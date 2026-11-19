package io.prism.router.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import io.prism.router.ui.theme.PrismRadius
import io.prism.router.ui.theme.PrismSize
import io.prism.router.ui.theme.PrismSpacing

/**
 * 通用分段选择器（替代散落的 SingleChoiceSegmentedButtonRow）。
 *
 * - 外层胶囊 + 内层 4dp 留白，选中项填充 primary；
 * - 每项最小 48dp 高，整块可点，带 Tab 角色与 selected 语义；
 * - 选项是泛型，文案通过 [label] 映射，网络页的「拓扑 / 节点」、外观页的
 *   「跟随系统 / 浅色 / 深色」共用同一实现。
 */
@Composable
fun <T> Segmented(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    label: (T) -> String = { it.toString() }
) {
    if (options.isEmpty()) return

    Surface(
        modifier = modifier.alpha(if (enabled) 1f else 0.5f),
        shape = RoundedCornerShape(PrismRadius.pill),
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(PrismSpacing.xs)
                .selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(PrismSpacing.xs)
        ) {
            options.forEach { option ->
                val isSelected = option == selected
                val background by animateColorAsState(
                    targetValue = if (isSelected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        Color.Transparent
                    },
                    label = "prism-segmented-background"
                )
                val foreground by animateColorAsState(
                    targetValue = if (isSelected) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    label = "prism-segmented-foreground"
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = PrismSize.touchTarget)
                        .clip(RoundedCornerShape(PrismRadius.pill))
                        .background(background)
                        .selectable(
                            selected = isSelected,
                            enabled = enabled,
                            role = Role.Tab,
                            onClick = { onSelect(option) }
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = label(option),
                        style = MaterialTheme.typography.labelLarge,
                        color = foreground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = PrismSpacing.sm)
                    )
                }
            }
        }
    }
}
