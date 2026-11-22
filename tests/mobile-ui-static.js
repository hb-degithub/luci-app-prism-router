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
 *   0. 环境：localStorage 桩（memory / throw / getter-throw / none）供离线快照测试
 *   1. 结构：根 #ts-mobile.tsm-app、5 个 .tsm-page、顶部 5 个带文字 tab、默认第 1 屏
 *      （底部无文字圆点导航已移除，只保留顶部 tab）
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
 *  14~21. 懒加载 / 下钻 / 搜索 / 下拉刷新 / 骨架屏 / 切屏过渡 / 安全区 / 迷你趋势 / Top3
 *  23. 离线快照写入：键名、字段白名单（不含 apps/token/secret）、不超 64KB
 *  24. 64KB 上限：devices 截断到 200 条并标 truncated
 *  25. 首屏失败：读快照渲染 + 离线条文案与时间
 *  26. online 事件：清除离线条并重新请求
 *  27. 连续 3 次自动失败停表，手动重试仍可用
 *  28. 快照过期：24 小时不再使用、清掉并提示「快照已过期」
 *  29. 损坏 JSON / 结构不对：删除且不崩
 *  30. localStorage 不可用（抛错 / 取不到 / 不存在）：静默降级
 *  31. 「清除离线数据」删除 localStorage 键
 *  32. 安全：无危险 DOM、快照不进 title / 属性 / DOM 文本
 *  33. 运行中刷新失败：顶部离线条，恢复后自动收起
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
	'luci-app-prism-router/htdocs/luci-static/resources/view/prism-router/mobile.js'
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

/*
 * localStorage 的最小可信替身：只存文本，不做配额模拟。
 * 三种「不可用」模式由 makeEnvironment({ storage }) 选择：
 *   'memory'（默认，正常浏览器）/ 'throw'（读写抛错，配额满或安全策略）
 *   / 'getter-throw'（连 window.localStorage 都取不到）/ 'none'（属性不存在）。
 */
function makeMemoryStore(seed) {
	const map = new Map();

	Object.keys(seed || {}).forEach(function (key) { map.set(key, '' + seed[key]); });

	return {
		getItem: function (key) { return map.has(key) ? map.get(key) : null; },
		setItem: function (key, value) { map.set(key, '' + value); },
		removeItem: function (key) { map.delete(key); },
		clear: function () { map.clear(); },
		__map: map
	};
}

function makeEnvironment(options) {
	const opts = options || {};
	const declarations = [];
	const calls = [];
	const responses = {};
	const rejections = {};
	const notifications = [];
	const timers = { started: [], cleared: [], active: new Map() };
	const timeouts = { scheduled: [], cleared: [] };
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
				href: 'https://192.168.1.1/cgi-bin/luci/admin/services/prism-router/mobile'
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
			setTimeout: function (fn, ms) {
				const id = nextTimerId();

				timeouts.scheduled.push({ id: id, fn: fn, ms: ms });

				return id;
			},
			clearTimeout: function (id) {
				timeouts.cleared.push(id);
			},
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
	env.__timeouts = timeouts;
	env.__windowEvents = windowEvents;
	env.__scrolls = scrolls;
	env.__body = body;
	env.__head = head;

	/*
	 * 离线快照用的 localStorage：默认可用；'throw' / 'getter-throw' / 'none'
	 * 模拟隐私模式、配额满、被策略禁掉的浏览器。种子数据用来复现"上次成功"的快照。
	 */
	const store = makeMemoryStore(opts.seed || {});
	const storageMode = opts.storage || 'memory';

	if (storageMode === 'throw') {
		store.getItem = function () { throw new Error('SecurityError: localStorage is not available'); };
		store.setItem = function () { throw new Error('QuotaExceededError: quota exceeded'); };
		store.removeItem = function () { throw new Error('SecurityError: localStorage is not available'); };
	}

	if (storageMode === 'getter-throw') {
		Object.defineProperty(env.window, 'localStorage', {
			configurable: true,
			get: function () { throw new Error('SecurityError: access denied'); }
		});
	}
	else if (storageMode === 'none') {
		env.window.localStorage = undefined;
	}
	else {
		env.window.localStorage = store;
	}

	env.__store = store;
	env.__storageMode = storageMode;

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
	'deviceKindLabel',
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
	'apOnlineCount',
	'offlineText',
	'fmtHHMM',
	'buildSnapshot',
	'snapshotJson',
	'writeSnapshot',
	'readSnapshot',
	'removeSnapshot',
	'stateFromSnapshot',
	'snapStore',
	'snapBytes',
	'SNAPSHOT_KEY',
	'SNAPSHOT_MAX_BYTES',
	'SNAPSHOT_MAX_AGE_SEC',
	'SNAPSHOT_MAX_DEVICES'
];

