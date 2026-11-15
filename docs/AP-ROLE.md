# AP（192.168.100.3）在流量统计中的角色

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
2. **会重复计数**：若 AP 也跑 `traffic-statsd`，同一份流量会在两个节点各记一次；
   子母汇总时总量翻倍（与代理腿重复计数是不同原因，但现象相同）。
3. **已验证主路由覆盖无线客户端**：同一个 MAC（如 `22:77:08:69:a9:1f` = OnePlus-8-Pro）
   同时出现在 AP 的 `iw station dump` 和主路由的 DHCP 租约 / 状态文件里。

## 三、AP 的合理用法

**方案 A（推荐，当前）**：AP 不安装插件，不参与统计。
主路由单点覆盖全部有线 + 无线设备。

**方案 B（可选增强，未实现）**：AP 只上报「无线站点元数据」，不上报字节：

```
POST /cgi-bin/traffic-stats-stations
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

- 用**文件级部署**（scp 到 `/usr/share/traffic-stats/`），不打包
- 或先在带包源的构建环境里 `apk mkpkg` 生成 `.apk`（apk-tools 3.x 支持），再离线安装
- 无论哪种，都必须先在容器里验证文件属主/权限（参考 `docs/DEPLOY-RULES.md`）

## 五、当前决策

目标里写的"在 AP 上部署"**按方案 A 暂缓**：部署上去只会制造重复计数。
若需要无线信号维度，再按方案 B 实现。
