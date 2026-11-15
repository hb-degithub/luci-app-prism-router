#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// push.uc —— 子节点：把本机 state.json 汇总 POST 给母节点（子母多节点汇总）
//
// 安装位置：/usr/share/traffic-stats/push.uc
//（由 tools/build-ipk.sh 打进 traffic-stats 包；母节点接收端见 ingest.uc）
//
// 定时（cron 由用户自行添加，本包不会改 crontab）：
//   # 子节点：每分钟把汇总推给母节点
//   * * * * * /usr/bin/ucode /usr/share/traffic-stats/push.uc >/dev/null 2>&1
//
// 手动自测（不联网，只打印将要发送的请求；不要求 openssl）：
//   TRAFFIC_STATS_PUSH_DRY=1 /usr/bin/ucode /usr/share/traffic-stats/push.uc
//
// 协议（见 docs/SPEC.md 的子母扩展）：
//   POST <mother_url>/cgi-bin/traffic-stats-ingest
//   Content-Type: application/json
//   X-Node-Id:   <node_id>
//   X-Timestamp: <unix 秒>
//   X-Sign:      base64(HMAC-SHA256(secret, node_id + "\n" + timestamp + "\n" + sha256_hex(body)))
//   body: {"node_id","name","ts","totals":{...},"nodes":{...},"devices":[...最多20],"apps":[...最多20]}
//
// 注意（真机实测）：OpenWrt 的 uhttpd 只把 HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST /
// HTTP_USER_AGENT 传进 CGI 环境，自定义 X-* 头会被静默丢弃。所以除了上面三个头，本脚本
// 还把 node_id / ts / sign 以 percent 编码放进 URL 查询串；母节点 ingest.uc 先读头、再读
// 查询串，两种 web 服务器都能用。头仍然照发，方便 nginx 等标准 CGI 环境直接读取。
//
// 语义（与 docs/SPEC.md §3.1 一致，前端不得把 totals 当"今日"）：
//   * totals / nodes 是「子节点守护进程启动以来的累计值」，母节点只展示、不累加。
//   * body.ts 取 state.json 的 ts（数据时间）；母节点用 now-ts 算 age_sec，所以子节点
//     守护进程挂掉时，母节点会如实显示"数据已 N 分钟未更新"（不会假装新鲜）。
//   * devices / apps 只发前 20 条（按流量降序），每设备不再带 apps 明细，控制报文体积。
//
// UCI（section traffic-stats.settings）：
//   mother_enabled '0'   1 = 允许推送；0 = 关闭（默认）
//   mother_url     ''    母节点地址，例如 http://192.168.100.1；留空 = 不推送
//   mother_secret  ''    子母共享密钥（母节点校验 HMAC），两边必须一致
//   node_id        ''    本机节点 ID；留空则首次推送时生成（主机名 + MAC 后 4 位）并写回 UCI
//   node_name      ''    展示名；留空则用 node_id
//
// 失败处理：网络不通 / 非 200 / 响应 code != 0 → 记日志并 exit 0，不重试、不刷屏
//（cron 每分钟会再试一次）。日志：/tmp/traffic-stats/push.log（512 KB 轮转），
// 成功日志 10 分钟最多一条；错误同时进 syslog（logger -t traffic-stats-push）。
//
// 退出码：0 = 成功 / 无需推送；1 = 环境或配置错误（日志里有原因，下次 cron 还会再试）。
//
// 依赖：ucode（fs/uci/json 内建）、curl、openssl（openssl-util，HMAC 签名用）。
// 环境变量（只给测试/现场排查用，线上默认行为不受影响）：
//   TRAFFIC_STATS_STATE_DIR   覆盖 /tmp/traffic-stats（state.json 与日志目录）
//   TRAFFIC_STATS_PUSH_DRY=1  只打印请求（url/headers/body），不签名、不联网
//
// 风格：与 feishu.uc 一致（run/shq/read_json/log/jstr 等小工具同名同义）。
'use strict';

import { readfile, access, popen, writefile, unlink, stat, open, rename, lsdir } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG     = 'traffic-stats';
const BASE           = getenv('TRAFFIC_STATS_STATE_DIR') ?? '/tmp/traffic-stats';
const DRY_RUN        = length(getenv('TRAFFIC_STATS_PUSH_DRY') ?? '') > 0;
const LOG_MAX        = 524288;              // 512 KB 轮转
const CURL_TIMEOUT   = 12;                  // 秒；cron 每分钟一次，别拖过周期
const MAX_DEVICES    = 20;
const MAX_APPS       = 20;
const MAX_NODE_NAMES = 64;

