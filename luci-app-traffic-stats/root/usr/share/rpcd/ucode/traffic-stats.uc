#!/usr/bin/env ucode
// SPDX-License-Identifier: Apache-2.0
//
// luci-app-traffic-stats —— rpcd ucode 插件（ubus 对象名 "traffic-stats"）
//
// 只做"读文件 + 转发动作"，不采集、不常驻：
//   * /tmp/traffic-stats/state.json    由 traffic-statsd 每 5s 原子写入
//   * /tmp/traffic-stats/history.json  当日 5 分钟桶
//   * /etc/traffic-stats/daily/*.json  每日汇总
//   * /etc/traffic-stats/nodes/*.json  子节点快照（子母多节点汇总，由 CGI 写入）
//   * /etc/traffic-stats/stations/<node_id>.json
//                                      哑桥 AP 的无线站点元数据（由 traffic-stats-stations CGI 写入）。
//                                      **只有 mac/iface/signal/rx_rate/tx_rate/connected_sec，没有字节**，
//                                      所以这里绝不投影任何字节字段（前端只用信号列）。
//
// 两条硬约束（真机实测，见 docs/SPEC.md 的 rpcd 约定）：
//   1. 任何文件缺失 / JSON 半截 / UCI 缺失都必须返回空结构，不能让 ubus 调用报错；
//   2. ubus 单条消息上限 262144 字节（实测：>256 KiB 返回 "Operation not supported"），
//      所以 get_state 必须在服务端裁剪，否则几百 KB 的 state.json 会直接打挂这次调用。
//      这里按 180 KiB 的 JSON 长度预算逐级降级，并在返回体里带 truncated 标记。
//
// 现场调试（不依赖 ARGV —— rpcd 内嵌 VM 里没有 ARGV，引用未声明变量在 strict 模式下
// 会直接 Reference error，所以走环境变量）：
//   TRAFFIC_STATS_METHOD=status        ucode -L /usr/lib/ucode traffic-stats.uc
//   TRAFFIC_STATS_METHOD=get_history TRAFFIC_STATS_ARGS='{"days":7}' ucode -L /usr/lib/ucode traffic-stats.uc
//   TRAFFIC_STATS_METHOD=set_config  TRAFFIC_STATS_ARGS='{"section":"settings","options":"{\"poll_interval\":\"9\"}"}' ...
//
'use strict';

import { readfile, access, glob, popen, basename, writefile, rename, chmod, chown, unlink, mkdir, rmdir, stat } from 'fs';
import { cursor } from 'uci';

/* 测试钩子（生产环境不要设置）：把读/写的固定路径换成 fixture 目录，
   容器门禁才能在不碰真机、不污染 /etc 的前提下跑别名往返与配额计算。 */
function env_or(name, fallback) {
	const value = getenv(name);

	if (value == null || length(value) == 0)
		return fallback;

	return value;
}

const UCI_BIN      = '/sbin/uci';
const CURL_BIN     = '/usr/bin/curl';
const OPENSSL_BIN  = '/usr/bin/openssl';

const UCI_CONFIG   = 'traffic-stats';
const CONFIG_FILE  = '/etc/config/traffic-stats';
const STATE_FILE   = env_or('TRAFFIC_STATS_STATE_FILE', '/tmp/traffic-stats/state.json');
const HISTORY_FILE = '/tmp/traffic-stats/history.json';
const DAILY_DIR    = env_or('TRAFFIC_STATS_DAILY_DIR', '/etc/traffic-stats/daily');
const NODES_DIR    = '/etc/traffic-stats/nodes';
const STATIONS_DIR = '/etc/traffic-stats/stations';
/* 设备别名/分组/首次出现（traffic-statsd 与 rpcd 共用的唯一权威文件，SPEC §10.1） */
const DEVICES_FILE = env_or('TRAFFIC_STATS_DEVICES_FILE', '/etc/traffic-stats/devices.json');
const INIT_SCRIPT  = '/etc/init.d/traffic-statsd';
const VERSION      = '1.0.0';

/* 别名/分组单字段字节上限（与守护进程 DEVICE_META_TEXT_MAX 一致） */
const DEVICE_TEXT_MAX = 128;
/* 当月用量的聚合上限：设备条目、CSV 行数（防止脏数据撑爆 ubus 报文） */
const MONTH_DEVICE_MAX = 1024;
const CSV_MAX_ROWS     = 200;
/* 当月起止缓存的复用窗口（秒）：前端每 5s 轮询 get_state，别每次都读 31 个 daily 文件 */
const MONTH_CACHE_SECONDS = 20;

const CSV_BOM = chr(0xef) + chr(0xbb) + chr(0xbf);

const PID_FILES = [ '/var/run/traffic-statsd.pid', '/var/run/traffic-stats.pid' ];

/* get_state 的裁剪预算：ubus 上限 262144B，留出 blobmsg / JSON-RPC 封装余量。 */
const STATE_BUDGET = 180 * 1024;
/* get_history 的预算：30/31 天 + 当天 288 个 5 分钟桶也必须装得下。 */
const HISTORY_BUDGET = 180 * 1024;
const HISTORY_MAX_BUCKETS = 400;

/* devices.json 写锁：ucode 没有 flock，用 mkdir 的原子性互斥；有限重试 +
   陈旧锁回收，避免一个崩溃的写者让另一个永久卡住。 */
const DEVICE_LOCK_STALE_SECONDS = 25;
const DEVICE_LOCK_RETRY_MS = 25;
const DEVICE_LOCK_RETRIES = 60;

/* 裁剪档位：[设备数, 每设备应用数, 顶层应用数]，按顺序取第一个放得下的档位。 */
const STATE_SHAPES = [
	[ 200, 30, 400 ],
	[ 200, 10, 200 ],
	[ 120,  8, 120 ],
	[  60,  6,  60 ],
	[  30,  5,  30 ],
	[  15,  0,  15 ],
	[   8,  0,   8 ]
];

/* get_nodes 的裁剪档位：[节点数, 每节点设备数, 每节点应用数]。 */
const NODE_SHAPES = [
	[ 50, 20, 20 ],
	[ 24, 20, 20 ],
	[ 12, 10, 10 ],
	[  6,  5,  5 ],
	[  6,  0,  0 ]
];

/* get_stations 的裁剪档位：站点行数上限（每行 ~120 字节，400 行约 48 KB）。 */
const STATION_SHAPES = [ 400, 200, 100, 50, 0 ];

/* 允许前端写入的 UCI 字段白名单（不开放任意 UCI 写）。 */
const UCI_FIELDS = {
	settings: [
		'enabled', 'poll_interval', 'clash_api', 'clash_secret', 'fake_ip_ranges', 'history_days',
		/* 接入方式（无线 / 有线）判定：桥名 + 无线上联端口 + AP 的 LAN MAC + FDB 刷新间隔 */
		'lan_bridge', 'wireless_ports', 'ap_macs', 'link_refresh',
		/* 子母多节点汇总（settings 页暂未提供输入框，先开放给后续页面/脚本复用） */
		'node_id', 'node_name', 'mother_url', 'mother_secret', 'mother_enabled',
		/* 旧共享协议仅作短期迁移；新部署应注册 config node/station 的独立凭证。 */
		'legacy_shared_secret', 'legacy_stations_token',
		'mother_ca', 'mother_pinned_sha256', 'stations_ca', 'stations_pinned_sha256',
		/* 哑桥 AP 无线站点元数据上报（stations.uc 读，母节点 ingest-stations.uc 校验） */
		'stations_enabled', 'stations_token', 'station_ifaces',
		/* 软路由自身性能指标：是否采集 + 用哪个接口算 WAN 速率 */
		'system_enabled', 'wan_iface',
		/* 月配额（SPEC §10.2）：get_state 只给字节数，剩余量/百分比由前端算 */
		'quota_mode', 'quota_monthly_gb', 'quota_total_gb',
		/* Prometheus 指标导出（SPEC §10.3）：/cgi-bin/traffic-stats-metrics */
		'metrics_enabled', 'metrics_token'
	],
	/* 数据/日志保留策略（retention.uc 消费） */
	retention: [ 'enabled', 'daily_days', 'nodes_days', 'stations_days',
	             'log_days', 'log_max_kb', 'spool_max_kb', 'dry_run' ],
	feishu:   [ 'enabled', 'webhook', 'secret', 'daily_time', 'report_chat_enabled',
	             'app_id', 'app_secret', 'chat_id', 'card_wrapper',
	             /* 内容 / 时间 / 条件可配（feishu.uc 1.1.0） */
	             'report_items', 'report_mode', 'report_time', 'report_weekday',
	             'alert_app_daily_limit', 'alert_spike_ratio', 'alert_offline_min',
	             'alert_cpu_pct', 'alert_mem_pct', 'alert_disk_pct', 'alert_quiet_hours' ]
};

// ---------------------------------------------------------------- 小工具

function text(value, fallback) {
	return (value == null) ? fallback : `${value}`;
}

function integer(value, fallback) {
	if (value == null)
		return fallback;

	const n = int(value);

	/* int() 对非数字返回 NaN；NaN != NaN，用它判定可避免依赖 ucode-mod-math。 */
	return (n != n) ? fallback : n;
}

function clamp(n, lo, hi) {
	return (n < lo) ? lo : ((n > hi) ? hi : n);
}

function member(list, value) {
	for (let item in list)
		if (item == value)
			return true;
	return false;
}

/* 接入方式枚举固定 wifi|wired|unknown；缺字段/脏值 -> ''（前端显示 "-"）。 */
function link_kind(value) {
	const v = text(value, '');
	return member([ 'wifi', 'wired', 'unknown' ], v) ? v : '';
}

/* 无线上联端口列表：只收 0..65535 的整数，去重并截断（防止脏 state 撑爆 ubus 消息）。 */
function link_ports(value) {
	const out = [];

	if (type(value) != 'array')
		return out;

	for (let i = 0; i < length(value) && i < 32; i++) {
		const p = integer(value[i], -1);

		if (p < 0 || p > 65535 || member(out, p))
			continue;

		push(out, p);
	}

	return out;
}

function shellquote(s) {
	return `'${replace(`${s}`, "'", "'\\''")}'`;
}

