package io.prism.router.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext

/**
 * 主题模式。持久化时存 [name]，读取时用 [fromKey] 兜底，避免脏数据导致崩溃。
 */
enum class ThemeMode(val label: String) {
    SYSTEM("跟随系统"),
    LIGHT("浅色"),
    DARK("深色");

    companion object {
        fun fromKey(key: String?): ThemeMode = entries.firstOrNull { it.name == key } ?: SYSTEM
    }
}

/**
 * 棱镜路由主题。
 *
 * @param darkTheme 是否深色。调用方传入「系统 + 用户覆盖」的结果，主题本身不做判断。
 * @param dynamicColor Android 12+ 动态取色开关；关闭时始终使用品牌色 #3B5BFF。
 *                     Android 11 及以下自动忽略，不会报错。
 * @param content 页面内容。
 */
@Composable
fun PrismTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit
) {
    val context = LocalContext.current
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)

        darkTheme -> PrismDarkColorScheme
        else -> PrismLightColorScheme
    }
    val semantics = if (darkTheme) DarkSemanticColors else LightSemanticColors

    CompositionLocalProvider(
        LocalPrismSpacing provides DefaultPrismSpacings,
        LocalPrismSemanticColors provides semantics
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = PrismTypography,
            shapes = PrismShapes,
            content = content
        )
    }
}

/** 当前系统是否支持动态取色（Android 12 / API 31+）。 */
val isDynamicColorAvailable: Boolean
    get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

/** 把 [ThemeMode] 解析为最终是否深色。 */
@Composable
fun ThemeMode.resolveDark(): Boolean = when (this) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
}
