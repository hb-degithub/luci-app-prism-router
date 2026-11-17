#!/usr/bin/env node
/*
 * 手机版新界面（mobile.js）静态 / 轻量测试
 *
 * 不连路由器、不启动服务器、不跑 puppeteer：继续用 tests/ui-frontend-static.js
 * 的 vm 包装（'require xxx' 字符串 + return view.extend({...})），并在模块返回前
 * 把纯函数挂到 globalThis 上做断言；渲染结果用 E()/DOM 桩检查。
 *
 * 与 ui-frontend-static.js 的 E() 桩相比，这里补了真实 DOM 语义：
 *   - attrs['class'] + classList.add/remove/contains（setPage 只切 class）
 *   - appendChild/removeChild/firstChild/textContent（dom.content 真的写回）
 *   - window.setInterval/clearInterval（轮询测试需要桩计时器）
 * 这些都只是浏览器原语的替身，不复制 mobile.js 的任何业务判断。
 *
 * 覆盖：
 *   1. 结构：根 #ts-mobile.tsm-app、5 个 .tsm-page、5 个 .tsm-dot-btn、默认第 1 屏
 *   2. 分页 setPage 夹紧，只改 class，不发 RPC
 *   3. 概览数据：上传/下载速率、出口节点、连接数角标、在线台数
 *   4. 设备分类：主网络 / 访客 / 离线 + 三个 tab 数量
 *   5. 设备行：连接节点、接入方式、相对时间/离线
 *   6. 排序与链路筛选（本地重排，不发 RPC）
 *   7. 节点屏：在线/未绑定/未知胶囊、空态、get_nodes 失败不影响其它屏
 *  7b. 拓扑屏：5 层（互联网/出口/主路由/AP/设备）、降级、点击设备切屏展开、深色/320px 静态样式
 *   8. 安全与文案：无危险 DOM API、healthLook、不得把 totals 说成「今日」
 *   9. 轮询：startRefresh/stopRefresh、clearInterval、页面离开停止、hidden 跳过
 *  10. 陈旧 state：分类/计数用真实时间、未来 +60s 容忍、顶部「未更新」/「未运行」
 *  11. get_nodes 先成功后失败：旧卡片保留 + 顶部错误提示
 *  12. 后端裁剪：state.truncated / dev.apps_truncated 提示
 *  13. 静态样式：关键点击区 ≥44×44、概览数字不被旧规则压暗、拓扑主题变量
 *
 * 时钟：mobile.js 用真实时间（Date.now）判断在线/陈旧，所以沙箱里的 Date 固定成 NOW，
 * 让 NOW 相对的 last_seen 断言不随真实时钟漂移。
 *
 * 运行：node tests/mobile-ui-static.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MOBILE = path.join(
	ROOT,
	'luci-app-traffic-stats/htdocs/luci-static/resources/view/traffic-stats/mobile.js'
);
const SOURCE = fs.readFileSync(MOBILE, 'utf8');

/* 固定「现在」，避免相对时间断言随真实时钟漂移。 */
const NOW = 1800000000;

/*
 * 固定时钟：mobile.js 的在线/陈旧判断现在一律用真实时间（Date.now），
 * 所以测试必须把沙箱里的「现在」钉在 NOW，让 NOW 相对的 last_seen 保持稳定。
 * new Date(x) 仍返回真实 Date 实例，只是 Date.now()/new Date() 被固定。
 */
function makeFixedDate(ms) {
	function FixedDate() {
		const args = Array.prototype.slice.call(arguments);

		if (args.length === 0) return new Date(ms);

		return new (Function.prototype.bind.apply(Date, [ null ].concat(args)))();
	}

	FixedDate.now = function () { return ms; };
	FixedDate.parse = Date.parse;
	FixedDate.UTC = Date.UTC;
	FixedDate.prototype = Date.prototype;

	return FixedDate;
}

let passed = 0;
let failed = 0;

function ok(name) {
	passed++;
	console.log('  PASS  ' + name);
}

function bad(name, detail) {
	failed++;
	console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

function check(name, condition, detail) {
	if (condition) ok(name);
	else bad(name, detail);
}

function repr(value) {
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'undefined') return 'undefined';

	try {
		return JSON.stringify(value);
	}
	catch (e) {
		return '' + value;
	}
}

function same(name, actual, expected) {
	check(name, Object.is(actual, expected),
		'实际=' + repr(actual) + '，期望=' + repr(expected));
}

function sameList(name, actual, expected) {
	const a = repr(actual);
	const e = repr(expected);

	check(name, a === e, '实际=' + a + '，期望=' + e);
}

// ---------------------------------------------------------------- DOM 桩

function textOf(node) {
	if (node == null) return '';
	if (typeof node === 'string') return node;
	if (typeof node !== 'object') return '' + node;

	return node.textContent;
}

function classTokens(node) {
	const raw = (node != null && node.attrs != null && node.attrs['class'] != null)
		? '' + node.attrs['class'] : '';

	return raw.split(/\s+/).filter(Boolean);
}

function hasClass(node, name) {
	if (node == null || typeof node !== 'object') return false;

	return classTokens(node).indexOf(name) >= 0;
}

function makeClassList(node) {
	return {
		add: function (name) {
			const tokens = classTokens(node);

			if (tokens.indexOf(name) < 0) tokens.push(name);
			node.attrs['class'] = tokens.join(' ');
		},
		remove: function (name) {
			node.attrs['class'] = classTokens(node)
				.filter(function (token) { return token !== name; })
				.join(' ');
		},
		contains: function (name) {
			return classTokens(node).indexOf(name) >= 0;
		},
		toggle: function (name, force) {
			const on = (force === undefined) ? !this.contains(name) : !!force;

			if (on) this.add(name);
			else this.remove(name);

			return on;
		}
	};
}

/* E() 的 style 是内联字符串；浏览器会把它解析进 element.style，这里照做。 */
function parseStyle(text) {
	const out = {};

	if (typeof text !== 'string' || text.length === 0) return out;

	text.split(';').forEach(function (part) {
		const index = part.indexOf(':');

		if (index <= 0) return;

		out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
	});

	return out;
}

/*
 * 浏览器元素的最小可信替身：class 属性与 classList 联动、子节点真实增删、
 * textContent 赋值会清空子节点（与 DOM 一致）。E() 桩和 document.createElementNS
 * 共用它。
 */
function createNode(tag, attrs, children, namespace) {
	const node = {
		tag: tag,
		namespace: namespace || null,
		attrs: Object.assign({}, attrs || {}),
		style: parseStyle(attrs && attrs.style),
		children: [],
		parentNode: null,
		listeners: {},
		_text: ''
	};

	node.classList = makeClassList(node);

	node.appendChild = function (child) {
		if (child == null) return null;

		if (typeof child !== 'object') {
			node.children.push('' + child);
			return child;
		}

		child.parentNode = node;
		node.children.push(child);

		return child;
	};

	node.removeChild = function (child) {
		const index = node.children.indexOf(child);

		if (index >= 0) {
			node.children.splice(index, 1);

			if (child != null && typeof child === 'object') child.parentNode = null;
		}

		return child;
	};

	node.setAttribute = function (key, value) {
		node.attrs[key] = '' + value;

		if (key === 'style') node.style = parseStyle('' + value);
	};
	node.getAttribute = function (key) {
		return node.attrs[key] != null ? node.attrs[key] : null;
	};
	node.removeAttribute = function (key) {
		delete node.attrs[key];
	};
	node.addEventListener = function (type, fn) {
		(node.listeners[type] = node.listeners[type] || []).push(fn);
	};
	node.removeEventListener = function (type, fn) {
		const list = node.listeners[type] || [];
		const index = list.indexOf(fn);

		if (index >= 0) list.splice(index, 1);
	};
	node.focus = function () {};
	node.contains = function (other) {
		let current = other;

		while (current != null) {
			if (current === node) return true;
			current = current.parentNode;
		}

		return false;
	};

	Object.defineProperty(node, 'textContent', {
		get: function () {
			if (node.children.length === 0) return node._text;

			return node.children.map(textOf).join('');
		},
		set: function (value) {
			node.children.length = 0;
			node._text = (value == null) ? '' : '' + value;
		}
	});

	Object.defineProperty(node, 'firstChild', {
		get: function () {
			return node.children.length ? node.children[0] : null;
		}
	});

	node.title = node.attrs.title != null ? '' + node.attrs.title : '';
	node.disabled = node.attrs.disabled === true;

	if (children != null) {
		if (Array.isArray(children)) {
			children.forEach(function (child) {
				if (child != null) node.appendChild(child);
			});
		}
		else {
			node.appendChild(children);
		}
	}

	return node;
}

function findAll(root, predicate) {
	const out = [];

	(function walk(node) {
		if (node == null || typeof node !== 'object') return;

		if (predicate(node)) out.push(node);

		const children = node.children || [];

		for (let i = 0; i < children.length; i++) walk(children[i]);
	})(root);

	return out;
}

function findByClass(root, name) {
	return findAll(root, function (node) { return hasClass(node, name); })[0] || null;
}

// ---------------------------------------------------------------- 环境桩

function makeEnvironment() {
	const declarations = [];
	const calls = [];
	const responses = {};
	const rejections = {};
	const notifications = [];
	const timers = { started: [], cleared: [], active: new Map() };
	const windowEvents = [];
	const scrolls = [];

	let timerSeq = 1;

	const head = createNode('head', {}, null);
	const body = createNode('body', {}, null);

	function nextTimerId() {
		return timerSeq++;
	}

	const env = {
		console: console,

		/* 真实时间被 mobile.js 用作在线/陈旧基准，沙箱里钉死在 NOW。 */
		Date: makeFixedDate(NOW * 1000),

		TextEncoder: (typeof TextEncoder !== 'undefined') ? TextEncoder : undefined,

		/* LuCI 全局 */
		view: { extend: function (obj) { return obj; } },
		rpc: {
			declare: function (opts) {
				declarations.push({
					method: opts.method,
					object: opts.object,
					params: opts.params || null
				});

				return function () {
					const args = Array.prototype.slice.call(arguments);

					calls.push({ method: opts.method, args: args });

					/* 测试里按方法名注入 reject，模拟 rpcd 调用失败。 */
					if (rejections[opts.method] != null)
						return Promise.reject(rejections[opts.method]);

					const response = Object.prototype.hasOwnProperty.call(responses, opts.method)
						? responses[opts.method]
						: { ok: true };

					return Promise.resolve(response);
				};
			}
		},
		uci: {
			load: function () { return Promise.resolve(); },
			get: function () { return null; },
			set: function () {},
			commit: function () {}
		},
		ui: {
			addNotification: function (type, node, kind) {
				notifications.push({ node: node, kind: kind });
			},
			createHandlerFn: function (ctx, fn) {
				return function (ev) { return fn.call(ctx, ev); };
			}
		},
		L: {
			resource: function (p) { return '/luci-static/resources/' + p; },
			url: function (p) { return '/cgi-bin/luci/' + p; },
			/* 测试环境没有 uqr：二维码分支应降级成一行提示，绝不能抛错。 */
			require: function () { throw new Error('uqr unavailable in test env'); }
		},
		dom: {
			/* 与 LuCI 的 dom.content 一致：先清空，再按数组/单节点写入。 */
			content: function (node, content) {
				if (node == null) return;

				node.children.length = 0;
				node._text = '';

				if (content == null) return;

				if (Array.isArray(content)) {
					content.forEach(function (child) {
						if (child != null) node.appendChild(child);
					});

					return;
				}

				node.appendChild(content);
			}
		},
		E: function (tag, attrs, children) {
			return createNode(tag, attrs, children);
		},
		_: function (s) { return s; },

		window: {
			location: {
				href: 'https://192.168.1.1/cgi-bin/luci/admin/services/traffic-stats/mobile'
			},
			navigator: {
				/* 固定 Android UA，安装屏走 Android 分步文案，不依赖本机浏览器。 */
				userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
				maxTouchPoints: 5,
				standalone: false,
				clipboard: null
			},
			matchMedia: function () {
				return { matches: false, addListener: function () {}, removeListener: function () {} };
			},
			addEventListener: function (type, fn) {
				windowEvents.push({ action: 'add', type: type, fn: fn });
			},
			removeEventListener: function (type, fn) {
				windowEvents.push({ action: 'remove', type: type, fn: fn });
			},
			setInterval: function (fn, ms) {
				const id = nextTimerId();

				timers.started.push({ id: id, fn: fn, ms: ms });
				timers.active.set(id, { fn: fn, ms: ms });

				return id;
			},
			clearInterval: function (id) {
				timers.cleared.push(id);
				timers.active.delete(id);
			},
			setTimeout: function () { return nextTimerId(); },
			clearTimeout: function () {},
			scrollTo: function (x, y) {
				scrolls.push({ x: x, y: y });
			},
			open: function () {}
		},

		document: {
			title: '',
			hidden: false,
			head: head,
			body: body,
			createElement: function (tag) { return createNode(tag, {}, null); },
			createElementNS: function (ns, tag) { return createNode(tag, {}, null, ns); },
			createTextNode: function (text) { return { text: text }; },
			getElementById: function () { return null; },
			querySelectorAll: function () { return []; },
			importNode: function (node) { return node; },
			createRange: function () {
				return { selectNodeContents: function () {} };
			},
			execCommand: function () { return false; }
		},

		setTimeout: function () { return nextTimerId(); },
		clearTimeout: function () {}
	};

	env.__declarations = declarations;
	env.__calls = calls;
	env.__responses = responses;
	env.__rejections = rejections;
	env.__notifications = notifications;
	env.__timers = timers;
	env.__windowEvents = windowEvents;
	env.__scrolls = scrolls;
	env.__body = body;
	env.__head = head;

	return env;
}

// ---------------------------------------------------------------- 载入 view

/* 只读 mobile.js；纯函数通过临时注入 globalThis 暴露，不改产品文件。 */
const HOOK_NAMES = [
	'healthLook',
	'exitNodeOf',
	'activeDeviceCount',
	'mbpsNum',
	'fmtMbps',
	'fmtBytes',
	'present',
	'num',
	'linkOf',
	'deviceChainLabel',
	'appListOf',
	'deviceName',
	'deviceTotal',
	'deviceKey',
	'rateText',
	'fmtAgo',
	'isDeviceOnline',
	'isGuestDevice',
	'deviceKindOf',
	'deviceKindSvg',
	'topoBusSvg',
	'classifyDevice',
	'groupDevices',
	'sortDevices',
	'filterDevicesByLink',
	'deviceMatchesQuery',
	'filterDevicesByQuery',
	'deviceViewList',
	'deviceNow',
	'nodeStatus',
	'nodeTotalsOf',
	'nodeDeviceCount',
	'topoExitList',
	'topoOnlineDevices',
	'topoDeviceGroups',
	'topoLinkCounts',
	'topoHostname',
	'deviceChains',
	'exitDrillDevices',
	'apDrillDevices',
	'stationFreshness',
	'stationNodeKey',
	'stationNodeName',
	'apOnlineCount'
];

function loadMobile() {
	const env = makeEnvironment();
	const context = vm.createContext(env);
	const marker = '\nreturn view.extend({';
	const patched = SOURCE.replace(
		marker,
		'\nglobalThis.__tsMobile = { ' + HOOK_NAMES.join(', ') + ' };\nreturn view.extend({'
	);

	if (patched === SOURCE)
		throw new Error('mobile.js 结构变了：找不到 return view.extend({，无法注入测试钩子');

	const script = new vm.Script('(function () {\n' + patched + '\n})()', { filename: 'mobile.js' });
	const view = script.runInContext(context, { timeout: 3000 });

	return {
		view: view,
		env: env,
		context: context,
		hooks: context.__tsMobile,
		source: SOURCE
	};
}

// ---------------------------------------------------------------- 数据 / 启动助手

function baseState(overrides) {
	const state = {
		ts: NOW,
		totals: {
			direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
			wifi_rx: 0, wifi_tx: 0, wired_rx: 0, wired_tx: 0,
			unknown_rx: 0, unknown_tx: 0,
			rx_rate: 0, tx_rate: 0
		},
		health: { accounting_confidence: 'exact', reasons: [], clash_connections: 0 },
		devices: [],
		nodes: {}
	};
	const over = overrides || {};

	Object.keys(over).forEach(function (key) {
		state[key] = over[key];
	});

	return state;
}

async function boot(options) {
	const opts = options || {};
	const loaded = loadMobile();
	const env = loaded.env;

	env.__responses.get_state = (opts.state !== undefined) ? opts.state : baseState();
	env.__responses.get_nodes = (opts.nodes !== undefined) ? opts.nodes : { nodes: [] };
	env.__responses.get_stations = (opts.stations !== undefined) ? opts.stations : { enabled: false, nodes: [], stations: [], count: 0 };

	if (opts.rejectState != null) env.__rejections.get_state = opts.rejectState;
	if (opts.rejectNodes != null) env.__rejections.get_nodes = opts.rejectNodes;
	if (opts.rejectStations != null) env.__rejections.get_stations = opts.rejectStations;

	const ctx = Object.create(loaded.view);

	if (opts.skipLoad !== true) await loaded.view.load.call(ctx);

	loaded.view.render.call(ctx);

	/* 模拟 LuCI 把 view 挂到 #maincontent：轮询里的 document.body.contains 才为真。 */
	env.document.body.appendChild(ctx.root);

	return {
		mod: loaded.view,
		env: env,
		ctx: ctx,
		hooks: loaded.hooks,
		source: loaded.source
	};
}

function flush() {
	return new Promise(function (resolve) { setImmediate(resolve); });
}

/*
 * 进入节点/拓扑屏并等懒加载完成：setPage 只触发一次 ensureNodeData，
 * 这里复用同一个 promise，顺便把微任务跑完让 DOM 写回。
 */
