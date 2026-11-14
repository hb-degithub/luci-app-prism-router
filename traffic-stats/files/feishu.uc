#!/usr/bin/ucode
// feishu.uc — OpenWrt 流量统计插件的飞书群机器人推送模块
//
// 负责：日报卡片（JSON 2.0）生成 / 告警文本 / 签名 / 发送 / 失败重试 / 冷却去重
// 依赖：ucode（fs/uci/json 内建）、curl、openssl（openssl-util）
// 环境：iStoreOS 24.10（x86_64/musl）；没有 python3 / jq / node，也不使用它们。
//
// 用法（安装后位于 /usr/share/traffic-stats/feishu.uc，见 traffic-stats/Makefile）：
//   ucode feishu.uc daily                  # 生成并发送日报
//   ucode feishu.uc daily --dry-run        # 只生成，写到 /tmp/card.json，不联网
//   ucode feishu.uc card [--out FILE]      # 同上（只生成卡片）
//   ucode feishu.uc alerts                 # 扫描 state.json，发送需要发的告警
//   ucode feishu.uc test                   # 发送一条连通性测试
//   ucode feishu.uc selftest               # 离线自检：官方签名向量 + 卡片结构
//   ucode feishu.uc check [FILE]           # 校验已生成的卡片（默认 /tmp/card.json）
//   ucode feishu.uc retry [--now]          # 处理重试队列（--now 忽略到期时间）
//   ucode feishu.uc status                 # 查看配置/队列状态
//
// 定时调用（cron 示例，避开整点/半点以降低 11232 概率）：
//   32 8 * * * ucode /usr/share/traffic-stats/feishu.uc daily
//   3,13,23,33,43,53 * * * * ucode /usr/share/traffic-stats/feishu.uc alerts
//
// 常用参数：--base DIR（默认 /tmp/traffic-stats）、--state FILE、--history FILE、
//           --webhook URL、--secret SECRET（后两个仅用于测试，不写 UCI）、
//           --force（忽略 feishu.enabled=0）
//
// 配置（UCI，section traffic-stats.feishu）：
//   traffic-stats.feishu.enabled             0/1，默认 1（未设置时按启用处理）
//   traffic-stats.feishu.webhook             群机器人 webhook，空则静默跳过
//   traffic-stats.feishu.secret              签名密钥，空则静默跳过
//   traffic-stats.feishu.daily_time          日报时间，仅展示用（调度由调用方决定）
//   traffic-stats.feishu.alert_enabled       告警总开关，默认 1
//   traffic-stats.feishu.alert_new_device    新设备上线告警，默认 1
//   traffic-stats.feishu.device_daily_limit  单设备日流量阈值，如 40G/512M；纯数字按 GB；不设=关闭
//   traffic-stats.feishu.alert_cooldown      冷却秒数，默认 1800（30 分钟）
//
// 签名算法（官方）：key = timestamp + "\n" + secret，HMAC-SHA256 签空字节串，Base64。
//   测试向量：ts=1599360473, secret=demo -> l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=
//
// 设计要点：
//   * 绝不只看 HTTP 200：必须解析响应体 code，非 0 视为失败（19021/19024/11232 都是 200）。
//   * 卡片 2.0（schema=2.0，元素在 body.elements）；脚注用 div+plain_text（2.0 已移除 note）。
//   * 整个 POST body < 20 KB；超限按 Top 10 -> 8 -> 5 截断，再降图表密度。
//   * 可重试错误按 1 -> 5 -> 15 分钟退避，最多 3 次重试，队列在 /tmp（重启即丢，日报每天都有）。
//   * 告警同规则+同目标 30 分钟只发一次，状态在 /tmp/traffic-stats/alert-state.json。
//   * 日志在 /tmp/traffic-stats/feishu.log；不记录完整 webhook（防止泄露到日志）。

const fs = require("fs");

const VERSION       = "1.0.0";
const LIMIT_BODY    = 20480;                 // 飞书 webhook 请求体硬上限 20 KB
const DEFAULT_BASE  = "/tmp/traffic-stats";
const ONLINE_WINDOW = 600;                   // last_seen 在 10 分钟内算在线
const STALE_ALERT   = 180;                   // state.json 超过 3 分钟未更新 -> 采集异常告警
const STALE_REPORT  = 900;                   // 日报脚注提示阈值（15 分钟）
const ALERT_COOLDOWN = 1800;                 // 30 分钟冷却
const RETRY_DELAYS  = [60, 300, 900];        // 1 -> 5 -> 15 分钟
const MAX_RETRIES   = 3;                     // 首次失败后再重试 3 次
const LOG_MAX       = 524288;                // 512 KB 轮转

const SIGN_VECTOR = {
    ts: 1599360473,
    secret: "demo",
    expect: "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8="
};

let BASE = DEFAULT_BASE;
let LIMIT = LIMIT_BODY;            // 实际生效上限（测试可用 --limit 调整）
let _pid = 0;
let _seq = 0;
let _uci_cursor = null;
let _uci_broken = false;

// ucode 在函数定义处绑定标识符：先统一声明，再赋值为函数表达式。
let nowstr, today, run, shq, ensure_dir, getpid, read_json, write_atomic, log, jstr, jminify, num, intv, gb, fmt_bytes, cut, parse_size, tz_offset, hmac_sign, uci_get, bool_opt, load_cfg, send_allowed, device_key, device_label, device_bytes, top_nodes, collect, chart_points, overview_text, chart_element, table_element, footnote_element, build_card, prepare_daily, signed_body, code_help, http_post, parse_result, deliver, queue_dir, queue_count, enqueue, process_retries, script_path, spawn_worker, retry_worker, alert_state_path, read_alert_state, save_alert_state, allow_send, check_degraded, alert_text, send_text, cmd_alerts, gather_tags, check_card_json, cmd_daily, cmd_card, cmd_check, cmd_test, cmd_retry, cmd_status, cmd_selftest, cmd_sign, app_http, app_token, deliver_app, cmd_chats, usage, parse_args;

// ───────────────────────────── 基础工具 ─────────────────────────────

nowstr = function() {
    let r = run("date '+%Y-%m-%d %H:%M:%S'");
    let s = trim(r.out);
    return length(s) ? s : sprintf("@%d", time());
};

today = function() {
    let r = run("date +%F");
    let s = trim(r.out);
    return match(s, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) ? s : "";
};

// 执行命令并取回 stdout，返回 {code, out}（code 为进程退出码）
run = function(cmd) {
    let p = fs.popen(cmd, "r");
    if (!p)
        return { code: -1, out: "" };
    let out = "", buf = "";
    try {
        while (length(buf = p.read(4096)))
            out += buf;
    } catch (e) {
        // 读失败也要把子进程收掉
    }
    return { code: p.close(), out: out };
};

// 单引号 shell 转义（换行、$、反引号、双引号都会被安全包住）
shq = function(s) {
    return "'" + replace(sprintf("%s", s), "'", "'\\''") + "'";
};

ensure_dir = function(path) {
    if (!path || path == "." || path == "/")
        return true;
    if (fs.access(path))
        return true;
    return run("mkdir -p " + shq(path)).code == 0;
};

getpid = function() {
    if (!_pid) {
        _pid = intv(trim(run("echo $PPID").out));
        if (_pid <= 0)
            _pid = 1;
    }
    return _pid;
};

read_json = function(path) {
    try {
        if (!path || !fs.access(path))
            return null;
        let raw = fs.readfile(path);
        if (!length(raw))
            return null;
        return json(raw);
    } catch (e) {
        log("WARN", sprintf("读取/解析 %s 失败：%s", path, e));
        return null;
    }
};

write_atomic = function(path, content) {
    let tmp = sprintf("%s.tmp.%d.%d", path, getpid(), _seq++);
    try {
        fs.writefile(tmp, content);
        if (fs.rename(tmp, path))
            return true;
    } catch (e) {
        // fallthrough
    }
    try { fs.unlink(tmp); } catch (e) { }
    return false;
};

log = function(level, msg) {
    let line = sprintf("%s [%s] %s\n", nowstr(), level, msg);
    try {
        ensure_dir(BASE);
        let lp = BASE + "/feishu.log";
        if (fs.access(lp)) {
            let st = fs.stat(lp);
            if (st && st.size > LOG_MAX)
                fs.rename(lp, lp + ".1");
        }
        let fd = fs.open(lp, "a");
        if (fd) {
            fd.write(line);
            fd.close();
        } else {
            print(line);
        }
    } catch (e) {
        print(line);
    }
    // 关键日志同时进 syslog，方便 LuCI/命令行排查（日志文件本身在 tmpfs）
    if (level == "WARN" || level == "ERROR") {
        run(sprintf("logger -t traffic-stats-feishu -p daemon.%s %s 2>/dev/null",
            level == "ERROR" ? "err" : "warn",
            shq(sprintf("[%s] %s", level, msg))));
    }
};

jstr = function(o) {
    return jminify(sprintf("%J", o));
};

// ucode 的 %J 会插入空格（`{ "a": 1 }`），这里压成紧凑 JSON：
// 只在字符串外部删空白，字符串内部的空格/换行原样保留。
jminify = function(s) {
    let out = "", instr = false, esc = false;
    for (let i = 0; i < length(s); i++) {
        let c = substr(s, i, 1);
        if (instr) {
            out += c;
            if (esc)
                esc = false;
            else if (c == "\\")
                esc = true;
            else if (c == "\"")
                instr = false;
        } else if (c == "\"") {
            instr = true;
            out += c;
        } else if (c == " " || c == "\n" || c == "\r" || c == "\t") {
            // drop
        } else {
            out += c;
        }
    }
    return out;
};

