package io.prism.router.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * 棱镜路由 · 尺寸令牌
 *
 * 圆角只用 12 / 16 / 20 三档：小控件 12、卡片 16、大容器 / 弹层 20。
 * 间距只用 4 / 8 / 12 / 16 / 24 五档，避免页面里出现 7dp、13dp 这类随手值。
 */

/** 圆角令牌。 */
object PrismRadius {
    val small: Dp = 12.dp
    val medium: Dp = 16.dp
    val large: Dp = 20.dp

    /** 胶囊（Pill / Segmented 外框）。 */
    val pill: Dp = 999.dp
}

/** 间距令牌。 */
object PrismSpacing {
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 24.dp
}

/** 可注入的间距集合；需要整体缩放时替换 [LocalPrismSpacing] 即可。 */
@Immutable
data class PrismSpacings(
    val xs: Dp = PrismSpacing.xs,
    val sm: Dp = PrismSpacing.sm,
    val md: Dp = PrismSpacing.md,
    val lg: Dp = PrismSpacing.lg,
    val xl: Dp = PrismSpacing.xl
)

val DefaultPrismSpacings = PrismSpacings()

/** 可选入口：组件内部优先读它，方便以后做「紧凑模式」而不用改每个页面。 */
val LocalPrismSpacing = staticCompositionLocalOf { DefaultPrismSpacings }

/** 触控与图标尺寸（Material 最小触控 48dp）。 */
object PrismSize {
    val touchTarget: Dp = 48.dp
    val iconSmall: Dp = 18.dp
    val icon: Dp = 20.dp
    val iconLarge: Dp = 24.dp
    val avatar: Dp = 40.dp
    val emptyIcon: Dp = 64.dp
}

/** Material3 Shapes：与圆角令牌对齐。 */
val PrismShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(PrismRadius.small),
    medium = RoundedCornerShape(PrismRadius.medium),
    large = RoundedCornerShape(PrismRadius.large),
    extraLarge = RoundedCornerShape(28.dp)
)
