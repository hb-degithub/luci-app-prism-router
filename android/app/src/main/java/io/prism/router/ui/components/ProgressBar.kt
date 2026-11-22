package io.prism.router.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * 极简进度条（自绘）。
 *
 * 为什么不用 Material3 的 LinearProgressIndicator：
 * 1.3.x 的确定进度条会在终点画一个「stop indicator」圆点，在设备占比 / 出口占比
 * 这种 6dp 细条上看起来像一颗悬空的多余圆点；不同版本参数名与默认值也不稳定。
 * 这里用 Canvas 画圆角轨道 + 圆角进度段，两端都是干净圆头，没有任何附加装饰。
 *
 * 进度会先 coerce 到 0..1；读屏通过 [contentDescription] 获取「某某占比」的语义，
 * 不传时只作为视觉装饰（旁边的文字已经给出精确数值）。
 */
@Composable
fun PrismProgressBar(
    progress: Float,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
    trackColor: Color = MaterialTheme.colorScheme.surfaceVariant,
    height: Dp = 6.dp,
    contentDescription: String? = null
) {
    val value = progress.coerceIn(0f, 1f)
    val description = contentDescription
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .semantics {
                progressBarRangeInfo = ProgressBarRangeInfo(value, 0f..1f)
                if (description != null) {
                    this.contentDescription = description
                }
            }
    ) {
        if (size.width <= 0f || size.height <= 0f) return@Canvas
        val radius = CornerRadius(size.height / 2f, size.height / 2f)
        drawRoundRect(
            color = trackColor.copy(alpha = 0.55f),
            topLeft = Offset.Zero,
            size = Size(size.width, size.height),
            cornerRadius = radius
        )
        if (value <= 0f) return@Canvas
        /* 最小画成一颗圆头，避免 1% 时细到看不见。 */
        val barWidth = (size.width * value).coerceAtLeast(size.height)
        drawRoundRect(
            color = color,
            topLeft = Offset.Zero,
            size = Size(barWidth.coerceAtMost(size.width), size.height),
            cornerRadius = radius
        )
    }
}
