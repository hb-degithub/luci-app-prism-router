package io.prism.router.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.DataUsage
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Router
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
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
import io.prism.router.data.PanelState
import io.prism.router.data.NodeUsage
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock
import io.prism.router.ui.components.EmptyState
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.RefreshableContent
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.components.SkeletonBox
import io.prism.router.ui.components.StatCard
import io.prism.router.ui.components.StatusRow
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import java.time.LocalDate
import java.util.Locale
import kotlin.math.roundToInt

/*
 * 概览屏（重做版）。
 *
 * 设计取向对齐成熟商用路由器 App：单列、卡片、留白充足；先给结论（服务状态 / 速率），
 * 再给 KPI 与趋势，最后是告警、出口与记账健康。所有数字使用 tabular-nums（tnum），
 * 让 15 秒轮询时数字不会左右跳动。
 *
 * 顶栏说明：本屏自带 PrismScaffold（与设备 / 应用 / 网络三屏一致），大标题「概览」、
 * 副标题「服务状态 · 更新于 HH:mm:ss」、右上角刷新（加载中换成转圈）。导航层只负责
 * 挂载屏幕，不再包第二层 Scaffold —— 否则会出现两条标题栏、状态栏内边距也会叠加。
 * 滚动内容驱动大标题收起（nestedScroll 由 PrismScaffold 接到内容区）。
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

/**
 * 概览页（兼容旧调用：只传刷新回调）。
 *
 * 新的接线可再传 [onOpenDevices] / [onOpenNetwork]，让设备类告警跳「设备」页签、
 * 「查看全部」跳「网络」页签；未接入时对应跳转入口自动隐藏。
 */
@Composable
fun OverviewScreen(ui: UiState, onRefresh: () -> Unit) {
    OverviewScreen(ui = ui, onRefresh = onRefresh, onOpenDevices = null)
}

/**
 * 概览页。
 *
 * [onOpenDevices]：设备类告警的跳转回调（App / 导航传入后生效，为 null 时告警只展示）。
 * [onOpenNetwork]：出口摘要「查看全部」的跳转回调；为 null 时不显示该按钮。
 */
