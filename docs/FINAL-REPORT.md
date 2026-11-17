# 收尾报告（2026-11-15）

> 目标：完成 OpenWrt 棱镜路由插件（按设备 + 代理/直连分离 + 界面 + 飞书 + 子母多节点 + 双机部署 + 性能优化）。
> 结论：**核心功能全部完成并在真机验证**。剩余两项需用户输入（飞书凭据、AP 部署授权），
> 其余项已交付并有可复跑的证据。

---

## 一、交付物

| 包 | 内容 |
|---|---|
| `prism-router` | 采集守护进程 `prism-routerd.uc`、飞书 `feishu.uc`、子节点推送 `push.uc`、母节点接收 CGI `prism-router-ingest`、AP 站点脚本 `stations.uc` + 接收 CGI `prism-router-stations`、init/UCI 配置 |
| `luci-app-prism-router` | 5 个页面（概览/设备/应用/节点/设置）、rpcd 后端（8 个方法）、菜单与 ACL |

仓库：16 次提交、54 个文件、约 11.9k 行代码、16 份文档。

## 二、架构

```
主路由（母节点）
  prism-routerd.uc ── 每 5s 一轮
    ├─ OpenClash /connections  → 代理链路：真实域名 + 出口节点 + 每连接字节
    ├─ /proc/net/nf_conntrack  → 直连流量（orig dst 落在 fake-ip 段则跳过，绝不双计）
    └─ 自适应轮询：连续 2 轮无流量 → 5s 降为 15s，有流量立即恢复
  ↓ 原子写 /tmp/prism-router/{state,history}.json
  rpcd (ucode) → LuCI 5 页；飞书日报/告警（app 或 webhook 两条路线）
  CGI 接收端 ← 子节点 push.uc（HMAC）/ 哑桥 AP stations.uc（token，仅元数据）
```

## 三、验证证据（全部可复跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 24.10 基础 | `./tests/container-validate.sh` | **28/28** |
| 23.05 兼容 | `./tests/container-validate-2305.sh` | **28/28** |
| 子母多节点 | `./tests/container-validate-nodes.sh` | **75/75** |
| AP 站点通道 | `./tests/container-validate-stations.sh` | **93/93** |
| 真机冒烟 | `./tests/smoke.sh` | **15/15** |
| 界面渲染 | `./tests/ui/run.sh`（无头 Chrome 登录后逐页） | **5/5，0 console 报错** |

关键断言：
- 包安装前后 `/etc /usr /www /www/cgi-bin` **权限与属主不变**（11-14 事故的回归断言）
- `direct_rx=900240` 的合成用例中，fake-ip 流 8000 字节**未计入直连**
- 错 token / 过期时间戳 / `../evil` / 超大 body / GET 全部按预期拒绝
- 带 `rx_bytes` 的 body 落盘后文件里 grep 不到 `bytes`（AP 通道双端强制只存元数据）

## 四、真机状态（192.168.100.1）

```
服务 running, confidence=exact, clash=ok conntrack=ok
设备/应用维度正常；每日汇总 /etc/prism-router/daily/{2026-11-14,2026-11-15}.json
/etc /usr /www /www/cgi-bin /usr/share/prism-router → 全部 root:root 755
网络正常；cron 2 条（08:32 日报、每 10 分钟告警）
```

## 五、关键决策与已纠正的错误

1. **不复用 nlbwmon**：其记录结构无目的地址，原理上做不了 per-app；保留为交叉校验。
2. **代理/直连双源分离**：以 fake-ip 段为界，clash 侧管被接管流量，conntrack 只管直连。
   实测代理腿会让聚合值约为 WAN 的 2 倍——这正是必须分离的原因。
3. **ipk 格式**：实测 23.05.5 与 24.10 的官方包**都是外层 tar.gz**，不是 ar。已纠正并写进
   `docs/IPK-FORMAT.md`。
4. **哑桥 AP 不做字节统计**：会与主路由双计，只做无线元数据（`docs/AP-ROLE.md`）。
5. **11-14 事故**：手打 ipk 的目录条目带 uid1000/700，被 opkg 套用到 `/etc /usr /www`，
   导致 ubus/DHCP/DNS 全挂。已记录 `docs/INCIDENT-2026-11-14.md`，并加了三道防线：
   构建强制 `--owner=0 --group=0`、容器门禁断言系统目录不变、部署时权限守卫 + 失败即回滚。
6. **性能**：真机单轮 165–211ms（J4125），瓶颈是 ucode 单核解析而非内核/网络/写盘；
   已实现自适应轮询，空闲 CPU 降到约 1/3（`docs/PERFORMANCE.md`）。

## 六、未完成项（需用户输入）

### 1. 飞书端到端（代码完成、未真实发送）
- app 路线（扫码加群）：`app_id` + `app_secret` → `ucode feishu.uc chats` 取 `chat_id` → `test`
- webhook 路线：群机器人 webhook + secret
- 已验证：签名向量与官方一致、卡片 1782–4983 字节（上限 20480）、mock webhook 35/35、
  错误码解析、重试退避、告警冷却

### 2. AP（192.168.100.3）部署授权
- 代码与门禁就绪（93/93），母节点接收端已部署（`stations_enabled=0` 默认关闭）
- 部署为文件级（AP 无 apk 包源）：传 `stations.uc` → 写 UCI → dry-run → 真跑 → 加 cron
- 回滚 = 删文件 + 删 cron 行 + 关开关，无数据迁移

## 七、如何继续

```sh
# 配飞书（二选一）
uci set prism-router.feishu.app_id='cli_xxx'
uci set prism-router.feishu.app_secret='xxx'
uci commit prism-router
ucode /usr/share/prism-router/feishu.uc chats     # 拿 chat_id
uci set prism-router.feishu.chat_id='oc_xxx'; uci commit prism-router
ucode /usr/share/prism-router/feishu.uc test

# 装 AP 站点模式（文件级，见 docs/AP-ROLE.md「部署」一节）
```

任何改动前的验证流程见 `docs/DEPLOY-RULES.md`。
