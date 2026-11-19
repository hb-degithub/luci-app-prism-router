package io.prism.router.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * 路由器网络配置接口失败。
 *
 * [code] 是后端 `{"error":"invalid_ip"}` 的原值（`invalid_ip` / `invalid_netmask` /
 * `invalid_gateway` / `invalid_dns` / `invalid_port` / `invalid_hostname` /
 * `invalid_leasetime` / `invalid_pool` / `busy` / `unauthorized` / `internal` …），
 * 或本地分类（`no_base_url` / `network` / `timeout` / `server` / `bad_response`）。
 * [field] 是后端指出的字段名（已归一化为最后一段，如 `ipaddr` / `dest_port`），
 * 没有时为分级错误。错误文案不含令牌与 URL。
 */
class ConfigException(
    val code: String,
    override val message: String,
    val field: String = ""
) : Exception(message)

/**
 * 路由器配置客户端：`<面板地址>/cgi-bin/prism-router-admin`。
 *
 * 契约与后端一致：
 * - `GET ?action=config&token=…` → `{lan,wan,dhcp,system,redirects}`；
 * - `POST {action:"config_set", token, section, options, confirm:"APPLY"}` → `{ok:true,note}`；
 * - `POST {action:"redirect_add", token, name, src, dest, src_dport, dest_ip, dest_port, proto}`
 *   → `{ok:true,index}`；
 * - `POST {action:"redirect_del", token, index}` → `{ok:true}`；
 * - `POST {action:"config_rollback", token, section}` → `{ok:true}`。
 *
 * 安全约束：本类**不打任何日志**；令牌只出现在单次请求里，调用方保持内存持有；
 * 写操作不自动重试（`retryOnConnectionFailure(false)`），避免配置被重复下发。
 */
