'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 流量统计 · 设备
 *
 * 只消费 state.devices（不碰顶层 apps），一次 rpc 调用。
 * 列表按商用 App 的浏览逻辑组织：全部/在线/离线分段 + 摘要，表头本地排序，
 * 搜索与接入筛选，全部只过滤内存数据、不额外发 RPC。
 * 点设备行打开右侧详情抽屉（明细按需构建）；行首「▸」仍可展开行内应用分布，
 * 200 台设备也不会在加载时把几千个节点塞进页面。
 * 页面每 15s 拉一次 get_state 刷新；「暂停刷新」会停掉轮询。
 *
 * 设备识别（纯本地，不联网、不加 RPC）：
 *   - 厂商：内置 OUI_TABLE（MAC 前 3 字节 → 厂商标识），vendorOf() 查表；
 *     第 0/1 位（组播/本地管理）为 1 的随机 MAC 一律不认厂商，显示「未知厂商」。
 *   - 类型：deviceKindOf() 按 hostname/alias 关键词推断（手机/电脑/电视/平板/
 *     智能设备），短词用词边界匹配；deviceKindSvg() 生成 24px 线性图标。
 *   - 主机名列 = 类型图标 + 名称 + 厂商小字；表头可按厂商排序，工具栏有厂商筛选。
 *
 * 设备元数据 / 配额 / 导出（SPEC §10）：
 *   - 别名、分组：`set_device_meta {mac, alias, group}`（空串 = 清除该字段）。
 *     弹窗里的改动按 MAC 存进内存草稿，RPC 失败或点「取消」都不会丢，
 *     再次打开同一台设备会带出草稿；只有保存成功或显式「放弃修改」才清掉。
 *   - 本月用量：后端 `month_rx/month_tx/month_total`；`quota_limit` 只在
 *     quota_mode=device 时出现，剩余量 = limit - used（分母 0 时显示 —）。
 *   - CSV：`export_csv {what:'devices'}` 返回带 BOM/CRLF 的字符串，原样存盘；
 *     详情抽屉里的「导出该设备 CSV」按后端同样的列在前端拼一行下载。
 *   - 阻断建议只是只读 nft 命令文本（与概览页一致），不执行、不新增 RPC。
 *
 * 所有动态值都走 E()/textContent，不拼 HTML 字符串。窄屏隐藏次要列（首次出现/
 * 信号），表格容器内横向滚动，页面本身不会横向失控；抽屉在 <760px 时全宽。
 *
 * 单位：流量二进制（GiB/MiB），速率十进制 Mb/s（bits），括号/悬浮为十进制 MB/s。
 */

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

/* 写设备元数据（SPEC §10.1）。args 必须声明，否则 ubus 会拒收参数。 */
var callSetDeviceMeta = rpc.declare({
	object: 'traffic-stats',
	method: 'set_device_meta',
	params: [ 'mac', 'alias', 'group' ],
	expect: {}
});

/* 设备 CSV（SPEC §10.3.1）：what=devices，返回 {ok, filename, rows, csv}。 */
var callExportCsv = rpc.declare({
	object: 'traffic-stats',
	method: 'export_csv',
	params: [ 'what' ],
	expect: {}
});

/*
 * 哑桥 AP 上报的无线站点元数据（只有信号/速率/连接时长，没有字节）。
 * 老版本后端没有这个方法 → 调用失败时整页照常显示，只是信号列全是 "-"。
 */
var callCapability = rpc.declare({
	object: 'traffic-stats',
	method: 'status',
	expect: {}
});

var callStations = rpc.declare({
	object: 'traffic-stats',
	method: 'get_stations',
	expect: {},
	reject: true
});

function num(value) {
	var n = (typeof value == 'number') ? value : parseInt(value, 10);
	return (typeof n == 'number' && isFinite(n)) ? n : 0;
}

function fmtBytes(bytes) {
	var n = num(bytes);

	if (n >= 1099511627776) return (n / 1099511627776).toFixed(2) + ' TiB';
	if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GiB';
	if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
	if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';

	return Math.round(n) + ' B';
}

function fmtRateBits(bytesPerSecond) {
	var bits = num(bytesPerSecond) * 8;

	if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gb/s';
	if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mb/s';
	if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' kb/s';

	return Math.round(bits) + ' b/s';
}