/* 读 JSON 文件：缺失 / 读失败 / 半截 JSON 一律返回 null，绝不抛给 ubus。 */
function read_json(path) {
	let raw = null;

	try {
		raw = readfile(path);
	}
	catch (e) {
		return null;
	}

	if (type(raw) != 'string' || length(raw) == 0)
		return null;

	try {
		const parsed = json(raw);
		return (type(parsed) == 'object' || type(parsed) == 'array') ? parsed : null;
	}
	catch (e) {
		return null;
	}
}

/* UCI 读：cursor() 不带参数（官方 ddns.uc / luci.upnp 的写法）；配置缺失时
   cursor().get() 返回 null 而不是报错，正好满足"没装后端也能开页面"。 */
function uci_get(section, option, fallback) {
	let c = null;

	try {
		c = cursor();
	}
	catch (e) {
		return fallback;
	}

	if (c == null)
		return fallback;

	const value = c.get(UCI_CONFIG, section, option);
	return (value == null) ? fallback : value;
}

function uci_flag(section, option, fallback) {
	const v = uci_get(section, option, null);
	if (v == null)
		return fallback;
	return int(v) != 0;
}

function poll_interval() {
	return clamp(integer(uci_get('settings', 'poll_interval', 5), 5), 1, 3600);
}

function day_of(ts) {
	const t = localtime(ts);
	return sprintf('%04d-%02d-%02d', t.year, t.mon, t.mday);
}

/* 严格校验 YYYY-MM-DD（日历日期，不接受 2026-13-40 这种「格式正确但非法」的值）。 */
function valid_day(value) {
	const s = text(value, '');

	if (match(s, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) == null)
		return false;

	const y = integer(substr(s, 0, 4), 0);
	const m = integer(substr(s, 5, 2), 0);
	const d = integer(substr(s, 8, 2), 0);

	if (y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1)
		return false;

	const mdays = [ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 ];
	let maxd = mdays[m - 1];

	if (m == 2 && ((y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)))
		maxd = 29;

	return d <= maxd;
}

function daemon_running(raw, poll) {
	const ts = integer(raw?.ts, 0);

	/* 首要判据：state.json 够新（守护进程活着并且在写）。 */
	if (ts > 0 && (time() - ts) <= max(30, poll * 6))
		return true;

	/* 兜底 1：init 脚本 / procd 留下的 pid 文件。 */
	for (let path in PID_FILES) {
		const pid = integer(trim(text(readfile(path), '')), 0);

		if (pid > 0 && system([ 'kill', '-0', `${pid}` ]) == 0)
			return true;
	}

	/* 兜底 2：进程名（刚启动还没写出第一份 state 时）。 */
	if (system([ 'sh', '-c', 'pidof traffic-statsd >/dev/null 2>&1' ]) == 0)
		return true;

	return false;
}

// ---------------------------------------------------------------- state 归一化

function empty_summary() {
	return {
		ts: 0,
		uptime: 0,
		source: { clash: 'unknown', conntrack: 'unknown' },
		totals: {
			direct_rx: 0, direct_tx: 0,
			proxy_rx: 0, proxy_tx: 0,
			wifi_rx: 0, wifi_tx: 0,
			wired_rx: 0, wired_tx: 0,
			unknown_rx: 0, unknown_tx: 0,
			rx_rate: 0, tx_rate: 0,
			/* 当月合计（rx+tx）：由 build_state 用 daily/ 汇总后填，state.json 里没有这个键 */
			month_total: 0
		},
		nodes: {},
		/* 软路由自身性能指标；守护进程不写时为空对象，前端按缺字段处理 */
		system: {},
		health: {
			accounting_confidence: 'unknown',
			reasons: [],
			conntrack_count: 0,
			clash_connections: 0,
			clash_poll_ms: 0,
			clash_deduped: 0,
			link_source: 'none',
			link_bridge: '',
			link_ports: [],
			link_ports_from: 'none',
			link_entries: 0,
			link_refresh: 0,
			link_error: ''
		}
	};
}

/* 把 state.json 投影成"字段一定齐全"的汇总部分（不含 devices / apps）。 */
function state_summary(raw) {
	const out = empty_summary();

	if (raw == null || type(raw) != 'object')
		return out;

	out.ts = integer(raw.ts, 0);
	out.uptime = integer(raw.uptime, 0);

	if (type(raw.source) == 'object') {
		out.source.clash = text(raw.source.clash, 'unknown');
		out.source.conntrack = text(raw.source.conntrack, 'unknown');
	}

	if (type(raw.totals) == 'object')
		for (let key in keys(out.totals))
			out.totals[key] = integer(raw.totals[key], 0);

	/* 软路由性能指标：按"只放标量、最多 32 键"透传，未知结构一律丢弃，避免前端拿到脏数据
	   或把 ubus 报文撑大。字段集合由守护进程决定，这里不做枚举，新增指标无需再改本文件。 */
	if (type(raw.system) == 'object') {
		const sys = {};
		let n = 0;

		for (let k in raw.system) {
			if (n++ >= 32)
				break;

			const v = raw.system[k];
			const t = type(v);

			if (t == 'int' || t == 'double' || t == 'string' || t == 'bool')
				sys[k] = v;
		}

		out.system = sys;
	}

	if (type(raw.nodes) == 'object') {
		const nodes = {};

		for (let name, node in raw.nodes)
			if (type(node) == 'object')
				nodes[name] = { rx: integer(node.rx, 0), tx: integer(node.tx, 0) };

		out.nodes = nodes;
	}

	if (type(raw.health) == 'object') {
		const h = raw.health;
		let conf = text(h.accounting_confidence, 'unknown');

		if (!member([ 'exact', 'degraded', 'unavailable', 'unknown' ], conf))
			conf = 'unknown';

		out.health.accounting_confidence = conf;
		out.health.conntrack_count = integer(h.conntrack_count, 0);
		out.health.clash_connections = integer(h.clash_connections, 0);
		out.health.clash_poll_ms = integer(h.clash_poll_ms, 0);
		/* 双源去重跳过数（clash 已计的 conntrack 流）；老 state 没有该键时为 0。 */
		out.health.clash_deduped = integer(h.clash_deduped, 0);

		/* 接入方式（与 direct/proxy 正交）：状态透传给前端，缺字段时保持默认值。 */
		out.health.link_source = (text(h.link_source, 'none') == 'brctl') ? 'brctl' : 'none';
		out.health.link_bridge = text(h.link_bridge, '');
		out.health.link_ports = link_ports(h.link_ports);
		out.health.link_ports_from = text(h.link_ports_from, 'none');
		out.health.link_entries = integer(h.link_entries, 0);
		out.health.link_refresh = integer(h.link_refresh, 0);
		out.health.link_error = text(h.link_error, '');

		const reasons = [];

		if (type(h.reasons) == 'array')
			for (let i = 0; i < length(h.reasons) && i < 10; i++)
				if (type(h.reasons[i]) == 'string')
					push(reasons, h.reasons[i]);

		out.health.reasons = reasons;
	}

	return out;
}

function device_total(dev) {
	return integer(dev?.direct_rx, 0) + integer(dev?.direct_tx, 0)
	     + integer(dev?.proxy_rx, 0) + integer(dev?.proxy_tx, 0);
}

function app_total(app) {
	return integer(app?.rx, 0) + integer(app?.tx, 0);
}

function project_device(dev, max_apps, view) {
	const out = {
		ip: text(dev?.ip, ''),
		mac: text(dev?.mac, ''),
		hostname: text(dev?.hostname, ''),
		link: link_kind(dev?.link),
		direct_rx: integer(dev?.direct_rx, 0),
		direct_tx: integer(dev?.direct_tx, 0),
		proxy_rx: integer(dev?.proxy_rx, 0),
		proxy_tx: integer(dev?.proxy_tx, 0),
		rx_rate: integer(dev?.rx_rate, 0),
		tx_rate: integer(dev?.tx_rate, 0),
		last_seen: integer(dev?.last_seen, 0),
		apps: {}
	};

	/* 别名 / 分组 / 首次出现 / 当月用量：由 device_view() 预先算好，这里只查表
	   （state 归一化这一段不能前向引用后面那节函数，见文件末尾的分类顺序）。 */
	let info = null;

	if (view != null) {
		let key = lc(trim(text(dev?.mac, '')));

		if (length(key) > 0) {
			if (view.by_mac[key] != null)
				info = view.by_mac[key];
			else if (view.by_mac[replace(key, '-', ':')] != null)
				info = view.by_mac[replace(key, '-', ':')];
		}

		if (info == null) {
			const ip = text(dev?.ip, '');

			if (length(ip) > 0 && view.by_ip[ip] != null)
				info = view.by_ip[ip];
		}
	}

	if (info != null) {
		if (info.alias != null)
			out.alias = info.alias;

		if (info.group != null)
			out.group = info.group;

		if (info.first_seen != null)
			out.first_seen = info.first_seen;
	}

	/* 当月用量：始终给数值（没有数据就是 0），前端自己算百分比/剩余。 */
	out.month_rx = (info != null) ? integer(info.month_rx, 0) : 0;
	out.month_tx = (info != null) ? integer(info.month_tx, 0) : 0;
	out.month_total = out.month_rx + out.month_tx;

	/* 单设备配额只在「配额模式=device 且配了 GB」时出现（字节）。 */
	const limit = (view != null) ? integer(view.quota_limit, 0) : 0;

	if (limit > 0)
		out.quota_limit = limit;

	if (max_apps <= 0 || type(dev?.apps) != 'object')
		return out;

	const items = [];

	for (let host, app in dev.apps)
		push(items, {
			host: text(host, ''),
			rx: integer(app?.rx, 0),
			tx: integer(app?.tx, 0),
			chain: text(app?.chain, '')
		});

	sort(items, (a, b) => app_total(b) - app_total(a));

	const kept = [];

	for (let i = 0; i < length(items) && i < max_apps; i++)
		push(kept, items[i]);

	/* "__other__" 是守护进程合并的长尾，可能恰好是最大的一项，永远保留。 */
	for (let app in items)
		if (app.host == '__other__' && !member(map(kept, a => a.host), '__other__'))
			push(kept, app);

	for (let app in kept)
		out.apps[app.host] = { rx: app.rx, tx: app.tx, chain: app.chain };

	if (length(items) > length(kept))
		out.apps_truncated = true;

	return out;
}

