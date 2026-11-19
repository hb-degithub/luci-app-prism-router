package io.prism.router.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.prism.router.data.UiState
import io.prism.router.ui.components.Segmented

/** 网络页的两个子视图：拓扑图与节点列表。 */
private enum class NetworkTab(val label: String) {
    TOPOLOGY("拓扑"),
    NODES("节点")
}

/**
 * 网络页 = 拓扑 + 节点合并。
 *
 * 顶部用 [Segmented] 切换，下面直接复用现有 [TopologyScreen] / [NodesScreen] 的
 * 整屏 Composable（它们各自带 LazyColumn 与页头），本页只负责容器与切换，
 * 不复制也不改动两者的数据逻辑。屏幕内容重做由后续任务统一处理。
 */
@Composable
fun NetworkScreen(
    ui: UiState,
    onRetryNodes: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    var tabIndex by rememberSaveable { mutableIntStateOf(0) }
    val tabs = NetworkTab.entries

    Column(modifier = modifier.fillMaxSize()) {
        Segmented(
            options = tabs,
            selected = tabs[tabIndex.coerceIn(0, tabs.lastIndex)],
            onSelect = { tab -> tabIndex = tab.ordinal },
            label = { it.label },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp)
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (tabs[tabIndex.coerceIn(0, tabs.lastIndex)]) {
                NetworkTab.TOPOLOGY -> TopologyScreen(ui, onRetryNodes)
                NetworkTab.NODES -> NodesScreen(ui, onRetryNodes)
            }
        }
    }
}
