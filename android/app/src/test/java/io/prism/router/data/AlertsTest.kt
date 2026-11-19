package io.prism.router.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 本地告警规则测试：时间通过 nowSec 注入，结果完全确定。
 */
class AlertsTest {

    /** 固定时间基准（秒）。 */
    private val now = 1_732_000_000L

    /* ───────────────────────── 构造工具 ───────────────────────── */

    private fun device(
        name: String = "phone",
        link: String = "wifi",
        monthTotal: Long = 0,
        quotaLimit: Long = 0,
        lastSeen: Long = now,
        rxRate: Long = 0,
        txRate: Long = 0
    ) = Device(
        name = name,
        mac = "aa:bb:cc:dd:ee:ff",
        ip = "10.0.0.2",
        link = link,
        rxRate = rxRate,
        txRate = txRate,
        directRx = 0,
        directTx = 0,
        proxyRx = 0,
        proxyTx = 0,
        monthTotal = monthTotal,
        lastSeen = lastSeen,
        quotaLimit = quotaLimit
    )

    private fun state(
        ts: Long = now,
        confidence: String = "ok",
        clash: String = "ok",
        conntrack: String = "ok",
        devices: List<Device> = emptyList(),
        quotaDeviceLimit: Long = 0
    ) = PanelState(
        ts = ts,
        running = true,
        totals = Totals(),
        devices = devices,
        apps = emptyList(),
        nodes = emptyList(),
        health = Health(confidence, emptyList(), 0, "arp", "off"),
        clash = clash,
        conntrack = conntrack,
        quotaDeviceLimit = quotaDeviceLimit
    )

    /* ───────────────────────── 基线 ───────────────────────── */

    @Test
    fun healthyPanel_hasNoAlerts() {
        assertTrue(computeAlerts(state(), now).isEmpty())
        assertTrue(computeAlerts(state(devices = listOf(device())), now).isEmpty())
    }

    /* ───────────────────────── 1) 记账不可用 ───────────────────────── */

