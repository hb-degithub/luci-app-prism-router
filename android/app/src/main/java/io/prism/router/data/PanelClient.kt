package io.prism.router.data

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PanelException(message: String) : Exception(message)

/**
 * 只读客户端：调用棱镜路由独立面板的 JSON API。
 * 默认地址 http://<路由器>:8099/ ，可在设置里改。所有请求都只读（what=state）。
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

    fun testConnection(baseUrl: String, token: String?): String {
        val body = get(baseUrl, "status", token)
        val o = JSONObject(body)
        val version = o.optString("version", "?")
        val running = o.optBoolean("running", false)
        return "连接成功：版本 $version，服务${if (running) "运行中" else "未运行"}"
    }

    private fun get(baseUrl: String, what: String, token: String?): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw PanelException("请先在设置里填写面板地址")
        var url = "$base/cgi-bin/panel-api?what=$what"
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

    private fun parseState(body: String): PanelState {
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
                        lastSeen = d.optLong("last_seen")
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

        return PanelState(
            ts = o.optLong("ts"),
            running = o.optBoolean("running"),
            totals = totals,
            devices = devices.sortedByDescending { it.total },
            apps = apps.sortedByDescending { it.total },
            nodes = nodes.sortedByDescending { it.total },
            health = health,
            clash = source.optString("clash", "unknown"),
            conntrack = source.optString("conntrack", "unknown")
        )
    }
}
