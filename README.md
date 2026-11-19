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
- **家长控制**：按 MAC 在 `inet fw4` 的 `forward` 链上暂停/恢复某台设备上网（默认关闭，必须 `panel.token`；规则持久化、重启重放、审计只留最近 200 行）

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

## Android 原生客户端

`android/` 是一个 Kotlin + Jetpack Compose 原生应用（无 WebView），只读展示面板数据：
概览速率与折线、设备、应用、设置（服务器地址/令牌/刷新间隔）。

构建与安装见 [android/README.md](android/README.md)；本机已用免安装工具链构建出
`android/artifacts/prism-router-android-1.0.0-debug.apk`（包名 `io.prism.router`，
minSdk 26，targetSdk 35，debug 签名，仅内测用）。

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

## 系统信息 / 管理员 API（CGI）

插件在 `/www/cgi-bin/` 安装两个 ucode CGI（0755），由 LuCI 的 uhttpd 直接执行，
和其它 CGI 共用同一个 web 根（不需要新端口、不需要装第二个包）：

### `prism-router-system`：只读、无需登录

适合 Android/Web 客户端首屏、「关于」页与诊断页直接轮询：

| 请求 | 返回 |
|---|---|
| `/cgi-bin/prism-router-system?what=system` | `{"hostname","model","kernel","uptime","load":[1,5,15],"memory":{"total","free","available"},"rootfs":{"total","used","free"},"version"}` |
| `?what=services` | `{"services":[{"name","label","running","pid","info"}]}` |
| `?what=processes` | `{"processes":[{"pid","user","cpu","mem","command"}]}` |
| `?what=version` | `{"version":"1.0.0","build":"1.0.0-1","apk_version":"1.0.0","update_check":false}` |
| `?what=update_check` | `{"configured":true,"repo":"owner/repo","current":"1.0.0","latest":"1.2.3","has_update":true,"published_at","html_url","notes","apk","ipk"}`（未配置 → `{"configured":false,"message"}`） |

```sh
curl -s 'http://<路由器LAN>/cgi-bin/prism-router-system?what=system'
curl -s 'http://<路由器LAN>/cgi-bin/prism-router-system?what=version'
curl -s 'http://<路由器LAN>/cgi-bin/prism-router-system?what=update_check'
```

- **只读且无需 token**：只读 `/proc`、`/proc/net`、opkg control、UCI 和固定命令输出
  （`pidof`/`pgrep`/`netstat`/`df`/`nft`/`curl`），不写配置、不写日志。唯一的写入是
  `?what=update_check` 的成功结果缓存 `/tmp/prism-router/update-cache.json`（0600），
  `cache_seconds=0` 可关闭。
- `memory` / `rootfs` 单位是**字节**；`uptime` 是秒；`load` 是 1/5/15 分钟负载；
  `cpu` 是进程**累计 CPU 时间（秒）**，`mem` 是常驻内存（字节）。
- `processes` 按常驻内存降序取前 20，内核线程（cmdline 为空）已剔除，`command` 截断到 80 字节
  （按 UTF-8 字符边界，不会出现半个汉字）。
- `services` 固定包含 `prism-routerd`、`prism-router-panel`、`crontab`、`dnsmasq`、`firewall`；
  `clash`/`docker` 只在系统里确实装了对应软件时出现。判定用 `pidof`/`pgrep` +
  `/etc/init.d status` + `netstat`（面板端口读 `prism-router.panel.port`，默认 8099），**不用 systemd**。
- `version` 来自 `/usr/lib/opkg/info/luci-app-prism-router.control`（`build` 含 release），
  `apk_version` 优先读 `/etc/prism-router/version`（可选）；`update_check` 表示是否配置了
  `prism-router.update.github_repo`（配置后为 `true`，客户端可显示「检查更新」入口）。
- 只允许 `GET`（其它方法 405），未知 `what` 400，缺省 `what=system`；所有响应带
  `Cache-Control: no-store` + `application/json`。
- 同一份 CGI 也随包安装到独立面板目录（`/www/prism-router-panel/cgi-bin/`），所以启用面板后
  `http://<路由器LAN>:8099/cgi-bin/prism-router-system?what=…` 同样可用；两处行为一致。

#### 自动检测更新（GitHub Releases）

`?what=update_check` 用于提醒**路由器插件本身**有新版本（与 App 版本检查无关），只读、无需登录：

