package io.prism.router.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.InterruptedIOException
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * 管理员接口失败。
 *
 * [code] 是后端 `{"error":"..."}` 的原值（`bad_credentials` / `rate_limited` /
 * `unauthorized` / `confirm_required` / `wifi_unsupported` / `internal` …）或本地分类
 * （`no_base_url` / `network` / `timeout` / `server` / `bad_request` / `bad_response`）。
 * [message] 已是可直接展示的中文，绝不包含密码或令牌。
 */
class AdminException(val code: String, override val message: String) : Exception(message)

/** 登录成功返回的临时管理会话。 */
data class AdminLoginResult(
    /** 32 位十六进制管理令牌；只允许留在内存，绝不写盘 / 打印。 */
    val token: String,
    val user: String,
    /** 令牌过期时间（秒级时间戳）；0 表示后端没给。 */
    val expires: Long
)

/**
 * 管理员客户端：`POST|GET <面板地址>/cgi-bin/prism-router-admin`。
 *
 * 契约（后端 `/www/cgi-bin/prism-router-admin`）：
 * - 登录：`POST {action:"login",username:"root",password}` →
 *   `{ok:true,token,expires,user}`；失败 `{error:"bad_credentials"}`，限速时 429 + `rate_limited`；
 * - 只读查询：`GET ?action=system|network|wifi&token=…`；
 * - 写操作：`POST {action:"reboot",token,confirm:"REBOOT"}`、
 *   `POST {action:"wifi_toggle",token,radio,disabled}`；
 * - 令牌 30 分钟有效，过期后需重新登录。
 *
 * 安全约束（与后端约定一致）：
 * - 本类**不打任何日志**：密码、令牌、请求体、查询串都不进 logcat；
 * - 写操作不自动重试（`retryOnConnectionFailure(false)`），避免重启 / 无线开关被重复执行；
 * - 错误文案只由错误码映射，不回显请求 URL（token 在查询串里）。
 *
 * 本类只消费 `wifi` 查询（重启与无线开关需要射频列表）；`system` / `network`
 * 查询留给后续页面，客户端不调用以免发出无用的管理请求。
 */
class AdminClient {
    private companion object {
        const val PATH = "/cgi-bin/prism-router-admin"
        const val TIMEOUT_SEC = 12L
        val JSON = "application/json; charset=utf-8".toMediaType()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        /* 登录 / 重启 / 无线开关都是非幂等写操作：连接失败不自动重试。 */
        .retryOnConnectionFailure(false)
        .build()

    /**
     * 用 root 密码换取临时管理令牌。
     *
     * 密码只存在于本次请求体与内存中，不写 DataStore、不打印；调用方拿到
     * [AdminLoginResult.token] 后同样只能保存在内存里。
     */
    fun login(baseUrl: String, username: String, password: String): AdminLoginResult {
        val payload = JSONObject().apply {
            put("action", "login")
            put("username", username.trim().ifBlank { "root" })
            put("password", password)
        }
        val root = post(baseUrl, payload)
        val token = root.optString("token", "").trim()
        if (token.isEmpty()) throw AdminException("bad_response", "路由器没有返回管理令牌")
        return AdminLoginResult(
            token = token,
            user = root.optString("user", "").trim().ifBlank { username.trim().ifBlank { "root" } },
            expires = root.optLong("expires", 0L).coerceAtLeast(0L)
        )
    }

    /** 退出登录：让服务端删除令牌；失败静默（本地令牌已经丢弃，不影响用户）。 */
    fun logout(baseUrl: String, token: String) {
        try {
            post(
                baseUrl,
                JSONObject().apply {
                    put("action", "logout")
                    put("token", token)
                }
            )
        } catch (e: Exception) {
            /* 退出失败无需打扰用户：本地已清空会话。 */
        }
    }

    /** `GET ?action=wifi&token=…`：射频 / SSID / 客户端数 / 是否关闭。 */
    fun fetchWifi(baseUrl: String, token: String): WifiInfo {
        val root = get(baseUrl, "wifi", token)
        return parseWifiObject(root)
    }

    /** 解析 wifi 响应（公开给单测；`supported=false` 表示没有无线网卡）。 */
    fun parseWifi(body: String): WifiInfo = parseWifiObject(JSONObject(body))

    /** `POST {action:"reboot",token,confirm:"REBOOT"}`；后端先回包再延迟重启。 */
    fun reboot(baseUrl: String, token: String, confirm: String) {
        post(
            baseUrl,
            JSONObject().apply {
                put("action", "reboot")
                put("token", token)
                put("confirm", confirm.trim())
            }
        )
    }

    /** `POST {action:"wifi_toggle",token,radio,disabled}`：开关某个射频。 */
    fun setWifiDisabled(baseUrl: String, token: String, radio: String, disabled: Boolean) {
        post(
            baseUrl,
            JSONObject().apply {
                put("action", "wifi_toggle")
                put("token", token)
                put("radio", radio.trim())
                put("disabled", disabled)
            }
        )
    }

    /* ───────────────────────── 解析 ───────────────────────── */

    private fun parseWifiObject(root: JSONObject): WifiInfo {
        val devices = ArrayList<WifiDevice>()
        val array = root.optJSONArray("devices")
        if (array != null) {
            for (i in 0 until array.length()) {
                val o = array.optJSONObject(i) ?: continue
                devices.add(
                    WifiDevice(
                        radio = o.optString("radio", "").trim(),
                        ssid = o.optString("ssid", "").trim(),
                        band = o.optString("band", "").trim(),
                        channel = o.optString("channel", "").trim(),
                        disabled = o.optBoolean("disabled", false),
                        clients = o.optInt("clients", 0).coerceAtLeast(0),
                        encryption = o.optString("encryption", "").trim()
                    )
                )
            }
        }
        return WifiInfo(
            /* 有射频条目就按「支持无线」处理，即使老后端没给 supported 字段。 */
            supported = root.optBoolean("supported", false) || devices.isNotEmpty(),
            devices = devices
        )
    }

    /* ───────────────────────── HTTP ───────────────────────── */

    private fun post(baseUrl: String, payload: JSONObject): JSONObject {
        val base = normalizeBase(baseUrl)
        val request = Request.Builder()
            .url(base + PATH)
            .addHeader("Accept", "application/json")
            .post(payload.toString().toRequestBody(JSON))
            .build()
        return execute(request)
    }

    private fun get(baseUrl: String, action: String, token: String): JSONObject {
        val base = normalizeBase(baseUrl)
        val url = "$base$PATH?action=$action&token=" + URLEncoder.encode(token, "UTF-8")
        val request = Request.Builder()
            .url(url)
            .addHeader("Accept", "application/json")
            .get()
            .build()
        return execute(request)
    }

    private fun normalizeBase(baseUrl: String): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw AdminException("no_base_url", "请先在设置里填写面板地址")
        return base
    }

