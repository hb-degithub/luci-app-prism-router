package io.prism.router.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.prism.router.data.Device
import io.prism.router.data.NodeFreshness
import io.prism.router.data.NodeUsage
import io.prism.router.data.PanelState
import io.prism.router.data.SubNode
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock
import io.prism.router.data.fmtRateShort
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
import io.prism.router.ui.theme.PrismSpacing
import kotlinx.coroutines.delay
import java.util.Locale

/* ───────────────────────── 常量 ───────────────────────── */

/** 拓扑设备层最多画 5 台（与需求「在线设备前 5」一致）。 */
private const val TOPO_DEVICE_LIMIT = 5

/** 连接线宽度（1.5dp，深浅色下都足够细）。 */
private val LINK_WIDTH = 1.5.dp

/** 分支主干在内容区内的横向位置（左侧留白内）。 */
private val RAIL_X = 14.dp

/** 分支卡片相对主干缩进，留出连接线 + 横向短线的空间。 */
private val CARD_START = 30.dp

/** 网络页的两个子视图：拓扑图与节点列表。 */
private enum class NetworkTab(val label: String) {
    TOPOLOGY("拓扑"),
    NODES("节点")
}

/**
 * 网络页 = 拓扑 + 节点合并（第 4 个一级页签，只读）。
 *
 * 顶部大标题 / 副标题由本页的 [PrismScaffold] 提供（滚动收起），下面用 [Segmented]
 * 在「拓扑 / 节点」之间切换，两种视图共用同一个 [PullToRefreshBox]：
 * - 拓扑：互联网 → 出口 → 主路由 → 子节点 / AP → 设备的分层卡片，层间用 Canvas 连线；
 * - 节点：出口节点（rank / 流量 / 占比条）+ 子节点 / AP 列表（新鲜度 / 设备数 / 流量）。
 *
 * 数据来源：`state`（互联网 / 出口 / 主路由 / 设备）+ `?what=nodes`（子节点 / AP）。
 * 子节点单独失败只影响子节点区块，主数据继续展示；失败时给出重试入口。
 *
 * @param onRefresh 完整的「刷新」动作（state + 节点）；未接入时退回 [onRetryNodes]。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NetworkScreen(
    ui: UiState,
    onRetryNodes: () -> Unit = {},
    modifier: Modifier = Modifier,
    onRefresh: (() -> Unit)? = null
) {
    var tabIndex by rememberSaveable { mutableIntStateOf(0) }
    val tabs = NetworkTab.entries
    val tab = tabs[tabIndex.coerceIn(0, tabs.lastIndex)]
    val refresh = onRefresh ?: onRetryNodes

    /* 下拉刷新指示器只由手势触发，避免 15s 自动轮询反复闪动。 */
    var pulling by remember { mutableStateOf(false) }
    LaunchedEffect(ui.loading, ui.nodesAt, ui.updatedAt) {
        if (!ui.loading) pulling = false
    }
    /* 兜底：刷新被节流 / 无数据变化时，8 秒后收起指示器。 */
    LaunchedEffect(pulling) {
        if (pulling) {
            delay(8_000)
            pulling = false
        }
    }

    fun triggerRefresh() {
        pulling = true
        refresh()
    }

    PrismScaffold(
        title = "网络",
        subtitle = networkSubtitle(ui),
        modifier = modifier,
        actions = {
            PrismIconAction(
                icon = Icons.Rounded.Refresh,
                contentDescription = "刷新网络数据",
                onClick = {
                    pulling = false
                    refresh()
                }
            )
        }
    ) {
        Column(Modifier.fillMaxSize()) {
            Segmented(
                options = tabs,
                selected = tab,
                onSelect = { selected -> tabIndex = selected.ordinal },
                label = { it.label },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        start = PrismSpacing.lg,
                        end = PrismSpacing.lg,
                        top = PrismSpacing.md,
                        bottom = PrismSpacing.sm
                    )
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                PullToRefreshBox(
                    isRefreshing = pulling,
                    onRefresh = { triggerRefresh() },
                    modifier = Modifier.fillMaxSize()
                ) {
                    when (tab) {
                        NetworkTab.TOPOLOGY -> TopologyContent(
                            ui = ui,
                            onRetryNodes = onRetryNodes,
                            onRefresh = refresh
                        )

                        NetworkTab.NODES -> NodesContent(
                            ui = ui,
                            onRetryNodes = onRetryNodes,
                            onRefresh = refresh
                        )
                    }
                }
            }
        }
    }
}

