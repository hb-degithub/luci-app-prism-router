package io.prism.router.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * `?what=update_check` 的解析与展示辅助（纯 JVM，不访问网络）。
 *
 * 覆盖后端契约的四种形态：未配置 / 有更新（带 apk、ipk 或缺省）/ 已是最新 / 失败；
 * 以及 notes 摘要与 published_at 时区转换。
 */
class UpdateCheckParseTest {
    private val client = SystemClient()

    @Test
    fun parsesNotConfiguredResult() {
        val check = client.parseUpdateCheck(
            """{"configured":false,"message":"未配置 github_repo"}"""
        )
        assertFalse(check.configured)
        assertEquals("未配置 github_repo", check.message)
        assertEquals("", check.latest)
        assertFalse(check.hasUpdate)
        assertFalse(check.hasAsset)
    }

    @Test
    fun parsesUpdateAvailableWithApkOnly() {
        val check = client.parseUpdateCheck(
            """
            {
              "configured": true,
              "repo": "owner/repo",
              "current": "1.0.0",
              "latest": "1.2.0",
              "has_update": true,
              "published_at": "2026-11-19T12:30:00Z",
              "html_url": "https://github.com/owner/repo/releases/tag/v1.2.0",
              "notes": "- 修复统计口径\n- 新增网络配置页",
              "apk": {"name": "prism-1.2.0.apk", "url": "https://example.com/a.apk", "size": 8388608},
              "ipk": null
            }
            """.trimIndent()
        )
        assertTrue(check.configured)
        assertEquals("owner/repo", check.repo)
        assertEquals("1.0.0", check.currentText)
        assertEquals("1.2.0", check.latestText)
        assertTrue(check.hasUpdate)
        assertEquals("2026-11-19T12:30:00Z", check.publishedAt)
        assertEquals(
            "https://github.com/owner/repo/releases/tag/v1.2.0",
            check.htmlUrl
        )
        assertTrue(check.hasAsset)
        assertTrue(check.hasReleasePage)
        assertEquals("prism-1.2.0.apk", check.apk?.name)
        assertEquals("https://example.com/a.apk", check.apk?.url)
        assertEquals(8388608L, check.apk?.size ?: -1L)
        assertEquals("8.0 MB", check.apk?.sizeText)
        assertNull(check.ipk)
        assertEquals("修复统计口径 · 新增网络配置页", check.notesSummary())
    }

    @Test
    fun parsesBothAssetsAndKeepsUnknownSizeEmpty() {
        val check = client.parseUpdateCheck(
            """
            {
              "configured": true,
              "current": "1.0.0",
              "latest": "1.1.0",
              "has_update": true,
              "apk": {"name": "a.apk", "url": "https://example.com/a.apk"},
              "ipk": {"name": "a.ipk", "url": "https://example.com/a.ipk", "size": 0}
            }
            """.trimIndent()
        )
        assertTrue(check.hasAsset)
        assertEquals("", check.apk?.sizeText)
        assertEquals("a.ipk", check.ipk?.name)
        assertEquals("", check.ipk?.sizeText)
    }

    @Test
    fun parsesUpToDateResult() {
        val check = client.parseUpdateCheck(
            """
            {
              "configured": true,
              "repo": "owner/repo",
              "current": "1.2.0",
              "latest": "1.2.0",
              "has_update": false,
              "published_at": "2026-11-19T12:30:00Z",
              "html_url": "https://github.com/owner/repo/releases/tag/v1.2.0",
              "notes": "",
              "apk": null,
              "ipk": null
            }
            """.trimIndent()
        )
        assertTrue(check.configured)
        assertFalse(check.hasUpdate)
        assertFalse(check.hasAsset)
        assertEquals("", check.notesSummary())
    }

    @Test
    fun parsesErrorResult() {
        val check = client.parseUpdateCheck(
            """{"configured":true,"error":"github_unavailable","detail":"timeout"}"""
        )
        assertEquals("github_unavailable", check.error)
        assertEquals("timeout", check.detail)
        assertEquals("?", check.latestText)
    }

    @Test
    fun ignoresEmptyAssetObject() {
        val check = client.parseUpdateCheck(
            """{"configured":true,"latest":"1.1.0","apk":{},"ipk":{"url":""}}"""
        )
        assertNull(check.apk)
        assertNull(check.ipk)
        assertFalse(check.hasAsset)
    }


    @Test
    fun v104ReleaseWithOnlyOldAssetsFallsBackToReleasePage() {
        /*
         * v1.0.4 Release 里如果只剩旧版 v1.0.0 的资产，后端筛选后 apk/ipk 必须为 null，
         * 客户端不得展示旧下载链接，只能打开 html_url 指向的 v1.0.4 Release 页。
         */
        val check = client.parseUpdateCheck(
            """
            {
              "configured": true,
              "repo": "owner/repo",
              "current": "1.0.3",
              "latest": "1.0.4",
              "has_update": true,
              "published_at": "2026-11-22T10:00:00Z",
              "html_url": "https://github.com/owner/repo/releases/tag/v1.0.4",
              "notes": "新 UI 与安装修复",
              "apk": null,
              "ipk": null
            }
            """.trimIndent()
        )
        assertTrue(check.configured)
        assertTrue(check.hasUpdate)
        assertEquals("1.0.4", check.latestText)
        assertFalse(check.hasAsset)
        assertNull(check.apk)
        assertNull(check.ipk)
        assertTrue(check.hasReleasePage)
        assertEquals("https://github.com/owner/repo/releases/tag/v1.0.4", check.htmlUrl)
    }

    @Test
    fun notesSummaryTruncatesLongText() {
        val check = UpdateCheck(notes = "第一行\n\n第二行" + "很长的说明".repeat(100))
        val summary = check.notesSummary(maxChars = 40)
        assertTrue(summary.startsWith("第一行 · 第二行"))
        assertEquals(41, summary.length) // 40 个字符 + 省略号
        assertTrue(summary.endsWith("…"))
    }

    @Test
    fun formatsPublishedAtInGivenZone() {
        val shanghai = ZoneId.of("Asia/Shanghai")
        assertEquals(
            "2026-11-19 20:30",
            formatPublishedAt("2026-11-19T12:30:00Z", shanghai)
        )
        assertEquals(
            "2026-11-19 20:30",
            formatPublishedAt("2026-11-19T20:30:00+08:00", shanghai)
        )
        assertEquals("", formatPublishedAt("", shanghai))
        // 解析不了的值原样返回，不抛异常、不伪造时间。
        assertEquals("unknown", formatPublishedAt("unknown", shanghai))
    }
}
