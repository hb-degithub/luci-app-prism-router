package io.prism.router.ui

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import io.prism.router.data.MainViewModel
import io.prism.router.ui.navigation.PrismDestination
import io.prism.router.ui.navigation.PrismNavHost
import io.prism.router.ui.navigation.PrismRoutes
import io.prism.router.ui.navigation.navigateToTab
import io.prism.router.ui.theme.ThemeMode

/**
 * 与 UI 相关的轻量偏好（与 data 层的 DataStore 配置分开）。
 *
 * 目前只存「首启引导是否已完成」；主题与动态色由 data 层 SettingsStore 持久化，
 * 屏幕内容重做时再统一迁走。
 */
object PrismPrefs {
    const val NAME = "prism-router"
    const val KEY_ONBOARDED = "onboarded"
}

/** 老版本写在 SharedPreferences 里的配置键；只用于判断「是否已经配置过」。 */
private val LEGACY_CONFIG_KEYS = listOf(
    "baseUrl",
    "token",
    "servers",
    "activeServer",
    "interval"
)

/**
 * 应用根组件：5 项底部导航 + 页面容器 + NavHost。
 *
 * 边到边策略：
 * - 外层 Scaffold 的 contentWindowInsets 置 0，避免与每页 PrismScaffold 的
 *   TopAppBar 状态栏内边距重复；
 * - 底部导航自身 navigationBarsPadding()，内容区通过 innerPadding 让出高度；
 * - 二级页 / 引导页隐藏底部导航时，内容区补 navigationBarsPadding()。
 */
@Composable
fun App(
    vm: MainViewModel,
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    dynamicColor: Boolean = false,
    notifyEnabled: Boolean = true,
    onThemeModeChange: (ThemeMode) -> Unit = {},
    onDynamicColorChange: (Boolean) -> Unit = {},
    onNotifyEnabledChange: (Boolean) -> Unit = {}
) {
    val context = LocalContext.current
    val prefs = remember(context) {
        context.getSharedPreferences(PrismPrefs.NAME, Context.MODE_PRIVATE)
    }
    /* 只在首次组合时决定起始页；引导完成后用导航跳转，不重建 NavHost。 */
    val initialStartWithWelcome = remember {
        val onboarded = prefs.getBoolean(PrismPrefs.KEY_ONBOARDED, false)
        /*
         * 升级用户的老配置仍在 SharedPreferences（data 层迁移后只读保留）：
         * 已经配过路由器就不再弹引导，避免把有效地址覆盖成默认值。
         */
        val legacyConfigured = LEGACY_CONFIG_KEYS.any { prefs.contains(it) }
        if (!onboarded && legacyConfigured) {
            prefs.edit().putBoolean(PrismPrefs.KEY_ONBOARDED, true).apply()
        }
        !onboarded && !legacyConfigured
    }
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    /* 首帧 currentRoute 可能还是 null：按起始页决定是否显示，避免底部栏闪一下。 */
    val showBottomBar = currentRoute?.let { route ->
        PrismDestination.entries.any { it.route == route }
    } ?: !initialStartWithWelcome

    LaunchedEffect(Unit) { vm.start() }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            if (showBottomBar) {
                PrismBottomBar(
                    currentRoute = currentRoute,
                    onSelect = { destination -> navController.navigateToTab(destination) }
                )
            }
        }
    ) { innerPadding ->
        val contentModifier = Modifier
            .fillMaxSize()
            .padding(innerPadding)
            .then(if (showBottomBar) Modifier else Modifier.navigationBarsPadding())

        PrismNavHost(
            vm = vm,
            navController = navController,
            startWithWelcome = initialStartWithWelcome,
            themeMode = themeMode,
            dynamicColor = dynamicColor,
            notifyEnabled = notifyEnabled,
            onThemeModeChange = onThemeModeChange,
            onDynamicColorChange = onDynamicColorChange,
            onNotifyEnabledChange = onNotifyEnabledChange,
            onOnboardingComplete = {
                prefs.edit().putBoolean(PrismPrefs.KEY_ONBOARDED, true).apply()
                navController.navigate(PrismRoutes.MAIN) {
                    popUpTo(PrismRoutes.WELCOME) { inclusive = true }
                    launchSingleTop = true
                }
            },
            modifier = contentModifier
        )
    }
}

/**
 * 底部导航：概览 / 设备 / 应用 / 网络 / 设置。
 *
 * 选中态使用 primary + primaryContainer 指示器；文字用 LabelSmall，
 * 5 项在 390dp 宽度下均分不换行。图标是装饰性的（旁边始终有文字标签），
 * 因此 contentDescription 交给 Text 语义，避免读屏重复播报。
 */
@Composable
private fun PrismBottomBar(
    currentRoute: String?,
    onSelect: (PrismDestination) -> Unit
) {
    Column(Modifier.navigationBarsPadding()) {
        /* 不画 1dp 分隔线：底部栏用 surface 与背景形成层级，避免多一条苍白横线。 */
        NavigationBar(
            modifier = Modifier.fillMaxWidth(),
            windowInsets = WindowInsets(0, 0, 0, 0),
            containerColor = MaterialTheme.colorScheme.surface,
            tonalElevation = 0.dp
        ) {
            PrismDestination.entries.forEach { destination ->
                val selected = currentRoute == destination.route
                NavigationBarItem(
                    selected = selected,
                    onClick = { onSelect(destination) },
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = null
                        )
                    },
                    label = {
                        Text(
                            text = destination.label,
                            style = MaterialTheme.typography.labelSmall,
                            maxLines = 1
                        )
                    },
                    alwaysShowLabel = true,
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = MaterialTheme.colorScheme.primary,
                        selectedTextColor = MaterialTheme.colorScheme.primary,
                        indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                        unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                )
            }
        }
    }
}
