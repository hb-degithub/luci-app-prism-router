# 飞书（Lark）开放平台推送接口调研 —— 告警 + 日报/周报

> 调研对象：OpenWrt 流量统计插件向飞书推送「定时日报/周报」与「实时告警」。
> 约束：家用/小型办公路由器，**无公网 IP**，仅有出站 HTTPS；工具链为 shell + curl/wget。
> 调研时间：2026-11。只做调研，不含业务代码。

## 证据等级标注

本文对每条结论标注来源强度，请按此判断可信度：

| 标注 | 含义 |
|---|---|
| ✅ | **官方文档原文已核实**（给出文档 URL，可直接引用） |
| 🟢 | **本地实测/计算已验证**（我在本机跑过命令，结论可复现） |
| 🟡 | **由两条及以上官方文档推断**（官方未直白写出该结论） |
| ❓ | **未核实 / 推测 / 社区说法**（不可作为实现依据，上线前必须实测） |

---

## 0. 结论速览（TL;DR）

1. **家用无公网场景，首选「群自定义机器人 Webhook」**。它是纯出站 HTTPS POST，无回调、无需应用审核、无需公网地址；签名校验用 HMAC-SHA256 + Base64，shell 用 `openssl` 即可完成。✅🟢
2. **Webhook 硬限制**：请求体 **≤ 20 KB**；频率 **单租户单机器人 100 次/分钟、5 次/秒**；**不能发图**（拿不到 `image_key`）；只能推送到**它所在的那一个群**。✅🟡
3. **日报要"趋势图"，不要"贴 PNG"**。飞书卡片有**原生 `chart` 组件**（基于 VChart，13 种图）：一个 7 点折线图元素只有 **335 字节**，48 点也只有 **1066 字节**，Webhook 完全放得下。贴 PNG 必须先调「上传图片」拿 `image_key`，而该接口需要 `tenant_access_token`（自建应用），**纯 Webhook 路线做不到**。✅🟡
4. **日报表格用卡片原生 `table` 组件**（最多 5 个表/卡、50 列、每页 1–10 行），或用卡片 2.0 的 markdown 组件跑 **GFM 表格语法**（更省体积但最多展示 5 行数据）。✅
5. **卡片请用 JSON 2.0**（官方当前主线），但注意 **2.0 需要飞书客户端 ≥ 7.20**，低版本只显示标题 + 升级提示；如果担心家里老人手机版本太旧，用 1.0 更稳。✅
6. **发消息是纯出站，不需要任何事件回调**。只有"接收用户消息 / 卡片按钮回调 / 成员变动"这类**入站**事件才需要回调；而且即便要，飞书还提供**长连接（WebSocket）**模式，同样**不需要公网 IP**。✅
7. **绝对不要只看 HTTP 200**。Webhook 在签名错、关键词不匹配、被限流时，往往仍返回 **HTTP 200**，错误藏在 body 的 `code` 字段里（如 `19021`/`19024`/`11232`）。必须解析 body。✅🟢
8. **官方文档没有"每日累计条数"限制**（只有 100 次/分、5 次/秒）。社区流传的"每天 1000 条"我没找到官方出处，按 100 次/分设计即可。❓

---

## 1. 路线一：群自定义机器人 Webhook

### 1.1 Webhook 地址形态

在飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**，添加后得到：

```
https://open.feishu.cn/open-apis/bot/v2/hook/<token>
```

- 国际版（Lark）域名为 `open.larksuite.com`，路径相同。✅
- `<token>` 实测形如 UUID：`f99fed8d-9b01-4dfe-ab56-xxxx`（官方示例），也存在纯随机串形式。✅
- **同一自定义机器人无法添加到其他群聊**（只能在当前群使用）→ 要推多个群，就得建多个机器人 + 多个 webhook。✅

> 官方文档：[自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)

### 1.2 请求格式（各消息类型）

统一为 `POST`，`Content-Type: application/json`，body 顶层是 `msg_type` + 内容字段。✅

**纯文本（告警最省事）**

```json
{"msg_type":"text","content":{"text":"【流量告警】NAS 今日已用 42.1 GB，超过阈值 40 GB"}}
```

**富文本 post**（支持 标题/超链接/at/图片，均可跨段落）

```json
{"msg_type":"post","content":{"post":{"zh_cn":{"title":"流量告警","content":[
  [{"tag":"text","text":"设备 "},{"tag":"text","text":"NAS"},{"tag":"text","text":" 用量超阈值"}],
  [{"tag":"a","text":"查看详情","href":"http://192.168.1.1/"}]
]}}}}
```

官方为 webhook 的 `post` 明确列出的标签只有 **`text` / `a` / `at` / `img`** 四种。✅
（`md`（Markdown）标签在应用消息里存在，但**没有**在 webhook 文档中列出 —— 见 §9 未核实项。）

**卡片 interactive**：`msg_type` 为 `interactive`，内容放在 **`card`** 字段（不是 `content`）。✅

```text
{"msg_type":"interactive","card":{"schema":"2.0","header":{...},"body":{"elements":[...]}}}
                                   ↑ 省略号处是 header/body 的完整对象
```

**图片**：`{"msg_type":"image","content":{"image_key":"img_..."}}` —— 但 `image_key` 从哪来见 §4。✅

**群名片**：`{"msg_type":"share_chat","content":{"share_chat_id":"oc_..."}}`（只能分享机器人所在群）。✅

### 1.3 签名校验（重点，最容易写错）

**算法原文**（官方）：

> 即将 `timestamp + "\n" + 密钥` 当做签名字符串，使用 HmacSHA256 算法计算**空字符串**的签名结果，再进行 Base64 编码。其中 `timestamp` 是指距当前时间不超过 1 小时（3600 秒）的时间戳，时间单位：s。

要点（很多人在这里翻车）：

1. `timestamp\nsecret` 是 **HMAC 的 key**，被签名的**消息体是空字节串**。
   —— 不是"把 secret 当 key 去 HMAC timestamp"，正好相反。✅
