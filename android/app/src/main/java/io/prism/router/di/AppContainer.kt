package io.prism.router.di

import android.content.Context
import io.prism.router.data.ControlClient
import io.prism.router.data.PanelClient
import io.prism.router.data.repository.PanelRepository
import io.prism.router.data.store.SettingsStore
import io.prism.router.notify.AlertsNotifier

/**
 * 轻量依赖容器（不引入 Hilt / Koin）。
 *
 * 生命周期跟随 [io.prism.router.PrismApplication]：进程内单例，持有数据层对象，
 * ViewModel 通过 `application as PrismApplication` 取用。构造本身不做网络 / 磁盘 IO，
 * 打开应用的开销仍然只在各 ViewModel / 屏幕首次读取时发生。
 *
 * 之所以不把 PanelClient / ControlClient 暴露给 UI：屏幕只需要 Repository 或
 * 既有的无参客户端实例，容器保持唯一装配点，后续替换实现（测试 / 多面板）只改这里。
 */
class AppContainer(context: Context) {

    /** Application context，避免任何地方误持有 Activity。 */
    val appContext: Context = context.applicationContext

    /** 设置存储：DataStore Preferences（含旧 SharedPreferences 的一次性迁移）。 */
    val settingsStore: SettingsStore = SettingsStore(appContext)

    /** 面板读写仓库：统一错误映射、IO 线程切换。 */
    val panelRepository: PanelRepository = PanelRepository(
        panelClient = PanelClient(),
        controlClient = ControlClient()
    )

    /**
     * 本地告警通知器（现状是 object，容器直接持有引用）。
     * 后续若改为实例类（可注入通知渠道 / 时钟），只需在这里换实现。
     */
    val alertsNotifier: AlertsNotifier = AlertsNotifier
}
