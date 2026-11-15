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
 * 页面加载只有 2 次 rpc：uci get（整份配置）+ traffic-stats.status。
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

var callRestart = rpc.declare({
	object: 'traffic-stats',
	method: 'restart',
	expect: {}
});

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
		link_refresh: '30'
	},
	feishu: {
		enabled: '0',
		webhook: '',
		secret: '',
		daily_time: '08:30',
		report_chat_enabled: '1'
	}
};

function valueOf(section, option) {
	var value = null;

	try {
		value = uci.get('traffic-stats', section, option);
	}
	catch (e) {
		value = null;
	}

	if (value == null || value === '')
		return DEFAULTS[section][option];

	return '' + value;
}

function flagOf(section, option) {
	var value = valueOf(section, option);

	return (value === '1' || value === 'true' || value === 'yes' || value === 'on');
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

	field: function(section, key, label, desc, type, extra) {
		var id = 'ts-' + section + '-' + key;
		var value = valueOf(section, key);
		var input;

		if (type == 'bool') {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-checkbox',
				'type': 'checkbox',
				checked: flagOf(section, key) ? true : null
			});
		}
		else if (type == 'password') {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-text',
				'type': 'password',
				'value': value,
				'autocomplete': 'new-password'
			});
		}
		else if (type == 'number') {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-text',
				'type': 'number',
				'value': value,
				'style': 'width:12em'
			});
		}
		else {
			input = E('input', {
				'id': id,
				'class': 'cbi-input-text',
				'type': 'text',
				'value': value,
				'style': (extra && extra.wide) ? 'width:100%;max-width:32em' : 'width:16em'
			});
		}

		if (extra != null && extra.placeholder != null)
			input.setAttribute('placeholder', extra.placeholder);

		this.inputs[section + '.' + key] = input;

		if (type == 'bool') {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title', 'for': id }, label),
				E('div', { 'class': 'cbi-value-field' }, [
					E('label', {}, [ input, ' ', desc ? E('span', { 'class': 'cbi-value-description' }, desc) : '' ])
				])
			]);
		}

		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'for': id }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				input,
				desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
			])
		]);
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

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('采集设置')),
			E('div', { 'class': 'cbi-section-node' }, fields)
		]);
	},

	renderFeishuSection: function() {
		var self = this;
		var defs = [
			[ 'feishu', 'enabled', _('启用飞书报表'), _('开启后按报表时间推送日报卡片。'), 'bool', null ],
			[ 'feishu', 'webhook', _('Webhook 地址'), _('群自定义机器人的地址，https://open.feishu.cn/open-apis/bot/v2/hook/…'), 'text', { wide: true } ],
			[ 'feishu', 'secret', _('签名校验 secret'), _('机器人开启"签名校验"时填写；留空则不加签。'), 'password', { placeholder: _('留空则不签名') } ],
			[ 'feishu', 'daily_time', _('报表时间'), _('24 小时制 HH:MM，例如 08:30。'), 'text', { placeholder: '08:30' } ],
			[ 'feishu', 'report_chat_enabled', _('群聊报表'), _('关掉后只推送给私聊/其它通道（按后端实现）。'), 'bool', null ]
		];

		var fields = defs.map(function(def) {
			return self.field(def[0], def[1], def[2], def[3], def[4], def[5]);
		});

		this.testNode = E('span', { style: 'font-size:12px;opacity:.85' }, '');

		return E('div', { 'class': 'cbi-section', style: 'margin-bottom:18px' }, [
			E('h3', {}, _('飞书报表')),
			E('div', { 'class': 'cbi-section-node' }, fields),
			E('div', { 'class': 'cbi-section-actions', style: 'display:flex;gap:10px;align-items:center' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					click: ui.createHandlerFn(this, this.testFeishu)
				}, _('测试发送')),
				this.testNode
			])
		]);
	},

	renderActions: function() {
		this.statusText = E('span', { style: 'font-size:12px;margin-left:10px' }, '');

		return E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'cbi-button cbi-button-apply',
				click: ui.createHandlerFn(this, this.saveApply)
			}, _('保存并应用')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-save',
				click: ui.createHandlerFn(this, this.saveOnly)
			}, _('仅保存')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-reset',
				click: ui.createHandlerFn(this, this.restartService)
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

	collect: function() {
		var settings = {};
		var feishu = {};

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

		feishu.enabled = this.inputChecked('feishu', 'enabled') ? '1' : '0';
		feishu.webhook = this.inputValue('feishu', 'webhook');
		feishu.secret = this.inputValue('feishu', 'secret');
		feishu.daily_time = this.inputValue('feishu', 'daily_time');
		feishu.report_chat_enabled = this.inputChecked('feishu', 'report_chat_enabled') ? '1' : '0';

		return { settings: settings, feishu: feishu };
	},

	validate: function(cfg) {
		var poll = cfg.settings.poll_interval;

		if (!/^[0-9]+$/.test(poll) || parseInt(poll, 10) < 1 || parseInt(poll, 10) > 3600)
			return _('轮询间隔必须是 1–3600 之间的整数');

		var days = cfg.settings.history_days;

		if (!/^[0-9]+$/.test(days) || parseInt(days, 10) < 1 || parseInt(days, 10) > 90)
			return _('历史保留天数必须是 1–90 之间的整数');

		if (!/^[A-Za-z0-9._-]+:[0-9]{1,5}$/.test(cfg.settings.clash_api))
			return _('Clash API 地址必须形如 127.0.0.1:9090');

		var ranges = cfg.settings.fake_ip_ranges.split(/[\s,]+/);

		for (var i = 0; i < ranges.length; i++) {
			if (ranges[i].length == 0) continue;

			if (!/^[0-9a-fA-F:.]+\/[0-9]{1,3}$/.test(ranges[i]))
				return _('fake-ip 网段要以 CIDR 形式填写，例如 198.18.0.0/16');
		}

		var refresh = cfg.settings.link_refresh;

		if (!/^[0-9]+$/.test(refresh) || parseInt(refresh, 10) < 1 || parseInt(refresh, 10) > 3600)
			return _('接入方式刷新间隔必须是 1–3600 之间的整数');

		if (cfg.settings.lan_bridge.length > 0 && !/^[A-Za-z0-9._-]{1,15}$/.test(cfg.settings.lan_bridge))
			return _('LAN 网桥名不合法（1–15 个字母/数字/._-，例如 br-lan）');

		var ports = cfg.settings.wireless_ports.split(/[\s,]+/);

		for (var j = 0; j < ports.length; j++) {
			if (ports[j].length == 0) continue;

			if (!/^[0-9]{1,5}$/.test(ports[j]))
				return _('无线上联端口必须是桥端口号（数字），例如 3 或 3,5');
		}

		var apMacs = cfg.settings.ap_macs.split(/[\s,]+/);

		for (var k = 0; k < apMacs.length; k++) {
			if (apMacs[k].length == 0) continue;

			if (!/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(apMacs[k]))
				return _('AP 的 LAN MAC 必须是 MAC 形式，例如 00:58:28:d7:63:60');
		}

		if (cfg.feishu.webhook.length > 0 && !/^https?:\/\/[^\s]+$/.test(cfg.feishu.webhook))
			return _('飞书 webhook 必须是 http(s) 地址');

		if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(cfg.feishu.daily_time))
			return _('报表时间必须是 HH:MM（24 小时制）');

		return null;
	},

	setStatus: function(message, isError) {
		if (this.statusText != null) {
			this.statusText.textContent = message;
			this.statusText.style.color = isError ? '#c62828' : '';
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

	save: function(restartAfter) {
		var cfg = this.collect();
		var err = this.validate(cfg);

		if (err != null) {
			this.setStatus(err, true);
			this.notify(err, true);

			return Promise.resolve();
		}

		this.setStatus(_('正在保存…'), false);

		return callSetConfig('settings', JSON.stringify(cfg.settings)).then(function(res) {
			if (res == null || res.ok !== true)
				throw new Error((res != null && res.error) ? res.error : _('写入采集设置失败'));

			return callSetConfig('feishu', JSON.stringify(cfg.feishu));
		}).then(function(res) {
			if (res == null || res.ok !== true)
				throw new Error((res != null && res.error) ? res.error : _('写入飞书设置失败'));

			if (!restartAfter) {
				this.setStatus(_('已保存（重启服务后生效）'), false);

				return null;
			}

			this.setStatus(_('已保存，正在重启服务…'), false);

			return callRestart();
		}.bind(this)).then(function(res) {
			if (res == null) return;

			if (res.ok === true)
				this.setStatus(_('已保存并重启服务'), false);
			else
				this.setStatus(_('已保存，但重启失败：') + ((res.error != null) ? res.error : _('未知原因')), true);
		}.bind(this)).catch(function(e) {
			var message = (e != null && e.message) ? e.message : ('' + e);

			this.setStatus(_('保存失败：') + message, true);
			this.notify(_('保存失败：') + message, true);
		}.bind(this));
	},

	saveOnly: function(ev) {
		return this.save(false);
	},

	saveApply: function(ev) {
		return this.save(true);
	},

	testFeishu: function(ev) {
		var cfg = null;

		try {
			cfg = this.collect();
		}
		catch (e) {
			cfg = null;
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
				this.setStatus(_('重启失败：') + ((res != null && res.error != null) ? res.error : _('未知原因')), true);
		}.bind(this)).catch(function(e) {
			this.setStatus(_('重启失败：') + ((e != null && e.message) ? e.message : ('' + e)), true);
		}.bind(this));
	},

	/* 自己画了操作按钮，这里压掉 View.addFooter() 自动生成的 Save/Save&Apply 条 */
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
