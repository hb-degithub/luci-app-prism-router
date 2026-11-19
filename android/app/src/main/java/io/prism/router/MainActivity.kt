package io.prism.router

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color as AndroidColor
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.prism.router.data.MainViewModel
import io.prism.router.data.store.AppSettings
import io.prism.router.data.store.AppTheme
import io.prism.router.ui.App
import io.prism.router.ui.PrismPrefs
import io.prism.router.ui.theme.PrismTheme
import io.prism.router.ui.theme.ThemeMode
import io.prism.router.ui.theme.resolveDark
import kotlinx.coroutines.launch

/**
 * 应用入口：边到边 + 主题 + 通知权限。
 *
 * 主题来源（唯一真源）：
 * - 主题模式 / 动态色持久化在 data 层 SettingsStore（DataStore）；
 * - 这里只做「当前会话的乐观覆盖」：点击后立刻生效，DataStore 回流后保持一致；
 * - 用户覆盖只在进程内有效（rememberSaveable 跨旋转），下次冷启动以 DataStore 为准。
 */
class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        /* 状态栏 / 导航栏透明，内容延伸到系统栏后面；图标深浅由 Compose 里的 SideEffect 校正。 */
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
        )
        super.onCreate(savedInstanceState)

        val settingsStore = (application as? PrismApplication)?.container?.settingsStore

        setContent {
            val settingsFlow = remember(settingsStore) { settingsStore?.settings }
            val appSettings: AppSettings = if (settingsFlow != null) {
                settingsFlow.collectAsStateWithLifecycle(initialValue = AppSettings()).value
            } else {
                remember { AppSettings() }
            }

            /* 当前会话的乐观覆盖；null 表示完全跟随 DataStore。 */
            var themeOverride by rememberSaveable { mutableStateOf<String?>(null) }
            var dynamicOverride by rememberSaveable { mutableStateOf<Boolean?>(null) }

            val themeMode = themeOverride
                ?.let { ThemeMode.fromKey(it) }
                ?: appSettings.theme.toThemeMode()
            val dynamicColor = dynamicOverride ?: appSettings.dynamicColor
            val darkTheme = themeMode.resolveDark()
            val scope = rememberCoroutineScope()

            PrismTheme(darkTheme = darkTheme, dynamicColor = dynamicColor) {
                PrismSystemBars(darkTheme = darkTheme)
                /* 通知权限与 UI 无关：只弹一次系统对话框，拒绝也不影响任何页面。 */
                RequestNotificationPermissionOnce()

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    App(
                        vm = vm,
                        themeMode = themeMode,
                        dynamicColor = dynamicColor,
                        onThemeModeChange = { mode ->
                            themeOverride = mode.name
                            settingsStore?.let { store ->
                                scope.launch { store.setTheme(mode.toAppTheme()) }
                            }
                        },
                        onDynamicColorChange = { enabled ->
                            dynamicOverride = enabled
                            settingsStore?.let { store ->
                                scope.launch { store.setDynamicColor(enabled) }
                            }
                        }
                    )
                }
            }
        }
    }
}

/** 系统栏图标明暗跟随应用主题，而不是只跟系统深色模式。 */
@Composable
private fun PrismSystemBars(darkTheme: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return

    SideEffect {
        val window = (view.context as? Activity)?.window ?: return@SideEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !darkTheme
            isAppearanceLightNavigationBars = !darkTheme
        }
    }
}

/**
 * Android 13+ 的 `POST_NOTIFICATIONS` 运行期权限请求。
 *
 * - 只在「还没问过」时请求一次（标记落在 `prism-router` 偏好里），冷启动不会反复打扰；
 * - 已经授权 / 系统版本低于 13 时直接跳过；
 * - 回调忽略结果：拒绝、勾选「不再询问」都不会崩，只是收不到本地告警通知。
 */
@Composable
private fun RequestNotificationPermissionOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return

    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* granted 与否都不做处理：通知失败本来就是静默的。 */ }

    LaunchedEffect(Unit) {
        try {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (granted) return@LaunchedEffect

            val prefs = context.getSharedPreferences(PrismPrefs.NAME, Context.MODE_PRIVATE)
            if (prefs.getBoolean(KEY_ASKED, false)) return@LaunchedEffect

            /* 先置标记再请求：即使 launcher 抛异常也不会进入反复请求的循环。 */
            prefs.edit().putBoolean(KEY_ASKED, true).apply()
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } catch (e: Exception) {
            /* 部分 ROM / 无 Activity 环境会拒绝请求，忽略即可。 */
        }
    }
}

private const val KEY_ASKED = "notifyPermissionAsked"

/* ───────────────────────── 主题映射 ───────────────────────── */

private fun AppTheme.toThemeMode(): ThemeMode = when (this) {
    AppTheme.SYSTEM -> ThemeMode.SYSTEM
    AppTheme.LIGHT -> ThemeMode.LIGHT
    AppTheme.DARK -> ThemeMode.DARK
}

private fun ThemeMode.toAppTheme(): AppTheme = when (this) {
    ThemeMode.SYSTEM -> AppTheme.SYSTEM
    ThemeMode.LIGHT -> AppTheme.LIGHT
    ThemeMode.DARK -> AppTheme.DARK
}
