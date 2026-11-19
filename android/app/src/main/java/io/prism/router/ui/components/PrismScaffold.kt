package io.prism.router.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll

/**
 * 棱镜路由页面骨架。
 *
 * 结构：大标题 TopAppBar（可折叠）+ 内容 + 可选底部栏 / FAB。
 * 滚动联动通过 [nestedScroll] 接到内容区的可滚动容器上，LazyColumn / verticalScroll
 * 都能让大标题收起（`exitUntilCollapsedScrollBehavior`）。
 *
 * 边到边说明：
 * - 状态栏：交给 TopAppBar 默认 windowInsets 处理；
 * - 导航栏：由外层 App Scaffold 的底部栏 / navigationBarsPadding 统一处理，
 *   因此这里默认 [contentWindowInsets] 为 0，避免嵌套 Scaffold 重复加底部内边距。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrismScaffold(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    largeTitle: Boolean = true,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    contentWindowInsets: WindowInsets = WindowInsets(0, 0, 0, 0),
    content: @Composable (PaddingValues) -> Unit
) {
    /* 无条件创建，保证组合结构稳定；largeTitle=false 时不挂到顶栏即可。 */
    val collapsingBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val scrollBehavior = if (largeTitle) collapsingBehavior else null
    val nestedScrollModifier = if (scrollBehavior != null) {
        Modifier.nestedScroll(scrollBehavior.nestedScrollConnection)
    } else {
        Modifier
    }

    Scaffold(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = contentWindowInsets,
        topBar = {
            PrismTopBar(
                title = title,
                subtitle = subtitle,
                navigationIcon = navigationIcon,
                actions = actions,
                scrollBehavior = scrollBehavior
            )
        },
        bottomBar = bottomBar,
        floatingActionButton = floatingActionButton
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .then(nestedScrollModifier)
        ) {
            content(innerPadding)
        }
    }
}
