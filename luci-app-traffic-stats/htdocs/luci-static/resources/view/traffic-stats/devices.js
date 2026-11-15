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
 * 单位：流量二进制（GiB/MiB），速率十进制 Mb/s（bits），括号/悬浮为十进制 MB/s。
 */

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

/*
 * 哑桥 AP 上报的无线站点元数据（只有信号/速率/连接时长，没有字节）。
 * 老版本后端没有这个方法 → 调用失败时整页照常显示，只是信号列全是 "-"。
 */
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

		if (state == null || !Array.isArray(state.devices) || state.devices.length == 0)
			return E('div', {}, [
				E('h2', {}, _('流量统计 · 设备')),
				this.renderEmpty()
			]);

		var devices = state.devices.slice().sort(function(a, b) {
			return deviceTotal(b) - deviceTotal(a);
		});

		var rows = [];

		for (var i = 0; i < devices.length; i++)
			rows.push(this.renderDeviceRow(devices[i]));

		var summary = E('p', { style: 'margin:0 0 12px 0;font-size:12px;opacity:.85' }, [
			_('共') + ' ' + devices.length + ' ' + _('台设备'),
			state.truncated === true ? ' · ' + _('数据过大，后端已裁剪（仅显示使用量最高的部分）') : '',
			' · ',
			this.linkSummary(state),
			_('点击任意一行展开该设备的应用分布')
		]);

		return E('div', {}, [
			E('h2', {}, _('流量统计 · 设备')),
			summary,
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('主机名')),
					E('th', { 'class': 'th' }, _('MAC')),
					E('th', { 'class': 'th' }, _('IP')),
					E('th', {
						'class': 'th',
						title: _('接入方式：主路由桥 FDB 里该设备 MAC 学在哪个端口（无线/有线），与代理/直连无关')
					}, _('接入')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('直连')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('代理')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('合计')),
					E('th', { 'class': 'th', style: 'text-align:right', title: _('Mb/s（bits），悬浮显示十进制 MB/s') }, _('速率')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('最后在线')),
					E('th', {
						'class': 'th',
						style: 'text-align:right',
						title: _('来自哑桥 AP 的无线信号（仅元数据，不含流量）')
					}, _('信号'))
				])
			].concat(rows))
		]);
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
		var marker = E('span', {
			style: 'display:inline-block;width:12px;opacity:.6',
			title: _('展开应用分布')
		}, '▸');

		var cell = E('td', {
			'class': 'td',
			colspan: 10,
			style: 'padding:10px 12px;background:rgba(127,127,127,.06)'
		}, E('em', {}, _('展开后加载…')));

		var detailRow = E('tr', {
			'class': 'tr',
			style: 'display:none'
		}, [ cell ]);

		var filled = false;
		var open = false;

		var row = E('tr', {
			'class': 'tr',
			style: 'cursor:pointer',
			title: _('点击展开/收起该设备的应用分布')
		}, [
			E('td', { 'class': 'td' }, [ marker, ' ', E('strong', {}, shorten(name, 30)) ]),
			E('td', { 'class': 'td' }, E('code', {}, dev.mac ? '' + dev.mac : '—')),
			E('td', { 'class': 'td' }, E('code', {}, dev.ip ? '' + dev.ip : '—')),
			this.renderLink(dev),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(direct)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(proxy)),
			E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(total))),
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
