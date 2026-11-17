#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// stations.uc —— 哑桥 AP 侧：把「无线站点元数据」上报给母节点（只报元数据，绝不报字节）
//
// 安装位置：/usr/share/prism-router/stations.uc
//（由 tools/build-ipk.sh 打进 prism-router 包；母节点接收端见 ingest-stations.uc）
//
// ───────────────────────────── 为什么只报元数据 ─────────────────────────────
// AP 是**哑桥**（dhcp.lan.ignore=1、wan proto=none），客户端流量全部经桥接转发到主路由，
// 由主路由的 conntrack 统计。AP 若也做字节统计，同一份流量会被记两次（总量翻倍）。
// 所以本脚本**只**上报 MAC / 接口 / 信号 / 协商速率 / 连接时长，一个字节字段都不发；
// 母节点只把这些字段合并进设备详情里，字节仍然只来自母节点自己的采集。
// 详见 docs/AP-ROLE.md（方案 B）。
//
// ───────────────────────────── 安全边界（必读）─────────────────────────────
// AP 上没有 openssl，算不了 HMAC-SHA256，所以这条通道**不是签名通道**，而是
// 「按节点注册的 token + nonce + 时间戳」：仅限可信局域网使用，端口不要暴露到 WAN。
// 具体能保证什么、不能保证什么，写在 ingest-stations.uc 的文件头里（母节点是权威说明）。
// 本端：token 只从 UCI 读；走 Authorization: Bearer，不放 URL 查询串、不拼命令行；
// 临时文件 0600；curl 不 -k、不自动跨源重定向。
//
// ───────────────────────────── 协议 ─────────────────────────────
//   POST <mother_url>/cgi-bin/prism-router-stations?node_id=..&ts=..&proto=2&nonce=..
//   Content-Type: application/json
//   Authorization: Bearer <token>       ← uhttpd 会转发，token 不进 URL
//   X-Node-Id / X-Timestamp / X-Proto / X-Nonce / X-Token（给 nginx 等标准 CGI 用）
//   body: {"node_id","name","ts","stations":[
//            {"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53,
//             "rx_rate":866600,"tx_rate":650000,"connected_sec":3600}]}
//
//   单位约定（字段名固定，别改）：
//     signal        dBm（整数，负数）
//     rx_rate/tx_rate  协商速率，**kbit/s**（iw 的 "866.6 MBit/s" → 866600）
//     connected_sec 秒
//
// 真机实测：uhttpd 只转发 HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST / HTTP_USER_AGENT，
// 自定义 X-* 会被丢弃；Authorization 可用。所以 token 走 Bearer，URL 里只剩
// node_id/ts/proto/nonce（不是机密，且 nonce 由母节点原子占用防重放）。
//
// ───────────────────────────── 定时 ─────────────────────────────
// 包不改 crontab，由用户自行添加（AP 上 crond 有；别用 /etc/crontabs/root 以外的机制）：
//   * * * * * /usr/bin/ucode /usr/share/prism-router/stations.uc >/dev/null 2>&1
//
// 手动自测（只打印将要发送的请求，不联网；不要求 openssl）：
//   PRISM_ROUTER_STATIONS_DRY=1 /usr/bin/ucode /usr/share/prism-router/stations.uc
//
// ───────────────────────────── UCI（section prism-router.settings）─────────────────────────
//   stations_enabled '0'   1 = 允许上报；0 = 关闭（默认）
//   station_ifaces   ''    逗号分隔的 AP 接口名；留空 = 自动枚举 `iw dev` 里的 phy*-ap*
//   mother_url       ''    母节点地址，例如 http://192.168.100.1（与 push.uc 共用）
//   stations_token   ''    旧全局令牌（仅当本机没有 config station 独立 token 时兜底）
//   node_id          ''    节点 ID；留空则按「主机名 + 主 LAN 口 MAC 后 4 位」推导
//                          （口径与 push.uc 相同；这里不回写 UCI，避免两个脚本抢写配置）
//   node_name        ''    展示名；留空则用 node_id
//   stations_ca / stations_pinned_sha256  HTTPS 校验（默认验证系统 CA）
//
//   本机独立 token（推荐）：
//     config station
//         option node_id '<与 settings.node_id 一致>'
//         option token   '<母节点上同一 AP 的 token>'