```sh
uci set prism-router.update.github_repo='owner/repo'   # GitHub 仓库，必填
uci set prism-router.update.github_token=''            # 可选：私有仓库或避免匿名限流
uci set prism-router.update.cache_seconds='600'        # 成功结果缓存秒数（0 = 不缓存）
uci commit prism-router
curl -s 'http://<路由器LAN>/cgi-bin/prism-router-system?what=update_check'
curl -s 'http://<路由器LAN>/cgi-bin/prism-router-system?what=update_check&force=1'
```

- 未配置 `github_repo` → `200 {"configured":false,"message":"未配置更新源（uci set …）"}`，
  且**不发任何网络请求**。
- 已配置 → 请求固定 API `https://api.github.com/repos/<owner>/<repo>/releases/latest`
  （`Accept: application/vnd.github+json`、`User-Agent: prism-router`；有 token 时加
  `Authorization: Bearer …`），10 秒超时；系统没有 `curl` 时退回 `wget`。
- 解析 `tag_name`（去掉前缀 `v`）、`published_at`、`html_url`、`body`（`notes` 截断 2000 字节）
  以及 `assets[]` 里的 `.apk`/`.ipk`（返回 `name/url/size`，没有则 `null`），
  与当前插件版本比较得到 `has_update`。
- 失败**不返回 5xx**：`200 {"configured":true,"error":"github_unavailable","detail":"HTTP 403"}`；
  401/404 分别是 `github_unauthorized`/`github_not_found`；网络错误 detail 为
  `timeout`/`network_error`，不包含上游响应体或堆栈。
- 成功结果缓存到 `/tmp/prism-router/update-cache.json`（0600，按 repo + 当前版本区分），
  `cache_seconds` 内直接返回；`force=1` 跳过缓存。
- **安全**：`repo` 必须匹配 `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`（额外拒绝 `.`/`..` 段；非法 →
  `400 {"error":"invalid_repo"}` 且不联网）；只访问 `api.github.com`、不跟随重定向
  （curl `--max-redirs 0`）；`github_token` 不进响应/日志/缓存，走 0600 临时 curl 配置
  （不进命令行；只有无 curl 时的 wget 兜底路径受工具限制）。token 明文存在
  `/etc/config/prism-router`（conffile 默认 0644），建议 `chmod 600` 并使用只读 Releases
  权限的 fine-grained token。

### `prism-router-admin`：登录后的管理接口

同样的 web 根，`POST` JSON 或 `GET` + token：

```sh
# 1) 用路由器的 root 密码换取管理 token（30 分钟有效，同 IP 每分钟最多 5 次尝试）
curl -sS -X POST http://<路由器LAN>/cgi-bin/prism-router-admin \
  -H 'Content-Type: application/json' \
  -d '{"action":"login","username":"root","password":"<密码>"}'
# {"ok":true,"token":"<32 hex>","user":"root","expires":...}

# 2) 用 token 调管理接口（可用 Bearer 头或 ?token=）
curl -sS 'http://<路由器LAN>/cgi-bin/prism-router-admin?action=system&token=<token>'
curl -sS -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"action":"wifi","token":"<token>"}' http://<路由器LAN>/cgi-bin/prism-router-admin

# 3) 读当前软路由配置（只读，GET + token）
curl -sS 'http://<路由器LAN>/cgi-bin/prism-router-admin?action=config&token=<token>'
# {"lan":{"ipaddr":"192.168.100.1","netmask":"255.255.255.0","gateway":"","dns":[...]},
#  "wan":{"proto":"dhcp","device":"eth0","ipaddr":"...","gateway":"...","dns":[...]},
#  "dhcp":{"enabled":true,"start":"100","limit":"150","leasetime":"12h"},
#  "system":{"hostname":"iStoreOS","timezone":"CST-8","zonename":"Asia/Shanghai"},
#  "redirects":[{"index":0,"name":"","src":"lan","dest":"lan","src_dport":"",
#                "dest_ip":"","dest_port":"","proto":"tcp","enabled":true}]}

# 4) 改 LAN 地址（写操作必须 POST + token + confirm 字面量 APPLY）
curl -sS -X POST http://<路由器LAN>/cgi-bin/prism-router-admin \
  -H 'Content-Type: application/json' \
  -d '{"action":"config_set","token":"<token>","section":"lan","confirm":"APPLY",
       "options":{"ipaddr":"192.168.100.2","netmask":"255.255.255.0"}}'
# 200 {"ok":true,"backup":"/etc/prism-router/backup/network.<ts>",
#      "note":"LAN 地址已改，请用新地址重新连接（备份：...）"}
# LAN 地址/掩码真的变了时：先返回 200，再等 1 秒异步 /etc/init.d/network reload，
# 当前 HTTP 连接会断开，客户端要用新地址重连。

# 5) 端口转发（DNAT redirect）
curl -sS -X POST http://<路由器LAN>/cgi-bin/prism-router-admin -H 'Content-Type: application/json' \
  -d '{"action":"redirect_add","token":"<token>","name":"web","src":"lan","dest":"lan",
       "src_dport":"8080","dest_ip":"192.168.100.10","dest_port":"80","proto":"tcp"}'
# 200 {"ok":true,"index":0}
curl -sS -X POST http://<路由器LAN>/cgi-bin/prism-router-admin -H 'Content-Type: application/json' \
  -d '{"action":"redirect_del","token":"<token>","index":0}'
# 200 {"ok":true}

# 6) 回滚某段配置到最近一份备份
curl -sS -X POST http://<路由器LAN>/cgi-bin/prism-router-admin -H 'Content-Type: application/json' \
  -d '{"action":"config_rollback","token":"<token>","section":"lan"}'
# 200 {"ok":true,"backup":"/etc/prism-router/backup/network.<ts>"}；无备份 -> 404 {"error":"no_backup"}
```

