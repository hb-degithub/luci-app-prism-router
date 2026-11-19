package io.prism.router.ui

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.NodeFreshness
import io.prism.router.data.NodeUsage
import io.prism.router.data.SubNode
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import java.util.Locale

/**
 * 节点 / AP 屏（只读）。
 *
 * 两个数据源：
 *  - `state.nodes`：出口节点（DIRECT / 代理组）的累计流量，按流量排序并展示占比；
 *  - `?what=nodes`：子节点 / AP 快照，带上报新鲜度（age_sec 0–300 秒在线）、设备数与流量。
 *
 * 子节点单独失败只影响本区块（显示原因 + 重试），不影响出口节点与主数据。
 */
@Composable
fun NodesScreen(ui: UiState, onRetryNodes: () -> Unit = {}) {
    val nodes = (ui.state?.nodes ?: emptyList()).sortedByDescending { it.total }
    val total = nodes.sumOf { it.total }
    val subs = ui.nodesList

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(top = 12.dp, bottom = 20.dp)
    ) {
        item { NodesHeader() }

        item {
            SectionTitle(
                title = "出口节点",
                detail = if (nodes.isEmpty()) null else "共 ${nodes.size} 个 · 合计 ${fmtBytes(total)}"
            )
        }
        if (nodes.isEmpty()) {
            item { NodesEmpty(loading = ui.loading) }
        } else {
            itemsIndexed(nodes) { index, node ->
                NodeCard(rank = index + 1, node = node, total = total)
            }
        }

        item {
            SubNodesHeader(
                count = subs.size,
                error = ui.nodesError,
                onRetry = onRetryNodes
            )
        }
        when {
            subs.isEmpty() && ui.nodesError != null -> item {
                SubNodesError(message = ui.nodesError, onRetry = onRetryNodes)
            }

            subs.isEmpty() -> item { SubNodesEmpty(loading = ui.loading) }

            else -> {
                itemsIndexed(subs) { _, sub -> SubNodeCard(sub) }
                /* 有旧数据但本轮刷新失败：列表照常展示，底下补一条可重试的提示。 */
                ui.nodesError?.let { message ->
                    item { NodesErrorBanner(message = message, onRetry = onRetryNodes) }
                }
            }
        }

        item { NodesNote() }
    }
}

@Composable
private fun NodesHeader() {
    Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Text("节点 / AP", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(
            "出口节点与子节点 / AP · 上报 5 分钟内视为在线",
            fontSize = 11.sp,
            color = SubText
        )
    }
}

@Composable
private fun SectionTitle(title: String, detail: String?) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        if (detail != null) {
            Text(detail, fontSize = 11.sp, color = SubText, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun NodeCard(rank: Int, node: NodeUsage, total: Long) {
    val isDirect = node.name.equals("DIRECT", true)
    val color = if (isDirect) Good else Brand
    val share = if (total > 0) (node.total.toFloat() / total).coerceIn(0f, 1f) else 0f

    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(26.dp).background(color.copy(alpha = 0.14f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Text("$rank", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = color)
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        if (isDirect) "${node.name}（直连）" else node.name,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        "↓ ${fmtBytes(node.rx)} · ↑ ${fmtBytes(node.tx)}",
                        fontSize = 11.sp,
                        color = SubText,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Spacer(Modifier.width(8.dp))
                Column(horizontalAlignment = Alignment.End) {
                    Text(fmtBytes(node.total), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        String.format(Locale.US, "%.1f%%", share * 100),
                        fontSize = 11.sp,
                        color = SubText
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(
                progress = { share },
                modifier = Modifier.fillMaxWidth().height(6.dp),
                color = color,
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )
        }
    }
}

/* ───────────────────────── 子节点 / AP ───────────────────────── */

@Composable
private fun SubNodesHeader(count: Int, error: String?, onRetry: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("子节点 / AP", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        Text(
            if (count > 0) "共 $count 个" else if (error != null) "获取失败" else "暂无上报",
            fontSize = 11.sp,
            color = if (error != null) Warn else SubText
        )
        TextButton(onClick = onRetry, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("刷新", fontSize = 12.sp)
        }
    }
}

@Composable
private fun SubNodeCard(sub: SubNode) {
    val color = subNodeFreshnessColor(sub.freshness)

    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier.size(30.dp).background(color.copy(alpha = 0.14f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Rounded.Wifi, contentDescription = null, tint = color, modifier = Modifier.size(17.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    sub.displayName,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    "${sub.freshnessText()} · ${sub.deviceCount} 台设备",
                    fontSize = 11.sp,
                    color = if (sub.freshness == NodeFreshness.ONLINE) SubText else color,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(fmtBytes(sub.total), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    "↓ ${fmtBytes(sub.rx)} · ↑ ${fmtBytes(sub.tx)}",
                    fontSize = 11.sp,
                    color = SubText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun SubNodesEmpty(loading: Boolean) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(
                if (loading) "正在读取子节点…" else "暂无子节点 / AP 上报",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "面板 ?what=nodes 返回空列表：可能还没有子节点 / AP 推送过快照，或该面板版本未启用节点上报。",
                fontSize = 11.sp,
                color = SubText
            )
        }
    }
}

@Composable
private fun SubNodesError(message: String, onRetry: () -> Unit) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("子节点 / AP 获取失败", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = onRetry, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text("重试", fontSize = 12.sp, color = Warn)
                }
            }
            Text(message, fontSize = 11.sp, color = Warn)
            Spacer(Modifier.height(4.dp))
            Text(
                "仅影响子节点 / AP 区块，出口节点与其它页面数据不受影响。",
                fontSize = 11.sp,
                color = SubText
            )
        }
    }
}

@Composable
private fun NodesErrorBanner(message: String, onRetry: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Warn.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            "刷新失败：$message",
            fontSize = 11.sp,
            color = Warn,
            modifier = Modifier.weight(1f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        TextButton(onClick = onRetry, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("重试", fontSize = 12.sp, color = Warn)
        }
    }
}

/* ───────────────────────── 占位 / 说明 ───────────────────────── */

@Composable
private fun NodesEmpty(loading: Boolean) {
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                Icons.Rounded.Hub,
                contentDescription = null,
                tint = SubText,
                modifier = Modifier.size(34.dp)
            )
            Spacer(Modifier.height(10.dp))
            Text(if (loading) "正在加载节点数据…" else "暂无出口节点数据", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(
                if (loading) {
                    "正在从路由器读取面板数据，请稍候。"
                } else {
                    "面板还没有返回 nodes 数据：可能尚未有代理出口流量，或接口未启用节点统计。"
                },
                fontSize = 11.sp,
                color = SubText,
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
private fun NodesNote() {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Text("数据说明", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                "出口节点来自 state.nodes（累计流量，按流量排序并展示占比）；" +
                    "子节点 / AP 来自 ?what=nodes，含上报新鲜度（0–300 秒在线）、设备数与流量。本屏只读。",
                fontSize = 11.sp,
                color = SubText
            )
        }
    }
}

/** 供拓扑屏复用的新鲜度色（与子节点卡保持一致）。 */
internal fun subNodeFreshnessColor(freshness: NodeFreshness): Color = when (freshness) {
    NodeFreshness.ONLINE -> Good
    NodeFreshness.STALE -> Warn
    NodeFreshness.UNKNOWN -> SubText
}
