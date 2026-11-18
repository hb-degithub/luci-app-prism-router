package io.prism.router.data

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
    val lastSeen: Long
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
    val conntrack: String
) {
    val onlineCount: Int
        get() = devices.count { it.lastSeen > 0 && System.currentTimeMillis() / 1000 - it.lastSeen <= 600 }
}
