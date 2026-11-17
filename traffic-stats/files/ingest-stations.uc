#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// traffic-stats-stations —— 母节点接收「哑桥 AP 的无线站点元数据」
//（CGI，安装为 /www/cgi-bin/traffic-stats-stations）
//
// 由 traffic-stats/files/stations.uc（AP 侧）上报；本脚本只收元数据，**一个字节字段都不落盘**。
//
// ──────────────────────── 安全边界（必读，别按直觉改）────────────────────────
// 这是一条**仅限局域网、非签名**的通道：AP 上没有 openssl，算不出 HMAC-SHA256，
// 所以认证是「按节点注册的 token + nonce + 时间戳」。只允许在可信局域网使用，
// 绝不能把这台路由的 web 端口暴露到 WAN。需要跨不可信网络请换 TLS/WireGuard。
//
//   * 默认只认 `config station` + `option node_id` + `option token` 注册过的节点；
//     未注册 node_id 拒绝。旧的全局 settings.stations_token 只在显式
//     legacy_stations_token=1 时作为兜底（deprecation 日志）。
//   * v2：token 走 Authorization: Bearer（uhttpd 会转发），nonce 必填；
//     母节点用 /tmp 下有界 TTL 目录原子占用 nonce，防 300 秒窗口内重放。
//   * v1（无 nonce、token 可在查询串）只在 legacy_stations_token=1 时接受。
//   * 它能保证的：
//       - 只接受 POST；Content-Length 只接受 ^[0-9]+$（12abc/1e3/1,000/空白一律拒），
//         > 64 KiB 读取前拒绝，实际读取夹到 MAX_BODY+1，声明/实际长度不符拒绝；
//       - node_id 白名单 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（防目录穿越、防隐藏文件）；
//       - 时间戳与本地时间偏差 ≤ 300 秒；
//       - token 常量时间比较（不把比较耗时变成可观测信号）；
//       - 落盘只写白名单字段 —— 对端塞 rx_bytes/tx_bytes 也不会被存储。
//   * 它不能保证的：
//       - **身份真实性**：拿到 token 的人就是"AP"；token 泄露即可伪造。
//       - **抗窃听/抗篡改**：明文 HTTP（除非外层 TLS）。
//
// ───────────────────────── 协议 ─────────────────────────
//   POST http://<mother>/cgi-bin/traffic-stats-stations?node_id=..&ts=..&proto=2&nonce=..
//   Content-Type: application/json
//   Authorization: Bearer <token>          ← uhttpd 会转发；token 不再进 URL
//   X-Node-Id / X-Timestamp / X-Proto / X-Nonce / X-Token（给 nginx 等标准 CGI 用）
//   body: {"node_id","name","ts","stations":[
//            {"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53,
//             "rx_rate":866600,"tx_rate":650000,"connected_sec":3600}]}
//
//   返回 HTTP 200 + {"code":0}；失败 {"code":<非0>,"msg":"..."}。
//     code 1 = token 缺失/不匹配/节点未注册   2 = 时间戳非法或超出 ±300 秒
//          3 = 通道未启用 / 母节点未配置 token   4 = 报文不合法（node_id、JSON、nonce、长度）
//          5 = 落盘失败                          8 = nonce 重放
//   405 = 非 POST（Status 头 + code 405）；413 = 请求体过大（Status 头 + code 413）。
//
// 旧协议（v1，无 nonce、token 可在查询串）只在 legacy_stations_token=1 时接受；
// 新 AP 永远发 v2，token 走 Authorization，URL 里只有非机密路由字段。
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
//     CONTENT_TYPE=application/json HTTP_AUTHORIZATION="Bearer <token>" \
//     QUERY_STRING="node_id=ap-1&ts=$(date +%s)&proto=2&nonce=<16B hex>" \
//     /usr/bin/ucode /www/cgi-bin/traffic-stats-stations
//
// 依赖：ucode（fs/uci/json 内建）。**不需要 openssl、不需要 curl。**
// 风格：与 ingest.uc 一致（jstr/note/write_atomic/respond 等小工具同名同义）。
'use strict';

