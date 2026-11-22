package io.prism.router.data

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.InterruptedIOException
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * 系统信息接口失败。
 *
 * [code] 是稳定错误码：后端的 `{"error":"..."}`（internal / bad_request …）或本地
 * 分类（`no_base_url` / `network` / `timeout` / `server` / `not_found` / `bad_response`）。
 * [message] 已是可直接展示的中文，且不包含 URL / token。
 */
class SystemException(val code: String, override val message: String) : Exception(message)

/**
 * 系统信息客户端：`GET <面板地址>/cgi-bin/prism-router-system?what=…`
 *
 * 只读、**无需登录**，各查询彼此独立（一个失败不影响其它）：
 * - `what=system`    → [SystemInfo]（主机名 / 型号 / 内核 / 运行时间 / 负载 / 内存 / 根分区）；
 * - `what=services`  → [ServiceInfo] 列表（系统服务运行状态）；
 * - `what=processes` → [ProcessInfo] 列表（Top 进程）；
 * - `what=version`   → [ServerVersion]（路由器插件版本，只用于「关于」页并列展示）；
 * - `what=update_check`（可加 `&force=1`）→ [UpdateCheck]（**旧版**：由路由器代查
 *   GitHub 并返回插件 / IPK 版本）。App 更新已改为直接调用
 *   [GithubReleaseClient]，本方法仅为兼容旧面板契约保留，客户端不再调用。
 *
 * 老面板没有该接口时返回 404，这里映射成「请升级面板」的中文提示，而不是让设置页白屏。
 * 方法都是阻塞式的（与 [PanelClient] 一致），调用方负责放到 IO 线程。
 * 本类不打任何日志（响应里可能有主机名等信息，没有必要落 logcat）。
 */