function loadMobile(options) {
	const env = makeEnvironment(options);
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
	const loaded = loadMobile({ storage: opts.storage, seed: opts.seed });
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
	console.log('\n[1] 结构：根 #ts-mobile.tsm-app / 5 屏 / 顶部 5 tab（无底部圆点）/ 默认第 1 屏');

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
	same('底部圆点导航已移除（无 .tsm-dots）',
		findAll(root, function (n) { return hasClass(n, 'tsm-dots'); }).length, 0);
	same('底部圆点按钮已移除（无 .tsm-dot-btn）',
		findAll(root, function (n) { return hasClass(n, 'tsm-dot-btn'); }).length, 0);
	same('底部圆点指示已移除（无 .tsm-dot-i）',
		findAll(root, function (n) { return hasClass(n, 'tsm-dot-i'); }).length, 0);

	const mainTabs = findByClass(root, 'tsm-tabs');
	const tabButtons = findAll(mainTabs, function (n) { return hasClass(n, 'tsm-tab'); });

	same('顶部分段 tab 数量 = 5', tabButtons.length, 5);
	sameList('顶部 tab 文案依次为 概览/设备/节点/拓扑/安装',
		tabButtons.map(textOf), [ '概览', '设备', '节点', '拓扑', '安装' ]);

	sameList('顶部 tab aria-label 随 5 屏更新',
		tabButtons.map(function (n) { return n.attrs['aria-label']; }),
		[ '概览', '设备', '节点', '拓扑', '安装' ]);

	same('默认 pageIndex = 0', ctx.pageIndex, 0);
	check('默认只显示第 1 屏（page[0].on，其余 off）',
		hasClass(ctx.pages[0], 'on') &&
		!hasClass(ctx.pages[1], 'on') &&
		!hasClass(ctx.pages[2], 'on') &&
		!hasClass(ctx.pages[3], 'on') &&
		!hasClass(ctx.pages[4], 'on'),
		'pages classes=' + repr(ctx.pages.map(function (p) { return p.attrs['class']; })));
	check('默认第 1 个 tab 选中',
		hasClass(ctx.tabs[0], 'on') && !hasClass(ctx.tabs[1], 'on'),
		'tab classes=' + repr(ctx.tabs.map(function (t) { return t.attrs['class']; })));
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
	console.log('\n[2] 分页：夹紧 [0,4]；顶部 tab 切屏；首次进节点/拓扑懒加载一次');

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
	check('setPage(2)：对应顶部 tab 同步选中',
		hasClass(ctx.tabs[2], 'on') && !hasClass(ctx.tabs[0], 'on'),
		'tab=' + repr(ctx.tabs[2].attrs['class']));

	/* 0..4 每一屏都能直接切到，且只有目标屏 .on */
	for (let i = 0; i < 5; i++) {
		ctx.setPage(i);

		const others = [ 0, 1, 2, 3, 4 ].filter(function (index) { return index !== i; });

		same('setPage(' + i + ') → pageIndex=' + i, ctx.pageIndex, i);
		check('setPage(' + i + ')：目标屏 on、其余 off、顶部 tab 同步',
			hasClass(ctx.pages[i], 'on') &&
			others.every(function (index) { return !hasClass(ctx.pages[index], 'on'); }) &&
			hasClass(ctx.tabs[i], 'on'),
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

	ctx.tabs[1].attrs.click();
	same('点击顶部「设备」tab 切到第 2 屏', ctx.pageIndex, 1);

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
	ctx.tabs[2].attrs.click();
	same('点击顶部 tab 切屏也滚到顶部', env.__scrolls.length, 1);
	sameList('tab 切屏 scrollTo 同样传 (0,0)',
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

/*
 * CSS 树状连线的 DOM 结构：.tsm-ttree > .tsm-ttrunk + 每行 .tsm-trow + 行间 .tsm-tstem。
 * 行内多节点时带一个 .tsm-trow-bus；单节点行 is-single 且没有总线。
 */
function topoTree(root) {
	return findByClass(root, 'tsm-ttree');
}

function topoTreeRows(root) {
	const tree = topoTree(root);

	return tree ? findAll(tree, function (node) { return hasClass(node, 'tsm-trow'); }) : [];
}

function topoRowNodes(row) {
	return findAll(row, function (node) { return hasClass(node, 'tsm-dnode'); });
}

function topoRowBus(row) {
	return findByClass(row, 'tsm-trow-bus');
}

function topoTreeStems(root) {
	const tree = topoTree(root);

	return tree ? findAll(tree, function (node) { return hasClass(node, 'tsm-tstem'); }) : [];
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
	/* 连线改成 CSS 树：树干 → 每行总线 → 节点，不再有 SVG 覆盖层 */
	const wifiTree = topoTree(wifiGroup);
	const wifiTreeRows = topoTreeRows(wifiGroup);

	check('L5 每组都有 CSS 树 + 树干（.tsm-ttree > .tsm-ttrunk）',
		[ wifiGroup, wiredGroup, unknownGroup ].every(function (group) {
			const tree = topoTree(group);

			return tree != null && findByClass(tree, 'tsm-ttrunk') != null &&
				findByClass(tree, 'tsm-tbus') == null;
		}),
		'trees=' + repr([ wifiGroup, wiredGroup, unknownGroup ].map(function (group) {
			return topoTree(group) != null;
		})));
	sameList('L5 无线组 5 台 → 3 行，行节点数 2/2/1',
		wifiTreeRows.map(function (row) { return topoRowNodes(row).length; }), [ 2, 2, 1 ]);
	check('L5 两列行各有 1 条行内总线，单节点行没有总线',
		wifiTreeRows.every(function (row) {
			const multi = topoRowNodes(row).length > 1;

			return multi
				? (topoRowBus(row) != null && !hasClass(row, 'is-single'))
				: (topoRowBus(row) == null && hasClass(row, 'is-single'));
		}),
		'rows=' + repr(wifiTreeRows.map(function (row) {
			return { nodes: topoRowNodes(row).length, single: hasClass(row, 'is-single'),
				bus: topoRowBus(row) != null };
		})));
	same('L5 3 行之间 2 根竖干', topoTreeStems(wifiGroup).length, 2);
	check('L5 树干在最前、紧接第一行（DOM 顺序就是连线顺序）',
		wifiTree != null && wifiTree.children[0].attrs['class'] === 'tsm-ttrunk' &&
		wifiTree.children[1] === wifiTreeRows[0] &&
		wifiTree.children[2].attrs['class'] === 'tsm-tstem' &&
		wifiTree.children[3] === wifiTreeRows[1],
		'children=' + repr(wifiTree && wifiTree.children.map(function (n) {
			return n.attrs['class'];
		})));
	check('L5 「还有 2 台」在最后一行之后，不参与连线',
		wifiTree != null && wifiTree.children[wifiTree.children.length - 1] ===
			findByClass(wifiGroup, 'tsm-dmore') &&
		wifiTreeRows.every(function (row) {
			return !hasClass(row, 'tsm-dmore') &&
				findAll(row, function (n) { return hasClass(n, 'tsm-dmore'); }).length === 0;
		}),
		'last=' + repr(wifiTree && wifiTree.children[wifiTree.children.length - 1].attrs));
	check('L5 单节点组：1 行 is-single、无总线、节点铺满两列',
		topoTreeRows(wiredGroup).length === 1 &&
		hasClass(topoTreeRows(wiredGroup)[0], 'is-single') &&
		topoRowBus(topoTreeRows(wiredGroup)[0]) == null,
		'rows=' + repr(topoTreeRows(wiredGroup).map(function (row) { return row.attrs['class']; })));
	check('L5 不再有 SVG 连线 / .tsm-tline',
		[ wifiGroup, wiredGroup, unknownGroup ].every(function (group) {
			return findByClass(group, 'tsm-tbus') == null &&
				findAll(group, function (n) { return hasClass(n, 'tsm-tline'); }).length === 0;
		}),
		'bus=' + repr([ wifiGroup, wiredGroup, unknownGroup ].map(function (group) {
			return findByClass(group, 'tsm-tbus') != null;
		})));
	const rowOrder = [];

	wifiTreeRows.forEach(function (row) {
		topoRowNodes(row).forEach(function (node) {
			rowOrder.push(textOf(findByClass(node, 'tsm-dnode-name')));
		});
	});
	sameList('L5 行内节点顺序与拓扑设备顺序一致（分行不重排）', rowOrder,
		topoRows(ctx).slice(0, 5).map(function (node) {
			return textOf(findByClass(node, 'tsm-dnode-name'));
		}));
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

// ---------------------------------------------------------------- 7d2. 网络类设备（本机/容器/网关/服务器）

/* 图标标签序列：渲染结果里用它区分类型，不依赖颜色或外层文案。 */
function deviceIconSvg(node) {
	return findAll(node, function (n) { return n.tag === 'svg'; })[0] || null;
}

function deviceIconTags(node) {
	const svg = deviceIconSvg(node);

	return svg == null ? [] : svg.children.map(function (child) { return child.tag; });
}

/* 24px 画布自检：shape 的坐标与 path 数字都必须落在 0..24。 */
function svgCoordsInsideBox(svg) {
	const boxed = [ 'x', 'y', 'cx', 'cy', 'r', 'width', 'height' ];

	return svg.children.every(function (child) {
		const attrsOk = boxed.every(function (name) {
			const value = child.attrs[name];

			return value == null || (Number(value) >= 0 && Number(value) <= 24);
		});

		if (!attrsOk) return false;

		const nums = (String(child.attrs.d || '')).match(/-?\d+(\.\d+)?/g) || [];

		return nums.every(function (n) { return Number(n) >= 0 && Number(n) <= 24; });
	});
}

async function testNetworkDeviceKinds() {
	console.log('\n[7d2] 网络类设备：本机/容器/网关/服务器 识别 + 4 个新线条图标');

	const booted = await boot({ state: baseState() });
	const kindOf = booted.hooks.deviceKindOf;
	const labelOf = booted.hooks.deviceKindLabel;

	/* 本机：回环/未指派地址，或 hostname 关键词（大小写不敏感）。 */
	same('127.0.0.1 → local', kindOf({ ip: '127.0.0.1' }), 'local');
	same('0.0.0.0 → local', kindOf({ ip: '0.0.0.0' }), 'local');
	same('::1 → local', kindOf({ ip: '::1' }), 'local');
	same('localhost 主机名 → local', kindOf({ hostname: 'localhost' }), 'local');
	same('LocalHost-01 混合大小写 → local', kindOf({ hostname: 'LocalHost-01' }), 'local');
	same('中文「本机」→ local', kindOf({ hostname: '本机' }), 'local');

	/* 容器：172.16/12 整段（Docker 默认 172.17），以及容器关键词。 */
	same('172.16.0.2 → container', kindOf({ ip: '172.16.0.2' }), 'container');
	same('172.17.0.2（Docker 默认段）→ container', kindOf({ ip: '172.17.0.2' }), 'container');
	same('172.31.255.9（172.16/12 上界）→ container', kindOf({ ip: '172.31.255.9' }), 'container');
	same('172.15.0.2（不在 172.16/12）→ unknown', kindOf({ ip: '172.15.0.2' }), 'unknown');
	same('172.32.0.2（超出 172.16/12）→ unknown', kindOf({ ip: '172.32.0.2' }), 'unknown');
	same('Docker-01 主机名 → container', kindOf({ hostname: 'Docker-01' }), 'container');
	same('K8S-NODE 大写 → container', kindOf({ hostname: 'K8S-NODE' }), 'container');
	same('podman 主机名 → container', kindOf({ hostname: 'podman-host' }), 'container');
	same('172.17.0.1 先判容器（容器判定在网关之前）', kindOf({ ip: '172.17.0.1' }), 'container');

	/* 网关：私有网段且末段为 1；不是 .1 的私有地址仍是普通设备。 */
	same('10.0.0.1 → gateway', kindOf({ ip: '10.0.0.1' }), 'gateway');
	same('10.1.2.1 → gateway', kindOf({ ip: '10.1.2.1' }), 'gateway');
	same('192.168.1.1 → gateway', kindOf({ ip: '192.168.1.1' }), 'gateway');
	same('192.168.100.1 → gateway', kindOf({ ip: '192.168.100.1' }), 'gateway');
	same('192.168.100.3（不是 .1）→ unknown', kindOf({ ip: '192.168.100.3' }), 'unknown');
	same('10.1.2.3（不是 .1）→ unknown', kindOf({ ip: '10.1.2.3' }), 'unknown');
	same('8.8.8.1（公网 .1）→ unknown', kindOf({ ip: '8.8.8.1' }), 'unknown');
	same('Router-01 主机名 → gateway', kindOf({ hostname: 'Router-01' }), 'gateway');
	same('GATEWAY 大写 → gateway', kindOf({ hostname: 'GATEWAY' }), 'gateway');
	same('中文「主路由」→ gateway', kindOf({ hostname: '主路由' }), 'gateway');
	same('中文「路由」→ gateway', kindOf({ hostname: '路由' }), 'gateway');

	/* 服务器：NAS/机架等关键词。 */
	same('NAS-01 主机名 → server', kindOf({ hostname: 'NAS-01' }), 'server');
	same('nas 别名 → server', kindOf({ alias: 'home nas' }), 'server');
	same('Synology-DS920 → server', kindOf({ hostname: 'Synology-DS920' }), 'server');
	same('QNAP-TS → server', kindOf({ hostname: 'QNAP-TS' }), 'server');
	same('server 大写 → server', kindOf({ hostname: 'Server-A' }), 'server');
	same('中文「群晖」→ server', kindOf({ hostname: '群晖DS220' }), 'server');
	same('中文「服务器」→ server', kindOf({ hostname: '服务器-01' }), 'server');
	same('中文「机架」→ server', kindOf({ hostname: '机架02' }), 'server');
	same('rack-3 → server', kindOf({ hostname: 'rack-3' }), 'server');
	same('canvas 里的 nas 不命中 → unknown', kindOf({ hostname: 'canvas-device' }), 'unknown');

	/* 判定顺序 + 边界：缺 ip / 空 hostname / hostname 里带 IP 字面量。 */
	same('localhost 先于网关 IP 判定', kindOf({ hostname: 'localhost', ip: '192.168.1.1' }), 'local');
	same('容器关键词先于网关 IP 判定', kindOf({ hostname: 'docker-host', ip: '10.0.0.1' }), 'container');
	same('网关关键词先于服务器关键词', kindOf({ hostname: 'Router-NAS', ip: '192.168.100.3' }), 'gateway');
	same('服务器关键词先于手机关键词', kindOf({ hostname: 'NAS-01', alias: 'iPhone' }), 'server');
	same('容器 IP 先于手机关键词', kindOf({ ip: '172.17.0.2', hostname: 'iPhone-15' }), 'container');
	same('普通私有 IP 不误判，仍按原关键词 → phone', kindOf({ ip: '192.168.100.3', hostname: 'iPhone-15' }), 'phone');
	same('空 hostname + 空 ip → unknown', kindOf({ hostname: '', ip: '' }), 'unknown');
	same('空 hostname 不误判成 gateway', kindOf({ hostname: '', alias: '' }), 'unknown');
	same('hostname 含 IP 字面量但不解析成网关', kindOf({ hostname: '192.168.100.1' }), 'unknown');
	same('ip 非法文本不影响关键词判定', kindOf({ hostname: 'iPad-Air', ip: 'not-an-ip' }), 'tablet');
	same('短词词边界保留（MI-11 仍 phone）', kindOf({ hostname: 'MI-11', ip: '192.168.100.3' }), 'phone');
	same('短词词边界保留（HomePod mini 仍 iot）', kindOf({ hostname: 'HomePod mini', ip: '10.0.0.5' }), 'iot');

	/* 中文类型文案。 */
	same('文案 local = 本机', labelOf('local'), '本机');
	same('文案 container = 容器', labelOf('container'), '容器');
	same('文案 gateway = 网关', labelOf('gateway'), '网关');
	same('文案 server = 服务器', labelOf('server'), '服务器');
	same('文案 phone 仍是手机', labelOf('phone'), '手机');
	same('未知类型文案兜底', labelOf('bogus'), '未知');

	/* 4 个新图标：24px 画布、仅 rect/path/circle、stroke 透传。 */
	const expectedTags = {
		gateway: [ 'rect', 'path', 'path', 'path', 'circle' ],
		container: [ 'path', 'path', 'path' ],
		local: [ 'rect', 'path', 'path' ],
		server: [ 'rect', 'rect', 'circle', 'circle' ]
	};

	Object.keys(expectedTags).forEach(function (kind) {
		const svg = booted.hooks.deviceKindSvg(kind, '#2b7de9');

		check('deviceKindSvg(' + kind + ') 结构：' + expectedTags[kind].join('+'),
			svg != null && svg.tag === 'svg' && svg.attrs.viewBox === '0 0 24 24' &&
			svg.children.map(function (c) { return c.tag; }).join(',') === expectedTags[kind].join(',') &&
			svgCoordsInsideBox(svg),
			'tags=' + repr(svg && svg.children.map(function (c) { return c.tag; })));

		check('deviceKindSvg(' + kind + ') 只用 rect/path/circle 且 stroke 透传',
			svg.children.every(function (child) {
				return child.namespace === 'http://www.w3.org/2000/svg' &&
					[ 'rect', 'path', 'circle' ].indexOf(child.tag) >= 0 &&
					(child.attrs.stroke === '#2b7de9' || child.attrs.fill === '#2b7de9');
			}) &&
			findAll(svg, function (n) { return n.tag === 'text'; }).length === 0,
			'svg=' + repr(svg.children.map(function (c) { return c.tag; })));

		const plain = booted.hooks.deviceKindSvg(kind);

		check('deviceKindSvg(' + kind + ') 默认 currentColor（深色主题跟随）',
			plain.children.every(function (child) {
				return child.attrs.stroke === 'currentColor' || child.attrs.fill === 'currentColor';
			}),
			'stroke=' + repr(plain.children.map(function (c) { return c.attrs.stroke || c.attrs.fill; })));
	});

	/* 渲染：概览拓扑节点图标 + 设备行类型文案。 */
	const netDevices = [
		{ mac: 'ND1', ip: '172.17.0.2', hostname: '', link: 'wired', last_seen: NOW - 10, rx_rate: 1200, tx_rate: 600 },
		{ mac: 'ND2', ip: '192.168.100.1', hostname: '', link: 'wired', last_seen: NOW - 20, rx_rate: 2200, tx_rate: 700 },
		{ mac: 'ND3', ip: '192.168.100.3', hostname: '', link: 'wifi', last_seen: NOW - 30, rx_rate: 3200, tx_rate: 800 }
	];
	const rendered = await boot({ state: topoState({ devices: netDevices }) });
	const rctx = rendered.ctx;
	const containerNode = ovTopoRowByName(rctx, '172.17.0.2');
	const gatewayNode = ovTopoRowByName(rctx, '192.168.100.1');
	const unknownNode = ovTopoRowByName(rctx, '192.168.100.3');

	check('概览拓扑渲染出 3 个 IP 设备节点',
		containerNode != null && gatewayNode != null && unknownNode != null,
		'names=' + repr(ovTopoRows(rctx).map(function (n) {
			return textOf(findByClass(n, 'tsm-dnode-name'));
		})));

	check('172.17.0.2 显示容器图标（立方体三路径）',
		containerNode != null && deviceIconTags(containerNode).join(',') === 'path,path,path',
		'tags=' + repr(containerNode && deviceIconTags(containerNode)));
	check('192.168.100.1 显示网关图标（圆角矩形 + 天线 + 指示灯）',
		gatewayNode != null && deviceIconTags(gatewayNode).join(',') === 'rect,path,path,path,circle',
		'tags=' + repr(gatewayNode && deviceIconTags(gatewayNode)));
	check('192.168.100.3 仍是 unknown 问号（不瞎猜）',
		unknownNode != null && deviceIconTags(unknownNode).join(',') === 'circle,path,circle',
		'tags=' + repr(unknownNode && deviceIconTags(unknownNode)));
	check('172.17.0.2 节点仍是 is-wired（类型不改链路环色）',
		containerNode != null && hasClass(containerNode, 'is-wired'),
		'class=' + repr(containerNode && containerNode.attrs['class']));
	check('节点图标默认 currentColor（320px/深色主题不硬编码颜色）',
		containerNode != null && deviceIconSvg(containerNode).children.every(function (child) {
			return child.attrs.stroke === 'currentColor' || child.attrs.fill === 'currentColor';
		}),
		'attrs=' + repr(containerNode && deviceIconSvg(containerNode).children.map(function (c) {
			return c.attrs.stroke || c.attrs.fill;
		})));

	check('设备行文案：172.17.0.2 显示「容器」',
		deviceRowByName(rctx, '172.17.0.2') != null &&
			textOf(deviceRowByName(rctx, '172.17.0.2')).indexOf('容器 · 有线') >= 0,
		'row=' + repr(deviceRowByName(rctx, '172.17.0.2') && textOf(deviceRowByName(rctx, '172.17.0.2'))));
	check('设备行文案：192.168.100.1 显示「网关」',
		deviceRowByName(rctx, '192.168.100.1') != null &&
			textOf(deviceRowByName(rctx, '192.168.100.1')).indexOf('网关 · 有线') >= 0,
		'row=' + repr(deviceRowByName(rctx, '192.168.100.1') && textOf(deviceRowByName(rctx, '192.168.100.1'))));
	check('设备行文案：192.168.100.3 显示「未知」',
		deviceRowByName(rctx, '192.168.100.3') != null &&
			textOf(deviceRowByName(rctx, '192.168.100.3')).indexOf('未知 · 无线') >= 0,
		'row=' + repr(deviceRowByName(rctx, '192.168.100.3') && textOf(deviceRowByName(rctx, '192.168.100.3'))));

	/* L5 设备层复用 renderDeviceNode，图标/类型自动跟随。 */
	check('L5 renderDeviceNode 对 172.17.0.2 同样用容器图标',
		deviceIconTags(rctx.renderDeviceNode({ ip: '172.17.0.2', mac: 'L5A', last_seen: NOW })).join(',') === 'path,path,path',
		'tags=' + repr(deviceIconTags(rctx.renderDeviceNode({ ip: '172.17.0.2', mac: 'L5A', last_seen: NOW }))));
	check('L5 节点 title 带类型文案',
		String(rctx.renderDeviceNode({ ip: '192.168.100.1', mac: 'L5B', last_seen: NOW }).attrs.title)
			.indexOf('网关') === 0,
		'title=' + repr(rctx.renderDeviceNode({ ip: '192.168.100.1', mac: 'L5B', last_seen: NOW }).attrs.title));
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
	console.log('\n[7e] 概览设备拓扑：主路由根节点 + 两列在线节点 + CSS 树状连线 + 点击下钻');

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
	const tree = topoTree(ctx.ovTopoHost);

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

	check('根节点与设备之间是 CSS 树（树干 + 每行总线），没有 SVG 连线',
		tree != null && findByClass(tree, 'tsm-ttrunk') != null &&
		findByClass(ctx.ovTopoHost, 'tsm-tbus') == null &&
		findByClass(ctx.ovTopoHost, 'tsm-otop-grid') == null &&
		findAll(ctx.ovTopoHost, function (n) { return hasClass(n, 'tsm-tline'); }).length === 0,
		'tree=' + repr(tree && tree.attrs));
	check('3 台在线 → 2 行（2/1），第一行有行内总线',
		topoTreeRows(ctx.ovTopoHost).length === 2 &&
		topoTreeRows(ctx.ovTopoHost).map(function (row) {
			return topoRowNodes(row).length;
		}).join(',') === '2,1' &&
		topoRowBus(topoTreeRows(ctx.ovTopoHost)[0]) != null,
		'rows=' + repr(topoTreeRows(ctx.ovTopoHost).map(function (row) {
			return topoRowNodes(row).length;
		})));
	check('最后一行单节点：is-single + 无总线（节点铺满两列）',
		hasClass(topoTreeRows(ctx.ovTopoHost)[1], 'is-single') &&
		topoRowBus(topoTreeRows(ctx.ovTopoHost)[1]) == null,
		'row=' + repr(topoTreeRows(ctx.ovTopoHost)[1] && topoTreeRows(ctx.ovTopoHost)[1].attrs));
	same('行与行之间 1 根竖干', topoTreeStems(ctx.ovTopoHost).length, 1);
	check('树顶树干在第一行之前（DOM 顺序与视觉连线一致）',
		tree != null && tree.children[0].attrs['class'] === 'tsm-ttrunk' &&
		tree.children[1] === topoTreeRows(ctx.ovTopoHost)[0] &&
		tree.children[2].attrs['class'] === 'tsm-tstem',
		'children=' + repr(tree && tree.children.map(function (n) { return n.attrs['class']; })));

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
		topoTree(emptyBoot.ctx.ovTopoHost) == null &&
		topoTreeRows(emptyBoot.ctx.ovTopoHost).length === 0,
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
	sameList('9 台在线 → 8 个节点排 4 行（2/2/2/2）',
		topoTreeRows(manyCtx.ovTopoHost).map(function (row) {
			return topoRowNodes(row).length;
		}), [ 2, 2, 2, 2 ]);
	same('4 行之间 3 根竖干', topoTreeStems(manyCtx.ovTopoHost).length, 3);
	check('「还有 1 台」是树里最后一项，不在任何行内',
		topoTree(manyCtx.ovTopoHost).children[topoTree(manyCtx.ovTopoHost).children.length - 1] ===
			findByClass(manyCtx.ovTopoHost, 'tsm-dmore') &&
		topoTreeRows(manyCtx.ovTopoHost).every(function (row) {
			return findAll(row, function (n) { return hasClass(n, 'tsm-dmore'); }).length === 0;
		}),
		'last=' + repr(topoTree(manyCtx.ovTopoHost).children.map(function (n) {
			return n.attrs['class'];
		})));
}

// ---------------------------------------------------------------- 7f. CSS 树状连线

function topoTreeState(count) {
	const list = [];

	for (let i = 1; i <= count; i++)
		list.push({ hostname: '终端' + i, link: (i % 2) ? 'wifi' : 'wired', rx_rate: i * 1000, tx_rate: 0 });

	return topoState({ devices: overviewTopoDevices(list) });
}

/*
 * 回归截图里的「连线在节点之间横向乱穿」：旧实现用 viewBox 0 0 100 100 +
 * preserveAspectRatio=none 的百分比 SVG，行高一变竖线就落不到节点顶部，
 * 多行时每行独立横线看起来像节点串联。现在断言旧代码彻底删掉，并且新 DOM 的
 * 「trunk → row(bus) → stem → row(bus) ...」顺序与每行节点数都正确。
 */
async function testTopoTree() {
	console.log('\n[7f] CSS 树状连线：删掉百分比 SVG，行总线 / 竖干 / 单节点行');

	check('源码不再有 topoBusSvg', !/function topoBusSvg|topoBusSvg\(/.test(SOURCE),
		'match=' + repr(SOURCE.match(/topoBusSvg/g)));
	check('源码不再有 .tsm-tline / tsm-tbus / tsm-otop-grid / tsm-otop-stem',
		SOURCE.indexOf('.tsm-tline') < 0 && SOURCE.indexOf('tsm-tbus') < 0 &&
		SOURCE.indexOf('tsm-otop-grid') < 0 && SOURCE.indexOf('tsm-otop-stem') < 0,
		'hits=' + repr([ '.tsm-tline', 'tsm-tbus', 'tsm-otop-grid', 'tsm-otop-stem' ]
			.filter(function (needle) { return SOURCE.indexOf(needle) >= 0; })));
	check('不再用 viewBox 0 0 100 100 / preserveAspectRatio=none 画连线',
		SOURCE.indexOf("viewBox: '0 0 100 100'") < 0 &&
		SOURCE.indexOf("preserveAspectRatio: 'none'") < 0 &&
		SOURCE.indexOf('preserveAspectRatio="none"') < 0,
		'viewBox=' + repr(SOURCE.match(/viewBox:\s*'[^']*'/g)));

	/* CSS：树 / 树干 / 竖干 / 行 / 总线 / 节点上挑线 / 单节点行 */
	const treeRule = SOURCE.match(/\.tsm-ttree\{[^}]*\}/);
	const trunkRule = SOURCE.match(/\.tsm-ttrunk\{[^}]*\}/);
	const stemRule = SOURCE.match(/\.tsm-tstem\{[^}]*\}/);
	const rowRule = SOURCE.match(/\.tsm-trow\{[^}]*\}/);
	const busRule = SOURCE.match(/\.tsm-trow-bus\{[^}]*\}/);
	const nodeLineRule = SOURCE.match(/\.tsm-dnode::before\{[^}]*\}/);

	check('树容器是纵向 flex、水平居中',
		treeRule != null && treeRule[0].indexOf('display:flex') >= 0 &&
		treeRule[0].indexOf('flex-direction:column') >= 0 &&
		treeRule[0].indexOf('align-items:center') >= 0,
		'tree=' + repr(treeRule));
	check('树干 12px、行间竖干 10px、线宽 1.5px',
		SOURCE.indexOf('.tsm-ttrunk{height:12px}') >= 0 &&
		SOURCE.indexOf('.tsm-tstem{height:10px}') >= 0 &&
		SOURCE.indexOf('.tsm-ttrunk,.tsm-tstem{flex:none;width:1.5px;') >= 0,
		'trunk=' + repr(trunkRule) + ' stem=' + repr(stemRule));
	check('每行一条总线：absolute top:0 left:25% width:50% 1.5px',
		busRule != null && busRule[0].indexOf('position:absolute') >= 0 &&
		busRule[0].indexOf('top:0') >= 0 && busRule[0].indexOf('left:25%') >= 0 &&
		busRule[0].indexOf('width:50%') >= 0 && busRule[0].indexOf('height:1.5px') >= 0,
		'bus=' + repr(busRule));
	check('节点从自身顶部向上 12px 连到本行总线（不画进节点内部）',
		nodeLineRule != null && nodeLineRule[0].indexOf('top:-12px') >= 0 &&
		nodeLineRule[0].indexOf('left:50%') >= 0 &&
		nodeLineRule[0].indexOf('height:12px') >= 0 &&
		nodeLineRule[0].indexOf('translateX(-50%)') >= 0,
		'nodeLine=' + repr(nodeLineRule));
	check('行 padding-top 与节点上挑线同高（12px 对齐）',
		rowRule != null && rowRule[0].indexOf('padding-top:12px') >= 0 &&
		nodeLineRule != null && nodeLineRule[0].indexOf('height:12px') >= 0,
		'row=' + repr(rowRule));
	check('单节点行隐藏总线、节点铺满两列',
		SOURCE.indexOf('.tsm-trow.is-single .tsm-trow-bus{display:none}') >= 0 &&
		SOURCE.indexOf('.tsm-trow.is-single .tsm-dnode{grid-column:1 / -1}') >= 0,
		'single=' + repr(SOURCE.match(/\.tsm-trow\.is-single[^{]*\{[^}]*\}/g)));

	/* 5 台在线：3 行 2/2/1，最后一行 is-single，节点顺序与数据一致 */
	const five = await boot({ state: topoTreeState(5) });
	const fiveRows = topoTreeRows(five.ctx.ovTopoHost);

	sameList('5 台 → 3 行（2/2/1）',
		fiveRows.map(function (row) { return topoRowNodes(row).length; }), [ 2, 2, 1 ]);
	check('前两行各有 1 条总线，最后一行 is-single 无总线',
		topoRowBus(fiveRows[0]) != null && topoRowBus(fiveRows[1]) != null &&
		topoRowBus(fiveRows[2]) == null && hasClass(fiveRows[2], 'is-single') &&
		!hasClass(fiveRows[0], 'is-single'),
		'rows=' + repr(fiveRows.map(function (row) {
			return { n: topoRowNodes(row).length, single: hasClass(row, 'is-single'),
				bus: topoRowBus(row) != null };
		})));
	same('5 台 3 行 → 2 根竖干', topoTreeStems(five.ctx.ovTopoHost).length, 2);
	check('节点按数据顺序排在行里（终端1..终端5）',
		fiveRows.map(function (row) {
			return topoRowNodes(row).map(function (node) {
				return textOf(findByClass(node, 'tsm-dnode-name'));
			}).join(',');
		}).join('|') === '终端1,终端2|终端3,终端4|终端5',
		'order=' + repr(fiveRows.map(function (row) {
			return topoRowNodes(row).map(function (node) {
				return textOf(findByClass(node, 'tsm-dnode-name'));
			});
		})));
	check('树结构顺序：trunk → row → stem → row → stem → row(is-single)',
		topoTree(five.ctx.ovTopoHost).children.map(function (node) {
			return node.attrs['class'].split(/\s+/)[0];
		}).join('|') === 'tsm-ttrunk|tsm-trow|tsm-tstem|tsm-trow|tsm-tstem|tsm-trow' &&
		hasClass(topoTree(five.ctx.ovTopoHost).children[5], 'is-single'),
		'children=' + repr(topoTree(five.ctx.ovTopoHost).children.map(function (node) {
			return node.attrs['class'];
		})));

	/* 单台：只有一行，is-single，没有总线也没有行间竖干 */
	const one = await boot({ state: topoTreeState(1) });
	const oneRows = topoTreeRows(one.ctx.ovTopoHost);

	same('单台 → 1 行', oneRows.length, 1);
	check('单台行 is-single、无总线、无行间竖干',
		hasClass(oneRows[0], 'is-single') && topoRowBus(oneRows[0]) == null &&
		topoTreeStems(one.ctx.ovTopoHost).length === 0,
		'row=' + repr(oneRows[0] && oneRows[0].attrs));
	check('单台树干仍在第一行之前',
		topoTree(one.ctx.ovTopoHost).children[0].attrs['class'] === 'tsm-ttrunk' &&
		topoTree(one.ctx.ovTopoHost).children[1] === oneRows[0],
		'children=' + repr(topoTree(one.ctx.ovTopoHost).children.map(function (node) {
			return node.attrs['class'];
		})));

	/* 320px：两列不降级、没有固定像素宽度 */
	const small = SOURCE.match(/@media \(max-width:320px\)\{[\s\S]*?\}\}/);

	check('拓扑线条加粗到 1.5px 并使用更明显的 --tsm-wire',
		/\.tsm-ttrunk,\.tsm-tstem\{[^}]*width:1\.5px[^}]*--tsm-wire/.test(SOURCE) &&
		/\.tsm-trow-bus\{[^}]*height:1\.5px[^}]*--tsm-wire/.test(SOURCE) &&
		/--tsm-wire:rgba\(0,0,0,\.26\)/.test(SOURCE) &&
		/--tsm-wire:rgba\(255,255,255,\.34\)/.test(SOURCE),
		'wire=' + (SOURCE.match(/--tsm-wire[^;}]*/g) || []).join('|'));
	check('320px 下 .tsm-trow 仍是两列',
		small != null && small[0].indexOf('.tsm-trow{grid-template-columns:repeat(2,minmax(0,1fr))}') >= 0,
		'small=' + repr(small && small[0].match(/\.tsm-trow\{[^}]*\}/g)));
	check('树/行/总线都没有固定像素宽度',
		!/\.tsm-ttree\{[^}]*\bwidth:\s*\d+px/.test(SOURCE) &&
		!/\.tsm-trow\{[^}]*\bwidth:\s*\d+px/.test(SOURCE) &&
		!/\.tsm-trow-bus\{[^}]*\bwidth:\s*\d+px/.test(SOURCE),
		'tree=' + repr(treeRule) + ' row=' + repr(rowRule));
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

	/* 设备节点 / 连线：两列行网格、1.5px 状态环、1px CSS 连接线、统一线色 */
	const rowRule = SOURCE.match(/\.tsm-trow\{[^}]*\}/);
	const ringRule = SOURCE.match(/\.tsm-dnode-ring\{[^}]*\}/);
	const busRule = SOURCE.match(/\.tsm-trow-bus\{[^}]*\}/);
	const nodeLineRule = SOURCE.match(/\.tsm-dnode::before\{[^}]*\}/);

	check('设备节点行固定两列（minmax(0,1fr) 不横向溢出）',
		rowRule != null && rowRule[0].indexOf('grid-template-columns:repeat(2,minmax(0,1fr))') >= 0,
		'row=' + repr(rowRule));
	check('设备节点自身没有固定像素宽度（靠网格自适应）',
		!/\.tsm-dnode\{[^}]*\bwidth:\s*\d+px/.test(SOURCE) &&
		/\.tsm-dnode\{[^}]*min-width:0/.test(SOURCE),
		'node=' + repr(SOURCE.match(/\.tsm-dnode\{[^}]*\}/)));
	check('状态环 1.5px、连接线 1.5px（线宽符合要求）',
		ringRule != null && ringRule[0].indexOf('border:1.5px solid') >= 0 &&
		busRule != null && busRule[0].indexOf('height:1.5px') >= 0 &&
		nodeLineRule != null && nodeLineRule[0].indexOf('width:1.5px') >= 0 &&
		nodeLineRule[0].indexOf('height:12px') >= 0,
		'ring=' + repr(ringRule) + ' bus=' + repr(busRule) + ' node=' + repr(nodeLineRule));
	check('连接线统一用 --tsm-wire（不再按 link 给线条上色）',
		busRule != null && busRule[0].indexOf('background:var(--tsm-wire)') >= 0 &&
		nodeLineRule != null && nodeLineRule[0].indexOf('background:var(--tsm-wire)') >= 0 &&
		!/\.tsm-tline/.test(SOURCE) && SOURCE.indexOf('tsm-tbus') < 0,
		'bus=' + repr(busRule) + ' node=' + repr(nodeLineRule));
	check('320px 媒体查询仍把节点行钉成两列',
		small != null &&
		small[0].indexOf('.tsm-trow{grid-template-columns:repeat(2,minmax(0,1fr))}') >= 0,
		'small=' + repr(small && small[0].slice(0, 300)));
	check('深色主题下连接线仍走变量（--tsm-wire 由深色块覆盖）',
		dark != null && dark[0].indexOf('--tsm-wire:rgba(255,255,255,.34)') >= 0 &&
		busRule != null && busRule[0].indexOf('var(--tsm-wire)') >= 0 &&
		nodeLineRule != null && nodeLineRule[0].indexOf('var(--tsm-wire)') >= 0,
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
	check('三个 RPC 都走 prism-router 对象',
		loaded.env.__declarations.every(function (item) {
			return item.object === 'prism-router';
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

	check('state.running=false → 提示 prism-routerd 未运行',
		stoppedText.indexOf('prism-routerd 未运行') >= 0, 'notice=' + repr(stoppedText));
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
	check('节点卡「⋮」44×44',
		hasRule('tsm-nmore', 'width:44px') && hasRule('tsm-nmore', 'height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-nmore\{[^}]*\}/g)));
	check('筛选胶囊 .tsm-chip 触控高度 ≥44px',
		hasRule('tsm-chip', 'min-height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-chip\{[^}]*\}/g)));

	/* 深色主题：chip 背景必须走变量，不能写死白底（否则浅字白底看不见）。 */
	check('chip 背景/文字走主题变量',
		/\.tsm-chip\{[^}]*background:var\(--tsm-card-bg\)/.test(SOURCE) &&
		/\.tsm-chip\{[^}]*color:var\(--tsm-text\)/.test(SOURCE) &&
		!/\.tsm-chip\{[^}]*background:#fff/.test(SOURCE),
		'规则=' + repr(SOURCE.match(/\.tsm-chip\{[^}]*\}/g)));
	check('深色主题定义了 card-bg / text 变量',
		/@media \(prefers-color-scheme: dark\)\{#ts-mobile\{[^}]*--tsm-card-bg:#1c2026/.test(SOURCE) &&
		/@media \(prefers-color-scheme: dark\)\{#ts-mobile\{[^}]*--tsm-text:#e7eaee/.test(SOURCE),
		'rule=' + repr((SOURCE.match(/@media \(prefers-color-scheme: dark\)\{#ts-mobile\{[^}]*\}/) || [])[0]));
	check('chip 选中态用深色文字 + 橙色描边/浅底（不用低对比橙字）',
		/\.tsm-chip\.on\{[^}]*color:var\(--tsm-text\)[^}]*border-color:rgba\(255,111,0[^}]*background:rgba\(255,111,0/.test(SOURCE) &&
		!/\.tsm-chip\.on\{[^}]*color:#ff6f00/.test(SOURCE),
		'规则=' + repr(SOURCE.match(/\.tsm-chip\.on\{[^}]*\}/g)));
	check('搜索清空按钮用 44×44 透明覆盖层',
		/\.tsm-dclear::before\{[^}]*width:44px[^}]*height:44px/.test(SOURCE),
		'规则=' + repr(SOURCE.match(/\.tsm-dclear::before\{[^}]*\}/g)));
	check('复制按钮触控高度 ≥44px', hasRule('tsm-copy', 'min-height:44px'),
		'规则=' + repr(SOURCE.match(/\.tsm-copy\{[^}]*\}/g)));
	check('节点「⋮」用负 top/right 保持图标位置',
		hasRule('tsm-nmore', 'top:-4px') && hasRule('tsm-nmore', 'right:-4px'),
		'规则=' + repr(SOURCE.match(/\.tsm-nmore\{[^}]*\}/g)));

	const booted = await boot();

	same('页面里不再有底部圆点按钮',
		findAll(booted.ctx.root, function (node) {
			return hasClass(node, 'tsm-dot-btn');
		}).length, 0);

	const chips = findAll(booted.ctx.root, function (node) {
		return hasClass(node, 'tsm-chip');
	});

	check('筛选胶囊仍是 <button> 且带文案',
		chips.length > 0 && chips.every(function (node) {
			return node.tag === 'button' && textOf(node).length > 0;
		}),
		'chips=' + repr(chips.map(function (node) { return textOf(node); }).slice(0, 6)));
}



// ---------------------------------------------------------------- 17. 下拉刷新

/* 触摸事件桩：带 touches / changedTouches / preventDefault，够 bindSwipe + bindPullRefresh 用。 */
function touchEvent(points) {
	const list = points.map(function (p) { return { clientX: p.x, clientY: p.y }; });
	const ev = {
		touches: list,
		changedTouches: list,
		cancelable: true,
		defaultPrevented: false,
		preventDefault: function () { ev.defaultPrevented = true; }
	};

	return ev;
}

function fireTouch(node, type, points) {
	const ev = touchEvent(points);

	(node.listeners[type] || []).forEach(function (fn) { fn(ev); });

	return ev;
}

/* 执行 window.setTimeout 登记的回调（切屏入场类的移除靠它）。 */
function runTimeouts(env) {
	const list = env.__timeouts.scheduled.slice();

	env.__timeouts.scheduled.length = 0;
	list.forEach(function (item) {
		if (typeof item.fn === 'function') item.fn();
	});
}

async function testPullRefresh() {
	console.log('\n[17] 下拉刷新：顶部 >64px 触发 refresh(true)，水平/非顶部让位');

	const booted = await boot();
	const ctx = booted.ctx;
	const host = findByClass(ctx.root, 'tsm-pages');
	const calls = [];

	ctx.refresh = function (manual) { calls.push(manual); return Promise.resolve(); };

	check('下拉指示器挂在 .tsm-pages 顶部且默认隐藏',
		ctx.pullNode != null && host.children[0] === ctx.pullNode &&
		ctx.pullNode.style.opacity === '0',
		'first=' + repr(host.children[0] === ctx.pullNode) +
		' style=' + repr(ctx.pullNode && ctx.pullNode.style));
	check('指示器带旋转箭头 SVG + 「下拉刷新」文案',
		ctx.pullIcon != null && ctx.pullIcon.tag === 'svg' && textOf(ctx.pullText) === '下拉刷新',
		'icon=' + repr(ctx.pullIcon && ctx.pullIcon.tag) + ' text=' + repr(textOf(ctx.pullText)));
	check('指示器不参与 5 屏（.tsm-page 仍是 5 个）',
		findAll(ctx.root, function (n) { return hasClass(n, 'tsm-page'); }).length === 5 &&
		!hasClass(ctx.pullNode, 'tsm-page'),
		'pages=' + findAll(ctx.root, function (n) { return hasClass(n, 'tsm-page'); }).length);

	/* 顶部下拉 100px → 松手刷新一次 */
	fireTouch(host, 'touchstart', [ { x: 40, y: 100 } ]);
	const move = fireTouch(host, 'touchmove', [ { x: 40, y: 200 } ]);

	same('下拉超过 64px 文案变「松手刷新」', textOf(ctx.pullText), '松手刷新');
	check('顶部下拉时 preventDefault 阻止页面滚动', move.defaultPrevented === true);
	check('指示器跟手可见且随位移旋转',
		Number(ctx.pullNode.style.opacity) > 0 &&
		/rotate\(\d+deg\)/.test('' + ctx.pullIcon.style.transform),
		'opacity=' + repr(ctx.pullNode.style.opacity) +
		' transform=' + repr(ctx.pullIcon.style.transform));

	fireTouch(host, 'touchend', [ { x: 40, y: 200 } ]);

	sameList('>64px 松手触发一次 refresh(true)', calls, [ true ]);
	same('刷新过程中文案是「刷新中…」', textOf(ctx.pullText), '刷新中…');
	check('刷新过程中指示器停在可见位',
		ctx.pullNode.style.transform === 'translateY(0)' &&
		hasClass(ctx.pullNode, 'busy'),
		'style=' + repr(ctx.pullNode.style) + ' class=' + repr(ctx.pullNode.attrs['class']));

	await flush();

	same('刷新完成后指示器回弹归零（opacity 0）', ctx.pullNode.style.opacity, '0');
	same('刷新完成后指示器移出视口', ctx.pullNode.style.transform, 'translateY(-100%)');
	same('刷新完成后文案复位', textOf(ctx.pullText), '下拉刷新');
	check('刷新完成后旋转动画 class 移除', !hasClass(ctx.pullNode, 'busy'),
		'class=' + repr(ctx.pullNode.attrs['class']));

	/* 下拉 50px（<64）不触发 */
	calls.length = 0;
	fireTouch(host, 'touchstart', [ { x: 40, y: 100 } ]);
	fireTouch(host, 'touchmove', [ { x: 40, y: 150 } ]);
	same('下拉 50px 时仍是「下拉刷新」', textOf(ctx.pullText), '下拉刷新');
	fireTouch(host, 'touchend', [ { x: 40, y: 150 } ]);
	sameList('<64px 松手不触发刷新', calls, []);
	same('未触发刷新也会回弹', ctx.pullNode.style.opacity, '0');

	/* 水平滑动：让位给左右切屏，不触发下拉 */
	calls.length = 0;
	const pageBefore = ctx.pageIndex;
	fireTouch(host, 'touchstart', [ { x: 200, y: 200 } ]);
	const hMove = fireTouch(host, 'touchmove', [ { x: 40, y: 210 } ]);
	fireTouch(host, 'touchend', [ { x: 40, y: 210 } ]);

	sameList('水平滑动不触发下拉刷新', calls, []);
	check('水平滑动不拦默认滚动', hMove.defaultPrevented === false);
	same('水平滑动交给左右切屏（已切到下一屏）', ctx.pageIndex, pageBefore + 1);
	same('水平滑动后指示器仍是隐藏态', ctx.pullNode.style.opacity, '0');

	/* 非顶部：不介入，交给页面正常滚动 */
	ctx.setPage(0);
	calls.length = 0;
	booted.env.document.body.scrollTop = 120;

	fireTouch(host, 'touchstart', [ { x: 40, y: 100 } ]);
	const sMove = fireTouch(host, 'touchmove', [ { x: 40, y: 220 } ]);
	fireTouch(host, 'touchend', [ { x: 40, y: 220 } ]);

	sameList('非顶部下拉不触发刷新', calls, []);
	check('非顶部下拉不拦默认滚动', sMove.defaultPrevented === false);
	same('非顶部下拉不显示指示器', ctx.pullNode.style.opacity, '0');

	booted.env.document.body.scrollTop = 0;

	/* 只有概览 / 设备 / 拓扑三屏：节点屏不介入 */
	ctx.setPage(2);
	await ctx.ensureNodeData();
	calls.length = 0;
	booted.env.document.body.scrollTop = 0;

	fireTouch(host, 'touchstart', [ { x: 40, y: 100 } ]);
	const nMove = fireTouch(host, 'touchmove', [ { x: 40, y: 220 } ]);
	fireTouch(host, 'touchend', [ { x: 40, y: 220 } ]);

	sameList('节点屏下拉不触发刷新', calls, []);
	check('节点屏下拉不拦默认滚动', nMove.defaultPrevented === false);

	/* 设备屏 / 拓扑屏同样支持下拉刷新 */
	for (const pullPage of [ 1, 3 ]) {
		ctx.setPage(pullPage);
		calls.length = 0;

		fireTouch(host, 'touchstart', [ { x: 40, y: 100 } ]);
		fireTouch(host, 'touchmove', [ { x: 40, y: 200 } ]);
		fireTouch(host, 'touchend', [ { x: 40, y: 200 } ]);

		sameList('第 ' + (pullPage + 1) + ' 屏下拉也触发 refresh(true)', calls, [ true ]);

		await flush();
	}

	/* 桌面端：没有 touch 就不会进这套逻辑 → 指示器默认 opacity:0（静态样式断言） */
	check('CSS 里指示器默认透明 + 移出视口（桌面端不显示）',
		/\.tsm-pull\{[^}]*opacity:0[^}]*translateY\(-100%\)/.test(SOURCE),
		'rule=' + repr((SOURCE.match(/\.tsm-pull\{[^}]*\}/) || [])[0]));
	check('touchmove 用 passive:false 才能 preventDefault',
		/'touchmove'[\s\S]{0,4000}?passive: false/.test(SOURCE),
		'match=' + repr(/'touchmove'[\s\S]{0,4000}?passive: false/.test(SOURCE)));
}

// ---------------------------------------------------------------- 18. 骨架屏

async function testSkeletonScreens() {
	console.log('\n[18] 骨架屏：state=null 时 6/5/2 个 .tsm-skel，数据到达后清空');

	const booted = await boot({ rejectState: new Error('state boom') });
	const ctx = booted.ctx;

	function skelCount(node) {
		return findAll(node, function (n) { return hasClass(n, 'tsm-skel'); }).length;
	}

	same('state=null：概览 6 个数字块骨架', skelCount(ctx.pages[0]), 6);
	same('state=null：设备列表 5 行骨架', skelCount(ctx.devicesBox), 5);
	same('state=null：拓扑 2 层卡片骨架', skelCount(ctx.topoHost), 2);
	same('骨架不新增 .tsm-page',
		findAll(ctx.root, function (n) { return hasClass(n, 'tsm-page'); }).length, 5);
	check('骨架块都带 aria-hidden（纯装饰）',
		findAll(ctx.pages[0], function (n) { return hasClass(n, 'tsm-skel'); })
			.every(function (n) { return n.attrs['aria-hidden'] === 'true'; }),
		'blocks=' + repr(findAll(ctx.pages[0], function (n) { return hasClass(n, 'tsm-skel'); })
			.map(function (n) { return n.attrs; }).slice(0, 2)));

	/* 数据到达：骨架被真实内容替换（节点数量归 0） */
	delete booted.env.__rejections.get_state;
	booted.env.__responses.get_state = baseState({
		totals: { rx_rate: 1000000, tx_rate: 500000, direct_rx: 10, direct_tx: 5 }
	});

	await ctx.refresh(false);
	await flush();

	same('数据到达：概览骨架清空', skelCount(ctx.pages[0]), 0);
	same('数据到达：设备骨架清空', skelCount(ctx.devicesBox), 0);
	same('数据到达：拓扑骨架清空', skelCount(ctx.topoHost), 0);
	check('数据到达：概览换成真实数字',
		textOf(ctx.txNum) === '4.0' && textOf(ctx.rxNum) === '8.0',
		'tx=' + repr(textOf(ctx.txNum)) + ' rx=' + repr(textOf(ctx.rxNum)));

	check('骨架屏有 shimmer 动画',
		/@keyframes tsm-shimmer/.test(SOURCE) &&
		/\.tsm-skel::after\{[^}]*animation:tsm-shimmer/.test(SOURCE),
		'keyframes=' + repr(SOURCE.match(/@keyframes tsm-shimmer[^}]*\}/)));
	check('reduced-motion 关闭骨架动画',
		/@media \(prefers-reduced-motion: reduce\)\{\.tsm-skel::after\{animation:none/.test(SOURCE),
		'rule=' + repr(SOURCE.match(/@media \(prefers-reduced-motion: reduce\)\{\.tsm-skel[^}]*\}[^}]*\}/)));
}

// ---------------------------------------------------------------- 19. 切屏过渡

async function testPageTransition() {
	console.log('\n[19] 切屏过渡：入场 class / 方向相反 / 150ms 后移除 / reduced-motion 禁用');

	const booted = await boot();
	const ctx = booted.ctx;

	function enterNodes() {
		return findAll(ctx.pagesHost, function (n) {
			return hasClass(n, 'is-enter') || hasClass(n, 'is-enter-next') || hasClass(n, 'is-enter-prev');
		});
	}

	same('首屏渲染不带入场动画', enterNodes().length, 0);

	ctx.setPage(2);

	check('setPage(2)：目标页带 .is-enter', hasClass(ctx.pages[2], 'is-enter'),
		'class=' + repr(ctx.pages[2].attrs['class']));
	check('向后切屏用 .is-enter-next（从右进）', hasClass(ctx.pages[2], 'is-enter-next'),
		'class=' + repr(ctx.pages[2].attrs['class']));
	same('同一时间只有一屏有入场类', enterNodes().length, 1);
	same('同一时间只有一屏可见（.on）',
		ctx.pages.filter(function (page) { return hasClass(page, 'on'); }).length, 1);
	check('入场 class 由 150ms 定时器移除', ctx.enterTimer != null &&
		booted.env.__timeouts.scheduled.some(function (item) { return item.ms === 150; }),
		'timers=' + repr(booted.env.__timeouts.scheduled.map(function (t) { return t.ms; })));

	runTimeouts(booted.env);

	same('150ms 后入场类全部移除', enterNodes().length, 0);
	same('150ms 后页面仍停在第 3 屏', ctx.pageIndex, 2);

	ctx.setPage(0);

	check('向前切屏用 .is-enter-prev（从左进）',
		hasClass(ctx.pages[0], 'is-enter-prev') && !hasClass(ctx.pages[0], 'is-enter-next'),
		'class=' + repr(ctx.pages[0].attrs['class']));
	same('回落时旧页的入场类已清掉', enterNodes().length, 1);

	runTimeouts(booted.env);

	check('CSS 定义淡入 + 8px 位移与 150ms',
		/@keyframes tsm-enter-next\{from\{opacity:0;transform:translateX\(8px\)\}/.test(SOURCE) &&
		/@keyframes tsm-enter-prev\{from\{opacity:0;transform:translateX\(-8px\)\}/.test(SOURCE) &&
		/\.tsm-page\.on\.is-enter-next\{animation:tsm-enter-next \.15s/.test(SOURCE),
		'enter=' + repr(SOURCE.match(/@keyframes tsm-enter-[a-z]+\{[^}]*\}[^}]*\}/g)));
	check('reduced-motion 禁用入场动画',
		/@media \(prefers-reduced-motion: reduce\)\{\.tsm-page\.on\.is-enter-next,\.tsm-page\.on\.is-enter-prev\{animation:none\}\}/.test(SOURCE),
		'rule=' + repr(SOURCE.match(/@media \(prefers-reduced-motion: reduce\)\{\.tsm-page[^}]*\}[^}]*\}/)));
}

