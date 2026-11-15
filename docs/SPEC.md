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
    option daily_time '08:30'
    option report_chat_enabled '1'
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
| `get_state` | 无 | state.json 原文对象（含 `devices[].link` 与 `health.link_*`，按 180KB 预算裁剪） |
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

## 7. 飞书报表（日报）

卡片 JSON 2.0，`schema:"2.0"`，元素放 `body.elements`。内容：
- 标题：`流量日报 2026-11-14`
- 概览：总流量 / **代理流量（按节点 Top3）/ 直连流量** / 在线设备数
- 图表：近 24h 折线（总/代理/直连三条）
- 表格：Top 10 设备（主机名 / 直连 / 代理 / 合计）
- 脚注：`div + plain_text`（**2.0 不支持 note**）
- 必须解析响应 `code`，非 0 视为失败。

签名：`key = timestamp + "\n" + secret`，HMAC-SHA256 签空串，Base64。

---

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
