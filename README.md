# OpenWrt 流量统计插件

按**设备**与**应用/域名**统计流量，并把**代理链路流量与直连流量分开计算和展示**。
数据源双路互补、互不重复：

- **OpenClash / mihomo `/connections`** → 被代理接管的流量：真实域名、出口节点、每连接字节、源设备
- **`/proc/net/nf_conntrack`** → 未经代理的直连流量（fake-ip 段自动跳过，避免双计）

## 组成

| 包 | 内容 |
|---|---|
| `traffic-stats` | 采集守护进程 `traffic-statsd.uc`、飞书推送 `feishu.uc`、子节点推送 `push.uc`、母节点接收 CGI `traffic-stats-ingest`、init/UCI 配置 |
| `luci-app-traffic-stats` | 5 个界面页（概览/设备/应用/节点/设置）、rpcd 后端、菜单与 ACL |

## 功能

- **按设备**：每台设备的直连/代理流量、实时速率、在线状态、接入方式（无线/有线）、信号强度、首次出现时间
- **按应用**：真实域名（来自 mihomo `/connections`）与出口节点，含类别（视频/社交/游戏/下载/开发/购物/系统）
- **两个正交维度**：代理 vs 直连、无线 vs 有线——各自独立成条，**不可相加**
- **软路由自身性能**：CPU / 内存 / Swap / 负载 / 磁盘 / 温度 / 运行时长 / WAN 上下行速率
- **六类界面**：概览、设备、应用、节点、设置、手机版；另有独立「详细面板」（六标签，铺满整屏）
- **手机版 PWA**：扫码安装到主屏，独立窗口打开，含绑定二维码与安装引导
- **飞书可配**：发什么（7 个区块任选）、什么时候（daily/weekly/both + 时间）、什么条件下（应用超限/突增/离线/CPU/内存/磁盘/免打扰）
- **子母多节点**：HMAC 签名的推送通道，母节点汇总各子节点快照
- **哑桥 AP 信号**：只上报无线元数据（不含字节，避免双计）
- **数据治理**：保留策略（daily/nodes/stations/日志/队列，带 dry-run）、CSV 导出、Prometheus 指标
- **设备管理**：别名、分组、月配额与剩余量、陌生设备标记与阻断命令生成

## 安装

```sh
# 23.05 / 24.10 都用 .ipk（tar.gz 格式）；.legacy.ipk 仅极旧版本备用且未验证
opkg install traffic-stats_1.0.0-1_all.ipk
opkg install luci-app-traffic-stats_1.0.0-1_all.ipk
/etc/init.d/traffic-statsd enable
/etc/init.d/traffic-statsd start
/etc/init.d/rpcd reload; rm -f /tmp/luci-indexcache*
```

依赖：`ucode`、`ucode-mod-{fs,uci,uloop}`、`curl`；飞书/子母签名需 `openssl-util`。

界面：LuCI → 服务 → 流量统计。

## 配置（UCI `traffic-stats`）

```sh
uci set traffic-stats.settings.poll_interval='5'      # 采集间隔（秒）
uci set traffic-stats.settings.clash_api='127.0.0.1:9090'
uci set traffic-stats.settings.clash_secret=''        # 留空=自动读 openclash.config.dashboard_password
uci set traffic-stats.settings.fake_ip_ranges='198.18.0.0/16'
uci commit traffic-stats
```

## 飞书

两条路线，配了哪条走哪条：

```sh
# A. 自建应用机器人（二维码加群）
uci set traffic-stats.feishu.app_id='cli_xxx'
uci set traffic-stats.feishu.app_secret='xxx'
ucode /usr/share/traffic-stats/feishu.uc chats      # 列出机器人所在群，拿到 chat_id
uci set traffic-stats.feishu.chat_id='oc_xxx'

# B. 群自定义机器人 webhook
uci set traffic-stats.feishu.webhook='https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
uci set traffic-stats.feishu.secret='xxx'

uci set traffic-stats.feishu.enabled='1'            # 总开关（默认已是 1；设 0 可静音）
uci commit traffic-stats
ucode /usr/share/traffic-stats/feishu.uc test       # 连通性测试
```

定时（自行添加，包不改 crontab）：

```
32 8 * * *    ucode /usr/share/traffic-stats/feishu.uc daily
*/10 * * * *  ucode /usr/share/traffic-stats/feishu.uc alerts
```

## 子母多节点

母节点（接收端）：

```sh
uci set traffic-stats.settings.node_name='主路由'
uci set traffic-stats.settings.mother_secret="$(openssl rand -hex 16)"
uci commit traffic-stats
```

子节点（发送端，需 `openssl-util`）：

```sh
uci set traffic-stats.settings.mother_enabled='1'
uci set traffic-stats.settings.mother_url='http://192.168.100.1'
uci set traffic-stats.settings.mother_secret='<母节点那个密钥>'
uci set traffic-stats.settings.node_name='子节点-客厅'
uci commit traffic-stats
ucode /usr/share/traffic-stats/push.uc && echo ok
# cron: * * * * * ucode /usr/share/traffic-stats/push.uc >/dev/null 2>&1
```

界面「节点」页展示各节点最后上报时间、总流量、代理/直连、设备数；超 5 分钟未更新标黄。

## 部署前验证（强制）

九套容器门禁（全部 `--network none` 隔离运行）：

```sh
./tests/container-validate.sh            # 基础 28
./tests/container-validate-2305.sh       # 23.05 兼容 28
./tests/container-validate-links.sh      # 接入方式 102
./tests/container-validate-nodes.sh      # 子母多节点 75
./tests/container-validate-stations.sh   # AP 站点 93
./tests/container-validate-system.sh     # 软路由性能 78
./tests/container-validate-retention.sh  # 保留策略 93
./tests/container-validate-feishu.sh     # 飞书可配 151
./tests/container-validate-features.sh   # 别名/配额/导出 156
```

合计 **804 项断言**。真机部署后再跑 `./tests/smoke.sh`（15 项）与 `Luci 密码=... ./tests/ui/run.sh`（6 页渲染）。

```sh
./tests/container-validate.sh        # 28 项：包安装、属主权限、系统目录未被改动、守护进程离线用例
./tests/container-validate-nodes.sh  # 75 项：子母多节点（含签名负例、越权、限流、坏文件容错）
```

两条都必须在隔离容器里全绿，才允许上真机（见 `docs/DEPLOY-RULES.md`）。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/SPEC.md` | 数据结构、rpcd 方法、语义约定（totals 口径、confidence 枚举） |
| `docs/DEPLOY-RULES.md` | 部署流程与打包硬性要求 |
| `docs/INCIDENT-2026-11-14.md` | 事故复盘：包内目录权限导致系统目录被改坏 |
| `docs/IPK-FORMAT.md` | 24.10 的 ipk 是 tar.gz（不是 ar） |
| `docs/AP-ROLE.md` | 为什么哑桥 AP 不参与字节统计 |
| `docs/CALIBRATION.md` | 真机标定手册（offload 与精度取舍） |
| `docs/research-*.md` | 六份调研（采集点、归因路线、飞书接口、打包、业界实践、L2 计数） |
