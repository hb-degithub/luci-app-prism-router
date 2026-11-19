package io.prism.router

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import io.prism.router.data.MainViewModel
import io.prism.router.ui.App
import io.prism.router.ui.PrismRouterTheme

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            /* 通知权限请求与 UI 无关：只弹一次系统对话框，拒绝也不影响任何页面。 */
            RequestNotificationPermissionOnce()
            PrismRouterTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    App(vm)
                }
            }
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

            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(KEY_ASKED, false)) return@LaunchedEffect

            /* 先置标记再请求：即使 launcher 抛异常也不会进入反复请求的循环。 */
            prefs.edit().putBoolean(KEY_ASKED, true).apply()
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } catch (e: Exception) {
            /* 部分 ROM / 无 Activity 环境会拒绝请求，忽略即可。 */
        }
    }
}

private const val PREFS = "prism-router"
private const val KEY_ASKED = "notifyPermissionAsked"
