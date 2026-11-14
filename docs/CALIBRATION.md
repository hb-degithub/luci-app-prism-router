# 真机标定手册

> 目标：在你的 OpenWrt 上量出三件事——**① 各档 offload 下统计到底少算多少倍；② 关掉 offload 到底损失多少吞吐；③ 无线 station 计数可不可信。**
> 拿到这三个数字，`strict` / `hybrid` / `performance` 三档策略的默认值就不用猜了。
> 预计耗时：40–60 分钟（含装包与两次模式切换）。
> **⚠️ 会短暂中断转发**：每次改 `flow_offloading` 都要 reload firewall，会有几秒断网。请在没人用网的时候做，别在办公时段跑。

---

## 0. 先记录现场（一定要做）

```sh
uci show firewall | grep -i offload
cat /proc/sys/net/netfilter/nf_conntrack_acct
cat /proc/sys/net/core/rmem_max
ubus call system board | jsonfilter -e '@.model'
grep -E 'OPENWRT_|VERSION' /etc/os-release
```

**尤其记下 `flow_offloading` 和 `flow_offloading_hw` 的原始值（0 或 1），最后要改回去。**

---

## 1. 确认测试用接口

```sh
# WAN 侧的实际设备名（可能是 wan / eth1 / pppoe-wan / wwan）
ubus call network.interface.wan status | jsonfilter -e '@.l3_device'
ip route show default

# 无线接口名（24.10 常见 phy0-ap0，老版本 wlan0；可能不止一个）
iw dev | awk '/Interface/{print $2}'
```

下面用 `<WAN>` 和 `<WL>` 代指。**如果 `iw dev` 输出多个接口，只取你在用的那一个**。

---

## 2. 基线自检（30 秒）

```sh
# conntrack 记账必须为 1，否则后面全部无效
cat /proc/sys/net/netfilter/nf_conntrack_acct

# 采集器要用的 netlink 缓冲区上限
cat /proc/sys/net/core/rmem_max

# conntrack 表使用率
echo "count=$(cat /proc/sys/net/netfilter/nf_conntrack_count) max=$(cat /proc/sys/net/netfilter/nf_conntrack_max)"

# 全锥 NAT（有第三方报告称它会让采集器收不到事件，仅记录）
lsmod | grep -i fullcone
```

**判读**：`nf_conntrack_acct` 是 `0` → 先 `sysctl -w net.netfilter.nf_conntrack_acct=1`。`rmem_max` 若是 180224 这种小值 → 你也踩在 ramips 那个经典坑上，记下来。

---

## 3. 准备测试样本

**必须用客户端设备下载，不能用路由器自己下**——路由器本机发起的流量走本地进程路径，不经过 forward 链，测不出卸载的影响，会得到一个"完全准确"的假结论。

需要一台客户端 + 一个 ≥1 GB 的下载地址：

```sh
# Linux / macOS
curl -o /dev/null -w 'downloaded_bytes=%{size_download}\ntime=%{time_total}\n' 'https://<大文件URL>'

# wget
wget -O /dev/null 'https://<大文件URL>'    # 读最后的字节数

# Windows PowerShell
(Measure-Command { Invoke-WebRequest -Uri 'https://<大文件URL>' -OutFile $env:TEMP\big.bin }).TotalSeconds
(Get-Item $env:TEMP\big.bin).Length
```

记下**实际下载字节数**（真值）和**耗时**（算吞吐）。

> 优先选**单连接**下载（直接下大文件，不要用迅雷/多线程下载器）。多连接会把流量拆成多条 conntrack 流，脚本只取最大单流，会让你误判。

---

## 4. 采集脚本（保存为 `/tmp/cal.sh`）

