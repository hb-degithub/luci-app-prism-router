package io.prism.router.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/*
 * 棱镜路由 · 字体阶梯
 *
 * 全部使用系统字体（FontFamily.Default），不打包字体文件：
 * - 中文字形跟随 OEM / 系统设置，体积与渲染成本最低；
 * - 字号/行高按 Material3 的 4dp 基线微调，保证 390dp 宽度下单行不挤。
 *
 * 主阶梯 5 档，页面里优先从这里取：
 * DisplaySmall（引导页大标题）/ HeadlineSmall（统计数值、欢迎标题）/
 * TitleMedium（卡片标题）/ BodyMedium（正文）/ LabelSmall（辅助说明、标签）。
 * 另加 HeadlineMedium / TitleLarge 两档，专供 Material3 大标题顶栏的展开 / 折叠态，
 * 保证顶栏字重与卡片标题一致（默认 Typography 是 Normal，偏轻）。
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
    /* TopAppBar 展开态使用 HeadlineMedium，折叠态使用 TitleLarge；一并覆盖成半粗，
       避免大标题在默认 Typography 下是 Normal 字重、与卡片标题层级不统一。 */
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
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.2.sp
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.4.sp
    )
)
