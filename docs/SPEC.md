# 实现契约 v1（所有 agent 按此开发，不要自行改动字段名）

> 目标环境：192.168.100.1 iStoreOS 24.10.7（x86_64, musl, opkg, 有 ucode/curl/openssl/nlbwmon，无 sqlite3）
> 参考真机：AP 192.168.100.3（aarch64, apk, 无 openssl）
> 硬约束：**不引入 C 编译**；只用 `ucode` + `ash` + `curl`。电线风格：能跑、可读、可维护。

---

## 1. 数据源与职责划分（关键：不重复计数）

| 数据源 | 负责什么 | 明确不负责 |
|---|---|---|
| **OpenClash `/connections`**（mihomo API，`127.0.0.1:9090`，Bearer secret） | 被 clash 接管的流量：**真实域名(host)**、**出口链路(chains)**、**每连接字节**、源设备 IP | 未经 clash 的流量 |
| **`/proc/net/nf_conntrack`** 轮询 | 未经 clash 的**直连流量**（目的 IP 不在 fake-ip 段） | fake-ip 段的流（已被 clash 接管，跳过，否则双计） |
| **`/proc/net/dev`** | 接口总量，仅用于对账与实时总速率 | 设备维度 |
| **`brctl showmacs <lan_bridge>`**（桥 FDB） | 设备 MAC 学在哪个桥端口 → **接入方式**（wifi/wired/unknown） | 字节量、代理/直连归属 |

**去重规则（必须严格执行）**：conntrack 中 *orig dst* 落在 `fake_ip_ranges`（默认 `198.18.0.0/16`）的流，一律不计入设备直连流量。

**代理/直连判定**：clash 连接的 `chains[0] == "DIRECT"` → 直连（但仍经 clash，host 已知）；否则 → 代理，出口节点名 = `chains[0]`。

---

## 2. 进程与文件

```
/usr/bin/prism-routerd            # ucode 常驻守护进程（procd 托管）
/etc/init.d/prism-routerd
/etc/config/prism-router          # UCI 配置
/tmp/prism-router/state.json      # 守护进程每 5s 原子写入（rename）
/tmp/prism-router/history.json    # 当日 5 分钟桶
/etc/prism-router/daily/          # 每日汇总（JSON，一天一个文件，很小）
/etc/prism-router/devices.json    # 设备别名/分组/首次出现（§10.1；0644 root:root，原子写）
/etc/prism-router/nodes/          # 子节点快照 <node_id>.json / 采样 <node_id>.jsonl（§9 清理）
/etc/prism-router/stations/       # 哑桥 AP 站点元数据 <node_id>.json（§9 清理）
/tmp/prism-router/*.log           # 各模块日志（§9 按天删 + 超限截断）
/tmp/prism-router/feishu-queue/   # 飞书重试队列（§9 总量上限）
/usr/share/prism-router/retention.uc     # 数据/日志保留与清理脚本（cron 调用，见 §9）
/usr/share/rpcd/ucode/prism-router.uc   # rpcd 后端，读 state/history 返回 JSON
/www/cgi-bin/prism-router-metrics # Prometheus 指标导出 CGI（§10.3；只读 + token 认证）
/etc/init.d/prism-router-panel         # 独立面板服务的 procd init（§11；默认关闭）
/www/prism-router-panel/               # 独立面板静态根：index.html / app.js / style.css（§11）
/www/prism-router-panel/cgi-bin/panel-api  # 独立面板只读 JSON CGI（§11；0644→0755，ucode）
/www/cgi-bin/prism-router-control      # 家长控制写操作 CGI + 本机 root 的 apply 重放（§12；0755，ucode）
/etc/prism-router/paused.json          # 暂停列表（§12；0600，原子写）
/etc/prism-router/control.log          # 家长控制审计（§12；0600，最近 200 行）
/usr/share/rpcd/acl.d/luci-app-prism-router.json
/usr/share/luci/menu.d/luci-app-prism-router.json
/htdocs/luci-static/resources/view/prism-router/*.js
```

**UCI 配置项**（默认值）：

```
config settings 'settings'
    option enabled '1'
    option poll_interval '5'          # 秒
    option clash_api '127.0.0.1:9090'
    option clash_secret ''            # 留空则自动读 openclash.config.dashboard_password
    option fake_ip_ranges '198.18.0.0/16'
    option history_days '7'
    # 接入方式（无线/有线）：全部靠主路由自己判定，AP 上不装任何东西
    option lan_bridge 'br-lan'        # brctl showmacs 的目标网桥
    option wireless_ports ''          # 无线上联桥端口号，如 '3' 或 '3,5'
    option ap_macs ''                 # AP 的 LAN MAC 列表；配了则由 FDB 反查端口（优先于 wireless_ports）
    option link_refresh '30'          # 重新读取 FDB 的间隔（秒）
    # 软路由自身性能指标（state.json 的 system 段，见 §3.3）
    option system_enabled '1'         # 1=采集；0=整段不写入 state.json
    option wan_iface ''               # WAN 接口名（eth3/pppoe-wan…）；留空=默认路由所在接口
    # ── 月配额（§10.2；后端只给字节数，剩余量/百分比由前端算）──────────
    option quota_mode 'none'          # none | device | total
    option quota_monthly_gb ''        # 单设备默认月配额（GB，可带小数）；空=不限制
    option quota_total_gb ''          # 全屋月度总配额（GB）；空=不限制
    # ── Prometheus 指标导出（§10.3）────────────────────────────────
    option metrics_enabled '0'        # 1=允许抓取；0=关闭
    option metrics_token ''           # 抓取令牌；未启用或为空时一律 403
config feishu 'feishu'
    option enabled '0'
    # 路线一：群自定义机器人（复制 webhook，无二维码流程）
    option webhook ''
    option secret ''
    # 路线二：自建应用机器人（二维码/搜索加群），三件套齐全时优先于 webhook
    option app_id ''
    option app_secret ''
    option chat_id ''
    option card_wrapper 'card'      # card={"type":"card","data":card} | bare
    option daily_time '08:30'       # 旧字段；report_time 未设时作为兜底
    option report_chat_enabled '1'
    # ── 发什么（见 §7.1）─────────────────────────────────────────
    option report_items 'overview,proxy_direct,wifi_wired,top_devices,top_apps'
    # ── 什么时候发（见 §7.2）─────────────────────────────────────
    option report_mode 'daily'      # daily | weekly | both
    option report_time '08:30'      # HH:MM（本地时间）
    option report_weekday '1'       # 1=周一 … 7=周日（weekly / both 用）
    # ── 什么情况下发（见 §7.3；留空 = 关闭，行为与旧版一致）──────
    option alert_app_daily_limit '' # 单个域名/应用日流量，如 20G
    option alert_spike_ratio ''     # 突增倍数：当前小时 > 近 7 日均值×N
    option alert_offline_min ''     # 设备离线超过 N 分钟
    option alert_cpu_pct ''         # 依赖 state.system（§3.3）
    option alert_mem_pct ''
    option alert_disk_pct ''
    option alert_quiet_hours ''     # 免打扰，如 23:00-07:00；只抑制告警
```

> 另有 `config retention 'retention'` 段（数据 / 日志保留与清理，8 个阈值 + 总开关，
> 默认值与语义见 **§9**）。新装的默认配置末尾带这一段；**老配置升级不会被覆盖**
> （`/etc/config/prism-router` 是 conffile），需要手动追加或重装配置才会出现。

---

## 3. state.json 结构（**字段名固定**）

```json
{
  "ts": 1794700000,
  "uptime": 360000,
  "source": { "clash": "ok", "conntrack": "ok" },
  "totals": {
    "direct_rx": 123456789, "direct_tx": 1234567,
    "proxy_rx": 987654321,  "proxy_tx": 7654321,
    "wifi_rx": 500000000, "wifi_tx": 3000000,
    "wired_rx": 600000000, "wired_tx": 5000000,
    "unknown_rx": 1111110, "unknown_tx": 88888,
    "rx_rate": 12500000,    "tx_rate": 980000
  },
  "nodes": {
    "US2-HY2": { "rx": 800000000, "tx": 6000000 },
    "DIRECT":  { "rx": 123456789, "tx": 1234567 }
  },
  "devices": [
    {
      "ip": "192.168.100.190", "mac": "dc:56:7b:89:fb:31",
      "hostname": "LAPTOP-C8FAUCDA",
      "link": "wifi",
      "direct_rx": 1000, "direct_tx": 200,
      "proxy_rx": 500000, "proxy_tx": 8000,
      "rx_rate": 24000, "tx_rate": 1200,
      "last_seen": 1794699990,
      "apps": {
        "ws.chatgpt.com": { "rx": 12345, "tx": 678, "chain": "US2-HY2" },
        "www.baidu.com":  { "rx": 4000,  "tx": 300, "chain": "DIRECT" }
      }
    }
  ],
  "apps": [
    { "host": "ws.chatgpt.com", "rx": 90000, "tx": 5000, "chain": "US2-HY2", "devices": 2 }
  ],
  "system": {
    "uptime": 123456,
    "load1": 0.2, "load5": 1.3, "load15": 2.8,
    "cpu_pct": 25.0, "cpu_cores": 4,
    "mem_total": 4294967296, "mem_avail": 3221225472, "mem_pct": 25.0,
    "swap_total": 0, "swap_free": 0,
    "temp_c": 42.9,
    "disk_total": 1073741824, "disk_used": 268435456, "disk_pct": 25.0,
    "wan_rx_rate": 10000, "wan_tx_rate": 1000
  },
  "health": {
    "accounting_confidence": "exact",
    "reasons": [],
    "conntrack_count": 1800,
    "clash_connections": 175,
    "clash_poll_ms": 35,
    "link_source": "brctl",
    "link_bridge": "br-lan",
    "link_ports": [3],
    "link_ports_from": "ap_macs",
    "link_entries": 42,
    "link_refresh": 30,
    "link_error": ""
  }
}
```

- `rx` = 下载方向（到设备），`tx` = 上传方向。**统一按"设备视角"**。
- **§10 的新字段（alias/group/first_seen/month_*/quota）不在 state.json 里**：它们由 rpcd 在
  `get_state` 里算出来拼上去（`state.json` 只有守护进程写，契约不变，老消费方零影响）。
