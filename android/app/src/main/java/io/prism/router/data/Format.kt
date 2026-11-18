package io.prism.router.data

import java.util.Locale
import java.util.concurrent.TimeUnit

fun fmtBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var v = bytes.toDouble()
    var i = 0
    while (v >= 1024 && i < units.size - 1) {
        v /= 1024
        i++
    }
    return if (i == 0) "${bytes} B" else String.format(Locale.US, "%.1f %s", v, units[i])
}

fun fmtRate(bytesPerSec: Long): String =
    String.format(Locale.US, "%.2f Mbps", bytesPerSec * 8.0 / 1_000_000.0)

fun fmtRateShort(bytesPerSec: Long): String =
    String.format(Locale.US, "%.1f", bytesPerSec * 8.0 / 1_000_000.0)

fun fmtAgo(ts: Long): String {
    if (ts <= 0) return "从未"
    val diff = System.currentTimeMillis() / 1000 - ts
    return when {
        diff < 60 -> "刚刚"
        diff < 3600 -> "${diff / 60} 分钟前"
        diff < 86400 -> "${diff / 3600} 小时前"
        else -> "${diff / 86400} 天前"
    }
}

fun fmtClock(ts: Long): String {
    if (ts <= 0) return "—"
    val f = java.text.SimpleDateFormat("HH:mm:ss", Locale.getDefault())
    return f.format(java.util.Date(ts))
}

fun fmtUptime(seconds: Long): String {
    val d = TimeUnit.SECONDS.toDays(seconds)
    val h = TimeUnit.SECONDS.toHours(seconds) % 24
    val m = TimeUnit.SECONDS.toMinutes(seconds) % 60
    return when {
        d > 0 -> "${d}天 ${h}小时"
        h > 0 -> "${h}小时 ${m}分"
        else -> "${m}分"
    }
}
