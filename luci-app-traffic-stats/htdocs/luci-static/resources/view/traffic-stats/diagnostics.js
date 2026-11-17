'use strict';
'require view';
'require rpc';

/*
 * 流量统计 · 诊断中心（只读自检页）
 *
 * 商用路由的「自检」页：一次性把所有可观测项过一遍，逐项给
 *   通过 / 注意 / 失败 + 原因 + 建议。
 *
 * 只读契约（本页不写任何东西）：
 *   - 只调用 status / get_state / get_history / get_daily / get_nodes / get_stations
 *     六个只读 ubus 方法，不新增 rpc，不执行 shell，不写 UCI；
 *   - DOM 只用 E() + textContent + 内置 <details>，不引外部资源，
 *     不拼接标记字符串，所以建议里的任何后端文本都只会成为纯文本；
 *   - 不自动轮询：这是一次性自检，用户点「重新检查」才重新取数。
 *
 * 结论口径（与后端 traffic-statsd.uc 的 health / source 字段对齐）：
 *   - source.clash / source.conntrack 只有 ok / error（老 state 可能是 unknown）；
 *   - accounting_confidence 四态 exact / degraded / unavailable / unknown；
 *   - reasons 是后端写好的整句（"clash: …" / "conntrack: …" / "lan: …" / "link: …"），
 *     本页按前缀映射成短标签，原文放「建议」里便于贴日志。
 *   - state.ts 超过 90s 不动 = 注意（同概览页 STALE_SEC），缺失 / 为 0 = 失败。
 */

// ---------------------------------------------------------------- 常量

var EXPECTED_VERSION = '1.0.0';  /* 与 luci-app-traffic-stats / traffic-stats 的 PKG_VERSION 对齐 */
var STALE_SEC = 90;      /* state.ts 超过 90s 没动 → 注意 */
var ONLINE_SEC = 600;    /* 在线口径：last_seen 10 分钟内（同概览页） */
var NODE_STALE_SEC = 300;/* 子节点快照 >300s 未更新 → 注意（同 nodes.js） */
var HISTORY_DAYS = 7;    /* 历史覆盖期望天数 */

// ---------------------------------------------------------------- rpc（全部只读）

var callStatus = rpc.declare({
	object: 'traffic-stats',
	method: 'status',
	expect: {},
	reject: true
});

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

var callHistory = rpc.declare({
	object: 'traffic-stats',
	method: 'get_history',
	params: [ 'days' ],
	expect: {},
	reject: true
});

var callDaily = rpc.declare({
	object: 'traffic-stats',
	method: 'get_daily',
	params: [ 'day' ],
	expect: {},
	reject: true
});

var callNodes = rpc.declare({
	object: 'traffic-stats',
	method: 'get_nodes',
	expect: { nodes: [] },
	reject: true
});

var callStations = rpc.declare({
	object: 'traffic-stats',
	method: 'get_stations',
	expect: {},
	reject: true
});

// ---------------------------------------------------------------- 样式

