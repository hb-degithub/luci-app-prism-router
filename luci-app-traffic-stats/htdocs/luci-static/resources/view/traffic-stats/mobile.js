'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 流量统计 · 手机版（单页，最小可用）
 *
 * 数据只来自一次 rpcd 调用（get_state）。整页结构在 render 里建好，
 * 之后每 15s（document.hidden 时跳过）用同一个方法刷新数字与两个列表。
 *
 * 口径提醒（SPEC 3.1）：totals 是**进程启动以来累计**，不是"今日"。
 *
 * 单位约定（与其它页面一致，别混）：
 *   流量  二进制：B / KiB / MiB / GiB / TiB，≥1 GiB 保留 1 位小数
 *   速率  十进制：Mb/s（bits）
 */

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

var REFRESH_MS = 15000;

var COLOR_PROXY = '#2b7de9';
var COLOR_DIRECT = '#4caf50';

var LINK_STYLE = {
	wifi: { label: '无线', color: '#7b1fa2', bg: 'rgba(123,31,162,.16)' },
	wired: { label: '有线', color: '#00838f', bg: 'rgba(0,131,143,.16)' },
	unknown: { label: '未知', color: '#9e9e9e', bg: 'rgba(158,158,158,.2)' }
};

// ---------------------------------------------------------------- 格式化

function num(value) {
	var n = (typeof value == 'number') ? value : parseInt(value, 10);

	return (typeof n == 'number' && isFinite(n)) ? n : 0;
}

/* 字段"存在且是数字"才算是真数据；缺失/null/空串一律当作没有（显示 "-"）。 */
function present(value) {
	if (typeof value == 'number') return isFinite(value);
	if (typeof value == 'string' && value.length > 0) return isFinite(Number(value));

	return false;
}

function fmtBytes(bytes) {
	var n = num(bytes);

	if (n >= 1099511627776) return (n / 1099511627776).toFixed(1) + ' TiB';
	if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GiB';
	if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
	if (n >= 1024) return Math.round(n / 1024) + ' KiB';

	return Math.round(n) + ' B';
}