```sh
#!/bin/sh
# 用法: sh /tmp/cal.sh snap before
#       sh /tmp/cal.sh snap after
#       sh /tmp/cal.sh diff
D=/tmp/cal
WAN=${WAN:-$(ubus call network.interface.wan status 2>/dev/null | jsonfilter -e '@.l3_device' 2>/dev/null)}
[ -z "$WAN" ] && WAN=$(ip route show default | awk '{print $5; exit}')
WL=${WL:-$(iw dev 2>/dev/null | awk '/Interface/{print $2}' | head -1)}

snap() {
	mkdir -p "$D"; t=$1
	date +%s > "$D/$t.time"
	grep -E "^[[:space:]]*$WAN:" /proc/net/dev | cut -d: -f2 > "$D/$t.dev"
	[ -r /proc/net/nf_conntrack ] && cat /proc/net/nf_conntrack > "$D/$t.ct"
	[ -n "$WL" ] && iw dev "$WL" station dump > "$D/$t.sta" 2>/dev/null
	cat /proc/sys/net/netfilter/nf_conntrack_count > "$D/$t.ctc" 2>/dev/null
	echo "snapshot $t ok  (wan=$WAN wl=$WL)"
}

diff() {
	echo "=== 时间跨度 ==="
	echo "$(( $(cat "$D/after.time") - $(cat "$D/before.time") )) 秒"

	echo
	echo "=== WAN 接口字节增量 ==="
	awk 'NR==FNR{for(i=1;i<=NF;i++)b[i]=$i;next}{printf "wan_rx_delta=%d  wan_tx_delta=%d\n", $1-b[1], $9-b[9]}' \
		"$D/before.dev" "$D/after.dev"

	echo
	echo "=== conntrack 最大单向字节数（≈测试流量本身）==="
	if [ -r "$D/after.ct" ]; then
		printf 'max_single_direction_bytes='
		grep -o 'bytes=[0-9]*' "$D/after.ct" | cut -d= -f2 | sort -n | tail -1
		echo "（若这个数 ≈ 你下载的字节数 → 记账正常；若只有几 KB → 被 offload 绕过了）"
	else
		echo "（没有 /proc/net/nf_conntrack，见文末 FAQ）"
	fi

	echo
	echo "=== conntrack 条目数 ==="
	echo "before=$(cat "$D/before.ctc" 2>/dev/null)  after=$(cat "$D/after.ctc" 2>/dev/null)"

	echo
	echo "=== 无线 station 字节增量 ==="
	if [ -r "$D/before.sta" ] && [ -r "$D/after.sta" ]; then
		awk '
			NR==FNR{
				if ($1=="Station") m=$2
				if ($1=="rx" && $2=="bytes:") brx[m]=$3
				if ($1=="tx" && $2=="bytes:") btx[m]=$3
				next
			}
			{
				if ($1=="Station") m=$2
				if ($1=="rx" && $2=="bytes:") printf "  %s rx_delta=%d\n", m, $3-brx[m]
				if ($1=="tx" && $2=="bytes:") printf "  %s tx_delta=%d\n", m, $3-btx[m]
			}
		' "$D/before.sta" "$D/after.sta"
	else
		echo "（没有 station 快照）"
	fi
}

case "$1" in
	snap) snap "$2" ;;
	diff) diff ;;
	*) echo "用法: $0 snap <before|after> | diff" ;;
esac
```

> 说明：conntrack 那条指标故意取**最大单流单向字节数**，而不是全表求和——因为流会随时间消失，前后求和没有意义。1 GB 单连接下载结束后，那条流仍在 `ESTABLISHED/TIME_WAIT`，能直接读到。**下载完成后 10 秒内就要采集**（`tcp_timeout_time_wait` 默认只有 120 秒）。

---

## 5. 测试矩阵：3 档 × 2 种接入

每格跑一次，**每次跑之前先确认当前档位**：`uci show firewall | grep -i offload`

### 第 1 档：全关（strict 基线）

```sh
uci set firewall.@defaults[0].flow_offloading='0'
uci set firewall.@defaults[0].flow_offloading_hw='0'
uci commit firewall && /etc/init.d/firewall reload
```

等 10 秒，**有线客户端**测试：

```sh
sh /tmp/cal.sh snap before
# ── 在客户端上下载 1GB，记下实际字节数 ──
sh /tmp/cal.sh snap after
sh /tmp/cal.sh diff
```

再换**无线客户端**重复一遍。

### 第 2 档：只开软件卸载

```sh
uci set firewall.@defaults[0].flow_offloading='1'
uci set firewall.@defaults[0].flow_offloading_hw='0'
uci commit firewall && /etc/init.d/firewall reload
```

重复有线 + 无线。

### 第 3 档：开硬件卸载

```sh
uci set firewall.@defaults[0].flow_offloading_hw='1'
uci commit firewall && /etc/init.d/firewall reload
dmesg | tail -20     # 看有没有静默忽略/报错
```

重复有线 + 无线。

---

## 6. 怎么判读

每个组合填一行：

| 指标 | 取哪个数 |
|---|---|
| 真值 | 客户端报告的实际下载字节 |
| WAN 计数 | `wan_rx_delta`（下载方向） |
| conntrack 计数 | `max_single_direction_bytes` |
| **漏算倍数** | `真值 ÷ 计数`（两个计数各算一次） |
| 吞吐 | `真值 × 8 ÷ 秒数 ÷ 1e6`（Mbps） |