async function enterPage(ctx, index) {
	ctx.setPage(index);
	await ctx.ensureNodeData();
	await flush();
}

function countCalls(env, method) {
	return env.__calls.filter(function (call) { return call.method === method; }).length;
}

function devTabCount(ctx, id) {
	const tab = ctx.devTabs.find(function (item) { return item.id === id; });

	return tab ? textOf(tab.count) : null;
}

function deviceNames(ctx) {
	return findAll(ctx.devicesBox, function (node) {
		return hasClass(node, 'tsm-dname');
	}).map(textOf);
}

function deviceRowByName(ctx, name) {
	const items = findAll(ctx.devicesBox, function (node) {
		return hasClass(node, 'tsm-ditem');
	});

	for (let i = 0; i < items.length; i++) {
		const nameNode = findAll(items[i], function (node) {
			return hasClass(node, 'tsm-dname');
		})[0];

		if (nameNode != null && textOf(nameNode) === name) return items[i];
	}

	return null;
}

function nodeCards(ctx) {
	return findAll(ctx.nodeHost, function (node) {
		return hasClass(node, 'tsm-ncard');
	});
}

function nodeCardByName(ctx, name) {
	const cards = nodeCards(ctx);

	for (let i = 0; i < cards.length; i++) {
		const nameNode = findAll(cards[i], function (node) {
			return hasClass(node, 'tsm-nname');
		})[0];

		if (nameNode != null && textOf(nameNode) === name) return cards[i];
	}

	return null;
}

function nodePillText(card) {
	if (card == null) return null;

	const pill = findAll(card, function (node) {
		return hasClass(node, 'tsm-npill');
	})[0];

	return pill ? textOf(pill) : null;
}

/* 源码里的注释不算「界面文案」：去掉注释后再查口径措辞。 */
function codeWithoutComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------- 1. 结构

async function testStructure() {
	console.log('\n[1] 结构：根 #ts-mobile.tsm-app / 5 屏 / 5 圆点 / 默认第 1 屏');

	const booted = await boot();
	const ctx = booted.ctx;
	const root = ctx.root;

	check('mobile.js 可解析并返回 view 对象',
		booted.mod != null && typeof booted.mod === 'object',
		'view=' + repr(booted.mod));
	check('纯函数测试钩子可注入', booted.hooks != null,
		'hooks=' + repr(booted.hooks));

	same('根节点 id=ts-mobile', root.attrs.id, 'ts-mobile');
	check('根节点带 .tsm-app', hasClass(root, 'tsm-app'),
		'class=' + repr(root.attrs['class']));
	same('整页只有一个 .tsm-app', findAll(root, function (n) { return hasClass(n, 'tsm-app'); }).length, 1);

	const pagesHost = findByClass(root, 'tsm-pages');

	check('.tsm-pages 容器存在', pagesHost != null,
		'pagesHost=' + repr(pagesHost));
	same('.tsm-page 数量 = 5',
		findAll(root, function (n) { return hasClass(n, 'tsm-page'); }).length, 5);
	same('圆点按钮 .tsm-dot-btn 数量 = 5',
		findAll(root, function (n) { return hasClass(n, 'tsm-dot-btn'); }).length, 5);
	same('圆点指示 .tsm-dot-i 数量 = 5',
		findAll(root, function (n) { return hasClass(n, 'tsm-dot-i'); }).length, 5);

	const mainTabs = findByClass(root, 'tsm-tabs');
	const tabButtons = findAll(mainTabs, function (n) { return hasClass(n, 'tsm-tab'); });

	same('顶部分段 tab 数量 = 5', tabButtons.length, 5);
	sameList('顶部 tab 文案依次为 概览/设备/节点/拓扑/安装',
		tabButtons.map(textOf), [ '概览', '设备', '节点', '拓扑', '安装' ]);

	const dotButtons = findAll(root, function (n) { return hasClass(n, 'tsm-dot-btn'); });

	sameList('圆点 aria-label 随 5 屏更新',
		dotButtons.map(function (n) { return n.attrs['aria-label']; }),
		[ '概览', '设备', '节点', '拓扑', '安装' ]);

	same('默认 pageIndex = 0', ctx.pageIndex, 0);
	check('默认只显示第 1 屏（page[0].on，其余 off）',
		hasClass(ctx.pages[0], 'on') &&
		!hasClass(ctx.pages[1], 'on') &&
		!hasClass(ctx.pages[2], 'on') &&
		!hasClass(ctx.pages[3], 'on') &&
		!hasClass(ctx.pages[4], 'on'),
		'pages classes=' + repr(ctx.pages.map(function (p) { return p.attrs['class']; })));
	check('默认第 1 个 tab 与第 1 个圆点选中',
		hasClass(ctx.tabs[0], 'on') && hasClass(ctx.dots[0], 'on') &&
		!hasClass(ctx.tabs[1], 'on') && !hasClass(ctx.dots[1], 'on'),
		'tab classes=' + repr(ctx.tabs.map(function (t) { return t.attrs['class']; })) +
		' dot classes=' + repr(ctx.dots.map(function (d) { return d.attrs['class']; })));
	check('第 1 屏是概览（含上传Mbps/下载Mbps）',
		textOf(ctx.pages[0]).indexOf('上传Mbps') >= 0 &&
		textOf(ctx.pages[0]).indexOf('下载Mbps') >= 0,
		textOf(ctx.pages[0]).slice(0, 120));

	const topoText = textOf(ctx.pages[3]);

	check('第 4 屏是拓扑（含 网络拓扑 / 互联网 / 出口 / 主路由 / AP / 设备）',
		topoText.indexOf('网络拓扑') >= 0 &&
		topoText.indexOf('互联网') >= 0 &&
		topoText.indexOf('出口') >= 0 &&
		topoText.indexOf('主路由') >= 0 &&
		topoText.indexOf('AP / 接入点') >= 0 &&
		topoText.indexOf('设备') >= 0,
		topoText.slice(0, 240));
	check('拓扑层级容器带 aria-label',
		ctx.topoHost != null && ctx.topoHost.attrs['aria-label'] != null &&
		String(ctx.topoHost.attrs['aria-label']).indexOf('网络拓扑') >= 0,
		'aria-label=' + repr(ctx.topoHost && ctx.topoHost.attrs['aria-label']));
	check('第 5 屏是安装（含安装/扫码文案）',
		textOf(ctx.pages[4]).indexOf('安装') >= 0 || textOf(ctx.pages[4]).indexOf('扫码') >= 0,
		textOf(ctx.pages[4]).slice(0, 160));
}

// ---------------------------------------------------------------- 2. 分页

async function testPaging() {
	console.log('\n[2] 分页：夹紧 [0,4]；首次进节点/拓扑懒加载一次，之后切屏不再发 RPC');

	const booted = await boot();
	const ctx = booted.ctx;
	const env = booted.env;
	const pageRefs = ctx.pages.slice();
	const pageTexts = ctx.pages.map(textOf);
	const callsBefore = env.__calls.length;
	const stateCallsBefore = countCalls(env, 'get_state');
	const nodeCallsBefore = countCalls(env, 'get_nodes');
	const stationCallsBefore = countCalls(env, 'get_stations');
	const initialScrolls = env.__scrolls.length;

	same('首屏只调用 get_state 一次', stateCallsBefore, 1);
	same('首屏不拉 get_nodes', nodeCallsBefore, 0);
	same('首屏不拉 get_stations', stationCallsBefore, 0);

	ctx.setPage(2);
	same('首次进节点屏补拉 get_nodes 一次', countCalls(env, 'get_nodes'), nodeCallsBefore + 1);
	same('首次进节点屏补拉 get_stations 一次', countCalls(env, 'get_stations'), stationCallsBefore + 1);
	same('懒加载不重发 get_state', countCalls(env, 'get_state'), stateCallsBefore);
	same('setPage(2) → pageIndex=2', ctx.pageIndex, 2);
	check('setPage(2)：只有第 3 屏 on',
		hasClass(ctx.pages[2], 'on') && !hasClass(ctx.pages[0], 'on') &&
		!hasClass(ctx.pages[1], 'on') && !hasClass(ctx.pages[3], 'on') &&
		!hasClass(ctx.pages[4], 'on'),
		'pages=' + repr(ctx.pages.map(function (page) { return page.attrs['class']; })));
	check('setPage(2)：对应 tab 与圆点同步',
		hasClass(ctx.tabs[2], 'on') && hasClass(ctx.dots[2], 'on') &&
		!hasClass(ctx.tabs[0], 'on') && !hasClass(ctx.dots[0], 'on'),
		'tab=' + repr(ctx.tabs[2].attrs['class']) + ' dot=' + repr(ctx.dots[2].attrs['class']));

	/* 0..4 每一屏都能直接切到，且只有目标屏 .on */
	const dotButtons = findAll(ctx.root, function (node) {
		return hasClass(node, 'tsm-dot-btn');
	});

	for (let i = 0; i < 5; i++) {
		ctx.setPage(i);

		const others = [ 0, 1, 2, 3, 4 ].filter(function (index) { return index !== i; });

		same('setPage(' + i + ') → pageIndex=' + i, ctx.pageIndex, i);
		check('setPage(' + i + ')：目标屏 on、其余 off、tab/圆点同步',
			hasClass(ctx.pages[i], 'on') &&
			others.every(function (index) { return !hasClass(ctx.pages[index], 'on'); }) &&
			hasClass(ctx.tabs[i], 'on') && hasClass(ctx.dots[i], 'on'),
			'pages=' + repr(ctx.pages.map(function (page) { return page.attrs['class']; })));
	}

	ctx.setPage(0);
	ctx.setPage(99);
	same('setPage(99) 夹紧到 4', ctx.pageIndex, 4);
	check('越界 99：只有第 5 屏 on',
		hasClass(ctx.pages[4], 'on') && !hasClass(ctx.pages[3], 'on'),
		'pages=' + repr(ctx.pages.map(function (page) { return page.attrs['class']; })));

	ctx.setPage(-5);
	same('setPage(-5) 夹紧到 0', ctx.pageIndex, 0);
	check('越界 -5：只有第 1 屏 on',
		hasClass(ctx.pages[0], 'on') && !hasClass(ctx.pages[4], 'on'),
		'pages=' + repr(ctx.pages.map(function (page) { return page.attrs['class']; })));

	ctx.setPage(4);
	same('setPage(4) → 安装屏', ctx.pageIndex, 4);
	check('setPage(4)：第 5 屏 on、第 4 屏（拓扑）off',
		hasClass(ctx.pages[4], 'on') && !hasClass(ctx.pages[3], 'on'),
		'pages=' + repr(ctx.pages.map(function (page) { return page.attrs['class']; })));

	ctx.tabs[3].attrs.click();
	same('点击顶部「拓扑」tab 切到第 4 屏', ctx.pageIndex, 3);

	ctx.tabs[2].attrs.click();
	same('点击顶部 tab 切到第 3 屏', ctx.pageIndex, 2);

	/* ctx.dots 存的是指示点 span；可点击的是外层 .tsm-dot-btn 按钮。 */
	dotButtons[1].attrs.click();
	same('点击底部圆点切到第 2 屏', ctx.pageIndex, 1);

	check('切屏不重建页面节点（同一批 DOM）',
		ctx.pages.length === 5 &&
		ctx.pages.every(function (page, index) { return page === pageRefs[index]; }),
		'pages=' + repr(ctx.pages.map(function (page, index) { return page === pageRefs[index]; })));
	sameList('切屏不改页面文本（只改 class）', ctx.pages.map(textOf), pageTexts);
	same('切屏不调用 get_state', countCalls(env, 'get_state'), stateCallsBefore);
	same('切走再回来不重复拉 get_nodes', countCalls(env, 'get_nodes'), nodeCallsBefore + 1);
	same('切走再回来不重复拉 get_stations', countCalls(env, 'get_stations'), stationCallsBefore + 1);
	same('切屏只产生首次懒加载的 2 个 RPC', env.__calls.length, callsBefore + 2);

	/* 滚动复位：setPage 成功后 window.scrollTo(0,0)，重复同一屏不滚 */
	same('render 时 setPage(0) 复位过滚动（1 次）', initialScrolls, 1);

	env.__scrolls.length = 0;
	ctx.setPage(3);
	same('setPage(3) 后调用一次 window.scrollTo', env.__scrolls.length, 1);
	sameList('scrollTo 传 (0,0)', [ env.__scrolls[0].x, env.__scrolls[0].y ], [ 0, 0 ]);

	ctx.setPage(3);
	same('重复 setPage 同一屏不再触发滚动', env.__scrolls.length, 1);

	ctx.setPage(-5);
	same('越界夹紧并真的切屏后仍然滚到顶部', env.__scrolls.length, 2);
	same('越界夹紧到第 1 屏', ctx.pageIndex, 0);
	ctx.setPage(-1);
	same('夹紧结果与当前屏相同时不重复滚动', env.__scrolls.length, 2);
	ctx.setPage(99);
	same('切到第 5 屏后滚动一次', env.__scrolls.length, 3);

	env.__scrolls.length = 0;
	dotButtons[2].attrs.click();
	same('点击底部圆点切屏也滚到顶部', env.__scrolls.length, 1);
	sameList('圆点切屏 scrollTo 同样传 (0,0)',
		[ env.__scrolls[0].x, env.__scrolls[0].y ], [ 0, 0 ]);
}

// ---------------------------------------------------------------- 3. 概览数据

async function testOverview() {
	console.log('\n[3] 概览：上传/下载速率、出口节点、连接角标、在线台数');

	const state = baseState({
		totals: {
			direct_rx: 1000000, direct_tx: 2000000,
			proxy_rx: 3000000, proxy_tx: 4000000,
			rx_rate: 2500000, tx_rate: 1250000
		},
		health: { accounting_confidence: 'exact', reasons: [], clash_connections: 7 },
		devices: [
			{ mac: 'M1', hostname: '在线', last_seen: NOW - 100 },
			{ mac: 'M2', hostname: '601秒前', last_seen: NOW - 601 },
			{ mac: 'M3', hostname: '无记录', last_seen: 0 }
		],
		nodes: {
			DIRECT: { rx: 1000000, tx: 1000000 },
			'香港 01': { rx: 100, tx: 100 },
			'日本 02': { rx: 500, tx: 400 }
		}
	});

	const booted = await boot({ state: state });
	const ctx = booted.ctx;

	same('上传大号数字 = tx_rate 换算 Mbps（1.25MB/s → 10.0）',
		textOf(ctx.txNum), '10.0');
	same('下载大号数字 = rx_rate 换算 Mbps（2.5MB/s → 20.0）',
		textOf(ctx.rxNum), '20.0');
	check('上传数字 title 标明速率单位',
		('' + ctx.txNum.title).indexOf('上传速率') >= 0 &&
		('' + ctx.txNum.title).indexOf('10.0 Mb/s') >= 0,
		ctx.txNum.title);
	check('下载数字 title 标明速率单位',
		('' + ctx.rxNum.title).indexOf('下载速率') >= 0 &&
		('' + ctx.rxNum.title).indexOf('20.0 Mb/s') >= 0,
		ctx.rxNum.title);
	check('概览页有「上传Mbps」「下载Mbps」单位说明',
		textOf(ctx.pages[0]).indexOf('上传Mbps') >= 0 &&
		textOf(ctx.pages[0]).indexOf('下载Mbps') >= 0,
		'text=' + repr(textOf(ctx.pages[0]).slice(0, 160)));

	same('出口节点 = 非 DIRECT 中 rx+tx 最大者（日本 02，900 > 香港 01 的 200）',
		textOf(ctx.exitName), '日本 02');
	same('出口节点副标题', textOf(ctx.exitSub), '出口节点');
	same('连接数角标 = health.clash_connections', textOf(ctx.exitBadge), '7');
	same('连接数 >0 时角标显示', ctx.exitBadge.style.display, 'block');

	same('「N 台终端」只算 600 秒内（1 台）', textOf(ctx.devPill), '1 台终端');
	same('纯函数 activeDeviceCount 同一口径',
		booted.hooks.activeDeviceCount(state.devices, NOW), 1);

	/* 缺速率 / DIRECT / 角标 0 或缺失 / 600 秒边界 */
	const state2 = baseState({
		totals: { direct_rx: 1, direct_tx: 1, proxy_rx: 0, proxy_tx: 0 },
		health: { accounting_confidence: 'exact', reasons: [] },
		devices: [
			{ mac: 'M1', hostname: '边界 600', last_seen: NOW - 600 },
			{ mac: 'M2', hostname: '601', last_seen: NOW - 601 },
			{ mac: 'M3', hostname: '0', last_seen: 0 },
			{ mac: 'M4', hostname: '59', last_seen: NOW - 59 }
		],
		nodes: { DIRECT: { rx: 10, tx: 10 } }
	});
	const booted2 = await boot({ state: state2 });
	const ctx2 = booted2.ctx;

	same('缺 tx_rate 时上传显示 —', textOf(ctx2.txNum), '—');
	same('缺 rx_rate 时下载显示 —', textOf(ctx2.rxNum), '—');
	same('只有 DIRECT 时出口节点显示「直连」', textOf(ctx2.exitName), '直连');
	same('health.clash_connections 缺失时角标不显示', ctx2.exitBadge.style.display, 'none');
	same('角标隐藏时文本为空', textOf(ctx2.exitBadge), '');
	same('600 秒整仍算在线（59 秒 + 600 秒 = 2 台）', textOf(ctx2.devPill), '2 台终端');
	same('exitNodeOf 对空对象返回空串', booted2.hooks.exitNodeOf({}), '');
	same('exitNodeOf 忽略 DIRECT（大小写）',
		booted2.hooks.exitNodeOf({ direct: { rx: 999, tx: 999 }, 'HK': { rx: 1, tx: 0 } }), 'HK');
	same('exitNodeOf 忽略后端合成桶 UNKNOWN（不当作出口节点名）',
		booted2.hooks.exitNodeOf({ UNKNOWN: { rx: 1000, tx: 1000 }, 'HK': { rx: 1, tx: 1 } }), 'HK');
	same('exitNodeOf 只有 UNKNOWN 时返回空串（调用方显示直连）',
		booted2.hooks.exitNodeOf({ UNKNOWN: { rx: 1000, tx: 1000 } }), '');

	/* clash_connections 明确为 0 时也必须隐藏角标 */
	const state3 = baseState({
		totals: state2.totals,
		health: { accounting_confidence: 'exact', reasons: [], clash_connections: 0 },
		devices: [],
		nodes: {}
	});
	const booted3 = await boot({ state: state3 });

	same('health.clash_connections=0 时角标不显示',
		booted3.ctx.exitBadge.style.display, 'none');
	same('clash_connections=0 时角标文本为空', textOf(booted3.ctx.exitBadge), '');
}