@Composable
fun OverviewScreen(
    ui: UiState,
    onRefresh: () -> Unit,
    onOpenDevices: (() -> Unit)? = null,
    onOpenNetwork: (() -> Unit)? = null
) {
    /* 只在下拉 / 手动重试期间展示顶部指示器，避免 15s 自动轮询让指示器反复闪动。 */
    var pulling by remember { mutableStateOf(false) }
    LaunchedEffect(ui.loading) {
        if (!ui.loading) pulling = false
    }

    /*
     * 本屏自带上标题栏（与设备 / 应用 / 网络三屏一致，避免导航层与屏内各画一条）：
     * 大标题滚动收起、副标题给服务状态与更新时间、右上角刷新在加载时转圈。
     */
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
                /* 首屏加载：骨架屏（速率 + KPI + 趋势各一块）。 */
                state == null && ui.loading -> OverviewSkeleton()
                /* 既没有数据也不在加载：等待连接（配置未就绪 / 刚启动）。 */
                state == null -> OverviewWaiting(onRefresh)
                else -> OverviewList(
                    ui = ui,
                    state = state,
                    onRefresh = onRefresh,
                    onOpenDevices = onOpenDevices,
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
        else -> "正在连接面板"
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
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.lg)
    ) {
        item(key = "status") {
            StatusBanner(
                ui = ui,
                state = state,
                onRefresh = onRefresh
            )
        }
        item(key = "speed") { SpeedHeroCard(state) }
        item(key = "kpi") { KpiGrid(ui, state) }
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
            title = "连接面板失败",
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
            desc = "还没有拿到面板快照。请确认地址与网络后重试，或下拉刷新。",
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

/* ───────────────────────── 状态横幅 ───────────────────────── */

/**
 * 状态横幅：服务运行 / 记账可信度 / 数据新鲜度三颗胶囊。
 *
 * 颜色语义固定：绿=正常、橙=降级、红=异常；离线时整条换成「离线数据」提示条。
 * 三颗胶囊用 [FlowRow] 排布，大字号 / 窄屏会自动换行，390dp 下不会溢出。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatusBanner(
    ui: UiState,
    state: PanelState,
    onRefresh: () -> Unit
) {
    val scheme = MaterialTheme.colorScheme
    val semantic = LocalPrismSemanticColors.current
    val health = state.health

    val serviceColor = if (state.running) semantic.success else scheme.error
    val serviceText = if (state.running) "服务运行中" else "服务已停止"

    val (confidenceColor, confidenceText) = when (health.confidence.lowercase(Locale.US)) {
        "exact" -> semantic.success to "记账精确"
        "degraded" -> semantic.warning to "记账降级"
        "unavailable" -> scheme.error to "记账不可用"
        else -> semantic.neutral to "记账未知"
    }

    val ageSec = if (ui.updatedAt > 0) {
        ((System.currentTimeMillis() - ui.updatedAt) / 1000).coerceAtLeast(0)
    } else {
        -1
    }
    val (freshColor, freshText) = when {
        ui.offline -> scheme.error to "离线缓存"
        ageSec < 0 -> semantic.neutral to "等待数据"
        ageSec <= 60 -> semantic.success to "数据实时"
        ageSec <= 300 -> semantic.warning to "${ageSec / 60} 分钟前"
        else -> scheme.error to "数据陈旧"
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(PrismRadius.large),
        color = scheme.surface,
        contentColor = scheme.onSurface,
        tonalElevation = 0.dp,
        border = BorderStroke(1.dp, scheme.outlineVariant.copy(alpha = 0.55f))
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.lg)
        ) {
            Text(
                text = "运行状态",
                style = MaterialTheme.typography.titleMedium
            )
            Spacer(Modifier.height(PrismSpacing.md))
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm, Alignment.Start),
                verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
            ) {
                Pill(text = serviceText, color = serviceColor)
                Pill(text = confidenceText, color = confidenceColor)
                Pill(text = freshText, color = freshColor)
            }

            val error = ui.error
            when {
                ui.offline -> {
                    Spacer(Modifier.height(PrismSpacing.md))
                    OfflineBar(
                        at = if (ui.offlineAt > 0) ui.offlineAt else ui.updatedAt,
                        onRetry = onRefresh
                    )
                }

                error != null -> {
                    Spacer(Modifier.height(PrismSpacing.md))
                    InlineError(msg = error, onRetry = onRefresh)
                }
            }
        }
    }
}

/** 离线数据条：橙底 + 重试，触控高度 ≥48dp。 */
@Composable
private fun OfflineBar(at: Long, onRetry: () -> Unit) {
    val warning = LocalPrismSemanticColors.current.warning
    Surface(
        shape = RoundedCornerShape(PrismRadius.small),
        color = warning.copy(alpha = 0.12f)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Rounded.CloudOff,
                contentDescription = null,
                tint = warning,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = "离线数据 · 更新于 ${fmtClock(at)}",
                style = MaterialTheme.typography.labelSmall.tabular(),
                color = warning,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            TextButton(
                onClick = onRetry,
                modifier = Modifier.heightIn(min = PrismSize.touchTarget)
            ) {
                Text(
                    text = "重试",
                    style = MaterialTheme.typography.labelSmall,
                    color = warning
                )
            }
        }
    }
}

/** 在线但本轮同步失败：红底提示 + 重试，数据仍展示（避免整屏闪烁）。 */
@Composable
private fun InlineError(msg: String, onRetry: () -> Unit) {
    val error = MaterialTheme.colorScheme.error
    Surface(
        shape = RoundedCornerShape(PrismRadius.small),
        color = error.copy(alpha = 0.10f)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Rounded.ErrorOutline,
                contentDescription = null,
                tint = error,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = "同步失败：$msg",
                style = MaterialTheme.typography.labelSmall,
                color = error,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            TextButton(
                onClick = onRetry,
                modifier = Modifier.heightIn(min = PrismSize.touchTarget)
            ) {
                Text(
                    text = "重试",
                    style = MaterialTheme.typography.labelSmall,
                    color = error
                )
            }
        }
    }
}

