#!/usr/bin/env node
/*
 * LuCI 前端静态 / 轻量测试（无需路由器、不启动服务器）
 *
 * 覆盖：
 *   1. 八个 view 的 JS 语法：用 vm.Script 包一层函数解析，避免 LuCI 的
 *      'require xxx' 字符串被 Node 当成模块加载（也不执行任何浏览器 API）。
 *   2. 新增 RPC 声明：devices -> set_device_meta / export_csv，
 *      settings/apps -> export_csv，settings -> set_config。
 *   3. 配额提交：执行 settings.collect()，再执行 writeSection('settings', …)，
 *      验证 quota_mode / quota_monthly_gb / quota_total_gb 真的进了 RPC 参数。
 *   4. 导出调用：devices 导出 devices、apps 导出 apps，均触发 export_csv。
 *   5. 无危险 DOM 赋值：.innerHTML= / .outerHTML= / insertAdjacentHTML / document.write。
 *   6. 概览口径：昨日全天按后端 day 字段找昨天（不写死 days[1]，本地日历加减日）；
 *      在线只认 last_seen>0 且 10 分钟内；health unavailable 不再显示成健康；
 *      panel 历史 summary.totals 兼容。
 *   7. PWA 静态资源路径走 L.resource（保留根部署回退）。
 *   8. settings uciOk=false：保存/重启按钮禁用，save 不 collect、不调 set_config。
 *   9. devices：alias/group 按 UTF-8 128 字节校验（中文 43 字=129 字节被拒）；
 *      后端截断时回显真实返回值并警告；L.env.acls 权限两种（只读隐藏编辑）。
 *  10. mobile：unknown 灰色「未知」，unavailable 才红色「不可用」。
 *  11. menu.d：根依赖只读组，settings 子路由依赖 admin 组；视图 JS 不伪造 depends。
 *
 * 运行：node tests/ui-frontend-static.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VIEW_DIR = path.join(ROOT, 'luci-app-prism-router/htdocs/luci-static/resources/view/prism-router');
const THEME_FILE = path.join(ROOT, 'luci-app-prism-router/htdocs/luci-static/resources/prism-router/theme.js');
const MENU_FILE = path.join(ROOT, 'luci-app-prism-router/root/usr/share/luci/menu.d/luci-app-prism-router.json');
const VIEWS = [ 'overview', 'devices', 'apps', 'nodes', 'settings', 'mobile', 'panel', 'diagnostics' ];
const THEMED_VIEWS = [ 'overview', 'devices', 'apps', 'nodes', 'settings', 'diagnostics' ];

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

/* 数组逐项相等：菜单顺序、标题列表等静态断言用。 */
function sameList(name, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);

	check(name, a === b, a + ' != ' + b);
}

function readView(name) {
	return fs.readFileSync(path.join(VIEW_DIR, name + '.js'), 'utf8');
}

// ---------------------------------------------------------------- 共享主题

let themeCache = null;

/*
 * 真实 LuCI require 不只执行源码：compileClass 要求工厂返回 baseclass 子类，
 * 否则抛出 "factory yields invalid constructor"。测试用最小 baseclass.extend
 * 模拟该契约，并显式验证结果，不能把普通对象注入视图就当加载成功。
 */
function themeModule() {
	if (themeCache != null) return themeCache;

	const source = fs.readFileSync(THEME_FILE, 'utf8');
	function BaseClass() {}
	BaseClass.extend = function (members) {
		function SubClass() {}
		SubClass.prototype = Object.create(BaseClass.prototype);
		SubClass.prototype.constructor = SubClass;
		Object.keys(members || {}).forEach(function (key) {
			SubClass.prototype[key] = members[key];
		});
		return SubClass;
	};
	const env = {
		console,
		baseclass: BaseClass,

		/* theme.style() 在真实 LuCI 里用全局 E()；测试里给同形状的桩节点即可。 */
		E: function (tag, attrs, children) {
			return { tag: tag, attrs: attrs || {}, children: children };
		}
	};
	const context = vm.createContext(env);
	const script = new vm.Script('(function (baseclass) {\n' + source + '\n})(baseclass)', { filename: 'prism-router/theme.js' });
	const ThemeClass = script.runInContext(context, { timeout: 3000 });

	if (typeof ThemeClass !== 'function' || !(ThemeClass.prototype instanceof BaseClass))
		throw new TypeError('theme.js 不符合 LuCI require：必须返回 baseclass 子类');

	themeCache = new ThemeClass();

	return themeCache;
}

// ---------------------------------------------------------------- 环境桩

