package io.prism.router.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.TopAppBarScrollBehavior
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.prism.router.ui.theme.PrismSize

/**
 * 统一顶栏。
 *
 * - [scrollBehavior] 非空时使用 Material3 的 LargeTopAppBar：展开态是大标题，
 *   滚动后折叠为 64dp 的小标题（配合 `exitUntilCollapsedScrollBehavior`）；
 * - 为空时使用普通 TopAppBar（设置子页等二级页面）。
 *
 * 状态栏透明由 Activity 的 edge-to-edge 负责，这里只依赖 TopAppBar 默认的
 * windowInsets（会为状态栏留出高度），不做额外 padding，避免二次叠加。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrismTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    scrollBehavior: TopAppBarScrollBehavior? = null,
    colors: TopAppBarColors = TopAppBarDefaults.topAppBarColors(
        containerColor = Color.Transparent,
        scrolledContainerColor = MaterialTheme.colorScheme.surface
    )
) {
    /* 折叠后只保留标题，副标题在展开态出现，避免 64dp 内挤两行。 */
    val collapsedFraction = scrollBehavior?.state?.collapsedFraction ?: 0f
    val showSubtitle = subtitle != null && (scrollBehavior == null || collapsedFraction < 0.55f)

    val titleContent: @Composable () -> Unit = {
        Column {
            Text(
                text = title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            if (showSubtitle) {
                Text(
                    text = subtitle.orEmpty(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }
    }

    if (scrollBehavior != null) {
        LargeTopAppBar(
            title = titleContent,
            modifier = modifier,
            navigationIcon = navigationIcon ?: {},
            actions = actions,
            colors = colors,
            scrollBehavior = scrollBehavior
        )
    } else {
        TopAppBar(
            title = titleContent,
            modifier = modifier,
            navigationIcon = navigationIcon ?: {},
            actions = actions,
            colors = colors
        )
    }
}

/**
 * 顶栏图标动作：统一 48dp 触控目标与 20dp 图标。
 *
 * 纯图标按钮必须提供 [contentDescription]，读屏才能知道点下去会发生什么。
 */
@Composable
fun PrismIconAction(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            modifier = Modifier.size(PrismSize.icon)
        )
    }
}
