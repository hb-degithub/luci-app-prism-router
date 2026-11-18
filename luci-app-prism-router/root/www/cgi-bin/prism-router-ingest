#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// prism-router-ingest —— 母节点接收子节点推送（CGI，安装为 /www/cgi-bin/prism-router-ingest）
//
// uhttpd 以 root 身份执行本脚本，POST 体在 stdin。协议见 /usr/share/prism-router/push.uc
// 头部注释（Authorization: PrismRouter ...，body 为子节点汇总 JSON）。
//
// 凭证怎么拿到（真机实测结论，别按直觉改）：
//   * 标准 CGI 服务器（nginx + fcgiwrap 等）会把请求头转成 HTTP_X_NODE_ID 等环境变量；
//   * OpenWrt 的 uhttpd **只转发** HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST /
//     HTTP_USER_AGENT 这几个头，自定义 X-* 会被静默丢弃（容器里实测确认）。
//   新协议因此把全部认证字段放进 **Authorization**（uhttpd 会转发），查询串只留
//   node_id/ts/proto/nonce 这类非机密路由字段；v2 的 sign 绝不允许走查询串。
//
// 落盘（全部 0644 root:root，目录 0755 root:root）：
//   /etc/prism-router/nodes/<node_id>.json    最新快照（临时文件 + rename 原子写）
//   /etc/prism-router/nodes/<node_id>.jsonl   5 分钟一行的采样历史（上限 2000 行，超出裁掉最旧）
//
// jsonl 的写入策略：同一个 5 分钟桶内只写一行（桶内第一次上报），跨桶才追加。
// 这样既满足"5 分钟对齐"，又不会每分钟重写整份文件（/etc 在 overlay flash 上，
// 每分钟重写几百 KB 会磨 flash）；最新值始终在 .json 快照里，rpcd get_nodes 读的是快照。
// jsonl 每行是「采样点」（累计值），不是增量，口径与 state.json 的 totals 一致。
//
// 返回：HTTP 200 + {"code":0} 成功；{"code":<非0>,"msg":"..."} 失败。
//   code 1 = 签名/节点未注册/token 不安全   2 = 时间戳超差
//        3 = 母节点未配置对应密钥           4 = 报文不合法（含 nonce/长度不符）
//        5 = 本机无法计算 HMAC              6 = 落盘失败
//        8 = nonce 重放
//   405 = 非 POST（Status 头），413 = 请求体过大。
//
// 安全：
//   * 默认只认 `config node` + `option node_id` + `option secret` 注册过的节点；
//     未注册 node_id 一律拒绝，绝不再用全局 mother_secret 给任意 node_id 开门。
//   * v2 签名原文含 nonce；母节点用 /tmp 下有界 TTL 目录原子占用 nonce 防重放。
//   * v1 旧签名（无 nonce）只在显式 legacy_shared_secret=1 时接受，并记 deprecation。
//   * X-Timestamp 与本地时间偏差 > 300 秒 → 拒绝；body.node_id 必须与认证字段一致。
//   * node_id 只允许 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（防目录穿越、防隐藏文件）。
//   * Content-Length 只接受 ^[0-9]+$（12abc/1e3/1,000/空白一律拒），
//     > 128 KiB 在**读取前**拒绝；实际读取夹到 MAX_BODY+1；声明与实际不符也拒绝。
//   * 请求体上限 128 KiB（子节点最多 20 设备 + 20 应用，实测 ~4 KB）。
//   * 失败日志进 syslog 且 60 秒最多一条，避免被扫端口时刷屏。
//
// 手工排查（不需要 web 服务器，直接喂 stdin）：
//   printf '%s' "$BODY" | env REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} \
//     CONTENT_TYPE=application/json \
//     HTTP_AUTHORIZATION="PrismRouter node_id=node-a;ts=$TS;proto=2;nonce=$NONCE;sign=$SIGN" \
//     /usr/bin/ucode /www/cgi-bin/prism-router-ingest
//
// 依赖：ucode（fs/uci/json 内建）、sha256sum（busybox；缺失时回退 openssl dgst）。
// 风格同 push.uc / feishu.uc。
'use strict';

import { readfile, access, popen, writefile, unlink, open, rename, chmod, chown, stdin, stat, lsdir, lstat, mkdir, rmdir } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG   = 'prism-router';
const NODES_DIR    = '/etc/prism-router/nodes';
const TMP_DIR      = '/tmp/prism-router';
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
        /* /tmp/prism-router 不是真实 root 目录（例如被换成 symlink）→ 不写日志。 */
        if (!ensure_dir(TMP_DIR))
            return;

        writefile(LOG_STATE, sprintf('%d\n', now));
    }
    catch (e) {
        /* 记不上就算了，不要因为日志失败影响响应 */
    }

    system([ 'logger', '-t', 'prism-router-ingest', '-p', 'daemon.warn', cut(one_line(msg), 200) ]);
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

