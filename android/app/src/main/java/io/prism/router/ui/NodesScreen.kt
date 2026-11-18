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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.NodeUsage
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import java.util.Locale

/**
 * 节点 / AP 屏。
 *
 * 数据层目前只提供 state.nodes（出口节点：DIRECT / 代理组名，rx/tx），
 * 没有子节点、AP、上报时间字段。本屏按出口节点真实数据渲染，并显式标注数据边界。
 */
@Composable
fun NodesScreen(ui: UiState) {
    val nodes = (ui.state?.nodes ?: emptyList()).sortedByDescending { it.total }
    val total = nodes.sumOf { it.total }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        Text("节点 / AP", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("仅出口节点，子节点待数据层扩展", fontSize = 11.sp, color = Warn)
        Spacer(Modifier.height(10.dp))

        if (nodes.isEmpty()) {
            NodesEmpty(loading = ui.loading)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("共 ${nodes.size} 个出口节点", fontSize = 12.sp, color = SubText, modifier = Modifier.weight(1f))
                Text("合计 ${fmtBytes(total)}", fontSize = 12.sp, color = SubText)
            }
            Spacer(Modifier.height(8.dp))
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(bottom = 16.dp)
            ) {
                itemsIndexed(nodes) { index, node ->
                    NodeCard(rank = index + 1, node = node, total = total)
                }
                item { NodesNote() }
            }
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
                        color = SubText
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

@Composable
private fun NodesEmpty(loading: Boolean) {
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 28.dp),
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
            Spacer(Modifier.height(4.dp))
            Text(
                "子节点 / AP、上报时间与连接数需数据层扩展后展示。",
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
                "当前接口只提供出口节点（DIRECT / 代理组）的累计流量，因此本屏按流量排序并展示占比；子节点、AP 及其上报时间待数据层扩展。",
                fontSize = 11.sp,
                color = SubText
            )
        }
    }
}