// ---------------------------------------------------------------- 4. 设备分类

async function testDeviceGroups() {
	console.log('\n[4] 设备屏：在线 / 访客 / 离线分类 + 三个 tab 数量');

	const devices = [
		{ mac: 'M1', hostname: '笔记本', group: '家里', alias: '笔记本',
			link: 'wifi', last_seen: NOW - 60, direct_rx: 500 },
		{ mac: 'G1', hostname: '访客手机', group: '访客', alias: '',
			link: 'wifi', last_seen: NOW - 120, direct_rx: 200 },
		{ mac: 'G2', hostname: '平板', group: '', alias: 'GUEST-TAB',
			link: 'wired', last_seen: NOW - 30, direct_rx: 100 },
		{ mac: 'G3', hostname: '访客旧的', group: 'Guest', alias: '',
			link: 'wifi', last_seen: NOW - 900 },
		{ mac: 'M2', hostname: 'NAS', group: '', alias: '',
			link: 'wired', last_seen: NOW - 600, direct_rx: 100 },
		{ mac: 'O1', hostname: '旧手机', last_seen: NOW - 601 },
		{ mac: 'O2', hostname: '消失设备', last_seen: 0 }
	];

	const booted = await boot({ state: baseState({ devices: devices }) });
	const ctx = booted.ctx;
	const hooks = booted.hooks;

	const groups = hooks.groupDevices(devices, NOW);

	same('主网络设备数', groups.main.length, 2);
	same('访客设备数', groups.guest.length, 2);
	same('离线设备数', groups.offline.length, 3);

	const expected = [ 'main', 'guest', 'guest', 'offline', 'main', 'offline', 'offline' ];

	devices.forEach(function (dev, index) {
		same('分类：' + dev.hostname, hooks.classifyDevice(dev, NOW), expected[index]);
	});

	check('group 含「访客」→ 访客', hooks.isGuestDevice({ group: '访客' }) === true,
		'实际=' + repr(hooks.isGuestDevice({ group: '访客' })));
	check('alias 含「访客」→ 访客', hooks.isGuestDevice({ alias: '访客手机' }) === true,
		'实际=' + repr(hooks.isGuestDevice({ alias: '访客手机' })));
	check('group 含 GUEST（大写）→ 访客', hooks.isGuestDevice({ group: 'GUEST' }) === true,
		'实际=' + repr(hooks.isGuestDevice({ group: 'GUEST' })));
	check('alias 含 myGuest（混合大小写）→ 访客', hooks.isGuestDevice({ alias: 'myGuest' }) === true,
		'实际=' + repr(hooks.isGuestDevice({ alias: 'myGuest' })));
	check('普通 group/alias 不是访客', hooks.isGuestDevice({ group: '家里', alias: 'tv' }) === false,
		'实际=' + repr(hooks.isGuestDevice({ group: '家里', alias: 'tv' })));
	check('只有 hostname 含 guest 不算访客（口径只看 group/alias）',
		hooks.classifyDevice({ hostname: 'guest-pc', last_seen: NOW - 10 }, NOW) === 'main',
		'实际=' + repr(hooks.classifyDevice({ hostname: 'guest-pc', last_seen: NOW - 10 }, NOW)));

	check('在线边界：600 秒整仍在线', hooks.isDeviceOnline({ last_seen: NOW - 600 }, NOW) === true,
		'实际=' + repr(hooks.isDeviceOnline({ last_seen: NOW - 600 }, NOW)));
	check('离线：601 秒前', hooks.isDeviceOnline({ last_seen: NOW - 601 }, NOW) === false,
		'实际=' + repr(hooks.isDeviceOnline({ last_seen: NOW - 601 }, NOW)));
	check('离线：last_seen=0', hooks.isDeviceOnline({ last_seen: 0 }, NOW) === false,
		'实际=' + repr(hooks.isDeviceOnline({ last_seen: 0 }, NOW)));

	same('tab「主网络设备」数量', devTabCount(ctx, 'main'), '(2)');
	same('tab「访客设备」数量', devTabCount(ctx, 'guest'), '(2)');
	same('tab「离线设备」数量', devTabCount(ctx, 'offline'), '(3)');
	sameList('默认主网络列表只含在线主网络设备', deviceNames(ctx), [ '笔记本', 'NAS' ]);

	const callsBefore = booted.env.__calls.length;

	ctx.devTabs[1].node.attrs.click();
	same('点击访客 tab → devTab=guest', ctx.devTab, 'guest');
	same('访客 tab 标题', textOf(ctx.devTitleText), '访客设备');
	same('访客 tab 列表条数', deviceNames(ctx).length, 2);
	sameList('访客 tab 列表按合计流量排序', deviceNames(ctx), [ '访客手机', '平板' ]);

	ctx.devTabs[2].node.attrs.click();
	same('点击离线 tab → devTab=offline', ctx.devTab, 'offline');
	same('离线 tab 标题', textOf(ctx.devTitleText), '离线设备');
	sameList('离线 tab 列表（访客但离线也归离线）', deviceNames(ctx),
		[ '访客旧的', '旧手机', '消失设备' ]);
	same('切设备 tab 不发 RPC', booted.env.__calls.length, callsBefore);
}

// ---------------------------------------------------------------- 5. 设备行

async function testDeviceRows() {
	console.log('\n[5] 设备行：连接节点 / 接入方式 / 离线');

	const r1 = {
		mac: 'AA:01', hostname: '客厅电视', link: 'wifi', last_seen: NOW - 120,
		rx_rate: 250000, tx_rate: 125000,
		apps: {
			'youtube.com': { rx: 100, tx: 50, chain: 'DIRECT' },
			'netflix.com': { rx: 5000, tx: 1000, chain: 'HK-01' }
		}
	};
	const r2 = {
		mac: 'AA:02', hostname: '路由器', last_seen: NOW - 30,
		apps: { 'update.local': { rx: 10, tx: 0, chain: 'direct' } }
	};
	const r3 = { mac: 'AA:03', hostname: '没有应用', link: 'WIRED', last_seen: 0 };

	/*
	 * 离线行口径：last_seen<=0（没有可信时间）只写「离线」；
	 * last_seen>0 但超过 600 秒必须明确写「离线 · N 分钟前」，
	 * 不能只写相对时间让人误以为还在线。
	 */
	const r4 = { mac: 'AA:04', hostname: '久未上报', link: 'wifi', last_seen: NOW - 601 };

	const booted = await boot({ state: baseState({ devices: [ r1, r2, r3, r4 ] }) });
	const ctx = booted.ctx;
	const hooks = booted.hooks;

	const row1 = deviceRowByName(ctx, '客厅电视');

	check('阅读到第 1 台设备行', row1 != null, 'rows=' + repr(deviceNames(ctx)));

	if (row1 != null) {
		const text = textOf(row1);

		check('连接节点取 rx+tx 最大的 chain（HK-01，不是 DIRECT）',
			text.indexOf('连接节点：HK-01') >= 0, text);
		check('接入方式显示「无线」并带相对时间',
			text.indexOf('无线 · 2 分钟前') >= 0, text);
		check('设备行下载速率', text.indexOf('↓ 2.0 Mb/s') >= 0, text);
		check('设备行上传速率', text.indexOf('↑ 1.0 Mb/s') >= 0, text);
	}

	const row2 = deviceRowByName(ctx, '路由器');

	check('阅读到第 2 台设备行', row2 != null, 'rows=' + repr(deviceNames(ctx)));

	if (row2 != null) {
		const text = textOf(row2);

		check('chain 小写 direct 也显示「直连」', text.indexOf('连接节点：直连') >= 0, text);
		check('缺 link 字段 → 未知', text.indexOf('未知 · 刚刚') >= 0, text);
	}

	ctx.setDevTab('offline');

	const row3 = deviceRowByName(ctx, '没有应用');

	check('阅读到离线设备行', row3 != null, 'rows=' + repr(deviceNames(ctx)));

	if (row3 != null) {
		const text = textOf(row3);

		check('无 apps → 连接节点「—」', text.indexOf('连接节点：—') >= 0, text);
		check('link=WIRED（大写）→ 有线；last_seen=0 → 离线',
			text.indexOf('有线 · 离线') >= 0, text);
	}

	const row4 = deviceRowByName(ctx, '久未上报');

	check('过期设备仍在离线 tab 且有行', row4 != null, 'rows=' + repr(deviceNames(ctx)));

	if (row4 != null) {
		const text = textOf(row4);

		check('过期 last_seen 行内明确写「离线」并附相对时间',
			text.indexOf('离线 · 10 分钟前') >= 0, text);
	}

	same('linkOf wifi', hooks.linkOf({ link: 'wifi' }), 'wifi');
	same('linkOf WIFI（大写）', hooks.linkOf({ link: 'WIFI' }), 'wifi');
	same('linkOf wired', hooks.linkOf({ link: 'wired' }), 'wired');
	same('linkOf 非法值 → unknown', hooks.linkOf({ link: 'bogus' }), 'unknown');
	same('linkOf 缺字段 → unknown', hooks.linkOf({}), 'unknown');
	same('linkOf null → unknown', hooks.linkOf(null), 'unknown');

	same('deviceChainLabel 无 apps → —', hooks.deviceChainLabel({}), '—');
	same('deviceChainLabel 空 chain → —',
		hooks.deviceChainLabel({ apps: { a: { rx: 1, tx: 0, chain: '' } } }), '—');
	same('deviceChainLabel MIXED → 混合',
		hooks.deviceChainLabel({ apps: { a: { rx: 1, tx: 0, chain: 'MIXED' } } }), '混合');
	same('deviceChainLabel 普通节点名原样显示',
		hooks.deviceChainLabel({ apps: { a: { rx: 1, tx: 0, chain: 'HK-01' } } }), 'HK-01');

	const apps = hooks.appListOf(r1);

	same('应用明细条数', apps.length, 2);
	same('应用明细按 rx+tx 排序', apps[0].host, 'netflix.com');

	same('rateText 缺值 → —', hooks.rateText(null), '—');
	same('rateText 0 → 0.0 Mb/s', hooks.rateText(0), '0.0 Mb/s');
}

// ---------------------------------------------------------------- 6. 排序 / 筛选

async function testFiltering() {
	console.log('\n[6] 排序与链路筛选：列表顺序/条数正确、不发 RPC');

	const devices = [
		{ mac: 'B', hostname: 'B 设备', link: 'wifi', last_seen: NOW - 10, direct_rx: 300, rx_rate: 100 },
		{ mac: 'A', hostname: 'A 设备', link: 'wired', last_seen: NOW - 10, direct_rx: 100, rx_rate: 500 },
		{ mac: 'C', hostname: 'C 设备', link: 'wifi', last_seen: NOW - 10, direct_rx: 900, rx_rate: 10 }
	];
	const booted = await boot({ state: baseState({ devices: devices }) });
	const ctx = booted.ctx;
	const env = booted.env;
	const callsBefore = env.__calls.length;

	function sortChip(id) {
		return ctx.devSortChips.find(function (item) { return item.id === id; });
	}

	function linkChip(id) {
		return ctx.devLinkChips.find(function (item) { return item.id === id; });
	}

	sameList('默认按合计流量降序', deviceNames(ctx), [ 'C 设备', 'B 设备', 'A 设备' ]);
	same('默认总数 (3)', textOf(ctx.devicesCount), '(3)');

	same('筛选面板默认隐藏', ctx.devFilterPanel.style.display, 'none');
	ctx.devFilterBtn.attrs.click();
	same('点击「筛选」展开面板', ctx.devFilterPanel.style.display, '');
	same('筛选按钮 aria-expanded=true', ctx.devFilterBtn.attrs['aria-expanded'], 'true');
	check('筛选按钮展开时带 .on', hasClass(ctx.devFilterBtn, 'on'),
		'class=' + repr(ctx.devFilterBtn.attrs['class']));

	sortChip('rx').node.attrs.click();
	sameList('点击「下载速率」chip：按 rx_rate 降序', deviceNames(ctx), [ 'A 设备', 'B 设备', 'C 设备' ]);
	check('「下载速率」chip 选中态', hasClass(sortChip('rx').node, 'on'),
		'class=' + repr(sortChip('rx').node.attrs['class']));
	check('「合计流量」chip 取消选中', !hasClass(sortChip('total').node, 'on'),
		'class=' + repr(sortChip('total').node.attrs['class']));

	sortChip('total').node.attrs.click();
	sameList('切回「合计流量」', deviceNames(ctx), [ 'C 设备', 'B 设备', 'A 设备' ]);

	sortChip('name').node.attrs.click();
	sameList('点击「名称」chip：按名称排序', deviceNames(ctx), [ 'A 设备', 'B 设备', 'C 设备' ]);

	linkChip('wifi').node.attrs.click();
	sameList('仅无线（保留名称排序）', deviceNames(ctx), [ 'B 设备', 'C 设备' ]);
	same('仅无线后列表条数', textOf(ctx.devicesCount), '(2)');
	same('链路筛选不改变 tab 分类总数（仍 3 台主网络）', devTabCount(ctx, 'main'), '(3)');
	check('「仅无线」chip 选中态', hasClass(linkChip('wifi').node, 'on'),
		'class=' + repr(linkChip('wifi').node.attrs['class']));

	linkChip('wired').node.attrs.click();
	sameList('仅有线', deviceNames(ctx), [ 'A 设备' ]);
	same('仅有线后列表条数', textOf(ctx.devicesCount), '(1)');
	check('切到有线后无线 chip 取消选中',
		!hasClass(linkChip('wifi').node, 'on') && hasClass(linkChip('wired').node, 'on'),
		'wifi=' + repr(linkChip('wifi').node.attrs['class']) +
		' wired=' + repr(linkChip('wired').node.attrs['class']));

	linkChip('wired').node.attrs.click();
	sameList('再点同一项取消筛选', deviceNames(ctx), [ 'A 设备', 'B 设备', 'C 设备' ]);
	same('取消筛选后条数', textOf(ctx.devicesCount), '(3)');
	check('取消筛选后有线 chip 取消选中', !hasClass(linkChip('wired').node, 'on'),
		'class=' + repr(linkChip('wired').node.attrs['class']));

	ctx.devFilterBtn.attrs.click();
	same('再次点击「筛选」收起面板', ctx.devFilterPanel.style.display, 'none');
	same('筛选按钮 aria-expanded=false', ctx.devFilterBtn.attrs['aria-expanded'], 'false');

	same('排序/筛选全程不发 RPC', env.__calls.length, callsBefore);

	const hooks = booted.hooks;

	sameList('纯函数 deviceViewList：合计流量',
		hooks.deviceViewList(devices, NOW, 'main', 'total', '').map(hooks.deviceName),
		[ 'C 设备', 'B 设备', 'A 设备' ]);
	sameList('纯函数 deviceViewList：访客分类为空',
		hooks.deviceViewList(devices, NOW, 'guest', 'total', '').map(hooks.deviceName), []);
	same('非法链路值 = 不过滤', hooks.filterDevicesByLink(devices, 'bogus').length, 3);

	const beforeOrder = devices.map(hooks.deviceName);

	hooks.sortDevices(devices, 'rx');
	sameList('sortDevices 不修改传入数组', devices.map(hooks.deviceName), beforeOrder);
}

// ---------------------------------------------------------------- 7. 节点屏

