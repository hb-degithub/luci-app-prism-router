package io.prism.router.data

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.prism.router.notify.AlertsNotifier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

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
    /** `?what=nodes` 的子节点 / AP 列表；失败时保留上一次成功结果。 */
    val nodesList: List<SubNode> = emptyList(),
    val nodesError: String? = null,
    /** 子节点数据的最近一次拉取（或尝试）时间，用于 5 分钟节流。 */
    val nodesAt: Long = 0,
    /** `?what=apps_history` 的近 7 天应用（域名）汇总；失败时保留上一次成功结果。 */
    val apps7d: List<AppHistory> = emptyList(),
    /** 应用多日汇总的最近一次拉取（或尝试）时间，用于 5 分钟节流。 */
    val apps7dAt: Long = 0,
    val apps7dError: String? = null,
    /** 多路由器：地址列表与当前选中项（下标）。空列表时由 init 迁移出单条。 */
    val servers: List<ServerProfile> = emptyList(),
    val activeIndex: Int = 0,
    /** ViewModel 本地计算的告警，已按严重度排序。 */
    val alerts: List<Alert> = emptyList(),
    /** 当前展示的是否为离线缓存数据。 */
    val offline: Boolean = false,
    /** 离线缓存的保存时间（毫秒），用于「离线数据 · 更新于 HH:mm」。 */
    val offlineAt: Long = 0
)

/** 离线缓存的读取结果。 */
private data class CachedState(val state: PanelState, val at: Long)

/** 多路由器地址上限。设置页据此禁用「添加」并提示。 */
const val MAX_SERVERS = 8

