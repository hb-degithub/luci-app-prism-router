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
 * 只读、**无需登录**，四个查询各自独立（一个失败不影响另外两个）：
 * - `what=system`    → [SystemInfo]（主机名 / 型号 / 内核 / 运行时间 / 负载 / 内存 / 根分区）；
 * - `what=services`  → [ServiceInfo] 列表（系统服务运行状态）；
 * - `what=processes` → [ProcessInfo] 列表（Top 进程）；
 * - `what=version`   → [ServerVersion]（检查更新用）。
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

    /* ───────────────────────── HTTP ───────────────────────── */

    private fun fetch(baseUrl: String, what: String): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw SystemException("no_base_url", "请先在设置里填写面板地址")
        val request = Request.Builder()
            .url("$base$PATH?what=$what")
            .get()
            .build()
        try {
            client.newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw httpFailure(res.code, text)
                return text
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

    /** CPU / 内存百分比：NaN、无穷大一律按 0（避免界面显示 "NaN%"）。 */
    private fun finite(value: Double): Double = if (value.isFinite()) value else 0.0
}