/** 顶栏副标题：N 个出口 · M 个子节点（首次连接时给出状态文案）。 */
private fun networkSubtitle(ui: UiState): String {
    val exits = ui.state?.nodes?.count { it.total > 0 && !it.name.equals("DIRECT", true) } ?: 0
    val subs = ui.nodesList.size
    return if (ui.state == null && ui.loading) {
        "正在连接面板…"
    } else {
        "$exits 个出口 · $subs 个子节点"
    }
}

/* ───────────────────────── 拓扑视图 ───────────────────────── */

/**
 * 分层拓扑：互联网 → 出口 → 主路由 → 子节点 / AP → 设备。
 *
 * 卡片之间用 [LinkConnector] / [GroupConnector] 的 Canvas 连线连接；子节点与设备
 * 挂在同一条左侧分支主干（rail）上，390dp 宽度下不会横向溢出。
 */
@Composable
private fun TopologyContent(
    ui: UiState,
    onRetryNodes: () -> Unit,
    onRefresh: () -> Unit
) {
    val state = ui.state
    val subs = ui.nodesList

    if (state == null) {
        val initialLoading = ui.error == null && (ui.loading || ui.nodesAt == 0L)
        when {
            initialLoading -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(PrismSpacing.lg)
            ) {
                SkeletonList(rows = 5)
            }

            ui.error != null -> ErrorState(
                msg = redact(ui.error, ui.token),
                title = "拓扑加载失败",
                onRetry = onRefresh
            )

            else -> EmptyState(
                title = "暂无拓扑数据",
                desc = "先在「设置」里填写面板地址，连上路由器后这里会显示互联网、出口、主路由与子节点的分层关系。",
                icon = Icons.Rounded.AccountTree
            )
        }
        return
    }

    /* 出口节点：state.nodes 已按流量降序，取最大的非 DIRECT。 */
    val exit = remember(state) {
        state.nodes.firstOrNull { !it.name.equals("DIRECT", true) && it.total > 0 }
    }
    val nodeTotal = remember(state) { state.nodes.sumOf { it.total } }
    /* 在线设备：最近 10 分钟有上报或仍有速率；只画前 5 台。 */
    val devices = remember(state) {
        val nowSec = System.currentTimeMillis() / 1000
        state.devices
            .filter { isDeviceOnline(it, nowSec) }
            .sortedByDescending { it.total }
            .take(TOPO_DEVICE_LIMIT)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = PrismSpacing.lg,
            end = PrismSpacing.lg,
            top = PrismSpacing.sm,
            bottom = PrismSpacing.xl
        )
    ) {
        item { InternetCard(state) }

        if (exit != null) {
            item { LinkConnector() }
            item { ExitNodeCard(exit = exit, nodeTotal = nodeTotal) }
        }

        item { LinkConnector() }
        item { RouterCard(state) }

        if (subs.isNotEmpty() || devices.isNotEmpty()) {
            item { GroupConnector() }

            if (subs.isNotEmpty()) {
                item { RailHeader(title = "子节点 / AP", detail = "${subs.size} 个") }
                itemsIndexed(subs) { index, sub ->
                    RailItem(isLast = devices.isEmpty() && index == subs.lastIndex) {
                        SubNodeCard(sub)
                    }
                }
            }
            if (devices.isNotEmpty()) {
                item { RailHeader(title = "在网设备", detail = "前 ${devices.size} 台") }
                itemsIndexed(devices) { index, device ->
                    RailItem(isLast = index == devices.lastIndex) {
                        DeviceCard(device)
                    }
                }
            }
        }

        item { TopologyFooter(ui = ui, exitMissing = exit == null, onRetryNodes = onRetryNodes) }
    }
}

