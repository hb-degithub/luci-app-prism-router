package io.prism.router.data

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * GitHub Releases 查询失败。
 *
 * [code] 是稳定错误码（`network` / `timeout` / `rate_limit` / `forbidden` /
 * `not_found` / `server` / `http` / `bad_response` / `no_release`），
 * [message] 已是可直接展示的中文，且不包含 URL / token / 响应体。
 */
class GithubReleaseException(val code: String, override val message: String) : Exception(message)

/**
 * **App 自身的**更新客户端：直接查询公开的 GitHub Releases，不经过路由器。
 *
 * 背景：旧实现调用 `<路由器>/cgi-bin/prism-router-system?what=update_check`，
 * 由路由器代查 GitHub 并返回**插件 / IPK** 版本。路由器离线就无法检查更新，
 * 而且比较的是插件版本，不是 App 版本。本类彻底去掉这两个依赖：
 *
 * - 固定请求 `https://api.github.com/repos/<repo>/releases?per_page=20`；
 * - 无 token（公开仓库），只带 `User-Agent: prism-router-android` 与
 *   `Accept: application/vnd.github+json`；
 * - 忽略 draft / prerelease，只保留 assets 里有可下载 `.apk` 的 release；
 * - 按 tag 的语义版本（去掉 `app-v` / `android-v` / `v` 前缀）排序取最高；
 * - 网络失败 / 403 限流 / 404 / 5xx / 没有 APK 都抛 [GithubReleaseException]，
 *   由界面展示可读文案，**绝不回退到路由器接口，也不静默返回空结果**。
 *
 * 方法阻塞，调用方负责放到 IO 线程（与 [SystemClient] / [PanelClient] 一致）。
 * 解析与选版逻辑是纯函数（[selectLatestRelease]），可脱离网络单测。
 */
