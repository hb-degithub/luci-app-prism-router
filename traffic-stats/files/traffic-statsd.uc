#!/usr/bin/ucode
/**
 * traffic-statsd — OpenWrt 流量统计守护进程（ucode 实现）
 *
 * 数据源
 *   1) OpenClash /connections (mihomo REST API)
 *        - 被 clash 接管的流量：真实域名 host、出口链路 chains、每连接字节、源设备 IP
 *   2) /proc/net/nf_conntrack
 *        - 未经 clash 的直连流量（orig dst 不在 fake-ip 段）
 *
 * 去重（硬性）：conntrack 中 orig.dst 落在 fake_ip_ranges 的流一律跳过，
 * 这部分流量由 clash 侧统计，绝不能两边都算。
 *
 * 契约：docs/SPEC.md —— 字段名 / 文件路径以契约为准，不得改动。
 *
 * 仅测试用的环境变量（生产环境不要设置）：
 *   TRAFFIC_STATS_STATE_DIR  覆盖 /tmp/traffic-stats
 *   TRAFFIC_STATS_DAILY_DIR  覆盖 /etc/traffic-stats/daily
 *   TRAFFIC_STATS_ONCE=1     只跑一轮、写完文件后退出（用于冒烟测试）
 *   TRAFFIC_STATS_DEBUG=1    详细日志输出到 stderr
 */

const fs = require('fs');
const uloop = require('uloop');

const DAEMON_VERSION = '1.0.0';

const STATE_DIR_DEFAULT = '/tmp/traffic-stats';
const DAILY_DIR_DEFAULT = '/etc/traffic-stats/daily';
const LEASES_FILE = '/tmp/dhcp.leases';
const CONNTRACK_FILE = '/proc/net/nf_conntrack';

/* 资源上限：家庭网关上远达不到，仅用于保证长时间运行内存有界（SPEC §8.7） */
const MAX_TRACK_DEVICES = 256;    /* 内部跟踪的设备数上限 */
const MAX_OUT_DEVICES = 200;      /* state.json 输出上限（SPEC §3） */
const MAX_DEV_APPS = 96;          /* 每设备跟踪的 host 数上限 */
const MAX_DEV_APPS_OUT = 30;      /* 每设备输出 Top N（SPEC §3） */
const MAX_GLOBAL_APPS = 512;      /* 全局跟踪的 host 数上限 */
const MAX_OUT_APPS = 50;          /* apps 数组输出条数 */
const MAX_DAY_APPS = 512;
const BUCKET_SECONDS = 300;       /* 5 分钟桶（SPEC §4） */
const TOP_PER_BUCKET = 10;

function str(v) {
	if (v == null) return '';
	return '' + v;
}

function to_int(v, dflt) {
	if (v == null) return dflt;
	let t = type(v);
	if (t == 'int') return v;
	if (t == 'double') return int(v);
	let n = int(v);
	if (type(n) != 'int') return dflt;
	return n;
}

function elapsed_ms(t0) {
	let t1 = clock();
	return int(((t1[0] - t0[0]) * 1000000000 + (t1[1] - t0[1])) / 1000000);
}

function clamp(v, lo, hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

function split_ws(s) {
	let out = [];
	for (let t in split(s, ' ')) {
		if (t != '') push(out, t);
	}
	return out;
}

function split_list(s) {
	let out = [];
	for (let t in split(replace(str(s), ',', ' '), ' ')) {
		if (t != '') push(out, t);
	}
	return out;
}

function new_store() {
	return { rx: 0, tx: 0, chain: '', chain_rx: {}, devs: {} };
}

function store_evict(store) {
	let worst = null, worst_v = null;
	for (let k in store) {
		let v = store[k].rx + store[k].tx;
		if (worst_v == null || v < worst_v) {
			worst_v = v;
			worst = k;
		}
	}
	if (worst != null) delete store[worst];
}

function store_add(store, host, chain, rx, tx, ip, cap) {
	let a = store[host];
	if (a == null) {
		a = new_store();
		a.chain = chain;
		store[host] = a;
	}
	a.rx += rx;
	a.tx += tx;
	a.chain_rx[chain] = (a.chain_rx[chain] || 0) + rx;
	let best = a.chain, best_v = -1;
	for (let k in a.chain_rx) {
		if (a.chain_rx[k] > best_v) {
			best_v = a.chain_rx[k];
			best = k;
		}
	}
	a.chain = best;
	if (ip != null && ip != '') a.devs[ip] = 1;
	if (cap > 0 && length(store) > cap) store_evict(store);
	return a;
}

function mkpath(dir) {
	if (dir == null || dir == '' || dir == '/') return true;
	if (fs.stat(dir) != null) return true;
	let parent = fs.dirname(dir);
	if (parent != null && parent != dir) mkpath(parent);
	if (fs.mkdir(dir)) return true;
	return fs.stat(dir) != null;
}

function atomic_write(path, text) {
	let tmp = path + '.tmp';
	let n = fs.writefile(tmp, text);
	if (type(n) != 'int') {
		fs.unlink(tmp);
		return false;
	}
	if (!fs.rename(tmp, path)) {
		fs.unlink(tmp);
		return false;
	}
	return true;
}

function load_json(path) {
	let txt = fs.readfile(path);
	if (txt == null || txt == '') return null;
	try {
		let o = json(txt);
		return (type(o) == 'object') ? o : null;
	} catch (e) {
		return null;
	}
}

function jstr(s) {
	let out = '"';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		let n = ord(c);
		if (c == '"') out += '\\"';
		else if (c == '\\') out += '\\\\';
		else if (n == 10) out += '\\n';
		else if (n == 13) out += '\\r';
		else if (n == 9) out += '\\t';
		else if (n < 0x20) out += sprintf('\\u%04x', n);
		else out += c;
	}
	return out + '"';
}

function jnum(v) {
	let t = type(v);
	if (t == 'int') return sprintf('%d', v);
	if (t == 'double') {
		let n = int(v);
		if (type(n) == 'int') return sprintf('%d', n);
	}
	return '0';
}

function jenc(v) {
	if (v == null) return 'null';
	let t = type(v);
	if (t == 'int' || t == 'double') return jnum(v);
	if (t == 'bool') return v ? 'true' : 'false';
	if (t == 'string') return jstr(v);
	if (t == 'array') {
		let parts = [];
		for (let i in v) push(parts, jenc(i));
		return '[' + join(',', parts) + ']';
	}
	if (t == 'object') {
		let parts = [];
		for (let k in v) push(parts, jstr(k) + ':' + jenc(v[k]));
		return '{' + join(',', parts) + '}';
	}
	return 'null';
}

function ipv4_int(s) {
	let p = split(s, '.');
	if (length(p) != 4) return null;
	let n = 0;
	for (let i = 0; i < 4; i++) {
		let v = int(p[i]);
		if (type(v) != 'int' || v < 0 || v > 255) return null;
		n = n * 256 + v;
	}
	return n;
}

function mask_to_bits(m) {
	if (m == null || m == '') return 24;
	let n = ipv4_int(m);
	if (n == null) return 24;
	let bits = 0;
	for (let i = 31; i >= 0; i--) {
		if (n & (1 << i)) bits++;
		else break;
	}
	return bits;
}

