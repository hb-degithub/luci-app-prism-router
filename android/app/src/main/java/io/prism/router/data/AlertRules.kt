package io.prism.router.data

/*
 * 本地告警规则（纯函数，无 Android 依赖）。
 *
 * 从 MainViewModel 抽出来是为了可单测：时间基准由 [nowSec] 注入，
 * 给定同一份 PanelState 与同一个 nowSec，输出恒定。
 * 阈值与 SPEC / Web 面板保持一致。
 */

/** 数据陈旧阈值（秒）：超过则提示内容可能过期。 */
const val ALERT_STALE_SEC = 90L

/** 设备离线阈值（秒）：超过无活动即视为离线。 */
const val ALERT_OFFLINE_SEC = 600L

/** 在线判定窗口（秒）：[ALERT_OFFLINE_SEC] 内出现过即算在线。 */
const val ALERT_ONLINE_WINDOW = 180L

/** 月配额预警比例：达到 80% 出橙告警，100% 出红告警。 */
const val ALERT_QUOTA_WARN = 0.8

/** 未知接入方式多于该台数才提示（避免少量误判刷屏）。 */
const val ALERT_UNKNOWN_ONLINE = 3

/** 离线提示里最多列出的设备名数量。 */
const val ALERT_DEVICE_NAMES = 3

/**
 * 由面板快照计算本地告警，结果按严重度（红 > 橙 > 灰）排序。
 *
 * 只读：不修改 state，不访问网络 / 存储；[nowSec] 缺省取当前时间，
 * 测试里显式传入以获得确定性结果。
 */
fun computeAlerts(
    state: PanelState,
    nowSec: Long = System.currentTimeMillis() / 1000
): List<Alert> {
    val now = nowSec
    val out = ArrayList<Alert>()

    /* 1) 记账不可用 */
    if (state.health.confidence.equals("unavailable", true)) {
        out.add(
            Alert(
                AlertSeverity.DANGER,
                "记账不可用",
                "记账可信度为「不可用」，流量分账结果可能缺失。"
            )
        )
    }

    /* 2) 数据源非 ok */
    val failed = ArrayList<String>(2)
    if (sourceBad(state.clash)) failed.add("Clash")
    if (sourceBad(state.conntrack)) failed.add("conntrack")
    if (failed.isNotEmpty()) {
        out.add(
            Alert(
                AlertSeverity.DANGER,
                "数据源不可用",
                "采集源异常：${failed.joinToString(" / ")}，流量统计可能不完整。"
            )
        )
    }

    /* 3) 数据陈旧 */
    if (state.ts > 0) {
        val age = now - state.ts
        if (age > ALERT_STALE_SEC) {
            out.add(
                Alert(
                    AlertSeverity.WARN,
                    "数据陈旧",
                    "最近一次更新在 $age 秒前（阈值 $ALERT_STALE_SEC 秒），当前内容可能已过期。"
                )
            )
        }
    }

    /* 4)/5) 月配额：优先用设备自带的 quota_limit，缺省用 state.quota.device_limit。 */
    state.devices.forEach { device ->
        val limit = if (device.quotaLimit > 0) device.quotaLimit else state.quotaDeviceLimit
        if (limit <= 0) return@forEach
        val ratio = device.monthTotal.toDouble() / limit.toDouble()
        if (ratio < ALERT_QUOTA_WARN) return@forEach
        val over = ratio >= 1.0
        val percent = (ratio * 100).toInt()
        out.add(
            Alert(
                if (over) AlertSeverity.DANGER else AlertSeverity.WARN,
                if (over) "配额超限" else "配额接近上限",
                "${device.name} 本月 $percent%（${fmtBytes(device.monthTotal)} / ${fmtBytes(limit)}）",
                AlertTarget.DEVICES
            )
        )
    }

    /* 6) 设备离线：lastSeen <= 0 或超过 10 分钟无活动，最多列 3 台。 */
    val offline = state.devices.filter {
        it.lastSeen <= 0 || now - it.lastSeen > ALERT_OFFLINE_SEC
    }
    if (offline.isNotEmpty()) {
        val names = offline.take(ALERT_DEVICE_NAMES).joinToString("、") { it.name }
        val suffix = if (offline.size > ALERT_DEVICE_NAMES) " 等" else ""
        out.add(
            Alert(
                AlertSeverity.WARN,
                "设备离线",
                "${offline.size} 台设备超过 10 分钟无活动：$names$suffix",
                AlertTarget.DEVICES
            )
        )
    }

    /* 7) 未知接入设备较多（在线 >3 台） */
    val unknown = state.devices.count { it.link.equals("unknown", true) && isOnline(it, now) }
    if (unknown > ALERT_UNKNOWN_ONLINE) {
        out.add(
            Alert(
                AlertSeverity.INFO,
                "接入方式未知",
                "$unknown 台在线设备的接入方式未识别，建议检查 lan_bridge / wireless_ports 配置。",
                AlertTarget.DEVICES
            )
        )
    }

    return out.sortedBy { it.severity.ordinal }
}

/** 采集源状态：空串表示未知（不报），只有明确非 `ok` 才算异常。 */
internal fun sourceBad(value: String): Boolean {
    val v = value.trim().lowercase()
    return v.isNotEmpty() && v != "ok"
}

/** 在线判定：最近 [ALERT_ONLINE_WINDOW] 秒有活动，或当前仍有速率。 */
internal fun isOnline(device: Device, now: Long): Boolean {
    if (device.lastSeen > 0 && now - device.lastSeen <= ALERT_ONLINE_WINDOW) return true
    return device.rxRate + device.txRate > 0
}