2. `timestamp` 单位是**秒**（10 位），不是毫秒。✅
3. 拼接分隔符是**真实的换行符 LF（0x0A）**，不是字符 `\` 加 `n`。✅🟢
4. 结果是 **Base64**（不是十六进制、不是 URL-safe）。✅🟢
5. 签名与时间戳放在请求体**根部**，字段名 `timestamp`、`sign`；官方示例中 `timestamp` 是**字符串**。✅
6. 时间戳容差 **±1 小时**，因此路由器必须校时（NTP），否则报 `19021`。✅

**本地验证的测试向量** 🟢（我用官方 Java 示例的同一组输入 `timestamp=1599360473, secret=demo` 算的）：

| 算法 | 结果 |
|---|---|
| ✅ 正确（timestamp+"\n"+secret 作 key，空消息） | `l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=` |
| ❌ 错误：key/msg 互换 | `T6Mc0zt4awgK8ZK85CxgTTKY7V1xnmigxze+8dg2OyU=` |
| ❌ 错误：漏掉 `\n` | `fov190ZD9zuzAyBJQNqksXtMgOo3GBzAN6LhPSeLw0w=` |

你可以拿这组向量给自己的实现做单元自测。我在本机用 **Python 官方算法** 与 **openssl 两种写法**交叉计算，三者输出完全一致。

### 1.4 频率与体积限制

| 项目 | 限制 | 来源 |
|---|---|---|
| 请求体大小 | **≤ 20 KB** | ✅ 官方明确写"请求体的数据大小不能超过 20 KB"；社区成熟库 shoutrrr 按 **20,480 字节** 判定，并说明该上限覆盖**整个 JSON body**（含 `timestamp`/`sign`、以及 `\"`、`\n` 这类 JSON 转义后的字节） |
| 频率 | **单租户单机器人 100 次/分钟，5 次/秒** | ✅ 官方「频控策略」与「自定义机器人使用指南」两处一致 |
| 整点压力 | 官方建议**避开 10:00、17:30 等整点/半点**，否则可能出现系统压力导致的 `11232` 限流错误 | ✅ |
| 当天累计条数 | **官方文档中未见任何每日条数上限** | ❓（见 §9） |
| 并发/多群 | 一个机器人 = 一个群；多群需多个 webhook，各自独立限流 | ✅🟡 |

