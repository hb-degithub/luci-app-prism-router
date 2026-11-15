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
 *   TRAFFIC_STATS_CONNTRACK_FILE  覆盖 /proc/net/nf_conntrack（合成数据自测用）
 *   TRAFFIC_STATS_CLASH_API  覆盖 clash_api（自测用）
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
const MAX_DAY_APPS = 512;         /* 当日应用累计上限 */
const MAX_BUCKET_APPS = 256;      /* 单个 5 分钟桶内的应用数上限 */
const BUCKET_SECONDS = 300;       /* 5 分钟桶（SPEC §4） */
const TOP_PER_BUCKET = 10;
const HISTORY_FLUSH_SECONDS = 60; /* history.json 最少刷新间隔 */
const DAILY_RETRY_SECONDS = 600;  /* daily 目录写失败后的重试间隔 */
const DAILY_WRITE_SECONDS = 300;  /* daily 文件最短落盘间隔：/etc 在闪存上，别每轮都写 */

/*
 * ucode 不做函数提升：被调用者必须先于调用者定义。
 * 下面这些函数在源码里是后置定义的，先用 let 建好绑定，避免编译期解析不到。
 */
let store_evict, evict_device, elapsed_ms, node_add, day_dev_add, poll_dev_add;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

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

/** 去掉首尾空白，让 health.reasons 干净可读 */
function trim(s) {
	s = str(s);
	let a = 0, b = length(s);
	while (a < b && index(" \t\r\n", substr(s, a, 1)) >= 0) a++;
	while (b > a && index(" \t\r\n", substr(s, b - 1, 1)) >= 0) b--;
	return substr(s, a, b - a);
}

function clamp(v, lo, hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

/** 按空白切分并丢弃空 token（conntrack / dhcp.leases 都需要） */
function split_ws(s) {
	let out = [];
	for (let t in split(s, ' ')) {
		if (t != '') push(out, t);
	}
	return out;
}

/** 按空格或逗号切分（配置里的 CIDR 列表） */
function split_list(s) {
	let out = [];
	for (let t in split(replace(str(s), ',', ' '), ' ')) {
		if (t != '') push(out, t);
	}
	return out;
}

/** URI 清洗：去掉 shell 元字符与引号，防止拼进命令行时被注入 */
function sanitize_uri(s) {
	let bad = " \t\n\r\"'\\`$;&|<>(){}*?!";
	let out = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (index(bad, c) >= 0) continue;
		out += c;
	}
	return out;
}

/** curl 配置文件里的值：只去掉会破坏 "header = \\"...\\"" 的字符 */
function sanitize_secret(s) {
	let out = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (c == '"' || c == '\\' || ord(c) < 0x20) continue;
		out += c;
	}
	return out;
}

function shell_quote(s) {
	return "'" + replace(str(s), "'", "'\\''") + "'";
}

function new_store() {
	return { rx: 0, tx: 0, chain: '', chain_rx: {}, devs: {} };
}