- `apps` 每设备保留 **Top 15**（按 rx 排序），其余合并为 `__other__`。
- `devices` 按 `proxy_rx + direct_rx` 降序，**最多 40 个**；全局 `apps` 最多 40 条。
- **硬限制（实测）**：ubus 单条消息上限 **262144 字节**，超过会报 `Operation not supported`。所以 state.json 必须控制在 ~180KB 以内——40 设备 × 15 应用实测约 8–12KB，安全。


### 3.1 语义补充（实现中发现的歧义，以此为准）

- **`totals` = 进程启动以来累计**（进程重启归零），与 `uptime` 配套；"今日/历史"口径看 `history.json` 与 `/etc/prism-router/daily/`。UI 必须在卡片上标明这一点，不能把 `totals` 当"今日"展示。
- **顶层 `uptime` ≠ `system.uptime`**：顶层是**守护进程**运行秒数（`time() - started`），
  `system.uptime` 是**系统**运行秒数（`/proc/uptime`）。两者不得混用，前端标签也要写清。
- **`accounting_confidence` 枚举固定为** `exact | degraded | unavailable`，不得新增其它值。
- **`__other__` 桶固定为** `{ rx, tx, chain: "MIXED" }`；前端按 `chain` 过滤时必须把 `MIXED` 当作"混合"而不是节点名。
- **历史精度现实**：`history.json` 在 tmpfs，重启即丢 → "近 7 天折线"实际是「当天 5 分钟精度 + 往日日粒度」，前端要么两段拼接，要么只画当日。SPEC 不承诺跨天 5 分钟数据。
- **软重启连续性**：守护进程在 `/tmp/prism-router/baseline.json` 原子保存连接计数器基线（含采样时间与日期），启动时只接受同日且新鲜的基线；不存在/损坏/过期时首轮只采样，不将历史连接累计值当作新流量。当日 daily 在启动时恢复；每轮先成功写 daily 再保存连接基线，避免把已入账的连接差量重复计算。`/tmp` 清空后首轮重建基线，可能少计停机后的第一段流量，但不回放完整连接历史。
- **双源补充去重**：除 fake-ip 网段外，conntrack 命中本轮或上一轮 Clash 活跃连接的协议、设备/目的地址与端口时跳过；相应计数放入 `health.clash_deduped`。失效基线或读取失败必须进入降级原因，不能仍声称精确。
- **已知漏计**：完全落在两次轮询之间的短连接（clash 从未见过它、conntrack 又因 fake-ip 去重被跳过）会两边都不计。这是当前架构的固有盲区，需在文档中如实说明；缓解手段是缩短 `poll_interval`。

### 3.2 接入方式（无线 / 有线）——与代理/直连正交的第二个维度

母路由 x86 多网卡桥接（`br-lan` 含 eth1/eth2/eth3），哑桥 AP 挂在**一个桥端口**上
（实测 `brctl showmacs br-lan`：AP 自己的 br-lan MAC 与无线客户端都学在该端口）。因此：

- **`devices[].link` 枚举固定为** `wifi | wired | unknown`，不得新增其它值。
- **判定链**：设备 MAC --(`brctl showmacs <lan_bridge>`)--> 桥端口 --(无线上联端口集合)--> `wifi`/`wired`；
  FDB 未命中，或拿不到设备 MAC（无 DHCP 租约）→ `unknown`。
- **无线上联端口**：`ap_macs` 在 FDB 中反查到的端口（优先）；否则用 `wireless_ports` 显式配置；
  两者都空 → 端口集合为空，FDB 学到的设备全部归为 `wired`（**部署时必须配其中之一**）。
  `ap_macs` 配了但一个都没在 FDB 里找到时，保持 `wireless_ports` 原值并记 reason。
- **`totals.wifi_* / wired_* / unknown_*`** 与 `direct_* / proxy_*` 是两个维度，必须同时满足：
  - 代理/直连互斥：`direct + proxy` 就是总量；
  - 接入三桶互斥且完备：**`wifi_* + wired_* + unknown_* == direct_* + proxy_*`**（rx、tx 分别成立）。
  - conntrack 侧与 clash 侧每一笔增量都**同步且只**进一个 link 桶；`sourceIP` 为空的 clash 连接进 `unknown`。
- **`health.link_source` 枚举固定为** `brctl | none`：`brctl` = 最近一次 FDB 读取成功；
  `none` = 读不到（brctl 缺失 / 无此网桥 / 输出无法解析），此时所有设备 `unknown`，
  失败原因写在 `health.link_error`（只增字段）。配置过 `wireless_ports`/`ap_macs` 时，
  同一原因还会进 `health.reasons`（`accounting_confidence` 因此可能变 `degraded`），
  但 **direct/proxy 统计完全不受影响**。
- **`health.link_ports`** 是生效的无线上联端口数组（`[]` = 未配置）；`health.link_ports_from`
  为 `ap_macs | wireless_ports | none`，说明端口是怎么来的；`health.link_entries` 是解析到的 FDB 条目数，
  `health.link_refresh` 是 FDB 刷新间隔。
- **FDB 老化记忆**：桥 FDB 的老化时间只有几十秒，空闲设备会从表里消失。守护进程按 MAC 记住上一次
  判定结果（进程内存，重启清空），老化期间沿用，避免睡眠中的手机/音箱被翻成 `unknown`。
  配置了接入判定却暂时解析不出端口时，宁可给 `unknown` 也不武断判 `wired`。
- **仅母路由本地有效**：`link` / 接入三桶只出现在母路由自己的 `state.json` 与 rpcd 返回里；
  `push.uc` 的子节点快照（`/etc/prism-router/nodes/*.json`）不含这些字段，多节点页面也不展示，
  这是刻意的——桥 FDB 只在母路由上存在。
- **已知限制**：AP 的上联端口如果还下挂了有线设备（AP 的 LAN 口接 PC），这些设备会被误判为 `wifi`；
  同一个桥端口上混挂有线和无线在二层无法区分。要精确到端口只能靠 AP 侧上报，
  而 `stations.uc` 只报信号/协商速率，不报端口（且不报字节，见 AP-ROLE 方案 B）。

### 3.3 系统指标（`system`）——辅助信息，与主统计完全隔离

`system` 是 state.json 的**新增顶层字段**（位于 `apps` 与 `health` 之间），每轮 poll 更新，
全部来自只读的 /proc 或 sysfs，成本极低。字段名、单位、范围固定：

| 字段 | 类型 / 单位 | 来源 | 说明 |
|---|---|---|---|
| `uptime` | int，秒 | `/proc/uptime` | **系统**运行秒数（顶层 `uptime` 是进程秒数） |
| `load1` / `load5` / `load15` | 1 位小数 | `/proc/loadavg` | 系统负载 |
| `cpu_pct` | 1 位小数，0–100 | `/proc/stat` 两次采样 | 非 idle、非 iowait 占比 |
| `cpu_cores` | int | `/proc/cpuinfo` | `processor` 行数，解析成功一次后缓存 |
| `mem_total` / `mem_avail` | int，字节 | `/proc/meminfo` | MemTotal / MemAvailable（kB×1024） |
| `mem_pct` | 1 位小数，0–100 | 计算 | `(mem_total-mem_avail)/mem_total*100` |
| `swap_total` / `swap_free` | int，字节 | `/proc/meminfo` | 没有 swap 时**合法值为 0**（不是缺数据） |
| `temp_c` | 1 位小数，℃ | `/sys/class/thermal/thermal_zone0/temp` | 毫摄氏度÷1000；没有该文件则省略 |
| `disk_total` / `disk_used` | int，字节 | `df -k /` | rootfs 容量 |
| `disk_pct` | 1 位小数，0–100 | 计算 | `used/(used+avail)`，与 `df` 的 Use% 同口径 |
| `wan_rx_rate` / `wan_tx_rate` | int，字节/秒 | `/proc/net/dev` | WAN 接口两轮字节差 / 实际秒数 |

规则（实现与门禁都以本节为准）：

- 所有数值只能是**整数或 1 位小数**，JSON 定点输出，**不出现科学计数法**。
- **缺数据就省略字段，不写 0**。例：x86 没有 `thermal_zone0` → 没有 `temp_c`；
  只有 `MemAvailable` 缺失 → 省略 `mem_avail` 与 `mem_pct`，但保留 `mem_total`。
- `cpu_pct` 用相邻两次 `/proc/stat` 的 total/idle（idle+iowait）差值计算；
  进程启动后**第一轮没有上一采样，因此没有 `cpu_pct`**（约一个 poll 周期后出现）。
  窗口 = 实际 poll 间隔（自适应降频时按实际 dt 计算，速率/占用率仍正确）。
- `cpu_cores` 只成功解析一次后缓存，不每轮读文件。
- `disk_*` 用 `df -k <rootfs>`，**最多 60 秒一次**并缓存结果，不要每轮 fork。
- `wan_*`：配置 `wan_iface` 非空则用它；否则取 `/proc/net/route` 中默认路由
  （Destination=00000000、metric 最小）所在接口。首轮无差值、接口切换、
  计数器回绕时省略对应字段（不猜 0）。
- **体积上限**：`system` 段序列化后 **< 800 字节**（正常约 300–430B）；
  state.json 总体增量 **< 1KB**（当前 ~10KB，安全）。
- **失败降级**：任何一项读不到只是缺字段；整段采集异常时给空对象 `{}`。
  **绝不**写入 `health.reasons`，不改变 `accounting_confidence`，也**绝不影响**
  `direct_* / proxy_* / wifi_* / wired_* / unknown_*` 的任何数值。
- `system_enabled=0` 时整个 `system` 键不出现，老消费方完全无感。
- `conntrack_count` 保持在 `health` 里，**不搬进** `system`。
- 仅母路由本地有效：`push.uc` 的子节点快照与多节点页面不包含 `system`
  （子节点各自采集自己的系统指标），与 `link` 字段的处理方式一致。

**接口层透传**：`get_state` 按白名单把 `system` 里的**标量**字段原样返回给前端
（rpcd 侧限制为最多 32 个标量键，未知结构一律丢弃），未知/缺失字段不得报错。
`set_config` 的 settings 白名单需包含 `system_enabled` 与 `wan_iface`，未列出时这两个
配置项只能用 `uci set` 手工修改。