@Composable
private fun InternetCard(state: PanelState) {
    SectionCard(title = "互联网", subtitle = "WAN 总出口") {
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
            MetricColumn(
                label = "下行速率",
                value = "${fmtRateShort(state.totals.rxRate)} Mbps",
                modifier = Modifier.weight(1f),
                valueColor = MaterialTheme.colorScheme.primary
            )
            MetricColumn(
                label = "上行速率",
                value = "${fmtRateShort(state.totals.txRate)} Mbps",
                modifier = Modifier.weight(1f),
                valueColor = MaterialTheme.colorScheme.tertiary
            )
        }
    }
}

@Composable
private fun ExitNodeCard(exit: NodeUsage, nodeTotal: Long) {
    val share = if (nodeTotal > 0) (exit.total.toFloat() / nodeTotal).coerceIn(0f, 1f) else 0f
    SectionCard(
        title = "出口 · ${exit.name}",
        subtitle = String.format(Locale.US, "占节点流量 %.1f%%", share * 100f)
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
            MetricColumn("下行", fmtBytes(exit.rx), Modifier.weight(1f), MaterialTheme.colorScheme.primary)
            MetricColumn("上行", fmtBytes(exit.tx), Modifier.weight(1f), MaterialTheme.colorScheme.tertiary)
            MetricColumn("合计", fmtBytes(exit.total), Modifier.weight(1f))
        }
        Spacer(Modifier.height(PrismSpacing.md))
        LinearProgressIndicator(
            progress = { share },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(PrismRadius.pill)),
            color = MaterialTheme.colorScheme.primary,
            trackColor = MaterialTheme.colorScheme.surfaceVariant
        )
    }
}

@Composable
private fun RouterCard(state: PanelState) {
    SectionCard(
        title = "主路由 · 本机",
        subtitle = "在线 ${state.onlineCount} 台 · Clash 连接 ${state.health.clashConnections}"
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)) {
            MetricColumn("本月流量", fmtBytes(state.totals.monthTotal), Modifier.weight(1f))
            MetricColumn("在线设备", "${state.onlineCount} 台", Modifier.weight(1f))
            MetricColumn("快照时间", fmtClock(state.ts), Modifier.weight(1f))
        }
    }
}

@Composable
private fun SubNodeCard(sub: SubNode) {
    val tint = freshnessColor(sub.freshness)
    SectionCard(
        title = sub.displayName,
        subtitle = "接入设备 ${sub.deviceCount} 台",
        action = { Pill(text = sub.freshnessText(), color = tint) }
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)) {
            MetricColumn("累计流量", fmtBytes(sub.total), Modifier.weight(1f))
            MetricColumn("下行", fmtBytes(sub.rx), Modifier.weight(1f), MaterialTheme.colorScheme.primary)
            MetricColumn("上行", fmtBytes(sub.tx), Modifier.weight(1f), MaterialTheme.colorScheme.tertiary)
        }
    }
}

@Composable
private fun DeviceCard(device: Device) {
    SectionCard(
        title = device.name,
        subtitle = "${linkLabel(device.link)} · ${device.ip.ifBlank { device.mac }}"
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
            MetricColumn(
                label = "下行速率",
                value = "↓ ${fmtRateShort(device.rxRate)} Mbps",
                modifier = Modifier.weight(1f),
                valueColor = MaterialTheme.colorScheme.primary
            )
            MetricColumn(
                label = "上行速率",
                value = "↑ ${fmtRateShort(device.txRate)} Mbps",
                modifier = Modifier.weight(1f),
                valueColor = MaterialTheme.colorScheme.tertiary
            )
        }
    }
}

