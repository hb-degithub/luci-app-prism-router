# OpenWrt 流量统计插件 · 方案设计 v1.2

> 状态：**待用户确认**（确认后进入 P0 实现）
> 依据：`docs/research-traffic-capture.md`、`docs/research-feishu-api.md`、`docs/research-openwrt-packaging.md`、`docs/research-industry-approaches.md`、`docs/research-app-identification.md`、`docs/research-l2-counters.md`、`docs/REVIEW-alternatives.md`（均带出处，2026-11）
> v1.1 变更：四桶归因口径、`accounting_confidence` 状态位、SNI 提升为 full 档默认、存储改为分文件+小时落盘、告警阈值改为 C+D>10%、P4 增加 QUIC/SAN/ASN/代理元数据、补入实时速率与月配额等日常功能。
> v1.2 变更：新增 `hybrid` 策略（WiFi station 计数作为抗卸载的逐设备总量源）、纠正"无线不会被卸载"与"traffic-survey 可回灌"两处误解、端口 MIB 明确排除、风险表补充口径混用。
> 本文所有数字若标"估算"，表示按结构推导、未在真机实测。

---

## 0. 已确认的产品边界

| 需求 | 决策 |
|---|---|
| 每设备流量统计 | ✅ 做，以 `MAC` 为主身份，`IP` 为辅 |
| 每设备 × 每应用/网站 | ✅ 做，域名级归因（DNS 为主 + SNI 可选） |
| 多台 OpenWrt 共享数据 | ✅ 做，子→母 出站 push，母节点由一台路由器兼任 |
| 子母插件控制 | ✅ 做，母下发配置/规则/报表计划，子拉取执行 |
| 飞书日报/周报/告警 | ✅ 做，群自定义机器人 Webhook + 卡片 2.0 |
| 硬件适配 | ✅ 双档自适应：`lite`（<256MB RAM/小 flash）、`full`（≥256MB） |

**明确不做**（写清楚是为了避免范围蔓延）：
- 不做全流量 DPI（netifyd 要求 ≥256MB、3.8MB 包体，128MB 机型出局）
- 不做跨公网穿透（用户环境为同一局域网/多网段；母地址可配，出站设计保留将来替换传输层的空间）
- 不做逐包抓包统计（softflowd/libpcap 路线在 MT7621 上代价高一档）
- 不做网站内容分类（只到域名/应用名，不做"游戏/购物"语义分类，除非命中规则库）

---

## 1. 架构总览

```
┌─ 每台 OpenWrt（standalone 或 child 角色）───────────────────────┐
│                                                                │
│  LuCI JS 页面 ──rpc.declare──▶ rpcd ──▶ ucode 后端 (traffic-stats.uc) │
│                                        │                       │
│                                        ▼                       │
│  traffic-statsd (C 守护进程, procd)  ◀── ubus 查询 API          │
│    ├─ L1 采集：ctnetlink 事件 + 30s 快照                        │
│    ├─ L2 归因：DNS 嗅探 / SNI(可选) / 应用规则库                │
│    ├─ L3 聚合：1m(RAM) → 5m → 1h → 1d                          │
│    └─ 存储：RAM 环形桶 + SQLite(WAL) 聚合落盘                   │
│                                                                │
│  ucode 任务（cron/procd）                                       │
│    ├─ push.uc   ：批量上报母节点（spool 重试）                  │
│    ├─ alert.uc  ：本地阈值告警                                  │
│    └─ feishu.uc ：签名 + 卡片 + 错误码处理                      │
└───────────────────────────┬────────────────────────────────────┘
                            │ POST /api/v1/ingest (gzip + HMAC)
                            │ GET  /api/v1/config  (60s 轮询)
                            ▼
┌─ 母节点（其中一台路由器，master 角色）─────────────────────────┐
│  traffic-statsd 内置 HTTP API（LAN 绑定）                      │
│  汇总库 SQLite(WAL)：node_id 维度                              │
│  report.uc  ：日/周报 → 飞书卡片（chart + table）              │
│  alert.uc   ：跨节点规则、去重静默、恢复通知                    │
│  nodes.uc   ：配对注册、令牌、配置版本、心跳                    │
└────────────────────────────────────────────────────────────────┘
```

**为什么不用 MQTT**：子母都在同一局域网，HTTPS 批量 push 已足够；少一个 broker、少一个常驻进程、少一份内存。协议层留了 `transport` 配置项，将来要跨公网时换成 MQTT 或 WG 不必改数据模型。

---

## 2. 采集层（L1）

### 2.1 取数机制

- 数据源：内核 `nf_conntrack_acct`（OpenWrt 默认通过 `/etc/sysctl.d/11-nf-conntrack.conf` 打开；**主内核默认为关，必须启动时校验**）。
- 通道：`AF_NETLINK` / `NETLINK_NETFILTER`，订阅 `NFNLGRP_CONNTRACK_NEW|UPDATE|DESTROY`，配合 30 秒全量快照 + 计数器读取清零，用于把长连接归到正确的时间桶。
- **不依赖 nlbwmon**：nlbwmon 的 `database.h` 记录结构里没有目的地址（只有 `family/proto/dst_port/src_mac/src_addr`），从原理上给不了 per-app；且两个 ctnetlink 读取者会互相干扰计数。nlbwmon 仅作为可选的交叉校验工具（诊断页展示两者差值）。

### 2.2 三个必须自检的坑

| 坑 | 后果 | 我们的对策 |
|---|---|---|
| **flow offloading 开启**（软/硬） | offload 流不再更新 conntrack → 总量偏小甚至为 0 | 启动检测 `firewall.@defaults[0].flow_offloading` 与 `flow_offloading_hw`；非 0 时：① 诊断页红色告警；② 配置项 `strict_accounting=1`（默认）自动改 UCI 关闭并 reload firewall；③ 用户也可选择"保留 offload、接受偏低"并把 UI 标注为"估算值" |
| **netlink `rmem_max` 不足** | `setsockopt` 被内核静默截断 → 周期性 `ENOBUFS`，进程不退出但静默少算 | 启动读 `net.core.rmem_max`，把请求值 clamp 到其下并记录实际生效值；偏差 >20% 时打警告并写诊断项 |
| **`nf_conntrack_acct=0`** | 计数器永远为 0 | 启动校验，为 0 时写 sysctl 并重试，失败则拒绝启动（宁可不启动也不产出假数据） |

