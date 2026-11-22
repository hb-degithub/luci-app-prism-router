'use strict';
'require view';
'require dom';
'require rpc';
'require ui';
'require prism-router/theme as theme';

/*
 * 棱镜路由 · 多节点（子母汇总）
 *
 * 只调 prism-router.get_nodes（母节点 rpcd 读 /etc/prism-router/nodes/*.json），
 * 不碰 get_state，也不做任何本地累加：
 *   - latest.totals 是"子节点守护进程启动以来的累计值"，不是今日增量（见 SPEC §3.1），
 *     所以这里只展示、不求和成"全网总量"。
 *   - age_sec 0..300 = 在线；>300 = 离线；<0 / 缺失 = 未上报（快照没有可信时间戳）。
 *
 * 排序 / 筛选 / 展开全部只操作本地快照，不发 RPC。自动刷新 15s 一次，
 * 页面卸载或根节点被移出文档时停表；失败只显示错误条，保留上一次成功数据。
 *
 * 单位：流量二进制（GiB/MiB），与设备/应用页保持一致。
 */

var REFRESH_MS = 15000;
var STALE_SEC = 300;
var TOP_N = 5;

var SORT_KEYS = [ 'ts', 'total', 'devices' ];
var FILTER_KEYS = [ 'all', 'online', 'offline' ];

var callNodes = rpc.declare({
	object: 'prism-router',
	method: 'get_nodes',
	expect: { nodes: [] },
	reject: true
});

// ---------------------------------------------------------------- AP 管理（顶部区块）
//
// 只调 rpcd 的 ap_* 方法：ap_list 只读（read ACL），绑定/重命名/删除/命令都要 root 会话
// （admin ACL）。列表数据完全来自 rpcd，前端不算"在线"（online 由 rpcd 按 180 秒判定），
// 避免两端口径漂移。

var callApList = rpc.declare({
	object: 'prism-router',
	method: 'ap_list',
	expect: { aps: [] },
	reject: true
});

var callApBindStart = rpc.declare({
	object: 'prism-router',
	method: 'ap_bind_start',
	params: [ 'name', 'node_id', 'host' ],
	reject: true
});

var callApRename = rpc.declare({
	object: 'prism-router',
	method: 'ap_rename',
	params: [ 'node_id', 'name' ],
	reject: true
});

var callApDelete = rpc.declare({
	object: 'prism-router',
	method: 'ap_delete',
	params: [ 'node_id' ],
	reject: true
});

var callApCmd = rpc.declare({
	object: 'prism-router',
	method: 'ap_cmd',
	params: [ 'node_id', 'cmd' ],
	reject: true
});

function apIsOnline(ap) {
	return ap != null && ap.online === true;
}

function apAgeText(ap) {
	if (ap == null || ap.age_sec == null || ap.age_sec < 0) return _('未上报');

	return fmtAge(ap.age_sec);
}

function apMetric(label, value) {
	var t = '' + value;

	return E('div', { 'class': 'tsn-ap-metric' }, [
		E('div', { 'class': 'tsn-ap-metric-k' }, label),
		E('div', { 'class': 'tsn-ap-metric-v', 'title': t }, t)
	]);
}

function apCopyFallback(text) {
	try {
		var ta = document.createElement('textarea');

		ta.value = text;
		ta.setAttribute('readonly', 'readonly');
		ta.style.position = 'fixed';
		ta.style.top = '-1000px';
		ta.style.left = '0';
		document.body.appendChild(ta);
		ta.select();
		document.execCommand('copy');
		document.body.removeChild(ta);
	}
	catch (e) {
		/* 复制失败不弹错：文本本身可选，用户可手动复制 */
	}
}

function apCopy(text, btn) {
	var done = function() {
		if (btn == null) return;

		var old = btn.textContent;

		btn.textContent = _('已复制');

		if (typeof window != 'undefined' && typeof window.setTimeout == 'function')
			window.setTimeout(function() { btn.textContent = old; }, 1200);
	};

	var nav = (typeof navigator != 'undefined') ? navigator : null;

	if (nav != null && nav.clipboard != null && typeof nav.clipboard.writeText == 'function') {
		nav.clipboard.writeText(text).then(done, function() {
			apCopyFallback(text);
			done();
		});
		return;
	}

	apCopyFallback(text);
	done();
}

function apCodeRow(label, value) {
	var btn = E('button', { 'type': 'button', 'class': 'tsn-btn' }, _('复制'));

	btn.addEventListener('click', function() { apCopy(value, btn); });

	return E('div', { 'class': 'tsn-bind-row' }, [
		E('div', { 'class': 'tsn-bind-k' }, label),
		E('pre', { 'class': 'tsn-code tsn-copyable', 'tabindex': '0' }, value),
		btn
	]);
}

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

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

/* age_sec -> 人话；-1 表示快照里没有可信时间戳。 */
function fmtAge(age) {
	var sec = num(age);

	if (age == null || sec < 0) return _('未知');
	if (sec < 10) return _('刚刚');
	if (sec < 60) return sec + ' ' + _('秒前');
	if (sec < 3600) return Math.floor(sec / 60) + ' ' + _('分钟前');
	if (sec < 86400) return Math.floor(sec / 3600) + ' ' + _('小时前');

	return Math.floor(sec / 86400) + ' ' + _('天前');
}

