#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// traffic-stats-stations —— 母节点接收「哑桥 AP 的无线站点元数据」
//（CGI，安装为 /www/cgi-bin/traffic-stats-stations）
//
// 由 traffic-stats/files/stations.uc（AP 侧）上报；本脚本只收元数据，**一个字节字段都不落盘**。
//
// ───────────────────────── 安全边界（必读，别按直觉改）─────────────────────────
// 这是一条**仅限局域网、非签名**的通道：
//
//   * AP 上没有 openssl，算不出 HMAC-SHA256（子节点 push.uc 走的是 HMAC 签名），
//     所以本通道退化为「共享 token + 时间戳」认证。这是既定能力边界，不是待修的欠账：
//     **只允许在可信局域网使用，绝不能把这台路由的 web 端口暴露到 WAN。**
//   * 它能保证的：
//       - 只接受 POST，报文 ≤ 64 KiB；
//       - node_id 白名单 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（防目录穿越、防隐藏文件）；
//       - 时间戳与本地时间偏差 ≤ 300 秒（把重放窗口限制在 5 分钟内）；
//       - token 常量时间比较（不把比较耗时变成可观测信号）；
//       - 落盘只写白名单字段 —— **对端即使在 body 里塞 rx_bytes/tx_bytes 也不会被存储**
//         （见 norm_station()：只挑 mac/iface/signal/rx_rate/tx_rate/connected_sec）。
//   * 它不能保证的：
//       - **身份真实性**：拿到 token 的人就是"AP"。token 一旦泄露（读 /etc/config/traffic-stats、
//         抓一次明文 HTTP、web 服务器访问日志里的查询串），就能伪造上报。
//       - **抗重放**：300 秒窗口内可重放。影响有限（只覆盖最后一帧快照，不写历史）。
//       - **抗窃听/抗篡改**：明文 HTTP。
//     需要跨不可信网络时，换传输层（TLS / WireGuard / Tailscale），**不要在这条通道上
//     自创"弱签名"**——那只会让人误以为它比 token 更安全。
//
// ───────────────────────── 协议 ─────────────────────────
//   POST http://<mother>/cgi-bin/traffic-stats-stations
//   Content-Type: application/json
//   X-Node-Id:   <node_id>
//   X-Timestamp: <unix 秒>
//   X-Token:     <stations_token>
//   body: {"node_id","name","ts","stations":[
//            {"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53,
//             "rx_rate":866600,"tx_rate":650000,"connected_sec":3600}]}
//
//   返回 HTTP 200 + {"code":0}；失败 {"code":<非0>,"msg":"..."}。
//     code 1 = token 缺失/不匹配          2 = 时间戳非法或超出 ±300 秒
//          3 = 通道未启用 / 母节点未配置 token   4 = 报文不合法（node_id、JSON、stations）
//          5 = 落盘失败
//   405 = 非 POST（Status 头 + code 405）；413 = 请求体过大（Status 头 + code 413）。
//
// ⚠️ 真机实测：OpenWrt 的 uhttpd 只转发 HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST /
// HTTP_USER_AGENT，自定义 X-* 头会被静默丢弃。所以 stations.uc 除了发头，还把
// node_id / ts / token 放进 URL 查询串；本脚本先读头、读不到再读查询串。
// 代价：token 会出现在 web 服务器访问日志里（uhttpd 默认不记查询串，但别假设所有
// web 服务器都不记）。局域网内可接受，见上面的安全边界。
//
// ───────────────────────── 落盘 ─────────────────────────
//   /etc/traffic-stats/stations/<node_id>.json    最新快照，0644 root:root（临时文件 + rename 原子写）
//   /etc/traffic-stats/stations/                  0755 root:root
//
//   **不写 jsonl 历史**：信号强度是瞬时量，攒历史毫无价值，而 /etc 在 overlay flash 上，
//   每分钟追加一行只会磨 flash。要趋势请由前端做"当前值"展示，不要落盘。
//   最新快照本身也只是每分钟被覆盖一次（rename 原子写，不会出现半截文件）。
//
// 手工排查（不需要 web 服务器，直接喂 stdin）：
//   printf '%s' "$BODY" | env REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} \
//     CONTENT_TYPE=application/json HTTP_X_NODE_ID=ap-1 HTTP_X_TIMESTAMP=$(date +%s) \
//     HTTP_X_TOKEN=testtoken /usr/bin/ucode /www/cgi-bin/traffic-stats-stations
//
// 依赖：ucode（fs/uci/json 内建）。**不需要 openssl、不需要 curl。**
// 风格：与 ingest.uc 一致（jstr/note/write_atomic/respond 等小工具同名同义）。
'use strict';

import { readfile, access, popen, writefile, unlink, open, rename, chmod, chown, stdin } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG   = 'traffic-stats';
const STATIONS_DIR = '/etc/traffic-stats/stations';
const TMP_DIR      = '/tmp/traffic-stats';
const LOG_STATE    = `${TMP_DIR}/ingest-stations-lastlog`;