### 2.2.1 对账自检（比检测配置开关更可靠）

只看 `flow_offloading` 标志位是不够的：漏算还可能来自 rmem 丢事件、fullcone 吞事件、conntrack 表满、驱动特殊行为。所以要有一个**不依赖假设**的对照：

> 每 5 分钟对比 `Σ(所有设备上下行字节)` 与 `wan 接口计数器增量`（扣掉路由器自身发起的流量）。
> 两者应接近；比值低于阈值（默认 90%）就在诊断页显示"记账完整度"，并在连续 3 个周期不达标时产出一次 `accounting_degraded` 告警。

这是一个廉价但非常有效的自检：它能把"静默少算"变成"可观测的指标"，而不是让用户看一个漂亮但错误的图。

**横向调研确认这是一个真实空白**：13 个同类产品/项目里，**没有任何一家把"接口总量 vs 逐设备汇总"做成产品指标**。最接近的只有 RouterOS Traffic Flow 的 `unmanaged-packets/bytes`（认不出的包单独计数）和 LibreQoS 的 unknown-IP 类目。

配套要有一个给用户看的状态位：

```
accounting_confidence = exact | degraded | unknown
```
- `exact`：自检通过，对账比值 ≥ 95%；
- `degraded`：比值 70–95%，或检测到 offload/rmem/conntrack 表满等具体原因 → **必须同时给出原因**（"hw offload 生效" / "sw flow offloading 生效" / "rmem 不足丢事件" / "conntrack 表满"）；
- `unknown`：比值 < 70%，采集可能已经失效。

这个状态要出现在**概览页顶部**和**每份日报的表头**。调研里 MikroTik 的反面案例是"功能留着、文档写了、产品不拦"，结果是用户永远不知道自己的数字是错的——我们不能那样。

### 2.2.2 真机标定（P0 必做一次）

在本机跑三步，用已知大小的流量对照统计取值：

| 步骤 | 操作 | 期望结果 |
|---|---|---|
| 1 | 关闭 `flow_offloading` 与 `flow_offloading_hw`，下载一个 1 GB 文件 | 统计增量误差 < 2%（含 TCP 重传则略高） |
| 2 | 只开 `flow_offloading 1`，重复 | 统计只增加几 MB → 量化误差倍数 |
| 3 | 再开 `flow_offloading_hw 1`，重复 | 统计可能几乎不增长 |

同时记录三种状态下的 `iperf3` 吞吐，得到"这台机器上精度换速度"的真实代价。**这个数字决定默认策略**，而不是靠拍脑袋。

→ **可直接照做的手册见 `docs/CALIBRATION.md`**（含采集脚本、判读规则、结果回填模板、恢复现场的步骤）。

### 2.2.3 L2 计数器：第三个选项（它确实存在，但没想象中好用）

三个补充数据源，**口径不同，不能相加**：

| 源 | 口径 | OpenWrt 24.10 可用性 | 抗卸载 | 用途 |
|---|---|---|---|---|
| **WiFi per-station**（`iw dev <if> station dump`，mac80211 维护） | MAC 层字节（含 802.11 帧头与重传） | ✅ 零改动可用 | ✅ 由硬件 WCID 计数兜底 | 无线设备的**总量** |
| **交换机端口 MIB**（mt7530 有 64 位 TX/RX 字节寄存器 `0x48`/`0xa8`） | 端口字节 | ❌ **驱动没暴露**：`mt7530_mib[]` 只收了 9 个丢包/错误计数，`ethtool -S` 拿不到；映射到 `OctetsTransmittedOK` 的函数只在 master 分支 | ✅ | 有线设备总量（需回移补丁，**不列入首版**） |
| **`ppe0/{entries,bind}`**（MTK PPE 硬件计数） | 五元组流 | ⚠️ `has_accounting` 仅 **mt7622/7629/7981/7986/7988** 为真；**mt7621/mt7623 为假** | ✅ | 逐流校验 / 回灌（P4） |

**纠正两个常见误解**：

1. **"无线不会被卸载，所以 station 计数天然安全"是错的**。MT7986/MT7915 的 **WED**（Wireless Ethernet Dispatch）会把 WiFi↔以太网直通也卸载到硬件，同样绕过网络栈。station 计数之所以仍然准，是因为**驱动在 WED 激活时改用 WCID 硬件计数覆盖** `tx_bytes/rx_bytes`（`mt7915_sta_statistics()` 的注释明说这点）。抗卸载性来自"计数取自硬件"，不是来自"无线不可卸载"。
2. **`luci-app-traffic-survey` 不是读 `ppe0/bind`**。它是写 `/sys/kernel/debug/hnat/hnat_setting` 打开**厂商 hnat 模块**的 PPE→conntrack 回灌，再走 ctnetlink。而 mainline 内核**没有 hnat 节点**（`mtk_eth_soc.c` 里 0 次出现），那是厂商/第三方 out-of-tree 模块。**所以"MT7981 可以靠它回灌"这条在官方 24.10 上不成立**，官方固件能用的只有 `ppe0/{entries,bind}`。

**由此得到第三种策略**（原先只有"关加速"和"接受不准"两种）：

| 策略 | 无线总量 | 有线总量 | 应用维度 | NAT 吞吐 |
|---|---|---|---|---|
| `strict`（默认） | ✅ 准 | ✅ 准 | ✅ 准（DNS+SNI） | 降 |
| `hybrid`（新增） | ✅ 准（station 计数） | ⚠️ 低估 | ⚠️ 字节不可归因，退化为"按 DNS 请求数占比估算"并明确标注 | 满速 |
| `performance` | ⚠️ 低估 | ⚠️ 低估 | ⚠️ 估算 | 满速 |

