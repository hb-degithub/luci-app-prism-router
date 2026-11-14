# 横向盘点：别人的流量统计是怎么做的

> 目的：为一个 OpenWrt 用量统计插件提供"测量点 / 维度 / 存储 / 报表 / 告警"的横向参照。
> 调研时间：2026-11-14。**只做调研，不含业务代码。**
> 与既有三份调研的关系：`docs/research-traffic-capture.md` 已覆盖 **OpenWrt 包生态、内核原语、per-app 手段**；`docs/research-openwrt-packaging.md` 覆盖 LuCI 打包；`docs/research-feishu-api.md` 覆盖飞书接口。**本文不重复这些结论**，只回答"同类产品用什么测量点、给什么维度、怎么存、怎么报"。
> 口径约定：**"源码/官方文档"**=可点开复核；**"未查证"**=没找到可信来源，明确不写结论；**"估算"**=按结构推导，需实测。
>
> 结构说明：一/二/四/五 对应任务要求的四段（总表、分产品、设计点、反面教材）；三 是把"特别关注的三个判断题"单列成节，因为它们更适合横向对照而不是散落在各产品里。

---

## 0. 六条结论速览

1. **测量点只有四种原型**：① L2/网卡钩子（OPNsense 的 netgraph 节点、pfSense 的 pcap 系工具）；② 状态表/conntrack（pfSense 的 `rate`、OpenWrt 的 ctnetlink；RouterOS 的 `/ip accounting` 大概率也属这类，但官方未公开实现）；③ 转发链 CPU 路径计数（RouterOS 的 Traffic Flow / apptraffic）；④ **整形/队列点**（LibreQoS 的 tc/DPDK）。我们的 ctnetlink 属于 ②，这是主流选择，不是偏门。
2. **"抗 offload"这件事，业界没有赢家，只有取舍**：MikroTik 官方文档直接写明 FastTrack 会绕过 connection tracking、simple queues 和 **IP accounting**（[Connection tracking](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking)）；GL.iNet 官方文档写明启用"数据统计"会**自动关闭网络加速**（[Data Statistics](https://github.com/gl-inet/docs4.x/blob/master/docs/en/docs/interface_guide/data_statistics.md)）；RouterOS 甚至规定"跑 torch/sniffer 时不启用 FastTrack"。**即：要么关加速换准确，要么开加速接受不准。**
3. **没发现任何一家把"接口总量 vs 逐设备汇总"做成产品的自检指标**。最接近的是 RouterOS `traffic-flow/monitor` 里的 `unmanaged-packets/bytes`（认不出来的包单独计数）和 LibreQoS 的 "unknown IP" 类目。这反而是我们可以做差异化的地方（见 §4.5）。
4. **per-app 的真相：真 DPI 是少数，域名/端口推断是多数**。TP-Link 官方 FAQ 直接承认"**流量是按域名分类的**"（[FAQ 5235](https://www.tp-link.com/au/support/faq/5235/)）；OPNsense Insight 的"应用"饼图本质是**端口**（[Insight 文档](https://github.com/opnsense/docs/blob/master/source/manual/how-tos/insight.rst)）；Firewalla 官方说明"不看任何加密流量"，靠元数据+签名推断（[How deep does Firewalla look](https://help.firewalla.com/hc/en-us/articles/360008659013-How-deep-does-firewalla-look-at-network-packets)）。**我们的"DNS 为主 + SNI 为辅"路线，和 TP-Link/Firewalla 同源，属于行业主流而非降级方案。**
5. **存储形态分成两派**：树莓派/软路由派（OPNsense、GL.iNet）是**本地 SQLite + 分层聚合 + TTL**；家电派（eero、Google、Deco、UniFi 云）是**云侧聚合 + 订阅决定历史深度**。本地派里最值得抄的是 OPNsense 的"一份聚合一个 SQLite、按分辨率分文件、按分辨率设 TTL"（[aggregates/source.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/aggregates/source.py)）。
6. **告警维度上家用产品比我们想得细**：Firewalla 官方列出 10 类告警，其中包含"**设备离线**""**新设备**""**大流量**"（[Deep Insights](https://help.firewalla.com/hc/en-us/articles/4410153017619-Firewalla-s-Deep-Insights)）；而 eero / Google / Deco 的官方文档里只讲"用量"，没讲流量事件告警（**未查证**，也可能只是文档没写）。我们要补的是**事件类告警**，不只是阈值告警。

---

## 一、产品对比总表

### 1.1 主表

| 产品 / 方案 | 测量点（在哪一层数） | 给用户的维度 | 抗 offload / 加速？ | 存储 | 报表 / 告警 |
|---|---|---|---|---|---|
| **OPNsense Insight** | netgraph `ng_netflow` 节点插在 `ng_ether` 的 **lower/upper 之间（L2）**；导出给本机 `flowd` 收集器（[rc.d/netflow](https://github.com/opnsense/core/blob/master/src/etc/rc.d/netflow)） | if / src_addr / dst_addr / dst_port / protocol / direction / octets / packets。**无 per-app（"application"=端口）** | ✅ 结构上不受转发加速影响（在路由之前数）；但 **NAT 下 ingress+egress 会双计**，官方文档自己承认（[Netflow](https://docs.opnsense.org/manual/netflow.html)） | `/var/log/flowd.log` 原始流（10 MB×10 轮转）+ `/var/netflow/*.sqlite` 多层聚合（[lib/__init__.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/__init__.py)） | `Reporting → Insight`：堆叠/流/展开图、Top 25、端口饼图、CSV 导出；细节保留 62 天 |
| **pfSense Traffic Graph** | **pf 状态表**（用 `/usr/local/bin/rate` 读，源码见 [bandwidth_by_ip.inc](https://github.com/pfsense/pfSense/blob/master/src/usr/local/pfSense/include/www/bandwidth_by_ip.inc)） | 接口 + 每 IP 的实时 in/out 速率（3 秒刷新），Top 10 | ⚠️ 无 Linux 式 flow offload，不存在"被卸载绕过"；但 `rate` 是**统计/抽样式**工具，FreeBSD 包描述自认 "output is less accurate"（[pkg-descr](https://github.com/freebsd/freebsd-ports/blob/main/net-mgmt/rate/pkg-descr)） | 不落库（内存瞬时）；历史看 `Status → Monitoring` 的 RRD | 实时图 + Top10 主机；**无流量告警**（本机无流量告警引擎） |
| **pfSense bandwidthd** | libpcap 抓包（网卡混杂模式） | 每 IP，按子网分组；2/8/40/400 天图表；协议仅"HTTP/TCP/UDP/ICMP/VPN/P2P"色块（端口推断） | ❌ 受 TSO/LRO 影响（大包聚合后再进 pcap）；量级未查证 | 静态 HTML+PNG（每 200 秒）或 sensor→PostgreSQL（[bandwidthd 官网](http://bandwidthd.sourceforge.net/)） | 静态图；**无流量告警**；**不支持多接口**（[pfSense 文档](https://github.com/pfsense/docs/blob/master/source/monitoring/monitoring-bandwidth-usage.rst)） |
| **pfSense darkstat** | libpcap（"packet sniffer"） | 每 host / port / protocol + 带宽图；内存哈希表 | ❌ 同 pcap 系；且只在内存（`--hosts-max` 上限） | 无持久化，**重启即丢**（[man darkstat(8)](https://man.freebsd.org/cgi/man.cgi?query=darkstat&sektion=8)） | 内置 HTTP 页面；无流量告警；单接口 |
| **pfSense ntopng** | libpcap 或 flow | per-host + per-app（nDPI）+ per-flow | ❌/取决于抓包点 | Redis + 本地库（OPNsense 的 os-ntopng 文档明确要装 `os-redis`，[ntopng 文档](https://github.com/opnsense/docs/blob/master/source/manual/how-tos/ntopng.rst)） | 富交互界面；**资源要求高，官方不建议低配机** |
| **pfSense NetFlow** | `softflowd`（pcap→NetFlow）或 `pfflowd`（pf 状态→NetFlow） | 5-tuple 流 | softflowd ❌ 走 pcap；pfflowd 走状态表 | 本机不存，**纯导出** | 依赖外部 collector |
| **MikroTik `/ip accounting`** | 转发路径计数（官方未说明其内部实现；**FastTrack 会绕过它**） | src/dst 地址对的 bytes/packets | ❌ 官方明示 FastTrack 绕过 IP accounting | 内存 | 命令行 / 老式 web；无流量告警 |
| **MikroTik `/ip traffic-flow`** | **只统计过 CPU 的包**；"HW-offloaded traffic never shows up" | NetFlow v1/v5/v9/IPFIX（字段可选，含 NAT 前后地址） | ❌ 官方明写 HW-offload 的流量永远不出现 | 不存；UDP 导出（默认 2055）。flow cache 默认 256k/4k 条，active 30m / inactive 15s | `/ip/traffic-flow/monitor` 有 `finished/active/unmanaged` 计数（**自检味儿的计数器**） |
| **MikroTik `/tool/apptraffic`** | 设备本地的应用识别引擎（实现细节未查证） | **application + category** 的 bytes，分钟/10 分钟/小时/天/周窗口；**不含 per-device** | 未查证（`!mmips,!powerpc,!smips`，即大量低端机型不支持） | 内存（滚动窗口） | 命令行 stats；`/tool/apptraffic` 仅 1 个 `enabled` 开关 |
| **MikroTik Kid Control** | 每设备计数器（按 MAC 从 ARP 取 IP），限制由动态防火墙规则/简单队列实现 | 每设备 bytes-up/down + 实时 rate；时间表 + 限速 | ❌ 同 FastTrack 问题 | 内存 | App/命令行；**无"新设备"告警**（要自己看） |
| **MikroTik Queues** | **整形点**（simple queue / queue tree 的分类器+队列） | 每 target/队列：`bytes{up,down}`、`packets`、**`dropped`**、`rate`、`queued-bytes`（[queue/simple](https://manual.mikrotik.com/docs/cli-reference/queue/simple/)） | ⚠️ simple queue 与 `queue tree(parent=global)` **在绕过清单里**；挂在接口上的 queue tree 按字面**不在**清单内（推论，未实测） | 内存（`reset-counters` 清零） | 命令行/图形；无告警；**有丢弃计数，是 conntrack 口径给不了的** |
| **UniFi（UDM/UXG/USG）** | 网关侧 DPI（"Traffic and Device Identification"），官方要求必须是 UniFi 网关或云网关（[help.ui.com](https://help.ui.com/hc/en-us/articles/12570783535383-UniFi-Gateway-Traffic-and-Device-Identification)） | 应用 + 类别 + 每客户端；另有"设备识别"（厂商/型号/OS） | 未查证（官方未提 offload 与 DPI 的互斥） | 自托管 Network 应用要外部 **MongoDB**（3.6–8.0，9.0 起支持 8.0，[linuxserver 镜像文档](https://github.com/linuxserver/docker-unifi-network-application)）；DPI 具体表结构/保留期**未查证** | Network 应用内图表（Security Insights / 客户端详情）；**识别率官方标称：未查证** |
| **Firewalla** | 纯软件 CPU 路径（inbound+outbound 防火墙 + IDS/IPS），用户态解析包头与协议 | 每设备 live 吞吐、每设备/整网 Data Usage（月/日）、应用/域名类别、告警 | ✅ 无 ASIC/NIC 卸载可绕过；代价是吞吐随规则/流数下降（[Speed Limitations](https://help.firewalla.com/hc/en-us/articles/360007752134-Firewalla-Speed-Limitations-Explained)） | 本地 + 云（MSP 存 AWS，[MSP 隐私说明](https://help.firewalla.com/hc/en-us/articles/15767230775699-Firewalla-MSP-Questions-related-to-privacy-and-data-visibility)） | 10 类告警含**新设备 / 设备离线 / 大流量**（[Deep Insights](https://help.firewalla.com/hc/en-us/articles/4410153017619-Firewalla-s-Deep-Insights)） |
| **eero** | 云管理：用量由 eero 节点统计、云端聚合（具体计数器位置未查证） | 每设备 / 每 profile 的周用量；实时速率（5 秒刷新，单设备） | 未查证 | **云端**（"网络设置安全地存在云端"） | 流量类告警：未查证（有 eero Plus 的安全/内容过滤通知）；历史深度**按订阅分层**：免费 1 周，eero Plus 3 个月 |
| **Google Nest Wifi** | 云端（Google Home app） | 每设备上传/下载；"Devices"旁的数字=整网 WAN 总量；**近 30 天** | 未查证 | 云 | 流量类告警：未查证（家长控制是另一套） |
| **TP-Link Deco** | 云端 app（数据"非实时，延迟 1–5 分钟"） | 每设备 日/周；部分机型 "In-depth Statistics" 给**应用/类别**，默认关闭 | 未查证 | 云 | 流量类告警：未查证（家长控制是另一套） |
| **GL.iNet 数据统计** | 关闭"网络加速"后的软件转发路径；只统计 Client 页上的设备 | 应用 + 协议 + 每设备（v4.11 起有 client selector）；1 小时/1 天/7 天 | ❌ **官方：开统计会自动关掉网络加速** | **RAM 每 15 秒、flash 每 1 小时**；软重启不丢、硬重启丢最多 1 小时 | 图表（Top10/折线/柱/饼）+ 一键封应用；无流量告警 |
| **LibreQoS** | **整形点**：v2 是 `tc` HTB + CAKE（+ eBPF/XDP），v3 是 **DPDK 用户态桥**（[v3 文档](https://libreqos.readthedocs.io/en/latest/docs/v3/index.html)） | 每 subscriber/circuit、每方向的 bytes/packets/RTT/重传 | ✅ 在整形点计数，不存在"被绕过"；但**分片（shard）后顶层计数器只是某个 worker 的份额**，官方专门警告 | JSON 快照（`bridge_leaf_stats_*.json`）+ 本地 API + NetFlow v9 导出 | 本地 WebUI/dashboard + 外部 collector |
| **pmacct**（nfacctd/sfacctd/pmacctd/uacctd） | 收 NetFlow/IPFIX/sFlow，或自己 libpcap/NFLOG 抓包 | 聚合原语极多（`src_host/dst_host/src_port/dst_port/proto/tos/as/...`，见 [CONFIG-KEYS](http://www.pmacct.net/CONFIG-KEYS-1.6.1)） | 取决于导出点 | SQL（MySQL/PG/SQLite）、Kafka/AMQP、文件 | 无 UI，进 BI/Grafana |
| **ntopng + nProbe** | nProbe 作探针（pcap→flow）或收流；ntopng 作 collector + 展示 | per-host/per-app(nDPI)/per-flow | 取决于探针 | Redis（必需件，OPNsense 的 os-ntopng 文档可佐证）+ 可选外部时序库 | 富 UI + 告警；**nProbe 是收费件**（MikroTik 官方文档也这么写） |
| **Home Assistant / Grafana** | 只做二次消费：SNMP OID、InfluxDB/Prometheus | 取决于数据源 | — | InfluxDB/Prometheus | Grafana 面板 + HA 自动化告警 |

### 1.2 三个口径差异（看表时容易踩）

1. **L2 还是 L3**：OPNsense 在 `ng_ether` 上数，字节含以太网头（14 B/包起）；我们的 conntrack 数是 L3 字节。**跨产品对不上账，多数时候差在这一层**，不是"谁算错了"。量化差异未查证。
2. **单计还是双计**：凡是在"接口/端口对"上数的（OPNsense ingress+egress、pfSense per-interface），NAT 场景天然会翻倍；凡是按连接数的（conntrack、pf state）不会。OPNsense 的解法是提供 "egress only" 开关把 ingress 过滤掉，而不是去重。
3. **瞬时速率还是区间积分**：ntopng 官方博文写得很清楚——抓包接口按 5 秒差分算速率；NetFlow/IPFIX 的吞吐是 `bytes/(flow_end-flow_start+1)` 的**平均**；sFlow 的每条"流"其实是一个被放大的采样包（[ntop 博文](https://www.ntop.org/how-sampling-and-throughput-calculation-works-netflow-ipfix-vs-sflow-vs-packets/)）。**我们的 5 分钟桶是积分，天然比"平均速率×时间"稳。**

---

## 二、分产品详解

### 2.1 OPNsense：Insight 其实是"Netgraph 在网卡上抓 + 本机 flowd 收 + SQLite 分层聚合"

**测量点（最关键的一条）**：看它的 rc 脚本就一目了然——`ng_ether:lower <-> ng_netflow:ifaceX <-> ng_netflow:export <-> ng_netflow:outX <-> ng_ether:upper`，也就是说 **netflow 节点被插在以太网层和上层协议栈之间**，包还没进路由/NAT 就已经被计过数了（[rc.d/netflow](https://github.com/opnsense/core/blob/master/src/etc/rc.d/netflow)）。

- 导出与分发：`ng_netflow` 把 flow 交给 `ksocket` 节点，再由 **`samplicate`** 复制/分发到多个目标（含 `127.0.0.1`）；本机收集器是 **`flowd`**，日志落 `/var/log/flowd.log`。
- 所以答案是：**不是 softflowd，是内核 `ng_netflow`（Netgraph）**；导出格式支持 NetFlow v5 与 v9。`softflowd` 是另一条可选路线，但 OPNsense 自己的文档就说 netgraph 实现"very fast with little overhead **compared to softflowd or pfflowd**"（[Netflow](https://docs.opnsense.org/manual/netflow.html)）。
- 聚合与保留（源码比文档可信，[source.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/aggregates/source.py)、[ports.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/aggregates/ports.py)）：
  - 每个聚合器一份 SQLite（`src_addr_%06d.sqlite`、`dst_port_%06d.sqlite`…），`%06d` 是分辨率；
  - 分辨率 **300 s / 3600 s / 86400 s** 三档；
  - TTL：300 s 档留 **1 小时**，3600 s 档留 **1 天**，86400 s 档留 **365 天**；`src_addr_details`（含 dst_addr/port/proto）只做 86400 档，留 **62 天**；
  - 原始 `flowd.log` 到 10 MB 就轮转，最多 10 份（[flowd_aggregate.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/flowd_aggregate.py)）。
  - ⚠️ 文档说"5 个粒度，含最近 2 小时/30 秒平均"（[Netflow](https://docs.opnsense.org/manual/netflow.html)），但当前 master 源码里**没有 30 秒档**——以源码为准，文档过时了。
- **per-app？没有。** Insight 的"Port Pie Chart"官方描述是"the percentage per **port/application**"（[Insight 文档](https://github.com/opnsense/docs/blob/master/source/manual/how-tos/insight.rst)）——把端口叫成应用。想真按应用分，只能装 `os-ntopng`（走 pcap + nDPI，还要 Redis）或第三方插件。
- 一个有意思的工程细节：`ports.py` 取 `min(dst_port, src_port)` 当"服务端口"，这是为了兼容"服务端不一定在 443/80"的启发式。
- **对我们**：它的"多层聚合 + 每层独立 TTL + 每聚合一份 DB"是本地存储的教科书答案；但"端口=应用"和"NAT 双计"是明确的反面教材（见 §5）。

### 2.2 pfSense：同一台机器上并存三种测量点，互相不解释

| 工具 | 测量点 | 代价 | 官方文档怎么说 |
|---|---|---|---|
| Traffic Graph | **pf 状态表**（`rate` 工具，`-i if -nlq 1 -Aba 20 -lc subnet`） | 极低（读状态表） | 3 秒刷新、Top10 主机（[status_graph.php](https://github.com/pfsense/pfSense/blob/master/src/usr/local/www/status_graph.php)） |
| Status → Monitoring | 接口计数器 → RRD | 低 | "只要接口级总量就用内置 RRD 图" |
| bandwidthd | libpcap | 中（逐包进用户态） | 有包、按 IP、**不支持多接口** |
| darkstat | libpcap | 中 | 同上，且**只存内存** |
| ntopng | libpcap 或 flow | 高（官方：**不建议低 CPU/低内存机器**） | 可多接口 |
| NetFlow | softflowd（pcap）或 pfflowd（pf 状态） | 低（导出而已） | 需要有 collector |

（上表事实来自 [pfSense Monitoring Bandwidth Usage](https://github.com/pfsense/docs/blob/master/source/monitoring/monitoring-bandwidth-usage.rst)；`rate` 的"less accurate"来自 [FreeBSD ports 描述](https://github.com/freebsd/freebsd-ports/blob/main/net-mgmt/rate/pkg-descr)。）

- **没有任何 per-app**（除非装 ntopng）。pfSense 的定位是"把数据导出去，分析交给别人"。
- 注意 `rate` 的语义：它是**统计/流式**工具，为了"输出不超过人能看的速率"而丢精度——这和 nlbwmon 那种精确计数器不是一个物种，**不能拿它的数字做账单**。
- **对我们**：pfSense 证明了"一台设备同时提供实时图 / 历史 RRD / 包级工具 / 流导出"是可行且被用户接受的组合；但四套数字互相对不上，是它长期被吐槽的点。

### 2.3 MikroTik RouterOS：五条互不相通的统计链，而且关键几条都被 FastTrack 掐着

1. **`/ip accounting`**：按 src/dst 地址对计数，内存里。**官方文档写明 FastTrack 的包绕过 IP accounting**——FastTrack 绕过清单是：Firewall、**Connection tracking**、Simple queues、Queue tree(parent=global)、**IP accounting**、IPSec、Hotspot universal client、VRF（[Connection tracking](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking)）。
2. **`/ip traffic-flow`**：NetFlow v1/v5/v9/IPFIX，导出到 UDP collector。官方两句关键话：
   - "Traffic Flow **only processes traffic that passes through the router's CPU**. HW-offloaded traffic (for example, HW-offloaded bridged traffic between switch-chip ports) **never shows up** in Traffic Flow."
   - "records flows at the end of the input, forward and output chain stacks… mirrored frames are dropped before they reach the input chain."
   - 采样可开（`packet-sampling` + `sampling-interval/sampling-space`，如 2222/1111）；flow cache 默认 256k（大内存机型）或 4k（最小机型）；active/inactive 超时默认 30m/15s（[Traffic Flow](https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/traffic-flow/)）。
   - `/ip/traffic-flow/monitor` 暴露 `finished-flows / active-flows / unmanaged-packets / unmanaged-bytes`——**这是我在所有产品里找到的最接近"自检计数器"的东西**。
3. **`/tool/apptraffic`**（RouterOS 7.26 手册里有，`!mmips,!powerpc,!smips`）：给出 **application / category** 的 bytes 与占比，窗口有 分钟/10 分钟/小时/天/周（[apptraffic stats](https://manual.mikrotik.com/docs/cli-reference/tool/apptraffic/stats/)）。
   - **重要限制**：字段里**没有 IP/MAC**，也就是"全网按应用"，**不能回答"哪台设备在看 YouTube"**；而且 mmips（hAP 系列常用架构）直接不支持。
   - 识别引擎是什么、准确率多少：**未查证**（手册只写开关）。
4. **Kid Control**：每设备 bytes-up/down + rate + 时间表限速，设备按 **ARP 表里的 MAC** 识别；限制手段是"动态防火墙规则或简单队列"（[Kid Control](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/kid-control)）。
5. **`/ip accounting` 在 7.26 新手册里已无对应章节**（我核对过 sitemap 与 `/cli-reference/ip/` 的 158 个条目，没有 accounting）。v6 时代的老文档（`mikrotik.com/testdocs`）有该功能。**v7 是否仍保留、是否有行为变化：未查证。**
6. 还有一条容易被忽略的：FastTrack 生效的条件之一是"**Sniffer、torch 或 traffic generator 没在运行**"——**即：要抓就得放弃加速**，这是 RouterOS 自己写进文档的取舍。
7. **Queues 统计（最容易被忽略的一路）**：simple queue 的只读字段有 `bytes{upload,download}`、`total-bytes`、`packets`、**`dropped`**、`rate`、`queued-bytes`（[queue/simple](https://manual.mikrotik.com/docs/cli-reference/queue/simple/)）。**这是"整形点测量"的第二例**（第一例是 LibreQoS）：它数的是"实际放行 + 实际丢弃"，conntrack 口径给不了丢弃数。
   - 注意绕过清单的原文是 "**Simple queues**" 与 "**Queue tree with parent=global**"（[Connection tracking](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking)）。按字面理解，**挂在接口上的 queue tree 不在绕过清单内**，可能仍在快路径上计数——**这是我的推论，未实测**；但它能解释为什么 RouterOS 社区常用"按接口挂 queue tree"做长期流量统计。

- **对我们**：MikroTik 是"静默失效"最典型的反面教材——功能还在、文档也写了"会绕过"，但产品层面没有拦截，用户看到的是 0 或偏小。我们的 `strict_accounting` 默认关 offload + 检测告警，正是针对这一点。

### 2.4 Ubiquiti UniFi：唯一被官方叫作 DPI 的家用/小型商用方案，但细节全闭源

- **能力**：官方文章把它叫 "Traffic and Device Identification"，并注明"**may also be referred to as Deep Packet Inspection or DPI**"；功能分两块：**Traffic Identification**（过网关的流量类型）与 **Device Identification**（设备类型/厂商/型号/OS）。**硬性要求是 UniFi 网关或云网关**（AP 不参与）——即 **DPI 在网关侧**。设备识别依赖流量识别（[help.ui.com](https://help.ui.com/hc/en-us/articles/12570783535383-UniFi-Gateway-Traffic-and-Device-Identification)）。
- **粒度**：应用 + 类别 + 客户端；官方 UI 里体现为 "Security Insights / Identified Traffic"，并可直接据此建 Traffic Rule 做限速或阻断。
- **引擎**：Ubiquiti **没有公开**引擎名称/版本/签名来源。社区常说的 "ubnt_dpi / nDPI"：**未查证**（我没有找到任何官方或可复核的 firmware 证据，不写结论）。
- **存储**：自托管 UniFi Network 应用需要外部 MongoDB（支持 3.6–8.0；9.0 起支持 8.0，[linuxserver 镜像文档](https://github.com/linuxserver/docker-unifi-network-application)）。云网关（UDM/UCG）内部库是设备本地的，具体表结构与 DPI 保留期：**未查证**。
- **性能影响 / 识别率**：官方**没有**公布 DPI 的吞吐折损或识别准确率（技术规格里通常只给 IDS/IPS 吞吐）。**未查证，不要引用任何具体百分比。**
- **抗 offload**：官方未说明 DPI 与硬件卸载是否互斥。**未查证。**
- **对我们**：UniFi 说明"网关侧 DPI + 设备识别 + 一键按应用限速"是这类产品的完整体验闭环；但它把"为什么这么判"完全藏起来，用户无法自证——这正是我们可以做得更好的地方（§4.2）。

### 2.5 家用产品：五个厂商，四种做法

#### (a) Firewalla —— 纯软件路径 + 元数据推断 + 事件型告警

- **测量点**：**纯 CPU 软件转发/检测路径**，官方原话："Firewalla is a purely software-based system, all processing is done via CPU cores… most routers rely on specialized hardware to forward packets. This specialized hardware is fast but does not have the flexibility"（[Speed Limitations](https://help.firewalla.com/hc/en-us/articles/360007752134-Firewalla-Speed-Limitations-Explained)）。速率瓶颈列到了"header lookup / route lookup / 规则条数 / **把包踢到用户态**"，间接瓶颈是"用户态包头解析、协议解码、IPS/IDS、流数量"。
- **per-app 是怎么做的**：官方明确"**不会看任何加密流量**"，看的是：MAC、IP、**域名**、**SSL 证书**、连接时长、上下行字节、**协议 user agent**、协议类型、HTTP 的 URL（[How deep does Firewalla look](https://help.firewalla.com/hc/en-us/articles/360008659013-How-deep-does-firewalla-look-at-network-packets)）。也就是说：**它不是 payload DPI，而是"域名 + SNI/证书 + UA + 元数据统计"的推断**，官方把这部分叫 "The Magic"。
- **维度**：每设备 live 吞吐（DHCP/Simple 模式下不支持）、每设备/整网 Data Usage（月/日）、月度流量套餐与告警（[Bandwidth Usage Monitoring](https://help.firewalla.com/hc/en-us/articles/360043859234-Bandwidth-Usage-Monitoring)）。
- **告警**：官方列了 10 类，其中第 6 条 "Devices going on/offline"、第 9 条 "New devices"、第 8 条 "Large Bandwidth usage"（[Deep Insights](https://help.firewalla.com/hc/en-us/articles/4410153017619-Firewalla-s-Deep-Insights)）。
- **云**：MSP（多设备托管）把数据放 AWS，且文档直说"有数据落地限制就别用"（[MSP 隐私说明](https://help.firewalla.com/hc/en-us/articles/15767230775699-Firewalla-MSP-Questions-related-to-privacy-and-data-visibility)）——**云聚合是可选加值，不是统计的前提**。

#### (b) eero —— 云端聚合，历史深度按订阅分层

- 官方："eero app 显示**每设备或每 profile** 用了多少数据。所有用户可看**周用量**与**实时用量**；eero Plus 订阅者可看**日/月**，最多 **3 个月**历史。"（[How do I monitor my network data usage](https://eero.com/support/articles/how-do-i-monitor-my-network-data-usage)）
- 口径：历史用量**只含 WAN 流量，不含内网设备间流量**；**桥接模式下没有用量数据**；实时用量刷新 **5 秒**，只对单设备。
- 隐私：官方声明 eero 软件**不跟踪浏览行为**；网络设置"安全地存在云端"（[eero 隐私说明](https://eero.com/support/articles/what-types-of-personal-information-does-eero-use-and-why)）。
- **per-app：没有**（Activity 页/设备详情只有 Usage + Security & privacy 两块，[Activity 变更说明](https://eero.com/support/articles/what-can-i-see-in-the-activity-tab)）。
- 结论：**家用 mesh 的"标准答案"= 每设备用量 + 云端 + 订阅制历史深度，不做 per-app。**

#### (c) Google Nest Wifi —— 每设备用量，30 天

- 官方：Google Home app 显示每设备上传/下载；"Devices 旁的数字=整网 WAN 总流量"；**显示近 30 天内用过的设备**（含当前不在线的）；Google Wifi app 可看当前 + **最长 30 天**历史（[support.google.com](https://support.google.com/googlenest/answer/6263633)）。
- per-app：无。流量类告警：未查证（家长控制是另一套，不代表有流量告警）。

#### (d) TP-Link Deco —— 唯一官方承认"按域名分类"的

官方 FAQ（2026-08-10 更新，[FAQ 5235](https://www.tp-link.com/au/support/faq/5235/)）：
- "Traffic Usage"：按 **Day / Week** 看，每设备排名；部分机型有 **In-depth Statistics**（按应用或类别），**默认关闭**。
- "**Traffic data is not real-time; expect a delay of 1–5 minutes**"；"**LAN-to-LAN traffic is not included**"。
- Q1 原文（关键）："Traffic usage is **classified based on domain names**. When you access a service like YouTube via a browser or an app, both use the same domain (e.g., youtube.com). The system merges this traffic into one category. Even if the app is not open, background access to the same domain may still be counted under that app's traffic."
- 即：**它的"按应用"= 按域名归并**，和我们"DNS 为主"的路线完全同构；连"后台访问同一域名会算进该应用"这个副作用都被官方写出来了。

#### (e) GL.iNet —— 最像"我们"的产品，连取舍都写在文档里

官方文档（固件 v4.9 起，[Data Statistics](https://github.com/gl-inet/docs4.x/blob/master/docs/en/docs/interface_guide/data_statistics.md)）：
- **维度**：应用 + 协议；**per-device（v4.11 起有 Client Selector）**；1 小时 / 1 天 / 7 天；Top10 应用图 + 应用明细（下载/上传/合计），可一键封应用。
- **与加速的关系（最重要）**："Data Statistics **cannot work with Network Acceleration**. Enabling Data Statistics will **automatically disable Network Acceleration** to ensure stable performance."
- **存储规则**："Traffic statistics are **saved to RAM every 15 seconds** and **stored in flash every 1 hour**"；软重启前先落盘；硬重启/保留配置升级**最多丢最近 1 小时**。
- **边界情况**：Drop-in Gateway 模式下不生效；**只统计 Client 页上的设备**；经隧道（VPN Client/Tailscale/AstroWarp）转发的流量**不计入**。
- **机型门槛**：支持列表清一色是 ≥256 MB～1 GB 的机型（MT6000/BE9300/BE3600/MT3000…），不支持列表包含 GL-AX1800、GL-AXT1800、GL-MT1300 等——官方理由写的是"insufficient memory"。**这直接印证了我们"lite/full 双档"的必要性。**
- **未查证**：应用识别是 DNS 还是 DPI 还是内置签名库（文档没写，仓库里也没有公开实现）。

### 2.6 LibreQoS：把"测量点"放在整形点上，是另一种正确

- **形态**：ISP/园区侧做 per-subscriber 整形与统计。**v3（当前，2026）改成 DPDK 用户态桥**（`bridge_rs` + `lqosd` 控制面），"the Linux tc/eBPF datapath of v2.0 is **removed**"（[v3 文档首页](https://libreqos.readthedocs.io/en/latest/docs/v3/index.html)）；v2 是 `tc` HTB + CAKE，并在部分路径用 eBPF/XDP。
- **v3 细节**（[What's new](https://libreqos.readthedocs.io/en/latest/docs/v3/whats-new.html)）：
  - CAKE 是默认 SQM（v2 默认 fq_codel）；动态 CAKE 默认开；
  - "Per-direction RTT / retransmit / packet counters are back end-to-end"；
  - 有 **unknown-IP 跟踪**（未映射主机单独一类，页面保留 300 s 最后出现窗口）；
  - 有 `do_not_track_subnets`（按网段退出 flows/RTT 统计）；
  - 自带 **NetFlow v9 exporter**，但官方自曝 "TCP_FLAGS / DST_TOS 是诚实的 0"，且"small-flow attribution 受 tracked-table 限制"。
- **最重要的一条（多点聚合陷阱）**：官方在"Honest caveats"里写——"**Sharded (W>1) per-leaf counters: 对跨 worker 分片的电路，顶层 `bridge_leaf_stats_*.json` 计数器只是某一个 worker 的份额，不是该电路的总量**"。
  - 这就是"多个测量点各自计数、需要正确合并"的真实翻车点：**不去重/不求和，你会得到 1/N 的流量**。
- **能不能借鉴到路由器**：**不能照搬**（tc + IFB + 多核分片 + DPDK 都是 x86/大内存假设），但**"在整形点量"**这个思路值得记：它是唯一能保证"统计值 = 实际放行值"的测量点。我们的场景没有整形，等价物是"在 conntrack 记账点上量（且确认没有被 offload 绕过）"。
- 吞吐数字：官方明确"Throughput walls scale with the active leaf count — never cite a blanket '40G' figure"——**别引用任何单一吞吐数字**。

### 2.7 pmacct / ntopng / nProbe：collector + probe 模式的标准答案

**pmacct**（[CONFIG-KEYS](http://www.pmacct.net/CONFIG-KEYS-1.6.1)）：
- 四个守护进程分工：`nfacctd`（收 NetFlow/IPFIX）、`sfacctd`（收 sFlow）、`pmacctd`（libpcap 抓包）、`uacctd`（NFLOG）。
- **聚合原语**（`aggregate`）：`src_host/dst_host/src_port/dst_port/proto/tos/src_as/dst_as/vlan/src_mac/dst_mac/in_iface/out_iface/…`，还有 `timestamp_start/timestamp_end`、`nat_event`、`post_nat_*`。
- **采样**：`sampling_rate` = "1 out of N，简单的随机算法"；`sampling_map` = **按 exporter 分别指定采样率**（因为"router OS 的采样上报常有 bug"）；`*_ext_sampling_rate` = 外部已采样（PF_RING/NFLOG/镜像口）；`*_renormalize` = 把采样计数还原成真实值。
- **时间分桶**：`sql_history` + **按流时长比例分摊到各时间桶**（官方例子：1000 s 的流、300 s 桶 → 300/300/300/100）。
  - **这条对我们非常关键**：我们的 5 分钟桶也可以对长连接按"存活区间占比"分摊，而不是"整个流记到结束那个桶"。

**ntopng / nProbe**（[ntop 博文](https://www.ntop.org/how-sampling-and-throughput-calculation-works-netflow-ipfix-vs-sflow-vs-packets/)）：
- 角色：nProbe 可以把包变成流（软件探针），也可以收流；ntopng 收流 + 用 **nDPI** 做应用识别 + 展示。
- **采样率的坑（原文要点）**：
  - 原文大意：**包采样在 NetFlow/IPFIX 里是可选的，在 sFlow 里是强制的**（"compulsory"）；
  - NetFlow/IPFIX exporter **通常不在流里写采样率** → collector 必须手工 `-S 1:x:1`；
  - sFlow 每条流自带可变采样率 → collector 自动放大；
  - **一个 nProbe 收多个 exporter 时，`-S` 是全局参数**——采样率不同的 exporter 必须起多个 nProbe 实例，否则数字静默错 N 倍。
- **吞吐语义**：抓包接口 5 秒差分；sFlow 单包放大（越少采样越不准）；NetFlow/IPFIX 用 `bytes/(end-start+1)` 的**平均速率**。
- 商业边界：**nProbe 收费**——连 MikroTik 官方文档都写"要用 ntopng 分析 RouterOS 得用 nProbe，而它是付费软件"（[Traffic Flow](https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/traffic-flow/)）。
- **对我们**：如果将来要接第三方 collector，**必须传采样率**（IPFIX 的 `samplingInterval`），否则对面一定算错；我们自己做 collector 时同理。

### 2.8 Home Assistant / Grafana：家庭用户实际怎么把数据变成图表和告警

- **HA 官方没有"每设备流量"集成**。最接近的是 **OpenWrt (luci)** 集成，但它只做**设备在线状态（device tracker）**，用于"人在不在家"的自动化（[HA 文档](https://www.home-assistant.io/integrations/luci/)）。
- 实际路径有三条：
  1. **SNMP 拉接口计数**（HA 的 SNMP 集成可读 OID）→ 只有接口级，没有 per-device；
  2. **导出到 InfluxDB/Prometheus，再用 Grafana 画**（HA 有 [InfluxDB 集成](https://www.home-assistant.io/integrations/influxdb/)）——这是"家庭数据栈"的主流；
  3. 社区项目把 nlbwmon 之类桥到 Prometheus/collectd 再进 Grafana（见 `research-traffic-capture.md` §4.2，此处不重复）。
- **告警**：HA 的自动化 + `notify` 是家庭场景的事实标准（"流量超阈值就发手机通知"）；Grafana 侧是 Alert rules → 邮件/Webhook。
- **对我们**：**别指望 HA 生态会替我们做统计**——它只会消费。我们的"飞书日报"在家庭场景里其实等价于"HA 通知 + Grafana 面板"，优势是零配置、开箱有中文报表；可以考虑额外提供一个 **InfluxDB/Prometheus 导出开关**，让爱折腾的用户接自己家的 Grafana（成本低、口碑收益高）。

---

## 三、三个判断题（横向答案）

### 3.1 硬件加速（flow offload / PPE / FastTrack）开着还能准确统计的，有几个？

**结论：0 个"两者兼得"的；能准确的都是做了取舍。**

| 产品 | 开加速还准吗 | 靠什么 |
|---|---|---|
| OPNsense | ✅ 准 | **在 L2（ng_ether）就数完**，包还没进路由/NAT。注：FreeBSD/pf 侧不存在 Linux flowtable 那种"绕过 netfilter 的卸载"，这一点是按数据路径结构推断的，未见官方明文表述 |
| pfSense | ✅ 准（状态表口径） | 读 pf state，不经过加速层；但 `rate` 本身是近似算法 |
| MikroTik | ❌ 不准 | 官方：FastTrack 绕过 connection tracking / simple queues / **IP accounting**；Traffic Flow 明说 HW-offload 流量永不出现 |
| GL.iNet | ❌ 不准 | 官方：开统计 → **自动关加速** |
| Firewalla | ✅ 准（但慢） | **纯软件路径**，没有可绕过的 ASIC；代价是吞吐随规则/流数下降 |
| LibreQoS | ✅ 准 | 在**整形点**数，整形点就是唯一出口 |
| UniFi | 未查证 | 官方未说明 DPI 与硬件卸载的关系 |
| eero / Google / Deco | 未查证 | 云端聚合，不公开网关内部实现 |
| pmacct / ntopng | 取决于导出点 | 导出器不准，collector 再准也没用 |

**三条可复用的"抗卸载"手法**（按代价从低到高）：
1. **把测量点前移到 offload 判定之前**（OPNsense 的 L2 钩子）——代价是要处理"同一包被两个接口各数一次"。
2. **在唯一的强制通过点计数**（LibreQoS 的整形点、我们可用的 conntrack 记账点）——前提是该点真的在路径上。
3. **关掉加速 + 明确告知**（GL.iNet 的做法，也是我们 `strict_accounting` 的做法）——代价是吞吐，但**用户知情**。
   - 反面是 MikroTik：功能留着、文档写了、UI 不拦，用户看到 0。
   - **一个值得记住的例外**：MikroTik 的绕过清单精确到 "Simple queues" 和 "Queue tree with parent=global"，**没写"所有 queue tree"**。如果真要在家用路由上"开加速还准"，理论上唯一的落脚点是"挂在接口上的 queue tree"（引用见 §2.3 第 7 条）。这是**未实测的推论**，但它是"绕过清单越精确，越能留出安全出口"的范例——**我们将来写 `strict_accounting` 的判定逻辑时，也应该精确到"哪一个具体机制导致不准"，而不是笼统说"offload 开了就不准"**。

**对我们的具体含义**：我们选的是 2+3 的组合（conntrack + 检测到 offload 就告警/关闭）。**业界没有更聪明的办法**，只有"前移到 L2"这一条我们还没用——而 MT7621 的 PPE 连硬件计数都没有（见 `research-traffic-capture.md`），L2 钩子只能靠 tc/eBPF 或 pcap，代价更高。**所以维持现方案是对的，但必须把"当前是否准确"做成显式状态，而不是假设。**

### 3.2 有没有产品用"多个测量点互相校验"来检测漏算？

**结论：作为"产品功能"没有；作为"局部机制"有 6 种，都值得抄。**

我把找到的全部列出来（按可借鉴度排序）：

| 机制 | 谁在用 | 具体做法 | 我们能不能抄 |
|---|---|---|---|
| **未识别/未归因单独计数** | RouterOS `traffic-flow/monitor` 的 `unmanaged-packets/bytes` | flow cache 认不出的包单独累计，而不是丢掉 | ✅ 直接抄：采集器必须有 `unaccounted` 计数器 |
| **未映射主机单列一类** | LibreQoS 的 "unknown IP" + `do_not_track_subnets` | 没进配置的主机不混进正常类目，页面显示 + 最后出现时间 | ✅ 抄：`unknown` 桶必须是显式维度 |
| **Top N + "rest" 桶** | OPNsense `get_top_data`（超过 `max_hits` 的合成一行 "rest of data"） | 保证"图上的总量 = 真实总量" | ✅ 抄：报表永远有 `other` 尾项 |
| **双计显式化 + 规避开关** | OPNsense ingress/egress + "egress only" | 文档承认 NAT 会翻倍，给开关让你只数一边 | ⚠️ 半抄：我们没有双计问题，但可以给"口径说明" |
| **分片计数器合并规则** | LibreQoS（顶层 JSON 只是单 worker 份额） | 官方文档明确警告，避免误读 | ✅ 抄：我们的"子路由 push 桶"如果同一设备被两个子路由计到，必须有合并规则（漫游去重） |
| **采样率重归一化** | pmacct（`sampling_map`/`renormalize`）、nProbe（`-S`） | 采样必须还原，且**按 exporter 分别配置** | ✅ 抄：将来接 IPFIX 时必带 `samplingInterval` |

**没有任何一家做"接口总量 vs 逐设备汇总"的差值校验**（我查了 OPNsense/pfSense/MikroTik/UniFi/LibreQoS/pmacct/ntopng 的文档与源码层面，均无此功能）。
→ **这是我们可以做差异化的地方**：路由器上有个天然免费的"第二测量点"——`/proc/net/dev` 的接口计数器。**接口总字节 − Σ(逐设备桶) = 差额**，差额超过阈值就说明"有流量没被归因"（offload、隧道、IPv6、广播/组播、pcap 漏抓…）。这个自检不需要抓包、不需要额外内核模块，成本几乎为零。

### 3.3 per-app：多少是真 DPI，多少是 DNS/端口推断？

**先说结论：真 DPI 是少数（ntopng/nProbe、pfSense-with-ntopng；UniFi 自称 DPI 但引擎未公开），主流家用是"域名归并"，OPNsense/老工具是"端口当应用"。而且没有任何一家公布准确率。**

| 产品 | 归因方式 | 证据 | 标称准确率 | 已知翻车场景 |
|---|---|---|---|---|
| **TP-Link Deco** | **域名归并**（官方原话） | [FAQ 5235](https://www.tp-link.com/au/support/faq/5235/) Q1 | 无 | 官方自己写了："后台访问同一域名也会算进该应用"；CDN 共用域名同理 |
| **Firewalla** | 元数据推断（域名/证书/UA/字节数/时长），**明确不看加密内容** | [How deep](https://help.firewalla.com/hc/en-us/articles/360008659013-How-deep-does-firewalla-look-at-network-packets) | 无 | 官方举的反例：**无法按 YouTube 视频粒度阻断** |
| **OPNsense Insight** | **端口**（"port/application"饼图） | [Insight 文档](https://github.com/opnsense/docs/blob/master/source/manual/how-tos/insight.rst) | 无 | 443 上的一切都是"HTTPS" |
| **MikroTik apptraffic** | 未查证（设备本地引擎） | [apptraffic](https://manual.mikrotik.com/docs/cli-reference/tool/apptraffic/stats/) | 无 | 不支持 mmips/powerpc/smips；且**不区分设备** |
| **MikroTik（Traffic Flow）** | 只有 5-tuple/端口，无 L7 | [Traffic Flow](https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/traffic-flow/) | 无 | 只能靠 collector 二次分类 |
| **UniFi** | 官方称 DPI；引擎与准确率未公开 | [help.ui.com](https://help.ui.com/hc/en-us/articles/12570783535383-UniFi-Gateway-Traffic-and-Device-Identification) | **未查证** | 未查证 |
| **ntopng / nProbe** | **nDPI**（真 DPI，含 TLS 指纹/JA3-JA4 等） | [ntop 产品线](https://www.ntop.org/how-sampling-and-throughput-calculation-works-netflow-ipfix-vs-sflow-vs-packets/) | 官方未给准确率 | 加密流量靠指纹；DoH/ECH 后能力下降 |
| **eero / Google Nest** | **不做 per-app** | [eero](https://eero.com/support/articles/how-do-i-monitor-my-network-data-usage)、[Google](https://support.google.com/googlenest/answer/6263633) | — | — |
| **GL.iNet** | 未查证（有应用维度，机制未公开） | [Data Statistics](https://github.com/gl-inet/docs4.x/blob/master/docs/en/docs/interface_guide/data_statistics.md) | 无 | 官方列了一堆"不计入"的情况 |
| **pfSense + bandwidthd** | 端口 → 协议色块（HTTP/TCP/UDP/ICMP/VPN/P2P） | [bandwidthd](http://bandwidthd.sourceforge.net/) | 无 | P2P 识别靠端口/启发式 |

**三条行业共识，可以直接写进我们的产品承诺：**
1. **没有一家公布准确率**——所以我们也别承诺百分比，改为承诺"**可解释**"：每个域名类目都能点开看"哪些 IP、哪段时间、命中哪条 DNS 记录"。
2. **DoH/ECH 是这个赛道的共同天花板**，不是我们的独有问题（Firewalla 直接承认不看加密流量；TP-Link 直接承认按域名）。
3. **"后台访问同一域名也算进该应用"是所有域名归并方案的固有副作用**（TP-Link 官方承认）——我们应该在 UI 上把它写成口径说明，而不是等用户来质疑。

---

## 四、可借鉴的 5 个设计点

### 4.1 多层聚合 + 每层独立 TTL + 每聚合一份库（抄 OPNsense）

- 他们的结构：`src_addr_{300,3600,86400}.sqlite`、`dst_port_{...}.sqlite`、`src_addr_details_86400.sqlite`；TTL 分别是 1 h / 1 d / 365 d，明细 62 d。
- 映射到我们（`PLAN.md` 已是 1m→5m→1h→1d 阶梯）：建议**再明确一条"明细 vs 汇总"的保留差异**——比如 `device × domain × 5min` 只留 7 天，`device × day` 留 365 天。
- **理由**：单一表 + 单一 TTL 一定会走向"要么爆盘、要么为了省盘把长周期也砍掉"。分文件还带来一个好处：**删旧数据 = 删文件，不用 `DELETE` + `VACUUM`**（OPNsense 每 8 小时才 vacuum 一次，说明这事很贵）。
- 出处：[source.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/aggregates/source.py)、[flowd_aggregate.py](https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/flowd_aggregate.py)

### 4.2 "可解释"优先于"准确率"（抄 Firewalla 的诚实 + 反 UniFi 的黑箱）

- Firewalla 把"我们看了什么"列成 9 条清单（MAC/IP/域名/证书/时长/字节/UA/协议/URL），并直说"不看加密流量、所以不能按视频粒度阻断"。**这句话反而建立了信任。**
- 我们的对应做法：每一条 per-app 记录都能下钻到"命中的 DNS 记录 / SNI / 端口兜底"三选一，并标注**置信度**（`dns` > `sni` > `port`）。
- **理由**：域名归并一定会错（TP-Link 官方都承认后台流量会被算进去），**唯一能挽回信任的是"错得看得见"**。
- 出处：[Firewalla](https://help.firewalla.com/hc/en-us/articles/360008659013-How-deep-does-firewalla-look-at-network-packets)、[TP-Link FAQ 5235](https://www.tp-link.com/au/support/faq/5235/)

### 4.3 把"加速 vs 统计"的冲突做成显式状态机（抄 GL.iNet，别抄 MikroTik）

- GL.iNet：开统计 → 自动关加速 → 文档写明代价。
- 我们已有 `strict_accounting`，建议再补两步：
  1. **状态位**：`accounting_confidence = exact | degraded | unknown`，由三个自检（`nf_conntrack_acct`、`rmem_max`、`flow_offloading`）算出，**在日报表头打印**；
  2. **降级而不是静默**：检测到 offload 时，要么按用户策略关掉，要么把报表标成"估算值（offload 开启）"，**绝不出一个看起来正常的错数**。
- **理由**：MikroTik 的教训是"文档写了但产品不拦"，用户不会读文档；GL.iNet 的教训是"自动关"会掉吞吐，必须让用户选。
- 出处：[GL.iNet Data Statistics](https://github.com/gl-inet/docs4.x/blob/master/docs/en/docs/interface_guide/data_statistics.md)、[RouterOS Connection tracking](https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking)

### 4.4 RAM 高频 + flash 低频 + 关机前落盘（抄 GL.iNet 的三条规则）

- 原文三条：① 每 15 秒写 RAM、每 1 小时写 flash；② 软重启前先落盘；③ 硬重启/升级最多丢最近 1 小时。
- 我们的对应：子路由**纯内存环形桶**，按小时把"已封口"的桶批量写 SQLite；`procd` 的 stop 钩子里 flush；把"最多丢 1 小时"写进文档而不是假装不丢。
- **理由**：16 MB NOR 的擦写寿命是真约束；而"丢 1 小时"对日报/周报完全可接受。**这两件事必须同时成立**——只做其中一个，要么写坏 flash，要么丢一天。
- 出处：[GL.iNet Data Statistics](https://github.com/gl-inet/docs4.x/blob/master/docs/en/docs/interface_guide/data_statistics.md)

### 4.5 用接口计数器做"零成本对账"（业界没人做，我们的差异化）

- 数据：`/proc/net/dev`（或 ubus `network.interface` 的 `statistics`）给接口 tx/rx 字节，**不依赖 conntrack、不受 offload 影响**（网卡计数器是硬件/驱动层的）。
- 算法：`差额 = 接口总字节 − Σ(该接口上所有设备桶)`；差额率 = 差额 / 接口总字节。
- 用法：
  - 差额率超过设定阈值（**建议先按 3–5% 观察，具体值必须自己在目标机型上实测**，因为 PPPoE/VLAN/MTU 会改变基线）→ 诊断页红字"有流量未被归因"，并在日报标注；
  - 差额率长期 ≈ 0 → 说明采集链健康，可以给个"✅ 已核对"。
- **理由**：这是唯一能自动发现"offload 偷偷生效 / 隧道流量 / 采集进程挂了"的手段，成本≈0；而 MikroTik/pfSense/OPNsense/UniFi **都没做**（§3.2 已核）。
- 注意：接口计数含 L2 头与重传，**不能要求差额为 0**，只能看趋势和量级——阈值必须自己实测（各机型 MTU/PPPoE/VLAN 不同）。

---

## 五、我们不该照抄什么（反面教材）

### 5.1 不要把"端口"包装成"应用"（反 OPNsense / nlbwmon）

OPNsense 的饼图叫 "port/application"（[Insight 文档](https://github.com/opnsense/docs/blob/master/source/manual/how-tos/insight.rst)），nlbwmon 的 `layer7` 是一张约 45 条的端口映射表。这在 443 承载一切的今天等于没分类。
→ **我们要么给到域名，要么明确写 `unknown`；不要给一个"HTTPS 60%"的假洞察。**

### 5.2 不要允许"加速开着 + 统计看起来正常"（反 MikroTik）

RouterOS 的 `/ip accounting` 在 FastTrack 下会被绕过，但据我查到的官方文档，产品层面没有任何强制拦截或告警机制（只有一句"FastTrack-ed packets are bypassing: … IP accounting"）。用户看到的数字**看起来完全正常**，只是偏小。
→ **我们的红线**：宁可拒绝启动/标红，也不产出"看起来正常的错数"（`PLAN.md` §2.2 已定这条，此处只是确认行业里确实有人踩过）。

### 5.3 不要用启发式工具做"账单"（反 pfSense `rate`）

`rate` 的 FreeBSD 包描述自己写着 "The output is less accurate, however"（[pkg-descr](https://github.com/freebsd/freebsd-ports/blob/main/net-mgmt/rate/pkg-descr)）。pfSense 的 Traffic Graph 就是拿它做的，适合"看看谁在占带宽"，**不适合"这个月这台设备用了多少 GB"**。
→ **实时速率与累计用量必须是两条链路**：速率可以近似（1 秒采样），累计必须是精确计数器。

### 5.4 不要用 pcap 做默认路径（反 bandwidthd / darkstat / softflowd）

三个共同问题：① 每包进用户态，MT7621 上代价高一档；② 单接口（pfSense 官方文档明说 bandwidthd/darkstat **不支持多接口**）；③ darkstat 只存内存，**重启即丢**（[man page](https://man.freebsd.org/cgi/man.cgi?query=darkstat&sektion=8)）。
→ 我们只在"可选 SNI 嗅探"这一小块用 pcap，且只解析每流前几个包，不做全量。

### 5.5 不要把 NAT 双计当成"口径差异"糊过去（反 OPNsense）

OPNsense 官方文档承认 ingress+egress 会 double count，解法是让你手动勾 "egress only"。这是**把正确性外包给用户**。
→ 我们的 conntrack 口径天然单计，但**多子路由漫游会双计**，必须自己做去重（`PLAN.md` §3.4 已有短窗口归并），不要让用户去理解"为什么这台手机用了 2 倍"。

### 5.6 不要做"闭源引擎 + 不披露准确率"（反 UniFi）

UniFi 把 DPI 完全黑箱：引擎不明、签名来源不明、准确率不公布、DPI 与硬件卸载的关系也不说（以上均**未查证**）。用户只能信或不信。
→ 我们做不到 UniFi 的识别率，但可以做到**每条归因都可下钻**。这是小团队唯一能赢的地方。

### 5.7 不要把历史深度做成付费墙（反 eero）

eero 免费 1 周、Plus 才有 3 个月（[官方](https://eero.com/support/articles/how-do-i-monitor-my-network-data-usage)）。这在商业上成立，但**开源插件学这个只会被骂**。
→ 可借鉴的是**视图分层**（实时 5 秒 / 周 / 月），不是**权限分层**。我们的历史深度应该只受 flash/RAM 限制，并在 UI 上告诉用户"再往前的数据已被清理"，而不是"升级解锁"。

### 5.8 不要把分片计数器当总量（反 LibreQoS 的已知坑）

LibreQoS 官方警告：跨 worker 分片的电路，顶层 `bridge_leaf_stats_*.json` 只是**单个 worker 的份额**。我们将来如果做多进程/多 worker 采集，同样会有"每个 worker 各写各的桶"的问题。
→ **凡是并行采集，必须有"按 (node, bucket, dims) 求和"的合并层**，并且**在文档里写清楚**。

---

## 附录 A：未查证清单（明确不写结论的项）

1. **UniFi DPI 引擎**：是否 nDPI / 自研 / 签名来源 / 版本节奏 —— 无官方或可复核来源。
2. **UniFi DPI 准确率**：官方未公布任何百分比。
3. **UniFi DPI 与硬件卸载的关系**：官方文档未提。
4. **UniFi DPI 数据的表结构与保留期**：只知道自托管用 MongoDB。
5. **eero / Google Nest / TP-Link Deco 的网关内部测量实现**：三家都只描述"app 显示什么"，不描述"怎么数的"。
6. **MikroTik apptraffic 的识别机制**：手册只有一个 `enabled` 开关；且 `!mmips,!powerpc,!smips`。
7. **RouterOS 7 是否仍提供 `/ip/accounting`**：7.26 新手册的 sitemap 与 `/cli-reference/ip/` 条目里都没有；v6 老文档有。行为是否变化未查证。
8. **GL.iNet 应用识别的实现**：官方文档只描述功能。
9. **各产品 pcap 路径在 TSO/LRO 下的字节偏差量级**：工程常识，但没找到量化来源。
10. **"接口总量 vs 逐设备汇总"的行业实践**：查过的产品里**没有**把这个做成功能（这正是 §4.5 的机会）。
11. **各产品 L2 头开销对账目的影响**：OPNsense 在 ng_ether 上数，理论上含 14 B/包的以太头，未找到官方说明。
12. **LibreQoS 具体吞吐**：官方明确要求"不要引用单一 40G 数字"，需带 leaf 数与硬件条件。

## 附录 B：来源清单

**OPNsense**
- 官方手册（Netflow/Insight 能力与双计说明）：https://docs.opnsense.org/manual/netflow.html
- Insight 使用文档（"port/application" 饼图、导出集合）：https://github.com/opnsense/docs/blob/master/source/manual/how-tos/insight.rst
- ntopng 插件文档（需 Redis）：https://github.com/opnsense/docs/blob/master/source/manual/how-tos/ntopng.rst
- 测量点（ng_ether ↔ ng_netflow 拓扑）：https://github.com/opnsense/core/blob/master/src/etc/rc.d/netflow
- 存储路径与默认值（`/var/netflow`、`/var/log/flowd.log`）：https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/__init__.py
- 聚合器与 TTL：https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/aggregates/source.py
- 端口聚合（`min(dst,src)` 启发式）：https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/lib/aggregates/ports.py
- 原始流日志轮转（10 MB×10）：https://github.com/opnsense/core/blob/master/src/opnsense/scripts/netflow/flowd_aggregate.py

**pfSense / FreeBSD**
- 带宽监控总览（各工具定位、多接口限制、ntopng 资源警告）：https://github.com/pfsense/docs/blob/master/source/monitoring/monitoring-bandwidth-usage.rst
- Traffic Graph 前端：https://github.com/pfsense/pfSense/blob/master/src/usr/local/www/status_graph.php
- 每 IP 速率实现（调用 `rate`）：https://github.com/pfsense/pfSense/blob/master/src/usr/local/pfSense/include/www/bandwidth_by_ip.inc
- `rate` 官方包描述（"less accurate"）：https://github.com/freebsd/freebsd-ports/blob/main/net-mgmt/rate/pkg-descr
- `darkstat` 包描述：https://github.com/freebsd/freebsd-ports/blob/main/net-mgmt/darkstat/pkg-descr
- `darkstat(8)` 手册（libpcap、内存表）：https://man.freebsd.org/cgi/man.cgi?query=darkstat&sektion=8
- BandwidthD 官网（2/8/40/400 天、sensor→DB）：http://bandwidthd.sourceforge.net/

**MikroTik**
- Connection tracking / FastTrack 绕过清单：https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking
- Traffic Flow（CPU-only、HW-offload 不可见、采样、cache 规模、unmanaged 计数）：https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/traffic-flow/
- `/tool/apptraffic` 字段（无 per-device、架构限制）：https://manual.mikrotik.com/docs/cli-reference/tool/apptraffic/stats/
- Kid Control（每设备 bytes、MAC 识别、限速实现）：https://manual.mikrotik.com/docs/firewall-and-quality-of-service/kid-control

**Ubiquiti UniFi**
- Traffic and Device Identification（=DPI、需网关）：https://help.ui.com/hc/en-us/articles/12570783535383-UniFi-Gateway-Traffic-and-Device-Identification
- 自托管 MongoDB 依赖：https://github.com/linuxserver/docker-unifi-network-application

**家用产品**
- Firewalla 元数据清单 / 不看加密流量：https://help.firewalla.com/hc/en-us/articles/360008659013-How-deep-does-firewalla-look-at-network-packets
- Firewalla 性能模型（纯软件 CPU）：https://help.firewalla.com/hc/en-us/articles/360007752134-Firewalla-Speed-Limitations-Explained
- Firewalla 用量监控：https://help.firewalla.com/hc/en-us/articles/360043859234-Bandwidth-Usage-Monitoring
- Firewalla 告警类型（新设备/离线/大流量）：https://help.firewalla.com/hc/en-us/articles/4410153017619-Firewalla-s-Deep-Insights
- Firewalla MSP 数据落地（AWS）：https://help.firewalla.com/hc/en-us/articles/15767230775699-Firewalla-MSP-Questions-related-to-privacy-and-data-visibility
- eero 用量（周/月、订阅分层、仅 WAN、桥接无数据）：https://eero.com/support/articles/how-do-i-monitor-my-network-data-usage
- eero 隐私（不跟踪浏览、云端存设置）：https://eero.com/support/articles/what-types-of-personal-information-does-eero-use-and-why
- eero Activity 页变更：https://eero.com/support/articles/what-can-i-see-in-the-activity-tab
- Google Nest（每设备、30 天、总量=WAN）：https://support.google.com/googlenest/answer/6263633
- TP-Link Deco（按域名分类、1–5 分钟延迟、不含 LAN）：https://www.tp-link.com/au/support/faq/5235/
- GL.iNet 数据统计（关加速、15s/1h 存储、机型门槛）：https://github.com/gl-inet/docs4.x/blob/master/docs/en/docs/interface_guide/data_statistics.md

**LibreQoS**
- v3 首页（DPDK 桥、tc/eBPF 已移除）：https://libreqos.readthedocs.io/en/latest/docs/v3/index.html
- What's new（计数器、unknown IP、NetFlow v9 导出、分片警告）：https://libreqos.readthedocs.io/en/latest/docs/v3/whats-new.html
- Known limitations（CAKE 默认、worker 公式）：https://libreqos.readthedocs.io/en/latest/docs/v3/known-limitations.html

**pmacct / ntop**
- CONFIG-KEYS（sampling_rate / sampling_map / renormalize / sql_history 分摊）：http://www.pmacct.net/CONFIG-KEYS-1.6.1
- ntop 采样与吞吐计算（NetFlow/IPFIX vs sFlow vs 抓包）：https://www.ntop.org/how-sampling-and-throughput-calculation-works-netflow-ipfix-vs-sflow-vs-packets/

**Home Assistant / Grafana**
- OpenWrt (luci) 集成（仅设备在线状态）：https://www.home-assistant.io/integrations/luci/
- SNMP 集成：https://www.home-assistant.io/integrations/snmp/
- InfluxDB 集成：https://www.home-assistant.io/integrations/influxdb/
