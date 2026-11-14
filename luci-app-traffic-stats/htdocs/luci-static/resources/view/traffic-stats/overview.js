'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 流量统计 · 总览
 *
 * 数据来源只有一次 rpcd 调用（get_state），之后每 5s 用同一个方法增量刷新数字，
 * 不重画图表、不动 DOM 结构。
 *
 * 单位约定（四个页面一致，别混）：
 *   流量     二进制：B / KiB / MiB / GiB / TiB，≥1 GiB 保留 1 位小数
 *   速率     十进制：Mb/s（bits，链路习惯），括号里的十进制 MB/s 作为辅助
 */

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

var REFRESH_MS = 5000;
var COLOR_PROXY = '#2b7de9';
var COLOR_DIRECT = '#4caf50';

// ---------------------------------------------------------------- 格式化

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

/* bytes/s → bits/s（Mb/s 是十进制，和 MB/s 明确区分） */
function fmtRateBits(bytesPerSecond) {
	var bits = num(bytesPerSecond) * 8;

	if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gb/s';
	if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mb/s';
	if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' kb/s';

	return Math.round(bits) + ' b/s';
}

/* bytes/s → 十进制 MB/s */
function fmtRateBytes(bytesPerSecond) {
	var n = num(bytesPerSecond);

	if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB/s';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB/s';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB/s';

	return Math.round(n) + ' B/s';
}

