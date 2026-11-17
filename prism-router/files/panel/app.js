/* =========================================================================
   棱镜路由 · 独立面板  app.js
   -------------------------------------------------------------------------
   运行环境：浏览器直接访问面板端口，同源请求 /cgi-bin/panel-api。
   无 LuCI、无 jQuery、无外部 CDN、无构建步骤。
   约束：只用 createElement / textContent 组装 DOM，后端字符串一律当纯文本；
   不注入 HTML 字符串、不做动态求值、不加载任何外部资源。
   ========================================================================= */
(function () {
	'use strict';

	/* ------------------------------------------------------------------ *
	 * 常量
	 * ------------------------------------------------------------------ */
	var API_BASE = '/cgi-bin/panel-api';
	var TOKEN_KEY = 'prism-router-panel-token';
	var AUTO_KEY = 'prism-router-panel-autorefresh';

	var AUTO_INTERVAL = 15000;      /* 自动刷新间隔（毫秒） */
	var REQUEST_TIMEOUT = 12000;    /* 单次请求超时 */
	var MAX_SAMPLES = 60;           /* 页面本地滚动窗口 */
	var TOP_DEVICES = 10;
	var TOP_APPS = 10;
	var TOP_DEVICE_APPS = 5;
	var ONLINE_WINDOW = 180;        /* 秒：超过这个时间没有活动就不算在线 */
	var HISTORY_DAYS = 7;
	var HISTORY_REFRESH = 300000;   /* 历史数据 5 分钟刷新一次 */

	var CONFIDENCE = {
		exact: { label: '精确', cls: 'pill--ok' },
		degraded: { label: '降级', cls: 'pill--warn' },
		unavailable: { label: '不可用', cls: 'pill--danger' },
		unknown: { label: '未知', cls: 'pill--unknown' }
	};

	/* ------------------------------------------------------------------ *
	 * 运行态
	 * ------------------------------------------------------------------ */
	var app = {
		token: '',
		auto: true,
		timer: 0,
		inflight: false,
		queue: false,
		lastOk: 0,          /* 毫秒时间戳 */
		lastErr: null,
		authBlocked: false,
		authFocused: false,
		state: null,
		history: null,
		historyAt: 0,
		samples: [],
		prevTotals: null,
		lastSampleTs: 0,
		expanded: {},
		manual: false
	};

	var dom = {};
	var resizeRaf = 0;

	/* ------------------------------------------------------------------ *
	 * 小工具
	 * ------------------------------------------------------------------ */
	function el(tag, cls, text) {
		var node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined && text !== null) node.textContent = String(text);
		return node;
	}

	function clear(node) {
		if (!node) return;
		while (node.firstChild) node.removeChild(node.firstChild);
	}

	function setText(node, text) {
		if (!node) return;
		node.textContent = (text === undefined || text === null) ? '' : String(text);
	}

	function setMeta(node, text) {
		if (!node) return;
		var value = (text === undefined || text === null) ? '' : String(text);
		node.textContent = value;
		if (value) node.removeAttribute('hidden');
		else node.setAttribute('hidden', '');
	}

	function str(v) {
		if (typeof v === 'string') return v;
		if (v === undefined || v === null) return '';
		return String(v);
	}

	function n0(v) {
		var n = Number(v);
		return isFinite(n) ? n : 0;
	}

	function toSec(v) {
		var n = n0(v);
		return n > 1e11 ? Math.floor(n / 1000) : n;
	}

	function pad2(n) {
		return n < 10 ? '0' + n : String(n);
	}

	/* ------------------------------------------------------------------ *
	 * 格式化
	 * ------------------------------------------------------------------ */
	var BYTE_UNITS = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB' ];

	function fmtBytes(v) {
		var n = n0(v);
		var sign = n < 0 ? '-' : '';
		n = Math.abs(n);
		var i = 0;
		while (n >= 1024 && i < BYTE_UNITS.length - 1) {
			n /= 1024;
			i++;
		}
		var digits = (i === 0) ? 0 : (n >= 100 ? 0 : (n >= 10 ? 1 : 2));
		return sign + n.toFixed(digits) + ' ' + BYTE_UNITS[i];
	}

	/* bytes/s -> 自适应速率文本 */
	function fmtRate(bytesPerSec) {
		var bps = n0(bytesPerSec) * 8;
		if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps';
		if (bps >= 1e6) {
			var m = bps / 1e6;
			return m.toFixed(m >= 100 ? 0 : (m >= 10 ? 1 : 2)) + ' Mbps';
		}
		if (bps >= 1e3) return Math.round(bps / 1e3) + ' Kbps';
		return Math.round(bps) + ' bps';
	}

	/* 概览卡固定用 Mbps */
	function fmtMbps(bytesPerSec) {
		var m = n0(bytesPerSec) * 8 / 1e6;
		if (m >= 100) return m.toFixed(0);
		if (m >= 10) return m.toFixed(1);
		return m.toFixed(2);
	}

	function pct(part, whole) {
		var w = n0(whole);
		if (w <= 0) return 0;
		return Math.max(0, Math.min(100, n0(part) / w * 100));
	}

	function fmtPct(v) {
		return (Math.round(n0(v) * 10) / 10).toFixed(1) + '%';
	}

	function fmtClockMs(ms) {
		if (!ms) return '—';
		var d = new Date(ms);
		return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
	}

	function fmtDateTime(sec) {
		var s = toSec(sec);
		if (!s) return '—';
		var d = new Date(s * 1000);
		return pad2(d.getFullYear() % 100) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
			' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
	}

	function fmtHM(ms) {
		var d = new Date(n0(ms));
		return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
	}

	function relAgo(sec) {
		var s = toSec(sec);
		if (!s) return '';
		var diff = Math.max(0, Math.floor(Date.now() / 1000) - s);
		if (diff < 60) return diff + ' 秒前';
		if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
		if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
		return Math.floor(diff / 86400) + ' 天前';
	}

	function localDayKey(d) {
		return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
	}

	/* ------------------------------------------------------------------ *
	 * 存储 / URL 令牌
	 * ------------------------------------------------------------------ */
	function readStoredToken() {
		try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
	}

	function storeToken(token) {
		try {
			if (token) window.localStorage.setItem(TOKEN_KEY, token);
			else window.localStorage.removeItem(TOKEN_KEY);
		} catch (e) { /* 隐私模式下写不进去不影响本次会话 */ }
	}

	function readAutoPref() {
		try {
			var v = window.localStorage.getItem(AUTO_KEY);
			return v === null ? true : v === '1';
		} catch (e) { return true; }
	}

	function storeAutoPref(on) {
		try { window.localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
	}

	/* 从地址栏取 token 并立刻移除，避免复制链接/referrer 泄漏 */
	function takeUrlToken() {
		var token = '';
		try {
			var url = new window.URL(window.location.href);
			if (url.searchParams.has('token')) {
				token = url.searchParams.get('token') || '';
				url.searchParams.delete('token');
				window.history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''));
			}
		} catch (e) { token = ''; }
		return token;
	}

	/* ------------------------------------------------------------------ *
	 * 请求
	 * ------------------------------------------------------------------ */
	function apiUrl(what, extra) {
		var url = API_BASE + '?what=' + encodeURIComponent(what);
		if (extra) url += '&' + extra;
		if (app.token) url += '&token=' + encodeURIComponent(app.token);
		return url;
	}

	function makeError(status, data, text) {
		var detail = '';
		if (data && typeof data === 'object' && typeof data.error === 'string') detail = data.error;
		else if (typeof text === 'string' && text) detail = text.slice(0, 200);

		var kind = (status === 401 || status === 403) ? 'auth' : 'http';
		return {
			panelError: true,
			kind: kind,
			status: status,
			message: 'HTTP ' + status + (detail ? '：' + detail : '')
		};
	}

	function requestJson(url) {
		var opts = {
			method: 'GET',
			credentials: 'same-origin',
			cache: 'no-store',
			referrerPolicy: 'no-referrer',
			headers: { 'Accept': 'application/json' }
		};
		var ctrl = null;
		var timer = 0;

		if (typeof window.AbortController === 'function') {
			ctrl = new window.AbortController();
			opts.signal = ctrl.signal;
			timer = window.setTimeout(function () {
				try { ctrl.abort(); } catch (e) { /* 忽略 */ }
			}, REQUEST_TIMEOUT);
		}

		return window.fetch(url, opts).then(function (res) {
			return res.text().then(function (text) {
				var data = null;
				if (text) {
					try { data = JSON.parse(text); } catch (e) { data = null; }
				}
				if (!res.ok || res.status === 401) throw makeError(res.status, data, text);
				if (data === null) throw makeError(res.status, null, text);
				if (data && typeof data === 'object' && data.error) throw makeError(res.status, data, text);
				return data;
			});
		}).then(function (data) {
			if (timer) window.clearTimeout(timer);
			return data;
		}, function (err) {
			if (timer) window.clearTimeout(timer);
			if (err && err.panelError) throw err;
			var timeout = err && err.name === 'AbortError';
			throw {
				panelError: true,
				kind: timeout ? 'timeout' : 'network',
				status: 0,
				message: timeout ? '请求超时（' + Math.round(REQUEST_TIMEOUT / 1000) + ' 秒）' : '无法连接到面板服务'
			};
		});
	}

	function fetchState() {
		return requestJson(apiUrl('state'));
	}

	function fetchHistory() {
		return requestJson(apiUrl('history', 'days=' + HISTORY_DAYS));
	}

	/* ------------------------------------------------------------------ *
	 * 数据归一化（契约允许 apps 是数组或 host 映射）
	 * ------------------------------------------------------------------ */
	function normalizeApps(raw) {
		var out = [];

		if (Array.isArray(raw)) {
			raw.forEach(function (item) {
				if (!item || typeof item !== 'object') return;
				var host = str(item.host) || str(item.domain) || str(item.name);
				if (!host) return;
				out.push({ host: host, rx: n0(item.rx), tx: n0(item.tx), chain: str(item.chain) });
			});
			return out;
		}

		if (raw && typeof raw === 'object') {
			Object.keys(raw).forEach(function (host) {
				var item = raw[host];
				if (!item || typeof item !== 'object') return;
				if (!host) return;
				out.push({ host: host, rx: n0(item.rx), tx: n0(item.tx), chain: str(item.chain) });
			});
		}
		return out;
	}

	function sumParts(dev, kind) {
		var direct = n0(dev['direct_' + kind]);
		var proxy = n0(dev['proxy_' + kind]);
		var total = direct + proxy;
		if (total === 0 && dev[kind] !== undefined) total = n0(dev[kind]);
		return total;
	}

	function devRx(dev) { return sumParts(dev, 'rx'); }
	function devTx(dev) { return sumParts(dev, 'tx'); }
	function devTotal(dev) { return devRx(dev) + devTx(dev); }

	function totalsSum(totals) {
		var rx = n0(totals.rx) || (n0(totals.direct_rx) + n0(totals.proxy_rx));
		var tx = n0(totals.tx) || (n0(totals.direct_tx) + n0(totals.proxy_tx));
		return rx + tx;
	}

	function isOnline(dev, state) {
		var seen = toSec(dev.last_seen);
		var now = toSec(state && state.ts) || Math.floor(Date.now() / 1000);
		if (seen > 0 && now - seen <= ONLINE_WINDOW) return true;
		return (n0(dev.rx_rate) + n0(dev.tx_rate)) > 0;
	}

	function isRunning(state) {
		if (!state) return false;
		if (typeof state.running === 'boolean') return state.running;
		if (state.running === 1 || state.running === '1') return true;
		if (state.running === 0 || state.running === '0') return false;
		var ts = toSec(state.ts);
		return ts > 0 && (Math.floor(Date.now() / 1000) - ts) <= 60;
	}

	function confidenceOf(state) {
		var raw = state && state.health && state.health.accounting_confidence;
		var key = str(raw).toLowerCase();
		var meta = CONFIDENCE[key] || CONFIDENCE.unknown;
		return { key: CONFIDENCE[key] ? key : 'unknown', label: meta.label, cls: meta.cls };
	}

	function deviceName(dev) {
		return str(dev.alias) || str(dev.hostname) || str(dev.ip) || str(dev.mac) || '未知设备';
	}

	function linkMeta(link) {
		var k = str(link).toLowerCase();
		if (k === 'wifi' || k === 'wireless') return { text: '无线', cls: 'badge badge--wifi' };
		if (k === 'wired' || k === 'ethernet') return { text: '有线', cls: 'badge badge--wired' };
		return { text: '未知', cls: 'badge badge--unknown' };
	}

	function chainMeta(chain) {
		var c = str(chain);
		if (!c) return { text: '未知', cls: 'badge badge--unknown' };
		if (c.toUpperCase() === 'DIRECT') return { text: '直连', cls: 'badge badge--direct' };
		return { text: c, cls: 'badge badge--proxy' };
	}

	function badge(text, cls, title) {
		var box = el('span', cls || 'badge');
		box.appendChild(el('span', 'badge__text', text));
		if (title) box.title = title;
		return box;
	}

	function kv(key, value, warn) {
		var box = el('span', 'kv');
		box.appendChild(el('span', 'kv__k', key));
		box.appendChild(el('span', 'kv__v' + (warn ? ' kv__v--warn' : ''), value));
		return box;
	}

	/* ------------------------------------------------------------------ *
	 * 今日流量：优先用今日 5 分钟桶，其次当日 daily 摘要
	 * ------------------------------------------------------------------ */
	function todayStats() {
		var out = { bytes: 0, direct: 0, proxy: 0, fromHistory: false };
		var history = app.history;
		var days = history && Array.isArray(history.days) ? history.days : null;
		if (!days || !days.length) return out;

		var today = localDayKey(new Date());
		var first = days[0];
		if (!first || first.day !== today) return out;

		if (Array.isArray(first.buckets) && first.buckets.length) {
			first.buckets.forEach(function (b) {
				out.direct += n0(b.direct_rx) + n0(b.direct_tx);
				out.proxy += n0(b.proxy_rx) + n0(b.proxy_tx);
			});
			out.bytes = out.direct + out.proxy;
			out.fromHistory = true;
			return out;
		}

		if (first.summary && first.summary.totals) {
			var t = first.summary.totals;
			out.direct = n0(t.direct_rx) + n0(t.direct_tx);
			out.proxy = n0(t.proxy_rx) + n0(t.proxy_tx);
			out.bytes = n0(t.rx) + n0(t.tx) || (out.direct + out.proxy);
			out.fromHistory = out.bytes > 0;
		}
		return out;
	}

	/* ------------------------------------------------------------------ *
	 * 采样
	 * ------------------------------------------------------------------ */
	function recordSample(state) {
		var totals = (state && state.totals && typeof state.totals === 'object') ? state.totals : null;
		if (!totals) return;

		var ts = toSec(state.ts) || Math.floor(Date.now() / 1000);
		if (app.lastSampleTs === ts) return;   /* 同一份 state 不重复入库 */

		var rx = n0(totals.rx_rate);
		var tx = n0(totals.tx_rate);
		var rxTotal = n0(totals.rx) || (n0(totals.direct_rx) + n0(totals.proxy_rx));
		var txTotal = n0(totals.tx) || (n0(totals.direct_tx) + n0(totals.proxy_tx));

		/* 后端没给速率时用总量差分兜底 */
		if ((!totals.rx_rate || !totals.tx_rate) && app.prevTotals) {
			var dt = ts - app.prevTotals.ts;
			if (dt > 0) {
				if (rxTotal >= app.prevTotals.rx) rx = (rxTotal - app.prevTotals.rx) / dt;
				if (txTotal >= app.prevTotals.tx) tx = (txTotal - app.prevTotals.tx) / dt;
			}
		}

		app.prevTotals = { ts: ts, rx: rxTotal, tx: txTotal };
		app.lastSampleTs = ts;
		app.samples.push({ t: ts * 1000, rx: rx, tx: tx });
		while (app.samples.length > MAX_SAMPLES) app.samples.shift();
	}

	/* ------------------------------------------------------------------ *
	 * 顶栏
	 * ------------------------------------------------------------------ */
	function setPill(node, cls, text) {
		if (!node) return;
		node.className = 'pill ' + cls;
		node.textContent = text;
	}

	function renderTopbar() {
		var state = app.state;
		var running = isRunning(state);

		if (!state && app.inflight) {
			setPill(dom.statePill, 'pill--loading', '加载中');
		} else if (!state) {
			setPill(dom.statePill, 'pill--unknown', '未知');
		} else {
			setPill(dom.statePill, running ? 'pill--ok' : 'pill--warn', running ? '运行中' : '未运行');
		}

		var conf = confidenceOf(state);
		setPill(dom.confidencePill, conf.cls, conf.label);

		if (app.lastOk) {
			var stamp = fmtClockMs(app.lastOk);
			if (app.lastErr) {
				setText(dom.lastUpdated, stamp + ' · 已过期');
				dom.lastUpdated.setAttribute('data-stale', '1');
			} else {
				setText(dom.lastUpdated, stamp);
				dom.lastUpdated.removeAttribute('data-stale');
			}
			try { dom.lastUpdated.setAttribute('datetime', new Date(app.lastOk).toISOString()); } catch (e) { /* 忽略 */ }
		} else {
			setText(dom.lastUpdated, '—');
			dom.lastUpdated.removeAttribute('data-stale');
			dom.lastUpdated.removeAttribute('datetime');
		}
	}

	/* ------------------------------------------------------------------ *
	 * 概览卡
	 * ------------------------------------------------------------------ */
	function renderCards() {
		var state = app.state;
		var totals = (state && state.totals && typeof state.totals === 'object') ? state.totals : null;
		var health = (state && state.health && typeof state.health === 'object') ? state.health : {};

		if (!state || !totals) {
			setText(dom.cardRx, '—');
			setText(dom.cardTx, '—');
			setText(dom.cardRxUnit, '');
			setText(dom.cardTxUnit, '');
			setText(dom.cardRxSub, '等待数据');
			setText(dom.cardTxSub, '等待数据');
			setText(dom.cardToday, '—');
			setText(dom.cardTodaySub, '等待数据');
			setText(dom.cardMonth, '—');
			setText(dom.cardMonthSub, '等待数据');
			setText(dom.cardDevices, '—');
			setText(dom.cardDevicesUnit, '');
			setText(dom.cardDevicesSub, '等待数据');
			setText(dom.cardClash, '—');
			setText(dom.cardClashSub, '等待数据');
			return;
		}

		var rxRate = n0(totals.rx_rate);
		var txRate = n0(totals.tx_rate);
		setText(dom.cardRx, fmtMbps(rxRate));
		setText(dom.cardTx, fmtMbps(txRate));
		setText(dom.cardRxUnit, 'Mbps');
		setText(dom.cardTxUnit, 'Mbps');
		setText(dom.cardRxSub, fmtBytes(rxRate) + '/s · ' + fmtRate(rxRate));
		setText(dom.cardTxSub, fmtBytes(txRate) + '/s · ' + fmtRate(txRate));

		var today = todayStats();
		var todayBytes = today.fromHistory ? today.bytes : totalsSum(totals);
		setText(dom.cardToday, fmtBytes(todayBytes));
		setText(dom.cardTodaySub, today.fromHistory
			? '今日 5 分钟桶 · 直连 ' + fmtBytes(today.direct) + ' / 代理 ' + fmtBytes(today.proxy)
			: '暂无当日历史，显示进程累计');

		var month = n0(totals.month_total);
		var monthFromApi = month > 0;
		if (!monthFromApi) month = totalsSum(totals);
		setText(dom.cardMonth, fmtBytes(month));
		setText(dom.cardMonthSub, (monthFromApi ? '本月合计' : '进程累计') +
			' · 直连 ' + fmtBytes(n0(totals.direct_rx) + n0(totals.direct_tx)) +
			' / 代理 ' + fmtBytes(n0(totals.proxy_rx) + n0(totals.proxy_tx)));

		var devices = Array.isArray(state.devices) ? state.devices : [];
		var online = 0;
		devices.forEach(function (dev) {
			if (dev && isOnline(dev, state)) online++;
		});
		setText(dom.cardDevices, devices.length ? String(online) : '—');
		setText(dom.cardDevicesUnit, devices.length ? ' / ' + devices.length + ' 台' : '');
		setText(dom.cardDevicesSub, devices.length ? '近 3 分钟有活动设备' : '暂无设备数据');

		setText(dom.cardClash, String(n0(health.clash_connections)));
		setText(dom.cardClashSub, 'conntrack 记录 ' + n0(health.conntrack_count));
	}

	/* ------------------------------------------------------------------ *
	 * 图表
	 * ------------------------------------------------------------------ */
	function chartColors() {
		var dark = false;
		try {
			dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
		} catch (e) { dark = false; }

		if (dark) {
			return {
				grid: '#26304a', axis: '#46536e', text: '#8b9ab4',
				rx: '#7aa2ff', tx: '#f0a15c',
				rxTop: 'rgba(122, 162, 255, .30)', rxBottom: 'rgba(122, 162, 255, 0)',
				dot: '#0f1420'
			};
		}
		return {
			grid: '#e6ecf6', axis: '#b8c4d6', text: '#6b7a90',
			rx: '#2f6bf4', tx: '#e8792b',
			rxTop: 'rgba(47, 107, 244, .26)', rxBottom: 'rgba(47, 107, 244, 0)',
			dot: '#ffffff'
		};
	}

	function niceMax(v) {
		var target = Math.max(n0(v), 125000) * 1.1;   /* 至少 1 Mbps 的纵轴 */
		var exp = Math.floor(Math.log(target) / Math.LN10);
		var base = Math.pow(10, exp);
		var mults = [ 1, 2, 2.5, 5, 10 ];
		for (var i = 0; i < mults.length; i++) {
			var step = mults[i] * base;
			if (step * 4 >= target) return step * 4;
		}
		return base * 40;
	}

	function drawChart() {
		var canvas = dom.canvas;
		if (!canvas || typeof canvas.getContext !== 'function') return;

		var cssW = Math.max(260, Math.round(canvas.clientWidth || 640));
		var cssH = Math.max(160, Math.round(canvas.clientHeight || 240));
		var dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
		var pxW = Math.round(cssW * dpr);
		var pxH = Math.round(cssH * dpr);
		if (canvas.width !== pxW || canvas.height !== pxH) {
			canvas.width = pxW;
			canvas.height = pxH;
		}

		var ctx = canvas.getContext('2d');
		if (!ctx) return;
		if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssW, cssH);

		var colors = chartColors();
		var pad = { top: 14, right: 14, bottom: 26, left: 62 };
		var plotW = Math.max(40, cssW - pad.left - pad.right);
		var plotH = Math.max(40, cssH - pad.top - pad.bottom);
		var samples = app.samples;

		var maxVal = 0;
		for (var i = 0; i < samples.length; i++) {
			maxVal = Math.max(maxVal, samples[i].rx, samples[i].tx);
		}
		var yMax = niceMax(maxVal);

		/* 网格与纵轴刻度 */
		ctx.save();
		ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
		ctx.textBaseline = 'middle';
		for (var g = 0; g <= 4; g++) {
			var y = pad.top + plotH * g / 4;
			var value = yMax * (4 - g) / 4;
			ctx.beginPath();
			ctx.strokeStyle = colors.grid;
			ctx.lineWidth = 1;
			ctx.moveTo(pad.left, y + 0.5);
			ctx.lineTo(pad.left + plotW, y + 0.5);
			ctx.stroke();

			ctx.fillStyle = colors.text;
			ctx.textAlign = 'right';
			ctx.fillText(fmtRate(value), pad.left - 8, y);
		}
		ctx.restore();

		/* 横轴时间 */
		if (samples.length >= 2) {
			ctx.save();
			ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
			ctx.fillStyle = colors.text;
			ctx.textBaseline = 'top';
			ctx.textAlign = 'left';
			ctx.fillText(fmtHM(samples[0].t), pad.left, pad.top + plotH + 8);
			ctx.textAlign = 'right';
			ctx.fillText(fmtHM(samples[samples.length - 1].t), pad.left + plotW, pad.top + plotH + 8);
			ctx.textAlign = 'center';
			ctx.fillText(fmtHM(samples[Math.floor((samples.length - 1) / 2)].t), pad.left + plotW / 2, pad.top + plotH + 8);
			ctx.restore();
		}

		if (samples.length < 2) return;

		var n = samples.length;
		function xAt(idx) { return pad.left + plotW * idx / (n - 1); }
		function yAt(value) { return pad.top + plotH * (1 - Math.min(1, Math.max(0, value / yMax))); }

		/* 下载区域填充 */
		var grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
		grad.addColorStop(0, colors.rxTop);
		grad.addColorStop(1, colors.rxBottom);
		ctx.beginPath();
		ctx.moveTo(xAt(0), pad.top + plotH);
		for (var k = 0; k < n; k++) ctx.lineTo(xAt(k), yAt(samples[k].rx));
		ctx.lineTo(xAt(n - 1), pad.top + plotH);
		ctx.closePath();
		ctx.fillStyle = grad;
		ctx.fill();

		/* 曲线 */
		drawSeries(ctx, samples, 'rx', colors.rx, xAt, yAt);
		drawSeries(ctx, samples, 'tx', colors.tx, xAt, yAt);

		/* 末端点 */
		var last = samples[n - 1];
		[ [ 'rx', colors.rx ], [ 'tx', colors.tx ] ].forEach(function (pair) {
			ctx.beginPath();
			ctx.arc(xAt(n - 1), yAt(last[pair[0]]), 3.2, 0, Math.PI * 2);
			ctx.fillStyle = pair[1];
			ctx.fill();
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = colors.dot;
			ctx.stroke();
		});
	}

	function drawSeries(ctx, samples, key, color, xAt, yAt) {
		ctx.beginPath();
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.strokeStyle = color;
		for (var i = 0; i < samples.length; i++) {
			var x = xAt(i);
			var y = yAt(samples[i][key]);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}

	function renderChart() {
		var samples = app.samples;
		var hasData = samples.length >= 2;

		if (dom.chartEmpty) dom.chartEmpty.hidden = hasData;
		setText(dom.chartMeta, samples.length ? samples.length + ' 个采样点' : '采样中');
		setText(dom.chartWindow, String(MAX_SAMPLES));

		if (hasData) {
			var last = samples[samples.length - 1];
			var peakRx = 0;
			var peakTx = 0;
			samples.forEach(function (s) {
				peakRx = Math.max(peakRx, s.rx);
				peakTx = Math.max(peakTx, s.tx);
			});
			if (dom.canvas) {
				dom.canvas.setAttribute('aria-label',
					'最近 ' + samples.length + ' 次采样的上下行速率曲线；当前下载 ' + fmtRate(last.rx) +
					'，上传 ' + fmtRate(last.tx) + '；峰值下载 ' + fmtRate(peakRx) + '，上传 ' + fmtRate(peakTx) + '。');
			}
			setText(dom.chartLegendNote, '纵轴：速率 · 峰值 ↓ ' + fmtRate(peakRx) + ' / ↑ ' + fmtRate(peakTx));
		} else {
			if (dom.canvas) dom.canvas.setAttribute('aria-label', '实时速率趋势图，暂无采样数据');
			setText(dom.chartLegendNote, '纵轴：速率 · 横轴：采样时间');
		}

		drawChart();
	}

	/* ------------------------------------------------------------------ *
	 * 设备榜
	 * ------------------------------------------------------------------ */
	function deviceKey(dev, idx) {
		return str(dev.mac) || str(dev.ip) || ('idx-' + idx);
	}

	function buildDeviceDetail(dev) {
		var wrap = el('div', 'detail');
		var grid = el('div', 'detail__grid');

		grid.appendChild(kv('直连', '↓ ' + fmtBytes(n0(dev.direct_rx)) + ' · ↑ ' + fmtBytes(n0(dev.direct_tx))));
		grid.appendChild(kv('代理', '↓ ' + fmtBytes(n0(dev.proxy_rx)) + ' · ↑ ' + fmtBytes(n0(dev.proxy_tx))));
		if (str(dev.group)) grid.appendChild(kv('分组', str(dev.group)));

		var seen = toSec(dev.last_seen);
		grid.appendChild(kv('最后活动', seen ? fmtDateTime(seen) + '（' + relAgo(seen) + '）' : '—'));

		var idText = [ str(dev.ip), str(dev.mac) ].filter(Boolean).join(' · ');
		if (idText) grid.appendChild(kv('IP / MAC', idText));

		wrap.appendChild(grid);

		var limit = n0(dev.quota_limit);
		if (limit > 0) {
			var used = n0(dev.month_total);
			var percent = pct(used, limit);
			var quota = el('div', 'quota');
			var bar = el('div', 'quota__bar');
			var fill = el('span', 'quota__fill' +
				(percent >= 100 ? ' quota__fill--danger' : (percent >= 80 ? ' quota__fill--warn' : '')));
			fill.style.width = Math.min(100, percent) + '%';
			bar.appendChild(fill);
			quota.appendChild(el('span', 'kv__k', '月配额'));
			quota.appendChild(bar);
			quota.appendChild(el('span', 'quota__text',
				fmtBytes(used) + ' / ' + fmtBytes(limit) + '（' + fmtPct(percent) + '）'));
			wrap.appendChild(quota);
		}

		var apps = normalizeApps(dev.apps);
		apps.sort(function (a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });
		var top = apps.slice(0, TOP_DEVICE_APPS);

		if (!top.length) {
			wrap.appendChild(el('p', 'muted', '该设备暂无应用明细（未经过 Clash 或尚无流量）'));
			return wrap;
		}

		var table = el('table', 'mini-table');
		table.appendChild(el('caption', 'visually-hidden', deviceName(dev) + ' 的应用明细，前 ' + top.length + ' 条'));

		var thead = el('thead');
		var headerRow = el('tr');
		[ '应用 / 域名', '链路', '下载', '上传' ].forEach(function (label, i) {
			var th = el('th', i >= 2 ? 'num' : '', label);
			th.setAttribute('scope', 'col');
			headerRow.appendChild(th);
		});
		thead.appendChild(headerRow);
		table.appendChild(thead);

		var tbody = el('tbody');
		top.forEach(function (item) {
			var row = el('tr');
			var hostCell = el('td', 'detail__host', item.host);
			hostCell.title = item.host;
			row.appendChild(hostCell);
			var chainCell = el('td');
			var meta = chainMeta(item.chain);
			chainCell.appendChild(badge(meta.text, meta.cls, item.chain));
			row.appendChild(chainCell);
			row.appendChild(el('td', 'num', fmtBytes(item.rx)));
			row.appendChild(el('td', 'num', fmtBytes(item.tx)));
			tbody.appendChild(row);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		return wrap;
	}

	function toggleDeviceRow(row) {
		var btn = row.querySelector ? row.querySelector('.row-toggle') : null;
		if (!btn) return;

		var detailId = btn.getAttribute('aria-controls');
		var detail = detailId ? document.getElementById(detailId) : null;
		var next = btn.getAttribute('aria-expanded') !== 'true';
		var name = btn.getAttribute('data-name') || '设备';

		btn.setAttribute('aria-expanded', next ? 'true' : 'false');
		btn.setAttribute('aria-label', (next ? '收起 ' : '展开 ') + name + ' 的应用明细');
		if (detail) detail.hidden = !next;

		var key = row.getAttribute('data-key');
		if (key) {
			if (next) app.expanded[key] = true;
			else delete app.expanded[key];
		}
	}

	function renderDevices() {
		var body = dom.devicesBody;
		if (!body) return;
		clear(body);

		var state = app.state;
		var devices = (state && Array.isArray(state.devices)) ? state.devices.slice() : [];
		devices.sort(function (a, b) { return devTotal(b) - devTotal(a); });
		var list = devices.slice(0, TOP_DEVICES);

		var meta = devices.length ? '共 ' + devices.length + ' 台' : '';
		if (state && state.truncated) meta += meta ? ' · 已截断' : '已截断';
		setMeta(dom.devicesMeta, meta);

		if (!list.length) {
			var emptyRow = el('tr');
			var emptyCell = el('td', 'placeholder', state ? '暂无设备数据（等待下一轮采集）' : '正在加载…');
			emptyCell.colSpan = 5;
			emptyRow.appendChild(emptyCell);
			body.appendChild(emptyRow);
			return;
		}

		list.forEach(function (dev, idx) {
			var key = deviceKey(dev, idx);
			var expanded = !!app.expanded[key];
			var name = deviceName(dev);

			var row = el('tr', 'drow');
			row.setAttribute('data-key', key);

			var nameCell = el('td');
			var nameWrap = el('div', 'name-wrap');
			var nameText = el('div', 'name-wrap__text');
			nameText.appendChild(el('span', 'cell-main', name));
			var subParts = [];
			if (str(dev.alias) && str(dev.hostname)) subParts.push(str(dev.hostname));
			if (str(dev.ip)) subParts.push(str(dev.ip));
			if (subParts.length) nameText.appendChild(el('span', 'cell-sub', subParts.join(' · ')));
			nameWrap.appendChild(nameText);

			var btn = el('button', 'row-toggle');
			btn.type = 'button';
			btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
			btn.setAttribute('aria-controls', 'dev-detail-' + idx);
			btn.setAttribute('aria-label', (expanded ? '收起 ' : '展开 ') + name + ' 的应用明细');
			btn.setAttribute('data-name', name);
			btn.appendChild(el('span', 'caret', '▶'));
			nameWrap.appendChild(btn);
			nameCell.appendChild(nameWrap);
			row.appendChild(nameCell);

			var linkCell = el('td', 'col-link');
			var link = linkMeta(dev.link);
			linkCell.appendChild(badge(link.text, link.cls));
			row.appendChild(linkCell);

			var speedCell = el('td', 'num col-speed');
			speedCell.appendChild(el('span', 'speed speed--down', '↓ ' + fmtRate(dev.rx_rate)));
			speedCell.appendChild(el('span', 'speed speed--up', '↑ ' + fmtRate(dev.tx_rate)));
			row.appendChild(speedCell);

			row.appendChild(el('td', 'num', fmtBytes(devTotal(dev))));
			row.appendChild(el('td', 'num', dev.month_total === undefined ? '—' : fmtBytes(dev.month_total)));

			body.appendChild(row);

			var detailRow = el('tr', 'detail-row');
			detailRow.id = 'dev-detail-' + idx;
			detailRow.hidden = !expanded;
			var detailCell = el('td');
			detailCell.colSpan = 5;
			detailCell.appendChild(buildDeviceDetail(dev));
			detailRow.appendChild(detailCell);
			body.appendChild(detailRow);
		});
	}

	/* ------------------------------------------------------------------ *
	 * 应用榜
	 * ------------------------------------------------------------------ */
	function renderApps() {
		var body = dom.appsBody;
		if (!body) return;
		clear(body);

		var state = app.state;
		var apps = (state && Array.isArray(state.apps)) ? state.apps.slice() : [];
		apps.sort(function (a, b) { return (n0(b.rx) + n0(b.tx)) - (n0(a.rx) + n0(a.tx)); });
		var list = apps.slice(0, TOP_APPS);

		var meta = apps.length ? '共 ' + apps.length + ' 个' : '';
		if (state && state.truncated) meta += meta ? ' · 已截断' : '已截断';
		setMeta(dom.appsMeta, meta);

		if (!list.length) {
			var emptyRow = el('tr');
			var emptyCell = el('td', 'placeholder', state ? '暂无应用数据（未启用 Clash 或无接管流量）' : '正在加载…');
			emptyCell.colSpan = 4;
			emptyRow.appendChild(emptyCell);
			body.appendChild(emptyRow);
			return;
		}

		list.forEach(function (item) {
			var host = str(item.host) || '未知域名';
			var row = el('tr');

			var hostCell = el('td');
			var main = el('span', 'cell-main', host);
			main.title = host;
			hostCell.appendChild(main);

			var chain = chainMeta(item.chain);
			var sub = el('span', 'cell-sub');
			sub.appendChild(badge(chain.text, chain.cls, str(item.chain)));
			hostCell.appendChild(sub);
			row.appendChild(hostCell);

			row.appendChild(el('td', 'num', fmtBytes(item.rx)));
			row.appendChild(el('td', 'num', fmtBytes(item.tx)));
			row.appendChild(el('td', 'num', String(n0(item.devices))));
			body.appendChild(row);
		});
	}

	/* ------------------------------------------------------------------ *
	 * 节点 / 出口
	 * ------------------------------------------------------------------ */
	function renderNodes() {
		var list = dom.nodesList;
		if (!list) return;
		clear(list);

		var state = app.state;
		var raw = (state && state.nodes && typeof state.nodes === 'object') ? state.nodes : null;

		if (!raw || !Object.keys(raw).length) {
			list.appendChild(el('p', 'node__empty', state ? '暂无出口节点数据' : '正在加载…'));
			setMeta(dom.nodesMeta, '');
			return;
		}

		var nodes = Object.keys(raw).map(function (name) {
			var item = raw[name] || {};
			return { name: name, rx: n0(item.rx), tx: n0(item.tx), total: n0(item.rx) + n0(item.tx) };
		});
		nodes.sort(function (a, b) { return b.total - a.total; });

		var sum = 0;
		nodes.forEach(function (node) { sum += node.total; });
		setMeta(dom.nodesMeta, '共 ' + nodes.length + ' 个');

		nodes.forEach(function (node, idx) {
			var box = el('div', 'node');
			var head = el('div', 'node__head');
			var nameWrap = el('div', 'node__name');

			if (node.name.toUpperCase() === 'DIRECT') {
				nameWrap.appendChild(badge('直连', 'badge badge--direct', 'DIRECT'));
			} else {
				setText(nameWrap, node.name);
				nameWrap.title = node.name;
			}
			head.appendChild(nameWrap);
			head.appendChild(el('span', 'node__total', fmtBytes(node.total)));
			box.appendChild(head);

			var percent = sum > 0 ? (node.total / sum * 100) : 0;
			var bar = el('div', 'node__bar');
			var fill = el('div', 'node__fill node__fill--' + (idx % 5));
			fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
			bar.appendChild(fill);
			box.appendChild(bar);

			var meta = el('div', 'node__meta');
			meta.appendChild(el('span', '', '↓ ' + fmtBytes(node.rx) + ' · ↑ ' + fmtBytes(node.tx)));
			meta.appendChild(el('span', '', fmtPct(percent)));
			box.appendChild(meta);

			list.appendChild(box);
		});
	}

	/* ------------------------------------------------------------------ *
	 * 健康与告警
	 * ------------------------------------------------------------------ */
	function reasonLabel(text) {
		var t = str(text).trim();
		var low = t.toLowerCase();

		if (low.indexOf('clash:') === 0) {
			if (t.indexOf('认证') >= 0 || /secret/i.test(t) || t.indexOf('401') >= 0 || t.indexOf('403') >= 0)
				return 'Clash 认证失败';
			if (t.indexOf('配置无效') >= 0 || t.indexOf('不支持') >= 0)
				return 'Clash 配置无效';
			if (t.indexOf('非预期') >= 0 || t.indexOf('JSON') >= 0)
				return 'Clash 返回异常';
			return 'clash 不可达';
		}
		if (low.indexOf('conntrack:') === 0) {
			if (t.indexOf('bytes') >= 0 || t.indexOf('acct') >= 0) return 'conntrack 缺计数';
			return 'conntrack 不可用';
		}
		if (low.indexOf('lan:') === 0) return 'LAN 未识别';
		if (low.indexOf('link:') === 0) return 'FDB 读取失败';
		if (low.indexOf('fake_ip:') === 0) return 'fake_ip 配置无效';
		return '其他告警';
	}

	function sourceChip(label, status) {
		var s = str(status).toLowerCase();
		var text = '未知';
		var cls = 'badge badge--unknown';
		if (s === 'ok') { text = '正常'; cls = 'badge badge--ok'; }
		else if (s === 'error') { text = '异常'; cls = 'badge badge--danger'; }

		var box = el('span', 'kv');
		box.appendChild(el('span', 'kv__k', label));
		box.appendChild(badge(text, cls));
		return box;
	}

	function renderHealth() {
		var state = app.state;
		var health = (state && state.health && typeof state.health === 'object') ? state.health : null;
		var source = (state && state.source && typeof state.source === 'object') ? state.source : {};

		var sources = dom.healthSources;
		clear(sources);

		if (!state || !health) {
			sources.appendChild(el('span', 'badge badge--unknown', '正在加载…'));
			clear(dom.healthReasons);
			dom.healthReasons.appendChild(el('p', 'node__empty', '正在读取面板数据…'));
			setMeta(dom.healthMeta, '');
			return;
		}

		sources.appendChild(sourceChip('Clash 采集', source.clash));
		sources.appendChild(sourceChip('conntrack', source.conntrack));

		var linkSource = str(health.link_source);
		var linkText = linkSource === 'brctl' ? 'FDB（brctl）' : (linkSource === 'none' || !linkSource ? '未启用' : linkSource);
		var linkBox = el('span', 'kv');
		linkBox.appendChild(el('span', 'kv__k', '接入方式'));
		linkBox.appendChild(badge(linkText, linkSource === 'brctl' ? 'badge badge--ok' : 'badge badge--unknown'));
		sources.appendChild(linkBox);

		sources.appendChild(kv('Clash 连接', String(n0(health.clash_connections))));
		sources.appendChild(kv('conntrack 记录', String(n0(health.conntrack_count))));

		if (health.poll_ms !== undefined) {
			sources.appendChild(kv('本轮采集', n0(health.poll_ms) + ' ms'));
		}
		if (Array.isArray(health.link_ports) && health.link_ports.length) {
			sources.appendChild(kv('无线端口', health.link_ports.join(' / ')));
		} else if (str(health.link_ports)) {
			sources.appendChild(kv('无线端口', str(health.link_ports)));
		}

		var reasons = Array.isArray(health.reasons) ? health.reasons.slice() : [];
		var linkError = str(health.link_error);
		if (linkError && reasons.indexOf(linkError) < 0) reasons.push(linkError);

		var reasonList = dom.healthReasons;
		clear(reasonList);

		setMeta(dom.healthMeta, reasons.length ? reasons.length + ' 条告警' : '无告警');

		if (!reasons.length) {
			var okBox = el('p', 'reasons__empty');
			okBox.appendChild(el('span', '', '✓'));
			okBox.appendChild(el('span', '', '未发现异常'));
			reasonList.appendChild(okBox);
			return;
		}

		reasons.forEach(function (reason) {
			if (reason === null || reason === undefined) return;
			var text = str(reason);
			if (!text) return;

			var row = el('div', 'reason');
			row.appendChild(el('span', 'reason__badge', reasonLabel(text)));
			row.appendChild(el('span', 'reason__text', text));
			reasonList.appendChild(row);
		});
	}

	/* ------------------------------------------------------------------ *
	 * 错误 / 令牌
	 * ------------------------------------------------------------------ */
	function errText(err) {
		if (!err) return '';
		if (err.kind === 'auth') {
			if (err.status === 403) return '面板服务拒绝了请求（HTTP 403）：令牌可能无效或无权限。';
			return '需要访问令牌：输入令牌后面板会自动重试（HTTP 401）。';
		}
		if (err.kind === 'timeout') {
			return '请求超时：面板服务在 ' + Math.round(REQUEST_TIMEOUT / 1000) + ' 秒内没有响应，可能正在采集或负载过高。';
		}
		if (err.kind === 'network') {
			return '无法连接到面板服务：请确认 8099 端口已监听，且本页与服务同源。';
		}
		return '请求失败：' + err.message;
	}

	function authMessage() {
		var err = app.lastErr;
		if (err && err.kind === 'auth') {
			if (err.status === 403) return '面板服务返回 403：令牌可能无效或无权限，请重新输入。';
			if (app.token) return '已保存的令牌被拒绝（HTTP 401），请重新输入面板令牌。';
			return '面板服务要求访问令牌（HTTP 401），输入后会自动重新加载。';
		}
		return '面板服务要求令牌。令牌只保存在本机浏览器中，用于请求本机面板接口。';
	}

	function renderNotices() {
		if (app.lastErr) {
			dom.errorBar.hidden = false;
			setText(dom.errorText, errText(app.lastErr));
		} else {
			dom.errorBar.hidden = true;
			setText(dom.errorText, '');
		}

		dom.authPanel.hidden = !app.authBlocked;
		if (app.authBlocked) {
			setText(dom.authDesc, authMessage());
			if (app.token && !dom.tokenInput.value) dom.tokenInput.value = app.token;
			if (!app.authFocused) {
				app.authFocused = true;
				try { dom.tokenInput.focus(); } catch (e) { /* 忽略 */ }
			}
		} else {
			app.authFocused = false;
			dom.tokenInput.value = '';
		}
	}

	/* ------------------------------------------------------------------ *
	 * 整体渲染
	 * ------------------------------------------------------------------ */
	function renderAll() {
		renderTopbar();
		renderCards();
		renderChart();
		renderDevices();
		renderApps();
		renderNodes();
		renderHealth();
		renderNotices();
	}

	/* ------------------------------------------------------------------ *
	 * 状态播报（只在用户动作与关键状态变化时播报，避免每 15s 打扰）
	 * ------------------------------------------------------------------ */
	function announce(text) {
		if (!dom.live) return;
		dom.live.textContent = text;
	}

	function announceState() {
		var state = app.state;
		if (!state) return;
		var totals = (state.totals && typeof state.totals === 'object') ? state.totals : {};
		announce('已更新：下载 ' + fmtRate(totals.rx_rate) + '，上传 ' + fmtRate(totals.tx_rate) + '。');
	}

	/* ------------------------------------------------------------------ *
	 * 加载
	 * ------------------------------------------------------------------ */
	function setBusy(busy) {
		if (!dom.refreshBtn) return;
		if (busy) dom.refreshBtn.classList.add('is-spinning');
		else dom.refreshBtn.classList.remove('is-spinning');
		dom.refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
		dom.refreshBtn.disabled = !!busy;
	}

	function load(manual) {
		if (app.inflight) {
			app.queue = true;
			if (manual) app.manual = true;
			return;
		}

		app.inflight = true;
		app.manual = !!manual;
		setBusy(true);
		renderTopbar();

		var needHistory = manual || !app.history || (Date.now() - app.historyAt) > HISTORY_REFRESH;

		fetchState().then(function (state) {
			if (!state || typeof state !== 'object') {
				throw { panelError: true, kind: 'parse', status: 200, message: '面板接口返回的数据结构异常' };
			}
			app.state = state;
			app.authBlocked = false;
			app.lastErr = null;
			app.lastOk = Date.now();
			recordSample(state);

			if (!needHistory) return null;
			return fetchHistory().then(function (history) {
				if (history && Array.isArray(history.days)) {
					app.history = history;
					app.historyAt = Date.now();
				}
			}, function () {
				/* 历史只是辅助数据，失败不打断主流程 */
			});
		}).catch(function (err) {
			var e = (err && err.panelError) ? err : {
				panelError: true,
				kind: 'network',
				status: 0,
				message: '无法连接到面板服务'
			};
			app.lastErr = e;
			if (e.kind === 'auth') app.authBlocked = true;
		}).then(function () {
			app.inflight = false;
			setBusy(false);
			renderAll();

			if (app.manual && !app.lastErr) announceState();
			if (app.lastErr && app.lastErr.kind === 'auth') announce('需要访问令牌，请先输入令牌。');

			if (app.queue) {
				app.queue = false;
				load(app.manual);
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * 定时器
	 * ------------------------------------------------------------------ */
	function stopTimer() {
		if (app.timer) {
			window.clearInterval(app.timer);
			app.timer = 0;
		}
	}

	function startTimer() {
		stopTimer();
		if (!app.auto) return;
		app.timer = window.setInterval(function () {
			if (document.hidden) return;
			load(false);
		}, AUTO_INTERVAL);
	}

	/* ------------------------------------------------------------------ *
	 * 事件
	 * ------------------------------------------------------------------ */
	function onRefreshClick() {
		announce('正在刷新数据…');
		load(true);
	}

	function onAutoChange() {
		app.auto = !!dom.autoInput.checked;
		storeAutoPref(app.auto);
		if (app.auto) {
			startTimer();
			announce('已开启自动刷新，每 15 秒一次。');
			load(false);
		} else {
			stopTimer();
			announce('已关闭自动刷新。');
		}
	}

	function onTokenSubmit(ev) {
		if (ev && ev.preventDefault) ev.preventDefault();
		var value = dom.tokenInput ? String(dom.tokenInput.value || '').trim() : '';
		if (!value) {
			setText(dom.authHint, '令牌不能为空。');
			return;
		}
		app.token = value;
		storeToken(value);
		app.authBlocked = false;
		app.lastErr = null;
		renderNotices();
		announce('已保存令牌，正在重试。');
		load(true);
	}

	function onTokenClear() {
		app.token = '';
		storeToken('');
		setText(dom.authHint, '已清除本机保存的令牌。');
		if (dom.tokenInput) dom.tokenInput.value = '';
		load(true);
	}

	function onVisibilityChange() {
		if (document.hidden) {
			stopTimer();
			return;
		}
		if (!app.auto) return;
		startTimer();
		if (!app.lastOk || (Date.now() - app.lastOk) > AUTO_INTERVAL) load(false);
	}

	function closestRow(node) {
		var current = node;
		while (current && current !== dom.devicesBody) {
			if (current.tagName === 'TR') return current;
			current = current.parentNode;
		}
		return null;
	}

	function onDevicesClick(ev) {
		var row = closestRow(ev.target);
		if (!row || row.className.indexOf('drow') < 0) return;
		toggleDeviceRow(row);
	}

	function setupThemeListener() {
		if (!window.matchMedia) return;
		var mq = window.matchMedia('(prefers-color-scheme: dark)');
		var handler = function () { drawChart(); };
		if (mq.addEventListener) mq.addEventListener('change', handler);
		else if (mq.addListener) mq.addListener(handler);
	}

	function setupResize() {
		window.addEventListener('resize', function () {
			if (resizeRaf) return;
			resizeRaf = window.requestAnimationFrame(function () {
				resizeRaf = 0;
				drawChart();
			});
		});
		if (window.ResizeObserver && dom.canvas && dom.canvas.parentNode) {
			var observer = new window.ResizeObserver(function () { drawChart(); });
			observer.observe(dom.canvas.parentNode);
		}
	}

	function bindEvents() {
		if (dom.refreshBtn) dom.refreshBtn.addEventListener('click', onRefreshClick);
		if (dom.errorRetry) dom.errorRetry.addEventListener('click', onRefreshClick);
		if (dom.autoInput) dom.autoInput.addEventListener('change', onAutoChange);
		if (dom.authForm) dom.authForm.addEventListener('submit', onTokenSubmit);
		if (dom.tokenClear) dom.tokenClear.addEventListener('click', onTokenClear);
		if (dom.devicesBody) dom.devicesBody.addEventListener('click', onDevicesClick);
		document.addEventListener('visibilitychange', onVisibilityChange);
	}

	/* ------------------------------------------------------------------ *
	 * 启动
	 * ------------------------------------------------------------------ */
	function cacheDom() {
		var ids = [
			'state-pill', 'confidence-pill', 'last-updated', 'refresh-btn', 'auto-refresh',
			'aria-live', 'error-bar', 'error-text', 'error-retry',
			'auth-panel', 'auth-desc', 'auth-form', 'token-input', 'token-clear', 'auth-hint',
			'card-rx', 'card-rx-sub', 'card-rx-unit', 'card-tx', 'card-tx-sub', 'card-tx-unit',
			'card-today', 'card-today-sub', 'card-month', 'card-month-sub',
			'card-devices', 'card-devices-unit', 'card-devices-sub',
			'card-clash', 'card-clash-sub',
			'chart-window', 'chart-meta', 'rate-chart', 'chart-empty', 'chart-legend-note',
			'nodes-meta', 'nodes-list',
			'devices-meta', 'devices-body',
			'apps-meta', 'apps-body',
			'health-meta', 'health-sources', 'health-reasons'
		];

		ids.forEach(function (id) {
			var node = document.getElementById(id);
			if (node) dom[camel(id)] = node;
		});

		dom.canvas = dom.rateChart;
		dom.live = dom.ariaLive;
		dom.autoInput = dom.autoRefresh;
	}

	function camel(id) {
		return id.replace(/-([a-z0-9])/g, function (m, ch) { return ch.toUpperCase(); });
	}

	function init() {
		cacheDom();

		var urlToken = takeUrlToken();
		app.token = urlToken || readStoredToken();
		if (urlToken) storeToken(urlToken);

		app.auto = readAutoPref();
		if (dom.autoInput) dom.autoInput.checked = app.auto;

		bindEvents();
		setupThemeListener();
		setupResize();

		renderAll();
		load(false);
		startTimer();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
