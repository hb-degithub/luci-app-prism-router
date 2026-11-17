'use strict';
'require view';
'require rpc';
'require dom';
'require uci';

/*
 * 流量详细面板（独立窗口 · 分类标签页）
 *
 * 形态：从概览页「详细面板」按钮新窗口打开（admin/services/prism-router/panel），
 * 所以本页隐藏 LuCI 侧栏与页头，让内容铺满整个视口（applyFullscreen，沿用原逻辑）。
 *
 * 七个标签，共用同一份 state，切标签不重新请求后端：
 *   历史 / 设备 / 应用 / 节点 / 拓扑 / 系统 / 设置
 *
 * 「拓扑」是只读的横向分层视图：互联网 → 出口 → 主路由 → AP → 在网设备。
 * 出口卡 / AP 卡可点开下钻（最多 8 台在线设备，按速率降序），展开状态按出口名 /
 * AP node_id 记忆并纳入 topoSignature，刷新不丢、数据没变不重建。
 * 数据只来自已有的 get_state / get_nodes / get_stations（get_stations 失败只降级 AP 层）。
 *
 * 懒加载：首屏只请求 get_state（+ 今日 history）；get_nodes 在首次切到「节点」/「拓扑」
 * 时补一次，get_stations 在首次切到「拓扑」时补一次，拿到后复用；
 * 15s 轮询只刷新当前标签真正需要的那一份快照，其它标签不产生额外 RPC。
 *
 * 这里**没有**「概览」：那只是把 LuCI 概览页放大一遍（6 张 KPI + 趋势 + 比例条 + Top10），
 * 用户明确不要。健康状况改由顶部一行紧凑状态摘要表达（运行状态 / confidence /
 * 更新时间 / 在线设备数），不放 KPI 大卡、不放排行榜。
 *
 * 数据来源只有五个（不新增任何后端方法）：
 *   prism-router.get_state    —— totals / devices / apps / nodes / system / health
 *   prism-router.get_history  —— 今日 5 分钟桶（days=1）；历史页切到「近 7 / 30 天」时才请求
 *   prism-router.get_nodes    —— 子节点快照（首次切到「节点」/「拓扑」时拉取，之后共用）
 *   prism-router.get_stations —— AP 上报快照（首次切到「拓扑」时拉取；失败降级不抛错）
 *   uci('prism-router')       —— 设置页只读展示
 *
 * 降级约定（硬要求）：
 *   - 任何字段缺失都走文案，不显示 0 / NaN / undefined，也不白屏；
 *   - 每个标签的渲染都套 try/catch，单页出错只影响该页，其它标签照常；
 *   - 15s 自动刷新只重绘当前标签，切标签不打断定时器，也不重复请求没变化的 history；
 *   - get_history 有 ubus 单条消息上限：近 30 天失败时自动降级到近 7 天/今日并提示；
 *   - 不引外部库：趋势图用文件内的零依赖 SVG 渲染器（tsRenderLine）。
 */

var callState = rpc.declare({
	object: 'prism-router',
	method: 'get_state',
	expect: {},
	reject: true
});

/* 只有历史页切到近 7 / 30 天时才会多请求一次；失败降级并提示。 */
var callHistory = rpc.declare({
	object: 'prism-router',
	method: 'get_history',
	params: [ 'days' ],
	expect: {},
	reject: true
});

var callNodes = rpc.declare({
	object: 'prism-router',
	method: 'get_nodes',
	expect: { nodes: [] },
	reject: true
});

/*
 * AP 上报快照（只读）。老后端没有这个方法时 rpc 会 reject：
 * 只把「AP 数据不可用」写进 stationsError，其它层照常渲染，绝不往上抛。
 */
var callStations = rpc.declare({
	object: 'prism-router',
	method: 'get_stations',
	expect: { enabled: false, nodes: [], stations: [], count: 0 },
	reject: true
});

var REFRESH_MS = 15000;
var STALE_SEC = 300;             /* 节点超过 5 分钟未上报标黄 */
var ONLINE_SEC = 600;            /* 设备在线口径：last_seen 在 10 分钟内（与概览一致） */
var HISTORY_TIMEOUT_MS = 12000;  /* get_history 可能撑爆 ubus，给一个明确的超时降级点 */
var HISTORY_REFRESH_LONG_MS = 300000; /* 近 30 天报文大，自动刷新降到 5 分钟一次 */
var TREND_CHART_H = 360;         /* 大图高度下限，需求要求 ≥ 340px */
var PANEL_MAX_W = 1680;

/* 拓扑页：出口最多 6 张卡、设备每组最多 8 台；AP 上报 ≤5 分钟算在线（age_sec 0..300） */
var TOPO_MAX_NODES = 6;
var TOPO_MAX_DEVICES = 8;
var TOPO_AP_ONLINE_SEC = 300;

var TAB_DEFS = [
	{ id: 'history',  label: '历史' },
	{ id: 'devices',  label: '设备' },
	{ id: 'apps',     label: '应用' },
	{ id: 'nodes',    label: '节点' },
	{ id: 'topology', label: '拓扑' },
	{ id: 'system',   label: '系统' },
	{ id: 'settings', label: '设置' }
];

var RANGE_DEFS = [
	{ days: 1,  label: '今日' },
	{ days: 7,  label: '近 7 天' },
	{ days: 30, label: '近 30 天' }
];

var SERIES_DEFS = [
	{ key: 'total',  label: '总',   color: '#3949ab' },
	{ key: 'proxy',  label: '代理', color: '#1a73e8' },
	{ key: 'direct', label: '直连', color: '#34a853' },
	{ key: 'wifi',   label: '无线', color: '#a142f4' },
	{ key: 'wired',  label: '有线', color: '#f9ab00' }
];

/* 只读展示用的 UCI 默认值（与 prism-router.config 一致）；仅用于标注「默认」，不回写。 */
var UCI_DEFAULTS = {
	settings: {
		enabled: '1', poll_interval: '5', clash_api: '127.0.0.1:9090',
		fake_ip_ranges: '198.18.0.0/16', history_days: '7', lan_bridge: 'br-lan',
		link_refresh: '30', system_enabled: '1'
	},
	feishu: {
		enabled: '1', daily_time: '08:30', report_chat_enabled: '1'
	}
};

/* ---------------------------------------------------------------- 格式化 */

function num(v) {
	var n = Number(v);

	return isFinite(n) ? n : 0;
}

/* 数值字段的「有没有」：0 是合法值，null / undefined / '' / 非数字才算缺失。 */
function numOrNull(v) {
	if (v === null || v === undefined || v === '')
		return null;

	var n = Number(v);

	return isFinite(n) ? n : null;
}

function fmtBytes(v, digits) {
	var n = num(v);
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
	var i = 0;

	while (n >= 1024 && i < u.length - 1) {
		n /= 1024;
		i++;
	}

	if (i === 0)
		return Math.round(n) + ' B';

	return n.toFixed(digits == null ? 1 : digits) + ' ' + u[i];
}