var CSS = [
	'#ts-diagnostics{max-width:980px;margin:0 auto;padding:4px 2px 24px}',
	'.tsd-head{margin:0 0 10px}',
	'.tsd-title-main{margin:0 0 4px;font-size:20px;line-height:1.3}',
	'.tsd-sub{margin:0;color:#666;font-size:12.5px;line-height:1.5}',
	'.tsd-panel-link{margin-left:10px;color:#ff6f00;text-decoration:none;white-space:nowrap}',
	'.tsd-panel-link:hover{text-decoration:underline}',
	'.tsd-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;',
	'padding:10px 12px;margin:0 0 14px;background:#f4f6f8;',
	'border:1px solid #e0e4e8;border-radius:6px}',
	'.tsd-sum{margin:0;font-size:13.5px;color:#333}',
	'.tsd-sum strong{font-size:15px}',
	'.tsd-n-ok{color:#2e7d32}',
	'.tsd-n-warn{color:#ef6c00}',
	'.tsd-n-fail{color:#c62828}',
	'.tsd-sep{color:#bbb;margin:0 6px}',
	'.tsd-time{margin:0 0 0 auto;color:#777;font-size:12px}',
	'.tsd-btn{flex:0 0 auto}',
	'.tsd-list{display:block}',
	'.tsd-item{margin:0 0 10px;padding:10px 12px;background:#fff;',
	'border:1px solid #e0e4e8;border-left:4px solid #9e9e9e;border-radius:6px}',
	'.tsd-item.tsd-ok{border-left-color:#2e7d32}',
	'.tsd-item.tsd-warn{border-left-color:#ef6c00}',
	'.tsd-item.tsd-fail{border-left-color:#c62828}',
	'.tsd-row{display:flex;align-items:flex-start;gap:8px}',
	'.tsd-dot{flex:0 0 auto;width:10px;height:10px;margin-top:5px;border-radius:50%;',
	'background:#9e9e9e}',
	'.tsd-ok .tsd-dot{background:#2e7d32}',
	'.tsd-warn .tsd-dot{background:#ef6c00}',
	'.tsd-fail .tsd-dot{background:#c62828}',
	'.tsd-body{flex:1 1 auto;min-width:0}',
	'.tsd-name{margin:0 0 2px;font-size:14px;font-weight:600;line-height:1.4}',
	'.tsd-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:9px;',
	'font-size:11px;font-weight:500;line-height:16px;color:#fff;background:#2e7d32;',
	'vertical-align:1px}',
	'.tsd-warn .tsd-badge{background:#ef6c00}',
	'.tsd-fail .tsd-badge{background:#c62828}',
	'.tsd-detail{margin:0;color:#444;font-size:12.5px;line-height:1.55;word-break:break-word}',
	'.tsd-advice{margin:8px 0 0 18px;font-size:12.5px}',
	'.tsd-advice>summary{cursor:pointer;color:#1565c0}',
	'.tsd-tips{margin:6px 0 0;padding-left:18px;color:#555;line-height:1.6}',
	'.tsd-tips>li{margin:2px 0;word-break:break-word}',
	'.tsd-foot{margin:14px 0 0;color:#888;font-size:11.5px;line-height:1.5}',
	'@media (max-width:600px){',
	'.tsd-title-main{font-size:18px}',
	'.tsd-toolbar{gap:8px}',
	'.tsd-time{margin-left:0}',
	'.tsd-name{font-size:13.5px}',
	'.tsd-item{padding:9px 10px}',
	'}'
].join('');

// ---------------------------------------------------------------- 小工具

function num(value) {
	var n = (typeof value == 'number') ? value : parseInt(value, 10);

	return (typeof n == 'number' && isFinite(n)) ? n : 0;
}

