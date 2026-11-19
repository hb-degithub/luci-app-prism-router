package io.prism.router.data

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.prism.router.PrismApplication
import io.prism.router.data.repository.AppError
import io.prism.router.data.repository.PanelRepository
import io.prism.router.data.store.AppSettings
import io.prism.router.data.store.DEFAULT_SERVER
import io.prism.router.data.store.SettingsStore
import io.prism.router.di.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 主界面状态。
 *
 * 字段保持与旧版完全一致（屏幕层零改动）；配置类字段（[baseUrl] / [token] /
 * [intervalSec] / [servers] / [activeIndex]）由 DataStore 经 [MainViewModel] 同步，
 * 运行数据（state / 历史 / 节点 / 应用 / 告警）由仓库轮询写入。
 */
data class UiState(
    val baseUrl: String = DEFAULT_BASE_URL,
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
    /** 多路由器：地址列表与当前选中项（下标）。空列表时退回默认地址。 */
    val servers: List<ServerProfile> = listOf(DEFAULT_SERVER),
    val activeIndex: Int = 0,
    /** ViewModel 本地计算的告警，已按严重度排序。 */
    val alerts: List<Alert> = emptyList(),
    /** 当前展示的是否为离线缓存数据。 */
    val offline: Boolean = false,
    /** 离线缓存的保存时间（毫秒），用于「离线数据 · 更新于 HH:mm」。 */
    val offlineAt: Long = 0
)

/**
 * 一次性 UI 事件（用 [Channel] 而非状态，避免旋转屏幕 / 重组时重复消费）。
 *
 * 现有屏幕尚未接入；后续可直接 `lifecycleScope.launch { vm.eventsFlow.collect { ... } }`。
 */
sealed interface UiEvent {
    /** 简短提示：连接失败、配置已保存等。 */
    data class Snackbar(val message: String) : UiEvent

    /** 已切换到另一台路由器（旧数据已清空并重新开始轮询）。 */
    data object ServerSwitched : UiEvent
}

/** 离线缓存的读取结果。 */
private data class CachedState(val state: PanelState, val at: Long)