// ---------------------------------------------------------------- 20. 安全区

async function testSafeArea() {
	console.log('\n[20] 安全区：env(safe-area-inset-*) + viewport-fit=cover（不重复 viewport）');

	check('CSS 含 env(safe-area-inset-top)', SOURCE.indexOf('env(safe-area-inset-top') >= 0,
		'match=' + repr((SOURCE.match(/[^']*safe-area-inset-top[^']*/g) || []).slice(0, 1)));
	check('CSS 含 env(safe-area-inset-bottom)', SOURCE.indexOf('env(safe-area-inset-bottom') >= 0,
		'match=' + repr((SOURCE.match(/[^']*safe-area-inset-bottom[^']*/g) || []).slice(0, 1)));
	check('#ts-mobile 顶部/底部留出安全区',
		/#ts-mobile\{padding-top:env\(safe-area-inset-top,0px\);padding-bottom:calc\(12px \+ env\(safe-area-inset-bottom,0px\)\)\}/.test(SOURCE),
		'rule=' + repr(SOURCE.match(/#ts-mobile\{padding-top:env[^}]*\}/)));
	check('底部不再有固定圆点栏占位（无 .tsm-dots 规则）',
		!/\.tsm-dots\{/.test(SOURCE),
		'rule=' + repr(SOURCE.match(/\.tsm-dots\{[^}]*\}/g)));
	check('sticky tab 也避开刘海',
		/\.tsm-tabs\{top:env\(safe-area-inset-top/.test(SOURCE),
		'rule=' + repr(SOURCE.match(/\.tsm-tabs\{top:env[^}]*\}/)));

	const booted = await boot();
	const metas = findAll(booted.env.__head, function (n) {
		return n != null && n.tag === 'meta' && n.attrs != null && n.attrs.name === 'viewport';
	});

	same('head 里只有一个 viewport meta', metas.length, 1);
	check('viewport 含 viewport-fit=cover',
		metas.length === 1 && ('' + metas[0].attrs.content).indexOf('viewport-fit=cover') >= 0,
		'content=' + repr(metas[0] && metas[0].attrs.content));
}

// ---------------------------------------------------------------- 21. 迷你趋势

function pairCount(points) {
	const text = (points == null) ? '' : ('' + points);

	return text.length ? text.split(' ').length : 0;
}

async function testSparkline() {
	console.log('\n[21] 迷你趋势：120×32 SVG、2 条 polyline、12 次采样、空态占位');

	/* 没有数据：占位横线，折线为空 */
	const emptyBoot = await boot({ skipLoad: true });
	const emptyCtx = emptyBoot.ctx;

	check('无数据时占位横线可见',
		emptyCtx.sparkPh != null && emptyCtx.sparkPh.tag === 'line' &&
		emptyCtx.sparkPh.style.display !== 'none',
		'ph=' + repr(emptyCtx.sparkPh && emptyCtx.sparkPh.style));
	same('无数据时下行折线 points 为空', emptyCtx.sparkDown.attrs.points, '');
	same('无数据时上行折线 points 为空', emptyCtx.sparkUp.attrs.points, '');

	const booted = await boot({ state: baseState({ totals: { rx_rate: 2000000, tx_rate: 1000000 } }) });
	const ctx = booted.ctx;
	const svgs = findAll(ctx.pages[0], function (n) {
		return n.tag === 'svg' && hasClass(n, 'tsm-spark');
	});

	same('概览只有 1 个 sparkline SVG', svgs.length, 1);
	same('sparkline viewBox = 0 0 120 32', svgs[0].attrs.viewBox, '0 0 120 32');
	same('sparkline 宽 120', svgs[0].attrs.width, '120');
	same('sparkline 高 32', svgs[0].attrs.height, '32');
	check('sparkline 在速率数字下方（.tsm-rates 之后）',
		ctx.pages[0].children.indexOf(findByClass(ctx.pages[0], 'tsm-sparkwrap')) ===
			ctx.pages[0].children.indexOf(findByClass(ctx.pages[0], 'tsm-rates')) + 1,
		'order=' + repr(ctx.pages[0].children.map(function (n) {
			return (n && n.attrs && n.attrs['class']) || n;
		})));

	const polylines = findAll(svgs[0], function (n) { return n.tag === 'polyline'; });

	same('两条折线（下行 + 上行）', polylines.length, 2);
	same('下行折线是蓝色', polylines[0].attrs.stroke, '#2b7de9');
	same('上行折线是橙色', polylines[1].attrs.stroke, '#ff6f00');
	same('首屏 1 次采样 → 1 个点', pairCount(polylines[0].attrs.points), 1);

	/* 再 sync 11 次 = 12 次采样 */
	for (let i = 0; i < 11; i++)
		ctx.syncAll(baseState({ totals: { rx_rate: 2000000 + i, tx_rate: 1000000 + i } }));

	same('12 次 sync 后下行折线 12 个点', pairCount(ctx.sparkDown.attrs.points), 12);
	same('12 次 sync 后上行折线 12 个点', pairCount(ctx.sparkUp.attrs.points), 12);
	same('内存采样数 = 12', ctx.sparkSamples.length, 12);
	same('有数据后占位横线隐藏', ctx.sparkPh.style.display, 'none');

	/* 继续追加：cap 12，最早的被丢弃 */
	for (let i = 0; i < 3; i++)
		ctx.syncAll(baseState({ totals: { rx_rate: 3000 + i, tx_rate: 1000 } }));

	same('超过 12 次仍只保留 12 个点', pairCount(ctx.sparkDown.attrs.points), 12);
	same('数组长度 cap 在 12', ctx.sparkSamples.length, 12);
	same('保留的是最近一次采样',
		ctx.sparkSamples[ctx.sparkSamples.length - 1].rx, 3002);
	check('折线仍是 SVG 元素（不用 canvas）',
		ctx.sparkDown.tag === 'polyline' &&
		findAll(ctx.pages[0], function (n) { return n.tag === 'canvas'; }).length === 0);
}

// ---------------------------------------------------------------- 22. Top3 卡片

async function testOverviewTop3() {
	console.log('\n[22] 概览 Top3：设备/应用各 3 项排序正确，点设备切屏并展开');

	const devices = [
		{ mac: 'T1', hostname: '甲', link: 'wifi', last_seen: NOW - 60, direct_rx: 100, direct_tx: 0 },
		{ mac: 'T2', hostname: '乙', link: 'wifi', last_seen: NOW - 60, direct_rx: 5000, direct_tx: 0 },
		{ mac: 'T3', hostname: '丙', link: 'wifi', last_seen: NOW - 60, proxy_rx: 300, proxy_tx: 200 },
		{ mac: 'T4', hostname: '丁', link: 'wired', last_seen: NOW - 60, direct_rx: 40, direct_tx: 0 },
		{ mac: 'T5', hostname: '戊', link: 'wifi', last_seen: NOW - 60, direct_rx: 900, direct_tx: 100 }
	];
	const apps = [
		{ host: 'a.example', rx: 10, tx: 0 },
		{ host: 'b.example', rx: 3000, tx: 0 },
		{ host: 'c.example', rx: 500, tx: 500 },
		{ host: 'd.example', rx: 1, tx: 0 },
		{ host: 'e.example', rx: 2000, tx: 0 }
	];

	const booted = await boot({ state: baseState({ devices: devices, apps: apps }) });
	const ctx = booted.ctx;

	const cards = findAll(ctx.pages[0], function (n) { return hasClass(n, 'tsm-topcard'); });

	same('概览有 2 张 Top3 卡片', cards.length, 2);
	sameList('两卡标题是「流量 Top 设备」「应用 Top 3」',
		cards.map(function (card) { return textOf(findByClass(card, 'tsm-topcard-t')); }),
		[ '流量 Top 设备', '应用 Top 3' ]);

	const inFoot = findByClass(ctx.pages[0], 'tsm-foot');

	check('Top3 卡片在「N 台终端」胶囊下方（同一个 .tsm-foot 里）',
		inFoot != null && findByClass(inFoot, 'tsm-top3') != null &&
		inFoot.children.indexOf(ctx.devPill) === 1,
		'foot=' + repr(inFoot && inFoot.children.map(function (n) {
			return (n && n.attrs && n.attrs['class']) || n;
		})));

	const devRows = findAll(ctx.topDevBox, function (n) { return hasClass(n, 'tsm-toprow'); });
	const appRows = findAll(ctx.topAppBox, function (n) { return hasClass(n, 'tsm-toprow'); });

	same('流量 Top 设备卡片 3 项', devRows.length, 3);
	sameList('设备按合计流量降序',
		devRows.map(function (row) { return textOf(findByClass(row, 'tsm-topname')); }),
		[ '乙', '戊', '丙' ]);
	sameList('设备流量显示为格式化字节',
		devRows.map(function (row) { return textOf(findByClass(row, 'tsm-topval')); }),
		[ '5 KiB', '1000 B', '500 B' ]);

	same('应用 Top 3 卡片 3 项', appRows.length, 3);
	sameList('应用按流量降序',
		appRows.map(function (row) { return textOf(findByClass(row, 'tsm-topname')); }),
		[ 'b.example', 'e.example', 'c.example' ]);
	sameList('应用流量显示为格式化字节',
		appRows.map(function (row) { return textOf(findByClass(row, 'tsm-topval')); }),
		[ '3 KiB', '2 KiB', '1000 B' ]);

	check('设备 Top 行是可点按钮（≥40px + 有 click）',
		devRows.every(function (row) {
			return row.tag === 'button' && typeof row.attrs.click === 'function';
		}),
		'rows=' + repr(devRows.map(function (row) { return row.tag; })));
	check('应用 Top 行不可点（手机版没有应用屏）',
		appRows.every(function (row) {
			return (row.listeners == null) || (row.listeners.click == null);
		}),
		'listeners=' + repr(appRows.map(function (row) { return Object.keys(row.listeners || {}); })));

	/* 点设备：切到设备屏 + 展开该设备 */
	const pageBefore = ctx.pageIndex;

	devRows[0].attrs.click();

	same('点设备 Top 行切到设备屏', ctx.pageIndex, 1);
	check('切屏方向也是正常入场（页变了）', ctx.pageIndex !== pageBefore);

	const shownRows = findAll(ctx.devicesBox, function (n) { return hasClass(n, 'tsm-drow'); });

	same('设备屏渲染出 5 台设备', shownRows.length, 5);
	check('点中的设备行已展开（.on + aria-expanded）',
		shownRows[0].attrs['aria-expanded'] === 'true' && hasClass(shownRows[0], 'on'),
		'aria=' + repr(shownRows[0].attrs['aria-expanded']) +
		' class=' + repr(shownRows[0].attrs['class']));
	check('展开区可见（display 不是 none）',
		shownRows[0].parentNode.children[1].style.display !== 'none',
		'item=' + repr(shownRows[0].parentNode.children.map(function (n) { return n.style; })));
	same('目标设备分类是主网络', ctx.devTab, 'main');
	same('点 Top 设备不会发 RPC（只有懒加载的 0 次）',
		countCalls(booted.env, 'get_state'), 1);

	/* 空数据：两卡各给占位，不伪造条目 */
	const emptyBoot = await boot({ state: baseState() });
	const emptyCtx = emptyBoot.ctx;

	same('无设备时设备卡给占位',
		findAll(emptyCtx.topDevBox, function (n) { return hasClass(n, 'tsm-toprow-empty'); }).length, 1);
	same('无应用时应用卡给占位',
		findAll(emptyCtx.topAppBox, function (n) { return hasClass(n, 'tsm-toprow-empty'); }).length, 1);
	same('占位不产生可点行',
		findAll(emptyCtx.topDevBox, function (n) { return n.listeners && n.listeners.click; }).length, 0);
}

// ---------------------------------------------------------------- 23~33. 离线快照

/* 键名在这里写死：这是需求约定，不能只信 mobile.js 自己导出的常量。 */
const SNAPSHOT_KEY = 'prismRouterMobileSnapshot.v1';

const SNAPSHOT_TOTALS_OK = [
	'rx_rate', 'tx_rate',
	'direct_rx', 'direct_tx', 'proxy_rx', 'proxy_tx',
	'wifi_rx', 'wifi_tx', 'wired_rx', 'wired_tx', 'unknown_rx', 'unknown_tx'
];
const SNAPSHOT_DEVICE_OK = [ 'name', 'mac', 'ip', 'link', 'rx_rate', 'tx_rate', 'last_seen' ];
const SNAPSHOT_TOP_OK = [ 'v', 'ts', 'totals', 'devices', 'health', 'nodes', 'quota', 'truncated' ];

function two(n) { return (n < 10 ? '0' : '') + n; }

function hhmm(ts) {
	const d = new Date(ts * 1000);

	return two(d.getHours()) + ':' + two(d.getMinutes());
}

/* 一份"真实"的 state：带 node/health/quota，也带绝不该落盘的 token/secret/apps。 */
function offlineState() {
	return baseState({
		totals: {
			direct_rx: 1024, direct_tx: 2048, proxy_rx: 4096, proxy_tx: 8192,
			wifi_rx: 100, wifi_tx: 200, wired_rx: 300, wired_tx: 400,
			unknown_rx: 0, unknown_tx: 0,
			rx_rate: 125000, tx_rate: 250000
		},
		health: { accounting_confidence: 'degraded', reasons: [ 'nft 计数回退' ] },
		nodes: { 'HK-01': { rx: 4096, tx: 8192 }, 'JP-02': { rx: 1024, tx: 2048 } },
		quota: { total_limit: 1073741824, period: '2026-11' },
		devices: [
			{
				hostname: '客厅电视', mac: 'AA:BB:CC:00:00:01', ip: '192.168.1.11', link: 'wifi',
				rx_rate: 1000, tx_rate: 2000, last_seen: NOW - 30, direct_rx: 11,
				apps: [ { host: 'secret.example.com', rx: 1 } ], token: 'tok-device-SHOULD-NOT-LEAK'
			},
			{
				hostname: '书房台式', mac: 'AA:BB:CC:00:00:02', ip: '192.168.1.12', link: 'wired',
				rx_rate: 3000, tx_rate: 4000, last_seen: NOW - 20, token: 'tok-device-2'
			}
		],
		token: 'tok-state-SHOULD-NOT-LEAK',
		secret: 'sec-SHOULD-NOT-LEAK',
		apps: [ { host: 'secret.example.com', rx: 9, tx: 9 } ]
	});
}

/* 造一批设备：名称够长，3000 台足以把 JSON 撑过 64KB。 */
function bulkDevices(count) {
	const list = [];

	for (let i = 0; i < count; i++) {
		list.push({
			hostname: 'bulk-device-' + i + '-' + 'x'.repeat(60),
			mac: 'AA:BB:CC:11:22:' + (i % 256),
			ip: '10.0.' + Math.floor(i / 250) + '.' + (i % 250),
			link: (i % 2) ? 'wifi' : 'wired',
			rx_rate: i, tx_rate: i + 1, last_seen: NOW - 5,
			direct_rx: i, proxy_rx: i
		});
	}

	return list;
}

/* 成功同步一次拿到的快照文本（模拟"上次能连上后端时留下的副本"）。 */
async function snapshotFixture(state) {
	const first = await boot({ state: state || offlineState() });

	return first.env.__store.getItem(SNAPSHOT_KEY);
}

async function testSnapshotWrite() {
	console.log('\n[23] 快照写入：键正确 / 字段白名单 / 不含 apps·token·secret');

	const booted = await boot({ state: offlineState() });
	const env = booted.env;
	const hooks = booted.hooks;
	const key = hooks.SNAPSHOT_KEY;
	const raw = env.__store.getItem(key);

	check('成功同步后写入了快照', raw != null, 'raw=' + repr(raw && raw.slice(0, 80)));
	same('导出的键名正确', key, SNAPSHOT_KEY);
	check('源码里用的是约定键名', SOURCE.indexOf("'" + SNAPSHOT_KEY + "'") >= 0,
		'match=' + repr((SOURCE.match(/SNAPSHOT_KEY\s*=\s*'[^']*'/) || [])[0]));
	same('写入的是同一个键', env.__store.getItem(SNAPSHOT_KEY), raw);

	if (raw == null) return;

	const snap = JSON.parse(raw);

	same('快照版本 v=1', snap.v, 1);
	same('快照 ts = state.ts', snap.ts, NOW);
	sameList('快照顶层字段都在白名单内',
		Object.keys(snap).filter(function (k) { return SNAPSHOT_TOP_OK.indexOf(k) < 0; }), []);

	check('totals 保留速率与累计',
		snap.totals.rx_rate === 125000 && snap.totals.tx_rate === 250000 &&
		snap.totals.direct_rx === 1024 && snap.totals.proxy_tx === 8192,
		'totals=' + repr(snap.totals));
	sameList('totals 只含白名单字段',
		Object.keys(snap.totals).filter(function (k) { return SNAPSHOT_TOTALS_OK.indexOf(k) < 0; }), []);

	same('devices 条数', snap.devices.length, 2);
	sameList('devices 只含白名单字段',
		snap.devices.reduce(function (acc, dev) {
			return acc.concat(Object.keys(dev).filter(function (k) {
				return SNAPSHOT_DEVICE_OK.indexOf(k) < 0;
			}));
		}, []), []);
	same('设备名写在 name 字段', snap.devices[0].name, '客厅电视');
	same('设备名不再是 hostname 字段', Object.prototype.hasOwnProperty.call(snap.devices[0], 'hostname'), false);
	same('设备不存 apps', Object.prototype.hasOwnProperty.call(snap.devices[0], 'apps'), false);
	check('设备速率 / 链路 / last_seen 保留',
		snap.devices[1].rx_rate === 3000 && snap.devices[1].tx_rate === 4000 &&
		snap.devices[1].link === 'wired' && snap.devices[1].last_seen === NOW - 20,
		'dev=' + repr(snap.devices[1]));

	sameList('health 只含 confidence / reasons', Object.keys(snap.health).sort(), [ 'confidence', 'reasons' ]);
	same('health.confidence 取自 accounting_confidence', snap.health.confidence, 'degraded');
	sameList('health.reasons 原样保留', snap.health.reasons, [ 'nft 计数回退' ]);
	same('nodes 保留出口 rx', snap.nodes['HK-01'].rx, 4096);
	same('nodes 保留出口 tx', snap.nodes['HK-01'].tx, 8192);
	same('quota 保留 total_limit', snap.quota.total_limit, 1073741824);
	same('quota 保留 period', snap.quota.period, '2026-11');

	check('快照文本不含 token / secret',
		raw.indexOf('token') < 0 && raw.indexOf('secret') < 0 && raw.indexOf('SHOULD-NOT-LEAK') < 0,
		'raw=' + repr(raw.slice(0, 200)));
	check('快照文本不含 apps 明细',
		raw.indexOf('apps') < 0 && raw.indexOf('secret.example.com') < 0,
		'raw=' + repr(raw.slice(0, 200)));
	check('快照 JSON 在 64KB 以内',
		hooks.snapBytes(raw) <= hooks.SNAPSHOT_MAX_BYTES,
		'bytes=' + hooks.snapBytes(raw) + ' 上限=' + hooks.SNAPSHOT_MAX_BYTES);
	check('小快照不标 truncated', snap.truncated !== true, 'truncated=' + repr(snap.truncated));
	same('snapBytes 按 UTF-8 计（中文 3 字节）', hooks.snapBytes('中'), 3);
}

async function testSnapshotTruncate() {
	console.log('\n[24] 64KB 上限：devices 截断到 200 条并标 truncated');

	const booted = await boot({ state: baseState() });
	const env = booted.env;
	const hooks = booted.hooks;

	same('超限快照仍然写入成功', hooks.writeSnapshot(baseState({ devices: bulkDevices(3000) })), true);

	const raw = env.__store.getItem(SNAPSHOT_KEY);

	check('超限时 JSON 不超过 64KB',
		hooks.snapBytes(raw) <= hooks.SNAPSHOT_MAX_BYTES,
		'bytes=' + hooks.snapBytes(raw) + ' 上限=' + hooks.SNAPSHOT_MAX_BYTES);

	const snap = JSON.parse(raw);

	same('truncated 标记为 true', snap.truncated, true);
	same('devices 截断到 200 条', snap.devices.length, hooks.SNAPSHOT_MAX_DEVICES);
	same('截断后仍是 200 条上限常量', hooks.SNAPSHOT_MAX_DEVICES, 200);
	same('截断后 ts 仍保留', snap.ts, NOW);
	check('截断后 totals 仍保留', snap.totals.rx_rate === 0 && snap.totals.tx_rate === 0,
		'totals=' + repr(snap.totals));

	/* 小数据不该被截断：3 台设备原样保留，也没有 truncated 标记 */
	hooks.writeSnapshot(baseState({ devices: bulkDevices(3) }));

	const small = JSON.parse(env.__store.getItem(SNAPSHOT_KEY));

	same('小数据 devices 全保留', small.devices.length, 3);
	check('小数据没有 truncated 标记', small.truncated !== true, 'truncated=' + repr(small.truncated));

	/* snapshotJson 是纯函数：超限时自己就能收敛到上限内 */
	const huge = hooks.snapshotJson(hooks.buildSnapshot(baseState({ devices: bulkDevices(3000) })));

	check('snapshotJson 自己就收敛到 64KB',
		huge != null && hooks.snapBytes(huge) <= hooks.SNAPSHOT_MAX_BYTES,
		'bytes=' + (huge == null ? 'null' : hooks.snapBytes(huge)));
	same('snapshotJson 结果的 devices 也是 200 条', JSON.parse(huge).devices.length, 200);
	same('还原后的 state 也带 truncated（设备屏提示列表已裁剪）',
		hooks.stateFromSnapshot(snap).truncated, true);
}

async function testSnapshotRestore() {
	console.log('\n[25] 首屏失败：读快照渲染 + 离线条文案与时间');

	const raw = await snapshotFixture();
	const booted = await boot({
		rejectState: new Error('NetworkError: offline'),
		seed: { [SNAPSHOT_KEY]: raw }
	});
	const ctx = booted.ctx;

	check('callState reject 后仍渲染出快照数据', ctx.state != null, 'state=' + repr(ctx.state));
	check('离线条可见（display=flex）', ctx.offlineBar.style.display === 'flex',
		'display=' + repr(ctx.offlineBar.style.display));
	check('根节点带 tsm-offline-on（顶部 tab 下移，不遮内容）', hasClass(ctx.root, 'tsm-offline-on'),
		'class=' + repr(ctx.root.attrs['class']));
	same('离线条文案', textOf(ctx.offlineTextNode),
		'离线数据 · 更新于 ' + hhmm(NOW) + '（0 分钟前）');
	same('重试按钮文案', textOf(ctx.offlineRetryBtn), '重试');
	same('概览上传速率来自快照', textOf(ctx.txNum), '2.0');
	same('概览下载速率来自快照', textOf(ctx.rxNum), '1.0');

	const names = deviceNames(ctx);

	check('设备屏渲染出快照里的设备',
		names.indexOf('客厅电视') >= 0 && names.indexOf('书房台式') >= 0,
		'names=' + repr(names));
	same('在线终端数按 last_seen 算', textOf(ctx.devPill), '2 台终端');
	check('「更新于」用的是快照时间', textOf(ctx.updatedNode).indexOf(hhmm(NOW)) === 0,
		'updated=' + repr(textOf(ctx.updatedNode)));
	check('顶部不显示「暂无数据」', textOf(ctx.noticeNode).indexOf('暂无数据') < 0,
		'notice=' + repr(textOf(ctx.noticeNode)));

	/* N 分钟前：按快照 ts 与真实时间算，不看 state */
	const oldState = offlineState();

	oldState.ts = NOW - 900;

	const older = await boot({ state: oldState });
	const olderBoot = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: older.env.__store.getItem(SNAPSHOT_KEY) }
	});

	same('15 分钟前的快照文案', textOf(olderBoot.ctx.offlineTextNode),
		'离线数据 · 更新于 ' + hhmm(NOW - 900) + '（15 分钟前）');

	/* 首屏成功时不显示离线条 */
	const online = await boot({ state: offlineState() });

	same('成功首屏不显示离线条', online.ctx.offlineBar.style.display, 'none');
	check('成功首屏不加 tsm-offline-on', !hasClass(online.ctx.root, 'tsm-offline-on'),
		'class=' + repr(online.ctx.root.attrs['class']));
}

async function testSnapshotOnline() {
	console.log('\n[26] online 事件：清除离线条并重新请求');

	const raw = await snapshotFixture();
	const booted = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: raw }
	});
	const ctx = booted.ctx;
	const env = booted.env;

	same('离线条初始可见', ctx.offlineBar.style.display, 'flex');

	const onlineFns = env.__windowEvents
		.filter(function (e) { return e.action === 'add' && e.type === 'online'; })
		.map(function (e) { return e.fn; });

	same('注册了恰好一个 online 监听', onlineFns.length, 1);

	env.__responses.get_state = baseState({
		totals: {
			direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
			rx_rate: 2500000, tx_rate: 5000000
		}
	});
	delete env.__rejections.get_state;

	const before = countCalls(env, 'get_state');

	onlineFns[0]();
	await flush();
	await flush();

	same('online 后重新请求 get_state', countCalls(env, 'get_state'), before + 1);
	same('online 后清除离线条', ctx.offlineBar.style.display, 'none');
	check('online 后去掉 tsm-offline-on', !hasClass(ctx.root, 'tsm-offline-on'),
		'class=' + repr(ctx.root.attrs['class']));
	same('online 后 offlineInfo 清空', ctx.offlineInfo, null);
	same('恢复后数字来自新数据（上传）', textOf(ctx.txNum), '40.0');
	same('恢复后数字来自新数据（下载）', textOf(ctx.rxNum), '20.0');
	check('恢复后快照被覆盖为最新数据',
		JSON.parse(env.__store.getItem(SNAPSHOT_KEY)).totals.tx_rate === 5000000,
		'snap=' + repr(env.__store.getItem(SNAPSHOT_KEY)));
}

async function testOfflineGiveUp() {
	console.log('\n[27] 连续 3 次自动失败：停止轮询，保留手动重试');

	const raw = await snapshotFixture();
	const booted = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: raw }
	});
	const ctx = booted.ctx;
	const env = booted.env;
	const timer = Array.from(env.__timers.active.values())[0];

	check('轮询在跑', timer != null && env.__timers.active.size === 1,
		'active=' + env.__timers.active.size);

	for (let i = 1; i <= 3; i++) {
		timer.fn();
		await flush();
		await flush();

		same('第 ' + i + ' 次自动失败后 offlineFails=' + i, ctx.offlineFails, i);
	}

	same('3 次失败后停表', env.__timers.active.size, 0);
	same('3 次失败后 timer=null', ctx.timer, null);
	same('3 次失败后标记 offlineGivenUp', ctx.offlineGivenUp, true);
	same('停表后离线条仍在（数据仍可用）', ctx.offlineBar.style.display, 'flex');

	/* 手动重试不受 3 次限制 */
	const before = countCalls(env, 'get_state');

	ctx.retryOffline();
	await flush();
	await flush();

	same('手动重试仍会发请求', countCalls(env, 'get_state'), before + 1);
	same('手动重试把失败计数清零', ctx.offlineFails, 0);

	/* 成功一次：离线条消失 + 轮询恢复 */
	env.__responses.get_state = baseState();
	delete env.__rejections.get_state;

	ctx.retryOffline();
	await flush();
	await flush();

	same('成功后轮询恢复', env.__timers.active.size, 1);
	same('成功后离线条消失', ctx.offlineBar.style.display, 'none');
	same('成功后 offlineGivenUp 复位', ctx.offlineGivenUp, false);
}