class GithubReleaseClient(
    private val http: OkHttpClient = defaultHttpClient(),
    private val releasesUrl: String = RELEASES_URL
) {
    companion object {
        /** App 更新只认这个仓库。 */
        const val REPO = "hb-degithub/luci-app-prism-router"

        /** 固定接口；`per_page=20` 够覆盖近期发版，也控制了响应体大小。 */
        const val RELEASES_URL = "https://api.github.com/repos/$REPO/releases?per_page=20"

        /** GitHub API 要求提供 UA；不带 UA 会 403。 */
        const val USER_AGENT = "prism-router-android"

        /** 固定 JSON 媒体类型，避免拿到 HTML 错误页。 */
        const val ACCEPT = "application/vnd.github+json"

        private const val CONNECT_TIMEOUT_SEC = 8L
        private const val READ_TIMEOUT_SEC = 12L
        private const val CALL_TIMEOUT_SEC = 20L

        /** 默认 HTTP 客户端：只用于 GitHub API，不共享面板客户端的连接池配置。 */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
            .callTimeout(CALL_TIMEOUT_SEC, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    /**
     * 查询并返回「版本最高且带 APK」的正式 Release。
     *
     * 失败时抛 [GithubReleaseException]（可读中文）；调用方不要再回退到路由器
     * `update_check`，否则又会把插件版本当成 App 版本。
     */
    fun fetchLatestRelease(): GithubRelease {
        val request = Request.Builder()
            .url(releasesUrl)
            .header("User-Agent", USER_AGENT)
            .header("Accept", ACCEPT)
            .get()
            .build()
        try {
            http.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (response.code !in 200..299) {
                    throw httpFailure(
                        httpCode = response.code,
                        body = body,
                        rateLimitRemaining = response.header("X-RateLimit-Remaining")
                    )
                }
                return selectLatestRelease(body) ?: throw GithubReleaseException(
                    "no_release",
                    "GitHub 上没有找到带 APK 的正式版本（可能只有插件包或预发布版）"
                )
            }
        } catch (e: GithubReleaseException) {
            throw e
        } catch (e: SocketTimeoutException) {
            throw GithubReleaseException("timeout", "连接 GitHub 超时，请检查网络后重试")
        } catch (e: InterruptedIOException) {
            throw GithubReleaseException("timeout", "连接 GitHub 超时，请检查网络后重试")
        } catch (e: IOException) {
            throw GithubReleaseException("network", "无法访问 GitHub，请检查网络连接")
        } catch (e: Exception) {
            throw GithubReleaseException("bad_response", "GitHub Releases 响应处理失败，请稍后重试")
        }
    }

    /**
     * 从 GitHub Releases JSON 中选出 App 发版（纯函数，不访问网络）。
     *
     * 规则：
     * 1. 只看正式版（`draft=false`、`prerelease=false`）；
     * 2. assets 里必须有以 `.apk` 结尾、`browser_download_url` 为 https 的资产；
     * 3. tag 必须能解析成语义版本（允许 `app-v` / `android-v` / `v` 前缀）；
     * 4. 取版本号最高者；版本相同时取 `published_at` 较新的。
     *
     * @return 没有合格 release 时返回 `null`；JSON 结构非法时抛
     *   [GithubReleaseException]（`bad_response`），让调用方明确报错而不是静默。
     */
    fun selectLatestRelease(body: String): GithubRelease? {
        val releases = parseReleases(body)
        return releases.maxWithOrNull { a, b ->
            val byVersion = compareSemanticVersions(a.versionName, b.versionName)
            if (byVersion != 0) byVersion else a.publishedAt.compareTo(b.publishedAt)
        }
    }

    /**
     * 解析 Releases JSON 数组为候选列表（已过滤 draft / prerelease / 无 APK /
     * 版本号不可解析的条目）。纯函数，公开给单测。
     */
    fun parseReleases(body: String): List<GithubRelease> {
        val array = try {
            JSONArray(body)
        } catch (e: Exception) {
            throw GithubReleaseException("bad_response", "GitHub Releases 返回了无法解析的数据")
        }
        val out = ArrayList<GithubRelease>(minOf(array.length(), 20))
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            if (obj.optBoolean("draft", false) || obj.optBoolean("prerelease", false)) continue

            val tag = obj.optString("tag_name", "").trim()
            if (tag.isEmpty()) continue
            val versionName = normalizeReleaseTag(tag)
            if (parseSemVer(versionName) == null) continue

            val apk = selectApk(obj.optJSONArray("assets")) ?: continue
            out.add(
                GithubRelease(
                    tag = tag,
                    versionName = versionName,
                    versionCode = versionCodeFor(versionName),
                    apkName = apk.first,
                    apkUrl = apk.second,
                    body = obj.optString("body", ""),
                    publishedAt = obj.optString("published_at", "").trim(),
                    htmlUrl = obj.optString("html_url", "").trim()
                )
            )
        }
        return out
    }

    /* ───────────────────────── 解析辅助 ───────────────────────── */

    /**
     * 从 assets 里选第一个可直链下载的 `.apk`。
     *
     * 不做 ABI / 架构猜测（当前只有通用 APK）；只认 https 的
     * `browser_download_url`，不把 API 的 `url` 当下载地址（它需要额外的 Accept 头）。
     */
    private fun selectApk(assets: JSONArray?): Pair<String, String>? {
        if (assets == null) return null
        for (i in 0 until assets.length()) {
            val asset = assets.optJSONObject(i) ?: continue
            val name = asset.optString("name", "").trim()
            if (!name.endsWith(".apk", ignoreCase = true)) continue
            val url = asset.optString("browser_download_url", "").trim()
            if (!url.startsWith("https://", ignoreCase = true)) continue
            return name to url
        }
        return null
    }

    /** 非 2xx → 可读错误；403 区分「限流」与普通拒绝。 */
    private fun httpFailure(
        httpCode: Int,
        body: String,
        rateLimitRemaining: String?
    ): GithubReleaseException {
        val rateLimited = httpCode == 403 && (
            rateLimitRemaining?.trim() == "0" ||
                body.contains("rate limit", ignoreCase = true)
            )
        val (code, message) = when {
            rateLimited -> "rate_limit" to "GitHub 接口限流（HTTP 403），请稍后再试"
            httpCode == 403 -> "forbidden" to "GitHub 拒绝访问（HTTP 403），请稍后再试"
            httpCode == 404 ->
                "not_found" to "GitHub Releases 仓库不存在（HTTP 404），可能已改名或删除"

            httpCode == 429 -> "rate_limit" to "GitHub 请求过于频繁（HTTP 429），请稍后再试"
            httpCode in 500..599 ->
                "server" to "GitHub 服务异常（HTTP $httpCode），请稍后再试"

            else -> "http" to "GitHub 返回异常状态（HTTP $httpCode）"
        }
        return GithubReleaseException(code, message)
    }
}

/* ───────────────────────── 语义版本（tag 解析 / 排序） ───────────────────────── */

