package io.prism.router.ui.components

import androidx.compose.foundation.layout.BoxScope
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * 下拉刷新容器：Material3 [PullToRefreshBox] 的统一入口。
 *
 * 用法：把整屏内容（LazyColumn / 可滚动 Column）作为 [content] 传入，
 * 由本组件负责下拉手势与顶部指示器；克隆到每个屏幕，避免各自重复写
 * `@OptIn(ExperimentalMaterial3Api::class)` 与指示器位置。
 *
 * [isRefreshing] 只应在「用户主动下拉 / 手动重试」期间为 true，
 * 自动轮询不要接入，否则指示器会随每次轮询反复闪动。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RefreshableContent(
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit
) {
    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = onRefresh,
        modifier = modifier,
        content = content
    )
}
