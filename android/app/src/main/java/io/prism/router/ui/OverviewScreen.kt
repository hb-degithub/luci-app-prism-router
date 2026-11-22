package io.prism.router.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Router
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.AlertSeverity
import io.prism.router.data.AlertTarget
import io.prism.router.data.DailyUsage
import io.prism.router.data.Device
import io.prism.router.data.NodeUsage
import io.prism.router.data.PanelState
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock
import io.prism.router.data.fmtRate
import io.prism.router.data.normalizeMac
import io.prism.router.ui.components.EmptyState
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismProgressBar
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.RefreshableContent
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.components.SkeletonBox
import io.prism.router.ui.components.StatusRow
import io.prism.router.ui.theme.LocalPrismCategoryColors
import io.prism.router.ui.theme.LocalPrismDataColors
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import io.prism.router.ui.theme.PrismStroke
import java.time.LocalDate
import java.util.Locale
import kotlin.math.roundToInt

/*
 * 概览屏（网络驾驶舱版）。
 *
 * 信息顺序：紧凑状态行 → 速率主卡（含最近采样趋势）→ 今日 / 在线摘要 →
 * Top 3 活跃设备 → 近 7 天趋势 → 告警 → 出口 → 健康。
 *
 * 设计约定：
 * - 顶部不再有独立的「运行状态」大卡：服务 / 记账 / 新鲜度压成一行，
 *   只有离线、同步失败、服务停止、记账降级、数据陈旧时才在下面补一条明显提示；
 * - 下载固定品牌蓝、上传固定科技青（LocalPrismDataColors），绿 / 橙 / 红只留给状态；
 * - 数值统一 tabular figures，卡片不再使用 1dp 苍白描边，层级靠表面色与留白。
 *
 * 数据只读：本文件只消费 UiState / PanelState，不发起任何请求；刷新一律回调
 * [onRefresh]（由 MainViewModel.refresh() 负责）。
 */

/** 告警中心最多展示条数（需求约定 6 条）。 */
private const val MAX_ALERT_ROWS = 6

/** 出口摘要最多展示个数（需求约定 3 个）。 */
private const val MAX_EXIT_ROWS = 3

/** 健康卡最多展示的 reasons 条数。 */
private const val MAX_HEALTH_REASONS = 3

/** 首屏活跃设备入口条数。 */
private const val ACTIVE_DEVICE_ROWS = 3

/** 状态行下的异常提示数据。 */
private data class StatusAttentionData(
    val message: String,
    val color: Color,
    val icon: ImageVector,
    val action: String
)

/**
 * 概览页（兼容旧调用：只传刷新回调）。
 *
 * 新的接线可再传 [onOpenDevices] / [onOpenDevice] / [onOpenNetwork]，让设备类告警与
 * 「查看全部」跳「设备」页签、活跃设备行进单设备详情、「查看全部」跳「网络」页签；
 * 未接入时对应跳转入口自动隐藏。
 */
@Composable
fun OverviewScreen(ui: UiState, onRefresh: () -> Unit) {
    OverviewScreen(
        ui = ui,
        onRefresh = onRefresh,
        onOpenDevices = null,
        onOpenDevice = null,
        onOpenNetwork = null
    )
}

/**
 * 概览页。
 *
 * [onOpenDevices]：设备类告警 / 活跃设备「查看全部」的页签级跳转；为 null 时不可点。
 * [onOpenDevice]：Top 3 活跃设备行的单设备详情跳转；为 null 时行点击回落到
 * [onOpenDevices]（旧行为），两者都为空则整行只读。
 * [onOpenNetwork]：出口摘要「查看全部」的跳转回调；为 null 时不显示该按钮。
 */
@Composable
fun OverviewScreen(
    ui: UiState,
    onRefresh: () -> Unit,
    onOpenDevices: (() -> Unit)? = null,
    onOpenDevice: ((Device) -> Unit)? = null,
    onOpenNetwork: (() -> Unit)? = null
) {
    /* 只在下拉 / 手动重试期间展示顶部指示器，避免 15s 自动轮询让指示器反复闪动。 */
    var pulling by remember { mutableStateOf(false) }
    LaunchedEffect(ui.loading) {
        if (!ui.loading) pulling = false
    }

    PrismScaffold(
        title = "概览",
        subtitle = overviewSubtitle(ui),
        actions = {
            OverviewRefreshAction(loading = ui.loading, onClick = onRefresh)
        }
    ) { _ ->
        RefreshableContent(
            isRefreshing = pulling,
            onRefresh = {
                pulling = true
                onRefresh()
            },
            modifier = Modifier.fillMaxSize()
        ) {
            val state = ui.state
            val error = ui.error
            when {
                /* 首屏没有任何数据且请求失败：整页错误 + 重试。 */
                state == null && error != null -> OverviewError(error, onRefresh)
                /* 首屏加载：骨架屏（状态行 + 速率 + 摘要 + 活跃设备 + 趋势）。 */
                state == null && ui.loading -> OverviewSkeleton()
                /* 既没有数据也不在加载：等待连接（配置未就绪 / 刚启动）。 */
                state == null -> OverviewWaiting(onRefresh)
                else -> OverviewList(
                    ui = ui,
                    state = state,
                    onRefresh = onRefresh,
                    onOpenDevices = onOpenDevices,
                    onOpenDevice = onOpenDevice,
                    onOpenNetwork = onOpenNetwork
                )
            }
        }
    }
}

/* ───────────────────────── 顶栏 ───────────────────────── */

/**
 * 顶栏副标题：「服务状态 · 更新于 HH:mm:ss」。
 *
 * 离线时强调缓存时间（离线于 / 更新于都指快照时间），避免把旧数据当成实时值。
 */
