# 把流量归到「应用/网站」：技术路线穷举与 OpenWrt 可行性评估

> 目标硬件：MT7621（MIPS 1004Kc ×2 @880 MHz）/ MT7981（Cortex-A53）/ x86；RAM 128–512 MB，flash 16–128 MB。
> 约束：**不做全流量 DPI**（netifyd 官方要求 ≥256 MB RAM、解包约 3.8 MB）。
> 调研时间：2026-11-14。本文只做调研与评估，不含业务代码。
> 标注约定：**实测** = 本次运行命令/抓取原始数据得到；**估算** = 按公开参数与结构推导，需在目标机复测；**未查证** = 没有找到可信公开来源，不作结论。

---

## 0. 三个必答问题的结论（先看这里）

**Q1「不做全流量 DPI 的最好组合」**
DNS 嗅探（常开）→ TLS SNI（full 档）→ QUIC Initial 解密（full 档，可选）→ DoH/DoT 端点标记（常开）→ ASN 兜底（full 档，可选）→ 域名→应用规则库。
中性参数下（§3.3 模型）：**域名级 90.9%、仅 ASN 5.4%、可识别但不可归因 1.4%、完全未知 2.3%**；保守情形域名级 77.6%。只做 DNS 时域名级只有 59.5%——**所以 SNI 是性价比最高的一档，不是可选项**。对外建议表述为"域名级约 80–90%（估算）"，落地后以 §3.4 的 7 天实测替换。