const MAX_BODY     = 65536;      // 64 KiB（实测一条 128 站点的报文约 15 KB）
const MAX_SKEW     = 300;        // 时间戳容差（秒）
const MAX_STATIONS = 256;        // 单节点站点数上限（超出丢弃，并记 dropped）
const LOG_GAP      = 60;         // 失败日志节流（秒）

const MODE_644     = 420;        // 0o644
const MODE_755     = 493;        // 0o755

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

/* 按字节截断，且不切断 UTF-8 码点。 */
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

function ensure_stations_dir() {
    if (!ensure_dir(STATIONS_DIR))
        return false;

    /* 目录必须 root:root 0755（见 docs/DEPLOY-RULES.md，2026-11-14 事故的直接教训）。 */
    try { chmod(STATIONS_DIR, MODE_755); } catch (e) { }
    try { chown(STATIONS_DIR, 0, 0); } catch (e) { }

    return true;
}

/* 临时文件 + rename 原子写，0644 root（读端永远看不到半截文件）。 */
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

/* 失败日志：只进 syslog，60 秒最多一条；绝不写 stdout（stdout 是 CGI 响应体）。 */
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
        /* 记不上就算了，别因为日志失败影响响应 */
    }

    system([ 'logger', '-t', 'traffic-stats-stations', '-p', 'daemon.warn', cut(one_line(msg), 200) ]);
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

// ───────────────────────────── 请求解析 ─────────────────────────────

function env_header(name) {
    let value = getenv(`HTTP_${name}`);

    if (value == null)
        value = getenv(name);

    return trim(text(value ?? '', ''));
}

/* ucode 里标准输入的类型是 'resource'（不是 'object'），别按 object 判。
   declared 是 CONTENT_LENGTH；超限先拒，避免读一个巨大的 body。 */