private fun overviewSubtitle(ui: UiState): String {
    val state = ui.state
    val status = when {
        ui.offline -> "离线数据"
        state != null && state.running -> "服务运行中"
        state != null -> "服务已停止"
        ui.error != null -> "连接失败"
        else -> "正在连接路由器"
    }
    val time = when {
        ui.offline && ui.offlineAt > 0 -> "更新于 ${fmtClock(ui.offlineAt)}"
        ui.updatedAt > 0 -> "更新于 ${fmtClock(ui.updatedAt)}"
        else -> null
    }
    return listOfNotNull(status, time).joinToString(" · ")
}

/** 顶栏刷新：空闲是刷新图标，加载中换成 20dp 转圈，触控目标保持 48dp。 */
@Composable
private fun OverviewRefreshAction(loading: Boolean, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(PrismSize.touchTarget)
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier
                    .size(PrismSize.icon)
                    .semantics { contentDescription = "正在刷新" },
                strokeWidth = 2.dp
            )
        } else {
            Icon(
                imageVector = Icons.Rounded.Refresh,
                contentDescription = "刷新概览",
                modifier = Modifier.size(PrismSize.icon)
            )
        }
    }
}

/* ───────────────────────── 页面骨架 ───────────────────────── */

@Composable
private fun OverviewList(
    ui: UiState,
    state: PanelState,
    onRefresh: () -> Unit,
    onOpenDevices: (() -> Unit)?,
    onOpenDevice: ((Device) -> Unit)?,
    onOpenNetwork: (() -> Unit)?
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = PrismSpacing.lg,
            end = PrismSpacing.lg,
            top = PrismSpacing.sm,
            bottom = PrismSpacing.xl
        ),
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.md)
    ) {
        item(key = "status") {
            OverviewStatusRow(ui = ui, state = state, onRefresh = onRefresh)
        }
        item(key = "speed") { SpeedHeroCard(ui = ui, state = state) }
        item(key = "summary") { SummaryStrip(ui = ui, state = state) }
        item(key = "devices") {
            ActiveDevicesCard(
                state = state,
                onOpenDevices = onOpenDevices,
                onOpenDevice = onOpenDevice
            )
        }
        item(key = "trend") { TrendCard(ui) }
        item(key = "alerts") { AlertsCard(ui, onOpenDevices) }
        item(key = "exits") { ExitsCard(state, onOpenNetwork) }
        item(key = "health") { HealthCard(state) }
        item(key = "footer") { OverviewFooter(ui) }
    }
}

@Composable
private fun OverviewError(msg: String, onRetry: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(PrismSpacing.lg),
        contentAlignment = Alignment.Center
    ) {
        ErrorState(
            msg = msg,
            title = "连接路由器失败",
            onRetry = onRetry
        )
    }
}

@Composable
private fun OverviewWaiting(onRefresh: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(PrismSpacing.lg),
        contentAlignment = Alignment.Center
    ) {
        EmptyState(
            title = "等待路由器数据",
            desc = "还没有拿到路由器快照。请确认路由器地址与网络后重试，或下拉刷新。",
            icon = Icons.Rounded.Router,
            action = {
                Button(
                    onClick = onRefresh,
                    modifier = Modifier.heightIn(min = PrismSize.touchTarget)
                ) {
                    Text("立即刷新")
                }
            }
        )
    }
}

/* ───────────────────────── 状态行 ───────────────────────── */

/**
 * 紧凑状态行：服务 / 记账 / 新鲜度压成一行，异常时才追加一条明显提示。
 *
 * 正常态只占一行（≈20dp），不再用一张 120dp 的「运行状态」卡片挤占首屏；
 * 离线、同步失败、服务停止、记账降级、数据陈旧分别有独立提示与重试入口。
 */
@Composable
private fun OverviewStatusRow(ui: UiState, state: PanelState, onRefresh: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val semantic = LocalPrismSemanticColors.current
    val health = state.health
    val confidence = health.confidence.lowercase(Locale.US)
    val ageSec = if (ui.updatedAt > 0) {
        ((System.currentTimeMillis() - ui.updatedAt) / 1000).coerceAtLeast(0)
    } else {
        -1L
    }
    val stale = ageSec > 300
    val normal = state.running && confidence == "exact" && !ui.offline && ui.error == null && !stale

    val statusText = when {
        ui.offline -> "离线数据"
        ui.error != null -> "同步异常"
        !state.running -> "服务已停止"
        stale -> "数据延迟"
        else -> "服务运行中"
    }
    val statusColor = when {
        ui.offline -> semantic.warning
        ui.error != null -> scheme.error
        !state.running -> scheme.error
        stale -> semantic.warning
        confidence == "degraded" -> semantic.warning
        confidence == "unavailable" -> scheme.error
        confidence == "unknown" || confidence.isBlank() -> semantic.neutral
        else -> semantic.success
    }
    val confidenceText = when (confidence) {
        "exact" -> "记账精确"
        "degraded" -> "记账降级"
        "unavailable" -> "记账不可用"
        else -> "记账未知"
    }
    val timeText = when {
        ui.offline && ui.offlineAt > 0 -> "离线于 ${fmtClock(ui.offlineAt)}"
        ui.updatedAt > 0 -> "更新于 ${fmtClock(ui.updatedAt)}"
        else -> "等待首次数据"
    }

    val attention: StatusAttentionData? = when {
        ui.offline -> StatusAttentionData(
            message = "离线数据 · 更新于 ${fmtClock(if (ui.offlineAt > 0) ui.offlineAt else ui.updatedAt)}",
            color = semantic.warning,
            icon = Icons.Rounded.CloudOff,
            action = "重试"
        )

        ui.error != null -> StatusAttentionData(
            message = "同步失败：${ui.error}",
            color = scheme.error,
            icon = Icons.Rounded.ErrorOutline,
            action = "重试"
        )

        !state.running -> StatusAttentionData(
            message = "服务已停止：路由器进程未运行，速率与流量可能不再更新",
            color = scheme.error,
            icon = Icons.Rounded.ErrorOutline,
            action = "刷新"
        )

        confidence == "unavailable" -> StatusAttentionData(
            message = "记账不可用：无法从路由器获取记账数据",
            color = scheme.error,
            icon = Icons.Rounded.ErrorOutline,
            action = "刷新"
        )

        confidence == "degraded" -> StatusAttentionData(
            message = "记账降级：部分链路缺少数据，统计可能偏低",
            color = semantic.warning,
            icon = Icons.Rounded.ErrorOutline,
            action = "刷新"
        )

        stale -> StatusAttentionData(
            message = "数据已 ${(ageSec / 60).coerceAtLeast(1)} 分钟未更新",
            color = semantic.warning,
            icon = Icons.Rounded.CloudOff,
            action = "刷新"
        )

        else -> null
    }

    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 28.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .size(8.dp)
                    .background(statusColor, CircleShape)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = statusText,
                style = MaterialTheme.typography.labelSmall,
                color = if (normal) scheme.onSurface else statusColor,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = confidenceText,
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = timeText,
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = scheme.onSurfaceVariant,
                maxLines = 1
            )
        }
        if (attention != null) {
            Spacer(Modifier.height(PrismSpacing.xs))
            StatusAttention(data = attention, onAction = onRefresh)
        }
    }
}

