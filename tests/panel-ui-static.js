#!/usr/bin/env node
/*
 * 独立 8099 面板（index.html / style.css / app.js）静态 / 轻量测试
 * -------------------------------------------------------------------------
 * 不连路由器、不启动 8099 服务、不读任何令牌或凭据，只读仓库内三个前端文件：
 *   luci-app-prism-router/root/www/prism-router-panel/index.html
 *   luci-app-prism-router/root/www/prism-router-panel/style.css
 *   luci-app-prism-router/root/www/prism-router-panel/app.js
 *
 * 覆盖：
 *   1. 语法：app.js 能被 JS 引擎完整编译；style.css 花括号配对。
 *   2. 关键 id：摘要 / 趋势 / 健康 / 出口 / 设备 / 应用 / 告警 / 设置 / 家长控制 /
 *      底部导航 / “查看全部”按钮全部存在。
 *   3. DOM 引用：app.js cacheDom() 的每个 id 都真实存在；代码里每个 dom.xxx
 *      都能被 cacheDom 或显式赋值覆盖（防止重构后 null 引用）。
 *   4. 在线口径：真实时钟 + 600s；isOnline 在 vm 沙箱里按行为断言
 *      （近 10 分钟在线、未来偏差容忍、无 last_seen 的降级、state.ts 不作 now）。
 *   5. 文案：近 10 分钟；不得残留“近 3 分钟”；不得再引用已删除的 ALERT_OFFLINE_SEC。
 *   6. 颜色：下载蓝 / 上传青；浅色 #2f6bf4 / #0e7490，深色 #7aa2ff / #35d6e6；
 *      图表 tx 同色；状态绿橙红与速率色彼此独立。
 *   7. 响应式：760 / 480 / 390 / 360 断点；深色、对比度、焦点、reduced motion、
 *      44px 触控；小屏自动刷新短标签可见；空图高度 ≤ 120px。
 *   8. 结构：桌面驾驶舱顺序（hero → workspace → 设备/应用 → 告警/设置），
 *      移动底部锚点导航 4 项；无外部资源。
 *   9. 静态兜底：所有 HTML / JS 动态 class 都有 CSS 规则；无内联事件处理器。
 *  10. 第三阶段：≤760px 顶栏两行紧凑布局（高度预算 ≤100px、44px 触控、
 *      刷新/自动刷新标签不隐藏）；设置区改用原生 details 折叠分组，
 *      核心三组默认展开、功能开关/家长控制默认收起，原有动态内容不丢失。
 *
 * 运行：node tests/panel-ui-static.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PANEL = path.join(ROOT, 'luci-app-prism-router/root/www/prism-router-panel');
const INDEX = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PANEL, 'style.css'), 'utf8');
const APP = fs.readFileSync(path.join(PANEL, 'app.js'), 'utf8');

const NOW = 1800000000; /* 固定“现在”，让在线断言与真实时钟无关 */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
	if (condition) {
		passed += 1;
		console.log('  \u2713 ' + name);
		return;
	}
	failures.push({ name, detail });
	console.log('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

function group(title) {
	console.log('\n' + title);
}

function unique(list) {
	return Array.from(new Set(list));
}

/* ------------------------------------------------------------------ *
 * 1. 语法与基础
 * ------------------------------------------------------------------ */
group('1. 语法与基础');
try {
	new Function(APP); /* 只编译不执行：IIFE 内部不会被调用 */
	check('app.js 可被 JS 引擎完整编译', true);
} catch (e) {
	check('app.js 可被 JS 引擎完整编译', false, e.message);
}

const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
check('style.css 花括号配对',
	cssNoComments.split('{').length === cssNoComments.split('}').length,
	'{=' + cssNoComments.split('{').length + ' }=' + cssNoComments.split('}').length);

check('index.html 引入同源 style.css / app.js',
	/<link rel="stylesheet" href="style\.css">/.test(INDEX) && /<script src="app\.js"><\/script>/.test(INDEX));

const scripts = Array.from(INDEX.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g));
check('只有 app.js 一个脚本，无内联脚本',
	scripts.length === 1 && /src="app\.js"/.test(scripts[0][1]) && scripts[0][2].trim() === '');