function parse_cidr(s) {
	s = str(s);
	let parts = split(s, '/');
	let ip = ipv4_int(parts[0]);
	if (ip == null) return null;
	let bits = 32;
	if (length(parts) > 1) bits = to_int(parts[1], 32);
	bits = clamp(bits, 0, 32);
	let mask = bits == 0 ? 0 : ((0xffffffff << (32 - bits)) & 0xffffffff);
	return { base: ip & mask, mask: mask, bits: bits, text: s };
}

function cidr_match(cidrs, ip) {
	if (ip == null) return false;
	for (let c in cidrs) {
		if ((ip & c.mask) == c.base) return true;
	}
	return false;
}

function cidr_from_ip_mask(ip, mask) {
	let n = ipv4_int(ip);
	if (n == null) return null;
	let bits = mask_to_bits(mask);
	let m = bits == 0 ? 0 : ((0xffffffff << (32 - bits)) & 0xffffffff);
	return sprintf('%d.%d.%d.%d/%d',
		int((n & m) / 16777216) % 256,
		int((n & m) / 65536) % 256,
		int((n & m) / 256) % 256,
		(n & m) % 256, bits);
}

function cfg_str(cur, pkg, sec, opt, dflt) {
	let v = null;
	try {
		v = cur.get(pkg, sec, opt);
	} catch (e) {
		v = null;
	}
	if (v == null || v == '') return dflt;
	return str(v);
}

function load_config(cur) {
	let c = {};

	c.enabled = to_int(cfg_str(cur, 'traffic-stats', 'settings', 'enabled', '1'), 1) != 0;
	c.poll_interval = clamp(to_int(cfg_str(cur, 'traffic-stats', 'settings', 'poll_interval', '5'), 5), 1, 3600);
	c.clash_api = cfg_str(cur, 'traffic-stats', 'settings', 'clash_api', '127.0.0.1:9090');
	c.clash_secret = cfg_str(cur, 'traffic-stats', 'settings', 'clash_secret', '');
	c.fake_ip_ranges = split_list(cfg_str(cur, 'traffic-stats', 'settings', 'fake_ip_ranges', '198.18.0.0/16'));
	c.lan_ranges = split_list(cfg_str(cur, 'traffic-stats', 'settings', 'lan_ranges', ''));
	c.history_days = clamp(to_int(cfg_str(cur, 'traffic-stats', 'settings', 'history_days', '7'), 7), 1, 90);

	/* clash_secret 留空 -> 自动读 openclash 的控制器密码（契约 §2） */
	if (c.clash_secret == '') {
		c.clash_secret = cfg_str(cur, 'openclash', 'config', 'dashboard_password', '');
	}

	c.feishu_enabled = to_int(cfg_str(cur, 'traffic-stats', 'feishu', 'enabled', '0'), 0) != 0;
	c.feishu_webhook = cfg_str(cur, 'traffic-stats', 'feishu', 'webhook', '');
	c.feishu_secret = cfg_str(cur, 'traffic-stats', 'feishu', 'secret', '');
	c.feishu_daily_time = cfg_str(cur, 'traffic-stats', 'feishu', 'daily_time', '08:30');
	c.feishu_chat_enabled = to_int(cfg_str(cur, 'traffic-stats', 'feishu', 'report_chat_enabled', '1'), 1) != 0;

	let sd = getenv('TRAFFIC_STATS_STATE_DIR');
	c.state_dir = (sd != null && sd != '') ? sd : STATE_DIR_DEFAULT;
	let dd = getenv('TRAFFIC_STATS_DAILY_DIR');
	c.daily_dir = (dd != null && dd != '') ? dd : DAILY_DIR_DEFAULT;
	c.debug = getenv('TRAFFIC_STATS_DEBUG') != null;
	c.once = (getenv('TRAFFIC_STATS_ONCE') != null);

	for (let a in ARGV) {
		if (a == '--once') c.once = true;
		else if (a == '--debug') c.debug = true;
		else if (a == '--version') {
			printf('traffic-statsd %s\n', DAEMON_VERSION);
			exit(0);
		}
	}

	return c;
}

function dbg(ctx, msg) {
	if (ctx != null && ctx.cfg != null && ctx.cfg.debug) warn('traffic-statsd: ' + msg + '\n');
}

function read_if_addrs() {
	let out = {};
	let txt = null;
	try {
		let p = fs.popen('ip -4 -o addr show 2>/dev/null', 'r');
		txt = p.read('all');
		p.close();
	} catch (e) {
		txt = null;
	}
	if (txt == null) return out;
	for (let line in split(txt, '\n')) {
		let t = split_ws(line);
		if (length(t) < 4) continue;
		/* 16: br-lan inet 192.168.100.1/24 brd ... */
		let dev = substr(t[1], 0, length(t[1]) - 1);
		if (t[2] != 'inet') continue;
		if (out[dev] == null) out[dev] = [];
		push(out[dev], t[3]);
	}
	return out;
}

function detect_lan_cidrs(cur, cfg) {
	let cidrs = [];
	if (length(cfg.lan_ranges) > 0) {
		for (let s in cfg.lan_ranges) {
			let c = parse_cidr(s);
			if (c != null) push(cidrs, c);
		}
		if (length(cidrs) > 0) return cidrs;
	}

	let addrs = read_if_addrs();
	let nets = null;
	try {
		nets = cur.get('firewall', '@zone[0]', 'network');
	} catch (e) {
		nets = null;
	}
	if (type(nets) != 'array') {
		/* zone[0] 未必是 lan，退化为按名字找 */
		nets = ['lan'];
		try {
			if (str(cur.get('firewall', '@zone[0]', 'name')) != 'lan') nets = ['lan'];
		} catch (e) {
			nets = ['lan'];
		}
	}

	let devs = [];
	for (let n in nets) {
		let dev = null;
		try {
			dev = cur.get('network', n, 'device');
		} catch (e) {
			dev = null;
		}
		if (dev == null || dev == '') {
			try {
				dev = cur.get('network', n, 'ifname');
			} catch (e) {
				dev = null;
			}
		}
		if (type(dev) == 'array') dev = length(dev) > 0 ? dev[0] : null;
		if (dev == null || dev == '') dev = 'br-' + n;
		push(devs, dev);

		/* 1) 优先用接口上真实生效的地址 */
		if (addrs[dev] != null) {
			for (let a in addrs[dev]) {
				push(cidrs, a);
				continue;
			}
			continue;
		}
		/* 2) 退化到 uci 里的 ipaddr/netmask */
		let ip = null, mask = null;
		try {
			ip = cur.get('network', n, 'ipaddr');
			mask = cur.get('network', n, 'netmask');
		} catch (e) {
			ip = null;
		}
		let c = cidr_from_ip_mask(str(ip), str(mask));
		if (c != null) push(cidrs, c);
	}

	let out = [];
	for (let s in cidrs) {
		let c = parse_cidr(s);
		if (c != null) push(out, c);
	}
	if (length(out) == 0) {
		/* 最后兜底：br-lan，再不行就把所有非 lo/非 docker/非 tun 的 v4 地址当 LAN */
		if (addrs['br-lan'] != null) {
			for (let a in addrs['br-lan']) {
				let c = parse_cidr(a);
				if (c != null) push(out, c);
			}
		}
	}
	if (length(out) == 0) {
		for (let dev in keys(addrs)) {
			if (dev == 'lo' || substr(dev, 0, 3) == 'tun' || substr(dev, 0, 4) == 'wg0'
				|| substr(dev, 0, 6) == 'docker' || substr(dev, 0, 4) == 'veth'
				|| substr(dev, 0, 5) == 'tailscale')
				continue;
			for (let a in addrs[dev]) {
				let c = parse_cidr(a);
				if (c != null) push(out, c);
			}
		}
	}
	return out;
}

