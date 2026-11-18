package io.prism.router.ui

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.Device
import io.prism.router.data.UiState
import io.prism.router.data.fmtAgo
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtRate

@Composable
fun DevicesScreen(ui: UiState) {
    val devices = ui.state?.devices ?: emptyList()
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim().lowercase()
    val filtered = if (q.isEmpty()) devices else devices.filter {
        it.name.lowercase().contains(q) || it.mac.lowercase().contains(q) || it.ip.contains(q)
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("搜索名称 / MAC / IP") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "共 ${devices.size} 台 · 在线 ${ui.state?.onlineCount ?: 0}",
            fontSize = 12.sp,
            color = SubText
        )
        Spacer(Modifier.height(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(filtered) { d -> DeviceCard(d) }
            if (filtered.isEmpty()) {
                item { Text("没有匹配的设备", fontSize = 13.sp, color = SubText, modifier = Modifier.padding(16.dp)) }
            }
        }
    }
}

@Composable
private fun DeviceCard(d: Device) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
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
                Text("上次活跃 ${fmtAgo(d.lastSeen)}", fontSize = 10.sp, color = SubText)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("↓ ${fmtRate(d.rxRate)}", fontSize = 11.sp, color = SubText)
                Text("↑ ${fmtRate(d.txRate)}", fontSize = 11.sp, color = SubText)
                Text(fmtBytes(d.total), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
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