/* ───────────────────────── 速率大卡 ───────────────────────── */

/**
 * 速率大卡：左下载（品牌蓝）/ 右上传（橙），底部一行累计与本月。
 *
 * 顶部叠一层品牌色 12% → 透明的竖向渐变，深浅主题下都只做很轻的强调，
 * 不依赖图片资源，也不影响数字对比度。
 */
@Composable
private fun SpeedHeroCard(state: PanelState) {
    val scheme = MaterialTheme.colorScheme
    val semantic = LocalPrismSemanticColors.current
    val totals = state.totals
    val gradient = Brush.verticalGradient(
        listOf(scheme.primary.copy(alpha = 0.12f), Color.Transparent)
    )

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(PrismRadius.large),
        color = scheme.surface,
        contentColor = scheme.onSurface,
        tonalElevation = 0.dp,
        border = BorderStroke(1.dp, scheme.outlineVariant.copy(alpha = 0.55f))
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(gradient)
                    .padding(horizontal = PrismSpacing.lg, vertical = PrismSpacing.lg),
                verticalAlignment = Alignment.CenterVertically
            ) {
                RateColumn(
                    label = "下载",
                    rate = totals.rxRate,
                    color = scheme.primary,
                    icon = Icons.Rounded.ArrowDownward,
                    modifier = Modifier.weight(1f)
                )
                Box(
                    Modifier
                        .padding(horizontal = PrismSpacing.md)
                        .width(1.dp)
                        .height(64.dp)
                        .background(scheme.outlineVariant.copy(alpha = 0.6f))
                )
                RateColumn(
                    label = "上传",
                    rate = totals.txRate,
                    color = semantic.warning,
                    icon = Icons.Rounded.ArrowUpward,
                    modifier = Modifier.weight(1f)
                )
            }
            HorizontalDivider(color = scheme.outlineVariant.copy(alpha = 0.45f))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = PrismSpacing.lg, vertical = PrismSpacing.md)
            ) {
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
                    .size(PrismSize.iconLarge)
                    .background(color.copy(alpha = 0.14f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(16.dp)
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
                        lineHeight = size * 1.08f,
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
            style = MaterialTheme.typography.titleMedium.tabular(),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/* ───────────────────────── KPI 网格 ───────────────────────── */

/**
 * 2×2 KPI：今日流量 / 本月累计 / 在线设备 / Clash 连接。
 *
 * 今日流量优先取近 7 天历史里「今天」的汇总；历史尚未拿到时退回面板进程累计，
 * 并把标签改成「本次累计」，避免把进程累计谎报成今日。
 */
@Composable
private fun KpiGrid(ui: UiState, state: PanelState) {
    val totals = state.totals
    val semantic = LocalPrismSemanticColors.current
    val todayKey = LocalDate.now().toString()
    val today = ui.history.lastOrNull()?.takeIf { it.day == todayKey }

    val todayLabel = if (today != null) "今日流量" else "本次累计"
    val (todayValue, todayUnit) = compactBytes(today?.total ?: totals.total)
    val (monthValue, monthUnit) = compactBytes(totals.monthTotal)

    Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.md)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)
        ) {
            StatCard(
                label = todayLabel,
                value = todayValue,
                unit = todayUnit,
                accent = MaterialTheme.colorScheme.primary,
                icon = Icons.Rounded.DataUsage,
                modifier = Modifier.weight(1f)
            )
            StatCard(
                label = "本月累计",
                value = monthValue,
                unit = monthUnit,
                accent = MaterialTheme.colorScheme.tertiary,
                icon = Icons.Rounded.CalendarMonth,
                modifier = Modifier.weight(1f)
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)
        ) {
            StatCard(
                label = "在线设备",
                value = state.onlineCount.toString(),
                unit = "台",
                accent = semantic.success,
                icon = Icons.Rounded.Devices,
                modifier = Modifier.weight(1f)
            )
            StatCard(
                label = "Clash 连接",
                value = state.health.clashConnections.toString(),
                unit = "条",
                accent = semantic.info,
                icon = Icons.Rounded.Link,
                modifier = Modifier.weight(1f)
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
                    .height(132.dp),
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
                        .height(132.dp)
                        .semantics { contentDescription = chartDesc }
                )
                Spacer(Modifier.height(PrismSpacing.sm))
                Row(Modifier.fillMaxWidth()) {
                    days.forEach { day ->
                        val active = day.day == selected?.day
                        Text(
                            text = day.dayLabel,
                            style = MaterialTheme.typography.labelSmall
                                .copy(fontSize = 10.sp)
                                .tabular(),
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
 * 柱体用品牌色竖向渐变（上实下淡），选中柱 100% 不透明，其余 50%；
 * 槽位底色始终绘制，因此「0 流量」的一天也能看出位置。
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
                    color = trackColor.copy(alpha = if (selected) 0.75f else 0.45f),
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
                    else -> 0.5f
                }
                drawRoundRect(
                    brush = Brush.verticalGradient(
                        colors = listOf(barColor, barColor.copy(alpha = 0.55f)),
                        startY = top,
                        endY = size.height
                    ),
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
    Surface(
        shape = RoundedCornerShape(PrismRadius.small),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = PrismSpacing.md, vertical = PrismSpacing.sm)
        ) {
            DetailCell("日期", day.dayLabel, Modifier.weight(1f))
            DetailCell("下载", fmtBytes(day.rx), Modifier.weight(1.3f))
            DetailCell("上传", fmtBytes(day.tx), Modifier.weight(1.3f))
            DetailCell("总量", fmtBytes(day.total), Modifier.weight(1.3f))
        }
    }
}

@Composable
private fun DetailCell(label: String, value: String, modifier: Modifier = Modifier) {
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
            style = MaterialTheme.typography.bodyMedium.tabular(),
            color = MaterialTheme.colorScheme.onSurface,
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
                HorizontalDivider(color = scheme.outlineVariant.copy(alpha = 0.4f))
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
                    .background(success.copy(alpha = 0.18f), CircleShape),
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
    if (onOpenNetwork != null) {
        SectionCard(
            title = "出口 / 节点",
            subtitle = subtitle,
            action = { ViewAllAction(onOpenNetwork) }
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
    val semantic = LocalPrismSemanticColors.current
    if (visible.isEmpty()) {
        Text(
            text = "面板尚未下发出口数据，稍后下拉刷新。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        return
    }
    visible.forEachIndexed { index, node ->
        ExitRow(
            name = exitName(node.name),
            total = node.total,
            share = node.total.toFloat() / total,
            color = if (node.name.trim().equals("DIRECT", ignoreCase = true)) {
                semantic.success
            } else {
                MaterialTheme.colorScheme.primary
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
                text = "${(share * 100f).roundToInt()}%",
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
        LinearProgressIndicator(
            progress = { share.coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp),
            color = color,
            trackColor = MaterialTheme.colorScheme.surfaceVariant
        )
    }
}

@Composable
private fun ViewAllAction(onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.heightIn(min = PrismSize.touchTarget)
    ) {
        Text(
            text = "查看全部",
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
            "无法获取记账数据，请检查面板与内核模块状态。"
        )

        else -> Triple(
            semantic.neutral,
            "记账未知",
            "面板尚未返回可信度字段，暂不做记账结论。"
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
            color = scheme.outlineVariant.copy(alpha = 0.45f)
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
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp).tabular(),
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
            text = "数据来自路由器只读面板",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(PrismSpacing.xs))
        Text(
            text = "每 ${ui.intervalSec} 秒自动刷新 · 下拉可立即更新",
            style = MaterialTheme.typography.labelSmall.tabular(),
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            textAlign = TextAlign.Center
        )
    }
}

/* ───────────────────────── 骨架屏 ───────────────────────── */

/** 首屏骨架：状态条 + 速率大卡 + 2×2 KPI + 趋势，与真实布局一一对应。 */
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
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.lg)
    ) {
        item { SkeletonBanner(alpha) }
        item { SkeletonHero(alpha) }
        item { SkeletonKpi(alpha) }
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

/** 骨架卡片外壳：与 [SectionCard] 相同的圆角 / 描边，内部留白一致。 */
@Composable
private fun SkeletonSurface(
    shape: Shape = RoundedCornerShape(PrismRadius.medium),
    content: @Composable ColumnScope.() -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f))
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
private fun SkeletonBanner(alpha: Float) {
    SkeletonSurface(shape = RoundedCornerShape(PrismRadius.large)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SkeletonBox(Modifier.width(72.dp).height(16.dp), alpha)
            Spacer(Modifier.weight(1f))
            SkeletonBox(Modifier.width(96.dp).height(12.dp), alpha)
        }
        Spacer(Modifier.height(PrismSpacing.lg))
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
            repeat(3) {
                SkeletonBox(
                    modifier = Modifier
                        .width(78.dp)
                        .height(24.dp),
                    alpha = alpha,
                    shape = RoundedCornerShape(PrismRadius.pill)
                )
            }
        }
    }
}

@Composable
private fun SkeletonHero(alpha: Float) {
    SkeletonSurface(shape = RoundedCornerShape(PrismRadius.large)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SkeletonRateColumn(alpha, Modifier.weight(1f))
            SkeletonRateColumn(alpha, Modifier.weight(1f))
        }
        Spacer(Modifier.height(PrismSpacing.lg))
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f))
        Spacer(Modifier.height(PrismSpacing.md))
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
            SkeletonBox(Modifier.width(110.dp).height(14.dp), alpha)
            SkeletonBox(Modifier.width(110.dp).height(14.dp), alpha)
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
        SkeletonBox(Modifier.width(72.dp).height(10.dp), alpha)
    }
}

