'use strict';
'require view';
'require dom';
'require rpc';
'require ui';
'require prism-router/theme as theme';

/*
 * 棱镜路由 · 应用（域名）
 *
 * 按商用路由器 App 的逻辑组织「应用」页：
 *
 *   1. 顶部时间范围：今日（默认）/ 近 7 天。切换只重算并重绘榜单，不整页重载。
 *      - 今日：state.apps（get_state，进程启动以来累计，页面必须标明口径），
 *        并用 get_history(1) 的今日 5 分钟桶总量做"今日增量"参考提示（口径不同，分开标注）。
 *      - 近 7 天：get_history(7) 拿每天汇总，再逐天 get_daily 取 daily 应用汇总，按域名相加。
 *        历史只有日粒度（每天一个文件、最多 50 个域名、不含设备明细），数据不足时
 *        页面明确写出「历史仅提供日粒度」，只展示可得部分，不编造数字。
 *
 *   2. 类别概览卡（映射来自静态文件 prism-router/app-categories.json，进入页面取一次）：
 *      每类显示总量、占比条、条数；点击只看该类并高亮，再点取消；与文本搜索、出口筛选叠加。
 *
 *   3. 榜单：表头点「下载 / 上传 / 合计 / 设备数」排序（默认合计降序，箭头指示方向）；
 *      点击应用行展开该应用的设备分布（state.devices.apps 反查，最多 10 台，
 *      设备名可跳设备页），今日口径才有设备维度，近 7 天明确说明日粒度无明细。
 *
 *   4. 空态 / 筛选后无结果 / history 请求失败三种情况各有清晰文案；
 *      请求失败保留已有列表，只在上方提示。
 *
 *   5. 顶栏：最后更新时间 + 自动刷新开关（15s，默认开；关掉停止轮询，
 *      切时间范围与手动刷新仍会更新数据）。
 *
 * 全部 DOM 只用 E() / textContent 构造，不拼 HTML 字符串、不引外部资源/图表库。
 *
 * 导出（SPEC §10.3）：`export_csv {what:'apps'}` 返回带 BOM/CRLF 的 CSV，
 * 前端只负责存盘，不再补 BOM；失败时在按钮旁给出文字错误。
 * 单位：流量二进制（GiB/MiB），速率不出现在本页。
 */

var callState = rpc.declare({
	object: 'prism-router',
	method: 'get_state',
	expect: {},
	reject: true
});

/* 只有切到「近 7 天」时才请求；失败降级成提示，不清空已有列表。 */
var callHistory = rpc.declare({
	object: 'prism-router',
	method: 'get_history',
	params: [ 'days' ],
	expect: {},
	reject: true
});

/* 近 7 天：逐天取 daily 文件里的应用汇总（后端只在 get_daily 下发 apps[]）。 */
var callDaily = rpc.declare({
	object: 'prism-router',
	method: 'get_daily',
	params: [ 'day' ],
	expect: {},
	reject: true
});

var callExportCsv = rpc.declare({
	object: 'prism-router',
	method: 'export_csv',
	params: [ 'what' ],
	expect: {}
});

var REFRESH_MS = 15000;         /* 自动刷新节奏（与概览/面板页一致） */
var HIST_REFRESH_MS = 60000;    /* 近 7 天是日粒度，报文也更大：自动刷新降到 60s 一次 */
var HIST_TIMEOUT_MS = 15000;    /* get_history 可能撑爆 ubus，给一个明确超时点 */
var DAILY_TIMEOUT_MS = 10000;   /* 单天 daily 读取超时 */
var MAX_DRILL_DEVICES = 10;     /* 展开后最多列 10 台设备 */
var WEEK_DAYS = 7;

var RANGE_TODAY = 'today';
var RANGE_WEEK = '7d';

/* 分段的时间范围。以后扩 30 天只需在这里加一项，并在 fetchHistory 里带上对应天数。 */
var RANGES = [
	{ key: RANGE_TODAY, label: '今日' },
	{ key: RANGE_WEEK, label: '近 7 天' }
];

var SORT_DEFAULT = 'total';
var SORT_KEYS = [ 'rx', 'tx', 'total', 'devices' ];

var DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/* ---------------------------------------------------------------- 小工具 */

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
	return (n < 10) ? ('0' + n) : ('' + n);
}