/* 速率：入参是字节/秒，展示成 bit/s（与设备页口径一致）。 */
function fmtRate(v) {
	var n = num(v) * 8;

	if (n >= 1e9) return (n / 1e9).toFixed(2) + ' Gb/s';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mb/s';
	if (n >= 1e3) return (n / 1e3).toFixed(0) + ' kb/s';

	return Math.round(n) + ' b/s';
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

function fmtAgo(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = Math.max(0, Math.floor(Date.now() / 1000) - t);

	if (d < 5) return '在线';
	if (d < 60) return d + ' 秒前';
	if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
	if (d < 86400) return Math.floor(d / 3600) + ' 小时前';

	return Math.floor(d / 86400) + ' 天前';
}

function fmtAgeSec(age) {
	if (age == null || age < 0) return '未知';

	var sec = num(age);

	if (sec < 10) return '刚刚';
	if (sec < 60) return sec + ' 秒前';
	if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
	if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';

	return Math.floor(sec / 86400) + ' 天前';
}

function fmtClock(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function fmtHM(ts) {
	var d = new Date(num(ts) * 1000);

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtUptime(sec) {
	var s = Math.max(0, Math.floor(num(sec)));
	var d = Math.floor(s / 86400);
	var h = Math.floor((s % 86400) / 3600);
	var m = Math.floor((s % 3600) / 60);

	if (d > 0) return d + ' 天 ' + h + ' 小时';
	if (h > 0) return h + ' 小时 ' + m + ' 分';
	if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒';

	return s + ' 秒';
}

function pctOf(v) {
	var n = num(v);

	return Math.max(0, Math.min(100, n));
}

function pctColor(p) {
	return (p >= 90) ? '#d93025' : ((p >= 70) ? '#f9ab00' : '#1e8e3e');
}

function shortText(text, max) {
	var s = (text == null) ? '' : ('' + text);

	if (!s.length) return '—';
	if (s.length <= max) return s;

	return s.substring(0, max - 1) + '…';
}

function errText(e) {
	if (e == null) return '未知错误';
	if (typeof e === 'string') return (e.length ? e : '未知错误');
	if (e.message) return '' + e.message;

	try { return '' + e; }
	catch (x) { return '未知错误'; }
}

function flagOn(v, def) {
	if (v == null || v === '') v = def;

	var s = '' + v;

	return (s === '1' || s === 'true' || s === 'yes' || s === 'on');
}

/* ---------------------------------------------------------------- 小组件 */

function emptyBox(text, extra) {
	return E('div', { style: 'padding:22px 0;text-align:center;opacity:.6;font-size:13px' },
		[ text || _('暂无数据'), extra ? E('div', { style: 'margin-top:6px;font-size:12px' }, extra) : '' ]);
}

function centerBox(text) {
	return E('div', { style: 'height:100%;display:flex;align-items:center;justify-content:center;opacity:.55;font-size:13px;text-align:center;padding:0 12px' }, text);
}

function badge(text, color, bg) {
	return E('span', {
		style: 'font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap;color:' + color + ';background:' + bg
	}, text);
}

function card(title, body, extra) {
	return E('div', {
		style: 'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
			'border-radius:10px;padding:16px 18px;min-width:0'
	}, [
		E('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:12px;flex-wrap:wrap' }, [
			E('h3', { style: 'margin:0;font-size:15px;font-weight:600' }, title),
			extra || E('span')
		]),
		body
	]);
}

/*
 * 表格渲染器。
 * head 项：{ label, right, title, sortKey, mark, click }
 * rows 必须是「扁平的 tr 数组」——历史上把 [主行, 详情行] push 进 rows 会变成嵌套数组，
 * 被 E() 当成字符串渲染成 "[object HTMLTableRowElement]"，这里由调用方 concat 保证。
 */
function table(head, rows, emptyText) {
	if (!rows || !rows.length)
		return emptyBox(emptyText || _('暂无数据'));

	var titles = head.map(function (h) {
		var attrs = { 'class': 'th' };
		var style = 'white-space:nowrap' + (h.right ? ';text-align:right' : '');

		if (h.width) style += ';width:' + h.width;
		if (h.click) style += (style ? ';' : '') + 'cursor:pointer;user-select:none';
		if (h.title) attrs.title = h.title;
		if (h.sortKey) attrs['data-sort'] = h.sortKey;
		if (style) attrs.style = style;

		attrs.click = h.click;

		return E('th', attrs, h.mark ? [ h.label, E('span', { style: 'opacity:.7;margin-left:3px' }, h.mark) ] : h.label);
	});

	return E('table', { 'class': 'table', style: 'width:100%;font-size:13px' }, [
		E('tr', { 'class': 'tr table-titles' }, titles)
	].concat(rows));
}

function metricCard(key, label, value, sub, pct) {
	var body = [
		E('div', { style: 'font-size:12px;opacity:.65;margin-bottom:6px' }, label),
		E('div', { style: 'font-size:22px;font-weight:600;line-height:1.2' }, value)
	];

	if (pct != null && isFinite(+pct)) {
		body.push(E('div', {
			style: 'height:6px;border-radius:3px;background:rgba(127,127,127,.2);overflow:hidden;margin:10px 0 4px'
		}, E('div', {
			style: 'height:6px;border-radius:3px;width:' + pctOf(pct).toFixed(1) + '%;background:' + pctColor(pctOf(pct))
		})));
	}

	if (sub) {
		body.push(E('div', {
			style: 'font-size:11px;opacity:.6;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
		}, sub));
	}

	return E('div', {
		'data-card': key,
		style: 'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
			'border-radius:10px;padding:14px 16px;min-width:0'
	}, body);
}

/* ---------------------------------------------------------------- 数据小工具 */

function historyDays(payload) {
	return (payload != null && Array.isArray(payload.days)) ? payload.days : [];
}

function deviceTotal(d) {
	return num(d && d.direct_rx) + num(d && d.direct_tx) + num(d && d.proxy_rx) + num(d && d.proxy_tx);
}

function deviceRate(d) {
	return num(d && d.rx_rate) + num(d && d.tx_rate);
}

function deviceName(d) {
	if (d == null) return _('未知设备');
	if (d.hostname && ('' + d.hostname).length) return '' + d.hostname;
	if (d.ip && ('' + d.ip).length) return '' + d.ip;
	if (d.mac && ('' + d.mac).length) return '' + d.mac;

	return _('未知设备');
}

function deviceKey(d) {
	if (d == null) return '';
	if (d.mac && ('' + d.mac).length) return 'mac:' + ('' + d.mac).toLowerCase();
	if (d.ip && ('' + d.ip).length) return 'ip:' + ('' + d.ip);
	if (d.hostname && ('' + d.hostname).length) return 'host:' + ('' + d.hostname);

	return 'row:' + deviceTotal(d);
}

/* 接入方式：枚举固定 wifi|wired|unknown（SPEC §3.2），字段缺失返回 ''。 */
function linkKey(d) {
	if (d == null || typeof d.link !== 'string') return '';

	var v = d.link.toLowerCase();

	return (v === 'wifi' || v === 'wired' || v === 'unknown') ? v : '';
}

/* 筛选时把「后端没给」也归到「未知」，否则这些设备在任何筛选下都会消失。 */
function linkFilterKey(d) {
	return linkKey(d) || 'unknown';
}

function linkMeta(d) {
	var k = linkFilterKey(d);

	if (k === 'wifi') return { label: _('无线'), color: '#7b1fa2', bg: 'rgba(123,31,162,.16)' };
	if (k === 'wired') return { label: _('有线'), color: '#00838f', bg: 'rgba(0,131,143,.16)' };

	return { label: _('未知'), color: '#9e9e9e', bg: 'rgba(158,158,158,.2)' };
}

function linkBadge(d) {
	if (linkKey(d) === '' && (d == null || d.link == null))
		return E('span', { style: 'opacity:.55;font-size:12px', title: _('后端未提供接入判定（桥 FDB 不可用或版本较旧）') }, '—');

	var m = linkMeta(d);

	return badge(m.label, m.color, m.bg);
}

/* 信号：优先 dev.signal，其次 dev.signal_dbm；没有就返回 null（显示 "—"，不显示 0）。 */
function signalValue(d) {
	var v = numOrNull(d && d.signal);

	if (v == null) v = numOrNull(d && d.signal_dbm);

	return (v == null || v < -120 || v > 0) ? null : v;
}

function signalColor(dbm) {
	if (dbm > -60) return '#2e7d32';
	if (dbm >= -75) return '#f0a020';

	return '#d3302f';
}

function appTotal(a) {
	return num(a && a.rx) + num(a && a.tx);
}

function appLabel(host) {
	var name = (host == null) ? '' : ('' + host);

	if (name === '__other__') return _('其他（合并）');
	if (!name.length) return _('未知应用');

	return name;
}

function chainBadge(chain) {
	var name = (chain && ('' + chain).length) ? ('' + chain) : '—';
	var direct = (name === 'DIRECT');
	var mixed = (name === 'MIXED');

	if (direct) return badge(_('直连'), '#137333', 'rgba(52,168,83,.15)');
	if (mixed) return badge(_('混合'), '#5f6368', 'rgba(95,99,104,.15)');

	return badge(name, '#1a73e8', 'rgba(26,115,232,.12)');
}

function ipSortKey(ip) {
	var s = (ip == null) ? '' : ('' + ip);
	var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);

	if (!m) return '\uffff' + s;

	var p = function (x) { var t = '' + x; return (t.length < 3) ? ('000' + t).slice(-3) : t; };

	return p(m[1]) + '.' + p(m[2]) + '.' + p(m[3]) + '.' + p(m[4]);
}

/* ---------------------------------------------------------------- 趋势数据 */

/*
 * 把 get_history 的返回投影成折线点。
 *
 * days=1：当日 5 分钟桶（history.json 里也可能残留昨天最后一桶），标签 HH:MM。
 * days>1：每天一个点——当天有桶就用桶求和，往日只有每日汇总（summary.totals），
 *         标签 MM-DD。这符合 SPEC §3.1「不承诺跨天 5 分钟精度」。
 *
 * 只有真在桶 / 汇总里出现过的维度才标记为 has，缺失的曲线在界面上自动隐藏。
 */
function buildTrend(range, payload) {
	var days = historyDays(payload);
	var points = [];
	var has = { wifi: false, wired: false };
	var i, j;

	if (range === 1) {
		var buckets = [];

		for (i = 0; i < days.length; i++)
			if (days[i] && Array.isArray(days[i].buckets))
				buckets = buckets.concat(days[i].buckets);

		buckets.sort(function (a, b) { return num(a && a.ts) - num(b && b.ts); });

		for (j = 0; j < buckets.length; j++) {
			var b = buckets[j] || {};

			var wifi = (numOrNull(b.wifi_rx) != null || numOrNull(b.wifi_tx) != null)
				? num(b.wifi_rx) + num(b.wifi_tx) : null;
			var wired = (numOrNull(b.wired_rx) != null || numOrNull(b.wired_tx) != null)
				? num(b.wired_rx) + num(b.wired_tx) : null;

			if (wifi != null) has.wifi = true;
			if (wired != null) has.wired = true;

			points.push({
				label: fmtHM(b.ts),
				total: num(b.direct_rx) + num(b.direct_tx) + num(b.proxy_rx) + num(b.proxy_tx),
				proxy: num(b.proxy_rx) + num(b.proxy_tx),
				direct: num(b.direct_rx) + num(b.direct_tx),
				wifi: wifi,
				wired: wired
			});
		}
	}
	else {
		var list = days.slice().sort(function (a, b) {
			var x = '' + ((a && a.day) || '');
			var y = '' + ((b && b.day) || '');

			return (x < y) ? -1 : ((x > y) ? 1 : 0);
		});

		for (i = 0; i < list.length; i++) {
			var d = list[i] || {};
			var got = null;

			if (Array.isArray(d.buckets) && d.buckets.length) {
				var sum = { direct: 0, proxy: 0, wifi: 0, wired: 0, anyWifi: false, anyWired: false };

				for (j = 0; j < d.buckets.length; j++) {
					var bb = d.buckets[j] || {};

					sum.direct += num(bb.direct_rx) + num(bb.direct_tx);
					sum.proxy += num(bb.proxy_rx) + num(bb.proxy_tx);

					if (numOrNull(bb.wifi_rx) != null || numOrNull(bb.wifi_tx) != null) {
						sum.anyWifi = true;
						sum.wifi += num(bb.wifi_rx) + num(bb.wifi_tx);
					}

					if (numOrNull(bb.wired_rx) != null || numOrNull(bb.wired_tx) != null) {
						sum.anyWired = true;
						sum.wired += num(bb.wired_rx) + num(bb.wired_tx);
					}
				}

				got = {
					direct: sum.direct, proxy: sum.proxy,
					wifi: sum.anyWifi ? sum.wifi : null,
					wired: sum.anyWired ? sum.wired : null
				};
			}
			else if (d.summary && d.summary.totals) {
				var t = d.summary.totals;

				got = {
					direct: num(t.direct_rx) + num(t.direct_tx),
					proxy: num(t.proxy_rx) + num(t.proxy_tx),
					wifi: (numOrNull(t.wifi_rx) != null || numOrNull(t.wifi_tx) != null)
						? num(t.wifi_rx) + num(t.wifi_tx) : null,
					wired: (numOrNull(t.wired_rx) != null || numOrNull(t.wired_tx) != null)
						? num(t.wired_rx) + num(t.wired_tx) : null
				};
			}

			if (got == null) continue;

			if (got.wifi != null) has.wifi = true;
			if (got.wired != null) has.wired = true;

			points.push({
				label: ('' + (d.day || '')).length === 10 ? ('' + d.day).slice(5) : ('' + (d.day || '')),
				total: got.direct + got.proxy,
				proxy: got.proxy,
				direct: got.direct,
				wifi: got.wifi,
				wired: got.wired
			});
		}
	}

	return { points: points, has: has };
}

function chartDataFromTrend(trend, enabled) {
	var labels = trend.points.map(function (p) { return p.label; });
	var datasets = [];

	for (var i = 0; i < SERIES_DEFS.length; i++) {
		var s = SERIES_DEFS[i];

		if (!enabled || !enabled[s.key]) continue;
		if ((s.key === 'wifi' || s.key === 'wired') && !trend.has[s.key]) continue;

		datasets.push({
			label: s.label,
			strokeColor: s.color,
			data: trend.points.map(function (p) {
				return (p[s.key] == null) ? 0 : Math.round(p[s.key]);
			})
		});
	}

	return { labels: labels, datasets: datasets };
}

/*
 * 每日汇总：把 get_history 的 days[] 拍平成「一天一行」。
 *
 * 和 buildTrend 的区别：buildTrend 是给折线用的（近 7/30 天每天一个点），这里给表格用，
 * 更关心「哪些列真的采集到了」——wifi/wired 在每日汇总文件里通常没有（守护进程只写
 * direct/proxy），那就留 null，界面上显示「—」，绝不补 0 冒充"当天没有无线流量"。
 */
function dailyRowOf(d) {
	var day = (d != null && d.day != null) ? ('' + d.day) : '';
	var buckets = (d != null && Array.isArray(d.buckets)) ? d.buckets : [];
	var row = { day: day, total: null, proxy: null, direct: null, wifi: null, wired: null };
	var i, b;

	if (buckets.length) {
		var direct = 0, proxy = 0, wifi = 0, wired = 0;
		var anyWifi = false, anyWired = false;

		for (i = 0; i < buckets.length; i++) {
			b = buckets[i] || {};

			direct += num(b.direct_rx) + num(b.direct_tx);
			proxy += num(b.proxy_rx) + num(b.proxy_tx);

			if (numOrNull(b.wifi_rx) != null || numOrNull(b.wifi_tx) != null) {
				anyWifi = true;
				wifi += num(b.wifi_rx) + num(b.wifi_tx);
			}

			if (numOrNull(b.wired_rx) != null || numOrNull(b.wired_tx) != null) {
				anyWired = true;
				wired += num(b.wired_rx) + num(b.wired_tx);
			}
		}

		row.direct = direct;
		row.proxy = proxy;
		row.total = direct + proxy;
		row.wifi = anyWifi ? wifi : null;
		row.wired = anyWired ? wired : null;
	}
	/*
	 * 历史日的 daily 文件没有 buckets，后端只保证 summary.totals 兼容
	 * （devices/apps 可能因 ubus 体积预算被裁剪）。这里只读 totals 的
	 * direct/proxy/rx/tx；wifi/wired 缺字段时保持 null → 显示 —，不补 0。
	 */
	else if (d != null && d.summary != null && typeof d.summary === 'object' &&
		d.summary.totals != null && typeof d.summary.totals === 'object') {
		var t = d.summary.totals;
		var directB = num(t.direct_rx) + num(t.direct_tx);
		var proxyB = num(t.proxy_rx) + num(t.proxy_tx);

		row.direct = directB;
		row.proxy = proxyB;
		row.total = (numOrNull(t.rx) != null && numOrNull(t.tx) != null)
			? num(t.rx) + num(t.tx)
			: directB + proxyB;
		row.wifi = (numOrNull(t.wifi_rx) != null || numOrNull(t.wifi_tx) != null)
			? num(t.wifi_rx) + num(t.wifi_tx) : null;
		row.wired = (numOrNull(t.wired_rx) != null || numOrNull(t.wired_tx) != null)
			? num(t.wired_rx) + num(t.wired_tx) : null;
	}

	return row;
}

function dailyRowsOf(payload) {
	var days = historyDays(payload);
	var out = [];

	for (var i = 0; i < days.length; i++)
		out.push(dailyRowOf(days[i]));

	return out;
}

/* ------------------------------------------------------------------ *
 * 零依赖 SVG 折线渲染器
 *
 * 为什么不用 Chart.js：luci-lib-chartjs 里自带的是 nlbwmon 的精简构建，
 * Chart.prototype 上只有 Doughnut / Pie，没有 Line（实测会抛
 * "(intermediate value).Line is not a function"）。引外部 CDN 不可行，
 * 所以趋势图自己用 SVG 画，零依赖、可缩放、支持明暗主题（用半透明中性色）。
 *
 * 尺寸：按宿主的实际像素宽高生成 viewBox（挂载后再画一次），这样文字不会被拉伸。
 *
 * 轴标签与图例可能来自后端（日期/数据集名称），所以全部用
 * createElementNS + textContent 创建，不拼 HTML 字符串，避免被当成标记解析。
 * ------------------------------------------------------------------ */

var SVG_NS = 'http://www.w3.org/2000/svg';

function clearChildren(node) {
	while (node != null && node.firstChild)
		node.removeChild(node.firstChild);
}

function svgNode(name, attrs, text) {
	var node = document.createElementNS(SVG_NS, name);

	if (attrs != null) {
		for (var key in attrs) {
			if (attrs.hasOwnProperty(key))
				node.setAttribute(key, '' + attrs[key]);
		}
	}

	if (text != null) node.textContent = '' + text;

	return node;
}

function tsRenderLine(host, data, opts) {
	if (host == null) return null;

	opts = opts || {};

	var labels = (data && data.labels) || [];
	var sets = ((data && data.datasets) || []).filter(function (s) { return s && s.data && s.data.length; });

	if (!labels.length || !sets.length) return null;

	var W = Math.max(320, Math.round(opts.width || host.clientWidth || 900));
	var H = Math.max(120, Math.round(opts.height || host.clientHeight || 240));
	var PL = 68, PR = 14, PT = 10, PB = 26;
	var ticks = Math.max(1, Math.round(opts.yTicks || 4));

	var max = 0;

	sets.forEach(function (s) { s.data.forEach(function (v) { if (+v > max) max = +v; }); });
	if (!(max > 0)) max = 1;

	var n = labels.length;
	var fmtY = opts.fmtY || function (v) { return Math.round(v) + ''; };
	var x = function (i) { return PL + (n === 1 ? 0 : (W - PL - PR) * i / (n - 1)); };
	var y = function (v) { return H - PB - (H - PT - PB) * (Math.max(0, +v) / max); };

	var svg = svgNode('svg', {
		viewBox: '0 0 ' + W + ' ' + H,
		preserveAspectRatio: 'none',
		style: 'width:100%;height:100%;display:block'
	});
	var g, gy, i;

	for (g = 0; g <= ticks; g++) {
		gy = PT + (H - PT - PB) * g / ticks;
		svg.appendChild(svgNode('line', {
			x1: PL, y1: gy.toFixed(1), x2: W - PR, y2: gy.toFixed(1),
			stroke: 'rgba(127,127,127,.16)', 'stroke-width': 1
		}));
		svg.appendChild(svgNode('text', {
			x: PL - 6, y: (gy + 3).toFixed(1), 'font-size': 10,
			fill: 'rgba(127,127,127,.85)', 'text-anchor': 'end'
		}, fmtY(max * (1 - g / ticks))));
	}

	sets.forEach(function (s) {
		var d = s.data.map(function (v, idx) {
			return (idx ? 'L' : 'M') + x(idx).toFixed(1) + ' ' + y(v).toFixed(1);
		}).join(' ');

		svg.appendChild(svgNode('path', {
			d: d,
			fill: 'none',
			stroke: s.strokeColor || '#1a73e8',
			'stroke-width': 2,
			'stroke-linejoin': 'round',
			'stroke-linecap': 'round',
			'vector-effect': 'non-scaling-stroke'
		}));
	});

	var step = Math.max(1, Math.ceil(n / 8));

	for (i = 0; i < n; i += step) {
		svg.appendChild(svgNode('text', {
			x: x(i).toFixed(1), y: H - 8, 'font-size': 10,
			fill: 'rgba(127,127,127,.85)', 'text-anchor': 'middle'
		}, labels[i]));
	}

	var legend = null;

	if (opts.legend !== false) {
		legend = E('div', { style: 'font-size:11px;opacity:.75;padding:6px 0 0 4px' },
			sets.map(function (s) {
				return E('span', {
					style: 'display:inline-flex;align-items:center;gap:5px;margin-right:14px'
				}, [
					E('i', {
						style: 'width:10px;height:3px;border-radius:2px;display:inline-block;background:' +
							(s.strokeColor || '#1a73e8')
					}),
					(s.label || '')
				]);
			}));
	}

	var wrap = E('div', {
		style: 'width:100%;height:100%;display:flex;flex-direction:column'
	}, [
		E('div', { style: 'flex:1;min-height:0' }, svg),
		legend || ''
	]);

	clearChildren(host);
	dom.content(host, wrap);

	return {
		destroy: function() {
			try { clearChildren(host); }
			catch (e) { }
		}
	};
}

function confLook(conf) {
	if (conf === 'exact') return { text: _('记账精确'), color: '#137333', bg: 'rgba(52,168,83,.15)' };
	if (conf === 'degraded') return { text: _('记账降级'), color: '#b26a00', bg: 'rgba(249,171,0,.18)' };
	if (conf === 'unavailable') return { text: _('记账不可用'), color: '#c5221f', bg: 'rgba(217,48,37,.15)' };

	return { text: _('记账状态未知'), color: '#5f6368', bg: 'rgba(95,99,104,.15)' };
}

function tabStyle(active) {
	return 'font-size:14px;line-height:1.2;padding:7px 16px;border-radius:8px;cursor:pointer;' +
		'border:1px solid ' + (active ? '#1a73e8' : 'rgba(127,127,127,.35)') + ';' +
		'background:' + (active ? '#1a73e8' : 'transparent') + ';' +
		'color:' + (active ? '#fff' : 'inherit') + ';' +
		'font-weight:' + (active ? '600' : '400');
}

function chipStyle(active, color) {
	return 'font-size:12px;line-height:1.2;padding:5px 12px;border-radius:14px;cursor:pointer;' +
		'border:1px solid ' + (active ? (color || '#1a73e8') : 'rgba(127,127,127,.35)') + ';' +
		'background:' + (active ? (color || '#1a73e8') : 'transparent') + ';' +
		'color:' + (active ? '#fff' : 'inherit');
}

/* 趋势页的时间范围 / 曲线开关按钮 */
function chip(label, active, color, onclick) {
	return E('button', {
		type: 'button',
		'class': 'cbi-button',
		style: chipStyle(active, color),
		click: onclick
	}, label);
}

/* ---------------------------------------------------------------- 拓扑小件 */

/*
 * 层间连接件：1px 横线 + 圆点，纯 CSS 定位（不引图片、不拼字符）。
 * align-self:center 让它落在整行高度的一半，视觉上把左右两层连起来。
 */
function topoConnector() {
	return E('div', {
		style: 'flex:0 0 24px;width:24px;align-self:center;height:16px;position:relative;' +
			'display:flex;align-items:center;justify-content:center'
	}, [
		E('div', {
			style: 'position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(127,127,127,.45)'
		}),
		E('div', {
			style: 'position:relative;width:7px;height:7px;border-radius:50%;background:#1a73e8;' +
				'box-shadow:0 0 0 2px var(--background-color-high,#fff)'
		})
	]);
}

/* 拓扑层卡片：固定宽度 + 与其它页一致的卡片风格（暗色主题靠 LuCI 变量，不写死黑白） */
function topoLayer(title, width, body, extra) {
	return E('div', {
		'class': 'ts-topo-layer',
		style: 'box-sizing:border-box;flex:0 0 ' + width + 'px;width:' + width + 'px;min-width:0;' +
			'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
			'border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px'
	}, [
		E('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0' }, [
			E('span', { style: 'font-size:11px;letter-spacing:.04em;opacity:.62;white-space:nowrap' }, title),
			extra || E('span')
		]),
		E('div', { style: 'display:flex;flex-direction:column;gap:6px;min-width:0' }, body)
	]);
}

