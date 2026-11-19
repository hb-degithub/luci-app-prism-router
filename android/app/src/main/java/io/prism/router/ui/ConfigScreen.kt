package io.prism.router.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.prism.router.data.CONFIG_CONFIRM_PHRASE
import io.prism.router.data.CONFIG_SECTION_DHCP
import io.prism.router.data.CONFIG_SECTION_LAN
import io.prism.router.data.CONFIG_SECTION_SYSTEM
import io.prism.router.data.CONFIG_SECTION_WAN
import io.prism.router.data.COMMON_TIMEZONES
import io.prism.router.data.DhcpConfig
import io.prism.router.data.LanConfig
import io.prism.router.data.RedirectDraft
import io.prism.router.data.RedirectRule
import io.prism.router.data.RouterSystemConfig
import io.prism.router.data.UiState
import io.prism.router.data.WanConfig
import io.prism.router.data.WanProto
import io.prism.router.data.dhcpPoolError
import io.prism.router.data.isValidHostname
import io.prism.router.data.isValidIpv4
import io.prism.router.data.isValidLeasetime
import io.prism.router.data.isValidNetmask
import io.prism.router.data.parseDnsList
import io.prism.router.data.parsePortNumber
import io.prism.router.ui.components.ErrorState
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.components.Segmented
import io.prism.router.ui.theme.LocalPrismSemanticColors
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing

/* ───────────────────────── 分组 ───────────────────────── */

/**
 * 顶部 5 个分组。
 *
 * [label] 是分段控件的短文案：390dp 宽下 5 项各约 66dp，4 个汉字（“端口转发”）
 * 会被省略号截断，因此用「转发」，卡片标题里再写全称。
 * [section] 是 `config_set` / `config_rollback` 的后端分组名；端口转发没有分组级回滚，留空。
 */
private enum class ConfigTab(val label: String, val section: String) {
    LAN("LAN", CONFIG_SECTION_LAN),
    WAN("WAN", CONFIG_SECTION_WAN),
    DHCP("DHCP", CONFIG_SECTION_DHCP),
    SYSTEM("系统", CONFIG_SECTION_SYSTEM),
    REDIRECT("转发", "")
}

/** 端口转发的来源 / 目标区域：后端只接受 lan / wan。 */
private val ZONE_OPTIONS = listOf("lan", "wan")

/** 端口转发协议：契约示例只给了 tcp，这里同时提供 udp（tcp+udp 由后端按需扩展）。 */
private val PROTO_OPTIONS = listOf("tcp", "udp")

/* ───────────────────────── 屏幕 ───────────────────────── */

/**
 * 「网络配置」屏（登录后可用）：LAN / WAN / DHCP / 系统 / 端口转发。
 *
 * 数据流：
 * - 进屏读一次 `?action=config`（ViewModel 60 秒节流，写成功后强制重读）；
 * - 每个分组独立「保存」：前端先做 IP / 掩码 / 端口 / 主机名校验，通过后才弹二次确认
 *   （LAN 需输入 `APPLY`，与后端 `confirm` 一致）；
 * - 保存成功用 Snackbar 展示后端 `note`，失败按错误码映射中文；
 *   后端给了 `field` 时落到对应输入框（`fieldErrors`）；
 * - 「回滚」调 `config_rollback`，确认后恢复该分组最近一次备份。
 *
 * 令牌始终由 ViewModel 内存持有，本屏只通过回调触发操作，不接触令牌。
 */