/**
 * 一个可切换的面板地址（多路由器）。
 *
 * [name] 是用户起的短名（列表标题），[url] 是面板根地址（不带末尾斜杠），
 * [token] 是可选的访问令牌。持久化在 SharedPreferences 的 `servers` JSON 数组里。
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

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private companion object {
        const val HISTORY_DAYS = 7
        const val HISTORY_REFRESH_MS = 5 * 60 * 1000L
        /* 子节点 / AP 快照：正常 5 分钟一次，失败 1 分钟后重试。 */
        const val NODES_REFRESH_MS = 5 * 60 * 1000L
        const val NODES_RETRY_MS = 60 * 1000L
        const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
        const val PREF_STATE = "stateCache"
        const val PREF_STATE_AT = "stateCacheAt"
        /* 多路由器：地址列表与当前下标（老键 baseUrl/token 继续同步，保持兼容）。 */
        const val PREF_SERVERS = "servers"
        const val PREF_ACTIVE = "activeServer"
        /* 应用多日汇总：正常 5 分钟一次，失败 1 分钟后重试。 */
        const val APPS_DAYS = 7
        const val APPS_REFRESH_MS = 5 * 60 * 1000L
        const val APPS_RETRY_MS = 60 * 1000L

        /* 告警阈值与规则见 data/AlertRules.kt（纯函数，便于单测）。 */
    }

    private val prefs = app.getSharedPreferences("prism-router", Context.MODE_PRIVATE)
    private val client = PanelClient()
    private var job: Job? = null
    private var historyJob: Job? = null
    private var nodesJob: Job? = null
    private var appsJob: Job? = null

    var ui by mutableStateOf(UiState())
        private set

    init {
        val legacyBase = normalizeUrl(prefs.getString("baseUrl", null) ?: ui.baseUrl)
        val legacyToken = prefs.getString("token", "") ?: ""
        val stored = readServers()
        /* 首次启动 / 老版本升级：把原来的单个 baseUrl + token 迁移成一条地址。 */
        val servers = stored.ifEmpty {
            listOf(ServerProfile("主路由", legacyBase, legacyToken))
        }
        val active = resolveActiveIndex(servers)
        val current = servers[active]
        ui = ui.copy(
            baseUrl = current.url,
            token = current.token,
            intervalSec = prefs.getInt("interval", 15).coerceIn(5, 300),
            servers = servers,
            activeIndex = active
        )
        /* 迁移结果写回：老代码只认 baseUrl/token，新代码以 servers 为准，两边保持同步。 */
        persistServers(servers, active)
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
        nodesJob?.cancel()
        nodesJob = null
        appsJob?.cancel()
        appsJob = null
    }

    /** 手动刷新：state 立即重取，history / nodes / 应用多日汇总一并强制重取。 */
    fun refresh() {
        refreshState(forceHistory = true)
    }

    /** 子节点 / AP 手动重试（节点屏、拓扑屏的「重试」按钮）。 */
    fun refreshNodes() {
        loadNodes(force = true)
    }

    private fun refreshState(forceHistory: Boolean = false) {
        val base = ui.baseUrl
        val token = ui.token
        ui = ui.copy(loading = true)
        viewModelScope.launch {
            try {
                val state = client.fetchState(base, token)
                /* 请求期间用户改了服务器/令牌：丢弃这次旧结果。 */
                if (ui.baseUrl != base || ui.token != token) return@launch
                val rxHist = (ui.rxHistory + state.totals.rxRate).takeLast(24)
                val txHist = (ui.txHistory + state.totals.txRate).takeLast(24)
                val alerts = computeAlerts(state)
                /* 只有「拿到 state 且告警集合确实变了」才去发通知，避免每 15s 重复触发。 */
                val alertsChanged = alerts != ui.alerts
                ui = ui.copy(
                    state = state,
                    error = null,
                    loading = false,
                    updatedAt = System.currentTimeMillis(),
                    rxHistory = rxHist,
                    txHistory = txHist,
                    alerts = alerts,
                    offline = false,
                    offlineAt = 0
                )
                /* 成功即覆盖缓存（同时视为清理了上次的离线态）。 */
                saveCache(state)
                if (alertsChanged && alerts.isNotEmpty()) notifyAlerts(alerts)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base || ui.token != token) return@launch
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
            loadNodes(force = forceHistory)
            loadAppsHistory(force = forceHistory)
        }
    }

    /* ───────────────────────── 历史趋势 ───────────────────────── */

    private fun refreshHistory(force: Boolean) {
        val now = System.currentTimeMillis()
        /* 正常 5 分钟一次；上一次失败则 1 分钟后重试（不打扰主数据）。 */
        val refreshMs = if (ui.historyError != null) 60_000L else HISTORY_REFRESH_MS
        val due = force || ui.historyAt == 0L || now - ui.historyAt > refreshMs
        if (!due) return
        if (historyJob?.isActive == true) return

        val base = ui.baseUrl
        val token = ui.token
        historyJob = viewModelScope.launch {
            try {
                val days = client.fetchHistory(base, token, HISTORY_DAYS)
                if (ui.baseUrl != base || ui.token != token) return@launch
                ui = ui.copy(
                    history = days,
                    historyAt = System.currentTimeMillis(),
                    historyError = null
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base || ui.token != token) return@launch
                /* 历史失败不影响主数据：保留上一次成功的曲线，只记下原因。 */
                ui = ui.copy(
                    historyAt = System.currentTimeMillis(),
                    historyError = e.message ?: "历史数据获取失败"
                )
            }
        }
    }

    /* ───────────────────────── 子节点 / AP ───────────────────────── */

    /**
     * 拉取 `?what=nodes` 的子节点快照。
     *
     * 主数据每 15s 轮询一次，但子节点是 5 分钟粒度的快照，所以这里独立节流：
     * 正常 5 分钟一次；上次失败则 1 分钟后重试。失败只写 [UiState.nodesError]，
     * 保留上一次成功的列表，绝不影响概览/设备等主数据。
     */
    private fun loadNodes(force: Boolean) {
        val now = System.currentTimeMillis()
        val refreshMs = if (ui.nodesError != null) NODES_RETRY_MS else NODES_REFRESH_MS
        val due = force || ui.nodesAt == 0L || now - ui.nodesAt > refreshMs
        if (!due) return
        if (nodesJob?.isActive == true) return

        val base = ui.baseUrl
        val token = ui.token
        nodesJob = viewModelScope.launch {
            try {
                val nodes = client.fetchNodes(base, token)
                if (ui.baseUrl != base || ui.token != token) return@launch
                ui = ui.copy(
                    nodesList = nodes,
                    nodesAt = System.currentTimeMillis(),
                    nodesError = null
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base || ui.token != token) return@launch
                ui = ui.copy(
                    nodesAt = System.currentTimeMillis(),
                    nodesError = e.message ?: "子节点数据获取失败"
                )
            }
        }
    }

    /* ───────────────────────── 应用多日汇总（近 7 天） ───────────────────────── */

    /**
     * 拉取 `?what=apps_history` 的近 7 天应用（域名）汇总。
     *
     * 与 history / nodes 一样独立节流：正常 5 分钟一次，失败 1 分钟后重试；
     * 启动、手动刷新、切换服务器都会走到这里。失败只写 [UiState.apps7dError]，
     * 保留上一次成功的列表，绝不影响主数据；应用页据此显示「错误 + 重试」。
     */
    fun loadAppsHistory(force: Boolean = false) {
        val now = System.currentTimeMillis()
        val refreshMs = if (ui.apps7dError != null) APPS_RETRY_MS else APPS_REFRESH_MS
        val due = force || ui.apps7dAt == 0L || now - ui.apps7dAt > refreshMs
        if (!due) return
        if (appsJob?.isActive == true) return

        val base = ui.baseUrl
        val token = ui.token
        appsJob = viewModelScope.launch {
            try {
                val apps = client.fetchAppsHistory(base, token, APPS_DAYS)
                if (ui.baseUrl != base || ui.token != token) return@launch
                ui = ui.copy(
                    apps7d = apps,
                    apps7dAt = System.currentTimeMillis(),
                    apps7dError = null
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base || ui.token != token) return@launch
                /* 失败不影响主数据：保留旧列表，只记下原因供应用页提示 / 重试。 */
                ui = ui.copy(
                    apps7dAt = System.currentTimeMillis(),
                    apps7dError = e.message ?: "近 7 天应用数据获取失败"
                )
            }
        }
    }

    /* ───────────────────────── 告警通知（本地） ───────────────────────── */

    /**
     * 把本轮告警交给通知器：只发红 / 橙，同一 key 24 小时内只发一次。
     *
     * 用 application context；失败（无权限 / 渠道被系统关闭 / 离线）静默，
     * 异常一律吞掉，不影响刷新与页面。
     */
    private fun notifyAlerts(alerts: List<Alert>) {
        try {
            AlertsNotifier.notifyIfNeeded(getApplication(), alerts)
        } catch (e: Exception) {
            /* 通知只是锦上添花，异常不上抛。 */
        }
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

    /* ───────────────────────── 多路由器 ───────────────────────── */

    /** 当前选中的地址（设置页标题 / 状态卡展示用）。 */
    val activeServer: ServerProfile?
        get() = ui.servers.getOrNull(ui.activeIndex)

    /**
     * 添加一台路由器（最多 [MAX_SERVERS] 条）。
     *
     * 返回 `null` 表示成功，否则返回给用户看的错误文案。
     * 只写配置、不自动切换；用户点「切换到」才生效。
     */
    fun addServer(name: String, url: String, token: String): String? {
        val cleanUrl = normalizeUrl(url)
        if (cleanUrl.isEmpty()) return "请填写面板地址"
        if (ui.servers.size >= MAX_SERVERS) return "最多 $MAX_SERVERS 个地址，请先删除一条"
        if (ui.servers.any { it.url.equals(cleanUrl, ignoreCase = true) }) return "该地址已在列表中"
        val cleanName = name.trim().ifEmpty { ServerProfile.hostOf(cleanUrl) }
        val list = ui.servers + ServerProfile(cleanName, cleanUrl, token)
        ui = ui.copy(servers = list)
        persistServers(list, ui.activeIndex)
        return null
    }

    /**
     * 删除指定地址；至少保留一条。
     *
     * 删掉的正是当前地址时，自动切到相邻一条并重连轮询。
     * 返回 `null` 表示成功，否则返回错误文案。
     */
    fun removeServer(index: Int): String? {
        if (index !in ui.servers.indices) return "地址不存在"
        if (ui.servers.size <= 1) return "至少保留一个地址"
        val list = ui.servers.toMutableList().apply { removeAt(index) }
        val wasActive = index == ui.activeIndex
        val nextActive = when {
            index < ui.activeIndex -> ui.activeIndex - 1
            wasActive -> index.coerceAtMost(list.lastIndex)
            else -> ui.activeIndex
        }
        ui = ui.copy(servers = list)
        if (wasActive) {
            /* 当前地址被删：走完整切换流程（停轮询 → 换地址 → 重新开始）。 */
            applyServer(nextActive)
        } else {
            ui = ui.copy(activeIndex = nextActive)
            persistServers(list, nextActive)
        }
        return null
    }

    /**
     * 切换当前地址：更新 ui.baseUrl/token、持久化，并 stop/start 轮询重新拉数据。
     *
     * 切换后旧面板的 state / 历史 / 离线缓存都不再代表当前路由器，一并清空，
     * 避免短时间内在界面上张冠李戴。
     */
    fun selectServer(index: Int) {
        if (index !in ui.servers.indices) return
        if (index == ui.activeIndex) return
        applyServer(index)
    }

    private fun applyServer(index: Int) {
        if (index !in ui.servers.indices) return
        val server = ui.servers[index]
        stop()
        /* 旧面板的离线快照属于别的路由器，直接清掉（新版会按新面板重新写）。 */
        prefs.edit().remove(PREF_STATE).remove(PREF_STATE_AT).apply()
        ui = ui.copy(
            baseUrl = server.url,
            token = server.token,
            activeIndex = index,
            state = null,
            error = null,
            loading = false,
            updatedAt = 0,
            rxHistory = emptyList(),
            txHistory = emptyList(),
            history = emptyList(),
            historyAt = 0,
            historyError = null,
            apps7d = emptyList(),
            apps7dAt = 0,
            apps7dError = null,
            nodesList = emptyList(),
            nodesAt = 0,
            nodesError = null,
            alerts = emptyList(),
            offline = false,
            offlineAt = 0
        )
        persistServers(ui.servers, index)
        start()
    }

    /** 读取 `servers`（JSON 数组）；损坏 / 缺省时返回空列表，由 init 走迁移。 */
    private fun readServers(): List<ServerProfile> {
        val raw = prefs.getString(PREF_SERVERS, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            val out = ArrayList<ServerProfile>(arr.length())
            for (i in 0 until arr.length()) {
                if (out.size >= MAX_SERVERS) break
                val o = arr.optJSONObject(i) ?: continue
                val url = normalizeUrl(o.optString("url", ""))
                if (url.isEmpty()) continue
                out.add(
                    ServerProfile(
                        name = o.optString("name", "").trim(),
                        url = url,
                        token = o.optString("token", "")
                    )
                )
            }
            out
        } catch (e: Exception) {
            /* 配置损坏按「还没有地址列表」处理，让 init 用老键迁移，不崩。 */
            emptyList()
        }
    }

    /**
     * 保存 `servers` + `activeServer`，并同步老键 `baseUrl` / `token`：
     * 老版本 / 其它模块只读这两个键，保持兼容。
     */
    private fun persistServers(servers: List<ServerProfile>, active: Int) {
        val list = servers.take(MAX_SERVERS)
        val index = if (list.isEmpty()) 0 else active.coerceIn(0, list.lastIndex)
        val arr = JSONArray()
        list.forEach { server ->
            arr.put(
                JSONObject()
                    .put("name", server.name)
                    .put("url", server.url)
                    .put("token", server.token)
            )
        }
        val editor = prefs.edit()
            .putString(PREF_SERVERS, arr.toString())
            .putInt(PREF_ACTIVE, index)
        if (list.isNotEmpty()) {
            editor.putString("baseUrl", list[index].url)
            editor.putString("token", list[index].token)
        }
        editor.apply()
    }

    /**
     * 当前地址下标：优先用保存的 `activeServer`（兼容 Int / 数字字符串），
     * 越界 / 缺失时退回与老键 `baseUrl` 相同的那条，再退回第一条。
     */
    private fun resolveActiveIndex(servers: List<ServerProfile>): Int {
        if (servers.isEmpty()) return 0
        val raw = prefs.all[PREF_ACTIVE]
        val saved = when (raw) {
            is Int -> raw
            is Long -> raw.toInt()
            is String -> raw.trim().toIntOrNull() ?: -1
            else -> -1
        }
        if (saved in servers.indices) return saved
        val legacyBase = normalizeUrl(prefs.getString("baseUrl", "") ?: "")
        val legacyIndex = servers.indexOfFirst { it.url == legacyBase }
        return if (legacyIndex >= 0) legacyIndex else 0
    }

    /** 地址归一化：去空白与末尾斜杠；空串保持空（由调用方提示）。 */
    private fun normalizeUrl(url: String): String = url.trim().trimEnd('/')

    fun saveSettings(baseUrl: String, token: String, intervalSec: Int) {
        val clean = normalizeUrl(baseUrl)
        /* 当前地址的编辑直接写回列表里的当前条，保证列表与输入框一致。 */
        val list = ui.servers.toMutableList()
        val index = if (list.isEmpty()) 0 else ui.activeIndex.coerceIn(0, list.lastIndex)
        if (list.isEmpty()) {
            list.add(ServerProfile("主路由", clean, token))
        } else {
            val current = list[index]
            list[index] = current.copy(
                /* 地址被清空时保留列表里的原地址，避免把有效配置写成空串。 */
                url = clean.ifBlank { current.url },
                token = token
            )
        }
        /* 输入框留空时不把空串写进 ui，否则界面会一直停在「请填写地址」的报错态。 */
        val effective = clean.ifBlank { list[index].url }
        prefs.edit()
            .putInt("interval", intervalSec.coerceIn(5, 300))
            /* 换了服务器，旧快照不再代表当前面板，直接清掉。 */
            .remove(PREF_STATE)
            .remove(PREF_STATE_AT)
            .apply()
        ui = ui.copy(
            baseUrl = effective,
            token = token,
            intervalSec = intervalSec.coerceIn(5, 300),
            servers = list,
            activeIndex = index,
            offline = false,
            offlineAt = 0,
            /* 换了面板地址：历史曲线 / 子节点快照 / 应用多日汇总也重新拉取。 */
            history = emptyList(),
            historyAt = 0,
            historyError = null,
            apps7d = emptyList(),
            apps7dAt = 0,
            apps7dError = null,
            nodesList = emptyList(),
            nodesAt = 0,
            nodesError = null
        )
        persistServers(list, index)
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
