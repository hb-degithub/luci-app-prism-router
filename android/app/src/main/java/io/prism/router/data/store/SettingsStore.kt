package io.prism.router.data.store

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.prism.router.data.DEFAULT_BASE_URL
import io.prism.router.data.MAX_SERVERS
import io.prism.router.data.ServerProfile
import io.prism.router.data.normalizeServerUrl
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/* ───────────────────────── 常量 ───────────────────────── */

internal const val DEFAULT_INTERVAL_SEC = 15
internal const val INTERVAL_MIN_SEC = 5
internal const val INTERVAL_MAX_SEC = 300

/** 无任何配置时使用的默认地址（与老版本 init 的兜底一致）。 */
val DEFAULT_SERVER = ServerProfile("主路由", DEFAULT_BASE_URL)

/** 设置存储的 DataStore 文件名（与旧的 SharedPreferences `prism-router` 区分）。 */
private const val DATASTORE_NAME = "prism_settings"

/** 旧版配置来源：只读一次用于迁移，之后所有配置都以 DataStore 为准。 */
private const val LEGACY_PREFS = "prism-router"

/** DataStore 的键名（需求约定的 6 个键 + 迁移标记）。 */
private object Keys {
    val SERVERS = stringPreferencesKey("servers")
    val ACTIVE_SERVER = intPreferencesKey("activeServer")
    val THEME = stringPreferencesKey("theme")
    val DYNAMIC_COLOR = booleanPreferencesKey("dynamicColor")
    val NOTIFY_ENABLED = booleanPreferencesKey("notifyEnabled")
    val INTERVAL_SEC = intPreferencesKey("intervalSec")
    val MIGRATED = booleanPreferencesKey("migrated")
}

/* 旧 SharedPreferences 的键名（只用于首次迁移）。 */
private const val LEGACY_BASE_URL = "baseUrl"
private const val LEGACY_TOKEN = "token"
private const val LEGACY_SERVERS = "servers"
private const val LEGACY_ACTIVE = "activeServer"
private const val LEGACY_INTERVAL = "interval"

/** 主题模式：`system` 跟随系统 / `light` 浅色 / `dark` 深色。 */
enum class AppTheme(val wireValue: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark");

    companion object {
        /** 未知 / 空值一律退回跟随系统，保证坏配置不崩。 */
        fun from(value: String?): AppTheme =
            entries.firstOrNull { it.wireValue.equals(value?.trim(), ignoreCase = true) }
                ?: SYSTEM
    }
}

/** 设置页需要持久化的全部配置；列表与下标保证至少有一条地址。 */
data class AppSettings(
    val servers: List<ServerProfile> = listOf(DEFAULT_SERVER),
    val activeIndex: Int = 0,
    val theme: AppTheme = AppTheme.SYSTEM,
    val dynamicColor: Boolean = false,
    val notifyEnabled: Boolean = true,
    val intervalSec: Int = DEFAULT_INTERVAL_SEC
)

/*
 * 单例 DataStore：`preferencesDataStore` 委托按 Context 缓存实例，多个 SettingsStore
 * 共享同一个文件；损坏时整体退回空配置，由迁移 / 默认值重建，避免启动崩溃。
 */
private val Context.prismSettingsDataStore: DataStore<Preferences> by preferencesDataStore(
    name = DATASTORE_NAME,
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() }
)

/**
 * 设置存储（DataStore Preferences）。
 *
 * 职责：
 * - 以 [settings] Flow 暴露配置（`servers` / `activeServer` / `theme` / `dynamicColor` /
 *   `notifyEnabled` / `intervalSec`）；
 * - 写操作全部是 suspend，由调用方在自己的协程里执行；
 * - 首次启动把旧 SharedPreferences `prism-router` 的 `baseUrl` / `token` / `servers`
 *   迁移一次，随后写入 `migrated=true`，之后的读写都只走 DataStore。
 *
 * 不持有 UI / 网络依赖，可被 DI 容器直接创建。
 */
