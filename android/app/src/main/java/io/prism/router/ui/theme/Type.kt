package io.prism.router.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/*
 * 棱镜路由 · 字体阶梯（收敛版）
 *
 * 全部使用系统字体（FontFamily.Default），不打包字体文件：
 * - 中文字形跟随 OEM / 系统设置，体积与渲染成本最低；
 * - 字号收敛为 12 / 14 / 16 / 22 / 24 / 28 / 36 几档，不再出现 9sp / 10sp / 11sp
 *   这类在 360dp 屏上难读、又会把页面切碎的小字号；
 * - 最小正文 / 说明为 12sp（labelSmall / bodySmall）；14sp 是常规正文。
 *
 * 页面里优先取：HeadlineSmall（速率主数值）/ TitleMedium（卡片标题）/
 * BodyMedium（正文）/ LabelSmall（辅助说明、标签）。数值统一用 tabularFigures()。
 */
val PrismTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 36.sp,
        lineHeight = 44.sp,
        letterSpacing = (-0.5).sp
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 24.sp,
        lineHeight = 32.sp,
        letterSpacing = 0.sp
    ),
    /* TopAppBar 折叠 / 展开态的字重：默认 Typography 是 Normal，偏轻，这里统一半粗。 */
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 36.sp,
        letterSpacing = 0.sp
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.sp
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.1.sp
    ),
    titleSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.2.sp
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.2.sp
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.2.sp
    )
)

/**
 * 等宽数字（tabular figures）。
 *
 * 轮询刷新时速率 / 流量值宽度不变，数字不会左右跳动；
 * 与 Monospace 字体不同，它保留系统字体的中文与字形风格。
 */
fun TextStyle.tabularFigures(): TextStyle = copy(fontFeatureSettings = "tnum")
