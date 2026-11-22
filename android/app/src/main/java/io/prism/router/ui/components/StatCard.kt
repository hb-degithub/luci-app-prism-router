package io.prism.router.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing

/**
 * 统计卡片：标签 + 主数值（可带单位）+ 可选图标 / 说明。
 *
 * - [accent] 决定左侧强调条与图标底色；
 * - 可点击时自动具备 48dp 触控高度、Button 语义与整卡内容描述；
 * - 数值使用 HeadlineSmall + tabular figures，单位使用 LabelSmall，
 *   避免长数字撑破一行或在轮询时抖动。
 */
@Composable
fun StatCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    unit: String? = null,
    accent: Color = MaterialTheme.colorScheme.primary,
    icon: ImageVector? = null,
    caption: String? = null,
    onClick: (() -> Unit)? = null
) {
    val shape = MaterialTheme.shapes.medium
    val description = remember(label, value, unit, caption) {
        listOfNotNull(label, value, unit, caption).joinToString(" ")
    }
    val clickModifier = if (onClick != null) {
        Modifier
            .clip(shape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description }
    } else {
        Modifier
    }

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 88.dp)
            .then(clickModifier),
        shape = shape,
        color = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.lg),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .width(3.dp)
                    .height(40.dp)
                    .background(accent, RoundedCornerShape(2.dp))
            )
            Spacer(Modifier.width(PrismSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.height(PrismSpacing.xs))
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        text = value,
                        style = MaterialTheme.typography.headlineSmall.copy(
                            fontFeatureSettings = "tnum"
                        ),
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (!unit.isNullOrBlank()) {
                        Spacer(Modifier.width(PrismSpacing.xs))
                        Text(
                            text = unit,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 4.dp)
                        )
                    }
                }
                if (!caption.isNullOrBlank()) {
                    Spacer(Modifier.height(PrismSpacing.xs))
                    Text(
                        text = caption,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            if (icon != null) {
                Spacer(Modifier.width(PrismSpacing.md))
                Box(
                    modifier = Modifier
                        .size(PrismSize.avatar)
                        .background(accent.copy(alpha = 0.12f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(PrismSize.icon)
                    )
                }
            }
        }
    }
}
