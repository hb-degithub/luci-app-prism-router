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
 *   以及按类别（映射来自静态文件 traffic-stats/app-categories.json，只在进入页面时取一次）
 * 点行展开该域名在各设备上的用量 —— 这就是"下钻到设备"。
 *
 * 应用类别：app-categories.json 里按类别列出域名关键词，匹配规则是"域名包含关键词"
 * （大小写无关，子串命中），按 JSON 里的类别顺序取第一个命中的类别；都没命中归「其他」。
 * 映射文件取不到时本页降级为"不做类别统计"（类别列显示 —、表上方的占比条换成一句说明），
 * 域名排行与下钻不受影响。
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

// ---------------------------------------------------------------- 应用类别

/*
 * 类别映射来自静态文件 traffic-stats/app-categories.json（随 luci-app-traffic-stats 打包）：
 *   { "视频": ["youtube", ...], "社交": [...], ... }
 * 匹配：域名里包含任一关键词（大小写无关）即命中；按 JSON 里的类别顺序取第一个命中的类别；
 * 都没命中归「其他」。映射文件读不到时整页降级（不显示类别、不显示占比条），不报错、不空屏。
 */

var CATEGORY_FILE = 'traffic-stats/app-categories.json';
var CATEGORY_OTHER = '其他';

/* 类别配色：按 JSON 里的顺序取色，超出部分循环；「其他」固定灰 */
var CATEGORY_LOOK = [
	{ color: '#1e88e5', bg: 'rgba(30,136,229,.14)' },
	{ color: '#8e24aa', bg: 'rgba(142,36,170,.14)' },
	{ color: '#43a047', bg: 'rgba(67,160,71,.14)' },
	{ color: '#ef6c00', bg: 'rgba(239,108,0,.14)' },
	{ color: '#00838f', bg: 'rgba(0,131,143,.14)' },
	{ color: '#d81b60', bg: 'rgba(216,27,96,.14)' },
	{ color: '#6d4c41', bg: 'rgba(109,76,65,.16)' }
];
var CATEGORY_OTHER_LOOK = { color: '#757575', bg: 'rgba(127,127,127,.18)' };

/* 静态文件只取一次；取不到（404 / 老包 / 非浏览器环境）返回 null，由调用方降级 */
function loadCategories() {
	var url, fetcher;

	try {
		url = L.resource(CATEGORY_FILE);
	}
	catch (e) {
		url = null;
	}

	if (!url || typeof window == 'undefined' || typeof window.fetch != 'function')
		return Promise.resolve(null);

	fetcher = window.fetch;

	try {
		return fetcher.call(window, url, { credentials: 'same-origin' }).then(function(res) {
			if (res == null || res.ok !== true)
				throw new Error('HTTP ' + (res != null ? res.status : '?'));

			return res.json();
		}).then(function(raw) {
			return normalizeCategories(raw);
		}).catch(function() {
			/* 类别只是增强信息：失败不弹错、不阻断页面 */
			return null;
		});
	}
	catch (e) {
		return Promise.resolve(null);
	}
}

/* 校验并归一化映射：{ names: [...], rules: { 类别: [小写关键词...] } } */
function normalizeCategories(raw) {
	if (raw == null || typeof raw != 'object' || Array.isArray(raw))
		return null;

	var names = [], rules = {}, key, list, i, kw;

	for (key in raw) {
		if (!raw.hasOwnProperty(key)) continue;
		if (raw[key] == null || !Array.isArray(raw[key])) continue;

		list = [];

		for (i = 0; i < raw[key].length; i++) {
			kw = raw[key][i];

			if (typeof kw != 'string') continue;

			kw = kw.trim().toLowerCase();

			if (kw.length) list.push(kw);
		}

		if (list.length == 0) continue;

		names.push(key);
		rules[key] = list;
	}

	return (names.length > 0) ? { names: names, rules: rules } : null;
}

function categoryLook(cat, rules) {
	var idx = (rules != null) ? rules.names.indexOf(cat) : -1;

	if (cat == CATEGORY_OTHER || idx < 0) return CATEGORY_OTHER_LOOK;

	return CATEGORY_LOOK[idx % CATEGORY_LOOK.length];
}

/* 表上方的"按类别分布"（与总览页细堆叠条同一套视觉，纯内联样式 + 本页小段 style） */
var CSS = [
	'#ts-apps{font-size:13px}',
	'#ts-apps .tsa-catbar{margin:0 0 12px 0;padding:8px 11px;border-radius:9px;',
	'background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.18)}',
	'#ts-apps .tsa-catbar-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 6px 0;',
	'font-size:12px;font-weight:600}',
	'#ts-apps .tsa-catbar-n{font-size:10.5px;font-weight:400;opacity:.62;white-space:nowrap}',
	'#ts-apps .tsa-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:rgba(127,127,127,.2)}',
	'#ts-apps .tsa-bar i{display:block;height:100%;width:0}',
	'#ts-apps .tsa-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:7px;font-size:11.5px;line-height:1.7}',
	'#ts-apps .tsa-lg{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:inherit;',
	'text-decoration:none;border-bottom:1px dashed rgba(127,127,127,.45)}',
	'#ts-apps .tsa-lg i{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}',
	'#ts-apps .tsa-lg.on{font-weight:600;border-bottom-style:solid}',
	'#ts-apps .tsa-lg.off{opacity:.5}',
	'#ts-apps .tsa-cat{display:inline-block;font-size:10.5px;line-height:1.6;padding:0 6px;border-radius:5px;white-space:nowrap}'
].join('\n');