async function testNodeScreen() {
	console.log('\n[7] 节点屏：在线/未绑定/未知胶囊、空态、get_nodes 失败隔断');

	const state = baseState({
		totals: {
			direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
			rx_rate: 2500000, tx_rate: 1250000
		},
		devices: [ { mac: 'M1', hostname: '在线', last_seen: NOW - 100 } ]
	});

	const nodes = {
		nodes: [
			{
				node_id: 'n1', name: '客厅节点', ts: NOW - 60, age_sec: 60,
				latest: {
					totals: { direct_rx: 0, direct_tx: 0, proxy_rx: 100, proxy_tx: 200 },
					devices: [ { mac: 'a' }, { mac: 'b' } ]
				}
			},
			{
				node_id: 'n2', name: '车库节点', ts: NOW - 400, age_sec: 400,
				latest: { totals: { direct_rx: 0, direct_tx: 0, proxy_rx: 1, proxy_tx: 1 } }
			},
			{
				node_id: 'n3', name: '旧节点', ts: 0, age_sec: -1,
				latest: { totals: {} }
			}
		]
	};

	const booted = await boot({ state: state, nodes: nodes });
	const ctx = booted.ctx;
	const hooks = booted.hooks;

	await enterPage(ctx, 2);

	same('get_nodes 成功后 nodesOk=true', ctx.nodesOk, true);
	same('节点列表条数', ctx.nodesList.length, 3);
	same('节点屏卡片数量', nodeCards(ctx).length, 3);

	same('age_sec=60 → 在线胶囊', nodePillText(nodeCardByName(ctx, '客厅节点')), '在线');
	same('age_sec=400 → 未绑定胶囊', nodePillText(nodeCardByName(ctx, '车库节点')), '未绑定');
	same('age_sec=-1 → 未知胶囊', nodePillText(nodeCardByName(ctx, '旧节点')), '未知');

	same('nodeStatus(300) = 在线', hooks.nodeStatus(300).kind, 'online');
	same('nodeStatus(301) = 未绑定', hooks.nodeStatus(301).kind, 'unbound');
	same('nodeStatus(-1) = 未知', hooks.nodeStatus(-1).kind, 'unknown');
	same('nodeStatus(undefined) = 未知', hooks.nodeStatus(undefined).kind, 'unknown');

	/* 空数组：节点屏空态，但不影响概览 */
	const emptyBoot = await boot({ state: state, nodes: { nodes: [] } });
	const emptyCtx = emptyBoot.ctx;

	await enterPage(emptyCtx, 2);

	same('空 nodes 数组：nodesOk=true', emptyCtx.nodesOk, true);
	same('空 nodes 数组：列表为空', emptyCtx.nodesList.length, 0);
	same('空 nodes 数组：不渲染节点卡片', nodeCards(emptyCtx).length, 0);
	check('空 nodes 数组：显示空态文案',
		textOf(emptyCtx.nodeHost).indexOf('未配置子节点') >= 0,
		textOf(emptyCtx.nodeHost));
	check('空 nodes 数组：说明原因是本机没有快照',
		textOf(emptyCtx.nodeHost).indexOf('本机 state 目录里没有子节点快照') >= 0,
		textOf(emptyCtx.nodeHost));
	same('空 nodes 数组：概览速率仍正常', textOf(emptyCtx.txNum), '10.0');

	/* get_nodes reject：整页照常，只有节点屏显示原因 */
	const errBoot = await boot({
		state: state,
		rejectNodes: new Error('get_nodes boom')
	});
	const errCtx = errBoot.ctx;

	await enterPage(errCtx, 2);

	check('get_nodes 抛错时 load 不整体 reject（state 仍在）',
		errCtx.state != null && errCtx.error === null,
		'state=' + repr(errCtx.state != null) + ' error=' + repr(errCtx.error));
	same('get_nodes 抛错：nodesOk=false', errCtx.nodesOk, false);
	same('get_nodes 抛错：保留错误文本', errCtx.nodesError, 'get_nodes boom');
	same('get_nodes 抛错：节点列表为空', errCtx.nodesList.length, 0);
	same('get_nodes 抛错：节点屏不渲染卡片', nodeCards(errCtx).length, 0);
	check('get_nodes 抛错：节点屏显示原因',
		textOf(errCtx.nodeHost).indexOf('原因：get_nodes boom') >= 0,
		textOf(errCtx.nodeHost));
	same('get_nodes 抛错：概览速率仍正常', textOf(errCtx.txNum), '10.0');
	same('get_nodes 抛错：设备 tab 数量仍正常', devTabCount(errCtx, 'main'), '(1)');
	same('get_nodes 抛错：页面仍有 5 屏',
		findAll(errCtx.root, function (n) { return hasClass(n, 'tsm-page'); }).length, 5);

	const nodeCallsBefore = countCalls(errBoot.env, 'get_nodes');
	let refreshThrew = false;

	try {
		await errCtx.refresh(false);
	}
	catch (e) {
		refreshThrew = true;
	}

	check('get_nodes 持续失败时 refresh 也不抛错', refreshThrew === false,
		'refreshThrew=' + repr(refreshThrew));
	same('refresh 会重新尝试 get_nodes', countCalls(errBoot.env, 'get_nodes'), nodeCallsBefore + 1);
	same('refresh 后节点屏仍保留失败原因', errCtx.nodesError, 'get_nodes boom');
	same('refresh 后概览数据仍然正常', textOf(errCtx.txNum), '10.0');
}

// ---------------------------------------------------------------- 7b. 拓扑屏

function topoState(overrides) {
	const state = baseState({
		system: { hostname: 'R4S-主路由' },
		health: {
			accounting_confidence: 'exact',
			reasons: [],
			clash_connections: 3,
			link_source: 'brctl',
			link_bridge: 'br-lan'
		},
		totals: {
			direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
			rx_rate: 2500000, tx_rate: 1250000
		},
		nodes: {
			DIRECT: { rx: 1000, tx: 500 },
			'出口节点A': { rx: 4000, tx: 2000 },
			'出口节点B': { rx: 3000, tx: 1000 },
			'出口节点C': { rx: 100, tx: 100 },
			UNKNOWN: { rx: 999999, tx: 0 }
		},
		devices: []
	});
	const devices = [];
	let i;

	for (i = 1; i <= 7; i++) {
		devices.push({
			mac: 'AA:0' + i,
			hostname: (i === 1) ? '手机A' : ((i === 2) ? '平板B' : ('无线' + String.fromCharCode(64 + i))),
			link: 'wifi',
			last_seen: NOW - 20 * i,
			rx_rate: 3000000 - i * 100000,
			tx_rate: 1000000 - i * 10000,
			direct_rx: 100, direct_tx: 100,
			proxy_rx: 0, proxy_tx: 0
		});
	}

	devices.push({ mac: 'BB:01', hostname: '台式机', link: 'wired', last_seen: NOW - 40, rx_rate: 500000, tx_rate: 100000, direct_rx: 200, direct_tx: 200 });
	devices.push({ mac: 'CC:01', hostname: '未知终端', link: 'other', last_seen: NOW - 50, rx_rate: 10000, tx_rate: 10000, direct_rx: 10, direct_tx: 10 });
	devices.push({ mac: 'AA:09', hostname: '离线设备', link: 'wifi', last_seen: NOW - 7000, rx_rate: 1, tx_rate: 1, direct_rx: 1, direct_tx: 1 });

	state.devices = devices;

	const over = overrides || {};

	Object.keys(over).forEach(function (key) { state[key] = over[key]; });

	return state;
}

function topoStations() {
	return {
		enabled: true,
		nodes: [
			{ node_id: 'ap1', name: '客厅 AP', ts: NOW - 60, age_sec: 60, count: 4 },
			{ node_id: 'ap2', name: '车库 AP', ts: NOW - 600, age_sec: 600, count: 1 },
			{ node_id: 'ap3', name: '阁楼 AP', ts: 0, age_sec: -1, count: 0 }
		],
		stations: [
			{ mac: 'aa:01', node_id: 'ap1', node_name: '客厅 AP', iface: 'wlan0', signal: -45, rx_rate: 100, tx_rate: 100, connected_sec: 100, age_sec: 10 },
			{ mac: 'AA:02', node_id: 'ap1', node_name: '客厅 AP', iface: 'wlan0', signal: -55, rx_rate: 100, tx_rate: 100, connected_sec: 100, age_sec: 10 },
			{ mac: 'aa:01', node_id: 'ap1', node_name: '客厅 AP', iface: 'wlan1', signal: -45, rx_rate: 100, tx_rate: 100, connected_sec: 100, age_sec: 10 },
			{ mac: 'ff:ff', node_id: 'ap1', node_name: '客厅 AP', iface: 'wlan0', signal: -70, rx_rate: 1, tx_rate: 1, connected_sec: 1, age_sec: 1 },
			{ mac: 'aa:09', node_id: 'ap2', node_name: '车库 AP', iface: 'wlan0', signal: -80, rx_rate: 1, tx_rate: 1, connected_sec: 1, age_sec: 1 }
		],
		count: 5
	};
}

function topoLayerByLevel(ctx, level) {
	const layers = findAll(ctx.topoHost, function (node) {
		return hasClass(node, 'tsm-tl');
	});

	return layers.find(function (node) { return hasClass(node, 'tsm-tl-' + level); }) || null;
}

function topoExitCards(ctx) {
	return findAll(ctx.topoHost, function (node) { return hasClass(node, 'tsm-exit'); });
}

function topoExitByName(ctx, name) {
	return topoExitCards(ctx).find(function (card) {
		const node = findAll(card, function (n) { return hasClass(n, 'tsm-exit-name'); })[0];

		return node != null && textOf(node) === name;
	}) || null;
}

function topoApCards(ctx) {
	return findAll(ctx.topoHost, function (node) { return hasClass(node, 'tsm-ap'); });
}

function topoApByName(ctx, name) {
	return topoApCards(ctx).find(function (card) {
		const node = findAll(card, function (n) { return hasClass(n, 'tsm-ap-name'); })[0];

		return node != null && textOf(node) === name;
	}) || null;
}

function topoApState(card) {
	const node = findAll(card, function (n) { return hasClass(n, 'tsm-ap-state'); })[0];

	return node ? textOf(node) : null;
}

/* L5 设备层已改为拓扑节点（.tsm-dnode），不再是文字行。 */
function topoRows(ctx) {
	return findAll(ctx.topoHost, function (node) { return hasClass(node, 'tsm-dnode'); });
}

function topoRowByName(ctx, name) {
	return topoRows(ctx).find(function (row) {
		const node = findAll(row, function (n) { return hasClass(n, 'tsm-dnode-name'); })[0];

		return node != null && textOf(node) === name;
	}) || null;
}

function topoDrillRows(root) {
	return findAll(root, function (node) { return hasClass(node, 'tsm-xrow'); });
}

function topoDrillNames(root) {
	return topoDrillRows(root).map(function (row) {
		const name = findAll(row, function (n) { return hasClass(n, 'tsm-xname'); })[0];

		return name ? textOf(name) : null;
	});
}

function clickNode(node) {
	if (node != null && node.listeners != null && Array.isArray(node.listeners.click) &&
		typeof node.listeners.click[0] === 'function')
		node.listeners.click[0]({});
}

function typeSearch(ctx, value) {
	ctx.devSearchInput.attrs.input({ target: { value: value } });
}