function read_body(declared) {
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
// 真机实测：uhttpd 只把 HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST / HTTP_USER_AGENT
// 传进 CGI 环境，自定义 X-* 头会被静默丢弃。所以 stations.uc 把同样的三个值也放进
// URL 查询串；本脚本先读头、读不到再读查询串。

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

/* 先看请求头（标准 CGI web 服务器会转发），再退回查询串（uhttpd 只转发少数头）。 */
function request_value(http_name, query, query_key) {
    const value = env_header(http_name);

    if (length(value) > 0)
        return value;

    return trim(text(query[query_key], ''));
}

// ───────────────────────────── 报文归一化 ─────────────────────────────
//
// 只挑白名单字段。母节点这边**再闸一次**：AP 就算（写错/被篡改）发了 rx_bytes 之类，
// 也进不了落盘文件 —— "绝不报字节"不靠对端自觉，靠这里不认识就不存。

function is_mac(s) {
    return match(s, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/) != null;
}

/* 信号：合法 dBm 范围 -120..0；缺省/越界 → 不写该字段。 */
function station_signal(value) {
    const n = integer(value, null);

    if (n == null || n < -120 || n > 0)
        return null;

    return n;
}

/* 速率：kbit/s，0..100000000（100 Gbit/s）；超出按边界截断，负值归 0。 */
function station_rate(value) {
    const n = integer(value, null);

    if (n == null)
        return null;

    if (n < 0)
        return 0;

    return (n > 100000000) ? 100000000 : n;
}

function station_secs(value) {
    const n = integer(value, null);

    if (n == null || n < 0)
        return null;

    return (n > 40000000) ? 40000000 : n;
}

function norm_station(src) {
    if (type(src) != 'object')
        return null;

    const mac = lc(trim(text(src.mac, '')));

    if (!is_mac(mac))
        return null;

    const out = { mac: mac };

    const iface = cut(one_line(text(src.iface, '')), 32);

    if (length(iface))
        out.iface = iface;

    const signal = station_signal(src.signal);

    if (signal != null)
        out.signal = signal;

    const rx = station_rate(src.rx_rate);

    if (rx != null)
        out.rx_rate = rx;

    const tx = station_rate(src.tx_rate);

    if (tx != null)
        out.tx_rate = tx;

    const conn = station_secs(src.connected_sec);

    if (conn != null)
        out.connected_sec = conn;

    return out;
}

/* 返回 { list, dropped }：同一 MAC 只留第一条（多 BSS 重复上报时以先到的为准）。 */
function norm_stations(src) {
    const list = [];
    const seen = {};
    let dropped = 0;

    if (type(src) != 'array')
        return { list: list, dropped: 0 };

    for (let item in src) {
        const st = norm_station(item);

        if (st == null) {
            dropped++;
            continue;
        }

        if (seen[st.mac] == true) {
            dropped++;
            continue;
        }

        seen[st.mac] = true;

        if (length(list) >= MAX_STATIONS) {
            dropped++;
            continue;
        }

        push(list, st);
    }

    return { list: list, dropped: dropped };
}

function build_snapshot(payload, node_id, now) {
    let ts = integer(payload?.ts, 0);

    if (ts <= 0)
        ts = now;

    /* 对端时钟偏快时不接受未来时间（避免 UI 出现负 age）；偏慢由调用方的时间戳校验兜住。 */
    if (ts > now + MAX_SKEW)
        ts = now;

    let name = trim(one_line(text(payload?.name, '')));

    if (length(name) == 0)
        name = node_id;

    const stations = norm_stations(payload?.stations);

    return {
        v: 1,
        node_id: node_id,
        name: cut(name, 64),
        ts: ts,
        received_ts: now,
        count: length(stations.list),
        dropped: stations.dropped,
        stations: stations.list
    };
}

// ───────────────────────────── 落盘 ─────────────────────────────

function store(snap) {
    if (!ensure_stations_dir())
        return false;

    const path = sprintf('%s/%s.json', STATIONS_DIR, snap.node_id);

    return write_atomic(path, `${jstr(snap)}\n`);
}

// ───────────────────────────── 响应 ─────────────────────────────

/* uhttpd 只认带 reason 的 Status 头（"Status: 413" 会被无视、结果 HTTP 200），
   所以这里必须写全 "Status: 413 Payload Too Large"，否则 413 只是个 body 里的数字。 */
function status_text(status) {
    if (status == 405)
        return 'Method Not Allowed';

    if (status == 413)
        return 'Payload Too Large';

    return 'Error';
}

function respond(code, msg, status) {
    if (status != null)
        print(sprintf('Status: %d %s\r\n', status, status_text(status)));

    print('Content-Type: application/json\r\n');
    print('Cache-Control: no-store\r\n');
    print('\r\n');

    const out = { code: code };

    if (length(text(msg, '')))
        out.msg = text(msg, '');

    print(`${jstr(out)}\n`);
}

// ───────────────────────────── 主流程 ─────────────────────────────

/* 常量时间比较（长度不同直接失败）：不把比较耗时变成可观测信号。 */
function same_text(a, b) {
    if (length(a) != length(b))
        return false;

    let diff = 0;

    for (let i = 0; i < length(a); i++)
        diff |= ord(substr(a, i, 1)) ^ ord(substr(b, i, 1));

    return diff == 0;
}

function main() {
    if (trim(text(getenv('REQUEST_METHOD'), '')) != 'POST') {
        respond(405, 'only POST is accepted', 405);
        return 0;
    }

    /* 先看声明的长度：明显超限的直接拒，省得读一个巨大的请求体。 */
    const declared = integer(getenv('CONTENT_LENGTH'), 0);

    if (declared > MAX_BODY) {
        respond(413, 'request body too large', 413);
        return 0;
    }

    const body = read_body(declared);

    if (length(body) == 0) {
        respond(4, 'empty request body');
        return 0;
    }

    if (length(body) > MAX_BODY) {
        respond(413, 'request body too large', 413);
        return 0;
    }

    const ctype = lc(env_header('CONTENT_TYPE'));

    /* 带了 Content-Type 但不是 json 才拒；没带不拦（便于手工调试）。 */
    if (length(ctype) > 0 && !match(ctype, /^application\/json/)) {
        respond(4, 'Content-Type must be application/json');
        return 0;
    }

    const query = query_params();
    const node_id = request_value('X_NODE_ID', query, 'node_id');

    if (!match(node_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)) {
        note(sprintf('非法 node_id 被拒：[%s]', cut(node_id, 64)));
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

    /* 通道开关与 token 都必须配好；没配好一律拒绝，绝不匿名写入。 */
    const enabled = int(trim(text(uci_get('settings', 'stations_enabled', '0'), '0'))) != 0;

    if (!enabled) {
        respond(3, 'stations channel disabled on mother node');
        return 0;
    }

    const expected = trim(text(uci_get('settings', 'stations_token', ''), ''));

    if (length(expected) == 0) {
        note('母节点未配置 traffic-stats.settings.stations_token，拒绝接收站点上报');
        respond(3, 'stations_token not configured on mother node');
        return 0;
    }

    const token = request_value('X_TOKEN', query, 'token');

    if (length(token) == 0) {
        respond(1, 'missing X-Token');
        return 0;
    }

    if (!same_text(token, expected)) {
        note(sprintf('token 校验失败 node=%s', node_id));
        respond(1, 'token mismatch');
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

    if (type(payload.stations) != 'array') {
        respond(4, 'body.stations must be an array');
        return 0;
    }

    const snap = build_snapshot(payload, node_id, now);

    if (!store(snap)) {
        note(sprintf('写站点快照失败 node=%s', node_id));
        respond(5, 'failed to store stations snapshot');
        return 0;
    }

    respond(0, '');

    return 0;
}

exit(main());
