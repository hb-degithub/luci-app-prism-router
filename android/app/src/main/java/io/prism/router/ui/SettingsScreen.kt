package io.prism.router.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.prism.router.data.MAX_SERVERS
import io.prism.router.data.MainViewModel
import io.prism.router.data.PanelClient
import io.prism.router.data.ServerProfile
import io.prism.router.data.UiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/* 诊断阈值（与 Web 诊断中心 / SPEC 保持一致） */
private const val DIAG_FRESH_OK_SEC = 90L
private const val DIAG_FRESH_WARN_SEC = 300L
private const val DIAG_POLL_OK_MS = 500L
private const val DIAG_POLL_WARN_MS = 1500L
/* 记账原因只展示前 3 条，避免长列表把卡片撑长。 */
private const val DIAG_REASON_LIMIT = 3

/** 单项诊断结论：绿 / 橙 / 红 / 灰。 */
private enum class DiagLevel { OK, WARN, FAIL, UNKNOWN }

/** 设置页诊断卡的一项：名称 + 状态点 + 值/说明（可附带 reasons 明细）。 */
private data class DiagItem(
    val name: String,
    val level: DiagLevel,
    val detail: String,
    val reasons: List<String> = emptyList()
)

@Composable
fun SettingsScreen(
    ui: UiState,
    onSave: (String, String, Int) -> Unit,
    onTest: (String, String, (String) -> Unit) -> Unit,
    onRefresh: () -> Unit
) {
    /*
     * 多路由器的增删切换都在 ViewModel；调用方（App.kt）不在本次改动范围，只传了
     * onSave / onTest / onRefresh，所以这里取 Activity 作用域的同一个 MainViewModel
     * （MainActivity 用 by viewModels() 创建），仅用于地址列表的增删切换。
     */
    val vm: MainViewModel = viewModel()

    var base by rememberSaveable { mutableStateOf(ui.baseUrl) }
    var token by rememberSaveable { mutableStateOf(ui.token) }
    var interval by rememberSaveable { mutableStateOf(ui.intervalSec.toString()) }
    var testResult by rememberSaveable { mutableStateOf<String?>(null) }
    var showToken by remember { mutableStateOf(false) }
    /* 「添加服务器」表单与操作反馈。 */
    var showAdd by rememberSaveable { mutableStateOf(false) }
    var addName by rememberSaveable { mutableStateOf("") }
    var addUrl by rememberSaveable { mutableStateOf("") }
    var addToken by rememberSaveable { mutableStateOf("") }
    var serverMsg by rememberSaveable { mutableStateOf<String?>(null) }
    var serverMsgError by rememberSaveable { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<Int?>(null) }

    /* 切换当前服务器后，把输入框同步到新的地址；手动编辑时 ui 不变，不会被覆盖。 */
    LaunchedEffect(ui.baseUrl, ui.token) {
        if (base != ui.baseUrl) base = ui.baseUrl
        if (token != ui.token) token = ui.token
    }

    /* 诊断：status 只在点「刷新诊断」时读取一次，失败只影响「版本与服务」一项。 */
    val client = remember { PanelClient() }
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<JSONObject?>(null) }
    var statusError by remember { mutableStateOf<String?>(null) }
    var statusAt by remember { mutableStateOf(0L) }
    var diagLoading by remember { mutableStateOf(false) }

    fun runDiagnostics() {
        if (diagLoading) return
        diagLoading = true
        /* 主数据刷新交给 ViewModel 的协程；status 自己另起 IO 请求，二者都不阻塞界面。 */
        onRefresh()
        val baseUrl = ui.baseUrl
        val secret = ui.token
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { client.fetchStatus(baseUrl, secret) }
            }
            result.onSuccess {
                status = it
                statusError = null
                statusAt = System.currentTimeMillis()
            }.onFailure {
                status = null
                statusError = redact(it.message ?: it.javaClass.simpleName, secret)
                statusAt = System.currentTimeMillis()
            }
            diagLoading = false
        }
    }

    val diagItems = buildDiagnostics(ui, status, statusError, System.currentTimeMillis() / 1000L)
    val okCount = diagItems.count { it.level == DiagLevel.OK }
    val warnCount = diagItems.count { it.level == DiagLevel.WARN }
    val failCount = diagItems.count { it.level == DiagLevel.FAIL }
    val unknownCount = diagItems.count { it.level == DiagLevel.UNKNOWN }
    val issueCount = warnCount + failCount + unknownCount

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        /* 页面标题由外层 PrismScaffold 提供，这里不再重复渲染「设置」大标题。 */
        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("服务器", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "当前：${vm.activeServer?.displayName ?: "未配置"} · 共 ${ui.servers.size} 个地址",
                    fontSize = 11.sp,
                    color = SubText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
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
                    /* 连接失败信息里可能带 URL，展示前统一去掉 token。 */
                    val shown = redact(it, ui.token)
                    Text(shown, fontSize = 12.sp, color = if (shown.startsWith("连接成功")) Good else MaterialTheme.colorScheme.error)
                }
            }
        }

        /* 多路由器：地址列表（切换 / 删除）+ 添加表单，最多 MAX_SERVERS 条。 */
        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "多路由器",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f)
                    )
                    Text("${ui.servers.size} / $MAX_SERVERS", fontSize = 11.sp, color = SubText)
                }
                Text(
                    "点任一地址即切换；切换会停止并重启轮询，重新拉取该路由器的数据。",
                    fontSize = 11.sp,
                    color = SubText
                )
                ui.servers.forEachIndexed { index, server ->
                    ServerRow(
                        server = server,
                        active = index == ui.activeIndex,
                        canDelete = ui.servers.size > 1,
                        onSelect = {
                            if (index != ui.activeIndex) {
                                vm.selectServer(index)
                                serverMsg = "已切换到 ${server.displayName}"
                                serverMsgError = false
                            }
                        },
                        onDelete = { pendingDelete = index }
                    )
                }
                Spacer(Modifier.height(2.dp))
                if (showAdd) {
                    AddServerForm(
                        name = addName,
                        url = addUrl,
                        token = addToken,
                        showToken = showToken,
                        onName = { addName = it },
                        onUrl = { addUrl = it },
                        onToken = { addToken = it },
                        onCancel = { showAdd = false; serverMsg = null },
                        onAdd = {
                            val error = vm.addServer(addName, addUrl, addToken)
                            if (error == null) {
                                serverMsg = "已添加 ${addName.ifBlank { ServerProfile.hostOf(addUrl) }}"
                                serverMsgError = false
                                addName = ""
                                addUrl = ""
                                addToken = ""
                                showAdd = false
                            } else {
                                serverMsg = error
                                serverMsgError = true
                            }
                        }
                    )
                } else if (ui.servers.size < MAX_SERVERS) {
                    OutlinedButton(onClick = { showAdd = true; serverMsg = null }) { Text("添加服务器") }
                } else {
                    Text("已达 $MAX_SERVERS 条上限，删除一条后可继续添加。", fontSize = 11.sp, color = SubText)
                }
                serverMsg?.let { message ->
                    Text(
                        message,
                        fontSize = 12.sp,
                        color = if (serverMsgError) MaterialTheme.colorScheme.error else Good
                    )
                }
            }
        }

        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp)) {
                Text("当前状态", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text("服务器：${vm.activeServer?.displayName ?: "—"}", fontSize = 12.sp)
                Text("服务：${if (ui.state?.running == true) "运行中" else "未运行"}", fontSize = 12.sp)
                Text("记账：${ui.state?.health?.confidence ?: "unknown"}", fontSize = 12.sp)
                Text("数据时间：${io.prism.router.data.fmtClock(ui.state?.ts ?: 0)}", fontSize = 12.sp)
                Text("设备：${ui.state?.devices?.size ?: 0} 台（在线 ${ui.state?.onlineCount ?: 0}）", fontSize = 12.sp)
                ui.error?.let { Text(redact(it, ui.token), fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
            }
        }

        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("诊断", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text("只读自检", fontSize = 11.sp, color = SubText)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = { runDiagnostics() }, enabled = !diagLoading) {
                        Text(if (diagLoading) "检查中…" else "刷新诊断")
                    }
                    Spacer(Modifier.width(10.dp))
                    Text(
                        when {
                            diagLoading -> "正在读取状态…"
                            statusAt > 0L -> "状态读取于 ${fmtClockSec(statusAt / 1000L)}"
                            else -> "尚未读取面板状态"
                        },
                        fontSize = 11.sp,
                        color = SubText,
                        modifier = Modifier.weight(1f)
                    )
                }
                if (diagLoading) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                diagItems.forEach { item -> DiagnosticRow(item) }
                Text(
                    if (issueCount == 0) "结论：全部正常" else "结论：$issueCount 项需关注",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = when {
                        issueCount == 0 -> Good
                        failCount > 0 -> MaterialTheme.colorScheme.error
                        else -> Warn
                    }
                )
                Text(
                    "正常 $okCount · 注意 $warnCount · 异常 $failCount · 未知 $unknownCount",
                    fontSize = 11.sp,
                    color = SubText
                )
            }
        }

        Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp)) {
                Text("关于", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text("棱镜路由 · Android 原生客户端 v1.0.0", fontSize = 12.sp)
                Text("Android 客户端 v1.0.0 · 只读", fontSize = 12.sp)
                Text("数据来自路由器的独立面板只读 API（/cgi-bin/panel-api）。", fontSize = 12.sp, color = SubText)
                Text("本应用只读展示，不修改路由器配置。", fontSize = 12.sp, color = SubText)
            }
        }
    }

    /* 删除地址前确认一次，避免误删令牌。 */
    val deleteTarget = pendingDelete?.let { index -> ui.servers.getOrNull(index)?.let { index to it } }
    if (deleteTarget != null) {
        val (index, target) = deleteTarget
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除服务器") },
            text = { Text("确定从地址列表删除「${target.displayName}」？") },
            confirmButton = {
                TextButton(onClick = {
                    val error = vm.removeServer(index)
                    serverMsg = error ?: "已删除 ${target.displayName}"
                    serverMsgError = error != null
                    pendingDelete = null
                }) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            }
        )
    }
}