async function testSnapshotExpiry() {
	console.log('\n[28] 快照过期（>24h）：清掉、不渲染、显示「快照已过期」');

	/*
	 * 直接造一份过期快照文本：boot 成功那一次自己也会在安装屏 syncOfflineData
	 * 里发现过期并删掉，所以不能靠"先同步一次"拿到它。
	 */
	const maker = await boot({ state: baseState() });
	const expiredSnap = maker.hooks.buildSnapshot(offlineState());

	expiredSnap.ts = NOW - 25 * 3600;

	const raw = JSON.stringify(expiredSnap);
	const booted = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: raw }
	});
	const ctx = booted.ctx;

	same('过期快照不渲染', ctx.state, null);
	same('过期快照不显示离线条', ctx.offlineBar.style.display, 'none');
	same('过期快照被删除', booted.env.__store.getItem(SNAPSHOT_KEY), null);
	check('顶部提示暂无数据', textOf(ctx.noticeNode).indexOf('暂无数据') >= 0,
		'notice=' + repr(textOf(ctx.noticeNode)));
	check('顶部同时说明「快照已过期」', textOf(ctx.noticeNode).indexOf('快照已过期') >= 0,
		'notice=' + repr(textOf(ctx.noticeNode)));
	check('安装屏显示「快照已过期」', textOf(ctx.offlineDataNote).indexOf('快照已过期') >= 0,
		'note=' + repr(textOf(ctx.offlineDataNote)));

	/* readSnapshot 自己也要给出 expired 并删除 */
	const direct = await boot({ storage: 'memory' });

	direct.env.__store.setItem(SNAPSHOT_KEY, raw);
	sameList('readSnapshot 返回 expired', Object.keys(direct.hooks.readSnapshot()).sort(), [ 'expired', 'ts' ]);
	same('readSnapshot 顺手删除过期键', direct.env.__store.getItem(SNAPSHOT_KEY), null);

	/* 边界：23h59m 仍然可用 */
	const freshSnap = maker.hooks.buildSnapshot(offlineState());

	freshSnap.ts = NOW - (24 * 3600 - 60);

	const freshBoot = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: JSON.stringify(freshSnap) }
	});

	check('24 小时内的快照仍可用', freshBoot.ctx.state != null, 'state=' + repr(freshBoot.ctx.state));
	same('24 小时内不误报过期', freshBoot.ctx.offlineBar.style.display, 'flex');
}

