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
config feishu 'feishu'
    option enabled '0'
    option webhook ''
    option secret ''
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
    "clash_poll_ms": 35
  }
}
```

- `rx` = 下载方向（到设备），`tx` = 上传方向。**统一按"设备视角"**。
- `apps` 每设备保留 **Top 15**（按 rx 排序），其余合并为 `__other__`。
- `devices` 按 `proxy_rx + direct_rx` 降序，**最多 40 个**；全局 `apps` 最多 40 条。
- **硬限制（实测）**：ubus 单条消息上限 **262144 字节**，超过会报 `Operation not supported`。所以 state.json 必须控制在 ~180KB 以内——40 设备 × 15 应用实测约 8–12KB，安全。

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
| `status` | 无 | `{enabled, running, confidence, sources:{clash,conntrack}, version}` |
| `get_state` | 无 | state.json 原文对象 |
| `get_history` | `{days}` | `{days:[{day, buckets:[...]}]}` |
| `get_daily` | `{day}` | 当日汇总 |
| `test_feishu` | 无 | `{ok, code, msg}` |
| `set_config` | `{section, options}` | `{ok}` |
| `restart` | 无 | `{ok}` |

ACL：`read.ubus.traffic-stats` 给 status/get_state/get_history/get_daily；`write.ubus.traffic-stats` 给 test_feishu/set_config/restart。

---

## 6. 前端页面（LuCI JS）

| 路由 | 文件 | 内容 |
|---|---|---|
| `admin/services/traffic-stats/overview` | `overview.js` | 总览卡片（总流量/代理/直连/实时速率）、**代理 vs 直连环形图**、Top 应用、Top 设备、健康状态条 |
| `.../devices` | `devices.js` | 设备表（主机名/MAC/IP/直连/代理/合计/速率/信号），点开抽屉看该设备应用分布 |
| `.../apps` | `apps.js` | 应用（域名）排行，可按 直连/代理/节点 过滤，可下钻到设备 |
| `.../settings` | `settings.js` | 采集参数、clash secret、飞书 webhook+测试、报表时间 |

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