@Composable
fun ConfigScreen(
    ui: UiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSaveLan: (LanConfig) -> Unit,
    onSaveWan: (WanConfig) -> Unit,
    onSaveDhcp: (DhcpConfig) -> Unit,
    onSaveSystem: (RouterSystemConfig) -> Unit,
    onAddRedirect: (RedirectDraft) -> Unit,
    onDeleteRedirect: (Int) -> Unit,
    onRollback: (String) -> Unit,
    onClearFeedback: () -> Unit = {},
    onConsumeNotice: () -> Unit = {}
) {
    val snackbarHostState = remember { SnackbarHostState() }
    var tabName by rememberSaveable { mutableStateOf(ConfigTab.LAN.name) }
    val tab = ConfigTab.entries.firstOrNull { it.name == tabName } ?: ConfigTab.LAN

    /* 进屏读一次；ViewModel 内部节流，写成功后由 ViewModel 自己再读。 */
    LaunchedEffect(Unit) { onRefresh() }

    /*
     * 写成功后的 note 用 Snackbar 展示：按序号触发，同一文案连续两次也会重新弹。
     * 先消费再弹（key 是序号，清 notice 不会重启效果），离开再回来不会重复弹旧提示。
     */
    LaunchedEffect(ui.config.noticeSeq) {
        val seq = ui.config.noticeSeq
        val notice = ui.config.notice ?: return@LaunchedEffect
        if (seq <= 0L) return@LaunchedEffect
        onConsumeNotice()
        snackbarHostState.showSnackbar(notice)
    }

    PrismScaffold(
        title = "网络配置",
        subtitle = "LAN / WAN / DHCP / 系统 / 端口转发",
        largeTitle = false,
        navigationIcon = {
            PrismIconAction(
                icon = Icons.AutoMirrored.Rounded.ArrowBack,
                contentDescription = "返回",
                onClick = onBack
            )
        },
        actions = {
            PrismIconAction(
                icon = Icons.Rounded.Refresh,
                contentDescription = "刷新配置",
                onClick = onRefresh,
                enabled = !ui.config.loading && !ui.config.saving
            )
        }
    ) { _ ->
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                Segmented(
                    options = ConfigTab.entries,
                    selected = tab,
                    onSelect = { option -> tabName = option.name },
                    label = { option -> option.label },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = PrismSpacing.lg, vertical = PrismSpacing.sm)
                )

                val data = ui.config.data
                val error = ui.config.error
                when {
                    !ui.adminLoggedIn -> LoginRequiredBlock(onBack = onBack)
                    data == null && error != null -> ErrorState(
                        msg = error,
                        title = "读取配置失败",
                        onRetry = onRefresh,
                        modifier = Modifier.fillMaxSize()
                    )

                    data == null -> LoadingBlock()
                    else -> ConfigBody(
                        ui = ui,
                        tab = tab,
                        onSaveLan = onSaveLan,
                        onSaveWan = onSaveWan,
                        onSaveDhcp = onSaveDhcp,
                        onSaveSystem = onSaveSystem,
                        onAddRedirect = onAddRedirect,
                        onDeleteRedirect = onDeleteRedirect,
                        onRollback = onRollback,
                        onClearFeedback = onClearFeedback
                    )
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
}

/* ───────────────────────── 内容区 ───────────────────────── */

@Composable
private fun ConfigBody(
    ui: UiState,
    tab: ConfigTab,
    onSaveLan: (LanConfig) -> Unit,
    onSaveWan: (WanConfig) -> Unit,
    onSaveDhcp: (DhcpConfig) -> Unit,
    onSaveSystem: (RouterSystemConfig) -> Unit,
    onAddRedirect: (RedirectDraft) -> Unit,
    onDeleteRedirect: (Int) -> Unit,
    onRollback: (String) -> Unit,
    onClearFeedback: () -> Unit
) {
    val data = ui.config.data ?: return
    val saving = ui.config.saving
    val fieldErrors = ui.config.fieldErrors
    /* DHCP 地址池提示要带上 LAN 网段前缀（192.168.100.）才看得懂。 */
    val lanBits = data.lan.ipaddr.trim().substringBeforeLast('.', "")
    val lanPrefix = if (lanBits.isBlank()) "" else "$lanBits."

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = PrismSpacing.lg, end = PrismSpacing.lg, bottom = PrismSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.lg)
    ) {
        ui.config.error?.let { message ->
            ErrorBanner(message)
        }

        when (tab) {
            ConfigTab.LAN -> LanForm(
                current = data.lan,
                reloadKey = ui.config.noticeSeq,
                fieldErrors = fieldErrors,
                saving = saving,
                onSave = onSaveLan,
                onRollback = { onRollback(CONFIG_SECTION_LAN) },
                onClearFeedback = onClearFeedback
            )

            ConfigTab.WAN -> WanForm(
                current = data.wan,
                reloadKey = ui.config.noticeSeq,
                fieldErrors = fieldErrors,
                saving = saving,
                onSave = onSaveWan,
                onRollback = { onRollback(CONFIG_SECTION_WAN) },
                onClearFeedback = onClearFeedback
            )

            ConfigTab.DHCP -> DhcpForm(
                current = data.dhcp,
                lanPrefix = lanPrefix,
                reloadKey = ui.config.noticeSeq,
                fieldErrors = fieldErrors,
                saving = saving,
                onSave = onSaveDhcp,
                onRollback = { onRollback(CONFIG_SECTION_DHCP) },
                onClearFeedback = onClearFeedback
            )

            ConfigTab.SYSTEM -> SystemForm(
                current = data.system,
                reloadKey = ui.config.noticeSeq,
                fieldErrors = fieldErrors,
                saving = saving,
                onSave = onSaveSystem,
                onRollback = { onRollback(CONFIG_SECTION_SYSTEM) },
                onClearFeedback = onClearFeedback
            )

            ConfigTab.REDIRECT -> RedirectSection(
                rules = data.redirects,
                fieldErrors = fieldErrors,
                saving = saving,
                addedSeq = ui.config.redirectAddedSeq,
                onAdd = onAddRedirect,
                onDelete = onDeleteRedirect,
                onClearFeedback = onClearFeedback
            )
        }
    }
}

/* ───────────────────────── LAN ───────────────────────── */

