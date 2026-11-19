package io.prism.router.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 家长控制（按 MAC 暂停/恢复设备上网）写操作失败。
 *
 * [code] 是后端 `{"error":"..."}` 的原值（write_disabled / forbidden /
 * protected_target / invalid_mac …）；本地失败时是 no_base_url / network /
 * bad_response。[message] 已是可直接展示的中文。
 *
 * 注意：[message] 绝不包含 token，网络异常只带 OkHttp 的连接信息。
 */
class ControlException(val code: String, override val message: String) : Exception(message)

/**
 * 「棱镜路由」家长控制写客户端：`POST <面板地址>/cgi-bin/prism-router-control`。
 *
 * 契约（后端默认关闭，`panel.write_enabled=1` 且 `panel.token` 非空才可用）：
 * - 请求 JSON：`{"token":"...","action":"pause"|"resume"|"list","mac":"AA:BB:..."}`
 * - 成功：list → `{"ok":true,"paused":[{"mac":"...","handle":42}]}`；
 *   pause/resume → `{"ok":true,"already":false|true,"mac":"..."}`
 * - 失败：`{"error":"write_disabled"|"forbidden"|"protected_target"|
 *   "invalid_mac"|"invalid_action"|"bad_request"|"internal"|...}`
 *
 * 方法都是阻塞式（与 [PanelClient] 一致），调用方负责放到 IO 线程。
 * 本类不打任何日志，避免 token 落进 logcat。
 */
class ControlClient {
    private companion object {
        const val PATH = "/cgi-bin/prism-router-control"
        const val TIMEOUT_SEC = 12L
        val JSON = "application/json; charset=utf-8".toMediaType()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .build()

    /** 已暂停的设备 MAC 集合（服务端归一化后的大写冒号形式）。 */
    fun list(baseUrl: String, token: String): Set<String> {
        val root = post(baseUrl, token, "list", null)
        val arr = root.optJSONArray("paused") ?: return emptySet()
        val out = LinkedHashSet<String>(arr.length())
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val mac = normalizeMac(item.optString("mac", ""))
            if (mac.isNotEmpty()) out.add(mac)
        }
        return out
    }

    /** 暂停该设备上网；`already=true`（本来就已暂停）也按成功处理。 */
    fun pause(baseUrl: String, token: String, mac: String) {
        post(baseUrl, token, "pause", mac)
    }

    /** 恢复该设备上网；`already=true`（本来就没被暂停）也按成功处理。 */
    fun resume(baseUrl: String, token: String, mac: String) {
        post(baseUrl, token, "resume", mac)
    }

    private fun post(baseUrl: String, token: String, action: String, mac: String?): JSONObject {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw ControlException("no_base_url", "请先在设置里填写面板地址")

        val payload = JSONObject().apply {
            put("token", token)
            put("action", action)
            if (!mac.isNullOrBlank()) put("mac", mac.trim())
        }

        val request = Request.Builder()
            .url(base + PATH)
            .post(payload.toString().toRequestBody(JSON))
            .build()

        var httpCode = 0
        val text = try {
            client.newCall(request).execute().use { res ->
                /* 先记下 HTTP 状态：后端 5xx 也可能不带 JSON body。 */
                httpCode = res.code
                res.body?.string().orEmpty()
            }
        } catch (e: java.net.SocketTimeoutException) {
            throw ControlException("timeout", "连接超时：请检查面板地址与网络")
        } catch (e: java.io.InterruptedIOException) {
            throw ControlException("timeout", "连接超时：请检查面板地址与网络")
        } catch (e: Exception) {
            throw ControlException("network", "连接失败：${e.message ?: e.javaClass.simpleName}")
        }

        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            null
        }

        /* 后端 4xx/5xx 也带 JSON body，所以先看 error 再看 HTTP 状态。 */
        val error = json?.optString("error", "").orEmpty()
        if (error.isNotEmpty()) throw ControlException(error, messageFor(error))
        if (json == null) {
            throw ControlException(
                if (httpCode >= 500) "server" else "bad_response",
                if (httpCode >= 500) "面板服务异常（HTTP $httpCode）" else "面板返回异常数据"
            )
        }
        if (!json.optBoolean("ok", false)) throw ControlException("bad_response", "面板未确认操作结果")
        return json
    }

    private fun messageFor(code: String): String = when (code.trim().lowercase()) {
        "write_disabled" -> "路由器未开启家长控制（write_enabled=0）"
        "forbidden" -> "访问令牌无效"
        "protected_target" -> "该设备受保护，不能暂停"
        "invalid_mac" -> "MAC 地址无效"
        /* 其它错误按原值展示，避免把未知错误翻错。 */
        else -> code
    }
}

/**
 * 与服务端 `norm_mac` 一致的 MAC 归一化：去空白 → 大写 → '-' 当分隔符 →
 * 12 位裸 hex 补冒号。用于把 `/paused` 返回的 MAC 和 [Device.mac] 对上号。
 */
fun normalizeMac(mac: String): String {
    var s = mac.trim().uppercase()
    if (s.isEmpty()) return s
    s = s.replace('-', ':')
    if (s.length == 12 && s.all { it in '0'..'9' || it in 'A'..'F' }) {
        s = (0 until 12 step 2).joinToString(":") { s.substring(it, it + 2) }
    }
    return s
}
