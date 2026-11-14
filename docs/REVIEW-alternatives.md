# 横向调研结论：流量还能怎么量，别人是怎么做的

> 依据：`docs/research-industry-approaches.md`（13 个产品/项目）、`docs/research-app-identification.md`（15 条归因路线）、`docs/research-traffic-capture.md`
> 目的：回答"是不是只有 conntrack 这一条路"，并给出对 `PLAN.md` 的具体修订。
> 标注：**源码/官方文档**=可复核；**估算**=按结构推导；**未查证**=没有可信来源。

---

## 0. 直接回答：不是只有一条路，但业界的"测量原型"只有四种

| # | 测量点 | 代表实现 | 抗 offload | 能给 per-device | 能给 per-app |
|---|---|---|---|---|---|
| ① | **L2 / 网卡钩子**（包还没进路由就数） | OPNsense `ng_netflow` 插在 `ng_ether` 的 lower/upper 之间；bandwidthd/darkstat 的 pcap | ✅ 结构上不受转发加速影响 | ✅（按 IP） | ❌ |
| ② | **状态表 / conntrack** | 我们的 ctnetlink、RouterOS `/ip accounting`、pfSense 的 `rate`（读 pf 状态表） | ❌ | ✅ | 需另做归因 |
| ③ | **转发链 CPU 路径计数** | RouterOS Traffic Flow（官方原话：HW-offloaded traffic never shows up） | ❌ 最严重 | ✅ | ❌ |
| ④ | **整形 / 队列点** | LibreQoS（v3 已改 DPDK 用户态桥，v2 的 tc/eBPF 已移除） | ✅（在整形点计数，不存在被绕过） | ✅ 按 subscriber | ❌ |

**没有第五种**（就"包路径上数"这一类而言）。我们的 ctnetlink 属第 ② 种，是主流选择，不是偏门。

> ⚠️ 还有一类**不在包路径上**的测量点，是上述四类之外的候选：**驱动/硬件自带的计数器**——典型是 WiFi 的 per-station `rx/tx bytes`（`iw ... station dump`）和交换机端口 MIB（DSA/`swconfig`）。它们由硬件或驱动维护，理论上不受 flow offload 影响，但粒度是"每 station/每端口"而不是"每 IP"，且是 MAC 层字节（含重传与帧头）。这一类正在单独深挖（`docs/research-measurement-points.md`），结论出来前不把它算作可选主路径。

第 ① 种（OPNsense 的做法）是唯一"结构上抗 offload"的方案，但代价是：拿不到 per-app（没有 L7 上下文），且 **NAT 场景天然双计**——它自己在 ingress 和 egress 各数一次，官方文档承认，解法是给用户一个 "egress only" 开关，而不是去重。这两点决定了它不能直接搬到我们这里。

---

## 1. 抗 offload：全世界都没解决，只是有人把它变成了产品语言

| 产品 | 官方态度 | 出处 |
|---|---|---|
| **GL.iNet** | 开"数据统计"会**自动关闭网络加速**，并直说只统计 Client 页上的设备 | 官方文档 |
| **MikroTik** | 文档明确写 FastTrack 绕过 connection tracking、simple queues、**IP accounting**；Traffic Flow 明说 HW-offload 流量永不出现。**但产品层面不拦、不提示** | 官方手册 |
| **Firewalla** | 纯软件路径，没有 ASIC 可绕过；代价是吞吐随规则/流数下降（官方给了性能模型） | 官方帮助中心 |
| **LibreQoS** | 在整形点计数，不存在被绕过；但分片后顶层计数器只是某个 worker 的份额，官方专门警告 | 官方文档 |
| **OPNsense** | 在 L2 数，绕过问题不存在，换来 NAT 双计 | 源码 + 文档 |

**结论**：我们"默认关闭 offload"不是保守，而是行业里唯一诚实的做法。GL.iNet 直接把这个代价写进产品行为，说明它确实无法两全。