@Composable
private fun TopologyFooter(ui: UiState, exitMissing: Boolean, onRetryNodes: () -> Unit) {
    val semantic = LocalPrismSemanticColors.current
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = PrismSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
    ) {
        if (ui.nodesError != null) {
            InlineWarning(
                message = "子节点刷新失败：${redact(ui.nodesError, ui.token)}",
                onRetry = onRetryNodes
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "只读视图 · 更新于 ${fmtClock(ui.updatedAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f)
            )
            if (ui.offline) {
                Pill("离线缓存", color = semantic.warning)
            }
        }
        Text(
            text = "出口取流量最大的非 DIRECT 节点；子节点 / AP 来自 ?what=nodes（上报 5 分钟内视为在线）；" +
                "设备层只画最近 10 分钟活跃设备的前 $TOPO_DEVICE_LIMIT 台。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (exitMissing) {
            Text(
                text = "当前没有可用的非 DIRECT 出口节点，已跳过出口层。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/* ───────────────────────── 节点视图 ───────────────────────── */

/**
 * 节点列表：出口节点（rank + 流量 + 占比条）与子节点 / AP（新鲜度 Pill + 设备数 + 流量）。
 *
 * 子节点接口失败时不再伪造 0 流量，直接展示 [ErrorState] 与重试；若已有旧列表，
 * 则保留列表并在底部补一条可重试的失败提示。
 */
@Composable
private fun NodesContent(
    ui: UiState,
    onRetryNodes: () -> Unit,
    onRefresh: () -> Unit
) {
    val nodes = remember(ui.state) {
        ui.state?.nodes.orEmpty().sortedByDescending { it.total }
    }
    val total = nodes.sumOf { it.total }
    val subs = ui.nodesList
    val initialLoading = ui.error == null && (ui.loading || ui.nodesAt == 0L)

    if (ui.state == null) {
        when {
            initialLoading -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(PrismSpacing.lg)
            ) {
                SkeletonList(rows = 5)
            }

            ui.error != null -> ErrorState(
                msg = redact(ui.error, ui.token),
                title = "节点数据加载失败",
                onRetry = onRefresh
            )

            else -> EmptyState(
                title = "暂无节点数据",
                desc = "面板没有返回出口节点统计。先在「设置」里确认面板地址，或稍后下拉刷新。",
                icon = Icons.Rounded.Hub
            )
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = PrismSpacing.lg,
            end = PrismSpacing.lg,
            top = PrismSpacing.lg,
            bottom = PrismSpacing.xl
        ),
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.lg)
    ) {
        item {
            SectionCard(
                title = "出口节点",
                subtitle = if (nodes.isEmpty()) "尚无出口流量" else "共 ${nodes.size} 个 · 合计 ${fmtBytes(total)}"
            ) {
                if (nodes.isEmpty()) {
                    EmptyState(
                        title = "暂无出口节点",
                        desc = "面板还没有返回出口节点流量：可能尚未产生代理流量，或接口未启用节点统计。",
                        icon = Icons.Rounded.Cloud
                    )
                } else {
                    nodes.forEachIndexed { index, node ->
                        NodeRow(rank = index + 1, node = node, total = total)
                        if (index != nodes.lastIndex) {
                            HorizontalDivider(
                                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                            )
                        }
                    }
                }
            }
        }

        item {
            SectionCard(
                title = "子节点 / AP",
                subtitle = when {
                    subs.isNotEmpty() -> "共 ${subs.size} 个 · 上报 5 分钟内视为在线"
                    ui.nodesError != null -> "获取失败"
                    else -> "暂无上报"
                },
                action = {
                    TextButton(
                        onClick = onRetryNodes,
                        modifier = Modifier.heightIn(min = 48.dp)
                    ) {
                        Text("刷新", style = MaterialTheme.typography.labelSmall)
                    }
                }
            ) {
                when {
                    subs.isEmpty() && ui.nodesError != null -> ErrorState(
                        msg = redact(ui.nodesError, ui.token),
                        title = "子节点加载失败",
                        onRetry = onRetryNodes
                    )

                    subs.isEmpty() && (ui.loading || ui.nodesAt == 0L) -> SkeletonList(
                        rows = 2,
                        showHeader = false
                    )

                    subs.isEmpty() -> EmptyState(
                        title = "暂无子节点 / AP",
                        desc = "面板 ?what=nodes 返回空列表：可能还没有子节点推送过快照，或该面板版本未启用节点上报。",
                        icon = Icons.Rounded.Hub
                    )

                    else -> {
                        subs.forEachIndexed { index, sub ->
                            SubNodeRow(sub)
                            if (index != subs.lastIndex) {
                                HorizontalDivider(
                                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                                )
                            }
                        }
                        if (ui.nodesError != null) {
                            Spacer(Modifier.height(PrismSpacing.sm))
                            InlineWarning(
                                message = "刷新失败：${redact(ui.nodesError, ui.token)}",
                                onRetry = onRetryNodes
                            )
                        }
                    }
                }
            }
        }

        item { NodesFooter(ui) }
    }
}

@Composable
private fun NodeRow(rank: Int, node: NodeUsage, total: Long) {
    val isDirect = node.name.equals("DIRECT", true)
    val semantic = LocalPrismSemanticColors.current
    val accent = if (isDirect) semantic.success else MaterialTheme.colorScheme.primary
    val share = if (total > 0) (node.total.toFloat() / total).coerceIn(0f, 1f) else 0f

    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = PrismSpacing.md)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .background(accent.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "$rank",
                    style = MaterialTheme.typography.labelSmall,
                    color = accent
                )
            }
            Spacer(Modifier.width(PrismSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = if (isDirect) "${node.name}（直连）" else node.name,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = "↓ ${fmtBytes(node.rx)} · ↑ ${fmtBytes(node.tx)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.width(PrismSpacing.sm))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = fmtBytes(node.total),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1
                )
                Text(
                    text = String.format(Locale.US, "%.1f%%", share * 100f),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
            }
        }
        Spacer(Modifier.height(PrismSpacing.sm))
        LinearProgressIndicator(
            progress = { share },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(PrismRadius.pill)),
            color = accent,
            trackColor = MaterialTheme.colorScheme.surfaceVariant
        )
    }
}