- 可用 action：`login`、`logout`、`system`、`network`、`wifi`、`reboot`、`wifi_toggle`、
  `config`（只读）、`config_set`、`redirect_add`、`redirect_del`、`config_rollback`。
- 密码只与 `/etc/shadow` 的哈希比较（`openssl passwd -1/-5/-6` + 相同 salt），不写日志、不进 argv。
- token 存在 `/tmp/prism-router/admin/<token>.json`（0600），重启即失效。
- 写操作（`config_set`/`redirect_add`/`redirect_del`/`config_rollback`）**只接受 POST** 且必须有效
  token：非 POST → 405；token 缺失/过期/格式错 → 401。`reboot` 需 `confirm: "REBOOT"`；
  `wifi_toggle` 的 radio 只接受 `radio0` 形式；`config_set` 的 `confirm` 必须是字面量 `APPLY`。
- `config_set` 的 `section` 只允许 `lan`/`wan`/`dhcp`/`system`，`options` 只允许白名单字段
  （lan: `ipaddr/netmask/gateway/dns`；wan: `proto/device/ipaddr/netmask/gateway/dns`；
  dhcp: `enabled/start/limit/leasetime`；system: `hostname/timezone/zonename`）。
- 校验失败一律 `400 {"error":"invalid_<field>"}`，**不写任何配置、不产生备份**：
  - lan：合法 IPv4 且掩码连续、同网段、不能是网络/广播地址（/31、/32 除外）；gateway 为空或
    与 LAN 同网段；dns ≤3 个合法 IPv4；
  - wan：`proto` ∈ `dhcp|static|none`；static 时 `ipaddr/netmask/gateway/dns` 必填且合法；
  - dhcp：`start` 1–254、`limit` 1–253、`leasetime` 匹配 `^[0-9]+[smhd]$` 或空；
  - system：`hostname` 匹配 `^[A-Za-z0-9][A-Za-z0-9-]{0,62}$`；`zonename` 必须在
    `/usr/share/zoneinfo/<zonename>` 真实存在且不含 `..`；`timezone` 是 `CST-8` 这类 POSIX TZ 串，
    若写成 `Asia/Shanghai` 这种 IANA 形式同样要求 zoneinfo 中存在。
- 每个写操作前备份 `/etc/prism-router/backup/<config>.<ts>`（目录 0700、文件 0600，
  每个 config 保留最近 10 份，超出删最旧；备份失败 → 500 且不写配置）。
  `lan`/`wan` 共用 `network` 备份，`config_rollback` 会整份恢复 `/etc/config/network`。
- 应用方式：lan/wan → `/sbin/network reload`（不存在则 `/etc/init.d/network reload`）；
  dhcp → `/etc/init.d/dnsmasq restart`；system → `uci commit system` + `hostname <新值>` 立即生效；
  redirect 增删 → `/etc/init.d/firewall reload`；**不会重启整机**。