function load_leases(ctx) {
	let now = time();
	if (now - ctx.leases_ts < 30) return;
	ctx.leases_ts = now;
	let txt = fs.readfile(LEASES_FILE);
	let m = {};
	if (txt != null) {
		for (let line in split(txt, '\n')) {
			if (line == '') continue;
			let f = split_ws(line);
			if (length(f) < 4) continue;
			let ip = f[2];
			if (ipv4_int(ip) == null) continue;
			let host = f[3];
			if (host == '*') host = '';
			m[ip] = { mac: f[1], hostname: host };
		}
	}
	ctx.leases = m;
}

function dev_identity(ctx, ip) {
	let l = ctx.leases[ip];
	if (l == null) return { mac: '', hostname: '' };
	return l;
}

function evict_device(ctx) {
	let worst = null, worst_v = null;
	for (let ip in ctx.devices) {
		let d = ctx.devices[ip];
		let v = d.last_seen;
		if (worst_v == null || v < worst_v) {
			worst_v = v;
			worst = ip;
		}
	}
	if (worst != null) {
		delete ctx.devices[worst];
		delete ctx.prev_dev[worst];
	}
}

function dev_slot(ctx, ip) {
	let d = ctx.devices[ip];
	if (d != null) return d;
	d = {
		ip: ip,
		mac: '',
		hostname: '',
		direct_rx: 0, direct_tx: 0,
		proxy_rx: 0, proxy_tx: 0,
		rx_rate: 0, tx_rate: 0,
		last_seen: 0,
		apps: {}
	};
	ctx.devices[ip] = d;
	if (length(ctx.devices) > MAX_TRACK_DEVICES) evict_device(ctx);
	return d;
}

function clash_url(ctx) {
	let api = ctx.cfg.clash_api;
	if (index(api, '://') < 0) api = 'http://' + api;
	return api + '/connections';
}

function cleanup_files(list) {
	for (let f in list) {
		try {
			fs.unlink(f);
		} catch (e) {
			/* ignore */
		}
	}
}

function fetch_clash(ctx) {
	let t0 = clock();
	let body = ctx.cfg.state_dir + '/.clash.body';
	let code = ctx.cfg.state_dir + '/.clash.code';
	let err = ctx.cfg.state_dir + '/.clash.err';
	let timeout = clamp(ctx.cfg.poll_interval * 2, 2, 10);
	let cmd = "curl -sS -m " + timeout + " -K - -o '" + body + "' -w '%{http_code}' '"
		+ clash_url(ctx) + "' > '" + code + "' 2> '" + err + "'";
	let res = { ok: false, conns: [], ms: 0, reason: 'clash: 未采集', http: 0, n: 0 };

	try {
		let p = fs.popen(cmd, 'w');
		if (ctx.cfg.clash_secret != '') {
			p.write("header = \"Authorization: Bearer " + ctx.cfg.clash_secret + "\"\n");
		}
		p.close();
	} catch (e) {
		res.reason = 'clash: 执行 curl 失败（' + str(e) + '）';
		res.ms = elapsed_ms(t0);
		cleanup_files([body, code, err]);
		return res;
	}

	let http = to_int(str(fs.readfile(code)), 0);
	res.http = http;
	let text = null;
	try {
		text = fs.readfile(body);
	} catch (e) {
		text = null;
	}

	if (http != 200) {
		let detail = '';
		if (text != null && text != '') {
			detail = substr(text, 0, 80);
			detail = replace(detail, '\n', ' ');
		}
		let errtext = str(fs.readfile(err));
		if (http == 0) {
			res.reason = 'clash: 无法连接 ' + ctx.cfg.clash_api
				+ (errtext != '' ? '（' + substr(replace(errtext, '\n', ' '), 0, 80) + '）' : '');
		} else if (http == 401 || http == 403) {
			res.reason = 'clash: 认证失败 HTTP ' + http + '（检查 clash_secret / openclash 控制器密码）';
		} else {
			res.reason = 'clash: HTTP ' + http + (detail != '' ? ' ' + detail : '');
		}
		res.ms = elapsed_ms(t0);
		cleanup_files([body, code, err]);
		return res;
	}

	let obj = null;
	try {
		obj = (text != null && text != '') ? json(text) : null;
	} catch (e) {
		obj = null;
	}
	if (type(obj) != 'object' || type(obj.connections) != 'array') {
		res.reason = 'clash: /connections 返回不是预期的 JSON 结构';
		res.ms = elapsed_ms(t0);
		cleanup_files([body, code, err]);
		return res;
	}

	res.ok = true;
	res.conns = obj.connections;
	res.n = length(obj.connections);
	res.reason = '';
	res.ms = elapsed_ms(t0);
	cleanup_files([body, code, err]);
	return res;
}

function day_app_add(ctx, host, chain, rx, tx, ip) {
	store_add(ctx.day_apps, host, chain, rx, tx, ip, MAX_DAY_APPS);
}

function day_dev_add(ctx, ip, rx, tx) {
	let d = ctx.day_devices[ip];
	if (d == null) {
		d = { rx: 0, tx: 0 };
		ctx.day_devices[ip] = d;
	}
	d.rx += rx;
	d.tx += tx;
}

function day_node_add(ctx, node, rx, tx) {
	let n = ctx.day_nodes[node];
	if (n == null) {
		n = { rx: 0, tx: 0, devs: {} };
		ctx.day_nodes[node] = n;
	}
	n.rx += rx;
	n.tx += tx;
}

