package io.prism.router.data.repository

import io.prism.router.data.AppHistory
import io.prism.router.data.ControlClient
import io.prism.router.data.ControlException
import io.prism.router.data.DailyUsage
import io.prism.router.data.PanelClient
import io.prism.router.data.PanelException
import io.prism.router.data.PanelState
import io.prism.router.data.SubNode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException

/* ───────────────────────── 统一错误模型 ───────────────────────── */

/**
 * 数据层向 UI 暴露的唯一错误类型。
 *
 * 每个子类固定一个 [code]（与后端 / 本地分类一一对应）和一段可直接展示的中文
 * [message]；UI 只依赖本类型，不再感知 OkHttp / org.json / 后端错误码。
 *
 * - [Unauthorized]：缺少或无效的访问令牌
 * - [Network]：连接失败、DNS / 连接被拒
 * - [Timeout]：连接 / 读取超时
 * - [Server]：面板 5xx
 * - [BadResponse]：响应无法解析或业务参数非法
 * - [WriteDisabled]：面板未开启家长控制
 * - [Forbidden]：令牌无写权限
 * - [ProtectedTarget]：设备受保护，禁止暂停
 */
sealed class AppError(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** 稳定错误码（日志 / 埋点用，不直接展示）。 */
    abstract val code: String

    class Unauthorized(cause: Throwable? = null) :
        AppError("需要访问令牌，请在设置里填写", cause) {
        override val code: String = "unauthorized"
    }

    class Network(cause: Throwable? = null) :
        AppError("网络连接失败，请检查路由器和网络", cause) {
        override val code: String = "network"
    }

    class Timeout(cause: Throwable? = null) :
        AppError("连接超时，请检查面板地址和网络", cause) {
        override val code: String = "timeout"
    }

    class Server(cause: Throwable? = null) :
        AppError("面板服务异常，请稍后重试", cause) {
        override val code: String = "server"
    }

    class BadResponse(
        cause: Throwable? = null,
        message: String = "面板返回的数据无法解析"
    ) : AppError(message, cause) {
        override val code: String = "badResponse"
    }

    class WriteDisabled(cause: Throwable? = null) :
        AppError("路由器未开启家长控制（write_enabled=0）", cause) {
        override val code: String = "writeDisabled"
    }

    class Forbidden(cause: Throwable? = null) :
        AppError("访问令牌无效", cause) {
        override val code: String = "forbidden"
    }

    class ProtectedTarget(cause: Throwable? = null) :
        AppError("该设备受保护，不能暂停", cause) {
        override val code: String = "protectedTarget"
    }

    companion object {
        /** 任意异常 → [AppError]；已是 [AppError] 时原样返回（保留类型与文案）。 */
        fun fromThrowable(error: Throwable): AppError = when (error) {
            is AppError -> error
            is PanelException -> fromPanel(error)
            is ControlException -> fromControl(error)
            is SocketTimeoutException -> Timeout(error)
            is IOException -> Network(error)
            else -> BadResponse(error)
        }

        /** 只读面板错误码 → 统一错误。 */
        fun fromPanel(error: PanelException): AppError {
            return when (error.code.trim().lowercase()) {
                "unauthorized" -> Unauthorized(error)
                "forbidden" -> Forbidden(error)
                "timeout" -> Timeout(error)
                "network" -> Network(error)
                "server" -> Server(error)
                "badresponse", "bad_response" -> BadResponse(error)
                else -> fromMessage(error.message, error)
            }
        }

        /** 家长控制错误码 → 统一错误；未知码保留服务端的中文说明。 */
        fun fromControl(error: ControlException): AppError {
            val message = error.message
            return when (error.code.trim().lowercase()) {
                "write_disabled" -> WriteDisabled(error)
                "forbidden" -> Forbidden(error)
                "protected_target" -> ProtectedTarget(error)
                "timeout" -> Timeout(error)
                "network" -> Network(error)
                "server" -> Server(error)
                "bad_response", "badresponse" -> BadResponse(error, message)
                "no_base_url" -> BadResponse(error, "请先在设置里填写面板地址")
                else -> when {
                    message.contains("家长控制") -> WriteDisabled(error)
                    message.contains("受保护") -> ProtectedTarget(error)
                    message.contains("令牌") -> Forbidden(error)
                    else -> BadResponse(error, message)
                }
            }
        }

        /**
         * 旧客户端只带 message 时的兜底分类（例如历史异常、手工抛出的
         * [PanelException]）。顺序从具体到宽泛，避免把业务文案误判为网络错误。
         */
        private fun fromMessage(message: String?, cause: Throwable): AppError {
            val text = message.orEmpty().trim()
            return when {
                text.contains("令牌") || text.contains("unauthorized", true) ->
                    Unauthorized(cause)
                text.contains("超时") -> Timeout(cause)
                text.contains("HTTP 5") || text.contains("服务异常") -> Server(cause)
                text.contains("连接失败") || text.contains("网络") -> Network(cause)
                else -> BadResponse(cause, text.ifBlank { "面板返回的数据无法解析" })
            }
        }
    }
}