async function testSnapshotCorrupt() {
	console.log('\n[29] 损坏 / 结构不对的快照：删除且不崩');

	const corrupt = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: '{not-json' }
	});

	same('损坏 JSON：state 仍为 null', corrupt.ctx.state, null);
	same('损坏 JSON：键被删除', corrupt.env.__store.getItem(SNAPSHOT_KEY), null);
	check('损坏 JSON：页面照常渲染占位',
		corrupt.ctx.root != null && textOf(corrupt.ctx.noticeNode).indexOf('暂无数据') >= 0,
		'notice=' + repr(textOf(corrupt.ctx.noticeNode)));
	same('损坏 JSON：仍是 5 屏',
		findAll(corrupt.ctx.root, function (n) { return hasClass(n, 'tsm-page'); }).length, 5);

	const wrongVersion = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: JSON.stringify({ v: 9, ts: NOW, totals: {} }) }
	});

	same('版本不对的快照被删除', wrongVersion.env.__store.getItem(SNAPSHOT_KEY), null);
	same('版本不对：state 为 null', wrongVersion.ctx.state, null);

	const arrayJson = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: '[]' }
	});

	same('数组快照被删除', arrayJson.env.__store.getItem(SNAPSHOT_KEY), null);

	const noTs = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: JSON.stringify({ v: 1, ts: 0, totals: {} }) }
	});

	same('缺少 ts 的快照被删除', noTs.env.__store.getItem(SNAPSHOT_KEY), null);
	check('三种脏数据都不会抛异常', arrayJson.ctx.root != null && noTs.ctx.root != null, 'ok');
}

