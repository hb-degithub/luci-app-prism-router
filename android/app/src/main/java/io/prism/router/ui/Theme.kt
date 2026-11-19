package io.prism.router.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import io.prism.router.ui.theme.PrismBrand
import io.prism.router.ui.theme.PrismGoodLegacy
import io.prism.router.ui.theme.PrismSubTextLegacy
import io.prism.router.ui.theme.PrismTheme
import io.prism.router.ui.theme.PrismWarnLegacy

/*
 * 旧屏幕兼容层。
 *
 * Overview / Devices / Apps / Nodes / Topology / Settings 仍在直接引用
 * Brand / Good / Warn / SubText，屏幕内容重做前先保留这些别名，
 * 数值与旧版完全一致（避免视觉回归）；新代码请使用
 * MaterialTheme.colorScheme 或 LocalPrismSemanticColors。
 */

/** 品牌色（#3B5BFF）。 */
val Brand: Color = PrismBrand

/** 成功 / 直连。 */
val Good: Color = PrismGoodLegacy

/** 警告 / 降级。 */
val Warn: Color = PrismWarnLegacy

/** 次要文字。 */
val SubText: Color = PrismSubTextLegacy

/**
 * 旧主题入口（兼容可能残留的调用方）。
 *
 * 新代码请直接使用 [PrismTheme]（支持深浅色 / 动态色参数）。
 */
@Composable
@Deprecated("使用 PrismTheme(darkTheme, dynamicColor, content)")
fun PrismRouterTheme(content: @Composable () -> Unit) {
    PrismTheme(content = content)
}
