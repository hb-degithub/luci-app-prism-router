# OpenWrt 24.10 / 23.05 下「procd 守护进程 + LuCI 界面」插件工程规范调研

> 调研对象：为 `luci-app-traffic-stats`（后台采集守护进程 + UCI 配置 + LuCI Web 图表界面 + root 特权操作 + opkg/apk 安装 + 自定义 feed）确定标准工程结构与实现规范。
>
> 调研时间：2026-11-14。**本文只做调研，不含业务实现。**
>
> 方法：以三条**分支固定**的源码为第一证据（`openwrt/luci@openwrt-24.10` / `openwrt-24.10` / `openwrt-24.10` 的 `packages` feed），辅以 OpenWrt 官方 wiki。所有"确认"均可用文末链接复核。

## 证据等级约定（请按此理解正文标注）

| 标记 | 含义 |
|---|---|
| **【源码确认】** | 在 24.10 分支源码中逐行核对过，链接可点开同一行 |
| **【文档确认】** | OpenWrt 官方 wiki / 仓库内文档明确写出 |
| **【推断】** | 由上述两类证据推理得出，未直接写明 |
| **未查证** | 没有找到可靠来源，本文不给结论（不编造） |

> ⚠️ 重要前提：本次调研**没有在真实设备上执行任何命令**（环境无 OpenWrt 设备/SDK 构建）。因此下文不存在"24.10 实测"结论；所有"24.10"标注均为**源码/文档确认**。凡需要上机验证的点，统一列在第 8 节"待实测清单"。

---

## 0. 结论速览

| # | 问题 | 结论（24.10） | 23.05 差异 |
|---|---|---|---|
| 1 | 前端形态 | **LuCI JS（客户端渲染）为唯一可选新路径**；Lua/CBI 仍能跑但官方已声明不再接受新的 Lua 客户端模块 | 23.05 同样已是 JS 为主（103 个 app 中 72 个是 JS 视图、33 个仍带 `luasrc`）；24.10 进一步收敛到 12 个 Lua app |
| 2 | 后端接入 | 首选 `/usr/libexec/rpcd/<obj>` 可执行脚本（`list`/`call` 协议），或 `/usr/share/rpcd/ucode/*.uc`（rpcd 内嵌 ucode VM）；重负载才写 C ubus 对象 | 23.05 已支持 ucode 插件（`rpcd-mod-ucode` 存在），协议完全一致 |
| 3 | 服务托管 | `USE_PROCD=1` + `procd_open_instance` / `respawn` / `limits` / `stdout 1` / `stderr 1`，日志自动进 logd；状态用 `ubus call service list` | procd 参数集与 24.10 相同（含 `user`/`group`/`seccomp`/`capabilities`） |
| 4 | 配置 | `/etc/config/<pkg>` + `conffiles` 保留；`/etc/uci-defaults` 只在**首次启动/升级后**跑一次，退出 0 即删除；格式迁移**没有内建机制**，要自己用版本号标记 + 幂等 `uci -q get` 守卫 | 同 |
| 5 | 打包 | **24.10 默认仍是 opkg**，apk 是标了 `(BROKEN)` 且 `depends on BROKEN` 的编译期选项；**23.05 根本没有 apk 包**；apk 成为默认是从 **25.12** 开始 | 23.05 无 apk；Makefile 写法两者一致 |
| 6 | 二进制 vs 脚本 | 采集/高频路径用 C（`$(TARGET_CC)` 或 cmake.mk）；控制面/管理逻辑用 ucode 最划算（解释器约 64 KB）；Go 仅在生态强绑定时用，体积代价明显 | 同 |
| 7 | 骨架 | 双包结构：`traffic-statsd`（架构相关）+ `luci-app-traffic-stats`（`LUCI_PKGARCH:=all`） | 同 |

**一句话架构建议**：守护进程用 C（或复用现成采集器）跑 root 采集，状态/查询走 **rpcd ucode 插件或 `/usr/libexec/rpcd` 脚本**，LuCI JS 只经 `rpc.declare()` 调 ubus、经 ACL 白名单拿数据，图表用 `luci-lib-chartjs`（24.10 自带，23.05 需自带 JS）。

---

## 1. LuCI 前端形态：24.10 是 JS，Lua 是兼容态

### 1.1 结论与证据

24.10 的 LuCI 是**客户端渲染的 JavaScript 框架**，后端由 ucode 实现的 dispatcher 提供服务端路由，Lua 只保留兼容层。

- 仓库内文档明确写：`LuCI Modules Reference` "can be JS based or Lua (**deprecated**)""；`How to make LuCI Lua Modules` 一节注明 "**No new Lua modules for client side display are accepted**, but some server side things are still done in Lua"。【文档确认】[docs/README.md](https://github.com/openwrt/luci/blob/openwrt-24.10/docs/README.md)
- 分支统计（本次在克隆仓库内实测统计）：【源码确认】

| 指标 | `openwrt-23.05` | `openwrt-24.10` |
|---|---|---|
| `applications/*/` 总数 | 103 | 102 |
| 带 `htdocs/`（JS 视图） | 72 | **92** |
| 带 `luasrc/`（Lua CBI） | 33 | **12** |
| `modules/luci-compat` | 存在 | 存在 |
| `modules/luci-lua-runtime` | 存在 | 存在 |
| `usr/share/luci/menu.d/*.json` 数量 | 85 | 89 |

- 24.10 的路由/菜单解析已经完全是 ucode：`modules/luci-base/ucode/dispatcher.uc`，视图动作用 `runtime.render('view', …)` 渲染。【源码确认】[dispatcher.uc](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/ucode/dispatcher.uc)
- **默认安装集合不含 Lua 兼容层**：`collections/luci` 只依赖 `+luci-light +luci-app-package-manager`，`collections/luci-light` 依赖 `+luci-app-firewall +luci-mod-admin-full +luci-proto-ppp +luci-theme-bootstrap +rpcd-mod-rrdns +uhttpd +uhttpd-mod-ubus`，两者都**没有** `luci-compat` / `luci-lua-runtime`；而 `modules/luci-compat` 自身 `LUCI_DEPENDS:=+luci-lua-runtime`。【源码确认】[luci-light/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/collections/luci-light/Makefile)、[luci-compat/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-compat/Makefile)

> 实务含义：**不要写 Lua app**。如果写，必须在 `LUCI_DEPENDS` 里显式加 `+luci-compat`，否则在 24.10 默认固件上直接 500/白屏。

### 1.2 两种形态的目录结构对照

| 职责 | LuCI JS（24.10 正道） | 旧 Lua/CBI（兼容态） |
|---|---|---|
| 页面视图 | `htdocs/luci-static/resources/view/<app>/<page>.js` | `luasrc/view/<app>/<page>.htm` |
| 控制器/菜单 | `root/usr/share/luci/menu.d/luci-app-<app>.json` | `luasrc/controller/<app>.lua`（`entry()` 注册） |
| 表单模型 | JS 里 `form.Map()` / `form.TypedSection` | `luasrc/model/cbi/<app>/*.lua`（CBI） |
| 后端 RPC | `root/usr/libexec/rpcd/<obj>` 或 `root/usr/share/rpcd/ucode/*.uc` | 同（后端与前端形态无关） |
| ACL | `root/usr/share/rpcd/acl.d/luci-app-<app>.json` | 同 |
| 静态资源/其它 JS 库 | `htdocs/luci-static/resources/<任意路径>.js`（页面内 `L.resource('x.js')` 加载） | — |
| 安装落点 | `htdocs/*` → `/www/*`；`root/*` → `/` | `luasrc/*` → `/usr/lib/lua/luci/` |