@Composable
private fun LanForm(
    current: LanConfig,
    reloadKey: Long,
    fieldErrors: Map<String, String>,
    saving: Boolean,
    onSave: (LanConfig) -> Unit,
    onRollback: () -> Unit,
    onClearFeedback: () -> Unit
) {
    val semantic = LocalPrismSemanticColors.current
    var ip by rememberSaveable(current, reloadKey) { mutableStateOf(current.ipaddr) }
    var mask by rememberSaveable(current, reloadKey) { mutableStateOf(current.netmask) }
    var gateway by rememberSaveable(current, reloadKey) { mutableStateOf(current.gateway) }
    var dns by rememberSaveable(current, reloadKey) { mutableStateOf(current.dnsText) }
    var showErrors by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var rollbackAsk by remember { mutableStateOf(false) }

    val dnsList = parseDnsList(dns)
    val ipOk = isValidIpv4(ip)
    val maskOk = isValidNetmask(mask)
    val gatewayOk = gateway.isBlank() || isValidIpv4(gateway)
    val dnsOk = dnsList.all { isValidIpv4(it) }

    fun edit() {
        showErrors = false
        if (fieldErrors.isNotEmpty()) onClearFeedback()
    }

    fun submit() {
        showErrors = true
        if (!ipOk || !maskOk || !gatewayOk || !dnsOk) return
        confirming = true
    }

    ConfigFormCard(
        title = "LAN",
        subtitle = "路由器局域网地址（保存后会断开当前连接）",
        saving = saving,
        onSave = { submit() },
        onRollback = { rollbackAsk = true }
    ) {
        ConfigField(
            value = ip,
            onValueChange = { ip = it; edit() },
            label = "IP 地址",
            placeholder = "192.168.100.1",
            supporting = "路由器 LAN 口地址；其它设备也用它访问面板",
            error = fieldErrors["ipaddr"]
                ?: if (showErrors && !ipOk) "请输入合法的 IPv4 地址" else null,
            enabled = !saving
        )
        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = mask,
            onValueChange = { mask = it; edit() },
            label = "子网掩码",
            placeholder = "255.255.255.0",
            supporting = "点分格式，要求连续的 1 后接连续的 0",
            error = fieldErrors["netmask"]
                ?: if (showErrors && !maskOk) "子网掩码不正确（例如 255.255.255.0）" else null,
            enabled = !saving
        )
        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = gateway,
            onValueChange = { gateway = it; edit() },
            label = "网关（可留空）",
            placeholder = "192.168.100.1",
            supporting = "留空表示由路由器按 LAN 地址自动推断",
            error = fieldErrors["gateway"]
                ?: if (showErrors && !gatewayOk) "网关需为合法的 IPv4 地址" else null,
            enabled = !saving
        )
        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = dns,
            onValueChange = { dns = it; edit() },
            label = "DNS（多值用逗号分隔）",
            placeholder = "223.5.5.5, 114.114.114.114",
            supporting = "例如 223.5.5.5, 114.114.114.114",
            error = fieldErrors["dns"]
                ?: if (showErrors && !dnsOk) "DNS 需为 IPv4 地址，多个用逗号分隔" else null,
            enabled = !saving
        )

        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigNote(
            text = "修改 LAN 地址会断开当前连接：保存后本机需用新地址重新访问，局域网内其它设备也要重新获取地址。",
            color = semantic.warning
        )
    }

    if (confirming) {
        ApplyConfirmDialog(
            title = "修改 LAN 地址",
            message = "修改 LAN 地址会断开当前连接，需用新地址重连；局域网内其它设备会短暂掉线。",
            detail = "新地址：$ip / $mask",
            onConfirm = {
                confirming = false
                onSave(
                    LanConfig(
                        ipaddr = ip.trim(),
                        netmask = mask.trim(),
                        gateway = gateway.trim(),
                        dns = dnsList
                    )
                )
            },
            onDismiss = { confirming = false }
        )
    }

    if (rollbackAsk) {
        ConfigConfirmDialog(
            title = "回滚 LAN 配置",
            message = "将恢复 LAN 分组最近一次备份。恢复后地址可能变化，本机需要重新连接。",
            confirmLabel = "回滚",
            destructive = true,
            onConfirm = {
                rollbackAsk = false
                onRollback()
            },
            onDismiss = { rollbackAsk = false }
        )
    }
}

/* ───────────────────────── WAN ───────────────────────── */

