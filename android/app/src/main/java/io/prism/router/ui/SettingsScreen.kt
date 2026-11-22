package io.prism.router.ui

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lan
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.prism.router.data.MAX_SERVERS
import io.prism.router.data.GithubRelease
import io.prism.router.data.GithubReleaseClient
import io.prism.router.data.MainViewModel
import io.prism.router.data.PanelClient
import io.prism.router.data.ProcessInfo
import io.prism.router.data.ServerProfile
import io.prism.router.data.ServiceInfo
import io.prism.router.data.SystemInfo
import io.prism.router.data.UiState
import io.prism.router.data.UpdateStatus
import io.prism.router.data.WifiDevice
import io.prism.router.data.formatPublishedAt
import io.prism.router.data.fmtBytes
import io.prism.router.data.fmtUptime
import io.prism.router.ui.components.EmptyState
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismProgressBar
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.components.Segmented
import io.prism.router.ui.components.SkeletonList
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import io.prism.router.ui.theme.ThemeMode
import io.prism.router.ui.theme.isDynamicColorAvailable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Locale

/* ───────────────────────── 常量 ───────────────────────── */

/**
 * 「管理员」卡片在设置页 LazyColumn 里的下标（连接 0 → 管理员 1）。
 * 未登录时点「网络配置」会滚到这里并把焦点放到密码框。
 */
private const val ADMIN_ITEM_INDEX = 1

/** 刷新间隔的允许范围（与 SettingsStore / ViewModel 的收敛范围一致）。 */
private const val INTERVAL_MIN = 5
private const val INTERVAL_MAX = 300

/* 诊断阈值（与 Web 诊断中心 / SPEC 保持一致） */
private const val DIAG_FRESH_OK_SEC = 90L
private const val DIAG_FRESH_WARN_SEC = 300L
private const val DIAG_POLL_OK_MS = 500L
private const val DIAG_POLL_WARN_MS = 1500L
/* 记账原因只展示前 3 条，避免长列表把卡片撑长。 */
private const val DIAG_REASON_LIMIT = 3

/* 进程列表只展示 CPU 占用最高的前 10 条（需求约定的 Top 10）。 */
private const val PROCESS_TOP_N = 10

/* 内存 / 根分区占用达到该比例后进度条转为橙 / 红。 */
private const val USAGE_WARN_PERCENT = 0.75f
private const val USAGE_DANGER_PERCENT = 0.90f

/** 单项诊断结论：绿 / 橙 / 红 / 灰。 */
private enum class DiagLevel { OK, WARN, FAIL, UNKNOWN }

/** 设置页诊断卡的一项：名称 + 状态点 + 值/说明（可附带 reasons 明细）。 */
private data class DiagItem(
    val name: String,
    val level: DiagLevel,
    val detail: String,
    val reasons: List<String> = emptyList()
)

/**
 * 设置页（统计只读 + 本机配置 + 少量管理操作）。
 *
 * 分组顺序与商用路由器 App 一致：连接 → 管理员 → 系统 → 显示 → 通知 → 刷新 → 诊断 → 关于。
 * - 连接：当前服务器摘要、路由器地址 / 令牌编辑、测试连接；「多路由器」内联展开
 *   （增删切换仍调用 ViewModel 的既有方法，不跳子路由）；
 * - 管理员：root 密码登录换取 30 分钟内存令牌，登录后可重启路由器（输入 REBOOT
 *   二次确认）或开关无线射频；密码与令牌都不落盘、不进日志；
 * - 系统：无需登录的只读摘要（主机 / 型号 / 内核 / 运行时间 / 负载 / 内存 / 根分区
 *   进度条）+ 服务运行状态 + 进程 Top 10（等宽表格），带「刷新」；
 * - 显示 / 通知：主题、动态取色、告警通知开关。UiState 暂无这些字段、导航也未传入，
 *   默认用本地 remember 展示；调用方可通过参数接入真实状态（传 null 即本地模式）；
 * - 刷新：5–300 秒步进 + 输入；
 * - 诊断：原有 9 项只读自检，折叠展示；
 * - 关于：版本、构建信息、GitHub 更新检查（下载 / Release 入口）、只读说明与开源许可。
 *
 * 只有存在未保存修改时才出现底部「保存设置」栏，保存后弹 Snackbar；深色 / 动态色全部走主题令牌。
 *
 * @param vm Activity 作用域的 MainViewModel（由 NavHost 显式传入，避免按
 *   NavBackStackEntry 新建第二个实例）；仅供多路由器增删切换使用。
 * @param themeMode / dynamicColor / notifyEnabled 为可选外部状态，null 时使用本地状态。
 * @param onThemeModeChange / onDynamicColorChange / onNotifyEnabledChange 为对应的持久化回调。
 * @param onOpenServers / onOpenAbout 顶栏子页入口；null 时不渲染对应图标（预览 / 单页复用）。
 */
