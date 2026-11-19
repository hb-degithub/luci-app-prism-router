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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing

/**
 * 状态行：左侧状态点（可换成图标）+ 标题 + 说明，右侧可选尾部文案 / 箭头。
 *
 * 用于告警中心、健康原因等「一条状态一件事」的列表：
 * - 颜色由调用方传入（通常是语义色：danger / warning / info / success），
 *   圆点外圈取 14% 同色底，深浅色主题下都比纯圆点更清楚；
 * - 可点击时自动具备 48dp 最小触控高度、Button 角色与整行合并语义，
 *   右侧出现箭头；不可点击时只做展示，不抢焦点；
 * - 水平方向不加内边距，让状态点与卡片标题左对齐，分隔线可整行铺满。
 */
@Composable
fun StatusRow(
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    color: Color = MaterialTheme.colorScheme.primary,
    icon: ImageVector? = null,
    trailingText: String? = null,
    onClick: (() -> Unit)? = null
) {
    val shape = MaterialTheme.shapes.small
    val desc = description?.takeIf { it.isNotBlank() }
    val readOut = listOfNotNull(title, desc, trailingText, if (onClick != null) "点按打开" else null)
        .joinToString("，")

    val clickModifier = if (onClick != null) {
        Modifier
            .clip(shape)
            .clickable(role = Role.Button, onClick = onClick)
            /* mergeDescendants：整行作为一颗按钮被读屏朗读，不逐个文字停顿。 */
            .semantics(mergeDescendants = true) { contentDescription = readOut }
    } else {
        Modifier
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = PrismSize.touchTarget)
            .then(clickModifier)
            .padding(vertical = PrismSpacing.sm),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(20.dp)
                .background(color.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            if (icon != null) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(12.dp)
                )
            } else {
                Box(
                    Modifier
                        .size(6.dp)
                        .background(color, CircleShape)
                )
            }
        }
        Spacer(Modifier.width(PrismSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (desc != null) {
                Spacer(Modifier.height(PrismSpacing.xs))
                Text(
                    text = desc,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        if (!trailingText.isNullOrBlank()) {
            Spacer(Modifier.width(PrismSpacing.sm))
            Text(
                text = trailingText,
                style = MaterialTheme.typography.labelSmall,
                color = color,
                maxLines = 1
            )
        }
        if (onClick != null) {
            Spacer(Modifier.width(PrismSpacing.xs))
            Icon(
                imageVector = Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(PrismSize.iconSmall)
            )
        }
    }
}
