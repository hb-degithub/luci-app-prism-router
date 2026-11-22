# AP（192.168.100.3）在棱镜路由中的角色

> 结论先说：**AP 不应该跑流量计费/统计的采集端**，否则会与主路由重复计数。
> 它唯一有价值的贡献是「无线侧元数据」（信号强度、协商速率、BSS）。

## 一、实测事实（2026-11-15 只读勘察）

| 项目 | 结果 |
|---|---|
| 系统 | ImmortalWrt SNAPSHOT，kernel 6.18.35，aarch64（airoha/an7581） |
| 包管理 | **apk-tools 3.0.5**，无 opkg；`/etc/apk/repositories` 为空（无包源） |
| ucode | 有，且模块齐全（fs/uloop/uci/ubus/math/rtnl/nl80211/digest/log） |
| 其它 | curl ✓、openssl ✗、jq ✗、crond ✓ |
| 存储 | overlay 331 MB，剩余 301 MB |
| 角色 | **哑桥**：`dhcp.lan.ignore=1`、`network.wan.proto=none`、3 个 BSS |

## 二、为什么不应在 AP 上做字节统计

1. **网络路径**：AP 是纯二层桥，所有客户端流量经桥接转发到主路由，由主路由做 NAT。
   主路由的 conntrack 已经统计了这些流量。
2. **会重复计数**：若 AP 也跑 `prism-routerd`，同一份流量会在两个节点各记一次；
   子母汇总时总量翻倍（与代理腿重复计数是不同原因，但现象相同）。
3. **已验证主路由覆盖无线客户端**：同一个 MAC（如 `22:77:08:69:a9:1f` = OnePlus-8-Pro）
   同时出现在 AP 的 `iw station dump` 和主路由的 DHCP 租约 / 状态文件里。

## 三、AP 的合理用法

**方案 A（推荐，当前）**：AP 不安装插件，不参与统计。
主路由单点覆盖全部有线 + 无线设备。

**方案 B（可选增强，未实现）**：AP 只上报「无线站点元数据」，不上报字节：

```
POST /cgi-bin/prism-router-stations
{
  "node_id": "ap-1",
  "ts": 1794700000,
  "stations": [
    {"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-33,
     "rx_rate":866000,"tx_rate":650000,"connected_sec":3600}
  ]
}
```
主路由把这些字段合并进设备详情页（信号/速率），字节仍只来自主路由自己的采集。
这样不产生任何重复计数，且能回答"这个设备信号好不好"。

数据来源：`iw dev <iface> station dump`，字段 `signal`、`rx bitrate`、`tx bitrate`、`connected time`。
代价：AP 侧一个每分钟跑一次的 ucode 脚本 + 主路由一个接收端点。

## 四、部署方式（若将来做方案 B）

AP 无 apk 源，无法 `apk add`；有 ucode/curl，所以：

- 用**文件级部署**（scp 到 `/usr/share/prism-router/`），不打包
- 或先在带包源的构建环境里 `apk mkpkg` 生成 `.apk`（apk-tools 3.x 支持），再离线安装
- 无论哪种，都必须先在容器里验证文件属主/权限（参考 `docs/DEPLOY-RULES.md`）

## 五、当前决策

目标里写的"在 AP 上部署"**按方案 A 暂缓**：部署上去只会制造重复计数。
若需要无线信号维度，再按方案 B 实现。

---

## 六、实际部署记录（2026-11-15）

按方案 B（只报无线元数据、**不报任何字节**）部署完毕。

| 位置 | 改动 |
|---|---|
| AP `192.168.100.3` | `/usr/share/prism-router/stations.uc`（root:root 644）、`/etc/config/prism-router`（600）、crontab 一行每分钟 |
| 母节点 `192.168.100.1` | `stations_enabled=1` + `stations_token`，接收端与界面此前已随包部署 |

验证结果：
```
AP 上报：站点=3 请求体=418 字节  exit=0
母节点：/etc/prism-router/stations/ap-1.json (root:root 644)
get_stations：node ap-1「客厅 AP」，3 个站点（signal -48/-40 dBm、rx/tx 速率、连接时长）
设备页：信号列已显示（-xx dBm），接入列 无线/有线 与棱镜路由无关地独立呈现
AP 权限：/etc /usr /www /usr/share/prism-router 全部 root:root 755 未变
WiFi：3 个 BSS 正常
```

