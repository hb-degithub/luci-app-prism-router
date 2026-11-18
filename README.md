# OpenWrt 棱镜路由插件

按**设备**与**应用/域名**统计流量，并把**代理链路流量与直连流量分开计算和展示**。
数据源双路互补、互不重复：

- **OpenClash / mihomo `/connections`** → 被代理接管的流量：真实域名、出口节点、每连接字节、源设备
- **`/proc/net/nf_conntrack`** → 未经代理的直连流量（fake-ip 网段与 Clash 活跃连接五元组双重去重，避免真实目的 IP 也重复计数）

## 组成

| 包 | 内容 |
|---|---|
| `prism-router` | 采集守护进程 `prism-routerd.uc`、飞书推送 `feishu.uc`、子节点推送 `push.uc`、母节点接收 CGI `prism-router-ingest`、独立面板服务（`prism-router-panel` init + `/www/prism-router-panel/`）、init/UCI 配置 |
| `luci-app-prism-router` | 5 个界面页（概览/设备/应用/节点/设置）、rpcd 后端、菜单与 ACL |

## 功能

- **按设备**：每台设备的直连/代理流量、实时速率、在线状态、接入方式（无线/有线）、信号强度、首次出现时间
- **按应用**：真实域名（来自 mihomo `/connections`）与出口节点，含类别（视频/社交/游戏/下载/开发/购物/系统）
- **两个正交维度**：代理 vs 直连、无线 vs 有线——各自独立成条，**不可相加**
- **软路由自身性能**：CPU / 内存 / Swap / 负载 / 磁盘 / 温度 / 运行时长 / WAN 上下行速率
- **六类界面**：概览、设备、应用、节点、设置、手机版；另有「详细面板」（七标签）与**独立面板服务**（独立端口，不经过 LuCI）
- **手机版 App 界面**：五屏分页（概览速率/设备/节点/拓扑/安装），上下行大数字与出口节点卡、主网络/访客/离线分段列表、AP 卡片网格；支持触摸滑动与纯本地筛选
- **网络拓扑**：手机版纵向五层（互联网 → 出口 → 主路由 → AP → 按接入方式分组的设备），详细面板横向七标签版本；点击出口/AP 卡可下钻查看其在线设备；AP 归属按 stations 上报的 MAC 匹配，数据缺失时逐层降级。AP 数据按需加载，不产生首屏开销
- **设备搜索**：手机版设备屏支持按名称 / MAC / IP 过滤，与接入方式筛选、排序叠加
- **手机版 PWA**：扫码安装到主屏，独立窗口打开，含绑定二维码与安装引导
- **飞书可配**：发什么（7 个区块任选）、什么时候（daily/weekly/both + 时间）、什么条件下（应用超限/突增/离线/CPU/内存/磁盘/免打扰）
- **子母多节点**：每个节点独立 HMAC 密钥、nonce 防重放，母节点汇总各子节点快照；默认校验 HTTPS 证书
- **哑桥 AP 信号**：只上报无线元数据（不含字节，避免双计）
- **数据治理**：保留策略（daily/nodes/stations/日志/队列，带 dry-run）、CSV 导出、Prometheus 指标
- **设备管理**：别名、分组、月配额与剩余量、陌生设备标记与阻断命令生成

## 安装

```sh
# 23.05 / 24.10 都用 .ipk（tar.gz 格式）；默认不生成不可用的 legacy 包
opkg install prism-router_1.0.0-1_all.ipk
opkg install luci-app-prism-router_1.0.0-1_all.ipk
/etc/init.d/prism-routerd enable
/etc/init.d/prism-routerd start
/etc/init.d/rpcd reload; rm -f /tmp/luci-indexcache*
```

依赖：`ucode`、`ucode-mod-{fs,uci,uloop}`、`curl`、`uhttpd`；飞书/子母签名需 `openssl-util`。

界面：LuCI → 服务 → 棱镜路由。

## 配置（UCI `prism-router`）

```sh
uci set prism-router.settings.poll_interval='5'      # 采集间隔（秒）
uci set prism-router.settings.clash_api='127.0.0.1:9090'
uci set prism-router.settings.clash_secret=''        # 留空=自动读 openclash.config.dashboard_password
uci set prism-router.settings.fake_ip_ranges='198.18.0.0/16'
uci commit prism-router
```

## 一个插件，两种打开方式

`luci-app-prism-router` 是**单个 ipk**：采集守护进程、rpcd 接口、LuCI 页面、CGI 与独立面板
服务都在同一个包里，安装后在「服务 → 棱镜路由」直接使用完整功能（概览/设备/应用/节点/
设置/手机版/诊断/详细面板）。

独立面板是该插件自带的**可选窗口**（默认关闭），适合把仪表盘单独放到第二个屏幕或做展示：

```sh
uci set prism-router.panel=panel
uci set prism-router.panel.enabled='1'
uci commit prism-router
/etc/init.d/prism-router-panel enable
/etc/init.d/prism-router-panel start
# 浏览器访问 http://<路由器LAN>:8099/
```