let _seq = 0;

// ───────────────────────────── 基础工具 ─────────────────────────────

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

function positive(value) {
    const n = integer(value, 0);
    return (n < 0) ? 0 : n;
}

/* 按字节截断，且不切断 UTF-8 码点（同 feishu.uc 的 cut）。 */
function cut(s, maxb) {
    s = `${s}`;

    if (length(s) <= maxb)
        return s;

    let n = maxb - 3;

    if (n < 0)
        n = 0;

    while (n > 0) {
        const b = ord(substr(s, n, 1));

        if ((b & 0xc0) != 0x80)
            break;

        n--;
    }

    return substr(s, 0, n) + '…';
}

/* 单引号 shell 转义（换行、$、反引号、双引号都会被安全包住）。 */
function shq(s) {
    return `'${replace(`${s}`, "'", "'\\''")}'`;
}

/* percent 编码：node_id / ts / base64 签名放进查询串时用（base64 的 + / = 必须转义）。 */
function url_encode(s) {
    let out = '';

    for (let i = 0; i < length(s); i++) {
        const c = substr(s, i, 1);

        if (match(c, /[A-Za-z0-9._~-]/))
            out += c;
        else
            out += sprintf('%%%02X', ord(c));
    }

    return out;
}

/* 执行命令并取回 stdout，返回 {code, out}（code 为进程退出码）。 */
function run(cmd) {
    let p = null;

    try {
        p = popen(cmd);
    }
    catch (e) {
        return { code: -1, out: '' };
    }

    if (p == null)
        return { code: -1, out: '' };

    let out = '', buf = '';

    try {
        while (length(buf = p.read(4096)))
            out += buf;
    }
    catch (e) {
        /* 读失败也要把子进程收掉 */
    }

    return { code: p.close(), out: out };
}

function getpid() {
    const m = match(trim(text(readfile('/proc/self/stat'), '')), /^([0-9]+)/);

    return m ? int(m[1]) : int(time());
}

function stamp() {
    const t = localtime(time());

    return sprintf('%04d-%02d-%02d %02d:%02d:%02d',
        t.year, t.mon, t.mday, t.hour, t.min, t.sec);
}

function ensure_dir(path) {
    if (length(path) == 0 || path == '.')
        return false;

    if (access(path))
        return true;

    return system([ 'mkdir', '-p', path ]) == 0;
}

