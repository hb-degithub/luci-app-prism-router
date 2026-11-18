package io.prism.router.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.Device
import io.prism.router.data.UiState
import io.prism.router.data.fmtAgo
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtClock
import io.prism.router.data.fmtRate

private enum class DeviceFilter(val label: String) { ALL("全部"), ONLINE("在线"), OFFLINE("离线") }

private enum class DeviceSort(val label: String) { TOTAL("累计"), RATE("速率"), NAME("名称") }

/** 在线口径：有过活跃时间，且 10 分钟内上报过。与 PanelState.onlineCount 保持一致。 */
private const val ONLINE_WINDOW_SEC = 600L

private fun Device.isOnline(nowSec: Long): Boolean =
    lastSeen > 0 && nowSec - lastSeen <= ONLINE_WINDOW_SEC

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(ui: UiState) {
    val devices = ui.state?.devices ?: emptyList()
    var query by rememberSaveable { mutableStateOf("") }
    var filterIndex by rememberSaveable { mutableIntStateOf(0) }
    var sortIndex by rememberSaveable { mutableIntStateOf(0) }
    var selectedMac by rememberSaveable { mutableStateOf<String?>(null) }

    val filters = DeviceFilter.values()
    val sorts = DeviceSort.values()
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

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("搜索名称 / MAC / IP") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(10.dp))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            filters.forEachIndexed { index, item ->
                SegmentedButton(
                    selected = filter == item,
                    onClick = { filterIndex = index },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = filters.size)
                ) { Text(item.label) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("排序", fontSize = 11.sp, color = SubText)
            sorts.forEachIndexed { index, item ->
                FilterChip(
                    selected = sort == item,
                    onClick = { sortIndex = index },
                    label = { Text(item.label, fontSize = 11.sp) }
                )
            }
        }
        Text(
            "共 ${devices.size} 台 · 在线 $onlineCount · 当前 ${sorted.size} 台",
            fontSize = 12.sp,
            color = SubText,
            modifier = Modifier.padding(vertical = 6.dp)
        )
        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(bottom = 16.dp)
        ) {
            items(sorted) { d ->
                DeviceCard(d, online = d.isOnline(nowSec)) { selectedMac = d.mac }
            }
            if (sorted.isEmpty()) {
                item {
                    Text(
                        if (q.isEmpty()) "没有匹配的设备" else "没有匹配「$q」的设备",
                        fontSize = 13.sp,
                        color = SubText,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }

    if (selected != null) {
        DeviceDetailSheet(
            device = selected,
            online = selected.isOnline(nowSec),
            onDismiss = { selectedMac = null }
        )
    }
}

@Composable
private fun DeviceCard(d: Device, online: Boolean, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(38.dp).background(linkColor(d.link).copy(alpha = 0.15f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Text(d.name.take(1).uppercase(), color = linkColor(d.link), fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(d.name, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    "${linkLabel(d.link)} · ${d.ip.ifBlank { d.mac }}",
                    fontSize = 11.sp,
                    color = SubText,
                    maxLines = 1
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(6.dp).background(
                            if (online) Good else SubText.copy(alpha = 0.4f),
                            CircleShape
                        )
                    )
                    Spacer(Modifier.width(4.dp))
                    Text("上次活跃 ${fmtAgo(d.lastSeen)}", fontSize = 10.sp, color = SubText)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("↓ ${fmtRate(d.rxRate)}", fontSize = 11.sp, color = SubText)
                Text("↑ ${fmtRate(d.txRate)}", fontSize = 11.sp, color = SubText)
                Text(fmtBytes(d.total), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeviceDetailSheet(device: Device, online: Boolean, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboard = LocalClipboardManager.current
    var copied by remember(device.mac) { mutableStateOf(false) }
    val accent = linkColor(device.link)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .verticalScroll(rememberScrollState())
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(44.dp).background(accent.copy(alpha = 0.15f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        device.name.take(1).uppercase(),
                        color = accent,
                        fontWeight = FontWeight.Bold,
                        fontSize = 18.sp
                    )
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(device.name, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 2)
                    Text(
                        "${linkLabel(device.link)} · ${if (online) "在线" else "离线"}",
                        fontSize = 12.sp,
                        color = if (online) Good else SubText
                    )
                }
            }

            Spacer(Modifier.height(14.dp))
            DetailCard {
                InfoRow("名称", device.name)
                InfoRow("MAC", device.mac.ifBlank { "—" })
                InfoRow("IP", device.ip.ifBlank { "—" })
                InfoRow("接入", linkLabel(device.link))
                InfoRow(
                    "上次活跃",
                    if (device.lastSeen > 0) "${fmtAgo(device.lastSeen)} · ${fmtClock(device.lastSeen)}" else "从未"
                )
            }

            Spacer(Modifier.height(10.dp))
            DetailCard {
                Text("实时速率", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Row {
                    RateColumn("下载", fmtRate(device.rxRate), Brand, Modifier.weight(1f))
                    RateColumn("上传", fmtRate(device.txRate), Warn, Modifier.weight(1f))
                }
            }

            Spacer(Modifier.height(10.dp))
            DetailCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("累计", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text(fmtBytes(device.total), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "直连 ↓ ${fmtBytes(device.directRx)} · ↑ ${fmtBytes(device.directTx)}",
                    fontSize = 12.sp,
                    color = SubText
                )
                Text(
                    "代理 ↓ ${fmtBytes(device.proxyRx)} · ↑ ${fmtBytes(device.proxyTx)}",
                    fontSize = 12.sp,
                    color = SubText
                )
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("本月", fontSize = 12.sp, color = SubText, modifier = Modifier.weight(1f))
                    Text(fmtBytes(device.monthTotal), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            Spacer(Modifier.height(10.dp))
            DetailCard {
                Text("应用明细", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text("该设备暂无应用明细（数据层待扩展）", fontSize = 12.sp, color = Warn)
                Text(
                    "当前接口的 apps 为全局面板聚合，无法按设备拆分；数据层接入 per-device 明细后将在此展示。",
                    fontSize = 11.sp,
                    color = SubText
                )
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    clipboard.setText(AnnotatedString(device.mac))
                    copied = true
                },
                enabled = device.mac.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (copied) "已复制 MAC" else "复制 MAC")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun DetailCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), content = content)
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, fontSize = 12.sp, color = SubText, modifier = Modifier.width(72.dp))
        Text(value, fontSize = 13.sp, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun RateColumn(label: String, value: String, color: Color, modifier: Modifier = Modifier) {
    Column(modifier.padding(top = 6.dp)) {
        Text(label, fontSize = 11.sp, color = SubText)
        Text(value, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = color)
    }
}

private fun linkColor(link: String): Color = when (link) {
    "wifi" -> Color(0xFF7B1FA2)
    "wired" -> Color(0xFF00838F)
    else -> SubText
}

private fun linkLabel(link: String): String = when (link) {
    "wifi" -> "无线"
    "wired" -> "有线"
    else -> "未知"
}
