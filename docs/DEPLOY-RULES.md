# 部署规则（2026-11-14 事故后制定，强制遵守）

> 背景：见 `docs/INCIDENT-2026-11-14.md`。一次自制 ipk 的权限错误把主路由 `/etc`、`/usr`、`/www`
> 改成 uid 1000 / 700，导致 ubus、DHCP、DNS 全部失效，网络中断。

## 一、部署流程（不可跳步）

```
本地构建 → 容器/虚拟机验证 → 只读复核 → 用户确认 → 真机部署 → 部署后自检
```

1. **容器/虚拟机验证**（新增强制门禁）
   - 用 OpenWrt rootfs 容器（或 QEMU 镜像）安装产出的包。
   - 断言：文件落位、属主 root:root、权限正确、**系统目录（/etc /usr /www）权限未被改动**。
   - 跑守护进程的离线用例（mock clash API + 合成 conntrack）。
   - 任何一条不过，禁止进入下一步。

2. **只读复核**
   - `tar -tzv` 检查包内每个条目的 owner/mode，**目录条目必须是 root:root 755**。
   - 列出将要写入真机的完整路径清单。

3. **用户确认**
   - 系统级改动（装包、改 init/cron/rpcd、动服务）必须先列清单等确认。
   - 只读检查不需要确认。

4. **真机部署 + 部署后自检**
   - 部署后立刻检查 `/etc /usr /www` 权限、`ubus list`、DNS、网关连通。
   - 异常立即回滚，不自行"修复"核心组件。

## 二、打包硬性要求

- `tar` 必须带 `--owner=0 --group=0 --numeric-owner`。
- 打包前把 staging 目录统一 `chmod 755`、文件 `chmod 644`（可执行文件再单独 `chmod 755`）。
- **禁止**让包内的 `./etc/`、`./usr/`、`./www/` 等父目录条目带上非 root 属主或 700 权限。
- 产物必须经过 `tar -tzv` 人工目视确认后才能安装。

## 三、核心组件异常时的处置

ubus / netifd / dnsmasq / firewall 出现异常时：

1. **停手**，不做任何"修复"动作。
2. 取证：进程状态、`/proc/net/unix`、日志、相关目录权限、`/etc` 与 `/usr` 的 owner/mode。
3. 报告用户，等待指示。

**禁止**：kill 核心守护进程、重启网络、改防火墙、改目录权限。

## 四、自动审批被拒时

- 先判断：这一步是不是完成目标的关键卡点？
- 不是卡点 → 等用户一起解决，不换法子绕过。
- 是卡点 → 换更小、更可逆的做法重试一次，仍被拒则停下说明。

## 五、验证环境说明

- 宿主机没有 gcc / 交叉工具链，构建靠 docker（Alpine 静态编译）。
- OpenWrt 验证用 rootfs 容器；容器内无法复现真实 conntrack/PPE 行为，这类验证仍需真机只读观察。
- 真机只读观察 ≠ 部署，不受本流程第 3 步限制，但仍不得写任何系统路径。

## 六、界面验证（无头浏览器）

`tests/ui/run.sh` 用 puppeteer 容器真实登录 LuCI，逐页检查渲染与 console 报错。
最近一次结果（2026-11-15）：登录 OK，overview/devices/apps/nodes/settings **全部 OK，0 报错**。

```sh
LUCI_PASS='<root 密码>' ./tests/ui/run.sh
```

注意：容器内 puppeteer 位于 `/home/pptruser/node_modules`；挂载目录必须是 755，
否则容器内用户看不到脚本（表现为 `Cannot find module '/w/test.js'`）。