安装落点由 `luci.mk` 统一处理：`HTDOCS = /www`、`LUCI_LIBRARYDIR = /usr/lib/lua/luci`、`UCODE_LIBRARYDIR = /usr/share/ucode/luci`；`Package/*/install` 把 `htdocs`、`root`、`luasrc`、`ucode`、`src` 分别拷到对应位置。【源码确认】[luci.mk#L79-L82](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk#L79-L82)、[luci.mk#L201-L229](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk#L201-L229)

### 1.3 LuCI JS 视图最小骨架

官方 `luci-app-example` 就是官方认定的骨架（`structure.md` 明确"Your starting point for this layout is the `applications` directory"）。下面是**配置页**最小可用形态（改写自官方 `form.js`）：【源码确认】[view/example/form.js](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/htdocs/luci-static/resources/view/example/form.js)

```js
'use strict';
'require view';
'require form';

return view.extend({
	render: function() {
		let m, s, o;

		// 第一个参数 = /etc/config/ 下的配置名，即 /etc/config/traffic_stats
		// 对应 ACL：read.uci / write.uci 里都要有 "traffic_stats"
		m = new form.Map('traffic_stats', _('Traffic Statistics'),
			_('流量统计守护进程配置'));

		s = m.section(form.TypedSection, 'settings', _('采集设置'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'interval', _('采样间隔（秒）'));
		o.datatype = 'uinteger';
		o.placeholder = '60';

		o = s.option(form.ListValue, 'backend', _('采集方式'));
		o.value('nft', 'nftables counter');
		o.value('conntrack', 'conntrack accounting');

		o = s.option(form.DynamicList, 'interfaces', _('监控接口'));
		o.datatype = 'network';

		return m.render();
	}
});
```

要点（都有源码依据）：
- 顶部 `'require xxx'` 字符串是**依赖声明**，供构建期打包与运行期加载，不是注释。【源码确认】同文件与 `docs/README.md`
- 视图文件路径 = 菜单 `action.path` 的路径 + `.js`；`view/traffic-stats/overview.js` ↔ `path: "traffic-stats/overview"`。
- `form.Map` 直接读写 UCI，**ACL 必须同时给 `read.uci` 和 `write.uci`**，否则保存时报 "Access denied"。【文档确认】[structure.md ACL 段](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/structure.md)
- 页面必须准备好"配置为空"的情况：官方注释提醒"如果配置文件完全为空，表单会显示该 section 还没有值，因此**安装时就该铺一份带 section 的默认配置**"。【源码确认】[form.js#L14-L17](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/htdocs/luci-static/resources/view/example/form.js#L14-L17)

### 1.4 菜单注册：推荐 `menu.d` JSON（不是 JS 里 `entry()`）

**结论：24.10 用 `root/usr/share/luci/menu.d/luci-app-<name>.json`。** 整个 24.10 仓库里没有任何一处 JS 使用 `entry()` 注册菜单，且 `luci.js` 中也没有 `entry()` 函数定义（本次在克隆内全文检索 `entry(` 无命中，仅有 `Poll` 的参数名），说明 `entry()` 属 Lua 时代 API。【源码确认】

JSON 的合法字段由 dispatcher 的 schema 校验决定，只有：`action`, `auth`, `cors`, `depends`, `order`, `setgroup`, `setuser`, `title`, `wildcard`, `firstchild_ineligible`。【源码确认】[dispatcher.uc#L346-L357](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/ucode/dispatcher.uc#L346-L357)

`action.type` 的全部取值：`template` / `view` / `call` / `function` / `cbi` / `form` / `alias` / `rewrite` / `firstchild` / `none`。【源码确认】[dispatcher.uc run_action()](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/ucode/dispatcher.uc)

骨架：

```json
{
  "admin/status/traffic-stats": {
    "title": "流量统计",
    "order": 95,
    "action": { "type": "firstchild" },
    "depends": { "acl": [ "luci-app-traffic-stats" ] }
  },

  "admin/status/traffic-stats/overview": {
    "title": "总览",
    "order": 1,
    "action": { "type": "view", "path": "traffic-stats/overview" }
  },

  "admin/status/traffic-stats/config": {
    "title": "设置",
    "order": 2,
    "action": { "type": "view", "path": "traffic-stats/config" }
  }
}
```

`depends` 支持三类前置条件（不满足则**菜单不显示**）：`acl`（本 session 的 ACL 组）、`uci`（配置存在/选项匹配）、`fs`（文件存在/可执行）。真实用法见 `luci-app-vnstat2`：`depends.fs` 用 `/usr/bin/vnstat: "executable"` 判断后端是否装了；`luci-app-nlbwmon` 用 `depends.uci: { "nlbwmon": true }`。【源码确认】[vnstat2 menu.d](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-vnstat2/root/usr/share/luci/menu.d/luci-app-vnstat2.json)、[nlbwmon menu.d](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-nlbwmon/root/usr/share/luci/menu.d/luci-app-nlbwmon.json)；判定函数 `check_depends()`【源码确认】[dispatcher.uc#L277-L310](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/ucode/dispatcher.uc#L277-L310)

### 1.5 前端如何调后端（rpcd/ubus）

三种调用面，全部走 ubus，都要 ACL：

1. **自定义 ubus 对象**（本项目的推荐主线）
   ```js
   'require rpc';
   const callTotals = rpc.declare({
       object: 'traffic-stats',      // 对象名 = /usr/libexec/rpcd/traffic-stats 或 ucode 插件注册名
       method: 'get_totals',
       params: [ 'iface', 'period' ],
       expect: { '': {} }
   });
   // 在 load() 里 return Promise.all([ callTotals('wan','day') ]);
   ```
   【源码确认】[view/example/rpc.js](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/htdocs/luci-static/resources/view/example/rpc.js)

2. **服务状态**：`service` 对象 `list`
   ```js
   const callServiceList = rpc.declare({ object:'service', method:'list', params:['name'], expect:{ '':{} } });
   // data[0]['traffic-statsd']['instances']['instance1']['running']
   ```
   ⚠️ `service` 的 `list` **不在 luci-base 默认 ACL 里**，必须在自己的 `acl.d` 里给 `read.ubus.service: ["list"]`。证据：`luci-base.json` 只把 `file`/`uci` 给了普通用户，而各带状态页的 app 都单独声明了 `"service": ["list"]`。【源码确认】[luci-base.json](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/root/usr/share/rpcd/acl.d/luci-base.json)、[vnstat2 acl.d](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-vnstat2/root/usr/share/rpcd/acl.d/luci-app-vnstat2.json)、读取写法 [vnstat2/graphs.js#L14-L19](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-vnstat2/htdocs/luci-static/resources/view/vnstat2/graphs.js#L14-L19)

3. **直接执行受控命令**：`fs.exec_direct()`，ACL 用"命令行前缀"白名单
   ```js
   'require fs';
   fs.exec_direct('/usr/sbin/traffic-statsctl', [ 'dump', '--json' ], 'json')
   ```
   对应 ACL（注意 key 是**含参数的命令行前缀**，`*` 通配）：
   ```json
   "file": { "/usr/sbin/traffic-statsctl dump --json": [ "exec" ] }
   ```
   【源码确认】[vnstat2 acl.d](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-vnstat2/root/usr/share/rpcd/acl.d/luci-app-vnstat2.json) 与 [graphs.js](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-vnstat2/htdocs/luci-static/resources/view/vnstat2/graphs.js)；`fs.exec` / `fs.exec_direct` 在 23.05 与 24.10 的 `fs.js` 中**行号完全一致**（268 / 405），API 无变化【源码确认】

### 1.6 图表方案（4 选 1，按推荐度）

| 方案 | 做法 | 适用 | 代价 |
|---|---|---|---|
| **A. `luci-lib-chartjs`（推荐）** | `LUCI_DEPENDS:=+luci-lib-chartjs`，页面里 `L.resource('nlbw.chart.min.js')` 注入后 `new Chart(...)` | 时间序列/环形图，交互 tooltip | 24.10 自带；**23.05 无此包**（本次核对 `luci-23.05/libs/luci-lib-chartjs` 不存在），需自查版本或自带 JS |
| B. 后端出图（PNG） | 后端二进制输出 PNG，前端 `fs.exec_direct(...,'blob')` 换成 `URL.createObjectURL()` | 已有绘图工具（vnstati/rrdtool） | 无交互；要比 A 多一个依赖 |
| C. 纯 SVG/Canvas 手绘 | 前端自己画 | 极简折线 | 代码多 |
| D. rrdtool `graph` | ACL 形如 `"/usr/bin/rrdtool graph - -a PNG -s *": ["exec"]`，后端生成图 | 长期 RRD 存储 | 依赖 rrdtool，体积大 |

A 的实证：`luci-app-nlbwmon` 用 `luci-lib-chartjs`（`LUCI_DEPENDS` 含 `+luci-lib-chartjs`，页面 `L.resource('nlbw.chart.min.js')` 后使用全局 `Chart`）；B 的实证：`luci-app-vnstat2` 用 `fs.exec_direct('/usr/bin/vnstati', [...], 'blob')` + `URL.createObjectURL`；D 的实证：`luci-app-statistics` 的 ACL 里就是 `rrdtool graph` 的 exec 白名单。【源码确认】[nlbwmon Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-nlbwmon/Makefile)、[nlbwmon/display.js#L820-L830](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-nlbwmon/htdocs/luci-static/resources/view/nlbw/display.js#L820-L830)、[statistics acl.d](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-statistics/root/usr/share/rpcd/acl.d/luci-app-statistics.json)

> ⚠️ 23.05 兼容提示：如果要在 23.05 上跑同一份前端，别直接依赖 `luci-lib-chartjs`；把 chart.js 作为静态资源自己装进 `htdocs/luci-static/resources/`（体积约 100 KB 级）。

### 1.7 23.05 差异小结（LuCI 部分）

- 菜单/ACL/视图的**文件形态与 API 一致**（23.05 的 dispatcher 也已是 `ucode/dispatcher.uc`，`menu.d` schema 相同）【源码确认】
- `luci-lib-chartjs` **23.05 不存在**（差异项，需自行处理）
- 23.05 里 LuCI 的"官方默认"更宽松地容忍 Lua app（33 个），但**新的官方文档口径两者相同：不再接受新 Lua 客户端模块**
- `luci.mk` 的 postinst 行为不同：23.05 是 `killall -HUP rpcd`，24.10 改为 `/etc/init.d/rpcd reload`【源码确认，见 5.4】

---

## 2. rpcd 权限模型与三种后端形态

### 2.1 ACL 文件：`/usr/share/rpcd/acl.d/*.json`

一个 JSON 文件可含多个"角色"（顶层 key = 角色名，通常与包同名）。每个角色有 `description` 和 `read` / `write` 两个权限块，块内按资源类型分组：`ubus`、`uci`、`file`、`cgi-io`。最小真实例子（官方 example app）：【源码确认】[acl.d/luci-app-example.json](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/root/usr/share/rpcd/acl.d/luci-app-example.json)

```json
{
  "luci-app-example": {
    "description": "Grant UCI and RPC access to LuCI app example",
    "read":  { "ubus": { "luci.example": [ "get_sample1", "get_sample2" ] },
               "uci":  [ "example" ] },
    "write": { "uci":  [ "example" ] }
  }
}
```

语义要点：
- `ubus.<对象名>: [方法名…]` 是**方法级**白名单，不是对象级；未列出的方法前端调用会被框架拦下（官方 example 的 `rpc.js` 里故意留了一个"没给 ACL 所以必被拒"的 `get_sample3`）。【源码确认】
- `uci: [ "配置名" ]` 是**配置级**，粒度到 `/etc/config/<name>`，不能细到 section/option。
- `file` 支持 `read`/`write`/`list`/`exec`，key 是**路径或带参数的命令行前缀（可含 `*`）**；`exec` 只允许匹配前缀的命令，避免了给一个通用 shell。**精确机制（已核 rpcd 源码）**：`rpc_file_exec_run()` 先用**可执行文件绝对路径**做一次 `exec` 权限检查；若被拒，再把 `可执行文件 + 空格 + 每个参数` 拼成一个字符串（最多 255 个参数，超长直接拒绝）做第二次检查。所以 `"/usr/bin/vnstat --json f 1"`、`"/usr/bin/rrdtool graph - -a PNG -s *"` 这类写法是"命令 + 参数"整串匹配，能精确到子命令。【源码确认】[rpcd/file.c#L1034-L1095](https://github.com/openwrt/rpcd/blob/master/file.c#L1034-L1095)
- `cgi-io: [ "exec" ]` / `[ "read" ]`：经由 `cgi-io` 通道执行受控命令/下载文件（`luci-app-statistics`、`luci-app-nlbwmon` 都在用）。
- 角色名同时是**菜单可见性**与**前端权限**的开关：`menu.d` 的 `depends.acl` 引用它；`L.hasViewPermission()` 也看它。

> 注意：`luci-compat` 可能以"legacy UCI 全放行"的 ACL 存在，官方文档警告**不能**因为它在就省掉自己的 ACL；测试时可以把 `acl.d/luci-compat` 移开再重启 rpcd 验证自己的 ACL 是否完备。【文档确认】[structure.md ACL 段](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/structure.md)

### 2.2 自定义后端怎么注册（三种形态）

#### 形态 A：`/usr/libexec/rpcd/<object>` 可执行脚本（最简单，官方 example 用的就是它）

协议（官方 wiki 明确写清）：rpcd 启动时对目录下每个可执行文件调用 `argv[1] = "list"`，脚本输出 `{"方法名": {"参数": 类型示例}}`；调用时以 `argv[1]="call"`、`argv[2]=方法名` 执行，**参数 JSON 从 stdin 整块送入**，stdout 内容原样作为返回。【文档确认】[rpcd TechRef](https://openwrt.org/docs/techref/rpcd)

```sh
#!/bin/sh
# /usr/libexec/rpcd/traffic-stats   —— 对象名即文件名
. /lib/functions.sh

case "$1" in
list)
	cat <<'EOF'
{ "get_totals": { "iface": "wan", "period": "day" },
  "reset": {} }
EOF
	;;
call)
	read -r input            # ubus 调用参数（JSON）从 stdin 来，不是命令行参数
	case "$2" in
	get_totals)
		# …查库/调用守护进程…
		printf '{"rx":0,"tx":0}\n'
		;;
	reset)
		/etc/init.d/traffic-statsd restart >/dev/null 2>&1
		printf '{}\n'
		;;
	esac
	;;
esac
```

调试方式（官方 wiki 与 example 都给了同样套路）：`echo '{"iface":"wan"}' | /usr/libexec/rpcd/traffic-stats call get_totals`、`ubus -v list traffic-stats`、`ubus call traffic-stats get_totals '{"iface":"wan"}'`。参数类型由**示例值的类型**推断（字符串→String，true/false→Boolean，整数按大小→INT8/16/32/64）。【文档确认】[rpcd TechRef](https://openwrt.org/docs/techref/rpcd)

Lua 版同一协议见官方 `luci.example`（`methods` 表 + `list`/`call`/`help` 三个分支）。【源码确认】[luci.example](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/root/usr/libexec/rpcd/luci.example)

#### 形态 B：`/usr/share/rpcd/ucode/*.uc`（rpcd 内嵌 ucode VM，性能最好、无需起进程）

rpcd 的 ucode 插件目录在源码里硬编码为 `INSTALL_PREFIX "/share/rpcd/ucode"`。【源码确认】[rpcd/ucode.c#L35](https://github.com/openwrt/rpcd/blob/master/ucode.c)

脚本形态不再自己解析 `list`/`call`，而是**返回一个签名对象**，由 rpcd 注册成 ubus 对象：【源码确认】[rpcd examples/ucode/example-plugin.uc](https://github.com/openwrt/rpcd/blob/master/examples/ucode/example-plugin.uc)

```ucode
'use strict';
// /usr/share/rpcd/ucode/traffic-stats.uc
import { cursor } from 'uci';

return {
	'traffic-stats': {                       // ← ubus 对象名
		get_totals: {
			args: { iface: 'wan', period: 'day' },   // 类型由示例值推断
			call: function (request) {
				const uci = cursor();
				const db = uci.get('traffic_stats', 'settings', 'db_path') ?? '/var/lib/traffic-stats';
				return { rx: 0, tx: 0, db: db, got: request.args };
			}
		},
		reset: {
			call: function (request) {
				// 二次校验：只有 root 会话可做破坏性操作
				if (request.info.acl.user != 'root')
					exit(1);                  // 非 0 退出码会映射成 ubus 错误
				return {};
			}
		}
	}
};
```

关键能力（全部在官方 example 的注释里写明）：`call` 返回值自动转 blobmsg；`args` 会作为方法签名发布到 ubus；`request.info` 里有本次调用的 **ubusd ACL 上下文**（可做"仅 root"判定）；长耗时操作要 `ubus.defer(...)` 异步化避免阻塞 rpcd 主循环。【源码确认】同文件

#### 形态 C：独立进程自己 `ubus_add_object()`（C/libubus）

适合"守护进程本身就要对外提供数据"的场景：进程启动时 `ubus_connect()` + `ubus_add_object()`，用 `UBUS_METHOD`/`UBUS_METHOD_MAP` 声明方法、`blobmsg_policy` 校验参数。【源码确认】[ubus examples/server.c](https://github.com/openwrt/ubus/blob/master/examples/server.c)

```c
static const struct ubus_method traffic_methods[] = {
    UBUS_METHOD("get_totals", traffic_get_totals, totals_policy),
};
static struct ubus_object_type traffic_obj_type = UBUS_OBJECT_TYPE("traffic-stats", traffic_methods);
static struct ubus_object traffic_obj = { .name = "traffic-stats", .type = &traffic_obj_type,
                                          .methods = traffic_methods,
                                          .n_methods = ARRAY_SIZE(traffic_methods) };
/* main: ctx = ubus_connect(NULL); ubus_add_object(ctx, &traffic_obj); uloop_run(); */
```

注意：这种方式**仍然**需要 `acl.d` 授权（rpcd 的 session/ACL 是 ubus 之上的策略层），并且要给守护进程一个能连 `/var/run/ubus/ubus.sock` 的运行身份。

### 2.3 三种形态怎么选

| 维度 | A. `/usr/libexec/rpcd` 脚本 | B. rpcd ucode 插件 | C. 进程内 ubus 对象 |
|---|---|---|---|
| 语言 | sh / lua / ucode 均可（`#!/usr/bin/env ucode` 也行） | ucode | C |
| 进程模型 | 每次调用 **fork+exec**（有开销） | rpcd 进程内，**无 fork** | 已在运行的守护进程 |
| 额外依赖 | 无（rpcd 自带 exec.c） | `+rpcd-mod-ucode` | `+libubus +libubox +libblobmsg-json` |
| 适合 | 低频管理动作、状态查询、调用 init.d | 中等频率查询、要读 UCI | 高频/大结果集、进程已常驻 |
| 可维护性 | 最易读、最好调试 | 好（JSON 原生，类型推断） | 差（C + blobmsg 样板代码） |
| 权限面 | 每个方法一个 argv，天然隔离 | 进程内，需 `request.info.acl` 自查 | 取决于 daemon 自身 |

官方 example（前端骨架）用 A；LuCI 仓库里 8 个 app 用 A（如 `luci.pbr`、`luci.squid`）；`luci-app-ddns` 用 B（`root/usr/share/rpcd/ucode/ddns.uc`，344 行，做进程/日志/UCI 综合查询）。【源码确认】

**对本项目的建议**：守护进程负责采集与落库（C，root），**查询与运维动作**用 B（ucode 插件，读 UCI + 读统计库/调用 ubus 取服务状态）；"重启服务/清库"这类动作走 A 或 B 的独立方法并在 ACL 里只开给 `write`。这样既不引入 C 的 ubus 样板，也不给前端任何 shell。

### 2.4 最小权限控制清单（本项目的硬要求）

1. **ubus 方法级拆分读写**：读方法放 `read.ubus`，破坏性方法（`reset`/`restart`）只放 `write.ubus`。【源码确认】`luci-app-pbr` 的 ACL 就是 read 里 6 个查询方法、write 里只有 `setInitAction`。
2. **不要用一个"万能 exec"**：`file.exec` 的 key 写成带子命令前缀的形式（`/usr/sbin/x dump --json`），而不是 `/bin/sh`；机制是"命令+参数"整串匹配（见 2.1，已核源码）。【源码确认】vnstat2 / nlbwmon / statistics 三例
3. **UCI 只开自己的配置名**，不要给 `uci: ["*"]`。
4. **特权操作在代码里再判一次身份**：ucode 插件用 `request.info.acl.user != 'root'` 拒绝；sh 后端可以检查 `$ubus_rpc_session` 或用 `ubus call session get`。官方 example 的 `method_3` 演示了这种"纵深防御"。【源码确认】
5. **守护进程降权**：能降就降（见 3.7），只在必须碰 netlink/nftables 的地方保留 root；写库/读库可交给 `procd_set_param user/group` 的专用用户，或用 `USERID:=` 建系统用户。
6. **不需要 root 的能力别放在 LuCI 会话可达面**：例如"读 /proc/net/dev"这种，走 `file.read` 白名单而不是 exec。

### 2.5 生效与调试

- 改完 `acl.d` / 新增 `/usr/libexec/rpcd/*` 后：`/etc/init.d/rpcd reload`（rpcd 的 `reload_service()` 是 `procd_send_signal rpcd`，即 SIGHUP，只重载插件、不断会话）。【源码确认】[rpcd.init](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/rpcd/files/rpcd.init)
- **装包后自动生效**：`luci.mk` 为所有 LuCI 包注入了默认 `postinst`，会清 `/tmp/luci-indexcache.*`、`/tmp/luci-modulecache/` 并 `reload rpcd`。所以只要走 `luci.mk`，不需要自己写 postinst。【源码确认】[luci.mk#L231-L240](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk#L231-L240)
- 前端报 "Access denied" ≈ ACL 不匹配；菜单不出现 ≈ `depends`（acl/uci/fs）不满足或 indexcache 未清。

### 2.6 23.05 差异（rpcd 部分）

- ucode 插件机制 **23.05 已有**：`openwrt-23.05` 的 rpcd Makefile 里同样有 `BuildPlugin,ucode,+libucode`，`luci-app-ddns` 在 23.05 也已带 `ddns.uc`。【源码确认】[rpcd 23.05 Makefile](https://github.com/openwrt/openwrt/blob/openwrt-23.05/package/system/rpcd/Makefile)
- `/usr/libexec/rpcd` 的 `list`/`call` 协议与 ACL 结构两版一致（官方 TechRef 未标注版本差异）。【文档确认】
- 23.05 的 LuCI 默认集合同样不含 `luci-compat`。

---

## 3. procd 服务规范

### 3.1 标准 init 脚本骨架

以 `nlbwmon`（与本项目形态几乎同构：常驻采集 + UCI 配置 + hotplug + reload trigger）和 `go2rtc`（最小降权实例）为样板。【源码确认】[nlbwmon.init](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/files/nlbwmon.init)、[go2rtc.init](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/go2rtc/files/go2rtc.init)

```sh
#!/bin/sh /etc/rc.common

START=95
STOP=10
USE_PROCD=1
NAME=traffic-statsd
PROG=/usr/sbin/traffic-statsd

start_service() {
	config_load traffic_stats
	config_get_bool enabled settings enabled 1
	[ "$enabled" -eq 1 ] || return 0

	procd_open_instance
	procd_set_param command "$PROG" -d /var/lib/traffic-stats
	procd_set_param respawn 3600 5 5        # 60 分钟内挂 5 次即停
	procd_set_param stdout 1                # 日志进 logd
	procd_set_param stderr 1
	procd_set_param limits core="unlimited"
	procd_set_param file /etc/config/traffic_stats   # 声明配置文件（变化检测参数）
	procd_close_instance
}

service_triggers() {
	procd_add_reload_trigger "traffic_stats"
}

reload_service() {
	procd_send_signal traffic-statsd        # 优雅重载；不支持 SIGHUP 就写 restart
}
```

`USE_PROCD=1` 的语义（官方文档原文）：`/etc/rc.common` 同时支持老式与 procd 式脚本，**设置 `USE_PROCD` 才表示使用新式**。【文档确认】[procd-init-script-example](https://openwrt.org/docs/guide-developer/procd-init-script-example)

### 3.2 procd 参数全集（以 24.10 的 `procd.sh` 注释为准）

| 参数 | 含义 |
|---|---|
| `command` | 命令行数组，一个参数一个 shell word |
| `respawn` | `阈值 超时 重试次数` |
| `env` | 环境变量 |
| `data` | 任意键值，用于**检测配置变化触发 reload** |
| `file` | 配置文件列表，变化检测 |
| `netdev` | 绑定网卡，检测 ifindex 变化 |
| `limits` | rlimit |
| `user` / `group` | **以指定用户/组运行（降权）** |
| `pidfile` | pid 文件 |
| `stdout` / `stderr` | 是否把输出重定向到 syslog（默认 0） |
| `facility` | syslog facility，默认 `daemon` |
| `seccomp` / `capabilities` / `no_new_privs` | 沙箱相关 |

【源码确认】[procd.sh#L15-L31](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/procd/files/procd.sh#L15-L31)、合法参数校验见 [procd.sh#L248-L269](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/procd/files/procd.sh#L248-L269)

### 3.3 respawn 语义

`procd_set_param respawn <threshold> <timeout> <retry>`：进程在 `threshold` 秒内退出视为崩溃，间隔 `timeout` 秒重启，连续 `retry` 次后放弃；超过 `threshold` 才退出则无限重启。官方文档原文与此一致；不给参数时使用 `/etc/config/system` 里 `system.@service[0]` 的 `respawn_threshold`/`respawn_timeout`/`respawn_retry`（默认 3600/5/5）。【文档确认】[procd-init-script-example](https://openwrt.org/docs/guide-developer/procd-init-script-example)；【源码确认】[procd.sh#L496-L504](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/procd/files/procd.sh#L496-L504)

### 3.4 日志接 logd/syslog

- 守护进程**直接写 stdout/stderr**，play `procd_set_param stdout 1` + `stderr 1`，procd 把它们送进 logd，用户 `logread` 可见。官方文档明确"仍需把 stdout/stderr 重定向到 logd 才能在系统日志里看到输出"。【文档确认】[procd-init-script-example](https://openwrt.org/docs/guide-developer/procd-init-script-example)
- 脚本侧要打日志用 `logger -t traffic-statsd "..."`（rpcd 后端同理；官方 example 用 `nixio.syslog`）。【源码确认】[luci.example](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/root/usr/libexec/rpcd/luci.example)
- 若希望日志落到独立文件（统计类常想保留历史），需要自己 `logread` 采集或用 `logd` 的 remote/文件输出，或直接用自有日志文件 + logrotate。**具体推荐方案：未查证**（未找到官方针对"守护进程独立日志文件"的标准做法）。

### 3.5 状态上报（ubus service）

- `ubus call service list '{"name":"traffic-statsd"}'` 返回 `{"traffic-statsd":{"instances":{"instance1":{"running":true,...}}}}`；前端用 `rpc.declare({object:'service',method:'list'})` 读取，并从 `data[0]['<name>']['instances']['instance1']['running']` 判活（vnstat2 的原样写法）。【源码确认】[graphs.js#L100-L103](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-vnstat2/htdocs/luci-static/resources/view/vnstat2/graphs.js#L100-L103)
- 服务在 procd 里的名字默认是 init 脚本文件名（`NAME=` 可覆盖），实例名默认 `instance1`。
- 除 `running` 外还可读到 `pid`、`command` 等；**是否需要 `service` 额外方法（如 `restart`）取决于 ACL 是否给**——本项目建议"重启"走自己的 ubus 方法，而不是给前端 `service` 的写权限。【推断】

### 3.6 优雅重启 / 热重载

- `reload_service() { procd_send_signal <name> [instance] [signal] }` → 给进程发信号（如 SIGHUP 让 daemon 重读配置），不重启进程。
- `procd_add_reload_trigger "traffic_stats"` → 精确机制（源码）：为每个配置名注册一个 `config.change` ubus 事件触发器，事件到达时执行 `/etc/init.d/<脚本名> reload`。也就是说**它依赖 `uci commit` 触发的 `config.change` 事件**，手改文件不会触发。【源码确认】[procd.sh#L454-L464](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/procd/files/procd.sh#L454-L464)
- `procd_add_interface_trigger "interface.*" <iface> /etc/init.d/traffic-statsd reload` → 接口 up/down 时 reload（nlbwmon 用它保证新接口被纳入采集）。【源码确认】[nlbwmon.init#L93-L107](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/files/nlbwmon.init#L93-L107)
- 需要"重开数据库/换文件"这类无法热处理的变更，就让 daemon 收到 SIGHUP 后自行 `execv` 重启自己，或干脆 `restart`。

### 3.7 降权与沙箱（对应"最小权限"需求）

- **`procd_set_param user/group`**：最实用的降权手段（go2rtc 用 `USER=go2rtc GROUP=go2rtc` + `respawn`）。【源码确认】[go2rtc.init](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/go2rtc/files/go2rtc.init)
- **`capabilities` / `seccomp` / `no_new_privs`**：procd 支持，可与 jail 组合。【源码确认】`procd.sh` 合法参数表
- **service jail**：`procd_add_jail` + `procd_add_jail_mount`(`_rw`)，flags 支持 `log`/`ubus`/`procfs`/`sysfs`/`ronly`/`requirejail`/`netns`/`userns`/`cgroupsns` 等。【文档确认】[procd-init-scripts（Service jails 一节）](https://openwrt.org/docs/guide-developer/procd-init-scripts)；【源码确认】[procd.sh#L186-L232](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/procd/files/procd.sh#L186-L232)
- **系统用户**：包级 `USERID:=username:groupname` 会在安装时创建用户，正好配合 `procd_set_param user`。【文档确认】[packages 文档 USERID](https://openwrt.org/docs/guide-developer/packages)

> 实践建议：统计采集通常需要 root（netlink conntrack / nftables counter / 读取所有 socket）。可行的分层：**采集进程保留 root 但只做采集并写库（库文件权限 0600 root）**；对外查询由 ucode rpcd 插件以 rpcd 身份读库（若库是 root-only，就需要 rpcd 插件有权限——rpcd 以 root 运行，因此可行）。**这一点未在真机验证过 rpcd 的读权限边界，列入待实测。**

### 3.8 23.05 差异（procd 部分）

逐行对比 23.05 与 24.10 的 `procd.sh`：`_procd_add_jail()` 与包含 `pidfile|user|group|seccomp|capabilities` 的参数校验行**行号与内容一致**（184/263 vs 186/265），respawn/limits/stdout/stderr 语义一致。【源码确认】[procd.sh@23.05](https://github.com/openwrt/openwrt/blob/openwrt-23.05/package/system/procd/files/procd.sh)

---

## 4. UCI 配置、默认值与格式迁移

### 4.1 `/etc/config/<pkg>` 与 conffiles

- 配置文件必须声明在 `Package/<pkg>/conffiles` 中（一行一个路径，**不要缩进**），否则升级包时会被覆盖。【文档确认】[packages 文档](https://openwrt.org/docs/guide-developer/packages)
- 安装时用 `$(INSTALL_CONF)` 而不是 `$(INSTALL_DATA)`，语义更清晰。【源码确认】nlbwmon Makefile
- **必须预置一份带 section 的默认配置**：LuCI 表单在空文件上会显示"还没有值"（官方 example 注释明说）。【源码确认】

```uci
config settings 'settings'
	option enabled '1'
	option interval '60'
	option backend 'nft'
	list interfaces 'lan'
```

### 4.2 `/etc/uci-defaults` 的确切语义

官方文档原文要点：【文档确认】[UCI defaults](https://openwrt.org/docs/guide-developer/uci-defaults)

1. 脚本放在 `/etc/uci-defaults/`（可按数字前缀排序），**首次启动**时由 boot 服务执行；
2. **退出码 0 → 立刻删除**（所以只跑一次）；**非 0 → 保留，下次启动重跑**；
3. 干净安装与**升级后**都会执行（"at every first boot (i.e. after a clean install or an upgrade)"）；
4. 官方推荐的"不覆盖用户设置"写法：开头做存在性判断 `[ "$(uci -q get system.@system[0].zonename)" = "..." ] && exit 0`；
5. 脚本**不需要可执行位**（由 boot 服务 `sh` 执行）；官方原文是 "Scripts should **not** be executable."。打包时放 `root/etc/uci-defaults/90_traffic_stats` 即可，靠 `luci.mk` 的 `cp -pR root/* → $(1)/` 装进包（**权限沿用源文件模式**）。
   > 勘误说明：`luci.mk` 里虽然定义了 `LUCI_DEFAULTS:=$(notdir $(wildcard ${CURDIR}/root/etc/uci-defaults/*))`，但该变量在 `luci.mk` 中**再未被引用**（仅第 11 行出现一次），别指望它做额外处理。非 LuCI 包则在自己 Makefile 的 `install` 段手动装。

### 4.3 配置格式变更怎么升级（本项目最需要自定规矩的地方）

**事实**：OpenWrt **没有**内建的"配置 schema 版本迁移"机制；`uci-defaults` 只在首次/升级后跑一次，而 **opkg/apk 单独升级包时不会重跑 uci-defaults**（它已被删除）。【推断，基于 4.2 的删除语义】

因此推荐**三层组合**（工程惯例，非官方规范）：

1. **代码层兜底**：读配置时永远给默认值——shell 用 `config_get x settings interval 60`；ucode 用 `uci.get(..., 'interval') ?? '60'`；前端表单用 `o.default`/`o.placeholder`。这样即使旧配置缺字段也能跑。
2. **显式版本戳 + 幂等迁移脚本**：
   ```sh
   # /etc/uci-defaults/90_traffic_stats（首次安装时跑）
   #!/bin/sh
   [ -f /etc/config/traffic_stats ] || exit 0
   uci -q get traffic_stats.settings.interval >/dev/null || \
       uci set traffic_stats.settings.interval='60'
   uci -q get traffic_stats.settings.config_version >/dev/null || \
       uci set traffic_stats.settings.config_version='2'
   uci commit traffic_stats
   exit 0
   ```
3. **包 postinst 里做"跨版本迁移"**：`Package/<pkg>/postinst` 里判断 `config_version`，逐级 upgrade 并 `uci commit`。注意 postinst 在安装环境与目标环境都可能执行，要判 `$IPKG_INSTROOT`（ipk）——官方 `luci.mk` 的默认 postinst 就是这么写的 `[ -n "${IPKG_INSTROOT}" ] || {...}`。【源码确认】[luci.mk#L231-L240](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk#L231-L240)

> ⚠️ 注意 opkg→apk 的差异：`IPKG_INSTROOT` 这类 ipk 时代的变量在 apk 下是否保持，**未查证**。若要在 25.12+ 也支持，postinst 的写法需要单独确认（列入第 8 节）。

### 4.4 脚本里用 UCI 的最佳实践

- **读**：shell 用 `/lib/functions.sh` 的 `config_load` + `config_get`/`config_get_bool`/`config_list_foreach`（nlbwmon 的 `parse_config` 就是标准范式）。【源码确认】[nlbwmon.init](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/files/nlbwmon.init)
- **写**：`uci set/add/delete/rename` 都是**先暂存在 `/tmp/.uci`**，必须 `uci commit <config>` 才落盘；`uci get` 在 commit 前读到的也是暂存值。【文档确认】[UCI TechRef](https://openwrt.org/docs/techref/uci)
- **批量**：`uci -q batch <<EOF ... EOF` 减少进程数、语义原子性更好。【文档确认】[UCI defaults 示例](https://openwrt.org/docs/guide-developer/uci-defaults)
- **不要**直接 `sed` 改 `/etc/config/*`（会绕过 uci 的 lock/暂存语义）。
- ucode 里用 `import { cursor } from 'uci'`，`cursor()` 提供 `get/set/add/delete/commit/foreach/load`；LuCI 前端用 `uci.load()/uci.get()/uci.get_first()`。【源码确认】[uci.uc/官方 ddns.uc](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-ddns/root/usr/share/rpcd/ucode/ddns.uc#L10)
- 变更后要通知服务：`/etc/init.d/traffic-statsd reload`，或依赖 procd 的 `reload_trigger`（3.6）。

---

## 5. 打包：24.10 vs 23.05（以及 25.12 的 apk）

### 5.1 关键结论：24.10 并没有用 apk 替代 opkg

这是本次调研最需要澄清的一点。

| 版本 | 包管理器 | 证据 |
|---|---|---|
| 23.05 | **opkg**（无 apk） | `package/system/apk/Makefile` 在 23.05 分支 **404 不存在**；`opkg` 存在【源码确认】 |
| 24.10 | **opkg 默认**；apk 是**编译期实验选项且被标记 BROKEN** | `config/Config-build.in`：`config USE_APK` / `bool "Use APK instead of OPKG to build distribution (BROKEN)"` / **`depends on BROKEN`**，没有 `default y`【源码确认】 |
| main（→25.12） | **apk 默认** | 同一 config 变成 `bool "Use APK instead of OPKG to build distribution"` + **`default y`**【源码确认】 |
| 25.12+ | apk | 官方 wiki："APK … is the package manager used in **OpenWrt 25.12 and newer**"【文档确认】 |

- 24.10 分支已有 `package/system/apk/Makefile`（apk 作为包可编），但 **`USE_APK` 依赖 `BROKEN` 符号**，所以正常编译配置里不会启用；默认产物是 `.ipk`。【源码确认】[Config-build.in@24.10](https://github.com/openwrt/openwrt/blob/openwrt-24.10/config/Config-build.in) vs [Config-build.in@main](https://github.com/openwrt/openwrt/blob/main/config/Config-build.in)
- 官方 wiki：APK 用于 25.12 及以后，取代已停止开发的 opkg。【文档确认】[apk package manager](https://openwrt.org/docs/guide-user/additional-software/apk)

**对 Makefile 的影响：几乎为零。**`package-pack.mk` 里只有产物路径分叉：`CONFIG_USE_APK` 为空 → `$(1)_$(VERSION)_$(PKGARCH).ipk`；非空 → `$(1)-$(VERSION).apk`；`Package/<name>/install`、`conffiles` 等写法完全不变。【源码确认】[package-pack.mk#L98-L108](https://github.com/openwrt/openwrt/blob/openwrt-24.10/include/package-pack.mk#L98-L108)

> 所以：**写一份 Makefile，24.10/23.05 用 opkg 装，25.12+ 用 apk 装，不需要两套。** 唯一要注意的是 `postinst/preinst` 里对 `IPKG_INSTROOT` 的假设（见 4.3 的"未查证"）。

### 5.2 双包结构（强烈建议，也是全部官方范例的做法）

| 包 | 内容 | 架构 |
|---|---|---|
| `traffic-statsd` | 守护进程二进制、init.d、默认 UCI 配置、hotplug | **架构相关**（默认 `PKGARCH=$(ARCH_PACKAGES)`） |
| `luci-app-traffic-stats` | JS 视图、menu.d、acl.d、rpcd 后端（ucode/sh 脚本） | `LUCI_PKGARCH:=all`（纯脚本，可跨架构） |

实证：`nlbwmon`（`packages` feed，C 守护进程）与 `luci-app-nlbwmon`（`luci` feed，纯前端）就是这样拆的，两者的 `LUCI_DEPENDS:=+luci-base +luci-lib-chartjs +nlbwmon` 把 UI 与 daemon 连起来。【源码确认】[nlbwmon/Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/Makefile)、[luci-app-nlbwmon/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-nlbwmon/Makefile)

优点：架构无关的 UI 只编一次（`PKGARCH: all` 的 ipk 可复用）；C 二进制单独按架构出包；升级解耦。

### 5.3 守护进程包 Makefile 关键字段

以 nlbwmon（上游 git 源码）与 xupnpd（手写 `$(TARGET_CC)`）为范本。【源码确认】[nlbwmon](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/Makefile)、[xupnpd](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/xupnpd/Makefile)

| 字段 | 作用 / 取值 |
|---|---|
| `include $(TOPDIR)/rules.mk` | 必须是第一行（定义 `$(TOPDIR)`、`$(INCLUDE_DIR)`、`$(BUILD_DIR)`） |
| `PKG_NAME` | 包名，决定 `PKG_BUILD_DIR` 与 `BuildPackage` 名 |
| `PKG_VERSION` / `PKG_RELEASE` | 版本；`VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)` |
| `PKG_SOURCE`/`PKG_SOURCE_URL`/`PKG_HASH` 或 `PKG_SOURCE_PROTO:=git`+`PKG_SOURCE_VERSION`+`PKG_MIRROR_HASH` | 源码来源（git 方式需 `PKG_SOURCE_DATE`） |
| `PKG_BUILD_DIR` | 默认 `$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)`【源码确认】[package.mk#L11](https://github.com/openwrt/openwrt/blob/openwrt-24.10/include/package.mk#L11) |
| `PKG_INSTALL` | 置 1 则调用上游 `make install`，装到 `PKG_INSTALL_DIR`【文档确认】 |
| `PKG_BUILD_DEPENDS` / `PKG_BUILD_PARALLEL` / `PKG_BUILD_FLAGS` | 构建期依赖 / 并行 / flags（如 `no-mips16`） |
| `include $(INCLUDE_DIR)/package.mk` | 必须；若用 cmake/autotools 再 include 对应 `.mk` |
| `Package/<name>` 段 | `SECTION` `CATEGORY` `TITLE` `DEPENDS` `URL` `PKGARCH` `USERID` `PROVIDES` `ALTERNATIVES` |
| `Package/<name>/install` | 用 `$(1)` 作为目标根，`$(INSTALL_DIR/BIN/DATA/CONF)` 安装 |
| `Package/<name>/conffiles` | 配置文件清单（不缩进） |
| `Package/<name>/{preinst,postinst,prerm,postrm}` | 维护脚本 |
| `$(eval $(call BuildPackage,<name>))` | 收尾，每个子包一次 |

### 5.4 LuCI 包的 `luci.mk` 专有字段

```make
include $(TOPDIR)/rules.mk

LUCI_TITLE:=流量统计 Web 界面
LUCI_DESCRIPTION:=Traffic statistics for OpenWrt
LUCI_DEPENDS:=+luci-base +luci-lib-chartjs +traffic-statsd
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Your Name <you@example.com>

include ../../luci.mk
```

| 变量 | 说明（均来自 luci.mk） |
|---|---|
| `LUCI_TITLE` / `LUCI_DESCRIPTION` | 包标题/描述；不写 title 则自动生成 `LuCI <name> <type>` |
| `LUCI_DEPENDS` → `DEPENDS` | 运行时依赖，语法同 OpenWrt `DEPENDS` |
| `LUCI_PKGARCH` → `PKGARCH` | **默认 `all`，但当目录下存在 `src/Makefile` 时默认变空（即架构相关）**，见 5.5 |
| `LUCI_EXTRA_DEPENDS` → `EXTRA_DEPENDS` | 带版本约束的依赖 |
| `LUCI_TYPE` / `LUCI_CATEGORY` / `LUCI_SUBMENU` / `LUCI_SECTION` / `LUCI_URL` | menuconfig 归类与元数据 |
| `LUCI_MINIFY_JS/CSS/LUA` | 是否压缩（默认 1，依赖 `jsmin`/`csstidy`/`luasrcdiet`） |
| `LUCI_DEFAULTS` | 自动收集 `root/etc/uci-defaults/*` |
| 自动注入的 `postinst` | 清 LuCI 缓存 + `reload rpcd`（可被自己的 `Package/<name>/postinst` 覆盖） |

【源码确认】[luci.mk](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk)

`luci.mk` 还会：`Build/Prepare` 自动拷 `luasrc/ ucode/ htdocs/ root/ src/` 五个目录；`Package/install` 把 `htdocs→/www`、`root→/`、`luasrc→/usr/lib/lua/luci`、`ucode→/usr/share/ucode/luci`，有 `src/` 时调用 `Build/Install/Default`；若存在 `luasrc/`，自动加 `+luci-lua-runtime` 依赖。【源码确认】同文件

### 5.5 架构（PKGARCH）语义与陷阱

- 通用规则：默认按目标架构打包；纯脚本/资源包设 `PKGARCH:=all` 可得单一架构无关 ipk。【文档确认】[packages 文档 PKGARCH](https://openwrt.org/docs/guide-developer/packages)
- `package-defaults.mk` 里 `PKGARCH:=$(ARCH_PACKAGES)`（无则 `$(BOARD)`）。【源码确认】[package-defaults.mk#L39-L43](https://github.com/openwrt/openwrt/blob/openwrt-24.10/include/package-defaults.mk#L39-L43)
- **LuCI 包陷阱**：`luci.mk` 第 12 行 `LUCI_PKGARCH?=$(if $(realpath src/Makefile),,all)` —— 只要你在 LuCI 包目录里放了 `src/Makefile`（即把守护进程源码塞进同一个 LuCI 包），`PKGARCH` 就不再是 `all`，会按架构出包；而 `Build/Compile` 也会改成 `$(MAKE) -C src clean compile`。**这正是不建议把 C 守护进程塞进 luci-app 包的技术原因**。【源码确认】[luci.mk#L12](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk#L12)、[luci.mk#L189-L199](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk#L189-L199)

### 5.6 依赖声明（DEPENDS）写法

| 写法 | 含义 |
|---|---|
| `+foo` | 依赖并**选中** `foo` |
| `foo` | 依赖但不在菜单里显示，直到 foo 被选 |
| `@FOO` | 依赖 config 符号 `CONFIG_FOO`（如 `@TARGET_x86`），支持 `&& ! ||` |
| `+FOO:bar` | 若 `CONFIG_FOO` 则依赖并选中 `bar` |
| `@FOO:bar` | 若 `CONFIG_FOO` 则依赖 `bar`（不选中） |

【文档确认】[packages 文档 Dependency Types](https://openwrt.org/docs/guide-developer/packages)

本项目的典型依赖：
- C 守护进程：`DEPENDS:=+libubox +libuci +libblobmsg-json`（用 ubus 时加 `+libubus`）
- 需要 conntrack 统计：`+kmod-nf-conntrack-netlink`（nlbwmon 的写法）；需要 nft 计数：`+kmod-nf-conntrack` / `+nftables-json` 等**按实际内核模块名逐个确认**（本项目具体模块名**未查证**）
- libc 一般**不用**显式依赖（工具链隐式链接；跨 libc 只有 `USE_MUSL/USE_GLIBC` 这类 config 符号可用于条件依赖）
- 线程：musl 把 pthread 合进 libc，**不需要** `+libpthread`（老文档里的 `+libpthread` 是 uClibc 时代遗留）【推断，24.10 默认 musl】

### 5.7 安装段与文件类型

```make
define Package/traffic-statsd/install
	$(INSTALL_DIR)  $(1)/usr/sbin
	$(INSTALL_BIN)  $(PKG_BUILD_DIR)/traffic-statsd $(1)/usr/sbin/
	$(INSTALL_DIR)  $(1)/etc/init.d
	$(INSTALL_BIN)  ./files/traffic-statsd.init $(1)/etc/init.d/traffic-statsd
	$(INSTALL_DIR)  $(1)/etc/config
	$(INSTALL_CONF) ./files/traffic_stats.config $(1)/etc/config/traffic_stats
	$(INSTALL_DIR)  $(1)/etc/uci-defaults
	$(INSTALL_DATA) ./files/90_traffic_stats $(1)/etc/uci-defaults/   # 官方：不应可执行
	$(INSTALL_DIR)  $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/traffic-statsd.acl.json $(1)/usr/share/rpcd/acl.d/
endef
```

- `$(INSTALL_BIN)` 0755 / `$(INSTALL_DATA)` 0644 / `$(INSTALL_CONF)` 0600-ish（配置） / `$(INSTALL_DIR)` 建目录。
- **luci-app 包不需要手写 install 段**：`htdocs/` 与 `root/` 会被 `luci.mk` 自动装好，这正是官方推荐的"把你的文件按 `root/` 目录树摆放"的做法。【文档确认】[structure.md](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/structure.md)
- `USERID:=traffic-stats:traffic-stats` 可让安装时自动创建系统用户（配合 procd 降权）。【文档确认】[packages 文档 USERID](https://openwrt.org/docs/guide-developer/packages)

### 5.8 C / Go 的构建集成

**C，上游有 CMake**（推荐，nlbwmon 用的就是这条）：`CMAKE_INSTALL:=1` + `include $(INCLUDE_DIR)/cmake.mk`，交叉编译参数由框架注入，`Package/install` 从 `$(PKG_INSTALL_DIR)` 取产物。【源码确认】[nlbwmon Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/Makefile)

**C，上游有 autotools**：`include $(INCLUDE_DIR)/autotools.mk`（`include/autotools.mk` 在 24.10 存在）【源码确认】。

**C，只有几个 .c 或源码就在 feed 里**：自己写 `Build/Prepare` + `Build/Compile`，用 `$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) … $(TARGET_LDFLAGS)`。【源码确认】[xupnpd Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/xupnpd/Makefile)

```make
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall -O2 \
		-o $(PKG_BUILD_DIR)/traffic-statsd \
		$(PKG_BUILD_DIR)/*.c \
		$(TARGET_LDFLAGS) -lubus -lubox -lblobmsg_json -luci
endef
```

**Go**：不要手写 `go build`，用 packages feed 的 `golang-package.mk`（注意它在 **packages feed** 的 `lang/golang/` 下，不在 core 的 `include/` 里——本次核对 `include/golang-package.mk` 在 24.10 是 404）。【源码确认】[go2rtc Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/go2rtc/Makefile)、[golang-package.mk](https://github.com/openwrt/packages/blob/openwrt-24.10/lang/golang/golang-package.mk)

```make
PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1
include $(INCLUDE_DIR)/package.mk
include ../../lang/golang/golang-package.mk

GO_PKG:=example.com/traffic-stats
GO_PKG_LDFLAGS_X:=main.version=$(PKG_VERSION)

define Package/traffic-statsd
  DEPENDS:=$(GO_ARCH_DEPENDS)
  USERID:=traffic-stats:traffic-stats
endef

define Package/traffic-statsd/install
	$(call GoPackage/Package/Install/Bin,$(1))
	# 再装 init.d / config
endef
```

体积代价（工程判断，**具体数字未查证**）：Go 静态二进制通常数 MB 到数十 MB，需 `-ldflags "-s -w"`（`GO_PKG_LDFLAGS`）与 `no-mips16` 之类 flags；对 8/16 MB flash 的路由器通常不可接受。同样功能的 C 守护进程一般在几十到几百 KB。

### 5.9 自定义 feed 的组织

已验证的事实：
- 官方 luci feed 的布局是**仓库根放 `luci.mk`**，各 app 在 `applications/luci-app-*` 下写 `include ../../luci.mk`。【源码确认】[luci-app-example/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/Makefile)
- `packages` feed **从不** include `luci.mk`（对该 feed 全部 `Makefile` 检索 `luci.mk` 无命中），说明 LuCI 包与普通包分属不同 feed。【源码确认】

因此自定义 feed 有三种可行做法（按推荐度）：

1. **自建 feed 仓库，根目录放一份 `luci.mk`**（从 `openwrt/luci` 拷贝），目录结构：
   ```
   my-feed/
   ├── luci.mk                      # 拷贝自 openwrt/luci
   ├── luci-app-traffic-stats/      # include ../luci.mk
   └── traffic-statsd/              # include $(TOPDIR)/rules.mk + package.mk
   ```
   然后 `src-git myfeed https://…/my-feed.git` 写进 `feeds.conf.default`。这与官方 luci feed 同构，最稳。
2. **把 app 放进 luci feed 的 `applications/` 目录**（本地开发时最省事，但不便于分发）。
3. **`include $(TOPDIR)/feeds/luci/luci.mk`**：依赖构建机已 `./scripts/feeds update` 出 `feeds/luci`（该目录根就是含 `luci.mk` 的 luci 仓库）。可行，但**不是官方文档写明的方式**，属社区惯例（**未查证是否有官方推荐**）。

> feed 里的包仍需遵守"一个 feed 一条 `src-git`"，并且 `./scripts/feeds install -a` 后才能 `make menuconfig` 看到。

---

## 6. 二进制 vs 脚本：守护进程用什么写

### 6.1 选型矩阵

| 方案 | 启动/常驻开销 | 单次采集开销 | 依赖 | 可维护性 | 结论 |
|---|---|---|---|---|---|
| **C** | 极低，RSS 可控（几十 KB~几 MB） | 最低 | libc + 需要的库 | 差（内存管理/样板代码） | **采集与落库用它** |
| **Go** | 低 | 低 | 静态链接，体积大 | 好 | 仅当生态必须（如已有 Go 实现） |
| **ucode** | 需 `ucode` 进程或挂在 rpcd 内 | 中（解释执行，无 JIT） | `+ucode` | **最好**（JSON 原生、语法近 JS） | **控制面/查询/胶水**；不适合高频采集 |
| **Lua** | 低 | 中 | `+luci-lua-runtime` / `liblua` | 中（LuCI 侧已 deprecated） | 不推荐新写 |
| **ash/sh** | 最低（无额外依赖） | **最高**（每次 `read`/算术都要 fork 外部命令；shell 算术只有整数） | 无 | 差（引号/分词/错误处理坑） | 只做 init.d 与一次性动作 |

### 6.2 ucode 的事实依据

- 上游自述："small scripting language for Linux systems … ECMAScript syntax, an embeddable C core, JSON as a native datatype … **preinstalled on OpenWrt 22.03 and later**"；并给出尺寸："**~64 KB** interpreter and runtime on ARM Cortex A9"；并声明"OpenWrt's firewall and web interface are written in it"。【文档确认】[ucode.mein.io](https://ucode.mein.io/)
- 24.10 的 LuCI 服务端（dispatcher/runtime/sys）本身就是 ucode 写的，说明它是被官方支持的"一等公民"运行时。【源码确认】`modules/luci-base/ucode/*.uc`
- 整数语义：ucode 提供"64-bit integers with a guaranteed range, distinct from double"（上游首页），对字节计数器友好。【文档确认】

### 6.3 用脚本写守护进程的坑（务必规避）

1. **每轮循环 fork 外部命令**：ash 里 `date +%s`、`wc -c`、`awk` 都是 fork+exec，几十毫秒起步；1 秒级采样会显著吃 CPU。**对策**：采样周期 ≥ 10 s，或把循环放进 ucode/单进程内。
2. **ash 只有整数算术**：`$(( ))` 不支持浮点，累计字节数除法/速率换算要做定点运算；`bc` 是额外依赖（busybox 默认不带 `bc`）。
3. **无内存上限、无 GC**：脚本里数组/字符串拼接持续增长会 OOM；必须自己限制历史长度。
4. **信号处理弱**：ash 的 `trap` 只能在命令间隙生效，优雅关闭（flush 数据库）不可靠；procd 发 SIGTERM 后可能来不及落盘。**对策**：写库要"小步快写 + 原子 rename"。
5. **错误处理**：`set -e` 在 procd 的 `command` 下行为容易误判；命令失败不退出会导致"假活"（procd 认为 running，实际不采集）。**对策**：核心循环里检查退出码并主动 `exit 1`，让 respawn 生效。
6. **依赖膨胀**：用 lua 写 daemon 需要 `liblua` + 自备 lua 模块路径；用 ucode 写需要 `+ucode`（约 64 KB 解释器 + 模块），比 C 大但可接受。
7. **可观测性差**：脚本 daemon 打日志只能 `logger`，且没法用 `stderr 1` 之外的调试手段（可以，见 3.4）。

### 6.4 对本项目的建议分工

```
C 守护进程 traffic-statsd        : 采集（netlink/nft counter）、聚合、写 SQLite/自定义 binlog、SIGHUP 重载
ucode rpcd 插件 traffic-stats.uc : 读 UCI 配置、查库（只读）、返回 JSON 给前端；破坏性操作单独方法 + root 校验
LuCI JS 视图                      : 配置表单 + 图表（chartjs），只经 rpc.declare/fs.exec_direct
init.d                           : procd 托管、reload trigger、interface trigger
```

> 为什么不让前端直接读数据库？因为 LuCI 的 ACL 能控制"能否 exec/能否调某方法"，但**不能**做 SQL 级授权；一旦把"执行任意查询"暴露出去就等于把库交出去。用固定的 rpcd 方法（参数受 ubus 类型约束）是更小的攻击面。

---

## 7. 最小完整骨架清单（供后续开发照此实现）

### 7.1 目录树

```
my-feed/                                  # 自定义 feed 根（含 luci.mk 拷贝）
├── luci.mk                               # 从 openwrt/luci@openwrt-24.10 原样拷贝
│
├── traffic-statsd/                       # ① 守护进程包（架构相关）
│   ├── Makefile
│   ├── src/
│   │   ├── main.c                        # 采集主循环、SIGHUP、写库
│   │   └── …                             # 采集/存储模块
│   └── files/
│       ├── traffic-statsd.init           # procd init（第 3.1 节骨架）
│       ├── traffic_stats.config          # /etc/config 默认配置（第 4.1 节）
│       └── 90_traffic_stats              # uci-defaults，首次/升级补齐默认值（第 4.3 节）
│
└── luci-app-traffic-stats/               # ② LuCI 包（PKGARCH=all）
    ├── Makefile                          # include ../luci.mk
    ├── htdocs/luci-static/resources/
    │   └── view/traffic-stats/
    │       ├── overview.js               # 图表总览（rpc.declare + chartjs）
    │       └── config.js                 # 配置表单（form.Map）
    ├── root/
    │   ├── usr/share/luci/menu.d/luci-app-traffic-stats.json     # 菜单（第 1.4 节）
    │   ├── usr/share/rpcd/acl.d/luci-app-traffic-stats.json      # ACL（第 2.1 节）
    │   └── usr/share/rpcd/ucode/traffic-stats.uc                 # 后端（第 2.2 形态 B）
    └── po/
        ├── templates/traffic-stats.pot   # 可选：翻译模板
        └── zh_Hans/traffic-stats.po
```

### 7.2 每个文件的职责

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `luci.mk` | LuCI 包通用构建逻辑 | 原样拷贝，勿改；升级时随上游同步 |
| `traffic-statsd/Makefile` | 编 C、装 init.d/config/uci-defaults、声明 `conffiles`/`USERID`/`DEPENDS` | `DEPENDS` 带 `+kmod-…`；不要设 `PKGARCH:=all` |
| `src/main.c` | 常驻采集；信号处理；状态可观测 | 必须处理 SIGTERM（flush）与 SIGHUP（重载） |
| `files/traffic-statsd.init` | `USE_PROCD=1`；读 UCI 拼 `command`；`respawn`/`stdout 1`/`stderr 1`；`reload_trigger`/`interface trigger` | `reload_service()` 必须存在，否则 `reload` 会走默认 restart |
| `files/traffic_stats.config` | 默认配置（带 section！） | 与 `config`/`form.Map` 的 section 名严格一致 |
| `files/90_traffic_stats` | 首次/升级补齐字段，幂等；**退出 0** | 用 `uci -q get … ||` 守卫，禁止无脑覆盖（4.2） |
| `luci-app-traffic-stats/Makefile` | `LUCI_TITLE`/`LUCI_DEPENDS`/`LUCI_PKGARCH:=all`；`include ../luci.mk` | 依赖里要含 `+traffic-statsd` 与 `+luci-lib-chartjs` |
| `view/traffic-stats/config.js` | 配置表单 | 每个 option 的 section/name 必须与 UCI 一致；给 `default`/`placeholder` |
| `view/traffic-stats/overview.js` | 图表 + 服务状态 | `load()` 里 `Promise.all([...])`；`service.list` 判活；`prompt`/`poll` 定时刷新 |
| `menu.d/…json` | 菜单树 | `action.type` 只用 `view`/`firstchild`/`alias`；顶级节点加 `depends.acl` |
| `acl.d/…json` | 授权 | 读/写分离；`service:["list"]` 若需要；`file.exec` 用前缀白名单 |
| `usr/share/rpcd/ucode/traffic-stats.uc` | 后端实现 | 返回签名对象；破坏性方法校验 `request.info.acl.user == 'root'` |
| `po/*` | i18n | 用 `_()` 包裹的字符串才会被提取；`LUCI_LANGUAGES` 自动识别 `po/<lang>/` |

### 7.3 关键文件的最小内容（可直接照抄的形态）

- **menu.d**：第 1.4 节。
- **acl.d**：
  ```json
  {
    "luci-app-traffic-stats": {
      "description": "Grant access to traffic statistics",
      "read": {
        "ubus": { "traffic-stats": [ "get_totals", "get_ifaces" ],
                  "service": [ "list" ] },
        "uci": [ "traffic_stats" ],
        "file": { "/usr/sbin/traffic-statsctl dump --json": [ "exec" ] }
      },
      "write": {
        "ubus": { "traffic-stats": [ "reset" ] },
        "uci": [ "traffic_stats" ]
      }
    }
  }
  ```
- **rpcd ucode 后端**：第 2.2 节形态 B。
- **init.d**：第 3.1 节。
- **config**：第 4.1 节。
- **luci-app Makefile**：第 5.4 节；**守护进程 Makefile**：第 5.3/5.8 节。

### 7.4 构建与验证步骤（命令层面）

```sh
# 1) SDK / buildroot：加入 feed
echo 'src-git myfeed https://example.com/my-feed.git' >> feeds.conf.default
./scripts/feeds update myfeed && ./scripts/feeds install -a -p myfeed

# 2) 选中
make menuconfig      # LuCI → Applications → luci-app-traffic-stats

# 3) 只编这两个包
make package/feeds/myfeed/luci-app-traffic-stats/compile V=s
make package/feeds/myfeed/traffic-statsd/compile V=s

# 4) 产物
find bin/packages -name '*traffic-stats*'
```

设备侧验证（**本次未执行，属待实测**）：
```sh
opkg install /tmp/luci-app-traffic-stats*.ipk /tmp/traffic-statsd*.ipk
ubus -v list traffic-stats
ubus call traffic-stats get_totals '{"iface":"wan"}'
ubus call service list '{"name":"traffic-statsd"}'
/etc/init.d/traffic-statsd reload && logread -e traffic-statsd
```

---

## 8. 未查证 / 待实测清单（明确标注，勿当作结论使用）

1. **24.10 真机行为**：全部结论来自源码/文档；`ubus service list` 的实际返回结构、`reload` 的耗时、ACL 生效边界均**未在设备上实测**。
2. **apk 下的维护脚本变量**：`IPKG_INSTROOT` 在 apk（25.12+）下是否仍然可用 / 对应变量名是什么——**未查证**。若要在 25.12+ 支持迁移逻辑，需单独确认。
3. **本项目具体需要的内核模块名**（如 conntrack/netlink 计数的 kmod 包名）——**未查证**，需按目标内核版本核对。
4. **rpcd 读 root-only 文件/数据库的权限边界**：rpcd 以 root 运行（推断自 `PROG=/sbin/rpcd` 与 procd 未降权），因此 ucode 插件读 root 库应可行，但**未实测**。
5. **23.05 上 `luci-lib-chartjs` 缺失**已确认；替代方案（自带 chart.js / 用 vnstati 式图片）**未实测**其在 23.05 的浏览器兼容表现。
6. **Go 二进制的实际体积**（不同架构/裁剪选项）——**未查证**，只有定性判断。
7. **`entry()` 在 JS 里的可用性**：已核对——`modules/luci-base/htdocs/luci-static/resources/luci.js` 中**不存在** `entry()` 定义（仅 `Poll` API 的参数恰好叫 entry），且全仓库 JS 无调用。可判定它是 Lua 时代 API，JS 侧一律用 `menu.d`。
8. **chartjs 的版本与 API**：24.10 自带的是 `nlbw.chart.min.js`（定制版，全局 `Chart`，用法接近 Chart.js v1/v2 混合）；具体可用 API 需按该文件实际能力确认——**未逐行核对**。

---

## 9. 参考来源

### 9.1 LuCI 仓库（`openwrt/luci`，分支 `openwrt-24.10`）

- 包结构官方说明：[applications/luci-app-example/structure.md](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/structure.md)
- 官方示例 Makefile：[luci-app-example/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/Makefile)
- 视图示例（表单/ RPC）：[view/example/form.js](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/htdocs/luci-static/resources/view/example/form.js)、[view/example/rpc.js](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/htdocs/luci-static/resources/view/example/rpc.js)
- 菜单示例：[menu.d/luci-app-example.json](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/root/usr/share/luci/menu.d/luci-app-example.json)
- ACL 示例：[acl.d/luci-app-example.json](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/root/usr/share/rpcd/acl.d/luci-app-example.json)
- rpcd 后端示例（Lua 版协议）：[usr/libexec/rpcd/luci.example](https://github.com/openwrt/luci/blob/openwrt-24.10/applications/luci-app-example/root/usr/libexec/rpcd/luci.example)
- `luci.mk`：[luci.mk](https://github.com/openwrt/luci/blob/openwrt-24.10/luci.mk)
- 仓库内文档索引：[docs/README.md](https://github.com/openwrt/luci/blob/openwrt-24.10/docs/README.md)
- 菜单/路由实现：[modules/luci-base/ucode/dispatcher.uc](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/ucode/dispatcher.uc)
- 默认 ACL：[modules/luci-base/root/usr/share/rpcd/acl.d/luci-base.json](https://github.com/openwrt/luci/blob/openwrt-24.10/modules/luci-base/root/usr/share/rpcd/acl.d/luci-base.json)
- 默认集合依赖：[collections/luci/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/collections/luci/Makefile)、[collections/luci-light/Makefile](https://github.com/openwrt/luci/blob/openwrt-24.10/collections/luci-light/Makefile)
- 图表库：[libs/luci-lib-chartjs](https://github.com/openwrt/luci/tree/openwrt-24.10/libs/luci-lib-chartjs)
- 实战范本：
  - [luci-app-nlbwmon](https://github.com/openwrt/luci/tree/openwrt-24.10/applications/luci-app-nlbwmon)（流量统计 + chartjs + exec 后端）
  - [luci-app-vnstat2](https://github.com/openwrt/luci/tree/openwrt-24.10/applications/luci-app-vnstat2)（流量图表 + 服务状态 + exec ACL）
  - [luci-app-statistics](https://github.com/openwrt/luci/tree/openwrt-24.10/applications/luci-app-statistics)（rrdtool 出图 + 大 ACL）
  - [luci-app-pbr](https://github.com/openwrt/luci/tree/openwrt-24.10/applications/luci-app-pbr)（shell rpcd 后端 + 读写分离 ACL）
  - [luci-app-ddns](https://github.com/openwrt/luci/tree/openwrt-24.10/applications/luci-app-ddns)（ucode rpcd 插件 344 行范例）
- LuCI JS API 文档：[openwrt.github.io/luci/jsapi/LuCI.html](https://openwrt.github.io/luci/jsapi/LuCI.html)

### 9.2 OpenWrt core / rpcd / ubus（分支 `openwrt-24.10` 或 `master`）

- procd 参数与语义：[package/system/procd/files/procd.sh](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/procd/files/procd.sh)
- rpcd init（reload = SIGHUP）：[package/system/rpcd/files/rpcd.init](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/rpcd/files/rpcd.init)
- rpcd 插件打包宏（`rpcd-mod-ucode`）：[package/system/rpcd/Makefile](https://github.com/openwrt/openwrt/blob/openwrt-24.10/package/system/rpcd/Makefile)
- rpcd ucode 插件目录与实现：[rpcd/ucode.c](https://github.com/openwrt/rpcd/blob/master/ucode.c)
- rpcd C 插件 ABI：[include/rpcd/plugin.h](https://github.com/openwrt/rpcd/blob/master/include/rpcd/plugin.h)
- rpcd ucode 插件官方示例：[examples/ucode/example-plugin.uc](https://github.com/openwrt/rpcd/blob/master/examples/ucode/example-plugin.uc)
- rpcd `file` 插件（exec ACL 的"命令+参数"拼接匹配实现）：[rpcd/file.c](https://github.com/openwrt/rpcd/blob/master/file.c)
- ubus C 对象示例：[ubus examples/server.c](https://github.com/openwrt/ubus/blob/master/examples/server.c)
- 包默认变量（PKGARCH 等）：[include/package-defaults.mk](https://github.com/openwrt/openwrt/blob/openwrt-24.10/include/package-defaults.mk)
- ipk/apk 产物分叉：[include/package-pack.mk](https://github.com/openwrt/openwrt/blob/openwrt-24.10/include/package-pack.mk)
- `USE_APK` 在 24.10（BROKEN）：[config/Config-build.in](https://github.com/openwrt/openwrt/blob/openwrt-24.10/config/Config-build.in)
- `USE_APK` 在 main（default y）：[config/Config-build.in](https://github.com/openwrt/openwrt/blob/main/config/Config-build.in)

### 9.3 packages feed（`openwrt/packages`，分支 `openwrt-24.10`）

- C 守护进程 + procd 范本：[net/nlbwmon](https://github.com/openwrt/packages/tree/openwrt-24.10/net/nlbwmon)（[Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/Makefile)、[nlbwmon.init](https://github.com/openwrt/packages/blob/openwrt-24.10/net/nlbwmon/files/nlbwmon.init)）
- 最小 procd + 降权：[multimedia/go2rtc](https://github.com/openwrt/packages/tree/openwrt-24.10/multimedia/go2rtc)（[Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/go2rtc/Makefile)、[go2rtc.init](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/go2rtc/files/go2rtc.init)）
- 手写 `$(TARGET_CC)`：[multimedia/xupnpd/Makefile](https://github.com/openwrt/packages/blob/openwrt-24.10/multimedia/xupnpd/Makefile)
- Go 打包宏：[lang/golang/golang-package.mk](https://github.com/openwrt/packages/blob/openwrt-24.10/lang/golang/golang-package.mk)

### 9.4 OpenWrt 官方 wiki

- rpcd 与 plugin executables 协议：[docs/techref/rpcd](https://openwrt.org/docs/techref/rpcd)
- ubus 技术参考：[docs/techref/ubus](https://openwrt.org/docs/techref/ubus)
- procd init 脚本示例（含 respawn/limits/stdout）：[docs/guide-developer/procd-init-script-example](https://openwrt.org/docs/guide-developer/procd-init-script-example)
- procd init 脚本（含 **Service jails**）：[docs/guide-developer/procd-init-scripts](https://openwrt.org/docs/guide-developer/procd-init-scripts)
- 包 Makefile 全字段（DEPENDS/PKGARCH/PKG_INSTALL/USERID/conffiles）：[docs/guide-developer/packages](https://openwrt.org/docs/guide-developer/packages)
- UCI 技术参考（batch/commit/暂存语义）：[docs/techref/uci](https://openwrt.org/docs/techref/uci)
- UCI defaults 语义与防覆盖写法：[docs/guide-developer/uci-defaults](https://openwrt.org/docs/guide-developer/uci-defaults)
- apk 包管理器（25.12+）：[docs/guide-user/additional-software/apk](https://openwrt.org/docs/guide-user/additional-software/apk)
- opkg（23.05/24.10）：[docs/guide-user/additional-software/opkg](https://openwrt.org/docs/guide-user/additional-software/opkg)
- LuCI 技术参考（总索引）：[docs/techref/luci](https://openwrt.org/docs/techref/luci)
- 注意：wiki 的 [docs/guide-developer/luci](https://openwrt.org/docs/guide-developer/luci) 页面标题是"Adding new elements to LuCI"，内容是 **Lua/CBI 时代**的做法（`cbi_tab`/`cbi_file`），**不适用于 24.10 的 JS 开发**，不要照抄。

### 9.5 ucode

- 上游主页（64 KB 解释器、22.03+ 预装、64 位整数）：[ucode.mein.io](https://ucode.mein.io/)

---

## 附：一页速查（给实现者）

1. **两个包**：`traffic-statsd`（C/架构相关）+ `luci-app-traffic-stats`（`LUCI_PKGARCH:=all`）。
2. **前端**：只写 JS，`htdocs/luci-static/resources/view/traffic-stats/*.js`；菜单写 `menu.d` JSON；绝不写 Lua CBI。
3. **后端**：ucode rpcd 插件（`/usr/share/rpcd/ucode/*.uc`，依赖 `+rpcd-mod-ucode`）为主；低频/命令类用 `/usr/libexec/rpcd/<obj>`。
4. **ACL**：`acl.d` 里读写分离、方法级白名单、`service:["list"]` 单独给、exec 用命令行前缀。
5. **服务**：`USE_PROCD=1` + `respawn 3600 5 5` + `stdout/stderr 1` + `reload_trigger`。
6. **配置**：装包即铺默认 UCI；`conffiles` 保住用户配置；`uci-defaults` 只做一次幂等补齐；格式升级靠 `config_version` + postinst。
7. **包管理器**：24.10/23.05 是 **opkg**（apk 从 25.12 起才默认），Makefile 不用改。
8. **构建**：C 优先 cmake.mk/autotools.mk，单文件才手写 `$(TARGET_CC)`；Go 用 `golang-package.mk`（体积代价大）。
