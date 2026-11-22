package io.prism.router.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import io.prism.router.data.ControlClient
import io.prism.router.data.ControlException
import io.prism.router.data.Device
import io.prism.router.data.UiState
import io.prism.router.data.fmtAgo
import io.prism.router.data.normalizeMac
import io.prism.router.ui.components.EmptyState
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * 单设备详情（正式路由 `device/{mac}`）。
 *
 * 为什么单独一页：设备列表的详情弹层只能从列表进入，无法分享 / 深链，也无法在
 * 概览的 Top 3 活跃设备行里一键落到「这一台」。这个页面把同一份详情内容
 * （[DeviceDetailContent]，仍由设备屏提供）复用到二级路由上：
 * - 路由只带规范化 MAC，不带 token / 面板地址；
 * - 家长控制写操作与设备屏共用 [DeviceControlController]，不复制第二套逻辑；
 * - 设备从列表消失时给明确空态 + 重试 / 返回，不白屏、不伪造数据。
 *
 * 本文件不新增任何数据请求：内容全部来自传入的 [UiState]；刷新一律回调 onRetry()。
 */

/**
 * 家长控制客户端：无状态、线程安全，整个进程共用一个实例（避免每页重建连接池）。
 *
 * 与设备列表页共用同一个实例，所以「在详情页暂停 → 返回列表」不会因为两个
 * OkHttp 连接池而出现时序差异。
 */
internal val deviceControlClient = ControlClient()

/**
 * 家长控制状态机（暂停列表 / 忙碌 MAC / 错误 / 确认弹窗）。
 *
 * 设备列表的详情弹层与独立详情页共用一个实现，避免两套 list / pause / resume
 * 逻辑漂移。约定：
 * - token 只在构造时从 [UiState] 只读拷贝，不写日志、不进任何提示文案；
 * - [scope] 由调用方的组合作用域提供，页面离开组合时随作用域取消，不泄漏协程；
 * - 同一时刻只允许一个写操作（[busyMac] 非空时新请求直接忽略）；
 * - 写失败时 [error] 给中文提示，write_disabled / forbidden 额外置 [blocked]，
 *   避免用户反复点同一个必然失败的按钮。
 */