// ───────────────────── 认证工具（与 prism-router-node-auth.uc 同步）─────────
//
// 目标容器 OpenSSL 3.0.22 实测：`dgst -hmac` / `-macopt key:<文件>` 都只接受
// argv 里的字面量，没有“从文件/fd 读 HMAC key”的选项；环境变量又会出现在
// /proc/<pid>/environ。因此这里用 ucode 内存拼 ipad/opad + sha256sum 读 stdin，
// 密钥不进 argv / 环境变量 / 磁盘，只把 hash 的十六进制文本落到 0600 临时文件。

const AUTH_TMP = '/tmp/prism-router/.auth';
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

/* 安全目录（与 prism-router-node-auth.uc 同步）：
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

/* /tmp/prism-router 先安全创建/校验，再建 0700 的 .auth。 */
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

// ───────────────────────────── 签名 ─────────────────────────────

function uci_cursor() {
    try {
        return cursor();
    }
    catch (e) {
        return null;
    }
}

// ───────────────────────────── nonce 防重放 ─────────────────────────────
//
// 每个已认证的 v2 请求用一个一次性 nonce（客户端 16 字节随机数 hex）。
// 用 mkdir 的原子性做“检查并占用”：同名目录创建失败 = 重放。
// 目录 mtime 做过期依据，TTL 覆盖时间戳容差；每个节点条目数有上限，失败关闭。

const NONCE_DIR = `${TMP_DIR}/nonces`;
const NONCE_TTL = 900;          // 15 分钟（> MAX_SKEW 300s）
const NONCE_MAX = 2048;         // 单节点未过期 nonce 上限

function ensure_nonce_dir() {
    if (!auth_safe_tmp_parent())
        return false;

    if (!auth_secure_dir(TMP_DIR, MODE_755))
        return false;

    return auth_secure_dir(NONCE_DIR, 448);   // 0o700
}

/* 返回 true = 新 nonce 已占用；false = 重放 / 无法安全记录（调用方必须拒绝）。 */
function consume_nonce(node_id, nonce) {
    if (!auth_valid_nonce(nonce))
        return false;

    if (!ensure_nonce_dir())
        return false;

    const dir = sprintf('%s/%s', NONCE_DIR, node_id);

    /* 节点子目录同样必须是真实 root 目录；已有 symlink/普通文件 → 失败关闭。 */
    if (!auth_secure_dir(dir, 448))
        return false;

    /* 先清过期条目，同时统计存活数量。lstat 不跟随符号链接。 */
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

    /* mkdir 是原子的：同名只可能成功一次；目标已存在（含 symlink）即失败。 */
    const nonce_dir = sprintf('%s/%s', dir, nonce);

    let made = null;

    try { made = mkdir(nonce_dir, 448); } catch (e) { return false; }

    /* mkdir 返回 null = 目标已存在（重放/预置 symlink）或失败，必须拒绝。 */
    if (made != true || auth_lstat_dir(nonce_dir) == null)
        return false;

    try { chmod(nonce_dir, 448); } catch (e) { }

    return true;
}

// ───────────────────────────── 请求解析 ─────────────────────────────

function env_header(name) {
    let value = getenv(`HTTP_${name}`);

    if (value == null)
        value = getenv(name);

    return trim(text(value ?? '', ''));
}

/* 新协议把凭证放在 Authorization: PrismRouter node_id=..;ts=..;proto=2;nonce=..;sign=..
   （uhttpd 会转发 Authorization）。解析成 map，避免任何字段被拼进 shell/日志。 */
function auth_params() {
    const out = {};
    let auth = env_header('AUTHORIZATION');

    if (!length(auth))
        auth = trim(text(getenv('AUTHORIZATION'), ''));

    const m = match(auth, /^PrismRouter[ \t]+(.+)$/i);

    if (m == null)
        return out;

    for (let part in split(m[1], ';')) {
        const eq = index(part, '=');

        if (eq <= 0)
            continue;

        out[trim(substr(part, 0, eq))] = trim(substr(part, eq + 1));
    }

    return out;
}

/* 字段取值顺序：Authorization -> X-* 头 -> 查询串。
   查询串只用于非敏感字段和 v1 legacy；v2 的 sign 绝不允许从查询串取。 */
function request_value(http_name, query, query_key, auth, allow_query) {
    if (auth != null && length(auth[query_key]) > 0)
        return trim(auth[query_key]);

    const value = env_header(http_name);

    if (length(value) > 0)
        return value;

    return allow_query ? trim(text(query[query_key], '')) : '';
}