async function testTopology() {
	console.log('\n[7b] 拓扑屏：5 层、DIRECT/前 3 出口、主路由、AP 新鲜度、设备分组与切屏展开');

	const booted = await boot({ state: topoState(), stations: topoStations(), nodes: { nodes: [] } });
	const ctx = booted.ctx;
	const hooks = booted.hooks;

	await enterPage(ctx, 3);

	same('get_stations 成功后 stationsOk=true', ctx.stationsOk, true);
	same('AP 节点列表条数', ctx.stationsNodes.length, 3);
	same('station 明细条数', ctx.stationsList.length, 5);

	/* 纯函数 */
	const exits = hooks.topoExitList(topoState().nodes, 3);

	same('出口取前 3 个（含 DIRECT，排除 UNKNOWN）', exits.length, 3);
	sameList('出口按 rx+tx 降序', exits.map(function (e) { return e.name; }),
		[ '出口节点A', '出口节点B', 'DIRECT' ]);
	same('DIRECT 标记 direct=true', exits[2].direct, true);
	same('UNKNOWN 不进入出口列表',
		exits.some(function (e) { return e.name === 'UNKNOWN'; }), false);
	same('节点C 因流量低被前 3 截断',
		exits.some(function (e) { return e.name === '出口节点C'; }), false);

	const counts = hooks.topoLinkCounts(topoState().devices, NOW);

	same('在线分类计数：无线 7', counts.wifi, 7);
	same('在线分类计数：有线 1', counts.wired, 1);
	same('在线分类计数：未知 1', counts.unknown, 1);
	const offlineCounts = hooks.topoLinkCounts(
		[ { mac: 'x', link: 'wifi', last_seen: NOW - 7000 } ], NOW);

	check('离线设备不计入在线分类',
		offlineCounts.wifi === 0 && offlineCounts.wired === 0 && offlineCounts.unknown === 0,
		'counts=' + repr(offlineCounts));

	same('AP age_sec=60 → 在线', hooks.stationFreshness(60).label, '在线');
	same('AP age_sec=300 → 在线（阈值含端点）', hooks.stationFreshness(300).online, true);
	same('AP age_sec=600 → 10 分钟前', hooks.stationFreshness(600).label, '10 分钟前');
	same('AP age_sec=-1 → 未上报', hooks.stationFreshness(-1).label, '未上报');
	same('AP age_sec 缺失 → 未上报', hooks.stationFreshness(undefined).label, '未上报');

	/* 结构：5 层 + 4 段连接线 */
	same('拓扑共 5 层', findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tl'); }).length, 5);
	sameList('层级 aria-label 自上而下',
		findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tl'); })
			.map(function (n) { return n.attrs['aria-label']; }),
		[ '互联网', '出口', '主路由', 'AP / 接入点', '设备' ]);
	same('层间 CSS 连接线 4 段',
		findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-conn'); }).length, 4);
	same('连接线内的小圆点 4 个',
		findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-conn-d'); }).length, 4);

	/* L1 */
	const inet = findAll(topoLayerByLevel(ctx, 1), function (n) { return hasClass(n, 'tsm-inet-txt'); })[0];

	check('L1 显示 WAN 速率（Mbps）',
		inet != null && textOf(inet).indexOf('20.0 Mbps') >= 0 && textOf(inet).indexOf('10.0 Mbps') >= 0,
		'L1=' + repr(inet && textOf(inet)));
	check('L1 是绿色地球 SVG（globeSvg 绿色描边）',
		findAll(topoLayerByLevel(ctx, 1), function (n) { return n.tag === 'svg'; }).length >= 1,
		'svg=' + repr(findAll(topoLayerByLevel(ctx, 1), function (n) { return n.tag === 'svg'; })));

	/* L2 */
	const cards = topoExitCards(ctx);

	same('L2 出口最多 3 张卡', cards.length, 3);
	sameList('L2 卡片顺序按流量降序',
		cards.map(function (card) {
			return textOf(findAll(card, function (n) { return hasClass(n, 'tsm-exit-name'); })[0]);
		}), [ '出口节点A', '出口节点B', 'DIRECT' ]);

	const direct = topoExitByName(ctx, 'DIRECT');
	const proxy = topoExitByName(ctx, '出口节点A');

	check('DIRECT 卡标「直连」',
		direct != null && textOf(direct).indexOf('直连') >= 0,
		'text=' + repr(direct && textOf(direct)));
	check('DIRECT 卡用绿色描边 class',
		hasClass(direct, 'tsm-exit-direct'), 'class=' + repr(direct && direct.attrs['class']));
	check('代理卡用蓝色描边 class',
		hasClass(proxy, 'tsm-exit-proxy') && !hasClass(proxy, 'tsm-exit-direct'),
		'class=' + repr(proxy && proxy.attrs['class']));
	check('出口卡显示总流量 fmtBytes',
		textOf(direct).indexOf('KiB') >= 0, 'text=' + repr(direct && textOf(direct)));

	/* L3 */
	const routerName = findAll(topoLayerByLevel(ctx, 3), function (n) { return hasClass(n, 'tsm-router-name'); })[0];
	const routerMeta = findAll(topoLayerByLevel(ctx, 3), function (n) { return hasClass(n, 'tsm-router-meta'); })[0];
	const routerLinks = findAll(topoLayerByLevel(ctx, 3), function (n) { return hasClass(n, 'tsm-router-links'); })[0];
	const routerOnline = findAll(topoLayerByLevel(ctx, 3), function (n) { return hasClass(n, 'tsm-router-online'); })[0];

	same('L3 主机名取 state.system.hostname', textOf(routerName), 'R4S-主路由');
	check('L3 link_source=brctl 时显示网桥名',
		textOf(routerMeta).indexOf('br-lan') >= 0, 'meta=' + repr(textOf(routerMeta)));
	check('L3 在线设备数复用 activeDeviceCount（9 台）',
		textOf(routerOnline) === '9台在线', 'online=' + repr(textOf(routerOnline)));
	same('L3 无线/有线/未知计数', textOf(routerLinks), '无线 7 / 有线 1 / 未知 1');

	/* L4 */
	same('L4 AP 卡数量 = stations.nodes 数量', topoApCards(ctx).length, 3);
	same('AP 新鲜（60s）→ 在线', topoApState(topoApByName(ctx, '客厅 AP')), '在线');
	same('AP 陈旧（600s）→ 10 分钟前', topoApState(topoApByName(ctx, '车库 AP')), '10 分钟前');
	same('AP age_sec=-1 → 未上报', topoApState(topoApByName(ctx, '阁楼 AP')), '未上报');
	check('AP 下在线设备按 mac 匹配去重（客厅 AP=2 台）',
		textOf(topoApByName(ctx, '客厅 AP')).indexOf('2 台在线') >= 0,
		'text=' + repr(textOf(topoApByName(ctx, '客厅 AP'))));
	check('AP 下离线设备不计数（车库 AP=0 台）',
		textOf(topoApByName(ctx, '车库 AP')).indexOf('0 台在线') >= 0,
		'text=' + repr(textOf(topoApByName(ctx, '车库 AP'))));

	/* L5：三组设备节点网格（不再是文字行） */
	const wifiGroup = findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tgroup-wifi'); })[0];
	const wifiRows = findAll(wifiGroup, function (n) { return hasClass(n, 'tsm-dnode'); });
	const wiredGroup = findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tgroup-wired'); })[0];
	const unknownGroup = findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tgroup-unknown'); })[0];

	same('L5 无线组最多显示 5 台', wifiRows.length, 5);
	check('L5 无线组显示「还有 2 台」',
		textOf(wifiGroup).indexOf('还有 2 台') >= 0, 'group=' + repr(textOf(wifiGroup)));
	same('L5 有线组 1 台',
		findAll(wiredGroup, function (n) { return hasClass(n, 'tsm-dnode'); }).length, 1);
	same('L5 未知组 1 台',
		findAll(unknownGroup, function (n) { return hasClass(n, 'tsm-dnode'); }).length, 1);
	check('L5 组标题保留名称与数量',
		textOf(findByClass(wifiGroup, 'tsm-tgroup-h')).indexOf('无线 7') >= 0 &&
		textOf(findByClass(wiredGroup, 'tsm-tgroup-h')).indexOf('有线 1') >= 0,
		'h=' + repr([ textOf(findByClass(wifiGroup, 'tsm-tgroup-h')),
			textOf(findByClass(wiredGroup, 'tsm-tgroup-h')) ]));
	check('L5 每组都有 SVG 连线覆盖层（树干 + 分叉，按 link 上色）',
		[ [ wifiGroup, 'wifi' ], [ wiredGroup, 'wired' ], [ unknownGroup, 'unknown' ] ]
			.every(function (pair) {
				const bus = findByClass(pair[0], 'tsm-tbus');
				const lines = bus ? findAll(bus, function (n) { return hasClass(n, 'tsm-tline'); }) : [];

				return bus != null && bus.tag === 'svg' && lines.length >= 2 &&
					findAll(bus, function (n) {
						return hasClass(n, 'tsm-tline-' + pair[1]);
					}).length >= 1;
			}),
		'bus=' + repr([ wifiGroup, wiredGroup, unknownGroup ].map(function (group) {
			const bus = findByClass(group, 'tsm-tbus');

			return bus ? findAll(bus, function (n) { return hasClass(n, 'tsm-tline'); }).length : -1;
		})));
	check('L5 设备节点带状态环、类型图标、名称与速率',
		textOf(wifiRows[0]).indexOf('↓') >= 0 &&
		findAll(wifiRows[0], function (n) { return hasClass(n, 'tsm-dnode-ring'); }).length === 1 &&
		findAll(wifiRows[0], function (n) { return n.tag === 'svg'; }).length === 1 &&
		findAll(wifiRows[0], function (n) { return hasClass(n, 'tsm-dnode-name'); }).length === 1,
		'node=' + repr(textOf(wifiRows[0])));
	check('L5 无线组节点挂 is-wifi 状态类',
		hasClass(wifiRows[0], 'is-wifi'),
		'wifiNode=' + repr(wifiRows[0].attrs['class']));
	check('L5 有线组节点挂 is-wired 状态类',
		hasClass(findAll(wiredGroup, function (n) { return hasClass(n, 'tsm-dnode'); })[0], 'is-wired'),
		'wired=' + repr(findAll(wiredGroup, function (n) { return hasClass(n, 'tsm-dnode'); })[0].attrs['class']));

	const row = topoRowByName(ctx, '手机A');

	check('拓扑设备节点 role=button/tabindex=0',
		row != null && row.attrs.role === 'button' && row.attrs.tabindex === '0',
		'row=' + repr(row && row.attrs));

	ctx.setPage(0);
	row.listeners.click[0]({});

	same('点击拓扑设备节点切到设备屏', ctx.pageIndex, 1);
	same('自动定位到主网络设备 tab', ctx.devTab, 'main');

	const devRow = deviceRowByName(ctx, '手机A');

	check('目标设备在设备屏已展开',
		devRow != null && devRow.children[0].attrs['aria-expanded'] === 'true' &&
		devRow.children[1].style.display !== 'none',
		'devRow=' + repr(devRow && devRow.children[0].attrs['aria-expanded']));

	ctx.setPage(0);

	const row2 = topoRowByName(ctx, '平板B');

	row2.listeners.keydown[0]({ key: 'Enter', preventDefault: function () {} });
	same('键盘 Enter 也能切到设备屏', ctx.pageIndex, 1);
	same('键盘 Enter 展开对应设备',
		deviceRowByName(ctx, '平板B').children[0].attrs['aria-expanded'], 'true');

	/* 刷新 sig：数据未变不重建，数据变才重建 */
	const inetBefore = ctx.topoHost.firstChild;
	const sigBefore = ctx.topoSig;

	await ctx.refresh(false);
	same('数据未变：拓扑 sig 不变', ctx.topoSig, sigBefore);
	check('数据未变：拓扑 DOM 不重建', ctx.topoHost.firstChild === inetBefore,
		'firstChild same=' + (ctx.topoHost.firstChild === inetBefore));

	const changed = topoState();

	changed.totals.rx_rate = 5000000;
	changed.totals.tx_rate = 2500000;
	booted.env.__responses.get_state = changed;

	/* 真实时钟固定，但 state.ts 仍是 NOW；轮询会重新取 state */
	await ctx.refresh(false);

	same('数据变化：拓扑 sig 更新', ctx.topoSig !== sigBefore, true);
	check('数据变化：拓扑 DOM 重建', ctx.topoHost.firstChild !== inetBefore,
		'firstChild same=' + (ctx.topoHost.firstChild === inetBefore));
	check('数据变化：L1 WAN 速率更新为 40.0 Mbps',
		textOf(ctx.topoHost).indexOf('40.0 Mbps') >= 0,
		'inL1=' + repr(findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-inet-txt'); })[0] &&
			textOf(findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-inet-txt'); })[0])));

	const rebuilt = ctx.topoHost.firstChild;

	await ctx.refresh(false);
	check('再次刷新同数据：仍不重建', ctx.topoHost.firstChild === rebuilt,
		'firstChild same=' + (ctx.topoHost.firstChild === rebuilt));

	/* 无出口数据 / 无在线设备 / 无 AP 数据的空态 */
	const emptyBoot = await boot({ state: baseState(), stations: { enabled: true, nodes: [], stations: [], count: 1 }, nodes: { nodes: [] } });

	await enterPage(emptyBoot.ctx, 3);

	const emptyText = textOf(emptyBoot.ctx.pages[3]);

	check('无出口数据 → 暂无出口数据', emptyText.indexOf('暂无出口数据') >= 0, emptyText.slice(0, 200));
	check('无 AP 数据 → 暂无 AP 数据', emptyText.indexOf('暂无 AP 数据') >= 0, emptyText.slice(0, 240));
	check('无在线设备 → 暂无在线设备', emptyText.indexOf('暂无在线设备') >= 0, emptyText.slice(0, 240));
	check('没有 hostname 时回退「主路由」', emptyText.indexOf('主路由') >= 0, emptyText.slice(0, 200));
}

// ---------------------------------------------------------------- 7d. 设备类型图标 + 概览设备拓扑

function ovTopoRows(ctx) {
	return findAll(ctx.ovTopoHost, function (node) { return hasClass(node, 'tsm-dnode'); });
}

function ovTopoRowByName(ctx, name) {
	return ovTopoRows(ctx).find(function (node) {
		const label = findAll(node, function (n) { return hasClass(n, 'tsm-dnode-name'); })[0];

		return label != null && textOf(label) === name;
	}) || null;
}

async function testDeviceKindOf() {
	console.log('\n[7d] 设备类型：deviceKindOf 关键词分类 + 自绘线条 SVG 图标');

	const booted = await boot({ state: baseState() });
	const kindOf = booted.hooks.deviceKindOf;

	same('iPhone（混合大小写）→ phone', kindOf({ hostname: 'iPhone-15' }), 'phone');
	same('ANDROID 大写 → phone', kindOf({ hostname: 'ANDROID-9' }), 'phone');
	same('vivo（alias）→ phone', kindOf({ alias: 'vivo X90' }), 'phone');
	same('OPPO 大写 → phone', kindOf({ hostname: 'OPPO-Reno' }), 'phone');
	same('huawei → phone', kindOf({ hostname: 'HUAWEI-P40' }), 'phone');
	same('mi 按词边界 → phone', kindOf({ hostname: 'MI-11' }), 'phone');
	same('中文「手机」→ phone', kindOf({ hostname: '华为手机' }), 'phone');
	same('MacBook → laptop', kindOf({ hostname: 'MacBook-Pro' }), 'laptop');
	same('windows/desktop → laptop', kindOf({ hostname: 'WIN-DESKTOP' }), 'laptop');
	same('linux → laptop', kindOf({ hostname: 'linux-box' }), 'laptop');
	same('pc 按词边界 → laptop', kindOf({ alias: 'pc-01' }), 'laptop');
	same('中文「电脑」→ laptop', kindOf({ hostname: '台式电脑' }), 'laptop');
	same('TVBOX → tv', kindOf({ hostname: 'TVBOX' }), 'tv');
	same('Apple TV → tv', kindOf({ alias: 'Apple TV' }), 'tv');
	same('Android-TV 先判电视', kindOf({ hostname: 'Android-TV' }), 'tv');
	same('roku → tv', kindOf({ hostname: 'Roku-Stick' }), 'tv');
	same('中文「电视」→ tv', kindOf({ hostname: '客厅电视' }), 'tv');
	same('iPad → tablet', kindOf({ hostname: 'iPad-Air' }), 'tablet');
	same('tablet → tablet', kindOf({ alias: 'Tablet-2' }), 'tablet');
	same('中文「平板」→ tablet', kindOf({ hostname: '客厅平板' }), 'tablet');
	same('camera → iot', kindOf({ hostname: 'Camera-01' }), 'iot');
	same('echo → iot', kindOf({ hostname: 'Echo-Dot' }), 'iot');
	same('HomePod mini → iot（mini 里的 mi 不误判手机）', kindOf({ hostname: 'HomePod mini' }), 'iot');
	same('bulb/plug → iot', kindOf({ alias: 'LED Bulb Plug' }), 'iot');
	same('无法识别的名称 → unknown', kindOf({ hostname: 'unknown-device' }), 'unknown');
	same('hostname/alias 都为空 → unknown', kindOf({}), 'unknown');
	same('null → unknown', kindOf(null), 'unknown');

	const kinds = [ 'phone', 'laptop', 'tv', 'tablet', 'iot', 'unknown' ];

	kinds.forEach(function (kind) {
		const svg = booted.hooks.deviceKindSvg(kind, '#2b7de9');
		const shapeTags = [ 'rect', 'path', 'circle', 'ellipse', 'line' ];

		check('deviceKindSvg(' + kind + ') 是 24px 自绘线条 SVG',
			svg != null && svg.tag === 'svg' && svg.attrs.viewBox === '0 0 24 24' &&
			svg.children.length >= 2 &&
			svg.children.every(function (child) {
				return child.namespace === 'http://www.w3.org/2000/svg' &&
					shapeTags.indexOf(child.tag) >= 0 &&
					(child.attrs.stroke === '#2b7de9' || child.attrs.fill === '#2b7de9');
			}),
			'svg=' + repr(svg && svg.children.map(function (c) { return c.tag; })));
	});

	check('图标只用线条图形（无 <text>、无 emoji 文本节点）',
		kinds.every(function (kind) {
			const svg = booted.hooks.deviceKindSvg(kind, '#000');

			return findAll(svg, function (n) { return n.tag === 'text'; }).length === 0 &&
				svg.children.every(function (child) { return typeof child === 'object'; });
		}),
		'icons=' + repr(kinds));
}

function overviewTopoDevices(list) {
	return list.map(function (item, index) {
		return {
			mac: 'OT' + index,
			hostname: item.hostname,
			link: item.link,
			last_seen: NOW - 20 - index,
			rx_rate: item.rx_rate,
			tx_rate: item.tx_rate
		};
	});
}

async function testOverviewTopo() {
	console.log('\n[7e] 概览设备拓扑：主路由根节点 + 两列在线节点 + SVG 连线 + 点击下钻');

	const devices = overviewTopoDevices([
		{ hostname: 'iPhone 15', link: 'wifi', rx_rate: 150000, tx_rate: 20000 },
		{ hostname: 'MacBook Air', link: 'wifi', rx_rate: 750000, tx_rate: 100000 },
		{ hostname: '客厅电视', link: 'wired', rx_rate: 300000, tx_rate: 50000 },
		{ hostname: '离线终端', link: 'wifi', rx_rate: 1, tx_rate: 1 }
	]);

	/* 最后一台置为离线：只应出现在设备屏离线分类，不进拓扑 */
	devices[3].last_seen = NOW - 9000;

	const booted = await boot({ state: topoState({ devices: devices }) });
	const ctx = booted.ctx;

	check('概览屏出现设备拓扑区块', ctx.ovTopoHost != null &&
		hasClass(ctx.ovTopoHost, 'tsm-otopo'), 'host=' + repr(ctx.ovTopoHost && ctx.ovTopoHost.attrs));

	const root = findByClass(ctx.ovTopoHost, 'tsm-otop-root');
	const grid = findByClass(ctx.ovTopoHost, 'tsm-otop-grid');

	check('主路由根节点存在且显示 hostname',
		root != null && textOf(root).indexOf('R4S-主路由') >= 0 &&
		findAll(root, function (n) { return n.tag === 'svg'; }).length === 1,
		'root=' + repr(root && textOf(root)));
	check('设备拓扑区块在「N 台终端」胶囊之后、累计口径说明之前',
		ctx.pages[0].children.indexOf(ctx.ovTopoHost) ===
			ctx.pages[0].children.indexOf(findByClass(ctx.pages[0], 'tsm-foot')) + 1 &&
		ctx.pages[0].children.indexOf(ctx.moreBox) ===
			ctx.pages[0].children.indexOf(ctx.ovTopoHost) + 1,
		'order=' + repr(ctx.pages[0].children.map(function (n) {
			return (n && n.attrs && n.attrs['class']) || n;
		})));

	same('在线终端 3 台 → 3 个设备节点', ovTopoRows(ctx).length, 3);
	check('节点名称正确（离线终端不出现）',
		ovTopoRows(ctx).map(function (node) {
			return textOf(findByClass(node, 'tsm-dnode-name'));
		}).sort().join(',') === 'MacBook Air,iPhone 15,客厅电视',
		'names=' + repr(ovTopoRows(ctx).map(function (node) {
			return textOf(findByClass(node, 'tsm-dnode-name'));
		})));
	check('节点速率小字 = ↓ + Mb/s',
		textOf(ovTopoRowByName(ctx, 'iPhone 15')).indexOf('↓ 1.2 Mb/s') >= 0,
		'node=' + repr(textOf(ovTopoRowByName(ctx, 'iPhone 15'))));
	check('节点 title 同时给出上行/下行',
		String(ovTopoRowByName(ctx, 'MacBook Air').attrs.title).indexOf('6.0 Mb/s') >= 0 &&
		String(ovTopoRowByName(ctx, 'MacBook Air').attrs.title).indexOf('上行') >= 0,
		'title=' + repr(ovTopoRowByName(ctx, 'MacBook Air').attrs.title));
	check('每台设备节点都有状态环与类型图标',
		ovTopoRows(ctx).every(function (node) {
			return findAll(node, function (n) { return hasClass(n, 'tsm-dnode-ring'); }).length === 1 &&
				findAll(node, function (n) { return n.tag === 'svg'; }).length === 1;
		}),
		'nodes=' + repr(ovTopoRows(ctx).map(function (n) { return textOf(n); })));

	const bus = findByClass(ctx.ovTopoHost, 'tsm-tbus');
	const lines = bus ? findAll(bus, function (n) { return hasClass(n, 'tsm-tline'); }) : [];

	check('根节点与设备之间有 SVG 连线（树干 + 3 条分叉）',
		grid != null && bus != null && bus.tag === 'svg' && lines.length === 4,
		'lines=' + repr(lines.map(function (n) { return n.attrs['class']; })));
	check('连线按链路类型着色：无线蓝 / 有线绿',
		findAll(bus, function (n) { return hasClass(n, 'tsm-tline-wifi'); }).length === 2 &&
		findAll(bus, function (n) { return hasClass(n, 'tsm-tline-wired'); }).length === 1,
		'links=' + repr(findAll(bus, function (n) { return hasClass(n, 'tsm-tline'); })
			.map(function (n) { return n.attrs['class']; })));

	const node = ovTopoRowByName(ctx, '客厅电视');

	check('概览设备节点 role=button/tabindex=0',
		node != null && node.attrs.role === 'button' && node.attrs.tabindex === '0',
		'node=' + repr(node && node.attrs));

	ctx.setPage(0);
	node.listeners.click[0]({});

	same('点击概览设备节点切到设备屏', ctx.pageIndex, 1);

	const devRow = deviceRowByName(ctx, '客厅电视');

	check('点击后目标设备在设备屏已展开',
		devRow != null && devRow.children[0].attrs['aria-expanded'] === 'true' &&
		devRow.children[1].style.display !== 'none',
		'devRow=' + repr(devRow && devRow.children[0].attrs['aria-expanded']));

	ctx.setPage(0);

	const node2 = ovTopoRowByName(ctx, 'iPhone 15');

	node2.listeners.keydown[0]({ key: 'Enter', preventDefault: function () {} });
	same('键盘 Enter 也切到设备屏', ctx.pageIndex, 1);
	same('键盘 Enter 展开对应设备',
		deviceRowByName(ctx, 'iPhone 15').children[0].attrs['aria-expanded'], 'true');

	/* 0 台在线：只给占位，不造假节点 */
	const emptyBoot = await boot({ state: topoState({
		devices: [ { mac: 'OFF1', hostname: '离线终端', link: 'wifi', last_seen: NOW - 9000 } ]
	}) });

	check('0 台在线 → 「暂无在线设备」占位', textOf(emptyBoot.ctx.ovTopoHost).indexOf('暂无在线设备') >= 0,
		'text=' + repr(textOf(emptyBoot.ctx.ovTopoHost)));
	same('0 台在线 → 0 个设备节点', ovTopoRows(emptyBoot.ctx).length, 0);
	check('0 台在线 → 根节点仍在（不伪造子节点）',
		findByClass(emptyBoot.ctx.ovTopoHost, 'tsm-otop-root') != null &&
		findByClass(emptyBoot.ctx.ovTopoHost, 'tsm-tbus') == null,
		'root=' + repr(textOf(emptyBoot.ctx.ovTopoHost)));

	/* 9 台在线：8 个节点 + 「还有 1 台」 */
	const many = [];

	for (let i = 1; i <= 9; i++)
		many.push({ hostname: '终端' + i, link: (i % 2) ? 'wifi' : 'wired', rx_rate: i * 100000, tx_rate: 1000 });

	const manyBoot = await boot({ state: topoState({ devices: overviewTopoDevices(many) }) });
	const manyCtx = manyBoot.ctx;

	same('9 台在线 → 最多显示 8 个节点', ovTopoRows(manyCtx).length, 8);
	check('9 台在线 → 末尾显示「还有 1 台」',
		textOf(manyCtx.ovTopoHost).indexOf('还有 1 台') >= 0,
		'text=' + repr(textOf(manyCtx.ovTopoHost).slice(-60)));
	check('第 9 台不生成节点',
		ovTopoRowByName(manyCtx, '终端9') == null,
		'names=' + repr(ovTopoRows(manyCtx).map(function (n) {
			return textOf(findByClass(n, 'tsm-dnode-name'));
		})));
}

async function testTopologyDegrade() {
	console.log('\n[7c] 拓扑降级：get_stations / get_nodes 失败不影响其它屏');

	const state = topoState();

	/* 只有 get_stations 失败，get_nodes 有子节点：AP 层降级但仍显示名称 + 上报时间 */
	const degBoot = await boot({
		state: state,
		rejectStations: new Error('get_stations boom'),
		nodes: { nodes: [ { node_id: 'n1', name: '子节点X', ts: NOW - 120, age_sec: 120, latest: {} } ] }
	});
	const ctx = degBoot.ctx;

	await enterPage(ctx, 3);

	const apText = textOf(topoLayerByLevel(ctx, 4));

	same('get_stations 失败：stationsOk=false', ctx.stationsOk, false);
	same('get_stations 失败：保留错误文本', ctx.stationsError, 'get_stations boom');
	check('get_stations 失败：拓扑 AP 层显示降级文案',
		apText.indexOf('AP 数据不可用') >= 0, apText);
	check('get_stations 失败：回退 get_nodes 名称',
		apText.indexOf('子节点X') >= 0, apText);
	check('get_stations 失败：回退卡片显示上报时间',
		apText.indexOf('上报') >= 0 && apText.indexOf('2 分钟前') >= 0, apText);
	same('get_stations 失败：概览照常', textOf(ctx.txNum), '10.0');
	same('get_stations 失败：页面仍是 5 屏',
		findAll(ctx.root, function (n) { return hasClass(n, 'tsm-page'); }).length, 5);
	same('get_stations 失败：其它拓扑层照常（出口 3 张卡）', topoExitCards(ctx).length, 3);

	/* get_stations + get_nodes 同时失败：AP 层降级，节点屏/概览/设备屏照常 */
	const bothBoot = await boot({
		state: state,
		rejectStations: new Error('stations boom'),
		rejectNodes: new Error('nodes boom')
	});
	const bothCtx = bothBoot.ctx;

	await enterPage(bothCtx, 3);

	check('两者都失败：AP 层仍是「AP 数据不可用」',
		textOf(topoLayerByLevel(bothCtx, 4)).indexOf('AP 数据不可用') >= 0,
		textOf(topoLayerByLevel(bothCtx, 4)));
	same('两者都失败：节点屏仍显示失败原因',
		bothCtx.nodesError, 'nodes boom');
	check('两者都失败：节点屏空态仍带原因',
		textOf(bothCtx.nodeHost).indexOf('原因：nodes boom') >= 0,
		textOf(bothCtx.nodeHost));
	same('两者都失败：概览速率仍正常', textOf(bothCtx.txNum), '10.0');
	same('两者都失败：拓扑其它层照常', topoExitCards(bothCtx).length, 3);
	same('两者都失败：设备 tab 数量仍正常', devTabCount(bothCtx, 'main'), '(9)');

	let refreshThrew = false;
	const stationCallsBefore = countCalls(bothBoot.env, 'get_stations');

	try {
		await bothCtx.refresh(false);
	}
	catch (e) {
		refreshThrew = true;
	}

	check('持续失败时 refresh 也不抛错', refreshThrew === false, 'refreshThrew=' + repr(refreshThrew));
	same('refresh 会重新尝试 get_stations',
		countCalls(bothBoot.env, 'get_stations'), stationCallsBefore + 1);
	same('refresh 后概览数据仍然正常', textOf(bothCtx.txNum), '10.0');

	/* state 完全不可用：拓扑只显示「暂无数据」，其余屏也不留白 */
	const stateBoot = await boot({ rejectState: new Error('state boom') });
	const stateCtx = stateBoot.ctx;

	await enterPage(stateCtx, 3);

	check('state 不可用：拓扑显示「暂无数据」',
		textOf(stateCtx.pages[3]).indexOf('暂无数据') >= 0,
		textOf(stateCtx.pages[3]).slice(0, 160));
	same('state 不可用：页面仍是 5 屏',
		findAll(stateCtx.root, function (n) { return hasClass(n, 'tsm-page'); }).length, 5);
	check('state 不可用：拓扑不渲染任何层',
		findAll(stateCtx.topoHost, function (n) { return hasClass(n, 'tsm-tl'); }).length === 0,
		'host=' + repr(textOf(stateCtx.topoHost)));
}

// ---------------------------------------------------------------- 13b. 拓扑静态样式

async function testTopoStyles() {
	console.log('\n[13b] 静态：拓扑主题变量 / 深色媒体查询 / 320px 省略');

	check('卡片颜色走 CSS 变量（--tsm-card-bg / --tsm-line / --tsm-sub）',
		/--tsm-card-bg:#fff/.test(SOURCE) && /--tsm-line:rgba\(0,0,0,\.06\)/.test(SOURCE) &&
		/--tsm-sub:#8a8f98/.test(SOURCE),
		'vars=' + repr(SOURCE.match(/--tsm-[a-z-]+:[^;}]*/g)));
	check('拓扑 DIRECT 绿描边 / 代理蓝描边',
		/\.tsm-exit-direct\{[^}]*var\(--tsm-green\)/.test(SOURCE) &&
		/\.tsm-exit-proxy\{[^}]*var\(--tsm-blue\)/.test(SOURCE),
		'direct=' + repr(SOURCE.match(/\.tsm-exit-direct\{[^}]*\}/g)) +
		' proxy=' + repr(SOURCE.match(/\.tsm-exit-proxy\{[^}]*\}/g)));
	check('层间连接线是 CSS 1px 竖线 + 圆点',
		/\.tsm-conn::before\{[^}]*width:1px/.test(SOURCE) && /\.tsm-conn-d\{[^}]*border-radius:50%/.test(SOURCE),
		'conn=' + repr(SOURCE.match(/\.tsm-conn[^{]*\{[^}]*\}/g)));

	const dark = SOURCE.match(/@media \(prefers-color-scheme: dark\)\{[\s\S]*?\}\}/);

	check('存在深色主题媒体查询', dark != null,
		'dark=' + repr(SOURCE.match(/@media \(prefers-color-scheme:[^)]*\)/g)));
	check('深色主题覆盖卡片背景/分隔线/次级文字',
		dark != null && dark[0].indexOf('--tsm-card-bg:#1c2026') >= 0 &&
		dark[0].indexOf('--tsm-line:rgba(255,255,255,.1)') >= 0 &&
		dark[0].indexOf('--tsm-sub:#a4abb5') >= 0,
		'dark=' + repr(dark && dark[0].slice(0, 200)));
	check('深色主题不用纯黑（无 #000）',
		dark != null && dark[0].indexOf('#000') < 0,
		'dark=' + repr(dark && dark[0].slice(0, 200)));
	check('深色主题保留强调色（橙/绿/蓝变量不变）',
		dark != null && dark[0].indexOf('--tsm-accent') < 0 &&
		dark[0].indexOf('--tsm-green') < 0 && dark[0].indexOf('--tsm-blue') < 0,
		'dark=' + repr(dark && dark[0].slice(0, 200)));

	const small = SOURCE.match(/@media \(max-width:320px\)\{[\s\S]*?\}\}/);

	check('存在 320px 媒体查询', small != null,
		'small=' + repr(SOURCE.match(/@media \(max-width:[^)]*\)/g)));
	check('320px 下拓扑卡片文字省略',
		small != null && small[0].indexOf('.tsm-topo') >= 0 &&
		small[0].indexOf('text-overflow:ellipsis') >= 0,
		'small=' + repr(small && small[0].slice(0, 240)));
	check('320px 下拓扑层间距收紧',
		small != null && small[0].indexOf('.tsm-topo .tsm-conn{height:14px}') >= 0,
		'small=' + repr(small && small[0].slice(0, 240)));

	/* 设备节点 / 连线：两列网格、1.5px 状态环、1px 连线、按 link 上色 */
	const gridRule = SOURCE.match(/\.tsm-tgroup-body,\.tsm-tnodes,\.tsm-otop-grid\{[^}]*\}/);
	const ringRule = SOURCE.match(/\.tsm-dnode-ring\{[^}]*\}/);
	const lineRule = SOURCE.match(/\.tsm-tline\{[^}]*\}/);

	check('设备节点网格固定两列（minmax(0,1fr) 不横向溢出）',
		gridRule != null && gridRule[0].indexOf('grid-template-columns:repeat(2,minmax(0,1fr))') >= 0,
		'grid=' + repr(gridRule));
	check('设备节点自身没有固定像素宽度（靠网格自适应）',
		!/\.tsm-dnode\{[^}]*\bwidth:\s*\d+px/.test(SOURCE) &&
		/\.tsm-dnode\{[^}]*min-width:0/.test(SOURCE),
		'node=' + repr(SOURCE.match(/\.tsm-dnode\{[^}]*\}/)));
	check('状态环 1.5px、连线 1px（线宽符合要求）',
		ringRule != null && ringRule[0].indexOf('border:1.5px solid') >= 0 &&
		lineRule != null && lineRule[0].indexOf('stroke-width:1;') >= 0,
		'ring=' + repr(ringRule) + ' line=' + repr(lineRule));
	check('连线颜色：无线 --tsm-blue / 有线 --tsm-green / 未知 --tsm-sub',
		/\.tsm-tline-wifi\{[^}]*stroke:var\(--tsm-blue\)/.test(SOURCE) &&
		/\.tsm-tline-wired\{[^}]*stroke:var\(--tsm-green\)/.test(SOURCE) &&
		/\.tsm-tline-unknown\{[^}]*stroke:var\(--tsm-sub\)/.test(SOURCE),
		'lines=' + repr(SOURCE.match(/\.tsm-tline-[a-z]+\{[^}]*\}/g)));
	check('320px 媒体查询仍把节点网格钉成两列',
		small != null &&
		small[0].indexOf('.tsm-tgroup-body,.tsm-otop-grid{grid-template-columns:repeat(2,minmax(0,1fr))}') >= 0,
		'small=' + repr(small && small[0].slice(0, 240)));
	check('深色主题下连线仍走变量（--tsm-line-strong 由深色块覆盖）',
		dark != null && dark[0].indexOf('--tsm-line-strong:rgba(255,255,255,.18)') >= 0 &&
		lineRule != null && lineRule[0].indexOf('stroke:var(--tsm-line-strong)') >= 0,
		'dark=' + repr(dark && dark[0].slice(0, 160)));

	const booted = await boot({ state: topoState(), stations: topoStations() });
	const ctx = booted.ctx;

	await enterPage(ctx, 3);

	same('拓扑容器 role=list', ctx.topoHost.attrs.role, 'list');
	check('拓扑容器 aria-label 描述自顶向下层级',
		String(ctx.topoHost.attrs['aria-label']).indexOf('网络拓扑') >= 0,
		'aria=' + repr(ctx.topoHost.attrs['aria-label']));
	check('每层都是 role=listitem',
		findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tl'); })
			.every(function (n) { return n.attrs.role === 'listitem' && n.attrs['aria-label'] != null; }),
		'layers=' + repr(findAll(ctx.topoHost, function (n) { return hasClass(n, 'tsm-tl'); })
			.map(function (n) { return n.attrs; })));
	check('拓扑设备行都 role=button + tabindex=0',
		topoRows(ctx).every(function (row) {
			return row.attrs.role === 'button' && row.attrs.tabindex === '0';
		}), 'rows=' + repr(topoRows(ctx).map(function (row) { return row.attrs; })));
}