**同时发现一个真正的空白**：**没有任何一家把"接口总量 vs 逐设备汇总"做成产品的自检指标**。最接近的只有 RouterOS Traffic Flow 里的 `unmanaged-packets/bytes`（认不出的包单独计数）和 LibreQoS 的 "unknown IP" 类目。

→ 我们的**对账自检**（`Σ逐设备` vs `wan 接口总量` → `accounting_integrity` 百分比）是确实没人做的差异点，保留并前置到概览页。

另外，RouterOS 的绕过清单精确到"哪个机制"（Simple queues、parent=global 的 queue tree），而不是笼统说 offload。启示：我们的 `strict_accounting` 判定也应该**指出具体原因**（"hw offload 生效" / "sw flow offloading 生效" / "rmem 不足丢事件" / "conntrack 表满"），而不是只给一个"不准"。

---

## 2. per-app 的真相：真 DPI 是少数，我们不是降级方案

| 产品 | 它所谓"应用"实际是什么 | 证据 |
|---|---|---|
| **TP-Link Deco** | **按域名分类**。官方 FAQ 连副作用都写了："后台访问同一域名也会算进该应用" | 官方 FAQ 5235 |
| **OPNsense Insight** | **端口**。饼图叫 "Port / Application"，源码里用 `min(dst_port, src_port)` 猜服务端 | 源码 |
| **Firewalla** | 不看任何加密流量，靠域名/证书/UA 元数据推断 | 官方帮助中心 |
| UniFi | 自称 DPI（需要 UniFi 网关） | 官方文档 |
| ntopng | 真 DPI（nDPI） | 官方源码 |

**而且没有任何一家公布识别准确率。** 所以我们在文案上不应该承诺百分比，而应该承诺**可解释**：每个应用的流量能下钻到"这条归因来自哪条 DNS 记录 / 哪个 SNI / 哪个端口规则 + 置信度"。这比一个编出来的 "95%" 更有用。

---

## 3. 归因还能扩展——但要换成"四桶"口径

现有方案只有一个 "unknown" 桶，太粗。调研给出的分层（A/B/C/D）更能反映真实能力：

| 桶 | 含义 | 中性估算 | 保守估算 |
|---|---|---|---|
| **A 域名级** | 归到具体域名/应用 | 90.9% | 77.6% |
| **B 仅 ASN** | 只知道是哪家公司（Google/Cloudflare…） | 5.4% | — |
| **C 可识别但不可归因** | 认得出是加密 DNS/代理，但不知道内容 | 1.4% | — |
| **D 完全未知** | 什么都不剩 | 2.3% | — |

> 仅做 DNS 嗅探时：A 只有 59.5%，**B 高达 24.3%**，D 16.2%。所以 **SNI 不是锦上添花，是把 A 从 59.5% 拉到 90% 的关键一档**——这改变了"lite 档默认不开 SNI"的性价比判断（见 §7 修订）。

可加的路线（按性价比排序）：

| 路线 | 价值 | 成本 | 建议档位 |
|---|---|---|---|
| **QUIC Initial 解密取 SNI** | HTTP/3 已占 41% 站点；RFC 9369 原文说 Initial 设计上就是可被观察者检查的；nDPI `quic.c` 已有实现（v1/v2 盐 + CRYPTO 乱序重组） | 解密 100–150 µs/包，1000 连接/分钟约 0.7% 单核；**瓶颈是抓包不是解密** | full 档，P4 |
| **TLS 1.2 证书 SAN** | **免疫 ECH**（ECH 只用于 TLS 1.3） | 比 SNI 贵 3–10 倍（要重组多包） | full 档，P4 |
| **ECH outer SNI** | ECH 流量唯一可读信号，至少能到 CDN/前置 | 复用 SNI 解析，≈0 | 顺手做 |
| **DoH 端点标记** | 标出"这台设备在用加密 DNS"，把这部分流量归 C 桶而不是 D | ≈0 | lite 档也开 |
| **ASN 兜底** | 把所有流量至少归到公司，B 桶 | lite 用 Top-50~200 ASN 前缀集 ≈0.3–0.5 MB；full 用 iptoasn（PDDL 公有领域，9.4 MB）；GeoLite2-ASN 9.07 MB 但 CC BY-SA + 要账号 | lite 用精简集，full 用全库 |
| **代理侧元数据**（mihomo `/connections`） | 若用户跑代理，host **精确**且零抓包 | 读本地 API | P4 可选 |
| **规则库** | 域名→应用 | **v2fly/domain-list-community（MIT，1000+ 服务）做主库**；AdGuard services.json（GPL-3.0）做补充 | P1 |

