'use strict';
'require view';
'require dom';
'require rpc';
'require uci';
'require ui';
'require prism-router/theme as theme';

/*
 * 棱镜路由 · 设置
 *
 * 读取走 uci.load()/uci.get()（只读），写入走 rpcd 的 set_config（后端按 section 白名单
 * 落 UCI 并 commit），重启走 rpcd 的 restart。前端不直接写 /etc/config，也不碰 shell。
 *
 * 本版补齐了「后端/UCI 已支持、但界面没有入口」的配置项：
 *   feishu   —— report_items（内容勾选）/ report_mode / report_time / report_weekday（时间）
 *               以及 alert_app_daily_limit / alert_spike_ratio / alert_offline_min /
 *               alert_cpu_pct / alert_mem_pct / alert_disk_pct / alert_quiet_hours（触发条件）
 *   retention —— 新增 section：enabled / daily_days / nodes_days / stations_days / log_days /
 *                log_max_kb / spool_max_kb / dry_run，外加「立即预览（dry-run）」
 *   settings —— system_enabled / wan_iface（系统指标采集）
 *   settings —— quota_mode / quota_monthly_gb / quota_total_gb（月配额，SPEC §10.2）：
 *               这三个键必须真的进 collect() 的 settings 对象并由 writeSection 提交；
 *               留空 = 不限制，模式 none 时不显示配额卡片。
 *   export   —— 「导出每日汇总 CSV」走 rpcd export_csv {what:'daily'}（SPEC §10.3）。
 *               metrics_enabled / metrics_token 目前没有界面入口，本页也不改它们，
 *               避免保存时把用户手写的 metrics 配置清掉（后端只写传入的键）。
 *
 * 飞书发送方式（本页新增，顶部单选）：
 *   feishu.mode = webhook —— 群自定义机器人，原有 webhook / secret 输入保持不变；
 *   feishu.mode = app     —— 自建应用机器人，填 App ID / App Secret 后「生成绑定二维码」：
 *       1. GET /cgi-bin/prism-router-feishu?action=start → {state, url}
 *          （CGI 只读 GET、凭证从 UCI 取：页面上的 App ID/Secret 与已保存值不一致时，
 *            先只把这两个键 set_config 保存一次；Secret 绝不进 URL / 二维码 / 日志）
 *       2. 用 uqr 把 url 画成 SVG 二维码（DOM 节点拼装，无外部图片、无 HTML 字符串赋值）
 *       3. 每 2 秒 GET ?action=status&state=<state>
 *          → {status:'pending'} / {status:'ready', chats:[{chat_id,name}]} / {status:'error', error}
 *          失效 state 走 HTTP 404（立即停表），其余网络错误连续 3 次才放弃
 *       4. ready 后选群 → set_config('feishu', {mode:'app', chat_id}) 落盘 → 显示已绑定 + 解除绑定
 *   超时 5 分钟停表；切标签页、切回 webhook、离开页面都会清定时器；错误文案统一脱敏
 *   （App Secret / token / Bearer 打码 + 截断）。
 *
 *   后端契约若还没上线（无 /cgi-bin/prism-router-feishu），这里只会显示可读错误，不影响
 *   页面其它功能；set_config 白名单还没有 mode 时该键被后端静默跳过，chat_id 仍会写入。
 *
 * 兼容与降级（页面绝不因为老后端/缺字段报错）：
 *   - 选项不存在 → 显示内置默认值，并在 label 旁标注「默认」；
 *   - 空值 → 默认不写（保持「未配置」语义）；但该 option 原本存在时写空串，用于把旧阈值关掉；
 *   - retention 段：当前 rpcd 的 set_config 白名单可能还没有 retention（返回 invalid section），
 *     此时只降级为「给出可复制的 uci 命令」提示，不影响 settings/feishu 已保存的结果；
 *   - retention dry-run：rpcd 方法可能还不存在（ACL 也可能没授权）。点击时尝试
 *     retention_dryrun / retention_dry_run 两个候选方法，都不可用就只给命令行提示，
 *     不弹错误通知、不影响页面其它功能。
 *
 * 页面加载仍然只有 2 次 rpc：uci get（整份配置）+ prism-router.status。
 */

var callStatus = rpc.declare({
	object: 'prism-router',
	method: 'status',
	expect: {}
});

var callSetConfig = rpc.declare({
	object: 'prism-router',
	method: 'set_config',
	params: [ 'section', 'options' ],
	expect: {}
});

var callTestFeishu = rpc.declare({
	object: 'prism-router',
	method: 'test_feishu',
	expect: {}
});

var callFeishuChats = rpc.declare({
	object: 'prism-router',
	method: 'feishu_chats',
	expect: {}
});

var callRestart = rpc.declare({
	object: 'prism-router',
	method: 'restart',
	expect: {}
});

/* CSV 导出（SPEC §10.3）：设置页只放“每日汇总”一种，设备/应用在各自页面导出。 */
var callExportCsv = rpc.declare({
	object: 'prism-router',
	method: 'export_csv',
	params: [ 'what' ],
	expect: {}
});

/*
 * retention dry-run：后端目前还没有这个 ubus 方法（ACL 里也没有），这里按最可能的名字
 * 先声明、点击时再尝试调用。调用失败属于「预期内的老后端」，只降级成命令行提示。
 */
var callRetentionDryRun = rpc.declare({
	object: 'prism-router',
	method: 'retention_dryrun',
	params: [ 'dry_run' ],
	expect: {}
});

var callRetentionDryRunAlt = rpc.declare({
	object: 'prism-router',
	method: 'retention_dry_run',
	params: [ 'dry_run' ],
	expect: {}
});

/* report_items 的可选区块；顺序与 feishu.uc 的 ITEMS_ALL 一致 */
var REPORT_ITEMS = [ 'overview', 'proxy_direct', 'wifi_wired', 'system', 'top_devices', 'top_apps', 'nodes' ];

var REPORT_ITEM_LABELS = {
	overview: _('概览（总量 / 在线设备 / 实时速率 + 近 24h 折线）'),
	proxy_direct: _('代理 vs 直连'),
	wifi_wired: _('无线 vs 有线'),
	system: _('系统指标（CPU / 内存 / 磁盘 / 温度）'),
	top_devices: _('Top 设备'),
	top_apps: _('Top 应用'),
	nodes: _('多节点流量')
};

var WEEKDAY_LABELS = [ _('周一'), _('周二'), _('周三'), _('周四'), _('周五'), _('周六'), _('周日') ];

var RETENTION_KEYS = [ 'enabled', 'daily_days', 'nodes_days', 'stations_days',
	'log_days', 'log_max_kb', 'spool_max_kb', 'dry_run' ];

/* 内置默认值：与 package 里的 /etc/config/prism-router、docs/SPEC.md §2/§9.2 对齐。
 * 只用于「配置里读不到这一项」时显示，不会在保存时强制写回（除非用户真的按了保存）。 */
var DEFAULTS = {
	settings: {
		enabled: '1',
		poll_interval: '5',
		clash_api: '127.0.0.1:9090',
		clash_secret: '',
		fake_ip_ranges: '198.18.0.0/16',
		history_days: '7',
		lan_bridge: 'br-lan',
		wireless_ports: '',
		ap_macs: '',
		link_refresh: '30',
		system_enabled: '1',
		wan_iface: '',
		/* 月配额（SPEC §10.2）：mode=none 时后两项不生效 */
		quota_mode: 'none',
		quota_monthly_gb: '',
		quota_total_gb: ''
	},
	feishu: {
		enabled: '0',
		/* 渠道模式：webhook = 群自定义机器人；app = 自建应用机器人（扫码绑定群） */
		mode: 'webhook',
		webhook: '',
		secret: '',
		app_id: '',
		app_secret: '',
		chat_id: '',
		daily_time: '08:30',
		report_chat_enabled: '1',
		/* 发什么 */
		report_items: 'overview,proxy_direct,wifi_wired,top_devices,top_apps',
		/* 什么时候发 */
		report_mode: 'daily',
		report_time: '08:30',
		report_weekday: '1',
		/* 什么情况下发（空 = 关闭） */
		alert_app_daily_limit: '',
		alert_spike_ratio: '',
		alert_offline_min: '',
		alert_cpu_pct: '',
		alert_mem_pct: '',
		alert_disk_pct: '',
		alert_quiet_hours: ''
	},
	retention: {
		enabled: '1',
		daily_days: '400',
		nodes_days: '30',
		stations_days: '7',
		log_days: '7',
		log_max_kb: '512',
		spool_max_kb: '2048',
		dry_run: '0'
	}
};

/* ---------------------------------------------------------------- 小工具 */

function rawValue(section, option) {
	var value = null;

	try {
		value = uci.get('prism-router', section, option);
	}
	catch (e) {
		value = null;
	}

	/* 与 UCI 的既有约定一致：空串等同「未设置」（uci commit 会删掉那一行）。 */
	if (value == null || value === '')
		return null;

	return '' + value;
}

function optionPresent(section, option) {
	var value = null;

	try {
		value = uci.get('prism-router', section, option);
	}
	catch (e) {
		value = null;
	}

	return (value != null);
}

function defaultOf(section, option) {
	var table = DEFAULTS[section];

	if (table == null || table[option] === undefined)
		return '';

	return table[option];
}

function valueOf(section, option) {
	var value = rawValue(section, option);

	return (value != null) ? value : defaultOf(section, option);
}

function isDefault(section, option) {
	return (rawValue(section, option) == null);
}

/* retention 段是否存在：任一选项存在即视为存在（老配置可能整段都没有） */
function retentionSectionPresent() {
	for (var i = 0; i < RETENTION_KEYS.length; i++) {
		if (optionPresent('retention', RETENTION_KEYS[i]))
			return true;
	}

	return false;
}

function isFlagValue(value) {
	var v = ('' + value).toLowerCase();

	return (v === '1' || v === 'true' || v === 'yes' || v === 'on');
}

/* 记账状态枚举（SPEC）：unavailable/degraded 绝不能显示成“健康/精确”。 */
function confidenceLabel(value) {
	var conf = str(value || 'unknown');

	if (conf === 'exact') return _('精确');
	if (conf === 'degraded') return _('降级');
	if (conf === 'unavailable') return _('不可用');

	return _('未知');
}

function str(value) {
	return (value == null) ? '' : ('' + value);
}

/* 清空节点用 DOM API，不写 HTML 字符串（设置页的群列表会重复填）。 */
function clearNode(node) {
	if (node == null) return;

	while (node.firstChild)
		node.removeChild(node.firstChild);
}

function isIntegerInRange(value, min, max) {
	var s = ('' + value).trim();

	if (!/^[0-9]+$/.test(s))
		return false;

	var n = parseInt(s, 10);

	return (n >= min && n <= max);
}

function isDecimalInRange(value, min, max) {
	var s = ('' + value).trim();

	if (!/^[0-9]+(\.[0-9]+)?$/.test(s))
		return false;

	var n = parseFloat(s);

	return (n >= min && n <= max);
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

/* "8:30" / "08:30" / "0830" -> "08:30"；非法返回 null */
function normHHMM(value) {
	var s = ('' + value).trim();
	var m = /^([0-9]{1,2}):([0-9]{1,2})$/.exec(s);

	if (m == null)
		m = /^([0-9]{2})([0-9]{2})$/.exec(s);

	if (m == null)
		return null;

	var h = parseInt(m[1], 10);
	var mi = parseInt(m[2], 10);

	if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59))
		return null;

	return pad2(h) + ':' + pad2(mi);
}

/* "23:00-07:00" / "12:00-13:30,23:00-07:00" -> 规范化；非法返回 null，空返回 '' */
function normQuietHours(value) {
	var s = ('' + value).trim();

	if (s === '')
		return '';

	var parts = s.split(',');
	var out = [];

	for (var i = 0; i < parts.length; i++) {
		var part = parts[i].trim();

		if (part === '')
			continue;

		var m = /^([0-9]{1,2}):([0-9]{2})-([0-9]{1,2}):([0-9]{2})$/.exec(part);

		if (m == null)
			return null;

		var from = normHHMM(m[1] + ':' + m[2]);
		var to = normHHMM(m[3] + ':' + m[4]);

		if (from == null || to == null || from === to)
			return null;

		out.push(from + '-' + to);
	}

	return out.length ? out.join(',') : '';
}

function parseReportItems(raw) {
	var value = str(raw).trim().toLowerCase();
	var tokens = value.length ? value.split(',') : [];
	var out = [];

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i].trim();

		if (token === '')
			continue;

		/* none / off / - / 0：显式「什么都不发」 */
		if (token === 'none' || token === 'off' || token === '-' || token === '0')
			return [];

		if (REPORT_ITEMS.indexOf(token) >= 0 && out.indexOf(token) < 0)
			out.push(token);
	}

	return out;
}

function isMissingMethodError(err) {
	var message = (err != null && err.message != null) ? ('' + err.message) : ('' + err);

	return /not\s*found|no\s+such|unknown\s+method|invalid\s+method|method.*missing|-32601|404/i.test(message);
}

/* ------------------------------------------------- 飞书应用机器人 · 扫码绑定
 *
 * 后端契约（由 prism-router-feishu CGI 提供，前端只按这个形状消费）：
 *   GET  /cgi-bin/prism-router-feishu?action=start      （凭证从 UCI 读，前端不传）
 *        -> { state, url }                       ; url 是飞书授权链接，渲染成二维码
 *   GET  /cgi-bin/prism-router-feishu?action=status&state=<state>
 *        -> { status: 'pending' }
 *        -> { status: 'ready', chats: [ {chat_id, name} ] }
 *        -> { status: 'error', error: '<文案>' }
 *
 * 两条硬规则：App Secret 只留在 /etc/config 与输入框里（不进 URL、不进二维码，
 * 也不出现在任何请求体）；state 只放在查询串里且一次性使用；轮询用相对路径，天然同源。
 */
var FEISHU_CGI = '/cgi-bin/prism-router-feishu';
var FEISHU_MODE_WEBHOOK = 'webhook';
var FEISHU_MODE_APP = 'app';
var FEISHU_MODE_USER = 'user';   /* 应用机器人 → 个人 open_id（无需群） */
var FEISHU_POLL_MS = 2000;                    /* 每 2 秒查一次绑定状态 */
var FEISHU_BIND_TIMEOUT_MS = 5 * 60 * 1000;   /* 二维码 5 分钟有效 */
var FEISHU_POLL_FAIL_MAX = 3;                 /* 连续三次网络失败才放弃 */
var FEISHU_REQUEST_TIMEOUT_MS = 15000;
var FEISHU_ERROR_MAX = 200;                   /* 错误文案截断，避免糊一屏 */
var SVG_NS = 'http://www.w3.org/2000/svg';

