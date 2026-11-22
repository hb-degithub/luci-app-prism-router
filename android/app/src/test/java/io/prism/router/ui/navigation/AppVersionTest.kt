package io.prism.router.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * About 页版本文案（纯 JVM，不依赖 PackageManager）。
 *
 * 真实 versionName/versionCode 由 Gradle 注入、运行时从 PackageManager 读取；
 * 这里只锁定展示格式，防止有人把版本写死回 "1.0.0 (1)"。
 */
class AppVersionTest {
    @Test
    fun formatsVersionNameAndCode() {
        assertEquals("1.0.4 (4)", formatAppVersion("1.0.4", 4))
        assertEquals("1.0.4 (10004)", formatAppVersion(" 1.0.4 ", 10004))
    }

    @Test
    fun fallsBackWhenVersionNameMissing() {
        assertEquals("? (0)", formatAppVersion(null, 0))
        assertEquals("? (7)", formatAppVersion("   ", 7))
    }
}