function fmtPercent(part, total) {
	var p = num(part), t = num(total);

	if (t <= 0) return '0%';

	return (p * 100 / t).toFixed(1) + '%';
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

function shorten(text, max) {
	var s = '' + (text == null ? '' : text);

	if (s.length <= max) return s;

	return s.substring(0, max - 1) + '…';
}

function healthLook(confidence) {
	var conf = '' + (confidence == null ? 'unknown' : confidence);

	if (conf == 'exact')
		return { color: '#2e7d32', bg: 'rgba(76,175,80,.12)', label: _('记账精确') };
	if (conf == 'degraded')
		return { color: '#e65100', bg: 'rgba(255,152,0,.14)', label: _('记账降级') };

	return { color: '#c62828', bg: 'rgba(198,40,40,.12)', label: _('记账状态未知') };
}

function deviceName(dev) {
	if (dev == null) return _('未知设备');
	if (dev.hostname && ('' + dev.hostname).length) return '' + dev.hostname;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
}

function totalOf(totals) {
	var t = totals || {};

	return num(t.direct_rx) + num(t.direct_tx) + num(t.proxy_rx) + num(t.proxy_tx);
}

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
		var state = this.state;

		this.cells = [];
		this.chart = null;

		if (state == null)
			return E('div', {}, [
				E('h2', {}, _('流量统计 · 总览')),
				this.renderUnavailable()
			]);

		var total = totalOf(state.totals);
		var devices = Array.isArray(state.devices) ? state.devices : [];
		var apps = Array.isArray(state.apps) ? state.apps : [];
		var health = state.health || {};

		var empty = (num(state.ts) == 0) && (total == 0) && (devices.length == 0) && (apps.length == 0);

		var root = E('div', {}, [
			E('h2', {}, _('流量统计 · 总览')),
			this.renderStatusLine(state),
			this.renderHealth(state, health),
			empty ? this.renderEmpty(health) : '',
			this.renderCards(state),
			this.renderChart(state),
			this.renderTopApps(state, apps, total),
			this.renderTopDevices(state, devices)
		]);

		this.root = root;
		this.syncAll(state);

		if (empty)
			this.stopRefresh();
		else
			this.startRefresh();

		return root;
	},

	renderUnavailable: function() {
		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
			E('p', {}, _('暂时读不到统计数据：rpcd 对象 traffic-stats 不可用，或者后端尚未安装。')),
			E('p', {}, _('已安装 traffic-statsd 的话，请确认 rpcd 已重载：') + ' ',
				E('code', {}, '/etc/init.d/rpcd reload')),
			E('p', {}, E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页')))
		]);
	},

	renderEmpty: function(health) {
		var h = health || {};
		var reasons = Array.isArray(h.reasons) ? h.reasons : [];

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
			E('p', {}, E('strong', {}, _('暂无数据'))),
			E('p', {}, this.state && this.state.running
				? _('traffic-statsd 正在运行，但还没有采到任何流量；等几秒后会自动刷新。')
				: _('traffic-statsd 未运行或刚启动，因此还没有 state.json。')),
			reasons.length ? E('ul', {}, reasons.map(function(r) { return E('li', {}, '' + r); })) : '',
			E('p', {}, [
				E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页') + ' '),
				_('检查采集参数与 service 状态。')
			])
		]);
	},

	renderStatusLine: function(state) {
		var running = (state != null) && (state.running === true);

		this.updatedNode = E('span', {}, '');
		this.runningBadge = E('span', {
			'class': 'label',
			style: 'display:inline-block;padding:1px 8px;border-radius:4px;margin-right:8px;color:#fff;background:' +
				(running ? '#4caf50' : '#c62828')
		}, running ? _('服务运行中') : _('服务未运行'));
		this.dataTimeNode = E('span', {}, '');

		return E('p', { style: 'margin:0 0 10px 0;font-size:12px;opacity:.85' }, [
			this.runningBadge,
			this.updatedNode,
			' · ',
			this.dataTimeNode
		]);
	},

	updateStatusLine: function(state) {
		var running = (state != null) && (state.running === true);

		if (this.runningBadge != null) {
			this.runningBadge.textContent = running ? _('服务运行中') : _('服务未运行');
			this.runningBadge.style.background = running ? '#4caf50' : '#c62828';
		}

		if (this.dataTimeNode != null)
			this.dataTimeNode.textContent = _('数据时间') + ' ' + fmtClock(state != null ? state.ts : 0);
	},

	renderHealth: function(state, health) {
		var h = health || {};
		var look = healthLook(h.accounting_confidence);
		var source = (state != null && state.source && typeof state.source == 'object') ? state.source : {};

		this.healthBox = E('div', {
			style: 'padding:10px 14px;margin-bottom:16px;border-left:4px solid ' + look.color +
				';border-radius:6px;background:' + look.bg
		}, [
			E('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
				this.healthLabel = E('strong', { style: 'color:' + look.color }, look.label),
				this.healthBits = E('span', { style: 'font-size:12px;opacity:.8' }, '')
			]),
			this.healthReasons = E('ul', { style: 'margin:8px 0 0 0;padding-left:20px;font-size:12px' }, '')
		]);

		return this.healthBox;
	},

	updateHealth: function(state) {
		var h = (state != null && state.health) ? state.health : {};
		var source = (state != null && state.source && typeof state.source == 'object') ? state.source : {};
		var look = healthLook(h.accounting_confidence);
		var reasons = Array.isArray(h.reasons) ? h.reasons : [];

		if (this.healthBox == null || this.healthLabel == null) return;

		this.healthBox.style.borderLeftColor = look.color;
		this.healthBox.style.background = look.bg;
		this.healthLabel.style.color = look.color;
		this.healthLabel.textContent = look.label;
		this.healthBits.textContent = [
			_('数据源') + ' clash=' + (source.clash || 'unknown') + ', conntrack=' + (source.conntrack || 'unknown'),
			_('conntrack 条目') + ' ' + num(h.conntrack_count),
			_('clash 连接') + ' ' + num(h.clash_connections),
			_('clash 轮询') + ' ' + num(h.clash_poll_ms) + ' ms'
		].join(' · ');

		dom.content(this.healthReasons, reasons.map(function(reason) {
			return E('li', {}, '' + reason);
		}));
	},

	renderCards: function(state) {
		var self = this;

		/* 副行统一用 cell()，这样 5s 刷新时数字会跟着动 */
		function fromTotals(render) {
			return E('div', { style: 'font-size:12px;opacity:.75' }, [
				self.cell(function(s) { return render(s.totals || {}); })
			]);
		}

		function rxTx(field) {
			return E('div', { style: 'font-size:12px;opacity:.75' }, [
				'↓ ', self.cell(function(s) { return fmtBytes(num((s.totals || {})[field + '_rx'])); }),
				' · ↑ ', self.cell(function(s) { return fmtBytes(num((s.totals || {})[field + '_tx'])); })
			]);
		}

		function card(title, valueRender, subNode, title2) {
			return E('div', {
				style: 'flex:1 1 200px;min-width:170px;padding:12px 14px;border-radius:8px;' +
					'background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.18)'
			}, [
				E('div', { style: 'font-size:12px;opacity:.75', title: title2 || null }, title),
				E('div', { style: 'font-size:21px;font-weight:600;line-height:1.35' }, self.cell(valueRender)),
				subNode
			]);
		}

		return E('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px' }, [
			card(_('总流量'),
				function(s) { return fmtBytes(totalOf(s.totals)); },
				fromTotals(function(t) {
					return '↓ ' + fmtBytes(num(t.proxy_rx) + num(t.direct_rx)) +
						' · ↑ ' + fmtBytes(num(t.proxy_tx) + num(t.direct_tx));
				})),
			card(_('代理流量'),
				function(s) { return fmtBytes(num((s.totals || {}).proxy_rx) + num((s.totals || {}).proxy_tx)); },
				rxTx('proxy')),
			card(_('直连流量'),
				function(s) { return fmtBytes(num((s.totals || {}).direct_rx) + num((s.totals || {}).direct_tx)); },
				rxTx('direct')),
			card(_('实时速率'),
				function(s) { return fmtRateBits(num((s.totals || {}).rx_rate)); },
				E('div', { style: 'font-size:12px;opacity:.75' }, [
					'↑ ', self.cell(function(s) { return fmtRateBits(num((s.totals || {}).tx_rate)); }),
					' · ',
					self.cell(function(s) { return '↓ ' + fmtRateBytes(num((s.totals || {}).rx_rate)); })
				]),
				_('速率按 Mb/s（bits）；同一行的 MB/s 是十进制字节速率'))
		]);
	},

	renderChart: function(state) {
		var totals = state.totals || {};
		var proxy = num(totals.proxy_rx) + num(totals.proxy_tx);
		var direct = num(totals.direct_rx) + num(totals.direct_tx);
		var sum = proxy + direct;
		var canvas = E('canvas', { width: 220, height: 220, style: 'width:220px;height:220px' });
		var self = this;

		this.chartData = { proxy: proxy, direct: direct };

		function legendRow(color, label, value, percent) {
			return E('li', { style: 'margin:6px 0;list-style:none' }, [
				E('span', {
					style: 'display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;background:' + color
				}),
				E('strong', {}, label),
				' ',
				E('span', {}, fmtBytes(value)),
				E('span', { style: 'opacity:.7' }, ' (' + percent + ')')
			]);
		}

		var chart = E('div', { style: 'display:flex;gap:24px;align-items:center;flex-wrap:wrap' }, [
			canvas,
			E('ul', { style: 'margin:0;padding:0;min-width:220px' }, [
				legendRow(COLOR_PROXY, _('代理'), proxy, fmtPercent(proxy, sum)),
				legendRow(COLOR_DIRECT, _('直连'), direct, fmtPercent(direct, sum)),
				E('li', { style: 'margin-top:10px;font-size:12px;opacity:.7;list-style:none' },
					_('累计字节，按 rx+tx 计算'))
			])
		]);

		/* 图表库由 luci-lib-chartjs 提供（nlbw.chart.min.js，Chart.js v1 API）。
		   注意是异步注入：必须等 script 的 load 事件，不能在 render 里直接 new Chart。 */
		var script = null;

		if (typeof window.Chart == 'function') {
			window.setTimeout(function() { self.drawChart(canvas); }, 0);
		}
		else {
			script = E('script', {
				type: 'text/javascript',
				src: L.resource('nlbw.chart.min.js'),
				load: function() { self.drawChart(canvas); },
				error: function() {
					dom.content(canvas.parentNode, E('div', {
						'class': 'alert-message warning'
					}, _('图表库未安装（luci-lib-chartjs），环形图无法显示。')));
				}
			});
		}

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('代理 vs 直连')),
			chart,
			script || ''
		]);
	},

	drawChart: function(canvas) {
		var ChartLib = window.Chart;

		if (typeof ChartLib != 'function' || !canvas || !canvas.getContext) return;

		var ctx = canvas.getContext('2d');

		if (!ctx) return;

		var data = this.chartData || { proxy: 0, direct: 0 };
		var sum = data.proxy + data.direct;

		/* 把 chart.js v1 的全局样式按我们需要的设定一次；customTooltips 归零以恢复内置 tooltip。 */
		if (ChartLib.defaults && ChartLib.defaults.global) {
			ChartLib.defaults.global.customTooltips = null;
			ChartLib.defaults.global.showTooltips = true;
			ChartLib.defaults.global.tooltipTemplate = function(item) {
				return '' + item.label + ': ' + fmtBytes(item.value);
			};
			ChartLib.defaults.global.multiTooltipTemplate = ChartLib.defaults.global.tooltipTemplate;
		}

		var segments = (sum > 0) ? [
			{ value: data.proxy, color: COLOR_PROXY, highlight: '#5c9cef', label: _('代理') },
			{ value: data.direct, color: COLOR_DIRECT, highlight: '#81c784', label: _('直连') }
		] : [
			{ value: 1, color: 'rgba(127,127,127,.25)', highlight: 'rgba(127,127,127,.25)', label: _('暂无数据') }
		];

		if (this.chart != null) {
			try { this.chart.destroy(); } catch (e) { }
			this.chart = null;
		}

		try {
			this.chart = new ChartLib(ctx).Doughnut(segments, {
				segmentStrokeWidth: 2,
				percentageInnerCutout: 62,
				animation: false
			});
		}
		catch (e) {
			/* 图表失败不影响页面其它部分 */
			if (window.console) console.warn('traffic-stats: 环形图绘制失败', e);
		}
	},

	renderTopApps: function(state, apps, total) {
		var top = apps.slice().sort(function(a, b) {
			return (num(b.rx) + num(b.tx)) - (num(a.rx) + num(a.tx));
		}).slice(0, 5);

		var body;

		if (top.length == 0) {
			body = E('p', { style: 'opacity:.7' }, _('暂无数据'));
		}
		else {
			body = E('div', { 'class': 'cbi-section-table' }, [
				E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('应用/域名')),
						E('th', { 'class': 'th' }, _('出口')),
						E('th', { 'class': 'th', style: 'text-align:right' }, _('下载')),
						E('th', { 'class': 'th', style: 'text-align:right' }, _('上传')),
						E('th', { 'class': 'th', style: 'text-align:right' }, _('合计'))
					])
				].concat(top.map(function(app) {
					var totalBytes = num(app.rx) + num(app.tx);

					return E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', title: '' + (app.host || '') }, shorten(app.host || _('未知'), 40)),
						E('td', { 'class': 'td' }, E('span', {
							style: 'font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(127,127,127,.18)'
						}, (app.chain && app.chain.length) ? app.chain : '—')),
						E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(app.rx)),
						E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(app.tx)),
						E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(totalBytes))
					]);
				})))
			]);
		}

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('Top 5 应用')),
			body,
			E('p', { style: 'margin-top:8px' }, E('a', {
				href: L.url('admin/services/traffic-stats/apps')
			}, _('查看全部应用 →')))
		]);
	},

	renderTopDevices: function(state, devices) {
		var top = devices.slice().sort(function(a, b) {
			return (num(b.direct_rx) + num(b.direct_tx) + num(b.proxy_rx) + num(b.proxy_tx)) -
				(num(a.direct_rx) + num(a.direct_tx) + num(a.proxy_rx) + num(a.proxy_tx));
		}).slice(0, 5);

		var body;

		if (top.length == 0) {
			body = E('p', { style: 'opacity:.7' }, _('暂无数据'));
		}
		else {
			body = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('设备')),
					E('th', { 'class': 'th' }, _('IP')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('直连')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('代理')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('速率'))
				])
			].concat(top.map(function(dev) {
				var direct = num(dev.direct_rx) + num(dev.direct_tx);
				var proxy = num(dev.proxy_rx) + num(dev.proxy_tx);

				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', title: deviceName(dev) }, shorten(deviceName(dev), 28)),
					E('td', { 'class': 'td' }, E('code', {}, dev.ip || '—')),
					E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(direct)),
					E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(proxy)),
					E('td', { 'class': 'td', style: 'text-align:right', title: fmtRateBytes(num(dev.rx_rate)) + ' ↓ / ' + fmtRateBytes(num(dev.tx_rate)) + ' ↑' },
						'↓ ' + fmtRateBits(num(dev.rx_rate)))
				]);
			})))
		}

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Top 5 设备')),
			body,
			E('p', { style: 'margin-top:8px' }, E('a', {
				href: L.url('admin/services/traffic-stats/devices')
			}, _('查看全部设备 →')))
		]);
	},

	// ------------------------------------------------------------ 增量刷新

	/* 记录所有需要随刷新更新的文本节点 */
	cell: function(render, attrs) {
		var node = E('span', attrs || {}, '—');

		this.cells.push({ node: node, render: render });

		return node;
	},

	syncAll: function(state) {
		for (var i = 0; i < this.cells.length; i++) {
			try {
				this.cells[i].node.textContent = '' + this.cells[i].render(state);
			}
			catch (e) { }
		}

		if (this.updatedNode != null)
			this.updatedNode.textContent = _('更新于') + ' ' + fmtClock(Date.now() / 1000);

		this.updateStatusLine(state);
		this.updateHealth(state);
	},

	startRefresh: function() {
		if (this.timer != null) return;

		var self = this;

		this.timer = window.setInterval(function() {
			/* 离开页面后 #view 会被清空，这里顺便把定时器停掉，避免后台一直轮询 */
			if (self.root == null || !document.body.contains(self.root)) {
				self.stopRefresh();
				return;
			}

			callState().then(function(state) {
				if (state != null && typeof state == 'object' && state.totals != null) {
					self.state = state;
					self.syncAll(state);
				}
			}).catch(function() { });
		}, REFRESH_MS);
	},

	stopRefresh: function() {
		if (this.timer != null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