/** 记录一条 host 流量；chain 取 rx 最大的那条链路 */
function store_add(store, host, chain, rx, tx, ip, cap) {
	let a = store[host];
	if (a == null) {
		a = new_store();
		a.chain = chain;
		store[host] = a;
		/* 只在新建条目时检查容量：length() 是 O(n)，不能放在每条流的热路径上 */
		if (cap > 0 && length(store) > cap) store_evict(store);
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
	return a;
}

/** 超过上限时淘汰流量最小的一条，避免长时间运行无限增长 */
store_evict = function(store) {
	let worst = null, worst_v = null;
	for (let k in store) {
		let v = store[k].rx + store[k].tx;
		if (worst_v == null || v < worst_v) {
			worst_v = v;
			worst = k;
		}
	}
	if (worst != null) delete store[worst];
};

/* ------------------------------------------------------------------ *
 * 文件系统
 * ------------------------------------------------------------------ */

function mkpath(dir) {
	if (dir == null || dir == '' || dir == '/') return true;
	if (fs.stat(dir) != null) return true;
	let parent = fs.dirname(dir);
	if (parent != null && parent != dir) mkpath(parent);
	if (fs.mkdir(dir)) return true;
	return fs.stat(dir) != null;
}

/** 原子写：同目录临时文件 + rename（SPEC §8.7 不允许半截文件） */
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

function unlink_quiet(list) {
	for (let f in list) {
		try {
			fs.unlink(f);
		} catch (e) {
			/* ignore */
		}
	}
}

/* ------------------------------------------------------------------ *
 * JSON 编码（ucode 的 %J 带空格，这里输出紧凑格式，与契约示例一致）
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * IPv4 / CIDR
 * ------------------------------------------------------------------ */

function ipv4_int(s) {
	let p = split(str(s), '.');
	if (length(p) != 4) return null;
	let n = 0;
	for (let i = 0; i < 4; i++) {
		let v = int(p[i]);
		if (type(v) != 'int' || v < 0 || v > 255) return null;
		n = n * 256 + v;
	}
	return n;
}

function bits_to_mask(bits) {
	if (bits == 0) return 0;
	return (0xffffffff << (32 - bits)) & 0xffffffff;
}

function mask_to_bits(m) {
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
	let parts = split(str(s), '/');
	let ip = ipv4_int(parts[0]);
	if (ip == null) return null;
	let bits = 32;
	if (length(parts) > 1) bits = to_int(parts[1], 32);
	bits = clamp(bits, 0, 32);
	let mask = bits_to_mask(bits);
	return { base: ip & mask, mask: mask, bits: bits, text: str(s) };
}

function cidr_match(cidrs, ip) {
	if (ip == null) return false;
	for (let c in cidrs) {
		if ((ip & c.mask) == c.base) return true;
	}
	return false;
}

/** "192.168.100.1" + "255.255.255.0" -> "192.168.100.0/24" */
function cidr_from_ip_mask(ip, mask) {
	let n = ipv4_int(ip);
	if (n == null) return null;
	let bits = mask_to_bits(mask);
	let m = bits_to_mask(bits);
	let net = n & m;
	return sprintf('%d.%d.%d.%d/%d',
		int(net / 16777216) % 256,
		int(net / 65536) % 256,
		int(net / 256) % 256,
		net % 256, bits);
}

/* ------------------------------------------------------------------ *
 * 配置（UCI: /etc/config/traffic-stats，缺省时全部走默认值）
 * ------------------------------------------------------------------ */

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


	let sd = getenv('TRAFFIC_STATS_STATE_DIR');
	c.state_dir = (sd != null && sd != '') ? sd : STATE_DIR_DEFAULT;
	let dd = getenv('TRAFFIC_STATS_DAILY_DIR');
	c.daily_dir = (dd != null && dd != '') ? dd : DAILY_DIR_DEFAULT;
	let cf = getenv('TRAFFIC_STATS_CONNTRACK_FILE');
	c.conntrack_file = (cf != null && cf != '') ? cf : CONNTRACK_FILE;
	let ca = getenv('TRAFFIC_STATS_CLASH_API');
	if (ca != null && ca != '') c.clash_api = ca;
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

/* ------------------------------------------------------------------ *
 * LAN / fake-ip 网段识别
 * ------------------------------------------------------------------ */

/** 解析 `ip -4 -o addr show` -> { ifname: [ "a.b.c.d/len", ... ] } */
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
		/* 形如: 16: br-lan    inet 192.168.100.1/24 brd ... */
		if (length(t) < 4) continue;
		if (t[2] != 'inet') continue;
		let dev = substr(t[1], 0, length(t[1]) - 1);
		if (out[dev] == null) out[dev] = [];
		push(out[dev], t[3]);
	}
	return out;
}