function read_json(path) {
    let raw = null;

    try {
        if (!access(path))
            return null;

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

/* 日志节流：同一类消息在 interval 秒内最多记一次（避免每分钟刷屏）。
   注意：ucode 在函数定义处绑定标识符（strict 模式下引用尚未声明的函数会直接
   Reference error），所以 throttle 必须定义在 log 之前，不能依赖"稍后定义"。 */
function throttle(key, interval) {
    const path = sprintf('%s/push-%s.last', BASE, key);
    const now = time();
    let last = 0;

    try {
        last = integer(trim(text(readfile(path), '')), 0);
    }
    catch (e) {
        last = 0;
    }

    if (last > 0 && now - last < interval)
        return false;

    try { writefile(path, sprintf('%d\n', now)); } catch (e) { }

    return true;
}

function log(level, msg) {
    const line = sprintf('%s [%s] %s\n', stamp(), level, msg);

    try {
        ensure_dir(BASE);

        const lp = `${BASE}/push.log`;

        if (access(lp)) {
            const st = stat(lp);

            if (st != null && st.size > LOG_MAX) {
                try { unlink(`${lp}.1`); } catch (e) { }
                try { rename(lp, `${lp}.1`); } catch (e) { }
            }
        }

        const fd = open(lp, 'a');

        if (fd != null) {
            fd.write(line);
            fd.close();
        }
        else {
            print(line);
        }
    }
    catch (e) {
        print(line);
    }

    if (level == 'ERROR' || level == 'WARN') {
        /* 日志文件每行都写（会轮转），但 syslog 最多 5 分钟一条，母节点长期不可达时不刷屏。 */
        if (level != 'ERROR' || throttle('syslog', 300))
            system([ 'logger', '-t', 'traffic-stats-push', '-p',
                (level == 'ERROR' ? 'daemon.err' : 'daemon.warn'), cut(msg, 200) ]);
    }
}

// ───────────────────────────── JSON ─────────────────────────────

/* ucode 的 %J 会插空格（`{ "a": 1 }`），压成紧凑 JSON：
   只在字符串外部删空白，字符串内部的空格/换行原样保留（同 feishu.uc）。 */
function jminify(s) {
    let out = '', instr = false, esc = false;

    for (let i = 0; i < length(s); i++) {
        const c = substr(s, i, 1);

        if (instr) {
            out += c;

            if (esc)
                esc = false;
            else if (c == '\\')
                esc = true;
            else if (c == '"')
                instr = false;
        }
        else if (c == '"') {
            instr = true;
            out += c;
        }
        else if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
            /* drop */
        }
        else {
            out += c;
        }
    }

    return out;
}

function jstr(o) {
    return jminify(sprintf('%J', o));
}

// ───────────────────────────── 签名 ─────────────────────────────

function openssl_bin() {
    for (let path in [ '/usr/bin/openssl', '/usr/sbin/openssl', '/bin/openssl' ])
        if (access(path))
            return path;

    return null;
}

function curl_bin() {
    for (let path in [ '/usr/bin/curl', '/usr/sbin/curl', '/bin/curl' ])
        if (access(path))
            return path;

    return null;
}

function tmp_path(kind) {
    return sprintf('%s/.push-%s-%d-%d', BASE, kind, getpid(), _seq++);
}

function hex_of(s) {
    let hex = '';

    for (let i = 0; i < length(s); i++)
        hex += sprintf('%02x', ord(substr(s, i, 1)));

    return hex;
}

/* body 的 sha256（hex 小写）。优先 busybox sha256sum，其次 openssl dgst。 */
function sha256_hex(txt) {
    const f = tmp_path('body');
    let hex = '';

    try {
        writefile(f, txt);
    }
    catch (e) {
        return '';
    }

    let r = run(sprintf('sha256sum %s 2>/dev/null', shq(f)));

    if (r.code == 0) {
        const m = match(trim(r.out), /^([0-9a-fA-F]{64})/);

        if (m != null)
            hex = lc(m[1]);
    }

    if (length(hex) == 0) {
        const ossl = openssl_bin();

        if (ossl != null) {
            r = run(sprintf('%s dgst -sha256 %s 2>/dev/null', ossl, shq(f)));
            const m = match(r.out, /([0-9a-fA-F]{64})/);

            if (r.code == 0 && m != null)
                hex = lc(m[1]);
        }
    }

    try { unlink(f); } catch (e) { }

    return hex;
}

/* base64(HMAC-SHA256(secret, message))，与 feishu.uc 相同的 openssl 用法。 */
function hmac_b64(secret, message) {
    const ossl = openssl_bin();

    if (ossl == null)
        return '';

    const f = tmp_path('msg');

    try {
        writefile(f, message);
    }
    catch (e) {
        return '';
    }

    /* 主路径：-hmac 直接把 key 作为 argv（shq 保证特殊字符安全） */
    let r = run(sprintf('%s dgst -sha256 -hmac %s -binary < %s | %s base64 -A',
        ossl, shq(secret), shq(f), ossl));
    let sig = trim(r.out);

    if (r.code == 0 && match(sig, /^[A-Za-z0-9+\/=]+$/)) {
        try { unlink(f); } catch (e) { }
        return sig;
    }

    /* 备用路径：hexkey（某些 openssl 构建对 argv 里的特殊字符有顾虑） */
    r = run(sprintf('%s dgst -sha256 -mac HMAC -macopt hexkey:%s -binary < %s | %s base64 -A',
        ossl, hex_of(secret), shq(f), ossl));
    sig = trim(r.out);
    try { unlink(f); } catch (e) { }

    if (r.code == 0 && match(sig, /^[A-Za-z0-9+\/=]+$/))
        return sig;

    return '';
}

// ───────────────────────────── UCI ─────────────────────────────

function uci_cursor() {
    try {
        return cursor();
    }
    catch (e) {
        return null;
    }
}

function uci_get(section, option, fallback) {
    const c = uci_cursor();

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

/* 只用于把自动生成的 node_id 写回 UCI；失败不影响推送。 */
function uci_set(option, value) {
    const c = uci_cursor();

    if (c == null)
        return false;

    try {
        c.set(UCI_CONFIG, 'settings', option, value);
        return c.commit(UCI_CONFIG) === true;
    }
    catch (e) {
        return false;
    }
}

// ───────────────────────────── 节点身份 ─────────────────────────────

function hostname() {
    const h = trim(text(readfile('/proc/sys/kernel/hostname'), ''));

    return length(h) ? h : 'OpenWrt';
}

function read_mac(name) {
    let raw = '';

    try {
        raw = trim(text(readfile(sprintf('/sys/class/net/%s/address', name)), ''));
    }
    catch (e) {
        return '';
    }

    if (!match(raw, /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/))
        return '';

    if (raw == '00:00:00:00:00:00')
        return '';

    return lc(raw);
}

/* 取主 LAN 口的 MAC（没有 br-lan 就退回第一个有效地址）。 */
function primary_mac() {
    let ifaces = [];

    try {
        ifaces = lsdir('/sys/class/net') ?? [];
    }
    catch (e) {
        ifaces = [];
    }

    for (let want in [ 'br-lan', 'lan', 'br0', 'eth0', 'wan' ]) {
        if (index(ifaces, want) < 0)
            continue;

        const mac = read_mac(want);

        if (length(mac))
            return mac;
    }

    for (let name in ifaces) {
        const mac = read_mac(name);

        if (length(mac))
            return mac;
    }

    return '';
}

/* 只留 [A-Za-z0-9._-]，并去掉首尾的 ./-，保证 node_id 可安全用作文件名。 */
function sanitize_id(s) {
    let out = '', prev_dash = false;

    for (let i = 0; i < length(s); i++) {
        const c = substr(s, i, 1);

        if (match(c, /[A-Za-z0-9._-]/)) {
            out += c;
            prev_dash = false;
        }
        else if (!prev_dash) {
            out += '-';
            prev_dash = true;
        }
    }

    out = replace(out, /^[._-]+/, '');
    out = replace(out, /[._-]+$/, '');

    return cut(out, 48);
}

/* 默认 node_id = 主机名 + MAC 后 4 位（稳定、可读、同网段不重名）。 */
function gen_node_id() {
    const host = sanitize_id(hostname());
    const mac = primary_mac();
    let tail = '';

    if (length(mac)) {
        const hex = join('', split(mac, ':'));
        tail = lc(substr(hex, length(hex) - 4));
    }

    if (length(tail))
        return cut(sprintf('%s-%s', length(host) ? host : 'node', tail), 48);

    return length(host) ? host : 'node';
}

function resolve_node_id(cfg) {
    if (length(cfg.node_id))
        return cfg.node_id;

    const id = gen_node_id();

    if (!length(id))
        return '';

    if (!DRY_RUN) {
        if (uci_set('node_id', id))
            log('INFO', sprintf('已生成 node_id=%s 并写回 UCI', id));
        else
            log('WARN', sprintf('node_id=%s 无法写回 UCI；每次运行会重新推导（同机结果稳定）', id));
    }

    return id;
}

// ───────────────────────────── 配置与数据 ─────────────────────────────

function load_config() {
    return {
        enabled: uci_flag('settings', 'mother_enabled', false),
        url: trim(text(uci_get('settings', 'mother_url', ''), '')),
        secret: trim(text(uci_get('settings', 'mother_secret', ''), '')),
        node_id: trim(text(uci_get('settings', 'node_id', ''), '')),
        node_name: trim(text(uci_get('settings', 'node_name', ''), ''))
    };
}

function totals_of(state) {
    const out = { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0, rx_rate: 0, tx_rate: 0 };
    const t = (type(state?.totals) == 'object') ? state.totals : {};

    for (let key in keys(out))
        out[key] = positive(t[key]);

    return out;
}

function nodes_of(state) {
    const out = {};
    const arr = [];

    if (type(state?.nodes) != 'object')
        return out;

    for (let name, node in state.nodes) {
        if (type(node) != 'object')
            continue;

        push(arr, { name: cut(name, 40), rx: positive(node.rx), tx: positive(node.tx) });
    }

    sort(arr, (a, b) => (b.rx + b.tx) - (a.rx + a.tx));

    for (let i = 0; i < length(arr) && i < MAX_NODE_NAMES; i++) {
        if (length(arr[i].name) == 0)
            continue;

        out[arr[i].name] = { rx: arr[i].rx, tx: arr[i].tx };
    }

    return out;
}

/* devices / apps 都不再按 SPEC 全量发：各取前 20 条，够母节点页面用，报文 < 10 KB。 */
function devices_of(state) {
    const out = [];
    const arr = [];

    if (type(state?.devices) != 'array')
        return out;

    for (let dev in state.devices) {
        if (type(dev) != 'object')
            continue;

        const item = {
            ip: cut(text(dev.ip, ''), 64),
            mac: cut(text(dev.mac, ''), 32),
            hostname: cut(text(dev.hostname, ''), 64),
            direct_rx: positive(dev.direct_rx),
            direct_tx: positive(dev.direct_tx),
            proxy_rx: positive(dev.proxy_rx),
            proxy_tx: positive(dev.proxy_tx),
            rx_rate: positive(dev.rx_rate),
            tx_rate: positive(dev.tx_rate),
            last_seen: positive(dev.last_seen)
        };

        if (length(item.ip) == 0 && length(item.mac) == 0 && length(item.hostname) == 0)
            continue;

        push(arr, item);
    }

    sort(arr, (a, b) => (b.direct_rx + b.proxy_rx) - (a.direct_rx + a.proxy_rx));

    for (let i = 0; i < length(arr) && i < MAX_DEVICES; i++)
        push(out, arr[i]);

    return out;
}

function apps_of(state) {
    const out = [];
    const arr = [];

    if (type(state?.apps) != 'array')
        return out;

    for (let app in state.apps) {
        if (type(app) != 'object')
            continue;

        const item = {
            host: cut(text(app.host, ''), 96),
            rx: positive(app.rx),
            tx: positive(app.tx),
            chain: cut(text(app.chain, ''), 40),
            devices: positive(app.devices)
        };

        if (length(item.host) == 0)
            continue;

        push(arr, item);
    }

    sort(arr, (a, b) => (b.rx + b.tx) - (a.rx + a.tx));

    for (let i = 0; i < length(arr) && i < MAX_APPS; i++)
        push(out, arr[i]);

    return out;
}

function build_payload(state, cfg, node_id) {
    const now = time();
    let ts = integer(state?.ts, 0);

    if (ts <= 0)
        ts = now;

    if (ts > now + 60)          /* 子节点时钟偏快时别让母节点算出负 age */
        ts = now;

    return {
        node_id: node_id,
        name: length(cfg.node_name) ? cut(cfg.node_name, 64) : node_id,
        ts: ts,
        totals: totals_of(state),
        nodes: nodes_of(state),
        devices: devices_of(state),
        apps: apps_of(state)
    };
}

/* mother_url 允许三种写法：http://host / http://host:port / 已经带 /cgi-bin/... 的完整地址。 */
function ingest_url(url) {
    let base = trim(url);

    if (!match(base, /^https?:\/\/[^\/\s]+/))
        return '';

    base = replace(base, /\/+$/, '');

    if (match(base, /\/cgi-bin\/[A-Za-z0-9._-]+$/))
        return base;

    return `${base}/cgi-bin/traffic-stats-ingest`;
}

// ───────────────────────────── HTTP ─────────────────────────────

function http_post(curl, url, headers, body) {
    const tag = sprintf('%d-%d', getpid(), _seq++);
    const bf = sprintf('%s/.push-body-%s.json', BASE, tag);
    const rf = sprintf('%s/.push-resp-%s.json', BASE, tag);
    const ef = sprintf('%s/.push-err-%s.txt', BASE, tag);

    try {
        writefile(bf, body);
    }
    catch (e) {
        return { http: 0, curl: -1, resp: '', err: sprintf('写请求体失败：%s', e) };
    }

    /* --data-binary 用 @file 发原始字节：签名覆盖的就是这份字节，绝不能被 curl 改写。 */
    /* -L 跟随 uhttpd 的 307（redirect_https=1 会把 http 跳 https）；
       -k 接受自签证书：母节点在局域网内，通常用 OpenWrt 自签证书。 */
    let cmd = sprintf('%s -sSLk -m %d --connect-timeout 5 -o %s -w %%{http_code}',
        curl, CURL_TIMEOUT, shq(rf));

    for (let name in headers)
        cmd += sprintf(' -H %s', shq(sprintf('%s: %s', name, headers[name])));

    cmd += sprintf(' --data-binary %s %s 2>%s', shq(`@${bf}`), shq(url), shq(ef));

    const r = run(cmd);
    let resp = '', err = '';

    try { if (access(rf)) resp = readfile(rf); } catch (e) { }
    try { if (access(ef)) err = trim(readfile(ef)); } catch (e) { }

    try { unlink(bf); } catch (e) { }
    try { unlink(rf); } catch (e) { }
    try { unlink(ef); } catch (e) { }

    return { http: integer(trim(r.out), 0), curl: r.code, resp: resp, err: err };
}

function parse_response(res) {
    if (res.curl != 0)
        return { ok: false, code: -1, msg: length(res.err) ? res.err : sprintf('curl exit %d', res.curl) };

    if (res.http != 200)
        return { ok: false, code: -1, msg: sprintf('HTTP %d', res.http) };

    let body = null;

    try {
        body = json(res.resp);
    }
    catch (e) {
        body = null;
    }

    if (type(body) != 'object')
        return { ok: false, code: -1, msg: sprintf('响应不是 JSON：%s', cut(trim(res.resp), 120)) };

    const code = integer(body.code, -1);

    if (code != 0)
        return { ok: false, code: code, msg: cut(text(body.msg, ''), 200) };

    return { ok: true, code: 0, msg: '' };
}

// ───────────────────────────── 主流程 ─────────────────────────────

function main() {
    const cfg = load_config();

    /* 默认 mother_enabled=0；没配母节点地址也静默退出（子节点独立运行）。 */
    if (!cfg.enabled)
        return 0;

    if (length(cfg.url) == 0)
        return 0;

    if (length(cfg.secret) == 0) {
        log('ERROR', 'mother_url 已配置但 mother_secret 为空，拒绝推送');
        return 1;
    }

    const url = ingest_url(cfg.url);

    if (length(url) == 0) {
        log('ERROR', sprintf('mother_url 不是合法的 http(s) 地址：%s', cut(cfg.url, 120)));
        return 1;
    }

    const state = read_json(sprintf('%s/state.json', BASE));

    if (state == null) {
        if (throttle('nostate', 600))
            log('WARN', sprintf('%s/state.json 不可读，跳过推送（traffic-statsd 未运行？）', BASE));

        return 0;
    }

    const node_id = resolve_node_id(cfg);

    if (length(node_id) == 0) {
        log('ERROR', '无法生成 node_id（主机名与 MAC 都取不到）');
        return 1;
    }

    const body = jstr(build_payload(state, cfg, node_id));
    const ts = sprintf('%d', time());
    const headers = {
        'Content-Type': 'application/json',
        'X-Node-Id': node_id,
        'X-Timestamp': ts
    };
    /* uhttpd 不转发自定义头，所以同样的值再挂一份到查询串（见文件头说明）。 */
    const query = sprintf('node_id=%s&ts=%s', url_encode(node_id), url_encode(ts));
    const sep = (index(url, '?') >= 0) ? '&' : '?';

    if (DRY_RUN) {
        print(sprintf('%J\n', { url: url + sep + query, headers: headers, body: body }));
        return 0;
    }

    const curl = curl_bin();

    if (curl == null) {
        log('ERROR', '缺少 curl，无法推送（opkg install curl）');
        return 1;
    }

    const digest = sha256_hex(body);

    if (length(digest) == 0) {
        log('ERROR', '计算 body 的 sha256 失败（缺少 sha256sum / openssl）');
        return 1;
    }

    headers['X-Sign'] = hmac_b64(cfg.secret, sprintf('%s\n%s\n%s', node_id, ts, digest));

    if (length(headers['X-Sign']) == 0) {
        log('ERROR', 'HMAC 签名失败（openssl 不可用？opkg install openssl-util）');
        return 1;
    }

    const full_url = sprintf('%s%s%s&sign=%s', url, sep, query, url_encode(headers['X-Sign']));
    const raw = http_post(curl, full_url, headers, body);
    const res = parse_response(raw);

    if (res.ok) {
        if (throttle('ok', 600))
            log('INFO', sprintf('推送成功：%s bytes=%d ts=%s', url, length(body), ts));

        return 0;
    }

    /* 按约定：网络 / 非 200 / code != 0 都不算脚本故障，记日志后 exit 0，下个周期再试。 */
    log('ERROR', sprintf('推送失败：http=%s curl=%s code=%s %s',
        raw.http, raw.curl, res.code, cut(res.msg, 160)));

    return 0;
}

exit(main());
