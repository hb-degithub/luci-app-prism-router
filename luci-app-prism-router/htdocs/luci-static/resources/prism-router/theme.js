'use strict';
'require baseclass';
/*
 * 棱镜路由 · 共享 LuCI 主题（无构建步骤，纯 JS 模块）
 *
 * 用法：
 *   'require prism-router/theme as theme'
 *
 *   this.root = E('div', { 'id': 'ts-overview', 'class': theme.CLASS }, [
 *       theme.style(),          // 共享 token + 基础组件（只挂在 .ts-prism 下）
 *       E('style', {}, CSS),    // 本页自己的规则（仍用 #ts-overview 作用域）
 *       ...
 *   ]);
 *
 * 约定（第一阶段 UI 改造）：
 *   - 方向色：下载 = 品牌蓝 #3B82F6（深色 #60A5FA），上传 = 青 #0891B2（深色 #22D3EE）。
 *     这两个色只表示方向，不用来表示“好/坏”。
 *   - 状态色：绿 / 橙 / 红只表示状态（正常 / 注意 / 失败），不用于方向或分类。
 *   - 分类色：无线紫、直连青绿、有线/未知中性灰；与方向、状态都不混用。
 *   - 文字对比度：*Text 变体是给正文/标签用的加深色（白底 ≥ 4.5:1），
 *     基色只用于填充、线条、圆点等非文字图形（≥ 3:1）。
 *   - 所有规则都限定在 .ts-prism（各页面根元素上的共享 class）内，
 *     不覆盖 LuCI 全局选择器（body / .cbi-* / #maincontent 等）。
 *   - 支持 prefers-reduced-motion / prefers-color-scheme；focus-visible 统一描边。
 *
 * 颜色对比度（相对本主题表面，WCAG 2.1）：
 *   浅色 #1D4ED8 on #FFFFFF = 6.7:1；#0E7490 on #FFFFFF = 5.4:1；
 *   #15803D on #FFFFFF = 5.0:1；#B45309 on #FFFFFF = 5.0:1；#B91C1C on #FFFFFF = 6.5:1。
 *   深色 #93C5FD / #67E8F9 / #86EFAC / #FCD34D / #FCA5A5 on #12161B 均 > 7:1。
 */

var VERSION = 1;
var CLASS = 'ts-prism';

/* 语义色：light / dark。fill 用于图形，text 用于文字。 */
var TOKENS = {
	down:     { light: '#3B82F6', dark: '#60A5FA' },
	downText: { light: '#1D4ED8', dark: '#93C5FD' },
	up:       { light: '#0891B2', dark: '#22D3EE' },
	upText:   { light: '#0E7490', dark: '#67E8F9' },
	ok:       { light: '#16A34A', dark: '#4ADE80' },
	okText:   { light: '#15803D', dark: '#86EFAC' },
	warn:     { light: '#D97706', dark: '#FBBF24' },
	warnText: { light: '#B45309', dark: '#FCD34D' },
	bad:      { light: '#DC2626', dark: '#F87171' },
	badText:  { light: '#B91C1C', dark: '#FCA5A5' },
	accent:   { light: '#7C3AED', dark: '#A78BFA' },
	teal:     { light: '#0F766E', dark: '#2DD4BF' },
	neutral:  { light: '#64748B', dark: '#94A3B8' },
	text:     { light: '#1F2937', dark: '#E6EDF5' },
	text2:    { light: '#4B5563', dark: '#A9B6C6' },
	text3:    { light: '#6B7280', dark: '#8B9AAC' },
	focus:    { light: '#2563EB', dark: '#93C5FD' }
};