num = function(v) {
    let t = type(v);
    if (t == "int" || t == "double")
        return v;
    if (t == "string") {
        v = trim(v);
        if (match(v, /^-?[0-9]+(\.[0-9]+)?$/))
            return v * 1.0;
    }
    return 0;
};

intv = function(v) {
    let n = num(v);
    if (type(n) != "int" && type(n) != "double")
        return 0;
    if (n != n)              // NaN
        return 0;
    return int(n);
};

gb = function(n) {
    n = num(n) / 1073741824.0;
    if (n <= 0)
        return 0;
    let p = n < 1 ? 1000 : 100;
    return int(n * p + 0.5) / (p * 1.0);
};

fmt_bytes = function(n) {
    n = num(n);
    if (n < 0)
        n = 0;
    let units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let u = 0, v = n * 1.0;
    while (v >= 1024 && u < length(units) - 1) {
        v = v / 1024.0;
        u++;
    }
    if (u == 0)
        return sprintf("%d B", int(v));
    if (v >= 100)
        return sprintf("%.0f %s", v, units[u]);
    if (v >= 10)
        return sprintf("%.1f %s", v, units[u]);
    return sprintf("%.2f %s", v, units[u]);
};

// 按字节截断，且不切断 UTF-8 码点；截断时补一个省略号
cut = function(s, maxb) {
    s = sprintf("%s", s);
    if (length(s) <= maxb)
        return s;
    let n = maxb - 3;
    if (n < 0)
        n = 0;
    while (n > 0) {
        let b = ord(substr(s, n, 1));
        if ((b & 0xc0) != 0x80)
            break;
        n--;
    }
    return substr(s, 0, n) + "…";
};

// 解析 "40G" / "512M" / "1.5T" / 纯数字（纯数字按 GB 处理）；0 表示不启用
parse_size = function(v) {
    v = trim(sprintf("%s", v == null ? "" : v));
    if (!length(v) || v == "0")
        return 0;
    let m = match(v, /^([0-9]+(\.[0-9]+)?)\s*([KMGTkmgt]?)B?$/);
    if (!m)
        return 0;
    let mult = { "": 1073741824, "k": 1024, "m": 1048576, "g": 1073741824, "t": 1099511627776 };
    return int(num(m[1]) * mult[lc(m[3] || "")]);
};

// 本地时区偏移（秒）；用 date +%z，避免依赖 ucode 的时区能力
tz_offset = function() {
    let s = trim(run("date +%z").out);
    if (!match(s, /^[+-][0-9]{4}$/))
        return 0;
    let sign = substr(s, 0, 1) == "-" ? -1 : 1;
    return sign * (intv(substr(s, 1, 2)) * 3600 + intv(substr(s, 3, 2)) * 60);
};

// ───────────────────────────── 签名 ─────────────────────────────

// key = ts + "\n" + secret；HMAC-SHA256 签空字节串；Base64
hmac_sign = function(ts, secret) {
    let key = sprintf("%s\n%s", ts, secret);
    // 主路径：-hmac 直接把 key 作为 argv（shq 保证特殊字符安全）
    let r = run(sprintf("openssl dgst -sha256 -hmac %s -binary < /dev/null | openssl base64 -A", shq(key)));
    let sig = trim(r.out);
    if (r.code == 0 && match(sig, /^[A-Za-z0-9+\/=]+$/))
        return sig;

    // 备用路径：hexkey（本机没有 od/base64 命令，hex 由 ucode 生成，base64 用 openssl）
    let hex = "";
    for (let i = 0; i < length(key); i++)
        hex += sprintf("%02x", ord(substr(key, i, 1)));
    r = run(sprintf("openssl dgst -sha256 -mac HMAC -macopt hexkey:%s -binary < /dev/null | openssl base64 -A", hex));
    sig = trim(r.out);
    if (r.code == 0 && match(sig, /^[A-Za-z0-9+\/=]+$/))
        return sig;

    log("ERROR", sprintf("签名计算失败：openssl rc=%d stderr=%s", r.code, cut(trim(r.out), 120)));
    return "";
};

// ───────────────────────────── UCI 配置 ─────────────────────────────

uci_get = function(key) {
    let parts = split(key, ".");
    if (!_uci_broken && !_uci_cursor) {
        try {
            _uci_cursor = require("uci").cursor();
        } catch (e) {
            _uci_broken = true;
            log("WARN", "ucode uci 模块不可用，回退到 uci 命令：" + e);
        }
    }
    if (_uci_cursor && length(parts) >= 3) {
        try {
            let v = _uci_cursor.get(parts[0], parts[1], parts[2]);
            if (v != null)
                return sprintf("%s", v);
            return "";
        } catch (e) {
            // fallback to command
        }
    }
    let r = run("uci -q get " + shq(key));
    return r.code == 0 ? trim(r.out) : "";
};

bool_opt = function(v, def) {
    v = trim(sprintf("%s", v == null ? "" : v));
    if (!length(v))
        return def;
    let l = lc(v);
    if (v == "0" || l == "false" || l == "no" || l == "off" || l == "disabled")
        return false;
    return true;
};

load_cfg = function(opts) {
    let c = {
        enabled: bool_opt(uci_get("traffic-stats.feishu.enabled"), true),
        webhook: trim(uci_get("traffic-stats.feishu.webhook")),
        app_id: trim(uci_get("traffic-stats.feishu.app_id")),
        app_secret: trim(uci_get("traffic-stats.feishu.app_secret")),
        chat_id: trim(uci_get("traffic-stats.feishu.chat_id")),
        card_wrapper: trim(uci_get("traffic-stats.feishu.card_wrapper")),
        secret: trim(uci_get("traffic-stats.feishu.secret")),
        daily_time: trim(uci_get("traffic-stats.feishu.daily_time")),
        alert_enabled: bool_opt(uci_get("traffic-stats.feishu.alert_enabled"), true),
        alert_new_device: bool_opt(uci_get("traffic-stats.feishu.alert_new_device"), true),
        device_limit: parse_size(uci_get("traffic-stats.feishu.device_daily_limit")),
        cooldown: ALERT_COOLDOWN,
        force: opts && opts.force ? true : false
    };
    if (!length(c.daily_time))
        c.daily_time = "08:30";
    if (!length(c.card_wrapper))
        c.card_wrapper = "card";
    let cd = intv(trim(uci_get("traffic-stats.feishu.alert_cooldown")));
    if (cd >= 60)
        c.cooldown = cd;
    if (opts) {
        if (opts.webhook != null)
            c.webhook = trim(opts.webhook);
        if (opts.secret != null)
            c.secret = trim(opts.secret);
        if (opts.device_limit != null)
            c.device_limit = parse_size(opts.device_limit);
    }
    return c;
};

