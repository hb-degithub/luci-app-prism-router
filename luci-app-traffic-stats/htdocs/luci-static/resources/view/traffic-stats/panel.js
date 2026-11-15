'use strict';
'require view';
'require rpc';
'require dom';
'require uci';

/*
 * 流量详细面板（独立窗口 · 分类标签页）
 *
 * 形态：从概览页「详细面板」按钮新窗口打开（admin/services/traffic-stats/panel），
 * 所以本页隐藏 LuCI 侧栏与页头，让内容铺满整个视口（applyFullscreen，沿用原逻辑）。
 *
 * 七个标签，共用同一份 state，切标签不重新请求后端：
 *   概览 / 趋势 / 设备 / 应用 / 节点 / 系统 / 设置
 *
 * 数据来源只有四个（不新增任何后端方法）：
 *   traffic-stats.get_state   —— totals / devices / apps / nodes / system / health
 *   traffic-stats.get_history —— 今日 5 分钟桶（days=1）；趋势页切「近 7 天」时才请求 days=7
 *   traffic-stats.get_nodes   —— 子节点快照（只在节点页 / 节点页刷新时拉取）
 *   uci('traffic-stats')      —— 设置页只读展示
 *
 * 降级约定（硬要求）：
 *   - 任何字段缺失都走文案，不显示 0 / NaN / undefined，也不白屏；
 *   - 每个标签的渲染都套 try/catch，单页出错只影响该页，其它标签照常；
 *   - 15s 自动刷新只重绘当前标签，切标签不打断定时器，也不重新请求 history；
 *   - 不引外部库：趋势图用文件内的零依赖 SVG 渲染器（tsRenderLine）。
 */

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

/* 只有「趋势」页切到近 7 天时才会用 days=7 再请求一次；失败降级为 days=1。 */
var callHistory = rpc.declare({
	object: 'traffic-stats',
	method: 'get_history',
	params: [ 'days' ],
	expect: {},
	reject: true
});

var callNodes = rpc.declare({
	object: 'traffic-stats',
	method: 'get_nodes',
	expect: { nodes: [] },
	reject: true
});

var REFRESH_MS = 15000;
var STALE_SEC = 300;             /* 节点超过 5 分钟未上报标黄 */
var HISTORY_TIMEOUT_MS = 12000;  /* 近 7 天可能撑爆 ubus，给一个明确的超时降级点 */
var OVERVIEW_CHART_H = 240;
var TREND_CHART_H = 360;         /* 大图高度下限，需求要求 ≥ 340px */
var PANEL_MAX_W = 1680;

var TAB_DEFS = [
	{ id: 'overview', label: '概览' },
	{ id: 'trend',    label: '趋势' },
	{ id: 'devices',  label: '设备' },
	{ id: 'apps',     label: '应用' },
	{ id: 'nodes',    label: '节点' },
	{ id: 'system',   label: '系统' },
	{ id: 'settings', label: '设置' }
];

var SERIES_DEFS = [
	{ key: 'total',  label: '总',   color: '#3949ab' },
	{ key: 'proxy',  label: '代理', color: '#1a73e8' },
	{ key: 'direct', label: '直连', color: '#34a853' },
	{ key: 'wifi',   label: '无线', color: '#a142f4' },
	{ key: 'wired',  label: '有线', color: '#f9ab00' }
];

/* 只读展示用的 UCI 默认值（与 traffic-stats.config 一致）；仅用于标注「默认」，不回写。 */
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