check('无内联事件处理器（onclick 等）',
	!/\son[a-z]+\s*=\s*"/i.test(INDEX));

check('无外部资源引用（http/https/CDN/import）',
	!/https?:\/\//i.test(INDEX) && !/@import/i.test(CSS) && !/url\(\s*['"]?https?:/i.test(CSS));

check('viewport / color-scheme / 中文 lang',
	/<html lang="zh-CN">/.test(INDEX) &&
	/<meta name="viewport"[^>]*width=device-width/.test(INDEX) &&
	/<meta name="color-scheme" content="light dark">/.test(INDEX));

/* ------------------------------------------------------------------ *
 * 2. 关键 id
 * ------------------------------------------------------------------ */
group('2. 关键 id 与结构');
const htmlIds = Array.from(INDEX.matchAll(/\bid="([^"]+)"/g)).map(function (m) { return m[1]; });
const idSet = new Set(htmlIds);

const requiredIds = [
	'main', 'cards-title', 'speed-title', 'chart-title',
	'state-pill', 'confidence-pill', 'last-updated', 'refresh-btn', 'auto-refresh',
	'aria-live', 'error-bar', 'error-text', 'error-retry',
	'net-bar', 'net-text', 'net-retry', 'pull-hint', 'pull-hint-text',
	'auth-panel', 'auth-desc', 'auth-form', 'token-input', 'token-clear', 'auth-hint',
	'card-rx', 'card-rx-unit', 'card-rx-sub', 'card-tx', 'card-tx-unit', 'card-tx-sub',
	'card-today', 'card-today-sub', 'card-month', 'card-month-sub',
	'card-devices', 'card-devices-unit', 'card-devices-sub',
	'card-clash', 'card-clash-sub',
	'chart-window', 'chart-meta', 'rate-chart', 'chart-empty', 'chart-legend-note',
	'health-title', 'health-meta', 'health-sources', 'health-reasons',
	'nodes-title', 'nodes-meta', 'nodes-list', 'nodes-more',
	'devices-title', 'devices-meta', 'devices-body', 'devices-more',
	'apps-title', 'apps-meta', 'apps-body', 'apps-more',
	'alerts-title', 'alerts-meta', 'alerts-list',
	'settings-title', 'settings-meta', 'settings-body',
	'guard-modal', 'guard-backdrop', 'guard-dialog', 'guard-title', 'guard-target',
	'guard-desc', 'guard-error', 'guard-cancel', 'guard-confirm'
];
const missingIds = requiredIds.filter(function (id) { return !idSet.has(id); });
check('关键 id 全部存在（' + requiredIds.length + ' 项）', missingIds.length === 0, missingIds.join(', '));

check('速率是主卡：上下行 id 在 .speedcard 内',
	/<article class="speedcard"[\s\S]*?id="card-rx"[\s\S]*?id="card-tx"[\s\S]*?<\/article>/.test(INDEX));

check('四项摘要：今日 / 本月 / 在线 / Clash',
	['card-today', 'card-month', 'card-devices', 'card-clash'].every(function (id) {
		return INDEX.indexOf('id="' + id + '"') >= 0;
	}));
check('在线摘要文案为“近 10 分钟”', /近 10 分钟有活动/.test(INDEX));
check('已移除“近 3 分钟”旧口径', !/近 3 分钟/.test(INDEX) && !/近 3 分钟/.test(APP));

/* 桌面顺序：hero -> workspace（图表 + 右侧轨）-> 设备/应用 -> 告警/设置 */
const posHero = INDEX.indexOf('class="hero"');
const posWorkspace = INDEX.indexOf('class="workspace"');
const posTables = INDEX.indexOf('columns--tables');
const posBottom = INDEX.indexOf('columns--bottom');
check('驾驶舱顺序：摘要 → 主图/右侧轨 → 设备应用 → 告警设置',
	posHero > 0 && posWorkspace > posHero && posTables > posWorkspace && posBottom > posTables);

const railStart = INDEX.indexOf('<aside class="rail"');
const railEnd = INDEX.indexOf('</aside>', railStart);
const railHtml = railStart >= 0 ? INDEX.slice(railStart, railEnd) : '';
check('右侧轨同时包含“网络健康”和“出口节点”',
	/网络健康/.test(railHtml) && /出口节点/.test(railHtml) &&
	railHtml.indexOf('health-title') >= 0 && railHtml.indexOf('nodes-title') >= 0);

check('主图在 workspace 内、右侧轨排在其后',
	INDEX.indexOf('panel--chart') > posWorkspace && INDEX.indexOf('panel--chart') < railStart);

/* 底部锚点导航 */
const tabbarMatch = INDEX.match(/<nav class="tabbar"[\s\S]*?<\/nav>/);
check('底部导航存在且带 aria-label', !!tabbarMatch && /aria-label="面板分区导航"/.test(tabbarMatch[0]));
const tabKeys = tabbarMatch ? Array.from(tabbarMatch[0].matchAll(/data-tab="([^"]+)"/g)).map(function (m) { return m[1]; }) : [];
check('底部导航 4 个锚点：概览 / 设备 / 应用 / 设置',
	tabKeys.length === 4 && ['overview', 'devices', 'apps', 'settings'].every(function (k) { return tabKeys.indexOf(k) >= 0; }),
	tabKeys.join(','));
const tabHrefs = tabbarMatch ? Array.from(tabbarMatch[0].matchAll(/href="#([^"]+)"/g)).map(function (m) { return m[1]; }) : [];
check('底部导航锚点复用页面已有标题 id',
	tabHrefs.length === 4 && tabHrefs.every(function (id) { return idSet.has(id); }), tabHrefs.join(','));

/* ------------------------------------------------------------------ *
 * 3. DOM 引用：cacheDom 与 dom.xxx 一致
 * ------------------------------------------------------------------ */
group('3. DOM 引用与空引用防护');
const idsBlock = (APP.match(/var ids = \[([\s\S]*?)\];/) || [])[1] || '';
const cacheIds = unique(Array.from(idsBlock.matchAll(/'([a-z0-9-]+)'/g)).map(function (m) { return m[1]; }));
check('cacheDom 缓存了至少 60 个 id', cacheIds.length >= 60, String(cacheIds.length));
const cacheMissing = cacheIds.filter(function (id) { return !idSet.has(id); });
check('cacheDom 的每个 id 都真实存在于 index.html', cacheMissing.length === 0, cacheMissing.join(', '));

function camel(id) {
	return id.replace(/-([a-z0-9])/g, function (m, ch) { return ch.toUpperCase(); });
}
const cacheProps = new Set(cacheIds.map(camel));
const manualProps = new Set(['canvas', 'live', 'autoInput', 'topbar']); /* cacheDom 末尾显式赋值 */
const domRefs = unique(Array.from(APP.matchAll(/\bdom\.([a-zA-Z0-9_]+)/g)).map(function (m) { return m[1]; }));
const unknownRefs = domRefs.filter(function (name) {
	return !cacheProps.has(name) && !manualProps.has(name);
});
check('所有 dom.xxx 都有对应缓存/显式赋值（无 null 引用）', unknownRefs.length === 0, unknownRefs.join(', '));

const moreIds = ['devices-more', 'apps-more', 'nodes-more'];
check('“查看全部”按钮已被 cacheDom 缓存',
	moreIds.every(function (id) { return cacheIds.indexOf(id) >= 0; }));
check('“查看全部”按钮已绑定事件并驱动重渲染',
	/bindMore\(dom\.devicesMore,\s*'devices',\s*renderDevices\)/.test(APP) &&
	/bindMore\(dom\.appsMore,\s*'apps',\s*renderApps\)/.test(APP) &&
	/bindMore\(dom\.nodesMore,\s*'nodes',\s*renderNodes\)/.test(APP));

check('移动端预览条数与断点常量存在',
	/var COMPACT_MQ = '\(max-width: 760px\)'/.test(APP) &&
	/var DEVICE_PREVIEW = 3/.test(APP) &&
	/var APP_PREVIEW = 5/.test(APP) &&
	/var NODE_PREVIEW = 5/.test(APP) &&
	/var LIST_MAX = 50/.test(APP));
check('“查看全部”展开后仍可“收起”',
	/var hasOverflow = count > base/.test(APP) && /expanded \? '收起' : '查看全部'/.test(APP));
check('手机告警目标在折叠列表外时先展开再定位，找不到不假报已定位',
	/if \(missing && allDevices\.length > previewLimit\('devices', allDevices\.length\)\)/.test(APP) &&
	/app\.more\.devices = true;\s*renderDevices\(\);/.test(APP) &&
	/设备在当前列表之外，已展开可见列表/.test(APP));

/* ------------------------------------------------------------------ *
 * 4. 在线口径：真实时钟 + 600s
 * ------------------------------------------------------------------ */
group('4. 在线口径：真实时钟 / 600s / 未来偏差');
check('ONLINE_WINDOW = 600 秒', /var ONLINE_WINDOW = 600;/.test(APP));
check('FUTURE_SKEW = 60 秒', /var FUTURE_SKEW = 60;/.test(APP));
check('isOnline 用 nowSec() 作为“现在”，不把 state.ts 当 now',
	/var now = nowSec\(\);/.test(APP) && !/var now = toSec\(state && state\.ts\)/.test(APP));
check('已移除 ALERT_OFFLINE_SEC（避免未定义引用）', !/ALERT_OFFLINE_SEC/.test(APP));

const onlineSrcMatch = APP.match(/function isOnline\(dev, state\) \{([\s\S]*?)\n\t\}/);
const onlineSrc = onlineSrcMatch ? onlineSrcMatch[0] : '';
check('isOnline 函数存在', onlineSrc.length > 0);

if (onlineSrc) {
	const sandbox = {
		nowSec: function () { return NOW; },
		toSec: function (v) {
			const n = Number(v);
			return isFinite(n) ? (n > 1e11 ? Math.floor(n / 1000) : n) : 0;
		},
		n0: function (v) {
			const n = Number(v);
			return isFinite(n) ? n : 0;
		},
		ONLINE_WINDOW: 600,
		FUTURE_SKEW: 60,
		ALERT_STALE_SEC: 90
	};
	vm.createContext(sandbox);
	vm.runInContext(onlineSrc + '\n__isOnline = isOnline;', sandbox);
	const isOnline = sandbox.__isOnline;

	const cases = [
		['last_seen 59 秒前，无速率 → 在线', { last_seen: NOW - 59 }, {}, true],
		['last_seen 恰好 600 秒 → 在线', { last_seen: NOW - 600 }, {}, true],
		['last_seen 601 秒 → 离线', { last_seen: NOW - 601 }, {}, false],
		['last_seen 未来 60 秒（偏差内）→ 在线', { last_seen: NOW + 60 }, {}, true],
		['last_seen 未来 61 秒（超偏差）→ 离线', { last_seen: NOW + 61 }, {}, false],
		['无 last_seen、state 新鲜且仍有速率 → 在线',
			{ rx_rate: 1024 }, { ts: NOW - 30 }, true],
		['无 last_seen、state 新鲜但速率为 0 → 离线',
			{ rx_rate: 0, tx_rate: 0 }, { ts: NOW - 30 }, false],
		['无 last_seen、state 已陈旧（>90s）→ 离线',
			{ rx_rate: 1024 }, { ts: NOW - 120 }, false],
		/* 旧实现用 state.ts 当 now：state.ts 在未来会被误判离线；新实现应在线 */
		['state.ts 未来偏差 + last_seen 30 秒前 → 在线（真实时钟）',
			{ last_seen: NOW - 30 }, { ts: NOW + 3600 }, true],
		/* 旧实现只看速率：state 陈旧仍会算在线；新实现要求 state 新鲜 */
		['无 last_seen、state 陈旧但速率 > 0 → 离线（不再盲信速率）',
			{ rx_rate: 5000 }, { ts: NOW - 3600 }, false]
	];

	cases.forEach(function (item) {
		const dev = Object.assign({}, item[1]);
		const state = Object.assign({}, item[2]);
		let actual = null;
		try { actual = isOnline(dev, state); } catch (e) { actual = 'throw: ' + e.message; }
		check(item[0], actual === item[3], 'got ' + actual + ', want ' + item[3]);
	});
}

/* 告警中心的离线判定同样走 ONLINE_WINDOW / FUTURE_SKEW，不再误报无 last_seen 的设备 */
check('离线告警跳过无 last_seen 与未来偏差设备',
	/if \(!\(seen > 0\)\) return;/.test(APP) &&
	/if \(seen > now \+ FUTURE_SKEW\) return;/.test(APP) &&
	/if \(now - seen <= ONLINE_WINDOW\) return;/.test(APP));
check('在线摘要文案为“近 10 分钟”', /近 10 分钟有活动的设备/.test(APP));

/* ------------------------------------------------------------------ *
 * 5. 颜色：下载蓝 / 上传青 / 状态绿橙红独立
 * ------------------------------------------------------------------ */
group('5. 颜色与对比度');
function cssVar(name) {
	const re = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,8})\\s*;', 'g');
	return Array.from(CSS.matchAll(re)).map(function (m) { return m[1].toLowerCase(); });
}
const rxVals = cssVar('rx');
const txVals = cssVar('tx');
check('浅色 --rx 下载蓝 = #2563eb', rxVals.indexOf('#2563eb') >= 0, rxVals.join(','));
check('浅色 --tx 上传青 = #0c6a84', txVals.indexOf('#0c6a84') >= 0, txVals.join(','));
check('深色 --rx = #7aa2ff', rxVals.indexOf('#7aa2ff') >= 0, rxVals.join(','));
check('深色 --tx = #35d6e6', txVals.indexOf('#35d6e6') >= 0, txVals.join(','));
const txIsNotOrange = txVals.every(function (v) { return ['#e8792b', '#f0a15c'].indexOf(v) < 0; });
check('上传不再是橙色（#e8792b / #f0a15c）', txIsNotOrange, txVals.join(','));