function fmtClock(date) {
	var d = (date instanceof Date) ? date : new Date(num(date));

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function fmtDuration(sec) {
	var s = num(sec);

	if (s <= 0) return '0 ' + _('秒');
	if (s < 60) return Math.round(s) + ' ' + _('秒');
	if (s < 3600) return Math.floor(s / 60) + ' ' + _('分');
	if (s < 86400) {
		var h = Math.floor(s / 3600);
		var m = Math.floor((s % 3600) / 60);

		return h + ' ' + _('小时') + (m > 0 ? ' ' + m + ' ' + _('分') : '');
	}

	return Math.floor(s / 86400) + ' ' + _('天');
}

function todayKey() {
	var d = new Date();

	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
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

function errText(e) {
	if (e == null) return _('未知错误');
	if (typeof e === 'string') return (e.length ? e : _('未知错误'));
	if (e.message) return '' + e.message;

	try { return '' + e; }
	catch (x) { return _('未知错误'); }
}

function chainBadge(chain) {
	var name = (chain && ('' + chain).length) ? ('' + chain) : '—';

	return E('span', {
		style: 'font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap;background:' +
			(name == 'DIRECT' ? 'rgba(15,118,110,.16)' : 'rgba(59,130,246,.16)')
	}, name);
}

/* 清空并重挂子节点：只重绘局部容器，不整页重载（只用 DOM 节点接口）。 */
function replaceChildren(node, kids) {
	if (node == null) return;

	while (node.firstChild) node.removeChild(node.firstChild);

	if (kids == null) return;

	for (var i = 0; i < kids.length; i++)
		if (kids[i] != null) node.appendChild(kids[i]);
}

/* 分段 / 筛选小药丸按钮（与历史页同一套视觉） */
function chipStyle(active, color) {
	/*
	 * 选中态用“浅底 + 加深方向色文字”，避免白字压在品牌蓝上（3.7:1 不达正文标准），
	 * 也和 overview/devices 的分段控件保持同一套状态语义。
	 */
	return 'font-size:12px;line-height:1.2;padding:5px 12px;border-radius:14px;cursor:pointer;' +
		'border:1px solid ' + (active ? (color || 'var(--ts-down)') : 'var(--ts-border)') + ';' +
		'background:' + (active ? 'rgba(59,130,246,.12)' : 'transparent') + ';' +
		'color:' + (active ? 'var(--ts-down-text)' : 'inherit') + ';' +
		(active ? 'font-weight:600;' : '');
}

function chip(label, active, color, onclick) {
	return E('button', {
		'type': 'button',
		'class': 'cbi-button',
		style: chipStyle(active, color),
		click: onclick
	}, label);
}

// ---------------------------------------------------------------- 应用类别

/*
 * 类别映射来自静态文件 prism-router/app-categories.json（随 luci-app-prism-router 打包）：
 *   { "视频": ["youtube", ...], "社交": [...], ... }
 * 匹配：域名里包含任一关键词（大小写无关）即命中；按 JSON 里的类别顺序取第一个命中的类别；
 * 都没命中归「其他」。映射文件读不到时整页降级（不显示类别卡与类别列），不报错、不空屏。
 */

var CATEGORY_FILE = 'prism-router/app-categories.json';
var CATEGORY_OTHER = '其他';

/* 类别概览卡的展示顺序（JSON 里没有的会自动跳过，JSON 里多出来的按原顺序追加）。 */
var CARD_ORDER = [ '视频', '游戏', '社交', '下载', '开发', '购物', '系统' ];

/* 类别配色：按 JSON 里的顺序取色，超出部分循环；「其他」固定灰 */
var CATEGORY_LOOK = [
	{ color: '#1565c0', bg: 'rgba(21,101,192,.14)' },
	{ color: '#8e24aa', bg: 'rgba(142,36,170,.14)' },
	{ color: '#00695c', bg: 'rgba(0,105,92,.14)' },
	{ color: '#5e35b1', bg: 'rgba(94,53,177,.14)' },
	{ color: '#3949ab', bg: 'rgba(57,73,171,.14)' },
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

// ---------------------------------------------------------------- 历史日汇总

/* 一天的总字节数：优先 summary.totals，其次当天 5 分钟桶累加（口径与后端一致）。 */
function sumDayHistory(day) {
	if (day == null || typeof day !== 'object') return 0;

	var t = (day.summary != null && day.summary.totals != null) ? day.summary.totals : day.totals;
	var i, b, sum, d;

	if (t != null && typeof t === 'object') {
		d = num(t.direct_rx) + num(t.direct_tx) + num(t.proxy_rx) + num(t.proxy_tx);

		if (d > 0 || t.rx != null || t.tx != null)
			return (d > 0) ? d : (num(t.rx) + num(t.tx));
	}

	if (Array.isArray(day.buckets)) {
		sum = 0;

		for (i = 0; i < day.buckets.length; i++) {
			b = day.buckets[i];

			if (b == null || typeof b !== 'object') continue;

			if (b.direct_rx != null || b.proxy_rx != null)
				sum += num(b.direct_rx) + num(b.direct_tx) + num(b.proxy_rx) + num(b.proxy_tx);
			else
				sum += num(b.rx) + num(b.tx);
		}

		return sum;
	}

	return 0;
}

/* get_history(1) → 今日桶合计（只作参考提示；失败或为 0 时返回 null） */
function todayHistory(res) {
	if (res == null || !Array.isArray(res.days) || res.days.length == 0) return null;

	var key = todayKey();
	var found = null, i, bytes;

	for (i = 0; i < res.days.length; i++) {
		if (res.days[i] != null && res.days[i].day === key) {
			found = res.days[i];
			break;
		}
	}

	if (found == null) found = res.days[0];

	bytes = sumDayHistory(found);

	if (bytes <= 0) return null;

	return { day: (found.day || key), bytes: bytes };
}

/* 近 7 天：把每天 daily.apps[] 汇总成按域名的列表（dialog 里不再出现设备维度）。 */
function weekAppsFrom(byHost) {
	var out = [], total = 0, host, item, chains, name;

	for (host in byHost) {
		if (!byHost.hasOwnProperty(host)) continue;

		item = byHost[host];
		chains = [];

		for (name in item.chains)
			if (item.chains.hasOwnProperty(name)) chains.push(name);

		chains.sort();

		out.push({
			host: host,
			rx: item.rx,
			tx: item.tx,
			chain: (chains.length === 1) ? chains[0] : '',
			chains: chains,
			devices: item.devicesMax,
			days: item.days,
			source: 'daily'
		});

		total += item.rx + item.tx;
	}

	return { apps: out, total: total };
}

/* 表上方的"按类别分布"与页面小件样式（纯内联样式 + 本页小段 style，不引外部资源） */
var CSS = [
	'#ts-apps{font-size:var(--ts-fs-2);max-width:100%;min-width:0}',
	'#ts-apps .tsa-range{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px 0}',
	'#ts-apps .tsa-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}',
	'#ts-apps .tsa-toolbar label{font-size:var(--ts-fs-1)}',
	'#ts-apps .tsa-hint{font-size:var(--ts-fs-1);color:var(--ts-text-3)}',
	'#ts-apps .tsa-upd{font-size:var(--ts-fs-1);color:var(--ts-text-2);white-space:nowrap}',
	'#ts-apps .tsa-note{margin:0 0 12px 0;padding:0;border-radius:var(--ts-r);background:var(--ts-surface);',
	'border:1px solid var(--ts-border);font-size:var(--ts-fs-1);line-height:1.7;min-width:0}',
	'#ts-apps .tsa-fold>summary{display:flex;align-items:center;gap:6px;padding:8px 11px;cursor:pointer;',
	'list-style:none;font-weight:600;font-size:var(--ts-fs-1)}',
	'#ts-apps .tsa-fold>summary::-webkit-details-marker{display:none}',
	'#ts-apps .tsa-fold>summary::before{content:"▸";flex:none;color:var(--ts-text-3);transition:transform .15s}',
	'#ts-apps .tsa-fold[open]>summary::before{transform:rotate(90deg)}',
	'#ts-apps .tsa-fold[open]>summary{border-bottom:1px solid var(--ts-border)}',
	'#ts-apps .tsa-fold-b{padding:8px 11px 10px;overflow-wrap:anywhere}',
	'#ts-apps .tsa-cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px;margin:0 0 12px 0}',
	'#ts-apps .tsa-card{padding:8px 10px;border-radius:var(--ts-r);border:1px solid var(--ts-border);',
	'background:var(--ts-surface);transition:opacity .15s,border-color .15s;min-width:0}',
	'#ts-apps .tsa-card.off{opacity:.55}',
	'#ts-apps .tsa-cat{display:inline-block;font-size:12px;line-height:1.6;padding:0 6px;border-radius:var(--ts-r-sm);white-space:nowrap}',
	'#ts-apps .tsa-sort{cursor:pointer;user-select:none;white-space:nowrap}',
	'#ts-apps .tsa-sort:hover{background:var(--ts-surface-2)}',
	'#ts-apps .tsa-arrow{font-size:12px;opacity:.75}',
	'#ts-apps .tsa-export{font-size:12px;color:var(--ts-text-2);min-width:0;overflow-wrap:anywhere}',
	'#ts-apps .tsa-filterline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px 0;font-size:12px}',
	'#ts-apps .tsa-filterline label{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}',
	'#ts-apps .tsa-count{margin:0 0 8px 0;font-size:12px;color:var(--ts-text-2)}',
	'#ts-apps .tsa-scrollhint{display:none;margin:0 0 6px;color:var(--ts-text-3);font-size:12px}',
	'#ts-apps .tsa-empty{padding:12px 14px;margin:0 0 10px 0}',
	'#ts-apps .tsa-empty p{margin:4px 0}',
	'#ts-apps .tsa-foot{margin:14px 0 0 0;font-size:12px;color:var(--ts-text-3);line-height:1.6}',
	'#ts-apps .tsa-tablewrap{max-width:100%;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch}',
	'#ts-apps .tsa-table{min-width:720px;display:block}',
	'#ts-apps .tsa-table .tr{display:flex;flex-wrap:nowrap;min-width:720px;width:100%;box-sizing:border-box}',
	'#ts-apps .tsa-table .th,#ts-apps .tsa-table .td{flex:1 1 0;min-width:0;box-sizing:border-box;font-size:12px;vertical-align:middle}',
	'#ts-apps .tsa-table .tsa-col-rank{flex:0 0 34px}',
	'#ts-apps .tsa-table .tsa-col-host{flex:0 0 190px;overflow-wrap:anywhere;word-break:break-word}',
	'#ts-apps .tsa-table .tsa-col-chain{flex:0 0 100px}',
	'#ts-apps .tsa-table .tsa-col-count{flex:0 0 60px}',
	'#ts-apps .tsa-table .tsa-col-bytes{flex:0 0 94px;white-space:nowrap}',
	'#ts-apps .tsa-table .td{overflow-wrap:anywhere}',
	'@media (max-width:760px){',
	'#ts-apps .tsa-cats{grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}',
	'#ts-apps .tsa-table{min-width:670px}',
	'#ts-apps .tsa-table .tr{min-width:670px}',
	'#ts-apps .tsa-col-meta{display:none}',
	'#ts-apps .tsa-toolbar{gap:6px}',
	'#ts-apps .tsa-toolbar input[type=search],#ts-apps .tsa-toolbar input[type=text]{flex:1 1 100%;min-width:0}',
	'}',
	'@media (max-width:420px){',
	'#ts-apps .tsa-cats{grid-template-columns:repeat(2,minmax(0,1fr))}',
	'#ts-apps .tsa-table{min-width:670px}',
	'#ts-apps .tsa-table .tr{min-width:670px}',
	'#ts-apps .tsa-scrollhint{display:block}',
	'}'
].join('\n');

return view.extend({
	/*
	 * 概览页「Top 应用」链接带 #host=<域名>：渲染后填入搜索框并过滤，
	 * 然后清掉 hash，避免刷新/切回时重复触发。
	 */
	applyHashTarget: function() {
		var self = this;
		var hash = (typeof window != 'undefined' && window.location != null)
			? ('' + (window.location.hash || '')) : '';
		var m = /^#host=(.+)$/.exec(hash);

		if (m == null) return;

		var host = '';

		try { host = decodeURIComponent(m[1]); } catch (e) { host = m[1]; }

		host = ('' + host).trim();

		if (host.length === 0) return;

		window.setTimeout(function() {
			self.setSearch(host);
			try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { }
		}, 0);
	},

	load: function() {
		var self = this;

		/* state（1 次 rpc）与类别映射（静态文件）并行取；类别失败不影响域名排行。
		   今日桶提示来自 get_history(1)，失败只隐藏提示，不影响页面。 */
		return Promise.all([
			callState().then(function(state) {
				self.state = (state != null && typeof state == 'object' && state.totals != null) ? state : null;
				self.error = null;
			}).catch(function(err) {
				self.state = null;
				self.error = errText(err);
			}),
			loadCategories().then(function(rules) {
				self.categories = rules;
			}),
			callHistory(1).then(function(res) {
				self.todayHist = todayHistory(res);
			}).catch(function() {
				self.todayHist = null;
			})
		]);
	},

	render: function() {
		var self = this;

		this.stopAutoRefresh();

		var state = this.state;

		if (state == null || !Array.isArray(state.apps))
			return E('div', { 'id': 'ts-apps', 'class': theme.CLASS }, [
				theme.style(),
				E('style', {}, CSS),
				E('h2', { 'class': 'ts-title' }, _('棱镜路由 · 应用')),
				this.renderEmpty(state)
			]);

		/* 每次进页面都从默认态开始：今日 / 合计降序 / 无筛选 / 自动刷新开 */
		this.range = RANGE_TODAY;
		this.sortKey = SORT_DEFAULT;
		this.sortDesc = true;
		this.search = '';
		this.catFilter = 'all';
		this.filter = 'all';
		this.expanded = {};
		this.catRules = (this.categories != null) ? this.categories : null;
		this.catCache = {};
		this.datasets = {};
		this.datasets[RANGE_TODAY] = this.buildTodayData(state);
		this.refreshError = '';
		this.histError = '';
		this.histPending = false;
		this.refreshPending = false;
		this.autoRefresh = true;
		this.timer = null;
		this.unloadFn = null;
		this.lastUpdateAt = this.datasets[RANGE_TODAY].at;
		this.lastHistAt = null;

		/* 首屏直接带上内容（不是空壳等重绘）；之后的筛选/排序/刷新只重绘这些容器 */
		this.rangeWrap = E('div', { 'class': 'tsa-range' }, this.renderRangeChips());
		this.noticeWrap = E('div', {}, this.renderNotice());
		this.scopeWrap = E('div', {}, this.renderScope());
		this.catWrap = E('div', {}, this.renderCategoryCards());
		this.filterWrap = E('div', {}, this.renderFilterLine());
		this.countEl = E('p', { 'class': 'tsa-count' }, this.countLine());
		this.listWrap = E('div', {}, this.renderList());
		this.lastUpdateEl = E('span', { 'class': 'tsa-upd' }, this.lastUpdateText());

		this.autoInput = E('input', {
			'id': 'tsa-auto-refresh',
			'class': 'cbi-input-checkbox',
			'type': 'checkbox',
			change: function(ev) {
				self.setAutoRefresh(ev.currentTarget.checked === true);
			}
		});
		this.autoInput.checked = true;

		this.searchInput = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'placeholder': _('搜索域名，例如 youtube'),
			style: 'min-width:180px;flex:1 1 180px;max-width:280px',
			input: function(ev) { self.onSearch(ev); }
		});

		this.filterSelect = E('select', {
			'id': 'tsa-chain-filter',
			'class': 'cbi-input-select',
			change: function(ev) { self.setChain(ev.currentTarget.value || 'all'); }
		}, this.chainOptions(state));

		this.exportStatus = E('span', { 'class': 'tsa-export' }, '');
		this.exportBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			click: ui.createHandlerFn(this, function() { return this.exportCsv('apps'); })
		}, _('导出应用 CSV'));

		this.refreshBtn = E('button', {
			'class': 'cbi-button',
			click: function(ev) {
				if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
				self.manualRefresh();
			}
		}, _('刷新'));

		var toolbar = E('div', { 'class': 'tsa-toolbar' }, [
			this.searchInput,
			E('label', { 'for': 'tsa-chain-filter' }, _('出口')),
			this.filterSelect,
			this.refreshBtn,
			this.exportBtn,
			E('label', {
				'for': 'tsa-auto-refresh',
				style: 'display:inline-flex;align-items:center;gap:4px'
			}, [
				this.autoInput,
				E('span', {}, _('自动刷新')),
				E('span', { 'class': 'tsa-hint' }, _('15s'))
			]),
			this.lastUpdateEl,
			this.exportStatus
		]);

		this.root = E('div', { 'id': 'ts-apps', 'class': theme.CLASS }, [
			theme.style(),
			E('style', {}, CSS),
			E('h2', { 'class': 'ts-title' }, _('棱镜路由 · 应用')),
			this.rangeWrap,
			toolbar,
			this.noticeWrap,
			this.scopeWrap,
			this.catWrap,
			this.filterWrap,
			this.countEl,
			this.listWrap,
			E('p', { 'class': 'tsa-foot' },
				_('数据来自 prism-routerd 的 get_state / get_history / get_daily；时间范围、类别、搜索与排序都在前端完成，切换不重新加载页面。'))
		]);

		this.exportBtn.title = (this.range === RANGE_WEEK)
			? _('后端导出的是进程启动以来的累计应用列表，不含近 7 天日粒度聚合')
			: _('导出应用列表（进程启动以来累计）');
		this.startAutoRefresh();

		this.applyHashTarget();

		return this.root;
	},

	// ------------------------------------------------------------ 数据构建

	buildTodayData: function(state) {
		var list = [], total = 0, i, app, chain;

		for (i = 0; i < state.apps.length; i++) {
			app = state.apps[i];

			if (app == null || app.host == null) continue;

			chain = (app.chain == null) ? '' : ('' + app.chain);

			list.push({
				host: '' + app.host,
				rx: num(app.rx),
				tx: num(app.tx),
				chain: chain,
				chains: (chain.length ? [ chain ] : []),
				devices: num(app.devices),
				source: 'state'
			});

			total += appTotal(app);
		}

		return {
			range: RANGE_TODAY,
			apps: list,
			total: total,
			devices: Array.isArray(state.devices) ? state.devices : [],
			truncated: (state.truncated === true),
			at: Date.now()
		};
	},

	/*
	 * 近 7 天：get_history(7) 给"有哪些天 + 每天合计"，再逐天 get_daily 取应用汇总。
	 * 单天失败 / 缺文件只记录下来继续，不整体失败；页面上明确写出缺了哪些天。
	 */
	loadDailyApps: function(days) {
		var self = this;
		var records = [];
		var byHost = {};
		var histTotal = 0;

		function step(index) {
			if (index >= days.length) return Promise.resolve();

			var dayObj = days[index];
			var rec = { day: '', total: 0, apps: 0, ok: false, missing: false, error: '' };

			records.push(rec);

			if (dayObj == null || typeof dayObj.day !== 'string' || !DAY_RE.test(dayObj.day)) {
				rec.error = _('日期无效');
				return step(index + 1);
			}

			rec.day = dayObj.day;
			rec.total = sumDayHistory(dayObj);
			histTotal += rec.total;

			return self.fetchDaily(rec.day).then(function(data) {
				rec.ok = true;

				if (data == null || typeof data !== 'object' ||
						(data.day == null && data.apps == null && data.totals == null)) {
					rec.missing = true;
					rec.error = _('没有这一天的 daily 记录');
					return step(index + 1);
				}

				var apps = Array.isArray(data.apps) ? data.apps : [];
				var i, a, host, item;

				for (i = 0; i < apps.length; i++) {
					a = apps[i];

					if (a == null || a.host == null || ('' + a.host).length === 0) continue;

					host = '' + a.host;
					item = byHost[host];

					if (item == null)
						item = byHost[host] = { host: host, rx: 0, tx: 0, chains: {}, devicesMax: 0, days: 0 };

					item.rx += num(a.rx);
					item.tx += num(a.tx);
					item.days += 1;
					item.devicesMax = Math.max(item.devicesMax, num(a.devices));

					if (a.chain != null && ('' + a.chain).length > 0)
						item.chains['' + a.chain] = true;

					rec.apps += 1;
				}

				if (apps.length === 0)
					rec.error = _('这一天只有汇总，没有应用明细');

				return step(index + 1);
			}).catch(function(err) {
				rec.error = errText(err);
				return step(index + 1);
			});
		}

		return step(0).then(function() {
			return { records: records, byHost: byHost, histTotal: histTotal };
		});
	},

	fetchHistory: function() {
		var timeout = new Promise(function(resolve, reject) {
			setTimeout(function() { reject(new Error(_('请求超时'))); }, HIST_TIMEOUT_MS);
		});

		return Promise.race([
			Promise.resolve().then(function() { return callHistory(WEEK_DAYS); }),
			timeout
		]);
	},

	fetchDaily: function(day) {
		var timeout = new Promise(function(resolve, reject) {
			setTimeout(function() { reject(new Error(_('请求超时'))); }, DAILY_TIMEOUT_MS);
		});

		return Promise.race([
			Promise.resolve().then(function() { return callDaily(day); }),
			timeout
		]);
	},

	currentData: function() {
		if (this.datasets == null) return null;

		return (Object.prototype.hasOwnProperty.call(this.datasets, this.range))
			? this.datasets[this.range]
			: null;
	},

	// ------------------------------------------------------------ 取数 / 刷新

	fetchToday: function(manual) {
		var self = this;

		if (this.refreshPending === true && manual !== true) return Promise.resolve();

		this.refreshPending = true;
		this.refreshError = '';

		if (manual === true) this.refreshView();

		return callState().then(function(state) {
			if (state == null || typeof state !== 'object' || state.totals == null)
				throw new Error(_('后端没有返回状态数据'));

			self.state = state;
			self.datasets[RANGE_TODAY] = self.buildTodayData(state);
			self.lastUpdateAt = Date.now();
			self.refreshError = '';
		}).catch(function(err) {
			/* 失败不清空已有列表：只在上方提示，旧数据继续可看 */
			self.refreshError = _('刷新失败：') + errText(err);
		}).then(function() {
			self.refreshPending = false;
			self.refreshView();
		});
	},

	fetch7d: function(manual) {
		var self = this;

		if (this.histPending === true) return Promise.resolve();

		this.histPending = true;
		this.histError = '';

		if (manual === true) this.refreshView();

		return this.fetchHistory().then(function(res) {
			var days = (res != null && Array.isArray(res.days)) ? res.days : [];
			var truncated = (res != null && res.truncated === true);

			return self.loadDailyApps(days).then(function(agg) {
				var built = weekAppsFrom(agg.byHost);

				return {
					range: RANGE_WEEK,
					apps: built.apps,
					total: built.total,
					devices: null,
					truncated: truncated,
					at: Date.now(),
					meta: { records: agg.records, histTotal: agg.histTotal, truncated: truncated }
				};
			});
		}).then(function(data) {
			self.datasets[RANGE_WEEK] = data;
			self.lastHistAt = data.at;
			self.lastUpdateAt = data.at;
			self.histError = '';
		}).catch(function(err) {
			/* 失败不清空已有列表：上次成功的数据继续展示，只加一条提示 */
			self.histError = errText(err);
			/* 失败也记一次时间，避免自动刷新每 15s 重打一遍失败的历史请求 */
			self.lastHistAt = Date.now();
		}).then(function() {
			self.histPending = false;
			self.refreshView();
		});
	},

	refresh: function(manual) {
		if (this.range === RANGE_WEEK) return this.fetch7d(manual === true);

		return this.fetchToday(manual === true);
	},

	manualRefresh: function() {
		return this.refresh(true);
	},

	setRange: function(key) {
		if (key !== RANGE_TODAY && key !== RANGE_WEEK) return Promise.resolve();
		if (this.range === key) return Promise.resolve();

		this.range = key;
		this.refreshView();

		/* 切回今日时顺手刷新一次 get_state（便宜）；自动刷新关掉时也照常更新。
		   近 7 天已有缓存就先用缓存，点「刷新」再重读。 */
		if (key === RANGE_TODAY) return this.fetchToday(false);

		if (this.datasets[RANGE_WEEK] == null) return this.fetch7d(false);

		return Promise.resolve();
	},

	// ------------------------------------------------------------ 自动刷新

	startAutoRefresh: function() {
		var self = this;
		var win = (typeof window !== 'undefined') ? window : null;

		this.stopAutoRefresh();

		if (win == null || typeof win.setInterval !== 'function') return;
		if (this.autoRefresh !== true) return;

		this.timer = win.setInterval(function() {
			if (self.root == null) {
				self.stopAutoRefresh();
				return;
			}

			/* 离开页面后 #view 会被整体替换，这里顺手停表，避免后台一直轮询 */
			var body = (typeof document !== 'undefined') ? document.body : null;

			if (body != null && typeof body.contains === 'function' && !body.contains(self.root)) {
				self.stopAutoRefresh();
				return;
			}

			if (typeof document !== 'undefined' && document.hidden === true) return;
			if (self.autoRefresh !== true) {
				self.stopAutoRefresh();
				return;
			}

			/* 近 7 天是日粒度 + 报文更大：自动刷新降到 60s 一次 */
			if (self.range === RANGE_WEEK && self.lastHistAt != null &&
					(Date.now() - self.lastHistAt) < HIST_REFRESH_MS)
				return;

			self.refresh(false);
		}, REFRESH_MS);

		if (typeof win.addEventListener === 'function' && this.unloadFn == null) {
			this.unloadFn = function() { self.stopAutoRefresh(); };
			win.addEventListener('beforeunload', this.unloadFn);
		}
	},

	stopAutoRefresh: function() {
		var win = (typeof window !== 'undefined') ? window : null;

		if (this.timer != null) {
			if (win != null && typeof win.clearInterval === 'function') win.clearInterval(this.timer);

			this.timer = null;
		}

		if (this.unloadFn != null) {
			if (win != null && typeof win.removeEventListener === 'function')
				win.removeEventListener('beforeunload', this.unloadFn);

			this.unloadFn = null;
		}
	},

	setAutoRefresh: function(on) {
		var enable = (on === true);

		if (this.autoInput != null) this.autoInput.checked = enable;

		/* 已经开着且定时器还在：什么都不用做；开着但定时器被停过（比如离开页面）
		   就重新建一个，避免开关看起来是开的却不再刷新。 */
		if (this.autoRefresh === enable && (enable !== true || this.timer != null))
			return;

		this.autoRefresh = enable;

		if (enable) this.startAutoRefresh();
		else this.stopAutoRefresh();

		if (this.lastUpdateEl != null) this.lastUpdateEl.textContent = this.lastUpdateText();
	},

	// ------------------------------------------------------------ 筛选 / 排序

	activeCategory: function() {
		return (this.catFilter != null && this.catFilter.indexOf('cat:') === 0)
			? this.catFilter.substring(4)
			: '';
	},

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

	matchChain: function(app) {
		if (this.filter == null || this.filter === 'all') return true;

		var chains = Array.isArray(app.chains)
			? app.chains
			: ((app.chain == null || ('' + app.chain).length === 0) ? [] : [ '' + app.chain ]);
		var i;

		for (i = 0; i < chains.length; i++) {
			if (this.filter === 'proxy' && chains[i] !== 'DIRECT') return true;
			if (this.filter === 'direct' && chains[i] === 'DIRECT') return true;
			if (this.filter.indexOf('node:') === 0 && chains[i] === this.filter.substring(5)) return true;
		}

		return false;
	},

	matchCategory: function(app) {
		var active = this.activeCategory();

		if (!active) return true;

		return this.catOf(app.host) === active;
	},

	matchSearch: function(app) {
		if (this.search == null || this.search.length === 0) return true;

		var host = (app.host == null) ? '' : ('' + app.host).toLowerCase();

		return host.indexOf(this.search.toLowerCase()) >= 0;
	},

	chainApps: function(data) {
		var out = [];

		if (data == null || !Array.isArray(data.apps)) return out;

		for (var i = 0; i < data.apps.length; i++)
			if (this.matchChain(data.apps[i])) out.push(data.apps[i]);

		return out;
	},

	sortValue: function(app, key) {
		if (key === 'rx') return num(app.rx);
		if (key === 'tx') return num(app.tx);
		if (key === 'devices') return num(app.devices);

		return appTotal(app);
	},

	compareApps: function(a, b) {
		var d = this.sortValue(b, this.sortKey) - this.sortValue(a, this.sortKey);

		if (!this.sortDesc) d = -d;
		if (d !== 0) return d;

		/* 主键相同就按合计降序、域名升序，保证顺序稳定 */
		var t = appTotal(b) - appTotal(a);

		if (t !== 0) return t;

		return ('' + a.host).localeCompare('' + b.host);
	},

	sortApps: function(rows) {
		var self = this;

		return rows.sort(function(a, b) { return self.compareApps(a, b); });
	},

	visibleApps: function(data) {
		var base = this.chainApps(data);
		var out = [], i;

		for (i = 0; i < base.length; i++)
			if (this.matchCategory(base[i]) && this.matchSearch(base[i]))
				out.push(base[i]);

		return this.sortApps(out);
	},

	sortBy: function(key) {
		if (SORT_KEYS.indexOf(key) < 0) return;

		if (this.sortKey === key) this.sortDesc = !this.sortDesc;
		else {
			this.sortKey = key;
			this.sortDesc = true;
		}

		this.refreshView();
	},

	onSearch: function(ev) {
		this.search = ('' + ((ev != null && ev.currentTarget != null) ? (ev.currentTarget.value || '') : '')).trim();
		this.refreshView();
	},

	setSearch: function(value) {
		this.search = ('' + ((value == null) ? '' : value)).trim();

		if (this.searchInput != null) this.searchInput.value = this.search;

		this.refreshView();
	},

	setChain: function(value) {
		this.filter = (value == null || ('' + value).length === 0) ? 'all' : ('' + value);

		if (this.filterSelect != null) this.filterSelect.value = this.filter;

		this.refreshView();
	},

	selectCategory: function(cat) {
		this.catFilter = (cat != null && ('' + cat).length > 0) ? ('cat:' + cat) : 'all';
		this.refreshView();
	},

	toggleCategory: function(cat) {
		if (this.activeCategory() === cat) this.selectCategory('');
		else this.selectCategory(cat);
	},

	resetFilters: function() {
		this.search = '';
		this.catFilter = 'all';
		this.filter = 'all';

		if (this.searchInput != null) this.searchInput.value = '';
		if (this.filterSelect != null) this.filterSelect.value = 'all';

		this.refreshView();
	},

	chainOptions: function(state) {
		var nodes = this.listNodes(state);
		var opts = [
			E('option', { value: 'all' }, _('全部')),
			E('option', { value: 'proxy' }, _('仅代理')),
			E('option', { value: 'direct' }, _('仅直连'))
		];

		for (var i = 0; i < nodes.length; i++)
			opts.push(E('option', { value: 'node:' + nodes[i] }, _('节点：') + nodes[i]));

		return opts;
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

	chainFilterLabel: function() {
		if (this.filter === 'all' || this.filter == null) return _('全部');
		if (this.filter === 'proxy') return _('仅代理');
		if (this.filter === 'direct') return _('仅直连');
		if (this.filter.indexOf('node:') === 0) return _('节点：') + this.filter.substring(5);

		return this.filter;
	},

	sortLabel: function() {
		if (this.sortKey === 'rx') return _('下载');
		if (this.sortKey === 'tx') return _('上传');
		if (this.sortKey === 'devices') return _('设备数');

		return _('合计');
	},

	// ------------------------------------------------------------ 局部重绘

	refreshView: function() {
		if (this.rangeWrap != null) replaceChildren(this.rangeWrap, this.renderRangeChips());
		if (this.noticeWrap != null) replaceChildren(this.noticeWrap, this.renderNotice());
		if (this.scopeWrap != null) replaceChildren(this.scopeWrap, this.renderScope());
		if (this.catWrap != null) replaceChildren(this.catWrap, this.renderCategoryCards());
		if (this.filterWrap != null) replaceChildren(this.filterWrap, this.renderFilterLine());
		if (this.countEl != null) this.countEl.textContent = this.countLine();
		if (this.listWrap != null) replaceChildren(this.listWrap, this.renderList());
		if (this.lastUpdateEl != null) this.lastUpdateEl.textContent = this.lastUpdateText();

		if (this.exportBtn != null) {
			this.exportBtn.title = (this.range === RANGE_WEEK)
				? _('后端导出的是进程启动以来的累计应用列表，不含近 7 天日粒度聚合')
				: _('导出应用列表（进程启动以来累计）');
		}
	},

	renderRangeChips: function() {
		var self = this;
		var chips = RANGES.map(function(item) {
			return chip(_(item.label), self.range === item.key, 'var(--ts-down)', function() {
				self.setRange(item.key);
			});
		});

		return [ E('span', { style: 'font-size:12px;opacity:.7;margin-right:2px' }, _('时间范围')) ]
			.concat(chips)
			.concat([
				E('span', { 'class': 'tsa-hint' },
					(this.range === RANGE_TODAY)
						? _('进程启动以来累计')
						: _('近 7 天 · 日粒度'))
			]);
	},

	renderNotice: function() {
		var items = [];

		if (this.refreshError && this.range === RANGE_TODAY)
			items.push(this.warningBox(_('刷新失败'), this.refreshError, this.currentData() != null));

		if (this.range === RANGE_WEEK) {
			if (this.histPending === true)
				items.push(E('div', { 'class': 'tsa-note' }, _('正在读取近 7 天数据…')));
			else if (this.histError && this.datasets[RANGE_WEEK] != null)
				items.push(this.warningBox(_('近 7 天数据读取失败'), this.histError, true));
		}

		return items;
	},

	warningBox: function(title, message, stale) {
		return E('div', { 'class': 'alert-message warning tsa-empty' }, [
			E('p', {}, E('strong', {}, title + '：' + message)),
			stale
				? E('p', {}, _('下面显示的是上一次成功读取的数据，没有被清空；点「刷新」可以重试。'))
				: E('p', {}, _('当前列表未被清空；可以点「刷新」重试，或切回「今日」查看。'))
		]);
	},

	renderScope: function() {
		return (this.range === RANGE_WEEK) ? this.renderScopeWeek() : this.renderScopeToday();
	},

	renderScopeToday: function() {
		var parts = [
			E('strong', {}, _('数据口径：') + _('进程启动以来累计')),
			' ',
			_('榜单来自 get_state 的 apps：prism-routerd 自本次启动起累计，进程重启归零，不是今日增量。')
		];
		var uptime = (this.state != null) ? num(this.state.uptime) : 0;

		if (uptime > 0) parts.push(' ' + _('已运行') + ' ' + fmtDuration(uptime) + '。');

		var today = (this.datasets != null) ? this.datasets[RANGE_TODAY] : null;

		if (today != null && today.truncated === true)
			parts.push(' ' + _('后端因报文过大裁剪过域名/设备明细，榜单按剩余数据展示，可能不完整。'));

		if (this.todayHist != null)
			parts.push(' ' + _('今日 5 分钟桶（get_history）合计') + ' ' + fmtBytes(this.todayHist.bytes) +
				_('，这是今日增量参考；与上面的累计口径不同，不能互相加减。'));
		else
			parts.push(' ' + _('今日桶（get_history）暂不可用或今日还没有记录，本页不显示今日增量参考。'));

		/* 口径说明长期占页面，改成默认折叠的 <details>；摘要只留一行标题。 */
		return [ E('details', { 'class': 'tsa-note tsa-fold' }, [
			E('summary', {}, _('数据口径说明')),
			E('div', { 'class': 'tsa-fold-b' }, parts)
		]) ];
	},

	renderScopeWeek: function() {
		var data = this.datasets[RANGE_WEEK];
		var parts = [
			E('strong', {}, _('数据口径：') + _('近 7 天按日聚合')),
			' ',
			_('每天取 daily 的应用汇总后按域名相加；历史仅提供日粒度（每天最多 50 个域名，且不含设备维度明细），缺失的日子只贡献总量、不参与域名排行。')
		];

		if (data != null && data.meta != null) {
			var records = data.meta.records || [];
			var withApps = 0, missing = 0, i;

			for (i = 0; i < records.length; i++) {
				if (records[i].apps > 0) withApps++;
				if (records[i].missing === true) missing++;
			}

			parts.push(' ' + _('已读取') + ' ' + records.length + ' ' + _('天') + '，' +
				withApps + ' ' + _('天有应用明细') + '。');

			if (missing > 0)
				parts.push(' ' + missing + ' ' + _('天没有 daily 文件，已跳过') + '。');

			if (num(data.meta.histTotal) > 0)
				parts.push(' ' + _('这些天的历史总流量') + ' ' + fmtBytes(data.meta.histTotal) + '，' +
					_('其中可归属到域名的合计') + ' ' + fmtBytes(data.total) +
					_('（差额来自每日域名上限、缺失明细与后端裁剪）。'));

			if (data.truncated === true)
				parts.push(' ' + _('后端报文超预算，历史天数被裁剪过，只含部分天。'));
		}

		/* 口径说明长期占页面，改成默认折叠的 <details>；摘要只留一行标题。 */
		return [ E('details', { 'class': 'tsa-note tsa-fold' }, [
			E('summary', {}, _('数据口径说明')),
			E('div', { 'class': 'tsa-fold-b' }, parts)
		]) ];
	},

	renderCategoryCards: function() {
		var self = this;

		if (this.catRules == null)
			return [ E('div', { 'class': 'tsa-note' },
				_('类别映射文件 app-categories.json 未加载：本页不显示类别概览，域名排行、搜索与下钻不受影响。')) ];

		var data = this.currentData();
		var stats = this.categoryStats(data);
		var order = this.categoryOrder();
		var active = this.activeCategory();
		var cards = [], head, i;

		for (i = 0; i < order.length; i++)
			cards.push(this.categoryCard(order[i],
				stats.map[order[i]] || { bytes: 0, count: 0 },
				stats.total,
				order[i] === active));

		head = [
			E('span', { style: 'font-size:12px;font-weight:600' }, _('类别概览')),
			E('span', { 'class': 'tsa-hint' }, _('点击类别只看这一类，再点取消；与搜索、出口筛选叠加（卡片按出口筛选统计，不受搜索与类别筛选影响）'))
		];

		if (active)
			head.push(E('button', {
				'type': 'button',
				'class': 'cbi-button',
				style: chipStyle(false),
				click: function(ev) {
					if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
					self.selectCategory('');
				}
			}, _('清除类别筛选')));

		return [
			E('div', {
				style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 6px 0'
			}, head),
			E('div', { 'class': 'tsa-cats' }, cards)
		];
	},

	categoryOrder: function() {
		var names = (this.catRules != null) ? this.catRules.names.slice() : [];
		var out = [], i;

		for (i = 0; i < CARD_ORDER.length; i++)
			if (names.indexOf(CARD_ORDER[i]) >= 0) out.push(CARD_ORDER[i]);

		for (i = 0; i < names.length; i++)
			if (out.indexOf(names[i]) < 0) out.push(names[i]);

		if (out.indexOf(CATEGORY_OTHER) < 0) out.push(CATEGORY_OTHER);

		return out;
	},

	/* 类别合计只跟随出口筛选：不跟随搜索 / 类别筛选本身，否则一选类别占比就只剩 100%。 */
	categoryStats: function(data) {
		var map = {}, total = 0;

		if (data != null && Array.isArray(data.apps)) {
			var apps = this.chainApps(data);
			var i, cat, bytes, item;

			for (i = 0; i < apps.length; i++) {
				cat = this.catOf(apps[i].host);
				bytes = appTotal(apps[i]);
				item = map[cat];

				if (item == null) item = map[cat] = { bytes: 0, count: 0 };

				item.bytes += bytes;
				item.count += 1;
				total += bytes;
			}
		}

		return { map: map, total: total };
	},

	categoryCard: function(name, stat, total, active) {
		var self = this;
		var look = categoryLook(name, this.catRules);
		var share = (total > 0) ? (num(stat.bytes) * 100 / total) : 0;
		var clickable = num(stat.bytes) > 0;
		var attrs = {
			'class': 'tsa-card' + (active ? ' on' : '') + (clickable ? '' : ' off'),
			style: 'border-color:' + (active ? look.color : 'rgba(127,127,127,.22)') + ';' +
				(active ? ('background:' + look.bg + ';') : '') +
				(clickable ? 'cursor:pointer' : 'cursor:default'),
			'aria-pressed': active ? 'true' : 'false',
			title: clickable
				? (active ? _('再点一次取消该类别筛选') : _('只看') + ' ' + name)
				: _('这一类当前没有流量')
		};

		if (clickable) {
			attrs.role = 'button';
			attrs.tabindex = '0';
			attrs.click = function(ev) {
				if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
				self.toggleCategory(name);
			};
		}

		var card = E('div', attrs, [
			E('div', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600' }, [
				E('i', {
					style: 'width:8px;height:8px;border-radius:2px;display:inline-block;flex:none;background:' +
						look.color
				}),
				E('span', { style: 'flex:1' }, name),
				E('span', { style: 'font-size:11px;font-weight:400;opacity:.62' },
					num(stat.count) + ' ' + _('个'))
			]),
			E('div', { style: 'font-size:13px;font-weight:600;margin:2px 0 4px' }, fmtBytes(stat.bytes)),
			E('div', {
				style: 'height:5px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden'
			}, E('div', {
				style: 'height:5px;width:' + share.toFixed(1) + '%;background:' + look.color
			})),
			E('div', { style: 'font-size:10.5px;opacity:.62;margin-top:3px' }, share.toFixed(1) + '%')
		]);

		if (clickable) {
			card.addEventListener('keydown', function(ev) {
				var code = (ev != null) ? (ev.key || ev.keyCode) : null;

				if (code === 'Enter' || code === ' ' || code === 13 || code === 32) {
					if (typeof ev.preventDefault === 'function') ev.preventDefault();
					self.toggleCategory(name);
				}
			});
		}

		return card;
	},

	renderFilterLine: function() {
		var self = this;
		var chips = [], active = this.activeCategory();

		if (this.search != null && this.search.length > 0)
			chips.push(this.filterChip(_('搜索') + '：' + shortHost(this.search, 24), function() { self.setSearch(''); }));

		if (active)
			chips.push(this.filterChip(_('类别') + '：' + active, function() { self.selectCategory(''); }));

		if (this.filter !== 'all')
			chips.push(this.filterChip(_('出口') + '：' + this.chainFilterLabel(), function() { self.setChain('all'); }));

		if (chips.length === 0) return [];

		return [
			E('div', { 'class': 'tsa-filterline' },
				[ E('span', { style: 'opacity:.7' }, _('当前筛选')) ].concat(chips).concat([
					E('button', {
						'type': 'button',
						'class': 'cbi-button',
						style: chipStyle(false),
						click: function(ev) {
							if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
							self.resetFilters();
						}
					}, _('清除全部筛选'))
				]))
		];
	},

	filterChip: function(label, onclear) {
		return E('span', {
			'class': 'tsa-chip',
			style: 'display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:12px;' +
				'border:1px solid rgba(127,127,127,.3);font-size:12px'
		}, [
			label,
			E('a', {
				href: '#',
				title: _('移除该筛选'),
				style: 'text-decoration:none',
				click: function(ev) {
					if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
					onclear();
				}
			}, '×')
		]);
	},

	countLine: function() {
		var data = this.currentData();

		if (data == null)
			return (this.range === RANGE_WEEK) ? _('近 7 天数据尚未读取') : '';

		var base = this.chainApps(data);
		var rows = this.visibleApps(data);
		var parts = [
			(this.range === RANGE_WEEK)
				? (_('近 7 天') + ' · ' + _('日粒度'))
				: (_('进程启动以来') + ' · ' + _('今日视图')),
			_('共') + ' ' + base.length + ' ' + _('个域名'),
			_('合计') + ' ' + fmtBytes(data.total)
		];

		if (rows.length !== base.length)
			parts.push(_('筛选后') + ' ' + rows.length + ' ' + _('条'));

		parts.push(_('排序') + '：' + this.sortLabel() + ' ' + (this.sortDesc ? '▼' : '▲'));

		return parts.join(' · ');
	},

	lastUpdateText: function() {
		var parts = [];

		if (this.lastUpdateAt != null)
			parts.push(_('最后更新') + ' ' + fmtClock(new Date(this.lastUpdateAt)));

		if (this.refreshPending === true || this.histPending === true)
			parts.push(_('刷新中…'));

		if (this.autoRefresh !== true)
			parts.push(_('自动刷新已关闭'));

		return parts.join(' · ');
	},

	// ------------------------------------------------------------ 榜单

	renderList: function() {
		var data = this.currentData();

		if (data == null) {
			if (this.range === RANGE_WEEK) {
				if (this.histPending === true)
					return [ E('div', { 'class': 'tsa-note' }, _('正在读取近 7 天数据…')) ];

				return [ this.renderWeekUnavailable() ];
			}

			return [ this.renderDataEmpty() ];
		}

		if (!Array.isArray(data.apps) || data.apps.length === 0) return [ this.renderDataEmpty() ];
		if (this.chainApps(data).length === 0) return [ this.renderFilteredEmpty() ];
		if (this.visibleApps(data).length === 0) return [ this.renderFilteredEmpty() ];

		return [ this.renderTable(this.visibleApps(data), data) ];
	},

	renderWeekUnavailable: function() {
		var self = this;

		return E('div', { 'class': 'alert-message warning tsa-empty' }, [
			E('p', {}, E('strong', {}, _('近 7 天数据读取失败'))),
			E('p', {}, this.histError || _('未知错误')),
			E('p', {}, _('历史数据只有日粒度，读不到时不会用今日累计去凑数；今日榜单不受影响。')),
			E('p', {}, [
				E('a', {
					href: '#',
					click: function(ev) {
						if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
						self.fetch7d(true);
					}
				}, _('重试读取近 7 天')),
				' · ',
				E('a', {
					href: '#',
					click: function(ev) {
						if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
						self.setRange(RANGE_TODAY);
					}
				}, _('切回「今日」'))
			])
		]);
	},

	renderDataEmpty: function() {
		var self = this;
		var title, lines = [], actions = [];

		var weekData = this.currentData();
		var weekDays = (weekData != null && weekData.meta != null && Array.isArray(weekData.meta.records))
			? weekData.meta.records.length
			: 0;

		if (this.range === RANGE_WEEK && weekDays > 0) {
			title = _('暂无数据：近 7 天的每日文件里没有应用明细');
			lines.push(_('读到') + ' ' + weekDays + ' ' + _('天汇总，但这些 daily 文件没有 apps[]（老版本记录、每日域名上限或已被裁剪）。') +
				_('历史仅提供日粒度，没有更细的记录可以补。'));
			actions.push(E('a', {
				href: '#',
				click: function(ev) {
					if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
					self.setRange(RANGE_TODAY);
				}
			}, _('切回「今日」')));
		}
		else if (this.range === RANGE_WEEK) {
			title = _('暂无数据：近 7 天没有可用的每日记录');
			lines.push(_('history 里没有可读的天，或者 daily 文件已过保留期。历史仅提供日粒度，没有更细的记录可以补。'));
			actions.push(E('a', {
				href: '#',
				click: function(ev) {
					if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
					self.setRange(RANGE_TODAY);
				}
			}, _('切回「今日」')));
		}
		else if (this.state != null && this.state.running !== true) {
			title = _('暂无数据：prism-routerd 未运行');
			lines.push(_('守护进程没跑，state 里还没有域名记录。启动服务后本页会自动刷新。'));
			actions.push(E('a', { href: L.url('admin/services/prism-router/settings') }, _('前往设置页')));
		}
		else {
			title = _('暂无数据：还没采到域名');
			lines.push(_('prism-routerd 正在运行，但本次进程启动以来还没有域名记录。'));
		}

		actions.push(E('a', { href: L.url('admin/services/prism-router/overview') }, _('返回总览')));

		var body = [ E('p', {}, E('strong', {}, title)) ];
		var i;

		for (i = 0; i < lines.length; i++) body.push(E('p', {}, lines[i]));

		var links = [];
		for (i = 0; i < actions.length; i++) {
			if (i > 0) links.push(' · ');
			links.push(actions[i]);
		}

		body.push(E('p', {}, links));

		return E('div', { 'class': 'alert-message tsa-empty' }, body);
	},

	renderFilteredEmpty: function() {
		var self = this;
		var desc = [], active = this.activeCategory();

		if (this.search != null && this.search.length > 0)
			desc.push(_('搜索') + '「' + this.search + '」');

		if (active) desc.push(_('类别') + '「' + active + '」');

		if (this.filter !== 'all') desc.push(_('出口') + '「' + this.chainFilterLabel() + '」');

		return E('div', { 'class': 'alert-message tsa-empty' }, [
			E('p', {}, E('strong', {}, _('筛选后没有匹配的域名'))),
			E('p', {}, desc.length ? (_('当前筛选：') + desc.join(' + ') + '。') : _('当前筛选条件下没有域名记录。')),
			E('p', {}, _('可以放宽搜索、再点一次已选的类别，或者直接清除全部筛选。')),
			E('p', {}, E('a', {
				href: '#',
				click: function(ev) {
					if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
					self.resetFilters();
				}
			}, _('清除全部筛选')))
		]);
	},

	renderTable: function(rows, data) {
		var head = [
			E('th', { 'class': 'th tsa-col-rank', style: 'width:36px' }, '#'),
			E('th', { 'class': 'th tsa-col-host' }, _('应用/域名')),
			E('th', { 'class': 'th tsa-col-meta' }, _('类别')),
			E('th', { 'class': 'th tsa-col-chain' }, _('出口')),
			this.sortHeader(_('设备数'), 'devices', 'right', 'tsa-col-count'),
			this.sortHeader(_('下载'), 'rx', 'right', 'tsa-col-bytes'),
			this.sortHeader(_('上传'), 'tx', 'right', 'tsa-col-bytes'),
			this.sortHeader(_('合计'), 'total', 'right', 'tsa-col-bytes'),
			E('th', { 'class': 'th tsa-col-meta', style: 'width:120px' }, _('占比'))
		];
		var list = [], i, pair;

		for (i = 0; i < rows.length; i++) {
			pair = this.renderAppRow(rows[i], data, i + 1);
			list.push(pair[0]);
			list.push(pair[1]);
		}

		return E('div', { 'class': 'tsa-tablewrap', 'role': 'region', 'tabindex': '0',
			'aria-label': _('应用与域名列表，可左右滑动查看更多列') }, [
			E('p', { 'class': 'tsa-scrollhint' }, _('左右滑动表格查看更多列')),
			E('table', { 'class': 'table tsa-table' },
				[ E('tr', { 'class': 'tr table-titles' }, head) ].concat(list))
		]);
	},

	sortHeader: function(label, key, align, className) {
		var self = this;
		var active = (this.sortKey === key);
		var arrow = active ? (this.sortDesc ? '▼' : '▲') : '';

		var th = E('th', {
			'class': 'th tsa-sort' + (className ? ' ' + className : ''),
			style: 'text-align:' + (align === 'right' ? 'right' : 'left'),
			tabindex: '0',
			'aria-sort': active ? (this.sortDesc ? 'descending' : 'ascending') : 'none',
			title: _('点击按') + label + _('排序，再点一次切换升序/降序'),
			click: function(ev) {
				if (ev != null && typeof ev.preventDefault === 'function') ev.preventDefault();
				self.sortBy(key);
			}
		}, [
			label,
			' ',
			E('span', { 'class': 'tsa-arrow' }, arrow)
		]);

		/* 键盘可达：Enter / 空格 与点击等价（用通用监听接口，不依赖事件属性名） */
		th.addEventListener('keydown', function(ev) {
			var code = (ev != null) ? (ev.key || ev.keyCode) : null;

			if (code === 'Enter' || code === ' ' || code === 13 || code === 32) {
				if (typeof ev.preventDefault === 'function') ev.preventDefault();
				self.sortBy(key);
			}
		});

		return th;
	},

	renderAppRow: function(app, data, index) {
		var self = this;
		var rank = (index == null) ? '' : ('' + index);
		var total = appTotal(app);
		var percent = (data != null && num(data.total) > 0) ? (total * 100 / num(data.total)) : 0;
		var host = (app.host == null) ? '' : ('' + app.host);
		var marker = E('span', { style: 'display:inline-block;width:12px;opacity:.6' }, '▸');
		var cell = E('td', {
			'class': 'td',
			colspan: 9,
			style: 'padding:10px 12px;background:rgba(127,127,127,.06)'
		});
		var detailRow = E('tr', { 'class': 'tr', style: 'display:none' }, [ cell ]);
		var filled = false;
		var open = (this.expanded != null && this.expanded[host] === true);
		var singleDirect = (Array.isArray(app.chains) && app.chains.length === 1 && app.chains[0] === 'DIRECT');
		var row = E('tr', {
			'class': 'tr',
			style: 'cursor:pointer',
			title: _('点击展开：该域名在各设备上的用量'),
			'aria-expanded': open ? 'true' : 'false'
		}, [
			E('td', { 'class': 'td tsa-col-rank', style: 'text-align:right;opacity:.55;width:36px' }, rank),
			E('td', { 'class': 'td tsa-col-host', title: host }, [
				marker,
				' ',
				E('strong', {}, shortHost(host, 44))
			]),
			E('td', { 'class': 'td tsa-col-meta' }, this.renderCategoryBadge(host)),
			E('td', { 'class': 'td tsa-col-chain' }, this.renderChainBadge(app)),
			E('td', {
				'class': 'td tsa-col-count',
				style: 'text-align:right',
				title: (this.range === RANGE_WEEK)
					? (_('近 7 天中日粒度汇总的单日最大设备数') +
						(num(app.days) > 0 ? _('；') + num(app.days) + _(' 天有记录') : ''))
					: _('涉及该域名的设备数')
			}, '' + num(app.devices)),
			E('td', { 'class': 'td tsa-col-bytes', style: 'text-align:right' }, fmtBytes(app.rx)),
			E('td', { 'class': 'td tsa-col-bytes', style: 'text-align:right' }, fmtBytes(app.tx)),
			E('td', { 'class': 'td tsa-col-bytes', style: 'text-align:right' }, E('strong', {}, fmtBytes(total))),
			E('td', { 'class': 'td tsa-col-meta', style: 'width:120px' }, [
				E('div', {
					style: 'height:6px;border-radius:3px;background:rgba(127,127,127,.2);overflow:hidden'
				}, E('div', {
					style: 'height:6px;width:' + percent.toFixed(1) + '%;background:' +
						(singleDirect ? 'var(--ts-teal)' : 'var(--ts-down)')
				})),
				E('span', { style: 'font-size:11px;opacity:.7' }, percent.toFixed(1) + '%')
			])
		]);

		function paint(isOpen) {
			detailRow.style.display = isOpen ? '' : 'none';
			marker.textContent = isOpen ? '▾' : '▸';
			row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

			if (isOpen && !filled) {
				filled = true;
				dom.content(cell, self.renderDetail(app, data));
			}
		}

		row.addEventListener('click', function() {
			open = !open;

			if (open) self.expanded[host] = true;
			else delete self.expanded[host];

			paint(open);
		});

		/* 重新排序 / 刷新后保留之前展开的行 */
		if (open) paint(true);

		return [ row, detailRow ];
	},

	renderChainBadge: function(app) {
		var chains = Array.isArray(app.chains) ? app.chains : [];

		if (chains.length > 1)
			return E('span', {
				style: 'font-size:12px;padding:1px 6px;border-radius:4px;white-space:nowrap;background:var(--ts-surface-2)',
				title: _('多出口混合：') + chains.join(' / ')
			}, _('混合'));

		return chainBadge(chains.length ? chains[0] : app.chain);
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

	renderDetail: function(app, data) {
		if (this.range !== RANGE_TODAY || data == null || !Array.isArray(data.devices))
			return this.renderDetailWeek();

		return this.renderDeviceDrilldown(app, data);
	},

	renderDetailWeek: function() {
		return E('div', { style: 'font-size:12px;opacity:.85;line-height:1.7' }, [
			E('strong', {}, _('历史仅提供日粒度')),
			' ',
			_('近 7 天的数据来自每日文件的应用汇总，只有「哪一天、哪个域名用了多少」，没有设备维度明细，所以这里不能展开设备分布。'),
			' ',
			_('切到「今日」可以按设备下钻（最多显示 10 台）。')
		]);
	},

	renderDeviceDrilldown: function(app, data) {
		var host = (app.host == null) ? '' : ('' + app.host);
		var matched = [];
		var i, dev, entry, chain, probe, item;

		for (i = 0; i < data.devices.length; i++) {
			dev = data.devices[i];
			entry = (dev != null && dev.apps != null && typeof dev.apps === 'object') ? dev.apps[host] : null;

			if (entry == null) continue;

			chain = (entry.chain == null) ? '' : ('' + entry.chain);
			probe = { chains: chain.length ? [ chain ] : [] };

			if (!this.matchChain(probe)) continue;

			matched.push({ dev: dev, rx: num(entry.rx), tx: num(entry.tx), chain: chain });
		}

		matched.sort(function(a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

		if (matched.length === 0)
			return E('div', { style: 'font-size:12px;opacity:.85;line-height:1.7' }, [
				_('这个域名在当前筛选下没有设备维度明细（可能是聚合层记录，也可能被后端裁剪掉了）。'),
				' ',
				E('a', { href: L.url('admin/services/prism-router/devices') }, _('在设备页查看全部应用 →'))
			]);

		var shown = matched.slice(0, MAX_DRILL_DEVICES);
		var rows = [];

		for (i = 0; i < shown.length; i++) {
			item = shown[i];

			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('a', {
					href: L.url('admin/services/prism-router/devices'),
					title: _('在设备页查看该设备')
				}, deviceName(item.dev))),
				E('td', { 'class': 'td' }, E('code', {}, item.dev.ip ? '' + item.dev.ip : '—')),
				E('td', { 'class': 'td' }, chainBadge(item.chain)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(item.rx)),
				E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(item.tx)),
				E('td', { 'class': 'td', style: 'text-align:right' },
					E('strong', {}, fmtBytes(item.rx + item.tx)))
			]));
		}

		var head = [
			E('span', { style: 'font-weight:600' }, _('设备分布')),
			_('：') + shortHost(host, 60) + ' ' + _('出现在') + ' ' + matched.length + ' ' + _('台设备上') +
				(matched.length > shown.length
					? ('，' + _('仅显示前') + ' ' + shown.length + ' ' + _('台'))
					: '')
		];

		return E('div', {}, [
			E('div', { style: 'font-size:12px;opacity:.85;margin-bottom:6px' }, head),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('设备')),
					E('th', { 'class': 'th' }, _('IP')),
					E('th', { 'class': 'th' }, _('出口')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('下载')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('上传')),
					E('th', { 'class': 'th', style: 'text-align:right' }, _('应用流量'))
				])
			].concat(rows)),
			E('p', { style: 'margin:8px 0 0 0;font-size:12px' }, [
				E('a', { href: L.url('admin/services/prism-router/devices') }, _('在设备页查看全部应用 →'))
			])
		]);
	},

	// ------------------------------------------------------------ 错误页 / 导出

	renderEmpty: function(state) {
		var message;

		if (state == null)
			message = _('暂时读不到应用列表：rpcd 对象 prism-router 不可用，或者后端尚未安装。');
		else if (state.running !== true)
			message = _('暂无数据：prism-routerd 未运行，因此还没有域名记录。');
		else
			message = _('暂无数据：prism-routerd 正在运行，但还没采到任何域名。');

		return E('div', { 'class': 'alert-message warning', style: 'padding:12px 14px' }, [
			E('p', {}, E('strong', {}, message)),
			E('p', {}, [
				E('a', { href: L.url('admin/services/prism-router/settings') }, _('前往设置页')),
				' · ',
				E('a', { href: L.url('admin/services/prism-router/overview') }, _('返回总览'))
			])
		]);
	},

	/* CSV 导出：后端返回 {filename, rows, csv}，csv 已带 BOM/CRLF，原样存盘。 */
	exportCsv: function(what) {
		var self = this;

		this.setExportStatus(_('正在导出…'), '');

		return callExportCsv(what).then(function(res) {
			if (res == null || res.ok !== true || typeof res.csv != 'string')
				throw new Error((res != null && res.error != null) ? ('' + res.error) : _('后端没有返回 CSV 内容'));

			self.saveCsv(res, what);
			self.setExportStatus(_('已导出') + ' ' + ((res.rows != null) ? res.rows : 0) + ' ' + _('行'), 'var(--ts-ok-text)');
		}).catch(function(err) {
			var message = errText(err);

			self.setExportStatus(_('导出失败：') + message, 'var(--ts-bad-text)');
			ui.addNotification(null, E('p', {}, _('导出失败：') + message), 'error');
		});
	},

	setExportStatus: function(text, color) {
		if (this.exportStatus == null) return;

		this.exportStatus.textContent = text;
		this.exportStatus.style.color = color || '';
	},

	saveCsv: function(res, what) {
		var csv = (res != null && typeof res.csv === 'string') ? res.csv : '';

		if (!csv.length) throw new Error(_('CSV 内容为空'));

		var now = new Date();
		var fallback = 'prism-router-' + what + '-' + now.getFullYear() + '-' +
			pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + '.csv';
		var filename = (res != null && res.filename) ? ('' + res.filename) : fallback;
		var blob = new Blob([ csv ], { type: 'text/csv;charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');

		a.href = url;
		a.download = filename;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