import { readfile, access, popen, writefile, unlink, open, rename, chmod, chown, stdin, stat, lsdir, lstat, mkdir, rmdir } from 'fs';
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

/* 目录必须落成真实 root 目录：已存在但不是目录/属主非 root（含 symlink）→ false。
   （lstat 不跟随符号链接；需要更严格父目录校验的认证目录另见 auth_secure_dir。） */
function ensure_dir(path) {
    if (length(path) == 0 || path == '.')
        return false;

    let st = null;

    try { st = lstat(path); } catch (e) { return false; }

    if (st != null)
        return st.type == 'directory' && st.uid == 0 && st.gid == 0;

    if (system([ 'mkdir', '-p', path ]) != 0)
        return false;

    try { st = lstat(path); } catch (e) { return false; }

    return st != null && st.type == 'directory' && st.uid == 0 && st.gid == 0;
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
    const tmp = sprintf('%s.tmp.%d.%d.%d', path, ucode_pid(), _seq++, time());

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
        /* /tmp/traffic-stats 不是真实 root 目录（例如被换成 symlink）→ 不写日志。 */
        if (!ensure_dir(TMP_DIR))
            return;

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

// ───────────────────── 认证工具（与 traffic-stats-node-auth.uc 同步）─────────
//
// 目标容器 OpenSSL 3.0.22 实测：`dgst -hmac` / `-macopt key:<文件>` 都只接受
// argv 里的字面量，没有“从文件/fd 读 HMAC key”的选项；环境变量又会出现在
// /proc/<pid>/environ。因此这里用 ucode 内存拼 ipad/opad + sha256sum 读 stdin，
// 密钥不进 argv / 环境变量 / 磁盘，只把 hash 的十六进制文本落到 0600 临时文件。

const AUTH_TMP = '/tmp/traffic-stats/.auth';
let _auth_seq = 0;

function auth_text(value, fallback) {
    return (value == null) ? fallback : `${value}`;
}

function auth_nonce() {
    let raw = '';

    try {
        const fd = open('/dev/urandom', 'r');

        if (fd != null) {
            raw = fd.read(16) ?? '';
            fd.close();
        }
    }
    catch (e) {
        raw = '';
    }

    if (length(raw) < 16) {
        try {
            raw = replace(trim(auth_text(readfile('/proc/sys/kernel/random/uuid'), '')), '-', '');
        }
        catch (e) {
            raw = '';
        }
    }

    if (length(raw) < 16)
        raw = sprintf('%08x%08x%08x%08x', time(), int(time() / 1000), _auth_seq, 0);

    let hex = '';

    for (let i = 0; i < length(raw) && length(hex) < 32; i++)
        hex += sprintf('%02x', ord(substr(raw, i, 1)));

    return hex;
}

function auth_valid_nonce(nonce) {
    return match(nonce, /^[A-Za-z0-9_-]{16,64}$/) != null;
}

/* 安全目录（与 traffic-stats-node-auth.uc 同步）：
   lstat 不跟随符号链接；只接受真实目录且 root:root。已存在但不安全时直接失败，
   绝不先 chmod/chown 再信任（符号链接不会被 chmod 变成目录）。 */
function auth_lstat_dir(path) {
    let st = null;

    try { st = lstat(path); } catch (e) { return null; }

    if (st == null || st.type != 'directory' || st.uid != 0 || st.gid != 0)
        return null;

    return st;
}

function auth_secure_dir(path, mode) {
    let st = auth_lstat_dir(path);

    if (st == null) {
        let raw = null;

        try { raw = lstat(path); } catch (e) { raw = null; }

        if (raw != null)
            return false;

        try { mkdir(path, mode); } catch (e) { }

        st = auth_lstat_dir(path);
        if (st == null)
            return false;
    }

    try { chmod(path, mode); } catch (e) { return false; }
    try { chown(path, 0, 0); } catch (e) { return false; }

    return auth_lstat_dir(path) != null;
}

/* /tmp 必须是 root 的 sticky 真实目录；否则不创建任何认证临时目录。 */
function auth_safe_tmp_parent() {
    let st = null;

    try { st = lstat('/tmp'); } catch (e) { return false; }

    return st != null && st.type == 'directory' && st.uid == 0
        && st.perm != null && st.perm.sticky == true;
}

/* /tmp/traffic-stats 先安全创建/校验，再建 0700 的 .auth。 */
function auth_ensure_tmp() {
    if (!auth_safe_tmp_parent())
        return false;

    if (!auth_secure_dir(TMP_DIR, MODE_755))
        return false;

    return auth_secure_dir(AUTH_TMP, 448);   /* 0700 */
}

/* sha256sum 的输出仍是行首 64 hex；openssl dgst -sha256 的
   `SHA2-256(stdin)= <64hex>` 尾部格式只在回退时接受。 */
function auth_digest_hex(raw) {
    const text = trim(auth_text(raw, ''));
    let m = match(text, /^([0-9a-fA-F]{64})/);

    if (m != null)
        return lc(m[1]);

    m = match(text, /(SHA2-256|SHA256)\(stdin\)= *([0-9a-fA-F]{64}) *$/);
    if (m != null)
        return lc(m[2]);

    m = match(text, /\(stdin\)= *([0-9a-fA-F]{64}) *$/);

    return (m != null) ? lc(m[1]) : '';
}

function auth_hash_cmd() {
    for (let path in [ '/usr/bin/sha256sum', '/bin/sha256sum' ])
        if (access(path))
            return path;

    for (let path in [ '/usr/bin/openssl', '/usr/sbin/openssl', '/bin/openssl' ])
        if (access(path))
            return sprintf('%s dgst -sha256', path);

    return 'sha256sum';
}

/* sha256_hex(data)：数据从 stdin 进，stdout 重定向到 0600 文件；argv 里只有路径。 */
function auth_sha256_hex(data) {
    if (!auth_ensure_tmp())
        return '';

    const out = sprintf('%s/h-%d-%d-%s', AUTH_TMP, int(time()), _auth_seq++, auth_nonce());
    let fd = null;

    try {
        /* 'wx'：目标已存在（含预先放置的符号链接/文件）就失败，绝不跟随写入。 */
        fd = open(out, 'wx', 384);         /* 384 = 0o600 */
        if (fd == null)
            return '';

        fd.close();
    }
    catch (e) {
        try { if (fd != null) fd.close(); } catch (e2) { }
        try { unlink(out); } catch (e2) { }
        return '';
    }

    let p = null;

    try {
        p = popen(sprintf('%s > %s', auth_hash_cmd(), shq(out)), 'w');
    }
    catch (e) {
        p = null;
    }

    if (p == null) {
        try { unlink(out); } catch (e) { }
        return '';
    }

    let off = 0;

    try {
        while (off < length(data)) {
            const n = p.write(substr(`${data}`, off));

            if (n == null || n <= 0)
                break;

            off += n;
        }
    }
    catch (e) {
        /* 关闭管道后按实际输出判定 */
    }

    const rc = p.close();
    let raw = '';

    try { raw = auth_text(readfile(out), ''); } catch (e) { raw = ''; }
    try { unlink(out); } catch (e) { }

    if (rc != 0)
        return '';

    return auth_digest_hex(raw);
}

function auth_hex_bin(hex) {
    let out = '';

    for (let i = 0; i + 1 < length(hex); i += 2)
        out += chr(int(substr(hex, i, 2), 16));

    return out;
}

const AUTH_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function auth_b64(bin) {
    let out = '';

    for (let i = 0; i < length(bin); i += 3) {
        const b0 = ord(substr(bin, i, 1));
        const has1 = (i + 1 < length(bin));
        const has2 = (i + 2 < length(bin));
        const b1 = has1 ? ord(substr(bin, i + 1, 1)) : 0;
        const b2 = has2 ? ord(substr(bin, i + 2, 1)) : 0;

        out += substr(AUTH_B64, (b0 >> 2) & 63, 1);
        out += substr(AUTH_B64, ((b0 & 3) << 4) | ((b1 >> 4) & 15), 1);
        out += has1 ? substr(AUTH_B64, ((b1 & 15) << 2) | ((b2 >> 6) & 3), 1) : '=';
        out += has2 ? substr(AUTH_B64, b2 & 63, 1) : '=';
    }

    return out;
}

function auth_hmac_b64(secret, message) {
    const msg = `${message}`;
    let key = `${secret}`;

    if (length(key) > 64) {
        const kh = auth_sha256_hex(key);

        if (length(kh) == 0)
            return '';

        key = auth_hex_bin(kh);
    }

    let ipad = '', opad = '';

    for (let i = 0; i < 64; i++) {
        const b = (i < length(key)) ? ord(substr(key, i, 1)) : 0;

        ipad += chr(b ^ 0x36);
        opad += chr(b ^ 0x5c);
    }

    const inner_hex = auth_sha256_hex(ipad + msg);

    if (length(inner_hex) == 0)
        return '';

    const outer_hex = auth_sha256_hex(opad + auth_hex_bin(inner_hex));

    if (length(outer_hex) == 0)
        return '';

    return auth_b64(auth_hex_bin(outer_hex));
}

function auth_same(a, b) {
    if (length(a) != length(b))
        return false;

    let diff = 0;

    for (let i = 0; i < length(a); i++)
        diff |= ord(substr(a, i, 1)) ^ ord(substr(b, i, 1));

    return diff == 0;
}

function auth_message_v2(node_id, ts, nonce, body_digest) {
    return sprintf('v2\n%s\n%s\n%s\n%s', node_id, ts, nonce, body_digest);
}

function auth_message_v1(node_id, ts, body_digest) {
    return sprintf('%s\n%s\n%s', node_id, ts, body_digest);
}

/* UCI section 的“节点 ID”：优先 option node_id；命名 section 才回落到 section 名。
   UCI 的 section 名只允许 [A-Za-z0-9_]，带 '-' 的 node_id 必须写 option node_id。 */
function auth_section_id(s) {
    let id = trim(auth_text(s.node_id, ''));

    if (length(id) == 0 && s['.anonymous'] != true)
        id = trim(auth_text(s['.name'], ''));

    return id;
}

/* 只认 .type == 'node' 的 section；未知 node_id 返回 ''（调用方必须拒绝）。 */
function auth_node_secret(c, node_id) {
    let found = '';

    if (c == null)
        return '';

    c.foreach(UCI_CONFIG, 'node', function(s) {
        if (length(found) || type(s) != 'object' || s['.type'] != 'node')
            return;

        if (auth_section_id(s) != node_id)
            return;

        const secret = trim(auth_text(s.secret, ''));

        if (length(secret))
            found = secret;
    });

    return found;
}

function auth_station_token(c, node_id) {
    let found = '';

    if (c == null)
        return '';

    c.foreach(UCI_CONFIG, 'station', function(s) {
        if (length(found) || type(s) != 'object' || s['.type'] != 'station')
            return;

        if (auth_section_id(s) != node_id)
            return;

        const token = trim(auth_text(s.token, ''));

        if (length(token))
            found = token;
    });

    return found;
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

function uci_cursor() {
    try {
        return cursor();
    }
    catch (e) {
        return null;
    }
}

/* token 默认按节点注册（config station + option node_id/token）；只有显式
   legacy_stations_token=1 才回退到全局 settings.stations_token。 */
function station_token(node_id) {
    const per_node = auth_station_token(uci_cursor(), node_id);

    if (length(per_node))
        return per_node;

    if (int(trim(text(uci_get('settings', 'legacy_stations_token', '0'), '0'))) == 0)
        return '';

    const global = trim(text(uci_get('settings', 'stations_token', ''), ''));

    if (length(global))
        note('使用 legacy_stations_token 全局令牌（已弃用；请改为 config station 每节点 token）');

    return global;
}

// ───────────────────────────── 请求解析 ─────────────────────────────

function env_header(name) {
    let value = getenv(`HTTP_${name}`);

    if (value == null)
        value = getenv(name);

    return trim(text(value ?? '', ''));
}

/* Authorization: Bearer <token>（uhttpd 会转发）。也接受 X-Token 头；查询串 token
   只在 v1 legacy 下接受，避免新协议的 token 进 web 访问日志。 */
function bearer_token() {
    let auth = env_header('AUTHORIZATION');

    if (!length(auth))
        auth = trim(text(getenv('AUTHORIZATION'), ''));

    const m = match(auth, /^[Bb]earer[ \t]+(.+)$/);

    return (m != null) ? trim(m[1]) : '';
}

function request_value(http_name, query, query_key, allow_query) {
    const value = env_header(http_name);

    if (length(value) > 0)
        return value;

    return allow_query ? trim(text(query[query_key], '')) : '';
}

/* 与 ingest.uc 相同的读取策略：声明超限先拒，实际读取夹到 MAX_BODY+1，
   声明/实际不一致拒绝。 */
function read_body(declared, has_declared) {
    const kind = type(stdin);
    const limit = MAX_BODY + 1;
    let raw = '';

    if (kind != 'resource' && kind != 'object')
        return raw;

    for (let guard = 0; guard < 512 && length(raw) < limit; guard++) {
        let want = limit - length(raw);

        if (has_declared) {
            const left = declared - length(raw);

            if (left <= 0)
                break;

            if (left < want)
                want = left;
        }

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
    }

    if (has_declared && declared >= 0 && declared <= MAX_BODY && length(raw) <= declared) {
        try {
            const extra = stdin.read(1);

            if (extra != null && length(extra) > 0)
                raw += extra;
        }
        catch (e) {
            /* EOF 正常 */
        }
    }

    return raw;
}

// ───────────────────────────── nonce 去重 ─────────────────────────────

const NONCE_DIR = `${TMP_DIR}/station-nonces`;
const NONCE_TTL = 900;
const NONCE_MAX = 4096;

function ensure_nonce_dir() {
    if (!auth_safe_tmp_parent())
        return false;

    if (!auth_secure_dir(TMP_DIR, MODE_755))
        return false;

    return auth_secure_dir(NONCE_DIR, 448);   // 0o700
}

/* 返回 true = 新 nonce；false = 重放 / 无法安全记录（必须拒绝）。 */
function consume_nonce(node_id, nonce) {
    if (!auth_valid_nonce(nonce))
        return false;

    if (!ensure_nonce_dir())
        return false;

    const dir = sprintf('%s/%s', NONCE_DIR, node_id);

    /* 节点子目录同样必须是真实 root 目录；已有 symlink/普通文件 → 失败关闭。 */
    if (!auth_secure_dir(dir, 448))
        return false;

    const now = time();
    let alive = 0;
    let entries = [];

    try { entries = lsdir(dir) ?? []; } catch (e) { entries = []; }

    for (let name in entries) {
        const p = sprintf('%s/%s', dir, name);
        let st = null;

        try { st = lstat(p); } catch (e) { continue; }
        if (st == null)
            continue;

        if (st.type == 'directory' && now - integer(st.mtime, 0) > NONCE_TTL) {
            try { rmdir(p); } catch (e) { }
            continue;
        }

        alive++;
    }

    if (alive >= NONCE_MAX)
        return false;

    const nonce_dir = sprintf('%s/%s', dir, nonce);

    let made = null;

    try { made = mkdir(nonce_dir, 448); } catch (e) { return false; }

    /* mkdir 返回 null = 目标已存在（重放/预置 symlink）或失败，必须拒绝。 */
    if (made != true || auth_lstat_dir(nonce_dir) == null)
        return false;

    try { chmod(nonce_dir, 448); } catch (e) { }

    return true;
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

    /* 先看声明的长度：明显超限的直接拒，省得读一个巨大的请求体。
       顺序固定：^(数字+)$ → 十进制上限 → integer()。绝不先 integer 再判，
       否则 "12abc" / "1e3" / "1,000" / 前后空白都可能被宽松转换成 12。 */
    const cl_raw = text(getenv('CONTENT_LENGTH'), '');
    const has_declared = length(cl_raw) > 0;
    let declared = 0;

    if (has_declared) {
        if (match(cl_raw, /^[0-9]+$/) == null) {
            respond(4, 'invalid Content-Length');
            return 0;
        }

        /* 去掉前导零后按十进制字符串比较上限，避免超长数字进入 int()。 */
        let digits = cl_raw;

        while (length(digits) > 1 && substr(digits, 0, 1) == '0')
            digits = substr(digits, 1);

        const max_text = `${MAX_BODY}`;

        if (length(digits) > length(max_text)
            || (length(digits) == length(max_text) && digits > max_text)) {
            respond(413, 'request body too large', 413);
            return 0;
        }

        declared = integer(digits, -1);

        if (declared < 0 || declared > MAX_BODY) {
            respond(4, 'invalid Content-Length');
            return 0;
        }
    }

    const ctype = lc(env_header('CONTENT_TYPE'));

    /* 带了 Content-Type 但不是 json 才拒；没带不拦（便于手工调试）。 */
    if (length(ctype) > 0 && !match(ctype, /^application\/json/)) {
        respond(4, 'Content-Type must be application/json');
        return 0;
    }

    const body = read_body(declared, has_declared);

    if (length(body) == 0) {
        respond(4, 'empty request body');
        return 0;
    }

    if (length(body) > MAX_BODY) {
        respond(413, 'request body too large', 413);
        return 0;
    }

    if (has_declared && length(body) != declared) {
        respond(4, sprintf('Content-Length mismatch（声明 %d，实际 %d）', declared, length(body)));
        return 0;
    }

    const query = query_params();
    const node_id = request_value('X_NODE_ID', query, 'node_id', true);

    if (!match(node_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)) {
        note(sprintf('非法 node_id 被拒：[%s]', cut(node_id, 64)));
        respond(4, 'invalid X-Node-Id');
        return 0;
    }

    const ts_text = request_value('X_TIMESTAMP', query, 'ts', true);
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

    /* 通道开关：母节点必须显式启用。 */
    const enabled = int(trim(text(uci_get('settings', 'stations_enabled', '0'), '0'))) != 0;

    if (!enabled) {
        respond(3, 'stations channel disabled on mother node');
        return 0;
    }

    /* proto 2 = token + nonce；缺省/1 = 旧协议（无 nonce，仅 legacy 显式允许）。 */
    const proto_text = request_value('X_PROTO', query, 'proto', true);
    let proto = integer(proto_text, 0);

    if (proto == 0)
        proto = 1;

    if (proto != 1 && proto != 2) {
        respond(4, 'unsupported protocol version');
        return 0;
    }

    const nonce = request_value('X_NONCE', query, 'nonce', true);
    const legacy = int(trim(text(uci_get('settings', 'legacy_stations_token', '0'), '0'))) != 0;

    /* 通道完全没有任何凭证配置时维持原 API 的 code=3；旧协议已配置但禁用才 code=1。 */
    const legacy_token = trim(text(uci_get('settings', 'stations_token', ''), ''));

    if (proto == 1 && !legacy && length(legacy_token) == 0
        && length(auth_station_token(uci_cursor(), node_id)) == 0) {
        respond(3, 'stations_token not configured on mother node');
        return 0;
    }

    if (proto == 1 && !legacy) {
        note('收到 v1 站点上报，但 legacy_stations_token 未开启，拒绝');
        respond(1, 'legacy stations token protocol is disabled');
        return 0;
    }

    const expected = station_token(node_id);

    if (length(expected) == 0) {
        note(sprintf('未注册的站点节点被拒：%s', node_id));
        respond(1, 'station node is not registered on mother node');
        return 0;
    }

    let token = bearer_token();

    if (!length(token))
        token = env_header('X_TOKEN');

    if (proto == 1 && !length(token))
        token = trim(text(query.token, ''));

    if (length(token) == 0) {
        respond(1, 'missing token');
        return 0;
    }

    if (!same_text(token, expected)) {
        note(sprintf('token 校验失败 node=%s proto=%d', node_id, proto));
        respond(1, 'token mismatch');
        return 0;
    }

    /* 验 token 通过后才占用 nonce；v2 必须带，v1 带了也去重。 */
    if (proto == 2 || length(nonce)) {
        if (!auth_valid_nonce(nonce)) {
            respond(4, 'invalid nonce');
            return 0;
        }

        if (!consume_nonce(node_id, nonce)) {
            note(sprintf('nonce 重放被拒 node=%s', node_id));
            respond(8, 'replayed nonce');
            return 0;
        }
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
