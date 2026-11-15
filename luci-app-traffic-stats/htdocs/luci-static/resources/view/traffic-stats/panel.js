'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

/*
 * 详细面板（独立窗口）
 *
 * 设计意图：LuCI 页面只放"基础信息"，细节全部集中到这里，用新窗口打开（window.open），
 * 因此本页会隐藏 LuCI 侧栏与页面头部，让内容铺满整个视口。
 * 依赖：traffic-stats 的 get_state / get_history（与其它页面同一套 rpcd 接口）。
 */

var callState = rpc.declare({ object: 'traffic-stats', method: 'get_state', expect: {} });
var callHistory = rpc.declare({ object: 'traffic-stats', method: 'get_history', params: [ 'days' ], expect: {} });

var CHART_SRC = 'nlbw.chart.min.js';
var REFRESH_MS = 15000;

/* ---------------------------------------------------------------- 格式化 */

function num(v) {
	var n = Number(v);

	return isFinite(n) ? n : 0;
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

function fmtRate(v) {
	var n = num(v) * 8;

	if (n >= 1e9) return (n / 1e9).toFixed(2) + ' Gb/s';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mb/s';
	if (n >= 1e3) return (n / 1e3).toFixed(0) + ' kb/s';

	return Math.round(n) + ' b/s';
}

function fmtAgo(ts) {
	var d = Math.max(0, Math.floor(Date.now() / 1000) - num(ts));

	if (d < 60) return d + ' 秒前';
	if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
	if (d < 86400) return Math.floor(d / 3600) + ' 小时前';

	return Math.floor(d / 86400) + ' 天前';
}

function fmtClock(ts) {
	var d = new Date(num(ts) * 1000);
	var p = function (n) { return (n < 10 ? '0' : '') + n; };

	return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------------------------------------------------------------- 小组件 */

function card(title, body, extra) {
	return E('div', {
		style: 'background:var(--background-color-high,#fff);border:1px solid var(--border-color,#e5e7eb);' +
			'border-radius:10px;padding:16px 18px;min-width:0'
	}, [
		E('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px' }, [
			E('h3', { style: 'margin:0;font-size:15px;font-weight:600' }, title),
			extra || E('span')
		]),
		body
	]);
}

function kpi(label, value, sub, color) {
	return E('div', {
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

function table(head, rows, emptyText) {
	if (!rows.length)
		return E('div', { style: 'padding:24px 0;text-align:center;opacity:.55;font-size:13px' }, emptyText || '暂无数据');

	return E('table', { 'class': 'table', style: 'width:100%;font-size:13px' }, [
		E('tr', { 'class': 'tr table-titles' }, head.map(function (h) {
			return E('th', { 'class': 'th', style: h.right ? 'text-align:right' : '' }, h.label);
		}))
	].concat(rows));
}

/* ---------------------------------------------------------------- 页面 */


/* ------------------------------------------------------------------ *
 * 零依赖 SVG 折线渲染器
 *
 * 为什么不用 Chart.js：luci-lib-chartjs 里自带的是 nlbwmon 的精简构建，
 * Chart.prototype 上只有 Doughnut / Pie，没有 Line（实测会抛
 * "(intermediate value).Line is not a function"）。引外部 CDN 不可行，
 * 所以趋势图自己用 SVG 画，零依赖、可缩放、支持明暗主题（用半透明中性色）。
 * ------------------------------------------------------------------ */
function tsRenderLine(host, data, opts) {
	if (host == null) return null;

	var W = 900, H = 240, PL = 62, PR = 12, PT = 10, PB = 22;
	var labels = (data && data.labels) || [];
	var sets = ((data && data.datasets) || []).filter(function (s) { return s && s.data && s.data.length; });

	if (!labels.length || !sets.length) return null;

	var max = 0;
	sets.forEach(function (s) { s.data.forEach(function (v) { if (+v > max) max = +v; }); });
	if (!(max > 0)) max = 1;

	var n = labels.length;
	var fmtY = (opts && opts.fmtY) || function (v) { return Math.round(v) + ''; };
	var x = function (i) { return PL + (n === 1 ? 0 : (W - PL - PR) * i / (n - 1)); };
	var y = function (v) { return H - PB - (H - PT - PB) * (Math.max(0, +v) / max); };

	var out = [];
	var g, gy;

	for (g = 0; g <= 3; g++) {
		gy = PT + (H - PT - PB) * g / 3;
		out.push('<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) +
			'" stroke="rgba(127,127,127,.16)" stroke-width="1"/>');
		out.push('<text x="' + (PL - 6) + '" y="' + (gy + 3).toFixed(1) +
			'" font-size="10" fill="rgba(127,127,127,.85)" text-anchor="end">' + fmtY(max * (1 - g / 3)) + '</text>');
	}

	sets.forEach(function (s) {
		var d = s.data.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
		out.push('<path d="' + d + '" fill="none" stroke="' + (s.strokeColor || '#1a73e8') +
			'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>');
	});

	var step = Math.max(1, Math.ceil(n / 7));

	for (var i = 0; i < n; i += step)
		out.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) +
			'" font-size="10" fill="rgba(127,127,127,.85)" text-anchor="middle">' + labels[i] + '</text>');

	var legend = sets.map(function (s) {
		return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px">' +
			'<i style="width:10px;height:3px;border-radius:2px;background:' + (s.strokeColor || '#1a73e8') + ';display:inline-block"></i>' +
			(s.label || '') + '</span>';
	}).join('');

	host.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column">' +
		'<div style="flex:1;min-height:0"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
		'style="width:100%;height:100%;display:block">' + out.join('') + '</svg></div>' +
		'<div style="font-size:11px;opacity:.75;padding:6px 0 0 46px">' + legend + '</div></div>';

	return { destroy: function () { try { host.innerHTML = ''; } catch (e) { } } };
}

return view.extend({
	load: function () {
		return Promise.all([
			callState().catch(function () { return null; }),
			callHistory(1).catch(function () { return null; })
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
			'.main-bg{display:none!important}'
		].join('\n');

		document.head.appendChild(E('style', { id: 'ts-panel-fs' }, css));
	},

	render: function (data) {
		var self = this;

		this.applyFullscreen();

		this.state = data[0];
		this.history = data[1];
		this.root = E('div', { style: 'max-width:1680px;margin:0 auto' }, '');

		var self0 = this;

		this.rebuild = function () {
		var st = self0.state || {};
		var totals = st.totals || {};
		var health = st.health || {};

		self0.chartNode = E('div', { style: 'height:240px;position:relative' }, '');

		return E('div', {}, [
			/* 顶栏 */
			E('div', {
				style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap'
			}, [
				E('h2', { style: 'margin:0;font-size:20px' }, _('流量详细面板')),
				E('span', {
					style: 'font-size:12px;padding:2px 8px;border-radius:10px;background:' +
						(health.accounting_confidence === 'exact' ? '#e6f4ea;color:#137333' : '#fce8e6;color:#c5221f')
				}, health.accounting_confidence === 'exact' ? _('记账精确') : (health.accounting_confidence || _('未知'))),
				E('span', { style: 'font-size:12px;opacity:.6' }, _('更新于') + ' ' + fmtClock(st.ts || 0)),
				E('span', { style: 'flex:1' }, ''),
				E('button', {
					'class': 'cbi-button',
					click: ui.createHandlerFn(this, this.refreshNow)
				}, _('刷新')),
				E('button', {
					'class': 'cbi-button',
					click: function () { window.close(); }
				}, _('关闭'))
			]),

			/* KPI 行 */
			E('div', {
				style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px'
			}, [
				kpi(_('总流量'), fmtBytes(num(totals.direct_rx) + num(totals.direct_tx) + num(totals.proxy_rx) + num(totals.proxy_tx)),
					_('下载') + ' ' + fmtBytes(num(totals.direct_rx) + num(totals.proxy_rx))),
				kpi(_('实时速率'), fmtRate(num(totals.rx_rate)), '↓ ' + fmtRate(num(totals.rx_rate)) + '  ↑ ' + fmtRate(num(totals.tx_rate))),
				kpi(_('代理流量'), fmtBytes(num(totals.proxy_rx) + num(totals.proxy_tx)),
					'↓ ' + fmtBytes(num(totals.proxy_rx)) + '  ↑ ' + fmtBytes(num(totals.proxy_tx)), '#1a73e8'),
				kpi(_('直连流量'), fmtBytes(num(totals.direct_rx) + num(totals.direct_tx)),
					'↓ ' + fmtBytes(num(totals.direct_rx)) + '  ↑ ' + fmtBytes(num(totals.direct_tx)), '#34a853'),
				kpi(_('无线接入'), totals.wifi_rx != null ? fmtBytes(num(totals.wifi_rx) + num(totals.wifi_tx)) : '-',
					totals.wifi_rx != null ? ('↓ ' + fmtBytes(num(totals.wifi_rx)) + '  ↑ ' + fmtBytes(num(totals.wifi_tx))) : _('未采集'), '#a142f4'),
				kpi(_('有线接入'), totals.wired_rx != null ? fmtBytes(num(totals.wired_rx) + num(totals.wired_tx)) : '-',
					totals.wired_rx != null ? ('↓ ' + fmtBytes(num(totals.wired_rx)) + '  ↑ ' + fmtBytes(num(totals.wired_tx))) : _('未采集'), '#f9ab00')
			]),

			/* 趋势 + 比例 */
			E('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:14px' }, [
				card(_('流量趋势（近 24 小时 · 5 分钟桶）'), this.chartNode,
					E('span', { style: 'font-size:12px;opacity:.6' }, _('总 / 代理 / 直连'))),
				card(_('构成比例'), E('div', {}, [
					E('div', { style: 'font-size:12px;opacity:.65;margin-bottom:8px' }, _('代理 vs 直连')),
					splitBar([
						{ label: _('代理'), value: num(totals.proxy_rx) + num(totals.proxy_tx), color: '#1a73e8' },
						{ label: _('直连'), value: num(totals.direct_rx) + num(totals.direct_tx), color: '#34a853' }
					]),
					E('div', { style: 'font-size:12px;opacity:.65;margin:16px 0 8px' }, _('无线 vs 有线')),
					totals.wifi_rx != null ? splitBar([
						{ label: _('无线'), value: num(totals.wifi_rx) + num(totals.wifi_tx), color: '#a142f4' },
						{ label: _('有线'), value: num(totals.wired_rx) + num(totals.wired_tx), color: '#f9ab00' },
						{ label: _('未知'), value: num(totals.unknown_rx) + num(totals.unknown_tx), color: '#9aa0a6' }
					]) : E('div', { style: 'opacity:.55;font-size:12px' }, _('未启用接入方式判定'))
				]))
			]),

			/* Top 设备 / Top 应用 */
			E('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' }, [
				card(_('Top 10 设备'), this.renderDeviceTable()),
				card(_('Top 10 应用 / 域名'), this.renderAppTable())
			])
		]);
		};

		dom.content(this.root, this.rebuild());
		this.loadChartLib().then(function () { self0.drawChart(); });
		this.scheduleRefresh();

		return this.root;
	},

	renderDeviceTable: function () {
		var st = this.state || {};
		var list = (st.devices || []).slice().sort(function (a, b) {
			return (num(b.direct_rx) + num(b.proxy_rx)) - (num(a.direct_rx) + num(a.proxy_rx));
		}).slice(0, 10);

		var rows = list.map(function (d) {
			var name = d.hostname || d.ip || '-';
			var total = num(d.direct_rx) + num(d.proxy_rx) + num(d.direct_tx) + num(d.proxy_tx);
			var linkMap = { wifi: [ _('无线'), '#a142f4' ], wired: [ _('有线'), '#f9ab00' ] };
			var lk = linkMap[d.link] || [ _('未知'), '#9aa0a6' ];

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
					E('strong', {}, name)),
				E('td', { 'class': 'td' }, E('span', {
					style: 'font-size:11px;padding:1px 6px;border-radius:4px;color:' + lk[1] + ';background:' + lk[1] + '1a'
				}, lk[0])),
				E('td', { 'class': 'td', style: 'text-align:right;color:#1a73e8' }, fmtBytes(num(d.proxy_rx) + num(d.proxy_tx))),
				E('td', { 'class': 'td', style: 'text-align:right;color:#34a853' }, fmtBytes(num(d.direct_rx) + num(d.direct_tx))),
				E('td', { 'class': 'td', style: 'text-align:right' }, E('strong', {}, fmtBytes(total)))
			]);
		});

		return table([
			{ label: _('设备') }, { label: _('接入') },
			{ label: _('代理'), right: true }, { label: _('直连'), right: true }, { label: _('合计'), right: true }
		], rows, _('暂无设备数据'));
	},

	renderAppTable: function () {
		var st = this.state || {};
		var list = (st.apps || []).slice().sort(function (a, b) {
			return (num(b.rx) + num(b.tx)) - (num(a.rx) + num(a.tx));
		}).slice(0, 10);

		var rows = list.map(function (a) {
			var isDirect = (a.chain === 'DIRECT');

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', style: 'max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: a.host },
					a.host || '-'),
				E('td', { 'class': 'td' }, E('span', {
					style: 'font-size:11px;padding:1px 6px;border-radius:4px;color:' + (isDirect ? '#34a853' : '#1a73e8') +
						';background:' + (isDirect ? '#e6f4ea' : '#e8f0fe')
				}, isDirect ? _('直连') : (a.chain || _('代理')))),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(num(a.rx) + num(a.tx))),
				E('td', { 'class': 'td', style: 'text-align:right;opacity:.7' }, num(a.devices) || 1)
			]);
		});

		return table([
			{ label: _('域名 / 应用') }, { label: _('路径') },
			{ label: _('流量'), right: true }, { label: _('设备数'), right: true }
		], rows, _('暂无应用数据'));
	},

	/* ------------------------------------------------------------ 趋势图 */

	loadChartLib: function () {
		var self = this;

		if (typeof window.Chart !== 'undefined')
			return Promise.resolve(true);

		return new Promise(function (resolve) {
			var s = E('script', {
				src: L.resource(CHART_SRC),
				load: function () { resolve(typeof window.Chart !== 'undefined'); },
				error: function () { resolve(false); }
			});

			document.head.appendChild(s);
			setTimeout(function () { resolve(typeof window.Chart !== 'undefined'); }, 4000);
		});
	},

	drawChart: function () {
		var self = this;
		var canvas = E('canvas', { width: 900, height: 220 }, '');

		dom.content(this.chartNode, canvas);

		var buckets = [];

		try {
			var days = (this.history && this.history.days) || [];

			days.forEach(function (d) { (d.buckets || []).forEach(function (b) { buckets.push(b); }); });
		}
		catch (e) { buckets = []; }

		if (!buckets.length) {
			dom.content(this.chartNode, E('div', {
				style: 'height:100%;display:flex;align-items:center;justify-content:center;opacity:.55;font-size:13px'
			}, _('暂无历史数据（history.json 为空或守护进程刚启动）')));
			return;
		}

		buckets.sort(function (a, b) { return num(a.ts) - num(b.ts); });

		var labels = buckets.map(function (b) {
			var d = new Date(num(b.ts) * 1000);
			var p = function (n) { return (n < 10 ? '0' : '') + n; };

			return p(d.getHours()) + ':' + p(d.getMinutes());
		});

		var series = function (label, color, pick) {
			return {
				label: label,
				fillColor: 'rgba(0,0,0,0)',
				strokeColor: color,
				pointColor: color,
				pointStrokeColor: '#fff',
				data: buckets.map(function (b) {
					return Math.round((num(pick(b, 'rx')) + num(pick(b, 'tx'))) / 1024);
				})
			};
		};

		var data = {
			labels: labels,
			datasets: [
				series(_('总'), '#3949ab', function (b, k) {
					return (num(b.direct_rx) + num(b.proxy_rx)) * (k === 'rx' ? 1 : 0) +
						(num(b.direct_tx) + num(b.proxy_tx)) * (k === 'tx' ? 1 : 0);
				}),
				series(_('代理'), '#1a73e8', function (b, k) { return k === 'rx' ? b.proxy_rx : b.proxy_tx; }),
				series(_('直连'), '#34a853', function (b, k) { return k === 'rx' ? b.direct_rx : b.direct_tx; })
			]
		};

		var opts = {
			animation: false,
			scaleBeginAtZero: true,
			scaleShowGridLines: true,
			scaleGridLineColor: 'rgba(0,0,0,.06)',
			bezierCurve: false,
			pointDot: false,
			datasetFill: false,
			multiTooltipTemplate: '<%=datasetLabel%>: <%=value%> KiB'
		};

		try {
			tsRenderLine(self.chartNode, data, { fmtY: function (v) { return fmtBytes(v * 1024, 0); } });
		}
		catch (e) {
			dom.content(this.chartNode, E('div', { style: 'opacity:.6;font-size:12px' }, _('图表绘制失败：') + e));
		}
	},

	/* ------------------------------------------------------------ 刷新 */

	refreshNow: function () {
		var self = this;

		return Promise.all([
			callState().catch(function () { return null; }),
			callHistory(1).catch(function () { return null; })
		]).then(function (d) {
			self.state = d[0];
			self.history = d[1];
			dom.content(self.root, self.rebuild());
			self.drawChart();
		});
	},

	scheduleRefresh: function () {
		var self = this;

		var tick = function () {
			if (document.hidden) {
				self.timer = setTimeout(tick, REFRESH_MS);
				return;
			}

			self.refreshNow();
			self.timer = setTimeout(tick, REFRESH_MS);
		};

		this.timer = setTimeout(tick, REFRESH_MS);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
