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

/* ───────────────────────── 检查更新（GitHub 更新源） ───────────────────────── */

/**
 * 检查更新的确定结果：
 * - [IDLE]        还没检查过；
 * - [CHECKING]    请求进行中；
 * - [NOT_CONFIGURED] 路由器没配更新源（uci 的 github_repo 为空）；
 * - [UP_TO_DATE]  已是最新；
 * - [UPDATE_AVAILABLE] 有新版本；
 * - [UNKNOWN]     后端返回了不完整的结果（没有 latest，也没给错误码）；
 * - [ERROR]       请求失败（GitHub 不可达 / 仓库不存在 / 拒绝访问等）。
 */
enum class UpdateStatus {
    IDLE, CHECKING, NOT_CONFIGURED, UP_TO_DATE, UPDATE_AVAILABLE, UNKNOWN, ERROR
}

/**
 * 一个更新产物（APK / IPK）。
 *
 * [url] 为空表示后端没给下载地址，界面不渲染对应按钮；[size] 为字节数，
 * 缺失时为 0（界面不显示大小，而不是显示 "0 B"）。
 */
data class UpdateAsset(
    val name: String = "",
    val url: String = "",
    val size: Long = 0L
) {
    /** 是否可下载：只认非空 URL（不猜文件名拼地址）。 */
    val available: Boolean get() = url.isNotBlank()

    /** 展示用文件名：后端没给时退回「安装包」。 */
    val displayName: String get() = name.trim().ifBlank { "安装包" }

    /** 大小文案；未知大小返回空串（调用方据此隐藏括号）。 */
    val sizeText: String get() = if (size > 0L) fmtBytes(size) else ""
}

/**
 * `GET /cgi-bin/prism-router-system?what=update_check[&force=1]` 的结果。
 *
 * 三种形态（与后端契约一致，缺字段一律取安全默认值）：
 * - 未配置：`configured=false`，[message] 是后端说明；
 * - 成功：`configured=true`，带 [repo] / [current] / [latest] / [hasUpdate] /
 *   [publishedAt] / [htmlUrl] / [notes] / [apk] / [ipk]；
 * - 失败：`configured=true` + [error]（`github_unavailable` / `github_not_found` /
 *   `github_unauthorized`）+ [detail]（后端诊断，只用于排查，不进 UI 主文案）。
 */
data class UpdateCheck(
    val configured: Boolean = false,
    val message: String = "",
    val repo: String = "",
    val current: String = "",
    val latest: String = "",
    val hasUpdate: Boolean = false,
    val publishedAt: String = "",
    val htmlUrl: String = "",
    val notes: String = "",
    val apk: UpdateAsset? = null,
    val ipk: UpdateAsset? = null,
    val error: String = "",
    val detail: String = ""
) {
    /** 当前版本展示文案：后端没给时用「?」，不猜。 */
    val currentText: String get() = current.trim().ifBlank { "?" }

    /** 最新版本展示文案。 */
    val latestText: String get() = latest.trim().ifBlank { "?" }

    /** 是否至少有一个可下载的安装包。 */
    val hasAsset: Boolean get() = apk?.available == true || ipk?.available == true

    /** 是否有 Release 页面可打开。 */
    val hasReleasePage: Boolean get() = htmlUrl.isNotBlank()

    /**
     * Release notes 摘要：去空行、去列表符号，用「·」连成一段并截断到 [maxChars]。
     * 只做展示裁剪，不改写原文语义。
     */
    fun notesSummary(maxChars: Int = 220): String {
        val lines = notes
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .split('\n')
            .map { line -> line.trim().trimStart('-', '*', '•').trim() }
            .filter { line -> line.isNotEmpty() && !line.startsWith("<!--") }
        if (lines.isEmpty()) return ""
        val joined = lines.joinToString(" · ")
        if (joined.length <= maxChars) return joined
        return joined.take(maxChars.coerceAtLeast(1)).trimEnd() + "…"
    }
}

