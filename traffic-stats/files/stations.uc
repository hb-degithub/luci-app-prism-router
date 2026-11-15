#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// stations.uc —— 哑桥 AP 侧：把「无线站点元数据」上报给母节点（只报元数据，绝不报字节）
//
// 安装位置：/usr/share/traffic-stats/stations.uc
//（由 tools/build-ipk.sh 打进 traffic-stats 包；母节点接收端见 ingest-stations.uc）
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
// 「共享 token + 时间戳」：仅限可信局域网使用，端口不要暴露到 WAN。
// 具体能保证什么、不能保证什么，写在 ingest-stations.uc 的文件头里（母节点是权威说明）。
// 本端能做的都做了：token 只从 UCI 读，不放命令行参数里（避免 ps 里可见）。
//
// ───────────────────────────── 协议 ─────────────────────────────
//   POST <mother_url>/cgi-bin/traffic-stats-stations
//   Content-Type: application/json
//   X-Node-Id:   <node_id>
//   X-Timestamp: <unix 秒>
//   X-Token:     <stations_token>
//   body: {"node_id","name","ts","stations":[
//            {"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53,
//             "rx_rate":866600,"tx_rate":650000,"connected_sec":3600}]}
//
//   单位约定（字段名固定，别改）：
//     signal        dBm（整数，负数）
//     rx_rate/tx_rate  协商速率，**kbit/s**（iw 的 "866.6 MBit/s" → 866600）
//     connected_sec 秒
//
// ⚠️ 真机实测：OpenWrt 的 uhttpd 只把 HTTP_ACCEPT / HTTP_AUTHORIZATION / HTTP_HOST /
// HTTP_USER_AGENT 这几个头传进 CGI 环境，自定义 X-* 头会被静默丢弃。所以除了上面的头，
// 本脚本还把 node_id / ts / token 以 percent 编码放进 URL 查询串；母节点先读头、读不到
// 再读查询串。头照样发，方便 nginx 等标准 CGI 环境。代价是 token 会出现在 web 服务器
// 访问日志里 —— 局域网内可接受，别把该端口暴露到 WAN（见上面的安全边界）。
//
// ───────────────────────────── 定时 ─────────────────────────────
// 包不改 crontab，由用户自行添加（AP 上 crond 有；别用 /etc/crontabs/root 以外的机制）：
//   * * * * * /usr/bin/ucode /usr/share/traffic-stats/stations.uc >/dev/null 2>&1
//
// 手动自测（只打印将要发送的请求，不联网；不要求 openssl）：
//   TRAFFIC_STATS_STATIONS_DRY=1 /usr/bin/ucode /usr/share/traffic-stats/stations.uc
//
// ───────────────────────────── UCI（section traffic-stats.settings）─────────────────────────
//   stations_enabled '0'   1 = 允许上报；0 = 关闭（默认）
//   station_ifaces   ''    逗号分隔的 AP 接口名；留空 = 自动枚举 `iw dev` 里的 phy*-ap*
//   mother_url       ''    母节点地址，例如 http://192.168.100.1（与 push.uc 共用）
//   stations_token   ''    母/子共享令牌（母节点 stations_token 必须一致，否则拒收）
//   node_id          ''    节点 ID；留空则按「主机名 + 主 LAN 口 MAC 后 4 位」推导
//                          （口径与 push.uc 相同；这里不回写 UCI，避免两个脚本抢写配置）
//   node_name        ''    展示名；留空则用 node_id
//
// ───────────────────────────── 失败处理 ─────────────────────────────
// 采不到 / 没站点 / 网络不通 / 非 200 / 响应 code != 0 → 记日志并 exit 0（cron 每分钟会再试，
// 绝不刷屏）。只有「配置错误」（有开关但缺 token / 地址非法）返回 1。
// 日志：/tmp/traffic-stats/stations.log（512 KB 轮转）；syslog 每类消息 5 分钟最多一条。
//
// 环境变量（只给测试/现场排查用，线上默认行为不受影响）：
//   TRAFFIC_STATS_STATE_DIR       覆盖 /tmp/traffic-stats（日志目录，非必需）
//   TRAFFIC_STATS_STATIONS_DRY=1  只打印请求（url/headers/body），不联网
//   TRAFFIC_STATS_IW              iw 可执行文件路径（容器用例注入假 iw 用；默认查 /usr/sbin/iw）
//
// 依赖：ucode（fs/uci/json 内建）、curl、iw。**不需要 openssl**。
// 风格：与 push.uc 一致（run/shq/throttle/log/jstr 等小工具同名同义）。
'use strict';

import { readfile, access, popen, writefile, unlink, stat, open, rename, lsdir } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG    = 'traffic-stats';
const BASE          = getenv('TRAFFIC_STATS_STATE_DIR') ?? '/tmp/traffic-stats';
const DRY_RUN       = length(getenv('TRAFFIC_STATS_STATIONS_DRY') ?? '') > 0;
const IW_OVERRIDE   = getenv('TRAFFIC_STATS_IW') ?? '';

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

