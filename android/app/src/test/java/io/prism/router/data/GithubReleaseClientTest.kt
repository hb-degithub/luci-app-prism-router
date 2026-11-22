package io.prism.router.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference

/**
 * GitHub Releases 客户端：选版规则、错误分类、请求头（全部纯 JVM，不访问网络）。
 *
 * 用 OkHttp Interceptor 返回构造好的 JSON，既覆盖真实请求构建（URL / UA / Accept），
 * 又避免单测依赖外网。
 */
class GithubReleaseClientTest {
    private fun clientReturning(
        body: String,
        code: Int = 200,
        headers: Map<String, String> = emptyMap(),
        seen: AtomicReference<Request>? = null
    ): GithubReleaseClient {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            seen?.set(chain.request())
            val builder = Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message(if (code == 200) "OK" else "Error")
                .body(body.toResponseBody("application/json".toMediaType()))
            headers.forEach { (name, value) -> builder.header(name, value) }
            builder.build()
        }.build()
        return GithubReleaseClient(http)
    }

    @Test
    fun selectsHighestVersionWithApkAndIgnoresDraftPrereleaseAndNonApk() {
        val json = """
            [
              {
                "tag_name": "v9.9.9",
                "draft": true,
                "prerelease": false,
                "published_at": "2026-11-21T00:00:00Z",
                "assets": [
                  {"name": "prism-router-9.9.9.apk", "browser_download_url": "https://example.com/9.9.9.apk"}
                ]
              },
              {
                "tag_name": "v8.8.8",
                "draft": false,
                "prerelease": true,
                "published_at": "2026-11-21T00:00:00Z",
                "assets": [
                  {"name": "prism-router-8.8.8.apk", "browser_download_url": "https://example.com/8.8.8.apk"}
                ]
              },
              {
                "tag_name": "v1.0.12",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-20T12:00:00Z",
                "html_url": "https://github.com/hb-degithub/luci-app-prism-router/releases/tag/v1.0.12",
                "body": "- 修复更新检查\n- 版本解耦",
                "assets": [
                  {"name": "prism-router-1.0.12.apk", "browser_download_url": "https://example.com/1.0.12.apk"},
                  {"name": "prism-router-1.0.12.ipk", "browser_download_url": "https://example.com/1.0.12.ipk"}
                ]
              },
              {
                "tag_name": "v2.0.0",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-21T00:00:00Z",
                "assets": [
                  {"name": "prism-router-2.0.0.ipk", "browser_download_url": "https://example.com/2.0.0.ipk"}
                ]
              },
              {
                "tag_name": "v1.0.11",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-20T00:00:00Z",
                "assets": [
                  {"name": "README.txt", "browser_download_url": "https://example.com/README.txt"}
                ]
              },
              {
                "tag_name": "v1.0.10",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-19T00:00:00Z",
                "assets": []
              }
            ]
        """.trimIndent()

        val release = clientReturning(json).selectLatestRelease(json)
        assertEquals("v1.0.12", release?.tag)
        assertEquals("1.0.12", release?.versionName)
        assertEquals(10012, release?.versionCode)
        assertEquals("prism-router-1.0.12.apk", release?.apkName)
        assertEquals("https://example.com/1.0.12.apk", release?.apkUrl)
        assertEquals("修复更新检查 · 版本解耦", release?.notesSummary())
        assertEquals(
            "https://github.com/hb-degithub/luci-app-prism-router/releases/tag/v1.0.12",
            release?.htmlUrl
        )
        assertTrue(release?.hasApk == true)
        assertTrue(release?.hasReleasePage == true)
    }

    @Test
    fun normalizesAppTagPrefixForAppOnlyRelease() {
        val json = """
            [
              {
                "tag_name": "app-v1.0.13",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-22T00:00:00Z",
                "html_url": "https://github.com/hb-degithub/luci-app-prism-router/releases/tag/app-v1.0.13",
                "assets": [
                  {"name": "prism-router-1.0.13.apk", "browser_download_url": "https://example.com/1.0.13.apk"}
                ]
              }
            ]
        """.trimIndent()

        val release = clientReturning(json).selectLatestRelease(json)
        assertEquals("app-v1.0.13", release?.tag)
        assertEquals("1.0.13", release?.versionName)
        assertEquals(10013, release?.versionCode)
    }

    @Test
    fun ignoresApkWithHttpOrApiUrl() {
        val json = """
            [
              {
                "tag_name": "v1.0.14",
                "assets": [
                  {"name": "prism-router-1.0.14.apk", "browser_download_url": "http://example.com/1.0.14.apk"},
                  {"name": "prism-router-1.0.14.apk", "url": "https://api.github.com/assets/1"}
                ]
              },
              {
                "tag_name": "v1.0.13",
                "assets": [
                  {"name": "prism-router-1.0.13.apk", "browser_download_url": "https://example.com/1.0.13.apk"}
                ]
              }
            ]
        """.trimIndent()

        val release = clientReturning(json).selectLatestRelease(json)
        assertEquals("1.0.13", release?.versionName)
    }

    @Test
    fun returnsNullWhenNoReleaseHasApk() {
        val json = """
            [
              {"tag_name": "v1.0.1", "assets": [{"name": "pkg.ipk", "browser_download_url": "https://example.com/pkg.ipk"}]},
              {"tag_name": "v1.0.0", "assets": []}
            ]
        """.trimIndent()

        assertNull(clientReturning(json).selectLatestRelease(json))
    }

    @Test
    fun requestUsesFixedUrlAndRequiredHeaders() {
        val seen = AtomicReference<Request>()
        val json = """
            [
              {
                "tag_name": "v1.0.9",
                "assets": [
                  {"name": "prism-router-1.0.9.apk", "browser_download_url": "https://example.com/1.0.9.apk"}
                ]
              }
            ]
        """.trimIndent()

        val release = clientReturning(json, seen = seen).fetchLatestRelease()

        assertEquals(GithubReleaseClient.RELEASES_URL, seen.get()?.url.toString())
        assertEquals(GithubReleaseClient.USER_AGENT, seen.get()?.header("User-Agent"))
        assertEquals(GithubReleaseClient.ACCEPT, seen.get()?.header("Accept"))
        assertNull(seen.get()?.header("Authorization"))
        assertEquals("1.0.9", release.versionName)
    }

    @Test
    fun maps403RateLimitToReadableError() {
        val client = clientReturning(
            body = """{"message":"API rate limit exceeded for 1.2.3.4"}""",
            code = 403,
            headers = mapOf("X-RateLimit-Remaining" to "0")
        )
        val error = assertThrows(GithubReleaseException::class.java) { client.fetchLatestRelease() }
        assertEquals("rate_limit", error.code)
        assertTrue(error.message.contains("限流"))
        assertFalse(error.message.contains("1.2.3.4"))
    }

    @Test
    fun mapsNetworkFailureToReadableError() {
        val http = OkHttpClient.Builder().addInterceptor { throw IOException("offline") }.build()
        val error = assertThrows(GithubReleaseException::class.java) {
            GithubReleaseClient(http).fetchLatestRelease()
        }
        assertEquals("network", error.code)
        assertTrue(error.message.contains("网络"))
    }

    @Test
    fun mapsEmptyReleaseListToNoReleaseError() {
        val error = assertThrows(GithubReleaseException::class.java) {
            clientReturning("[]").fetchLatestRelease()
        }
        assertEquals("no_release", error.code)
        assertTrue(error.message.contains("没有找到带 APK"))
    }

    @Test
    fun mapsMalformedJsonToBadResponse() {
        val error = assertThrows(GithubReleaseException::class.java) {
            clientReturning("{not json").fetchLatestRelease()
        }
        assertEquals("bad_response", error.code)
    }

    @Test
    fun semverComparisonHandlesPreReleaseAndMissingSegments() {
        assertTrue(compareSemanticVersions("1.0.10", "1.0.9") > 0)
        assertTrue(compareSemanticVersions("1.10.0", "1.9.9") > 0)
        assertTrue(compareSemanticVersions("1.0.0", "1.0.0-beta") > 0)
        assertEquals(0, compareSemanticVersions("v1.0.9", "app-v1.0.9"))
    }

    @Test
    fun versionCodeFollowsProjectRuleAndRejectsOutOfRangeSegments() {
        assertEquals(10009, versionCodeFor("1.0.9"))
        assertEquals(10203, versionCodeFor("1.2.3"))
        assertNull(versionCodeFor("1.100.0"))
        assertNull(versionCodeFor("1.0.100"))
        assertNull(versionCodeFor("1.0"))
    }
}