//
// ───────────────────────────── 失败处理 ─────────────────────────────
// 采不到 / 没站点 / 网络不通 / 非 200 / 响应 code != 0 → 记日志并 exit 0（cron 每分钟会再试，
// 绝不刷屏）。只有「配置错误」（有开关但缺 token / 地址非法）返回 1。
// 日志：/tmp/prism-router/stations.log（512 KB 轮转）；syslog 每类消息 5 分钟最多一条。
//
// 环境变量（只给测试/现场排查用，线上默认行为不受影响）：
//   PRISM_ROUTER_STATE_DIR       覆盖 /tmp/prism-router（日志目录，非必需）
//   PRISM_ROUTER_STATIONS_DRY=1  只打印请求（url/headers/body），不联网
//   PRISM_ROUTER_IW              iw 可执行文件路径（容器用例注入假 iw 用；默认查 /usr/sbin/iw）
//
// 依赖：ucode（fs/uci/json 内建）、curl、iw。**不需要 openssl**。
// 风格：与 push.uc 一致（run/shq/throttle/log/jstr 等小工具同名同义）。
'use strict';

import { readfile, access, popen, writefile, unlink, stat, open, rename, lsdir, chmod, chown, lstat, mkdir } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG    = 'prism-router';
const BASE          = getenv('PRISM_ROUTER_STATE_DIR') ?? '/tmp/prism-router';
const DRY_RUN       = length(getenv('PRISM_ROUTER_STATIONS_DRY') ?? '') > 0;
const IW_OVERRIDE   = getenv('PRISM_ROUTER_IW') ?? '';

const LOG_MAX       = 524288;   // 512 KB 轮转
const CURL_TIMEOUT  = 10;       // 秒；cron 每分钟一次，别拖过周期
const MAX_IFACES    = 16;       // 单次最多扫 16 个 BSS
const MAX_STATIONS  = 128;      // 单次最多上报 128 个站点（母节点上限 256，报文 ~15 KB）
const MAX_NAME      = 64;

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

/* 按字节截断，且不切断 UTF-8 码点（与 push.uc / feishu.uc 的 cut 一致）。 */
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

/* 单行化：日志里不允许出现换行（否则一行日志会变成多行）。 */
function one_line(s) {
    let out = '';

    for (let i = 0; i < length(s); i++) {
        const c = substr(s, i, 1);

        out += (c == '\n' || c == '\r' || c == '\t') ? ' ' : c;
    }

    return out;
}

/* 单引号 shell 转义（接口名、路径都从这里过，绝不直拼）。 */
function shq(s) {
    return `'${replace(`${s}`, "'", "'\\''")}'`;
}

/* percent 编码：node_id / ts / token 放进查询串时用。 */
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

/* 目录必须落成真实 root 目录：已存在但不是目录/属主非 root（含 symlink）→ false。 */
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

/* 日志节流：同一类消息在 interval 秒内最多记一次（必然要在 log() 之前定义）。 */
function throttle(key, interval) {
    const path = sprintf('%s/stations-%s.last', BASE, key);
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
        /* BASE 不是真实 root 目录（例如 /tmp/prism-router 被换成 symlink）→ 不写日志。 */
        if (!ensure_dir(BASE)) {
            print(line);
            return;
        }

        const lp = `${BASE}/stations.log`;

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
        /* 文件里每行都有（会轮转）；syslog 按级别 5 分钟一条，cron 每分钟跑也不刷屏。 */
        if (throttle(sprintf('syslog-%s', lc(level)), 300))
            system([ 'logger', '-t', 'prism-router-stations', '-p',
                (level == 'ERROR' ? 'daemon.err' : 'daemon.warn'), cut(one_line(msg), 200) ]);
    }
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

    if (!auth_secure_dir('/tmp/prism-router', 493))   /* 0755 */
        return false;

    return auth_secure_dir(AUTH_TMP, 448);             /* 0700 */
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

