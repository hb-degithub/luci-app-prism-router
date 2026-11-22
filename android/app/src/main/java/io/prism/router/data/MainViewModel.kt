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
 * 配置类字段（[baseUrl] / [token] / [intervalSec] / [servers] / [activeIndex]）由
 * DataStore 经 [MainViewModel] 同步；运行数据（state / 历史 / 节点 / 应用 / AP 客户端 /
 * 系统信息 / 管理员会话 / 更新）由 ViewModel 写入。管理员令牌不在本类里（只在 ViewModel
 * 私有字段），这里只有展示所需的登录态与到期时间。
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
    /** `?what=stations` 的 AP 无线客户端快照；失败时保留上一次成功结果。 */
    val stations: StationsData = StationsData(),
    val stationsError: String? = null,
    /** AP 快照的最近一次拉取（或尝试）时间，用于 5 分钟节流。 */
    val stationsAt: Long = 0,
    /** 是否正在拉取 AP 快照（仅在列表为空时显示骨架屏，有数据时不闪烁）。 */
    val stationsLoading: Boolean = false,
    /** 系统信息（`/cgi-bin/prism-router-system`，无需登录）。 */
    val system: SystemInfo? = null,
    val services: List<ServiceInfo> = emptyList(),
    val processes: List<ProcessInfo> = emptyList(),
    val systemError: String? = null,
    val systemAt: Long = 0,
    val systemLoading: Boolean = false,
    /**
     * 管理员会话的展示字段。
     *
     * **令牌不在这里**：它只保存在 ViewModel 的私有字段里，既不进 UiState
     * （避免 data class 的 toString / Compose 日志意外带出），也不写 DataStore。
     */
    val adminUser: String = "",
    val adminLoggedIn: Boolean = false,
    /** 令牌到期时间（秒级时间戳）；0 表示后端没给。 */
    val adminExpiresAt: Long = 0,
    val adminLoginLoading: Boolean = false,
    val adminError: String? = null,
    val adminNotice: String? = null,
    /** `?action=wifi&token=…` 的射频列表；未登录时为 null。 */
    val wifi: WifiInfo? = null,
    val wifiLoading: Boolean = false,
    /** 「网络配置」屏的读写状态；data 为 null 表示尚未读到。 */
    val config: ConfigUiState = ConfigUiState(),
    /** 重启 / 无线开关等管理写操作是否在进行中（禁用按钮、防重复提交）。 */
    val adminBusy: Boolean = false,
    /** 检查更新：本机 App 版本、GitHub Releases 上选中的 App 发版与结论（与路由器无关）。 */
    val update: UpdateState = UpdateState(),
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
 * 「网络配置」屏的状态（管理员 `?action=config` 一组接口）。
 *
 * 只做读写编排，不缓存到 DataStore：每次进屏 / 每次写成功后都重新读一遍路由器，
 * 保证界面展示的就是路由器当前值。令牌不在这里（仍在 ViewModel 私有字段）。
 */