/* 地球：文件内零依赖 SVG（与趋势图同一套 svgNode），不引外部资源 */
function topoSvgGlobe(size) {
	var c = '#1a73e8';
	var svg = svgNode('svg', {
		width: size,
		height: size,
		viewBox: '0 0 24 24',
		role: 'img',
		'aria-label': _('互联网'),
		style: 'display:block'
	});

	svg.appendChild(svgNode('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: c, 'stroke-width': 1.6 }));
	svg.appendChild(svgNode('ellipse', { cx: 12, cy: 12, rx: 9, ry: 4, fill: 'none', stroke: c, 'stroke-width': 1, opacity: .7 }));
	svg.appendChild(svgNode('ellipse', { cx: 12, cy: 12, rx: 4.4, ry: 9, fill: 'none', stroke: c, 'stroke-width': 1, opacity: .7 }));
	svg.appendChild(svgNode('line', { x1: 3, y1: 12, x2: 21, y2: 12, stroke: c, 'stroke-width': 1, opacity: .7 }));

	return svg;
}

/*
 * AP 上报新鲜度：age_sec 0..300 算在线；>300 显示「N 分钟前」；
 * 负数 / 缺失一律「未上报」（不显示 -1，也不显示 NaN）。
 */
function topoFreshness(ageSec) {
	var age = numOrNull(ageSec);

	if (age == null || age < 0)
		return { text: _('未上报'), color: '#9e9e9e', bg: 'rgba(158,158,158,.2)', dot: '#9e9e9e', stale: true };

	if (age <= TOPO_AP_ONLINE_SEC)
		return { text: _('在线'), color: '#137333', bg: 'rgba(52,168,83,.15)', dot: '#1e8e3e', stale: false };

	var minutes = Math.max(1, Math.floor(age / 60));

	return { text: minutes + ' 分钟前', color: '#b26a00', bg: 'rgba(249,171,0,.18)', dot: '#f0a020', stale: true };
}

/* 拓扑里的小号「标签 + 值」行 */
function topoField(label, value, title) {
	return E('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0' }, [
		E('span', { style: 'font-size:11px;opacity:.6;white-space:nowrap' }, label),
		E('span', {
			style: 'font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right',
			title: title || ''
		}, value)
	]);
}

/* ---------------------------------------------------------------- 页面 */

return view.extend({
	load: function () {
		var self = this;

		this.state = null;
		this.stateError = null;
		this.hist = {};        /* days → get_history 返回体（只有请求过的范围才有 key） */
		this.histErr = {};     /* days → 失败原因 */
		this.histAt = {};      /* days → 最近一次成功请求的时间（ms），决定自动刷新频率 */
		this.histPending = {}; /* days → 该范围的请求是否进行中 */
		this.nodes = [];
		this.nodesError = null;
		this.nodesPending = false;
		this.nodesLoaded = false;   /* false = 还没成功拉过；空数组是合法结果，不反复重拉 */
		this.stations = null;   /* get_stations 返回体；null = 未拿到（拓扑页显示「AP 数据不可用」） */
		this.stationsError = null;
		this.stationsPending = false;
		this.uciOk = true;
		this.uciError = null;

		var attempt = function (fn) {
			try { return Promise.resolve(fn()); }
			catch (e) { return Promise.reject(e); }
		};

		return Promise.all([
			/* state 是所有标签的主数据源，失败也要把错误留住，页面照常渲染降级文案 */
			attempt(callState).then(function (st) {
				self.state = (st != null && typeof st === 'object') ? st : null;
				self.stateError = null;
			}).catch(function (err) {
				self.state = null;
				self.stateError = errText(err);
			}),

			/* 首屏先拿 days=1：历史页默认「今日」，切 7 / 30 天时再按需请求 */
			attempt(function () { return callHistory(1); }).then(function (h) {
				self.hist[1] = (h != null && typeof h === 'object') ? h : { days: [] };
				self.histAt[1] = Date.now();
				self.histErr[1] = '';
			}).catch(function (err) {
				self.hist[1] = null;
				self.histErr[1] = errText(err);
			}),

			/* 设置页只读展示；读不到 UCI 不影响其它标签 */
			attempt(function () { return uci.load('prism-router'); }).then(function () {
				self.uciOk = true;
				self.uciError = null;
			}).catch(function (err) {
				self.uciOk = false;
				self.uciError = errText(err);
			})
		]);
	},

	/* 隐藏 LuCI 侧栏与页面头部，让本页铺满窗口（这是"独立窗口"形态的关键） */
	applyFullscreen: function () {
		if (document.getElementById('ts-panel-fs'))
			return;

		var css = [
			'#mainmenu.main-left{display:none!important}',
			'.main-right{left:0!important;margin-left:0!important;width:100%!important;padding-left:0!important}',
			'.main-right>header,.main-right>.main-right-header{display:none!important}',
			'.main{padding-left:0!important;margin-left:0!important}',
			'#maincontent{padding:14px 18px!important;max-width:none!important}',
			'.main-bg{display:none!important}',
			'#ts-panel-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px 0;',
			'  padding:0 0 10px 0;border-bottom:1px solid rgba(127,127,127,.22)}',
			'#ts-panel-tabs button:hover{opacity:.88}',
			'#ts-panel .table .th,#ts-panel .table .td{padding:6px 8px}',
			'#ts-panel-status strong{font-weight:600}',
			/* 拓扑出口 / AP 卡可点：hover / 键盘焦点给个明确反馈 */
			'#ts-panel .ts-topo-card:hover{background:rgba(127,127,127,.10)}',
			'#ts-panel .ts-topo-card:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}',
			'#ts-panel .ts-topo-sub{background:rgba(127,127,127,.10);border-radius:6px}',
			/* 深色主题：面板自己的中性色一律用 rgba，不写死白底 / 深色文字（卡内文字继承主题色） */
			'@media (prefers-color-scheme:dark){',
			'  #ts-panel .ts-topo-layer,#ts-panel .ts-topo-card{',
			'    background:rgba(127,127,127,.12)!important;border-color:rgba(127,127,127,.34)!important}',
			'  #ts-panel .ts-topo-card:hover,#ts-panel .ts-topo-sub{background:rgba(127,127,127,.18)!important}',
			'  #ts-panel #ts-panel-status{background:rgba(127,127,127,.12)!important}',
			'}'
		].join('\n');

		document.head.appendChild(E('style', { id: 'ts-panel-fs' }, css));
	},

	render: function () {
		this.applyFullscreen();

		this.tab = this.tab || 'history';
		this.range = (this.range === 7 || this.range === 30) ? this.range : 1;
		this.series = this.series || { total: true, proxy: true, direct: true, wifi: false, wired: false };
		this.dailySort = this.dailySort || { key: 'day', dir: -1 };
		this.devSort = this.devSort || { key: 'total', dir: -1 };
		this.devLink = this.devLink || 'all';
		this.devQuery = this.devQuery || '';
		this.appChain = this.appChain || 'all';
		this.expanded = this.expanded || {};
		this.expandedApps = this.expandedApps || {};
		this.topoOpen = this.topoOpen || {};   /* 拓扑页展开的应用明细 */
		this.topoExitOpen = this.topoExitOpen || {}; /* 出口下钻：出口名 → true */
		this.topoApOpen = this.topoApOpen || {};     /* AP 下钻：AP node_id → true */
		this.topoCache = null;                 /* 拓扑整块 DOM 缓存：数据没变就不重建 */
		this.refreshError = null;
		this.busy = false;
		this.histNotice = '';
		this.hist = this.hist || {};
		this.histErr = this.histErr || {};
		this.histAt = this.histAt || {};
		this.histPending = this.histPending || {};

		this.header = this.buildHeader();
		this.statusLine = this.buildStatus();
		this.tabBar = this.buildTabs();
		this.sectionHost = E('div', { id: 'ts-panel-section' }, '');

		this.root = E('div', {
			id: 'ts-panel',
			style: 'max-width:' + PANEL_MAX_W + 'px;margin:0 auto'
		}, [ this.header, this.statusLine, this.tabBar, this.sectionHost ]);

		this.updateStatus();
		this.renderSection();
		this.scheduleRefresh();

		return this.root;
	},

	/* ------------------------------------------------------------ 顶栏 */

	buildHeader: function () {
		var self = this;

		return E('div', {
			id: 'ts-panel-header',
			style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap'
		}, [
			E('h2', { style: 'margin:0;font-size:20px' }, _('流量详细面板')),
			E('span', { style: 'flex:1' }, ''),
			E('button', {
				'class': 'cbi-button',
				type: 'button',
				title: _('立即刷新当前标签的数据（不会重新请求没变化的 history）'),
				click: function () { self.refreshNow(); }
			}, _('刷新')),
			E('button', {
				'class': 'cbi-button',
				type: 'button',
				click: function () { try { window.close(); } catch (e) { } }
			}, _('关闭'))
		]);
	},

	/*
	 * 紧凑状态摘要：运行状态 / confidence / 更新时间 / 在线设备数。
	 * 它是"这一屏能不能信"的最小信息，不是概览——所以没有 KPI 大卡、没有 Top 榜。
	 */
	buildStatus: function () {
		this.statusDot = E('span', {
			style: 'display:inline-block;width:8px;height:8px;border-radius:50%;background:#9e9e9e;flex:none'
		}, '');
		this.statusRun = E('strong', {}, _('状态未知'));
		this.statusConf = E('span', {}, '');
		this.statusUpdated = E('span', { style: 'opacity:.8' }, '');
		this.statusDevices = E('span', { style: 'opacity:.8' }, '');
		this.statusWarn = E('span', { style: 'color:#b26a00' }, '');

		return E('div', {
			id: 'ts-panel-status',
			style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px;' +
				'padding:7px 12px;margin:0 0 12px;border:1px solid rgba(127,127,127,.22);' +
				'border-radius:8px;background:rgba(127,127,127,.06)'
		}, [
			E('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, [ this.statusDot, this.statusRun ]),
			E('span', { style: 'opacity:.3' }, '|'),
			this.statusConf,
			E('span', { style: 'opacity:.3' }, '|'),
			this.statusUpdated,
			E('span', { style: 'opacity:.3' }, '|'),
			this.statusDevices,
			this.statusWarn
		]);
	},

	updateStatus: function () {
		if (this.statusRun == null) return;

		var st = this.state;
		var health = (st != null && st.health != null) ? st.health : {};
		var look = confLook(health.accounting_confidence);
		var reasons = Array.isArray(health.reasons) ? health.reasons : [];
		var devices = (st != null && Array.isArray(st.devices)) ? st.devices : [];
		var nowSec = Math.floor(Date.now() / 1000);
		var online = 0;

		for (var i = 0; i < devices.length; i++) {
			var seen = num(devices[i] && devices[i].last_seen);

			/* 在线口径：last_seen 必须是正数且在 10 分钟内（与概览/feishu 一致）。 */
			if (seen > 0 && seen <= nowSec + 60 && (nowSec - seen) <= ONLINE_SEC) online++;
		}

		var running = (st != null) ? st.running : null;
		var conf = '' + (health.accounting_confidence == null ? 'unknown' : health.accounting_confidence);
		var color;

		if (st == null)
			color = '#9e9e9e';
		else if (running === false || conf === 'unavailable')
			color = '#d93025';
		else if (conf === 'degraded' || reasons.length > 0)
			color = '#b26a00';
		else
			color = '#1e8e3e';

		this.statusDot.style.background = color;

		if (st == null)
			this.statusRun.textContent = _('读不到运行状态');
		else if (running === true)
			this.statusRun.textContent = (conf === 'exact' && reasons.length === 0)
				? _('运行中')
				: _('运行中（降级）');
		else if (running === false)
			this.statusRun.textContent = _('已停止');
		else
			this.statusRun.textContent = _('运行状态未知');

		this.statusRun.style.color = color;

		/* 状态文字与颜色保持一致：unavailable 绝不显示成健康绿。 */
		this.statusConf.textContent = look.text;
		this.statusConf.style.color = look.color;

		if (this.refreshError)
			this.statusUpdated.textContent = _('更新失败，显示上次数据');
		else if (st == null)
			this.statusUpdated.textContent = _('暂无数据');
		else if (num(st.ts) > 0)
			this.statusUpdated.textContent = _('更新于') + ' ' + fmtClock(st.ts);
		else
			this.statusUpdated.textContent = _('暂无数据');

		this.statusDevices.textContent = (st == null)
			? _('在线设备 —')
			: (_('在线设备') + ' ' + online + ' / ' + devices.length);

		this.statusWarn.textContent = (st != null && st.truncated === true) ? _('· 数据已裁剪') : '';
	},

	/* ------------------------------------------------------------ 标签栏 */

	buildTabs: function () {
		var self = this;

		this.tabButtons = {};

		var buttons = TAB_DEFS.map(function (t) {
			var btn = E('button', {
				'class': 'cbi-button',
				type: 'button',
				role: 'tab',
				'data-tab': t.id,
				style: tabStyle(t.id === self.tab),
				click: function () { self.setTab(t.id); }
			}, _(t.label));

			self.tabButtons[t.id] = btn;

			return btn;
		});

		return E('div', { id: 'ts-panel-tabs', role: 'tablist' }, buttons);
	},

	updateTabs: function () {
		for (var i = 0; i < TAB_DEFS.length; i++) {
			var id = TAB_DEFS[i].id;
			var btn = this.tabButtons ? this.tabButtons[id] : null;

			if (!btn) continue;

			var active = (this.tab === id);

			btn.setAttribute('style', tabStyle(active));
			btn.setAttribute('aria-selected', active ? 'true' : 'false');
		}
	},

	/* 切标签只重绘内容区：state / history 全部复用，不请求后端 */
	setTab: function (id) {
		if (!this.tabButtons || !this.tabButtons[id] || this.tab === id)
			return;

		this.tab = id;

		/* 懒加载：只有进到需要快照的标签才请求，拿到一次后复用（失败时下次切回来再试一次） */
		if (id === 'topology') {
			this.ensureStations();
			this.ensureNodes();
		}
		else if (id === 'nodes') {
			this.ensureNodes();
		}

		this.renderSection();
	},

	/* ------------------------------------------------------------ 渲染调度 */

	renderErrorBox: function (e) {
		return E('div', { 'class': 'alert-message error', 'data-page': this.tab, style: 'padding:12px 14px' }, [
			E('strong', {}, _('本标签渲染失败（已降级，不影响其它标签）')),
			E('p', {}, E('code', {}, errText(e))),
			E('p', {}, _('点右上角「刷新」重试；若持续出现，请把这条错误反馈给开发者。'))
		]);
	},

	renderSection: function () {
		if (!this.sectionHost) return;

		var self = this;
		var node = null;

		try {
			if (this.tab === 'history') node = this.renderHistory();
			else if (this.tab === 'devices') node = this.renderDevices();
			else if (this.tab === 'apps') node = this.renderApps();
			else if (this.tab === 'nodes') node = this.renderNodes();
			else if (this.tab === 'topology') node = this.renderTopology();
			else if (this.tab === 'system') node = this.renderSystem();
			else if (this.tab === 'settings') node = this.renderSettings();
			else node = this.renderHistory();
		}
		catch (e) {
			/* 单页渲染异常不能白屏：只把这一页换成错误说明，其它标签仍可用 */
			node = this.renderErrorBox(e);
		}

		try {
			/* 拓扑页在数据没变时返回同一棵 DOM：已经在位就别整块重建（其它标签每次都是新节点） */
			if (node != null && this.sectionHost.firstChild === node) {
				/* 复用，不替换 */
			}
			else {
				dom.content(this.sectionHost, node);
			}

			this.updateTabs();
			this.updateStatus();
			this.drawCurrentChart();
		}
		catch (e2) {
			/* 最后一道兜底：连内容区替换都失败时，至少写一行错误文本 */
			try {
				dom.content(this.sectionHost, E('div', {
					'data-page': this.tab,
					style: 'padding:16px;font-size:13px;color:#c5221f'
				}, _('渲染失败：') + errText(e2)));
			}
			catch (e3) { }
		}

		if (this._drawTimer) {
			try { clearTimeout(this._drawTimer); } catch (e4) { }
			this._drawTimer = null;
		}

		this._drawTimer = setTimeout(function () {
			self._drawTimer = null;
			self.drawCurrentChart();
		}, 0);
	},

	drawCurrentChart: function () {
		try {
			if (this.tab === 'history') this.drawHistoryChart();
		}
		catch (e) {
			/* 图表失败不影响其它内容；下面各 draw* 自己也兜底 */
		}
	},

	/* ------------------------------------------------------------ 状态横幅 */

	renderStateBanner: function () {
		if (this.state != null) return '';

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px;margin-bottom:14px' }, [
			E('strong', {}, _('读不到状态数据（prism-routerd 未运行，或 rpcd 的 prism-router 对象不可用）')),
			this.stateError ? E('p', {}, E('code', {}, this.stateError)) : '',
			E('p', {}, _('可以点右上角「刷新」重试；刚装好插件时请先确认服务已启动。'))
		]);
	},

	/* ------------------------------------------------------------ 历史 */

	rangeLabel: function (n) {
		if (n === 7) return _('近 7 天');
		if (n === 30) return _('近 30 天');

		return _('今日');
	},

	/* 当前范围的数据：只有请求成功过的范围才有值，失败 / 未请求一律 null */
	histPayload: function () {
		return Object.prototype.hasOwnProperty.call(this.hist || {}, this.range) ? this.hist[this.range] : null;
	},

	renderHistory: function () {
		var self = this;
		var payload = this.histPayload();
		var trend = buildTrend(this.range, payload);
		var available = {
			total: true, proxy: true, direct: true,
			wifi: !!trend.has.wifi, wired: !!trend.has.wired
		};
		var pending = (this.histPending || {})[this.range] === true;

		this.histChartHost = E('div', {
			style: 'height:' + TREND_CHART_H + 'px;position:relative;min-width:0'
		}, '');

		var rangeRow = E('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
			E('span', { style: 'font-size:12px;opacity:.7;margin-right:2px' }, _('时间范围'))
		].concat(RANGE_DEFS.map(function (r) {
			return chip(_(r.label), self.range === r.days, '#1a73e8', function () { self.setRange(r.days); });
		})));

		/* 五个指标都摆出来；本范围没有采集到的（无线 / 有线）置灰并说明，避免点开一条假 0 线 */
		var seriesChips = SERIES_DEFS.map(function (s) {
			var usable = !!available[s.key];
			var btn = chip(_(s.label), usable && !!self.series[s.key], s.color,
				function () { self.toggleSeries(s.key); });

			if (!usable) {
				btn.setAttribute('style', chipStyle(false, s.color) + ';opacity:.4;cursor:default');
				btn.setAttribute('title', _('该时间范围没有') + _(s.label) + _('数据'));
			}

			return btn;
		});

		var seriesRow = E('div', {
			style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px'
		}, [ E('span', { style: 'font-size:12px;opacity:.7;margin-right:2px' }, _('显示曲线')) ].concat(seriesChips));

		var notice = '';

		if (pending)
			notice = E('div', { style: 'margin-top:10px;font-size:12px;opacity:.7' },
				_('正在加载') + this.rangeLabel(this.range) + _('数据…'));
		else if (this.histNotice)
			notice = E('div', { 'class': 'alert-message warning', style: 'padding:10px 14px;margin-top:10px' }, this.histNotice);
		else if (payload == null && (this.histErr || {})[this.range])
			notice = E('div', { 'class': 'alert-message warning', style: 'padding:10px 14px;margin-top:10px' },
				_('历史数据读取失败：') + this.histErr[this.range]);

		var caveat = (this.range === 1)
			? _('今日：5 分钟桶，最多 288 个点（history.json 在 tmpfs，重启即丢）。')
			: ((this.range === 7)
				? _('近 7 天：每天一个点——今天由 5 分钟桶求和，往日取每日汇总（日粒度）。SPEC §3.1 不承诺跨天 5 分钟数据。')
				: _('近 30 天：日粒度，报文更大；超过 ubus 单条消息上限会失败，并自动降级回近 7 天 / 今日，原因见上方提示。'));

		return E('div', { 'data-page': 'history' }, [
			this.renderStateBanner(),
			E('div', {
				style: 'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
					'border-radius:10px;padding:12px 14px;margin-bottom:12px'
			}, [ rangeRow, seriesRow ]),
			card(_('流量趋势'), this.histChartHost,
				E('span', { style: 'font-size:12px;opacity:.6' },
					this.range === 1 ? _('今日 · 5 分钟桶') : (this.rangeLabel(this.range) + ' · ' + _('日粒度')))),
			notice,
			E('p', { style: 'margin:10px 0 14px;font-size:12px;opacity:.7' }, caveat),
			this.renderDailyTable()
		]);
	},

	/* 每日汇总表：一天一行，点表头排序 */
	renderDailyTable: function () {
		var host = E('div', { style: 'overflow-x:auto' }, this.renderDailyBody());

		this.dailyHost = host;

		return card(_('每日汇总'), E('div', {}, [
			E('p', { style: 'margin:0 0 10px;font-size:12px;opacity:.65' },
				_('每天一行，来自 get_history 的 days 数组；无线 / 有线未采集的日子显示「—」。点表头可排序。')),
			host
		]), E('span', { style: 'font-size:12px;opacity:.6' }, _('按日汇总')));
	},

	renderDailyBody: function () {
		var rows = this.sortedDailyRows();

		if (!rows.length)
			return emptyBox(_('暂无每日汇总'), _('get_history 没有返回任何一天的数据'));

		var cell = function (value, color) {
			return E('td', {
				'class': 'td',
				style: 'text-align:right;white-space:nowrap' + (color ? ';color:' + color : '')
			}, (value == null) ? '—' : E('strong', {}, fmtBytes(value)));
		};

		var cells = rows.map(function (r) {
			return E('tr', { 'class': 'tr', 'data-row': 'daily' }, [
				E('td', { 'class': 'td', style: 'white-space:nowrap' }, E('code', {}, r.day || '—')),
				cell(r.total),
				cell(r.proxy, '#1a73e8'),
				cell(r.direct, '#188038'),
				cell(r.wifi, '#a142f4'),
				cell(r.wired, '#b26a00')
			]);
		});

		return table(this.dailyHead(), cells, _('暂无每日汇总'));
	},

	dailyHead: function () {
		var self = this;

		var cols = [
			{ key: 'day', label: _('日期') },
			{ key: 'total', label: _('总流量'), right: true },
			{ key: 'proxy', label: _('代理'), right: true },
			{ key: 'direct', label: _('直连'), right: true },
			{ key: 'wifi', label: _('无线'), right: true },
			{ key: 'wired', label: _('有线'), right: true }
		];

		var sort = this.dailySort || { key: 'day', dir: -1 };

		return cols.map(function (c) {
			var o = {
				label: c.label,
				right: c.right,
				sortKey: c.key,
				click: function () { self.setDailySort(c.key); }
			};

			if (sort.key === c.key)
				o.mark = (sort.dir < 0) ? '▼' : '▲';

			return o;
		});
	},

	dailySortValue: function (row, key) {
		if (key === 'day') return row.day || '';

		return (row[key] == null) ? null : num(row[key]);
	},

	sortedDailyRows: function () {
		var self = this;
		var rows = dailyRowsOf(this.histPayload());
		var sort = this.dailySort || { key: 'day', dir: -1 };
		var key = sort.key;
		var dir = (sort.dir < 0) ? -1 : 1;

		rows.sort(function (a, b) {
			var va = self.dailySortValue(a, key);
			var vb = self.dailySortValue(b, key);

			/* 空值（无线 / 有线未采集）永远排最后，不随升降序来回跳 */
			if (va == null && vb == null) return 0;
			if (va == null) return 1;
			if (vb == null) return -1;

			var r;

			if (typeof va === 'number' && typeof vb === 'number')
				r = va - vb;
			else if (va < vb)
				r = -1;
			else if (va > vb)
				r = 1;
			else
				r = 0;

			return r * dir;
		});

		return rows;
	},

	setDailySort: function (key) {
		if (!key) return;

		if (this.dailySort && this.dailySort.key === key)
			this.dailySort.dir = (this.dailySort.dir < 0) ? 1 : -1;
		else
			this.dailySort = { key: key, dir: -1 };

		if (this.dailyHost)
			dom.content(this.dailyHost, this.renderDailyBody());
	},

	/*
	 * 切时间范围：只有第一次切到某个范围才真的请求。
	 * get_history 受 ubus 单条消息上限约束（后端按 200000 字符瘦身，仍可能失败），
	 * 所以失败一律降级：30 天 → 近 7 天（有缓存时）→ 今日，并把原因写在历史页顶部。
	 */
	setRange: function (n) {
		var self = this;

		n = (n === 7 || n === 30) ? n : 1;

		this.hist = this.hist || {};
		this.histPending = this.histPending || {};
		this.histErr = this.histErr || {};
		this.histAt = this.histAt || {};

		if (this.histPending[n]) return;

		if (Object.prototype.hasOwnProperty.call(this.hist, n) && this.hist[n] != null) {
			this.range = n;
			this.histNotice = '';
			this.renderSection();
			return;
		}

		this.range = n;
		this.histNotice = '';
		this.histPending[n] = true;
		this.renderSection();

		var timeout = new Promise(function (resolve, reject) {
			setTimeout(function () { reject(new Error(_('请求超时'))); }, HISTORY_TIMEOUT_MS);
		});

		Promise.race([
			Promise.resolve().then(function () { return callHistory(n); }),
			timeout
		]).then(function (data) {
			self.hist[n] = (data != null && typeof data === 'object') ? data : { days: [] };
			self.histAt[n] = Date.now();
			self.histErr[n] = '';
			delete self.histPending[n];

			if (self.range === n) {
				self.histNotice = '';
				self.renderSection();
			}
		}).catch(function (err) {
			delete self.histPending[n];
			self.hist[n] = null;
			self.histErr[n] = errText(err);

			/* 用户已经切到别的范围了：只记下这次失败，不要把他拽回来 */
			if (self.range !== n) return;

			var fb = (n === 30 && self.hist[7] != null) ? 7 : 1;
			var reason = self.histErr[n] || _('未知错误');

			self.range = fb;
			self.histNotice = self.rangeLabel(n) + _('读取失败') +
				'（' + _('可能超过 ubus 单条消息上限，或后端超时') + '）。' +
				_('已降级为') + '「' + self.rangeLabel(fb) + '」：' + reason;
			self.renderSection();
		});
	},

	toggleSeries: function (key) {
		if (!key) return;

		this.series[key] = !this.series[key];
		this.renderSection();
	},

	drawHistoryChart: function () {
		var host = this.histChartHost;

		if (host == null) return;

		try {
			if ((this.histPending || {})[this.range] === true && this.histPayload() == null) {
				dom.content(host, centerBox(_('正在加载') + this.rangeLabel(this.range) + _('数据…')));
				return;
			}

			var trend = buildTrend(this.range, this.histPayload());

			if (!trend.points.length) {
				dom.content(host, centerBox(_('暂无历史数据（history.json 为空，或守护进程刚启动）')));
				return;
			}

			var data = chartDataFromTrend(trend, this.series);

			if (!data.datasets.length) {
				dom.content(host, centerBox(_('已隐藏全部曲线，点上面的「显示曲线」恢复')));
				return;
			}

			tsRenderLine(host, data, {
				height: TREND_CHART_H,
				fmtY: function (v) { return fmtBytes(v); }
			});
		}
		catch (e) {
			dom.content(host, centerBox(_('趋势图绘制失败：') + errText(e)));
		}
	},

	/* ------------------------------------------------------------ 设备 */

	devices: function () {
		var st = this.state || {};

		return Array.isArray(st.devices) ? st.devices : [];
	},

	sortValue: function (d, key) {
		if (key === 'host') return deviceName(d).toLowerCase();
		if (key === 'ip') return ipSortKey(d.ip);
		if (key === 'mac') return ((d.mac == null) ? '' : ('' + d.mac)).toLowerCase();
		if (key === 'link') return { wifi: 0, wired: 1, unknown: 2 }[linkFilterKey(d)];
		if (key === 'direct') return num(d.direct_rx) + num(d.direct_tx);
		if (key === 'proxy') return num(d.proxy_rx) + num(d.proxy_tx);
		if (key === 'total') return deviceTotal(d);
		if (key === 'rate') return deviceRate(d);
		if (key === 'last_seen') return num(d.last_seen);
		if (key === 'signal') {
			var s = signalValue(d);

			return (s == null) ? -1000 : s;
		}

		return 0;
	},

	filteredDevices: function () {
		var self = this;
		var q = ('' + (this.devQuery || '')).trim().toLowerCase();
		var link = this.devLink || 'all';

		var list = this.devices().filter(function (d) {
			if (link !== 'all' && linkFilterKey(d) !== link) return false;

			if (q.length) {
				var hay = ((d.hostname || '') + ' ' + (d.ip || '') + ' ' + (d.mac || '')).toLowerCase();

				if (hay.indexOf(q) < 0) return false;
			}

			return true;
		});

		var dir = (this.devSort.dir < 0) ? -1 : 1;
		var key = this.devSort.key;

		list.sort(function (a, b) {
			var va = self.sortValue(a, key);
			var vb = self.sortValue(b, key);
			var r;

			if (typeof va === 'number' && typeof vb === 'number')
				r = va - vb;
			else {
				va = '' + va;
				vb = '' + vb;
				r = (va < vb) ? -1 : ((va > vb) ? 1 : 0);
			}

			if (r === 0)
				return deviceTotal(b) - deviceTotal(a);

			return r * dir;
		});

		return list;
	},

	renderDevices: function () {
		var self = this;

		this.devLinkSelect = E('select', {
			'class': 'cbi-input-select',
			change: function (ev) { self.setDevLink(ev.currentTarget.value); }
		}, [
			E('option', { value: 'all' }, _('全部')),
			E('option', { value: 'wifi' }, _('无线')),
			E('option', { value: 'wired' }, _('有线')),
			E('option', { value: 'unknown' }, _('未知'))
		]);

		this.devLinkSelect.value = this.devLink;

		this.devSearch = E('input', {
			'class': 'cbi-input-text',
			type: 'search',
			placeholder: _('搜索主机名 / IP / MAC'),
			style: 'min-width:220px',
			value: this.devQuery,
			input: function (ev) { self.setDevQuery(ev.currentTarget.value); }
		});

		this.devSummaryNode = E('span', { style: 'font-size:12px;opacity:.85' }, '');
		this.devTableHost = E('div', { style: 'overflow-x:auto' }, this.renderDeviceTableBody());

		this.updateDeviceSummary();

		return E('div', { 'data-page': 'devices' }, [
			this.renderStateBanner(),
			E('div', {
				style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px'
			}, [
				E('label', { style: 'font-size:13px' }, _('接入')),
				this.devLinkSelect,
				this.devSearch,
				E('button', {
					'class': 'cbi-button',
					type: 'button',
					click: function () {
						self.devLink = 'all';
						self.devQuery = '';
						self.devSort = { key: 'total', dir: -1 };
						self.renderSection();
					}
				}, _('重置')),
				this.devSummaryNode
			]),
			E('p', { style: 'margin:0 0 10px;font-size:12px;opacity:.65' },
				_('点表头排序，点行展开该设备的应用 Top 10。接入方式来自主路由的桥 FDB，与代理/直连无关。')),
			this.devTableHost
		]);
	},

	/* 设备表头：data-sort 方便自测和鼠标提示；点表头切换升/降序 */
	deviceHead: function () {
		var self = this;

		var cols = [
			{ label: _('主机名'), sortKey: 'host', width: '22%' },
			{ label: _('IP'), sortKey: 'ip', width: '130px' },
			{ label: _('MAC'), sortKey: 'mac', width: '160px' },
			{ label: _('接入'), sortKey: 'link', width: '78px' },
			{ label: _('直连'), right: true, sortKey: 'direct', width: '104px' },
			{ label: _('代理'), right: true, sortKey: 'proxy', width: '104px' },
			{ label: _('合计'), right: true, sortKey: 'total', width: '104px' },
			{ label: _('速率'), right: true, sortKey: 'rate', width: '104px', title: _('下载 + 上传，bit/s') },
			{ label: _('最后在线'), right: true, sortKey: 'last_seen', width: '104px' },
			{ label: _('信号'), right: true, sortKey: 'signal', width: '88px', title: _('来自哑桥 AP 的无线信号（若有）') }
		];

		return cols.map(function (c) {
			var o = {
				label: c.label,
				width: c.width,
				right: c.right,
				title: c.title,
				sortKey: c.sortKey,
				click: function () { self.setDevSort(c.sortKey); }
			};

			if (self.devSort.key === c.sortKey)
				o.mark = (self.devSort.dir < 0) ? '▼' : '▲';

			return o;
		});
	},

	updateDeviceSummary: function () {
		if (!this.devSummaryNode) return;

		var all = this.devices().length;
		var shown = this.filteredDevices().length;
		var h = ((this.state || {}).health) || {};
		var ports = Array.isArray(h.link_ports) ? h.link_ports : [];
		var link = '';

		if ('' + (h.link_source || 'none') !== 'brctl')
			link = _('接入判定不可用（读不到桥 FDB）');
		else if (!ports.length)
			link = _('未配置无线上联端口，接入列一律按有线归类');
		else
			link = _('接入判定 brctl:') + ports.join(',');

		this.devSummaryNode.textContent = _('共') + ' ' + all + ' ' + _('台设备') +
			(shown !== all ? ('（' + _('筛选后') + ' ' + shown + '）') : '') +
			' · ' + link + ((this.state && this.state.truncated === true) ? ' · ' + _('数据过大，后端已裁剪') : '');
	},

	renderDeviceTableBody: function () {
		var self = this;
		var list = this.filteredDevices();

		if (!list.length) {
			return this.devices().length
				? emptyBox(_('当前筛选条件下没有设备'), _('试试把接入方式切回「全部」并清空搜索'))
				: emptyBox(_('暂无设备数据（prism-routerd 还没采到设备流量）'));
		}

		var rows = [];

		for (var i = 0; i < list.length; i++)
			rows = rows.concat(this.renderDeviceRow(list[i]));

		return table(this.deviceHead(), rows, _('暂无设备数据'));
	},

	renderDeviceRow: function (d) {
		var self = this;
		var key = deviceKey(d);
		var open = !!this.expanded[key];
		var direct = num(d.direct_rx) + num(d.direct_tx);
		var proxy = num(d.proxy_rx) + num(d.proxy_tx);
		var sig = signalValue(d);

		var row = E('tr', {
			'class': 'tr',
			'data-row': 'device',
			style: 'cursor:pointer',
			title: _('点击展开/收起该设备的应用 Top 10')
		}, [
			E('td', { 'class': 'td', style: 'max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [
				E('span', { style: 'display:inline-block;width:12px;opacity:.6' }, open ? '▾' : '▸'),
				E('strong', {}, shortText(deviceName(d), 34))
			]),
			E('td', { 'class': 'td' }, E('code', {}, d.ip ? '' + d.ip : '—')),
			E('td', { 'class': 'td' }, E('code', {}, d.mac ? '' + d.mac : '—')),
			E('td', { 'class': 'td' }, linkBadge(d)),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(direct)),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(proxy)),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, E('strong', {}, fmtBytes(deviceTotal(d)))),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap', title: fmtRate(deviceRate(d)) }, fmtRate(deviceRate(d))),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtAgo(d.last_seen)),
			E('td', {
				'class': 'td',
				style: 'text-align:right;white-space:nowrap;color:' + (sig == null ? 'inherit' : signalColor(sig)),
				title: (sig == null) ? _('没有无线站点元数据（需要 AP 侧上报）') : ''
			}, (sig == null) ? '—' : (sig + ' dBm'))
		]);

		row.addEventListener('click', function () {
			if (self.expanded[key]) delete self.expanded[key];
			else self.expanded[key] = true;

			self.renderDeviceTable();
		});

		var rows = [ row ];

		if (open) rows.push(this.renderDeviceDetail(d));

		return rows;
	},

	renderDeviceDetail: function (d) {
		return E('tr', { 'class': 'tr', 'data-row': 'device-apps' }, [
			E('td', {
				'class': 'td',
				colspan: 10,
				style: 'padding:10px 12px;background:rgba(127,127,127,.06)'
			}, this.renderDeviceApps(d))
		]);
	},

	/* 设备 apps → 归一化列表（拓扑页复用同一份提取逻辑，避免两处口径分叉） */
	deviceAppsList: function (d) {
		var apps = (d != null && d.apps != null && typeof d.apps === 'object') ? d.apps : null;

		if (apps == null)
			return null;

		var list = [];

		for (var host in apps) {
			if (!Object.prototype.hasOwnProperty.call(apps, host)) continue;

			list.push({
				host: host,
				rx: num(apps[host] && apps[host].rx),
				tx: num(apps[host] && apps[host].tx),
				chain: (apps[host] && apps[host].chain) ? '' + apps[host].chain : ''
			});
		}

		list.sort(function (a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

		return list;
	},

	renderDeviceApps: function (d) {
		var list = this.deviceAppsList(d);

		if (list == null || !list.length)
			return E('div', { style: 'font-size:12px;opacity:.65' }, _('该设备暂无应用明细（后端未提供）'));

		var top = list.slice(0, 10);

		var rows = top.map(function (a) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
					shortText(appLabel(a.host), 48)),
				E('td', { 'class': 'td' }, chainBadge(a.chain)),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(a.rx + a.tx))
			]);
		});

		return E('div', {}, [
			E('div', { style: 'font-size:12px;opacity:.7;margin-bottom:8px' }, [
				_('应用 Top 10'),
				' · ',
				_('共') + ' ' + list.length + ' ' + _('项'),
				(d.apps_truncated === true) ? (' · ' + _('后端已裁剪')) : ''
			]),
			E('table', { 'class': 'table', style: 'width:100%;font-size:12px' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('应用 / 域名')),
					E('th', { 'class': 'th', style: 'width:150px' }, _('出口')),
					E('th', { 'class': 'th', style: 'text-align:right;width:110px' }, _('流量'))
				])
			].concat(rows))
		]);
	},

	setDevLink: function (v) {
		this.devLink = (v === 'wifi' || v === 'wired' || v === 'unknown') ? v : 'all';
		this.renderDeviceTable();
	},

	setDevQuery: function (q) {
		this.devQuery = (q == null) ? '' : ('' + q);
		this.renderDeviceTable();
	},

	setDevSort: function (key) {
		if (!key) return;

		if (this.devSort.key === key) {
			this.devSort.dir = (this.devSort.dir < 0) ? 1 : -1;
		}
		else {
			this.devSort.key = key;
			this.devSort.dir = (key === 'host' || key === 'ip' || key === 'mac' || key === 'link' || key === 'last_seen') ? 1 : -1;
		}

		this.renderDeviceTable();
	},

	/* 只重绘表格与摘要，搜索框保持焦点（排序/筛选不重建整页） */
	renderDeviceTable: function () {
		if (this.devTableHost)
			dom.content(this.devTableHost, this.renderDeviceTableBody());

		this.updateDeviceSummary();
	},

	/* ------------------------------------------------------------ 应用 */

	apps: function () {
		var st = this.state || {};

		return Array.isArray(st.apps) ? st.apps : [];
	},

	appChainKeys: function () {
		var keys = [ 'all', 'proxy', 'direct' ];
		var seen = {};
		var self = this;

		this.apps().forEach(function (a) {
			var c = '' + ((a && a.chain) || '');

			if (c.length && c !== 'DIRECT' && c !== 'MIXED' && c !== '__other__')
				seen[c] = 1;
		});

		var nodes = ((this.state || {}).nodes) || {};

		for (var name in nodes) {
			if (!Object.prototype.hasOwnProperty.call(nodes, name)) continue;
			if (name === 'DIRECT' || name === 'MIXED' || name === '__other__') continue;

			seen[name] = 1;
		}

		Object.keys(seen).sort().forEach(function (n) { keys.push('node:' + n); });

		return keys;
	},

	appChainLabel: function (key) {
		if (key === 'all') return _('全部');
		if (key === 'proxy') return _('仅代理');
		if (key === 'direct') return _('仅直连');
		if (key.indexOf('node:') === 0) return _('节点：') + key.substring(5);

		return key;
	},

	matchAppChain: function (chain) {
		var name = (chain == null) ? '' : ('' + chain);
		var f = this.appChain || 'all';

		if (f === 'all') return true;
		if (f === 'proxy') return name !== 'DIRECT';
		if (f === 'direct') return name === 'DIRECT';
		if (f.indexOf('node:') === 0) return name === f.substring(5);

		return true;
	},

	renderApps: function () {
		var self = this;
		var keys = this.appChainKeys();

		if (keys.indexOf(this.appChain) < 0) this.appChain = 'all';

		this.appSelect = E('select', {
			'class': 'cbi-input-select',
			change: function (ev) { self.setAppChain(ev.currentTarget.value); }
		}, keys.map(function (k) {
			return E('option', { value: k }, self.appChainLabel(k));
		}));

		this.appSelect.value = this.appChain;
		this.appTableHost = E('div', { style: 'overflow-x:auto' }, this.renderAppTableBody());

		return E('div', { 'data-page': 'apps' }, [
			this.renderStateBanner(),
			E('p', { style: 'margin:0 0 12px;font-size:12px;opacity:.85' }, [
				_('共') + ' ' + this.apps().length + ' ' + _('个域名'),
				' · ',
				_('点行展开可看到访问该应用的设备'),
				((this.state || {}).truncated === true) ? (' · ' + _('数据过大，后端已裁剪')) : ''
			]),
			E('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px' }, [
				E('label', { style: 'font-size:13px' }, _('出口筛选')),
				this.appSelect,
				E('span', { style: 'font-size:12px;opacity:.7' }, _('切换筛选不会重新请求后端'))
			]),
			this.appTableHost
		]);
	},

	renderAppTableBody: function () {
		var self = this;
		var list = this.apps().filter(function (a) { return self.matchAppChain(a.chain); })
			.sort(function (a, b) { return appTotal(b) - appTotal(a); });

		if (!list.length) {
			return this.apps().length
				? emptyBox(_('当前出口筛选下没有域名记录'), _('把筛选切回「全部」试试'))
				: emptyBox(_('暂无应用数据（clash / conntrack 都还没采到域名）'));
		}

		var rows = [];

		for (var i = 0; i < list.length; i++)
			rows = rows.concat(this.renderAppRow(list[i]));

		return table([
			{ label: _('域名 / 应用') },
			{ label: _('出口'), width: '190px' },
			{ label: _('流量'), right: true, width: '120px' },
			{ label: _('设备数'), right: true, width: '90px' }
		], rows, _('暂无应用数据'));
	},

	renderAppRow: function (a) {
		var self = this;
		var host = (a && a.host) ? '' + a.host : '';
		var key = 'app:' + host;
		var open = !!this.expandedApps[key];

		var row = E('tr', {
			'class': 'tr',
			'data-row': 'app',
			style: 'cursor:pointer',
			title: _('点击展开/收起访问该应用的设备')
		}, [
			E('td', { 'class': 'td', style: 'max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [
				E('span', { style: 'display:inline-block;width:12px;opacity:.6' }, open ? '▾' : '▸'),
				E('strong', {}, shortText(appLabel(host), 48))
			]),
			E('td', { 'class': 'td' }, chainBadge(a.chain)),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(appTotal(a))),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, '' + num(a.devices))
		]);

		row.addEventListener('click', function () {
			if (self.expandedApps[key]) delete self.expandedApps[key];
			else self.expandedApps[key] = true;

			self.renderAppTable();
		});

		var rows = [ row ];

		if (open) rows.push(this.renderAppDetail(a));

		return rows;
	},

	renderAppDetail: function (a) {
		return E('tr', { 'class': 'tr', 'data-row': 'app-devices' }, [
			E('td', {
				'class': 'td',
				colspan: 4,
				style: 'padding:10px 12px;background:rgba(127,127,127,.06)'
			}, this.renderAppDevices(a))
		]);
	},

	/*
	 * 设备明细：后端 app.devices 是「设备数」（整数），SPEC 没承诺设备列表。
	 * 所以优先用 app.devices 数组（若将来后端给了列表），否则反查 state.devices[].apps，
	 * 这样即使只有计数也能告诉用户"是哪几台设备"。
	 */
	appDeviceIndex: function () {
		if (this._appIndexState === this.state && this._appIndex)
			return this._appIndex;

		var map = {};
		var devices = this.devices();

		for (var i = 0; i < devices.length; i++) {
			var d = devices[i];
			var apps = (d != null && d.apps != null && typeof d.apps === 'object') ? d.apps : null;

			if (apps == null) continue;

			for (var host in apps) {
				if (!Object.prototype.hasOwnProperty.call(apps, host)) continue;

				if (!map[host]) map[host] = [];

				map[host].push({
					name: deviceName(d),
					ip: d.ip || '',
					mac: d.mac || '',
					link: linkKey(d),
					rx: num(apps[host] && apps[host].rx),
					tx: num(apps[host] && apps[host].tx),
					chain: (apps[host] && apps[host].chain) ? '' + apps[host].chain : ''
				});
			}
		}

		for (var k in map) {
			if (!Object.prototype.hasOwnProperty.call(map, k)) continue;

			map[k].sort(function (x, y) { return (y.rx + y.tx) - (x.rx + x.tx); });
		}

		this._appIndexState = this.state;
		this._appIndex = map;

		return map;
	},

	appDevicesOf: function (a) {
		var host = (a && a.host) ? '' + a.host : '';

		if (a && Array.isArray(a.devices)) {
			return a.devices.map(function (d) {
				if (d == null || typeof d !== 'object')
					return { name: '' + d, ip: '', mac: '', link: '', rx: 0, tx: 0, chain: '' };

				return {
					name: d.hostname || d.ip || d.mac || '',
					ip: d.ip || '',
					mac: d.mac || '',
					link: linkKey(d),
					rx: num(d.rx || d.direct_rx) + num(d.proxy_rx),
					tx: num(d.tx || d.direct_tx) + num(d.proxy_tx),
					chain: (d.chain && ('' + d.chain)) || ''
				};
			});
		}

		var idx = this.appDeviceIndex();

		return idx[host] || [];
	},

	renderAppDevices: function (a) {
		var host = (a && a.host) ? '' + a.host : '';
		var list = this.appDevicesOf(a);
		var count = num(a && a.devices);

		if (!list.length) {
			return E('div', {}, [
				E('div', { style: 'font-size:12px;opacity:.7' },
					_('后端只给了设备数（') + count + '），没有设备明细；设备表里也没有这台设备的该应用记录。'),
				E('div', { style: 'font-size:12px;opacity:.55;margin-top:4px' },
					_('设备表最多 40 台、每设备应用最多 15 个，超出部分会被后端裁剪。'))
			]);
		}

		var shown = list.slice(0, 12);

		var rows = shown.map(function (d) {
			var m = d.link ? linkMeta(d) : null;

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
					E('strong', {}, shortText(d.name || d.ip || _('未知设备'), 40))),
				E('td', { 'class': 'td', style: 'white-space:nowrap' }, E('code', {}, d.ip || '—')),
				E('td', { 'class': 'td', style: 'white-space:nowrap' }, m ? badge(m.label, m.color, m.bg) : '—'),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(d.rx + d.tx))
			]);
		});

		var note = _('共') + ' ' + list.length + ' ' + _('台设备');

		if (list.length > shown.length)
			note += ' · ' + _('仅显示前') + ' ' + shown.length + ' ' + _('台');

		if (!Array.isArray(a && a.devices) && count > 0 && count !== list.length)
			note += ' · ' + _('（应用表记的设备数是') + ' ' + count + '）';

		return E('div', {}, [
			E('div', { style: 'font-size:12px;opacity:.7;margin-bottom:8px' }, [ host ? _('访问该应用的设备') : _('设备'), ' · ', note ]),
			E('table', { 'class': 'table', style: 'width:100%;font-size:12px' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('设备')),
					E('th', { 'class': 'th', style: 'width:140px' }, _('IP')),
					E('th', { 'class': 'th', style: 'width:80px' }, _('接入')),
					E('th', { 'class': 'th', style: 'text-align:right;width:120px' }, _('该应用流量'))
				])
			].concat(rows))
		]);
	},

	setAppChain: function (v) {
		this.appChain = v || 'all';
		this.renderAppTable();
	},

	renderAppTable: function () {
		if (this.appTableHost)
			dom.content(this.appTableHost, this.renderAppTableBody());
	},

	/* ------------------------------------------------------------ 节点 */

	nodeName: function (n) {
		if (n == null) return '—';
		if (n.name && ('' + n.name).length) return '' + n.name;
		if (n.node_id && ('' + n.node_id).length) return '' + n.node_id;

		return '—';
	},

	nodeTotals: function (n) {
		var latest = (n != null && n.latest != null && typeof n.latest === 'object') ? n.latest : {};
		var t = (latest.totals != null && typeof latest.totals === 'object') ? latest.totals : {};

		var direct = num(t.direct_rx) + num(t.direct_tx);
		var proxy = num(t.proxy_rx) + num(t.proxy_tx);

		return { direct: direct, proxy: proxy, total: direct + proxy };
	},

	nodeDeviceCount: function (n) {
		var latest = (n != null && n.latest != null && typeof n.latest === 'object') ? n.latest : {};

		return Array.isArray(latest.devices) ? latest.devices.length : 0;
	},

	isStaleNode: function (n) {
		var age = (n != null && n.age_sec != null) ? num(n.age_sec) : -1;

		return (age < 0) || (age > STALE_SEC);
	},

	renderNodes: function () {
		var self = this;
		var list = (Array.isArray(this.nodes) ? this.nodes.slice() : []);

		/* 懒加载：首次切到本页时请求还在路上，先给加载提示，不误报「暂无节点」 */
		if (!list.length && !this.nodesLoaded && !this.nodesError) {
			return E('div', { 'data-page': 'nodes' }, [
				E('div', { style: 'padding:22px 0;text-align:center;opacity:.6;font-size:13px' },
					_('正在加载节点数据…'))
			]);
		}

		if (!list.length) {
			return E('div', { 'data-page': 'nodes' }, [
				E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
					E('p', {}, E('strong', {}, _('暂无节点（多节点未启用或尚未上报）'))),
					this.nodesError ? E('p', {}, _('读取失败：') + this.nodesError) : '',
					E('p', {}, _('子节点需要配置 mother_enabled=1 / mother_url / mother_secret，并由 cron 每分钟运行一次 push.uc；母节点需要同一个 mother_secret。')),
					E('p', { style: 'font-size:12px;opacity:.8' },
						_('验证：在任一节点执行 ucode /usr/share/prism-router/push.uc，然后点右上角「刷新」。'))
				])
			]);
		}

		list.sort(function (a, b) { return num(b && b.ts) - num(a && a.ts); });

		var stale = list.filter(function (n) { return self.isStaleNode(n); }).length;

		var rows = list.map(function (n) {
			var t = self.nodeTotals(n);
			var bad = self.isStaleNode(n);
			var age = (n != null && n.age_sec != null) ? num(n.age_sec) : -1;
			var name = self.nodeName(n);
			var id = (n && n.node_id) ? '' + n.node_id : '';

			return E('tr', {
				'class': 'tr',
				'data-row': 'node',
				style: bad ? 'background:rgba(255,193,7,.18)' : '',
				title: _('最后上报') + '：' + fmtClock(n && n.ts)
			}, [
				E('td', { 'class': 'td' }, [
					E('strong', {}, name),
					(name !== id && id.length) ? E('div', { style: 'font-size:11px;opacity:.65' }, E('code', {}, id)) : ''
				]),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, [
					bad ? E('span', { style: 'color:#b26a00' }, '⚠ ') : '',
					fmtAgeSec(age),
					E('div', { style: 'font-size:11px;opacity:.6' }, fmtClock(n && n.ts))
				]),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, E('strong', {}, fmtBytes(t.total))),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(t.proxy)),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtBytes(t.direct)),
				E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, '' + self.nodeDeviceCount(n))
			]);
		});

		return E('div', { 'data-page': 'nodes' }, [
			E('p', { style: 'margin:0 0 12px;font-size:12px;opacity:.85' }, [
				_('共') + ' ' + list.length + ' ' + _('个节点'),
				stale > 0 ? (' · ' + stale + ' ' + _('个超过 5 分钟未上报')) : '',
				' · ',
				_('总流量 = 该节点直连 + 代理（自该节点守护进程启动以来累计，不是今日增量）')
			]),
			this.nodesError ? E('div', { 'class': 'alert-message warning', style: 'padding:10px 14px;margin-bottom:12px' },
				_('读取节点列表失败：') + this.nodesError) : '',
			table([
				{ label: _('节点') },
				{ label: _('最后上报'), right: true, width: '170px' },
				{ label: _('总流量'), right: true, width: '120px' },
				{ label: _('代理'), right: true, width: '110px' },
				{ label: _('直连'), right: true, width: '110px' },
				{ label: _('设备数'), right: true, width: '84px' }
			], rows, _('暂无节点（多节点未启用或尚未上报）'))
		]);
	},

	/* ------------------------------------------------------------ 拓扑 */

	/*
	 * 拓扑是「只读拼图」，不新增后端方法：
	 *   互联网 ← state.totals.rx_rate/tx_rate（缺失时退回 system.wan_*_rate）
	 *   出口   ← state.nodes（按 rx+tx 降序，最多 6 张卡，占比以全部出口为分母）
	 *   主路由 ← system.hostname / health.link_bridge / 在线设备数与无线·有线·未知分组
	 *   AP     ← get_stations().nodes（新鲜度 + 其下在线无线设备数）
	 *   设备   ← get_state().devices 中在线的那些，按 link 三组，每组最多 8 台
	 *
	 * 任何一层缺数据都只出自己的占位文案，其余层照常；整页渲染还有外层 try/catch 兜底。
	 *
	 * 下钻：出口卡 → 该出口（apps[*].chain）下的在线设备；AP 卡 → stations 命中在线设备的
	 * 无线终端。最多 8 台、按速率降序；展开状态存 topoExitOpen / topoApOpen 并进签名。
	 */

	/* 节点快照：首次进「节点」/「拓扑」时拉一次，之后复用；失败只影响节点页的提示 */
	ensureNodes: function () {
		var self = this;

		if (this.nodesPending || this.nodesLoaded)
			return Promise.resolve();

		this.nodesPending = true;

		return Promise.resolve().then(function () { return callNodes(); })
			.then(function (r) {
				self.nodes = (r != null && Array.isArray(r.nodes)) ? r.nodes : [];
				self.nodesError = null;
				self.nodesLoaded = true;
			})
			.catch(function (err) {
				/* 失败保留旧列表（首次就是空数组），只在节点页提示，不抛错、不影响其它层 */
				self.nodesError = errText(err);
			})
			.then(function () {
				self.nodesPending = false;

				/* 用户可能已经切走：只在这两份数据仍然有用时重绘 */
				if (self.tab === 'nodes' || self.tab === 'topology') self.renderSection();
			});
	},

	/* AP 数据拿不到（老后端没有 get_stations / rpc 失败）时补一次；绝不抛错 */
	ensureStations: function () {
		var self = this;

		if (this.stationsPending || this.stations != null)
			return Promise.resolve();

		this.stationsPending = true;

		return Promise.resolve().then(function () { return callStations(); })
			.then(function (r) {
				self.stations = (r != null && typeof r === 'object')
					? r : { enabled: false, nodes: [], stations: [], count: 0 };
				self.stationsError = null;
			})
			.catch(function (err) {
				self.stationsError = errText(err);
			})
			.then(function () {
				self.stationsPending = false;

				/* 用户可能已经切走：只在拓扑页仍打开时重绘 */
				if (self.tab === 'topology') self.renderSection();
			});
	},

	/* 在线口径与状态摘要一致：last_seen > 0 且 10 分钟内（且不接受明显超前的时钟） */
	isDeviceOnline: function (d) {
		var nowSec = Math.floor(Date.now() / 1000);
		var seen = num(d && d.last_seen);

		return seen > 0 && seen <= nowSec + 60 && (nowSec - seen) <= ONLINE_SEC;
	},

	onlineDevices: function () {
		var self = this;

		return this.devices().filter(function (d) { return self.isDeviceOnline(d); });
	},

	topoRates: function () {
		var totals = (this.state != null && this.state.totals != null && typeof this.state.totals === 'object')
			? this.state.totals : {};
		var sys = (this.state != null && this.state.system != null && typeof this.state.system === 'object')
			? this.state.system : {};
		var rx = numOrNull(totals.rx_rate);
		var tx = numOrNull(totals.tx_rate);

		if (rx == null) rx = numOrNull(sys.wan_rx_rate);
		if (tx == null) tx = numOrNull(sys.wan_tx_rate);

		return { rx: rx, tx: tx };
	},

	topoMeta: function () {
		var st = this.state;
		var health = (st != null && st.health != null && typeof st.health === 'object') ? st.health : {};
		var sys = (st != null && st.system != null && typeof st.system === 'object') ? st.system : {};
		var host = '';

		if (sys.hostname != null && ('' + sys.hostname).trim().length)
			host = ('' + sys.hostname).trim();
		else if (st != null && st.hostname != null && ('' + st.hostname).trim().length)
			host = ('' + st.hostname).trim();

		var bridge = (health.link_bridge == null) ? '' : ('' + health.link_bridge).trim();

		return {
			host: host.length ? host : _('主路由'),
			bridge: bridge,
			linkSource: (health.link_source == null) ? '' : ('' + health.link_source)
		};
	},

	/* 出口列：state.nodes（含 DIRECT），按 rx+tx 降序；total 是全部出口（不只 Top6）的和 */
	topoExits: function () {
		var raw = (this.state != null && this.state.nodes != null && typeof this.state.nodes === 'object')
			? this.state.nodes : null;
		var list = [];
		var total = 0;

		if (raw != null) {
			for (var name in raw) {
				if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;

				var v = (raw[name] != null && typeof raw[name] === 'object') ? raw[name] : {};
				var rx = num(v.rx);
				var tx = num(v.tx);

				list.push({ name: '' + name, rx: rx, tx: tx, total: rx + tx });
				total += rx + tx;
			}
		}

		list.sort(function (a, b) { return b.total - a.total; });

		return {
			list: list.slice(0, TOPO_MAX_NODES),
			count: list.length,
			total: total,
			available: (raw != null)
		};
	},

	topoLinkCounts: function (online) {
		var counts = { wifi: 0, wired: 0, unknown: 0 };

		for (var i = 0; i < online.length; i++) {
			var k = linkFilterKey(online[i]);

			if (counts[k] == null) k = 'unknown';
			counts[k]++;
		}

		return counts;
	},

	stationsNodes: function () {
		return (this.stations != null && Array.isArray(this.stations.nodes)) ? this.stations.nodes : [];
	},

	stationsList: function () {
		return (this.stations != null && Array.isArray(this.stations.stations)) ? this.stations.stations : [];
	},

	/* accounting_confidence 的中文状态与配色：沿用 confLook，颜色与顶部状态条一致 */
	topoConfidence: function () {
		var st = this.state;
		var health = (st != null && st.health != null && typeof st.health === 'object') ? st.health : {};

		return confLook(health.accounting_confidence);
	},

	/* 出口名匹配：apps[*].chain === 出口名；DIRECT 大小写不敏感（Clash 可能报 direct/DIRECT） */
	exitChainMatch: function (chain, name) {
		var c = (chain == null) ? '' : ('' + chain);
		var n = (name == null) ? '' : ('' + name);

		if (!c.length || !n.length) return false;
		if (c.toUpperCase() === 'DIRECT' && n.toUpperCase() === 'DIRECT') return true;

		return c === n;
	},

	/*
	 * 出口下钻：该出口下在线的设备。
	 * 口径 = state.devices 里在线、且 apps 中任一 chain 命中该出口名；
	 * 按速率降序，最多 TOPO_MAX_DEVICES 台（不显示 0 台设备）。
	 */
	topoExitDevices: function (name) {
		var self = this;
		var list = this.onlineDevices().filter(function (d) {
			var apps = (d != null && d.apps != null && typeof d.apps === 'object') ? d.apps : null;

			if (apps == null) return false;

			for (var host in apps) {
				if (!Object.prototype.hasOwnProperty.call(apps, host)) continue;
				if (self.exitChainMatch(apps[host] && apps[host].chain, name)) return true;
			}

			return false;
		});

		list.sort(function (a, b) { return deviceRate(b) - deviceRate(a); });

		return list.slice(0, TOPO_MAX_DEVICES);
	},

	/*
	 * AP 下钻：该 AP 下在线的无线终端。
	 * 口径 = stations 中 node_id 命中、且 mac 命中在线 state.devices；
	 * 返回 { device, station } 便于显示信号；按设备速率降序，最多 TOPO_MAX_DEVICES 台。
	 */
	topoApDevices: function (nodeId) {
		var nid = (nodeId == null) ? '' : ('' + nodeId);
		var byMac = {};
		var online = this.onlineDevices();
		var out = [];
		var seen = {};
		var i;

		for (i = 0; i < online.length; i++) {
			var m = ((online[i] && online[i].mac == null) ? '' : ('' + online[i].mac)).toLowerCase();

			if (m.length) byMac[m] = online[i];
		}

		var list = this.stationsList();

		for (i = 0; i < list.length; i++) {
			var s = list[i];

			if (s == null) continue;
			if (nid.length && ('' + ((s.node_id == null) ? '' : s.node_id)) !== nid) continue;

			var mac = ((s.mac == null) ? '' : ('' + s.mac)).toLowerCase();

			if (!mac.length || !Object.prototype.hasOwnProperty.call(byMac, mac)) continue;
			if (seen[mac]) continue;

			seen[mac] = true;
			out.push({ device: byMac[mac], station: s });
		}

		out.sort(function (a, b) { return deviceRate(b.device) - deviceRate(a.device); });

		return out.slice(0, TOPO_MAX_DEVICES);
	},

	/* 某 AP 下「在线」的无线设备数：stations 的 mac 命中在线设备集合，按 mac 去重 */
	apOnlineCount: function (nodeId, onlineKeys) {
		var list = this.stationsList();
		var nid = (nodeId == null) ? '' : ('' + nodeId);
		var seen = {};
		var count = 0;

		for (var i = 0; i < list.length; i++) {
			var s = list[i];

			if (s == null) continue;
			if (nid.length && ('' + ((s.node_id == null) ? '' : s.node_id)) !== nid) continue;

			var mac = ((s.mac == null) ? '' : ('' + s.mac)).toLowerCase();

			if (!mac.length || !Object.prototype.hasOwnProperty.call(onlineKeys, mac)) continue;
			if (seen[mac]) continue;

			seen[mac] = true;
			count++;
		}

		return count;
	},

	/*
	 * 整块签名：只包含真正画在屏幕上的字段（颜色/文案都由它们派生）。
	 * 相同 → renderTopology 直接复用上次的 DOM，不重建整块。
	 */
	topoSignature: function () {
		var st = this.state;
		var parts = [];
		var i;

		parts.push(st == null ? 'state:0' : ('state:1:' + (st.running === true ? 1 : (st.running === false ? 0 : -1))));
		parts.push('stateerr:' + ((this.stateError == null) ? '' : this.stateError));

		var rates = this.topoRates();

		parts.push('rate:' + ((rates.rx == null) ? '-' : rates.rx) + ':' + ((rates.tx == null) ? '-' : rates.tx));

		var meta = this.topoMeta();

		parts.push('meta:' + meta.host + ':' + meta.bridge);

		/* 主路由卡上的「记账状态」徽标 */
		parts.push('conf:' + this.topoConfidence().text);

		var exits = this.topoExits();
		var j;

		parts.push('exitn:' + exits.count + ':' + exits.total + ':' + (exits.available ? 1 : 0));
		for (i = 0; i < exits.list.length; i++) {
			var en = exits.list[i].name;

			parts.push(en + '=' + exits.list[i].rx + '/' + exits.list[i].tx + (this.topoExitOpen[en] ? '*' : ''));

			/* 展开时把下钻出来的设备也写进签名：设备改名 / apps 变化也能触发重绘 */
			if (this.topoExitOpen[en]) {
				var ed = this.topoExitDevices(en);

				parts.push('exdev:' + ed.length);

				for (j = 0; j < ed.length; j++)
					parts.push(deviceKey(ed[j]) + '=' + deviceRate(ed[j]));
			}
		}

		var online = this.onlineDevices();

		parts.push('devn:' + online.length + ':' + this.devices().length);
		for (i = 0; i < online.length; i++) {
			var dk = deviceKey(online[i]);

			parts.push(dk + '=' + deviceRate(online[i]) + (this.topoOpen[dk] ? '*' : ''));
		}

		var ap = this.stationsNodes();

		parts.push('ap:' + (this.stations == null ? 0 : 1) + ':' + ap.length + ':' +
			((this.stationsError == null) ? '' : this.stationsError) + ':' +
			((this.stations != null && this.stations.enabled === false) ? 0 : 1));

		for (i = 0; i < ap.length; i++) {
			var n = ap[i] || {};
			var an = ((n.node_id == null) ? '' : ('' + n.node_id));

			parts.push(an + '=' + num(n.age_sec) + '/' + num(n.count) + '/' + num(n.ts) +
				(this.topoApOpen[an] ? '*' : ''));

			if (this.topoApOpen[an]) {
				var ad = this.topoApDevices(an);

				parts.push('apdev:' + ad.length);

				for (j = 0; j < ad.length; j++)
					parts.push(deviceKey(ad[j].device) + '=' + numOrNull(ad[j].station.signal) + '/' + deviceRate(ad[j].device));
			}
		}

		var sl = this.stationsList();

		for (i = 0; i < sl.length; i++)
			parts.push(((sl[i] && sl[i].mac) || '') + '@' + ((sl[i] && sl[i].node_id) || ''));

		return parts.join('|');
	},

	renderTopology: function () {
		var sig = this.topoSignature();

		if (this.topoCache != null && this.topoCache.sig === sig)
			return this.topoCache.node;

		var node = this.buildTopology();

		this.topoCache = { sig: sig, node: node };

		return node;
	},

	buildTopology: function () {
		var rates = this.topoRates();
		var meta = this.topoMeta();
		var exits = this.topoExits();
		var online = this.onlineDevices();
		var counts = this.topoLinkCounts(online);
		var totalDevices = this.devices().length;
		var i;

		/* 互联网 */
		var internet = topoLayer(_('互联网'), 104, [
			E('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0' }, [
				topoSvgGlobe(30),
				E('div', { style: 'font-size:11px;white-space:nowrap' }, '↓ ' + ((rates.rx == null) ? '—' : fmtRate(rates.rx))),
				E('div', { style: 'font-size:11px;white-space:nowrap' }, '↑ ' + ((rates.tx == null) ? '—' : fmtRate(rates.tx)))
			])
		], E('span', { style: 'font-size:11px;opacity:.55;white-space:nowrap' }, _('实时')));

		/* 出口 */
		var exitBody = [];

		if (!exits.available) {
			exitBody.push(emptyBox(_('暂无出口节点数据（后端未提供 nodes）')));
		}
		else if (!exits.list.length) {
			exitBody.push(emptyBox(_('暂无出口流量')));
		}
		else {
			for (i = 0; i < exits.list.length; i++)
				exitBody.push(this.topoExitCard(exits.list[i], exits.total));
		}

		var exitExtra = E('span', { style: 'font-size:11px;opacity:.55;white-space:nowrap' },
			exits.count > exits.list.length ? (exits.list.length + '/' + exits.count) : (exits.count + ''));

		var exitsLayer = topoLayer(_('出口'), 128, exitBody, exitExtra);

		/* 主路由 */
		var topoConf = this.topoConfidence();
		var routerFields = [
			topoField(_('主机名'), meta.host, meta.host),
			topoField(_('网桥'), meta.bridge.length ? meta.bridge : '—', meta.linkSource ? (meta.linkSource + ' · ' + meta.bridge) : ''),
			topoField(_('在线设备'), totalDevices ? (online.length + ' / ' + totalDevices) : '0'),
			E('div', {
				style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;opacity:.72;min-width:0'
			}, [
				E('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' },
					_('共') + ' ' + totalDevices + ' ' + _('台')),
				badge(topoConf.text, topoConf.color, topoConf.bg)
			])
		];

		var linkMetaWifi = linkMeta({ link: 'wifi' });
		var linkMetaWired = linkMeta({ link: 'wired' });
		var linkMetaUnknown = linkMeta({ link: 'unknown' });

		var router = topoLayer(_('主路由'), 168, [
			E('div', { style: 'display:flex;flex-direction:column;gap:5px;min-width:0' }, routerFields),
			E('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' }, [
				badge(_('无线') + ' ' + counts.wifi, linkMetaWifi.color, linkMetaWifi.bg),
				badge(_('有线') + ' ' + counts.wired, linkMetaWired.color, linkMetaWired.bg),
				badge(_('未知') + ' ' + counts.unknown, linkMetaUnknown.color, linkMetaUnknown.bg)
			])
		]);

		/* AP */
		var apNodes = this.stationsNodes();
		var apBody = [];
		var onlineKeys = {};

		for (i = 0; i < online.length; i++) {
			var om = ((online[i] && online[i].mac == null) ? '' : ('' + online[i].mac)).toLowerCase();

			if (om.length) onlineKeys[om] = true;
		}

		if (this.stations == null) {
			/* 首次切过来时请求还在路上：别把「正在加载」误报成不可用 */
			apBody.push(this.stationsPending
				? emptyBox(_('正在加载 AP 数据…'))
				: emptyBox(_('AP 数据不可用'),
					this.stationsError ? this.stationsError : _('get_stations 未返回数据')));
		}
		else if (!apNodes.length) {
			apBody.push(this.stations.enabled === false
				? emptyBox(_('AP 上报未启用'), _('需要 AP 侧开启 stations_enabled 并上报 get_stations'))
				: emptyBox(_('暂无 AP 上报')));
		}
		else {
			for (i = 0; i < apNodes.length; i++)
				apBody.push(this.topoApCard(apNodes[i], onlineKeys));
		}

		var apExtra = E('span', { style: 'font-size:11px;opacity:.55;white-space:nowrap' },
			this.stations == null ? '—' : (apNodes.length + ''));

		var apLayer = topoLayer(_('AP'), 144, apBody, apExtra);

		/* 在网设备 */
		var devBody = [];

		if (!online.length) {
			devBody.push(emptyBox(_('暂无在线设备'), _('在线口径：最近 10 分钟内有流量')));
		}
		else {
			var groups = [
				{ key: 'wifi', label: _('无线') },
				{ key: 'wired', label: _('有线') },
				{ key: 'unknown', label: _('未知') }
			];

			for (i = 0; i < groups.length; i++) {
				var g = groups[i];
				var glist = online.filter(function (d) { return linkFilterKey(d) === g.key; });

				if (!glist.length) continue;

				devBody.push(this.topoDeviceGroup(g, glist));
			}

			/* 三组都空不可能走到这里（online.length > 0），但保底也留一行占位 */
			if (!devBody.length)
				devBody.push(emptyBox(_('暂无在线设备')));
		}

		var devExtra = E('span', { style: 'font-size:11px;opacity:.55;white-space:nowrap' }, online.length + '');

		var devicesLayer = topoLayer(_('在网设备'), 208, devBody, devExtra);

		/* 从左到右拼层 + 连接件（横向顺序即数据流方向） */
		var layers = [ internet, exitsLayer, router, apLayer, devicesLayer ];
		var row = [];

		for (i = 0; i < layers.length; i++) {
			if (i > 0) row.push(topoConnector());
			row.push(layers[i]);
		}

		return E('div', { 'data-page': 'topology' }, [
			this.renderStateBanner(),
			E('div', {
				/* 只让拓扑这块横向滚动，绝不撑破页面（1200 / 1000px 宽度下都不溢出） */
				style: 'overflow-x:auto;overflow-y:hidden;padding-bottom:6px'
			}, [
				E('div', {
					style: 'display:flex;align-items:flex-start;flex-wrap:nowrap;gap:0;' +
						'min-width:min-content;width:max-content'
				}, row)
			]),
			E('p', { style: 'margin:12px 0 0;font-size:12px;opacity:.65' }, [
				_('从左到右：互联网 → 出口 → 主路由 → AP → 在网设备。'),
				' ',
				_('点设备行可展开该设备的应用 Top 5；点出口卡 / AP 卡可展开该出口 / 该 AP 下的在线设备。'),
				exits.count > exits.list.length ? (' ' + _('出口只画流量最高的') + ' ' + TOPO_MAX_NODES + ' ' + _('个。')) : ''
			])
		]);
	},

	/* 出口卡：节点名（DIRECT 标「直连」）+ 流量 + 占比 + rx/tx；点击展开该出口下的在线设备 */
	topoExitCard: function (n, total) {
		var self = this;
		/* 出口总流量为 0（或分母为 0）时占比显示「—」，绝不出现 NaN / 假的 0% */
		var pct = (total > 0 && n.total > 0 && isFinite(n.total * 100 / total)) ? (n.total * 100 / total) : null;
		var direct = (('' + n.name).toUpperCase() === 'DIRECT');
		var label = direct ? _('直连') : shortText(n.name, 14);
		var open = !!this.topoExitOpen[n.name];
		var body = [
			E('div', { style: 'display:flex;align-items:center;gap:5px;min-width:0' }, [
				E('span', {
					style: 'flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:' +
						(direct ? '#1e8e3e' : '#1a73e8')
				}),
				E('span', {
					style: 'font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
					title: n.name
				}, label),
				E('span', { style: 'flex:none;font-size:10px;opacity:.55' }, open ? '▾' : '▸')
			]),
			E('div', { style: 'font-size:11px;white-space:nowrap;opacity:.9' }, fmtBytes(n.total)),
			E('div', {
				style: 'height:4px;border-radius:2px;background:rgba(127,127,127,.2);overflow:hidden'
			}, E('div', {
				style: 'height:4px;border-radius:2px;width:' +
					((pct == null) ? '0' : pctOf(pct).toFixed(1)) + '%;background:' + (direct ? '#1e8e3e' : '#1a73e8')
			})),
			E('div', {
				style: 'font-size:11px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
				title: ((pct == null) ? _('占比未知') : pct.toFixed(1) + '%') + ' · ↓' + fmtBytes(n.rx) + ' ↑' + fmtBytes(n.tx)
			}, [
				(pct == null) ? '—' : (pct.toFixed(1) + '%'),
				' · ↓' + fmtBytes(n.rx) + ' ↑' + fmtBytes(n.tx)
			])
		];

		/* 下钻：该出口下在线的设备；空列表给占位文案，不画空表 */
		if (open) {
			var devs = this.topoExitDevices(n.name);
			var rows = [];

			if (!devs.length) {
				rows.push(E('div', { style: 'font-size:11px;opacity:.55;padding:2px 0' }, _('该出口暂无设备')));
			}
			else {
				for (var i = 0; i < devs.length; i++) {
					rows.push(E('div', {
						style: 'display:flex;align-items:baseline;justify-content:space-between;gap:4px;min-width:0'
					}, [
						E('span', {
							style: 'flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
							title: deviceName(devs[i])
						}, shortText(deviceName(devs[i]), 16)),
						E('span', { style: 'font-size:11px;white-space:nowrap;opacity:.85' },
							'↓' + fmtRate(num(devs[i].rx_rate)) + ' ↑' + fmtRate(num(devs[i].tx_rate)))
					]));
				}
			}

			body.push(E('div', {
				'class': 'ts-topo-sub',
				style: 'margin-top:2px;padding:4px 2px 1px;border-top:1px dashed rgba(127,127,127,.3);' +
					'display:flex;flex-direction:column;gap:2px;min-width:0'
			}, rows));
		}

		var el = E('div', {
			'class': 'ts-topo-card',
			'data-node': n.name,
			'role': 'button',
			'tabindex': 0,
			'aria-expanded': open ? 'true' : 'false',
			title: n.name + ' · ' + (open ? _('点击收起该出口下的在线设备') : _('点击展开该出口下的在线设备')) +
				'（Enter / Space）',
			style: 'border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:7px 8px;' +
				'display:flex;flex-direction:column;gap:3px;min-width:0;cursor:pointer'
		}, body);

		el.addEventListener('click', function () { self.toggleTopoExit(n.name); });
		el.addEventListener('keydown', function (ev) {
			if (ev == null) return;
			if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
				if (ev.preventDefault) ev.preventDefault();
				self.toggleTopoExit(n.name);
			}
		});

		return el;
	},

	toggleTopoExit: function (name) {
		var key = (name == null) ? '' : ('' + name);

		if (this.topoExitOpen[key]) delete this.topoExitOpen[key];
		else this.topoExitOpen[key] = true;

		/* 签名里带了展开状态，重绘后 DOM 会重建；这是用户动作，不做缓存复用 */
		this.renderSection();
	},

	/* AP 卡：名称 + 新鲜度 + 其下在线无线设备数；点击展开该 AP 下的在线设备 */
	topoApCard: function (n, onlineKeys) {
		var self = this;
		var ap = (n != null && typeof n === 'object') ? n : {};
		var fresh = topoFreshness(ap.age_sec);
		var nid = (ap.node_id == null) ? '' : ('' + ap.node_id);
		var name = (ap.name != null && ('' + ap.name).trim().length) ? ('' + ap.name).trim()
			: (nid.length ? nid : _('未命名 AP'));
		var online = this.apOnlineCount(nid, onlineKeys);
		var reported = num(ap.count);
		var open = !!this.topoApOpen[nid];
		var body = [
			E('div', { style: 'display:flex;align-items:center;gap:5px;min-width:0' }, [
				E('span', { style: 'flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:' + fresh.dot }),
				E('span', {
					style: 'font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
					title: name
				}, shortText(name, 14)),
				E('span', { style: 'flex:none;font-size:10px;opacity:.55' }, open ? '▾' : '▸')
			]),
			E('div', { style: 'font-size:11px;white-space:nowrap' }, fresh.text),
			E('div', { style: 'font-size:11px;opacity:.7;white-space:nowrap' },
				_('在线无线') + ' ' + online + (reported > 0 ? (' / ' + reported) : ''))
		];

		/* 下钻：stations 命中在线设备的无线终端，显示名称 + 信号（无信号退回速率） */
		if (open) {
			var list = this.topoApDevices(nid);
			var rows = [];

			if (!list.length) {
				rows.push(E('div', { style: 'font-size:11px;opacity:.55;padding:2px 0' }, _('该 AP 下暂无在线设备')));
			}
			else {
				for (var i = 0; i < list.length; i++) {
					var d = list[i].device;
					var sig = numOrNull(list[i].station && list[i].station.signal);

					if (sig == null) sig = signalValue(d);

					rows.push(E('div', {
						style: 'display:flex;align-items:baseline;justify-content:space-between;gap:4px;min-width:0'
					}, [
						E('span', {
							style: 'flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
							title: deviceName(d)
						}, shortText(deviceName(d), 14)),
						(sig != null)
							? E('span', {
								style: 'font-size:11px;white-space:nowrap;font-weight:600;color:' + signalColor(sig)
							}, sig + ' dBm')
							: E('span', { style: 'font-size:11px;white-space:nowrap;opacity:.85' },
								'↓' + fmtRate(num(d.rx_rate)) + ' ↑' + fmtRate(num(d.tx_rate)))
					]));
				}
			}

			body.push(E('div', {
				'class': 'ts-topo-sub',
				style: 'margin-top:2px;padding:4px 2px 1px;border-top:1px dashed rgba(127,127,127,.3);' +
					'display:flex;flex-direction:column;gap:2px;min-width:0'
			}, rows));
		}

		var el = E('div', {
			'class': 'ts-topo-card',
			'data-ap': nid,
			'role': 'button',
			'tabindex': 0,
			'aria-expanded': open ? 'true' : 'false',
			title: name + ' · ' + (open ? _('点击收起该 AP 下的在线设备') : _('点击展开该 AP 下的在线设备')) +
				'（Enter / Space）',
			style: 'border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:7px 8px;' +
				'display:flex;flex-direction:column;gap:3px;min-width:0;cursor:pointer'
		}, body);

		el.addEventListener('click', function () { self.toggleTopoAp(nid); });
		el.addEventListener('keydown', function (ev) {
			if (ev == null) return;
			if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
				if (ev.preventDefault) ev.preventDefault();
				self.toggleTopoAp(nid);
			}
		});

		return el;
	},

	toggleTopoAp: function (nodeId) {
		var key = (nodeId == null) ? '' : ('' + nodeId);

		if (this.topoApOpen[key]) delete this.topoApOpen[key];
		else this.topoApOpen[key] = true;

		/* 签名里带了展开状态，重绘后 DOM 会重建；这是用户动作，不做缓存复用 */
		this.renderSection();
	},

	/* 一组在网设备（无线 / 有线 / 未知）：表头徽标 + 最多 8 行，行可点开应用 Top 5 */
	topoDeviceGroup: function (g, list) {
		var shown = list.slice(0, TOPO_MAX_DEVICES);
		var meta = linkMeta({ link: g.key });
		var rows = [];

		for (var i = 0; i < shown.length; i++)
			rows = rows.concat(this.topoDeviceRow(shown[i]));

		if (!rows.length)
			rows.push(E('div', { style: 'font-size:11px;opacity:.55;padding:2px 2px 4px' }, _('无')));

		return E('div', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' }, [
			E('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin:2px 0 3px' }, [
				badge(g.label, meta.color, meta.bg),
				E('span', { style: 'font-size:11px;opacity:.6;white-space:nowrap' },
					shown.length + (list.length > shown.length ? ('/' + list.length) : ''))
			])
		].concat(rows));
	},

	topoDeviceRow: function (d) {
		var self = this;
		var key = deviceKey(d);
		var open = !!this.topoOpen[key];
		var rate = fmtRate(deviceRate(d));
		var rows = [
			E('div', {
				'class': 'ts-topo-row',
				'data-device': key,
				style: 'display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:6px;cursor:pointer;min-width:0',
				title: deviceName(d) + ' · ' + rate + ' · ' + _('点击展开/收起应用 Top 5')
			}, [
				E('span', { style: 'flex:0 0 9px;font-size:10px;opacity:.6' }, open ? '▾' : '▸'),
				E('span', {
					style: 'flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
				}, shortText(deviceName(d), 16)),
				E('span', { style: 'font-size:11px;white-space:nowrap;opacity:.85' }, rate)
			])
		];

		rows[0].addEventListener('click', function () { self.toggleTopoDevice(key); });

		if (open) {
			rows.push(E('div', {
				style: 'margin:0 0 6px 12px;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.08);' +
					'overflow:hidden'
			}, this.renderTopoDeviceApps(d)));
		}

		return rows;
	},

	toggleTopoDevice: function (key) {
		if (this.topoOpen[key]) delete this.topoOpen[key];
		else this.topoOpen[key] = true;

		/* 签名里带了展开状态，重绘后 DOM 会重建；这是用户动作，不做缓存复用 */
		this.renderSection();
	},

	/* 拓扑列窄，复用设备页同一份应用数据（deviceAppsList），只画紧凑的 Top 5 */
	renderTopoDeviceApps: function (d) {
		var list = this.deviceAppsList(d);

		if (list == null || !list.length)
			return E('div', { style: 'font-size:11px;opacity:.6;padding:2px 0' }, _('该设备暂无应用明细（后端未提供）'));

		var top = list.slice(0, 5);

		return E('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
			E('div', { style: 'font-size:10px;opacity:.6;margin-bottom:1px' },
				_('应用 Top 5') + ' · ' + _('共') + ' ' + list.length + ' ' + _('项'))
		].concat(top.map(function (a) {
			return E('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:4px;min-width:0' }, [
				E('span', {
					style: 'flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
					title: appLabel(a.host) + (a.chain ? (' · ' + a.chain) : '')
				}, appLabel(a.host)),
				E('span', { style: 'font-size:11px;white-space:nowrap;opacity:.8' }, fmtBytes(a.rx + a.tx))
			]);
		})));
	},

	/* ------------------------------------------------------------ 系统 */

	renderSystem: function () {
		var sys = (this.state && this.state.system != null && typeof this.state.system === 'object')
			? this.state.system : null;

		var cards = [];
		var cpuPct, cores, load1, load5, load15, memPct, memTotal, memAvail;
		var diskPct, diskTotal, diskUsed, temp, up, wanRx, wanTx, swapTotal, swapFree;

		if (sys) {
			cpuPct = numOrNull(sys.cpu_pct);
			cores = numOrNull(sys.cpu_cores);
			load1 = numOrNull(sys.load1);
			load5 = numOrNull(sys.load5);
			load15 = numOrNull(sys.load15);

			if (cpuPct != null) {
				cards.push(metricCard('cpu', _('CPU 占用'),
					cpuPct.toFixed(1) + '%',
					cores ? (cores + ' ' + _('核')) : '',
					cpuPct));
			}

			if (load1 != null || load5 != null || load15 != null) {
				var parts = [];

				if (load1 != null) parts.push(load1.toFixed(2));
				if (load5 != null) parts.push(load5.toFixed(2));
				if (load15 != null) parts.push(load15.toFixed(2));

				var perCore = '';

				if (load1 != null && cores && cores > 0)
					perCore = _('每核 ≈ ') + (load1 / cores).toFixed(2);

				cards.push(metricCard('load', _('系统负载 (1 / 5 / 15)'), parts.join(' / '), perCore));
			}

			memPct = numOrNull(sys.mem_pct);
			memTotal = numOrNull(sys.mem_total);
			memAvail = numOrNull(sys.mem_avail);

			if (memPct == null && memTotal != null && memAvail != null && memTotal > 0)
				memPct = (memTotal - memAvail) * 100 / memTotal;

			if (memPct != null) {
				var memSub = '';

				if (memTotal != null)
					memSub = _('已用') + ' ' + fmtBytes(Math.max(0, memTotal - num(memAvail))) + ' / ' + fmtBytes(memTotal);

				swapTotal = numOrNull(sys.swap_total);
				swapFree = numOrNull(sys.swap_free);

				if (swapTotal != null && swapTotal > 0)
					memSub += (memSub ? ' · ' : '') + _('Swap') + ' ' + fmtBytes(Math.max(0, swapTotal - num(swapFree))) + ' / ' + fmtBytes(swapTotal);

				cards.push(metricCard('mem', _('内存占用'), memPct.toFixed(1) + '%', memSub, memPct));
			}

			diskPct = numOrNull(sys.disk_pct);
			diskTotal = numOrNull(sys.disk_total);
			diskUsed = numOrNull(sys.disk_used);

			if (diskPct == null && diskTotal != null && diskUsed != null && diskTotal > 0)
				diskPct = diskUsed * 100 / diskTotal;

			if (diskPct != null) {
				var diskSub = (diskTotal != null && diskUsed != null)
					? (_('已用') + ' ' + fmtBytes(diskUsed) + ' / ' + fmtBytes(diskTotal)) : '';

				cards.push(metricCard('disk', _('磁盘占用（rootfs）'), diskPct.toFixed(1) + '%', diskSub, diskPct));
			}

			temp = numOrNull(sys.temp_c);

			if (temp != null)
				cards.push(metricCard('temp', _('温度'), temp.toFixed(1) + ' ℃', _('thermal_zone0')));

			up = numOrNull(sys.uptime);

			if (up != null) {
				var upSub = '';

				if (numOrNull((this.state || {}).uptime) != null)
					upSub = _('守护进程 ') + fmtUptime(this.state.uptime);

				cards.push(metricCard('uptime', _('系统运行时长'), fmtUptime(up), upSub));
			}

			wanRx = numOrNull(sys.wan_rx_rate);
			wanTx = numOrNull(sys.wan_tx_rate);

			if (wanRx != null || wanTx != null) {
				cards.push(metricCard('wan', _('WAN 实时速率'), E('div', {}, [
					wanRx != null ? E('div', { style: 'font-size:18px;line-height:1.35;white-space:nowrap' }, '↓ ' + fmtRate(wanRx)) : '',
					wanTx != null ? E('div', { style: 'font-size:18px;line-height:1.35;white-space:nowrap' }, '↑ ' + fmtRate(wanTx)) : ''
				]), _('按 WAN 接口两轮字节差计算')));
			}
		}

		if (!cards.length) {
			return E('div', { 'data-page': 'system' }, [
				E('div', { 'class': 'alert-message warning', style: 'padding:14px 16px' }, [
					E('p', {}, E('strong', {}, _('系统指标尚未采集（守护进程版本较旧）'))),
					E('p', {}, _('该功能需要新版 prism-routerd，并在 UCI 里保持 system_enabled=1；老版本 state.json 没有 system 段，所以这里没有数据。')),
					E('p', {}, [
						_('可以到'),
						' ',
						E('a', { href: L.url('admin/services/prism-router/settings') }, _('设置页')),
						' ',
						_('确认「系统指标」开关，然后重启服务。')
					])
				])
			]);
		}

		return E('div', { 'data-page': 'system' }, [
			E('p', { style: 'margin:0 0 12px;font-size:12px;opacity:.8' },
				_('来自 state.system（每轮 poll 更新，只读 /proc 与 sysfs）。后端没上报的指标这里不显示，也不补 0。')),
			E('div', {
				style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px'
			}, cards)
		]);
	},

	/* ------------------------------------------------------------ 设置 */

	cfg: function (section, option) {
		if (!this.uciOk) return null;

		var v = null;

		try { v = uci.get('prism-router', section, option); }
		catch (e) { v = null; }

		if (v === null || v === undefined) return null;

		v = '' + v;

		return v.length ? v : null;
	},

	settingRow: function (label, value, hint) {
		if (value == null) return null;

		return E('div', {
			style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:2px 12px;' +
				'align-items:baseline;padding:7px 0;border-bottom:1px dashed rgba(127,127,127,.18);font-size:13px'
		}, [
			E('span', { style: 'opacity:.7' }, label),
			E('div', { style: 'min-width:0;word-break:break-all' }, [
				value,
				hint ? E('div', { style: 'font-size:11px;opacity:.55;margin-top:2px' }, hint) : ''
			])
		]);
	},

	/* 取 UCI 值；缺失时回落到默认值并返回 isDefault（界面上标注「默认」） */
	cfgWithDefault: function (section, option) {
		var v = this.cfg(section, option);

		if (v != null) return { value: v, isDefault: false };

		var def = (UCI_DEFAULTS[section] || {})[option];

		if (def != null) return { value: def, isDefault: true };

		return { value: null, isDefault: false };
	},

	maskSet: function (v) {
		if (!this.uciOk) return _('未知（读不到 UCI）');

		return (v != null && ('' + v).length) ? _('已设置（不显示明文）') : _('未设置');
	},

	renderSettings: function () {
		var self = this;
		var rows, cards = [];
		var v;

		var s = function (label, value, hint) { return self.settingRow(label, value, hint); };

		var defaultHint = function (o) { return o.isDefault ? _('默认') : ''; };

		/* ---- 采集 ---- */
		rows = [];

		v = this.cfgWithDefault('settings', 'enabled');
		if (v.value != null)
			rows.push(s(_('采集开关'),
				flagOn(v.value) ? badge(_('已开启'), '#137333', 'rgba(52,168,83,.15)') : badge(_('已关闭'), '#c5221f', 'rgba(217,48,37,.15)'),
				defaultHint(v)));

		v = this.cfgWithDefault('settings', 'poll_interval');
		if (v.value != null) rows.push(s(_('采集间隔'), v.value + ' ' + _('秒'), defaultHint(v)));

		v = this.cfgWithDefault('settings', 'system_enabled');
		if (v.value != null)
			rows.push(s(_('系统指标采集'), flagOn(v.value) ? _('开启') : _('关闭'), defaultHint(v)));

		v = this.cfg('settings', 'wan_iface');
		if (v != null) rows.push(s(_('WAN 接口'), v, _('留空 = 自动判定')));

		if (rows.length) cards.push(card(_('采集'), E('div', {}, rows)));

		/* ---- Clash ---- */
		rows = [];

		v = this.cfgWithDefault('settings', 'clash_api');
		if (v.value != null) rows.push(s(_('Clash 控制器'), v.value, defaultHint(v)));

		rows.push(s(_('Clash 密钥'), this.maskSet(this.cfg('settings', 'clash_secret'))));

		v = this.cfgWithDefault('settings', 'fake_ip_ranges');
		if (v.value != null)
			rows.push(s(_('fake-ip 网段'), v.value, defaultHint(v) || _('conntrack 去重')));

		v = this.cfg('settings', 'lan_ranges');
		if (v != null) rows.push(s(_('LAN 网段'), v));

		if (rows.length) cards.push(card(_('Clash / 代理'), E('div', {}, rows)));

		/* ---- 接入判定 ---- */
		rows = [];

		v = this.cfgWithDefault('settings', 'lan_bridge');
		if (v.value != null) rows.push(s(_('桥接口'), v.value, defaultHint(v)));

		v = this.cfg('settings', 'wireless_ports');
		rows.push(s(_('无线上联端口'), (v != null) ? v : _('未配置（FDB 学到的设备一律按有线归类）')));

		v = this.cfg('settings', 'ap_macs');
		rows.push(s(_('AP 的 LAN MAC'),
			(v != null) ? v : _('未配置'),
			(v != null) ? (('' + v).split(',').length + ' ' + _('个')) : ''));

		v = this.cfgWithDefault('settings', 'link_refresh');
		if (v.value != null) rows.push(s(_('FDB 刷新间隔'), v.value + ' ' + _('秒'), defaultHint(v)));

		if (rows.length) cards.push(card(_('接入判定（无线 / 有线）'), E('div', {}, rows)));

		/* ---- 飞书 ---- */
		rows = [];

		v = this.cfgWithDefault('feishu', 'enabled');
		if (v.value != null)
			rows.push(s(_('飞书日报'),
				flagOn(v.value) ? badge(_('已启用'), '#137333', 'rgba(52,168,83,.15)') : badge(_('未启用'), '#5f6368', 'rgba(95,99,104,.15)'),
				defaultHint(v)));

		v = this.cfgWithDefault('feishu', 'daily_time');
		if (v.value != null) rows.push(s(_('报表时间'), v.value, defaultHint(v)));

		v = this.cfgWithDefault('feishu', 'report_chat_enabled');
		if (v.value != null) rows.push(s(_('发送到群'), flagOn(v.value) ? _('是') : _('否'), defaultHint(v)));

		rows.push(s(_('群机器人 Webhook'), this.maskSet(this.cfg('feishu', 'webhook'))));
		rows.push(s(_('应用机器人'), (this.cfg('feishu', 'app_id') != null || this.cfg('feishu', 'chat_id') != null)
			? _('已配置') : _('未配置'),
			(this.cfg('feishu', 'app_id') != null || this.cfg('feishu', 'chat_id') != null) ? _('app_id / chat_id 已设置') : ''));

		if (rows.length) cards.push(card(_('飞书日报'), E('div', {}, rows)));

		/* ---- 保留策略 ----
		 * history_days 属于 settings（守护进程自己用）；
		 * 其余来自 retention 段（retention.uc 读取）。该段可能还没写进 /etc/config，
		 * 没有的字段直接不显示，绝不补 0 / 默认值冒充"已配置"。
		 */
		rows = [];

		v = this.cfgWithDefault('settings', 'history_days');
		if (v.value != null) {
			var keepHint = _('history.json 保留天数');

			if (defaultHint(v)) keepHint = defaultHint(v) + ' · ' + keepHint;

			rows.push(s(_('历史文件保留'), v.value + ' ' + _('天'), keepHint));
		}

		v = this.cfg('retention', 'enabled');
		if (v != null)
			rows.push(s(_('清理任务'), flagOn(v, '1') ? badge(_('已启用'), '#137333', 'rgba(52,168,83,.15)') : badge(_('已关闭'), '#5f6368', 'rgba(95,99,104,.15)')));

		var retentionDefs = [
			[ 'daily_days',   _('每日汇总保留'), _('天') ],
			[ 'nodes_days',   _('子节点快照保留'), _('天') ],
			[ 'stations_days', _('AP 站点快照保留'), _('天') ],
			[ 'log_days',     _('日志保留'), _('天') ],
			[ 'log_max_kb',   _('单个日志上限'), 'KB' ],
			[ 'spool_max_kb', _('飞书重试队列上限'), 'KB' ]
		];

		for (var i = 0; i < retentionDefs.length; i++) {
			var rv = this.cfg('retention', retentionDefs[i][0]);

			if (rv != null)
				rows.push(s(retentionDefs[i][1], rv + ' ' + retentionDefs[i][2]));
		}

		if (rows.length) cards.push(card(_('保留策略'), E('div', {}, rows)));

		/* ---- 多节点 / AP 上报：只在真的启用时展示，避免页面噪音 ---- */
		var motherOn = flagOn(this.cfg('settings', 'mother_enabled'), '0');
		var stationsOn = flagOn(this.cfg('settings', 'stations_enabled'), '0');
		var motherUrl = this.cfg('settings', 'mother_url');

		if (motherOn || stationsOn || motherUrl != null) {
			rows = [];

			rows.push(s(_('多节点推送'), motherOn ? _('启用') : _('关闭')));
			if (motherUrl != null) rows.push(s(_('母节点地址'), motherUrl));
			rows.push(s(_('AP 无线元数据上报'), stationsOn ? _('启用') : _('关闭')));

			cards.push(card(_('多节点与 AP'), E('div', {}, rows)));
		}

		var warn = this.uciOk ? '' : E('div', {
			'class': 'alert-message warning', style: 'padding:10px 14px;margin-bottom:14px'
		}, [
			E('strong', {}, _('读不到 UCI 配置：下面显示的是默认值（标注「默认」）')),
			this.uciError ? E('p', {}, E('code', {}, this.uciError)) : ''
		]);

		return E('div', { 'data-page': 'settings' }, [
			warn,
			E('p', { style: 'margin:0 0 14px;font-size:12px;opacity:.8' },
				_('下面是当前生效配置的只读快照（来自 uci prism-router）。标「默认」表示该项没有写进 /etc/config，用的是内置默认值。')),
			E('div', {
				style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px'
			}, cards.length ? cards : [ card(_('配置'), emptyBox(_('没有可展示的配置项'))) ]),
			E('div', {
				style: 'margin-top:16px;padding:14px 16px;border:1px dashed rgba(127,127,127,.35);' +
					'border-radius:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap'
			}, [
				E('span', { style: 'font-size:13px;flex:1;min-width:240px' },
					_('本页只是只读展示；修改请去 LuCI 设置页（保存由后端写 UCI 并重启守护进程）。')),
				E('a', {
					'class': 'cbi-button cbi-button-action',
					href: L.url('admin/services/prism-router/settings'),
					target: '_blank',
					rel: 'noopener',
					style: 'text-decoration:none'
				}, _('去 LuCI 设置页修改'))
			])
		]);
	},

	/* ------------------------------------------------------------ 刷新 */

	/* 15s 自动刷新：只重绘当前标签；节点页额外重拉 get_nodes。
	   历史页跟着刷新当前范围，但近 30 天报文大，降到 5 分钟一次，避免折腾 ubus 与闪存。 */
	refreshNow: function () {
		var self = this;

		if (this.busy) return Promise.resolve();

		this.busy = true;

		var tasks = [
			Promise.resolve().then(function () { return callState(); })
				.then(function (st) {
					if (st != null && typeof st === 'object') {
						self.state = st;
						self.stateError = null;
					}
					self.refreshError = null;
				})
				.catch(function (err) {
					self.refreshError = errText(err);
				})
		];

		/* 节点快照只对「节点」/「拓扑」有意义：其它标签下不发这个 RPC；请求在途时也不叠加 */
		if ((this.tab === 'nodes' || this.tab === 'topology') && !this.nodesPending) {
			tasks.push(Promise.resolve().then(function () { return callNodes(); })
				.then(function (r) {
					if (r != null && Array.isArray(r.nodes)) {
						self.nodes = r.nodes;
						self.nodesError = null;
						self.nodesLoaded = true;
					}
				})
				.catch(function (err) {
					self.nodesError = errText(err);
				}));
		}

		/* 拓扑页才补拉 AP 快照；失败保留上一次数据，只把错误写进 AP 层 */
		if (this.tab === 'topology' && !this.stationsPending) {
			tasks.push(Promise.resolve().then(function () { return callStations(); })
				.then(function (r) {
					if (r != null && typeof r === 'object') {
						self.stations = r;
						self.stationsError = null;
					}
				})
				.catch(function (err) {
					self.stationsError = errText(err);
				}));
		}

		if (this.tab === 'history' && !this.histPending[this.range] && this.historyRefreshDue()) {
			tasks.push(Promise.resolve().then(function () { return callHistory(self.range); })
				.then(function (d) {
					if (d != null && typeof d === 'object') {
						self.hist[self.range] = d;
						self.histAt[self.range] = Date.now();
						self.histErr[self.range] = '';
					}
				})
				.catch(function () {
					/* 后台刷新失败保持沉默：旧图继续用，别把用户的视线拉到一条瞬时错误上 */
				}));
		}

		return Promise.all(tasks).then(function () {
			self.busy = false;
			self.renderSection();
		}).catch(function () {
			self.busy = false;
			self.refreshError = _('刷新失败');
			self.updateStatus();
		});
	},

	/* 历史数据是否到了该刷新的时间：今日/近 7 天跟 15s 节奏，近 30 天 5 分钟一次 */
	historyRefreshDue: function () {
		var last = num((this.histAt || {})[this.range]);
		var maxAge = (this.range === 30) ? HISTORY_REFRESH_LONG_MS : REFRESH_MS;

		if (!last) return true;

		return (Date.now() - last) >= maxAge;
	},

	scheduleRefresh: function () {
		var self = this;

		if (this.timer) {
			try { clearTimeout(this.timer); } catch (e) { }
			this.timer = null;
		}

		var tick = function () {
			if (!document.hidden)
				self.refreshNow();

			self.timer = setTimeout(tick, REFRESH_MS);
		};

		this.timer = setTimeout(tick, REFRESH_MS);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