class SystemClient {
    private companion object {
        const val PATH = "/cgi-bin/prism-router-system"
        const val CONNECT_TIMEOUT_SEC = 6L
        const val READ_TIMEOUT_SEC = 12L

        /**
         * 更新检查的业务错误码 → 中文提示。
         *
         * `github_*` 由后端在访问 GitHub 失败时下发（契约见 prism-router-system）；
         * 其余是本地 / 通用 HTTP 分类。未知码保留原值，避免把没见过的错误翻错。
         */
        fun updateErrorMessage(code: String, httpCode: Int = 0): String =
            when (code.trim().lowercase()) {
                "github_unavailable" -> "无法访问 GitHub：请检查路由器的外网与 DNS"
                "github_not_found" -> "GitHub 仓库不存在：请检查路由器 uci 的 github_repo 设置"
                "github_unauthorized" -> "GitHub 拒绝了请求：仓库可能为私有或触发了访问限制"
                "not_configured" -> "未配置更新源（可在路由器 uci 设置 github_repo）"
                "invalid_repo" -> "更新源格式不正确：应为 owner/repo"
                "internal" -> "路由器内部错误，请稍后重试"
                "no_base_url" -> "请先在设置里填写面板地址"
                "not_found" -> "路由器没有更新检查接口（HTTP 404），请先升级面板插件"
                "bad_request" -> "路由器不支持该查询（HTTP 400），请先升级面板插件"
                "timeout" -> "连接超时：请检查面板地址和网络"
                "network" -> "连接失败：请检查路由器和网络"
                "server" -> "面板服务异常（HTTP $httpCode）"
                "bad_response" -> "更新检查返回了无法解析的数据"
                else -> if (code.isBlank()) {
                    "更新检查失败（HTTP $httpCode）"
                } else {
                    "更新检查失败（$code）"
                }
            }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** `what=system`。 */
    fun fetchSystem(baseUrl: String): SystemInfo = wrap("系统信息") {
        parseSystem(fetch(baseUrl, "system"))
    }

    /** `what=services`。 */
    fun fetchServices(baseUrl: String): List<ServiceInfo> = wrap("服务状态") {
        parseServices(fetch(baseUrl, "services"))
    }

    /** `what=processes`。 */
    fun fetchProcesses(baseUrl: String): List<ProcessInfo> = wrap("进程列表") {
        parseProcesses(fetch(baseUrl, "processes"))
    }

    /** `what=version`。 */
    fun fetchVersion(baseUrl: String): ServerVersion = wrap("版本信息") {
        parseVersion(fetch(baseUrl, "version"))
    }

    /**
     * `what=update_check`（[force]=true 时带 `&force=1`，跳过后端的短期缓存）。
     *
     * **已废弃，App 不再调用**：该接口由路由器代查 GitHub，返回的是插件 / IPK 版本，
     * 且路由器离线时不可用。App 自动更新改走 [GithubReleaseClient]（直连 GitHub
     * Releases，只比较 App versionName）。保留仅为兼容旧面板契约 / 历史单测。
     *
     * 返回三种形态之一（见 [UpdateCheck]）；业务失败（GitHub 不可达 / 仓库不存在 /
     * 拒绝访问）在这里统一抛 [SystemException]，[SystemException.message] 已是对用户
     * 可读的中文，调用方无需再翻译。未配置更新源**不是**异常，而是
     * `configured=false` 的正常结果。
     */
    @Deprecated("App 更新改由 GithubReleaseClient 直连 GitHub Releases，不再使用路由器 update_check")
    fun fetchUpdateCheck(baseUrl: String, force: Boolean = false): UpdateCheck = wrap("检查更新") {
        val query = if (force) "what=update_check&force=1" else "what=update_check"
        val result = execute(baseUrl, query)

        if (result.code !in 200..299) {
            /* 后端可能用 4xx/5xx 携带 {"configured":true,"error":…}：优先按业务码翻译。 */
            val parsed = parseOrNull(result.text)
            val business = parsed?.error.orEmpty().trim()
            if (business.isNotEmpty()) {
                throw SystemException(business, updateErrorMessage(business, result.code))
            }
            throw updateHttpFailure(result.code, result.text)
        }

        val check = parseUpdateCheck(result.text)
        if (check.error.isNotBlank()) {
            throw SystemException(check.error, updateErrorMessage(check.error, result.code))
        }
        check
    }

    /* ───────────────────────── HTTP ───────────────────────── */

    /** 一次 GET 的原始结果：状态码 + 文本（不在这里判定成功与否，调用方决定）。 */
    private data class HttpResult(val code: Int, val text: String)

    private fun fetch(baseUrl: String, what: String): String {
        val result = execute(baseUrl, "what=$what")
        if (result.code !in 200..299) throw httpFailure(result.code, result.text)
        return result.text
    }

    /**
     * 发一次 GET 并返回原始响应。
     *
     * 网络层异常在这里统一翻译成 [SystemException]（`no_base_url` / `timeout` /
     * `network`）；HTTP 状态码留给调用方，因为 update_check 的业务错误也可能带 4xx/5xx。
     */
    private fun execute(baseUrl: String, query: String): HttpResult {
        val base = normalizeBase(baseUrl)
        val request = Request.Builder()
            .url("$base$PATH?$query")
            .get()
            .build()
        try {
            client.newCall(request).execute().use { res ->
                return HttpResult(res.code, res.body?.string().orEmpty())
            }
        } catch (e: SystemException) {
            throw e
        } catch (e: SocketTimeoutException) {
            throw SystemException("timeout", "连接超时：请检查面板地址和网络")
        } catch (e: InterruptedIOException) {
            throw SystemException("timeout", "连接超时：请检查面板地址和网络")
        } catch (e: IOException) {
            throw SystemException("network", "连接失败：请检查路由器和网络")
        } catch (e: Exception) {
            throw SystemException("bad_response", "系统信息请求失败：${e.javaClass.simpleName}")
        }
    }

    /** 地址归一化：空地址直接报「请先填写面板地址」，不发请求。 */
    private fun normalizeBase(baseUrl: String): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw SystemException("no_base_url", "请先在设置里填写面板地址")
        return base
    }

