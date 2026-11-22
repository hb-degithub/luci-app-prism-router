package io.prism.router.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/*
 * 棱镜路由 · 设计系统色板（科技感网络驾驶舱）
 *
 * 颜色有明确分工，页面里不要自己发明：
 * - 品牌 / 下载：棱镜蓝 #3B5BFF（浅色）/ #A9BEFF（深色）；
 * - 上传：科技青 #0B7285（浅色）/ #4FD6E0（深色）；
 * - 正常 / 警告 / 错误：只用于「状态」（服务、记账、新鲜度、告警、信号），
 *   不再拿 warning / tertiary 代表上传方向；
 * - 表面：用 surface / surfaceContainer* 的层级区分卡片与背景，
 *   浅色下卡片刻意比背景亮，深色下逐级提亮但不用纯黑，也不做霓虹高亮。
 *
 * 页面 / 组件不要直接写十六进制颜色，统一从 MaterialTheme.colorScheme、
 * LocalPrismSemanticColors 或 LocalPrismDataColors 取，动态取色时才能整体跟随系统。
 */

/** 品牌主色（同时是下载方向色）。Logo、主按钮、选中态都使用它。 */
val PrismBrand = Color(0xFF3B5BFF)

/** 深色主题下的品牌高对比变体。 */
val PrismBrandOnDark = Color(0xFFA9BEFF)

/** 品牌色的低饱和容器色（浅色主题）。 */
val PrismBrandContainerLight = Color(0xFFDCE2FF)

/** 品牌色的深色容器色。 */
val PrismBrandContainerDark = Color(0xFF2438A8)

/** 科技青：上传方向色（浅色）。 */
val PrismUploadLight = Color(0xFF0B7285)

/** 科技青：上传方向色（深色，避免霓虹，保持 7:1 左右对比）。 */
val PrismUploadDark = Color(0xFF4FD6E0)

/** 浅色主题下的下载方向色（品牌蓝在浅底上仍保持 4.5:1 以上对比）。 */
val PrismDownloadLight = PrismBrand

/** 深色主题下的下载方向色（比品牌色更亮，避免深底发闷）。 */
val PrismDownloadDark = PrismBrandOnDark

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
    success = Color(0xFF0F7B4F),
    warning = Color(0xFF874500),
    info = PrismBrand,
    danger = Color(0xFFB3261E),
    neutral = Color(0xFF596273)
)

val DarkSemanticColors = PrismSemanticColors(
    success = Color(0xFF57D68A),
    warning = Color(0xFFF5B544),
    info = PrismBrandOnDark,
    danger = Color(0xFFFFB4AB),
    neutral = Color(0xFFA9B3C4)
)

/** 固定类别色：与方向、状态、动态壁纸取色均解耦。 */
@Immutable
data class PrismCategoryColors(
    val proxy: Color,
    val direct: Color,
    val wifi: Color,
    val wired: Color,
    val neutral: Color
)

val LightCategoryColors = PrismCategoryColors(
    proxy = Color(0xFF6D3FC0),
    direct = Color(0xFF0F766E),
    wifi = Color(0xFF6D3FC0),
    wired = Color(0xFF475569),
    neutral = Color(0xFF596273)
)

val DarkCategoryColors = PrismCategoryColors(
    proxy = Color(0xFFC4B5FD),
    direct = Color(0xFF5EEAD4),
    wifi = Color(0xFFC4B5FD),
    wired = Color(0xFFCBD5E1),
    neutral = Color(0xFFA9B3C4)
)

val LocalPrismCategoryColors = staticCompositionLocalOf { LightCategoryColors }

/** 语义色入口；默认给浅色一套，预览 / 未包裹主题时也不会崩。 */
val LocalPrismSemanticColors = staticCompositionLocalOf { LightSemanticColors }

/**
 * 方向色（数据可视化语义）。
 *
 * 与「状态色」严格分开：下载永远是蓝、上传永远是青，不论当前是正常还是告警状态。
 * Overview / Devices / Network 的上下行数值、图标、迷你趋势线都从这里取色，
 * 这样三个页签的方向语义不会各自漂移。
 */