// ───────────────────────────── JSON ─────────────────────────────

/* ucode 的 %J 会插空格（`{ "a": 1 }`），压成紧凑 JSON：
   只在字符串外部删空白，字符串内部的空格/换行原样保留（同 push.uc）。 */
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

// ───────────────────────────── 可执行文件定位 ─────────────────────────────

function iw_bin() {
    if (length(IW_OVERRIDE))
        return IW_OVERRIDE;

    for (let path in [ '/usr/sbin/iw', '/sbin/iw', '/usr/bin/iw', '/bin/iw' ])
        if (access(path))
            return path;

    /* 退回 PATH（容器用例把假 iw 注入 PATH 就走这条）。 */
    return 'iw';
}

function curl_bin() {
    for (let path in [ '/usr/bin/curl', '/usr/sbin/curl', '/bin/curl' ])
        if (access(path))
            return path;

    return 'curl';
}

// ───────────────────────────── iw 输出解析 ─────────────────────────────
//
// 目标格式（iw 4.x/5.x，mac80211）：
//
//   Station 22:77:08:69:a9:1f (on phy0.1-ap0)
//   	inactive time:	1234 ms
//   	rx bytes:	12345678          <-- 字节，本脚本**故意不解析**
//   	signal:  	-53 [-57, -55] dBm
//   	signal avg:	-55 [-58, -56] dBm
//   	tx bitrate:	650.0 MBit/s VHT-MCS 7 80MHz short GI VHT-NSS 2
//   	rx bitrate:	866.6 MBit/s VHT-MCS 9 80MHz short GI VHT-NSS 2
//   	connected time:	3600 seconds
//
// 健壮性要求：字段缺失/带单位/格式变化都不能崩，解析不出来就**跳过该字段**。
// 因此这里不用固定偏移、不按行号取值，而是「按 key: value 解析 + 已知 key 白名单」。

/* key 归一化："signal   avg" / "signal\tavg" → "signal avg"。 */
function norm_key(raw) {
    let out = '', last_space = false;

    for (let i = 0; i < length(raw); i++) {
        const c = substr(raw, i, 1);

        if (c == ' ' || c == '\t' || c == '\r') {
            if (!last_space)
                out += ' ';

            last_space = true;
        }
        else {
            out += c;
            last_space = false;
        }
    }

    return lc(trim(out));
}

function is_mac(s) {
    return match(s, /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/) != null;
}

/* "signal: -53 [-57, -55] dBm" → -53；越界/无数字 → null（跳过字段）。 */
function parse_signal(value) {
    const m = match(value, /(-?[0-9]+)/);

    if (m == null)
        return null;

    const n = int(m[1]);

    if (n != n)
        return null;

    /* dBm 物理范围：-120..0。超出说明不是信号（比如解析到了别的字段）→ 丢弃。 */
    if (n < -120 || n > 0)
        return null;

    return n;
}

/* "866.6 MBit/s VHT-MCS ..." → 866600（kbit/s）；"6.0 MBit/s" → 6000；认不出 → null。
   不依赖浮点库：整数部分 + 小数部分各自换算（ucode 无 math 模块时也能跑）。 */
