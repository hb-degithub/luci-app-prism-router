package io.prism.router.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.Alert
import io.prism.router.data.AlertSeverity
import io.prism.router.data.AlertTarget
import io.prism.router.data.DailyUsage
import io.prism.router.data.Health
import io.prism.router.data.PanelState
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtRate
import io.prism.router.data.fmtRateShort
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 概览页（兼容旧调用：只传刷新回调）。
 * 新的接线可再传 [onOpenDevices] 让设备类告警可点击跳转「设备」页签。
 */
@Composable
fun OverviewScreen(ui: UiState, onRefresh: () -> Unit) {
    OverviewScreen(ui, onRefresh, null)
}

/**
 * 概览页。
 *
 * [onOpenDevices] 是可选回调：由 App.kt 传入后，设备类告警可点击跳转「设备」页签；
 * 未接入时（默认 null）告警只做展示，不影响其余功能。
 *
 * 支持下拉刷新（Compose 原生 PullToRefresh），手动下拉与刷新按钮都会触发 [onRefresh]
 * （ViewModel 的 refresh() 会顺带强制重取 history）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OverviewScreen(
    ui: UiState,
    onRefresh: () -> Unit,
    onOpenDevices: (() -> Unit)? = null
) {
    /* 仅手动下拉时展示指示器，避免 15s 自动轮询让顶部指示器反复闪动。 */
    var pulling by remember { mutableStateOf(false) }
    LaunchedEffect(ui.loading) {
        if (!ui.loading) pulling = false
    }

    val s = ui.state
    PullToRefreshBox(
        isRefreshing = pulling,
        onRefresh = {
            pulling = true
            onRefresh()
        },
        modifier = Modifier.fillMaxSize()
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 16.dp)
        ) {
            item { StatusHeader(ui, onRefresh) }
            item { RateCards(s) }
            item { KpiRow(s) }
            item { TrendCard(ui) }
            item { SparklineCard(ui) }
            item { AlertsCard(ui, onOpenDevices) }
            item { NodesCard(s) }
            item { HealthCard(s) }
        }
    }
}

@Composable
private fun StatusHeader(ui: UiState, onRefresh: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) {
                Text("棱镜路由", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(
                    when {
                        ui.offline -> "网络不可用 · 展示离线缓存"
                        ui.loading && ui.state == null -> "正在连接…"
                        ui.error != null -> ui.error
                        ui.state != null -> "更新于 ${fmtClock(ui.updatedAt)}"
                        else -> "等待数据"
                    },
                    fontSize = 12.sp,
                    color = when {
                        ui.offline -> Warn
                        ui.error != null && !ui.loading -> MaterialTheme.colorScheme.error
                        else -> SubText
                    }
                )
            }
            if (ui.loading) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            TextButton(onClick = onRefresh) { Text("刷新") }
        }
        if (ui.offline) {
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Warn.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
                    .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "离线数据 · 更新于 ${fmtHm(ui.offlineAt)}",
                    fontSize = 12.sp,
                    color = Warn,
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = onRefresh, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text("重试", fontSize = 12.sp, color = Warn)
                }
            }
        }
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

/* ───────────────────────── 近 7 天趋势 ───────────────────────── */

@Composable
private fun TrendCard(ui: UiState) {
    val days = ui.history
    var selectedDay by remember { mutableStateOf<String?>(null) }
    val selected = days.firstOrNull { it.day == selectedDay }

    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("近 7 天", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    Text("每日流量 · 点击柱子查看当天总量", fontSize = 11.sp, color = SubText)
                }
                if (days.isNotEmpty()) {
                    Text(fmtBytes(days.sumOf { it.total }), fontSize = 12.sp, color = SubText)
                }
            }
            Spacer(Modifier.height(10.dp))

            if (days.isEmpty()) {
                Box(
                    Modifier.fillMaxWidth().height(96.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        if (ui.historyError != null) "历史数据暂不可用" else "暂无历史数据",
                        fontSize = 12.sp,
                        color = SubText
                    )
                }
                return@Column
            }

            DailyBars(
                days = days,
                selectedDay = selected?.day,
                onSelect = { day -> selectedDay = day },
                modifier = Modifier.fillMaxWidth().height(112.dp)
            )
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth()) {
                days.forEach { day ->
                    val active = day.day == selected?.day
                    Column(
                        Modifier.weight(1f),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            day.dayLabel,
                            fontSize = 9.sp,
                            color = if (active) MaterialTheme.colorScheme.primary else SubText,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            textAlign = TextAlign.Center,
                            maxLines = 1
                        )
                        Text(
                            fmtBytes(day.total),
                            fontSize = 8.sp,
                            color = if (active) MaterialTheme.colorScheme.primary else SubText,
                            textAlign = TextAlign.Center,
                            maxLines = 1
                        )
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            if (selected != null) {
                Text(
                    "${selected.day} 总量 ${fmtBytes(selected.total)}（↓ ${fmtBytes(selected.rx)} · ↑ ${fmtBytes(selected.tx)}）",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium
                )
            } else {
                Text(
                    "近 ${days.size} 天合计 ${fmtBytes(days.sumOf { it.total })} · 点击柱子查看当日总量",
                    fontSize = 12.sp,
                    color = SubText
                )
            }
        }
    }
}