function kpi(key, label, value, sub, color) {
	return E('div', {
		'data-kpi': key,
		style: 'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
			'border-radius:10px;padding:14px 16px;min-width:0'
	}, [
		E('div', { style: 'font-size:12px;opacity:.65;margin-bottom:6px' }, label),
		E('div', { style: 'font-size:24px;font-weight:600;line-height:1.15;color:' + (color || 'inherit') }, value),
		E('div', { style: 'font-size:11px;opacity:.6;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, sub || '')
	]);
}

/* 细堆叠条：比环形图省 10 倍空间，同样表达比例 */
function splitBar(parts) {
	var total = parts.reduce(function (s, p) { return s + num(p.value); }, 0);
	var bar = E('div', {
		style: 'display:flex;height:10px;border-radius:5px;overflow:hidden;background:#e5e7eb'
	}, parts.map(function (p) {
		var pct = total > 0 ? (num(p.value) / total * 100) : 0;

		return E('div', { style: 'width:' + pct.toFixed(2) + '%;background:' + p.color, title: p.label + ' ' + pct.toFixed(1) + '%' }, '');
	}));

	var legend = E('div', { style: 'display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px' },
		parts.map(function (p) {
			var pct = total > 0 ? (num(p.value) / total * 100) : 0;

			return E('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, [
				E('i', { style: 'width:9px;height:9px;border-radius:2px;background:' + p.color + ';display:inline-block' }, ''),
				E('span', {}, p.label),
				E('strong', {}, pct.toFixed(1) + '%'),
				E('span', { style: 'opacity:.6' }, fmtBytes(p.value))
			]);
		}));

	return E('div', {}, [ bar, legend ]);
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
		var style = h.right ? 'text-align:right' : '';

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

	if (range !== 7) {
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

/* ------------------------------------------------------------------ *
 * 零依赖 SVG 折线渲染器
 *
 * 为什么不用 Chart.js：luci-lib-chartjs 里自带的是 nlbwmon 的精简构建，
 * Chart.prototype 上只有 Doughnut / Pie，没有 Line（实测会抛
 * "(intermediate value).Line is not a function"）。引外部 CDN 不可行，
 * 所以趋势图自己用 SVG 画，零依赖、可缩放、支持明暗主题（用半透明中性色）。
 *
 * 尺寸：按宿主的实际像素宽高生成 viewBox（挂载后再画一次），这样文字不会被拉伸。
 * ------------------------------------------------------------------ */
function tsRenderLine(host, data, opts) {
	if (host == null) return null;

	opts = opts || {};

	var labels = (data && data.labels) || [];
	var sets = ((data && data.datasets) || []).filter(function (s) { return s && s.data && s.data.length; });

	if (!labels.length || !sets.length) return null;

	var W = Math.max(320, Math.round(opts.width || host.clientWidth || 900));
	var H = Math.max(120, Math.round(opts.height || host.clientHeight || 240));
	var PL = 68, PR = 14, PT = 10, PB = 24;
	var ticks = Math.max(1, Math.round(opts.yTicks || 4));

	var max = 0;

	sets.forEach(function (s) { s.data.forEach(function (v) { if (+v > max) max = +v; }); });
	if (!(max > 0)) max = 1;

	var n = labels.length;
	var fmtY = opts.fmtY || function (v) { return Math.round(v) + ''; };
	var x = function (i) { return PL + (n === 1 ? 0 : (W - PL - PR) * i / (n - 1)); };
	var y = function (v) { return H - PB - (H - PT - PB) * (Math.max(0, +v) / max); };

	var out = [];
	var g, gy;

	for (g = 0; g <= ticks; g++) {
		gy = PT + (H - PT - PB) * g / ticks;
		out.push('<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) +
			'" stroke="rgba(127,127,127,.16)" stroke-width="1"/>');
		out.push('<text x="' + (PL - 6) + '" y="' + (gy + 3).toFixed(1) +
			'" font-size="10" fill="rgba(127,127,127,.85)" text-anchor="end">' + fmtY(max * (1 - g / ticks)) + '</text>');
	}

	sets.forEach(function (s) {
		var d = s.data.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');

		out.push('<path d="' + d + '" fill="none" stroke="' + (s.strokeColor || '#1a73e8') +
			'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>');
	});

	var step = Math.max(1, Math.ceil(n / 8));

	for (var i = 0; i < n; i += step)
		out.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) +
			'" font-size="10" fill="rgba(127,127,127,.85)" text-anchor="middle">' + labels[i] + '</text>');

	var legend = (opts.legend === false) ? '' : sets.map(function (s) {
		return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px">' +
			'<i style="width:10px;height:3px;border-radius:2px;background:' + (s.strokeColor || '#1a73e8') + ';display:inline-block"></i>' +
			(s.label || '') + '</span>';
	}).join('');

	host.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column">' +
		'<div style="flex:1;min-height:0"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
		'style="width:100%;height:100%;display:block">' + out.join('') + '</svg></div>' +
		(legend ? '<div style="font-size:11px;opacity:.75;padding:6px 0 0 4px">' + legend + '</div>' : '') +
		'</div>';

	return { destroy: function () { try { host.innerHTML = ''; } catch (e) { } } };
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

/* ---------------------------------------------------------------- 页面 */

return view.extend({
	load: function () {
		var self = this;

		this.state = null;
		this.stateError = null;
		this.history = null;
		this.history7 = null;
		this.nodes = [];
		this.nodesError = null;
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

			/* 首屏就要 history=1：概览的 240px 小图和趋势页的「今日」共用这份数据 */
			attempt(function () { return callHistory(1); }).then(function (h) {
				self.history = (h != null && typeof h === 'object') ? h : null;
			}).catch(function () {
				self.history = null;
			}),

			/* 节点快照很轻（只有子节点上报的几个文件），但老后端可能没有这个方法 */
			attempt(callNodes).then(function (r) {
				self.nodes = (r != null && Array.isArray(r.nodes)) ? r.nodes : [];
				self.nodesError = null;
			}).catch(function (err) {
				self.nodes = [];
				self.nodesError = errText(err);
			}),

			/* 设置页只读展示；读不到 UCI 不影响其它标签 */
			attempt(function () { return uci.load('traffic-stats'); }).then(function () {
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
			'#ts-panel .ts-grid-split{display:grid;gap:12px}',
			'@media (max-width:900px){#ts-panel .ts-grid-split{grid-template-columns:1fr!important}}'
		].join('\n');

		document.head.appendChild(E('style', { id: 'ts-panel-fs' }, css));
	},

	render: function () {
		var self = this;

		this.applyFullscreen();

		this.tab = this.tab || 'overview';
		this.range = this.range || 1;
		this.series = this.series || { total: true, proxy: true, direct: true, wifi: false, wired: false };
		this.devSort = this.devSort || { key: 'total', dir: -1 };
		this.devLink = this.devLink || 'all';
		this.devQuery = this.devQuery || '';
		this.appChain = this.appChain || 'all';
		this.expanded = this.expanded || {};
		this.expandedApps = this.expandedApps || {};
		this.refreshError = null;
		this.busy = false;
		this.trendLoading = false;
		this.trendNotice = '';

		this.header = this.buildHeader();
		this.tabBar = this.buildTabs();
		this.sectionHost = E('div', { id: 'ts-panel-section' }, '');

		this.root = E('div', {
			id: 'ts-panel',
			style: 'max-width:' + PANEL_MAX_W + 'px;margin:0 auto'
		}, [ this.header, this.tabBar, this.sectionHost ]);

		this.updateHeader();
		this.renderSection();
		this.scheduleRefresh();

		return this.root;
	},

	/* ------------------------------------------------------------ 顶栏 */

	buildHeader: function () {
		var self = this;

		this.confNode = E('span', { style: 'font-size:12px;padding:2px 8px;border-radius:10px' }, '');
		this.updatedNode = E('span', { style: 'font-size:12px;opacity:.6' }, '');

		return E('div', {
			id: 'ts-panel-header',
			style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap'
		}, [
			E('h2', { style: 'margin:0;font-size:20px' }, _('流量详细面板')),
			this.confNode,
			this.updatedNode,
			E('span', { style: 'flex:1' }, ''),
			E('button', {
				'class': 'cbi-button',
				type: 'button',
				title: _('立即刷新当前标签的数据（不会重新请求 history）'),
				click: function () { self.refreshNow(); }
			}, _('刷新')),
			E('button', {
				'class': 'cbi-button',
				type: 'button',
				click: function () { try { window.close(); } catch (e) { } }
			}, _('关闭'))
		]);
	},

	updateHeader: function () {
		if (this.confNode) {
			var look = confLook(((this.state || {}).health || {}).accounting_confidence);

			this.confNode.textContent = look.text;
			this.confNode.setAttribute('style',
				'font-size:12px;padding:2px 8px;border-radius:10px;color:' + look.color + ';background:' + look.bg);
		}

		if (this.updatedNode) {
			if (this.refreshError)
				this.updatedNode.textContent = _('刷新失败，显示上次数据');
			else if (this.state == null)
				this.updatedNode.textContent = _('暂无数据');
			else if (num((this.state || {}).ts) > 0)
				this.updatedNode.textContent = _('更新于') + ' ' + fmtClock(this.state.ts);
			else
				this.updatedNode.textContent = _('暂无数据');
		}
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
			if (this.tab === 'trend') node = this.renderTrend();
			else if (this.tab === 'devices') node = this.renderDevices();
			else if (this.tab === 'apps') node = this.renderApps();
			else if (this.tab === 'nodes') node = this.renderNodes();
			else if (this.tab === 'system') node = this.renderSystem();
			else if (this.tab === 'settings') node = this.renderSettings();
			else node = this.renderOverview();
		}
		catch (e) {
			/* 单页渲染异常不能白屏：只把这一页换成错误说明，其它标签仍可用 */
			node = this.renderErrorBox(e);
		}

		try {
			dom.content(this.sectionHost, node);
			this.updateTabs();
			this.updateHeader();
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
			if (this.tab === 'overview') this.drawOverviewChart();
			else if (this.tab === 'trend') this.drawTrendChart();
		}
		catch (e) {
			/* 图表失败不影响其它内容；下面各 draw* 自己也兜底 */
		}
	},

	/* ------------------------------------------------------------ 概览 */

	renderStateBanner: function () {
		if (this.state != null) return '';

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px;margin-bottom:14px' }, [
			E('strong', {}, _('读不到状态数据（traffic-statsd 未运行，或 rpcd 的 traffic-stats 对象不可用）')),
			this.stateError ? E('p', {}, E('code', {}, this.stateError)) : '',
			E('p', {}, _('可以点右上角「刷新」重试；刚装好插件时请先确认服务已启动。'))
		]);
	},

	renderOverview: function () {
		var st = this.state || {};
		var totals = st.totals || {};
		var hasTotals = !!(this.state && st.totals);

		var directAll = num(totals.direct_rx) + num(totals.direct_tx);
		var proxyAll = num(totals.proxy_rx) + num(totals.proxy_tx);
		var wifiKnown = (numOrNull(totals.wifi_rx) != null || numOrNull(totals.wifi_tx) != null);
		var wiredKnown = (numOrNull(totals.wired_rx) != null || numOrNull(totals.wired_tx) != null);
		var totalAll = directAll + proxyAll;

		this.ovChartHost = E('div', {
			style: 'height:' + OVERVIEW_CHART_H + 'px;position:relative;min-width:0'
		}, '');

		return E('div', { 'data-page': 'overview' }, [
			this.renderStateBanner(),

			/* KPI 行：6 张卡，口径写在标签/副标题上（totals 是"进程启动以来累计"） */
			E('div', {
				style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px'
			}, [
				kpi('total', _('总流量（累计）'),
					hasTotals ? fmtBytes(totalAll) : '—',
					hasTotals ? (_('下载') + ' ' + fmtBytes(num(totals.direct_rx) + num(totals.proxy_rx)) + ' · ' + _('上传') + ' ' + fmtBytes(num(totals.direct_tx) + num(totals.proxy_tx))) : _('暂无数据')),
				kpi('rate', _('实时速率'),
					hasTotals ? fmtRate(num(totals.rx_rate)) : '—',
					hasTotals ? ('↓ ' + fmtRate(num(totals.rx_rate)) + '   ↑ ' + fmtRate(num(totals.tx_rate))) : _('暂无数据')),
				kpi('proxy', _('代理流量'),
					hasTotals ? fmtBytes(proxyAll) : '—',
					hasTotals ? ('↓ ' + fmtBytes(num(totals.proxy_rx)) + '  ↑ ' + fmtBytes(num(totals.proxy_tx))) : _('暂无数据'), '#1a73e8'),
				kpi('direct', _('直连流量'),
					hasTotals ? fmtBytes(directAll) : '—',
					hasTotals ? ('↓ ' + fmtBytes(num(totals.direct_rx)) + '  ↑ ' + fmtBytes(num(totals.direct_tx))) : _('暂无数据'), '#34a853'),
				kpi('wifi', _('无线接入'),
					wifiKnown ? fmtBytes(num(totals.wifi_rx) + num(totals.wifi_tx)) : '—',
					wifiKnown ? ('↓ ' + fmtBytes(num(totals.wifi_rx)) + '  ↑ ' + fmtBytes(num(totals.wifi_tx))) : _('未采集'), '#a142f4'),
				kpi('wired', _('有线接入'),
					wiredKnown ? fmtBytes(num(totals.wired_rx) + num(totals.wired_tx)) : '—',
					wiredKnown ? ('↓ ' + fmtBytes(num(totals.wired_rx)) + '  ↑ ' + fmtBytes(num(totals.wired_tx))) : _('未采集'), '#f9ab00')
			]),

			/* 趋势 + 比例 */
			E('div', {
				'class': 'ts-grid-split',
				style: 'grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-bottom:14px'
			}, [
				card(_('流量趋势（近 24 小时 · 5 分钟桶）'), this.ovChartHost,
					E('span', { style: 'font-size:12px;opacity:.6' }, _('总 / 代理 / 直连'))),
				card(_('构成比例'), E('div', {}, [
					E('div', { style: 'font-size:12px;opacity:.65;margin-bottom:8px' }, _('代理 vs 直连')),
					splitBar([
						{ label: _('代理'), value: proxyAll, color: '#1a73e8' },
						{ label: _('直连'), value: directAll, color: '#34a853' }
					]),
					E('div', { style: 'font-size:12px;opacity:.65;margin:16px 0 8px' }, _('无线 vs 有线')),
					wifiKnown ? splitBar([
						{ label: _('无线'), value: num(totals.wifi_rx) + num(totals.wifi_tx), color: '#a142f4' },
						{ label: _('有线'), value: num(totals.wired_rx) + num(totals.wired_tx), color: '#f9ab00' },
						{ label: _('未知'), value: num(totals.unknown_rx) + num(totals.unknown_tx), color: '#9aa0a6' }
					]) : E('div', { style: 'opacity:.55;font-size:12px' }, _('未启用接入方式判定'))
				]))
			]),

			/* Top 10 设备 / Top 10 应用 */
			E('div', {
				'class': 'ts-grid-split',
				style: 'grid-template-columns:minmax(0,1fr) minmax(0,1fr)'
			}, [
				card(_('Top 10 设备'), this.renderTopDevices()),
				card(_('Top 10 应用 / 域名'), this.renderTopApps())
			])
		]);
	},

	renderTopDevices: function () {
		var st = this.state || {};
		var list = (Array.isArray(st.devices) ? st.devices.slice() : [])
			.sort(function (a, b) { return deviceTotal(b) - deviceTotal(a); })
			.slice(0, 10);

		var rows = list.map(function (d) {
			var name = deviceName(d);
			var m = linkMeta(d);

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
					E('strong', {}, shortText(name, 26))),
				E('td', { 'class': 'td' }, badge(m.label, m.color, m.bg)),
				E('td', { 'class': 'td', style: 'text-align:right;color:#1a73e8' }, fmtBytes(num(d.proxy_rx) + num(d.proxy_tx))),
				E('td', { 'class': 'td', style: 'text-align:right;color:#34a853' }, fmtBytes(num(d.direct_rx) + num(d.direct_tx))),
				E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(deviceTotal(d))))
			]);
		});

		return table([
			{ label: _('设备') }, { label: _('接入') },
			{ label: _('代理'), right: true }, { label: _('直连'), right: true }, { label: _('合计'), right: true }
		], rows, _('暂无设备数据'));
	},

	renderTopApps: function () {
		var st = this.state || {};
		var list = (Array.isArray(st.apps) ? st.apps.slice() : [])
			.sort(function (a, b) { return appTotal(b) - appTotal(a); })
			.slice(0, 10);

		var rows = list.map(function (a) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: '' + (a.host || '') },
					shortText(appLabel(a.host), 40)),
				E('td', { 'class': 'td' }, chainBadge(a.chain)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(appTotal(a))),
				E('td', { 'class': 'td', style: 'text-align:right;opacity:.7' }, '' + num(a.devices))
			]);
		});

		return table([
			{ label: _('域名 / 应用') }, { label: _('出口') },
			{ label: _('流量'), right: true }, { label: _('设备数'), right: true }
		], rows, _('暂无应用数据'));
	},

	/* 概览的小图：固定用今日（days=1），与趋势页的当前选择互不影响 */
	drawOverviewChart: function () {
		var host = this.ovChartHost;

		if (host == null) return;

		try {
			var trend = buildTrend(1, this.history);

			if (!trend.points.length) {
				dom.content(host, centerBox(_('暂无历史数据（history.json 为空，或守护进程刚启动）')));
				return;
			}

			var data = chartDataFromTrend(trend, { total: true, proxy: true, direct: true });

			if (!data.datasets.length) {
				dom.content(host, centerBox(_('暂无可绘制的曲线')));
				return;
			}

			tsRenderLine(host, data, {
				height: OVERVIEW_CHART_H,
				fmtY: function (v) { return fmtBytes(v); }
			});
		}
		catch (e) {
			dom.content(host, centerBox(_('趋势图绘制失败：') + errText(e)));
		}
	},

	/* ------------------------------------------------------------ 趋势 */

	renderTrend: function () {
		var self = this;
		var payload = (this.range === 7) ? this.history7 : this.history;
		var trend = buildTrend(this.range, payload);
		var available = {
			total: true, proxy: true, direct: true,
			wifi: !!trend.has.wifi, wired: !!trend.has.wired
		};

		this.trendChartHost = E('div', {
			style: 'height:' + TREND_CHART_H + 'px;position:relative;min-width:0'
		}, '');

		var rangeRow = E('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
			E('span', { style: 'font-size:12px;opacity:.7;margin-right:2px' }, _('时间范围')),
			chip(_('今日'), this.range === 1, '#1a73e8', function () { self.setRange(1); }),
			chip(_('近 7 天'), this.range === 7, '#1a73e8', function () { self.setRange(7); })
		]);

		var seriesChips = SERIES_DEFS.filter(function (s) {
			return !!(available[s.key]);
		}).map(function (s) {
			return chip(_(s.label), !!self.series[s.key], s.color, function () { self.toggleSeries(s.key); });
		});

		var seriesRow = E('div', {
			style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px'
		}, [ E('span', { style: 'font-size:12px;opacity:.7;margin-right:2px' }, _('显示曲线')) ].concat(seriesChips));

		var notice = '';

		if (this.trendLoading)
			notice = E('div', { style: 'margin-top:10px;font-size:12px;opacity:.7' }, _('正在加载近 7 天数据…'));
		else if (this.trendNotice)
			notice = E('div', { 'class': 'alert-message warning', style: 'padding:10px 14px;margin-top:10px' }, this.trendNotice);

		var caveat = (this.range === 1)
			? _('今日：5 分钟桶，最多 288 个点（history.json 在 tmpfs，重启即丢）。')
			: _('近 7 天：每天一个点——今天由 5 分钟桶求和，往日取每日汇总（日粒度）。SPEC §3.1 不承诺跨天 5 分钟数据。');

		return E('div', { 'data-page': 'trend' }, [
			this.renderStateBanner(),
			E('div', {
				style: 'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
					'border-radius:10px;padding:12px 14px;margin-bottom:12px'
			}, [ rangeRow, seriesRow ]),
			card(_('流量趋势'), this.trendChartHost,
				E('span', { style: 'font-size:12px;opacity:.6' },
					this.range === 1 ? _('今日 · 5 分钟桶') : _('近 7 天 · 日粒度'))),
			notice,
			E('p', { style: 'margin:10px 0 0;font-size:12px;opacity:.7' }, caveat)
		]);
	},

	/* 切到近 7 天：只有这里会额外请求 history；超过 ubus 上限/超时就降级回今日 */
	setRange: function (n) {
		var self = this;

		n = (n === 7) ? 7 : 1;

		if (n === 1) {
			this.range = 1;
			this.trendLoading = false;
			this.trendNotice = '';
			this.renderSection();
			return;
		}

		this.range = 7;
		this.trendNotice = '';

		if (this.history7) {
			this.trendLoading = false;
			this.renderSection();
			return;
		}

		if (this.trendPending) return;

		this.trendLoading = true;
		this.trendPending = true;
		this.renderSection();

		var timeout = new Promise(function (resolve, reject) {
			setTimeout(function () { reject(new Error('timeout')); }, HISTORY_TIMEOUT_MS);
		});

		Promise.race([ Promise.resolve().then(function () { return callHistory(7); }), timeout ])
			.then(function (data) {
				self.history7 = (data != null && typeof data === 'object') ? data : { days: [] };
				self.trendLoading = false;
				self.trendPending = false;
				self.renderSection();
			})
			.catch(function () {
				/* 降级：回到 days=1，并把原因写在趋势页顶部 */
				self.trendLoading = false;
				self.trendPending = false;
				self.range = 1;
				self.trendNotice = _('近 7 天数据读取失败（可能超过 ubus 单条消息上限，或后端超时），已降级为「今日」。');

				return Promise.resolve().then(function () { return callHistory(1); })
					.then(function (d) {
						if (d != null && typeof d === 'object') self.history = d;
					})
					.catch(function () { })
					.then(function () { self.renderSection(); });
			})
			.catch(function () { /* 兜底：渲染失败也不能冒出未处理的 Promise 拒绝 */ });
	},

	toggleSeries: function (key) {
		if (!key) return;

		this.series[key] = !this.series[key];
		this.renderSection();
	},

	drawTrendChart: function () {
		var host = this.trendChartHost;

		if (host == null) return;

		try {
			if (this.range === 7 && this.trendLoading) {
				dom.content(host, centerBox(_('正在加载近 7 天数据…')));
				return;
			}

			var payload = (this.range === 7) ? this.history7 : this.history;
			var trend = buildTrend(this.range, payload);

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
		this.devTableHost = E('div', {}, this.renderDeviceTableBody());

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
			{ label: _('主机名'), sortKey: 'host' },
			{ label: _('IP'), sortKey: 'ip' },
			{ label: _('MAC'), sortKey: 'mac' },
			{ label: _('接入'), sortKey: 'link' },
			{ label: _('直连'), right: true, sortKey: 'direct' },
			{ label: _('代理'), right: true, sortKey: 'proxy' },
			{ label: _('合计'), right: true, sortKey: 'total' },
			{ label: _('速率'), right: true, sortKey: 'rate', title: _('下载 + 上传，bit/s') },
			{ label: _('最后在线'), right: true, sortKey: 'last_seen' },
			{ label: _('信号'), right: true, sortKey: 'signal', title: _('来自哑桥 AP 的无线信号（若有）') }
		];

		return cols.map(function (c) {
			var o = {
				label: c.label,
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
				: emptyBox(_('暂无设备数据（traffic-statsd 还没采到设备流量）'));
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
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(direct)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(proxy)),
			E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(deviceTotal(d)))),
			E('td', { 'class': 'td', style: 'text-align:right', title: fmtRate(deviceRate(d)) }, fmtRate(deviceRate(d))),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtAgo(d.last_seen)),
			E('td', {
				'class': 'td',
				style: 'text-align:right;color:' + (sig == null ? 'inherit' : signalColor(sig)),
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

	renderDeviceApps: function (d) {
		var apps = (d != null && d.apps != null && typeof d.apps === 'object') ? d.apps : null;

		if (apps == null)
			return E('div', { style: 'font-size:12px;opacity:.65' }, _('该设备暂无应用明细（后端未提供）'));

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

		if (!list.length)
			return E('div', { style: 'font-size:12px;opacity:.65' }, _('该设备暂无应用明细（后端未提供）'));

		list.sort(function (a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

		var top = list.slice(0, 10);

		var rows = top.map(function (a) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
					shortText(appLabel(a.host), 48)),
				E('td', { 'class': 'td' }, chainBadge(a.chain)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(a.rx + a.tx))
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
					E('th', { 'class': 'th' }, _('出口')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('流量'))
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
		this.appTableHost = E('div', {}, this.renderAppTableBody());

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
			{ label: _('出口') },
			{ label: _('流量'), right: true },
			{ label: _('设备数'), right: true }
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
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(appTotal(a))),
			E('td', { 'class': 'td', style: 'text-align:right' }, '' + num(a.devices))
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
				E('td', { 'class': 'td' }, E('code', {}, d.ip || '—')),
				E('td', { 'class': 'td' }, m ? badge(m.label, m.color, m.bg) : '—'),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(d.rx + d.tx))
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
					E('th', { 'class': 'th' }, _('IP')),
					E('th', { 'class': 'th' }, _('接入')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('该应用流量'))
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

		if (!list.length) {
			return E('div', { 'data-page': 'nodes' }, [
				E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
					E('p', {}, E('strong', {}, _('暂无节点（多节点未启用或尚未上报）'))),
					this.nodesError ? E('p', {}, _('读取失败：') + this.nodesError) : '',
					E('p', {}, _('子节点需要配置 mother_enabled=1 / mother_url / mother_secret，并由 cron 每分钟运行一次 push.uc；母节点需要同一个 mother_secret。')),
					E('p', { style: 'font-size:12px;opacity:.8' },
						_('验证：在任一节点执行 ucode /usr/share/traffic-stats/push.uc，然后点右上角「刷新」。'))
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
				E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(t.total))),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(t.proxy)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(t.direct)),
				E('td', { 'class': 'td', style: 'text-align:right' }, '' + self.nodeDeviceCount(n))
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
				{ label: _('最后上报'), right: true },
				{ label: _('总流量'), right: true },
				{ label: _('代理'), right: true },
				{ label: _('直连'), right: true },
				{ label: _('设备数'), right: true }
			], rows, _('暂无节点（多节点未启用或尚未上报）'))
		]);
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
				var wanText = [];

				if (wanRx != null) wanText.push('↓ ' + fmtRate(wanRx));
				if (wanTx != null) wanText.push('↑ ' + fmtRate(wanTx));

				cards.push(metricCard('wan', _('WAN 实时速率'), wanText.join('   '), _('按 WAN 接口两轮字节差计算')));
			}
		}

		if (!cards.length) {
			return E('div', { 'data-page': 'system' }, [
				E('div', { 'class': 'alert-message warning', style: 'padding:14px 16px' }, [
					E('p', {}, E('strong', {}, _('系统指标尚未采集（守护进程版本较旧）'))),
					E('p', {}, _('该功能需要新版 traffic-statsd，并在 UCI 里保持 system_enabled=1；老版本 state.json 没有 system 段，所以这里没有数据。')),
					E('p', {}, [
						_('可以到'),
						' ',
						E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('设置页')),
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

		try { v = uci.get('traffic-stats', section, option); }
		catch (e) { v = null; }

		if (v === null || v === undefined) return null;

		v = '' + v;

		return v.length ? v : null;
	},

	settingRow: function (label, value, hint) {
		if (value == null) return null;

		return E('div', {
			style: 'display:flex;gap:12px;align-items:baseline;padding:6px 0;' +
				'border-bottom:1px dashed rgba(127,127,127,.18);font-size:13px'
		}, [
			E('span', { style: 'min-width:150px;opacity:.7;flex-shrink:0' }, label),
			E('span', { style: 'flex:1;min-width:0;word-break:break-all' }, value),
			hint ? E('span', { style: 'font-size:11px;opacity:.55;white-space:nowrap' }, hint) : ''
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

		rows.push(s(_('Clash 密钥'), this.maskSet(this.cfg('settings', 'clash_secret')), _('留空时自动读 OpenClash')));

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
			? _('已配置（app_id / chat_id 已设置）') : _('未配置')));

		if (rows.length) cards.push(card(_('飞书日报'), E('div', {}, rows)));

		/* ---- 保留策略（字段可能还没实现：没有就不显示） ---- */
		rows = [];

		v = this.cfgWithDefault('settings', 'history_days');
		if (v.value != null) {
			var keepHint = _('history.json + 每日汇总');

			if (defaultHint(v)) keepHint = defaultHint(v) + ' · ' + keepHint;

			rows.push(s(_('历史保留'), v.value + ' ' + _('天'), keepHint));
		}

		var extraKeys = [ 'retention_days', 'keep_days', 'daily_keep' ];

		for (var i = 0; i < extraKeys.length; i++) {
			v = this.cfg('settings', extraKeys[i]);

			if (v != null) rows.push(s(extraKeys[i], v));
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
				_('下面是当前生效配置的只读快照（来自 uci traffic-stats）。标「默认」表示该项没有写进 /etc/config，用的是内置默认值。')),
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
					href: L.url('admin/services/traffic-stats/settings'),
					target: '_blank',
					rel: 'noopener',
					style: 'text-decoration:none'
				}, _('去 LuCI 设置页修改'))
			])
		]);
	},

	/* ------------------------------------------------------------ 刷新 */

	/* 15s 自动刷新：只重绘当前标签；只有节点页会额外重拉 get_nodes。
	   history 不在这里请求——只有趋势页切「近 7 天」才会请求。 */
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

		if (this.tab === 'nodes') {
			tasks.push(Promise.resolve().then(function () { return callNodes(); })
				.then(function (r) {
					if (r != null && Array.isArray(r.nodes)) {
						self.nodes = r.nodes;
						self.nodesError = null;
					}
				})
				.catch(function (err) {
					self.nodesError = errText(err);
				}));
		}

		return Promise.all(tasks).then(function () {
			self.busy = false;
			self.renderSection();
		}).catch(function () {
			self.busy = false;
			self.refreshError = _('刷新失败');
			self.updateHeader();
		});
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