async function testSnapshotStorageUnavailable() {
	console.log('\n[30] localStorage 不可用：静默降级，页面照常');

	const throwing = await boot({ storage: 'throw' });

	same('setItem 抛错：写快照返回 false', throwing.hooks.writeSnapshot(baseState()), false);
	same('getItem 抛错：读快照返回 null', throwing.hooks.readSnapshot(), null);
	check('页面照常渲染数据', throwing.ctx.state != null && textOf(throwing.ctx.rxNum) === '0.0',
		'state=' + repr(throwing.ctx.state && throwing.ctx.state.ts) + ' rx=' + repr(textOf(throwing.ctx.rxNum)));
	check('写快照失败不弹错误提示', textOf(throwing.ctx.noticeNode) === '',
		'notice=' + repr(textOf(throwing.ctx.noticeNode)));
	same('异常模式下也没有写进存储', throwing.env.__store.__map.size, 0);

	const denied = await boot({ storage: 'getter-throw' });

	same('取不到 localStorage：snapStore 返回 null', denied.hooks.snapStore(), null);
	same('取不到 localStorage：读快照 null', denied.hooks.readSnapshot(), null);
	check('安装屏说明本地存储不可用',
		textOf(denied.ctx.offlineDataNote).indexOf('不可用') >= 0,
		'note=' + repr(textOf(denied.ctx.offlineDataNote)));
	same('不可用时隐藏清除按钮', denied.ctx.offlineClearBtn.style.display, 'none');
	check('不可用时页面照常渲染', denied.ctx.state != null, 'state=' + repr(denied.ctx.state));

	const missing = await boot({ storage: 'none' });

	same('没有 localStorage 属性：读快照 null', missing.hooks.readSnapshot(), null);
	check('没有 localStorage 属性：页面照常渲染', missing.ctx.state != null, 'state=' + repr(missing.ctx.state));
}

