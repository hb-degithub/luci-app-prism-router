# 飞书官方 SDK 长连接（feishu-ws）与随包分发的 lark-oapi

本插件 1.0.23 起随 IPK 分发**官方 lark-oapi 1.8.0**（裁剪后的长连接子集）和一个
procd 服务，用官方 `lark_oapi.ws.Client` 常驻接收飞书事件，把「机器人被加进哪些群」
「谁在群里说过话」记录成脱敏清单，设置页可一键把发现的 `chat_id` / `receive_id`
填进现有字段。**默认关闭。**

```
/etc/init.d/prism-router-feishu-ws          procd 服务（ws_enabled=1 且凭据齐全才启动）
/usr/share/prism-router/feishu-ws.py        服务主体（标准库 + 随包 SDK）
/usr/lib/prism-router/pylib/                随包 SDK（不写系统 site-packages）
/etc/prism-router/feishu-ws.json            发现的群/用户（0600，原子写）
/tmp/prism-router/feishu-ws.status.json     实时状态（tmpfs，15s 心跳）
/tmp/prism-router/feishu-ws.pid             PID（tmpfs）
/tmp/prism-router/feishu-ws.log             日志（0640，512KB 上限，超了保留尾部）
```

## 打开方式

```sh
uci set prism-router.feishu.ws_enabled='1'
uci commit prism-router
/etc/init.d/prism-router-feishu-ws enable
/etc/init.d/prism-router-feishu-ws start
```

关闭：

```sh
uci set prism-router.feishu.ws_enabled='0'
uci commit prism-router
/etc/init.d/prism-router-feishu-ws stop
/etc/init.d/prism-router-feishu-ws disable
```

前置条件（缺一不启动，具体原因由 `ubus call prism-router feishu_ws_status` 的
`reasons` 返回）：

1. `prism-router.feishu.app_id` / `app_secret` 已填；
2. python3 运行时已装（`Depends` 自动带 `python3-light` 等，见 Makefile）；
3. 飞书开放平台 →「事件与回调」→ **加密策略**里选择**长连接**；
4. 同一页「事件订阅」添加：`im.chat.member.bot.added_v1`（机器人入群）、
   `im.message.receive_v1`（接收消息）；
5. 权限管理里给机器人 `im:message`（读消息）等对应权限，并「创建版本并发布」。

> 长连接本身**不需要**公网回调地址、不需要内网穿透，只要路由器能出站访问
> `open.feishu.cn`。事件是否真的能收到，取决于第 3–5 步在飞书后台的配置。

## rpcd 契约：`prism-router.feishu_ws_status`

只读、脱敏，**不返回 `app_secret`**（只在本地判空）。读权限由 ACL 控制
（`luci-app-prism-router` 与 `luci-app-prism-router-admin` 的 read 已放行）。
设置页只需 `rpc.declare({ object:'prism-router', method:'feishu_ws_status' })`。

```jsonc
{
  "ok": true,
  "ws_enabled": true,          // uci feishu.ws_enabled
  "has_credentials": true,     // app_id 非空 && app_secret 非空
  "running": true,             // PID 活着 && 状态文件 pid 对得上 && 心跳 <= 180s
  "connected": true,           // WebSocket 已连上（watchdog 每 15s 采样）
  "pid": 9574,
  "last_event_ts": 0,          // 最近事件（tmpfs 实时值 > /etc 落盘值）
  "last_event_type": "",       // 如 im.message.receive_v1
  "events_seen": 0,
  "heartbeat_age": 0,          // 秒；-1 = 从未写过状态
  "last_error": "",
  "chats": [                   // 最多 50，按最近活跃
    { "chat_id": "oc_xxx", "name": "家里", "last_seen": 1700000000 }
  ],
  "users": [                   // 最多 20
    { "open_id": "ou_xxx", "user_id": "u_xxx", "name": "", "last_seen": 1700000000 }
  ],
  "log_tail": [                // 最后 40 行，URL query / token 已打码
    "2026-11-22T23:14:22 INFO  connected to wss://msg-frontier.feishu.cn/ws/v2?***"
  ],
  "reasons": [                 // 未运行时「下一步做什么」
    "ws_enabled=0：长连接默认关闭，勾选「启用长连接」并保存后才会启动"
  ],
  "paths": { "state": "...", "status": "...", "log": "...", "init": "..." }
}
```

设置页建议：

* 勾选框写 `feishu.ws_enabled`（已在 rpcd 的 UCI 写白名单里）。
* 状态行显示：未启用 / 运行中（已连接/未连接）/ 未运行 + `reasons[0]`。
* `chats` / `users` 有内容时给「使用该 chat_id」「使用该 open_id」按钮，
  **只填当前输入框，不自动保存**，用户点保存才落 UCI。
* 刷新频率别太密（`log_tail` 每次会读最多 512KB 日志）；建议 10–30s 一次，
  或只在展开「长连接状态」时刷新。

## 安全

* `app_secret` 只在 Python 进程内用 `uci -q get` 读进内存：**不进 argv、不进环境变量、
  不写状态文件、不打印**。`--check` 只输出 `has_app_id/has_app_secret` 布尔值。
