'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 流量统计 · 设备
 *
 * 只消费 state.devices（不碰顶层 apps），一次 rpc 调用。
 * 点行展开该设备的应用分布：明细按需构建（首次展开时才生成 DOM），
 * 200 台设备也不会在加载时把几千个节点塞进页面。
 *
 * 设备元数据 / 配额 / 导出（SPEC §10）：
 *   - 别名、分组：`set_device_meta {mac, alias, group}`（空串 = 清除该字段）。
 *     弹窗里的改动按 MAC 存进内存草稿，RPC 失败或点「取消」都不会丢，
 *     再次打开同一台设备会带出草稿；只有保存成功或显式「放弃修改」才清掉。
 *   - 本月用量：后端 `month_rx/month_tx/month_total`；`quota_limit` 只在
 *     quota_mode=device 时出现，剩余量 = limit - used（分母 0 时显示 —）。
 *   - CSV：`export_csv {what:'devices'}` 返回带 BOM/CRLF 的字符串，原样存盘。
 *
 * 所有动态值都走 E()/textContent，不拼 HTML 字符串。窄屏隐藏次要列（MAC/IP/
 * 首次出现/信号），剩余列在表格容器内横向滚动，页面本身不会横向失控。
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

/* 这个页面的表格在窄屏隐藏次要列；CSS 只作用于本页容器。 */
var CSS = [
	'#ts-devices .tsd-tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
	'#ts-devices table{min-width:940px}',
	'#ts-devices .tsd-sub{font-size:11px;opacity:.65;line-height:1.5;white-space:nowrap}',
	'#ts-devices .tsd-alias-name{font-weight:600;word-break:break-word}',
	'#ts-devices .tsd-edit{padding:1px 7px;font-size:11px;line-height:1.6;margin-left:6px;white-space:nowrap}',
	'#ts-devices .tsd-new{display:inline-block;margin-left:5px;padding:0 5px;border-radius:6px;font-size:10px;',
	'line-height:1.6;background:rgba(198,40,40,.14);color:#c62828;vertical-align:middle}',
	'#ts-devices .tsd-quota{min-width:92px;text-align:right}',
	'@media (max-width:760px){',
	'#ts-devices .tsd-opt{display:none}',
	'#ts-devices table{min-width:0}',
	'#ts-devices .tsd-tablewrap{overflow-x:visible}',
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

return view.extend({
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
		var state = this.state;

		this.drafts = this.drafts || {};
		this.dialog = null;
		this.aliasCells = {};
		this.exportStatus = E('span', { style: 'font-size:12px;margin-left:8px;opacity:.85' }, '');

		if (state == null || !Array.isArray(state.devices) || state.devices.length == 0) {
			this.root = E('div', { 'id': 'ts-devices' }, [
				E('style', {}, CSS),
				E('h2', {}, _('流量统计 · 设备')),
				this.renderEmpty()
			]);

			return this.root;
		}

		var devices = state.devices.slice().sort(function(a, b) {
			return deviceTotal(b) - deviceTotal(a);
		});

		var rows = [];

		for (var i = 0; i < devices.length; i++)
			/* renderDeviceRow 返回 [主行, 详情行]，必须 concat 展开；push 会变成嵌套数组，
			   被 E() 当成字符串渲染成 [object HTMLTableRowElement]。 */
			rows = rows.concat(this.renderDeviceRow(devices[i]));

		var quota = totalQuota(state);
		var summary = E('div', { style: 'margin:0 0 12px 0;font-size:12px;opacity:.85;line-height:1.8' }, [
			E('div', {}, [
				_('共') + ' ' + devices.length + ' ' + _('台设备'),
				state.truncated === true ? ' · ' + _('数据过大，后端已裁剪（仅显示使用量最高的部分）') : '',
				' · ',
				this.linkSummary(state),
				_('点击任意一行展开该设备的应用分布')
			]),
			quota == null ? '' : E('div', { style: 'white-space:normal' }, [
				_('全屋本月配额') + '（' + (quota.period || _('本月')) + _('）') + '：',
				_('已用') + ' ' + fmtBytes(quota.used) + ' / ' + fmtBytes(quota.limit) + ' · ',
				_('剩余') + ' ' + fmtBytes(Math.max(0, quota.remaining)) + '（' + quota.pct.toFixed(1) + '%）'
			])
		]);

		var actions = E('div', {
			style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px 0'
		}, [
			E('button', {
				'class': 'cbi-button cbi-button-action',
				click: ui.createHandlerFn(this, function() { return this.exportCsv('devices'); })
			}, _('导出设备 CSV')),
			this.exportStatus
		]);

		this.root = E('div', { 'id': 'ts-devices' }, [
			E('style', {}, CSS),
			E('h2', {}, _('流量统计 · 设备')),
			summary,
			actions,
			E('div', { 'class': 'tsd-tablewrap' }, E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('主机名')),
					E('th', { 'class': 'th' }, _('别名 / 分组')),
					E('th', { 'class': 'th tsd-opt', title: _('守护进程首次看到该 MAC 的时间（本地时区）') }, _('首次出现')),
					E('th', {
						'class': 'th',
						title: _('接入方式：主路由桥 FDB 里该设备 MAC 学在哪个端口（无线/有线），与代理/直连无关')
					}, _('接入')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('直连')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('代理')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('合计')),
					E('th', { 'class': 'th', style: 'text-align:right', title: _('本月 1 号至今的 rx+tx（只读 daily/，跨月自动归零）') }, _('本月')),
					E('th', { 'class': 'th tsd-quota', title: _('剩余 = 配额 - 本月用量；未配置配额时显示 —') }, _('配额剩余')),
					E('th', { 'class': 'th', style: 'text-align:right', title: _('Mb/s（bits），悬浮显示十进制 MB/s') }, _('速率')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('最后在线')),
					E('th', {
						'class': 'th tsd-opt',
						style: 'text-align:right',
						title: _('来自哑桥 AP 的无线信号（仅元数据，不含流量）')
					}, _('信号'))
				])
			].concat(rows)))
		]);

		return this.root;
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

		if (state == null) {
			message = _('暂时读不到设备列表：rpcd 对象 traffic-stats 不可用，或者后端尚未安装。');
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
				E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页')),
				' · ',
				E('a', { href: L.url('admin/services/traffic-stats/overview') }, _('返回总览'))
			])
		]);
	},

	renderDeviceRow: function(dev) {
		var direct = num(dev.direct_rx) + num(dev.direct_tx);
		var proxy = num(dev.proxy_rx) + num(dev.proxy_tx);
		var total = direct + proxy;
		var name = deviceName(dev);
		var mac = macKey(dev);
		var marker = E('span', {
			style: 'display:inline-block;width:12px;opacity:.6',
			title: _('展开应用分布')
		}, '▸');

		var cell = E('td', {
			'class': 'td',
			colspan: 12,
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

		var firstSeen = num(dev.first_seen);

		var row = E('tr', {
			'class': 'tr',
			style: 'cursor:pointer',
			title: _('点击展开/收起该设备的应用分布')
		}, [
			E('td', { 'class': 'td' }, [
				marker,
				' ',
				E('strong', {}, shorten(name, 30)),
				isNewDevice(dev) ? E('span', { 'class': 'tsd-new', title: _('first_seen 在 24 小时内') }, _('新')) : '',
				dev.mac ? E('div', { 'class': 'tsd-sub' }, E('code', {}, '' + dev.mac)) : '',
				dev.ip ? E('div', { 'class': 'tsd-sub' }, E('code', {}, '' + dev.ip)) : '',
				/* 首次出现也放在主列的小字里：窄屏隐藏独立列后仍然看得到。 */
				firstSeen > 0 ? E('div', { 'class': 'tsd-sub' }, _('首次') + ' ' + fmtDate(firstSeen)) : ''
			]),
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
			this.renderSignal(dev)
		]);

		row.addEventListener('click', function() {
			open = !open;
			detailRow.style.display = open ? '' : 'none';
			marker.textContent = open ? '▾' : '▸';

			if (open && !filled) {
				filled = true;
				dom.content(cell, this.renderApps(dev));
			}
		}.bind(this));

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

	/* 接入列：无线 / 有线 / 未知；字段缺失（老后端）显示 "-"。
	   数据来自主路由的桥 FDB（见守护进程 brctl showmacs），与字节来源无关。 */
	renderLink: function(dev) {
		var kind = linkOf(dev);
		var style = LINK_STYLE[kind];

		if (style == null)
			return E('td', { 'class': 'td' }, '-');

		return E('td', { 'class': 'td' }, E('span', {
			style: 'font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap;color:' +
				style.color + ';background:' + style.bg
		}, _(style.label)));
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
		var apps = (dev.apps != null && typeof dev.apps == 'object') ? dev.apps : {};
		var list = [];

		for (var host in apps) {
			if (!apps.hasOwnProperty(host)) continue;

			list.push({
				host: host,
				rx: num(apps[host] && apps[host].rx),
				tx: num(apps[host] && apps[host].tx),
				chain: (apps[host] && apps[host].chain) ? '' + apps[host].chain : ''
			});
		}

		if (list.length == 0)
			return E('div', {}, E('em', { style: 'opacity:.7' }, _('该设备暂无应用明细')));

		list.sort(function(a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

		var sum = 0;

		for (var i = 0; i < list.length; i++)
			sum += list[i].rx + list[i].tx;

		var rows = list.map(function(app) {
			var total = app.rx + app.tx;
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