## 4. history.json（当日 5 分钟桶）

```json
{ "day": "2026-11-14",
  "buckets": [
    { "ts": 1794700200,
      "direct_rx": 1, "direct_tx": 1, "proxy_rx": 1, "proxy_tx": 1,
      "top_apps": [ {"host":"...","rx":1,"tx":1} ],
      "top_devices": [ {"ip":"...","rx":1,"tx":1} ] } ] }
```

## 5. rpcd API（LuCI 前端只调这些）

对象名 `prism-router`，方法：

| 方法 | 参数 | 返回 |
|---|---|---|
| `status` | 无 | `{enabled, running, confidence, sources:{clash,conntrack}, link_source, link_bridge, link_ports, link_ports_from, version}` |
| `get_state` | 无 | state.json 原文对象（含 `devices[].link`、`health.link_*`、`system` 段，按 180KB 预算裁剪） |
| `get_history` | `{days}` | `{days:[{day, buckets:[...], summary:{totals}}]}`；daily 只投影 `summary.totals`，最终响应受 180KB 预算限制，裁剪时带 `truncated` |
| `get_daily` | `{day}` | 当日汇总 |
| `get_nodes` | 无 | 子节点快照（§多节点） |
| `get_stations` | 无 | 哑桥 AP 站点元数据（只读，无字节） |
| `set_device_meta` | `{mac, alias, group}` | `{ok, mac, alias, group, devices}`；写 `/etc/prism-router/devices.json`（§10.1） |
| `export_csv` | `{what}` | `{ok, what, filename, rows, csv}`；what = devices\|apps\|daily（§10.3） |
| `test_feishu` | 无 | `{ok, code, msg}` |
| `set_config` | `{section, options}` | `{ok}`；`settings` 白名单含 `lan_bridge/wireless_ports/ap_macs/link_refresh/system_enabled/wan_iface/quota_mode/quota_monthly_gb/quota_total_gb/metrics_enabled/metrics_token` |
| `restart` | 无 | `{ok}` |

ACL：`read.ubus.prism-router` 给 status/get_state/get_history/get_daily/get_nodes/get_stations/**export_csv**；
`write.ubus.prism-router` 给 test_feishu/feishu_chats/set_config/restart/**set_device_meta**。

### 5.1 节点 / AP 认证协议（v2）

- 母节点按类型化 UCI 注册表查找凭证：`config node` + `option node_id/secret`，AP 为 `config station` + `option node_id/token`。UCI section 名不能含 `-`，带连字符的 ID 使用匿名 section + 显式 `node_id`。
- 节点签名原文：`v2\n<node_id>\n<timestamp>\n<nonce>\n<sha256(body)>`；使用 `Authorization: PrismRouter ...` 传递，签名与 token 不进 URL。nonce 为随机 16 字节 hex，母节点以 `/tmp` 下有界 TTL 记录拒绝重放。
- 未知节点、错误凭证、重复 nonce、超限或长度不符的 body 均拒绝；`Content-Length` 在读取前检查。
- HMAC 在 ucode 内组装，sha256sum/openssl 只接收数据，不把密钥放入 argv、环境或临时磁盘。
- HTTPS 默认验证系统 CA 与主机名，不使用 `-k`；支持显式 CA/公钥 pin。禁止跨源和降级重定向。
- `legacy_shared_secret=1` / `legacy_stations_token=1` 仅用于短期迁移旧全局凭证，默认均为 0；不得作为长期多节点方案。

---

## 6. 前端页面（LuCI JS）

| 路由 | 文件 | 内容 |
|---|---|---|
| `admin/services/prism-router/overview` | `overview.js` | 总览卡片（总流量/代理/直连/实时速率）、**代理 vs 直连环形图**、**接入方式（无线/有线/未知）两张卡 + 三段环形图**、Top 应用、Top 设备、健康状态条 |
| `.../devices` | `devices.js` | 设备表（主机名/MAC/IP/**接入**/直连/代理/合计/速率/信号），点开抽屉看该设备应用分布 |
| `.../apps` | `apps.js` | 应用（域名）排行，可按 直连/代理/节点 过滤，可下钻到设备 |
| `.../settings` | `settings.js` | 采集参数、clash secret、**接入方式（lan_bridge / wireless_ports / ap_macs / link_refresh）**、飞书 webhook+测试、报表时间 |

接入方式的 UI 约定：概览页的无线/有线和代理/直连**分开呈现、不相加**；设备页「接入」列无数据时显示 `-`；
未配置无线上联端口时页面要明说"当前一律归为有线"，FDB 读不到时提示原因。

图表：24.10 用自带 `luci-lib-chartjs`（`L.resource('nlbw.chart.min.js')` 然后全局 `Chart`）。

---

## 7. 飞书推送（日报 / 周报 / 告警）：内容、时间、条件均可配

模块：`/usr/share/prism-router/feishu.uc`（ucode + curl + openssl，无 python/jq）。
卡片 JSON 2.0，`schema:"2.0"`，元素放 `body.elements`；**绝不**使用 `note`/`action`（2.0 已移除）。
发消息必须解析响应 `code`，非 0 视为失败（19021/19024/11232 都是 HTTP 200）。

命令：

| 命令 | 语义 |
|---|---|
| `feishu.uc daily [--dry-run]` | **立即**生成并发送，忽略 `report_mode/report_time`（手动触发、老 cron 兼容） |
| `feishu.uc scheduled` | cron 入口：按 §7.2 判定「到点没」再发，同一个 kind+日期只发一次 |
| `feishu.uc alerts [--dry-run]` | 扫描 `state.json`(+`history.json`) 发告警；`--dry-run` 只打印将发的告警 |
| `feishu.uc card` / `check` / `selftest` / `status` | 离线生成卡片 / 校验卡片 / 自检 / 看配置 |

cron（用户自己加；`scheduled` 才按配置判定）：

```sh
30 8 * * *    ucode /usr/share/prism-router/feishu.uc scheduled          # daily 模式
30 8 * * 1    ucode /usr/share/prism-router/feishu.uc scheduled          # weekly 模式
3,8,...,58 * * * *  ucode ... scheduled --window 10                        # 有容错、且不会重复发
3,13,23,33,43,53 * * * *  ucode ... alerts
```

### 7.1 发什么：`report_items`

逗号分隔，**按书写顺序渲染**；未列出的区块不渲染。可选值与内容：

| 区块 | 卡片中的形态 | 数据来源 | 缺数据时 |
|---|---|---|---|
| `overview` | markdown（总流量/代理/直连/在线设备/实时速率）**+ 近 24h 折线图** | `totals`、`devices[].last_seen`、`history.json` | 缺 `state` 时用 history 汇总并注明 |
| `proxy_direct` | markdown：代理 X%（A）/ 直连 Y%（B） | `totals.proxy_* / direct_*` | 分母 0 → 占比显示 `—` |
| `wifi_wired` | markdown：无线/有线/未知 占比 | `totals.wifi_*/wired_*/unknown_*`，缺则按 `devices[].link` 汇总 | 都缺 → 显示 `—` |
| `system` | markdown：CPU（含核数）/内存/负载/磁盘/温度/运行时长/WAN 速率 | **`state.system`（§3.3）** | **静默跳过该区块**（不报错、不留空块） |
| `top_devices` | table，列 `host/direct/proxy/total`，`page_size=10` | `devices[]` | 行数 0（表仍在） |
| `top_apps` | table，列 `app/chain/total`，`page_size=10` | `apps[]`（`host/chain`） | 行数 0（表仍在） |
| `nodes` | markdown：节点名 + 流量 + 占比（最多 8 个，其余合并计数） | `nodes`（`DIRECT` 不算节点） | 无节点 → 静默跳过 |

规则：

- **顺序**：`report_items` 的书写顺序就是 `body.elements` 的顺序（`overview` 的图表紧跟其后），脚注永远最后。
- **空**：`report_items` 的**整项缺省** = 用默认清单（`overview,proxy_direct,wifi_wired,top_devices,top_apps`），
  保证老配置行为不变；写 `none`（或 `off`/`-`/`0`）= **什么都不发**（`daily` 只记日志并退出 0）。
  注意 UCI 的坑：`option report_items ''` 在 UCI 里**等同「未设置」**（`uci get` 返回空、`uci commit` 会删掉该行），
  所以「关闭推送」请显式写 `none`。
- **未知名字**：逐项忽略，不报错；`--items` 可临时覆盖（调试用，不写 UCI）。
- 卡片体积仍必须 **< 20480 字节**（飞书 webhook 硬上限）。超限时按固定阶梯逐级裁剪：
  `Top 10→8→5` → 图表步长 `1→2→4→6` 小时 → `Top=0`（去掉两张表，只留文字区块 + 图表/脚注）。
  发生裁剪时脚注追加「已裁剪（体积超限）」，`check` 见到该标记会把「表缺失」判为 WARN 而不是 FAIL。

### 7.2 什么时候发：`report_mode` / `report_time` / `report_weekday`

- `report_mode=daily`：每天 `report_time` 到点发；标题 `流量日报 YYYY-MM-DD`。
- `report_mode=weekly`：只在 `report_weekday`（1=周一 … 7=周日）那天 `report_time` 发；
  标题 `流量周报 YYYY-MM-DD`。
- `report_mode=both`：每天 `report_time` 都发；**遇到 `report_weekday` 那天算周报**（标题不同，仍只发一条）。
- `report_time` 缺省取旧字段 `daily_time`，再缺省 `08:30`；支持 `8:30`/`0830` 写法，非法值回退 `08:30` 且不报错。
- `--window N`（分钟，默认 0）：`report_time` 之后 N 分钟内仍算「到点」，用于路由器休眠/重启错过整分；
  配合 `BASE/report-last.json` 的 `{kind: {day, ts}}` 去重，窗口内**不会重复发**。
- 判定使用**本地时间**（`date +%z`），`--at "YYYY-MM-DD HH:MM"` / `--epoch N` 可注入「现在」用于测试。
- `daily` 子命令**不做**时间判定（手动强制）；老 cron 里写 `daily` 的部署行为不变。

### 7.3 什么情况下发：告警