data class ConfigUiState(
    /** 最近一次成功读取的配置；null 表示还没读到（首屏骨架 / 错误态）。 */
    val data: ConfigData? = null,
    val loading: Boolean = false,
    /** 是否有写操作（保存 / 新增 / 删除 / 回滚）在进行，用于禁用按钮与进度条。 */
    val saving: Boolean = false,
    /** 分组级错误（网络失败、登录过期、后端 internal 等）。 */
    val error: String? = null,
    /** 字段级错误：字段名 → 中文说明（invalid_ip → ipaddr）。 */
    val fieldErrors: Map<String, String> = emptyMap(),
    /** 最近一次写操作成功的提示（后端 note），由界面用 Snackbar 展示。 */
    val notice: String? = null,
    /** 提示序号：同一文案连续两次也会重新弹 Snackbar。 */
    val noticeSeq: Long = 0,
    /** 端口转发新增成功次数：界面据此清空「添加规则」表单（失败时保留输入）。 */
    val redirectAddedSeq: Long = 0,
    /** 最近一次读取完成（或失败）的时间，用于轻量节流。 */
    val at: Long = 0
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
 * - 轮询 15s（可在设置里改 5–300s），历史 / 节点 / 应用多日汇总 / AP 客户端 5 分钟节流，
 *   失败 1 分钟后重试；系统信息进设置页时读一次，同样 5 分钟节流；
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

        /* AP 无线客户端快照（stations.uc 每分钟上报）：正常 5 分钟一次，失败 1 分钟后重试。 */
        const val STATIONS_REFRESH_MS = 5 * 60 * 1000L
        const val STATIONS_RETRY_MS = 60 * 1000L

        /* 系统信息：进设置页自动读一次，之后 5 分钟节流；失败 1 分钟后可重试。 */
        const val SYSTEM_REFRESH_MS = 5 * 60 * 1000L
        const val SYSTEM_RETRY_MS = 60 * 1000L

        /* 网络配置：进屏读一次；1 分钟内重复进屏复用结果（写成功后强制重读）。 */
        const val CONFIG_CACHE_MS = 60 * 1000L

        /*
         * App 更新：启动时自动查一次 GitHub Releases，失败/成功后 6 小时内不重复自动查；
         * 手动点「检查更新」不受节流限制。GitHub 未认证接口限流 60 次/小时，节流可避免
         * 频繁冷启动把额度用光。更新与路由器无关，不需要 DataStore 配置就绪。
         */
        const val AUTO_UPDATE_CHECK_MS = 6 * 60 * 60 * 1000L
        const val PREF_UPDATE_CHECK_AT = "updateCheckAt"

        /* 告警阈值与规则见 data/AlertRules.kt（纯函数，便于单测）。 */
    }

    /* 依赖容器：Manifest 已注册 PrismApplication；兜底分支仅用于预览 / 旧宿主环境。 */
    private val container: AppContainer =
        (app as? PrismApplication)?.container ?: AppContainer(app)
    private val repository: PanelRepository = container.panelRepository
    private val settingsStore: SettingsStore = container.settingsStore

    /*
     * AP 快照复用既有只读客户端（只新增了 fetchStations()）；系统 / 管理员接口是
     * 独立 CGI，各自一个轻量客户端。三者都是无状态阻塞式 client，在 IO 线程调用。
     */
    private val panelClient = PanelClient()
    private val systemClient = SystemClient()
    private val adminClient = AdminClient()
    /* 路由器配置（LAN / WAN / DHCP / 系统 / 端口转发）：独立 CGI 段的轻量客户端。 */
    private val configClient = ConfigClient()
    /*
     * App 自动更新：直接查询 GitHub Releases，不经过路由器，也不依赖 DataStore 里的
     * 面板地址。无 token 的公开接口，调用方（checkUpdate）负责切到 IO 线程。
     */
    private val githubReleaseClient = GithubReleaseClient()

    /**
     * 仅保留离线快照的 SharedPreferences（`stateCache` / `stateCacheAt`）；
     * 地址 / 令牌 / 间隔等配置已全部迁移到 DataStore。
     */
    private val prefs = app.getSharedPreferences("prism-router", Context.MODE_PRIVATE)

    private var job: Job? = null
    private var historyJob: Job? = null
    private var nodesJob: Job? = null
    private var appsJob: Job? = null
    private var stationsJob: Job? = null
    private var systemJob: Job? = null
    private var wifiJob: Job? = null
    private var configJob: Job? = null

    /** 配置提示的自增序号（见 [ConfigUiState.noticeSeq]）。 */
    private var configNoticeSeq = 0L

    /**
     * 管理员令牌：**只保存在内存**（不进 UiState / DataStore / 日志），
     * 进程退出、切换服务器或退出登录即丢弃。
     */
    private var adminToken: String? = null

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
        /* App 更新不依赖路由器：进程启动即可查 GitHub；内部按 6 小时节流。 */
        maybeAutoCheckUpdate()
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
        stationsJob?.cancel()
        stationsJob = null
        systemJob?.cancel()
        systemJob = null
        wifiJob?.cancel()
        wifiJob = null
        configJob?.cancel()
        configJob = null
        /* 取消后不会再有心跳回来清 loading，这里主动收起骨架屏 / 进度条。 */
        if (ui.stationsLoading || ui.systemLoading || ui.wifiLoading) {
            ui = ui.copy(stationsLoading = false, systemLoading = false, wifiLoading = false)
        }
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

    /** AP 面板手动刷新（网络页「AP」分段的下拉刷新 / 重试按钮）。 */
    fun refreshStations() {
        if (!settingsReady) return
        loadStations(force = true)
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
            loadStations(force = forceHistory)
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

    /* ───────────────────────── AP 无线客户端（?what=stations） ───────────────────────── */

    /**
     * 拉取 `?what=stations` 的 AP 无线客户端快照。
     *
     * 与 nodes 一样独立节流：正常 5 分钟一次，失败 1 分钟后重试。失败只写
     * [UiState.stationsError] 并保留上一次成功结果，绝不影响拓扑 / 节点 / 概览数据。
     * 响应里的 `enabled=false`（母节点关了 AP 上报）是正常状态，由 AP 面板显示引导文案。
     */
    private fun loadStations(force: Boolean) {
        if (!settingsReady) return
        val now = System.currentTimeMillis()
        val refreshMs = if (ui.stationsError != null) STATIONS_RETRY_MS else STATIONS_REFRESH_MS
        val due = force || ui.stationsAt == 0L || now - ui.stationsAt > refreshMs
        if (!due) return
        if (stationsJob?.isActive == true) return

        val base = ui.baseUrl
        val token = ui.token
        ui = ui.copy(stationsLoading = true)
        stationsJob = viewModelScope.launch {
            try {
                val data = withContext(Dispatchers.IO) { panelClient.fetchStations(base, token) }
                if (ui.baseUrl != base || ui.token != token) return@launch
                ui = ui.copy(
                    stations = data,
                    stationsAt = System.currentTimeMillis(),
                    stationsError = null,
                    stationsLoading = false
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base || ui.token != token) return@launch
                ui = ui.copy(
                    stationsAt = System.currentTimeMillis(),
                    stationsError = e.message ?: "AP 客户端数据获取失败",
                    stationsLoading = false
                )
            }
        }
    }

    /* ───────────────────────── 系统信息（无需登录） ───────────────────────── */

    /** 设置页「系统」卡片的手动刷新。 */
    fun refreshSystem() {
        loadSystem(force = true)
    }

    /**
     * 读取系统摘要 / 服务状态 / 进程列表（三个独立 GET）。
     *
     * 进设置页自动调用一次（5 分钟节流），之后由「刷新」按钮强制重取。
     * 三项分别容错：某一项失败不影响其它两项展示；全部失败才在 UI 显示错误态。
     */
    fun loadSystem(force: Boolean = false) {
        if (!settingsReady) return
        val now = System.currentTimeMillis()
        val refreshMs = if (ui.systemError != null) SYSTEM_RETRY_MS else SYSTEM_REFRESH_MS
        val due = force || ui.systemAt == 0L || now - ui.systemAt > refreshMs
        if (!due) return
        if (systemJob?.isActive == true) return

        val base = ui.baseUrl
        ui = ui.copy(systemLoading = true)
        systemJob = viewModelScope.launch {
            val info = safely { withContext(Dispatchers.IO) { systemClient.fetchSystem(base) } }
            val services = safely { withContext(Dispatchers.IO) { systemClient.fetchServices(base) } }
            val processes = safely { withContext(Dispatchers.IO) { systemClient.fetchProcesses(base) } }
            if (ui.baseUrl != base) return@launch

            val failure = info.exceptionOrNull()
                ?: services.exceptionOrNull()
                ?: processes.exceptionOrNull()
            ui = ui.copy(
                system = info.getOrNull() ?: ui.system,
                services = services.getOrNull() ?: ui.services,
                processes = processes.getOrNull() ?: ui.processes,
                systemError = failure?.let { systemErrorMessage(it) },
                systemAt = System.currentTimeMillis(),
                systemLoading = false
            )
        }
    }

    /* ───────────────────────── 管理员登录 / 管理操作 ───────────────────────── */

    /**
     * 用 root 密码登录路由器管理接口。
     *
     * 成功时把令牌保存在 ViewModel 内存，并立即读取无线状态；失败按后端错误码给出
     * 中文提示（`bad_credentials` → 密码错误，429 → 尝试过于频繁）。密码本身不落盘。
     */
    fun adminLogin(username: String, password: String) {
        if (ui.adminLoginLoading) return
        if (!settingsReady) return
        if (password.isBlank()) {
            ui = ui.copy(adminError = "请输入管理员密码")
            return
        }
        if (ui.baseUrl.isBlank()) {
            ui = ui.copy(adminError = "请先在「连接」里填写面板地址")
            return
        }

        val base = ui.baseUrl
        val user = username.trim().ifBlank { "root" }
        ui = ui.copy(adminLoginLoading = true, adminError = null, adminNotice = null)
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { adminClient.login(base, user, password) }
                if (ui.baseUrl != base) return@launch
                adminToken = result.token
                ui = ui.copy(
                    adminUser = result.user.ifBlank { user },
                    adminLoggedIn = true,
                    adminExpiresAt = result.expires,
                    adminLoginLoading = false,
                    adminError = null,
                    adminNotice = "登录成功",
                    wifi = null,
                    wifiLoading = false,
                    /* 新会话：清掉上一次登录残留的配置数据，进配置屏时会重新读取。 */
                    config = ConfigUiState()
                )
                /* 登录后立刻拉射频列表，用户不必再点一次。 */
                wifiJob?.cancel()
                loadWifi()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                adminToken = null
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(
                    adminLoggedIn = false,
                    adminUser = "",
                    adminExpiresAt = 0,
                    adminLoginLoading = false,
                    adminError = adminErrorMessage(e),
                    wifi = null
                )
            }
        }
    }

    /** 退出登录：本地立即清空令牌，服务端删除失败也不打扰用户。 */
    fun adminLogout() {
        val base = ui.baseUrl
        val token = adminToken
        adminToken = null
        wifiJob?.cancel()
        wifiJob = null
        ui = ui.copy(
            adminLoggedIn = false,
            adminUser = "",
            adminExpiresAt = 0,
            adminLoginLoading = false,
            adminError = null,
            adminNotice = "已退出管理员登录",
            wifi = null,
            wifiLoading = false,
            adminBusy = false,
            /* 令牌失效：配置数据（只对登录会话可见）一并清空，避免残留展示。 */
            config = ConfigUiState()
        )
        if (token.isNullOrBlank()) return
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { adminClient.logout(base, token) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                /* 服务端令牌会在 30 分钟内自然过期，退出失败不需要提示。 */
            }
        }
    }

    /** 重新读取无线状态（登录后自动调用；失败保留空态 + 错误提示）。 */
    fun adminReloadWifi() {
        if (!ui.adminLoggedIn) return
        wifiJob?.cancel()
        loadWifi()
    }

    private fun loadWifi() {
        if (!ui.adminLoggedIn) return
        if (wifiJob?.isActive == true) return
        val token = validAdminToken() ?: return
        val base = ui.baseUrl
        ui = ui.copy(wifiLoading = true)
        wifiJob = viewModelScope.launch {
            try {
                val wifi = withContext(Dispatchers.IO) { adminClient.fetchWifi(base, token) }
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(wifi = wifi, wifiLoading = false, adminError = null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(wifiLoading = false, wifi = null, adminError = adminErrorMessage(e))
                if (e is AdminException && e.code == "unauthorized") clearAdminSession()
            }
        }
    }

    /**
     * 开关某个射频：`disabled=true` 关闭无线。
     *
     * 关闭会断开该频段的客户端（本机若走 Wi-Fi 也会掉线），由 UI 在做之前说明。
     * 成功后重新读取无线状态，让开关显示与实际一致。
     */
    fun adminSetWifiDisabled(radio: String, disabled: Boolean) {
        if (ui.adminBusy) return
        val token = validAdminToken() ?: return
        val base = ui.baseUrl
        ui = ui.copy(adminBusy = true, adminError = null, adminNotice = null)
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { adminClient.setWifiDisabled(base, token, radio, disabled) }
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(
                    adminBusy = false,
                    adminNotice = if (disabled) "已关闭 $radio 无线" else "已开启 $radio 无线"
                )
                wifiJob?.cancel()
                loadWifi()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(adminBusy = false, adminError = adminErrorMessage(e))
                if (e is AdminException && e.code == "unauthorized") clearAdminSession()
            }
        }
    }

    /** 重启路由器：必须带字面量 `REBOOT` 二次确认；后台会在回包后延迟 1 秒重启。 */
    fun adminReboot(confirm: String) {
        if (ui.adminBusy) return
        if (confirm.trim() != "REBOOT") {
            ui = ui.copy(adminError = "请输入 REBOOT 确认重启")
            return
        }
        val token = validAdminToken() ?: return
        val base = ui.baseUrl
        ui = ui.copy(adminBusy = true, adminError = null, adminNotice = null)
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { adminClient.reboot(base, token, "REBOOT") }
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(
                    adminBusy = false,
                    adminNotice = "重启命令已发送：路由器将在约 1 分钟后重启，期间面板会断开连接。"
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(adminBusy = false, adminError = adminErrorMessage(e))
                if (e is AdminException && e.code == "unauthorized") clearAdminSession()
            }
        }
    }

    /**
     * 校验并返回当前令牌：过期时清空会话并提示重新登录。
     * 令牌只在内存里，任何路径都不会写盘 / 打印。
     */
    private fun validAdminToken(): String? {
        val token = adminToken
        if (token.isNullOrBlank()) {
            ui = ui.copy(
                adminLoggedIn = false,
                adminUser = "",
                adminExpiresAt = 0,
                adminError = "请先登录管理员"
            )
            return null
        }
        val expires = ui.adminExpiresAt
        if (expires > 0L && System.currentTimeMillis() / 1000 >= expires) {
            clearAdminSession()
            ui = ui.copy(adminError = "登录已过期，请重新登录")
            return null
        }
        return token
    }

    private fun clearAdminSession() {
        adminToken = null
        wifiJob?.cancel()
        wifiJob = null
        configJob?.cancel()
        configJob = null
        ui = ui.copy(
            adminLoggedIn = false,
            adminUser = "",
            adminExpiresAt = 0,
            adminLoginLoading = false,
            adminNotice = null,
            wifi = null,
            wifiLoading = false,
            adminBusy = false,
            config = ConfigUiState()
        )
    }

    private fun adminErrorMessage(error: Throwable): String = when (error) {
        is AdminException -> error.message
        else -> error.message ?: "管理员操作失败"
    }

    /* ───────────────────────── 网络配置（管理员 ?action=config） ───────────────────────── */

    /**
     * 读取路由器网络配置（`GET ?action=config&token=…`）。
     *
     * 只读不缓存：每次进屏、每次写成功后都重新读一遍，界面展示的永远是路由器当前值。
     * [force]=false 时 60 秒内复用上次结果，避免切换分组来回打接口。
     * 令牌过期（`unauthorized`）会清空管理员会话，界面随之回到「需先登录」状态。
     */
    fun configLoad(force: Boolean = false) {
        if (!ui.adminLoggedIn) return
        val fresh = System.currentTimeMillis() - ui.config.at < CONFIG_CACHE_MS
        if (!force && ui.config.data != null && fresh) return
        if (configJob?.isActive == true) return
        val token = validAdminToken() ?: return
        val base = ui.baseUrl
        ui = ui.copy(config = ui.config.copy(loading = true, error = null))
        configJob = viewModelScope.launch {
            try {
                val data = withContext(Dispatchers.IO) { configClient.fetchConfig(base, token) }
                if (ui.baseUrl != base) return@launch
                ui = ui.copy(
                    config = ui.config.copy(
                        data = data,
                        loading = false,
                        error = null,
                        fieldErrors = emptyMap(),
                        at = System.currentTimeMillis()
                    )
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base) return@launch
                val message = (e as? ConfigException)?.message ?: e.message ?: "配置读取失败"
                val expired = e is ConfigException && e.code == "unauthorized"
                if (expired) clearAdminSession()
                ui = ui.copy(
                    config = ui.config.copy(
                        loading = false,
                        error = message,
                        at = System.currentTimeMillis()
                    )
                )
            }
        }
    }

    /**
     * 所有配置写操作的公共流程：登录态校验 → 置 saving → 执行 → 成功提示 + 重新读取。
     *
     * 失败按后端错误码映射中文；后端给了 `field`（或错误码能定位字段）时把说明
     * 落到对应输入框（[ConfigUiState.fieldErrors]），否则作为分组级错误展示。
     * 写操作不自动重试，避免配置被重复下发。
     */
    private fun configWrite(
        onSuccess: (() -> Unit)? = null,
        action: suspend (base: String, token: String) -> String?
    ) {
        if (!ui.adminLoggedIn) return
        if (ui.config.saving) return
        val token = validAdminToken() ?: return
        val base = ui.baseUrl
        ui = ui.copy(
            config = ui.config.copy(saving = true, error = null, fieldErrors = emptyMap())
        )
        viewModelScope.launch {
            try {
                val note = withContext(Dispatchers.IO) { action(base, token) }
                if (ui.baseUrl != base) return@launch
                configNoticeSeq += 1
                ui = ui.copy(
                    config = ui.config.copy(
                        saving = false,
                        error = null,
                        fieldErrors = emptyMap(),
                        notice = note?.takeIf { it.isNotBlank() } ?: "配置已保存",
                        noticeSeq = configNoticeSeq
                    )
                )
                onSuccess?.invoke()
                /* 写完立刻重读：界面展示的永远是路由器当前值（而不是本地乐观值）。 */
                configJob?.cancel()
                configLoad(force = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ui.baseUrl != base) return@launch
                val code = (e as? ConfigException)?.code.orEmpty()
                val field = (e as? ConfigException)?.field.orEmpty()
                    .ifBlank { ConfigClient.fieldFor(code) }
                val message = (e as? ConfigException)?.message
                    ?: e.message
                    ?: "配置操作失败"
                if (code == "unauthorized") clearAdminSession()
                ui = ui.copy(
                    config = ui.config.copy(
                        saving = false,
                        error = message,
                        fieldErrors = if (field.isBlank()) emptyMap() else mapOf(field to message)
                    )
                )
            }
        }
    }

    /** 保存 LAN：IP / 掩码 / 网关 / DNS（多值）。 */
    fun configSaveLan(ipaddr: String, netmask: String, gateway: String, dns: List<String>) {
        configWrite { base, token ->
            configClient.setSection(
                base,
                token,
                CONFIG_SECTION_LAN,
                mapOf(
                    "ipaddr" to ipaddr.trim(),
                    "netmask" to netmask.trim(),
                    "gateway" to gateway.trim(),
                    "dns" to dns.map { it.trim() }.filter { it.isNotEmpty() }
                )
            )
        }
    }

    /**
     * 保存 WAN：DHCP / 无只下发 proto（不覆盖路由器当前的地址 / DNS）；
     * 静态才下发 IP / 掩码 / 网关 / DNS，避免把空串写进 uci。
     */
    fun configSaveWan(
        proto: String,
        ipaddr: String,
        netmask: String,
        gateway: String,
        dns: List<String>
    ) {
        configWrite { base, token ->
            val cleanProto = WanProto.fromWire(proto).wire
            val options = LinkedHashMap<String, Any?>()
            options["proto"] = cleanProto
            if (cleanProto == WanProto.STATIC.wire) {
                options["ipaddr"] = ipaddr.trim()
                options["netmask"] = netmask.trim()
                options["gateway"] = gateway.trim()
                options["dns"] = dns.map { it.trim() }.filter { it.isNotEmpty() }
            }
            configClient.setSection(base, token, CONFIG_SECTION_WAN, options)
        }
    }

    /** 保存 DHCP：启用开关 / 地址池起始 / 数量 / 租期。 */
    fun configSaveDhcp(enabled: Boolean, start: String, limit: String, leasetime: String) {
        configWrite { base, token ->
            configClient.setSection(
                base,
                token,
                CONFIG_SECTION_DHCP,
                mapOf(
                    "enabled" to enabled,
                    "start" to start.trim(),
                    "limit" to limit.trim(),
                    "leasetime" to leasetime.trim()
                )
            )
        }
    }

    /** 保存系统分组：主机名 / POSIX 时区 / IANA 时区名。 */
    fun configSaveSystem(hostname: String, timezone: String, zonename: String) {
        configWrite { base, token ->
            configClient.setSection(
                base,
                token,
                CONFIG_SECTION_SYSTEM,
                mapOf(
                    "hostname" to hostname.trim(),
                    "timezone" to timezone.trim(),
                    "zonename" to zonename.trim()
                )
            )
        }
    }

    /** 新增端口转发；成功后重新读取列表（下标由后端分配）并通知界面清空表单。 */
    fun configAddRedirect(draft: RedirectDraft) {
        configWrite(
            onSuccess = {
                ui = ui.copy(
                    config = ui.config.copy(
                        redirectAddedSeq = ui.config.redirectAddedSeq + 1
                    )
                )
            }
        ) { base, token ->
            val index = configClient.addRedirect(base, token, draft)
            if (index >= 0) "$CONFIG_NOTE_REDIRECT_ADDED（#$index）" else CONFIG_NOTE_REDIRECT_ADDED
        }
    }

    /** 删除端口转发；[index] 为后端下发的规则下标，非法值直接忽略。 */
    fun configDeleteRedirect(index: Int) {
        if (index < 0) {
            ui = ui.copy(config = ui.config.copy(error = "该规则没有有效的下标，请刷新后重试"))
            return
        }
        configWrite { base, token ->
            configClient.deleteRedirect(base, token, index)
            "已删除端口转发规则"
        }
    }

    /** 回滚某个分组到最近一次备份：section 取 lan / wan / dhcp / system。 */
    fun configRollback(section: String) {
        configWrite { base, token ->
            configClient.rollback(base, token, section)
            "已恢复该分组的最近备份"
        }
    }

    /** 清除配置页的错误 / 字段错误 / 提示（用户重新输入或关闭弹层时调用）。 */
    fun configClearFeedback() {
        if (ui.config.error == null &&
            ui.config.fieldErrors.isEmpty() &&
            ui.config.notice == null
        ) {
            return
        }
        ui = ui.copy(
            config = ui.config.copy(error = null, fieldErrors = emptyMap(), notice = null)
        )
    }

    /** 只清掉已展示的 Snackbar 提示，不动错误与字段错误（提示被消费后调用）。 */
    fun configClearNotice() {
        if (ui.config.notice == null) return
        ui = ui.copy(config = ui.config.copy(notice = null))
    }

    /* ───────────────────────── 检查更新（GitHub Releases，App 自身） ───────────────────────── */

    /**
     * 检查 **App 自身的**新版本：直接请求 GitHub Releases，不依赖路由器。
     *
     * 与旧实现的区别：
     * - 不再调用 `SystemClient.fetchUpdateCheck`（那是插件 / IPK 版本，且要路由器在线）；
     * - 不需要面板地址 / 访问令牌 / DataStore 就绪，启动自动检查与手动检查都可以直接查；
     * - 只把 GitHub 上带 APK 的正式 release 与本机 versionName 比较，**不比较插件版本**；
     * - 失败时展示可读错误（网络 / 限流 / 仓库 / 无 APK），绝不回退到路由器接口。
     * - 不自动下载或安装：只保留版本提示，APK 下载交给系统浏览器 / 下载器。
     *
     * 每次调用（自动 / 手动）都会刷新节流时间戳；手动检查不会被节流拦截。
     */
    fun checkUpdate() {
        if (ui.update.status == UpdateStatus.CHECKING) return
        val appVersion = appVersionName()
        prefs.edit().putLong(PREF_UPDATE_CHECK_AT, System.currentTimeMillis()).apply()
        ui = ui.copy(
            update = UpdateState(
                status = UpdateStatus.CHECKING,
                appVersion = appVersion,
                release = ui.update.release
            )
        )
        viewModelScope.launch {
            try {
                val release = withContext(Dispatchers.IO) {
                    githubReleaseClient.fetchLatestRelease()
                }
                val comparison = compareVersions(release.versionName, appVersion)
                val status = when {
                    comparison == null -> UpdateStatus.UNKNOWN
                    comparison > 0 -> UpdateStatus.UPDATE_AVAILABLE
                    else -> UpdateStatus.UP_TO_DATE
                }
                val message = if (status == UpdateStatus.UNKNOWN) {
                    "无法比较版本：本机 App 为 v${appVersion.ifBlank { "未知" }}，" +
                        "GitHub 最新为 v${release.displayVersion}"
                } else {
                    null
                }
                ui = ui.copy(update = UpdateState(status, appVersion, release, message))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ui = ui.copy(
                    update = UpdateState(
                        status = UpdateStatus.ERROR,
                        appVersion = appVersion,
                        release = ui.update.release,
                        message = updateErrorMessage(e)
                    )
                )
            }
        }
    }

    /**
     * 启动时的自动检查：0 次或距上次尝试超过 [AUTO_UPDATE_CHECK_MS] 才发起。
     *
     * 只说「尝试」：失败也会写时间戳，避免 6 小时内反复请求 GitHub 触发匿名限流；
     * 用户点「检查更新」不受此限制。
     */
    private fun maybeAutoCheckUpdate() {
        val now = System.currentTimeMillis()
        val last = prefs.getLong(PREF_UPDATE_CHECK_AT, 0L)
        if (last > 0L && now >= last && now - last < AUTO_UPDATE_CHECK_MS) return
        checkUpdate()
    }

    /** 本机 App 版本号（读取 Gradle 写入 APK 的 versionName；不依赖 BuildConfig）。 */
    private fun appVersionName(): String = try {
        val app = getApplication<Application>()
        @Suppress("DEPRECATION")
        app.packageManager.getPackageInfo(app.packageName, 0).versionName.orEmpty()
    } catch (e: Exception) {
        ""
    }

    /** 更新检查错误 → 可展示文案；网络类错误明确标注「网络」，不混入路由器提示。 */
    private fun updateErrorMessage(error: Throwable): String = when (error) {
        is GithubReleaseException -> when (error.code) {
            "network", "timeout" -> "检查更新失败（网络）：${error.message}"
            else -> error.message
        }

        else -> error.message ?: "检查更新失败，请稍后重试"
    }

    /** 系统接口错误 → 可展示文案（SystemException 已带中文）。 */
    private fun systemErrorMessage(error: Throwable): String = when (error) {
        is SystemException -> error.message
        else -> error.message ?: "系统信息获取失败"
    }

    /**
     * 与 `runCatching` 等价的协程安全版本：**取消信号必须透传**，
     * 否则页面关闭时会把 CancellationException 吞成「业务失败」并继续写已废状态。
     */
    private suspend fun <T> safely(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
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

    /**
     * 清空与「某台路由器」绑定的数据：AP 快照 / 系统信息 / 管理员会话。
     *
     * 切换或保存地址时调用，避免把旧路由器的管理令牌、系统信息带到新面板上。
     * 更新检查结果与路由器无关（GitHub 上的 App 发版），所以**不重置** [update]；
     * 只有「本机版本 + GitHub 结果」两个输入，换路由器不会改变结论。
     * 同时丢弃内存里的管理令牌（令牌只对签发它的那台路由器有效）。
     */
    private fun UiState.withoutRouterScopedData(): UiState {
        adminToken = null
        return copy(
            stations = StationsData(),
            stationsError = null,
            stationsAt = 0,
            stationsLoading = false,
            system = null,
            services = emptyList(),
            processes = emptyList(),
            systemError = null,
            systemAt = 0,
            systemLoading = false,
            adminUser = "",
            adminLoggedIn = false,
            adminExpiresAt = 0,
            adminLoginLoading = false,
            adminError = null,
            adminNotice = null,
            wifi = null,
            wifiLoading = false,
            adminBusy = false,
            config = ConfigUiState()
        )
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
        ).withoutRouterScopedData()
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
        ).withoutRouterScopedData()
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
