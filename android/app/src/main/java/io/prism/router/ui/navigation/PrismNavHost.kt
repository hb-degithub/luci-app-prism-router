package io.prism.router.ui.navigation

import android.os.Build
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
import androidx.compose.material.icons.rounded.Lan
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import androidx.navigation.createGraph
import androidx.navigation.navArgument
import io.prism.router.data.Device
import io.prism.router.data.MAX_SERVERS
import io.prism.router.data.MainViewModel
import io.prism.router.data.UiState
import io.prism.router.data.normalizeMac
import io.prism.router.ui.AppsScreen
import io.prism.router.ui.ConfigScreen
import io.prism.router.ui.DeviceDetailScreen
import io.prism.router.ui.DevicesScreen
import io.prism.router.ui.NetworkScreen
import io.prism.router.ui.OverviewScreen
import io.prism.router.ui.SettingsScreen
import io.prism.router.ui.WelcomeScreen
import io.prism.router.ui.components.Pill
import io.prism.router.ui.components.PrismIconAction
import io.prism.router.ui.components.PrismScaffold
import io.prism.router.ui.components.SectionCard
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing
import io.prism.router.ui.theme.ThemeMode
import io.prism.router.ui.DeviceRouteCodec

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

    /** 网络配置（LAN / WAN / DHCP / 系统 / 端口转发），仅管理员登录后可用。 */
    const val SETTINGS_CONFIG = "settings/config"

    /** 设备详情：路径参数是规范化后的 MAC（冒号编码为 %3A）。 */
    const val DEVICE_DETAIL = "device/{mac}"
    const val DEVICE_DETAIL_ARG = "mac"

    /**
     * 设备详情路由占位符：MAC 为空（无法作为路径参数）时使用。
     * 详情页会把该占位符当成「设备已不在当前列表」展示，而不是崩溃 / 白屏。
     */
    const val DEVICE_DETAIL_UNKNOWN = "-"

    /**
     * 构建设备详情路由（`device/{mac}`）。
     *
     * 先按后端 / [io.prism.router.data.normalizeMac] 的规则归一化（大写、冒号分隔），
     * 再做百分号编码：冒号必须编码成 `%3A`，否则会被 Uri 解析成 scheme 分隔符。
     * 路由里只放 MAC，绝不放 token / 面板地址等敏感数据。
     */
    fun deviceDetailRoute(mac: String): String {
        /* 严格 MAC 编码；空/非法值进入受控的“设备不可用”空态，不构造歧义路由。 */
        return "device/" + (DeviceRouteCodec.encode(mac) ?: DEVICE_DETAIL_UNKNOWN)
    }
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

/**
 * 打开设备详情。
 *
 * MAC 是唯一路由键：没有 MAC 的设备无法定位到详情，退回设备页签而不是跳非法路由。
 * 正常路径由设备页 / 概览的点击回调触发，此前已按 [normalizeMac] 判空。
 */
private fun NavHostController.openDeviceDetail(device: Device) {
    if (normalizeMac(device.mac).isBlank()) {
        navigateToTab(PrismDestination.DEVICES)
        return
    }
    navigate(PrismRoutes.deviceDetailRoute(device.mac)) {
        /* 慢机/双击不能把同一台设备压栈两次，否则返回时仍停在相同详情页。 */
        launchSingleTop = true
    }
}

/** 详情页返回：优先弹回上一页（设备列表 / 概览），返回栈异常时兜底回设备页签。 */
private fun NavHostController.backFromDeviceDetail() {
    if (!popBackStack()) navigateToTab(PrismDestination.DEVICES)
}

/**
 * 导航回调 / 主题状态的稳定载体。
 *
 * NavHost 的图只在首次组合时构建（见 [PrismNavHost]），因此目的地 lambda 不能直接
 * 捕获每次重组都会变化的 `ui` / `themeMode` / 回调 lambda，否则 remember 的 key 变化
 * 会重建 NavGraph，NavController 会清空返回栈。这里用可变状态 + SideEffect 把最新值
 * 推给已构建的图：主题变化能触发 About 页重组，轮询更新只重组当前目的地。
 */