/** LAN 网段：优先 config 里的 lan_ranges，其次 firewall lan zone 的网络，最后兜底 */
function detect_lan_cidrs(cur, cfg) {
	let raw = [];
	if (length(cfg.lan_ranges) > 0) {
		for (let s in cfg.lan_ranges) push(raw, s);
	}

	if (length(raw) == 0) {
		let addrs = read_if_addrs();
		let nets = null;
		try {
			nets = cur.get('firewall', '@zone[0]', 'network');
		} catch (e) {
			nets = null;
		}
		if (type(nets) != 'array' || length(nets) == 0) nets = ['lan'];

		for (let n in nets) {
			let dev = null;
			try {
				dev = cur.get('network', n, 'device');
				if (dev == null) dev = cur.get('network', n, 'ifname');
			} catch (e) {
				dev = null;
			}
			if (type(dev) == 'array') dev = length(dev) > 0 ? str(dev[0]) : null;
			dev = str(dev);
			if (dev == '') dev = 'br-' + n;

			if (addrs[dev] != null) {
				for (let a in addrs[dev]) push(raw, a);
				continue;
			}
			let ip = null, mask = null;
			try {
				ip = cur.get('network', n, 'ipaddr');
				mask = cur.get('network', n, 'netmask');
			} catch (e) {
				ip = null;
			}
			let c = cidr_from_ip_mask(str(ip), str(mask));
			if (c != null) push(raw, c);
		}

		if (length(raw) == 0 && addrs['br-lan'] != null) {
			for (let a in addrs['br-lan']) push(raw, a);
		}
		if (length(raw) == 0) {
			for (let dev in keys(addrs)) {
				if (dev == 'lo' || substr(dev, 0, 3) == 'tun' || substr(dev, 0, 2) == 'wg'
					|| substr(dev, 0, 6) == 'docker' || substr(dev, 0, 4) == 'veth'
					|| substr(dev, 0, 9) == 'tailscale' || substr(dev, 0, 2) == 'pp')
					continue;
				for (let a in addrs[dev]) push(raw, a);
			}
		}
	}

	let out = [];
	for (let s in raw) {
		let c = parse_cidr(s);
		if (c != null) push(out, c);
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * 设备身份：/tmp/dhcp.leases -> { ip: { mac, hostname } }
 * ------------------------------------------------------------------ */

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
			/* 格式: expiry mac ip hostname clientid */
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

/* ------------------------------------------------------------------ *
 * 设备记录
 * ------------------------------------------------------------------ */

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

evict_device = function(ctx) {
	let worst = null, worst_v = null;
	for (let ip in ctx.devices) {
		let v = ctx.devices[ip].last_seen;
		if (worst_v == null || v < worst_v) {
			worst_v = v;
			worst = ip;
		}
	}
	if (worst != null) delete ctx.devices[worst];
};

/* ------------------------------------------------------------------ *
 * clash /connections 采集
 * ------------------------------------------------------------------ */

function clash_url(ctx) {
	let api = sanitize_uri(ctx.cfg.clash_api);
	if (index(api, '://') < 0) api = 'http://' + api;
	return api + '/connections';
}

/** 取一次 /connections；返回 { ok, conns, n, ms, reason } */
function fetch_clash(ctx) {
	let t0 = clock();
	let body = ctx.cfg.state_dir + '/.clash.body';
	let code = ctx.cfg.state_dir + '/.clash.code';
	let errf = ctx.cfg.state_dir + '/.clash.err';
	let timeout = clamp(ctx.cfg.poll_interval * 2, 2, 10);
	let cmd = 'curl -sS -m ' + timeout + ' -K - -o ' + shell_quote(body)
		+ " -w '%{http_code}' " + shell_quote(clash_url(ctx))
		+ ' > ' + shell_quote(code) + ' 2> ' + shell_quote(errf);
	let res = { ok: false, conns: [], ms: 0, reason: '', http: 0, n: 0 };

	try {
		let p = fs.popen(cmd, 'w');
		if (ctx.cfg.clash_secret != '') {
			/* 走 curl 配置的 stdin，避免 secret 出现在 ps 命令行里 */
			let sec = sanitize_secret(ctx.cfg.clash_secret);
			p.write("header = \"Authorization: Bearer " + sec + "\"\n");
		}
		p.close();
	} catch (e) {
		res.reason = 'clash: 执行 curl 失败（' + str(e) + '）';
		res.ms = elapsed_ms(t0);
		unlink_quiet([body, code, errf]);
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
		let errtext = trim(str(fs.readfile(errf)));
		if (http == 0) {
			res.reason = 'clash: 无法连接 ' + ctx.cfg.clash_api
				+ (errtext != '' ? '（' + substr(replace(errtext, '\n', ' '), 0, 90) + '）' : '');
		} else if (http == 401 || http == 403) {
			res.reason = 'clash: 认证失败 HTTP ' + http + '（检查 clash_secret / openclash.config.dashboard_password）';
		} else {
			let detail = (text != null && text != '') ? substr(replace(text, '\n', ' '), 0, 90) : '';
			res.reason = 'clash: HTTP ' + http + (detail != '' ? ' ' + detail : '');
		}
		res.ms = elapsed_ms(t0);
		unlink_quiet([body, code, errf]);
		return res;
	}

	let obj = null;
	try {
		obj = (text != null && text != '') ? json(text) : null;
	} catch (e) {
		obj = null;
	}
	if (type(obj) != 'object' || type(obj.connections) != 'array') {
		res.reason = 'clash: /connections 返回的不是预期 JSON 结构';
		res.ms = elapsed_ms(t0);
		unlink_quiet([body, code, errf]);
		return res;
	}

	res.ok = true;
	res.conns = obj.connections;
	res.n = length(obj.connections);
	res.ms = elapsed_ms(t0);
	unlink_quiet([body, code, errf]);
	return res;
}

elapsed_ms = function(t0) {
	let t1 = clock();
	return int(((t1[0] - t0[0]) * 1000000000 + (t1[1] - t0[1])) / 1000000);
};

function ms_between(a, b) {
	return int(((b[0] - a[0]) * 1000000000 + (b[1] - a[1])) / 1000000);
}

/**
 * clash 侧增量累计
 *  - id 是稳定键，用上轮快照做差；连接消失时删除快照（最后一次已知值即已计入）
 *  - chains[0] == "DIRECT" -> 直连；否则代理，节点名 = chains[0]
 *  - 域名取 metadata.host，空则用 destinationIP:destinationPort
 *  - 设备用 metadata.sourceIP
 */
function accumulate_clash(ctx, conns) {
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
			ctx.day_totals.direct_rx += ddl;
			ctx.day_totals.direct_tx += dul;
		} else {
			ctx.totals.proxy_rx += ddl;
			ctx.totals.proxy_tx += dul;
			ctx.day_totals.proxy_rx += ddl;
			ctx.day_totals.proxy_tx += dul;
		}

		node_add(ctx.nodes, node, ddl, dul);
		node_add(ctx.day_nodes, node, ddl, dul);
		store_add(ctx.apps, host, node, ddl, dul, ip, MAX_GLOBAL_APPS);
		store_add(ctx.day_apps, host, node, ddl, dul, ip, MAX_DAY_APPS);
		store_add(ctx.poll_apps, host, node, ddl, dul, ip, 0);

		if (ip != '') {
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
			poll_dev_add(ctx, ip, ddl, dul);
		}
	}

	/* 已消失的连接：从快照表移除以保证内存有界 */
	for (let id in keys(ctx.clash_prev)) {
		if (seen[id] == null) delete ctx.clash_prev[id];
	}
}