**Q2「有没有产品公开过未归因流量占比」**
**未查证到**任何口径明确、可复核的公开数字。能查到的只有间接量：HTTPS 站点占比 90.7%、HTTP/3 站点占比 41.1%（W3Techs，2026-11，**站点数**口径，不是流量口径）；DPI 产品（[ntopng 界面里有 `unknown` 流量分类](https://www.ntop.org/guides/ntopng/user_interface/network_interface/interface/interfaces.html)）也只提供分类，没有公开的汇总比例。**结论：这个指标我们必须自己定义、自己标定、自己公布口径**（§3.4），不能引用别人的数字充数。

**Q3「开 SNI + QUIC Initial 的 CPU 代价，MT7621 能不能接受」**
能接受，但**瓶颈是抓包不是解密**。QUIC Initial 解密约 100–150 µs/包（一个连接 2–3 个包，合计 0.3–0.5 ms），1000 新连接/分钟约占单核 0.7%；真正花钱的是"每个 443 包过一次 BPF/抓包路径"，100 Mbps 下约 1–3% 单核，300 Mbps 下 3–6%（估算）。**MT7621 建议 ≤200–300 Mbps 开 SNI+QUIC，千兆场景只在 MT7981/x86 开**。另外必须提醒：为统计关掉 flow offloading 的代价（吞吐腰斩）远大于嗅探本身。

---

## 一、路线总表（11 条 × 6 维）

> 覆盖率/准确率都是**该路线单独使用**时的口径；"解析深度"指要做到这条路线，最少要解到哪一层。
> 资源代价为常驻增量（不含既有的 conntrack 采集）；CPU 以 MT7621 @100 Mbps WAN 为参照。
> 复杂度里的"人日"是**估算**，含联调不含长期维护。

| # | 路线 | 解析深度 | CPU / 内存代价 | 覆盖率 | 准确率 | 实现复杂度 | 是否受加密影响 |
|---|---|---|---|---|---|---|---|
| 1 | **DNS 嗅探**（基线） | L7：DNS 报文（含 TTL、SVCB/HTTPS RR） | <0.5% / 0.3–1.3 MB | 60–90%（=走路由器 DNS 的流量占比） | 映射本身准；IP→域名回填有歧义（CDN 共享 IP） | 低（3–5 人日） | DoH/DoT/DoQ 直接失效；ECH 无关 |
| 2 | **TLS SNI 嗅探**（基线） | L5：TLS record + ClientHello | 1–3% / ≈1 MB | 覆盖 TLS 流≈100%（除 ECH/无 SNI） | 高（SNI 即目标域名） | 低-中（5–8 人日） | **ECH 失效**（RFC 9849）；TLS 1.3 不影响 |
| 3 | **QUIC Initial 解密取 SNI** | L5：QUIC long header + AES-128-GCM + CRYPTO 重组 + TLS CH | 解密 <1%；抓包 1–3% / 0.5 MB | HTTP/3 流≈100%（v1/v2） | 与 SNI 同级 | 中-高（10–20 人日；复用 nDPI 可降至 3–5） | 可解（协议设计如此）；ECH 后只剩 outer SNI |
| 4 | **DoH/DoT/DoQ 端点识别** | L3/L4 + 已知端点表（+SNI 主机名） | ≈0 / <100 KB | 只能回答"这台设备在用加密 DNS" | 高（专用 anycast IP）；共享 CDN IP 上低 | 低（1–2 人日） | 本身就是为加密 DNS 而生 |
| 5 | **ASN / GeoIP 归类** | L3：目的 IP → ASN | 查询 <0.1% / 9 MB 全库，或 0.2–1 MB 精简集 | 100%（任何 IP 都有 ASN） | 只到"哪家公司"，不到"哪个应用" | 低（2–4 人日 + 数据管线） | 不受影响 |
| 6 | **TLS 指纹（JA3/JA4）** | L5：ClientHello 字段哈希 | ≈0 / ≈0 | 能算 100% TLS 流 | 客户端类型高；**目标应用低** | 低（2–3 人日） | 不受 ECH 影响（外层 CH 仍在） |
| 7 | **包长/时序指纹 + ML** | 每流前 N 包（=全量抓包） | **不可行**（见 §2.7） | — | 学术闭集 97–99%，开放集未查证 | 高（30+ 人日）且不建议 | 不影响（本来只看密文长度），padding 会削弱 |
| 8 | **反向 DNS / PTR** | L7：DNS PTR | 低，但必须异步 / <1 MB | 30–60% 目的 IP（CDN 差异极大） | 只到"哪家/CDN"，不到站点 | 低（2 人日） | 不受影响 |
| 9 | **nDPI 轻量子集** | 首包多协议（端口/SNI/QUIC/DNS/HTTP） | 整库不划算 / 2.4 MB 安装 | 与 1+2+3 高度重叠 | 中-高（取决于抽取哪些解析器） | 中（5–10 人日） | 同 SNI/QUIC |
| 10 | **社区域名分类库** | 无（离线数据，后缀匹配） | 0 / 0.1–3 MB | 域名命中率取决于库 | 高（后缀匹配确定） | 低（3–5 人日 + 长期维护） | 无关（是数据不是探测） |
| 11 | **其他路线**（见 §2.11，共 5 条） | — | — | — | — | — | — |

**表 11 展开：5 条补充路线**

| # | 路线 | 解析深度 | CPU / 内存代价 | 覆盖率 | 准确率 | 复杂度 | 加密影响 |
|---|---|---|---|---|---|---|---|
| 11a | **代理侧元数据**（mihomo/sing-box /connections） | 无（读 API） | ≈0 / <1 MB | 仅"流量过代理"的设备 | **极高**（host 是代理自己解析的） | 低（3–5 人日） | 免疫（代理本来就终结 TLS） |
| 11b | **TLS 1.2 证书 SAN** | L5：Certificate 消息（多包重组） | 中（3–10× SNI）/ 8 KB/流 | TLS 1.2 流（份额在降） | 高（证书即域名） | 中（6–10 人日） | **不受 ECH 影响**（ECH 只用于 TLS 1.3）；TLS 1.3 下失效 |
| 11c | **ECH outer SNI** | L5：ClientHelloOuter 的 server_name | ≈0（复用 SNI 解析） | ECH 流量≈100% | 只到"ECH 前置/CDN"，站点未知 | 低（1 人日） | 专为 ECH 设计，是唯一可读信号 |
| 11d | **端口/协议启发式** | L4 | ≈0 / <50 KB | 系统类流量（推送/更新/VoIP） | 高（端口语义稳定） | 低（1 人日） | 不受影响 |
| 11e | **DNS 强制归口**（重定向 53 / 封 853 / 封 DoH） | L3/L4 策略 | 低 / 0 | 极大提升 DNS 可观测性 | 高 | 低（2–3 人日）+ 高破坏风险 | 直接消灭加密 DNS 旁路 |

---

## 二、逐条详解

### 2.1 DNS 嗅探（基线）

**原理**：`AF_PACKET` + BPF `udp port 53`，解析 DNS 报文头/QUESTION/ANSWER，按 TTL 维护 `域名 → IP 集合`，再把 conntrack 里的目的 IP 反查回域名。DNS 报文格式见 [RFC 1035](https://www.rfc-editor.org/rfc/rfc1035.html)。

**解析深度**：L4 之后就是 DNS wire format（无压缩指针也能解，压缩指针只是复用后缀）。要拿 TTL 必须解析 ANSWER 的 TTL 字段；要拿 ECH 线索则要解析 SVCB/HTTPS RR（type 65，[RFC 9460](https://www.rfc-editor.org/rfc/rfc9460.html)）里的 `ipv4hint` / `ech` 参数——**这是本路线一个被低估的附加值**：看到某域名的 HTTPS RR 里带 `ech=`，就能提前把该域名标记为"将来 SNI 会失效"，并提前准备 outer SNI 规则。

**资源代价**：家庭场景 20–100 QPS，单查询 100–300 B。CPU <0.5%（估算）。内存取决于表规模：5k 域名 × 平均 1.6 个 IP × 48 B ≈ 0.4 MB；2 万条 ≈ 1.3 MB。TTL 短的 CDN 域名（30–60 s）会让表频繁换入换出，必须做 TTL 上限（建议 cap 300 s）+ 过期后 30 s 宽限。

**覆盖率**：取决于"客户端是否把 DNS 发给路由器"。OpenWrt 默认由 DHCP 下发自己为 DNS，覆盖率高；但三类旁路会直接归零：
1. 客户端自带 DoH/DoT（Firefox 默认 DoH、Android Private DNS、Chrome DoH）；
2. App 内置 **HTTPDNS**——阿里云文档明确写"绕过传统 Local DNS 服务器，直接通过 HTTP(S) 协议向 HTTPDNS 服务发送 DNS 查询请求"（[阿里云 HTTPDNS](https://www.alibabacloud.com/help/zh/httpdns/latest/what-is-httpdns)，腾讯云同类产品见 [Tencent Cloud HTTPDNS](https://www.tencentcloud.com/zh/document/product/1130/44480)）；这是国内 App 的普遍做法，也是本方案最大的漏损源；
3. 写死 `114.114.114.114` / `223.5.5.5` 的电视盒子、摄像头、老 IoT。

**准确率**：DNS 里的"域名→IP"是**真实应答**，映射本身准确。错在反查：一个 IP 常被多个域名共用（Cloudflare 一个边缘 IP 后面是百万站点），只能用"最近一次解析 + 端口 + 时间窗 + 规则优先级"打分。估算 join 成功率 85%（0.75–0.92）。

**是否受加密影响**：DoH（[RFC 8484](https://www.rfc-editor.org/rfc/rfc8484.html)）、DoT（[RFC 7858](https://www.rfc-editor.org/rfc/rfc7858.html)）、DoQ（[RFC 9250](https://www.rfc-editor.org/rfc/rfc9250.html)，UDP/853）一律失效。ECH 不直接影响 DNS，但 ECH 配置通过 HTTPS RR 分发，实践中浏览器只在 DoH 可用时才启用 ECH，所以"ECH 普及"与"DNS 归因失效"高度相关。

**一个实现上的优势**：被动嗅探**与用户用什么 DNS 软件无关**（dnsmasq / unbound / AdGuard Home / smartdns 都行），而"读 dnsmasq 日志"只对 dnsmasq 有效。这是选嗅探而不是读日志的核心理由（既有文档 §2.1 已论证）。

---

### 2.2 TLS SNI 嗅探（基线）

**原理**：TLS ClientHello 的 `server_name` 扩展是明文（[RFC 6066 §3](https://www.rfc-editor.org/rfc/rfc6066.html)）；TLS 1.3 也没有加密它（[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html)，加密从 EncryptedExtensions 开始）。被动读出 SNI 即目标域名。

**解析深度**：TCP 层拿到首个含 payload 的段即可（ClientHello 通常 <1.5 KB，单包）；解 TLS record header（0x16 0x03）+ handshake header + 扩展列表。**不需要 TCP 重组**（除非 CH 被拆包，少见）。

**资源代价**：关键是 BPF 只放行"payload 首字节 = 0x16"的包，其余在核内丢弃、不拷贝到用户态。100 Mbps 下约 10k pps 过 BPF，1–3% 单核（估算）。每流状态 <1 KB，并发 1000 流 ≈ 1 MB。

**覆盖率**：所有走 TLS 的流。HTTPS 已是默认：W3Techs 2026-11 显示 **90.7% 的网站默认 HTTPS**（[W3Techs](https://w3techs.com/technologies/details/ce-httpsdefault)），流量加权更高（估算 95%+）。

**准确率**：高——SNI 就是客户端想访问的域名。四类例外：
1. **ECH**：SNI 变成 `public_name`（见 §2.11c）；
2. **域前置/共用证书**：SNI 写的是 CDN 边缘域，不是真实站点（国内少见，Cloudflare 系有）；
3. **IP 直连无 SNI**：部分 SDK、探活、内网服务；
4. **非 TLS 的 443**：私有协议伪装成 443（游戏、代理），SNI 解析失败，落 unknown。

**是否受加密影响**：ECH（[RFC 9849](https://www.rfc-editor.org/rfc/rfc9849.html)，2026-03 发布，Standards Track）生效即失效。注意 ECH **只在 TLS 1.3 下工作**，所以 TLS 1.2 流不受 ECH 影响（这也是 §2.11b 的价值）。

**与 DNS 的关系**：SNI 是"直接证据"，DNS 是"间接证据"。SNI 能解决 DNS 最痛的 CDN 共享 IP 歧义，所以两者不是替代而是互补：**DNS 提供覆盖面，SNI 提供消歧**。

---

### 2.3 QUIC Initial 解密取 SNI ★重点

**原理**：QUIC 的 Initial 包用**固定盐 + 客户端首个包的 DCID** 派生密钥，任何观察者都能解。这是协议明写的设计：

- v1 盐 `0x38762cf7f55934b34d179ae6a4c80cadccbb7f0a`，`initial_secret = HKDF-Extract(salt, client_dst_connection_id)`，再用 HKDF-Expand-Label 派 "client in" → "quic key"/"quic iv"/"quic hp"（[RFC 9001 §5.2](https://www.rfc-editor.org/rfc/rfc9001.html)）。
- v2 盐 `0x0dede3def700a6db819381be6e269dcbf9bd2ed9`，标签前缀改 `quicv2`（[RFC 9369 §3.3](https://www.rfc-editor.org/rfc/rfc9369.html)）。RFC 9369 自己就把话说明白了：*"Protecting Initial packets in this way allows observers to inspect their contents, which includes the TLS Client Hello"*。
- 解密后从 CRYPTO 帧里取出 TLS ClientHello，按 §2.2 解析 SNI。QUIC 加密只保护 Initial 的**载荷**，头部保护（HP）用的也是公开派生的 key，所以连包类型都能读。

**解析深度**：UDP → QUIC long header（version、DCID、packet number）→ 头部保护解除（AES-ECB）→ AEAD 解密（AES-128-GCM）→ CRYPTO 帧重组（ClientHello 可能跨 2–3 个 Initial，且可能乱序）→ TLS ClientHello 解析。

**关键实现事实**：nDPI 已经在做这件事，而且只在需要时做——源码注释写着 *"nDPI only ever needs to decrypt Initial packets, which always use…"*，解密后 `ndpi_hostname_sni_set()` 写入 `host_server_name`（[nDPI quic.c](https://github.com/ntop/nDPI/blob/dev/src/lib/protocols/quic.c)）。它同时支持 v1/v2 和一堆 draft 盐，并处理 CRYPTO 帧乱序重组。**这证明"路由器上解 QUIC Initial"不是理论可行，而是已被一个 C 库实现并在跑。**

**能不能直接用 nDPI？** 可以但要看清成本与许可：
- OpenWrt 24.10 有 `libndpi 4.8-r1`：ipk 688,512 B，安装后 2,467,840 B（≈2.4 MB），依赖只有 libc（[Packages 索引](https://downloads.openwrt.org/releases/24.10.0/packages/aarch64_cortex-a53/packages/Packages.gz)）。
- 许可：核心 LGPLv3，但 **TLS/DNS 等解析器是 ntop 的双许可组件**，商业产品要用得签商业授权（[README.license.md](https://github.com/ntop/nDPI/blob/dev/README.license.md)）。如果只是"内部使用/不直接创收"，双许可组件可免费使用。
- 结论：**抄它的算法/移植 quic.c 的关键函数（注意双许可），比链接整个库更划算**——我们只需要 QUIC Initial + TLS CH 这两个解析器，不需要 266 个协议的检测树。

**资源代价（估算，按 MT7621 880 MHz、无 AES/SHA 指令扩展推算）**：
| 动作 | 单次成本 | 频率 | 占用 |
|---|---|---|---|
| BPF 过滤（long header 才拷贝） | 0.3–1 µs/包 | 10k pps @100 Mbps | 0.3–1% |
| Initial 解密（HKDF + AES-128-GCM 1.2 KB） | 100–150 µs/包 | 2–3 包/连接 | — |
| ClientHello 解析 + SNI 提取 | 20–40 µs/连接 | 每连接 1 次 | — |
| 合计每连接 | ≈0.3–0.5 ms | 1000 连接/分钟 = 16.7/s | **≈0.7%** |

软件 AES-128-GCM 在 880 MHz MIPS 上按 12–15 MB/s 估（T-table 实现，无 AES-NI/ARMv8 Crypto）。**解密不是瓶颈**：即使 10 万新 QUIC 连接/小时（家庭不可能），也只有 1% CPU。瓶颈是"每个 443 包都要过一次抓包过滤"，这部分和 §2.2 共享。

内存：只需一个 `DCID → 已解密` 的 LRU（防重传重复解密），4096 项 × 48 B ≈ 200 KB；加每流重组缓冲 8 KB × 并发 64 ≈ 0.5 MB。

**覆盖率**：HTTP/3 流 ≈100%（v1/v2 盐都已知；除非客户端用未知新版本）。HTTP/3 的**站点**占比 41.1%（[W3Techs HTTP/3](https://w3techs.com/technologies/details/ce-http3)，2026-11，站点数口径）；但头部大站（Google/YouTube/Meta/Cloudflare 系）几乎全上 HTTP/3，所以**流量加权占比高得多**（估算 55–70%，需实测）。

**准确率**：与 SNI 同级。两个新失效点：
1. **ECH**：QUIC 也支持 ECH，解密后 ClientHelloOuter 的 SNI 只有 `public_name`；
2. **未知 QUIC 版本 / 私有 QUIC**：解不出来，落 unknown（可回退到 DNS）。

**是否受加密影响**：Initial 天生可解；**真正不可解的是 1-RTT（握手完成后）的包**——但那不重要，因为我们只要 ClientHello。ECH 生效后这条路线退化为 §2.11c。

**工程建议（很重要）**：不要用 `AF_PACKET` 无差别抓 443。用 BPF 只放行长头包（下为伪代码，实际偏移要按 IP 头长度算）：
- QUIC：`udp dst port 443 && (udp[8] & 0x80) != 0`（只要长头）。**不要按 v1 的 Initial 类型位写死**——v1 的 Initial 是 `0b00`、v2 是 `0b01`（[RFC 9369 §3.2](https://www.rfc-editor.org/rfc/rfc9369.html)），写死会漏掉 v2；版本与包类型判断放用户态。
- TLS：`tcp dst port 443 && <payload 首字节> == 0x16`（TLS handshake record）。
核内就把短头包（占 QUIC 流量 95%+）丢掉，用户态看到的只有每流 1–3 个包。这是"不做全流量 DPI"能成立的技术前提。
另一个可选路径是 nftables `ct state new … queue num X` 只把**每流第一个包**送用户态（[nftables wiki](https://wiki.nftables.org/wiki-nftables/index.php/Queueing_to_userspace)）；QUIC 恰好首个包就是 Initial，天然适配；TCP 不适用（首包是 SYN，无 payload）。

---

### 2.4 DoH / DoT / DoQ 端点 IP 识别

**原理**：维护"已知加密 DNS 端点"集合，命中即判定"这台设备在用加密 DNS"，从而把它剩下的未归因流量**单独标注**，而不是混进 unknown。这是**解释性**路线，不是归因路线。

**公开列表（实测可用）**：

| 服务商 | IP / 段 | 来源 |
|---|---|---|
| Cloudflare | 1.1.1.1、1.0.0.1（`cloudflare-dns.com`） | [cloudflare.com/ips-v4](https://www.cloudflare.com/ips-v4) |
| Google | 8.8.8.8、8.8.4.4、2001:4860:4860::8888/8844 | [Google Public DNS 文档](https://developers.google.com/speed/public-dns/docs/using) |
| Quad9 | 9.9.9.9、149.112.112.112、2620:fe::fe | [Quad9 FAQ](https://quad9.net/support/faq/) |
| AdGuard | 94.140.14.14、94.140.15.15 等 | [AdGuard DNS](https://adguard-dns.io/en/public-dns.html) |
| NextDNS | 45.90.28.0/24、45.90.30.0/24 | [NextDNS 帮助](https://help.nextdns.io/t/y4y3pz1/nextdns-ip-address-ranges-subnets) |
| OpenDNS | 208.67.222.222、208.67.220.220 | 官方文档（未逐一复核） |
| 国内 | 223.5.5.5（AliDNS）、119.29.29.29（DNSPod）、180.76.76.76（百度） | 各官网，DoH 端点另需按主机名识别 |

**一个必须避开的陷阱**：**不要用 Cloudflare 的 `ips-v4` 判 DoH**。那份列表是整个边缘网（`104.16.0.0/13`、`172.64.0.0/13` 等），拿它匹配会把**所有 Cloudflare 前置的网站**都标成"在用 DoH"。正确做法是只匹配**专用 anycast 地址**（1.1.1.1/1.0.0.1），或匹配 DoH 主机名（`cloudflare-dns.com` 解析出的 `104.16.248.249` 是共享 IP，不能单独作为判据）。

**更可靠的判据**：如果 SNI/QUIC 可用，直接看 SNI 是否等于已知 DoH 主机名（`dns.google`、`cloudflare-dns.com`、`dns.quad9.net`、`doh.pub`、`dns.alidns.com`、`dns.adguard-dns.com`）。这比 IP 表准确得多，成本为零（复用 SNI 解析）。DoQ 走 UDP/853，QUIC Initial 解密后同样能拿到 SNI（[RFC 9250](https://www.rfc-editor.org/rfc/rfc9250.html)）。

**代价**：一个 IP set（<100 KB）+ 一次哈希查表，CPU≈0。

**覆盖率/准确率**：只能回答"设备是否在用加密 DNS"，**不能回答查了什么域名**。专用 IP 上准确率高；共享 CDN IP 上不可用。

**加密影响**：这条路线就是为加密 DNS 设计的，因此"受加密影响"= 它存在的前提。

---

### 2.5 ASN / GeoIP 归类

**原理**：目的 IP → ASN，把 `13335` 读成 Cloudflare、`15169` 读成 Google、`32934` 读成 Meta。用于给"归不到域名"的流量一个**粗粒度但确定**的标签。

**可选数据源对比（实测/官方）**：

| 数据源 | 体积 | 许可 | 更新 | 备注 |
|---|---|---|---|---|
| MaxMind **GeoLite2-ASN.mmdb** | **9,065,220 B**（2026.11.13 的第三方镜像发布资产，实测） | [GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula) = **CC BY-SA 4.0** + 必须注册账号 + 署名 | 每周 | 需 `libmaxminddb`（ipk 15,982 B / 安装 143,360 B，Apache-2.0，依赖仅 libc） |
| MaxMind GeoLite2-Country | 3,394,049 B | 同上 | 每周 | 只有国家，对应用归因没用 |
| **iptoasn.com** `ip2asn-v4-u32.tsv.gz` | **9,439,400 B**（实测 Content-Range） | **Public Domain (PDDL v1.0)**（站点明示） | **每小时** | 无账号；另有 v6 / combined 文件 |
| **Team Cymru DNS** | 0（在线查询） | 免费服务 | 实时 | `dig 8.8.8.8.origin.asn.cymru.com TXT` → `"15169 \| 8.8.8.0/24 \| US \| arin \| …"`（**实测**）；`as15169.asn.cymru.com TXT` 拿 AS 名 |
| 自建 **Top-N ASN 前缀集** | 估算 0.2–1 MB | 取决于上游 | 随发布 | 只保留 Cloudflare/Google/Meta/AWS/字节/腾讯/阿里等 N 家，编译成 nft interval set 或排序 u32 数组 |

**128 MB 设备能不能用**：**库放不下 flash，但放得进内存**。16 MB flash 机型固件本身占 8–10 MB，塞不进 9 MB 库；128 MB NAND 机型可以。折中：
- 方案 A（推荐给 lite）：**只内置 Top-50~200 ASN 的前缀集**。Cloudflare 约 2k 前缀、Google 约 1k、Meta 约 500，200 家合计估算 3–5 万条 u32 区间，二进制 8 B/条 ≈ 320–400 KB，nft interval set 常驻约 0.3–0.5 MB。够把 80–90% 的字节归到"哪家公司"。
- 方案 B（full）：`mmap` GeoLite2-ASN，按需换页，RSS 通常 1–2 MB（页缓存可回收）；代价是首次查询有缺页延迟。
- 方案 C（不推荐默认）：Team Cymru 在线查询。**实测可用**，但每个新 IP 一次外网 DNS 查询，必须异步 + 缓存 + 限速，且把用户访问的 IP 泄露给第三方。

**覆盖率**：100%（任何 IP 都有 ASN）。
**准确率**：ASN 本身准；但**"哪家公司"≠"哪个应用"**。Google 的 AS15169 同时是 YouTube/Gmail/Search/Play/Drive；Meta 的 AS32934 是 FB/IG/WhatsApp；Cloudflare 的 AS13335 是几百万个站点。估算只有 20–40% 的 ASN 能唯一映射到一个应用家族（如 13335→"Cloudflare 前置，站点未知"、32934→"Meta 系"）。

**是否需要解析深度**：只要 L3。
**加密影响**：完全不受影响——这是它最大的价值，也是它只能做兜底的原因。

**IPv6 注意**：GeoLite2-ASN 同时含 v4/v6；iptoasn 的 `ip2asn-v4*` 只含 v4，v6 要用 `ip2asn-v6.tsv.gz`。DNS 的 AAAA、SNI、QUIC 对 v6 完全同理，别把 v6 流量漏出统计口径。

---

### 2.6 TLS 指纹（JA3 / JA4）

**原理**：把 ClientHello 的版本、密码套件、扩展、曲线、签名算法等字段拼起来做哈希/结构化编码。JA3 出自 Salesforce（[JA3 介绍](https://medium.com/salesforce-engineering/tls-fingerprinting-with-ja3-and-ja3s-247362855967)），JA4 是它的改良版，格式 `a_b_c`（[FoxIO ja4](https://github.com/FoxIO-LLC/ja4)）。

**能力边界（必须说清）**：
- 指纹**只来自客户端**，ClientHello 里没有任何"我要访问谁"的信息。所以它回答的是"**谁在连**"，不是"**连到哪**"。
- 同一套 TLS 栈被无数 App 共用：OkHttp/Conscrypt（大量 Android App）、BoringSSL（Chrome/大量 SDK）、curl、Go net/http。同一指纹下的目标应用可以完全不同。
- 指纹会漂移。JA4 作者自己写：*"JA4 fingerprints will change as application TLS libraries are updated, about once a year. Do not assume fingerprints will remain constant"*（[ja4 README](https://github.com/FoxIO-LLC/ja4)）。
- 真正能靠指纹识别的，是**自带 TLS 栈且版本稳定**的客户端：特定浏览器、带自定义 TLS 栈的 App（部分版本）、爬虫、恶意软件、扫描器。

**结论**：JA3/JA4 适合做**辅助维度**——判断"这是浏览器还是 App SDK"、"是不是已知爬虫/扫描器"，用来给域名归因结果加置信度或做设备画像；**不能作为"目标应用"的识别手段**。把它写进"按应用统计"的主路径会制造大量误判。

**代价**：与 SNI 共用解析，额外计算≈0；内存≈0（可只存指纹→标签的哈希表）。
**许可**：JA4（TLS 客户端指纹）是 BSD-3-Clause；JA4+ 其余成员（JA4S/JA4H/JA4X…）是 patent-pending + FoxIO License 1.1，**不允许 monetization**。只用 JA4 本体没问题。
**加密影响**：ECH 不影响——外层 ClientHello 仍然在，JA4 照样能算（只是它描述的是"外层连接"）。

---

### 2.7 包长/时序指纹 + ML 分类

**学术上做到什么**：
- **ET-BERT**（WWW'22）：在 5 个加密流量任务上 SOTA，F1 分别达到 ISCX-Tor 99.2%、ISCX-VPN-Service 98.9%、Cross-Platform(Android) 92.5%、CSTNET-TLS1.3 97.4%（[arXiv:2202.06335](https://arxiv.org/abs/2202.06335)）。
- **nPrint**（CCS'20）：把每个包压成固定长度比特串，接 AutoML；在 8 个任务上验证（[arXiv:2008.02695](https://arxiv.org/abs/2008.02695)）。
- **FlowPic**：把流的前若干包画成"包长-时间"二维图，当图像分类；论文报告的闭集准确率随任务在 **93.9%–99.9%** 之间（14 类 93.9%、VPN 任务 99.7% 等，[论文 PDF](http://pdfs.semanticscholar.org/8f4d/3d4830f8f5b2ef6aaa63caa85d2f01dbabcc.pdf)）。

**为什么在路由器上不现实**（四条，按重要性排序）：
1. **数据采集成本 = 全流量 DPI**。上述方法都要每流前 N 个包的**长度与时序序列**（ET-BERT 还要前若干字节做 token）。要拿到这些，就得把每个流的前几十个包都复制到用户态——这正是我们明令不做的"全流量 DPI"。省掉采集，模型就没有输入。
2. **模型体积/算力**。ET-BERT 是 BERT-base 级（1.1 亿参数，数百 MB），MT7621 上不可能。FlowPic 类小 CNN 勉强能跑（估算 1–5 ms/流），但需要为每流维护图像缓冲，且吞吐随流数线性下降。
3. **闭集指标不可外推**。98–99% 是"在固定标签集、同分布测试集"上的数字；真实家庭是**开放集**：新 App、新 CDN、流量混杂、标签未知。学术界的开放集（open-world）评测准确率普遍显著下降，且没有可直接引用的、针对"家庭路由器按应用归因"的公开数字（**未查证**）。
4. **输出粒度不对**。这些模型输出的是"应用类别/某个 App"，不是"哪个网站"。而本产品的核心诉求是"每设备 × 每网站/应用"，ML 给的标签既不稳定也不可解释，用户看到"可能是视频类"不会满意。

**结论**：**不做**。如果将来要在 x86 上做研究性功能，也只能是"离线抽样 pcap + 服务端训练"，不进路由器热路径。

**覆盖率/准确率**：不适用（不作为产品路线）。
**加密影响**：不改变可行性——它本来就看密文，但 ECH 的填充和 QUIC 的 padding 会削弱长度特征。

---

### 2.8 反向 DNS / PTR

**原理**：对目的 IP 发 PTR 查询（`in-addr.arpa`，[RFC 1035](https://www.rfc-editor.org/rfc/rfc1035.html)），从返回的主机名推断归属。

**实测覆盖差异极大**（本次直接 `dig -x`）：

| 目的 IP | PTR | 能推出什么 |
|---|---|---|
| `142.250.72.14`（Google） | `den08s06-in-f14.1e100.net.` | Google |
| `23.1.2.3`（Akamai） | `a23-1-2-3.deploy.static.akamaitechnologies.com.` | Akamai |
| `8.8.8.8` | `dns.google.` | Google DNS |
| `1.1.1.1` | `one.one.one.one.` | Cloudflare DNS |
| `104.16.0.1`（Cloudflare） | **无 PTR** | 什么都推不出 |
| `151.101.1.69`（Fastly） | **无 PTR** | 什么都推不出 |

**结论**：PTR 的覆盖是"CDN 各自为政"——Akamai/Google/AWS 爱设 PTR，Cloudflare/Fastly 基本不设。它只能补充"哪家/CDN"，**给不了站点**；而且 PTR 可被任意设置，不能当强证据。

**代价**：每个**唯一目的 IP** 一次查询，必须异步（否则 5 s 超时会卡住归因线程）、必须缓存（按 IP + TTL + 失败负缓存）、必须限速（避免把路由器 DNS 打爆）。IP 数量按家庭 1 小时 300–1000 个新 IP 估算，QPS 完全可接受，但要做队列。
**另一个代价是隐私**：PTR 查询会把"用户访问了哪些 IP"暴露给上游 DNS。
**实现复杂度**：低（2 人日）。**加密影响**：无。

---

### 2.9 nDPI 的"轻量子集"

**事实基础**：nDPI 源码 `src/lib/protocols` 下约 266 个文件（GitHub 目录 API 计数，含少量非 .c 文件），其中相当一部分是**首包即可判定**的：端口表、IP 段表、DNS、TLS（SNI/证书）、QUIC（Initial 解密 + SNI）、HTTP Host、以及自带的 host 规则引擎。

**可以抽取的轻量做法**（按性价比排序）：
1. **端口/IP 表**：nDPI 里除 DPI 逻辑外还有大量静态端口映射，本质是查表，可直接照抄语义。
2. **TLS ClientHello 解析器**：与我们 §2.2 重合。
3. **QUIC Initial 解密 + CRYPTO 重组**：与我们 §2.3 重合，是 nDPI 里最有价值的一块。
4. **host 规则引擎**：nDPI 支持从文件加载"域名/URL → 自定义协议"（`ndpi_load_protocols_file` / 自定义 category），这正是我们要的"域名→应用"匹配器。
5. **DNS 解析器**：与我们 §2.1 重合。

**不建议整库链接的理由**：
- 2.4 MB 安装体积对 16 MB flash 机型偏重；
- 每流状态结构体不小，且它的检测树会为 266 个协议维护回调；
- TLS/DNS 解析器是**双许可**组件，商业分发需授权（[README.license.md](https://github.com/ntop/nDPI/blob/dev/README.license.md)）；
- 它解决的问题比我们多得多（我们只要 4 个解析器）。

**结论**：**借算法不借库**。把 nDPI 当"参考实现 + 正确性对照"（同一批 pcap 跑 nDPI 和我们自己的解析器比对），而不是运行时依赖。

**覆盖率/准确率**：与 1+2+3 的重叠部分相同；nDPI 独有的那部分（非加密协议的指纹）在家庭流量里占比小，且大多要靠payload，违反"不做全流量 DPI"。

---

### 2.10 社区域名分类库（域名 → 应用）

**关键区分**：绝大多数"社区列表"是**广告/跟踪拦截表**（域名 → 是否拦截），**不是**"域名 → 应用"。能直接当"域名→应用"用的只有少数几个：

| 项目 | 内容 | 规模 | 许可 | 可用性 |
|---|---|---|---|---|
| **v2fly/domain-list-community** | 每个文件一个服务（`netflix`、`youtube`、`douyin`、`bilibili`、`apple`…），纯域名列表，支持 `@cn`、`include:` 属性 | **≥1000 个服务文件**（GitHub 目录 API 单页上限 1000，实际可能更多） | **MIT** | ★★★★★ 首选：许可最干净、格式最简单、国内 App 覆盖尚可 |
| **AdGuard HostlistsRegistry `services.json`** | `blocked_services[]`：`id`/`name`/`rules`（adblock 语法 `||domain^`） | **154 个服务（实测计数）** | **GPL-3.0** | ★★★★ 结构最规整，但要处理 GPL |
| **blackmatrix7/ios_rule_script** | 按 App 的规则集（`YouTube.list`、`WeChat.list`…），从 Surge/QuantumultX 生态整理 | 数百个 App | **GPL-2.0** | ★★★ 应用粒度细，但 GPL-2 传染性 + 质量参差 |
| **hagezi/dns-blocklists** | 拦截表（ads/tracking/malware） | 百万级域名 | **GPL-3.0** | ★ 是"类别"不是"应用" |
| **OISD** | 拦截表 | 大 | **GPL-3.0**（FAQ 明示） | ★ 同上 |
| **AdGuard DNS filter** | 拦截表 | 大 | **GPL-3.0** | ★ 同上 |
| **NextDNS** | 有分类拦截，但**未查到公开的域名→应用数据集** | — | — | **未查证** |

**结论与用法**：
- 主库选 **v2fly（MIT）**：它的文件结构天然就是 `app → domain[]`，且带 `@cn` 这类属性可以做"国内/国外"分流。
- **GPL 库的正确用法**：只在构建期做"离线合并/去重/生成自有格式"，不要把 GPL 数据以"衍生数据库"形式随非 GPL 固件分发；如果一定要分发，整个数据文件按 GPL 发布并单独存放（数据与代码分离）。
- **不要指望拦截表**：`hagezi/OISD/AdGuard DNS filter` 给的是"这个域名是不是广告"，不是"这个域名属于哪个应用"。把它们当应用库会得到一堆"广告联盟"标签。
- **覆盖偏差要写进文档**：v2fly 的 geosite 生态是**为代理分流而生**，对"需要翻墙的站点"覆盖极好（Google/YouTube/Netflix/Telegram），对国内长尾 App（地方银行、政务、小众 SDK）覆盖不足。**规则库命中率必须作为独立指标展示**——"域名已归因但应用未识别"应作为 A 桶下的 **A2 子桶**单独显示，不要混进 unknown。

**维护成本**：这是**持续成本**，不是一次性成本。新 App 每周都在出现，库需要版本化 + 母节点下发（既有 PLAN 已设计 `app_rules` 下发，版本号幂等替换）。

**匹配算法建议**：按"精确域名 > 最长后缀通配 > 关键词"三级匹配；同一域名命中多条规则时，用"规则优先级 + 库版本"决定；自定义规则永远优先于内置规则。别用正则做全量匹配——几千条规则 × 每流一次，在 MT7621 上是可观的 CPU。

---

### 2.11 其他路线（5 条补充）

#### 2.11a 代理侧元数据（mihomo / Clash / sing-box）

**原理**：如果设备流量经过透明代理，代理自己就知道 host。mihomo 的 `/connections` 返回每条连接的 `metadata`，字段包括 `host`、`destinationIP`、`destinationIPASN`、`destinationGeoIP`、`dnsMode`、`process`、`sourceIP`，以及该连接的 `upload`/`download` 字节数（源码：[constant/metadata.go](https://github.com/MetaCubeX/mihomo/blob/Meta/constant/metadata.go)）。

**这意味着**：在"有代理"的环境里，**域名归因、ASN、每连接字节数三件事全是现成的**，不需要任何抓包。`dnsMode` 还能告诉你这个 host 是 fake-ip 映射来的还是真实解析来的。sing-box 也提供 Clash 兼容 API（`experimental.clash_api`，[文档](https://sing-box.sagernet.org/configuration/experimental/clash-api/)），字段语义基本一致。

**覆盖率**：只覆盖走代理的流量（可能是全部，也可能只有一部分规则命中）。**准确率**：极高（host 是代理的权威视图）。**代价**：≈0。
**产品含义**：应该**优先探测 mihomo/sing-box 的 API**（默认 9090/9093），有就用它的数据，没有再退回嗅探。这是"零成本高精度"的路线，很多同类插件忽略它。

#### 2.11b TLS 1.2 证书 SAN 解析（被低估的一条）

**原理**：TLS 1.2 的 Certificate 消息是**明文**，里面的 SAN 就是站点域名。TLS 1.3 从 EncryptedExtensions 开始全部加密（[RFC 8446 握手图](https://www.rfc-editor.org/rfc/rfc8446.html)，`{Certificate}` 带花括号 = 受握手密钥保护），所以这条路线**只对 TLS 1.2 有效**。

**为什么值得写**：
- ECH **只在 TLS 1.3 下工作**，所以"用 TLS 1.2 的流量"天然免疫 ECH；
- 老 Android、IoT、机顶盒、部分 SDK 仍在用 TLS 1.2；
- 当 SNI 缺失（IP 直连）但证书有 SAN 时，仍能拿到域名。

**代价**：证书消息 2–8 KB，跨多个 TCP 段，需要**有界重组缓冲**（8 KB/流）和握手状态机；比 SNI 贵 3–10 倍（估算）。覆盖率 = TLS 1.2 流量占比（估算 10–25%，逐年下降，**未查证**精确值）。
**结论**：作为 SNI 的**补充**在 full 档开启，不作为主路径。

#### 2.11c ECH outer SNI

**原理**：ECH 的 ClientHelloOuter 里仍然有一个明文 `server_name`，值等于 ECHConfig 的 `public_name`——RFC 9849 在 §6.1（Offering ECH）第 5 步明确要求客户端 *"SHOULD place the value of ECHConfig.contents.public_name in the server_name extension"*（[RFC 9849](https://www.rfc-editor.org/rfc/rfc9849.html)），并定义 `public_name` 为"client-facing server 的 DNS 名"。

**能拿到什么**：ECHConfig 里的 `public_name`（常见形态如 `cloudflare-ech.com`，具体值由服务方配置、随provider不同，**未逐一查证**）→ 可以判定"这条流用了 ECH，且前置是某某"，**站点仍然未知**。
**价值**：把"unknown"细分成"ECH/CF 前置，站点不可知"，这是**诚实展示**的关键——用户能看懂"为什么这条归不了"，而不是看到一个黑盒 unknown。
**代价**：≈0（复用 SNI 解析）。**覆盖率**：ECH 流≈100%。**准确率**：只到"前置/CDN"级别。

#### 2.11d 端口 / 协议启发式

**原理**：少部分协议有稳定端口语义，可以直接映射到"系统服务/应用家族"（端口分配见 [IANA 注册表](https://www.iana.org/assignments/service-names-port-numbers/)）：
- TCP 5223 → Apple APNs（iCloud/推送）
- TCP 5228/5229/5230 → Google FCM/Play
- UDP 3478 / 19302 → STUN/WebRTC（音视频通话）
- TCP 5060/5061 → SIP
- TCP 1935 → RTMP
- UDP 123 → NTP
- UDP 443 → QUIC（不是应用，但是"HTTP/3 候选"信号）
- TCP/UDP 853 → DoT/DoQ（→ §2.4）

**价值**：这些流量**单流很小但流数多**（推送、心跳、NTP），如果全落 unknown 会让"未归因占比"虚高；打上标签后指标更真实。**代价**：≈0。**准确率**：端口语义稳定的协议上很高；端口可被任意占用，所以只能做"候选标签"并给低置信度。

#### 2.11e DNS 强制归口（策略型，不是技术型）

**原理**：把加密 DNS 的旁路**堵掉**，让流量重新变得可观测：
1. nftables 把 LAN→任意 `:53` 重定向到路由器 dnsmasq（`redirect to :53`）；
2. 丢弃/拒绝 `:853`（DoT/DoQ）；
3. 丢弃到已知 DoH 端点 IP 的 `:443`（粒度粗，误伤 Cloudflare 系网站，慎用）；
4. 对 `use-application-dns.net` 返回 NXDOMAIN —— Mozilla 的 canary 机制，Firefox 见到 NXDOMAIN 会关闭 DoH（机制见 [Mozilla 文档](https://support.mozilla.org/en-US/kb/configuring-networks-disable-dns-over-https)）。

**收益**：能把 DNS 可观测比例从 60–75% 拉到 90%+（估算），是**提升覆盖率最猛的一招**。
**代价与风险**：这是**改变用户网络行为**，不是观测。会破坏：用户手动设置的 Private DNS、企业 VPN 的分流、部分 App 的容灾逻辑（HTTPDNS 被堵后回退失败）。**只能作为 opt-in 开关，默认关，并在 UI 明示"这会改变网络行为"**。**不建议**做第 3 条（封 DoH IP），误伤面太大。

---

## 三、推荐组合与覆盖率估算

### 3.1 分层组合（按"性价比"排序，不是按技术先进度）

| 层 | 手段 | 档位 | 作用 | 增量成本 |
|---|---|---|---|---|
| T0 | conntrack 计数（已有） | 全档 | 分母：每设备字节数 | 0 |
| T1 | **DNS 嗅探** | 全档常开 | 覆盖面主力 | <0.5% CPU / <1.5 MB |
| T2 | **域名→应用规则库**（v2fly MIT 为主） | 全档常开 | 域名落到应用 | 0.1–3 MB 存储 |
| T3 | **DoH/DoT 端点标记** | 全档常开 | 把"设备在绕 DNS"解释清楚 | ≈0 |
| T4 | **TLS SNI** | full 档，默认开；lite 档编译保留、运行关 | 消歧 + 补 DNS 漏 | 1–3% CPU / 1 MB |
| T5 | **QUIC Initial 解密** | full 档，默认开（与 T4 共享抓包） | 补 HTTP/3 | +0.7% CPU / 0.5 MB |
| T6 | **ECH outer SNI** | 随 T4 自动生效 | 把 unknown 细分 | ≈0 |
| T7 | **ASN 兜底**（Top-N 前缀集优先） | full 档可选；lite 档用 Top-50 | 给剩余流量一个标签 | 0.3–1 MB |
| T8 | **代理元数据**（若探测到 mihomo） | 全档，自动 | 该设备零成本精确归因 | ≈0 |
| T9 | PTR（仅对 T7 桶补充） | 可选，默认关 | 把 ASN 细化到 CDN 名 | 低 + 隐私代价 |
| T10 | DNS 强制归口 | **opt-in，默认关** | 覆盖率兜底 | 破坏性 |

**关键设计**：T4/T5 共享同一条抓包路径和同一套 BPF 过滤（443 的 TLS CH + QUIC Initial），所以"开 SNI"和"开 QUIC"的边际成本很低——**要么都不开，要么一起开**。

### 3.2 输出分桶（这是"诚实展示"的基础）

每条流（或每个聚合桶）只允许落进四个桶之一，UI 必须分开显示：

| 桶 | 含义 | 依据 |
|---|---|---|
| **A. 域名级** | 归到具体域名（进而归到应用） | DNS 命中 / SNI 命中 / QUIC SNI / 代理 host |
| **B. 仅 ASN** | 只知"哪家公司/CDN" | ASN 表命中 |
| **C. 已识别但不可归因** | 知道"在用 ECH/DoH/加密代理"，但站点不可知 | ECH outer SNI / DoH 端点 |
| **D. unknown** | 什么都不知道 | 其余 |

> 很多产品把 B/C/D 混成一个 "其他"，这是不诚实的根源。分开之后，"未归因占比"才有解释力。

### 3.3 覆盖率模型（估算，参数可替换）

设：
- `d` = 明文 DNS 可观测的**字节**占比（走路由器 DNS 且未被 HTTPDNS/DoH 绕过）
- `j` = DNS 桶中 IP→域名 join 成功率
- `s` = **未**被 DNS 归因到的那部分流量中，"TLS/QUIC 且能取到 SNI"的比例（含 DNS 旁路和 join 失败两种来源）
- `e` = ECH 导致 SNI 失效的比例

则（取并集：DNS 归因与 SNI 归因互相独立地"救回"流量）：
```
A(域名级) = d·j + (1 - d·j)·s·(1-e)
R = 1 - A
B(仅ASN)  = R·0.6
C(ECH/DoH)= R·0.15      # 不开 SNI/QUIC 时恒为 0
D(unknown)= R - B - C
```

| 场景 | d | j | s | e | A 域名级 | B 仅ASN | C 已识别 | D unknown |
|---|---|---|---|---|---|---|---|---|
| 乐观（全开 SNI+QUIC，设备规矩） | 0.85 | 0.90 | 0.85 | 0.02 | **96.1%** | 2.4% | 0.6% | 1.0% |
| **中性（推荐默认假设）** | 0.70 | 0.85 | 0.80 | 0.03 | **90.9%** | 5.4% | 1.4% | 2.3% |
| 保守（IP 直连多、私有协议多） | 0.60 | 0.80 | 0.60 | 0.05 | **77.6%** | 13.4% | 3.4% | 5.6% |
| **只做 DNS（不开 SNI）** | 0.70 | 0.85 | — | — | **59.5%** | 24.3% | 0% | 16.2% |

> 保留一位小数只是为了让四桶近似相加 = 100%，不代表精度（独立四舍五入会有 ±0.1 的差）；四个输入参数 `d/j/s/e` 本身是**估算**，实测后整张表都会变。

**这张表最重要的一行是最后一行**：只做 DNS 时域名级只有 59.5%，加上 SNI+QUIC 直接跳到 77.6–96.1%。**SNI 是性价比最高的那一档，不是锦上添花**——因为它能把"DNS 旁路/join 失败"的流量重新救回来（那些流量绝大多数仍是带 SNI 的 TLS）。

**但不要拿 90.9% 对外宣传**。这个模型的乐观来自 `s=0.80`：它假设残余流量里 80% 能被 SNI 救回。如果 App 大量使用 IP 直连、域前置、私有协议（游戏、物联网、部分国产 SDK），`s` 会掉到 0.5 以下，A 就落到 75–80%。**对外建议表述为"域名级约 80–90%（估算），以实测为准"，并在 UI 里始终显示真实分桶**。

**为什么 `d` 取 0.70 而不是 0.9**：国内 App 的 HTTPDNS 是真实存在的系统性漏损（阿里云/腾讯云都在卖这个能力），只要有一批头部 App 用了，明文 DNS 就到不了 90%。这个参数**必须实测**。

**为什么"按字节"比"按流"好**：视频（抖音/B 站/YouTube/Netflix）单流字节大、且几乎都能被 DNS+SNI 双命中；而大量小流（心跳、推送、NTP、DoH）更容易落 unknown。所以**字节口径的域名级占比通常比流口径高 3–6 个百分点**（估算）。报表应默认按字节，并在脚注写口径。

**另外三个参数的取值依据**：
- `j=0.85`：DNS 表是"域名→IP 集合"，CDN 一个 IP 挂着多个域名，且 TTL 过期后连接仍在；能成功回填的比例取决于打分策略，85% 是偏乐观的中值。
- `s=0.80`：DNS 归因失败的流量（HTTPDNS 旁路、TTL 过期、表未命中）主体仍是 App 的 TLS/QUIC，SNI 可读；剩下是私有协议、游戏 UDP、自定义加密。80% 是"多数可救回"的估计，**是全表最敏感的参数**。
- `e=0.03`：**ECH 的实际渗透率未查证**。它需要 DoH + 服务端开启 ECH + 客户端支持三个条件同时成立，家庭场景按 1–8% 给区间，中性取 3%。

### 3.4 7 天标定方法（把"估算"变成"实测"）

发布前在 3 类样本上各跑 7 天（≥1 台 MT7621、1 台 MT7981、1 台 x86）：

1. **总量对账**：`Σ(各设备字节)` vs `wan 口计数器增量`，比值即"记账完整度"（既有 PLAN §2.2.1 已设计）。
2. **分桶占比**：直接输出 A/B/C/D 四桶的字节占比与流数占比。这是产品要公布的**唯一权威数字**。
3. **抽样验证**（准确率，不是覆盖率）：每天随机抽 200 条域名级归因，人工/脚本核对"这个 IP 当时是否真属于这个域名"（用同期的 SNI 或代理日志做 ground truth），算**归因准确率**。
4. **漏损归因**：对 D 桶按目的 IP 聚类，人工看 Top-20 是什么（大概率是 HTTPDNS 的 App、私有协议游戏、DoH）。
5. **规则库命中率**：A 桶里有多少能落到具体 app，多少只能落"其他域名"。

**公布的指标建议**（写进 README 和日报脚注）：
> "本期共统计 128.4 GB，其中 86.2% 归到具体网站/应用，9.1% 只能归到运营方（ASN），2.0% 可判定为加密 DNS/ECH 但站点不可知，2.7% 完全未知。口径：按字节，含上下行，已扣除路由器自身流量。"

### 3.5 必答 Q3：CPU 代价与 MT7621 可接受性

**分项（估算，MT7621 @880 MHz）**：

| 项目 | 100 Mbps | 300 Mbps | 1000 Mbps |
|---|---|---|---|
| BPF + 抓包路径（443 全量过过滤） | 1–3% | 3–6% | 10–20% |
| QUIC Initial 解密（按 1000 连接/分钟） | 0.7% | 1.5% | 3% |
| SNI/CH 解析 | <0.5% | 1% | 3% |
| 内存增量 | +1.5 MB | 同 | 同 |

**结论**：
- **MT7621：≤200–300 Mbps 可接受**（新增 2–6% 单核）；千兆不建议开，或只在"晚高峰抽样开启"。
- **MT7981 / x86：可全开**。A53 有 ARMv8 AES/SHA 指令，AES-GCM 快 5–10 倍；且多核可把抓包线程钉到另一个核。
- **真正的税不是嗅探，是关 offload**：为了 conntrack 记账必须关 flow offloading（[OpenWrt wiki](https://openwrt.org/docs/guide-user/perf_and_log/flow_offloading)），MT7621 上这会显著降低 NAT 吞吐。嗅探的 2–6% 相比之下是小数。**这一点必须在产品文档里说清楚**，否则用户会以为是插件拖慢了网速。
- **省 CPU 的三个开关**：① BPF 只放行长头/CH；② 只对"新流"解密（DCID LRU）；③ 采样率（`sni_sample=1.0` 可降到 0.2，按流抽样，误差可控）。

---

## 四、明确的"不做"清单及理由

| 不做的事 | 理由 | 如果将来要做的前提 |
|---|---|---|
| **全流量 DPI**（netifyd / nDPI 全量 / ntopng） | 官方要求 ≥256 MB RAM、解包 3.8 MB；MT7621 128 MB 机型直接出局；且与 flow offload 天然冲突 | 只在 x86 / ≥512 MB 设备上作为可选插件 |
| **ML 流量分类**（ET-BERT/FlowPic/nPrint 类） | 数据采集=全量抓包（违反前提）；模型体积/算力不匹配；闭集 93.9–99.9% 不可外推到开放集；输出是"类别"不是"网站" | 离线抽样 + 服务端训练，不进热路径 |
| **TLS 中间人解密**（自签 CA 替换证书） | 破坏端到端安全、需要给每台设备装证书、法律与信任风险极高 | 永不 |
| **主动探测**（对目的 IP 反查/扫端口/证书拉取） | 侵入第三方、产生额外流量、可能违法；对 CDN IP 也探不出站点 | 永不 |
| **解密 QUIC 1-RTT / TLS 应用数据** | 密码学上不可能（密钥未暴露） | 永不 |
| **逐包 pcap 落盘** | flash 写放大、隐私风险、体积爆炸 | 仅调试模式，内存环形缓冲，不落盘 |
| **强制 DNS 劫持作为默认** | 改变用户网络行为，可能断网/破坏 VPN | opt-in 开关，默认关，UI 明示 |
| **用 Cloudflare ips-v4 判 DoH** | 那是整个边缘网，会把所有 CF 站点误判成 DoH | 只用专用 anycast IP / DoH 主机名 |
| **把 JA3/JA4 当"目标应用"识别** | 指纹只描述客户端；同栈多应用；每年漂移 | 只作辅助维度/置信度 |
| **把拦截表（OISD/hagezi）当应用库** | 它们是"广告/跟踪"分类，不是"应用"分类 | 只用于"是否广告"这一独立维度 |
| **对每个目的 IP 同步查 PTR** | 5 s 超时会卡死归因线程；且会向上游泄露访问的 IP | 异步 + 缓存 + 限速，默认关 |
| **依赖在线 ASN 查询作为主路径** | 外网依赖 + 延迟 + 隐私 | 只作冷数据的补充 |
| **宣称"100% 归因"** | 加密 DNS/ECH/HTTPDNS 决定了不可能 | 改为公布 A/B/C/D 四桶占比 |

---

## 五、来源清单

**协议**
- [RFC 9001（QUIC + TLS，§5.2 Initial Secrets）](https://www.rfc-editor.org/rfc/rfc9001.html)
- [RFC 9369（QUIC v2，§3.3.1 Initial Salt）](https://www.rfc-editor.org/rfc/rfc9369.html)
- [RFC 9849（TLS ECH，2026-03，Standards Track）](https://www.rfc-editor.org/rfc/rfc9849.html)
- [RFC 8446（TLS 1.3，握手加密边界）](https://www.rfc-editor.org/rfc/rfc8446.html)
- [RFC 6066（TLS 扩展，§3 server_name）](https://www.rfc-editor.org/rfc/rfc6066.html)
- [RFC 8484（DoH）](https://www.rfc-editor.org/rfc/rfc8484.html) / [RFC 7858（DoT）](https://www.rfc-editor.org/rfc/rfc7858.html) / [RFC 9250（DoQ，UDP/853）](https://www.rfc-editor.org/rfc/rfc9250.html)
- [RFC 9460（SVCB/HTTPS RR，含 ipv4hint 与 ech 参数）](https://www.rfc-editor.org/rfc/rfc9460.html)
- [RFC 1035（DNS 报文与 PTR）](https://www.rfc-editor.org/rfc/rfc1035.html)

**实现与数据**
- [nDPI quic.c（Initial 解密 + SNI 提取，实测源码）](https://github.com/ntop/nDPI/blob/dev/src/lib/protocols/quic.c)
- [nDPI 许可说明（核心 LGPLv3 + TLS/DNS 双许可）](https://github.com/ntop/nDPI/blob/dev/README.license.md)
- [OpenWrt 24.10 Packages 索引（libndpi 688,512 B / libmaxminddb 15,982 B，实测）](https://downloads.openwrt.org/releases/24.10.0/packages/aarch64_cortex-a53/packages/Packages.gz)
- [Cloudflare IP 段](https://www.cloudflare.com/ips-v4) / [Google Public DNS](https://developers.google.com/speed/public-dns/docs/using) / [Quad9](https://quad9.net/support/faq/) / [AdGuard DNS](https://adguard-dns.io/en/public-dns.html) / [NextDNS 段](https://help.nextdns.io/t/y4y3pz1/nextdns-ip-address-ranges-subnets)
- [GeoLite2 EULA（CC BY-SA 4.0）](https://www.maxmind.com/en/geolite2/eula)；GeoLite2-ASN 体积 9,065,220 B（第三方镜像 2026.11.13 发布资产，实测）
- [iptoasn.com（PDDL v1.0，每小时更新；v4-u32 9,439,400 B 实测）](https://iptoasn.com/)
- [Team Cymru IP-to-ASN（实测 `origin.asn.cymru.com` 可用）](https://www.team-cymru.com/ip-asn-mapping)
- [JA4 / JA4+（许可与漂移说明）](https://github.com/FoxIO-LLC/ja4)
- [v2fly/domain-list-community（MIT，≥1000 服务文件）](https://github.com/v2fly/domain-list-community)
- [AdGuard HostlistsRegistry services.json（GPL-3.0）](https://adguardteam.github.io/HostlistsRegistry/assets/services.json)
- [blackmatrix7/ios_rule_script（GPL-2.0）](https://github.com/blackmatrix7/ios_rule_script)
- [OISD（GPL-3.0，FAQ 明示）](https://oisd.nl/faq) / [hagezi（GPL-3.0）](https://github.com/hagezi/dns-blocklists)
- [mihomo Metadata 字段（host / destinationIPASN / dnsMode）](https://github.com/MetaCubeX/mihomo/blob/Meta/constant/metadata.go)
- [nftables queue 到用户态](https://wiki.nftables.org/wiki-nftables/index.php/Queueing_to_userspace) / [OpenWrt flow offloading](https://openwrt.org/docs/guide-user/perf_and_log/flow_offloading)
- [MT7621 DTS（双 MIPS 1004Kc）](https://github.com/openwrt/openwrt/blob/openwrt-24.10/target/linux/ramips/dts/mt7621.dtsi)

**统计与学术**
- [W3Techs：HTTPS 默认 90.7%（2026-11）](https://w3techs.com/technologies/details/ce-httpsdefault) / [HTTP/3 41.1%（2026-11）](https://w3techs.com/technologies/details/ce-http3)
- [ET-BERT（WWW'22）](https://arxiv.org/abs/2202.06335) / [nPrint（CCS'20）](https://arxiv.org/abs/2008.02695) / [FlowPic](http://pdfs.semanticscholar.org/8f4d/3d4830f8f5b2ef6aaa63caa85d2f01dbabcc.pdf)
- [阿里云 HTTPDNS（绕过 Local DNS 的官方描述）](https://www.alibabacloud.com/help/zh/httpdns/latest/what-is-httpdns) / [腾讯云 HTTPDNS](https://www.tencentcloud.com/zh/document/product/1130/44480)
- [Android Private DNS / DoT（默认自动升级）](https://android-developers.googleblog.com/2018/04/dns-over-tls-support-in-android-p.html)
- [Firefox DoH canary 域名机制](https://support.mozilla.org/en-US/kb/configuring-networks-disable-dns-over-https)

---

## 六、与既有文档的关系

- 本文是 `docs/research-traffic-capture.md` §2.1（当时列了 5 种手段）的**扩展与量化**：补到 15 条，补齐 QUIC Initial 的实现证据、ASN 数据源实测体积、PTR 实测覆盖、规则库许可证，并给出可替换参数的覆盖率模型。
- 本文的结论与 `docs/PLAN.md` §3（三级策略）**兼容**：PLAN 的 L1/L2/L3 正对应本文 T1/T4/T2；本文新增的是 T3（DoH 标记）、T5（QUIC）、T6（ECH outer）、T7（ASN）以及四桶口径。
- **对 PLAN 的一处修订建议**：PLAN §3.3 写"QUIC/HTTP3 仍可归因，因为靠 DNS"——这只在 DNS 可观测时成立；若客户端用 DoH/HTTPDNS，QUIC 同样归不到。建议改为"QUIC 的归因走 DNS 或 Initial 解密两条路，二者都失效时落 unknown"。
- **另一处建议**：PLAN 的"未归因占比 > 30% 告警"阈值，按本文模型 C+D（可识别但不可归因 + 完全未知）中性只有 3.7%、保守 9.0%，**30% 这个阈值几乎永远不会触发**，等于没有监控。建议改为"C+D > 10% 时提示"，并把 A/B/C/D 四桶在 UI 里分开显示。
- **与同期另一份调研的互证**：`docs/research-industry-approaches.md`（独立产出，未由本文复核原始出处）给出三组可互证的行业事实：① MikroTik 文档写明 FastTrack 会绕过 IP accounting、GL.iNet 文档写明开"数据统计"会自动关网络加速 → 支持本文"关 offload 才是真正的税"；② TP-Link 官方 FAQ 承认其流量"按域名分类"、Firewalla 说明"不看加密流量" → 说明"DNS 为主 + SNI 为辅"是行业主流而非降级方案；③ 主流产品普遍把"未知"混进一个大类，不做分桶 → 本文 §3.2 的四桶口径是可差异化的点。
