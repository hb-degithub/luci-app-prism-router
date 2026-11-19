package io.prism.router.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.prism.router.MainActivity
import io.prism.router.R
import io.prism.router.data.Alert
import io.prism.router.data.AlertSeverity

/**
 * 本地告警通知（纯本地，不发网络请求）。
 *
 * 规则：
 * - 只发 `danger`（红）与 `warn`（橙），`info`（灰）/ 其他不发；
 * - 同一告警 key（严重度 + 目标页 + 标题）24 小时内只通知一次；
 * - 通知栏里最多同时保留 [MAX_ACTIVE] 条，超出的从最早的开始撤掉；
 * - 点击通知打开 [MainActivity]；
 * - 无通知权限 / 渠道被系统关闭 / ROM 限制时静默返回，不抛异常、不影响刷新。
 *
 * 去重记录存放在独立 SharedPreferences（[PREF_NAME]）里，与面板设置（baseUrl/token）
 * 分开，避免设置页的读写误删通知状态。
 */
object AlertsNotifier {

    /** 渠道 id（需求约定）。 */
    const val CHANNEL_ID = "prism_alerts"

    /** 渠道中文名（系统「通知设置」里显示）。 */
    const val CHANNEL_NAME = "棱镜路由告警"

    /** 同一 key 的去重窗口：24 小时。 */
    const val DEDUPE_MS = 24L * 60 * 60 * 1000

    /** 通知栏里同时保留的最大条数。 */
    const val MAX_ACTIVE = 3

    private const val CHANNEL_DESC = "记账异常、配额、设备离线等本地告警"
    private const val PREF_NAME = "prism-router-alerts"
    private const val PREF_SEEN_PREFIX = "seen_"
    private const val PREF_SHOWN = "shown_ids"

    /**
     * 按需发送告警通知；任何异常（无权限、渠道禁用、系统限制）都被吞掉。
     *
     * 只读取 [alerts]，不做网络 IO；调用方传入 application context 即可。
     */
    fun notifyIfNeeded(context: Context, alerts: List<Alert>) {
        if (alerts.isEmpty()) return
        try {
            /* 只发红与橙：灰（info）与其它严重度一律不发。 */
            val sendable = alerts.filter {
                it.severity == AlertSeverity.DANGER || it.severity == AlertSeverity.WARN
            }
            if (sendable.isEmpty()) return
            if (!canPost(context)) return

            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return
            ensureChannel(manager)

            val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            val now = System.currentTimeMillis()

            /* 先筛出「24 小时内没通知过」的 key；同一次调用里同一个 key 只处理一次
             * （例如两台设备同时接近配额时标题相同，只留一条通知）。 */
            val pending = ArrayList<Pair<String, Alert>>(sendable.size)
            val picked = HashSet<String>(sendable.size)
            for (alert in sendable) {
                val key = dedupeKey(alert)
                if (!picked.add(key)) continue
                val last = prefs.getLong(PREF_SEEN_PREFIX + prefSuffix(key), 0L)
                if (last > 0L && now - last < DEDUPE_MS) continue
                pending.add(key to alert)
            }
            if (pending.isEmpty()) return

            val editor = prefs.edit()
            val shown = shownIds(prefs)
            for ((key, alert) in pending) {
                val id = notificationId(key)
                manager.notify(id, build(context, alert))
                /* 无论 notify 是否被系统静默丢弃，都记下时间：避免每轮刷新重复尝试。 */
                editor.putLong(PREF_SEEN_PREFIX + prefSuffix(key), now)
                shown.remove(id)
                shown.add(id)
            }

            /* 最多同时保留 3 条：从最早的一条开始撤（去重记录保留，24h 内不再弹）。 */
            while (shown.size > MAX_ACTIVE) {
                val evicted = shown.removeAt(0)
                try {
                    manager.cancel(evicted)
                } catch (e: Exception) {
                    /* 取消失败无所谓，下一轮会继续裁。 */
                }
            }

            editor.putString(PREF_SHOWN, shown.joinToString(","))
            pruneSeen(prefs, editor, now)
            editor.apply()
        } catch (e: Exception) {
            /* 通知失败静默：离线 / 无权限 / 渠道被禁用都不影响主流程。 */
        }
    }

    /* ───────────────────────── 内部 ───────────────────────── */

    /** Android 13+ 需要运行期通知权限；更早版本看用户是否在系统里关掉了通知。 */
    private fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** 渠道只建一次；已存在时保留用户改过的重要性设置。 */
    private fun ensureChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = CHANNEL_DESC
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    /** 单条告警 → 通知（点击打开 MainActivity）。 */
    private fun build(context: Context, alert: Alert): Notification {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val color = if (alert.severity == AlertSeverity.DANGER) {
            0xFFE5484D.toInt()
        } else {
            0xFFF5A524.toInt()
        }
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(alert.title)
            .setContentText(alert.detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.detail))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setColor(color)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(pending)
            .build()
    }

    /** 去重 key：严重度 + 目标页 + 标题（detail 里的百分比变化不产生新 key）。 */
    internal fun dedupeKey(alert: Alert): String =
        "${alert.severity.name}|${alert.target.name}|${alert.title}"

    /** 通知 id 由 key 稳定派生：同一条告警重发时覆盖而不是叠加。 */
    internal fun notificationId(key: String): Int {
        val id = key.hashCode() and 0x7FFF_FFFF
        return if (id == 0) 1 else id
    }

    private fun prefSuffix(key: String): String = Integer.toHexString(key.hashCode())

    private fun shownIds(prefs: SharedPreferences): MutableList<Int> {
        val raw = prefs.getString(PREF_SHOWN, "") ?: ""
        val out = ArrayList<Int>(MAX_ACTIVE)
        for (part in raw.split(',')) {
            val id = part.trim().toIntOrNull() ?: continue
            if (!out.contains(id)) out.add(id)
        }
        return out
    }

    /** 清掉超过去重窗口的记录，避免 prefs 无限增长。 */
    private fun pruneSeen(prefs: SharedPreferences, editor: SharedPreferences.Editor, now: Long) {
        for ((k, v) in prefs.all) {
            if (!k.startsWith(PREF_SEEN_PREFIX)) continue
            val at = v as? Long ?: continue
            if (now - at >= DEDUPE_MS) editor.remove(k)
        }
    }
}
