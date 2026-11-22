# 安全、远程访问与通知后台检测

日期：2026-11-22。范围：当前未提交源码的 LuCI、独立 8099 面板、管理员/系统/控制 CGI、Android 客户端与飞书通知。检测使用源码审计、OpenWrt 24.10 隔离容器和本地固定假数据；**未开启隧道、未扫描真实网络、未读取真实凭据、未向真实飞书群发送消息**。

## 结论

当前版本的独立面板默认关闭，适合仅在受控 LAN 或私有 overlay 网络中使用。**不建议把 8099 或 LuCI 管理端口直接通过 FRP、Cloudflare Tunnel、ngrok 或端口映射暴露到公网**：面板 token 只保护 `panel-api`，同端口另有匿名系统信息与 root 密码登录的管理 API；这些 system/admin CGI 还安装到 LuCI 默认 `/www/cgi-bin`，**关闭 8099 并不能消除它们**。已有认证、防重放、家长控制与飞书测试通过，不等于整体远程暴露安全。

Android 本地通知不是远程推送；没有 FCM、WorkManager、前台服务、开机启动或独立后台进程。退后台后可能短期继续轮询，但进程死亡后没有任务可拉取数据或发通知。飞书由路由器出站 HTTPS 发送，可在手机离线时工作，但需要用户配置 cron 与测试群。

## 已执行证据

| 检测 | 结果与边界 |
|---|---|
| 独立面板完整临时构建容器门禁 | 237/237：默认关闭、认证、只读白名单、安全响应、能力投影等 |
| 节点/AP 认证与密钥门禁 | 135/135：独立密钥、nonce 防重放、body 限长、HMAC 不进 argv、TLS CA 校验、跨源重定向不泄密 |
| 家长控制门禁 | 123/123：默认拒绝、token、MAC/保护目标、审计、假 nft 命令约束 |
| 飞书通知门禁 | 151/151：调度、告警、免打扰、重试队列、本地 mock 投递；不是实际飞书投递 |
| Android JVM 测试 | 87/87，其中新增 AlertsNotifier 去重/告警组合 12 项；不是设备后台保活证明 |
| Android 35 软件模拟器 | 本地假面板：API 33 权限弹窗与授权、IMPORTANCE_DEFAULT 渠道、24h 去重、4 告警仅保留 3 条、HOME 后继续轮询、进程死后无轮询/Job/Alarm/Service；UI 点击与长时 Doze 未验 |
| 管理员串行限速 | 五条当前失败记录后第 6 次固定无效登录返回 429 |
| 管理员并发限速 | 同源 16 个并发固定无效登录：9 个返回 400 进入验密，7 个 429；若严格串行 5/min，应 11 个被限流，证实并发窗口 |
| 匿名系统 CGI | 隔离 CGI `what=processes`、`what=version` 无凭据均返回 200 |

安全门禁通过的项目是有效的局部防护，不能抵消下面的架构风险。

## 分级发现

### 高：穿透面板或 LuCI Web 根会暴露管理面与匿名系统面

- 实际 IPK 构建把 `prism-router-system`、`prism-router-admin` 和 `prism-router-control` 放进面板 `cgi-bin`，见 `tools/build-ipk.sh:167-182`；OpenWrt Makefile 同样安装这些副本。
- 同一 system/admin/control 还安装到 LuCI 默认 `/www/cgi-bin`，不依赖 `panel.enabled`；因此关闭独立面板只关闭 8099 副本，并不移除 LuCI Web 根下的匿名 system 与管理登录面。
- `panel-api` token 不保护 system/admin；system 无需登录，见 `root/www/cgi-bin/prism-router-system:912-924`。
- admin 使用 root `/etc/shadow` 密码换取 30 分钟管理 token，可做网络/DHCP/端口转发修改、重启等，见 `prism-router-admin:223-245`、`:1247-1265`。
- `panel.bind` 缺失或非法会回退所有接口，见 `root/etc/init.d/prism-router-panel:112-126`。默认 panel 虽关闭，但开启时必须显式固定 bind、防火墙和认证。

整改：拆分只读远程入口与管理面，覆盖 8099 与 `/www/cgi-bin` 两处副本；移除不需要的副本或给 system/admin 增加认证，并在反代 deny；bind 失败应拒绝启动；远程写操作默认保持 `write_enabled=0`。不得仅靠关闭面板或设置 `panel.token` 认为管理面已消失。

### 中高：管理员登录限速可并发绕过，反代后按 IP 限速也会失真

`rate_check` 与 `rate_hit` 分离且无锁，见 `prism-router-admin:115-134`、`:228-234`。上述 16 并发测试已复现窗口。反向代理/本机隧道又可能让多个用户共享 `REMOTE_ADDR`，造成全局限速锁死或审计无法归因；不能盲目信任可伪造的 X-Forwarded-For。

整改：原子/加锁计数，在验密前记账，增加全局并发上限和递增延迟；在受信反代层限速并安全传递客户端身份。公网暴露前必须整改。

### 中：匿名系统信息与强制更新检查

`system?what=processes` 返回 Top 20 的 pid、user、command；服务/版本/监听地址也有匿名投影。`update_check&force=1` 可绕缓存发起固定 GitHub 外联，见 `prism-router-system:495-529`。如果第三方进程在 argv 中放秘密，进程列表可能扩大泄露。

整改：远程入口 deny system；至少对 processes/services/update_check 要求认证和限频，进程命令仅返回必要的 basename。