@Composable
private fun WanForm(
    current: WanConfig,
    reloadKey: Long,
    fieldErrors: Map<String, String>,
    saving: Boolean,
    onSave: (WanConfig) -> Unit,
    onRollback: () -> Unit,
    onClearFeedback: () -> Unit
) {
    var protoName by rememberSaveable(current, reloadKey) { mutableStateOf(current.protoType.name) }
    var ip by rememberSaveable(current, reloadKey) { mutableStateOf(current.ipaddr) }
    var mask by rememberSaveable(current, reloadKey) { mutableStateOf(current.netmask) }
    var gateway by rememberSaveable(current, reloadKey) { mutableStateOf(current.gateway) }
    var dns by rememberSaveable(current, reloadKey) { mutableStateOf(current.dnsText) }
    var showErrors by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var rollbackAsk by remember { mutableStateOf(false) }

    val proto = WanProto.entries.firstOrNull { it.name == protoName } ?: WanProto.DHCP
    val static = proto == WanProto.STATIC
    val dnsList = parseDnsList(dns)
    val ipOk = !static || isValidIpv4(ip)
    val maskOk = !static || isValidNetmask(mask)
    val gatewayOk = !static || gateway.isBlank() || isValidIpv4(gateway)
    val dnsOk = !static || dnsList.all { isValidIpv4(it) }

    fun edit() {
        showErrors = false
        if (fieldErrors.isNotEmpty()) onClearFeedback()
    }

    fun submit() {
        showErrors = true
        if (!ipOk || !maskOk || !gatewayOk || !dnsOk) return
        confirming = true
    }

    ConfigFormCard(
        title = "WAN",
        subtitle = "外网接入方式${if (current.device.isBlank()) "" else " · 接口 ${current.device}"}",
        saving = saving,
        onSave = { submit() },
        onRollback = { rollbackAsk = true }
    ) {
        Text(
            text = "协议",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(PrismSpacing.sm))
        Segmented(
            options = WanProto.entries,
            selected = proto,
            onSelect = { selected ->
                protoName = selected.name
                showErrors = false
                if (fieldErrors.isNotEmpty()) onClearFeedback()
            },
            label = { option -> option.label },
            enabled = !saving,
            modifier = Modifier.fillMaxWidth()
        )

        if (static) {
            Spacer(Modifier.height(PrismSpacing.md))
            ConfigField(
                value = ip,
                onValueChange = { ip = it; edit() },
                label = "IP 地址",
                placeholder = "192.168.1.2",
                error = fieldErrors["ipaddr"]
                    ?: if (showErrors && !ipOk) "请输入合法的 IPv4 地址" else null,
                enabled = !saving
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            ConfigField(
                value = mask,
                onValueChange = { mask = it; edit() },
                label = "子网掩码",
                placeholder = "255.255.255.0",
                error = fieldErrors["netmask"]
                    ?: if (showErrors && !maskOk) "子网掩码不正确（例如 255.255.255.0）" else null,
                enabled = !saving
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            ConfigField(
                value = gateway,
                onValueChange = { gateway = it; edit() },
                label = "网关",
                placeholder = "192.168.1.1",
                error = fieldErrors["gateway"]
                    ?: if (showErrors && !gatewayOk) "网关需为合法的 IPv4 地址" else null,
                enabled = !saving
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            ConfigField(
                value = dns,
                onValueChange = { dns = it; edit() },
                label = "DNS（多值用逗号分隔）",
                placeholder = "223.5.5.5, 114.114.114.114",
                error = fieldErrors["dns"]
                    ?: if (showErrors && !dnsOk) "DNS 需为 IPv4 地址，多个用逗号分隔" else null,
                enabled = !saving
            )
        } else {
            Spacer(Modifier.height(PrismSpacing.md))
            ConfigNote(
                text = if (proto == WanProto.NONE) {
                    "选择「无」后 WAN 口不再自动获取地址，路由器只能通过 LAN 访问。"
                } else {
                    "DHCP 模式下地址 / 网关 / DNS 由上游自动下发，下列信息只读；" +
                        "当前地址 ${current.ipaddr.ifBlank { "未获取" }}。"
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (current.gateway.isNotBlank()) {
                Spacer(Modifier.height(PrismSpacing.xs))
                InfoText("网关", current.gateway)
            }
            if (current.ipaddr.isNotBlank()) {
                InfoText("IP 地址", current.ipaddr)
            }
            if (current.dns.isNotEmpty()) {
                InfoText("DNS", current.dns.joinToString(", "))
            }
        }
    }

    if (confirming) {
        ApplyConfirmDialog(
            title = "修改 WAN 设置",
            message = "保存后 WAN 会重新协商，外网可能中断约 5–10 秒；正在进行的连接会断开。",
            detail = "协议：${proto.label}",
            onConfirm = {
                confirming = false
                onSave(
                    WanConfig(
                        proto = proto.wire,
                        device = current.device,
                        ipaddr = if (static) ip.trim() else current.ipaddr,
                        netmask = if (static) mask.trim() else current.netmask,
                        gateway = if (static) gateway.trim() else current.gateway,
                        dns = if (static) dnsList else current.dns
                    )
                )
            },
            onDismiss = { confirming = false }
        )
    }

    if (rollbackAsk) {
        ConfigConfirmDialog(
            title = "回滚 WAN 配置",
            message = "将恢复 WAN 分组最近一次备份，外网可能短暂中断。",
            confirmLabel = "回滚",
            destructive = true,
            onConfirm = {
                rollbackAsk = false
                onRollback()
            },
            onDismiss = { rollbackAsk = false }
        )
    }
}

/* ───────────────────────── DHCP ───────────────────────── */

@Composable
private fun DhcpForm(
    current: DhcpConfig,
    lanPrefix: String,
    reloadKey: Long,
    fieldErrors: Map<String, String>,
    saving: Boolean,
    onSave: (DhcpConfig) -> Unit,
    onRollback: () -> Unit,
    onClearFeedback: () -> Unit
) {
    val semantic = LocalPrismSemanticColors.current
    var enabled by rememberSaveable(current, reloadKey) { mutableStateOf(current.enabled) }
    var start by rememberSaveable(current, reloadKey) { mutableStateOf(current.start) }
    var limit by rememberSaveable(current, reloadKey) { mutableStateOf(current.limit) }
    var leasetime by rememberSaveable(current, reloadKey) { mutableStateOf(current.leasetime) }
    var showErrors by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var rollbackAsk by remember { mutableStateOf(false) }

    val startValue = start.trim().toIntOrNull()
    val limitValue = limit.trim().toIntOrNull()
    val startOk = startValue != null && startValue in 1..254 && start.trim().all { it.isDigit() }
    val limitOk = limitValue != null && limitValue in 1..254 && limit.trim().all { it.isDigit() }
    val poolError = dhcpPoolError(start, limit)
    val poolOk = startOk && limitOk && poolError == null
    val poolEnd = if (poolOk) (startValue ?: 0) + (limitValue ?: 0) - 1 else null
    val leaseOk = isValidLeasetime(leasetime)

    fun edit() {
        showErrors = false
        if (fieldErrors.isNotEmpty()) onClearFeedback()
    }

    fun submit() {
        showErrors = true
        if (!poolOk || !leaseOk) return
        confirming = true
    }

    ConfigFormCard(
        title = "DHCP",
        subtitle = "局域网地址分配（dnsmasq）",
        saving = saving,
        onSave = { submit() },
        onRollback = { rollbackAsk = true }
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PrismSize.touchTarget)
                .clip(RoundedCornerShape(PrismRadius.small))
                .toggleable(
                    value = enabled,
                    enabled = !saving,
                    role = Role.Switch
                ) { checked ->
                    enabled = checked
                    edit()
                }
                .padding(vertical = PrismSpacing.sm),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = "启用 DHCP 服务",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = if (enabled) "客户端可自动获取地址与网关" else "关闭后客户端必须手动配置地址",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(Modifier.width(PrismSpacing.sm))
            Switch(checked = enabled, onCheckedChange = null, enabled = !saving)
        }

        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = start,
            onValueChange = { start = it; edit() },
            label = "地址池起始（最后一个八位组）",
            placeholder = "100",
            supporting = "例如 100 表示从 192.168.x.100 开始分配",
            error = fieldErrors["start"]
                ?: if (showErrors && !startOk) "起始地址需为 1–254 的数字" else null,
            enabled = !saving,
            keyboardType = KeyboardType.Number
        )
        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = limit,
            onValueChange = { limit = it; edit() },
            label = "地址数量",
            placeholder = "150",
            supporting = "1–254；起始 + 数量 - 1 不能超过 254",
            error = fieldErrors["limit"]
                ?: if (showErrors && !limitOk) {
                    "地址数量需为 1–254 的数字"
                } else if (showErrors && startOk && limitOk && poolError != null) {
                    "起始 + 数量 - 1 不能大于 254"
                } else {
                    null
                },
            enabled = !saving,
            keyboardType = KeyboardType.Number
        )
        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = leasetime,
            onValueChange = { leasetime = it; edit() },
            label = "租期",
            placeholder = "12h",
            supporting = "支持 12h / 30m / 1d / 43200 / infinite",
            error = fieldErrors["leasetime"]
                ?: if (showErrors && !leaseOk) "租期格式不正确（例如 12h / 30m / 1d）" else null,
            enabled = !saving
        )

        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigNote(
            text = if (poolEnd != null) {
                "地址池：$lanPrefix${start.trim()} – $lanPrefix$poolEnd" +
                    "（共 $limitValue 个地址，租期 ${leasetime.trim().ifBlank { "—" }}）"
            } else {
                "地址池结束地址 = LAN 网段 .起始 + 数量 - 1；填写合法后这里会显示完整范围"
            },
            color = semantic.info
        )
    }

    if (confirming) {
        ApplyConfirmDialog(
            title = "修改 DHCP 设置",
            message = "保存后 DHCP 服务会重启，已连接的客户端会续租（通常无感）。",
            detail = "地址池：$start 起，共 $limit 个，租期 $leasetime",
            onConfirm = {
                confirming = false
                onSave(
                    DhcpConfig(
                        enabled = enabled,
                        start = start.trim(),
                        limit = limit.trim(),
                        leasetime = leasetime.trim()
                    )
                )
            },
            onDismiss = { confirming = false }
        )
    }

    if (rollbackAsk) {
        ConfigConfirmDialog(
            title = "回滚 DHCP 配置",
            message = "将恢复 DHCP 分组最近一次备份。",
            confirmLabel = "回滚",
            destructive = true,
            onConfirm = {
                rollbackAsk = false
                onRollback()
            },
            onDismiss = { rollbackAsk = false }
        )
    }
}