/* ───────────────────────── 多路由器：地址行 / 新增表单 ───────────────────────── */

/** 地址列表的一行：单选点 + 名称/地址 + 删除；整行可点（当前项不可点）。 */
@Composable
private fun ServerRow(
    server: ServerProfile,
    active: Boolean,
    canDelete: Boolean,
    onSelect: () -> Unit,
    onDelete: () -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = !active, onClick = onSelect)
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        RadioButton(selected = active, onClick = { if (!active) onSelect() })
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    server.displayName,
                    fontSize = 13.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (active) {
                    Spacer(Modifier.width(6.dp))
                    ActiveBadge()
                }
            }
            Text(
                server.url,
                fontSize = 11.sp,
                color = SubText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(6.dp))
        TextButton(
            onClick = onDelete,
            enabled = canDelete,
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
        ) {
            Text(
                "删除",
                fontSize = 11.sp,
                color = if (canDelete) MaterialTheme.colorScheme.error else SubText
            )
        }
    }
}

@Composable
private fun ActiveBadge() {
    Box(
        Modifier
            .background(Brand.copy(alpha = 0.14f), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 1.dp)
    ) {
        Text("当前", fontSize = 10.sp, color = Brand, fontWeight = FontWeight.Medium)
    }
}

/** 新增地址表单：名称 / 地址 / 令牌。校验与去重都由 ViewModel 负责。 */
@Composable
private fun AddServerForm(
    name: String,
    url: String,
    token: String,
    showToken: Boolean,
    onName: (String) -> Unit,
    onUrl: (String) -> Unit,
    onToken: (String) -> Unit,
    onCancel: () -> Unit,
    onAdd: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = name,
            onValueChange = onName,
            label = { Text("名称") },
            placeholder = { Text("如：客厅路由器") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = url,
            onValueChange = onUrl,
            label = { Text("面板地址") },
            placeholder = { Text("http://192.168.1.1:8099") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = token,
            onValueChange = onToken,
            label = { Text("访问令牌（可留空）") },
            singleLine = true,
            visualTransformation = if (showToken) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth()
        )
        Row {
            Button(onClick = onAdd) { Text("添加") }
            Spacer(Modifier.width(12.dp))
            OutlinedButton(onClick = onCancel) { Text("取消") }
        }
    }
}