### 中：明文 HTTP 与 URL token 在穿透链路中扩大暴露

- 独立 uhttpd 只配置 HTTP；Android `usesCleartextTraffic=true`，见 `AndroidManifest.xml:9-16`。
- Android `PanelClient.kt:192-200`、Web `app.js:303-307`、admin GET 使用 URL token。
- App 自身日志已移除 query；浏览器引导后用 `replaceState` 清地址栏，并有 no-referrer，这些是有效缓解。
- 但反向代理/隧道访问日志、非加密中间链路仍可能看到完整 URL。panel token 同时是家长控制凭据，admin token 是短期管理凭据。

整改：优先 Tailscale/WireGuard 等加密私有网络；必须公网入口时使用 TLS+mTLS/IdP Access。客户端 GET 改 `Authorization: Bearer`，仅保留一次性安全引导，读写凭据分离。

### 中低：配置读取异常可能让面板认证失败开放

`panel-api:210-222` 的 UCI 读取异常返回空 token，而空 token 表示放行。配置完全损坏的隔离测试返回 500，并非所有异常都会放行；但游标/单项读取异常仍有失败开放路径。

整改：区分“明确未配置 token”和“配置读取失败”，后者 fail-closed 为 401/503，不能当作未配置。

### 中低：Android 凭据与备份、管理员会话

- 服务器列表/token 为普通 Preferences DataStore，Manifest `allowBackup=true`；没有 Android Keystore/EncryptedSharedPreferences。
- admin 的 username 可指定任意 shadow 账户，成功后权限不按用户区分；token 不随改密失效。登录密码会短暂写入 0600 临时文件，异常退出可能残留。

整改：按 Android 备份规则排除凭据，使用 Keystore 保护；admin 仅允许 root、改密撤销 token、避免明文临时密码文件。

## 推荐的远程访问方式

1. **优先：Tailscale ACL 或自建 WireGuard。** 只把指定手机/用户接入路由器 LAN/8099；路由器 WAN 防火墙仍拒绝 8099。显式配置 `panel.bind` 为受控 LAN/overlay 地址，设置高强度随机 panel token，关闭 `write_enabled`。
2. 不要把 LuCI 80/443、SSH 或完整路由器管理端口一起映射。只读远程需求只开放静态面板和 `panel-api`，显式 deny `prism-router-admin/system/control`。
3. **必须公网 HTTPS 时：** Cloudflare Tunnel 必须同时配置 Access 身份认证和路径白名单；裸 Tunnel 不是认证。自建反代需 TLS、客户端证书/IdP、URL 脱敏日志、请求体/连接/频率限制。FRP/ngrok 裸端口映射不建议。
4. 目前 Android 网络配置/网络管理依赖 system/admin；若在远程入口禁用它们，App 应明确降级为只读，不能用放开管理面换取功能完整。

## 通知与后台存活

| 场景 | 当前能力与结论 |
|---|---|
| Android 前台、已授权通知 | 轮询后由 `AlertsNotifier` 发本地 warn/danger 通知；24h key 去重、最多 3 条；`contentIntent` 指向 MainActivity 为代码与系统记录证据，未实际 tap |
| Android 13+ | Manifest 有 POST_NOTIFICATIONS，首次请求一次；授权路径已实测，拒绝后只问一次为代码路径，未做拒绝端到端实测 |
| 锁屏/退后台但进程存活 | 软件模拟器 HOME 后假面板仍连续收到轮询；锁屏只验证 PRIVATE/NO_OVERRIDE 属性，未做安全锁屏视觉验收。进程存活时继续，但不是可靠后台 SLA |
| 强制停止、进程被杀、手机重启 | 模拟器进程死亡后停止轮询，JobScheduler/Alarm/Service 均无 prism 项；没有应用自建 Worker/BOOT receiver/FCM（库有无关 ProfileInstallReceiver），不能自行恢复。手机重启未实测 |
| 飞书 | 路由器出站 HTTPS，可独立于手机工作；离线 mock 通过，但需 cron、有效 webhook/app 与真实网络 |

推荐远程重要告警优先走飞书。若未来需要 App 后台刷新，采用 WorkManager 的周期约束与系统限制说明，前台服务仅用于用户可见的持续任务，并遵守 Android 14+ 的前台服务类型/权限要求；不要用“忽略电池优化”作为通用保活方案。

## 真机验收矩阵（待用户授权环境）

1. 私有 overlay 仅允许测试设备到 8099，其它 overlay 节点和 WAN 均应不可达；验证 bind 异常不会扩大监听。
2. 无 token、错 token、正确 Bearer 的 panel-api 分别为 401/401/200；system/admin/control 在远程入口必须不可达。
3. TLS 证书链、主机名、失效/自签证书均按预期失败；检查反代访问日志不包含 token/query。
4. 反代来源地址下验证登录限速与审计；并发 16 次应在修复后按全局与每客户端策略限流。
5. Android 前台→Home→锁屏 5/30 分钟→Doze→强制停止→重启，分别记录进程、轮询日志、通知和手动恢复；不能承诺国产 ROM 与 AOSP 行为相同。
6. 飞书真实测试群：手动 test、cron scheduled、alerts、断网重试；手机飞行模式时仍应收到路由器已发出的消息。

当前不能宣称“穿透链路已实测安全”或“App 后台保活通过”，需要上述真实环境结果。