function ensure_dir(path) {
    if (length(path) == 0 || path == '.')
        return false;

    if (access(path))
        return true;

    return system([ 'mkdir', '-p', path ]) == 0;
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
        ensure_dir(BASE);

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
        /* 文件里每行都有（会轮转），syslog 5 分钟一条，cron 每分钟跑也不刷屏。 */
        if (level != 'ERROR' || throttle('syslog', 300))
            system([ 'logger', '-t', 'traffic-stats-stations', '-p',
                (level == 'ERROR' ? 'daemon.err' : 'daemon.warn'), cut(one_line(msg), 200) ]);
    }
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

/* `iw dev` 输出 → AP 接口名列表。优先看 type（AP），名字再兜一层 phy*-ap*。 */
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

        const type = match(t, /^type[ \t]+([A-Za-z]+)/);

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
        token: trim(text(uci_get('settings', 'stations_token', ''), '')),
        node_id: trim(text(uci_get('settings', 'node_id', ''), '')),
        node_name: trim(text(uci_get('settings', 'node_name', ''), ''))
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
function stations_url(url) {
    let base = trim(url);

    if (!match(base, /^https?:\/\/[^\/\s]+/))
        return '';

    base = replace(base, /\/+$/, '');

    if (match(base, /\/cgi-bin\/[A-Za-z0-9._-]+$/))
        return base;

    if (match(base, /\/cgi-bin$/))
        return `${base}/traffic-stats-stations`;

    return `${base}/cgi-bin/traffic-stats-stations`;
}

// ───────────────────────────── HTTP ─────────────────────────────

function http_post(curl, url, headers, body) {
    const tag = sprintf('%d-%d', getpid(), _seq++);
    const bf = sprintf('%s/.stations-body-%s.json', BASE, tag);
    const rf = sprintf('%s/.stations-resp-%s.json', BASE, tag);
    const ef = sprintf('%s/.stations-err-%s.txt', BASE, tag);

    if (!ensure_dir(BASE))
        return { http: 0, curl: -1, resp: '', err: '无法创建临时目录' };

    try {
        writefile(bf, body);
    }
    catch (e) {
        return { http: 0, curl: -1, resp: '', err: sprintf('写请求体失败：%s', e) };
    }

    /* --data-binary 用 @file 发原始字节；-L 跟随 uhttpd 的 307；-k 接受自签证书。 */
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

    /* 默认关闭；没开开关就完全静默（cron 每分钟跑，不产生任何日志）。 */
    if (!cfg.enabled)
        return 0;

    if (length(cfg.url) == 0) {
        log('WARN', 'stations_enabled=1 但 mother_url 未配置，跳过上报');
        return 0;
    }

    if (length(cfg.token) == 0) {
        log('ERROR', 'stations_enabled=1 但 stations_token 为空，母节点会拒收，跳过');
        return 1;
    }

    const url = stations_url(cfg.url);

    if (length(url) == 0) {
        log('ERROR', sprintf('mother_url 不是合法的 http(s) 地址：%s', cut(cfg.url, 120)));
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
    const got = collect_stations(scan);

    if (length(got.list) == 0) {
        log('INFO', sprintf('扫描 %d 个接口，无关联站点，跳过上报', got.scanned));
        return 0;
    }

    const body = jstr(build_payload(cfg, node_id, got.list));
    const ts = sprintf('%d', time());
    const headers = {
        'Content-Type': 'application/json',
        'X-Node-Id': node_id,
        'X-Timestamp': ts,
        'X-Token': cfg.token
    };

    /* uhttpd 不转发自定义头，所以同样的值再挂一份到查询串（见文件头说明）。 */
    const query = sprintf('node_id=%s&ts=%s&token=%s',
        url_encode(node_id), url_encode(ts), url_encode(cfg.token));
    const sep = (index(url, '?') >= 0) ? '&' : '?';

    if (DRY_RUN) {
        print(sprintf('%J\n', { url: url + sep + query, headers: headers, body: body }));
        return 0;
    }

    const res = parse_response(http_post(curl_bin(), url + sep + query, headers, body));

    if (!res.ok) {
        /* 网络 / 非 200 / code != 0 都不算脚本故障：记日志，下个周期再试。 */
        log('ERROR', sprintf('上报失败：code=%s %s（%d 个站点，%d 字节）',
            res.code, cut(res.msg, 160), length(got.list), length(body)));
        return 0;
    }

    if (throttle('ok', 600))
        log('INFO', sprintf('上报成功：%s 站点=%d bytes=%d ts=%s',
            url, length(got.list), length(body), ts));

    return 0;
}

exit(main());