**必须写进文档的国内现实**：阿里云/腾讯云的 **HTTPDNS** 明确"绕过传统 Local DNS，直接 HTTPS 查询"——这是国内 App 的普遍做法，也是 DNS 归因最大的漏损源。用户会看到某几个 App 一直归到 unknown，文案要提前解释，否则会被当成 bug。

**阈值修订**：原计划"未归因 > 30% 告警"按模型几乎永不触发（中性 C+D 只有 3.7%）。改为 **C+D > 10%** 才是有意义的监控。

**已知的两个坑**（别踩）：
- 判断 DoH **不能用 Cloudflare 的 `ips-v4`**（那是整个边缘网 /13，会把所有 Cloudflare 前置站点误判成 DoH），只能用专用 anycast（1.1.1.1/1.0.0.1）或 DoH 主机名。
- nDPI 的 TLS/DNS 解析器是 ntop **双许可**组件，商业分发要授权 → **借算法不借库**。

---

## 4. 存储与报表：有两个现成答案可抄

**OPNsense 的结构**（源码确认）：
- 每个聚合维度一份 SQLite（`src_addr_000300.sqlite`、`dst_port_003600.sqlite`…），文件名带分辨率；
- 三档分辨率 300s / 3600s / 86400s，TTL 分别 **1 小时 / 1 天 / 365 天**；明细聚合保留 62 天；
- 原始流日志 10 MB × 10 轮转。
- **删旧数据 = 删文件**，不需要 VACUUM。这对 flash 是好设计，值得抄。

**GL.iNet 的写盘节奏**：RAM 每 15 秒写、flash 每 1 小时写；软重启前落盘，**硬重启最多丢 1 小时**；且按内存给机型门槛（明确列了不支持的型号）。这正好是我们 lite/full 双档的现成论证。

**Top-N + rest**：OPNsense 的 Top 25 + 其余归 "rest"，避免长尾把表撑爆。我们的 `t1d_dev_app` 之前设计成"Top-5 + other"，与此一致，保持。

**一个我们本来就占优的点**：5 分钟桶是**区间积分**，而 NetFlow/IPFIX 的吞吐是 `bytes/(flow_end-flow_start+1)` 的**平均**（ntop 官方博文）。积分口径在"某小时用了多少"这类问题上天然更稳，这在文案里可以作为正确性论据。

---

## 5. 功能对照：别人有、我们没写进方案的