/* ───────────────────────── 系统 ───────────────────────── */

@Composable
private fun SystemForm(
    current: RouterSystemConfig,
    reloadKey: Long,
    fieldErrors: Map<String, String>,
    saving: Boolean,
    onSave: (RouterSystemConfig) -> Unit,
    onRollback: () -> Unit,
    onClearFeedback: () -> Unit
) {
    var hostname by rememberSaveable(current, reloadKey) { mutableStateOf(current.hostname) }
    var timezone by rememberSaveable(current, reloadKey) { mutableStateOf(current.timezone) }
    var zonename by rememberSaveable(current, reloadKey) { mutableStateOf(current.zonename) }
    var showErrors by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var rollbackAsk by remember { mutableStateOf(false) }
    var tzMenu by remember { mutableStateOf(false) }

    val hostnameOk = isValidHostname(hostname)
    val timezoneOk = timezone.trim().isNotEmpty()
    val zonenameOk = zonename.trim().isNotEmpty()

    fun edit() {
        showErrors = false
        if (fieldErrors.isNotEmpty()) onClearFeedback()
    }

    fun submit() {
        showErrors = true
        if (!hostnameOk || !timezoneOk || !zonenameOk) return
        confirming = true
    }

    ConfigFormCard(
        title = "系统",
        subtitle = "主机名与时区（保存后部分服务会重载）",
        saving = saving,
        onSave = { submit() },
        onRollback = { rollbackAsk = true }
    ) {
        ConfigField(
            value = hostname,
            onValueChange = { hostname = it; edit() },
            label = "主机名",
            placeholder = "iStoreOS",
            supporting = "1–63 位字母、数字或 -，首尾不能是 -",
            error = fieldErrors["hostname"]
                ?: if (showErrors && !hostnameOk) "主机名不合法（字母 / 数字 / -，首尾不能是 -）" else null,
            enabled = !saving
        )

        Spacer(Modifier.height(PrismSpacing.md))
        Row(verticalAlignment = Alignment.CenterVertically) {
            ConfigField(
                value = zonename,
                onValueChange = { zonename = it; edit() },
                label = "时区名称（IANA）",
                placeholder = "Asia/Shanghai",
                supporting = "点右侧箭头可从常用时区里选",
                error = fieldErrors["zonename"]
                    ?: if (showErrors && !zonenameOk) "请填写时区名称" else null,
                enabled = !saving,
                modifier = Modifier.weight(1f)
            )
            Box {
                IconButton(
                    onClick = { tzMenu = true },
                    enabled = !saving,
                    modifier = Modifier.size(PrismSize.touchTarget)
                ) {
                    Icon(
                        imageVector = Icons.Rounded.ArrowDropDown,
                        contentDescription = "选择常用时区"
                    )
                }
                DropdownMenu(expanded = tzMenu, onDismissRequest = { tzMenu = false }) {
                    COMMON_TIMEZONES.forEach { option ->
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(
                                        text = option.zone,
                                        style = MaterialTheme.typography.bodyMedium
                                    )
                                    Text(
                                        text = option.posix,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            },
                            onClick = {
                                zonename = option.zone
                                timezone = option.posix
                                tzMenu = false
                                edit()
                            }
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(PrismSpacing.sm))
        ConfigField(
            value = timezone,
            onValueChange = { timezone = it; edit() },
            label = "时区（POSIX TZ）",
            placeholder = "CST-8",
            supporting = "OpenWrt 使用的 POSIX 写法，例如 CST-8",
            error = fieldErrors["timezone"]
                ?: if (showErrors && !timezoneOk) "请填写 POSIX 时区（例如 CST-8）" else null,
            enabled = !saving
        )
    }

    if (confirming) {
        ApplyConfirmDialog(
            title = "修改系统设置",
            message = "保存后主机名与时区会立即生效，部分服务会重载。",
            detail = "主机名：${hostname.trim()}",
            onConfirm = {
                confirming = false
                onSave(
                    RouterSystemConfig(
                        hostname = hostname.trim(),
                        timezone = timezone.trim(),
                        zonename = zonename.trim()
                    )
                )
            },
            onDismiss = { confirming = false }
        )
    }

    if (rollbackAsk) {
        ConfigConfirmDialog(
            title = "回滚系统配置",
            message = "将恢复系统分组最近一次备份（主机名 / 时区）。",
            confirmLabel = "回滚",
            destructive = true,
            onConfirm = {
                rollbackAsk = false
                onRollback()
            },
            onDismiss = { rollbackAsk = false }
        )
    }
}

/* ───────────────────────── 端口转发 ───────────────────────── */

@Composable
private fun RedirectSection(
    rules: List<RedirectRule>,
    fieldErrors: Map<String, String>,
    saving: Boolean,
    addedSeq: Long,
    onAdd: (RedirectDraft) -> Unit,
    onDelete: (Int) -> Unit,
    onClearFeedback: () -> Unit
) {
    var name by rememberSaveable { mutableStateOf("") }
    var src by rememberSaveable { mutableStateOf("lan") }
    var dest by rememberSaveable { mutableStateOf("lan") }
    var srcDport by rememberSaveable { mutableStateOf("") }
    var destIp by rememberSaveable { mutableStateOf("") }
    var destPort by rememberSaveable { mutableStateOf("") }
    var proto by rememberSaveable { mutableStateOf("tcp") }
    var showErrors by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<RedirectRule?>(null) }

    /* 新增成功后清空表单；失败时保留用户输入，方便照着错误改。 */
    var handledAddSeq by remember { mutableStateOf(addedSeq) }
    LaunchedEffect(addedSeq) {
        if (addedSeq > handledAddSeq) {
            handledAddSeq = addedSeq
            name = ""
            srcDport = ""
            destIp = ""
            destPort = ""
            showErrors = false
        }
    }

    val srcPortOk = parsePortNumber(srcDport) != null
    val destIpOk = isValidIpv4(destIp)
    val destPortOk = parsePortNumber(destPort) != null

    fun edit() {
        showErrors = false
        if (fieldErrors.isNotEmpty()) onClearFeedback()
    }

    fun submit() {
        showErrors = true
        if (!srcPortOk || !destIpOk || !destPortOk) return
        onAdd(
            RedirectDraft(
                name = name.trim(),
                src = src,
                dest = dest,
                srcDport = srcDport.trim(),
                destIp = destIp.trim(),
                destPort = destPort.trim(),
                proto = proto
            )
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.lg)) {
        SectionCard(
            title = "端口转发",
            subtitle = when {
                saving -> "正在提交…"
                rules.isEmpty() -> "暂无规则"
                else -> "共 ${rules.size} 条规则"
            }
        ) {
            if (rules.isEmpty()) {
                Text(
                    text = "还没有端口转发规则。在下方填写「源端口 → 目标 IP:端口」即可新增。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                rules.forEachIndexed { index, rule ->
                    RedirectRow(
                        rule = rule,
                        enabled = !saving,
                        onDelete = { pendingDelete = rule }
                    )
                    if (index != rules.lastIndex) {
                        HorizontalDivider(
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                        )
                    }
                }
            }
        }

        SectionCard(
            title = "添加规则",
            subtitle = "外网端口 → 内网 IP:端口"
        ) {
            ConfigField(
                value = name,
                onValueChange = { name = it; edit() },
                label = "名称（可留空）",
                placeholder = "NAS 面板",
                error = fieldErrors["name"],
                enabled = !saving
            )

            Spacer(Modifier.height(PrismSpacing.md))
            Text(
                text = "协议",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            Segmented(
                options = PROTO_OPTIONS,
                selected = proto,
                onSelect = { proto = it; edit() },
                label = { it.uppercase() },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(Modifier.height(PrismSpacing.md))
            ConfigField(
                value = srcDport,
                onValueChange = { srcDport = it; edit() },
                label = "源端口",
                placeholder = "8080",
                supporting = "路由器对外暴露的端口（1–65535）",
                error = fieldErrors["src_dport"]
                    ?: if (showErrors && !srcPortOk) "端口不合法（1–65535）" else null,
                enabled = !saving,
                keyboardType = KeyboardType.Number
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            ConfigField(
                value = destIp,
                onValueChange = { destIp = it; edit() },
                label = "目标 IP",
                placeholder = "192.168.100.10",
                error = fieldErrors["dest_ip"]
                    ?: if (showErrors && !destIpOk) "请输入合法的 IPv4 地址" else null,
                enabled = !saving
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            ConfigField(
                value = destPort,
                onValueChange = { destPort = it; edit() },
                label = "目标端口",
                placeholder = "8080",
                error = fieldErrors["dest_port"]
                    ?: if (showErrors && !destPortOk) "端口不合法（1–65535）" else null,
                enabled = !saving,
                keyboardType = KeyboardType.Number
            )

            Spacer(Modifier.height(PrismSpacing.md))
            Text(
                text = "来源区域",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            Segmented(
                options = ZONE_OPTIONS,
                selected = src,
                onSelect = { src = it; edit() },
                label = { if (it == "lan") "LAN" else "WAN" },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            Text(
                text = "目标区域",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(PrismSpacing.sm))
            Segmented(
                options = ZONE_OPTIONS,
                selected = dest,
                onSelect = { dest = it; edit() },
                label = { if (it == "lan") "LAN" else "WAN" },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth()
            )

            if (saving) {
                Spacer(Modifier.height(PrismSpacing.sm))
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }

            Spacer(Modifier.height(PrismSpacing.md))
            Button(
                onClick = { submit() },
                enabled = !saving,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text(if (saving) "提交中…" else "添加")
            }
            Spacer(Modifier.height(PrismSpacing.sm))
            ConfigNote(
                text = "新增规则会立即生效；端口转发列表不提供分组回滚，删除单条规则即可撤销。",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }

    pendingDelete?.let { rule ->
        ConfigConfirmDialog(
            title = "删除端口转发",
            message = "确定删除「${rule.displayName}」吗？删除后该端口的访问会立即失效。",
            detail = "${rule.srcLabel}:${rule.srcDport} → ${rule.targetText}（${rule.protoLabel}）",
            confirmLabel = "删除",
            destructive = true,
            onConfirm = {
                pendingDelete = null
                onDelete(rule.index)
            },
            onDismiss = { pendingDelete = null }
        )
    }
}

@Composable
private fun RedirectRow(
    rule: RedirectRule,
    enabled: Boolean,
    onDelete: () -> Unit
) {
    val semantic = LocalPrismSemanticColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(vertical = PrismSpacing.sm),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = rule.displayName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(
                    text = rule.protoLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(Modifier.width(PrismSpacing.sm))
                Text(
                    text = if (rule.enabled) "启用" else "已停用",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (rule.enabled) semantic.success else semantic.neutral
                )
            }
            Text(
                text = "${rule.srcLabel} : ${rule.srcDport} → ${rule.targetText} · 目标 ${rule.destLabel}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(PrismSpacing.sm))
        IconButton(
            onClick = onDelete,
            enabled = enabled,
            modifier = Modifier.size(PrismSize.touchTarget)
        ) {
            Icon(
                imageVector = Icons.Rounded.DeleteOutline,
                contentDescription = "删除规则 ${rule.displayName}",
                tint = MaterialTheme.colorScheme.error
            )
        }
    }
}

/* ───────────────────────── 通用小件 ───────────────────────── */

/** 分组卡片：标题 + 内容 + 「保存 / 回滚」按钮 + 保存中的进度条。 */
@Composable
private fun ConfigFormCard(
    title: String,
    subtitle: String,
    saving: Boolean,
    onSave: () -> Unit,
    onRollback: (() -> Unit)?,
    content: @Composable ColumnScope.() -> Unit
) {
    SectionCard(title = title, subtitle = subtitle) {
        content()

        if (saving) {
            Spacer(Modifier.height(PrismSpacing.sm))
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }

        Spacer(Modifier.height(PrismSpacing.md))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
        ) {
            Button(
                onClick = onSave,
                enabled = !saving,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text(if (saving) "保存中…" else "保存")
            }
            if (onRollback != null) {
                OutlinedButton(
                    onClick = onRollback,
                    enabled = !saving,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = PrismSize.touchTarget)
                ) {
                    Text("回滚")
                }
            }
        }
    }
}

/** 单行输入框：错误优先于说明文案，错误时边框转红。 */
@Composable
private fun ConfigField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    supporting: String? = null,
    error: String? = null,
    enabled: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text
) {
    val hint = error ?: supporting
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = if (placeholder != null) {
            { Text(placeholder) }
        } else {
            null
        },
        isError = error != null,
        supportingText = if (hint != null) {
            { Text(hint) }
        } else {
            null
        },
        singleLine = true,
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        modifier = modifier.fillMaxWidth()
    )
}

/** 卡片内的一条提示（风险 / 说明），深色下同样可读。 */
@Composable
private fun ConfigNote(text: String, color: Color) {
    Surface(
        shape = RoundedCornerShape(PrismRadius.small),
        color = color.copy(alpha = 0.10f),
        contentColor = color
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = color,
            modifier = Modifier.padding(PrismSpacing.sm)
        )
    }
}

/** 只读信息行（LAN / WAN 当前值）。 */
@Composable
private fun InfoText(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
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
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f)
        )
    }
}

/** 分组级错误条（网络失败 / 登录过期 / 后端 internal）。 */
@Composable
private fun ErrorBanner(message: String) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.md),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Rounded.ErrorOutline,
                contentDescription = null,
                modifier = Modifier.size(PrismSize.icon)
            )
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