function accumulate_clash(ctx, conns, dt, deltas) {
	let seen = {};
	for (let c in conns) {
		if (type(c) != 'object') continue;
		let id = str(c.id);
		if (id == '') continue;
		seen[id] = 1;

		let md = (type(c.metadata) == 'object') ? c.metadata : {};
		let dl = to_int(c.download, 0);
		let ul = to_int(c.upload, 0);
		if (dl < 0) dl = 0;
		if (ul < 0) ul = 0;

		let prev = ctx.clash_prev[id];
		let ddl, dul;
		if (prev == null) {
			ddl = dl;
			dul = ul;
		} else {
			ddl = dl - prev.rx;
			dul = ul - prev.tx;
			/* 计数被重置（连接复用/异常）时以当前值为准 */
			if (ddl < 0) ddl = dl;
			if (dul < 0) dul = ul;
		}
		ctx.clash_prev[id] = { rx: dl, tx: ul };
		if (ddl == 0 && dul == 0) continue;

		let chain = '';
		if (type(c.chains) == 'array' && length(c.chains) > 0) chain = str(c.chains[0]);
		let is_direct = (chain == 'DIRECT');
		let node = is_direct ? 'DIRECT' : (chain != '' ? chain : 'UNKNOWN');

		let host = str(md.host);
		if (host == '') {
			let dip = str(md.destinationIP);
			let dport = str(md.destinationPort);
			host = (dip != '' ? dip : 'unknown') + (dport != '' ? ':' + dport : '');
		}

		let ip = str(md.sourceIP);

		if (is_direct) {
			ctx.totals.direct_rx += ddl;
			ctx.totals.direct_tx += dul;
			deltas.direct_rx += ddl;
			deltas.direct_tx += dul;
		} else {
			ctx.totals.proxy_rx += ddl;
			ctx.totals.proxy_tx += dul;
			deltas.proxy_rx += ddl;
			deltas.proxy_tx += dul;
		}

		let nd = ctx.nodes[node];
		if (nd == null) {
			nd = { rx: 0, tx: 0 };
			ctx.nodes[node] = nd;
		}
		nd.rx += ddl;
		nd.tx += dul;

		/* 当日累计 */
		ctx.day_totals[is_direct ? 'direct_rx' : 'proxy_rx'] += ddl;
		ctx.day_totals[is_direct ? 'direct_tx' : 'proxy_tx'] += dul;
		day_node_add(ctx, node, ddl, dul);
		day_app_add(ctx, host, node, ddl, dul, ip);

		/* 设备维度 */
		if (ip == '') continue;
		let d = dev_slot(ctx, ip);
		d.last_seen = ctx.now;
		let ident = dev_identity(ctx, ip);
		if (ident.mac != '') d.mac = ident.mac;
		if (ident.hostname != '') d.hostname = ident.hostname;
		if (is_direct) {
			d.direct_rx += ddl;
			d.direct_tx += dul;
		} else {
			d.proxy_rx += ddl;
			d.proxy_tx += dul;
		}
		d.rx_rate += ddl;
		d.tx_rate += dul;
		store_add(d.apps, host, node, ddl, dul, null, MAX_DEV_APPS);
		day_dev_add(ctx, ip, ddl, dul);
		store_add(ctx.apps, host, node, ddl, dul, ip, MAX_GLOBAL_APPS);
	}

	/* 已消失的连接：从快照表里清掉，避免内存随时间增长 */
	for (let id in keys(ctx.clash_prev)) {
		if (seen[id] == null) delete ctx.clash_prev[id];
	}
}

function fetch_conntrack(ctx) {
	let txt = null;
	try {
		txt = fs.readfile(LEASES_FILE == '' ? '' : CONNTRACK_FILE);
	} catch (e) {
		txt = null;
	}
	if (txt == null) {
		return { ok: false, text: null, reason: 'conntrack: 无法读取 ' + CONNTRACK_FILE + '（内核模块未加载或权限不足）' };
	}
	return { ok: true, text: txt, reason: '' };
}

function parse_ct_line(line) {
	let toks = split_ws(line);
	if (length(toks) < 8) return null;
	let family = toks[0];
	if (family != 'ipv4' && family != 'ipv6') return null;
	let proto = toks[2];

	let groups = [];
	let cur = null;
	for (let tk in toks) {
		if (substr(tk, 0, 4) == 'src=') {
			cur = {};
			push(groups, cur);
		}
		if (cur == null) continue;
		let kv = split(tk, '=');
		if (length(kv) != 2) continue;
		let k = kv[0];
		if (k == 'src') cur.src = kv[1];
		else if (k == 'dst') cur.dst = kv[1];
		else if (k == 'sport') cur.sport = kv[1];
		else if (k == 'dport') cur.dport = kv[1];
		else if (k == 'packets') cur.packets = to_int(kv[1], 0);
		else if (k == 'bytes') cur.bytes = to_int(kv[1], 0);
	}
	if (length(groups) == 0) return null;
	let orig = groups[0];
	if (orig.src == null || orig.dst == null) return null;
	if (orig.bytes == null) orig.bytes = 0;
	if (orig.packets == null) orig.packets = 0;
	let reply = length(groups) > 1 ? groups[1] : null;
	if (reply != null) {
		if (reply.bytes == null) reply.bytes = 0;
	}
	return { family: family, proto: proto, orig: orig, reply: reply };
}

function accumulate_conntrack(ctx, text, deltas) {
	let seen = {};
	let total = 0;

	for (let line in split(text, '\n')) {
		if (line == '') continue;
		total++;
		let flow = parse_ct_line(line);
		if (flow == null) continue;

		let o = flow.orig;
		let ip = null, dir = 0;

		if (ipv4_int(o.src) != null && cidr_match(ctx.lan_cidrs, ipv4_int(o.src))) {
			ip = o.src;
			dir = 1; /* 设备发出 */
		} else if (ipv4_int(o.dst) != null && cidr_match(ctx.lan_cidrs, ipv4_int(o.dst))) {
			ip = o.dst;
			dir = 2; /* 设备接收（外网主动连入） */
		} else {
			continue; /* 与 LAN 设备无关（路由自身 / clash 出站腿） */
		}

		/* 去重：orig.dst 落在 fake-ip 段 -> 已被 clash 接管，跳过 */
		let odst = ipv4_int(o.dst);
		if (odst != null && cidr_match(ctx.fake_cidrs, odst)) {
			ctx.fakeip_skipped++;
			continue;
		}

		/* LAN 内部互访（两端都在 LAN）不计入设备直连，避免把内网流量当外网用量 */
		if (dir == 1 && ipv4_int(o.dst) != null && cidr_match(ctx.lan_cidrs, ipv4_int(o.dst))) {
			continue;
		}

		let key = flow.proto + '|' + o.src + '|' + str(o.sport) + '|' + o.dst + '|' + str(o.dport);
		seen[key] = 1;

		let cur_tx = dir == 1 ? o.bytes : (flow.reply != null ? flow.reply.bytes : 0);
		let cur_rx = dir == 1 ? (flow.reply != null ? flow.reply.bytes : 0) : o.bytes;

		let prev = ctx.ct_prev[key];
		let d_rx, d_tx;
		if (prev == null) {
			d_rx = cur_rx;
			d_tx = cur_tx;
		} else {
			d_rx = cur_rx - prev.rx;
			d_tx = cur_tx - prev.tx;
			if (d_rx < 0) d_rx = cur_rx;
			if (d_tx < 0) d_tx = cur_tx;
		}
		ctx.ct_prev[key] = { rx: cur_rx, tx: cur_tx };
		if (d_rx == 0 && d_tx == 0) continue;

		ctx.totals.direct_rx += d_rx;
		ctx.totals.direct_tx += d_tx;
		deltas.direct_rx += d_rx;
		deltas.direct_tx += d_tx;

		let nd = ctx.nodes['DIRECT'];
		if (nd == null) {
			nd = { rx: 0, tx: 0 };
			ctx.nodes['DIRECT'] = nd;
		}
		nd.rx += d_rx;
		nd.tx += d_tx;

		ctx.day_totals.direct_rx += d_rx;
		ctx.day_totals.direct_tx += d_tx;
		day_node_add(ctx, 'DIRECT', d_rx, d_tx);

		let d = dev_slot(ctx, ip);
		d.last_seen = ctx.now;
		let ident = dev_identity(ctx, ip);
		if (ident.mac != '') d.mac = ident.mac;
		if (ident.hostname != '') d.hostname = ident.hostname;
		d.direct_rx += d_rx;
		d.direct_tx += d_tx;
		d.rx_rate += d_rx;
		d.tx_rate += d_tx;
		day_dev_add(ctx, ip, d_rx, d_tx);
		/* 直连流没有域名，用目的地址:端口归到应用维度 */
		let host = o.dst + (o.dport != null ? ':' + o.dport : '');
		store_add(d.apps, host, 'DIRECT', d_rx, d_tx, null, MAX_DEV_APPS);
		store_add(ctx.apps, host, 'DIRECT', d_rx, d_tx, ip, MAX_GLOBAL_APPS);
		day_app_add(ctx, host, 'DIRECT', d_rx, d_tx, ip);
	}

	ctx.ct_count = total;

	/* 已消失的流：清理快照表 */
	for (let key in keys(ctx.ct_prev)) {
		if (seen[key] == null) delete ctx.ct_prev[key];
	}
}

