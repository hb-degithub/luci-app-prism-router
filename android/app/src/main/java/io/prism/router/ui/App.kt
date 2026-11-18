package io.prism.router.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
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
import io.prism.router.data.MainViewModel

@Composable
fun App(vm: MainViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val ui = vm.ui

    LaunchedEffect(Unit) { vm.start() }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == 0,
                    onClick = { tab = 0 },
                    icon = { Icon(Icons.Rounded.Speed, contentDescription = "概览") },
                    label = { Text("概览") }
                )
                NavigationBarItem(
                    selected = tab == 1,
                    onClick = { tab = 1 },
                    icon = { Icon(Icons.Rounded.Devices, contentDescription = "设备") },
                    label = { Text("设备") }
                )
                NavigationBarItem(
                    selected = tab == 2,
                    onClick = { tab = 2 },
                    icon = { Icon(Icons.Rounded.Apps, contentDescription = "应用") },
                    label = { Text("应用") }
                )
                NavigationBarItem(
                    selected = tab == 3,
                    onClick = { tab = 3 },
                    icon = { Icon(Icons.Rounded.Hub, contentDescription = "节点") },
                    label = { Text("节点") }
                )
                NavigationBarItem(
                    selected = tab == 4,
                    onClick = { tab = 4 },
                    icon = { Icon(Icons.Rounded.Settings, contentDescription = "设置") },
                    label = { Text("设置") }
                )
            }
        }
    ) { inner ->
        Box(Modifier.padding(inner)) {
            when (tab) {
                0 -> OverviewScreen(ui, onRefresh = { vm.refresh() }, onOpenDevices = { tab = 1 })
                1 -> DevicesScreen(ui)
                2 -> AppsScreen(ui)
                3 -> NodesScreen(ui)
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
