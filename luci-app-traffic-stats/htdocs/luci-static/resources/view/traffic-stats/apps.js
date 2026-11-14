'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 流量统计 · 应用（域名）
 *
 * 一次 rpc 调用拿 state.apps（排行）+ state.devices（下钻所需的应用明细）。
 * 筛选完全在前端做（切一次筛选不产生 rpc）：
 *   全部 / 仅代理 / 仅直连 / 按节点（state.nodes 里除 DIRECT 以外的出口）
 * 点行展开该域名在各设备上的用量 —— 这就是"下钻到设备"。
 *
 * 单位：流量二进制（GiB/MiB），速率不出现在本页。
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

function shortHost(host, max) {
	var s = (host == null) ? '' : ('' + host);

	if (s == '__other__') return _('其他（合并）');
	if (s.length <= max) return s;

	return s.substring(0, max - 1) + '…';
}

function deviceName(dev) {
	if (dev == null) return _('未知设备');
	if (dev.hostname && ('' + dev.hostname).length) return '' + dev.hostname;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
}

function appTotal(app) {
	return num(app.rx) + num(app.tx);
}

function chainBadge(chain) {
	var name = (chain && ('' + chain).length) ? ('' + chain) : '—';

	return E('span', {
		style: 'font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap;background:' +
			(name == 'DIRECT' ? 'rgba(76,175,80,.2)' : 'rgba(43,125,233,.2)')
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

		if (state == null || !Array.isArray(state.apps))
			return E('div', {}, [
				E('h2', {}, _('流量统计 · 应用')),
				this.renderEmpty(state)
			]);

		this.filter = 'all';
		this.devices = Array.isArray(state.devices) ? state.devices : [];
		this.apps = state.apps.slice().sort(function(a, b) { return appTotal(b) - appTotal(a); });
		this.totalBytes = 0;

		for (var i = 0; i < this.apps.length; i++)
			this.totalBytes += appTotal(this.apps[i]);

		var nodes = this.listNodes(state);
		var options = [
			E('option', { value: 'all' }, _('全部')),
			E('option', { value: 'proxy' }, _('仅代理')),
			E('option', { value: 'direct' }, _('仅直连'))
		].concat(nodes.map(function(node) {
			return E('option', { value: 'node:' + node }, _('节点：') + node);
		}));

		this.filterSelect = E('select', {
			'class': 'cbi-input-select',
			change: L.bind(this.onFilterChange, this)
		}, options);

		this.tableWrap = E('div', {});

		var root = E('div', {}, [
			E('h2', {}, _('流量统计 · 应用')),
			E('p', { style: 'margin:0 0 12px 0;font-size:12px;opacity:.85' }, [
				_('共') + ' ' + this.apps.length + ' ' + _('个域名'),
				' · ',
				_('按合计流量排序'),
				state.truncated === true ? ' · ' + _('数据过大，后端已裁剪') : ''
			]),
			E('div', {
				style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px'
			}, [
				E('label', { style: 'font-size:13px' }, _('筛选')),
				this.filterSelect,
				E('span', { style: 'font-size:12px;opacity:.7' },
					_('切换筛选不会重新请求后端；点行展开可下钻到设备'))
			]),
			this.tableWrap
		]);

		dom.content(this.tableWrap, this.renderTable());

		return root;
	},

	listNodes: function(state) {
		var nodes = (state != null && state.nodes != null && typeof state.nodes == 'object') ? state.nodes : {};
		var list = [];

		for (var name in nodes) {
			if (!nodes.hasOwnProperty(name)) continue;
			if (name == 'DIRECT' || name == '__other__') continue;

			list.push(name);
		}

		return list.sort();
	},

	onFilterChange: function(ev) {
		this.filter = ev.currentTarget.value || 'all';
		dom.content(this.tableWrap, this.renderTable());
	},

	matchChain: function(chain) {
		var name = (chain == null) ? '' : ('' + chain);

		if (this.filter == 'all') return true;
		if (this.filter == 'proxy') return name != 'DIRECT';
		if (this.filter == 'direct') return name == 'DIRECT';

		if (this.filter.indexOf('node:') == 0)
			return name == this.filter.substring(5);

		return true;
	},

	renderTable: function() {
		var self = this;
		var rows = [];

		for (var i = 0; i < this.apps.length; i++) {
			var app = this.apps[i];

			if (this.matchChain(app.chain))
				rows.push(this.renderAppRow(app));
		}

		if (rows.length == 0)
			return E('div', { 'class': 'alert-message', style: 'padding:12px 14px' }, [
				E('strong', {}, _('暂无数据')),
				E('p', {}, _('当前筛选条件下没有域名记录。')),
				E('p', {}, [
					_('试试'),
					' ',
					E('a', {
						href: '#',
						click: function(ev) {
							ev.preventDefault();
							self.filter = 'all';
							if (self.filterSelect != null) self.filterSelect.value = 'all';
							dom.content(self.tableWrap, self.renderTable());
						}
					}, _('切换回"全部"'))
				])
			]);

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th', style: 'width:36px' }, '#'),
				E('th', { 'class': 'th' }, _('应用/域名')),
				E('th', { 'class': 'th' }, _('出口')),
				E('th', { 'class': 'th', style: 'text-align:right' }, _('设备数')),
				E('th', { 'class': 'th', style: 'text-align:right' }, _('下载')),
				E('th', { 'class': 'th', style: 'text-align:right' }, _('上传')),
				E('th', { 'class': 'th', style: 'text-align:right' }, _('合计')),
				E('th', { 'class': 'th' }, _('占比'))
			])
		].concat(rows));
	},

	renderAppRow: function(app) {
		var self = this;
		var total = appTotal(app);
		var percent = (this.totalBytes > 0) ? (total * 100 / this.totalBytes) : 0;
		var marker = E('span', { style: 'display:inline-block;width:12px;opacity:.6' }, '▸');
		var cell = E('td', {
			'class': 'td',
			colspan: 8,
			style: 'padding:10px 12px;background:rgba(127,127,127,.06)'
		}, E('em', {}, _('展开后加载…')));
		var detailRow = E('tr', { 'class': 'tr', style: 'display:none' }, [ cell ]);
		var filled = false;
		var open = false;

		var row = E('tr', {
			'class': 'tr',
			style: 'cursor:pointer',
			title: _('点击展开：该域名在各设备上的用量')
		}, [
			E('td', { 'class': 'td', style: 'opacity:.6' }, marker),
			E('td', { 'class': 'td', title: '' + (app.host || '') },
				E('strong', {}, shortHost(app.host, 44))),
			E('td', { 'class': 'td' }, chainBadge(app.chain)),
			E('td', { 'class': 'td', style: 'text-align:right' }, '' + num(app.devices)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(app.rx)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(app.tx)),
			E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(total))),
			E('td', { 'class': 'td', style: 'width:120px' }, [
				E('div', {
					style: 'height:6px;border-radius:3px;background:rgba(127,127,127,.2);overflow:hidden'
				}, E('div', {
					style: 'height:6px;width:' + percent.toFixed(1) + '%;background:' +
						(app.chain == 'DIRECT' ? '#4caf50' : '#2b7de9')
				})),
				E('span', { style: 'font-size:11px;opacity:.7' }, percent.toFixed(1) + '%')
			])
		]);

		row.addEventListener('click', function() {
			open = !open;
			detailRow.style.display = open ? '' : 'none';
			marker.textContent = open ? '▾' : '▸';

			if (open && !filled) {
				filled = true;
				dom.content(cell, self.renderDeviceDrilldown(app));
			}
		});

		return [ row, detailRow ];
	},

	renderDeviceDrilldown: function(app) {
		var host = (app.host == null) ? '' : ('' + app.host);
		var matched = [];

		for (var i = 0; i < this.devices.length; i++) {
			var dev = this.devices[i];
			var entry = (dev.apps != null && typeof dev.apps == 'object') ? dev.apps[host] : null;

			if (entry == null) continue;
			if (!this.matchChain(entry.chain)) continue;

			matched.push({
				dev: dev,
				rx: num(entry.rx),
				tx: num(entry.tx),
				chain: (entry.chain == null) ? '' : ('' + entry.chain)
			});
		}

		matched.sort(function(a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

		if (matched.length == 0)
			return E('div', {}, E('em', { style: 'opacity:.7' },
				_('这个域名在当前筛选下没有设备维度明细（可能是聚合层记录，也可能是后端裁剪掉了）。')));

		var rows = matched.map(function(item) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('strong', {}, deviceName(item.dev))),
				E('td', { 'class': 'td' }, E('code', {}, item.dev.ip ? '' + item.dev.ip : '—')),
				E('td', { 'class': 'td' }, chainBadge(item.chain)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(item.rx)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(item.tx)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(item.rx + item.tx))
			]);
		});

		return E('div', {}, [
			E('div', { style: 'font-size:12px;opacity:.85;margin-bottom:6px' },
				_('下钻：') + shortHost(host, 60) + ' ' + _('分布在') + ' ' + matched.length + ' ' + _('台设备上')),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('设备')),
					E('th', { 'class': 'th' }, _('IP')),
					E('th', { 'class': 'th' }, _('出口')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('下载')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('上传')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('合计'))
				])
			].concat(rows)),
			E('p', { style: 'margin:8px 0 0 0' }, E('a', {
				href: L.url('admin/services/traffic-stats/devices')
			}, _('在设备页查看全部应用 →')))
		]);
	},

	renderEmpty: function(state) {
		var message;

		if (state == null)
			message = _('暂时读不到应用列表：rpcd 对象 traffic-stats 不可用，或者后端尚未安装。');
		else if (state.running !== true)
			message = _('暂无数据：traffic-statsd 未运行，因此还没有域名记录。');
		else
			message = _('暂无数据：traffic-statsd 正在运行，但还没采到任何域名。');

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
			E('p', {}, E('strong', {}, message)),
			E('p', {}, [
				E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页')),
				' · ',
				E('a', { href: L.url('admin/services/traffic-stats/overview') }, _('返回总览'))
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
