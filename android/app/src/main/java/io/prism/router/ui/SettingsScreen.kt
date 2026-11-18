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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.prism.router.data.UiState

@Composable
fun SettingsScreen(
    ui: UiState,
    onSave: (String, String, Int) -> Unit,
    onTest: (String, String, (String) -> Unit) -> Unit,
    onRefresh: () -> Unit
) {
    var base by rememberSaveable { mutableStateOf(ui.baseUrl) }
    var token by rememberSaveable { mutableStateOf(ui.token) }
    var interval by rememberSaveable { mutableStateOf(ui.intervalSec.toString()) }
    var testResult by rememberSaveable { mutableStateOf<String?>(null) }
    var showToken by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("设置", fontSize = 22.sp, fontWeight = FontWeight.Bold)

        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("服务器", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(
                    value = base,
                    onValueChange = { base = it },
                    label = { Text("面板地址") },
                    placeholder = { Text("http://192.168.100.1:8099") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("访问令牌（可留空）") },
                    singleLine = true,
                    visualTransformation = if (showToken) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedButton(onClick = { showToken = !showToken }) {
                    Text(if (showToken) "隐藏令牌" else "显示令牌")
                }
                OutlinedTextField(
                    value = interval,
                    onValueChange = { interval = it.filter { c -> c.isDigit() } },
                    label = { Text("刷新间隔（秒，5–300）") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth()
                )
                Row {
                    Button(onClick = {
                        onSave(base, token, interval.toIntOrNull() ?: 15)
                        testResult = "已保存"
                    }) { Text("保存") }
                    Spacer(Modifier.width(12.dp))
                    OutlinedButton(onClick = {
                        onTest(base, token) { testResult = it }
                    }) { Text("测试连接") }
                    Spacer(Modifier.width(12.dp))
                    OutlinedButton(onClick = onRefresh) { Text("刷新") }
                }
                testResult?.let {
                    Text(it, fontSize = 12.sp, color = if (it.startsWith("连接成功")) Good else MaterialTheme.colorScheme.error)
                }
            }
        }

        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp)) {
                Text("当前状态", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text("服务：${if (ui.state?.running == true) "运行中" else "未运行"}", fontSize = 12.sp)
                Text("记账：${ui.state?.health?.confidence ?: "unknown"}", fontSize = 12.sp)
                Text("数据时间：${io.prism.router.data.fmtClock(ui.state?.ts ?: 0)}", fontSize = 12.sp)
                Text("设备：${ui.state?.devices?.size ?: 0} 台（在线 ${ui.state?.onlineCount ?: 0}）", fontSize = 12.sp)
                ui.error?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
            }
        }

        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp)) {
                Text("关于", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text("棱镜路由 · Android 原生客户端 v1.0.0", fontSize = 12.sp)
                Text("数据来自路由器的独立面板只读 API（/cgi-bin/panel-api）。", fontSize = 12.sp, color = SubText)
                Text("本应用只读展示，不修改路由器配置。", fontSize = 12.sp, color = SubText)
            }
        }
    }
}
