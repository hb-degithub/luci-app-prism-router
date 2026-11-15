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

import { readfile, access, glob, popen, basename } from 'fs';
import { cursor } from 'uci';

const UCI_BIN      = '/sbin/uci';
const CURL_BIN     = '/usr/bin/curl';
const OPENSSL_BIN  = '/usr/bin/openssl';

const UCI_CONFIG   = 'traffic-stats';
const CONFIG_FILE  = '/etc/config/traffic-stats';
const STATE_FILE   = '/tmp/traffic-stats/state.json';
const HISTORY_FILE = '/tmp/traffic-stats/history.json';
const DAILY_DIR    = '/etc/traffic-stats/daily';
const NODES_DIR    = '/etc/traffic-stats/nodes';
const STATIONS_DIR = '/etc/traffic-stats/stations';
const INIT_SCRIPT  = '/etc/init.d/traffic-statsd';
const VERSION      = '1.0.0';

const PID_FILES = [ '/var/run/traffic-statsd.pid', '/var/run/traffic-stats.pid' ];

/* get_state 的裁剪预算：ubus 上限 262144B，留出 blobmsg / JSON-RPC 封装余量。 */
const STATE_BUDGET = 180 * 1024;

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
		/* 哑桥 AP 无线站点元数据上报（stations.uc 读，母节点 ingest-stations.uc 校验） */
		'stations_enabled', 'stations_token', 'station_ifaces',
		/* 软路由自身性能指标：是否采集 + 用哪个接口算 WAN 速率 */
		'system_enabled', 'wan_iface'
	],
	feishu:   [ 'enabled', 'webhook', 'secret', 'daily_time', 'report_chat_enabled',
	             'app_id', 'app_secret', 'chat_id', 'card_wrapper' ]
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
			rx_rate: 0, tx_rate: 0
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

		if (!member([ 'exact', 'degraded', 'unknown' ], conf))
			conf = 'unknown';

		out.health.accounting_confidence = conf;
		out.health.conntrack_count = integer(h.conntrack_count, 0);
		out.health.clash_connections = integer(h.clash_connections, 0);
		out.health.clash_poll_ms = integer(h.clash_poll_ms, 0);

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

function project_device(dev, max_apps) {
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

/* 按预算裁剪 get_state 的返回体；返回体中 truncated=true 表示"服务端裁剪过"。 */
function build_state(raw, running) {
	const out = state_summary(raw);

	out.running = running;
	out.devices = [];
	out.apps = [];
	out.truncated = false;

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
			push(out.devices, project_device(devices[i], max_apps));

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
	const user = request?.info?.acl?.user;
	return (user == null || user == 'root');
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

	return system(cmd) == 0;
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

	/* 先确认 section 存在；不存在就建一个同名 section（uci set cfg.name=type）。
	   uci 会把命中的 section 类型打到 stdout，这里用 sh 重定向掉，别污染 rpcd。 */
	if (system([ 'sh', '-c', sprintf('%s -q get %s >/dev/null 2>&1',
			UCI_BIN, shellquote(`${UCI_CONFIG}.${section}`)) ]) != 0) {
		if (!uci_run([ 'set', `${UCI_CONFIG}.${section}=${section}` ]))
			return { ok: false, error: `无法创建 section ${section}` };
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
			return { ok: false, error: `字段 ${key} 过长` };

		if (!uci_run([ 'set', `${UCI_CONFIG}.${section}.${key}=${value}` ]))
			return { ok: false, error: `写入 ${section}.${key} 失败` };

		applied++;
	}

	if (applied == 0)
		return { ok: false, error: 'no valid options' };

	if (!uci_run([ 'commit', UCI_CONFIG ]))
		return { ok: false, error: 'uci commit 失败' };

	return { ok: true };
}

// ---------------------------------------------------------------- ubus 方法表

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
				version: VERSION
			};
		}
	},

	get_state: {
		call: function(request) {
			const raw = read_json(STATE_FILE);
			const poll = poll_interval();

			return build_state(raw, daemon_running(raw, poll));
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
			let days = clamp(integer(request.args?.days, 1), 1, 31);

			const out = [];
			const seen = {};
			const today = day_of(time());

			const history = read_json(HISTORY_FILE);

			if (history != null && type(history.buckets) == 'array') {
				const day = text(history.day, today);

				push(out, { day: day, buckets: history.buckets });
				seen[day] = true;
			}

			/* 历史日：每天一个文件，文件名就是日期。新的在前。 */
			let files = glob(`${DAILY_DIR}/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json`) ?? [];

			files = sort(files, (a, b) => (a > b) ? -1 : ((a < b) ? 1 : 0));

			for (let file in files) {
				if (length(out) >= days)
					break;

				const day = replace(basename(file), /\.json$/, '');

				if (seen[day] == true)
					continue;

				const data = read_json(file);

				if (data == null)
					continue;

				const entry = {
					day: day,
					buckets: (type(data.buckets) == 'array') ? data.buckets : []
				};

				/* 每日汇总里没有桶时，把原始文件挂在 summary 上，前端可自行取用。 */
				if (length(entry.buckets) == 0)
					entry.summary = data;

				push(out, entry);
				seen[day] = true;
			}

			/* 连 history.json 都没有时，用今天的 daily 文件兜底。 */
			if (length(out) == 0) {
				const data = read_json(`${DAILY_DIR}/${today}.json`);

				if (data != null)
					push(out, { day: today, buckets: [], summary: data });
			}

			/* ubus 单条消息上限 262144B：满一天 288 桶 × 每桶 top 列表会到 ~318 KiB，
			   整次调用会直接失败（前端只能降级成"暂无历史数据"）。按预算逐级瘦身：
			   ① 去掉桶内的 top_apps / top_devices（趋势图只需要 totals）
			   ② 仍超则只保留每个 day 最近的 200 个桶 */
			let slim_buckets = function(list) {
				for (let d in list) {
					let nb = [];

					for (let b in d.buckets) {
						let o = {};

						for (let k in b)
							if (k != 'top_apps' && k != 'top_devices')
								o[k] = b[k];

						push(nb, o);
					}

					d.buckets = nb;
				}

				return list;
			};

			let enc = sprintf('%J', { days: out });

			if (length(enc) > 200000)
				slim_buckets(out);

			enc = sprintf('%J', { days: out });

			if (length(enc) > 200000) {
				for (let d in out) {
					if (length(d.buckets) > 200) {
						let keep = [];

						for (let i = length(d.buckets) - 200; i < length(d.buckets); i++)
							push(keep, d.buckets[i]);

						d.buckets = keep;
					}
				}
			}

			return { days: out };
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