function escapeRegExp(text) {
	return ('' + text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* chat_id 展示脱敏：保留前缀和后 4 位，中间打点（oc_ab12…9f3c）。 */
function maskChatId(value) {
	var s = str(value);

	if (s.length === 0) return '';
	if (s.length <= 8) return s.substr(0, 3) + '…';

	return s.substr(0, 6) + '…' + s.substr(s.length - 4);
}

/* 错误脱敏：调用方传进来的密钥原文、常见 token 形态、Bearer 头一律打码，再截断。
 * 后端的原始报文可能把 app_secret / token 原样回显，这里不能直接 textContent 上去。 */
function redactFeishuError(message, secrets) {
	var text = (message != null && message.message != null) ? ('' + message.message) : str(message);
	var list = Array.isArray(secrets) ? secrets : [];
	var i;

	text = text.replace(/\s+/g, ' ').trim();

	for (i = 0; i < list.length; i++) {
		var secret = str(list[i]);

		if (secret.length < 4) continue;

		text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '***');
	}

	text = text.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***');
	/* Bearer 先打码，再按 key=value 打码；顺序反了会把 Bearer 这半截吃掉、token 留在后面。 */
	text = text.replace(
		/((?:app[_-]?secret|tenant[_-]?access[_-]?token|app[_-]?access[_-]?token|access[_-]?token|authorization|secret|token|passw[a-z]*)\s*["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi,
		'$1***');
	/* 长的疑似密钥串（>=32 位字母数字混合）也打码，避免未知字段泄露 */
	text = text.replace(/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[^\s]*[A-Za-z])(?=[^\s]*[0-9])[A-Za-z0-9_-]{32,}\b/g, '***');

	if (text.length > FEISHU_ERROR_MAX)
		text = text.substr(0, FEISHU_ERROR_MAX) + '…';

	return text;
}

/* uqr 返回的是 SVG 字符串：用 DOMParser 解析后 importNode，绝不把字符串当 HTML 赋值。
 * 只接受根节点是 <svg> 的文档；script / foreignObject 一律剥掉。 */
function importQrSvg(svgText) {
	var text = str(svgText);

	if (text === '') return null;

	var doc = null;

	try {
		if (typeof DOMParser == 'function')
			doc = new DOMParser().parseFromString(text, 'image/svg+xml');
	}
	catch (e) {
		doc = null;
	}

	var root = (doc != null) ? doc.documentElement : null;

	if (root == null || ('' + root.nodeName).toLowerCase() !== 'svg') return null;

	var node = null;

	try {
		node = document.importNode(root, true);
	}
	catch (e) {
		return null;
	}

	if (node == null) return null;

	try {
		var bad = node.querySelectorAll('script,foreignObject');

		for (var i = 0; i < bad.length; i++) {
			if (bad[i].parentNode != null) bad[i].parentNode.removeChild(bad[i]);
		}
	}
	catch (e) { }

	return node;
}

/* uqr 的 SVG 通常自带 viewBox；只给 width/height 时按像素补一个，CSS 拉满时才能等比缩放。 */
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
		/* 390px 手机上固定像素会溢出：宽 100%、高自动，容器负责最大宽度。 */
		svg.setAttribute('style', 'display:block;width:100%;height:auto');
	}
	catch (e) { }
}

/*
 * 设置页是写页面：menu.d 已给它 depends.acl=luci-app-prism-router-admin。
 * 这里再检查一次 L.env.acls，作为「老版本 dispatcher 仍放行」或手工打开 URL
 * 时的前端兜底。环境里没有 acls 时以 menu.d 的 depends 为准（返回 true），
 * 不把正常管理员误伤；走到了这个页面的无 admin 用户才会被禁用写控件。
 */
var ADMIN_ACL = 'luci-app-prism-router-admin';

function aclValues() {
	var env = (typeof L != 'undefined' && L != null) ? L.env : null;

	if (env == null || env.acls == null)
		return null;

	var a = env.acls;

	if (Array.isArray(a))
		return a.map(function(v) { return '' + v; });

	if (typeof a == 'string')
		return a.split(/[\s,]+/);

	if (typeof a == 'object') {
		var group = a['access-group'];

		if (Array.isArray(group))
			return group.map(function(v) { return '' + v; });

		if (group != null && typeof group == 'object')
			return Object.keys(group);

		return Object.keys(a);
	}

	return null;
}

function canManage() {
	var acls = aclValues();

	if (acls != null && acls.indexOf(ADMIN_ACL) < 0) return false;

	/* 后端动作目前仅 root 可执行；用 status 的能力位兼容未注入 acls 的 LuCI。 */
	if (typeof L != 'undefined' && L.env != null &&
		typeof L.env.prismRouterCanManage == 'boolean')
		return L.env.prismRouterCanManage;

	return acls != null;
}