`hybrid` 的价值在于：家庭里绝大多数设备是无线连接的，而**开着硬件加速还能拿到无线设备的准确总量**，比"全准但降速"或"全不准"都更实用。代价是口径混用（无线是 MAC 层、有线是 IP 层），UI 必须标明每条数据来自哪个源。
- `kmod-nft-fullcone`（全锥 NAT）有第三方报告称会导致收不到 conntrack 事件 → 检测到就提示"若统计恒为空请尝试关闭全锥 NAT"。
- MT7621/7622 的 PPE **无 per-flow accounting**（第三方结论，待实测）；MT7981/7986/7988 可回灌 → 诊断页按 SoC 给出"硬件卸载下可信度"提示。

### 2.3 双档能力矩阵

| 能力 | lite（<256MB / 小 flash） | full（≥256MB） |
|---|---|---|
| conntrack 采集 | ✅ | ✅ |
| DNS 归因 | ✅ | ✅ |
| DoH 端点标记 | ✅ | ✅ |
| SNI 嗅探 | ⚙️ 可选，限速版（≤200 pps） | ✅ 默认开 |
| ASN 兜底 | ✅ Top-50~200 前缀集（0.3–0.5MB） | ✅ iptoasn 全库（9.4MB） |
| QUIC Initial 解密 | ❌ | ⚙️ P4 可选 |
| 1 分钟桶保留 | 60 分钟（RAM） | 2 小时（RAM） |
| 5 分钟桶落盘 | ❌ 只落 1h/1d | ✅ 7 天 |
| 内存预算（常驻） | 目标 < 6 MB | 目标 < 20 MB |

---

## 3. 归因层（L2）

### 3.1 三级策略

| 级 | 手段 | 默认 | 成本 | 失效条件 |
|---|---|---|---|---|
| L0 | **DoH/DoT 端点标记**：识别已知加密 DNS 端点（专用 anycast，**不能用 Cloudflare 全段 `/13`**） | 开 | ≈0 | 共享 IP 上会误判 |
| L1 | **被动 DNS 嗅探**：`AF_PACKET` + BPF 过滤 `udp port 53`，解析 question A/AAAA + 应答，维护 `domain ↔ IP` 带 TTL 映射 | 开 | 极低（家庭场景约 20 QPS） | 客户端用 DoH/DoT；HTTPDNS；DNS 走非 53 端口 |
| L2 | **TLS SNI**：每流只看首个含 payload 的包，解析 ClientHello | **full 档默认开**；lite 可选（限速） | 中，需限速 | ECH；非 TLS |
| L3 | **域名 → 应用规则库**：`*.douyin.com → 抖音`，内置 + 自定义 + 母节点下发 | 开 | 零 | 规则未覆盖 |
| L4 | **ASN 兜底**：目的 IP → ASN，至少归到"哪家公司" | lite 用 Top-50~200 前缀集（≈0.3–0.5MB）；full 用 iptoasn 全库（9.4MB，PDDL 公有领域） | 低 | 只到公司，不到应用 |

**为什么把 SNI 提到 full 档默认开**：调研量化后，仅做 DNS 时域名级归因只有 **59.5%**（另有 24.3% 只能到 ASN）；加上 SNI 可拉到 **90% 左右**（估算）。SNI 是性价比最高的一档，不是可选装饰。

> **为什么改成"被动嗅探"而不是"读 dnsmasq 日志"**：dnsmasq 的 `log-facility` 一旦改指向文件，会把**全部** dnsmasq 日志从 syslog 挪走（对用户是侵入式改动）；而走 syslog 则受 `logread` 64KB 缓冲限制，突发时会丢行。被动嗅探不改用户任何配置，拿到的是 query+answer 原始对应关系，更准。若用户环境 DNS 不经过路由器（少见），可切到 dnsmasq 日志模式作为备选。

- 备选开关：`dns_source = auto | sniff | dnsmasq`。
- IP↔域名映射：一个 IP 可对应多个域名（CDN），按"最近一次解析 + 命中规则优先级"归因；TTL 过期后进入 30 秒宽限再淘汰。
- **透明性要求（四桶口径）**：不用单一的 "unknown"，而是分四桶展示，UI 与日报都按此呈现：

| 桶 | 含义 | 中性估算 | 保守估算 |
|---|---|---|---|
| **A 域名级** | 归到具体域名/应用 | 90.9% | 77.6% |
| **B 仅 ASN** | 只知道是哪家公司（Google/Cloudflare…） | 5.4% | — |
| **C 可识别但不可归因** | 认得出是加密 DNS/代理，但不知道内容 | 1.4% | — |
| **D 完全未知** | 什么都不剩 | 2.3% | — |

  触发条件是 **C+D > 10%**（不是原来的 30%——中性情形 C+D 只有 3.7%，30% 的门槛几乎永不触发，等于没监控）。
- **可解释性**：每条归因都要能下钻到依据（哪条 DNS 记录 / 哪个 SNI / 哪个端口规则 + 置信度）。调研发现**没有任何同类产品公布过识别准确率**，所以我们的承诺是"可解释"，而不是编一个百分比。

### 3.2 域名 → 应用

规则库为 JSON（可放 `/etc/traffic-stats/apps.json`），结构：

```json
{ "version": "2026.11.1",
  "apps": [
    {"id":"douyin","name":"抖音","category":"短视频","match":["*.douyin.com","*.douyinpic.com","*.amemv.com"]},
    {"id":"youtube","name":"YouTube","category":"视频","match":["*.googlevideo.com","*.youtube.com"]}
  ]}
```

匹配顺序：精确域名 > 后缀通配 > 关键词；先匹配自定义，再匹配内置。
规则库更新来源：母节点下发（带 `ver`，子端幂等替换），或手动上传。