/**
 * 保存类二次确认：固定要求输入 `APPLY`（与后端 `confirm` 校验一致）。
 *
 * 输入框状态放在本组件内部：每次打开都是空的，关闭即丢弃，不参与页面状态恢复。
 */
@Composable
private fun ApplyConfirmDialog(
    title: String,
    message: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    detail: String? = null
) {
    var phrase by remember { mutableStateOf("") }
    ConfigConfirmDialog(
        title = title,
        message = message,
        detail = detail,
        confirmLabel = "应用",
        destructive = true,
        requirePhrase = CONFIG_CONFIRM_PHRASE,
        phrase = phrase,
        onPhraseChange = { phrase = it },
        onConfirm = {
            if (phrase.trim() == CONFIG_CONFIRM_PHRASE) onConfirm()
        },
        onDismiss = onDismiss
    )
}

/** 二次确认弹层：可要求输入 APPLY（与后端 confirm 校验一致）。 */
@Composable
private fun ConfigConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    detail: String? = null,
    destructive: Boolean = false,
    requirePhrase: String? = null,
    phrase: String = "",
    onPhraseChange: (String) -> Unit = {}
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)) {
                Text(text = message, style = MaterialTheme.typography.bodyMedium)
                if (detail != null) {
                    Text(
                        text = detail,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (requirePhrase != null) {
                    Text(
                        text = "请输入 $requirePhrase 确认：",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = phrase,
                        onValueChange = onPhraseChange,
                        singleLine = true,
                        placeholder = { Text(requirePhrase) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = requirePhrase == null || phrase.trim() == requirePhrase,
                modifier = Modifier.heightIn(min = PrismSize.touchTarget)
            ) {
                Text(
                    text = confirmLabel,
                    color = if (destructive) {
                        MaterialTheme.colorScheme.error
                    } else {
                        Color.Unspecified
                    }
                )
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.heightIn(min = PrismSize.touchTarget)
            ) {
                Text("取消")
            }
        }
    )
}

/** 未登录：入口仍然可达（令牌过期 / 从深链进来），但只提示去设置页登录。 */
@Composable
private fun LoginRequiredBlock(onBack: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(PrismSpacing.lg),
        contentAlignment = Alignment.TopCenter
    ) {
        SectionCard(
            title = "需要管理员登录",
            subtitle = "网络配置会改写路由器设置"
        ) {
            Text(
                text = "请在「设置 → 管理员」用 root 密码登录后再进入本页。" +
                    "管理令牌只保存在内存，退出登录或切换服务器即失效。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(PrismSpacing.md))
            OutlinedButton(
                onClick = onBack,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text("返回设置去登录")
            }
        }
    }
}

/** 首屏加载：居中进度（只在 data 为空时出现，避免刷新时闪烁）。 */
@Composable
private fun LoadingBlock() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Spacer(Modifier.height(PrismSpacing.md))
            Text(
                text = "正在读取路由器配置…",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