/* ───────────────────────── 诊断卡 ───────────────────────── */

/** 单行诊断项：状态点 + 名称 + 值/说明，右侧为状态文案。 */
@Composable
private fun DiagnosticRow(item: DiagItem) {
    val color = diagColor(item.level)
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier
                .padding(top = 5.dp)
                .size(8.dp)
                .background(color, CircleShape)
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(item.name, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(item.detail, fontSize = 12.sp, color = SubText)
            item.reasons.forEach { reason ->
                Text("· $reason", fontSize = 11.sp, color = SubText)
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(diagLevelLabel(item.level), fontSize = 11.sp, color = color)
    }
}

@Composable
private fun diagColor(level: DiagLevel): Color = when (level) {
    DiagLevel.OK -> Good
    DiagLevel.WARN -> Warn
    DiagLevel.FAIL -> MaterialTheme.colorScheme.error
    DiagLevel.UNKNOWN -> SubText
}

private fun diagLevelLabel(level: DiagLevel): String = when (level) {
    DiagLevel.OK -> "正常"
    DiagLevel.WARN -> "注意"
    DiagLevel.FAIL -> "异常"
    DiagLevel.UNKNOWN -> "未知"
}

/**
 * 按固定顺序生成 9 条检查项（纯函数，便于按需重算）：
 * 服务运行 → 数据新鲜度 → 记账可信度 → Clash → conntrack → 链路识别 →
 * 轮询耗时 → 版本与服务 → 节点上报。
 *
 * 缺失数据一律按「未知（灰）」处理，只有明确异常才是红/橙，
 * 避免没取到 state 时满屏误报。
 */
private fun buildDiagnostics(
    ui: UiState,
    status: JSONObject?,
    statusError: String?,
    nowSec: Long
): List<DiagItem> {
    val state = ui.state
    val health = state?.health
    val items = ArrayList<DiagItem>(9)

    /* 1) 服务运行 */
    items += DiagItem(
        name = "服务运行",
        level = when {
            state == null -> DiagLevel.UNKNOWN
            state.running -> DiagLevel.OK
            else -> DiagLevel.FAIL
        },
        detail = when {
            state == null -> "尚未获取到面板状态"
            state.running -> "守护进程运行中"
            else -> "棱镜路由服务未运行，流量不会再累计"
        }
    )

    /* 2) 数据新鲜度：<90s 绿，<300s 橙，否则红 */
    val ts = state?.ts ?: 0L
    val ageSec = if (ts > 0L) (nowSec - ts).coerceAtLeast(0L) else -1L
    items += DiagItem(
        name = "数据新鲜度",
        level = when {
            ts <= 0L -> DiagLevel.UNKNOWN
            ageSec < DIAG_FRESH_OK_SEC -> DiagLevel.OK
            ageSec < DIAG_FRESH_WARN_SEC -> DiagLevel.WARN
            else -> DiagLevel.FAIL
        },
        detail = when {
            ts <= 0L -> "快照没有可信时间戳"
            ageSec < DIAG_FRESH_OK_SEC -> "更新于 ${fmtClockSec(ts)} · $ageSec 秒前"
            ageSec < DIAG_FRESH_WARN_SEC ->
                "更新于 ${fmtClockSec(ts)} · ${fmtAgeSec(ageSec)}前（阈值 $DIAG_FRESH_OK_SEC 秒）"
            else ->
                "更新于 ${fmtClockSec(ts)} · ${fmtAgeSec(ageSec)}前（阈值 $DIAG_FRESH_WARN_SEC 秒）"
        }
    )

    /* 3) 记账可信度：exact 绿 / degraded 橙 / unavailable 红 / unknown 灰 */
    val confidence = health?.confidence?.trim()?.lowercase().orEmpty()
    items += DiagItem(
        name = "记账可信度",
        level = when (confidence) {
            "exact" -> DiagLevel.OK
            "degraded" -> DiagLevel.WARN
            "unavailable" -> DiagLevel.FAIL
            else -> DiagLevel.UNKNOWN
        },
        detail = when (confidence) {
            "exact" -> "exact：直连 / 代理分账精确"
            "degraded" -> "degraded：部分流量的分账结果降级"
            "unavailable" -> "unavailable：分账不可用，流量可能缺失"
            else -> "unknown：面板未给出可信度"
        },
        reasons = health?.reasons?.filter { it.isNotBlank() }?.take(DIAG_REASON_LIMIT) ?: emptyList()
    )

    /* 4) Clash 采集：ok 绿，其它红（空值 = 面板没上报，同样按失败提示） */
    val clash = state?.clash?.trim().orEmpty()
    items += DiagItem(
        name = "Clash 采集",
        level = when {
            state == null -> DiagLevel.UNKNOWN
            clash.equals("ok", ignoreCase = true) -> DiagLevel.OK
            else -> DiagLevel.FAIL
        },
        detail = when {
            state == null -> "尚未获取到面板状态"
            clash.isEmpty() -> "面板未上报采集状态（空值）"
            else -> "采集源状态：$clash"
        }
    )

    /* 5) conntrack：ok 绿，其它红 */
    val conntrack = state?.conntrack?.trim().orEmpty()
    items += DiagItem(
        name = "conntrack",
        level = when {
            state == null -> DiagLevel.UNKNOWN
            conntrack.equals("ok", ignoreCase = true) -> DiagLevel.OK
            else -> DiagLevel.FAIL
        },
        detail = when {
            state == null -> "尚未获取到面板状态"
            conntrack.isEmpty() -> "面板未上报采集状态（空值）"
            else -> "采集源状态：$conntrack"
        }
    )

    /* 6) 链路识别：brctl 绿 / none 橙，附带网桥名 */
    val linkSource = health?.linkSource?.trim()?.lowercase().orEmpty()
    val linkBridge = health?.linkBridge?.trim().orEmpty()
    items += DiagItem(
        name = "链路识别",
        level = when (linkSource) {
            "brctl" -> DiagLevel.OK
            "none" -> DiagLevel.WARN
            else -> DiagLevel.UNKNOWN
        },
        detail = when (linkSource) {
            "brctl" -> "brctl FDB（网桥 ${linkBridge.ifBlank { "未命名" }}）"
            "none" -> "未识别接入方式${if (linkBridge.isNotBlank()) "（网桥 $linkBridge）" else ""}"
            else -> "面板未上报 link_source"
        }
    )

    /* 7) 轮询耗时：<500ms 绿，<1500ms 橙，否则红；优先用 state.health.clashPollMs */
    val pollMs = health?.clashPollMs?.takeIf { it > 0 } ?: pollMsOf(status)
    items += DiagItem(
        name = "轮询耗时",
        level = when {
            pollMs <= 0L -> DiagLevel.UNKNOWN
            pollMs < DIAG_POLL_OK_MS -> DiagLevel.OK
            pollMs < DIAG_POLL_WARN_MS -> DiagLevel.WARN
            else -> DiagLevel.FAIL
        },
        detail = if (pollMs <= 0L) {
            "面板未下发 clash_poll_ms"
        } else {
            "$pollMs ms（阈值 $DIAG_POLL_OK_MS / $DIAG_POLL_WARN_MS ms）"
        }
    )

    /* 8) 版本与服务：读 status 失败显示「无法读取状态」 */
    val version = status?.optString("version", "").orEmpty().trim()
    val statusRunning = status?.optBoolean("running", false) ?: false
    items += DiagItem(
        name = "版本与服务",
        level = when {
            status != null -> if (statusRunning) DiagLevel.OK else DiagLevel.WARN
            statusError != null -> DiagLevel.FAIL
            else -> DiagLevel.UNKNOWN
        },
        detail = when {
            status != null && statusRunning -> "服务端 v${version.ifBlank { "?" }} · 服务运行中"
            status != null -> "服务端 v${version.ifBlank { "?" }} · 服务未运行"
            statusError != null -> "无法读取状态：$statusError"
            else -> "尚未检查，点「刷新诊断」读取"
        }
    )

    /* 9) 节点上报：为空橙「无出口数据」，有则绿 + 数量 */
    val nodes = state?.nodes ?: emptyList()
    items += DiagItem(
        name = "节点上报",
        level = when {
            state == null -> DiagLevel.UNKNOWN
            nodes.isEmpty() -> DiagLevel.WARN
            else -> DiagLevel.OK
        },
        detail = when {
            state == null -> "尚未获取到面板状态"
            nodes.isEmpty() -> "无出口数据"
            else -> "${nodes.size} 个出口节点有流量"
        }
    )

    return items
}

/** 轮询耗时：优先 status 自带的 health.clash_poll_ms，再退回顶层补读值；0 = 未提供。 */
private fun pollMsOf(status: JSONObject?): Long {
    val root = status ?: return 0L
    val fromHealth = root.optJSONObject("health")?.optLong("clash_poll_ms", 0L) ?: 0L
    if (fromHealth > 0L) return fromHealth
    return root.optLong("clash_poll_ms", 0L)
}

/** 秒级时间戳 → HH:mm:ss（面板的 ts / last_seen 都是秒）。 */
private fun fmtClockSec(sec: Long): String {
    if (sec <= 0L) return "—"
    return java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
        .format(java.util.Date(sec * 1000L))
}

/** 秒数 → 简短中文时长（45 秒 / 3 分钟 / 2 小时 5 分）。 */
private fun fmtAgeSec(sec: Long): String = when {
    sec < 60L -> "$sec 秒"
    sec < 3600L -> "${sec / 60} 分钟"
    sec < 86400L -> "${sec / 3600} 小时 ${(sec % 3600) / 60} 分"
    else -> "${sec / 86400} 天"
}

/** 错误文案脱敏：URL 里的 token 参数与令牌原文都不能出现在界面上。 */
private fun redact(message: String, token: String): String {
    var out = message.replace(Regex("(?i)token=[^&\\s]*"), "token=***")
    val secret = token.trim()
    /* 太短的令牌替换会误伤普通文字，只有 ≥4 位时才按原文抹掉。 */
    if (secret.length >= 4) out = out.replace(secret, "***")
    return out
}