### 3.3 已知缺口（如实记录，不粉饰）

- **DoH/DoT**：客户端绕过路由器 DNS → 该设备流量落入 **C 桶**（能被 L0 标记出"在用加密 DNS"），而不是混进 D 桶。
- **HTTPDNS（国内最大漏损源）**：阿里云/腾讯云的 HTTPDNS 明确"绕过传统 Local DNS，直接 HTTPS 查询"，是国内 App 的普遍做法。用户会看到某些 App 长期归 unknown，**文案必须提前解释**，否则会被当成 bug。
- **ECH**：SNI 也拿不到。缓解手段：① 解析 DNS 的 SVCB/HTTPS RR（type 65）里的 `ech=` 参数，可**提前标记**哪些域名将来会让 SNI 失效；② 读 ECH 的 outer SNI（唯一可读信号，至少能到 CDN/前置）；③ TLS 1.2 的证书 SAN 不受 ECH 影响（但 TLS 1.3 下失效）。这三条都在 P4 候选里。
- **QUIC/HTTP3**：走**两条路**——DNS 可观测时靠 DNS 归因；DNS 不可观测时靠 QUIC Initial 解密（RFC 9369 的 Initial 设计上就允许观察者检查其中 TLS ClientHello）。**两条都不通时落 C/D 桶，不能假设"QUIC 总能归因"。**
- 下游再接一台路由器：其背后设备只能看到一个 MAC → 统计粒度退化到该路由器，需在 UI 说明。

---

## 4. 存储层

### 4.1 分层与保留

| 层级 | 粒度 | standalone/child | master | 位置 |
|---|---|---|---|---|
| t1m | 1 分钟 | 60min(lite) / 2h(full) | — | RAM (tmpfs) |
| t5m | 5 分钟 | 24h RAM + 7d(lite 不落盘) | 7 天 | SQLite |
| t1h | 1 小时 | 30d(lite) / 90d(full) | 90 天 | SQLite |
| t1d | 1 天 | 400 天 | 400 天 | SQLite |

**维度分表，禁止无脑笛卡尔积**：

- `t*_dev`：`(ts, node_id, dev_id) → rx, tx, pkts`
- `t*_app`：`(ts, node_id, app_id) → rx, tx, pkts`
- `t*_dev_app`：**只存在于 t1m（RAM）与 t1d（每设备 Top-5 应用 + other）** 两级。全部层级都存交叉表会让行数爆炸。

### 4.2 容量估算（**估算，未实测**）

假设 5 节点 × 20 设备 × 30 应用，行宽按 40–60B：

| 表 | 行数 | 体积 |
|---|---|---|
| master t5m_dev（7d） | 288×7×5×20 ≈ 20.1 万 | ~9 MB |
| master t1h_dev + t1h_app（90d） | 2160×5×20 + 2160×5×30 ≈ 54 万 | ~25 MB |
| master t1d_*（400d，含 Top-5 dev_app） | 400×5×(20+30+20×5) ≈ 30 万 | ~14 MB |
| child t1m（RAM，2h） | 120×20×21 ≈ 5 万 | ~3 MB（内存） |

→ 母节点总量 **≈50 MB**（估算）。128MB flash 机型需切 lite（1h 保留 30 天、无 dev_app），约 15–20 MB。

### 4.3 flash 写放大控制

- `journal_mode=WAL`、`synchronous=NORMAL`、`auto_vacuum=INCREMENTAL`，每日 `PRAGMA incremental_vacuum`。
- 写入批量化：**RAM 每 15 秒、flash 每小时**提交一次（GL.iNet 的现成节奏）；软重启/reload 前强制落盘，硬重启最多丢 1 小时。这比"每 5 分钟一个事务"更省 flash，且丢失窗口可接受。
- **按分辨率分文件**（抄 OPNsense）：`t5m.sqlite` / `t1h.sqlite` / `t1d.sqlite` 各自独立，过期数据直接删文件，不需要 VACUUM、不会让单个库无限膨胀。
- 估算：批写约 1 MB/天 → ~365 MB/年。lite 档默认关闭 5m 落盘，只剩 1h/1d，写入降到每天几十 KB。
- DB 路径可配：默认 `/etc/traffic-stats/`（持久），可选 `/tmp`（零 flash 磨损、重启丢历史——**作为选项而不是默认**，因为日报需要跨天数据）。

### 4.4 表结构草案

```sql
-- 维度
CREATE TABLE nodes(node_id TEXT PRIMARY KEY, name TEXT, role TEXT,
    token_hash TEXT, config_ver INTEGER, last_seen INTEGER, tz_offset INTEGER,
    model TEXT, version TEXT, created INTEGER);
CREATE TABLE devices(dev_id INTEGER PRIMARY KEY, node_id TEXT, mac TEXT,
    ip TEXT, hostname TEXT, first_seen INTEGER, last_seen INTEGER,
    UNIQUE(node_id, mac));
CREATE TABLE apps(app_id INTEGER PRIMARY KEY, key TEXT, name TEXT,
    category TEXT, UNIQUE(key));
CREATE TABLE domains(domain TEXT PRIMARY KEY, app_id INTEGER, last_seen INTEGER);

-- 明细/聚合（示例：5 分钟）
CREATE TABLE t5m_dev(ts INTEGER, node_id TEXT, dev_id INTEGER,
    rx INTEGER, tx INTEGER, pkts INTEGER, PRIMARY KEY(ts,node_id,dev_id)) WITHOUT ROWID;
CREATE TABLE t5m_app(ts INTEGER, node_id TEXT, app_id INTEGER,
    rx INTEGER, tx INTEGER, pkts INTEGER, PRIMARY KEY(ts,node_id,app_id)) WITHOUT ROWID;

-- 运维
CREATE TABLE spool(id INTEGER PRIMARY KEY, tier INTEGER, payload BLOB,
    created INTEGER, tries INTEGER);
CREATE TABLE alert_state(rule_key TEXT PRIMARY KEY, state TEXT,
    last_fired INTEGER, last_value INTEGER, streak INTEGER);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);  -- schema_version / node_id / secret
```

