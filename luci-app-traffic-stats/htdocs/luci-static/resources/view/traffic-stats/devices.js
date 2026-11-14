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
			rows.push(this.renderDeviceRow(devices[i], i));

		var summary = E('p', { style: 'margin:0 0 12px 0;font-size:12px;opacity:.85' }, [
			_('共 %d 台设备').format(devices.length),
			state.truncated === true ? ' · ' + _('数据过大，后端已裁剪（仅显示使用量最高的部分）') : '',
			' · ',
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
					E('th', { 'class': 'th', style: 'text-align:right' }, _('直连')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('代理')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('合计')),
					E('th', { 'class': 'th', style: 'text-align:right', title: _('Mb/s（bits），悬浮显示十进制 MB/s') }, _('速率')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('最后在线'))
				])
			].concat(rows))
		]);
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
			message = _('traffic-statsd 未运行，因此还没有设备数据。');
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

	renderDeviceRow: function(dev, index) {
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
			colspan: 8,
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
			E('td', { 'class': 'td', style: 'text-align:right;white-space:nowrap' }, fmtTime(dev.last_seen))
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
				E('td', { 'class': 'td', title: app.host }, shorten(app.host, 48)),
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