class ConfigClient {
    companion object {
        private const val PATH = "/cgi-bin/prism-router-admin"

        /* 读配置要跑 ubus / uci，保存要提交并重载网络，给比面板更大的超时。 */
        private const val TIMEOUT_SEC = 20L

        private val JSON = "application/json; charset=utf-8".toMediaType()

        /**
         * 后端错误码 → 前端默认定位的字段名（后端没回 `field` 时使用）。
         * 返回空串表示这是分组级 / 会话级错误，不对应具体输入框。
         */
        fun fieldFor(code: String): String = when (code.trim().lowercase()) {
            "invalid_ip" -> "ipaddr"
            "invalid_netmask", "invalid_mask" -> "netmask"
            "invalid_gateway" -> "gateway"
            "invalid_dns" -> "dns"
            "invalid_port" -> "dest_port"
            "invalid_hostname" -> "hostname"
            "invalid_leasetime" -> "leasetime"
            "invalid_pool", "invalid_dhcp_range" -> "start"
            else -> ""
        }

        /** 错误码 → 中文短句（未知码保留原值，避免把没见过的错误翻错）。 */
        fun messageFor(code: String, httpCode: Int = 0): String =
            when (code.trim().lowercase()) {
                "invalid_ip" -> "IP 地址格式不正确"
                "invalid_netmask", "invalid_mask" -> "子网掩码不正确（要求连续的点分掩码）"
                "invalid_gateway" -> "网关地址格式不正确"
                "invalid_dns" -> "DNS 地址格式不正确"
                "invalid_port" -> "端口不合法（1–65535）"
                "invalid_hostname" -> "主机名不合法（1–63 位字母、数字或 -，首尾不能是 -）"
                "invalid_leasetime" -> "租期格式不正确（例如 12h / 30m / 1d / infinite）"
                "invalid_pool", "invalid_dhcp_range" -> "地址池范围不合法（起始 + 数量不能超过 254）"
                "invalid_proto" -> "协议不受支持（DHCP / 静态 / 无）"
                "invalid_section" -> "未知的配置分组"
                "invalid_index", "not_found" -> "端口转发规则不存在，请刷新后重试"
                "missing_field", "bad_request" -> "缺少必填参数"
                "ip_conflict", "conflict" -> "该地址已被占用"
                "busy" -> "路由器正忙，请稍后重试"
                "confirm_required" -> "需要二次确认（APPLY）"
                "unauthorized" -> "登录已过期，请重新登录"
                "forbidden" -> "没有权限执行该操作"
                "unsupported", "method_not_allowed" -> "路由器不支持该操作，请先升级面板插件"
                "internal" -> "路由器内部错误，请稍后重试"
                "no_base_url" -> "请先在设置里填写面板地址"
                "timeout" -> "连接超时：请确认路由器管理页可访问"
                "network" -> "连接失败：请检查路由器和网络"
                "server" -> "路由器服务异常（HTTP $httpCode）"
                "bad_response" -> "路由器返回了无法解析的数据"
                else -> if (code.isBlank()) {
                    "路由器拒绝了请求（HTTP $httpCode）"
                } else {
                    "配置操作失败（$code）"
                }
            }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
        /* 配置写入非幂等：连接失败不自动重试。 */
        .retryOnConnectionFailure(false)
        .build()

    /* ───────────────────────── 读 ───────────────────────── */

    /** `GET ?action=config&token=…`：LAN / WAN / DHCP / 系统 / 端口转发。 */
    fun fetchConfig(baseUrl: String, token: String): ConfigData {
        val root = get(baseUrl, token)
        return parseConfigObject(root)
    }

    /** 解析配置响应（公开给单测；不访问网络）。缺字段时使用空值，不伪造数据。 */
    fun parseConfig(body: String): ConfigData = parseConfigObject(JSONObject(body))

    /* ───────────────────────── 写 ───────────────────────── */

    /**
     * `POST {action:"config_set", section, options, confirm:"APPLY"}`。
     *
     * [options] 的键与后端契约一致（lan: ipaddr/netmask/gateway/dns；wan: proto/…；
     * dhcp: enabled/start/limit/leasetime；system: hostname/timezone/zonename）。
     * 返回后端给的 `note`（可能为空）。
     */
    fun setSection(
        baseUrl: String,
        token: String,
        section: String,
        options: Map<String, Any?>
    ): String {
        val payload = JSONObject().apply {
            put("action", "config_set")
            put("token", token)
            put("section", section)
            put("options", optionsToJson(options))
            put("confirm", CONFIG_CONFIRM_PHRASE)
        }
        val root = post(baseUrl, payload)
        return root.optString("note", "").trim()
    }

    /**
     * `POST {action:"redirect_add", …}`：新增一条端口转发。
     * 返回后端给的下标；后端没回时返回 -1（界面只用它拼提示文案）。
     */
    fun addRedirect(baseUrl: String, token: String, draft: RedirectDraft): Int {
        val payload = JSONObject().apply {
            put("action", "redirect_add")
            put("token", token)
            put("name", draft.name.trim())
            put("src", draft.src.trim().ifBlank { "lan" })
            put("dest", draft.dest.trim().ifBlank { "lan" })
            put("src_dport", draft.srcDport.trim())
            put("dest_ip", draft.destIp.trim())
            put("dest_port", draft.destPort.trim())
            put("proto", draft.proto.trim().ifBlank { "tcp" })
        }
        val root = post(baseUrl, payload)
        return root.optInt("index", -1)
    }

    /** `POST {action:"redirect_del", token, index}`：按后端下标删除一条规则。 */
    fun deleteRedirect(baseUrl: String, token: String, index: Int) {
        post(
            baseUrl,
            JSONObject().apply {
                put("action", "redirect_del")
                put("token", token)
                put("index", index)
            }
        )
    }

    /** `POST {action:"config_rollback", token, section}`：恢复最近一次备份。 */
    fun rollback(baseUrl: String, token: String, section: String) {
        post(
            baseUrl,
            JSONObject().apply {
                put("action", "config_rollback")
                put("token", token)
                put("section", section)
            }
        )
    }

    /* ───────────────────────── 解析 ───────────────────────── */

    private fun parseConfigObject(root: JSONObject): ConfigData {
        val lan = root.optJSONObject("lan")
        val wan = root.optJSONObject("wan")
        val dhcp = root.optJSONObject("dhcp")
        val system = root.optJSONObject("system")

        val redirects = ArrayList<RedirectRule>()
        val array = root.optJSONArray("redirects")
        if (array != null) {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                redirects.add(
                    RedirectRule(
                        index = item.optInt("index", i),
                        name = item.optString("name", "").trim(),
                        src = item.optString("src", "lan").trim().ifBlank { "lan" },
                        dest = item.optString("dest", "lan").trim().ifBlank { "lan" },
                        srcDport = item.optString("src_dport", "").trim(),
                        destIp = item.optString("dest_ip", "").trim(),
                        destPort = item.optString("dest_port", "").trim(),
                        proto = item.optString("proto", "tcp").trim().ifBlank { "tcp" },
                        enabled = item.optBoolean("enabled", true)
                    )
                )
            }
        }

        /*
         * 各分组缺失（老后端 / 精简响应）时用空值兜底：安全调用 + orEmpty，
         * 界面显示「未读取到」而不是崩溃或伪造数据。
         */
        return ConfigData(
            lan = LanConfig(
                ipaddr = lan?.optString("ipaddr", "").orEmpty().trim(),
                netmask = lan?.optString("netmask", "").orEmpty().trim(),
                gateway = lan?.optString("gateway", "").orEmpty().trim(),
                dns = stringList(lan?.optJSONArray("dns"))
            ),
            wan = WanConfig(
                proto = wan?.optString("proto", WanProto.DHCP.wire).orEmpty().trim()
                    .ifBlank { WanProto.DHCP.wire },
                device = wan?.optString("device", "").orEmpty().trim(),
                ipaddr = wan?.optString("ipaddr", "").orEmpty().trim(),
                netmask = wan?.optString("netmask", "").orEmpty().trim(),
                gateway = wan?.optString("gateway", "").orEmpty().trim(),
                dns = stringList(wan?.optJSONArray("dns"))
            ),
            dhcp = DhcpConfig(
                enabled = dhcp?.optBoolean("enabled", true) ?: true,
                start = dhcp?.optString("start", "").orEmpty().trim(),
                limit = dhcp?.optString("limit", "").orEmpty().trim(),
                leasetime = dhcp?.optString("leasetime", "").orEmpty().trim()
            ),
            system = RouterSystemConfig(
                hostname = system?.optString("hostname", "").orEmpty().trim(),
                timezone = system?.optString("timezone", "").orEmpty().trim(),
                zonename = system?.optString("zonename", "").orEmpty().trim()
            ),
            redirects = redirects
        )
    }