@Immutable
data class PrismDataColors(
    val download: Color,
    val upload: Color
)

val LightDataColors = PrismDataColors(
    download = PrismDownloadLight,
    upload = PrismUploadLight
)

val DarkDataColors = PrismDataColors(
    download = PrismDownloadDark,
    upload = PrismUploadDark
)

/** 方向色入口；默认浅色，预览 / 未包裹主题时也不会崩。 */
val LocalPrismDataColors = staticCompositionLocalOf { LightDataColors }

val PrismLightColorScheme = lightColorScheme(
    primary = PrismBrand,
    onPrimary = Color.White,
    primaryContainer = PrismBrandContainerLight,
    onPrimaryContainer = Color(0xFF001355),
    inversePrimary = PrismBrandOnDark,
    secondary = Color(0xFF0F6F78),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFC7F0F2),
    onSecondaryContainer = Color(0xFF002022),
    tertiary = Color(0xFF5B4BC4),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFE6E0FF),
    onTertiaryContainer = Color(0xFF1D0F5C),
    /* 背景略冷、卡片纯白：不靠 1dp 描边也能分清层级。 */
    background = Color(0xFFF3F6FB),
    onBackground = Color(0xFF11161F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF11161F),
    surfaceVariant = Color(0xFFE9EEF7),
    onSurfaceVariant = Color(0xFF505A6B),
    surfaceTint = PrismBrand,
    inverseSurface = Color(0xFF2C3140),
    inverseOnSurface = Color(0xFFF0F2F8),
    error = Color(0xFFB3261E),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    outline = Color(0xFF6B7486),
    outlineVariant = Color(0xFFCBD4E3),
    scrim = Color.Black,
    surfaceBright = Color(0xFFFFFFFF),
    surfaceDim = Color(0xFFDDE3EE),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFAFCFF),
    surfaceContainer = Color(0xFFEDF2F9),
    surfaceContainerHigh = Color(0xFFE7EDF6),
    surfaceContainerHighest = Color(0xFFE0E8F3)
)

val PrismDarkColorScheme = darkColorScheme(
    primary = PrismBrandOnDark,
    onPrimary = Color(0xFF001A66),
    primaryContainer = PrismBrandContainerDark,
    onPrimaryContainer = PrismBrandContainerLight,
    inversePrimary = PrismBrand,
    secondary = Color(0xFF6FD3D9),
    onSecondary = Color(0xFF00363B),
    secondaryContainer = Color(0xFF16484F),
    onSecondaryContainer = Color(0xFFC7F0F2),
    tertiary = Color(0xFFC9BEFF),
    onTertiary = Color(0xFF2A1A6B),
    tertiaryContainer = Color(0xFF41347E),
    onTertiaryContainer = Color(0xFFE6E0FF),
    /* 深色不用纯黑：#0A0F18 背景 + 逐级提亮的表面，保留层次但不发灰、不刺眼。 */
    background = Color(0xFF0A0F18),
    onBackground = Color(0xFFE7EBF3),
    surface = Color(0xFF111827),
    onSurface = Color(0xFFE7EBF3),
    surfaceVariant = Color(0xFF1C2536),
    onSurfaceVariant = Color(0xFFB1BAC9),
    surfaceTint = PrismBrandOnDark,
    inverseSurface = Color(0xFFE7EBF3),
    inverseOnSurface = Color(0xFF2C3140),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    outline = Color(0xFF8B94A7),
    outlineVariant = Color(0xFF3B465C),
    scrim = Color.Black,
    surfaceBright = Color(0xFF26324A),
    surfaceDim = Color(0xFF0A0F18),
    surfaceContainerLowest = Color(0xFF0C121C),
    surfaceContainerLow = Color(0xFF121A28),
    surfaceContainer = Color(0xFF172133),
    surfaceContainerHigh = Color(0xFF1D293E),
    surfaceContainerHighest = Color(0xFF243149)
)
