package io.prism.router.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/* ───────────────────────── 多路由器配置 ───────────────────────── */

/** 多路由器地址上限。设置页据此禁用「添加」并提示。 */
const val MAX_SERVERS = 8

/** 首次启动 / 无任何配置时使用的默认面板地址。 */
const val DEFAULT_BASE_URL = "http://192.168.100.1:8099"

/**
 * 地址归一化：去空白与末尾斜杠；空串保持空（由调用方提示）。
 *
 * 统一放在模型层，供设置存储、仓库与 ViewModel 共用，避免各自实现漂移。
 */
fun normalizeServerUrl(url: String): String = url.trim().trimEnd('/')

/**
 * 一个可切换的面板地址（多路由器）。
 *
 * [name] 是用户起的短名（列表标题），[url] 是面板根地址（不带末尾斜杠），
 * [token] 是可选的访问令牌。DataStore 的 `servers` 键以 JSON 数组持久化。
 */
data class ServerProfile(
    val name: String,
    val url: String,
    val token: String = ""
) {
    /** 展示名：名称缺失时退回地址里的主机名，避免列表出现空标题。 */
    val displayName: String get() = name.trim().ifBlank { hostOf(url) }

    companion object {
        /** 从 URL 里取主机名（兼容无 scheme、带端口 / 路径的写法）。 */
        fun hostOf(url: String): String {
            val noScheme = url.trim().substringAfter("://", url.trim())
            val host = noScheme.substringBefore('/').substringBefore(':')
            return host.ifBlank { "路由器" }
        }
    }
}

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

/**
 * `?what=apps_history` 里的单条应用（域名）多日汇总。
 *
 * [days] 是该域名在统计窗口内实际出现过的天数。daily 摘要每天只保留 Top 50，
 * 所以多日合计是「每日 Top 50」的近似值，UI 必须标注这一点，不能当成精确全量。
 */