node_add = function(store, node, rx, tx) {
	let n = store[node];
	if (n == null) {
		n = { rx: 0, tx: 0 };
		store[node] = n;
	}
	n.rx += rx;
	n.tx += tx;
};

day_dev_add = function(ctx, ip, rx, tx) {
	let d = ctx.day_devices[ip];
	if (d == null) {
		d = { rx: 0, tx: 0 };
		ctx.day_devices[ip] = d;
	}
	d.rx += rx;
	d.tx += tx;
};

poll_dev_add = function(ctx, ip, rx, tx) {
	let d = ctx.poll_devs[ip];
	if (d == null) {
		d = { rx: 0, tx: 0 };
		ctx.poll_devs[ip] = d;
	}
	d.rx += rx;
	d.tx += tx;
};

/* ------------------------------------------------------------------ *
 * conntrack 采集
 * ------------------------------------------------------------------ */

function fetch_conntrack(ctx) {
	let txt = null;
	try {
		txt = fs.readfile(ctx.cfg.conntrack_file);
	} catch (e) {
		txt = null;
	}
	if (txt == null) {
		return { ok: false, text: null,
			reason: 'conntrack: 无法读取 ' + ctx.cfg.conntrack_file + '（模块未加载或无权限），直连流量无法统计' };
	}
	return { ok: true, text: txt, reason: '' };
}

/**
 * 解析单行 conntrack。
 * 一行里有两组 "src=.. dst=.. sport=.. dport=.. packets=.. bytes=.."，
 * 第一组是原始方向，第二组是应答方向。
 * 为了性能这里不对 token 做 split(tok,"=")，只按前缀取需要的字段。
 */
function parse_ct_line(line) {
	let toks = split_ws(line);
	if (length(toks) < 8) return null;
	let family = toks[0];
	if (family != 'ipv4' && family != 'ipv6') return null;
	let proto = toks[2];

	let groups = [];
	let cur = null;
	for (let tk in toks) {
		let c0 = substr(tk, 0, 1);
		if (c0 == 's') {
			if (substr(tk, 0, 4) == 'src=') {
				cur = { src: substr(tk, 4) };
				push(groups, cur);
			} else if (cur != null && substr(tk, 0, 6) == 'sport=') {
				cur.sport = substr(tk, 6);
			}
		} else if (c0 == 'd') {
			if (cur == null) continue;
			if (substr(tk, 0, 4) == 'dst=') cur.dst = substr(tk, 4);
			else if (substr(tk, 0, 6) == 'dport=') cur.dport = substr(tk, 6);
		} else if (c0 == 'b') {
			if (cur != null && substr(tk, 0, 6) == 'bytes=') cur.bytes = to_int(substr(tk, 6), 0);
		} else if (c0 == 'p') {
			if (cur != null && substr(tk, 0, 8) == 'packets=') cur.packets = to_int(substr(tk, 8), 0);
		}
	}
	if (length(groups) == 0) return null;
	let orig = groups[0];
	if (orig.src == null || orig.dst == null) return null;
	if (orig.bytes == null) orig.bytes = 0;
	let reply = (length(groups) > 1) ? groups[1] : null;
	if (reply != null && reply.bytes == null) reply.bytes = 0;
	return { family: family, proto: proto, orig: orig, reply: reply };
}

/**
 * conntrack 侧增量累计（只处理直连流量）
 *
 * 方向统一按“设备视角”：orig 是设备发出的 -> tx，reply 是设备收到的 -> rx；
 * 若设备是 orig.dst（外网主动连入），则反过来。
 */