它不是第二个产品，也不需要单独安装任何包；关闭它不影响 LuCI 内的任何功能。

## 从旧版 `traffic-stats` 迁移

项目已更名为 **棱镜路由 / PRISM Router**，包名也随之变更：

| 旧 | 新 |
| --- | --- |
| `traffic-stats` + `luci-app-traffic-stats`（两个包） | **`luci-app-prism-router`（一个插件包）** |
| `/etc/config/traffic-stats` | `/etc/config/prism-router` |
| `/etc/traffic-stats/` | `/etc/prism-router/` |
| ubus `traffic-stats` | ubus `prism-router` |
| `/www/traffic-panel` | `/www/prism-router-panel` |

安装新包时 postinst 会自动迁移（幂等）：

- 旧配置优先复制为新配置，缺少 `panel` 段时补默认值；
- `/etc/traffic-stats/` 下的 `daily/`、`devices.json`、`stations/` 整份复制到 `/etc/prism-router/`；
- 停用旧服务 `traffic-statsd`，避免新旧守护进程同时写数据。

旧包与旧目录**保留不删除**（作为回滚备份）。确认新面板与数据正常后，可以执行
`opkg remove luci-app-traffic-stats traffic-stats` 清理旧包；`/etc/config/traffic-stats`
与 `/etc/traffic-stats/` 不会被自动删除，需要手动清理。

## 独立面板服务（脱离 LuCI）

`prism-router` 会安装一个**独立**的 uhttpd 实例（procd 管理，不占用 LuCI 的 web 端口，
也不经过 LuCI 会话）。启用后浏览器直接访问 `http://<路由器LAN地址>:8099/` 即可看到只读面板：

```sh
uci set prism-router.panel=panel          # 老配置升级后需要先建段（没有该段时默认关闭）
uci set prism-router.panel.enabled='1'
uci set prism-router.panel.port='8099'    # 1–65535；非法值回退 8099
uci set prism-router.panel.bind=''        # 留空 = 自动绑定 network.lan.ipaddr；都没有则监听所有接口
uci set prism-router.panel.token='<随机串>'  # 可选：留空 = 只依赖网络边界
uci commit prism-router
/etc/init.d/prism-router-panel enable
/etc/init.d/prism-router-panel restart
```

- **默认关闭**：`panel.enabled=0` 时 init 直接返回，不监听任何端口；安装/升级也不会强制启动。
- **只读**：静态根 `/www/prism-router-panel` 只放页面，CGI `/cgi-bin/panel-api` 只调用
  `prism-router` 的只读 ubus 方法（`state/history/nodes/stations/status`），不写文件、不改配置。
- **token**：页面首次用 `?token=<值>` 打开后会把令牌存到浏览器本地并继续用查询串携带；
  脚本可用 `Authorization: Bearer <token>`。CGI 也接受 `X-Panel-Token` 头，但 OpenWrt 的
  uhttpd 只转发 `Accept/Authorization/Host/User-Agent`，自定义 `X-*` 头会被丢掉（实测），
  所以经本服务访问时请用查询串或 Bearer。
- 这是**仅限局域网**的明文 HTTP 服务，不要暴露到 WAN；需要跨网络请走 WireGuard/Tailscale。
- 面板数据来自 rpcd 的 `prism-router` ubus 对象（由 `luci-app-prism-router` 提供），
  两个包都要装；运行时还需要系统自带的 `uhttpd`（已声明为 `prism-router` 依赖）。

## 飞书

两条路线，配了哪条走哪条：

```sh
# A. 自建应用机器人（二维码加群）
uci set prism-router.feishu.app_id='cli_xxx'
uci set prism-router.feishu.app_secret='xxx'
ucode /usr/share/prism-router/feishu.uc chats      # 列出机器人所在群，拿到 chat_id
uci set prism-router.feishu.chat_id='oc_xxx'

# B. 群自定义机器人 webhook
uci set prism-router.feishu.webhook='https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
uci set prism-router.feishu.secret='xxx'

uci set prism-router.feishu.enabled='1'            # 总开关（默认已是 1；设 0 可静音）
uci commit prism-router
ucode /usr/share/prism-router/feishu.uc test       # 连通性测试
```

定时（自行添加，包不改 crontab）：

```
32 8 * * *    ucode /usr/share/prism-router/feishu.uc daily
*/10 * * * *  ucode /usr/share/prism-router/feishu.uc alerts
```

## 子母多节点

母节点和子节点都注册**同一个节点 ID 对应的独立密钥**（母节点为每个子节点分别配置）：

```sh
# 两边都执行；把 node-a 和随机密钥替换为本节点实际值
uci add prism-router node
uci set prism-router.@node[-1].node_id='node-a'
uci set prism-router.@node[-1].secret="$(openssl rand -hex 32)"
uci set prism-router.settings.node_id='node-a'
uci set prism-router.settings.node_name='子节点-客厅'

# 仅子节点设置上报地址并启用；HTTPS 默认验证证书
uci set prism-router.settings.mother_url='https://192.168.100.1'
uci set prism-router.settings.mother_enabled='1'
uci commit prism-router
ucode /usr/share/prism-router/push.uc && echo ok
# cron: * * * * * ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
```

