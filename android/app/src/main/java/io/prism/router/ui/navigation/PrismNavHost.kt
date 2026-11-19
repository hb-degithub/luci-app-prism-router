package io.prism.router.ui.navigation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Apps
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lan
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import io.prism.router.data.MAX_SERVERS
import io.prism.router.data.MainViewModel
import io.prism.router.data.UiState
import io.prism.router.data.fmtClock
import io.prism.router.ui.AppsScreen
import io.prism.router.ui.DevicesScreen
import io.prism.router.ui.NetworkScreen
import io.prism.router.ui.OverviewScreen
import io.prism.router.ui.SettingsScreen
import io.prism.router.ui.WelcomeScreen
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.components.Segmented
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import io.prism.router.ui.theme.ThemeMode
import io.prism.router.ui.theme.isDynamicColorAvailable

/* ───────────────────────── 路由表 ───────────────────────── */

/** 所有路由字符串集中在这里，避免手写字符串散落各处。 */
object PrismRoutes {
    const val WELCOME = "welcome"

    /** 主图（含 5 个底部页签与设置子页）。 */
    const val MAIN = "main"

    const val OVERVIEW = "overview"
    const val DEVICES = "devices"
    const val APPS = "apps"
    const val NETWORK = "network"
    const val SETTINGS = "settings"

    const val SETTINGS_SERVERS = "settings/servers"
    const val SETTINGS_ABOUT = "settings/about"
}

/** 底部导航的 5 个一级目的地（Material 指南：≤5 项）。 */
enum class PrismDestination(
    val route: String,
    val label: String,
    val icon: ImageVector
) {
    OVERVIEW(PrismRoutes.OVERVIEW, "概览", Icons.Rounded.Speed),
    DEVICES(PrismRoutes.DEVICES, "设备", Icons.Rounded.Devices),
    APPS(PrismRoutes.APPS, "应用", Icons.Rounded.Apps),
    NETWORK(PrismRoutes.NETWORK, "网络", Icons.Rounded.Lan),
    SETTINGS(PrismRoutes.SETTINGS, "设置", Icons.Rounded.Settings)
}

/**
 * 底部页签切换：保留各页签的滚动位置 / 输入状态，返回栈保持「概览为根」。
 *
 * 用 `popUpTo(OVERVIEW)`（而不是图根）保证从任一页签按返回都能回到概览；
 * `saveState + restoreState` 让来回切换不丢列表位置。
 */