function accumulate_conntrack(ctx, text) {
	let seen = {};
	let total = 0;

	for (let line in split(text, '\n')) {
		if (line == '') continue;
		total++;
		/* 粗筛：orig 里必须出现 LAN 网段前缀才值得解析，能省掉一大半 tokenize */
		let maybe = false;
		for (let pfx in ctx.lan_prefixes) {
			if (index(line, pfx) >= 0) { maybe = true; break; }
		}
		if (!maybe) continue;
		let flow = parse_ct_line(line);
		if (flow == null) continue;

		let o = flow.orig;
		let osrc = ipv4_int(o.src);
		let odst = ipv4_int(o.dst);
		let ip = null, dir = 0;

		if (osrc != null && cidr_match(ctx.lan_cidrs, osrc)) {
			ip = o.src;
			dir = 1; /* 设备发出 */
		} else if (odst != null && cidr_match(ctx.lan_cidrs, odst)) {
			ip = o.dst;
			dir = 2; /* 设备接收（外网主动连入） */
		} else {
			continue; /* 与 LAN 设备无关（路由自身 / clash 的出站腿） */
		}

		/* 去重：orig.dst 落在 fake-ip 段 -> 已被 clash 接管，跳过，绝不重复计入直连 */
		if (odst != null && cidr_match(ctx.fake_cidrs, odst)) {
			ctx.fakeip_skipped++;
			continue;
		}

		/* LAN 内部互访不计入设备直连，避免把内网流量当外网用量 */
		if (dir == 1 && odst != null && cidr_match(ctx.lan_cidrs, odst)) continue;

		/* 组播/广播不是外网用量（mDNS、SSDP 之类） */
		if (odst != null && (odst >= 0xe0000000 || odst == 0xffffffff)) continue;

		let key = flow.proto + '|' + o.src + '|' + str(o.sport) + '|' + o.dst + '|' + str(o.dport);
		seen[key] = 1;

		let cur_tx = (dir == 1) ? o.bytes : ((flow.reply != null) ? flow.reply.bytes : 0);
		let cur_rx = (dir == 1) ? ((flow.reply != null) ? flow.reply.bytes : 0) : o.bytes;

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
		ctx.day_totals.direct_rx += d_rx;
		ctx.day_totals.direct_tx += d_tx;
		node_add(ctx.nodes, 'DIRECT', d_rx, d_tx);
		node_add(ctx.day_nodes, 'DIRECT', d_rx, d_tx);

		let host = o.dst + (o.dport != null ? ':' + o.dport : '');
		store_add(ctx.apps, host, 'DIRECT', d_rx, d_tx, ip, MAX_GLOBAL_APPS);
		store_add(ctx.day_apps, host, 'DIRECT', d_rx, d_tx, ip, MAX_DAY_APPS);
		store_add(ctx.poll_apps, host, 'DIRECT', d_rx, d_tx, ip, 0);

		let d = dev_slot(ctx, ip);
		d.last_seen = ctx.now;
		let ident = dev_identity(ctx, ip);
		if (ident.mac != '') d.mac = ident.mac;
		if (ident.hostname != '') d.hostname = ident.hostname;
		d.direct_rx += d_rx;
		d.direct_tx += d_tx;
		d.rx_rate += d_rx;
		d.tx_rate += d_tx;
		store_add(d.apps, host, 'DIRECT', d_rx, d_tx, null, MAX_DEV_APPS);
		day_dev_add(ctx, ip, d_rx, d_tx);
		poll_dev_add(ctx, ip, d_rx, d_tx);
	}

	ctx.ct_count = total;

	/* 已消失的流：清理快照表 */
	for (let key in keys(ctx.ct_prev)) {
		if (seen[key] == null) delete ctx.ct_prev[key];
	}
}