@Stable
internal class DeviceControlController(
    private val baseUrl: String,
    private val token: String,
    private val scope: CoroutineScope
) {
    var pausedMacs by mutableStateOf<Set<String>>(emptySet())
        private set
    var busyMac by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var okMessage by mutableStateOf<String?>(null)
        private set
    var blocked by mutableStateOf(false)
        private set

    /** 待确认的设备 MAC：确认弹窗由页面层渲染，保证盖在底部弹层之上。 */
    var confirmMac by mutableStateOf<String?>(null)
        private set

    private var job: Job? = null

    fun isPaused(mac: String): Boolean = pausedMacs.contains(normalizeMac(mac))

    fun isBusy(mac: String): Boolean = busyMac != null && busyMac == normalizeMac(mac)

    fun clearMessages() {
        error = null
        okMessage = null
    }

    /**
     * 拉取「已暂停」集合。失败静默（没有列表就不显示徽章），不影响设备列表本身。
     * [clearBlocked] 用于「用户修好路由器配置后重开详情」这条恢复路径。
     */
    fun refreshPaused(clearBlocked: Boolean = false) {
        scope.launch {
            val loaded = try {
                withContext(Dispatchers.IO) { deviceControlClient.list(baseUrl, token) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            if (loaded == null) return@launch
            pausedMacs = loaded
            if (clearBlocked) blocked = false
        }
    }

    /** 点击「暂停 / 恢复」：先清掉旧提示，再弹确认框（真正写操作在 [confirm]）。 */
    fun requestToggle(device: Device) {
        if (busyMac != null) return
        if (device.mac.isBlank()) {
            error = "该设备没有 MAC 地址，无法暂停"
            okMessage = null
            return
        }
        clearMessages()
        confirmMac = device.mac
    }

    fun dismissConfirm() {
        confirmMac = null
    }

    fun confirm(device: Device, pause: Boolean) {
        confirmMac = null
        submit(device, pause)
    }

    /**
     * 确认后真正 POST；成功后本地集合先更新（徽章立刻生效），再用服务端 list 校正。
     */
    fun submit(device: Device, pause: Boolean) {
        if (busyMac != null) return
        if (device.mac.isBlank()) {
            error = "该设备没有 MAC 地址，无法暂停"
            return
        }
        val mac = normalizeMac(device.mac)
        busyMac = mac
        clearMessages()
        job?.cancel()
        job = scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (pause) {
                        deviceControlClient.pause(baseUrl, token, device.mac)
                    } else {
                        deviceControlClient.resume(baseUrl, token, device.mac)
                    }
                }
                pausedMacs = if (pause) pausedMacs + mac else pausedMacs - mac
                okMessage = if (pause) "已暂停该设备上网" else "已恢复该设备上网"
                val fresh = try {
                    withContext(Dispatchers.IO) { deviceControlClient.list(baseUrl, token) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
                /* 服务端列表是准绳；拿不到就保留本地结果（至少徽章是对的）。 */
                if (fresh != null) pausedMacs = fresh
                blocked = false
            } catch (e: CancellationException) {
                throw e
            } catch (e: ControlException) {
                error = e.message ?: "操作失败"
                if (e.code == "write_disabled" || e.code == "forbidden") blocked = true
            } catch (e: Exception) {
                error = e.message ?: "操作失败"
            } finally {
                busyMac = null
            }
        }
    }

    /** 页面离开组合时调用：取消在途写请求，避免已销毁页面上的状态回写。 */
    fun cancel() {
        job?.cancel()
        job = null
    }
}

/**
 * 创建 / 复用家长控制状态机。
 *
 * key 是 baseUrl + token：换路由器或令牌后必须重建（旧令牌的 paused 列表没有意义）。
 * 页面离开组合时通过 [DisposableEffect] 取消在途协程。
 */
@Composable
internal fun rememberDeviceControlController(ui: UiState): DeviceControlController {
    val scope = rememberCoroutineScope()
    val controller = remember(ui.baseUrl, ui.token, scope) {
        DeviceControlController(baseUrl = ui.baseUrl, token = ui.token, scope = scope)
    }
    DisposableEffect(controller) {
        onDispose { controller.cancel() }
    }
    return controller
}

/**
 * 暂停 / 恢复确认框（设备列表弹层与独立详情页共用）。
 *
 * [pausing] 为 true 时是「暂停」，按钮用 error 色；false 时是「恢复」，用 success 色。
 */
@Composable
internal fun DeviceControlConfirmDialog(
    device: Device,
    pausing: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    val semantic = LocalPrismSemanticColors.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (pausing) "暂停该设备上网？" else "恢复该设备上网？") },
        text = {
            Column {
                Text(
                    text = device.name.ifBlank { "未命名设备" },
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    text = "MAC ${device.mac}",
                    style = DeviceMonoCaption,
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
            TextButton(onClick = onConfirm) {
                Text(
                    text = if (pausing) "暂停" else "恢复",
                    color = if (pausing) MaterialTheme.colorScheme.error else semantic.success,
                    fontWeight = FontWeight.SemiBold
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

/**
 * 独立设备详情页。
 *
 * 状态分支（全部是真实数据，不补 0、不编历史）：
 * 1. 找得到设备 → 复用 [DeviceDetailContent]（实时速率 / 累计 / 本月 / 连接信息 /
 *    应用明细 / 家长控制）；
 * 2. 首屏还没数据且请求失败 → 错误态 + 重试；
 * 3. 首屏还没数据（刚启动 / 配置未就绪）→ 等待态 + 刷新；
 * 4. 有快照但这台设备不在列表 → 「已不在当前列表」空态，可返回或重试。
 *
 * [mac] 是路由路径参数（已百分号编码），这里再 `Uri.decode` 一次；对已解码的
 * 值是无操作，所以无论导航库是否解码过都能得到正确 MAC。匹配一律走
 * [normalizeMac]（大小写 / 分隔符差异不影响命中）。
 */
@Composable
fun DeviceDetailScreen(
    ui: UiState,
    mac: String,
    onRetry: () -> Unit,
    onBack: () -> Unit
) {
    val targetMac = remember(mac) { DeviceRouteCodec.decode(mac) }
    val devices = ui.state?.devices ?: emptyList()
    val device = if (targetMac.isBlank()) {
        null
    } else {
        devices.firstOrNull { normalizeMac(it.mac) == targetMac }
    }
    val loadError = ui.error
    val nowSec = System.currentTimeMillis() / 1000
    val online = device?.isOnline(nowSec) == true
    val control = rememberDeviceControlController(ui)

    /*
     * 同步「已暂停」集合：进入页面（或换了面板地址/令牌）时拉一次；首帧设备还没
     * 从快照里命中时不发请求，等 device.mac 出现再拉，成功即解除写按钮禁用。
     * 只有一个 effect，避免进入页面时并发两次 list。
     */
    LaunchedEffect(control, device?.mac) {
        if (device != null) control.refreshPaused(clearBlocked = true)
        else {
            /* 设备暂时消失时取消旧写任务与确认框，重新出现不恢复过期弹窗。 */
            control.cancel()
            control.dismissConfirm()
        }
    }

    fun refresh() {
        onRetry()
        control.refreshPaused(clearBlocked = true)
    }

    val title = device?.name?.takeIf { it.isNotBlank() } ?: "设备详情"

    PrismScaffold(
        title = title,
        subtitle = deviceSubtitle(device, ui.offline, online),
        largeTitle = false,
        navigationIcon = {
            PrismIconAction(
                icon = Icons.AutoMirrored.Rounded.ArrowBack,
                contentDescription = "返回设备列表",
                onClick = onBack
            )
        },
        actions = {
            PrismIconAction(
                icon = Icons.Rounded.Refresh,
                contentDescription = "刷新设备详情",
                onClick = { refresh() },
                enabled = !ui.loading
            )
        }
    ) { _ ->
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        ) {
            /* 离线快照提示：数据仍可看，但明确告知不是实时值。 */
            if (ui.offline) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = PrismSpacing.lg, vertical = PrismSpacing.sm)
                ) {
                    DeviceOfflineBanner(at = ui.offlineAt, onRetry = { refresh() })
                }
            }

            when {
                device != null -> DeviceDetailContent(
                    device = device,
                    online = online,
                    paused = control.isPaused(device.mac),
                    offline = ui.offline,
                    busy = control.isBusy(device.mac),
                    blocked = control.blocked,
                    error = control.error,
                    okMessage = control.okMessage,
                    onRequestToggle = { control.requestToggle(device) }
                )

                ui.state == null && loadError != null -> Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = PrismSpacing.xl)
                ) {
                    ErrorState(
                        msg = loadError,
                        title = "设备加载失败",
                        onRetry = { refresh() }
                    )
                }

                ui.state == null -> Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = PrismSpacing.xl)
                ) {
                    EmptyState(
                        icon = Icons.Rounded.Devices,
                        title = "正在等待设备数据",
                        desc = "还没有拿到路由器快照。刷新后会按 MAC 自动定位这台设备。",
                        action = {
                            OutlinedButton(
                                onClick = { refresh() },
                                modifier = Modifier.heightIn(min = PrismSize.touchTarget)
                            ) {
                                Text("刷新")
                            }
                        }
                    )
                }

                else -> MissingDeviceState(
                    mac = targetMac,
                    onBack = onBack,
                    onRetry = { refresh() }
                )
            }
        }
    }

    /* 确认弹窗放在页面顶层：与设备列表弹层共用同一实现。 */
    if (device != null && control.confirmMac != null) {
        val pausing = !control.isPaused(device.mac)
        DeviceControlConfirmDialog(
            device = device,
            pausing = pausing,
            onConfirm = { control.confirm(device, pausing) },
            onDismiss = { control.dismissConfirm() }
        )
    }
}