@Composable
private fun StatusAttention(data: StatusAttentionData, onAction: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(PrismRadius.small),
        color = data.color.copy(alpha = 0.10f)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PrismSize.touchTarget)
                .padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = data.icon,
                contentDescription = null,
                tint = data.color,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = data.message,
                style = MaterialTheme.typography.labelSmall,
                color = data.color,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            TextButton(
                onClick = onAction,
                modifier = Modifier.heightIn(min = PrismSize.touchTarget)
            ) {
                Text(
                    text = data.action,
                    style = MaterialTheme.typography.labelSmall,
                    color = data.color
                )
            }
        }
    }
}

/* ───────────────────────── 速率主卡 ───────────────────────── */

/**
 * 速率主卡：实时下载 / 上传 + 最近 24 次采样趋势 + 本次 / 本月累计。
 *
 * 方向色固定：下载 Brand 蓝、上传科技青；底部数字用 tabular figures，
 * 不再出现同一屏「132.7 GB / 132 GB」两种月流量写法。
 */
@Composable
private fun SpeedHeroCard(ui: UiState, state: PanelState) {
    val scheme = MaterialTheme.colorScheme
    val data = LocalPrismDataColors.current
    val totals = state.totals

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(PrismRadius.large),
        color = scheme.surface,
        contentColor = scheme.onSurface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.lg)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "实时速率",
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = "每 ${ui.intervalSec} 秒刷新",
                    style = MaterialTheme.typography.labelSmall.tabular(),
                    color = scheme.onSurfaceVariant
                )
            }
            Spacer(Modifier.height(PrismSpacing.md))
            Row(verticalAlignment = Alignment.CenterVertically) {
                RateColumn(
                    label = "下载",
                    rate = totals.rxRate,
                    color = data.download,
                    icon = Icons.Rounded.ArrowDownward,
                    modifier = Modifier.weight(1f)
                )
                Box(
                    Modifier
                        .padding(horizontal = PrismSpacing.md)
                        .width(1.dp)
                        .height(56.dp)
                        .background(scheme.outlineVariant.copy(alpha = 0.7f))
                )
                RateColumn(
                    label = "上传",
                    rate = totals.txRate,
                    color = data.upload,
                    icon = Icons.Rounded.ArrowUpward,
                    modifier = Modifier.weight(1f)
                )
            }

            if (ui.rxHistory.isNotEmpty() || ui.txHistory.isNotEmpty()) {
                Spacer(Modifier.height(PrismSpacing.md))
                RateSparkline(
                    rx = ui.rxHistory,
                    tx = ui.txHistory,
                    downloadColor = data.download,
                    uploadColor = data.upload,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(36.dp)
                        .semantics {
                            contentDescription = "最近 ${maxOf(ui.rxHistory.size, ui.txHistory.size)} 次采样的上下行速率趋势"
                        }
                )
            }

            Spacer(Modifier.height(PrismSpacing.md))
            HorizontalDivider(
                color = scheme.outlineVariant.copy(alpha = 0.7f),
                thickness = PrismStroke.hairline
            )
            Spacer(Modifier.height(PrismSpacing.md))
            Row(Modifier.fillMaxWidth()) {
                HeroMetric(
                    label = "本次下载",
                    value = fmtBytes(totals.rx),
                    modifier = Modifier.weight(1f)
                )
                HeroMetric(
                    label = "本次上传",
                    value = fmtBytes(totals.tx),
                    modifier = Modifier.weight(1f)
                )
                HeroMetric(
                    label = "本月累计",
                    value = fmtBytes(totals.monthTotal),
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun RateColumn(
    label: String,
    rate: Long,
    color: Color,
    icon: ImageVector,
    modifier: Modifier = Modifier
) {
    val scheme = MaterialTheme.colorScheme
    val value = fmtMbpsValue(rate)
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .background(color.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(18.dp)
                )
            }
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant
            )
        }
        Spacer(Modifier.height(PrismSpacing.sm))
        Row(verticalAlignment = Alignment.Bottom) {
            val size = rateValueSize(value)
            Text(
                text = value,
                style = MaterialTheme.typography.headlineSmall
                    .copy(
                        fontSize = size,
                        lineHeight = size * 1.05f,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.5).sp
                    )
                    .tabular(),
                color = color,
                maxLines = 1,
                softWrap = false
            )
            Spacer(Modifier.width(PrismSpacing.xs))
            Text(
                text = "Mbps",
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.padding(bottom = PrismSpacing.xs)
            )
        }
        Text(
            text = fmtKiB(rate),
            style = MaterialTheme.typography.labelSmall.tabular(),
            color = scheme.onSurfaceVariant,
            maxLines = 1
        )
    }
}