@Composable
private fun SubNodeRow(sub: SubNode) {
    val tint = freshnessColor(sub.freshness)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(vertical = PrismSpacing.sm),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(tint.copy(alpha = 0.12f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Rounded.Wifi,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(17.dp)
            )
        }
        Spacer(Modifier.width(PrismSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = sub.displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = "${sub.deviceCount} 台设备 · ↓ ${fmtBytes(sub.rx)} · ↑ ${fmtBytes(sub.tx)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        Pill(text = sub.freshnessText(), color = tint)
    }
}

@Composable
private fun NodesFooter(ui: UiState) {
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)
    ) {
        Text(
            text = "出口节点来自 state.nodes（累计流量，按流量降序并展示占比）；" +
                "子节点 / AP 来自 ?what=nodes（0–300 秒在线）。本页只读，不会修改路由器配置。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = if (ui.offline) "离线缓存 · 更新于 ${fmtClock(ui.updatedAt)}" else "更新于 ${fmtClock(ui.updatedAt)}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/* ───────────────────────── 小部件 ───────────────────────── */

/** 单个指标列：标签 + 主数值（可带强调色）。 */
@Composable
private fun MetricColumn(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    valueColor: Color? = null
) {
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
            style = MaterialTheme.typography.titleMedium,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/** 可重试的行内警告条（保持列表数据不丢失）。 */
@Composable
private fun InlineWarning(message: String, onRetry: (() -> Unit)? = null) {
    val warning = LocalPrismSemanticColors.current.warning
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        color = warning.copy(alpha = 0.12f),
        contentColor = warning
    ) {
        Row(
            modifier = Modifier.padding(start = PrismSpacing.md, end = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.labelSmall,
                color = warning,
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = PrismSpacing.sm),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (onRetry != null) {
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.heightIn(min = 48.dp),
                    contentPadding = PaddingValues(horizontal = PrismSpacing.sm)
                ) {
                    Text("重试", style = MaterialTheme.typography.labelSmall, color = warning)
                }
            }
        }
    }
}

/* ───────────────────────── Canvas 连接线 ───────────────────────── */

/** 主干直连：层与层之间的竖线 + 节点圆点。 */
@Composable
private fun LinkConnector() {
    val lineColor = MaterialTheme.colorScheme.primary
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(32.dp)
    ) {
        val cx = size.width / 2f
        val stroke = LINK_WIDTH.toPx()
        drawLine(
            color = lineColor.copy(alpha = 0.45f),
            start = Offset(cx, 0f),
            end = Offset(cx, size.height),
            strokeWidth = stroke,
            cap = StrokeCap.Round
        )
        drawCircle(lineColor.copy(alpha = 0.75f), radius = 2.5.dp.toPx(), center = Offset(cx, size.height / 2f))
    }
}