fun NavHostController.navigateToTab(destination: PrismDestination) {
    navigate(destination.route) {
        popUpTo(PrismRoutes.OVERVIEW) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

/* ───────────────────────── NavHost ───────────────────────── */

/**
 * 应用导航图。
 *
 * - 首次启动（未完成引导）以 [PrismRoutes.WELCOME] 为起始，完成后跳到主图；
 * - 主图内是 5 个一级页签 + 设置子页（servers / about）；
 * - 屏幕内容全部复用现有实现，本文件只负责 Scaffold、标题与导航接线。
 */
@Composable
fun PrismNavHost(
    vm: MainViewModel,
    navController: NavHostController,
    startWithWelcome: Boolean,
    themeMode: ThemeMode,
    dynamicColor: Boolean,
    onThemeModeChange: (ThemeMode) -> Unit,
    onDynamicColorChange: (Boolean) -> Unit,
    onOnboardingComplete: () -> Unit,
    modifier: Modifier = Modifier
) {
    val ui = vm.ui
    val startDestination = if (startWithWelcome) PrismRoutes.WELCOME else PrismRoutes.MAIN

    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier.fillMaxSize()
    ) {
        /* 首启引导：填地址 / 令牌 → 保存并进入概览；「稍后设置」直接进入。 */
        composable(PrismRoutes.WELCOME) {
            WelcomeScreen(
                defaultBaseUrl = ui.baseUrl,
                defaultToken = ui.token,
                onTest = { base, token, onResult ->
                    vm.testConnection(base, token, onResult)
                },
                onConnect = { base, token ->
                    vm.saveSettings(base, token, ui.intervalSec)
                    onOnboardingComplete()
                },
                onSkip = onOnboardingComplete
            )
        }

        navigation(startDestination = PrismRoutes.OVERVIEW, route = PrismRoutes.MAIN) {
            composable(PrismRoutes.OVERVIEW) {
                PrismScaffold(
                    title = "概览",
                    subtitle = overviewSubtitle(ui),
                    actions = {
                        PrismIconAction(
                            icon = Icons.Rounded.Refresh,
                            contentDescription = "刷新概览",
                            onClick = { vm.refresh() }
                        )
                    }
                ) { _ ->
                    OverviewScreen(
                        ui = ui,
                        onRefresh = { vm.refresh() },
                        onOpenDevices = {
                            navController.navigateToTab(PrismDestination.DEVICES)
                        }
                    )
                }
            }

            composable(PrismRoutes.DEVICES) {
                PrismScaffold(
                    title = "设备",
                    subtitle = devicesSubtitle(ui),
                    actions = {
                        PrismIconAction(
                            icon = Icons.Rounded.Refresh,
                            contentDescription = "刷新设备",
                            onClick = { vm.refresh() }
                        )
                    }
                ) { _ ->
                    DevicesScreen(ui)
                }
            }

            composable(PrismRoutes.APPS) {
                PrismScaffold(
                    title = "应用",
                    subtitle = "按域名统计 · 今日与近 7 天",
                    actions = {
                        PrismIconAction(
                            icon = Icons.Rounded.Refresh,
                            contentDescription = "刷新应用数据",
                            onClick = { vm.refresh() }
                        )
                    }
                ) { _ ->
                    AppsScreen(ui)
                }
            }

            composable(PrismRoutes.NETWORK) {
                PrismScaffold(
                    title = "网络",
                    subtitle = networkSubtitle(ui),
                    actions = {
                        PrismIconAction(
                            icon = Icons.Rounded.Refresh,
                            contentDescription = "刷新节点",
                            onClick = { vm.refreshNodes() }
                        )
                    }
                ) { _ ->
                    NetworkScreen(
                        ui = ui,
                        onRetryNodes = { vm.refreshNodes() }
                    )
                }
            }

            composable(PrismRoutes.SETTINGS) {
                PrismScaffold(
                    title = "设置",
                    subtitle = "服务器、外观与诊断",
                    actions = {
                        PrismIconAction(
                            icon = Icons.Rounded.Storage,
                            contentDescription = "服务器列表",
                            onClick = { navController.navigate(PrismRoutes.SETTINGS_SERVERS) }
                        )
                        PrismIconAction(
                            icon = Icons.Rounded.Info,
                            contentDescription = "关于",
                            onClick = { navController.navigate(PrismRoutes.SETTINGS_ABOUT) }
                        )
                    }
                ) { _ ->
                    SettingsScreen(
                        ui = ui,
                        onSave = { base, token, interval -> vm.saveSettings(base, token, interval) },
                        onTest = { base, token, onResult -> vm.testConnection(base, token, onResult) },
                        onRefresh = { vm.refresh() }
                    )
                }
            }

            /* 设置子页：地址列表只读预览（增删切换仍在设置页，后续任务升级）。 */
            composable(PrismRoutes.SETTINGS_SERVERS) {
                ServersRoute(
                    ui = ui,
                    onBack = { navController.popBackStack() }
                )
            }

            /* 设置子页：关于 + 外观（主题模式 / 动态取色开关）。 */
            composable(PrismRoutes.SETTINGS_ABOUT) {
                AboutRoute(
                    themeMode = themeMode,
                    dynamicColor = dynamicColor,
                    onThemeModeChange = onThemeModeChange,
                    onDynamicColorChange = onDynamicColorChange,
                    onBack = { navController.popBackStack() }
                )
            }
        }
    }
}

/* ───────────────────────── 标题副文案 ───────────────────────── */

private fun overviewSubtitle(ui: UiState): String = when {
    ui.offline -> "离线缓存 · ${fmtClock(ui.offlineAt)}"
    ui.updatedAt > 0L -> "实时监控 · 更新于 ${fmtClock(ui.updatedAt)}"
    else -> "正在连接面板…"
}

private fun devicesSubtitle(ui: UiState): String {
    val total = ui.state?.devices?.size ?: 0
    val online = ui.state?.onlineCount ?: 0
    return "$total 台设备 · 在线 $online"
}

private fun networkSubtitle(ui: UiState): String {
    val exits = ui.state?.nodes?.size ?: 0
    val subs = ui.nodesList.size
    return "拓扑与节点 · $exits 个出口 · $subs 个子节点"
}

/* ───────────────────────── 设置子页 ───────────────────────── */

@Composable
private fun ServersRoute(ui: UiState, onBack: () -> Unit) {
    PrismScaffold(
        title = "服务器",
        subtitle = "当前共 ${ui.servers.size} / $MAX_SERVERS 个地址",
        largeTitle = false,
        navigationIcon = { BackAction(onBack) }
    ) { _ ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(PrismSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(PrismSpacing.md)
        ) {
            SectionCard(
                title = "地址列表",
                subtitle = "点「设置」页可切换、编辑或删除；本页只读预览"
            ) {
                ui.servers.forEachIndexed { index, server ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = PrismSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = server.displayName,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                text = server.url,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        Spacer(Modifier.width(PrismSpacing.sm))
                        if (index == ui.activeIndex) {
                            Pill("当前", color = MaterialTheme.colorScheme.primary)
                        } else if (server.token.isNotBlank()) {
                            Pill("含令牌", color = MaterialTheme.colorScheme.onSurfaceVariant, leadingDot = false)
                        }
                    }
                    if (index != ui.servers.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(vertical = PrismSpacing.xs),
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                        )
                    }
                }
            }

            SectionCard(title = "编辑入口", subtitle = "为什么这里不能直接改？") {
                Text(
                    text = "面板地址、令牌与刷新间隔仍在「设置」页编辑，避免同一份配置出现两个写入入口。" +
                        "完整的多路由器管理（重命名 / 排序 / 批量删除）会在后续版本迁到这里。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            OutlinedButton(
                onClick = onBack,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text("返回设置")
            }
        }
    }
}

