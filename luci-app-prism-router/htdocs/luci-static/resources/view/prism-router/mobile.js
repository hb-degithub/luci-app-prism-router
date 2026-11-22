'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

/*
 * 棱镜路由 · 手机版（单页，手机 App 风格）
 *
 * 首屏只发一次 rpcd 调用（get_state）；整页结构在 render 里建好，
 * 之后每 15s（document.hidden 时跳过）刷新数字与列表。
 * 节点 / AP 数据懒加载：首次切到「节点」或「拓扑」时并行补拉
 * get_nodes + get_stations，之后复用缓存，只有停在这两屏时刷新才顺带更新。
 *
 * 结构：.tsm-app 内是顶部带文字分段 tab + 5 屏（概览 / 设备 / 节点 / 拓扑 / 安装）。
 * 切屏（setPage / 左右滑动）只改 class；首屏之外的额外 RPC 仅懒加载补拉一次。
 * 底部无文字圆点导航已移除（可发现性差），导航只保留顶部 tab。
 * 设备屏支持搜索（名称 / MAC / IP），拓扑屏支持出口 / AP 卡片下钻。
 *
 * 离线：每次 get_state 成功都写一份精简快照到 localStorage（见「离线快照」段），
 * 首屏 / 刷新失败时读回来渲染，并在顶部挂一条「离线数据 · 更新于 HH:MM」提示条 +
 * 重试按钮；网络恢复（online 事件或任意一次刷新成功）自动收起。
 * 自动轮询连续失败 3 次即停表省电，手动重试不受限；快照超过 24 小时作废。
 * 安装 / 关于屏有「清除离线数据」入口。
 *
 * 口径提醒（SPEC 3.1）：totals 是**进程启动以来累计**，不是"今日"。
 *
 * 单位约定（与其它页面一致，别混）：
 *   流量  二进制：B / KiB / MiB / GiB / TiB，≥1 GiB 保留 1 位小数
 *   速率  十进制：Mb/s（bits）
 */

var callState = rpc.declare({
	object: 'prism-router',
	method: 'get_state',
	expect: {},
	reject: true
});

/*
 * 子节点快照（只读、无参数，ACL 已放行 prism-router.get_nodes）。
 * 失败**绝不能**影响主数据与整页渲染：调用处一律自己 catch。
 */
var callNodes = rpc.declare({
	object: 'prism-router',
	method: 'get_nodes',
	expect: {},
	reject: true
});

/*
 * 无线站点 / AP 上报（只读、无参数，ACL 已放行 prism-router.get_stations）。
 * 同样自己 catch：失败只让拓扑屏的 AP 层降级，不影响其它屏。
 */