- 所有配置写入只经 ucode 的 `uci` cursor API，不把请求内容拼进 shell；reload 只用固定路径。
- 写操作审计日志追加 `/tmp/prism-router/admin.log`（0600），只记 action/section/结果/IP/备份路径，
  不含密码或 token。
- 所有响应 `Cache-Control: no-store`，错误统一 `{"error":...}`，不返回路径/堆栈/命令输出。
- 同样安装一份到面板目录：启用独立面板后 `http://<路由器LAN>:8099/cgi-bin/prism-router-admin`
  也可用（token/限速/备份逻辑不变）。

## 家长控制（按 MAC 暂停/恢复上网）

只对单台设备生效：在 nftables 的 `inet fw4` **forward 链**上加一条
`ether saddr <MAC> counter drop`，恢复时按 comment 找到 handle 删除。
**默认关闭**，而且必须带令牌；不碰其他表（第三方 `inet UA3F` 完全不受影响），
也绝不执行 `nft flush ruleset` 之类的破坏性命令。

```sh
# 1) 打开写开关并设置令牌（与独立面板共用 panel.token）
uci set prism-router.panel.write_enabled='1'
uci set prism-router.panel.token="$(hexdump -n 24 -e '24/1 "%02x"' /dev/urandom)"
uci commit prism-router

# 2) 暂停某台设备（MAC 大小写/分隔符都行，返回里统一成大写冒号）
curl -sS -X POST http://<路由器LAN>/cgi-bin/prism-router-control \
  -H 'Content-Type: application/json' \
  -d '{"token":"<token>","action":"pause","mac":"aa:bb:cc:dd:ee:ff"}'
# {"ok":true,"already":false,"mac":"AA:BB:CC:DD:EE:FF"}

# 3) 看当前暂停了谁 / 恢复
curl -sS -X POST ... -d '{"token":"<token>","action":"list"}'
# {"ok":true,"paused":[{"mac":"AA:BB:CC:DD:EE:FF","handle":42}]}
curl -sS -X POST ... -d '{"token":"<token>","action":"resume","mac":"AA:BB:CC:DD:EE:FF"}'
```

- 只接受 **POST + application/json（body ≤ 4 KiB）**，GET/HEAD 一律 405。
- `action` 只有 `pause` / `resume` / `list`；`token` 放 body 或 `Authorization: Bearer` 均可。
- 拒绝把 `00:00:00:00:00:00`、广播、多播、以及本机 br-lan 的 MAC 当目标（400 `protected_target`）。
- 暂停列表落在 `/etc/prism-router/paused.json`（0600）：重启后由
  `/etc/init.d/prism-routerd` 调 `prism-router-control apply` 自动重放，
  孩子重启设备/路由器也逃不掉。要真正放开，仍需带 token 的 `resume`（或手动删规则）。
- 审计在 `/etc/prism-router/control.log`（0600，只留最近 200 行，绝不记录 token）。
- 这是**仅限局域网**的明文 HTTP 接口，token 可能被窃听/重放；跨网络请用 TLS/WireGuard。
  没有 `inet fw4`（未装 firewall4）时写操作会返回 500 `nft_failed`。

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

十五套容器门禁（全部 `--network none` 隔离运行）。统一入口会只构建一次，所有门禁随后验证同一份只读产物：

```sh
./tools/test-release.sh                 # 全部：发布/原有回归/核心/认证/独立面板/家长控制
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
./tests/container-validate-standalone-panel.sh # 独立面板服务 + 系统信息/管理员 CGI/配置读写 190（真实 procd + uhttpd + CGI）
./tests/container-validate-feishu-oauth.sh # 飞书应用机器人扫码绑定（OAuth 回调/状态校验）
./tests/container-validate-control.sh    # 家长控制 123（假 nft / 保护目标 / 审计 / 重放）
./tests/container-validate-release.sh    # 发布物/权限/升级/卸载，23.05+24.10 各110
```

原有回归合计 **856 项断言**，另含家长控制（123 项）、核心、安全、独立面板 + 系统信息/管理员 CGI/配置读写/更新检查（224 项）、发布与前端专项；实际通过数以本次运行输出为准。真机部署后再跑 `./tests/smoke.sh`（15 项）与 `LUCI_PASS='<密码>' ./tests/ui/run.sh`（页面渲染）。

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