function local_day_str(ts) {
	let t = localtime(ts);
	return sprintf('%04d-%02d-%02d', t.year, t.mon, t.mday);
}

function bucket_ts_of(ts) {
	return ts - (ts % BUCKET_SECONDS);
}

function bucket_reset(ctx, bts) {
	ctx.cur_bucket = {
		ts: bts,
		direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
		apps: {},
		devs: {}
	};
}

function bucket_add(ctx, deltas) {
	let b = ctx.cur_bucket;
	if (b == null) return;
	b.direct_rx += deltas.direct_rx;
	b.direct_tx += deltas.direct_tx;
	b.proxy_rx += deltas.proxy_rx;
	b.proxy_tx += deltas.proxy_tx;
	for (let host in keys(ctx.poll_apps)) {
		let a = ctx.poll_apps[host];
		let cur = b.apps[host];
		if (cur == null) {
			cur = { rx: 0, tx: 0, chain: a.chain };
			b.apps[host] = cur;
		}
		cur.rx += a.rx;
		cur.tx += a.tx;
		cur.chain = a.chain;
	}
	for (let ip in keys(ctx.poll_devs)) {
		let d = ctx.poll_devs[ip];
		let cur = b.devs[ip];
		if (cur == null) {
			cur = { rx: 0, tx: 0 };
			b.devs[ip] = cur;
		}
		cur.rx += d.rx;
		cur.tx += d.tx;
	}
	/* 桶内应用数有上限，防 P2P 场景膨胀 */
	while (length(b.apps) > 256) store_evict(b.apps);
}

function bucket_finalize(b) {
	let apps = [];
	for (let host in b.apps) {
		push(apps, { host: host, rx: b.apps[host].rx, tx: b.apps[host].tx });
	}
	apps = sort(apps, function(x, y) { return (y.rx + y.tx) - (x.rx + x.tx); });
	let devs = [];
	for (let ip in b.devs) {
		push(devs, { ip: ip, rx: b.devs[ip].rx, tx: b.devs[ip].tx });
	}
	devs = sort(devs, function(x, y) { return (y.rx + y.tx) - (x.rx + x.tx); });
	return {
		ts: b.ts,
		direct_rx: b.direct_rx, direct_tx: b.direct_tx,
		proxy_rx: b.proxy_rx, proxy_tx: b.proxy_tx,
		top_apps: slice(apps, 0, TOP_PER_BUCKET),
		top_devices: slice(devs, 0, TOP_PER_BUCKET)
	};
}

function history_flush(ctx, force) {
	let now = time();
	let bts = bucket_ts_of(now);
	if (!force && ctx.last_history_flush > 0
		&& now - ctx.last_history_flush < BUCKET_HISTORY_FLUSH
		&& ctx.bucket_full_flushed)
		return;

	let buckets = [];
	for (let b in ctx.buckets) push(buckets, b);
	if (ctx.cur_bucket != null) push(buckets, bucket_finalize(ctx.cur_bucket));

	mkpath(ctx.cfg.state_dir);
	let doc = { day: ctx.day, buckets: buckets };
	let ok = atomic_write(ctx.cfg.state_dir + '/history.json', jenc(doc));
	ctx.last_history_flush = now;
	if (!ok) ctx.history_write_failed = true;
	else ctx.history_write_failed = false;
	ctx.bucket_full_flushed = true;
}

