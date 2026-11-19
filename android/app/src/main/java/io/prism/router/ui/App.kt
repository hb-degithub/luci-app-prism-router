package io.prism.router.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Apps
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import io.prism.router.data.MainViewModel

/**
 * 底部导航 6 项：概览 / 设备 / 应用 / 节点 / 拓扑 / 设置。
 *
 * 390px 宽度下 6 个 item 均分，标签单行；文案沿用 Material3 默认字号。
 * 拓扑页只读，重试子节点数据走 ViewModel.refreshNodes()。
 */
@Composable
fun App(vm: MainViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val ui = vm.ui

    LaunchedEffect(Unit) { vm.start() }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavTab(tab, 0, "概览", Icons.Rounded.Speed) { tab = it }
                NavTab(tab, 1, "设备", Icons.Rounded.Devices) { tab = it }
                NavTab(tab, 2, "应用", Icons.Rounded.Apps) { tab = it }
                NavTab(tab, 3, "节点", Icons.Rounded.Hub) { tab = it }
                NavTab(tab, 4, "拓扑", Icons.Rounded.AccountTree) { tab = it }
                NavTab(tab, 5, "设置", Icons.Rounded.Settings) { tab = it }
            }
        }
    ) { inner ->
        Box(Modifier.padding(inner)) {
            when (tab) {
                0 -> OverviewScreen(ui, onRefresh = { vm.refresh() }, onOpenDevices = { tab = 1 })
                1 -> DevicesScreen(ui)
                2 -> AppsScreen(ui)
                3 -> NodesScreen(ui, onRetryNodes = { vm.refreshNodes() })
                4 -> TopologyScreen(ui, onRetryNodes = { vm.refreshNodes() })
                else -> SettingsScreen(
                    ui = ui,
                    onSave = { base, token, interval -> vm.saveSettings(base, token, interval) },
                    onTest = { base, token, cb -> vm.testConnection(base, token, cb) },
                    onRefresh = { vm.refresh() }
                )
            }
        }
    }
}

@Composable
private fun RowScope.NavTab(
    current: Int,
    index: Int,
    label: String,
    icon: ImageVector,
    onSelect: (Int) -> Unit
) {
    NavigationBarItem(
        selected = current == index,
        onClick = { onSelect(index) },
        icon = { Icon(icon, contentDescription = label) },
        label = { Text(label, maxLines = 1) }
    )
}
