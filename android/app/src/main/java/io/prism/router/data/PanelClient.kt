package io.prism.router.data

import android.util.Log
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * 面板只读 API 失败。
 *
 * [code] 是稳定的本地 / 服务端错误码（`unauthorized` / `forbidden` / `network` /
 * `timeout` / `server` / `badResponse`），由
 * `PanelRepository` 统一映射为面向 UI 的 `AppError`；[message] 已是可直接展示的中文，
 * 且绝不包含 token。
 */
class PanelException(
    override val message: String,
    val code: String = "",
    cause: Throwable? = null
) : Exception(message, cause)

/**
 * 只读客户端：调用棱镜路由独立面板的 JSON API。
 * 默认地址 http://<路由器>:8099/ ，可在设置里改。所有请求都只读
 * （what=state / history / nodes / status），不会修改路由器配置。
 *
 * 网络策略：
 * - connect 8s / read 15s（写超时同 15s，仅用于统一连接池配置）；
 * - 仅幂等 GET 在 IOException 或 5xx 时重试 1 次；
 * - 日志只记录 method / host / path / status / 耗时，绝不打印 query（token 在
 *   query 里）与请求体。
 */
class PanelClient {
    private companion object {
        const val CONNECT_TIMEOUT_SEC = 8L
        const val READ_TIMEOUT_SEC = 15L
        const val WRITE_TIMEOUT_SEC = 15L
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(WRITE_TIMEOUT_SEC, TimeUnit.SECONDS)
        .addInterceptor(RetryIdempotentOnceInterceptor())
        .addInterceptor(RedactingLogInterceptor())
        .build()

    fun fetchState(baseUrl: String, token: String?): PanelState {
        val body = get(baseUrl, "state", token)
        return try {
            parseState(body)
        } catch (e: PanelException) {
            throw e
        } catch (e: Exception) {
            throw PanelException("状态响应无法解析", "badResponse", e)
        }
    }

    /**
     * 拉取近 [days] 天（1–31）的每日流量，返回按日期升序排列的列表。
     * 当日条目通常只有 5 分钟桶（无 summary），会在这里累加出当日总量。
     */
    fun fetchHistory(baseUrl: String, token: String?, days: Int = 7): List<DailyUsage> {
        val n = days.coerceIn(1, 31)
        val body = get(baseUrl, "history", token, "days=$n")
        return try {
            parseHistory(body)
        } catch (e: PanelException) {
            throw e
        } catch (e: Exception) {
            throw PanelException("历史响应无法解析", "badResponse", e)
        }
    }

    /**
     * 拉取子节点 / AP 列表（`?what=nodes`）。
     * 失败时抛 [PanelException]，由调用方降级（不影响主数据）。
     */
    fun fetchNodes(baseUrl: String, token: String?): List<SubNode> {
        val body = get(baseUrl, "nodes", token)
        return try {
            parseNodes(body)
        } catch (e: PanelException) {
            throw e
        } catch (e: Exception) {
            throw PanelException("子节点响应无法解析", "badResponse", e)
        }
    }

    /**
     * 拉取近 [days] 天（1–31）的应用（域名）汇总：`?what=apps_history&days=n`。
     *
     * 返回按 rx+tx 降序的列表（后端已排序，这里再排一次保证稳定），最多 100 条。
     * daily 摘要每天只存 Top 50，所以多日合计是近似值，调用方必须在 UI 标注。
     * 网络 / 鉴权失败与响应无法解析都抛 [PanelException]。
     */
    fun fetchAppsHistory(baseUrl: String, token: String?, days: Int = 7): List<AppHistory> {
        val n = days.coerceIn(1, 31)
        val body = get(baseUrl, "apps_history", token, "days=$n")
        return try {
            parseAppsHistory(body, n)
        } catch (e: PanelException) {
            throw e
        } catch (e: Exception) {
            throw PanelException("应用历史响应无法解析", "badResponse", e)
        }
    }

    fun testConnection(baseUrl: String, token: String?): String {
        val body = get(baseUrl, "status", token)
        val o = try {
            JSONObject(body)
        } catch (e: Exception) {
            throw PanelException("状态响应无法解析", "badResponse", e)
        }
        val version = o.optString("version", "?")
        val running = o.optBoolean("running", false)
        return "连接成功：版本 $version，服务${if (running) "运行中" else "未运行"}"
    }

    /**
     * 读取 `?what=status`（rpcd status 的只读投影：version / running / confidence /
     * sources / link_source / link_bridge / can_manage），供设置页「诊断」卡显示
     * 版本与服务状态。失败时抛 [PanelException]，由调用方降级（不影响其它检查项）。
     *
     * 面板的 status 投影里没有轮询耗时，[PanelState.Health] 也没有 clash_poll_ms，
     * 所以在 status 成功后补读一次 `?what=state`，只取 `health.clash_poll_ms`，
     * 以顶层 `clash_poll_ms` 附带返回（status 自带 health.clash_poll_ms 时不覆盖）。
     * 补读失败 / 字段缺失一律忽略，status 仍按成功返回。
     *
     * 只读：两次请求都是 GET，不改动路由器配置；返回值里不含 token。
     */
    fun fetchStatus(baseUrl: String, token: String?): JSONObject {
        val status = try {
            JSONObject(get(baseUrl, "status", token))
        } catch (e: PanelException) {
            throw e
        } catch (e: Exception) {
            throw PanelException("状态响应无法解析", "badResponse", e)
        }

        val fromHealth = status.optJSONObject("health")?.optLong("clash_poll_ms", 0L) ?: 0L
        if (fromHealth > 0L) return status

        /* 旧面板没有该字段时保持缺省，让诊断页显示「未知」而不是误报 0 ms。 */
        val pollMs = try {
            JSONObject(get(baseUrl, "state", token))
                .optJSONObject("health")?.optLong("clash_poll_ms", 0L) ?: 0L
        } catch (e: Exception) {
            0L
        }
        if (pollMs > 0L) status.put("clash_poll_ms", pollMs)
        return status
    }

    private fun get(baseUrl: String, what: String, token: String?, extraQuery: String? = null): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw PanelException("请先在设置里填写面板地址", "badResponse")
        var url = "$base/cgi-bin/panel-api?what=$what"
        if (!extraQuery.isNullOrBlank()) url += "&$extraQuery"
        if (!token.isNullOrBlank()) {
            url += "&token=" + java.net.URLEncoder.encode(token, "UTF-8")
        }
        val request = Request.Builder().url(url).get().build()
        try {
            client.newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val serverError = try {
                        JSONObject(text).optString("error", "")
                    } catch (e: Exception) {
                        ""
                    }
                    val code = when {
                        res.code == 401 -> "unauthorized"
                        res.code == 403 ->
                            if (serverError.equals("forbidden", ignoreCase = true)) "forbidden" else "unauthorized"
                        res.code >= 500 -> "server"
                        serverError.equals("unauthorized", ignoreCase = true) -> "unauthorized"
                        serverError.equals("forbidden", ignoreCase = true) -> "forbidden"
                        else -> "badResponse"
                    }
                    val message = when (code) {
                        "unauthorized" -> "需要访问令牌，请在设置里填写"
                        "forbidden" -> "访问令牌无效"
                        "server" -> "面板服务异常（HTTP ${res.code}）"
                        else -> serverError.ifBlank { "HTTP ${res.code}" }
                    }
                    throw PanelException(message, code)
                }
                return text
            }
        } catch (e: PanelException) {
            throw e
        } catch (e: SocketTimeoutException) {
            throw PanelException("连接超时：${safeErrorText(e)}", "timeout", e)
        } catch (e: InterruptedIOException) {
            /* OkHttp 的 callTimeout / 读超时也可能表现为 InterruptedIOException。 */
            throw PanelException("连接超时：${safeErrorText(e)}", "timeout", e)
        } catch (e: Exception) {
            throw PanelException("连接失败：${safeErrorText(e)}", "network", e)
        }
    }

    /** 错误文案脱敏：即使底层异常带上完整 URL，也不把 query 里的 token 带到界面。 */
    private fun safeErrorText(error: Throwable): String {
        val raw = error.message ?: error.javaClass.simpleName
        return raw.replace(TOKEN_IN_TEXT, "token=***")
    }

    /** 解析 state（也用于读取离线缓存里同结构的 JSON）。缺失字段一律按默认值处理。 */
    fun parseState(body: String): PanelState {
        val o = JSONObject(body)
        val t = o.optJSONObject("totals") ?: JSONObject()
        val totals = Totals(
            rx = t.optLong("rx"),
            tx = t.optLong("tx"),
            rxRate = t.optLong("rx_rate"),
            txRate = t.optLong("tx_rate"),
            directRx = t.optLong("direct_rx"),
            directTx = t.optLong("direct_tx"),
            proxyRx = t.optLong("proxy_rx"),
            proxyTx = t.optLong("proxy_tx"),
            wifiRx = t.optLong("wifi_rx"),
            wifiTx = t.optLong("wifi_tx"),
            wiredRx = t.optLong("wired_rx"),
            wiredTx = t.optLong("wired_tx"),
            monthTotal = t.optLong("month_total")
        )

        val devices = ArrayList<Device>()
        val da = o.optJSONArray("devices")
        if (da != null) {
            for (i in 0 until da.length()) {
                val d = da.optJSONObject(i) ?: continue
                val mac = d.optString("mac", "")
                val ip = d.optString("ip", "")
                val host = d.optString("hostname", "")
                devices.add(
                    Device(
                        name = host.ifBlank { ip.ifBlank { mac } },
                        mac = mac,
                        ip = ip,
                        link = d.optString("link", "unknown"),
                        rxRate = d.optLong("rx_rate"),
                        txRate = d.optLong("tx_rate"),
                        directRx = d.optLong("direct_rx"),
                        directTx = d.optLong("direct_tx"),
                        proxyRx = d.optLong("proxy_rx"),
                        proxyTx = d.optLong("proxy_tx"),
                        monthTotal = d.optLong("month_total"),
                        lastSeen = d.optLong("last_seen"),
                        quotaLimit = d.optLong("quota_limit"),
                        apps = parseDeviceApps(d.optJSONObject("apps"))
                    )
                )
            }
        }

        val apps = ArrayList<AppUsage>()
        val aa = o.optJSONArray("apps")
        if (aa != null) {
            for (i in 0 until aa.length()) {
                val a = aa.optJSONObject(i) ?: continue
                apps.add(
                    AppUsage(
                        host = a.optString("host"),
                        rx = a.optLong("rx"),
                        tx = a.optLong("tx"),
                        devices = a.optInt("devices"),
                        chain = a.optString("chain")
                    )
                )
            }
        }

        val nodes = ArrayList<NodeUsage>()
        val no = o.optJSONObject("nodes")
        if (no != null) {
            val keys = no.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val n = no.optJSONObject(k) ?: continue
                nodes.add(NodeUsage(k, n.optLong("rx"), n.optLong("tx")))
            }
        }

        val h = o.optJSONObject("health") ?: JSONObject()
        val reasons = ArrayList<String>()
        val ra = h.optJSONArray("reasons")
        if (ra != null) for (i in 0 until ra.length()) reasons.add(ra.optString(i))

        val health = Health(
            confidence = h.optString("accounting_confidence", "unknown"),
            reasons = reasons,
            clashConnections = h.optLong("clash_connections"),
            clashPollMs = h.optLong("clash_poll_ms"),
            linkSource = h.optString("link_source"),
            linkBridge = h.optString("link_bridge")
        )

        val source = o.optJSONObject("source") ?: JSONObject()
        val quota = o.optJSONObject("quota") ?: JSONObject()

        return PanelState(
            ts = o.optLong("ts"),
            running = o.optBoolean("running"),
            totals = totals,
            devices = devices.sortedByDescending { it.total },
            apps = apps.sortedByDescending { it.total },
            nodes = nodes.sortedByDescending { it.total },
            health = health,
            /* 缺失的数据源保持空串（= 未知，不误判为故障）；只有明确非 ok 才算异常。 */
            clash = source.optString("clash", ""),
            conntrack = source.optString("conntrack", ""),
            quotaDeviceLimit = quota.optLong("device_limit")
        )
    }

    /**
     * 解析单个设备的 `apps` 对象：`{ "<host>": {"rx","tx","chain"} }`。
     *
     * daemon 已按 rx 降序截断、长尾归并进 `__other__`，这里不做排序也不补数据：
     * - `apps` 缺失 / 不是对象 → 空 map（老快照与离线缓存都是这种形态）；
     * - 某一项不是对象、键为空 → 跳过该条，不影响其它条目；
     * - `rx`/`tx` 类型错乱时 `optLong` 给 0，负值按 0 处理；
     * - 同一 host 出现多次（仅首尾空白不同）时累加，避免静默丢流量。
     */
    private fun parseDeviceApps(root: JSONObject?): Map<String, DeviceApp> {
        if (root == null || root.length() == 0) return emptyMap()
        val out = LinkedHashMap<String, DeviceApp>(root.length())
        val keys = root.keys()
        while (keys.hasNext()) {
            val rawHost = keys.next()
            val host = rawHost.trim()
            if (host.isEmpty()) continue
            val o = root.optJSONObject(rawHost) ?: continue
            val rx = o.optLong("rx").coerceAtLeast(0L)
            val tx = o.optLong("tx").coerceAtLeast(0L)
            val prev = out[host]
            out[host] = if (prev == null) {
                DeviceApp(host = host, rx = rx, tx = tx, chain = o.optString("chain", "").trim())
            } else {
                /* 保留第一次读到的 chain（同一域名在同一设备上通常同链路）。 */
                prev.copy(rx = prev.rx + rx, tx = prev.tx + tx)
            }
        }
        return out
    }

    /** 解析 `?what=history`；容忍 buckets 为空、summary 缺失与字段不完整。 */
    fun parseHistory(body: String): List<DailyUsage> {
        val root = JSONObject(body)
        val arr = root.optJSONArray("days") ?: return emptyList()
        val out = ArrayList<DailyUsage>(arr.length())

        for (i in 0 until arr.length()) {
            val d = arr.optJSONObject(i) ?: continue
            val day = d.optString("day", "")
            if (day.isBlank()) continue

            /* 当日条目：只有 5 分钟桶，累加出四个方向。 */
            var bucketDirectRx = 0L
            var bucketDirectTx = 0L
            var bucketProxyRx = 0L
            var bucketProxyTx = 0L
            val buckets = d.optJSONArray("buckets")
            if (buckets != null) {
                for (j in 0 until buckets.length()) {
                    val b = buckets.optJSONObject(j) ?: continue
                    bucketDirectRx += b.optLong("direct_rx")
                    bucketDirectTx += b.optLong("direct_tx")
                    bucketProxyRx += b.optLong("proxy_rx")
                    bucketProxyTx += b.optLong("proxy_tx")
                }
            }

            /* 往日条目：summary.totals（后端已把老 daily 的 rx/tx 归入 direct）。 */
            val totals = d.optJSONObject("summary")?.optJSONObject("totals")
            val summaryRx = totals?.optLong("rx") ?: 0L
            val summaryTx = totals?.optLong("tx") ?: 0L
            val summaryDirectRx = totals?.optLong("direct_rx") ?: 0L
            val summaryDirectTx = totals?.optLong("direct_tx") ?: 0L
            val summaryProxyRx = totals?.optLong("proxy_rx") ?: 0L
            val summaryProxyTx = totals?.optLong("proxy_tx") ?: 0L
            val summarySplit = summaryDirectRx + summaryDirectTx + summaryProxyRx + summaryProxyTx
            val bucketTotal = bucketDirectRx + bucketDirectTx + bucketProxyRx + bucketProxyTx

            val directRx: Long
            val directTx: Long
            val proxyRx: Long
            val proxyTx: Long
            val rx: Long
            val tx: Long
            when {
                totals != null && (summaryRx + summaryTx > 0 || summarySplit > 0) -> {
                    directRx = summaryDirectRx
                    directTx = summaryDirectTx
                    proxyRx = summaryProxyRx
                    proxyTx = summaryProxyTx
                    rx = if (summaryRx + summaryTx > 0) summaryRx else summaryDirectRx + summaryProxyRx
                    tx = if (summaryRx + summaryTx > 0) summaryTx else summaryDirectTx + summaryProxyTx
                }

                bucketTotal > 0 -> {
                    directRx = bucketDirectRx
                    directTx = bucketDirectTx
                    proxyRx = bucketProxyRx
                    proxyTx = bucketProxyTx
                    rx = bucketDirectRx + bucketProxyRx
                    tx = bucketDirectTx + bucketProxyTx
                }

                else -> {
                    directRx = 0
                    directTx = 0
                    proxyRx = 0
                    proxyTx = 0
                    rx = 0
                    tx = 0
                }
            }

            out.add(DailyUsage(day, rx, tx, directRx, directTx, proxyRx, proxyTx))
        }

        /* 后端新的日期在前；图表按时间升序绘制。 */
        return out.sortedBy { it.day }
    }

    /**
     * 解析 `?what=nodes`：`{nodes:[{node_id,name,ts,age_sec,latest:{totals,devices,apps}}]}`。
     *
     * 字段类型错乱（totals 不是对象、devices 不是数组）一律按缺失处理；
     * 结果是只读快照，不做任何写回。排序：在线优先 → 流量降序 → 名称。
     */
    fun parseNodes(body: String): List<SubNode> {
        val root = JSONObject(body)
        val arr = root.optJSONArray("nodes") ?: return emptyList()
        val out = ArrayList<SubNode>(arr.length())

        for (i in 0 until arr.length()) {
            val n = arr.optJSONObject(i) ?: continue
            val latest = n.optJSONObject("latest") ?: JSONObject()
            val totals = latest.optJSONObject("totals") ?: JSONObject()
            out.add(
                SubNode(
                    nodeId = n.optString("node_id", ""),
                    name = n.optString("name", ""),
                    /* age_sec 缺失 / 非数字 → -1（未上报），不要误判成 0 秒。 */
                    ageSec = n.optLong("age_sec", -1L),
                    rx = totalsSum(totals, "rx", "direct_rx", "proxy_rx"),
                    tx = totalsSum(totals, "tx", "direct_tx", "proxy_tx"),
                    deviceCount = latest.optJSONArray("devices")?.length() ?: 0
                )
            )
        }

        return out.sortedWith(
            compareBy<SubNode> { it.freshness.ordinal }
                .thenByDescending { it.total }
                .thenBy { it.displayName }
        )
    }

    /**
     * 解析 `?what=apps_history`：
     * `{days,files,skipped,truncated,apps:[{host,rx,tx,chain,days}]}`。
     *
     * 容错策略与其它解析一致，坏数据不炸整页：
     * - `apps` 缺失 / 不是数组 → 空列表；
     * - 单条不是对象、`host` 为空 → 跳过；
     * - `rx`/`tx` 负值按 0；`days` 收敛到 0..[daysLimit]；
     * - 同一 host（仅首尾空白差异）多条累加，出现天数取最大值。
     */
    private fun parseAppsHistory(body: String, daysLimit: Int): List<AppHistory> {
        val root = JSONObject(body)
        val arr = root.optJSONArray("apps") ?: return emptyList()
        val merged = LinkedHashMap<String, AppHistory>(arr.length())
        for (i in 0 until arr.length()) {
            val a = arr.optJSONObject(i) ?: continue
            val host = a.optString("host", "").trim()
            if (host.isEmpty()) continue
            val rx = a.optLong("rx").coerceAtLeast(0L)
            val tx = a.optLong("tx").coerceAtLeast(0L)
            val days = a.optInt("days", 0).coerceIn(0, daysLimit.coerceAtLeast(0))
            val chain = a.optString("chain", "").trim()
            val prev = merged[host]
            merged[host] = if (prev == null) {
                AppHistory(host = host, rx = rx, tx = tx, chain = chain, days = days)
            } else {
                /* 同一域名的重复行：流量累加，链路保留第一个非空值。 */
                prev.copy(
                    rx = prev.rx + rx,
                    tx = prev.tx + tx,
                    chain = prev.chain.ifBlank { chain },
                    days = maxOf(prev.days, days)
                )
            }
        }
        /* 后端约定最多 100 条；这里再兜一层，避免异常响应把列表撑爆。 */
        return merged.values.sortedByDescending { it.total }.take(100)
    }

    /**
     * totals 里优先取合计 rx/tx；该字段缺失或为 0 时退回 `direct_* + proxy_*`。
     * 两种形态在快照里都出现过，这里统一成一个数，避免子节点流量显示为 0。
     */
    private fun totalsSum(totals: JSONObject, key: String, directKey: String, proxyKey: String): Long {
        val merged = totals.optLong(directKey) + totals.optLong(proxyKey)
        val total = totals.optLong(key)
        return if (total > 0) total else merged
    }
}

