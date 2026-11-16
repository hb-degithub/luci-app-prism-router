'use strict';
'require view';
'require dom';
'require rpc';
'require uci';
'require ui';

/*
 * 流量统计 · 设置
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
 * 页面加载仍然只有 2 次 rpc：uci get（整份配置）+ traffic-stats.status。
 */

var callStatus = rpc.declare({
	object: 'traffic-stats',
	method: 'status',
	expect: {}
});

var callSetConfig = rpc.declare({
	object: 'traffic-stats',
	method: 'set_config',
	params: [ 'section', 'options' ],
	expect: {}
});

var callTestFeishu = rpc.declare({
	object: 'traffic-stats',
	method: 'test_feishu',
	expect: {}
});

var callFeishuChats = rpc.declare({
	object: 'traffic-stats',
	method: 'feishu_chats',
	expect: {}
});

var callRestart = rpc.declare({
	object: 'traffic-stats',
	method: 'restart',
	expect: {}
});

/*
 * retention dry-run：后端目前还没有这个 ubus 方法（ACL 里也没有），这里按最可能的名字
 * 先声明、点击时再尝试调用。调用失败属于「预期内的老后端」，只降级成命令行提示。
 */
var callRetentionDryRun = rpc.declare({
	object: 'traffic-stats',
	method: 'retention_dryrun',
	params: [ 'dry_run' ],
	expect: {}
});