function project_app(app) {
	return {
		host: text(app?.host, ''),
		rx: integer(app?.rx, 0),
		tx: integer(app?.tx, 0),
		chain: text(app?.chain, ''),
		devices: integer(app?.devices, 0)
	};
}

/* 按预算裁剪 get_state 的返回体；返回体中 truncated=true 表示"服务端裁剪过"。
   view 是 device_view() 预先算好的投影表（别名/分组/首次出现/当月用量/配额），
   传 null 时行为与旧版完全一致（老调用方/单测不必构造它）。 */
function build_state(raw, running, view) {
	const out = state_summary(raw);

	out.running = running;
	out.devices = [];
	out.apps = [];
	out.truncated = false;

	/* 当月口径（SPEC §10.2）：state.json 本身一个字段都不改，只在返回体里补
	   totals.month_total 与 quota 段，老消费方零影响。 */
	out.totals.month_total = (view != null) ? integer(view.month_total, 0) : 0;
	out.quota = (view != null && type(view.quota) == 'object')
		? view.quota
		: { mode: 'none', monthly_gb: 0, total_gb: 0, device_limit: 0, total_limit: 0, period: '' };

	let devices = (type(raw?.devices) == 'array') ? raw.devices : [];
	let apps = (type(raw?.apps) == 'array') ? raw.apps : [];

	devices = sort(devices, (a, b) => device_total(b) - device_total(a));
	apps = sort(apps, (a, b) => app_total(b) - app_total(a));

	/* 半截 / null 条目直接丢掉，别让前端出现空白行。 */
	devices = filter(devices, dev =>
		type(dev) == 'object' && (length(text(dev?.ip, '')) || length(text(dev?.mac, ''))));
	apps = filter(apps, app => type(app) == 'object' && length(text(app?.host, '')));

	for (let shape in STATE_SHAPES) {
		const max_devices = shape[0], max_apps = shape[1], max_top = shape[2];

		out.devices = [];
		out.apps = [];

		for (let i = 0; i < length(devices) && i < max_devices; i++)
			push(out.devices, project_device(devices[i], max_apps, view));

		for (let i = 0; i < length(apps) && i < max_top; i++)
			push(out.apps, project_app(apps[i]));

		out.truncated = (length(devices) > max_devices) || (length(apps) > max_top)
		             || (max_apps < 30) || (max_top < 400);

		if (length(sprintf('%J', out)) <= STATE_BUDGET)
			return out;
	}

	/* 兜底：只给汇总，列表留空（前端会显示"数据过大已裁剪"）。 */
	out.devices = [];
	out.apps = [];
	out.truncated = true;

	return out;
}

// ---------------------------------------------------------------- 多节点快照

/* 子节点快照由 /www/cgi-bin/traffic-stats-ingest 写入，字段见 traffic-stats/files/ingest.uc。
   这里只做"读 + 归一化"：文件坏掉、字段缺失、类型不对都退回空结构，绝不抛错。 */

function node_totals(raw) {
	const out = {
		direct_rx: 0, direct_tx: 0,
		proxy_rx: 0, proxy_tx: 0,
		rx_rate: 0, tx_rate: 0
	};

	if (type(raw) == 'object')
		for (let key in keys(out))
			out[key] = integer(raw[key], 0);

	return out;
}

function node_nodes(raw) {
	const out = {};

	if (type(raw) != 'object')
		return out;

	for (let name, value in raw) {
		if (type(value) != 'object')
			continue;

		const label = text(name, '');

		if (length(label) == 0)
			continue;

		out[label] = { rx: integer(value.rx, 0), tx: integer(value.tx, 0) };
	}

	return out;
}

function node_devices(raw, max) {
	const out = [];

	if (type(raw) != 'array' || max <= 0)
		return out;

	for (let i = 0; i < length(raw) && i < max; i++) {
		const dev = raw[i];

		if (type(dev) != 'object')
			continue;

		push(out, {
			ip: text(dev.ip, ''),
			mac: text(dev.mac, ''),
			hostname: text(dev.hostname, ''),
			direct_rx: integer(dev.direct_rx, 0),
			direct_tx: integer(dev.direct_tx, 0),
			proxy_rx: integer(dev.proxy_rx, 0),
			proxy_tx: integer(dev.proxy_tx, 0),
			rx_rate: integer(dev.rx_rate, 0),
			tx_rate: integer(dev.tx_rate, 0),
			last_seen: integer(dev.last_seen, 0)
		});
	}

	return out;
}

function node_apps(raw, max) {
	const out = [];

	if (type(raw) != 'array' || max <= 0)
		return out;

	for (let i = 0; i < length(raw) && i < max; i++) {
		const app = raw[i];

		if (type(app) != 'object')
			continue;

		push(out, {
			host: text(app.host, ''),
			rx: integer(app.rx, 0),
			tx: integer(app.tx, 0),
			chain: text(app.chain, ''),
			devices: integer(app.devices, 0)
		});
	}

	return out;
}

function read_node(file) {
	const data = read_json(file);

	if (data == null || type(data) != 'object')
		return null;

	const node_id = text(data.node_id, replace(basename(file), /\.json$/, ''));

	if (length(node_id) == 0)
		return null;

	const ts = integer(data.ts, 0);
	const now = time();

	return {
		node_id: node_id,
		name: text(data.name, node_id),
		ts: ts,
		/* age_sec = -1 表示快照里没有可信时间戳（前端显示"—"并按过期处理）。 */
		age_sec: (ts > 0) ? max(0, now - ts) : -1,
		totals: node_totals(data.totals),
		nodes: node_nodes(data.nodes),
		devices: (type(data.devices) == 'array') ? data.devices : [],
		apps: (type(data.apps) == 'array') ? data.apps : []
	};
}

function build_nodes() {
	let files = glob(`${NODES_DIR}/*.json`) ?? [];

	files = sort(files ?? [], (a, b) => (a > b) ? -1 : ((a < b) ? 1 : 0));

	let list = [];

	for (let file in files) {
		const node = read_node(file);

		if (node != null)
			push(list, node);
	}

	list = sort(list, (a, b) => b.ts - a.ts);

	const out = { nodes: [] };

	/* 按预算逐级裁剪：ubus 单条消息 262144 字节，超了整个调用直接失败。 */
	for (let shape in NODE_SHAPES) {
		const max_nodes = shape[0], max_devices = shape[1], max_apps = shape[2];

		out.nodes = [];

		for (let i = 0; i < length(list) && i < max_nodes; i++) {
			const node = list[i];

			push(out.nodes, {
				node_id: node.node_id,
				name: node.name,
				ts: node.ts,
				age_sec: node.age_sec,
				latest: {
					totals: node.totals,
					nodes: node.nodes,
					devices: node_devices(node.devices, max_devices),
					apps: node_apps(node.apps, max_apps)
				}
			});
		}

		if (length(sprintf('%J', out)) <= STATE_BUDGET)
			return out;
	}

	return out;
}

// ---------------------------------------------------------------- 无线站点元数据

/* 哑桥 AP 只上报「无线侧元数据」：MAC / 接口 / 信号 / 协商速率 / 连接时长。
   **没有字节，也不应该有**——AP 是二层桥，字节由母节点的 conntrack 统计，
   AP 若也报字节就是重复计数（见 docs/AP-ROLE.md）。
   所以这里只投影上面这几个字段，前端按 MAC 索引后只用来显示「信号」列。 */

/* 信号：合法 dBm 范围 -120..0；缺省/越界 → null（前端显示 "-"）。 */
function station_signal(value) {
	const n = integer(value, null);

	if (n == null || n < -120 || n > 0)
		return null;

	return n;
}

/* 一台 AP 的站点行。行列里的 ts/age_sec 取该节点快照的时间，便于前端判断新鲜度。 */
function station_rows(raw, node_id, name, ts, age) {
	const out = [];

	if (type(raw) != 'array')
		return out;

	for (let i = 0; i < length(raw); i++) {
		const st = raw[i];

		if (type(st) != 'object')
			continue;

		const mac = lc(trim(text(st.mac, '')));

		if (!match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/))
			continue;

		push(out, {
			mac: mac,
			node_id: node_id,
			node_name: name,
			iface: text(st.iface, ''),
			signal: station_signal(st.signal),
			rx_rate: integer(st.rx_rate, 0),
			tx_rate: integer(st.tx_rate, 0),
			connected_sec: integer(st.connected_sec, 0),
			ts: ts,
			age_sec: age
		});
	}

	return out;
}