check('图表曲线 tx 与上传青一致（浅色 #0c6a84 / 深色 #35d6e6）',
	/tx: '#0c6a84'/.test(APP) && /tx: '#35d6e6'/.test(APP));
check('图表 rx 保持下载蓝', /rx: '#2563eb'/.test(APP) && /rx: '#7aa2ff'/.test(APP));

const okVals = cssVar('ok');
const warnVals = cssVar('warn');
const dangerVals = cssVar('danger');
const accentVals = cssVar('accent');
check('状态绿 / 橙 / 红三套值均定义', okVals.length > 0 && warnVals.length > 0 && dangerVals.length > 0);
const statusVals = new Set(okVals.concat(warnVals, dangerVals));
const speedVals = new Set(rxVals.concat(txVals));
const overlap = Array.from(statusVals).filter(function (v) { return speedVals.has(v); });
check('速率色与状态色彼此独立（无重叠）', overlap.length === 0, overlap.join(','));

/* WCAG 2.x 相对亮度 / 对比度：确保浅色与深色的正文、弱化文字、速率与状态色可读。 */
function srgbToLinear(channel) {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
	const h = hex.replace('#', '');
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrast(a, b) {
	const la = luminance(a);
	const lb = luminance(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}
function blendOn(fg, bg, alpha) {
	const f = fg.replace('#', '');
	const b = bg.replace('#', '');
	let out = '#';
	for (let i = 0; i < 6; i += 2) {
		const c = Math.round(parseInt(f.slice(i, i + 2), 16) * alpha +
			parseInt(b.slice(i, i + 2), 16) * (1 - alpha));
		out += (c < 16 ? '0' : '') + c.toString(16);
	}
	return out;
}

const light = {
	panel: '#ffffff', panel2: '#f5f8ff',
	text: '#0b1524', soft: '#334155', muted: '#5b6b82',
	rx: rxVals[0], tx: txVals[0],
	ok: okVals[0], warn: warnVals[0], danger: dangerVals[0],
	accent: accentVals[0]
};
const dark = {
	panel: '#0e1626',
	text: '#e8eefc', soft: '#c2cee4', muted: '#8595b2',
	rx: rxVals[1], tx: txVals[1],
	ok: okVals[1], warn: warnVals[1], danger: dangerVals[1],
	accent: accentVals[1]
};

check('浅色正文对比度 ≥ 7:1', contrast(light.text, light.panel) >= 7, contrast(light.text, light.panel).toFixed(2));
check('浅色弱化文字对比度 ≥ 4.5:1', contrast(light.muted, light.panel) >= 4.5, contrast(light.muted, light.panel).toFixed(2));
[['rx', 0.16], ['tx', 0.16]].forEach(function (pair) {
	check('浅色 ' + pair[0] + ' 在卡片底色上 ≥ 4.5:1',
		contrast(light[pair[0]], light.panel2) >= 4.5,
		contrast(light[pair[0]], light.panel2).toFixed(2));
});
[['ok', 0.13], ['warn', 0.14], ['danger', 0.11], ['accent', 0.12]].forEach(function (pair) {
	const key = pair[0];
	check('浅色 ' + key + ' 在自身浅底上 ≥ 4.5:1',
		contrast(light[key], blendOn(light[key], '#ffffff', pair[1])) >= 4.5,
		contrast(light[key], blendOn(light[key], '#ffffff', pair[1])).toFixed(2));
});
check('深色正文对比度 ≥ 7:1', contrast(dark.text, dark.panel) >= 7, contrast(dark.text, dark.panel).toFixed(2));
check('深色弱化文字对比度 ≥ 4.5:1', contrast(dark.muted, dark.panel) >= 4.5, contrast(dark.muted, dark.panel).toFixed(2));
['rx', 'tx', 'ok', 'warn', 'danger', 'accent'].forEach(function (key) {
	check('深色 ' + key + ' 在面板上 ≥ 4.5:1',
		contrast(dark[key], dark.panel) >= 4.5,
		contrast(dark[key], dark.panel).toFixed(2));
});

check('浅色 / 深色两套主题均定义',
	/@media \(prefers-color-scheme: dark\)/.test(CSS) &&
	cssVar('bg').length >= 2 && cssVar('panel').length >= 2);

/* ------------------------------------------------------------------ *
 * 6. 响应式与可访问性
 * ------------------------------------------------------------------ */
group('6. 响应式 / 可访问性 / 动效');
[760, 480, 390, 360].forEach(function (bp) {
	check('存在 ' + bp + 'px 断点', new RegExp('@media \\(max-width: ' + bp + 'px\\)').test(CSS));
});

check('移动端显示底部导航（默认隐藏）', /\.tabbar \{ display: none; \}/.test(CSS) &&
	/@media \(max-width: 760px\)[\s\S]*?\.tabbar \{[\s\S]*?position: fixed/.test(CSS));
check('移动端预留底部安全区', /padding-bottom: calc\(70px \+ env\(safe-area-inset-bottom/.test(CSS));

check('焦点可见样式存在', /:focus-visible \{[\s\S]*?outline: 3px solid var\(--accent\)/.test(CSS));
check('reduced motion 关闭动画与过渡',
	/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: \.001ms !important[\s\S]*?transition-duration: \.001ms !important/.test(CSS));
check('44px 触控目标规则存在（移动端）',
	(countOccurrences(CSS, 'min-height: 44px') >= 5), String(countOccurrences(CSS, 'min-height: 44px')));

function countOccurrences(text, needle) {
	return text.split(needle).length - 1;
}

/* 小屏自动刷新标签必须可见：短标签显示、长标签隐藏，不能整块隐藏 */
const pos480 = CSS.indexOf('@media (max-width: 480px)');
const switchShortInline = CSS.indexOf('.switch__label-short { display: inline; }');
const switchLongNone = CSS.indexOf('.switch__label-long { display: none; }');
check('≤480px 显示自动刷新短标签',
	pos480 >= 0 && switchShortInline > pos480 && switchLongNone > pos480);
check('不存在把整块 .switch__label 隐藏的规则',
	!/\.switch__label\s*\{[^}]*display:\s*none/.test(CSS));

/* 空图高度 ≤ 120px */
const emptyBlocks = Array.from(CSS.matchAll(/\.chart\.is-empty\s*\{([^}]*)\}/g)).map(function (m) { return m[1]; });
const emptyHeights = [];
emptyBlocks.forEach(function (body) {
	const m = body.match(/(?:^|[\s;])height:\s*(\d+)px/);
	if (m) emptyHeights.push(Number(m[1]));
});
check('空图高度规则存在', emptyHeights.length > 0, String(emptyHeights.length));
check('空图高度全部 ≤ 120px', emptyHeights.length > 0 && emptyHeights.every(function (h) { return h <= 120; }),
	emptyHeights.join(','));
check('空图状态由 app.js 切换 .is-empty', /classList\.toggle\('is-empty', !hasData\)/.test(APP));

/* 深色模式下重点文字使用主题变量，而非写死黑色 */
check('正文与弱化文字走主题变量',
	/--text:\s*#0b1524/.test(CSS) && /--text-soft:\s*#334155/.test(CSS) &&
	/--text:\s*#e8eefc/.test(CSS) && /--text-soft:\s*#c2cee4/.test(CSS));

/* 可访问性 */
check('跳转主内容链接存在', /class="skip-link" href="#main"/.test(INDEX) && /id="main"/.test(INDEX));
check('aria-live 状态播报存在', /id="aria-live"[\s\S]*?aria-live="polite"/.test(INDEX));
check('图表 canvas 具有 role=img 与 aria-label',
	/<canvas id="rate-chart"[^>]*role="img"[^>]*aria-label="/.test(INDEX));
check('健康告警列表可聚焦并带区域语义',
	/id="health-reasons"[^>]*role="region"[^>]*tabindex="0"/.test(INDEX));
check('表格滚动区可聚焦并带 aria-label',
	/class="table-scroll" tabindex="0" role="region" aria-label="/.test(INDEX));

/* ------------------------------------------------------------------ *
 * 7. 家长控制逻辑保留
 * ------------------------------------------------------------------ */
group('7. 家长控制逻辑保留');
check('家长控制确认框结构完整',
	/guard-modal/.test(INDEX) && /role="dialog"/.test(INDEX) && /aria-modal="true"/.test(INDEX));
check('app.js 保留暂停 / 恢复流程',
	/function openGuardModal\(/.test(APP) && /function runGuardAction\(/.test(APP) &&
	/function onGuardConfirm\(/.test(APP) && /function setGuardButton\(/.test(APP));
check('设备行仍按开关渲染暂停按钮',
	/guardEnabled\(\) && normMac\(dev\.mac\)/.test(APP) && /onGuardClick/.test(APP));
check('写接口仍为 POST + JSON（令牌在 body）',
	/method: 'POST'/.test(APP) && /body: JSON\.stringify\(payload\)/.test(APP) &&
	/CONTROL_BASE/.test(APP));

/* ------------------------------------------------------------------ *
 * 8. class 覆盖：避免重构后组件没有样式
 * ------------------------------------------------------------------ */
group('8. class 覆盖与 CSS 完整性');
const htmlClasses = unique(Array.from(INDEX.matchAll(/class="([^"]+)"/g)).reduce(function (out, m) {
	return out.concat(m[1].split(/\s+/));
}, []).filter(Boolean));
const jsClasses = unique(Array.from(APP.matchAll(/el\('[a-z0-9]+',\s*'([^']+)'/g)).reduce(function (out, m) {
	return out.concat(m[1].split(/\s+/));
}, []).filter(Boolean));
const toggleClasses = Array.from(APP.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g))
	.map(function (m) { return m[1]; });

const missingHtmlCss = htmlClasses.filter(function (c) { return CSS.indexOf('.' + c) < 0; });
const missingJsCss = jsClasses.concat(toggleClasses).filter(function (c) {
	return !c.endsWith('--') && CSS.indexOf('.' + c) < 0;
});
check('HTML 中每个 class 都有 CSS 规则', missingHtmlCss.length === 0, missingHtmlCss.join(', '));
check('app.js 动态 class 都有 CSS 规则', missingJsCss.length === 0, unique(missingJsCss).join(', '));

check('表格在 ≤760px 转为卡片（data-label 标签）',
	/\.dtable > tbody > tr > td\[data-label\]::before/.test(CSS) &&
	/content: attr\(data-label\)/.test(CSS));
check('嵌套 .mini-table 不被移动端卡片规则拆散',
	/\.dtable > tbody > tr > td \{/.test(CSS) && /\.mini-table \{ table-layout: fixed/.test(CSS));

/* ------------------------------------------------------------------ *
 * 9. 第三阶段：移动顶栏两行紧凑布局 + 设置 details 折叠
 * ------------------------------------------------------------------ */
group('9. 移动顶栏与设置折叠（第三阶段）');

/* 截取一个 CSS 规则体（选择器精确匹配 "选择器 {"，按花括号配对）。 */
function blockBody(selector, source) {
	const at = source.indexOf(selector + ' {');
	if (at < 0) return '';
	const start = source.indexOf('{', at);
	let depth = 0;
	for (let i = start; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start + 1, i);
		}
	}
	return '';
}

/* 截取第一个匹配 @media 头部的完整媒体块。 */
function mediaBlock(header) {
	const at = CSS.indexOf(header);
	if (at < 0) return '';
	const start = CSS.indexOf('{', at);
	let depth = 0;
	for (let i = start; i < CSS.length; i += 1) {
		if (CSS[i] === '{') depth += 1;
		else if (CSS[i] === '}') {
			depth -= 1;
			if (depth === 0) return CSS.slice(start + 1, i);
		}
	}
	return '';
}

const mq760 = mediaBlock('@media (max-width: 760px)');
const mobileTopbarInner = blockBody('.topbar__inner', mq760);

check('≤760 顶栏为两行网格（品牌/操作 + 状态）',
	/grid-template-areas:[\s\S]*?"brand actions"[\s\S]*?"status status"/.test(mobileTopbarInner),
	mobileTopbarInner.slice(0, 100));
check('品牌 / 状态 / 操作分别落在网格区',
	/\.topbar__brand \{[\s\S]*?grid-area: brand/.test(mq760) &&
	/\.topbar__status \{[\s\S]*?grid-area: status/.test(mq760) &&
	/\.topbar__actions \{[\s\S]*?grid-area: actions/.test(mq760));

/* 高度预算：44px 操作行 + 24px 状态行 + 2px 行距 + 6/7px 内边距 + 1px 边框 */
const topbarBudget = 44 + 24 + 2 + 6 + 7 + 1;
check('移动顶栏高度预算 ≤100px（' + topbarBudget + 'px）',
	topbarBudget <= 100 &&
	/padding: 6px max\(12px, env\(safe-area-inset-right, 0px\)\) 7px/.test(mobileTopbarInner) &&
	/gap: 2px 8px/.test(mobileTopbarInner) &&
	/\.btn \{ min-height: 44px; \}/.test(mq760) &&
	/\.switch \{ min-height: 44px; \}/.test(mq760) &&
	/\.pill \{ min-height: 24px;/.test(mq760));

check('移动端操作区不再整行占宽（避免第三行）',
	/\.topbar__actions \{[\s\S]*?width: auto/.test(mq760) &&
	/\.topbar__actions \{[\s\S]*?justify-content: flex-end/.test(mq760));
check('移动端品牌主标题保留，副标题 / 后缀压缩隐藏',
	/class="brand__name">棱镜路由</.test(INDEX) &&
	/\.brand__suffix \{ display: none; \}/.test(mq760) &&
	/\.brand__sub \{ display: none; \}/.test(mq760));
check('刷新文字与自动刷新标签在移动端不隐藏',
	!/\.btn__label\s*\{[^}]*display:\s*none/.test(CSS) &&
	!/\.switch__label\s*\{[^}]*display:\s*none/.test(CSS) &&
	/\.switch__label-short \{ display: inline; \}/.test(CSS));
check('移动端顶栏触控目标 ≥44px',
	/\.topbar__actions \.btn--icon/.test(mq760) &&
	/margin-left: 0/.test(blockBody('.topbar__status', mq760)) &&
	/\.btn \{ min-height: 44px; \}/.test(mq760) &&
	/\.switch \{ min-height: 44px; \}/.test(mq760));

/* 操作区必须是 topbar__status 的兄弟节点：移动端两行网格依赖这一点。 */
const statusStart = INDEX.indexOf('<div class="topbar__status">');
const actionsStart = INDEX.indexOf('<div class="topbar__actions">');
const statusSlice = (statusStart >= 0 && actionsStart > statusStart)
	? INDEX.slice(statusStart, actionsStart) : '';
const statusDivOpen = (statusSlice.match(/<div\b/g) || []).length;
const statusDivClose = (statusSlice.match(/<\/div>/g) || []).length;
check('顶栏操作区为直属子元素（状态行已闭合）',
	statusDivOpen >= 1 && statusDivOpen === statusDivClose,
	statusDivOpen + '/' + statusDivClose);

/* 桌面：10px 上下内边距 + 40px 操作高度 + 1px 边框 ≈ 61px，仍约 64px。 */
const desktopTopbarInner = blockBody('.topbar__inner', CSS);
const desktopBudget = 10 + 40 + 10 + 1;
check('桌面顶栏保持约 64px（' + desktopBudget + 'px）',
	Math.abs(desktopBudget - 64) <= 4 &&
	/padding: 10px clamp\(12px, 3vw, 28px\)/.test(desktopTopbarInner) &&
	/min-height: 40px/.test(blockBody('.btn', CSS)) &&
	/min-height: 40px/.test(blockBody('.switch', CSS)));

/* 设置区：原生 details 分组 */
check('设置区由原生 details / summary 动态生成',
	/function settingsDetails\(/.test(APP) &&
	/el\('details'/.test(APP) &&
	/el\('summary', 'settings-group__summary'\)/.test(APP) &&
	/details\.open = true/.test(APP));

const renderSettingsSrc = APP.slice(
	APP.indexOf('function renderSettings('),
	APP.indexOf('function loadSettings(')
);
const settingsOrder = [
	'settingsStatusGroup(write)',
	"settingsGroup('采集与保留'",
	"settingsGroup('面板服务'",
	"settingsGroup('功能开关'",
	'guardSettingsGroup()'
].map(function (needle) { return renderSettingsSrc.indexOf(needle); });
check('renderSettings 顺序：当前状态 → 采集 → 面板 → 功能 → 家长',
	settingsOrder.every(function (pos, idx) {
		return pos >= 0 && (idx === 0 || pos > settingsOrder[idx - 1]);
	}), settingsOrder.join(','));

check('核心三组默认展开：当前状态 / 采集与保留 / 面板服务',
	/settingsDetails\('当前状态', true/.test(APP) &&
	/settingsGroup\('采集与保留',[\s\S]*?\], true\)/.test(APP) &&
	/settingsGroup\('面板服务',[\s\S]*?\], true\)/.test(APP));
check('高级两组默认收起：功能开关 / 家长控制详细说明',
	/settingsGroup\('功能开关',[\s\S]*?\], false, true\)/.test(APP) &&
	/settingsDetails\('家长控制', false, chip, true\)/.test(APP));
check('家长控制状态同时保留在 summary 与展开内容中',
	/guard__status/.test(APP) && /guard__meta/.test(APP) &&
	/head\.appendChild\(el\('span', 'guard__label', '当前状态'\)\)/.test(APP));

check('settings-body 原有动态内容未丢失',
	['轮询间隔', '历史保留天数', '日文件保留', '面板端口', '绑定地址', '是否设置令牌',
		'飞书', '副节点', 'AP上报', '旧版兼容', '写操作未开放', 'GUARD_DESC'].every(function (text) {
		return APP.indexOf(text) >= 0;
	}));
check('设置仍清空 #settings-body 后动态插入分组与错误盒',
	/clear\(body\);/.test(renderSettingsSrc) &&
	(renderSettingsSrc.match(/body\.appendChild\(/g) || []).length >= 5 &&
	/settingsErrorBox\(\)/.test(renderSettingsSrc));
check('设置分组记住用户开合，自动刷新不重置',
	/settingsOpen: \{\}/.test(APP) &&
	/hasOwnProperty\.call\(app\.settingsOpen, title\)/.test(APP) &&
	/details\.addEventListener\('toggle',/.test(APP) &&
	/app\.settingsOpen\[title\] = details\.open === true/.test(APP));
check('原有设置 id 与 guard 提示 id 未变',
	idSet.has('settings-body') && idSet.has('settings-title') && idSet.has('settings-meta') &&
	idSet.has('guard-modal') && idSet.has('guard-error'));

check('details 分组样式 / 折叠标记 / 焦点可见齐全',
	/\.settings-group \{/.test(CSS) &&
	/\.settings-group__summary \{/.test(CSS) &&
	/\.settings-group\[open\] > \.settings-group__summary::before/.test(CSS) &&
	/\.settings-group__summary:focus-visible \{[\s\S]*?outline: 3px solid var\(--accent\)/.test(CSS));
check('桌面设置两列；收起的长分组并排、展开后独占整行',
	/@media \(min-width: 761px\)[\s\S]*?\.settings \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(CSS) &&
	/\.settings-group--wide\[open\] \{ grid-column: 1 \/ -1; \}/.test(CSS) &&
	/\.settings-group--wide:not\(\[open\]\) \{ grid-column: auto; \}/.test(CSS));
check('移动端详情 summary 触控 ≥44px',
	/\.settings-group__summary \{ min-height: 44px;/.test(mq760));
check('详情过渡受 reduced motion 约束',
	/transition: transform \.15s ease/.test(CSS) &&
	/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: \.001ms !important/.test(CSS));
check('设置区与顶栏未使用 innerHTML 注入',
	!/\.innerHTML\s*=/.test(APP) && !/\.innerHTML\s*=/.test(INDEX));

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */
console.log('\n' + '-'.repeat(62));
if (failures.length === 0) {
	console.log('PASS  ' + passed + ' checks');
	process.exit(0);
}
console.log('FAIL  ' + passed + ' passed, ' + failures.length + ' failed');
failures.forEach(function (f) {
	console.log('  - ' + f.name + (f.detail ? ' [' + f.detail + ']' : ''));
});
process.exit(1);