/* ───────────────────────── OkHttp 拦截器 ───────────────────────── */

private const val PANEL_LOG_TAG = "PanelClient"

/** 错误文案里的 token 脱敏（query 形式 `token=...`，大小写不敏感）。 */
private val TOKEN_IN_TEXT = Regex("""(token=)[^&\s]+""", RegexOption.IGNORE_CASE)

/**
 * 只对幂等 GET 失败重试 1 次。
 *
 * - 网络异常（连接重置 / 超时 / DNS 抖动）：重试一次；
 * - HTTP 5xx：关闭响应后重试一次；
 * - 非 GET（家长控制 POST）绝不重试，避免重复写操作；
 * - 调用已取消时立刻放弃，不吞取消信号。
 */
private class RetryIdempotentOnceInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val canRetry = request.method.equals("GET", ignoreCase = true)
        var attempt = 0
        while (true) {
            attempt++
            try {
                val response = chain.proceed(request)
                if (canRetry && attempt == 1 && response.code >= 500) {
                    response.close()
                    continue
                }
                return response
            } catch (e: IOException) {
                if (!canRetry || attempt >= 2 || chain.call().isCanceled()) throw e
                /* 幂等 GET：继续循环，再试一次。 */
            }
        }
    }
}

/**
 * 脱敏访问日志：只输出 method / scheme / host / port / path / status / 耗时。
 *
 * query 完全不打印（面板 token 放在 query 里），也不打印请求 / 响应体；
 * 日志失败（例如 JVM 单测没有 android.util.Log）时静默忽略，不影响请求。
 */
private class RedactingLogInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val url = request.url
        val target = "${url.scheme}://${url.host}:${url.port}${url.encodedPath}"
        val startedAt = System.nanoTime()
        return try {
            val response = chain.proceed(request)
            log("${request.method} $target -> ${response.code} (${elapsedMs(startedAt)} ms)")
            response
        } catch (e: IOException) {
            log("${request.method} $target -> ${e.javaClass.simpleName} (${elapsedMs(startedAt)} ms)")
            throw e
        }
    }

    private fun elapsedMs(startedAt: Long): Long = (System.nanoTime() - startedAt) / 1_000_000

    private fun log(line: String) {
        runCatching { Log.d(PANEL_LOG_TAG, line) }
    }
}