    /** `{"dns":["1.1.1.1"]}` → 列表；数字 / 非数组一律忽略，不猜。 */
    private fun stringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        val out = ArrayList<String>(array.length())
        for (i in 0 until array.length()) {
            val value = array.opt(i)
            if (value is String && value.trim().isNotEmpty()) out.add(value.trim())
        }
        return out
    }

    /** `options` 支持 String / Boolean / Int / Long / List<String>；其余类型直接忽略。 */
    private fun optionsToJson(options: Map<String, Any?>): JSONObject = JSONObject().apply {
        options.forEach { (key, value) ->
            when (value) {
                null -> Unit
                is String -> put(key, value)
                is Boolean -> put(key, value)
                is Int -> put(key, value)
                is Long -> put(key, value)
                is List<*> -> {
                    val array = JSONArray()
                    value.filterNotNull().forEach { element -> array.put(element.toString()) }
                    put(key, array)
                }

                else -> put(key, value.toString())
            }
        }
    }

    /* ───────────────────────── HTTP ───────────────────────── */

    private fun get(baseUrl: String, token: String): JSONObject {
        val base = normalizeBase(baseUrl)
        val url = "$base$PATH?action=config&token=" + URLEncoder.encode(token, "UTF-8")
        val request = Request.Builder()
            .url(url)
            .addHeader("Accept", "application/json")
            .get()
            .build()
        return execute(request)
    }

    private fun post(baseUrl: String, payload: JSONObject): JSONObject {
        val base = normalizeBase(baseUrl)
        val request = Request.Builder()
            .url(base + PATH)
            .addHeader("Accept", "application/json")
            .post(payload.toString().toRequestBody(JSON))
            .build()
        return execute(request)
    }

    private fun normalizeBase(baseUrl: String): String {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw ConfigException("no_base_url", "请先在设置里填写面板地址")
        return base
    }

    /**
     * 执行请求并把 HTTP / 后端错误翻译成 [ConfigException]。
     *
     * 顺序：网络异常 → 429 限速 → JSON 解析 → `error` 字段（优先于 HTTP 状态，
     * 因为后端 4xx 也带 `{"error":…,"field":…}`）→ 5xx / 4xx 兜底。
     * 响应文本不作为错误文案回显（避免把带令牌的 URL 或内部路径带出来）。
     */
    private fun execute(request: Request): JSONObject {
        var httpCode = 0
        val text = try {
            client.newCall(request).execute().use { res ->
                httpCode = res.code
                res.body?.string().orEmpty()
            }
        } catch (e: SocketTimeoutException) {
            throw ConfigException("timeout", messageFor("timeout"))
        } catch (e: InterruptedIOException) {
            throw ConfigException("timeout", messageFor("timeout"))
        } catch (e: IOException) {
            throw ConfigException("network", messageFor("network"))
        } catch (e: Exception) {
            throw ConfigException("bad_response", messageFor("bad_response"))
        }

        if (httpCode == 429) {
            throw ConfigException("rate_limited", "尝试过于频繁，请 1 分钟后再试")
        }

        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            null
        }
        if (json == null) {
            val code = if (httpCode >= 500) "server" else "bad_response"
            throw ConfigException(code, messageFor(code, httpCode))
        }

        val error = json.optString("error", "").trim()
        if (error.isNotEmpty()) {
            val field = json.optString("field", "").trim()
                .substringAfterLast('.')
            throw ConfigException(error, messageFor(error, httpCode), field)
        }
        if (httpCode == 401 || httpCode == 403) {
            throw ConfigException("unauthorized", messageFor("unauthorized"))
        }
        if (httpCode >= 500) throw ConfigException("server", messageFor("server", httpCode))
        if (httpCode >= 400) throw ConfigException("bad_request", messageFor("bad_request", httpCode))
        return json
    }
}