/* ------------------------------------------------------------------ *
 * 5 分钟桶 / history.json（SPEC §4）
 * ------------------------------------------------------------------ */

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

	for (let host in ctx.poll_apps) {
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
	for (let ip in ctx.poll_devs) {
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
	while (length(b.apps) > MAX_BUCKET_APPS) delete b.apps[keys(b.apps)[0]];
}

function bucket_finalize(b) {
	let apps = [];
	for (let host in b.apps) push(apps, { host: host, rx: b.apps[host].rx, tx: b.apps[host].tx });
	apps = sort(apps, function(x, y) { return (y.rx + y.tx) - (x.rx + x.tx); });

	let devs = [];
	for (let ip in b.devs) push(devs, { ip: ip, rx: b.devs[ip].rx, tx: b.devs[ip].tx });
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
	let now = ctx.now > 0 ? ctx.now : time();
	if (!force && ctx.last_history_flush > 0
		&& now - ctx.last_history_flush < HISTORY_FLUSH_SECONDS)
		return;

	let buckets = [];
	for (let b in ctx.buckets) push(buckets, b);
	if (ctx.cur_bucket != null) push(buckets, bucket_finalize(ctx.cur_bucket));

	mkpath(ctx.cfg.state_dir);
	let ok = atomic_write(ctx.cfg.state_dir + '/history.json',
		jenc({ day: ctx.day, buckets: buckets }));
	ctx.last_history_flush = now;
	if (!ok) dbg(ctx, 'write history.json failed: ' + str(fs.error()));
}

/* ------------------------------------------------------------------ *
 * 每日汇总（/etc/traffic-stats/daily/YYYY-MM-DD.json）
 * ------------------------------------------------------------------ */

function day_summary(ctx) {
	let devices = [];
	for (let ip in ctx.day_devices) {
		let d = ctx.day_devices[ip];
		let ident = dev_identity(ctx, ip);
		push(devices, {
			ip: ip, mac: ident.mac, hostname: ident.hostname,
			rx: d.rx, tx: d.tx
		});
	}
	devices = sort(devices, function(a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });

	let apps = [];
	for (let host in ctx.day_apps) {
		let a = ctx.day_apps[host];
		push(apps, { host: host, rx: a.rx, tx: a.tx, chain: a.chain, devices: length(a.devs) });
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
	if (!force) {
		if (ctx.daily_fail_ts > 0 && ctx.now - ctx.daily_fail_ts < DAILY_RETRY_SECONDS) return;
		if (ctx.last_daily_write > 0 && ctx.now - ctx.last_daily_write < DAILY_WRITE_SECONDS) return;
	}
	if (!mkpath(ctx.cfg.daily_dir)) {
		ctx.daily_fail_ts = ctx.now;
		return;
	}
	if (!atomic_write(ctx.cfg.daily_dir + '/' + ctx.day + '.json', jenc(day_summary(ctx)))) {
		ctx.daily_fail_ts = ctx.now;
		return;
	}
	ctx.daily_fail_ts = 0;
	ctx.last_daily_write = ctx.now;
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
		/* YYYY-MM-DD.json */
		if (length(n) != 15 || substr(n, 10) != '.json') continue;
		push(days, n);
	}
	days = sort(days);
	while (length(days) > ctx.cfg.history_days) {
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
	if (ctx.day != '') {
		daily_write(ctx, true);      /* 先把前一天落盘（此时 ctx.day 仍是旧值） */
		ctx.buckets = [];
	}
	ctx.day = d;
	ctx.day_totals = { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0 };
	ctx.day_devices = {};
	ctx.day_apps = {};
	ctx.day_nodes = {};
	ctx.cur_bucket = null;
	ctx.last_history_flush = 0;
	daily_prune(ctx);
}

/* ------------------------------------------------------------------ *
 * state.json 组装（SPEC §3）
 * ------------------------------------------------------------------ */

function device_apps_out(apps) {
	let list = [];
	for (let host in apps) {
		push(list, { host: host, rx: apps[host].rx, tx: apps[host].tx, chain: apps[host].chain });
	}
	list = sort(list, function(a, b) { return b.rx - a.rx; });

	let out = {};
	let other = { rx: 0, tx: 0, chain: 'MIXED' };
	for (let i = 0; i < length(list); i++) {
		let a = list[i];
		if (i < MAX_DEV_APPS_OUT) out[a.host] = { rx: a.rx, tx: a.tx, chain: a.chain };
		else { other.rx += a.rx; other.tx += a.tx; }
	}
	if (other.rx > 0 || other.tx > 0) out['__other__'] = other;
	return out;
}

function build_state(ctx) {
	let dt = ctx.poll_dt > 0 ? ctx.poll_dt : 1;

	let total_rx = ctx.totals.direct_rx + ctx.totals.proxy_rx;
	let total_tx = ctx.totals.direct_tx + ctx.totals.proxy_tx;
	ctx.totals.rx_rate = int((total_rx - ctx.prev_total_rx) / dt);
	ctx.totals.tx_rate = int((total_tx - ctx.prev_total_tx) / dt);
	ctx.prev_total_rx = total_rx;
	ctx.prev_total_tx = total_tx;

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

	let apps = [];
	for (let host in ctx.apps) {
		let a = ctx.apps[host];
		push(apps, { host: host, rx: a.rx, tx: a.tx, chain: a.chain, devices: length(a.devs) });
	}
	apps = sort(apps, function(a, b) { return b.rx - a.rx; });
	apps = slice(apps, 0, MAX_OUT_APPS);

	let nodes = {};
	for (let k in ctx.nodes) nodes[k] = { rx: ctx.nodes[k].rx, tx: ctx.nodes[k].tx };

	let reasons = ctx.reasons;
	let conf = 'exact';
	if (length(reasons) > 0) {
		conf = (ctx.source.clash == 'error' && ctx.source.conntrack == 'error')
			? 'unavailable' : 'degraded';
	}

	return {
		ts: ctx.now,
		uptime: ctx.now - ctx.started,
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

/* ------------------------------------------------------------------ *
 * 一轮采集
 * ------------------------------------------------------------------ */

function poll(ctx) {
	let t0 = clock();
	ctx.now = time();
	let dt = ctx.now - ctx.last_poll_ts;
	if (dt <= 0) dt = 1;
	ctx.last_poll_ts = ctx.now;
	ctx.poll_dt = dt;

	day_rollover_check(ctx);

	/* 5 分钟桶切换 */
	let bts = bucket_ts_of(ctx.now);
	if (ctx.cur_bucket == null) {
		bucket_reset(ctx, bts);
	} else if (bts != ctx.cur_bucket.ts) {
		push(ctx.buckets, bucket_finalize(ctx.cur_bucket));
		bucket_reset(ctx, bts);
	}

	load_leases(ctx);

	/* 本轮增量累加器 */
	for (let ip in ctx.devices) {
		ctx.devices[ip].rx_rate = 0;
		ctx.devices[ip].tx_rate = 0;
	}
	ctx.poll_apps = {};
	ctx.poll_devs = {};
	ctx.fakeip_skipped = 0;

	let before_direct_rx = ctx.totals.direct_rx;
	let before_direct_tx = ctx.totals.direct_tx;
	let before_proxy_rx = ctx.totals.proxy_rx;
	let before_proxy_tx = ctx.totals.proxy_tx;

	let reasons = [];

	let t_clash0 = clock();
	let clash = fetch_clash(ctx);
	ctx.clash_ms = clash.ms;
	if (clash.ok) {
		ctx.source.clash = 'ok';
		ctx.clash_count = clash.n;
		accumulate_clash(ctx, clash.conns);
	} else {
		ctx.source.clash = 'error';
		ctx.clash_count = 0;
		push(reasons, clash.reason);
	}

	let t_clash1 = clock();
	let ct = fetch_conntrack(ctx);
	if (ct.ok) {
		ctx.source.conntrack = 'ok';
		accumulate_conntrack(ctx, ct.text);
	} else {
		ctx.source.conntrack = 'error';
		ctx.ct_count = 0;
		push(reasons, ct.reason);
	}

	let deltas = {
		direct_rx: ctx.totals.direct_rx - before_direct_rx,
		direct_tx: ctx.totals.direct_tx - before_direct_tx,
		proxy_rx: ctx.totals.proxy_rx - before_proxy_rx,
		proxy_tx: ctx.totals.proxy_tx - before_proxy_tx
	};
	bucket_add(ctx, deltas);

	/* 自适应轮询：连续空闲则降频，见 tick()。空闲判定=本轮四个方向增量全为 0。 */
	let activity = deltas.direct_rx + deltas.direct_tx + deltas.proxy_rx + deltas.proxy_tx;
	ctx.idle_rounds = (activity == 0) ? ((ctx.idle_rounds || 0) + 1) : 0;

	ctx.reasons = reasons;
	ctx.poll_ms = elapsed_ms(t0);
	let t_ct1 = clock();

	let st = build_state(ctx);
	mkpath(ctx.cfg.state_dir);
	if (!atomic_write(ctx.cfg.state_dir + '/state.json', jenc(st)))
		dbg(ctx, 'write state.json failed: ' + str(fs.error()));

	let t_build1 = clock();
	if (ctx.cfg.debug)
		dbg(ctx, sprintf('timings clash=%dms ct=%dms build_write=%dms total=%dms',
			ms_between(t_clash0, t_clash1), ms_between(t_clash1, t_ct1),
			ms_between(t_ct1, t_build1), ctx.poll_ms));

	history_flush(ctx, false);
	daily_write(ctx, false);

	return st;
}

/* ------------------------------------------------------------------ *
 * 飞书日报（SPEC §7；默认 enabled=0）
 * ------------------------------------------------------------------ */

function hmac_sign_b64(ts, secret) {
	/* key = timestamp + "\n" + secret，对空串做 HMAC-SHA256，再 Base64 */
	let key = str(ts) + '\n' + secret;
	let cmd = "printf '%s' '' | openssl dgst -sha256 -hmac " + shell_quote(key)
		+ ' -binary | openssl base64 -A';
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
	return res == '' ? null : res;
}

function fmt_bytes(n) {
	n = to_int(n, 0);
	if (n < 1024) return n + ' B';
	if (n < 1048576) return sprintf('%d.%d KB', int(n / 1024), int(n % 1024 / 102));
	if (n < 1073741824) return sprintf('%d.%d MB', int(n / 1048576), int(n % 1048576 / 104858));
	return sprintf('%d.%d GB', int(n / 1073741824), int(n % 1073741824 / 107374183));
}


/** 发送日报/测试消息；返回 { ok, code, msg } */


/* ------------------------------------------------------------------ *
 * 初始化 / 主循环
 * ------------------------------------------------------------------ */

function new_ctx() {
	let now = time();
	return {
		cfg: null,
		started: now,
		now: now,
		last_poll_ts: now - 5,
		poll_dt: 5,
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
		day_totals: { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0 },
		day_devices: {},
		day_apps: {},
		day_nodes: {},
		day: local_day_str(now),
		buckets: [],
		cur_bucket: null,
		clash_prev: {},
		ct_prev: {},
		leases: {},
		leases_ts: 0,
		lan_cidrs: [],
		lan_prefixes: [],
		fake_cidrs: [],
		poll_apps: {},
		poll_devs: {},
		last_history_flush: 0,
		daily_fail_ts: 0,
		last_daily_write: 0,
		stopping: false
	};
}

/** 由 LAN 网段推出用于粗筛的字符串前缀（/24 及以上精度才用） */
function lan_prefixes_of(cidrs) {
	let out = [];
	for (let c in cidrs) {
		if (c.bits < 8) continue;
		let base = sprintf('%d.%d.%d.%d', int(c.base / 16777216) % 256,
			int(c.base / 65536) % 256, int(c.base / 256) % 256, c.base % 256);
		let p = split(base, '.');
		if (c.bits >= 24) push(out, p[0] + '.' + p[1] + '.' + p[2] + '.');
		else if (c.bits >= 16) push(out, p[0] + '.' + p[1] + '.');
		else push(out, p[0] + '.');
	}
	return out;
}

function lan_txt_of(ctx) {
	let out = [];
	for (let c in ctx.lan_cidrs) push(out, c.text);
	return out;
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
		printf('traffic-statsd: disabled by config (enabled=0)\n');
		exit(0);
	}

	load_leases(ctx);
	ctx.leases_ts = time();

	for (let s in ctx.cfg.fake_ip_ranges) {
		let c = parse_cidr(s);
		if (c != null) push(ctx.fake_cidrs, c);
	}
	ctx.lan_cidrs = detect_lan_cidrs(cur, ctx.cfg);
	ctx.lan_prefixes = lan_prefixes_of(ctx.lan_cidrs);

	dbg(ctx, 'lan=' + join(',', lan_txt_of(ctx)) + '  fake=' + join(',', ctx.cfg.fake_ip_ranges)
		+ '  interval=' + ctx.cfg.poll_interval + 's  api=' + ctx.cfg.clash_api);

	if (length(ctx.lan_cidrs) == 0)
		push(ctx.reasons, 'lan: 未能识别 LAN 网段，conntrack 直连流量将统计不到');
	if (length(ctx.fake_cidrs) == 0)
		push(ctx.reasons, 'fake_ip: fake_ip_ranges 无效，无法去重，可能重复计数');

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
		if (st != null)
			printf('once: devices=%d proxy_rx=%d direct_rx=%d apps=%d reasons=%d\n',
				length(st.devices), st.totals.proxy_rx, st.totals.direct_rx,
				length(st.apps), length(st.health.reasons));
		exit(0);
	}

	uloop.init();

	let tmr = null;
	let stop = function(tag) {
		ctx.stopping = true;
		flush_all(ctx, tag);
		uloop.end();
	};
	uloop.signal('TERM', function() { stop('TERM'); });
	uloop.signal('INT', function() { stop('INT'); });

	let tick = function() {
		if (ctx.stopping) return;
		try {
			poll(ctx);
		} catch (e) {
			warn('traffic-statsd: poll error: ' + str(e) + '\n');
		}
		if (!ctx.stopping && tmr != null) {
			/* 空闲 >=2 轮后降到 3 倍间隔（上限 30s），有流量立即恢复。
			   速率由 poll 内部按实际 dt 计算，降频不影响速率正确性。 */
			let base = ctx.cfg.poll_interval;
			let iv = ((ctx.idle_rounds || 0) >= 2) ? clamp(base * 3, base, 30) : base;
			if (iv != ctx.cur_interval) {
				ctx.cur_interval = iv;
				dbg(ctx, 'adaptive interval -> ' + iv + 's (idle_rounds=' + (ctx.idle_rounds || 0) + ')');
			}
			tmr.set(iv * 1000);
		}
	};

	printf('traffic-statsd %s started (interval=%ds, lan=%s)\n',
		DAEMON_VERSION, ctx.cfg.poll_interval, join(',', lan_txt_of(ctx)));

	/* 先跑一轮，之后按固定间隔自调度（上游慢时不会堆积） */
	tick();
	tmr = uloop.timer(ctx.cfg.poll_interval * 1000, tick);
	uloop.run();

	flush_all(ctx, 'exit');
	dbg(ctx, 'stopped');
}

main();