/* bytes/s → Mb/s（十进制 bits），速率统一标 Mb/s */
function fmtMbps(bytesPerSecond) {
	return (num(bytesPerSecond) * 8 / 1e6).toFixed(1) + ' Mb/s';
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

function fmtClock(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function totalOf(totals) {
	var t = totals || {};

	return num(t.direct_rx) + num(t.direct_tx) + num(t.proxy_rx) + num(t.proxy_tx);
}

function hasAnyTotal(totals) {
	var t = totals || {};

	return present(t.direct_rx) || present(t.direct_tx) ||
		present(t.proxy_rx) || present(t.proxy_tx) ||
		present(t.wifi_rx) || present(t.wired_rx);
}

function deviceName(dev) {
	if (dev == null) return _('未知设备');
	if (dev.hostname && ('' + dev.hostname).length) return '' + dev.hostname;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
}

function deviceKey(dev, index) {
	if (dev == null) return 'x:' + index;
	if (dev.mac && ('' + dev.mac).length) return 'm:' + ('' + dev.mac).toLowerCase();
	if (dev.ip && ('' + dev.ip).length) return 'i:' + dev.ip;

	return 'x:' + index;
}

function deviceTotal(dev) {
	return num(dev.direct_rx) + num(dev.direct_tx) + num(dev.proxy_rx) + num(dev.proxy_tx);
}

/* 后端固定给 wifi | wired | unknown；字段缺失/其它值 → unknown。 */
function linkOf(dev) {
	if (dev == null || typeof dev.link != 'string') return 'unknown';

	var v = dev.link.toLowerCase();

	return LINK_STYLE[v] ? v : 'unknown';
}

function appLabel(host) {
	var name = (host == null) ? '' : ('' + host);

	if (name == '__other__') return _('其他（合并）');
	if (name.length == 0) return _('未知');

	return name;
}

function appListOf(dev) {
	var apps = (dev != null && dev.apps != null && typeof dev.apps == 'object') ? dev.apps : {};
	var list = [];

	for (var host in apps) {
		if (!apps.hasOwnProperty(host)) continue;

		var a = apps[host] || {};

		list.push({
			host: host,
			rx: num(a.rx),
			tx: num(a.tx),
			chain: a.chain ? '' + a.chain : ''
		});
	}

	list.sort(function(x, y) { return (y.rx + y.tx) - (x.rx + x.tx); });

	return list;
}

function chainBadge(chain) {
	var name = (chain && ('' + chain).length) ? ('' + chain) : '';
	var style;

	if (name == 'DIRECT')
		style = { label: _('直连'), color: '#2e7d32', bg: 'rgba(76,175,80,.18)' };
	else if (name == 'MIXED')
		style = { label: _('混合'), color: '#9e9e9e', bg: 'rgba(158,158,158,.2)' };
	else if (name.length)
		style = { label: _('代理'), color: COLOR_PROXY, bg: 'rgba(43,125,233,.18)' };
	else
		style = { label: '—', color: '#9e9e9e', bg: 'rgba(158,158,158,.16)' };

	return E('span', {
		'class': 'tsm-badge',
		style: 'color:' + style.color + ';background:' + style.bg,
		title: name.length ? name : null
	}, style.label);
}

function healthLook(confidence) {
	var conf = '' + (confidence == null ? 'unknown' : confidence);

	if (conf == 'exact')
		return { kind: 'exact', label: _('记账精确'), color: '#2e7d32', bg: 'rgba(76,175,80,.12)' };
	if (conf == 'degraded')
		return { kind: 'degraded', label: _('记账降级'), color: '#c62828', bg: 'rgba(198,40,40,.10)' };

	return { kind: 'unavailable', label: _('记账状态未知'), color: '#c62828', bg: 'rgba(198,40,40,.10)' };
}

/* 一组对象拼个签名字符串：数据没变就跳过整块重绘，避免 15s 一次把列表刷掉。 */
function sigOf(items, render) {
	var out = [];

	for (var i = 0; i < items.length; i++) {
		var v;

		try { v = render(items[i], i); }
		catch (e) { v = ''; }

		out.push('' + v);
	}

	return out.join('\u0001');
}

// ---------------------------------------------------------------- 样式（内联，移动优先）

var CSS = [
	'#ts-mobile{max-width:768px;margin:0 auto;padding:0 2px 28px 2px;font-size:15px;line-height:1.45;box-sizing:border-box}',
	'#ts-mobile *,#ts-mobile *::before,#ts-mobile *::after{box-sizing:border-box}',
	'.tsm-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:2px 0 12px}',
	'.tsm-head h2{margin:0;font-size:19px;font-weight:600}',
	'.tsm-meta{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85}',
	'.tsm-refresh{font:inherit;font-size:13px;line-height:1;padding:8px 14px;min-height:34px;border-radius:17px;cursor:pointer;color:inherit;background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.35)}',
	'.tsm-refresh:active{background:rgba(127,127,127,.24)}',
	'.tsm-refresh[disabled]{opacity:.5;cursor:default}',
	'.tsm-notice{display:none;margin:0 0 10px 0;padding:9px 12px;border-radius:8px;font-size:12.5px;background:rgba(198,40,40,.12);color:#c62828;border-left:3px solid #c62828;word-break:break-word}',
	'.tsm-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:8px}',
	'.tsm-card{padding:9px 8px;border-radius:10px;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.18);min-width:0}',
	'.tsm-card-t{font-size:12px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-card-v{font-size:16px;font-weight:600;line-height:1.3;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-card-s{font-size:10.5px;opacity:.65;margin-top:2px;line-height:1.35;white-space:pre-line;overflow:hidden}',
	'.tsm-rate{font-size:12px;opacity:.8;margin:0 0 10px 0}',
	'.tsm-rows{margin:0 0 6px 0;padding:2px 12px;border-radius:10px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.16)}',
	'.tsm-rowline{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13.5px}',
	'.tsm-rowline+.tsm-rowline{border-top:1px solid rgba(127,127,127,.16)}',
	'.tsm-row-l{display:flex;align-items:center;gap:7px;white-space:nowrap}',
	'.tsm-dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}',
	'.tsm-row-num{white-space:nowrap}',
	'.tsm-row-s{font-size:11.5px;opacity:.65;margin-left:4px}',
	'.tsm-note{font-size:11.5px;opacity:.6;margin:0 0 14px 0}',
	'.tsm-section{margin:0 0 16px 0}',
	'.tsm-h3{font-size:15px;font-weight:600;margin:0 0 6px 0;padding:0 0 6px 0;border-bottom:1px solid rgba(127,127,127,.2)}',
	'.tsm-h3-n{font-size:12px;font-weight:400;opacity:.6;margin-left:4px}',
	'.tsm-dev{padding:9px 2px;border-bottom:1px solid rgba(127,127,127,.14);cursor:pointer}',
	'.tsm-dev:active{background:rgba(127,127,127,.08)}',
	'.tsm-dev-top{display:flex;align-items:center;gap:8px}',
	'.tsm-dev-name{flex:1 1 auto;min-width:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-dev-bytes{flex:none;font-size:13px;white-space:nowrap}',
	'.tsm-dev-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;opacity:.75;margin-top:3px}',
	'.tsm-marker{flex:none;width:12px;font-size:11px;opacity:.6}',
	'.tsm-badge{display:inline-block;font-size:10.5px;line-height:1.5;padding:0 6px;border-radius:4px;white-space:nowrap}',
	'.tsm-detail{margin:6px 0 2px 20px}',
	'.tsm-apps{padding:8px 10px;border-radius:8px;background:rgba(127,127,127,.07)}',
	'.tsm-apps-t{font-size:11px;opacity:.65;margin-bottom:4px}',
	'.tsm-app{display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0}',
	'.tsm-app-host{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-app-b{flex:none;font-size:11.5px;opacity:.9;white-space:nowrap}',
	'.tsm-approw{display:flex;align-items:center;gap:8px;padding:8px 2px;font-size:13px;border-bottom:1px solid rgba(127,127,127,.14)}',
	'.tsm-approw-name{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-approw-b{flex:none;font-size:12.5px;white-space:nowrap}',
	'.tsm-empty{padding:14px 2px;font-size:13px;opacity:.7}',
	'.tsm-empty-s{font-size:12px;opacity:.7;padding:2px 0}',
	'.tsm-health{margin-top:16px;padding:9px 12px;border-radius:8px;border-left:4px solid #9e9e9e;background:rgba(127,127,127,.1);font-size:12.5px}',
	'.tsm-health-r{font-size:11.5px;opacity:.85;margin-top:3px}',
	'@media (min-width:600px){.tsm-card-v{font-size:19px}.tsm-card-s{font-size:11.5px}.tsm-dev-name{font-size:15px}.tsm-app,.tsm-approw{font-size:13px}}'
].join('\n');

// ---------------------------------------------------------------- 视图

return view.extend({
	load: function() {
		return callState().then(function(state) {
			this.state = (state != null && typeof state == 'object' && state.totals != null) ? state : null;
			this.error = null;
		}.bind(this)).catch(function(err) {
			this.state = null;
			this.error = (err != null && err.message) ? err.message : '' + err;
		}.bind(this));
	},

	render: function() {
		var root;

		this.state = (this.state != null) ? this.state : null;
		this.expanded = {};
		this.devSig = null;
		this.appSig = null;
		this.timer = null;
		this.refreshing = false;

		root = E('div', { 'id': 'ts-mobile' }, [
			E('style', {}, CSS),
			this.renderHead(),
			this.renderNotice(),
			this.renderCards(),
			this.renderRate(),
			this.renderSplitRows(),
			E('p', { 'class': 'tsm-note' }, _('累计口径：traffic-statsd 启动以来，进程重启即归零。')),
			this.renderDevicesSection(),
			this.renderAppsSection(),
			this.renderHealth()
		]);

		this.root = root;

		if (this.state != null) {
			this.syncAll(this.state);
			this.syncNotice('');
		}
		else {
			this.syncUnavailable(this.error);
		}

		this.startRefresh();

		return root;
	},

	// ------------------------------------------------------------ 骨架

	renderHead: function() {
		var self = this;

		this.updatedNode = E('span', {}, '—');
		this.refreshBtn = E('button', {
			type: 'button',
			'class': 'tsm-refresh',
			click: function() { self.refresh(true); }
		}, _('刷新'));

		return E('div', { 'class': 'tsm-head' }, [
			E('h2', {}, _('流量统计')),
			E('div', { 'class': 'tsm-meta' }, [
				E('span', {}, [ _('更新于') + ' ', this.updatedNode ]),
				this.refreshBtn
			])
		]);
	},

	renderNotice: function() {
		this.noticeNode = E('div', { 'class': 'tsm-notice' }, '');

		return this.noticeNode;
	},

	renderCards: function() {
		function card(title, valueNode, subNode) {
			return E('div', { 'class': 'tsm-card' }, [
				E('div', { 'class': 'tsm-card-t' }, title),
				valueNode,
				subNode
			]);
		}

		this.totalValue = E('div', { 'class': 'tsm-card-v' }, '-');
		this.totalSub = E('div', { 'class': 'tsm-card-s' }, '');
		this.wifiValue = E('div', { 'class': 'tsm-card-v' }, '-');
		this.wifiSub = E('div', { 'class': 'tsm-card-s' }, '');
		this.wiredValue = E('div', { 'class': 'tsm-card-v' }, '-');
		this.wiredSub = E('div', { 'class': 'tsm-card-s' }, '');

		return E('div', { 'class': 'tsm-cards' }, [
			card(_('总流量'), this.totalValue, this.totalSub),
			card(_('无线'), this.wifiValue, this.wifiSub),
			card(_('有线'), this.wiredValue, this.wiredSub)
		]);
	},

	renderRate: function() {
		this.rateNode = E('div', { 'class': 'tsm-rate' }, '—');

		return this.rateNode;
	},

	renderSplitRows: function() {
		function row(label, color, valueNode, subNode) {
			return E('div', { 'class': 'tsm-rowline' }, [
				E('span', { 'class': 'tsm-row-l' }, [
					E('span', { 'class': 'tsm-dot', style: 'background:' + color }),
					label
				]),
				E('span', { 'class': 'tsm-row-num' }, [ valueNode, subNode ])
			]);
		}

		this.proxyValue = E('span', {}, '-');
		this.proxySub = E('span', { 'class': 'tsm-row-s' }, '');
		this.directValue = E('span', {}, '-');
		this.directSub = E('span', { 'class': 'tsm-row-s' }, '');

		return E('div', { 'class': 'tsm-rows' }, [
			row(_('代理'), COLOR_PROXY, this.proxyValue, this.proxySub),
			row(_('直连'), COLOR_DIRECT, this.directValue, this.directSub)
		]);
	},

	renderDevicesSection: function() {
		this.devicesCount = E('span', { 'class': 'tsm-h3-n' }, '');
		this.devicesBox = E('div', {}, '');

		return E('div', { 'class': 'tsm-section' }, [
			E('h3', { 'class': 'tsm-h3' }, [ _('设备'), this.devicesCount ]),
			this.devicesBox
		]);
	},

	renderAppsSection: function() {
		this.appsBox = E('div', {}, '');

		return E('div', { 'class': 'tsm-section' }, [
			E('h3', { 'class': 'tsm-h3' }, _('应用 Top 20')),
			this.appsBox
		]);
	},

	renderHealth: function() {
		this.healthLabel = E('strong', {}, _('记账状态未知'));
		this.healthReasons = E('div', { 'class': 'tsm-health-r' }, '');
		this.healthBox = E('div', { 'class': 'tsm-health' }, [
			this.healthLabel,
			this.healthReasons
		]);

		return this.healthBox;
	},

	// ------------------------------------------------------------ 同步

	syncAll: function(state) {
		var totals = (state != null && state.totals != null) ? state.totals : {};
		var health = (state != null && state.health != null) ? state.health : {};
		var devices = (state != null && Array.isArray(state.devices)) ? state.devices : [];
		var apps = (state != null && Array.isArray(state.apps)) ? state.apps : [];

		this.setUpdated(state != null ? state.ts : 0);
		this.syncCards(totals);
		this.syncRate(totals);
		this.syncSplitRows(totals);
		this.renderDevices(devices);
		this.renderApps(apps);
		this.syncHealth(health);
	},

	setUpdated: function(ts) {
		var t = num(ts);

		this.updatedNode.textContent = t ? fmtClock(t) : '—';
		this.updatedNode.title = t ? '' + new Date(t * 1000) : '';
	},

	syncCards: function(totals) {
		var t = totals || {};
		var total = totalOf(t);
		var rx = num(t.proxy_rx) + num(t.direct_rx);
		var tx = num(t.proxy_tx) + num(t.direct_tx);

		if (hasAnyTotal(t)) {
			this.totalValue.textContent = fmtBytes(total);
			this.totalValue.title = total + ' B';
			this.totalSub.textContent = '↓ ' + fmtBytes(rx) + '\n↑ ' + fmtBytes(tx);
		}
		else {
			this.totalValue.textContent = '-';
			this.totalValue.title = _('暂无数据');
			this.totalSub.textContent = '';
		}

		this.syncLinkCard(this.wifiValue, this.wifiSub, t, 'wifi');
		this.syncLinkCard(this.wiredValue, this.wiredSub, t, 'wired');
	},

	syncLinkCard: function(valueNode, subNode, t, prefix) {
		var rx = t[prefix + '_rx'];
		var tx = t[prefix + '_tx'];

		if (!present(rx) && !present(tx)) {
			valueNode.textContent = '-';
			valueNode.title = _('后端未提供该字段');
			subNode.textContent = '';

			return;
		}

		valueNode.textContent = fmtBytes(num(rx) + num(tx));
		valueNode.title = (num(rx) + num(tx)) + ' B';
		subNode.textContent = '↓ ' + fmtBytes(rx) + '\n↑ ' + fmtBytes(tx);
	},

	syncRate: function(totals) {
		var t = totals || {};

		if (!present(t.rx_rate) && !present(t.tx_rate)) {
			this.rateNode.textContent = _('实时速率') + '：—';

			return;
		}

		this.rateNode.textContent = _('实时速率') + '：↓ ' + fmtMbps(t.rx_rate) + ' · ↑ ' + fmtMbps(t.tx_rate);
	},

	syncSplitRows: function(totals) {
		var t = totals || {};

		this.syncSplitCell(this.proxyValue, this.proxySub, t, 'proxy');
		this.syncSplitCell(this.directValue, this.directSub, t, 'direct');
	},

	syncSplitCell: function(valueNode, subNode, t, prefix) {
		if (!present(t[prefix + '_rx']) && !present(t[prefix + '_tx'])) {
			valueNode.textContent = '-';
			subNode.textContent = '';

			return;
		}

		valueNode.textContent = '↓ ' + fmtBytes(t[prefix + '_rx']);
		subNode.textContent = present(t[prefix + '_tx']) ? '↑ ' + fmtBytes(t[prefix + '_tx']) : '';
	},

	renderDevices: function(devices) {
		var self = this;
		var sig = sigOf(devices, function(dev) {
			return deviceKey(dev) + '|' + linkOf(dev) + '|' + deviceTotal(dev) + '|' + appListOf(dev).length;
		});

		this.devicesCount.textContent = devices.length ? '(' + devices.length + ')' : '';

		if (sig === this.devSig) return;

		this.devSig = sig;

		if (devices.length == 0) {
			dom.content(this.devicesBox, E('p', { 'class': 'tsm-empty' }, _('暂无数据')));

			return;
		}

		dom.content(this.devicesBox, E('div', {}, devices.map(function(dev, index) {
			return self.renderDeviceRow(dev, index);
		})));
	},

	renderDeviceRow: function(dev, index) {
		var self = this;
		var key = deviceKey(dev, index);
		var link = LINK_STYLE[linkOf(dev)] || LINK_STYLE.unknown;
		var open = (this.expanded[key] === true);
		var marker = E('span', { 'class': 'tsm-marker' }, open ? '▾' : '▸');
		var detail = E('div', { 'class': 'tsm-detail', style: open ? '' : 'display:none' }, '');
		var filled = false;

		if (open) {
			filled = true;
			dom.content(detail, this.renderDeviceApps(dev));
		}

		var row = E('div', { 'class': 'tsm-dev' }, [
			E('div', { 'class': 'tsm-dev-top' }, [
				marker,
				E('span', { 'class': 'tsm-dev-name', title: deviceName(dev) }, deviceName(dev)),
				E('span', { 'class': 'tsm-dev-bytes', title: deviceTotal(dev) + ' B' },
					fmtBytes(deviceTotal(dev)))
			]),
			E('div', { 'class': 'tsm-dev-sub' }, [
				E('span', { 'class': 'tsm-badge', style: 'color:' + link.color + ';background:' + link.bg },
					_(link.label)),
				'↓ ' + fmtBytes(num(dev.direct_rx) + num(dev.proxy_rx)),
				'· ↑ ' + fmtBytes(num(dev.direct_tx) + num(dev.proxy_tx)),
				(dev.ip && ('' + dev.ip).length) ? ('· ' + dev.ip) : ''
			]),
			detail
		]);

		row.addEventListener('click', function() {
			open = !(self.expanded[key] === true);
			self.expanded[key] = open;
			marker.textContent = open ? '▾' : '▸';
			detail.style.display = open ? '' : 'none';

			if (open && !filled) {
				filled = true;
				dom.content(detail, self.renderDeviceApps(dev));
			}
		});

		return row;
	},

	renderDeviceApps: function(dev) {
		var list = appListOf(dev).slice(0, 5);

		if (list.length == 0)
			return E('div', { 'class': 'tsm-empty-s' }, _('该设备暂无应用明细'));

		return E('div', { 'class': 'tsm-apps' }, [
			E('div', { 'class': 'tsm-apps-t' }, _('应用 Top 5'))
		].concat(list.map(function(app) {
			return E('div', { 'class': 'tsm-app' }, [
				E('span', { 'class': 'tsm-app-host', title: app.host }, appLabel(app.host)),
				chainBadge(app.chain),
				E('span', { 'class': 'tsm-app-b' }, fmtBytes(app.rx + app.tx))
			]);
		})));
	},

	renderApps: function(apps) {
		var list = apps.slice().sort(function(a, b) {
			return (num(b.rx) + num(b.tx)) - (num(a.rx) + num(a.tx));
		}).slice(0, 20);

		var sig = sigOf(list, function(app) {
			return '' + (app && app.host) + '|' + num(app && app.rx) + '|' + num(app && app.tx) + '|' + (app && app.chain);
		});

		if (sig === this.appSig) return;

		this.appSig = sig;

		if (list.length == 0) {
			dom.content(this.appsBox, E('p', { 'class': 'tsm-empty' }, _('暂无数据')));

			return;
		}

		dom.content(this.appsBox, E('div', {}, list.map(function(app) {
			var host = (app && app.host != null) ? '' + app.host : '';

			return E('div', { 'class': 'tsm-approw' }, [
				E('span', { 'class': 'tsm-approw-name', title: host }, appLabel(host)),
				chainBadge(app != null ? app.chain : ''),
				E('span', { 'class': 'tsm-approw-b' }, fmtBytes(num(app && app.rx) + num(app && app.tx)))
			]);
		})));
	},

	syncHealth: function(health) {
		var h = health || {};
		var look = healthLook(h.accounting_confidence);
		var reasons = Array.isArray(h.reasons) ? h.reasons : [];
		var bad = (look.kind != 'exact') || (reasons.length > 0);
		var color = bad ? '#c62828' : look.color;

		this.healthBox.style.borderLeftColor = color;
		this.healthBox.style.background = bad ? 'rgba(198,40,40,.10)' : look.bg;
		this.healthLabel.style.color = color;
		this.healthLabel.textContent = bad && look.kind == 'exact'
			? look.label + _('（有异常）')
			: look.label;

		dom.content(this.healthReasons, reasons.length
			? reasons.map(function(reason) { return E('div', {}, '· ' + reason); })
			: E('span', {}, look.kind == 'exact' ? _('无异常') : '—'));
	},

	syncNotice: function(message) {
		var text = ('' + (message == null ? '' : message)).replace(/^\s+|\s+$/g, '');

		this.noticeNode.textContent = text;
		this.noticeNode.style.display = text.length ? 'block' : 'none';
	},

	/* 没有数据时把每个区块都填成占位符，绝不留白屏。 */
	syncUnavailable: function(reason) {
		var msg = ('' + (reason == null ? '' : reason)).replace(/^\s+|\s+$/g, '');

		this.setUpdated(0);
		this.totalValue.textContent = '-';
		this.totalSub.textContent = '';
		this.wifiValue.textContent = '-';
		this.wifiSub.textContent = '';
		this.wiredValue.textContent = '-';
		this.wiredSub.textContent = '';
		this.rateNode.textContent = _('实时速率') + '：—';
		this.proxyValue.textContent = '-';
		this.proxySub.textContent = '';
		this.directValue.textContent = '-';
		this.directSub.textContent = '';

		this.devicesCount.textContent = '';
		dom.content(this.devicesBox, E('p', { 'class': 'tsm-empty' }, _('暂无数据')));
		dom.content(this.appsBox, E('p', { 'class': 'tsm-empty' }, _('暂无数据')));
		this.devSig = null;
		this.appSig = null;

		this.syncHealth({ accounting_confidence: 'unavailable', reasons: [] });
		this.syncNotice(msg.length
			? (_('暂无数据') + '：' + msg)
			: _('暂无数据：后端 traffic-stats.get_state 不可用，或 traffic-statsd 尚未写入 state.json。'));
	},

	setBusy: function(busy) {
		if (this.refreshBtn == null) return;

		this.refreshBtn.disabled = (busy === true);
		this.refreshBtn.textContent = (busy === true) ? _('刷新中…') : _('刷新');
	},

	// ------------------------------------------------------------ 刷新

	refresh: function(manual) {
		var self = this;

		if (this.refreshing === true) return Promise.resolve();

		this.refreshing = true;

		if (manual === true) this.setBusy(true);

		return callState().then(function(state) {
			if (state != null && typeof state == 'object' && state.totals != null) {
				self.state = state;
				self.error = null;
				self.syncAll(state);
				self.syncNotice('');
			}
			else {
				self.syncUnavailable(_('后端返回了空数据'));
			}
		}).catch(function(err) {
			self.error = (err != null && err.message) ? err.message : '' + err;

			/* 有旧数据就保留着，只在顶部提示刷新失败；从来没有数据才铺占位符。 */
			if (self.state != null)
				self.syncNotice(_('刷新失败') + '：' + self.error);
			else
				self.syncUnavailable(self.error);
		}).then(function() {
			self.refreshing = false;

			if (manual === true) self.setBusy(false);
		});
	},

	startRefresh: function() {
		var self = this;

		this.stopRefresh();

		this.timer = window.setInterval(function() {
			/* 离开页面后 #view 会被整体替换，这里顺便停表，避免后台一直轮询 */
			if (self.root == null || !document.body.contains(self.root)) {
				self.stopRefresh();

				return;
			}

			if (document.hidden === true) return;

			self.refresh(false);
		}, REFRESH_MS);

		if (typeof window.addEventListener == 'function') {
			this.unloadFn = function() { self.stopRefresh(); };
			window.addEventListener('beforeunload', this.unloadFn);
			window.addEventListener('unload', this.unloadFn);
		}
	},

	stopRefresh: function() {
		if (this.timer != null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}

		if (this.unloadFn != null && typeof window.removeEventListener == 'function') {
			window.removeEventListener('beforeunload', this.unloadFn);
			window.removeEventListener('unload', this.unloadFn);
			this.unloadFn = null;
		}
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