function fmtRateBytes(bytesPerSecond) {
	var n = num(bytesPerSecond);

	if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB/s';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB/s';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB/s';

	return Math.round(n) + ' B/s';
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

function fmtTime(ts) {
	var t = num(ts);

	if (!t) return '—';

	var diff = Math.floor(Date.now() / 1000) - t;

	if (diff < 0) diff = 0;
	if (diff < 5) return _('在线');
	if (diff < 60) return diff + ' ' + _('秒前');
	if (diff < 3600) return Math.floor(diff / 60) + ' ' + _('分钟前');
	if (diff < 86400) return Math.floor(diff / 3600) + ' ' + _('小时前');

	var d = new Date(t * 1000);

	return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function deviceName(dev) {
	if (dev == null) return _('未知设备');
	if (dev.hostname && ('' + dev.hostname).length) return '' + dev.hostname;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
}

function deviceTotal(dev) {
	return num(dev.direct_rx) + num(dev.direct_tx) + num(dev.proxy_rx) + num(dev.proxy_tx);
}

function monthTotal(dev) {
	if (dev != null && dev.month_total != null)
		return num(dev.month_total);

	return num(dev != null ? dev.month_rx : 0) + num(dev != null ? dev.month_tx : 0);
}

/* 老后端没有 month_* 时显示 —，不拿 0 B 冒充“本月没用量”。 */
function monthAvailable(dev) {
	return dev != null &&
		(dev.month_total != null || dev.month_rx != null || dev.month_tx != null);
}

/* 本地日期（设备页只到天；后端 first_seen 是 Unix 秒）。 */
function fmtDate(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* first_seen 在 24 小时内 → 标「新」（SPEC §10.4：阈值由前端定）。 */
var NEW_DEVICE_SEC = 86400;

function isNewDevice(dev) {
	var seen = num(dev != null ? dev.first_seen : 0);

	return seen > 0 && (Math.floor(Date.now() / 1000) - seen) < NEW_DEVICE_SEC;
}

/* 归一化 MAC 作为草稿键，与后端 set_device_meta 的入参一致。 */
function macKey(dev) {
	var mac = (dev != null && dev.mac != null) ? ('' + dev.mac).trim() : '';

	return mac.replace(/-/g, ':').toUpperCase();
}

function aliasOf(dev) {
	return (dev != null && dev.alias != null) ? ('' + dev.alias) : '';
}

function groupOf(dev) {
	return (dev != null && dev.group != null) ? ('' + dev.group) : '';
}

/*
 * alias / group 的单字段上限是 128 **UTF-8 字节**（后端 clean_text() 按字节安全
 * 截断）。JS 的 String.length 是 UTF-16 码元数，中文 43 字就只有 43，拿它判断
 * 会放过 129 字节的输入，被后端悄悄截断。这里统一用 TextEncoder 量 UTF-8。
 */
var DEVICE_TEXT_MAX = 128;
var ADMIN_ACL = 'luci-app-traffic-stats-admin';

function utf8Bytes(value) {
	var s = (value == null) ? '' : ('' + value);

	if (typeof TextEncoder != 'undefined') {
		try {
			return new TextEncoder().encode(s).length;
		}
		catch (e) { /* 极老浏览器/异常输入，走下面的手算 */ }
	}

	/* 不依赖 TextEncoder 的兜底：按码点算 UTF-8 长度（代理对算 4 字节）。 */
	var bytes = 0;

	for (var i = 0; i < s.length; i++) {
		var code = s.charCodeAt(i);

		if (code < 0x80) {
			bytes += 1;
		}
		else if (code < 0x800) {
			bytes += 2;
		}
		else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
			var next = s.charCodeAt(i + 1);

			if (next >= 0xDC00 && next <= 0xDFFF) {
				bytes += 4;
				i++;
			}
			else {
				bytes += 3;
			}
		}
		else {
			bytes += 3;
		}
	}

	return bytes;
}

function metaByteError(alias, group) {
	var fields = [ [ _('别名'), alias ], [ _('分组'), group ] ];

	for (var i = 0; i < fields.length; i++) {
		var bytes = utf8Bytes(fields[i][1]);

		if (bytes > DEVICE_TEXT_MAX)
			return fields[i][0] + _('不能超过 ') + DEVICE_TEXT_MAX + _(' 字节（UTF-8，当前 ') +
				bytes + _(' 字节；中文通常 3 字节/字），请缩短后再保存。');
	}

	return null;
}

/*
 * 权限：只有 luci-app-traffic-stats-admin 才有写设备元数据的资格。LuCI 24.10
 * 的 header 本来不注入 acls，这里按需求使用 L.env.acls；环境里没有 acls 时
 * 保守返回 false，宁可少显示编辑按钮也不把写入口暴露给只读用户。
 */
function aclValues() {
	var env = (typeof L != 'undefined' && L != null) ? L.env : null;

	if (env == null || env.acls == null)
		return null;

	var a = env.acls;

	if (Array.isArray(a))
		return a.map(function(v) { return '' + v; });

	if (typeof a == 'string')
		return a.split(/[\s,]+/);

	if (typeof a == 'object') {
		/* 兼容 { "<group>": {...} }、{ "access-group": { "<group>": true } }，
		   以及 { "access-group": [ "<group>" ] } 三种常见形态。 */
		var group = a['access-group'];

		if (Array.isArray(group))
			return group.map(function(v) { return '' + v; });

		if (group != null && typeof group == 'object')
			return Object.keys(group);

		return Object.keys(a);
	}

	return null;
}

function isAdmin() {
	var acls = aclValues();

	if (acls != null)
		return acls.indexOf(ADMIN_ACL) >= 0;

	/* 标准 LuCI 不一定注入 acls；status.can_manage 只返回布尔能力，不泄密。 */
	return typeof L != 'undefined' && L.env != null && L.env.trafficStatsCanManage === true;
}

/*
 * 后端成功但返回值与提交值不同 → 说明被 clean_text() 截断/清理了。
 * 把 dev 更新为后端真实值，并生成给用户看的警告；不要在同一轮里说“已保存”
 * 却继续显示提交前的完整字符串。
 */
function applyMetaResult(dev, res, submittedAlias, submittedGroup) {
	var alias = (res != null && res.alias != null) ? ('' + res.alias) : '';
	var group = (res != null && res.group != null) ? ('' + res.group) : '';
	var parts = [];

	dev.alias = alias;
	dev.group = group;

	if (!alias.length) delete dev.alias;
	if (!group.length) delete dev.group;

	if (alias !== submittedAlias)
		parts.push(_('别名') + _('实际保存为') + '「' + alias + '」');

	if (group !== submittedGroup)
		parts.push(_('分组') + _('实际保存为') + '「' + group + '」');

	if (!parts.length)
		return { alias: alias, group: group, truncated: false, warning: '' };

	return {
		alias: alias,
		group: group,
		truncated: true,
		warning: _('后端只保存了截断后的值（单字段上限 ') + DEVICE_TEXT_MAX +
			_(' 字节 UTF-8）：') + parts.join(_('；')) +
			_('。页面显示的是后端实际保存的值。')
	};
}

/*
 * 单设备配额（SPEC §10.2）：quota_limit 只在 mode=device 且配额 > 0 时出现。
 * 返回 null 表示“不适用”，渲染成 —，绝不做除零。
 */
function deviceQuota(dev) {
	var limit = num(dev != null ? dev.quota_limit : 0);

	if (!(limit > 0)) return null;

	var used = monthTotal(dev);
	var remaining = limit - used;
	var pct = Math.min(100, Math.max(0, used * 100 / limit));

	return { limit: limit, used: used, remaining: remaining, pct: pct };
}

/* 全屋月配额（mode=total 时后端给 quota.total_limit）。 */
function totalQuota(state) {
	var quota = (state != null && state.quota != null && typeof state.quota == 'object') ? state.quota : {};
	var limit = num(quota.total_limit);

	if (!(limit > 0)) return null;

	var used = num(state != null && state.totals != null ? state.totals.month_total : 0);
	var remaining = limit - used;

	return {
		limit: limit,
		used: used,
		remaining: remaining,
		pct: Math.min(100, Math.max(0, used * 100 / limit)),
		period: '' + (quota.period || '')
	};
}

/* 配额条：颜色只表达“用了多少”，不是健康判定。 */
function quotaLook(pct) {
	if (pct >= 90) return '#c62828';
	if (pct >= 75) return '#ef6c00';

	return '#2b7de9';
}

/* 导出状态/提示共用：不写 HTML 字符串，只改 textContent。 */
function nodeText(node, text, color) {
	if (node == null) return;

	node.textContent = (text == null) ? '' : ('' + text);
	node.style.color = color || '';
}

function clearNode(node) {
	if (node == null) return;

	while (node.firstChild)
		node.removeChild(node.firstChild);
}

/* 这个页面的表格在窄屏隐藏次要列并允许容器内横向滚动；CSS 只作用于本页容器。 */
var CSS = [
	'#ts-devices .tsd-tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
	'#ts-devices table{min-width:1080px}',
	'#ts-devices .tsd-sub{font-size:11px;opacity:.65;line-height:1.5;white-space:nowrap}',
	/* 主机名列：类型图标（圆形底 + 24px SVG）+ 名称/厂商/子信息；图标固定宽度，不挤名称。 */
	'#ts-devices .tsd-host{display:flex;align-items:flex-start;gap:8px;min-width:190px}',
	'#ts-devices .tsd-host-text{min-width:0;flex:1 1 auto}',
	'#ts-devices .tsd-kind{display:flex;align-items:center;justify-content:center;flex:0 0 auto;',
	'width:30px;height:30px;border-radius:50%;box-sizing:border-box}',
	'#ts-devices .tsd-vendor{font-size:11px;line-height:1.5;opacity:.72;margin-top:1px;',
	'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
	'#ts-devices .tsd-alias-name{font-weight:600;word-break:break-word}',
	'#ts-devices .tsd-edit{padding:1px 7px;font-size:11px;line-height:1.6;margin-left:6px;white-space:nowrap}',
	'#ts-devices .tsd-new{display:inline-block;margin-left:5px;padding:0 5px;border-radius:6px;font-size:10px;',
	'line-height:1.6;background:rgba(198,40,40,.14);color:#c62828;vertical-align:middle}',
	'#ts-devices .tsd-quota{min-width:92px;text-align:right}',
	'#ts-devices .tsd-seg{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px 0}',
	'#ts-devices .tsd-seg-btn{font:inherit;font-size:12.5px;line-height:1.5;padding:5px 12px;border-radius:15px;',
	'cursor:pointer;color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.35)}',
	'#ts-devices .tsd-seg-btn.tsd-on{background:#2b7de9;border-color:#2b7de9;color:#fff}',
	'#ts-devices .tsd-sum{font-size:12px;opacity:.85;line-height:1.8;margin:0 0 8px 0}',
	'#ts-devices .tsd-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px 0}',
	'#ts-devices .tsd-search{font:inherit;font-size:12.5px;padding:4px 8px;min-width:0;flex:1 1 180px;max-width:280px;',
	'border:1px solid rgba(127,127,127,.4);border-radius:6px;background:transparent;color:inherit}',
	'#ts-devices .tsd-select{font:inherit;font-size:12.5px;padding:4px 6px;border-radius:6px;',
	'border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit}',
	'#ts-devices .tsd-alert{padding:8px 12px;border-radius:8px;background:rgba(198,40,40,.12);color:#c62828;',
	'font-size:12.5px;line-height:1.6;margin:0 0 10px 0}',
	'#ts-devices .tsd-empty{padding:14px 16px;border:1px dashed rgba(127,127,127,.4);border-radius:10px;',
	'font-size:13px;line-height:1.8;margin:10px 0 0 0}',
	'#ts-devices .tsd-sort{font:inherit;font-weight:inherit;color:inherit;background:none;border:0;padding:0;',
	'margin:0;cursor:pointer;white-space:nowrap}',
	'#ts-devices .tsd-arrow{display:inline-block;min-width:9px;margin-left:3px;font-size:10px;opacity:.55}',
	'#ts-devices .tsd-arrow.tsd-arrow-on{opacity:1;color:#2b7de9}',
	'#ts-devices .tsd-appbtn{font:inherit;font-size:11px;line-height:1.6;padding:0 5px;margin-right:4px;',
	'border:1px solid rgba(127,127,127,.4);border-radius:5px;background:transparent;color:inherit;cursor:pointer}',
	'#ts-devices .tsd-detail-btn{white-space:nowrap}',
	'#ts-devices .tsd-pill{display:inline-block;font-size:11px;line-height:1.7;padding:1px 9px;border-radius:10px;',
	'white-space:nowrap;font-weight:600}',
	'#ts-devices .tsd-pill-on{background:rgba(76,175,80,.18);color:#2e7d32}',
	'#ts-devices .tsd-pill-off{background:rgba(127,127,127,.2);color:#616161}',
	'.tsd-drawer-overlay{position:fixed;inset:0;z-index:10000;display:flex;justify-content:flex-end;',
	'background:rgba(0,0,0,.42)}',
	'.tsd-drawer-panel{width:440px;max-width:100%;height:100%;box-sizing:border-box;overflow:auto;',
	'background:var(--background-color-high,#fff);color:var(--text-color,#222);padding:16px 18px 24px 18px;',
	'box-shadow:-12px 0 32px rgba(0,0,0,.24);transform:translateX(100%);transition:transform .22s ease;',
	'will-change:transform}',
	'.tsd-drawer-close{float:right;width:32px;height:32px;padding:0;font:inherit;font-size:20px;line-height:1;',
	'border-radius:50%;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}',
	'.tsd-drawer-h{font-size:17px;font-weight:600;line-height:1.4;margin:0 0 2px 0;padding-right:38px;',
	'word-break:break-word}',
	'.tsd-drawer-sub{font-size:12px;opacity:.7;line-height:1.6;margin:0 0 8px 0;word-break:break-all}',
	'.tsd-drawer-sec{margin:16px 0 0 0}',
	'.tsd-drawer-sec h5{font-size:12.5px;font-weight:600;margin:0 0 8px 0;opacity:.8}',
	'.tsd-info{display:grid;grid-template-columns:86px minmax(0,1fr);gap:6px 10px;font-size:12.5px;line-height:1.55}',
	'.tsd-info-k{opacity:.65}',
	'.tsd-info-v{word-break:break-all}',
	'.tsd-drawer-bar{height:7px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden;margin:4px 0 2px 0}',
	'.tsd-drawer-bar>div{height:7px;border-radius:4px}',
	'.tsd-drawer-apps{width:100%;border-collapse:collapse;font-size:12px}',
	'.tsd-drawer-apps td{padding:3px 4px;vertical-align:middle}',
	'.tsd-drawer-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}',
	'.tsd-drawer-code{font-size:11px;line-height:1.6;background:rgba(127,127,127,.12);padding:8px;border-radius:6px;',
	'white-space:pre-wrap;word-break:break-all;margin:6px 0 0 0}',
	'.tsd-drawer-note{font-size:11.5px;opacity:.7;line-height:1.6;margin:6px 0 0 0}',
	'@media (max-width:760px){',
	'#ts-devices .tsd-opt{display:none}',
	'#ts-devices table{min-width:620px}',
	'#ts-devices .tsd-tablewrap{overflow-x:auto}',
	'#ts-devices .tsd-host{min-width:160px}',
	'#ts-devices .tsd-vendor{max-width:150px}',
	'.tsd-drawer-panel{width:100%;max-width:100%;padding:14px}',
	'}'
].join('\n');

function appLabel(host) {
	var name = (host == null) ? '' : ('' + host);

	if (name == '__other__') return _('其他（合并）');

	return name;
}

function shorten(text, max) {
	var s = '' + (text == null ? '' : text);

	if (s.length <= max) return s;

	return s.substring(0, max - 1) + '…';
}

function chainBadge(chain) {
	var name = (chain && ('' + chain).length) ? ('' + chain) : '—';
	var direct = (name == 'DIRECT');
	var bg = direct ? 'rgba(76,175,80,.2)' : 'rgba(43,125,233,.2)';

	return E('span', {
		style: 'font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap;background:' + bg
	}, name);
}

/* ---- 接入方式（无线 / 有线 / 未知，来自主路由的桥 FDB，与代理/直连无关）---- */

var LINK_STYLE = {
	wifi: { label: '无线', color: '#7b1fa2', bg: 'rgba(123,31,162,.16)' },
	wired: { label: '有线', color: '#00838f', bg: 'rgba(0,131,143,.16)' },
	unknown: { label: '未知', color: '#9e9e9e', bg: 'rgba(158,158,158,.2)' }
};

/* 后端每次都会给 link；字段缺失（老 state.json）时返回 ''，表格里显示 "-"。 */
function linkOf(dev) {
	if (dev == null || typeof dev.link != 'string') return '';

	var v = dev.link.toLowerCase();

	return (v == 'wifi' || v == 'wired' || v == 'unknown') ? v : '';
}

/* ---- 设备识别：OUI 厂商 + 设备类型（纯本地查表，不联网、不新增 RPC）---- */

/*
 * 常见厂商 OUI（MAC 前 3 字节）。只收 IEEE 真实分配块，键统一为小写冒号格式；
 * 查不到（含随机 MAC）就返回 ''，由调用方显示「未知厂商」。
 */
var OUI_TABLE = {
	'00:00:DD': 'TCL',
	'00:05:B5': '博通',
	'00:0C:E7': '联发科',
	'00:0E:1F': 'TCL',
	'00:10:18': '博通',
	'00:11:32': '群晖',
	'00:15:EB': '中兴',
	'00:16:7A': '创维',
	'00:17:88': '飞利浦',
	'00:1A:11': 'Google',
	'00:1A:95': '海信',
	'00:1A:9A': '创维',
	'00:1B:21': 'Intel',
	'00:22:DE': 'OPPO',
	'00:66:4B': '华为',
	'00:74:9C': '锐捷',
	'00:A0:C6': '高通',
	'00:CA:E0': 'OPPO',
	'00:E0:4C': 'Realtek',
	'04:79:75': '荣耀',
	'04:D4:C4': '华硕',
	'08:67:4E': '海信',
	'0C:90:43': 'realme',
	'0C:96:BF': '华为',
	'10:D5:61': '涂鸦',
	'10:F9:6F': 'LG',
	'14:FE:B5': '戴尔',
	'18:69:D8': '涂鸦',
	'18:DB:F2': '戴尔',
	'1C:F2:9A': 'Google',
	'20:4E:7F': '网件',
	'24:0A:C4': 'Espressif',
	'24:A4:3C': 'Ubiquiti',
	'28:18:78': '微软',
	'2C:56:DC': '华硕',
	'2C:CF:67': 'Raspberry Pi',
	'30:19:66': '三星',
	'30:AE:A4': 'Espressif',
	'30:F9:ED': '索尼',
	'34:13:E8': 'Intel',
	'34:23:BA': '三星',
	'3C:07:54': 'Apple',
	'3C:5A:B4': 'Google',
	'3C:D9:2B': '惠普',
	'3C:EF:8C': '大华',
	'40:D4:F6': '荣耀',
	'44:19:B6': '海康威视',
	'44:65:0D': 'Amazon',
	'48:46:FB': '华为',
	'48:A6:B8': 'Sonos',
	'4C:11:BF': '大华',
	'50:2B:73': 'Tenda',
	'50:C7:BF': 'TP-Link',
	'54:60:09': 'Google',
	'58:A2:B5': 'LG',
	'58:BD:A3': '任天堂',
	'5C:AA:FD': 'Sonos',
	'5C:CF:7F': 'Espressif',
	'64:CC:2E': '小米',
	'64:EC:65': 'vivo',
	'68:54:FD': 'Amazon',
	'68:57:2D': '涂鸦',
	'68:F7:28': '联想',
	'6C:40:08': 'Apple',
	'6C:D1:99': 'vivo',
	'70:54:F5': '华为',
	'70:5A:0F': '惠普',
	'74:75:48': 'Amazon',
	'78:84:3C': '索尼',
	'78:8A:20': 'Ubiquiti',
	'7C:1D:D9': '小米',
	'7C:1E:52': '微软',
	'80:BE:05': 'Apple',
	'84:F3:EB': 'Espressif',
	'88:DE:A9': 'Roku',
	'8C:16:45': '联想',
	'8C:77:12': '三星',
	'8C:BE:BE': '小米',
	'8C:FD:F0': '高通',
	'90:02:A9': '大华',
	'90:09:D0': '群晖',
	'94:57:A5': '惠普',
	'94:65:2D': '一加',
	'98:B6:E9': '任天堂',
	'9C:99:A0': '小米',
	'A0:40:A0': '网件',
	'A4:2B:B0': 'TP-Link',
	'A4:83:E7': 'Apple',
	'A8:16:B2': 'LG',
	'AC:E2:15': '华为',
	'B0:83:FE': '戴尔',
	'B4:3A:28': '三星',
	'B8:27:EB': 'Raspberry Pi',
	'BC:46:99': 'TP-Link',
	'BC:92:6B': 'Apple',
	'BC:AD:28': '海康威视',
	'C0:3F:0E': '网件',
	'C0:56:E3': '海康威视',
	'C0:EE:FB': '一加',
	'C4:6E:1F': 'TP-Link',
	'C8:19:F7': '三星',
	'C8:3A:35': 'Tenda',
	'C8:7B:5B': '中兴',
	'CC:6D:A0': 'Roku',
	'D8:31:34': 'Roku',
	'DC:A6:32': 'Raspberry Pi',
	'E4:5F:01': 'Raspberry Pi',
	'E8:94:F6': 'TP-Link',
	'EC:B5:FA': '飞利浦',
	'F0:18:98': 'Apple',
	'F0:27:2D': 'Amazon',
	'F0:9F:C2': 'Ubiquiti',
	'F0:B4:29': '小米',
	'F4:29:81': 'vivo',
	'F4:F5:E8': 'Google',
	'F8:59:71': 'Intel',
	'F8:E0:79': '摩托罗拉',
	'FC:0F:E6': '索尼',
	'FC:59:9F': '锐捷',
};

/* MAC 归一化成小写冒号格式；非法返回 ''（兼容 aa-bb-cc、aabb.ccdd.eeff、12 位裸串）。 */
function normalizeMac(mac) {
	var s = (mac == null) ? '' : ('' + mac).trim().toLowerCase();

	if (!s.length) return '';

	s = s.replace(/-/g, ':').replace(/\./g, '');

	if (/^[0-9a-f]{12}$/.test(s))
		s = s.substr(0, 2) + ':' + s.substr(2, 2) + ':' + s.substr(4, 2) + ':' +
			s.substr(6, 2) + ':' + s.substr(8, 2) + ':' + s.substr(10, 2);

	if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return '';

	return s;
}

/* 第 0 位组播、第 1 位本地管理：任一为 1 就不是厂商烧录的全球唯一地址（随机/虚拟 MAC）。 */
function isRandomMac(mac) {
	var norm = normalizeMac(mac);

	if (!norm.length) return false;

	return (parseInt(norm.substr(0, 2), 16) & 0x03) !== 0;
}

/* 未知厂商返回 ''；随机 MAC 一律不认厂商，避免把 02/06/0A/0E 这类地址误判成某家厂商。 */
function vendorOf(mac) {
	var norm = normalizeMac(mac);

	if (!norm.length || isRandomMac(norm)) return '';

	var oui = norm.substr(0, 8);

	/* 表键按 IEEE 习惯写成大写；归一后的小写 MAC 在这里再转成表键大小写，两种写法都能查。 */
	if (!Object.prototype.hasOwnProperty.call(OUI_TABLE, oui))
		oui = oui.toUpperCase();

	return Object.prototype.hasOwnProperty.call(OUI_TABLE, oui) ? OUI_TABLE[oui] : '';
}

/* 与语言环境无关的字符串排序：统一小写后按码点比较，刷新/测试结果稳定。 */
function compareText(a, b) {
	var x = ('' + (a == null ? '' : a)).toLowerCase();
	var y = ('' + (b == null ? '' : b)).toLowerCase();

	return (x < y) ? -1 : ((x > y) ? 1 : 0);
}

/* 厂商筛选用的键：识别不出统一归到 VENDOR_UNKNOWN，和「未知厂商」分组一致。 */
var VENDOR_UNKNOWN = '__unknown__';

function vendorKeyOf(dev) {
	var name = vendorOf(dev != null ? dev.mac : '');

	return name.length ? name : VENDOR_UNKNOWN;
}

function vendorLabelOf(dev) {
	var name = vendorOf(dev != null ? dev.mac : '');

	return name.length ? name : _('未知厂商');
}

function matchesVendorFilter(dev, filter) {
	if (filter == null || !filter.length) return true;

	return vendorKeyOf(dev) === filter;
}

/* ---- 设备类型：hostname/alias 关键词推断（短词用边界匹配，mini 不会命中 mi）---- */

var DEVICE_KIND_LABELS = {
	phone: '手机',
	laptop: '电脑',
	tv: '电视',
	tablet: '平板',
	iot: '智能设备',
	unknown: '未知'
};

/* 关键词按优先级排列：平板 → 电视 → 电脑 → 手机 → 智能设备，先命中先返回。 */
var DEVICE_KIND_HINTS = [
	[ 'tablet', [ 'ipad', 'tablet', 'pad' ] ],
	[ 'tv', [ 'tv', 'tvbox', 'smarttv', 'androidtv', 'firetv', 'appletv', 'apple tv',
		'chromecast', 'roku', 'bravia', 'shield', 'mitv' ] ],
	[ 'laptop', [ 'pc', 'laptop', 'notebook', 'macbook', 'imac', 'mac', 'thinkpad',
		'desktop', 'workstation', 'linux', 'windows', 'win' ] ],
	[ 'phone', [ 'iphone', 'ipod', 'phone', 'mobile', 'smartphone', 'android', 'galaxy',
		'pixel', 'redmi', 'xiaomi', 'huawei', 'honor', 'samsung', 'oneplus', 'oppo',
		'vivo', 'realme', 'meizu', 'mi' ] ],
	[ 'iot', [ 'esp', 'esp32', 'esp8266', 'esphome', 'tasmota', 'shelly', 'camera',
		'speaker', 'echo', 'homepod', 'bulb', 'plug', 'iot', 'sensor', 'socket',
		'light', 'lamp', 'doorbell', 'thermostat', 'vacuum', 'robot', 'watch',
		'band', 'printer', 'nas' ] ]
];

/*
 * 前后都必须是非字母数字（结尾也算），所以 pc 不会命中 optimize，
 * mi 不会命中 mini，tv 不会命中 smarttv 以外的词（smarttv 单独收录）。
 */
function hasKindWord(text, word) {
	var t = ('' + (text == null ? '' : text)).toLowerCase();
	var w = ('' + (word == null ? '' : word)).toLowerCase();

	if (!t.length || !w.length) return false;

	var from = 0;

	while (from <= t.length) {
		var at = t.indexOf(w, from);

		if (at < 0) return false;

		var before = (at > 0) ? t.charAt(at - 1) : '';
		var after = t.charAt(at + w.length);

		if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;

		from = at + 1;
	}

	return false;
}

function deviceKindOf(dev) {
	var text = ((dev != null && dev.hostname != null) ? ('' + dev.hostname) : '') + ' ' +
		((dev != null && dev.alias != null) ? ('' + dev.alias) : '');

	for (var i = 0; i < DEVICE_KIND_HINTS.length; i++) {
		var words = DEVICE_KIND_HINTS[i][1];

		for (var j = 0; j < words.length; j++) {
			if (hasKindWord(text, words[j])) return DEVICE_KIND_HINTS[i][0];
		}
	}

	return 'unknown';
}

function deviceKindLabel(kind) {
	return _(DEVICE_KIND_LABELS[kind] || DEVICE_KIND_LABELS.unknown);
}

/* 6 个 24px 线性图标，只用 rect/path/circle，全部 createElementNS 生成，不拼字符串。 */
var SVG_NS = 'http://www.w3.org/2000/svg';

var DEVICE_KIND_SHAPES = {
	phone: [
		[ 'rect', { x: '7', y: '2.3', width: '10', height: '19.4', rx: '2.4' } ],
		[ 'path', { d: 'M10.6 18.4h2.8' } ]
	],
	laptop: [
		[ 'rect', { x: '3.2', y: '5', width: '17.6', height: '11', rx: '1.6' } ],
		[ 'path', { d: 'M2 19.4h20' } ]
	],
	tv: [
		[ 'rect', { x: '3', y: '6.2', width: '18', height: '11.6', rx: '1.8' } ],
		[ 'path', { d: 'M8.4 21h7.2M9.4 3.2l2.6 3 2.6-3' } ]
	],
	tablet: [
		[ 'rect', { x: '4.4', y: '3', width: '15.2', height: '18', rx: '2.2' } ],
		[ 'path', { d: 'M10.8 18.2h2.4' } ]
	],
	iot: [
		[ 'rect', { x: '6.2', y: '2.6', width: '11.6', height: '18.8', rx: '3.2' } ],
		[ 'path', { d: 'M9 6.6h6' } ],
		[ 'circle', { cx: '12', cy: '14.2', r: '2.8' } ]
	],
	unknown: [
		[ 'circle', { cx: '12', cy: '12', r: '8.6' } ],
		[ 'path', { d: 'M9.6 9.5a2.6 2.6 0 0 1 4.9.9c0 1.7-2.5 1.9-2.5 3.5' } ],
		[ 'circle', { cx: '12', cy: '17.2', r: '0.9' } ]
	]
};

function deviceKindSvg(kind, color) {
	var svg = document.createElementNS(SVG_NS, 'svg');
	var shapes = DEVICE_KIND_SHAPES[kind] || DEVICE_KIND_SHAPES.unknown;

	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', color || 'currentColor');
	svg.setAttribute('stroke-width', '1.6');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');

	for (var i = 0; i < shapes.length; i++) {
		var node = document.createElementNS(SVG_NS, shapes[i][0]);
		var attrs = shapes[i][1] || {};

		for (var name in attrs) {
			if (Object.prototype.hasOwnProperty.call(attrs, name))
				node.setAttribute(name, attrs[name]);
		}

		svg.appendChild(node);
	}

	return svg;
}

/* ---- 无线信号（来自哑桥 AP 的元数据，按 MAC 索引）---- */

function indexStations(payload) {
	var map = {};

	if (payload == null || !Array.isArray(payload.stations)) return map;

	for (var i = 0; i < payload.stations.length; i++) {
		var st = payload.stations[i];

		if (st == null || typeof st.mac != 'string' || st.mac.length == 0) continue;

		var key = st.mac.toLowerCase();

		if (map[key] == null) map[key] = st;
	}

	return map;
}

function stationFor(map, dev) {
	if (map == null || dev == null || typeof dev.mac != 'string' || dev.mac.length == 0) return null;

	return map[dev.mac.toLowerCase()] || null;
}

/* 分级：>-60 绿、-60~-75 黄、<-75 红。 */
function signalColor(dbm) {
	if (dbm > -60) return '#2e7d32';
	if (dbm >= -75) return '#f0a020';

	return '#d3302f';
}

/* ---- 商用路由器 App 式浏览：分段 / 排序 / 详情抽屉 / 自动刷新 ---- */

/* 在线口径与概览、移动端一致：last_seen > 0 且距今 ≤ 10 分钟（未来时间戳留 60s 容差）。 */
var ONLINE_SEC = 600;
var REFRESH_MS = 15000;

function nowSec() {
	return Math.floor(Date.now() / 1000);
}

function isDeviceOnline(dev, now) {
	var ls = num(dev != null ? dev.last_seen : 0);
	var t = (now == null) ? nowSec() : num(now);

	return ls > 0 && ls <= t + 60 && (t - ls) <= ONLINE_SEC;
}

/* 表头排序的取值：与列表里显示的字节 / 速率 / 厂商列一一对应。 */
function sortMetric(dev, key) {
	if (key === 'direct') return num(dev.direct_rx) + num(dev.direct_tx);
	if (key === 'proxy') return num(dev.proxy_rx) + num(dev.proxy_tx);
	if (key === 'rate') return num(dev.rx_rate) + num(dev.tx_rate);
	if (key === 'last_seen') return num(dev.last_seen);
	/* 厂商列是字符串，排序统一走 compareText（compareDevices 里按类型分支）。 */
	if (key === 'vendor') return vendorSortName(dev);

	return deviceTotal(dev);
}

/* 未识别厂商也参与排序，用「未知厂商」这个名字，避免空串全排到最前面。 */
function vendorSortName(dev) {
	var name = vendorOf(dev != null ? dev.mac : '');

	return name.length ? name : _('未知厂商');
}

/* 搜索覆盖主机名 / 别名 / 分组 / IP / MAC；大小写不敏感。 */
function deviceMatches(dev, q) {
	if (q == null || !q.length) return true;

	var fields = [
		dev != null ? dev.hostname : '', dev != null ? dev.alias : '',
		dev != null ? dev.group : '', dev != null ? dev.ip : '',
		dev != null ? dev.mac : '', deviceName(dev)
	];

	for (var i = 0; i < fields.length; i++) {
		if (fields[i] != null && ('' + fields[i]).toLowerCase().indexOf(q) >= 0)
			return true;
	}

	return false;
}

/* 接入筛选：unknown 同时收「未知」和字段缺失（老后端没有 link）。 */
function matchesLinkFilter(dev, filter) {
	if (filter == null || !filter.length) return true;

	var kind = linkOf(dev);

	if (filter === 'unknown')
		return kind === '' || kind === 'unknown';

	return kind === filter;
}

/* 应用分布：按该设备流量降序；抽屉取前 10，展开行仍显示全部。 */
function deviceAppList(dev) {
	var apps = (dev != null && dev.apps != null && typeof dev.apps === 'object') ? dev.apps : {};
	var list = [];

	for (var host in apps) {
		if (!apps.hasOwnProperty(host)) continue;

		var row = (apps[host] != null && typeof apps[host] === 'object') ? apps[host] : {};
		var rx = num(row.rx);
		var tx = num(row.tx);

		list.push({
			host: host,
			rx: rx,
			tx: tx,
			total: rx + tx,
			chain: row.chain ? ('' + row.chain) : ''
		});
	}

	list.sort(function(a, b) { return b.total - a.total; });

	return list;
}

function appListTotal(list) {
	var sum = 0;

	for (var i = 0; i < (list || []).length; i++)
		sum += num(list[i].total);

	return sum;
}

/* 单设备 CSV：后端 export_csv 只支持整页 devices，这里按后端同样的列拼一行由前端下载。 */
var DEVICE_CSV_HEADER = [ '主机名', 'IP', 'MAC', '别名', '分组', '接入',
	'直连下载', '直连上传', '代理下载', '代理上传', '合计',
	'本月下载', '本月上传', '本月合计', '首次出现' ];

function csvField(value) {
	var s = (value == null) ? '' : ('' + value);

	if (/[",\r\n]/.test(s))
		return '"' + s.replace(/"/g, '""') + '"';

	return s;
}

function deviceCsv(dev) {
	var link = LINK_STYLE[linkOf(dev)];
	var known = monthAvailable(dev);
	var row = [
		dev.hostname, dev.ip, macKey(dev), aliasOf(dev), groupOf(dev),
		(link != null) ? link.label : '—',
		num(dev.direct_rx), num(dev.direct_tx), num(dev.proxy_rx), num(dev.proxy_tx),
		deviceTotal(dev),
		known ? num(dev.month_rx) : '', known ? num(dev.month_tx) : '',
		known ? monthTotal(dev) : '',
		num(dev.first_seen) > 0 ? fmtDate(dev.first_seen) : ''
	];

	return '\ufeff' + DEVICE_CSV_HEADER.map(csvField).join(',') + '\r\n' +
		row.map(csvField).join(',') + '\r\n';
}

function deviceCsvFilename(dev) {
	var now = new Date();
	var tag = macKey(dev).replace(/[^A-Za-z0-9]/g, '') ||
		(('' + (dev != null && dev.ip ? dev.ip : '')).replace(/[^A-Za-z0-9]/g, '')) || 'device';

	return 'traffic-stats-device-' + tag + '-' + now.getFullYear() + '-' +
		pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + '.csv';
}

/* 阻断建议：与概览页同一段只读 nft 文本，只显示不执行。 */
function blockCommand(mac) {
	return 'nft add rule inet fw4 forward ether saddr ' + mac + ' counter drop';
}

function nextFrame(fn) {
	if (typeof window != 'undefined' && typeof window.requestAnimationFrame == 'function')
		window.requestAnimationFrame(fn);
	else if (typeof window != 'undefined' && typeof window.setTimeout == 'function')
		window.setTimeout(fn, 0);
	else
		fn();
}

return view.extend({
	/*
	 * 概览页「Top 设备」链接带 #mac=<编码 MAC>：渲染后自动打开该设备抽屉，
	 * 然后清掉 hash，避免刷新/切回时重复弹出。只认合法 MAC，其余忽略。
	 */
	applyHashTarget: function() {
		var self = this;
		var hash = (typeof window != 'undefined' && window.location != null)
			? ('' + (window.location.hash || '')) : '';
		var m = /^#mac=(.+)$/.exec(hash);

		if (m == null) return;

		var want = '';

		try { want = decodeURIComponent(m[1]); } catch (e) { want = m[1]; }

		want = ('' + want).replace(/-/g, ':').toUpperCase();

		if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(want)) return;

		window.setTimeout(function() {
			var list = (self.state != null && Array.isArray(self.state.devices)) ? self.state.devices : [];

			for (var i = 0; i < list.length; i++) {
				if (macKey(list[i]) === want) { self.openDrawer(list[i]); break; }
			}

			try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { }
		}, 0);
	},

	load: function() {
		var self = this;

		return Promise.all([
			callCapability().then(function(cap) {
				if (cap != null && typeof cap.can_manage == 'boolean')
					L.env.trafficStatsCanManage = cap.can_manage;
			}).catch(function() { }),
			callState().then(function(state) {
				self.state = (state != null && typeof state == 'object' && state.totals != null) ? state : null;
				self.error = null;
			}).catch(function(err) {
				self.state = null;
				self.error = (err != null && err.message) ? err.message : '' + err;
			}),

			/* 站点元数据是锦上添花：后端没有这个接口 / 没有 AP 上报时退回空表，
			   设备页照旧可用（信号列全部显示 "-"）。 */
			callStations().then(function(payload) {
				self.stations = indexStations(payload);
			}).catch(function() {
				self.stations = {};
			})
		]);
	},

	render: function() {
		var self = this;

		this.drafts = this.drafts || {};
		this.dialog = null;
		this.aliasCells = {};
		if (this.timer != null) this.stopRefresh();
		if (this.drawerOverlay != null) this.closeDrawer();
		this.segment = (this.segment === 'online' || this.segment === 'offline') ? this.segment : 'all';
		this.sortKey = this.sortKey || 'total';
		this.sortDir = (this.sortDir === 'asc') ? 'asc' : 'desc';
		this.search = (typeof this.search === 'string') ? this.search : '';
		this.linkFilter = (typeof this.linkFilter === 'string') ? this.linkFilter : '';
		this.vendorFilter = (typeof this.vendorFilter === 'string') ? this.vendorFilter : '';
		this.vendorSig = null;
		this.paused = (this.paused === true);
		this.refreshError = null;
		this.sortArrows = {};
		this.sortHeads = {};
		this.segmentBtns = {};
		this.exportStatus = E('span', { style: 'font-size:12px;opacity:.85' }, '');

		this.alertBox = E('div', { 'class': 'tsd-alert', style: 'display:none' }, '');
		this.summaryNode = E('div', { 'class': 'tsd-sum' }, '');

		var segDefs = [ [ 'all', _('全部') ], [ 'online', _('在线') ], [ 'offline', _('离线') ] ];
		var segChildren = [];

		for (var s = 0; s < segDefs.length; s++) {
			(function(key, label) {
				var btn = E('button', {
					'class': 'tsd-seg-btn',
					type: 'button',
					'aria-pressed': 'false',
					click: function(ev) {
						if (ev != null && ev.preventDefault) ev.preventDefault();
						self.setSegment(key);
					}
				}, label);

				self.segmentBtns[key] = btn;
				segChildren.push(btn);
			})(segDefs[s][0], segDefs[s][1]);
		}

		var segmentBox = E('div', { 'class': 'tsd-seg' }, segChildren);

		/* 搜索只过滤内存里的 state.devices，不发 RPC。 */
		this.searchInput = E('input', {
			'class': 'tsd-search',
			type: 'search',
			placeholder: _('搜索主机名 / 别名 / 分组 / IP / MAC'),
			'aria-label': _('搜索设备')
		});
		this.searchInput.value = this.search;
		this.searchInput.addEventListener('input', function(ev) {
			var v = (ev != null && ev.target != null) ? ev.target.value : self.searchInput.value;

			self.search = ('' + (v == null ? '' : v)).trim().toLowerCase();
			self.renderRows();
		});

		this.linkSelect = E('select', {
			'class': 'tsd-select',
			'aria-label': _('接入方式筛选')
		}, [
			E('option', { value: '' }, _('全部接入')),
			E('option', { value: 'wifi' }, _('无线')),
			E('option', { value: 'wired' }, _('有线')),
			E('option', { value: 'unknown' }, _('未知'))
		]);
		this.linkSelect.value = this.linkFilter;
		this.linkSelect.addEventListener('change', function(ev) {
			var v = (ev != null && ev.target != null) ? ev.target.value : self.linkSelect.value;

			self.linkFilter = ('' + (v == null ? '' : v));
			self.renderRows();
		});

		/* 厂商筛选：选项来自当前 state.devices 的识别结果，全部本地过滤，不发 RPC。 */
		this.vendorSelect = E('select', {
			'class': 'tsd-select',
			'aria-label': _('厂商筛选')
		}, E('option', { value: '' }, _('全部厂商')));
		this.vendorSelect.addEventListener('change', function(ev) {
			var v = (ev != null && ev.target != null) ? ev.target.value : self.vendorSelect.value;

			self.vendorFilter = ('' + (v == null ? '' : v));
			self.renderRows();
		});

		this.refreshBtn = E('button', {
			'class': 'cbi-button',
			type: 'button',
			click: ui.createHandlerFn(this, function() { this.toggleRefresh(); })
		}, _('暂停刷新'));
		this.refreshHint = E('span', { style: 'font-size:11.5px;opacity:.7' }, '');

		var toolbar = E('div', { 'class': 'tsd-toolbar' }, [
			this.searchInput,
			this.linkSelect,
			this.vendorSelect,
			E('button', {
				'class': 'cbi-button cbi-button-action',
				type: 'button',
				click: ui.createHandlerFn(this, function() { return this.exportCsv('devices'); })
			}, _('导出设备 CSV')),
			this.refreshBtn,
			this.refreshHint,
			this.exportStatus
		]);

		var head = E('tr', { 'class': 'tr table-titles' }, [
			this.sortHead('vendor', _('主机名 / 厂商'),
				_('设备名称在图标右侧，小字为按 MAC 前 3 字节（OUI）识别的厂商；点击按厂商名排序'), 'left'),
			E('th', { 'class': 'th' }, _('别名 / 分组')),
			E('th', { 'class': 'th tsd-opt', title: _('守护进程首次看到该 MAC 的时间（本地时区）') }, _('首次出现')),
			E('th', {
				'class': 'th',
				title: _('接入方式：主路由桥 FDB 里该设备 MAC 学在哪个端口（无线/有线），与代理/直连无关')
			}, _('接入')),
			this.sortHead('direct', _('直连'), _('按直连下载 + 上传排序')),
			this.sortHead('proxy', _('代理'), _('按代理下载 + 上传排序')),
			this.sortHead('total', _('合计'), _('按直连 + 代理合计排序')),
			E('th', { 'class': 'th', style: 'text-align:right', title: _('本月 1 号至今的 rx+tx（只读 daily/，跨月自动归零）') }, _('本月')),
			E('th', { 'class': 'th tsd-quota', title: _('剩余 = 配额 - 本月用量；未配置配额时显示 —') }, _('配额剩余')),
			this.sortHead('rate', _('速率'), _('按当前下载 + 上传速率排序')),
			this.sortHead('last_seen', _('上次活跃'), _('按 last_seen 时间排序')),
			E('th', {
				'class': 'th tsd-opt',
				style: 'text-align:right',
				title: _('来自哑桥 AP 的无线信号（仅元数据，不含流量）')
			}, _('信号')),
			E('th', { 'class': 'th', style: 'text-align:right' }, _('操作'))
		]);

		this.tbody = E('tbody', {}, '');
		this.tableWrap = E('div', { 'class': 'tsd-tablewrap' },
			E('table', { 'class': 'table' }, [ head, this.tbody ]));
		this.emptyBox = E('div', { 'class': 'tsd-empty', style: 'display:none' }, '');

		this.root = E('div', { 'id': 'ts-devices' }, [
			E('style', {}, CSS),
			E('h2', {}, _('流量统计 · 设备')),
			this.alertBox,
			segmentBox,
			this.summaryNode,
			toolbar,
			this.tableWrap,
			this.emptyBox
		]);

		this.renderRows();
		this.syncRefreshHint();
		this.startRefresh();

		this.applyHashTarget();

		return this.root;
	},

	sortHead: function(key, label, title, align) {
		var self = this;
		var arrow = E('span', { 'class': 'tsd-arrow' }, '');
		var th = E('th', {
			'class': 'th',
			style: 'text-align:' + (align === 'left' ? 'left' : 'right') + ';cursor:pointer',
			title: title || _('点击切换排序'),
			click: function(ev) {
				if (ev != null && ev.preventDefault) ev.preventDefault();
				self.toggleSort(key);
			}
		}, E('button', {
			'class': 'tsd-sort',
			type: 'button',
			click: function(ev) {
				if (ev != null) {
					if (ev.preventDefault) ev.preventDefault();
					/* 表头单元格本身也有 click：按钮里阻止冒泡，避免点一次排两次。 */
					if (ev.stopPropagation) ev.stopPropagation();
				}

				self.toggleSort(key);
			}
		}, [ label, arrow ]));

		this.sortArrows[key] = arrow;
		this.sortHeads[key] = th;

		return th;
	},

	toggleSort: function(key) {
		if (this.sortKey === key) {
			this.sortDir = (this.sortDir === 'desc') ? 'asc' : 'desc';
		}
		else {
			this.sortKey = key;
			/* 数值列默认从大到小，和“用量最高的设备在最上面”一致；厂商名按 A→Z / 拼音顺序。 */
			this.sortDir = (key === 'vendor') ? 'asc' : 'desc';
		}

		this.renderRows();
	},

	setSegment: function(key) {
		this.segment = (key === 'online' || key === 'offline') ? key : 'all';
		this.renderRows();
	},

	compareDevices: function(a, b) {
		var av = sortMetric(a, this.sortKey);
		var bv = sortMetric(b, this.sortKey);
		var dir = (this.sortDir === 'asc') ? 1 : -1;
		var cmp;

		if (typeof av === 'string' || typeof bv === 'string')
			cmp = compareText(av, bv);
		else
			cmp = (av < bv) ? -1 : ((av > bv) ? 1 : 0);

		if (cmp !== 0) return cmp * dir;

		var an = ('' + deviceName(a)).toLowerCase();
		var bn = ('' + deviceName(b)).toLowerCase();

		if (an !== bn) return (an < bn) ? -1 : 1;

		return ('' + (a != null ? a.mac : '')).localeCompare('' + (b != null ? b.mac : ''));
	},

	syncSegmentButtons: function(counts) {
		var labels = { all: _('全部'), online: _('在线'), offline: _('离线') };

		for (var key in this.segmentBtns) {
			if (!this.segmentBtns.hasOwnProperty(key)) continue;

			var btn = this.segmentBtns[key];
			var active = (key === this.segment);

			btn.textContent = labels[key] + ' ' + num(counts != null ? counts[key] : 0);
			btn.className = 'tsd-seg-btn' + (active ? ' tsd-on' : '');

			if (typeof btn.setAttribute == 'function')
				btn.setAttribute('aria-pressed', active ? 'true' : 'false');
		}
	},

	/*
	 * 厂商下拉：按当前 state.devices 的识别结果去重（未知厂商一项始终在最后）。
	 * 选项集合没变时只同步 value，避免刷新把用户正在选的项重建成新节点。
	 */
	syncVendorOptions: function() {
		var sel = this.vendorSelect;

		if (sel == null) return;

		var all = (this.state != null && Array.isArray(this.state.devices)) ? this.state.devices : [];
		var seen = {};
		var keys = [];
		var i;

		for (i = 0; i < all.length; i++) {
			var key = vendorKeyOf(all[i]);

			if (seen[key] !== true) {
				seen[key] = true;
				keys.push(key);
			}
		}

		keys.sort(function(a, b) {
			var an = (a === VENDOR_UNKNOWN) ? _('未知厂商') : a;
			var bn = (b === VENDOR_UNKNOWN) ? _('未知厂商') : b;

			return compareText(an, bn);
		});

		var sig = keys.join('\u0001');

		if (sig !== this.vendorSig) {
			var options = [ E('option', { value: '' }, _('全部厂商')) ];

			for (i = 0; i < keys.length; i++) {
				options.push(E('option', { value: keys[i] },
					keys[i] === VENDOR_UNKNOWN ? _('未知厂商') : keys[i]));
			}

			dom.content(sel, options);
			this.vendorSig = sig;
		}

		/* 选中的厂商已经不在列表里（设备掉线/列表刷新）时回到「全部厂商」。 */
		if (this.vendorFilter.length && seen[this.vendorFilter] !== true)
			this.vendorFilter = '';

		sel.value = this.vendorFilter;
	},

	syncSortArrows: function() {
		for (var key in this.sortArrows) {
			if (!this.sortArrows.hasOwnProperty(key)) continue;

			var arrow = this.sortArrows[key];
			var active = (key === this.sortKey);

			arrow.textContent = active ? (this.sortDir === 'asc' ? '▲' : '▼') : '↕';
			arrow.className = 'tsd-arrow' + (active ? ' tsd-arrow-on' : '');

			if (this.sortHeads[key] != null && typeof this.sortHeads[key].setAttribute == 'function')
				this.sortHeads[key].setAttribute('aria-sort',
					active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
		}
	},

	renderRows: function() {
		var self = this;
		var state = this.state;
		var all = (state != null && Array.isArray(state.devices)) ? state.devices : [];
		var now = nowSec();
		var online = 0;
		var i;

		for (i = 0; i < all.length; i++) {
			if (isDeviceOnline(all[i], now)) online++;
		}

		var offline = all.length - online;

		this.syncSegmentButtons({ all: all.length, online: online, offline: offline });
		this.syncVendorOptions();

		var monthSum = 0;
		var monthKnown = false;

		for (i = 0; i < all.length; i++) {
			if (monthAvailable(all[i])) {
				monthSum += monthTotal(all[i]);
				monthKnown = true;
			}
		}

		if (!monthKnown && state != null && state.totals != null && state.totals.month_total != null) {
			monthSum = num(state.totals.month_total);
			monthKnown = true;
		}

		var q = ('' + (this.search || '')).toLowerCase();
		var filtered = [];

		for (i = 0; i < all.length; i++) {
			if (deviceMatches(all[i], q) && matchesLinkFilter(all[i], this.linkFilter) &&
				matchesVendorFilter(all[i], this.vendorFilter))
				filtered.push(all[i]);
		}

		var rows = [];

		for (i = 0; i < filtered.length; i++) {
			var on = isDeviceOnline(filtered[i], now);

			if (this.segment === 'online' && !on) continue;
			if (this.segment === 'offline' && on) continue;

			rows.push(filtered[i]);
		}

		rows.sort(function(a, b) { return self.compareDevices(a, b); });

		var summary;

		if (state == null) {
			/* 首次读取失败：不要用 0 台冒充“没有设备”，摘要也显示不可用。 */
			summary = _('在线') + ' — · ' + _('离线') + ' — · ' + _('本月合计') + ' —';
		}
		else {
			summary = _('在线') + ' ' + online + ' · ' + _('离线') + ' ' + offline +
				' · ' + _('本月合计') + ' ' + (monthKnown ? fmtBytes(monthSum) : '—') +
				' · ' + _('共') + ' ' + all.length + ' ' + _('台设备');

			if (rows.length !== all.length)
				summary += ' · ' + _('匹配') + ' ' + rows.length + ' ' + _('台');

			if (state.truncated === true)
				summary += ' · ' + _('数据过大，后端已裁剪（仅显示使用量最高的部分）');

			if (state.running !== true)
				summary += ' · ' + _('traffic-statsd 未运行，数据可能已过期');

			/* 保留原来的「全屋本月配额」信息，但收进同一行摘要。 */
			var houseQuota = totalQuota(state);

			if (houseQuota != null)
				summary += ' · ' + _('全屋本月配额') + ' ' + _('剩余') + ' ' +
					fmtBytes(Math.max(0, houseQuota.remaining)) + ' / ' + fmtBytes(houseQuota.limit) +
					'（' + houseQuota.pct.toFixed(1) + '%）';

			summary += ' · ' + this.linkSummary(state);
			summary += _('点击设备行查看详情');
		}

		this.summaryNode.textContent = summary;

		this.syncSortArrows();
		this.syncAlert();
		this.aliasCells = {};

		if (state == null || !Array.isArray(state.devices) || all.length === 0) {
			this.tableWrap.style.display = 'none';
			this.emptyBox.style.display = '';
			clearNode(this.tbody);
			dom.content(this.emptyBox, this.renderEmpty());

			return;
		}

		if (rows.length === 0) {
			this.tableWrap.style.display = 'none';
			this.emptyBox.style.display = '';
			clearNode(this.tbody);
			dom.content(this.emptyBox, this.renderFilterEmpty());

			return;
		}

		this.tableWrap.style.display = '';
		this.emptyBox.style.display = 'none';
		clearNode(this.emptyBox);

		var frags = [];

		for (i = 0; i < rows.length; i++)
			frags = frags.concat(this.renderDeviceRow(rows[i]));

		dom.content(this.tbody, frags);
	},

	renderFilterEmpty: function() {
		var self = this;

		return E('div', {}, [
			E('strong', {}, _('没有匹配的设备')),
			E('p', { style: 'margin:6px 0 0 0' }, _('当前分段、搜索、接入或厂商筛选下没有设备。')),
			E('button', {
				'class': 'cbi-button',
				type: 'button',
				click: function(ev) {
					if (ev != null && ev.preventDefault) ev.preventDefault();
					self.clearFilters();
				}
			}, _('清除筛选'))
		]);
	},

	clearFilters: function() {
		this.segment = 'all';
		this.search = '';
		this.linkFilter = '';
		this.vendorFilter = '';

		if (this.searchInput != null) this.searchInput.value = '';
		if (this.linkSelect != null) this.linkSelect.value = '';
		if (this.vendorSelect != null) this.vendorSelect.value = '';

		this.renderRows();
	},

	syncAlert: function() {
		if (this.alertBox == null) return;

		if (this.refreshError != null) {
			this.alertBox.style.display = '';
			this.alertBox.textContent = (this.state == null)
				? _('加载失败：') + this.refreshError
				: _('刷新失败：') + this.refreshError + _('（下面显示的是上次成功的数据）');

			return;
		}

		this.alertBox.style.display = 'none';
		this.alertBox.textContent = '';
	},

	reloadState: function() {
		var self = this;

		return callState().then(function(state) {
			if (state == null || typeof state !== 'object' || !Array.isArray(state.devices))
				throw new Error(_('后端返回的数据不完整'));

			self.state = state;
			self.error = null;
			self.refreshError = null;
			self.renderRows();
			self.syncDrawer();

			return state;
		}).catch(function(err) {
			self.refreshError = (err != null && err.message) ? ('' + err.message) : ('' + err);
			self.syncAlert();

			if (self.state == null) self.renderRows();
		});
	},

	/* 15s 自动刷新：只重新拉 get_state，过滤/排序/分段状态都保留。 */
	refresh: function() {
		var self = this;

		if (this.refreshing === true) return Promise.resolve();

		this.refreshing = true;

		return callState().then(function(state) {
			self.refreshing = false;

			if (state == null || typeof state !== 'object' || !Array.isArray(state.devices))
				throw new Error(_('后端返回的数据不完整'));

			self.state = state;
			self.error = null;
			self.refreshError = null;
			self.renderRows();
			self.syncDrawer();

			return state;
		}).catch(function(err) {
			self.refreshing = false;
			/* 失败保留旧数据：不清 state、不重建表格，只在顶部提示。 */
			self.refreshError = (err != null && err.message) ? ('' + err.message) : ('' + err);
			self.syncAlert();
		});
	},

	startRefresh: function() {
		var self = this;

		if (this.paused === true || this.timer != null) return;

		if (typeof window == 'undefined' || typeof window.setInterval != 'function') return;

		this.timer = window.setInterval(function() {
			var attached = true;

			if (self.root != null && typeof document != 'undefined' && document.body != null &&
				typeof document.body.contains == 'function')
				attached = document.body.contains(self.root);

			/* 离开页面后 #view 会被清空，这里顺手停表，避免后台一直轮询。 */
			if (!attached) {
				self.stopRefresh();
				self.closeDrawer();

				return;
			}

			if (typeof document != 'undefined' && document.hidden === true) return;

			self.refresh();
		}, REFRESH_MS);
	},

	stopRefresh: function() {
		if (this.timer != null) {
			if (typeof window != 'undefined' && typeof window.clearInterval == 'function')
				window.clearInterval(this.timer);

			this.timer = null;
		}
	},

	toggleRefresh: function() {
		this.paused = !(this.paused === true);

		if (this.paused) this.stopRefresh();
		else this.startRefresh();

		this.syncRefreshHint();
	},

	syncRefreshHint: function() {
		if (this.refreshBtn != null)
			this.refreshBtn.textContent = this.paused ? _('继续刷新') : _('暂停刷新');

		if (this.refreshHint != null) {
			this.refreshHint.textContent = this.paused
				? _('自动刷新已暂停')
				: _('每') + ' ' + Math.round(REFRESH_MS / 1000) + ' ' + _('秒自动刷新');
		}
	},

	/* ---- 设备详情抽屉 ---- */

	openDrawer: function(dev) {
		if (dev == null) return;

		var self = this;

		if (this.drawerOverlay != null) this.closeDrawer();

		this.drawerDev = dev;

		var closeBtn = E('button', {
			'class': 'tsd-drawer-close',
			type: 'button',
			'aria-label': _('关闭设备详情'),
			title: _('关闭（Esc）'),
			click: function(ev) {
				if (ev != null && ev.preventDefault) ev.preventDefault();

				self.closeDrawer();
			}
		}, '×');

		this.drawerBody = E('div', {}, '');

		var panel = E('div', {
			'class': 'tsd-drawer-panel',
			role: 'dialog',
			'aria-modal': 'true',
			'aria-labelledby': 'tsd-drawer-title'
		}, [ closeBtn, this.drawerBody ]);

		var overlay = E('div', {
			'class': 'tsd-drawer-overlay',
			click: function(ev) {
				/* 只有点到遮罩本身才关闭；点面板内部不关。 */
				if (ev != null && ev.target === overlay) {
					if (ev.preventDefault) ev.preventDefault();

					self.closeDrawer();
				}
			}
		}, panel);

		this.drawerOverlay = overlay;
		this.drawerPanel = panel;

		dom.content(this.drawerBody, this.renderDrawerContent(dev));

		/* 挂在 #view 的根节点里：SPA 切页时随视图一起移除，不会留下盖住新页面的遮罩。 */
		var mount = (this.root != null) ? this.root : ((typeof document != 'undefined') ? document.body : null);

		if (mount != null && typeof mount.appendChild == 'function')
			mount.appendChild(overlay);

		/* 从右侧滑入：先以 translateX(100%) 挂上，再切到 0 触发 transition。 */
		nextFrame(function() {
			if (self.drawerPanel === panel && panel.style != null)
				panel.style.transform = 'translateX(0)';
		});

		this.escFn = function(ev) {
			if (ev == null || !(ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27))
				return;

			/* 编辑弹窗开着时 Esc 交给弹窗，抽屉保持打开。 */
			if (self.dialog != null) return;

			var attached = (self.root == null) ? false :
				(typeof document == 'undefined' || document.body == null ||
					typeof document.body.contains != 'function') ? true : document.body.contains(self.root);

			if (!attached) {
				self.closeDrawer();

				return;
			}

			if (typeof ev.preventDefault == 'function') ev.preventDefault();

			self.closeDrawer();
		};

		if (typeof document != 'undefined' && typeof document.addEventListener == 'function')
			document.addEventListener('keydown', this.escFn);

		try {
			closeBtn.focus();
		}
		catch (e) { /* 老浏览器/测试环境没有 focus 也不影响 */ }
	},

	closeDrawer: function() {
		if (this.escFn != null && typeof document != 'undefined' &&
			typeof document.removeEventListener == 'function')
			document.removeEventListener('keydown', this.escFn);

		this.escFn = null;

		var overlay = this.drawerOverlay;

		if (overlay != null) {
			if (overlay.parentNode != null && typeof overlay.parentNode.removeChild == 'function')
				overlay.parentNode.removeChild(overlay);
			else if (typeof document != 'undefined' && document.body != null &&
				typeof document.body.removeChild == 'function') {
				try { document.body.removeChild(overlay); }
				catch (e) { /* 已经不在文档里 */ }
			}
		}

		this.drawerOverlay = null;
		this.drawerPanel = null;
		this.drawerBody = null;
		this.drawerDev = null;
	},

	/* 刷新后把抽屉里的设备对象换成最新的一份，在线状态/用量不显示旧值。 */
	syncDrawer: function() {
		if (this.drawerBody == null || this.drawerDev == null) return;

		var key = macKey(this.drawerDev);
		var all = (this.state != null && Array.isArray(this.state.devices)) ? this.state.devices : [];
		var found = null;

		/* 没有 MAC 的设备无法按 MAC 对齐，保留打开时的对象，避免错配到另一台空 MAC 设备。 */
		if (!key.length) return;

		for (var i = 0; i < all.length; i++) {
			if (macKey(all[i]) === key) {
				found = all[i];

				break;
			}
		}

		if (found != null) this.drawerDev = found;

		dom.content(this.drawerBody, this.renderDrawerContent(this.drawerDev));
	},

	drawerSection: function(title, content) {
		return E('div', { 'class': 'tsd-drawer-sec' }, [
			E('h5', {}, title),
			content
		]);
	},

	drawerInfo: function(pairs) {
		var cells = [];

		for (var i = 0; i < pairs.length; i++) {
			cells.push(E('div', { 'class': 'tsd-info-k' }, pairs[i][0]));
			cells.push(E('div', { 'class': 'tsd-info-v' }, pairs[i][1]));
		}

		return E('div', { 'class': 'tsd-info' }, cells);
	},

	renderDrawerSignal: function(st) {
		if (st == null || typeof st.signal !== 'number' || !isFinite(st.signal)) return '—';

		var parts = [];

		if (st.node_name) parts.push('' + st.node_name);
		if (st.iface) parts.push('' + st.iface);

		return E('span', {
			style: 'color:' + signalColor(st.signal) + ';font-weight:600'
		}, st.signal + ' dBm' + (parts.length ? '（' + parts.join(' · ') + '）' : ''));
	},

	renderDrawerContent: function(dev) {
		var self = this;
		var mac = macKey(dev);
		var name = deviceName(dev);
		var online = isDeviceOnline(dev, nowSec());
		var st = stationFor(this.stations, dev);
		var alias = aliasOf(dev);
		var group = groupOf(dev);
		var vendor = vendorOf(dev != null ? dev.mac : '');
		var vendorNode = vendor.length
			? E('span', {}, vendor)
			: E('span', {}, [
				_('未知厂商'),
				isRandomMac(dev != null ? dev.mac : '')
					? E('span', { style: 'font-size:11px;opacity:.7' }, '（' + _('随机 MAC') + '）')
					: ''
			]);

		var header = E('div', {}, [
			E('div', { 'class': 'tsd-drawer-h', id: 'tsd-drawer-title' }, shorten(name, 60)),
			E('div', { 'class': 'tsd-drawer-sub' }, [
				alias.length ? alias : _('未命名'),
				group.length ? ' · ' + _('分组') + '：' + group : '',
				mac.length ? ' · ' + mac : ''
			]),
			E('div', {
				style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 0 0'
			}, [
				E('span', {
					'class': 'tsd-pill ' + (online ? 'tsd-pill-on' : 'tsd-pill-off')
				}, online ? _('在线') : _('离线')),
				isAdmin()
					? E('button', {
						'class': 'cbi-button cbi-button-edit tsd-edit',
						type: 'button',
						click: function(ev) {
							if (ev != null && ev.preventDefault) ev.preventDefault();

							self.openEditDialog(dev);
						}
					}, _('编辑'))
					: E('span', { style: 'font-size:11px;opacity:.6' }, _('只读'))
			])
		]);

		var basic = this.drawerInfo([
			[ _('IP'), (dev.ip != null && ('' + dev.ip).length) ? E('code', {}, '' + dev.ip) : '—' ],
			[ _('MAC'), mac.length ? E('code', {}, mac) : '—' ],
			[ _('厂商'), vendorNode ],
			[ _('设备类型'), deviceKindLabel(deviceKindOf(dev)) ],
			[ _('接入方式'), this.linkBadge(dev) ],
			[ _('信号'), this.renderDrawerSignal(st) ],
			[ _('首次出现'), num(dev.first_seen) > 0 ? fmtDate(dev.first_seen) : '—' ],
			[ _('上次活跃'), fmtTime(dev.last_seen) +
				(num(dev.last_seen) > 0 ? '（' + fmtDate(num(dev.last_seen)) + '）' : '') ]
		]);

		var usedKnown = monthAvailable(dev);

		var usage = this.drawerInfo([
			[ _('本月下载'), usedKnown ? fmtBytes(num(dev.month_rx)) : '—' ],
			[ _('本月上传'), usedKnown ? fmtBytes(num(dev.month_tx)) : '—' ],
			[ _('本月合计'), usedKnown ? fmtBytes(monthTotal(dev)) : '—' ]
		]);

		var q = deviceQuota(dev);
		var hasQuota = (dev != null && dev.quota_limit != null);
		var quotaNode;

		if (q != null) {
			quotaNode = E('div', { style: 'margin-top:10px' }, [
				E('div', { style: 'font-size:12px;line-height:1.6' }, [
					_('配额') + ' ' + fmtBytes(q.limit) + ' · ' + _('已用') + ' ' + fmtBytes(q.used) +
						'（' + q.pct.toFixed(1) + '%）'
				]),
				E('div', { 'class': 'tsd-drawer-bar' }, E('div', {
					style: 'width:' + q.pct.toFixed(1) + '%;background:' + quotaLook(q.pct)
				})),
				E('div', {
					style: 'font-size:12px;line-height:1.6;' + (q.remaining < 0 ? 'color:#c62828' : '')
				}, q.remaining < 0
					? _('已超额') + ' ' + fmtBytes(-q.remaining)
					: _('剩余') + ' ' + fmtBytes(q.remaining))
			]);
		}
		else if (hasQuota) {
			quotaNode = E('div', { style: 'font-size:12px;line-height:1.6;margin-top:10px;opacity:.85' },
				_('配额剩余') + ' — ' + _('（配额上限为 0，分母为 0，无法计算百分比）'));
		}
		else {
			quotaNode = E('div', { style: 'font-size:12px;line-height:1.6;margin-top:10px;opacity:.75' },
				_('未配置单设备配额（在设置页选择“每设备”配额并填写额度后显示）'));
		}

		var usageSection = this.drawerSection(_('用量'), E('div', {}, [ usage, quotaNode ]));

		var list = deviceAppList(dev);
		var listTotal = appListTotal(list);
		var appsContent;

		if (list.length === 0) {
			appsContent = E('div', { style: 'font-size:12px;opacity:.7' }, _('该设备暂无应用明细'));
		}
		else {
			var top = list.slice(0, 10);
			var appRows = [];

			for (var i = 0; i < top.length; i++) {
				var app = top[i];
				var pct = (listTotal > 0) ? (app.total * 100 / listTotal) : 0;

				appRows.push(E('tr', {}, [
					E('td', {
						style: 'max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
						title: app.host
					}, shorten(appLabel(app.host), 28)),
					E('td', {}, chainBadge(app.chain)),
					E('td', { style: 'text-align:right;white-space:nowrap' }, fmtBytes(app.total)),
					E('td', { style: 'width:92px' }, [
						E('div', { 'class': 'tsd-drawer-bar', style: 'margin:0' }, E('div', {
							style: 'width:' + pct.toFixed(1) + '%;background:#2b7de9'
						})),
						E('div', { style: 'font-size:10.5px;opacity:.7' }, pct.toFixed(1) + '%')
					])
				]));
			}

			appsContent = E('div', {}, [
				E('table', { 'class': 'tsd-drawer-apps' }, E('tbody', {}, appRows)),
				list.length > top.length
					? E('p', { 'class': 'tsd-drawer-note' },
						_('仅显示流量前 10 项（共 ') + list.length + _(' 项）；列表里点「▸」可展开全部应用。'))
					: ''
			]);
		}

		var appsSection = this.drawerSection(_('应用分布'), appsContent);

		var statusNode = E('div', { 'class': 'tsd-drawer-note', role: 'status' }, '');

		var copyAttrs = { 'class': 'cbi-button', type: 'button' };

		if (!mac.length) copyAttrs.disabled = true;

		var copyMacBtn = E('button', copyAttrs, _('复制 MAC'));

		copyMacBtn.addEventListener('click', function(ev) {
			if (ev != null && ev.preventDefault) ev.preventDefault();

			self.copyText(mac, statusNode);
		});

		var actionButtons = E('div', { 'class': 'tsd-drawer-actions' }, [
			E('button', {
				'class': 'cbi-button cbi-button-action',
				type: 'button',
				click: function(ev) {
					if (ev != null && ev.preventDefault) ev.preventDefault();

					self.exportDeviceCsv(dev, statusNode);
				}
			}, _('导出该设备 CSV')),
			copyMacBtn
		]);

		var blockNode;

		if (mac.length) {
			var cmd = blockCommand(mac);

			blockNode = E('div', {}, [
				E('pre', { 'class': 'tsd-drawer-code' }, E('code', {}, cmd)),
				E('p', { 'class': 'tsd-drawer-note' },
					_('本页只显示命令，不会执行；nft 规则在防火墙重载 / 重启后失效。需在路由器 SSH 中手动执行，执行前请确认不是自己的设备。')),
				E('div', { 'class': 'tsd-drawer-actions' }, [
					E('button', {
						'class': 'cbi-button',
						type: 'button',
						click: function(ev) {
							if (ev != null && ev.preventDefault) ev.preventDefault();

							self.copyText(cmd, statusNode);
						}
					}, _('复制命令'))
				])
			]);
		}
		else {
			blockNode = E('p', { 'class': 'tsd-drawer-note' },
				_('这台设备的 state.json 里没有 MAC（只有 IP），无法生成基于 MAC 的 nftables 规则，因此没有阻断建议。'));
		}

		var opsSection = this.drawerSection(_('操作'), E('div', {}, [
			actionButtons,
			statusNode,
			E('div', { style: 'font-size:12px;font-weight:600;margin:14px 0 0 0' }, _('阻断建议')),
			blockNode
		]));

		return [ header, this.drawerSection(_('基本信息'), basic),
			usageSection, appsSection, opsSection ];
	},

	/* 单设备 CSV：export_csv 只支持整页 devices，这里按同样的列导出一行。 */
	exportDeviceCsv: function(dev, statusNode) {
		try {
			this.saveCsv({ filename: deviceCsvFilename(dev), csv: deviceCsv(dev), rows: 1 }, 'device');
			nodeText(statusNode, _('已导出该设备的 CSV'), '#2e7d32');
		}
		catch (err) {
			var message = (err != null && err.message) ? ('' + err.message) : ('' + err);

			nodeText(statusNode, _('导出失败：') + message, '#c62828');
			ui.addNotification(null, E('p', {}, _('导出失败：') + message), 'error');
		}
	},

	copyText: function(text, statusNode) {
		var value = (text == null) ? '' : ('' + text);
		var done = function(ok, message) {
			nodeText(statusNode, message || (ok ? _('已复制到剪贴板') : _('复制失败，请手动选择文本')),
				ok ? '#2e7d32' : '#c62828');
		};

		if (!value.length) {
			done(false, _('没有可复制的内容'));

			return;
		}

		var nav = (typeof navigator != 'undefined') ? navigator : null;

		if (nav != null && nav.clipboard != null && typeof nav.clipboard.writeText == 'function') {
			nav.clipboard.writeText(value).then(function() { done(true); })
				.catch(function() { done(false); });

			return;
		}

		try {
			var area = document.createElement('textarea');

			area.value = value;
			area.style.position = 'fixed';
			area.style.opacity = '0';
			area.style.left = '-9999px';
			document.body.appendChild(area);

			if (typeof area.select == 'function') area.select();

			var ok = (typeof document.execCommand == 'function') ? document.execCommand('copy') : false;

			document.body.removeChild(area);
			done(ok === true);
		}
		catch (err) {
			done(false);
		}
	},

	/* 接入方式的数据来源提示：FDB 读不到或没配端口时，本列会大面积显示"未知/有线"，先把原因说清楚。 */
	linkSummary: function(state) {
		var h = (state != null && state.health) ? state.health : {};
		var ports = Array.isArray(h.link_ports) ? h.link_ports : [];
		var source = '' + (h.link_source || 'none');

		if (source != 'brctl')
			return _('接入判定不可用（读不到桥 FDB）') + ' · ';

		if (ports.length == 0)
			return _('未配置无线上联端口，接入列一律按有线归类') + ' · ';

		return _('接入判定') + ' brctl:' + ports.join(',') + ' · ';
	},

	renderEmpty: function() {
		var state = this.state;
		var h = (state != null && state.health) ? state.health : {};
		var reasons = Array.isArray(h.reasons) ? h.reasons : [];
		var message;
		var self = this;

		if (state == null) {
			message = _('暂时读不到设备列表：rpcd 对象 traffic-stats 不可用，或者后端尚未安装。') +
				(this.error ? '（' + this.error + '）' : '');
		}
		else if (state.running !== true) {
			message = _('暂无数据：traffic-statsd 未运行，因此还没有设备记录。');
		}
		else {
			message = _('暂无数据：traffic-statsd 正在运行，但还没采到任何设备流量。');
		}

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
			E('p', {}, E('strong', {}, message)),
			reasons.length ? E('ul', {}, reasons.map(function(r) { return E('li', {}, '' + r); })) : '',
			E('p', {}, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					type: 'button',
					click: function(ev) {
						if (ev != null && ev.preventDefault) ev.preventDefault();

						self.reloadState();
					}
				}, _('重试')),
				' ',
				E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页')),
				' · ',
				E('a', { href: L.url('admin/services/traffic-stats/overview') }, _('返回总览'))
			])
		]);
	},

	/* 主机名前的设备类型图标：圆形底 + 24px 线性图标，颜色沿用接入方式（无线紫/有线青/未知灰）。 */
	renderKindBadge: function(dev) {
		var kind = deviceKindOf(dev);
		var style = LINK_STYLE[linkOf(dev)] || LINK_STYLE.unknown;

		return E('span', {
			'class': 'tsd-kind',
			style: 'background:' + style.bg,
			title: _('设备类型') + '：' + deviceKindLabel(kind) + ' · ' + _('接入') + '：' + _(style.label)
		}, deviceKindSvg(kind, style.color));
	},

	renderDeviceRow: function(dev) {
		var self = this;
		var direct = num(dev.direct_rx) + num(dev.direct_tx);
		var proxy = num(dev.proxy_rx) + num(dev.proxy_tx);
		var total = direct + proxy;
		var name = deviceName(dev);
		var mac = macKey(dev);
		var marker = E('button', {
			'class': 'tsd-appbtn',
			type: 'button',
			title: _('展开/收起该设备的应用分布'),
			'aria-label': _('展开应用分布')
		}, '▸');

		var cell = E('td', {
			'class': 'td',
			colspan: 13,
			style: 'padding:10px 12px;background:rgba(127,127,127,.06)'
		}, E('em', {}, _('展开后加载…')));

		var detailRow = E('tr', {
			'class': 'tr',
			style: 'display:none'
		}, [ cell ]);

		var filled = false;
		var open = false;
		var aliasCell = E('td', { 'class': 'td' });

		if (mac.length) this.aliasCells[mac] = aliasCell;

		dom.content(aliasCell, this.renderAliasContent(dev));

		/* 行内「应用」按钮单独控制展开，点击行本身打开右侧详情抽屉。 */
		marker.addEventListener('click', function(ev) {
			if (ev != null) {
				if (ev.preventDefault) ev.preventDefault();
				if (ev.stopPropagation) ev.stopPropagation();
			}

			open = !open;
			detailRow.style.display = open ? '' : 'none';
			marker.textContent = open ? '▾' : '▸';

			if (open && !filled) {
				filled = true;
				dom.content(cell, self.renderApps(dev));
			}
		});

		var firstSeen = num(dev.first_seen);
		var vendorName = vendorLabelOf(dev);
		var vendorTitle = _('按 MAC 前 3 字节（OUI）识别的厂商') +
			(isRandomMac(dev != null ? dev.mac : '')
				? ' · ' + _('该 MAC 是本地管理地址（随机 MAC），无法识别厂商')
				: '');

		var row = E('tr', {
			'class': 'tr',
			style: 'cursor:pointer',
			title: _('点击查看设备详情')
		}, [
			E('td', { 'class': 'td' }, E('div', { 'class': 'tsd-host' }, [
				marker,
				this.renderKindBadge(dev),
				E('div', { 'class': 'tsd-host-text' }, [
					E('div', {}, [
						E('strong', {}, shorten(name, 30)),
						isNewDevice(dev)
							? E('span', { 'class': 'tsd-new', title: _('first_seen 在 24 小时内') }, _('新'))
							: ''
					]),
					E('div', { 'class': 'tsd-vendor', title: vendorTitle }, vendorName),
					dev.mac ? E('div', { 'class': 'tsd-sub' }, E('code', {}, '' + dev.mac)) : '',
					dev.ip ? E('div', { 'class': 'tsd-sub' }, E('code', {}, '' + dev.ip)) : '',
					/* 首次出现也放在主列的小字里：窄屏隐藏独立列后仍然看得到。 */
					firstSeen > 0 ? E('div', { 'class': 'tsd-sub' }, _('首次') + ' ' + fmtDate(firstSeen)) : ''
				])
			])),
			aliasCell,
			E('td', { 'class': 'td tsd-opt', title: firstSeen > 0 ? fmtDate(firstSeen) : _('后端尚未记录 first_seen') },
				firstSeen > 0 ? fmtDate(firstSeen) : '—'),
			this.renderLink(dev),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(direct)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(proxy)),
			E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(total))),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, monthAvailable(dev)
				? [
					fmtBytes(monthTotal(dev)),
					E('div', { 'class': 'tsd-sub' }, '↓ ' + fmtBytes(num(dev.month_rx)) + ' · ↑ ' + fmtBytes(num(dev.month_tx)))
				]
				: E('span', { style: 'opacity:.55' }, '—')),
			this.renderQuotaCell(dev),
			E('td', {
				'class': 'td',
				style: 'text-align:right;white-space:nowrap',
				title: '↓ ' + fmtRateBytes(num(dev.rx_rate)) + ' / ↑ ' + fmtRateBytes(num(dev.tx_rate))
			}, [
				E('div', {}, '↓ ' + fmtRateBits(num(dev.rx_rate))),
				E('div', { style: 'font-size:11px;opacity:.7' }, '↑ ' + fmtRateBits(num(dev.tx_rate)))
			]),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtTime(dev.last_seen)),
			this.renderSignal(dev),
			E('td', { 'class': 'td', style: 'text-align:right' }, E('button', {
				'class': 'cbi-button tsd-detail-btn',
				type: 'button',
				click: function(ev) {
					if (ev != null) {
						if (ev.preventDefault) ev.preventDefault();
						if (ev.stopPropagation) ev.stopPropagation();
					}

					self.openDrawer(dev);
				}
			}, _('详情')))
		]);

		row.addEventListener('click', function() { self.openDrawer(dev); });

		return [ row, detailRow ];
	},

	/* 别名/分组列；每次保存成功只重画这一格，不重排整张表。 */
	renderAliasContent: function(dev) {
		if (dev == null) return '—';

		var self = this;
		var editButton = isAdmin()
			? E('button', {
				'class': 'cbi-button cbi-button-edit tsd-edit',
				type: 'button',
				click: function(ev) {
					if (ev != null) {
						ev.preventDefault();
						ev.stopPropagation();
					}

					self.openEditDialog(dev);
				}
			}, _('编辑'))
			: '';

		if (!aliasOf(dev).length && !groupOf(dev).length)
			return E('div', {}, [
				E('span', { style: 'opacity:.5' }, _('未命名')),
				editButton
			]);

		return E('div', {}, [
			aliasOf(dev).length
				? E('div', { 'class': 'tsd-alias-name' }, aliasOf(dev))
				: E('span', { style: 'opacity:.5' }, _('未命名')),
			groupOf(dev).length
				? E('div', { 'class': 'tsd-sub' }, _('分组') + '：' + groupOf(dev))
				: '',
			editButton
		]);
	},

	/* 配额剩余列：limit 不存在（mode≠device / 未配置）显示 —，绝不做除零。 */
	renderQuotaCell: function(dev) {
		var q = deviceQuota(dev);

		if (q == null)
			return E('td', { 'class': 'td tsd-quota', style: 'text-align:right;opacity:.55' }, '—');

		var over = q.remaining < 0;

		return E('td', {
			'class': 'td tsd-quota',
			style: 'text-align:right;white-space:nowrap',
			title: _('已用') + ' ' + fmtBytes(q.used) + ' / ' + fmtBytes(q.limit) + '（' + q.pct.toFixed(1) + '%）'
		}, [
			E('div', { style: 'font-weight:600;color:' + (over ? '#c62828' : '') },
				fmtBytes(Math.max(0, q.remaining))),
			E('div', { 'class': 'tsd-sub' }, over ? _('已超额') : (q.pct.toFixed(1) + '%')),
			E('div', {
				style: 'height:4px;border-radius:2px;background:rgba(127,127,127,.2);overflow:hidden;margin-top:3px'
			}, E('div', {
				style: 'height:4px;width:' + q.pct.toFixed(1) + '%;background:' + quotaLook(q.pct)
			}))
		]);
	},

	/*
	 * 编辑别名/分组。草稿按归一化 MAC 保存：
	 *   - RPC 失败：弹窗不关、输入不清，错误写在弹窗里；
	 *   - 点「取消」：草稿保留，再次打开同一台设备会带出来（显式「放弃修改」才清）。
	 * 这样不会因为一次网络抖动/后端拒绝就把用户刚敲的字丢掉。
	 */
	openEditDialog: function(dev) {
		if (this.dialog != null || dev == null) return;

		if (!isAdmin()) {
			ui.addNotification(null, E('p', {},
				_('只有管理员（luci-app-traffic-stats-admin）才能编辑设备别名/分组。')), 'warning');

			return;
		}

		var self = this;
		var mac = macKey(dev);

		if (!mac.length) {
			ui.addNotification(null, E('p', {},
				_('这台设备没有 MAC，后端 set_device_meta 只接受 MAC 作为键，无法保存别名/分组。')), 'warning');

			return;
		}

		var draft = this.drafts[mac];

		if (draft == null)
			draft = { alias: aliasOf(dev), group: groupOf(dev) };

		var aliasInput = E('input', {
			'class': 'cbi-input-text',
			type: 'text',
			/* maxlength 以 UTF-16 计，只是防手滑的粗略上限；真正校验见 metaByteError()。 */
			maxlength: 128,
			placeholder: _('例如：客厅电视（留空 = 清除别名）'),
			style: 'width:100%;box-sizing:border-box'
		});

		aliasInput.value = draft.alias;

		var groupInput = E('input', {
			'class': 'cbi-input-text',
			type: 'text',
			/* 同上：128 code units 不会误伤任何 <=128 UTF-8 字节的合法输入。 */
			maxlength: 128,
			placeholder: _('例如：家人 / 客人（留空 = 清除分组）'),
			style: 'width:100%;box-sizing:border-box'
		});

		groupInput.value = draft.group;

		var errorNode = E('div', {
			style: 'min-height:18px;margin:8px 0 0 0;font-size:12px;line-height:1.6;white-space:pre-wrap'
		}, '');

		var draftNode = E('div', { style: 'font-size:11.5px;opacity:.7;margin:6px 0 0 0;line-height:1.6' }, '');

		var saveBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			type: 'button'
		}, _('保存'));

		var discardBtn = E('button', {
			'class': 'cbi-button',
			type: 'button'
		}, _('放弃修改'));

		var cancelBtn = E('button', {
			'class': 'cbi-button',
			type: 'button'
		}, _('取消（保留草稿）'));

		var remember = function() {
			self.drafts[mac] = { alias: aliasInput.value, group: groupInput.value };
			draftNode.textContent = _('未保存的修改已保留在本页，再次编辑这台设备时会带出来。');
		};

		aliasInput.addEventListener('input', remember);
		groupInput.addEventListener('input', remember);

		var close = function(dropDraft) {
			if (dropDraft === true) delete self.drafts[mac];

			if (overlay.parentNode != null) overlay.parentNode.removeChild(overlay);

			self.dialog = null;
		};

		saveBtn.addEventListener('click', function(ev) {
			if (ev != null) ev.preventDefault();

			var alias = ('' + aliasInput.value).trim();
			var group = ('' + groupInput.value).trim();
			var inputError = metaByteError(alias, group);

			if (inputError != null) {
				nodeText(errorNode, inputError, '#c62828');

				return;
			}

			saveBtn.disabled = true;
			nodeText(errorNode, _('正在保存…'), '');

			callSetDeviceMeta(mac, alias, group).then(function(res) {
				if (res == null || res.ok !== true) {
					var reason = (res != null && res.error != null) ? ('' + res.error) : _('后端没有返回成功');
					throw new Error(reason);
				}

				var result = applyMetaResult(dev, res, alias, group);
				var cell = self.aliasCells[mac];

				if (cell != null)
					dom.content(cell, self.renderAliasContent(dev));

				/* 抽屉同时开着时，头部别名 / 分组也要立刻换成后端保存后的值。 */
				self.syncDrawer();

				/* 后端返回值和提交值不一致 = 被截断/清理，绝不能只弹“已保存”。 */
				if (result.truncated) {
					aliasInput.value = result.alias;
					groupInput.value = result.group;
					self.drafts[mac] = { alias: result.alias, group: result.group };
					nodeText(errorNode, result.warning, '#ef6c00');
					saveBtn.disabled = false;
					ui.addNotification(null, E('p', {}, result.warning), 'warning');

					return;
				}

				delete self.drafts[mac];
				close(false);
				ui.addNotification(null, E('p', {},
					_('已保存') + ' ' + deviceName(dev) + _(' 的别名/分组。')), 'info');
			}).catch(function(err) {
				var message = (err != null && err.message) ? ('' + err.message) : ('' + err);

				/* 失败不关弹窗、不动输入，用户可以直接改一下再试。 */
				nodeText(errorNode, _('保存失败：') + message + '\n' + _('你的输入还在，修改后可以重试。'), '#c62828');
				saveBtn.disabled = false;
			});
		});

		discardBtn.addEventListener('click', function(ev) {
			if (ev != null) ev.preventDefault();

			close(true);
		});

		cancelBtn.addEventListener('click', function(ev) {
			if (ev != null) ev.preventDefault();

			remember();
			close(false);
		});

		var panel = E('div', {
			role: 'dialog',
			'aria-modal': 'true',
			style: 'width:100%;max-width:480px;max-height:86vh;overflow:auto;background:var(--background-color-high,#fff);' +
				'color:var(--text-color,#222);border-radius:12px;padding:16px 18px;' +
				'box-shadow:0 12px 40px rgba(0,0,0,.28)'
		}, [
			E('h4', { style: 'margin:0 0 4px 0;font-size:16px' }, _('编辑设备')),
			E('div', { style: 'font-size:12px;opacity:.75;margin-bottom:12px;word-break:break-all' }, [
				deviceName(dev), ' · ', E('code', {}, mac)
			]),
			E('label', { style: 'display:block;font-size:12px;margin:0 0 4px 0' }, _('别名')),
			aliasInput,
			E('div', { style: 'height:10px' }),
			E('label', { style: 'display:block;font-size:12px;margin:0 0 4px 0' }, _('分组')),
			groupInput,
			draftNode,
			errorNode,
			E('div', {
				style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:14px'
			}, [ discardBtn, cancelBtn, saveBtn ])
		]);

		var overlay = E('div', {
			style: 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;' +
				'padding:16px;background:rgba(0,0,0,.42)'
		}, [ panel ]);

		document.body.appendChild(overlay);

		this.dialog = overlay;

		try {
			aliasInput.focus();
		}
		catch (e) { /* 老浏览器/测试环境没有 focus 也不影响 */ }
	},

	/* CSV：后端返回 {filename, csv}，csv 已带 UTF-8 BOM 与 CRLF，这里原样存盘。 */
	exportCsv: function(what) {
		var self = this;

		nodeText(this.exportStatus, _('正在导出…'), '');

		return callExportCsv(what).then(function(res) {
			if (res == null || res.ok !== true || typeof res.csv != 'string')
				throw new Error((res != null && res.error != null) ? ('' + res.error) : _('后端没有返回 CSV 内容'));

			self.saveCsv(res, what);
			nodeText(self.exportStatus,
				_('已导出') + ' ' + ((res.rows != null) ? res.rows : 0) + ' ' + _('行'), '#2e7d32');
		}).catch(function(err) {
			var message = (err != null && err.message) ? ('' + err.message) : ('' + err);

			nodeText(self.exportStatus, _('导出失败：') + message, '#c62828');
			ui.addNotification(null, E('p', {}, _('导出失败：') + message), 'error');
		});
	},

	saveCsv: function(res, what) {
		var csv = (res != null && typeof res.csv == 'string') ? res.csv : '';

		if (!csv.length) throw new Error(_('CSV 内容为空'));

		var now = new Date();
		var fallback = 'traffic-stats-' + what + '-' + now.getFullYear() + '-' +
			pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + '.csv';
		var filename = (res != null && res.filename) ? ('' + res.filename) : fallback;
		var blob = new Blob([ csv ], { type: 'text/csv;charset=utf-8' });

		/* 老 IE / 边缘环境没有 createObjectURL：退化成 data URL 也能下载。 */
		if (typeof URL == 'undefined' || typeof URL.createObjectURL != 'function') {
			var link = document.createElement('a');

			link.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
			link.download = filename;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			return;
		}

		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');

		a.href = url;
		a.download = filename;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
	},

	/* 接入标签：抽屉和表格共用。数据来自主路由的桥 FDB（见守护进程 brctl showmacs），
	   与字节来源无关；字段缺失（老后端）显示 "-"。 */
	linkBadge: function(dev) {
		var style = LINK_STYLE[linkOf(dev)];

		if (style == null) return '-';

		return E('span', {
			style: 'font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap;color:' +
				style.color + ';background:' + style.bg
		}, _(style.label));
	},

	renderLink: function(dev) {
		return E('td', { 'class': 'td' }, this.linkBadge(dev));
	},

	/* 信号列：有数据就显示 "-53 dBm" 并分级着色；没有该设备的数据就显示 "-"。
	   数据只来自哑桥 AP 的无线元数据（不含任何流量字节）。 */
	renderSignal: function(dev) {
		var st = stationFor(this.stations, dev);
		var signal = (st != null && typeof st.signal == 'number' && isFinite(st.signal)) ? st.signal : null;

		if (signal == null)
			return E('td', { 'class': 'td', style: 'text-align:right' }, '-');

		var parts = [];

		if (st.node_name) parts.push('' + st.node_name);
		if (st.iface) parts.push('' + st.iface);

		var title = _('来自哑桥 AP 的无线信号（仅元数据，不含流量）');

		if (parts.length) title += ' · ' + parts.join(' · ');

		return E('td', {
			'class': 'td',
			style: 'text-align:right;white-space:nowrap',
			title: title
		}, E('span', {
			style: 'color:' + signalColor(signal) + ';font-weight:600'
		}, signal + ' dBm'));
	},

	renderApps: function(dev) {
		var list = deviceAppList(dev);

		if (list.length == 0)
			return E('div', {}, E('em', { style: 'opacity:.7' }, _('该设备暂无应用明细')));

		var sum = appListTotal(list);

		var rows = list.map(function(app) {
			var total = app.total;
			var percent = (sum > 0) ? (total * 100 / sum) : 0;

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', title: app.host }, shorten(appLabel(app.host), 48)),
				E('td', { 'class': 'td' }, chainBadge(app.chain)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(app.rx)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(app.tx)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(total)),
				E('td', { 'class': 'td', style: 'width:120px' }, [
					E('div', {
						style: 'height:6px;border-radius:3px;background:rgba(127,127,127,.2);overflow:hidden'
					}, E('div', {
						style: 'height:6px;width:' + percent.toFixed(1) + '%;background:#2b7de9'
					})),
					E('span', { style: 'font-size:11px;opacity:.7' }, percent.toFixed(1) + '%')
				])
			]);
		});

		return E('div', {}, [
			E('div', { style: 'font-size:12px;opacity:.85;margin-bottom:6px' }, [
				_('设备') + ' ' + deviceName(dev),
				dev.mac ? ' · ' + dev.mac : '',
				dev.ip ? ' · ' + dev.ip : '',
				' · ',
				_('接入') + ' ' + (LINK_STYLE[linkOf(dev)] != null ? _(LINK_STYLE[linkOf(dev)].label) : '-'),
				' · ',
				_('应用明细') + ' ' + list.length + ' ' + _('项')
			]),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('应用/域名')),
					E('th', { 'class': 'th' }, _('出口')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('下载')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('上传')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('合计')),
					E('th', { 'class': 'th' }, _('占比'))
				])
			].concat(rows)),
			dev.apps_truncated === true
				? E('p', { style: 'font-size:12px;opacity:.7;margin:6px 0 0 0' },
					_('后端为控制返回体积做了裁剪，这里只列出部分应用（__other__ 为其余合并项）。'))
				: ''
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
