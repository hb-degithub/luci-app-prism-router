# OpenWrt 流量统计插件 · 采集与归因技术选型调研

> 目标系统：OpenWrt 23.05 / 24.10；目标硬件：MT7621、MT7981（128–512 MB RAM，16–128 MB flash）、部分 x86 软路由。
> 调研时间：2026-11-14。本文只做调研与选型，不含业务代码。
> 约定：**"实测"**=有可复核的原始来源；**"估算"**=按结构推导的量级，需在自己设备上实测；**"未查证"**=没有找到可信来源，不作结论。

---

## 0. 结论速览（先看这 6 条）

1. **单机"每设备流量"这一步不要自研**：`nlbwmon` 已经在官方 feed 里、下载体积约 17–22 KB、走 ctnetlink、默认就用，MT7621 可跑。([packages 索引 23.05](https://downloads.openwrt.org/releases/23.05.5/packages/mipsel_24kc/packages/Packages.gz))
2. **但 nlbwmon 数据模型里没有"目的地址"**，只有 `family/proto/dst_port/src_mac/src_addr` + 上下行计数（[database.h](https://github.com/jow-/nlbwmon/blob/master/database.h)）。**它从原理上给不了 per-app/per-site**，这一层必须自研。
3. **per-app 归因的现实组合 = DNS 日志为主 + TLS SNI 为辅 + 端口/ASN 兜底**，业界（netifyd）也是这个路子：它的 status 输出里明确有 `DNS hint cache: enabled`（[netifyd OpenWrt 文档](https://www.netify.ai/documentation/agent/v4/install/agent/openwrt)）。全流量 DPI（netifyd 路线）在目标硬件上代价过高：官方要求 **≥256 MB RAM**，包体积约 1 MB（下载）/ 解包约 3.8 MB。
4. **最大的坑不是 CPU，是"offload 绕过 conntrack"**：OpenWrt 官方 wiki 明说用了 flow offloading 后这类统计"可能记录不准"（[Bandwidth Monitoring Guide](https://openwrt.org/docs/guide-user/services/network_monitoring/bwmon)），而 MediaTek 从 **mt7621 起**就支持硬件 offload（[Flow Offloading](https://openwrt.org/docs/guide-user/perf_and_log/flow_offloading)）。MT7621 的 PPE **没有 per-flow accounting**，硬转下逐主机统计会偏低甚至为 0（[luci-app-traffic-survey](https://github.com/Become-ILLUSORY/luci-app-traffic-survey)）。
5. **第二大的坑是 netlink 缓冲区**：在 ramips/mt7621 + OpenWrt 25.12 上已复现 —— `net.core.rmem_max=180224` 小于 nlbwmon 默认 `netlink_buffer_size=524288`，`setsockopt` 被内核静默截断，于是连续 24 小时 `Unable to dump conntrack: No buffer space available`，**而 conntrack 只有 200–350 条**（[nlbwmon issue #76](https://github.com/jow-/nlbwmon/issues/76)）。这会让统计静默少算，必须在安装时检测。
6. **多机汇总只能是"子→母 出站 push"**：子路由在 NAT 后，母路由无法主动拉取；且子路由自己做 NAT 时，母路由根本看不到子网客户端。所以聚合必须发生在子路由侧，母路由只做汇总、报表、告警。

---

## 一、方案对比表

### 1.1 数据来源与核实方法

包是否存在、版本、体积，全部取自官方发布索引（不是二手资料）：

- 23.05.5 / MT7621 架构 `mipsel_24kc`：[packages 索引](https://downloads.openwrt.org/releases/23.05.5/packages/mipsel_24kc/packages/Packages.gz)
- 24.10.0 / MT7981 架构 `aarch64_cortex-a53`：[packages 索引](https://downloads.openwrt.org/releases/24.10.0/packages/aarch64_cortex-a53/packages/Packages.gz)、[luci 索引](https://downloads.openwrt.org/releases/24.10.0/packages/aarch64_cortex-a53/luci/Packages.gz)
- 历史版本（18.06/19.07/21.02/22.03/23.05）同为各版本 `mipsel_24kc` 索引，下文"曾存在于…"即由此比对得出。
- 内核模块取自 target 的 kmods 索引：[23.05.5 ramips/mt7621 kmods](https://downloads.openwrt.org/releases/23.05.5/targets/ramips/mt7621/kmods/)、[24.10.0 mediatek/filogic kmods](https://downloads.openwrt.org/releases/24.10.0/targets/mediatek/filogic/kmods/)

> 体积口径说明：下表一律用索引里的 `Size` 字段（即 `.ipk` 下载体积，字节，跨版本可比）；两版索引的 `Installed-Size` 口径不一致（23.05 与 24.10 的数量级比值差异很大），因此**不用它做跨版本比较**，只在需要时说"解包后约为下载体积的 3–4 倍"。

### 1.2 主表

| 方案 | 采集机制 | 数据粒度 | 资源量级（官方包体积 / 运行开销） | 官方 feed 是否存在（23.05 / 24.10） | 维护状态 | MT7621 可行性 |
|---|---|---|---|---|---|---|
| **nlbwmon** (+luci-app-nlbwmon) | conntrack netlink（ctnetlink dump + 事件），计数器 zero-on-read | per-IP、per-MAC、per-远端端口（"layer7"实为端口表，默认约 45 条）。**无目的地址、无 per-flow** | 下载体积 23.05: 17.4 KB；24.10: 21.7 KB（解包约 3–4 倍）。另有 `luci-app-nlbwmon`（luci feed）。默认 DB 上限 10000 条，单条约 72 B → 磁盘约 0.7 MB | 有 / 有（23.05 分支为 2021-09-01、24.10 分支为 2024-02-21，均落后于 master 的 2025-06-02；见 [23.05 Makefile](https://raw.githubusercontent.com/openwrt/packages/openwrt-23.05/net/nlbwmon/Makefile) / [24.10 Makefile](https://raw.githubusercontent.com/openwrt/packages/openwrt-24.10/net/nlbwmon/Makefile)） | 上游活跃，作者 Jo-Philipp Wich（OpenWrt 核心开发者），GitHub 最后提交 2025-06-02 | ✅ 可行，是事实标准；但有 rmem 陷阱与 offload 失效（见 §4） |
| **bandwidthd** | libpcap 抓包 + 自建 HTML 图 | per-IP，按子网分组 | 33 KB（22.03 版本下载体积） | **无 / 无**（18.06、19.07、21.02、22.03 都有，**23.05 起从 feed 消失**） | 事实停更（上游 SourceForge 时代产物） | ⚠️ 不建议：23.05 起官方已不提供，需自行移植 |
| **vnstat** (+vnstati, luci-app-vnstat2) | 读 `/proc/net/dev` 的接口计数器 | **仅接口级**，没有 per-host | 23.05: 69 KB；24.10: 77 KB | 有 / 有（1.18） | 活跃 | ✅ 可行，但答不了"每设备"。官方 wiki 明确"Vnstat 只监控接口级" |
| **ntopng** | libpcap/flow + nDPI DPI，可做 flow collector | per-host + per-app + per-flow | 官方只为 Debian/Ubuntu/RPi/FreeBSD 等出包 | **无 / 无**（18.06→23.05 全版本索引均无）；OpenWrt wiki 也标注"in repo: **no**" | 上游非常活跃（8.3k★，2026-11 仍在提交） | ❌ 不适合：官方不打包，体积/内存远超 128 MB 设备 |
| **netifyd** | conntrack(ctnetlink) + libpcap + DPI 引擎；带 DNS hint cache | per-flow + per-app（DPI 分类）+ 可 JSON/HTTP 推送 | 23.05: 911 KB；24.10: 1.0 MB（下载；解包约 3.8 MB，另需 libstdc++ 等依赖）。官方文档要求 **≥256 MB RAM**；示例 status 显示 8 条流时 `max memory 15124 kB`、CPU 0.1% | 有 / 有（4.4.7） | **上游活跃但与 feed 脱节**：GitLab 最新 tag v5.2.8-1（2026-06-23），feed 仍停在 v4.4.7 | ⚠️ 128 MB 机型基本出局；512 MB 可试，但要注意 feed 版本落后一个大版本 |
| **softflowd** | libpcap 采样 → NetFlow v5/v9 | per-flow 导出（本身不落库） | 23.05: 26 KB；24.10: 29 KB | 有 / 有（1.1.0） | 上游活跃（2026-11 仍有提交） | ✅ 技术上可行，但**只是导出器**，还要另一台机器收；且 pcap 抓包在 MT7621 上是额外开销 |
| **ipt-netflow** | 内核模块（iptables target）直接导出 NetFlow | per-flow | 未打包 | **无 / 无**（全版本索引无） | 基本停更：[alex-eri/ipt-netflow](https://github.com/alex-eri/ipt-netflow)（自称 official）最后提交 2017-07，镜像仓库 2023 年仅有零星提交 | ❌ 不可行：无包、内核 5.15/6.6 适配存疑；iptables 路线在 22.03+ 已被 nftables 取代（旁证：iptables 计数工具 iptmon 就是因此在 22.03 失效，见 [nlbw2collectd](https://github.com/mstojek/nlbw2collectd)） |
| **ulogd** | netfilter 日志（nfacct / nfct / nflog）→ 文件/SQL | per-flow（nfct）或 per-rule 计数（nfacct） | 23.05: 21 KB；24.10: 24 KB（+ 各 mod 插件） | 有 / 有（2.0.8；feed master 已到 2.0.9） | 活跃（2025 年仍有 Makefile 更新） | ⚠️ 能跑，但要落 SQL/文件，写放大对 flash 不友好；更适合当"备用取数口" |
| **xt_ndpi / nDPI** | 内核 xtables 匹配器（xt_ndpi） / 用户态库（libndpi） | per-flow L7 分类 | libndpi 下载体积 23.05: 613 KB；24.10: 688 KB（解包约 2.4 MB） | **xt_ndpi 无**（全版本索引无）；**libndpi 有包但无人依赖**（23.05/24.10 索引中依赖 libndpi 的包数量为 0） | libndpi 上游活跃 | ❌ 不建议押注：没有 iptables 匹配器包，libndpi 在官方 feed 里是"孤儿包"；内核态 DPI 与 flow offload 天然冲突 |
| 内核原语：`nf_conntrack_acct` | conntrack 扩展，ct 上记 orig/reply 的包数与字节 | per-connection 计数 | 0（内核内建） | ✅ 默认开启 | 内核主线 | ✅ 这是本方案的地基。OpenWrt 通过 kmod-nf-conntrack 安装 `/etc/sysctl.d/11-nf-conntrack.conf`，其中 `net.netfilter.nf_conntrack_acct=1` |
| 内核原语：nftables flowtable 计数 | flowtable offload（软/硬） | 卸载后的包不再过 netfilter，conntrack 计数停止更新；也没有面向用户的 per-host 计数接口 | 0 | ✅ `kmod-nft-offload` 在 23.05/24.10 kmods 索引中都有 | 内核主线 | ❌ 反向指标：开了它就等于把统计关掉 |
| 内核原语：tc / eBPF 计数 | `tc` 分类器 + action 计数；`kmod-sched-bpf` 可挂 eBPF | 按接口/按分类，不天然 per-host | `kmod-sched-bpf` 40 KB、`kmod-ifb` 20 KB | ✅ 模块可装 | 内核主线 | ⚠️ 可行但工程量大：要自己写分类规则把 host 映射到 class，且 128 MB 设备上 eBPF 工具链/内存都不划算 |

### 1.3 几个必须说清的细节

**nlbwmon 到底记了什么**（决定了它能不能满足需求 2）：

```
struct record {
    uint8_t family; uint8_t proto; uint16_t dst_port;
    src_mac; src_addr;            /* 只有源侧 */
    count; out_pkts; out_bytes; in_pkts; in_bytes;
};
```
—— 来源：[database.h](https://github.com/jow-/nlbwmon/blob/master/database.h)。没有 `dst_addr`、没有 per-flow 记录，`layer7` 是"远端端口 → 协议名"的静态映射表（默认约 45 条，[README](https://github.com/jow-/nlbwmon)）。**结论：nlbwmon 只能回答"哪台设备用了多少"，回答不了"访问了哪个站"。**

**nlbwmon 的默认参数**（决定了开销与丢数风险）：`refresh_interval 30s`、`commit_interval 24h`、`database_limit 10000`、`database_directory /var/lib/nlbwmon`、`database_generations 10`、`database_compress 1`、`netlink_buffer_size 524288`。来源：[feed 里的默认配置](https://git.cdn.openwrt.org/feed/packages/plain/net/nlbwmon/files/nlbwmon.config)。注意默认库目录 `/var/lib/nlbwmon` 落在内存里——OpenWrt 的 base-files 把 `/var` 做成指向 `tmp` 的符号链接（[base-files/Makefile](https://raw.githubusercontent.com/openwrt/openwrt/openwrt-24.10/package/base-files/Makefile)），所以**重启即丢**。这对 flash 友好，但要求持久化就得改到 `/etc` 或外置存储（代价是写放大）。

**netifyd 的 DPI 引擎不在 OpenWrt 依赖里**：feed Makefile 的 `DEPENDS` 是 `ca-bundle libatomic libcurl libmnl libnetfilter-conntrack libpcap zlib libpthread libstdcpp`，**没有 libndpi**（[netifyd Makefile](https://git.openwrt.org/feed/packages/plain/net/netifyd/Makefile)），说明 DPI 引擎随其源码内置，而不是复用 feed 里的 libndpi。

**OpenWrt 确实默认开了 conntrack 记账**：`kmod-nf-conntrack` 会安装 `/etc/sysctl.d/11-nf-conntrack.conf`（[netfilter.mk](https://raw.githubusercontent.com/openwrt/openwrt/openwrt-24.10/package/kernel/linux/modules/netfilter.mk)），内容含 `net.netfilter.nf_conntrack_acct=1`（[sysctl-nf-conntrack.conf](https://raw.githubusercontent.com/openwrt/openwrt/openwrt-24.10/package/kernel/linux/files/sysctl-nf-conntrack.conf)）。这一点很关键：主线内核里 acct 扩展的默认值是 **关**（`static bool nf_ct_acct __read_mostly;`，[nf_conntrack_acct.c](https://raw.githubusercontent.com/torvalds/linux/v6.6/net/netfilter/nf_conntrack_acct.c)），是 OpenWrt 用 sysctl 打开的；**所以任何自研采集器都必须显式校验这个 sysctl，不能假设**。

---

## 二、per-app / 站点归因：手段与失效边界

### 2.1 五种手段的对比

| 手段 | 能看到什么 | 成本 | 失效条件 |
|---|---|---|---|
| **DNS 查询日志**（dnsmasq `--log-queries=extra`） | 客户端 IP + 查询名 + 应答；据此建 `域名→IP 集`，再与连接的目的 IP 关联 | 极低（每查询一行日志） | 客户端自带 DoH/DoT；明文 DNS 走非 dnsmasq 通道；CDN 共用 IP；域名泛解析/短 TTL |
| **TLS SNI 嗅探** | ClientHello 里的明文 SNI → 精确到域名 | 中（要在每流早期抓包） | ECH（SNI 加密）；非 TLS 流量；SNI 与实际内容不一致（域前置） |
| **QUIC 分析** | QUIC Initial 包可由观察者解出 ClientHello（含 SNI） | 中高 | 需要实现 Initial 解密；后续包不可读；HTTP/3 普及后价值上升 |
| **端口/协议表** | 如 443→HTTPS、3478→STUN | 极低 | 无法区分同端口下的不同站点/应用 |
| **全流量 DPI**（nDPI 类） | 应用层指纹，能识别非 TLS 应用 | 高（内存 + CPU + 包体） | 加密流量只能靠指纹/统计特征；模型/规则需持续维护 |

### 2.2 DNS 这一路：能力与做法（推荐主力）

- dnsmasq 有 `-q, --log-queries[=extra|proto|auth|only_failed]`，其中 `=extra` 会在每行前加"序号 + 请求方 IP"，`proto` 再加协议；`--log-facility` 可以直接写文件（含 `/` 即视为路径）。来源：[dnsmasq man page](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)。
- OpenWrt 的 dnsmasq init 已把 UCI `option logqueries 1` 翻译成 `--log-queries=extra`，`logfacility` 翻译成 `--log-facility`。来源：[dnsmasq.init](https://raw.githubusercontent.com/openwrt/openwrt/openwrt-23.05/package/network/services/dnsmasq/files/dnsmasq.init)。**也就是说开箱就能拿到"哪台设备查了什么域名"，不需要装任何东西。**
- 默认走 syslog → OpenWrt 是 logd 的 RAM 环形缓冲。生产上应改为写文件到 tmpfs，并自己做消费+轮转，否则高峰期会挤掉其它日志。
- **归因精度边界**：DNS 只给出"域名 → 一段时间内的 IP 集合"，然后靠"连接的目的 IP ∈ 该集合"来归属。所以
  - CDN（一个域名对应大量 IP、且 IP 被多域名共享）→ 会把流量算到"最后一个解析它的域名"上；
  - 一个连接可能同时匹配多个域名 → 需要策略（最近一次解析优先 / 端口+时间窗 / 打分）；
  - 解析失败或命中缓存的连接 → 归到 `unknown`。
- **明确不做**：odhcpd 不承担 DNS 解析（它是 DHCPv6/RA 守护进程），所以"DNS 归因"只有 dnsmasq（或 unbound/AdGuardHome 等替代品）这一条路；换 DNS 软件就要重做适配。

### 2.3 SNI 这一路：还能用，但在退化

- TLS SNI 在 ClientHello 里是明文，被动观察可读 —— 这是所有"按站点统计"的商业设备的基础能力。
- **ECH 是终点**：`TLS Encrypted Client Hello` 已作为 **RFC 9849（2026-03，Proposed Standard）** 发布（[RFC 索引](https://www.rfc-editor.org/rfc/rfc-index.txt)，条目见 RFC 9849）。ECH 生效时 SNI 被加密，**基于 SNI 的分类直接失效**，只剩"目的 IP + 端口"可用。
- ECH 的部署前提是 DoH（客户端要先拿到 HTTPS RR），所以"ECH 普及"与"DoH 普及"是同一件事。浏览器/地区维度的默认开启比例**未查证**（我不给出具体百分比）。
- **DoT**：RFC 7858（[RFC 索引](https://www.rfc-editor.org/rfc/rfc-index.txt)），走 853，端口可见、内容不可见 → DNS 归因失效，但至少能看到"这台设备在用 DoT"。
- **DoH**：RFC 8484，混在 443 里，连"在用 DoH"都难判定 → 对 DNS 归因是双重打击。
- **QUIC/HTTP3**：QUIC 的 Initial 包用"DCID + 固定 salt"派生密钥（[RFC 9001](https://www.rfc-editor.org/rfc/rfc9001.html)，§5.2），**所以在路上是可以解出 ClientHello 的** —— 这既是机会（HTTP/3 也能拿 SNI）也是陷阱（实现复杂度不低；一旦上 ECH 同样失效）。

### 2.4 业界实际在用什么组合

1. **DNS 提示 + DPI**：netifyd 的 status 输出里同时有 conntrack 采集和 `DNS hint cache: enabled`（[Netify Agent v4 on OpenWrt](https://www.netify.ai/documentation/agent/v4/install/agent/openwrt)）。这是"DPI 厂商也承认 DNS 是最便宜的强信号"的直接证据。
2. **DPI 为主**：ntopng/nDPI 系（[ntopng](https://github.com/ntop/ntopng)、[nDPI](https://github.com/ntop/nDPI)），代价是体积和内存。
3. **纯 DNS/端口启发式**：各类家用插件（如按目标域名统计的 LuCI 插件，见 §4.2），成本最低、准确率够用。
4. 结论：**家用/小办公场景，"DNS 为主 + SNI 兜底 + 端口/ASN 最后兜底"是性价比最高的组合**；DPI 只在 x86 或 ≥512 MB 的 ARM 上作为可选增强。

---

## 三、推荐架构（哪一层用什么技术）

### 3.1 分层

```
┌─ L0 内核 ────────────────────────────────────────────────┐
│ conntrack + nf_conntrack_acct=1（OpenWrt 默认已有）        │
│ 硬性要求：关闭 software/hardware flow offloading           │
└──────────────────────────────────────────────────────────┘
            │ ctnetlink（事件订阅 + 低频快照）
┌─ L1 采集（自研，跑在每台 OpenWrt 上）────────────────────┐
│ 逐流记录：{5-tuple, 客户端 MAC/IP, 目的 IP/端口, 上下行字节}│
│ 复用 nlbwmon 的坑位经验：检查 rmem_max ≥ netlink_buffer     │
│ 输出：5 分钟聚合桶（device × dst_ip × dst_port）           │
└──────────────────────────────────────────────────────────┘
            │
┌─ L2 归因（自研，同一进程或旁路进程）─────────────────────┐
│ 主：dnsmasq --log-queries=extra → 域名↔IP 时效映射          │
│ 辅：TLS SNI（每流只看前几个包）；QUIC Initial 可选          │
│ 兜底：端口表（复用 nlbwmon protocols 思路）+ 未识别桶        │
│ 输出：device × domain(或 app 类别) × 5 分钟桶               │
└──────────────────────────────────────────────────────────┘
            │ 出站 HTTPS/MQTT（子路由在 NAT 后也能通）
┌─ L3 存储/汇总（母路由）──────────────────────────────────┐
│ SQLite（WAL）→ 日报/周报；飞书 webhook 告警                 │
│ 可选：同时接收 softflowd 的 IPFIX，兼容非 OpenWrt 子节点     │
└──────────────────────────────────────────────────────────┘
```

### 3.2 每层的选型理由

| 层 | 选什么 | 为什么不选替代 |
|---|---|---|
| L0 计数 | **conntrack + acct**（内核自带，零安装） | nftables flowtable 是为吞吐设计的，明确绕过 netfilter，也没有 per-host 计数接口（[Flow Offloading](https://openwrt.org/docs/guide-user/perf_and_log/flow_offloading)）；tc/eBPF 需要自建分类映射，工程量与收益不匹配 |
| L1 采集 | **自研 ctnetlink 客户端**（C 或 ucode+C 混合），事件订阅为主、全量 dump 为辅 | 直接用 nlbwmon 拿不到目的地址（[database.h](https://github.com/jow-/nlbwmon/blob/master/database.h)）；用 libpcap（softflowd 路线）在 MT7621 上要逐包进用户态，代价高一档 |
| L2 归因 | **dnsmasq 日志为主**，SNI 为辅 | netifyd 的 DPI 要求 ≥256 MB RAM、解包约 3.8 MB，128 MB 机型直接出局；xt_ndpi 在官方 feed 里根本不存在 |
| L3 汇总 | **子路由主动 push 到母路由**（HTTPS 或 MQTT），母路由 SQLite + 报表 | 子路由在 NAT 后，母路由无法反向拉取；且子路由自己 NAT 时母路由看不到其客户端。pull 模型在这里不成立 |
| 报表 | 母路由生成 Markdown/HTML + 飞书 webhook（消息卡片或文件） | — |

### 3.3 关于"能不能直接复用 nlbwmon"

可以，但要分清两种用法：

- **用法 A（省事）**：每设备总量直接读 nlbwmon（`nlbw -c json`），我们只补 per-app 那一层。优点：L1 几乎零开发；缺点：两套数据源对不上账（nlbwmon 丢数时我们不知道），且 nlbwmon 的"layer7"和我们的域名归因会打架。
- **用法 B（推荐）**：自研 L1，把 nlbwmon 只作为**交叉校验/降级备份**（例如我们的进程挂了，LuCI 里还有 nlbwmon 的图）。
- **无论哪种**，安装脚本都必须做两件事：`sysctl net.netfilter.nf_conntrack_acct` 必须为 1；`net.core.rmem_max` 不得小于我们请求的 netlink buffer，否则会出现 [issue #76](https://github.com/jow-/nlbwmon/issues/76) 那种"连续 24 小时 dump 失败但界面照常显示"的静默故障。

### 3.4 多机汇总的数据模型（关键约束）

- **不要传原始流**：一台 20 设备的路由器每天几十万条流，传到母路由再入库，flash 和 RAM 都受不了。**只传聚合桶**：`(child_id, device_mac, domain_bucket, 5min_ts, up_bytes, down_bytes)`。
- **必须有 `child_id`**：设备 MAC 在不同子网可能重复（同型号设备、随机 MAC），只有 `child_id + mac` 才唯一。
- **时间**：所有桶带 UTC 时间戳，母路由按子路由上报的时区偏移换算；子路由 NTP 未同步时要拒绝上报（否则日报会错位）。
- **幂等**：桶以 `(child_id, bucket_start, dims)` 为唯一键 upsert，允许重传。
- **漫游去重**：同一台手机在子 A、子 B 之间漫游会两边都计数。聚合层需要一个短窗口归并策略（或明确接受"按接入点统计"的口径，并在报表里注明）。
- **断网补传**：子路由要有本地环形缓冲（内存为主，落盘要限速），恢复后补传并靠幂等键去重。

---

## 四、风险与未解决问题

### 4.1 硬性风险（会直接导致数据错）

| 风险 | 影响 | 依据 / 缓解 |
|---|---|---|
| **flow offloading 开启** | offloaded 流不再更新 conntrack 计数 → 总量偏小甚至为 0 | OpenWrt wiki 明示"用了 flow offloading 这些数据可能记录不准"（[bwmon](https://openwrt.org/docs/guide-user/services/network_monitoring/bwmon)）；MediaTek 自 **mt7621** 起支持 HFO（[Flow Offloading](https://openwrt.org/docs/guide-user/perf_and_log/flow_offloading)）。缓解：安装时检测 `firewall.@defaults[0].flow_offloading`，非 0 就告警并建议关闭 |
| **MT7621 的 PPE 无 per-flow accounting** | 即使想做"硬转下也统计"，老 SoC 也没有硬件计数器可回灌 | 第三方实测总结：MT7981/7986/7988（`per_flow_accounting=true`）可回灌，**MT7621/7622 的 PPE 为 false**，硬转下统计不准（[luci-app-traffic-survey](https://github.com/Become-ILLUSORY/luci-app-traffic-survey)）。这条属于第三方结论，建议自行在目标机型复核 |
| **全锥形 NAT（`kmod-nft-fullcone`）** | 有报告称 nlbwmon 收不到 conntrack 事件、统计恒空 | 来源：[luci-app-mihomo-traffic README](https://github.com/hoobnn/luci-app-mihomo-traffic)（第三方陈述，未在官方 issue 中复核，**待验证**） |
| **netlink 缓冲区不足（ENOBUFS）** | dump 失败但进程不退出 → 静默少算 | [issue #76](https://github.com/jow-/nlbwmon/issues/76)（ramips/mt7621 实测）；同类：[#60](https://github.com/jow-/nlbwmon/issues/60)、[#43](https://github.com/jow-/nlbwmon/issues/43)。缓解：启动时读 `net.core.rmem_max`，把 buffer 请求值 clamp 到该值以下，并记录实际生效值 |
| **conntrack 表满 / 长连接** | 表满时新流建不上、旧流被提前销毁；`tcp_timeout_established=7440`（124 分钟）意味着长连接要等到超时才最终结算 | sysctl 默认值见 [11-nf-conntrack.conf](https://raw.githubusercontent.com/openwrt/openwrt/openwrt-24.10/package/kernel/linux/files/sysctl-nf-conntrack.conf) |
| **DoH/DoT/ECH** | DNS 归因对启用了加密 DNS 的客户端失效；ECH 让 SNI 也失效 | [RFC 8484](https://www.rfc-editor.org/rfc/rfc8484.html)、[RFC 7858](https://www.rfc-editor.org/rfc/rfc7858.html)、[RFC 9849](https://www.rfc-editor.org/rfc/rfc-index.txt) |
| **flash 写入寿命** | 高频落库会磨损 16 MB NOR | 缓解：聚合桶常驻内存、按小时/按天批量落盘；或只在母路由落盘，子路由纯内存+断网时有限落盘 |
| **多机重复计数** | 漫游/双 WAN/同一客户端多路径 | 缓解：以 `child_id+mac` 为主键 + 短窗口去重；报表注明口径 |

### 4.2 可借鉴的开源项目（不能直接装，但架构可抄）

| 项目 | 可借鉴什么 | 状态 |
|---|---|---|
| [nlbw2collectd](https://github.com/mstojek/nlbw2collectd) | 把 nlbwmon 数据桥到 collectd/LuCI statistics 的做法；还记录了"iptmon 因 22.03 换 nftables 而失效"这段历史教训 | 活跃（2026-05 有提交） |
| [openwrt-nlbwmon-prometheus-collector](https://github.com/giuliomagnifico/openwrt-nlbwmon-prometheus-collector) / [VictoriaMetrics-NLBWMon-exporter](https://github.com/ingoratsdorf/Victoriametrics-NLBWMon-exporter) | "路由器只导出、时序库负责存储与出图"的分工；后者被 OpenWrt wiki 收录为相关项目（[wiki](https://openwrt.org/start?do=search&q=nlbwmon)） | 活跃 |
| [luci-app-traffic-survey](https://github.com/Become-ILLUSORY/luci-app-traffic-survey) | **MTK HNAT 感知**的逐主机统计（PPE 硬计数回灌），以及一份很实际的"能用/不能用"矩阵；常驻内存数百 KB | 活跃（2026-09） |
| [luci-app-mihomo-traffic](https://github.com/hoobnn/luci-app-mihomo-traffic) | 用 ucode 写采集进程的可行性数据点：**单核约 1.3%、常驻约 3 MB**；以及"按设备/按出口/按域名"的维度设计 | 活跃（2026-11） |
| [luci-app-flowlens](https://github.com/BlueSky16st/luci-app-flowlens) | LuCI 前端只做展示、后端用 rpcd shell 取数，前端资源静态化的轻量做法 | 活跃（2026-06） |
| [YAMon v4](https://github.com/al-caughey/YAMon-v4) | 老牌"每设备 + 详细报表"的整体产品形态（iptables 计数 + 报表） | **停更**（最后提交 2021-11） |
| [pmacct](https://github.com/pmacct/pmacct) | **集中汇总的参考实现**：`nfacctd`（NetFlow/IPFIX）、`sfacctd`（sFlow）收流，聚合后写 MySQL/PostgreSQL/SQLite 或发 Kafka/AMQP（[QUICKSTART](https://github.com/pmacct/pmacct/blob/master/QUICKSTART)） | 非常活跃（2026-11） |
| [ntopng](https://github.com/ntop/ntopng) | "collector + probe" 的集中模式：ntopng 作 flow collector，nProbe 作探针（[doc/README.md](https://github.com/ntop/ntopng/blob/dev/doc/README.md)） | 非常活跃 |
| Home Assistant 生态 | **没有**官方 OpenWrt 流量集成；实际做法是把指标导出到 InfluxDB/Prometheus 再展示（HA 有 InfluxDB 集成：[文档](https://www.home-assistant.io/integrations/influxdb/)） | — |

> 备注：中文生态里 2026 年出现了一批"按设备/按域名"的 LuCI 插件（上表后三项），说明这个需求方向成立；它们的共同点是**都绕开了 nlbwmon 的数据模型**，自己从 conntrack / 代理内核连接表取数。

### 4.3 未查证 / 需要自己实测的问题

1. **"每秒处理多少"这个问法本身要修正**：ctnetlink 记账的成本**与包速率无关**（计数在内核里做），只与"conntrack 条目数 × dump 频率"有关。所以不存在"能处理多少 pps"的上限，只有"一次 dump 处理多少条流"的上限。
   - 可推导的量级（**估算，未实测**）：1000 条 ct ≈ 1000 × ~120 B ≈ 120 KB netlink 载荷；内核组包 + 用户态解析 1000 条记录，单次 dump 估计在 **几毫秒到几十毫秒**；按默认 30 s 一次 → **单核占用 <0.1%**。把 `refresh_interval` 调到 5 s 会线性放大 6 倍；把 dump 换成"每流事件回调"则在高新建流速率下才需要关注。
   - **没有任何公开的 MT7621 基准数据**（我找过 nlbwmon 的 issue/README/wiki，均无吞吐或条目数实测）。**建议自测**：构造 200/1000/5000 条并发流，分别测 `nlbw dump` 的 CPU 时间、`nf_conntrack_count` 与丢数率（对照 `/proc/net/netlink` 的 drop 计数）。
2. **加了 DNS/SNI 归因后的 CPU 增量没有公开数据**。合理估算：DNS 日志按 20 查询/秒、每行 ~120 B 计，解析成本在 ucode 里约 50–200 µs/行 → **峰值约 1–4% 单核**；参考 [luci-app-mihomo-traffic](https://github.com/hoobnn/luci-app-mihomo-traffic) 的 ucode 采集进程"约 1.3% 单核"量级，可认为同数量级。**这是估算，不是实测。**
3. **SNI 嗅探的真实成本取决于实现方式**：只解析每流首批包（推荐）与全量 pcap 抓包差一个数量级。全量抓包在 MT7621 上跑 100 Mbps 的 CPU 开销**未查证**，不建议作为默认路径。
4. **ECH 的实际渗透率、以及各浏览器/地区默认 DoH 开启比例**：未查证。这直接决定 per-app 归因的长期可信度，建议上线后统计"未归因流量占比"来监控这条曲线。
5. **MT7621 硬转下"是否真的完全无计数"**：第三方 README 说 PPE `per_flow_accounting=false`，但没有给出量化误差。建议在目标机型上做一次 A/B（开/关 HFO 各跑 1 GB 已知流量，比对统计值）。
6. **`kmod-nft-fullcone` 与 ctnetlink 事件的冲突**：仅有第三方单点陈述，需要复现。
7. **本文的包体积是索引里的 `.ipk` 下载体积**，不是解包后占用；解包后一般大 3–4 倍（例：netifyd 24.10 下载 1.0 MB、索引标称解包约 3.8 MB）。要精确占用应在目标机型上 `opkg install` 后看实际增量。

---

## 附：一句话选型结论

- **每设备流量**：内核 `nf_conntrack_acct` + 自研 ctnetlink 采集（nlbwmon 可作降级备份），**强制关闭 flow offloading**。
- **per-app/站点**：dnsmasq 查询日志为主、TLS SNI 为辅、端口/ASN 兜底；**不做全流量 DPI**。
- **多机汇总**：子路由聚合后**出站 push** 到母路由，只传 5 分钟聚合桶，`child_id+mac` 唯一化，幂等 upsert。
- **存储与报表**：母路由 SQLite(WAL)，日报/周报/飞书告警；子路由尽量纯内存，控制 flash 写入。