| 功能 | 谁在做 | 价值 | 成本 | 建议 |
|---|---|---|---|---|
| **实时速率**（秒级） | 几乎所有产品 | 高——用户最想先看到的 | 低（db 里已有，只需暴露） | **P1 加** |
| **月流量配额 / 套餐剩余** | eero、Firewalla、运营商类 | 高（移动宽带/流量卡用户刚需） | 低（一条规则 + 进度条） | **P2 加** |
| **事件类告警**：新设备、设备离线、大流量 | Firewalla（10 类告警）；eero/Google/Deco 基本没有 | 高 | 低 | **P2 加**（已有部分，补"新设备/离线"） |
| 设备别名 / 分组（家长/办公） | UniFi、eero profile | 中 | 低 | P2 |
| **按域名反查"谁在访问"** | 少见 | 中高（排查"谁在刷抖音"） | 低 | **P2 加** |
| 导出 CSV / JSON | OPNsense、ntopng | 中 | 低 | P2 |
| Prometheus / InfluxDB 导出 | 开源派 | 中（接 Grafana/HA） | 中 | P3 可选 |
| 陌生设备一键阻断 | Firewalla、Deco | 中 | 中（要改 firewall，风险高） | P4 |
| 与 SQM 联动限速 | GL.iNet 有"一键封应用" | 中 | 高（要动 tc/队列） | 不做（P4 之后） |
| 历史对比（环比/同比） | TP-Link、UniFi | 中 | 低 | P1（日报里已有环比） |
| 应用类别（视频/游戏/下载） | 多数商用产品 | 中 | 低（规则库加 category 字段，已设计） | P1 |
| 父级/组级汇总 | UniFi | 低 | 中 | 不做 |

---

## 6. 明确不抄的（反面教材）

1. **OPNsense 的"端口=应用"** —— 会被用户当成识别错误，不如老实说"未识别"。
2. **MikroTik 的"功能留着、文档写了、产品不拦"** —— 用户永远不知道自己的数字是错的。我们必须用 `accounting_confidence` 显式标出来。
3. **eero / Google 的"历史深度按订阅分层"（免费 1 周 / 付费 3 个月）** —— 本地存储没有这个约束，不该人为设限。
4. **UniFi 的 MongoDB 依赖** —— 路由器上不可能，SQLite 足够。
5. **在 L2 对/端口对多接口各数一次** —— NAT 双计，除非只取 egress。

---

## 7. 对 PLAN.md 的修订清单

| # | 位置 | 原写法 | 改为 |
|---|---|---|---|
| M1 | §2.2 | 检测 offload 标志位 | 增加 `accounting_confidence = exact / degraded / unknown`，并**指出具体原因**；状态打到概览页与日报表头 |
| M2 | §3.1 | 单个 "unknown" 桶 | **四桶 A/B/C/D**，UI 与日报都分桶展示，且每条归因可下钻看依据 |
| M3 | §3.1 | SNI 默认关（lite 禁用） | 重新评估：仅 DNS 时 A 桶只有 59.5%，**SNI 是性价比最高的一档**；建议 lite 档也允许开（限速版），full 默认开 |
| M4 | §3.3 | "QUIC/HTTP3 仍可归因，因为靠 DNS" | 改为"QUIC 走 DNS 或 Initial 解密两条路，二者都不可用时落 C/D 桶" |
| M5 | §3.2 | 规则库来源不明 | 主库定 **v2fly/domain-list-community（MIT）**，辅以 AdGuard（GPL-3.0）；注意 nDPI 双许可，借算法不借库 |
| M6 | §4.1 | 单库多表 | 增加 OPNsense 式选项：**按分辨率分文件**，删旧数据 = 删文件，避免 VACUUM |
| M7 | §4.3 | 每 5 分钟一个事务 | 补 GL.iNet 式节奏：RAM 15s / flash 1h 批量提交，软重启前落盘 |
| M8 | §6.3 | 未归因 > 40% 才告警 | 改为 **C+D > 10%** |
| M9 | §9 | P4 才考虑 SNI | 增加 P4 候选：QUIC Initial 解密、TLS 1.2 证书 SAN、ASN 兜底、代理侧元数据 |
| M10 | 全文 | 无"实时速率/月配额/事件告警" | 按 §5 表补入 P1/P2 |

---

## 附：一句话总结

> 测量点业界只有四种原型，我们选的 conntrack 是主流；抗 offload 没有任何产品做到两全，但**把"当前数据可不可信"显式化 + 用接口总量对账**是没人做过的差异点；per-app 上真 DPI 是少数，我们的 DNS+SNI 路线与 TP-Link/Firewalla 同源，**该承诺的是"可解释"而不是准确率**。