---

## 5. 子母协议

### 5.1 拓扑与角色

- `role = standalone | child | master`，同一固件三选一，配置项切换。
- 母节点兼任采集器（自己也是 child），所以母上跑完整采集 + 汇总两套。

### 5.2 接口（母节点 C 守护进程内置极简 HTTP/1.1，绑 LAN 地址，默认 18080）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/register` | 用配对码换 `node_id + secret`（仅一次明文返回） |
| POST | `/api/v1/ingest` | 批量上报聚合桶（gzip，≤200 桶/次） |
| GET | `/api/v1/config?ver=N` | 拉配置（304 或新配置 + 应用规则库版本） |
| POST | `/api/v1/ping` | 心跳 + 时钟偏移 |

- **认证**：`X-Node-Id` + `X-Timestamp` + `X-Sign`；`sign = base64(HMAC-SHA256(secret, METHOD|PATH|TS|sha256(body)))`；时间容差 300s；`(node_id, ts)` 去重窗口 10 分钟。
- **传输安全**：局域网内 HTTP + HMAC。文档明确写"母端口不应暴露到 WAN；跨网段请走 WireGuard/Tailscale"。TLS 列为 P3 可选。
- **幂等**：以 `(node_id, tier, ts, dim, dim_id)` 为唯一键 upsert，允许重传与补传。
- **时钟**：桶以 UTC 存储；上报带 `tz_offset` 与本机 `htp`/NTP 同步状态。子端 NTP 未同步时**暂缓上报**（进 spool），母端对 `|skew| > 600s` 的批次回 409 并计入诊断。
- **注册流程**：母 UI 生成 8 位配对码（10 分钟有效）→ 子在设置页填母地址 + 配对码 → 母返回 `node_id`（如 `node-3f2a`）+ 32 字节 secret → 母 UI 显示待批准节点。

### 5.3 配置下发内容

`report_schedule`（日/周报时间与接收群）、`alert_rules`、`app_rules`（含版本号）、`retention`、`attribution` 开关、`feishu` 模板参数。子端把母下发的部分写入 `/etc/config/traffic-stats` 的 `remote` section，与本地配置分离，避免互相覆盖。

### 5.4 漫游与重复计数

同一手机在子 A/子 B 都上网 → 两边都计数。决策：**按接入点统计为正式口径**，不做事后合并（去重需要跨节点实时指纹，成本高于收益）。报表与 UI 注明口径；母端提供"同一 MAC 跨节点"视图供人工判读。

---

## 6. 报表与告警

### 6.1 飞书路线（已核实）

