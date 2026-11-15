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
/usr/bin/traffic-statsd            # ucode 常驻守护进程（procd 托管）
/etc/init.d/traffic-statsd
/etc/config/traffic-stats          # UCI 配置
/tmp/traffic-stats/state.json      # 守护进程每 5s 原子写入（rename）
/tmp/traffic-stats/history.json    # 当日 5 分钟桶
/etc/traffic-stats/daily/          # 每日汇总（JSON，一天一个文件，很小）
/usr/share/rpcd/ucode/traffic-stats.uc   # rpcd 后端，读 state/history 返回 JSON
/usr/share/rpcd/acl.d/luci-app-traffic-stats.json
/usr/share/luci/menu.d/luci-app-traffic-stats.json
/htdocs/luci-static/resources/view/traffic-stats/*.js
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
- `apps` 每设备保留 **Top 15**（按 rx 排序），其余合并为 `__other__`。
- `devices` 按 `proxy_rx + direct_rx` 降序，**最多 40 个**；全局 `apps` 最多 40 条。
- **硬限制（实测）**：ubus 单条消息上限 **262144 字节**，超过会报 `Operation not supported`。所以 state.json 必须控制在 ~180KB 以内——40 设备 × 15 应用实测约 8–12KB，安全。


### 3.1 语义补充（实现中发现的歧义，以此为准）

- **`totals` = 进程启动以来累计**（进程重启归零），与 `uptime` 配套；"今日/历史"口径看 `history.json` 与 `/etc/traffic-stats/daily/`。UI 必须在卡片上标明这一点，不能把 `totals` 当"今日"展示。
- **顶层 `uptime` ≠ `system.uptime`**：顶层是**守护进程**运行秒数（`time() - started`），
  `system.uptime` 是**系统**运行秒数（`/proc/uptime`）。两者不得混用，前端标签也要写清。
- **`accounting_confidence` 枚举固定为** `exact | degraded | unavailable`，不得新增其它值。
- **`__other__` 桶固定为** `{ rx, tx, chain: "MIXED" }`；前端按 `chain` 过滤时必须把 `MIXED` 当作"混合"而不是节点名。
- **历史精度现实**：`history.json` 在 tmpfs，重启即丢 → "近 7 天折线"实际是「当天 5 分钟精度 + 往日日粒度」，前端要么两段拼接，要么只画当日。SPEC 不承诺跨天 5 分钟数据。
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
  `push.uc` 的子节点快照（`/etc/traffic-stats/nodes/*.json`）不含这些字段，多节点页面也不展示，
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

对象名 `traffic-stats`，方法：

| 方法 | 参数 | 返回 |
|---|---|---|
| `status` | 无 | `{enabled, running, confidence, sources:{clash,conntrack}, link_source, link_bridge, link_ports, link_ports_from, version}` |
| `get_state` | 无 | state.json 原文对象（含 `devices[].link`、`health.link_*`、`system` 段，按 180KB 预算裁剪） |
| `get_history` | `{days}` | `{days:[{day, buckets:[...]}]}` |
| `get_daily` | `{day}` | 当日汇总 |
| `test_feishu` | 无 | `{ok, code, msg}` |
| `set_config` | `{section, options}` | `{ok}`；`settings` 白名单含 `lan_bridge/wireless_ports/ap_macs/link_refresh` |
| `restart` | 无 | `{ok}` |

ACL：`read.ubus.traffic-stats` 给 status/get_state/get_history/get_daily；`write.ubus.traffic-stats` 给 test_feishu/set_config/restart。

---

## 6. 前端页面（LuCI JS）

| 路由 | 文件 | 内容 |
|---|---|---|
| `admin/services/traffic-stats/overview` | `overview.js` | 总览卡片（总流量/代理/直连/实时速率）、**代理 vs 直连环形图**、**接入方式（无线/有线/未知）两张卡 + 三段环形图**、Top 应用、Top 设备、健康状态条 |
| `.../devices` | `devices.js` | 设备表（主机名/MAC/IP/**接入**/直连/代理/合计/速率/信号），点开抽屉看该设备应用分布 |
| `.../apps` | `apps.js` | 应用（域名）排行，可按 直连/代理/节点 过滤，可下钻到设备 |
| `.../settings` | `settings.js` | 采集参数、clash secret、**接入方式（lan_bridge / wireless_ports / ap_macs / link_refresh）**、飞书 webhook+测试、报表时间 |

接入方式的 UI 约定：概览页的无线/有线和代理/直连**分开呈现、不相加**；设备页「接入」列无数据时显示 `-`；
未配置无线上联端口时页面要明说"当前一律归为有线"，FDB 读不到时提示原因。

图表：24.10 用自带 `luci-lib-chartjs`（`L.resource('nlbw.chart.min.js')` 然后全局 `Chart`）。

---

## 7. 飞书推送（日报 / 周报 / 告警）：内容、时间、条件均可配

模块：`/usr/share/traffic-stats/feishu.uc`（ucode + curl + openssl，无 python/jq）。
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
30 8 * * *    ucode /usr/share/traffic-stats/feishu.uc scheduled          # daily 模式
30 8 * * 1    ucode /usr/share/traffic-stats/feishu.uc scheduled          # weekly 模式
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
- 突增基线来自 `/etc/traffic-stats/daily/*.json`（`--daily-dir` 可覆盖，取最近 7 天、不含今天）；
  基线 < 1 MB/小时或当前小时还没有桶时**不判定**（避免小样本噪声/开机误报）。
- 「持续超过 N%」用**冷却窗口**近似：值超阈值即发，之后同规则在 `alert_cooldown` 内不再重复。
- 每条告警仍然走原有冷却去重（`/tmp/traffic-stats/alert-state.json` 的 `cooldown`），
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
