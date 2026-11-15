#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// traffic-stats-ingest —— 母节点接收子节点推送（CGI，安装为 /www/cgi-bin/traffic-stats-ingest）
//
// uhttpd 以 root 身份执行本脚本，POST 体在 stdin。协议见 /usr/share/traffic-stats/push.uc
// 头部注释（X-Node-Id / X-Timestamp / X-Sign，body 为子节点汇总 JSON）。
//
// 关于三个凭证怎么拿到（真机实测结论，别按直觉改）：
//   * 标准 CGI 服务器（nginx + fcgiwrap 等）会把请求头转成 HTTP_X_NODE_ID 等环境变量；
//   * OpenWrt 的 uhttpd **只转发** HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST /
//     HTTP_USER_AGENT 这几个头，自定义 X-* 会被静默丢弃（容器里实测确认）。
//   因此 push.uc 同时把 node_id / ts / sign 放进 URL 查询串，本脚本先读头、再读查询串。
//   查询串里的 base64 已做 percent 编码，url_decode() 负责还原。
//
// 落盘（全部 0644 root:root，目录 0755 root:root）：
//   /etc/traffic-stats/nodes/<node_id>.json    最新快照（临时文件 + rename 原子写）
//   /etc/traffic-stats/nodes/<node_id>.jsonl   5 分钟一行的采样历史（上限 2000 行，超出裁掉最旧）
//
// jsonl 的写入策略：同一个 5 分钟桶内只写一行（桶内第一次上报），跨桶才追加。
// 这样既满足"5 分钟对齐"，又不会每分钟重写整份文件（/etc 在 overlay flash 上，
// 每分钟重写几百 KB 会磨 flash）；最新值始终在 .json 快照里，rpcd get_nodes 读的是快照。
// jsonl 每行是「采样点」（累计值），不是增量，口径与 state.json 的 totals 一致。
//
// 返回：HTTP 200 + {"code":0} 成功；{"code":<非0>,"msg":"..."} 失败。
//   code 1 = 签名/时间戳不安全  2 = 时间戳超差  3 = 母节点未配密钥  4 = 报文不合法
//        5 = 本机无法校验签名（缺 openssl）  6 = 落盘失败
//   405 = 非 POST（Status 头），413 = 请求体过大。
//
// 安全：
//   * 必须配置 traffic-stats.settings.mother_secret，未配置一律拒绝，绝不匿名写入。
//   * X-Timestamp 与本地时间偏差 > 300 秒 → 拒绝。
//   * node_id 只允许 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（防目录穿越、防隐藏文件）。
//   * 请求体上限 128 KiB（子节点最多 20 设备 + 20 应用，实测 ~4 KB）。
//   * 失败日志进 syslog 且 60 秒最多一条，避免被扫端口时刷屏。
//
// 手工排查（不需要 web 服务器，直接喂 stdin）：
//   printf '%s' "$BODY" | env REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} \
//     CONTENT_TYPE=application/json HTTP_X_NODE_ID=node-a HTTP_X_TIMESTAMP=$TS \
//     HTTP_X_SIGN="$SIGN" /usr/bin/ucode /www/cgi-bin/traffic-stats-ingest
//
// 依赖：ucode（fs/uci/json 内建）、openssl（校验 HMAC）。风格同 push.uc / feishu.uc。
'use strict';

import { readfile, access, popen, writefile, unlink, open, rename, chmod, chown, stdin } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG   = 'traffic-stats';
const NODES_DIR    = '/etc/traffic-stats/nodes';
const TMP_DIR      = '/tmp/traffic-stats';
const LOG_STATE    = `${TMP_DIR}/ingest-lastlog`;

const MAX_BODY     = 131072;      // 128 KiB
const MAX_SKEW     = 300;         // 时间戳容差（秒）
const BUCKET       = 300;         // jsonl 5 分钟对齐
const HISTORY_MAX  = 2000;        // jsonl 行数上限
const MAX_NODES    = 64;          // 单节点内 proxy 节点数上限
const MAX_DEVICES  = 20;
const MAX_APPS     = 20;
const LOG_GAP      = 60;          // 失败日志节流（秒）

const MODE_644     = 420;         // 0o644
const MODE_755     = 493;         // 0o755

let _seq = 0;

// ───────────────────────────── 基础工具 ─────────────────────────────