/** 最近采样双线趋势：上传先画、下载后画，蓝线压在青线上方。 */
@Composable
private fun RateSparkline(
    rx: List<Long>,
    tx: List<Long>,
    downloadColor: Color,
    uploadColor: Color,
    modifier: Modifier = Modifier
) {
    Canvas(modifier) {
        val count = maxOf(rx.size, tx.size)
        if (count < 2) return@Canvas
        val maxValue = maxOf(
            rx.maxOrNull() ?: 0L,
            tx.maxOrNull() ?: 0L,
            1L
        ).toFloat()
        val stepX = size.width / (count - 1)

        fun drawSeries(values: List<Long>, color: Color) {
            if (values.size < 2) return
            val offset = count - values.size
            var previous: Offset? = null
            values.forEachIndexed { index, raw ->
                val x = (offset + index) * stepX
                val ratio = (raw.coerceAtLeast(0L) / maxValue).coerceIn(0f, 1f)
                val point = Offset(x, size.height - ratio * size.height)
                previous?.let { start ->
                    drawLine(
                        color = color.copy(alpha = 0.9f),
                        start = start,
                        end = point,
                        strokeWidth = 2.dp.toPx(),
                        cap = StrokeCap.Round
                    )
                }
                previous = point
            }
        }

        drawSeries(tx, uploadColor)
        drawSeries(rx, downloadColor)
    }
}

@Composable
private fun HeroMetric(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(PrismSpacing.xs))
        Text(
            text = value,
            style = MaterialTheme.typography.titleSmall.tabular(),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/* ───────────────────────── 今日 / 在线摘要 ───────────────────────── */

/**
 * 紧凑摘要条：今日流量 / 在线设备 / Clash 连接。
 *
 * 今日优先取近 7 天历史里「今天」的汇总；历史尚未拿到时退回面板进程累计，
 * 并把标签改成「本次累计」，避免把进程累计谎报成今日。
 * 本月只保留在速率主卡底部，摘要条不再重复，避免同屏两个不同格式的月流量。
 */
@Composable
private fun SummaryStrip(ui: UiState, state: PanelState) {
    val scheme = MaterialTheme.colorScheme
    val todayKey = LocalDate.now().toString()
    val today = ui.history.lastOrNull()?.takeIf { it.day == todayKey }
    val todayLabel = if (today != null) "今日流量" else "本次累计"
    val todayValue = fmtBytes(today?.total ?: state.totals.total)

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = scheme.surface,
        contentColor = scheme.onSurface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = PrismSpacing.lg, vertical = PrismSpacing.md),
            verticalAlignment = Alignment.CenterVertically
        ) {
            SummaryCell(todayLabel, todayValue, Modifier.weight(1f))
            SummaryDivider()
            SummaryCell("在线设备", "${state.onlineCount} 台", Modifier.weight(1f))
            SummaryDivider()
            SummaryCell("Clash 连接", "${state.health.clashConnections} 条", Modifier.weight(1f))
        }
    }
}

@Composable
private fun SummaryCell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.height(PrismSpacing.xs))
        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium.tabular(),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun SummaryDivider() {
    Box(
        Modifier
            .padding(horizontal = PrismSpacing.sm)
            .width(PrismStroke.hairline)
            .height(32.dp)
            .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
    )
}

/* ───────────────────────── Top 3 活跃设备 ───────────────────────── */

/**
 * 活跃设备入口：按「实时速率总和」排序取前 3。
 *
 * 行点击优先跳单设备详情（[onOpenDevice] 已接线时）；未接线时保持旧行为跳设备页签。
 * 「查看全部」始终进设备页签，方便看完整列表。副标题与读屏文案会随接线情况变化，
 * 不再写成「只能进入设备页」。
 */
@Composable
private fun ActiveDevicesCard(
    state: PanelState,
    onOpenDevices: (() -> Unit)?,
    onOpenDevice: ((Device) -> Unit)?
) {
    val devices = remember(state.devices) {
        state.devices
            .sortedWith(
                compareByDescending<Device> { it.rxRate + it.txRate }
                    .thenByDescending { it.total }
                    .thenBy { it.name.lowercase(Locale.US) }
            )
            .take(ACTIVE_DEVICE_ROWS)
    }
    val openDevices = onOpenDevices
    val actionSlot: (@Composable () -> Unit)? = if (openDevices != null) {
        { ViewAllAction(text = "查看全部", onClick = openDevices) }
    } else {
        null
    }
    val hasDetail = onOpenDevice != null
    val subtitle = when {
        hasDetail -> "按实时速率排序 · 点按查看设备详情"
        openDevices != null -> "按实时速率排序 · 点按进入设备页"
        else -> "按实时速率排序"
    }

    SectionCard(
        title = "活跃设备",
        subtitle = subtitle,
        action = actionSlot
    ) {
        if (devices.isEmpty()) {
            Text(
                text = "路由器还没有上报终端速率，连接 Wi-Fi 后会自动出现。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            return@SectionCard
        }
        devices.forEachIndexed { index, device ->
            /* 没有 MAC 时无法定位详情，回落为设备页签跳转。 */
            val openDetail = onOpenDevice != null && normalizeMac(device.mac).isNotBlank()
            val rowClick: (() -> Unit)? = if (openDetail) {
                { onOpenDevice?.invoke(device) }
            } else {
                onOpenDevices
            }
            ActiveDeviceRow(
                device = device,
                onClick = rowClick,
                actionHint = if (openDetail) "点按查看设备详情" else "点按进入设备页"
            )
            if (index != devices.lastIndex) {
                HorizontalDivider(
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f),
                    thickness = PrismStroke.hairline
                )
            }
        }
    }
}