// ---------------------------------------------------------------- 14. 懒加载

async function testLazyNodeData() {
	console.log('\n[14] 懒加载：首屏只 get_state；首次进节点/拓扑才补拉 get_nodes/get_stations');

	const booted = await boot({ state: topoState(), stations: topoStations() });
	const ctx = booted.ctx;
	const env = booted.env;

	same('首屏只调用 get_state 一次', countCalls(env, 'get_state'), 1);
	same('首屏不拉 get_nodes', countCalls(env, 'get_nodes'), 0);
	same('首屏不拉 get_stations', countCalls(env, 'get_stations'), 0);
	same('节点数据尚未加载', ctx.nodeDataLoaded, false);
	check('节点屏先显示加载占位',
		textOf(ctx.nodeHost).indexOf('正在加载节点数据') >= 0, textOf(ctx.nodeHost));

	ctx.setPage(3);
	same('切到拓扑补拉 get_nodes 一次', countCalls(env, 'get_nodes'), 1);
	same('切到拓扑补拉 get_stations 一次', countCalls(env, 'get_stations'), 1);
	same('切屏不额外重发 get_state', countCalls(env, 'get_state'), 1);

	await ctx.ensureNodeData();
	await flush();

	same('拓扑数据到位 stationsOk=true', ctx.stationsOk, true);
	same('拓扑 AP 卡已渲染', topoApCards(ctx).length, 3);
	check('节点屏加载完成后显示节点卡片/空态，不再占位',
		textOf(ctx.nodeHost).indexOf('正在加载节点数据') < 0, textOf(ctx.nodeHost));

	ctx.setPage(0);
	await flush();
	ctx.setPage(3);
	await ctx.ensureNodeData();
	await flush();

	same('切走再回来不重复拉 get_nodes', countCalls(env, 'get_nodes'), 1);
	same('切走再回来不重复拉 get_stations', countCalls(env, 'get_stations'), 1);

	const stateCallsBefore = countCalls(env, 'get_state');
	const nodeCallsBefore = countCalls(env, 'get_nodes');
	const stationCallsBefore = countCalls(env, 'get_stations');

	ctx.setPage(0);
	await flush();
	await ctx.refresh(false);

	same('概览屏 refresh 仍刷新 get_state', countCalls(env, 'get_state'), stateCallsBefore + 1);
	same('概览屏 refresh 不拉 get_nodes', countCalls(env, 'get_nodes'), nodeCallsBefore);
	same('概览屏 refresh 不拉 get_stations', countCalls(env, 'get_stations'), stationCallsBefore);

	ctx.setPage(3);
	await ctx.refresh(false);

	same('拓扑屏 refresh 会刷新 get_nodes', countCalls(env, 'get_nodes'), nodeCallsBefore + 1);
	same('拓扑屏 refresh 会刷新 get_stations', countCalls(env, 'get_stations'), stationCallsBefore + 1);

	/* 两个分支互不影响：get_nodes 失败时 AP 层仍用 get_stations 正常渲染 */
	const failBoot = await boot({
		state: topoState(),
		stations: topoStations(),
		rejectNodes: new Error('nodes down')
	});

	await enterPage(failBoot.ctx, 3);

	same('get_nodes 失败不影响 get_stations', failBoot.ctx.stationsOk, true);
	same('get_nodes 失败时拓扑 AP 卡仍渲染', topoApCards(failBoot.ctx).length, 3);
	same('get_nodes 失败原因保留在节点屏', failBoot.ctx.nodesError, 'nodes down');
	check('get_nodes 失败不影响概览',
		textOf(failBoot.ctx.txNum) === '10.0', textOf(failBoot.ctx.txNum));
}

// ---------------------------------------------------------------- 15. 拓扑下钻