function text(value, fallback) {
    return (value == null) ? fallback : `${value}`;
}

function integer(value, fallback) {
    if (value == null)
        return fallback;

    const n = int(value);

    return (n != n) ? fallback : n;
}

function positive(value) {
    const n = integer(value, 0);

    return (n < 0) ? 0 : n;
}

function abs_int(n) {
    return (n < 0) ? -n : n;
}

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

/* 单行化：JSON 字符串里可能有 \n，写进 syslog 前压成空格。 */
function one_line(s) {
    let out = '';

    for (let i = 0; i < length(s); i++) {
        const c = substr(s, i, 1);

        out += (c == '\n' || c == '\r' || c == '\t') ? ' ' : c;
    }

    return out;
}

function shq(s) {
    return `'${replace(`${s}`, "'", "'\\''")}'`;
}

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

function ucode_pid() {
    const m = match(trim(text(readfile('/proc/self/stat'), '')), /^([0-9]+)/);

    return m ? int(m[1]) : int(time());
}

function ensure_dir(path) {
    if (length(path) == 0 || path == '.')
        return false;

    if (access(path))
        return true;

    return system([ 'mkdir', '-p', path ]) == 0;
}

function ensure_nodes_dir() {
    if (!ensure_dir(NODES_DIR))
        return false;

    /* 目录必须是 root:root 0755（见 docs/DEPLOY-RULES.md，2026-11-14 事故的直接教训）。 */
    try { chmod(NODES_DIR, MODE_755); } catch (e) { }
    try { chown(NODES_DIR, 0, 0); } catch (e) { }

    return true;
}

/* 临时文件 + rename 原子写，权限 0644 root（先落盘再改名，读端永远看不到半截文件）。 */
function write_atomic(path, content) {
    const tmp = sprintf('%s.tmp.%d.%d', path, ucode_pid(), _seq++);

    try {
        writefile(tmp, content);
        try { chmod(tmp, MODE_644); } catch (e) { }
        try { chown(tmp, 0, 0); } catch (e) { }

        if (rename(tmp, path))
            return true;
    }
    catch (e) {
        /* fallthrough */
    }

    try { unlink(tmp); } catch (e) { }

    return false;
}

/* 失败日志：只进 syslog，且 60 秒最多一条；绝不写 stdout（stdout 是 CGI 响应体）。 */
function note(msg) {
    const now = time();
    let last = 0;

    try {
        last = integer(trim(text(readfile(LOG_STATE), '')), 0);
    }
    catch (e) {
        last = 0;
    }

    if (last > 0 && now - last < LOG_GAP)
        return;

    try {
        ensure_dir(TMP_DIR);
        writefile(LOG_STATE, sprintf('%d\n', now));
    }
    catch (e) {
        /* 记不上就算了，不要因为日志失败影响响应 */
    }

    system([ 'logger', '-t', 'traffic-stats-ingest', '-p', 'daemon.warn', cut(one_line(msg), 200) ]);
}

// ───────────────────────────── JSON ─────────────────────────────

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

// ───────────────────────────── UCI ─────────────────────────────

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

// ───────────────────────────── 签名 ─────────────────────────────

function openssl_bin() {
    for (let path in [ '/usr/bin/openssl', '/usr/sbin/openssl', '/bin/openssl' ])
        if (access(path))
            return path;

    return null;
}

function hex_of(s) {
    let hex = '';

    for (let i = 0; i < length(s); i++)
        hex += sprintf('%02x', ord(substr(s, i, 1)));

    return hex;
}

