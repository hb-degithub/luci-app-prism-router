package io.prism.router.notify

import io.prism.router.data.Alert
import io.prism.router.data.AlertSeverity
import io.prism.router.data.AlertTarget
import io.prism.router.data.Device
import io.prism.router.data.Health
import io.prism.router.data.PanelState
import io.prism.router.data.Totals
import io.prism.router.data.computeAlerts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [AlertsNotifier] 中「纯函数」部分的契约测试（JVM，无 Robolectric / 无设备）。
 *
 * 覆盖范围与边界（务必与实现保持一致，避免把「没验证」误报成「已验证」）：
 * - 渠道 / 去重窗口 / 最大条数常量；
 * - [AlertsNotifier.dedupeKey]：只由「严重度 + 目标页 + 标题」决定，detail 不参与；
 * - [AlertsNotifier.notificationId]：稳定、非 0、同 key 同 id；
 * - 与 [computeAlerts] 的组合：同一标题的多台设备配额告警会折叠成同一个 key，
 *   「数据陈旧」这类 detail 每轮都变的告警不会因为时间文字变化而重复通知。
 *
 * **不在本测试范围**（需要 Android 框架 / 设备，见 tests/notification-runtime-*.md）：
 * 权限检查、渠道创建、NotificationManager.notify / cancel、PendingIntent、
 * SharedPreferences 落盘、锁屏可见性、进程被杀后的调度。
 */
class AlertsNotifierTest {

    /* ───────────────────────── 常量契约 ───────────────────────── */

    @Test
    fun channelId_isStableContractValue() {
        assertEquals("prism_alerts", AlertsNotifier.CHANNEL_ID)
        assertEquals("棱镜路由告警", AlertsNotifier.CHANNEL_NAME)
    }

    @Test
    fun dedupeWindow_is24Hours() {
        assertEquals(24L * 60 * 60 * 1000, AlertsNotifier.DEDUPE_MS)
    }

    @Test
    fun maxActive_isThree() {
        assertEquals(3, AlertsNotifier.MAX_ACTIVE)
    }

    /* ───────────────────────── dedupeKey ───────────────────────── */

    private fun alert(
        severity: AlertSeverity = AlertSeverity.WARN,
        title: String = "数据陈旧",
        detail: String = "最近一次更新在 91 秒前",
        target: AlertTarget = AlertTarget.HEALTH
    ) = Alert(severity, title, detail, target)

    @Test
    fun dedupeKey_ignoresDetail() {
        /* 「数据陈旧」的 detail 里带秒数，每一轮轮询都会变；key 必须忽略它。 */
        val a = alert(detail = "最近一次更新在 91 秒前（阈值 90 秒）")
        val b = alert(detail = "最近一次更新在 106 秒前（阈值 90 秒）")
        assertEquals(AlertsNotifier.dedupeKey(a), AlertsNotifier.dedupeKey(b))
    }

    @Test
    fun dedupeKey_includesSeverityTargetAndTitle() {
        val base = alert()
        val baseKey = AlertsNotifier.dedupeKey(base)

        assertNotEquals(baseKey, AlertsNotifier.dedupeKey(base.copy(severity = AlertSeverity.DANGER)))
        assertNotEquals(baseKey, AlertsNotifier.dedupeKey(base.copy(target = AlertTarget.DEVICES)))
        assertNotEquals(baseKey, AlertsNotifier.dedupeKey(base.copy(title = "配额超限")))
    }

    @Test
    fun dedupeKey_isDeterministic() {
        val a = alert(severity = AlertSeverity.DANGER, title = "记账不可用", target = AlertTarget.HEALTH)
        assertEquals(AlertsNotifier.dedupeKey(a), AlertsNotifier.dedupeKey(a.copy(detail = "其它文案")))
    }

    /* ───────────────────────── notificationId ───────────────────────── */

    @Test
    fun notificationId_isStableAndNonZero() {
        val key = AlertsNotifier.dedupeKey(alert())
        val id = AlertsNotifier.notificationId(key)
        assertEquals(id, AlertsNotifier.notificationId(key))
        assertTrue("通知 id 必须为正数（0 是非法 id）", id > 0)
    }