/**
 * 语义版本：数字核心 + 可选预发布段。
 *
 * 只实现排序需要的部分（不校验前导零等严格规则）；预发布版本按 semver 规则
 * 排在正式版之前，例如 `1.0.10-beta < 1.0.10`。
 */
internal data class SemanticVersion(
    val core: List<Int>,
    val preRelease: List<String>
)

/**
 * 去掉发版前缀：`app-v1.0.10` / `android-v1.0.10` / `v1.0.10` → `1.0.10`。
 *
 * 只有「前缀后面紧跟数字」才剥离，避免把 `version1.0` 这类 tag 误伤。
 */
internal fun normalizeReleaseTag(tag: String): String {
    var text = tag.trim()
    for (prefix in listOf("app-v", "android-v", "app-", "android-", "v")) {
        if (!text.startsWith(prefix, ignoreCase = true)) continue
        val rest = text.substring(prefix.length)
        if (rest.isNotEmpty() && rest.first().isDigit()) {
            text = rest
            break
        }
    }
    return text
}

/** 解析语义版本；核心段必须全是数字，格式不合法时返回 `null`。 */
internal fun parseSemVer(value: String): SemanticVersion? {
    val text = normalizeReleaseTag(value)
    if (text.isEmpty()) return null

    val withoutBuild = text.substringBefore('+')
    val main = withoutBuild.substringBefore('-')
    val preText = withoutBuild.substringAfter('-', "")
    if (preText.isNotEmpty() && preText.split('.').any { it.isEmpty() }) return null

    val core = main.split('.').map { part ->
        if (part.isEmpty() || !part.all { it.isDigit() }) return null
        part.toIntOrNull() ?: return null
    }
    if (core.isEmpty()) return null
    if (core.size > 4) return null

    val pre = if (preText.isEmpty()) emptyList() else preText.split('.')
    return SemanticVersion(core = core, preRelease = pre)
}

/** 比较两个版本号：`>0` 表示 [a] 更新，`<0` 更旧，`0` 相同。 */
internal fun compareSemVer(a: SemanticVersion, b: SemanticVersion): Int {
    val size = maxOf(a.core.size, b.core.size)
    for (i in 0 until size) {
        val left = a.core.getOrElse(i) { 0 }
        val right = b.core.getOrElse(i) { 0 }
        if (left != right) return left.compareTo(right)
    }
    return comparePreRelease(a.preRelease, b.preRelease)
}

/** semver：正式版 > 预发布版；预发布标识按数字 / 字典序逐段比较。 */
private fun comparePreRelease(a: List<String>, b: List<String>): Int {
    if (a.isEmpty() && b.isEmpty()) return 0
    if (a.isEmpty()) return 1
    if (b.isEmpty()) return -1

    val size = minOf(a.size, b.size)
    for (i in 0 until size) {
        val left = a[i]
        val right = b[i]
        val leftNumber = left.toIntOrNull()
        val rightNumber = right.toIntOrNull()
        val cmp = when {
            leftNumber != null && rightNumber != null -> leftNumber.compareTo(rightNumber)
            leftNumber != null -> -1
            rightNumber != null -> 1
            else -> left.compareTo(right)
        }
        if (cmp != 0) return cmp
    }
    return a.size.compareTo(b.size)
}

/** 字符串版本比较；任一侧不可解析时按「更旧」处理（会被排序丢弃前过滤）。 */
internal fun compareSemanticVersions(a: String, b: String): Int {
    val left = parseSemVer(a) ?: return -1
    val right = parseSemVer(b) ?: return 1
    return compareSemVer(left, right)
}

/**
 * 按项目规则从 versionName 推导 versionCode：`major*10000 + minor*100 + patch`。
 *
 * minor / patch 必须 < 100（否则位段会串），不符合规则时返回 `null`，
 * 由界面隐藏 versionCode，绝不猜一个错误值。
 */
fun versionCodeFor(versionName: String): Int? {
    val version = parseSemVer(versionName) ?: return null
    /* versionCode 规则固定三段；`1.0` 这类 tag 无法无歧义推导，留空而不是猜。 */
    if (version.core.size < 3) return null
    val major = version.core[0]
    val minor = version.core[1]
    val patch = version.core[2]
    if (minor !in 0..99 || patch !in 0..99) return null
    val code = major.toLong() * 10_000L + minor * 100L + patch
    if (code !in 1..Int.MAX_VALUE.toLong()) return null
    return code.toInt()
}
