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
    val quotaLimit: Long = 0,
    /**
     * `devices[].apps`：域名 → 单设备用量。
     *
     * daemon 已按 rx 降序截断、并把长尾归并进 [DEVICE_APP_OTHER_KEY]；
     * 老快照 / 离线缓存没有该字段时为空 map（UI 显示「暂无应用明细」，不伪造数据）。
     */
    val apps: Map<String, DeviceApp> = emptyMap()
) {
    val total: Long get() = directRx + directTx + proxyRx + proxyTx

    /** 应用明细合计（仅 apps 里列出的条目），与 [total] 的差即未覆盖部分。 */
    val appsRx: Long get() = apps.values.sumOf { it.rx }
    val appsTx: Long get() = apps.values.sumOf { it.tx }
    val appsTotal: Long get() = appsRx + appsTx
}

/** daemon 归并长尾应用的固定键（不是真实域名）。 */
const val DEVICE_APP_OTHER_KEY = "__other__"

/**
 * 单设备内的一个域名（应用）用量，对应 `devices[].apps[host]` 的值。
 *
 * [chain] 是出口链路：`DIRECT`（直连）、`MIXED`（混合 / 归并桶）、或节点名（如 `香港 IPLC 01`）。
 */
data class DeviceApp(
    val host: String,
    val rx: Long = 0,
    val tx: Long = 0,
    val chain: String = ""
) {
    val total: Long get() = rx + tx

    /** `__other__` 是长尾归并桶，UI 里当成「其他」这一条展示。 */
    val isOther: Boolean get() = host == DEVICE_APP_OTHER_KEY

    /** 展示名：归并桶显示「其他」，其余就是域名本身（不显示 `__other__` 字面量）。 */
    val displayName: String get() = if (isOther) "其他" else host

    /** 只有 `DIRECT`（大小写不敏感）算直连；其余非空值都按代理 / 节点处理。 */
    val isDirect: Boolean get() = chain.trim().equals("DIRECT", ignoreCase = true)
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

/** 子节点 / AP 上报保鲜窗口（秒）：与 Web 面板一致，0–300 秒算在线。 */
const val SUB_NODE_ONLINE_SEC = 300L

/** 子节点上报新鲜度；[UNKNOWN] 表示快照里没有可信时间戳（age_sec < 0）。 */
enum class NodeFreshness { ONLINE, STALE, UNKNOWN }

/**
 * `?what=nodes` 里的一个子节点 / AP 快照（只取拓扑与列表需要的字段）。
 *
 * [ageSec] 由后端按 `now - ts` 计算；`<0` 表示时间戳不可信（未上报），
 * 0–[SUB_NODE_ONLINE_SEC] 视为在线，更大则显示「N 分钟前」。
 */
data class SubNode(
    val nodeId: String,
    val name: String,
    val ageSec: Long,
    val rx: Long,
    val tx: Long,
    val deviceCount: Int
) {
    val total: Long get() = rx + tx

    val freshness: NodeFreshness
        get() = when {
            ageSec < 0 -> NodeFreshness.UNKNOWN
            ageSec <= SUB_NODE_ONLINE_SEC -> NodeFreshness.ONLINE
            else -> NodeFreshness.STALE
        }

    /** 名称缺失时退回 node_id，再退回占位文案（后端允许 name 为空）。 */
    val displayName: String
        get() = name.trim().ifBlank { nodeId.trim().ifBlank { "未命名 AP" } }

    /** 上报新鲜度文案：在线 / N 分钟前 / 未上报。 */
    fun freshnessText(): String = when (freshness) {
        NodeFreshness.ONLINE -> "在线"
        NodeFreshness.UNKNOWN -> "未上报"
        NodeFreshness.STALE -> {
            val minutes = ageSec / 60
            if (minutes < 60) "$minutes 分钟前" else "${minutes / 60} 小时前"
        }
    }
}

data class Health(
    val confidence: String,
    val reasons: List<String>,
    val clashConnections: Long,
    val linkSource: String,
    val linkBridge: String,
    val clashPollMs: Long = 0
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

/*
 * 离线快照不写每设备的 apps：缓存硬上限 64KB，逐设备明细会挤掉设备 / 全局应用列表；
 * 读回时 apps 缺省为空 map，详情弹层按「离线缓存不含应用明细」提示，不做猜测。
 */
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