/* 圆角 / 间距 / 字号：收敛成一套刻度，页面不再随手写 9px / 11.5px 这类值。 */
var SCALE = {
	radius: { sm: '6px', md: '10px', lg: '14px', pill: '999px' },
	space:  { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' },
	font:   { xs: '12px', sm: '13px', md: '15px', lg: '18px', xl: '22px' }
};

function cssVar(name) {
	return 'var(--ts-' + name + ')';
}

/*
 * 解析当前节点的 CSS 变量（Canvas 不能用 var()）。
 * 节点优先，其次 document.documentElement；拿不到就回退到静态值，
 * 所以测试桩 / 旧浏览器 / 深色媒体查询都不会抛错。
 */
function color(name, fallback, node) {
	var token = TOKENS[name];
	var fb = fallback || (token ? token.light : '');

	try {
		if (typeof getComputedStyle == 'function') {
			var host = node && node.nodeType ? node : ((typeof document != 'undefined') ? document.documentElement : null);

			if (host != null) {
				var value = getComputedStyle(host).getPropertyValue('--ts-' + name.replace(/[A-Z]/g, function(m) {
					return '-' + m.toLowerCase();
				}));

				value = ('' + (value == null ? '' : value)).replace(/^\s+|\s+$/g, '');

				if (value.length) return value;
			}
		}
	}
	catch (e) { }

	return fb;
}

/* 状态三态 → 前景 / 背景 / 描边（全部走变量，深浅主题自动跟随）。 */
function tone(name) {
	var map = {
		ok:   { fg: 'okText',   bg: 'rgba(22,163,74,.10)',  line: 'ok' },
		warn: { fg: 'warnText', bg: 'rgba(217,119,6,.10)',  line: 'warn' },
		bad:  { fg: 'badText',  bg: 'rgba(220,38,38,.10)',  line: 'bad' },
		info: { fg: 'downText', bg: 'rgba(59,130,246,.10)', line: 'down' },
		muted:{ fg: 'text2',    bg: 'rgba(127,127,127,.08)', line: 'neutral' }
	};
	var t = map[name] || map.muted;

	return {
		fg: cssVar(t.fg),
		bg: t.bg,
		line: cssVar(t.line)
	};
}

var CSS = [
	/* ---- token（只声明在页面根，不碰 LuCI 全局） ---- */
	'.ts-prism{',
	'--ts-down:' + TOKENS.down.light + ';--ts-down-text:' + TOKENS.downText.light + ';',
	'--ts-up:' + TOKENS.up.light + ';--ts-up-text:' + TOKENS.upText.light + ';',
	'--ts-ok:' + TOKENS.ok.light + ';--ts-ok-text:' + TOKENS.okText.light + ';',
	'--ts-warn:' + TOKENS.warn.light + ';--ts-warn-text:' + TOKENS.warnText.light + ';',
	'--ts-bad:' + TOKENS.bad.light + ';--ts-bad-text:' + TOKENS.badText.light + ';',
	'--ts-accent:' + TOKENS.accent.light + ';--ts-teal:' + TOKENS.teal.light + ';--ts-neutral:' + TOKENS.neutral.light + ';',
	'--ts-text:' + TOKENS.text.light + ';--ts-text-2:' + TOKENS.text2.light + ';--ts-text-3:' + TOKENS.text3.light + ';',
	'--ts-focus:' + TOKENS.focus.light + ';',
	'--ts-surface:rgba(15,23,42,.04);--ts-surface-2:rgba(15,23,42,.07);',
	'--ts-border:rgba(15,23,42,.14);--ts-border-2:rgba(15,23,42,.26);',
	'--ts-grid:rgba(15,23,42,.055);',
	'--ts-r-sm:' + SCALE.radius.sm + ';--ts-r:' + SCALE.radius.md + ';--ts-r-lg:' + SCALE.radius.lg +
		';--ts-r-pill:' + SCALE.radius.pill + ';',
	'--ts-s1:' + SCALE.space.xs + ';--ts-s2:' + SCALE.space.sm + ';--ts-s3:' + SCALE.space.md +
		';--ts-s4:' + SCALE.space.lg + ';--ts-s5:' + SCALE.space.xl + ';',
	'--ts-fs-1:' + SCALE.font.xs + ';--ts-fs-2:' + SCALE.font.sm + ';--ts-fs-3:' + SCALE.font.md +
		';--ts-fs-4:' + SCALE.font.lg + ';--ts-fs-5:' + SCALE.font.xl + ';',
	'color:var(--ts-text);font-size:var(--ts-fs-2);line-height:1.55;',
	'}',
	'@media (prefers-color-scheme:dark){:root:not([data-darkmode="false"]) .ts-prism{',
	'--ts-down:' + TOKENS.down.dark + ';--ts-down-text:' + TOKENS.downText.dark + ';',
	'--ts-up:' + TOKENS.up.dark + ';--ts-up-text:' + TOKENS.upText.dark + ';',
	'--ts-ok:' + TOKENS.ok.dark + ';--ts-ok-text:' + TOKENS.okText.dark + ';',
	'--ts-warn:' + TOKENS.warn.dark + ';--ts-warn-text:' + TOKENS.warnText.dark + ';',
	'--ts-bad:' + TOKENS.bad.dark + ';--ts-bad-text:' + TOKENS.badText.dark + ';',
	'--ts-accent:' + TOKENS.accent.dark + ';--ts-teal:' + TOKENS.teal.dark + ';--ts-neutral:' + TOKENS.neutral.dark + ';',
	'--ts-text:' + TOKENS.text.dark + ';--ts-text-2:' + TOKENS.text2.dark + ';--ts-text-3:' + TOKENS.text3.dark + ';',
	'--ts-focus:' + TOKENS.focus.dark + ';',
	'--ts-surface:rgba(148,163,184,.10);--ts-surface-2:rgba(148,163,184,.16);',
	'--ts-border:rgba(148,163,184,.28);--ts-border-2:rgba(148,163,184,.44);',
	'--ts-grid:rgba(148,163,184,.075);',
	'}}',
	/* LuCI bootstrap 的用户深色开关优先于系统配色；显式 false 时不进入上面的媒体查询。 */
	':root[data-darkmode="true"] .ts-prism{',
	'--ts-down:' + TOKENS.down.dark + ';--ts-down-text:' + TOKENS.downText.dark + ';',
	'--ts-up:' + TOKENS.up.dark + ';--ts-up-text:' + TOKENS.upText.dark + ';',
	'--ts-ok:' + TOKENS.ok.dark + ';--ts-ok-text:' + TOKENS.okText.dark + ';',
	'--ts-warn:' + TOKENS.warn.dark + ';--ts-warn-text:' + TOKENS.warnText.dark + ';',
	'--ts-bad:' + TOKENS.bad.dark + ';--ts-bad-text:' + TOKENS.badText.dark + ';',
	'--ts-accent:' + TOKENS.accent.dark + ';--ts-teal:' + TOKENS.teal.dark + ';--ts-neutral:' + TOKENS.neutral.dark + ';',
	'--ts-text:' + TOKENS.text.dark + ';--ts-text-2:' + TOKENS.text2.dark + ';--ts-text-3:' + TOKENS.text3.dark + ';',
	'--ts-focus:' + TOKENS.focus.dark + ';',
	'--ts-surface:rgba(148,163,184,.10);--ts-surface-2:rgba(148,163,184,.16);',
	'--ts-border:rgba(148,163,184,.28);--ts-border-2:rgba(148,163,184,.44);',
	'--ts-grid:rgba(148,163,184,.075);',
	'}',

	/* ---- 基础：盒模型与字体只作用于本组件子树 ---- */
	'.ts-prism,.ts-prism *,.ts-prism *::before,.ts-prism *::after{box-sizing:border-box}',
	'.ts-prism :focus-visible{outline:2px solid var(--ts-focus);outline-offset:2px}',
	/* 链接用对比度达标的品牌文字色；页面里的 color:inherit 规则优先级更高，不会被抢。 */
	'.ts-prism a{color:var(--ts-down-text);text-underline-offset:2px}',
	'.ts-prism a:hover{text-decoration:underline}',
	'.ts-prism ::selection{background:rgba(59,130,246,.22)}',

	/* ---- 页面标题：统一字号/字重 + 左侧 3px 品牌条（克制，不发光） ---- */
	'.ts-prism .ts-title{display:flex;align-items:center;gap:var(--ts-s2);margin:0 0 var(--ts-s3) 0;',
	'font-size:var(--ts-fs-4);font-weight:600;line-height:1.35;letter-spacing:.01em}',
	'.ts-prism .ts-title::before{content:"";flex:none;width:3px;height:1.05em;border-radius:2px;',
	'background:var(--ts-down)}',

	/* ---- 轻量表面：面板/卡片只用一层半透明中性底色 + 1px 边线，不堆渐变 ---- */
	'.ts-prism .ts-card{padding:var(--ts-s3);border-radius:var(--ts-r);',
	'background:var(--ts-surface);border:1px solid var(--ts-border);min-width:0}',
	'.ts-prism .ts-card-h{display:flex;align-items:center;gap:var(--ts-s2);flex-wrap:wrap;',
	'margin:0 0 var(--ts-s2) 0;padding:0 0 var(--ts-s2) 0;border-bottom:1px solid var(--ts-border)}',
	'.ts-prism .ts-card-t{font-size:var(--ts-fs-2);font-weight:600;white-space:nowrap}',
	'.ts-prism .ts-card-n{font-size:var(--ts-fs-1);color:var(--ts-text-3);white-space:nowrap;',
	'overflow:hidden;text-overflow:ellipsis;min-width:0}',
	'.ts-prism .ts-card-a{margin-left:auto;font-size:var(--ts-fs-1);white-space:nowrap}',

	/* ---- 数据层级 ---- */
	'.ts-prism .ts-num{font-variant-numeric:tabular-nums}',
	'.ts-prism .ts-muted{color:var(--ts-text-3)}',
	'.ts-prism .ts-strong{font-weight:600}',
	'.ts-prism .ts-chip{display:inline-block;padding:0 6px;border-radius:var(--ts-r-sm);',
	'font-size:var(--ts-fs-1);line-height:1.7;background:var(--ts-surface-2);color:var(--ts-text-2);white-space:nowrap}',
	'.ts-prism .ts-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--ts-neutral)}',

	/* ---- 可折叠说明（日历 / 口径说明），降低长期占位 ---- */
	'.ts-prism details.ts-fold{margin:0 0 var(--ts-s3) 0;border:1px solid var(--ts-border);',
	'border-radius:var(--ts-r);background:var(--ts-surface);min-width:0}',
	'.ts-prism details.ts-fold>summary{display:flex;align-items:center;gap:var(--ts-s2);flex-wrap:wrap;',
	'padding:9px 12px;cursor:pointer;list-style:none;font-size:var(--ts-fs-2);font-weight:600;line-height:1.5}',
	'.ts-prism details.ts-fold>summary::-webkit-details-marker{display:none}',
	'.ts-prism details.ts-fold>summary::before{content:"▸";flex:none;font-size:var(--ts-fs-1);',
	'color:var(--ts-text-3);transition:transform .15s}',
	'.ts-prism details.ts-fold[open]>summary::before{transform:rotate(90deg)}',
	'.ts-prism details.ts-fold[open]>summary{border-bottom:1px solid var(--ts-border)}',
	'.ts-prism details.ts-fold .ts-fold-b{padding:var(--ts-s3);min-width:0}',

	/* ---- 驾驶舱网格背景：低对比、只在明确的容器上用 ---- */
	'.ts-prism .ts-grid{background-image:',
	'linear-gradient(to right,var(--ts-grid) 1px,transparent 1px),',
	'linear-gradient(to bottom,var(--ts-grid) 1px,transparent 1px);',
	'background-size:24px 24px;background-position:0 0}',
	/* 浅色下别让网格压过文字：只给容器一点微弱底色 */
	'.ts-prism .ts-grid{background-color:transparent}',

	/* ---- 方向图例：下载/上传固定语义色（文字用加深变体保证对比度） ---- */
	'.ts-prism .ts-dir{display:inline-flex;align-items:center;gap:5px;font-size:var(--ts-fs-1);',
	'color:var(--ts-text-2);white-space:nowrap}',
	'.ts-prism .ts-dir-down::before,.ts-prism .ts-dir-up::before{content:"";flex:none;width:8px;',
	'height:8px;border-radius:2px;display:inline-block}',
	'.ts-prism .ts-dir-down::before{background:var(--ts-down)}',
	'.ts-prism .ts-dir-up::before{background:var(--ts-up)}',
	'.ts-prism .ts-down{color:var(--ts-down-text)}',
	'.ts-prism .ts-up{color:var(--ts-up-text)}',

	/* ---- 状态：绿/橙/红只出现在状态元素上 ---- */
	'.ts-prism .ts-st-ok{color:var(--ts-ok-text)}',
	'.ts-prism .ts-st-warn{color:var(--ts-warn-text)}',
	'.ts-prism .ts-st-bad{color:var(--ts-bad-text)}',
	'.ts-prism .ts-strip{display:flex;align-items:center;gap:var(--ts-s2);flex-wrap:wrap;',
	'padding:8px 12px;border-radius:var(--ts-r);background:var(--ts-surface);',
	'border:1px solid var(--ts-border);border-left-width:3px;font-size:var(--ts-fs-1);line-height:1.6}',
	'.ts-prism .ts-strip.ts-strip-ok{border-left-color:var(--ts-ok)}',
	'.ts-prism .ts-strip.ts-strip-warn{border-left-color:var(--ts-warn)}',
	'.ts-prism .ts-strip.ts-strip-bad{border-left-color:var(--ts-bad)}',
	'.ts-prism .ts-strip.ts-strip-muted{border-left-color:var(--ts-neutral)}',

	/* ---- 按钮：只统一可聚焦控件的最小点击区与圆角，不覆盖 LuCI cbi-button ---- */
	'.ts-prism .ts-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;',
	'min-height:32px;padding:0 10px;border-radius:var(--ts-r-sm);border:1px solid var(--ts-border);',
	'background:var(--ts-surface);color:inherit;font:inherit;font-size:var(--ts-fs-1);cursor:pointer}',
	'.ts-prism .ts-btn:hover{background:var(--ts-surface-2)}',
	'.ts-prism .ts-btn:disabled{opacity:.55;cursor:default}',
	/* 触摸设备上把可见高度扩到 44px，但视觉尺寸不变 */
	'@media (pointer:coarse){.ts-prism .ts-btn{position:relative}',
	'.ts-prism .ts-btn::before{content:"";position:absolute;left:-2px;right:-2px;top:50%;height:44px;margin-top:-22px}}',

	/* ---- 减少动态偏好：动画/过渡/平滑滚动全部关掉 ---- */
	'@media (prefers-reduced-motion:reduce){',
	'.ts-prism,.ts-prism *,.ts-prism *::before,.ts-prism *::after{',
	'animation-duration:.001ms !important;animation-iteration-count:1 !important;',
	'transition-duration:.001ms !important;scroll-behavior:auto !important}',
	'}',

	/* ---- 窄屏：共享卡片间距收紧，标题不换行挤压操作区 ---- */
	'@media (max-width:600px){',
	'.ts-prism{--ts-fs-4:' + SCALE.font.md + ';--ts-fs-5:' + SCALE.font.lg + '}',
	'.ts-prism .ts-card{padding:var(--ts-s2)}',
	'.ts-prism .ts-title{flex-wrap:wrap;gap:6px}',
	'}'
].join('\n');

/* LuCI view 里直接 E('style', {}, theme.css())。 */
function styleNode() {
	return E('style', {}, CSS);
}

return baseclass.extend({
	VERSION: VERSION,
	CLASS: CLASS,
	TOKENS: TOKENS,
	SCALE: SCALE,
	COLORS: TOKENS,
	css: function() { return CSS; },
	style: styleNode,
	color: color,
	tone: tone,
	var: cssVar
});