function makeEnvironment() {
	const declarations = [];
	const calls = [];
	const responses = {};
	const notifications = [];
	const anchors = [];

	const env = {
		console,

		/* require prism-router/theme as theme 的模块对象（见 themeModule）。 */
		theme: themeModule(),

		/* 浏览器原生 UTF-8 编码器：devices 的 128 字节校验用它。 */
		TextEncoder: (typeof TextEncoder !== 'undefined') ? TextEncoder : undefined,

		/* LuCI 全局 */
		view: { extend: function (obj) { return obj; } },
		rpc: {
			declare: function (opts) {
				const record = {
					method: opts.method,
					object: opts.object,
					params: opts.params || null
				};

				declarations.push(record);

				return function () {
					const args = Array.prototype.slice.call(arguments);

					calls.push({ method: opts.method, args: args });

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
			url: function (p) { return '/cgi-bin/luci/' + p; }
		},
		dom: {
			content: function (node, content) {
				if (node == null) return;

				while (node.firstChild) node.removeChild(node.firstChild);

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
			const classes = {};

			return {
				tag: tag,
				attrs: attrs || {},
				children: children,
				style: {},
				classList: {
					add: function (name) { classes[name] = true; },
					remove: function (name) { delete classes[name]; },
					contains: function (name) { return classes[name] === true; },
					toggle: function (name, on) { classes[name] = (on !== false); }
				},
				textContent: '',
				firstChild: null,
				/* syncStatus 用 lastChild 写服务状态文本；真实 DOM 里始终存在。 */
				lastChild: { textContent: '' },
				value: attrs && attrs.value != null ? attrs.value : '',
				checked: false,
				appendChild: function () {},
				removeChild: function () {},
				addEventListener: function () {},
				removeEventListener: function () {},
				setAttribute: function (key, value) { this.attrs[key] = value; },
				getAttribute: function (key) { return this.attrs[key] != null ? this.attrs[key] : null; },
				removeAttribute: function (key) { delete this.attrs[key]; },
				focus: function () {}
			};
		},
		_: function (s) { return s; },

		/* 浏览器桩：只在导出/按钮回调里被调用，不执行真实下载 */
		window: {
			addEventListener: function () {},
			removeEventListener: function () {},
			setTimeout: function (fn) { return 0; },
			clearTimeout: function () {},
			open: function () {},
			location: { reload: function () {} }
		},
		document: {
			hidden: false,
			createElement: function (tag) {
				const el = {
					tag: tag,
					style: {},
					href: '',
					download: '',
					click: function () { el.clicked = true; },
					appendChild: function () {},
					removeChild: function () {}
				};

				anchors.push(el);

				return el;
			},
			createElementNS: function (ns, tag) {
				return {
					namespace: ns,
					tag: tag,
					attrs: {},
					textContent: '',
					children: [],
					setAttribute: function (k, v) { this.attrs[k] = v; },
					appendChild: function (child) { this.children.push(child); }
				};
			},
			createTextNode: function (text) { return { text: text }; },
			getElementById: function () { return null; },
			querySelectorAll: function () { return []; },
			body: { appendChild: function () {}, removeChild: function () {} },
			head: { appendChild: function () {} }
		},
		Blob: function (parts, opts) {
			this.parts = parts;
			this.type = opts && opts.type;
		},
		URL: {
			createObjectURL: function () { return 'blob:ui-frontend-static'; },
			revokeObjectURL: function () {}
		},
		setTimeout: function (fn) { return 0; },
		clearTimeout: function () {}
	};

	env.__declarations = declarations;
	env.__calls = calls;
	env.__responses = responses;
	env.__notifications = notifications;
	env.__anchors = anchors;

	return env;
}

/*
 * 在隔离 context 里执行一个 view。LuCI view 顶层只是
 * 'require xxx' 字符串语句 + 若干 rpc.declare + return view.extend({...})，
 * 用 vm 包一层函数即可在不引入浏览器依赖的情况下拿到 view 对象。
 */
function loadView(name) {
	const source = readView(name);
	const env = makeEnvironment();
	const context = vm.createContext(env);
	const wrapped = '(function () {\n' + source + '\n})()';
	const script = new vm.Script(wrapped, { filename: name + '.js' });

	const result = script.runInContext(context, { timeout: 3000 });

	if (result == null || typeof result != 'object')
		throw new Error(name + '.js 没有 return view.extend(...) 对象');

	return { view: result, env: env, context: context, source: source };
}

function callsOf(env, method) {
	return env.__calls.filter(function (call) { return call.method === method; });
}

function declarationOf(env, method) {
	return env.__declarations.find(function (decl) { return decl.method === method; });
}

/* 在 E() 桩生成的节点树里找符合条件的节点 / 文本。 */
function findNode(root, predicate) {
	if (root == null || typeof root != 'object') return null;
	if (predicate(root)) return root;

	const children = root.children;

	if (Array.isArray(children)) {
		for (const child of children) {
			const hit = findNode(child, predicate);
			if (hit != null) return hit;
		}
	}
	else if (children != null && typeof children === 'object') {
		return findNode(children, predicate);
	}

	return null;
}

function containsText(root, needle) {
	if (root == null) return false;
	if (typeof root === 'string') return root.indexOf(needle) >= 0;
	if (typeof root != 'object') return false;
	if (Array.isArray(root)) return root.some(function(child) { return containsText(child, needle); });
	if (typeof root.textContent === 'string' && root.textContent.indexOf(needle) >= 0) return true;

	const children = root.children;

	if (typeof children === 'string') return children.indexOf(needle) >= 0;
	if (Array.isArray(children)) return children.some(function (child) { return containsText(child, needle); });

	return containsText(children, needle);
}

// ---------------------------------------------------------------- 1. 语法

async function testSyntax() {
	console.log('\n[1] 八个 view 的 JS 语法（vm.Script 包装后解析）');

	for (const name of VIEWS) {
		try {
			loadView(name);
			ok(name + '.js 语法通过');
		}
		catch (err) {
			bad(name + '.js 语法通过', err && err.message);
		}
	}
}

// ---------------------------------------------------------------- 2. RPC 声明

async function testDeclarations() {
	console.log('\n[2] 新增 RPC 声明');

	const devices = loadView('devices');
	const setMeta = declarationOf(devices.env, 'set_device_meta');
	const devExport = declarationOf(devices.env, 'export_csv');

	check('devices 声明 set_device_meta', setMeta != null);
	check('set_device_meta 参数为 mac/alias/group',
		setMeta != null && JSON.stringify(setMeta.params) === JSON.stringify([ 'mac', 'alias', 'group' ]),
		setMeta && JSON.stringify(setMeta.params));
	check('devices 声明 export_csv', devExport != null);
	check('devices export_csv 参数为 what',
		devExport != null && JSON.stringify(devExport.params) === JSON.stringify([ 'what' ]),
		devExport && JSON.stringify(devExport.params));

	const apps = loadView('apps');
	check('apps 声明 export_csv', declarationOf(apps.env, 'export_csv') != null);

	const settings = loadView('settings');
	check('settings 声明 export_csv', declarationOf(settings.env, 'export_csv') != null);

	const setConfig = declarationOf(settings.env, 'set_config');
	check('settings 声明 set_config',
		setConfig != null && JSON.stringify(setConfig.params) === JSON.stringify([ 'section', 'options' ]),
		setConfig && JSON.stringify(setConfig.params));

	const devicesSource = readView('devices');
	const appsSource = readView('apps');
	const settingsSource = readView('settings');

	check('devices 有编辑弹窗入口', /编辑设备/.test(devicesSource) && /openEditDialog/.test(devicesSource));
	check('devices 展示首次出现/本月/配额',
		/首次出现/.test(devicesSource) && /本月/.test(devicesSource) && /配额剩余/.test(devicesSource));
	check('devices 有导出按钮', /导出设备 CSV/.test(devicesSource));
	check('apps 有导出按钮', /导出应用 CSV/.test(appsSource));
	check('settings 有每日导出按钮', /导出每日汇总 CSV/.test(settingsSource));
	check('settings 渲染三个配额字段',
		/quota_mode/.test(settingsSource) &&
		/quota_monthly_gb/.test(settingsSource) &&
		/quota_total_gb/.test(settingsSource));
}

// ---------------------------------------------------------------- 3. 配额提交

async function testQuotaSubmit() {
	console.log('\n[3] 月配额 collect + writeSection');

	const loaded = loadView('settings');
	const mod = loaded.view;

	const inputs = {
		'settings.enabled': '1',
		'settings.poll_interval': '5',
		'settings.clash_api': '127.0.0.1:9090',
		'settings.clash_secret': '',
		'settings.fake_ip_ranges': '198.18.0.0/16',
		'settings.history_days': '7',
		'settings.lan_bridge': 'br-lan',
		'settings.wireless_ports': '',
		'settings.ap_macs': '',
		'settings.link_refresh': '30',
		'settings.system_enabled': '1',
		'settings.wan_iface': '',
		'settings.quota_mode': 'device',
		'settings.quota_monthly_gb': '12.5',
		'settings.quota_total_gb': '100',
		'feishu.enabled': '0',
		'feishu.webhook': '',
		'feishu.secret': '',
		'feishu.app_id': '',
		'feishu.app_secret': '',
		'feishu.chat_id': '',
		'feishu.report_chat_enabled': '1',
		'feishu.daily_time': '08:30',
		'feishu.report_time': '08:30',
		'feishu.report_weekday': '1',
		'feishu.alert_app_daily_limit': '',
		'feishu.alert_spike_ratio': '',
		'feishu.alert_offline_min': '',
		'feishu.alert_cpu_pct': '',
		'feishu.alert_mem_pct': '',
		'feishu.alert_disk_pct': '',
		'feishu.alert_quiet_hours': '',
		'retention.enabled': '1',
		'retention.daily_days': '400',
		'retention.nodes_days': '30',
		'retention.stations_days': '7',
		'retention.log_days': '7',
		'retention.log_max_kb': '512',
		'retention.spool_max_kb': '2048',
		'retention.dry_run': '0'
	};

	const checked = {
		'settings.enabled': true,
		'settings.system_enabled': true,
		'feishu.report_chat_enabled': true,
		'retention.enabled': true
	};

	const ctx = Object.create(mod);

	ctx.writtenOptions = {};
	ctx.reportTimeDirty = false;
	ctx.reportTimeInitial = '08:30';
	ctx.inputValue = function (section, key) {
		const value = inputs[section + '.' + key];

		return (value == null) ? '' : value;
	};
	ctx.inputChecked = function (section, key) {
		return checked[section + '.' + key] === true;
	};
	ctx.radioValue = function (section, key, fallback) {
		if (section + '.' + key === 'feishu.report_mode')
			return 'daily';

		return fallback;
	};
	ctx.collectReportItems = function () { return 'none'; };

	const cfg = mod.collect.call(ctx);

	check('collect 写入 quota_mode=device', cfg.settings.quota_mode === 'device', cfg.settings.quota_mode);
	check('collect 写入 quota_monthly_gb=12.5', cfg.settings.quota_monthly_gb === '12.5', cfg.settings.quota_monthly_gb);
	check('collect 写入 quota_total_gb=100', cfg.settings.quota_total_gb === '100', cfg.settings.quota_total_gb);

	await mod.writeSection.call(ctx, 'settings', cfg.settings);

	const writes = callsOf(loaded.env, 'set_config');

	check('writeSection 实际调用 set_config', writes.length === 1, 'calls=' + writes.length);

	if (writes.length === 1) {
		const section = writes[0].args[0];
		let submitted = null;

		try {
			submitted = JSON.parse(writes[0].args[1]);
		}
		catch (e) {
			submitted = null;
		}

		check('set_config section=settings', section === 'settings', '' + section);
		check('set_config options 含 quota_mode',
			submitted != null && submitted.quota_mode === 'device');
		check('set_config options 含 quota_monthly_gb',
			submitted != null && submitted.quota_monthly_gb === '12.5');
		check('set_config options 含 quota_total_gb',
			submitted != null && submitted.quota_total_gb === '100');
	}
}

// ---------------------------------------------------------------- 4. 导出调用

async function testExports() {
	console.log('\n[4] CSV 导出调用');

	const devices = loadView('devices');

	devices.env.__responses.export_csv = {
		ok: true,
		what: 'devices',
		filename: 'prism-router-devices-2026-11-16.csv',
		rows: 2,
		csv: '主机名,IP\r\nrouter,192.168.1.1\r\n'
	};

	const devCtx = Object.create(devices.view);

	devCtx.exportStatus = { textContent: '', style: {} };

	await devices.view.exportCsv.call(devCtx, 'devices');

	const devCalls = callsOf(devices.env, 'export_csv');

	check('devices 导出触发 export_csv', devCalls.length === 1, 'calls=' + devCalls.length);
	check('devices 导出 what=devices',
		devCalls.length === 1 && devCalls[0].args[0] === 'devices',
		devCalls.length ? JSON.stringify(devCalls[0].args) : 'no call');

	const devAnchor = devices.env.__anchors.find(function (a) { return a.download; });

	check('devices 下载使用后端 filename',
		devAnchor != null && devAnchor.download === 'prism-router-devices-2026-11-16.csv',
		devAnchor && devAnchor.download);

	const apps = loadView('apps');

	apps.env.__responses.export_csv = {
		ok: true,
		what: 'apps',
		filename: 'prism-router-apps-2026-11-16.csv',
		rows: 1,
		csv: '应用,出口\r\nyoutube.com,DIRECT\r\n'
	};

	const appCtx = Object.create(apps.view);

	appCtx.exportStatus = { textContent: '', style: {} };

	await apps.view.exportCsv.call(appCtx, 'apps');

	const appCalls = callsOf(apps.env, 'export_csv');

	check('apps 导出触发 export_csv', appCalls.length === 1, 'calls=' + appCalls.length);
	check('apps 导出 what=apps',
		appCalls.length === 1 && appCalls[0].args[0] === 'apps',
		appCalls.length ? JSON.stringify(appCalls[0].args) : 'no call');

	const settings = loadView('settings');

	settings.env.__responses.export_csv = {
		ok: true,
		what: 'daily',
		filename: 'prism-router-daily-2026-11-16.csv',
		rows: 3,
		csv: '日期,下载\r\n2026-11-16,1\r\n'
	};

	const setCtx = Object.create(settings.view);

	setCtx.exportStatus = { textContent: '', style: {} };

	await settings.view.exportDaily.call(setCtx);

	const dailyCalls = callsOf(settings.env, 'export_csv');

	check('settings 导出触发 export_csv', dailyCalls.length === 1, 'calls=' + dailyCalls.length);
	check('settings 导出 what=daily',
		dailyCalls.length === 1 && dailyCalls[0].args[0] === 'daily',
		dailyCalls.length ? JSON.stringify(dailyCalls[0].args) : 'no call');
}

// ---------------------------------------------------------------- 5. 危险 DOM

async function testDangerousDom() {
	console.log('\n[5] 无危险 DOM 赋值');

	const patterns = [
		{ name: '.innerHTML =', re: /\.innerHTML\s*=/ },
		{ name: '.outerHTML =', re: /\.outerHTML\s*=/ },
		{ name: 'insertAdjacentHTML', re: /insertAdjacentHTML/ },
		{ name: 'document.write', re: /document\.write\s*\(/ }
	];

	for (const name of VIEWS) {
		const source = readView(name);

		/* 连注释也不留 innerHTML 字样，避免被简单的 grep 门禁误判。 */
		check(name + ' 不含 innerHTML 字样', !/innerHTML/.test(source));

		for (const pattern of patterns)
			check(name + ' 不含 ' + pattern.name, !pattern.re.test(source));
	}
}

// ---------------------------------------------------------------- 6. 概览 / 历史口径

async function testSemantics() {
	console.log('\n[6] 概览 / 历史口径静态检查');

	const overview = readView('overview');
	const panel = readView('panel');
	const mobile = readView('mobile');
	const devicesPage = readView('devices');
	const appsPage = readView('apps');
	const nodesPage = readView('nodes');
	const diagnosticsPage = readView('diagnostics');

	check('概览「昨日全天」按 day 查找，不写死 days[1]',
		!/days\[1\]/.test(overview) && /findYesterdayDay/.test(overview) &&
		/day\s*===/.test(overview) && /summary\.totals/.test(overview));
	check('概览昨日计算用本地日历加减日（setDate，非固定 86400 秒）',
		/shiftDayKey/.test(overview) && /setDate\(/.test(overview) && /parseDayKey/.test(overview));
	check('概览明确写昨日全天（不再叫较昨日）',
		/昨日全天/.test(overview) && !/较昨日/.test(overview));
	check('概览不再用 now - DAY_SEC 分组昨日桶',
		!/now\s*-\s*DAY_SEC/.test(overview));
	check('在线只认 last_seen > 0',
		/ls\s*>\s*0/.test(overview) && /ONLINE_SEC/.test(overview));
	check('health unavailable 显示为不可用',
		/unavailable/.test(overview) && /记账不可用/.test(overview));

	check('panel 状态对 unavailable 降级',
		/conf === 'unavailable'/.test(panel) && /运行中（降级）/.test(panel));
	check('panel 历史兼容 summary.totals',
		/summary\.totals/.test(panel) && /daily 文件/.test(panel));
	check('panel SVG 标签用 textContent（无 HTML 拼接标记）',
		/svgNode\('text'/.test(panel) && !/\+\s*labels\[i\]\s*\+\s*'<\/text>/.test(panel));
	check('panel 有「拓扑」标签且用只读 get_stations',
		/id:\s*'topology'/.test(panel) && /label:\s*'拓扑'/.test(panel) &&
		/method:\s*'get_stations'/.test(panel));
	check('panel 拓扑含五层与 AP 降级文案',
		/topoLayer/.test(panel) && /互联网/.test(panel) && /主路由/.test(panel) &&
		/AP 数据不可用/.test(panel));

	/* 概览 Top 下钻 → 设备页/应用页定位；两端都必须解析并清理 hash。 */
	check('概览 Top 下钻链接带 #mac= / #host=',
		/#mac=' \+ encodeURIComponent/.test(overview) &&
		/#host=' \+ encodeURIComponent/.test(overview));
	check('设备页解析 #mac= 打开抽屉并清理 hash',
		/applyHashTarget/.test(devicesPage) && /#mac=/.test(devicesPage) &&
		/replaceState/.test(devicesPage));
	check('应用页解析 #host= 过滤并清理 hash',
		/applyHashTarget/.test(appsPage) && /#host=/.test(appsPage) &&
		/replaceState/.test(appsPage));

	/* 商用化改造的关键结构（防止回退成纯列表）。 */
	check('设备页有分段筛选、表头排序与详情抽屉',
		/segment/.test(devicesPage) && /sortKey/.test(devicesPage) &&
		/openDrawer/.test(devicesPage) && /drawer/i.test(devicesPage));
	check('应用页有时间范围、类别聚合与自动刷新',
		/RANGE_/.test(appsPage) && /categor/i.test(appsPage) &&
		/autoRefresh/.test(appsPage));
	check('节点页有状态摘要、排序与展开详情',
		/age_sec/.test(nodesPage) && /sort/i.test(nodesPage) &&
		/expanded/.test(nodesPage));
	check('概览页有在线/离线/访客摘要与刷新开关',
		/deviceCounts/.test(overview) && /在线/.test(overview) &&
		/访客/.test(overview) && /autoRefresh|autoInput/.test(overview));

	/* 新增功能：设备厂商识别、流量日历/关注卡片、诊断中心。 */
	check('设备页内置 OUI 厂商表并处理随机 MAC',
		/OUI_TABLE/.test(devicesPage) && /vendorOf/.test(devicesPage) &&
		/随机|本地管理/.test(devicesPage));
	check('设备页有厂商筛选与设备类型图标',
		/vendorFilter|厂商/.test(devicesPage) && /deviceKind/.test(devicesPage) &&
		/deviceKindSvg|svg/i.test(devicesPage));
	check('概览页有流量日历与需要关注卡片',
		/日历/.test(overview) && /需要关注/.test(overview) &&
		/get_daily/.test(overview));
	/* 网络类设备（本机/容器/网关/服务器）在手机版与桌面设备页都要有识别与图标。 */
	check('手机版与设备页都识别网络类设备',
		/'gateway'/.test(mobile) && /'container'/.test(mobile) &&
		/'gateway'/.test(devicesPage) && /'container'/.test(devicesPage) &&
		/本机/.test(mobile) && /网关/.test(mobile) && /容器/.test(mobile));
	check('诊断页只读且包含关键检查项',
		/method:\s*'status'/.test(diagnosticsPage) &&
		!/set_config|set_device_meta|method:\s*'restart'|uci\.set\s*\(/.test(diagnosticsPage) &&
		/数据源/.test(diagnosticsPage) && /未更新|新鲜/.test(diagnosticsPage));

	/* 概览不再对只读 ACL 发 UCI 探测；手机版/诊断的既有控制台入口保持兼容。 */
	check('概览不引入默认 8099 死链，既有视图入口不变',
		!/CONSOLE_PORT = 8099|consoleUrl\(\)/.test(overview) &&
		/:8099\//.test(mobile) && /target: '_blank'/.test(mobile) &&
		/:8099\//.test(diagnosticsPage) && /target: '_blank'/.test(diagnosticsPage));
	check('概览不用 window.open 打开详细面板',
		!/window\.open\(\s*L\.url\('admin\/services\/prism-router\/panel'\)/.test(overview));
	check('menu.d 含诊断页且 order 在手机版与面板之间',
		/"admin\/services\/prism-router\/diagnostics"/.test(readView('diagnostics')) === false &&
		/"path": "prism-router\/diagnostics"/.test(
			require('fs').readFileSync(path.join(ROOT, 'luci-app-prism-router/root/usr/share/luci/menu.d/luci-app-prism-router.json'), 'utf8')));

	/* ---- 拓扑：懒加载 / 下钻 / 可读性（静态断言，不启动浏览器） ---- */
	const loadBody = (panel.match(/load:\s*function\s*\(\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';
	const setTabBody = (panel.match(/setTab:\s*function\s*\(id\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';
	const refreshBody = (panel.match(/refreshNow:\s*function\s*\(\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';
	const exitCardBody = (panel.match(/topoExitCard:\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';
	const apCardBody = (panel.match(/topoApCard:\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';
	const sigBody = (panel.match(/topoSignature:\s*function\s*\(\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';
	const topoBody = (panel.match(/buildTopology:\s*function\s*\(\)\s*\{([\s\S]*?)\n\t\},/) || [])[1] || '';

	check('panel 首屏懒加载：load() 不直接拉 get_nodes / get_stations',
		loadBody.length > 0 && !/callNodes\s*\(/.test(loadBody) && !/callStations\s*\(/.test(loadBody));
	check('panel 有 ensureNodes / ensureStations，并在切「节点」/「拓扑」时补拉',
		/ensureNodes:\s*function\s*\(/.test(panel) && /ensureStations:\s*function\s*\(/.test(panel) &&
		/ensureNodes\(\)/.test(setTabBody) && /ensureStations\(\)/.test(setTabBody) &&
		/id === 'topology'/.test(setTabBody) && /id === 'nodes'/.test(setTabBody));
	check('panel 轮询只在「节点」/「拓扑」激活时刷新快照',
		/this\.tab === 'nodes' \|\| this\.tab === 'topology'/.test(refreshBody) &&
		/callNodes\s*\(/.test(refreshBody) && /callStations\s*\(/.test(refreshBody) &&
		/this\.tab === 'topology'/.test(refreshBody));
	check('panel 拓扑有出口 / AP 下钻函数',
		/topoExitDevices:\s*function\s*\(/.test(panel) && /topoApDevices:\s*function\s*\(/.test(panel));
	check('panel 出口卡可点击（role=button / tabindex / Enter+Space）',
		/'role':\s*'button'/.test(exitCardBody) && /'tabindex':\s*0/.test(exitCardBody) &&
		/Enter/.test(exitCardBody) && /Space/.test(exitCardBody) && /toggleTopoExit/.test(exitCardBody));
	check('panel AP 卡可点击（role=button / tabindex）',
		/'role':\s*'button'/.test(apCardBody) && /'tabindex':\s*0/.test(apCardBody) &&
		/toggleTopoAp/.test(apCardBody));
	check('panel 下钻展开状态纳入 topoSignature（刷新不丢）',
		/topoExitOpen/.test(sigBody) && /topoApOpen/.test(sigBody) &&
		/topoExitDevices\(/.test(sigBody) && /topoApDevices\(/.test(sigBody));
	check('panel 下钻空状态有占位文案',
		/该出口暂无设备/.test(panel) && /该 AP 下暂无在线设备/.test(panel));
	check('panel 出口占比为 0 时显示「—」而不是 NaN / 假 0%',
		/total > 0 && n\.total > 0/.test(exitCardBody) && /'—'/.test(exitCardBody));
	check('panel 主路由卡显示「共 N 台」与记账状态（confLook 语义）',
		/共/.test(topoBody) && /台/.test(topoBody) && /topoConfidence\(\)/.test(topoBody) &&
		/topoConfidence:\s*function\s*\(/.test(panel) && /accounting_confidence/.test(panel));
	check('panel 深色主题对拓扑卡片补 rgba 中性色覆盖',
		/@media \(prefers-color-scheme:dark\)\{[\s\S]{0,420}rgba\(127,127,127/.test(panel) &&
		/ts-topo-card/.test(panel) && /ts-topo-layer/.test(panel));

	check('mobile PWA 路径使用 L.resource',
		/L\.resource\('prism-router\/'/.test(mobile) && /pwaAsset/.test(mobile));
	check('mobile 明确根部署回退',
		/\/luci-static\/resources\/prism-router\//.test(mobile));
}

// ---------------------------------------------------------------- 6b. 概览纯函数

async function testOverviewLogic() {
	console.log('\n[6b] 概览纯函数（昨日全天 / 在线 / health）');

	const source = readView('overview');
	const patched = source.replace(
		/\nreturn view\.extend\(\{/,
		'\nglobalThis.__tsTests = { yesterdayCompare: yesterdayCompare, shiftDayKey: shiftDayKey, onlineCount: onlineCount, healthLook: healthLook, newestDay: newestDay, trendOf: trendOf, attentionItems: attentionItems, localDayKey: localDayKey };\nreturn view.extend({'
	);

	if (patched === source) {
		bad('overview 可注入纯函数测试钩子');

		return;
	}

	const env = makeEnvironment();
	const context = vm.createContext(env);
	const script = new vm.Script('(function () {\n' + patched + '\n})()', { filename: 'overview.logic.js' });

	script.runInContext(context, { timeout: 3000 });

	const tests = context.__tsTests;

	check('overview 纯函数可测试', tests != null);

	if (tests == null) return;

	/* 本地日历加减日：跨夏令时切换日（23/25 小时）也不能差一天。 */
	check('日历减日：2026-03-08（美国春季 DST）→ 2026-03-07',
		tests.shiftDayKey('2026-03-08', -1) === '2026-03-07',
		tests.shiftDayKey('2026-03-08', -1));
	check('日历减日：2026-11-01（美国秋季 DST）→ 2026-10-31',
		tests.shiftDayKey('2026-11-01', -1) === '2026-10-31',
		tests.shiftDayKey('2026-11-01', -1));
	check('非法日期不参与 day 匹配（2026-02-31）',
		tests.shiftDayKey('2026-02-31', -1) === '');

	const now = Math.floor(Date.now() / 1000);

	function localKey(ts) {
		const d = new Date(ts * 1000);

		return d.getFullYear() + '-' +
			String(d.getMonth() + 1).padStart(2, '0') + '-' +
			String(d.getDate()).padStart(2, '0');
	}

	function shiftKey(key, delta) {
		const parts = key.split('-').map(Number);
		const d = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);

		d.setDate(d.getDate() + delta);

		return d.getFullYear() + '-' +
			String(d.getMonth() + 1).padStart(2, '0') + '-' +
			String(d.getDate()).padStart(2, '0');
	}

	const todayKey = localKey(now);
	const yKey = shiftKey(todayKey, -1);
	const olderKey = shiftKey(todayKey, -2);

	const history = {
		days: [
			{ day: todayKey, buckets: [ { ts: now - 300, direct_rx: 1, direct_tx: 1, proxy_rx: 0, proxy_tx: 0 } ] },
			{ day: yKey, buckets: [], summary: { totals: {
				direct_rx: 1, direct_tx: 2, proxy_rx: 3, proxy_tx: 4, rx: 4, tx: 6
			} } }
		]
	};
	const compare = tests.yesterdayCompare(history, now);

	check('昨日全天取 summary.totals（rx+tx=10）',
		compare.ok === true && compare.yestBytes === 10, JSON.stringify(compare));
	check('昨日全天文案不再叫“较昨日”',
		compare.ok === true && /昨日全天/.test(compare.text) && !/较昨日/.test(compare.text), compare.text);
	check('昨日全天 title 明确同截止时间不可用',
		/不可用/.test(compare.title), compare.title);

	/*
	 * 非理想数组：days[1] 是前天（还带一个 99 的汇总），昨天排在最后。
	 * 旧实现固定读 days[1] 会显示 99；新实现必须按 day 找到 10。
	 */
	const nonIdeal = {
		days: [
			{ day: todayKey, buckets: [] },
			{ day: olderKey, summary: { totals: { rx: 99, tx: 0 } } },
			{ day: yKey, summary: { totals: { rx: 4, tx: 6 } } }
		]
	};
	const nonIdealCompare = tests.yesterdayCompare(nonIdeal, now);

	check('非理想数组：昨日不在 days[1] 也按 day 找到（rx+tx=10，不是 99）',
		nonIdealCompare.ok === true && nonIdealCompare.yestBytes === 10,
		JSON.stringify(nonIdealCompare));
	check('非理想数组：title 使用后端 day 字段',
		nonIdealCompare.ok === true && nonIdealCompare.title.indexOf(yKey) >= 0,
		nonIdealCompare.title);

	/* 只有昨天一天（没有今天的桶）也必须能显示，不再要求数组长度 >= 2。 */
	const onlyYesterday = {
		days: [ { day: yKey, summary: { totals: { rx: 1, tx: 1 } } } ]
	};
	const onlyCompare = tests.yesterdayCompare(onlyYesterday, now);

	check('只有昨日 daily 时仍能按 day 显示（rx+tx=2）',
		onlyCompare.ok === true && onlyCompare.yestBytes === 2, JSON.stringify(onlyCompare));

	/* 缺少昨天、但 days[1] 是前天且有 summary：必须降级，不能误读 days[1]。 */
	const missing = tests.yesterdayCompare({
		days: [
			{ day: todayKey, buckets: [] },
			{ day: olderKey, summary: { totals: { rx: 99, tx: 0 } } }
		]
	}, now);

	check('缺少昨日 daily 时降级为 —（不误读 days[1]）',
		missing.ok !== true && /—/.test(missing.text), JSON.stringify(missing));

	/* days 乱序：昨天排第一、今天排第二，仍按 day 找到。 */
	const shuffled = tests.yesterdayCompare({
		days: [
			{ day: yKey, summary: { totals: { rx: 3, tx: 7 } } },
			{ day: todayKey, buckets: [] }
		]
	}, now);

	check('days 乱序时仍按 day 找到昨天（rx+tx=10）',
		shuffled.ok === true && shuffled.yestBytes === 10, JSON.stringify(shuffled));

	check('在线只统计 last_seen>0 且 10 分钟内',
		tests.onlineCount({ devices: [
			{ last_seen: 0 },
			{ last_seen: now - 100 },
			{ last_seen: now - 700 }
		] }, now) === 1);

	check('health unavailable 不显示为精确',
		tests.healthLook('unavailable').label !== '记账精确' &&
		/不可用/.test(tests.healthLook('unavailable').label));

	/* 午夜后 history.json 仍是昨天：今日 KPI/趋势必须降级，不能拿 days[0] 冒充今日。 */
	const oldOnlyTrend = tests.trendOf(tests.newestDay(onlyYesterday, now), now);
	check('今日筛选只接受后端 day=今天，旧 history 不冒充今日',
		tests.newestDay(onlyYesterday, now).days.length === 0 &&
		oldOnlyTrend.points.length === 0);
	const actualToday = { day: todayKey, buckets: [
		{ ts: now - 300, direct_rx: 100, direct_tx: 20 },
		{ ts: now, direct_rx: 200, direct_tx: 40 }
	] };
	const mixedHistory = { days: [ onlyYesterday.days[0], actualToday ] };
	const todayTrend = tests.trendOf(tests.newestDay(mixedHistory, now), now);
	check('乱序历史仍能按 day 取到今天桶',
		todayTrend.points.length === 2 && todayTrend.sumRx === 300 && todayTrend.sumTx === 60,
		JSON.stringify(todayTrend));

	/* 真实异常路径：degraded/source-bad/stale 都会走 panelHref，不能再 ReferenceError。 */
	let attention = null;
	let attentionError = '';
	try {
		attention = tests.attentionItems({
			ts: now - 300,
			health: { accounting_confidence: 'degraded', reasons: [] },
			source: { clash: 'error', conntrack: 'ok' },
			devices: [], quota: {}
		}, now);
	} catch (e) { attentionError = String(e); }
	check('异常关注项可生成且下钻 LuCI 内部详细面板',
		attentionError === '' && Array.isArray(attention) && attention.length >= 3 &&
		attention.every(function(item) { return /prism-router\/panel|prism-router\/devices/.test(item.href || ''); }),
		attentionError || JSON.stringify(attention));
}

// ---------------------------------------------------------------- 6c. mobile 健康状态

async function testMobileHealth() {
	console.log('\n[6c] mobile 健康状态（unknown 灰 / unavailable 红）');

	const source = readView('mobile');
	const patched = source.replace(
		/\nreturn view\.extend\(\{/,
		'\nglobalThis.__tsMobile = { healthLook: healthLook };\nreturn view.extend({'
	);

	if (patched === source) {
		bad('mobile 可注入 healthLook 测试钩子');

		return;
	}

	const env = makeEnvironment();
	const context = vm.createContext(env);
	const script = new vm.Script('(function () {\n' + patched + '\n})()', { filename: 'mobile.health.js' });

	script.runInContext(context, { timeout: 3000 });

	const tests = context.__tsMobile;

	check('mobile healthLook 可测试', tests != null);

	if (tests == null) return;

	const unknown = tests.healthLook('unknown');

	check('unknown → 灰色「未知」，不叫不可用',
		unknown.kind === 'unknown' &&
		/未知/.test(unknown.label) && !/不可用/.test(unknown.label) &&
		unknown.color === '#9e9e9e',
		JSON.stringify(unknown));

	const unavailable = tests.healthLook('unavailable');

	check('unavailable → 红色「不可用」',
		unavailable.kind === 'unavailable' &&
		/不可用/.test(unavailable.label) && unavailable.color === '#c62828',
		JSON.stringify(unavailable));

	const degraded = tests.healthLook('degraded');

	check('degraded 不再冒充 unavailable 红色',
		degraded.kind === 'degraded' && degraded.color !== '#c62828',
		JSON.stringify(degraded));

	check('syncHealth 对 unknown 走灰色分支',
		/look\.kind == 'unknown'/.test(source) && /warnColor/.test(source));
}

// ---------------------------------------------------------------- 6d. settings UCI 失败闸门

async function testSettingsUciGuard() {
	console.log('\n[6d] settings uciOk=false：拒绝保存 / 禁用按钮');

	const loaded = loadView('settings');
	const mod = loaded.view;
	const env = loaded.env;
	const ctx = Object.create(mod);

	env.uci.load = function () {
		return Promise.reject(new Error('uci unavailable (test)'));
	};

	await mod.load.call(ctx);

	check('uci.load 失败后 uciOk=false', ctx.uciOk === false, '' + ctx.uciOk);

	mod.render.call(ctx);

	const apply = findNode(ctx.root, function (n) { return n.attrs && n.attrs.id === 'ts-settings-save-apply'; });
	const save = findNode(ctx.root, function (n) { return n.attrs && n.attrs.id === 'ts-settings-save-only'; });
	const restart = findNode(ctx.root, function (n) { return n.attrs && n.attrs.id === 'ts-settings-restart'; });

	check('保存并应用按钮 disabled', apply != null && apply.attrs.disabled === true);
	check('仅保存按钮 disabled', save != null && save.attrs.disabled === true);
	check('重启按钮 disabled', restart != null && restart.attrs.disabled === true);

	const feishuTest = findNode(ctx.root, function (n) {
		return n.tag === 'button' && containsText(n, '测试发送');
	});
	const feishuChats = findNode(ctx.root, function (n) {
		return n.tag === 'button' && containsText(n, '列出机器人所在的群');
	});

	check('飞书写操作按钮也 disabled（测试发送）', feishuTest != null && feishuTest.attrs.disabled === true);
	check('飞书写操作按钮也 disabled（列群）', feishuChats != null && feishuChats.attrs.disabled === true);

	let collected = false;

	ctx.collect = function () {
		collected = true;
		throw new Error('collect 不应在 uciOk=false 时执行');
	};

	await mod.save.call(ctx, false);

	check('uciOk=false 时 save 不执行 collect（不构造默认值）', collected === false);
	check('uciOk=false 时 save 不调用 set_config',
		callsOf(env, 'set_config').length === 0,
		'calls=' + callsOf(env, 'set_config').length);
	check('uciOk=false 时状态栏明确提示拒绝保存',
		ctx.statusText != null && /拒绝保存/.test(ctx.statusText.textContent),
		ctx.statusText && ctx.statusText.textContent);
	check('uciOk=false 时发出 error 通知',
		env.__notifications.some(function (n) { return n.kind === 'error'; }));

	await mod.restartService.call(ctx, {});

	check('uciOk=false 时 restart 不调用后端',
		callsOf(env, 'restart').length === 0,
		'calls=' + callsOf(env, 'restart').length);
	check('uciOk=false 时重启也被明确拒绝',
		ctx.statusText != null && /禁用重启/.test(ctx.statusText.textContent),
		ctx.statusText && ctx.statusText.textContent);

	/* 只读账号即使 uciOk=true（老 dispatcher 仍放行路由），写按钮也要禁用。 */
	const roLoaded = loadView('settings');
	const roCtx = Object.create(roLoaded.view);

	roCtx.uciOk = true;
	roLoaded.env.L.env = { acls: [ 'luci-app-prism-router' ] };
	roLoaded.view.render.call(roCtx);

	const roApply = findNode(roCtx.root, function (n) { return n.attrs && n.attrs.id === 'ts-settings-save-apply'; });
	const roRestart = findNode(roCtx.root, function (n) { return n.attrs && n.attrs.id === 'ts-settings-restart'; });

	check('只读 ACL 账号：保存按钮 disabled', roApply != null && roApply.attrs.disabled === true);
	check('只读 ACL 账号：重启按钮 disabled', roRestart != null && roRestart.attrs.disabled === true);

	let roCollected = false;

	roCtx.collect = function () {
		roCollected = true;
		throw new Error('只读账号不应 collect');
	};

	await roLoaded.view.save.call(roCtx, false);

	check('只读 ACL 账号：save 不 collect、不调 set_config',
		roCollected === false && callsOf(roLoaded.env, 'set_config').length === 0,
		'calls=' + callsOf(roLoaded.env, 'set_config').length);
	check('只读 ACL 账号：状态栏提示没有管理 ACL',
		roCtx.statusText != null && /没有管理 ACL/.test(roCtx.statusText.textContent),
		roCtx.statusText && roCtx.statusText.textContent);

	/* admin 账号（uciOk=true）按钮恢复可用。 */
	const adminLoaded = loadView('settings');
	const adminCtx = Object.create(adminLoaded.view);

	adminCtx.uciOk = true;
	adminLoaded.env.L.env = { acls: [ 'luci-app-prism-router', 'luci-app-prism-router-admin' ] };
	adminLoaded.view.render.call(adminCtx);

	const adminApply = findNode(adminCtx.root, function (n) { return n.attrs && n.attrs.id === 'ts-settings-save-apply'; });

	check('admin ACL 账号：保存按钮可用', adminApply != null && adminApply.attrs.disabled !== true);
}

// ---------------------------------------------------------------- 6e. devices UTF-8 与权限

async function testDevicesMetaPermissions() {
	console.log('\n[6e] devices 128 UTF-8 字节校验 / 截断回显 / 权限');

	const source = readView('devices');
	const patched = source.replace(
		/\nreturn view\.extend\(\{/,
		'\nglobalThis.__tsDev = { utf8Bytes: utf8Bytes, metaByteError: metaByteError, isAdmin: isAdmin, applyMetaResult: applyMetaResult };\nreturn view.extend({'
	);

	if (patched === source) {
		bad('devices 可注入元数据测试钩子');

		return;
	}

	const env = makeEnvironment();
	const context = vm.createContext(env);
	const script = new vm.Script('(function () {\n' + patched + '\n})()', { filename: 'devices.meta.js' });
	const view = script.runInContext(context, { timeout: 3000 });

	const tests = context.__tsDev;

	check('devices 元数据助手可测试', tests != null);

	if (tests == null) return;

	const cn43 = '中'.repeat(43);
	const cn42 = '中'.repeat(42);

	check('中文 43 字 = 129 UTF-8 字节', tests.utf8Bytes(cn43) === 129, '' + tests.utf8Bytes(cn43));
	check('中文 42 字 = 126 UTF-8 字节', tests.utf8Bytes(cn42) === 126, '' + tests.utf8Bytes(cn42));
	check('中文 43 字被拒绝（不是按 UTF-16 length）',
		tests.metaByteError(cn43, '') != null);
	check('中文 42 字允许', tests.metaByteError(cn42, '') === null);
	check('128 个 ASCII 允许', tests.metaByteError('a'.repeat(128), '') === null);
	check('129 个 ASCII 被拒绝', tests.metaByteError('a'.repeat(129), '') != null);

	const dev = { alias: '旧别名', group: '旧分组' };
	const applied = tests.applyMetaResult(dev, { alias: cn42, group: '' }, cn43, '');

	check('后端截断时 dev 更新为返回的真实值',
		applied.truncated === true && dev.alias === cn42 && applied.alias === cn42,
		JSON.stringify(applied));
	check('后端截断时警告包含实际保存值',
		/截断/.test(applied.warning) && applied.warning.indexOf(cn42) >= 0 &&
		/128/.test(applied.warning),
		applied.warning);
	check('未截断时不发警告',
		tests.applyMetaResult(dev, { alias: 'tv', group: '家' }, 'tv', '家').truncated === false);

	check('devices 不再用 UTF-16 alias.length > 128 判断',
		!/alias\.length\s*>\s*128/.test(source) && !/group\.length\s*>\s*128/.test(source));
	check('devices 用 TextEncoder 统计 UTF-8 字节',
		/TextEncoder/.test(source) && /metaByteError/.test(source));

	/* 权限：L.env.acls 缺失 → 保守 false；只读组 false；admin 组 true。 */
	delete env.L.env;

	check('L.env.acls 与能力均缺失时保守不展示编辑',
		tests.isAdmin() === false);

	delete env.L.env;
	env.L.env = { prismRouterCanManage: true };
	check('无 ACL 列表时用只读 RPC 的 can_manage 能力', tests.isAdmin() === true);
	env.L.env.prismRouterCanManage = false;
	check('RPC 明确非管理员时隐藏写入口', tests.isAdmin() === false);

	env.L.env = { acls: [ 'luci-app-prism-router' ] };

	check('只读 ACL 组 → 非管理员', tests.isAdmin() === false);

	const ctxRead = { openEditDialog: function () {} };
	const readonlyTree = view.renderAliasContent.call(ctxRead,
		{ mac: 'AA:BB:CC:DD:EE:FF', alias: 'tv', group: '' });

	check('只读用户看到的别名格没有「编辑」按钮',
		containsText(readonlyTree, '编辑') === false);

	env.L.env = { acls: [ 'luci-app-prism-router', 'luci-app-prism-router-admin' ] };

	check('admin ACL 组 → 管理员', tests.isAdmin() === true);

	const adminTree = view.renderAliasContent.call(ctxRead,
		{ mac: 'AA:BB:CC:DD:EE:FF', alias: 'tv', group: '' });

	check('管理员看到的别名格有「编辑」按钮',
		containsText(adminTree, '编辑') === true);

	/* 直接调用编辑入口也要被 admin 闸门挡住（避免只靠按钮隐藏）。 */
	env.L.env = { acls: [ 'luci-app-prism-router' ] };

	const guardCtx = { dialog: null, drafts: {} };
	const beforeNotify = env.__notifications.length;

	view.openEditDialog.call(guardCtx, { mac: 'AA:BB:CC:DD:EE:FF', alias: 'tv', group: '' });

	check('只读用户直接调用编辑入口也被拒绝',
		guardCtx.dialog == null && env.__notifications.length === beforeNotify + 1,
		'notifications+' + (env.__notifications.length - beforeNotify));
}



// ---------------------------------------------------------------- 6f. 共享主题

function srgbToLinear(c) {
	const v = c / 255;

	return (v <= 0.03928) ? (v / 12.92) : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
	const m = /^#([0-9a-fA-F]{6})$/.exec(hex);

	if (m == null) return null;

	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;

	return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(a, b) {
	const la = luminance(a);
	const lb = luminance(b);

	if (la == null || lb == null) return 0;

	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);

	return (hi + 0.05) / (lo + 0.05);
}

async function testTheme() {
	console.log('\n[6f] 共享主题 theme.js / 令牌 / 对比度 / 作用域');

	const theme = themeModule();
	const tokens = theme.TOKENS;

	check('theme.js 导出 CLASS / css / style / color',
		theme.CLASS === 'ts-prism' && typeof theme.css === 'function' &&
		typeof theme.style === 'function' && typeof theme.color === 'function',
		'class=' + theme.CLASS);
	check('theme.CLASS = ts-prism（页面根共享 class）', theme.CLASS === 'ts-prism');

	check('下载色：浅 #3B82F6 / 深 #60A5FA',
		tokens.down.light === '#3B82F6' && tokens.down.dark === '#60A5FA',
		JSON.stringify(tokens.down));
	check('上传色：浅 #0891B2 / 深 #22D3EE',
		tokens.up.light === '#0891B2' && tokens.up.dark === '#22D3EE',
		JSON.stringify(tokens.up));

	/* 正文/标签对比度：白底 ≥4.5:1，深色底 ≥4.5:1（WCAG 2.1 AA）。 */
	const lightBg = '#FFFFFF';
	const darkBg = '#12161B';
	const textKeys = [ 'downText', 'upText', 'okText', 'warnText', 'badText', 'text', 'text2', 'text3' ];
	const lightFail = textKeys.filter(function(key) {
		return contrast(tokens[key].light, lightBg) < 4.5;
	});
	const darkFail = textKeys.filter(function(key) {
		return contrast(tokens[key].dark, darkBg) < 4.5;
	});

	check('浅色正文/标签 token 对比度 ≥4.5:1', lightFail.length === 0,
		lightFail.map(function(key) {
			return key + '=' + contrast(tokens[key].light, lightBg).toFixed(2);
		}).join(' '));
	check('深色正文/标签 token 对比度 ≥4.5:1', darkFail.length === 0,
		darkFail.map(function(key) {
			return key + '=' + contrast(tokens[key].dark, darkBg).toFixed(2);
		}).join(' '));

	/* 方向色（填充）与状态色必须是两套值，避免“下载 = 正常”这类误读。 */
	check('方向色与状态色不共用（浅色）',
		tokens.down.light !== tokens.ok.light && tokens.down.light !== tokens.warn.light &&
		tokens.down.light !== tokens.bad.light && tokens.up.light !== tokens.ok.light &&
		tokens.up.light !== tokens.warn.light && tokens.up.light !== tokens.bad.light);
	check('方向色与状态色不共用（深色）',
		tokens.down.dark !== tokens.ok.dark && tokens.down.dark !== tokens.warn.dark &&
		tokens.down.dark !== tokens.bad.dark && tokens.up.dark !== tokens.ok.dark &&
		tokens.up.dark !== tokens.warn.dark && tokens.up.dark !== tokens.bad.dark);

	const css = theme.css();

	check('主题声明深浅两套 token',
		/--ts-down:#3B82F6/.test(css) && /--ts-down:#60A5FA/.test(css) &&
		/@media \(prefers-color-scheme:dark\)/.test(css));
	check('LuCI data-darkmode 显式深色优先且显式浅色不被 OS 覆盖',
		/:root\[data-darkmode="true"\] \.ts-prism/.test(css) &&
		/:root:not\(\[data-darkmode="false"\]\) \.ts-prism/.test(css));
	check('主题含 focus-visible 描边', /:focus-visible\{outline:2px solid var\(--ts-focus\)/.test(css));
	check('主题尊重 prefers-reduced-motion',
		/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?animation-duration:\.001ms/.test(css));
	check('主题提供折叠说明/details 组件', /details\.ts-fold/.test(css));
	check('主题提供方向图例（下载/上传）', /\.ts-dir-down::before/.test(css) && /\.ts-dir-up::before/.test(css));

	/* 作用域：所有选择器都必须挂在 .ts-prism 下，不能泄漏到 LuCI 全局。 */
	const leaked = [];
	css.split('\n').forEach(function(line) {
		const text = line.trim();

		if (text.indexOf('{') < 0) return;

		const selector = text.slice(0, text.indexOf('{'));

		/* @media 行本身不是选择器；它内部的规则会在各自行继续检查。 */
		if (selector.charAt(0) === '@') return;

		selector.split(',').forEach(function(part) {
			const value = part.trim();
			if (!value.length) return;
			if (value.indexOf('.ts-prism') === 0) return;
			/* LuCI bootstrap 显式主题属性必须能优先于 OS 媒体查询。 */
			if (/^:root(?::not\(\[data-darkmode="false"\]\)|\[data-darkmode="true"\]) \.ts-prism$/.test(value)) return;
			leaked.push(text);
		});
	});

	check('主题规则全部限定在 .ts-prism 作用域（无全局泄漏）', leaked.length === 0,
		leaked.slice(0, 3).join(' | '));

	/* 每个页面都 require 共享模块、根元素带 class、注入 theme.style()。 */
	for (const name of THEMED_VIEWS) {
		const source = readView(name);

		check(name + ' require 共享主题模块',
			/require prism-router\/theme as theme/.test(source));
		check(name + ' 根元素带 theme.CLASS', /'class': theme\.CLASS/.test(source));
		check(name + ' 注入 theme.style()', /theme\.style\(\)/.test(source));
	}

	check('概览标题统一为「概览」', /棱镜路由 · 概览/.test(readView('overview')));
	check('节点页标题统一为「网络节点」', /棱镜路由 · 网络节点/.test(readView('nodes')));
	check('诊断页标题统一', /棱镜路由 · 诊断/.test(readView('diagnostics')));
	check('设置页标题统一', /棱镜路由 · 设置/.test(readView('settings')));
}


// ---------------------------------------------------------------- 6i. 概览渲染冒烟（DOM 桩）

async function testOverviewRender() {
	console.log('\n[6i] 概览渲染冒烟：根/4 KPI/顺序/折叠/8099 条件入口');

	const loaded = loadView('overview');
	const now = Math.floor(Date.now() / 1000);

	function makeCtx(panelEnabled) {
		const ctx = Object.create(loaded.view);

		ctx.autoRefresh = false;
		ctx.panelEnabled = panelEnabled === true;
		ctx.state = {
			running: true,
			ts: now,
			uptime: 3600,
			totals: {
				direct_rx: 100, direct_tx: 50, proxy_rx: 200, proxy_tx: 80,
				rx_rate: 1000, tx_rate: 500,
				wifi_rx: 10, wifi_tx: 5, wired_rx: 20, wired_tx: 2,
				unknown_rx: 0, unknown_tx: 0,
				month_total: 1073741824
			},
			quota: { mode: 'monthly', monthly_gb: 10, total_gb: 0, period: '' },
			health: { accounting_confidence: 'exact', reasons: [] },
			devices: [ {
				mac: 'AA:BB:CC:DD:EE:FF', hostname: 'tv', ip: '192.168.1.2',
				direct_rx: 10, direct_tx: 5, proxy_rx: 1, proxy_tx: 1,
				last_seen: now - 10, link: 'wifi'
			} ],
			apps: [ { host: 'youtube.com', rx: 10, tx: 5, chain: 'DIRECT', devices: 1 } ],
			nodes: {}
		};

		return ctx;
	}

	let root = null;

	try {
		root = loaded.view.render.call(makeCtx(false));
	}
	catch (err) {
		bad('概览 render 不抛异常', err && err.message);
		return;
	}

	ok('概览 render 不抛异常');

	check('根节点 #ts-overview 且带 .ts-prism',
		root != null && root.attrs != null && root.attrs.id === 'ts-overview' &&
		('' + root.attrs['class']).indexOf('ts-prism') >= 0,
		root && JSON.stringify(root.attrs));

	const text = (function() {
		const parts = [];

		(function walk(node) {
			if (node == null) return;
			if (typeof node === 'string') { parts.push(node); return; }
			if (typeof node !== 'object') return;
			if (typeof node.children === 'string') parts.push(node.children);
			else if (Array.isArray(node.children)) node.children.forEach(walk);
			if (node.textContent) parts.push('' + node.textContent);
		})(root);

		return parts.join(' ');
	})();

	check('4 个 KPI 文案都在页面上',
		text.indexOf('下载') >= 0 && text.indexOf('上传') >= 0 &&
		text.indexOf('今日') >= 0 && text.indexOf('本月') >= 0);
	check('KPI 数值按字节单位渲染（GiB/MiB/B）', /(GiB|MiB|KiB| B)/.test(text));
	check('今日无桶时显示 —（不补 0）', text.indexOf('暂无今日桶') >= 0);

	const topIndex = root.children.findIndex(function(node) {
		return node && node.attrs && ('' + (node.attrs['class'] || '')).indexOf('tso-cols-top') >= 0;
	});
	const calIndex = root.children.findIndex(function(node) {
		return node && node.attrs && ('' + (node.attrs['class'] || '')).indexOf('tso-cal-panel') >= 0;
	});

	check('DOM 顺序：Top 在日历之前', topIndex >= 0 && calIndex >= 0 && topIndex < calIndex,
		'top=' + topIndex + ' cal=' + calIndex);

	const calBox = root.children[calIndex];

	check('日历是 <details> 且默认折叠（open 不为 true）',
		calBox != null && calBox.tag === 'details' && calBox.attrs.open !== true &&
		calBox.attrs.open !== 'open',
		calBox && JSON.stringify(calBox.attrs));

	check('概览不渲染默认 8099 控制台死链',
		containsText(root, '独立控制台') === false);
	check('桌面概览不再渲染手机版入口',
		containsText(root, '手机版') === false);

	const degradedCtx = makeCtx(false);
	degradedCtx.state.health.accounting_confidence = 'degraded';
	degradedCtx.state.source = { clash: 'error', conntrack: 'unknown' };
	degradedCtx.state.ts = now - 600;
	let degradedRoot = null;
	let degradedError = '';
	try { degradedRoot = loaded.view.render.call(degradedCtx); }
	catch (e) { degradedError = String(e); }
	/* DOM 桩不保留 dom.content 的子树；条目文本/URL由上方 attentionItems 行为测试验证。 */
	check('概览 degraded/source-bad/stale 完整 render 不再因 panelHref 崩溃',
		degradedError === '' && degradedRoot != null && degradedCtx.attnBox != null &&
		degradedCtx.attnSig != null && degradedCtx.attnSig.indexOf('记账状态') >= 0,
		degradedError || ('root=' + (degradedRoot != null) + ' attn=' + (degradedCtx.attnBox != null) + ' sig=' + degradedCtx.attnSig));
}

// ---------------------------------------------------------------- 6g. 概览驾驶舱 IA

async function testCockpit() {
	console.log('\n[6g] 概览驾驶舱：4 KPI / Top 在日历前 / 日历折叠 / 8099 条件入口');

	const overview = readView('overview');
	const renderBody = (overview.match(/render: function\(\)\s*\{([\s\S]*?)\n\t\},\n\n\t\/\* get_state 失败/ ) || [])[1] || '';
	const kpiBody = (overview.match(/renderKpis: function\(state\)\s*\{([\s\S]*?)\n\t\},\n\n\t\/\/ -{10,} ②b/) || [])[1] || '';

	check('概览 render 结构可定位', renderBody.length > 0 && kpiBody.length > 0,
		'render=' + renderBody.length + ' kpi=' + kpiBody.length);

	/* 4 个 KPI 去重：下载 / 上传 / 今日 / 本月；实时速率与接入维度不再占 KPI。 */
	check('KPI = 下载/上传/今日/本月',
		/_\('下载'\)/.test(kpiBody) && /_\('上传'\)/.test(kpiBody) &&
		/_\('今日'\)/.test(kpiBody) && /_\('本月'\)/.test(kpiBody));
	check('KPI 不再重复放实时速率', !/_\('实时速率'\)/.test(kpiBody));
	check('KPI 不再重复放无线/有线接入', !/_\('无线接入'\)/.test(kpiBody) && !/_\('有线接入'\)/.test(kpiBody));
	check('4 张 KPI 磁贴按顺序渲染',
		/\[ downCard, upCard, todayCard, monthCard \]/.test(kpiBody));
	check('KPI 下载/上传用方向色 token',
		/var\(--ts-down-text\)/.test(kpiBody) && /var\(--ts-up-text\)/.test(kpiBody));

	/* Top 设备/应用必须排在日历之前。 */
	const topAt = renderBody.indexOf('renderTopDevices');
	const calAt = renderBody.indexOf('renderCalendar');

	check('Top 设备/应用在日历之前', topAt > 0 && calAt > 0 && topAt < calAt,
		'top=' + topAt + ' cal=' + calAt);

	/* 日历默认折叠（<details> 不带 open）。 */
	check('日历用 <details> 默认折叠',
		/E\('details', \{ 'class': 'tso-panel tso-cal-panel ts-fold' \}/.test(overview));
	check('日历英文案在折叠体内（不再长期占页面）',
		/ts-fold-b[\s\S]{0,260}左旧右新/.test(overview));
	check('展开日历时滚到今天',
		/calBox\.addEventListener\('toggle'[\s\S]{0,160}scrollCalendarToToday\(\)/.test(overview));

	/* 8099 配置不能由只读 ACL 安全读取，首屏不发 UCI、不阻塞实时数据。 */
	check('首屏不读取 UCI 探测面板开关',
		!/uci\.load\('prism-router'\)/.test(overview) &&
		!/readPanelEnabled\(\)/.test(overview));
	check('概览不渲染无条件 8099 死链',
		!/href: consoleUrl\(\)/.test(overview));
	check('概览不再链接手机版路由（桌面不混入手机 UI）',
		!/admin\/services\/prism-router\/mobile/.test(overview));
	check('30s 周期同时更新今日桶/昨日对比与日历',
		/loadTrendHistory: function\(\)/.test(overview) &&
		/callHistory\(2\)\.then/.test(overview) &&
		/self\.loadTrendHistory\(\);[\s\S]{0,100}self\.loadCalendar\(\);/.test(overview));
	check('今日历史刷新有序号保护，旧响应不能覆盖新数据',
		/var seq = \(this\.trendSeq \|\| 0\) \+ 1/.test(overview) &&
		/if \(seq !== self\.trendSeq\) return/.test(overview) &&
		/historySeq === self\.trendSeq/.test(overview));

	/* 方向色：趋势数据集写 var(--ts-down/up)，Canvas 再按主题解析。 */
	check('趋势方向常量走 token',
		/var COLOR_RX = 'var\(--ts-down\)'/.test(overview) &&
		/var COLOR_TX = 'var\(--ts-up\)'/.test(overview));
	check('Canvas 颜色按主题解析', /theme\.color\('down'/.test(overview) && /theme\.color\('up'/.test(overview));
	check('状态色只用于健康/关注（ok/warn/bad token）',
		/var\(--ts-ok-text\)/.test(overview) && /var\(--ts-warn-text\)/.test(overview) &&
		/var\(--ts-bad-text\)/.test(overview) && !/COLOR_RX = 'var\(--ts-ok/.test(overview));
}


// ---------------------------------------------------------------- 6h. 设备/应用窄屏可读性

async function testResponsiveReadability() {
	console.log('\n[6h] devices/apps：窄屏不溢出 / 关键列保留 / 长说明折叠');

	const devices = readView('devices');
	const apps = readView('apps');

	check('devices 根限制 max-width:100% 且可换行',
		/#ts-devices\{max-width:100%;min-width:0;overflow-wrap:anywhere\}/.test(devices));
	check('devices 表格容器横向滚动（页面本身不溢出）',
		/#ts-devices \.tsd-tablewrap\{overflow-x:auto/.test(devices));
	check('devices 窄屏隐藏次要列（首次出现/信号）',
		/@media \(max-width:760px\)\{[\s\S]{0,120}#ts-devices \.tsd-opt\{display:none\}/.test(devices));
	check('devices 窄屏收紧表格最小宽度并约束 LuCI flex 行',
		/#ts-devices table\{min-width:660px\}/.test(devices) &&
		/#ts-devices table \.tr\{min-width:660px\}/.test(devices) &&
		/#ts-devices table \.tsd-col-name\{flex-basis:190px\}/.test(devices));
	check('devices 窄屏把次要列留给详情抽屉', /\.tsd-col-meta\{display:none\}/.test(devices));
	check('devices 信号表头与有/无信号单元格同步隐藏',
		/renderSignal: function[\s\S]*?'class': 'td tsd-opt', style: 'text-align:right'/.test(devices) &&
		/renderSignal: function[\s\S]*?'class': 'td tsd-opt',\n\t\t\tstyle: 'text-align:right;white-space:nowrap'/.test(devices));
	check('devices 窄屏搜索/下拉换行', /\.tsd-search\{flex:1 1 100%/.test(devices) &&
		/\.tsd-select\{flex:1 1 46%/.test(devices));

	check('apps 根限制 max-width:100%',
		/#ts-apps\{font-size:var\(--ts-fs-2\);max-width:100%;min-width:0\}/.test(apps));
	check('apps 表格容器横向滚动', /#ts-apps \.tsa-tablewrap\{[^}]*overflow-x:auto/.test(apps));
	check('apps 约束 LuCI flex 行与域名/数值关键列',
		/#ts-apps \.tsa-table \.tr\{display:flex;flex-wrap:nowrap;min-width:720px/.test(apps) &&
		/\.tsa-col-host\{flex:0 0 190px/.test(apps) &&
		/\.tsa-col-bytes\{flex:0 0 94px;white-space:nowrap/.test(apps));
	check('apps 窄屏有 760px / 420px 两档并隐藏次要列',
		/@media \(max-width:760px\)\{[\s\S]*?#ts-apps \.tsa-table\{min-width:670px\}/.test(apps) &&
		/\.tsa-col-meta\{display:none\}/.test(apps) &&
		/@media \(max-width:420px\)\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(apps));
	check('apps 筛选行允许换行', /\.tsa-filterline\{display:flex;gap:8px;align-items:center;flex-wrap:wrap/.test(apps));

	/* 字号：正文/标签 ≥12px（方向、类别、厂商、子信息）。 */
	check('apps 类别标签 ≥12px', /\.tsa-cat\{display:inline-block;font-size:12px/.test(apps));
	check('apps 排序箭头 12px', /\.tsa-arrow\{font-size:12px/.test(apps));
	check('devices 子信息/厂商 ≥12px',
		/\.tsd-sub\{font-size:12px/.test(devices) && /\.tsd-vendor\{font-size:12px/.test(devices));

	/* 长说明收进 details，默认不占页面。 */
	check('apps 数据口径说明收进 <details>',
		/E\('details', \{ 'class': 'tsa-note tsa-fold' \}/.test(apps) &&
		/E\('summary', \{\}, _\('数据口径说明'\)\)/.test(apps));
	check('apps details 默认不展开（无 open）',
		!/E\('details', \{ 'class': 'tsa-note tsa-fold'[^}]*open/.test(apps));

	/* 设备关键列保留：名称/接入/上下行/合计；直连/代理/合计带 ↓↑ title。 */
	check('devices 保留 名称/接入/直连/代理/合计/操作 列',
		/主机名 \/ 厂商/.test(devices) && /_\('接入'\)/.test(devices) &&
		/_\('直连'\)/.test(devices) && /_\('代理'\)/.test(devices) &&
		/_\('合计'\)/.test(devices) && /_\('操作'\)/.test(devices));
	check('devices 上下行拆分写进 cell title',
		/title: _\('直连'\) \+ ' ↓ '/.test(devices) &&
		/title: _\('代理'\) \+ ' ↓ '/.test(devices));
	check('apps 保留 域名/类别/下载/上传/合计 列',
		/'class': 'th tsa-col-host'/.test(apps) && /_\('应用\/域名'\)/.test(apps) &&
		/'class': 'th tsa-col-meta'/.test(apps) && /_\('类别'\)/.test(apps) &&
		/this\.sortHeader\(_\('下载'\), 'rx', 'right', 'tsa-col-bytes'\)/.test(apps) &&
		/this\.sortHeader\(_\('上传'\), 'tx', 'right', 'tsa-col-bytes'\)/.test(apps) &&
		/this\.sortHeader\(_\('合计'\), 'total', 'right', 'tsa-col-bytes'\)/.test(apps));
}

async function testMenu() {
	console.log('\n[7] 菜单 JSON：网络入口 + 旧路由保留（LuCI 真实可见规则）');

	try {
		const menu = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));

		check('menu.d JSON 可解析', menu != null && typeof menu === 'object');

		const leafKeys = Object.keys(menu).filter(function(key) {
			return key.indexOf('admin/services/prism-router/') === 0;
		});

		/*
		 * OpenWrt 24.10 ui.js 的 UIMenu.getChildren() 只检查 satisfied 和 title；
		 * 它不会读取 menu.d 的 hidden 字段。这里复刻真实可见性，避免用自创
		 * hidden 断言把八项菜单误报成五项，或牺牲 mobile/diagnostics 旧路由。
		 */
		/*
		 * 桌面侧栏只放六个真实入口；mobile / panel 去掉 title 后成为
		 * 「隐藏但可访问」的兼容路由（LuCI 的 getChildren 只渲染带 title 的节点），
		 * 供手机书签、PWA 与概览「详情」按钮继续使用，不再污染桌面菜单。
		 */
		const visible = leafKeys.filter(function(key) {
			const node = menu[key];
			return node && Object.prototype.hasOwnProperty.call(node, 'title') && node.satisfied !== false;
		}).sort(function(a, b) {
			return (menu[a].order || 0) - (menu[b].order || 0);
		});
		const visibleNames = visible.map(function(key) { return key.split('/').pop(); });

		sameList('桌面侧栏只显示六个入口（手机版/详细面板不出现）', visibleNames,
			[ 'overview', 'devices', 'apps', 'nodes', 'settings', 'diagnostics' ]);
		[ 'mobile', 'panel' ].forEach(function(name) {
			const node = menu['admin/services/prism-router/' + name];
			check(name + ' 不写 title（桌面菜单隐藏）',
				node && !Object.prototype.hasOwnProperty.call(node, 'title'));
		});
		check('不使用 LuCI 不支持的 hidden 菜单字段',
			leafKeys.every(function(key) { return !Object.prototype.hasOwnProperty.call(menu[key], 'hidden'); }));
		check('主入口标题为 概览/设备/应用/网络/设置',
			visible.slice(0, 5).map(function(key) { return menu[key].title; }).join('|') === '概览|设备|应用|网络|设置',
			visible.map(function(key) { return menu[key].title; }).join('|'));

		check('「网络」入口复用 nodes.js 且 path 不变',
			menu['admin/services/prism-router/nodes'].title === '网络' &&
			menu['admin/services/prism-router/nodes'].action.type === 'view' &&
			menu['admin/services/prism-router/nodes'].action.path === 'prism-router/nodes');

		/* 隐藏路由仍必须是真实 view action：设置页给手机版/诊断入口，
		   概览「详情」按钮打开 panel；三者都不能变成 404。 */
		[ 'mobile', 'diagnostics', 'panel' ].forEach(function(name) {
			const node = menu['admin/services/prism-router/' + name];
			check(name + ' 旧 URL 对应 view 路由保留',
				node && node.action && node.action.type === 'view' &&
				node.action.path === 'prism-router/' + name);
		});

		const root = menu['admin/services/prism-router'];
		const rootAcl = root && root.depends && root.depends.acl;

		check('根菜单保留 luci-app-prism-router 依赖',
			Array.isArray(rootAcl) && rootAcl.length === 1 && rootAcl[0] === 'luci-app-prism-router',
			JSON.stringify(rootAcl));

		const settings = menu['admin/services/prism-router/settings'];
		const settingsAcl = settings && settings.depends && settings.depends.acl;

		check('设置页子路由 depends.acl=luci-app-prism-router-admin',
			Array.isArray(settingsAcl) && settingsAcl.length === 1 &&
			settingsAcl[0] === 'luci-app-prism-router-admin',
			JSON.stringify(settingsAcl));

		/*
		 * LuCI 的 JS View 基类（luci.js 的 LuCI.view）没有 depends 成员，
		 * 视图 JS 里写 depends 不会被 dispatcher 读取；ACL 必须落在 menu.d 节点。
		 */
		const settingsView = readView('settings');

		check('settings.js 不伪造 view.depends（ACL 只在 menu.d）',
			!/(?:^|\n)\s*depends\s*:/.test(settingsView));

		const mobileSrc = readView('mobile');
		const panelSrc = readView('panel');

		check('mobile/panel 没有写 RPC，因此不需要 admin 子路由依赖',
			!/set_config|set_device_meta|method:\s*'restart'|uci\.set\s*\(/.test(mobileSrc) &&
			!/set_config|set_device_meta|method:\s*'restart'|uci\.set\s*\(/.test(panelSrc));

		/* 入口补偿：设置页给诊断，概览给手机版；不制造死链。 */
		check('设置页含诊断入口链接',
			/admin\/services\/prism-router\/diagnostics/.test(readView('settings')));
		check('设置页含手机版入口链接',
			/admin\/services\/prism-router\/mobile/.test(readView('settings')));
	}
	catch (err) {
		bad('menu.d JSON 可解析', err && err.message);
	}
}

// ---------------------------------------------------------------- main

(async function main() {
	console.log('LuCI 前端静态测试：' + VIEW_DIR);

	await testSyntax();
	await testDeclarations();
	await testQuotaSubmit();
	await testExports();
	await testDangerousDom();
	await testSemantics();
	await testOverviewLogic();
	await testMobileHealth();
	await testSettingsUciGuard();
	await testDevicesMetaPermissions();
	await testTheme();
	await testCockpit();
	await testOverviewRender();
	await testResponsiveReadability();
	await testMenu();

	console.log('\n结果：' + passed + ' passed, ' + failed + ' failed');

	process.exit(failed === 0 ? 0 : 1);
})().catch(function (err) {
	console.error('测试自身异常：', err && err.stack ? err.stack : err);
	process.exit(1);
});
