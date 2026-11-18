package io.prism.router.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.AppUsage
import io.prism.router.data.UiState
import io.prism.router.data.fmtBytes

@Composable
fun AppsScreen(ui: UiState) {
    val apps = ui.state?.apps ?: emptyList()
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        Text("应用流量 Top", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("共 ${apps.size} 个域名", fontSize = 12.sp, color = SubText)
        Spacer(Modifier.height(10.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(apps) { a -> AppCard(a) }
            if (apps.isEmpty()) {
                item { Text("暂无应用数据", fontSize = 13.sp, color = SubText, modifier = Modifier.padding(16.dp)) }
            }
        }
    }
}

@Composable
private fun AppCard(a: AppUsage) {
    Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(a.host, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1)
                Text(fmtBytes(a.total), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(4.dp))
            Row {
                Text(if (a.chain.equals("DIRECT", true)) "直连" else a.chain, fontSize = 11.sp, color = Good)
                Spacer(Modifier.width(12.dp))
                Text("↓ ${fmtBytes(a.rx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(8.dp))
                Text("↑ ${fmtBytes(a.tx)}", fontSize = 11.sp, color = SubText)
                Spacer(Modifier.width(8.dp))
                Text("${a.devices} 台设备", fontSize = 11.sp, color = SubText)
            }
        }
    }
}
