package io.prism.router.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Lan
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Router
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.Device
import io.prism.router.data.NodeUsage
import io.prism.router.data.PanelState
import io.prism.router.data.SubNode
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock
import io.prism.router.data.fmtRateShort
import java.util.Locale

/** 拓扑屏设备层最多画 5 台（需求：在线设备前 5）。 */
private const val TOPO_DEVICE_LIMIT = 5

/** 连接线宽度（需求 1.5dp）。 */
private val LINK_WIDTH = 1.5.dp

/** 分支主干在内容区内的横向位置（左侧留白内）。 */
private val RAIL_X = 14.dp

/** 分支卡片相对主干缩进，留出连接线 + 横向短线的空间。 */
private val CARD_START = 30.dp

/**
 * 拓扑屏（第 5 个页签，只读）。
 *
 * 纵向分层：互联网 → 出口节点 → 主路由 → 子节点 / AP → 在网设备（前 5 台）。
 * 层间连接线由 [Canvas] 绘制（1.5dp，主色主干 / 次要色分支），卡片本身是普通 Compose 组件；
 * 子节点 / AP 与设备各自挂在同一条分支主干（rail）上，保证 390px 宽度下不横向溢出。
 *
 * 数据来源：`state`（互联网 / 出口 / 主路由 / 设备）+ `?what=nodes`（子节点 / AP）。
 * 没有子节点时整层跳过；完全没有面板数据时显示空态。
 */
@Composable
fun TopologyScreen(ui: UiState, onRetryNodes: () -> Unit = {}) {
    val state = ui.state
    val subs = ui.nodesList

    /* 出口节点：state.nodes 已按流量降序，取最大的非 DIRECT。 */
    val exit = remember(state) {
        state?.nodes?.firstOrNull { !it.name.equals("DIRECT", true) && it.total > 0 }
    }
    val nodeTotal = remember(state) { state?.nodes?.sumOf { it.total } ?: 0L }

    /* 在线设备：最近 10 分钟有上报或仍有速率；只画前 5 台。 */
    val devices = remember(state) {
        val nowSec = System.currentTimeMillis() / 1000
        (state?.devices ?: emptyList())
            .filter { isDeviceOnline(it, nowSec) }
            .sortedByDescending { it.total }
            .take(TOPO_DEVICE_LIMIT)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        contentPadding = PaddingValues(top = 12.dp, bottom = 20.dp)
    ) {
        item { TopologyHeader(ui) }

        if (state == null) {
            item { TopologyEmpty(ui) }
        } else {
            item { InternetLayer(state) }
            if (exit != null) {
                item { LinkConnector() }
                item { ExitLayer(exit, nodeTotal) }
            }
            item { LinkConnector() }
            item { RouterLayer(state) }

            if (subs.isNotEmpty() || devices.isNotEmpty()) {
                item { GroupConnector() }

                if (subs.isNotEmpty()) {
                    item { RailHeader(title = "子节点 / AP", detail = "${subs.size} 个") }
                    itemsIndexed(subs) { index, sub ->
                        RailItem(isLast = devices.isEmpty() && index == subs.lastIndex) {
                            SubNodeLayerCard(sub)
                        }
                    }
                }
                if (devices.isNotEmpty()) {
                    item { RailHeader(title = "在网设备", detail = "前 ${devices.size} 台") }
                    itemsIndexed(devices) { index, device ->
                        RailItem(isLast = index == devices.lastIndex) {
                            DeviceLayerCard(device)
                        }
                    }
                }
            }

            item {
                TopologyNote(
                    exitMissing = exit == null,
                    hasSubs = subs.isNotEmpty(),
                    hasDevices = devices.isNotEmpty(),
                    nodesError = ui.nodesError,
                    onRetryNodes = onRetryNodes
                )
            }
        }
    }
}

/* ───────────────────────── 页头 / 空态 / 说明 ───────────────────────── */