/* body 的 sha256（hex 小写）。优先 busybox sha256sum，其次 openssl dgst。 */
function sha256_hex(txt) {
    const f = sprintf('%s/.ingest-body-%d-%d', TMP_DIR, ucode_pid(), _seq++);
    let hex = '';

    if (!ensure_dir(TMP_DIR))
        return '';

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

function hmac_b64(secret, message) {
    const ossl = openssl_bin();

    if (ossl == null)
        return '';

    const f = sprintf('%s/.ingest-msg-%d-%d', TMP_DIR, ucode_pid(), _seq++);

    if (!ensure_dir(TMP_DIR))
        return '';

    try {
        writefile(f, message);
    }
    catch (e) {
        return '';
    }

    let r = run(sprintf('%s dgst -sha256 -hmac %s -binary < %s | %s base64 -A',
        ossl, shq(secret), shq(f), ossl));
    let sig = trim(r.out);

    if (r.code == 0 && match(sig, /^[A-Za-z0-9+\/=]+$/)) {
        try { unlink(f); } catch (e) { }
        return sig;
    }

    r = run(sprintf('%s dgst -sha256 -mac HMAC -macopt hexkey:%s -binary < %s | %s base64 -A',
        ossl, hex_of(secret), shq(f), ossl));
    sig = trim(r.out);
    try { unlink(f); } catch (e) { }

    if (r.code == 0 && match(sig, /^[A-Za-z0-9+\/=]+$/))
        return sig;

    return '';
}

/* 常量时间比较（长度不同直接失败）：只为不把比较耗时变成一个可观测的信号。 */
function same_text(a, b) {
    if (length(a) != length(b))
        return false;

    let diff = 0;

    for (let i = 0; i < length(a); i++)
        diff |= ord(substr(a, i, 1)) ^ ord(substr(b, i, 1));

    return diff == 0;
}

function expected_sign(node_id, ts_text, body, secret) {
    const digest = sha256_hex(body);

    if (length(digest) == 0)
        return '';

    return hmac_b64(secret, sprintf('%s\n%s\n%s', node_id, ts_text, digest));
}

// ───────────────────────────── 请求解析 ─────────────────────────────

function env_header(name) {
    let value = getenv(`HTTP_${name}`);

    if (value == null)
        value = getenv(name);

    return trim(text(value ?? '', ''));
}

/* 先看请求头（标准 CGI web 服务器会转发），再退回查询串（uhttpd 只转发少数头）。 */
function request_value(http_name, query, query_key) {
    const value = env_header(http_name);

    if (length(value) > 0)
        return value;

    return trim(text(query[query_key], ''));
}

/* ucode 里标准输入的类型是 'resource'（不是 'object'），别按 object 判。 */
function read_body() {
    const declared = integer(getenv('CONTENT_LENGTH'), 0);
    const kind = type(stdin);
    let raw = '';

    if (kind != 'resource' && kind != 'object')
        return raw;

    for (let guard = 0; guard < 256; guard++) {
        const want = (declared > 0) ? (declared - length(raw)) : 65536;

        if (want <= 0)
            break;

        let chunk = null;

        try {
            chunk = stdin.read(want);
        }
        catch (e) {
            break;
        }

        if (chunk == null || length(chunk) == 0)
            break;

        raw += chunk;

        if (length(raw) > MAX_BODY)
            break;
    }

    return raw;
}

// ───────────────────────────── 查询串兜底 ─────────────────────────────
//
// 真机实测（openwrt-24.10 容器，uhttpd 内核 CGI）：uhttpd 只把
// HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST / HTTP_USER_AGENT 这几个请求头
// 传进 CGI 环境，自定义的 X-Node-Id / X-Timestamp / X-Sign 会被静默丢弃。
// 所以 push.uc 除了发文档约定的三个头，还会把同样的三个值放进 URL 查询串；
// 这里先读头、读不到再读查询串，两种 web 服务器（uhttpd / nginx）都能用。

function hexval(c) {
    return index('0123456789abcdef', lc(c));
}

function url_decode(s) {
    let out = '';

    for (let i = 0; i < length(s); i++) {
        const c = substr(s, i, 1);

        if (c == '+') {
            out += ' ';
            continue;
        }

        if (c == '%' && i + 2 < length(s)) {
            const h = lc(substr(s, i + 1, 2));
            const hi = hexval(substr(h, 0, 1));
            const lo = hexval(substr(h, 1, 1));

            if (hi >= 0 && lo >= 0) {
                out += chr(hi * 16 + lo);
                i += 2;
                continue;
            }
        }

        out += c;
    }

    return out;
}

function query_params() {
    const out = {};
    const qs = trim(text(getenv('QUERY_STRING'), ''));

    if (length(qs) == 0)
        return out;

    for (let pair in split(qs, '&')) {
        if (length(pair) == 0)
            continue;

        const eq = index(pair, '=');

        if (eq < 0) {
            out[url_decode(pair)] = '';
            continue;
        }

        out[url_decode(substr(pair, 0, eq))] = url_decode(substr(pair, eq + 1));
    }

    return out;
}

// ───────────────────────────── 报文归一化 ─────────────────────────────

function norm_totals(src) {
    const out = { direct_rx: 0, direct_tx: 0, proxy_rx: 0, proxy_tx: 0, rx_rate: 0, tx_rate: 0 };

    if (type(src) != 'object')
        return out;

    for (let key in keys(out))
        out[key] = positive(src[key]);

    return out;
}

function norm_nodes(src) {
    const out = {};

    if (type(src) != 'object')
        return out;

    const arr = [];

    for (let name, node in src) {
        if (type(node) != 'object')
            continue;

        const label = cut(one_line(text(name, '')), 40);

        if (length(label) == 0)
            continue;

        push(arr, { name: label, rx: positive(node.rx), tx: positive(node.tx) });
    }

    sort(arr, (a, b) => (b.rx + b.tx) - (a.rx + a.tx));

    for (let i = 0; i < length(arr) && i < MAX_NODES; i++)
        out[arr[i].name] = { rx: arr[i].rx, tx: arr[i].tx };

    return out;
}

function norm_devices(src) {
    const out = [];
    const arr = [];

    if (type(src) != 'array')
        return out;

    for (let dev in src) {
        if (type(dev) != 'object')
            continue;

        const item = {
            ip: cut(text(dev.ip, ''), 64),
            mac: cut(text(dev.mac, ''), 32),
            hostname: cut(one_line(text(dev.hostname, '')), 64),
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

        if (length(arr) >= MAX_DEVICES)
            break;
    }

    for (let i = 0; i < length(arr) && i < MAX_DEVICES; i++)
        push(out, arr[i]);

    return out;
}

function norm_apps(src) {
    const out = [];
    const arr = [];

    if (type(src) != 'array')
        return out;

    for (let app in src) {
        if (type(app) != 'object')
            continue;

        const item = {
            host: cut(text(app.host, ''), 96),
            rx: positive(app.rx),
            tx: positive(app.tx),
            chain: cut(one_line(text(app.chain, '')), 40),
            devices: positive(app.devices)
        };

        if (length(item.host) == 0)
            continue;

        push(arr, item);

        if (length(arr) >= MAX_APPS)
            break;
    }

    for (let i = 0; i < length(arr) && i < MAX_APPS; i++)
        push(out, arr[i]);

    return out;
}

function normalize(body, node_id, now) {
    if (type(body) != 'object')
        return null;

    let ts = integer(body.ts, 0);

    if (ts <= 0)
        ts = now;

    if (ts > now + MAX_SKEW)
        ts = now;

    let name = trim(one_line(text(body.name, '')));

    if (length(name) == 0)
        name = node_id;

    return {
        v: 1,
        node_id: node_id,
        name: cut(name, 64),
        ts: ts,
        received_ts: now,
        totals: norm_totals(body.totals),
        nodes: norm_nodes(body.nodes),
        devices: norm_devices(body.devices),
        apps: norm_apps(body.apps)
    };
}

// ───────────────────────────── 落盘 ─────────────────────────────

function split_lines(raw) {
    const out = [];

    for (let line in split(raw, '\n'))
        if (length(trim(line)))
            push(out, line);

    return out;
}

function line_ts(line) {
    let o = null;

    try {
        o = json(line);
    }
    catch (e) {
        return -1;
    }

    if (type(o) != 'object')
        return -1;

    return integer(o.ts, -1);
}

/* 5 分钟对齐的采样历史：跨桶才追加；超过 2000 行时整体重写、裁掉最旧。 */
function append_history(snap) {
    const path = sprintf('%s/%s.jsonl', NODES_DIR, snap.node_id);
    const bucket = int(snap.ts / BUCKET) * BUCKET;
    let raw = '';

    try {
        if (access(path))
            raw = text(readfile(path), '');
    }
    catch (e) {
        raw = '';
    }

    const lines = split_lines(raw);

    if (length(lines) > 0) {
        const last = line_ts(lines[length(lines) - 1]);

        /* 本桶已有记录（或子节点时钟轻微回拨）→ 不重复写，避免每分钟重写 flash。 */
        if (last >= bucket)
            return true;
    }

    const line = jstr({ ts: bucket, totals: snap.totals, nodes: snap.nodes });

    if (length(lines) < HISTORY_MAX) {
        let payload = `${line}\n`;

        if (length(raw) > 0 && substr(raw, length(raw) - 1, 1) != '\n')
            payload = `\n${payload}`;

        try {
            const fd = open(path, 'a');

            if (fd == null)
                return false;

            fd.write(payload);
            fd.close();
        }
        catch (e) {
            return false;
        }

        try { chmod(path, MODE_644); } catch (e) { }
        try { chown(path, 0, 0); } catch (e) { }

        return true;
    }

    const keep = [];

    for (let i = length(lines) - (HISTORY_MAX - 1); i < length(lines); i++)
        if (i >= 0)
            push(keep, lines[i]);

    push(keep, line);

    return write_atomic(path, `${join('\n', keep)}\n`);
}

function store(snap) {
    if (!ensure_nodes_dir())
        return false;

    const path = sprintf('%s/%s.json', NODES_DIR, snap.node_id);

    if (!write_atomic(path, `${jstr(snap)}\n`))
        return false;

    append_history(snap);

    return true;
}

// ───────────────────────────── 响应 ─────────────────────────────

function respond(code, msg, status) {
    if (status != null)
        print(sprintf('Status: %d\r\n', status));

    print('Content-Type: application/json\r\n');
    print('Cache-Control: no-store\r\n');
    print('\r\n');

    const out = { code: code };

    if (length(text(msg, '')))
        out.msg = text(msg, '');

    print(`${jstr(out)}\n`);
}

// ───────────────────────────── 主流程 ─────────────────────────────

function main() {
    if (trim(text(getenv('REQUEST_METHOD'), '')) != 'POST') {
        respond(405, 'only POST is accepted', 405);
        return 0;
    }

    const body = read_body();

    if (length(body) == 0) {
        respond(4, 'empty request body');
        return 0;
    }

    if (length(body) > MAX_BODY) {
        respond(413, 'request body too large', 413);
        return 0;
    }

    const ctype = lc(env_header('CONTENT_TYPE'));

    /* uhttpd 会带 application/json；没带时不拦（便于手工调试），带了但不是 json 才拒。 */
    if (length(ctype) > 0 && !match(ctype, /^application\/json/)) {
        respond(4, 'Content-Type must be application/json');
        return 0;
    }

    const query = query_params();
    const node_id = request_value('X_NODE_ID', query, 'node_id');

    if (!match(node_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)) {
        respond(4, 'invalid X-Node-Id');
        return 0;
    }

    const ts_text = request_value('X_TIMESTAMP', query, 'ts');
    const ts = integer(ts_text, 0);
    const now = time();

    if (ts <= 0) {
        respond(2, 'invalid X-Timestamp');
        return 0;
    }

    if (abs_int(now - ts) > MAX_SKEW) {
        respond(2, sprintf('timestamp out of tolerance（本地 %d，请求 %d）', now, ts));
        return 0;
    }

    const secret = trim(text(uci_get('settings', 'mother_secret', ''), ''));

    if (length(secret) == 0) {
        note('母节点未配置 traffic-stats.settings.mother_secret，拒绝接收');
        respond(3, 'mother_secret not configured on mother node');
        return 0;
    }

    let payload = null;

    try {
        payload = json(body);
    }
    catch (e) {
        payload = null;
    }

    if (type(payload) != 'object') {
        respond(4, 'body is not a JSON object');
        return 0;
    }

    if (text(payload.node_id, '') != node_id) {
        respond(4, 'body.node_id does not match X-Node-Id');
        return 0;
    }

    const sign = request_value('X_SIGN', query, 'sign');

    if (length(sign) == 0) {
        respond(1, 'missing X-Sign');
        return 0;
    }

    const expect = expected_sign(node_id, ts_text, body, secret);

    if (length(expect) == 0) {
        note('无法计算 HMAC（openssl 不可用？）');
        respond(5, 'signature verification unavailable (openssl missing)');
        return 0;
    }

    if (!same_text(sign, expect)) {
        note(sprintf('签名校验失败 node=%s', node_id));
        respond(1, 'signature mismatch');
        return 0;
    }

    const snap = normalize(payload, node_id, now);

    if (snap == null) {
        respond(4, 'invalid payload');
        return 0;
    }

    if (!store(snap)) {
        note(sprintf('写快照失败 node=%s', node_id));
        respond(6, 'failed to store snapshot');
        return 0;
    }

    respond(0, '');

    return 0;
}

exit(main());
