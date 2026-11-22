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
	/* 家长控制写接口：只接受 POST + JSON，令牌放在请求体，绝不进地址栏。 */
	var CONTROL_BASE = '/cgi-bin/prism-router-control';
	var TOKEN_KEY = 'prism-router-panel-token';
	var AUTO_KEY = 'prism-router-panel-autorefresh';

	var AUTO_INTERVAL = 15000;      /* 自动刷新间隔（毫秒） */
	var REQUEST_TIMEOUT = 12000;    /* 单次请求超时 */
	var MAX_SAMPLES = 60;           /* 页面本地滚动窗口 */
	var TOP_DEVICES = 10;
	var TOP_APPS = 10;
	var TOP_DEVICE_APPS = 5;
	var ONLINE_WINDOW = 600;        /* 秒：近 10 分钟有活动才算在线（用真实时钟，不拿 state.ts 当 now） */
	var FUTURE_SKEW = 60;           /* 秒：last_seen 最多容忍的未来偏差 */
	var COMPACT_MQ = '(max-width: 760px)'; /* 与 style.css 的移动断点一致 */
	var DEVICE_PREVIEW = 3;         /* 手机默认只看 Top 3，其余走「查看全部」 */
	var APP_PREVIEW = 5;            /* 手机默认只看 Top 5 */
	var NODE_PREVIEW = 5;           /* 出口节点默认 Top 5（桌面与手机一致） */
	var LIST_MAX = 50;              /* 「查看全部」的单次渲染上限，避免一次插入上百行 */
	var HISTORY_DAYS = 7;
	var HISTORY_REFRESH = 300000;   /* 历史数据 5 分钟刷新一次 */
	var NODES_REFRESH = 300000;     /* 节点上报状态 5 分钟刷新一次 */
	var SETTINGS_REFRESH = 300000;  /* 只读设置 5 分钟刷新一次 */

	/* 告警中心阈值（与 SPEC/需求保持一致） */
	var ALERT_STALE_SEC = 90;       /* 数据陈旧：now - ts > 90s */
	var ALERT_NODE_STALE_SEC = 300; /* 节点上报超时：age_sec > 300s */
	var ALERT_QUOTA_WARN = 0.8;     /* 配额接近：>= 80% */
	var ALERT_UNKNOWN_ONLINE = 3;   /* 未知接入设备较多：在线 > 3 台 */
	var ALERT_MAX = 8;              /* 告警中心最多展示条数 */
	var ALERT_DEVICE_NAMES = 3;     /* 离线/节点告警详情最多列出的名字数 */
	var ALERT_FLASH_MS = 2000;      /* 点击告警后的高亮时长 */

	/* 移动端：底部导航 / 下拉刷新 / 离线提示 */
	var PULL_TRIGGER = 64;          /* 下拉超过这个距离（像素）才触发刷新 */
	var PULL_MAX = 96;              /* 指示器最大位移，避免越拉越远 */
	var PULL_DAMPING = 0.55;        /* 下拉阻尼：手指位移的 55% 计入指示器 */
	var TAB_LOCK_MS = 700;          /* 点击 tab 后锁定高亮，避免平滑滚动途中来回跳 */
	var TAB_PROBE_GAP = 20;         /* 区块顶部越过顶栏底边多少像素算「当前区块」 */
	var NET_REFRESH_MIN = 1500;     /* 网络恢复后的刷新去抖 */

	/* 家长控制（暂停 / 恢复设备上网） */
	var GUARD_DESC = '暂停后该设备的所有转发流量会被丢弃（nftables），恢复后立即生效；规则重启后自动重放。';
	var GUARD_OFF_HINT = '默认关闭，因此不显示暂停按钮。启用需要在路由器上设置 panel.write_enabled=1 并配置 panel.token，重启面板服务后生效。';
	var GUARD_NO_TOKEN_HINT = '家长控制已开启，但面板未设置令牌：请先在 UCI 里设置 prism-router 的 panel.token 并重启面板服务，之后才能暂停设备。';
	var GUARD_UNAVAILABLE_HINT = '暂时读不到家长控制开关（设置接口不可用），因此不显示暂停按钮。';
	var GUARD_LOADING_HINT = '正在读取家长控制开关…';
	var GUARD_TOKEN_PROMPT = '暂停 / 恢复设备上网需要面板访问令牌。令牌只保存在本机浏览器中，不会出现在地址栏里。';

	/* 失败提示一律走白名单文案：不回显服务端原始响应。 */
	var GUARD_ERR_TEXT = {
		write_disabled: '家长控制未开启（面板已禁用写操作），暂时不能执行该操作。',
		forbidden: '令牌无效或没有权限执行该操作。',
		protected_target: '出于安全考虑，路由器自身与网关设备不能被暂停。',
		bad_request: '设备地址无效，无法执行该操作。',
		internal: '路由器执行失败，请稍后重试。',
		network: '无法连接到面板服务，请检查网络后重试。',
		timeout: '请求超时：路由器没有在预期时间内响应。',
		unknown: '操作失败，请稍后重试。'
	};

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
		nodes: null,
		nodesAt: 0,
		settings: null,
		settingsAt: 0,
		settingsBusy: false,
		settingsError: null,
		/* 用户主动展开/收起的设置分组；15s 自动刷新不得重置选择和焦点语义。 */
		settingsOpen: {},
		samples: [],
		prevTotals: null,
		lastSampleTs: 0,
		expanded: {},
		/* Top 列表的「查看全部」状态：手机默认折叠，桌面设备/应用仍显示 Top 10 */
		more: { devices: false, apps: false, nodes: false },
		manual: false,
		offlineSeen: false,     /* 是否已经因为断网提示过（用于恢复后只刷新一次） */
		lastRecoverAt: 0,
		tokenPrompt: '',        /* 非 401 原因要求输入令牌时的说明（复用令牌面板） */
		guard: {
			paused: {},         /* 归一化 MAC -> handle */
			listBusy: false,
			listAt: 0,
			listError: null,
			busyMac: '',
			target: null,       /* 待确认 {mac, name, isPaused} */
			error: '',          /* 确认框内展示的错误码 */
			pending: null       /* 缺令牌时暂存的动作，保存令牌后继续确认 */
		}
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

	/* /what=nodes 的节点列表带 age_sec（子节点上报新鲜度），用于告警中心。 */
	function fetchNodes() {
		return requestJson(apiUrl('nodes'));
	}

	/* /what=settings 的只读投影（只含非敏感项，写操作恒为未开放）。 */
	function fetchSettings() {
		return requestJson(apiUrl('settings'));
	}

	/* ------------------------------------------------------------------ *
	 * 家长控制：能力判定 / 暂停集合 / 写请求
	 * ------------------------------------------------------------------ */
	function truthyFlag(v) {
		if (v === true || v === 1) return true;
		var s = str(v).trim().toLowerCase();
		return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'enabled';
	}

	function guardPanelCfg() {
		var data = app.settings;
		var panel = (data && data.panel && typeof data.panel === 'object') ? data.panel : null;
		var write = (data && data.write && typeof data.write === 'object') ? data.write : null;
		if (!panel && app.state && app.state.panel && typeof app.state.panel === 'object') {
			panel = app.state.panel;   /* 兼容：某些版本把面板信息挂在 state 上 */
		}
		return { panel: panel || {}, write: write || {} };
	}

	/* 契约：只有 panel.write_enabled=1 且 panel.token 非空时写接口可用。
	   只读投影不回传令牌原值，因此用 has_token 判断「已设令牌」。 */
	function guardStatus() {
		var cfg = guardPanelCfg();
		var panel = cfg.panel;
		var writeEnabled = truthyFlag(panel.write_enabled);
		/* 兼容：仅当没有 write_enabled 字段时才参考 write.enabled */
		if (panel.write_enabled === undefined && cfg.write.enabled === true) writeEnabled = true;
		var hasToken = truthyFlag(panel.has_token) || truthyFlag(panel.token_set) ||
			(typeof panel.token === 'string' && panel.token.length > 0);
		var ready = !!(app.settings || (app.state && app.state.panel));

		if (!ready) {
			return {
				key: app.settingsError ? 'unavailable' : 'loading',
				enabled: false, writeEnabled: false, hasToken: false
			};
		}
		if (!writeEnabled) {
			return { key: 'off', enabled: false, writeEnabled: false, hasToken: hasToken };
		}
		if (!hasToken) {
			return { key: 'notoken', enabled: false, writeEnabled: true, hasToken: false };
		}
		return { key: 'on', enabled: true, writeEnabled: true, hasToken: true };
	}

	function guardEnabled() {
		return guardStatus().enabled;
	}

	var MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

	/* 归一化 MAC：大小写、'-' 与 ':' 差异都抹平；非法值返回空串（不写入对象键）。 */
	function normMac(v) {
		var s = str(v).trim().toLowerCase().replace(/-/g, ':');
		return MAC_RE.test(s) ? s : '';
	}

	function isPaused(mac) {
		var key = normMac(mac);
		return !!key && Object.prototype.hasOwnProperty.call(app.guard.paused, key);
	}

	function setPaused(mac, on) {
		var key = normMac(mac);
		if (!key) return;
		if (on) app.guard.paused[key] = true;
		else delete app.guard.paused[key];
	}

	function applyPaused(list) {
		var next = {};
		if (Array.isArray(list)) {
			list.forEach(function (item) {
				var raw = (item && typeof item === 'object') ? item.mac : item;
				var key = normMac(raw);
				if (key) next[key] = (item && typeof item === 'object') ? str(item.handle) : '';
			});
		}
		app.guard.paused = next;
	}

	function pausedCount() {
		return Object.keys(app.guard.paused).length;
	}

	function guardErrorText(code) {
		return GUARD_ERR_TEXT[code] || GUARD_ERR_TEXT.unknown;
	}

	function controlCode(raw) {
		var s = str(raw).trim().toLowerCase();
		if (s === 'write_disabled' || s === 'forbidden' || s === 'protected_target' ||
			s === 'bad_request' || s === 'internal') {
			return s;
		}
		return 'internal';
	}

	function controlError(code, status) {
		return { ctrlError: true, code: code, status: n0(status) };
	}

	/* 写接口：POST + JSON。令牌只放在 body，永远不出现在 URL。 */
	function controlPost(payload) {
		var opts = {
			method: 'POST',
			credentials: 'same-origin',
			cache: 'no-store',
			referrerPolicy: 'no-referrer',
			headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
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

		return window.fetch(CONTROL_BASE, opts).then(function (res) {
			return res.text().then(function (text) {
				var data = null;
				if (text) {
					try { data = JSON.parse(text); } catch (e) { data = null; }
				}
				if (data && typeof data === 'object' && typeof data.error === 'string') {
					throw controlError(controlCode(data.error), res.status);
				}
				if (res.status === 401 || res.status === 403) throw controlError('forbidden', res.status);
				if (!res.ok) throw controlError('internal', res.status);
				if (!data || typeof data !== 'object' || data.ok !== true) {
					throw controlError('internal', res.status);
				}
				return data;
			});
		}).then(function (data) {
			if (timer) window.clearTimeout(timer);
			return data;
		}, function (err) {
			if (timer) window.clearTimeout(timer);
			if (err && err.ctrlError) throw err;
			var timeout = err && err.name === 'AbortError';
			throw controlError(timeout ? 'timeout' : 'network', 0);
		});
	}

	/* 每次加载 state 时同步暂停集合：失败静默，绝不阻塞主流程。 */
	function syncPaused() {
		if (app.guard.listBusy) return;
		if (!guardEnabled() || !app.token) return;

		app.guard.listBusy = true;
		controlPost({ token: app.token, action: 'list' }).then(function (data) {
			applyPaused(data ? data.paused : null);
			app.guard.listAt = Date.now();
			app.guard.listError = null;
		}, function (err) {
			app.guard.listError = (err && err.code) ? err.code : 'internal';
		}).then(function () {
			app.guard.listBusy = false;
			paintGuardButtons();
		});
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

	/* 在线口径：一律对真实时钟（不把 state.ts 当 now）。
	   - 有 last_seen：与 now 相差 ≤ 10 分钟即在线，最多容忍 FUTURE_SKEW 秒未来偏差；
	   - 没有 last_seen：只有本轮 state 采样仍然新鲜、且设备当前仍有速率时才计入在线。 */
	function isOnline(dev, state) {
		if (!dev) return false;
		var seen = toSec(dev.last_seen);
		var now = nowSec();
		if (seen > 0) return seen <= now + FUTURE_SKEW && now - seen <= ONLINE_WINDOW;
		var ts = toSec(state && state.ts);
		var fresh = ts > 0 && Math.abs(now - ts) <= ALERT_STALE_SEC;
		return fresh && (n0(dev.rx_rate) + n0(dev.tx_rate)) > 0;
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
		setText(dom.cardDevicesSub, devices.length ? '近 10 分钟有活动的设备' : '暂无设备数据');

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
				grid: '#26304a', axis: '#46536e', text: '#8595b2',
				rx: '#7aa2ff', tx: '#35d6e6',
				rxTop: 'rgba(122, 162, 255, .30)', rxBottom: 'rgba(122, 162, 255, 0)',
				dot: '#0f1420'
			};
		}
		return {
			grid: '#e6ecf6', axis: '#b8c4d6', text: '#5b6b82',
			rx: '#2563eb', tx: '#0c6a84',
			rxTop: 'rgba(37, 99, 235, .26)', rxBottom: 'rgba(37, 99, 235, 0)',
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
		var cssH = Math.max(100, Math.round(canvas.clientHeight || 240));
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
		/* 空图收成一条 120px 以内的占位，避免首屏被空画布占掉半屏（CSS 兜底 :has 同款）。 */
		var chartBox = dom.canvas && dom.canvas.parentNode;
		if (chartBox && chartBox.classList) chartBox.classList.toggle('is-empty', !hasData);
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

	/* 设备榜与告警中心共用同一排序与 key，保证点击告警能定位到对应行。 */
	function sortedDevices(state) {
		var devices = (state && Array.isArray(state.devices)) ? state.devices.slice() : [];
		devices.sort(function (a, b) { return devTotal(b) - devTotal(a); });
		return devices;
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

	/* 手机默认只看前几项，桌面仍是 Top 10；「查看全部」展开到 LIST_MAX。
	   断点与 style.css 的 760px 保持一致。 */
	function isCompactViewport() {
		try { return !!(window.matchMedia && window.matchMedia(COMPACT_MQ).matches); }
		catch (e) { return false; }
	}

	function basePreviewLimit(kind, total) {
		var count = Math.max(0, n0(total));
		if (kind === 'devices') return Math.min(count, isCompactViewport() ? DEVICE_PREVIEW : TOP_DEVICES);
		if (kind === 'apps') return Math.min(count, isCompactViewport() ? APP_PREVIEW : TOP_APPS);
		return Math.min(count, NODE_PREVIEW);
	}

	function previewLimit(kind, total) {
		var count = Math.max(0, n0(total));
		return app.more[kind] ? Math.min(count, LIST_MAX) : basePreviewLimit(kind, count);
	}

	function updateMoreButton(btn, kind, total) {
		if (!btn) return;
		var count = Math.max(0, n0(total));
		var base = basePreviewLimit(kind, count);
		var expanded = !!app.more[kind];
		/* 是否显示按钮看「默认条数」而不是当前条数：展开后仍要能「收起」。 */
		var hasOverflow = count > base;

		btn.hidden = !hasOverflow;
		setText(btn, expanded ? '收起' : '查看全部');
		btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		btn.title = expanded
			? '收起列表，回到默认的 ' + base + ' 项'
			: '展开到 ' + Math.min(count, LIST_MAX) + ' 项（最多 ' + LIST_MAX + ' 项）';
	}

	function bindMore(btn, kind, rerender) {
		if (!btn) return;
		btn.addEventListener('click', function () {
			app.more[kind] = !app.more[kind];
			rerender();
			announce(app.more[kind] ? '已展开全部列表。' : '已收起列表。');
		});
	}

	function renderDevices() {
		var body = dom.devicesBody;
		if (!body) return;
		clear(body);

		var state = app.state;
		var devices = sortedDevices(state);
		var list = devices.slice(0, previewLimit('devices', devices.length));

		var meta = devices.length ? '共 ' + devices.length + ' 台' : '';
		if (list.length && list.length < devices.length) meta += ' · 显示 ' + list.length;
		if (state && state.truncated) meta += meta ? ' · 已截断' : '已截断';
		setMeta(dom.devicesMeta, meta);
		updateMoreButton(dom.devicesMore, 'devices', devices.length);

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

			var nameCell = el('td', 'cell-name');
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

			/* 家长控制：仅开关开启且设备有 MAC 时提供暂停 / 恢复入口 */
			if (guardEnabled() && normMac(dev.mac)) {
				var guardBtn = el('button', 'btn btn--small guard-btn');
				guardBtn.type = 'button';
				setGuardButton(guardBtn, name, str(dev.mac), isPaused(dev.mac));
				guardBtn.addEventListener('click', onGuardClick);
				nameWrap.appendChild(guardBtn);
			}

			nameWrap.appendChild(btn);
			nameCell.appendChild(nameWrap);
			row.appendChild(nameCell);

			var linkCell = el('td', 'col-link cell-link');
			linkCell.setAttribute('data-label', '接入');
			var link = linkMeta(dev.link);
			linkCell.appendChild(badge(link.text, link.cls));
			row.appendChild(linkCell);

			var speedCell = el('td', 'num col-speed cell-speed');
			speedCell.setAttribute('data-label', '上下行');
			speedCell.appendChild(el('span', 'speed speed--down', '↓ ' + fmtRate(dev.rx_rate)));
			speedCell.appendChild(el('span', 'speed speed--up', '↑ ' + fmtRate(dev.tx_rate)));
			row.appendChild(speedCell);

			var totalCell = el('td', 'num cell-total', fmtBytes(devTotal(dev)));
			totalCell.setAttribute('data-label', '累计');
			row.appendChild(totalCell);

			var monthCell = el('td', 'num cell-month',
				dev.month_total === undefined ? '—' : fmtBytes(dev.month_total));
			monthCell.setAttribute('data-label', '本月');
			row.appendChild(monthCell);

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
	 * 家长控制 UI：设备行按钮 / 设置区状态 / 确认框
	 * 说明：设备行按钮只改自身文案与 aria 状态，不重建表格。
	 * ------------------------------------------------------------------ */
	var guardModalLastFocus = null;

	function guardStatusMeta() {
		var status = guardStatus();
		if (status.key === 'on') return { text: '已开启', cls: 'guard__status--on' };
		if (status.key === 'notoken') return { text: '已开启但未设令牌', cls: 'guard__status--warn' };
		if (status.key === 'off') return { text: '未开启', cls: 'guard__status--off' };
		if (status.key === 'unavailable') return { text: '状态不可用', cls: 'guard__status--off' };
		return { text: '正在读取…', cls: 'guard__status--off' };
	}

	function guardMetaText() {
		var count = pausedCount();
		if (!count) return '当前没有设备被暂停 · 每次加载自动同步暂停列表';
		return '已暂停 ' + count + ' 台设备 · 每次加载自动同步暂停列表';
	}

	function setGuardButton(btn, name, mac, paused) {
		if (!btn) return;
		var displayName = name || '该设备';
		var busy = !!app.guard.busyMac && normMac(app.guard.busyMac) === normMac(mac);
		var label = (paused ? '恢复 ' : '暂停 ') + displayName + ' 的上网';

		setText(btn, busy ? '处理中…' : (paused ? '恢复' : '暂停'));
		btn.disabled = busy;
		if (busy) btn.setAttribute('aria-busy', 'true');
		else btn.removeAttribute('aria-busy');
		btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
		btn.setAttribute('aria-label', label);
		btn.setAttribute('data-name', displayName);
		btn.setAttribute('data-mac', mac);
		btn.title = label;
		if (paused) btn.classList.add('is-paused');
		else btn.classList.remove('is-paused');
	}

	/* list 回来或动作完成后，只就地刷新按钮，不整页重建。 */
	function paintGuardButtons() {
		if (dom.devicesBody) {
			var btns = dom.devicesBody.querySelectorAll('.guard-btn');
			for (var i = 0; i < btns.length; i++) {
				var mac = btns[i].getAttribute('data-mac') || '';
				setGuardButton(btns[i], btns[i].getAttribute('data-name') || '该设备', mac, isPaused(mac));
			}
		}
		paintGuardMeta();
	}

	function paintGuardMeta() {
		if (!dom.settingsBody) return;
		var meta = dom.settingsBody.querySelector('.guard__meta');
		if (meta) setText(meta, guardMetaText());
	}

	/* 家长控制详细说明：默认收起，summary 上保留当前状态标签；
	   展开后仍是完整的状态行 + 说明 + 提示（内容不丢失）。 */
	function guardSettingsGroup() {
		var status = guardStatus();
		var metaState = guardStatusMeta();

		var chip = el('span', 'guard__status ' + metaState.cls, metaState.text);
		chip.title = '家长控制：' + metaState.text;
		var group = settingsDetails('家长控制', false, chip, true);

		var box = el('div', 'guard');

		var head = el('div', 'guard__head');
		head.appendChild(el('span', 'guard__label', '当前状态'));
		head.appendChild(el('span', 'guard__status ' + metaState.cls, metaState.text));
		box.appendChild(head);

		box.appendChild(el('p', 'guard__desc', GUARD_DESC));

		if (status.key === 'on') {
			box.appendChild(el('p', 'guard__meta', guardMetaText()));
			box.appendChild(el('p', 'guard__hint',
				'在设备榜的每台设备右侧点「暂停」即可切断它的转发流量；已暂停的设备显示「恢复」。'));
		} else {
			var hint = el('p', 'guard__note');
			if (status.key === 'notoken') hint.textContent = GUARD_NO_TOKEN_HINT;
			else if (status.key === 'off') hint.textContent = GUARD_OFF_HINT;
			else if (status.key === 'unavailable') hint.textContent = GUARD_UNAVAILABLE_HINT;
			else hint.textContent = GUARD_LOADING_HINT;
			box.appendChild(hint);
		}

		group.body.appendChild(box);
		return group.details;
	}

	/* ---- 确认框 ---- */
	function paintGuardModal() {
		var target = app.guard.target;
		if (!target || !dom.guardModal) return;

		setText(dom.guardTitle, target.isPaused ? '恢复该设备上网' : '暂停该设备上网');
		if (dom.guardTarget) {
			clear(dom.guardTarget);
			dom.guardTarget.appendChild(el('span', 'modal__name', target.name || '该设备'));
			if (str(target.mac)) dom.guardTarget.appendChild(el('span', 'modal__mac', str(target.mac)));
		}
		setText(dom.guardDesc, GUARD_DESC);

		var busy = !!app.guard.busyMac;
		var hasErr = !!app.guard.error;
		if (dom.guardError) {
			dom.guardError.hidden = !hasErr;
			setText(dom.guardError, hasErr ? guardErrorText(app.guard.error) : '');
		}
		if (dom.guardConfirm) {
			setText(dom.guardConfirm, busy ? '处理中…' : (target.isPaused ? '确认恢复' : '确认暂停'));
			dom.guardConfirm.disabled = busy;
			dom.guardConfirm.setAttribute('aria-busy', busy ? 'true' : 'false');
		}
		if (dom.guardCancel) dom.guardCancel.disabled = busy;
	}

	function onGuardModalKey(ev) {
		if (!dom.guardModal || dom.guardModal.hidden) return;

		if (ev.key === 'Escape' || ev.key === 'Esc') {
			ev.preventDefault();
			if (!app.guard.busyMac) closeGuardModal();
			return;
		}
		if (ev.key !== 'Tab') return;

		var items = [];
		if (dom.guardCancel && !dom.guardCancel.disabled) items.push(dom.guardCancel);
		if (dom.guardConfirm && !dom.guardConfirm.disabled) items.push(dom.guardConfirm);
		if (!items.length) return;

		var first = items[0];
		var last = items[items.length - 1];
		if (ev.shiftKey && document.activeElement === first) {
			ev.preventDefault();
			try { last.focus(); } catch (e) { /* 忽略 */ }
		} else if (!ev.shiftKey && document.activeElement === last) {
			ev.preventDefault();
			try { first.focus(); } catch (e) { /* 忽略 */ }
		}
	}

	function openGuardModal(target) {
		if (!dom.guardModal || !target) return;
		app.guard.target = target;
		app.guard.error = '';
		guardModalLastFocus = document.activeElement;

		paintGuardModal();
		dom.guardModal.hidden = false;
		document.body.classList.add('is-modal-open');
		document.addEventListener('keydown', onGuardModalKey, true);
		try { dom.guardCancel.focus(); } catch (e) { /* 忽略 */ }
		announce((target.isPaused ? '恢复 ' : '暂停 ') + (target.name || '该设备') + '上网，请确认。');
	}

	function closeGuardModal() {
		if (!dom.guardModal) return;
		dom.guardModal.hidden = true;
		document.body.classList.remove('is-modal-open');
		document.removeEventListener('keydown', onGuardModalKey, true);
		app.guard.target = null;
		app.guard.error = '';

		var back = guardModalLastFocus;
		guardModalLastFocus = null;
		if (back && back.focus && document.contains(back)) {
			try { back.focus(); } catch (e) { /* 忽略 */ }
		}
	}

	function showTokenPrompt(text, message) {
		app.tokenPrompt = text;
		renderNotices();
		/* 令牌面板在页面顶部：动作发生在设备榜时把用户带过去，避免以为「按了没反应」。 */
		scrollToNode(dom.authPanel, 'center');
		try { if (dom.tokenInput) dom.tokenInput.focus(); } catch (e) { /* 忽略 */ }
		if (message) announce(message);
	}

	function requestGuardToken() {
		showTokenPrompt(GUARD_TOKEN_PROMPT, '需要访问令牌，请先输入令牌。');
	}

	function onGuardClick(ev) {
		if (ev) {
			if (ev.preventDefault) ev.preventDefault();
			if (ev.stopPropagation) ev.stopPropagation();   /* 不要触发展开 / 收起 */
		}
		var node = (ev && ev.currentTarget) ? ev.currentTarget : this;
		var mac = node ? node.getAttribute('data-mac') || '' : '';
		var name = node ? node.getAttribute('data-name') || '该设备' : '该设备';
		if (!mac) return;

		var target = { mac: mac, name: name, isPaused: isPaused(mac) };
		if (!app.token) {
			app.guard.pending = target;
			requestGuardToken();
			return;
		}
		openGuardModal(target);
	}

	function onGuardConfirm() {
		var target = app.guard.target;
		if (!target || app.guard.busyMac) return;
		if (!app.token) {
			app.guard.pending = { mac: target.mac, name: target.name, isPaused: target.isPaused };
			closeGuardModal();
			requestGuardToken();
			return;
		}
		runGuardAction(target);
	}

	function runGuardAction(target) {
		var action = target.isPaused ? 'resume' : 'pause';

		app.guard.busyMac = target.mac;
		app.guard.error = '';
		paintGuardModal();
		paintGuardButtons();

		controlPost({ token: app.token, action: action, mac: target.mac }).then(function (data) {
			app.guard.busyMac = '';
			if (Array.isArray(data.paused)) applyPaused(data.paused);
			else setPaused(target.mac, action === 'pause');

			closeGuardModal();
			paintGuardButtons();
			renderSettings();
			announce((action === 'pause' ? '已暂停 ' : '已恢复 ') + (target.name || '该设备') + '的上网。');
		}, function (err) {
			app.guard.busyMac = '';
			var code = (err && err.code) ? err.code : 'internal';

			/* 令牌被拒绝：复用令牌面板，保存后自动回到这次操作。 */
			if (code === 'forbidden') {
				app.guard.pending = { mac: target.mac, name: target.name, isPaused: target.isPaused };
				closeGuardModal();
				paintGuardButtons();
				showTokenPrompt('已保存的令牌被拒绝（HTTP 403）：请重新输入面板令牌，保存后会自动继续这次操作。',
					'令牌被拒绝，请重新输入。');
				return;
			}

			app.guard.error = code;
			paintGuardModal();
			paintGuardButtons();
			announce(guardErrorText(code));
			if (code === 'write_disabled') loadSettings(true);
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
		var list = apps.slice(0, previewLimit('apps', apps.length));

		var meta = apps.length ? '共 ' + apps.length + ' 个' : '';
		if (list.length && list.length < apps.length) meta += ' · 显示 ' + list.length;
		if (state && state.truncated) meta += meta ? ' · 已截断' : '已截断';
		setMeta(dom.appsMeta, meta);
		updateMoreButton(dom.appsMore, 'apps', apps.length);

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

			var hostCell = el('td', 'cell-host');
			hostCell.setAttribute('data-label', '域名');
			var main = el('span', 'cell-main', host);
			main.title = host;
			hostCell.appendChild(main);

			var chain = chainMeta(item.chain);
			var sub = el('span', 'cell-sub');
			sub.appendChild(badge(chain.text, chain.cls, str(item.chain)));
			hostCell.appendChild(sub);
			row.appendChild(hostCell);

			var rxCell = el('td', 'num cell-dl', fmtBytes(item.rx));
			rxCell.setAttribute('data-label', '下载');
			row.appendChild(rxCell);

			var txCell = el('td', 'num cell-ul', fmtBytes(item.tx));
			txCell.setAttribute('data-label', '上传');
			row.appendChild(txCell);

			var devCell = el('td', 'num cell-devices', String(n0(item.devices)));
			devCell.setAttribute('data-label', '设备数');
			row.appendChild(devCell);
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
			updateMoreButton(dom.nodesMore, 'nodes', 0);
			return;
		}

		var nodes = Object.keys(raw).map(function (name) {
			var item = raw[name] || {};
			return { name: name, rx: n0(item.rx), tx: n0(item.tx), total: n0(item.rx) + n0(item.tx) };
		});
		nodes.sort(function (a, b) { return b.total - a.total; });

		var sum = 0;
		nodes.forEach(function (node) { sum += node.total; });
		var shown = nodes.slice(0, previewLimit('nodes', nodes.length));
		var nodesMeta = '共 ' + nodes.length + ' 个';
		if (shown.length < nodes.length) nodesMeta += ' · 显示 ' + shown.length;
		setMeta(dom.nodesMeta, nodesMeta);
		updateMoreButton(dom.nodesMore, 'nodes', nodes.length);

		shown.forEach(function (node, idx) {
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
	 * 告警中心（完全在前端从 state / nodes 计算）
	 * ------------------------------------------------------------------ */
	var SEVERITY_RANK = { danger: 0, warn: 1, info: 2 };

	function nowSec() {
		return Math.floor(Date.now() / 1000);
	}

	/* 采集源状态：只有明确的非 ok 值才算异常；字段缺失按"未知"处理，不误报。 */
	function sourceBad(value) {
		var s = str(value).toLowerCase();
		return s !== '' && s !== 'ok';
	}

	function pushNodeAge(out, seen, name, age) {
		var label = str(name).trim();
		if (!label) return;
		var value = Number(age);
		if (!isFinite(value) || value <= ALERT_NODE_STALE_SEC) return;
		if (seen[label]) return;
		seen[label] = true;
		out.push({ name: label, age: value });
	}

	/* 优先用 ?what=nodes 的 age_sec；同时兼容 state.nodes 直接带 age_sec/ts 的形态。 */
	function collectStaleNodes(state, now) {
		var out = [];
		var seen = {};

		function scanList(list) {
			if (!Array.isArray(list)) return;
			list.forEach(function (item) {
				if (!item || typeof item !== 'object') return;
				var name = str(item.name) || str(item.node_name) || str(item.node_id);
				var age = item.age_sec;
				if (age === undefined || age === null) {
					var itemTs = toSec(item.ts);
					if (itemTs > 0) age = now - itemTs;
				}
				pushNodeAge(out, seen, name, age);
			});
		}

		if (app.nodes && typeof app.nodes === 'object') scanList(app.nodes.nodes);

		var local = state && state.nodes;
		if (Array.isArray(local)) {
			scanList(local);
		} else if (local && typeof local === 'object') {
			scanList(local.nodes);
			Object.keys(local).forEach(function (name) {
				if (name === 'nodes') return;
				var item = local[name];
				if (!item || typeof item !== 'object') return;
				var age = item.age_sec;
				if (age === undefined || age === null) {
					var itemTs = toSec(item.ts);
					if (itemTs > 0) age = now - itemTs;
				}
				pushNodeAge(out, seen, name, age);
			});
		}

		out.sort(function (a, b) { return b.age - a.age; });
		return out;
	}

	function buildAlerts(state) {
		var out = [];
		var now = nowSec();
		var health = (state && state.health && typeof state.health === 'object') ? state.health : {};
		var source = (state && state.source && typeof state.source === 'object') ? state.source : {};
		var devices = sortedDevices(state);

		/* 1) 记账不可用 */
		if (str(health.accounting_confidence).toLowerCase() === 'unavailable') {
			out.push({
				severity: 'danger',
				title: '记账不可用',
				detail: '记账可信度为「不可用」，流量分账结果可能缺失。',
				target: { type: 'health' }
			});
		}

		/* 2) 数据源不可用 */
		var failedSources = [];
		if (sourceBad(source.clash)) failedSources.push('Clash');
		if (sourceBad(source.conntrack)) failedSources.push('conntrack');
		if (failedSources.length) {
			out.push({
				severity: 'danger',
				title: '数据源不可用',
				detail: '采集源异常：' + failedSources.join(' / ') + '，流量统计可能不完整。',
				target: { type: 'health' }
			});
		}

		/* 3) 数据陈旧 */
		var ts = toSec(state.ts);
		if (ts > 0) {
			var age = now - ts;
			if (age > ALERT_STALE_SEC) {
				out.push({
					severity: 'warn',
					title: '数据陈旧',
					detail: '最近一次更新在 ' + age + ' 秒前（阈值 ' + ALERT_STALE_SEC + ' 秒），当前内容可能已过期。',
					target: { type: 'health' }
				});
			}
		}

		/* 4)/5) 月配额超限 / 接近上限 */
		devices.forEach(function (dev, idx) {
			var limit = n0(dev.quota_limit);
			if (!(limit > 0)) return;

			var used = n0(dev.month_total);
			var ratio = used / limit;
			if (ratio < ALERT_QUOTA_WARN) return;

			var over = ratio >= 1;
			out.push({
				severity: over ? 'danger' : 'warn',
				title: over ? '配额超限' : '配额接近上限',
				detail: deviceName(dev) + ' 本月 ' + fmtPct(ratio * 100) +
					'（' + fmtBytes(used) + ' / ' + fmtBytes(limit) + '）',
				target: { type: 'devices', keys: [ deviceKey(dev, idx) ] }
			});
		});

		/* 6) 设备离线：只对「有过 last_seen 且确实超过 10 分钟」的设备报警；
		   没有 last_seen 或时间戳在未来偏差内的设备不误报。 */
		var offline = [];
		devices.forEach(function (dev, idx) {
			var seen = toSec(dev.last_seen);
			if (!(seen > 0)) return;
			if (seen > now + FUTURE_SKEW) return;
			if (now - seen <= ONLINE_WINDOW) return;
			offline.push({ name: deviceName(dev), key: deviceKey(dev, idx) });
		});
		if (offline.length) {
			var offlineNames = offline.slice(0, ALERT_DEVICE_NAMES).map(function (item) { return item.name; });
			out.push({
				severity: 'warn',
				title: '设备离线',
				detail: offline.length + ' 台设备超过 10 分钟无活动：' + offlineNames.join('、') +
					(offline.length > ALERT_DEVICE_NAMES ? ' 等' : ''),
				target: { type: 'devices', keys: offline.map(function (item) { return item.key; }) }
			});
		}

		/* 7) 未知接入设备较多 */
		var unknownKeys = [];
		devices.forEach(function (dev, idx) {
			if (str(dev.link).toLowerCase() !== 'unknown') return;
			if (!isOnline(dev, state)) return;
			unknownKeys.push(deviceKey(dev, idx));
		});
		if (unknownKeys.length > ALERT_UNKNOWN_ONLINE) {
			out.push({
				severity: 'info',
				title: '接入方式未知',
				detail: unknownKeys.length + ' 台在线设备的接入方式未识别，建议检查 lan_bridge / wireless_ports 配置。',
				target: { type: 'devices', keys: unknownKeys }
			});
		}

		/* 8) 节点上报超时 */
		var staleNodes = collectStaleNodes(state, now);
		if (staleNodes.length) {
			var nodeNames = staleNodes.slice(0, ALERT_DEVICE_NAMES).map(function (item) { return item.name; });
			out.push({
				severity: 'warn',
				title: '节点上报超时',
				detail: staleNodes.length + ' 个节点超过 5 分钟未上报：' + nodeNames.join('、') +
					(staleNodes.length > ALERT_DEVICE_NAMES ? ' 等' : ''),
				target: { type: 'nodes' }
			});
		}

		/* 严重度排序（同级保持规则顺序） */
		out.forEach(function (item, idx) { item.order = idx; });
		out.sort(function (a, b) {
			var diff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
			return diff !== 0 ? diff : a.order - b.order;
		});
		return out;
	}

	function panelOf(node) {
		var current = node;
		while (current && current.nodeType === 1) {
			if (current.classList && current.classList.contains('panel')) return current;
			current = current.parentNode;
		}
		return null;
	}

	function topbarOffset() {
		var bar = document.querySelector('.topbar');
		var h = bar ? bar.getBoundingClientRect().height : 0;
		return (h > 0 ? h : 0) + 12;
	}

	function prefersReducedMotion() {
		try {
			return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
		} catch (e) {
			return false;
		}
	}

	function scrollToNode(node, block) {
		if (!node) return;
		var behavior = prefersReducedMotion() ? 'auto' : 'smooth';

		/* 区块跳到顶：按当前顶栏实际高度留出空间（窄屏顶栏会换行变高）。 */
		if (block === 'start') {
			var docTop = window.pageYOffset || document.documentElement.scrollTop || 0;
			var top = node.getBoundingClientRect().top + docTop - topbarOffset();
			try {
				window.scrollTo({ top: Math.max(0, top), behavior: behavior });
				return;
			} catch (e) { /* 回退到 scrollIntoView */ }
		}

		try {
			node.scrollIntoView({ behavior: behavior, block: block || 'center' });
		} catch (e) {
			try { node.scrollIntoView(); } catch (e2) { /* 忽略 */ }
		}
	}

	function flashNode(node) {
		if (!node || !node.classList) return;
		node.classList.add('is-flash');
		window.setTimeout(function () {
			if (node.classList) node.classList.remove('is-flash');
		}, ALERT_FLASH_MS);
	}

	function deviceRowByKey(key) {
		if (!dom.devicesBody) return null;
		var rows = dom.devicesBody.querySelectorAll('tr.drow');
		for (var i = 0; i < rows.length; i++) {
			if (rows[i].getAttribute('data-key') === key) return rows[i];
		}
		return null;
	}

	/* 点击告警：设备行滚动并高亮 2 秒；节点/健康区块滚动。 */
	function jumpToAlert(target) {
		if (!target) return;

		if (target.type === 'devices') {
			var rows = [];
			var allDevices = sortedDevices(app.state);
			var missing = false;
			(target.keys || []).forEach(function (key) {
				var row = deviceRowByKey(key);
				if (row) rows.push(row);
				else missing = true;
			});

			/* 手机默认 Top 3 可能折叠掉告警设备：先展开再定位，不能假报“已定位”。 */
			if (missing && allDevices.length > previewLimit('devices', allDevices.length)) {
				app.more.devices = true;
				renderDevices();
				rows = [];
				(target.keys || []).forEach(function (key) {
					var row = deviceRowByKey(key);
					if (row) rows.push(row);
				});
			}

			if (rows.length) {
				scrollToNode(rows[0]);
				rows.forEach(function (row) { flashNode(row); });
				announce('已定位到设备榜。');
				return;
			}

			var devicesPanel = panelOf(dom.devicesBody);
			scrollToNode(devicesPanel || dom.devicesBody, 'start');
			flashNode(devicesPanel);
			announce('设备在当前列表之外，已展开可见列表；请点“查看全部”进一步查找。');
			return;
		}

		if (target.type === 'nodes') {
			var nodesPanel = panelOf(dom.nodesList);
			scrollToNode(nodesPanel || dom.nodesList, 'start');
			flashNode(nodesPanel);
			announce('已定位到节点 / 出口。');
			return;
		}

		var healthPanel = panelOf(dom.healthSources);
		scrollToNode(healthPanel || dom.healthSources, 'start');
		flashNode(healthPanel);
		announce('已定位到健康与告警。');
	}

	function alertButton(item) {
		var btn = el('button', 'alert alert--' + item.severity);
		btn.type = 'button';
		if (item.target && item.target.type === 'nodes') btn.title = '跳转到节点 / 出口';
		else if (item.target && item.target.type === 'health') btn.title = '跳转到健康与告警';
		else btn.title = '跳转到设备榜';

		var dot = el('span', 'alert__dot');
		dot.setAttribute('aria-hidden', 'true');
		btn.appendChild(dot);

		var body = el('span', 'alert__body');
		body.appendChild(el('span', 'alert__title', item.title));
		body.appendChild(el('span', 'alert__detail', item.detail));
		btn.appendChild(body);

		var cue = el('span', 'alert__cue', '›');
		cue.setAttribute('aria-hidden', 'true');
		btn.appendChild(cue);

		btn.addEventListener('click', function () { jumpToAlert(item.target); });
		return btn;
	}

	function renderAlerts() {
		var list = dom.alertsList;
		if (!list) return;
		clear(list);

		var state = app.state;
		if (!state) {
			setMeta(dom.alertsMeta, app.inflight ? '统计中' : '暂无数据');
			list.appendChild(el('p', 'alerts__loading',
				app.inflight ? '正在读取面板数据…' : '暂无面板数据，无法统计告警'));
			return;
		}

		var alerts = buildAlerts(state);
		var shown = alerts.slice(0, ALERT_MAX);
		var countText = alerts.length + ' 项需要关注';
		if (alerts.length > shown.length) countText += ' · 显示前 ' + shown.length + ' 项';
		setMeta(dom.alertsMeta, countText);

		if (!shown.length) {
			var box = el('div', 'alerts__empty');
			var check = el('span', 'alerts__empty-check', '✓');
			check.setAttribute('aria-hidden', 'true');
			box.appendChild(check);

			var text = el('span', 'alerts__empty-text');
			text.appendChild(el('span', 'alerts__empty-title', '一切正常'));
			text.appendChild(el('span', 'alerts__empty-sub', '未发现需要关注的项'));
			box.appendChild(text);
			list.appendChild(box);
			return;
		}

		shown.forEach(function (item) {
			list.appendChild(alertButton(item));
		});
	}

	/* ------------------------------------------------------------------ *
	 * 设置（只读投影）
	 * ------------------------------------------------------------------ */
	function settingRaw(value) {
		var s = str(value).trim();
		return s === '' ? '—' : s;
	}

	function settingWithUnit(value, unit) {
		var s = str(value).trim();
		if (s === '') return '—';
		var n = Number(s);
		if (!isFinite(n)) return s;
		return n + ' ' + unit;
	}

	function onOffValue(value) {
		var s = str(value).trim().toLowerCase();
		if (s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'enabled') {
			return { text: '开', cls: 'settings__v--on' };
		}
		if (s === '0' || s === 'false' || s === 'off' || s === 'no' || s === 'disabled') {
			return { text: '关', cls: 'settings__v--off' };
		}
		return { text: s === '' ? '—' : s, cls: '' };
	}

	function settingsRow(label, value, cls, title) {
		var item = el('div', 'settings__row');
		item.appendChild(el('dt', 'settings__k', label));
		var node = el('dd', 'settings__v' + (cls ? ' ' + cls : ''), value);
		if (title) node.title = title;
		item.appendChild(node);
		return item;
	}

	/* 原生 <details> 分组：summary 上放标题 + 可选状态/说明，
	   内容全部由 renderSettings 动态生成，仍挂在 #settings-body 下。 */
	function settingsDetails(title, open, summaryExtra, wide) {
		var details = el('details', wide ? 'settings-group settings-group--wide' : 'settings-group');
		if (Object.prototype.hasOwnProperty.call(app.settingsOpen, title)) {
			details.open = app.settingsOpen[title] === true;
		} else if (open) {
			details.open = true;
		}
		details.addEventListener('toggle', function () {
			app.settingsOpen[title] = details.open === true;
		});

		var summary = el('summary', 'settings-group__summary');
		summary.appendChild(el('span', 'settings-group__title', title));
		if (summaryExtra) summary.appendChild(summaryExtra);
		details.appendChild(summary);

		var body = el('div', 'settings-group__body');
		details.appendChild(body);
		return { details: details, body: body };
	}

	function settingsGroup(title, rows, open, wide) {
		var group = settingsDetails(title, open, null, wide);
		var list = el('dl', 'settings__list');
		rows.forEach(function (row) {
			list.appendChild(settingsRow(row.label, row.value, row.cls, row.title));
		});
		group.body.appendChild(list);
		return group.details;
	}

	/* 当前状态：写操作是否开放 + 家长控制当前状态，默认展开。 */
	function settingsStatusGroup(write) {
		var metaState = guardStatusMeta();
		var group = settingsDetails('当前状态', true, el('span', 'settings-group__note', '只读'), true);

		if (write.enabled === false) {
			var writeBox = el('p', 'settings__write');
			var writeDot = el('span', 'settings__write-dot');
			writeDot.setAttribute('aria-hidden', 'true');
			writeBox.appendChild(writeDot);
			writeBox.appendChild(el('span', '', '写操作未开放'));
			group.body.appendChild(writeBox);
		}

		var list = el('dl', 'settings__list');
		var guardCls = metaState.cls === 'guard__status--on' ? 'settings__v--on'
			: (metaState.cls === 'guard__status--warn' ? 'settings__v--warn' : 'settings__v--off');
		list.appendChild(settingsRow('家长控制', metaState.text, guardCls));

		var paused = pausedCount();
		if (paused > 0) list.appendChild(settingsRow('已暂停设备', paused + ' 台'));

		group.body.appendChild(list);

		if (guardStatus().key === 'on') {
			group.body.appendChild(el('p', 'settings__hint', guardMetaText()));
		}
		return group.details;
	}

	function settingsErrorBox() {
		var box = el('div', 'settings__error');
		var text = el('div', 'settings__error-text');
		text.appendChild(el('p', 'settings__error-title', '设置数据不可用'));
		text.appendChild(el('p', 'settings__error-detail',
			app.settingsError ? errText(app.settingsError) : '未知错误'));
		box.appendChild(text);

		var retry = el('button', 'btn btn--small', '重试');
		retry.type = 'button';
		retry.setAttribute('aria-label', '重新加载设置数据');
		retry.addEventListener('click', function () { loadSettings(true); });
		box.appendChild(retry);
		return box;
	}

	function renderSettings() {
		var body = dom.settingsBody;
		if (!body) return;
		clear(body);

		if (!app.settings) {
			setMeta(dom.settingsMeta, app.settingsError ? '不可用' : '加载中');
			body.appendChild(app.settingsError
				? settingsErrorBox()
				: el('p', 'settings__loading', '正在读取设置…'));
			return;
		}

		var data = app.settings;
		var settings = (data.settings && typeof data.settings === 'object') ? data.settings : {};
		var panelCfg = (data.panel && typeof data.panel === 'object') ? data.panel : {};
		var write = (data.write && typeof data.write === 'object') ? data.write : {};

		setMeta(dom.settingsMeta, guardEnabled() ? '只读 · 家长控制' : '只读');

		/* 核心三组默认展开；功能开关与家长控制详细说明默认折叠。 */
		body.appendChild(settingsStatusGroup(write));

		body.appendChild(settingsGroup('采集与保留', [
			{ label: '轮询间隔', value: settingWithUnit(settings.poll_interval, '秒') },
			{ label: '历史保留天数', value: settingWithUnit(settings.history_days, '天') },
			{ label: '日文件保留', value: settingWithUnit(settings.retention_daily_days, '天') }
		], true));

		var bind = str(panelCfg.bind).trim();
		body.appendChild(settingsGroup('面板服务', [
			{ label: '面板端口', value: settingRaw(panelCfg.port) },
			{ label: '绑定地址', value: bind === '' ? '全部地址' : bind },
			{ label: '是否设置令牌', value: panelCfg.has_token ? '是' : '否' }
		], true));

		var feishu = onOffValue(settings.feishu_enabled);
		var mother = onOffValue(settings.mother_enabled);
		var stations = onOffValue(settings.stations_enabled);
		var legacyOn = str(settings.legacy_shared_secret) === '1' || str(settings.legacy_stations_token) === '1';
		var legacy = onOffValue(legacyOn ? '1' : '0');

		body.appendChild(settingsGroup('功能开关', [
			{ label: '飞书', value: feishu.text, cls: feishu.cls },
			{ label: '副节点', value: mother.text, cls: mother.cls },
			{ label: 'AP上报', value: stations.text, cls: stations.cls },
			{
				label: '旧版兼容',
				value: legacy.text,
				cls: legacy.cls,
				title: '旧共享密钥：' + (str(settings.legacy_shared_secret) === '1' ? '开' : '关') +
					' · 旧站点令牌：' + (str(settings.legacy_stations_token) === '1' ? '开' : '关')
			}
		], false, true));

		body.appendChild(guardSettingsGroup());

		/* 刷新失败但已有旧数据：保留数据，在底部补一条错误与重试。 */
		if (app.settingsError) body.appendChild(settingsErrorBox());
	}

	function loadSettings(force) {
		if (app.settingsBusy) return;
		if (!force && app.settings && (Date.now() - app.settingsAt) < SETTINGS_REFRESH) return;

		var prevGuard = guardStatus().key;

		app.settingsBusy = true;
		app.settingsError = null;
		renderSettings();

		fetchSettings().then(function (data) {
			if (!data || typeof data !== 'object') {
				app.settingsError = {
					panelError: true,
					kind: 'parse',
					status: 200,
					message: '设置接口返回的数据结构异常'
				};
				return;
			}
			app.settings = data;
			app.settingsAt = Date.now();
			app.settingsError = null;
		}, function (err) {
			app.settingsError = (err && err.panelError) ? err : {
				panelError: true,
				kind: 'network',
				status: 0,
				message: '无法连接到面板服务'
			};
		}).then(function () {
			app.settingsBusy = false;
			renderSettings();

			/* 家长控制开关变了：设备榜要补上 / 去掉暂停按钮，并同步暂停列表。 */
			var nextGuard = guardStatus().key;
			if (nextGuard !== prevGuard) renderDevices();
			if (nextGuard === 'on') syncPaused();
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
		var down = netDown();
		renderNetBar();

		/* 断网/超时的提示已经由顶部网络条承担，避免两条横幅说同一件事。 */
		var err = app.lastErr;
		var suppress = down && err && (err.kind === 'network' || err.kind === 'timeout');
		if (dom.errorBar) dom.errorBar.hidden = !err || suppress;
		setText(dom.errorText, (!err || suppress) ? '' : errText(err));

		/* 401 与「家长控制缺少令牌」共用同一个令牌面板，说明文案区分来源。 */
		var showAuth = !!app.authBlocked || !!app.tokenPrompt;
		dom.authPanel.hidden = !showAuth;
		if (showAuth) {
			setText(dom.authDesc, app.tokenPrompt || authMessage());
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
		renderAlerts();
		renderSettings();
		renderNotices();
		updateActiveTab();
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
			syncPaused();   /* 家长控制：静默同步已暂停集合，失败不影响主流程 */

			/* 节点上报状态只是辅助数据：单独请求，失败不影响主流程。 */
			var needNodes = manual || !app.nodes || (Date.now() - app.nodesAt) > NODES_REFRESH;
			if (needNodes) {
				fetchNodes().then(function (nodes) {
					if (!nodes || typeof nodes !== 'object') return;
					app.nodes = nodes;
					app.nodesAt = Date.now();
					renderAlerts();
				}, function () { /* 节点数据不可用时保留上一次结果 */ });
			}

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
	/* 手动刷新入口：按钮、错误条重试、下拉刷新、网络恢复都走这里。
	   只做一次强制 load，不碰自动刷新开关（app.auto / 复选框）。 */
	function refresh() {
		announce('正在刷新数据…');
		load(true);
		loadSettings(true);
	}

	function onRefreshClick() {
		refresh();
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
		app.tokenPrompt = '';

		/* 保存令牌后回到刚才被令牌挡住的那次暂停 / 恢复操作（仍需用户确认）。 */
		var pending = app.guard.pending;
		app.guard.pending = null;

		renderNotices();
		announce('已保存令牌，正在重试。');
		load(true);
		syncPaused();
		if (pending) openGuardModal(pending);
	}

	function onTokenClear() {
		app.token = '';
		storeToken('');
		app.tokenPrompt = '';
		app.guard.pending = null;
		app.guard.paused = {};
		setText(dom.authHint, '已清除本机保存的令牌。');
		if (dom.tokenInput) dom.tokenInput.value = '';
		renderNotices();
		paintGuardButtons();
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

	function closestClass(node, cls) {
		var current = node;
		while (current && current.nodeType === 1) {
			if (current.classList && current.classList.contains(cls)) return current;
			current = current.parentNode;
		}
		return null;
	}

	function onDevicesClick(ev) {
		/* 暂停 / 恢复按钮有自己的确认流程，不要连带展开设备明细。 */
		if (ev.target && closestClass(ev.target, 'guard-btn')) return;
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
		/* 跨过 760px 断点时，列表默认条数会变（手机 3/5 条、桌面 10 条），重渲染一次。 */
		if (window.matchMedia) {
			try {
				var compact = window.matchMedia(COMPACT_MQ);
				var onChange = function () {
					app.more.devices = false;
					app.more.apps = false;
					renderDevices();
					renderApps();
				};
				if (compact.addEventListener) compact.addEventListener('change', onChange);
				else if (compact.addListener) compact.addListener(onChange);
			} catch (e) { /* 老浏览器忽略 */ }
		}
	}

	function bindEvents() {
		if (dom.refreshBtn) dom.refreshBtn.addEventListener('click', onRefreshClick);
		if (dom.errorRetry) dom.errorRetry.addEventListener('click', onRefreshClick);
		if (dom.netRetry) dom.netRetry.addEventListener('click', onRefreshClick);
		if (dom.autoInput) dom.autoInput.addEventListener('change', onAutoChange);
		if (dom.authForm) dom.authForm.addEventListener('submit', onTokenSubmit);
		if (dom.tokenClear) dom.tokenClear.addEventListener('click', onTokenClear);
		if (dom.devicesBody) dom.devicesBody.addEventListener('click', onDevicesClick);
		bindMore(dom.devicesMore, 'devices', renderDevices);
		bindMore(dom.appsMore, 'apps', renderApps);
		bindMore(dom.nodesMore, 'nodes', renderNodes);
		if (dom.guardCancel) dom.guardCancel.addEventListener('click', closeGuardModal);
		if (dom.guardConfirm) dom.guardConfirm.addEventListener('click', onGuardConfirm);
		if (dom.guardBackdrop) {
			dom.guardBackdrop.addEventListener('click', function () {
				if (!app.guard.busyMac) closeGuardModal();
			});
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
	}

	/* ------------------------------------------------------------------ *
	 * 移动端：底部导航（≤760px 由 CSS 显示，桌面 display:none）
	 * 锚点复用页面已有的标题 id，避免新增区块 id；滚动位置按顶栏实际高度补偿。
	 * ------------------------------------------------------------------ */
	var TABS = [
		{ key: 'overview', label: '概览', head: 'cards-title', cards: true },
		{ key: 'devices', label: '设备', head: 'devices-title' },
		{ key: 'apps', label: '应用', head: 'apps-title' },
		{ key: 'settings', label: '设置', head: 'settings-title' }
	];

	var tabState = { entries: [], active: '', raf: 0, lockUntil: 0 };

	function tabTarget(item) {
		var head = document.getElementById(item.head);
		if (!head) return null;
		if (item.cards) return head.parentNode || head;   /* 概览 = 概览卡所在的 section */
		return panelOf(head) || head.parentNode || head;
	}

	function setActiveTab(key, force) {
		if (!key) return;
		if (!force && tabState.active === key) return;
		tabState.active = key;

		tabState.entries.forEach(function (entry) {
			var on = entry.item.key === key;
			if (on) {
				entry.node.classList.add('is-active');
				entry.node.setAttribute('aria-current', 'page');
			} else {
				entry.node.classList.remove('is-active');
				entry.node.removeAttribute('aria-current');
			}
		});
	}

	/* 以「顶栏底边 + TAB_PROBE_GAP」为判定线：越过这条线的最后一个区块就是当前区块。 */
	function updateActiveTab() {
		if (!tabState.entries.length) return;
		if (Date.now() < tabState.lockUntil) return;

		var barRect = dom.topbar ? dom.topbar.getBoundingClientRect() : null;
		var probe = (barRect ? barRect.bottom : 0) + TAB_PROBE_GAP;
		var best = TABS[0].key;

		TABS.forEach(function (item) {
			var node = tabTarget(item);
			if (!node) return;
			if (node.getBoundingClientRect().top <= probe) best = item.key;
		});

		/* 滚到底部时最后一屏（设置）可能只露出一半，直接判为当前项更符合直觉。 */
		var doc = document.documentElement;
		var top = window.pageYOffset || doc.scrollTop || 0;
		if (doc.scrollHeight && top + (window.innerHeight || 0) >= doc.scrollHeight - 4) {
			best = TABS[TABS.length - 1].key;
		}

		setActiveTab(best);
	}

	/* scroll 事件用 rAF 节流：一帧最多算一次几何。 */
	function onScrollThrottled() {
		if (tabState.raf) return;
		tabState.raf = window.requestAnimationFrame(function () {
			tabState.raf = 0;
			updateActiveTab();
		});
	}

	function bindTabClick(entry) {
		return function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			var target = tabTarget(entry.item);
			setActiveTab(entry.item.key, true);
			tabState.lockUntil = Date.now() + TAB_LOCK_MS;
			if (target) scrollToNode(target, 'start');
			announce('已跳转到「' + entry.item.label + '」。');
			window.setTimeout(updateActiveTab, TAB_LOCK_MS + 60);
		};
	}

	function setupTabs() {
		var bar = document.querySelector('.tabbar');
		if (!bar) return;

		var links = bar.querySelectorAll('.tabbar__link');
		for (var i = 0; i < links.length; i++) {
			var key = links[i].getAttribute('data-tab') || '';
			var item = null;
			for (var j = 0; j < TABS.length; j++) {
				if (TABS[j].key === key) item = TABS[j];
			}
			if (!item) continue;

			var entry = { node: links[i], item: item };
			tabState.entries.push(entry);
			links[i].addEventListener('click', bindTabClick(entry));
		}

		setActiveTab(TABS[0].key, true);
		window.addEventListener('scroll', onScrollThrottled, { passive: true });
		window.addEventListener('resize', onScrollThrottled);
		updateActiveTab();
	}

	/* ------------------------------------------------------------------ *
	 * 移动端：下拉刷新
	 * 只在「页面在最顶部且单指下拉」时接管，超过 PULL_TRIGGER 才刷新；
	 * 触发的是 refresh()（手动刷新），自动刷新开关与定时器都不受影响。
	 * ------------------------------------------------------------------ */
	var pullState = { tracking: false, startY: 0, distance: 0 };

	function pageAtTop() {
		var doc = document.documentElement;
		return (window.pageYOffset || doc.scrollTop || 0) <= 0;
	}

	function paintPull(dist, dragging) {
		pullState.distance = dist;

		var hint = dom.pullHint;
		if (!hint) return;

		hint.style.setProperty('--pull-y', Math.round(dist) + 'px');
		if (dragging) hint.classList.add('is-dragging');
		else hint.classList.remove('is-dragging');

		if (dist > 2) hint.classList.add('is-visible');
		else hint.classList.remove('is-visible');

		if (dist >= PULL_TRIGGER) hint.classList.add('is-armed');
		else hint.classList.remove('is-armed');

		setText(dom.pullHintText, dist >= PULL_TRIGGER ? '松开刷新' : '下拉刷新');
	}

	function onTouchStart(ev) {
		if (!ev.touches || ev.touches.length !== 1) { pullState.tracking = false; return; }
		if (!pageAtTop()) { pullState.tracking = false; return; }
		pullState.tracking = true;
		pullState.startY = ev.touches[0].clientY;
		pullState.distance = 0;

		/* 指示器从顶栏下沿滑出：这里钉一次顶栏底边位置（窄屏顶栏会换行变高）。 */
		if (dom.pullHint && dom.topbar) {
			var barBottom = dom.topbar.getBoundingClientRect().bottom;
			dom.pullHint.style.setProperty('--pull-top', Math.max(0, Math.round(barBottom)) + 'px');
		}
	}

	function onTouchMove(ev) {
		if (!pullState.tracking) return;
		if (!ev.touches || ev.touches.length !== 1) { onTouchEnd(); return; }
		if (!pageAtTop()) { pullState.tracking = false; paintPull(0, false); return; }

		var dy = ev.touches[0].clientY - pullState.startY;
		if (dy <= 0) {
			if (pullState.distance) paintPull(0, true);
			return;
		}

		var dist = Math.min(PULL_MAX, dy * PULL_DAMPING);
		if (dist > 4 && ev.cancelable) {
			try { ev.preventDefault(); } catch (e) { /* 忽略 */ }
		}
		paintPull(dist, true);
	}

	function onTouchEnd() {
		if (!pullState.tracking) return;
		var dist = pullState.distance;
		pullState.tracking = false;
		paintPull(0, false);
		if (dist >= PULL_TRIGGER) refresh();
	}

	function setupPullRefresh() {
		if (!dom.pullHint) return;
		document.addEventListener('touchstart', onTouchStart, { passive: true });
		document.addEventListener('touchmove', onTouchMove, { passive: false });
		document.addEventListener('touchend', onTouchEnd);
		document.addEventListener('touchcancel', function () {
			pullState.tracking = false;
			paintPull(0, false);
		});
	}

	/* ------------------------------------------------------------------ *
	 * 离线 / 弱网提示
	 * navigator.onLine === false 或请求失败（network / timeout）时显示，
	 * 恢复联网事件后自动隐藏并刷新一次（NET_REFRESH_MIN 去抖，避免重复刷新）。
	 * ------------------------------------------------------------------ */
	function netDown() {
		if (window.navigator && window.navigator.onLine === false) return true;
		var err = app.lastErr;
		return !!(err && (err.kind === 'network' || err.kind === 'timeout'));
	}

	function renderNetBar() {
		if (!dom.netBar) return;

		if (!netDown()) {
			if (!dom.netBar.hidden) dom.netBar.hidden = true;
			setText(dom.netText, '');
			return;
		}

		var when = app.lastOk ? fmtClockMs(app.lastOk) : '';
		var offline = !!(window.navigator && window.navigator.onLine === false);
		var reason = offline ? '网络已断开' : '网络响应超时';
		var text = reason + (when
			? '，显示的是上次数据（' + when + '）'
			: '，暂无可用数据');

		setText(dom.netText, text);
		dom.netBar.hidden = false;
	}

	function onOffline() {
		app.offlineSeen = true;
		renderNotices();
		announce('网络已断开，显示的是上次数据。');
	}

	function onOnline() {
		var wasDown = app.offlineSeen || netDown();
		app.offlineSeen = false;

		/* 旧的断网错误已经不代表现状，先清掉，让提示条即时消失。 */
		if (app.lastErr && (app.lastErr.kind === 'network' || app.lastErr.kind === 'timeout')) {
			app.lastErr = null;
		}
		renderNotices();

		if (!wasDown) return;

		var now = Date.now();
		if (now - app.lastRecoverAt < NET_REFRESH_MIN) return;
		app.lastRecoverAt = now;

		announce('网络已恢复，正在刷新数据。');
		refresh();
	}

	function setupNetwork() {
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
	}

	/* ------------------------------------------------------------------ *
	 * 启动
	 * ------------------------------------------------------------------ */
	function cacheDom() {
		var ids = [
			'state-pill', 'confidence-pill', 'last-updated', 'refresh-btn', 'auto-refresh',
			'aria-live', 'error-bar', 'error-text', 'error-retry',
			'net-bar', 'net-text', 'net-retry', 'pull-hint', 'pull-hint-text',
			'auth-panel', 'auth-desc', 'auth-form', 'token-input', 'token-clear', 'auth-hint',
			'guard-modal', 'guard-backdrop', 'guard-dialog', 'guard-title', 'guard-target',
			'guard-desc', 'guard-error', 'guard-cancel', 'guard-confirm',
			'card-rx', 'card-rx-sub', 'card-rx-unit', 'card-tx', 'card-tx-sub', 'card-tx-unit',
			'card-today', 'card-today-sub', 'card-month', 'card-month-sub',
			'card-devices', 'card-devices-unit', 'card-devices-sub',
			'card-clash', 'card-clash-sub',
			'chart-window', 'chart-meta', 'rate-chart', 'chart-empty', 'chart-legend-note',
			'nodes-meta', 'nodes-list', 'nodes-more',
			'devices-meta', 'devices-body', 'devices-more',
			'apps-meta', 'apps-body', 'apps-more',
			'health-meta', 'health-sources', 'health-reasons',
			'alerts-meta', 'alerts-list',
			'settings-meta', 'settings-body'
		];

		ids.forEach(function (id) {
			var node = document.getElementById(id);
			if (node) dom[camel(id)] = node;
		});

		dom.canvas = dom.rateChart;
		dom.live = dom.ariaLive;
		dom.autoInput = dom.autoRefresh;
		dom.topbar = document.querySelector('.topbar');
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
		setupTabs();
		setupPullRefresh();
		setupNetwork();

		renderAll();
		load(false);
		loadSettings(false);
		startTimer();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