保留原有：`alert_enabled`（总开关）、`alert_new_device`（新设备，首次运行只建基线）、
`device_daily_limit`（单设备日流量，如 `40G`/`512M`/纯数字=GB）、`alert_cooldown`（同规则同目标冷却秒数，默认 1800）。

新增（**留空 = 关闭**，老配置因此完全无感）：

| 配置 | 触发条件 | 冷却键 |
|---|---|---|
| `alert_app_daily_limit` | `apps[]` 里单个 `host` 的 `rx+tx ≥ 阈值` | `applimit:<host>` |
| `alert_spike_ratio` | 当前小时（`history.json` 桶求和）≥ 近 7 日均值/24 × N | `spike:hour` |
| `alert_offline_min` | 告警状态里记录的最后在线时间距今 > N 分钟（且 ≤7 天） | `offline:<设备键>` |
| `alert_cpu_pct` / `alert_mem_pct` / `alert_disk_pct` | `state.system` 对应百分比 ≥ 阈值 | `sys:cpu` / `sys:mem` / `sys:disk` |
| `alert_quiet_hours` | 命中时段内**跳过全部告警**（报表不受影响），支持 `23:00-07:00` 跨零点与逗号分隔多段 | — |

规则：

- 系统类告警（CPU/内存/磁盘）与 `system` 区块都依赖 `state.system`（§3.3）；**字段缺失时静默跳过，不报错**。
  字段名兼容 `cpu_pct|cpu`、`mem_pct|mem_percent`、`disk_pct|disk`、`load1|loadavg`、`temp_c|temp`，
  以及 `mem_total+mem_avail`（换算成 used）、`wan_rx_rate/wan_tx_rate`。
- 突增基线来自 `/etc/prism-router/daily/*.json`（`--daily-dir` 可覆盖，取最近 7 天、不含今天）；
  基线 < 1 MB/小时或当前小时还没有桶时**不判定**（避免小样本噪声/开机误报）。
- 「持续超过 N%」用**冷却窗口**近似：值超阈值即发，之后同规则在 `alert_cooldown` 内不再重复。
- 每条告警仍然走原有冷却去重（`/tmp/prism-router/alert-state.json` 的 `cooldown`），
  可重试错误入队重试（1→5→15 分钟，最多 3 次）。

### 7.4 兼容与自检

- **向后兼容**：只配 `webhook`/`secret`/`enabled` 的老配置行为不变（默认 `report_items`、默认
  `daily` 模式、告警阈值全空）；所有新配置项读不到或为空时只走默认值，**不报错、不崩**。
- `check [FILE] [--items LIST]`：按 `report_items`（或 `--items`）校验对应区块是否存在、
  表格列名/行数、图表三条序列、脚注 `plain_text`、无 `note`/`action`、体积 < 20480。
- `selftest`：签名官方向量、本地时间换算、`report_items` 解析、调度判定（daily/weekly/both/window）、
  免打扰、冷却、卡片结构（默认/单区块/全开/无 `system`/体积裁剪）、阈值解析、JSON 压缩器，全部离线。
- `--items`、`--at/--epoch`、`--window`、`--mode/--time/--weekday/--kind`、
  `--app-limit/--spike-ratio/--offline-min/--cpu/--mem/--disk/--quiet`、`--daily-dir` 都是调试/验证用参数，
  **不写 UCI**。
- 容器门禁：`tests/container-validate-feishu.sh`（隔离容器，`--network none`）覆盖
  `report_items` 组合、调度判定、各告警阈值触发/不触发、免打扰、体积/标签、既有 `feishu-test.sh` 回归。

## 8. 验收（冒烟）

1. 服务启动后 `state.json` 每 5s 更新，`devices` 非空且包含主路由下已知设备。
2. 下载 100MB 后，该设备的 `proxy_rx + direct_rx` 增量与真值偏差 < 5%。
3. 代理与直连互斥：同一字节不得同时出现在两边。
4. 断网/关 clash 时降级不崩，`health.reasons` 说明原因。
5. LuCI 四个页面能打开、无 JS 报错、图表有数据。
6. 飞书测试发送返回 `code==0`。
7. 连续运行 1 小时，内存无增长、state.json 原子写不产生半截文件。
8. 接入方式：配好 `ap_macs`（或 `wireless_ports`）后，无线客户端 `link=="wifi"`、有线 `"wired"`、
   FDB 未命中 `"unknown"`，且 `wifi+wired+unknown == direct+proxy`；`brctl` 不可用时
   `health.link_source=="none"` 且 `reasons` 有原因，direct/proxy 数值不受影响。
9. 系统指标：`state.json` 出现 `system` 段且序列化后 < 800 字节；用固定伪造的 `/proc`
   两次采样时 `cpu_pct`/`mem_pct`/load 与构造值一致；`temp` 缺失时字段省略；
   `df` 在 60 秒内只执行一次；`/proc` 读不到时 `system` 为空对象、`direct/proxy` 与
   关闭 `system_enabled` 时**逐字节一致**且 `reasons` 不增加。
10. 设备元数据/配额/导出（§10）：`set_device_meta` 往返一致、`devices.json` 0644 root:root 且无 `.tmp` 残留；
    `get_state` 每设备有 `month_rx/month_tx/month_total`、顶层 `totals.month_total`，上月文件不计入；
    `export_csv` 三种 what 都能出 CSV（带 BOM、逗号/引号转义正确）；Prometheus CGI 未配置/错 token 一律 403，
    正确 token 返回合法 Prometheus 文本；`tests/container-validate-features.sh` 全绿。

---

## 9. 数据 / 日志保留与清理（retention）

模块：`/usr/share/prism-router/retention.uc`（ucode，只用 `fs`/`uci` 内建，不需要 curl/openssl）。
**cron 由用户自己加**，脚本不改 crontab；`retention.enabled=0` 或整段删掉即回到旧行为。

### 9.1 清理范围（白名单硬编码）

| 目录（硬编码） | 匹配 | 年龄依据 | 配置项 |
|---|---|---|---|
| `/etc/prism-router/daily/` | `*.json`（一天一个） | **文件名日期** | `daily_days` |
| `/etc/prism-router/nodes/` | `*.json` / `*.jsonl` | 文件名日期，没有就 mtime | `nodes_days` |
| `/etc/prism-router/stations/` | `*.json` | 同上 | `stations_days` |
| `/tmp/prism-router/` | `*.log` | mtime | `log_days` |
| `/tmp/prism-router/` | `*.log` | 大小 | `log_max_kb`（超限截断） |
| `/tmp/prism-router/feishu-queue/` | 目录内全部普通文件 | 总量 | `spool_max_kb`（从最旧删） |

配置段**只有阈值，没有任何路径项**，所以清理范围不可能被配置改到系统目录。
只处理上表目录的**直接子文件**，不递归。

### 9.2 配置（UCI `prism-router`，section `retention`）

```
config retention 'retention'
    option enabled '1'
    option daily_days '400'
    option nodes_days '30'
    option stations_days '7'
    option log_days '7'
    option log_max_kb '512'
    option spool_max_kb '2048'
    option dry_run '0'
```

| 选项 | 默认 | 取值范围 | 语义 |
|---|---|---|---|
| `enabled` | `1` | 0/1 | `0` = 本次运行什么都不删、不截断（等于回到旧行为） |
| `daily_days` | `400` | 0–36500 | `/etc/prism-router/daily/*.json` 保留天数 |
| `nodes_days` | `30` | 0–36500 | `/etc/prism-router/nodes/*` 保留天数 |
| `stations_days` | `7` | 0–36500 | `/etc/prism-router/stations/*` 保留天数 |
| `log_days` | `7` | 0–36500 | `/tmp/prism-router/*.log` 按 mtime 的保留天数 |
| `log_max_kb` | `512` | 0–16777216 | 单个日志超过就截断，只留尾部一半（KB） |
| `spool_max_kb` | `2048` | 0–16777216 | `feishu-queue` 目录总量上限（KB） |
| `dry_run` | `0` | 0/1 | `1` = 只打印将要删除/截断的清单，不动任何文件 |

规则：

- **`0` 一律表示关闭该项**（`days=0` 关闭该目录的按天清理，`*_kb=0` 关闭截断/上限）。
  这是安全阀：配置写错成 `0` 不会把数据删空。
- 选项缺失（老配置根本没有 `retention` 段）、非整数、越界 → 用默认值并记一条 WARN，
  **绝不猜测一个会删数据的值**。
- 整段缺失等价于默认值（`enabled=1` + 上面 7 个默认阈值）；但只有加了 cron 才会真正执行。

### 9.3 按天删除的判定

- **文件名日期优先**：`^YYYY-MM-DD[.后缀]$`（如 `2026-11-15.json`、`2026-11-15.jsonl`）。
  四位年 + 两位月 + 两位日，并用公历往返校验（`2026-02-30` 这类非法日期不算），
  所以 `node-a.json`、`q-1794700000-1-0.json` 不会被误认成日期。
  日期按**本地时区**解释（与 `daily/` 文件名口径一致）。
- **否则按 mtime**：`年龄 = int((now - mtime) / 86400)`；mtime 在未来按 0 天前算（保留）。
- **年龄 > 保留天数才删**：恰好等于保留天数的不删。所以 `daily_days=400` 实际保留 401 个日历日的文件。
- 删除时记一行清单：`retention: 删除 <路径>（<N> 天前）`。

### 9.4 日志截断

- 只处理 `/tmp/prism-router/*.log`，`size > log_max_kb*1024`（严格大于）才截断。
- 保留**尾部** `size/2` 字节；若起点切在半行上，丢掉这半行（最多丢一行），保证新文件从整行开始。
- 「同目录临时文件 + `rename`」原子替换，保持原文件权限（通常 0644），不会出现半截日志。
- 脚本自己的 `/tmp/prism-router/retention.log` 也在范围内，会被自己一起截断，不会无限增长。

### 9.5 飞书重试队列上限

- 总量 = 目录下所有**普通文件** `st_size` 之和（不算目录开销）。
- 超过 `spool_max_kb` → 按 **mtime 从最旧**开始删，边删边算，直到不超上限。
- `*.processing`（`feishu.uc` 正在投递的条目）**跳过不删**；删完仍超限只记 WARN
  （剩下的都是处理中的条目，等 `feishu.uc` 自己收尾/回收）。

### 9.6 安全约束（硬性）

