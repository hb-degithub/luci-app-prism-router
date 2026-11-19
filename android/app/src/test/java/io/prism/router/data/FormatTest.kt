package io.prism.router.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 纯格式化函数的边界测试（JVM 单元测试，不依赖 Android 框架）。
 *
 * fmtAgo 依赖「当前时间」，这里以秒级 now 为基准构造时间戳，
 * 断言的都是分钟 / 小时 / 天这类跨越较宽的档位，秒级抖动不会影响结果。
 */
class FormatTest {

    private val nowSec: Long = System.currentTimeMillis() / 1000

    /* ───────────────────────── fmtBytes ───────────────────────── */

    @Test
    fun fmtBytes_zero_and_negative_areZero() {
        assertEquals("0 B", fmtBytes(0))
        assertEquals("0 B", fmtBytes(-1))
    }

    @Test
    fun fmtBytes_bytes_stayInteger() {
        assertEquals("1 B", fmtBytes(1))
        assertEquals("512 B", fmtBytes(512))
        assertEquals("1023 B", fmtBytes(1023))
    }

    @Test
    fun fmtBytes_kb() {
        assertEquals("1.0 KB", fmtBytes(1024))
        assertEquals("1.5 KB", fmtBytes(1536))
    }

    @Test
    fun fmtBytes_mb() {
        assertEquals("1.0 MB", fmtBytes(1024L * 1024))
        assertEquals("2.5 MB", fmtBytes((2.5 * 1024 * 1024).toLong()))
    }

    @Test
    fun fmtBytes_gb() {
        assertEquals("1.0 GB", fmtBytes(1024L * 1024 * 1024))
        assertEquals("3.0 GB", fmtBytes(3L * 1024 * 1024 * 1024))
    }

    /* ───────────────────────── fmtRate ───────────────────────── */

    @Test
    fun fmtRate_usesMegabitsPerSecond() {
        assertEquals("0.00 Mbps", fmtRate(0))
        assertEquals("8.00 Mbps", fmtRate(1_000_000))
        assertEquals("1.00 Mbps", fmtRate(125_000))
        assertEquals("16.00 Mbps", fmtRate(2_000_000))
    }

    @Test
    fun fmtRateShort_keepsOneDecimal() {
        assertEquals("0.0", fmtRateShort(0))
        assertEquals("8.0", fmtRateShort(1_000_000))
        assertEquals("1.0", fmtRateShort(125_000))
    }

    /* ───────────────────────── fmtAgo ───────────────────────── */

    @Test
    fun fmtAgo_zeroOrNegative_isNever() {
        assertEquals("从未", fmtAgo(0))
        assertEquals("从未", fmtAgo(-10))
    }

    @Test
    fun fmtAgo_recent_isJustNow() {
        assertEquals("刚刚", fmtAgo(nowSec))
        assertEquals("刚刚", fmtAgo(nowSec - 30))
    }

    @Test
    fun fmtAgo_minutes() {
        assertEquals("5 分钟前", fmtAgo(nowSec - 5 * 60))
        assertEquals("59 分钟前", fmtAgo(nowSec - 59 * 60))
    }

    @Test
    fun fmtAgo_hours() {
        assertEquals("1 小时前", fmtAgo(nowSec - 3600))
        assertEquals("2 小时前", fmtAgo(nowSec - 2 * 3600))
    }

    @Test
    fun fmtAgo_days() {
        assertEquals("1 天前", fmtAgo(nowSec - 86400))
        assertEquals("2 天前", fmtAgo(nowSec - 2 * 86400))
    }

    /* ───────────────────────── fmtUptime ───────────────────────── */

    @Test
    fun fmtUptime_underOneHour_isMinutes() {
        assertEquals("0分", fmtUptime(0))
        assertEquals("1分", fmtUptime(90))
        assertEquals("59分", fmtUptime(59 * 60 + 59))
    }

    @Test
    fun fmtUptime_hours() {
        assertEquals("1小时 0分", fmtUptime(3600))
        assertEquals("1小时 1分", fmtUptime(3661))
        assertEquals("23小时 59分", fmtUptime(23 * 3600 + 59 * 60))
    }

    @Test
    fun fmtUptime_days() {
        assertEquals("1天 1小时", fmtUptime(90061))
        assertEquals("3天 0小时", fmtUptime(3 * 86400))
    }
}