**干扰数据如何避免**：AP 侧只采集 `iw station dump` 的 6 个字段（mac/iface/signal/rx_rate/tx_rate/connected_sec），
母节点再按白名单过滤一次；即使 AP 端被改坏、塞入 `rx_bytes`，也不会落盘（门禁 93 项含此用例）。
因此主路由的字节统计仍是唯一权威来源，不会出现双计。

---

## 七、AP 绑定 + 上报 + 控制（1.0.32 起）

方案 B 的「哑桥元数据」通道（token + nonce，不签名）继续保留；从 1.0.32 起多了一条
**可绑定、可控制**的签名通道，供 `ap-agent.sh` 使用：

```
主路由（生成一次性命令）                       AP（每分钟一轮）
  ap_bind_start ── 32 hex token（10 分钟，只存 sha256）
        │
        ├─ url  : https://192.168.100.1/cgi-bin/prism-router-ingest
        └─ cmd  : curl -fsSLk -o /usr/share/prism-router/ap-agent.sh … && ap-agent.sh --url … --token … --install
                                                    │
                                                 ap_report ── 首次自动绑定并消费 token（HMAC 校验）
                                                    │
                                                 ap_poll  ── 取 refresh|reboot（队列 0600，最多 8 条）
                                                    │
                                                 ap_result ── 结果写回 registry.last_cmd_result
```

- 协议、签名原文、落盘路径与错误码见 `docs/SPEC.md` §5.2。
- `ap-agent.sh` 是 POSIX sh，**纯 shell HMAC-SHA256**（busybox `printf '%b'` + `sha256sum`），
  不需要 openssl；token 不进 argv/环境/日志。单实例锁 + 256 KB 日志轮转 + 同类失败 5 分钟节流。
- 网络页顶部新增「AP 管理」：列表（名称/在线/最后上报/终端数/平均信号，离线标红）、
  生成绑定命令（弹窗含 url+token+cmd，可复制，10 分钟有效）、重命名、删除、重启 AP（二次确认）。
- 设置页新增 `settings.ap_offline_min`（默认 10 分钟，`ap_list` 原样返回给页面显示阈值）。

### 7.1 部署与迁移（真机步骤）

```sh
# 母节点（192.168.100.1）安装 1.0.32 包后，在网络页「AP 管理 → 生成绑定命令」复制命令；
# 或命令行（root）：
ubus call prism-router ap_bind_start '{"name":"客厅 AP","node_id":"ap-1"}'

# 在 AP 上执行返回的 cmd；--install 会写 /etc/prism-router-ap/agent.conf(0600)
# 并装一条 crontab：* * * * * /usr/share/prism-router/ap-agent.sh >/dev/null 2>&1
# 如果 AP 上还跑着旧的 stations.uc cron，装完本 agent 后把那一行删掉（同一个 node_id 会写同一份快照）。
```

### 7.2 2026-11-23 真机验证（iStoreOS 24.10.7，模拟 AP）

```
ap_bind_start → token 32 hex；url=https://192.168.100.1/cgi-bin/prism-router-ingest；insecure=true（自签）
ap-agent.sh --once（假 iw，node-id=ap-1）→ "绑定成功（node_id=ap-1），已上报 3 个站点" exit 0
/etc/prism-router/ap-bind/  空（令牌已消费，目录 0700）
/etc/prism-router/ap-registry.json  0600，只有 sha256(token)
/etc/prism-router/stations/ap-1.json  0644，3 站（-41/-48/-57 dBm，rx/tx 速率，连接时长），无 bytes
ap_list → count=1 online=true stations=3 avg_signal=-48 controllable=true
ap_cmd refresh → 队列 0600；第二轮 agent：poll → refresh → result
ap_list → last_cmd=refresh, last_cmd_result="ok: refreshed 3 stations"
```

旧 `ap-1` 快照（11-17）被这次首报直接接管；`/etc/config/prism-router` 未被覆盖（opkg 提示
新 conffile 在 `/etc/config/prism-router-opkg`），`ap_offline_min` 缺省时 rpcd 按 10 处理。