// 空 webhook/secret -> 静默跳过（只记日志，不报错、不重试）
send_allowed = function(cfg, ignore_enabled) {
    /* 自建应用路线：只要三件套齐全就放行，不要求 webhook/secret */
    let app_mode = length(cfg.app_id) && length(cfg.app_secret) && length(cfg.chat_id);
    if (app_mode) {
        if (!ignore_enabled && !cfg.enabled && !cfg.force) {
            log("INFO", "traffic-stats.feishu.enabled=0，跳过发送（可用 --force 强制）");
            return false;
        }
        return true;
    }
    if (!length(cfg.webhook)) {
        log("INFO", "traffic-stats.feishu.webhook 未配置，跳过发送");
        return false;
    }
    if (!length(cfg.secret)) {
        log("INFO", "traffic-stats.feishu.secret 未配置，跳过发送（签名校验需要密钥）");
        return false;
    }
    if (!match(cfg.webhook, /^https?:\/\/[^\s"'\\]+$/)) {
        log("ERROR", "traffic-stats.feishu.webhook 格式非法，跳过发送");
        return false;
    }
    if (!ignore_enabled && !cfg.enabled && !cfg.force) {
        log("INFO", "traffic-stats.feishu.enabled=0，跳过发送（可用 --force 强制）");
        return false;
    }
    return true;
};

// ───────────────────────────── 数据采集 ─────────────────────────────

device_key = function(d) {
    let mac = trim(sprintf("%s", d.mac == null ? "" : d.mac));
    if (length(mac))
        return lc(mac);
    let ip = trim(sprintf("%s", d.ip == null ? "" : d.ip));
    if (length(ip))
        return ip;
    let h = trim(sprintf("%s", d.hostname == null ? "" : d.hostname));
    return length(h) ? h : "unknown";
};

device_label = function(d) {
    let h = trim(sprintf("%s", d.hostname == null ? "" : d.hostname));
    if (length(h))
        return h;
    let ip = trim(sprintf("%s", d.ip == null ? "" : d.ip));
    if (length(ip))
        return ip;
    let m = trim(sprintf("%s", d.mac == null ? "" : d.mac));
    return length(m) ? m : "未知设备";
};

device_bytes = function(d) {
    return {
        direct: num(d.direct_rx) + num(d.direct_tx),
        proxy: num(d.proxy_rx) + num(d.proxy_tx),
        total: num(d.direct_rx) + num(d.direct_tx) + num(d.proxy_rx) + num(d.proxy_tx)
    };
};

top_nodes = function(state, n) {
    let out = [];
    if (!state || type(state) != "object" || type(state.nodes) != "object")
        return out;
    let arr = [];
    for (let name in state.nodes) {
        if (name == "DIRECT")
            continue;
        let node = state.nodes[name];
        if (type(node) != "object")
            continue;
        let bytes = num(node.rx) + num(node.tx);
        if (bytes <= 0)
            continue;
        push(arr, { name: name, bytes: bytes });
    }
    sort(arr, function (a, b) { return b.bytes - a.bytes; });
    for (let i = 0; i < length(arr) && i < n; i++)
        push(out, sprintf("%s %s", cut(arr[i].name, 28), fmt_bytes(arr[i].bytes)));
    return out;
};

// 把 state.json / history.json 归一化成日报需要的结构
collect = function(state, hist, now) {
    let ctx = {
        day: today(),
        hist_day: "",
        now: now,
        has_state: false,
        has_totals: false,
        has_hours: false,
        has_data: false,
        state_age: -1,
        total: 0, proxy: 0, direct: 0,
        online: -1,
        devices: [],
        nodes: [],
        warnings: [],
        hours: [],
        first_hour: -1,
        last_hour: -1,
        fallback: [],
        confidence: ""
    };

    let used = false;
    let off = tz_offset();
    let hours = [];
    for (let i = 0; i < 24; i++)
        hours[i] = { total: 0, proxy: 0, direct: 0 };

    if (hist && type(hist) == "object") {
        if (type(hist.day) == "string" && length(hist.day))
            ctx.hist_day = hist.day;
        if (type(hist.buckets) == "array") {
            for (let b in hist.buckets) {
                if (type(b) != "object")
                    continue;
                let ts = intv(b.ts);
                if (ts <= 0)
                    continue;
                if (ts > 100000000000)          // 容错：毫秒时间戳
                    ts = int(ts / 1000);
                let h = int(((ts + off) % 86400) / 3600);
                if (h < 0) h = 0;
                if (h > 23) h = 23;
                let dr = num(b.direct_rx) + num(b.direct_tx);
                let pr = num(b.proxy_rx) + num(b.proxy_tx);
                hours[h].direct += dr;
                hours[h].proxy += pr;
                hours[h].total += dr + pr;
                used = true;
                if (ctx.first_hour < 0 || h < ctx.first_hour)
                    ctx.first_hour = h;
                if (h > ctx.last_hour)
                    ctx.last_hour = h;
            }
        }
    }
    ctx.hours = hours;
    ctx.has_hours = used;

    if (state && type(state) == "object") {
        ctx.has_state = true;
        let ts = intv(state.ts);
        if (ts > 100000000000)
            ts = int(ts / 1000);
        if (ts > 0)
            ctx.state_age = now - ts;

        let has_totals = (type(state.totals) == "object");
        ctx.has_totals = has_totals;
        let t = has_totals ? state.totals : {};
        ctx.direct = num(t.direct_rx) + num(t.direct_tx);
        ctx.proxy = num(t.proxy_rx) + num(t.proxy_tx);
        ctx.total = ctx.direct + ctx.proxy;

        if (type(state.devices) == "array") {
            for (let d in state.devices) {
                if (type(d) != "object")
                    continue;
                let b = device_bytes(d);
                push(ctx.devices, {
                    key: device_key(d),
                    label: device_label(d),
                    ip: trim(sprintf("%s", d.ip == null ? "" : d.ip)),
                    mac: trim(sprintf("%s", d.mac == null ? "" : d.mac)),
                    direct: b.direct,
                    proxy: b.proxy,
                    total: b.total,
                    last_seen: intv(d.last_seen)
                });
            }
            sort(ctx.devices, function (a, b) { return b.total - a.total; });
            let on = 0;
            for (let d in ctx.devices) {
                if (!d.last_seen || now - d.last_seen <= ONLINE_WINDOW)
                    on++;
            }
            ctx.online = on;
        }

        ctx.nodes = top_nodes(state, 3);

        let hp = (type(state.health) == "object") ? state.health : {};
        if (hp.accounting_confidence != null)
            ctx.confidence = trim(sprintf("%s", hp.accounting_confidence));
        if (length(ctx.confidence) && ctx.confidence != "exact")
            push(ctx.warnings, "采集置信度 " + ctx.confidence);
        let src = (type(state.source) == "object") ? state.source : {};
        if (src.clash != null && src.clash != "ok")
            push(ctx.warnings, "clash=" + src.clash);
        if (src.conntrack != null && src.conntrack != "ok")
            push(ctx.warnings, "conntrack=" + src.conntrack);
        if (type(hp.reasons) == "array" && length(hp.reasons)) {
            let rs = [];
            for (let r in hp.reasons)
                push(rs, type(r) == "string" ? r : jstr(r));
            push(ctx.warnings, "原因：" + cut(join("；", rs), 200));
        }
        if (ctx.state_age > STALE_REPORT)
            push(ctx.warnings, sprintf("state.json 已 %d 分钟未更新", int(ctx.state_age / 60)));
    } else if (used) {
        // 没有 state，只能用 history 求和
        for (let i = 0; i < 24; i++) {
            ctx.direct += hours[i].direct;
            ctx.proxy += hours[i].proxy;
            ctx.total += hours[i].total;
        }
        push(ctx.warnings, "state.json 缺失，设备明细与在线数不可用");
    }

    // totals 缺失时按设备汇总兜底
    if (!ctx.has_totals && length(ctx.devices)) {
        let dsum = 0, psum = 0;
        for (let d in ctx.devices) {
            dsum += d.direct;
            psum += d.proxy;
        }
        ctx.direct = dsum;
        ctx.proxy = psum;
        ctx.total = dsum + psum;
        push(ctx.warnings, "totals 缺失，按设备汇总");
    }

    if (!ctx.has_hours && ctx.total > 0) {
        let h = int(((now + off) % 86400) / 3600);
        push(ctx.fallback, {
            t: sprintf("%02d:00", h),
            total: gb(ctx.total),
            proxy: gb(ctx.proxy),
            direct: gb(ctx.direct)
        });
        push(ctx.warnings, "history.json 缺失，趋势只有当前累计点");
    }

    ctx.has_data = used || (ctx.has_state && (ctx.total > 0 || length(ctx.devices)));
    return ctx;
};

chart_points = function(ctx, step) {
    if (!ctx.has_hours)
        return ctx.fallback;
    let pts = [];
    let lo = int(ctx.first_hour / step) * step;
    let hi = int(ctx.last_hour / step) * step;
    for (let h = lo; h <= hi; h += step) {
        let a = { total: 0, proxy: 0, direct: 0 };
        for (let k = 0; k < step && h + k < 24; k++) {
            a.total += ctx.hours[h + k].total;
            a.proxy += ctx.hours[h + k].proxy;
            a.direct += ctx.hours[h + k].direct;
        }
        push(pts, {
            t: sprintf("%02d:00", h),
            total: gb(a.total),
            proxy: gb(a.proxy),
            direct: gb(a.direct)
        });
    }
    return pts;
};

// ───────────────────────────── 卡片构造（JSON 2.0） ─────────────────────────────

overview_text = function(ctx) {
    let s = "";
    s += sprintf("**总流量**：%s\n", fmt_bytes(ctx.total));
    s += sprintf("**代理流量**：%s", fmt_bytes(ctx.proxy));
    if (length(ctx.nodes))
        s += sprintf("（Top3：%s）", join(" · ", ctx.nodes));
    s += "\n";
    s += sprintf("**直连流量**：%s\n", fmt_bytes(ctx.direct));
    if (ctx.online >= 0)
        s += sprintf("**在线设备**：%d 台", ctx.online);
    else
        s += "**在线设备**：—（state.json 缺失）";
    return s;
};

chart_element = function(ctx, step) {
    let vals = [];
    for (let p in chart_points(ctx, step)) {
        push(vals, { t: p.t, k: "总流量", v: p.total });
        push(vals, { t: p.t, k: "代理", v: p.proxy });
        push(vals, { t: p.t, k: "直连", v: p.direct });
    }
    return {
        "tag": "chart",
        "aspect_ratio": "16:9",
        "color_theme": "brand",
        "chart_spec": {
            "type": "line",
            "title": { "text": "近 24h 流量 (GB)" },
            "data": { "values": vals },
            "xField": "t",
            "yField": "v",
            "seriesField": "k"
        }
    };
};

table_element = function(ctx, top_n) {
    let rows = [];
    for (let i = 0; i < length(ctx.devices) && i < top_n; i++) {
        let d = ctx.devices[i];
        push(rows, {
            host: cut(d.label, 48),
            direct: fmt_bytes(d.direct),
            proxy: fmt_bytes(d.proxy),
            total: fmt_bytes(d.total)
        });
    }
    return {
        "tag": "table",
        "page_size": 10,
        "row_height": "low",
        "freeze_first_column": true,
        "header_style": { bold: true, background_style: "grey", text_size: "normal" },
        "columns": [
            { name: "host", display_name: "设备", data_type: "text" },
            { name: "direct", display_name: "直连", data_type: "text" },
            { name: "proxy", display_name: "代理", data_type: "text" },
            { name: "total", display_name: "合计", data_type: "text" }
        ],
        "rows": rows
    };
};

footnote_element = function(ctx) {
    let parts = [];
    if (ctx.has_hours)
        push(parts, sprintf("统计区间 %s %02d:00–%02d:00", ctx.hist_day || ctx.day, ctx.first_hour, ctx.last_hour));
    else
        push(parts, "统计区间：无分时数据");
    push(parts, "数据源 state.json/history.json");
    if (length(ctx.confidence))
        push(parts, "置信度 " + ctx.confidence);
    if (length(ctx.warnings))
        push(parts, "注意：" + join("；", ctx.warnings));
    push(parts, "由 traffic-stats 自动生成");
    return {
        "tag": "div",
        "margin": "8px 0px 0px 0px",
        "text": {
            "tag": "plain_text",
            "content": cut(join(" · ", parts), 600),
            "text_size": "notation",
            "text_color": "grey"
        }
    };
};

build_card = function(ctx, top_n, step) {
    let elements = [];
    push(elements, { "tag": "markdown", "content": overview_text(ctx) });
    push(elements, chart_element(ctx, step));
    push(elements, table_element(ctx, top_n));
    push(elements, footnote_element(ctx));

    return {
        "schema": "2.0",
        "config": { "update_multi": true, "width_mode": "fill" },
        "header": {
            "template": "blue",
            "title": {
                "tag": "plain_text",
                "content": "流量日报 " + ctx.day
            },
            "subtitle": {
                "tag": "plain_text",
                "content": "OpenWrt 流量统计 · 自动生成"
            }
        },
        "body": {
            "direction": "vertical",
            "padding": "12px",
            "elements": elements
        }
    };
};

// 生成日报：先按 Top 10/8/5 截断，再降图表密度；整个请求体必须 < 20 KB
prepare_daily = function(ctx, cfg) {
    let ts = sprintf("%d", time());
    let sign = length(cfg.secret) ? hmac_sign(ts, cfg.secret) : "";
    let tops = [10, 8, 5];
    let steps = [1, 2, 4, 6];
    let tried = [];

    for (let i = 0; i < length(tops); i++) {
        let card = build_card(ctx, tops[i], 1);
        let body = signed_body(cfg, { "msg_type": "interactive", "card": card }, ts, sign);
        let bytes = length(body);
        if (bytes < LIMIT)
            return { card: card, body: body, bytes: bytes, top: tops[i], step: 1, ts: ts, sign: sign };
        push(tried, sprintf("top=%d/step=1:%dB", tops[i], bytes));
    }
    for (let i = 0; i < length(steps); i++) {
        let card = build_card(ctx, 5, steps[i]);
        let body = signed_body(cfg, { "msg_type": "interactive", "card": card }, ts, sign);
        let bytes = length(body);
        if (bytes < LIMIT)
            return { card: card, body: body, bytes: bytes, top: 5, step: steps[i], ts: ts, sign: sign };
        push(tried, sprintf("top=5/step=%dh:%dB", steps[i], bytes));
    }
    log("ERROR", "卡片体积无法压到 20 KB 以内：" + join(", ", tried));
    return null;
};

signed_body = function(cfg, req, ts, sign) {
    let o = {};
    if (length(cfg.secret)) {
        o.timestamp = ts;
        o.sign = sign;
    }
    for (let k in req)
        o[k] = req[k];
    return jstr(o);
};

// ───────────────────────────── 发送与错误判定 ─────────────────────────────

code_help = function(code) {
    code = intv(code);
    if (code == 0) return "成功";
    if (code == 19021) return "签名错误或时间戳超过 1 小时（检查密钥与 NTP 校时）";
    if (code == 19022) return "出口 IP 不在白名单";
    if (code == 19024) return "消息未命中自定义关键词";
    if (code == 11232) return "飞书系统限流（整点/半点高发），稍后重试";
    if (code == 9499) return "请求体格式错误或超过 20 KB";
    if (code == 99991400) return "触发频率限制（HTTP 429）";
    if (code == 230020) return "触发频率限制";
    if (code == 230025) return "消息体超长";
    if (code == 230099) return "卡片内容非法（子码见响应）";
    if (code == -5) return "tenant_access_token 获取失败（检查 app_id/app_secret）";
    if (code == -6) return "未配置 app_id/app_secret";
    if (code == -7) return "未配置 chat_id（先运行 chats 列群）";
    return "未知错误";
};

http_post = function(url, body) {
    let dir = BASE + "/tmp";
    if (!ensure_dir(dir))
        return { http: 0, curl: -1, body: "", err: "无法创建临时目录 " + dir };

    let tag = sprintf("%d-%d-%d", time(), getpid(), _seq++);
    let bf = sprintf("%s/body-%s.json", dir, tag);
    let rf = sprintf("%s/resp-%s.json", dir, tag);
    let ef = sprintf("%s/err-%s.txt", dir, tag);
    let cf = sprintf("%s/curl-%s.conf", dir, tag);

    // curl 配置文件避免把 webhook/路径拼进 shell；data-binary 保证字节不被改动
    let conf = sprintf(
        "url = \"%s\"\n" +
        "request = \"POST\"\n" +
        "header = \"Content-Type: application/json\"\n" +
        "silent\n" +
        "show-error\n" +
        "connect-timeout = 8\n" +
        "max-time = 25\n" +
        "data-binary = \"@%s\"\n" +
        "output = \"%s\"\n" +
        "write-out = \"%%{http_code}\"\n", url, bf, rf);

    try {
        fs.writefile(bf, body);
        fs.writefile(cf, conf);
    } catch (e) {
        return { http: 0, curl: -1, body: "", err: "写临时文件失败：" + e };
    }

    let r = run(sprintf("curl -sS -K %s 2>%s", shq(cf), shq(ef)));
    let http = intv(trim(r.out));
    let resp = "", err = "";
    try { if (fs.access(rf)) resp = fs.readfile(rf); } catch (e) { }
    try { if (fs.access(ef)) err = trim(fs.readfile(ef)); } catch (e) { }
    try {
        fs.unlink(bf);
        fs.unlink(cf);
        fs.unlink(rf);
        fs.unlink(ef);
    } catch (e) { }
    return { http: http, curl: r.code, body: resp, err: err };
};

// 判成功必须 code==0（HTTP 200 不代表成功）
parse_result = function(r) {
    let code = -1, msg = "", j = null;
    if (length(r.body)) {
        try { j = json(r.body); } catch (e) { j = null; }
    }
    if (j != null && type(j) == "object") {
        if (j.code != null)
            code = intv(j.code);
        if (j.msg != null)
            msg = trim(sprintf("%s", j.msg));
    }
    if (r.curl != 0) {
        code = -1;
        msg = length(r.err) ? r.err : sprintf("curl exit %d", r.curl);
    } else if (code == -1) {
        msg = sprintf("HTTP %s 响应不是 JSON：%s", r.http, cut(r.body, 120));
    }

    let ok = (r.curl == 0 && r.http == 200 && code == 0);
    let retryable = false;
    if (!ok) {
        if (r.curl != 0)
            retryable = true;                       // DNS/连接/超时/TLS
        else if (r.http == 429 || r.http >= 500)
            retryable = true;
        else if (code == 11232 || code == 99991400 || code == 230020)
            retryable = true;
    }
    return { ok: ok, code: code, http: r.http, msg: msg, retryable: retryable, curl: r.curl, bytes: 0 };
};

/* ============================================================
 * 自建应用路线（app_id / app_secret / chat_id）
 *   机器人用二维码加进群，发消息走 tenant_access_token
 *   - token: POST /open-apis/auth/v3/tenant_access_token/internal（缓存到 BASE/tmp）
 *   - 发送: POST /open-apis/im/v1/messages?receive_id_type=chat_id
 *   - 群列表: GET /open-apis/im/v1/chats
 * ============================================================ */
app_http = function(method, url, bearer, body) {
    let dir = BASE + "/tmp";
    if (!ensure_dir(dir))
        return { http: 0, curl: -1, body: "", err: "无法创建临时目录 " + dir };
    let tag = sprintf("%d-%d-%d", time(), getpid(), _seq++);
    let bf = sprintf("%s/abody-%s.json", dir, tag);
    let rf = sprintf("%s/aresp-%s.json", dir, tag);

    let cmd = sprintf("curl -sS -X %s", method);
    if (length(bearer))
        cmd += sprintf(" -H %s", shq("Authorization: Bearer " + bearer));
    if (length(body)) {
        try { fs.writefile(bf, body); } catch (e) {
            return { http: 0, curl: -1, body: "", err: "写请求体失败：" + e };
        }
        cmd += sprintf(" -H %s", shq("Content-Type: application/json"));
        cmd += sprintf(" --data-binary %s", shq("@" + bf));
    }
    cmd += sprintf(" -o %s -w '%%{http_code}' --connect-timeout 8 --max-time 25 %s 2>/dev/null",
                   shq(rf), shq(url));

    let r = run(cmd);
    let http = intv(trim(r.out));
    let resp = "";
    try { if (fs.access(rf)) resp = fs.readfile(rf); } catch (e) { }
    try { fs.unlink(bf); } catch (e) { }
    try { fs.unlink(rf); } catch (e) { }
    return { http: http, curl: r.code, body: resp, err: length(resp) ? "" : "curl exit " + r.code };
};

app_token = function(cfg, force) {
    let cp = BASE + "/tmp/feishu-token.json";
    let now = time();
    if (!force) {
        let c = read_json(cp);
        if (c != null && type(c) == "object" && c.app_id == cfg.app_id &&
            intv(c.expire) > now + 120 && length(c.token))
            return c.token;
    }
    let body = sprintf('%J', { app_id: cfg.app_id, app_secret: cfg.app_secret });
    let r = app_http("POST", "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", "", body);
    let j = null;
    try { if (length(r.body)) j = json(r.body); } catch (e) { j = null; }
    let tok = (j != null && type(j) == "object" && j.tenant_access_token != null) ? j.tenant_access_token : "";
    let exp = (j != null && type(j) == "object" && j.expire != null) ? intv(j.expire) : 7200;
    if (!length(tok)) {
        log("ERROR", sprintf("tenant_access_token 获取失败 http=%d body=%s", r.http, cut(r.body, 200)));
        return "";
    }
    write_atomic(cp, sprintf('%J', { app_id: cfg.app_id, token: tok, expire: now + exp }));
    return tok;
};

deliver_app = function(cfg, req) {
    if (!length(cfg.app_id) || !length(cfg.app_secret))
        return { ok: false, retryable: false, code: -6, http: 0, msg: "未配置 app_id/app_secret", bytes: 0 };
    if (!length(cfg.chat_id))
        return { ok: false, retryable: false, code: -7, http: 0, msg: "未配置 chat_id（先跑 feishu.uc chats 列群）", bytes: 0 };
    let tok = app_token(cfg);
    if (!length(tok))
        return { ok: false, retryable: true, code: -5, http: 0, msg: "tenant_access_token 获取失败", bytes: 0 };
    let content;
    if (req.msg_type == "interactive")
        content = (cfg.card_wrapper == "bare") ? req.card : { type: "card", data: req.card };
    else
        content = req.content;
    let body = sprintf('%J', {
        receive_id: cfg.chat_id,
        msg_type: req.msg_type,
        content: sprintf('%J', content)
    });
    let bytes = length(body);
    if (bytes >= LIMIT)
        return { ok: false, retryable: false, code: -4, http: 0, msg: sprintf("请求体 %d 字节超过 %d 上限", bytes, LIMIT), bytes: bytes };
    let res = parse_result(app_http("POST",
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", tok, body));
    res.bytes = bytes;
    return res;
};

cmd_chats = function(opts) {
    let cfg = load_cfg(opts);
    if (!length(cfg.app_id) || !length(cfg.app_secret)) {
        print("请先配置 app_id / app_secret：\n  uci set traffic-stats.feishu.app_id=cli_xxx\n  uci set traffic-stats.feishu.app_secret=xxx\n  uci commit traffic-stats\n");
        return 2;
    }
    let tok = app_token(cfg);
    if (!length(tok)) {
        print("tenant_access_token 获取失败：检查 app_id/app_secret 与出网\n");
        return 2;
    }
    let r = app_http("GET", "https://open.feishu.cn/open-apis/im/v1/chats?page_size=50", tok, "");
    let j = null;
    try { j = json(r.body); } catch (e) { j = null; }
    if (j == null || type(j) != "object" || intv(j.code) != 0) {
        print(sprintf("查询群列表失败：HTTP %d %s\n", r.http, cut(r.body, 200)));
        return 2;
    }
    let items = (j.data != null && j.data.items != null) ? j.data.items : [];
    if (!length(items)) {
        print("机器人还没有被加入任何群。请先把机器人拉进群（扫码或搜索应用名）。\n");
        return 3;
    }
    for (let it in items)
        printf("%s\t%s\n", it.chat_id, it.name);
    return 0;
};

deliver = function(cfg, req) {
    /* 配了自建应用三件套就走 API，否则回落到群机器人 webhook */
    if (length(cfg.app_id) && length(cfg.app_secret) && length(cfg.chat_id))
        return deliver_app(cfg, req);
    let ts = sprintf("%d", time());
    let sign = length(cfg.secret) ? hmac_sign(ts, cfg.secret) : "";
    if (length(cfg.secret) && !length(sign))
        return { ok: false, retryable: false, code: -3, http: 0, msg: "签名计算失败（openssl 不可用？）", bytes: 0 };
    let body = signed_body(cfg, req, ts, sign);
    let bytes = length(body);
    if (bytes >= LIMIT)
        return { ok: false, retryable: false, code: -4, http: 0, msg: sprintf("请求体 %d 字节超过 %d 上限", bytes, LIMIT), bytes: bytes };
    let res = parse_result(http_post(cfg.webhook, body));
    res.bytes = bytes;
    return res;
};

// ───────────────────────────── 重试队列 ─────────────────────────────

queue_dir = function() {
    return BASE + "/feishu-queue";
};

enqueue = function(req, desc) {
    if (!ensure_dir(queue_dir())) {
        log("ERROR", "无法创建重试队列目录 " + queue_dir());
        return "";
    }
    let ts = time();
    let e = {
        "v": 1,
        "desc": desc,
        "req": req,
        "attempts": 1,
        "created": ts,
        "next_at": ts + RETRY_DELAYS[0]
    };
    let p = sprintf("%s/q-%d-%d-%d.json", queue_dir(), ts, getpid(), _seq++);
    if (!write_atomic(p, jstr(e))) {
        log("ERROR", "写重试队列失败：" + p);
        return "";
    }
    log("WARN", sprintf("已排队重试（%d 秒后第 1 次，最多 %d 次）：%s", RETRY_DELAYS[0], MAX_RETRIES, desc));
    return p;
};

process_retries = function(cfg, force) {
    let dir = queue_dir();
    if (!fs.access(dir))
        return 0;

    // 回收崩溃/被杀进程留下的 .processing 条目（10 分钟后仍无人处理就放回队列）
    let stale = fs.lsdir(dir);
    if (type(stale) == "array") {
        for (let f in stale) {
            if (!match(f, /^q-.*\.json\.processing$/))
                continue;
            let cp = dir + "/" + f;
            let st = fs.stat(cp);
            if (st && time() - st.mtime > 600) {
                let back = substr(cp, 0, length(cp) - length(".processing"));
                if (fs.rename(cp, back))
                    log("WARN", "回收超时的重试条目：" + back);
            }
        }
    }

    let files = fs.lsdir(dir);
    if (type(files) != "array")
        return 0;
    sort(files);
    let pending = 0;

    for (let f in files) {
        if (!match(f, /^q-.*\.json$/))
            continue;
        let p = dir + "/" + f;
        let e = read_json(p);
        if (e == null || type(e) != "object" || type(e.req) != "object") {
            if (!fs.access(p))
                continue;               // 已被其他进程认领，不是损坏
            log("WARN", "丢弃损坏的重试条目：" + p);
            try { fs.unlink(p); } catch (x) { }
            continue;
        }
        if (!force && intv(e.next_at) > time()) {
            pending++;
            continue;
        }

        // 先改名认领，避免 daily 与后台 worker 同时处理同一条
        let claim = p + ".processing";
        if (!fs.rename(p, claim))
            continue;
        e = read_json(claim);
        if (e == null || type(e) != "object" || type(e.req) != "object") {
            try { fs.unlink(claim); } catch (x) { }
            continue;
        }

        let attempts = intv(e.attempts);
        let res = deliver(cfg, e.req);
        if (res.ok) {
            try { fs.unlink(claim); } catch (x) { }
            log("INFO", sprintf("重试成功（第 %d 次尝试，%d 字节）：%s", attempts + 1, res.bytes, e.desc));
        } else {
            log("WARN", sprintf("重试失败（第 %d 次尝试）：http=%s code=%s %s（%s）",
                attempts + 1, res.http, res.code, res.msg, code_help(res.code)));
            if (res.retryable && attempts < MAX_RETRIES) {
                e.attempts = attempts + 1;
                e.next_at = time() + RETRY_DELAYS[e.attempts - 1];
                if (write_atomic(claim, jstr(e)) && fs.rename(claim, p)) {
                    pending++;
                } else {
                    log("ERROR", "回写重试条目失败，保留为 " + claim);
                    pending++;
                }
            } else {
                try { fs.unlink(claim); } catch (x) { }
                log("ERROR", sprintf("放弃重试（%s）：%s",
                    res.retryable ? "重试次数用尽" : "错误不可重试：" + code_help(res.code), e.desc));
            }
        }
        sleep(200);                 // 远离 5 次/秒
    }
    return pending;
};

script_path = function() {
    try {
        let raw = fs.readfile("/proc/self/cmdline");
        if (!length(raw))
            return "";
        let parts = split(raw, "\0");
        for (let i = 1; i < length(parts); i++) {
            if (match(parts[i], /\.uc$/)) {
                if (match(parts[i], /^\//))
                    return parts[i];
                let cwd = "";
                try { cwd = fs.getcwd(); } catch (e) { }
                return length(cwd) ? cwd + "/" + parts[i] : parts[i];
            }
        }
    } catch (e) { }
    return "";
};

spawn_worker = function() {
    if (!fs.access(queue_dir()))
        return false;
    let self = script_path();
    if (!length(self)) {
        log("WARN", "无法定位自身路径，后台重试进程未启动；下次 daily/alerts 会继续处理队列");
        return false;
    }
    let lock = BASE + "/feishu-retry.lock";
    let inner = sprintf("flock -n %s ucode %s _retry-worker", shq(lock), shq(self));
    if (BASE != DEFAULT_BASE)
        inner += sprintf(" --base %s", shq(BASE));
    system(sprintf("setsid /bin/sh -c %s </dev/null >/dev/null 2>&1 &", shq(inner)));
    log("INFO", "已启动后台重试进程");
    return true;
};

retry_worker = function() {
    let deadline = time() + 1200;        // 覆盖最长 15 分钟退避
    log("INFO", "后台重试进程启动");
    while (time() <= deadline) {
        let cfg = load_cfg({});
        if (!length(cfg.webhook) || !length(cfg.secret)) {
            log("WARN", "重试进程：webhook/secret 未配置，退出");
            break;
        }
        let pending = process_retries(cfg, false);
        if (pending <= 0)
            break;
        sleep(20000);
    }
    log("INFO", "后台重试进程退出");
    return 0;
};

// ───────────────────────────── 告警 ─────────────────────────────

alert_state_path = function() {
    return BASE + "/alert-state.json";
};

read_alert_state = function() {
    let o = read_json(alert_state_path());
    let first = (o == null || type(o) != "object");
    if (first)
        o = {};
    if (type(o.devices) != "object")
        o.devices = {};
    if (type(o.cooldown) != "object")
        o.cooldown = {};
    o.version = 1;
    o._first = first;
    return o;
};

save_alert_state = function(o) {
    if (o._first != null)
        delete o._first;
    o.updated = time();
    return write_atomic(alert_state_path(), jstr(o));
};

// 同规则同目标冷却窗口内只允许一次
allow_send = function(o, key, now, cd) {
    let last = intv(o.cooldown[key]);
    if (last > 0 && now - last < cd)
        return false;
    o.cooldown[key] = now;
    return true;
};

check_degraded = function(state, now) {
    if (state == null || type(state) != "object")
        return { lines: ["state.json 缺失（守护进程未运行或尚未生成）"] };

    let lines = [];
    let ts = intv(state.ts);
    if (ts > 100000000000)
        ts = int(ts / 1000);
    if (ts <= 0)
        push(lines, "state.json 缺少 ts 字段");
    else if (now - ts > STALE_ALERT)
        push(lines, sprintf("state.json 已 %d 分钟未更新", int((now - ts) / 60)));

    let src = (type(state.source) == "object") ? state.source : {};
    if (src.clash != null && src.clash != "ok")
        push(lines, "clash 采集：" + src.clash);
    if (src.conntrack != null && src.conntrack != "ok")
        push(lines, "conntrack 采集：" + src.conntrack);

    let hp = (type(state.health) == "object") ? state.health : {};
    if (hp.accounting_confidence != null && hp.accounting_confidence != "exact")
        push(lines, "accounting_confidence：" + hp.accounting_confidence);
    if (type(hp.reasons) == "array" && length(hp.reasons)) {
        let rs = [];
        for (let r in hp.reasons)
            push(rs, type(r) == "string" ? r : jstr(r));
        push(lines, "原因：" + cut(join("；", rs), 240));
    }
    return length(lines) ? { lines: lines } : null;
};

alert_text = function(title, lines) {
    let s = "【流量告警】" + title + "\n";
    for (let l in lines)
        s += sprintf("%s\n", l);
    s += "时间：" + nowstr();
    return s;
};

send_text = function(cfg, text, desc) {
    let req = { "msg_type": "text", "content": { "text": text } };
    let res = deliver(cfg, req);
    if (res.ok) {
        log("INFO", sprintf("告警已发送（%d 字节）：%s", res.bytes, desc));
    } else {
        log("WARN", sprintf("告警发送失败：http=%s code=%s %s（%s）", res.http, res.code, res.msg, desc));
        if (res.retryable)
            enqueue(req, desc);
    }
    return res;
};

cmd_alerts = function(opts) {
    let cfg = load_cfg(opts);
    if (!cfg.enabled && !cfg.force) {
        log("INFO", "feishu.enabled=0，跳过告警（可用 --force 强制）");
        return 0;
    }
    if (!cfg.alert_enabled) {
        log("INFO", "告警未启用（alert_enabled=0），跳过");
        return 0;
    }
    if (!send_allowed(cfg))
        return 0;

    let now = time();
    let state = read_json(opts.state || (BASE + "/state.json"));
    let o = read_alert_state();
    let first = o._first;
    let sent = 0, skipped = 0;

    // 1) 服务异常 / 采集降级
    let deg = check_degraded(state, now);
    if (deg) {
        if (allow_send(o, "degraded:service", now, cfg.cooldown)) {
            if (send_text(cfg, alert_text("采集异常/降级", deg.lines), "alert/degraded").ok)
                sent++;
        } else {
            skipped++;
        }
    }

    // 2) 新设备上线（首次运行只建立基线，避免刷屏）
    if (state != null && type(state) == "object" && type(state.devices) == "array") {
        let online = [];
        for (let d in state.devices) {
            if (type(d) != "object")
                continue;
            let ls = intv(d.last_seen);
            if (ls > 0 && now - ls > ONLINE_WINDOW)
                continue;
            push(online, d);
        }
        if (first) {
            for (let d in online)
                o.devices[device_key(d)] = now;
            log("INFO", sprintf("告警基线初始化：记录 %d 台在线设备，本次不发送新设备告警", length(online)));
        } else if (cfg.alert_new_device) {
            for (let d in online) {
                let k = device_key(d);
                if (k in o.devices)
                    continue;
                if (!allow_send(o, "newdev:" + k, now, cfg.cooldown)) {
                    skipped++;
                    o.devices[k] = now;
                    continue;
                }
                let text = alert_text("新设备上线", [
                    sprintf("设备：%s", device_label(d)),
                    sprintf("标识：%s / %s", length(d.ip) ? d.ip : "?", length(d.mac) ? d.mac : "?")
                ]);
                if (send_text(cfg, text, "alert/new_device/" + k).ok)
                    sent++;
                o.devices[k] = now;
            }
        }
        for (let d in online)
            o.devices[device_key(d)] = now;
    }

    // 3) 设备日流量超限
    if (cfg.device_limit > 0 && state != null && type(state) == "object" && type(state.devices) == "array") {
        for (let d in state.devices) {
            if (type(d) != "object")
                continue;
            let b = device_bytes(d);
            if (b.total < cfg.device_limit)
                continue;
            let k = device_key(d);
            if (!allow_send(o, "limit:" + k, now, cfg.cooldown)) {
                skipped++;
                continue;
            }
            let text = alert_text("设备流量超限", [
                sprintf("设备：%s", device_label(d)),
                sprintf("今日流量：%s（阈值 %s）", fmt_bytes(b.total), fmt_bytes(cfg.device_limit))
            ]);
            if (send_text(cfg, text, "alert/limit/" + k).ok)
                sent++;
        }
    }

    // 清理 30 天未出现的设备和 1 天前的冷却记录
    let pruned = 0;
    for (let k in keys(o.devices)) {
        if (now - intv(o.devices[k]) > 30 * 86400) {
            delete o.devices[k];
            pruned++;
        }
    }
    for (let k in keys(o.cooldown)) {
        if (now - intv(o.cooldown[k]) > 86400)
            delete o.cooldown[k];
    }
    if (!save_alert_state(o))
        log("ERROR", "写告警状态失败：" + alert_state_path());

    log("INFO", sprintf("告警检查完成：发送 %d 条，冷却跳过 %d 条，清理陈旧设备 %d 台", sent, skipped, pruned));
    if (opts.webhook == null && queue_count() > 0)
        spawn_worker();
    return 0;
};

// ───────────────────────────── 卡片校验（离线） ─────────────────────────────

gather_tags = function(node, out) {
    if (type(node) == "array") {
        for (let x in node)
            gather_tags(x, out);
    } else if (type(node) == "object") {
        for (let k in node) {
            if (k == "tag" && type(node[k]) == "string")
                push(out, node[k]);
            else
                gather_tags(node[k], out);
        }
    }
};

check_card_json = function(raw) {
    let fails = 0;
    let msgs = [];
    let bytes = length(raw);

    let obj = null;
    try { obj = json(raw); } catch (e) {
        print(sprintf("  FAIL  JSON 解析失败：%s\n", e));
        return 1;
    }
    let card = obj;
    if (type(obj) == "object" && type(obj.card) == "object")
        card = obj.card;

    if (type(obj) == "object" && obj.msg_type == "interactive")
        push(msgs, "PASS  msg_type=interactive（Webhook 用 card 字段）");
    else {
        push(msgs, "WARN  顶层没有 msg_type=interactive（只校验 card 本身）");
    }

    if (type(card) == "object" && card.schema == "2.0")
        push(msgs, "PASS  schema=2.0");
    else {
        push(msgs, "FAIL  schema 不是 2.0");
        fails++;
    }

    let title = "";
    if (type(card) == "object" && type(card.header) == "object" && type(card.header.title) == "object")
        title = trim(sprintf("%s", card.header.title.content == null ? "" : card.header.title.content));
    if (match(title, /^流量日报 [0-9]{4}-[0-9]{2}-[0-9]{2}$/))
        push(msgs, "PASS  header.title = " + title);
    else {
        push(msgs, "FAIL  header.title 不是「流量日报 YYYY-MM-DD」：[" + title + "]");
        fails++;
    }

    let elements = [];
    if (type(card) == "object" && type(card.body) == "object" && type(card.body.elements) == "array")
        elements = card.body.elements;
    if (length(elements) >= 4)
        push(msgs, sprintf("PASS  body.elements 共 %d 个元素", length(elements)));
    else {
        push(msgs, "FAIL  body.elements 少于 4 个");
        fails++;
    }

    let tags = [];
    gather_tags(elements, tags);
    for (let want in ["markdown", "chart", "table", "div"]) {
        if (index(tags, want) >= 0)
            push(msgs, "PASS  含 " + want + " 组件");
        else {
            push(msgs, "FAIL  缺少 " + want + " 组件");
            fails++;
        }
    }
    if (index(tags, "note") < 0 && index(tags, "action") < 0)
        push(msgs, "PASS  不含 note/action（2.0 已移除）");
    else {
        push(msgs, "FAIL  含 note/action 组件（2.0 会报 200861）");
        fails++;
    }

    let chart = null, table = null, foot = null;
    for (let el in elements) {
        if (type(el) != "object")
            continue;
        if (el.tag == "chart")
            chart = el;
        else if (el.tag == "table")
            table = el;
        else if (el.tag == "div" && foot == null)
            foot = el;
    }

    if (chart != null && type(chart.chart_spec) == "object" && chart.chart_spec.type == "line")
        push(msgs, "PASS  chart: 原生折线图");
    else {
        push(msgs, "FAIL  chart 缺失或不是 line");
        fails++;
    }
    if (chart != null && type(chart.chart_spec) == "object" &&
        type(chart.chart_spec.data) == "object" && type(chart.chart_spec.data.values) == "array") {
        let vals = chart.chart_spec.data.values;
        let series = [];
        for (let v in vals) {
            if (type(v) == "object" && v.k != null && index(series, v.k) < 0)
                push(series, v.k);
        }
        if (length(vals) > 0 && length(series) == 3)
            push(msgs, sprintf("PASS  chart: %d 个点 / %d 条序列（总/代理/直连）", length(vals), length(series)));
        else {
            push(msgs, sprintf("FAIL  chart 数据异常（%d 点/%d 序列）", length(vals), length(series)));
            fails++;
        }
    } else {
        push(msgs, "FAIL  chart_spec.data.values 缺失");
        fails++;
    }

    if (table != null && table.page_size == 10)
        push(msgs, "PASS  table: page_size=10");
    else {
        push(msgs, "FAIL  table.page_size 不是 10");
        fails++;
    }
    let cols = [];
    if (table != null && type(table.columns) == "array") {
        for (let c in table.columns)
            if (type(c) == "object" && c.name != null)
                push(cols, c.name);
    }
    let col_ok = true;
    for (let want in ["host", "direct", "proxy", "total"]) {
        if (index(cols, want) < 0)
            col_ok = false;
    }
    if (col_ok)
        push(msgs, "PASS  table 列：host/direct/proxy/total");
    else {
        push(msgs, "FAIL  table 列缺失：" + join(",", cols));
        fails++;
    }
    if (table != null && type(table.rows) == "array") {
        if (length(table.rows) <= 10)
            push(msgs, sprintf("PASS  table 行数 %d（<=10）", length(table.rows)));
        else {
            push(msgs, "FAIL  table 行数超过 10");
            fails++;
        }
    }

    if (foot != null && type(foot.text) == "object" && foot.text.tag == "plain_text" &&
        foot.text.text_size == "notation")
        push(msgs, "PASS  脚注 div + plain_text(notation)");
    else {
        push(msgs, "FAIL  脚注结构不对（应为 div + plain_text notation）");
        fails++;
    }

    if (index(raw, "\"tag\":\"note\"") < 0 && index(raw, "\"tag\":\"action\"") < 0)
        push(msgs, "PASS  原文不含 \"tag\":\"note\"/\"tag\":\"action\"");
    else {
        push(msgs, "FAIL  原文出现 note/action 标签");
        fails++;
    }

    if (bytes < LIMIT_BODY)
        push(msgs, sprintf("PASS  字节数 %d < %d（%.1f%%）", bytes, LIMIT_BODY, bytes * 100.0 / LIMIT_BODY));
    else {
        push(msgs, sprintf("FAIL  字节数 %d 超过 %d", bytes, LIMIT_BODY));
        fails++;
    }

    for (let m in msgs)
        print("  " + m + "\n");
    print(sprintf("  结果：%s（%d 项失败），bytes=%d\n", fails ? "FAIL" : "PASS", fails, bytes));
    return fails ? 1 : 0;
};

// ───────────────────────────── 命令 ─────────────────────────────

cmd_daily = function(opts) {
    let cfg = load_cfg(opts);
    if (!cfg.enabled && !cfg.force) {
        log("INFO", "feishu.enabled=0，跳过日报");
        return 0;
    }
    // --dry-run 只生成卡片，不需要 webhook/secret，也不处理重试队列
    if (!opts.dry_run) {
        if (!send_allowed(cfg))
            return 0;
        process_retries(cfg, false);
    }

    let state_path = opts.state || (BASE + "/state.json");
    let hist_path = opts.history || (BASE + "/history.json");
    let state = read_json(state_path);
    let hist = read_json(hist_path);
    let ctx = collect(state, hist, time());

    if (!ctx.has_data) {
        log("WARN", sprintf("无可用数据（%s / %s），跳过日报", state_path, hist_path));
        print("feishu daily: 无数据，已跳过（详见 " + BASE + "/feishu.log）\n");
        return 0;
    }

    let prep = prepare_daily(ctx, cfg);
    if (prep == null) {
        log("ERROR", sprintf("日报卡片无法压到 %d 字节，放弃发送", LIMIT));
        print(sprintf("feishu daily: 卡片超过 %d 字节上限且无法压缩，已放弃\n", LIMIT));
        return 1;
    }
    if (prep.top < 10 || prep.step > 1)
        log("WARN", sprintf("卡片超限截断：Top=%d step=%dh bytes=%d", prep.top, prep.step, prep.bytes));
    log("INFO", sprintf("日报生成：day=%s bytes=%d top=%d step=%dh", ctx.day, prep.bytes, prep.top, prep.step));

    if (opts.dry_run) {
        let out = opts.card_out || "/tmp/card.json";
        let d = fs.dirname(out);
        if (length(d) && d != "." && d != "/")
            ensure_dir(d);
        if (!fs.writefile(out, prep.body)) {
            log("ERROR", "写卡片文件失败：" + out);
            return 1;
        }
        print(sprintf("feishu daily: dry-run 已写入 %s（%d 字节 / 上限 %d）\n", out, prep.bytes, LIMIT));
        return 0;
    }

    let res = deliver(cfg, { "msg_type": "interactive", "card": prep.card });
    res.bytes = prep.bytes;
    if (res.ok) {
        log("INFO", sprintf("日报发送成功：http=%s code=0 bytes=%d", res.http, res.bytes));
        print(sprintf("feishu daily: 发送成功（%d 字节，code=0）\n", res.bytes));
    } else {
        log("ERROR", sprintf("日报发送失败：http=%s code=%s %s（%s）", res.http, res.code, res.msg, code_help(res.code)));
        print(sprintf("feishu daily: 发送失败 code=%s（%s）\n", res.code, code_help(res.code)));
        if (res.retryable) {
            if (length(enqueue({ "msg_type": "interactive", "card": prep.card }, "daily/" + ctx.day)))
                if (opts.webhook == null)
                    spawn_worker();
        } else {
            log("WARN", "该错误不可重试（配置或内容问题），未入队");
        }
    }
    return res.ok ? 0 : 1;
};

cmd_card = function(opts) {
    let cfg = load_cfg(opts);
    let state_path = opts.state || (BASE + "/state.json");
    let hist_path = opts.history || (BASE + "/history.json");
    let ctx = collect(read_json(state_path), read_json(hist_path), time());
    if (!ctx.has_data) {
        print("feishu card: 无数据，未生成卡片\n");
        return 0;
    }
    let prep = prepare_daily(ctx, cfg);
    if (prep == null) {
        print(sprintf("feishu card: 卡片超过 %d 字节上限且无法压缩\n", LIMIT));
        return 1;
    }
    let out = opts.card_out || "/tmp/card.json";
    let d = fs.dirname(out);
    if (length(d) && d != "." && d != "/")
        ensure_dir(d);
    if (!fs.writefile(out, prep.body)) {
        print("feishu card: 写文件失败 " + out + "\n");
        return 1;
    }
    print(sprintf("feishu card: %s => %d 字节（上限 %d，占 %.1f%%），Top=%d，图表步长 %dh\n",
        out, prep.bytes, LIMIT, prep.bytes * 100.0 / LIMIT, prep.top, prep.step));
    if (prep.top < 10 || prep.step > 1)
        print(sprintf("  已截断：Top %d，图表 %d 小时/点\n", prep.top, prep.step));
    return 0;
};

cmd_check = function(opts) {
    let path = opts.path || "/tmp/card.json";
    if (!fs.access(path)) {
        print("feishu check: 文件不存在 " + path + "\n");
        return 1;
    }
    print("feishu check: " + path + "\n");
    return check_card_json(fs.readfile(path));
};

cmd_test = function(opts) {
    let cfg = load_cfg(opts);
    if (!send_allowed(cfg, true)) {
        print("feishu test: webhook/secret 未配置或格式非法，未发送\n");
        return 1;
    }
    let host = "";
    try { host = trim(fs.readfile("/proc/sys/kernel/hostname")); } catch (e) { }
    let text = sprintf("【流量告警】飞书推送连通性测试\n路由器：%s\n时间：%s",
        length(host) ? host : "OpenWrt", nowstr());
    if (length(opts.text))
        text = opts.text;
    let res = deliver(cfg, { "msg_type": "text", "content": { "text": text } });
    if (res.ok) {
        log("INFO", "连通性测试成功");
        print(sprintf("feishu test: 成功（HTTP %s，code=0，%d 字节）\n", res.http, res.bytes));
        return 0;
    }
    log("WARN", sprintf("连通性测试失败：http=%s code=%s %s", res.http, res.code, res.msg));
    print(sprintf("feishu test: 失败（HTTP %s，code=%s，%s）\n", res.http, res.code, code_help(res.code)));
    if (length(res.msg))
        print("  详情：" + cut(res.msg, 300) + "\n");
    return 1;
};

cmd_retry = function(opts) {
    let cfg = load_cfg(opts);
    if (!send_allowed(cfg))
        return 0;
    let pending = process_retries(cfg, opts.now);
    print(sprintf("feishu retry: 处理完成，剩余 %d 条待重试\n", pending));
    return 0;
};

cmd_status = function(opts) {
    let cfg = load_cfg(opts);
    let host = "";
    let m = match(cfg.webhook, /^https?:\/\/([^\/]+)/);
    if (m)
        host = m[1];
    print("feishu.uc " + VERSION + "\n");
    print(sprintf("  base      : %s\n", BASE));
    print(sprintf("  enabled   : %s\n", cfg.enabled ? "1" : "0"));
    print(sprintf("  webhook   : %s\n", length(cfg.webhook) ? ("已配置（" + host + "）") : "未配置"));
    print(sprintf("  secret    : %s\n", length(cfg.secret) ? "已配置" : "未配置"));
    print(sprintf("  daily_time: %s\n", cfg.daily_time));
    print(sprintf("  alert     : %s（新设备 %s，阈值 %s，冷却 %ds）\n",
        cfg.alert_enabled ? "开" : "关",
        cfg.alert_new_device ? "开" : "关",
        cfg.device_limit > 0 ? fmt_bytes(cfg.device_limit) : "未设置",
        cfg.cooldown));
    let q = 0;
    if (fs.access(queue_dir())) {
        let files = fs.lsdir(queue_dir());
        if (type(files) == "array") {
            for (let f in files)
                if (match(f, /^q-.*\.json$/))
                    q++;
        }
    }
    print(sprintf("  queue     : %d 条待重试（%s）\n", q, queue_dir()));
    let st = read_json(opts.state || (BASE + "/state.json"));
    if (st != null && type(st) == "object" && intv(st.ts) > 0)
        print(sprintf("  state.json: 存在（%d 秒前更新）\n", time() - intv(st.ts)));
    else
        print("  state.json: 缺失\n");
    return 0;
};

cmd_selftest = function() {
    let fails = 0;
    print("== 1. 签名测试向量（官方 ts=1599360473 / secret=demo）==\n");
    let got = hmac_sign(sprintf("%d", SIGN_VECTOR.ts), SIGN_VECTOR.secret);
    print("  期望: " + SIGN_VECTOR.expect + "\n");
    print("  实际: " + got + "\n");
    if (got == SIGN_VECTOR.expect) {
        print("  PASS  签名算法正确（key=timestamp+\\n+secret，签空串，Base64）\n");
    } else {
        print("  FAIL  签名不匹配\n");
        fails++;
    }

    print("== 2. 卡片结构（内置样例，不联网）==\n");
    let now = time();
    let state = {
        "ts": now - 5,
        "uptime": 36000,
        "source": { "clash": "ok", "conntrack": "ok" },
        "totals": {
            "direct_rx": 1234567890, "direct_tx": 1234567,
            "proxy_rx": 9876543210, "proxy_tx": 76543210,
            "rx_rate": 12500000, "tx_rate": 980000
        },
        "nodes": {
            "US2-HY2": { "rx": 8000000000, "tx": 60000000 },
            "JP1-Tokyo": { "rx": 3000000000, "tx": 20000000 },
            "HK-HKT": { "rx": 1000000000, "tx": 10000000 },
            "DIRECT": { "rx": 1234567890, "tx": 1234567 }
        },
        "devices": [],
        "health": { "accounting_confidence": "exact", "reasons": [], "conntrack_count": 1800 }
    };
    for (let i = 1; i <= 12; i++) {
        push(state.devices, {
            "ip": sprintf("192.168.100.%d", 100 + i),
            "mac": sprintf("dc:56:7b:89:fb:%02x", i),
            "hostname": "device-" + i,
            "direct_rx": i * 1000000, "direct_tx": i * 10000,
            "proxy_rx": i * 9000000, "proxy_tx": i * 90000,
            "rx_rate": 1000, "tx_rate": 100,
            "last_seen": now - 10
        });
    }
    let buckets = [];
    for (let i = 0; i < 48; i++) {
        push(buckets, {
            "ts": now - (48 - i) * 300,
            "direct_rx": 1000000 + i, "direct_tx": 10000,
            "proxy_rx": 9000000 + i, "proxy_tx": 90000
        });
    }
    let ctx = collect(state, { "day": today(), "buckets": buckets }, now);
    let prep = prepare_daily(ctx, { secret: SIGN_VECTOR.secret });
    if (prep == null) {
        print("  FAIL  无法生成卡片\n");
        return 1;
    }
    print(sprintf("  Top=%d step=%dh bytes=%d（样例总量 %s）\n",
        prep.top, prep.step, prep.bytes, fmt_bytes(ctx.total)));
    fails += check_card_json(signed_body({ secret: SIGN_VECTOR.secret }, { "msg_type": "interactive", "card": prep.card }, prep.ts, prep.sign));

    print("== 3. JSON 压缩器往返 ==\n");
    let sample = { "a": "x y", "b": "q\"z", "c": "\\", "d": "中文", "e": [1, 2, { "f": true }] };
    let mini = jstr(sample);
    let back = null;
    try { back = json(mini); } catch (e) { }
    if (back != null && jstr(back) == mini)
        print("  PASS  紧凑 JSON 可被重新解析且内容一致\n");
    else {
        print("  FAIL  紧凑 JSON 往返失败\n");
        fails++;
    }

    print(sprintf("\n自检结果：%s（%d 项失败）\n", fails ? "FAIL" : "PASS", fails));
    return fails ? 1 : 0;
};

cmd_sign = function(opts) {
    let ts = opts.sign_ts;
    let secret = opts.sign_secret;
    if (!length(ts) || secret == null) {
        print("用法: ucode feishu.uc sign <timestamp> <secret>\n");
        return 2;
    }
    let sig = hmac_sign(ts, secret);
    print(sig + "\n");
    return length(sig) ? 0 : 1;
};

usage = function() {
    print("feishu.uc " + VERSION + " — 飞书群机器人推送（日报 / 告警）\n\n");
    print("用法：\n");
    print("  ucode feishu.uc daily [--dry-run] [--out FILE]   生成并发送日报（--dry-run 只写文件）\n");
    print("  ucode feishu.uc card [--out FILE]               只生成日报卡片（默认 /tmp/card.json）\n");
    print("  ucode feishu.uc alerts                          扫描 state.json 并发送告警\n");
    print("  ucode feishu.uc test [--text TEXT]              发送连通性测试\n");
    print("  ucode feishu.uc selftest                        离线自检（签名向量 + 卡片结构）\n");
    print("  ucode feishu.uc check [FILE]                    校验卡片文件结构/体积\n");
    print("  ucode feishu.uc retry [--now]                   处理重试队列\n");
    print("  ucode feishu.uc status                          查看配置与队列\n");
    print("  ucode feishu.uc sign <timestamp> <secret>       打印签名（调试）\n\n");
    print("参数：--base DIR（默认 /tmp/traffic-stats）、--state FILE、--history FILE、\n");
    print("      --webhook URL、--secret SECRET（测试用，不写 UCI）、--force\n");
    return 0;
};

// ───────────────────────────── 入口 ─────────────────────────────

parse_args = function(argv) {
    let o = {
        cmd: "help",
        dry_run: false,
        force: false,
        now: false,
        base: "",
        state: "",
        history: "",
        card_out: "/tmp/card.json",
        limit: LIMIT_BODY,
        device_limit: null,
        webhook: null,
        secret: null,
        text: "",
        path: "",
        sign_ts: "",
        sign_secret: null
    };
    if (length(argv) == 0)
        return o;
    o.cmd = argv[0];
    for (let i = 1; i < length(argv); i++) {
        let a = argv[i];
        if (a == "--dry-run") {
            o.dry_run = true;
        } else if (a == "--force") {
            o.force = true;
        } else if (a == "--now") {
            o.now = true;
        } else if (a == "--base" && i + 1 < length(argv)) {
            o.base = argv[++i];
        } else if (a == "--state" && i + 1 < length(argv)) {
            o.state = argv[++i];
        } else if (a == "--history" && i + 1 < length(argv)) {
            o.history = argv[++i];
        } else if ((a == "--out" || a == "--card-out") && i + 1 < length(argv)) {
            o.card_out = argv[++i];
        } else if (a == "--limit" && i + 1 < length(argv)) {
            o.limit = intv(argv[++i]);
        } else if (a == "--device-limit" && i + 1 < length(argv)) {
            o.device_limit = argv[++i];
        } else if (a == "--webhook" && i + 1 < length(argv)) {
            o.webhook = argv[++i];
        } else if (a == "--secret" && i + 1 < length(argv)) {
            o.secret = argv[++i];
        } else if (a == "--text" && i + 1 < length(argv)) {
            o.text = argv[++i];
        } else if (a == "--help" || a == "-h") {
            o.cmd = "help";
        } else if (o.cmd == "sign") {
            if (!length(o.sign_ts))
                o.sign_ts = a;
            else if (o.sign_secret == null)
                o.sign_secret = a;
        } else if (o.cmd == "check" && !length(o.path)) {
            o.path = a;
        } else {
            print("未知参数：" + a + "\n");
        }
    }
    return o;
};

let opts = parse_args(ARGV);
if (length(opts.base) && match(opts.base, /^\/[A-Za-z0-9._\/-]+$/))
    BASE = opts.base;
if (opts.limit >= 1024)
    LIMIT = opts.limit;

let rc = 0;
if (opts.cmd == "daily")
    rc = cmd_daily(opts);
else if (opts.cmd == "card")
    rc = cmd_card(opts);
else if (opts.cmd == "alerts")
    rc = cmd_alerts(opts);
else if (opts.cmd == "test")
    rc = cmd_test(opts);
else if (opts.cmd == "selftest")
    rc = cmd_selftest();
else if (opts.cmd == "check")
    rc = cmd_check(opts);
else if (opts.cmd == "retry")
    rc = cmd_retry(opts);
else if (opts.cmd == "status")
    rc = cmd_status(opts);
else if (opts.cmd == "sign")
    rc = cmd_sign(opts);
else if (opts.cmd == "chats")
    rc = cmd_chats(opts);
else if (opts.cmd == "_retry-worker")
    rc = retry_worker();
else if (opts.cmd == "help" || opts.cmd == "--help")
    rc = usage();
else {
    print("未知命令：" + opts.cmd + "\n\n");
    rc = usage();
    rc = 2;
};
exit(rc);
