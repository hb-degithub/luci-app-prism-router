package io.prism.router.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 首启页地址校验的纯逻辑测试：锁定空地址 / 非法 scheme 的提示文案，
 * 以及 http(s) 与首尾空白的放行规则（与 WelcomeScreen 的提交逻辑一致）。
 */
class WelcomeValidationTest {
    @Test
    fun blankAddressKeepsTheOriginalMessage() {
        val expected = "请填写路由器地址，例如 http://192.168.100.1:8099"
        assertEquals(expected, welcomeInputError(""))
        assertEquals(expected, welcomeInputError("   "))
    }

    @Test
    fun invalidSchemeKeepsTheOriginalMessage() {
        val expected = "路由器地址需要以 http:// 或 https:// 开头"
        assertEquals(expected, welcomeInputError("192.168.100.1:8099"))
        assertEquals(expected, welcomeInputError("ftp://192.168.100.1"))
        assertEquals(expected, welcomeInputError("http:/192.168.100.1"))
    }

    @Test
    fun httpAndHttpsAreAcceptedAfterTrim() {
        assertNull(welcomeInputError("http://192.168.100.1:8099"))
        assertNull(welcomeInputError("https://192.168.100.1:8099"))
        assertNull(welcomeInputError("  http://192.168.100.1:8099  "))
    }
}