- 群自定义机器人 Webhook：`https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，卡片放 **`card` 字段**（不是应用 API 的 `content`）。
- 签名：`key = timestamp + "\n" + secret`，HMAC-SHA256 签**空字节串**，Base64；`timestamp`/`sign` 放 body 根部。
- **硬限制**：body ≤ **20 KB**；单机器人 **100 次/分、5 次/秒**；只能推它所在的那一个群；**纯 Webhook 拿不到 `image_key`，贴不了图**。
- **必须解析 body 的 `code`**：签名错 `19021`、关键词错 `19024`、限流 `11232` 往往仍是 HTTP 200，只看状态码会"假成功"丢告警。
- 卡片用 **JSON 2.0**（`"schema":"2.0"`，元素在 `body.elements`）：趋势图用原生 `chart`（VChart，13 种图，7 点折线约 335B），表格用原生 `table`（单卡 ≤5 个、≤50 列、`page_size` 默认 5 需显式设 10）。
- ⚠️ 2.0 需客户端 ≥ 7.20，老版本只显示标题 + 升级提示 → 提供 `card_version = 2.0 | 1.0` 降级开关（1.0 用 markdown 表格，无图）。
- ⚠️ 2.0 已移除 `note` 与 `action`，硬用报 `200861`；脚注改用 `div + plain_text`。

### 6.2 日报卡结构（体积预算内）

```
header      日报｜2026-11-13  总流量 128.4 GB ▼12%
markdown    概况：在线设备 18 / 峰值 92 Mbps / 未归因 7.2%
chart       Top8 应用 横向柱状图（~1.5KB）
table       Top10 设备（名称/流量/占比），page_size=10（~2.5KB）
div+note    数据口径说明 + 生成时间
```
单卡约 6–8 KB，远低于 20 KB；周报把 chart 换成 7 天折线。

### 6.3 告警引擎

规则类型（UCI list 配置，母/子都可定义）：

| 类型 | 触发 | 默认抑制 |
|---|---|---|
| `dev_quota` | 设备单日流量 > X GB | 当天一次 |
| `app_quota` | 某应用单日 > X GB | 当天一次 |
| `spike` | 当前小时同比 7 日均值 > N 倍 | 2 小时 |
| `dev_offline` | 已知设备 > N 分钟无流量（且不在 DHCP 租约活跃期） | 恢复即通知 |
| `new_device` | 未知 MAC 首次上网 | 一次性 |
| `node_offline` | 子节点心跳缺失 > 5 分钟 | 恢复即通知 |
| `accounting_degraded` | `accounting_confidence ≠ exact`（offload/rmem/表满），或 C+D 桶 > 10% | 12 小时 |
| `month_quota` | 设备或全网当月流量达到套餐上限的 80% / 95% | 每档各一次 |

去重状态机：`normal → pending(需连续 2 次命中) → firing(进入冷却) → resolved(发恢复)`；冷却期内只更新 `last_value` 不发消息。**这是防止告警风暴的核心**。

### 6.4 失败处理

- 重试：`1 → 5 → 15` 分钟三次退避，仍失败写 `logread` 并在诊断页留痕。
- 时钟漂移会导致全量 `19021` → 发送前校验本机时间与上次成功发送的时间差，若系统时间跳变则强制重签。
- 整点（10:00/17:30）易撞 `11232` → 报表计划默认错开 3–5 分钟。

---

## 7. Web 界面（LuCI JS）

24.10 只写 JS 视图（Lua CBI 已停止接受新模块），菜单走 `menu.d/*.json`，绝不写 Lua app。

| 页面 | 内容 |
|---|---|
| **概览** | 今日/本月总流量、实时速率、在线设备数、Top 设备、Top 应用、未归因占比 |
| **设备** | 列表（MAC/主机名/IP/今日/本周/估算月用量）→ 详情（应用分布环图、24h/7d 曲线、Top 域名） |
| **应用** | 应用排行、单应用下钻（哪些设备在用） |
| **多节点**（master） | 节点卡片（状态/最后上报/流量）、全局面板、节点配对与批准 |
| **设置** | 采集粒度、归因开关（DNS 模式/SNI）、存储与保留、飞书 webhook + 测试发送、告警规则、报表计划 |
| **诊断** | 三项自检结果（acct/rmem/offload）、conntrack 条目数、采集速率、上报队列、DB 大小、与 nlbwmon 的交叉校验差值 |

图表库：24.10 用自带 `luci-lib-chartjs`（`L.resource('nlbw.chart.min.js')` 注入后全局 `Chart`）；⚠️ **23.05 没有该包**，23.05 需自带 chart.js（约 90KB gzip）或用简洁 SVG 自绘。决策：第一版只在 24.10 使用 chartjs，23.05 用自绘 SVG（避免打包体积翻倍）。

后端调用：LuCI JS → `rpc.declare()` → rpcd ucode 插件（`/usr/share/rpcd/ucode/traffic-stats.uc`）→ ubus 调 C 守护进程。
ACL：读写分离 + 方法级白名单；`read.ubus.service:["list"]` 必须显式授予。

---

## 8. 工程结构（双包，OpenWrt 标准）

```
openwrt-traffic-stats/
├── traffic-statsd/                    # 架构相关包（C）
│   ├── Makefile
│   ├── src/{main.c,ctnetlink.c,flows.c,dns.c,sni.c,agg.c,db.c,http.c,ubus_iface.c,util.c}
│   ├── files/{traffic-statsd.init, traffic-stats.config, uci-defaults/90-traffic-stats}
│   └── files/sysctl/11-traffic-stats.conf
├── luci-app-traffic-stats/            # LUCI_PKGARCH:=all
│   ├── Makefile
│   ├── htdocs/luci-static/resources/view/traffic-stats/*.js
│   ├── root/usr/share/luci/menu.d/luci-app-traffic-stats.json
│   ├── root/usr/share/rpcd/ucode/traffic-stats.uc
│   ├── root/usr/share/rpcd/acl.d/luci-app-traffic-stats.json
│   └── root/usr/share/traffic-stats/{apps.json, locales/}
├── ucode/                             # 报表/告警/上报（装进 traffic-statsd 包）
│   ├── feishu.uc  report.uc  alert.uc  push.uc  render.uc
├── docs/
├── tests/
└── README.md
```

- 依赖：`+libc +libubus +libblobmsg-json +libuci +libsqlite3 +kmod-nf-conntrack +rpcd-mod-ucode`
  （具体 kmod 名清单以打包调研 §8 待实测项为准，P0 首件事是编译验证）
- 24.10/23.05 都是 **opkg**（apk 从 25.12 才默认），Makefile 不用双写。
- 配置：装包即铺带 section 的默认 UCI（否则 LuCI 表单空转）；`conffiles` 保用户配置；`uci-defaults` 幂等补齐；`config_version` + 三层迁移策略。

---

## 9. 分期与验收

| 期 | 交付 | 验收标准 |
|---|---|---|
| **P0** 骨架+采集 | 双包骨架、C 守护进程跑通 ctnetlink、三项自检 + 对账自检、`accounting_confidence`、SQLite 落 1m/5m 桶、LuCI 概览+设备两页 | 真机上能列出设备并看到分钟级曲线；自检页三项状态正确；对账比值能算出来；连续跑 24h 无 ENOBUFS |
| **P1** 归因+报表 | DNS 嗅探、**实时速率**、四桶（A/B/C/D）口径与下钻、应用规则库、应用类别、飞书日报卡片（含环比） | 日报卡 `code==0`；应用 Top 榜与手工核对偏差 < 10%；每条归因能看到依据 |
| **P2** 告警+日常 | 规则引擎、去重状态机、恢复通知、**新设备/设备离线/大流量/月配额**告警、设置页、周报、**按域名反查设备**、CSV 导出、**设备别名与分组（按组汇总）**、**`hybrid` 模式（WiFi station 计数 + 来源标注）** | 构造六类场景各触发一次且不重复发；月配额在 80%/95% 各触发一次；分组汇总数 = 成员之和；开 offload 时无线设备总量与关闭 offload 的读数偏差 < 5% |
| **P3** 子母 | 注册/上报/汇总/全局面板/配置下发/规则库下发、**Prometheus / InfluxDB 导出** | 两节点以上数据正确汇总；断网 10 分钟后补传无重复；时钟偏移被正确拒收；Prometheus 端点能被 `promtool check metrics` 通过 |
| **P4** 增强 | **QUIC Initial 解密、TLS 1.2 证书 SAN、ECH outer SNI、ASN 兜底、代理侧元数据（mihomo/sing-box）**、**陌生设备识别 + 一键阻断**、压测、文档、feed 打包 | 1000 并发流下 CPU < 5% 单核、内存 < 20MB；QUIC 归因在 HTTP/3 站点上可用；阻断操作有二次确认与审计日志（以真机实测为准） |

---

## 10. 风险登记（按严重度）

| # | 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|---|
| R1 | flow offloading 与统计互斥 | 数据不可信 | 三档策略（strict/hybrid/performance）+ 自动检测 + `accounting_confidence` 标注 | 设计已覆盖 |
| R2 | MT7621 无 PPE 硬计数（`has_accounting=false`，硬件与驱动都没有） | 开 HFO 时必然偏低 | 关 HFO 或走 hybrid；诊断页按 SoC 提示 | 已确认 |
| R2b | **口径混用**：hybrid 模式下无线是 MAC 层字节、有线是 IP 层 | 两类设备数字不可直接比大小 | UI 给每个数字标注来源；汇总时按平台加系数（MAC 层约 +2.1–2.5%，小包可到 +50%） | 设计已覆盖 |
| R2c | mt7530 端口字节 MIB 在 24.10 未暴露 | 有线 L2 计数不可用 | 不做（需回移内核补丁，维护成本高于收益） | 已排除 |
| R3 | DoH/ECH 普及 | 归因覆盖率下降 | 展示未归因占比；可选拦截已知 DoH 域名（不默认） | 长期风险 |
| R4 | 16MB flash 写寿命 | 设备损坏 | lite 档不落 5m；批量事务；可配 /tmp | 设计已覆盖 |
| R5 | 128MB RAM 下的 SQLite 缓存 | OOM | `PRAGMA cache_size` 限 2MB；连接用 `SQLITE_OPEN_NOMUTEX` | 待实测 |
| R6 | 多机时钟漂移 | 报表错位 | NTP 未同步暂缓上报；母端 409 拒收 | 设计已覆盖 |
| R7 | 漫游重复计数 | 总量偏高 | 明确按接入点口径 + 跨节点 MAC 视图 | 已接受 |
| R8 | 飞书 20KB / 限流 | 报告发不出 | chart+table 体积预算 8KB 内；告警去重 | 设计已覆盖 |
| R9 | `kmod-nft-fullcone` 可能吞事件 | 统计恒空 | 检测 + 提示，不自动改 | 待验证 |

---

## 11. 决策记录与待确认

### 已定

| 决策 | 结论 | 日期 |
|---|---|---|
| 包名 | `traffic-statsd`（架构相关）+ `luci-app-traffic-stats`（all） | 2026-11-14 |
| 母节点形态 | 由其中一台 OpenWrt 路由器兼任 | 2026-11-14 |
| 飞书路线 | 群自定义机器人 Webhook（签名 secret），不建自建应用 | 2026-11-14 |
| 归因精度 | 分档可配置：DNS 常开，SNI 按档位（full 默认开，详见下） | 2026-11-14 |
| 子母网络 | 同一局域网/多网段，不做公网穿透 | 2026-11-14 |
| 硬件适配 | 双档（lite / full）按 RAM 与 flash 自适应 | 2026-11-14 |
| 归因口径 | **四桶 A/B/C/D**，可下钻到依据；不承诺准确率百分比 | 2026-11-14 |
| 数据可信度 | 增加 `accounting_confidence`（exact/degraded/unknown），用接口总量对账，行业空白点 | 2026-11-14 |
| 规则库许可 | 主库 v2fly/domain-list-community（MIT）；nDPI 双许可，**借算法不借库** | 2026-11-14 |
| SNI 默认档位 | **full 档默认开 SNI**（多 1–3% CPU，换域名级归因 60%→90%）；lite 可选限速版 | 2026-11-14 |
| 增补功能 | 设备别名+分组（P2）、Prometheus/InfluxDB 导出（P3）、陌生设备识别+一键阻断（P4） | 2026-11-14 |

### 待确认

1. **flow offloading 默认策略（现在是三选一，见 §2.2.3）** —— `strict`（全准、降速）/ `hybrid`（开加速，无线总量准、有线低估、应用退化）/ `performance`（开加速，全部估算）。方案默认仍是 `strict`，但等你真机标定（§2.2.2）拿到"三档吞吐 + 偏差倍数"后再定。若你的无线设备占多数、且宽带是千兆，`hybrid` 很可能是更优解。
2. **实现细节还想改哪些** —— 你明确要再改方案细节，尚未进入编码。
3. **目标机型清单**：型号、OpenWrt 版本、WAN 带宽、当前 offload 设置（用于把 lite/full 分档阈值和默认策略落到实处）。
4. ~~待补调研~~ 已完成：`research-l2-counters.md` 证明无线 station 计数可用（WED 由驱动用硬件 WCID 兜底），交换机端口 MIB 在 24.10 未暴露，厂商 hnat 回灌在官方固件无效。

---

## 12. 文档索引

- `docs/research-traffic-capture.md` — 采集与归因选型（方案对比、三个坑、业界组合、容量与协议约束）
- `docs/research-feishu-api.md` — 飞书 Webhook/卡片/限流/错误码/最小签名示例（37 条官方链接）
- `docs/research-openwrt-packaging.md` — LuCI JS/rpcd/procd/UCI/打包/骨架（958 行，含可照抄模板）
- `docs/research-industry-approaches.md` — 13 个同类产品的测量点/维度/存储/告警横向对比
- `docs/research-app-identification.md` — 15 条归因路线的成本与覆盖率模型
- `docs/research-l2-counters.md` — WiFi station 计数、mt7530 端口 MIB、PPE 计数回灌
- `docs/REVIEW-alternatives.md` — 横向结论与对方案的修订清单
- `docs/CALIBRATION.md` — 真机标定手册（含采集脚本与判读规则）

---

## 13. 实测环境勘察结论（2026-11-14）

### 13.1 两台机器

| | 主软路由 | AP |
|---|---|---|
| 地址 | 192.168.100.1 | 192.168.100.3 |
| 系统 | iStoreOS 24.10.7（**opkg**） | ImmortalWrt SNAPSHOT r39859（**apk**） |
| 硬件 | x86_64 J4125 4C@2.0GHz / 3.7GB RAM / overlay 1.9G（剩 1.0G） | aarch64 airoha/an7581 / 1.8GB RAM / overlay 331M（剩 297M） |
| 内核 | 6.6.141 | 6.18.35 |
| 角色 | 路由 + NAT + DHCP + DNS | **哑桥 AP**（`dhcp.lan.ignore=1`、`wan proto=none`），3 个 BSS，5 个无线客户端 |
| offload | **完全未启用**（`nft list ruleset` 中 flowtable 数 = 0，uci 无该键） | `flow_offloading=1` + `_hw=1`，ruleset 有 1 个 flowtable，`nft_fullcone` 已加载 |
| acct / rmem | 1 / 7500000 | 1 / 7500000 |
| conntrack | 2502 / 65535 | 837 / 65536 |
| 其它 | nlbwmon 在跑、OpenClash(fake-ip)、AdGuardHome、Docker(uptime-kuma) | — |
| 缺件 | libsqlite3、conntrack 工具 | libsqlite3、openssl、conntrack 工具 |

### 13.2 六个改变设计的发现

**F1｜主路由根本没有 offload → `strict` 在这套部署上零代价。**
x86 4 核、ruleset 里没有 flowtable。所以我之前纠结的"关加速掉一半吞吐"对本部署不成立。`hybrid`/`performance` 保留给 ARM 机型，默认 `strict`。

**F2｜AP 是哑桥，但主路由能看到无线客户端的 MAC。**
同一个 MAC（如 `22:77:08:69:a9:1f` = OnePlus-8-Pro）同时出现在 AP 的 `station dump` 和主路由的 DHCP 租约 / nlbwmon 记录里。**结论：主路由单点即可覆盖全网设备，子母不是当前刚需。**

**F3｜OpenClash 是 fake-ip 模式 → DNS 归因反而更准。**
`fake-ip-range: 198.18.0.1/16`。每个域名分到一个专属假 IP，客户端连的是假 IP，DNS 应答里就有映射 → **IP↔域名 1:1，没有 CDN 共享 IP 的歧义**。这比普通环境更理想，应显式识别并标为"高置信度"。

**F4｜但代理会导致重复计数：实测聚合值是 WAN 的 2.0 倍。**
- nlbwmon 当前区间（11-01 起，13.6 天）合计 **970.7 GiB**；
- eth0 自启动 4.05 天合计 141.5 GiB → 折合 13.6 天约 **479 GiB**；
- 比值 **≈2.0**。与"客户端一条流 + clash 出站一条流，两条都被计数"完全吻合（因果为强推断，未逐流验证）。
- 且路由器自身 MAC 独占 rx 450 GiB（全部 rx 的 63%），因为它承载了所有 clash 出站连接。
→ **对账自检不能天真地用 `Σ设备` 比 `WAN 总量`**，必须拆出"路由器自身/代理腿"桶，否则天天报"180%"。

**F5｜nlbwmon 正在运行，会与我们的采集器抢计数。**
它已在 `/etc/nlbwmon` 积累了数月数据（压缩后仅 4.8KB/970GiB，说明**只存设备维度极其便宜**）。两者都读 ctnetlink 并清零计数器，**必须互斥**。同时它是 P0 现成的对照基准（oracle）。

**F6｜apk / opkg 双格式、双架构已成事实。**
主路由 opkg + x86_64，AP apk + aarch64_cortex-a53。打包必须两边都验证，不能只测一种。

### 13.3 由此产生的方案修订

| # | 位置 | 修订 |
|---|---|---|
| M11 | §2.2 策略 | 本部署默认 `strict`；`hybrid`/`performance` 降级为面向 ARM 用户的可选项 |
| M12 | §2.2.1 对账 | 增加"路由器自身"桶与代理感知；阈值改为按"终端设备合计 vs (WAN − 路由器自身)"计算，并为代理路径留容差带 |
| M13 | §3 归因 | 显式检测 fake-ip 段（198.18.0.0/16 等），命中时按假 IP 直映域名并标"高置信度" |
| M14 | §4 存储 | 参考 nlbwmon：设备维度汇总极省空间，真正贵的是 `dev×app×时间`；lite 档可考虑砍掉 dev_app 交叉表 |
| M15 | §8 工程 | 明确 apk/opkg 双格式 + x86_64/aarch64 双架构的构建与验证矩阵；处理 nlbwmon 互斥（安装时检测并提示停用） |

### 13.4 受控精度验证（2026-11-14，已执行）

**方法**：本机（192.168.100.115，LAN 客户端）从清华镜像站下载**精确 100 MiB**，同步抓取主路由的 conntrack 与 eth0 计数。

**结果**：

| 指标 | 数值 | 与真值偏差 |
|---|---|---|
| 下载真值 | 104,857,600 B / 3.20 s / 261.8 Mbps | — |
| **conntrack 客户端腿（下载方向）** | **105,476,660 B** | **+0.59%** |
| eth0 rx 增量（4 秒窗口） | 110,129,331 B | +5.02%（**含背景流量，仅参考**） |

抓到的流：
```
src=192.168.100.115 dst=198.18.49.245 sport=58650 dport=443
  ⟶ reply: src=192.168.100.1 sport=7892 dst=192.168.100.115
  reply_bytes=105476660
```

**三条结论**：

1. **逐设备计数准确（<1%）**。0.59% 的差是 TLS/传输层开销，不是漏算。方案的核心假设成立。
2. **本地重定向不破坏设备归属**，但**必须用 orig 五元组取目的地**：reply 的源地址已被 NAT 改写成 `192.168.100.1:7892`。任何"假设 reply.src == orig.dst"的实现都会在这里出错。
3. **代理腿确实存在**：客户端腿在 br-lan（105 MB），eth0 侧另有 ~110 MB，二者相加 ≈ 215 MB ≈ 2×WAN，与 §13.2 F4 的聚合 2.0× 完全吻合。因此对账口径必须拆出"路由器自身/代理腿"桶。

**归因侧**：客户端连的是 fake-ip `198.18.49.245`，DNS 应答里有 `域名→假 IP` 映射，归因 1:1 无歧义。需处理的问题：fake-ip 有 TTL 回收，且 clash 重启后映射全变（`store_fakeip=0`），所以映射表必须靠持续嗅探重建，不能持久化后当永久事实。