async function testTopoDrilldown() {
	console.log('\n[15] 拓扑下钻：出口/AP 卡展开在线设备、空态、刷新保留');

	const devices = [
		{
			mac: 'AA:01', hostname: '出口A手机', link: 'wifi', last_seen: NOW - 10,
			rx_rate: 1000000, tx_rate: 500000, direct_rx: 4000, direct_tx: 1000,
			apps: { 'video.example': { rx: 500, tx: 100, chain: '出口 A' } }
		},
		{
			mac: 'AA:02', hostname: '出口A平板', link: 'wired', last_seen: NOW - 20,
			rx_rate: 200000, tx_rate: 100000, direct_rx: 3000, direct_tx: 1000,
			apps: { 'web.example': { rx: 100, tx: 50, chain: '出口 A' } }
		},
		{
			mac: 'AA:03', hostname: '出口A离线', link: 'wifi', last_seen: NOW - 7000,
			direct_rx: 9000, direct_tx: 9000,
			apps: { 'x.example': { rx: 1, tx: 1, chain: '出口 A' } }
		},
		{
			mac: 'DD:01', hostname: '直连电视', link: 'wifi', last_seen: NOW - 30,
			rx_rate: 100000, tx_rate: 50000, direct_rx: 200, direct_tx: 100,
			apps: { 'tv.example': { rx: 10, tx: 5, chain: 'direct' } }
		},
		{
			mac: 'DD:02', hostname: '直连离线', link: 'wifi', last_seen: NOW - 7000,
			direct_rx: 50, direct_tx: 50,
			apps: { 'x.example': { rx: 1, tx: 1, chain: 'DIRECT' } }
		}
	];
	const state = baseState({
		system: { hostname: 'R4S' },
		nodes: {
			'出口 A': { rx: 3000, tx: 1000 },
			'出口 B': { rx: 100, tx: 100 },
			DIRECT: { rx: 50, tx: 50 }
		},
		devices: devices
	});
	const stations = {
		enabled: true,
		nodes: [
			{ node_id: 'ap1', name: '客厅 AP', ts: NOW - 30, age_sec: 30 },
			{ node_id: 'ap2', name: '车库 AP', ts: NOW - 30, age_sec: 30 },
			{ node_id: 'ap3', name: '阁楼 AP', ts: 0, age_sec: -1 }
		],
		stations: [
			{ mac: 'AA:01', node_id: 'ap1', signal: -45 },
			{ mac: 'AA:02', node_id: 'ap1', signal: -60 },
			{ mac: 'DD:01', node_id: 'ap2', signal: -70 },
			{ mac: 'AA:03', node_id: 'ap2', signal: -80 }
		],
		count: 4
	};

	const booted = await boot({ state: state, stations: stations });
	const ctx = booted.ctx;
	const hooks = booted.hooks;

	await enterPage(ctx, 3);

	/* 出口 A：两台在线 + 一台离线（离线不列） */
	const aCard = topoExitByName(ctx, '出口 A');
	const aDetail = findAll(aCard, function (n) { return hasClass(n, 'tsm-xlist'); })[0];

	check('出口卡 role=button/tabindex=0',
		aCard != null && aCard.attrs.role === 'button' && aCard.attrs.tabindex === '0',
		'card=' + repr(aCard && aCard.attrs));
	same('出口卡初始 aria-expanded=false', aCard.attrs['aria-expanded'], 'false');
	same('出口设备列表初始隐藏', aDetail.style.display, 'none');

	clickNode(aCard);
	same('点击出口卡展开列表', aDetail.style.display, '');
	same('展开后 aria-expanded=true', aCard.attrs['aria-expanded'], 'true');
	check('展开后出口卡带 .open', hasClass(aCard, 'open'), 'class=' + repr(aCard.attrs['class']));
	sameList('出口 A 下只列 2 台在线设备（离线不列）',
		topoDrillNames(aCard), [ '出口A手机', '出口A平板' ]);
	check('出口设备行显示 ↓↑ 速率',
		textOf(aDetail).indexOf('↓ 8.0 Mb/s') >= 0 && textOf(aDetail).indexOf('↑ 4.0 Mb/s') >= 0,
		'detail=' + repr(textOf(aDetail)));

	clickNode(aCard);
	same('再次点击出口卡收起', aDetail.style.display, 'none');
	same('收起后 aria-expanded=false', aCard.attrs['aria-expanded'], 'false');

	/* DIRECT 卡：chain='direct' 大小写不敏感 */
	const dCard = topoExitByName(ctx, 'DIRECT');
	const dDetail = findAll(dCard, function (n) { return hasClass(n, 'tsm-xlist'); })[0];

	clickNode(dCard);
	sameList('DIRECT 卡匹配 chain=direct（大小写不敏感）', topoDrillNames(dCard), [ '直连电视' ]);
	same('DIRECT 卡展开', dDetail.style.display, '');

	/* 没有设备的出口给空态 */
	const bCard = topoExitByName(ctx, '出口 B');
	const bDetail = findAll(bCard, function (n) { return hasClass(n, 'tsm-xlist'); })[0];

	clickNode(bCard);
	sameList('出口 B 无设备列表为空', topoDrillNames(bCard), []);
	check('出口 B 显示「该出口暂无设备」',
		textOf(bDetail).indexOf('该出口暂无设备') >= 0, textOf(bDetail));

	bCard.listeners.keydown[0]({ key: ' ', preventDefault: function () {} });
	same('Space 键也能收起出口卡', bDetail.style.display, 'none');

	/* AP 卡：node_id + mac 命中在线设备，且只显示该 AP 的 */
	const ap1 = topoApByName(ctx, '客厅 AP');
	const ap1Detail = findAll(ap1, function (n) { return hasClass(n, 'tsm-xlist'); })[0];

	check('AP 卡 role=button/tabindex=0',
		ap1 != null && ap1.attrs.role === 'button' && ap1.attrs.tabindex === '0',
		'card=' + repr(ap1 && ap1.attrs));

	clickNode(ap1);
	sameList('客厅 AP 只列本 AP 在线设备', topoDrillNames(ap1), [ '出口A手机', '出口A平板' ]);
	check('AP 设备行显示信号 dBm',
		textOf(ap1Detail).indexOf('-45 dBm') >= 0 && textOf(ap1Detail).indexOf('-60 dBm') >= 0,
		'detail=' + repr(textOf(ap1Detail)));

	const ap2 = topoApByName(ctx, '车库 AP');
	const ap2Names = (function () {
		clickNode(ap2);
		return topoDrillNames(ap2);
	})();

	sameList('车库 AP 只列自己的在线设备（不振别的 AP）', ap2Names, [ '直连电视' ]);

	const ap3 = topoApByName(ctx, '阁楼 AP');
	const ap3Detail = findAll(ap3, function (n) { return hasClass(n, 'tsm-xlist'); })[0];

	clickNode(ap3);
	sameList('无设备的 AP 列表为空', topoDrillNames(ap3), []);
	check('无设备的 AP 显示「该 AP 下暂无在线设备」',
		textOf(ap3Detail).indexOf('该 AP 下暂无在线设备') >= 0, textOf(ap3Detail));

	/* 展开状态刷新保留，且数据未变不重建 */
	clickNode(aCard);
	const beforeRefresh = ctx.topoHost.firstChild;

	await ctx.refresh(false);

	same('数据未变：刷新不重建拓扑', ctx.topoHost.firstChild, beforeRefresh);
	same('刷新后出口展开状态保留', aDetail.style.display, '');
	same('刷新后 AP 展开状态保留', ap1Detail.style.display, '');
	same('展开状态按出口名/AP node_id 记忆',
		ctx.topoOpenExits['exit:出口 A'] === true && ctx.topoOpenExits['ap:ap1'] === true, true);

	/* 纯函数：最多 8 台、按流量降序、DIRECT 大小写不敏感 */
	const many = [];

	for (let i = 0; i < 10; i++) {
		many.push({
			mac: 'M' + i, hostname: '设备' + i, last_seen: NOW - 10,
			direct_rx: 100 - i, direct_tx: 0,
			apps: { 'x.example': { rx: 1, tx: 1, chain: '出口 A' } }
		});
	}

	const limited = hooks.exitDrillDevices({ name: '出口 A', direct: false }, many, NOW);

	same('出口下钻最多 8 台', limited.length, 8);
	same('出口下钻按累计流量降序', limited[0].hostname, '设备0');
	same('DIRECT 下钻 chain 大小写不敏感',
		hooks.exitDrillDevices({ name: 'DIRECT', direct: true },
			[ { mac: 'x', last_seen: NOW - 10, apps: { x: { chain: 'direct' } } } ], NOW).length, 1);

	const apStationsMany = [];
	const apDevicesMany = [];

	for (let i = 0; i < 10; i++) {
		const mac = 'F0:00:00:00:00:' + (10 + i);

		apStationsMany.push({ mac: mac, node_id: 'apX', signal: -50 - i });
		apDevicesMany.push({ mac: mac, hostname: 'AP设备' + i, last_seen: NOW - 10, direct_rx: 100 - i });
	}

	same('AP 下钻最多 8 台',
		hooks.apDrillDevices('apX', apStationsMany, apDevicesMany, NOW).length, 8);
}

// ---------------------------------------------------------------- 16. 设备搜索

async function testDeviceSearch() {
	console.log('\n[16] 设备搜索：名称/别名/MAC/IP 即输即筛、空态、与 tab/链路筛选叠加');

	const devices = [
		{
			mac: 'AA:BB:CC:00:11:22', hostname: '电视盒子', alias: '客厅',
			ip: '192.168.1.10', link: 'wifi', last_seen: NOW - 10, direct_rx: 100
		},
		{
			mac: 'DE:AD:BE:EF:00:01', hostname: '书房电脑', alias: '',
			ip: '192.168.1.20', link: 'wired', last_seen: NOW - 10, direct_rx: 50
		},
		{
			mac: '11:22:33:44:55:66', hostname: '访客手机', alias: '访客',
			ip: '192.168.1.30', link: 'wifi', last_seen: NOW - 10, direct_rx: 10
		}
	];
	const booted = await boot({ state: baseState({ devices: devices }) });
	const ctx = booted.ctx;
	const env = booted.env;
	const rpcBefore = env.__calls.length;

	same('搜索框占位符', ctx.devSearchInput.attrs.placeholder, '搜索名称 / MAC / IP');
	check('搜索框左侧有放大镜 SVG',
		findAll(ctx.devSearchBox, function (n) { return n.tag === 'svg'; }).length >= 1,
		'box=' + repr(ctx.devSearchBox));
	same('清空按钮初始隐藏', ctx.devSearchClear.style.display, 'none');

	typeSearch(ctx, '客');
	sameList('别名包含「客」也能命中', deviceNames(ctx), [ '电视盒子' ]);
	same('输入后清空按钮出现', ctx.devSearchClear.style.display, '');
	same('搜索不发 RPC', env.__calls.length, rpcBefore);

	ctx.setDevTab('guest');
	sameList('搜索与分类 tab 叠加（访客 tab 只剩访客手机）', deviceNames(ctx), [ '访客手机' ]);
	same('搜索不重置分类 tab', ctx.devTab, 'guest');
	same('tab 计数不随搜索变化', devTabCount(ctx, 'main'), '(2)');

	typeSearch(ctx, 'de:ad');
	sameList('MAC 片段大小写不敏感（当前访客 tab 无匹配）', deviceNames(ctx), []);
	check('MAC 无匹配时显示空态',
		textOf(ctx.devicesBox).indexOf('没有匹配的设备') >= 0, textOf(ctx.devicesBox));

	ctx.setDevTab('main');
	sameList('切回主网络后 MAC 命中书房电脑', deviceNames(ctx), [ '书房电脑' ]);

	typeSearch(ctx, '192.168.1.10');
	sameList('IP 片段也能命中', deviceNames(ctx), [ '电视盒子' ]);

	typeSearch(ctx, '绝不存在的设备');
	sameList('无匹配时列表为空', deviceNames(ctx), []);
	check('无匹配空态含当前关键词',
		textOf(ctx.devicesBox).indexOf('没有匹配的设备') >= 0 &&
		textOf(ctx.devicesBox).indexOf('绝不存在的设备') >= 0,
		textOf(ctx.devicesBox));
	same('无匹配时 tab 计数仍是分类总数', devTabCount(ctx, 'main'), '(2)');

	ctx.devSearchClear.attrs.click();
	sameList('点击清空恢复完整列表', deviceNames(ctx), [ '电视盒子', '书房电脑' ]);
	same('清空后关键词为空', ctx.devQuery, '');
	same('清空后按钮重新隐藏', ctx.devSearchClear.style.display, 'none');

	const wifiChip = ctx.devLinkChips.find(function (item) { return item.id === 'wifi'; });
	const wiredChip = ctx.devLinkChips.find(function (item) { return item.id === 'wired'; });

	wifiChip.node.attrs.click();
	sameList('仅无线筛选：主网络只剩电视盒子', deviceNames(ctx), [ '电视盒子' ]);

	typeSearch(ctx, '电脑');
	sameList('搜索与「仅无线」叠加：电脑被链路筛掉', deviceNames(ctx), []);
	check('叠加无结果也有空态',
		textOf(ctx.devicesBox).indexOf('没有匹配的设备') >= 0, textOf(ctx.devicesBox));

	wiredChip.node.attrs.click();
	sameList('切到「仅有线」后搜索关键词保留', deviceNames(ctx), [ '书房电脑' ]);
	same('搜索全程不发 RPC', env.__calls.length, rpcBefore);

	/* 320px：搜索框可收缩，不把页面撑宽 */
	check('搜索框 CSS 允许收缩（min-width:0）',
		/\.tsm-dsearch\{[^}]*min-width:0/.test(SOURCE) &&
		/\.tsm-dsearch-i\{[^}]*min-width:0/.test(SOURCE),
		'dsearch=' + repr(SOURCE.match(/\.tsm-dsearch\{[^}]*\}/g)) +
		' input=' + repr(SOURCE.match(/\.tsm-dsearch-i\{[^}]*\}/g)));

	const small = SOURCE.match(/@media \(max-width:320px\)\{[\s\S]*?\}\}/);

	check('320px 媒体查询收紧搜索框内边距',
		small != null && small[0].indexOf('.tsm-dsearch') >= 0,
		'small=' + repr(small && small[0].slice(0, 320)));
}

// ---------------------------------------------------------------- 8. 安全 / 口径