    /** 4xx / 5xx → 可展示的中文；404 / 400 明确指向「面板版本太旧」。 */
    private fun httpFailure(httpCode: Int, text: String): SystemException {
        val serverError = try {
            JSONObject(text).optString("error", "").trim()
        } catch (e: Exception) {
            ""
        }
        val code = when {
            httpCode == 404 -> "not_found"
            httpCode == 400 -> "bad_request"
            httpCode >= 500 -> "server"
            serverError.isNotEmpty() -> serverError
            else -> "bad_response"
        }
        val message = when (code) {
            "not_found" -> "路由器没有系统信息接口（HTTP 404），请升级面板插件后重试"
            "bad_request" -> "路由器不支持该查询（HTTP 400），请升级面板插件后重试"
            "server" -> "面板服务异常（HTTP $httpCode）"
            else -> serverError.ifBlank { "系统信息读取失败（HTTP $httpCode）" }
        }
        return SystemException(code, message)
    }

    /** update_check 的 HTTP 失败：先看后端 `error`，再按状态码兜底。 */
    private fun updateHttpFailure(httpCode: Int, text: String): SystemException {
        val serverError = try {
            JSONObject(text).optString("error", "").trim()
        } catch (e: Exception) {
            ""
        }
        if (serverError.isNotEmpty()) {
            return SystemException(serverError, updateErrorMessage(serverError, httpCode))
        }
        val mapped = when {
            httpCode == 404 -> "not_found"
            httpCode == 400 -> "bad_request"
            httpCode >= 500 -> "server"
            else -> "bad_response"
        }
        return SystemException(mapped, updateErrorMessage(mapped, httpCode))
    }

    /** 非 2xx 时容忍解析失败：解析不出来就走 HTTP 兜底文案。 */
    private fun parseOrNull(body: String): UpdateCheck? = try {
        parseUpdateCheck(body)
    } catch (e: Exception) {
        null
    }

    /** 解析失败统一成 [SystemException]（JSON 坏掉时不要把 JSONException 抛给 UI）。 */
    private fun <T> wrap(label: String, block: () -> T): T = try {
        block()
    } catch (e: SystemException) {
        throw e
    } catch (e: Exception) {
        throw SystemException("bad_response", "${label}响应无法解析")
    }

    /* ───────────────────────── 解析（容忍缺字段） ───────────────────────── */

    /** 解析 `{hostname,model,kernel,uptime,load:[...],memory:{...},rootfs:{...},version}`。 */
    fun parseSystem(body: String): SystemInfo {
        val root = JSONObject(body)

        val load = ArrayList<Double>(3)
        val loadArray = root.optJSONArray("load")
        if (loadArray != null) {
            for (i in 0 until loadArray.length()) {
                val value = loadArray.optDouble(i, Double.NaN)
                if (value.isFinite()) load.add(value)
            }
        }

        val memory = root.optJSONObject("memory")?.let { o ->
            MemoryInfo(
                total = o.optLong("total", 0L).coerceAtLeast(0L),
                free = o.optLong("free", 0L).coerceAtLeast(0L),
                available = o.optLong("available", 0L).coerceAtLeast(0L)
            )
        } ?: MemoryInfo()

        val rootfs = root.optJSONObject("rootfs")?.let { o ->
            RootfsInfo(
                total = o.optLong("total", 0L).coerceAtLeast(0L),
                used = o.optLong("used", 0L).coerceAtLeast(0L),
                free = o.optLong("free", 0L).coerceAtLeast(0L)
            )
        } ?: RootfsInfo()

        return SystemInfo(
            hostname = root.optString("hostname", "").trim(),
            model = root.optString("model", "").trim(),
            kernel = root.optString("kernel", "").trim(),
            uptime = root.optLong("uptime", 0L).coerceAtLeast(0L),
            load = load,
            memory = memory,
            rootfs = rootfs,
            version = root.optString("version", "").trim()
        )
    }

