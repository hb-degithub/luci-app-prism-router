# L2 计数器能否作为「抗 offload」的逐设备数据源

范围：OpenWrt 24.10（内核 6.6）+ MediaTek mt76 / mt7530 / MT7981·7986。
内核行为以 mainline 源码为准，`[6.6]` `[6.12]` 表示已对照该稳定分支核对。

---

## Q1：`iw dev <if> station dump` 的 rx/tx bytes

**结论：** 能用于 WiFi 客户端，但它是 **MAC 层字节**、TX/RX 口径不对称，且计数来源会随 WED 开关切换。「PPE 不影响它」成立，「WiFi 无法卸载所以天然安全」不成立。

### 证据

计数由两条路径产生，谁维护取决于 WED 是否激活：

1. **软件路径（mac80211）** —— 未开 WED 时：
   - RX：`u64_stats_add(&link_sta->rx_stats.bytes, rx->skb->len)` — [net/mac80211/rx.c](https://github.com/torvalds/linux/blob/master/net/mac80211/rx.c)
   - TX：`tx->sta->deflink.tx_stats.bytes[ac] += skb->len` — [net/mac80211/tx.c](https://github.com/torvalds/linux/blob/master/net/mac80211/tx.c)
   - 由 [sta_info.c](https://github.com/torvalds/linux/blob/master/net/mac80211/sta_info.c) 汇总成 `NL80211_STA_INFO_{RX,TX}_BYTES64`。
   - 即维护者是 **mac80211**；**cfg80211 不参与计数**，只负责把属性序列化给 `iw` 显示。mt76 不介入这条路径。
2. **硬件路径（WED 激活时）** —— [mt7915_sta_statistics()](https://github.com/torvalds/linux/blob/master/drivers/net/wireless/mediatek/mt76/mt7915/main.c) 用 WCID 硬件计数覆盖，源码注释原文：
   > `offloading flows bypass networking stack, so driver counts and reports sta statistics via NL80211_STA_INFO when WED is active.`
   对应 `sinfo->tx_bytes = msta->wcid.stats.tx_bytes`，RX 同（需 `mtk_wed_get_rx_capa`）。

**关键推论验证（分两半）：**
- 「PPE/HNAT 只作用于以太网转发路径，WiFi 帧必须过 CPU/MAC」→ **成立**。PPE 位于 `mtk_eth_soc` 的 GMAC 收发之间，WiFi 帧经 PCIe MAC 进出，不进 PPE flow table。
- 「因此 station 计数天然不受任何卸载影响」→ **不成立**。MT7986/MT7915 的 **WED** 把 WiFi↔以太网直通也卸载到硬件，同样绕过网络栈；mt76 正是因为这点才加上述分支，用硬件 WCID 计数补偿。
- 正确表述：station 计数的抗卸载性来自 **「计数取自硬件 WCID」**，而非「WiFi 不可卸载」。反例存在，只是被驱动兜住了。

**MAC 层 vs 用户流量的偏差（可计算）：**
- 每帧固定开销：802.11 MAC 头 24B（QoS 数据帧 26B，带 HT Control 30B）+ LLC/SNAP 8B；FCS 4B 一般已被驱动剥离、不计入。
- MTU 1500B 时开销约 32–38B ≈ **2.1%–2.5%**；64B 小包（DNS 之类）可到 **50%+**，偏差与包长分布强相关。
- 重传：TX 在**入队时**计数，不含重传放大；RX 按收到的每个 MPDU 计，**含**空口重传。
- 自校准：`station dump` 自带 `tx retries` / `tx failed` / `tx packets`，等效空口字节 ≈ `tx_bytes × (1 + tx_retries / tx_packets)`；再按每帧 32–38B 扣头还原「用户字节」。
- **公开的 MAC↔L3 对照实测数据：未查证**（未找到成体系数据集，仅上述可计算方法）。

### 局限
- **多 SSID**：每个 BSS 各有一条 station 记录，同一客户端 MAC 重复出现，必须按 MAC 归并，否则重复计。
- **WDS / 4-addr 中继**：中继替下游设备转发的流量也记在中继自己的 station 上，会把下游用量算到中继头上。
- **802.11k/v 漫游**：断开即释放 `sta_info`，条目消失、计数归零。**必须在断开事件时快照落盘**，否则每次漫游丢一段。
- **WED 开/关切换**：来源从 mac80211 软件计数切到 WCID 硬件计数，口径不连续，切换点会跳变。
- 同一客户端 2.4G/5G 双连会各算一份。

---

## Q2：交换机端口计数 + FDB

**结论：** 硬件有能力（mt7530 有 64 位每端口字节 MIB，且天然含硬转流量），但 **OpenWrt 24.10 的 6.6 内核没把它暴露出来**；FDB 只能给「端口→MAC 集合」，不能唯一摊到设备。

### 证据
- **都是 DSA，不是 swconfig**：`ramips/mt7621` 与 `mediatek/filogic` 的 [config-6.6](https://github.com/openwrt/openwrt/blob/openwrt-24.10/target/linux/ramips/mt7621/config-6.6) 均为 `CONFIG_NET_DSA=y` + `CONFIG_NET_DSA_MT7530(_MDIO/_MMIO)=y`，无 `CONFIG_SWCONFIG`。MT7981 内置 MT7531 走同一 `mt7530` 驱动。
- **硬件确有字节计数**：[mt7530.h](https://github.com/torvalds/linux/blob/master/drivers/net/dsa/mt7530.h) 定义 `MT7530_PORT_MIB_TX_BYTES 0x48` / `MT7530_PORT_MIB_RX_BYTES 0xa8`，注释 `/* 64 bytes */`（64 位，分两段读）。
- **但 6.6 驱动没暴露**：`mt7530_mib[]` 只收了 9 个丢弃/错误计数（TxDrop/TxCrcErr/…/RxArlDrop），**没有 TX/RX_BYTES**，所以 `ethtool -S lan1` 拿不到字节数。
- 真正暴露字节计数的 `mt7530_get_eth_mac_stats()`（把 TX/RX_BYTES 映射成 `OctetsTransmittedOK` / `OctetsReceivedOK`，走 `ethtool --include-statistics -S`）只存在于 **master**；`[6.6]` `[6.12]` 中均搜不到 → 24.10 用不上，且 `pending-6.6` 里也没有相关补丁。
- **为什么端口计数相对 conntrack 有价值**：MIB 是交换机端口的硬件计数器，PPE 卸载发生在 SoC 的 GMAC 之后，帧无论如何都要过一次端口 → **硬转字节照样被端口 MIB 累加**，而 conntrack 会在卸载后停更。这正是它不可替代的地方。

### 局限
- **端口 ≠ 设备**：端口下挂 AP / 下级交换机时，该端口只有一个总量，`bridge fdb` 只能列出该端口上的多个 MAC，无法拆分；只有「1 端口 1 设备」的常见拓扑才近似 1:1。
- FDB 只含活跃 MAC，默认老化 300s，空闲设备会掉出，出现「有流量但查不到归属」。
- LAN↔LAN 被交换机硬件桥接，若用 user-port netdev 统计（`ip -s link`）看不到；且该统计同样被 PPE 绕过。
- 6.6 上要拿端口字节，必须**回移驱动补丁或自己读 0x48/0xa8 寄存器**，不是纯读取。

---

## Q3：MT7981/7986 的 PPE per-flow accounting

**结论：** mainline 有逐流字节计数，但只经 **debugfs 文本**暴露（无 netlink/procfs）；MT7621 没有（驱动不置 `has_accounting`，硬件也无该 MIB 块）。社区项目 traffic-survey 走的**不是** debugfs，而是 conntrack + 厂商 hnat 回灌。

### 证据
- **接口**：`/sys/kernel/debug/ppe0/entries` 与 `/sys/kernel/debug/ppe0/bind`（每 PPE 一个 `ppe%d` 目录，见 [mtk_ppe_debugfs.c](https://github.com/torvalds/linux/blob/master/drivers/net/ethernet/mediatek/mtk_ppe_debugfs.c) 的 `debugfs_create_file("entries"|"bind", ...)`）。`bind` 只列 BIND 态（已卸载）表项，行尾追加 `packets=%llu bytes=%llu`。
- **数据源**：`mtk_foe_entry_get_mib()` → `mtk_mib_entry_read()`，且 `if (!ppe->accounting) return NULL`；读到的值累加进 `ppe->acct_table`（`acct->bytes += bytes`）→ **debugfs 是条目生命周期累计值**，可直接差分算增量/速率。
- **支持矩阵**（mainline `mtk_eth_soc.c`）：`has_accounting=true` 仅 mt7622 / mt7629 / mt7981 / mt7986 / mt7988；**mt7621、mt7623 为 false**（两者 `offload_version=1`）。
- **来源提交**：Daniel Golle，[`[PATCH net-next v14 6/9] net: ethernet: mtk_eth_soc: ppe: add support for flow accounting`](https://lore.kernel.org/netdev/f943f6da8c276ab96a29c79922524297344fba73.1679230025.git.daniel@makrotopia.org/raw)，正文写明「The PPE units found in MT7622 and newer support packet and byte accounting of hw-offloaded flows」。
- **`luci-app-traffic-survey`（Become-ILLUSORY）实际做法**：[init.d](https://github.com/Become-ILLUSORY/luci-app-traffic-survey/blob/main/root/etc/init.d/traffic-survey) 里先 `echo 1 > nf_conntrack_acct`，再 `echo 7 1 > /sys/kernel/debug/hnat/hnat_setting` 打开 `nf_conntrack update`（把 PPE 计数回灌 conntrack）；C 守护 `luci.client-rates` 用 libmnl + libnetfilter_conntrack 做 **ctnetlink dump** 读 `bytes=`，**uloop 2 秒**采样，per-MAC 累计值持久化 `/tmp`。即：**读的是 conntrack，不是 `ppe0/bind`**。

### 局限
- **24.10 官方固件没有 `/sys/kernel/debug/hnat`**：该节点来自 MediaTek 下游 feed / 第三方 mt798x 固件（[chasey-dev/immortalwrt-mt798x-rebase](https://github.com/chasey-dev/immortalwrt-mt798x-rebase)）的 out-of-tree `mtk-hnat` 模块，stock OpenWrt 只有 mainline PPE → traffic-survey 那套在官方 24.10 上**无效**，只能自己解析 `ppe0/bind`。
- debugfs 是文本、无事件通知，只能轮询；表可达数千条，全表 dump 有可观开销。
- 只有**已卸载**的流有条目，短流/未卸载流不在表内，须与 conntrack 合并。
- 条目是五元组而非设备：要自己由 conntrack src / DHCP 租约 / FDB 反查内网 IP→MAC。
- **MT7621 为何不行**：mainline `has_accounting=false`，`mtk_foe_entry_get_mib()` 直接返回 NULL，且只有 offload v2 的 SoC 才有该 MIB 寄存器块 → 是「硬件 + 驱动都没有」，不是单纯驱动没暴露。
- **存疑（未查证）**：traffic-survey README 称「部分 MT7621/7622 `per_flow_accounting=false`」，而 mainline 对 MT7622 置 `true` —— 二者指的不是同一套实现（mainline PPE vs 厂商 hnat 模块），需实测确认。

---

## 推荐组合与结论

三条源互补，按「精度 / 成本」分层，**不要相加**（口径分别是 MAC 层、交换机端口、五元组）：

1. **WiFi 设备** → `station dump`，目前唯一零改动、抗卸载的逐设备源（WED 由 mt76 的 WCID 硬件计数兜底）。必须轮询落盘以对抗漫游清零；报表标注「MAC 层字节」或按 2–3% 折算。
2. **有线设备（1 端口 1 设备）** → 交换机端口 MIB 最可靠且含硬转流量，但 24.10 上需回移 `mt7530_get_eth_mac_stats()`（约几十行）或直接读 0x48/0xa8；否则退到 `ip -s link`，会被 PPE 漏计。
3. **逐流校验 / 兜底** → stock 用 `ppe0/bind` + conntrack 合并；第三方 mt798x 固件用 hnat 回灌 + ctnetlink（2s 轮询）。
4. **共同要求**：全部是累计值差分，设备断开、条目老化、WED 切换时都必须快照，否则丢数或被归错设备。