    @Test
    fun accountingUnavailable_isDanger() {
        val alerts = computeAlerts(state(confidence = "unavailable"), now)
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.DANGER, alerts[0].severity)
        assertEquals("记账不可用", alerts[0].title)
        assertEquals(AlertTarget.HEALTH, alerts[0].target)
    }

    @Test
    fun accountingUnavailable_isCaseInsensitive() {
        val alerts = computeAlerts(state(confidence = "Unavailable"), now)
        assertEquals(1, alerts.size)
        assertEquals("记账不可用", alerts[0].title)
    }

    @Test
    fun accountingOkOrUnknown_doesNotAlert() {
        assertTrue(computeAlerts(state(confidence = "ok"), now).isEmpty())
        assertTrue(computeAlerts(state(confidence = "degraded"), now).isEmpty())
    }

    /* ───────────────────────── 2) 数据源 ───────────────────────── */

    @Test
    fun badDataSource_isDanger() {
        val alerts = computeAlerts(state(clash = "down"), now)
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.DANGER, alerts[0].severity)
        assertEquals("数据源不可用", alerts[0].title)
        assertTrue(alerts[0].detail.contains("Clash"))
        assertFalse(alerts[0].detail.contains("conntrack"))
    }

    @Test
    fun bothDataSourcesBad_listedTogether() {
        val alerts = computeAlerts(state(clash = "error", conntrack = " timeout "), now)
        assertEquals(1, alerts.size)
        assertTrue(alerts[0].detail.contains("Clash"))
        assertTrue(alerts[0].detail.contains("conntrack"))
    }

    @Test
    fun emptySource_isUnknown_notFailure() {
        val alerts = computeAlerts(state(clash = "", conntrack = "  "), now)
        assertTrue(alerts.isEmpty())
    }

    @Test
    fun sourceBad_helper() {
        assertFalse(sourceBad("ok"))
        assertFalse(sourceBad(" OK "))
        assertFalse(sourceBad(""))
        assertTrue(sourceBad("error"))
        assertTrue(sourceBad(" down "))
    }

    /* ───────────────────────── 3) 数据陈旧 ───────────────────────── */

    @Test
    fun staleData_warnsAfterThreshold() {
        val fresh = computeAlerts(state(ts = now - ALERT_STALE_SEC), now)
        assertTrue(fresh.isEmpty())

        val stale = computeAlerts(state(ts = now - ALERT_STALE_SEC - 1), now)
        assertEquals(1, stale.size)
        assertEquals(AlertSeverity.WARN, stale[0].severity)
        assertEquals("数据陈旧", stale[0].title)
        assertTrue(stale[0].detail.contains("91 秒前"))
    }

    @Test
    fun missingTimestamp_doesNotAlertStale() {
        assertTrue(computeAlerts(state(ts = 0), now).isEmpty())
    }

    /* ───────────────────────── 4)/5) 月配额 ───────────────────────── */

    @Test
    fun quotaBelowThreshold_noAlert() {
        val alerts = computeAlerts(
            state(devices = listOf(device(monthTotal = 799, quotaLimit = 1000))),
            now
        )
        assertTrue(alerts.isEmpty())
    }

    @Test
    fun quotaNearLimit_isWarn() {
        val alerts = computeAlerts(
            state(devices = listOf(device(monthTotal = 900, quotaLimit = 1000))),
            now
        )
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.WARN, alerts[0].severity)
        assertEquals("配额接近上限", alerts[0].title)
        assertEquals(AlertTarget.DEVICES, alerts[0].target)
        assertTrue(alerts[0].detail.contains("90%"))
    }

    @Test
    fun quotaOverLimit_isDanger() {
        val alerts = computeAlerts(
            state(devices = listOf(device(monthTotal = 1000, quotaLimit = 1000))),
            now
        )
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.DANGER, alerts[0].severity)
        assertEquals("配额超限", alerts[0].title)
        assertTrue(alerts[0].detail.contains("100%"))
    }

    @Test
    fun quotaFallsBackToPanelDeviceLimit() {
        /* 设备没带 quota_limit 时用 state.quota.device_limit。 */
        val alerts = computeAlerts(
            state(
                devices = listOf(device(name = "tv", monthTotal = 850, quotaLimit = 0)),
                quotaDeviceLimit = 1000
            ),
            now
        )
        assertEquals(1, alerts.size)
        assertEquals("配额接近上限", alerts[0].title)
        assertTrue(alerts[0].detail.contains("tv"))
    }

    @Test
    fun quotaWithoutAnyLimit_noAlert() {
        val alerts = computeAlerts(
            state(devices = listOf(device(monthTotal = 10_000, quotaLimit = 0)), quotaDeviceLimit = 0),
            now
        )
        assertTrue(alerts.isEmpty())
    }

    /* ───────────────────────── 6) 设备离线 ───────────────────────── */

    @Test
    fun offlineDevice_warns() {
        val alerts = computeAlerts(
            state(devices = listOf(device(name = "laptop", lastSeen = now - ALERT_OFFLINE_SEC - 1))),
            now
        )
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.WARN, alerts[0].severity)
        assertEquals("设备离线", alerts[0].title)
        assertTrue(alerts[0].detail.contains("laptop"))
    }

    @Test
    fun neverSeenDevice_countsAsOffline() {
        val alerts = computeAlerts(state(devices = listOf(device(name = "cam", lastSeen = 0))), now)
        assertEquals(1, alerts.size)
        assertEquals("设备离线", alerts[0].title)
    }

    @Test
    fun offlineListTruncatesAfterThreeNames() {
        val devices = (1..5).map { device(name = "d$it", lastSeen = now - 3600) }
        val alerts = computeAlerts(state(devices = devices), now)
        assertEquals(1, alerts.size)
        assertTrue(alerts[0].detail.contains("5 台设备"))
        assertTrue(alerts[0].detail.contains("d1、d2、d3"))
        assertFalse(alerts[0].detail.contains("d4"))
        assertTrue(alerts[0].detail.contains("等"))
    }

    /* ───────────────────────── 7) 未知接入 ───────────────────────── */

    @Test
    fun manyUnknownLinks_isInfo() {
        val devices = (1..4).map { device(name = "u$it", link = "unknown", lastSeen = now) }
        val alerts = computeAlerts(state(devices = devices), now)
        assertEquals(1, alerts.size)
        assertEquals(AlertSeverity.INFO, alerts[0].severity)
        assertEquals("接入方式未知", alerts[0].title)
        assertEquals(AlertTarget.DEVICES, alerts[0].target)
    }

    @Test
    fun exactlyThreeUnknownLinks_noAlert() {
        val devices = (1..3).map { device(name = "u$it", link = "unknown", lastSeen = now) }
        assertTrue(computeAlerts(state(devices = devices), now).isEmpty())
    }

    @Test
    fun unknownButOffline_notCounted() {
        val devices = (1..4).map {
            device(name = "u$it", link = "unknown", lastSeen = now - 3600)
        }
        /* 全离线：只出「设备离线」，不出「接入方式未知」。 */
        val alerts = computeAlerts(state(devices = devices), now)
        assertEquals(1, alerts.size)
        assertEquals("设备离线", alerts[0].title)
    }

    /* ───────────────────────── 排序 ───────────────────────── */

    @Test
    fun alerts_sortedBySeverity_dangerFirst() {
        val alerts = computeAlerts(
            state(
                ts = now - 3600,
                confidence = "unavailable",
                devices = listOf(
                    device(name = "u1", link = "unknown", lastSeen = now),
                    device(name = "old", lastSeen = now - 3600)
                )
            ),
            now
        )
        /* 记账不可用（红）+ 数据陈旧（橙）+ 设备离线（橙）。 */
        assertEquals(3, alerts.size)
        assertEquals(AlertSeverity.DANGER, alerts[0].severity)
        assertEquals("记账不可用", alerts[0].title)
        assertEquals(AlertSeverity.WARN, alerts[1].severity)
        assertEquals(AlertSeverity.WARN, alerts[2].severity)
        assertNotNull(alerts[1].detail)
    }

    /* ───────────────────────── 在线判定 ───────────────────────── */

    @Test
    fun isOnline_helper() {
        assertTrue(isOnline(device(lastSeen = now - 10), now))
        assertFalse(isOnline(device(lastSeen = now - ALERT_ONLINE_WINDOW - 1), now))
        /* 时间戳很旧但当前仍有速率：仍算在线。 */
        assertTrue(
            isOnline(device(lastSeen = now - 3600, rxRate = 1, txRate = 1), now)
        )
        assertFalse(isOnline(device(lastSeen = 0), now))
    }
}
