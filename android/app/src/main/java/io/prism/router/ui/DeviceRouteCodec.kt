package io.prism.router.ui

import java.net.URLDecoder
import java.net.URLEncoder

/** device/{mac} 路由的严格 MAC 编码/解码；仅 UI 路由使用，不修改后端数据。 */
internal object DeviceRouteCodec {
    private val MAC = Regex("^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$")

    fun normalize(value: String): String {
        val input = value.trim().uppercase().replace('-', ':')
        val withColons = if (input.length == 12 && input.all { it.isDigit() || it in 'A'..'F' }) {
            (0 until 12 step 2).joinToString(":") { input.substring(it, it + 2) }
        } else input
        return withColons.takeIf { MAC.matches(it) }.orEmpty()
    }

    fun encode(value: String): String? {
        val mac = normalize(value).ifEmpty { return null }
        return URLEncoder.encode(mac, "UTF-8").replace("+", "%20")
    }

    fun decode(value: String): String {
        val raw = value.trim()
        if (raw.isEmpty() || raw == "-") return ""
        /* Navigation 2.8 已解码 path 参数；只有仍含 % 时才需要兼容手工深链。 */
        val decoded = if ('%' in raw) {
            try { URLDecoder.decode(raw, "UTF-8") } catch (_: Exception) { return "" }
        } else raw
        /* 已解码的正常 MAC 不会因第二次处理而改变；拒绝 %XX 被误当成另一台设备。 */
        return normalize(decoded)
    }
}