@Composable
private fun TopologyHeader(ui: UiState) {
    Column(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("网络拓扑", fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("只读", fontSize = 11.sp, color = SubText)
        }
        Text(
            "自上而下：互联网 → 出口 → 主路由 → 子节点 / AP → 设备",
            fontSize = 11.sp,
            color = SubText,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Text(
            when {
                ui.state == null -> if (ui.loading) "正在读取面板数据…" else (ui.error ?: "等待数据")
                ui.offline -> "离线缓存 · 更新于 ${fmtClock(ui.updatedAt)}"
                else -> "更新于 ${fmtClock(ui.updatedAt)}"
            },
            fontSize = 11.sp,
            color = if (ui.offline || ui.error != null) Warn else SubText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun TopologyEmpty(ui: UiState) {
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                Icons.Rounded.AccountTree,
                contentDescription = null,
                tint = SubText,
                modifier = Modifier.size(36.dp)
            )
            Spacer(Modifier.height(10.dp))
            Text(
                if (ui.loading) "正在加载拓扑数据…" else "暂无拓扑数据",
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    ui.loading -> "正在从路由器读取面板数据，请稍候。"
                    ui.error != null -> ui.error ?: ""
                    else -> "先在「设置」里填好面板地址，连上路由器后这里会显示互联网、出口、主路由与子节点的分层关系。"
                },
                fontSize = 11.sp,
                color = SubText,
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
private fun TopologyNote(
    exitMissing: Boolean,
    hasSubs: Boolean,
    hasDevices: Boolean,
    nodesError: String?,
    onRetryNodes: () -> Unit
) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Text("拓扑说明", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                "出口层取 state.nodes 中流量最大的非 DIRECT 节点；子节点 / AP 来自 ?what=nodes" +
                    "（上报 0–300 秒视为在线）；设备层只画在线设备的前 $TOPO_DEVICE_LIMIT 台。",
                fontSize = 11.sp,
                color = SubText
            )
            if (exitMissing) {
                Text("未发现非 DIRECT 出口节点，已跳过出口层。", fontSize = 11.sp, color = SubText)
            }
            if (!hasSubs) {
                Text("没有子节点 / AP 上报，已跳过该层。", fontSize = 11.sp, color = SubText)
            }
            if (!hasDevices) {
                Text("没有在线设备，已跳过设备层。", fontSize = 11.sp, color = SubText)
            }
            if (nodesError != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "子节点数据获取失败：$nodesError",
                        fontSize = 11.sp,
                        color = Warn,
                        modifier = Modifier.weight(1f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    TextButton(onClick = onRetryNodes, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Text("重试", fontSize = 12.sp, color = Warn)
                    }
                }
            }
        }
    }
}

/* ───────────────────────── 层卡片 ───────────────────────── */

@Composable
private fun InternetLayer(state: PanelState) {
    LayerCard(
        icon = Icons.Rounded.Public,
        iconTint = Brand,
        title = "互联网",
        subtitle = "WAN 总出口",
        value = "↓ ${fmtRateShort(state.totals.rxRate)} Mbps",
        valueHint = "↑ ${fmtRateShort(state.totals.txRate)} Mbps"
    )
}

@Composable
private fun ExitLayer(exit: NodeUsage, nodeTotal: Long) {
    val percent = if (nodeTotal > 0) exit.total.toDouble() * 100.0 / nodeTotal else 0.0
    LayerCard(
        icon = Icons.Rounded.Cloud,
        iconTint = Brand,
        title = "出口 · ${exit.name}",
        subtitle = "↓ ${fmtBytes(exit.rx)} · ↑ ${fmtBytes(exit.tx)}",
        value = fmtBytes(exit.total),
        valueHint = String.format(Locale.US, "占节点流量 %.1f%%", percent)
    )
}

@Composable
private fun RouterLayer(state: PanelState) {
    LayerCard(
        icon = Icons.Rounded.Router,
        iconTint = Good,
        title = "主路由 · 本机",
        subtitle = "在线 ${state.onlineCount} 台 · 连接 ${state.health.clashConnections}",
        value = fmtBytes(state.totals.monthTotal),
        valueHint = "本月流量"
    )
}

@Composable
private fun SubNodeLayerCard(sub: SubNode) {
    LayerCard(
        icon = Icons.Rounded.Hub,
        iconTint = subNodeFreshnessColor(sub.freshness),
        title = sub.displayName,
        subtitle = "${sub.freshnessText()} · ${sub.deviceCount} 台设备",
        value = fmtBytes(sub.total),
        valueHint = "↓${fmtBytes(sub.rx)} ↑${fmtBytes(sub.tx)}"
    )
}

@Composable
private fun DeviceLayerCard(device: Device) {
    LayerCard(
        icon = deviceIcon(device.link),
        iconTint = Brand,
        title = device.name,
        subtitle = "${linkLabel(device.link)} · ${device.ip.ifBlank { device.mac }}",
        value = "↓ ${fmtRateShort(device.rxRate)} Mbps",
        valueHint = "↑ ${fmtRateShort(device.txRate)} Mbps"
    )
}

/**
 * 单层卡片：左侧图标 + 名称/副标题，右侧关键数字（两行）。
 * 右侧列限宽 120dp，390px 屏下中间文字自动省略，绝不横向溢出。
 */
@Composable
private fun LayerCard(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    subtitle: String,
    value: String,
    valueHint: String
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier.size(34.dp).background(iconTint.copy(alpha = 0.14f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    subtitle,
                    fontSize = 11.sp,
                    color = SubText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.widthIn(max = 120.dp), horizontalAlignment = Alignment.End) {
                Text(
                    value,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    valueHint,
                    fontSize = 11.sp,
                    color = SubText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

/* ───────────────────────── Canvas 连接线 ───────────────────────── */

/** 主干直连：层与层之间的竖线 + 节点圆点。 */
@Composable
private fun LinkConnector() {
    val lineColor = MaterialTheme.colorScheme.primary
    Canvas(Modifier.fillMaxWidth().height(26.dp)) {
        val cx = size.width / 2f
        val stroke = LINK_WIDTH.toPx()
        drawLine(
            color = lineColor.copy(alpha = 0.55f),
            start = Offset(cx, 0f),
            end = Offset(cx, size.height),
            strokeWidth = stroke,
            cap = StrokeCap.Round
        )
        drawCircle(lineColor, radius = 2.5.dp.toPx(), center = Offset(cx, size.height / 2f))
    }
}

/** 主干 → 分支 rail：从中心竖线拐到左侧主干的曲线（次要色）。 */
@Composable
private fun GroupConnector() {
    val lineColor = MaterialTheme.colorScheme.secondary
    Canvas(Modifier.fillMaxWidth().height(24.dp)) {
        val cx = size.width / 2f
        val railX = RAIL_X.toPx()
        val path = Path().apply {
            moveTo(cx, 0f)
            cubicTo(cx, size.height * 0.55f, railX, size.height * 0.55f, railX, size.height)
        }
        drawPath(
            path = path,
            color = lineColor.copy(alpha = 0.7f),
            style = Stroke(width = LINK_WIDTH.toPx(), cap = StrokeCap.Round)
        )
    }
}

/** 分支上的分组小标题（与卡片同一条 rail，不占卡片高度）。 */
@Composable
private fun RailHeader(title: String, detail: String) {
    RailItem(isLast = false) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
            Text(detail, fontSize = 11.sp, color = SubText)
        }
    }
}

/**
 * 分支条目：左侧 Canvas 画一条竖线（首尾相接形成连续的 rail）+ 指向卡片的横向短线 + 圆点，
 * 右侧放一张卡片。竖线用 `matchParentSize` 覆盖含底部留白的整个条目，
 * 因此相邻条目之间不会出现断线。
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
                color = lineColor.copy(alpha = 0.55f),
                start = Offset(railX, 0f),
                end = Offset(railX, if (isLast) midY else size.height),
                strokeWidth = stroke
            )
            drawLine(
                color = lineColor.copy(alpha = 0.55f),
                start = Offset(railX, midY),
                end = Offset(tickEnd, midY),
                strokeWidth = stroke
            )
            drawCircle(lineColor, radius = 2.5.dp.toPx(), center = Offset(railX, midY))
        }
        Box(Modifier.padding(start = CARD_START, bottom = 8.dp)) {
            content()
        }
    }
}

/* ───────────────────────── 小工具 ───────────────────────── */

private fun isDeviceOnline(device: Device, nowSec: Long): Boolean {
    if (device.lastSeen > 0 && nowSec - device.lastSeen <= 600) return true
    return device.rxRate + device.txRate > 0
}

private fun deviceIcon(link: String): ImageVector = when (link.lowercase()) {
    "wifi", "wireless" -> Icons.Rounded.Wifi
    "wired", "lan", "ethernet" -> Icons.Rounded.Lan
    else -> Icons.Rounded.Devices
}

private fun linkLabel(link: String): String = when (link.lowercase()) {
    "wifi", "wireless" -> "无线"
    "wired", "lan", "ethernet" -> "有线"
    else -> "接入未知"
}
