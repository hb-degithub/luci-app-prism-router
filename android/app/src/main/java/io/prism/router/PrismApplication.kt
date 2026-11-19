package io.prism.router

import android.app.Application
import io.prism.router.di.AppContainer

/**
 * 应用入口：创建并持有轻量依赖容器 [AppContainer]。
 *
 * 在 AndroidManifest.xml 里通过 `android:name=".PrismApplication"` 注册；
 * [MainViewModel][io.prism.router.data.MainViewModel] 以 `AndroidViewModel`
 * 构造，从 `application as PrismApplication` 取容器，无需 Hilt。
 */
class PrismApplication : Application() {

    /**
     * 进程级容器，首次访问时创建（线程安全）。
     *
     * 构造容器只做对象装配，不触发网络 / 磁盘读写，因此放在 lazy 里也不会拖慢冷启动；
     * 设置迁移由 [io.prism.router.data.store.SettingsStore.settings] 首次收集触发。
     */
    val container: AppContainer by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        AppContainer(this)
    }

    override fun onCreate() {
        super.onCreate()
        /* 主动装配一次：尽早暴露配置 / 依赖问题，而不是等到第一个屏幕创建 ViewModel。 */
        container
    }
}