function day_summary(ctx) {
	let devices = [];
	for (let ip in ctx.day_devices) {
		let d = ctx.day_devices[ip];
		let ident = dev_identity(ctx, ip);
		push(devices, {
			ip: ip,
			mac: ident.mac,
			hostname: ident.hostname,
			rx: d.rx,
			tx: d.tx
		});
	}
	devices = sort(devices, function(a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

	let apps = [];
	for (let host in ctx.day_apps) {
		let a = ctx.day_apps[host];
		push(apps, {
			host: host,
			rx: a.rx,
			tx: a.tx,
			chain: a.chain,
			devices: length(a.devs)
		});
	}
	apps = sort(apps, function(a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

	let nodes = {};
	for (let k in ctx.day_nodes) nodes[k] = { rx: ctx.day_nodes[k].rx, tx: ctx.day_nodes[k].tx };

	return {
		day: ctx.day,
		ts: ctx.now,
		totals: {
			direct_rx: ctx.day_totals.direct_rx, direct_tx: ctx.day_totals.direct_tx,
			proxy_rx: ctx.day_totals.proxy_rx, proxy_tx: ctx.day_totals.proxy_tx,
			rx: ctx.day_totals.direct_rx + ctx.day_totals.proxy_rx,
			tx: ctx.day_totals.direct_tx + ctx.day_totals.proxy_tx
		},
		nodes: nodes,
		devices: slice(devices, 0, MAX_OUT_DEVICES),
		apps: slice(apps, 0, MAX_OUT_APPS)
	};
}

function daily_write(ctx, force) {
	if (!force && ctx.daily_fail_ts > 0 && ctx.now - ctx.daily_fail_ts < 600) return;
	if (!mkpath(ctx.cfg.daily_dir)) {
		ctx.daily_fail_ts = ctx.now;
		return;
	}
	let doc = day_summary(ctx);
	let path = ctx.cfg.daily_dir + '/' + ctx.day + '.json';
	if (!atomic_write(path, jenc(doc))) {
		ctx.daily_fail_ts = ctx.now;
		return;
	}
	ctx.daily_fail_ts = 0;
}

function daily_prune(ctx) {
	let names = null;
	try {
		names = fs.lsdir(ctx.cfg.daily_dir);
	} catch (e) {
		names = null;
	}
	if (names == null) return;
	let days = [];
	for (let n in names) {
		if (substr(n, 0, 1) == '.') continue;
		if (length(n) != 15 || substr(n, 10) != '.json') continue;
		push(days, n);
	}
	days = sort(days);
	let keep = ctx.cfg.history_days;
	while (length(days) > keep) {
		let victim = days[0];
		days = slice(days, 1, length(days));
		try {
			fs.unlink(ctx.cfg.daily_dir + '/' + victim);
		} catch (e) {
			/* ignore */
		}
	}
}

function day_rollover_check(ctx) {
	let d = local_day_str(ctx.now);
	if (ctx.day == d) return;
	/* 跨天：先把昨天写盘、清空当日累计 */
	if (ctx.day != '') {
		daily_write(ctx, true);
		ctx.buckets = [];
	}
	ctx.day = d;
	ctx.day_totals = { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0 };
	ctx.day_devices = {};
	ctx.day_apps = {};
	ctx.day_nodes = {};
	bucket_reset(ctx, bucket_ts_of(ctx.now));
	ctx.last_history_flush = 0;
	daily_prune(ctx);
}

function device_apps_out(apps) {
	let list = [];
	for (let host in apps) {
		push(list, { host: host, rx: apps[host].rx, tx: apps[host].tx, chain: apps[host].chain });
	}
	list = sort(list, function(a, b) { return b.rx - a.rx; });
	if (length(list) <= MAX_DEV_APPS_OUT) {
		let out = {};
		for (let a in list) out[a.host] = { rx: a.rx, tx: a.tx, chain: a.chain };
		return out;
	}
	let out = {}, other = { rx: 0, tx: 0, chain: 'MIXED' };
	for (let i = 0; i < length(list); i++) {
		let a = list[i];
		if (i < MAX_DEV_APPS_OUT) {
			out[a.host] = { rx: a.rx, tx: a.tx, chain: a.chain };
		} else {
			other.rx += a.rx;
			other.tx += a.tx;
		}
	}
	out['__other__'] = other;
	return out;
}

function build_state(ctx) {
	let now = ctx.now;
	let dt = now - ctx.last_poll_ts;
	if (dt <= 0) dt = 1;

	/* 速率（本轮到上轮的增量 / 实际间隔） */
	ctx.totals.rx_rate = int((ctx.totals.direct_rx + ctx.totals.proxy_rx - ctx.prev_total_rx) / dt);
	ctx.totals.tx_rate = int((ctx.totals.direct_tx + ctx.totals.proxy_tx - ctx.prev_total_tx) / dt);
	ctx.prev_total_rx = ctx.totals.direct_rx + ctx.totals.proxy_rx;
	ctx.prev_total_tx = ctx.totals.direct_tx + ctx.totals.proxy_tx;

	let devices = [];
	for (let ip in ctx.devices) {
		let d = ctx.devices[ip];
		push(devices, {
			ip: d.ip,
			mac: d.mac,
			hostname: d.hostname,
			direct_rx: d.direct_rx,
			direct_tx: d.direct_tx,
			proxy_rx: d.proxy_rx,
			proxy_tx: d.proxy_tx,
			rx_rate: int(d.rx_rate / dt),
			tx_rate: int(d.tx_rate / dt),
			last_seen: d.last_seen,
			apps: device_apps_out(d.apps)
		});
	}
	devices = sort(devices, function(a, b) {
		return (b.proxy_rx + b.direct_rx) - (a.proxy_rx + a.direct_rx);
	});
	devices = slice(devices, 0, MAX_OUT_DEVICES);

	/* apps 聚合（按 rx 排序，附设备数） */
	let apps = [];
	for (let host in ctx.apps) {
		let a = ctx.apps[host];
		push(apps, {
			host: host,
			rx: a.rx,
			tx: a.tx,
			chain: a.chain,
			devices: length(a.devs)
		});
	}
	apps = sort(apps, function(a, b) { return b.rx - a.rx; });
	apps = slice(apps, 0, MAX_OUT_APPS);

	let nodes = {};
	for (let k in ctx.nodes) nodes[k] = { rx: ctx.nodes[k].rx, tx: ctx.nodes[k].tx };

	let reasons = ctx.reasons;
	let conf = 'exact';
	if (length(reasons) > 0) {
		conf = (ctx.source.clash == 'error' && ctx.source.conntrack == 'error') ? 'unavailable' : 'degraded';
	}

	return {
		ts: now,
		uptime: now - ctx.started,
		source: { clash: ctx.source.clash, conntrack: ctx.source.conntrack },
		totals: {
			direct_rx: ctx.totals.direct_rx, direct_tx: ctx.totals.direct_tx,
			proxy_rx: ctx.totals.proxy_rx, proxy_tx: ctx.totals.proxy_tx,
			rx_rate: ctx.totals.rx_rate, tx_rate: ctx.totals.tx_rate
		},
		nodes: nodes,
		devices: devices,
		apps: apps,
		health: {
			accounting_confidence: conf,
			reasons: reasons,
			conntrack_count: ctx.ct_count,
			clash_connections: ctx.clash_count,
			clash_poll_ms: ctx.clash_ms,
			poll_ms: ctx.poll_ms
		}
	};
}

function fmt_bytes(n) {
	n = to_int(n, 0);
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return sprintf('%.1f KB', n / 1024);
	if (n < 1024 * 1024 * 1024) return sprintf('%.1f MB', n / 1048576);
	return sprintf('%.2f GB', n / 1073741824);
}

function feishu_payload(ctx) {
	let sum = day_summary(ctx);
	let devs = slice(sum.devices, 0, 10);
	let rows = [];
	for (let d in devs) {
		let name = d.hostname != '' ? d.hostname : (d.ip != '' ? d.ip : d.mac);
		push(rows, [name, fmt_bytes(d.rx), fmt_bytes(d.tx), fmt_bytes(d.rx + d.tx)]);
	}
	let bucket_txt = [];
	for (let b in ctx.buckets) push(bucket_txt, fmt_bytes(b.proxy_rx + b.direct_rx + b.proxy_tx + b.direct_tx));
	let total_rx = sum.totals.rx;
	let total_tx = sum.totals.tx;

	return {
		schema: '2.0',
		config: { wide_screen_mode: true },
		header: {
			template: 'blue',
			title: { tag: 'plain_text', content: '流量日报 ' + sum.day }
		},
		body: {
			elements: [
				{ tag: 'div', text: { tag: 'lark_md',
					content: '**总流量（下行 / 上行）**：' + fmt_bytes(total_rx) + ' / ' + fmt_bytes(total_tx) + '\n'
						+ '**代理流量**：' + fmt_bytes(sum.totals.proxy_rx + sum.totals.proxy_tx) + '\n'
						+ '**直连流量**：' + fmt_bytes(sum.totals.direct_rx + sum.totals.direct_tx) + '\n'
						+ '**在线设备数**：' + length(sum.devices) } },
				{ tag: 'div', text: { tag: 'lark_md', content: '**近 24 小时**（每格一个 5 分钟桶，单位见括号）：\n'
					+ (length(bucket_txt) > 0 ? join(' / ', slice(bucket_txt, 0, 24)) + ' …' : '（暂无数据）') } },
				{ tag: 'table', page_size: 10, row_height: 'low',
					header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey' },
					columns: [
						{ name: 'device', display_name: '设备', data_type: 'text', width: 'auto' },
						{ name: 'direct', display_name: '直连', data_type: 'text', width: 'auto' },
						{ name: 'proxy', display_name: '代理', data_type: 'text', width: 'auto' },
						{ name: 'total', display_name: '合计', data_type: 'text', width: 'auto' }
					],
					rows: rows },
				{ tag: 'div', text: { tag: 'plain_text', content: '由 traffic-statsd ' + DAEMON_VERSION
					+ ' 生成 · ' + local_day_str(ctx.now) } }
			]
		}
	};
}

function shell_quote(s) {
	return "'" + replace(s, "'", "'\\''") + "'";
}

function hmac_sign2(ts, secret) {
	let key = str(ts) + '\n' + secret;
	let cmd = "printf '%s' '' | openssl dgst -sha256 -hmac " + shell_quote(key) + " -binary | openssl base64 -A";
	let res = null;
	try {
		let p = fs.popen(cmd, 'r');
		res = p.read('all');
		p.close();
	} catch (e) {
		return null;
	}
	if (res == null) return null;
	res = replace(res, '\n', '');
	if (res == '') return null;
	return res;
}

function feishu_send(ctx, is_test) {
	let ts = ctx.now;
	let sign = hmac_sign2(ts, ctx.cfg.feishu_secret);
	let body = feishu_payload(ctx);
	let doc = { timestamp: str(ts), sign: sign != null ? sign : '', msg_type: 'interactive', card: body };
	let file = ctx.cfg.state_dir + '/.feishu.json';
	let resp = ctx.cfg.state_dir + '/.feishu.resp';
	mkpath(ctx.cfg.state_dir);
	if (type(fs.writefile(file, jenc(doc))) != 'int') return { ok: false, code: -1, msg: '无法写临时文件' };

	let cmd = "curl -sS -m 10 -X POST -H 'Content-Type: application/json' --data-binary @'"
		+ file + "' -o '" + resp + "' -w '%{http_code}' " + shell_quote(ctx.cfg.feishu_webhook);
	let http = 0;
	try {
		let p = fs.popen(cmd, 'r');
		http = to_int(p.read('all'), 0);
		p.close();
	} catch (e) {
		http = 0;
	}
	let text = fs.readfile(resp);
	cleanup_files([file, resp]);
	if (text == null) return { ok: false, code: http, msg: '无响应（HTTP ' + http + '）' };
	let o = null;
	try {
		o = json(text);
	} catch (e) {
		o = null;
	}
	if (type(o) != 'object') return { ok: false, code: http, msg: '响应非 JSON: ' + substr(text, 0, 80) };
	let code = to_int(o.code, -1);
	let msg = str(o.msg == null ? '' : o.msg);
	return { ok: code == 0, code: code, msg: msg };
}

function feishu_maybe_send(ctx) {
	if (!ctx.cfg.feishu_enabled) return;
	if (ctx.cfg.feishu_webhook == '') return;
	let t = localtime(ctx.now);
	let hhmm = sprintf('%02d:%02d', t.hour, t.min);
	let day = local_day_str(ctx.now);
	if (ctx.feishu_sent_day == day) return;
	if (hhmm != ctx.cfg.feishu_daily_time) return;
	ctx.feishu_sent_day = day;
	feishu_send(ctx, false);
}

function poll(ctx) {
	let t0 = clock();
	ctx.now = time();
	let dt = ctx.now - ctx.last_poll_ts;
	if (dt <= 0) dt = 1;
	ctx.last_poll_ts = ctx.now;

	day_rollover_check(ctx);

	/* 桶切换 */
	let bts = bucket_ts_of(ctx.now);
	if (ctx.cur_bucket == null) {
		bucket_reset(ctx, bts);
	} else if (bts != ctx.cur_bucket.ts) {
		push(ctx.buckets, bucket_finalize(ctx.cur_bucket));
		bucket_reset(ctx, bts);
		ctx.bucket_full_flushed = false;
	}

	load_leases(ctx);

	/* 每轮重置速率/增量累加器 */
	for (let ip in ctx.devices) {
		ctx.devices[ip].rx_rate = 0;
		ctx.devices[ip].tx_rate = 0;
	}
	ctx.poll_apps = {};
	ctx.poll_devs = {};
	ctx.fakeip_skipped = 0;

	let deltas = { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0 };
	let reasons = [];

	let clash = fetch_clash(ctx);
	ctx.clash_ms = clash.ms;
	if (clash.ok) {
		ctx.source.clash = 'ok';
		ctx.clash_count = clash.n;
		accumulate_clash(ctx, clash.conns, dt, deltas);
	} else {
		ctx.source.clash = 'error';
		ctx.clash_count = 0;
		push(reasons, clash.reason);
	}

	let ct = fetch_conntrack(ctx);
	if (ct.ok) {
		ctx.source.conntrack = 'ok';
		accumulate_conntrack(ctx, ct.text, deltas);
	} else {
		ctx.source.conntrack = 'error';
		ctx.ct_count = 0;
		push(reasons, ct.reason);
	}

	/* 本轮 App/设备增量（用于 5 分钟桶） */
	ctx.poll_apps = ctx.poll_apps;
	ctx.poll_devs = ctx.poll_devs;

	bucket_add(ctx, deltas);

	ctx.reasons = reasons;
	ctx.poll_ms = elapsed_ms(t0);

	let st = build_state(ctx);
	mkpath(ctx.cfg.state_dir);
	let state_ok = atomic_write(ctx.cfg.state_dir + '/state.json', jenc(st));
	if (!state_ok) dbg(ctx, 'write state.json failed: ' + fs.error());

	history_flush(ctx, false);
	daily_write(ctx, false);
	feishu_maybe_send(ctx);

	return st;
}

function hmac_sign(ts, secret) {
	/* key = timestamp + "\n" + secret，对空串做 HMAC-SHA256，再 Base64 */
	let key = str(ts) + '\n' + secret;
	let out = null;
	try {
		let p = fs.popen("openssl dgst -sha256 -hmac '" + replace(key, "'", "'\\''")
			+ "' -binary | openssl base64 -A", 'w');
		p.write('');
		p.close();
	} catch (e) {
		return null;
	}
	/* 上面的写法只为避免密钥进 ps：改用管道读回见 hmac_sign2 */
	return out;
}

function new_ctx() {
	let ctx = {
		cfg: null,
		started: time(),
		now: time(),
		last_poll_ts: time(),
		poll_ms: 0,
		clash_ms: 0,
		clash_count: 0,
		ct_count: 0,
		fakeip_skipped: 0,
		source: { clash: 'ok', conntrack: 'ok' },
		reasons: [],
		totals: { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0, rx_rate: 0, tx_rate: 0 },
		prev_total_rx: 0,
		prev_total_tx: 0,
		nodes: {},
		apps: {},
		devices: {},
		prev_dev: {},
		day_totals: { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0 },
		day_devices: {},
		day_apps: {},
		day_nodes: {},
		day: local_day_str(time()),
		buckets: [],
		cur_bucket: null,
		clash_prev: {},
		ct_prev: {},
		leases: {},
		leases_ts: 0,
		lan_cidrs: [],
		fake_cidrs: [],
		poll_apps: {},
		poll_devs: {},
		last_history_flush: 0,
		bucket_full_flushed: true,
		history_write_failed: false,
		daily_fail_ts: 0,
		feishu_sent_day: '',
		stopping: false
	};
	return ctx;
}

function boot() {
	let cur = null;
	try {
		cur = require('uci').cursor();
	} catch (e) {
		cur = null;
	}
	let ctx = new_ctx();
	ctx.cfg = load_config(cur);

	if (!ctx.cfg.enabled) {
		printf('traffic-statsd: disabled by /etc/config/traffic-stats (enabled=0)\n');
		exit(0);
	}

	load_leases(ctx);
	ctx.leases_ts = time();

	for (let s in ctx.cfg.fake_ip_ranges) {
		let c = parse_cidr(s);
		if (c != null) push(ctx.fake_cidrs, c);
	}
	ctx.lan_cidrs = detect_lan_cidrs(cur, ctx.cfg);

	let lan_txt = [];
	for (let c in ctx.lan_cidrs) push(lan_txt, c.text);
	dbg(ctx, 'lan=' + join(',', lan_txt) + ' fake=' + join(',', ctx.cfg.fake_ip_ranges)
		+ ' interval=' + ctx.cfg.poll_interval + 's api=' + ctx.cfg.clash_api);

	if (length(ctx.lan_cidrs) == 0) {
		push(ctx.reasons, 'lan: 未能识别 LAN 网段，conntrack 直连流量将统计不到');
	}
	if (length(ctx.fake_cidrs) == 0) {
		push(ctx.reasons, 'fake_ip: fake_ip_ranges 配置无效，无法去重，可能重复计数');
	}

	mkpath(ctx.cfg.state_dir);
	return ctx;
}

function flush_all(ctx, tag) {
	ctx.now = time();
	try {
		history_flush(ctx, true);
		daily_write(ctx, true);
	} catch (e) {
		dbg(ctx, 'flush on ' + tag + ' failed: ' + str(e));
	}
}

function main() {
	let ctx = boot();

	if (ctx.cfg.once) {
		poll(ctx);
		flush_all(ctx, 'once');
		let st = load_json(ctx.cfg.state_dir + '/state.json');
		if (st != null) printf('once: devices=%d proxy_rx=%d direct_rx=%d reasons=%d\n',
			length(st.devices), st.totals.proxy_rx, st.totals.direct_rx, length(st.health.reasons));
		exit(0);
	}

	uloop.init();

	uloop.signal('TERM', function() {
		ctx.stopping = true;
		flush_all(ctx, 'TERM');
		uloop.end();
	});
	uloop.signal('INT', function() {
		ctx.stopping = true;
		flush_all(ctx, 'INT');
		uloop.end();
	});

	let tmr = null;
	let tick = function() {
		if (ctx.stopping) return;
		try {
			poll(ctx);
		} catch (e) {
			dbg(ctx, 'poll failed: ' + str(e));
			ctx.source.clash = 'error';
			ctx.source.conntrack = ctx.source.conntrack;
		}
		if (!ctx.stopping) tmr.set(ctx.cfg.poll_interval * 1000);
	};

	/* 先跑一轮，再按固定间隔重排（自调度，避免上游慢时堆积） */
	tick();
	tmr = uloop.timer(ctx.cfg.poll_interval * 1000, tick);

	printf('traffic-statsd %s started (interval=%ds)\n', DAEMON_VERSION, ctx.cfg.poll_interval);
	uloop.run();
	flush_all(ctx, 'exit');
	dbg(ctx, 'stopped');
}



const BUCKET_HISTORY_FLUSH = 60;  /* history.json 最少刷新间隔（秒） */

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */





/** 按空白切分并丢弃空 token（conntrack / dhcp.leases 都需要） */

/** 按空格或逗号切分（配置里的 CIDR 列表） */


/** 记录一条 host 流量；chain 取 rx 最大的那条链路 */

/** 超过上限时淘汰流量最小的一条，避免长时间运行无限增长 */

/* ------------------------------------------------------------------ *
 * 文件系统
 * ------------------------------------------------------------------ */


/** 原子写：同目录临时文件 + rename */


/* ------------------------------------------------------------------ *
 * JSON 编码（ucode 的 %J 带空格，这里输出紧凑格式，与契约示例一致）
 * ------------------------------------------------------------------ */




/* ------------------------------------------------------------------ *
 * IPv4 / CIDR
 * ------------------------------------------------------------------ */





/** "192.168.100.1" + "255.255.255.0" -> "192.168.100.0/24" */

/* ------------------------------------------------------------------ *
 * 配置（UCI: /etc/config/traffic-stats，缺省时全部走默认值）
 * ------------------------------------------------------------------ */




/* ------------------------------------------------------------------ *
 * LAN / fake-ip 网段识别
 * ------------------------------------------------------------------ */

/** 解析 `ip -4 -o addr show` -> { ifname: [ "a.b.c.d/len", ... ] } */

/** LAN 网段：优先 uci 里 firewall lan zone 的网络，其次 br-lan/lan，最后忽略 lo/docker/tun/veth */

/* ------------------------------------------------------------------ *
 * 设备身份：/tmp/dhcp.leases -> { ip: { mac, hostname } }
 * ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ *
 * 设备记录
 * ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ *
 * clash /connections 采集
 * ------------------------------------------------------------------ */


/** 取一次 /connections；返回 { ok, conns, ms, reason } */


/**
 * clash 侧增量累计
 *  - id 是稳定键，用上轮快照做差
 *  - chains[0] == "DIRECT" -> 直连；否则代理，节点名 = chains[0]
 *  - 域名取 metadata.host，空则用 destinationIP:destinationPort
 *  - 设备用 metadata.sourceIP
 */




/* ------------------------------------------------------------------ *
 * conntrack 采集
 * ------------------------------------------------------------------ */


/**
 * 解析单行 conntrack。
 * 返回 { family, proto, orig: {...}, reply: {...} }，字段缺失时为 null。
 * 一行里有两组 "src=.. dst=.. sport=.. dport=.. packets=.. bytes=.."，
 * 第一组是原始方向，第二组是应答方向。
 */

/**
 * conntrack 侧增量累计（只处理直连流量）
 *
 * 方向统一按“设备视角”：orig 是设备发出的 -> tx，reply 是设备收到的 -> rx；
 * 若设备是 orig.dst（外网主动连入），则反过来。
 */

/* ------------------------------------------------------------------ *
 * 统计桶 / history.json（SPEC §4）
 * ------------------------------------------------------------------ */







/* ------------------------------------------------------------------ *
 * 每日汇总（/etc/traffic-stats/daily/YYYY-MM-DD.json）
 * ------------------------------------------------------------------ */





/* ------------------------------------------------------------------ *
 * state.json 组装（SPEC §3）
 * ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ *
 * 一轮采集
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * 飞书日报（SPEC §7；默认 enabled=0，不配置就不会触发）
 * ------------------------------------------------------------------ */







/** 发送日报；返回 { ok, code, msg } */

/* ------------------------------------------------------------------ *
 * 初始化 / 主循环
 * ------------------------------------------------------------------ */





main();