/** 检查更新的 UI 状态：App 版本、最近一次 GitHub 结果与错误文案。 */
data class UpdateState(
    val status: UpdateStatus = UpdateStatus.IDLE,
    val appVersion: String = "",
    val check: UpdateCheck? = null,
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

/**
 * GitHub 的 `published_at`（ISO 8601）→ 本地时区 `yyyy-MM-dd HH:mm`。
 *
 * 支持 `2026-11-19T12:30:00Z`（App 拿到的是 UTC）与 `...+08:00`；
 * 解析失败时原样返回（后端以后可能给纯日期），绝不抛异常打断界面。
 * [zone] 只为单测固定时区而暴露，界面不传。
 */
fun formatPublishedAt(
    value: String,
    zone: java.time.ZoneId = java.time.ZoneId.systemDefault()
): String {
    val text = value.trim()
    if (text.isEmpty()) return ""
    val formatter = java.time.format.DateTimeFormatter
        .ofPattern("yyyy-MM-dd HH:mm")
        .withZone(zone)
    return try {
        formatter.format(java.time.OffsetDateTime.parse(text).toInstant())
    } catch (e: Exception) {
        try {
            formatter.format(java.time.Instant.parse(text))
        } catch (e2: Exception) {
            text
        }
    }
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

/* ───────────────────────── 路由器网络配置（管理员 ?action=config） ───────────────────────── */

/*
 * 契约（后端 /www/cgi-bin/prism-router-admin）：
 *   GET  ?action=config&token=…  → lan / wan / dhcp / system / redirects
 *   POST {action:"config_set", token, section, options, confirm:"APPLY"}
 *   POST {action:"redirect_add", token, name, src, dest, src_dport, dest_ip, dest_port, proto}
 *   POST {action:"redirect_del", token, index}
 *   POST {action:"config_rollback", token, section}
 * 令牌只允许留在内存：这里的数据类不含任何令牌字段，也不会被序列化到本机存储。
 */

/** `config_set` / `config_rollback` 的分组标识（后端只认这四个字面量）。 */
const val CONFIG_SECTION_LAN = "lan"
const val CONFIG_SECTION_WAN = "wan"
const val CONFIG_SECTION_DHCP = "dhcp"
const val CONFIG_SECTION_SYSTEM = "system"

/** `config_set` 的二次确认字面量（后端校验）。 */
const val CONFIG_CONFIRM_PHRASE = "APPLY"

/** 端口转发新增成功的提示前缀；界面据此清空表单（失败时保留用户输入）。 */
const val CONFIG_NOTE_REDIRECT_ADDED = "已添加端口转发规则"

/**
 * LAN 设置（`config.lan`）。
 *
 * [dns] 是后端下发的字符串数组；界面上用逗号分隔的多值输入框编辑，
 * [dnsText] 只负责「数组 ↔ 输入框字符串」的展示转换。
 */
data class LanConfig(
    val ipaddr: String = "",
    val netmask: String = "",
    val gateway: String = "",
    val dns: List<String> = emptyList()
) {
    /** 输入框展示用：DNS 多值 → `223.5.5.5, 114.114.114.114`。 */
    val dnsText: String get() = dns.joinToString(", ")
}

/** WAN 协议；[wire] 是发给后端的值，[label] 是分段控件文案。 */
enum class WanProto(val wire: String, val label: String) {
    DHCP("dhcp", "DHCP"),
    STATIC("static", "静态"),
    NONE("none", "无");

    companion object {
        /**
         * 后端值 → 枚举。未知协议（例如 pppoe）回退到 DHCP：
         * 界面只在用户主动选择时才写回 proto，不会把未知协议误改成 dhcp。
         */
        fun fromWire(value: String): WanProto =
            entries.firstOrNull { it.wire.equals(value.trim(), ignoreCase = true) } ?: DHCP
    }
}

/** WAN 设置（`config.wan`）。[device] 是只读的物理接口名（如 eth0 / pppoe-wan）。 */
data class WanConfig(
    val proto: String = WanProto.DHCP.wire,
    val device: String = "",
    val ipaddr: String = "",
    val netmask: String = "",
    val gateway: String = "",
    val dns: List<String> = emptyList()
) {
    val protoType: WanProto get() = WanProto.fromWire(proto)

    val static: Boolean get() = protoType == WanProto.STATIC

    val dnsText: String get() = dns.joinToString(", ")
}

/**
 * DHCP 服务设置（`config.dhcp`）。
 *
 * [start] 是地址池最后一个八位组（后端约定为字符串，如 "100"），
 * [limit] 是分配数量；两者都是字符串以保留后端的原始写法。
 */
data class DhcpConfig(
    val enabled: Boolean = true,
    val start: String = "",
    val limit: String = "",
    val leasetime: String = ""
) {
    /** 地址池结束地址（起始 + 数量 - 1）；任一字段非数字时返回 null，不猜。 */
    val poolEnd: Int?
        get() {
            val first = start.trim().toIntOrNull() ?: return null
            val count = limit.trim().toIntOrNull() ?: return null
            return first + count - 1
        }
}

/** 系统设置（`config.system`）：[timezone] 是 POSIX TZ（CST-8），[zonename] 是 IANA 名称。 */
data class RouterSystemConfig(
    val hostname: String = "",
    val timezone: String = "",
    val zonename: String = ""
)

/** 一条端口转发规则（`config.redirects[]`）；[index] 是删除时用的后端下标。 */
data class RedirectRule(
    val index: Int = -1,
    val name: String = "",
    val src: String = "lan",
    val dest: String = "lan",
    val srcDport: String = "",
    val destIp: String = "",
    val destPort: String = "",
    val proto: String = "tcp",
    val enabled: Boolean = true
) {
    val displayName: String get() = name.trim().ifBlank { "未命名规则" }

    val protoLabel: String get() = proto.trim().uppercase(Locale.US).ifBlank { "TCP" }

    val srcLabel: String get() = src.trim().uppercase(Locale.US).ifBlank { "LAN" }

    val destLabel: String get() = dest.trim().uppercase(Locale.US).ifBlank { "LAN" }

    /** 目标列展示：`192.168.100.10:8080`；缺字段时给出可读占位。 */
    val targetText: String
        get() {
            val ip = destIp.trim()
            val port = destPort.trim()
            if (ip.isBlank() && port.isBlank()) return "未填写目标"
            return if (port.isBlank()) ip else "$ip:$port"
        }
}

/** 新增端口转发时的前端草稿（不含 [RedirectRule.index]，下标由后端返回）。 */
data class RedirectDraft(
    val name: String = "",
    val src: String = "lan",
    val dest: String = "lan",
    val srcDport: String = "",
    val destIp: String = "",
    val destPort: String = "",
    val proto: String = "tcp"
)

/** `?action=config` 的完整响应（只含可展示字段，不含令牌）。 */
data class ConfigData(
    val lan: LanConfig = LanConfig(),
    val wan: WanConfig = WanConfig(),
    val dhcp: DhcpConfig = DhcpConfig(),
    val system: RouterSystemConfig = RouterSystemConfig(),
    val redirects: List<RedirectRule> = emptyList()
)

/* ───────────────────────── 配置输入校验（纯函数，便于单测） ───────────────────────── */

/**
 * 严格 IPv4 校验：四段十进制 0–255，拒绝前导零（`010` 会被路由器按八进制解释）
 * 与空段。网关 / DNS / 目标 IP 全部复用这一份规则。
 */
fun isValidIpv4(value: String): Boolean {
    val parts = value.trim().split('.')
    if (parts.size != 4) return false
    return parts.all { part ->
        if (part.isEmpty() || part.length > 3) return@all false
        if (!part.all { it.isDigit() }) return@all false
        if (part.length > 1 && part.startsWith("0")) return@all false
        val octet = part.toIntOrNull() ?: return@all false
        octet in 0..255
    }
}

/**
 * 点分掩码校验：必须是连续的 1 后接连续的 0（`255.255.255.0` 合法，
 * `255.0.255.0` 与 `0.0.0.0` 不合法），与后端 `invalid_netmask` 判定对齐。
 */
fun isValidNetmask(value: String): Boolean {
    val text = value.trim()
    if (!isValidIpv4(text)) return false
    val mask = text.split('.').fold(0) { acc, part -> (acc shl 8) or part.toInt() }
    if (mask == 0) return false
    val inverted = mask.inv()
    return (inverted and (inverted + 1)) == 0
}

/**
 * 主机名校验（RFC 1123，允许点分标签）：1–253 字符，每个标签 1–63 字符，
 * 只含 ASCII 字母 / 数字 / `-`，且首尾不能是 `-`。
 */
fun isValidHostname(value: String): Boolean {
    val text = value.trim()
    if (text.isEmpty() || text.length > 253) return false
    return text.split('.').all { label ->
        label.isNotEmpty() &&
            label.length <= 63 &&
            !label.startsWith("-") &&
            !label.endsWith("-") &&
            label.all { ch -> ch == '-' || (ch.isLetterOrDigit() && ch.code < 128) }
    }
}

/** 单端口解析：1–65535 的十进制数；非法 / 空串返回 null（界面据此提示）。 */
fun parsePortNumber(value: String): Int? {
    val text = value.trim()
    if (text.isEmpty() || text.length > 5 || !text.all { it.isDigit() }) return null
    val port = text.toIntOrNull() ?: return null
    return if (port in 1..65535) port else null
}

/**
 * DHCP 租期校验：`12h` / `30m` / `1d` / 纯数字（秒，如 `43200`）或 `infinite`。
 * 值为 0 或空串一律不合法，避免把 0 秒租期写进 dnsmasq。
 */
fun isValidLeasetime(value: String): Boolean {
    val text = value.trim().lowercase(Locale.US)
    if (text == "infinite" || text == "无限") return true
    if (text.isEmpty()) return false
    val unit = text.last()
    val digits = if (unit == 's' || unit == 'm' || unit == 'h' || unit == 'd') {
        text.dropLast(1)
    } else {
        text
    }
    if (digits.isEmpty() || !digits.all { it.isDigit() }) return false
    return (digits.toLongOrNull() ?: 0L) > 0L
}

/** DNS 输入框字符串 → 地址列表：逗号 / 中文逗号 / 空格 / 分号 / 换行分隔，去空去重。 */
fun parseDnsList(value: String): List<String> = value
    .split(',', '，', ' ', ';', '；', '\n')
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .distinct()

/** DHCP 地址池校验：起始 / 数量各为 1–254，且「起始 + 数量 - 1 ≤ 254」。返回 null 表示合法。 */
fun dhcpPoolError(start: String, limit: String): String? {
    val first = parseLastOctet(start) ?: return "起始地址需为 1–254 的数字"
    val count = parseLastOctet(limit) ?: return "地址数量需为 1–254 的数字"
    if (first + count - 1 > 254) return "地址池超出范围（起始 + 数量 - 1 不能大于 254）"
    return null
}

/** 纯函数：把 "100" 解析成 100 并限制在 1–254；非法返回 null。 */
private fun parseLastOctet(value: String): Int? {
    val text = value.trim()
    if (text.isEmpty() || text.length > 3 || !text.all { it.isDigit() }) return null
    val n = text.toIntOrNull() ?: return null
    return if (n in 1..254) n else null
}

/** 时区下拉的一个候选：[zone] 是 IANA 名称，[posix] 是 OpenWrt 使用的 POSIX TZ。 */
data class TimezoneOption(val zone: String, val posix: String)

/** 系统分组时区下拉的常用候选（不含全部 IANA 表，可手动输入覆盖）。 */
val COMMON_TIMEZONES: List<TimezoneOption> = listOf(
    TimezoneOption("Asia/Shanghai", "CST-8"),
    TimezoneOption("Asia/Hong_Kong", "HKT-8"),
    TimezoneOption("Asia/Taipei", "CST-8"),
    TimezoneOption("Asia/Tokyo", "JST-9"),
    TimezoneOption("Asia/Seoul", "KST-9"),
    TimezoneOption("Asia/Singapore", "SGT-8"),
    TimezoneOption("Europe/London", "GMT0BST,M3.5.0/1,M10.5.0"),
    TimezoneOption("Europe/Berlin", "CET-1CEST,M3.5.0,M10.5.0/3"),
    TimezoneOption("America/New_York", "EST5EDT,M3.2.0,M11.1.0"),
    TimezoneOption("America/Los_Angeles", "PST8PDT,M3.2.0,M11.1.0"),
    TimezoneOption("UTC", "UTC0")
)