    /**
     * 执行请求并把 HTTP / 后端错误翻译成 [AdminException]。
     *
     * 顺序很重要：429（限速）优先于 JSON 解析；`error` 字段优先于 HTTP 状态，
     * 因为后端 4xx 也带 `{"error":...}`。响应文本不作为错误文案回显（可能含敏感信息）。
     */
    private fun execute(request: Request): JSONObject {
        var httpCode = 0
        val text = try {
            client.newCall(request).execute().use { res ->
                httpCode = res.code
                res.body?.string().orEmpty()
            }
        } catch (e: SocketTimeoutException) {
            throw AdminException("timeout", "连接超时：请确认路由器管理页可访问")
        } catch (e: InterruptedIOException) {
            throw AdminException("timeout", "连接超时：请确认路由器管理页可访问")
        } catch (e: IOException) {
            throw AdminException("network", "连接失败：请检查路由器和网络")
        } catch (e: Exception) {
            throw AdminException("bad_response", "请求失败：${e.javaClass.simpleName}")
        }

        if (httpCode == 429) {
            throw AdminException("rate_limited", "尝试过于频繁，请 1 分钟后再试")
        }

        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            null
        }
        if (json == null) {
            val code = if (httpCode >= 500) "server" else "bad_response"
            val message = if (httpCode >= 500) {
                "路由器服务异常（HTTP $httpCode）"
            } else {
                "路由器返回了无法解析的数据（HTTP $httpCode）"
            }
            throw AdminException(code, message)
        }

        val error = json.optString("error", "").trim()
        if (error.isNotEmpty()) throw AdminException(error, messageFor(error, httpCode))
        if (httpCode == 401 || httpCode == 403) {
            throw AdminException("unauthorized", "登录已过期，请重新登录")
        }
        if (httpCode >= 500) throw AdminException("server", "路由器服务异常（HTTP $httpCode）")
        if (httpCode >= 400) throw AdminException("bad_request", "路由器拒绝了请求（HTTP $httpCode）")
        return json
    }

    /** 后端错误码 → 中文；未知码保留原值，避免把未预期的错误翻错。 */
    private fun messageFor(code: String, httpCode: Int): String = when (code.trim().lowercase()) {
        "bad_credentials" -> "密码错误，请重试"
        "rate_limited" -> "尝试过于频繁，请 1 分钟后再试"
        "unauthorized" -> "登录已过期，请重新登录"
        "forbidden" -> "没有权限执行该操作"
        "confirm_required" -> "请输入 REBOOT 确认重启"
        "wifi_unsupported" -> "未检测到无线网卡"
        "internal" -> "路由器内部错误，请稍后重试"
        "bad_request" -> "请求参数无效"
        "method_not_allowed" -> "路由器不支持该操作，请先升级面板插件"
        else -> if (httpCode >= 500) "路由器服务异常（HTTP $httpCode）" else code
    }
}