async function testSnapshotClear() {
	console.log('\n[31] 「清除离线数据」删除 localStorage 键');

	const raw = await snapshotFixture();
	const booted = await boot({ state: offlineState() });
	const ctx = booted.ctx;
	const env = booted.env;

	check('成功同步后键存在', env.__store.getItem(SNAPSHOT_KEY) != null, 'ok');
	check('安装屏显示已保存离线快照',
		textOf(ctx.offlineDataNote).indexOf('已保存离线快照') >= 0,
		'note=' + repr(textOf(ctx.offlineDataNote)));

	ctx.setPage(4);

	const btn = findAll(ctx.pages[4], function (n) { return hasClass(n, 'tsm-offline-clear'); })[0];

	check('安装屏有「清除离线数据」按钮', btn != null && textOf(btn) === '清除离线数据',
		'btn=' + repr(btn && textOf(btn)));

	if (btn == null) return;

	const notesBefore = env.__notifications.length;

	btn.attrs.click();

	same('点击后键被删除', env.__store.getItem(SNAPSHOT_KEY), null);
	check('状态回写为暂无离线快照',
		textOf(ctx.offlineDataNote).indexOf('暂无离线快照') >= 0,
		'note=' + repr(textOf(ctx.offlineDataNote)));
	check('清除后给出提示', env.__notifications.length === notesBefore + 1,
		'notifications=' + env.__notifications.length);

	/* 离线状态下清除：离线条收起，键也没了 */
	const offlineBoot = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: raw }
	});

	same('离线时键存在', offlineBoot.env.__store.getItem(SNAPSHOT_KEY) != null, true);
	same('离线时离线条可见', offlineBoot.ctx.offlineBar.style.display, 'flex');

	offlineBoot.ctx.setPage(4);

	const btn2 = findAll(offlineBoot.ctx.pages[4], function (n) {
		return hasClass(n, 'tsm-offline-clear');
	})[0];

	btn2.attrs.click();

	same('清除后离线条隐藏', offlineBoot.ctx.offlineBar.style.display, 'none');
	same('清除后键消失', offlineBoot.env.__store.getItem(SNAPSHOT_KEY), null);
	check('清除后去掉 tsm-offline-on', !hasClass(offlineBoot.ctx.root, 'tsm-offline-on'),
		'class=' + repr(offlineBoot.ctx.root.attrs['class']));
}