/**
 * 主 ViewModel：只做「状态编排」，网络 / 存储全部委托给仓库与 [SettingsStore]。
 *
 * - 容器来自 [PrismApplication]，用 `AndroidViewModel` 取 Application 免去 Hilt；
 * - 配置读写是 suspend，但对外接口（[saveSettings]、[addServer] 等）保持同步签名，
 *   内部 `viewModelScope.launch` 落盘；
 * - 轮询 15s（可在设置里改 5–300s），历史 / 节点 / 应用多日汇总 5 分钟节流，
 *   失败 1 分钟后重试；
 * - 网络失败展示 ≤24h 的离线快照（仍存 SharedPreferences，兼容旧版本数据）；
 * - 主数据失败时发一次 [UiEvent.Snackbar]（同一文案去重，避免每 15s 刷屏）。
 */
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
        /* 应用多日汇总：正常 5 分钟一次，失败 1 分钟后重试。 */
        const val APPS_DAYS = 7
        const val APPS_REFRESH_MS = 5 * 60 * 1000L
        const val APPS_RETRY_MS = 60 * 1000L

        /* 告警阈值与规则见 data/AlertRules.kt（纯函数，便于单测）。 */
    }

    /* 依赖容器：Manifest 已注册 PrismApplication；兜底分支仅用于预览 / 旧宿主环境。 */
    private val container: AppContainer =
        (app as? PrismApplication)?.container ?: AppContainer(app)
    private val repository: PanelRepository = container.panelRepository
    private val settingsStore: SettingsStore = container.settingsStore

    /**
     * 仅保留离线快照的 SharedPreferences（`stateCache` / `stateCacheAt`）；
     * 地址 / 令牌 / 间隔等配置已全部迁移到 DataStore。
     */
    private val prefs = app.getSharedPreferences("prism-router", Context.MODE_PRIVATE)

    private var job: Job? = null
    private var historyJob: Job? = null
    private var nodesJob: Job? = null
    private var appsJob: Job? = null

    /** 配置是否已从 DataStore 读出；读出前不发起网络请求，避免用默认地址空跑。 */
    private var settingsReady = false
    private var autoStart = false
    private var pendingRefresh = false
    private var notifyEnabled = true

    /** 与上一次已发送的错误文案比较，避免轮询失败时重复弹 Snackbar。 */
    private var lastEmittedError: String? = null

    /** 一次性事件通道（容量有限，消费方未接入时不会阻塞主流程）。 */
    val events: Channel<UiEvent> = Channel(Channel.BUFFERED)

    /** 事件的 Flow 形式；屏幕后续可直接 collect。 */
    val eventsFlow: Flow<UiEvent> = events.receiveAsFlow()

    var ui by mutableStateOf(UiState())
        private set

    /** 当前地址列表（同步只读视图，兼容旧屏幕 / 新代码）。 */
    val servers: List<ServerProfile> get() = ui.servers

    /** 当前地址下标。 */
    val activeIndex: Int get() = ui.activeIndex

    /** 当前选中的地址（设置页标题 / 状态卡展示用）。 */
    val activeServer: ServerProfile?
        get() = ui.servers.getOrNull(ui.activeIndex)

    init {
        observeSettings()
    }

    /* ───────────────────────── 设置状态流 ───────────────────────── */

    /**
     * 收集 [SettingsStore.settings]：首个值到达后同步到 [ui] 并启动轮询。
     *
     * DataStore 是所有配置的唯一真源；界面上的保存 / 切换最终都会回到这条流，
     * 因此外部（未来设置页的主题、通知开关）改动也能自动反映。
     */
    private fun observeSettings() {
        viewModelScope.launch {
            try {
                settingsStore.settings.collect { snapshot ->
                    val first = !settingsReady
                    applySettings(snapshot)
                    if (first) onSettingsReady()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                /* DataStore 不可用：用默认配置继续运行，不让应用停在空白页。 */
                applySettings(settingsStore.fallbackSettings())
                if (!settingsReady) onSettingsReady()
            }
        }
    }

    private fun applySettings(settings: AppSettings) {
        notifyEnabled = settings.notifyEnabled
        val servers = settings.servers.ifEmpty { listOf(DEFAULT_SERVER) }
        val index = settings.activeIndex.coerceIn(0, servers.lastIndex)
        val current = servers[index]
        val interval = settings.intervalSec.coerceIn(5, 300)
        if (ui.servers == servers &&
            ui.activeIndex == index &&
            ui.baseUrl == current.url &&
            ui.token == current.token &&
            ui.intervalSec == interval
        ) {
            return
        }
        ui = ui.copy(
            baseUrl = current.url,
            token = current.token,
            intervalSec = interval,
            servers = servers,
            activeIndex = index
        )
    }

    private fun onSettingsReady() {
        if (settingsReady) return
        settingsReady = true
        when {
            autoStart -> {
                autoStart = false
                val force = pendingRefresh
                pendingRefresh = false
                startPolling(forceHistory = force)
            }

            pendingRefresh -> {
                pendingRefresh = false
                refreshState(forceHistory = true)
            }
        }
    }

    /* ───────────────────────── 轮询生命周期 ───────────────────────── */

    fun start() {
        startPolling(forceHistory = false)
    }

    private fun startPolling(forceHistory: Boolean) {
        if (job != null) return
        if (!settingsReady) {
            /* 界面先调 start()、配置稍后才读到：记下来，读到后自动接着启动。 */
            autoStart = true
            if (forceHistory) pendingRefresh = true
            return
        }
        job = viewModelScope.launch {
            var force = forceHistory || pendingRefresh
            pendingRefresh = false
            while (isActive) {
                refreshState(forceHistory = force)
                force = false
                delay(ui.intervalSec.coerceIn(5, 300) * 1000L)
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
        if (!settingsReady) {
            pendingRefresh = true
            return
        }
        refreshState(forceHistory = true)
    }

    /** 子节点 / AP 手动重试（节点屏、拓扑屏的「重试」按钮）。 */
    fun refreshNodes() {
        if (!settingsReady) return
        loadNodes(force = true)
    }

    /* ───────────────────────── 主数据 ───────────────────────── */

    private fun refreshState(forceHistory: Boolean = false) {
        if (!settingsReady) {
            pendingRefresh = true
            return
        }
        val base = ui.baseUrl
        val token = ui.token
        ui = ui.copy(loading = true)
        viewModelScope.launch {
            try {
                val state = repository.state(base, token)
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
                lastEmittedError = null
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
                emitErrorOnce(message)
            }
            refreshHistory(forceHistory)
            loadNodes(force = forceHistory)
            loadAppsHistory(force = forceHistory)
        }
    }

    private fun emitErrorOnce(message: String) {
        if (lastEmittedError == message) return
        lastEmittedError = message
        events.trySend(UiEvent.Snackbar(message))
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
                val days = repository.history(base, token, HISTORY_DAYS)
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
                val nodes = repository.nodes(base, token)
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
        if (!settingsReady) return
        val now = System.currentTimeMillis()
        val refreshMs = if (ui.apps7dError != null) APPS_RETRY_MS else APPS_REFRESH_MS
        val due = force || ui.apps7dAt == 0L || now - ui.apps7dAt > refreshMs
        if (!due) return
        if (appsJob?.isActive == true) return

        val base = ui.baseUrl
        val token = ui.token
        appsJob = viewModelScope.launch {
            try {
                val apps = repository.appsHistory(base, token, APPS_DAYS)
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
     * 受设置项 `notifyEnabled` 控制；用 application context；失败（无权限 / 渠道被
     * 系统关闭 / 离线）静默，异常一律吞掉，不影响刷新与页面。
     */
    fun notifyAlerts(alerts: List<Alert>) {
        if (!notifyEnabled || alerts.isEmpty()) return
        try {
            container.alertsNotifier.notifyIfNeeded(getApplication(), alerts)
        } catch (e: Exception) {
            /* 通知只是锦上添花，异常不上抛。 */
        }
    }

    /* ───────────────────────── 离线缓存（SharedPreferences 兼容） ───────────────────────── */

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
            CachedState(repository.parseCachedState(raw), at)
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

    /**
     * 添加一台路由器（最多 [MAX_SERVERS] 条）。
     *
     * 返回 `null` 表示成功，否则返回给用户看的错误文案。
     * 只写配置、不自动切换；用户点「切换到」才生效。
     */
    fun addServer(name: String, url: String, token: String): String? {
        if (!settingsReady) return "设置正在加载，请稍后重试"
        val cleanUrl = normalizeServerUrl(url)
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
        if (!settingsReady) return "设置正在加载，请稍后重试"
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
        lastEmittedError = null
        persistServers(ui.servers, index)
        start()
        events.trySend(UiEvent.ServerSwitched)
    }

    /** 配置落盘：DataStore 原子写入（内部保证先完成首次迁移）。 */
    private fun persistServers(servers: List<ServerProfile>, active: Int) {
        val list = servers.take(MAX_SERVERS)
        val index = if (list.isEmpty()) 0 else active.coerceIn(0, list.lastIndex)
        val interval = ui.intervalSec
        viewModelScope.launch {
            try {
                settingsStore.saveConnection(list, index, interval)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                /* 落盘失败只能提示：内存里的配置仍然可用，下一次操作会重试写入。 */
                events.trySend(UiEvent.Snackbar("设置保存失败：${e.message ?: "未知错误"}"))
            }
        }
    }

    /* ───────────────────────── 设置保存 / 连接测试 ───────────────────────── */

    fun saveSettings(baseUrl: String, token: String, intervalSec: Int) {
        val clean = normalizeServerUrl(baseUrl)
        /* 当前地址的编辑直接写回列表里的当前条，保证列表与输入框一致。 */
        val list = ui.servers.toMutableList()
        val index = if (list.isEmpty()) 0 else ui.activeIndex.coerceIn(0, list.lastIndex)
        if (list.isEmpty()) {
            list.add(ServerProfile("主路由", clean.ifBlank { DEFAULT_BASE_URL }, token))
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
        val interval = intervalSec.coerceIn(5, 300)
        /* 换了服务器，旧快照不再代表当前面板，直接清掉。 */
        prefs.edit()
            .remove(PREF_STATE)
            .remove(PREF_STATE_AT)
            .apply()
        ui = ui.copy(
            baseUrl = effective,
            token = token,
            intervalSec = interval,
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
        lastEmittedError = null
        persistServers(list, index)
        stop()
        start()
    }

    fun testConnection(baseUrl: String, token: String, onResult: (String) -> Unit) {
        viewModelScope.launch {
            val result = try {
                repository.testConnection(normalizeServerUrl(baseUrl), token)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val message = (e as? AppError)?.message ?: e.message ?: "未知错误"
                "连接失败：$message"
            }
            onResult(result)
        }
    }

    override fun onCleared() {
        stop()
        events.close()
        super.onCleared()
    }
}