async function testSafetyAndHealth() {
	console.log('\n[8] 安全与约定：无危险 DOM、healthLook、累计口径措辞');

	check('mobile.js 不含 innerHTML 字样', !/innerHTML/.test(SOURCE),
		'匹配=' + repr(/innerHTML/.test(SOURCE)));
	check('mobile.js 不含 .outerHTML =', !/\.outerHTML\s*=/.test(SOURCE),
		'匹配=' + repr(/\.outerHTML\s*=/.test(SOURCE)));
	check('mobile.js 不含 insertAdjacentHTML', !/insertAdjacentHTML/.test(SOURCE),
		'匹配=' + repr(/insertAdjacentHTML/.test(SOURCE)));
	check('mobile.js 不含 document.write(', !/document\.write\s*\(/.test(SOURCE),
		'匹配=' + repr(/document\.write\s*\(/.test(SOURCE)));
	check('mobile.js 没有写 RPC（set_config / set_device_meta / restart / uci.set）',
		!/set_config|set_device_meta|method:\s*'restart'|uci\.set\s*\(/.test(SOURCE),
		'匹配=' + repr(/set_config|set_device_meta|method:\s*'restart'|uci\.set\s*\(/.test(SOURCE)));

	const loaded = loadMobile();
	const methods = loaded.env.__declarations.map(function (item) { return item.method; }).sort();

	sameList('mobile 只声明 get_state / get_nodes / get_stations 三个只读 RPC',
		methods, [ 'get_nodes', 'get_state', 'get_stations' ]);
	check('三个 RPC 都走 traffic-stats 对象',
		loaded.env.__declarations.every(function (item) {
			return item.object === 'traffic-stats';
		}),
		'declarations=' + repr(loaded.env.__declarations));

	const hooks = loaded.hooks;

	const unknown = hooks.healthLook('unknown');

	same('healthLook(unknown).kind', unknown.kind, 'unknown');
	same('healthLook(unknown).label', unknown.label, '记账状态未知');
	same('healthLook(unknown).color 为灰色', unknown.color, '#9e9e9e');

	const unavailable = hooks.healthLook('unavailable');

	same('healthLook(unavailable).kind', unavailable.kind, 'unavailable');
	same('healthLook(unavailable).label', unavailable.label, '记账不可用');
	same('healthLook(unavailable).color 为红色', unavailable.color, '#c62828');

	same('healthLook(undefined) 与 unknown 同档',
		hooks.healthLook(undefined).label, '记账状态未知');
	same('healthLook(null) 与 unknown 同档',
		hooks.healthLook(null).label, '记账状态未知');

	/* 渲染路径：syncHealth 真的把颜色/文案写进 healthBox */
	const unknownBoot = await boot({
		state: baseState({ health: { accounting_confidence: 'unknown', reasons: [] } })
	});

	same('健康块 unknown 文案', textOf(unknownBoot.ctx.healthLabel), '记账状态未知');
	same('健康块 unknown 左边框灰色', unknownBoot.ctx.healthBox.style.borderLeftColor, '#9e9e9e');

	const unavailableBoot = await boot({
		state: baseState({ health: { accounting_confidence: 'unavailable', reasons: [] } })
	});

	same('健康块 unavailable 文案', textOf(unavailableBoot.ctx.healthLabel), '记账不可用');
	same('健康块 unavailable 左边框红色', unavailableBoot.ctx.healthBox.style.borderLeftColor, '#c62828');

	/*
	 * 口径：totals 是进程启动以来累计，不是「今日」。
	 * 注释里说明「不是今日」是允许的，去掉注释后再查。
	 */
	const code = codeWithoutComments(SOURCE);

	check('代码（去注释）里不出现「今日」口径', !/今日/.test(code),
		'匹配=' + repr(/今日/.test(code)));
	check('源码里不出现「今日流量」文案', !/今日流量/.test(SOURCE),
		'匹配=' + repr(/今日流量/.test(SOURCE)));
	check('源码里有累计口径说明', /累计口径/.test(SOURCE) && /进程启动以来/.test(SOURCE),
		'累计口径=' + repr(/累计口径/.test(SOURCE)) +
		' 进程启动以来=' + repr(/进程启动以来/.test(SOURCE)));
	check('概览页展开区有累计口径提示',
		textOf(unknownBoot.ctx.pages[0]).indexOf('累计口径') >= 0,
		textOf(unknownBoot.ctx.pages[0]).slice(-160));
}

// ---------------------------------------------------------------- 9. 轮询

async function testPolling() {
	console.log('\n[9] 轮询：startRefresh / stopRefresh / 页面离开停止 / hidden 跳过');

	const booted = await boot();
	const ctx = booted.ctx;
	const env = booted.env;

	check('startRefresh / stopRefresh 都是函数',
		typeof ctx.startRefresh === 'function' && typeof ctx.stopRefresh === 'function',
		'start=' + repr(typeof ctx.startRefresh) + ' stop=' + repr(typeof ctx.stopRefresh));
	same('render 后启动了一个 interval', env.__timers.active.size, 1);

	const firstTimer = Array.from(env.__timers.active.entries())[0];

	same('render 只启动一次 interval', env.__timers.started.length, 1);
	same('轮询间隔 15 秒', firstTimer ? firstTimer[1].ms : null, 15000);
	same('ctx.timer 记录 interval id', ctx.timer, firstTimer ? firstTimer[0] : null);

	ctx.stopRefresh();
	same('stopRefresh 后 ctx.timer=null', ctx.timer, null);
	same('stopRefresh 调用 clearInterval 一次', env.__timers.cleared.length, 1);
	same('clearInterval 收到正确 id', env.__timers.cleared[0], firstTimer ? firstTimer[0] : null);
	same('stopRefresh 后没有存活 interval', env.__timers.active.size, 0);
	check('stopRefresh 移除 beforeunload/unload 监听',
		env.__windowEvents.filter(function (e) {
			return e.action === 'remove' && (e.type === 'beforeunload' || e.type === 'unload');
		}).length >= 2,
		'events=' + repr(env.__windowEvents));

	ctx.startRefresh();
	same('再次 startRefresh 重新起 interval', env.__timers.active.size, 1);

	/* 页面离开：#view 被替换 → root 不在 body 里，下一次 tick 必须自己停表 */
	const secondTimer = Array.from(env.__timers.active.values())[0];
	const callsBeforeTick = env.__calls.length;

	env.document.body.removeChild(ctx.root);
	secondTimer.fn();

	same('页面离开后 tick 停止轮询（active=0）', env.__timers.active.size, 0);
	same('页面离开后 ctx.timer=null', ctx.timer, null);
	same('页面离开后的 tick 不再发 RPC', env.__calls.length, callsBeforeTick);

	/* document.hidden=true 跳过这一轮；hidden=false 恢复刷新 */
	const hiddenBoot = await boot();
	const hiddenCtx = hiddenBoot.ctx;
	const hiddenEnv = hiddenBoot.env;
	const hiddenTimer = Array.from(hiddenEnv.__timers.active.values())[0];

	hiddenEnv.document.hidden = true;
	hiddenCtx.timer = hiddenTimer;
	const hiddenCallsBefore = hiddenEnv.__calls.length;

	hiddenTimer.fn();
	await flush();

	same('页面隐藏时 tick 不发 RPC', hiddenEnv.__calls.length, hiddenCallsBefore);
	check('页面隐藏时轮询不停止', hiddenCtx.timer != null && hiddenEnv.__timers.active.size === 1,
		'timer=' + repr(hiddenCtx.timer) + ' active=' + hiddenEnv.__timers.active.size);

	hiddenEnv.document.hidden = false;

	/* 恢复可见后换一份新数据：轮询 tick 必须真的把数字回写到页面 */
	hiddenEnv.__responses.get_state = baseState({
		totals: {
			direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
			rx_rate: 2500000, tx_rate: 5000000
		}
	});

	hiddenTimer.fn();
	await flush();

	same('页面恢复后 tick 只刷新 get_state（当前在概览屏）',
		hiddenEnv.__calls.length, hiddenCallsBefore + 1);
	same('概览屏轮询不额外拉 get_nodes', countCalls(hiddenEnv, 'get_nodes'), 0);
	same('概览屏轮询不额外拉 get_stations', countCalls(hiddenEnv, 'get_stations'), 0);
	same('轮询刷新后上传数字更新为 40.0', textOf(hiddenCtx.txNum), '40.0');
	same('轮询刷新后下载数字更新为 20.0', textOf(hiddenCtx.rxNum), '20.0');
	same('刷新后 refreshing 复位', hiddenCtx.refreshing, false);
	check('刷新后轮询继续运行', hiddenCtx.timer != null && hiddenEnv.__timers.active.size === 1,
		'timer=' + repr(hiddenCtx.timer) + ' active=' + hiddenEnv.__timers.active.size);
}

// ---------------------------------------------------------------- 10. 陈旧 state / daemon 状态

async function testStaleState() {
	console.log('\n[10] 陈旧 state：真实时间判在线 + 顶部「未更新」/「未运行」提示');

	const staleDevices = [
		{ mac: 'S1', hostname: '冻结设备一', link: 'wifi', last_seen: NOW - 3600, direct_rx: 100 },
		{ mac: 'S2', hostname: '冻结设备二', link: 'wired', last_seen: NOW - 3600, direct_rx: 50 }
	];

	/* ts 冻结在 1 小时前，last_seen 也跟着 ts：按 state.ts 算会全部算在线（旧 bug）。 */
	const booted = await boot({
		state: baseState({ ts: NOW - 3600, devices: staleDevices })
	});
	const ctx = booted.ctx;
	const hooks = booted.hooks;

	same('陈旧 ts：终端数为 0', textOf(ctx.devPill), '0 台终端');
	same('陈旧 ts：主网络设备 0 台', devTabCount(ctx, 'main'), '(0)');
	same('陈旧 ts：两台设备都归入离线', devTabCount(ctx, 'offline'), '(2)');
	sameList('陈旧 ts：默认主网络列表为空', deviceNames(ctx), []);
	check('陈旧 ts：顶部提示数据未更新',
		textOf(ctx.noticeNode).indexOf('数据已 1 小时未更新') >= 0,
		'notice=' + repr(textOf(ctx.noticeNode)));
	check('「更新于」保留时间戳并补相对时间',
		textOf(ctx.updatedNode).indexOf('小时前') >= 0,
		'updated=' + repr(textOf(ctx.updatedNode)));

	ctx.setDevTab('offline');

	const row = deviceRowByName(ctx, '冻结设备一');

	check('离线行内相对时间基于真实时间（1 小时前）',
		row != null && textOf(row).indexOf('1 小时前') >= 0,
		'row=' + repr(row ? textOf(row) : null));

	/* 同一份陈旧 ts，但设备 last_seen 是新的 → 分类确实没用 state.ts */
	const mixed = await boot({
		state: baseState({
			ts: NOW - 3600,
			devices: [
				{ mac: 'S1', hostname: '冻结设备', last_seen: NOW - 3600 },
				{ mac: 'F1', hostname: '刚上报', last_seen: NOW - 20 }
			]
		})
	});

	same('ts 陈旧但 last_seen 新：仍按真实时间算 1 台在线',
		textOf(mixed.ctx.devPill), '1 台终端');
	same('ts 陈旧：刚上报设备留在主网络', devTabCount(mixed.ctx, 'main'), '(1)');
	same('ts 陈旧：冻结设备归离线', devTabCount(mixed.ctx, 'offline'), '(1)');

	/* 未来时间戳：+60 秒内算在线，更远不算（与 overview.js 的 onlineCount 同口径） */
	check('last_seen 在未来 30 秒内仍算在线',
		hooks.isDeviceOnline({ last_seen: NOW + 30 }, NOW) === true,
		'实际=' + repr(hooks.isDeviceOnline({ last_seen: NOW + 30 }, NOW)));
	check('last_seen 在未来 61 秒不算在线',
		hooks.isDeviceOnline({ last_seen: NOW + 61 }, NOW) === false,
		'实际=' + repr(hooks.isDeviceOnline({ last_seen: NOW + 61 }, NOW)));
	same('activeDeviceCount 容忍未来 +30 秒',
		hooks.activeDeviceCount([ { last_seen: NOW + 30 } ], NOW), 1);
	same('activeDeviceCount 不数未来 +61 秒',
		hooks.activeDeviceCount([ { last_seen: NOW + 61 } ], NOW), 0);

	/* daemon 未运行：state.running === false */
	const stopped = await boot({ state: baseState({ running: false, devices: [] }) });
	const stoppedText = textOf(stopped.ctx.noticeNode);

	check('state.running=false → 提示 traffic-statsd 未运行',
		stoppedText.indexOf('traffic-statsd 未运行') >= 0, 'notice=' + repr(stoppedText));
	same('未运行时 notice 可见', stopped.ctx.noticeNode.style.display, 'block');
	check('running=false 且数据新鲜时不提「未更新」',
		stoppedText.indexOf('未更新') < 0, 'notice=' + repr(stoppedText));

	const fresh = await boot({ state: baseState() });

	same('running 字段缺失时不显示 notice', textOf(fresh.ctx.noticeNode), '');
	same('running 字段缺失时 notice 隐藏', fresh.ctx.noticeNode.style.display, 'none');
}

// ---------------------------------------------------------------- 11. 节点刷新失败

async function testNodesPartialFailure() {
	console.log('\n[11] get_nodes 先成功后失败：卡片保留 + 顶部错误提示');

	const nodes = {
		nodes: [
			{ node_id: 'n1', name: '客厅节点', ts: NOW - 60, age_sec: 60,
				latest: { totals: { proxy_rx: 1 } } },
			{ node_id: 'n2', name: '车库节点', ts: NOW - 90, age_sec: 90,
				latest: { totals: {} } }
		]
	};

	const booted = await boot({ state: baseState(), nodes: nodes });
	const ctx = booted.ctx;

	await enterPage(ctx, 2);

	same('先成功：nodesOk=true', ctx.nodesOk, true);
	same('先成功：2 张节点卡片', nodeCards(ctx).length, 2);

	booted.env.__rejections.get_nodes = new Error('nodes boom');

	await ctx.refresh(false);

	same('后失败：nodesOk=false', ctx.nodesOk, false);
	same('后失败：错误文本保留', ctx.nodesError, 'nodes boom');
	same('后失败：旧卡片仍保留', nodeCards(ctx).length, 2);
	same('后失败：概览速率不受影响', textOf(ctx.txNum), '0.0');
	check('后失败：节点屏顶部出现刷新失败提示',
		textOf(ctx.nodeHost).indexOf('节点数据刷新失败：nodes boom') >= 0,
		'nodeHost=' + repr(textOf(ctx.nodeHost)));
	check('后失败：提示行是节点屏第一行',
		ctx.nodeHost.children.length === 2 && hasClass(ctx.nodeHost.children[0], 'tsm-nerr'),
		'children=' + repr(ctx.nodeHost.children.map(function (node) {
			return node.attrs && node.attrs['class'];
		})));
	same('后失败：卡片网格仍在',
		findAll(ctx.nodeHost, function (node) { return hasClass(node, 'tsm-ngrid'); }).length, 1);

	/* 重新成功一次：错误行必须消失，卡片照旧 */
	booted.env.__rejections.get_nodes = null;
	await ctx.refresh(false);

	same('恢复成功后 nodesOk=true', ctx.nodesOk, true);
	same('恢复成功后错误行消失',
		findAll(ctx.nodeHost, function (node) { return hasClass(node, 'tsm-nerr'); }).length, 0);
	same('恢复成功后卡片仍在', nodeCards(ctx).length, 2);
}

// ---------------------------------------------------------------- 12. 后端裁剪提示

async function testTruncation() {
	console.log('\n[12] 后端裁剪：state.truncated / dev.apps_truncated 提示');

	const dev = {
		mac: 'T1', hostname: '裁剪设备', link: 'wifi', last_seen: NOW - 30, direct_rx: 100,
		apps: { 'video.example': { rx: 100, tx: 50, chain: 'DIRECT' } },
		apps_truncated: true
	};

	const booted = await boot({ state: baseState({ truncated: true, devices: [ dev ] }) });
	const ctx = booted.ctx;

	check('state.truncated=true → 设备屏有裁剪提示',
		textOf(ctx.devTruncNote).indexOf('后端已裁剪') >= 0 &&
		textOf(ctx.devTruncNote).indexOf('仅显示使用量最高的部分设备') >= 0,
		'note=' + repr(textOf(ctx.devTruncNote)));
	same('裁剪提示显示', ctx.devTruncNote.style.display, 'block');

	const appsNode = ctx.renderDeviceApps(dev);

	check('apps_truncated=true → 应用列表上方提示已裁剪',
		textOf(appsNode).indexOf('应用明细已裁剪') >= 0, 'apps=' + repr(textOf(appsNode)));
	check('应用裁剪提示排在「应用 Top 5」之前',
		appsNode.children.length > 1 &&
		hasClass(appsNode.children[0], 'tsm-apps-trunc') &&
		hasClass(appsNode.children[1], 'tsm-apps-t'),
		'classes=' + repr(appsNode.children.map(function (node) {
			return node.attrs && node.attrs['class'];
		})));

	/* 展开设备行后，DOM 里也能看到提示 */
	const row = findAll(deviceRowByName(ctx, '裁剪设备'), function (node) {
		return hasClass(node, 'tsm-drow');
	})[0];

	check('找到可展开的设备行', row != null && row.listeners.click != null,
		'row=' + repr(row != null));

	if (row != null) {
		row.listeners.click[0]();

		check('展开后应用明细里有裁剪提示',
			textOf(row.parentNode).indexOf('应用明细已裁剪') >= 0,
			'item=' + repr(textOf(row.parentNode)));
	}

	/* 字段缺失：两条提示都不出现 */
	const plainDev = { mac: 'P1', hostname: '普通设备', last_seen: NOW - 30,
		apps: { 'a.example': { rx: 1, tx: 0 } } };
	const plain = await boot({ state: baseState({ devices: [ plainDev ] }) });

	same('state.truncated 缺失时提示隐藏', plain.ctx.devTruncNote.style.display, 'none');
	check('apps_truncated 缺失时没有应用裁剪提示',
		textOf(plain.ctx.renderDeviceApps(plainDev)).indexOf('应用明细已裁剪') < 0,
		'apps=' + repr(textOf(plain.ctx.renderDeviceApps(plainDev))));

	same('state.truncated=false 时提示隐藏',
		(await boot({ state: baseState({ truncated: false }) })).ctx.devTruncNote.style.display, 'none');
}

// ---------------------------------------------------------------- 13. 可点区域与覆盖样式

async function testTouchTargets() {
	console.log('\n[13] 静态：关键点击区 ≥44×44、概览数字不被旧规则压暗');

	function hasRule(selector, pattern) {
		const re = new RegExp('\\.' + selector + '\\{[^}]*' + pattern + '[^}]*\\}');

		return re.test(SOURCE);
	}

	check('.tsm-rate 覆盖块恢复 opacity:1 与 margin:0',
		/\.tsm-rate\{[^}]*opacity:1[^}]*margin:0\}/.test(SOURCE),
		'规则=' + repr(SOURCE.match(/\.tsm-rate\{[^}]*\}/g)));
	check('刷新按钮用透明覆盖层扩到 44px 高',
		hasRule('tsm-refresh::before', 'height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-refresh::before\{[^}]*\}/g)));
	check('刷新按钮视觉高度仍是 30px',
		hasRule('tsm-refresh', 'min-height:30px'),
		'规则=' + repr(SOURCE.match(/\.tsm-refresh\{[^}]*\}/g)));
	check('顶部 tab min-height:44px', hasRule('tsm-tab', 'min-height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-tab\{[^}]*\}/g)));
	check('筛选按钮用透明覆盖层扩到 44px 高',
		hasRule('tsm-filter::before', 'height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-filter::before\{[^}]*\}/g)));
	check('筛选按钮视觉高度仍是 32px',
		hasRule('tsm-filter', 'min-height:32px'),
		'规则=' + repr(SOURCE.match(/\.tsm-filter\{[^}]*\}/g)));
	check('底部圆点按钮 44×44',
		hasRule('tsm-dot-btn', 'width:44px') && hasRule('tsm-dot-btn', 'height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-dot-btn\{[^}]*\}/g)));
	check('节点卡「⋮」44×44',
		hasRule('tsm-nmore', 'width:44px') && hasRule('tsm-nmore', 'height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-nmore\{[^}]*\}/g)));
	check('圆点按钮用负 margin 抵消视觉尺寸', hasRule('tsm-dot-btn', 'margin:-7px'),
		'规则=' + repr(SOURCE.match(/\.tsm-dot-btn\{[^}]*\}/g)));
	check('节点「⋮」用负 top/right 保持图标位置',
		hasRule('tsm-nmore', 'top:-4px') && hasRule('tsm-nmore', 'right:-4px'),
		'规则=' + repr(SOURCE.match(/\.tsm-nmore\{[^}]*\}/g)));

	const booted = await boot();
	const dotButtons = findAll(booted.ctx.root, function (node) {
		return hasClass(node, 'tsm-dot-btn');
	});

	same('底部圆点按钮仍是 5 个', dotButtons.length, 5);
	check('圆点按钮都是 <button> 且带 aria-label',
		dotButtons.every(function (node) {
			return node.tag === 'button' && node.attrs['aria-label'] != null;
		}),
		'buttons=' + repr(dotButtons.map(function (node) { return node.tag; })));
}



// ---------------------------------------------------------------- main

(async function main() {
	console.log('手机版 UI 静态测试：' + MOBILE);

	try {
		await testStructure();
		await testPaging();
		await testOverview();
		await testDeviceGroups();
		await testDeviceRows();
		await testFiltering();
		await testNodeScreen();
		await testTopology();
		await testDeviceKindOf();
		await testOverviewTopo();
		await testTopologyDegrade();
		await testSafetyAndHealth();
		await testPolling();
		await testStaleState();
		await testNodesPartialFailure();
		await testTruncation();
		await testTouchTargets();
		await testTopoStyles();
		await testLazyNodeData();
		await testTopoDrilldown();
		await testDeviceSearch();
	}
	catch (err) {
		console.error('\n测试自身异常：', err && err.stack ? err.stack : err);
		process.exit(1);
	}

	console.log('\n结果：' + passed + ' passed, ' + failed + ' failed');

	process.exit(failed === 0 ? 0 : 1);
})();