- 只删上表白名单目录里的**普通文件**；目录本身、子目录、符号链接、设备文件一律跳过。
- 删除前 `realpath` 复核：真实路径必须**正好等于** `<root>/<name>`，且仍在白名单根之下。
- 白名单根**不能是符号链接**：`realpath(root)` 必须等于 `realpath(parent) + 相对路径`；
  目录不存在则静默跳过（还没产生数据），不是普通目录则 WARN 后跳过。
- 不跟随符号链接：符号链接条目本身不删、其目标也不会被删。
- 调试用的目录覆盖（`--daily-dir` 等）必须落在 `/etc/prism-router/` 或 `/tmp/prism-router/` 之下，
  路径里不允许 `.` / `..` 段，字符限于 `[A-Za-z0-9._/-]`；被拒绝时只 WARN 并跳过该目录，
  **绝不回退到默认目录**（否则等于绕过白名单）。
- 不使用 `rm -rf`、不 fork 删除命令：只用 `fs.unlink` / `fs.rename`。
- 依赖自检：`ucode-mod-fs` 缺少 `fs.realpath`/`fs.lstat`/`fs.lsdir` 时**拒绝执行**
  （fail closed，只 WARN + 全 0 摘要），绝不退化成「不做校验就删」。

### 9.7 输出契约（机器可读）

- 每个动作一行，全部以 `retention: ` 开头；dry-run 时动词前多一个「将」：
  - `retention: 删除 <路径>（<N> 天前）` / `retention: 将删除 …`
  - `retention: 截断 <路径>（<旧> KB → <新> KB，保留尾部）` / `retention: 将截断 …`
  - `retention: 删除 <队列条目>（队列 <总量> KB > <上限> KB）`
- WARN 也走 **stdout**（前缀 `retention: WARN `），这样 `2>&1` 下顺序确定；
  同时写 `/tmp/prism-router/retention.log` 与 syslog（`logger -t prism-router-retention -p daemon.warn`）。
- dry-run 额外一行计划汇总：
  `retention: dry-run：计划删除 P 个文件、截断 T 个日志，共 B 字节（未改动任何文件）`
- **stdout 最后一行永远是摘要**：

  ```
  retention: files_deleted=N bytes_freed=M logs_truncated=K
  ```

  `files_deleted` = 实际删除的文件数（含飞书队列条目）；`bytes_freed` = 释放字节数
  （删除 + 截断）；`logs_truncated` = 被截断的日志个数。
  **dry-run 下三个值都是 0**（确实没动文件），计划量看上面那行。
- **一律 `exit 0`**：没有东西可删、单个文件失败、甚至未预期异常（外层 try/catch）都是 0，
  cron 不会因此发邮件；失败信号是 WARN 行 + `retention.log` + syslog。
- 单个文件失败（删不掉/截断失败）只记 WARN 并继续下一个。

### 9.8 与守护进程的分工（关键）

`daily/` 的清理只能有**一个**负责人，否则 `daily_days=400` 会被老逻辑悄悄删掉：

- `retention` 段**存在**且 `enabled != 0` → `prism-routerd` **不再执行** `daily_prune`
  （原来按 `settings.history_days` 做「只留 N 个文件」的计数裁剪）；`daily/` 的清理
  完全由 `retention.uc` 按 `daily_days` 的**日期**语义负责。
- `retention` 段**不存在**（老配置升级、conffile 未被覆盖）或 `enabled=0` → 行为与从前
  完全一致（守护进程按 `history_days` 计数裁剪）。
- 结论：升级后想用新策略，必须**手动追加** `retention` 段（或重装配置）并加 cron；
  只装脚本不配段 = 老行为不变。
- 门禁用的测试钩子：`PRISM_ROUTER_PRUNE_NOW=1` 让守护进程启动时立刻跑一次清理判定
  （正常只在跨天时跑），生产环境不要设置。

### 9.9 cron（用户自己加，包不改 crontab）

```sh
# 每天 03:30 清理一次；stdout 是给人的清单，cron 里丢掉即可
30 3 * * * /usr/bin/ucode /usr/share/prism-router/retention.uc >/dev/null 2>&1

# 首次启用建议先看清单（只打印、不动文件），再上正式 cron：
ucode /usr/share/prism-router/retention.uc --dry-run
```

### 9.10 调试参数（不写 UCI）

`--dry-run`、`--epoch N`（注入「现在」，秒）、`--daily-days/--nodes-days/--stations-days/--log-days/--log-max-kb/--spool-max-kb`、
`--daily-dir/--nodes-dir/--stations-dir/--log-dir/--queue-dir`（受 §9.6 约束）、`--selftest`、`--help`。

`--selftest` 是纯函数自检（公历换算、文件名日期解析、白名单/路径判定、KB 显示），
不读写任何数据目录，容器门禁会跑它。

### 9.11 容器门禁

`tests/container-validate-retention.sh`（隔离容器、`--network none`）覆盖：

- 安装后 `/etc /usr /www` 权限不变；`retention.uc` 落位 0644 root:root；config 三个 section 结构完好
- `retention` 段 8 个默认值齐全
- 5 个日期的 daily（含 500 天前）→ 只删 500 天前那个，其余一个不动
- `nodes_days` / `stations_days` 各自生效（同为 10 天前：node 保留、station 删除）
- 文件名日期优先于 mtime（mtime 是新文件但名字是 `2020-01-01.json` → 删）
- 日志 > `log_max_kb` → 截断为约一半、内容确实是尾部、无 `.tmp` 残留、权限不变
- `feishu-queue` 超上限 → 从最旧删到不超，最新保留
- `--dry-run` 与 UCI `dry_run=1`：只打印，前后条目数/大小完全一致
- 越权保护：`/etc/escape.json`、父目录里的 `escape.json`、指向白名单外的符号链接、
  以超期日期命名的**子目录**全部不动；`--daily-dir /etc`、含 `..` 的路径被拒绝且不回落默认目录；
  白名单根本身换成符号链接时整目录跳过
- 摘要行格式正确；空目录 / `enabled=0` 也 `exit 0`
- 安全阀：`daily_days=0` / `log_max_kb=0` 关闭对应动作；非法值回落默认并 WARN
- 守护进程：`retention` 段存在时不裁剪 daily，`enabled=0` 时回到 `history_days` 计数裁剪

### 9.12 已知不足

- `/tmp` 是 tmpfs：日志与队列重启即丢，`log_days` 只对「本次开机期间」有意义；
  真正长期留存的是 `/etc/prism-router/` 下的 daily/nodes/stations。
- 队列按 **mtime** 排序（不是条目里的 `created`/`next_at`）；人工 `touch` 过会改变顺序。
- `*.processing` 不删，卡住的条目要等 `feishu.uc` 的 10 分钟回收逻辑放回队列后才会被清理。
- 目录大小按文件 `st_size` 求和，不含目录项/块对齐开销（与 `du` 有少许差异）。
- 只做「删除 / 截断」，不做压缩归档、不做跨目录配额统计。
- 日期判定跟随本机时区（`/etc/TZ`）；容器里通常是 UTC，与真机本地时区结论可能差一天，
  门禁用相对天数（`date -d @epoch`）构造，不受影响。


---

## 10. 设备别名/分组 · 月配额 · 导出（CSV / Prometheus）· 陌生设备标记

三块能力都**只追加**：`state.json` 一个字段都没变（新字段只在 rpcd 的 `get_state` 返回体里拼上去），
老前端、飞书卡片、`push.uc` 子节点快照完全无感。

### 10.1 设备元数据 `/etc/prism-router/devices.json`

**唯一权威文件**，守护进程与 rpcd 共用：

```json
{ "<mac>": { "alias": "客厅电视", "group": "家人", "first_seen": 1794600000 } }
```

- 键是 **小写冒号 MAC**（`DC-56-...` / `dc-56-...` 由写方归一）；非法 MAC 的条目读取时丢弃。
- 三个值都可缺省：`alias` / `group` 为空时**不写这个键**；`first_seen` 只收正整数。
- 文本清洗：去控制字符（含 `\n` `\t` `\r`）、`trim`、**UTF-8 安全截断到 128 字节**（不切断多字节码点）。
- 权限 **0644 root:root**；写入必须**同目录唯一临时文件 + `rename`**（时间 + 纳秒时钟 + 序号），
  读端永远看不到半截 JSON。文件缺失 / 损坏 / 字段类型错 → 读成空对象 `{}`，不报错、不崩。
- 上限 **512 条**；写方超限时按「有 alias/group 的优先 → `first_seen` 从新到旧」保留；
  读取端最多认 1024 条。
- 两个写者都在共享 mkdir 锁内走「读盘 → 只改自己那几个键 → 原子写回」，互不覆盖：
  * rpcd `set_device_meta` 写 `alias` / `group`；
  * `prism-routerd` 在**新 MAC 首次出现**时写 `first_seen`（绝不碰 alias/group）。

`get_state` 的 `devices[]` 里**有值才带** `alias` / `group` / `first_seen`（没有就整个键不出现）。

**`set_device_meta {mac, alias, group}`** → `{ok, mac, alias, group, devices}`：

- `alias` / `group` **没传 = 不改**，**传空串 = 清除**；两个都清空且没有 `first_seen` → 整条记录删除。
- 非法 MAC → `{ok:false, error:"invalid mac"}`；两个字段都没传 → `{ok:false, error:"nothing to update …"}`。
- 写失败 → `{ok:false, error:"写入 <路径> 失败"}`（权限/只读 overlay）。
- 参数策略必须声明（`args: {mac, alias, group}` 三个字符串）：不声明时 ubus 会以
  `Invalid argument` 拒绝**任何**参数；写 `null` 会让整个插件加载失败（`Skipping registration`）。
  实测 rpcd 只把调用方真正传了的键放进 `request.args`，所以「没传=不改」在 ubus 与调试入口下一致。

### 10.2 月配额

UCI `settings` 段：

| 选项 | 默认 | 取值 | 语义 |
|---|---|---|---|
| `quota_mode` | `none` | `none` / `device` / `total` | `none` 关闭；`device` 每台设备同一配额；`total` 全屋合计 |
| `quota_monthly_gb` | `''` | 数字（可带小数，如 `50` / `0.5`） | 单设备默认月配额（GB）；空 = 不限制 |
| `quota_total_gb` | `''` | 同上 | 全屋月度总配额（GB）；空 = 不限制 |