return view.extend({
	load: function() {
		this.uciOk = true;
		this.status = null;
		this.loadError = null;
		/* 生命周期监听（beforeunload / visibilitychange）每次页面装载只绑一次：
		 * render() 可能被 LuCI 调多次，重复绑定会让旧闭包一直留在 window 上。 */
		this.feishuLifecycleBound = false;
		this.feishuUnloadFn = null;
		this.feishuVisibilityFn = null;

		var tasks = [
			uci.load('prism-router').catch(function(err) {
				this.uciOk = false;
				this.loadError = (err != null && err.message) ? err.message : '' + err;
			}.bind(this)),
			callStatus().then(function(status) {
				this.status = (status != null && typeof status == 'object') ? status : null;
				if (this.status != null && typeof this.status.can_manage == 'boolean')
					L.env.prismRouterCanManage = this.status.can_manage;
			}.bind(this)).catch(function() {
				this.status = null;
			}.bind(this))
		];

		return Promise.all(tasks);
	},

	render: function() {
		/* 重渲染前先把上一份视图的轮询停掉，避免旧实例在后台继续打 CGI。 */
		this.clearFeishuPollTimer();

		this.inputs = {};
		this.rows = {};
		this.radioInputs = {};
		this.itemInputs = {};
		this.itemOrder = [];
		this.writtenOptions = {};
		this.itemsHint = null;
		this.retentionHint = null;
		this.retentionOutput = null;
		this.dryRunStatus = null;
		this.reportTimeDirty = false;

		/* 飞书应用机器人 · 扫码绑定的运行时状态（只在内存里，不落 UCI） */
		this.feishuQrHost = null;
		this.feishuScanStatus = null;
		this.feishuScanBlock = null;
		this.feishuChatBox = null;
		this.feishuBoundNode = null;
		this.feishuBoundText = null;
		this.feishuBindBtn = null;
		this.feishuSaveBindBtn = null;
		this.feishuUnbindBtn = null;
		this.feishuChatRadios = [];
		this.feishuChats = [];
		this.feishuState = '';
		this.feishuPollTimer = null;
		this.feishuPollDeadline = 0;
		this.feishuPollFailures = 0;
		this.feishuPolling = false;
		this.feishuPaused = false;
		this.feishuStartSeq = 0;
		this.feishuBoundChat = null;

		var root = E('div', { 'id': 'ts-settings', 'class': theme.CLASS }, [
			theme.style(),
			E('h2', { 'class': 'ts-title' }, _('棱镜路由 · 设置')),
			/* 手机版 / 诊断的快捷入口；menu.d 旧路由保持可访问。 */
			E('p', { 'class': 'ts-muted ts-entry-links' }, [
				_('只读视图') + '：',
				E('a', { href: L.url('admin/services/prism-router/overview') }, _('概览')),
				' · ',
				E('a', { href: L.url('admin/services/prism-router/mobile') }, _('手机版')),
				' · ',
				E('a', { href: L.url('admin/services/prism-router/diagnostics') }, _('诊断中心'))
			]),
			this.renderStatusBanner(),
			this.uciOk ? '' : E('div', { 'class': 'alert-message error', style: 'padding:10px 14px;margin-bottom:16px' }, [
				E('strong', {}, _('读不到 UCI 配置：已禁用保存/重启（不会用默认值覆盖现有配置）')),
				E('p', {}, _('当前页面可能显示默认值（包括空密钥、空配额）。请检查 ACL 或 rpcd 后刷新页面，确认能读到配置再保存。')),
				this.loadError ? E('p', {}, E('code', {}, this.loadError)) : ''
			]),
			this.renderCaptureSection(),
			this.renderFeishuSection(),
			this.renderRetentionSection(),
			this.renderActions()
		]);

		this.root = root;

		return root;
	},

	// ------------------------------------------------------------ 状态横幅

	renderStatusBanner: function() {
		var status = this.status;
		var running = (status != null) && (status.running === true);
		var enabled = (status != null) ? (status.enabled !== false) : true;
		var conf = (status != null && status.confidence != null) ? ('' + status.confidence) : 'unknown';
		var look;

		/* 记账 unavailable/degraded 时横幅不能是健康绿；服务没跑则一律红。 */
		if (!running)
			look = { color: 'var(--ts-bad-text)', bg: 'rgba(220,38,38,.10)' };
		else if (conf === 'exact')
			look = { color: 'var(--ts-ok-text)', bg: 'rgba(22,163,74,.10)' };
		else if (conf === 'unavailable')
			look = { color: 'var(--ts-bad-text)', bg: 'rgba(220,38,38,.10)' };
		else
			look = { color: 'var(--ts-warn-text)', bg: 'rgba(217,119,6,.10)' };

		var bits = [];

		if (status != null) {
			bits.push(_('采集中') + ': ' + (enabled ? _('是') : _('否')));
			bits.push(_('服务运行') + ': ' + (running ? _('是') : _('否')));
			bits.push(_('记账状态') + ': ' + confidenceLabel(status.confidence));

			if (status.sources != null) {
				bits.push('clash=' + (status.sources.clash || '?'));
				bits.push('conntrack=' + (status.sources.conntrack || '?'));
			}

			if (status.link_source != null) {
				var ports = Array.isArray(status.link_ports) ? status.link_ports : [];

				bits.push(_('接入判定') + ': ' + ((status.link_source == 'brctl')
					? ('brctl' + (ports.length ? ' (' + ports.join(',') + ')' : ''))
					: _('不可用')));
			}

			if (status.version)
				bits.push('v' + status.version);
		}
		else {
			bits.push(_('读不到服务状态（rpcd 对象 prism-router 不可用或未安装后端）'));
		}

		this.statusNode = E('span', { style: 'font-size:12px;opacity:.85' }, bits.join(' · '));

		return E('div', {
			style: 'padding:10px 14px;margin-bottom:16px;border-left:4px solid ' + look.color +
				';border-radius:6px;background:' + look.bg
		}, [
			E('strong', { style: 'color:' + look.color }, running
				? (conf === 'exact' ? _('服务运行中') : _('服务运行中（记账降级）'))
				: _('服务未运行')),
			' ',
			this.statusNode
		]);
	},

	// ------------------------------------------------------------ 表单

	/* 「配置里没有这一项，显示的是内置默认值」的角标 */
	defaultBadge: function() {
		return E('span', {
			'title': _('配置里没有这一项（或为空），当前显示的是内置默认值'),
			'style': 'display:inline-block;margin-left:8px;padding:0 6px;border-radius:8px;' +
				'font-size:11px;font-weight:400;line-height:1.7;vertical-align:middle;' +
				'background:rgba(127,127,127,.18);opacity:.85'
		}, _('默认'));
	},

	/* 小节标题；first=false 时上面补一条分隔线 */
	subhead: function(title, first) {
		return E('h4', {
			'style': 'margin:' + (first ? '4px' : '20px') + ' 0 6px;font-size:13px;font-weight:600;' +
				'opacity:.9;' +
				(first ? '' : 'padding-top:14px;border-top:1px solid rgba(127,127,127,.22);')
		}, title);
	},

	/*
	 * 单个配置项。type: bool / password / number / text / select。
	 * extra: { value, defaulted, placeholder, wide, inputmode, min, max, step, options }
	 * 传 extra.value 可覆盖「从 UCI 读」的结果（例如 report_time 需要回落到 daily_time）。
	 */
	field: function(section, key, label, desc, type, extra) {
		var id = 'ts-' + section + '-' + key;
		var opts = extra || {};
		var raw = rawValue(section, key);
		var value;
		var defaulted;
		var input;

		if (opts.value !== undefined) {
			value = '' + opts.value;
			defaulted = (opts.defaulted === true);
		}
		else {
			value = (raw != null) ? raw : defaultOf(section, key);
			defaulted = (raw == null);
		}

		if (type == 'bool') {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-checkbox',
				'type': 'checkbox'
			});

			input.checked = isFlagValue(value);
		}
		else if (type == 'password') {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-text',
				'type': 'password',
				'autocomplete': 'new-password'
			});

			input.value = value;
		}
		else if (type == 'number') {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-text',
				'type': 'number',
				'style': 'width:12em'
			});

			input.value = value;

			if (opts.min != null) input.setAttribute('min', '' + opts.min);
			if (opts.max != null) input.setAttribute('max', '' + opts.max);
			if (opts.step != null) input.setAttribute('step', '' + opts.step);
		}
		else if (type == 'select') {
			var choices = opts.options || [];
			var allowed = choices.map(function(choice) { return '' + choice[0]; });
			var selected = (allowed.indexOf(value) >= 0) ? value : (allowed.length ? allowed[0] : '');

			if (allowed.length && selected !== value)
				defaulted = true;

			input = E('select', {
				'id': id,
				'class': 'cbi-input-select',
				'style': 'min-width:9em'
			}, choices.map(function(choice) {
				return E('option', { 'value': '' + choice[0] }, choice[1]);
			}));

			input.value = selected;
		}
		else {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-text',
				'type': 'text',
				'style': opts.wide ? 'width:100%;max-width:32em' : 'width:16em'
			});

			if (opts.inputmode != null) input.setAttribute('inputmode', opts.inputmode);

			input.value = value;
		}

		if (opts.placeholder != null)
			input.setAttribute('placeholder', opts.placeholder);

		this.inputs[section + '.' + key] = input;

		var title = E('label', { 'class': 'cbi-value-title', 'for': id }, [
			label,
			defaulted ? this.defaultBadge() : ''
		]);

		var row;

		if (type == 'bool') {
			row = E('div', { 'class': 'cbi-value' }, [
				title,
				E('div', { 'class': 'cbi-value-field' }, [
					E('label', { 'for': id }, [
						input,
						' ',
						desc ? E('span', { 'class': 'cbi-value-description' }, desc) : ''
					])
				])
			]);
		}
		else {
			row = E('div', { 'class': 'cbi-value' }, [
				title,
				E('div', { 'class': 'cbi-value-field' }, [
					input,
					desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
				])
			]);
		}

		this.rows[section + '.' + key] = row;

		return row;
	},

	/* 单选组（report_mode 用）：选项值即 UCI 里要写的字符串 */
	radioField: function(section, key, label, desc, choices) {
		var self = this;
		var id = 'ts-' + section + '-' + key;
		var current = valueOf(section, key);
		var allowed = choices.map(function(choice) { return '' + choice[0]; });
		var matched = (allowed.indexOf(current) >= 0);
		var selected = matched ? current : (allowed.length ? allowed[0] : '');
		var inputs = [];

		var nodes = choices.map(function(choice) {
			var radio = E('input', {
				'id': id + '-' + choice[0],
				'name': id,
				'type': 'radio',
				'class': 'cbi-input-radio',
				'value': '' + choice[0],
				'change': function() {
					self.updateConditionalFields();
				}
			});

			radio.checked = ('' + choice[0] === selected);
			inputs.push(radio);

			return E('label', {
				'for': id + '-' + choice[0],
				'style': 'display:inline-block;margin-right:18px;white-space:nowrap'
			}, [ radio, ' ', choice[1] ]);
		});

		this.radioInputs[section + '.' + key] = inputs;

		var row = E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, [
				label,
				(isDefault(section, key) || !matched) ? this.defaultBadge() : ''
			]),
			E('div', { 'class': 'cbi-value-field' }, [
				E('div', {}, nodes),
				desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
			])
		]);

		this.rows[section + '.' + key] = row;

		return row;
	},

	renderCaptureSection: function() {
		var self = this;
		var defs = [
			[ 'settings', 'enabled', _('启用采集'), _('关闭后守护进程不采集，仅保留已有数据。'), 'bool', null ],
			[ 'settings', 'poll_interval', _('轮询间隔（秒）'), _('1–3600，默认 5。越小越实时，开销也越大。'), 'number', null ],
			[ 'settings', 'clash_api', _('Clash API 地址'), _('mihomo / OpenClash 的 external-controller，例如 127.0.0.1:9090。'), 'text', null ],
			[ 'settings', 'clash_secret', _('Clash secret'), _('留空 = 自动读取 OpenClash 的 dashboard 密码。'), 'password', { placeholder: _('留空自动获取') } ],
			[ 'settings', 'fake_ip_ranges', _('fake-ip 网段'), _('逗号分隔；命中这些网段的 conntrack 流不计入直连，避免与代理重复计数。'), 'text', { wide: true } ],
			[ 'settings', 'history_days', _('历史保留天数'), _('1–90，默认 7。'), 'number', null ],
			[ 'settings', 'lan_bridge', _('LAN 网桥'), _('brctl showmacs 的目标网桥；x86 多网卡桥接一般是 br-lan。'), 'text', { placeholder: 'br-lan' } ],
			[ 'settings', 'wireless_ports', _('无线上联端口'), _('桥端口号，逗号分隔（例如 3 或 3,5）：AP 上联的那个口上的 MAC 记为无线。留空 = 不区分。'), 'text', { placeholder: '3' } ],
			[ 'settings', 'ap_macs', _('AP 的 LAN MAC'), _('逗号分隔。配了它就用 FDB 反查 AP 上联端口，优先于「无线上联端口」。'), 'text', { wide: true, placeholder: '00:58:28:d7:63:60' } ],
			[ 'settings', 'link_refresh', _('接入方式刷新间隔（秒）'), _('重新读取 FDB 的间隔，默认 30。'), 'number', null ]
		];

		var fields = defs.map(function(def) {
			return self.field(def[0], def[1], def[2], def[3], def[4], def[5]);
		});

		fields.push(this.subhead(_('系统指标（软路由自身，与棱镜路由隔离）'), false));
		fields.push(this.field('settings', 'system_enabled', _('采集系统指标'),
			_('CPU / 内存 / 负载 / 磁盘 / 温度 / WAN 速率，写入 state.json 的 system 段；关闭后整段不出现。'),
			'bool', null));
		fields.push(this.field('settings', 'wan_iface', _('WAN 接口'),
			_('用于计算 WAN 上下行速率，例如 eth3 / pppoe-wan。留空 = 自动取默认路由所在接口。'),
			'text', { placeholder: _('留空 = 自动') }));

		/* ---- 月配额（SPEC §10.2）：get_state 的 month_* / quota 段只读展示在设备页 ---- */
		fields.push(this.subhead(_('月配额'), false));
		fields.push(E('div', { 'class': 'cbi-value-description', style: 'margin:0 0 6px 0' },
			_('按自然月统计（1 号至今）。关闭 = 不做任何限制；设备模式对所有设备使用同一月配额；全屋模式只算总用量。')));
		fields.push(this.field('settings', 'quota_mode', _('配额模式'),
			_('none = 关闭；device = 每台设备同一月配额；total = 全屋月度总配额。'),
			'select', { options: [
				[ 'none', _('关闭') ],
				[ 'device', _('每台设备') ],
				[ 'total', _('全屋合计') ]
			] }));
		fields.push(this.field('settings', 'quota_monthly_gb', _('单设备月配额（GB）'),
			_('可带小数，例如 50 / 0.5；留空 = 单设备不限制。仅「每台设备」模式使用。'),
			'number', { min: 0, step: '0.01', placeholder: _('留空 = 不限制') }));
		fields.push(this.field('settings', 'quota_total_gb', _('全屋月配额（GB）'),
			_('可带小数；留空 = 不限制。仅「全屋合计」模式使用。'),
			'number', { min: 0, step: '0.01', placeholder: _('留空 = 不限制') }));

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('采集设置')),
			E('div', { 'class': 'cbi-section-node' }, fields)
		]);
	},

	renderFeishuSection: function() {
		var self = this;

		/* 写操作统一闸门：读不到 UCI 或没有 admin ACL 时，所有会落盘的按钮都禁用。
		 * （下面的扫码绑定按钮也用它，保持与「测试发送 / 列出机器人所在的群」一致。） */
		var writeDisabled = ((!canManage()) || this.uciOk !== true) ? true : null;

		var channelFields = [
			[ 'feishu', 'enabled', _('启用飞书报表'), _('开启后按下面的「时间」推送日报/周报；测试发送不受这里影响。'), 'bool', null ],
			[ 'feishu', 'app_id', _('App ID（扫码加群的自建应用）'), _('飞书开放平台 → 自建应用 → 凭证与基础信息。填了 App ID/Secret 就优先走应用 API，不再用 webhook。'), 'text', { wide: true, placeholder: 'cli_xxxxx' } ],
			[ 'feishu', 'app_secret', _('App Secret'), _('与 App ID 配套；仅保存在本机 /etc/config/prism-router。'), 'password', null ],
			[ 'feishu', 'chat_id', _('群 chat_id'), _('点下方「列出机器人所在的群」自动获取；形如 oc_xxxxx。'), 'text', { wide: true, placeholder: 'oc_xxxxx' } ],
			[ 'feishu', 'receive_id', _('接收人（个人通知，无需群）'), _('推荐填飞书 user_id（管理后台 → 成员详情可复制），也可填 ou_ 开头的 open_id 或邮箱；都不需要回调地址。应用可用范围必须包含这个账号。'), 'text', { wide: true, placeholder: 'user_id / ou_xxxxx / 邮箱' } ],
			[ 'feishu', 'report_chat_enabled', _('群聊报表'), _('关掉后只推送给私聊/其它通道（按后端实现）。'), 'bool', null ]
		];

		/* 发送方式在最上面：webhook（自定义机器人）/ app（应用机器人 · 扫码绑定） */
		var fields = [ this.feishuModeField() ];

		channelFields.forEach(function(def) {
			fields.push(self.field(def[0], def[1], def[2], def[3], def[4], def[5]));
		});

		/* ---- 内容（report_items）---- */
		fields.push(this.subhead(_('内容'), false));
		fields.push(this.reportItemsField());

		/* ---- 时间（report_mode / report_time / report_weekday）---- */
		var reportTimeRaw = rawValue('feishu', 'report_time');
		var legacyTimeRaw = rawValue('feishu', 'daily_time');
		var reportTime = (reportTimeRaw != null) ? reportTimeRaw : ((legacyTimeRaw != null) ? legacyTimeRaw : DEFAULTS.feishu.report_time);
		/* 只有 report_time 与 daily_time 都没有时才标「默认」；沿用 daily_time 属于老配置的有效值。 */
		var reportTimeDefaulted = (reportTimeRaw == null && legacyTimeRaw == null);

		fields.push(this.subhead(_('时间'), false));
		fields.push(this.radioField('feishu', 'report_mode', _('报表模式'),
			_('每天 = 每天按时间发日报；每周 = 只在所选星期发；每天 + 每周 = 每天都发，那天算周报（标题不同，仍只发一条）。'),
			[ [ 'daily', _('每天') ], [ 'weekly', _('每周') ], [ 'both', _('每天 + 每周') ] ]));
		fields.push(this.field('feishu', 'report_time', _('报表时间'),
			_('24 小时制 HH:MM，例如 08:30。留空时回落到下面的旧字段 daily_time，再缺省为 08:30。'),
			'text', { placeholder: '08:30', value: reportTime, defaulted: reportTimeDefaulted }));

		/* 老配置可能只有 daily_time、没有 report_time：只要用户没动这个框，就继续不写
		   report_time，保持「daily_time 兜底」的语义；一旦编辑过才落盘成显式值。 */
		var reportTimeInput = this.inputs['feishu.report_time'];

		this.reportTimeInitial = reportTime;

		if (reportTimeInput != null) {
			var markReportTimeDirty = function() { self.reportTimeDirty = true; };

			reportTimeInput.addEventListener('input', markReportTimeDirty);
			reportTimeInput.addEventListener('change', markReportTimeDirty);
		}

		fields.push(this.field('feishu', 'report_weekday', _('周报星期'),
			_('1 = 周一 … 7 = 周日；只有「每周 / 每天 + 每周」模式使用。'),
			'select', { options: WEEKDAY_LABELS.map(function(label, index) {
				return [ '' + (index + 1), label ];
			}) }));
		fields.push(this.field('feishu', 'daily_time', _('旧字段 daily_time（兜底）'),
			_('仅供老配置兼容：report_time 未设置时才用这个时间。保留是为了不做破坏性迁移。'),
			'text', { placeholder: '08:30' }));

		/* ---- 触发条件（留空 = 关闭）---- */
		fields.push(this.subhead(_('触发条件'), false));
		fields.push(E('div', { 'class': 'cbi-value-description', style: 'margin:0 0 6px 0' },
			_('以下阈值全部留空 = 关闭对应告警；这些告警由 feishu.uc alerts 扫描触发，需要你自己加 cron。')));
		fields.push(this.field('feishu', 'alert_app_daily_limit', _('单应用日流量阈值'),
			_('单个域名/应用当天 rx+tx 达到即告警。示例：20G / 512M（纯数字按 GB 计）；留空 = 关闭。'),
			'text', { placeholder: '20G' }));
		fields.push(this.field('feishu', 'alert_spike_ratio', _('突增倍数'),
			_('当前小时 ≥ 近 7 日均值 × N 时告警，必须 > 1。示例：3；留空 = 关闭。'),
			'text', { placeholder: '3', inputmode: 'decimal' }));
		fields.push(this.field('feishu', 'alert_offline_min', _('离线分钟阈值'),
			_('设备最后在线超过 N 分钟告警（1–10080，最多 7 天）。示例：30；留空 = 关闭。'),
			'number', { min: 1, max: 10080, placeholder: '30' }));
		fields.push(this.field('feishu', 'alert_cpu_pct', _('CPU 使用率阈值（%）'),
			_('系统指标 cpu_pct ≥ 该值告警，0–100。示例：85；留空 = 关闭（需要先启用系统指标采集）。'),
			'text', { placeholder: '85', inputmode: 'decimal' }));
		fields.push(this.field('feishu', 'alert_mem_pct', _('内存使用率阈值（%）'),
			_('系统指标 mem_pct ≥ 该值告警，0–100。示例：90；留空 = 关闭。'),
			'text', { placeholder: '90', inputmode: 'decimal' }));
		fields.push(this.field('feishu', 'alert_disk_pct', _('磁盘使用率阈值（%）'),
			_('系统指标 disk_pct ≥ 该值告警，0–100。示例：90；留空 = 关闭。'),
			'text', { placeholder: '90', inputmode: 'decimal' }));
		fields.push(this.field('feishu', 'alert_quiet_hours', _('免打扰时段'),
			_('只抑制告警、不影响报表；格式 HH:MM-HH:MM，可逗号分隔多段，支持跨零点。示例：23:00-07:00,12:00-13:00；留空 = 关闭。'),
			'text', { wide: true, placeholder: '23:00-07:00' }));

		/* ---- 应用机器人 · 扫码绑定（只有「应用机器人」模式显示）---- */
		fields.push(this.feishuScanField(writeDisabled));

		this.testNode = E('span', { style: 'font-size:12px;opacity:.85' }, '');
		this.chatNode = E('div', { style: 'font-size:12px;margin-top:8px' }, '');

		var section = E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('飞书报表')),
			E('div', { 'class': 'cbi-section-node' }, fields),
			E('div', { 'class': 'cbi-section-actions', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, this.testFeishu),
					'disabled': writeDisabled
				}, _('测试发送')),
				E('button', {
					'class': 'cbi-button',
					'click': ui.createHandlerFn(this, this.listFeishuChats),
					'disabled': writeDisabled
				}, _('列出机器人所在的群')),
				this.testNode
			]),
			this.chatNode
		]);

		/* report_weekday 只在 weekly / both 时显示（radio 的 change 也会再调一次） */
		this.updateConditionalFields();

		/* beforeunload / visibilitychange 只绑一次，切标签或离开页面时清掉轮询定时器 */
		this.bindFeishuLifecycle();

		return section;
	},

	/* 发送方式切换：webhook（自定义机器人，保持原样）/ app（自建应用机器人，扫码绑定）。 */
	feishuModeField: function() {
		/* 只保留“应用凭证”一种接入方式：要么绑定群，要么直接发个人；
		   不再提供 webhook（群自定义机器人）。 */
		var choices = [ [ FEISHU_MODE_APP, _('绑定群（扫码）') ],
		                [ FEISHU_MODE_USER, _('发给个人（无需群）') ] ];

		/* mode 未设置时后端沿用旧行为：app_id/app_secret/chat_id 齐全走应用。
		   这里把 app 放到首位，让界面选中项与真实发送路线一致，避免误导。 */
		if (rawValue('feishu', 'mode') == null &&
		    rawValue('feishu', 'app_id') && rawValue('feishu', 'app_secret') &&
		    rawValue('feishu', 'chat_id'))
			choices = [ choices[1], choices[0] ];

		var row = this.radioField('feishu', 'mode', _('发送方式'),
			_('两种都只需要飞书自建应用的 App ID / App Secret。绑定群 = 扫码把机器人所在的群选出来；发给个人 = 直接填你的飞书邮箱，不需要建群。'),
			choices);

		row.setAttribute('id', 'ts-feishu-mode-row');

		return row;
	},

	/* 绑定前置条件：飞书开放平台的配置项缺一不可，直接显示可复制的回调地址，
	 * 避免用户只填了 App ID/Secret 却因没配重定向 URL / 没开权限而反复失败。 */
	feishuPrereqNode: function() {
		var redirect = '';

		try {
			var forced = str(rawValue('feishu', 'redirect_base')).trim();

			redirect = (forced !== '' ? forced.replace(/\/+$/, '')
				: (window.location.protocol + '//' + window.location.host)) +
				'/cgi-bin/prism-router-feishu?action=callback';
		}
		catch (e) { redirect = ''; }

		var savedId = str(rawValue('feishu', 'app_id'));

		var codeStyle = 'display:inline-block;max-width:100%;padding:2px 6px;border-radius:4px;' +
			'background:rgba(127,127,127,.12);font-size:12px;word-break:break-all;user-select:all';

		return E('div', {
			'class': 'cbi-value-description',
			'style': 'margin:0;padding:10px 12px;border:1px solid rgba(127,127,127,.28);' +
				'border-radius:6px;max-width:100%;min-width:0;line-height:1.65'
		}, [
			E('div', {}, E('strong', {}, _('绑定前必须完成（缺一不可）'))),
			E('ol', { 'style': 'margin:6px 0 0 18px;padding:0' }, [
				E('li', {}, _('开放平台创建「自建应用」，并开启「机器人」能力。')),
				E('li', {}, _('「权限管理」添加 im:chat:readonly，然后创建版本并发布（企业自建应用还需管理员审批）。')),
				E('li', {}, [
					_('「安全设置 → 重定向 URL」原样添加（含 ?action=callback）：'),
					E('br'),
					E('code', { 'style': codeStyle }, redirect || _('（无法读取当前地址，请用浏览器访问本页）')),
					redirect ? E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'style': 'margin-left:6px',
						'click': function(ev) {
							ev.preventDefault();
							try {
								if (navigator.clipboard) navigator.clipboard.writeText(redirect);
							} catch (e) { }
						}
					}, _('复制')) : '',
					E('br'),
					E('span', { style: 'opacity:.8' }, _('若飞书报 20029：这里显示的值必须与后台一条不差（协议、域名、端口、查询串）。'))
				]),
				E('li', {}, _('在本页填写 App ID / App Secret；点「生成绑定二维码」时会自动保存到本机。')),
				E('li', {}, _('先在飞书群里添加这个机器人，再生成二维码；群列表只显示机器人已加入的群。'))
			]),
			E('div', { 'style': 'margin-top:6px' }, savedId
				? _('已保存 App ID：') + savedId
				: _('当前还没有保存 App ID / App Secret。')),
			E('div', { 'style': 'margin-top:4px;opacity:.8' },
				_('授权页会申请 im:chat:readonly；若应用未开通该权限，飞书会直接报 20027。群列表用机器人身份获取，不包含机器人未加入的群。'))
		]);
	},

	/* 扫码绑定区块：二维码 + 轮询状态 + 群列表 + 已绑定提示。
	 * 只在 mode=app 时显示（syncFeishuMode 负责）；全部单列布局，390px 不横向溢出。 */
	feishuScanField: function(writeDisabled) {
		var self = this;

		this.feishuQrHost = E('div', {
			'id': 'ts-feishu-qr',
			'data-qr': '',
			'style': 'display:none;width:180px;max-width:100%;box-sizing:border-box;' +
				'padding:8px;border-radius:8px;background:#fff;border:1px solid rgba(127,127,127,.28);' +
				'flex-direction:column;align-items:center;justify-content:center;overflow:hidden'
		}, '');

		this.feishuScanStatus = E('div', {
			'id': 'ts-feishu-scan-status',
			'style': 'font-size:12px;line-height:1.55;max-width:100%;word-break:break-word;overflow-wrap:anywhere'
		}, '');

		this.feishuChatBox = E('div', {
			'id': 'ts-feishu-chats',
			'style': 'display:none;max-width:100%;min-width:0'
		}, '');

		this.feishuBoundText = E('span', { style: 'font-size:12px;line-height:1.6;word-break:break-word' }, '');

		this.feishuUnbindBtn = E('button', {
			'id': 'ts-feishu-btn-unbind',
			'class': 'cbi-button cbi-button-reset',
			'click': ui.createHandlerFn(this, this.unbindFeishu),
			'disabled': writeDisabled
		}, _('解除绑定'));

		this.feishuBoundNode = E('div', {
			'id': 'ts-feishu-bound',
			'style': 'display:none;max-width:100%;align-items:center;gap:10px;flex-wrap:wrap;' +
				'padding:8px 10px;border-radius:6px;background:rgba(22,163,74,.10)'
		}, [
			this.feishuBoundText,
			this.feishuUnbindBtn
		]);

		this.feishuBindBtn = E('button', {
			'id': 'ts-feishu-btn-bind',
			'class': 'cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, this.startFeishuBind),
			'disabled': writeDisabled
		}, _('生成绑定二维码'));

		this.feishuSaveBindBtn = E('button', {
			'id': 'ts-feishu-btn-savebind',
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, this.saveFeishuBinding),
			'disabled': writeDisabled
		}, _('保存绑定'));

		this.feishuScanBlock = E('div', {
			'id': 'ts-feishu-scan-block',
			'style': 'display:none;margin:0;max-width:100%;min-width:0'
		}, [
			this.subhead(_('飞书应用机器人 · 扫码绑定'), false),
			this.feishuPrereqNode(),
			E('div', {
				'style': 'display:grid;grid-template-columns:minmax(0,1fr);gap:10px;' +
					'max-width:100%;min-width:0;box-sizing:border-box'
			}, [
				E('div', { 'class': 'cbi-value-description', style: 'margin:0;max-width:100%' },
					_('用手机飞书扫描下面的二维码，把自建应用机器人拉进要接收报表的群；授权完成后本页会列出群供你选择。')),
				E('div', { 'class': 'cbi-value-description', style: 'margin:0;max-width:100%' },
					_('App ID / App Secret 只保存在本机配置里（扫码接口从本机读取，不进 URL、不进二维码），二维码 5 分钟内有效。')),
				E('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:100%' }, [
					this.feishuBindBtn
				]),
				this.feishuQrHost,
				this.feishuScanStatus,
				this.feishuChatBox,
				this.feishuBoundNode
			])
		]);

		return this.feishuScanBlock;
	},

	/* 内容多选：七个区块；全不勾 → 保存 none（空串会回落到默认内容，语义不同） */
	reportItemsField: function() {
		var self = this;
		var id = 'ts-feishu-report_items';
		var raw = rawValue('feishu', 'report_items');
		var defaulted = (raw == null);
		var selected = parseReportItems(defaulted ? DEFAULTS.feishu.report_items : raw);

		this.itemOrder = selected.slice();
		this.itemInputs = {};

		var boxes = REPORT_ITEMS.map(function(name) {
			var input = E('input', {
				'id': id + '-' + name,
				'class': 'cbi-input-checkbox',
				'type': 'checkbox',
				'change': function() {
					self.updateItemsHint();
				}
			});

			input.checked = (selected.indexOf(name) >= 0);
			self.itemInputs[name] = input;

			return E('label', {
				'for': id + '-' + name,
				'style': 'display:inline-block;min-width:16em;margin:3px 12px 3px 0'
			}, [ input, ' ', REPORT_ITEM_LABELS[name] ]);
		});

		this.itemsHint = E('div', { style: 'font-size:12px;margin-top:4px;opacity:.75' }, '');
		this.updateItemsHint();

		var row = E('div', { 'class': 'cbi-value' }, [
			E('div', { 'class': 'cbi-value-title' }, [
				_('报表内容'),
				defaulted ? this.defaultBadge() : ''
			]),
			E('div', { 'class': 'cbi-value-field' }, [
				E('div', {}, boxes),
				E('div', { 'class': 'cbi-value-description', style: 'margin-top:4px' },
					_('全部不勾选时保存 none（表示真的什么都不发）；整项留空才会回落到默认内容。')),
				this.itemsHint
			])
		]);

		this.rows['feishu.report_items'] = row;

		return row;
	},

	renderRetentionSection: function() {
		var self = this;
		var defs = [
			[ 'retention', 'enabled', _('启用清理任务'), _('关闭后 retention.uc 什么都不删、不截断（等于回到旧行为）。定时触发仍需自己加 cron。'), 'bool', null ],
			[ 'retention', 'daily_days', _('每日汇总保留（天）'), _('/etc/prism-router/daily/*.json；0–36500，0 = 关闭该目录的按天清理。默认 400。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'nodes_days', _('子节点快照保留（天）'), _('/etc/prism-router/nodes/*.json / *.jsonl；0–36500，0 = 关闭。默认 30。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'stations_days', _('AP 站点快照保留（天）'), _('/etc/prism-router/stations/*.json；0–36500，0 = 关闭。默认 7。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'log_days', _('日志保留（天）'), _('/tmp/prism-router/*.log；0–36500，0 = 关闭按天清理。默认 7。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'log_max_kb', _('单个日志上限（KB）'), _('超过就截断为尾部一半；0–16777216，0 = 关闭截断。默认 512。'), 'number', { min: 0, max: 16777216 } ],
			[ 'retention', 'spool_max_kb', _('飞书队列上限（KB）'), _('feishu-queue 总量上限，超了从最旧开始删；0–16777216，0 = 关闭。默认 2048。'), 'number', { min: 0, max: 16777216 } ],
			[ 'retention', 'dry_run', _('dry-run（仅预览）'), _('打开后 retention.uc 只打印将要删除/截断的清单，不动任何文件。首次启用建议先打开看一眼。'), 'bool', null ]
		];

		var fields = defs.map(function(def) {
			return self.field(def[0], def[1], def[2], def[3], def[4], def[5]);
		});

		this.dryRunStatus = E('span', { style: 'font-size:12px;opacity:.85' }, '');
		this.retentionHint = E('div', { style: 'font-size:12px;margin-top:8px;color:#ef6c00;white-space:pre-wrap;display:none' }, '');
		this.retentionOutput = E('pre', {
			'id': 'ts-retention-output',
			'style': 'display:none;margin:8px 0 0 0;padding:8px 10px;border-radius:6px;' +
				'background:rgba(127,127,127,.12);max-height:260px;overflow:auto;' +
				'white-space:pre-wrap;word-break:break-all;font-size:12px'
		}, '');

		/* 记住初始值：老后端的 set_config 还不接受 retention 段时，只有用户真的改过
		   才提示「未写入」；没改就静默跳过，避免每次保存都弹一条没有意义的警告。 */
		this.retentionBaseline = JSON.stringify(this.collectRetentionValues());

		/* 老配置（conffile 未被覆盖）里可能整段没有 retention：按 SPEC §9.8，
		   「只装脚本不配段」应保持老行为，所以本页不主动创建这个段——用户真的改了
		   任意一项才写入。这里给一句说明，避免用户以为改了立即生效。 */
		this.retentionExists = retentionSectionPresent();

		var notes = [
			E('div', { 'class': 'cbi-value-description' },
				_('清理范围是硬编码白名单（daily / nodes / stations / 日志 / 飞书队列），本段只改天数和大小，没有路径项。')),
			E('div', { 'class': 'cbi-value-description' },
				_('定时触发由你自己的 cron 负责（本页不改 crontab），例如：30 3 * * * /usr/bin/ucode /usr/share/prism-router/retention.uc >/dev/null 2>&1')),
			E('div', { 'class': 'cbi-value-description' },
				_('注意：上面的「立即预览」读取的是已保存的 UCI 配置，改了输入请先保存。'))
		];

		if (!this.retentionExists) {
			notes.push(E('div', { 'class': 'cbi-value-description', style: 'color:#ef6c00;margin-top:4px' },
				_('提示（不影响保存）：当前还没有 retention 段；改动任意一项再保存会创建它，之后 daily 清理由 retention.uc 接管（记得加 cron）。')));
		}

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('保留策略')),
			E('div', { 'class': 'cbi-section-node' }, fields),
			E('div', { 'class': 'cbi-section-node', style: 'padding:4px 0 0 0' }, notes),
			E('div', { 'class': 'cbi-section-actions', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
				E('button', {
					'id': 'ts-retention-dryrun',
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, this.runRetentionDryRun)
				}, _('立即预览（dry-run）')),
				this.dryRunStatus
			]),
			this.retentionHint,
			this.retentionOutput
		]);
	},

	renderActions: function() {
		this.statusText = E('span', { style: 'font-size:12px;margin-left:10px' }, '');
		this.exportStatus = E('span', { style: 'font-size:12px;margin-left:10px;word-break:break-word' }, '');

		/* uciOk=false 时页面上的 secret/quota 可能是内置默认值，保存/重启一律禁用，
		   避免把空值当成用户配置提交；save() 里还有同样的硬拒绝。
		   没有 admin ACL 的只读账号（老 dispatcher 放行时）也在这里禁用写按钮。 */
		var noAcl = !canManage();
		var blocked = (this.uciOk !== true) || noAcl;
		var disabled = blocked ? true : null;
		var blockedTitle = (this.uciOk !== true)
			? _('UCI 配置未加载成功，已禁用（避免用默认值覆盖）')
			: (noAcl ? _('当前账号没有管理 ACL，写操作已禁用') : null);

		return E('div', { 'class': 'cbi-page-actions', style: 'flex-wrap:wrap;gap:6px 0' }, [
			E('button', {
				'id': 'ts-settings-save-apply',
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, this.saveApply),
				'disabled': disabled,
				'title': blockedTitle
			}, _('保存并应用')),
			' ',
			E('button', {
				'id': 'ts-settings-save-only',
				'class': 'cbi-button cbi-button-save',
				'click': ui.createHandlerFn(this, this.saveOnly),
				'disabled': disabled,
				'title': blockedTitle
			}, _('仅保存')),
			' ',
			E('button', {
				'id': 'ts-settings-restart',
				'class': 'cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(this, this.restartService),
				'disabled': disabled,
				'title': blockedTitle
			}, _('重启服务')),
			' ',
			E('button', {
				'id': 'ts-settings-export',
				'class': 'cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, this.exportDaily)
			}, _('导出每日汇总 CSV')),
			this.statusText,
			this.exportStatus
		]);
	},

	// ------------------------------------------------------------ 读写

	inputValue: function(section, key) {
		var node = this.inputs[section + '.' + key];

		return (node == null) ? '' : ('' + (node.value == null ? '' : node.value)).trim();
	},

	inputChecked: function(section, key) {
		var node = this.inputs[section + '.' + key];

		return (node == null) ? false : (node.checked === true);
	},

	radioValue: function(section, key, fallback) {
		var inputs = this.radioInputs[section + '.' + key] || [];

		for (var i = 0; i < inputs.length; i++) {
			if (inputs[i].checked === true)
				return '' + inputs[i].value;
		}

		return fallback;
	},

	/* 该 option 在页面上是「已知」的：UCI 里本来就有，或本次会话已经成功写过。
	 * 用来决定空输入要不要写：原本没有就别写（保持未配置），写过/存在就写空串（把它关掉）。 */
	optionIsKnown: function(section, key) {
		return optionPresent(section, key) || this.writtenOptions[section + '.' + key] === true;
	},

	setOptional: function(target, section, key, value) {
		if (value === '' && !this.optionIsKnown(section, key))
			return;

		target[key] = value;
	},

	rememberOptions: function(section, options) {
		for (var key in options)
			this.writtenOptions[section + '.' + key] = true;
	},

	collectReportItems: function() {
		var out = [];

		for (var i = 0; i < this.itemOrder.length; i++) {
			var ordered = this.itemOrder[i];

			if (this.itemInputs[ordered] != null && this.itemInputs[ordered].checked === true && out.indexOf(ordered) < 0)
				out.push(ordered);
		}

		for (var j = 0; j < REPORT_ITEMS.length; j++) {
			var name = REPORT_ITEMS[j];

			if (this.itemInputs[name] != null && this.itemInputs[name].checked === true && out.indexOf(name) < 0)
				out.push(name);
		}

		return out.length ? out.join(',') : 'none';
	},

	updateItemsHint: function() {
		if (this.itemsHint == null)
			return;

		var value = this.collectReportItems();

		this.itemsHint.textContent = _('将保存：') + ' ' + value +
			(value === 'none' ? ' ' + _('（不推送任何内容）') : '');
	},

	updateConditionalFields: function() {
		var row = this.rows['feishu.report_weekday'];

		if (row != null) {
			var mode = this.radioValue('feishu', 'report_mode', 'daily');

			row.style.display = (mode === 'daily') ? 'none' : '';
		}

		/* 发送方式：切到 app 才显示扫码绑定区块；切回 webhook 顺手停表 */
		this.syncFeishuMode();
	},

	collect: function() {
		var settings = {};
		var feishu = {};
		var retention;

		settings.enabled = this.inputChecked('settings', 'enabled') ? '1' : '0';
		settings.poll_interval = this.inputValue('settings', 'poll_interval');
		settings.clash_api = this.inputValue('settings', 'clash_api');
		settings.clash_secret = this.inputValue('settings', 'clash_secret');
		settings.fake_ip_ranges = this.inputValue('settings', 'fake_ip_ranges');
		settings.history_days = this.inputValue('settings', 'history_days');
		settings.lan_bridge = this.inputValue('settings', 'lan_bridge');
		settings.wireless_ports = this.inputValue('settings', 'wireless_ports');
		settings.ap_macs = this.inputValue('settings', 'ap_macs');
		settings.link_refresh = this.inputValue('settings', 'link_refresh');
		settings.system_enabled = this.inputChecked('settings', 'system_enabled') ? '1' : '0';
		this.setOptional(settings, 'settings', 'wan_iface', this.inputValue('settings', 'wan_iface'));

		/* 月配额：模式永远显式写入（none/device/total），两个 GB 字段非空就写；
		   原本存在、现在清空的字段写空串，语义是“取消限制”，不能悄悄保留旧配额。 */
		settings.quota_mode = this.inputValue('settings', 'quota_mode') || 'none';
		this.setOptional(settings, 'settings', 'quota_monthly_gb', this.inputValue('settings', 'quota_monthly_gb'));
		this.setOptional(settings, 'settings', 'quota_total_gb', this.inputValue('settings', 'quota_total_gb'));

		feishu.enabled = this.inputChecked('feishu', 'enabled') ? '1' : '0';
		/* 发送方式：webhook = 群自定义机器人，app = 自建应用机器人（扫码绑定群）。
		   后端 UCI_FIELDS 白名单里暂时没有 mode 时会静默忽略这个键，不影响其它字段落盘。 */
		feishu.mode = this.radioValue('feishu', 'mode', FEISHU_MODE_APP);
		if (feishu.mode === FEISHU_MODE_WEBHOOK)
			feishu.mode = FEISHU_MODE_APP;
		feishu.app_id = this.inputValue('feishu', 'app_id');
		feishu.app_secret = this.inputValue('feishu', 'app_secret');
		feishu.chat_id = this.inputValue('feishu', 'chat_id');
		/* 接收目标统一成 receive_id + receive_id_type：webhook 不用，app 用群，user 用个人。 */
		if (feishu.mode === FEISHU_MODE_USER) {
			var target = this.inputValue('feishu', 'receive_id').trim();

			/* 自动识别：邮箱 → email；ou_ → open_id；其余按 user_id（无需回调，最省事）。 */
			if (target.indexOf('@') > 0)
				feishu.receive_id_type = 'email';
			else if (/^ou_/.test(target))
				feishu.receive_id_type = 'open_id';
			else
				feishu.receive_id_type = 'user_id';

			feishu.receive_id = target;
		} else {
			feishu.receive_id_type = 'chat_id';
			feishu.receive_id = feishu.chat_id;
		}
		feishu.report_chat_enabled = this.inputChecked('feishu', 'report_chat_enabled') ? '1' : '0';
		feishu.daily_time = this.inputValue('feishu', 'daily_time');

		/* 内容：永远写非空值（全不勾 -> none），绝不写 '' */
		feishu.report_items = this.collectReportItems();

		/* 时间 */
		feishu.report_mode = this.radioValue('feishu', 'report_mode', 'daily');
		feishu.report_weekday = this.inputValue('feishu', 'report_weekday');

		var reportTime = this.inputValue('feishu', 'report_time');
		var normalizedTime = (reportTime === '') ? '' : (normHHMM(reportTime) || reportTime);
		var reportTimeKnown = this.optionIsKnown('feishu', 'report_time');
		var reportTimeDirty = this.reportTimeDirty || (reportTime !== this.reportTimeInitial);

		if (normalizedTime === '') {
			/* 空：原本有就写空串（回到 daily_time 兜底），原本没有就不写 */
			if (reportTimeKnown)
				feishu.report_time = '';
		}
		else if (reportTimeKnown || reportTimeDirty) {
			feishu.report_time = normalizedTime;
		}
		/* 否则：老配置只有 daily_time，用户也没动过 → 不写 report_time，保持兜底语义 */

		/* 触发条件：留空 = 关闭；空且原本没配 -> 不写，空且原本配过 -> 写空串把它关掉 */
		this.setOptional(feishu, 'feishu', 'alert_app_daily_limit', this.inputValue('feishu', 'alert_app_daily_limit'));
		this.setOptional(feishu, 'feishu', 'alert_spike_ratio', this.inputValue('feishu', 'alert_spike_ratio'));
		this.setOptional(feishu, 'feishu', 'alert_offline_min', this.inputValue('feishu', 'alert_offline_min'));
		this.setOptional(feishu, 'feishu', 'alert_cpu_pct', this.inputValue('feishu', 'alert_cpu_pct'));
		this.setOptional(feishu, 'feishu', 'alert_mem_pct', this.inputValue('feishu', 'alert_mem_pct'));
		this.setOptional(feishu, 'feishu', 'alert_disk_pct', this.inputValue('feishu', 'alert_disk_pct'));

		var quiet = this.inputValue('feishu', 'alert_quiet_hours');
		var normalizedQuiet = (quiet === '') ? '' : normQuietHours(quiet);

		/* 非法输入原样保留，交给 validate() 给出可读的报错 */
		if (normalizedQuiet == null)
			normalizedQuiet = quiet;

		this.setOptional(feishu, 'feishu', 'alert_quiet_hours', normalizedQuiet);

		/* 保留策略：整段显式写入；数值项在 validate() 里做范围校验 */
		retention = this.collectRetentionValues();

		return { settings: settings, feishu: feishu, retention: retention };
	},

	collectRetentionValues: function() {
		var retention = {};

		retention.enabled = this.inputChecked('retention', 'enabled') ? '1' : '0';

		for (var i = 0; i < RETENTION_KEYS.length; i++) {
			var key = RETENTION_KEYS[i];

			if (key === 'enabled' || key === 'dry_run')
				continue;

			retention[key] = this.inputValue('retention', key);
		}

		retention.dry_run = this.inputChecked('retention', 'dry_run') ? '1' : '0';

		return retention;
	},

	validate: function(cfg) {
		var settings = cfg.settings;
		var feishu = cfg.feishu;
		var retention = cfg.retention;
		var i;

		if (!isIntegerInRange(settings.poll_interval, 1, 3600))
			return _('轮询间隔必须是 1–3600 之间的整数');

		if (!isIntegerInRange(settings.history_days, 1, 90))
			return _('历史保留天数必须是 1–90 之间的整数');

		if (!/^[A-Za-z0-9._-]+:[0-9]{1,5}$/.test(settings.clash_api))
			return _('Clash API 地址必须形如 127.0.0.1:9090');

		var ranges = settings.fake_ip_ranges.split(/[\s,]+/);

		for (i = 0; i < ranges.length; i++) {
			if (ranges[i].length == 0) continue;

			if (!/^[0-9a-fA-F:.]+\/[0-9]{1,3}$/.test(ranges[i]))
				return _('fake-ip 网段要以 CIDR 形式填写，例如 198.18.0.0/16');
		}

		if (!isIntegerInRange(settings.link_refresh, 1, 3600))
			return _('接入方式刷新间隔必须是 1–3600 之间的整数');

		if (settings.lan_bridge.length > 0 && !/^[A-Za-z0-9._-]{1,15}$/.test(settings.lan_bridge))
			return _('LAN 网桥名不合法（1–15 个字母/数字/._-，例如 br-lan）');

		var ports = settings.wireless_ports.split(/[\s,]+/);

		for (i = 0; i < ports.length; i++) {
			if (ports[i].length == 0) continue;

			if (!/^[0-9]{1,5}$/.test(ports[i]))
				return _('无线上联端口必须是桥端口号（数字），例如 3 或 3,5');
		}

		var apMacs = settings.ap_macs.split(/[\s,]+/);

		for (i = 0; i < apMacs.length; i++) {
			if (apMacs[i].length == 0) continue;

			if (!/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(apMacs[i]))
				return _('AP 的 LAN MAC 必须是 MAC 形式，例如 00:58:28:d7:63:60');
		}

		var wan = str(settings.wan_iface);

		if (wan.length > 0 && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,31}$/.test(wan))
			return _('WAN 接口名不合法（字母/数字/._:@- 组成，留空 = 自动）');

		if ([ 'none', 'device', 'total' ].indexOf(str(settings.quota_mode)) < 0)
			return _('配额模式只能是 none / device / total');

		var gbFields = [
			[ 'quota_monthly_gb', _('单设备月配额') ],
			[ 'quota_total_gb', _('全屋月配额') ]
		];

		for (i = 0; i < gbFields.length; i++) {
			var gb = str(settings[gbFields[i][0]]);

			if (gb.length > 0 && !isDecimalInRange(gb, 0, 1048576))
				return gbFields[i][1] + ' ' + _('必须是 0–1048576 之间的数字（GB，留空 = 不限制）');
		}

		if (feishu.mode !== FEISHU_MODE_APP && feishu.mode !== FEISHU_MODE_USER)
			return _('飞书发送方式只能是绑定群或发给个人（都使用应用凭证）');

		/* 应用机器人没有 App ID/Secret 连 token 都换不到：保存前就拦住并说清楚，别等到发送时静默失败 */
		if ((feishu.mode === FEISHU_MODE_APP || feishu.mode === FEISHU_MODE_USER) && str(feishu.app_id) === '')
			return _('请先填写 App ID（应用凭证里的 App ID，形如 cli_xxxxx）');

		/* 允许先保存 App ID、Secret 稍后填；但如果本机已经存过 Secret，不允许被清空。 */
		if ((feishu.mode === FEISHU_MODE_APP || feishu.mode === FEISHU_MODE_USER) &&
		    str(feishu.app_secret) === '' && str(rawValue('feishu', 'app_secret') || '') !== '')
			return _('App Secret 不能清空：请在输入框重新粘贴后再保存');

		if (feishu.mode === FEISHU_MODE_USER) {
			var rcpt = str(feishu.receive_id).trim();

			/* 允许先保存 App 凭证、稍后再填接收人；只有填了才校验格式。 */
			if (rcpt.length > 0) {
				var okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rcpt);
				var okOpen = /^ou_[A-Za-z0-9_-]{8,}$/.test(rcpt);
				var okUser = /^[A-Za-z0-9_-]{1,64}$/.test(rcpt);

				if (!okEmail && !okOpen && !okUser)
					return _('接收人要填飞书 user_id、ou_ 开头的 open_id 或邮箱');
			}
		}

		if (feishu.daily_time.length > 0 && normHHMM(feishu.daily_time) == null)
			return _('旧字段 daily_time 必须是 24 小时制 HH:MM');

		var reportTime = str(feishu.report_time);

		if (reportTime.length > 0 && normHHMM(reportTime) == null)
			return _('报表时间必须是 24 小时制 HH:MM，例如 08:30');

		if (feishu.report_mode != 'daily' && !/^[1-7]$/.test(str(feishu.report_weekday)))
			return _('周报星期必须是 1–7（1 = 周一）');

		var appLimit = str(feishu.alert_app_daily_limit);

		if (appLimit.length > 0 && !/^[0-9]+(\.[0-9]+)?\s*[KMGT]?B?$/i.test(appLimit))
			return _('单应用日流量阈值要形如 20G / 512M（纯数字按 GB 计）');

		var ratio = str(feishu.alert_spike_ratio);

		if (ratio.length > 0) {
			if (!/^[0-9]+(\.[0-9]+)?$/.test(ratio))
				return _('突增倍数必须是大于 1 的数字，例如 3');

			var ratioValue = parseFloat(ratio);

			if (!(ratioValue > 1))
				return _('突增倍数必须大于 1（等于 1 等于每小时都告警，没有意义）');

			if (ratioValue > 1000)
				return _('突增倍数不能大于 1000');
		}

		var offline = str(feishu.alert_offline_min);

		if (offline.length > 0 && !isIntegerInRange(offline, 1, 10080))
			return _('离线分钟阈值必须是 1–10080 之间的整数（最多 7 天）');

		var pctFields = [
			[ 'alert_cpu_pct', _('CPU 使用率阈值') ],
			[ 'alert_mem_pct', _('内存使用率阈值') ],
			[ 'alert_disk_pct', _('磁盘使用率阈值') ]
		];

		for (i = 0; i < pctFields.length; i++) {
			var pct = str(feishu[pctFields[i][0]]);

			if (pct.length > 0 && !isDecimalInRange(pct, 0, 100))
				return pctFields[i][1] + ' ' + _('必须是 0–100 之间的数字');
		}

		var quiet = str(feishu.alert_quiet_hours);

		if (quiet.length > 0 && normQuietHours(quiet) == null)
			return _('免打扰时段必须形如 HH:MM-HH:MM（可逗号分隔多段，起止时间不能相同），例如 23:00-07:00');

		var dayFields = [
			[ 'daily_days', _('每日汇总保留天数') ],
			[ 'nodes_days', _('子节点快照保留天数') ],
			[ 'stations_days', _('AP 站点快照保留天数') ],
			[ 'log_days', _('日志保留天数') ]
		];

		for (i = 0; i < dayFields.length; i++) {
			if (!isIntegerInRange(retention[dayFields[i][0]], 0, 36500))
				return dayFields[i][1] + ' ' + _('必须是 0–36500 之间的整数（0 = 关闭）');
		}

		var kbFields = [
			[ 'log_max_kb', _('单个日志上限') ],
			[ 'spool_max_kb', _('飞书队列上限') ]
		];

		for (i = 0; i < kbFields.length; i++) {
			if (!isIntegerInRange(retention[kbFields[i][0]], 0, 16777216))
				return kbFields[i][1] + ' ' + _('必须是 0–16777216 之间的整数（0 = 关闭）');
		}

		return null;
	},

	setStatus: function(message, kind) {
		if (this.statusText != null) {
			this.statusText.textContent = message;
			this.statusText.style.color = (kind === 'error' || kind === true)
				? 'var(--ts-bad-text)'
				: ((kind === 'warn') ? 'var(--ts-warn-text)' : '');
		}
	},

	setTestResult: function(message, isError) {
		if (this.testNode != null) {
			this.testNode.textContent = message;
			this.testNode.style.color = isError ? 'var(--ts-bad-text)' : 'var(--ts-ok-text)';
		}
	},

	notify: function(message, isError) {
		ui.addNotification(null, E('p', {}, message), isError ? 'error' : 'info');
	},

	writeSection: function(section, options) {
		var labels = { settings: _('采集设置'), feishu: _('飞书设置') };
		var label = labels[section] || section;

		return callSetConfig(section, JSON.stringify(options)).then(function(res) {
			if (res == null || res.ok !== true)
				throw new Error((res != null && res.error != null)
					? ('' + res.error)
					: (_('写入') + label + _('失败')));

			return res;
		});
	},

	save: function(restartAfter) {
		var self = this;

		/*
		 * 硬闸门放在 collect() 之前：uciOk=false 时输入框里是内置默认值
		 * （clash_secret / feishu.secret / app_secret / quota_* 都可能是空串），
		 * 一旦 collect 后提交，就等于把用户现有配置覆盖成空值。宁可拒绝保存。
		 */
		if (this.uciOk !== true) {
			var blocked = _('读不到 UCI 配置，已拒绝保存：不会用页面默认值（空密钥/空配额等）覆盖现有配置。请检查 ACL 或 rpcd 后刷新页面重试。');

			this.setStatus(blocked, 'error');
			this.notify(blocked, true);

			return Promise.resolve();
		}

		if (!canManage()) {
			var denied = _('当前账号没有管理 ACL（luci-app-prism-router-admin），已拒绝保存。');

			this.setStatus(denied, 'error');
			this.notify(denied, true);

			return Promise.resolve();
		}

		var cfg = this.collect();
		var err = this.validate(cfg);
		var warnings = [];
		var retentionDirty = (JSON.stringify(cfg.retention) !== this.retentionBaseline);
		var writeRetention = retentionDirty || this.retentionExists === true;

		if (err != null) {
			this.setStatus(err, 'error');
			this.notify(err, true);

			return Promise.resolve();
		}

		this.setStatus(_('正在保存…'), false);
		this.clearRetentionMessages();

		var finish = function(message) {
			if (warnings.length)
				self.setStatus(message + _('；但有未完成项：') + warnings.join('；'), 'warn');
			else
				self.setStatus(message, false);
		};

		return this.writeSection('settings', cfg.settings).then(function() {
			self.rememberOptions('settings', cfg.settings);

			return self.writeSection('feishu', cfg.feishu);
		}).then(function() {
			self.rememberOptions('feishu', cfg.feishu);

			/* 老配置没有 retention 段且用户没改：不主动创建（SPEC §9.8 的兼容语义） */
			if (!writeRetention) {
				self.clearRetentionMessages();

				return Promise.resolve();
			}

			/* retention 段单独兜底：当前后端白名单里可能还没有它（返回 invalid section），
			   这不能连累已经写好的 settings / feishu。 */
			return callSetConfig('retention', JSON.stringify(cfg.retention)).then(function(res) {
				if (res != null && res.ok === true) {
					self.rememberOptions('retention', cfg.retention);
					self.retentionBaseline = JSON.stringify(cfg.retention);
					self.retentionExists = true;
					self.clearRetentionMessages();

					return;
				}

				var message = (res != null && res.error != null) ? ('' + res.error) : _('未知原因');

				if (!retentionDirty)
					return;

				warnings.push(_('保留策略未写入') + '（' + message + '）');
				self.showRetentionUciFallback(message, cfg.retention);
			}, function(e) {
				if (!retentionDirty)
					return;

				var message = (e != null && e.message != null) ? ('' + e.message) : ('' + e);

				warnings.push(_('保留策略未写入') + '（' + message + '）');
				self.showRetentionUciFallback(message, cfg.retention);
			});
		}).then(function() {
			if (!restartAfter) {
				finish(_('已保存（重启服务后生效）'));

				return null;
			}

			self.setStatus(_('已保存，正在重启服务…'), false);

			return callRestart().then(function(res) {
				if (res != null && res.ok === true) {
					finish(_('已保存并重启服务'));
				}
				else {
					var message = _('已保存，但重启失败：') +
						((res != null && res.error != null) ? res.error : _('未知原因'));

					if (warnings.length)
						message += _('；另有未完成项：') + warnings.join('；');

					self.setStatus(message, 'error');
				}
			});
		}).catch(function(e) {
			var message = (e != null && e.message) ? e.message : ('' + e);

			self.setStatus(_('保存失败：') + message, 'error');
			self.notify(_('保存失败：') + message, true);
		});
	},

	saveOnly: function(ev) {
		return this.save(false);
	},

	saveApply: function(ev) {
		return this.save(true);
	},

	// ------------------------------------------------------------ 保留策略：dry-run / uci 降级

	retentionCommands: function(values) {
		var lines = [ 'uci set prism-router.retention=retention' ];

		for (var i = 0; i < RETENTION_KEYS.length; i++) {
			var key = RETENTION_KEYS[i];
			var value;

			if (values != null && values[key] != null) {
				value = '' + values[key];
			}
			else if (key === 'enabled' || key === 'dry_run') {
				value = this.inputChecked('retention', key) ? '1' : '0';
			}
			else {
				value = this.inputValue('retention', key);
			}

			lines.push("uci set prism-router.retention." + key + "='" + value + "'");
		}

		lines.push('uci commit prism-router');

		return lines.join('\n');
	},

	showRetentionUciFallback: function(reason, values) {
		var hint = _('当前后端的 set_config 不接受 retention 段') + '（' + reason + _('），所以本页的保留策略没有写入。可在 SSH 执行下面命令落盘（值取自本页当前输入）：');

		if (this.retentionHint != null) {
			this.retentionHint.textContent = hint;
			this.retentionHint.style.display = '';
		}

		if (this.retentionOutput != null) {
			this.retentionOutput.textContent = this.retentionCommands(values);
			this.retentionOutput.style.display = '';
		}
	},

	setDryRunStatus: function(message, isError) {
		if (this.dryRunStatus != null) {
			this.dryRunStatus.textContent = message;
			this.dryRunStatus.style.color = isError ? 'var(--ts-bad-text)' : '';
		}
	},

	clearRetentionMessages: function() {
		if (this.retentionHint != null) {
			this.retentionHint.textContent = '';
			this.retentionHint.style.display = 'none';
		}

		if (this.retentionOutput != null) {
			this.retentionOutput.textContent = '';
			this.retentionOutput.style.display = 'none';
		}
	},

	applyDryRunResult: function(res) {
		if (res == null) {
			this.showDryRunFallback(new Error(_('rpcd 没有返回内容')));

			return;
		}

		/* 有的实现直接返回 stdout 字符串 */
		if (typeof res == 'string') {
			if (this.retentionOutput != null) {
				this.retentionOutput.textContent = res || _('（没有输出）');
				this.retentionOutput.style.display = '';
			}

			this.setDryRunStatus(_('dry-run 完成（只读，未改动任何文件）'), false);

			return;
		}

		if (res.ok !== true) {
			var detail = (res.error != null) ? ('' + res.error)
				: ((res.msg != null) ? ('' + res.msg) : _('未知原因'));

			this.setDryRunStatus(_('dry-run 失败：') + detail, true);

			if (this.retentionHint != null) {
				this.retentionHint.textContent = _('后端方法存在但没有成功执行。可在 SSH 直接跑：');
				this.retentionHint.style.display = '';
			}

			if (this.retentionOutput != null) {
				this.retentionOutput.textContent = 'ucode /usr/share/prism-router/retention.uc --dry-run';
				this.retentionOutput.style.display = '';
			}

			return;
		}

		var text = '';

		if (typeof res.output == 'string') {
			text = res.output;
		}
		else if (typeof res.stdout == 'string') {
			text = res.stdout;
		}
		else if (typeof res.log == 'string') {
			text = res.log;
		}
		else if (typeof res.result == 'string') {
			text = res.result;
		}
		else {
			try {
				text = JSON.stringify(res, null, 2);
			}
			catch (e) {
				text = '' + res;
			}
		}

		if (this.retentionOutput != null) {
			this.retentionOutput.textContent = text || _('（没有输出）');
			this.retentionOutput.style.display = '';
		}

		this.setDryRunStatus(_('dry-run 完成（只读，未改动任何文件）'), false);
	},

	showDryRunFallback: function(err) {
		var detail = (err != null && err.message != null) ? ('' + err.message) : ('' + err);
		var missing = isMissingMethodError(err);
		var text = missing
			? _('当前后端没有可用的 retention dry-run 接口（方法不存在或 ACL 未授权）')
			: _('调用 retention dry-run 失败（可能是 rpcd 不可用或权限不足）');

		this.setDryRunStatus(missing
			? _('没有可用的 dry-run 方法，已改为命令行提示（不影响其它功能）')
			: _('调用失败，已改为命令行提示'), false);

		if (this.retentionHint != null) {
			this.retentionHint.textContent = text + '（' + detail + _('）。可在 SSH 手动执行（只打印、不改文件）：');
			this.retentionHint.style.display = '';
		}

		if (this.retentionOutput != null) {
			this.retentionOutput.textContent = 'ucode /usr/share/prism-router/retention.uc --dry-run';
			this.retentionOutput.style.display = '';
		}
	},

	runRetentionDryRun: function(ev) {
		var self = this;

		this.setDryRunStatus(_('正在调用 rpcd 执行 dry-run…'), false);
		this.clearRetentionMessages();

		var apply = function(res) {
			self.applyDryRunResult(res);
		};

		return callRetentionDryRun(true).then(apply).catch(function() {
			return callRetentionDryRunAlt(true).then(apply).catch(function(err) {
				self.showDryRunFallback(err);
			});
		});
	},

	/* 二维码加群的自建应用：列出机器人所在的群，点一下就把 chat_id 填进输入框 */
	listFeishuChats: function() {
		var self = this;

		if (!canManage()) {
			clearNode(this.chatNode);
			this.chatNode.appendChild(E('span', { style: 'color:#c62828' },
				_('当前账号没有管理 ACL（luci-app-prism-router-admin），无法查询群。')));
			return Promise.resolve();
		}

		clearNode(this.chatNode);
		this.chatNode.appendChild(E('em', {}, _('查询中…（用已保存的 App ID/Secret 换 token）')));

		return callFeishuChats().then(function(res) {
			clearNode(self.chatNode);

			if (res == null || res.ok !== true) {
				self.chatNode.appendChild(E('span', { style: 'color:#c62828' },
					_('获取失败：') + ((res && res.msg) || _('未知错误'))));
				return;
			}

			var chats = res.chats || [];

			if (chats.length === 0) {
				self.chatNode.appendChild(E('span', {}, _('机器人还没有被加入任何群。请先在飞书里把它扫码拉进群。')));
				return;
			}

			self.chatNode.appendChild(E('div', {}, _('点击一项填入 chat_id：')));

			chats.forEach(function(c) {
				self.chatNode.appendChild(E('div', {
					style: 'padding:4px 0;cursor:pointer',
					click: function() {
						var node = self.inputs['feishu.chat_id'];
						if (node != null) node.value = c.chat_id;
					}
				}, [ E('code', {}, c.chat_id), E('span', { style: 'margin-left:8px' }, c.name || '') ]));
			});
		}).catch(function(e) {
			clearNode(self.chatNode);
			self.chatNode.appendChild(E('span', { style: 'color:#c62828' }, _('获取失败：') + e));
		});
	},

	// ------------------------------------------------------ 应用机器人 · 扫码绑定

	feishuMode: function() {
		var mode = this.radioValue('feishu', 'mode', FEISHU_MODE_APP);

		/* 旧配置可能还是 webhook：一律按“绑定群”处理，不再有 webhook 选项。 */
		return (mode === FEISHU_MODE_USER) ? FEISHU_MODE_USER : FEISHU_MODE_APP;
	},

	/* 读不到 UCI 或没有 admin ACL：所有会落盘的飞书按钮都禁用（与其它写按钮同一闸门）。 */
	feishuWriteBlocked: function() {
		return (this.uciOk !== true) || (!canManage());
	},

	/* 只有「应用机器人」模式才显示扫码区域。 */
	syncFeishuMode: function() {
		var mode = this.feishuMode();
		var app = (mode === FEISHU_MODE_APP);
		var user = (mode === FEISHU_MODE_USER);
		var self = this;

		/* 只显示当前方式真正需要的字段：webhook/secret 只在 webhook；app 凭据在 app/user；
		   chat_id 只给群；open_id 只给个人。 */
		function show(key, on) {
			var row = self.rows['feishu.' + key];
			if (row != null) row.style.display = on ? '' : 'none';
		}

		show('app_id', app || user);
		show('app_secret', app || user);
		show('chat_id', app);
		show('receive_id', user);

		if (this.feishuScanBlock != null)
			this.feishuScanBlock.style.display = (app || user) ? '' : 'none';

		if (this.feishuBindBtn != null)
			this.setFeishuButton(this.feishuBindBtn,
				user ? _('扫码获取我的 open_id') : _('生成绑定二维码'), this.feishuWriteBlocked());

		if (!app && this.feishuPolling === true) {
			this.stopFeishuPoll();
			this.setFeishuScanStatus(_('已切回自定义机器人，绑定轮询已停止。'), 'warn');
		}

		if (app)
			this.refreshFeishuBound();
	},

	/* 页面装载时回显已保存的 chat_id（群名只有扫码后才知道，这里只给打码的 id）。
	 * 本次会话里刚绑定/解除过就用内存里的结果：uci 缓存要刷新页面才会更新。 */
	refreshFeishuBound: function() {
		if (this.feishuBoundNode == null) return;

		if (this.feishuBoundChat != null) {
			this.showFeishuBound(this.feishuBoundChat.chat_id, this.feishuBoundChat.name);

			return;
		}

		if (this.uciOk !== true) {
			this.showFeishuBound('');

			return;
		}

		var chatId = str(rawValue('feishu', 'chat_id'));

		if (chatId === '') {
			this.showFeishuBound('');

			return;
		}

		this.showFeishuBound(chatId, '');
	},

	showFeishuBound: function(chatId, name) {
		var id = str(chatId);

		if (this.feishuBoundNode == null || this.feishuBoundText == null) return;

		if (id === '') {
			this.feishuBoundNode.style.display = 'none';
			this.feishuBoundText.textContent = '';

			return;
		}

		var label = str(name);
		var text = _('已绑定：') + (label.length ? label + ' ' : '') + '（' + maskChatId(id) + '）';

		if (label.length === 0)
			text += ' ' + _('（群名未知，重新扫码可刷新）');

		this.feishuBoundText.textContent = text;
		this.feishuBoundNode.style.display = 'flex';
	},

	setFeishuScanStatus: function(message, kind) {
		if (this.feishuScanStatus == null) return;

		this.feishuScanStatus.textContent = (message == null) ? '' : ('' + message);
		this.feishuScanStatus.style.color = (kind === 'error') ? 'var(--ts-bad-text)'
			: ((kind === 'ok') ? 'var(--ts-ok-text)'
			: ((kind === 'warn') ? 'var(--ts-warn-text)' : ''));
	},

	setFeishuButton: function(btn, label, busy) {
		if (btn == null) return;

		if (label != null)
			btn.textContent = label;

		btn.disabled = (busy === true) || this.feishuWriteBlocked();
	},

	syncFeishuChatIdInput: function(chatId) {
		var node = this.inputs['feishu.chat_id'];

		if (node != null)
			node.value = str(chatId);
	},

	/* 用于错误脱敏的当前密钥（App Secret / webhook 签名 secret），只在本页内存里。 */
	feishuSecretValues: function() {
		var out = [];
		var secret = this.inputValue('feishu', 'app_secret');
		var sign = this.inputValue('feishu', 'secret');

		if (secret.length >= 4) out.push(secret);
		if (sign.length >= 4) out.push(sign);

		return out;
	},

	feishuErrorText: function(err) {
		var text = redactFeishuError(err, this.feishuSecretValues());

		if (/expire|invalid[\s_-]?state|state[\s_-]?not[\s_-]?found|过期|失效/i.test(text)) {
			text = _('二维码 / state 已过期或无效，请点「重新生成二维码」') + '（' + text + '）';
		}
		else if (/no valid options/i.test(text)) {
			text = _('后端 set_config 白名单还不认识 mode / chat_id，请更新 prism-router 后端后重试') +
				'（' + text + '）';
		}

		return text;
	},

	clearFeishuPollTimer: function() {
		var win = (typeof window !== 'undefined') ? window : null;

		if (this.feishuPollTimer != null && win != null && typeof win.clearTimeout === 'function')
			win.clearTimeout(this.feishuPollTimer);

		this.feishuPollTimer = null;
	},

	/* 彻底停表：清定时器 + 丢掉 state（用户切模式 / 离开页面 / 超时后才调）。 */
	stopFeishuPoll: function() {
		this.clearFeishuPollTimer();
		this.feishuPolling = false;
		this.feishuPaused = false;
		this.feishuState = '';
		this.feishuPollDeadline = 0;
		this.feishuPollFailures = 0;
	},

	/* LuCI 换掉视图后（离开设置页）root 不再挂在 body 上，轮询必须自停。 */
	feishuViewDetached: function() {
		var doc = (typeof document !== 'undefined') ? document : null;
		var body = (doc != null) ? doc.body : null;

		if (this.root == null) return false;
		if (body == null || typeof body.contains !== 'function') return false;

		return (body.contains(this.root) !== true);
	},

	bindFeishuLifecycle: function() {
		var self = this;
		var win = (typeof window !== 'undefined') ? window : null;
		var doc = (typeof document !== 'undefined') ? document : null;

		if (this.feishuLifecycleBound === true) return;

		this.feishuLifecycleBound = true;

		this.feishuUnloadFn = function() { self.clearFeishuPollTimer(); };

		if (win != null && typeof win.addEventListener === 'function')
			win.addEventListener('beforeunload', this.feishuUnloadFn);

		this.feishuVisibilityFn = function() { self.onFeishuVisibility(); };

		if (doc != null && typeof doc.addEventListener === 'function')
			doc.addEventListener('visibilitychange', this.feishuVisibilityFn);
	},

	/* 切标签页：先停表（省电省请求），回到本页且在 5 分钟内则继续轮询。 */
	onFeishuVisibility: function() {
		var doc = (typeof document !== 'undefined') ? document : null;

		if (doc == null) return;

		if (doc.hidden === true) {
			if (this.feishuPolling === true) {
				this.clearFeishuPollTimer();
				this.feishuPolling = false;
				this.feishuPaused = true;
				this.setFeishuScanStatus(_('已切到其它标签页，轮询暂停；回到本页会自动继续。'), 'warn');
			}

			return;
		}

		if (this.feishuPaused !== true) return;

		this.feishuPaused = false;

		if (this.feishuState === '') {
			this.setFeishuScanStatus(_('绑定已结束，请点「重新生成二维码」重新发起。'), 'warn');

			return;
		}

		if (Date.now() >= this.feishuPollDeadline) {
			this.stopFeishuPoll();
			this.setFeishuScanStatus(_('绑定超时（5 分钟未完成扫码）：请点「重新生成二维码」重试。'), 'warn');

			return;
		}

		this.setFeishuScanStatus(_('等待手机扫码…') + ' ' + _('（已继续轮询）'), '');
		this.feishuPolling = true;
		this.scheduleFeishuPoll();
	},

	/* 同源相对路径 + fetch；请求里不带任何凭证（CGI 从 UCI 读）。非 2xx 与「不是 JSON」都变成可读错误。 */
	feishuRequest: function(path, init) {
		var opts = { credentials: 'same-origin', cache: 'no-store' };
		var key;

		for (key in init) {
			if (init.hasOwnProperty(key)) opts[key] = init[key];
		}

		var win = (typeof window !== 'undefined') ? window : null;
		var controller = null;
		var timer = null;

		try {
			if (typeof AbortController == 'function') {
				controller = new AbortController();
				opts.signal = controller.signal;
			}
		}
		catch (e) {
			controller = null;
		}

		if (controller != null && win != null && typeof win.setTimeout === 'function') {
			timer = win.setTimeout(function() {
				try { controller.abort(); }
				catch (e) { }
			}, FEISHU_REQUEST_TIMEOUT_MS);
		}

		var release = function() {
			if (timer != null && win != null && typeof win.clearTimeout === 'function')
				win.clearTimeout(timer);

			timer = null;
		};

		var pending;

		try {
			pending = fetch(path, opts);
		}
		catch (e) {
			release();

			return Promise.reject(e);
		}

		return pending.then(function(resp) {
			release();

			if (resp == null)
				throw new Error(_('后端没有响应'));

			var status = (resp.status != null) ? (0 + resp.status) : 0;
			var httpOk = (resp.ok === false) ? false : (status < 400);

			if (typeof resp.text != 'function')
				throw new Error(_('后端响应没有可读取的内容'));

			return resp.text().then(function(text) {
				var data = null;

				try { data = (text == null || text === '') ? null : JSON.parse(text); }
				catch (e) { data = null; }

				if (!httpOk) {
					var detail = (data != null && data.error != null) ? ('' + data.error)
						: ((data != null && data.msg != null) ? ('' + data.msg)
						: ((status === 404 || status === 410)
							? _('接口不存在（请确认后端已安装 /cgi-bin/prism-router-feishu）')
							: (_('HTTP ') + status)));

					/* 带上 HTTP 状态码：轮询层据此区分「state 过期」和「网络抖动」 */
					var httpErr = new Error(detail);

					httpErr.status = status;
					throw httpErr;
				}

				if (data == null)
					throw new Error(_('返回内容不是 JSON'));

				return data;
			});
		}).catch(function(err) {
			release();
			throw err;
		});
	},

	/* 「生成绑定二维码」/「重新生成二维码」 */
	startFeishuBind: function() {
		var self = this;

		if (this.uciOk !== true) {
			this.setFeishuScanStatus(_('读不到 UCI 配置，已拒绝生成绑定二维码：请检查 ACL 或 rpcd 后刷新页面。'), 'error');

			return Promise.resolve();
		}

		if (!canManage()) {
			this.setFeishuScanStatus(_('当前账号没有管理 ACL（luci-app-prism-router-admin），不能绑定群。'), 'error');

			return Promise.resolve();
		}

		if (typeof fetch != 'function') {
			this.setFeishuScanStatus(_('当前浏览器不支持 fetch，无法生成绑定二维码；请换新版浏览器或用手机 App。'), 'error');

			return Promise.resolve();
		}

		var appId = this.inputValue('feishu', 'app_id');
		var appSecret = this.inputValue('feishu', 'app_secret');

		if (appId === '' || appSecret === '') {
			this.setFeishuScanStatus(_('请先填写 App ID 和 App Secret 再生成绑定二维码（在上面的输入框里）。'), 'error');

			var focusNode = this.inputs['feishu.' + ((appId === '') ? 'app_id' : 'app_secret')];

			if (focusNode != null && typeof focusNode.focus == 'function')
				focusNode.focus();

			return Promise.resolve();
		}

		/* App ID 格式与 CGI 的校验保持一致（^[A-Za-z0-9._-]{1,128}$），
		 * 本地先拦一次，省掉一次往返和一句看不懂的后端报错。 */
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(appId)) {
			this.setFeishuScanStatus(_('App ID 格式不对：应为 cli_ 开头的应用 ID（只允许字母/数字/._-）。'), 'error');

			return Promise.resolve();
		}

		this.stopFeishuPoll();
		this.clearFeishuChats();
		this.renderFeishuQr('');
		this.setFeishuButton(this.feishuBindBtn, _('生成绑定二维码'), true);

		/*
		 * CGI 是只读 GET，凭证从 UCI 读：页面上刚改过 App ID/Secret 但还没保存时，
		 * 先只把这两个键写进去（不带 mode，避免还没绑群就把发送路线切走）。
		 */
		var savedId = str(rawValue('feishu', 'app_id'));
		var savedSecret = str(rawValue('feishu', 'app_secret'));

		if (savedId !== appId || savedSecret !== appSecret) {
			this.setFeishuScanStatus(_('正在保存 App ID / App Secret（扫码接口只读取已保存的配置）…'), '');

			return callSetConfig('feishu', JSON.stringify({ app_id: appId, app_secret: appSecret }))
				.then(function(res) {
					if (res == null || res.ok !== true) {
						throw new Error((res != null && res.error != null)
							? ('' + res.error)
							: _('后端没有返回 ok'));
					}

					self.rememberOptions('feishu', { app_id: appId, app_secret: appSecret });

					return self.requestFeishuStart(self.feishuMode() === FEISHU_MODE_USER ? 'openid' : '');
				})
				.catch(function(err) {
					self.setFeishuButton(self.feishuBindBtn, _('生成绑定二维码'), false);
					self.setFeishuScanStatus(_('生成前需要先保存 App ID / App Secret：') +
						self.feishuErrorText(err), 'error');
				});
		}

		return this.requestFeishuStart(this.feishuMode() === FEISHU_MODE_USER ? 'openid' : '');
	},

	/* 真正调 CGI 的 start：GET + 同源相对路径，不带任何凭证（CGI 从 UCI 读）。 */
	requestFeishuStart: function(target) {
		var self = this;
		var seq = (this.feishuStartSeq || 0) + 1;
		var q = '?action=start' + (target ? ('&target=' + encodeURIComponent(target)) : '');

		this.feishuStartSeq = seq;
		this.setFeishuScanStatus(target === 'openid' ? _('正在申请授权二维码…') : _('正在申请绑定二维码…'), '');

		return this.feishuRequest(FEISHU_CGI + q, { method: 'GET' }).then(function(data) {
			/* 期间又点了一次「重新生成」：这份响应已经过期，别覆盖新的 state/二维码 */
			if (self.feishuStartSeq !== seq) return;

			var state = (data != null && data.state != null) ? ('' + data.state) : '';
			var url = (data != null && data.url != null) ? ('' + data.url) : '';

			self.setFeishuButton(self.feishuBindBtn, _('重新生成二维码'), false);

			if (state === '' || url === '') {
				self.setFeishuScanStatus(_('后端没有返回绑定信息（缺少 state 或 url）：请确认 prism-router 后端已更新。'), 'error');

				return;
			}

			if (!/^https?:\/\/[^\s]+$/i.test(url)) {
				self.setFeishuScanStatus(_('后端返回的二维码地址不是 http(s) 链接，已拒绝渲染。'), 'error');

				return;
			}

			self.feishuState = state;
			self.feishuPollDeadline = Date.now() + FEISHU_BIND_TIMEOUT_MS;
			self.feishuPollFailures = 0;
			self.renderFeishuQr(url);
			self.setFeishuScanStatus(_('等待手机扫码…') + ' ' + _('（5 分钟内有效）'), '');
			self.scheduleFeishuPoll();
		}).catch(function(err) {
			if (self.feishuStartSeq !== seq) return;

			self.setFeishuButton(self.feishuBindBtn, _('重新生成二维码'), false);
			self.setFeishuScanStatus(_('生成绑定二维码失败：') + self.feishuErrorText(err), 'error');
		});
	},

	/* 每 2 秒查一次；上一次请求回来才排下一次，慢后端不会把定时器叠成并发。 */
	scheduleFeishuPoll: function() {
		var self = this;
		var win = (typeof window !== 'undefined') ? window : null;

		if (win == null || typeof win.setTimeout != 'function') return;

		this.clearFeishuPollTimer();
		this.feishuPolling = true;

		this.feishuPollTimer = win.setTimeout(function() {
			self.feishuPollTick();
		}, FEISHU_POLL_MS);
	},

	feishuPollTick: function() {
		var self = this;

		this.feishuPollTimer = null;

		if (this.feishuPolling !== true || this.feishuState === '')
			return;

		if (this.feishuViewDetached()) {
			this.stopFeishuPoll();

			return;
		}

		if (Date.now() >= this.feishuPollDeadline) {
			this.stopFeishuPoll();
			this.renderFeishuQr('');
			this.setFeishuScanStatus(_('绑定超时（5 分钟未完成扫码）：请点「重新生成二维码」重试，并确认手机与路由器在同一网络。'), 'warn');

			return;
		}

		var query = FEISHU_CGI + '?action=status&state=' + encodeURIComponent(this.feishuState);

		this.feishuRequest(query, { method: 'GET' }).then(function(data) {
			if (self.feishuPolling !== true) return;

			self.feishuPollFailures = 0;
			self.applyFeishuStatus(data);
		}).catch(function(err) {
			if (self.feishuPolling !== true) return;

			/* 404/410 = 后端的 state 已过期或不存在（CGI 对失效 state 返回 404）：
			 * 这是终态，立刻停表让用户重新生成，别当成网络故障重试三次。 */
			if (err != null && (err.status === 404 || err.status === 410)) {
				self.stopFeishuPoll();
				self.renderFeishuQr('');
				self.setFeishuScanStatus(_('二维码 / state 已过期或无效：请点「重新生成二维码」重试。') +
					'（' + redactFeishuError(err, self.feishuSecretValues()) + '）', 'error');

				return;
			}

			self.feishuPollFailures = (self.feishuPollFailures || 0) + 1;

			if (self.feishuPollFailures >= FEISHU_POLL_FAIL_MAX || Date.now() >= self.feishuPollDeadline) {
				self.stopFeishuPoll();
				self.setFeishuScanStatus(_('查询绑定状态失败：') + self.feishuErrorText(err), 'error');

				return;
			}

			self.setFeishuScanStatus(_('网络异常，正在重试（') + self.feishuPollFailures + '/' +
				FEISHU_POLL_FAIL_MAX + _('）…'), 'warn');
			self.scheduleFeishuPoll();
		});
	},

	applyFeishuStatus: function(data) {
		var status = (data != null && data.status != null) ? ('' + data.status) : '';

		if (this.feishuPolling !== true) return;

		if (status === 'pending') {
			this.setFeishuScanStatus(_('等待手机扫码…') + ' ' + _('（5 分钟内有效）'), '');
			this.scheduleFeishuPoll();

			return;
		}

		if (status === 'ready') {
			/* state 一次性：拿到结果就停表，避免继续打后端 */
			this.clearFeishuPollTimer();
			this.feishuPolling = false;
			this.feishuState = '';
			this.feishuPollFailures = 0;
			this.renderFeishuQr('');

			var openId = (data != null && data.open_id != null) ? ('' + data.open_id) : '';

			/* 个人模式：授权后直接拿到 open_id，填进输入框，不需要群 */
			if (openId !== '') {
				var input = this.inputs['feishu.receive_id'];

				if (input != null)
					input.value = openId;

				this.setFeishuScanStatus(_('已获取你的 open_id，并填入接收人：') + openId, '');

				return;
			}

			var chats = (data != null && Array.isArray(data.chats)) ? data.chats : [];

			this.renderFeishuChats(chats);

			return;
		}

		if (status === 'error') {
			var detail = (data != null && data.error != null) ? ('' + data.error)
				: ((data != null && data.msg != null) ? ('' + data.msg) : _('后端没有给出原因'));

			this.stopFeishuPoll();
			this.renderFeishuQr('');
			this.setFeishuScanStatus(_('授权失败：') + this.feishuErrorText(detail), 'error');

			return;
		}

		/* 未知状态：当错误处理，绝不无限轮询 */
		this.stopFeishuPoll();
		this.setFeishuScanStatus(_('后端返回了无法识别的状态：') +
			redactFeishuError(status || _('（空）'), this.feishuSecretValues()), 'error');
	},

	/* 群列表：单列单选（390px 不横向溢出），默认选中第一个，点「保存绑定」才落盘。 */
	renderFeishuChats: function(chats) {
		var self = this;
		var box = this.feishuChatBox;

		if (box == null) return;

		this.feishuChatRadios = [];
		this.feishuChats = [];
		clearNode(box);

		var list = Array.isArray(chats) ? chats : [];
		var usable = [];

		for (var i = 0; i < list.length; i++) {
			var item = list[i];

			if (item == null) continue;

			var chatId = str(item.chat_id);

			if (chatId === '') continue;

			usable.push({ chat_id: chatId, name: str(item.name) });
		}

		if (usable.length === 0) {
			box.style.display = '';
			box.appendChild(E('div', {
				style: 'font-size:12px;line-height:1.6;color:#c62828;max-width:100%;word-break:break-word'
			}, _('授权成功，但机器人还没有加入任何群：请先在飞书里把应用机器人拉进目标群，再点「重新生成二维码」。')));
			this.setFeishuScanStatus(_('群列表为空，无法绑定'), 'warn');

			return;
		}

		this.feishuChats = usable;
		this.setFeishuScanStatus(_('扫码成功：选择要接收报表的群，然后点「保存绑定」。'), 'ok');

		var rows = usable.map(function(chat, index) {
			var radio = E('input', {
				'id': 'ts-feishu-chat-' + index,
				'name': 'ts-feishu-chat',
				'type': 'radio',
				'class': 'cbi-input-radio',
				'value': chat.chat_id
			});

			radio.checked = (index === 0);
			self.feishuChatRadios.push({ input: radio, chat: chat });

			return E('label', {
				'for': 'ts-feishu-chat-' + index,
				'style': 'display:flex;gap:8px;align-items:flex-start;min-width:0;max-width:100%;' +
					'box-sizing:border-box;padding:7px 8px;border-radius:6px;cursor:pointer;' +
					'background:rgba(127,127,127,.08)'
			}, [
				radio,
				E('span', { style: 'flex:1 1 auto;min-width:0;max-width:100%;word-break:break-word;line-height:1.45' }, [
					E('span', { style: 'display:block' }, chat.name.length ? chat.name : _('（未命名群）')),
					E('code', { style: 'font-size:11px;opacity:.7;word-break:break-all' }, maskChatId(chat.chat_id))
				])
			]);
		});

		box.style.display = '';
		box.appendChild(E('div', { style: 'font-size:12px;opacity:.85;margin-bottom:6px' },
			_('机器人所在的群（单选）：')));
		box.appendChild(E('div', {
			style: 'display:grid;grid-template-columns:minmax(0,1fr);gap:6px;max-width:100%;min-width:0'
		}, rows));
		box.appendChild(E('div', {
			style: 'margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:100%'
		}, [
			this.feishuSaveBindBtn,
			E('span', { style: 'font-size:12px;opacity:.75' },
				_('保存后写入 feishu.chat_id，并切到应用机器人模式'))
		]));
	},

	clearFeishuChats: function() {
		this.feishuChatRadios = [];
		this.feishuChats = [];

		if (this.feishuChatBox == null) return;

		clearNode(this.feishuChatBox);
		this.feishuChatBox.style.display = 'none';
	},

	selectedFeishuChat: function() {
		for (var i = 0; i < this.feishuChatRadios.length; i++) {
			if (this.feishuChatRadios[i].input.checked === true)
				return this.feishuChatRadios[i].chat;
		}

		return null;
	},

	/* 「保存绑定」：只写 mode + chat_id 两个键，不动其它飞书配置。 */
	saveFeishuBinding: function() {
		var self = this;

		if (this.uciOk !== true) {
			this.setFeishuScanStatus(_('读不到 UCI 配置，已拒绝保存绑定：不会用页面默认值覆盖现有配置。'), 'error');

			return Promise.resolve();
		}

		if (!canManage()) {
			this.setFeishuScanStatus(_('当前账号没有管理 ACL（luci-app-prism-router-admin），不能保存绑定。'), 'error');

			return Promise.resolve();
		}

		var chat = this.selectedFeishuChat();

		if (chat == null) {
			this.setFeishuScanStatus(_('请先选择要绑定的群（没有群可选项时请重新生成二维码）。'), 'error');

			return Promise.resolve();
		}

		this.setFeishuButton(this.feishuSaveBindBtn, _('保存中…'), true);
		this.setFeishuScanStatus(_('正在保存绑定…'), '');

		var payload = { mode: FEISHU_MODE_APP, chat_id: chat.chat_id };

		return callSetConfig('feishu', JSON.stringify(payload)).then(function(res) {
			if (res == null || res.ok !== true) {
				throw new Error((res != null && res.error != null) ? ('' + res.error) : _('后端没有返回 ok'));
			}

			self.rememberOptions('feishu', payload);
			self.syncFeishuChatIdInput(chat.chat_id);
			self.feishuBoundChat = { chat_id: chat.chat_id, name: chat.name };
			self.showFeishuBound(chat.chat_id, chat.name);
			self.clearFeishuChats();
			self.setFeishuButton(self.feishuSaveBindBtn, _('保存绑定'), false);
			self.setFeishuScanStatus(_('已保存绑定：') +
				(chat.name.length ? chat.name : maskChatId(chat.chat_id)), 'ok');

			ui.addNotification(null, E('p', {}, _('已绑定飞书群：') +
				(chat.name.length ? chat.name : maskChatId(chat.chat_id))), 'info');
		}).catch(function(err) {
			self.setFeishuButton(self.feishuSaveBindBtn, _('保存绑定'), false);
			self.setFeishuScanStatus(_('保存绑定失败：') + self.feishuErrorText(err), 'error');
		});
	},

	/* 「解除绑定」：清空 feishu.chat_id（不删群、不动 App ID/Secret）。 */
	unbindFeishu: function() {
		var self = this;

		if (this.uciOk !== true) {
			this.setFeishuScanStatus(_('读不到 UCI 配置，已拒绝解除绑定。'), 'error');

			return Promise.resolve();
		}

		if (!canManage()) {
			this.setFeishuScanStatus(_('当前账号没有管理 ACL（luci-app-prism-router-admin），不能解除绑定。'), 'error');

			return Promise.resolve();
		}

		this.setFeishuButton(this.feishuUnbindBtn, _('解除中…'), true);

		return callSetConfig('feishu', JSON.stringify({ chat_id: '' })).then(function(res) {
			if (res == null || res.ok !== true) {
				throw new Error((res != null && res.error != null) ? ('' + res.error) : _('后端没有返回 ok'));
			}

			/* 空串也记成「已知」：下一次整页保存要把空值写回去，而不是跳过 */
			self.rememberOptions('feishu', { chat_id: '' });
			self.syncFeishuChatIdInput('');
			self.feishuBoundChat = null;
			self.showFeishuBound('');
			self.setFeishuButton(self.feishuUnbindBtn, _('解除绑定'), false);
			self.setFeishuScanStatus(_('已解除绑定（feishu.chat_id 已清空），重新扫码可以再绑。'), 'ok');
		}).catch(function(err) {
			self.setFeishuButton(self.feishuUnbindBtn, _('解除绑定'), false);
			self.setFeishuScanStatus(_('解除绑定失败：') + self.feishuErrorText(err), 'error');
		});
	},

	/* 二维码：交给 LuCI 自带的 uqr（不重复实现编码），只把解析出来的 SVG 节点插进 host。 */
	renderFeishuQr: function(text) {
		var self = this;
		var host = this.feishuQrHost;
		var url = str(text);

		if (host == null) return;

		clearNode(host);
		host.style.display = 'none';
		host.setAttribute('data-qr', '');

		if (url === '') return;

		var done = false;

		var fallback = function(reason) {
			if (done) return;

			done = true;
			clearNode(host);
			host.setAttribute('data-qr', 'fail');
			host.appendChild(E('div', {
				style: 'font-size:12px;line-height:1.5;padding:6px;color:#555;word-break:break-word'
			}, _('二维码组件不可用（') + str(reason || _('未知原因')) + _('）。可在电脑上打开下面的链接完成授权：')));
			host.appendChild(E('div', {
				style: 'font-size:11px;line-height:1.4;padding:0 6px 6px;word-break:break-all;opacity:.8'
			}, url));
			host.style.display = 'flex';
		};

		var apply = function(mod) {
			if (done) return false;

			var api = mod;

			if (api != null && typeof api.renderSVG != 'function' &&
				api['default'] != null && typeof api['default'].renderSVG == 'function')
				api = api['default'];

			if (api == null || typeof api.renderSVG != 'function') return false;

			var svg = null;

			try {
				svg = api.renderSVG(url, { pixelSize: 6, whiteColor: '#fff', blackColor: '#000' });
			}
			catch (e) {
				return false;
			}

			var node = importQrSvg(svg);

			if (node == null) return false;

			/* 期间用户又点了一次「重新生成」：host 里已经是新的，旧结果直接丢 */
			if (self.feishuQrHost !== host) return false;

			done = true;
			clearNode(host);
			host.appendChild(node);
			normalizeQrSvg(host);
			host.setAttribute('data-qr', 'ok');
			host.style.display = 'flex';

			return true;
		};

		var mod = null;

		try {
			mod = (typeof L != 'undefined' && L != null && typeof L.require == 'function')
				? L.require('uqr')
				: null;
		}
		catch (e) {
			mod = null;
		}

		if (apply(mod)) return;

		if (mod != null && typeof mod.then == 'function') {
			mod.then(function(m) {
				if (!apply(m)) fallback(_('uqr 模块加载失败'));
			}).catch(function() {
				fallback(_('uqr 模块加载失败'));
			});

			return;
		}

		fallback(_('uqr 模块不可用'));
	},

	/* 「导出每日汇总 CSV」：what=daily，单位字节，最多最近 200 天（后端决定）。 */
	exportDaily: function() {
		var self = this;

		this.setExportStatus(_('正在导出每日汇总…'), '');

		return callExportCsv('daily').then(function(res) {
			if (res == null || res.ok !== true || typeof res.csv != 'string')
				throw new Error((res != null && res.error != null) ? ('' + res.error) : _('后端没有返回 CSV 内容'));

			self.saveCsv(res, 'daily');
			self.setExportStatus(_('已导出') + ' ' + ((res.rows != null) ? res.rows : 0) + ' ' + _('行'), 'var(--ts-ok-text)');
		}).catch(function(err) {
			var message = (err != null && err.message) ? ('' + err.message) : ('' + err);

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
		var csv = (res != null && typeof res.csv == 'string') ? res.csv : '';

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

	testFeishu: function(ev) {
		if (!canManage()) {
			this.setTestResult(_('当前账号没有管理 ACL（luci-app-prism-router-admin），不能发送测试消息。'), true);
			return Promise.resolve();
		}

		this.setTestResult(_('正在发送测试消息…'), false);

		return callTestFeishu().then(function(res) {
			if (res != null && res.ok === true) {
				this.setTestResult(_('测试消息已发送（code=0）'), false);
			}
			else {
				var detail = (res != null)
					? ('code=' + ((res.code == null) ? '?' : res.code) + ' ' + ((res.msg == null) ? '' : res.msg))
					: _('没有返回内容');

				this.setTestResult(_('测试发送失败：') + detail, true);
			}
		}.bind(this)).catch(function(e) {
			this.setTestResult(_('测试发送失败：') + ((e != null && e.message) ? e.message : ('' + e)), true);
		}.bind(this));
	},

	restartService: function(ev) {
		if (this.uciOk !== true) {
			var blocked = _('读不到 UCI 配置，已禁用重启：请先确认配置能正常读取，避免在错误状态下重启服务。');

			this.setStatus(blocked, 'error');
			this.notify(blocked, true);

			return Promise.resolve();
		}

		if (!canManage()) {
			var denied = _('当前账号没有管理 ACL（luci-app-prism-router-admin），已禁用重启。');

			this.setStatus(denied, 'error');
			this.notify(denied, true);

			return Promise.resolve();
		}

		var confirmed = (typeof window.confirm == 'function')
			? window.confirm(_('确定要重启 prism-routerd 服务吗？'))
			: true;

		if (!confirmed)
			return Promise.resolve();

		this.setStatus(_('正在重启服务…'), false);

		return callRestart().then(function(res) {
			if (res != null && res.ok === true)
				this.setStatus(_('服务已重启'), false);
			else
				this.setStatus(_('重启失败：') + ((res != null && res.error != null) ? res.error : _('未知原因')), 'error');
		}.bind(this)).catch(function(e) {
			this.setStatus(_('重启失败：') + ((e != null && e.message) ? e.message : ('' + e)), 'error');
		}.bind(this));
	},

	/* 自己画了操作按钮，这里压掉 View.addFooter() 自动生成的 Save/Save&Apply 条 */
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
