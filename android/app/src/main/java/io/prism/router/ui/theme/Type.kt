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
 * 阶梯只定义 5 档，页面里只允许从这里取：
 * DisplaySmall（引导页大标题）/ HeadlineSmall（统计数值、欢迎标题）/
 * TitleMedium（卡片标题）/ BodyMedium（正文）/ LabelSmall（辅助说明、标签）。
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