* `/etc/prism-router/feishu-ws.json` 是 0600，原子写（同目录临时文件 + `os.replace`）；
  只在「发现新群/新用户」或距上次 ≥10 分钟时才写，避免每条消息擦写 flash。
* 日志 0640、512KB 上限。SDK 的连接串里带 `access_key`/`ticket`，服务用一个
  自定义 logging handler 接管 SDK 日志：URL 只留 `wss://host/path?***`，
  `access_key=`/`ticket=`/`secret=` 等 token 整体打码；SDK 自带的 stdout handler
  被降级到 WARNING，避免原始 URL 进 `logread`。rpcd 返回的 `log_tail` 再做一次
  同样的打码。
* 事件内容不落盘：只记 `chat_id` / `open_id` / `user_id` / 群名（截断 64 字）。
* 服务以 root 运行（需要读 `/etc/config/prism-router`），只监听出站 WSS。
* **不写 `.pyc`**：`feishu-ws.py` 在导入 SDK 之前就 `sys.dont_write_bytecode = True`，
  init 脚本另带 `PYTHONDONTWRITEBYTECODE=1`。实测一次不带该变量的
  `python3 -c "import lark_oapi"` 会在 pylib 里生成 474 个 `__pycache__` 文件
  （约 +3.7 MB flash），所以手工验证时也请带上：
  `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/usr/lib/prism-router/pylib python3 ...`

## 随包 SDK（体积 / 内存）

`lark_oapi` 官方整包会用 `from .api import *` 导入 10 534 个生成模块；真机
`import lark_oapi` 实测 **166 MB RSS / 4.9 s**。随包分发的是裁剪过的长连接子集
（只保留 `core/event/ws` + `api/im` 的事件模型，5 处最小补丁），真机：

| 指标 | 官方整包 | 随包裁剪版 |
|---|---|---|
| pylib 解压后 | 34.7 MB | **4.35 MB**（602 文件） |
| IPK 体积 | — | **1.61 MB**（含全部插件代码） |
| `import lark_oapi` RSS | 166 MB | **38 MB** |
| 服务常驻 RSS | — | **≈43 MB**（含 asyncio + websockets + 日志） |
| `import lark_oapi` 耗时 | 4.9 s | ≈0.6 s |

细节（保留/裁掉/补丁/原生扩展/重新生成）见
[`luci-app-prism-router/pylib/README`](../luci-app-prism-router/pylib/README)
与 [`MANIFEST.json`](../luci-app-prism-router/pylib/MANIFEST.json)，
工具是 [`tools/pylib_tool.py`](../tools/pylib_tool.py)。

**已知限制**：未分发产品线的 `register_p2_*` 方法仍存在，调用会 `NameError`；
`lark_oapi.Client`、`lark_oapi.channel`、`lark_oapi.register_app` 不存在。
本插件只用 `lark_oapi.ws.Client` + 两个 `im` 事件，`--selftest` 覆盖了这条路径。

## 构建 / 测试 / 验证

```sh
tools/build-ipk.sh                     # 打包前自动跑 pylib 清单+静态 import 图校验
tools/vendor-pylib.sh                  # 重新生成 pylib（在路由器上 pip download）
tests/container-validate-release.sh    # 发布门禁（23.05 + 24.10，含 pylib/服务/权限）
tests/container-validate-feishu-ws.sh  # 长连接门禁（rpcd 摘要/脱敏/裁剪/默认关闭）
tests/container-validate-feishu.sh     # 现有飞书发送门禁（回归）
```

真机验证（宿主 glibc 加载不了 musl .so，这一步只能在路由器上做）：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/usr/lib/prism-router/pylib \
  python3 -c 'import lark_oapi, lark_oapi.ws, Crypto.Cipher.AES; print("ok")'
/usr/share/prism-router/feishu-ws.py --selftest      # 应输出 "pylib": "/usr/lib/prism-router/pylib"
/usr/share/prism-router/feishu-ws.py --check         # has_app_id/has_app_secret 布尔值
ubus call prism-router feishu_ws_status | head -20
grep VmRSS /proc/$(cat /tmp/prism-router/feishu-ws.pid)/status
```

2026-11-22 在 iStoreOS 24.10 / python 3.11.18 / x86_64 上实测：

```
[INFO] connected to wss://msg-frontier.feishu.cn/ws/v2?*** [conn_id=7711014428167146491]
"running": true, "connected": true, "heartbeat_age": 0
VmRSS: 42960 kB
```

**仍未验证**：端到端事件投递（需要飞书后台订阅事件 + 把机器人拉进群后
从手机发消息），以及「机器人被移出群」等边界；`chats`/`users` 目前为空即因为
还没有事件到达。

## 回滚

* 只关长连接：`uci set prism-router.feishu.ws_enabled='0'; uci commit; /etc/init.d/prism-router-feishu-ws stop`
* 回滚整个版本：`opkg install --force-reinstall` 上一版 ipk（pylib 会随之移除）。
  旧版不依赖 `pylib`，`/usr/lib/prism-router/` 会作为遗留目录留空，可手工删除。
* 卸载：`opkg remove luci-app-prism-router` 会先 stop+disable 长连接
  （见 prerm），`/etc/prism-router/feishu-ws.json` 与其它数据文件保留。