/* ───────────────────────── 仓库 ───────────────────────── */

/**
 * 面板数据仓库：只读面板 API（[PanelClient]）与家长控制写 API（[ControlClient]）的
 * 唯一入口。
 *
 * - 所有网络方法都是 suspend，内部切到 [Dispatchers.IO]，调用方（ViewModel）无需关心线程；
 * - 所有失败统一映射为 [AppError]，UI 直接用 `error.message` 展示中文文案；
 * - 不依赖任何 Compose / Android UI 类型，可在 JVM 单测中构造（注入假 client 即可）。
 */
class PanelRepository(
    private val panelClient: PanelClient = PanelClient(),
    private val controlClient: ControlClient = ControlClient()
) {

    /** 当前快照（`?what=state`）；也用于读取离线缓存前重新解析。 */
    suspend fun state(baseUrl: String, token: String): PanelState =
        request { panelClient.fetchState(baseUrl, token) }

    /** 近 [days] 天每日流量（升序）。 */
    suspend fun history(baseUrl: String, token: String, days: Int = 7): List<DailyUsage> =
        request { panelClient.fetchHistory(baseUrl, token, days) }

    /** 子节点 / AP 快照（`?what=nodes`）。 */
    suspend fun nodes(baseUrl: String, token: String): List<SubNode> =
        request { panelClient.fetchNodes(baseUrl, token) }

    /** 近 [days] 天应用（域名）汇总（`?what=apps_history`）。 */
    suspend fun appsHistory(baseUrl: String, token: String, days: Int = 7): List<AppHistory> =
        request { panelClient.fetchAppsHistory(baseUrl, token, days) }

    /** 面板状态投影（`?what=status`），供设置页「诊断」使用。 */
    suspend fun status(baseUrl: String, token: String): JSONObject =
        request { panelClient.fetchStatus(baseUrl, token) }

    /** 连接测试：成功时返回可直接展示的中文结果；失败抛 [AppError]。 */
    suspend fun testConnection(baseUrl: String, token: String): String =
        request { panelClient.testConnection(baseUrl, token) }

    /* ───────────────────────── 家长控制（写） ───────────────────────── */

    suspend fun pause(baseUrl: String, token: String, mac: String) {
        request { controlClient.pause(baseUrl, token, mac) }
    }

    suspend fun resume(baseUrl: String, token: String, mac: String) {
        request { controlClient.resume(baseUrl, token, mac) }
    }

    suspend fun list(baseUrl: String, token: String): Set<String> =
        request { controlClient.list(baseUrl, token) }

    /* ───────────────────────── 本地解析 ───────────────────────── */

    /** 解析离线缓存里的 state JSON（与网络响应同结构，不发请求）。 */
    fun parseCachedState(body: String): PanelState = panelClient.parseState(body)

    /**
     * 统一执行网络调用：
     * - 协程取消直接透传，绝不包装成业务错误；
     * - 已知异常转换成 [AppError]；
     * - 未知异常兜底为 [AppError.BadResponse]。
     */
    private suspend fun <T> request(block: () -> T): T = withContext(Dispatchers.IO) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AppError) {
            throw e
        } catch (e: PanelException) {
            throw AppError.fromPanel(e)
        } catch (e: ControlException) {
            throw AppError.fromControl(e)
        } catch (e: SocketTimeoutException) {
            throw AppError.Timeout(e)
        } catch (e: IOException) {
            throw AppError.Network(e)
        } catch (e: Exception) {
            throw AppError.BadResponse(e)
        }
    }
}