var callRetentionDryRunAlt = rpc.declare({
	object: 'traffic-stats',
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

/* 内置默认值：与 package 里的 /etc/config/traffic-stats、docs/SPEC.md §2/§9.2 对齐。
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
		wan_iface: ''
	},
	feishu: {
		enabled: '0',
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
		value = uci.get('traffic-stats', section, option);
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
		value = uci.get('traffic-stats', section, option);
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

function str(value) {
	return (value == null) ? '' : ('' + value);
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

return view.extend({
	load: function() {
		this.uciOk = true;
		this.status = null;
		this.loadError = null;

		var tasks = [
			uci.load('traffic-stats').catch(function(err) {
				this.uciOk = false;
				this.loadError = (err != null && err.message) ? err.message : '' + err;
			}.bind(this)),
			callStatus().then(function(status) {
				this.status = (status != null && typeof status == 'object') ? status : null;
			}.bind(this)).catch(function() {
				this.status = null;
			}.bind(this))
		];

		return Promise.all(tasks);
	},

	render: function() {
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

		var root = E('div', {}, [
			E('h2', {}, _('流量统计 · 设置')),
			this.renderStatusBanner(),
			this.uciOk ? '' : E('div', { 'class': 'alert-message error', style: 'padding:10px 14px;margin-bottom:16px' }, [
				E('strong', {}, _('读不到 UCI 配置（当前显示的可能是默认值）')),
				E('p', {}, _('常见原因是 ACL 未生效或 rpcd 未重载；保存会由后端直接校验。')),
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

		var look = running
			? { color: '#2e7d32', bg: 'rgba(76,175,80,.12)' }
			: { color: '#c62828', bg: 'rgba(198,40,40,.12)' };

		var bits = [];

		if (status != null) {
			bits.push(_('采集中') + ': ' + (enabled ? _('是') : _('否')));
			bits.push(_('服务运行') + ': ' + (running ? _('是') : _('否')));
			bits.push(_('记账状态') + ': ' + (status.confidence || 'unknown'));

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
			bits.push(_('读不到服务状态（rpcd 对象 traffic-stats 不可用或未安装后端）'));
		}

		this.statusNode = E('span', { style: 'font-size:12px;opacity:.85' }, bits.join(' · '));

		return E('div', {
			style: 'padding:10px 14px;margin-bottom:16px;border-left:4px solid ' + look.color +
				';border-radius:6px;background:' + look.bg
		}, [
			E('strong', { style: 'color:' + look.color }, running ? _('服务运行中') : _('服务未运行')),
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

		fields.push(this.subhead(_('系统指标（软路由自身，与流量统计隔离）'), false));
		fields.push(this.field('settings', 'system_enabled', _('采集系统指标'),
			_('CPU / 内存 / 负载 / 磁盘 / 温度 / WAN 速率，写入 state.json 的 system 段；关闭后整段不出现。'),
			'bool', null));
		fields.push(this.field('settings', 'wan_iface', _('WAN 接口'),
			_('用于计算 WAN 上下行速率，例如 eth3 / pppoe-wan。留空 = 自动取默认路由所在接口。'),
			'text', { placeholder: _('留空 = 自动') }));

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('采集设置')),
			E('div', { 'class': 'cbi-section-node' }, fields)
		]);
	},

	renderFeishuSection: function() {
		var self = this;

		var channelFields = [
			[ 'feishu', 'enabled', _('启用飞书报表'), _('开启后按下面的「时间」推送日报/周报；测试发送不受这里影响。'), 'bool', null ],
			[ 'feishu', 'webhook', _('Webhook 地址'), _('群自定义机器人的地址，https://open.feishu.cn/open-apis/bot/v2/hook/…'), 'text', { wide: true } ],
			[ 'feishu', 'secret', _('签名校验 secret'), _('机器人开启「签名校验」时填写；留空则不加签。'), 'password', { placeholder: _('留空则不签名') } ],
			[ 'feishu', 'app_id', _('App ID（扫码加群的自建应用）'), _('飞书开放平台 → 自建应用 → 凭证与基础信息。填了 App ID/Secret 就优先走应用 API，不再用 webhook。'), 'text', { wide: true, placeholder: 'cli_xxxxx' } ],
			[ 'feishu', 'app_secret', _('App Secret'), _('与 App ID 配套；仅保存在本机 /etc/config/traffic-stats。'), 'password', null ],
			[ 'feishu', 'chat_id', _('群 chat_id'), _('点下方「列出机器人所在的群」自动获取；形如 oc_xxxxx。'), 'text', { wide: true, placeholder: 'oc_xxxxx' } ],
			[ 'feishu', 'report_chat_enabled', _('群聊报表'), _('关掉后只推送给私聊/其它通道（按后端实现）。'), 'bool', null ]
		];

		var fields = channelFields.map(function(def) {
			return self.field(def[0], def[1], def[2], def[3], def[4], def[5]);
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

		this.testNode = E('span', { style: 'font-size:12px;opacity:.85' }, '');
		this.chatNode = E('div', { style: 'font-size:12px;margin-top:8px' }, '');

		var section = E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('飞书报表')),
			E('div', { 'class': 'cbi-section-node' }, fields),
			E('div', { 'class': 'cbi-section-actions', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, this.testFeishu)
				}, _('测试发送')),
				E('button', {
					'class': 'cbi-button',
					'click': ui.createHandlerFn(this, this.listFeishuChats)
				}, _('列出机器人所在的群')),
				this.testNode
			]),
			this.chatNode
		]);

		/* report_weekday 只在 weekly / both 时显示（radio 的 change 也会再调一次） */
		this.updateConditionalFields();

		return section;
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
			[ 'retention', 'daily_days', _('每日汇总保留（天）'), _('/etc/traffic-stats/daily/*.json；0–36500，0 = 关闭该目录的按天清理。默认 400。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'nodes_days', _('子节点快照保留（天）'), _('/etc/traffic-stats/nodes/*.json / *.jsonl；0–36500，0 = 关闭。默认 30。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'stations_days', _('AP 站点快照保留（天）'), _('/etc/traffic-stats/stations/*.json；0–36500，0 = 关闭。默认 7。'), 'number', { min: 0, max: 36500 } ],
			[ 'retention', 'log_days', _('日志保留（天）'), _('/tmp/traffic-stats/*.log；0–36500，0 = 关闭按天清理。默认 7。'), 'number', { min: 0, max: 36500 } ],
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
				_('定时触发由你自己的 cron 负责（本页不改 crontab），例如：30 3 * * * /usr/bin/ucode /usr/share/traffic-stats/retention.uc >/dev/null 2>&1')),
			E('div', { 'class': 'cbi-value-description' },
				_('注意：上面的「立即预览」读取的是已保存的 UCI 配置，改了输入请先保存。'))
		];

		if (!this.retentionExists) {
			notes.push(E('div', { 'class': 'cbi-value-description', style: 'color:#ef6c00;margin-top:4px' },
				_('当前 UCI 里还没有 retention 段：改动任意一项再保存才会创建它；创建后 daily 的清理由 retention.uc 接管（别忘了加 cron）。')));
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

		return E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, this.saveApply)
			}, _('保存并应用')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-save',
				'click': ui.createHandlerFn(this, this.saveOnly)
			}, _('仅保存')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(this, this.restartService)
			}, _('重启服务')),
			this.statusText
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

		if (row == null)
			return;

		var mode = this.radioValue('feishu', 'report_mode', 'daily');

		row.style.display = (mode === 'daily') ? 'none' : '';
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

		feishu.enabled = this.inputChecked('feishu', 'enabled') ? '1' : '0';
		feishu.webhook = this.inputValue('feishu', 'webhook');
		feishu.secret = this.inputValue('feishu', 'secret');
		feishu.app_id = this.inputValue('feishu', 'app_id');
		feishu.app_secret = this.inputValue('feishu', 'app_secret');
		feishu.chat_id = this.inputValue('feishu', 'chat_id');
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

		if (feishu.webhook.length > 0 && !/^https?:\/\/[^\s]+$/.test(feishu.webhook))
			return _('飞书 webhook 必须是 http(s) 地址');

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
				? '#c62828'
				: ((kind === 'warn') ? '#ef6c00' : '');
		}
	},

	setTestResult: function(message, isError) {
		if (this.testNode != null) {
			this.testNode.textContent = message;
			this.testNode.style.color = isError ? '#c62828' : '#2e7d32';
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
		var lines = [ 'uci set traffic-stats.retention=retention' ];

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

			lines.push("uci set traffic-stats.retention." + key + "='" + value + "'");
		}

		lines.push('uci commit traffic-stats');

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
			this.dryRunStatus.style.color = isError ? '#c62828' : '';
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
				this.retentionOutput.textContent = 'ucode /usr/share/traffic-stats/retention.uc --dry-run';
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
			this.retentionOutput.textContent = 'ucode /usr/share/traffic-stats/retention.uc --dry-run';
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

		this.chatNode.innerHTML = '';
		this.chatNode.appendChild(E('em', {}, _('查询中…（用已保存的 App ID/Secret 换 token）')));

		return callFeishuChats().then(function(res) {
			self.chatNode.innerHTML = '';

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
			self.chatNode.innerHTML = '';
			self.chatNode.appendChild(E('span', { style: 'color:#c62828' }, _('获取失败：') + e));
		});
	},

	testFeishu: function(ev) {
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
		var confirmed = (typeof window.confirm == 'function')
			? window.confirm(_('确定要重启 traffic-statsd 服务吗？'))
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
