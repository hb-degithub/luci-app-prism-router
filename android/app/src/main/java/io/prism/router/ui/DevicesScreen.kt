package io.prism.router.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.SettingsEthernet
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.prism.router.data.ControlClient
import io.prism.router.data.ControlException
import io.prism.router.data.Device
import io.prism.router.data.DeviceApp
import io.prism.router.data.MainViewModel
import io.prism.router.data.UiState
import io.prism.router.data.fmtAgo
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock
import io.prism.router.data.fmtRate
import io.prism.router.data.normalizeMac
import io.prism.router.ui.components.EmptyState
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.components.Segmented
import io.prism.router.ui.components.SkeletonList
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * 设备屏（商用风格重做）：大标题 + 搜索 / 在线分段 / 排序 / 设备卡片 / 详情弹层 / 家长控制。
 * 只组合 ui/components 现有组件与主题令牌，不新增共享组件。
 */

/* ───────────────────────── 页面常量 ───────────────────────── */

private enum class DeviceFilter(val label: String) { ALL("全部"), ONLINE("在线"), OFFLINE("离线") }

private enum class DeviceSort(val label: String) { TOTAL("累计"), RATE("速率"), NAME("名称") }

/** 在线口径：有过活跃时间，且 10 分钟内上报过。与 PanelState.onlineCount 保持一致。 */
private const val ONLINE_WINDOW_SEC = 600L

/** 家长控制写客户端无状态、线程安全，整页共用一个实例（避免每次切页重建连接池）。 */
private val controlClient = ControlClient()

/** 详情弹层「应用明细」的展示条数上限：后端已截断+归并，这里再兜一层避免弹层过长。 */
private const val DEVICE_APP_ROWS = 8

/** 下拉刷新看门狗：请求异常卡住时最多转 8 秒，避免指示器永久停在顶部。 */
private const val REFRESH_WATCHDOG_MS = 8_000L

/**
 * IP / MAC / 速率等机器可读串的等宽样式。
 *
 * 列表里多项并排时，等宽数字能让上下行速率、地址在视觉上纵向对齐；
 * 中文仍回落到系统字体，不会出现方块。
 */
private val MonoCaption = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 10.sp,
    lineHeight = 14.sp,
    letterSpacing = 0.sp
)

private fun Device.isOnline(nowSec: Long): Boolean =
    lastSeen > 0 && nowSec - lastSeen <= ONLINE_WINDOW_SEC