@Composable
private fun ActiveDeviceRow(
    device: Device,
    onClick: (() -> Unit)?,
    actionHint: String = "点按进入设备页"
) {
    val data = LocalPrismDataColors.current
    val scheme = MaterialTheme.colorScheme
    val name = device.name.ifBlank { "未命名设备" }
    val shape = MaterialTheme.shapes.small
    val clickModifier = if (onClick != null) {
        Modifier
            .clip(shape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "$name，下载 ${fmtRate(device.rxRate)}，" +
                    "上传 ${fmtRate(device.txRate)}，累计 ${fmtBytes(device.total)}，$actionHint"
            }
    } else {
        Modifier
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = PrismSize.touchTarget)
            .then(clickModifier)
            .padding(vertical = PrismSpacing.xs),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(scheme.primary.copy(alpha = 0.12f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Rounded.Devices,
                contentDescription = null,
                tint = scheme.primary,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
        }
        Spacer(Modifier.width(PrismSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = name,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = scheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = "累计 ${fmtBytes(device.total)}",
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = "↓ ${fmtRate(device.rxRate)}",
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = data.download,
                maxLines = 1
            )
            Text(
                text = "↑ ${fmtRate(device.txRate)}",
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = data.upload,
                maxLines = 1
            )
        }
        if (onClick != null) {
            Spacer(Modifier.width(PrismSpacing.xs))
            Icon(
                imageVector = Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = scheme.onSurfaceVariant,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
        }
    }
}

/* ───────────────────────── 近 7 天趋势 ───────────────────────── */

/**
 * 近 7 天趋势：Canvas 柱状图（不引第三方库）。
 *
 * 点击某根柱子选中当天：选中柱高亮、下方展示日期 / 下载 / 上传 / 总量；
 * 再点一次取消选中。无数据时按加载状态给骨架或空态。
 */
@Composable
private fun TrendCard(ui: UiState) {
    val days = ui.history
    /* 空串代表「未选中」：用 rememberSaveable 保留旋转 / 返回后的选中态。 */
    var selectedDay by rememberSaveable { mutableStateOf("") }
    val selected = days.firstOrNull { it.day == selectedDay && selectedDay.isNotEmpty() }
    val sum = days.sumOf { it.total }

    SectionCard(
        title = "近 7 天趋势",
        subtitle = "每日总流量 · 点按柱子查看当天明细",
        action = {
            if (days.isNotEmpty()) {
                Text(
                    text = "合计 ${fmtBytes(sum)}",
                    style = MaterialTheme.typography.labelSmall.tabular(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    ) {
        when {
            days.isEmpty() && ui.loading -> SkeletonBox(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(124.dp),
                alpha = 0.7f
            )

            days.isEmpty() -> EmptyState(
                title = "暂无趋势数据",
                icon = Icons.Rounded.BarChart,
                desc = if (ui.historyError != null) {
                    "历史数据暂不可用，下拉刷新可重试"
                } else {
                    "路由器还没有生成每日汇总，稍后再试"
                }
            )

            else -> {
                val chartDesc = remember(days) {
                    val peak = days.maxByOrNull { it.total }
                    buildString {
                        append("近 ${days.size} 天流量柱状图，合计 ${fmtBytes(days.sumOf { it.total })}")
                        if (peak != null) append("，最高 ${peak.dayLabel} ${fmtBytes(peak.total)}")
                    }
                }
                DailyBars(
                    days = days,
                    selectedDay = selected?.day,
                    onSelect = { day ->
                        selectedDay = if (selectedDay == day) "" else day
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(124.dp)
                        .semantics { contentDescription = chartDesc }
                )
                Spacer(Modifier.height(PrismSpacing.sm))
                Row(Modifier.fillMaxWidth()) {
                    days.forEach { day ->
                        val active = day.day == selected?.day
                        Text(
                            text = day.dayLabel,
                            style = MaterialTheme.typography.labelSmall.tabular(),
                            color = if (active) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
                Spacer(Modifier.height(PrismSpacing.md))
                if (selected != null) {
                    DayDetail(selected)
                } else {
                    Text(
                        text = "近 ${days.size} 天合计 ${fmtBytes(sum)} · " +
                            "日均 ${fmtBytes(sum / days.size)}",
                        style = MaterialTheme.typography.labelSmall.tabular(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

/**
 * 柱状图本体：每根柱子 = 当日总量，高度按 7 天峰值归一。
 *
 * 柱体用纯色而非渐变（选中 100%、未选中 45%）；槽位底色始终绘制，
 * 因此「0 流量」的一天也能看出位置。
 */
@Composable
private fun DailyBars(
    days: List<DailyUsage>,
    selectedDay: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val barColor = MaterialTheme.colorScheme.primary
    val trackColor = MaterialTheme.colorScheme.surfaceVariant
    val data = LocalPrismDataColors.current
    val maxTotal = maxOf(days.maxOfOrNull { it.total } ?: 0L, 1L).toFloat()
    val hasFlow = days.any { it.total > 0L }

    Box(modifier) {
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(days) {
                    detectTapGestures { offset ->
                        if (days.isEmpty()) return@detectTapGestures
                        val slot = size.width.toFloat() / days.size
                        if (slot <= 0f) return@detectTapGestures
                        val index = (offset.x / slot).toInt().coerceIn(0, days.lastIndex)
                        onSelect(days[index].day)
                    }
                }
        ) {
            if (days.isEmpty()) return@Canvas
            val slot = size.width / days.size
            val gap = (slot * 0.22f).coerceIn(6.dp.toPx(), 14.dp.toPx())
            val barWidth = minOf(slot - gap, 44.dp.toPx()).coerceAtLeast(3.dp.toPx())
            val radius = CornerRadius(6.dp.toPx(), 6.dp.toPx())

            days.forEachIndexed { index, day ->
                val left = slot * index + (slot - barWidth) / 2f
                val selected = day.day == selectedDay
                drawRoundRect(
                    color = trackColor.copy(alpha = if (selected) 0.85f else 0.55f),
                    topLeft = Offset(left, 0f),
                    size = Size(barWidth, size.height),
                    cornerRadius = radius
                )
                if (day.total <= 0L) return@forEachIndexed
                val barHeight = (day.total / maxTotal * size.height)
                    .coerceIn(4.dp.toPx(), size.height)
                val top = size.height - barHeight
                val alpha = when {
                    selectedDay == null -> 1f
                    selected -> 1f
                    else -> 0.45f
                }
                drawRoundRect(
                    color = barColor,
                    topLeft = Offset(left, top),
                    size = Size(barWidth, barHeight),
                    cornerRadius = radius,
                    alpha = alpha
                )
            }
        }
        if (!hasFlow) {
            Text(
                text = "近 7 天暂无流量记录",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.Center)
            )
        }
    }
}

/** 选中当天的明细条：日期 / 下载 / 上传 / 总量。 */
@Composable
private fun DayDetail(day: DailyUsage) {
    val data = LocalPrismDataColors.current
    Surface(
        shape = RoundedCornerShape(PrismRadius.small),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = PrismSpacing.md, vertical = PrismSpacing.sm)
        ) {
            DetailCell("日期", day.dayLabel, Modifier.weight(1f))
            DetailCell("下载", fmtBytes(day.rx), Modifier.weight(1.3f), color = data.download)
            DetailCell("上传", fmtBytes(day.tx), Modifier.weight(1.3f), color = data.upload)
            DetailCell("总量", fmtBytes(day.total), Modifier.weight(1.3f))
        }
    }
}

@Composable
private fun DetailCell(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurface
) {
    Column(modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
        Spacer(Modifier.height(PrismSpacing.xs))
        Text(
            text = value,
            style = MaterialTheme.typography.labelSmall.tabular(),
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/* ───────────────────────── 告警中心 ───────────────────────── */

@Composable
private fun AlertsCard(ui: UiState, onOpenDevices: (() -> Unit)?) {
    val alerts = ui.alerts
    val visible = alerts.take(MAX_ALERT_ROWS)
    val scheme = MaterialTheme.colorScheme
    val semantic = LocalPrismSemanticColors.current
    val hasDanger = alerts.any { it.severity == AlertSeverity.DANGER }

    SectionCard(
        title = "告警中心",
        subtitle = if (alerts.isEmpty()) {
            "设备、流量与记账健康检查"
        } else if (onOpenDevices != null) {
            "按严重度排序 · 设备类告警可点按跳转"
        } else {
            "按严重度排序"
        },
        action = {
            if (alerts.isNotEmpty()) {
                Pill(
                    text = "${alerts.size} 条",
                    color = if (hasDanger) scheme.error else semantic.warning
                )
            }
        }
    ) {
        if (visible.isEmpty()) {
            AllClearRow()
            return@SectionCard
        }
        visible.forEachIndexed { index, alert ->
            val color = when (alert.severity) {
                AlertSeverity.DANGER -> scheme.error
                AlertSeverity.WARN -> semantic.warning
                AlertSeverity.INFO -> semantic.info
            }
            val open = if (alert.target == AlertTarget.DEVICES) onOpenDevices else null
            StatusRow(
                title = alert.title,
                description = alert.detail,
                color = color,
                trailingText = if (open != null) "设备" else null,
                onClick = open
            )
            if (index != visible.lastIndex) {
                HorizontalDivider(
                    color = scheme.outlineVariant.copy(alpha = 0.7f),
                    thickness = PrismStroke.hairline
                )
            }
        }
        if (alerts.size > visible.size) {
            Spacer(Modifier.height(PrismSpacing.sm))
            Text(
                text = "另有 ${alerts.size - visible.size} 条告警未显示",
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun AllClearRow() {
    val success = LocalPrismSemanticColors.current.success
    Surface(
        shape = RoundedCornerShape(PrismRadius.small),
        color = success.copy(alpha = 0.10f)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.md),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .background(success.copy(alpha = 0.16f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Rounded.TaskAlt,
                    contentDescription = null,
                    tint = success,
                    modifier = Modifier.size(PrismSize.iconSmall)
                )
            }
            Spacer(Modifier.width(PrismSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = "一切正常",
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = "未发现异常，记账与链路健康",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.width(PrismSpacing.sm))
            Pill(text = "0 条", color = success)
        }
    }
}

/* ───────────────────────── 出口 / 节点 ───────────────────────── */

@Composable
private fun ExitsCard(state: PanelState, onOpenNetwork: (() -> Unit)?) {
    val nodes = state.nodes.sortedByDescending { it.total }
    val total = nodes.sumOf { it.total }.coerceAtLeast(1L)
    val visible = nodes.take(MAX_EXIT_ROWS)
    val subtitle = if (nodes.isEmpty()) "累计流量占比" else "累计流量占比 · 前 ${visible.size} 个"

    /* 回调存在才显示「查看全部」；当前导航未接线时按钮不出现。 */
    val openNetwork = onOpenNetwork
    if (openNetwork != null) {
        SectionCard(
            title = "出口 / 节点",
            subtitle = subtitle,
            action = { ViewAllAction(text = "查看全部", onClick = openNetwork) }
        ) {
            ExitsBody(nodes, visible, total)
        }
    } else {
        SectionCard(title = "出口 / 节点", subtitle = subtitle) {
            ExitsBody(nodes, visible, total)
        }
    }
}

@Composable
private fun ExitsBody(nodes: List<NodeUsage>, visible: List<NodeUsage>, total: Long) {
    if (visible.isEmpty()) {
        Text(
            text = "路由器尚未下发出口数据，稍后下拉刷新。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        return
    }
    visible.forEachIndexed { index, node ->
        val share = (node.total.toFloat() / total).coerceIn(0f, 1f)
        ExitRow(
            name = exitName(node.name),
            total = node.total,
            share = share,
            color = if (node.name.trim().equals("DIRECT", ignoreCase = true)) {
                LocalPrismCategoryColors.current.direct
            } else {
                LocalPrismCategoryColors.current.proxy
            }
        )
        if (index != visible.lastIndex) Spacer(Modifier.height(PrismSpacing.md))
    }
    if (nodes.size > visible.size) {
        Spacer(Modifier.height(PrismSpacing.sm))
        Text(
            text = "另有 ${nodes.size - visible.size} 个出口",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun ExitRow(name: String, total: Long, share: Float, color: Color) {
    val percent = (share * 100f).roundToInt()
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = name,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = "$percent%",
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1
            )
            Spacer(Modifier.width(PrismSpacing.md))
            Text(
                text = fmtBytes(total),
                style = MaterialTheme.typography.bodyMedium
                    .copy(fontWeight = FontWeight.SemiBold)
                    .tabular(),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1
            )
        }
        Spacer(Modifier.height(PrismSpacing.sm))
        PrismProgressBar(
            progress = share,
            color = color,
            contentDescription = "$name 占比 $percent%"
        )
    }
}

@Composable
private fun ViewAllAction(text: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.heightIn(min = PrismSize.touchTarget)
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall
        )
    }
}

/* ───────────────────────── 健康与记账 ───────────────────────── */

@Composable
private fun HealthCard(state: PanelState) {
    val scheme = MaterialTheme.colorScheme
    val semantic = LocalPrismSemanticColors.current
    val health = state.health
    val (color, label, summary) = when (health.confidence.lowercase(Locale.US)) {
        "exact" -> Triple(
            semantic.success,
            "记账精确",
            "所有记账链路都正常，流量数据可直接用于配额与账单。"
        )

        "degraded" -> Triple(
            semantic.warning,
            "记账降级",
            "部分链路缺少数据，统计可能偏低，请查看下方原因。"
        )

        "unavailable" -> Triple(
            scheme.error,
            "记账不可用",
            "无法获取记账数据，请检查路由器与内核模块状态。"
        )

        else -> Triple(
            semantic.neutral,
            "记账未知",
            "路由器尚未返回可信度字段，暂不做记账结论。"
        )
    }
    val reasons = health.reasons

    SectionCard(
        title = "健康与记账",
        subtitle = "可信度结论、原因与数据源",
        action = { Pill(text = label, color = color) }
    ) {
        Text(
            text = summary,
            style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant
        )
        Spacer(Modifier.height(PrismSpacing.md))
        if (reasons.isEmpty()) {
            StatusRow(
                title = "未发现异常",
                description = "记账链路检查全部通过",
                color = semantic.success,
                icon = Icons.Rounded.TaskAlt
            )
        } else {
            reasons.take(MAX_HEALTH_REASONS).forEach { reason ->
                StatusRow(title = reason, color = semantic.warning)
            }
            if (reasons.size > MAX_HEALTH_REASONS) {
                Text(
                    text = "另有 ${reasons.size - MAX_HEALTH_REASONS} 条原因",
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = PrismSpacing.xs)
                )
            }
        }
        HorizontalDivider(
            modifier = Modifier.padding(vertical = PrismSpacing.md),
            color = scheme.outlineVariant.copy(alpha = 0.7f),
            thickness = PrismStroke.hairline
        )
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)) {
            InfoCell(
                label = "Clash 订阅",
                value = state.clash.ifBlank { "—" },
                caption = if (health.clashPollMs > 0) {
                    "轮询 ${health.clashPollMs} ms"
                } else {
                    "策略代理"
                },
                modifier = Modifier.weight(1f)
            )
            InfoCell(
                label = "conntrack",
                value = state.conntrack.ifBlank { "—" },
                caption = "连接跟踪表",
                modifier = Modifier.weight(1f)
            )
        }
        Spacer(Modifier.height(PrismSpacing.md))
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)) {
            InfoCell(
                label = "链路来源",
                value = health.linkSource.ifBlank { "—" },
                modifier = Modifier.weight(1f)
            )
            InfoCell(
                label = "链路桥接",
                value = health.linkBridge.ifBlank { "—" },
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
private fun InfoCell(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    caption: String? = null
) {
    Column(modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
        Spacer(Modifier.height(PrismSpacing.xs))
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        if (caption != null) {
            Spacer(Modifier.height(PrismSpacing.xs))
            Text(
                text = caption,
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

/* ───────────────────────── 页脚 ───────────────────────── */

@Composable
private fun OverviewFooter(ui: UiState) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = PrismSpacing.xs),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "数据来自路由器只读接口",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(PrismSpacing.xs))
        Text(
            text = "每 ${ui.intervalSec} 秒自动刷新 · 下拉可立即更新",
            style = MaterialTheme.typography.labelSmall.tabular(),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
    }
}

/* ───────────────────────── 骨架屏 ───────────────────────── */

/** 首屏骨架：状态行 + 速率主卡 + 摘要 + 活跃设备 + 趋势，与真实布局一一对应。 */
@Composable
private fun OverviewSkeleton() {
    val alpha = rememberSkeletonAlpha()
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .semantics { contentDescription = "概览加载中" },
        contentPadding = PaddingValues(
            start = PrismSpacing.lg,
            end = PrismSpacing.lg,
            top = PrismSpacing.sm,
            bottom = PrismSpacing.xl
        ),
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.md)
    ) {
        item { SkeletonStatus(alpha) }
        item { SkeletonHero(alpha) }
        item { SkeletonSummary(alpha) }
        item { SkeletonDevices(alpha) }
        item { SkeletonTrend(alpha) }
    }
}

@Composable
private fun rememberSkeletonAlpha(): Float {
    val transition = rememberInfiniteTransition(label = "overview-skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.95f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "overview-skeleton-alpha"
    )
    return alpha
}

/** 骨架卡片外壳：与 [SectionCard] 相同的圆角 / 表面，不再加 1dp 描边。 */
@Composable
private fun SkeletonSurface(
    shape: RoundedCornerShape = RoundedCornerShape(PrismRadius.medium),
    content: @Composable ColumnScope.() -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.lg),
            content = content
        )
    }
}

@Composable
private fun SkeletonStatus(alpha: Float) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 28.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        SkeletonBox(Modifier.size(8.dp), alpha, CircleShape)
        Spacer(Modifier.width(PrismSpacing.sm))
        SkeletonBox(Modifier.width(64.dp).height(12.dp), alpha)
        Spacer(Modifier.width(PrismSpacing.sm))
        SkeletonBox(Modifier.width(56.dp).height(12.dp), alpha)
        Spacer(Modifier.weight(1f))
        SkeletonBox(Modifier.width(88.dp).height(12.dp), alpha)
    }
}

@Composable
private fun SkeletonHero(alpha: Float) {
    SkeletonSurface(shape = RoundedCornerShape(PrismRadius.large)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SkeletonRateColumn(alpha, Modifier.weight(1f))
            SkeletonRateColumn(alpha, Modifier.weight(1f))
        }
        Spacer(Modifier.height(PrismSpacing.md))
        SkeletonBox(Modifier.fillMaxWidth().height(36.dp), alpha)
        Spacer(Modifier.height(PrismSpacing.md))
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
        Spacer(Modifier.height(PrismSpacing.md))
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
            repeat(3) {
                SkeletonBox(Modifier.weight(1f).height(32.dp), alpha)
            }
        }
    }
}

@Composable
private fun SkeletonRateColumn(alpha: Float, modifier: Modifier = Modifier) {
    Column(modifier) {
        SkeletonBox(Modifier.width(52.dp).height(12.dp), alpha)
        Spacer(Modifier.height(PrismSpacing.md))
        SkeletonBox(Modifier.fillMaxWidth(0.72f).height(34.dp), alpha)
        Spacer(Modifier.height(PrismSpacing.sm))
        SkeletonBox(Modifier.width(72.dp).height(12.dp), alpha)
    }
}

@Composable
private fun SkeletonSummary(alpha: Float) {
    SkeletonSurface {
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
            repeat(3) {
                Column(Modifier.weight(1f)) {
                    SkeletonBox(Modifier.width(56.dp).height(12.dp), alpha)
                    Spacer(Modifier.height(PrismSpacing.sm))
                    SkeletonBox(Modifier.width(72.dp).height(20.dp), alpha)
                }
            }
        }
    }
}

@Composable
private fun SkeletonDevices(alpha: Float) {
    SkeletonSurface {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SkeletonBox(Modifier.width(96.dp).height(14.dp), alpha)
            Spacer(Modifier.weight(1f))
            SkeletonBox(Modifier.width(52.dp).height(12.dp), alpha)
        }
        Spacer(Modifier.height(PrismSpacing.md))
        repeat(3) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                SkeletonBox(Modifier.size(32.dp), alpha, CircleShape)
                Spacer(Modifier.width(PrismSpacing.md))
                SkeletonBox(Modifier.weight(1f).height(14.dp), alpha)
                Spacer(Modifier.width(PrismSpacing.md))
                SkeletonBox(Modifier.width(64.dp).height(12.dp), alpha)
            }
        }
    }
}

@Composable
private fun SkeletonTrend(alpha: Float) {
    SkeletonSurface {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SkeletonBox(Modifier.width(112.dp).height(14.dp), alpha)
            Spacer(Modifier.weight(1f))
            SkeletonBox(Modifier.width(64.dp).height(12.dp), alpha)
        }
        Spacer(Modifier.height(PrismSpacing.md))
        SkeletonBox(
            modifier = Modifier
                .fillMaxWidth()
                .height(124.dp),
            alpha = alpha
        )
    }
}

/* ───────────────────────── 数字 / 文案工具 ───────────────────────── */

/** 等宽数字：轮询刷新时数字宽度不变，避免整行左右抖动。 */
private fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = "tnum")

/** 速率主数字：≥100 取整、≥0.1 保留 1 位、更小保留 2 位，控制字号不跳变。 */
private fun fmtMbpsValue(bytesPerSec: Long): String {
    val mbps = bytesPerSec.coerceAtLeast(0L) * 8.0 / 1_000_000.0
    return when {
        mbps >= 100 -> String.format(Locale.US, "%.0f", mbps)
        mbps >= 0.1 -> String.format(Locale.US, "%.1f", mbps)
        else -> String.format(Locale.US, "%.2f", mbps)
    }
}

/** 辅助单位 KiB/s（与 Mbps 同一数据源，只是换单位展示）。 */
private fun fmtKiB(bytesPerSec: Long): String =
    String.format(Locale.US, "%.0f KiB/s", bytesPerSec.coerceAtLeast(0L) / 1024.0)

/** 按数字长度给速率主数字降字号：360dp 宽度下两列并排不换行、不裁切。 */
private fun rateValueSize(text: String): TextUnit = when {
    text.length <= 4 -> 36.sp
    text.length == 5 -> 32.sp
    text.length == 6 -> 28.sp
    else -> 24.sp
}

/** 出口名：DIRECT 统一显示为「直连」，与其余节点名区分。 */
private fun exitName(name: String): String =
    if (name.trim().equals("DIRECT", ignoreCase = true)) "直连" else name
