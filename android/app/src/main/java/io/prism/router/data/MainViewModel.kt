package io.prism.router.data

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class UiState(
    val baseUrl: String = "http://192.168.100.1:8099",
    val token: String = "",
    val intervalSec: Int = 15,
    val state: PanelState? = null,
    val error: String? = null,
    val loading: Boolean = false,
    val updatedAt: Long = 0,
    val rxHistory: List<Long> = emptyList(),
    val txHistory: List<Long> = emptyList(),
    /** 近 7 天每日流量（升序）；空列表表示尚未拿到 / 路由器没有历史。 */
    val history: List<DailyUsage> = emptyList(),
    /** 历史数据的最近一次拉取（或尝试）时间，用于 5 分钟节流。 */
    val historyAt: Long = 0,
    val historyError: String? = null,
    /** ViewModel 本地计算的告警，已按严重度排序。 */
    val alerts: List<Alert> = emptyList(),
    /** 当前展示的是否为离线缓存数据。 */
    val offline: Boolean = false,
    /** 离线缓存的保存时间（毫秒），用于「离线数据 · 更新于 HH:mm」。 */
    val offlineAt: Long = 0
)

/** 离线缓存的读取结果。 */
private data class CachedState(val state: PanelState, val at: Long)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private companion object {
        const val HISTORY_DAYS = 7
        const val HISTORY_REFRESH_MS = 5 * 60 * 1000L
        const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
        const val PREF_STATE = "stateCache"
        const val PREF_STATE_AT = "stateCacheAt"