function parse_bitrate(value) {
    const lv = lc(value);
    const m = match(lv, /^([0-9]+(\.[0-9]+)?)[ \t]*([kmgt]?)bit\/s/);

    if (m == null)
        return null;

    const dot = index(m[1], '.');
    let whole = m[1], frac = '';

    if (dot >= 0) {
        whole = substr(m[1], 0, dot);
        frac = substr(m[1], dot + 1, 6);
    }

    let n = int(whole);

    if (n != n)
        return null;

    /* 先算到"单位值的千分之一"，最后一步再换算成 kbit/s，避免小数累积误差。 */
    let thousandths = n * 1000;

    if (length(frac)) {
        let f = int(frac);

        if (f != f)
            f = 0;

        /* 小数位可能被截短（"6" 表示 0.6），按实际位数缩放。 */
        let div = 1;

        for (let i = 0; i < length(frac); i++)
            div *= 10;

        thousandths += int((f * 1000) / div + 0.5);
    }

    /* 单位 → kbit/s 的换算系数（1 MBit/s = 1000 kbit/s）。 */
    const unit = m[3];
    let mult = 0.001;           /* bit/s */

    if (unit == 'g')
        mult = 1000000;
    else if (unit == 'm')
        mult = 1000;
    else if (unit == 'k')
        mult = 1;

    const kbit = int((thousandths * mult) / 1000 + 0.5);

    if (kbit < 0 || kbit > 100000000)   /* 100 Tbit/s 以上视为垃圾数据 */
        return null;

    return kbit;
}

/* "3600 seconds" → 3600；"123" → 123；认不出 → null。 */
function parse_seconds(value) {
    const m = match(value, /^([0-9]+)/);

    if (m == null)
        return null;

    const n = int(m[1]);

    if (n != n || n < 0 || n > 40000000)
        return null;

    return n;
}

/* "Station 22:77:08:69:a9:1f (on phy0.1-ap0)" → { mac, iface }；不是站点行 → null。 */
function station_head(line, default_iface) {
    const m = match(line, /^Station[ \t]+([0-9A-Fa-f:]{17})/);

    if (m == null || !is_mac(m[1]))
        return null;

    let iface = `${default_iface}`;
    const on = match(line, /\(on[ \t]+([^)]+)\)/);

    if (on != null) {
        const name = trim(on[1]);

        /* 接口名只允许安全字符：它只用于展示与匹配，绝不进文件路径。 */
        if (match(name, /^[A-Za-z0-9._-]{1,32}$/))
            iface = name;
    }

    return { mac: lc(m[1]), iface: iface };
}

/* 解析一份 `iw dev <if> station dump` 输出。fields 缺省就不出现（母节点按缺省处理）。 */
function parse_dump(raw, iface) {
    const out = [];
    let cur = null;

    for (let line in split(raw, '\n')) {
        const t = trim(line);

        if (length(t) == 0)
            continue;

        if (match(t, /^Station[ \t]/) != null) {
            cur = station_head(t, iface);

            if (cur != null && length(out) < MAX_STATIONS)
                push(out, cur);

            continue;
        }

        if (cur == null)
            continue;

        /* key: value —— 只认白名单里的 4 个 key，其余（含 rx/tx bytes）一律忽略。 */
        const colon = index(t, ':');

        if (colon <= 0)
            continue;

        const key = norm_key(substr(t, 0, colon));
        const value = trim(substr(t, colon + 1));

        if (key == 'signal') {
            const v = parse_signal(value);

            if (v != null)
                cur.signal = v;
        }
        else if (key == 'rx bitrate') {
            const v = parse_bitrate(value);

            if (v != null)
                cur.rx_rate = v;
        }
        else if (key == 'tx bitrate') {
            const v = parse_bitrate(value);

            if (v != null)
                cur.tx_rate = v;
        }
        else if (key == 'connected time') {
            const v = parse_seconds(value);

            if (v != null)
                cur.connected_sec = v;
        }
    }

    return out;
}

/* `iw dev` 输出 → AP 接口名列表。优先看 type（必须正好是 AP），名字再兜一层 phy*-ap*。
   注意 `type AP/VLAN` 是 VLAN 接口（例如 br-lan），**不是** BSS，不能被当成 AP ——
   否则会去 dump 一个没有 station 的接口，白干活还刷日志。 */
function is_ap_iface(name, kind) {
    if (kind == 'ap')
        return true;

    return match(name, /^phy[0-9]+.*-ap[0-9]+/) != null;
}

