package io.prism.router.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/*
 * 棱镜路由 · 设计系统色板
 *
 * 品牌色固定为 #3B5BFF（棱镜蓝）。深浅两套 ColorScheme 都以它为中心推导：
 * - 浅色：primary 直接用品牌色，容器色提亮到 #DCE2FF，保证白字对比度；
 * - 深色：primary 提亮到 #B4C2FF（品牌色的高对比变体），避免深底上蓝字发闷。
 *
 * 页面 / 组件不要直接写十六进制颜色，统一从 MaterialTheme.colorScheme 或
 * LocalPrismSemanticColors 取，动态取色（Android 12+）时才能整体跟随系统。
 */

/** 品牌主色。Logo、主按钮、选中态都使用它。 */
val PrismBrand = Color(0xFF3B5BFF)

/** 深色主题下的品牌高对比变体。 */
val PrismBrandOnDark = Color(0xFFB4C2FF)

/** 品牌色的低饱和容器色（浅色主题）。 */
val PrismBrandContainerLight = Color(0xFFDCE2FF)

/** 品牌色的深色容器色。 */
val PrismBrandContainerDark = Color(0xFF1B36B8)

/** 旧屏幕仍在直接引用的语义色（保持历史视觉不变，新代码请用 LocalPrismSemanticColors）。 */
val PrismGoodLegacy = Color(0xFF00B96B)
val PrismWarnLegacy = Color(0xFFFF6F00)
val PrismSubTextLegacy = Color(0xFF8A8F98)

/**
 * 设计系统补充语义色。
 *
 * Material3 的 error 只覆盖「错误」，成功 / 警告 / 中性三类状态没有官方槽位，
 * 因此用 CompositionLocal 提供，深色下自动换成高对比版本。
 */
@Immutable
data class PrismSemanticColors(
    val success: Color,
    val warning: Color,
    val info: Color,
    val danger: Color,
    val neutral: Color
)

val LightSemanticColors = PrismSemanticColors(
    success = Color(0xFF00875A),
    warning = Color(0xFFB45309),
    info = PrismBrand,
    danger = Color(0xFFB3261E),
    neutral = Color(0xFF5A616B)
)

val DarkSemanticColors = PrismSemanticColors(
    success = Color(0xFF4ADE80),
    warning = Color(0xFFFBBF24),
    info = PrismBrandOnDark,
    danger = Color(0xFFFFB4AB),
    neutral = Color(0xFFA9B2C2)
)

/** 语义色入口；默认给浅色一套，预览 / 未包裹主题时也不会崩。 */
val LocalPrismSemanticColors = staticCompositionLocalOf { LightSemanticColors }

val PrismLightColorScheme = lightColorScheme(
    primary = PrismBrand,
    onPrimary = Color.White,
    primaryContainer = PrismBrandContainerLight,
    onPrimaryContainer = Color(0xFF00105C),
    inversePrimary = PrismBrandOnDark,
    secondary = Color(0xFF006A67),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF9CF2ED),
    onSecondaryContainer = Color(0xFF00201F),
    tertiary = Color(0xFF6847D9),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFE9DDFF),
    onTertiaryContainer = Color(0xFF22005D),
    background = Color(0xFFF7F8FC),
    onBackground = Color(0xFF11151C),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF11151C),
    surfaceVariant = Color(0xFFEEF0F7),
    onSurfaceVariant = Color(0xFF5A616B),
    surfaceTint = PrismBrand,
    inverseSurface = Color(0xFF2E3038),
    inverseOnSurface = Color(0xFFF1F0F7),
    error = Color(0xFFBA1A1A),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    outline = Color(0xFF74777F),
    outlineVariant = Color(0xFFC4C6D0),
    scrim = Color.Black,
    surfaceBright = Color(0xFFFFFFFF),
    surfaceDim = Color(0xFFD8DAE2),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFBFBFE),
    surfaceContainer = Color(0xFFF1F3F9),
    surfaceContainerHigh = Color(0xFFEBEDF4),
    surfaceContainerHighest = Color(0xFFE4E7EF)
)

val PrismDarkColorScheme = darkColorScheme(
    primary = PrismBrandOnDark,
    onPrimary = Color(0xFF002387),
    primaryContainer = PrismBrandContainerDark,
    onPrimaryContainer = PrismBrandContainerLight,
    inversePrimary = PrismBrand,
    secondary = Color(0xFF80D5D0),
    onSecondary = Color(0xFF003735),
    secondaryContainer = Color(0xFF00504D),
    onSecondaryContainer = Color(0xFF9CF2ED),
    tertiary = Color(0xFFCBBEFF),
    onTertiary = Color(0xFF3B1E78),
    tertiaryContainer = Color(0xFF523E8C),
    onTertiaryContainer = Color(0xFFE9DDFF),
    background = Color(0xFF0B0F19),
    onBackground = Color(0xFFE6EAF2),
    surface = Color(0xFF111725),
    onSurface = Color(0xFFE6EAF2),
    surfaceVariant = Color(0xFF1D2536),
    onSurfaceVariant = Color(0xFFA9B2C2),
    surfaceTint = PrismBrandOnDark,
    inverseSurface = Color(0xFFE6EAF2),
    inverseOnSurface = Color(0xFF2E3038),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    outline = Color(0xFF8A92A3),
    outlineVariant = Color(0xFF3A4356),
    scrim = Color.Black,
    surfaceBright = Color(0xFF2A3245),
    surfaceDim = Color(0xFF0B0F19),
    surfaceContainerLowest = Color(0xFF070A12),
    surfaceContainerLow = Color(0xFF0F1420),
    surfaceContainer = Color(0xFF151C2A),
    surfaceContainerHigh = Color(0xFF1B2434),
    surfaceContainerHighest = Color(0xFF222C3F)
)