/**
 * 设备页。
 *
 * 结构：PrismScaffold（大标题「设备」+「N 台 · 在线 M」，滚动收起）
 * → 固定搜索 / 分段筛选 / 排序 → 可下拉刷新的设备列表 → 详情 BottomSheet。
 *
 * 数据只读 [UiState]；唯一写操作是既有「家长控制」暂停/恢复（[ControlClient]）。
 * 刷新调用 ViewModel 现有方法，不新增任何接口。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(
    ui: UiState,
    /*
     * Activity 作用域的 MainViewModel：页面只调用现有 refresh()，不读 vm.ui。
     * NavHost 会显式传入；默认值兜底旧调用方，且避免 viewModel() 落到
     * NavBackStackEntry 上新建第二个实例（见 devicesViewModel 注释）。
     */
    vm: MainViewModel = devicesViewModel()
) {
    val devices = ui.state?.devices ?: emptyList()
    var query by rememberSaveable { mutableStateOf("") }
    var filterIndex by rememberSaveable { mutableIntStateOf(0) }
    var sortIndex by rememberSaveable { mutableIntStateOf(0) }
    var selectedMac by rememberSaveable { mutableStateOf<String?>(null) }

    /* 仅手动下拉 / 点刷新时展示指示器，避免 15s 自动轮询让顶部反复闪动。 */
    var pulling by remember { mutableStateOf(false) }

    /*
     * 家长控制状态。token 直接取 UiState.token（只读），不新增页面参数，
     * 这样 App.kt 不需要为「暂停/恢复」做任何改动。
     */
    val scope = rememberCoroutineScope()
    var pausedMacs by remember(ui.baseUrl, ui.token) { mutableStateOf<Set<String>>(emptySet()) }
    var busyMac by remember { mutableStateOf<String?>(null) }
    var controlError by remember { mutableStateOf<String?>(null) }
    var controlOk by remember { mutableStateOf<String?>(null) }
    /* write_disabled / forbidden 属于配置问题：提示后直接禁用写按钮，不再反复弹窗。 */
    var controlBlocked by remember(ui.baseUrl, ui.token) { mutableStateOf(false) }
    /* 待确认的设备 MAC：确认弹窗在页面层（ModalBottomSheet 之外）渲染，保证显示在弹层之上。 */
    var confirmMac by remember { mutableStateOf<String?>(null) }

    val filters = DeviceFilter.entries
    val sorts = DeviceSort.entries
    val filter = filters[filterIndex.coerceIn(0, filters.lastIndex)]
    val sort = sorts[sortIndex.coerceIn(0, sorts.lastIndex)]
    val nowSec = System.currentTimeMillis() / 1000

    val q = query.trim().lowercase()
    val searched = if (q.isEmpty()) devices else devices.filter {
        it.name.lowercase().contains(q) || it.mac.lowercase().contains(q) || it.ip.contains(q)
    }
    val filtered = when (filter) {
        DeviceFilter.ALL -> searched
        DeviceFilter.ONLINE -> searched.filter { it.isOnline(nowSec) }
        DeviceFilter.OFFLINE -> searched.filterNot { it.isOnline(nowSec) }
    }
    val sorted = when (sort) {
        DeviceSort.TOTAL -> filtered.sortedByDescending { it.total }
        DeviceSort.RATE -> filtered.sortedByDescending { it.rxRate + it.txRate }
        DeviceSort.NAME -> filtered.sortedBy { it.name.lowercase() }
    }
    val onlineCount = devices.count { it.isOnline(nowSec) }
    val selected = selectedMac?.let { mac -> devices.firstOrNull { it.mac == mac } }
    val loadError = ui.error

    fun refreshDevices() {
        pulling = true
        vm.refresh()
    }

    /** 下拉指示器跟随主数据 loading；另设看门狗兜底，网络卡住也不会永久转圈。 */
    LaunchedEffect(ui.loading, ui.updatedAt) {
        if (!ui.loading) pulling = false
    }
    LaunchedEffect(pulling) {
        if (pulling) {
            delay(REFRESH_WATCHDOG_MS)
            pulling = false
        }
    }

    /**
     * 拉取「已暂停」集合。失败静默（没有列表就不显示徽章），不影响设备列表本身。
     * [clearBlocked] 用于「用户修好路由器配置后重开详情」这条恢复路径。
     */
    fun refreshPaused(clearBlocked: Boolean = false) {
        scope.launch {
            val loaded = try {
                withContext(Dispatchers.IO) { controlClient.list(ui.baseUrl, ui.token) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            if (loaded == null) return@launch
            pausedMacs = loaded
            if (clearBlocked) controlBlocked = false
        }
    }

    /* 进入页面（或换了面板地址/令牌）时同步一次暂停状态。 */
    LaunchedEffect(ui.baseUrl, ui.token) { refreshPaused() }

    /* 打开详情弹层时再同步一次；成功即视为配置已恢复，解除按钮禁用。 */
    LaunchedEffect(selectedMac) {
        if (selectedMac != null) refreshPaused(clearBlocked = true)
    }

    /** 确认后真正 POST；成功后本地集合先更新（徽章立刻生效），再用服务端 list 校正。 */
    fun submitControl(device: Device, pause: Boolean) {
        if (busyMac != null) return
        if (device.mac.isBlank()) {
            controlError = "该设备没有 MAC 地址，无法暂停"
            return
        }
        val mac = normalizeMac(device.mac)
        busyMac = device.mac
        controlError = null
        controlOk = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (pause) {
                        controlClient.pause(ui.baseUrl, ui.token, device.mac)
                    } else {
                        controlClient.resume(ui.baseUrl, ui.token, device.mac)
                    }
                }
                pausedMacs = if (pause) pausedMacs + mac else pausedMacs - mac
                controlOk = if (pause) "已暂停该设备上网" else "已恢复该设备上网"
                val fresh = try {
                    withContext(Dispatchers.IO) { controlClient.list(ui.baseUrl, ui.token) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
                /* 服务端列表是准绳；拿不到就保留本地结果（至少徽章是对的）。 */
                if (fresh != null) pausedMacs = fresh
            } catch (e: CancellationException) {
                throw e
            } catch (e: ControlException) {
                controlError = e.message ?: "操作失败"
                if (e.code == "write_disabled" || e.code == "forbidden") controlBlocked = true
            } catch (e: Exception) {
                controlError = e.message ?: "操作失败"
            } finally {
                busyMac = null
            }
        }
    }

    PrismScaffold(
        title = "设备",
        subtitle = "${devices.size} 台 · 在线 $onlineCount",
        actions = {
            PrismIconAction(
                icon = Icons.Rounded.Refresh,
                contentDescription = "刷新设备",
                onClick = { refreshDevices() }
            )
        }
    ) { _ ->
        Column(Modifier.fillMaxSize()) {
            /* ── 固定筛选区：搜索 / 在线分段 / 排序（列表滚动时保持可达） ── */
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = PrismSpacing.lg)
            ) {
                Spacer(Modifier.height(PrismSpacing.sm))
                DeviceSearchField(query = query, onQueryChange = { query = it })
                Spacer(Modifier.height(PrismSpacing.md))
                Segmented(
                    options = filters,
                    selected = filter,
                    onSelect = { filterIndex = it.ordinal },
                    label = { item ->
                        when (item) {
                            DeviceFilter.ALL -> "全部 ${devices.size}"
                            DeviceFilter.ONLINE -> "在线 $onlineCount"
                            DeviceFilter.OFFLINE -> "离线 ${(devices.size - onlineCount).coerceAtLeast(0)}"
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(PrismSpacing.xs))
                DeviceSortRow(selected = sort, onSelect = { sortIndex = it.ordinal })
            }

            PullToRefreshBox(
                isRefreshing = pulling,
                onRefresh = { refreshDevices() },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = PrismSpacing.lg,
                        end = PrismSpacing.lg,
                        top = PrismSpacing.sm,
                        bottom = PrismSpacing.xl
                    ),
                    verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
                ) {
                    if (ui.offline) {
                        item { OfflineBanner(at = ui.offlineAt, onRetry = { refreshDevices() }) }
                    }

                    when {
                        /* 首屏：还没有任何快照、也没有错误 → 骨架屏。 */
                        ui.state == null && loadError == null -> item {
                            SkeletonList(rows = 5, showHeader = false)
                        }

                        /* 首屏失败（没有可展示的缓存）→ 错误态 + 重试。 */
                        ui.state == null && loadError != null -> item {
                            Box(
                                Modifier
                                    .fillParentMaxSize()
                                    .padding(bottom = PrismSpacing.xl),
                                contentAlignment = Alignment.Center
                            ) {
                                ErrorState(
                                    msg = loadError,
                                    title = "设备加载失败",
                                    onRetry = { refreshDevices() }
                                )
                            }
                        }

                        sorted.isEmpty() -> item {
                            Box(
                                Modifier
                                    .fillParentMaxSize()
                                    .padding(bottom = PrismSpacing.xl),
                                contentAlignment = Alignment.Center
                            ) {
                                EmptyDevices(
                                    query = query,
                                    filter = filter,
                                    hasDevices = devices.isNotEmpty(),
                                    onClearSearch = { query = "" },
                                    onShowAll = { filterIndex = 0 },
                                    onRefresh = { refreshDevices() }
                                )
                            }
                        }

                        else -> items(sorted) { device ->
                            DeviceCard(
                                device = device,
                                online = device.isOnline(nowSec),
                                paused = normalizeMac(device.mac) in pausedMacs,
                                onClick = {
                                    selectedMac = device.mac
                                    controlError = null
                                    controlOk = null
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    if (selected != null) {
        DeviceDetailSheet(
            device = selected,
            online = selected.isOnline(nowSec),
            paused = normalizeMac(selected.mac) in pausedMacs,
            offline = ui.offline,
            busy = busyMac == selected.mac,
            blocked = controlBlocked,
            error = controlError,
            okMessage = controlOk,
            onDismiss = {
                selectedMac = null
                controlError = null
                controlOk = null
            },
            onRequestToggle = { confirmMac = selected.mac }
        )
    }

    /* 确认弹窗放在 ModalBottomSheet 外面：新窗口后创建，稳定显示在弹层之上。 */
    val confirming = confirmMac?.let { mac -> devices.firstOrNull { it.mac == mac } }
    if (confirming != null) {
        val pausing = normalizeMac(confirming.mac) !in pausedMacs
        AlertDialog(
            onDismissRequest = { confirmMac = null },
            title = { Text(if (pausing) "暂停该设备上网？" else "恢复该设备上网？") },
            text = {
                Column {
                    Text(
                        confirming.name.ifBlank { "未命名设备" },
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        "MAC ${confirming.mac}",
                        style = MonoCaption.copy(fontSize = 12.sp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(PrismSpacing.md))
                    Text(
                        text = if (pausing) {
                            "暂停后该设备将无法上网，恢复立即生效。"
                        } else {
                            "恢复后该设备可立即正常上网。"
                        },
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val target = confirming
                        confirmMac = null
                        submitControl(target, pausing)
                    }
                ) {
                    Text(
                        text = if (pausing) "暂停" else "恢复",
                        color = if (pausing) {
                            MaterialTheme.colorScheme.error
                        } else {
                            LocalPrismSemanticColors.current.success
                        },
                        fontWeight = FontWeight.SemiBold
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmMac = null }) { Text("取消") }
            }
        )
    }
}

/* ───────────────────────── 固定筛选区 ───────────────────────── */

@Composable
private fun DeviceSearchField(query: String, onQueryChange: (String) -> Unit) {
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        shape = RoundedCornerShape(PrismRadius.medium),
        textStyle = MaterialTheme.typography.bodyMedium,
        placeholder = {
            Text(
                text = "搜索名称 / MAC / IP",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        },
        leadingIcon = {
            Icon(
                imageVector = Icons.Rounded.Search,
                contentDescription = null,
                modifier = Modifier.size(PrismSize.icon)
            )
        },
        /* 清除按钮保留 48dp 触控目标；输入为空时不占位。 */
        trailingIcon = {
            if (query.isNotEmpty()) {
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "清除搜索",
                        modifier = Modifier.size(PrismSize.icon)
                    )
                }
            }
        }
    )
}

@Composable
private fun DeviceSortRow(selected: DeviceSort, onSelect: (DeviceSort) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
    ) {
        Text(
            text = "排序",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        DeviceSort.entries.forEach { item ->
            FilterChip(
                selected = selected == item,
                onClick = { onSelect(item) },
                label = {
                    Text(item.label, style = MaterialTheme.typography.labelSmall)
                },
                shape = RoundedCornerShape(PrismRadius.pill),
                colors = FilterChipDefaults.filterChipColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    selectedContainerColor = MaterialTheme.colorScheme.primary,
                    selectedLabelColor = MaterialTheme.colorScheme.onPrimary
                )
            )
        }
    }
}

/* ───────────────────────── 设备卡片 ───────────────────────── */

/** 商用风格的设备行：头像 / 名称 / 链路 / 地址 / 速率 / 累计。 */
@Composable
private fun DeviceCard(
    device: Device,
    online: Boolean,
    paused: Boolean,
    onClick: () -> Unit
) {
    val accent = linkAccent(device.link)
    val surface = MaterialTheme.colorScheme.surface
    val shape = MaterialTheme.shapes.medium
    val semantic = LocalPrismSemanticColors.current

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .clickable(role = Role.Button, onClick = onClick),
        shape = shape,
        color = surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        tonalElevation = 0.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = PrismSpacing.md, vertical = PrismSpacing.md),
            verticalAlignment = Alignment.CenterVertically
        ) {
            DeviceAvatar(link = device.link, online = online, paused = paused)
            Spacer(Modifier.width(PrismSpacing.md))

            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = device.name.ifBlank { "未命名设备" },
                        style = MaterialTheme.typography.titleMedium,
                        fontSize = 15.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                    if (paused) {
                        Spacer(Modifier.width(PrismSpacing.xs))
                        Pill(
                            text = "已暂停",
                            color = MaterialTheme.colorScheme.error,
                            leadingDot = false
                        )
                    }
                }
                Spacer(Modifier.height(PrismSpacing.xs))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Pill(
                        text = linkLabel(device.link),
                        color = accent,
                        leadingDot = false
                    )
                    Spacer(Modifier.width(PrismSpacing.sm))
                    Text(
                        text = "上次活跃 ${fmtAgo(device.lastSeen)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Spacer(Modifier.height(PrismSpacing.xs))
                Text(
                    text = listOf(device.ip, device.mac)
                        .filter { it.isNotBlank() }
                        .joinToString(" · ")
                        .ifBlank { "无地址信息" },
                    style = MonoCaption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            Spacer(Modifier.width(PrismSpacing.sm))

            /* 右侧：下行 / 上行速率 + 累计流量（粗体）。 */
            Column(horizontalAlignment = Alignment.End) {
                SpeedLine(
                    arrow = "↓",
                    value = fmtRate(device.rxRate),
                    arrowColor = MaterialTheme.colorScheme.primary
                )
                SpeedLine(
                    arrow = "↑",
                    value = fmtRate(device.txRate),
                    arrowColor = semantic.warning
                )
                Spacer(Modifier.height(PrismSpacing.xs))
                Text(
                    text = fmtBytes(device.total),
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp
                    ),
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1
                )
                Text(
                    text = "累计",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    maxLines = 1
                )
            }
        }
    }
}

@Composable
private fun SpeedLine(arrow: String, value: String, arrowColor: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text = arrow, style = MonoCaption, color = arrowColor)
        Spacer(Modifier.width(PrismSpacing.xs))
        Text(
            text = value,
            style = MonoCaption,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
    }
}

/**
 * 圆形头像：按接入方式取色 + 图标；右上红点表示已暂停，右下状态点表示在线。
 * 图标是装饰性的（链路文案在 Pill 里），因此 contentDescription 为 null。
 */
@Composable
private fun DeviceAvatar(link: String, online: Boolean, paused: Boolean) {
    val accent = linkAccent(link)
    val ring = MaterialTheme.colorScheme.surface
    val semantic = LocalPrismSemanticColors.current

    Box(Modifier.size(44.dp)) {
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(accent.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = linkIcon(link),
                contentDescription = null,
                tint = accent,
                modifier = Modifier.size(PrismSize.iconLarge)
            )
        }
        if (paused) {
            StatusDot(
                modifier = Modifier.align(Alignment.TopEnd),
                color = MaterialTheme.colorScheme.error,
                ring = ring
            )
        }
        StatusDot(
            modifier = Modifier.align(Alignment.BottomEnd),
            color = if (online) semantic.success else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f),
            ring = ring
        )
    }
}