/* ucode 里标准输入的类型是 'resource'（不是 'object'），别按 object 判。
   读取上限是 MAX_BODY + 1：超过即拒；声明长度与实际不一致也拒。 */
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

    /* 声明长度内没读满/刚好读满都不算完：再探 1 字节，抓“实际比声明多”。
       只在 declared 未到上限时探，避免为一个正常的大包多阻塞一次。 */
    if (has_declared && declared >= 0 && declared <= MAX_BODY && length(raw) <= declared) {
        try {
            const extra = stdin.read(1);

            if (extra != null && length(extra) > 0)
                raw += extra;
        }
        catch (e) {
            /* EOF 是正常情况 */
        }
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

// ───────────────────────────── 主流程 ─────────────────────────────

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

function main() {
    if (trim(text(getenv('REQUEST_METHOD'), '')) != 'POST') {
        respond(405, 'only POST is accepted', 405);
        return 0;
    }

    /* 先看声明的长度，超限在**读取之前**就拒；读取阶段再夹到 MAX_BODY+1。
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

    /* uhttpd 会带 application/json；没带时不拦（便于手工调试），带了但不是 json 才拒。 */
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
    const auth = auth_params();
    const node_id = request_value('X_NODE_ID', query, 'node_id', auth, true);

    if (!match(node_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)) {
        respond(4, 'invalid X-Node-Id');
        return 0;
    }

    const ts_text = request_value('X_TIMESTAMP', query, 'ts', auth, true);
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

    /* proto: 2 = 新协议（nonce + 每节点密钥）；缺省/1 = v1 旧协议（仅 legacy 显式允许）。 */
    const proto_text = request_value('X_PROTO', query, 'proto', auth, true);
    let proto = integer(proto_text, 0);

    if (proto == 0)
        proto = 1;

    if (proto != 1 && proto != 2) {
        respond(4, 'unsupported protocol version');
        return 0;
    }

    const nonce = request_value('X_NONCE', query, 'nonce', auth, true);
    let secret = '';

    if (proto == 2) {
        secret = auth_node_secret(uci_cursor(), node_id);

        if (length(secret) == 0) {
            note(sprintf('未注册的 node_id 被拒：%s', node_id));
            respond(1, 'node is not registered on mother node');
            return 0;
        }
    }
    else {
        const legacy = int(trim(text(uci_get('settings', 'legacy_shared_secret', '0'), '0'))) != 0;

        if (!legacy) {
            note('收到 v1 旧协议请求，但 legacy_shared_secret 未开启，拒绝');
            respond(1, 'legacy shared secret protocol is disabled');
            return 0;
        }

        secret = trim(text(uci_get('settings', 'mother_secret', ''), ''));

        if (length(secret) == 0) {
            note('母节点未配置 prism-router.settings.mother_secret，拒绝接收');
            respond(3, 'mother_secret not configured on mother node');
            return 0;
        }

        note(sprintf('接受 v1 legacy 共享密钥请求 node=%s（已弃用，请迁移到 config node 独立密钥）', node_id));
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

    let sign = '';

    if (auth != null && length(auth.sign))
        sign = trim(auth.sign);
    else {
        sign = env_header('X_SIGN');

        /* v1 为兼容旧客户端/旧测试，允许签名走查询串；v2 绝不允许。 */
        if (!length(sign) && proto == 1)
            sign = trim(text(query.sign, ''));
    }

    if (length(sign) == 0) {
        respond(1, 'missing signature');
        return 0;
    }

    const digest = auth_sha256_hex(body);

    if (length(digest) == 0) {
        note('无法计算 body 的 sha256（缺少 sha256sum / openssl？）');
        respond(5, 'signature verification unavailable');
        return 0;
    }

    let expect = '';

    if (proto == 2) {
        if (!auth_valid_nonce(nonce)) {
            respond(4, 'invalid nonce');
            return 0;
        }

        expect = auth_hmac_b64(secret, auth_message_v2(node_id, ts_text, nonce, digest));
    }
    else {
        expect = auth_hmac_b64(secret, auth_message_v1(node_id, ts_text, digest));
    }

    if (length(expect) == 0) {
        note('无法计算 HMAC（缺少 sha256sum？）');
        respond(5, 'signature verification unavailable');
        return 0;
    }

    if (!auth_same(sign, expect)) {
        note(sprintf('签名校验失败 node=%s proto=%d', node_id, proto));
        respond(1, 'signature mismatch');
        return 0;
    }

    /* 验签通过后才占用 nonce，避免未认证请求把 /tmp 撑大。 */
    if (proto == 2 && !consume_nonce(node_id, nonce)) {
        note(sprintf('nonce 重放被拒 node=%s', node_id));
        respond(8, 'replayed nonce');
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