var callStations = rpc.declare({
	object: 'prism-router',
	method: 'get_stations',
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

/* HH:MM（离线提示只精确到分钟，秒没有意义）。 */
function fmtHHMM(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* 真实当前时间（秒）：分类/计数/相对时间一律以它为准，state.ts 只用于「更新于」显示。 */
function nowSec() {
	return Math.floor(Date.now() / 1000);
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

// ---------------------------------------------------------------- App 屏辅助

var SVG_NS = 'http://www.w3.org/2000/svg';

/* SVG 必须走命名空间：E() 建出来的是 HTML 元素，浏览器不会当成图形渲染。 */
function svgEl(tag, attrs) {
	var node = document.createElementNS(SVG_NS, tag);

	if (attrs != null) {
		for (var key in attrs) {
			if (!attrs.hasOwnProperty(key)) continue;
			if (attrs[key] == null) continue;

			node.setAttribute(key, '' + attrs[key]);
		}
	}

	return node;
}

/* bytes/s → 大号数字用的纯数值（Mb/s，保留 1 位）；单位交给下方灰字。 */
function mbpsNum(bytesPerSecond) {
	return (num(bytesPerSecond) * 8 / 1e6).toFixed(1);
}

/*
 * 在线终端数：last_seen > 0 且 now - last_seen <= 600（与概览页同一口径）。
 * now 缺失/非正数时按真实当前时间算；last_seen 在未来 60 秒内（设备时钟漂移）
 * 仍算在线，更远的未来时间戳不冒充在线（同 overview.js 的 onlineCount）。
 */
function activeDeviceCount(devices, now) {
	var list = Array.isArray(devices) ? devices : [];
	var base = num(now);
	var count = 0;

	if (base <= 0) base = nowSec();

	for (var i = 0; i < list.length; i++) {
		var seen = num(list[i] != null ? list[i].last_seen : 0);

		if (seen > 0 && seen <= base + 60 && (base - seen) <= OFFLINE_SEC) count++;
	}

	return count;
}

/* 出口节点：nodes 里 rx+tx 最大的「真实节点」项。
 * DIRECT 与 UNKNOWN 都不是节点名（UNKNOWN 是后端在 chain 为空时的合成桶），
 * 跳过它们；没有代理节点返回 ''（调用方显示「直连」）。 */
function exitNodeOf(nodes) {
	var src = (nodes != null && typeof nodes == 'object') ? nodes : {};
	var name = '';
	var best = -1;

	for (var key in src) {
		if (!src.hasOwnProperty(key)) continue;

		var label = '' + key;

		if (!label.length) continue;

		var upper = label.toUpperCase();

		if (upper == 'DIRECT' || upper == 'UNKNOWN') continue;

		var item = src[key] || {};
		var value = num(item.rx) + num(item.tx);

		if (value > best) {
			best = value;
			name = label;
		}
	}

	return name;
}

/* 上传/下载箭头：纯 SVG 线条，不用 emoji 也不用字体图标。 */
function arrowSvg(up, color) {
	var svg = svgEl('svg', {
		viewBox: '0 0 24 24', width: '18', height: '18',
		'aria-hidden': 'true', focusable: 'false'
	});

	svg.appendChild(svgEl('path', {
		d: up ? 'M12 20V5' : 'M12 4v15', fill: 'none', stroke: color,
		'stroke-width': '2.6', 'stroke-linecap': 'round'
	}));
	svg.appendChild(svgEl('path', {
		d: up ? 'M5.5 11.5 12 5l6.5 6.5' : 'M5.5 12.5 12 19l6.5-6.5', fill: 'none', stroke: color,
		'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
	}));

	return svg;
}

/* 地球：绿色描边 + 经线/纬线，约 72px。 */
function globeSvg() {
	var svg = svgEl('svg', {
		'class': 'tsm-globe', viewBox: '0 0 72 72', width: '72', height: '72',
		'aria-hidden': 'true', focusable: 'false'
	});
	var line = { fill: 'none', stroke: '#00b96b', 'stroke-width': '1.6', opacity: '.7' };

	svg.appendChild(svgEl('circle', {
		cx: '36', cy: '36', r: '30', fill: 'none', stroke: '#00b96b', 'stroke-width': '2.4'
	}));
	svg.appendChild(svgEl('ellipse', {
		cx: '36', cy: '36', rx: '13', ry: '30', fill: 'none', stroke: '#00b96b',
		'stroke-width': '1.6', opacity: '.7'
	}));
	svg.appendChild(svgEl('path', { d: 'M36 6v60', fill: 'none', stroke: '#00b96b', 'stroke-width': '1.6', opacity: '.5' }));
	svg.appendChild(svgEl('path', {
		d: 'M7.7 26C20 21 52 21 64.3 26', fill: line.fill, stroke: line.stroke,
		'stroke-width': line['stroke-width'], opacity: line.opacity
	}));
	svg.appendChild(svgEl('path', {
		d: 'M7.7 46C20 51 52 51 64.3 46', fill: line.fill, stroke: line.stroke,
		'stroke-width': line['stroke-width'], opacity: line.opacity
	}));

	return svg;
}

/* 出口节点：绿底白线路由器/节点图形。 */
function routerSvg() {
	var svg = svgEl('svg', {
		viewBox: '0 0 48 48', width: '36', height: '36',
		'aria-hidden': 'true', focusable: 'false'
	});
	var stroke = { fill: 'none', stroke: '#fff', 'stroke-width': '2.6', 'stroke-linecap': 'round' };

	svg.appendChild(svgEl('path', {
		d: 'M16.5 18.5 12.5 8', fill: stroke.fill, stroke: stroke.stroke,
		'stroke-width': stroke['stroke-width'], 'stroke-linecap': stroke['stroke-linecap']
	}));
	svg.appendChild(svgEl('path', {
		d: 'M31.5 18.5 35.5 8', fill: stroke.fill, stroke: stroke.stroke,
		'stroke-width': stroke['stroke-width'], 'stroke-linecap': stroke['stroke-linecap']
	}));
	svg.appendChild(svgEl('rect', {
		x: '7', y: '20', width: '34', height: '16', rx: '4.5',
		fill: 'none', stroke: '#fff', 'stroke-width': '2.6'
	}));
	svg.appendChild(svgEl('circle', { cx: '15', cy: '28', r: '1.9', fill: '#fff' }));
	svg.appendChild(svgEl('circle', { cx: '22', cy: '28', r: '1.9', fill: '#fff' }));
	svg.appendChild(svgEl('path', {
		d: 'M30 28h6', fill: 'none', stroke: '#fff', 'stroke-width': '2.6', 'stroke-linecap': 'round'
	}));

	return svg;
}

/* 筛选漏斗：纯 SVG 线条，橙色，和「筛选」文字同一行。 */
function funnelSvg() {
	var svg = svgEl('svg', {
		viewBox: '0 0 24 24', width: '14', height: '14',
		'aria-hidden': 'true', focusable: 'false'
	});

	svg.appendChild(svgEl('path', {
		d: 'M3 5h18l-7 8.2V20l-4-2.2v-4.6z', fill: 'none', stroke: '#ff6f00',
		'stroke-width': '2', 'stroke-linejoin': 'round'
	}));

	return svg;
}

/* 设备搜索放大镜：继承 currentColor，浅色/深色主题都能看清。 */
function searchSvg() {
	var svg = svgEl('svg', {
		viewBox: '0 0 24 24', width: '15', height: '15',
		'aria-hidden': 'true', focusable: 'false'
	});

	svg.appendChild(svgEl('circle', {
		cx: '11', cy: '11', r: '6.5', fill: 'none', stroke: 'currentColor',
		'stroke-width': '2'
	}));
	svg.appendChild(svgEl('path', {
		d: 'M16 16l4.5 4.5', fill: 'none', stroke: 'currentColor',
		'stroke-width': '2', 'stroke-linecap': 'round'
	}));

	return svg;
}

function healthLook(confidence) {
	var conf = '' + (confidence == null ? 'unknown' : confidence);

	if (conf == 'exact')
		return { kind: 'exact', label: _('记账精确'), color: '#2e7d32', bg: 'rgba(76,175,80,.12)' };
	if (conf == 'degraded')
		return { kind: 'degraded', label: _('记账降级'), color: '#b26a00', bg: 'rgba(249,171,0,.18)' };
	if (conf == 'unavailable')
		return { kind: 'unavailable', label: _('记账不可用'), color: '#c62828', bg: 'rgba(198,40,40,.10)' };

	/* unknown 是「还没拿到结论」，不是「不可用」：灰色未知，别用红色报错吓人。 */
	return { kind: 'unknown', label: _('记账状态未知'), color: '#9e9e9e', bg: 'rgba(158,158,158,.2)' };
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

// ---------------------------------------------------------------- 安装 / 扫码

/*
 * PWA 安装入口的全局状态。
 * beforeinstallprompt 只会在可安装时触发，而且事件对象只能用一次，所以放在模块
 * 作用域里：页面重建（切标签、返回）不会把已经拿到的安装事件丢掉。
 */
var INSTALL = {
	deferred: null,   /* beforeinstallprompt 事件（Android Chrome / Edge） */
	installed: false, /* 触发过 appinstalled，或当前就是独立窗口 */
	applied: false,   /* 已经调过 prompt()，事件不能再用 */
	bound: false,     /* window 监听只注册一次 */
	refresh: null     /* 当前挂载视图的状态回写函数 */
};

/* 当前页面地址（去掉 hash）：二维码与复制都用它 */
function pageUrl() {
	try {
		var href = '' + window.location.href;
		var i = href.indexOf('#');

		return (i >= 0) ? href.substring(0, i) : href;
	}
	catch (e) {
		return '';
	}
}

function isStandalone() {
	try {
		if (typeof window.matchMedia == 'function' &&
			window.matchMedia('(display-mode: standalone)').matches)
			return true;
	}
	catch (e) { }

	try {
		if (window.navigator != null && window.navigator.standalone === true)
			return true;
	}
	catch (e) { }

	return false;
}

/* iOS 判断要放在 Android 前面：iPadOS 13+ 的 UA 是 Macintosh。 */
function platformOf() {
	var ua = '';
	var touch = 0;

	try { ua = '' + (window.navigator.userAgent || ''); }
	catch (e) { ua = ''; }

	try { touch = num(window.navigator.maxTouchPoints); }
	catch (e) { touch = 0; }

	if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
	if (/macintosh/i.test(ua) && touch > 1) return 'ios';
	if (/android/i.test(ua)) return 'android';

	return 'other';
}

/* installed：已装；prompt：浏览器给了安装事件；manual：只能给分步文案 */
function installMode() {
	if (INSTALL.installed || isStandalone()) return 'installed';
	if (INSTALL.deferred != null) return 'prompt';

	return 'manual';
}

function notifyInstall() {
	if (typeof INSTALL.refresh != 'function') return;

	try { INSTALL.refresh(); }
	catch (e) { }
}

function bindInstallListeners() {
	if (INSTALL.bound) return;

	INSTALL.bound = true;
	INSTALL.installed = isStandalone();

	if (typeof window.addEventListener != 'function') return;

	window.addEventListener('beforeinstallprompt', function(ev) {
		/* 拦下浏览器自带的安装横幅，改成页面里的按钮触发 */
		try { ev.preventDefault(); }
		catch (e) { }

		INSTALL.deferred = ev;
		notifyInstall();
	});

	window.addEventListener('appinstalled', function() {
		INSTALL.installed = true;
		INSTALL.deferred = null;
		notifyInstall();
	});
}

/*
 * uqr 输出的 SVG 通常自带 viewBox；万一只有 width/height，就按像素补一个 viewBox，
 * 这样 CSS 把 svg 拉到 100% 时是等比缩放而不是裁掉右下角。失败一律忽略。
 */
function normalizeQrSvg(host) {
	if (host == null || typeof host.querySelector != 'function') return;

	var svg = null;

	try { svg = host.querySelector('svg'); }
	catch (e) { svg = null; }

	if (svg == null || typeof svg.getAttribute != 'function') return;

	try {
		if (!svg.getAttribute('viewBox')) {
			var w = parseFloat(svg.getAttribute('width'));
			var h = parseFloat(svg.getAttribute('height'));

			if (isFinite(w) && isFinite(h) && w > 0 && h > 0)
				svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
		}

		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
	}
	catch (e) { }
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
	/* ---- 安装 / 扫码 ---- */
	'.tsm-install-card{margin:0 0 4px;padding:14px 12px 12px;border-radius:10px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.16);text-align:center}',
	'.tsm-qr{width:184px;height:184px;padding:8px;margin:0 auto;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center}',
	'.tsm-qr svg{display:block;width:100%!important;height:100%!important}',
	'.tsm-qr-fail{font-size:11.5px;line-height:1.5;opacity:.6;padding:6px;color:#555}',
	'.tsm-qr-cap{font-size:11.5px;opacity:.6;margin:7px 0 12px}',
	'.tsm-inst-btn{font:inherit;font-size:14px;line-height:1.2;padding:10px 20px;min-height:40px;border-radius:20px;border:none;cursor:pointer;color:#fff;background:#1a73e8}',
	'.tsm-inst-btn:active{opacity:.85}',
	'.tsm-inst-ok{font-size:13.5px;font-weight:600;color:#2e7d32}',
	'.tsm-inst-t{font-size:12.5px;opacity:.75;margin:0 0 6px;text-align:left}',
	'.tsm-inst-steps{margin:0;padding:0}',
	'.tsm-inst-step{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.5;padding:3px 0;text-align:left}',
	'.tsm-inst-n{flex:none;width:18px;height:18px;line-height:18px;border-radius:50%;text-align:center;font-size:11px;background:rgba(127,127,127,.22);margin-top:1px}',
	'.tsm-inst-s{flex:1 1 auto;min-width:0}',
	'.tsm-inst-hint{font-size:11.5px;opacity:.6;margin-top:8px;line-height:1.5}',
	'.tsm-url-row{display:flex;gap:8px;align-items:center;margin:12px 0 0;padding-top:12px;border-top:1px dashed rgba(127,127,127,.28)}',
	'.tsm-url{flex:1 1 auto;min-width:0;font-size:11.5px;line-height:1.45;word-break:break-all;text-align:left;font-family:ui-monospace,Menlo,Consolas,monospace}',
	'.tsm-copy{flex:none;font:inherit;font-size:12.5px;line-height:1.1;padding:8px 12px;min-height:44px;border-radius:8px;border:none;cursor:pointer;color:#fff;background:#1a73e8}',
	'.tsm-copy[disabled]{opacity:.75;cursor:default}',
	'.tsm-install-note{margin:10px 0 0}',
	'@media (min-width:600px){.tsm-card-v{font-size:19px}.tsm-card-s{font-size:11.5px}.tsm-dev-name{font-size:15px}.tsm-app,.tsm-approw{font-size:13px}}',

	/* ================================================================
	 * 手机 App 风格（第 1 步）：白底、橙色强调、细分隔线、无重阴影。
	 * 这里用同一份样式表后置覆盖上面的旧规则（同优先级后者胜），
	 * 旧规则仍为设备/应用列表保留，第 2 步直接复用。
	 * ================================================================ */
	'#ts-mobile{max-width:100%;padding:0 0 24px 0;background:#fff;color:#1b1f24;-webkit-text-size-adjust:100%}',
	'.tsm-app{display:flex;flex-direction:column;min-height:100%}',
	/* 顶部标题行 */
	'.tsm-head{flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px 2px;margin:0}',
	'.tsm-head h2{font-size:17px;font-weight:600}',
	'.tsm-meta{gap:8px;font-size:11.5px;color:#8a8f98;white-space:nowrap;opacity:1}',
	'.tsm-refresh{font-size:12.5px;padding:7px 12px;min-height:30px;border-radius:15px;color:#ff6f00;background:rgba(255,111,0,.08);border:1px solid rgba(255,111,0,.28)}',
	'.tsm-refresh:active{background:rgba(255,111,0,.18)}',
	'.tsm-notice{margin:10px 16px 0;border-radius:12px;background:rgba(198,40,40,.08);border-left:3px solid #c62828}',
	/* 顶部分段 tab：选中项下方 3px 橙色短横线 */
	'.tsm-tabs{display:flex;align-items:stretch;padding:6px 8px 0;border-bottom:1px solid rgba(0,0,0,.06);background:#fff;position:sticky;top:0;z-index:10}',
	'.tsm-tab{flex:1 1 0;min-width:0;font:inherit;font-size:14px;line-height:1.2;padding:8px 2px 0;border:none;background:none;color:#8a8f98;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-tab.on{color:#1b1f24;font-weight:600}',
	'.tsm-tab::after{content:"";display:block;height:3px;width:22px;margin:8px auto 0;border-radius:2px;background:transparent}',
	'.tsm-tab.on::after{background:#ff6f00}',
	/* 五屏 */
	'.tsm-pages{flex:1 1 auto;display:block;min-width:0}',
	'.tsm-page{display:none;padding:14px 16px 0}',
	'.tsm-page.on{display:block}',
	'.tsm-host{min-width:0}',
	/* 概览：上传 / 下载 */
	'.tsm-rates{display:flex;align-items:flex-start;gap:10px;min-width:0}',
	'.tsm-rate{flex:1 1 0;min-width:0}',
	'.tsm-rate-h{display:flex;align-items:center;gap:6px;min-width:0}',
	'.tsm-rate-h svg{flex:none;display:block}',
	'.tsm-big{font-size:40px;font-weight:700;line-height:1.05;letter-spacing:-.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
	'.tsm-rate-cap{font-size:12px;color:#8a8f98;margin-top:4px}',
	'.tsm-vline{width:1px;align-self:stretch;min-height:52px;margin:4px 0;background:rgba(0,0,0,.06)}',
	/* 概览：地球 → 竖线 → 出口节点卡片 */
	'.tsm-node{display:flex;flex-direction:column;align-items:center;margin:22px 0 0}',
	'.tsm-globe{display:block;width:72px;height:72px}',
	'.tsm-spring{width:1px;height:28px;background:rgba(0,0,0,.08);margin:8px 0}',
	'.tsm-nodecard{position:relative;width:64px;height:64px;border-radius:18px;background:#00b96b;display:flex;align-items:center;justify-content:center}',
	'.tsm-nodecard svg{display:block;width:36px;height:36px}',
	'.tsm-badge-c{position:absolute;top:-7px;right:-8px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#ff6f00;color:#fff;font-size:11.5px;font-weight:600;line-height:22px;text-align:center;font-variant-numeric:tabular-nums}',
	'.tsm-nodename{margin-top:10px;max-width:100%;font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-nodesub{margin-top:2px;font-size:11.5px;color:#8a8f98}',
	/* 概览：＋ 按钮与终端胶囊 */
	'.tsm-foot{display:flex;flex-direction:column;align-items:center;margin:22px 0 0}',
	'.tsm-plus{width:56px;height:56px;padding:0;border:none;border-radius:50%;background:rgba(255,111,0,.1);color:#ff6f00;font:inherit;font-size:26px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer}',
	'.tsm-plus.on{background:#ff6f00;color:#fff}',
	'.tsm-pill{margin-top:10px;padding:6px 14px;border-radius:999px;background:#fff;border:1px solid rgba(0,0,0,.06);font-size:13px;color:#1b1f24;font-variant-numeric:tabular-nums}',
	'.tsm-more{margin:16px 0 0}',
	'.tsm-more.off{display:none}',
	'.tsm-block{margin:0 0 14px}',
	/* 卡片与列表行（白底 14px 圆角、1px 细分隔线） */
	'.tsm-card{padding:12px 14px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,.06);min-width:0}',
	'.tsm-card-t{font-size:12px;color:#8a8f98;opacity:1}',
	'.tsm-card-v{font-size:17px;margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-card-s{font-size:11.5px;color:#8a8f98;line-height:1.45;opacity:1}',
	'.tsm-card-i{margin:0 0 10px}',
	'.tsm-rows{padding:2px 14px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,.06);margin:0}',
	'.tsm-rowline{padding:9px 0;font-size:13.5px;min-width:0}',
	'.tsm-rowline+.tsm-rowline{border-top:1px solid rgba(0,0,0,.06)}',
	'.tsm-row-l{min-width:0;color:#1b1f24}',
	'.tsm-row-num{color:#1b1f24;font-variant-numeric:tabular-nums}',
	'.tsm-row-s{font-size:11.5px;color:#8a8f98;opacity:1}',
	'.tsm-note{font-size:11.5px;color:#8a8f98;margin:0 0 12px;line-height:1.5;opacity:1}',
	'.tsm-sub{font-size:11.5px;color:#8a8f98;margin:6px 0 0;line-height:1.5}',
	'.tsm-h3{font-size:13px;padding:0;border:none;margin:0 0 6px}',
	'.tsm-h3-n{font-size:11.5px;color:#8a8f98}',
	'.tsm-empty{padding:28px 8px;text-align:center;font-size:13px;color:#8a8f98;opacity:1;margin:0}',
	'.tsm-empty-s{font-size:12px;color:#8a8f98;opacity:1}',
	/* 健康度（上色由 syncHealth 内联决定） */
	'.tsm-health{margin:0;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.03);border-left:3px solid #9e9e9e;font-size:12.5px;color:#1b1f24}',
	'.tsm-health-r{font-size:11.5px;color:#8a8f98;opacity:1}',
	/* 设备 / 应用：第 2 步接入，样式先按白底调好 */
	'.tsm-dev{padding:10px 2px;border-bottom:1px solid rgba(0,0,0,.06)}',
	'.tsm-dev:active{background:rgba(0,0,0,.03)}',
	'.tsm-dev-top{min-width:0}',
	'.tsm-dev-name{font-size:14px}',
	'.tsm-dev-bytes{font-variant-numeric:tabular-nums}',
	'.tsm-dev-sub{font-size:11.5px;color:#8a8f98;opacity:1}',
	'.tsm-marker{color:#8a8f98;opacity:1}',
	'.tsm-detail{margin:6px 0 2px 20px}',
	'.tsm-apps{background:rgba(0,0,0,.03);border-radius:10px}',
	'.tsm-apps-t{font-size:11px;color:#8a8f98;opacity:1}',
	'.tsm-app-b,.tsm-approw-b{font-variant-numeric:tabular-nums}',
	'.tsm-approw{padding:9px 2px;border-bottom:1px solid rgba(0,0,0,.06)}',
	/* 安装屏 */
	'.tsm-install-card{padding:16px 14px 14px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,.06)}',
	'.tsm-qr{border:1px solid rgba(0,0,0,.06);border-radius:10px}',
	'.tsm-qr-fail{color:#8a8f98}',
	'.tsm-qr-cap{font-size:11.5px;color:#8a8f98;opacity:1}',
	'.tsm-inst-btn{background:#ff6f00}',
	'.tsm-inst-ok{color:#00b96b}',
	'.tsm-inst-t{font-size:12.5px;color:#8a8f98;opacity:1}',
	'.tsm-inst-n{background:rgba(0,0,0,.06)}',
	'.tsm-inst-hint{font-size:11.5px;color:#8a8f98;opacity:1}',
	'.tsm-url-row{border-top:1px dashed rgba(0,0,0,.1)}',
	'.tsm-url{color:#1b1f24}',
	'.tsm-copy{background:#ff6f00}',
	/* 底部分页已移除：只保留顶部带文字 tab（避免无文字圆点的可发现性问题） */
	/* 窄屏收紧大号数字；宽屏整页限宽 480 居中 */
	'@media (max-width:359px){.tsm-big{font-size:34px}}',
	'@media (min-width:760px){#ts-mobile{max-width:480px;border-left:1px solid rgba(0,0,0,.06);border-right:1px solid rgba(0,0,0,.06);min-height:100vh}.tsm-page{padding:14px 18px 0}}',

	/* ================================================================
	 * 第 2 步：设备屏 / 节点屏（同样后置覆盖）
	 * ================================================================ */
	/* 设备屏：三个等宽分段 tab，视觉沿用 .tsm-tabs/.tsm-tab（这里只把 sticky 关掉） */
	'.tsm-dtabs{position:static;padding:0;background:#fff;border-bottom:1px solid rgba(0,0,0,.06)}',
	'.tsm-dtabs .tsm-tab{font-size:13.5px}',
	'.tsm-tab-n{font-size:11px;color:#8a8f98;font-variant-numeric:tabular-nums}',
	'.tsm-dtabs .tsm-tab.on .tsm-tab-n{color:#ff6f00}',
	/* 标题行：左「主网络设备 (N)」，右「筛选」漏斗 */
	'.tsm-dhead{display:flex;align-items:center;gap:6px;margin:12px 0 2px;min-width:0}',
	'.tsm-dtitle{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-dcount{flex:none;font-size:13px;color:#8a8f98;font-variant-numeric:tabular-nums}',
	'.tsm-dspring{flex:1 1 auto}',
	/* 搜索框：标题行下方整行，左放大镜 + 输入 + 有内容时才出现的清空按钮 */
	'.tsm-dsearch{display:flex;align-items:center;gap:6px;min-width:0;height:36px;margin:8px 0 2px;padding:0 10px;border-radius:18px;background:var(--tsm-soft);color:var(--tsm-sub)}',
	'.tsm-dsearch svg{display:block;flex:none}',
	'.tsm-dsearch-i{flex:1 1 auto;min-width:0;width:100%;padding:0;border:none;background:none;font:inherit;font-size:13px;line-height:1.4;color:var(--tsm-text);outline:none;-webkit-appearance:none;appearance:none}',
	'.tsm-dsearch-i::placeholder{color:var(--tsm-sub)}',
	'.tsm-dsearch-i::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;display:none}',
	'.tsm-dclear{position:relative;display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:none;border-radius:50%;background:none;color:var(--tsm-sub);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
	'.tsm-dclear::before{content:"";position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%)}',
	'.tsm-dclear:active{background:var(--tsm-soft)}',
	'.tsm-filter{display:flex;align-items:center;gap:4px;flex:none;font:inherit;font-size:13px;line-height:1.2;min-height:32px;padding:6px 10px;border:none;border-radius:16px;background:none;color:#ff6f00;cursor:pointer}',
	'.tsm-filter.on{background:rgba(255,111,0,.1)}',
	'.tsm-filter svg{display:block;flex:none}',
	/* 筛选面板：内联展开，选择后只重排本地数据 */
	'.tsm-fpanel{margin:8px 0 6px;padding:10px 12px;border-radius:12px;background:#fff;border:1px solid rgba(0,0,0,.06)}',
	'.tsm-flabel{font-size:11.5px;color:#8a8f98;margin:0 0 7px}',
	'.tsm-fchips{display:flex;flex-wrap:wrap;gap:8px}',
	'.tsm-fchips+.tsm-flabel{margin-top:12px}',
	'.tsm-chip{font:inherit;font-size:12.5px;line-height:1.2;min-height:44px;padding:10px 14px;border-radius:999px;border:1px solid var(--tsm-line-strong);background:var(--tsm-card-bg);color:var(--tsm-text);cursor:pointer}',
	/* 选中态：深色文字 + 橙色描边/浅底。橙字在白底上只有 ~2.8:1，不能当正文色。 */
	'.tsm-chip.on{color:var(--tsm-text);border-color:rgba(255,111,0,.55);background:rgba(255,111,0,.10);font-weight:600}',
	/* 设备行：40px 圆形底 + 三行文字 + 右侧速率两行 + 箭头，整行可点（>=44px） */
	'.tsm-ditem{border-bottom:1px solid rgba(0,0,0,.06)}',
	'.tsm-drow{display:flex;align-items:center;gap:10px;padding:10px 2px;min-height:44px;cursor:pointer}',
	'.tsm-drow:active{background:rgba(0,0,0,.03)}',
	'.tsm-dava{flex:none;width:40px;height:40px;border-radius:50%;color:#fff;font-size:16px;font-weight:600;line-height:40px;text-align:center;overflow:hidden}',
	'.tsm-dmid{flex:1 1 auto;min-width:0}',
	'.tsm-dname{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-dmeta{font-size:11.5px;color:#8a8f98;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-drates{flex:none;text-align:right;font-size:11.5px;color:#8a8f98;line-height:1.5;white-space:nowrap;font-variant-numeric:tabular-nums}',
	'.tsm-darrow{flex:none;color:#c0c4c9;font-size:18px;line-height:1;transition:transform .15s}',
	'.tsm-drow.on .tsm-darrow{transform:rotate(90deg)}',
	'.tsm-ddetail{margin:0 0 8px 50px}',
	'.tsm-dnote{font-size:11.5px;color:#8a8f98;text-align:center;margin:0;line-height:1.5}',
	/* 节点屏：浅色渐变欢迎区 → 「设备」大标题 + 橙色短横线 → 2 列卡片网格 */
	'.tsm-nhero{margin:-14px -16px 0;padding:14px 16px 12px;background:linear-gradient(180deg,#fff4ea 0%,rgba(255,244,234,.35) 60%,rgba(255,255,255,0) 100%)}',
	'.tsm-nhero-t{font-size:12px;color:#8a8f98;line-height:1.5}',
	'.tsm-nbig{font-size:22px;font-weight:700;letter-spacing:-.3px;margin:16px 0 0}',
	'.tsm-nbar{width:28px;height:3px;border-radius:2px;background:#ff6f00;margin:7px 0 14px}',
	'.tsm-ngrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}',
	'.tsm-ncard{position:relative;padding:14px 10px 12px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,.06);min-width:0}',
	'.tsm-nico{width:44px;height:44px;border-radius:12px;margin:0 auto;display:flex;align-items:center;justify-content:center}',
	'.tsm-nico svg{display:block;width:28px;height:28px}',
	'.tsm-nname{margin-top:8px;font-size:13.5px;font-weight:600;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-npillwrap{margin-top:6px;text-align:center}',
	'.tsm-npill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;line-height:1.6}',
	'.tsm-nmore{position:absolute;top:2px;right:2px;width:32px;height:32px;padding:0;border:none;border-radius:50%;background:none;color:#b0b4b9;font:inherit;font-size:17px;line-height:1;cursor:pointer}',
	'.tsm-nmore.on{color:#ff6f00}',
	'.tsm-ndetail{margin-top:10px;padding-top:8px;border-top:1px dashed rgba(0,0,0,.1);font-size:11.5px;color:#8a8f98;line-height:1.6}',
	'.tsm-ndrow{display:flex;justify-content:space-between;gap:8px;min-width:0}',
	'.tsm-ndrow-k{flex:none}',
	'.tsm-ndrow-v{flex:1 1 auto;min-width:0;text-align:right;color:#1b1f24;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-nnote{font-size:11.5px;color:#8a8f98;text-align:center;margin:0;line-height:1.5}',
	'@media (min-width:760px){.tsm-nhero{margin:-14px -18px 0}}',

	/* ================================================================
	 * 复审修复：概览数字不透明度 / 关键可点区域 ≥44×44 / 裁剪与错误提示
	 * ================================================================ */
	/* 旧规则 .tsm-rate{opacity:.8;margin:0 0 10px 0} 会压暗大号数字并多出间距，这里覆盖 */
	'.tsm-rate{opacity:1;margin:0}',
	/* 视觉尺寸不变、可点区域 ≥44px：透明元素撑盒模型 + 负 margin 抵消；
	   有底色的刷新/筛选按钮改用透明 ::before 覆盖层，避免背景被撑大 */
	'.tsm-tab{min-height:44px;padding-top:12px;margin:-4px 0 -4px}',
	'.tsm-nmore{width:44px;height:44px;top:-4px;right:-4px}',
	'.tsm-refresh{position:relative}',
	'.tsm-refresh::before{content:"";position:absolute;left:-2px;right:-2px;top:50%;height:44px;margin-top:-22px}',
	'.tsm-filter{position:relative}',
	'.tsm-filter::before{content:"";position:absolute;left:0;right:0;top:50%;height:44px;margin-top:-22px}',
	/* 后端裁剪 / 节点刷新失败提示 */
	'.tsm-dtrunc{display:none;margin:8px 0 0;color:#b26a00;line-height:1.5}',
	'.tsm-nerr{margin:0 0 10px;padding:8px 10px;border-radius:10px;background:rgba(198,40,40,.08);color:#c62828;font-size:11.5px;line-height:1.5;border-left:3px solid #c62828;word-break:break-word}',
	'.tsm-apps-trunc{font-size:11px;color:#b26a00;margin:0 0 4px}',

	/* ================================================================
	 * 第 3 步：网络拓扑屏 + 主题变量
	 * 卡片/分隔线/次级文字统一走变量，深色主题只改变量，强调色不动。
	 * ================================================================ */
	'#ts-mobile{--tsm-card-bg:#fff;--tsm-line:rgba(0,0,0,.06);--tsm-line-strong:rgba(0,0,0,.1);--tsm-wire:rgba(0,0,0,.26);--tsm-text:#1b1f24;--tsm-sub:#8a8f98;--tsm-accent:#ff6f00;--tsm-green:#00b96b;--tsm-blue:#2b7de9;--tsm-soft:rgba(0,0,0,.03)}',
	'.tsm-card,.tsm-rows,.tsm-ncard,.tsm-install-card,.tsm-fpanel,.tsm-pill,.tsm-inet,.tsm-exit,.tsm-router-card,.tsm-ap,.tsm-tgroup{background:var(--tsm-card-bg);border-color:var(--tsm-line)}',
	'.tsm-tabs,.tsm-dtabs{background:var(--tsm-card-bg);border-color:var(--tsm-line)}',
	'.tsm-meta,.tsm-rate-cap,.tsm-nodesub,.tsm-card-t,.tsm-card-s,.tsm-row-s,.tsm-note,.tsm-sub,.tsm-h3-n,.tsm-dev-sub,.tsm-marker,.tsm-apps-t,.tsm-dmeta,.tsm-drates,.tsm-dcount,.tsm-dnote,.tsm-nhero-t,.tsm-nnote,.tsm-ndetail,.tsm-tab,.tsm-tab-n,.tsm-flabel,.tsm-tl-h,.tsm-tl-empty,.tsm-ap-dev,.tsm-ap-meta,.tsm-exit-bytes,.tsm-ndrow-k,.tsm-empty,.tsm-empty-s{color:var(--tsm-sub)}',
	'.tsm-row-l,.tsm-row-num,.tsm-ndrow-v,.tsm-url,.tsm-chip,.tsm-tab.on,.tsm-pill,.tsm-health,.tsm-router-name,.tsm-exit-name,.tsm-ap-name{color:var(--tsm-text)}',

	/* ---- 拓扑屏：纵向 5 层 + CSS 竖线/圆点连接 ---- */
	'.tsm-topo-page{padding-bottom:8px}',
	'.tsm-topo{display:block;min-width:0}',
	'.tsm-topo-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;margin:0}',
	'.tsm-tstack{display:flex;flex-direction:column;min-width:0}',
	'.tsm-tl{min-width:0}',
	'.tsm-tl-h{font-size:11.5px;letter-spacing:.04em;margin:0 2px 6px}',
	'.tsm-tl-b{min-width:0}',
	'.tsm-tl-empty{margin:0;padding:8px 2px;font-size:12.5px;line-height:1.5}',
	'.tsm-tl-warn{margin:0 0 6px;padding:6px 9px;border-radius:8px;font-size:11.5px;line-height:1.5;color:#b26a00;background:rgba(249,171,0,.12);border-left:3px solid #f9ab00;word-break:break-word}',
	'.tsm-conn{position:relative;height:22px;display:flex;align-items:center;justify-content:center}',
	'.tsm-conn::before{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--tsm-line-strong)}',
	'.tsm-conn-d{position:relative;width:6px;height:6px;border-radius:50%;background:var(--tsm-green);flex:none}',
	/* L1 互联网 */
	'.tsm-inet{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;border:1px solid var(--tsm-line);min-width:0}',
	'.tsm-inet-ico{flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center}',
	'.tsm-inet-ico svg{display:block;width:40px;height:40px}',
	'.tsm-inet-txt{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	/* L2 出口：最多 3 张，DIRECT 绿描边 / 代理蓝描边 */
	'.tsm-exits{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;min-width:0}',
	'.tsm-exit{min-width:0;padding:9px 10px;border-radius:12px;border-width:1.5px;border-style:solid;cursor:pointer}',
	'.tsm-exit-direct{border-color:var(--tsm-green)}',
	'.tsm-exit-proxy{border-color:var(--tsm-blue)}',
	'.tsm-exit-top{display:flex;align-items:center;gap:4px;min-width:0}',
	'.tsm-exit-name{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-exit-badge{flex:none;font-size:10px;line-height:1.6;padding:0 5px;border-radius:4px;color:var(--tsm-green);background:rgba(0,185,107,.12);white-space:nowrap}',
	'.tsm-exit-badge-proxy{color:var(--tsm-blue);background:rgba(43,125,233,.12)}',
	'.tsm-exit-bytes{margin-top:4px;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	/* L3 主路由 */
	'.tsm-router-card{display:flex;align-items:center;gap:10px;padding:12px;border-radius:14px;border:1px solid var(--tsm-line);min-width:0}',
	'.tsm-router-ico{flex:none;width:44px;height:44px;border-radius:12px;background:var(--tsm-green);display:flex;align-items:center;justify-content:center}',
	'.tsm-router-ico svg{display:block;width:28px;height:28px}',
	'.tsm-router-mid{flex:1 1 auto;min-width:0}',
	'.tsm-router-name{font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-router-meta,.tsm-router-links{font-size:11.5px;line-height:1.5;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tsm-sub)}',
	'.tsm-router-online{flex:none;text-align:right;font-size:11px;line-height:1.35;white-space:nowrap;color:var(--tsm-sub)}',
	'.tsm-router-online b{display:block;font-size:16px;line-height:1.2;font-variant-numeric:tabular-nums;color:var(--tsm-text)}',
	/* L4 AP */
	'.tsm-aps{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0}',
	'.tsm-ap{min-width:0;padding:10px;border-radius:12px;border:1px solid var(--tsm-line);cursor:pointer}',
	'.tsm-ap-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-ap-state{display:inline-block;margin-top:4px;font-size:10.5px;line-height:1.6;padding:0 6px;border-radius:999px;color:var(--tsm-sub);background:var(--tsm-soft);white-space:nowrap}',
	'.tsm-ap.on .tsm-ap-state{color:var(--tsm-green);background:rgba(0,185,107,.12)}',
	'.tsm-ap-dev,.tsm-ap-meta{font-size:11px;line-height:1.5;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tsm-sub)}',
	/* 拓扑下钻：出口/AP 卡内展开的在线设备列表（默认隐藏，点击卡片才显示） */
	'.tsm-xlist{margin-top:6px;padding-top:4px;border-top:1px solid var(--tsm-line);min-width:0}',
	'.tsm-xrow{display:flex;align-items:center;gap:6px;min-height:24px;font-size:11.5px;line-height:1.4;min-width:0;color:var(--tsm-sub)}',
	'.tsm-xname{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tsm-text)}',
	'.tsm-xrate{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--tsm-sub)}',
	'.tsm-xempty{margin:4px 0 0;font-size:11px;line-height:1.5;color:var(--tsm-sub)}',
	/* L5 设备：三组；组内是 CSS 树状连线（树干 → 每行总线 → 节点），行高变化也不会脱节 */
	'.tsm-tgroups{display:flex;flex-direction:column;gap:10px;min-width:0}',
	'.tsm-tgroup{min-width:0;padding:2px 10px 8px;border-radius:12px;border:1px solid var(--tsm-line)}',
	'.tsm-tgroup-h{font-size:11.5px;padding:6px 0 4px;border-bottom:1px solid var(--tsm-line);color:var(--tsm-sub)}',
	'.tsm-tgroup-body{min-width:0}',
	/* 树：父节点 → 每行一条总线 → 总线向下连到本行每个节点；连接线不跨行、不跨节点 */
	'.tsm-ttree{position:relative;display:flex;flex-direction:column;align-items:center;width:100%;min-width:0}',
	'.tsm-ttrunk,.tsm-tstem{flex:none;width:1.5px;background:var(--tsm-wire)}',
	'.tsm-ttrunk{height:12px}',
	'.tsm-tstem{height:10px}',
	'.tsm-trow{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:8px;row-gap:0;width:100%;min-width:0;padding-top:12px}',
	'.tsm-trow-bus{position:absolute;top:0;left:25%;width:50%;height:1.5px;background:var(--tsm-wire);pointer-events:none}',
	'.tsm-trow.is-single .tsm-trow-bus{display:none}',
	'.tsm-trow.is-single .tsm-dnode{grid-column:1 / -1}',
	'.tsm-ttree>.tsm-dmore{align-self:stretch;margin-top:8px}',
	/* 设备节点：状态环 + 类型图标 + 名称（2 行省略）+ 速率 */
	'.tsm-dnode{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;padding:4px 2px;border-radius:10px;cursor:pointer;text-align:center}',
	'.tsm-dnode:active{background:var(--tsm-soft)}',
	/* 节点到本行总线的竖线：从节点顶部向上 12px（正好是 .tsm-trow 的 padding-top） */
	'.tsm-dnode::before{content:"";position:absolute;top:-12px;left:50%;width:1.5px;height:12px;background:var(--tsm-wire);transform:translateX(-50%);pointer-events:none}',
	'.tsm-dnode-ring{flex:none;width:46px;height:46px;border-radius:50%;border:1.5px solid var(--tsm-line-strong);display:flex;align-items:center;justify-content:center;background:var(--tsm-card-bg);color:var(--tsm-sub)}',
	'.tsm-dnode.is-wifi .tsm-dnode-ring{border-color:var(--tsm-blue);color:var(--tsm-blue)}',
	'.tsm-dnode.is-wired .tsm-dnode-ring{border-color:var(--tsm-green);color:var(--tsm-green)}',
	'.tsm-dnode.is-unknown .tsm-dnode-ring{border-color:var(--tsm-line-strong);color:var(--tsm-sub)}',
	'.tsm-dnode.is-off{opacity:.65}',
	'.tsm-dnode.is-off .tsm-dnode-ring{border-color:var(--tsm-line-strong);color:var(--tsm-sub)}',
	'.tsm-dnode-ico{display:flex;align-items:center;justify-content:center;width:22px;height:22px}',
	'.tsm-dnode-ico svg{display:block;width:22px;height:22px}',
	'.tsm-dnode-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:11.5px;line-height:1.35;overflow-wrap:break-word;color:var(--tsm-text);max-width:100%}',
	'.tsm-dnode-rate{font-size:10.5px;line-height:1.3;color:var(--tsm-sub);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
	'.tsm-dmore{display:flex;align-items:center;justify-content:center;min-height:46px;padding:2px 4px;border-radius:10px;border:1px dashed var(--tsm-line-strong);font-size:11px;line-height:1.4;color:var(--tsm-sub);text-align:center}',
	/* 概览屏「设备拓扑」：主路由根节点 → 树干 → 每行总线 → 两列节点 */
	'.tsm-otopo{margin:10px 0 0;padding:12px 10px 10px;border-radius:14px;border:1px solid var(--tsm-line);background:var(--tsm-card-bg);min-width:0}',
	'.tsm-otop-root{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}',
	'.tsm-otop-ico{flex:none;width:46px;height:46px;border-radius:50%;background:var(--tsm-green);display:flex;align-items:center;justify-content:center}',
	'.tsm-otop-ico svg{display:block;width:28px;height:28px}',
	'.tsm-otop-name{max-width:100%;font-size:11.5px;line-height:1.4;color:var(--tsm-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-otop-empty{margin:6px 0 0;text-align:center;font-size:12px;line-height:1.5;color:var(--tsm-sub)}',
	/* 320px 窄屏：拓扑卡片全部省略号 + 收紧层间距，绝不横向溢出 */
	'@media (max-width:359px){.tsm-exits{grid-template-columns:1fr 1fr}.tsm-exit{padding:8px}.tsm-exit-name{font-size:12px}.tsm-aps{grid-template-columns:1fr}.tsm-tl-h{margin-bottom:4px}.tsm-conn{height:16px}.tsm-dnode-name{font-size:11px}}',
	'@media (max-width:320px){.tsm-topo .tsm-exits{grid-template-columns:1fr}.tsm-topo .tsm-exit{padding:7px 8px}.tsm-topo .tsm-exit-name,.tsm-topo .tsm-ap-name,.tsm-topo .tsm-router-name,.tsm-topo .tsm-inet-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tsm-topo .tsm-conn{height:14px}.tsm-topo .tsm-tl-h{margin-bottom:4px}.tsm-topo .tsm-ap{padding:8px}.tsm-topo .tsm-router-card{gap:8px;padding:10px}.tsm-topo .tsm-router-ico{width:38px;height:38px}.tsm-topo .tsm-router-ico svg{width:24px;height:24px}.tsm-topo .tsm-xname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tsm-trow{grid-template-columns:repeat(2,minmax(0,1fr))}.tsm-dnode-ring{width:40px;height:40px}.tsm-dnode-ico,.tsm-dnode-ico svg{width:20px;height:20px}.tsm-otopo{padding:10px 8px 8px}.tsm-dsearch{padding:0 8px;gap:4px;margin-left:0;margin-right:0}}',
	/* 深色主题：只改背景/分隔线/次级文字，橙/绿/蓝强调色保持不变；不用纯黑 */
	'@media (prefers-color-scheme: dark){#ts-mobile{--tsm-card-bg:#1c2026;--tsm-line:rgba(255,255,255,.1);--tsm-line-strong:rgba(255,255,255,.18);--tsm-wire:rgba(255,255,255,.34);--tsm-text:#e7eaee;--tsm-sub:#a4abb5;--tsm-soft:rgba(255,255,255,.06);background:#14171b;color:#e7eaee}#ts-mobile .tsm-tabs,#ts-mobile .tsm-dtabs{background:#1c2026}#ts-mobile .tsm-nhero{background:linear-gradient(180deg,rgba(255,111,0,.14) 0%,rgba(255,111,0,.05) 60%,rgba(20,23,27,0) 100%)}#ts-mobile .tsm-tab.on{color:#e7eaee}#ts-mobile .tsm-health{background:rgba(255,255,255,.05)}}',

	/* ================================================================
	 * 第 4 步：下拉刷新 / 骨架屏 / 切屏过渡 / 安全区 / 迷你趋势 / Top3
	 * 全部走颜色变量，深色主题自动跟随。
	 * ================================================================ */
	/* ---- 安全区：刘海与底部横条不遮挡内容（viewport-fit=cover 由 injectPwaHead 保证）---- */
	'#ts-mobile{padding-top:env(safe-area-inset-top,0px);padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}',
	'.tsm-tabs{top:env(safe-area-inset-top,0px)}',
	/* ---- 下拉刷新指示器：绝对定位在 .tsm-pages 顶部，默认藏在 sticky tab 后面 ---- */
	'.tsm-pages{position:relative}',
	'.tsm-pull{position:absolute;top:0;left:0;right:0;z-index:5;display:flex;align-items:center;justify-content:center;gap:6px;height:56px;pointer-events:none;opacity:0;transform:translateY(-100%);transition:transform .18s ease-out,opacity .18s ease-out;background:var(--tsm-card-bg);color:var(--tsm-sub);font-size:12px;border-bottom:1px solid var(--tsm-line)}',
	'.tsm-pull-ico{flex:none;display:block;transform-origin:50% 50%}',
	'.tsm-pull.busy .tsm-pull-ico{animation:tsm-spin .9s linear infinite}',
	'@keyframes tsm-spin{to{transform:rotate(360deg)}}',
	/* ---- 骨架屏：灰条 + shimmer 横扫；减少动态偏好时彻底关掉 ---- */
	'.tsm-skel{position:relative;overflow:hidden;background:rgba(127,127,127,.16);border-radius:10px;min-width:0}',
	'.tsm-skel::after{content:"";position:absolute;top:0;bottom:0;left:0;right:0;background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.45) 50%,rgba(255,255,255,0) 100%);transform:translateX(-100%);animation:tsm-shimmer 1.2s ease-in-out infinite}',
	'@keyframes tsm-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
	'.tsm-skel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 12px;min-width:0}',
	'.tsm-skel-num{height:54px}',
	'.tsm-skel-list{margin:8px 0 0;min-width:0}',
	'.tsm-skel-row{height:44px;margin:0 0 8px}',
	'.tsm-skel-stack{display:block;min-width:0;margin:0 0 6px}',
	'.tsm-skel-card{height:84px;margin:0 0 8px}',
	/* ---- 切屏过渡：淡入 + 8px 横向位移，150ms；同一时间仍只有 .on 那屏可见 ---- */
	'.tsm-page.on.is-enter-next{animation:tsm-enter-next .15s ease-out both}',
	'.tsm-page.on.is-enter-prev{animation:tsm-enter-prev .15s ease-out both}',
	'@keyframes tsm-enter-next{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}',
	'@keyframes tsm-enter-prev{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}',
	/* ---- 迷你趋势：120×32，下行蓝 / 上行橙，与其它屏配色一致 ---- */
	'.tsm-sparkwrap{display:flex;align-items:center;gap:8px;margin:8px 0 0;min-width:0}',
	'.tsm-spark{display:block;flex:none;width:120px;height:32px}',
	'.tsm-spark-cap{font-size:11px;line-height:1.4;color:var(--tsm-sub);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
	/* ---- 概览 Top3：设备行可点（≥40px），应用行只展示不可点 ---- */
	'.tsm-top3{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0 0;min-width:0}',
	'.tsm-topcard{min-width:0;padding:10px 12px;border-radius:14px;background:var(--tsm-card-bg);border:1px solid var(--tsm-line)}',
	'.tsm-topcard-t{font-size:12px;line-height:1.4;color:var(--tsm-sub);margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-toprow{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;min-width:0;min-height:40px;padding:0;margin:0;border:none;background:none;font:inherit;font-size:12.5px;line-height:1.35;color:var(--tsm-text);text-align:left}',
	'.tsm-toprow.is-link{cursor:pointer}',
	'.tsm-toprow.is-link:active{opacity:.72}',
	'.tsm-topname{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-topval{flex:none;font-size:11.5px;color:var(--tsm-sub);font-variant-numeric:tabular-nums;white-space:nowrap}',
	'.tsm-toprow-empty{display:flex;align-items:center;min-height:40px;font-size:12px;color:var(--tsm-sub)}',
	'@media (max-width:359px){.tsm-top3{grid-template-columns:1fr}.tsm-spark-cap{display:none}}',
	/* ---- 离线快照提示条：sticky 顶部 + 安全区；出现时把顶部分段 tab 顺次下移 40px，不遮内容 ---- */
	'.tsm-offline{display:none;align-items:center;justify-content:space-between;gap:10px;position:sticky;top:env(safe-area-inset-top,0px);z-index:20;min-height:40px;padding:5px 14px;background:rgba(249,171,0,.16);border-bottom:1px solid rgba(249,171,0,.42);color:#8a5a00;font-size:12px;line-height:1.3}',
	'.tsm-offline-t{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'.tsm-offline-btn{position:relative;flex:none;font:inherit;font-size:12px;line-height:1;padding:0 12px;min-height:30px;border-radius:15px;color:#8a5a00;background:rgba(249,171,0,.22);border:1px solid rgba(178,106,0,.5);cursor:pointer}',
	'.tsm-offline-btn::before{content:"";position:absolute;left:0;right:0;top:-7px;height:44px}',
	'.tsm-offline-btn:active{background:rgba(249,171,0,.38)}',
	'.tsm-app.tsm-offline-on .tsm-tabs{top:calc(env(safe-area-inset-top,0px) + 40px)}',
	/* ---- 安装屏「离线数据」：状态一行 + 清除按钮 ---- */
	'.tsm-offline-card{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:var(--tsm-soft);border:1px solid var(--tsm-line)}',
	'.tsm-offline-note{flex:1 1 auto;min-width:0;font-size:12px;line-height:1.4;color:var(--tsm-sub);word-break:break-word}',
	'.tsm-offline-clear{position:relative;flex:none;font:inherit;font-size:12.5px;line-height:1;padding:0 12px;min-height:32px;border-radius:16px;color:#c62828;background:rgba(198,40,40,.08);border:1px solid rgba(198,40,40,.36);cursor:pointer}',
	'.tsm-offline-clear::before{content:"";position:absolute;left:0;right:0;top:-6px;height:44px}',
	'.tsm-offline-clear:active{background:rgba(198,40,40,.18)}',
	'@media (prefers-color-scheme: dark){#ts-mobile .tsm-offline{background:rgba(249,171,0,.2);color:#f3c675}#ts-mobile .tsm-offline-btn{color:#f3c675;background:rgba(249,171,0,.24)}}',
	/* ---- 减少动态偏好：新增的动画 / 过渡一律关闭 ---- */
	'@media (prefers-reduced-motion: reduce){.tsm-skel::after{animation:none;background:none}}',
	'@media (prefers-reduced-motion: reduce){.tsm-page.on.is-enter-next,.tsm-page.on.is-enter-prev{animation:none}}',
	'@media (prefers-reduced-motion: reduce){.tsm-pull,.tsm-pull-ico{transition:none}.tsm-pull.busy .tsm-pull-ico{animation:none}}'
].join('\n');

// ---------------------------------------------------------------- 设备屏 / 节点屏（第 2 步）

/*
 * 设备分类与节点状态都是**模块级纯函数**：只吃数据，不碰 DOM、不发 RPC，
 * 方便单测直接调，也保证 15s 轮询时同一份数据永远得到同一份分类结果。
 */

var OFFLINE_SEC = 600;      /* 与概览页「最近 10 分钟」同一口径 */
var NODE_STALE_SEC = 300;   /* 子节点快照超过 5 分钟没更新 → 未绑定 */
/* state 冻结判据：max(90 秒, 6 个轮询周期)，daemon 停摆后要能看出来。 */
var STALE_STATE_SEC = Math.max(90, 6 * Math.round(REFRESH_MS / 1000));

var DEV_TABS = [
	{ id: 'main', label: '主网络设备', empty: '暂无在线设备' },
	{ id: 'guest', label: '访客设备', empty: '没有访客设备' },
	{ id: 'offline', label: '离线设备', empty: '没有离线设备' }
];

var DEV_SORTS = [
	{ id: 'total', label: '合计流量' },
	{ id: 'rx', label: '下载速率' },
	{ id: 'name', label: '名称' }
];

var DEV_LINKS = [
	{ id: 'wifi', label: '仅无线' },
	{ id: 'wired', label: '仅有线' }
];

/*
 * 设备屏时钟基准：**只用真实当前时间**。
 * state.ts 是后端写快照的时间，prism-routerd 停摆后它会冻住；拿它算在线会把
 * 陈旧设备一直显示成在线。state.ts 只用于顶部「更新于」显示。
 */
function deviceNow() {
	return nowSec();
}

/*
 * 在线 = last_seen > 0 且距今 ≤ 600；last_seen<=0 一律离线。
 * 未来时间戳只有落在 +60 秒内（设备时钟漂移）才算在线，与 overview.js 同口径。
 */
function isDeviceOnline(dev, now) {
	var seen = num(dev != null ? dev.last_seen : 0);
	var base = num(now);

	if (base <= 0) base = nowSec();
	if (seen <= 0) return false;
	if (seen > base + 60) return false;

	return (base - seen) <= OFFLINE_SEC;
}

/* 访客：group 或 alias 文本里含「访客」或 guest（大小写不敏感）。 */
function isGuestDevice(dev) {
	if (dev == null) return false;

	var text = ('' + (dev.group != null ? dev.group : '') + ' ' +
		(dev.alias != null ? dev.alias : '')).toLowerCase();

	return text.indexOf('访客') >= 0 || text.indexOf('guest') >= 0;
}

/* 分类优先级：先看在线与否，在线再分访客 / 主网络。 */
function classifyDevice(dev, now) {
	if (!isDeviceOnline(dev, now)) return 'offline';

	return isGuestDevice(dev) ? 'guest' : 'main';
}

function groupDevices(devices, now) {
	var list = Array.isArray(devices) ? devices : [];
	var base = (num(now) > 0) ? num(now) : deviceNow();
	var out = { main: [], guest: [], offline: [] };

	for (var i = 0; i < list.length; i++) {
		var dev = list[i];

		if (dev == null) continue;

		out[classifyDevice(dev, base)].push(dev);
	}

	return out;
}

/* 连接节点 = 该设备 apps 里 rx+tx 最大的那条 chain；DIRECT→直连，没有 apps→「—」。 */
function deviceChainLabel(dev) {
	var list = appListOf(dev);

	if (list.length == 0) return '—';

	var chain = list[0].chain;

	if (chain.length == 0) return '—';

	var upper = chain.toUpperCase();

	if (upper == 'DIRECT') return _('直连');
	if (upper == 'MIXED') return _('混合');

	return chain;
}

/* 名称排序用码点比较（不依赖 locale，测试环境也一致）。 */
function compareDeviceName(a, b) {
	var an = deviceName(a);
	var bn = deviceName(b);

	if (an < bn) return -1;
	if (an > bn) return 1;

	return 0;
}

function sortDevices(list, sort) {
	var arr = (Array.isArray(list) ? list : []).slice();

	if (sort == 'name') arr.sort(compareDeviceName);
	else if (sort == 'rx') arr.sort(function(a, b) { return num(b != null ? b.rx_rate : 0) - num(a != null ? a.rx_rate : 0); });
	else arr.sort(function(a, b) { return deviceTotal(b) - deviceTotal(a); });

	return arr;
}

/* link 为空串/非法值 = 不过滤；点第二次同一项由调用方传空串取消。 */
function filterDevicesByLink(list, link) {
	var arr = Array.isArray(list) ? list : [];

	if (link != 'wifi' && link != 'wired') return arr.slice();

	return arr.filter(function(dev) { return linkOf(dev) == link; });
}

/*
 * 搜索：显示名 / 主机名 / 别名 / MAC / IP 任一包含关键词即命中（大小写不敏感）。
 * 空关键词视为不过滤；两头空白会去掉，避免手机输入法带空格时搜不到。
 */
function deviceMatchesQuery(dev, query) {
	var q = ('' + ((query == null) ? '' : query)).replace(/^\s+|\s+$/g, '').toLowerCase();

	if (!q.length) return true;
	if (dev == null) return false;

	var fields = [ deviceName(dev), dev.hostname, dev.alias, dev.mac, dev.ip ];
	var i, text;

	for (i = 0; i < fields.length; i++) {
		text = (fields[i] == null) ? '' : ('' + fields[i]);

		if (text.toLowerCase().indexOf(q) >= 0) return true;
	}

	return false;
}

function filterDevicesByQuery(list, query) {
	var arr = Array.isArray(list) ? list : [];
	var q = ('' + ((query == null) ? '' : query)).replace(/^\s+|\s+$/g, '');

	if (!q.length) return arr.slice();

	return arr.filter(function(dev) { return deviceMatchesQuery(dev, q); });
}

/* 分类 → 链路筛选 → 搜索 → 排序；只重排本地数据，不发 RPC。 */
function deviceViewList(devices, now, tab, sort, link, query) {
	var groups = groupDevices(devices, now);
	var base = groups[tab] ? groups[tab] : [];

	return sortDevices(filterDevicesByQuery(filterDevicesByLink(base, link), query), sort);
}

/* 圆形底上的首字符：中文取第一个汉字，空名字用 ?（代理对也取整个字符）。 */
function deviceInitial(dev) {
	var name = ('' + deviceName(dev)).replace(/^\s+|\s+$/g, '');

	if (!name.length || name == _('未知设备')) return '?';

	var code = (typeof name.codePointAt == 'function') ? name.codePointAt(0) : name.charCodeAt(0);

	return (typeof String.fromCodePoint == 'function') ? String.fromCodePoint(code) : name.charAt(0);
}

/* 设备行的时间文本：离线要明确写出来（只写「10 分钟前」会让人误以为还在线）。
 * 没有可信 last_seen（<=0）只写「离线」；有 last_seen 但已超时的补上相对时间。 */
function deviceSeenLabel(dev, now) {
	var seen = num(dev != null ? dev.last_seen : 0);

	if (!isDeviceOnline(dev, now))
		return (seen > 0) ? (_('离线') + ' · ' + fmtAgo(seen, now)) : _('离线');

	return fmtAgo(seen, now);
}

/* 相对时间：离线（没有可信 last_seen）/ 刚刚 / N 分钟前 / N 小时前 / N 天前。 */
function fmtAgo(lastSeen, now) {
	var seen = num(lastSeen);

	if (seen <= 0) return _('离线');

	var base = (num(now) > 0) ? num(now) : deviceNow();
	var d = base - seen;

	if (d < 0) d = 0;
	if (d < 60) return _('刚刚');
	if (d < 3600) return Math.floor(d / 60) + ' ' + _('分钟前');
	if (d < 86400) return Math.floor(d / 3600) + ' ' + _('小时前');

	return Math.floor(d / 86400) + ' ' + _('天前');
}

/* 时长（不带「前/后」）：用于「数据已 1 小时未更新」这类状态提示。 */
function fmtSpan(seconds) {
	var s = num(seconds);

	if (s < 60) return Math.max(1, Math.floor(s)) + ' ' + _('秒');
	if (s < 3600) return Math.floor(s / 60) + ' ' + _('分钟');
	if (s < 86400) return Math.floor(s / 3600) + ' ' + _('小时');

	return Math.floor(s / 86400) + ' ' + _('天');
}

function rateText(bytesPerSecond) {
	return present(bytesPerSecond) ? fmtMbps(bytesPerSecond) : '—';
}

/* 节点状态：age_sec<0 = 时间戳不可信 → 未知；<=300s 在线；更久 → 未绑定（待上报）。 */
function nodeStatus(ageSec) {
	var age = (typeof ageSec == 'number' && isFinite(ageSec)) ? ageSec : null;

	if (age == null || age < 0)
		return { kind: 'unknown', label: _('未知'), color: '#757575', bg: 'rgba(0,0,0,.06)', ico: '#9e9e9e' };

	if (age <= NODE_STALE_SEC)
		return { kind: 'online', label: _('在线'), color: '#2e7d32', bg: 'rgba(76,175,80,.14)', ico: '#00b96b' };

	return { kind: 'unbound', label: _('未绑定'), color: '#b26a00', bg: 'rgba(249,171,0,.18)', ico: '#f0a020' };
}

function nodeTotalsOf(node) {
	var latest = (node != null && node.latest != null && typeof node.latest == 'object') ? node.latest : null;

	return (latest != null && latest.totals != null && typeof latest.totals == 'object') ? latest.totals : null;
}

function nodeDeviceCount(node) {
	var latest = (node != null && node.latest != null && typeof node.latest == 'object') ? node.latest : null;

	if (latest == null || !Array.isArray(latest.devices)) return null;

	return latest.devices.length;
}

function nodeIdOf(node, index) {
	if (node != null && node.node_id != null && ('' + node.node_id).length) return '' + node.node_id;

	return '#' + index;
}

function nodeNameOf(node, index) {
	if (node != null && node.name != null && ('' + node.name).length) return '' + node.name;

	return nodeIdOf(node, index);
}

/* 节点列表签名：age_sec 本身每轮都变（服务端按 now-ts 算），只取状态档位，避免整格重建。 */
function nodeSigField(node) {
	var totals = nodeTotalsOf(node);
	var count = nodeDeviceCount(node);

	return [
		'' + nodeIdOf(node, 0),
		'' + nodeNameOf(node, 0),
		num(node != null ? node.ts : 0),
		nodeStatus(node != null ? node.age_sec : -1).kind,
		totals != null ? totalOf(totals) : '-',
		count == null ? '-' : count
	].join('|');
}

// ---------------------------------------------------------------- 网络拓扑（第 3 步）

var TOPO_MAX_EXITS = 3;    /* 出口层最多 3 张卡 */
var TOPO_MAX_DEVICES = 5;  /* 设备层每组最多 5 台 */
var TOPO_DRILL_MAX = 8;    /* 出口/AP 卡下钻最多列 8 台在线设备 */
var TOPO_AP_FRESH_SEC = 300; /* AP 上报 ≤5 分钟算在线（与节点胶囊同一阈值） */

var TOPO_GROUPS = [ 'wifi', 'wired', 'unknown' ];

/*
 * state.nodes（名字 → {rx,tx}）→ 出口卡片列表：按 rx+tx 从大到小取前 N。
 * DIRECT 是真实出口（标「直连」），UNKNOWN 只是后端合成的空 chain 桶，跳过。
 */
function topoExitList(nodes, max) {
	var src = (nodes != null && typeof nodes == 'object') ? nodes : {};
	var limit = (typeof max == 'number' && max > 0) ? Math.floor(max) : TOPO_MAX_EXITS;
	var list = [];

	for (var key in src) {
		if (!src.hasOwnProperty(key)) continue;

		var name = '' + key;

		if (!name.length) continue;

		var upper = name.toUpperCase();

		if (upper == 'UNKNOWN') continue;

		var entry = (src[key] != null && typeof src[key] == 'object') ? src[key] : {};
		var rx = num(entry.rx);
		var tx = num(entry.tx);

		list.push({
			name: name,
			direct: (upper == 'DIRECT'),
			rx: rx,
			tx: tx,
			total: rx + tx
		});
	}

	list.sort(function(a, b) {
		if (b.total != a.total) return b.total - a.total;

		return (a.name < b.name) ? -1 : ((a.name > b.name) ? 1 : 0);
	});

	return list.slice(0, limit);
}

/* 在线设备（真实当前时间口径，与设备屏/概览一致）。 */
function topoOnlineDevices(devices, now) {
	var list = Array.isArray(devices) ? devices : [];
	var out = [];

	for (var i = 0; i < list.length; i++) {
		if (list[i] != null && isDeviceOnline(list[i], now)) out.push(list[i]);
	}

	out.sort(function(a, b) {
		var d = deviceTotal(b) - deviceTotal(a);

		if (d != 0) return d;

		return compareDeviceName(a, b);
	});

	return out;
}

/* 在线设备按 link（wifi / wired / unknown）分组，组内仍按累计流量降序。 */
function topoDeviceGroups(devices, now) {
	var online = topoOnlineDevices(devices, now);
	var out = { wifi: [], wired: [], unknown: [] };

	for (var i = 0; i < online.length; i++) {
		var link = linkOf(online[i]);

		if (!out[link]) link = 'unknown';

		out[link].push(online[i]);
	}

	return out;
}

function topoLinkCounts(devices, now) {
	var groups = topoDeviceGroups(devices, now);

	return {
		wifi: groups.wifi.length,
		wired: groups.wired.length,
		unknown: groups.unknown.length
	};
}

/* 设备 apps 里出现过的 chain 列表（出口下钻只看 apps 的 chain）。 */
function deviceChains(dev) {
	var list = appListOf(dev);
	var out = [];

	for (var i = 0; i < list.length; i++) {
		if (list[i].chain.length) out.push(list[i].chain);
	}

	return out;
}

/*
 * 出口下钻：在线设备的 apps 里任一 chain 等于出口名（DIRECT 卡大小写不敏感）。
 * 在线列表本身已按累计流量降序，直接截取前 max 台即可。
 */
function exitDrillDevices(exit, devices, now, max) {
	var online = topoOnlineDevices(devices, now);
	var limit = (typeof max == 'number' && max > 0) ? Math.floor(max) : TOPO_DRILL_MAX;
	var out = [];
	var i, j, chains, hit;

	if (exit == null) return out;

	for (i = 0; i < online.length && out.length < limit; i++) {
		chains = deviceChains(online[i]);
		hit = false;

		for (j = 0; j < chains.length; j++) {
			if (exit.direct) {
				if (chains[j].toUpperCase() == 'DIRECT') {
					hit = true;
					break;
				}
			}
			else if (chains[j] === exit.name) {
				hit = true;
				break;
			}
		}

		if (hit) out.push(online[i]);
	}

	return out;
}

/*
 * AP 下钻：stations 里 node_id（缺失时 node_name）命中该 AP、且 MAC 命中在线设备。
 * 同一 MAC 多条 stations（多 iface）只保留第一条；结果最多 max 台。
 */
function apDrillDevices(nodeKey, stations, devices, now, max) {
	var online = topoOnlineDevices(devices, now);
	var limit = (typeof max == 'number' && max > 0) ? Math.floor(max) : TOPO_DRILL_MAX;
	var byMac = {};
	var groups = stationGroups(stations);
	var list = (nodeKey.length && groups[nodeKey]) ? groups[nodeKey] : [];
	var seen = {};
	var out = [];
	var i, mac, dev, item;

	for (i = 0; i < online.length; i++) {
		mac = stationNormMac(online[i] != null ? online[i].mac : '');

		if (mac.length && byMac[mac] == null) byMac[mac] = online[i];
	}

	for (i = 0; i < list.length && out.length < limit; i++) {
		item = list[i];
		mac = stationNormMac(item != null ? item.mac : '');

		if (!mac.length || seen[mac] === true) continue;

		seen[mac] = true;
		dev = byMac[mac];

		if (dev == null) continue;

		out.push({
			dev: dev,
			signal: present(item != null ? item.signal : null) ? num(item.signal) : null
		});
	}

	return out;
}

/* MAC 归一化：去掉空白并转小写，避免大小写/格式差异匹配不上。 */
function stationNormMac(mac) {
	return ('' + ((mac != null) ? mac : '')).replace(/\s+/g, '').toLowerCase();
}

/* 在线设备的 MAC 集合（只用于 AP 下在线无线设备计数）。 */
function onlineMacSet(devices, now) {
	var online = topoOnlineDevices(devices, now);
	var set = {};

	for (var i = 0; i < online.length; i++) {
		var mac = stationNormMac(online[i] != null ? online[i].mac : '');

		if (mac.length) set[mac] = true;
	}

	return set;
}

/* 该 AP 的 stations 里，MAC 命中在线设备集合的去重台数。 */
function apOnlineCount(stations, macSet) {
	var list = Array.isArray(stations) ? stations : [];
	var seen = {};
	var count = 0;

	for (var i = 0; i < list.length; i++) {
		var mac = stationNormMac(list[i] != null ? list[i].mac : '');

		if (!mac.length || seen[mac] === true) continue;

		seen[mac] = true;

		if (macSet != null && macSet[mac] === true) count++;
	}

	return count;
}

/* get_stations.stations 按 node_id（缺失时 node_name）分组。 */
function stationGroups(stations) {
	var list = Array.isArray(stations) ? stations : [];
	var out = {};

	for (var i = 0; i < list.length; i++) {
		if (list[i] == null) continue;

		var key = stationNodeKey(list[i]);

		if (!out[key]) out[key] = [];

		out[key].push(list[i]);
	}

	return out;
}

/* AP 节点标识：node_id 优先，其次 node_name。 */
function stationNodeKey(node) {
	if (node == null) return '';
	if (node.node_id != null && ('' + node.node_id).length) return '' + node.node_id;
	if (node.node_name != null && ('' + node.node_name).length) return '' + node.node_name;

	return '';
}

function stationNodeName(node) {
	if (node == null) return _('未命名 AP');
	if (node.name != null && ('' + node.name).length) return '' + node.name;
	if (node.node_name != null && ('' + node.node_name).length) return '' + node.node_name;

	var key = stationNodeKey(node);

	return key.length ? key : _('未命名 AP');
}

/* AP 新鲜度：age_sec>=0 且 <=300 → 在线；更久 → N 分钟前；缺失/负值 → 未上报。 */
function stationFreshness(ageSec) {
	if (!present(ageSec)) return { online: false, label: _('未上报') };

	var age = num(ageSec);

	if (age < 0) return { online: false, label: _('未上报') };
	if (age <= TOPO_AP_FRESH_SEC) return { online: true, label: _('在线') };

	return { online: false, label: Math.max(1, Math.round(age / 60)) + ' ' + _('分钟前') };
}

/* 同一个设备（跨列表引用）：MAC 优先，其次 IP。 */
function sameDevice(a, b) {
	if (a == null || b == null) return false;

	var am = stationNormMac(a.mac);
	var bm = stationNormMac(b.mac);

	if (am.length && bm.length) return (am == bm);

	var ai = '' + ((a.ip != null) ? a.ip : '');
	var bi = '' + ((b.ip != null) ? b.ip : '');

	if (ai.length && bi.length) return (ai == bi);

	return (a === b);
}

/* 主路由主机名：state.system.hostname 可用就用，否则「主路由」。 */
function topoHostname(state) {
	var system = (state != null && state.system != null && typeof state.system == 'object')
		? state.system : {};
	var name = (system.hostname != null) ? ('' + system.hostname).replace(/^\s+|\s+$/g, '') : '';

	return name.length ? name : _('主路由');
}

// ---------------------------------------------------------------- 设备类型图标（拓扑节点）

/* 类型关键词；顺序有意义（「平板电脑」先判平板，Android TV 先判电视，IoT 先于手机）。 */
var DEVICE_KIND_RULES = [
	{ kind: 'tablet', words: [ 'ipad', 'tablet', 'pad', '平板' ] },
	{ kind: 'tv', words: [ 'apple tv', 'smarttv', 'smart tv', 'tvbox', 'roku', '电视', 'tv' ] },
	{ kind: 'laptop', words: [ 'macbook', 'notebook', 'laptop', 'desktop', 'windows', 'linux', '电脑', 'pc', 'win' ] },
	{ kind: 'iot', words: [ 'camera', 'speaker', 'homepod', 'echo', 'bulb', 'plug', 'sensor', '摄像', '音箱', '插座', '灯泡', 'iot' ] },
	{ kind: 'phone', words: [ 'iphone', 'android', 'oneplus', 'redmi', 'pixel', 'huawei', 'xiaomi', 'vivo', 'oppo', 'phone', '手机', 'mi' ] }
];

function deviceKindText(dev) {
	var hostname = (dev != null && dev.hostname != null) ? ('' + dev.hostname) : '';
	var alias = (dev != null && dev.alias != null) ? ('' + dev.alias) : '';
	var ip = (dev != null && dev.ip != null) ? ('' + dev.ip) : '';

	return (hostname + ' ' + alias + ' ' + ip).toLowerCase();
}

/*
 * 关键词命中：≥4 字符或含中文的关键词直接子串匹配；
 * 短 ASCII 关键词（mi/pc/win/tv/pad/iot）按词边界匹配，避免 mini 里命中 mi。
 */
function deviceKindHit(text, word) {
	if (!word.length) return false;
	if (word.length >= 4 || !/^[a-z0-9]+$/.test(word)) return text.indexOf(word) >= 0;

	return new RegExp('(^|[^a-z0-9])' + word + '([^a-z0-9]|$)').test(text);
}

/* 网络类设备（本机/容器/网关/服务器）关键词；先于消费类关键词判定。 */
var DEVICE_KIND_NET_RULES = [
	{ kind: 'local', words: [ 'localhost', '本机' ] },
	{ kind: 'container', words: [ 'docker', 'container', 'podman', 'k8s' ] },
	{ kind: 'gateway', words: [ 'router', 'gateway', '主路由', '路由' ] },
	{ kind: 'server', words: [ 'nas', 'synology', 'qnap', 'server', '群晖', '服务器', '机架', 'rack' ] }
];

/* 回环/未指派地址：直接算本机（不参与私有网段推断）。 */
var DEVICE_KIND_LOCAL_IPS = [ '127.0.0.1', '0.0.0.0', '::1' ];

/* IPv4 字面量 → [a,b,c,d]；缺失或非法返回 null（IPv6 只认上面的回环字面量）。 */
function deviceKindIpv4(ip) {
	var parts = ('' + ip).split('.');
	var out = [];
	var i, n;

	if (parts.length !== 4) return null;

	for (i = 0; i < 4; i++) {
		if (!/^[0-9]{1,3}$/.test(parts[i])) return null;

		n = parseInt(parts[i], 10);
		if (!(n <= 255)) return null;

		out.push(n);
	}

	return out;
}

/* RFC1918：10/8、172.16/12、192.168/16。 */
function deviceKindPrivateIpv4(v4) {
	if (v4 == null) return false;

	return v4[0] === 10 ||
		(v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
		(v4[0] === 192 && v4[1] === 168);
}

function deviceKindTextHit(text, words) {
	var i;

	for (i = 0; i < words.length; i++) {
		if (deviceKindHit(text, words[i])) return true;
	}

	return false;
}

/*
 * 设备类型：先判网络类设备（本机 → 容器 → 网关 → 服务器），再按 hostname/alias/ip
 * 关键词猜消费类（大小写不敏感）；猜不出返回 unknown。
 * 纯函数，供拓扑节点选图标；不做任何网络/宿主探测。
 */
function deviceKindOf(dev) {
	var ip = (dev != null && dev.ip != null) ? ('' + dev.ip).replace(/^\s+|\s+$/g, '') : '';
	var text = deviceKindText(dev);
	var v4 = deviceKindIpv4(ip);
	var i, j;

	/* 本机：回环/未指派地址，或 hostname 里写明 localhost/本机。 */
	if (DEVICE_KIND_LOCAL_IPS.indexOf(ip) >= 0 ||
		deviceKindTextHit(text, DEVICE_KIND_NET_RULES[0].words))
		return 'local';

	/* 容器：Docker 默认 172.17，整个 172.16/12 都算；或 hostname 命中容器关键词。 */
	if ((v4 != null && v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
		deviceKindTextHit(text, DEVICE_KIND_NET_RULES[1].words))
		return 'container';

	/* 网关：私有网段且末段为 1（.1 才是网关，.3 仍是普通设备），或 hostname 命中路由关键词。 */
	if ((deviceKindPrivateIpv4(v4) && v4[3] === 1) ||
		deviceKindTextHit(text, DEVICE_KIND_NET_RULES[2].words))
		return 'gateway';

	if (deviceKindTextHit(text, DEVICE_KIND_NET_RULES[3].words))
		return 'server';

	for (i = 0; i < DEVICE_KIND_RULES.length; i++) {
		for (j = 0; j < DEVICE_KIND_RULES[i].words.length; j++) {
			if (deviceKindHit(text, DEVICE_KIND_RULES[i].words[j]))
				return DEVICE_KIND_RULES[i].kind;
		}
	}

	return 'unknown';
}

/* 类型中文文案：拓扑 title / 设备行等直接复用，新增类型不必各自加分支。 */
var DEVICE_KIND_LABELS = {
	phone: '手机',
	laptop: '电脑',
	tv: '电视',
	tablet: '平板',
	iot: '智能设备',
	local: '本机',
	container: '容器',
	gateway: '网关',
	server: '服务器',
	unknown: '未知'
};

function deviceKindLabel(kind) {
	var label = DEVICE_KIND_LABELS[kind];

	return _(label != null ? label : DEVICE_KIND_LABELS.unknown);
}

/* 类型图标：20-24px 线条风格（与 globe/router 一致），不用 emoji、不引外部图片。 */
function deviceKindSvg(kind, color) {
	var svg = svgEl('svg', {
		viewBox: '0 0 24 24', width: '22', height: '22',
		'aria-hidden': 'true', focusable: 'false'
	});
	var stroke = (color != null && ('' + color).length) ? ('' + color) : 'currentColor';
	var line = {
		fill: 'none', stroke: stroke, 'stroke-width': '1.6',
		'stroke-linecap': 'round', 'stroke-linejoin': 'round'
	};

	function add(tag, attrs) {
		var merged = {}, key;

		for (key in line) {
			if (line.hasOwnProperty(key)) merged[key] = line[key];
		}

		if (attrs != null) {
			for (key in attrs) {
				if (attrs.hasOwnProperty(key)) merged[key] = attrs[key];
			}
		}

		svg.appendChild(svgEl(tag, merged));
	}

	if (kind == 'phone') {
		add('rect', { x: '7', y: '2.6', width: '10', height: '18.8', rx: '2.4' });
		add('path', { d: 'M10.6 5.2h2.8' });
		add('circle', { cx: '12', cy: '18.4', r: '0.9', fill: stroke, stroke: 'none' });
	}
	else if (kind == 'tablet') {
		add('rect', { x: '4.4', y: '3', width: '15.2', height: '18', rx: '2.2' });
		add('path', { d: 'M10.8 18.2h2.4' });
	}
	else if (kind == 'laptop') {
		add('rect', { x: '5', y: '4.4', width: '14', height: '9.8', rx: '1.6' });
		add('path', { d: 'M3 17.6h18l-1.6 2.2H4.6z' });
	}
	else if (kind == 'tv') {
		add('rect', { x: '2.8', y: '4.8', width: '18.4', height: '12.2', rx: '2' });
		add('path', { d: 'M8.4 20.4h7.2' });
		add('path', { d: 'M12 17v3.4' });
	}
	else if (kind == 'iot') {
		add('circle', { cx: '12', cy: '10.2', r: '5' });
		add('path', { d: 'M9.6 17.4h4.8' });
		add('path', { d: 'M10.6 19.9h2.8' });
	}
	else if (kind == 'gateway') {
		add('rect', { x: '2.8', y: '10.6', width: '18.4', height: '8.2', rx: '2' });
		add('path', { d: 'M7 10.6V5.6' });
		add('path', { d: 'M17 10.6V5.6' });
		add('path', { d: 'M9.4 15.6L17.6 15.6' });
		add('circle', { cx: '5.9', cy: '15.6', r: '0.9', fill: stroke, stroke: 'none' });
	}
	else if (kind == 'container') {
		add('path', {
			d: 'M12 2.8L20.4 7.5L20.4 16.5L12 21.2L3.6 16.5L3.6 7.5Z'
		});
		add('path', { d: 'M3.6 7.5L12 12.2L20.4 7.5' });
		add('path', { d: 'M12 12.2L12 21.2' });
	}
	else if (kind == 'local') {
		add('rect', { x: '3.2', y: '4.2', width: '17.6', height: '12', rx: '1.8' });
		add('path', { d: 'M12 16.2v3.6' });
		add('path', { d: 'M8.6 19.8h6.8' });
	}
	else if (kind == 'server') {
		add('rect', { x: '3.4', y: '3.4', width: '17.2', height: '7.2', rx: '1.4' });
		add('rect', { x: '3.4', y: '13.4', width: '17.2', height: '7.2', rx: '1.4' });
		add('circle', { cx: '6.9', cy: '7', r: '0.85', fill: stroke, stroke: 'none' });
		add('circle', { cx: '6.9', cy: '17', r: '0.85', fill: stroke, stroke: 'none' });
	}
	else {
		add('circle', { cx: '12', cy: '12', r: '8.6' });
		add('path', { d: 'M9.5 9.5c.1-1.4 1.2-2.4 2.6-2.4 1.5 0 2.5 1 2.5 2.3 0 2-2.5 2.2-2.5 4.1' });
		add('circle', { cx: '12', cy: '17.2', r: '0.9', fill: stroke, stroke: 'none' });
	}

	return svg;
}

var TOPO_NODE_COLS = 2;      /* 设备节点网格固定两列（320px 也不降级） */
var OVERVIEW_TOPO_MAX = 8;   /* 概览屏设备拓扑最多 8 个节点 */

/*
 * 树状连线：纯 CSS 布局线（.tsm-ttrunk / .tsm-tstem / .tsm-trow-bus + 节点 ::before）。
 *
 * 之前用 position:absolute 的 SVG + viewBox 0 0 100 100 百分比坐标画线：设备名一/两行
 * 会让真实行高和百分比错位，竖线落不到节点顶部；每行横线是独立路径，多行时看起来
 * 像在节点之间横向串联。改成「父节点竖干 → 每行自己的总线 → 总线向下连本行每个节点」
 * 的 DOM 结构后，线跟着 grid 行高走：行内只有一条总线，行与行之间只有一根竖干，
 * 不再有任何跨节点的横向连线。
 *
 * nodes 按 TOPO_NODE_COLS 分行：两列 → 总线落在 25%/75%（两列中心）；单节点行去掉
 * 总线并让节点铺满两列，竖线自然落在正中。tail（「还有 N 台」）放在最后一行之后，
 * 不参与连线。
 */
function topoTree(nodes, tail) {
	var cols = TOPO_NODE_COLS;
	var list = Array.isArray(nodes) ? nodes : [];
	var tree = E('div', { 'class': 'tsm-ttree' }, [
		E('div', { 'class': 'tsm-ttrunk' }, '')
	]);
	var i, row, single, children = [];

	for (i = 0; i < list.length; i += cols) {
		row = list.slice(i, i + cols);
		single = row.length < 2;
		children = single ? [] : [ E('div', { 'class': 'tsm-trow-bus' }, '') ];

		if (i > 0)
			tree.appendChild(E('div', { 'class': 'tsm-tstem' }, ''));

		tree.appendChild(E('div', {
			'class': 'tsm-trow' + (single ? ' is-single' : '')
		}, children.concat(row)));
	}

	if (tail)
		tree.appendChild(tail);

	return tree;
}

/* 节点速率小字：一格只放一行，下行优先；上行放在 title 里。 */
function deviceNodeRateText(dev) {
	return '↓ ' + rateText(dev != null ? dev.rx_rate : null);
}

function deviceNodeTitle(dev) {
	var name = deviceName(dev);
	var rx = rateText(dev != null ? dev.rx_rate : null);
	var tx = rateText(dev != null ? dev.tx_rate : null);

	return deviceKindLabel(deviceKindOf(dev)) + ' · ' + name + ' · ' +
		_('下行') + ' ' + rx + ' · ' + _('上行') + ' ' + tx;
}

// ---------------------------------------------------------------- 交互增强（下拉刷新 / 骨架 / 趋势 / Top3）

var PULL_TRIGGER = 64;        /* 下拉超过 64px 松手才真正刷新 */
var PULL_ARM = 8;             /* 超过 8px 才认为是在下拉（过滤手指抖动） */
var PULL_RANGE = 56;          /* 指示器最多露出 56px（与 CSS 高度一致） */
var PULL_PAGES = [ 0, 1, 3 ]; /* 只有概览 / 设备 / 拓扑三屏支持下拉刷新 */
var ENTER_MS = 150;           /* 切屏入场动画 150ms，结束后移除 class */
var SPARK_MAX = 12;           /* 迷你趋势保留最近 12 次采样 */
var SPARK_W = 120;
var SPARK_H = 32;

/* 页面滚动位置：优先 scrollingElement，退化到 documentElement / body；取不到当 0（顶部）。 */
function scrollTopOf() {
	var el = null;
	var top = 0;

	try {
		el = document.scrollingElement || document.documentElement || document.body;
	}
	catch (e) { el = null; }

	if (el != null && typeof el.scrollTop == 'number') top = el.scrollTop;
	else if (typeof window !== 'undefined' && typeof window.scrollY == 'number') top = window.scrollY;

	return num(top);
}

/* 单指触摸点；多指 / 空列表一律 null（多指手势不当下拉）。 */
function touchAt(ev, key) {
	var list = (ev != null) ? ev[key] : null;

	if (list == null || list.length != 1) return null;

	return list[0];
}

function round1(value) {
	return Math.round(num(value) * 10) / 10;
}

/* 骨架块：每块是 .tsm-skel + 变体类，纯装饰（aria-hidden），不带任何假数据。 */
function skeletonBlocks(count, variant) {
	var out = [];
	var n = num(count);
	var i;

	for (i = 0; i < n; i++)
		out.push(E('div', {
			'class': 'tsm-skel' + (variant ? ' ' + variant : ''),
			'aria-hidden': 'true'
		}, ''));

	return out;
}

function sparkMaxOf(samples) {
	var list = Array.isArray(samples) ? samples : [];
	var max = 0;
	var i;

	for (i = 0; i < list.length; i++)
		max = Math.max(max, num(list[i] != null ? list[i].rx : 0), num(list[i] != null ? list[i].tx : 0));

	return max;
}

/*
 * 迷你趋势的点串：无采样返回空串（由占位横线兜底）；单点时居中。
 * x 均匀分布在 0..SPARK_W，y 按两条序列的共同最大值归一化，留 2px 上下边距。
 */
function sparkPoints(samples, field) {
	var list = Array.isArray(samples) ? samples : [];
	var n = list.length;
	var max = sparkMaxOf(list);
	var out = [];
	var i, x, y;

	if (!n) return '';

	for (i = 0; i < n; i++) {
		x = (n <= 1) ? (SPARK_W / 2) : (i * SPARK_W / (n - 1));
		y = (max <= 0)
			? (SPARK_H - 2)
			: (SPARK_H - 2 - (num(list[i][field]) / max) * (SPARK_H - 4));

		out.push(round1(x) + ',' + round1(y));
	}

	return out.join(' ');
}

// ---------------------------------------------------------------- 离线快照

/*
 * 离线快照：断网 / 接口失败时，手机版显示最近一次成功的数据（PWA 装到桌面后最常见）。
 *
 * 只写**展示需要的字段**的精简快照，键 'prismRouterMobileSnapshot.v1'：
 *   v / ts / totals（速率与累计）/ nodes（出口名 → rx,tx）/
 *   devices（name,mac,ip,link,rx_rate,tx_rate,last_seen）/
 *   health（confidence,reasons）/ quota。
 * **绝不写密钥、token、应用全量明细**；JSON 上限 64KB，超了把 devices 截到 200 条并标 truncated。
 * 快照超过 24 小时一律作废并删除。
 *
 * 存储不可用（隐私模式 / 被策略禁掉 / 配额满）时全部静默降级：离线能力是增强，
 * 任何异常都不能影响正常页面渲染。
 */
var SNAPSHOT_KEY = 'prismRouterMobileSnapshot.v1';
var SNAPSHOT_VERSION = 1;
var SNAPSHOT_MAX_BYTES = 65536;         /* 64KB：localStorage 配额小，别撑爆 */
var SNAPSHOT_MAX_DEVICES = 200;         /* 超限时 devices 截断条数 */
var SNAPSHOT_MAX_NODES = 64;            /* 出口节点条目上限 */
var SNAPSHOT_MAX_AGE_SEC = 24 * 3600;   /* 超过 24 小时不再使用 */
var SNAPSHOT_TEXT_MAX = 64;             /* 单个字符串字段最多 64 字符 */

/* 连续失败多少次后停止自动轮询（手机上省电），手动「重试 / 刷新」始终可用。 */
var OFFLINE_GIVEUP_FAILS = 3;

/* 累计与速率字段白名单：手机版概览/展开区用到的全在这里，多余的字段一律不落盘。 */
var SNAPSHOT_TOTAL_FIELDS = [
	'rx_rate', 'tx_rate',
	'direct_rx', 'direct_tx', 'proxy_rx', 'proxy_tx',
	'wifi_rx', 'wifi_tx', 'wired_rx', 'wired_tx', 'unknown_rx', 'unknown_tx'
];

/* 去掉首尾空白并截断：快照是"够看就行"的副本，不追求原样。 */
function snapText(value, max) {
	var text = (value == null) ? '' : ('' + value);

	text = text.replace(/^\s+|\s+$/g, '');

	if (text.length > max) text = text.slice(0, max);

	return text;
}

/* UTF-8 字节数：localStorage 配额按字节算，只看 length 会低估中文（一个字符 3 字节）。 */
function snapBytes(text) {
	var s = (text == null) ? '' : ('' + text);
	var total = 0;
	var i, c;

	for (i = 0; i < s.length; i++) {
		c = s.charCodeAt(i);

		if (c < 0x80) total += 1;
		else if (c < 0x800) total += 2;
		else if (c >= 0xd800 && c <= 0xdbff) { total += 4; i++; }
		else total += 3;
	}

	return total;
}

/* localStorage 句柄：不可用（隐私模式 / 被禁 / 非浏览器）返回 null，调用方一律静默降级。 */
function snapStore() {
	var store = null;

	try {
		if (typeof window === 'undefined' || window == null) return null;

		store = window.localStorage;   /* 隐私模式下取这个属性本身就可能抛错 */
	}
	catch (e) {
		return null;
	}

	if (store == null) return null;
	if (typeof store.getItem != 'function' || typeof store.setItem != 'function' ||
		typeof store.removeItem != 'function')
		return null;

	return store;
}

function snapTotals(totals) {
	var src = (totals != null && typeof totals == 'object') ? totals : {};
	var out = {};
	var i, field;

	for (i = 0; i < SNAPSHOT_TOTAL_FIELDS.length; i++) {
		field = SNAPSHOT_TOTAL_FIELDS[i];

		if (present(src[field])) out[field] = num(src[field]);
	}

	return out;
}

/* 一台设备只留展示字段；连 name/mac/ip 都没有的行没有展示价值，直接丢。 */
function snapDevice(dev) {
	var out = {};
	var name, mac, ip, link;

	if (dev == null || typeof dev != 'object') return null;

	name = snapText(dev.hostname != null ? dev.hostname : dev.name, SNAPSHOT_TEXT_MAX);
	if (name.length) out.name = name;

	mac = snapText(dev.mac, 32);
	if (mac.length) out.mac = mac;

	ip = snapText(dev.ip, 46);
	if (ip.length) out.ip = ip;

	link = snapText(dev.link, 8);
	if (link.length) out.link = link;

	if (present(dev.rx_rate)) out.rx_rate = num(dev.rx_rate);
	if (present(dev.tx_rate)) out.tx_rate = num(dev.tx_rate);
	if (present(dev.last_seen)) out.last_seen = num(dev.last_seen);

	if (!out.name && !out.mac && !out.ip) return null;

	return out;
}

/* state.nodes 是「出口名 → {rx,tx}」对象：只留这两个数字，条目数封顶。 */
function snapNodes(nodes) {
	var src = (nodes != null && typeof nodes == 'object') ? nodes : null;
	var out = {};
	var count = 0;
	var key, name, entry;

	if (src == null) return out;

	for (key in src) {
		if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
		if (count >= SNAPSHOT_MAX_NODES) break;

		name = snapText(key, SNAPSHOT_TEXT_MAX);
		if (!name.length) continue;

		/* 这些键会改对象原型，不能当普通键写回去 */
		if (name == '__proto__' || name == 'constructor' || name == 'prototype') continue;

		entry = (src[key] != null && typeof src[key] == 'object') ? src[key] : {};

		out[name] = { rx: num(entry.rx), tx: num(entry.tx) };
		count++;
	}

	return out;
}

function snapHealth(health) {
	var src = (health != null && typeof health == 'object') ? health : {};
	var reasons = Array.isArray(src.reasons) ? src.reasons : [];
	var out = {
		confidence: snapText(src.accounting_confidence != null ? src.accounting_confidence : 'unknown', 24)
	};
	var list = [];
	var i, reason;

	for (i = 0; i < reasons.length && list.length < 8; i++) {
		reason = snapText(reasons[i], 120);

		if (reason.length) list.push(reason);
	}

	out.reasons = list;

	return out;
}

function snapQuota(quota) {
	var src = (quota != null && typeof quota == 'object') ? quota : null;
	var out = {};
	var period, mode;

	if (src == null) return null;

	if (present(src.total_limit)) out.total_limit = num(src.total_limit);

	period = snapText(src.period, 24);
	if (period.length) out.period = period;

	mode = snapText(src.mode, 16);
	if (mode.length) out.mode = mode;

	return Object.keys(out).length ? out : null;
}

/* 后端 state → 精简快照对象（纯函数，不碰存储）。 */
function buildSnapshot(state) {
	var src = (state != null && typeof state == 'object') ? state : {};
	var devices = Array.isArray(src.devices) ? src.devices : [];
	var list = [];
	var i, item, nodes, quota;
	var snap;

	for (i = 0; i < devices.length; i++) {
		item = snapDevice(devices[i]);

		if (item != null) list.push(item);
	}

	snap = {
		v: SNAPSHOT_VERSION,
		ts: num(src.ts),
		totals: snapTotals(src.totals),
		devices: list,
		health: snapHealth(src.health)
	};

	nodes = snapNodes(src.nodes);
	if (Object.keys(nodes).length) snap.nodes = nodes;

	quota = snapQuota(src.quota);
	if (quota != null) snap.quota = quota;

	return snap;
}

/*
 * 序列化 + 64KB 上限（超了先截 devices 到 200 条并标 truncated）：
 *   1. 正常写；
 *   2. 超限 → devices 截到 200 条 + truncated:true；
 *   3. 还超 → 丢掉 nodes；
 *   4. 再超 → devices 清空，只留总量。
 * 仍然超（不现实）返回 null：宁可不写，也不写一条读不回来的记录。
 */
function snapshotJson(snap) {
	var text, bytes;

	if (snap == null || typeof snap != 'object') return null;

	text = JSON.stringify(snap);
	bytes = snapBytes(text);

	if (bytes <= SNAPSHOT_MAX_BYTES) return text;

	snap.truncated = true;

	if (Array.isArray(snap.devices) && snap.devices.length > SNAPSHOT_MAX_DEVICES)
		snap.devices = snap.devices.slice(0, SNAPSHOT_MAX_DEVICES);

	text = JSON.stringify(snap);
	if (snapBytes(text) <= SNAPSHOT_MAX_BYTES) return text;

	delete snap.nodes;

	text = JSON.stringify(snap);
	if (snapBytes(text) <= SNAPSHOT_MAX_BYTES) return text;

	snap.devices = [];

	text = JSON.stringify(snap);

	return (snapBytes(text) <= SNAPSHOT_MAX_BYTES) ? text : null;
}

/* 写快照：成功返回 true；存储不可用 / 配额满 / 序列化异常一律吞掉并返回 false。 */
function writeSnapshot(state) {
	var store = snapStore();
	var text;

	if (store == null) return false;

	try {
		text = snapshotJson(buildSnapshot(state));

		if (text == null) return false;

		store.setItem(SNAPSHOT_KEY, text);

		return true;
	}
	catch (e) {
		return false;
	}
}

function removeSnapshot() {
	var store = snapStore();

	if (store == null) return false;

	try {
		store.removeItem(SNAPSHOT_KEY);

		return true;
	}
	catch (e) {
		return false;
	}
}

/* 精简快照 → 页面渲染用的 state（字段名映射回后端口径，缺失一律给安全默认值）。 */
function stateFromSnapshot(snap) {
	var src = (snap != null && typeof snap == 'object') ? snap : {};
	var list = Array.isArray(src.devices) ? src.devices : [];
	var health = (src.health != null && typeof src.health == 'object') ? src.health : {};
	var nodes = (src.nodes != null && typeof src.nodes == 'object') ? src.nodes : {};
	var quota = (src.quota != null && typeof src.quota == 'object') ? src.quota : {};
	var devices = [];
	var i, dev;

	for (i = 0; i < list.length; i++) {
		dev = (list[i] != null && typeof list[i] == 'object') ? list[i] : null;

		if (dev == null) continue;

		devices.push({
			hostname: (dev.name != null) ? '' + dev.name : '',
			mac: (dev.mac != null) ? '' + dev.mac : '',
			ip: (dev.ip != null) ? '' + dev.ip : '',
			link: (dev.link != null) ? '' + dev.link : '',
			rx_rate: num(dev.rx_rate),
			tx_rate: num(dev.tx_rate),
			last_seen: num(dev.last_seen)
		});
	}

	return {
		ts: num(src.ts),
		totals: snapTotals(src.totals),
		nodes: nodes,
		devices: devices,
		health: {
			accounting_confidence: (health.confidence != null) ? '' + health.confidence : 'unknown',
			reasons: Array.isArray(health.reasons) ? health.reasons.slice(0, 8) : []
		},
		quota: quota,
		truncated: (src.truncated === true),
		snapshot: true
	};
}

/*
 * 读快照：
 *   - 没有 / 存储不可用 → null；
 *   - JSON 损坏或结构不对 → 删掉并返回 null（绝不让页面因为一条脏数据崩掉）；
 *   - 超过 24 小时 → 删掉并返回 { expired:true }（调用方据此显示「快照已过期」）；
 *   - 正常 → { state, ts, truncated }。
 */
function readSnapshot() {
	var store = snapStore();
	var raw = null;
	var snap = null;
	var ts;

	if (store == null) return null;

	try { raw = store.getItem(SNAPSHOT_KEY); }
	catch (e) { return null; }

	if (raw == null || ('' + raw).length === 0) return null;

	try { snap = JSON.parse('' + raw); }
	catch (e) {
		removeSnapshot();

		return null;
	}

	if (snap == null || typeof snap !== 'object' || Array.isArray(snap) ||
		num(snap.v) !== SNAPSHOT_VERSION ||
		snap.totals == null || typeof snap.totals !== 'object' || Array.isArray(snap.totals)) {
		removeSnapshot();

		return null;
	}

	ts = num(snap.ts);

	if (!(ts > 0)) {
		removeSnapshot();

		return null;
	}

	if ((nowSec() - ts) > SNAPSHOT_MAX_AGE_SEC) {
		removeSnapshot();

		return { expired: true, ts: ts };
	}

	return {
		state: stateFromSnapshot(snap),
		ts: ts,
		truncated: (snap.truncated === true)
	};
}

/* 「离线数据 · 更新于 HH:MM（N 分钟前）」：分钟数只按快照时间算。 */
function offlineText(ts, now) {
	var base = (num(now) > 0) ? num(now) : nowSec();
	var age = base - num(ts);
	var minutes;

	if (age < 0) age = 0;

	minutes = Math.floor(age / 60);

	return _('离线数据') + ' · ' + _('更新于') + ' ' + fmtHHMM(ts) +
		'（' + minutes + ' ' + _('分钟前') + '）';
}

// ---------------------------------------------------------------- 视图

return view.extend({
	load: function() {
		var self = this;

		/*
		 * 首屏只取主数据（get_state）。节点 / AP 数据改成懒加载：
		 * 首次切到「节点」或「拓扑」屏时由 ensureNodeData() 并行补拉，
		 * 免得概览/设备/安装屏白等两个额外 RPC。
		 *
		 * 离线：成功就把精简快照写进 localStorage；失败则尝试读回最近一次快照，
		 * 让首屏显示「上次已知的数据」而不是空白页（快照过期/损坏/存储不可用时仍走占位）。
		 */
		return callState().then(function(state) {
			if (state != null && typeof state == 'object' && state.totals != null) {
				self.persistSnapshot(state);

				return {
					state: state,
					error: null,
					offline: null
				};
			}

			return {
				state: null,
				error: null,
				offline: self.restoreSnapshot()
			};
		}, function(err) {
			return {
				state: null,
				error: (err != null && err.message) ? err.message : '' + err,
				offline: self.restoreSnapshot()
			};
		}).then(function(res) {
			/* 有快照就用快照顶上，同时记下离线信息（由 render 画提示条）。 */
			self.state = (res.offline != null) ? res.offline.state : res.state;
			self.error = res.error;
			self.offlineInfo = (res.offline != null) ? res.offline : null;
		});
	},

	render: function() {
		var root;

		/* PWA：注册 manifest 与主屏图标，装到手机桌面后以独立窗口打开 */
		this.injectPwaHead();

		this.state = (this.state != null) ? this.state : null;
		this.expanded = {};
		this.devSig = null;
		this.appSig = null;
		this.timer = null;
		this.refreshing = false;
		this.moreOpen = false;
		this.pageIndex = -1;
		this.pages = [];
		this.tabs = [];
		this.dots = [];

		/* 第 2 步：设备屏本地视图参数 + 节点屏数据（首次进节点/拓扑屏才懒加载） */
		this.lastDevices = [];
		this.devNow = 0;
		this.nodeSig = null;
		this.nodeOpen = {};
		this.nodeDataLoaded = false;
		this.nodeDataPromise = null;

		if (!Array.isArray(this.nodesList)) this.nodesList = [];
		if (typeof this.nodesError != 'string') this.nodesError = '';
		if (this.nodesOk !== true) this.nodesOk = false;

		/* 拓扑屏：AP 数据同样懒加载，失败时保持空数组 */
		if (!Array.isArray(this.stationsNodes)) this.stationsNodes = [];
		if (!Array.isArray(this.stationsList)) this.stationsList = [];
		if (typeof this.stationsError != 'string') this.stationsError = '';
		if (this.stationsOk !== true) this.stationsOk = false;
		this.topoSig = null;

		/* 拓扑下钻展开状态：exit:<出口名> / ap:<node_id>，刷新时保留 */
		this.topoOpenExits = {};

		/* 下拉刷新 / 切屏过渡 / 迷你趋势 / 概览 Top3 的本地状态（内存，不写存储） */
		this.enterTimer = null;
		this.enterPageRef = null;
		this.pullDist = 0;
		this.pullBusy = false;
		this.ovSkelOn = false;
		this.sparkSamples = [];
		this.top3Sig = null;

		/* 离线：快照提示条状态 + 连续失败计数（load 可能已经塞过 offlineInfo） */
		this.offlineInfo = (this.offlineInfo != null && typeof this.offlineInfo == 'object')
			? this.offlineInfo : null;
		this.offlineFails = 0;
		this.offlineGivenUp = false;
		if (this.snapshotExpired !== true) this.snapshotExpired = false;

		root = E('div', { 'id': 'ts-mobile', 'class': 'tsm-app' }, [
			E('style', {}, CSS),
			this.renderHead(),
			this.renderOfflineBar(),
			this.renderTabs(),
			this.renderNotice(),
			this.renderPages()
		]);

		this.root = root;

		/* 默认停在第 1 屏；setPage 只改 class，不发 RPC */
		this.setPage(0);

		if (this.state != null) {
			this.syncAll(this.state);
			this.syncNotice('');
		}
		else {
			/* 首屏没数据：先看有没有 24 小时内的离线快照，有就渲染它，绝不留白屏。 */
			var snap = this.restoreSnapshot();

			if (snap != null) {
				this.state = snap.state;
				this.offlineInfo = snap;
				this.syncAll(this.state);
				this.syncNotice('');
			}
			else {
				this.syncUnavailable(this.error, this.snapshotExpired === true);
			}
		}

		if (this.offlineInfo != null) this.showOfflineBar(this.offlineInfo);
		else this.hideOfflineBar();

		this.syncOfflineData();
		this.bindOnline();
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

		/* 详细面板是独立页面：用真链接 + 新标签，手机上也能直接打开宽屏面板。 */
		this.panelLink = E('a', {
			'class': 'tsm-refresh',
			href: 'http://' + ((typeof window !== 'undefined' && window.location) ? window.location.hostname : '') + ':8099/',
			target: '_blank',
			rel: 'noopener noreferrer',
			title: _('在新标签页打开详细面板')
		}, _('独立控制台 ↗'));

		return E('div', { 'class': 'tsm-head' }, [
			E('h2', {}, _('棱镜路由')),
			E('div', { 'class': 'tsm-meta' }, [
				E('span', {}, [ _('更新于') + ' ', this.updatedNode ]),
				this.panelLink,
				this.refreshBtn
			])
		]);
	},

	renderNotice: function() {
		this.noticeNode = E('div', { 'class': 'tsm-notice' }, '');

		return this.noticeNode;
	},

	/*
	 * 离线快照提示条：sticky 在标题行下方（出现时顶部 tab 顺次下移，不压内容）。
	 * 只写文本节点与固定的 class/role/aria-live —— 快照内容绝不进 title / data-* 属性，
	 * 免得被截图工具、辅助信息或调试面板当成可见元数据读出去。
	 */
	renderOfflineBar: function() {
		var self = this;

		this.offlineTextNode = E('span', { 'class': 'tsm-offline-t' }, '');
		this.offlineRetryBtn = E('button', {
			type: 'button',
			'class': 'tsm-offline-btn',
			click: function() { self.retryOffline(); }
		}, _('重试'));

		this.offlineBar = E('div', {
			'class': 'tsm-offline',
			role: 'status',
			'aria-live': 'polite',
			style: 'display:none'
		}, [ this.offlineTextNode, this.offlineRetryBtn ]);

		return this.offlineBar;
	},

	// ------------------------------------------------------------ 五屏骨架

	/* 顶部分段 tab：点击切屏，只改 class，不发 RPC */
	renderTabs: function() {
		var self = this;
		var labels = [ _('概览'), _('设备'), _('节点'), _('拓扑'), _('安装') ];

		return E('div', { 'class': 'tsm-tabs', role: 'tablist' }, labels.map(function(label, index) {
			var tab = E('button', {
				type: 'button',
				'class': 'tsm-tab',
				role: 'tab',
				'aria-label': label,
				click: function() { self.setPage(index); }
			}, label);

			self.tabs.push(tab);

			return tab;
		}));
	},

	renderPages: function() {
		this.pages = [
			this.renderOverview(),
			this.renderDevPage(),
			this.renderNodePage(),
			this.renderTopoPage(),
			this.renderInstallPage()
		];

		/* 下拉指示器是 .tsm-pages 的第一个子节点（绝对定位，不参与 5 屏的分页） */
		this.pullNode = this.renderPullIndicator();
		this.pagesHost = E('div', { 'class': 'tsm-pages' }, [ this.pullNode ].concat(this.pages));
		this.bindSwipe(this.pagesHost);
		this.bindPullRefresh(this.pagesHost);

		return this.pagesHost;
	},

	/* 切屏：只切 .on；仅首次进入节点/拓扑屏时补拉一次节点/AP 数据（不阻塞切屏） */
	setPage: function(index) {
		var count = this.pages.length;
		var target = num(index);
		var from = this.pageIndex;

		if (!count) return;

		if (target < 0) target = 0;
		if (target > count - 1) target = count - 1;
		if (target === this.pageIndex) return;

		this.pageIndex = target;

		for (var i = 0; i < count; i++) {
			var on = (i === target);

			this.toggleClass(this.pages[i], 'on', on);
			this.toggleClass(this.tabs[i], 'on', on);
		}

		/* 入场过渡：只加 class 与一次性定时器，仍然是「不发 RPC」的纯本地切屏 */
		if (from >= 0) this.enterPage(target, (target >= from) ? 'next' : 'prev');

		/* 先显示占位/已有数据；数据到了由 ensureNodeData 内部 sync，绝不阻塞切屏。 */
		if (target === 2 || target === 3) this.ensureNodeData();

		/* 切屏后回到顶部：各屏不保留滚动位置（简单可靠优先）。 */
		if (typeof window.scrollTo == 'function') window.scrollTo(0, 0);
	},

	/*
	 * 节点 / AP 数据懒加载：get_nodes + get_stations 并行，两个分支各吞异常，
	 * 所以任一失败只降级对应屏，不影响其它屏；成功与否都只拉一次，之后复用。
	 */
	ensureNodeData: function() {
		var self = this;

		if (this.nodeDataLoaded === true)
			return (this.nodeDataPromise != null) ? this.nodeDataPromise : Promise.resolve();

		this.nodeDataLoaded = true;

		this.nodeDataPromise = Promise.all([
			callNodes().then(function(res) {
				return { ok: true, res: res };
			}, function(err) {
				return { ok: false, err: err };
			}),
			callStations().then(function(res) {
				return { ok: true, res: res };
			}, function(err) {
				return { ok: false, err: err };
			})
		]).then(function(res) {
			self.applyNodes(res[0]);
			self.applyStations(res[1]);

			/* 数据到了再按 sig 写回；此时用户可能已经切走，sync 本身不发 RPC。 */
			self.syncNodePage();
			self.syncTopoPage();
		});

		return this.nodeDataPromise;
	},

	toggleClass: function(node, name, on) {
		if (node == null || node.classList == null) return;

		if (on) node.classList.add(name);
		else node.classList.remove(name);
	},

	/* 左右滑动切屏：水平位移 > 40px 且大于纵向位移才算，避免和页面滚动打架 */
	bindSwipe: function(host) {
		var self = this;
		var startX = 0;
		var startY = 0;
		var tracking = false;

		if (host == null || typeof host.addEventListener != 'function') return;

		host.addEventListener('touchstart', function(ev) {
			var touch = (ev.touches != null && ev.touches.length == 1) ? ev.touches[0] : null;

			tracking = (touch != null);

			if (!tracking) return;

			startX = touch.clientX;
			startY = touch.clientY;
		}, { passive: true });

		host.addEventListener('touchend', function(ev) {
			if (!tracking) return;

			tracking = false;

			var touch = (ev.changedTouches != null && ev.changedTouches.length)
				? ev.changedTouches[0] : null;

			if (touch == null) return;

			var dx = touch.clientX - startX;
			var dy = touch.clientY - startY;

			if (Math.abs(dx) <= 40 || Math.abs(dx) <= Math.abs(dy)) return;

			self.setPage(self.pageIndex + (dx < 0 ? 1 : -1));
		}, { passive: true });
	},

	// ------------------------------------------------------------ 下拉刷新 / 切屏过渡

	/* 指示器：旋转箭头 SVG + 一行文案；挂在 .tsm-pages 顶部，默认藏在 tab 后面。 */
	renderPullIndicator: function() {
		var icon = svgEl('svg', {
			'class': 'tsm-pull-ico', viewBox: '0 0 24 24', width: '20', height: '20',
			'aria-hidden': 'true', focusable: 'false'
		});

		icon.appendChild(svgEl('path', {
			d: 'M12 4v11', fill: 'none', stroke: '#ff6f00',
			'stroke-width': '2.4', 'stroke-linecap': 'round'
		}));
		icon.appendChild(svgEl('path', {
			d: 'M6.5 10.5 12 16l5.5-5.5', fill: 'none', stroke: '#ff6f00',
			'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
		}));

		this.pullIcon = icon;
		this.pullText = E('span', { 'class': 'tsm-pull-t' }, _('下拉刷新'));

		return E('div', {
			'class': 'tsm-pull',
			'aria-hidden': 'true',
			/* 默认隐藏写在行内：桌面端没有 touch，永远不会被显示 */
			style: 'opacity:0;transform:translateY(-100%)'
		}, [ icon, this.pullText ]);
	},

	/* 只有概览 / 设备 / 拓扑三屏支持下拉刷新（节点 / 安装屏不拦滚动） */
	pullAllowed: function() {
		return PULL_PAGES.indexOf(num(this.pageIndex)) >= 0;
	},

	/*
	 * 下拉手势：touchstart 记起点 → touchmove 只在「顶部 + 竖直下拉」时介入，
	 * 并用 passive:false 的 preventDefault 关掉橡皮筋；水平位移更大时立刻让位给
	 * bindSwipe 的左右切屏。松手超过 64px 调 this.refresh(true)。
	 *
	 * 滚动容器说明：整页由文档滚动（#ts-mobile 没有自己的 overflow），
	 * 所以「顶部」按 scrollTopOf() 判断；setPage 切屏时本来就 window.scrollTo(0,0)。
	 */
	bindPullRefresh: function(host) {
		var self = this;
		var active = false;
		var pulling = false;
		var horizontal = false;
		var startX = 0;
		var startY = 0;

		if (host == null || typeof host.addEventListener != 'function') return;

		host.addEventListener('touchstart', function(ev) {
			var touch = touchAt(ev, 'touches');

			active = false;
			pulling = false;
			horizontal = false;
			self.pullDist = 0;

			if (touch == null) return;
			if (self.pullBusy === true) return;
			if (!self.pullAllowed()) return;
			if (scrollTopOf() > 0) return;   /* 不在顶部：交给页面正常滚动 */

			active = true;
			startX = num(touch.clientX);
			startY = num(touch.clientY);
		}, { passive: true });

		host.addEventListener('touchmove', function(ev) {
			var touch, dx, dy;

			if (!active) return;

			touch = touchAt(ev, 'touches');

			if (touch == null) return;

			dx = num(touch.clientX) - startX;
			dy = num(touch.clientY) - startY;

			/* 水平位移更大 → 这是左右切屏，让位，且不拦默认行为 */
			if (!pulling && Math.abs(dx) > PULL_ARM && Math.abs(dx) > Math.abs(dy)) {
				horizontal = true;
				active = false;
				self.resetPull();

				return;
			}

			if (horizontal) return;
			if (!pulling) {
				if (dy <= PULL_ARM) return;
				if (scrollTopOf() > 0) { active = false; return; }

				pulling = true;
			}

			/* 顶部下拉：阻止页面滚动 / 橡皮筋 */
			if (ev != null && typeof ev.preventDefault == 'function' && ev.cancelable !== false)
				ev.preventDefault();

			self.pullDist = dy;
			self.pullDistance(dy);
		}, { passive: false });

		host.addEventListener('touchend', function() {
			var dist = num(self.pullDist);

			if (!active) {
				if (!pulling) self.resetPull();

				return;
			}

			active = false;

			if (!pulling) {
				self.resetPull();

				return;
			}

			pulling = false;

			if (dist > PULL_TRIGGER) self.startPullRefresh();
			else self.resetPull();
		}, { passive: true });

		host.addEventListener('touchcancel', function() {
			active = false;
			pulling = false;
			self.resetPull();
		}, { passive: true });
	},

	/* 跟手：指示器从 tab 后面滑出，箭头随下拉角度旋转，文案在 64px 处切换。 */
	pullDistance: function(dist) {
		var d = Math.max(0, num(dist));
		var shown = Math.min(d, PULL_RANGE);

		if (this.pullNode != null) {
			this.pullNode.style.transform = 'translateY(' + (shown - PULL_RANGE) + 'px)';
			this.pullNode.style.opacity = (d > 0) ? (Math.min(1, d / 32)).toFixed(2) : '0';
		}

		if (this.pullIcon != null)
			this.pullIcon.style.transform = 'rotate(' + Math.min(360, Math.round(d * 3)) + 'deg)';

		if (this.pullText != null)
			this.pullText.textContent = (d > PULL_TRIGGER) ? _('松手刷新') : _('下拉刷新');
	},

	/* 松手触发刷新：先切「刷新中…」+ 旋转动画，刷新结束后回弹归零。 */
	startPullRefresh: function() {
		var self = this;

		this.pullBusy = true;

		if (this.pullText != null) this.pullText.textContent = _('刷新中…');

		this.toggleClass(this.pullNode, 'busy', true);

		if (this.pullNode != null) {
			this.pullNode.style.transform = 'translateY(0)';
			this.pullNode.style.opacity = '1';
		}

		var done = null;

		try { done = this.refresh(true); }
		catch (e) { done = null; }

		if (done != null && typeof done.then == 'function') {
			done.then(function() { self.resetPull(); }, function() { self.resetPull(); });

			return;
		}

		this.resetPull();
	},

	/* 归零（回弹由 CSS transition 完成；减少动态偏好时没有过渡） */
	resetPull: function() {
		this.pullBusy = false;
		this.pullDist = 0;

		this.toggleClass(this.pullNode, 'busy', false);

		if (this.pullNode != null) {
			this.pullNode.style.transform = 'translateY(-100%)';
			this.pullNode.style.opacity = '0';
		}

		if (this.pullIcon != null) this.pullIcon.style.transform = 'rotate(0deg)';

		if (this.pullText != null) this.pullText.textContent = _('下拉刷新');
	},

	/* 入场动画 class 只挂 150ms；reduced-motion 时对应 CSS 直接 animation:none。 */
	enterPage: function(index, dir) {
		var self = this;
		var page = this.pages[index];
		var prevClass = (dir === 'prev') ? 'is-enter-prev' : 'is-enter-next';

		if (page == null) return;

		/* 连续快速切屏：先把上一屏的入场类清掉，保证同一时间只有一个页面在动画 */
		if (this.enterPageRef != null && this.enterPageRef !== page)
			this.clearEnter(this.enterPageRef);

		this.enterPageRef = page;

		this.toggleClass(page, 'is-enter', true);
		this.toggleClass(page, prevClass, true);

		if (this.enterTimer != null && typeof window.clearTimeout == 'function')
			window.clearTimeout(this.enterTimer);

		this.enterTimer = (typeof window.setTimeout == 'function') ? window.setTimeout(function() {
			self.enterTimer = null;

			if (self.enterPageRef === page) self.enterPageRef = null;

			self.clearEnter(page);
		}, ENTER_MS) : null;
	},

	clearEnter: function(page) {
		if (page == null) return;

		this.toggleClass(page, 'is-enter', false);
		this.toggleClass(page, 'is-enter-next', false);
		this.toggleClass(page, 'is-enter-prev', false);
	},

	// ------------------------------------------------------------ 设备屏

	/*
	 * 设备屏：三个等宽分段 tab（主网络 / 访客 / 离线）+ 标题行（筛选）+ 列表。
	 * 列表写回复用 renderDevices / renderDeviceRow（内部按 sig 去重，不整屏重绘）。
	 */
	renderDevPage: function() {
		var self = this;

		this.devTab = 'main';
		this.devSort = 'total';
		this.devLink = '';
		this.devQuery = '';
		this.devFilterOpen = false;
		this.devTabs = [];
		this.devSortChips = [];
		this.devLinkChips = [];

		this.devTitleText = E('span', { 'class': 'tsm-dtitle' }, _(this.devTabLabel()));
		this.devicesCount = E('span', { 'class': 'tsm-dcount' }, '');
		this.devicesBox = E('div', { 'class': 'tsm-dlist' }, '');
		this.devTruncNote = E('p', { 'class': 'tsm-note tsm-dtrunc', style: 'display:none' },
			_('后端已裁剪，仅显示使用量最高的部分设备'));

		this.devSearchInput = E('input', {
			type: 'search',
			'class': 'tsm-dsearch-i',
			placeholder: _('搜索名称 / MAC / IP'),
			'aria-label': _('搜索设备'),
			autocomplete: 'off',
			input: function(ev) {
				self.setDevQuery((ev != null && ev.target != null) ? ev.target.value : '');
			}
		});
		this.devSearchClear = E('button', {
			type: 'button',
			'class': 'tsm-dclear',
			'aria-label': _('清空搜索'),
			title: _('清空搜索'),
			style: 'display:none',
			click: function() { self.clearDevQuery(); }
		}, '×');
		this.devSearchBox = E('div', { 'class': 'tsm-dsearch' }, [
			searchSvg(),
			this.devSearchInput,
			this.devSearchClear
		]);

		this.devFilterBtn = E('button', {
			type: 'button',
			'class': 'tsm-filter',
			'aria-expanded': 'false',
			title: _('筛选与排序'),
			click: function() { self.toggleDevFilter(); }
		}, [ funnelSvg(), _('筛选') ]);

		this.devFilterPanel = E('div', { 'class': 'tsm-fpanel', style: 'display:none' }, [
			E('div', { 'class': 'tsm-flabel' }, _('排序')),
			E('div', { 'class': 'tsm-fchips' }, DEV_SORTS.map(function(item) {
				var chip = E('button', {
					type: 'button',
					'class': 'tsm-chip',
					click: function() { self.setDevSort(item.id); }
				}, _(item.label));

				self.devSortChips.push({ id: item.id, node: chip });

				return chip;
			})),
			E('div', { 'class': 'tsm-flabel' }, _('链路（再点一次取消）')),
			E('div', { 'class': 'tsm-fchips' }, DEV_LINKS.map(function(item) {
				var chip = E('button', {
					type: 'button',
					'class': 'tsm-chip',
					click: function() { self.setDevLink(item.id); }
				}, _(item.label));

				self.devLinkChips.push({ id: item.id, node: chip });

				return chip;
			}))
		]);

		var tabRow = E('div', { 'class': 'tsm-tabs tsm-dtabs', role: 'tablist' },
			DEV_TABS.map(function(tab) {
				var count = E('span', { 'class': 'tsm-tab-n' }, '');
				var btn = E('button', {
					type: 'button',
					'class': 'tsm-tab' + (tab.id === self.devTab ? ' on' : ''),
					role: 'tab',
					'aria-label': _(tab.label),
					'aria-selected': (tab.id === self.devTab) ? 'true' : 'false',
					click: function() { self.setDevTab(tab.id); }
				}, [ E('span', {}, _(tab.label)), ' ', count ]);

				self.devTabs.push({ id: tab.id, label: tab.label, empty: tab.empty, node: btn, count: count });

				return btn;
			}));

		var head = E('div', { 'class': 'tsm-dhead' }, [
			this.devTitleText,
			this.devicesCount,
			E('div', { 'class': 'tsm-dspring' }, ''),
			this.devFilterBtn
		]);

		return E('div', { 'class': 'tsm-page' }, [
			this.devTruncNote,
			tabRow,
			head,
			this.devSearchBox,
			this.devFilterPanel,
			this.devicesBox
		]);
	},

	devTabLabel: function() {
		for (var i = 0; i < DEV_TABS.length; i++)
			if (DEV_TABS[i].id === this.devTab) return DEV_TABS[i].label;

		return DEV_TABS[0].label;
	},

	devTabEmpty: function() {
		for (var i = 0; i < DEV_TABS.length; i++)
			if (DEV_TABS[i].id === this.devTab) return DEV_TABS[i].empty;

		return DEV_TABS[0].empty;
	},

	setDevTab: function(id) {
		if (id === this.devTab) return;

		this.devTab = id;
		this.devSig = null;   /* 分类变了，强制重建列表 */

		this.syncDevTabs();
		this.syncDevicePage(this.lastDevices);
	},

	/* 同步 tab 选中态与数量（数量是分类总数，不受链路筛选影响） */
	syncDevTabs: function() {
		var groups = groupDevices(this.lastDevices, this.devNow);

		for (var i = 0; i < this.devTabs.length; i++) {
			var tab = this.devTabs[i];
			var n = groups[tab.id] ? groups[tab.id].length : 0;
			var on = (tab.id === this.devTab);

			tab.count.textContent = '(' + n + ')';
			tab.node.title = _(tab.label) + ' ' + n;
			tab.node.setAttribute('aria-selected', on ? 'true' : 'false');
			this.toggleClass(tab.node, 'on', on);
		}
	},

	setDevSort: function(id) {
		if (id === this.devSort) return;

		this.devSort = id;
		this.devSig = null;
		this.syncFilterPanel();
		this.syncDevicePage(this.lastDevices);
	},

	/* 再点一次同一项 = 取消（回到不过滤） */
	setDevLink: function(id) {
		this.devLink = (this.devLink === id) ? '' : id;
		this.devSig = null;
		this.syncFilterPanel();
		this.syncDevicePage(this.lastDevices);
	},

	/*
	 * 搜索：输入即过滤，只重排本地数据（不发 RPC），也不重置分类 tab。
	 * 关键词在分类 / 链路筛选 / 排序之后叠加。
	 */
	setDevQuery: function(value) {
		var text = (value == null) ? '' : ('' + value);

		if (text === this.devQuery) return;

		this.devQuery = text;
		this.devSig = null;   /* 关键词变了，强制重建列表（空态文案也随之更新） */
		this.syncDevSearch();
		this.syncDevicePage(this.lastDevices);
	},

	clearDevQuery: function() {
		if (this.devSearchInput != null) this.devSearchInput.value = '';

		this.setDevQuery('');
	},

	syncDevSearch: function() {
		if (this.devSearchClear != null)
			this.devSearchClear.style.display = this.devQuery.length ? '' : 'none';
	},

	toggleDevFilter: function() {
		this.devFilterOpen = !this.devFilterOpen;

		if (this.devFilterPanel != null)
			this.devFilterPanel.style.display = this.devFilterOpen ? '' : 'none';

		if (this.devFilterBtn != null) {
			this.devFilterBtn.setAttribute('aria-expanded', this.devFilterOpen ? 'true' : 'false');
			this.toggleClass(this.devFilterBtn, 'on', this.devFilterOpen);
		}

		this.syncFilterPanel();
	},

	syncFilterPanel: function() {
		var self = this;

		this.devSortChips.forEach(function(chip) {
			self.toggleClass(chip.node, 'on', chip.id === self.devSort);
		});

		this.devLinkChips.forEach(function(chip) {
			self.toggleClass(chip.node, 'on', chip.id === self.devLink);
		});
	},

	// ------------------------------------------------------------ 节点屏

	renderNodePage: function() {
		this.nodeHost = E('div', { 'class': 'tsm-nhost' }, '');

		return E('div', { 'class': 'tsm-page' }, [
			E('div', { 'class': 'tsm-nhero' }, [
				E('div', { 'class': 'tsm-nhero-t' },
					_('子节点上报的累计流量与在线状态（累计口径：子节点进程启动以来）'))
			]),
			E('h3', { 'class': 'tsm-nbig' }, _('设备')),
			E('div', { 'class': 'tsm-nbar' }, ''),
			this.nodeHost
		]);
	},

	// ------------------------------------------------------------ 拓扑屏

	renderTopoPage: function() {
		this.topoHost = E('div', {
			'class': 'tsm-topo',
			role: 'list',
			'aria-label': _('网络拓扑，自上而下：互联网、出口、主路由、接入点、设备')
		}, '');

		return E('div', { 'class': 'tsm-page tsm-topo-page' }, [
			E('div', { 'class': 'tsm-topo-head' },
				E('h3', { 'class': 'tsm-nbig' }, _('网络拓扑'))),
			E('div', { 'class': 'tsm-nbar' }, ''),
			this.topoHost
		]);
	},

	/*
	 * 拓扑写回：数据全部来自 state / get_stations / get_nodes 的本地结果，
	 * sig 未变就不重建 DOM（15s 轮询时不闪动），切屏也不会走到这里。
	 */
	syncTopoPage: function() {
		var data, sig;

		if (this.topoHost == null) return;

		if (this.state == null) {
			this.syncTopoEmpty();

			return;
		}

		data = this.buildTopoData();
		sig = this.topoSigOf(data);

		if (sig === this.topoSig) return;

		this.topoSig = sig;
		dom.content(this.topoHost, this.renderTopoLayers(data));
	},

	/* state 完全没有时只给占位，不做任何猜测、不抛错。 */
	syncTopoEmpty: function() {
		if (this.topoHost == null || this.topoSig === 'empty') return;

		this.topoSig = 'empty';
		dom.content(this.topoHost, [
			/* 2 层卡片骨架：数据到达后 syncTopoPage 会整块替换掉 */
			E('div', { 'class': 'tsm-tstack tsm-skel-stack' }, [
				E('div', { 'class': 'tsm-skel tsm-skel-card', 'aria-hidden': 'true' }, ''),
				E('div', { 'class': 'tsm-conn', 'aria-hidden': 'true' },
					E('span', { 'class': 'tsm-conn-d' }, '')),
				E('div', { 'class': 'tsm-skel tsm-skel-card', 'aria-hidden': 'true' }, '')
			]),
			E('p', { 'class': 'tsm-empty' }, _('暂无数据')),
			E('p', { 'class': 'tsm-nnote' }, _('等待后端 prism-router.get_state 返回拓扑数据。'))
		]);
	},

	buildTopoData: function() {
		var state = (this.state != null) ? this.state : {};
		var totals = (state.totals != null) ? state.totals : {};
		var health = (state.health != null) ? state.health : {};
		var devices = Array.isArray(state.devices) ? state.devices : [];
		var nodes = (state.nodes != null) ? state.nodes : {};
		var now = nowSec();
		var macSet = onlineMacSet(devices, now);
		var stationNodes = (this.stationsOk === true && Array.isArray(this.stationsNodes))
			? this.stationsNodes : [];
		var stationList = (this.stationsOk === true && Array.isArray(this.stationsList))
			? this.stationsList : [];
		var stationMap = (this.stationsOk === true)
			? stationGroups(stationList) : {};
		var fallback = Array.isArray(this.nodesList) ? this.nodesList : [];
		var aps = [];
		var apDegraded = (this.stationsOk !== true);
		var exits = topoExitList(nodes, TOPO_MAX_EXITS);
		var i, node, fresh, ts, age, key;

		for (i = 0; i < exits.length; i++)
			exits[i].devices = exitDrillDevices(exits[i], devices, now);

		if (stationNodes.length) {
			for (i = 0; i < stationNodes.length; i++) {
				node = stationNodes[i];
				if (node == null) continue;

				fresh = stationFreshness(node.age_sec);
				key = stationNodeKey(node);

				aps.push({
					key: key,
					name: stationNodeName(node),
					label: fresh.label,
					online: fresh.online,
					count: apOnlineCount(stationMap[key] || [], macSet),
					meta: '',
					devices: apDrillDevices(key, stationList, devices, now)
				});
			}
		}
		else if (fallback.length) {
			for (i = 0; i < fallback.length; i++) {
				node = fallback[i];
				if (node == null) continue;

				ts = num(node.ts);
				age = present(node.age_sec) ? num(node.age_sec) : ((ts > 0) ? (now - ts) : -1);
				fresh = stationFreshness(age);
				key = nodeIdOf(node, i);

				aps.push({
					key: key,
					name: nodeNameOf(node, i),
					label: fresh.label,
					online: fresh.online,
					count: null,
					meta: (ts > 0) ? fmtAgo(ts, now) : _('未上报'),
					devices: apDrillDevices(key, stationList, devices, now)
				});
			}
		}
		else if (this.nodesOk !== true) {
			apDegraded = true;
		}

		return {
			rate: { rx: totals.rx_rate, tx: totals.tx_rate },
			exits: exits,
			router: {
				name: topoHostname(state),
				bridge: (health.link_source === 'brctl' &&
					health.link_bridge != null && ('' + health.link_bridge).length)
					? ('' + health.link_bridge) : '',
				online: activeDeviceCount(devices, now),
				counts: topoLinkCounts(devices, now)
			},
			aps: aps,
			apDegraded: apDegraded,
			apError: this.stationsError,
			groups: topoDeviceGroups(devices, now)
		};
	},

	topoSigOf: function(data) {
		var parts = [
			num(data.rate.rx), num(data.rate.tx),
			data.router.name, data.router.bridge, data.router.online,
			data.router.counts.wifi, data.router.counts.wired, data.router.counts.unknown,
			data.apDegraded ? '1' : '0', data.apError || ''
		];
		var i, j, list;

		for (i = 0; i < data.exits.length; i++)
			parts.push(data.exits[i].name + ':' + data.exits[i].total + ':' +
				(data.exits[i].direct ? 'd' : 'p') + ':' +
				sigOf(data.exits[i].devices || [], function(dev) {
					return deviceKey(dev) + ':' + deviceName(dev) + ':' +
						num(dev.rx_rate) + ':' + num(dev.tx_rate);
				}));

		for (i = 0; i < data.aps.length; i++)
			parts.push(data.aps[i].name + ':' + data.aps[i].label + ':' +
				((data.aps[i].count == null) ? '-' : data.aps[i].count) + ':' + data.aps[i].meta + ':' +
				sigOf(data.aps[i].devices || [], function(item) {
					return deviceKey(item.dev) + ':' + deviceName(item.dev) + ':' +
						((item.signal == null) ? '-' : item.signal);
				}));

		for (i = 0; i < TOPO_GROUPS.length; i++) {
			list = data.groups[TOPO_GROUPS[i]] || [];

			for (j = 0; j < list.length; j++)
				parts.push(TOPO_GROUPS[i] + ':' + deviceKey(list[j], j) + ':' + deviceName(list[j]) + ':' +
					num(list[j].rx_rate) + ':' + num(list[j].tx_rate));
		}

		return parts.join('|');
	},

	renderTopoLayers: function(data) {
		var layers = [
			this.renderTopoInet(data),
			this.renderTopoExits(data),
			this.renderTopoRouter(data),
			this.renderTopoAps(data),
			this.renderTopoDevices(data)
		];
		var out = [];

		for (var i = 0; i < layers.length; i++) {
			if (i > 0)
				out.push(E('div', { 'class': 'tsm-conn', 'aria-hidden': 'true' },
					E('span', { 'class': 'tsm-conn-d' }, '')));

			out.push(layers[i]);
		}

		return E('div', { 'class': 'tsm-tstack' }, out);
	},

	/* 一层：小标题 + 内容；层级容器带 aria-label，读屏能按层朗读。 */
	topoLayer: function(level, label, body) {
		return E('section', {
			'class': 'tsm-tl tsm-tl-' + level,
			role: 'listitem',
			'aria-label': label
		}, [
			E('div', { 'class': 'tsm-tl-h' }, label),
			E('div', { 'class': 'tsm-tl-b' }, body)
		]);
	},

	/* L1：绿色地球 + WAN 速率（totals.rx_rate / tx_rate，Mbps）。 */
	renderTopoInet: function(data) {
		var text;

		if (present(data.rate.rx) || present(data.rate.tx))
			text = 'WAN ↓ ' + mbpsNum(data.rate.rx) + ' Mbps · ↑ ' + mbpsNum(data.rate.tx) + ' Mbps';
		else
			text = _('暂无 WAN 速率');

		return this.topoLayer(1, _('互联网'), E('div', { 'class': 'tsm-inet' }, [
			E('span', { 'class': 'tsm-inet-ico' }, globeSvg()),
			E('span', { 'class': 'tsm-inet-txt' }, text)
		]));
	},

	/*
	 * L2：出口卡片，按 rx+tx 取前 3；DIRECT 绿描边并标「直连」。
	 * 卡片可点/可回车：展开该出口下最多 8 台在线设备（chain 与出口名相等）。
	 */
	renderTopoExits: function(data) {
		var self = this;
		var list = data.exits;
		var body;

		if (!list.length) {
			body = E('p', { 'class': 'tsm-tl-empty' }, _('暂无出口数据'));
		}
		else {
			body = E('div', { 'class': 'tsm-exits' }, list.map(function(exit) {
				var key = 'exit:' + exit.name;
				var open = (self.topoOpenExits[key] === true);
				var shown = exit.devices || [];
				var rows = [];

				if (!shown.length) {
					rows.push(E('p', { 'class': 'tsm-xempty' }, _('该出口暂无设备')));
				}
				else {
					shown.forEach(function(dev) {
						rows.push(self.renderTopoDrillRow(deviceName(dev),
							'↓ ' + rateText(dev.rx_rate) + ' ↑ ' + rateText(dev.tx_rate),
							deviceName(dev)));
					});
				}

				var detail = E('div', {
					'class': 'tsm-xlist',
					style: open ? '' : 'display:none'
				}, rows);
				var card = E('div', {
					'class': 'tsm-exit ' + (exit.direct ? 'tsm-exit-direct' : 'tsm-exit-proxy'),
					role: 'button',
					tabindex: '0',
					'aria-expanded': open ? 'true' : 'false',
					'aria-label': exit.name + '，' + _('点击展开设备'),
					title: exit.name
				}, [
					E('div', { 'class': 'tsm-exit-top' }, [
						E('span', { 'class': 'tsm-exit-name' }, exit.name),
						E('span', { 'class': 'tsm-exit-badge' + (exit.direct ? '' : ' tsm-exit-badge-proxy') },
							exit.direct ? _('直连') : _('代理'))
					]),
					E('div', { 'class': 'tsm-exit-bytes' }, fmtBytes(exit.total)),
					detail
				]);

				self.bindTopoExpand(card, detail, key);

				return card;
			}));
		}

		return this.topoLayer(2, _('出口'), body);
	},

	/* 下钻行：名称 + 右侧速率/信号，统一用 .tsm-xrow，避免和 L5 设备行混淆。 */
	renderTopoDrillRow: function(name, meta, title) {
		return E('div', { 'class': 'tsm-xrow' }, [
			E('span', { 'class': 'tsm-xname', title: title }, name),
			E('span', { 'class': 'tsm-xrate' }, meta)
		]);
	},

	/* 出口/AP 卡展开：只切 display 与 class，不重绘拓扑，不触发 RPC。 */
	bindTopoExpand: function(card, detail, key) {
		var self = this;

		function toggle() {
			var open = !(self.topoOpenExits[key] === true);

			self.topoOpenExits[key] = open;

			if (detail != null) detail.style.display = open ? '' : 'none';

			card.setAttribute('aria-expanded', open ? 'true' : 'false');
			self.toggleClass(card, 'open', open);
		}

		card.addEventListener('click', toggle);
		card.addEventListener('keydown', function(ev) {
			var k = (ev != null) ? ev.key : null;

			if (k == 'Enter' || k == ' ' || k == 'Spacebar') {
				if (ev != null && typeof ev.preventDefault == 'function') ev.preventDefault();

				toggle();
			}
		});
	},

	/* L3：主路由（主机名 / 网桥 / 在线数 / 无线·有线·未知）。 */
	renderTopoRouter: function(data) {
		var router = data.router;
		var info = [
			E('div', { 'class': 'tsm-router-name', title: router.name }, router.name)
		];

		if (router.bridge.length)
			info.push(E('div', { 'class': 'tsm-router-meta' }, _('网桥') + '：' + router.bridge));

		info.push(E('div', { 'class': 'tsm-router-links' },
			_('无线') + ' ' + router.counts.wifi + ' / ' +
			_('有线') + ' ' + router.counts.wired + ' / ' +
			_('未知') + ' ' + router.counts.unknown));

		return this.topoLayer(3, _('主路由'), E('div', { 'class': 'tsm-router-card' }, [
			E('div', { 'class': 'tsm-router-ico' }, routerSvg()),
			E('div', { 'class': 'tsm-router-mid' }, info),
			E('div', { 'class': 'tsm-router-online' }, [
				E('b', {}, '' + router.online),
				E('span', {}, _('台在线'))
			])
		]));
	},

	/*
	 * L4：AP 卡片；stations 不可用降级为「AP 数据不可用」，有 get_nodes 时只显示名称与上报时间。
	 * 卡片可点/可回车：按 node_id 展开该 AP 下最多 8 台在线无线设备。
	 */
	renderTopoAps: function(data) {
		var self = this;
		var rows = [];
		var list = data.aps;

		if (list.length) {
			if (data.apDegraded)
				rows.push(E('p', { 'class': 'tsm-tl-warn' }, _('AP 数据不可用')));

			rows.push(E('div', { 'class': 'tsm-aps' }, list.map(function(ap) {
				var key = 'ap:' + ((ap.key != null && ('' + ap.key).length) ? ap.key : ap.name);
				var open = (self.topoOpenExits[key] === true);
				var shown = ap.devices || [];
				var drill = [];

				if (!shown.length) {
					drill.push(E('p', { 'class': 'tsm-xempty' }, _('该 AP 下暂无在线设备')));
				}
				else {
					shown.forEach(function(item) {
						var meta = (item.signal != null)
							? (item.signal + ' dBm')
							: ('↓ ' + rateText(item.dev.rx_rate) + ' ↑ ' + rateText(item.dev.tx_rate));

						drill.push(self.renderTopoDrillRow(deviceName(item.dev), meta, deviceName(item.dev)));
					});
				}

				var children = [
					E('div', { 'class': 'tsm-ap-name', title: ap.name }, ap.name),
					E('div', { 'class': 'tsm-ap-state' }, ap.label)
				];

				if (ap.count != null)
					children.push(E('div', { 'class': 'tsm-ap-dev' }, ap.count + ' ' + _('台在线')));
				else if (ap.meta.length)
					children.push(E('div', { 'class': 'tsm-ap-meta' }, _('上报') + ' ' + ap.meta));

				var detail = E('div', {
					'class': 'tsm-xlist',
					style: open ? '' : 'display:none'
				}, drill);

				children.push(detail);

				var card = E('div', {
					'class': 'tsm-ap' + (ap.online ? ' on' : ''),
					role: 'button',
					tabindex: '0',
					'aria-expanded': open ? 'true' : 'false',
					'aria-label': ap.name + '，' + _('点击展开设备'),
					title: ap.name
				}, children);

				self.bindTopoExpand(card, detail, key);

				return card;
			})));
		}
		else {
			rows.push(E('p', { 'class': 'tsm-tl-empty' },
				data.apDegraded ? _('AP 数据不可用') : _('暂无 AP 数据')));
		}

		return this.topoLayer(4, _('AP / 接入点'), rows);
	},

	/*
	 * L5：在线设备按 link 分三组（组标题保留数量），每组最多 5 台。
	 * 组内不再是文字行，而是两列「设备节点」网格 + 从组头聚合点分叉的 SVG 细线。
	 */
	renderTopoDevices: function(data) {
		var self = this;
		var blocks = [];
		var total = 0;
		var i;

		for (i = 0; i < TOPO_GROUPS.length; i++)
			total += (data.groups[TOPO_GROUPS[i]] || []).length;

		if (!total)
			return this.topoLayer(5, _('设备'),
				E('p', { 'class': 'tsm-tl-empty' }, _('暂无在线设备')));

		TOPO_GROUPS.forEach(function(id) {
			var list = data.groups[id] || [];

			if (!list.length) return;

			var shown = list.slice(0, TOPO_MAX_DEVICES);
			var rest = list.length - shown.length;
			var nodes = shown.map(function(dev) { return self.renderDeviceNode(dev); });
			var tail = (rest > 0) ?
				E('div', { 'class': 'tsm-dmore' }, _('还有') + ' ' + rest + ' ' + _('台')) : null;

			blocks.push(E('div', { 'class': 'tsm-tgroup tsm-tgroup-' + id }, [
				E('div', { 'class': 'tsm-tgroup-h' }, _(LINK_STYLE[id].label) + ' ' + list.length),
				E('div', { 'class': 'tsm-tgroup-body' }, topoTree(nodes, tail))
			]));
		});

		return this.topoLayer(5, _('设备'), E('div', { 'class': 'tsm-tgroups' }, blocks));
	},

	/*
	 * 设备节点：状态环 + 类型图标 + 名称（2 行省略）+ 速率小字。
	 * 单个节点即 role=button；点击/Enter/Space → 设备屏并展开（复用 openDeviceFromTopo）。
	 */
	renderDeviceNode: function(dev, now) {
		var self = this;
		var link = linkOf(dev);
		var kind = deviceKindOf(dev);
		var name = deviceName(dev);
		var online = isDeviceOnline(dev, ((typeof now === 'number') && isFinite(now)) ? now : deviceNow());
		var tone = LINK_STYLE[link] || LINK_STYLE.unknown;
		var node = E('div', {
			'class': 'tsm-dnode is-' + link + (online ? '' : ' is-off'),
			role: 'button',
			tabindex: '0',
			'aria-label': name + '，' + _(tone.label) + '，' +
				(online ? _('在线') : _('离线')) + '，' + _('点击查看设备详情'),
			title: deviceNodeTitle(dev)
		}, [
			E('span', { 'class': 'tsm-dnode-ring' }, [
				E('span', { 'class': 'tsm-dnode-ico' }, deviceKindSvg(kind))
			]),
			E('span', { 'class': 'tsm-dnode-name' }, name),
			E('span', { 'class': 'tsm-dnode-rate' }, deviceNodeRateText(dev))
		]);

		function open() {
			self.openDeviceFromTopo(dev);
		}

		node.addEventListener('click', open);
		node.addEventListener('keydown', function(ev) {
			var k = (ev != null) ? ev.key : null;

			if (k == 'Enter' || k == ' ' || k == 'Spacebar') {
				if (ev != null && typeof ev.preventDefault == 'function') ev.preventDefault();

				open();
			}
		});

		return node;
	},

	/*
	 * 拓扑屏点设备 → 切到设备屏并展开该设备。
	 * 只操作本地已取到的数据（不发 RPC）；先清链路筛选，保证目标行一定在列表里。
	 */
	openDeviceFromTopo: function(dev) {
		var now, tab, list, index = -1, i;

		if (dev == null) {
			this.setPage(1);

			return;
		}

		now = deviceNow();
		tab = isGuestDevice(dev) ? 'guest' : 'main';

		this.devLink = '';
		this.devTab = tab;
		this.devSig = null;

		/* 从拓扑跳过来要保证目标行可见：清掉搜索关键词（不发 RPC）。 */
		this.devQuery = '';
		if (this.devSearchInput != null) this.devSearchInput.value = '';
		this.syncDevSearch();

		list = deviceViewList(this.lastDevices, now, this.devTab, this.devSort, this.devLink, this.devQuery);

		for (i = 0; i < list.length; i++) {
			if (sameDevice(list[i], dev)) {
				index = i;

				break;
			}
		}

		if (index >= 0) this.expanded[deviceKey(list[index], index)] = true;

		this.syncFilterPanel();
		this.syncDevicePage(this.lastDevices);
		this.setPage(1);
	},

	renderInstallPage: function() {
		return E('div', { 'class': 'tsm-page' }, [ this.renderInstall() ]);
	},

	// ------------------------------------------------------------ 概览屏

	renderOverview: function() {
		var self = this;

		this.txNum = E('div', { 'class': 'tsm-big' }, '—');
		this.rxNum = E('div', { 'class': 'tsm-big' }, '—');
		this.exitBadge = E('span', { 'class': 'tsm-badge-c' }, '');
		this.exitName = E('div', { 'class': 'tsm-nodename' }, _('直连'));
		this.exitSub = E('div', { 'class': 'tsm-nodesub' }, _('出口节点'));
		this.devPill = E('div', { 'class': 'tsm-pill' }, '—');
		this.ovSkelHost = E('div', { 'class': 'tsm-skel-grid', 'aria-hidden': 'true' }, '');
		this.ovTopoHost = E('div', {
			'class': 'tsm-otopo',
			role: 'group',
			'aria-label': _('设备拓扑：主路由与在线终端')
		}, '');
		this.plusBtn = E('button', {
			type: 'button',
			'class': 'tsm-plus',
			title: _('更多信息'),
			'aria-label': _('更多信息'),
			click: function() { self.toggleMore(); }
		}, '+');

		return E('div', { 'class': 'tsm-page' }, [
			/* 首屏还没数据时的骨架占位（6 个数字块），数据到了整块清空 */
			this.ovSkelHost,
			E('div', { 'class': 'tsm-rates' }, [
				E('div', { 'class': 'tsm-rate' }, [
					E('div', { 'class': 'tsm-rate-h' }, [ arrowSvg(true, '#00b96b'), this.txNum ]),
					E('div', { 'class': 'tsm-rate-cap' }, _('上传Mbps'))
				]),
				E('div', { 'class': 'tsm-vline' }, ''),
				E('div', { 'class': 'tsm-rate' }, [
					E('div', { 'class': 'tsm-rate-h' }, [ arrowSvg(false, '#ff6f00'), this.rxNum ]),
					E('div', { 'class': 'tsm-rate-cap' }, _('下载Mbps'))
				])
			]),
			/* 速率数字下方的迷你趋势（120×32 SVG，不用 canvas） */
			E('div', { 'class': 'tsm-sparkwrap' }, [
				this.renderSparkline(),
				E('span', { 'class': 'tsm-spark-cap', title: _('最近 12 次采样的下行（蓝）/ 上行（橙）速率') },
					_('近 12 次采样'))
			]),
			E('div', { 'class': 'tsm-node' }, [
				globeSvg(),
				E('div', { 'class': 'tsm-spring' }, ''),
				E('div', { 'class': 'tsm-nodecard' }, [ routerSvg(), this.exitBadge ]),
				this.exitName,
				this.exitSub
			]),
			/* 「N 台终端」胶囊下方：流量 Top 设备 + 应用 Top 3 两个小卡片 */
			E('div', { 'class': 'tsm-foot' }, [ this.plusBtn, this.devPill, this.renderTop3() ]),
			/* 「N 台终端」胶囊之后、「累计口径」说明之前：设备拓扑区块 */
			this.ovTopoHost,
			this.renderMore()
		]);
	},

	/*
	 * 迷你趋势：120×32 的 SVG，两条 polyline（下行蓝 / 上行橙）+ 一条占位横线。
	 * 只在 syncSparkline 里改 points / display 属性，不重建节点、不用 canvas。
	 */
	renderSparkline: function() {
		var svg = svgEl('svg', {
			'class': 'tsm-spark',
			viewBox: '0 0 ' + SPARK_W + ' ' + SPARK_H,
			width: '' + SPARK_W,
			height: '' + SPARK_H,
			role: 'img',
			'aria-label': _('最近 12 次采样的上下行速率趋势'),
			focusable: 'false'
		});

		this.sparkPh = svgEl('line', {
			'class': 'tsm-spark-ph',
			x1: '0', y1: '' + (SPARK_H / 2),
			x2: '' + SPARK_W, y2: '' + (SPARK_H / 2),
			stroke: '#8a8f98', 'stroke-width': '1', 'stroke-dasharray': '3 3'
		});
		this.sparkDown = svgEl('polyline', {
			'class': 'tsm-spark-down', fill: 'none', stroke: COLOR_PROXY,
			'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
			points: ''
		});
		this.sparkUp = svgEl('polyline', {
			'class': 'tsm-spark-up', fill: 'none', stroke: '#ff6f00',
			'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
			points: ''
		});

		svg.appendChild(this.sparkPh);
		svg.appendChild(this.sparkDown);
		svg.appendChild(this.sparkUp);

		this.sparkSvg = svg;

		return svg;
	},

	/*
	 * 概览 Top3：左侧「流量 Top 设备」（可点 → 设备屏并展开该设备），
	 * 右侧「应用 Top 3」。手机版没有独立应用屏，所以应用行只展示、不加点击。
	 */
	renderTop3: function() {
		this.topDevBox = E('div', { 'class': 'tsm-toplist' }, '');
		this.topAppBox = E('div', { 'class': 'tsm-toplist' }, '');

		return E('div', { 'class': 'tsm-top3' }, [
			E('div', { 'class': 'tsm-topcard' }, [
				E('div', { 'class': 'tsm-topcard-t' }, _('流量 Top 设备')),
				this.topDevBox
			]),
			E('div', { 'class': 'tsm-topcard' }, [
				E('div', { 'class': 'tsm-topcard-t' }, _('应用 Top 3')),
				this.topAppBox
			])
		]);
	},

	/* ＋ 展开/收起更多信息：只切 class，数字由 syncAll 回写 */
	toggleMore: function() {
		this.moreOpen = (this.moreOpen !== true);

		this.toggleClass(this.moreBox, 'off', !this.moreOpen);
		this.toggleClass(this.plusBtn, 'on', this.moreOpen);

		if (this.plusBtn != null) {
			this.plusBtn.textContent = this.moreOpen ? '−' : '+';
			this.plusBtn.title = this.moreOpen ? _('收起') : _('更多信息');
		}
	},

	/* 展开区：累计口径说明、代理 vs 直连、无线 vs 有线/未知、健康度 */
	renderMore: function() {
		this.totalValue = E('div', { 'class': 'tsm-card-v' }, '-');
		this.totalSub = E('div', { 'class': 'tsm-card-s' }, '');
		this.wifiValue = E('span', {}, '-');
		this.wifiSub = E('span', { 'class': 'tsm-row-s' }, '');
		this.wiredValue = E('span', {}, '-');
		this.wiredSub = E('span', { 'class': 'tsm-row-s' }, '');
		this.unknownValue = E('span', {}, '-');
		this.unknownSub = E('span', { 'class': 'tsm-row-s' }, '');

		this.moreBox = E('div', { 'class': 'tsm-more off' }, [
			E('p', { 'class': 'tsm-note' },
				_('累计口径：prism-routerd 启动以来，进程重启即归零；速率是最近一次采样的瞬时值。')),
			E('div', { 'class': 'tsm-card tsm-card-i' }, [
				E('div', { 'class': 'tsm-card-t' }, _('累计流量')),
				this.totalValue,
				this.totalSub
			]),
			E('div', { 'class': 'tsm-block' }, [
				E('h3', { 'class': 'tsm-h3' }, _('口径一：代理 vs 直连')),
				this.renderSplitRows(),
				E('p', { 'class': 'tsm-sub' }, _('两者相加即全部流量。'))
			]),
			E('div', { 'class': 'tsm-block' }, [
				E('h3', { 'class': 'tsm-h3' }, _('口径二：无线 vs 有线 / 未知')),
				this.renderLinkRows(),
				E('p', { 'class': 'tsm-sub' }, _('与「代理 vs 直连」是两种独立的口径（按链路类型切分），不可相加。'))
			]),
			E('div', { 'class': 'tsm-block' }, [
				E('h3', { 'class': 'tsm-h3' }, _('健康度')),
				this.renderHealth()
			])
		]);

		return this.moreBox;
	},

	renderLinkRows: function() {
		function row(label, link, valueNode, subNode) {
			return E('div', { 'class': 'tsm-rowline' }, [
				E('span', { 'class': 'tsm-row-l' }, [
					E('span', { 'class': 'tsm-dot', style: 'background:' + link.color }),
					_(link.label)
				]),
				E('span', { 'class': 'tsm-row-num' }, [ valueNode, subNode ])
			]);
		}

		return E('div', { 'class': 'tsm-rows' }, [
			row(_('无线'), LINK_STYLE.wifi, this.wifiValue, this.wifiSub),
			row(_('有线'), LINK_STYLE.wired, this.wiredValue, this.wiredSub),
			row(_('未知'), LINK_STYLE.unknown, this.unknownValue, this.unknownSub)
		]);
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

	/* ------------------------------------------------------------ 安装 / 扫码 */

	/*
	 * 页面底部：二维码 + 安装入口 + 当前地址。
	 * 这一块与 get_state 完全无关（只读 location / beforeinstallprompt），
	 * 所以后端没数据、手机没网时也照常显示。
	 */
	renderInstall: function() {
		var self = this;
		var url = pageUrl();

		bindInstallListeners();

		this.qrHost = E('div', { 'class': 'tsm-qr' }, '');
		this.urlNode = E('code', { 'class': 'tsm-url', title: url }, url.length ? url : '—');
		this.copyBtn = E('button', {
			type: 'button',
			'class': 'tsm-copy',
			click: function() { self.copyUrl(); }
		}, _('复制'));
		this.installHost = E('div', { 'class': 'tsm-inst' }, '');

		/* manifest 是 render 时才注入的，安装事件通常在首屏之后才来，由这里回写状态 */
		INSTALL.refresh = function() { self.syncInstall(); };

		this.renderQr(this.qrHost, url);
		this.syncInstall();

		return E('div', {}, [
			E('div', { 'class': 'tsm-section' }, [
				E('h3', { 'class': 'tsm-h3' }, _('安装到手机')),
				E('div', { 'class': 'tsm-install-card' }, [
					this.qrHost,
					E('div', { 'class': 'tsm-qr-cap' }, _('用另一台手机扫码打开')),
					this.installHost,
					E('div', { 'class': 'tsm-url-row' }, [ this.urlNode, this.copyBtn ])
				]),
				E('p', { 'class': 'tsm-note tsm-install-note' },
					_('内网 https 自签地址：另一台手机第一次打开会提示证书不受信任，选择「继续访问」即可。'))
			]),
			this.renderOfflineData()
		]);
	},

	/* 二维码交给 LuCI 自带的 uqr（不在前端重复实现编码），任何失败都只降级成一行提示。 */
	renderQr: function(host, text) {
		var done = false;

		var fallback = function() {
			if (done) return;

			done = true;
			dom.content(host, E('div', { 'class': 'tsm-qr-fail' },
				_('二维码不可用，请复制下方地址用另一台手机打开')));
		};

		var apply = function(mod) {
			if (done) return false;

			var api = mod;

			if (api != null && typeof api.renderSVG != 'function' &&
				api['default'] != null && typeof api['default'].renderSVG == 'function')
				api = api['default'];

			if (api == null || typeof api.renderSVG != 'function') return false;

			try {
				var svg = api.renderSVG(text, { pixelSize: 5, whiteColor: '#fff', blackColor: '#000' });

				if (typeof svg != 'string' || !svg.length) return false;

				/* 库返回 SVG 字符串：用 DOMParser 解析后 importNode，不做 HTML 字符串赋值。
				   只接受根节点是 <svg> 的文档；脚本/foreignObject 一律剥掉。 */
				var doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
				var root = doc ? doc.documentElement : null;

				if (root == null || ('' + root.nodeName).toLowerCase() !== 'svg') return false;

				var imported = document.importNode(root, true);

				[].forEach.call(imported.querySelectorAll('script,foreignObject'), function(node) {
					if (node.parentNode != null) node.parentNode.removeChild(node);
				});

				done = true;
				while (host.firstChild) host.removeChild(host.firstChild);
				host.appendChild(imported);
				normalizeQrSvg(host);   /* 让 SVG 能按容器缩放（补 viewBox） */
				host.setAttribute('data-qr', 'ok');

				return true;
			}
			catch (e) {
				return false;
			}
		};

		if (!text.length) {
			fallback();
			return;
		}

		var mod = null;

		try { mod = L.require('uqr'); }
		catch (e) { mod = null; }

		if (apply(mod)) return;

		/* L.require 在 LuCI 里可能返回 Promise，已加载过也可能直接返回模块，两种都接住 */
		if (mod != null && typeof mod.then == 'function') {
			mod.then(function(m) { if (!apply(m)) fallback(); })
				.catch(fallback);

			return;
		}

		fallback();
	},

	syncInstall: function() {
		if (this.installHost == null) return;

		var self = this;
		var mode = installMode();

		if (mode == 'installed') {
			dom.content(this.installHost, E('div', {}, [
				E('div', { 'class': 'tsm-inst-ok' }, '✓ ' + _('已安装（当前以独立窗口打开）')),
				E('div', { 'class': 'tsm-inst-hint' }, _('要重新安装，先在系统里卸载本应用，再刷新这个页面。'))
			]));

			return;
		}

		if (mode == 'prompt') {
			dom.content(this.installHost, E('div', {}, [
				E('button', {
					type: 'button',
					'class': 'tsm-inst-btn',
					click: function() { self.promptInstall(); }
				}, '＋ ' + _('添加到主屏幕')),
				E('div', { 'class': 'tsm-inst-hint' }, _('点击后由浏览器弹出安装确认；没反应就按下面的手动步骤操作。'))
			]));

			return;
		}

		dom.content(this.installHost, this.renderInstallSteps());
	},

	/* 没有 beforeinstallprompt（iOS Safari / 已拒绝 / 不支持）时给分步文案 */
	renderInstallSteps: function() {
		var platform = platformOf();
		var steps = [];

		var add = function(text) {
			steps.push(E('div', { 'class': 'tsm-inst-step' }, [
				E('span', { 'class': 'tsm-inst-n' }, '' + (steps.length + 1)),
				E('span', { 'class': 'tsm-inst-s' }, text)
			]));
		};

		var title = '';

		if (platform == 'ios') {
			title = _('iPhone / iPad（Safari）：');
			add(_('点底部工具栏的「分享」按钮（方框带向上箭头）'));
			add(_('在弹出菜单里选「添加到主屏幕」'));
			add(_('确认名称后点右上角「添加」'));
		}
		else if (platform == 'android') {
			title = _('Android Chrome：');
			add(_('点右上角的「⋮」菜单'));
			add(_('选「添加到主屏幕」或「安装应用」'));
			add(_('按提示确认安装'));
		}
		else {
			title = _('当前浏览器没有提供安装入口，可以：');
			add(_('Android Chrome：右上角「⋮」→「添加到主屏幕」/「安装应用」'));
			add(_('iOS Safari：底部「分享」→「添加到主屏幕」'));
			add(_('浏览器只在 https（或 localhost）下提供安装能力'));
		}

		var nodes = [ E('div', { 'class': 'tsm-inst-t' }, title), E('div', { 'class': 'tsm-inst-steps' }, steps) ];

		if (INSTALL.applied)
			nodes.push(E('div', { 'class': 'tsm-inst-hint' },
				_('已经弹出过安装确认；如果没有装成功，按上面的步骤手动添加。')));

		return E('div', {}, nodes);
	},

	/* beforeinstallprompt 的事件对象只能用一次：调用后立刻清掉，失败就回落到手动步骤 */
	promptInstall: function() {
		var self = this;
		var ev = INSTALL.deferred;

		INSTALL.applied = true;

		if (ev == null || typeof ev.prompt != 'function') {
			INSTALL.deferred = null;
			this.syncInstall();

			return;
		}

		INSTALL.deferred = null;

		try { ev.prompt(); }
		catch (e) { }

		try {
			if (ev.userChoice != null && typeof ev.userChoice.then == 'function') {
				ev.userChoice.then(function() { self.syncInstall(); })
					.catch(function() { self.syncInstall(); });
			}
		}
		catch (e) { }

		this.syncInstall();
	},

	/* ------------------------------------------------------------ 离线数据（安装 / 关于屏） */

	/*
	 * 离线快照的说明 + 清除入口：断网首屏要用它，所以放在「安装 / 关于」屏，
	 * 用户随时能自己删掉（隐私敏感的场景尤其需要）。
	 */
	renderOfflineData: function() {
		var self = this;

		this.offlineDataNote = E('div', { 'class': 'tsm-offline-note' }, '');
		this.offlineClearBtn = E('button', {
			type: 'button',
			'class': 'tsm-offline-clear',
			click: function() { self.clearOfflineData(); }
		}, _('清除离线数据'));

		this.syncOfflineData();

		return E('div', { 'class': 'tsm-section' }, [
			E('h3', { 'class': 'tsm-h3' }, _('离线数据')),
			E('div', { 'class': 'tsm-offline-card' }, [
				this.offlineDataNote,
				this.offlineClearBtn
			]),
			E('p', { 'class': 'tsm-note' },
				_('断网或接口失败时显示最近一次成功的数据快照（最多保留 24 小时，只含展示字段，不含密钥）。'))
		]);
	},

	/* 只回写文本：快照时间 / 过期 / 不可用一律不进 title、data-* 等属性。 */
	syncOfflineData: function() {
		var note = this.offlineDataNote;
		var snap;

		if (note == null) return;

		if (snapStore() == null) {
			note.textContent = _('当前浏览器不允许本地存储（如隐私模式），离线快照不可用');

			if (this.offlineClearBtn != null) this.offlineClearBtn.style.display = 'none';

			return;
		}

		if (this.offlineClearBtn != null) this.offlineClearBtn.style.display = '';

		snap = readSnapshot();

		if (snap != null && snap.expired === true) {
			this.snapshotExpired = true;
			note.textContent = _('快照已过期');

			return;
		}

		if (snap != null && snap.state != null) {
			this.snapshotExpired = false;
			note.textContent = _('已保存离线快照') + ' · ' + _('更新于') + ' ' +
				fmtHHMM(snap.ts) + '（' + fmtAgo(snap.ts, 0) + '）';

			return;
		}

		note.textContent = (this.snapshotExpired === true) ? _('快照已过期') : _('暂无离线快照');
	},

	/* 清掉 localStorage 里的快照键：清完当次页面仍显示内存里的数据，下次刷新回到实时。 */
	clearOfflineData: function() {
		var ok = removeSnapshot();

		this.snapshotExpired = false;
		this.hideOfflineBar();
		this.syncOfflineData();

		if (typeof ui != 'undefined' && ui != null && typeof ui.addNotification == 'function') {
			ui.addNotification(null, E('p', {}, ok
				? _('已清除离线数据')
				: _('当前浏览器不允许本地存储（如隐私模式），没有可清除的数据')), 'info');
		}

		return ok;
	},

	copyUrl: function() {
		var self = this;
		var url = pageUrl();

		var selectText = function() {
			try {
				var range = document.createRange();

				range.selectNodeContents(self.urlNode);

				var sel = window.getSelection();

				sel.removeAllRanges();
				sel.addRange(range);
			}
			catch (e) { }
		};

		var fallback = function() {
			/* 非安全上下文 / 旧浏览器：退回选中文本，让用户长按复制 */
			selectText();

			var ok = false;

			try { ok = document.execCommand('copy'); }
			catch (e) { ok = false; }

			self.flashCopy(ok);
		};

		try {
			if (window.navigator.clipboard != null &&
				typeof window.navigator.clipboard.writeText == 'function') {
				window.navigator.clipboard.writeText(url)
					.then(function() { self.flashCopy(true); })
					.catch(fallback);

				return;
			}
		}
		catch (e) { }

		fallback();
	},

	flashCopy: function(ok) {
		var btn = this.copyBtn;

		if (btn == null) return;

		btn.textContent = ok ? _('已复制') : _('已选中，长按复制');
		btn.disabled = true;

		if (this._copyTimer != null) window.clearTimeout(this._copyTimer);

		this._copyTimer = window.setTimeout(function() {
			btn.textContent = _('复制');
			btn.disabled = false;
		}, 2000);
	},

	// ------------------------------------------------------------ 同步

	syncAll: function(state) {
		var totals = (state != null && state.totals != null) ? state.totals : {};
		var health = (state != null && state.health != null) ? state.health : {};
		var devices = (state != null && Array.isArray(state.devices)) ? state.devices : [];
		var nodes = (state != null && state.nodes != null) ? state.nodes : {};

		this.setUpdated(state != null ? state.ts : 0);

		/* 概览屏的数字：只回写节点，不重绘整屏 */
		this.syncOverview(totals, nodes, health, devices);

		/* 展开区（口径说明） */
		this.syncCards(totals);
		this.syncLinkRows(totals);
		this.syncSplitRows(totals);
		this.syncHealth(health);

		/* 设备屏：分类 → 排序/筛选 → 写回列表（内部按 sig 去重） */
		this.syncDevicePage(devices);

		/* 节点屏：与 15s 轮询同一次刷新，不新增定时器 */
		this.syncNodePage();

		/* 拓扑屏：与同一次刷新一起更新，sig 未变不重建 */
		this.syncTopoPage();
	},

	/*
	 * 设备屏写回：tab 数量 + 标题 + 列表。
	 * 只重排本地数据（分类/排序/筛选都在本地做），不发任何 RPC。
	 * 时钟一律取真实当前时间（state.ts 冻结时不能把旧设备算成在线）。
	 */
	syncDevicePage: function(devices) {
		this.lastDevices = Array.isArray(devices) ? devices : [];
		this.devNow = deviceNow();

		this.syncDevTabs();
		this.syncDevTrunc();

		if (this.devTitleText != null) this.devTitleText.textContent = _(this.devTabLabel());

		this.renderDevices(deviceViewList(this.lastDevices, this.devNow, this.devTab,
			this.devSort, this.devLink, this.devQuery));
	},

	/* state.truncated 明确为 true 才提示；字段缺失/老后端不显示。 */
	syncDevTrunc: function() {
		var node = this.devTruncNote;

		if (node == null) return;

		var truncated = (this.state != null && this.state.truncated === true);

		node.style.display = truncated ? 'block' : 'none';
	},

	/* 概览屏：上传/下载速率、迷你趋势、出口节点、在线终端数、Top3、设备拓扑 */
	syncOverview: function(totals, nodes, health, devices) {
		var apps = (this.state != null && Array.isArray(this.state.apps)) ? this.state.apps : [];

		this.syncRateBig(totals);
		this.syncSparkline(totals);
		this.syncExitNode(nodes, health);
		this.syncDevicePill(devices);
		this.syncOverviewTopo(devices);
		this.syncTop3(devices, apps);
		this.syncOverviewSkeleton(false);
	},

	/* 每次 sync 追加一次采样（cap 12），只改 polyline 的 points，不重建 SVG。 */
	syncSparkline: function(totals) {
		var t = totals || {};

		if (!Array.isArray(this.sparkSamples)) this.sparkSamples = [];

		this.sparkSamples.push({ rx: num(t.rx_rate), tx: num(t.tx_rate) });

		while (this.sparkSamples.length > SPARK_MAX) this.sparkSamples.shift();

		if (this.sparkDown != null)
			this.sparkDown.setAttribute('points', sparkPoints(this.sparkSamples, 'rx'));

		if (this.sparkUp != null)
			this.sparkUp.setAttribute('points', sparkPoints(this.sparkSamples, 'tx'));

		/* 有采样就收起占位横线；没数据时保留，避免空白框 */
		if (this.sparkPh != null)
			this.sparkPh.style.display = this.sparkSamples.length ? 'none' : '';
	},

	/* 首屏 state 未到达时铺 6 个数字块骨架；数据到达后整块清空（节点数归 0）。 */
	syncOverviewSkeleton: function(show) {
		var on = (show === true);

		if (this.ovSkelHost == null || on === this.ovSkelOn) return;

		this.ovSkelOn = on;
		dom.content(this.ovSkelHost, on ? skeletonBlocks(6, 'tsm-skel-num') : []);
	},

	/*
	 * Top3 写回：设备按合计流量（deviceTotal）取前 3，应用按 rx+tx 取前 3。
	 * 只在数据 / 名称变化时重建（sig 去重），15s 轮询不会每轮重排。
	 */
	syncTop3: function(devices, apps) {
		var self = this;
		var devList = Array.isArray(devices) ? devices : [];
		var appList = Array.isArray(apps) ? apps : [];
		var entries = [];
		var sig, rows;
		var i;

		for (i = 0; i < devList.length; i++)
			if (devList[i] != null) entries.push({ dev: devList[i], index: i });

		entries.sort(function(a, b) { return deviceTotal(b.dev) - deviceTotal(a.dev); });
		entries = entries.slice(0, 3);

		appList = appList.slice().sort(function(a, b) {
			return (num(b != null ? b.rx : 0) + num(b != null ? b.tx : 0)) -
				(num(a != null ? a.rx : 0) + num(a != null ? a.tx : 0));
		}).slice(0, 3);

		sig = 'd:' + sigOf(entries, function(item) {
			return deviceKey(item.dev, item.index) + ':' + deviceTotal(item.dev);
		}) + '|a:' + sigOf(appList, function(app) {
			return '' + ((app != null && app.host != null) ? app.host : '') + ':' +
				num(app != null ? app.rx : 0) + ':' + num(app != null ? app.tx : 0);
		});

		if (sig === this.top3Sig) return;

		this.top3Sig = sig;

		if (this.topDevBox != null) {
			rows = entries.map(function(item) {
				return E('button', {
					type: 'button',
					'class': 'tsm-toprow is-link',
					title: deviceName(item.dev) + ' · ' + _('点击查看设备'),
					click: function() { self.openTopDevice(item.dev, item.index); }
				}, [
					E('span', { 'class': 'tsm-topname' }, deviceName(item.dev)),
					E('span', { 'class': 'tsm-topval' }, fmtBytes(deviceTotal(item.dev)))
				]);
			});

			if (!rows.length)
				rows.push(E('div', { 'class': 'tsm-toprow-empty' }, _('暂无数据')));

			dom.content(this.topDevBox, rows);
		}

		if (this.topAppBox != null) {
			rows = appList.map(function(app) {
				var host = (app != null && app.host != null) ? ('' + app.host) : '';

				return E('div', { 'class': 'tsm-toprow', title: host }, [
					E('span', { 'class': 'tsm-topname' }, appLabel(host)),
					E('span', { 'class': 'tsm-topval' },
						fmtBytes(num(app != null ? app.rx : 0) + num(app != null ? app.tx : 0)))
				]);
			});

			if (!rows.length)
				rows.push(E('div', { 'class': 'tsm-toprow-empty' }, _('暂无数据')));

			dom.content(this.topAppBox, rows);
		}
	},

	/*
	 * Top 设备 → 设备屏：切到该设备所属分类、清掉搜索/链路筛选并展开它的应用明细。
	 * 全部是本地状态，不发任何 RPC。
	 * 展开键沿用 deviceKey()（有 MAC/IP 时稳定；两者都没有的设备按数组下标，
	 * 与设备屏里的行下标可能不同，这种设备点了只切屏、不一定展开——属于已知边界）。
	 */
	openTopDevice: function(dev, index) {
		var now = deviceNow();
		var key = deviceKey(dev, index);
		var tab = classifyDevice(dev, now);
		var list = (Array.isArray(this.lastDevices) && this.lastDevices.length)
			? this.lastDevices
			: ((this.state != null && Array.isArray(this.state.devices)) ? this.state.devices : []);

		this.devNow = now;
		this.expanded[key] = true;

		this.devQuery = '';
		this.devLink = '';

		if (tab === 'main' || tab === 'guest' || tab === 'offline') this.devTab = tab;
		if (this.devSearchInput != null) this.devSearchInput.value = '';

		this.devSig = null;

		this.setPage(1);
		this.syncDevSearch();
		this.syncFilterPanel();
		this.syncDevTabs();
		this.syncDevicePage(list);
	},

	syncRateBig: function(totals) {
		var t = totals || {};

		this.setBig(this.txNum, t.tx_rate, _('上传速率'));
		this.setBig(this.rxNum, t.rx_rate, _('下载速率'));
	},

	setBig: function(node, value, label) {
		if (node == null) return;

		if (!present(value)) {
			node.textContent = '—';
			node.title = label + '：' + _('暂无数据');

			return;
		}

		node.textContent = mbpsNum(value);
		node.title = label + '：' + fmtMbps(value);
	},

	/* 出口节点名 = nodes 里 rx+tx 最大的非 DIRECT 项；没有代理节点显示「直连」 */
	syncExitNode: function(nodes, health) {
		var name = exitNodeOf(nodes);
		var conns = num(health != null ? health.clash_connections : 0);

		if (this.exitName != null) {
			this.exitName.textContent = name.length ? name : _('直连');
			this.exitName.title = name.length ? name : _('直连');
		}

		if (this.exitBadge == null) return;

		if (conns > 0) {
			this.exitBadge.textContent = '' + conns;
			this.exitBadge.style.display = 'block';
		}
		else {
			this.exitBadge.textContent = '';
			this.exitBadge.style.display = 'none';
		}
	},

	syncDevicePill: function(devices) {
		if (this.devPill == null) return;

		var online = activeDeviceCount(devices, nowSec());

		this.devPill.textContent = online + ' ' + _('台终端');
		this.devPill.title = _('最近 10 分钟内有记录的终端');
	},

	/*
	 * 概览屏设备拓扑：主路由根节点 + 最多 8 个在线终端节点（2 列网格 + SVG 细线）。
	 * 与设备屏同一在线口径；sig 未变不重建 DOM（15s 轮询不闪动、不丢点击焦点）。
	 */
	syncOverviewTopo: function(devices) {
		var host = this.ovTopoHost;
		var now, online, shown, rest, name, sig;

		if (host == null) return;

		now = deviceNow();
		online = topoOnlineDevices(devices, now);
		shown = online.slice(0, OVERVIEW_TOPO_MAX);
		rest = online.length - shown.length;
		name = topoHostname(this.state);
		sig = name + '|' + rest + '|' + sigOf(shown, function(dev) {
			return deviceKey(dev) + ':' + deviceName(dev) + ':' + linkOf(dev) + ':' +
				num(dev.rx_rate) + ':' + num(dev.tx_rate);
		});

		if (sig === this.ovTopoSig) return;

		this.ovTopoSig = sig;
		dom.content(host, this.renderOverviewTopo(shown, rest, name, now));
	},

	/* 主路由根节点 → 树（树干/每行总线/节点）；0 台在线时只给占位，不造假节点。 */
	renderOverviewTopo: function(shown, rest, hostname, now) {
		var self = this;
		var root = E('div', { 'class': 'tsm-otop-root' }, [
			E('span', { 'class': 'tsm-otop-ico' }, routerSvg()),
			E('span', { 'class': 'tsm-otop-name', title: hostname }, hostname)
		]);
		var nodes;
		var tail;

		if (!shown.length) {
			return E('div', {}, [
				root,
				E('p', { 'class': 'tsm-otop-empty' }, _('暂无在线设备'))
			]);
		}

		nodes = shown.map(function(dev) { return self.renderDeviceNode(dev, now); });
		tail = (rest > 0) ?
			E('div', { 'class': 'tsm-dmore' }, _('还有') + ' ' + rest + ' ' + _('台')) : null;

		return E('div', {}, [
			root,
			topoTree(nodes, tail)
		]);
	},

	setUpdated: function(ts) {
		var t = num(ts);

		/* 保留后端时间戳，但补上相对时间：跨天/停摆时一眼能看出陈旧。 */
		this.updatedNode.textContent = t ? (fmtClock(t) + ' · ' + fmtAgo(t)) : '—';
		this.updatedNode.title = t ? '' + new Date(t * 1000) : '';
	},

	/* 展开区：累计流量（进程启动以来） */
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
	},

	/* 展开区：无线 vs 有线/未知（与代理/直连正交，不能相加） */
	syncLinkRows: function(totals) {
		var t = totals || {};

		this.syncLinkCard(this.wifiValue, this.wifiSub, t, 'wifi');
		this.syncLinkCard(this.wiredValue, this.wiredSub, t, 'wired');
		this.syncLinkCard(this.unknownValue, this.unknownSub, t, 'unknown');
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
		subNode.textContent = '↓ ' + fmtBytes(rx) + ' ↑ ' + fmtBytes(tx);
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

	/*
	 * 列表写回：sig 由「视图参数 + 数据」拼成，没变就不重建 DOM。
	 * 时间桶按分钟入 sig，让「3 分钟前」这类相对时间自己往前走。
	 */
	renderDevices: function(devices) {
		var self = this;
		var list = Array.isArray(devices) ? devices : [];

		if (this.devicesBox == null) return;

		if (this.devicesCount != null) this.devicesCount.textContent = '(' + list.length + ')';

		var sig = [
			/* 骨架 → 真实数据必须换 sig，否则同一分钟内会一直停在骨架上 */
			(this.state == null) ? 'skel' : 'data',
			'' + this.devTab,
			'' + this.devSort,
			'' + this.devLink,
			'' + this.devQuery,
			Math.floor(this.devNow / 60),
			sigOf(list, function(dev) {
				return deviceKey(dev) + '|' + linkOf(dev) + '|' + deviceTotal(dev) + '|' +
					num(dev != null ? dev.rx_rate : 0) + '|' + num(dev != null ? dev.tx_rate : 0) + '|' +
					num(dev != null ? dev.last_seen : 0) + '|' + appListOf(dev).length + '|' +
					deviceChainLabel(dev);
			})
		].join('|');

		if (sig === this.devSig) return;

		this.devSig = sig;

		/* 首屏 state 还没到：5 行骨架占位，数据到达后整块替换（不发请求） */
		if (this.state == null) {
			dom.content(this.devicesBox,
				E('div', { 'class': 'tsm-skel-list' }, skeletonBlocks(5, 'tsm-skel-row')));

			return;
		}

		if (list.length == 0) {
			/* 搜索无结果 vs 该分类本来就没有设备，文案必须分开，避免误以为设备丢了。 */
			if (this.devQuery.length) {
				dom.content(this.devicesBox, [
					E('p', { 'class': 'tsm-empty' }, _('没有匹配的设备')),
					E('p', { 'class': 'tsm-dnote' }, _('关键词') + '：' + this.devQuery)
				]);

				return;
			}

			dom.content(this.devicesBox, [
				E('p', { 'class': 'tsm-empty' }, _(this.devTabEmpty())),
				E('p', { 'class': 'tsm-dnote' }, _('数据来自后端 state.json，每 15 秒自动刷新。'))
			]);

			return;
		}

		dom.content(this.devicesBox, E('div', {}, list.map(function(dev, index) {
			return self.renderDeviceRow(dev, index);
		})));
	},

	/*
	 * 设备行：40px 圆形底（无线/有线不同底色）+ 三行文字 + 右侧两行速率 + 箭头。
	 * 整行可点（min-height 44px）/可回车，展开区复用 renderDeviceApps。
	 */
	renderDeviceRow: function(dev, index) {
		var self = this;
		var key = deviceKey(dev, index);
		var link = LINK_STYLE[linkOf(dev)] || LINK_STYLE.unknown;
		var open = (this.expanded[key] === true);
		var detail = E('div', { 'class': 'tsm-detail tsm-ddetail', style: open ? '' : 'display:none' }, '');
		var filled = false;

		if (open) {
			filled = true;
			dom.content(detail, this.renderDeviceApps(dev));
		}

		var row = E('div', {
			'class': 'tsm-drow' + (open ? ' on' : ''),
			role: 'button',
			tabindex: '0',
			'aria-expanded': open ? 'true' : 'false',
			title: deviceName(dev)
		}, [
			E('div', { 'class': 'tsm-dava', style: 'background:' + link.color }, deviceInitial(dev)),
			E('div', { 'class': 'tsm-dmid' }, [
				E('div', { 'class': 'tsm-dname' }, deviceName(dev)),
				E('div', { 'class': 'tsm-dmeta' }, _('连接节点') + '：' + deviceChainLabel(dev)),
				E('div', { 'class': 'tsm-dmeta' },
					deviceKindLabel(deviceKindOf(dev)) + ' · ' +
					_(link.label) + ' · ' + deviceSeenLabel(dev, this.devNow))
			]),
			E('div', { 'class': 'tsm-drates' }, [
				E('div', {}, '↑ ' + rateText(dev != null ? dev.tx_rate : null)),
				E('div', {}, '↓ ' + rateText(dev != null ? dev.rx_rate : null))
			]),
			E('span', { 'class': 'tsm-darrow' }, '›')
		]);

		function toggle() {
			open = !(self.expanded[key] === true);
			self.expanded[key] = open;
			detail.style.display = open ? '' : 'none';
			row.setAttribute('aria-expanded', open ? 'true' : 'false');
			self.toggleClass(row, 'on', open);

			if (open && !filled) {
				filled = true;
				dom.content(detail, self.renderDeviceApps(dev));
			}
		}

		row.addEventListener('click', toggle);
		row.addEventListener('keydown', function(ev) {
			var k = (ev != null) ? ev.key : null;

			if (k == 'Enter' || k == ' ' || k == 'Spacebar') {
				if (ev != null && typeof ev.preventDefault == 'function') ev.preventDefault();

				toggle();
			}
		});

		return E('div', { 'class': 'tsm-ditem' }, [ row, detail ]);
	},

	// ------------------------------------------------------------ 节点屏渲染

	/* get_nodes 结果：成功（含空数组）与失败分开记，失败时保留上一次成功的数据。 */
	applyNodes: function(result) {		var ok = (result != null) && (result.ok === true) && (result.res != null) &&
			(typeof result.res == 'object') && Array.isArray(result.res.nodes);

		if (ok) {
			this.nodesList = result.res.nodes;
			this.nodesOk = true;
			this.nodesError = '';

			return;
		}

		var err = (result != null) ? result.err : null;
		var msg = (err != null && err.message) ? ('' + err.message) : ((err != null) ? ('' + err) : '');

		this.nodesOk = false;

		if (!Array.isArray(this.nodesList)) this.nodesList = [];

		this.nodesError = msg.length ? msg : _('后端 prism-router.get_nodes 不可用');
	},

	/* get_stations 结果：数组缺失/rpcd 失败都只记错误，拓扑 AP 层降级，其它屏照常。 */
	applyStations: function(result) {
		var ok = (result != null) && (result.ok === true) && (result.res != null) &&
			(typeof result.res == 'object') &&
			(Array.isArray(result.res.nodes) || Array.isArray(result.res.stations));

		if (ok) {
			this.stationsNodes = Array.isArray(result.res.nodes) ? result.res.nodes : [];
			this.stationsList = Array.isArray(result.res.stations) ? result.res.stations : [];
			this.stationsOk = true;
			this.stationsError = '';

			return;
		}

		var err = (result != null) ? result.err : null;
		var msg = (err != null && err.message) ? ('' + err.message) : ((err != null) ? ('' + err) : '');

		this.stationsOk = false;

		if (!Array.isArray(this.stationsNodes)) this.stationsNodes = [];
		if (!Array.isArray(this.stationsList)) this.stationsList = [];

		this.stationsError = msg.length ? msg : _('后端 prism-router.get_stations 不可用');
	},

	/* 节点屏写回：按 sig 去重；空数组/失败给空态文案，绝不抛错也绝不留白屏。 */
	syncNodePage: function() {
		var self = this;
		var list = Array.isArray(this.nodesList) ? this.nodesList : [];
		var sig;

		if (this.nodeHost == null) return;

		/* 还没触发懒加载：只给「加载中」占位，别把「未配置子节点」当成结论。 */
		if (this.nodeDataLoaded !== true) {
			if (this.nodeSig === 'loading') return;

			this.nodeSig = 'loading';
			dom.content(this.nodeHost, [
				E('p', { 'class': 'tsm-empty' }, _('正在加载节点数据…')),
				E('p', { 'class': 'tsm-nnote' }, _('首次进入节点屏时加载，之后直接复用。'))
			]);

			return;
		}

		sig = [
			(list.length ? '1' : '0'),
			this.nodesOk === true ? '1' : '0',
			this.nodesError,
			sigOf(list, nodeSigField)
		].join('|');

		if (sig === this.nodeSig) return;

		this.nodeSig = sig;

		if (list.length == 0) {
			dom.content(this.nodeHost, [
				E('p', { 'class': 'tsm-empty' }, _('未配置子节点（母节点需要各子节点上报）')),
				E('p', { 'class': 'tsm-nnote' }, this.nodesError.length
					? (_('原因') + '：' + this.nodesError)
					: _('原因：本机 state 目录里没有子节点快照（子节点尚未上报）。'))
			]);

			return;
		}

		/* nodesOk=false 但已有旧卡片：保留卡片，只在顶部补一行错误提示，不清空旧数据。 */
		var rows = [];

		if (this.nodesOk !== true)
			rows.push(E('p', { 'class': 'tsm-nerr' },
				_('节点数据刷新失败') + '：' +
				(this.nodesError.length ? this.nodesError : _('后端 prism-router.get_nodes 不可用'))));

		rows.push(E('div', { 'class': 'tsm-ngrid' }, list.map(function(node, index) {
			return self.renderNodeCard(node, index);
		})));

		dom.content(this.nodeHost, rows);
	},

	/*
	 * 节点卡片：自绘线稿路由器 + 节点名 + 状态胶囊（在线 / 未绑定 / 未知）；
	 * 右上角「⋮」在卡内展开详情（最后上报 / 累计总量 / 代理·直连 / 设备数）。
	 */
	renderNodeCard: function(node, index) {
		var self = this;
		var id = nodeIdOf(node, index);
		var status = nodeStatus(node != null ? node.age_sec : -1);
		var open = (this.nodeOpen[id] === true);
		var detail = E('div', { 'class': 'tsm-ndetail', style: open ? '' : 'display:none' },
			open ? this.renderNodeDetail(node) : '');
		var more = E('button', {
			type: 'button',
			'class': 'tsm-nmore' + (open ? ' on' : ''),
			'aria-label': _('节点详情'),
			'aria-expanded': open ? 'true' : 'false',
			title: _('详情'),
			click: function(ev) {
				if (ev != null && typeof ev.stopPropagation == 'function') ev.stopPropagation();

				open = !(self.nodeOpen[id] === true);
				self.nodeOpen[id] = open;
				detail.style.display = open ? '' : 'none';
				more.setAttribute('aria-expanded', open ? 'true' : 'false');
				self.toggleClass(more, 'on', open);

				if (open) dom.content(detail, self.renderNodeDetail(node));
			}
		}, '⋮');

		var icon = E('div', { 'class': 'tsm-nico', style: 'background:' + status.ico }, routerSvg());

		return E('div', { 'class': 'tsm-ncard' }, [
			more,
			icon,
			E('div', { 'class': 'tsm-nname', title: nodeNameOf(node, index) }, nodeNameOf(node, index)),
			E('div', { 'class': 'tsm-npillwrap' }, [
				E('span', {
					'class': 'tsm-npill',
					style: 'color:' + status.color + ';background:' + status.bg
				}, status.label)
			]),
			detail
		]);
	},

	/* 详情行：缺失字段一律「—」，不做任何猜测。 */
	renderNodeDetail: function(node) {
		var totals = nodeTotalsOf(node);
		var count = nodeDeviceCount(node);
		var ts = num(node != null ? node.ts : 0);
		var has = (totals != null) && hasAnyTotal(totals);
		var proxy = num(totals != null ? totals.proxy_rx : 0) + num(totals != null ? totals.proxy_tx : 0);
		var direct = num(totals != null ? totals.direct_rx : 0) + num(totals != null ? totals.direct_tx : 0);

		function line(key, value) {
			return E('div', { 'class': 'tsm-ndrow' }, [
				E('span', { 'class': 'tsm-ndrow-k' }, key),
				E('span', { 'class': 'tsm-ndrow-v' }, value)
			]);
		}

		return E('div', {}, [
			line(_('最后上报'), (ts > 0) ? (fmtAgo(ts, 0) + ' · ' + fmtClock(ts)) : '—'),
			line(_('累计总量'), has ? fmtBytes(totalOf(totals)) : '—'),
			line(_('代理 / 直连'), has ? (fmtBytes(proxy) + ' / ' + fmtBytes(direct)) : '—'),
			line(_('设备数'), (count == null) ? '—' : (count + ' ' + _('台')))
		]);
	},

	renderDeviceApps: function(dev) {
		var list = appListOf(dev).slice(0, 5);

		if (list.length == 0)
			return E('div', { 'class': 'tsm-empty-s' }, _('该设备暂无应用明细'));

		var children = [];

		/* 后端只回传裁剪后的应用明细时，在列表上方明确提示。 */
		if (dev != null && dev.apps_truncated === true)
			children.push(E('div', { 'class': 'tsm-apps-trunc' }, _('应用明细已裁剪')));

		children.push(E('div', { 'class': 'tsm-apps-t' }, _('应用 Top 5')));

		return E('div', { 'class': 'tsm-apps' }, children.concat(list.map(function(app) {
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
		var warnColor = '#b26a00';
		var warnBg = 'rgba(249,171,0,.18)';
		var color, bg;

		if (look.kind == 'unavailable') {
			color = look.color;
			bg = look.bg;
		}
		else if (look.kind == 'unknown') {
			/* 未知保持灰色；有 reasons 只展开原因，不把整块染红。 */
			color = look.color;
			bg = look.bg;
		}
		else if (look.kind == 'degraded' || reasons.length > 0) {
			color = warnColor;
			bg = warnBg;
		}
		else {
			color = look.color;
			bg = look.bg;
		}

		this.healthBox.style.borderLeftColor = color;
		this.healthBox.style.background = bg;
		this.healthLabel.style.color = color;
		this.healthLabel.textContent = (look.kind == 'exact' && reasons.length > 0)
			? look.label + _('（有异常）')
			: look.label;

		dom.content(this.healthReasons, reasons.length
			? reasons.map(function(reason) { return E('div', {}, '· ' + reason); })
			: E('span', {}, look.kind == 'exact' ? _('无异常') : '—'));
	},

	/*
	 * 顶部提示里的「状态类」补充：daemon 未运行 / state 冻结。
	 * 与刷新失败等既有文案用「；」拼接，互不覆盖。
	 */
	statusNotes: function() {
		var out = [];
		var state = this.state;
		var ts, age;

		if (state == null || typeof state != 'object') return out;

		if (state.running === false) out.push(_('prism-routerd 未运行'));

		ts = num(state.ts);
		age = nowSec() - ts;

		if (ts > 0 && age > STALE_STATE_SEC)
			out.push(_('数据已') + ' ' + fmtSpan(age) + _('未更新'));

		return out;
	},

	syncNotice: function(message) {
		var parts = [];
		var text = ('' + (message == null ? '' : message)).replace(/^\s+|\s+$/g, '');
		var notes = this.statusNotes();
		var out, i;

		if (text.length) parts.push(text);
		for (i = 0; i < notes.length; i++) parts.push(notes[i]);

		out = parts.join('；');

		this.noticeNode.textContent = out;
		this.noticeNode.style.display = out.length ? 'block' : 'none';
	},

	/* 没有数据时把每个区块都填成占位符，绝不留白屏。 */
	syncUnavailable: function(reason, expired) {
		var msg = ('' + (reason == null ? '' : reason)).replace(/^\s+|\s+$/g, '');
		var head = msg.length
			? (_('暂无数据') + '：' + msg)
			: _('暂无数据：后端 prism-router.get_state 不可用，或 prism-routerd 尚未写入 state.json。');

		this.setUpdated(0);

		/* 首屏没数据：概览铺 6 个数字块骨架，数据到了由 syncOverview 清掉 */
		this.syncOverviewSkeleton(true);

		if (this.txNum != null) this.txNum.textContent = '—';
		if (this.rxNum != null) this.rxNum.textContent = '—';
		if (this.exitName != null) this.exitName.textContent = '—';
		if (this.exitBadge != null) this.exitBadge.style.display = 'none';
		if (this.devPill != null) this.devPill.textContent = '—';

		this.totalValue.textContent = '-';
		this.totalSub.textContent = '';
		this.wifiValue.textContent = '-';
		this.wifiSub.textContent = '';
		this.wiredValue.textContent = '-';
		this.wiredSub.textContent = '';
		this.unknownValue.textContent = '-';
		this.unknownSub.textContent = '';
		this.proxyValue.textContent = '-';
		this.proxySub.textContent = '';
		this.directValue.textContent = '-';
		this.directSub.textContent = '';

		this.devSig = null;
		this.appSig = null;

		/* 设备屏 / 节点屏也不能留白屏：设备列表清空，节点屏按已知数据（可能为空态）渲染 */
		if (this.devicesBox != null) this.syncDevicePage([]);

		this.syncNodePage();

		/* 拓扑屏没有 state 就只给「暂无数据」，不猜测任何层级 */
		this.syncTopoEmpty();

		this.syncHealth({ accounting_confidence: 'unavailable', reasons: [] });
		this.syncNotice((expired === true) ? (_('快照已过期') + '；' + head) : head);
	},

	setBusy: function(busy) {
		if (this.refreshBtn == null) return;

		this.refreshBtn.disabled = (busy === true);
		this.refreshBtn.textContent = (busy === true) ? _('刷新中…') : _('刷新');
	},

	// ------------------------------------------------------------ 离线快照

	/* 成功一次就覆盖快照：永远是「最近一次成功的数据」。 */
	persistSnapshot: function(state) {
		if (state == null || typeof state != 'object') return false;

		return writeSnapshot(state);
	},

	/* 读快照：过期 / 损坏 / 存储不可用都返回 null（readSnapshot 内部已清理过脏数据）。 */
	restoreSnapshot: function() {
		var snap = readSnapshot();

		if (snap == null) return null;

		if (snap.expired === true) {
			this.snapshotExpired = true;

			return null;
		}

		this.snapshotExpired = false;

		return snap;
	},

	/* 显示离线条：「离线数据 · 更新于 HH:MM（N 分钟前）」+ 重试 */
	showOfflineBar: function(info) {
		var snap = (info != null && typeof info == 'object') ? info : {};

		this.offlineInfo = snap;

		if (this.offlineTextNode != null)
			this.offlineTextNode.textContent = offlineText(snap.ts, nowSec());

		if (this.offlineBar != null) this.offlineBar.style.display = 'flex';

		/* 顶部 tab 的 sticky top 靠这个 class 顺次下移，提示条不会盖住内容 */
		this.toggleClass(this.root, 'tsm-offline-on', true);
	},

	/* 刷新失败但页面上还有上次成功的数据：时间取数据自己的 ts，没有可信 ts 就不摆条。 */
	showStaleBar: function() {
		var ts = num(this.state != null ? this.state.ts : 0);

		if (!(ts > 0)) return;

		this.showOfflineBar({ ts: ts, state: this.state });
	},

	hideOfflineBar: function() {
		this.offlineInfo = null;

		if (this.offlineBar != null) this.offlineBar.style.display = 'none';

		this.toggleClass(this.root, 'tsm-offline-on', false);
	},

	/* 手动重试：调 refresh(true)，失败不计数（用户已经知道在离线）。 */
	retryOffline: function() {
		return this.refresh(true);
	},

	/*
	 * 连续失败计数：自动轮询失败 3 次就停表（手机上省电），
	 * 手动「重试 / 刷新」随时可用，任何一次成功后自动把轮询接回来。
	 */
	noteOfflineFailure: function() {
		this.offlineFails = num(this.offlineFails) + 1;

		if (this.offlineFails < OFFLINE_GIVEUP_FAILS) return this.offlineFails;

		this.offlineGivenUp = true;
		this.stopRefresh();

		return this.offlineFails;
	},

	/*
	 * 网络恢复：清掉离线条并立刻重拉一次；被停表的顺手把轮询接回来。
	 * 监听只挂一次，页面被替换后由 handleOnline 自己摘掉。
	 */
	bindOnline: function() {
		var self = this;

		if (typeof window.addEventListener != 'function') return;

		this.unbindOnline();

		this.onlineFn = function() { return self.handleOnline(); };

		window.addEventListener('online', this.onlineFn);
	},

	unbindOnline: function() {
		if (this.onlineFn == null || typeof window.removeEventListener != 'function') return;

		window.removeEventListener('online', this.onlineFn);
		this.onlineFn = null;
	},

	handleOnline: function() {
		/* #view 被整体替换后 root 不在文档里：顺手摘掉监听，避免旧实例继续跑 */
		if (this.root == null || (typeof document != 'undefined' && document.body != null &&
			typeof document.body.contains == 'function' && !document.body.contains(this.root))) {
			this.unbindOnline();

			return null;
		}

		this.offlineFails = 0;
		this.offlineGivenUp = false;
		this.hideOfflineBar();

		if (this.timer == null) this.startRefresh();

		return this.refresh(true);
	},

	// ------------------------------------------------------------ 刷新

	refresh: function(manual) {
		var self = this;
		var nodePage, wantNodeData, jobs;

		if (this.refreshing === true) return Promise.resolve();

		this.refreshing = true;

		/* 手动刷新等于「我现在就想再试一次」：清掉连续失败计数，成功后轮询自动恢复。 */
		if (manual === true) {
			this.offlineFails = 0;
			this.offlineGivenUp = false;
			this.setBusy(true);
		}

		/*
		 * get_state 始终刷新；节点 / AP 上报只在「当前屏是节点或拓扑且已经懒加载过」
		 * 时顺带刷新，避免首屏和其它屏每次轮询都多打两个 RPC。
		 */
		nodePage = (this.pageIndex === 2 || this.pageIndex === 3);
		wantNodeData = nodePage && (this.nodeDataLoaded === true);

		/* 当前屏需要但还没加载过（例如直接落在节点屏）：补一次懒加载，不阻塞 state 刷新。 */
		if (nodePage && this.nodeDataLoaded !== true) this.ensureNodeData();

		jobs = [
			callState().then(function(state) {
				return { ok: true, state: state };
			}, function(err) {
				return { ok: false, err: err };
			})
		];

		if (wantNodeData) {
			jobs.push(callNodes().then(function(res) {
				return { ok: true, res: res };
			}, function(err) {
				return { ok: false, err: err };
			}));
			jobs.push(callStations().then(function(res) {
				return { ok: true, res: res };
			}, function(err) {
				return { ok: false, err: err };
			}));
		}

		return Promise.all(jobs).then(function(res) {
			var state = res[0];

			if (wantNodeData) {
				self.applyNodes(res[1]);
				self.applyStations(res[2]);
			}

			if (state.ok === true && state.state != null &&
				typeof state.state == 'object' && state.state.totals != null) {
				self.state = state.state;
				self.error = null;

				/* 成功一次：覆盖快照、清掉离线标记与失败计数，被停掉的轮询接回来。 */
				self.persistSnapshot(state.state);
				self.offlineFails = 0;
				self.offlineGivenUp = false;
				self.snapshotExpired = false;
				self.hideOfflineBar();
				self.syncAll(state.state);
				self.syncNotice('');
				self.syncOfflineData();

				if (self.timer == null) self.startRefresh();
			}
			else if (state.ok === true) {
				self.syncUnavailable(_('后端返回了空数据'));
			}
			else {
				self.error = (state.err != null && state.err.message) ? state.err.message : '' + state.err;

				self.applyRefreshFailure(manual);
			}
		}).catch(function(err) {
			self.error = (err != null && err.message) ? err.message : '' + err;

			self.applyRefreshFailure(manual);
		}).then(function() {
			self.refreshing = false;

			if (manual === true) self.setBusy(false);
		});
	},

	/*
	 * 刷新失败的统一处理：
	 *   - 已经有数据（含离线快照）→ 只提示「刷新失败」，页面不清空；
	 *   - 一点数据都没有 → 先试离线快照，再退到占位符；
	 *   - 自动轮询连续失败 3 次 → 停表省电，等用户手动重试或网络恢复。
	 */
	applyRefreshFailure: function(manual) {
		var snap;

		if (this.state != null) {
			this.syncNotice(_('刷新失败') + '：' + this.error);

			/* 页面上的数字仍是"上次成功"的：把离线条摆出来，恢复后自动收起 */
			this.showStaleBar();
		}
		else {
			snap = this.restoreSnapshot();

			if (snap != null) {
				this.state = snap.state;
				this.offlineInfo = snap;
				this.syncAll(this.state);
				this.syncNotice('');
				this.showOfflineBar(snap);
			}
			else {
				this.syncUnavailable(this.error, this.snapshotExpired === true);
			}
		}

		/* 只有自动轮询才计数：手动重试是用户主动行为，不该被「3 次」挡住。 */
		if (manual !== true) this.noteOfflineFailure();
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
	/*
	 * PWA 的 manifest/图标路径：
	 *   - 优先用 LuCI 的 L.resource('prism-router/...')，它按当前 LuCI 静态资源
	 *     根生成地址（反向代理在子路径下也正确）；
	 *   - L.resource 不可用时退回 `/luci-static/...`，这是**根部署**（LuCI 在
	 *     /cgi-bin/luci、静态资源在 /luci-static）的约定；子路径部署需要反代
	 *     把 /luci-static 也映射到同一根，manifest.json 里的图标/start_url 同样
	 *     按根部署写死。
	 */
	pwaAsset: function(name) {
		try {
			var url = L.resource('prism-router/' + name);

			if (url) return '' + url;
		}
		catch (e) { /* 非浏览器/极老 LuCI 没有 L.resource */ }

		return '/luci-static/resources/prism-router/' + name;
	},

	/* PWA 头信息：manifest + 主屏图标 + 主题色（只注入一次） */
	injectPwaHead: function() {
		/* Argon 主题自己带了一个 manifest（指向整个 LuCI），会把本页的安装入口抢走。
		   这里改用本应用的 manifest：装到主屏后直接打开「手机版」而不是 LuCI 首页。
		   注意 LuCI 是单页应用，head 的改动会保留到本会话结束（刷新即恢复）。 */
		[].forEach.call(document.querySelectorAll('link[rel="manifest"]'), function(n) {
			n.parentNode.removeChild(n);
		});
		[].forEach.call(document.querySelectorAll('meta[name="theme-color"]'), function(n) {
			n.parentNode.removeChild(n);
		});

		/* 安全区：复用（改写）主题已有的 viewport，绝不新增第二个 */
		this.ensureViewportCover();

		document.title = _('棱镜路由');

		var items = [
			E('link', { rel: 'manifest', href: this.pwaAsset('manifest.json') }),
			E('link', { rel: 'apple-touch-icon', href: this.pwaAsset('icon-192.png') }),
			E('link', { rel: 'icon', type: 'image/png', href: this.pwaAsset('icon-192.png') }),
			E('meta', { name: 'theme-color', content: '#4a6fe3' }),
			E('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }),
			E('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }),
			E('meta', { name: 'apple-mobile-web-app-title', content: '棱镜路由' })
		];

		items.forEach(function(el) { document.head.appendChild(el); });
	},

	/*
	 * 安全区（刘海 / 底部横条）的前提是 viewport 带 viewport-fit=cover。
	 * 主题通常已经注入了一个 viewport：这里只改写它的 content，绝不再加第二个
	 * （浏览器只认第一个 viewport，多写一个等于没生效）。
	 */
	ensureViewportCover: function() {
		var list = [];
		var meta = null;
		var content = '';
		var next;

		try { list = document.querySelectorAll('meta[name="viewport"]') || []; }
		catch (e) { list = []; }

		if (list.length) meta = list[0];

		if (meta == null) {
			meta = E('meta', {
				name: 'viewport',
				content: 'width=device-width, initial-scale=1, viewport-fit=cover'
			});
			document.head.appendChild(meta);

			return meta;
		}

		try { content = '' + (meta.getAttribute('content') || ''); }
		catch (e) { content = ''; }

		if (content.indexOf('viewport-fit=cover') >= 0) return meta;

		next = content.length
			? (content.replace(/^\s+|\s+$/g, '') + ',viewport-fit=cover')
			: 'width=device-width, initial-scale=1, viewport-fit=cover';

		try { meta.setAttribute('content', next); }
		catch (e) { }

		return meta;
	},

	handleSaveApply: null,
	handleReset: null
});
