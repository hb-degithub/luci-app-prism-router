'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 流量统计 · 多节点（子母汇总）
 *
 * 只调 traffic-stats.get_nodes（母节点 rpcd 读 /etc/traffic-stats/nodes/*.json），
 * 不碰 get_state，也不做任何本地累加：
 *   - latest.totals 是"子节点守护进程启动以来的累计值"，不是今日增量（见 SPEC §3.1），
 *     所以这里只展示、不求和成"全网总量"。
 *   - age_sec 超过 5 分钟没有新上报的节点整行标黄；age_sec < 0（快照没时间戳）
 *     也按过期处理。
 *
 * 单位：流量二进制（GiB/MiB），与设备/应用页保持一致。
 */

var STALE_SEC = 300;

var callNodes = rpc.declare({
	object: 'traffic-stats',
	method: 'get_nodes',
	expect: { nodes: [] },
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

/* 绝对时间（本地时区），供悬浮提示用。 */
function fmtClock(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
		pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function nodeName(node) {
	if (node == null) return '—';
	if (node.name && ('' + node.name).length) return '' + node.name;
	if (node.node_id && ('' + node.node_id).length) return '' + node.node_id;

	return '—';
}

/* 一个节点的 latest.totals 投影成 直连 / 代理 / 合计。 */
function totalsOf(node) {
	var latest = (node != null && node.latest != null && typeof node.latest == 'object') ? node.latest : {};
	var t = (latest.totals != null && typeof latest.totals == 'object') ? latest.totals : {};

	var direct = num(t.direct_rx) + num(t.direct_tx);
	var proxy = num(t.proxy_rx) + num(t.proxy_tx);

	return {
		direct: direct,
		proxy: proxy,
		total: direct + proxy
	};
}

function deviceCount(node) {
	var latest = (node != null && node.latest != null && typeof node.latest === 'object') ? node.latest : {};

	return Array.isArray(latest.devices) ? latest.devices.length : 0;
}

function isStale(node) {
	var age = (node != null && node.age_sec != null) ? num(node.age_sec) : -1;

	return (age < 0) || (age > STALE_SEC);
}

return view.extend({
	load: function() {
		return callNodes().then(function(result) {
			var nodes = (result != null && Array.isArray(result.nodes)) ? result.nodes : [];

			/* 新的在前；ts 相同（或都缺失）时按 node_id 排，保证渲染稳定。 */
			nodes.sort(function(a, b) {
				var d = num(b && b.ts) - num(a && a.ts);

				if (d) return d;

				var na = (a && a.node_id) ? '' + a.node_id : '';
				var nb = (b && b.node_id) ? '' + b.node_id : '';

				return (na > nb) ? 1 : ((na < nb) ? -1 : 0);
			});

			this.nodes = nodes;
			this.error = null;
		}.bind(this)).catch(function(err) {
			this.nodes = [];
			this.error = (err != null && err.message) ? err.message : '' + err;
		}.bind(this));
	},

	render: function() {
		var nodes = Array.isArray(this.nodes) ? this.nodes : [];

		var head = [
			E('h2', {}, _('流量统计 · 多节点')),
			E('p', { style: 'margin:0 0 12px 0;font-size:12px;opacity:.85' }, [
				_('来自子节点的汇总快照（各节点自行统计后上报）。'),
				' ',
				_('总流量 = 该节点直连 + 代理，自该节点守护进程启动以来累计，不是今日增量。'),
				' ',
				_('超过 5 分钟未上报的节点整行标黄。')
			])
		];

		if (nodes.length == 0)
			return E('div', {}, head.concat([ this.renderEmpty() ]));

		var stale = 0;

		for (var i = 0; i < nodes.length; i++)
			if (isStale(nodes[i])) stale++;

		var summary = E('p', { style: 'margin:0 0 12px 0;font-size:12px;opacity:.85' }, [
			_('共') + ' ' + nodes.length + ' ' + _('个节点'),
			stale > 0 ? ' · ' + stale + ' ' + _('个节点超过 5 分钟未上报') : ''
		]);

		var rows = nodes.map(function(node) {
			return this.renderRow(node);
		}.bind(this));

		return E('div', {}, head.concat([
			summary,
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('节点')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('最后上报')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('总流量')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('代理')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('直连')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('设备数'))
				])
			].concat(rows))
		]));
	},

	renderEmpty: function() {
		var message;

		if (this.error)
			message = _('读不到节点列表：') + this.error;
		else if (this.nodes == null)
			message = _('读不到节点列表：rpcd 对象 traffic-stats 不可用，或者后端尚未安装。');
		else
			message = _('暂无节点');

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
			E('p', {}, E('strong', {}, message)),
			E('p', {}, _('子节点需要配置 mother_enabled=1 / mother_url / mother_secret，并由 cron 每分钟运行一次 push.uc；母节点需要配置同一个 mother_secret 接收上报。')),
			E('p', { style: 'font-size:12px;opacity:.8' },
				_('验证：在任一节点执行 ucode /usr/share/traffic-stats/push.uc，然后刷新本页。'))
		]);
	},

	renderRow: function(node) {
		var t = totalsOf(node);
		var stale = isStale(node);
		var id = (node && node.node_id) ? '' + node.node_id : '';
		var name = nodeName(node);
		var age = (node != null && node.age_sec != null) ? num(node.age_sec) : -1;

		/* 只有"真的过旧"才标黄：未知时间戳走同一个黄色，但文案写"未知"。 */
		var style = stale ? 'background:rgba(255,193,7,.18)' : '';

		return E('tr', { 'class': 'tr', style: style, title: _('最后上报') + '：' + fmtClock(node && node.ts) }, [
			E('td', { 'class': 'td' }, [
				E('strong', {}, name),
				(name != id && id.length) ? E('div', { style: 'font-size:11px;opacity:.65' }, E('code', {}, id)) : ''
			]),
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, [
				stale ? E('span', { style: 'color:#b26a00', title: _('超过 5 分钟未上报') }, '⚠ ') : '',
				fmtAge(age),
				E('div', { style: 'font-size:11px;opacity:.6' }, fmtClock(node && node.ts))
			]),
			E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(t.total))),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(t.proxy)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(t.direct)),
			E('td', { 'class': 'td', style: 'text-align:right' }, '' + deviceCount(node))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