@Composable
fun SettingsScreen(
    ui: UiState,
    onSave: (String, String, Int) -> Unit,
    onTest: (String, String, (String) -> Unit) -> Unit,
    onRefresh: () -> Unit,
    vm: MainViewModel = viewModel(),
    themeMode: ThemeMode? = null,
    dynamicColor: Boolean? = null,
    onThemeModeChange: ((ThemeMode) -> Unit)? = null,
    onDynamicColorChange: ((Boolean) -> Unit)? = null,
    notifyEnabled: Boolean? = null,
    onNotifyEnabledChange: ((Boolean) -> Unit)? = null,
    /* 设置子页入口：由 NavHost 传入；为空时不显示顶栏动作（预览 / 单页复用时）。 */
    onOpenServers: (() -> Unit)? = null,
    onOpenAbout: (() -> Unit)? = null,
    /* 「管理员 → 网络配置」入口；null 时不渲染该行（预览 / 单页复用）。 */
    onOpenConfig: (() -> Unit)? = null
) {
    val context = LocalContext.current
    val semantic = LocalPrismSemanticColors.current
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    var base by rememberSaveable { mutableStateOf(ui.baseUrl) }
    var token by rememberSaveable { mutableStateOf(ui.token) }
    var interval by rememberSaveable { mutableStateOf(ui.intervalSec.toString()) }
    var testResult by rememberSaveable { mutableStateOf<String?>(null) }
    var showToken by remember { mutableStateOf(false) }

    /* 外观 / 通知：外部参数优先，否则本地态（不写 data 层）。 */
    var localThemeName by rememberSaveable { mutableStateOf(ThemeMode.SYSTEM.name) }
    var localDynamic by rememberSaveable { mutableStateOf(false) }
    var localNotify by rememberSaveable { mutableStateOf(true) }
    val currentTheme = themeMode ?: ThemeMode.fromKey(localThemeName)
    val currentDynamic = dynamicColor ?: localDynamic
    val currentNotify = notifyEnabled ?: localNotify

    /* 多路由器：内联展开 + 新增表单 + 删除确认。 */
    var showServers by rememberSaveable { mutableStateOf(false) }
    var showAdd by rememberSaveable { mutableStateOf(false) }
    var addName by rememberSaveable { mutableStateOf("") }
    var addUrl by rememberSaveable { mutableStateOf("") }
    var addToken by rememberSaveable { mutableStateOf("") }
    var serverError by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingDelete by remember { mutableStateOf<Int?>(null) }

    var diagOpen by rememberSaveable { mutableStateOf(false) }
    var showLicenses by remember { mutableStateOf(false) }

    /* 「网络配置」未登录时跳回管理员分组：列表状态 + 密码框焦点。 */
    val listState = rememberLazyListState()
    val loginFocus = remember { FocusRequester() }

    /* 切换当前服务器后，把输入框同步到新的地址；手动编辑时 ui 不变，不会被覆盖。 */
    LaunchedEffect(ui.baseUrl, ui.token) {
        if (base != ui.baseUrl) base = ui.baseUrl
        if (token != ui.token) token = ui.token
    }
    /* 外部改了间隔（保存 / 布局恢复）时同步输入框；用户输入不会触发这个 effect。 */
    LaunchedEffect(ui.intervalSec) {
        if (interval.toIntOrNull() != ui.intervalSec) interval = ui.intervalSec.toString()
    }

    /* 系统信息（无需登录）：进入设置页自动读一次，ViewModel 内部 5 分钟节流。 */
    LaunchedEffect(Unit) {
        vm.loadSystem(force = false)
    }

    /* 诊断：status 只在点「刷新诊断」时读取一次，失败只影响「版本与服务」一项。 */
    val client = remember { PanelClient() }
    var status by remember { mutableStateOf<JSONObject?>(null) }
    var statusError by remember { mutableStateOf<String?>(null) }
    var statusAt by remember { mutableStateOf(0L) }
    var diagLoading by remember { mutableStateOf(false) }

    fun toast(message: String) {
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    /**
     * 用系统浏览器打开外部链接（更新包下载 / GitHub Release 页）。
     *
     * 不申请任何权限、不内置下载器：只发 ACTION_VIEW；系统没有可用浏览器时
     * 用 Snackbar 提示，而不是崩溃（部分精简系统会没有默认浏览器）。
     */
    fun openExternal(url: String) {
        val target = url.trim()
        if (target.isEmpty()) return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(target))
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            toast("没有可打开链接的应用")
        }
    }

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

    val intervalValue = interval.toIntOrNull()
    val intervalInvalid = intervalValue == null || intervalValue !in INTERVAL_MIN..INTERVAL_MAX
    val baseInvalid = base.trim().isEmpty()
    val dirty = base.trim().trimEnd('/') != ui.baseUrl ||
        token != ui.token ||
        intervalInvalid ||
        intervalValue != ui.intervalSec

    fun submit() {
        if (intervalInvalid || baseInvalid) return
        val value = (interval.toIntOrNull() ?: ui.intervalSec).coerceIn(INTERVAL_MIN, INTERVAL_MAX)
        interval = value.toString()
        onSave(base, token, value)
        toast("设置已保存")
    }

    /* 版本 / 构建信息：从 PackageManager 读取，避免依赖未开启的 BuildConfig。 */
    val packageInfo = remember(context) {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
    }
    val versionName = packageInfo?.versionName?.takeIf { it.isNotBlank() } ?: "未知"
    val versionCode = when {
        packageInfo == null -> 0L
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> packageInfo.longVersionCode
        else -> @Suppress("DEPRECATION") packageInfo.versionCode.toLong()
    }
    /* 路由器插件版本：来自只读系统信息（?what=system 的 version），与 App 版本分开展示。 */
    val routerPluginVersion = ui.system?.version?.trim().orEmpty()
    val buildType = if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
        "debug"
    } else {
        "release"
    }

    val diagItems = buildDiagnostics(ui, status, statusError, System.currentTimeMillis() / 1000L)
    val okCount = diagItems.count { it.level == DiagLevel.OK }
    val warnCount = diagItems.count { it.level == DiagLevel.WARN }
    val failCount = diagItems.count { it.level == DiagLevel.FAIL }
    val unknownCount = diagItems.count { it.level == DiagLevel.UNKNOWN }
    val issueCount = warnCount + failCount + unknownCount

    PrismScaffold(
        title = "设置",
        subtitle = ui.servers.getOrNull(ui.activeIndex)?.displayName ?: "未配置服务器",
        actions = {
            if (onOpenServers != null) {
                PrismIconAction(
                    icon = Icons.Rounded.Storage,
                    contentDescription = "服务器列表",
                    onClick = onOpenServers
                )
            }
            if (onOpenAbout != null) {
                PrismIconAction(
                    icon = Icons.Rounded.Info,
                    contentDescription = "关于",
                    onClick = onOpenAbout
                )
            }
        },
        bottomBar = {
            /* 只读区域（系统 / 关于 / 服务器）不再常驻保存栏：只有真正改过才出现。 */
            if (dirty) {
                SettingsSaveBar(
                    onSave = { submit() },
                    saveEnabled = !intervalInvalid && !baseInvalid,
                    invalidMessage = if (baseInvalid) "请先填写路由器地址" else "请先修正无效的刷新间隔"
                )
            }
        }
    ) {
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = PrismSpacing.lg,
                    end = PrismSpacing.lg,
                    top = PrismSpacing.lg,
                    bottom = PrismSpacing.lg
                ),
                verticalArrangement = Arrangement.spacedBy(PrismSpacing.lg)
            ) {
                /* ───────── 连接 ───────── */
                item {
                    SectionCard(
                        title = "连接",
                        subtitle = "路由器地址、访问令牌与多路由器"
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = ui.servers.getOrNull(ui.activeIndex)?.displayName ?: "未配置",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Text(
                                    text = ui.baseUrl.ifBlank { "尚未填写路由器地址" },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            Spacer(Modifier.width(PrismSpacing.sm))
                            Pill(
                                text = if (ui.token.isBlank()) "无令牌" else "令牌已配置",
                                color = if (ui.token.isBlank()) semantic.neutral else semantic.success
                            )
                        }

                        Spacer(Modifier.height(PrismSpacing.md))
                        OutlinedTextField(
                            value = base,
                            onValueChange = { base = it },
                            label = { Text("路由器地址") },
                            placeholder = { Text("http://192.168.100.1:8099") },
                            isError = baseInvalid,
                            supportingText = {
                                if (baseInvalid) Text("请输入路由器地址")
                            },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(Modifier.height(PrismSpacing.sm))
                        OutlinedTextField(
                            value = token,
                            onValueChange = { token = it },
                            label = { Text("访问令牌（可留空）") },
                            singleLine = true,
                            visualTransformation = if (showToken) {
                                VisualTransformation.None
                            } else {
                                PasswordVisualTransformation()
                            },
                            trailingIcon = {
                                IconButton(onClick = { showToken = !showToken }) {
                                    Icon(
                                        imageVector = if (showToken) {
                                            Icons.Rounded.VisibilityOff
                                        } else {
                                            Icons.Rounded.Visibility
                                        },
                                        contentDescription = if (showToken) "隐藏令牌" else "显示令牌"
                                    )
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        )

                        Spacer(Modifier.height(PrismSpacing.md))
                        OutlinedButton(
                            onClick = { onTest(base, token) { result -> testResult = result } },
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                        ) {
                            Text("测试连接")
                        }
                        testResult?.let { result ->
                            /* 连接失败信息里可能带 URL，展示前统一去掉 token。 */
                            val shown = redact(result, token)
                            val ok = shown.startsWith("连接成功")
                            Spacer(Modifier.height(PrismSpacing.sm))
                            Text(
                                text = shown,
                                style = MaterialTheme.typography.labelSmall,
                                color = if (ok) semantic.success else MaterialTheme.colorScheme.error
                            )
                        }

                        Spacer(Modifier.height(PrismSpacing.md))
                        HorizontalDivider(
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                        )

                        /* 多路由器：内联展开，避免跳到子路由后丢失本页输入。 */
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clip(RoundedCornerShape(PrismRadius.small))
                                .clickable { showServers = !showServers }
                                .padding(vertical = PrismSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = "多路由器",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = "${ui.servers.size} / $MAX_SERVERS 个路由器地址 · " +
                                        if (ui.servers.size > 1) "点选即切换" else "可添加备用地址",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            Text(
                                text = if (showServers) "收起" else "管理",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Icon(
                                imageVector = if (showServers) {
                                    Icons.Rounded.ExpandLess
                                } else {
                                    Icons.Rounded.ExpandMore
                                },
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(PrismSize.icon)
                            )
                        }

                        if (showServers) {
                            Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)) {
                                ui.servers.forEachIndexed { index, server ->
                                    ServerRow(
                                        server = server,
                                        active = index == ui.activeIndex,
                                        canDelete = ui.servers.size > 1,
                                        onSelect = {
                                            if (index != ui.activeIndex) {
                                                vm.selectServer(index)
                                                toast("已切换到 ${server.displayName}")
                                            }
                                        },
                                        onDelete = { pendingDelete = index }
                                    )
                                    if (index != ui.servers.lastIndex) {
                                        HorizontalDivider(
                                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                                        )
                                    }
                                }

                                Spacer(Modifier.height(PrismSpacing.sm))
                                when {
                                    showAdd -> AddServerForm(
                                        name = addName,
                                        url = addUrl,
                                        token = addToken,
                                        showToken = showToken,
                                        onName = { addName = it },
                                        onUrl = { addUrl = it },
                                        onToken = { addToken = it },
                                        onToggleToken = { showToken = !showToken },
                                        onCancel = {
                                            showAdd = false
                                            serverError = null
                                        },
                                        onAdd = {
                                            val error = vm.addServer(addName, addUrl, addToken)
                                            if (error == null) {
                                                toast(
                                                    "已添加 " + addName.ifBlank {
                                                        ServerProfile.hostOf(addUrl)
                                                    }
                                                )
                                                addName = ""
                                                addUrl = ""
                                                addToken = ""
                                                showAdd = false
                                                serverError = null
                                            } else {
                                                serverError = error
                                            }
                                        }
                                    )

                                    ui.servers.size < MAX_SERVERS -> OutlinedButton(
                                        onClick = {
                                            showAdd = true
                                            serverError = null
                                        },
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .heightIn(min = 48.dp)
                                    ) {
                                        Text("添加服务器")
                                    }

                                    else -> Text(
                                        text = "已达 $MAX_SERVERS 条上限，删除一条后可继续添加。",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                serverError?.let { message ->
                                    Text(
                                        text = message,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.error
                                    )
                                }
                            }
                        }
                    }
                }

                /* ───────── 管理员 ───────── */
                item {
                    AdminSection(
                        ui = ui,
                        vm = vm,
                        toast = { message -> toast(message) },
                        onOpenConfig = onOpenConfig,
                        onRequireLogin = {
                            /* 未登录：滚到管理员卡片并把焦点交给密码框（入口就是本卡片）。 */
                            scope.launch {
                                runCatching { listState.animateScrollToItem(ADMIN_ITEM_INDEX) }
                                runCatching { loginFocus.requestFocus() }
                            }
                            toast("需先登录管理员")
                        },
                        passwordFocus = loginFocus
                    )
                }

                /* ───────── 系统（无需登录） ───────── */
                item {
                    SystemSection(
                        ui = ui,
                        onRefresh = { vm.refreshSystem() }
                    )
                }

                /* ───────── 显示 ───────── */
                item {
                    SectionCard(title = "显示", subtitle = "主题与动态取色") {
                        Text(
                            text = "主题",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(PrismSpacing.sm))
                        Segmented(
                            options = ThemeMode.entries,
                            selected = currentTheme,
                            onSelect = { mode ->
                                /* 本地态始终同步，外部回调只负责持久化；二者都缺席时也不会卡在旧值。 */
                                localThemeName = mode.name
                                onThemeModeChange?.invoke(mode)
                            },
                            label = { it.label },
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(Modifier.height(PrismSpacing.sm))
                        Text(
                            text = "跟随系统会随系统深色模式自动切换；浅色 / 深色仅影响本应用。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )

                        Spacer(Modifier.height(PrismSpacing.md))
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clip(RoundedCornerShape(PrismRadius.small))
                                .alpha(if (isDynamicColorAvailable) 1f else 0.6f)
                                .toggleable(
                                    value = currentDynamic && isDynamicColorAvailable,
                                    enabled = isDynamicColorAvailable,
                                    role = Role.Switch
                                ) { checked ->
                                    if (isDynamicColorAvailable) {
                                        localDynamic = checked
                                        onDynamicColorChange?.invoke(checked)
                                    }
                                }
                                .padding(vertical = PrismSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = "动态取色",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = if (isDynamicColorAvailable) {
                                        "Android 12+ 跟随系统壁纸配色；关闭后固定品牌蓝"
                                    } else {
                                        "需要 Android 12 及以上系统，当前设备不支持（已灰显）"
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Spacer(Modifier.width(PrismSpacing.sm))
                            Switch(
                                checked = currentDynamic && isDynamicColorAvailable,
                                onCheckedChange = null,
                                enabled = isDynamicColorAvailable
                            )
                        }
                    }
                }

                /* ───────── 通知 ───────── */
                item {
                    SectionCard(title = "通知", subtitle = "本地告警通知") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clip(RoundedCornerShape(PrismRadius.small))
                                .toggleable(
                                    value = currentNotify,
                                    role = Role.Switch
                                ) { checked ->
                                    localNotify = checked
                                    onNotifyEnabledChange?.invoke(checked)
                                }
                                .padding(vertical = PrismSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = "告警通知",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = "服务异常、数据过期、记账降级时发送本地通知",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Spacer(Modifier.width(PrismSpacing.sm))
                            Switch(checked = currentNotify, onCheckedChange = null)
                        }
                        Spacer(Modifier.height(PrismSpacing.sm))
                        Text(
                            text = if (currentNotify) {
                                "通知权限由系统设置控制；关闭系统通知后此处仍显示为开启。"
                            } else {
                                "已关闭：告警仍会显示在概览页，但不再发送系统通知。"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                /* ───────── 刷新 ───────── */
                item {
                    SectionCard(title = "刷新", subtitle = "自动轮询间隔 $INTERVAL_MIN–$INTERVAL_MAX 秒") {
                        val currentInterval = (interval.toIntOrNull() ?: ui.intervalSec)
                            .coerceIn(INTERVAL_MIN, INTERVAL_MAX)
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
                        ) {
                            IconButton(
                                onClick = {
                                    interval = (currentInterval - 5)
                                        .coerceAtLeast(INTERVAL_MIN)
                                        .toString()
                                },
                                enabled = currentInterval > INTERVAL_MIN,
                                modifier = Modifier.size(PrismSize.touchTarget)
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Remove,
                                    contentDescription = "减少刷新间隔"
                                )
                            }
                            OutlinedTextField(
                                value = interval,
                                onValueChange = { raw ->
                                    interval = raw.filter { it.isDigit() }.take(3)
                                },
                                label = { Text("间隔") },
                                suffix = { Text("秒") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                isError = intervalInvalid && interval.isNotBlank(),
                                supportingText = {
                                    when {
                                        interval.isBlank() -> Text("范围 $INTERVAL_MIN–$INTERVAL_MAX 秒")
                                        intervalInvalid -> Text("请输入 $INTERVAL_MIN–$INTERVAL_MAX")
                                    }
                                },
                                modifier = Modifier.weight(1f)
                            )
                            IconButton(
                                onClick = {
                                    interval = (currentInterval + 5)
                                        .coerceAtMost(INTERVAL_MAX)
                                        .toString()
                                },
                                enabled = currentInterval < INTERVAL_MAX,
                                modifier = Modifier.size(PrismSize.touchTarget)
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Add,
                                    contentDescription = "增加刷新间隔"
                                )
                            }
                        }
                        Spacer(Modifier.height(PrismSpacing.sm))
                        Text(
                            text = "5 秒最及时但更耗电；60 秒以上适合只看趋势。修改后点底部「保存设置」生效。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                /* ───────── 诊断 ───────── */
                item {
                    SectionCard(
                        title = "诊断",
                        subtitle = "只读自检 · 9 项",
                        action = {
                            TextButton(
                                onClick = { diagOpen = !diagOpen },
                                modifier = Modifier.heightIn(min = 48.dp),
                                contentPadding = PaddingValues(horizontal = PrismSpacing.sm)
                            ) {
                                Text(
                                    text = if (diagOpen) "收起" else "展开",
                                    style = MaterialTheme.typography.labelSmall
                                )
                            }
                        }
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = if (issueCount == 0) "全部正常" else "$issueCount 项需关注",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = when {
                                    issueCount == 0 -> semantic.success
                                    failCount > 0 -> MaterialTheme.colorScheme.error
                                    else -> semantic.warning
                                },
                                modifier = Modifier.weight(1f)
                            )
                            Pill(
                                text = if (issueCount == 0) "正常" else "需关注",
                                color = if (issueCount == 0) semantic.success else semantic.warning
                            )
                        }
                        Spacer(Modifier.height(PrismSpacing.xs))
                        Text(
                            text = "正常 $okCount · 注意 $warnCount · 异常 $failCount · 未知 $unknownCount",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )

                        if (diagOpen) {
                            Spacer(Modifier.height(PrismSpacing.md))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                OutlinedButton(
                                    onClick = { runDiagnostics() },
                                    enabled = !diagLoading,
                                    modifier = Modifier.heightIn(min = 48.dp)
                                ) {
                                    Text(if (diagLoading) "检查中…" else "刷新诊断")
                                }
                                Spacer(Modifier.width(PrismSpacing.md))
                                Text(
                                    text = when {
                                        diagLoading -> "正在读取状态…"
                                        statusAt > 0L -> "状态读取于 ${fmtClockSec(statusAt / 1000L)}"
                                        else -> "尚未读取路由器状态"
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f)
                                )
                            }
                            if (diagLoading) {
                                Spacer(Modifier.height(PrismSpacing.sm))
                                LinearProgressIndicator(Modifier.fillMaxWidth())
                            }
                            Spacer(Modifier.height(PrismSpacing.sm))
                            diagItems.forEachIndexed { index, item ->
                                DiagnosticRow(item)
                                if (index != diagItems.lastIndex) {
                                    HorizontalDivider(
                                        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                                    )
                                }
                            }
                        } else {
                            Spacer(Modifier.height(PrismSpacing.sm))
                            Text(
                                text = "展开可查看服务运行、数据新鲜度、记账可信度、Clash、conntrack、" +
                                    "链路识别、轮询耗时、版本与节点上报。",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }

                /* ───────── 关于 ───────── */
                item {
                    SectionCard(title = "关于", subtitle = "棱镜路由 · Android 原生客户端") {
                        /*
                         * App 版本与路由器插件版本是两个独立的版本来源：
                         * - App 版本由 android/version.properties 单一维护，CI 可覆盖；
                         * - 插件版本由路由器上安装的 ipk 决定，不参与 App 更新比较。
                         */
                        InfoRow("App 版本", "$versionName ($versionCode)")
                        InfoRow(
                            "路由器插件版本",
                            if (routerPluginVersion.isNotBlank()) {
                                "v$routerPluginVersion"
                            } else {
                                "未连接路由器 / 读取中"
                            }
                        )
                        InfoRow(
                            "构建",
                            "$buildType · Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）"
                        )
                        InfoRow("数据来源", "路由器只读面板 /cgi-bin/panel-api")
                        InfoRow("权限", "统计只读；管理员操作需登录，含重启 / 无线开关 / 网络配置")
                        UpdateBlock(
                            ui = ui,
                            appVersionFallback = versionName,
                            onCheck = { vm.checkUpdate() },
                            onOpenUrl = { url -> openExternal(url) }
                        )
                        Spacer(Modifier.height(PrismSpacing.xs))
                        HorizontalDivider(
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                        )
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clip(RoundedCornerShape(PrismRadius.small))
                                .clickable(role = Role.Button) { showLicenses = true }
                                .padding(vertical = PrismSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "开源许可",
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f)
                            )
                            Text(
                                text = "查看",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Icon(
                                imageVector = Icons.AutoMirrored.Rounded.KeyboardArrowRight,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(PrismSize.icon)
                            )
                        }
                        Spacer(Modifier.height(PrismSpacing.xs))
                        Text(
                            text = "统计功能只读；管理员操作需登录，且仅限重启路由器、无线开关与网络配置。" +
                                "路由器地址、访问令牌与刷新间隔仅保存在本机 DataStore；" +
                                "管理员令牌只存在于内存，退出应用或切换服务器即失效。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(PrismSpacing.lg)
            )
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
                    if (error == null) {
                        toast("已删除 ${target.displayName}")
                    } else {
                        serverError = error
                    }
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

    if (showLicenses) {
        AlertDialog(
            onDismissRequest = { showLicenses = false },
            title = { Text("开源许可") },
            text = {
                Column(
                    modifier = Modifier
                        .heightIn(max = 360.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)
                ) {
                    Text(
                        text = "棱镜路由 Android 客户端基于以下开源项目构建：",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    LicenseLine("AndroidX / Jetpack Compose", "Apache-2.0")
                    LicenseLine("Kotlin / kotlinx.coroutines", "Apache-2.0")
                    LicenseLine("OkHttp", "Apache-2.0")
                    LicenseLine("DataStore", "Apache-2.0")
                    Spacer(Modifier.height(PrismSpacing.sm))
                    Text(
                        text = "完整许可证文本见各项目仓库。应用只读访问路由器面板，不收集、不上传任何个人数据。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { showLicenses = false }) { Text("关闭") }
            }
        )
    }
}

/* ───────────────────────── 底部保存栏 ───────────────────────── */

/**
 * 底部保存栏：只有存在未保存修改时才由 [SettingsScreen] 挂载。
 *
 * 因此这里不再需要「配置已同步」的常驻文案，也不占只读区域的高度；
 * 顶部用 0.5dp 分隔线与内容区分，按钮保持 ≥48dp。
 */
@Composable
private fun SettingsSaveBar(onSave: () -> Unit, saveEnabled: Boolean, invalidMessage: String = "请先修正无效的刷新间隔") {
    val semantic = LocalPrismSemanticColors.current
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        shape = RoundedCornerShape(topStart = PrismRadius.large, topEnd = PrismRadius.large)
    ) {
        Column {
            HorizontalDivider(
                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f),
                thickness = 0.5.dp
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = PrismSpacing.lg, vertical = PrismSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(PrismSpacing.md)
            ) {
                Text(
                    text = if (saveEnabled) "有未保存的修改" else invalidMessage,
                    style = MaterialTheme.typography.labelSmall,
                    color = semantic.warning,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Button(
                    onClick = onSave,
                    enabled = saveEnabled,
                    modifier = Modifier.heightIn(min = 48.dp)
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Save,
                        contentDescription = null,
                        modifier = Modifier.size(PrismSize.iconSmall)
                    )
                    Spacer(Modifier.width(PrismSpacing.xs))
                    Text("保存设置")
                }
            }
        }
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
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(PrismRadius.small))
            .clickable(enabled = !active, role = Role.RadioButton, onClick = onSelect)
            .padding(vertical = PrismSpacing.xs),
        verticalAlignment = Alignment.CenterVertically
    ) {
        RadioButton(selected = active, onClick = { if (!active) onSelect() })
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = server.displayName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (active) {
                    Spacer(Modifier.width(PrismSpacing.sm))
                    Pill("当前", color = MaterialTheme.colorScheme.primary)
                }
            }
            Text(
                text = server.url,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        TextButton(
            onClick = onDelete,
            enabled = canDelete,
            modifier = Modifier.heightIn(min = 48.dp),
            contentPadding = PaddingValues(horizontal = PrismSpacing.sm)
        ) {
            Text(
                text = "删除",
                style = MaterialTheme.typography.labelSmall,
                color = if (canDelete) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
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
    onToggleToken: () -> Unit,
    onCancel: () -> Unit,
    onAdd: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
        Text(
            text = "添加路由器",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
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
            label = { Text("路由器地址") },
            placeholder = { Text("http://192.168.1.1:8099") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = token,
            onValueChange = onToken,
            label = { Text("访问令牌（可留空）") },
            singleLine = true,
            visualTransformation = if (showToken) {
                VisualTransformation.None
            } else {
                PasswordVisualTransformation()
            },
            trailingIcon = {
                IconButton(onClick = onToggleToken) {
                    Icon(
                        imageVector = if (showToken) {
                            Icons.Rounded.VisibilityOff
                        } else {
                            Icons.Rounded.Visibility
                        },
                        contentDescription = if (showToken) "隐藏令牌" else "显示令牌"
                    )
                }
            },
            modifier = Modifier.fillMaxWidth()
        )
        Row(horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
            Button(
                onClick = onAdd,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp)
            ) {
                Text("添加")
            }
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp)
            ) {
                Text("取消")
            }
        }
    }
}

/* ───────────────────────── 诊断卡 ───────────────────────── */

/** 单行诊断项：状态点 + 名称 + 值/说明，右侧为状态文案。 */
@Composable
private fun DiagnosticRow(item: DiagItem) {
    val color = diagColor(item.level)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = PrismSpacing.sm),
        verticalAlignment = Alignment.Top
    ) {
        Box(
            Modifier
                .padding(top = 5.dp)
                .size(8.dp)
                .background(color, CircleShape)
        )
        Spacer(Modifier.width(PrismSpacing.sm))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = item.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface
            )
            Text(
                text = item.detail,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            item.reasons.forEach { reason ->
                Text(
                    text = "· $reason",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        Text(
            text = diagLevelLabel(item.level),
            style = MaterialTheme.typography.labelSmall,
            color = color
        )
    }
}

@Composable
private fun diagColor(level: DiagLevel): Color {
    val semantic = LocalPrismSemanticColors.current
    return when (level) {
        DiagLevel.OK -> semantic.success
        DiagLevel.WARN -> semantic.warning
        DiagLevel.FAIL -> MaterialTheme.colorScheme.error
        DiagLevel.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

private fun diagLevelLabel(level: DiagLevel): String = when (level) {
    DiagLevel.OK -> "正常"
    DiagLevel.WARN -> "注意"
    DiagLevel.FAIL -> "异常"
    DiagLevel.UNKNOWN -> "未知"
}

/* ───────────────────────── 关于 ───────────────────────── */

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = PrismSpacing.xs),
        verticalAlignment = Alignment.Top
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(64.dp)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun LicenseLine(name: String, license: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = PrismSpacing.xs),
        verticalAlignment = Alignment.Top
    ) {
        Text(
            text = name,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(PrismSpacing.sm))
        Text(
            text = license,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/* ───────────────────────── 诊断计算 ───────────────────────── */

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

/* ───────────────────────── 管理员（登录 + 管理操作） ───────────────────────── */

/**
 * 管理员分组：root 密码登录 → 临时管理令牌（只在 ViewModel 内存）→ 重启 / 无线开关。
 *
 * 安全与交互约定：
 * - 密码只放在 [remember] 的输入框状态里（不落 DataStore、不参与屏幕状态恢复），
 *   登录成功后立刻清空；
 * - 令牌由 ViewModel 私有字段持有，UiState 只暴露「已登录 / 用户名 / 到期时间」；
 * - 重启必须二次确认并输入字面量 `REBOOT`（与后端 `confirm` 校验一致）；
 * - 关无线会断开客户端，卡片里提前说明，开关只作用于后端返回的 radio；
 * - 错误（密码错误 / 429 限速 / 令牌过期）与成功提示都在卡片内就地展示。
 */
@Composable
private fun AdminSection(
    ui: UiState,
    vm: MainViewModel,
    toast: (String) -> Unit,
    onOpenConfig: (() -> Unit)?,
    onRequireLogin: () -> Unit,
    passwordFocus: FocusRequester
) {
    val semantic = LocalPrismSemanticColors.current
    var username by rememberSaveable { mutableStateOf("root") }
    /* 密码不是配置：用 remember（不参与状态恢复），登录成功立即清空。 */
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var showReboot by remember { mutableStateOf(false) }
    var rebootText by remember { mutableStateOf("") }

    LaunchedEffect(ui.adminLoggedIn) {
        if (ui.adminLoggedIn) password = ""
    }

    val logoutAction: (@Composable () -> Unit)? = if (ui.adminLoggedIn) {
        {
            TextButton(
                onClick = {
                    vm.adminLogout()
                    toast("已退出管理员登录")
                },
                modifier = Modifier.heightIn(min = 48.dp)
            ) {
                Text("退出", style = MaterialTheme.typography.labelSmall)
            }
        }
    } else {
        null
    }

    SectionCard(
        title = "管理员",
        subtitle = if (ui.adminLoggedIn) {
            "已登录 · 令牌仅保存在内存，30 分钟后过期"
        } else {
            "root 密码登录后可执行重启 / 无线开关"
        },
        action = logoutAction
    ) {
        if (!ui.adminLoggedIn) {
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("用户名") },
                singleLine = true,
                enabled = !ui.adminLoginLoading,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("管理员密码") },
                singleLine = true,
                enabled = !ui.adminLoginLoading,
                visualTransformation = if (showPassword) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(passwordFocus),
                trailingIcon = {
                    IconButton(onClick = { showPassword = !showPassword }) {
                        Icon(
                            imageVector = if (showPassword) {
                                Icons.Rounded.VisibilityOff
                            } else {
                                Icons.Rounded.Visibility
                            },
                            contentDescription = if (showPassword) "隐藏密码" else "显示密码"
                        )
                    }
                }
            )
            Spacer(Modifier.height(PrismSpacing.md))
            Button(
                onClick = { vm.adminLogin(username, password) },
                enabled = !ui.adminLoginLoading && password.isNotBlank(),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
            ) {
                Text(if (ui.adminLoginLoading) "登录中…" else "登录")
            }
            AdminFeedback(ui)
            Spacer(Modifier.height(PrismSpacing.sm))
            Text(
                text = "密码只用于向路由器换取 30 分钟有效的管理令牌；令牌只保存在内存，" +
                    "不写入本机存储，也不会出现在日志里。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill("已登录", color = semantic.success)
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(
                    text = ui.adminUser.ifBlank { "root" },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
            }
            Spacer(Modifier.height(PrismSpacing.xs))
            Text(
                text = "令牌到期 ${fmtClockSec(ui.adminExpiresAt)} · ${adminExpiryText(ui.adminExpiresAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(Modifier.height(PrismSpacing.md))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            Spacer(Modifier.height(PrismSpacing.md))

            Text(
                text = "管理操作",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            OutlinedButton(
                onClick = {
                    rebootText = ""
                    showReboot = true
                },
                enabled = !ui.adminBusy,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
            ) {
                Text("重启路由器")
            }
            Text(
                text = "需要输入 REBOOT 二次确认；重启期间路由器管理页与面板都会断开约 1 分钟。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(Modifier.height(PrismSpacing.md))
            Text(
                text = "无线开关",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(PrismSpacing.xs))
            WifiBlock(ui = ui, vm = vm)
            AdminFeedback(ui)
        }

        /* 网络配置入口：登录后可用；未登录时提示先登录并跳到本卡片的登录框。 */
        if (onOpenConfig != null) {
            Spacer(Modifier.height(PrismSpacing.md))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            Spacer(Modifier.height(PrismSpacing.md))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .clip(RoundedCornerShape(PrismRadius.small))
                    .clickable {
                        if (ui.adminLoggedIn) {
                            onOpenConfig()
                        } else {
                            onRequireLogin()
                        }
                    }
                    .padding(vertical = PrismSpacing.sm),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = Icons.Rounded.Lan,
                    contentDescription = null,
                    tint = if (ui.adminLoggedIn) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                )
                Spacer(Modifier.width(PrismSpacing.md))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "网络配置",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = if (ui.adminLoggedIn) {
                            "LAN / WAN / DHCP / 系统 / 端口转发"
                        } else {
                            "需先登录管理员"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = if (ui.adminLoggedIn) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            semantic.warning
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Spacer(Modifier.width(PrismSpacing.sm))
                Icon(
                    imageVector = Icons.AutoMirrored.Rounded.KeyboardArrowRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }

    if (showReboot) {
        AlertDialog(
            onDismissRequest = { if (!ui.adminBusy) showReboot = false },
            title = { Text("重启路由器") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
                    Text(
                        text = "重启会中断所有网络连接约 1 分钟。请输入 REBOOT 确认：",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    OutlinedTextField(
                        value = rebootText,
                        onValueChange = { rebootText = it },
                        placeholder = { Text("REBOOT") },
                        singleLine = true,
                        enabled = !ui.adminBusy,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.adminReboot(rebootText)
                        rebootText = ""
                        showReboot = false
                    },
                    enabled = rebootText.trim() == "REBOOT" && !ui.adminBusy,
                    modifier = Modifier.heightIn(min = 48.dp)
                ) {
                    Text("重启", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showReboot = false },
                    enabled = !ui.adminBusy,
                    modifier = Modifier.heightIn(min = 48.dp)
                ) {
                    Text("取消")
                }
            }
        )
    }
}

/** 管理员卡片内的错误 / 成功提示与写操作进度条（就地展示，不弹 Snackbar 打断）。 */
@Composable
private fun AdminFeedback(ui: UiState) {
    val semantic = LocalPrismSemanticColors.current
    ui.adminError?.let { message ->
        Spacer(Modifier.height(PrismSpacing.sm))
        Text(
            text = message,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.error
        )
    }
    ui.adminNotice?.let { message ->
        Spacer(Modifier.height(PrismSpacing.sm))
        Text(
            text = message,
            style = MaterialTheme.typography.labelSmall,
            color = semantic.success
        )
    }
    if (ui.adminBusy) {
        Spacer(Modifier.height(PrismSpacing.sm))
        LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

/** 无线射频列表：未登录时整个区块不会渲染；0 个射频时提示「未检测到无线网卡」。 */
@Composable
private fun WifiBlock(ui: UiState, vm: MainViewModel) {
    val semantic = LocalPrismSemanticColors.current
    val wifi = ui.wifi
    when {
        ui.wifiLoading && wifi == null -> Row(verticalAlignment = Alignment.CenterVertically) {
            LinearProgressIndicator(Modifier.weight(1f))
            Spacer(Modifier.width(PrismSpacing.md))
            Text(
                text = "正在读取无线状态…",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        wifi == null -> Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
            Text(
                text = "还没有读取到无线状态。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(
                onClick = { vm.adminReloadWifi() },
                enabled = !ui.adminBusy,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
            ) {
                Text("读取无线状态")
            }
        }

        !wifi.supported -> Text(
            text = "未检测到无线网卡（wifi.supported=false）。",
            style = MaterialTheme.typography.bodyMedium,
            color = semantic.warning
        )

        wifi.devices.isEmpty() -> Text(
            text = "路由器上报支持无线，但没有射频条目；稍后点「刷新无线状态」再试。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        else -> Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)) {
            wifi.devices.forEach { device ->
                WifiSwitchRow(
                    device = device,
                    busy = ui.adminBusy,
                    onToggle = { enabled -> vm.adminSetWifiDisabled(device.radio, !enabled) }
                )
            }
            TextButton(
                onClick = { vm.adminReloadWifi() },
                enabled = !ui.wifiLoading && !ui.adminBusy,
                modifier = Modifier.heightIn(min = 48.dp)
            ) {
                Text("刷新无线状态", style = MaterialTheme.typography.labelSmall)
            }
            Text(
                text = "关闭射频会断开该频段的无线客户端（本机若走 Wi-Fi 也会掉线）。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** 单个射频：radio 名 + SSID / 频段 / 信道 / 客户端数 + 开关（开 = 未禁用）。 */
@Composable
private fun WifiSwitchRow(device: WifiDevice, busy: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(vertical = PrismSpacing.xs),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = device.displayRadio,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = wifiDeviceDetail(device),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        Switch(
            checked = !device.disabled,
            onCheckedChange = onToggle,
            enabled = !busy
        )
    }
}

/** 射频副文案：SSID / 频段 / 信道 / 客户端数 / 加密方式（空字段直接跳过）。 */
private fun wifiDeviceDetail(device: WifiDevice): String = listOfNotNull(
    device.ssid.trim().takeIf { it.isNotBlank() }?.let { "SSID $it" },
    device.band.trim().takeIf { it.isNotBlank() },
    device.channel.trim().takeIf { it.isNotBlank() }?.let { "信道 $it" },
    "${device.clients} 台客户端",
    device.encryption.trim().takeIf { it.isNotBlank() }
).joinToString(" · ")

/** 令牌到期文案：绝对时间由调用方展示，这里给相对剩余（过期即提示重新登录）。 */
private fun adminExpiryText(expiresAt: Long): String {
    if (expiresAt <= 0L) return "到期时间未知"
    val remain = expiresAt - System.currentTimeMillis() / 1000
    return when {
        remain <= 0L -> "已过期，请重新登录"
        remain < 60L -> "剩余不到 1 分钟"
        else -> "剩余 ${remain / 60} 分钟"
    }
}

/* ───────────────────────── 系统（无需登录） ───────────────────────── */

/**
 * 系统分组：设备摘要（主机名 / 型号 / 内核 / 运行时间 / 负载 / 内存 / 根分区）、
 * 服务状态（绿点运行 / 红点停止 + PID / info）与进程 Top 10（等宽表格）。
 *
 * 数据来自 `/cgi-bin/prism-router-system`（只读、无需登录）。三个查询互相独立：
 * 某一块失败只影响本块，其它块照常展示；全部失败才显示整块错误 + 重试。
 */
@Composable
private fun SystemSection(ui: UiState, onRefresh: () -> Unit) {
    val semantic = LocalPrismSemanticColors.current
    val system = ui.system
    val hasAny = system != null || ui.services.isNotEmpty() || ui.processes.isNotEmpty()

    SectionCard(
        title = "系统",
        subtitle = "无需登录 · 只读",
        action = {
            TextButton(
                onClick = onRefresh,
                enabled = !ui.systemLoading,
                modifier = Modifier.heightIn(min = 48.dp),
                contentPadding = PaddingValues(horizontal = PrismSpacing.sm)
            ) {
                Text(
                    text = if (ui.systemLoading) "刷新中…" else "刷新",
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }
    ) {
        when {
            !hasAny && ui.systemLoading -> SkeletonList(rows = 3, showHeader = false)

            !hasAny && ui.systemError != null -> ErrorState(
                msg = ui.systemError,
                title = "系统信息读取失败",
                onRetry = onRefresh
            )

            !hasAny -> EmptyState(
                title = "尚未读取系统信息",
                desc = "点右上角「刷新」读取主机名、内存、根分区、服务与进程。",
                icon = Icons.Rounded.Info
            )

            else -> {
                if (system != null) {
                    SystemInfoBlock(system)
                } else if (ui.systemError != null) {
                    Text(
                        text = "设备信息读取失败：${ui.systemError}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }

                Spacer(Modifier.height(PrismSpacing.md))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                Spacer(Modifier.height(PrismSpacing.md))

                Text(
                    text = "服务状态",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Spacer(Modifier.height(PrismSpacing.xs))
                if (ui.services.isEmpty()) {
                    Text(
                        text = "暂无服务数据",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    Text(
                        text = "运行中 ${ui.services.count { it.running }} / ${ui.services.size}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(PrismSpacing.xs))
                    ui.services.forEachIndexed { index, service ->
                        ServiceStatusRow(service)
                        if (index != ui.services.lastIndex) {
                            HorizontalDivider(
                                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                            )
                        }
                    }
                }

                Spacer(Modifier.height(PrismSpacing.md))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                Spacer(Modifier.height(PrismSpacing.md))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "进程 Top $PROCESS_TOP_N",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f)
                    )
                    Text(
                        text = "按 CPU 排序",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(Modifier.height(PrismSpacing.xs))
                if (ui.processes.isEmpty()) {
                    Text(
                        text = "暂无进程数据",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    ProcessTable(ui.processes)
                }

                if (ui.systemError != null && system != null) {
                    Spacer(Modifier.height(PrismSpacing.sm))
                    Text(
                        text = "部分数据读取失败：${ui.systemError}",
                        style = MaterialTheme.typography.labelSmall,
                        color = semantic.warning
                    )
                }
                Spacer(Modifier.height(PrismSpacing.sm))
                Text(
                    text = if (ui.systemAt > 0L) {
                        "读取于 ${fmtClockSec(ui.systemAt / 1000L)} · 来自 /cgi-bin/prism-router-system"
                    } else {
                        "来自 /cgi-bin/prism-router-system"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** 设备摘要：主机名 / 型号 / 内核 / 运行时间 / 负载 + 内存与根分区进度条。 */
@Composable
private fun SystemInfoBlock(info: SystemInfo) {
    InfoRow("主机名", info.hostname.ifBlank { "—" })
    InfoRow("型号", info.model.ifBlank { "—" })
    InfoRow("内核", info.kernel.ifBlank { "—" })
    if (info.version.isNotBlank()) InfoRow("固件", info.version)
    InfoRow("运行时间", if (info.uptime > 0L) fmtUptime(info.uptime) else "—")
    InfoRow("负载", info.loadText)
    Spacer(Modifier.height(PrismSpacing.xs))
    if (info.memory.known) {
        ProgressRow(
            label = "内存",
            valueText = "${fmtBytes(info.memory.used)} / ${fmtBytes(info.memory.total)}",
            percent = info.memory.usedPercent
        )
    } else {
        InfoRow("内存", "未获取到")
    }
    if (info.rootfs.known) {
        ProgressRow(
            label = "根分区",
            valueText = "${fmtBytes(info.rootfs.used)} / ${fmtBytes(info.rootfs.total)}",
            percent = info.rootfs.usedPercent
        )
    } else {
        InfoRow("根分区", "未获取到")
    }
}

/** 单条容量进度：标签 + 已用/总量 + 百分比 + 6dp 进度条（≥75% 橙、≥90% 红）。 */
@Composable
private fun ProgressRow(label: String, valueText: String, percent: Float) {
    val color = usageColor(percent)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = PrismSpacing.xs)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.width(64.dp)
            )
            Text(
                text = valueText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = String.format(Locale.US, "%.0f%%", percent * 100f),
                style = MaterialTheme.typography.labelSmall,
                color = color
            )
        }
        Spacer(Modifier.height(PrismSpacing.xs))
        PrismProgressBar(
            progress = percent,
            color = color,
            height = 6.dp,
            contentDescription = String.format(Locale.US, "%s 已用 %.0f%%", label, percent * 100f)
        )
    }
}

/** 占用比例 → 语义色。 */
@Composable
private fun usageColor(percent: Float): Color {
    val semantic = LocalPrismSemanticColors.current
    return when {
        percent >= USAGE_DANGER_PERCENT -> MaterialTheme.colorScheme.error
        percent >= USAGE_WARN_PERCENT -> semantic.warning
        else -> MaterialTheme.colorScheme.primary
    }
}

/** 单条服务：状态点（绿运行 / 红停止）+ 名称 + 服务名 / PID / info + 状态文案。 */
@Composable
private fun ServiceStatusRow(service: ServiceInfo) {
    val semantic = LocalPrismSemanticColors.current
    val tint = if (service.running) semantic.success else MaterialTheme.colorScheme.error
    val subtitle = listOfNotNull(
        service.name.trim().takeIf { it.isNotBlank() && !it.equals(service.displayName, ignoreCase = true) },
        service.pid.takeIf { it > 0 }?.let { "PID $it" },
        service.info.trim().takeIf { it.isNotBlank() }
    ).joinToString(" · ")

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(vertical = PrismSpacing.xs),
        verticalAlignment = Alignment.Top
    ) {
        Box(
            Modifier
                .padding(top = 6.dp)
                .size(8.dp)
                .background(tint, CircleShape)
        )
        Spacer(Modifier.width(PrismSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = service.displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            if (subtitle.isNotEmpty()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        Text(
            text = if (service.running) "运行中" else "已停止",
            style = MaterialTheme.typography.labelSmall,
            color = tint,
            maxLines = 1
        )
    }
}

/**
 * 进程 Top 10 表格：PID / 用户 / CPU% / 内存 / 命令，全部等宽字体。
 *
 * 列宽固定（40 / 56 / 48 / 48dp），命令列 `weight(1f)` 单行省略 —— 390dp 宽度下
 * 不横向溢出；行高不设 48dp（只读表格，无触控目标），卡片整体仍可滚动。
 */
@Composable
private fun ProcessTable(processes: List<ProcessInfo>) {
    val mono = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace)
    val headerColor = MaterialTheme.colorScheme.onSurfaceVariant
    val top = remember(processes) { processes.sortedByDescending { it.cpu }.take(PROCESS_TOP_N) }

    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = PrismSpacing.xs)
    ) {
        ProcessCell("PID", mono, 40.dp, headerColor)
        ProcessCell("用户", mono, 56.dp, headerColor)
        ProcessCell("CPU%", mono, 48.dp, headerColor)
        ProcessCell("内存", mono, 48.dp, headerColor)
        ProcessCell("命令", mono, null, headerColor)
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    top.forEach { process ->
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            ProcessCell("${process.pid}", mono, 40.dp)
            ProcessCell(process.userText, mono, 56.dp)
            ProcessCell(process.cpuText, mono, 48.dp)
            ProcessCell(process.memText, mono, 48.dp)
            ProcessCell(process.commandText, mono, null)
        }
    }
}

/** 进程表格单元格：固定列宽或吃掉剩余宽度，永远单行省略。 */
@Composable
private fun RowScope.ProcessCell(text: String, style: TextStyle, width: Dp?, color: Color) {
    Text(
        text = text,
        style = style,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = if (width != null) Modifier.width(width) else Modifier.weight(1f)
    )
}

@Composable
private fun RowScope.ProcessCell(text: String, style: TextStyle, width: Dp?) {
    ProcessCell(text, style, width, MaterialTheme.colorScheme.onSurface)
}

/* ───────────────────────── 检查更新（关于分组内） ───────────────────────── */

/**
 * 检查更新：直接查询 GitHub Releases 上的 **App** 新版本（不再经过路由器）。
 *
 * 结果与界面一一对应：
 * - 有更新：App 版本对比（本机 → 最新）、发布时间、notes 摘要，并提供
 *   「下载 APK」（交给系统浏览器 / 下载器）与「打开 Release 页」；
 * - 已是最新：显示「已是最新」与本机 / GitHub 最新 App 版本；
 * - 失败：网络 / 限流 / 仓库 / 无 APK 的中文提示，**不提示「请先连接路由器」**。
 *
 * 路由器插件版本在「关于」卡片单独展示；这里的比较只用 App versionName。
 * [onOpenUrl] 由调用方用系统浏览器 Intent 打开，本组件不内置下载 / 安装逻辑。
 */
@Composable
private fun UpdateBlock(
    ui: UiState,
    appVersionFallback: String,
    onCheck: () -> Unit,
    onOpenUrl: (String) -> Unit
) {
    val semantic = LocalPrismSemanticColors.current
    val update = ui.update
    val release = update.release
    /* 还没检查过时 UpdateState 里没有版本号：退回 PackageManager 的 versionName。 */
    val appVersion = update.appVersion.ifBlank { appVersionFallback }
    val checking = update.status == UpdateStatus.CHECKING

    Spacer(Modifier.height(PrismSpacing.md))
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    Spacer(Modifier.height(PrismSpacing.sm))

    InfoRow("本机 App", "v" + appVersion.ifBlank { "未知" })
    InfoRow("更新源", "GitHub Releases · ${GithubReleaseClient.REPO}")

    Spacer(Modifier.height(PrismSpacing.sm))
    OutlinedButton(
        onClick = onCheck,
        enabled = !checking,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = PrismSize.touchTarget)
    ) {
        Text(if (checking) "检查中…" else "检查更新")
    }
    Spacer(Modifier.height(PrismSpacing.sm))

    when (update.status) {
        UpdateStatus.IDLE -> Text(
            text = "从 GitHub Releases 检查 App 新版本；无需连接路由器。有新版本只提示，不自动安装。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        UpdateStatus.CHECKING -> LinearProgressIndicator(Modifier.fillMaxWidth())

        UpdateStatus.UPDATE_AVAILABLE -> UpdateAvailableBlock(release, appVersion, onOpenUrl)

        UpdateStatus.UP_TO_DATE -> Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)) {
            Text(
                text = "已是最新（本机 v${appVersion.ifBlank { "?" }}）",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = semantic.success
            )
            val published = formatPublishedAt(release?.publishedAt.orEmpty())
            Text(
                text = buildString {
                    append("GitHub 最新 App 版本 v").append(release?.displayVersion ?: "?")
                    if (published.isNotBlank()) append(" · 最新发布 ").append(published)
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        UpdateStatus.UNKNOWN -> Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)) {
            Text(
                text = "暂时无法判断版本",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = semantic.warning
            )
            Text(
                text = update.message ?: "GitHub 返回的版本号无法与本机 App 版本比较，请稍后重试。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        UpdateStatus.ERROR -> Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)) {
            val networkFailure = update.message?.startsWith("检查更新失败（网络）") == true
            Text(
                text = if (networkFailure) "网络不可用" else "检查更新失败",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.error
            )
            Text(
                text = update.message ?: "未知错误，请稍后重试。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}

/**
 * 有新版本时的详情：App 版本对比、发布时间、notes 摘要、APK 下载与 Release 页。
 *
 * 只展示 GitHub release 里的 APK（不再展示 IPK —— 插件包由插件自己的发布渠道提供）。
 * 打开动作由 [onOpenUrl] 交给系统浏览器 / DownloadManager，App 不请求存储或安装权限。
 */
@Composable
private fun UpdateAvailableBlock(
    release: GithubRelease?,
    appVersion: String,
    onOpenUrl: (String) -> Unit
) {
    if (release == null) {
        Text(
            text = "GitHub 返回的数据缺少 App 发版信息，请稍后重试。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        return
    }
    val published = formatPublishedAt(release.publishedAt)
    val summary = release.notesSummary()

    Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.xs)) {
        Text(
            text = "发现新版本 App v${release.displayVersion}",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary
        )
        Text(
            text = "App 版本 v${appVersion.ifBlank { "未知" }} → v${release.displayVersion}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (published.isNotBlank()) {
            Text(
                text = "发布时间 $published",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (summary.isNotBlank()) {
            Spacer(Modifier.height(PrismSpacing.xs))
            Text(
                text = summary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis
            )
        }

        if (release.hasApk) {
            Spacer(Modifier.height(PrismSpacing.sm))
            OutlinedButton(
                onClick = { onOpenUrl(release.apkUrl) },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text(
                    text = "下载 APK",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Text(
                text = "APK ${release.apkName}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }

        if (release.hasReleasePage) {
            Spacer(Modifier.height(PrismSpacing.sm))
            OutlinedButton(
                onClick = { onOpenUrl(release.htmlUrl) },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text("打开 Release 页")
            }
        }

        if (!release.hasApk && !release.hasReleasePage) {
            Text(
                text = "该 Release 没有提供 APK 或发布页链接，请到仓库页面手动获取。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