@Composable
private fun DailyBars(
    days: List<DailyUsage>,
    selectedDay: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val barColor = Brand
    val selectedColor = MaterialTheme.colorScheme.primary
    val trackColor = MaterialTheme.colorScheme.surfaceVariant
    val max = maxOf(days.maxOfOrNull { it.total } ?: 0L, 1L).toFloat()

    Canvas(
        modifier.pointerInput(days) {
            detectTapGestures { offset ->
                if (days.isEmpty()) return@detectTapGestures
                val slot = size.width.toFloat() / days.size
                if (slot <= 0f) return@detectTapGestures
                val index = (offset.x / slot).toInt().coerceIn(0, days.size - 1)
                onSelect(days[index].day)
            }
        }
    ) {
        if (days.isEmpty()) return@Canvas
        val slot = size.width / days.size
        val gap = 6.dp.toPx().coerceAtMost(slot / 3f)
        val barWidth = (slot - gap).coerceAtLeast(2f)
        val radius = CornerRadius(4f, 4f)

        days.forEachIndexed { index, day ->
            val left = slot * index + gap / 2f
            drawRoundRect(
                color = trackColor.copy(alpha = 0.6f),
                topLeft = Offset(left, 0f),
                size = Size(barWidth, size.height),
                cornerRadius = radius
            )
            if (day.total <= 0L) return@forEachIndexed
            val barHeight = (day.total.toFloat() / max * size.height).coerceAtLeast(3f)
            drawRoundRect(
                color = if (day.day == selectedDay) selectedColor else barColor.copy(alpha = 0.78f),
                topLeft = Offset(left, size.height - barHeight),
                size = Size(barWidth, barHeight),
                cornerRadius = radius
            )
        }
    }
}

/* ───────────────────────── 实时速率 ───────────────────────── */

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

/* ───────────────────────── 告警中心 ───────────────────────── */

@Composable
private fun AlertsCard(ui: UiState, onOpenDevices: (() -> Unit)?) {
    val alerts = ui.alerts.take(6)
    val openDevices = onOpenDevices
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("告警", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text(
                    if (alerts.isEmpty()) "正常" else "${ui.alerts.size} 条",
                    fontSize = 11.sp,
                    color = if (alerts.isEmpty()) Good else SubText
                )
            }
            if (alerts.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("未发现异常", fontSize = 12.sp, color = Good)
                return@Column
            }
            alerts.forEach { alert ->
                AlertRow(alert, openDevices)
            }
            if (ui.alerts.size > alerts.size) {
                Spacer(Modifier.height(4.dp))
                Text("还有 ${ui.alerts.size - alerts.size} 条未显示", fontSize = 11.sp, color = SubText)
            }
        }
    }
}

@Composable
private fun AlertRow(alert: Alert, openDevices: (() -> Unit)?) {
    val color = when (alert.severity) {
        AlertSeverity.DANGER -> MaterialTheme.colorScheme.error
        AlertSeverity.WARN -> Warn
        AlertSeverity.INFO -> SubText
    }
    var action: (() -> Unit)? = null
    if (alert.target == AlertTarget.DEVICES && openDevices != null) {
        val callback: () -> Unit = openDevices
        action = callback
    }
    val rowModifier = Modifier
        .fillMaxWidth()
        .then(if (action != null) Modifier.clickable { action?.invoke() } else Modifier)
        .padding(vertical = 6.dp)

    Row(rowModifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(alert.title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = color)
            Text(alert.detail, fontSize = 11.sp, color = SubText)
        }
        if (action != null) {
            Spacer(Modifier.width(8.dp))
            Text("设备 ›", fontSize = 11.sp, color = color)
        }
    }
}

/* ───────────────────────── 节点 / 健康 ───────────────────────── */

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
                "Clash ${s?.clash?.ifBlank { "?" } ?: "?"} · conntrack ${s?.conntrack?.ifBlank { "?" } ?: "?"}",
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

/** 离线提示用的时:分格式。 */
private fun fmtHm(ts: Long): String {
    if (ts <= 0) return "—"
    return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
}

/** 与 Format.kt 的 fmtClock 保持同一时区/格式（HH:mm:ss）。 */
private fun fmtClock(ts: Long): String {
    if (ts <= 0) return "—"
    return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ts))
}