class SettingsStore(context: Context) {
    private val appContext: Context = context.applicationContext
    private val dataStore: DataStore<Preferences> = appContext.prismSettingsDataStore
    private val legacyPrefs: SharedPreferences =
        appContext.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)

    /** 迁移只做一次：内存标记避免每次读设置都进 DataStore 事务。 */
    @Volatile
    private var migrated: Boolean = false

    /**
     * 配置流：首次收集时先完成迁移，再持续发数据。
     *
     * 读取失败（如磁盘 IO 异常）时发空配置而不是抛异常，UI 用默认值继续可用；
     * 真正的损坏文件已由 [ReplaceFileCorruptionHandler] 兜底。
     */
    val settings: Flow<AppSettings> = flow {
        ensureMigrated()
        emitAll(
            dataStore.data
                .catch { error ->
                    if (error is IOException) {
                        emit(emptyPreferences())
                    } else {
                        throw error
                    }
                }
                .map { it.toSettings() }
        )
    }

    /** 一次性读取当前配置（内部先完成迁移）。 */
    suspend fun snapshot(): AppSettings = settings.first()

    /** DataStore 不可用时的最后兜底：默认地址 + 默认设置，保证应用仍可打开。 */
    fun fallbackSettings(): AppSettings = AppSettings()

    /**
     * 首次迁移：旧 SharedPreferences 的 `servers` 优先；没有列表时把
     * `baseUrl` + `token` 合成一条；两者都没有则写默认地址。迁移后写 `migrated=true`。
     *
     * 使用 DataStore 的原子 edit：并发调用由 DataStore 串行化，标记只会写一次。
     */
    suspend fun ensureMigrated() {
        if (migrated) return
        dataStore.edit { prefs ->
            if (prefs[Keys.MIGRATED] == true) {
                return@edit
            }
            val legacyBase = normalizeServerUrl(legacyString(LEGACY_BASE_URL, "") ?: "")
            val legacyToken = legacyString(LEGACY_TOKEN, "") ?: ""
            val legacyServers = parseServers(legacyString(LEGACY_SERVERS, null))
            val servers = when {
                legacyServers.isNotEmpty() -> legacyServers
                legacyBase.isNotEmpty() -> listOf(ServerProfile("主路由", legacyBase, legacyToken))
                else -> listOf(DEFAULT_SERVER)
            }
            val active = resolveLegacyActive(servers, legacyBase)

            /* 只在键缺失时写入，避免覆盖已经由新版本写过的配置。 */
            if (prefs[Keys.SERVERS] == null) prefs[Keys.SERVERS] = encodeServers(servers)
            if (prefs[Keys.ACTIVE_SERVER] == null) prefs[Keys.ACTIVE_SERVER] = active
            if (prefs[Keys.INTERVAL_SEC] == null) {
                val legacyInterval = runCatching {
                    legacyPrefs.getInt(LEGACY_INTERVAL, DEFAULT_INTERVAL_SEC)
                }.getOrDefault(DEFAULT_INTERVAL_SEC)
                prefs[Keys.INTERVAL_SEC] = legacyInterval.coerceIn(INTERVAL_MIN_SEC, INTERVAL_MAX_SEC)
            }
            if (prefs[Keys.THEME] == null) prefs[Keys.THEME] = AppTheme.SYSTEM.wireValue
            if (prefs[Keys.DYNAMIC_COLOR] == null) prefs[Keys.DYNAMIC_COLOR] = false
            if (prefs[Keys.NOTIFY_ENABLED] == null) prefs[Keys.NOTIFY_ENABLED] = true
            prefs[Keys.MIGRATED] = true
        }
        migrated = true
    }

    /* ───────────────────────── 写操作（suspend） ───────────────────────── */

    /**
     * 保存连接配置（地址列表 + 当前下标 + 轮询间隔）。
     *
     * 空列表会写回默认地址；下标与间隔按约定收敛，保证读出的配置始终可用。
     */
    suspend fun saveConnection(
        servers: List<ServerProfile>,
        activeIndex: Int,
        intervalSec: Int
    ) {
        ensureMigrated()
        val clean = sanitizeServers(servers).ifEmpty { listOf(DEFAULT_SERVER) }
        val index = activeIndex.coerceIn(0, clean.lastIndex)
        val interval = intervalSec.coerceIn(INTERVAL_MIN_SEC, INTERVAL_MAX_SEC)
        dataStore.edit { prefs ->
            prefs[Keys.SERVERS] = encodeServers(clean)
            prefs[Keys.ACTIVE_SERVER] = index
            prefs[Keys.INTERVAL_SEC] = interval
        }
    }

    /** 只切换当前地址；下标越界时收敛到最近一条。 */
    suspend fun setActiveServer(index: Int) {
        ensureMigrated()
        dataStore.edit { prefs ->
            val count = parseServers(prefs[Keys.SERVERS]).size
            val max = if (count <= 0) 0 else count - 1
            prefs[Keys.ACTIVE_SERVER] = index.coerceIn(0, max)
        }
    }

    /** 轮询间隔，收敛到 5–300 秒。 */
    suspend fun setIntervalSec(intervalSec: Int) {
        ensureMigrated()
        dataStore.edit { prefs ->
            prefs[Keys.INTERVAL_SEC] = intervalSec.coerceIn(INTERVAL_MIN_SEC, INTERVAL_MAX_SEC)
        }
    }

    suspend fun setTheme(theme: AppTheme) {
        ensureMigrated()
        dataStore.edit { prefs -> prefs[Keys.THEME] = theme.wireValue }
    }

    suspend fun setDynamicColor(enabled: Boolean) {
        ensureMigrated()
        dataStore.edit { prefs -> prefs[Keys.DYNAMIC_COLOR] = enabled }
    }

    suspend fun setNotifyEnabled(enabled: Boolean) {
        ensureMigrated()
        dataStore.edit { prefs -> prefs[Keys.NOTIFY_ENABLED] = enabled }
    }

    /** 一次性写入全部设置（设置页 / 备份恢复等场景使用）。 */
    suspend fun save(settings: AppSettings) {
        ensureMigrated()
        val clean = sanitizeServers(settings.servers).ifEmpty { listOf(DEFAULT_SERVER) }
        val index = settings.activeIndex.coerceIn(0, clean.lastIndex)
        dataStore.edit { prefs ->
            prefs[Keys.SERVERS] = encodeServers(clean)
            prefs[Keys.ACTIVE_SERVER] = index
            prefs[Keys.THEME] = settings.theme.wireValue
            prefs[Keys.DYNAMIC_COLOR] = settings.dynamicColor
            prefs[Keys.NOTIFY_ENABLED] = settings.notifyEnabled
            prefs[Keys.INTERVAL_SEC] =
                settings.intervalSec.coerceIn(INTERVAL_MIN_SEC, INTERVAL_MAX_SEC)
        }
    }

    /* ───────────────────────── 解析 / 编解码 ───────────────────────── */

    private fun Preferences.toSettings(): AppSettings {
        val servers = parseServers(this[Keys.SERVERS]).ifEmpty { listOf(DEFAULT_SERVER) }
        val active = (this[Keys.ACTIVE_SERVER] ?: 0).coerceIn(0, servers.lastIndex)
        return AppSettings(
            servers = servers,
            activeIndex = active,
            theme = AppTheme.from(this[Keys.THEME]),
            dynamicColor = this[Keys.DYNAMIC_COLOR] ?: false,
            notifyEnabled = this[Keys.NOTIFY_ENABLED] ?: true,
            intervalSec = (this[Keys.INTERVAL_SEC] ?: DEFAULT_INTERVAL_SEC)
                .coerceIn(INTERVAL_MIN_SEC, INTERVAL_MAX_SEC)
        )
    }

    /**
     * 解析 `servers` JSON 数组；损坏、空串、逐条坏数据都按缺失处理。
     *
     * 规则与旧版 SharedPreferences 的读取保持一致：地址归一化、空地址跳过、
     * 重复地址只保留第一条、最多 [MAX_SERVERS] 条。
     */
    private fun parseServers(raw: String?): List<ServerProfile> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val array = JSONArray(raw)
            val out = ArrayList<ServerProfile>(minOf(array.length(), MAX_SERVERS))
            for (i in 0 until array.length()) {
                if (out.size >= MAX_SERVERS) break
                val item = array.optJSONObject(i) ?: continue
                val url = normalizeServerUrl(item.optString("url", ""))
                if (url.isEmpty()) continue
                if (out.any { it.url.equals(url, ignoreCase = true) }) continue
                out.add(
                    ServerProfile(
                        name = item.optString("name", "").trim(),
                        url = url,
                        token = item.optString("token", "")
                    )
                )
            }
            out
        } catch (e: Exception) {
            /* 配置损坏按「还没有地址列表」处理，由调用方走迁移 / 默认值。 */
            emptyList()
        }
    }

    private fun encodeServers(servers: List<ServerProfile>): String {
        val array = JSONArray()
        servers.take(MAX_SERVERS).forEach { server ->
            array.put(
                JSONObject()
                    .put("name", server.name)
                    .put("url", server.url)
                    .put("token", server.token)
            )
        }
        return array.toString()
    }

    private fun sanitizeServers(servers: List<ServerProfile>): List<ServerProfile> {
        val out = ArrayList<ServerProfile>(minOf(servers.size, MAX_SERVERS))
        for (server in servers) {
            if (out.size >= MAX_SERVERS) break
            val url = normalizeServerUrl(server.url)
            if (url.isEmpty()) continue
            if (out.any { it.url.equals(url, ignoreCase = true) }) continue
            out.add(server.copy(name = server.name.trim(), url = url))
        }
        return out
    }

    private fun legacyString(key: String, defaultValue: String?): String? =
        runCatching { legacyPrefs.getString(key, defaultValue) }.getOrNull() ?: defaultValue

    /** 旧下标兼容 Int / Long / 数字字符串；越界时退回与旧 `baseUrl` 相同的一条。 */
    private fun resolveLegacyActive(servers: List<ServerProfile>, legacyBase: String): Int {
        if (servers.isEmpty()) return 0
        val raw: Any? = legacyPrefs.all[LEGACY_ACTIVE]
        val saved = when (raw) {
            is Int -> raw
            is Long -> raw.toInt()
            is String -> raw.trim().toIntOrNull() ?: -1
            else -> -1
        }
        if (saved in servers.indices) return saved
        val matched = servers.indexOfFirst { it.url.equals(legacyBase, ignoreCase = true) }
        return if (matched >= 0) matched else 0
    }
}