function read_station_snapshot(file) {
	const data = read_json(file);

	if (data == null || type(data) != 'object')
		return null;

	let node_id = trim(text(data.node_id, ''));

	if (length(node_id) == 0)
		node_id = replace(basename(file), /\.json$/, '');

	/* 文件名来自 CGI 的白名单校验；这里再挡一次，防手工丢进来的怪文件。 */
	if (!match(node_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
		return null;

	const ts = integer(data.ts, 0);
	const now = time();

	/* age_sec = -1 表示快照里没有可信时间戳。 */
	const age = (ts > 0) ? max(0, now - ts) : -1;

	return {
		node_id: node_id,
		name: text(data.name, node_id),
		ts: ts,
		age_sec: age,
		count: integer(data.count, 0),
		stations: (type(data.stations) == 'array') ? data.stations : []
	};
}

/* 返回 {enabled, nodes:[{node_id,name,ts,age_sec,count}], stations:[...], count}。
   文件缺失 / 坏了 / 字段错乱一律退化为空结构，绝不让 ubus 调用报错（同 get_nodes）。 */
function build_stations() {
	const enabled = uci_flag('settings', 'stations_enabled', false);
	const out = { enabled: enabled, nodes: [], stations: [], count: 0 };

	let files = glob(`${STATIONS_DIR}/*.json`) ?? [];

	files = sort(files, (a, b) => (a > b) ? -1 : ((a < b) ? 1 : 0));

	let snaps = [];

	for (let file in files) {
		const snap = read_station_snapshot(file);

		if (snap != null)
			push(snaps, snap);
	}

	snaps = sort(snaps, (a, b) => b.ts - a.ts);
	/* 按预算逐级裁剪：ubus 单条消息 262144 字节，超了整个调用直接失败。 */
	for (let i = 0; i < length(STATION_SHAPES); i++) {
		const cap = STATION_SHAPES[i];

		out.nodes = [];
		out.stations = [];

		for (let snap in snaps) {
			const rows = station_rows(snap.stations, snap.node_id, snap.name, snap.ts, snap.age_sec);

			push(out.nodes, {
				node_id: snap.node_id,
				name: snap.name,
				ts: snap.ts,
				age_sec: snap.age_sec,
				count: length(rows)
			});

			for (let row in rows) {
				if (length(out.stations) >= cap)
					break;

				push(out.stations, row);
			}
		}

		out.count = length(out.stations);

		if (length(sprintf('%J', out)) <= STATE_BUDGET)
			return out;
	}

	out.nodes = [];
	out.stations = [];
	out.count = 0;

	return out;
}

// ---------------------------------------------------------------- 动作

function is_root(request) {
	/* 严格判定：rpcd 会把会话用户放在 request.info.acl.user。缺失 / 非 root
	 * （包括 null、空串、guest）一律拒绝；调试入口自己构造 root 身份，见文件末尾。 */
	return request?.info?.acl?.user == 'root';
}

function curl_binary() {
	for (let path in [ CURL_BIN, '/usr/sbin/curl', '/bin/curl' ])
		if (access(path))
			return path;

	return null;
}

function feishu_sign(timestamp, secret) {
	const key = `${timestamp}\n${secret}`;
	const bin = access(OPENSSL_BIN) ? OPENSSL_BIN : 'openssl';
	const cmd = sprintf('%s dgst -sha256 -hmac %s -binary < /dev/null | %s base64 -A',
		bin, shellquote(key), bin);
	let fd = null;

	try {
		fd = popen(cmd);
	}
	catch (e) {
		return '';
	}

	if (fd == null)
		return '';

	const sign = trim(fd.read('all'));
	fd.close();

	return sign;
}

function feishu_payload(secret) {
	const timestamp = `${time()}`;
	const host = trim(text(readfile('/proc/sys/kernel/hostname'), '')) || 'OpenWrt';
	const payload = {
		msg_type: 'interactive',
		card: {
			schema: '2.0',
			header: {
				title: { tag: 'plain_text', content: '流量统计 · 测试消息' },
				template: 'blue'
			},
			body: {
				elements: [
					{
						tag: 'div',
						text: {
							tag: 'plain_text',
							content: `来自 ${host} 的 LuCI 流量统计插件。\n如果你看到这条消息，说明 webhook 与签名配置可用。`
						}
					},
					{
						tag: 'div',
						text: { tag: 'plain_text', content: `发送时间：${day_of(time())} ${sprintf('%02d:%02d:%02d', localtime(time()).hour, localtime(time()).min, localtime(time()).sec)}` }
					}
				]
			}
		}
	};

	if (length(secret)) {
		payload.timestamp = timestamp;
		payload.sign = feishu_sign(timestamp, secret);
	}

	return payload;
}

/* 二维码加群的机器人：列出它所在的群，供设置页选择 chat_id。
   直接复用 feishu.uc 的 chats 子命令，避免在 rpcd 里重复实现 Feishu API。 */
function feishu_chats() {
	const app_id = trim(text(uci_get('feishu', 'app_id', ''), ''));
	const app_secret = trim(text(uci_get('feishu', 'app_secret', ''), ''));

	if (!length(app_id) || !length(app_secret))
		return { ok: false, code: -1, msg: '请先填写 App ID / App Secret 并保存' };

	const script = '/usr/share/traffic-stats/feishu.uc';

	if (!access(script))
		return { ok: false, code: -1, msg: 'feishu.uc 未安装（重装 traffic-stats 包）' };

	let fd = null;

	try {
		fd = popen(sprintf('/usr/bin/ucode %s chats 2>&1', shellquote(script)));
	}
	catch (e) {
		return { ok: false, code: -1, msg: `执行失败：${e}` };
	}

	if (fd == null)
		return { ok: false, code: -1, msg: '执行失败' };

	const out = fd.read('all');
	fd.close();

	let list = [];
	let raw = trim(text(out, ''));

	for (let line in split(raw, '\n')) {
		let l = trim(line);
		let tab = index(l, '\t');

		if (tab <= 0)
			continue;

		let id = trim(substr(l, 0, tab));
		let name = trim(substr(l, tab + 1));

		if (length(id))
			push(list, { chat_id: id, name: name });
	}

	if (!length(list))
		return { ok: false, code: -1, msg: raw || '未获取到群列表（机器人是否已加群？）', raw: raw };

	return { ok: true, chats: list, raw: raw };
}

function test_feishu() {
	const webhook = trim(text(uci_get('feishu', 'webhook', ''), ''));
	const secret = trim(text(uci_get('feishu', 'secret', ''), ''));

	if (length(webhook) == 0)
		return { ok: false, code: -1, msg: '未配置飞书 webhook（设置 → 飞书）' };

	if (!match(webhook, /^https?:\/\/[^\s]+$/))
		return { ok: false, code: -1, msg: 'webhook 不是合法的 http(s) 地址' };

	if (length(secret) && !access(OPENSSL_BIN) && !access('/usr/sbin/openssl'))
		return { ok: false, code: -1, msg: '缺少 openssl，无法生成签名' };

	const curl = curl_binary();

	if (curl == null)
		return { ok: false, code: -1, msg: '缺少 curl，无法发送（opkg install curl）' };

	const payload = feishu_payload(secret);
	const cmd = sprintf('%s -sS -m 15 -H %s -d %s %s',
		curl,
		shellquote('Content-Type: application/json'),
		shellquote(sprintf('%J', payload)),
		shellquote(webhook));

	let fd = null;

	try {
		fd = popen(cmd);
	}
	catch (e) {
		return { ok: false, code: -1, msg: `执行 curl 失败：${e}` };
	}

	if (fd == null)
		return { ok: false, code: -1, msg: '执行 curl 失败' };

	const body = fd.read('all');
	fd.close();

	let res = null;

	try {
		res = json(body);
	}
	catch (e) {
		res = null;
	}

	if (type(res) != 'object')
		return { ok: false, code: -1, msg: `飞书返回非 JSON：${substr(trim(text(body, '')), 0, 200)}` };

	/* 自定义机器人：v2 返回 {code,msg}，旧版返回 {StatusCode,StatusMessage}。 */
	const code = integer(res.code ?? res.StatusCode, -1);
	const msg = text(res.msg ?? res.StatusMessage, '');

	return { ok: (code == 0), code: code, msg: msg };
}

function uci_run(args) {
	const cmd = [ UCI_BIN, '-q' ];

	for (let arg in args)
		push(cmd, arg);

	/* system() 的数组形式不经过 shell：值里的 $(...)、;、| 都只是普通字符。 */
	return system(cmd) == 0;
}

/** 只捕获输出、不经过用户数据：参数全部来自固定常量 / UCI 白名单。 */
function uci_capture(args) {
	let cmd = '';

	for (let arg in args)
		cmd += (length(cmd) ? ' ' : '') + shellquote(`${arg}`);

	try {
		const fd = popen(`${cmd} 2>/dev/null`);
		if (fd == null)
			return '';

		const out = fd.read('all');
		fd.close();

		return (out == null) ? '' : `${out}`;
	}
	catch (e) {
		return '';
	}
}

/** 当前 staged 的 UCI 变更集合：key = "section" 或 "section.option"，
 *  value = { action: "set"|"delete"|"list" }。
 *
 *  uci changes 的删除行形如 `-traffic-stats.settings.clash_secret`（没有 `=`）：
 *  旧实现只认 `key=value`，会把别人的 staged 删除当成「没有 staged」，
 *  失败回滚时 revert 掉这次 set，同时也把别人的删除意图一起清掉。
 *  这里显式解析前导 `-`，保留最后一行动作（uci delta 按输出顺序生效）。 */
function uci_changes() {
	const out = uci_capture([ UCI_BIN, '-q', 'changes', UCI_CONFIG ]);
	const map = {};
	const prefix = `${UCI_CONFIG}.`;

	for (let line in split(out, '\n')) {
		let s = trim(line);

		if (length(s) == 0)
			continue;

		let action = 'set';

		if (substr(s, 0, 1) == '-') {
			action = 'delete';
			s = trim(substr(s, 1));
		}
		else if (substr(s, 0, 1) == '+') {
			action = 'set';
			s = trim(substr(s, 1));
		}

		const eq = index(s, '=');
		let key = (eq < 0) ? s : trim(substr(s, 0, eq));

		if (length(key) == 0)
			continue;

		/* list 增量：key 末尾的 +/-（如 settings.lan_ranges+='x'）。 */
		const tail = substr(key, length(key) - 1, 1);

		if (action != 'delete' && (tail == '+' || tail == '-')) {
			action = 'list';
			key = substr(key, 0, length(key) - 1);
		}

		if (substr(key, 0, length(prefix)) == prefix)
			key = substr(key, length(prefix));
		else
			continue;

		if (length(key) > 0)
			map[key] = { action: action };
	}

	return map;
}

function uci_revert_section(section) {
	try {
		return system([ UCI_BIN, '-q', 'revert', `${UCI_CONFIG}.${section}` ]) == 0;
	}
	catch (e) {
		return false;
	}
}

function uci_revert_option(section, option) {
	try {
		return system([ UCI_BIN, '-q', 'revert', `${UCI_CONFIG}.${section}.${option}` ]) == 0;
	}
	catch (e) {
		return false;
	}
}

/* 不调用 shell 判断 section 是否存在：直接读 /etc/config/traffic-stats 的
 * `config <type> ['<name>']` 行。这样 set_config 全程只有 argv 数组，没有 sh -c。 */
function config_has_section(section) {
	let raw = null;

	try {
		raw = readfile(CONFIG_FILE);
	}
	catch (e) {
		return false;
	}

	if (type(raw) != 'string' || length(raw) == 0)
		return false;

	for (let line in split(raw, '\n')) {
		const s = trim(line);

		if (length(s) == 0 || substr(s, 0, 1) == '#')
			continue;

		const toks = [];

		for (let t in split(replace(s, '\t', ' '), ' '))
			if (t != '')
				push(toks, t);

		if (length(toks) < 2 || toks[0] != 'config')
			continue;

		let name = (length(toks) >= 3) ? toks[2] : '';

		if (length(name) >= 2) {
			const a = substr(name, 0, 1);
			const b = substr(name, length(name) - 1, 1);

			if ((a == "'" && b == "'") || (a == '"' && b == '"'))
				name = substr(name, 1, length(name) - 2);
		}

		if (name == section || (length(name) == 0 && toks[1] == section))
			return true;
	}

	return false;
}

function set_config(request) {
	if (!is_root(request))
		return { ok: false, error: 'permission denied' };

	if (!access(CONFIG_FILE))
		return { ok: false, error: `${CONFIG_FILE} 不存在，请先安装 traffic-statsd` };

	const section = text(request.args?.section, '');
	const allowed = UCI_FIELDS[section];

	if (allowed == null)
		return { ok: false, error: 'invalid section' };

	/* options 允许两种形态：JSON 字符串（默认，避开 rpcd 的表类型推断）或对象。 */
	let options = request.args?.options;

	if (type(options) == 'string') {
		try {
			options = json(options);
		}
		catch (e) {
			return { ok: false, error: 'options 不是合法 JSON' };
		}
	}

	if (type(options) != 'object')
		return { ok: false, error: 'invalid options' };

	/* 记录调用前的 staged 状态：失败时只能撤销「本次真正写过的 option」，
	 * 绝不能 uci revert 整个 config（会清掉别的写者/别的字段已 staged 的改动）。
	 * 对本来就 staged 的 option，保存旧值并在失败时放回，避免 revert 误清。 */
	const staged_before = uci_changes();
	let touched = [];
	let created_section = false;

	let restore = function() {
		const staged_after = uci_changes();

		/* 本次新建的 section：只要它仍是 staged 状态就整体撤销（section 内的
		 * 本次改动一并消失）；若 commit 失败但 section 已落盘，则不回滚已提交部分。 */
		if (created_section) {
			if (staged_after[section] != null) {
				uci_revert_section(section);
				return;
			}
		}

		for (let t in touched) {
			const key = `${section}.${t.option}`;

			/* 已 committed 的字段不再回滚（commit 失败也可能有部分已提交）。 */
			if (staged_after[key] == null)
				continue;

			/* 调用前这个 option 已经是「staged 删除」：本次 set 失败后必须重新
			 * uci delete，把删除意图放回去；否则 revert 会恢复已提交值，
			 * 静默清掉别人的 staged 删除。先 revert 掉本次 set/旧 delta，
			 * 再 delete，使最终 staged 状态只剩 -option。 */
			if (t.prev != null && t.prev.action == 'delete') {
				uci_revert_option(section, t.option);
				uci_run([ 'delete', `${UCI_CONFIG}.${section}.${t.option}` ]);
				continue;
			}

			if (t.was_staged && length(t.value) > 0)
				uci_run([ 'set', `${UCI_CONFIG}.${section}.${t.option}=${t.value}` ]);
			else
				uci_revert_option(section, t.option);
		}
	};

	let fail = function(msg) {
		restore();
		return { ok: false, error: msg };
	};

	/* section 不存在就建一个同名 section（uci set cfg.name=type），仍走 argv 数组。 */
	if (!config_has_section(section) && staged_before[section] == null) {
		if (!uci_run([ 'set', `${UCI_CONFIG}.${section}=${section}` ]))
			return { ok: false, error: `无法创建 section ${section}` };
		created_section = true;
	}

	let applied = 0;

	for (let key in keys(options)) {
		if (!member(allowed, key))
			continue;

		let value = options[key];

		/* ucode 的 type() 对布尔返回 'bool'，UCI 里统一写成 '1' / '0'。 */
		if (type(value) == 'bool')
			value = value ? '1' : '0';
		else if (value == null)
			continue;
		else
			value = `${value}`;

		if (length(value) > 1024)
			return fail(`字段 ${key} 过长`);

		const staged_key = `${section}.${key}`;
		const was_staged = staged_before[staged_key] != null;

		/* 旧值必须在 set 之前取（cursor 读取包含 staged 值，能保存别人的 staged 值）。 */
		const old_value = was_staged ? text(uci_get(section, key, ''), '') : '';

		if (!uci_run([ 'set', `${UCI_CONFIG}.${section}.${key}=${value}` ]))
			return fail(`写入 ${section}.${key} 失败`);

		push(touched, {
			option: key,
			was_staged: was_staged,
			value: old_value,
			prev: staged_before[staged_key] ?? null
		});
		applied++;
	}

	if (applied == 0)
		return fail('no valid options');

	if (!uci_run([ 'commit', UCI_CONFIG ]))
		return fail('uci commit 失败');

	return { ok: true };
}

// ---------------------------------------------------------------- 设备元数据 / 当月用量 / 配额
//
// 数据源（都不在 state.json 里，见 docs/SPEC.md §10）：
//   /etc/traffic-stats/devices.json   { "<mac>": { alias, group, first_seen } }
//   /etc/traffic-stats/daily/*.json   当月（1 号至今）每设备用量
//
// 三条硬约束：
//   1. 文件缺失 / 半截 JSON / 字段类型错一律退化成空结构，绝不抛给 ubus；
//   2. 写文件必须原子（临时文件 + rename），权限 0644 root:root；
//   3. 新增字段只在有值时出现（alias/group/quota_limit/first_seen），老前端无感。

/* UTF-8 安全截断：ucode 的 length() 是字节长度，直接 substr 会切断多字节码点。 */
function cut_text(s, maxb) {
	let v = `${s}`;

	if (length(v) <= maxb)
		return v;

	let n = maxb;

	while (n > 0 && (ord(substr(v, n, 1)) & 0xc0) == 0x80)
		n--;

	return substr(v, 0, n);
}

/* 单行文本：丢掉控制字符（含 \n / \t / \r）再 trim + 截断。
   别名/分组来自用户输入，落进 JSON 前必须清洗。 */
function clean_text(value, maxb) {
	const src = text(value, '');
	let out = '';

	for (let i = 0; i < length(src); i++) {
		const c = substr(src, i, 1);
		const n = ord(c);

		if (n < 0x20 || n == 0x7f)
			continue;

		out += c;
	}

	return cut_text(trim(out), maxb);
}

/* MAC 归一：大写 -> 小写、`-` -> `:`，非法返回 ''（state.json 里的 MAC 可能带大写）。 */
function norm_mac(value) {
	let m = lc(trim(text(value, '')));

	m = replace(m, '-', ':');

	if (length(m) != 17)
		return '';

	if (match(m, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/) == null)
		return '';

	return m;
}

/* 原子写 + 0644 root:root；同名临时文件带「秒 + clock 纳秒 + 进程内序号」，
   两个并发写者（守护进程 / 另一次 rpcd 调用）不会撞在同一个临时文件上。 */
let write_seq = 0;

function write_atomic(path, content) {
	write_seq++;
	const tmp = sprintf('%s.tmp.%d.%d.%d', path, time(), clock()[1], write_seq);

	try {
		const n = writefile(tmp, content);

		if (type(n) != 'int') {
			try { unlink(tmp); } catch (e) { }
			return false;
		}
	}
	catch (e) {
		try { unlink(tmp); } catch (e) { }
		return false;
	}

	try { chmod(tmp, 420); } catch (e) { }
	try { chown(tmp, 0, 0); } catch (e) { }

	if (rename(tmp, path))
		return true;

	try { unlink(tmp); } catch (e) { }

	return false;
}

/* devices.json 的 mkdir 互斥锁：多个 rpcd 进程 / 守护进程同时读改写时，
   只有拿到锁的写者能提交，避免「后写覆盖前写」丢更新。
   锁目录内写 owner（pid + 进程内唯一 token）；陈旧锁回收必须 rename 到自己的
   唯一 stale 路径，rename 成功者才删除，避免并发回收互删；释放校验 owner。
   协议必须与 traffic-statsd.uc 完全一致。 */
let lock_seq = 0;
let lock_pid = 0;
let lock_rnd = '';

function lock_owner_pid() {
	if (lock_pid > 0)
		return lock_pid;

	let txt = '';

	try { txt = `${readfile('/proc/self/stat') ?? ''}`; } catch (e) { txt = ''; }

	let n = 0;

	for (let i = 0; i < length(txt); i++) {
		const ch = substr(txt, i, 1);

		if (ch < '0' || ch > '9')
			break;

		n = n * 10 + ord(ch) - 48;
	}

	if (n <= 0)
		n = int(time() % 1000000) + 1;

	lock_pid = n;

	return lock_pid;
}

function lock_owner_nonce() {
	if (length(lock_rnd) > 0)
		return lock_rnd;

	try { lock_rnd = replace(trim(text(readfile('/proc/sys/kernel/random/uuid'), '')), '-', ''); }
	catch (e) { lock_rnd = ''; }

	if (length(lock_rnd) == 0)
		lock_rnd = sprintf('%d%d', int(time()), int(clock()[1]));

	return lock_rnd;
}

function lock_owner_token() {
	lock_seq++;

	return sprintf('%d|%d|%s|%d', lock_owner_pid(), int(time()), lock_owner_nonce(), lock_seq);
}

function device_lock_acquire(path) {
	const lock = `${path}.lock`;

	for (let i = 0; i < DEVICE_LOCK_RETRIES; i++) {
		if (mkdir(lock, 448)) {
			const token = lock_owner_token();
			let n = null;

			try { n = writefile(`${lock}/owner`, `${token}\n`); } catch (e) { n = null; }

			if (type(n) == 'int')
				return { path: lock, token: token };

			try { unlink(`${lock}/owner`); } catch (e) { }
			try { rmdir(lock); } catch (e) { }

			return null;
		}

		let st = null;

		try { st = stat(lock); } catch (e) { st = null; }

		if (st != null && (time() - integer(st.mtime, 0)) >= DEVICE_LOCK_STALE_SECONDS) {
			const stale = `${lock}.stale.${lock_owner_token()}`;

			if (rename(lock, stale)) {
				try { unlink(`${stale}/owner`); } catch (e) { }
				try { rmdir(stale); } catch (e) { }

				continue;
			}
		}

		sleep(DEVICE_LOCK_RETRY_MS);
	}

	return null;
}

function device_lock_release(lock) {
	if (lock == null)
		return false;

	const dir = (type(lock) == 'object') ? `${lock.path ?? ''}` : `${lock}`;
	const token = (type(lock) == 'object') ? `${lock.token ?? ''}` : '';

	if (length(dir) == 0)
		return false;

	let cur = null;

	try { cur = readfile(`${dir}/owner`); } catch (e) { cur = null; }

	if (length(token) > 0 && (cur == null || trim(`${cur}`) != token))
		return false;

	try { unlink(`${dir}/owner`); } catch (e) { }
	try { rmdir(dir); } catch (e) { }

	return true;
}

/* 读 devices.json -> { "<mac>": { alias?, group?, first_seen? } }。
   未知键、非法 MAC、非对象条目一律丢弃；first_seen 只收正整数。 */
function devices_meta_read() {
	const out = {};
	const raw = read_json(DEVICES_FILE);

	if (raw == null || type(raw) != 'object')
		return out;

	let n = 0;

	for (let key, value in raw) {
		const mac = norm_mac(key);

		if (length(mac) == 0 || type(value) != 'object')
			continue;

		const entry = {};
		const alias = clean_text(value.alias, DEVICE_TEXT_MAX);
		const group = clean_text(value.group, DEVICE_TEXT_MAX);
		const seen = integer(value.first_seen, 0);

		if (length(alias))
			entry.alias = alias;

		if (length(group))
			entry.group = group;

		if (seen > 0)
			entry.first_seen = seen;

		if (length(keys(entry)) > 0)
			out[mac] = entry;

		/* 文件被手工塞爆时，别让一次 get_state 读几千条 */
		if (++n >= MONTH_DEVICE_MAX)
			break;
	}

	return out;
}

function devices_meta_write(meta) {
	return write_atomic(DEVICES_FILE, `${sprintf('%J', meta)}\n`);
}

/* 当月用量：从 daily/YYYY-MM-DD.json 汇总「1 号至今」。
   返回 { month: "YYYY-MM", rx, tx, days, devices: { "m:<mac>"|"i:<ip>": {rx,tx} } }。

   边界（门禁会验）：
     * 只认文件名里年月等于**当前本地月**的文件 -> 上个月、其它月的文件不会被算进来；
     * 文件名日期 > 今天（时钟错乱产生的未来文件）跳过；
     * 坏 JSON / 半截文件跳过，不影响其它天；
     * 设备键优先用 MAC（state.json 的 MAC 可能为空，此时退回 IP）。 */
function month_entry_key(dev) {
	const mac = norm_mac(dev?.mac);

	if (length(mac) > 0)
		return `m:${mac}`;

	const ip = trim(text(dev?.ip, ''));

	if (match(ip, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/) != null)
		return `i:${ip}`;

	return '';
}

function month_scan(month, today) {
	const out = { month: month, rx: 0, tx: 0, days: 0, devices: {} };

	let files = [];

	try {
		files = glob(`${DAILY_DIR}/${month}-[0-9][0-9].json`) ?? [];
	}
	catch (e) {
		files = [];
	}

	files = sort(files ?? []);

	for (let file in files) {
		const day = replace(basename(file), /\.json$/, '');

		/* 非法日期 / 未来日期 / 文件内日期与文件名不一致：一律跳过。 */
		if (!valid_day(day) || day > today)
			continue;

		const data = read_json(file);

		if (data == null || type(data) != 'object')
			continue;

		const file_day = text(data.day, '');

		if (length(file_day) > 0 && file_day != day)
			continue;

		let rx = 0, tx = 0, used_rows = false, has_totals = false;

		/* 总账以 daily 的 totals 为准：devices 数组在守护进程里最多 200 行，
		 * 用截断后的设备行求和会低估当月总用量。
		 * 只有 totals 里真的有有效 rx/tx（哪怕都是 0）或 direct/proxy 拆分时，
		 * 才认为总账可用；空对象 {} 必须回退到设备行，否则老文件会丢整月用量。 */
		if (type(data.totals) == 'object') {
			const t = data.totals;
			const has_rx = (t.rx != null && integer(t.rx, -1) >= 0);
			const has_tx = (t.tx != null && integer(t.tx, -1) >= 0);
			const has_split = (t.direct_rx != null || t.direct_tx != null
				|| t.proxy_rx != null || t.proxy_tx != null);

			if (has_rx || has_tx || has_split) {
				rx = has_rx ? max(0, integer(t.rx, 0)) : 0;
				tx = has_tx ? max(0, integer(t.tx, 0)) : 0;

				if (has_split && !has_rx && !has_tx) {
					rx = max(0, integer(t.direct_rx, 0)) + max(0, integer(t.proxy_rx, 0));
					tx = max(0, integer(t.direct_tx, 0)) + max(0, integer(t.proxy_tx, 0));
				}

				has_totals = true;
			}
		}

		/* 每设备用量仍从 devices 行汇总（这是唯一有设备维度的数据）；
		 * 老文件没有 totals 时，总账才退回设备行求和。 */
		if (type(data.devices) == 'array') {
			for (let dev in data.devices) {
				if (type(dev) != 'object')
					continue;

				const drx = max(0, integer(dev.rx, 0));
				const dtx = max(0, integer(dev.tx, 0));
				const key = month_entry_key(dev);

				if (length(key) > 0) {
					let slot = out.devices[key];

					if (slot == null && length(keys(out.devices)) < MONTH_DEVICE_MAX) {
						slot = { rx: 0, tx: 0 };
						out.devices[key] = slot;
					}

					if (slot != null) {
						slot.rx += drx;
						slot.tx += dtx;
					}
				}

				if (!has_totals) {
					rx += drx;
					tx += dtx;
				}
				used_rows = true;
			}
		}

		if (!has_totals && !used_rows)
			continue;

		out.rx += max(0, rx);
		out.tx += max(0, tx);
		out.days++;
	}

	return out;
}


/* 20 秒缓存：key 含「年月 + 今天」，跨天/跨月自动失效（不做时间旅行假设）。 */
let month_cache = { key: '', ts: 0, data: null };

function month_usage(now) {
	const t = localtime(now);
	const month = sprintf('%04d-%02d', t.year, t.mon);
	const today = sprintf('%04d-%02d-%02d', t.year, t.mon, t.mday);
	const key = `${month}|${today}`;

	if (month_cache.data != null && month_cache.key == key
		&& (now < month_cache.ts || (now - month_cache.ts) <= MONTH_CACHE_SECONDS))
		return month_cache.data;

	const data = month_scan(month, today);

	month_cache = { key: key, ts: now, data: data };

	return data;
}

/* 单台设备的当月用量：MAC 命中优先，其次 IP；都没有就是 0（不猜）。 */
function month_device(month, dev) {
	const mac = norm_mac(dev?.mac);

	if (length(mac) > 0 && month?.devices?.[`m:${mac}`] != null)
		return month.devices[`m:${mac}`];

	const ip = trim(text(dev?.ip, ''));

	if (length(ip) > 0 && month?.devices?.[`i:${ip}`] != null)
		return month.devices[`i:${ip}`];

	return { rx: 0, tx: 0 };
}

/* GB（可带小数，如 0.5 / 50）-> 字节；'' 或非法 -> 0（= 不限制）。
   ucode 没有 double()，用算术强制转换；非法输入得到 NaN，用 n != n 判定。 */
function gb_bytes(value) {
	const s = trim(text(value, ''));

	if (length(s) == 0)
		return 0;

	const n = s * 1;

	if (n != n || n < 0)
		return 0;

	const capped = (n > 1048576) ? 1048576 : n;   /* 上限 1 PiB，防配置写飞 */

	return int(capped * 1073741824 + 0.5);
}

/* 配额配置（UCI settings 段）-> { mode, monthly_gb, total_gb, device_limit, total_limit }。
   mode 非法/缺省一律 none；只有 mode 命中且数值 > 0 时才给出 *_limit（字节）。 */
function quota_config() {
	const raw_mode = lc(trim(text(uci_get('settings', 'quota_mode', 'none'), 'none')));
	const mode = member([ 'none', 'device', 'total' ], raw_mode) ? raw_mode : 'none';

	const monthly_text = trim(text(uci_get('settings', 'quota_monthly_gb', ''), ''));
	const total_text = trim(text(uci_get('settings', 'quota_total_gb', ''), ''));
	const out = {
		mode: mode,
		monthly_gb: length(monthly_text) ? (monthly_text * 1) : 0,
		total_gb: length(total_text) ? (total_text * 1) : 0,
		device_limit: 0,
		total_limit: 0
	};

	if (out.monthly_gb != out.monthly_gb || out.monthly_gb < 0)
		out.monthly_gb = 0;

	if (out.total_gb != out.total_gb || out.total_gb < 0)
		out.total_gb = 0;

	if (mode == 'device')
		out.device_limit = gb_bytes(monthly_text);

	if (mode == 'total')
		out.total_limit = gb_bytes(total_text);

	return out;
}

/* 时间戳 -> 本地 "YYYY-MM-DD HH:MM:SS"（0/缺失 -> 空串）。 */
function datetime_of(ts) {
	const n = integer(ts, 0);

	if (n <= 0)
		return '';

	const t = localtime(n);

	return sprintf('%04d-%02d-%02d %02d:%02d:%02d', t.year, t.mon, t.mday, t.hour, t.min, t.sec);
}

/* 把「devices.json 元数据 + 当月用量 + 配额」算成一张按 MAC / IP 可查的表。
   build_state / project_device（定义在本节之前）只做查表，不再引用本节函数。 */
function device_view(raw) {
	const meta = devices_meta_read();
	const month = month_usage(time());
	const quota = quota_config();

	const view = {
		month_total: month.rx + month.tx,
		quota: {
			mode: quota.mode,
			monthly_gb: quota.monthly_gb,
			total_gb: quota.total_gb,
			device_limit: quota.device_limit,
			total_limit: quota.total_limit,
			period: month.month
		},
		quota_limit: quota.device_limit,
		by_mac: {},
		by_ip: {}
	};

	const devices = (type(raw?.devices) == 'array') ? raw.devices : [];

	for (let dev in devices) {
		if (type(dev) != 'object')
			continue;

		const mac = norm_mac(dev.mac);
		const raw_mac = lc(trim(text(dev.mac, '')));
		const ip = trim(text(dev.ip, ''));

		if (length(mac) == 0 && length(raw_mac) == 0 && length(ip) == 0)
			continue;

		const entry = (length(mac) > 0) ? (meta[mac] ?? null) : null;
		const used = month_device(month, dev);
		const info = {
			month_rx: used.rx,
			month_tx: used.tx,
			month_total: used.rx + used.tx
		};

		if (entry != null) {
			if (entry.alias != null)
				info.alias = entry.alias;

			if (entry.group != null)
				info.group = entry.group;

			if (entry.first_seen != null)
				info.first_seen = entry.first_seen;
		}

		if (length(mac) > 0)
			view.by_mac[mac] = info;

		if (length(raw_mac) > 0)
			view.by_mac[raw_mac] = info;

		if (length(ip) > 0)
			view.by_ip[ip] = info;
	}

	return view;
}


// ---------------------------------------------------------------- CSV 导出
//
// 约定（SPEC §10.3）：
//   * 首字节是 UTF-8 BOM（Excel 双击打开中文不乱码）；
//   * 行尾 CRLF；字段含 逗号/引号/换行 时按 RFC 4180 加引号并把内部引号翻倍；
//   * 文本字段以 = + - @ 开头时前面加一个 '（防 Excel 公式注入 —— 主机名/别名是
//     设备侧不可信输入，不能让 CSV 在别人电脑上执行公式）；
//   * 数值字段不加引号、不加前缀。

function csv_text(value) {
	let s = text(value, '');
	const first = substr(s, 0, 1);

	if (member([ '=', '+', '-', '@', '\t', '\r' ], first))
		s = `'${s}`;

	if (index(s, '"') >= 0 || index(s, ',') >= 0 || index(s, '\n') >= 0 || index(s, '\r') >= 0)
		s = `"${replace(s, '"', '""')}"`;

	return s;
}

function csv_num(value) {
	return sprintf('%d', integer(value, 0));
}

function daily_totals(data) {
	let rx = 0, tx = 0;

	if (type(data?.totals) == 'object') {
		rx = integer(data.totals.rx, 0);
		tx = integer(data.totals.tx, 0);

		if (rx == 0 && tx == 0) {
			rx = integer(data.totals.direct_rx, 0) + integer(data.totals.proxy_rx, 0);
			tx = integer(data.totals.direct_tx, 0) + integer(data.totals.proxy_tx, 0);
		}
	}

	return { rx: max(0, rx), tx: max(0, tx) };
}

function export_csv(request) {
	const what = lc(trim(text(request.args?.what, 'devices')));

	if (!member([ 'devices', 'apps', 'daily' ], what))
		return { ok: false, error: 'invalid what (devices|apps|daily)' };

	const now = time();
	const raw = read_json(STATE_FILE);
	const meta = devices_meta_read();
	const month = month_usage(now);

	let header = [];
	const rows = [];

	if (what == 'devices') {
		header = [ '主机名', 'IP', 'MAC', '别名', '分组', '接入',
			'直连下载', '直连上传', '代理下载', '代理上传', '合计',
			'本月下载', '本月上传', '本月合计', '首次出现' ];

		let list = (type(raw?.devices) == 'array') ? raw.devices : [];

		list = sort(filter(list, dev => type(dev) == 'object'),
			(a, b) => device_total(b) - device_total(a));

		for (let i = 0; i < length(list) && i < CSV_MAX_ROWS; i++) {
			const dev = list[i];
			const mac = norm_mac(dev.mac);
			const info = (length(mac) > 0) ? meta[mac] : null;
			const used = month_device(month, dev);

			push(rows, join(',', [
				csv_text(dev.hostname), csv_text(dev.ip), csv_text(mac),
				csv_text(info?.alias), csv_text(info?.group), csv_text(link_kind(dev.link)),
				csv_num(dev.direct_rx), csv_num(dev.direct_tx),
				csv_num(dev.proxy_rx), csv_num(dev.proxy_tx), csv_num(device_total(dev)),
				csv_num(used.rx), csv_num(used.tx), csv_num(used.rx + used.tx),
				csv_text(datetime_of(info?.first_seen))
			]));
		}
	}
	else if (what == 'apps') {
		header = [ '应用', '出口链路', '下载', '上传', '合计', '设备数' ];

		let list = (type(raw?.apps) == 'array') ? raw.apps : [];

		list = sort(filter(list, app => type(app) == 'object'),
			(a, b) => app_total(b) - app_total(a));

		for (let i = 0; i < length(list) && i < CSV_MAX_ROWS; i++) {
			const app = list[i];

			push(rows, join(',', [
				csv_text(app.host), csv_text(app.chain),
				csv_num(app.rx), csv_num(app.tx), csv_num(app_total(app)),
				csv_num(app.devices)
			]));
		}
	}
	else {
		header = [ '日期', '下载', '上传', '合计', '设备数' ];

		let files = [];

		try {
			files = glob(`${DAILY_DIR}/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json`) ?? [];
		}
		catch (e) {
			files = [];
		}

		files = sort(files ?? []);
		let list = [];

		for (let file in files) {
			const data = read_json(file);

			if (data == null || type(data) != 'object')
				continue;

			const totals = daily_totals(data);

			push(list, {
				day: replace(basename(file), /\.json$/, ''),
				rx: totals.rx,
				tx: totals.tx,
				devices: (type(data.devices) == 'array') ? length(data.devices) : 0
			});
		}

		if (length(list) > CSV_MAX_ROWS)
			list = slice(list, length(list) - CSV_MAX_ROWS, length(list));

		for (let entry in list)
			push(rows, join(',', [
				csv_text(entry.day), csv_num(entry.rx), csv_num(entry.tx),
				csv_num(entry.rx + entry.tx), csv_num(entry.devices)
			]));
	}

	let csv = `${CSV_BOM}${join(',', map(header, csv_text))}\r\n`;

	for (let row in rows)
		csv += `${row}\r\n`;

	return {
		ok: true,
		what: what,
		filename: sprintf('traffic-stats-%s-%s.csv', what, day_of(now)),
		rows: length(rows),
		csv: csv
	};
}

/* set_device_meta {mac, alias, group}：
     * alias / group 缺省 = 不改；显式给空串 = 清除该字段；
     * 三个字段都没了（且没有 first_seen）就把这个 MAC 整条删掉，文件不留空壳；
     * first_seen 由守护进程写，这里原样保留，绝不覆盖。 */
function set_device_meta(request) {
	if (!is_root(request))
		return { ok: false, error: 'permission denied' };

	const args = request.args ?? {};
	const mac = norm_mac(args.mac);

	if (length(mac) == 0)
		return { ok: false, error: 'invalid mac' };

	const has_alias = (args.alias != null);
	const has_group = (args.group != null);

	if (!has_alias && !has_group)
		return { ok: false, error: 'nothing to update (alias / group)' };

	/* 两个写者（本 rpcd 调用 / 守护进程 first_seen）必须真正互斥：
	 * 拿锁 -> 重读 -> 只改自己的键 -> 原子写 -> 放锁。拿不到锁就快速失败，
	 * 让上层重试，绝不无锁覆盖别人的更新。 */
	const lock = device_lock_acquire(DEVICES_FILE);

	if (lock == null)
		return { ok: false, error: '设备元数据忙，请重试' };

	const meta = devices_meta_read();
	const entry = meta[mac] ?? {};

	if (has_alias) {
		const alias = clean_text(args.alias, DEVICE_TEXT_MAX);

		if (length(alias)) entry.alias = alias;
		else delete entry.alias;
	}

	if (has_group) {
		const group = clean_text(args.group, DEVICE_TEXT_MAX);

		if (length(group)) entry.group = group;
		else delete entry.group;
	}

	if (length(keys(entry)) > 0)
		meta[mac] = entry;
	else
		delete meta[mac];

	const ok = devices_meta_write(meta);

	device_lock_release(lock);

	if (!ok)
		return { ok: false, error: `写入 ${DEVICES_FILE} 失败` };

	return {
		ok: true,
		mac: mac,
		alias: entry?.alias ?? '',
		group: entry?.group ?? '',
		devices: length(keys(meta))
	};
}


// ---------------------------------------------------------------- ubus 方法表

/* get_history 的桶瘦身：前端趋势图只需要时间戳与四个方向的字节数；
   top_apps/top_devices 是每日文件里的重字段，30 天一起返回会撑爆 ubus。 */
function history_bucket_slim(b) {
	if (type(b) != 'object')
		return null;

	const out = { ts: integer(b.ts, 0) };
	const fields = [
		'direct_rx', 'direct_tx', 'proxy_rx', 'proxy_tx',
		'wifi_rx', 'wifi_tx', 'wired_rx', 'wired_tx',
		'unknown_rx', 'unknown_tx'
	];

	for (let k in fields)
		if (b[fields[k]] != null)
			out[fields[k]] = integer(b[fields[k]], 0);

	return out;
}

/* 往日 daily 只保留前端实际会用的轻量 summary：totals + 几个计数。
   绝不把 devices[] / apps[] 原样塞进 get_history（30 天 × 200 设备会远超预算）。 */
function history_summary_light(data, day) {
	const t = daily_totals(data);
	const totals = { rx: t.rx, tx: t.tx };
	const src = (type(data?.totals) == 'object') ? data.totals : {};
	const split = [ 'direct_rx', 'direct_tx', 'proxy_rx', 'proxy_tx',
		'wifi_rx', 'wifi_tx', 'wired_rx', 'wired_tx', 'unknown_rx', 'unknown_tx' ];
	let has_split = false;

	for (let k in split) {
		if (src[split[k]] != null) {
			totals[split[k]] = max(0, integer(src[split[k]], 0));
			has_split = true;
		}
	}

	/* 老 daily 只有 rx/tx：归入 direct，保证趋势图总量不丢。 */
	if (!has_split) {
		totals.direct_rx = t.rx;
		totals.direct_tx = t.tx;
		totals.proxy_rx = 0;
		totals.proxy_tx = 0;
	}

	return {
		day: day,
		ts: integer(data?.ts, 0),
		totals: totals,
		devices: (type(data?.devices) == 'array') ? length(data.devices) : 0,
		apps: (type(data?.apps) == 'array') ? length(data.apps) : 0,
		nodes: (type(data?.nodes) == 'object') ? length(keys(data.nodes)) : 0
	};
}

const methods = {
	status: {
		call: function(request) {
			const raw = read_json(STATE_FILE);
			const summary = state_summary(raw);

			return {
				enabled: uci_flag('settings', 'enabled', true),
				running: daemon_running(raw, poll_interval()),
				confidence: summary.health.accounting_confidence,
				sources: {
					clash: summary.source.clash,
					conntrack: summary.source.conntrack
				},
				/* 接入方式判定状态（设置页/概览页用来提示"FDB 读不到"或"未配置端口"） */
				link_source: summary.health.link_source,
				link_bridge: summary.health.link_bridge,
				link_ports: summary.health.link_ports,
				link_ports_from: summary.health.link_ports_from,
				version: VERSION,
				/* 能力探测而非读取密钥：供没有 L.env.acls 的 LuCI 隐藏写入口。 */
				can_manage: is_root(request)
			};
		}
	},

	get_state: {
		call: function(request) {
			const raw = read_json(STATE_FILE);
			const poll = poll_interval();

			/* view = 别名/分组/首次出现/当月用量/配额（只在服务端算一次） */
			return build_state(raw, daemon_running(raw, poll), device_view(raw));
		}
	},

	get_nodes: {
		call: function(request) {
			try {
				return build_nodes();
			}
			catch (e) {
				/* 多节点页面挂了也不能影响概览/设备页：异常一律退回空结构。 */
				return { nodes: [] };
			}
		}
	},

	/* 哑桥 AP 上报的无线站点元数据（按 MAC 索引由前端做）。空态/坏文件都返回空结构。 */
	get_stations: {
		call: function(request) {
			try {
				return build_stations();
			}
			catch (e) {
				return { enabled: false, nodes: [], stations: [], count: 0 };
			}
		}
	},

	get_history: {
		args: { days: 1 },
		call: function(request) {
			const days = clamp(integer(request.args?.days, 1), 1, 31);

			let out = [];
			const seen = {};
			const today = day_of(time());

			const history = read_json(HISTORY_FILE);

			if (history != null && type(history.buckets) == 'array') {
				const day = text(history.day, today);

				/* 未来日期 / 非法日期一律不返回，避免时钟错乱时前端出现"明天"。 */
				if (valid_day(day) && day <= today) {
					let list = history.buckets;

					if (length(list) > HISTORY_MAX_BUCKETS)
						list = slice(list, length(list) - HISTORY_MAX_BUCKETS, length(list));

					const buckets = [];

					for (let b in list) {
						const slim = history_bucket_slim(b);

						if (slim != null)
							push(buckets, slim);
					}

					push(out, { day: day, buckets: buckets });
					seen[day] = true;
				}
			}

			/* 历史日：每天一个文件，文件名就是日期。新的在前。 */
			let files = glob(`${DAILY_DIR}/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json`) ?? [];

			files = sort(files, (a, b) => (a > b) ? -1 : ((a < b) ? 1 : 0));

			for (let file in files) {
				if (length(out) >= days)
					break;

				const day = replace(basename(file), /\.json$/, '');

				if (!valid_day(day) || day > today || seen[day] == true)
					continue;

				const data = read_json(file);

				if (data == null || type(data) != 'object')
					continue;

				const file_day = text(data.day, '');

				if (length(file_day) > 0 && file_day != day)
					continue;

				/* summary 只保留 totals 和计数；devices/apps 明细不随 get_history 下发。 */
				push(out, {
					day: day,
					buckets: [],
					summary: history_summary_light(data, day)
				});
				seen[day] = true;
			}

			/* 连 history.json 都没有时，用今天的 daily 文件兜底。 */
			if (length(out) == 0) {
				const data = read_json(`${DAILY_DIR}/${today}.json`);

				if (data != null && type(data) == 'object')
					push(out, { day: today, buckets: [], summary: history_summary_light(data, today) });
			}

			/* ubus 单条消息上限 262144B：按 180KiB 预算逐级瘦身，并带 truncated 标志。
			   桶默认已只保留 ts + 字节数，正常 31 天 + 288 桶远小于预算；这里仍
			   保留兜底，防止脏 history.json 把整个调用打挂。 */
			let truncated = false;
			let enc = sprintf('%J', { days: out, truncated: truncated });

			for (let limit in [ 96, 48, 24, 12, 0 ]) {
				if (length(enc) <= HISTORY_BUDGET)
					break;

				for (let d in out) {
					if (length(d.buckets) > limit) {
						d.buckets = slice(d.buckets, length(d.buckets) - limit, length(d.buckets));
						truncated = true;
					}
				}

				enc = sprintf('%J', { days: out, truncated: truncated });
			}

			/* 仍超预算：优先保留最近的天数，并明确标记截断。 */
			while (length(enc) > HISTORY_BUDGET && length(out) > 1) {
				out = slice(out, 0, length(out) - 1);
				truncated = true;
				enc = sprintf('%J', { days: out, truncated: truncated });
			}

			return { days: out, truncated: truncated };
		}
	},

	get_daily: {
		args: { day: '' },
		call: function(request) {
			const day = text(request.args?.day, '');

			if (!match(day, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/))
				return {};

			const data = read_json(`${DAILY_DIR}/${day}.json`);

			if (data != null)
				return data;

			/* 当天还没落到 daily/ 时，用 history.json 的桶累加出一个当日汇总。 */
			const history = read_json(HISTORY_FILE);

			if (history != null && text(history.day, '') == day) {
				const out = {
					day: day,
					direct_rx: 0, direct_tx: 0,
					proxy_rx: 0, proxy_tx: 0,
					buckets: (type(history.buckets) == 'array') ? history.buckets : []
				};

				for (let bucket in out.buckets) {
					out.direct_rx += integer(bucket?.direct_rx, 0);
					out.direct_tx += integer(bucket?.direct_tx, 0);
					out.proxy_rx += integer(bucket?.proxy_rx, 0);
					out.proxy_tx += integer(bucket?.proxy_tx, 0);
				}

				return out;
			}

			return {};
		}
	},

	/* 设备别名 / 分组（SPEC §10.1）：写 /etc/traffic-stats/devices.json（原子写 0644）。
	   alias/group 缺省 = 不改；给空串 = 清除。返回 {ok, mac, alias, group, devices}。 */
	set_device_meta: {
		/* 参数策略必须声明：不声明时 ubus 会以 "Invalid argument" 拒绝**任何**参数；
		   而 rpcd 的 args 只支持 boolean/integer/string/array/object，写 null 会让整个
		   插件注册失败（"Skipping registration of ucode script"，真机实测）。
		   实测：rpcd 只把调用方真正传了的键放进 request.args —— 声明里的默认值不会替
		   缺省参数补位，所以「没传 = 不改、空串 = 清除」在 ubus 与调试入口下行为一致。 */
		args: { mac: '', alias: '', group: '' },
		call: function(request) {
			try {
				return set_device_meta(request);
			}
			catch (e) {
				return { ok: false, error: `${e}` };
			}
		}
	},

	/* CSV 导出（SPEC §10.3）：what = devices|apps|daily -> {ok, filename, rows, csv}。
	   返回文本自带 UTF-8 BOM 与 CRLF 行尾，前端只需把 csv 存成 .csv 文件即可。 */
	export_csv: {
		args: { what: 'devices' },
		call: function(request) {
			try {
				return export_csv(request);
			}
			catch (e) {
				return { ok: false, error: `${e}` };
			}
		}
	},

	feishu_chats: {
		call: function(request) {
			if (!is_root(request))
				return { ok: false, code: -1, msg: 'permission denied' };

			try {
				return feishu_chats();
			}
			catch (e) {
				return { ok: false, code: -1, msg: `${e}` };
			}
		}
	},

	test_feishu: {
		call: function(request) {
			if (!is_root(request))
				return { ok: false, code: -1, msg: 'permission denied' };

			try {
				return test_feishu();
			}
			catch (e) {
				return { ok: false, code: -1, msg: `${e}` };
			}
		}
	},

	set_config: {
		args: { section: 'settings', options: '{}' },
		call: function(request) {
			try {
				return set_config(request);
			}
			catch (e) {
				return { ok: false, error: `${e}` };
			}
		}
	},

	restart: {
		call: function(request) {
			if (!is_root(request))
				return { ok: false, error: 'permission denied' };

			if (!access(INIT_SCRIPT))
				return { ok: false, error: `${INIT_SCRIPT} 不存在，请先安装 traffic-statsd` };

			return { ok: (system([ INIT_SCRIPT, 'restart' ]) == 0) };
		}
	}
};

/* 命令行自测入口：只认环境变量，绝不碰 ARGV（rpcd 内嵌 VM 里没有这个全局）。 */
const debug_method = getenv('TRAFFIC_STATS_METHOD') ?? '';

if (length(debug_method)) {
	const method = methods[debug_method];

	if (method == null) {
		print(sprintf('%.3J\n', { error: 'unknown method', method: debug_method }));
		exit(1);
	}

	let args = {};
	const debug_args = getenv('TRAFFIC_STATS_ARGS') ?? '';

	if (length(debug_args)) {
		try {
			args = json(debug_args);
		}
		catch (e) {
			args = {};
		}
	}

	const result = method.call({ args: args, info: { acl: { user: 'root' } } });

	print(sprintf('%.3J\n', result));
	exit(0);
}

return { 'traffic-stats': methods };
