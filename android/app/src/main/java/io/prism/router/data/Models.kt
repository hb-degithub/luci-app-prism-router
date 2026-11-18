package io.prism.router.data

import org.json.JSONArray
import org.json.JSONObject

/** 与棱镜路由面板 API（/cgi-bin/panel-api?what=state）对应的精简模型。 */
data class Totals(
    val rx: Long = 0,
    val tx: Long = 0,
    val rxRate: Long = 0,
    val txRate: Long = 0,
    val directRx: Long = 0,
    val directTx: Long = 0,
    val proxyRx: Long = 0,
    val proxyTx: Long = 0,
    val wifiRx: Long = 0,
    val wifiTx: Long = 0,
    val wiredRx: Long = 0,
    val wiredTx: Long = 0,
    val monthTotal: Long = 0
) {
    val total: Long get() = rx + tx
}

data class Device(
    val name: String,
    val mac: String,
    val ip: String,
    val link: String,
    val rxRate: Long,
    val txRate: Long,
    val directRx: Long,
    val directTx: Long,
    val proxyRx: Long,
    val proxyTx: Long,
    val monthTotal: Long,
    val lastSeen: Long,
    /** 单设备月配额（字节）；0 表示面板未下发该规则。 */
    val quotaLimit: Long = 0
) {
    val total: Long get() = directRx + directTx + proxyRx + proxyTx
}

data class AppUsage(
    val host: String,
    val rx: Long,
    val tx: Long,
    val devices: Int,
    val chain: String
) {
    val total: Long get() = rx + tx
}

data class NodeUsage(val name: String, val rx: Long, val tx: Long) {
    val total: Long get() = rx + tx
}

data class Health(
    val confidence: String,
    val reasons: List<String>,
    val clashConnections: Long,
    val linkSource: String,
    val linkBridge: String
)

data class PanelState(
    val ts: Long,
    val running: Boolean,
    val totals: Totals,
    val devices: List<Device>,
    val apps: List<AppUsage>,
    val nodes: List<NodeUsage>,
    val health: Health,
    val clash: String,
    val conntrack: String,
    /** state.quota.device_limit：设备配额模式下所有设备的默认上限（字节），0 表示未配置。 */
    val quotaDeviceLimit: Long = 0
) {
    val onlineCount: Int
        get() = devices.count { it.lastSeen > 0 && System.currentTimeMillis() / 1000 - it.lastSeen <= 600 }
}

/**
 * `?what=history` 的单日汇总：rx/tx 为当日总量，
 * direct_* / proxy_* 为直连与代理分项。往日来自 daily 摘要，
 * 当日由 5 分钟桶累加（后端可能不下发 summary）。
 */
data class DailyUsage(
    val day: String,
    val rx: Long = 0,
    val tx: Long = 0,
    val directRx: Long = 0,
    val directTx: Long = 0,
    val proxyRx: Long = 0,
    val proxyTx: Long = 0
) {
    val total: Long get() = rx + tx

    /** 图表横轴标签（MM-dd）。 */
    val dayLabel: String get() = if (day.length >= 10) day.substring(5) else day
}

/** 告警严重度；声明顺序即排序权重（红 > 橙 > 灰）。 */
enum class AlertSeverity { DANGER, WARN, INFO }

/** 告警点击后的目标页签（设备类告警才可跳转）。 */
enum class AlertTarget { DEVICES, HEALTH }

/** ViewModel 本地计算的单条告警；由 Overview 的「告警」卡片消费。 */
data class Alert(
    val severity: AlertSeverity,
    val title: String,
    val detail: String,
    val target: AlertTarget = AlertTarget.HEALTH
)

/** 离线缓存上限：需求约定 ≤64KB。 */
const val CACHE_MAX_BYTES = 64 * 1024

/**
 * 把 state 序列化成离线缓存 JSON。字段白名单：
 * totals / devices / apps / nodes / health / ts / running / source。
 * 超过 [maxBytes] 时逐级裁剪 devices / apps / nodes，保证落盘体积受控。
 */
fun PanelState.toCacheJson(maxBytes: Int = CACHE_MAX_BYTES): String {
    /* (devices, apps, nodes) 上限，从宽松到最简；最后一级一定装得下。 */
    val shapes = listOf(
        Triple(40, 30, 20),
        Triple(20, 15, 10),
        Triple(10, 10, 5),
        Triple(4, 4, 2),
        Triple(0, 0, 0)
    )
    for ((deviceLimit, appLimit, nodeLimit) in shapes) {
        val candidate = toCacheObject(deviceLimit, appLimit, nodeLimit).toString()
        if (candidate.toByteArray(Charsets.UTF_8).size <= maxBytes) return candidate
    }
    return toCacheObject(0, 0, 0).toString()
}

private fun PanelState.toCacheObject(deviceLimit: Int, appLimit: Int, nodeLimit: Int): JSONObject {
    val deviceArray = JSONArray()
    devices.take(deviceLimit).forEach { deviceArray.put(it.toCacheObject()) }

    val appArray = JSONArray()
    apps.take(appLimit).forEach { appArray.put(it.toCacheObject()) }

    val nodeObject = JSONObject()
    nodes.take(nodeLimit).forEach { nodes -> nodeObject.put(nodes.name, nodes.toCacheObject()) }

    val reasonArray = JSONArray()
    /* 健康原因只用于提示，缓存里限制条数与单条长度，保证极端情况下也不超 64KB。 */
    health.reasons.take(20).forEach { reasonArray.put(it.take(200)) }

    return JSONObject().apply {
        put("ts", ts)
        put("running", running)
        put("totals", totals.toCacheObject())
        put("devices", deviceArray)
        put("apps", appArray)
        put("nodes", nodeObject)
        put(
            "health",
            JSONObject().apply {
                put("accounting_confidence", health.confidence)
                put("reasons", reasonArray)
                put("clash_connections", health.clashConnections)
                put("link_source", health.linkSource)
                put("link_bridge", health.linkBridge)
            }
        )
        put(
            "source",
            JSONObject().apply {
                put("clash", clash)
                put("conntrack", conntrack)
            }
        )
    }
}

private fun Totals.toCacheObject(): JSONObject = JSONObject().apply {
    put("rx", rx)
    put("tx", tx)
    put("rx_rate", rxRate)
    put("tx_rate", txRate)
    put("direct_rx", directRx)
    put("direct_tx", directTx)
    put("proxy_rx", proxyRx)
    put("proxy_tx", proxyTx)
    put("wifi_rx", wifiRx)
    put("wifi_tx", wifiTx)
    put("wired_rx", wiredRx)
    put("wired_tx", wiredTx)
    put("month_total", monthTotal)
}

private fun Device.toCacheObject(): JSONObject = JSONObject().apply {
    put("hostname", name)
    put("mac", mac)
    put("ip", ip)
    put("link", link)
    put("rx_rate", rxRate)
    put("tx_rate", txRate)
    put("direct_rx", directRx)
    put("direct_tx", directTx)
    put("proxy_rx", proxyRx)
    put("proxy_tx", proxyTx)
    put("month_total", monthTotal)
    put("last_seen", lastSeen)
    if (quotaLimit > 0) put("quota_limit", quotaLimit)
}

private fun AppUsage.toCacheObject(): JSONObject = JSONObject().apply {
    put("host", host)
    put("rx", rx)
    put("tx", tx)
    put("devices", devices)
    put("chain", chain)
}

private fun NodeUsage.toCacheObject(): JSONObject = JSONObject().apply {
    put("rx", rx)
    put("tx", tx)
}
