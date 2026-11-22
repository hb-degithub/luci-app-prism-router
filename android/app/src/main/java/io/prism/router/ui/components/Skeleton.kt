package io.prism.router.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSpacing

/**
 * 列表骨架屏：加载中占位，避免空白页 + 转圈。
 *
 * 使用整屏统一的呼吸透明度动画（900ms 往复），不绘制 shimmer 渐变，
 * 在低端机与深色模式下都稳定；容器带「内容加载中」语义，读屏不会读到空白。
 */
@Composable
fun SkeletonList(
    rows: Int = 6,
    modifier: Modifier = Modifier,
    showHeader: Boolean = true
) {
    val transition = rememberInfiniteTransition(label = "prism-skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.9f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "prism-skeleton-alpha"
    )

    Column(
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = "内容加载中" },
        verticalArrangement = Arrangement.spacedBy(PrismSpacing.sm)
    ) {
        if (showHeader) {
            SkeletonBox(
                modifier = Modifier
                    .fillMaxWidth(0.42f)
                    .height(20.dp),
                alpha = alpha
            )
            Spacer(Modifier.height(PrismSpacing.xs))
        }
        repeat(rows.coerceAtLeast(1)) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surface,
                tonalElevation = 0.dp,
                shadowElevation = 0.dp
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(PrismSpacing.lg),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    SkeletonBox(
                        modifier = Modifier.size(40.dp),
                        alpha = alpha,
                        shape = CircleShape
                    )
                    Spacer(Modifier.width(PrismSpacing.md))
                    Column(Modifier.weight(1f)) {
                        SkeletonBox(
                            modifier = Modifier
                                .fillMaxWidth(0.55f)
                                .height(14.dp),
                            alpha = alpha
                        )
                        Spacer(Modifier.height(PrismSpacing.sm))
                        SkeletonBox(
                            modifier = Modifier
                                .fillMaxWidth(0.8f)
                                .height(10.dp),
                            alpha = alpha
                        )
                    }
                    Spacer(Modifier.width(PrismSpacing.md))
                    SkeletonBox(
                        modifier = Modifier
                            .width(52.dp)
                            .height(14.dp),
                        alpha = alpha
                    )
                }
            }
        }
    }
}

/** 单个骨架块；[shape] 默认 12dp 圆角。 */
@Composable
fun SkeletonBox(
    modifier: Modifier = Modifier,
    alpha: Float = 0.6f,
    shape: Shape = RoundedCornerShape(PrismRadius.small)
) {
    Box(
        modifier = modifier
            .clip(shape)
            .background(
                MaterialTheme.colorScheme.onSurface.copy(alpha = (alpha * 0.12f).coerceIn(0.04f, 0.16f)),
                shape
            )
    )
}