function parse_iw_dev(raw) {
    const out = [];
    let name = null, kind = '';

    for (let line in split(raw, '\n')) {
        const t = trim(line);

        if (length(t) == 0)
            continue;

        const iface = match(t, /^Interface[ \t]+([A-Za-z0-9._-]+)/);

        if (iface != null) {
            if (name != null && is_ap_iface(name, kind) && index(out, name) < 0)
                push(out, name);

            name = iface[1];
            kind = '';
            continue;
        }

        /* 取整个 token：'AP' 才是 BSS，'AP/VLAN' 不是（用 [A-Za-z]+ 会截成 AP）。 */
        const type = match(t, /^type[ \t]+(\S+)/);

        if (type != null) {
            kind = lc(type[1]);
            continue;
        }
    }

    if (name != null && is_ap_iface(name, kind) && index(out, name) < 0)
        push(out, name);

    return out;
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

    if (!is_mac(raw) || raw == '00:00:00:00:00:00')
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

/* 默认 node_id = 主机名 + MAC 后 4 位（与 push.uc 同口径，两边算出来一致）。
   这里**不回写 UCI**：push.uc 会把结果写回，两个脚本抢写同一份配置没必要。 */
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

// ───────────────────────────── 配置 ─────────────────────────────

function load_config() {
    const raw_ifaces = trim(text(uci_get('settings', 'station_ifaces', ''), ''));
    const ifaces = [];

    if (length(raw_ifaces)) {
        for (let item in split(raw_ifaces, ',')) {
            const name = trim(item);

            /* 只接受安全接口名：不允许空、不允许奇怪字符（避免后面拼进 shell 时出岔子）。 */
            if (match(name, /^[A-Za-z0-9._-]{1,32}$/) && index(ifaces, name) < 0)
                push(ifaces, name);
        }
    }

    return {
        enabled: uci_flag('settings', 'stations_enabled', false),
        ifaces: ifaces,
        url: trim(text(uci_get('settings', 'mother_url', ''), '')),
        /* 旧字段仍读取；若本节点有 config station 独立 token，则优先用独立 token。 */
        token_global: trim(text(uci_get('settings', 'stations_token', ''), '')),
        node_id: trim(text(uci_get('settings', 'node_id', ''), '')),
        node_name: trim(text(uci_get('settings', 'node_name', ''), '')),
        ca: trim(text(uci_get('settings', 'stations_ca', ''), '')),
        pin: trim(text(uci_get('settings', 'stations_pinned_sha256', ''), ''))
    };
}

// ───────────────────────────── 采集 ─────────────────────────────

function iw_dev_list() {
    const r = run(sprintf('%s dev 2>/dev/null', shq(iw_bin())));

    if (r.code != 0)
        return [];

    return parse_iw_dev(r.out);
}

function station_dump(iface) {
    return run(sprintf('%s dev %s station dump 2>/dev/null', shq(iw_bin()), shq(iface)));
}

/* 输出前显式挑字段：即使解析过程里意外多出字段，也不会把字节类字段带出去。
   这是"只报元数据、绝不报字节"的最后一道闸。 */
function station_json(st) {
    const out = { mac: st.mac, iface: st.iface };

    if (st.signal != null)
        out.signal = st.signal;

    if (st.rx_rate != null)
        out.rx_rate = st.rx_rate;

    if (st.tx_rate != null)
        out.tx_rate = st.tx_rate;

    if (st.connected_sec != null)
        out.connected_sec = st.connected_sec;

    return out;
}

function collect_stations(ifaces) {
    const list = [];
    const seen = {};
    let scanned = 0;

    for (let iface in ifaces) {
        const r = station_dump(iface);

        if (r.code != 0) {
            log('WARN', sprintf('iw dev %s station dump 失败（exit %d），跳过该接口', iface, r.code));
            continue;
        }

        scanned++;

        for (let st in parse_dump(r.out, iface)) {
            if (seen[st.mac] == true)
                continue;

            seen[st.mac] = true;

            if (length(list) < MAX_STATIONS)
                push(list, station_json(st));
        }
    }

    return { list: list, scanned: scanned, total: length(seen) };
}

// ───────────────────────────── 报文 ─────────────────────────────

function build_payload(cfg, node_id, stations) {
    const label = length(cfg.node_name) ? cfg.node_name : node_id;

    return {
        node_id: node_id,
        name: cut(label, MAX_NAME),
        ts: time(),
        stations: stations
    };
}

/* mother_url 允许这几种写法：http://host / http://host:port / http://host/cgi-bin
   / 已经带 /cgi-bin/<script> 的完整地址。 */
function url_parts(u) {
    const raw = `${u}`;

    if (match(raw, /[\r\n\t ]/))
        return null;

    if (index(raw, '@') >= 0 || index(raw, '#') >= 0)
        return null;

    const m = match(raw, /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:([0-9]{1,5}))?(\/[^?#]*)?(\?[^#]*)?$/);

    if (m == null)
        return null;

    const scheme = lc(m[1]);
    const port = integer(m[4], scheme == 'https' ? 443 : 80);

    if (port <= 0 || port > 65535)
        return null;

    return {
        scheme: scheme,
        host: lc(m[2]),
        port: port,
        path: length(m[5]) ? m[5] : '/',
        query: length(m[6]) ? m[6] : ''
    };
}

/* mother_url 允许 http(s)://host[:port][/path]；不允许 userinfo/查询串。 */
function stations_url(url) {
    let base = trim(`${url}`);
    const p = url_parts(base);

    if (p == null || length(p.query))
        return '';

    base = replace(base, /\/+$/, '');

    if (match(base, /\/cgi-bin\/[A-Za-z0-9._-]+$/))
        return base;

    if (match(base, /\/cgi-bin$/))
        return `${base}/prism-router-stations`;

    return `${base}/cgi-bin/prism-router-stations`;
}

/* 只允许同主机、同路径/查询、http:80 -> https:443（或同端口）的重定向。 */
function same_origin_upgrade(from, to) {
    const a = url_parts(from), b = url_parts(to);

    if (a == null || b == null)
        return '';

    if (a.scheme != 'http' || b.scheme != 'https')
        return '';

    if (a.host != b.host)
        return '';

    if (!(a.port == b.port || (a.port == 80 && b.port == 443)))
        return '';

    if (a.path != b.path || a.query != b.query)
        return '';

    return `${to}`;
}

function redact_url(u) {
    return replace(`${u}`, /\?.*$/, '');
}

function curl_quote(s) {
    const v = `${s}`;

    if (match(v, /[\r\n]/))
        return null;

    return `"${replace(replace(v, /\\/g, '\\\\'), /"/g, '\\"')}"`;
}

function write_private(path, content) {
    let fd = null;

    try {
        fd = open(path, 'w', 384);
    }
    catch (e) {
        return false;
    }

    if (fd == null)
        return false;

    try {
        fd.write(`${content}`);
        fd.close();
        return true;
    }
    catch (e) {
        try { fd.close(); } catch (e2) { }
        return false;
    }
}

function pin_value(pin) {
    const p = trim(`${pin}`);

    if (length(p) == 0)
        return '';

    if (match(p, /^sha256\/\/[A-Za-z0-9+\/=]+$/))
        return p;

    if (match(p, /^[0-9a-fA-F]{64}$/))
        return `sha256//${auth_b64(auth_hex_bin(lc(p)))}`;

    return '';
}

/* 临时文件全部 0600；token 只进 Authorization / curl 配置文件，URL 里不再带 token。 */
function http_post(curl, url, headers, body, cfg) {
    const tag = sprintf('%d-%d-%s', getpid(), _seq++, auth_nonce());
    const bf = sprintf('%s/.stations-body-%s.json', BASE, tag);
    const rf = sprintf('%s/.stations-resp-%s.json', BASE, tag);
    const ef = sprintf('%s/.stations-err-%s.txt', BASE, tag);
    const cf = sprintf('%s/.stations-curl-%s.conf', BASE, tag);

    if (!ensure_dir(BASE))
        return { http: 0, curl: -1, resp: '', err: '无法创建临时目录', redirect: '' };

    if (!write_private(bf, body) || !write_private(rf, '') || !write_private(ef, '') || !write_private(cf, '')) {
        try { unlink(bf); } catch (e) { }
        try { unlink(rf); } catch (e) { }
        try { unlink(ef); } catch (e) { }
        try { unlink(cf); } catch (e) { }
        return { http: 0, curl: -1, resp: '', err: '写临时文件失败', redirect: '' };
    }

    const lines = [
        `url = ${curl_quote(url)}`,
        'request = "POST"',
        `data-binary = "@${bf}"`,
        `output = ${curl_quote(rf)}`,
        'write-out = "%{http_code} %{redirect_url}"',
        'silent',
        'show-error',
        'connect-timeout = 5',
        `max-time = ${CURL_TIMEOUT}`,
        'max-filesize = 65536',
        'proto = "=http,https"',
        'proto-redir = "=https"',
        'max-redirs = 0'
    ];

    for (let name in headers) {
        const hq = curl_quote(sprintf('%s: %s', name, headers[name]));

        if (hq == null) {
            try { unlink(bf); } catch (e) { }
            try { unlink(rf); } catch (e) { }
            try { unlink(ef); } catch (e) { }
            try { unlink(cf); } catch (e) { }
            return { http: 0, curl: -1, resp: '', err: '非法请求头', redirect: '' };
        }

        push(lines, `header = ${hq}`);
    }

    if (length(cfg.ca))
        push(lines, `cacert = ${curl_quote(cfg.ca)}`);

    const pin = pin_value(cfg.pin);

    if (length(pin))
        push(lines, `pinnedpubkey = ${curl_quote(pin)}`);

    if (!write_private(cf, `${join('\n', lines)}\n`)) {
        try { unlink(bf); } catch (e) { }
        try { unlink(rf); } catch (e) { }
        try { unlink(ef); } catch (e) { }
        try { unlink(cf); } catch (e) { }
        return { http: 0, curl: -1, resp: '', err: '写 curl 配置失败', redirect: '' };
    }

    const r = run(sprintf('%s -sS -K %s 2>%s', curl, shq(cf), shq(ef)));
    let resp = '', err = '', redirect = '', http = 0;

    try { if (access(rf)) resp = readfile(rf); } catch (e) { }
    try { if (access(ef)) err = trim(readfile(ef)); } catch (e) { }

    const meta = split(trim(r.out), ' ');

    http = integer(meta[0], 0);

    if (length(meta) > 1)
        redirect = trim(meta[1]);

    try { unlink(bf); } catch (e) { }
    try { unlink(rf); } catch (e) { }
    try { unlink(ef); } catch (e) { }
    try { unlink(cf); } catch (e) { }

    if (length(resp) > 65536) {
        resp = '';
        err = '响应体超过 64 KiB，已丢弃';
    }

    return { http: http, curl: r.code, resp: resp, err: err, redirect: redirect };
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

    /* 默认关闭；没开开关就完全静默（cron 每分钟跑，不产生任何日志）。 */
    if (!cfg.enabled)
        return 0;

    if (length(cfg.url) == 0) {
        log('WARN', 'stations_enabled=1 但 mother_url 未配置，跳过上报');
        return 0;
    }

    /* TLS 验证绝不放宽：配置了 CA / pin 就必须存在且格式合法。 */
    if (length(cfg.ca)) {
        if (!match(cfg.ca, /^\/[^\r\n]*$/) || !access(cfg.ca)) {
            log('ERROR', sprintf('stations_ca 必须是存在的绝对路径：%s', cut(cfg.ca, 120)));
            return 1;
        }
    }

    if (length(cfg.pin) && !length(pin_value(cfg.pin))) {
        log('ERROR', 'stations_pinned_sha256 格式非法（应为 sha256//base64 或 64 位 hex）');
        return 1;
    }

    const url = stations_url(cfg.url);

    if (length(url) == 0) {
        log('ERROR', sprintf('mother_url 不是合法的 http(s) 地址（不允许 userinfo/查询串）：%s', cut(cfg.url, 120)));
        return 1;
    }

    const ifaces = length(cfg.ifaces) ? cfg.ifaces : iw_dev_list();

    if (length(ifaces) == 0) {
        log('WARN', '没有可用的 AP 接口（station_ifaces 为空且 iw dev 未列出 phy*-ap*），跳过');
        return 0;
    }

    /* 接口数量上限：BSS 再多也不至于上百，超出的截掉，避免一轮跑太久。 */
    let scan = ifaces;

    if (length(scan) > MAX_IFACES) {
        scan = [];

        for (let i = 0; i < MAX_IFACES; i++)
            push(scan, ifaces[i]);

        log('WARN', sprintf('接口数 %d 超过上限 %d，只扫前 %d 个', length(ifaces), MAX_IFACES, MAX_IFACES));
    }

    const node_id = sanitize_id(cfg.node_id) || gen_node_id();
    const token = auth_station_token(uci_cursor(), node_id) || cfg.token_global;

    if (length(token) == 0) {
        log('ERROR', sprintf('节点 %s 没有 config station token，也没有 settings.stations_token，跳过', node_id));
        return 1;
    }

    const got = collect_stations(scan);

    if (length(got.list) == 0) {
        log('INFO', sprintf('扫描 %d 个接口，无关联站点，跳过上报', got.scanned));
        return 0;
    }

    const body = jstr(build_payload(cfg, node_id, got.list));
    const ts = sprintf('%d', time());
    const nonce = auth_nonce();
    const headers = {
        'Content-Type': 'application/json',
        'X-Node-Id': node_id,
        'X-Timestamp': ts,
        'X-Proto': '2',
        'X-Nonce': nonce,
        'X-Token': token,
        'Authorization': `Bearer ${token}`
    };

    /* token 只在 Authorization / X-Token（curl 配置文件 0600），查询串只放 nonce 等非机密。 */
    const query = sprintf('node_id=%s&ts=%s&proto=2&nonce=%s',
        url_encode(node_id), url_encode(ts), url_encode(nonce));
    const sep = (index(url, '?') >= 0) ? '&' : '?';

    if (DRY_RUN) {
        print(sprintf('%J\n', { url: url + sep + query, headers: headers, body: body }));
        return 0;
    }

    let raw = http_post(curl_bin(), url + sep + query, headers, body, cfg);

    if (raw.http >= 300 && raw.http < 400) {
        const next = length(raw.redirect) ? same_origin_upgrade(url + sep + query, raw.redirect) : '';

        if (length(next)) {
            if (throttle('redirect', 3600))
                log('WARN', sprintf('母节点同源 http->https 重定向，按安全规则重发：%s', redact_url(next)));

            raw = http_post(curl_bin(), next, headers, body, cfg);
        }
        else {
            log('ERROR', sprintf('拒绝重定向（跨源/降级/路径或查询串变化）：%s -> %s',
                redact_url(url), cut(redact_url(raw.redirect), 160)));
            return 0;
        }
    }

    const res = parse_response(raw);

    if (!res.ok) {
        /* 网络 / 非 200 / code != 0 都不算脚本故障：记日志，下个周期再试。 */
        log('ERROR', sprintf('上报失败：code=%s %s（站点 %d，请求体 %d 字节）',
            res.code, cut(res.msg, 160), length(got.list), length(body)));
        return 0;
    }

    if (throttle('ok', 600))
        log('INFO', sprintf('上报成功：%s 站点=%d 请求体=%d 字节 ts=%s proto=2',
            redact_url(url), length(got.list), length(body), ts));

    return 0;
}

exit(main());