**四条判读规则**：

1. **`strict` 档下 conntrack 应该≈真值（偏差 <5%）**。如果差很多，说明还有别的漏算源（rmem 丢事件、表满、fullcone），**先停下来查**——这时后两档的数据都没有意义。
2. **`hybrid` 是否可行，只看无线那两行**：开硬件卸载后，station 的 `tx bytes` 增量是否仍≈真值（±10%）。是 → hybrid 成立；station 也被绕过 → 该机型不适用。
3. **看 WAN 接口计数是否被 PPE 绕过**：开硬件卸载后 `wan_rx_delta` 还跟不跟着涨。涨 → 我们的对账自检能工作；不涨 → 连对账都做不了，只能靠 station 计数。
4. **吞吐损失**：`strict` 与 `hw` 两档的 Mbps 之差就是"精度换速度"的真实代价。**如果两者接近，说明你机器 CPU 够用，那就不必纠结，直接 strict。**

---

## 7. 决策表

| 你的测量结果 | 建议默认策略 |
|---|---|
| 宽带 ≤300M，或 strict 档吞吐损失 <20% | **`strict`** —— 没有理由牺牲精度 |
| 千兆宽带 + 无线设备为主 + station 计数验证可用 | **`hybrid`** —— 满速且无线总量准 |
| WAN 接口计数在 hw 档也正常 | `hybrid` 额外获得可用的对账自检 |
| station 计数在 hw 档也不准 | 只能 `strict`；否则全盘估算 |

---

## 8. 恢复现场

```sh
uci set firewall.@defaults[0].flow_offloading='<原始值>'
uci set firewall.@defaults[0].flow_offloading_hw='<原始值>'
uci commit firewall && /etc/init.d/firewall reload
uci show firewall | grep -i offload     # 确认改回去了
```

**别忘了这一步**——很多人测完就忘，家里一直跑在关卸载的低速状态。

---

## 9. 结果回填（贴给我就行）

```text
机型：                     OpenWrt 版本：
WAN 设备：                 无线接口：
宽带上下行：               当前 offload（hw/sw）：
nf_conntrack_acct：        rmem_max：
conntrack count/max：      fullcone 模块：

┌──────────┬──────┬──────────┬─────────┬──────────┬────────┬──────────┐
│ 档位     │ 接入 │ 真值字节 │ WAN增量 │ ct最大流 │ 漏算倍 │ 吞吐Mbps │
├──────────┼──────┼──────────┼─────────┼──────────┼────────┼──────────┤
│ 全关     │ 有线 │          │         │          │        │          │
│ 全关     │ 无线 │          │         │          │        │          │
│ 软件卸载 │ 有线 │          │         │          │        │          │
│ 软件卸载 │ 无线 │          │         │          │        │          │
│ 硬件卸载 │ 有线 │          │         │          │        │          │
│ 硬件卸载 │ 无线 │          │         │          │        │          │
└──────────┴──────┴──────────┴─────────┴──────────┴────────┴──────────┘

无线 station（hw 档，下载前后）：
  tx bytes: before=          after=         增量=
  rx bytes: before=          after=         增量=
```

---

## 附：常见问题

**Q：`/proc/net/nf_conntrack` 不存在？**
A：内核没开 `CONFIG_NF_CONNTRACK_PROCFS`。装 conntrack 工具（`opkg update && opkg install conntrack`），把脚本里的 `cat /proc/net/nf_conntrack` 换成 `conntrack -L` 即可，其余逻辑不变。

**Q：WAN 是 PPPoE，能数准吗？**
A：能，但 **PPPoE 每包多 8 字节封装**（2 字节 PPP 协议 + 6 字节 PPPoE 头）。接口字节会比 IP 层略高，属正常，不是漏算。

**Q：`strict` 档也对不上（偏差 >5%）怎么办？**
A：先别往下测。按序查：① `dmesg | grep -i netlink` 有没有 `No buffer space available`；② `nf_conntrack_count` 是否接近 max；③ 有没有 `fullcone` 模块；④ 是不是走了 IPv6（本文只测 IPv4，v6 计数路径不同）。

**Q：无线测试时别人在用网，会不会污染？**
A：会。station 是按 MAC 分的，但如果测试机上有其它应用在跑，增量会混进去。测试前把客户端其它应用关掉。

**Q：能不能省掉第 1 档（全关）？**
A：不能。它是基线——没有它，你不知道"少算"是多少倍，只知道"少"。