> 参考：[频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)、[shoutrrr Lark 文档](https://github.com/nicholas-fedor/shoutrrr/blob/a4ae74216d354cd444846b4cc37d39c23c1d95be/docs/services/chat/lark/index.md)

### 1.5 三种安全设置（可同时启用多个）

| 方式 | 行为 | 失败返回 |
|---|---|---|
| 自定义关键词 | 最多 10 个；消息需**至少含一个**关键词才发送。注意：关键词只对 `text`、`title` 这类文本参数值生效，**不过滤 `href`** | `{"code":19024,"msg":"Key Words Not Found"}` ✅ |
| IP 白名单 | 最多 10 条，支持 `123.12.1.*` 与 `123.1.1.1/24` | `{"code":19022,"msg":"Ip Not Allowed"}` ✅ |
| 签名校验 | 见 §1.3 | `{"code":19021,"msg":"sign match fail or timestamp is not within one hour from current time"}` ✅ |

> **家用场景建议**：一定开**签名校验**；**不要开 IP 白名单**（家庭宽带公网 IP 会变，且 N 多路由器是 CGNAT 共享出口）；关键词可开，但要把关键词放在**卡片标题**里，别赌卡片正文是否被扫描（见 §9）。

---

## 2. 路线二：自建应用（Custom App）

### 2.1 获取 tenant_access_token

官方现在有**新旧两个接口**，新接口是当前推荐版本：

**新（推荐）** ✅

```http
POST https://accounts.feishu.cn/oauth/v3/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=cli_xxx          # app_id
&client_secret=xxx          # app_secret
```

响应：`{"code":0,"access_token":"...","expires_in":7200,"token_type":"Bearer"}`

- 遵循 OAuth 2.0 Client Credentials；也支持 `client_secret_basic`（HTTP Basic）认证，但**两种认证方式不能同时用**，否则报 `20070`。✅
- 有效期最长 **2 小时**，以响应里的 `expires_in` 为准，**不要硬编码**。✅
- 新版权杖是 **JWT 格式，长度显著变长**，官方建议存储/缓存/Header 预留至少 **4 KB**。✅

**旧（已标为历史版本，不推荐）** ✅

```http
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
Content-Type: application/json; charset=utf-8

{"app_id":"cli_xxx","app_secret":"xxx"}
```

响应：`{"code":0,"msg":"ok","tenant_access_token":"t-xxx","expire":7200}`

- 有效期最大 2 小时；**剩余 >30 分钟时返回原来那个 token，<30 分钟时返回新 token**（会有两个有效 token 并存）。✅
- 官方在该页明确标注"本接口已成为历史版本，不推荐使用"。✅

> 参考：[自建应用获取 tenant_access_token（新版）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)、[旧版](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)

### 2.2 发消息接口

```http
POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id
Authorization: Bearer t-xxx
Content-Type: application/json; charset=utf-8

{
  "receive_id": "oc_xxx",
  "msg_type": "interactive",
  "content": "{\"schema\":\"2.0\",...}",   // 注意：content 是「JSON 序列化后的字符串」
  "uuid": "可选，1 小时内相同 uuid 至多成功发送一条"
}
```

- `receive_id_type` 可选：`open_id` / `union_id` / `user_id` / `email` / `chat_id`。✅
- **`content` 是字符串**，里面的 JSON 必须再序列化一次并转义 —— 这是与 Webhook（`card` 是嵌套对象）最大的写法差异，也是移植时最容易踩的坑。✅
- `msg_type` 支持：text / post / image / file / audio / media / sticker / interactive / share_chat / share_user / system。✅
- **体积限制**：文本 ≤ **150 KB**；卡片、富文本 ≤ **30 KB**（比 webhook 的 20 KB 宽松）；用模板发送时模板本身也计入。✅

**发消息所需权限**（三者**任一**即可，推荐最小权限的那个）：

| 权限 | 说明 |
|---|---|
| `im:message:send_as_bot` | **以应用的身份发消息**（推荐，权限最小） |
| `im:message` | 获取与发送单聊、群组消息 |
| `im:message:send` | 发送消息 V2（历史版本） |

给部门/多人群发（`POST /open-apis/message/v4/batch_send/`）额外需要：
`im:message:send_multi_users`（给多个用户）、`im:message:send_multi_depts`（给一个或多个部门的成员）。✅

用 `receive_id_type=user_id` 时另需字段权限 `contact:user.employee_id:readonly`。✅

**调用前提**（都是硬条件，缺一个就报错）：

1. 应用需**开启机器人能力**并**发版生效**。✅
2. 给用户发消息时，该用户必须在应用的**可用范围**内。✅
3. 给群发消息时，机器人必须在群里且**有发言权限**。✅
4. **群自定义机器人无法调用该接口**（该接口只给应用机器人用）。✅

### 2.3 是否需要事件回调？—— 不需要

这是本次调研最关键的确认项：

- **「发消息」是纯出站请求**，用 `tenant_access_token` 直接 POST 即可，**与事件订阅完全无关**。✅
- 事件订阅（`im.message.receive_v1` 接收消息、卡片按钮回调、机器人被移出群等）才是**入站**，才需要回调地址。✅
- 而且即便是入站，飞书还提供**长连接（WebSocket）**模式，官方原文：*"只需保证运行环境具备访问公网的能力即可，**无需提供公网 IP 或域名、无需使用内网穿透工具**"*。✅
  - 代价：仅支持**企业自建应用**；需要通过官方 SDK（Go/Python/Java/Node）接入；收到事件需 **3 秒内**处理完；每应用最多 **50 个连接**；**集群模式、不广播**（多客户端只有一个随机收到）。✅
  - 对 OpenWrt 的现实意义：路由器上通常没有 Go/Python 运行时，长连接不实用；但我们**不需要**它。

> 参考：[使用长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case)、[服务端 SDK 概述](https://open.feishu.cn/document/server-docs/server-side-sdk)

### 2.4 两条路线的取舍

| 维度 | 群自定义机器人 Webhook | 自建应用（app_id/secret） |
|---|---|---|
| 接入成本 | **极低**：群里点两下拿 URL | 需建应用、开机器人能力、申请权限、**管理员审核发版** |
| 公网要求 | **无** | **无**（发消息纯出站） |
| 鉴权 | 可选 签名/关键词/IP（`secret`） | `app_secret` → `tenant_access_token`（2h，需自己刷新） |
| 目标 | **只能是它所在的那 1 个群** | 任意群（机器人需在群内）、指定用户（需在可用范围）、部门批量 |
| 消息类型 | text / post / image / share_chat / interactive | 全部（含 file/audio/media/sticker/system） |
| 体积上限 | **20 KB** | 文本 150 KB / 卡片 30 KB |
| 频率 | 100 次/分、5 次/秒（单机器人） | 同用户 5 QPS、同群 5 QPS（群内机器人共享）；接口 1000 次/分 & 50 次/秒 |
| 发图 | **不行**（无 `image_key` 来源） | 行（`/open-apis/im/v1/images`） |
| 收消息/交互回调 | **不行**（官方明确不能响应 @ 消息） | 行（需回调或长连接） |
| 能否撤回自己发的消息 | **不能**（只能群主/管理员撤） | 行（`DELETE /im/v1/messages/:id`，需权限） |
| 消息卡片模板 | 支持，但模板需显式**授权给该机器人** | 支持 |
| 适合我们的场景 | **日报/周报 + 群内告警** ✅ | 需要私聊某人 / 需要贴 PNG / 需要多群分发 |

**建议**：先用 Webhook 把日报 + 告警跑通；把"图片上传"和"私聊"作为可选增强，等有人真的需要了再上自建应用。两者的卡片 JSON 结构基本一致，迁移成本主要在 `content` 要二次序列化。

---

## 3. 消息卡片 interactive

### 3.1 JSON 2.0 vs 1.0（官方当前推荐 2.0）

| 维度 | JSON 1.0 | JSON 2.0 |
|---|---|---|
| 声明方式 | 不写 `schema` 或 `"schema":"1.0"` | **必须显式** `"schema":"2.0"` |
| 正文结构 | 根级 `elements: []` | 新增 `body`，改到 **`body.elements`** |
| 多语言 | `i18n_elements` 全局多语言 | **不再支持** `i18n_elements`，改用组件级 `i18n_content` |
| 降级 | 支持 `fallback` 字段 | **暂不支持** `fallback` 自定义降级 |
| 未知属性 | 忽略 | **直接报错**（更严格） |
| `update_multi` | 默认 `false`，可设 false | 默认 `true`，且**暂时只允许 true**（即只支持共享卡片） |
| 可交互 / 可更新期 | 交互 30 天 / 更新 14 天 | **统一 14 天** |
| 客户端要求 | 低版本兼容好 | **飞书 ≥ 7.20**，低版本只显示标题 + 升级提示 |
| 元素数量 | — | 一张卡片**最多 200 个元素/组件** |
| 布局能力 | 较弱 | 新增 `direction`/`padding`/`horizontal_spacing`/`vertical_align`、`width_mode`（`compact`/`fill`）等 |

> 参考：[卡片 JSON 2.0 结构](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)、[2.0 版本更新说明](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-breaking-changes-release-notes)

**官方推荐**：官网文档主线、卡片搭建工具的新版卡片导出的都是 2.0；2.0 独有原生图表、GFM 表格、更细布局。**结论：新项目用 2.0**，但要接受"客户端 ≥ 7.20"这个前提（2026 年这个版本已经很老了，实际风险低）。

### 3.2 表格：有原生组件，也能用 Markdown 表格

**A. 原生 `table` 组件**（推荐用于 Top N 榜）✅

- `tag: "table"`，**必须放在卡片根节点**，不可嵌套在其他组件内，也不支持内嵌其他组件。
- 单卡**最多 5 个**表格组件（配多语言时每个语言各 5 个）。
- 列：`columns`，**最多 50 列**，超出不展示；`name` 是数据 key，`display_name` 是表头。
- 行：`rows`，数组，元素是用 `name: value` 组成的对象。
- 分页：**`page_size` 支持 [1,10]，默认 5** ← 注意默认只显示 5 行，要多显示必须显式设到 10。
- 列宽：`auto` / `[80px,600px]` / `[1%,100%]`。
- `data_type`：`text` / `lark_md`(v7.10+) / `options`(彩色标签) / `number`(可带 `format.symbol`/`precision`/`separator`) / `persons` / `date`(毫秒时间戳) / `markdown`(v7.14+)。
- 其它：`row_height`(`low`/`medium`/`high`/`auto`)、`row_max_height`、`freeze_first_column`、`header_style`。
- 单元格内容超宽会被**省略号截断**，悬浮/点击可看全文。

**B. Markdown 组件的 GFM 表格**（更省体积，但展示受限）✅

- 卡片 2.0 的 `markdown` 组件支持标准 Markdown（除 `HTMLBlock`）。
- 表格语法：`| a | b |` + 分隔行；**除标题行外最多展示 5 行数据，超出分页展示，不支持自定义**；**单个富文本组件内最多 4 个表格**；**不支持设置列宽**、列对齐等。
- 结论：Top 5 榜这种正好；要 10 行分页或用彩色标签/数字格式，就用原生 `table`。

### 3.3 图表：有原生 `chart` 组件，不必贴图

`tag: "chart"`，基于 **[VChart](https://www.visactor.io/)** 的 spec。✅

| 属性 | 说明 |
|---|---|
| `chart_spec` | **必填**，VChart spec 结构体（`type`/`data.values`/`xField`/`yField`/`title`…） |
| `aspect_ratio` | `1:1` / `2:1` / `4:3` / `16:9`（默认 PC 16:9、移动端 1:1） |
| `color_theme` | `brand`(默认) / `rainbow` / `complementary` / `converse` / `primary`；若 `chart_spec` 里已声明样式则此项失效 |
| `height` | `auto`（默认，按宽高比算）或 `[1,999]px` |
| `preview` | 默认 `true`，PC 端可独立窗口查看、移动端可全屏 |

限制与注意事项：✅

- 支持折线、面积、柱状、条形、饼图、词云、环形/条形进度等 **13 种**。
- **单卡建议最多 5 个图表**。
- **不支持 JavaScript 语法**（不能写函数/lambda）。
- 客户端版本决定 VChart 能力：7.1–7.6 → 1.2.2；7.7–7.9 → 1.6.6；7.10–7.15 → 1.8.3；7.16–7.26 → 1.10.1；**7.27+ → 1.12.3**。用新语法前先确认目标客户端版本。
- 移动端不支持：纹理 `bar.style.texture`、圆锥渐变、`grid` 布局词云、`extensionMark` 图片的 `repeatX/repeatY`、`bar.style.background` 的 svg。写了会**加载失败**。
- 平台默认会往 `chart_spec` 追加媒体查询做自适应；想自己控制就设 `"media": []`。
- `chart_spec` 配错会报 `230099` + 子错误码 `200550`（`ErrPath` 会告诉你第几个元素坏了）。

最小可用折线图元素：

```json
{"tag":"chart","aspect_ratio":"16:9","color_theme":"brand",
 "chart_spec":{"type":"line","title":{"text":"近 7 日用量 (GB)"},
   "data":{"values":[{"d":"11-09","v":17.2},{"d":"11-10","v":19.4}]},
   "xField":"d","yField":"v"}}
```

### 3.4 图片：只能 `img_key`

- `img` 组件：`{"tag":"img","img_key":"img_v3_...","scale_type":"crop_center"}`。✅
- markdown 里：`![hover_text](img_key)` —— **参数就是 image_key 本身**。✅
- **不支持外链 URL**（文档中图片一律要求 `image_key`，来自上传接口）。✅🟡
- 建议尺寸 1500×3000 px 内、≤10 MB、高宽比 ≤16:9。✅

### 3.5 卡片模板（template）vs 自定义卡片 JSON

| | 卡片模板（template_id） | 自定义卡片 JSON |
|---|---|---|
| 搭建方式 | 飞书卡片搭建工具（可视化、变量、多语言） | 代码里拼 JSON |
| Webhook 请求体 | `{"msg_type":"interactive","card":{"type":"template","data":{"template_id":"AAq...","template_version_name":"1.0.0","template_variable":{"k":"v"}}}}` | `{"msg_type":"interactive","card":{...}}` |
| 变量 | 支持（`template_variable`，类型需与模板定义一致，否则 `200732`） | **不支持变量**（官方明确：直接传 JSON 源代码的方式不支持卡片变量） |
| 授权 | 必须在搭建工具里把该**机器人/应用**加为使用者，否则 `200381` / `11310`("template is not visible to app") | 无 |
| 版本 | 可用 `template_version_name` 锁版本（不填=最新版，**发布即影响线上**） | 代码即版本 |
| 适合我们 | 不推荐（多一个后台依赖、要维护授权关系） | **推荐**（路由器本地拼 JSON，无外部依赖） |

> 参考：[使用自定义机器人发送飞书卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/send-message-cards-with-custom-bot)

**Webhook 发卡片的官方限制**（很重要）：✅

- 卡片中**不能**含"请求回调交互事件"（按钮只能 `open_url` 跳转，不能回传服务端）；
- 卡片**仅用于一次性通知**，不能更新；
- **仅向单个指定群**发送。

这三条恰好完全匹配"日报/告警"场景 —— 我们本来就不需要交互。

### 3.6 卡片 2.0 的组件白名单（血泪点）

2.0 **只认**下面这批 `tag`；1.0 时代常用的 **`note`（备注）和 `action`（交互模块）在 2.0 已被移除**。官方原文：*"2.0 结构不再支持备注（note）组件和交互模块（"tag" 为 "action"）"*。硬用会报 `230099` + 子码 `200861`（`unsupported tag`）。✅

| 类别 | 2.0 可用 `tag` |
|---|---|
| 展示类 | `header`（标题）· `div`（普通文本）· `markdown`（富文本）· `img`（图片）· `img_combination`（多图混排）· `person` · `person_list` · `chart` · `table` · `hr`（分割线） |
| 容器类 | `column_set`（分栏）· `form`（表单）· `interactive_container` · `collapsible_panel`（折叠面板）· 循环容器（仅搭建工具） |
| 交互类 | `button` · `overflow` · `input` · `select_static` · `multi_select_static` · `select_person` · `multi_select_person` · `date_picker` · `picker_time` · `picker_datetime` · `select_img` · `checker` |

**`note` 的替代写法**（本文示例卡片的脚注就是这么写的）✅：

```json
{"tag":"div","margin":"8px 0px 0px 0px",
 "text":{"tag":"plain_text","content":"脚注内容","text_size":"notation","text_color":"grey"}}
```

- `text_size` 取 `notation` = **12px 辅助信息**字号；
- `text_color` 可填颜色枚举（`grey`、`grey-500` … 见[颜色枚举值](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/enumerations-for-fields-related-to-color)）。

**嵌套限制**（写复杂日报时容易撞）✅：`table`、`chart` **只能挂在根节点**，不能被别的容器嵌套；表单容器不能内嵌 `table`/`chart`；折叠面板不能内嵌 `form`/`table`。

> 参考：[组件概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/component-json-v2-overview)、[2.0 版本更新说明 · 废弃备注组件 & 交互模块](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-breaking-changes-release-notes)

---

## 4. 图片 / 文件上传

### 4.1 上传图片（拿 image_key）

```http
POST https://open.feishu.cn/open-apis/im/v1/images
Authorization: Bearer t-xxx
Content-Type: multipart/form-data

image_type=message
image=@/tmp/chart.png
```

返回：`{"code":0,"data":{"image_key":"img_v2_xxx"},"msg":"success"}` ✅

| 限制 | 值 |
|---|---|
| 大小 | **≤ 10 MB**，且不能为 0 字节 |
| 格式 | JPG / JPEG / PNG / WEBP / GIF / BMP / ICO / TIFF / HEIC（**TIFF、HEIC 上传后会被转成 JPG**） |
| 分辨率 | GIF ≤ 2000×2000；其他 ≤ 12000×12000；头像 ≤ 4096×4096 |
| 频率 | 1000 次/分钟、50 次/秒 |
| 权限 | `im:resource` 或 `im:resource:upload` |
| 前提 | 应用需**开启机器人能力** |

常见错误码：`234006` 超大小、`234010` 0 字节、`234011` 格式不支持、`234039` 分辨率超限、`234007` 未开机器人能力。✅

上传文件（`POST /open-apis/im/v1/files`）限制 ≤ **30 MB**。✅

### 4.2 日报带趋势图：PNG 还是原生图表？

**结论：用卡片原生 `chart` 组件，不要贴 PNG。** 理由：

| | 本地渲染 PNG 再上传 | 卡片原生 `chart` |
|---|---|---|
| 是否需要自建应用 | **需要**（上传要 `tenant_access_token` + 机器人能力） | **不需要**（纯 webhook 即可） |
| 路由器依赖 | 需要能画图（gnuplot/ImageMagick/Python-PIL —— 在 OpenWrt 上装这些很重） | 只需拼 JSON |
| 体积 | 图片走单独接口 + `image_key` 引用，卡片很轻 | 7 点折线元素 ≈ **335 B**；48 点 ≈ **1066 B**；整张周报卡片（摘要 + 5 行表格 + 7 点折线）≈ **1.6 KB** |
| 展示效果 | 静态图，模糊/暗色模式不适配 | **可交互**（点数据标签、点图例过滤、拖缩略轴）、自适应深浅色、可全屏/独立窗口 |
| 失败面 | 上传失败、key 过期、权限、体积 4 类问题 | 只有 `chart_spec` 写错 |

**为什么纯 webhook 贴不了图**（这条是设计上的硬约束，务必记住）：

- 拿 `image_key` 的唯一官方途径是「上传图片」接口 → 需要 `tenant_access_token`（自建应用）。
- 官方对自定义机器人的定位是：*"自定义机器人不具有任何数据访问权限"*、*"仅支持通过 Webhook 单向推送消息到指定群聊"*。✅
- 因此：**Webhook-only 场景下无法获得 `image_key`**，卡片里的 `img` 组件和 markdown 的 `![..](img_key)` 都用不了。🟡

> ❓ 未核实：用**自建应用**上传得到的 `image_key`，能否在**同一租户的自定义机器人 webhook** 消息中直接使用。按 `image_key` 是租户级资源推断大概率可以，但官方未承诺，**要用必须自己实测**。所以如果哪天真的必须贴图，就走自建应用整条链路，别赌混用。

---

## 5. 限流与失败处理

### 5.1 错误码/状态码含义

**Webhook 专有（官方自定义机器人文档）** ✅

| code | msg | 含义 / 处理 |
|---|---|---|
| `0` | success | 成功（HTTP 200）。注意同时还有冗余字段 `StatusCode`/`StatusMessage`，官方说**不建议使用** |
| `9499` | Bad Request | 请求体格式错误：结构不符合该 `msg_type` 的示例，或**超过 20 KB** |
| `19021` | sign match fail or timestamp is not within one hour from current time | 签名错 / 时间戳超 1 小时 / 路由器时钟不准 |
| `19022` | Ip Not Allowed | 出口 IP 不在白名单 |
| `19024` | Key Words Not Found | 消息不含任一自定义关键词 |
| `11232` | create message service trigger rate limit | **系统级**限流（官方点名整点/半点高发），不是你的 QPS 超了 |

**平台通用** ✅

| code / HTTP | 含义 | 处理 |
|---|---|---|
| `99991400` + **HTTP 429**（部分旧接口是 400） | `request trigger frequency limit` | 读响应头 **`x-ogw-ratelimit-reset`**（还有 `x-ogw-ratelimit-limit`），等待该秒数后重试；这是官方推荐做法 |
| `230020` (400) | `This operation triggers the frequency limit.` | 降频重试 |
| `230025` (400) | 消息体超长（文本 150 KB / 卡片富文本 30 KB） | 裁剪内容 |
| `230099` (400) | `Failed to create card content.` | 看子错误码（见下） |
| `230034` | `receive_id` 无效 | 检查 ID 与 `receive_id_type` 是否匹配 |
| `230022` | 内容含敏感信息 | 改文案（流量类插件基本不会遇到） |

**卡片子错误码**（都挂在 `230099` 下）✅

| 子码 | 含义 |
|---|---|
| `200550` | `chart_spec` 无效（`ErrPath` 指出第几个元素） |
| `200621` | 卡片 JSON 解析失败 |
| `200861` | 用了 2.0 已废弃的组件/标签 |
| `11310` | ① 模板对应用不可见 ② `element exceeds the limit`（2.0 超 200 元素）③ `card action is lock` |
| `200380` | 卡片模板不存在/未发布 |
| `200381` | 无卡片模板使用权限（没把机器人加进模板授权） |
| `200732` / `200737` | 模板变量类型/格式不匹配 |
| `100290` | 卡片中存在无效的人员 ID（at 人/人员组件） |

**token 接口**：`20002` secret 错、`20009` 租户未安装应用、`20048` 应用不存在、`20069` 应用未启用、`20070` 两种认证方式同时用。✅

### 5.2 重试与退避建议

按错误分类处理，别一把梭全重试：

1. **先判 body `code`，再判 HTTP 状态码**。Webhook 签名错、关键词错都是 **HTTP 200 + code≠0**，只看状态码会"假成功"，告警丢了都不知道。✅🟢
2. **可重试**：`11232`、`99991400`/429、`230020`、HTTP 5xx、连接超时/DNS 失败。
3. **不可重试**（改配置或改内容才有用）：`9499`、`19021`、`19022`、`19024`、`230025`、`200550`、`200621`、`200380`、`200381`。
4. **退避**：
   - 有 `x-ogw-ratelimit-reset` → **严格按它等**（官方指定）；
   - 否则指数退避 + 抖动：`1s, 2s, 4s, 8s`（±30% 抖动），最多 3–4 次；
   - `11232` 建议直接顺延到「下一分钟且非整点」重发，因为它是系统压力，立刻重试更容易连败。
5. **告警要合并**：本地做"同一设备+同一类型"的 **10 分钟去重/聚合窗口**（例如"5 个设备超阈值"合一条），否则 100 次/分很容易被几台设备刷穿。
6. **本地队列 + 落盘**：路由器内存小，失败消息写 `/tmp` 或 `/etc/.../queue`（注意 flash 写入寿命，建议 `/tmp` + 定期转存），重启不丢关键告警。
7. **单飞 + 串行**：shell 脚本用 `flock` 防并发；全局限速器（例如每次发送前 sleep 200ms，天然满足 5 次/秒）。
8. **NTP 必开**：签名容差 ±1 小时，路由器断电重启后时钟漂移会导致全部 `19021`。启动脚本里先 `ntpd -q` 或等 sysntpd 同步完再发。

### 5.3 Webhook 失效 / 机器人被移出群的表现

**官方文档没有写这种情况的返回码**（我在自定义机器人文档、通用错误码文档里都没找到）。❓

可预期的表现（**未核实，需实测**）：

- 机器人被移出群 / 群解散 / webhook 被重置 → 大概率返回**非 0 的 `code`**（社区有 `19001` 的说法，见下），也可能直接 HTTP 4xx；
- 社区库 `notify-bridge` 的文档把 `19001` 记为"无效的 webhook"、`19002`"无效的签名"、`19003`"无效的时间戳" —— 但**这与官方文档冲突**（官方签名失败是 `19021`），我个人判断这三个码属于旧版接口或社区误记，**不要依赖**。❓
- 另有社区 PR（bytedance/deer-flow #7798、Runfusion/Fusion #3634）强调"必须校验 body `code`，否则失败会静默假成功" —— 这一点与官方文档一致，可信。✅

**工程上的兜底方案**（不依赖猜错误码）：

- **每日心跳消息**：日报本身就是心跳；再加一条"周报生成成功"之类的轻量文本，连续 N 次失败即报警（怎么报警？路由器 Web 界面红字 + 本地 syslog，因为飞书这条路断了）。
- **失败计数持久化**：连续失败 ≥3 次就在 Web 界面显著提示"飞书推送已失效，请重新复制 webhook 地址"。
- 提供**「测试推送」按钮**：用户改完配置点一下，立即反馈成功/失败 + 错误码中文解释。

---

## 6. 可直接照抄的最小示例

### 6.1 纯文本（不签名）—— 30 秒验证连通性

```bash
HOOK='https://open.feishu.cn/open-apis/bot/v2/hook/你的token'

curl -sS -X POST "$HOOK" \
  -H 'Content-Type: application/json' \
  -d '{"msg_type":"text","content":{"text":"OpenWrt 流量插件连通性测试"}}'
```

期望输出：`{"StatusCode":0,"StatusMessage":"success","code":0,"data":{},"msg":"success"}`

### 6.2 带签名校验的最小 shell（curl + openssl）✅🟢

```bash
#!/bin/sh
# 用法: ./feishu-send.sh  "消息文本"
set -eu

HOOK='https://open.feishu.cn/open-apis/bot/v2/hook/你的token'
SECRET='你的签名密钥'          # 群机器人 → 安全设置 → 签名校验 → 复制
TEXT="${1:-hello}"

TS=$(date +%s)                                              # 秒级时间戳
KEY=$(printf '%s\n%s' "$TS" "$SECRET")                      # timestamp + LF + secret
SIGN=$(printf '' | openssl dgst -sha256 -hmac "$KEY" -binary | base64 | tr -d '\n')

# 用 printf 生成 JSON（避免 echo 解释反斜杠），并注意转义双引号和换行
JSON=$(printf '{"timestamp":"%s","sign":"%s","msg_type":"text","content":{"text":"%s"}}' \
        "$TS" "$SIGN" "$TEXT")

curl -sS -X POST "$HOOK" -H 'Content-Type: application/json' -d "$JSON"
echo
```

关键点（每条都验证过）：

- `KEY` 里必须含**真实换行**：`printf '%s\n%s'` 就可以；用 `echo "$TS\n$SECRET"` 在部分 shell 下会得到字面 `\n`，**必错**。
- `openssl dgst -hmac "$KEY"` 接受含换行的 argv，实测正确。
  - 如果担心 argv 里换行被某些环境吞掉，改用 hexkey 写法（结果完全一致）：
    ```sh
    HEXKEY=$(printf '%s\n%s' "$TS" "$SECRET" | od -An -v -tx1 | tr -d ' \n')
    SIGN=$(printf '' | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$HEXKEY" -binary | base64 | tr -d '\n')
    ```
- `base64` 输出带换行，必须 `tr -d '\n'`，否则 JSON 里会多出换行 → 签名对但 JSON 坏了。
- `-d "$JSON"` 里的双引号需要你自己保证合法；**文本里有 `"` `\` 或换行时不要手拼**，见 §6.4。

### 6.3 日报/周报卡片（表格 + 原生折线图，可直接发）✅🟢

```bash
HOOK='https://open.feishu.cn/open-apis/bot/v2/hook/你的token'

curl -sS -X POST "$HOOK" \
  -H 'Content-Type: application/json' \
  -d @weekly-card.json
```

`weekly-card.json`（已用 JSON 校验器验证，**1583 字节**，远低于 20 KB）：

```json
{"msg_type":"interactive","card":{"schema":"2.0","config":{"update_multi":true,"width_mode":"fill"},"header":{"template":"blue","title":{"tag":"plain_text","content":"流量周报 2026-W46（11-09 ~ 11-15）"},"subtitle":{"tag":"plain_text","content":"OpenWrt 路由器 · 自动生成"}},"body":{"direction":"vertical","padding":"12px","elements":[{"tag":"markdown","content":"**总用量**：128.6 GB（环比 ↑12%）\n**在线设备**：17 台\n**告警次数**：3"},{"tag":"table","page_size":5,"row_height":"low","freeze_first_column":true,"header_style":{"bold":true,"background_style":"grey","text_size":"normal"},"columns":[{"name":"rank","display_name":"#","data_type":"number","width":"40px"},{"name":"host","display_name":"设备","data_type":"text"},{"name":"total","display_name":"合计","data_type":"text"}],"rows":[{"rank":1,"host":"iPhone-15","total":"42.1 GB"},{"rank":2,"host":"MacBook","total":"31.7 GB"},{"rank":3,"host":"NAS","total":"22.4 GB"},{"rank":4,"host":"TV-Box","total":"15.2 GB"},{"rank":5,"host":"unknown-aa:bb","total":"9.8 GB"}]},{"tag":"chart","aspect_ratio":"16:9","color_theme":"brand","chart_spec":{"type":"line","title":{"text":"近 7 日用量 (GB)"},"data":{"values":[{"d":"11-09","v":17.2},{"d":"11-10","v":19.4},{"d":"11-11","v":18.1},{"d":"11-12","v":21.6},{"d":"11-13","v":16.9},{"d":"11-14","v":18.8},{"d":"11-15","v":16.6}]},"xField":"d","yField":"v"}},{"tag":"div","margin":"8px 0px 0px 0px","text":{"tag":"plain_text","content":"阈值/推送时间可在路由器 Web 界面调整","text_size":"notation","text_color":"grey"}}]}}}
```

等价可读版（对照看结构，实际发送用上面单行）：

```json
{
  "msg_type": "interactive",
  "card": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "width_mode": "fill"
    },
    "header": {
      "template": "blue",
      "title": {
        "tag": "plain_text",
        "content": "流量周报 2026-W46（11-09 ~ 11-15）"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": "OpenWrt 路由器 · 自动生成"
      }
    },
    "body": {
      "direction": "vertical",
      "padding": "12px",
      "elements": [
        {
          "tag": "markdown",
          "content": "**总用量**：128.6 GB（环比 ↑12%）\n**在线设备**：17 台\n**告警次数**：3"
        },
        {
          "tag": "table",
          "page_size": 5,
          "row_height": "low",
          "freeze_first_column": true,
          "header_style": {
            "bold": true,
            "background_style": "grey",
            "text_size": "normal"
          },
          "columns": [
            {
              "name": "rank",
              "display_name": "#",
              "data_type": "number",
              "width": "40px"
            },
            {
              "name": "host",
              "display_name": "设备",
              "data_type": "text"
            },
            {
              "name": "total",
              "display_name": "合计",
              "data_type": "text"
            }
          ],
          "rows": [
            {
              "rank": 1,
              "host": "iPhone-15",
              "total": "42.1 GB"
            },
            {
              "rank": 2,
              "host": "MacBook",
              "total": "31.7 GB"
            },
            {
              "rank": 3,
              "host": "NAS",
              "total": "22.4 GB"
            },
            {
              "rank": 4,
              "host": "TV-Box",
              "total": "15.2 GB"
            },
            {
              "rank": 5,
              "host": "unknown-aa:bb",
              "total": "9.8 GB"
            }
          ]
        },
        {
          "tag": "chart",
          "aspect_ratio": "16:9",
          "color_theme": "brand",
          "chart_spec": {
            "type": "line",
            "title": {
              "text": "近 7 日用量 (GB)"
            },
            "data": {
              "values": [
                {
                  "d": "11-09",
                  "v": 17.2
                },
                {
                  "d": "11-10",
                  "v": 19.4
                },
                {
                  "d": "11-11",
                  "v": 18.1
                },
                {
                  "d": "11-12",
                  "v": 21.6
                },
                {
                  "d": "11-13",
                  "v": 16.9
                },
                {
                  "d": "11-14",
                  "v": 18.8
                },
                {
                  "d": "11-15",
                  "v": 16.6
                }
              ]
            },
            "xField": "d",
            "yField": "v"
          }
        },
        {
          "tag": "div",
          "margin": "8px 0px 0px 0px",
          "text": {
            "tag": "plain_text",
            "content": "阈值/推送时间可在路由器 Web 界面调整",
            "text_size": "notation",
            "text_color": "grey"
          }
        }
      ]
    }
  }
}
```

### 6.4 别在 shell 里手拼 JSON

文本里出现 `"`、`\`、换行、emoji 时，手拼 JSON 几乎必然出错。两种稳妥做法：

**A. 用文件（推荐，最省事）**

```sh
# 生成 /tmp/body.json 后
curl -sS -X POST "$HOOK" -H 'Content-Type: application/json' --data-binary @/tmp/body.json
```

`-d @file` 与 `--data-binary @file` 都不做分块，区别在于 `-d` 会去掉换行；**卡片 JSON 建议用 `--data-binary`** 保证字节完全一致（对签名字段无影响，但对 `20 KB` 计数与调试更可控）。

**B. 用 ucode / lua（OpenWrt 自带）序列化**

OpenWrt 默认带 `ucode` 或 `lua`，用其 JSON 库生成字符串再喂给 curl，避免任何转义问题。❓（具体可用的 JSON 库随固件版本不同，需按目标固件确认）

### 6.5 自测签名是否正确

拿 §1.3 的向量做断言，两边一致才发：

```sh
TS=1599360473; SECRET=demo
KEY=$(printf '%s\n%s' "$TS" "$SECRET")
printf '' | openssl dgst -sha256 -hmac "$KEY" -binary | base64
# 期望: l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=
```

---

## 7. 家用无公网环境下的推荐方案

### 7.1 推荐架构（一路 Webhook 到底）

```
流量采集 (nftables/conntrack) → 本地 SQLite/JSON → 报表/告警决策
                                                        │
                                        ┌───────────────┴───────────────┐
                                        ▼                               ▼
                             日报/周报（每日/每周 1 次）        告警（事件驱动）
                             card: markdown + table + chart     text 或小卡片（1 小时内合并）
                                        │                               │
                                        └───────────► curl + openssl ◄──┘
                                                           │
                                              POST /open-apis/bot/v2/hook/<token>
                                           (出站 HTTPS，签名校验，失败落盘重试)
```

**具体选型**：

| 项目 | 选择 | 理由 |
|---|---|---|
| 通道 | 群自定义机器人 Webhook | 无公网、无审核、零后台依赖 |
| 安全 | **签名校验**（不要 IP 白名单） | 家宽 IP 会变；签名成本极低 |
| 日报格式 | 卡片 2.0：`markdown`(摘要) + `table`(Top N) + `chart`(趋势) | 全部原生，无需上传图片 |
| 告警格式 | `text`（简单）或极简卡片（带颜色 header 区分等级） | 体积小、失败率低；支持 `<at user_id="ou_xxx">` 但需预先知道 open_id |
| 图表 | 卡片原生 `chart` | 免上传、可交互、体积小 |
| 频率控制 | 本地限速 200ms/次 + 告警 10 分钟聚合 | 远离 100 次/分、5 次/秒 |
| 心跳 | 日报即心跳 + 连续失败 3 次在 Web 界面报警 | 通道断了不能只靠通道通知 |
| 时钟 | 启动后等 NTP 同步再发 | 签名 ±1 小时容差 |

### 7.2 什么时候才升级到自建应用

只有以下需求出现时才值得上：

- 要把报表发到**多个群**（每个群一个 webhook 也能凑合，但管理成本高）；
- 要**私聊指定人/部门**（webhook 做不到，这是最硬的边界）；
- 日报必须带**本地渲染的 PNG**（如热力图、复杂堆叠图，卡片 chart 表达不了）；
- 需要用卡片按钮**回传交互**（如"确认静默该告警"）。

升级代价评估：建应用 + 开机器人能力 + 申请 `im:message:send_as_bot`（可能需管理员审核发版）+ 实现 token 缓存（2h）+ 把 `card` 改成 `content` 字符串。工作量大约 1–2 天，不算大，但**没有必要提前做**。

### 7.3 OpenWrt 工具链注意

- `curl` 需要装 `curl` 包（`opkg install curl`），比 busybox 的 `wget` 更可控（busybox wget 对自定义 header + POST body 支持有限，且不同版本行为差异大）。❓（需按固件实测）
- `openssl` CLI 来自 **`openssl-util`** 包（`/usr/bin/openssl`）；`base64` 通常由 busybox 提供。❓（同上，需实测；若缺失可改用 `openssl base64`）
- 若嫌 openssl 大，可考虑用 `ucode` 的 crypto/或者 `md5sum` 系的不可行 —— **HMAC-SHA256 必须要有 SHA256 实现**，别想着用 `md5sum` 糊弄。
- 写文件注意 flash 寿命：日志/队列放 `/tmp`（tmpfs），只把配置放持久分区。

---

## 8. 踩坑清单

**签名类（最高发）**

1. ❌ 把 `secret` 当 HMAC key、`timestamp` 当消息 → 一切皆错。正确：`key = timestamp+"\n"+secret`，`msg = 空`。
2. ❌ 用毫秒时间戳；❌ 用 `\n` 字面两字符；❌ 输出 hex 而非 Base64。
3. ❌ 路由器时钟不准 → `19021`；❌ `base64` 输出的换行没删，JSON 结构坏了。
4. ❌ 以为"签名只签 content" —— 实际上签名**不覆盖消息体**，只覆盖 timestamp。

**协议类**

5. ❌ **只看 HTTP 200 就认为成功**。签名错/关键词错都是 200 + `code≠0`，告警静默丢失。
6. ❌ 卡片用 `content` 字段（那是应用 API 的写法），Webhook 用 **`card`**。
7. ❌ 把 `timestamp`/`sign` 放进 `content` 里，而不是 body 根部。
8. ❌ 忘记 `Content-Type: application/json`，或用了 `charset` 以外的怪异值。

**体积/频率类**

9. ❌ 20 KB 是**整个 body**，含 JSON 转义后的字节（中文 3 字节/字，`\"` 变 3 字节）。用 `compact` 序列化（无空格无缩进），别发 pretty JSON。
10. ❌ 表格默认 `page_size=5`，以为发了 50 行就显示 50 行 —— 实际每页只显示 5 行，要显式设 `page_size:10`。
11. ❌ 单卡超 200 个元素（2.0 硬限制），或塞了 6 个表格/图表（上限 5 个）。
12. ❌ 定时任务都设在 10:00 / 17:30 整点 → 撞上 `11232`。**错峰 + 加随机秒偏移**。
13. ❌ 一个机器人想推两个群 —— 做不到，一个机器人只能在一个群。

**卡片类**

14. ❌ 用 2.0 结构但客户端 < 7.20 → 用户只看到标题和一句升级提示。发布前抽样确认版本，或退回 1.0。
15. ❌ 2.0 里写了 1.0 的属性 → **2.0 会直接报错**（1.0 是静默忽略），别照抄旧博客。
16. ❌ 在 2.0 里用 `note`（备注）或 `action`（交互模块）→ `200861` `unsupported tag`。这两个组件 2.0 已移除，脚注改成 `div` + `text_size:notation` + 灰色文字（见 §3.6）。
17. ❌ `chart_spec` 里写 JS 函数/lambda（不支持）；移动端用了 texture/圆锥渐变/grid 词云 → 图加载失败。
18. ❌ 表格组件想放进 `column_set`/`form` 里 —— 它**只能挂在根节点**。
19. ❌ 想给卡片贴外链图片 URL —— 只认 `image_key`。
20. ❌ 用卡片模板却忘了在搭建工具里把机器人加为使用者 → `200381`。

**运维类**

21. ❌ Webhook 地址写进公开仓库/日志（官方专门警告）→ 任何人都能往你群里刷消息。建议存 UCI 配置并限制文件权限。
22. ❌ 群解散 / 机器人被移除后无人知晓 → 必须有本地失败告警与"测试推送"按钮。
23. ❌ 开 IP 白名单 → 家宽换 IP 后全部失败，且报错信息不直观容易误判成签名问题。
24. ❌ 关键词设置后改了文案模板 → `19024`。关键词放在 `header.title` 最稳。
25. ❌ 每条告警都即时发 → 设备批量超阈值时瞬间打满 100 次/分。

---

## 9. 未核实 / 存疑清单（上线前必须自测）

| # | 问题 | 现状 | 验证方法 |
|---|---|---|---|
| 1 | Webhook **每日累计条数**上限 | 官方文档中**未见**任何每日上限；社区"每天 1000 条"说法无出处 | 按 100 次/分设计；如担心，压测一天 500 条观察 |
| 2 | 机器人被移出群 / webhook 失效的**确切 code** | 官方未写；社区 `19001/19002/19003` 说法与官方 `19021` 冲突 | 建测试群 → 移出机器人 → 记录真实响应 |
| 3 | Webhook `post` 是否支持 `md`（Markdown）标签 | 官方 webhook 文档只列 `text`/`a`/`at`/`img`；应用消息文档有 `md` | 直接发一条带 `md` 标签的 post 试 |
| 4 | 自定义**关键词**是否扫描卡片正文（`markdown.content` / 表格单元格） | 官方只说"只对 `text`、`title` 这类文本参数值生效" | 关键词设为卡片里才出现的词，发一张卡片看是否 19024 |
| 5 | 自建应用上传的 `image_key` 能否在 **webhook** 消息中复用 | 官方未承诺 | 上传后用 webhook 发 `image` 消息试 |
| 6 | `11232` 的重试节奏（是否立刻重试会连败） | 官方只说会因系统压力触发 | 压测观察 |
| 7 | OpenWrt 上 `openssl`/`base64`/`curl` 的具体可用性与包名 | 取决于固件与架构 | 目标固件上 `which openssl base64 curl` 实测 |
| 8 | 卡片 2.0 在目标用户手机（飞书版本）上的实际渲染 | 需 ≥ 7.20 | 找 2–3 台真机看效果 |
| 9 | `chart` 组件在低端安卓机上的性能 | 未知 | 真机验证 |
| 10 | 官方 SDK 是否适合 OpenWrt | 官方 SDK 面向 Go/Python/Java/Node，体积大 | 不建议在路由器上用 SDK，直接 curl |

---

## 10. 参考链接

**官方文档**

- [自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) — webhook、签名算法、错误码 19021/19022/19024、9499、20 KB、100 次/分
- [使用自定义机器人发送飞书卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/send-message-cards-with-custom-bot) — `card` 结构、template 写法、能力对比
- [频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN) — 429 / `99991400` / `x-ogw-ratelimit-reset` / 自定义机器人 100 次/分 5 次/秒 / 11232
- [自建应用获取 tenant_access_token（新版）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)
- [自建应用获取 tenant_access_token（旧版，历史）](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) — 权限、限频、体积、错误码
- [发送消息内容（各 msg_type 结构）](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)
- [上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)
- [上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)
- [卡片 JSON 2.0 结构](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
- [卡片 JSON 2.0 版本更新说明（1.0 差异）](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-breaking-changes-release-notes)
- [表格组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/table)
- [图表组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/chart)
- [富文本（Markdown）组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text) — GFM 表格语法限制
- [图片组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/image)
- [使用长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case) — 无需公网 IP
- [服务端 SDK 概述](https://open.feishu.cn/document/server-docs/server-side-sdk)
- [通用错误码](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN)

**社区参考实现**

- [shoutrrr · Lark service](https://github.com/nicholas-fedor/shoutrrr/blob/a4ae74216d354cd444846b4cc37d39c23c1d95be/docs/services/chat/lark/index.md) — Go，watchtower 生态在用的通知库；对 20 KB（20480 B）口径解释清晰，含签名 + post 的 URL 化配置
- [XUJiahua/alertmanager-webhook-feishu](https://github.com/XUJiahua/alertmanager-webhook-feishu) — Go，Prometheus Alertmanager → 飞书的**告警场景**参考架构（`feishu/bot.go` 里用官方 SDK 的 `WebhookV2` 发送，本仓库结构已实际拉取确认）
- [os7blue/dobby](https://github.com/os7blue/dobby) — Go，"简配版 Server 酱"，多通道 webhook 机器人（含飞书）
- [bytedance/deer-flow #7798](https://github.com/bytedance/deer-flow/pull/7798) — 真实项目里"飞书卡片超体积限制"的修例，可佐证 20 KB 是实打实的卡点
- [Runfusion/Fusion #3634](https://github.com/Runfusion/Fusion/pull/3634) — "必须校验 body `code`，19001/19002/19021 时如实报失败"的实践

> **审阅程度说明**（避免误信）：`shoutrrr` 的 Lark 文档、`alertmanager-webhook-feishu` 的目录结构与 `feishu/bot.go` 我**实际拉取读过**；`os7blue/dobby`、`bytedance/deer-flow#7798`、`Runfusion/Fusion#3634` 只来自搜索结果标题/描述，**未审阅其代码**，仅作线索。社区实现中的错误码说法与官方冲突处已在 §5.3 标注，**以官方文档为准**。

**官方给出的最小示例代码**（可直接照抄，权威）

官方自定义机器人文档内嵌了 **Java / Go / Python** 三种签名实现，其中 Python 版最精简：

```python
import hashlib, base64, hmac

def gen_sign(timestamp, secret):
    string_to_sign = '{}\n{}'.format(timestamp, secret)
    hmac_code = hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
    return base64.b64encode(hmac_code).decode('utf-8')
```

注意 `hmac.new(key, msg=None)` —— 官方就是靠"不传 msg"来表达"签空字符串"。
**官方没有提供 Shell 版本**，本文 §6.2 的 openssl 版本是我按该算法推导并做了交叉验证的（见 §1.3 测试向量）。

---

## 附：一句话总结

> **家用无公网场景，用「群自定义机器人 Webhook + 卡片 JSON 2.0（markdown 摘要 + 原生 table + 原生 chart）+ 签名校验」即可完整覆盖日报/周报与告警；唯一真正的硬约束是「20 KB / 100 次每分 / 不能发图 / 只能发一个群」，其中"不能发图"用卡片原生图表就能绕开，因此完全不需要自建应用。**