/** 头像角标：10dp 圆点 + 卡片底色描边，避免和头像颜色糊在一起。 */
@Composable
private fun StatusDot(modifier: Modifier, color: Color, ring: Color) {
    Box(
        modifier
            .size(10.dp)
            .background(color, CircleShape)
            .border(2.dp, ring, CircleShape)
    )
}

/* ───────────────────────── 空态 / 离线条 ───────────────────────── */

@Composable
private fun EmptyDevices(
    query: String,
    filter: DeviceFilter,
    hasDevices: Boolean,
    onClearSearch: () -> Unit,
    onShowAll: () -> Unit,
    onRefresh: () -> Unit
) {
    val q = query.trim()
    when {
        q.isNotEmpty() -> EmptyState(
            icon = Icons.Rounded.Search,
            title = "没有匹配的设备",
            desc = "没有找到与「$q」相关的名称、MAC 或 IP，换个关键词试试。",
            action = {
                TextButton(onClick = onClearSearch) { Text("清空搜索") }
            }
        )

        !hasDevices -> EmptyState(
            icon = Icons.Rounded.Devices,
            title = "暂无设备",
            desc = "路由器还没有上报终端，连接 Wi-Fi 后会自动出现在这里。",
            action = {
                OutlinedButton(
                    onClick = onRefresh,
                    modifier = Modifier.heightIn(min = PrismSize.touchTarget)
                ) {
                    Text("刷新")
                }
            }
        )

        else -> EmptyState(
            icon = Icons.Rounded.Devices,
            title = "当前没有${filter.label}设备",
            desc = "切换上方分段，查看全部终端。",
            action = {
                TextButton(onClick = onShowAll) { Text("查看全部") }
            }
        )
    }
}

