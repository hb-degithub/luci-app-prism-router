#!/usr/bin/env node
/*
 * LuCI 前端静态 / 轻量测试（无需路由器、不启动服务器）
 *
 * 覆盖：
 *   1. 七个 view 的 JS 语法：用 vm.Script 包一层函数解析，避免 LuCI 的
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
const VIEW_DIR = path.join(ROOT, 'luci-app-traffic-stats/htdocs/luci-static/resources/view/traffic-stats');
const VIEWS = [ 'overview', 'devices', 'apps', 'nodes', 'settings', 'mobile', 'panel' ];

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

function readView(name) {
	return fs.readFileSync(path.join(VIEW_DIR, name + '.js'), 'utf8');
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
			return {
				tag: tag,
				attrs: attrs || {},
				children: children,
				style: {},
				textContent: '',
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

	const children = root.children;

	if (typeof children === 'string') return children.indexOf(needle) >= 0;
	if (Array.isArray(children)) return children.some(function (child) { return containsText(child, needle); });

	return containsText(children, needle);
}

// ---------------------------------------------------------------- 1. 语法

async function testSyntax() {
	console.log('\n[1] 七个 view 的 JS 语法（vm.Script 包装后解析）');

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
		filename: 'traffic-stats-devices-2026-11-16.csv',
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
		devAnchor != null && devAnchor.download === 'traffic-stats-devices-2026-11-16.csv',
		devAnchor && devAnchor.download);

	const apps = loadView('apps');

	apps.env.__responses.export_csv = {
		ok: true,
		what: 'apps',
		filename: 'traffic-stats-apps-2026-11-16.csv',
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
		filename: 'traffic-stats-daily-2026-11-16.csv',
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
		/L\.resource\('traffic-stats\/'/.test(mobile) && /pwaAsset/.test(mobile));
	check('mobile 明确根部署回退',
		/\/luci-static\/resources\/traffic-stats\//.test(mobile));
}

// ---------------------------------------------------------------- 6b. 概览纯函数

async function testOverviewLogic() {
	console.log('\n[6b] 概览纯函数（昨日全天 / 在线 / health）');

	const source = readView('overview');
	const patched = source.replace(
		/\nreturn view\.extend\(\{/,
		'\nglobalThis.__tsTests = { yesterdayCompare: yesterdayCompare, shiftDayKey: shiftDayKey, onlineCount: onlineCount, healthLook: healthLook };\nreturn view.extend({'
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
	roLoaded.env.L.env = { acls: [ 'luci-app-traffic-stats' ] };
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
	adminLoaded.env.L.env = { acls: [ 'luci-app-traffic-stats', 'luci-app-traffic-stats-admin' ] };
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
	env.L.env = { trafficStatsCanManage: true };
	check('无 ACL 列表时用只读 RPC 的 can_manage 能力', tests.isAdmin() === true);
	env.L.env.trafficStatsCanManage = false;
	check('RPC 明确非管理员时隐藏写入口', tests.isAdmin() === false);

	env.L.env = { acls: [ 'luci-app-traffic-stats' ] };

	check('只读 ACL 组 → 非管理员', tests.isAdmin() === false);

	const ctxRead = { openEditDialog: function () {} };
	const readonlyTree = view.renderAliasContent.call(ctxRead,
		{ mac: 'AA:BB:CC:DD:EE:FF', alias: 'tv', group: '' });

	check('只读用户看到的别名格没有「编辑」按钮',
		containsText(readonlyTree, '编辑') === false);

	env.L.env = { acls: [ 'luci-app-traffic-stats', 'luci-app-traffic-stats-admin' ] };

	check('admin ACL 组 → 管理员', tests.isAdmin() === true);

	const adminTree = view.renderAliasContent.call(ctxRead,
		{ mac: 'AA:BB:CC:DD:EE:FF', alias: 'tv', group: '' });

	check('管理员看到的别名格有「编辑」按钮',
		containsText(adminTree, '编辑') === true);

	/* 直接调用编辑入口也要被 admin 闸门挡住（避免只靠按钮隐藏）。 */
	env.L.env = { acls: [ 'luci-app-traffic-stats' ] };

	const guardCtx = { dialog: null, drafts: {} };
	const beforeNotify = env.__notifications.length;

	view.openEditDialog.call(guardCtx, { mac: 'AA:BB:CC:DD:EE:FF', alias: 'tv', group: '' });

	check('只读用户直接调用编辑入口也被拒绝',
		guardCtx.dialog == null && env.__notifications.length === beforeNotify + 1,
		'notifications+' + (env.__notifications.length - beforeNotify));
}


async function testMenu() {
	console.log('\n[7] 菜单 JSON');

	const file = path.join(ROOT, 'luci-app-traffic-stats/root/usr/share/luci/menu.d/luci-app-traffic-stats.json');

	try {
		const menu = JSON.parse(fs.readFileSync(file, 'utf8'));

		check('menu.d JSON 可解析', menu != null && typeof menu === 'object');

		const paths = VIEWS.map(function (name) {
			return menu['admin/services/traffic-stats/' + name];
		});

		check('menu.d 含七个 view 路径',
			paths.every(function (item) { return item && item.action && item.action.type === 'view'; }));

		const root = menu['admin/services/traffic-stats'];
		const rootAcl = root && root.depends && root.depends.acl;

		check('根菜单保留 luci-app-traffic-stats 依赖',
			Array.isArray(rootAcl) && rootAcl.length === 1 && rootAcl[0] === 'luci-app-traffic-stats',
			JSON.stringify(rootAcl));

		const settings = menu['admin/services/traffic-stats/settings'];
		const settingsAcl = settings && settings.depends && settings.depends.acl;

		check('设置页子路由 depends.acl=luci-app-traffic-stats-admin',
			Array.isArray(settingsAcl) && settingsAcl.length === 1 &&
			settingsAcl[0] === 'luci-app-traffic-stats-admin',
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
	await testMenu();

	console.log('\n结果：' + passed + ' passed, ' + failed + ' failed');

	process.exit(failed === 0 ? 0 : 1);
})().catch(function (err) {
	console.error('测试自身异常：', err && err.stack ? err.stack : err);
	process.exit(1);
});