@Composable
private fun SkeletonKpi(alpha: Float) {
    Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.md)) {
        repeat(2) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)
            ) {
                repeat(2) {
                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .height(96.dp),
                        shape = RoundedCornerShape(PrismRadius.medium),
                        color = MaterialTheme.colorScheme.surface,
                        tonalElevation = 0.dp,
                        border = BorderStroke(
                            1.dp,
                            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f)
                        )
                    ) {
                        Column(Modifier.padding(PrismSpacing.lg)) {
                            SkeletonBox(Modifier.fillMaxWidth(0.6f).height(12.dp), alpha)
                            Spacer(Modifier.height(PrismSpacing.md))
                            SkeletonBox(Modifier.fillMaxWidth(0.5f).height(26.dp), alpha)
                        }
                    }
                }
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
        Spacer(Modifier.height(PrismSpacing.lg))
        SkeletonBox(
            modifier = Modifier
                .fillMaxWidth()
                .height(132.dp),
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

/** 按数字长度给速率主数字降字号：390dp 宽度下两列并排不换行、不裁切。 */
private fun rateValueSize(text: String): TextUnit = when {
    text.length <= 4 -> 38.sp
    text.length == 5 -> 33.sp
    text.length == 6 -> 29.sp
    else -> 25.sp
}

/**
 * KPI 用的紧凑体积：拆成「数字 + 单位」两段。
 *
 * StatCard 的数值列在 2×2 网格里只有约 73dp 宽，三位整数带小数（如 102.4 GB）
 * 会把单位挤成省略号；这里在整数部分 ≥3 位时去掉小数（102 GB），
 * 既保住有效数字，又保证单位完整显示。
 */
private fun compactBytes(bytes: Long): Pair<String, String> {
    val text = fmtBytes(bytes)
    val separator = text.lastIndexOf(' ')
    if (separator <= 0) return text to ""
    var number = text.substring(0, separator)
    val unit = text.substring(separator + 1)
    if (number.contains('.') && number.substringBefore('.').length >= 3) {
        number = number.substringBefore('.')
    }
    return number to unit
}

/** 出口名：DIRECT 统一显示为「直连」，与其余节点名区分。 */
private fun exitName(name: String): String =
    if (name.trim().equals("DIRECT", ignoreCase = true)) "直连" else name