/** 主干 → 分支 rail：从中心竖线拐到左侧主干的曲线（次要色）。 */
@Composable
private fun GroupConnector() {
    val lineColor = MaterialTheme.colorScheme.secondary
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(36.dp)
    ) {
        val cx = size.width / 2f
        val railX = RAIL_X.toPx()
        val path = Path().apply {
            moveTo(cx, 0f)
            cubicTo(cx, size.height * 0.55f, railX, size.height * 0.55f, railX, size.height)
        }
        drawPath(
            path = path,
            color = lineColor.copy(alpha = 0.6f),
            style = Stroke(width = LINK_WIDTH.toPx(), cap = StrokeCap.Round)
        )
    }
}

/** 分支上的分组小标题（与卡片同一条 rail，不额外占卡片高度）。 */
@Composable
private fun RailHeader(title: String, detail: String) {
    RailItem(isLast = false) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(vertical = PrismSpacing.xs),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = detail,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * 分支条目：左侧 Canvas 画竖线（条目首尾相接形成连续 rail）+ 指向卡片的横向短线 + 圆点，
 * 右侧放一张卡片。竖线覆盖整个条目（含底部留白），相邻条目之间不会断线。
 */
@Composable
private fun RailItem(isLast: Boolean, content: @Composable () -> Unit) {
    val lineColor = MaterialTheme.colorScheme.secondary
    Box(Modifier.fillMaxWidth()) {
        Canvas(Modifier.matchParentSize()) {
            val railX = RAIL_X.toPx()
            val stroke = LINK_WIDTH.toPx()
            val midY = size.height / 2f
            val tickEnd = CARD_START.toPx() - 2.dp.toPx()
            drawLine(
                color = lineColor.copy(alpha = 0.45f),
                start = Offset(railX, 0f),
                end = Offset(railX, if (isLast) midY else size.height),
                strokeWidth = stroke
            )
            drawLine(
                color = lineColor.copy(alpha = 0.45f),
                start = Offset(railX, midY),
                end = Offset(tickEnd, midY),
                strokeWidth = stroke
            )
            drawCircle(lineColor.copy(alpha = 0.8f), radius = 2.5.dp.toPx(), center = Offset(railX, midY))
        }
        Box(
            Modifier
                .padding(start = CARD_START, bottom = PrismSpacing.sm)
        ) {
            content()
        }
    }
}

/* ───────────────────────── 工具函数 ───────────────────────── */

@Composable
private fun freshnessColor(freshness: NodeFreshness): Color {
    val semantic = LocalPrismSemanticColors.current
    return when (freshness) {
        NodeFreshness.ONLINE -> semantic.success
        NodeFreshness.STALE -> semantic.warning
        NodeFreshness.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

private fun isDeviceOnline(device: Device, nowSec: Long): Boolean {
    if (device.lastSeen > 0 && nowSec - device.lastSeen <= 600) return true
    return device.rxRate + device.txRate > 0
}

private fun linkLabel(link: String): String = when (link.lowercase()) {
    "wifi", "wireless" -> "无线"
    "wired", "lan", "ethernet" -> "有线"
    else -> "接入未知"
}

/** 错误文案脱敏：URL 里的 token 参数与令牌原文都不能出现在界面上。 */
private fun redact(message: String, token: String): String {
    var out = message.replace(Regex("(?i)token=[^&\\s]*"), "token=***")
    val secret = token.trim()
    if (secret.length >= 4) out = out.replace(secret, "***")
    return out
}