return view.extend({
	load: function() {
		var self = this;

		/* state（1 次 rpc）与类别映射（静态文件）并行取；类别失败不影响域名排行 */
		return Promise.all([
			callState().then(function(state) {
				self.state = (state != null && typeof state == 'object' && state.totals != null) ? state : null;
				self.error = null;
			}).catch(function(err) {
				self.state = null;
				self.error = (err != null && err.message) ? err.message : '' + err;
			}),
			loadCategories().then(function(rules) {
				self.categories = rules;
			})
		]);
	},

	render: function() {
		var state = this.state;

		if (state == null || !Array.isArray(state.apps))
			return E('div', {}, [
				E('h2', {}, _('流量统计 · 应用')),
				this.renderEmpty(state)
			]);

		this.filter = 'all';
		this.catFilter = 'all';
		this.catRules = (this.categories != null) ? this.categories : null;
		this.catCache = {};
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

		var catAttrs = {
			'class': 'cbi-input-select',
			change: L.bind(this.onCategoryChange, this),
			title: (this.catRules == null)
				? _('类别映射文件 app-categories.json 未加载，本页不做类别统计')
				: _('按类别筛选：只影响本页显示，不请求后端')
		};

		/* 映射没加载时把下拉禁用（不要禁用成 disabled="false"，那在老浏览器仍算禁用） */
		if (this.catRules == null) catAttrs.disabled = '';

		this.catSelect = E('select', catAttrs, this.categoryOptions());

		this.summaryWrap = E('div', {});
		this.tableWrap = E('div', {});

		var root = E('div', { 'id': 'ts-apps' }, [
			E('style', {}, CSS),
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
				E('label', { style: 'font-size:13px;margin-left:6px' }, _('类别')),
				this.catSelect,
				E('span', { style: 'font-size:12px;opacity:.7' },
					_('切换筛选不会重新请求后端；点行展开可下钻到设备'))
			]),
			this.summaryWrap,
			this.tableWrap
		]);

		this.refreshTables();

		return root;
	},

	/* 两个筛选都只改 DOM：重画占比条 + 表格，不产生 rpc */
	refreshTables: function() {
		if (this.summaryWrap != null)
			dom.content(this.summaryWrap, this.renderCategorySummary());

		if (this.tableWrap != null)
			dom.content(this.tableWrap, this.renderTable());
	},

	categoryOptions: function() {
		var opts = [ E('option', { value: 'all' }, _('全部类别')) ];
		var names = (this.catRules != null) ? this.catRules.names : [];

		for (var i = 0; i < names.length; i++)
			opts.push(E('option', { value: 'cat:' + names[i] }, names[i]));

		if (names.indexOf(CATEGORY_OTHER) < 0)
			opts.push(E('option', { value: 'cat:' + CATEGORY_OTHER }, _('其他')));

		return opts;
	},

	/* 域名 → 类别（大小写无关的子串命中，JSON 顺序优先；未命中归「其他」） */
	classify: function(host) {
		var key = (host == null) ? '' : ('' + host).toLowerCase();
		var hit = { name: '', keyword: '' };
		var i, j, name, kws, found;

		if (this.catCache != null && this.catCache[key] != null)
			return this.catCache[key];

		if (this.catRules != null) {
			for (i = 0; i < this.catRules.names.length && !hit.name; i++) {
				name = this.catRules.names[i];
				kws = this.catRules.rules[name] || [];
				found = null;

				for (j = 0; j < kws.length; j++) {
					if (key.indexOf(kws[j]) >= 0) {
						found = kws[j];
						break;
					}
				}

				if (found != null) hit = { name: name, keyword: found };
			}

			if (!hit.name) hit = { name: CATEGORY_OTHER, keyword: '' };
		}

		if (this.catCache != null) this.catCache[key] = hit;

		return hit;
	},

	catOf: function(host) {
		return this.classify(host).name;
	},

	matchCategory: function(host) {
		if (this.catFilter == 'all') return true;

		var want = (this.catFilter.indexOf('cat:') == 0) ? this.catFilter.substring(4) : '';

		return this.catOf(host) == want;
	},

	renderCategoryBadge: function(host) {
		var hit = this.classify(host);

		if (!hit.name)
			return E('span', { style: 'opacity:.45' }, '—');

		var look = categoryLook(hit.name, this.catRules);

		return E('span', {
			'class': 'tsa-cat',
			style: 'color:' + look.color + ';background:' + look.bg,
			title: hit.keyword
				? (_('按关键词') + ' "' + hit.keyword + '" ' + _('归入') + ' ' + hit.name)
				: _('没有命中任何类别关键词，归入') + ' ' + hit.name
		}, hit.name);
	},

	/*
	 * 表上方的「按类别分布」：一条横向堆叠占比条 + 图例（类别 / 域名数 / 占比 / 合计）。
	 * 统计口径跟随上面的出口筛选（代理/直连/节点），不跟随类别筛选本身 ——
	 * 否则一选类别，占比条就只剩 100% 一根，失去比较意义。
	 */
	renderCategorySummary: function() {
		var self = this;

		if (this.catRules == null)
			return E('div', { 'class': 'tsa-catbar' }, [
				E('div', { 'class': 'tsa-catbar-h' }, _('按类别分布')),
				E('div', { 'class': 'tsa-catbar-n' },
					_('类别映射文件 app-categories.json 未加载：本页不做类别统计，域名排行与下钻不受影响。'))
			]);

		var sums = {}, counts = {}, total = 0, shown = 0, i, app, cat, bytes;
		var order = this.catRules.names.slice();

		if (order.indexOf(CATEGORY_OTHER) < 0) order.push(CATEGORY_OTHER);

		for (i = 0; i < this.apps.length; i++) {
			app = this.apps[i];

			if (!this.matchChain(app.chain)) continue;

			cat = this.catOf(app.host);
			bytes = appTotal(app);

			sums[cat] = num(sums[cat]) + bytes;
			counts[cat] = num(counts[cat]) + 1;
			total += bytes;
			shown++;
		}

		var active = (this.catFilter.indexOf('cat:') == 0) ? this.catFilter.substring(4) : '';
		var segs = [], legend = [];

		/* 每个图例单独闭包（var cat 是函数作用域，直接在循环里闭包会全部取到最后一个） */
		function legendItem(cat, look, share, count) {
			return E('a', {
				'class': 'tsa-lg' + (active == cat ? ' on' : (active ? ' off' : '')),
				href: '#',
				title: _('只看') + ' ' + cat,
				click: function(ev) {
					ev.preventDefault();
					self.selectCategory(cat);
				}
			}, [
				E('i', { style: 'background:' + look.color }),
				E('span', {}, [
					cat + ' ',
					E('span', { style: 'opacity:.62' },
						count + ' ' + _('个') + ' · ' + share.toFixed(1) + '% · ' + fmtBytes(sums[cat]))
				])
			]);
		}

		for (i = 0; i < order.length; i++) {
			cat = order[i];

			if (!(num(sums[cat]) > 0)) continue;

			var look = categoryLook(cat, this.catRules);
			var share = (total > 0) ? (num(sums[cat]) * 100 / total) : 0;
			var dim = (active && active != cat) ? ';opacity:.35' : '';

			segs.push(E('i', {
				style: 'width:' + share.toFixed(2) + '%;background:' + look.color + dim,
				title: cat + ' · ' + fmtBytes(sums[cat]) + ' · ' + share.toFixed(1) + '%'
			}));

			legend.push(legendItem(cat, look, share, num(counts[cat])));
		}

		var head = [
			E('span', {}, _('按类别分布')),
			E('span', { 'class': 'tsa-catbar-n' },
				_('共') + ' ' + shown + ' ' + _('个域名') + ' · ' + fmtBytes(total) +
				(active ? ' · ' + _('已筛选') + '：' + active : ''))
		];

		if (segs.length == 0)
			return E('div', { 'class': 'tsa-catbar' }, [
				E('div', { 'class': 'tsa-catbar-h' }, head),
				E('div', { 'class': 'tsa-catbar-n' }, _('当前筛选条件下没有可统计的流量。'))
			]);

		return E('div', { 'class': 'tsa-catbar' }, [
			E('div', { 'class': 'tsa-catbar-h' }, head),
			E('div', { 'class': 'tsa-bar' }, segs),
			E('div', { 'class': 'tsa-legend' }, legend),
			E('div', { 'class': 'tsa-catbar-n', style: 'margin-top:6px' },
				_('点图例可只看某一类；「其他」= 没命中任何关键词的域名。'))
		]);
	},

	selectCategory: function(cat) {
		var value = (cat && cat.length) ? ('cat:' + cat) : 'all';

		this.catFilter = value;

		if (this.catSelect != null)
			this.catSelect.value = value;

		this.refreshTables();
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
		this.refreshTables();
	},

	onCategoryChange: function(ev) {
		this.catFilter = ev.currentTarget.value || 'all';
		this.refreshTables();
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

			if (this.matchChain(app.chain) && this.matchCategory(app.host))
				/* 同 devices.js：renderAppRow 返回 [主行, 详情行]，必须 concat 展开 */
				rows = rows.concat(this.renderAppRow(app));
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
							self.catFilter = 'all';
							if (self.filterSelect != null) self.filterSelect.value = 'all';
							if (self.catSelect != null) self.catSelect.value = 'all';
							self.refreshTables();
						}
					}, _('切换回"全部"'))
				])
			]);

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th', style: 'width:36px' }, '#'),
				E('th', { 'class': 'th' }, _('应用/域名')),
				E('th', { 'class': 'th' }, _('类别')),
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
			colspan: 9,
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
			E('td', { 'class': 'td' }, this.renderCategoryBadge(app.host)),
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