async function testSnapshotSafety() {
	console.log('\n[32] 快照安全：无危险 DOM、快照不进 title / 属性');

	check('mobile.js 不含 innerHTML', !/innerHTML/.test(SOURCE));
	check('mobile.js 不含 .outerHTML =', !/\.outerHTML\s*=/.test(SOURCE));
	check('mobile.js 不含 insertAdjacentHTML', !/insertAdjacentHTML/.test(SOURCE));
	check('mobile.js 不含 document.write(', !/document\.write\s*\(/.test(SOURCE));
	check('mobile.js 不含 eval(', !/\beval\s*\(/.test(SOURCE));
	check('mobile.js 不含 new Function', !/new\s+Function\s*\(/.test(SOURCE));

	const raw = await snapshotFixture();
	const booted = await boot({
		rejectState: new Error('offline'),
		seed: { [SNAPSHOT_KEY]: raw }
	});
	const bar = booted.ctx.offlineBar;

	sameList('离线条只挂固定属性', Object.keys(bar.attrs).sort(), [ 'aria-live', 'class', 'role', 'style' ]);
	same('离线条本身没有 title 属性', bar.attrs.title == null, true);
	same('离线条子节点没有 title 属性',
		findAll(bar, function (n) { return n.attrs && n.attrs.title != null; }).length, 0);
	check('页面 title 不含快照内容',
		('' + booted.env.document.title).indexOf('{') < 0 &&
		('' + booted.env.document.title).indexOf('devices') < 0,
		'title=' + repr(booted.env.document.title));
	check('离线条文本不含 JSON 结构',
		textOf(bar).indexOf('{') < 0 && textOf(bar).indexOf('"') < 0,
		'text=' + repr(textOf(bar)));
	same('快照键没有出现在任何节点属性里',
		findAll(booted.ctx.root, function (n) {
			return JSON.stringify(n.attrs || {}).indexOf(SNAPSHOT_KEY) >= 0;
		}).length, 0);
	same('快照 JSON 原文没有进入 DOM',
		findAll(booted.ctx.root, function (n) {
			return textOf(n).indexOf('"totals"') >= 0;
		}).length, 0);
}

async function testSnapshotStaleRefresh() {
	console.log('\n[33] 运行中刷新失败：顶部离线条 + 恢复后自动收起');

	const staleState = offlineState();

	staleState.ts = NOW - 120;

	const booted = await boot({ state: staleState, rejectState: null });
	const ctx = booted.ctx;
	const env = booted.env;
	const timer = Array.from(env.__timers.active.values())[0];

	same('首屏成功时没有离线条', ctx.offlineBar.style.display, 'none');

	/* 断网：下一轮轮询失败，页面保留上次数据并亮出离线条 */
	env.__rejections.get_state = new Error('offline');

	timer.fn();
	await flush();
	await flush();

	same('刷新失败后离线条可见', ctx.offlineBar.style.display, 'flex');
	same('离线条时间用上次成功的 ts', textOf(ctx.offlineTextNode),
		'离线数据 · 更新于 ' + hhmm(NOW - 120) + '（2 分钟前）');
	check('顶部同时提示刷新失败', textOf(ctx.noticeNode).indexOf('刷新失败') >= 0,
		'notice=' + repr(textOf(ctx.noticeNode)));
	check('数字没有被清空', textOf(ctx.txNum) === '2.0', 'tx=' + repr(textOf(ctx.txNum)));

	/* 恢复：成功一次后自动收起 */
	env.__responses.get_state = baseState({
		ts: NOW,
		totals: {
			direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
			rx_rate: 2500000, tx_rate: 5000000
		}
	});
	delete env.__rejections.get_state;

	ctx.retryOffline();
	await flush();
	await flush();

	same('恢复后离线条收起', ctx.offlineBar.style.display, 'none');
	check('恢复后去掉 tsm-offline-on', !hasClass(ctx.root, 'tsm-offline-on'),
		'class=' + repr(ctx.root.attrs['class']));
	same('恢复后显示新数据', textOf(ctx.txNum), '40.0');
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
		await testNetworkDeviceKinds();
		await testOverviewTopo();
		await testTopoTree();
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
		await testPullRefresh();
		await testSkeletonScreens();
		await testPageTransition();
		await testSafeArea();
		await testSparkline();
		await testOverviewTop3();
		await testSnapshotWrite();
		await testSnapshotTruncate();
		await testSnapshotRestore();
		await testSnapshotOnline();
		await testOfflineGiveUp();
		await testSnapshotExpiry();
		await testSnapshotCorrupt();
		await testSnapshotStorageUnavailable();
		await testSnapshotClear();
		await testSnapshotSafety();
		await testSnapshotStaleRefresh();
	}
	catch (err) {
		console.error('\n测试自身异常：', err && err.stack ? err.stack : err);
		process.exit(1);
	}

	console.log('\n结果：' + passed + ' passed, ' + failed + ' failed');

	process.exit(failed === 0 ? 0 : 1);
})();