**计算口径**（rpcd 侧，`get_state` 内）：

- 只读 `/etc/prism-router/daily/YYYY-MM-DD.json`，且**文件名年月 == 当前本地月**（1 号至今）；
- 文件名日期 **> 今天**（时钟错乱产生的未来文件）跳过；
- 每天的 `devices[].rx/tx` 按 MAC 累加（`mac` 为空则用 IP 作键，state 侧同样 MAC 优先、IP 回退）；
- **月度总账始终使用 daily 的 `totals.rx/tx`**（缺失再取 direct+proxy），不能按被 Top N 截断的设备行求和；设备行只用于单设备配额；
- 坏 JSON / 半截文件跳过，不影响其它天；目录不存在 → 全 0；
- 跨天/跨月自动失效（缓存 key 含「年月 + 今天」，复用窗口 20 秒）。

**`get_state` 新增返回字段**：

```json
"totals": { "…": "…", "month_total": 1463 },
"quota": { "mode": "device", "monthly_gb": 10, "total_gb": 0,
           "device_limit": 10737418240, "total_limit": 0, "period": "2026-11" },
"devices": [
  { "…": "…", "month_rx": 900, "month_tx": 90, "month_total": 990,
    "quota_limit": 10737418240 }
]
```

- `month_rx` / `month_tx` / `month_total` **始终是数字**（没有数据就是 0）。
- `quota.device_limit` / `quota.total_limit` 是**字节**：`int(gb * 1073741824 + 0.5)`（四舍五入），
  上限 1 PiB；空 / 非数字 / 负数 → 0（= 不限制）；`quota_mode` 非法 → 按 `none` 处理。
- `devices[].quota_limit` **只在 `mode=device` 且 `quota_monthly_gb > 0` 时出现**。
- 剩余量/百分比**由前端算**：`remaining = limit - used`，`pct = used / limit * 100`；
  分母 0（未配置）时前端显示 `—`，不要做除法。

### 10.3 导出

#### 10.3.1 CSV —— rpcd `export_csv {what}`

参数 `what` ∈ `devices` | `apps` | `daily`（缺省 `devices`；非法 → `{ok:false, error}`）。
返回 `{ok, what, filename, rows, csv}`，文件名 `prism-router-<what>-YYYY-MM-DD.csv`。
前端只需把 `csv` 字符串存成 `.csv` 文件（已带 BOM，不要再自己加）。

CSV 规则（门禁逐条验）：

- **首 3 字节 UTF-8 BOM**（`EF BB BF`），行尾 **CRLF** —— Excel 双击打开中文不乱码、不串行；
- 字段含 `,` `"` 换行 → 整体加引号、内部 `"` 翻倍（RFC 4180）；
- 文本字段以 `= + - @ \t \r` 开头 → 前面加一个 `'`（**防 Excel 公式注入**，主机名/别名是不可信输入）；
- 数值字段不加引号；单位一律**字节**；
- 最多 200 行：devices/apps 按流量降序取前 200；daily 取最近 200 天（仍按日期升序）；
- 源文件缺失/损坏 → 只有表头（`rows:0`），`ok:true`，不报错。

列（顺序固定）：

| `what` | 列 |
|---|---|
| `devices` | 主机名,IP,MAC,别名,分组,接入,直连下载,直连上传,代理下载,代理上传,合计,本月下载,本月上传,本月合计,首次出现 |
| `apps` | 应用,出口链路,下载,上传,合计,设备数 |
| `daily` | 日期,下载,上传,合计,设备数 |

`接入` 只会是 `wifi` / `wired` / `unknown` / 空；`首次出现` 是本地时间 `YYYY-MM-DD HH:MM:SS`（没有就空）。

#### 10.3.2 Prometheus —— CGI `/cgi-bin/prism-router-metrics`

安装为 `/www/cgi-bin/prism-router-metrics`（ucode，**只读**：只读 state.json 与 devices.json，
不写文件、不 fork 子进程）。

**认证**：`metrics_enabled=1` **且** `metrics_token` 非空；请求带 `?token=<tok>` 或
`Authorization: Bearer <tok>`（大小写不敏感），比对为常量时间。
未启用 / 未配 token / token 不对 → **一律 403**（不区分原因，不给探测者信息）；`GET`/`HEAD` 以外 → **405**。
响应头：`Content-Type: text/plain; version=0.0.4; charset=utf-8`、`Cache-Control: no-store`。

| 指标 | 类型 | 说明 |
|---|---|---|
| `traffic_info{version="…"}` | gauge | 恒 `1` |
| `traffic_up` | gauge | `1` = state.json 足够新（`now - ts <= max(30, 6×poll_interval)`） |
| `traffic_state_present` | gauge | `1` = state.json 可读且是合法 JSON |
| `traffic_state_ts_seconds` | gauge | state.json 的 `ts`（有才输出） |
| `traffic_state_age_seconds` | gauge | `now - ts`（有才输出） |
| `traffic_devices_online` | gauge | `last_seen` 在 300 秒内的设备数 |
| `traffic_rx_rate_bytes_per_second` / `…tx…` | gauge | `totals.rx_rate/tx_rate` |
| `traffic_proxy_rx_bytes_total` / `…tx` / `traffic_direct_rx_bytes_total` / `…tx` | counter | 进程启动以来累计 |
| `traffic_device_rx_bytes{mac,hostname,alias,group}` / `…tx…` | gauge | 每设备 `direct+proxy` 字节（进程启动以来），最多 200 台 |
| `traffic_system_cpu_pct` / `cpu_cores` / `load1` / `load5` / `load15` / `mem_total_bytes` / `mem_avail_bytes` / `mem_pct` / `swap_total_bytes` / `swap_free_bytes` / `temp_celsius` / `disk_total_bytes` / `disk_used_bytes` / `disk_pct` / `uptime_seconds` / `wan_rx_bytes_per_second` / `wan_tx_bytes_per_second` | gauge | 对应 `state.json` 的 `system` 段，**字段存在才输出**（缺数据不写 0） |

- 数值全是**定点整数或 1 位小数**，不会出现科学计数法；
- 标签值按 Prometheus 文本格式转义：`\` → `\\`、`"` → `\"`、换行 → `\n`，其它控制字符 → 空格；
  设备没有别名/分组时标签是**空串**（标签集合固定为 4 个，避免序列漂移）；
- 降级：state.json 缺失/损坏 → 仍然 200，只有 `traffic_info/traffic_up/traffic_state_present`；
  devices.json 坏 → alias/group 标签为空串；
- ⚠ `*_bytes_total` 与 `traffic_device_*_bytes` 都是**守护进程启动以来累计**（重启归零），
  不是持久单调计数器——Prometheus 会看到一次 reset，用 `rate()`/`increase()` 时请注意；
  月配额没有直接暴露为 Prometheus 指标（需要就抓 `get_state` / `export_csv`）。

### 10.4 陌生设备标记 `first_seen`

- 由 `prism-routerd` 在每轮 poll 末尾记录：只针对**有 MAC** 的设备
  （没有 DHCP 租约 → MAC 为空 → 没有 `first_seen`）。
- 已有 `first_seen` **绝不覆盖**；`alias` / `group` 不动；同一进程内不会重复写
  （重复运行后 `devices.json` 字节级不变）。
- 没有新 MAC 时最多 30 秒读一次 `devices.json`（缓存），不会每轮 poll 碰闪存。
- 写失败（`/etc` 只读、磁盘满）只记调试日志，**不影响** `direct_* / proxy_* / link / system` 任何数值。
- `devices.json` 损坏 → 下次自动重建为合法 JSON（旧内容丢失，`first_seen` 重新计时）。
- 前端标记「新设备」：`now - first_seen < N 天`（N 由前端定，后端不判）。

### 10.5 兼容性

- **`state.json` 一个字段都没变**：新字段只在 rpcd 返回体里；老消费方（飞书、push.uc、子节点快照）无感。
- 新增字段「有值才出现」（`alias/group/first_seen/quota_limit`）；`month_*` 与 `quota` 段始终存在，
  老前端忽略未知键即可（月总量为 0 时也只是多个数字）。
- 老配置没有 `quota_*` / `metrics_*` → `quota_mode=none`、`metrics_enabled=0`，与装前行为一致。
- 新方法只增不改：`status/get_state/get_history/get_daily/get_nodes/get_stations` 签名与语义不变。

### 10.6 调试/测试钩子（生产环境不要设置）

| 环境变量 | 作用 |
|---|---|
| `PRISM_ROUTER_DEVICES_FILE` | 覆盖 `devices.json` 路径（daemon / rpcd / metrics CGI 都用） |
| `PRISM_ROUTER_STATE_FILE` | 覆盖 rpcd 与 metrics CGI 读的 state.json 路径 |
| `PRISM_ROUTER_DAILY_DIR` | 覆盖 rpcd 读的 daily 目录（daemon 侧本来就是它的写目录） |

### 10.7 已知不足

- `devices.json` 的 daemon 与 rpcd 写者通过同一目录的原子 mkdir 锁保护「读-改-写」，临时文件名含进程时钟与序号；锁有有限等待和陈旧恢复，避免长期阻塞。
- `first_seen` 依赖守护进程跑过；从没跑过 daemon（`enabled=0`）时前端拿不到 `first_seen`。
- 月用量来自 `daily/`：当天数据最迟滞后一个 `DAILY_WRITE_SECONDS`（300 秒）；
  `daily/` 被 retention 清掉、重装清 `/etc`、或跨年归档，都会让对应月份的「当月」数值变小。
- `daily/` 每台设备只在文件里存最多 200 台（守护进程上限）；本机设备数超过
  `MONTH_DEVICE_MAX`（1024 个 MAC/IP 键）时聚合会截断。
- 别名/分组只按 **MAC** 记：手机开随机 MAC 后是新设备，需要重新命名。
- CSV 的公式注入防护会在文本前多一个 `'`（安全换可读性）；Excel 里看起来是多一个字符。
- Prometheus 指标是**进程生命周期累计**（重启 reset），不是持久计数器；也没有做多抓取端缓存/限流，
  每次抓取读两个小文件（`state.json` ~10KB、`devices.json` ~几 KB）。