/** 详情页副标题：服务数据是否离线 + 设备在线状态 + 上次活跃时间。 */
private fun deviceSubtitle(device: Device?, offlineSnapshot: Boolean, online: Boolean): String {
    if (device == null) return "按 MAC 定位的终端详情"
    val status = when {
        offlineSnapshot -> "离线快照"
        online -> "在线"
        else -> "离线"
    }
    val seen = if (device.lastSeen > 0) {
        "上次活跃 ${fmtAgo(device.lastSeen)}"
    } else {
        "从未活跃"
    }
    return "$status · $seen"
}

/**
 * 设备消失空态：路由命中过，但当前快照里已经没有这台设备。
 *
 * 只展示像 MAC 的键（`-` 占位符等非法键不展示），并同时给「返回设备列表」
 * 与「刷新」两个出口，避免用户被困在一张空页面。
 */
@Composable
private fun MissingDeviceState(mac: String, onBack: () -> Unit, onRetry: () -> Unit) {
    val macText = if (isMacShaped(mac)) "MAC $mac。" else ""
    EmptyState(
        icon = Icons.Rounded.Devices,
        title = "这台设备已不在当前列表",
        desc = "${macText}它可能已经离线、被路由器移除，或换了网卡。" +
            "返回设备列表可查看全部终端，刷新后再试一次。",
        action = {
            Row(
                horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(
                    onClick = onBack,
                    modifier = Modifier.heightIn(min = PrismSize.touchTarget)
                ) {
                    Text("返回设备列表")
                }
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.heightIn(min = PrismSize.touchTarget)
                ) {
                    Text("刷新")
                }
            }
        }
    )
}

/** 是否是一个「像 MAC」的键（6 组冒号分隔）：只用于决定空态里要不要展示该串。 */
private fun isMacShaped(value: String): Boolean =
    value.length == 17 && value.count { it == ':' } == 5