/* 详情里的完整绝对时间，带年份。 */
function fmtStamp(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
		pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function clockText(date) {
	if (date == null || typeof date.getHours != 'function') return '';

	var t = date.getTime();

	if (!isFinite(t)) return '';

	return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function errText(err) {
	if (err == null) return _('未知错误');
	if (typeof err == 'string') return err;
	if (typeof err == 'number') return '' + err;
	if (err.message) return '' + err.message;
	if (err.error) return '' + err.error;

	try {
		return JSON.stringify(err);
	}
	catch (e) {
		return '' + err;
	}
}

function nodeIdOf(node) {
	if (node == null || node.node_id == null) return '';

	return '' + node.node_id;
}

function nodeNameOf(node) {
	if (node == null) return '—';
	if (node.name && ('' + node.name).length) return '' + node.name;
	if (node.node_id && ('' + node.node_id).length) return '' + node.node_id;

	return '—';
}

function nodeKey(node) {
	var id = nodeIdOf(node);

	return 'n:' + (id.length ? id : nodeNameOf(node));
}

function latestOf(node) {
	return (node != null && node.latest != null && typeof node.latest == 'object') ? node.latest : {};
}

/* 一个节点的 latest.totals 投影成 直连 / 代理 / 合计。 */
function totalsOf(node) {
	var t = latestOf(node).totals;
	var totals = (t != null && typeof t == 'object') ? t : {};

	var direct = num(totals.direct_rx) + num(totals.direct_tx);
	var proxy = num(totals.proxy_rx) + num(totals.proxy_tx);

	return {
		direct: direct,
		proxy: proxy,
		total: direct + proxy
	};
}

function devicesOf(node) {
	var list = latestOf(node).devices;

	return Array.isArray(list) ? list : [];
}

function appsOf(node) {
	var list = latestOf(node).apps;

	return Array.isArray(list) ? list : [];
}

function deviceTotal(dev) {
	if (dev == null) return 0;

	return num(dev.direct_rx) + num(dev.direct_tx) + num(dev.proxy_rx) + num(dev.proxy_tx);
}

function appTotal(app) {
	if (app == null) return 0;

	return num(app.rx) + num(app.tx);
}

function ageOf(node) {
	if (node == null || node.age_sec == null) return -1;

	return num(node.age_sec);
}

/* 在线 0..300；离线 >300；缺时间戳 / -1 = 未上报。 */
function statusOf(node) {
	var age = ageOf(node);

	if (age < 0) return 'unreported';
	if (age <= STALE_SEC) return 'online';

	return 'offline';
}

function statusLabel(status) {
	if (status == 'online') return _('在线');
	if (status == 'offline') return _('离线');

	return _('未上报');
}

function sortLabel(key) {
	if (key == 'total') return _('总流量');
	if (key == 'devices') return _('设备数');

	return _('最后上报');
}

function filterLabel(key) {
	if (key == 'online') return _('在线');
	if (key == 'offline') return _('离线');

	return _('全部');
}

function countStatus(nodes) {
	var counts = { online: 0, offline: 0, unreported: 0 };

	for (var i = 0; i < nodes.length; i++)
		counts[statusOf(nodes[i])]++;

	return counts;
}

/* 最后上报时间：优先 ts；只有 age_sec 时用本地时间近似，全部缺失排最后。 */
function reportTs(node) {
	var ts = num(node != null ? node.ts : null);

	if (ts > 0) return ts;

	var age = ageOf(node);

	if (age >= 0) return Math.floor(Date.now() / 1000) - age;

	return -1;
}

function compareNodes(a, b, key) {
	var va, vb;

	if (key == 'total') {
		va = totalsOf(a).total;
		vb = totalsOf(b).total;
	}
	else if (key == 'devices') {
		va = devicesOf(a).length;
		vb = devicesOf(b).length;
	}
	else {
		va = reportTs(a);
		vb = reportTs(b);
	}

	if (va != vb) return (vb > va) ? 1 : -1;

	var na = nodeNameOf(a);
	var nb = nodeNameOf(b);

	if (na != nb) return (na > nb) ? 1 : -1;

	var ia = nodeIdOf(a);
	var ib = nodeIdOf(b);

	return (ia > ib) ? 1 : ((ia < ib) ? -1 : 0);
}

function sortedNodes(nodes, key) {
	var list = nodes.slice();

	list.sort(function(a, b) {
		return compareNodes(a, b, key);
	});

	return list;
}

function filterNodes(nodes, filter) {
	if (filter != 'online' && filter != 'offline') return nodes.slice();

	return nodes.filter(function(node) {
		return statusOf(node) == filter;
	});
}

function topDevices(node) {
	var list = devicesOf(node).slice();

	list.sort(function(a, b) {
		var d = deviceTotal(b) - deviceTotal(a);

		if (d) return d;

		return 0;
	});

	return list.slice(0, TOP_N);
}

function topApps(node) {
	var list = appsOf(node).slice();

	list.sort(function(a, b) {
		var d = appTotal(b) - appTotal(a);

		if (d) return d;

		return 0;
	});

	return list.slice(0, TOP_N);
}

function deviceLabel(dev) {
	if (dev == null) return _('未知设备');

	var host = (dev.hostname != null) ? ('' + dev.hostname).replace(/^\s+|\s+$/g, '') : '';

	if (host.length) return host;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
}

function deviceMeta(dev) {
	var label = deviceLabel(dev);
	var parts = [];

	if (dev != null && dev.ip && ('' + dev.ip) != label) parts.push('' + dev.ip);
	if (dev != null && dev.mac && ('' + dev.mac) != label) parts.push('' + dev.mac);

	return parts.join(' · ');
}

function chainLabel(chain) {
	var c = (chain != null) ? ('' + chain).replace(/^\s+|\s+$/g, '') : '';

	if (!c.length) return '';
	if (c.toUpperCase() == 'DIRECT') return _('直连');

	return c;
}

function appLabel(app) {
	if (app == null) return _('未知应用');
	if (app.host && ('' + app.host).length) return '' + app.host;

	return _('未知应用');
}

function appMeta(app) {
	var parts = [];
	var chain = chainLabel(app != null ? app.chain : '');
	var devices = num(app != null ? app.devices : 0);

	if (chain.length) parts.push(_('链路') + ' ' + chain);
	if (devices > 0) parts.push(devices + ' ' + _('台设备'));

	return parts.join(' · ');
}

function clear(el) {
	if (el == null) return;

	while (el.firstChild)
		el.removeChild(el.firstChild);
}

function metric(label, value) {
	var text = '' + value;

	return E('div', { 'class': 'tsn-metric' }, [
		E('div', { 'class': 'tsn-metric-k' }, label),
		E('div', { 'class': 'tsn-metric-v', 'title': text }, text)
	]);
}

function detailSection(title, note, rows, emptyText) {
	return E('div', { 'class': 'tsn-detail-sect' }, [
		E('div', { 'class': 'tsn-detail-h' }, [
			E('span', {}, title),
			note.length ? E('span', { 'class': 'tsn-detail-h-n' }, note) : ''
		]),
		rows.length ? E('div', {}, rows) : E('div', { 'class': 'tsn-sub-empty' }, emptyText)
	]);
}

/* 展开区：最后上报（绝对 + 相对）、设备 Top 5、应用 Top 5。 */
function buildDetails(node, totals, age, devs, apps) {
	var last;

	if (num(node != null ? node.ts : null) > 0)
		last = fmtStamp(node.ts) + '（' + fmtAge(age) + '）';
	else
		last = _('未知（快照没有可信时间戳）');

	var devRows = topDevices(node).map(function(dev, i) {
		var label = deviceLabel(dev);
		var meta = deviceMeta(dev);

		return E('div', { 'class': 'tsn-row' }, [
			E('span', { 'class': 'tsn-rank' }, '' + (i + 1)),
			E('div', { 'class': 'tsn-row-main' }, [
				E('div', { 'class': 'tsn-row-name', 'title': label }, label),
				meta.length ? E('div', { 'class': 'tsn-row-sub', 'title': meta }, meta) : ''
			]),
			E('span', { 'class': 'tsn-row-val' }, fmtBytes(deviceTotal(dev)))
		]);
	});

	var appRows = topApps(node).map(function(app, i) {
		var label = appLabel(app);
		var meta = appMeta(app);

		return E('div', { 'class': 'tsn-row' }, [
			E('span', { 'class': 'tsn-rank' }, '' + (i + 1)),
			E('div', { 'class': 'tsn-row-main' }, [
				E('div', { 'class': 'tsn-row-name', 'title': label }, label),
				meta.length ? E('div', { 'class': 'tsn-row-sub', 'title': meta }, meta) : ''
			]),
			E('span', { 'class': 'tsn-row-val' }, fmtBytes(appTotal(app)))
		]);
	});

	return [
		E('div', { 'class': 'tsn-detail-line' }, [
			E('span', { 'class': 'tsn-detail-k' }, _('最后上报')),
			E('span', { 'class': 'tsn-detail-v' }, last)
		]),
		E('div', { 'class': 'tsn-detail-line' }, [
			E('span', { 'class': 'tsn-detail-k' }, _('累计流量')),
			E('span', { 'class': 'tsn-detail-v' },
				_('总') + ' ' + fmtBytes(totals.total) + ' · ' +
				_('代理') + ' ' + fmtBytes(totals.proxy) + ' · ' +
				_('直连') + ' ' + fmtBytes(totals.direct))
		]),
		detailSection(_('设备 Top') + ' ' + TOP_N,
			_('共') + ' ' + devs.length + ' ' + _('台，按累计流量排序'),
			devRows, _('该节点未上报设备明细')),
		detailSection(_('应用 Top') + ' ' + TOP_N,
			_('共') + ' ' + apps.length + ' ' + _('个，按累计流量排序'),
			appRows, _('该节点未上报应用明细'))
	];
}

// ---------------------------------------------------------------- 样式（内联，不引外部 CSS）

var CSS = [
	'#ts-nodes{font-size:var(--ts-fs-2);line-height:1.55;max-width:100%;min-width:0}',
	'#ts-nodes *,#ts-nodes *::before,#ts-nodes *::after{box-sizing:border-box}',

	/* 标题 + 最后更新时间 */
	'#ts-nodes .tsn-head{display:flex;align-items:baseline;gap:8px 12px;flex-wrap:wrap;margin:0 0 3px 0}',
	'#ts-nodes .tsn-title{margin:0;font-size:var(--ts-fs-4);font-weight:600;line-height:1.4;white-space:nowrap}',
	'#ts-nodes .tsn-updated{margin-left:auto;font-size:var(--ts-fs-1);color:var(--ts-text-3);white-space:nowrap;',
	'font-variant-numeric:tabular-nums}',
	'#ts-nodes .tsn-sub{margin:0 0 10px 0;font-size:var(--ts-fs-1);line-height:1.65;color:var(--ts-text-2)}',

	/* 摘要卡 */
	'#ts-nodes .tsn-summary{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;',
	'margin:0 0 10px 0;padding:9px 12px;border-radius:var(--ts-r);background:var(--ts-surface);',
	'border:1px solid var(--ts-border);min-width:0}',
	'#ts-nodes .tsn-sum-main{display:flex;align-items:baseline;gap:2px 5px;flex-wrap:wrap;min-width:0}',
	'#ts-nodes .tsn-sum-stat{display:inline-flex;align-items:center;gap:5px;font-size:12px;',
	'font-weight:600;white-space:nowrap}',
	'#ts-nodes .tsn-sum-k{font-weight:400;opacity:.72}',
	'#ts-nodes .tsn-sum-v{font-size:18px;line-height:1.25;font-variant-numeric:tabular-nums}',
	'#ts-nodes .tsn-sep{opacity:.35;padding:0 1px}',
	'#ts-nodes .tsn-sum-unit{font-size:12px;opacity:.72;white-space:nowrap}',
	'#ts-nodes .tsn-sum-total{margin-left:auto;font-size:var(--ts-fs-1);color:var(--ts-text-2);white-space:nowrap}',

	/* 状态胶囊 / 圆点 */
	'#ts-nodes .tsn-pill{display:inline-flex;align-items:center;gap:5px;flex:none;',
	'font-size:12px;font-weight:600;line-height:1.8;padding:0 8px;border-radius:var(--ts-r-sm);',
	'border:1px solid transparent;white-space:nowrap}',
	'#ts-nodes .tsn-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;',
	'background:currentColor}',
	'#ts-nodes .tsn-pill.tsn-st-online{background:rgba(22,163,74,.10);border-color:rgba(22,163,74,.40);color:var(--ts-ok-text)}',
	'#ts-nodes .tsn-pill.tsn-st-offline{background:rgba(217,119,6,.10);border-color:rgba(217,119,6,.42);color:var(--ts-warn-text)}',
	'#ts-nodes .tsn-pill.tsn-st-unreported{background:var(--ts-surface-2);border-color:var(--ts-border);color:var(--ts-text-2)}',
	'#ts-nodes .tsn-sum-stat.tsn-st-online{color:var(--ts-ok-text)}',
	'#ts-nodes .tsn-sum-stat.tsn-st-offline{color:var(--ts-warn-text)}',
	'#ts-nodes .tsn-sum-stat.tsn-st-unreported{color:var(--ts-text-2)}',

	/* 工具栏（纯本地排序 / 筛选） */
	'#ts-nodes .tsn-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px 0}',
	'#ts-nodes .tsn-field{display:inline-flex;align-items:center;gap:5px;min-width:0}',
	'#ts-nodes .tsn-field-k{font-size:11.5px;opacity:.68;white-space:nowrap}',
	'#ts-nodes .tsn-select{font:inherit;font-size:12px;line-height:1.9;padding:0 6px;border-radius:8px;',
	'color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.28);max-width:100%}',
	'#ts-nodes .tsn-seg{display:inline-flex;flex-wrap:wrap;border:1px solid rgba(127,127,127,.28);',
	'border-radius:9px;overflow:hidden;max-width:100%}',
	'#ts-nodes .tsn-seg-btn{font:inherit;font-size:12px;line-height:1.9;padding:0 10px;border:0;',
	'border-right:1px solid var(--ts-border);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
	'#ts-nodes .tsn-seg-btn:last-child{border-right:0}',
	'#ts-nodes .tsn-seg-btn.on{background:var(--ts-surface-2);color:var(--ts-down-text);font-weight:600}',
	'#ts-nodes .tsn-count{font-size:11px;opacity:.62;white-space:nowrap;margin-left:auto}',
	'#ts-nodes .tsn-toolbar-note{flex:1 1 100%;font-size:10.5px;line-height:1.6;opacity:.62}',

	/* 错误条：保留旧数据 + 重试 */
	'#ts-nodes .tsn-alert{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;',
	'margin:0 0 10px 0;padding:9px 12px;border-radius:var(--ts-r-sm);background:rgba(220,38,38,.08);',
	'border-left:3px solid var(--ts-bad);font-size:12px;line-height:1.65}',
	'#ts-nodes .tsn-alert-main{flex:1 1 220px;min-width:0}',
	'#ts-nodes .tsn-alert-text{overflow-wrap:anywhere;word-break:break-word;opacity:.85}',
	'#ts-nodes .tsn-alert-note{font-size:10.5px;opacity:.68;margin-top:2px}',
	'#ts-nodes .tsn-btn{font:inherit;font-size:12px;line-height:1.85;padding:0 10px;border-radius:8px;',
	'cursor:pointer;color:inherit;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.28);',
	'white-space:nowrap;flex:none}',
	'#ts-nodes .tsn-btn:hover{background:rgba(127,127,127,.18)}',
	'#ts-nodes .tsn-btn[disabled]{opacity:.55;cursor:default}',

	/* 节点卡片 */
	'#ts-nodes .tsn-list{min-width:0}',
	'#ts-nodes .tsn-card{max-width:100%;margin:0 0 10px 0;border-radius:10px;overflow:hidden;',
	'background:var(--ts-surface);border:1px solid var(--ts-border);',
	'border-left:3px solid var(--ts-neutral);cursor:pointer}',
	'#ts-nodes .tsn-card-online{border-left-color:var(--ts-ok)}',
	'#ts-nodes .tsn-card-offline{border-left-color:var(--ts-warn)}',
	'#ts-nodes .tsn-card-unreported{border-left-color:var(--ts-neutral)}',
	'#ts-nodes .tsn-card[aria-expanded="true"]{background:rgba(127,127,127,.09)}',
	'#ts-nodes .tsn-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
	'padding:10px 12px;cursor:pointer;outline:none}',
	'#ts-nodes .tsn-card:focus-visible{outline:none;box-shadow:inset 0 0 0 2px rgba(21,101,192,.55)}',
	'#ts-nodes .tsn-card-title{flex:1 1 160px;min-width:0}',
	'#ts-nodes .tsn-name{font-size:13.5px;font-weight:600;line-height:1.45;',
	'overflow-wrap:anywhere;word-break:break-word}',
	'#ts-nodes .tsn-id{font-size:10.5px;line-height:1.4;opacity:.62;overflow-wrap:anywhere}',
	'#ts-nodes .tsn-age{font-size:11.5px;opacity:.78;white-space:nowrap;margin-left:auto;',
	'font-variant-numeric:tabular-nums}',
	'#ts-nodes .tsn-age-k{opacity:.75}',
	'#ts-nodes .tsn-chev{flex:none;width:14px;text-align:center;font-size:11px;opacity:.55}',

	/* 卡片指标：宽屏 5 列，窄屏 2 列，绝不横向溢出 */
	'#ts-nodes .tsn-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));',
	'gap:5px 10px;padding:0 12px 11px 12px;min-width:0}',
	'#ts-nodes .tsn-metric{min-width:0}',
	'#ts-nodes .tsn-metric-k{font-size:10.5px;line-height:1.5;opacity:.62;white-space:nowrap}',
	'#ts-nodes .tsn-metric-v{font-size:13px;font-weight:600;line-height:1.4;white-space:nowrap;',
	'overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',

	/* 展开详情 */
	'#ts-nodes .tsn-details{border-top:1px dashed rgba(127,127,127,.28);',
	'padding:9px 12px 12px 12px;background:rgba(127,127,127,.03);cursor:default;min-width:0}',
	'#ts-nodes .tsn-detail-line{display:flex;flex-wrap:wrap;gap:3px 8px;margin:0 0 7px 0;',
	'font-size:11.5px;line-height:1.7;min-width:0}',
	'#ts-nodes .tsn-detail-k{opacity:.62;white-space:nowrap}',
	'#ts-nodes .tsn-detail-v{font-variant-numeric:tabular-nums;overflow-wrap:anywhere;word-break:break-word;min-width:0}',
	'#ts-nodes .tsn-detail-sect{margin:8px 0 0 0;padding:8px 0 0 0;',
	'border-top:1px dashed rgba(127,127,127,.2);min-width:0}',
	'#ts-nodes .tsn-detail-h{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;',
	'font-size:11.5px;font-weight:600;line-height:1.6;margin:0 0 2px 0}',
	'#ts-nodes .tsn-detail-h-n{font-size:10.5px;font-weight:400;opacity:.6}',
	'#ts-nodes .tsn-row{display:flex;align-items:center;gap:7px;min-width:0;padding:4px 0;',
	'border-bottom:1px solid rgba(127,127,127,.1)}',
	'#ts-nodes .tsn-row:last-child{border-bottom:0}',
	'#ts-nodes .tsn-rank{flex:none;width:16px;text-align:right;font-size:10px;opacity:.5;',
	'font-variant-numeric:tabular-nums}',
	'#ts-nodes .tsn-row-main{flex:1 1 auto;min-width:0}',
	'#ts-nodes .tsn-row-name{font-size:12px;line-height:1.5;white-space:nowrap;',
	'overflow:hidden;text-overflow:ellipsis}',
	'#ts-nodes .tsn-row-sub{font-size:10px;line-height:1.5;opacity:.6;white-space:nowrap;',
	'overflow:hidden;text-overflow:ellipsis}',
	'#ts-nodes .tsn-row-val{flex:none;font-size:11.5px;font-weight:600;white-space:nowrap;',
	'text-align:right;font-variant-numeric:tabular-nums}',
	'#ts-nodes .tsn-sub-empty{font-size:11px;line-height:1.7;opacity:.55;margin:2px 0 0 0}',

	/* 空态 / 筛选空态 */
	'#ts-nodes .tsn-empty{margin:0 0 10px 0;padding:15px 14px;border-radius:10px;',
	'background:rgba(127,127,127,.06);border:1px dashed rgba(127,127,127,.3);min-width:0}',
	'#ts-nodes .tsn-empty-sm{padding:12px 14px}',
	'#ts-nodes .tsn-empty-title{font-size:14px;font-weight:600;line-height:1.5;margin:0 0 4px 0}',
	'#ts-nodes .tsn-empty-text{margin:0 0 8px 0;font-size:12px;line-height:1.7;opacity:.78;',
	'overflow-wrap:anywhere}',
	'#ts-nodes .tsn-guide{margin:0 0 8px 0;padding:9px 11px;border-radius:8px;',
	'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.18);min-width:0}',
	'#ts-nodes .tsn-guide-h{font-size:11.5px;font-weight:600;line-height:1.6;margin:0 0 4px 0}',
	'#ts-nodes .tsn-code{max-width:100%;margin:0 0 6px 0;padding:7px 9px;border-radius:6px;',
	'background:rgba(127,127,127,.12);font-size:11px;line-height:1.7;',
	'white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere}',
	'#ts-nodes .tsn-guide-n{font-size:11px;line-height:1.65;opacity:.72;margin:3px 0 0 0;',
	'overflow-wrap:anywhere;word-break:break-word}',

	/* 中等 / 窄屏：卡片单列（列表本来就是块级）、指标 3→2 列、状态行换行 */
	'@media (max-width:900px){',
	'#ts-nodes .tsn-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}',
	'}',
	'@media (max-width:640px){',
	'#ts-nodes .tsn-updated{margin-left:0;width:100%}',
	'#ts-nodes .tsn-summary{align-items:flex-start}',
	'#ts-nodes .tsn-sum-total{margin-left:0}',
	'#ts-nodes .tsn-toolbar .tsn-count{margin-left:0}',
	'#ts-nodes .tsn-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}',
	'#ts-nodes .tsn-card-head{padding:9px 11px}',
	'#ts-nodes .tsn-age{order:3;flex:1 1 100%;margin-left:0}',
	'#ts-nodes .tsn-chev{order:2}',
	'#ts-nodes .tsn-metrics{padding:0 11px 10px 11px}',
	'#ts-nodes .tsn-details{padding:8px 11px 10px 11px}',
	'}',

	/* AP 管理区块（顶部）：离线整行标红；窄屏指标 2 列，绝不横向溢出 */
	'#ts-nodes .tsn-aps{max-width:100%;margin:0 0 14px 0;padding:11px 12px;border-radius:var(--ts-r);',
	'background:var(--ts-surface);border:1px solid var(--ts-border);min-width:0}',
	'#ts-nodes .tsn-aps-head{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;margin:0 0 5px 0}',
	'#ts-nodes .tsn-aps-title{margin:0;font-size:var(--ts-fs-4);font-weight:600;line-height:1.4}',
	'#ts-nodes .tsn-aps-note{font-size:var(--ts-fs-1);color:var(--ts-text-3);white-space:nowrap}',
	'#ts-nodes .tsn-aps-spacer{flex:1 1 auto}',
	'#ts-nodes .tsn-btn-primary{background:rgba(21,101,192,.16);border-color:rgba(21,101,192,.45);font-weight:600}',
	'#ts-nodes .tsn-btn-danger{color:var(--ts-bad-text);border-color:rgba(220,38,38,.45)}',
	'#ts-nodes .tsn-aps-hint{font-size:10.5px;line-height:1.6;opacity:.66;margin:0 0 8px 0}',
	'#ts-nodes .tsn-ap{max-width:100%;margin:0 0 8px 0;padding:9px 11px;border-radius:9px;',
	'background:var(--ts-surface-2);border:1px solid var(--ts-border);border-left:3px solid var(--ts-ok)}',
	'#ts-nodes .tsn-ap:last-child{margin-bottom:0}',
	'#ts-nodes .tsn-ap.tsn-ap-off{border-left-color:var(--ts-bad);background:rgba(220,38,38,.05)}',
	'#ts-nodes .tsn-ap.tsn-ap-off .tsn-name{color:var(--ts-bad-text)}',
	'#ts-nodes .tsn-ap-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
	'#ts-nodes .tsn-ap-main{flex:1 1 140px;min-width:0}',
	'#ts-nodes .tsn-ap-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));',
	'gap:4px 10px;margin:6px 0 0 0;min-width:0}',
	'#ts-nodes .tsn-ap-metric{min-width:0}',
	'#ts-nodes .tsn-ap-metric-k{font-size:10px;line-height:1.5;opacity:.6;white-space:nowrap}',
	'#ts-nodes .tsn-ap-metric-v{font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;',
	'overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
	'#ts-nodes .tsn-ap-btns{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0 0 0}',
	'#ts-nodes .tsn-modal{min-width:0;max-width:100%;padding:2px 0}',
	'#ts-nodes .tsn-field-form label{display:block;font-size:10.5px;opacity:.66;margin:4px 0 0 0}',
	'#ts-nodes .tsn-modal .cbi-input-text{width:100%;margin:2px 0 8px 0;box-sizing:border-box}',
	'#ts-nodes .tsn-modal-status{font-size:12px;line-height:1.6;color:var(--ts-warn-text);margin:2px 0}',
	'#ts-nodes .tsn-modal .right{margin:9px 0 0 0;text-align:right}',
	'#ts-nodes .tsn-bind-result{margin:10px 0 0 0;min-width:0}',
	'#ts-nodes .tsn-bind-warn{font-size:11.5px;line-height:1.65;padding:8px 10px;border-radius:8px;',
	'margin:0 0 8px 0;background:rgba(217,119,6,.10);border-left:3px solid var(--ts-warn)}',
	'#ts-nodes .tsn-bind-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;margin:0 0 8px 0;min-width:0}',
	'#ts-nodes .tsn-bind-k{flex:0 0 100%;font-size:10.5px;opacity:.66}',
	'#ts-nodes .tsn-copyable{flex:1 1 220px;min-width:0;margin:0}',
	'@media (max-width:900px){#ts-nodes .tsn-ap-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}',
	'@media (max-width:640px){#ts-nodes .tsn-ap-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}',

].join('\n');

// ---------------------------------------------------------------- 视图

return view.extend({
	load: function() {
		this.aps = [];
		this.apLoaded = false;
		this.apLoading = false;
		this.apError = null;
		this.apUpdated = null;
		this.offlineMin = 10;

		/* 两个 RPC 并行；任一失败都不影响另一个（reload/reloadAps 各自吞异常） */
		return Promise.all([ this.reload(), this.reloadAps() ]).then(function() {
			return true;
		});
	},

	render: function() {
		if (!Array.isArray(this.nodes)) this.nodes = [];
		if (this.sortKey == null) this.sortKey = 'ts';
		if (this.filter == null) this.filter = 'all';
		if (this.expanded == null || typeof this.expanded != 'object') this.expanded = {};
		if (this.loaded == null) this.loaded = false;
		if (this.loading == null) this.loading = false;
		if (this.error == null) this.error = null;
		if (this.lastUpdated == null) this.lastUpdated = null;
		if (!Array.isArray(this.aps)) this.aps = [];
		if (this.apLoaded == null) this.apLoaded = false;
		if (this.apLoading == null) this.apLoading = false;
		if (this.apError === undefined) this.apError = null;
		if (this.apUpdated === undefined) this.apUpdated = null;
		if (this.offlineMin == null) this.offlineMin = 10;

		this.updatedEl = E('span', { 'class': 'tsn-updated' }, '');
		this.summaryEl = E('div', {
			'class': 'tsn-summary',
			'role': 'status',
			'aria-live': 'polite'
		});
		this.toolbarEl = E('div', { 'class': 'tsn-toolbar' });
		this.bannerEl = E('div', { 'class': 'tsn-banner' });
		this.listEl = E('div', { 'class': 'tsn-list' });
		this.apEl = E('div', { 'class': 'tsn-aps', 'id': 'tsn-aps' });

		this.root = E('div', { 'id': 'ts-nodes', 'class': theme.CLASS }, [
			theme.style(),
			E('style', {}, CSS),
			this.apEl,
			E('div', { 'class': 'tsn-head' }, [
				E('h2', { 'class': 'tsn-title ts-title' }, _('棱镜路由 · 网络节点')),
				this.updatedEl
			]),
			E('p', { 'class': 'tsn-sub' },
				_('来自各子节点的汇总快照；总流量为节点守护进程启动以来的累计值，不是今日增量。每 15 秒自动刷新。')),
			this.summaryEl,
			this.toolbarEl,
			this.bannerEl,
			this.listEl
		]);

		this.paint();
		this.startAutoRefresh();

		return this.root;
	},

	paint: function() {
		if (this.root == null || this.listEl == null) return;

		var nodes = Array.isArray(this.nodes) ? this.nodes : [];
		var counts = countStatus(nodes);
		var filtered = sortedNodes(filterNodes(nodes, this.filter), this.sortKey);

		this.renderUpdated();
		this.renderSummary(counts, nodes.length);
		this.renderToolbar(counts, nodes.length, filtered.length);
		this.renderBanner();
		this.renderAps();
		this.renderList();
	},

	renderUpdated: function() {
		var text;

		if (this.lastUpdated != null) {
			text = _('最后更新') + ' ' + clockText(this.lastUpdated);

			if (this.loading === true) text += ' · ' + _('刷新中…');
		}
		else if (this.loading === true) {
			text = _('正在读取节点…');
		}
		else {
			text = _('尚未成功读取');
		}

		this.updatedEl.textContent = text;
	},

	renderSummary: function(counts, total) {
		clear(this.summaryEl);

		var row = E('div', { 'class': 'tsn-sum-main' }, [
			E('span', { 'class': 'tsn-sum-stat tsn-st-online' }, [
				E('i', { 'class': 'tsn-dot' }),
				E('span', { 'class': 'tsn-sum-k' }, _('在线') + ' '),
				E('strong', { 'class': 'tsn-sum-v' }, '' + counts.online)
			]),
			E('span', { 'class': 'tsn-sep' }, ' · '),
			E('span', { 'class': 'tsn-sum-stat tsn-st-offline' }, [
				E('i', { 'class': 'tsn-dot' }),
				E('span', { 'class': 'tsn-sum-k' }, _('离线') + ' '),
				E('strong', { 'class': 'tsn-sum-v' }, '' + counts.offline)
			]),
			E('span', { 'class': 'tsn-sep' }, ' · '),
			E('span', { 'class': 'tsn-sum-stat tsn-st-unreported' }, [
				E('i', { 'class': 'tsn-dot' }),
				E('span', { 'class': 'tsn-sum-k' }, _('未上报') + ' '),
				E('strong', { 'class': 'tsn-sum-v' }, '' + counts.unreported)
			]),
			E('span', { 'class': 'tsn-sum-unit' }, ' ' + _('个节点'))
		]);

		this.summaryEl.appendChild(row);
		this.summaryEl.appendChild(E('span', { 'class': 'tsn-sum-total' },
			' · ' + _('节点总数') + ' ' + total));
	},

	renderToolbar: function(counts, total, shown) {
		var self = this;

		clear(this.toolbarEl);

		var select = E('select', { 'class': 'tsn-select', 'id': 'tsn-nodes-sort' },
			SORT_KEYS.map(function(key) {
				var attrs = { 'value': key };

				if (self.sortKey == key) attrs.selected = 'selected';

				return E('option', attrs, sortLabel(key));
			}));

		select.value = this.sortKey;
		select.addEventListener('change', function(ev) {
			var value = (ev != null && ev.target != null) ? ev.target.value : select.value;

			self.setSort(value);
		});

		var seg = E('div', {
			'class': 'tsn-seg',
			'role': 'group',
			'aria-label': _('状态筛选')
		}, FILTER_KEYS.map(function(key) {
			var active = (self.filter == key);
			var count = (key == 'online') ? counts.online
				: (key == 'offline') ? counts.offline : total;
			var btn = E('button', {
				'type': 'button',
				'class': 'tsn-seg-btn' + (active ? ' on' : ''),
				'aria-pressed': active ? 'true' : 'false'
			}, filterLabel(key) + ' ' + count);

			btn.addEventListener('click', function() {
				self.setFilter(key);
			});

			return btn;
		}));

		this.toolbarEl.appendChild(E('div', { 'class': 'tsn-field' }, [
			E('label', { 'class': 'tsn-field-k', 'for': 'tsn-nodes-sort' }, _('排序')),
			select
		]));
		this.toolbarEl.appendChild(seg);
		this.toolbarEl.appendChild(E('span', { 'class': 'tsn-count' },
			_('显示') + ' ' + shown + ' / ' + total));

		if (this.filter != 'all' && counts.unreported > 0)
			this.toolbarEl.appendChild(E('div', { 'class': 'tsn-toolbar-note' },
				_('未上报节点仅在「全部」中显示。')));
	},

	renderBanner: function() {
		var self = this;

		clear(this.bannerEl);

		if (!this.error) return;

		var box = E('div', { 'class': 'tsn-alert', 'role': 'alert' }, [
			E('div', { 'class': 'tsn-alert-main' }, [
				E('strong', {}, _('读取节点失败')),
				E('div', { 'class': 'tsn-alert-text' }, this.error),
				this.lastUpdated != null ? E('div', { 'class': 'tsn-alert-note' },
					_('列表仍显示上一次成功读取的数据') +
					'（' + clockText(this.lastUpdated) + '）。') : ''
			])
		]);

		var retryAttrs = { 'type': 'button', 'class': 'tsn-btn tsn-retry' };

		if (this.loading === true) retryAttrs.disabled = 'disabled';

		var retry = E('button', retryAttrs, this.loading === true ? _('重试中…') : _('重试'));

		retry.addEventListener('click', function() {
			self.reload();
		});

		box.appendChild(retry);
		this.bannerEl.appendChild(box);
	},

	renderList: function() {
		if (this.listEl == null) return;

		var nodes = Array.isArray(this.nodes) ? this.nodes : [];
		var counts = countStatus(nodes);
		var filtered = sortedNodes(filterNodes(nodes, this.filter), this.sortKey);

		clear(this.listEl);

		if (nodes.length == 0) {
			if (this.loaded !== true) {
				if (!this.error)
					this.listEl.appendChild(E('div', { 'class': 'tsn-empty' }, [
						E('div', { 'class': 'tsn-empty-title' }, _('正在读取节点…')),
						E('p', { 'class': 'tsn-empty-text' },
							_('正在向 prism-router.get_nodes 请求节点列表。'))
					]));

				return;
			}

			this.listEl.appendChild(this.renderEmpty());
			return;
		}

		if (filtered.length == 0) {
			this.listEl.appendChild(this.renderFilterEmpty(counts));
			return;
		}

		for (var i = 0; i < filtered.length; i++)
			this.listEl.appendChild(this.renderCard(filtered[i]));
	},

	renderEmpty: function() {
		var self = this;
		var reloadAttrs = { 'type': 'button', 'class': 'tsn-btn' };

		if (this.loading === true) reloadAttrs.disabled = 'disabled';

		var reload = E('button', reloadAttrs, this.loading === true ? _('读取中…') : _('重新读取'));

		reload.addEventListener('click', function() {
			self.reload();
		});

		return E('div', { 'class': 'tsn-empty' }, [
			E('div', { 'class': 'tsn-empty-title' }, _('母节点尚未收到子节点上报')),
			E('p', { 'class': 'tsn-empty-text' },
				_('节点列表为空：母节点还没有收到任何子节点的汇总快照。子节点推送成功后，这里会自动出现节点卡片。')),
			E('div', { 'class': 'tsn-guide' }, [
				E('div', { 'class': 'tsn-guide-h' }, _('最短配置：在母节点注册子节点')),
				E('pre', { 'class': 'tsn-code' }, [
					'uci add prism-router node',
					"uci set prism-router.@node[-1].node_id='node-a'",
					"uci set prism-router.@node[-1].secret='<32+ 字节随机串>'",
					'uci commit prism-router'
				].join('\n')),
				E('p', { 'class': 'tsn-guide-n' },
					_('在子节点把同一个 node_id / secret 写入 config node，并设置 mother_url、mother_enabled=1；两端的 secret 必须一致。')),
				E('p', { 'class': 'tsn-guide-n' },
					_('旧版共享密钥（仅升级过渡）：uci set prism-router.settings.legacy_shared_secret=\'1\'，母节点再设置同一个 mother_secret。')),
				E('p', { 'class': 'tsn-guide-n' },
					_('验证：在子节点执行 ucode /usr/share/prism-router/push.uc，然后点「重新读取」。'))
			]),
			reload
		]);
	},

	renderFilterEmpty: function(counts) {
		var self = this;
		var all = E('button', { 'type': 'button', 'class': 'tsn-btn' }, _('显示全部'));

		all.addEventListener('click', function() {
			self.setFilter('all');
		});

		return E('div', { 'class': 'tsn-empty tsn-empty-sm' }, [
			E('div', { 'class': 'tsn-empty-title' },
				this.filter == 'online' ? _('当前没有在线节点') : _('当前没有离线节点')),
			E('p', { 'class': 'tsn-empty-text' },
				_('可以切换到「全部」查看所有已上报节点。') +
				(counts.unreported > 0 ? ' ' + _('另有') + ' ' + counts.unreported + ' ' + _('个未上报节点。') : '')),
			all
		]);
	},

	renderCard: function(node) {
		var self = this;
		var id = nodeIdOf(node);
		var name = nodeNameOf(node);
		var key = nodeKey(node);
		var status = statusOf(node);
		var totals = totalsOf(node);
		var age = ageOf(node);
		var devs = devicesOf(node);
		var apps = appsOf(node);
		var open = (this.expanded[key] === true);

		var detail = E('div', {
			'class': 'tsn-details',
			style: open ? '' : 'display:none'
		});
		var filled = false;

		function fill() {
			if (filled) return;

			filled = true;
			clear(detail);

			var parts = buildDetails(node, totals, age, devs, apps);

			for (var i = 0; i < parts.length; i++)
				detail.appendChild(parts[i]);
		}

		var chev = E('span', { 'class': 'tsn-chev', 'aria-hidden': 'true' }, open ? '▾' : '▸');

		var card = E('div', {
			'class': 'tsn-card tsn-card-' + status,
			'role': 'button',
			'tabindex': '0',
			'aria-expanded': open ? 'true' : 'false',
			'aria-label': name + ' · ' + statusLabel(status) + ' · ' + _('点击展开详情')
		}, [
			E('div', { 'class': 'tsn-card-head' }, [
				E('span', { 'class': 'tsn-pill tsn-st-' + status }, [
					E('i', { 'class': 'tsn-dot' }),
					statusLabel(status)
				]),
				E('div', { 'class': 'tsn-card-title' }, [
					E('div', { 'class': 'tsn-name' }, name),
					(id.length && id != name) ? E('div', { 'class': 'tsn-id' }, id) : ''
				]),
				E('div', { 'class': 'tsn-age' }, [
					E('span', { 'class': 'tsn-age-k' }, _('最后上报') + ' '),
					fmtAge(age)
				]),
				chev
			]),
			E('div', { 'class': 'tsn-metrics' }, [
				metric(_('总量'), fmtBytes(totals.total)),
				metric(_('代理'), fmtBytes(totals.proxy)),
				metric(_('直连'), fmtBytes(totals.direct)),
				metric(_('设备'), devs.length + ' ' + _('台')),
				metric(_('应用'), apps.length + ' ' + _('个'))
			]),
			detail
		]);

		/* 展开/收起只切 display 与 aria，不重绘列表、不发 RPC；刷新后按 expanded 恢复。 */
		function toggle() {
			open = !(self.expanded[key] === true);
			self.expanded[key] = open;

			if (open) fill();

			detail.style.display = open ? '' : 'none';
			chev.textContent = open ? '▾' : '▸';
			card.setAttribute('aria-expanded', open ? 'true' : 'false');
		}

		if (open) fill();

		card.addEventListener('click', toggle);
		card.addEventListener('keydown', function(ev) {
			var k = (ev != null) ? ev.key : null;

			if (k == 'Enter' || k == ' ' || k == 'Spacebar') {
				if (ev != null && typeof ev.preventDefault == 'function') ev.preventDefault();

				toggle();
			}
		});

		/* 详情里的选择/点击不触发卡片收起。 */
		detail.addEventListener('click', function(ev) {
			if (ev != null && typeof ev.stopPropagation == 'function') ev.stopPropagation();
		});

		return card;
	},

	setSort: function(key) {
		if (SORT_KEYS.indexOf(key) < 0 || key == this.sortKey) return;

		this.sortKey = key;
		this.paint();
	},

	setFilter: function(key) {
		if (FILTER_KEYS.indexOf(key) < 0 || key == this.filter) return;

		this.filter = key;
		this.paint();
	},

	/* 拉 get_nodes：成功替换快照并记时间；失败只写 error，绝不清空 nodes。 */
	reload: function() {
		var self = this;

		if (this.loading === true) return Promise.resolve(false);

		this.loading = true;
		this.paint();

		return callNodes().then(function(result) {
			var nodes = (result != null && Array.isArray(result.nodes)) ? result.nodes : [];

			self.nodes = nodes.slice();
			self.loaded = true;
			self.lastUpdated = new Date();
			self.error = null;
			self.loading = false;
			self.paint();

			return true;
		}, function(err) {
			/* 保留上一次成功数据：只更新错误条，不动 self.nodes / lastUpdated。 */
			self.error = errText(err);
			self.loading = false;
			self.paint();

			return false;
		});
	},

	startAutoRefresh: function() {
		var self = this;
		var win = (typeof window != 'undefined') ? window : null;

		this.stopAutoRefresh();

		if (win == null || typeof win.setInterval != 'function') return;

		this.timer = win.setInterval(function() {
			if (self.root == null) {
				self.stopAutoRefresh();
				return;
			}

			/* 离开页面后 #view 会被整体替换，这里顺手停表，避免后台一直轮询。 */
			var body = (typeof document != 'undefined') ? document.body : null;

			if (body != null && typeof body.contains == 'function' && !body.contains(self.root)) {
				self.stopAutoRefresh();
				return;
			}

			if (typeof document != 'undefined' && document.hidden === true) return;

			self.reload();
			self.reloadAps();
		}, REFRESH_MS);

		if (typeof win.addEventListener == 'function' && this.unloadFn == null) {
			this.unloadFn = function() { self.stopAutoRefresh(); };
			win.addEventListener('beforeunload', this.unloadFn);
		}
	},

	stopAutoRefresh: function() {
		var win = (typeof window != 'undefined') ? window : null;

		if (this.timer != null) {
			if (win != null && typeof win.clearInterval == 'function')
				win.clearInterval(this.timer);

			this.timer = null;
		}

		if (this.unloadFn != null) {
			if (win != null && typeof win.removeEventListener == 'function')
				win.removeEventListener('beforeunload', this.unloadFn);

			this.unloadFn = null;
		}
	},


	/* ---- AP 管理：列表 / 绑定 / 重命名 / 删除 / 重启 ---- */

	reloadAps: function() {
		var self = this;

		if (this.apLoading === true) return Promise.resolve(false);

		this.apLoading = true;

		if (this.apEl != null) this.renderAps();

		return callApList().then(function(result) {
			var aps = (result != null && Array.isArray(result.aps)) ? result.aps : [];

			self.aps = aps.slice();
			self.apLoaded = true;
			self.apUpdated = new Date();
			self.apLoading = false;
			self.apError = null;

			if (result != null && result.offline_min != null)
				self.offlineMin = num(result.offline_min);

			self.renderAps();

			return true;
		}, function(err) {
			/* 保留上一次成功数据：只显示错误条 */
			self.apError = errText(err);
			self.apLoading = false;
			self.renderAps();

			return false;
		});
	},

	renderAps: function() {
		var self = this;

		if (this.apEl == null) return;

		clear(this.apEl);

		var refreshBtn = E('button', { 'type': 'button', 'class': 'tsn-btn' },
			this.apLoading === true ? _('刷新中…') : _('刷新数据'));

		if (this.apLoading === true) refreshBtn.disabled = 'disabled';

		refreshBtn.addEventListener('click', function() { self.reloadAps(); });

		var bindBtn = E('button', { 'type': 'button', 'class': 'tsn-btn tsn-btn-primary' }, _('生成绑定命令'));

		bindBtn.addEventListener('click', function() { self.showBindDialog(); });

		this.apEl.appendChild(E('div', { 'class': 'tsn-aps-head' }, [
			E('h3', { 'class': 'tsn-aps-title' }, _('AP 管理')),
			E('span', { 'class': 'tsn-aps-note' },
				this.apUpdated != null ? _('更新于') + ' ' + clockText(this.apUpdated) : ''),
			E('span', { 'class': 'tsn-aps-spacer' }),
			refreshBtn,
			bindBtn
		]));

		this.apEl.appendChild(E('div', { 'class': 'tsn-aps-hint' },
			_('在线 = 最近上报 < 180 秒；离线告警阈值在设置页配置（当前') + ' ' +
			(this.offlineMin || 10) + ' ' + _('分钟）。绑定后 AP 每分钟上报，可下发 refresh / reboot。')));

		if (this.apError != null) {
			var retry = E('button', { 'type': 'button', 'class': 'tsn-btn' }, _('重试'));

			retry.addEventListener('click', function() { self.reloadAps(); });

			this.apEl.appendChild(E('div', { 'class': 'tsn-alert', 'role': 'alert' }, [
				E('div', { 'class': 'tsn-alert-main' }, [
					E('strong', {}, _('读取 AP 列表失败')),
					E('div', { 'class': 'tsn-alert-text' }, this.apError)
				]),
				retry
			]));
		}

		var aps = Array.isArray(this.aps) ? this.aps : [];

		if (aps.length == 0) {
			if (this.apLoaded !== true && this.apError == null)
				this.apEl.appendChild(E('div', { 'class': 'tsn-empty tsn-empty-sm' }, [
					E('div', { 'class': 'tsn-empty-title' }, _('正在读取 AP…'))
				]));
			else
				this.apEl.appendChild(this.renderApEmpty());

			return;
		}

		var list = E('div', { 'class': 'tsn-ap-list' });

		for (var i = 0; i < aps.length; i++)
			list.appendChild(this.renderApRow(aps[i]));

		this.apEl.appendChild(list);
	},

	renderApEmpty: function() {
		var self = this;
		var bind = E('button', { 'type': 'button', 'class': 'tsn-btn tsn-btn-primary' }, _('生成绑定命令'));

		bind.addEventListener('click', function() { self.showBindDialog(); });

		return E('div', { 'class': 'tsn-empty tsn-empty-sm' }, [
			E('div', { 'class': 'tsn-empty-title' }, _('还没有绑定 AP')),
			E('p', { 'class': 'tsn-empty-text' },
				_('点「生成绑定命令」得到一条可在 AP 上直接执行的安装命令；10 分钟内有效，令牌只显示一次。')),
			bind
		]);
	},

	renderApRow: function(ap) {
		var self = this;
		var online = apIsOnline(ap);
		var id = (ap != null && ap.node_id != null) ? ('' + ap.node_id) : '';
		var name = (ap != null && ap.name != null && ('' + ap.name).length) ? ('' + ap.name) : id;
		var managed = (ap != null && ap.managed === true);
		var result = (ap != null && ap.last_cmd_result != null) ? ('' + ap.last_cmd_result) : '';
		var cmd = (ap != null && ap.last_cmd != null) ? ('' + ap.last_cmd) : '';

		var renameBtn = E('button', { 'type': 'button', 'class': 'tsn-btn' }, _('重命名'));
		var rebootBtn = E('button', { 'type': 'button', 'class': 'tsn-btn' }, _('重启 AP'));
		var delBtn = E('button', { 'type': 'button', 'class': 'tsn-btn tsn-btn-danger' }, _('删除'));

		renameBtn.addEventListener('click', function() { self.showRenameDialog(ap); });
		rebootBtn.addEventListener('click', function() { self.showRebootDialog(ap); });
		delBtn.addEventListener('click', function() { self.showDeleteDialog(ap); });

		/* 未绑定的只有站点快照：没有通道可控制，只能看/删除 */
		if (!managed) {
			renameBtn.disabled = 'disabled';
			rebootBtn.disabled = 'disabled';
		}
		else if (ap != null && ap.controllable === false) {
			rebootBtn.disabled = 'disabled';
		}

		var cmdText = '—';

		if (cmd.length)
			cmdText = cmd + (result.length ? ' · ' + result : '');

		return E('div', { 'class': 'tsn-ap' + (online ? '' : ' tsn-ap-off') }, [
			E('div', { 'class': 'tsn-ap-top' }, [
				E('span', { 'class': 'tsn-pill ' + (online ? 'tsn-st-online' : 'tsn-st-offline') }, [
					E('i', { 'class': 'tsn-dot' }),
					online ? _('在线') : _('离线')
				]),
				E('div', { 'class': 'tsn-ap-main' }, [
					E('div', { 'class': 'tsn-name' }, name),
					E('div', { 'class': 'tsn-id' },
						id + (managed ? '' : ' · ' + _('未绑定（只有站点快照）')))
				])
			]),
			E('div', { 'class': 'tsn-ap-metrics' }, [
				apMetric(_('最后上报'), apAgeText(ap)),
				apMetric(_('终端'), (ap != null ? num(ap.stations) : 0) + ' ' + _('台')),
				apMetric(_('平均信号'),
					(ap != null && ap.avg_signal != null) ? (num(ap.avg_signal) + ' dBm') : '—'),
				apMetric(_('最近命令'), cmdText)
			]),
			E('div', { 'class': 'tsn-ap-btns' }, [ renameBtn, rebootBtn, delBtn ])
		]);
	},

	showBindDialog: function() {
		var nameIn = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'maxlength': '32',
			'placeholder': _('例如：客厅 AP（可留空）')
		});
		var nodeIn = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'maxlength': '64',
			'placeholder': _('留空 = 用 AP 主机名；接管旧 AP 可填 ap-1')
		});
		var status = E('div', { 'class': 'tsn-modal-status' }, '');
		var result = E('div', { 'class': 'tsn-bind-result' });
		var okBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-apply' }, _('生成'));
		var cancelBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button' }, _('关闭'));

		cancelBtn.addEventListener('click', function() { ui.hideModal(); });

		okBtn.addEventListener('click', function() {
			var name = nameIn.value.replace(/^\s+|\s+$/g, '');
			var nodeId = nodeIn.value.replace(/^\s+|\s+$/g, '');

			okBtn.disabled = 'disabled';
			status.textContent = _('正在生成…');

			callApBindStart(name, nodeId, '').then(function(res) {
				okBtn.disabled = false;

				if (res == null || res.ok !== true) {
					status.textContent = _('生成失败：') + errText(res != null ? (res.error || res) : null);
					return;
				}

				status.textContent = '';
				clear(result);

				result.appendChild(E('div', { 'class': 'tsn-bind-warn' }, [
					E('strong', {}, _('令牌只显示这一次。')),
					' ' + _('把它贴到 AP 上执行下面的命令；AP 首次上报即完成绑定，令牌随即作废。')
				]));
				result.appendChild(apCodeRow(_('上报地址'), '' + res.url));
				result.appendChild(apCodeRow(_('绑定令牌'), '' + res.token));
				result.appendChild(apCodeRow(_('安装命令'), '' + res.cmd));
				result.appendChild(E('div', { 'class': 'tsn-guide-n' },
					_('10 分钟内有效（最多 8 个待用令牌）。命令需要 AP 能访问母节点地址；自签 HTTPS 时会带 --insecure（HMAC 仍然校验请求）。')));
			}, function(err) {
				okBtn.disabled = false;
				status.textContent = _('生成失败：') + errText(err);
			});
		});

		ui.showModal(_('生成 AP 绑定命令'), [
			E('div', { 'class': 'tsn-modal' }, [
				E('p', { 'class': 'tsn-guide-n' },
					_('生成一个一次性绑定令牌，并给出可直接在 AP 上执行的安装命令。令牌只存 sha256，明文只在这里出现一次。')),
				E('div', { 'class': 'tsn-field-form' }, [
					E('label', {}, _('备注名')),
					nameIn,
					E('label', {}, _('节点 ID（可选）')),
					nodeIn
				]),
				status,
				E('div', { 'class': 'right' }, [ okBtn, ' ', cancelBtn ]),
				result
			])
		]);
	},

	showRenameDialog: function(ap) {
		var self = this;
		var id = '' + ap.node_id;
		var input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'maxlength': '32' });
		var status = E('div', { 'class': 'tsn-modal-status' }, '');
		var okBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-apply' }, _('保存'));
		var cancelBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button' }, _('取消'));

		input.value = (ap.name != null && ('' + ap.name).length) ? ('' + ap.name) : id;

		cancelBtn.addEventListener('click', function() { ui.hideModal(); });

		okBtn.addEventListener('click', function() {
			var name = input.value.replace(/^\s+|\s+$/g, '');

			if (name.length == 0) {
				status.textContent = _('名字不能为空（最多 32 字）');
				return;
			}

			okBtn.disabled = 'disabled';

			callApRename(id, name).then(function(res) {
				okBtn.disabled = false;

				if (res == null || res.ok !== true) {
					status.textContent = _('重命名失败：') + errText(res != null ? (res.error || res) : null);
					return;
				}

				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('已重命名：') + id + ' → ' + name), 'info');
				self.reloadAps();
			}, function(err) {
				okBtn.disabled = false;
				status.textContent = _('重命名失败：') + errText(err);
			});
		});

		ui.showModal(_('重命名 AP') + ' · ' + id, [
			E('div', { 'class': 'tsn-modal' }, [
				E('label', {}, _('展示名（最多 32 字）')),
				input,
				status,
				E('div', { 'class': 'right' }, [ okBtn, ' ', cancelBtn ])
			])
		]);
	},

	showDeleteDialog: function(ap) {
		var self = this;
		var id = '' + ap.node_id;
		var status = E('div', { 'class': 'tsn-modal-status' }, '');
		var okBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-remove' }, _('删除'));
		var cancelBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button' }, _('取消'));

		cancelBtn.addEventListener('click', function() { ui.hideModal(); });

		okBtn.addEventListener('click', function() {
			okBtn.disabled = 'disabled';

			callApDelete(id).then(function(res) {
				okBtn.disabled = false;

				if (res == null || res.ok !== true) {
					status.textContent = _('删除失败：') + errText(res != null ? (res.error || res) : null);
					return;
				}

				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('已删除 AP：') + id), 'info');
				self.reloadAps();
			}, function(err) {
				okBtn.disabled = false;
				status.textContent = _('删除失败：') + errText(err);
			});
		});

		ui.showModal(_('删除 AP') + ' · ' + id, [
			E('div', { 'class': 'tsn-modal' }, [
				E('p', {}, _('会删除该 AP 的绑定信息、站点快照与命令队列。AP 若还在运行，下一轮上报会因为未绑定被拒绝，需要重新生成绑定命令。')),
				status,
				E('div', { 'class': 'right' }, [ okBtn, ' ', cancelBtn ])
			])
		]);
	},

	showRebootDialog: function(ap) {
		var self = this;
		var id = '' + ap.node_id;
		var status = E('div', { 'class': 'tsn-modal-status' }, '');
		var okBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-negative' }, _('确认重启'));
		var cancelBtn = E('button', { 'type': 'button', 'class': 'btn cbi-button' }, _('取消'));

		cancelBtn.addEventListener('click', function() { ui.hideModal(); });

		okBtn.addEventListener('click', function() {
			okBtn.disabled = 'disabled';

			callApCmd(id, 'reboot').then(function(res) {
				okBtn.disabled = false;

				if (res == null || res.ok !== true) {
					status.textContent = _('下发失败：') + errText(res != null ? (res.error || res) : null);
					return;
				}

				ui.hideModal();
				ui.addNotification(null, E('p', {},
					_('已下发 reboot，等待 AP 下一次轮询（约 1 分钟内）。')), 'warning');
				self.reloadAps();
			}, function(err) {
				okBtn.disabled = false;
				status.textContent = _('下发失败：') + errText(err);
			});
		});

		ui.showModal(_('重启 AP') + ' · ' + id, [
			E('div', { 'class': 'tsn-modal' }, [
				E('p', {}, _('重启会断开该 AP 上所有无线客户端，约 1–2 分钟恢复。命令在 AP 下一次上报后执行。')),
				status,
				E('div', { 'class': 'right' }, [ okBtn, ' ', cancelBtn ])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