data class AppHistory(
    val host: String,
    val rx: Long = 0,
    val tx: Long = 0,
    val chain: String = "",
    val days: Int = 0
) {
    val total: Long get() = rx + tx

    /** 只有 `DIRECT`（大小写不敏感）算直连；其余非空值都按代理 / 节点处理。 */
    val isDirect: Boolean get() = chain.trim().equals("DIRECT", ignoreCase = true)

    /** 日均：按「实际出现天数」平均；天数为 0（字段缺失）时退回合计，避免除零。 */
    val dailyAvg: Long get() = if (days > 0) total / days else total

    /** 展示名：长尾归并桶显示「其他」，其余就是域名本身。 */
    val displayName: String get() = if (host == DEVICE_APP_OTHER_KEY) "其他" else host
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

/* ───────────────────────── AP 无线客户端（?what=stations） ───────────────────────── */

/**
 * AP 上报快照的陈旧阈值（秒）：stations.uc 每分钟上报一次，300 秒仍未更新即算陈旧。
 * 与 [SUB_NODE_ONLINE_SEC] 同值，但语义是「无线站点快照」而不是「节点流量快照」。
 */
const val STATION_STALE_SEC = 300L

/** 无线信号档位：绿（好）/ 黄（一般）/ 红（弱）/ 灰（未上报 dBm）。 */
enum class SignalLevel { GOOD, FAIR, WEAK, UNKNOWN }

/**
 * 信号 dBm → 档位。阈值取消费级路由器 App 的常见分档：
 * `>= -60` 绿、`(-75, -60)` 黄、`<= -75` 红；`null`（后端没给 / 超出 -120..0）为灰。
 */
fun signalLevelOf(signal: Int?): SignalLevel = when {
    signal == null -> SignalLevel.UNKNOWN
    signal >= -60 -> SignalLevel.GOOD
    signal > -75 -> SignalLevel.FAIR
    else -> SignalLevel.WEAK
}

/** 秒数 → 简短中文跨度（45 秒 / 3 分钟 / 2 小时 5 分 / 1 天）；负数返回「—」。 */
fun fmtSpan(sec: Long): String = when {
    sec < 0L -> "—"
    sec < 60L -> "$sec 秒"
    sec < 3600L -> "${sec / 60} 分钟"
    sec < 86400L -> "${sec / 3600} 小时 ${(sec % 3600) / 60} 分"
    else -> "${sec / 86400} 天"
}

/** 上报年龄 → 「12 秒前 / N 分钟前 / 未上报」；负数（无可信时间戳）显示「未上报」。 */
fun fmtStationAge(ageSec: Long): String = when {
    ageSec < 0L -> "未上报"
    ageSec < 60L -> "${ageSec} 秒前"
    else -> fmtSpan(ageSec) + "前"
}

/**
 * `?what=stations` 里的一个 AP 节点汇总。
 *
 * [count] 是服务端统计的站点数（可能大于本次实际返回的条数：服务端按报文预算
 * 裁剪列表），[ageSec] 为该节点最后一次上报的年龄（`<0` 表示没有可信时间戳）。
 */
data class StationNode(
    val nodeId: String,
    val name: String,
    val ts: Long,
    val ageSec: Long,
    val count: Int
) {
    val displayName: String
        get() = name.trim().ifBlank { nodeId.trim().ifBlank { "未命名 AP" } }

    val freshness: NodeFreshness
        get() = when {
            ageSec < 0L -> NodeFreshness.UNKNOWN
            ageSec <= STATION_STALE_SEC -> NodeFreshness.ONLINE
            else -> NodeFreshness.STALE
        }

    /** 超过 [STATION_STALE_SEC] 未上报：UI 显示橙色「数据陈旧」。 */
    val stale: Boolean get() = freshness == NodeFreshness.STALE

    /** 状态短文案：在线 / 数据陈旧 / 未上报。 */
    fun freshnessText(): String = when (freshness) {
        NodeFreshness.ONLINE -> "在线"
        NodeFreshness.STALE -> "数据陈旧"
        NodeFreshness.UNKNOWN -> "未上报"
    }

    /** 上报年龄文案（「12 秒前」/「1 天前」/「未上报」）。 */
    fun ageText(): String = fmtStationAge(ageSec)
}

/**
 * 单条无线客户端（AP 侧 stations.uc 上报的元数据，不含任何字节字段）。
 *
 * 单位与后端一致：[signal] 为 dBm（后端判定非法时为 `null`，不能用 0 顶替），
 * [rxRate]/[txRate] 为 kbit/s（iw 的协商速率），[connectedSec] 为连接秒数。
 */
data class StationInfo(
    val mac: String,
    val nodeId: String,
    val nodeName: String,
    val iface: String,
    val signal: Int?,
    val rxRate: Int,
    val txRate: Int,
    val connectedSec: Long,
    val ts: Long,
    val ageSec: Long
) {
    /** MAC 统一大写展示（后端存小写）。 */
    val displayMac: String get() = mac.uppercase(Locale.US)

    /** 所属 AP：优先展示名，缺失时退回 node_id，再退回占位文案。 */
    val apName: String
        get() = nodeName.trim().ifBlank { nodeId.trim().ifBlank { "未知 AP" } }

    val signalLevel: SignalLevel get() = signalLevelOf(signal)

    /** 该行快照是否已过保鲜窗口（> [STATION_STALE_SEC] 秒）。 */
    val stale: Boolean get() = ageSec > STATION_STALE_SEC

    /** 信号文案：`-50 dBm` / `信号未知`。 */
    fun signalText(): String = signal?.let { "$it dBm" } ?: "信号未知"

    /** 上报年龄文案。 */
    fun ageText(): String = fmtStationAge(ageSec)

    /** 客户端行的新鲜度文案：陈旧时直接写「数据陈旧」，否则「N 分钟前 / 未上报」。 */
    fun freshnessText(): String = if (stale) "数据陈旧" else ageText()
}

/** `?what=stations` 的完整响应；`enabled=false` 表示母节点没开 AP 上报。 */
data class StationsData(
    val enabled: Boolean = true,
    val nodes: List<StationNode> = emptyList(),
    val stations: List<StationInfo> = emptyList(),
    /** 服务端统计的站点条数（可能大于 [stations] 的长度）。 */
    val count: Int = 0
) {
    val isEmpty: Boolean get() = nodes.isEmpty() && stations.isEmpty()

    val staleNodeCount: Int get() = nodes.count { it.stale }
}

/* ───────────────────────── 系统信息（/cgi-bin/prism-router-system） ───────────────────────── */

/** 内存：`total` / `free` / `available` 均为字节；`available` 缺失时退回 `free`。 */
data class MemoryInfo(
    val total: Long = 0,
    val free: Long = 0,
    val available: Long = 0
) {
    /** 可用内存：优先 `available`（含缓存可回收），没有就退回 `free`。 */
    val usable: Long get() = if (available > 0) available else free

    val used: Long get() = (total - usable).coerceAtLeast(0L)

    val usedPercent: Float
        get() = if (total > 0) (used.toFloat() / total).coerceIn(0f, 1f) else 0f

    val known: Boolean get() = total > 0
}

/** 根分区（overlay）：`total` / `used` / `free` 均为字节。 */
data class RootfsInfo(
    val total: Long = 0,
    val used: Long = 0,
    val free: Long = 0
) {
    val usedPercent: Float
        get() = if (total > 0) (used.toFloat() / total).coerceIn(0f, 1f) else 0f

    val known: Boolean get() = total > 0
}

/** `?what=system`：设备摘要（主机名 / 型号 / 内核 / 运行时间 / 负载 / 内存 / 根分区）。 */
data class SystemInfo(
    val hostname: String = "",
    val model: String = "",
    val kernel: String = "",
    val uptime: Long = 0,
    val load: List<Double> = emptyList(),
    val memory: MemoryInfo = MemoryInfo(),
    val rootfs: RootfsInfo = RootfsInfo(),
    val version: String = ""
) {
    /** 三个负载值（1 / 5 / 15 分钟），缺失时显示「—」。 */
    val loadText: String
        get() = if (load.isEmpty()) {
            "—"
        } else {
            load.take(3).joinToString(" / ") { String.format(Locale.US, "%.2f", it) }
        }
}

/** `?what=services` 的一项：系统服务运行状态。 */
data class ServiceInfo(
    val name: String,
    val label: String,
    val running: Boolean,
    val pid: Int,
    val info: String
) {
    /** 展示名：优先中文 label，缺失时退回服务名。 */
    val displayName: String
        get() = label.trim().ifBlank { name.trim().ifBlank { "未知服务" } }
}

/** `?what=processes` 的一行：PID / 用户 / CPU% / 内存% / 命令行。 */
data class ProcessInfo(
    val pid: Int,
    val user: String,
    val cpu: Double,
    val mem: Double,
    val command: String
) {
    val userText: String get() = user.trim().ifBlank { "—" }

    val commandText: String get() = command.trim().ifBlank { "—" }

    val cpuText: String get() = String.format(Locale.US, "%.1f%%", cpu.coerceAtLeast(0.0))

    val memText: String get() = String.format(Locale.US, "%.1f%%", mem.coerceAtLeast(0.0))
}

/**
 * `?what=version`：服务端版本。
 *
 * [version] 是面板 / 固件版本（检查更新时与 App 的 versionName 比较）；
 * [apkVersion] 是服务端记录的 Android 包版本，仅在 [version] 缺失时兜底；
 * [build] 是构建标识，只用于展示。
 */
data class ServerVersion(
    val version: String = "",
    val build: String = "",
    val apkVersion: String = ""
) {
    /** 参与比较的有效版本：优先 `version`，缺失时退回 `apk_version`。 */
    val effectiveVersion: String get() = version.trim().ifBlank { apkVersion.trim() }

    val displayVersion: String get() = effectiveVersion.ifBlank { "未知" }

    val known: Boolean get() = effectiveVersion.isNotBlank()
}

/* ───────────────────────── 无线射频（管理员 ?action=wifi） ───────────────────────── */

/** 一个无线射频：radio 名、SSID、频段 / 信道、客户端数、是否禁用与加密方式。 */
data class WifiDevice(
    val radio: String = "",
    val ssid: String = "",
    val band: String = "",
    val channel: String = "",
    val disabled: Boolean = false,
    val clients: Int = 0,
    val encryption: String = ""
) {
    /** 展示名：radio 名缺失时退回「无线」。 */
    val displayRadio: String get() = radio.trim().ifBlank { "无线" }
}

/** `?action=wifi` 的响应；`supported=false`（或没有射频）表示路由器没有无线网卡。 */
data class WifiInfo(
    val supported: Boolean = false,
    val devices: List<WifiDevice> = emptyList()
)

/* ───────────────────────── 检查更新 ───────────────────────── */

/** 检查更新的四种确定结果 + 两种过程态。 */
enum class UpdateStatus { IDLE, CHECKING, UP_TO_DATE, UPDATE_AVAILABLE, UNKNOWN, ERROR }

/** 检查更新的 UI 状态：App 版本、服务端版本与结论。 */
data class UpdateState(
    val status: UpdateStatus = UpdateStatus.IDLE,
    val appVersion: String = "",
    val server: ServerVersion? = null,
    val message: String? = null
)

/**
 * 提取版本号里的数字段：`"v1.2.3-beta"` → `[1, 2, 3]`、`"1.10"` → `[1, 10]`。
 * 遇到第一个非数字 / 空段即停止；完全没有数字时返回 `null`（不可比较）。
 */
fun versionParts(value: String): List<Int>? {
    val text = value.trim().removePrefix("v").removePrefix("V")
    if (text.isEmpty()) return null
    val out = ArrayList<Int>(4)
    for (chunk in text.split('.')) {
        val number = chunk.takeWhile { it.isDigit() }.toIntOrNull() ?: break
        out.add(number)
        if (out.size >= 4) break
    }
    return out.ifEmpty { null }
}

/**
 * 比较两个版本号：`>0` 表示 [a] 比 [b] 新，`<0` 更旧，`0` 相同；
 * 任一侧无法解析出数字段时返回 `null`（UI 显示「无法比较」而不是猜）。
 */
fun compareVersions(a: String, b: String): Int? {
    val left = versionParts(a) ?: return null
    val right = versionParts(b) ?: return null
    val size = maxOf(left.size, right.size)
    for (i in 0 until size) {
        val x = left.getOrElse(i) { 0 }
        val y = right.getOrElse(i) { 0 }
        if (x != y) return x.compareTo(y)
    }
    return 0
}

/** 面板健康状态（`state.health` 的只读投影）。 */
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