@Stable
private class PrismNavState(
    val vm: MainViewModel,
    val navController: NavHostController,
    initialThemeMode: ThemeMode,
    initialDynamicColor: Boolean,
    initialOnThemeModeChange: (ThemeMode) -> Unit,
    initialOnDynamicColorChange: (Boolean) -> Unit,
    initialNotifyEnabled: Boolean,
    initialOnNotifyEnabledChange: (Boolean) -> Unit,
    initialOnOnboardingComplete: () -> Unit
) {
    var themeMode by mutableStateOf(initialThemeMode)
    var dynamicColor by mutableStateOf(initialDynamicColor)
    var notifyEnabled by mutableStateOf(initialNotifyEnabled)
    var onThemeModeChange: (ThemeMode) -> Unit = initialOnThemeModeChange
    var onDynamicColorChange: (Boolean) -> Unit = initialOnDynamicColorChange
    var onNotifyEnabledChange: (Boolean) -> Unit = initialOnNotifyEnabledChange
    var onOnboardingComplete: () -> Unit = initialOnOnboardingComplete
}

/* ───────────────────────── NavHost ───────────────────────── */

/**
 * 应用导航图。
 *
 * - 首次启动（未完成引导）以 [PrismRoutes.WELCOME] 为起始，完成后跳到主图；
 * - 主图内是 5 个一级页签 + 设置子页（servers / about）；
 * - 屏幕内容全部复用现有实现，本文件只负责导航接线与尚未自带 Scaffold 的页面外壳。
 *
 * 图构建一次并缓存：目的地内部读取 `vm.ui`，轮询只触发当前页重组，
 * 不会重建 NavGraph / 清空返回栈。
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
    notifyEnabled: Boolean = true,
    onNotifyEnabledChange: (Boolean) -> Unit = {},
    onOnboardingComplete: () -> Unit,
    modifier: Modifier = Modifier
) {
    val navState = remember(vm, navController) {
        PrismNavState(
            vm = vm,
            navController = navController,
            initialThemeMode = themeMode,
            initialDynamicColor = dynamicColor,
            initialOnThemeModeChange = onThemeModeChange,
            initialOnDynamicColorChange = onDynamicColorChange,
            initialNotifyEnabled = notifyEnabled,
            initialOnNotifyEnabledChange = onNotifyEnabledChange,
            initialOnOnboardingComplete = onOnboardingComplete
        )
    }

    /* 回调 / 主题每次组合的最新值；写 State 只在值变化时触发对应目的地重组。 */
    SideEffect {
        navState.themeMode = themeMode
        navState.dynamicColor = dynamicColor
        navState.onThemeModeChange = onThemeModeChange
        navState.onDynamicColorChange = onDynamicColorChange
        navState.notifyEnabled = notifyEnabled
        navState.onNotifyEnabledChange = onNotifyEnabledChange
        navState.onOnboardingComplete = onOnboardingComplete
    }

    val graph = remember(navController, startWithWelcome, navState) {
        navController.createGraph(
            startDestination = if (startWithWelcome) PrismRoutes.WELCOME else PrismRoutes.MAIN
        ) {
            /* 首启引导：填地址 / 令牌 → 保存并进入概览；「稍后设置」直接进入。 */
            composable(PrismRoutes.WELCOME) {
                val ui = vm.ui
                WelcomeScreen(
                    defaultBaseUrl = ui.baseUrl,
                    defaultToken = ui.token,
                    onTest = { base, token, onResult ->
                        vm.testConnection(base, token, onResult)
                    },
                    onConnect = { base, token ->
                        vm.saveSettings(base, token, ui.intervalSec)
                        navState.onOnboardingComplete()
                    },
                    onSkip = { navState.onOnboardingComplete() }
                )
            }

            navigation(startDestination = PrismRoutes.OVERVIEW, route = PrismRoutes.MAIN) {
                /* 5 个一级页签的屏幕都自带 PrismScaffold（大标题/副标题/刷新），
                 * 这里只负责挂载与导航回调，避免双层顶栏。 */
                composable(PrismRoutes.OVERVIEW) {
                    OverviewScreen(
                        ui = vm.ui,
                        onRefresh = { vm.refresh() },
                        onOpenDevices = {
                            navController.navigateToTab(PrismDestination.DEVICES)
                        },
                        /*
                         * Top 3 活跃设备行：有该回调时直接进单设备详情；
                         * 「查看全部」仍走设备页签（见 OverviewScreen 的 action 槽）。
                         */
                        onOpenDevice = { device -> navController.openDeviceDetail(device) },
                        onOpenNetwork = {
                            navController.navigateToTab(PrismDestination.NETWORK)
                        }
                    )
                }

                composable(PrismRoutes.DEVICES) {
                    /* 设备屏自带 PrismScaffold；vm 只用于下拉刷新（屏幕仍只渲染传入的 ui）。 */
                    DevicesScreen(
                        ui = vm.ui,
                        vm = vm,
                        /* 正式详情路由；MAC 为空时设备屏自己回退到旧弹层。 */
                        onOpenDevice = { device -> navController.openDeviceDetail(device) }
                    )
                }

                /*
                 * 设备详情：主图内的二级目的地，因此底部导航自动隐藏、系统返回由
                 * NavController 弹出。MAC 经路径参数传入（只含归一化 MAC，无敏感数据）。
                 */
                composable(
                    route = PrismRoutes.DEVICE_DETAIL,
                    arguments = listOf(
                        navArgument(PrismRoutes.DEVICE_DETAIL_ARG) { type = NavType.StringType }
                    )
                ) { entry ->
                    DeviceDetailScreen(
                        ui = vm.ui,
                        mac = entry.arguments
                            ?.getString(PrismRoutes.DEVICE_DETAIL_ARG)
                            .orEmpty(),
                        onRetry = { vm.refresh() },
                        onBack = { navController.backFromDeviceDetail() }
                    )
                }

                composable(PrismRoutes.APPS) {
                    /* 应用屏自带 PrismScaffold（标题 / 域名数副标题 / 刷新都在屏内）。 */
                    AppsScreen(ui = vm.ui, vm = vm)
                }

                composable(PrismRoutes.NETWORK) {
                    NetworkScreen(
                        ui = vm.ui,
                        onRetryNodes = { vm.refreshNodes() },
                        onRefresh = { vm.refresh() }
                    )
                }

                composable(PrismRoutes.SETTINGS) {
                    val ui = vm.ui
                    SettingsScreen(
                        ui = ui,
                        onSave = { base, token, interval ->
                            vm.saveSettings(base, token, interval)
                        },
                        onTest = { base, token, onResult ->
                            vm.testConnection(base, token, onResult)
                        },
                        onRefresh = { vm.refresh() },
                        vm = vm,
                        themeMode = navState.themeMode,
                        dynamicColor = navState.dynamicColor,
                        onThemeModeChange = { mode -> navState.onThemeModeChange(mode) },
                        onDynamicColorChange = { enabled -> navState.onDynamicColorChange(enabled) },
                        notifyEnabled = navState.notifyEnabled,
                        onNotifyEnabledChange = { enabled -> navState.onNotifyEnabledChange(enabled) },
                        onOpenServers = { navController.navigate(PrismRoutes.SETTINGS_SERVERS) },
                        onOpenAbout = { navController.navigate(PrismRoutes.SETTINGS_ABOUT) },
                        onOpenConfig = { navController.navigate(PrismRoutes.SETTINGS_CONFIG) }
                    )
                }

                /* 设置子页：地址列表只读预览（增删切换仍在设置页，后续任务升级）。 */
                composable(PrismRoutes.SETTINGS_SERVERS) {
                    ServersRoute(
                        ui = vm.ui,
                        onBack = { navController.popBackStack() }
                    )
                }

                /* 设置子页：关于 + 外观（主题模式 / 动态取色开关）。 */
                composable(PrismRoutes.SETTINGS_ABOUT) {
                    AboutRoute(
                        routerPluginVersion = vm.ui.system?.version.orEmpty(),
                        onBack = { navController.popBackStack() }
                    )
                }

                /*
                 * 设置子页：网络配置（需管理员登录）。
                 * 令牌由 ViewModel 内存持有；本页只发起读写并渲染返回的状态。
                 */
                composable(PrismRoutes.SETTINGS_CONFIG) {
                    ConfigScreen(
                        ui = vm.ui,
                        onBack = { navController.popBackStack() },
                        onRefresh = { vm.configLoad() },
                        onSaveLan = { lan ->
                            vm.configSaveLan(lan.ipaddr, lan.netmask, lan.gateway, lan.dns)
                        },
                        onSaveWan = { wan ->
                            vm.configSaveWan(
                                wan.proto,
                                wan.ipaddr,
                                wan.netmask,
                                wan.gateway,
                                wan.dns
                            )
                        },
                        onSaveDhcp = { dhcp ->
                            vm.configSaveDhcp(
                                dhcp.enabled,
                                dhcp.start,
                                dhcp.limit,
                                dhcp.leasetime
                            )
                        },
                        onSaveSystem = { system ->
                            vm.configSaveSystem(system.hostname, system.timezone, system.zonename)
                        },
                        onAddRedirect = { draft -> vm.configAddRedirect(draft) },
                        onDeleteRedirect = { index -> vm.configDeleteRedirect(index) },
                        onRollback = { section -> vm.configRollback(section) },
                        onClearFeedback = { vm.configClearFeedback() },
                        onConsumeNotice = { vm.configClearNotice() }
                    )
                }
            }
        }
    }

    NavHost(
        navController = navController,
        graph = graph,
        modifier = modifier.fillMaxSize()
    )
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
                            Pill(
                                "含令牌",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                leadingDot = false
                            )
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
                    text = "路由器地址、令牌与刷新间隔仍在「设置」页编辑，避免同一份配置出现两个写入入口。" +
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
private fun AboutRoute(routerPluginVersion: String, onBack: () -> Unit) {
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
            SectionCard(title = "关于棱镜路由", subtitle = "Android 原生客户端") {
                val context = LocalContext.current
                /* App 版本必须来自 PackageManager（Gradle 从 android/version.properties 注入），
                   不能写死；路由器插件版本单独展示，不参与 App 更新比较。 */
                val packageInfo = remember(context) {
                    runCatching {
                        context.packageManager.getPackageInfo(context.packageName, 0)
                    }.getOrNull()
                }
                val versionText = if (packageInfo == null) {
                    "未知"
                } else {
                    val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        packageInfo.longVersionCode
                    } else {
                        @Suppress("DEPRECATION") packageInfo.versionCode.toLong()
                    }
                    formatAppVersion(packageInfo.versionName, code)
                }
                InfoLine("应用", "棱镜路由")
                InfoLine("App 版本", versionText)
                InfoLine(
                    "路由器插件版本",
                    routerPluginVersion.trim().takeIf { it.isNotBlank() }?.let { "v$it" }
                        ?: "未连接路由器 / 读取中"
                )
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

/**
 * About 页版本文案：`versionName (versionCode)`。
 *
 * 抽成纯函数便于 JVM 单测；真实值由 PackageManager 读取，缺失时退回 `? (0)`。
 */
internal fun formatAppVersion(versionName: String?, versionCode: Long): String {
    val name = versionName?.trim().orEmpty().ifBlank { "?" }
    return "$name ($versionCode)"
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