@Composable
private fun AboutRoute(
    themeMode: ThemeMode,
    dynamicColor: Boolean,
    onThemeModeChange: (ThemeMode) -> Unit,
    onDynamicColorChange: (Boolean) -> Unit,
    onBack: () -> Unit
) {
    PrismScaffold(
        title = "关于",
        subtitle = "外观、版本与数据来源",
        largeTitle = false,
        navigationIcon = { BackAction(onBack) }
    ) { _ ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(PrismSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(PrismSpacing.md)
        ) {
            SectionCard(title = "外观", subtitle = "主题与动态取色") {
                Segmented(
                    options = ThemeMode.entries,
                    selected = themeMode,
                    onSelect = onThemeModeChange,
                    label = { it.label },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(PrismSpacing.lg))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = "动态取色",
                            style = MaterialTheme.typography.titleMedium
                        )
                        Text(
                            text = if (isDynamicColorAvailable) {
                                "Android 12+ 跟随系统壁纸配色；关闭后固定品牌蓝 #3B5BFF"
                            } else {
                                "需要 Android 12 及以上系统，当前设备不支持"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Spacer(Modifier.width(PrismSpacing.sm))
                    Switch(
                        checked = dynamicColor && isDynamicColorAvailable,
                        onCheckedChange = onDynamicColorChange,
                        enabled = isDynamicColorAvailable
                    )
                }
                Spacer(Modifier.height(PrismSpacing.sm))
                Pill(
                    text = if (dynamicColor && isDynamicColorAvailable) "动态取色已开启" else "品牌蓝 #3B5BFF",
                    color = MaterialTheme.colorScheme.primary
                )
            }

            SectionCard(title = "关于棱镜路由", subtitle = "Android 原生客户端") {
                InfoLine("应用", "棱镜路由")
                InfoLine("版本", "1.0.0 (1)")
                InfoLine("数据来源", "路由器只读面板 /cgi-bin/panel-api")
                InfoLine("权限", "只读展示，不修改路由器配置")
            }

            OutlinedButton(
                onClick = onBack,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = PrismSize.touchTarget)
            ) {
                Text("返回设置")
            }
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
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
            modifier = Modifier.width(72.dp)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun BackAction(onBack: () -> Unit) {
    PrismIconAction(
        icon = Icons.AutoMirrored.Rounded.ArrowBack,
        contentDescription = "返回",
        onClick = onBack
    )
}