/** 离线快照提示：仍可下拉刷新；颜色取 warning，深浅色下都可读。 */
@Composable
private fun OfflineBanner(at: Long, onRetry: () -> Unit) {
    val warning = LocalPrismSemanticColors.current.warning
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        color = warning.copy(alpha = 0.12f),
        contentColor = warning
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PrismSize.touchTarget)
                .padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "离线数据 · 更新于 ${fmtHm(at)}",
                style = MaterialTheme.typography.labelSmall,
                color = warning,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = onRetry) {
                Text("重试", style = MaterialTheme.typography.labelSmall, color = warning)
            }
        }
    }
}

/* ───────────────────────── 详情弹层 ───────────────────────── */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeviceDetailSheet(
    device: Device,
    online: Boolean,
    paused: Boolean,
    offline: Boolean,
    busy: Boolean,
    blocked: Boolean,
    error: String?,
    okMessage: String?,
    onDismiss: () -> Unit,
    onRequestToggle: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboard = LocalClipboardManager.current
    var copied by remember(device.mac) { mutableStateOf(false) }
    val accent = linkAccent(device.link)
    val semantic = LocalPrismSemanticColors.current

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = PrismSpacing.lg)
                .verticalScroll(rememberScrollState())
        ) {
            /* ── 头部：头像 + 名称 + 状态 Pills ── */
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(52.dp)
                        .background(accent.copy(alpha = 0.14f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = linkIcon(device.link),
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(PrismSize.iconLarge + 2.dp)
                    )
                }
                Spacer(Modifier.width(PrismSpacing.md))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = device.name.ifBlank { "未命名设备" },
                        style = MaterialTheme.typography.titleLarge,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(Modifier.height(PrismSpacing.xs))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(PrismSpacing.xs)
                    ) {
                        Pill(text = linkLabel(device.link), color = accent, leadingDot = false)
                        Pill(
                            text = if (online) "在线" else "离线",
                            color = if (online) semantic.success else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        if (paused) {
                            Pill(
                                text = "已暂停",
                                color = MaterialTheme.colorScheme.error,
                                leadingDot = false
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(PrismSpacing.lg))

            /* ── 实时速率 ── */
            SectionCard(title = "实时速率", subtitle = "最近一次面板采样") {
                Row(Modifier.fillMaxWidth()) {
                    RateColumn(
                        label = "下载",
                        value = fmtRate(device.rxRate),
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.weight(1f)
                    )
                    RateColumn(
                        label = "上传",
                        value = fmtRate(device.txRate),
                        color = semantic.warning,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            Spacer(Modifier.height(PrismSpacing.md))

            /* ── 累计 / 直连 / 代理 / 本月 ── */
            FlowBreakdownCard(device)

            Spacer(Modifier.height(PrismSpacing.md))

            /* ── 连接信息 ── */
            SectionCard(title = "连接信息") {
                InfoRow("IP", device.ip.ifBlank { "—" }, mono = true)
                InfoRow("MAC", device.mac.ifBlank { "—" }, mono = true)
                InfoRow("接入", linkLabel(device.link))
                InfoRow(
                    label = "上次活跃",
                    value = if (device.lastSeen > 0) {
                        "${fmtAgo(device.lastSeen)} · ${fmtClock(device.lastSeen)}"
                    } else {
                        "从未"
                    }
                )
            }

            Spacer(Modifier.height(PrismSpacing.md))

            DeviceAppsCard(device = device, offline = offline)

            Spacer(Modifier.height(PrismSpacing.md))

            ParentControlCard(
                device = device,
                paused = paused,
                busy = busy,
                blocked = blocked,
                error = error,
                okMessage = okMessage,
                onRequestToggle = onRequestToggle
            )

            Spacer(Modifier.height(PrismSpacing.md))

            OutlinedButton(
                onClick = {
                    clipboard.setText(AnnotatedString(device.mac))
                    copied = true
                },
                enabled = device.mac.isNotBlank(),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Icon(
                    imageVector = Icons.Rounded.ContentCopy,
                    contentDescription = null,
                    modifier = Modifier.size(PrismSize.iconSmall)
                )
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(if (copied) "已复制 MAC" else "复制 MAC")
            }

            Spacer(Modifier.height(PrismSpacing.xl))
        }
    }
}

@Composable
private fun RateColumn(
    label: String,
    value: String,
    color: Color,
    modifier: Modifier = Modifier
) {
    Column(modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * 累计流量 + 直连 / 代理分项 + 本月。
 *
 * 比例条只在总量 > 0 时绘制，避免除零；两个分项都为 0 时只留灰色轨道。
 */
@Composable
private fun FlowBreakdownCard(device: Device) {
    val directTotal = device.directRx + device.directTx
    val proxyTotal = device.proxyRx + device.proxyTx
    val total = device.total
    val directShare = if (total > 0) directTotal.toFloat() / total else 0f
    val proxyShare = if (total > 0) proxyTotal.toFloat() / total else 0f

    SectionCard(title = "累计流量", subtitle = "直连与代理出口分项") {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                text = fmtBytes(total),
                style = MaterialTheme.typography.headlineSmall,
                fontFamily = FontFamily.Monospace,
                maxLines = 1
            )
            Spacer(Modifier.width(PrismSpacing.xs))
            Text(
                text = "累计",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = PrismSpacing.xs)
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = "本月 ${fmtBytes(device.monthTotal)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1
            )
        }

        if (total > 0) {
            Spacer(Modifier.height(PrismSpacing.sm))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
            ) {
                if (directShare > 0f) {
                    Box(
                        Modifier
                            .weight(directShare)
                            .fillMaxHeight()
                            .background(MaterialTheme.colorScheme.primary)
                    )
                }
                if (proxyShare > 0f) {
                    Box(
                        Modifier
                            .weight(proxyShare)
                            .fillMaxHeight()
                            .background(MaterialTheme.colorScheme.tertiary)
                    )
                }
            }
            Spacer(Modifier.height(PrismSpacing.xs))
            Text(
                text = "直连 ${(directShare * 100).toInt()}% · 代理 ${(proxyShare * 100).toInt()}%",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        Spacer(Modifier.height(PrismSpacing.sm))
        BreakdownRow(label = "直连", rx = device.directRx, tx = device.directTx)
        Spacer(Modifier.height(PrismSpacing.xs))
        BreakdownRow(label = "代理", rx = device.proxyRx, tx = device.proxyTx)
    }
}

@Composable
private fun BreakdownRow(label: String, rx: Long, tx: Long) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(40.dp)
        )
        Text(
            text = "↓ ${fmtBytes(rx)}   ↑ ${fmtBytes(tx)}",
            style = MonoCaption.copy(fontSize = 11.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
    }
}

/** 详情里的单行信息：标签固定宽度，值可换行但最多两行。 */
@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(64.dp)
        )
        Text(
            text = value,
            style = if (mono) MonoCaption.copy(fontSize = 12.sp) else MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * 详情弹层的「应用明细」：数据只来自 `state.devices[].apps`，不新增任何请求。
 *
 * - 顶部先给「应用明细覆盖 X / 总 Y」，让用户直接看出明细相对设备总量的缺口；
 * - 列表按 `rx + tx` 降序、最多 [DEVICE_APP_ROWS] 条；
 * - `__other__` 是 daemon 的长尾归并桶，显示「其他」并整行置灰；
 * - 没有明细时按真实情况显示「暂无应用明细」，不伪造数据。
 */
@Composable
private fun DeviceAppsCard(device: Device, offline: Boolean) {
    val apps = remember(device.apps) {
        device.apps.values.sortedWith(
            compareByDescending<DeviceApp> { it.total }.thenBy { it.displayName }
        )
    }
    val shown = apps.take(DEVICE_APP_ROWS)
    val actionSlot: (@Composable () -> Unit)? = if (apps.isNotEmpty()) {
        {
            Text(
                text = "${apps.size} 个域名",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    } else {
        null
    }

    SectionCard(
        title = "应用明细",
        subtitle = when {
            apps.isEmpty() && offline -> "离线缓存不含每设备明细，连回路由器后自动出现"
            apps.isEmpty() -> "面板暂未下发该设备的域名用量"
            else -> appsCoverageText(device)
        },
        action = actionSlot
    ) {
        if (apps.isEmpty()) {
            Text(
                text = "暂无应用明细",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else {
            if (device.appsTotal in 1 until device.total) {
                Text(
                    text = "缺口为未列入明细的流量（后端会按体积裁剪）。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(PrismSpacing.xs))
            }
            shown.forEach { app -> DeviceAppRow(app) }
            if (shown.size < apps.size) {
                Spacer(Modifier.height(PrismSpacing.xs))
                Text(
                    text = "仅显示流量前 $DEVICE_APP_ROWS 条",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** 「应用明细覆盖 X / 总 Y」；设备总量未知或明细反而更大时只报数字，不编造百分比。 */
private fun appsCoverageText(device: Device): String {
    val covered = device.appsTotal
    val total = device.total
    if (total <= 0) return "应用明细合计 ${fmtBytes(covered)} · 设备总量未知"
    val pct = if (covered in 1..total) " · ${covered * 100L / total}%" else ""
    return "覆盖 ${fmtBytes(covered)} / 总 ${fmtBytes(total)}$pct"
}

/** 单条应用：域名（`__other__` → 「其他」并置灰）+ 链路 Pill + ↓rx ↑tx。 */
@Composable
private fun DeviceAppRow(app: DeviceApp) {
    val dim = app.isOther
    val numberColor = if (dim) {
        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = app.displayName,
            style = MaterialTheme.typography.labelSmall.copy(
                fontFamily = if (dim) FontFamily.Default else FontFamily.Monospace
            ),
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            fontWeight = if (dim) FontWeight.Normal else FontWeight.Medium,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(PrismSpacing.xs))
        ChainPill(app.chain, dim = dim)
        Spacer(Modifier.width(PrismSpacing.sm))
        Text(
            text = "↓ ${fmtBytes(app.rx)}",
            style = MonoCaption,
            color = numberColor,
            maxLines = 1
        )
        Spacer(Modifier.width(PrismSpacing.xs))
        Text(
            text = "↑ ${fmtBytes(app.tx)}",
            style = MonoCaption,
            color = numberColor,
            maxLines = 1
        )
    }
}

/* ───────────────────────── 家长控制 ───────────────────────── */

@Composable
private fun ParentControlCard(
    device: Device,
    paused: Boolean,
    busy: Boolean,
    blocked: Boolean,
    error: String?,
    okMessage: String?,
    onRequestToggle: () -> Unit
) {
    val semantic = LocalPrismSemanticColors.current
    val actionColor = if (paused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
    val actionContent = if (paused) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onError
    val badgeSlot: (@Composable () -> Unit)? = if (paused) {
        {
            Pill(
                text = "已暂停",
                color = MaterialTheme.colorScheme.error,
                leadingDot = false
            )
        }
    } else {
        null
    }

    SectionCard(
        title = "家长控制",
        subtitle = if (paused) "该设备当前已暂停，无法上网" else "暂停后该设备将无法上网，恢复立即生效",
        action = badgeSlot
    ) {
        if (error != null) {
            Text(
                text = error,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error
            )
            Spacer(Modifier.height(PrismSpacing.xs))
        }
        if (blocked) {
            Text(
                text = "写操作被路由器拒绝：请确认 panel.write_enabled=1，且设置页里的访问令牌与 panel.token 一致。修好后重开本弹层即可重试。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(PrismSpacing.xs))
        }
        if (okMessage != null && error == null) {
            Text(
                text = okMessage,
                style = MaterialTheme.typography.labelSmall,
                color = semantic.success
            )
            Spacer(Modifier.height(PrismSpacing.xs))
        }

        Button(
            onClick = onRequestToggle,
            enabled = !busy && !blocked && device.mac.isNotBlank(),
            colors = ButtonDefaults.buttonColors(
                containerColor = actionColor,
                contentColor = actionContent,
                disabledContainerColor = actionColor.copy(alpha = 0.35f),
                disabledContentColor = actionContent.copy(alpha = 0.7f)
            ),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PrismSize.touchTarget)
        ) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = actionContent
                )
                Spacer(Modifier.width(PrismSpacing.sm))
            } else {
                Icon(
                    imageVector = if (paused) Icons.Rounded.PlayArrow else Icons.Rounded.Block,
                    contentDescription = null,
                    modifier = Modifier.size(PrismSize.iconSmall)
                )
                Spacer(Modifier.width(PrismSpacing.xs))
            }
            Text(
                text = when {
                    busy -> "处理中…"
                    paused -> "恢复上网"
                    else -> "暂停上网"
                },
                style = MaterialTheme.typography.titleMedium
            )
        }
    }
}

/* ───────────────────────── 链路徽章 / 图标 ───────────────────────── */

/**
 * 出口链路 Pill：`DIRECT` 用 success 绿（显示「直连」），其余非空链路用 primary 蓝。
 * 缺失 / 归并行（`__other__`）置灰——这两种都不是代理，不冒充蓝色。
 */
@Composable
private fun ChainPill(chain: String, dim: Boolean = false) {
    val semantic = LocalPrismSemanticColors.current
    val color = when {
        dim || chain.isBlank() -> MaterialTheme.colorScheme.onSurfaceVariant
        chain.trim().equals("DIRECT", ignoreCase = true) -> semantic.success
        else -> MaterialTheme.colorScheme.primary
    }
    Pill(
        text = chainLabel(chain),
        color = color,
        leadingDot = false,
        modifier = Modifier.widthIn(max = 92.dp)
    )
}

/** chip 文案：直连 / 混合 / 后端原样节点名；缺失时用破折号（与 Web 面板保持一致）。 */
private fun chainLabel(chain: String): String {
    val c = chain.trim()
    return when {
        c.isEmpty() -> "—"
        c.equals("DIRECT", ignoreCase = true) -> "直连"
        c.equals("MIXED", ignoreCase = true) -> "混合"
        else -> c
    }
}

/** 接入方式取色：无线 tertiary 紫、有线 secondary 青、未知中性色；深浅色随主题自动切换。 */
@Composable
private fun linkAccent(link: String): Color = when (link) {
    "wifi" -> MaterialTheme.colorScheme.tertiary
    "wired" -> MaterialTheme.colorScheme.secondary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun linkIcon(link: String): ImageVector = when (link) {
    "wifi" -> Icons.Rounded.Wifi
    "wired" -> Icons.Rounded.SettingsEthernet
    else -> Icons.Rounded.Devices
}

private fun linkLabel(link: String): String = when (link) {
    "wifi" -> "无线"
    "wired" -> "有线"
    else -> "未知"
}

/** 离线条 / 提示用的时:分格式（与「更新于 HH:mm」的中文习惯一致）。 */
private fun fmtHm(ts: Long): String {
    if (ts <= 0) return "—"
    return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
}

/**
 * 取 Activity 作用域的 MainViewModel（与 MainActivity 的 `by viewModels()` 是同一个实例）。
 *
 * Navigation-Compose 会把每个目的地的 LocalViewModelStoreOwner 换成 NavBackStackEntry，
 * 此时直接 `viewModel()` 会创建另一个 MainViewModel：refresh() 只写进那个没人渲染的
 * 实例，下拉刷新看起来「没反应」。这里显式用宿主 Activity 作为 owner，保证刷新/
 * 家长控制列表都作用在真正驱动界面的实例上；非 Activity 宿主（预览/测试）回退默认 owner。
 */
@Composable
private fun devicesViewModel(): MainViewModel {
    val activity = LocalContext.current as? ComponentActivity
    return if (activity != null) {
        viewModel(viewModelStoreOwner = activity)
    } else {
        viewModel()
    }
}