function text(value) {
	return (value == null) ? '' : ('' + value);
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

function errText(err) {
	if (err == null) return _('未知错误');
	if (typeof err == 'string') return err;
	if (err.message) return text(err.message);

	return text(err);
}

/* 日期键（本地日历，和后端 day_of 的本地时区一致） */
function dayKey(date) {
	return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function clockText(date) {
	return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function stampText(date) {
	return dayKey(date) + ' ' + clockText(date);
}

/* 时长：用于「数据已 N 未更新」这类不含「前」的句子 */
function fmtSpan(sec) {
	var n = Math.max(0, num(sec));

	if (n < 60) return n + ' ' + _('秒');
	if (n < 3600) return Math.floor(n / 60) + ' ' + _('分钟');
	if (n < 86400) return Math.floor(n / 3600) + ' ' + _('小时');

	return Math.floor(n / 86400) + ' ' + _('天');
}

/* 年龄：用于「12 秒前」这类短语；负数 / 缺失 → 未知 */
function fmtAge(age) {
	var sec = num(age);

	if (age == null || sec < 0) return _('未知');
	if (sec < 10) return _('刚刚');

	return fmtSpan(sec) + _('前');
}

function levelLabel(level) {
	if (level === 'ok') return _('通过');
	if (level === 'warn') return _('注意');

	return _('失败');
}

function member(list, value) {
	for (var i = 0; i < list.length; i++)
		if (list[i] === value) return true;

	return false;
}

function hasKeys(obj) {
	if (obj == null || typeof obj != 'object') return false;

	for (var key in obj)
		if (Object.prototype.hasOwnProperty.call(obj, key)) return true;

	return false;
}

function clear(el) {
	if (el == null) return el;

	while (el.firstChild)
		el.removeChild(el.firstChild);

	return el;
}

/* 一条检查：level = ok|warn|fail，advice = 纯字符串数组（每行一条建议） */
function mk(level, title, detail, advice) {
	return {
		level: level,
		title: title,
		detail: detail,
		advice: Array.isArray(advice) ? advice.filter(function(line) {
			return line != null && ('' + line).length > 0;
		}) : []
	};
}

/* 后端 reasons 的短标签映射（reasonTag 类似物） */
function reasonTag(reason) {
	var s = text(reason).trim().toLowerCase();

	if (s.indexOf('clash:') === 0) return _('clash 不可达');
	if (s.indexOf('conntrack:') === 0) {
		var raw = text(reason);

		if (raw.indexOf('nf_conntrack_acct') >= 0 || raw.indexOf('bytes') >= 0)
			return _('conntrack 缺计数');

		return _('conntrack 不可读');
	}
	if (s.indexOf('lan:') === 0) return _('LAN 未识别');
	if (s.indexOf('fake_ip:') === 0) return _('fake_ip 配置无效');
	if (s.indexOf('link:') === 0) return _('FDB 读取失败');

	return _('其他原因');
}

/* 去掉 "clash: " 前缀，建议里保留可读正文 */
function reasonBody(reason) {
	var s = text(reason).trim();
	var i = s.indexOf(':');

	if (i > 0 && i <= 12) return s.slice(i + 1).trim();

	return s;
}

function sourceLabel(value) {
	if (value === 'ok') return _('正常');
	if (value === 'error') return _('失败');

	return _('未知');
}

function grab(promise) {
	return promise.then(function(data) {
		return { ok: true, data: data, error: '' };
	}, function(err) {
		return { ok: false, data: null, error: errText(err) };
	});
}

// ---------------------------------------------------------------- 各项检查

function checkService(statusRes) {
	if (statusRes.ok !== true)
		return mk('fail', _('服务'),
			_('无法读取 status：') + statusRes.error,
			[
				_('确认 luci-app-traffic-stats 的 rpcd 插件已安装：/usr/share/rpcd/ucode/traffic-stats.uc'),
				_('重启 rpcd 后重新检查：/etc/init.d/rpcd restart'),
				_('手动核对：ubus call traffic-stats status')
			]);

	var st = statusRes.data;

	if (st == null || typeof st != 'object')
		return mk('fail', _('服务'),
			_('status 返回为空，无法判断服务状态'),
			[
				_('重启 rpcd 后重新检查：/etc/init.d/rpcd restart'),
				_('手动核对：ubus call traffic-stats status')
			]);

	var enabled = (st.enabled !== false);
	var running = (st.running === true);
	var version = text(st.version).length > 0 ? text(st.version) : _('未知');
	var facts = _('配置') + (enabled ? _('启用') : _('禁用')) + ' · ' +
		_('进程') + (running ? _('运行中') : _('未运行')) + ' · ' +
		_('版本 ') + version;

	if (!running)
		return mk('fail', _('服务'),
			_('traffic-statsd 未运行（') + facts + '）',
			[
				_('启动服务：/etc/init.d/traffic-statsd start'),
				_('查看日志：logread -e traffic-stats'),
				_('若配置里是禁用状态，先启用：uci set traffic-stats.settings.enabled=1 && uci commit traffic-stats')
			]);

	if (!enabled)
		return mk('warn', _('服务'),
			_('配置中已禁用，但进程仍在运行（') + facts + '）',
			[
				_('开机不会自启：确认 uci show traffic-stats.settings.enabled'),
				_('不需要统计时停掉进程：/etc/init.d/traffic-statsd stop')
			]);

	return mk('ok', _('服务'), facts, []);
}

function checkSources(stateRes) {
	if (stateRes.ok !== true)
		return mk('fail', _('数据源'),
			_('无法读取 get_state：') + stateRes.error,
			[
				_('先确认状态接口可用：ubus call traffic-stats status'),
				_('重启 rpcd 后重新检查：/etc/init.d/rpcd restart')
			]);

	var state = stateRes.data;
	var src = (state != null && state.source != null && typeof state.source == 'object') ? state.source : {};
	var clash = text(src.clash).length > 0 ? text(src.clash) : 'unknown';
	var ct = text(src.conntrack).length > 0 ? text(src.conntrack) : 'unknown';
	var detail = _('clash ') + sourceLabel(clash) + ' · ' + _('conntrack ') + sourceLabel(ct);
	var advice = [];

	if (clash === 'error')
		advice.push(_('clash 采集失败：检查 OpenClash 控制器地址与密码（clash_api / clash_secret），确认控制器端口可达'));

	if (ct === 'error')
		advice.push(_('conntrack 采集失败：检查 LAN 网段识别（lan_bridge / wireless_ports 与 IP 网段），确认 /proc/net/nf_conntrack 可读且 nf_conntrack_acct 已启用'));

	if (clash === 'error' || ct === 'error')
		return mk('fail', _('数据源'), detail, advice);

	if (clash === 'unknown' || ct === 'unknown')
		return mk('warn', _('数据源'), detail,
			[ _('状态快照里还没有数据源结论：确认守护进程已完成第一轮轮询（日志 logread -e traffic-stats）') ]);

	return mk('ok', _('数据源'), detail, []);
}

function checkAccounting(stateRes) {
	var state = (stateRes.ok === true) ? stateRes.data : null;
	var health = (state != null && state.health != null && typeof state.health == 'object') ? state.health : null;

	if (health == null)
		return mk('warn', _('记账状态'),
			_('状态快照里没有 health 段'),
			[
				_('确认 traffic-statsd 与 rpcd 插件版本一致后重启服务'),
				_('检查 state 文件：ubus call traffic-stats get_state')
			]);

	var conf = text(health.accounting_confidence);
	var reasons = [];

	if (Array.isArray(health.reasons))
		reasons = health.reasons.filter(function(item) {
			return typeof item == 'string' && item.length > 0;
		});

	if (!member([ 'exact', 'degraded', 'unavailable', 'unknown' ], conf))
		conf = 'unknown';

	var confLabel = {
		exact: _('精确'),
		degraded: _('降级'),
		unavailable: _('不可用'),
		unknown: _('未知')
	}[conf];

	var detail = _('记账可信度：') + confLabel;
	var advice = [];

	if (reasons.length > 0)
		detail += ' · ' + reasons.length + ' ' + _('条原因');

	for (var i = 0; i < reasons.length; i++)
		advice.push(reasonTag(reasons[i]) + '：' + reasonBody(reasons[i]));

	if (conf === 'exact')
		return mk('ok', _('记账状态'), detail, advice);

	if (conf === 'degraded')
		return mk('warn', _('记账状态'), detail, advice.length ? advice : [ _('查看 health.reasons 的具体原因') ]);

	if (conf === 'unavailable')
		return mk('fail', _('记账状态'), detail,
			advice.length ? advice : [ _('clash 与 conntrack 两路都失败：按「数据源」一节的建议逐项排查') ]);

	return mk('warn', _('记账状态'), detail,
		[ _('守护进程还没写出可信度：确认服务运行且完成首轮轮询') ]);
}

function checkFreshness(stateRes) {
	if (stateRes.ok !== true)
		return mk('fail', _('数据新鲜度'),
			_('没有状态快照，无法判断新鲜度'),
			[ _('确认 traffic-statsd 正在运行：/etc/init.d/traffic-statsd status') ]);

	var state = stateRes.data;
	var ts = num(state != null ? state.ts : 0);

	if (!(ts > 0))
		return mk('fail', _('数据新鲜度'),
			_('state.ts 缺失或为 0（守护进程还没写出第一轮快照）'),
			[
				_('确认守护进程已运行并完成第一轮轮询：logread -e traffic-stats'),
				_('状态文件在 tmpfs，重启后需要一轮轮询才会重新出现')
			]);

	var now = Math.floor(Date.now() / 1000);
	var age = now - ts;

	if (age > STALE_SEC)
		return mk('warn', _('数据新鲜度'),
			_('数据已 ') + fmtSpan(age) + _(' 未更新（阈值 ') + STALE_SEC + _(' 秒）'),
			[
				_('查看守护进程是否卡住：logread -e traffic-stats'),
				_('确认配置里的 poll_interval 没有被调得过大'),
				_('确认 clash / conntrack 采集没有长时间超时')
			]);

	if (age < -60)
		return mk('warn', _('数据新鲜度'),
			_('state.ts 在未来 ') + fmtSpan(-age) + _('（系统时间可能不对）'),
			[ _('校准系统时间（ntpd / sysntpd）后重新检查') ]);

	return mk('ok', _('数据新鲜度'), _('数据新鲜（') + fmtAge(age) + '）', []);
}

function checkLink(stateRes) {
	var state = (stateRes.ok === true) ? stateRes.data : null;
	var health = (state != null && state.health != null && typeof state.health == 'object') ? state.health : null;

	if (health == null)
		return mk('warn', _('接入判定'),
			_('状态快照里没有 health 段，无法判断无线/有线归类'),
			[ _('确认 traffic-statsd 与 rpcd 插件版本一致后重启服务') ]);

	var source = (text(health.link_source) === 'brctl') ? 'brctl' : 'none';
	var bridge = text(health.link_bridge);
	var ports = Array.isArray(health.link_ports) ? health.link_ports.length : 0;
	var entries = num(health.link_entries);
	var linkError = text(health.link_error);

	if (source !== 'brctl') {
		var advice = [
			_('在「设置」里确认 LAN 网桥名（lan_bridge）与无线端口（wireless_ports）'),
			linkError.length > 0 ? _('后端报告：') + linkError : null,
			_('确认已安装 brctl 且能读取网桥 FDB：brctl showmacs <网桥>')
		];

		return mk('warn', _('接入判定'),
			_('未配置或读不到桥 FDB，无线/有线归类不可用') +
				(bridge.length > 0 ? '（' + _('网桥 ') + bridge + '）' : ''),
			advice);
	}

	if (!(entries > 0))
		return mk('warn', _('接入判定'),
			_('网桥 ') + bridge + _(' 的 FDB 为空，暂时没有可归类的无线/有线条目'),
			[
				_('确认无线客户端已关联且网桥端口正常：brctl showmacs ' + bridge),
				_('若刚启动，等一轮 link_refresh 后再重新检查')
			]);

	return mk('ok', _('接入判定'),
		_('来源 brctl · 网桥 ') + bridge + _(' · 无线上联端口 ') + ports +
			_(' 个 · FDB ') + entries + _(' 条'),
		[]);
}

function checkFiles(historyRes, dailyRes) {
	var days = (historyRes.ok === true && historyRes.data != null && Array.isArray(historyRes.data.days))
		? historyRes.data.days : [];
	var truncated = (historyRes.ok === true && historyRes.data != null && historyRes.data.truncated === true);
	var withSummary = 0;

	for (var i = 0; i < days.length; i++) {
		var item = days[i];

		if (item != null && item.summary != null && item.summary.totals != null)
			withSummary++;
	}

	var dailyExists = (dailyRes.ok === true && hasKeys(dailyRes.data));
	var detail = _('历史 ') + days.length + ' / ' + HISTORY_DAYS + ' ' + _('天') + ' · ' +
		withSummary + ' ' + _('天带汇总') + ' · ' +
		_('今日 daily ') + (dailyExists ? _('已生成') : _('缺失'));

	if (truncated) detail += ' · ' + _('服务端已裁剪');

	var advice = [];

	if (historyRes.ok !== true)
		advice.push(_('读取 get_history 失败：') + historyRes.error);

	if (dailyRes.ok !== true)
		advice.push(_('读取 get_daily 失败：') + dailyRes.error);

	if (days.length === 0)
		advice.push(_('检查 /etc/traffic-stats/daily 目录是否存在且可读（文件权限 644 / 属主 root）'));

	if (days.length < HISTORY_DAYS)
		advice.push(_('保留天数可能不足：确认 retention 的 daily_days 没有过早删文件（uci show traffic-stats.retention）'));

	if (!dailyExists)
		advice.push(_('当天文件通常在日切后才写出；history.json 在 tmpfs，重启会清空当日桶'));

	if (days.length === 0 && !dailyExists)
		return mk('warn', _('历史 / 每日文件'),
			_('没有历史或每日数据文件'), advice);

	if (days.length < HISTORY_DAYS || !dailyExists)
		return mk('warn', _('历史 / 每日文件'), detail, advice);

	return mk('ok', _('历史 / 每日文件'), detail, []);
}

function checkNodes(nodesRes, stationsRes) {
	var list = (nodesRes.ok === true && nodesRes.data != null && Array.isArray(nodesRes.data.nodes))
		? nodesRes.data.nodes : [];
	var st = (stationsRes.ok === true) ? stationsRes.data : null;
	var apEnabled = (st != null && st.enabled === true);
	var apNodes = (st != null && Array.isArray(st.nodes)) ? st.nodes.length : 0;
	var apCount = (st != null && Array.isArray(st.stations)) ? st.count : 0;
	var apText = (stationsRes.ok !== true)
		? _('AP 数据读取失败')
		: (apEnabled
			? _('AP ') + apNodes + _(' 个 · 站点 ') + num(apCount) + _(' 个')
			: _('AP 上报未启用'));

	if (nodesRes.ok !== true)
		return mk('warn', _('节点 / AP'),
			_('读取 get_nodes 失败：') + nodesRes.error,
			[ _('确认 /etc/traffic-stats/nodes 可读，或先在子节点配置推送') ]);

	var apAdvice = (stationsRes.ok !== true)
		? [ _('读取 get_stations 失败：') + stationsRes.error ]
		: [];

	if (list.length === 0) {
		if (apAdvice.length > 0)
			return mk('warn', _('节点 / AP'),
				_('未启用（没有子节点上报快照）') + ' · ' + apText, apAdvice);

		return mk('ok', _('节点 / AP'),
			_('未启用（没有子节点上报快照）') + ' · ' + apText,
			[]);
	}

	var ages = [];

	for (var i = 0; i < list.length; i++) {
		var age = num(list[i] != null ? list[i].age_sec : -1);

		if (age >= 0) ages.push(age);
	}

	var detail = _('子节点 ') + list.length + _(' 个');

	if (ages.length > 0) {
		var newest = Math.min.apply(null, ages);
		var oldest = Math.max.apply(null, ages);

		detail += ' · ' + _('最新上报 ') + fmtAge(newest) + ' · ' + _('最旧上报 ') + fmtAge(oldest);

		if (newest > NODE_STALE_SEC)
			return mk('warn', _('节点 / AP'),
				detail + ' · ' + apText,
				[
					_('子节点快照超过 ') + fmtSpan(NODE_STALE_SEC) + _(' 未更新：检查子节点的推送任务与网络'),
					_('确认母节点 /etc/traffic-stats/nodes 目录可读')
				].concat(apAdvice));
	}
	else {
		detail += ' · ' + _('快照没有可信时间戳');
	}

	detail += ' · ' + apText;

	if (ages.length === 0)
		return mk('warn', _('节点 / AP'), detail,
			[ _('子节点快照缺少可信 ts：确认子节点时钟正确并重新推送') ].concat(apAdvice));

	if (apAdvice.length > 0)
		return mk('warn', _('节点 / AP'), detail, apAdvice);

	return mk('ok', _('节点 / AP'), detail, []);
}

function checkDevices(stateRes) {
	if (stateRes.ok !== true)
		return mk('warn', _('设备'),
			_('没有状态快照，无法统计设备'),
			[ _('确认 traffic-statsd 正在运行：/etc/init.d/traffic-statsd status') ]);

	var state = stateRes.data;
	var devices = (state != null && Array.isArray(state.devices)) ? state.devices : [];
	var now = Math.floor(Date.now() / 1000);
	var online = 0;
	var unknownLink = 0;
	var noMac = 0;

	for (var i = 0; i < devices.length; i++) {
		var dev = devices[i];

		if (dev == null) continue;

		var lastSeen = num(dev.last_seen);
		var mac = text(dev.mac).trim();
		var link = text(dev.link).trim();

		if (lastSeen > 0 && (now - lastSeen) <= ONLINE_SEC) online++;
		if (link.length === 0 || link === 'unknown') unknownLink++;
		if (mac.length === 0) noMac++;
	}

	var total = devices.length;

	if (total === 0)
		return mk('warn', _('设备'),
			_('暂无设备记录'),
			[
				_('守护进程完成第一轮轮询后才会出现设备'),
				_('确认 LAN 网段识别正常（数据源一节的 conntrack 建议）')
			]);

	var detail = _('在线 ') + online + _(' · 离线 ') + (total - online) +
		_(' · 共 ') + total + _(' · 未知接入 ') + unknownLink + _(' · 无 MAC ') + noMac;
	var advice = [];

	if (state.truncated === true)
		advice.push(_('后端为控制报文体积裁剪了设备列表，以上统计基于已加载的部分'));

	if (noMac > 0)
		advice.push(_('核对 DHCP 租约（/tmp/dhcp.leases）与 conntrack 能否看到客户端 IP'));

	if (noMac > 0)
		return mk('warn', _('设备'), detail, advice.concat([
			_('无 MAC 的设备只能按 IP 识别，在线判定与别名匹配会不稳定')
		]));

	return mk('ok', _('设备'), detail, advice);
}

function checkVersion(statusRes) {
	if (statusRes.ok !== true)
		return mk('warn', _('版本 / 兼容'),
			_('无法读取后端版本'),
			[ _('确认 rpcd 插件可用：ubus call traffic-stats status') ]);

	var version = text(statusRes.data != null ? statusRes.data.version : '');

	if (version.length === 0)
		return mk('warn', _('版本 / 兼容'),
			_('后端没有上报版本号'),
			[ _('后端可能过旧：重新安装 traffic-stats 与 luci-app-traffic-stats 后再检查') ]);

	if (version === EXPECTED_VERSION)
		return mk('ok', _('版本 / 兼容'), _('前后端版本一致（') + version + '）', []);

	return mk('warn', _('版本 / 兼容'),
		_('版本不一致：页面期望 ') + EXPECTED_VERSION + _('，后端上报 ') + version,
		[
			_('先强制刷新浏览器（Ctrl+F5）或清理 LuCI 缓存后重进本页'),
			_('若仍不一致，说明 luci-app-traffic-stats 与 traffic-stats 版本不匹配，请一并重装'),
			_('升级后重启 rpcd 与 traffic-statsd 再检查')
		]);
}

function buildChecks(data) {
	return [
		checkService(data.status),
		checkSources(data.state),
		checkAccounting(data.state),
		checkFreshness(data.state),
		checkLink(data.state),
		checkFiles(data.history, data.daily),
		checkNodes(data.nodes, data.stations),
		checkDevices(data.state),
		checkVersion(data.status)
	];
}

function countLevels(checks) {
	var counts = { ok: 0, warn: 0, fail: 0 };

	for (var i = 0; i < checks.length; i++) {
		var level = checks[i].level;

		if (counts[level] == null) level = 'warn';

		counts[level]++;
	}

	return counts;
}

// ---------------------------------------------------------------- 视图

return view.extend({
	checks: null,
	data: null,
	checkedAt: null,
	running: false,

	load: function() {
		return this.runChecks();
	},

	runChecks: function() {
		var self = this;

		if (self.running === true) return Promise.resolve(self.checks);

		self.running = true;
		self.paintBusy();

		var today = dayKey(new Date());

		return Promise.all([
			grab(callStatus()),
			grab(callState()),
			grab(callHistory(HISTORY_DAYS)),
			grab(callDaily(today)),
			grab(callNodes()),
			grab(callStations())
		]).then(function(results) {
			self.data = {
				status: results[0],
				state: results[1],
				history: results[2],
				daily: results[3],
				nodes: results[4],
				stations: results[5]
			};
			self.checks = buildChecks(self.data);
			self.checkedAt = new Date();
			self.running = false;

			if (self.root != null)
				self.paint();

			return self.checks;
		}, function(err) {
			/* Promise.all 里 grab 不会 reject；这里是兜底，避免页面停在「检查中」 */
			self.running = false;
			self.checks = [ mk('fail', _('自检'), _('自检失败：') + errText(err),
				[ _('刷新页面后重试') ]) ];
			self.checkedAt = new Date();

			if (self.root != null)
				self.paint();

			return self.checks;
		});
	},

	render: function() {
		var self = this;

		this.sumOk = E('strong', { 'class': 'tsd-n-ok' }, '0');
		this.sumWarn = E('strong', { 'class': 'tsd-n-warn' }, '0');
		this.sumFail = E('strong', { 'class': 'tsd-n-fail' }, '0');
		this.sumEl = E('div', {
			'class': 'tsd-sum',
			'role': 'status',
			'aria-live': 'polite'
		}, [
			this.sumOk, ' ' + _('通过'),
			E('span', { 'class': 'tsd-sep' }, '/'),
			this.sumWarn, ' ' + _('注意'),
			E('span', { 'class': 'tsd-sep' }, '/'),
			this.sumFail, ' ' + _('失败')
		]);
		this.timeEl = E('span', { 'class': 'tsd-time' }, '');
		this.btn = E('button', {
			'type': 'button',
			'class': 'cbi-button cbi-button-action tsd-btn',
			'click': function(ev) {
				if (ev != null && typeof ev.preventDefault == 'function') ev.preventDefault();

				return self.runChecks();
			}
		}, _('重新检查'));
		this.listEl = E('div', { 'class': 'tsd-list' });

		this.root = E('div', { 'id': 'ts-diagnostics' }, [
			E('style', {}, CSS),
			E('div', { 'class': 'tsd-head' }, [
				E('h2', { 'class': 'tsd-title-main' }, _('流量统计 · 诊断')),
				E('p', { 'class': 'tsd-sub' }, [
					_('只读检查，不会修改任何配置。'),
					E('a', {
						'class': 'tsd-panel-link',
						href: L.url('admin/services/traffic-stats/panel'),
						target: '_blank',
						rel: 'noopener noreferrer',
						title: _('在新标签页打开详细面板')
					}, _('详细面板 ↗'))
				])
			]),
			E('div', { 'class': 'tsd-toolbar' }, [ this.sumEl, this.timeEl, this.btn ]),
			this.listEl,
			E('p', { 'class': 'tsd-foot' },
				_('本页只调用 status / get_state / get_history / get_daily / get_nodes / get_stations 六个只读接口，不写配置、不执行命令。'))
		]);

		this.paint();

		return this.root;
	},

	paintBusy: function() {
		if (this.btn != null) {
			this.btn.disabled = true;
			this.btn.textContent = _('检查中…');
		}
	},

	paint: function() {
		if (this.root == null) return;

		var checks = Array.isArray(this.checks) ? this.checks : [];
		var counts = countLevels(checks);

		this.sumOk.textContent = '' + counts.ok;
		this.sumWarn.textContent = '' + counts.warn;
		this.sumFail.textContent = '' + counts.fail;

		this.timeEl.textContent = (this.checkedAt != null)
			? _('最后检查：') + stampText(this.checkedAt)
			: _('尚未检查');

		if (this.btn != null) {
			this.btn.disabled = (this.running === true);
			this.btn.textContent = (this.running === true) ? _('检查中…') : _('重新检查');
		}

		clear(this.listEl);

		for (var i = 0; i < checks.length; i++)
			this.listEl.appendChild(this.renderItem(checks[i]));
	},

	renderItem: function(check) {
		var children = [
			E('div', { 'class': 'tsd-row' }, [
				E('i', { 'class': 'tsd-dot', 'aria-hidden': 'true' }),
				E('div', { 'class': 'tsd-body' }, [
					E('div', { 'class': 'tsd-name' }, [
						check.title,
						E('span', { 'class': 'tsd-badge' }, levelLabel(check.level))
					]),
					E('p', { 'class': 'tsd-detail' }, check.detail)
				])
			])
		];
		var advice = this.renderAdvice(check);

		/* 只把非空节点放进子节点列表（不依赖内核/框架对 null 的容忍）。 */
		if (advice != null)
			children.push(advice);

		return E('div', {
			'class': 'tsd-item tsd-' + check.level,
			'data-check': check.title
		}, children);
	},

	renderAdvice: function(check) {
		if (!Array.isArray(check.advice) || check.advice.length === 0)
			return null;

		var tips = E('ul', { 'class': 'tsd-tips' });

		for (var i = 0; i < check.advice.length; i++)
			tips.appendChild(E('li', {}, check.advice[i]));

		var box = E('details', { 'class': 'tsd-advice' }, [
			E('summary', {}, _('建议') + '（' + check.advice.length + '）'),
			tips
		]);

		/* 失败项默认展开建议，注意/通过项折叠。 */
		if (check.level === 'fail')
			box.open = true;

		return box;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