- `metrics_token` 明文存放于 `/etc/config/prism-router`；走 URL 查询串时会进 web 服务器访问日志；
  通道无 TLS、不防重放 —— **仅限内网**，不要把 web 端口暴露到 WAN。
- 月口径跟随本机时区（`/etc/TZ`），与 `daily/` 文件名口径一致；改时区后同一天可能重复/漏算一次。

### 10.8 容器门禁

`tests/container-validate-features.sh`（隔离容器、`--network none`，**156 项**）覆盖：

- 安装后 `/etc /usr /www /www/cgi-bin` 权限不变；`prism-router-metrics` 0644/0755 落位；
  三份 ucode（daemon / rpcd / CGI）语法检查；5 个新配置项与默认值
- `set_device_meta` 往返：大写+短横线 MAC 归一、0644 root:root、无 `.tmp` 残留、
  alias 空串清除、全空删除记录、非法 MAC / 空更新拒绝、`\n \t` 清洗、128 字节截断
- 月配额：当月 1 号至今累加、上月文件不计、未来日期不计、坏 JSON 跳过、无 devices 行用 totals 兜底、
  daily 目录缺失；`none/device/total`、小数 GB、非法/负数/空值回落；设备 `quota_limit` 只在 device 模式出现
- `first_seen`：守护进程记录新 MAC、已有 `first_seen`/alias/group 不被覆盖、重复运行幂等、
  坏文件重建、0644、无 `.tmp`
- `export_csv` devices/apps/daily：BOM、CRLF、表头、逗号/引号转义、公式注入前缀、行数、文件名、
  非法 `what`、缺省 `what`、坏文件跳过
- Prometheus CGI：未启用/未配 token/未带/错 token → 403；`?token=` 与 `Bearer`（含小写）→ 200；
  POST → 405；逐行校验文本格式（HELP/TYPE/样本/标签转义/无重复序列/无科学计数法/定点小数）；
  state.json 缺失或损坏 → 200 + `state_present=0`；devices.json 坏 → 标签空串
- 向后兼容：12 个原有设备字段、无元数据时不多出键、`state.json` 无新字段、5 个旧方法仍返回合法 JSON、
  `get_state` < 180 KiB
- ACL（read 含 `export_csv`、write 含 `set_device_meta`）、`set_config` 放行 5 个新选项、未知字段仍拒绝
- 真实 ubus → rpcd：插件注册成功（无 `Skipping registration`）、`get_state`/`set_device_meta`/`export_csv`
  端到端；缺省参数不改、空串清除

---

## 11. 独立面板服务（`prism-router-panel`，脱离 LuCI）

一个**独立的只读 HTTP 服务**：procd 启动一个专门的 uhttpd 实例，浏览器直接访问
`http://<路由器LAN地址>:8099/` 就能看面板，不需要 LuCI 会话，也不经过 LuCI 的 uhttpd 实例。

### 11.1 安装内容

```
/etc/init.d/prism-router-panel            0755   procd init（USE_PROCD=1，START=95）
/www/prism-router-panel/index.html        0644   静态页面（由 files/panel/ 安装）
/www/prism-router-panel/app.js            0644
/www/prism-router-panel/style.css         0644
/www/prism-router-panel/cgi-bin/panel-api 0755   只读 ucode CGI（#!/usr/bin/ucode）
```

`prism-router` 的 `DEPENDS` 因此包含 `uhttpd`（系统自带的 web 服务器，不是 LuCI）。
面板数据来自 rpcd 的 `prism-router` ubus 对象，所以 **`luci-app-prism-router` 必须安装**
（该包提供 `/usr/share/rpcd/ucode/prism-router.uc`）；面板本身不读 LuCI 的会话/菜单/ACL。

### 11.2 配置（UCI `prism-router`，section `panel`）

```
config panel 'panel'
    option enabled '0'     # 1 = 启动独立面板服务；0 = 关闭（默认）
    option port '8099'     # 1–65535；非法/空/越界回退 8099
    option bind ''         # IPv4 字面量；留空 = 取 network.lan.ipaddr；都没有 = 监听所有接口
    option token ''        # 空 = 不做应用层认证（只依赖网络边界）
    option write_enabled '0'  # 家长控制总开关（§12）；默认 0，且 token 非空才允许写
```

- **默认关闭**：`enabled=0` 时 `/etc/init.d/prism-router-panel start` 直接 `return 0`，不监听任何端口；
  postinst/prerm 只按 `panel.enabled` 做 `enable`/`disable`，**绝不强制启动**。
- 老配置升级后没有 `panel` 段，`config_get_bool` 取默认 0 —— 行为与未安装前一致。
- 修改 `port`/`bind` 后需要 `/etc/init.d/prism-router-panel restart`（uhttpd 的监听参数在启动时确定）；
  修改 `token` 不需要重启（CGI 每个请求重新读 UCI）。

### 11.3 启动命令（procd）

```
/usr/sbin/uhttpd -f -h /www/prism-router-panel -x /cgi-bin \
    -p <listen> -t 60 -T 60 -A 1
```

- `-f` 前台运行（由 procd 托管），`-p` 在有 bind 时是 `addr:port`，否则只给 `port`（所有接口）；
- `respawn 3600 5 0`（异常退出自动拉起），stdout/stderr 转 syslog；
- `reload_service` = `stop` + `start`；`service_triggers` 注册 `prism-router` 的 reload 触发器。
- `bind` 只接受 IPv4 字面量（四段 0–255）；主机名/IPv6/带端口的写法一律记一条日志后
  回退为监听所有接口 —— 绝不把 UCI 原文拼进 argv。

### 11.4 API：`/cgi-bin/panel-api`（只读）

| 参数 | 取值 | 说明 |
|---|---|---|
| `what` | `state`（默认）\|`history`\|`nodes`\|`stations`\|`status` | 白名单，其它 → **400** `{"error":"bad_request"}` |
| `days` | 1–31（默认 1） | 仅 `history`；非数字回退 1，越界夹到 1–31 |
| `token` | 字符串 | `panel.token` 非空时必须完全相等 |

- `what` → ubus 方法映射：`state→get_state`、`history→get_history`、`nodes→get_nodes`、
  `stations→get_stations`、`status→status`。响应体是 ubus 返回的 JSON 原样透传
  （`state` 含 `totals`，`history` 含 `days[]`）。
- 方法：只允许 `GET`/`HEAD`，其它 → **405** `{"error":"method_not_allowed"}`（`HEAD` 只回头不回体）。
- 认证：`token` 为空 → 不做应用层认证；非空时要求 `?token=`、`X-Panel-Token:` 或
  `Authorization: Bearer <token>` 与配置**逐字节完全相等**（常量时间比较），否则
  → **401** `{"error":"unauthorized"}`（先于参数白名单校验）。
- 任何异常（ubus 不可用、返回非 JSON、超 256 KiB、内部错误）→ **500** `{"error":"internal"}`，
  响应体不含堆栈/路径/命令输出。
- 响应头固定：`Content-Type: application/json; charset=utf-8`、`Content-Length`、
  `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- **只读**：不写任何文件；除 `ubus call prism-router <只读方法>` 之外不执行外部命令。
  CGI 不做任何日志（不记录 token）。

### 11.5 安全边界

- 默认关闭 + 默认绑定 LAN 地址；`bind` 解析失败时宁可监听所有接口也不拼命令（uhttpd argv 由
  procd 以列表形式传递，不经过 shell）。
- 文档根只放静态页面；目录里没有可写路径。token 只在 CGI 内从 UCI 读取，不写日志、不进 argv。
- 这是**仅限局域网**的明文 HTTP 服务：没有 TLS、没有防重放；不要暴露到 WAN，跨网络请用
  WireGuard/Tailscale。
- ⚠ OpenWrt 的 uhttpd 只把 `Accept/Authorization/Host/User-Agent` 转成 CGI 环境变量，
  自定义 `X-*` 头会被静默丢弃（与 §5.1 的实测结论一致）。因此经本服务实际可用的是
  `?token=` 与 `Authorization: Bearer`；`X-Panel-Token` 仍被 CGI 接受，供 nginx+fcgiwrap
  等标准 CGI/反向代理转发场景使用。
- `?token=` 会出现在浏览器历史/书签里；页面取到后立即从地址栏移除并改存 localStorage。

### 11.6 容器门禁

`tests/container-validate-standalone-panel.sh`（第 13 套，隔离容器、`--network none`，**68 项**）：

- 装包后落位/权限（init 755、CGI 755、静态 644）、`sh -n`/`ucode -c`、panel 段默认值；
- **默认关闭**：`enabled=0` 时 start 退出码 0 且 18099 无监听；
- 真实 `ubusd + procd + rpcd` → `/etc/init.d/prism-router-panel start` 拉起独立 uhttpd →
  `?what=state` 200 + `application/json` + 四个安全头 + `Content-Length` + `totals`；
- 白名单/默认 what/`what=bad`→400/写方法名→400；POST→405（经 uhttpd）；
  HEAD→200 且 CGI 层不输出 body；
- token：未设→200；设置后无/错→401、`?token=`→200、`Bearer`→200（经 uhttpd）、
  错误 Bearer→401；`X-Panel-Token` 在 CGI 层验证（uhttpd 不转发 X-*）；
- `history&days=2`→200 且含 `days[]`；`days=99`/`days=abc` 不报错；
- 静态 `/`→200 `text/html`（页面未就绪时用临时占位，不写最终页面）；
- 非法 `port=99999`→回退 8099、非法 bind→监听所有接口、旧端口不再监听；
- `panel.bind` 留空 → 自动取 `network.lan.ipaddr`；
- 停掉 rpcd → 500 `{"error":"internal"}` 且响应不含路径/堆栈；
- init 不读 token、CGI 无写文件/日志调用、临时日志里没有 token、系统目录权限不变。



## 12. 家长控制（按 MAC 暂停/恢复上网）

按单台设备的 MAC 在 nftables 的 **`inet fw4` / `forward` 链**上加一条
`ether saddr <MAC> counter drop`，临时断开该设备的上网；恢复时按 comment 找到
`handle` 再删除。**默认关闭**，写操作必须带 `panel.token`。

### 12.1 安装内容

```
/www/cgi-bin/prism-router-control   0755   ucode CGI：HTTP 写接口 + 本机 root 的 apply 重放
/etc/prism-router/paused.json       0600   暂停列表（{"v":1,"paused":[...]}，原子写）
/etc/prism-router/control.log       0600   审计（最近 200 行）
```

`/etc/init.d/prism-routerd` 在 `procd_close_instance` 之后调用
`/www/cgi-bin/prism-router-control apply`，把上次运行暂停的设备重新加回规则；
失败只写一条 syslog（`logger -t prism-routerd`），不影响守护进程启动。

### 12.2 配置（UCI `prism-router`，section `panel`）

```
config panel 'panel'
    option write_enabled '0'   # 总开关，默认 0（关闭）
    option token ''            # 复用独立面板令牌；**为空则写操作一律 403**