    /** 解析 `{services:[{name,label,running,pid,info}]}`；缺 name 的行跳过。 */
    fun parseServices(body: String): List<ServiceInfo> {
        val root = JSONObject(body)
        val array = root.optJSONArray("services") ?: return emptyList()
        val out = ArrayList<ServiceInfo>(array.length())
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            val name = o.optString("name", "").trim()
            if (name.isEmpty()) continue
            out.add(
                ServiceInfo(
                    name = name,
                    label = o.optString("label", "").trim(),
                    running = o.optBoolean("running", false),
                    pid = o.optInt("pid", 0).coerceAtLeast(0),
                    info = o.optString("info", "").trim()
                )
            )
        }
        return out
    }

    /** 解析 `{processes:[{pid,user,cpu,mem,command}]}`；PID 非正或整行全空的行跳过。 */
    fun parseProcesses(body: String): List<ProcessInfo> {
        val root = JSONObject(body)
        val array = root.optJSONArray("processes") ?: return emptyList()
        val out = ArrayList<ProcessInfo>(array.length())
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            val pid = o.optInt("pid", 0)
            if (pid <= 0) continue
            val user = o.optString("user", "").trim()
            val command = o.optString("command", "").trim()
            if (user.isEmpty() && command.isEmpty()) continue
            out.add(
                ProcessInfo(
                    pid = pid,
                    user = user,
                    cpu = finite(o.optDouble("cpu", 0.0)),
                    mem = finite(o.optDouble("mem", 0.0)),
                    command = command
                )
            )
        }
        return out
    }

    /** 解析 `{version,build,apk_version}`。 */
    fun parseVersion(body: String): ServerVersion {
        val root = JSONObject(body)
        return ServerVersion(
            version = root.optString("version", "").trim(),
            build = root.optString("build", "").trim(),
            apkVersion = root.optString("apk_version", "").trim()
        )
    }

    /**
     * 解析 `?what=update_check` 的响应（公开给单测；不访问网络）。
     *
     * 缺字段一律取安全默认值：`configured` 缺失时按 true 处理（真正未配置时
     * 后端一定显式下发 `false`）；`apk` / `ipk` 只有对象存在且至少带 name/url
     * 时才非 null（全空对象视为「没有产物」）。
     */
    fun parseUpdateCheck(body: String): UpdateCheck {
        val root = JSONObject(body)
        return UpdateCheck(
            configured = root.optBoolean("configured", true),
            message = root.optString("message", "").trim(),
            repo = root.optString("repo", "").trim(),
            current = root.optString("current", "").trim(),
            latest = root.optString("latest", "").trim(),
            hasUpdate = root.optBoolean("has_update", false),
            publishedAt = root.optString("published_at", "").trim(),
            htmlUrl = root.optString("html_url", "").trim(),
            notes = root.optString("notes", "").trim(),
            apk = parseAsset(root.optJSONObject("apk")),
            ipk = parseAsset(root.optJSONObject("ipk")),
            error = root.optString("error", "").trim(),
            detail = root.optString("detail", "").trim()
        )
    }

    /** `{name,url,size}` → [UpdateAsset]；对象全空时返回 null（不伪造下载入口）。 */
    private fun parseAsset(json: JSONObject?): UpdateAsset? {
        if (json == null) return null
        val name = json.optString("name", "").trim()
        val url = json.optString("url", "").trim()
        if (name.isEmpty() && url.isEmpty()) return null
        return UpdateAsset(
            name = name,
            url = url,
            size = json.optLong("size", 0L).coerceAtLeast(0L)
        )
    }

    /** CPU / 内存百分比：NaN、无穷大一律按 0（避免界面显示 "NaN%"）。 */
    private fun finite(value: Double): Double = if (value.isFinite()) value else 0.0
}