        /* 告警阈值（与 SPEC / Web 面板一致） */
        const val ALERT_STALE_SEC = 90L
        const val ALERT_OFFLINE_SEC = 600L
        const val ALERT_ONLINE_WINDOW = 180L
        const val ALERT_QUOTA_WARN = 0.8
        const val ALERT_UNKNOWN_ONLINE = 3
        const val ALERT_DEVICE_NAMES = 3
    }

    private val prefs = app.getSharedPreferences("prism-router", Context.MODE_PRIVATE)
    private val client = PanelClient()
    private var job: Job? = null
    private var historyJob: Job? = null

    var ui by mutableStateOf(UiState())
        private set

    init {
        ui = ui.copy(
            baseUrl = prefs.getString("baseUrl", ui.baseUrl) ?: ui.baseUrl,
            token = prefs.getString("token", "") ?: "",
            intervalSec = prefs.getInt("interval", 15).coerceIn(5, 300)
        )
    }

    fun start() {
        if (job != null) return
        job = viewModelScope.launch {
            while (isActive) {
                refreshState()
                delay(ui.intervalSec * 1000L)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        historyJob?.cancel()
        historyJob = null
    }

    /** 手动刷新：state 立即重取，history 一并强制重取。 */
    fun refresh() {
        refreshState(forceHistory = true)
    }

    private fun refreshState(forceHistory: Boolean = false) {
        val base = ui.baseUrl
        val token = ui.token
        ui = ui.copy(loading = true)
        viewModelScope.launch {
            try {
                val state = client.fetchState(base, token)
                val rxHist = (ui.rxHistory + state.totals.rxRate).takeLast(24)
                val txHist = (ui.txHistory + state.totals.txRate).takeLast(24)
                ui = ui.copy(
                    state = state,
                    error = null,
                    loading = false,
                    updatedAt = System.currentTimeMillis(),
                    rxHistory = rxHist,
                    txHistory = txHist,
                    alerts = computeAlerts(state),
                    offline = false,
                    offlineAt = 0
                )
                /* 成功即覆盖缓存（同时视为清理了上次的离线态）。 */
                saveCache(state)
            } catch (e: Exception) {
                val message = e.message ?: "未知错误"
                val cached = loadCache()
                val current = ui.state
                /* 网络失败：优先展示缓存快照；若内存里的数据更新，则保留它并标注离线。 */
                if (cached != null && (current == null || cached.at > ui.updatedAt)) {
                    ui = ui.copy(
                        state = cached.state,
                        error = message,
                        loading = false,
                        offline = true,
                        offlineAt = cached.at,
                        alerts = computeAlerts(cached.state)
                    )
                } else if (current != null) {
                    ui = ui.copy(
                        error = message,
                        loading = false,
                        offline = true,
                        offlineAt = ui.updatedAt,
                        alerts = computeAlerts(current)
                    )
                } else {
                    ui = ui.copy(loading = false, error = message)
                }
            }
            refreshHistory(forceHistory)
        }
    }

    /* ───────────────────────── 历史趋势 ───────────────────────── */

    private fun refreshHistory(force: Boolean) {
        val now = System.currentTimeMillis()
        val due = force || ui.historyAt == 0L || now - ui.historyAt > HISTORY_REFRESH_MS
        if (!due) return
        if (historyJob?.isActive == true) return

        val base = ui.baseUrl
        val token = ui.token
        historyJob = viewModelScope.launch {
            try {
                val days = client.fetchHistory(base, token, HISTORY_DAYS)
                ui = ui.copy(
                    history = days,
                    historyAt = System.currentTimeMillis(),
                    historyError = null
                )
            } catch (e: Exception) {
                /* 历史失败不影响主数据：保留上一次成功的曲线，只记下原因。 */
                ui = ui.copy(
                    historyAt = System.currentTimeMillis(),
                    historyError = e.message ?: "历史数据获取失败"
                )
            }
        }
    }

    /* ───────────────────────── 告警中心（本地计算） ───────────────────────── */

    private fun computeAlerts(state: PanelState): List<Alert> {
        val now = System.currentTimeMillis() / 1000
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

    private fun sourceBad(value: String): Boolean {
        val v = value.trim().lowercase()
        return v.isNotEmpty() && v != "ok"
    }

    private fun isOnline(device: Device, now: Long): Boolean {
        if (device.lastSeen > 0 && now - device.lastSeen <= ALERT_ONLINE_WINDOW) return true
        return device.rxRate + device.txRate > 0
    }

    /* ───────────────────────── 离线缓存 ───────────────────────── */

    private suspend fun saveCache(state: PanelState) {
        try {
            val json = state.toCacheJson()
            val at = System.currentTimeMillis()
            withContext(Dispatchers.IO) {
                prefs.edit().putString(PREF_STATE, json).putLong(PREF_STATE_AT, at).apply()
            }
        } catch (e: Exception) {
            /* 缓存写失败不影响主流程。 */
        }
    }

    /** 读取 ≤24h 的离线快照；过期或损坏时清掉并返回 null。 */
    private suspend fun loadCache(): CachedState? {
        return try {
            val raw = withContext(Dispatchers.IO) { prefs.getString(PREF_STATE, null) }
            val at = withContext(Dispatchers.IO) { prefs.getLong(PREF_STATE_AT, 0L) }
            if (raw.isNullOrBlank() || at <= 0L) return null

            if (System.currentTimeMillis() - at > CACHE_TTL_MS) {
                clearCache()
                return null
            }
            CachedState(client.parseState(raw), at)
        } catch (e: Exception) {
            clearCache()
            null
        }
    }

    private suspend fun clearCache() {
        try {
            withContext(Dispatchers.IO) {
                prefs.edit().remove(PREF_STATE).remove(PREF_STATE_AT).apply()
            }
        } catch (e: Exception) {
            /* 忽略 */
        }
    }

    fun saveSettings(baseUrl: String, token: String, intervalSec: Int) {
        val clean = baseUrl.trim().trimEnd('/')
        prefs.edit()
            .putString("baseUrl", clean)
            .putString("token", token)
            .putInt("interval", intervalSec.coerceIn(5, 300))
            /* 换了服务器，旧快照不再代表当前面板，直接清掉。 */
            .remove(PREF_STATE)
            .remove(PREF_STATE_AT)
            .apply()
        ui = ui.copy(
            baseUrl = clean,
            token = token,
            intervalSec = intervalSec.coerceIn(5, 300),
            offline = false,
            offlineAt = 0,
            /* 换了面板地址：历史曲线也重新拉取。 */
            history = emptyList(),
            historyAt = 0,
            historyError = null
        )
        stop()
        start()
    }

    fun testConnection(baseUrl: String, token: String, onResult: (String) -> Unit) {
        viewModelScope.launch {
            val result = try {
                client.testConnection(baseUrl.trim().trimEnd('/'), token)
            } catch (e: Exception) {
                "连接失败：${e.message}"
            }
            onResult(result)
        }
    }

    override fun onCleared() {
        stop()
        super.onCleared()
    }
}