```

- 只有 `write_enabled` **恰好为字符串 `1`** 才认为开启；缺省 / `0` / 其它值都按关闭处理
  （老配置升级后没有该选项 → 行为与未启用前一致）。
- `panel.token` 必须非空；请求里的 token 与之逐字节比较（常量时间，长度不同直接失败）。

### 12.3 HTTP 契约：`POST /cgi-bin/prism-router-control`

| 项 | 规则 |
|---|---|
| 方法 | **仅 POST**；GET / HEAD / PUT … → `405 {"error":"method_not_allowed"}` |
| Content-Type | 若提供则必须是 `application/json…`，否则 `400 {"error":"bad_request"}`（不提供不拦，便于手工调试） |
| body | ≤ **4096 字节**；`Content-Length` 只接受 `^[0-9]+$`；声明超限直接 `400 body_too_large`（不读）；实际超限/声明不符同样 400 |
| body 形态 | 必须是一个 JSON 对象；解析失败/数组/字符串 → `400 {"error":"invalid_json"}`；空 body → `400 {"error":"empty_body"}` |
| 请求体 | `{"token":"...","action":"pause"\|"resume"\|"list","mac":"aa:bb:cc:dd:ee:ff"}` |
| 令牌 | `body.token` 优先；为空时取 `Authorization: Bearer <token>` |

**校验顺序（实现与门禁都按它断言）**：
方法 → body 长度/Content-Type/JSON 解析 → `write_enabled==1` → token → action 白名单 → mac。

- `write_enabled != 1` → `403 {"error":"write_disabled"}`
- token 缺失 / 为空 / 不匹配（含 `panel.token` 本身为空）→ `403 {"error":"forbidden"}`
- `action` 不在 `pause|resume|list` → `400 {"error":"invalid_action"}`
  （**`apply` 不是 HTTP action**，远程调用拿到的就是 400）
- `mac` 归一化（去首尾空白、转大写、`-`→`:`、12 位裸 hex 自动补冒号）后必须匹配
  `^([0-9A-F]{2}:[0-9A-F]{2}){5}$`，否则 `400 {"error":"invalid_mac"}`

### 12.4 保护目标（400 `protected_target`，在调用 nft 之前拒绝）

| 目标 | 判定 |
|---|---|
| 全零 | `00:00:00:00:00:00` |
| 广播 | `FF:FF:FF:FF:FF:FF` |
| 多播 | 首字节 bit0 = 1（`(int(MAC[0..2],16) & 1) == 1`），例如 `33:33:..` / `01:00:5e:..` |
| 本机网桥 | MAC 等于 `/sys/class/net/br-lan/address`（读不到就跳过该条） |

> 测试钩子：容器门禁设 `PRISM_ROUTER_BRLAN_ADDR` 指向 fixture 文件；生产环境不要设置。

### 12.5 行为

| action | 成功响应 | 说明 |
|---|---|---|
| `pause` | `200 {"ok":true,"already":false,"mac":"AA:..."}` | 加规则后写 `paused.json` |
| `pause`（已有 comment 规则） | `200 {"ok":true,"already":true,"mac":"AA:..."}` | **不重复加规则**；补写 `paused.json` |
| `resume` | `200 {"ok":true,"already":false,"mac":"AA:..."}` | 删除所有 comment 匹配的 handle |
| `resume`（无匹配） | `200 {"ok":true,"already":true,"mac":"AA:..."}` | 不改 nft |
| `list` | `200 {"ok":true,"paused":[{"mac":"AA:...","handle":42}, …]}` | **每次从内核现查**，不读 `paused.json`；不写审计 |

失败：`500 {"error":"nft_failed"}` / `500 {"error":"persist_failed"}`。
所有响应固定 `Content-Type: application/json`、`Cache-Control: no-store`、
`X-Content-Type-Options: nosniff`；**绝不返回 nft 的原始输出**。

### 12.6 nft 命令（固定 argv，经 `fs.popen` + 单引号转义，绝不拼原始请求）

```
nft add rule inet fw4 forward ether saddr <MAC> counter drop comment "prism-pause-<MAC>"
nft -a list chain inet fw4 forward
nft delete rule inet fw4 forward handle <N>
```

- MAC 只可能含 `0-9A-F:`，handle 只可能是 `^[0-9]+$`，comment 是固定前缀 + 已校验 MAC。
- 只操作 `inet fw4` 的 `forward` 链；**绝不** `nft flush ruleset`、**绝不**列出/修改别的表
  （第三方 `inet UA3F` 不会被触碰）。
- nft stderr 重定向到 `/dev/null`，退出码非 0 一律映射成 500，不把命令输出带回响应。

### 12.7 持久化：`/etc/prism-router/paused.json`

```json
{ "v": 1, "paused": [ "AA:BB:CC:DD:EE:FF", "02:00:00:00:00:01" ] }
```

- 0600 root:root；`/etc/prism-router` 已存在时必须是真实目录且 root:root（`lstat` 不跟随符号链接），否则写失败。
- 原子写：同目录临时文件（`open(..., "wx", 0600)`，目标已存在即失败）+ `chmod` + `rename`。
- 每次成功的 pause/resume 后重写；`list` 不碰它。
- 读取时丢弃非法/保护目标 MAC（脏文件不会卡住重放）。

### 12.8 apply 模式（仅本机 root，无 HTTP）

```
/www/cgi-bin/prism-router-control apply
```

- 只有 **没有 `REQUEST_METHOD`** 且 `argv[0] == "apply"` 才进入；任何 CGI 请求都带
  `REQUEST_METHOD`，因此远程无法触发。
- 要求 `euid == 0`（读 `/proc/self/status` 的 `Uid:` 首字段），否则退出码 1。
- 不需要 token，**不受 `write_enabled` 影响**：这是恢复既有的管理决定，不是新的写操作；
  要真正放开某台设备仍需带 token 的 `resume`。
- 读 `paused.json`，逐条做归一化 + 保护目标校验后 `nft add rule`；已经在 forward 链里的跳过。
- 幂等；单条失败不影响其余条目；有失败时退出码 1（无失败 0）。审计里 action 记为 `apply`。

### 12.9 审计：`/etc/prism-router/control.log`

```
YYYY-MM-DD HH:MM:SS action mac result
```

- `action ∈ {pause, resume, apply}`；`result ∈ {ok, already, failed}`。
- 0600 root:root；每次写入后只保留最近 **200 行**（读尾部 64 KiB → 追加 → 截断 → 原子写）。
- **绝不写 token**，也不写请求体原文。
- 只读的 `list` 不写审计。

### 12.10 安全边界与剩余风险

- 默认关闭；写接口必须 POST + JSON + 4 KiB 上限 + 常量时间 token 比较。
- `panel.token` 与独立面板共用：改一处两边都变，部署时注意。
- 明文局域网 HTTP：token 可能被窃听/重放；跨不可信网络请用 TLS / WireGuard / Tailscale。
- 依赖 `inet fw4` 的 `forward` 链存在（未装 firewall4 / 链被改名 → 写操作 500 `nft_failed`）。
- 容器门禁用**假 nft** 断言"我们发出了什么 argv"，不证明内核行为；fw4 规则顺序、
  counter、nft 对 `comment` 的打印格式等需要真机验收。

### 12.11 容器门禁

`tests/container-validate-control.sh`（第 15 套，隔离容器、`--network none`，**123 项**）：

- 装包后 CGI 755 root:root、`ucode -c`、init `sh -n`、config 默认 `write_enabled '0'`；
- 默认关闭 → 403 `write_disabled`；老配置（缺该选项）同样 403；GET/HEAD/PUT → 405；
- token 为空 / 缺失 / 错误 → 403 `forbidden`；`body.token` 与 `Bearer` 两条路径都能 pause；
- pause → nft 收到固定 `add rule … ether saddr <MAC> … drop comment "prism-pause-<MAC>"`；
  重复 pause → `already=true` 且不再加规则；
- resume 从 `-a list chain` 输出解析 handle 并 `delete rule … handle N`；无规则 → `already=true`；
- list 从内核现查、返回 `{mac,handle}`、不写审计；
- 保护目标（br-lan / 全零 / 广播 / 多播）→ 400 且 **0 次 nft 调用**；
- 非法 MAC / action / `apply` / JSON / 超大 body / 无 body / 错 Content-Type / 错 Content-Length → 400；
- nft 失败 → 500 `nft_failed`，响应不回显 nft 输出；
- `paused.json` 0600 且内容正确；apply 重放、幂等、保护目标跳过、`write_enabled=0` 仍重放；
- 审计 0600、格式正确、不含 token、205 次操作后截断为 200 行；
- 所有 nft 调用只落在 `inet fw4 forward`，断言没有 `flush` / `ruleset` / `UA3F`；
- 卸载后 CGI 与 init 移除、系统目录权限不变。

---

## 单包插件形态

- 唯一包 `luci-app-prism-router` 同时安装守护进程、rpcd 插件、ACL、菜单、LuCI 页面、
  CGI 与独立面板；不再拆分为 daemon 包 + LuCI 包。
- 菜单含完整页面：overview / devices / apps / nodes / settings / mobile / diagnostics / panel。
- ACL 两组：只读组 + 管理组（`luci-app-prism-router-admin`，含 UCI 与写方法）。
- 独立面板（`prism-router-panel`，默认关闭）：同一插件自带的可选视图，端口 8099，
  API 只读白名单 + token；与 LuCI 共用同一份 `/etc/config/prism-router`。
