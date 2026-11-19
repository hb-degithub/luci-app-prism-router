package io.prism.router.data

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PanelException(message: String) : Exception(message)

/**
 * 只读客户端：调用棱镜路由独立面板的 JSON API。
 * 默认地址 http://<路由器>:8099/ ，可在设置里改。所有请求都只读
 * （what=state / history / nodes / status），不会修改路由器配置。
 */
class PanelClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build()

    fun fetchState(baseUrl: String, token: String?): PanelState {
        val body = get(baseUrl, "state", token)
        return parseState(body)
    }

    /**
     * 拉取近 [days] 天（1–31）的每日流量，返回按日期升序排列的列表。
     * 当日条目通常只有 5 分钟桶（无 summary），会在这里累加出当日总量。
     */
    fun fetchHistory(baseUrl: String, token: String?, days: Int = 7): List<DailyUsage> {
        val n = days.coerceIn(1, 31)
        val body = get(baseUrl, "history", token, "days=$n")
        return parseHistory(body)
    }

    /**
     * 拉取子节点 / AP 列表（`?what=nodes`）。
     * 失败时抛 [PanelException]，由调用方降级（不影响主数据）。
     */
    fun fetchNodes(baseUrl: String, token: String?): List<SubNode> {
        val body = get(baseUrl, "nodes", token)
        return parseNodes(body)
    }

    fun testConnection(baseUrl: String, token: String?): String {
        val body = get(baseUrl, "status", token)
        val o = JSONObject(body)
        val version = o.optString("version", "?")
        val running = o.optBoolean("running", false)
        return "连接成功：版本 $version，服务${if (running) "运行中" else "未运行"}"
    }

    private fun get(baseUrl: String, what: String, token: String?, extraQuery: String? = null): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw PanelException("请先在设置里填写面板地址")
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
                    val err = try {
                        JSONObject(text).optString("error", "HTTP ${res.code}")
                    } catch (e: Exception) {
                        "HTTP ${res.code}"
                    }
                    throw PanelException(if (err == "unauthorized") "需要访问令牌，请在设置里填写" else err)
                }
                return text
            }
        } catch (e: PanelException) {
            throw e
        } catch (e: Exception) {
            throw PanelException("连接失败：${e.message ?: e.javaClass.simpleName}")
        }
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
                        quotaLimit = d.optLong("quota_limit")
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
     * totals 里优先取合计 rx/tx；该字段缺失或为 0 时退回 `direct_* + proxy_*`。
     * 两种形态在快照里都出现过，这里统一成一个数，避免子节点流量显示为 0。
     */
    private fun totalsSum(totals: JSONObject, key: String, directKey: String, proxyKey: String): Long {
        val merged = totals.optLong(directKey) + totals.optLong(proxyKey)
        val total = totals.optLong(key)
        return if (total > 0) total else merged
    }
}