`node-a` 这类带连字符的 ID 必须写匿名 `config node` + `option node_id`，不能用作 UCI section 名。AP 同理使用 `config station` + `node_id/token`。

升级旧版时可短期显式开启 `settings.legacy_shared_secret=1`（AP 为 `legacy_stations_token=1`）；该模式恢复全局共享凭证，只能用于迁移，完成后立即关闭。旧版 `totals` 仍表示进程启动以来累计，跨重启的日累计由 daily 与连接基线延续。

界面「节点」页展示各节点最后上报时间、总流量、代理/直连、设备数；超 5 分钟未更新标黄。

## 部署前验证（强制）

十三套容器门禁（全部 `--network none` 隔离运行）。统一入口会只构建一次，所有门禁随后验证同一份只读产物：

```sh
./tools/test-release.sh                 # 全部：发布/原有回归/核心/认证/独立面板
node tests/ui-frontend-static.js        # LuCI 静态与纯函数检查
node tests/mobile-ui-static.js          # 手机版 App 界面（分页/分类/节点/轮询）

# 也可单独运行（默认复用 dist 并校验 SHA256SUMS；--build 显式重建）
./tests/container-validate.sh            # 基础 28
./tests/container-validate-2305.sh       # 23.05 兼容 28
./tests/container-validate-links.sh      # 接入方式 102
./tests/container-validate-nodes.sh      # 子母多节点 75
./tests/container-validate-stations.sh   # AP 站点 93
./tests/container-validate-system.sh     # 软路由性能 78
./tests/container-validate-retention.sh  # 保留策略 93
./tests/container-validate-feishu.sh     # 飞书可配 151
./tests/container-validate-features.sh   # 别名/配额/导出 156
./tests/container-validate-core-fixes.sh # 跨重启/去重/历史/并发 72
./tests/container-validate-security-fixes.sh # 独立凭证/防重放/TLS 87
./tests/container-validate-standalone-panel.sh # 独立面板服务 68（真实 procd + uhttpd + CGI）
./tests/container-validate-release.sh    # 发布物/权限/升级/卸载，23.05+24.10 各110
```

原有回归合计 **804 项断言**，另含核心、安全、独立面板（68 项）、发布与前端专项；实际通过数以本次运行输出为准。真机部署后再跑 `./tests/smoke.sh`（15 项）与 `LUCI_PASS='<密码>' ./tests/ui/run.sh`（页面渲染）。

```sh
./tests/container-validate.sh        # 28 项：包安装、属主权限、系统目录未被改动、守护进程离线用例
./tests/container-validate-nodes.sh  # 75 项：子母多节点（含签名负例、越权、限流、坏文件容错）
```

两条都必须在隔离容器里全绿，才允许上真机（见 `docs/DEPLOY-RULES.md`）。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/SPEC.md` | 数据结构、rpcd 方法、语义约定（totals 口径、confidence 枚举） |
| `docs/AUDIT-REMEDIATION.md` | 审计修复、独立凭证迁移、ACL 与验证边界 |
| `docs/DEPLOY-RULES.md` | 部署流程与打包硬性要求 |
| `docs/INCIDENT-2026-11-14.md` | 事故复盘：包内目录权限导致系统目录被改坏 |
| `docs/IPK-FORMAT.md` | 24.10 的 ipk 是 tar.gz（不是 ar） |
| `docs/AP-ROLE.md` | 为什么哑桥 AP 不参与字节统计 |
| `docs/CALIBRATION.md` | 真机标定手册（offload 与精度取舍） |
| `docs/research-*.md` | 六份调研（采集点、归因路线、飞书接口、打包、业界实践、L2 计数） |


## 飞书机器人（两种方式）

- **自定义机器人（默认）**：群里添加机器人，把 webhook 与签名 secret 填进设置页。
- **应用机器人 · 扫码绑定**：适合多群/换群，不需要复制 webhook。

扫码绑定的准备（飞书开放平台，一次性）：

1. 创建企业自建应用，记下 App ID / App Secret；
2. 添加应用能力「机器人」；
3. 安全设置 → 重定向 URL：`https://<路由器LAN>/cgi-bin/prism-router-feishu?action=callback`
   （若未强制 HTTPS 则用 http）；
4. 权限：`im:message:send_as_bot`、`im:chat:readonly`，然后创建版本并发布；
5. 设置页「发送方式」选「应用机器人（扫码绑定）」→ 填 App ID/Secret →
   点「生成绑定二维码」→ 手机飞书扫码授权 → 选择要绑定的群 → 保存。

机器人必须先被加入目标群；错误会写进 `/tmp/prism-router/feishu.log`（已脱敏）。