    @Test
    fun notificationId_isStableAcrossProcessRuns() {
        /*
         * 纯函数 + 固定 hash：同一个 key 在进程重启后必须得到同一个 id，
         * 否则同一告警会叠加而不是覆盖。这里锁定一个显式期望值。
         */
        val key = "WARN|HEALTH|数据陈旧"
        assertEquals(key.hashCode() and 0x7FFF_FFFF, AlertsNotifier.notificationId(key))
    }

    @Test
    fun differentKeys_usuallyGetDifferentIds() {
        val warn = AlertsNotifier.dedupeKey(alert(title = "配额接近上限", target = AlertTarget.DEVICES))
        val danger = AlertsNotifier.dedupeKey(
            alert(severity = AlertSeverity.DANGER, title = "配额超限", target = AlertTarget.DEVICES)
        )
        assertNotEquals(AlertsNotifier.notificationId(warn), AlertsNotifier.notificationId(danger))
    }

    /* ───────────────────── 与 AlertRules 的组合行为 ───────────────────── */

    private val now = 1_732_000_000L

    private fun device(
        name: String,
        monthTotal: Long,
        quota: Long,
        link: String = "wifi"
    ) = Device(
        name = name,
        mac = "aa:bb:cc:dd:ee:ff",
        ip = "10.0.0.2",
        link = link,
        rxRate = 0,
        txRate = 0,
        directRx = 0,
        directTx = 0,
        proxyRx = 0,
        proxyTx = 0,
        monthTotal = monthTotal,
        lastSeen = now,
        quotaLimit = quota
    )

    private fun state(devices: List<Device>) = PanelState(
        ts = now,
        running = true,
        totals = Totals(),
        devices = devices,
        apps = emptyList(),
        nodes = emptyList(),
        health = Health("ok", emptyList(), 0, "arp", "off"),
        clash = "ok",
        conntrack = "ok",
        quotaDeviceLimit = 0
    )

    @Test
    fun quotaAlertsForDifferentDevices_collapseToSameKey() {
        /*
         * 两台设备都到 80%：AlertRules 生成两条标题相同的 WARN；
         * dedupeKey 不含 detail，所以只会通知一条（实现注释里的既定行为）。
         */
        val alerts = computeAlerts(
            state(
                listOf(
                    device("phone", monthTotal = 800, quota = 1000),
                    device("laptop", monthTotal = 850, quota = 1000)
                )
            ),
            now
        )
        val quota = alerts.filter { it.title == "配额接近上限" }
        assertEquals(2, quota.size)
        assertEquals(AlertsNotifier.dedupeKey(quota[0]), AlertsNotifier.dedupeKey(quota[1]))
    }

    @Test
    fun staleAlert_detailChangesButKeyDoesNotAcrossPollRounds() {
        /* 同一份 state 在两轮时间点计算：detail 的秒数变了，key 不变。 */
        val staleState = PanelState(
            ts = now - 1000,
            running = true,
            totals = Totals(),
            devices = emptyList(),
            apps = emptyList(),
            nodes = emptyList(),
            health = Health("ok", emptyList(), 0, "arp", "off"),
            clash = "ok",
            conntrack = "ok"
        )
        val first = computeAlerts(staleState, now)
        val second = computeAlerts(staleState, now + 15)
        assertEquals(1, first.size)
        assertEquals(1, second.size)
        assertEquals("数据陈旧", first[0].title)
        assertNotEquals(first[0].detail, second[0].detail)
        assertEquals(AlertsNotifier.dedupeKey(first[0]), AlertsNotifier.dedupeKey(second[0]))
    }

    @Test
    fun infoAlertsAreProducedButNotSendable() {
        /*
         * 4 台未知接入 → INFO。notifyIfNeeded 只发 DANGER/WARN；
         * 这里只能验证「规则确实产出 INFO」，过滤逻辑本身依赖 Android 框架，见运行时报告。
         */
        val devices = (1..4).map { device("u$it", monthTotal = 0, quota = 0, link = "unknown") }
        val alerts = computeAlerts(state(devices), now)
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.INFO, alerts[0].severity)
    }
}
