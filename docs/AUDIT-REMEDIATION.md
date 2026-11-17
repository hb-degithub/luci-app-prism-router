# 审计修复与架构调整

## 范围

本轮针对独立审计确认的问题修复：跨软重启日累计与连接基线、Clash/conntrack 双源去重、历史接口消息预算、月总账、设备元数据并发写入、节点/AP 独立认证、LuCI 配额/别名/导出、发布物完整性与依赖门禁。

仍使用 ucode + ash + curl，不引入 C 编译，不把容器的 mock 结果当成真机精度证明。

## 核心记账

- `totals` 仍是当前进程生命周期累计；当日/月度数据看 daily。
- 守护进程原子保存 `/tmp/traffic-stats/baseline.json`，启动恢复当天的 daily 与有效连接基线；已有 daily 但基线损坏/丢失/过期时首轮只采样，防止整段历史连接重算。
- 去重覆盖 fake-ip 和 Clash 活跃连接元数据，含 DIRECT；Clash 中断时按真实续期时间保留去重键，TTL 覆盖请求超时与下一次调度；恢复仍使用旧计数器做差。接入维度与代理维度仍分别满足恒等式。
- 基线 v3 记录被上限截断的条数、去重键与故障期已记账连接；未覆盖的连接在恢复首轮只采样。日切失败快照也持久化到 tmpfs，进程重启后可继续重试。
- daily 的 300 秒节流意味着崩溃/断电仍可能丢最近一段增量。基线不是完整流量日志，不能补齐停机窗口；`/tmp` 清空、基线过期、故障期间重启等场景选择少计而不是双计。
- `get_history` 只投影每日 totals 与轻量桶，按 180 KiB 预算裁剪并标记；`get_daily` 保留完整数据接口。

## 节点/AP 迁移

新部署默认按节点注册独立凭证：

```sh
uci add traffic-stats node
uci set traffic-stats.@node[-1].node_id='node-a'
uci set traffic-stats.@node[-1].secret='<随机密钥>'
```

AP 使用匿名 `config station` + `node_id/token`。`node_id` 含 `-` 时不能用作 UCI section 名。

v2 加入 nonce，母节点拒绝重放、未知节点和错误节点密钥。凭证不再放 URL，也不进入 OpenSSL 命令行；curl 使用最小权限配置，HTTPS 默认校验证书。

旧版全局 `mother_secret` 或 `stations_token` 只在显式 `legacy_shared_secret=1` / `legacy_stations_token=1` 下临时兼容；该模式不具节点隔离，迁移后必须关闭。新增 CA/pin 选项见默认配置注释。

## ACL

`luci-app-traffic-stats` 是面板读取权限；`luci-app-traffic-stats-admin` 才含 UCI 与配置写入。需要管理页面的账号应同时授予两组，以满足根菜单与管理员子页的 ACL 依赖；**当前写操作还要求 root 身份**，非 root 管理组只能获得路由与 UCI 访问，后端会拒绝写调用。前端通过只读 `status.can_manage` 能力位隐藏无权限控件，不读取配置密钥。

## 手机版界面

`mobile.js` 重做为五屏 App 风格：概览（上传/下载大号速率、出口节点卡片与 Clash 连接数角标、终端数胶囊）、设备（主网络/访客/离线分段、筛选排序、展开应用分布）、节点（AP/子节点卡片与详情）、拓扑（纵向五层：互联网 → 出口 → 主路由 → AP → 设备）、安装（PWA 与二维码）。数据只来自 `get_state`、只读的 `get_nodes` 与 `get_stations`，切屏和筛选不发 RPC；陈旧 `state` 会用真实时间重新判定在线并提示未更新。

独立面板服务（`/etc/init.d/traffic-panel` + `/www/traffic-panel/`）：procd 启动独立 uhttpd 实例，默认关闭；`panel.enabled/port/bind/token` 可配，`bind` 留空自动绑定 `network.lan.ipaddr`；CGI 只读白名单 `state/history/nodes/stations/status`，token 校验先于参数校验，异常统一 500 不泄漏细节。开启方式见 README。

详细面板（`panel.js`）新增横向「拓扑」标签：出口按流量取前 6 张卡、AP 上报 5 分钟内算在线、设备按接入方式分组最多 8 台；`get_stations` 失败只降级 AP 层。手机版与面板都不保存节点密钥，也不新增写接口。

拓扑下钻：出口卡按其 apps 中的 chain 归集在线设备（DIRECT 大小写不敏感），AP 卡按 `stations` 的 `node_id` + MAC 归集在线无线设备，各最多 8 台并可再次点击收起。`get_nodes` / `get_stations` 改为按需加载：首屏只取 `state`，首次进入节点/拓扑时补拉一次，轮询只在对应界面激活时刷新。手机版设备屏另有名称/MAC/IP 搜索，与分类、接入筛选和排序叠加。

## 发布验证

```sh
./tools/test-release.sh
node tests/ui-frontend-static.js
node tests/mobile-ui-static.js
```

构建一次后，所有门禁验证同一份带 `SHA256SUMS` 的 dist 快照；单独运行某个门禁默认只复用产物，`--build` 才显式重建。发布门禁检查依赖、权限、payload 与源码一致、重装/卸载和 legacy 负例。

本地容器验证不能代替真实 Clash/conntrack/offload、真实浏览器、PWA 或飞书端到端验证；未经用户另行确认，不进行真机部署。
