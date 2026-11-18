package io.prism.router.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.Health
import io.prism.router.data.PanelState
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtRate
import io.prism.router.data.fmtRateShort

@Composable
fun OverviewScreen(ui: UiState, onRefresh: () -> Unit) {
    val s = ui.state
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 16.dp)
    ) {
        item { StatusHeader(ui, onRefresh) }
        item { RateCards(s) }
        item { KpiRow(s) }
        item { SparklineCard(ui) }
        item { NodesCard(s) }
        item { HealthCard(s) }
    }
}

@Composable
private fun StatusHeader(ui: UiState, onRefresh: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text("棱镜路由", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(
                when {
                    ui.loading && ui.state == null -> "正在连接…"
                    ui.error != null -> ui.error
                    ui.state != null -> "更新于 ${io.prism.router.data.fmtClock(ui.updatedAt)}"
                    else -> "等待数据"
                },
                fontSize = 12.sp,
                color = if (ui.error != null) MaterialTheme.colorScheme.error else SubText
            )
        }
        if (ui.loading) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        TextButton(onClick = onRefresh) { Text("刷新") }
    }
}

@Composable
private fun RateCards(s: PanelState?) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        RateCard("下载", s?.totals?.rxRate ?: 0, Brand, Modifier.weight(1f))
        RateCard("上传", s?.totals?.txRate ?: 0, Warn, Modifier.weight(1f))
    }
}

@Composable
private fun RateCard(label: String, rate: Long, color: Color, modifier: Modifier = Modifier) {
    Card(modifier, shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Text(label, fontSize = 12.sp, color = SubText)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    fmtRateShort(rate),
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                    color = color
                )
                Spacer(Modifier.width(4.dp))
                Text("Mbps", fontSize = 12.sp, color = SubText, modifier = Modifier.padding(bottom = 5.dp))
            }
            Text(fmtRate(rate), fontSize = 11.sp, color = SubText)
        }
    }
}

@Composable
private fun KpiRow(s: PanelState?) {
    val t = s?.totals
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Kpi("今日", fmtBytes(t?.total ?: 0), Modifier.weight(1f))
        Kpi("本月", fmtBytes(t?.monthTotal ?: 0), Modifier.weight(1f))
        Kpi("在线", "${s?.onlineCount ?: 0} 台", Modifier.weight(1f))
        Kpi("连接", "${s?.health?.clashConnections ?: 0}", Modifier.weight(1f))
    }
}

@Composable
private fun Kpi(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier, shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(label, fontSize = 11.sp, color = SubText)
            Text(value, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun SparklineCard(ui: UiState) {
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Text("实时速率", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text("最近 24 次采样", fontSize = 11.sp, color = SubText)
            Spacer(Modifier.height(10.dp))
            Sparkline(ui.rxHistory, ui.txHistory, Modifier.fillMaxWidth().height(72.dp))
            Spacer(Modifier.height(8.dp))
            Row {
                Legend(Brand, "下载")
                Spacer(Modifier.width(16.dp))
                Legend(Warn, "上传")
            }
        }
    }
}

@Composable
private fun Legend(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(label, fontSize = 11.sp, color = SubText)
    }
}

@Composable
private fun Sparkline(rx: List<Long>, tx: List<Long>, modifier: Modifier = Modifier) {
    val rxColor = Brand
    val txColor = Warn
    Canvas(modifier) {
        if (rx.size < 2 && tx.size < 2) {
            drawLine(
                color = rxColor.copy(alpha = 0.25f),
                start = Offset(0f, size.height / 2),
                end = Offset(size.width, size.height / 2),
                strokeWidth = 2f
            )
            return@Canvas
        }
        val max = maxOf(rx.maxOrNull() ?: 0L, tx.maxOrNull() ?: 0L, 1L).toFloat()
        fun drawSeries(values: List<Long>, color: Color) {
            if (values.size < 2) return
            val path = Path()
            values.forEachIndexed { i, v ->
                val x = size.width * i / (values.size - 1)
                val y = size.height - (v / max) * size.height
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(path, color = color, style = Stroke(width = 2.5f, cap = StrokeCap.Round))
        }
        drawSeries(rx, rxColor)
        drawSeries(tx, txColor)
    }
}

@Composable
private fun NodesCard(s: PanelState?) {
    val nodes = s?.nodes ?: emptyList()
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Text("节点 / 出口", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            if (nodes.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("暂无出口数据", fontSize = 12.sp, color = SubText)
            }
            val total = nodes.sumOf { it.total }.coerceAtLeast(1)
            nodes.take(5).forEach { n ->
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(n.name, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text(fmtBytes(n.total), fontSize = 12.sp, color = SubText)
                }
                Spacer(Modifier.height(4.dp))
                LinearProgressIndicator(
                    progress = { n.total.toFloat() / total },
                    modifier = Modifier.fillMaxWidth().height(4.dp),
                    color = if (n.name.equals("DIRECT", true)) Good else Brand,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant
                )
            }
        }
    }
}

@Composable
private fun HealthCard(s: PanelState?) {
    val h: Health? = s?.health
    val (color, label) = when (h?.confidence) {
        "exact" -> Good to "记账精确"
        "degraded" -> Warn to "记账降级"
        "unavailable" -> MaterialTheme.colorScheme.error to "记账不可用"
        else -> SubText to "记账状态未知"
    }
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(color, CircleShape))
                Spacer(Modifier.width(8.dp))
                Text("健康与告警", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text(label, fontSize = 11.sp, color = color)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "Clash ${s?.clash ?: "?"} · conntrack ${s?.conntrack ?: "?"}",
                fontSize = 11.sp,
                color = SubText
            )
            val reasons = h?.reasons ?: emptyList()
            if (reasons.isEmpty()) {
                Text("未发现异常", fontSize = 12.sp, color = Good, modifier = Modifier.padding(top = 6.dp))
            } else {
                reasons.take(6).forEach { r ->
                    Text("· $r", fontSize = 12.sp, color = Warn, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
    }
}
