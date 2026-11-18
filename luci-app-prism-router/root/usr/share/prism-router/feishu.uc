#!/usr/bin/ucode
// feishu.uc — OpenWrt 棱镜路由插件的飞书群机器人推送模块
//
// 负责：日报卡片（JSON 2.0）生成 / 告警文本 / 签名 / 发送 / 失败重试 / 冷却去重
// 依赖：ucode（fs/uci/json 内建）、curl、sha256sum（busybox；缺失时回退 openssl dgst）
// 环境：iStoreOS 24.10（x86_64/musl）；没有 python3 / jq / node，也不使用它们。
//
// 用法（安装后位于 /usr/share/prism-router/feishu.uc，见 prism-router/Makefile）：
//   ucode feishu.uc daily                  # 立即生成并发送（忽略 report_time/报告模式）
//   ucode feishu.uc scheduled              # 按 report_mode/time/weekday 判定，到点才发
//   ucode feishu.uc daily --dry-run        # 只生成，写到 /tmp/card.json，不联网
//   ucode feishu.uc card [--out FILE]      # 同上（只生成卡片）
//   ucode feishu.uc alerts                 # 扫描 state.json，发送需要发的告警
//   ucode feishu.uc alerts --dry-run       # 只打印「将要发的告警」，不发、不写冷却
//   ucode feishu.uc test                   # 发送一条连通性测试
//   ucode feishu.uc selftest               # 离线自检：签名向量 + 卡片结构 + 调度/告警判定
//   ucode feishu.uc check [FILE]           # 校验已生成的卡片（默认 /tmp/card.json）
//   ucode feishu.uc retry [--now]          # 处理重试队列（--now 忽略到期时间）
//   ucode feishu.uc status                 # 查看配置/队列状态
//
// 定时调用（cron 示例，避开整点/半点以降低 11232 概率）：
//   # 日报 / 周报：推荐用 scheduled，它在模块内按 report_mode/report_time/report_weekday 判定，
//   #   同一个 cron 条目就能自动切换「每天」和「每周」；daily 则是手动强制发送（忽略时间）。
//   #   30 8 * * * ucode /usr/share/prism-router/feishu.uc scheduled
//   #
//   # daily 模式（每天 08:30）：
//   #   30 8 * * *   ucode /usr/share/prism-router/feishu.uc scheduled
//   # weekly 模式（report_weekday=1 即周一 08:30）：
//   #   30 8 * * 1   ucode /usr/share/prism-router/feishu.uc scheduled
//   # both 模式（每天 08:30；周一生效为「周报」标题）：
//   #   30 8 * * *   ucode /usr/share/prism-router/feishu.uc scheduled
//   #
//   #   路由器休眠/重启可能错过整分，可以每 5 分钟叫一次并给 10 分钟容错；
//   #   scheduled 会写 BASE/report-last.json 去重，窗口内不会重复发。
//   #   3,8,...,58 * * * *  ucode /usr/share/prism-router/feishu.uc scheduled --window 10
//   # 告警扫描：
//   #   3,13,23,33,43,53 * * * * ucode /usr/share/prism-router/feishu.uc alerts
//
// 常用参数：--base DIR（默认 /tmp/prism-router）、--state FILE、--history FILE、
//           --webhook URL、--secret SECRET（后两个仅用于测试，不写 UCI）、
//           --chat CHAT_ID（覆盖 prism-router.feishu.chat_id，仅本次运行）、
//           --force（忽略 feishu.enabled=0）、
//           --items LIST（临时覆盖 report_items，如 overview,top_apps）、
//           --at "YYYY-MM-DD HH:MM" / --epoch N（注入「现在」，用于判定与测试）、
//           --window N（分钟，scheduled 的到点容错）、--kind daily|weekly、
//           --daily-dir DIR（7 日均值来源，默认 /etc/prism-router/daily）
//
// 配置（UCI，section prism-router.feishu；全部可缺省，缺省即老行为）：
//   prism-router.feishu.enabled             0/1，默认 1（未设置时按启用处理）
//   prism-router.feishu.mode                webhook | app（默认 webhook）
//                                             webhook = 群自定义机器人 webhook（老路线）
//                                             app     = 自建应用 + 机器人（tenant_access_token）
//                                           该选项**缺省**时沿用旧行为：app_id/app_secret/chat_id
//                                           三件套齐全走应用，否则走 webhook（升级用户无感）。
//   prism-router.feishu.webhook             群机器人 webhook，空则静默跳过
//   prism-router.feishu.secret              签名密钥，空则静默跳过
//   prism-router.feishu.app_id              自建应用 App ID（cli_xxx），仅 mode=app 使用
//   prism-router.feishu.app_secret          自建应用 App Secret，仅存于 /etc/config（建议 chmod 600）
//   prism-router.feishu.chat_id             目标群 chat_id（oc_xxx）；可由「扫码绑定」得到
//   prism-router.feishu.daily_time          旧字段；report_time 未设时的兜底时间
//   prism-router.feishu.alert_enabled       告警总开关，默认 1
//   prism-router.feishu.alert_new_device    新设备上线告警，默认 1
//   prism-router.feishu.device_daily_limit  单设备日流量阈值，如 40G/512M；纯数字按 GB；不设=关闭
//   prism-router.feishu.alert_cooldown      同一规则同一目标冷却秒数，默认 1800（30 分钟）
//   ── 发什么（内容可配，按数组顺序渲染）──
//   prism-router.feishu.report_items        overview,proxy_direct,wifi_wired,top_devices,top_apps
//                                            可选：overview | proxy_direct | wifi_wired | system |
//                                            top_devices | top_apps | nodes，按书写顺序渲染；
//                                            写 'none' = 什么都不发；整项缺省 = 用上面的默认值
//                                            （老配置行为不变；UCI 里写空串等同未设置）。
//   ── 什么时候发 ──
//   prism-router.feishu.report_mode         daily | weekly | both（默认 daily）
//   prism-router.feishu.report_time         HH:MM（默认 08:30；未设则取 daily_time）
//   prism-router.feishu.report_weekday      1=周一 … 7=周日（默认 1，仅 weekly/both 用）
//   ── 什么情况下发（全部留空=关闭，行为与旧版一致）──
//   prism-router.feishu.alert_app_daily_limit  单个域名/应用日流量阈值，如 20G
//   prism-router.feishu.alert_spike_ratio      突增倍数：当前小时 > 近 7 日均值 × N
//   prism-router.feishu.alert_offline_min      设备离线超过 N 分钟告警
//   prism-router.feishu.alert_cpu_pct          软路由 CPU 超过 N% 告警（依赖 state.system）
//   prism-router.feishu.alert_mem_pct          内存超过 N%
//   prism-router.feishu.alert_disk_pct         磁盘超过 N%
//   prism-router.feishu.alert_quiet_hours      免打扰时段，如 23:00-07:00（可逗号分隔多段）；
//                                               仅抑制告警，报表不受影响
//
// 签名算法（官方）：key = timestamp + "\n" + secret，HMAC-SHA256 签空字节串，Base64。
//   测试向量：ts=1599360473, secret=demo -> l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=
//
// 设计要点：
//   * 绝不只看 HTTP 200：必须解析响应体 code，非 0 视为失败（19021/19024/11232 都是 200）。
//   * 卡片 2.0（schema=2.0，元素在 body.elements）；脚注用 div+plain_text（2.0 已移除 note）。
//   * 整个 POST body < 20 KB；超限按 Top 10 -> 8 -> 5 截断，再降图表密度。
//   * 可重试错误按 1 -> 5 -> 15 分钟退避，最多 3 次重试，队列在 /tmp（重启即丢，日报每天都有）。
//   * 告警同规则+同目标 30 分钟只发一次，状态在 /tmp/prism-router/alert-state.json。
//   * 日志在 /tmp/prism-router/feishu.log；不记录完整 webhook（防止泄露到日志）。
//   * 应用机器人路线：tenant_access_token 缓存在 BASE/feishu-tenant.json（0600，过期前 60 秒
//     刷新，按 app_id 区分）；发送失败只重试一次，仍失败且配了 webhook 则回退 webhook
//     （日志写明原因）—— 不排重试风暴，也不让一次 API 抖动把日报丢掉。
//   * app_secret / Bearer token 只进 0600 临时文件（curl -K 配置 + data-binary @file），
//     绝不进 argv、不进日志、不进 stdout。

const fs = require("fs");

const VERSION       = "1.1.0";
const LIMIT_BODY    = 20480;                 // 飞书 webhook 请求体硬上限 20 KB
const DEFAULT_BASE  = "/tmp/prism-router";
const ONLINE_WINDOW = 600;                   // last_seen 在 10 分钟内算在线
const STALE_ALERT   = 180;                   // state.json 超过 3 分钟未更新 -> 采集异常告警
const STALE_REPORT  = 900;                   // 日报脚注提示阈值（15 分钟）
const ALERT_COOLDOWN = 1800;                 // 30 分钟冷却
const RETRY_DELAYS  = [60, 300, 900];        // 1 -> 5 -> 15 分钟
const MAX_RETRIES   = 3;                     // 首次失败后再重试 3 次
const LOG_MAX       = 524288;                // 512 KB 轮转

// 卡片可配区块（顺序即渲染顺序）：overview 附带近 24h 折线图
const ITEMS_ALL      = ["overview", "proxy_direct", "wifi_wired", "system",
                        "top_devices", "top_apps", "nodes"];
const ITEMS_DEFAULT  = ["overview", "proxy_direct", "wifi_wired", "top_devices", "top_apps"];
const ITEMS_DISABLE  = ["none", "off", "-", "0", ""];
const DEFAULT_DAILY_DIR = "/etc/prism-router/daily";
const SPIKE_MIN_BASE = 1048576;              // 突增基线低于 1 MB/h 时不告警（避免小样本噪声）
const SPIKE_DAYS     = 7;                    // 近 7 日均值

const SIGN_VECTOR = {
    ts: 1599360473,
    secret: "demo",
    expect: "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8="
};

let BASE = DEFAULT_BASE;
let LIMIT = LIMIT_BODY;            // 实际生效上限（测试可用 --limit 调整）
let DAILY_DIR = DEFAULT_DAILY_DIR; // 7 日均值来源（--daily-dir 覆盖）
let NOW_OVERRIDE = 0;              // 注入的「现在」（--epoch / --at），0 = 用真实时间
let _pid = 0;
let _seq = 0;
let _uci_cursor = null;
let _uci_broken = false;

// ucode 在函数定义处绑定标识符：先统一声明，再赋值为函数表达式。
let now_ts, nowstr, today, run, shq, ensure_dir, getpid, read_json, write_atomic, log, jstr, jminify, num, intv, gb, fmt_bytes, fmt_rate, fmt_uptime, pct_text, cut, parse_size, tz_offset,
    civil_from_days, local_parts, day_of, hhmm_parse, hhmm_minutes, report_due, quiet_parse, in_quiet,
    hmac_sign, uci_cursor, uci_get, uci_present, bool_opt, parse_items, default_cfg, load_cfg, send_allowed,
    pick_num, system_metrics, device_key, device_label, device_bytes, top_nodes, collect, chart_points,
    overview_text, proxy_direct_text, wifi_wired_text, system_text, nodes_text, chart_element, table_element,
    apps_table_element, footnote_element, card_elements, build_card, prepare_daily, signed_body, code_help,
    http_post, parse_result, deliver, queue_dir, queue_count, enqueue, process_retries, script_path, spawn_worker,
    retry_worker, alert_state_path, read_alert_state, save_alert_state, allow_send, check_degraded, alert_text,
    send_text, alert_emit, track_emit, spike_info, report_stamp_path, mark_report_sent, report_already_sent,
    cmd_alerts, gather_tags, card_texts, card_tables,
    check_card_json, cmd_daily, cmd_scheduled, cmd_card, cmd_check, cmd_test, cmd_retry, cmd_status, cmd_selftest,
    cmd_sign, app_http, app_token, deliver_app, cmd_chats, usage, parse_args;

// ───────────────────────────── 基础工具 ─────────────────────────────

// 「现在」：真实时间，或 --epoch/--at 注入的时间（测试与离线判定用）
now_ts = function() {
    return NOW_OVERRIDE > 0 ? NOW_OVERRIDE : time();
};

nowstr = function() {
    if (NOW_OVERRIDE > 0) {
        let p = local_parts(NOW_OVERRIDE);
        if (p != null)
            return sprintf("%s %02d:%02d:%02d", p.day, p.h, p.m, p.s);
    }
    let r = run("date '+%Y-%m-%d %H:%M:%S'");
    let s = trim(r.out);
    return length(s) ? s : sprintf("@%d", time());
};

today = function() {
    return day_of(now_ts());
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
    let st = null;
    try { st = fs.lstat(path); } catch (e) { return false; }
    if (st)
        return st.type == "directory" && st.uid == 0 && st.gid == 0;
    if (run("mkdir -p " + shq(path)).code != 0)
        return false;
    try { st = fs.lstat(path); } catch (e) { return false; }
    return st != null && st.type == "directory" && st.uid == 0 && st.gid == 0;
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

/* 0600 原子写：用于 tenant_access_token 缓存等凭证。 */
let write_atomic_private = function(path, content) {
    let tmp = sprintf("%s.tmp.%d.%d.%d", path, getpid(), _seq++, int(time()));
    try {
        let fd = fs.open(tmp, "w", 384);
        if (!fd)
            return false;
        fd.write(content);
        fd.close();
        if (fs.rename(tmp, path)) {
            try { fs.chmod(path, 384); } catch (e) { }
            return true;
        }
    } catch (e) {
        // fallthrough
    }
    try { fs.unlink(tmp); } catch (e) { }
    return false;
};

/* 预创建 0600 文件：curl 的 output= 与 shell 的 2> 会保留原权限。 */
let write_private = function(path, content) {
    try {
        let fd = fs.open(path, "w", 384);       // 0o600
        if (!fd)
            return false;
        if (content != null)
            fd.write(content);
        fd.close();
        return true;
    } catch (e) {
        return false;
    }
};

log = function(level, msg) {
    let line = sprintf("%s [%s] %s\n", nowstr(), level, msg);
    try {
        // BASE 不是真实 root 目录（例如 /tmp/prism-router 被换成 symlink）→ 不写日志。
        if (!ensure_dir(BASE)) {
            print(line);
            return;
        }
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
        run(sprintf("logger -t prism-router-feishu -p daemon.%s %s 2>/dev/null",
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

// 实时速率（字节/秒）
fmt_rate = function(n) {
    n = num(n);
    if (n <= 0)
        return "0 B/s";
    return fmt_bytes(n) + "/s";
};

// 运行时长：3d2h / 5h20m / 12m
fmt_uptime = function(sec) {
    sec = intv(sec);
    if (sec <= 0)
        return "";
    let d = int(sec / 86400);
    let h = int(sec / 3600) % 24;
    let m = int(sec / 60) % 60;
    if (d > 0)
        return sprintf("%dd%dh", d, h);
    if (h > 0)
        return sprintf("%dh%dm", h, m);
    return sprintf("%dm", m);
};

// 占比文本：45.2%；分母为 0 时给 —
pct_text = function(part, whole) {
    part = num(part);
    whole = num(whole);
    if (whole <= 0)
        return "—";
    return sprintf("%.1f%%", part * 100.0 / whole);
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

// ───────────────────── 本地时间 / 报表调度（纯函数，可离线自检） ─────────────────────

// 1970-01-01 起的天数 -> 公历（Howard Hinnant 算法）
civil_from_days = function(days) {
    let z = intv(days) + 719468;
    let era = (z >= 0 ? z : z - 146096) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp < 10 ? mp + 3 : mp - 9;
    return { y: y + (m <= 2 ? 1 : 0), m: m, d: d };
};

// 本地时间拆分：{ day:"YYYY-MM-DD", h, m, s, wd(1=周一), days, sod }
local_parts = function(epoch) {
    let t = intv(epoch);
    if (t <= 0)
        return null;
    t += tz_offset();
    let sod = t % 86400;
    if (sod < 0)
        sod += 86400;
    let days = (t - sod) / 86400;
    let c = civil_from_days(days);
    let wd = ((days + 3) % 7 + 7) % 7 + 1;      // 1970-01-01 是周四 -> 4
    return {
        day: sprintf("%04d-%02d-%02d", intv(c.y), intv(c.m), intv(c.d)),
        h: int(sod / 3600), m: int((sod % 3600) / 60), s: int(sod % 60),
        wd: wd, days: days, sod: sod
    };
};

day_of = function(epoch) {
    let p = local_parts(epoch);
    return p == null ? "" : p.day;
};

// "08:30" / "8:30" / "0830" / "8" -> "08:30"；解析不了返回 def（本身也做一次规范化）
hhmm_parse = function(v, def) {
    def = def == null ? "08:30" : def;
    v = trim(sprintf("%s", v == null ? "" : v));
    let h = -1, mi = -1;
    let m = match(v, /^([0-9]{1,2}):([0-9]{1,2})$/);
    if (m) {
        h = intv(m[1]); mi = intv(m[2]);
    } else {
        m = match(v, /^([0-9]{2})([0-9]{2})$/);
        if (m) {
            h = intv(m[1]); mi = intv(m[2]);
        } else {
            m = match(v, /^([0-9]{1,2})$/);
            if (m) {
                h = intv(m[1]); mi = 0;
            }
        }
    }
    if (h < 0 || h > 23 || mi < 0 || mi > 59)
        return hhmm_parse(def, "08:30");
    return sprintf("%02d:%02d", h, mi);
};

hhmm_minutes = function(v) {
    let s = hhmm_parse(v, "08:30");
    return intv(substr(s, 0, 2)) * 60 + intv(substr(s, 3, 2));
};

// 报表是否到点：返回 {due, kind:"daily"|"weekly", reason}
// 语义：daily=每天；weekly=report_weekday 那天；both=每天（report_weekday 那天算「周报」）
report_due = function(cfg, epoch) {
    let mode = lc(trim(sprintf("%s", cfg == null || cfg.report_mode == null ? "" : cfg.report_mode)));
    if (mode != "daily" && mode != "weekly" && mode != "both")
        mode = "daily";
    let want = hhmm_parse(cfg == null ? "" : cfg.report_time, "08:30");
    let wd_want = intv(cfg == null ? 0 : cfg.report_weekday);
    if (wd_want < 1 || wd_want > 7)
        wd_want = 1;
    let window = cfg != null && intv(cfg.window) > 0 ? intv(cfg.window) : 0;

    let p = local_parts(epoch);
    if (p == null)
        return { due: false, kind: "daily",
                 reason: sprintf("时间无效（epoch=%s）", epoch) };

    let cur = sprintf("%02d:%02d", p.h, p.m);
    let cur_m = p.h * 60 + p.m;
    let want_m = hhmm_minutes(want);
    let hit = (cur_m == want_m) ||
              (window > 0 && cur_m > want_m && cur_m - want_m <= window);

    let kind = "daily";
    let due = false;
    if (mode == "daily") {
        due = hit;
        kind = "daily";
    } else if (mode == "weekly") {
        due = hit && p.wd == wd_want;
        kind = "weekly";
    } else {
        due = hit;
        kind = (p.wd == wd_want) ? "weekly" : "daily";
    }
    return {
        due: due,
        kind: kind,
        reason: sprintf("mode=%s time=%s weekday=%d now=%s %s(周%d)%s",
                        mode, want, wd_want, p.day, cur, p.wd,
                        window > 0 ? sprintf(" window=%dmin", window) : "")
    };
};

// 免打扰时段："23:00-07:00" / "12:00-13:30,23:00-07:00"；无效项忽略
quiet_parse = function(raw) {
    let out = [];
    let s = trim(sprintf("%s", raw == null ? "" : raw));
    if (!length(s))
        return out;
    for (let part in split(s, ",")) {
        part = trim(part);
        if (!length(part))
            continue;
        let m = match(part, /^([0-9]{1,2}(:[0-9]{1,2})?)\s*[-~]\s*([0-9]{1,2}(:[0-9]{1,2})?)$/);
        if (!m)
            continue;
        let from = hhmm_minutes(m[1]);
        let to = hhmm_minutes(m[3]);       // 注意：m[2] 是内层“:MM”分组
        if (from == to)
            continue;                       // 起止相同视为整段无意义，忽略
        push(out, { from: from, to: to, raw: part });
    }
    return out;
};

// 当前是否落在免打扰时段；返回命中的窗口或 null
in_quiet = function(windows, epoch) {
    if (type(windows) != "array" || !length(windows))
        return null;
    let p = local_parts(epoch);
    if (p == null)
        return null;
    let cur = p.h * 60 + p.m;
    for (let w in windows) {
        if (type(w) != "object")
            continue;
        if (w.from <= w.to) {
            if (cur >= w.from && cur < w.to)
                return w;
        } else if (cur >= w.from || cur < w.to) {   // 跨零点
            return w;
        }
    }
    return null;
};

// ───────────────────────────── 签名 ─────────────────────────────

// 签名：key = ts + "\n" + secret；HMAC-SHA256 签空字节串；Base64。
//
// ⚠️ 目标容器 OpenSSL 3.0.22 实测：`dgst -hmac` / `-macopt key:<文件>` 都只能
// 从 argv 拿字面量 key，没有“从文件/fd 读 HMAC key”的选项；环境变量会出现在
// /proc/<pid>/environ。因此改为纯 ucode HMAC + sha256sum 读 stdin：
//   * secret 只在本进程内存里派生 ipad/opad；
//   * argv 里只有临时文件路径，没有 key；
//   * 临时文件只保存 hash 的十六进制文本，权限 0600，用完即删。

let auth_tmp_seq = 0;

const AUTH_TMP = "/tmp/prism-router/.auth";
const AUTH_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// 安全目录（与 prism-router-node-auth.uc 同步）：
// lstat 不跟随符号链接；只接受真实目录且 root:root。已存在但不安全时直接失败，
// 绝不先 chmod/chown 再信任（符号链接不会被 chmod 变成目录）。
let auth_lstat_dir = function(path) {
    let st = null;
    try { st = fs.lstat(path); } catch (e) { return null; }
    if (!st || st.type != "directory" || st.uid != 0 || st.gid != 0)
        return null;
    return st;
};

let auth_secure_dir = function(path, mode) {
    let st = auth_lstat_dir(path);
    if (!st) {
        let raw = null;
        try { raw = fs.lstat(path); } catch (e) { raw = null; }
        if (raw)
            return false;
        try { fs.mkdir(path, mode); } catch (e) { }
        st = auth_lstat_dir(path);
        if (!st)
            return false;
    }
    try { fs.chmod(path, mode); } catch (e) { return false; }
    try { fs.chown(path, 0, 0); } catch (e) { return false; }
    return auth_lstat_dir(path) != null;
};

// /tmp 必须是 root 的 sticky 真实目录；否则不创建任何认证临时目录。
let auth_safe_tmp_parent = function() {
    let st = null;
    try { st = fs.lstat("/tmp"); } catch (e) { return false; }
    return st != null && st.type == "directory" && st.uid == 0
        && st.perm != null && st.perm.sticky == true;
};

// /tmp/prism-router 先安全创建/校验，再建 0700 的 .auth。
let auth_ensure_tmp = function() {
    if (!auth_safe_tmp_parent())
        return false;
    if (!auth_secure_dir("/tmp/prism-router", 493))   // 0755
        return false;
    return auth_secure_dir(AUTH_TMP, 448);             // 0700
};

// sha256sum 的输出仍是行首 64 hex；openssl dgst -sha256 的
// `SHA2-256(stdin)= <64hex>` 尾部格式只在回退时接受。
let auth_digest_hex = function(raw) {
    let text = trim(sprintf("%s", raw ?? ""));
    let m = match(text, /^([0-9a-fA-F]{64})/);
    if (m)
        return lc(m[1]);
    m = match(text, /(SHA2-256|SHA256)\(stdin\)= *([0-9a-fA-F]{64}) *$/);
    if (m)
        return lc(m[2]);
    m = match(text, /\(stdin\)= *([0-9a-fA-F]{64}) *$/);
    return m ? lc(m[1]) : "";
};

let auth_hash_cmd = function() {
    for (let path in [ "/usr/bin/sha256sum", "/bin/sha256sum" ])
        if (fs.access(path))
            return path;
    for (let path in [ "/usr/bin/openssl", "/usr/sbin/openssl", "/bin/openssl" ])
        if (fs.access(path))
            return sprintf("%s dgst -sha256", path);
    return "sha256sum";
};

let auth_sha256_hex = function(data) {
    if (!auth_ensure_tmp())
        return "";
    let out = sprintf("%s/h-%d-%d-%d", AUTH_TMP, time(), getpid(), auth_tmp_seq++);
    try {
        // 'wx'：目标已存在（含预先放置的符号链接/文件）就失败，绝不跟随写入。
        let fd = fs.open(out, "wx", 384);      // 0o600
        if (!fd)
            return "";
        fd.close();
    } catch (e) {
        return "";
    }
    let p = null;
    try { p = fs.popen(sprintf("%s > %s", auth_hash_cmd(), shq(out)), "w"); }
    catch (e) { p = null; }
    if (!p) {
        try { fs.unlink(out); } catch (e) { }
        return "";
    }
    let off = 0;
    try {
        while (off < length(data)) {
            let n = p.write(substr(data, off));
            if (n == null || n <= 0)
                break;
            off += n;
        }
    } catch (e) { }
    let rc = p.close();
    let raw = "";
    try { raw = fs.readfile(out) ?? ""; } catch (e) { raw = ""; }
    try { fs.unlink(out); } catch (e) { }
    if (rc != 0)
        return "";
    return auth_digest_hex(raw);
};

let auth_hex_bin = function(hex) {
    let out = "";
    for (let i = 0; i + 1 < length(hex); i += 2)
        out += chr(int(substr(hex, i, 2), 16));
    return out;
};

let auth_b64 = function(bin) {
    let out = "";
    for (let i = 0; i < length(bin); i += 3) {
        let b0 = ord(substr(bin, i, 1));
        let has1 = (i + 1 < length(bin));
        let has2 = (i + 2 < length(bin));
        let b1 = has1 ? ord(substr(bin, i + 1, 1)) : 0;
        let b2 = has2 ? ord(substr(bin, i + 2, 1)) : 0;
        out += substr(AUTH_B64, (b0 >> 2) & 63, 1);
        out += substr(AUTH_B64, ((b0 & 3) << 4) | ((b1 >> 4) & 15), 1);
        out += has1 ? substr(AUTH_B64, ((b1 & 15) << 2) | ((b2 >> 6) & 3), 1) : "=";
        out += has2 ? substr(AUTH_B64, b2 & 63, 1) : "=";
    }
    return out;
};

let auth_hmac_b64 = function(secret, message) {
    let msg = sprintf("%s", message);
    let key = sprintf("%s", secret);
    if (length(key) > 64) {
        let kh = auth_sha256_hex(key);
        if (!length(kh))
            return "";
        key = auth_hex_bin(kh);
    }
    let ipad = "", opad = "";
    for (let i = 0; i < 64; i++) {
        let b = (i < length(key)) ? ord(substr(key, i, 1)) : 0;
        ipad += chr(b ^ 0x36);
        opad += chr(b ^ 0x5c);
    }
    let inner = auth_sha256_hex(ipad + msg);
    if (!length(inner))
        return "";
    let outer = auth_sha256_hex(opad + auth_hex_bin(inner));
    if (!length(outer))
        return "";
    return auth_b64(auth_hex_bin(outer));
};

hmac_sign = function(ts, secret) {
    let sig = auth_hmac_b64(sprintf("%s\n%s", ts, secret), "");
    if (!length(sig))
        log("ERROR", "签名计算失败（缺少 sha256sum，或临时目录不可写）；密钥未进 argv/环境变量");
    return sig;
};

// ───────────────────────────── UCI 配置 ─────────────────────────────

// uci cursor（失败只记一次日志，随后回退到 uci 命令）
uci_cursor = function() {
    if (!_uci_broken && !_uci_cursor) {
        try {
            _uci_cursor = require("uci").cursor();
        } catch (e) {
            _uci_broken = true;
            log("WARN", "ucode uci 模块不可用，回退到 uci 命令：" + e);
        }
    }
    return _uci_cursor;
};

uci_get = function(key) {
    let parts = split(key, ".");
    let c = uci_cursor();
    if (c && length(parts) >= 3) {
        try {
            let v = c.get(parts[0], parts[1], parts[2]);
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

// 区分「选项不存在」和「选项为空」：前者用默认值（老配置行为不变），后者按用户显式写空处理
uci_present = function(key) {
    let parts = split(key, ".");
    let c = uci_cursor();
    if (c && length(parts) >= 3) {
        try {
            return c.get(parts[0], parts[1], parts[2]) != null;
        } catch (e) {
            // fallback to command
        }
    }
    return run("uci -q get " + shq(key)).code == 0;
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

// report_items：逗号分隔，按配置顺序渲染；未知项忽略；"none"/"off"/"-"/"0"/空 显式表示什么都不发
// fallback=true 时（选项根本不存在）返回默认清单，保证老配置行为不变
parse_items = function(raw, fallback) {
    let s = trim(sprintf("%s", raw == null ? "" : raw));
    if (!length(s))
        return fallback ? slice(ITEMS_DEFAULT, 0) : [];
    let out = [];
    for (let tok in split(s, ",")) {
        let t = lc(trim(tok));
        if (!length(t))
            continue;
        if (index(ITEMS_DISABLE, t) >= 0)
            return [];
        if (index(ITEMS_ALL, t) < 0)
            continue;
        if (index(out, t) < 0)
            push(out, t);
    }
    return out;
};

// 不带 UCI 的基础默认值（selftest / 离线调用用，保证不依赖本机配置）
default_cfg = function() {
    return {
        enabled: true,
        webhook: "", app_id: "", app_secret: "", chat_id: "",
        // 发送路线：mode 为空 = 未配置（沿用旧的三件套自动判定）
        mode: "", mode_explicit: false, use_app: false, fallback_webhook: false,
        card_wrapper: "card", secret: "", daily_time: "08:30",
        alert_enabled: true, alert_new_device: true,
        device_limit: 0, cooldown: ALERT_COOLDOWN,
        // 发什么
        items: slice(ITEMS_DEFAULT, 0),
        items_raw: "",
        items_explicit: false,
        // 什么时候发
        report_mode: "daily", report_time: "08:30", report_weekday: 1,
        kind: "daily", window: 0,
        // 什么条件下发
        app_limit: 0, spike_ratio: 0.0, offline_min: 0,
        cpu_pct: 0.0, mem_pct: 0.0, disk_pct: 0.0,
        quiet: [], quiet_raw: "",
        force: false
    };
};

load_cfg = function(opts) {
    let c = default_cfg();

    c.enabled = bool_opt(uci_get("prism-router.feishu.enabled"), true);
    c.webhook = trim(uci_get("prism-router.feishu.webhook"));
    c.app_id = trim(uci_get("prism-router.feishu.app_id"));
    c.app_secret = trim(uci_get("prism-router.feishu.app_secret"));
    c.chat_id = trim(uci_get("prism-router.feishu.chat_id"));
    c.card_wrapper = trim(uci_get("prism-router.feishu.card_wrapper"));
    c.secret = trim(uci_get("prism-router.feishu.secret"));
    c.daily_time = trim(uci_get("prism-router.feishu.daily_time"));
    c.alert_enabled = bool_opt(uci_get("prism-router.feishu.alert_enabled"), true);
    c.alert_new_device = bool_opt(uci_get("prism-router.feishu.alert_new_device"), true);
    c.device_limit = parse_size(uci_get("prism-router.feishu.device_daily_limit"));

    /* ── 发送路线 ──
       mode 选项存在时以它为准（webhook/app 二选一）；
       mode 缺省时（老配置）完全沿用旧行为：三件套齐全走应用，否则走 webhook。
       应用路线失败后是否回退 webhook：要求 webhook 本身可用（合法 URL + 有签名密钥）。 */
    c.mode_explicit = uci_present("prism-router.feishu.mode");
    let mraw = lc(trim(uci_get("prism-router.feishu.mode")));
    c.mode = (mraw == "app" || mraw == "webhook") ? mraw : "";
    let app_creds = length(c.app_id) && length(c.app_secret);
    let app_triple = app_creds && length(c.chat_id);
    if (!length(c.mode))
        c.use_app = app_triple;
    else
        c.use_app = (c.mode == "app") ? app_creds : false;
    c.fallback_webhook = webhook_ok(c.webhook) && length(c.secret) > 0;

    if (!length(c.daily_time))
        c.daily_time = "08:30";
    if (!length(c.card_wrapper))
        c.card_wrapper = "card";
    let cd = intv(trim(uci_get("prism-router.feishu.alert_cooldown")));
    if (cd >= 60)
        c.cooldown = cd;

    // ── 发什么 ──
    let items_key = "prism-router.feishu.report_items";
    c.items_explicit = uci_present(items_key);
    c.items_raw = trim(uci_get(items_key));
    /* 空值按"未配置"处理：老配置升级后没有这行、或用户在界面上把内容清空，
       都不应该让日报静默停掉。要彻底停发请显式写 report_items=none。 */
    c.items = parse_items(c.items_raw, !c.items_explicit || c.items_raw == "");

    // ── 什么时候发 ──
    c.report_mode = lc(trim(uci_get("prism-router.feishu.report_mode")));
    if (c.report_mode != "daily" && c.report_mode != "weekly" && c.report_mode != "both")
        c.report_mode = "daily";
    // report_time 优先；未设则沿用旧字段 daily_time；都没有就是 08:30
    c.report_time = hhmm_parse(uci_get("prism-router.feishu.report_time"), hhmm_parse(c.daily_time, "08:30"));
    c.report_weekday = intv(trim(uci_get("prism-router.feishu.report_weekday")));
    if (c.report_weekday < 1 || c.report_weekday > 7)
        c.report_weekday = 1;

    // ── 什么条件下发（空 = 关闭）──
    c.app_limit = parse_size(uci_get("prism-router.feishu.alert_app_daily_limit"));
    c.spike_ratio = num(trim(uci_get("prism-router.feishu.alert_spike_ratio")));
    if (c.spike_ratio < 0)
        c.spike_ratio = 0;
    c.offline_min = intv(trim(uci_get("prism-router.feishu.alert_offline_min")));
    if (c.offline_min < 0)
        c.offline_min = 0;
    c.cpu_pct = num(trim(uci_get("prism-router.feishu.alert_cpu_pct")));
    c.mem_pct = num(trim(uci_get("prism-router.feishu.alert_mem_pct")));
    c.disk_pct = num(trim(uci_get("prism-router.feishu.alert_disk_pct")));
    c.quiet_raw = trim(uci_get("prism-router.feishu.alert_quiet_hours"));
    c.quiet = quiet_parse(c.quiet_raw);

    c.force = opts && opts.force ? true : false;

    // ── 命令行覆盖（仅调试/测试用，不写 UCI）──
    if (opts) {
        if (opts.webhook != null)
            c.webhook = trim(opts.webhook);
        if (opts.secret != null)
            c.secret = trim(opts.secret);
        if (opts.chat != null)
            c.chat_id = trim(opts.chat);
        if (opts.device_limit != null)
            c.device_limit = parse_size(opts.device_limit);
        if (opts.items != null) {
            c.items_raw = trim(opts.items);
            c.items = parse_items(c.items_raw, false);
            c.items_explicit = true;
        }
        if (opts.mode != null && length(trim(opts.mode)))
            c.report_mode = lc(trim(opts.mode));
        if (opts.time != null && length(trim(opts.time)))
            c.report_time = hhmm_parse(opts.time, c.report_time);
        if (opts.weekday != null)
            c.report_weekday = intv(opts.weekday);
        if (c.report_weekday < 1 || c.report_weekday > 7)
            c.report_weekday = 1;
        if (opts.window != null)
            c.window = intv(opts.window) > 0 ? intv(opts.window) : 0;
        if (opts.kind != null)
            c.kind = opts.kind == "weekly" ? "weekly" : "daily";
        if (opts.app_limit != null)
            c.app_limit = parse_size(opts.app_limit);
        if (opts.spike_ratio != null)
            c.spike_ratio = num(opts.spike_ratio);
        if (opts.offline_min != null)
            c.offline_min = intv(opts.offline_min);
        if (opts.cpu != null)
            c.cpu_pct = num(opts.cpu);
        if (opts.mem != null)
            c.mem_pct = num(opts.mem);
        if (opts.disk != null)
            c.disk_pct = num(opts.disk);
        if (opts.quiet != null) {
            c.quiet_raw = trim(opts.quiet);
            c.quiet = quiet_parse(c.quiet_raw);
        }
    }
    if (c.spike_ratio < 0)
        c.spike_ratio = 0;
    if (c.offline_min < 0)
        c.offline_min = 0;
    if (c.cpu_pct < 0)
        c.cpu_pct = 0;
    if (c.mem_pct < 0)
        c.mem_pct = 0;
    if (c.disk_pct < 0)
        c.disk_pct = 0;
    return c;
};

/* webhook 校验：ucode 的 ERE 对字符类里的 \s 支持不一致，别用 [^\s"'\\]。
   这里显式禁止空白/引号/反斜杠，避免把 URL 拼进 curl 配置时破坏语法。 */
webhook_ok = function(u) {
    if (!match(u, /^https?:\/\//))
        return false;
    for (let bad in [ " ", "\t", "\r", "\n", "\"", "'", "\\" ])
        if (index(u, bad) >= 0)
            return false;
    return true;
};

// 空 webhook/secret -> 静默跳过（只记日志，不报错、不重试）
send_allowed = function(cfg, ignore_enabled) {
    /* 应用路线（mode=app，或老配置三件套齐全）：只要求 app_id/app_secret 齐；
       chat_id 缺失 / 凭据错误交给 deliver 反馈，并且会尝试回退 webhook。 */
    if (cfg.use_app) {
        if (!length(cfg.app_id) || !length(cfg.app_secret)) {
            log("ERROR", "mode=app 但 prism-router.feishu.app_id/app_secret 未配置，无法发送");
            return false;
        }
        if (!ignore_enabled && !cfg.enabled && !cfg.force) {
            log("INFO", "prism-router.feishu.enabled=0，跳过发送（可用 --force 强制）");
            return false;
        }
        return true;
    }
    if (!length(cfg.webhook)) {
        log("INFO", "prism-router.feishu.webhook 未配置，跳过发送");
        return false;
    }
    if (!length(cfg.secret)) {
        log("INFO", "prism-router.feishu.secret 未配置，跳过发送（签名校验需要密钥）");
        return false;
    }
    if (!webhook_ok(cfg.webhook)) {
        log("ERROR", "prism-router.feishu.webhook 格式非法，跳过发送");
        return false;
    }
    if (!ignore_enabled && !cfg.enabled && !cfg.force) {
        log("INFO", "prism-router.feishu.enabled=0，跳过发送（可用 --force 强制）");
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

// 从对象里按候选字段名取第一个数值；没有则返回 null（区别于 0）
pick_num = function(obj, names) {
    if (type(obj) != "object")
        return null;
    for (let n in names) {
        let v = obj[n];
        if (v == null)
            continue;
        if (type(v) == "array") {           // loadavg 风格的数组
            if (length(v) && type(v[0]) != "object")
                return num(v[0]);
            continue;
        }
        if (type(v) == "object")
            continue;
        if (type(v) == "string" && !length(trim(v)))
            continue;
        return num(v);
    }
    return null;
};

// state.system -> { cpu_pct, mem_pct, disk_pct, load1/5/15, temp_c, uptime, mem_*, disk_* }
// state.json 里没有 system（或里面没有任何可识别字段）时返回 null，调用方必须静默跳过。
system_metrics = function(state) {
    if (!state || type(state) != "object" || type(state.system) != "object")
        return null;
    let s = state.system;
    let o = {
        cpu_pct: pick_num(s, ["cpu_pct", "cpu", "cpu_usage", "cpu_percent", "cpu_p"]),
        cpu_cores: pick_num(s, ["cpu_cores", "cores", "ncpu"]),
        mem_pct: pick_num(s, ["mem_pct", "memory_pct", "mem_usage", "mem_percent", "mem_p"]),
        disk_pct: pick_num(s, ["disk_pct", "disk", "disk_usage", "disk_percent", "root_pct"]),
        load1: pick_num(s, ["load1", "load_1", "loadavg", "load"]),
        load5: pick_num(s, ["load5", "load_5"]),
        load15: pick_num(s, ["load15", "load_15"]),
        temp_c: pick_num(s, ["temp_c", "temp", "temperature", "cpu_temp"]),
        uptime: pick_num(s, ["uptime", "uptime_sec"]),
        mem_total: pick_num(s, ["mem_total", "memory_total"]),
        mem_used: pick_num(s, ["mem_used", "memory_used"]),
        mem_avail: pick_num(s, ["mem_avail", "mem_available", "memory_available"]),
        disk_total: pick_num(s, ["disk_total", "root_total"]),
        disk_used: pick_num(s, ["disk_used", "root_used"]),
        wan_rx: pick_num(s, ["wan_rx_rate", "wan_rx"]),
        wan_tx: pick_num(s, ["wan_tx_rate", "wan_tx"])
    };
    // SPEC §3.3 给的是 mem_avail（可用），这里统一换算成 used
    if (o.mem_used == null && o.mem_total != null && o.mem_avail != null)
        o.mem_used = o.mem_total - o.mem_avail;
    // 只给了 used/total 的，补算百分比
    if (o.mem_pct == null && o.mem_total != null && o.mem_used != null && o.mem_total > 0)
        o.mem_pct = o.mem_used * 100.0 / o.mem_total;
    if (o.disk_pct == null && o.disk_total != null && o.disk_used != null && o.disk_total > 0)
        o.disk_pct = o.disk_used * 100.0 / o.disk_total;
    if (o.uptime == null)
        o.uptime = pick_num(state, ["uptime"]);
    let any = false;
    for (let k in o) {
        if (o[k] != null && k != "uptime") {
            any = true;
            break;
        }
    }
    return any ? o : null;
};

// 把 state.json / history.json 归一化成日报需要的结构
collect = function(state, hist, now) {
    let ctx = {
        day: day_of(now) || today(),
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
        node_list: [],
        node_total: 0,
        apps: [],
        rates: { rx: 0, tx: 0 },
        links: { wifi: 0, wired: 0, unknown: 0 },
        links_from: "none",
        system: null,
        warnings: [],
        hours: [],
        first_hour: -1,
        last_hour: -1,
        fallback: [],
        confidence: "",
        trimmed: false
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
        ctx.rates.rx = num(t.rx_rate);
        ctx.rates.tx = num(t.tx_rate);

        // 接入三桶（SPEC §3.2）：优先 totals.wifi_*/wired_*/unknown_*，缺失时退回按设备 link 汇总
        let wf = num(t.wifi_rx) + num(t.wifi_tx);
        let wd = num(t.wired_rx) + num(t.wired_tx);
        let un = num(t.unknown_rx) + num(t.unknown_tx);
        if (wf + wd + un > 0) {
            ctx.links = { wifi: wf, wired: wd, unknown: un };
            ctx.links_from = "totals";
        }

        if (type(state.devices) == "array") {
            for (let d in state.devices) {
                if (type(d) != "object")
                    continue;
                let b = device_bytes(d);
                let lk = lc(trim(sprintf("%s", d.link == null ? "" : d.link)));
                if (lk != "wifi" && lk != "wired")
                    lk = "unknown";
                push(ctx.devices, {
                    key: device_key(d),
                    label: device_label(d),
                    ip: trim(sprintf("%s", d.ip == null ? "" : d.ip)),
                    mac: trim(sprintf("%s", d.mac == null ? "" : d.mac)),
                    link: lk,
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
            if (ctx.links_from == "none") {
                let agg = { wifi: 0, wired: 0, unknown: 0 };
                for (let d in ctx.devices)
                    agg[d.link] += d.total;
                if (agg.wifi + agg.wired + agg.unknown > 0) {
                    ctx.links = agg;
                    ctx.links_from = "devices";
                }
            }
        }

        ctx.nodes = top_nodes(state, 3);

        // 全量节点列表（nodes 区块用）
        if (type(state.nodes) == "object") {
            let arr = [];
            for (let name in state.nodes) {
                if (name == "DIRECT")
                    continue;
                let nd = state.nodes[name];
                if (type(nd) != "object")
                    continue;
                let bytes = num(nd.rx) + num(nd.tx);
                if (bytes <= 0)
                    continue;
                push(arr, { name: cut(trim(sprintf("%s", name)), 28), bytes: bytes });
            }
            sort(arr, function (a, b) { return b.bytes - a.bytes; });
            ctx.node_list = arr;
            for (let a in arr)
                ctx.node_total += a.bytes;
        }

        // 全局应用（域名）排行
        if (type(state.apps) == "array") {
            let arr = [];
            for (let a in state.apps) {
                if (type(a) != "object")
                    continue;
                let host = trim(sprintf("%s", a.host == null ? "" : a.host));
                if (!length(host))
                    continue;
                let bytes = num(a.rx) + num(a.tx);
                if (bytes <= 0)
                    continue;
                push(arr, {
                    host: cut(host, 40),
                    chain: cut(trim(sprintf("%s", a.chain == null ? "" : a.chain)), 24),
                    devices: intv(a.devices),
                    total: bytes
                });
            }
            sort(arr, function (a, b) { return b.total - a.total; });
            ctx.apps = arr;
        }

        // 系统指标（state.system；该字段可能还不存在 -> 相关区块/告警静默跳过）
        ctx.system = system_metrics(state);

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
//
// 区块由 report_items 决定（按配置顺序渲染）：
//   overview      总量 / 代理 / 直连 / 在线设备 / 实时速率  + 近 24h 折线图
//   proxy_direct  代理 vs 直连 占比
//   wifi_wired    无线 / 有线 / 未知 占比
//   system        软路由 CPU / 内存 / 负载 / 磁盘 / 温度 / 运行时长（state.system 缺失则跳过）
//   top_devices   Top N 设备表
//   top_apps      Top N 应用（域名）表
//   nodes         多节点（代理出口）列表
// 元素标记（供 check/门禁 grep）：**总流量** / **代理 / 直连** / **无线 / 有线** / **系统** / **代理节点**

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
    if (ctx.rates.rx > 0 || ctx.rates.tx > 0)
        s += sprintf("\n**实时速率**：↓%s ↑%s", fmt_rate(ctx.rates.rx), fmt_rate(ctx.rates.tx));
    return s;
};

proxy_direct_text = function(ctx) {
    return sprintf("**代理 / 直连**：代理 %s（%s） · 直连 %s（%s）",
                   fmt_bytes(ctx.proxy), pct_text(ctx.proxy, ctx.total),
                   fmt_bytes(ctx.direct), pct_text(ctx.direct, ctx.total));
};

wifi_wired_text = function(ctx) {
    let l = ctx.links;
    let sum = l.wifi + l.wired + l.unknown;
    if (sum <= 0)
        return "**无线 / 有线**：—（state.json 缺少接入数据）";
    let s = sprintf("**无线 / 有线**：无线 %s（%s） · 有线 %s（%s）",
                    fmt_bytes(l.wifi), pct_text(l.wifi, sum),
                    fmt_bytes(l.wired), pct_text(l.wired, sum));
    if (l.unknown > 0)
        s += sprintf(" · 未知 %s（%s）", fmt_bytes(l.unknown), pct_text(l.unknown, sum));
    return s;
};

system_text = function(sys) {
    if (sys == null || type(sys) != "object")
        return "";
    let parts = [];
    if (sys.cpu_pct != null)
        push(parts, sprintf("CPU %.0f%%%s", sys.cpu_pct,
                            sys.cpu_cores != null ? sprintf("（%d 核）", sys.cpu_cores) : ""));
    if (sys.mem_pct != null) {
        let m = sprintf("内存 %.0f%%", sys.mem_pct);
        if (sys.mem_total != null && sys.mem_total > 0)
            m += sprintf("（%s/%s）", fmt_bytes(sys.mem_used == null ? 0 : sys.mem_used), fmt_bytes(sys.mem_total));
        push(parts, m);
    }
    if (sys.load1 != null) {
        let ld = sprintf("负载 %.2f", sys.load1);
        if (sys.load5 != null)
            ld += sprintf("/%.2f", sys.load5);
        if (sys.load15 != null)
            ld += sprintf("/%.2f", sys.load15);
        push(parts, ld);
    }
    if (sys.disk_pct != null)
        push(parts, sprintf("磁盘 %.0f%%", sys.disk_pct));
    if (sys.temp_c != null)
        push(parts, sprintf("温度 %.0f℃", sys.temp_c));
    if (sys.uptime != null && sys.uptime > 0)
        push(parts, "运行 " + fmt_uptime(sys.uptime));
    if (sys.wan_rx != null || sys.wan_tx != null)
        push(parts, sprintf("WAN ↓%s ↑%s", fmt_rate(sys.wan_rx), fmt_rate(sys.wan_tx)));
    if (!length(parts))
        return "";
    return "**系统**：" + join(" · ", parts);
};

nodes_text = function(ctx) {
    if (!length(ctx.node_list))
        return "";
    let parts = [];
    for (let i = 0; i < length(ctx.node_list) && i < 8; i++) {
        let n = ctx.node_list[i];
        push(parts, sprintf("%s %s（%s）", cut(n.name, 24), fmt_bytes(n.bytes),
                            pct_text(n.bytes, ctx.node_total)));
    }
    let s = "**代理节点**：" + join(" · ", parts);
    if (length(ctx.node_list) > 8)
        s += sprintf(" 等 %d 个", length(ctx.node_list));
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

apps_table_element = function(ctx, top_n) {
    let rows = [];
    for (let i = 0; i < length(ctx.apps) && i < top_n; i++) {
        let a = ctx.apps[i];
        push(rows, {
            app: cut(a.host, 40),
            chain: length(a.chain) ? cut(a.chain, 24) : "-",
            total: fmt_bytes(a.total)
        });
    }
    return {
        "tag": "table",
        "page_size": 10,
        "row_height": "low",
        "freeze_first_column": true,
        "header_style": { bold: true, background_style: "grey", text_size: "normal" },
        "columns": [
            { name: "app", display_name: "应用 / 域名", data_type: "text" },
            { name: "chain", display_name: "出口", data_type: "text" },
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
    if (ctx.trimmed)
        push(parts, "已裁剪（体积超限）");
    if (length(ctx.warnings))
        push(parts, "注意：" + join("；", ctx.warnings));
    push(parts, "由 prism-router 自动生成");
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

// 按 items 顺序拼装元素；top_n=0 表示不放表格（体积裁剪的最后手段）
card_elements = function(ctx, items, top_n, step) {
    let els = [];
    for (let it in items) {
        if (it == "overview") {
            push(els, { "tag": "markdown", "content": overview_text(ctx) });
            push(els, chart_element(ctx, step));
        } else if (it == "proxy_direct") {
            push(els, { "tag": "markdown", "content": proxy_direct_text(ctx) });
        } else if (it == "wifi_wired") {
            push(els, { "tag": "markdown", "content": wifi_wired_text(ctx) });
        } else if (it == "system") {
            let txt = system_text(ctx.system);
            if (length(txt))
                push(els, { "tag": "markdown", "content": txt });
        } else if (it == "nodes") {
            let txt = nodes_text(ctx);
            if (length(txt))
                push(els, { "tag": "markdown", "content": txt });
        } else if (it == "top_devices") {
            if (top_n > 0)
                push(els, table_element(ctx, top_n));
        } else if (it == "top_apps") {
            if (top_n > 0)
                push(els, apps_table_element(ctx, top_n));
        }
    }
    push(els, footnote_element(ctx));
    return els;
};

build_card = function(ctx, cfg, top_n, step, trimmed) {
    let items = (cfg != null && type(cfg.items) == "array") ? cfg.items : ITEMS_DEFAULT;
    let kind = (cfg != null && cfg.kind == "weekly") ? "weekly" : "daily";
    ctx.trimmed = trimmed ? true : false;
    return {
        "schema": "2.0",
        "config": { "update_multi": true, "width_mode": "fill" },
        "header": {
            "template": "blue",
            "title": {
                "tag": "plain_text",
                "content": (kind == "weekly" ? "流量周报 " : "流量日报 ") + ctx.day
            },
            "subtitle": {
                "tag": "plain_text",
                "content": "OpenWrt 棱镜路由 · 自动生成"
            }
        },
        "body": {
            "direction": "vertical",
            "padding": "12px",
            "elements": card_elements(ctx, items, top_n, step)
        }
    };
};

// 生成日报：先按 Top 10/8/5 截断，再降图表密度，最后去掉表格；整个请求体必须 < 20 KB
prepare_daily = function(ctx, cfg) {
    /* 签名时间戳必须用真实时间（飞书只接受 1 小时内），--at/--epoch 只影响「日期/到点」判定 */
    let ts = sprintf("%d", time());
    let sign = length(cfg.secret) ? hmac_sign(ts, cfg.secret) : "";
    let ladder = [
        { top: 10, step: 1 }, { top: 8, step: 1 }, { top: 5, step: 1 },
        { top: 5, step: 2 }, { top: 5, step: 4 }, { top: 5, step: 6 },
        { top: 0, step: 1 }, { top: 0, step: 2 }, { top: 0, step: 4 }, { top: 0, step: 6 }
    ];
    let tried = [];

    if (type(cfg.items) != "array" || !length(cfg.items)) {
        log("WARN", "report_items 未启用任何区块，跳过日报");
        return null;
    }

    for (let i = 0; i < length(ladder); i++) {
        let lv = ladder[i];
        let card = build_card(ctx, cfg, lv.top, lv.step, i > 0);
        let body = signed_body(cfg, { "msg_type": "interactive", "card": card }, ts, sign);
        let bytes = length(body);
        if (bytes < LIMIT) {
            return { card: card, body: body, bytes: bytes,
                     top: lv.top, step: lv.step, ts: ts, sign: sign, kind: cfg.kind };
        }
        push(tried, sprintf("top=%d/step=%d:%dB", lv.top, lv.step, bytes));
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
    /* 应用机器人（im/v1/messages）常见错误 */
    if (code == 230001 || code == 230002) return "机器人不在该群，或群里没有发言权限（先把机器人拉进群）";
    if (code == 230013) return "机器人没有发消息权限（开放平台检查 im:message:send_as_bot）";
    if (code == 230027) return "缺少 im:message:send_as_bot 权限（改权限后要发布版本）";
    if (code == 99991663) return "tenant_access_token 无效或已过期（重试会自动刷新）";
    if (code == 10014) return "app_id / app_secret 不正确（开放平台核对后重填）";
    if (code == -5) return "tenant_access_token 获取失败（检查 app_id/app_secret）";
    if (code == -6) return "未配置 app_id/app_secret";
    if (code == -7) return "未配置 chat_id（先运行 chats 列群）";
    return "未知错误";
};

http_post = function(url, body) {
    let dir = BASE + "/tmp";
    if (!ensure_dir(dir))
        return { http: 0, curl: -1, body: "", err: "无法创建临时目录 " + dir };
    try { fs.chmod(dir, 448); } catch (e) { }     // 0o700

    let tag = sprintf("%d-%d-%d-%d", time(), getpid(), _seq++, int(time() * 1000));
    let bf = sprintf("%s/body-%s.json", dir, tag);
    let rf = sprintf("%s/resp-%s.json", dir, tag);
    let ef = sprintf("%s/err-%s.txt", dir, tag);
    let cf = sprintf("%s/curl-%s.conf", dir, tag);

    // 所有文件 0600；webhook（含 hook token）只进 curl 配置文件，不拼命令行。
    let conf = sprintf(
        "url = \"%s\"\n" +
        "request = \"POST\"\n" +
        "header = \"Content-Type: application/json\"\n" +
        "silent\n" +
        "show-error\n" +
        "connect-timeout = 8\n" +
        "max-time = 25\n" +
        "max-filesize = 65536\n" +
        "proto = \"=http,https\"\n" +
        "proto-redir = \"=https\"\n" +
        "max-redirs = 0\n" +
        "data-binary = \"@%s\"\n" +
        "output = \"%s\"\n" +
        "write-out = \"%%{http_code}\"\n", url, bf, rf);

    let ok = write_private(bf, body) && write_private(rf, "") &&
             write_private(ef, "") && write_private(cf, conf);

    if (!ok) {
        try { fs.unlink(bf); } catch (e) { }
        try { fs.unlink(rf); } catch (e) { }
        try { fs.unlink(ef); } catch (e) { }
        try { fs.unlink(cf); } catch (e) { }
        return { http: 0, curl: -1, body: "", err: "写临时文件失败" };
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
    if (length(resp) > 65536)
        resp = "";
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
 * 发送路线：webhook（默认） / app（自建应用机器人，mode=app）
 *   webhook  POST <webhook>（签名可选，见 hmac_sign）
 *   app      token: POST /open-apis/auth/v3/tenant_access_token/internal
 *                  缓存到 BASE/feishu-tenant.json（0600，过期前 60 秒刷新）
 *            发送: POST /open-apis/im/v1/messages?receive_id_type=chat_id
 *            群列表: GET /open-apis/im/v1/chats?page_size=50&user_id_type=open_id
 *   失败处理：应用路线单次 + 一次重试；仍失败且 webhook 可用 -> 回退 webhook 并记原因。
 * ============================================================ */

/* 测试钩子：把 open.feishu.cn 换成 loopback mock（仅隔离容器门禁用）。
   非 loopback 一律忽略 —— 否则一个环境变量就能把 app_secret 改道到别的主机。 */
api_base = function() {
    let raw = trim(sprintf("%s", getenv("PRISM_ROUTER_FEISHU_BASE") ?? ""));
    if (length(raw) && match(raw, /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:[0-9]{1,5})?$/))
        return raw;
    return "https://open.feishu.cn";
};

api_loopback = function() {
    return match(api_base(), /^http:\/\//) != null;
};

/* curl 的 proto 限制：生产只允许 https；只有 loopback mock 才放宽到 http。 */
api_proto = function() {
    return api_loopback() ? "=http,https" : "=https";
};

/* Bearer token 只允许 unreserved 字符：避免拼进 curl 配置时破坏语法，也挡住脏 token。 */
token_ok = function(tok) {
    /* 注意：ucode 的 ERE 不支持 {8,2048}（上限 255），所以长度单独判。 */
    return length(tok) >= 8 && length(tok) <= 2048
        && match(tok, /^[A-Za-z0-9._~+\/=-]+$/) != null;
};

app_http = function(method, path, bearer, body) {
    let dir = BASE + "/tmp";
    if (!ensure_dir(dir))
        return { http: 0, curl: -1, body: "", err: "无法创建临时目录 " + dir };
    try { fs.chmod(dir, 448); } catch (e) { }

    let tag = sprintf("%d-%d-%d-%d", time(), getpid(), _seq++, int(time() * 1000));
    let bf = sprintf("%s/abody-%s.json", dir, tag);
    let rf = sprintf("%s/aresp-%s.json", dir, tag);
    let cf = sprintf("%s/acurl-%s.conf", dir, tag);

    if (length(bearer) && !token_ok(bearer))
        return { http: 0, curl: -2, body: "", err: "access_token 格式非法" };

    // Bearer token / app_secret 请求体都只进 0600 配置文件，绝不进 argv。
    let lines = [
        sprintf("url = \"%s%s\"", api_base(), path),
        sprintf("request = \"%s\"", method),
        "silent",
        "show-error",
        "connect-timeout = 8",
        "max-time = 25",
        "max-filesize = 65536",
        sprintf("proto = \"%s\"", api_proto()),
        "proto-redir = \"=https\"",
        "max-redirs = 0",
        sprintf("output = \"%s\"", rf),
        "write-out = \"%{http_code}\""
    ];
    if (length(bearer))
        push(lines, sprintf("header = \"Authorization: Bearer %s\"", bearer));
    if (length(body)) {
        push(lines, "header = \"Content-Type: application/json\"");
        push(lines, sprintf("data-binary = \"@%s\"", bf));
    }

    let ok = write_private(bf, body ?? "") && write_private(rf, "") &&
             write_private(cf, join("\n", lines) + "\n");

    if (!ok) {
        try { fs.unlink(bf); } catch (e) { }
        try { fs.unlink(rf); } catch (e) { }
        try { fs.unlink(cf); } catch (e) { }
        return { http: 0, curl: -1, body: "", err: "写临时文件失败" };
    }

    let r = run(sprintf("curl -sS -K %s 2>/dev/null", shq(cf)));
    let http = intv(trim(r.out));
    let resp = "";
    try { if (fs.access(rf)) resp = fs.readfile(rf); } catch (e) { }
    try { fs.unlink(bf); } catch (e) { }
    try { fs.unlink(rf); } catch (e) { }
    try { fs.unlink(cf); } catch (e) { }
    if (length(resp) > 65536)
        resp = "";
    return { http: http, curl: r.code, body: resp,
             err: (r.code != 0) ? "curl exit " + r.code : "" };
};

/* tenant_access_token 缓存：BASE/feishu-tenant.json（0600，原子写）。
   过期前 60 秒就刷新；按 app_id 区分（换应用 != 换 token）。force=true 时忽略缓存。 */
app_token = function(cfg, force) {
    let cp = BASE + "/feishu-tenant.json";
    let now = time();
    if (!force) {
        let c = read_json(cp);
        if (c != null && type(c) == "object" && c.app_id == cfg.app_id &&
            intv(c.expire) > now + 60 && length(c.token) && token_ok(c.token))
            return c.token;
    }
    /* 旧版本把 token 缓存在 BASE/tmp/feishu-token.json；不再复用，顺手清掉。 */
    try { fs.unlink(BASE + "/tmp/feishu-token.json"); } catch (e) { }

    let body = sprintf('%J', { app_id: cfg.app_id, app_secret: cfg.app_secret });
    let r = app_http("POST", "/open-apis/auth/v3/tenant_access_token/internal", "", body);
    let j = null;
    try { if (length(r.body)) j = json(r.body); } catch (e) { j = null; }
    let tok = (j != null && type(j) == "object" && j.tenant_access_token != null) ? j.tenant_access_token : "";
    let exp = (j != null && type(j) == "object" && j.expire != null) ? intv(j.expire) : 7200;
    if (!length(tok) || !token_ok(tok)) {
        let code = -1, msg = "";
        if (j != null && type(j) == "object") {
            code = intv(j.code ?? -1);
            msg = sprintf("%s", j.msg ?? "");
        }
        /* 不记录响应体原文：里面可能有诊断信息，也可能被上游塞入凭证。 */
        log("ERROR", sprintf("tenant_access_token 获取失败 http=%d code=%d msg=%s%s",
            r.http, code, cut(msg, 160), length(r.err) ? "（" + r.err + "）" : ""));
        return "";
    }
    write_atomic_private(cp, sprintf('%J', { app_id: cfg.app_id, token: tok, expire: now + exp }));
    return tok;
};

/* opts.force_token：应用发送失败重试时强制换 token（token 被吊销/缓存脏的常见场景）。 */
deliver_app = function(cfg, req, force_token) {
    if (!length(cfg.app_id) || !length(cfg.app_secret))
        return { ok: false, retryable: false, code: -6, http: 0, msg: "未配置 app_id/app_secret", bytes: 0, route: "app" };
    if (!length(cfg.chat_id))
        return { ok: false, retryable: false, code: -7, http: 0, msg: "未配置 chat_id（先跑 feishu.uc chats 列群）", bytes: 0, route: "app" };
    let tok = app_token(cfg, force_token ? true : false);
    if (!length(tok))
        return { ok: false, retryable: true, code: -5, http: 0, msg: "tenant_access_token 获取失败", bytes: 0, route: "app" };
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
        return { ok: false, retryable: false, code: -4, http: 0, msg: sprintf("请求体 %d 字节超过 %d 上限", bytes, LIMIT), bytes: bytes, route: "app" };
    let res = parse_result(app_http("POST",
        "/open-apis/im/v1/messages?receive_id_type=chat_id", tok, body));
    res.bytes = bytes;
    res.route = "app";
    return res;
};

deliver_webhook = function(cfg, req) {
    let ts = sprintf("%d", time());
    let sign = length(cfg.secret) ? hmac_sign(ts, cfg.secret) : "";
    if (length(cfg.secret) && !length(sign))
        return { ok: false, retryable: false, code: -3, http: 0, msg: "签名计算失败（openssl 不可用？）", bytes: 0, route: "webhook" };
    let body = signed_body(cfg, req, ts, sign);
    let bytes = length(body);
    if (bytes >= LIMIT)
        return { ok: false, retryable: false, code: -4, http: 0, msg: sprintf("请求体 %d 字节超过 %d 上限", bytes, LIMIT), bytes: bytes, route: "webhook" };
    let res = parse_result(http_post(cfg.webhook, body));
    res.bytes = bytes;
    res.route = "webhook";
    return res;
};

/* 统一出口：按 cfg.use_app 分路线；应用失败只重试一次，然后（若配了 webhook）回退。 */
deliver = function(cfg, req) {
    if (!cfg.use_app)
        return deliver_webhook(cfg, req);

    let first = deliver_app(cfg, req, false);
    if (first.ok)
        return first;

    let last = first;
    if (first.retryable) {
        log("WARN", sprintf("应用机器人发送失败（http=%s code=%s %s），重试一次",
            first.http, first.code, cut(first.msg, 160)));
        last = deliver_app(cfg, req, true);
        if (last.ok) {
            log("INFO", "应用机器人重试成功");
            return last;
        }
    }

    if (cfg.fallback_webhook) {
        log("WARN", sprintf("应用机器人发送失败（http=%s code=%s %s）→ 回退 webhook",
            last.http, last.code, cut(last.msg, 160)));
        let res = deliver_webhook(cfg, req);
        res.reason = "app_failed";
        res.app_code = last.code;
        if (res.ok)
            log("INFO", "已通过 webhook 回退发送成功");
        else
            log("ERROR", sprintf("webhook 回退也失败：http=%s code=%s %s",
                res.http, res.code, cut(res.msg, 160)));
        return res;
    }

    return last;
};

cmd_chats = function(opts) {
    let cfg = load_cfg(opts);
    if (!length(cfg.app_id) || !length(cfg.app_secret)) {
        print("请先配置 app_id / app_secret：\n  uci set prism-router.feishu.app_id=cli_xxx\n  uci set prism-router.feishu.app_secret=xxx\n  uci commit prism-router\n");
        return 2;
    }
    let tok = app_token(cfg);
    if (!length(tok)) {
        print("tenant_access_token 获取失败：检查 app_id/app_secret 与出网\n");
        return 2;
    }
    let r = app_http("GET", "/open-apis/im/v1/chats?page_size=50&user_id_type=open_id", tok, "");
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

// 发一条告警：冷却去重 -> dry-run 只打印 -> 真正发送（失败按可重试入队）
// 返回 {fired, skipped}：skipped=被冷却挡住；fired=本次要发/已发
alert_emit = function(cfg, o, now, key, kind, title, lines, dry) {
    if (!allow_send(o, key, now, cfg.cooldown))
        return { fired: false, skipped: true };
    if (dry) {
        print(sprintf("DRYRUN kind=%s key=%s %s\n", kind, key, title));
        for (let l in lines)
            print("        " + sprintf("%s", l) + "\n");
        return { fired: true, skipped: false };
    }
    let ok = send_text(cfg, alert_text(title, lines), "alert/" + kind + "/" + key).ok;
    return { fired: ok, skipped: false };
};

// 统计 alert_emit 结果（sent / skipped / failed）
track_emit = function(stat, r) {
    if (r.skipped)
        stat.skipped++;
    else if (r.fired)
        stat.sent++;
    else
        stat.failed++;
    return r;
};

// 突增判定：当前小时（history.json 的桶） vs 近 7 日日均/24
// 返回 null = 无法判定（缺 history / 缺 daily / 基线过小）；否则 {cur, base, ratio, days, hit}
spike_info = function(cfg, hist, now) {
    if (cfg == null || num(cfg.spike_ratio) <= 0)
        return null;
    if (hist == null || type(hist) != "object" || type(hist.buckets) != "array")
        return null;
    let p = local_parts(now);
    if (p == null)
        return null;
    let off = tz_offset();
    let cur = 0, nb = 0;
    for (let b in hist.buckets) {
        if (type(b) != "object")
            continue;
        let ts = intv(b.ts);
        if (ts <= 0)
            continue;
        if (ts > 100000000000)
            ts = int(ts / 1000);
        let sod = (ts + off) % 86400;
        if (sod < 0)
            sod += 86400;
        if (int(sod / 3600) != p.h)
            continue;
        cur += num(b.direct_rx) + num(b.direct_tx) + num(b.proxy_rx) + num(b.proxy_tx);
        nb++;
    }
    if (nb == 0)                        // 当前小时还没有桶 -> 不判定
        return null;

    let days = [], sums = [];
    try {
        if (!fs.access(DAILY_DIR))
            return null;
        let ls = fs.lsdir(DAILY_DIR);
        if (type(ls) != "array")
            return null;
        sort(ls);
        for (let f in ls) {
            if (!match(f, /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/))
                continue;
            let day = substr(f, 0, 10);
            if (day >= p.day)            // 今天（以及异常的未来文件）不进基线
                continue;
            let d = read_json(DAILY_DIR + "/" + f);
            if (d == null || type(d) != "object")
                continue;
            let t = (type(d.totals) == "object") ? d.totals : {};
            let bytes = num(t.direct_rx) + num(t.direct_tx) + num(t.proxy_rx) + num(t.proxy_tx);
            if (bytes <= 0)
                continue;
            push(days, day);
            push(sums, bytes);
        }
    } catch (e) {
        return null;
    }
    if (!length(sums))
        return null;
    // 只取最近 SPIKE_DAYS 天
    let total = 0, n = 0;
    for (let i = length(sums) - 1; i >= 0 && n < SPIKE_DAYS; i--) {
        total += sums[i];
        n++;
    }
    if (n <= 0)
        return null;
    let base = (total / n) / 24.0;      // 近 7 日「每小时」均值
    if (base < SPIKE_MIN_BASE)
        return { cur: cur, base: base, ratio: 0, days: n, hit: false };
    let ratio = cur / base;
    return {
        cur: cur, base: base, ratio: ratio, days: n,
        hit: ratio >= num(cfg.spike_ratio)
    };
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

    let now = now_ts();
    let dry = opts.dry_run ? true : false;

    // 免打扰时段：只抑制告警，不影响报表
    let q = in_quiet(cfg.quiet, now);
    if (q != null) {
        log("INFO", sprintf("免打扰时段 %s，跳过全部告警", q.raw));
        print(sprintf("feishu alerts: 免打扰时段 %s，跳过告警\n", q.raw));
        return 0;
    }

    if (!dry && !send_allowed(cfg))
        return 0;

    let state = read_json(opts.state || (BASE + "/state.json"));
    let hist = read_json(opts.history || (BASE + "/history.json"));
    let o = read_alert_state();
    let first = o._first;
    let stat = { sent: 0, skipped: 0, failed: 0 };

    // 1) 服务异常 / 采集降级
    let deg = check_degraded(state, now);
    if (deg)
        track_emit(stat, alert_emit(cfg, o, now, "degraded:service", "degraded", "采集异常/降级", deg.lines, dry));

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
                let lines = [
                    sprintf("设备：%s", device_label(d)),
                    sprintf("标识：%s / %s", length(d.ip) ? d.ip : "?", length(d.mac) ? d.mac : "?")
                ];
                track_emit(stat, alert_emit(cfg, o, now, "newdev:" + k, "new_device", "新设备上线", lines, dry));
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
            let lines = [
                sprintf("设备：%s", device_label(d)),
                sprintf("今日流量：%s（阈值 %s）", fmt_bytes(b.total), fmt_bytes(cfg.device_limit))
            ];
            track_emit(stat, alert_emit(cfg, o, now, "limit:" + k, "device_limit", "设备流量超限", lines, dry));
        }
    }

    // 4) 单个应用 / 域名日流量超限
    if (cfg.app_limit > 0 && state != null && type(state) == "object" && type(state.apps) == "array") {
        for (let a in state.apps) {
            if (type(a) != "object")
                continue;
            let host = trim(sprintf("%s", a.host == null ? "" : a.host));
            if (!length(host))
                continue;
            let bytes = num(a.rx) + num(a.tx);
            if (bytes < cfg.app_limit)
                continue;
            let chain = trim(sprintf("%s", a.chain == null ? "" : a.chain));
            let lines = [
                sprintf("应用：%s", cut(host, 64)),
                sprintf("今日流量：%s（阈值 %s）", fmt_bytes(bytes), fmt_bytes(cfg.app_limit))
            ];
            if (length(chain))
                push(lines, "出口：" + chain);
            track_emit(stat, alert_emit(cfg, o, now, "applimit:" + lc(host), "app_limit", "应用流量超限", lines, dry));
        }
    }

    // 5) 流量突增（当前小时 vs 近 7 日均值）
    let spike = spike_info(cfg, hist, now);
    if (spike != null && spike.hit) {
        let lines = [
            sprintf("当前小时：%s", fmt_bytes(spike.cur)),
            sprintf("近 %d 日均值：%s/小时", spike.days, fmt_bytes(spike.base)),
            sprintf("倍数：%.1f 倍（阈值 %s 倍）", spike.ratio, cfg.spike_ratio)
        ];
        track_emit(stat, alert_emit(cfg, o, now, "spike:hour", "spike", "流量突增", lines, dry));
    }

    // 6) 设备离线超过 N 分钟（以告警状态里记录的最后在线时间为准）
    //    注意：state.json 缺失/无设备时无从判断「离线」，直接跳过（采集异常另有告警，避免刷屏）
    if (cfg.offline_min > 0 && state != null && type(state) == "object" &&
        type(state.devices) == "array") {
        let labels = {};
        for (let d in state.devices) {
            if (type(d) == "object")
                labels[device_key(d)] = device_label(d);
        }
        let limit = cfg.offline_min * 60;
        for (let k in keys(o.devices)) {
            let last = intv(o.devices[k]);
            if (last <= 0 || now - last <= limit)
                continue;
            if (now - last > 7 * 86400)     // 太久没出现交给 30 天清理，不再告警
                continue;
            let lines = [
                sprintf("设备：%s", labels[k] != null ? labels[k] : k),
                sprintf("最后在线：%d 分钟前（阈值 %d 分钟）", int((now - last) / 60), cfg.offline_min)
            ];
            track_emit(stat, alert_emit(cfg, o, now, "offline:" + k, "offline", "设备离线", lines, dry));
        }
    }

    // 7) 软路由系统资源（state.system 缺失 -> 静默跳过）
    let sys = system_metrics(state);
    if (sys != null) {
        let sys_items = [
            { key: "sys:cpu", kind: "sys_cpu", fn: "CPU", cur: sys.cpu_pct, lim: cfg.cpu_pct, pct: true },
            { key: "sys:mem", kind: "sys_mem", fn: "内存", cur: sys.mem_pct, lim: cfg.mem_pct, pct: true },
            { key: "sys:disk", kind: "sys_disk", fn: "磁盘", cur: sys.disk_pct, lim: cfg.disk_pct, pct: true }
        ];
        for (let it in sys_items) {
            if (it.lim == null || it.lim <= 0 || it.cur == null)
                continue;
            if (it.cur < it.lim)
                continue;
            let lines = [
                sprintf("%s使用率：%.1f%%（阈值 %.0f%%）", it.fn, it.cur, it.lim),
                sprintf("负载：%s", sys.load1 != null ? sprintf("%.2f", sys.load1) : "—")
            ];
            track_emit(stat, alert_emit(cfg, o, now, it.key, it.kind, it.fn + "使用率过高", lines, dry));
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
    if (dry) {
        log("INFO", sprintf("告警演练（--dry-run）：将发送 %d 条，冷却跳过 %d 条",
                            stat.sent, stat.skipped));
    } else if (!save_alert_state(o)) {
        log("ERROR", "写告警状态失败：" + alert_state_path());
    } else {
        log("INFO", sprintf("告警检查完成：发送 %d 条，冷却跳过 %d 条，失败 %d 条，清理陈旧设备 %d 台",
                            stat.sent, stat.skipped, stat.failed, pruned));
    }
    if (!dry && opts.webhook == null && queue_count() > 0)
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

// 取出所有 text/markdown 的文本内容（区块标记检测用）
card_texts = function(elements) {
    let out = [];
    if (type(elements) != "array")
        return out;
    for (let el in elements) {
        if (type(el) != "object")
            continue;
        if (el.tag == "markdown" && el.content != null)
            push(out, sprintf("%s", el.content));
        if (type(el.text) == "object" && el.text.content != null)
            push(out, sprintf("%s", el.text.content));
    }
    return out;
};

card_tables = function(elements) {
    let out = [];
    if (type(elements) != "array")
        return out;
    for (let el in elements) {
        if (type(el) == "object" && el.tag == "table")
            push(out, el);
    }
    return out;
};

// 校验一张卡片：items 为「本次应渲染的区块」（默认 = report_items 默认值）
// 数据驱动的区块（system / nodes）缺失只 WARN，不算失败——state.json 里可能本来就没有。
check_card_json = function(raw, items) {
    let fails = 0;
    let msgs = [];
    let bytes = length(raw);
    let want = (type(items) == "array" && length(items)) ? items : ITEMS_DEFAULT;
    let optional = ["system", "nodes"];
    let has_item = function(name) { return index(want, name) >= 0; };
    let trimmed = index(raw, "已裁剪") >= 0;

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
    else
        push(msgs, "WARN  顶层没有 msg_type=interactive（只校验 card 本身）");

    if (type(card) == "object" && card.schema == "2.0")
        push(msgs, "PASS  schema=2.0");
    else {
        push(msgs, "FAIL  schema 不是 2.0");
        fails++;
    }

    let title = "";
    if (type(card) == "object" && type(card.header) == "object" && type(card.header.title) == "object")
        title = trim(sprintf("%s", card.header.title.content == null ? "" : card.header.title.content));
    if (match(title, /^流量(日|周)报 [0-9]{4}-[0-9]{2}-[0-9]{2}$/))
        push(msgs, "PASS  header.title = " + title);
    else {
        push(msgs, "FAIL  header.title 不是「流量日报/流量周报 YYYY-MM-DD」：[" + title + "]");
        fails++;
    }

    let elements = [];
    if (type(card) == "object" && type(card.body) == "object" && type(card.body.elements) == "array")
        elements = card.body.elements;

    let need = 1;                                   // 脚注
    if (has_item("overview"))
        need += 2;                                  // 概览 markdown + 折线图
    if (has_item("proxy_direct"))
        need += 1;
    if (has_item("wifi_wired"))
        need += 1;
    if (!trimmed) {
        if (has_item("top_devices"))
            need += 1;
        if (has_item("top_apps"))
            need += 1;
    }
    if (length(elements) >= need)
        push(msgs, sprintf("PASS  body.elements 共 %d 个元素（期望 >=%d）", length(elements), need));
    else {
        push(msgs, sprintf("FAIL  body.elements 只有 %d 个，期望 >=%d", length(elements), need));
        fails++;
    }

    let tags = [];
    gather_tags(elements, tags);
    let need_markdown = has_item("overview") || has_item("proxy_direct") || has_item("wifi_wired") ||
                        has_item("system") || has_item("nodes");
    for (let want_tag in ["markdown", "chart", "table", "div"]) {
        let must = false;
        if (want_tag == "markdown")
            must = need_markdown && !trimmed;
        else if (want_tag == "chart")
            must = has_item("overview");
        else if (want_tag == "table")
            must = (has_item("top_devices") || has_item("top_apps")) && !trimmed;
        else
            must = true;
        if (index(tags, want_tag) >= 0)
            push(msgs, "PASS  含 " + want_tag + " 组件");
        else if (must) {
            push(msgs, "FAIL  缺少 " + want_tag + " 组件");
            fails++;
        } else
            push(msgs, "WARN  没有 " + want_tag + " 组件（未配置或被体积裁剪）");
    }
    if (index(tags, "note") < 0 && index(tags, "action") < 0)
        push(msgs, "PASS  不含 note/action（2.0 已移除）");
    else {
        push(msgs, "FAIL  含 note/action 组件（2.0 会报 200861）");
        fails++;
    }

    // 区块标记：overview / proxy_direct / wifi_wired / system / nodes 各有一段 markdown
    let joined = join("\n", card_texts(elements));
    let markers = {
        overview: "**总流量**",
        proxy_direct: "**代理 / 直连**",
        wifi_wired: "**无线 / 有线**",
        system: "**系统**",
        nodes: "**代理节点**"
    };
    for (let it in want) {
        if (markers[it] == null)
            continue;
        if (index(joined, markers[it]) >= 0)
            push(msgs, sprintf("PASS  区块 %s 存在（%s）", it, markers[it]));
        else if (index(optional, it) >= 0)
            push(msgs, sprintf("WARN  区块 %s 跳过（state.json 无对应数据，属预期）", it));
        else {
            push(msgs, sprintf("FAIL  缺少区块 %s（找不到 %s）", it, markers[it]));
            fails++;
        }
    }

    // 折线图
    let chart = null, foot = null;
    for (let el in elements) {
        if (type(el) != "object")
            continue;
        if (el.tag == "chart")
            chart = el;
        else if (el.tag == "div" && foot == null)
            foot = el;
    }
    if (chart != null && type(chart.chart_spec) == "object" && chart.chart_spec.type == "line")
        push(msgs, "PASS  chart: 原生折线图");
    else if (has_item("overview")) {
        push(msgs, "FAIL  chart 缺失或不是 line（overview 必带趋势图）");
        fails++;
    } else
        push(msgs, "WARN  未配置 overview，卡片没有折线图");
    if (chart != null) {
        if (type(chart.chart_spec) == "object" &&
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
    }

    // 表格：设备表（host/direct/proxy/total）与应用表（app/chain/total）各自校验
    let dev_table = null, app_table = null;
    for (let tb in card_tables(elements)) {
        let cols = [];
        if (type(tb.columns) == "array") {
            for (let c in tb.columns)
                if (type(c) == "object" && c.name != null)
                    push(cols, c.name);
        }
        let all = function(names, list) {
            for (let n in names)
                if (index(list, n) < 0)
                    return false;
            return true;
        };
        if (all(["host", "direct", "proxy", "total"], cols) && dev_table == null)
            dev_table = tb;
        else if (all(["app", "chain", "total"], cols) && app_table == null)
            app_table = tb;
    }

    let check_table = function(tb, name, cols_want, row_cap) {
        if (tb == null) {
            if (trimmed)
                push(msgs, sprintf("WARN  %s 表被体积裁剪", name));
            else {
                push(msgs, sprintf("FAIL  缺少 %s 表", name));
                fails++;
            }
            return;
        }
        if (tb.page_size == 10)
            push(msgs, sprintf("PASS  %s 表: page_size=10", name));
        else {
            push(msgs, sprintf("FAIL  %s 表 page_size 不是 10", name));
            fails++;
        }
        let cols = [];
        if (type(tb.columns) == "array") {
            for (let c in tb.columns)
                if (type(c) == "object" && c.name != null)
                    push(cols, c.name);
        }
        let ok = true;
        for (let w in cols_want)
            if (index(cols, w) < 0)
                ok = false;
        if (ok)
            push(msgs, sprintf("PASS  %s 表列：%s", name, join("/", cols_want)));
        else {
            push(msgs, sprintf("FAIL  %s 表列缺失：%s", name, join(",", cols)));
            fails++;
        }
        if (type(tb.rows) == "array") {
            if (length(tb.rows) <= row_cap)
                push(msgs, sprintf("PASS  %s 表行数 %d（<=%d）", name, length(tb.rows), row_cap));
            else {
                push(msgs, sprintf("FAIL  %s 表行数 %d 超过 %d", name, length(tb.rows), row_cap));
                fails++;
            }
        } else {
            push(msgs, sprintf("FAIL  %s 表 rows 不是数组", name));
            fails++;
        }
    };
    if (has_item("top_devices"))
        check_table(dev_table, "设备", ["host", "direct", "proxy", "total"], 10);
    if (has_item("top_apps"))
        check_table(app_table, "应用", ["app", "chain", "total"], 10);

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

// 报表去重标记：同一「kind + 日期」只由 scheduled 发一次（--window 容错不会重复发）
report_stamp_path = function() {
    return BASE + "/report-last.json";
};

mark_report_sent = function(kind, day) {
    let p = report_stamp_path();
    let o = read_json(p);
    if (o == null || type(o) != "object")
        o = {};
    o[kind] = { day: day, ts: now_ts() };
    if (!write_atomic(p, jstr(o))) {
        log("WARN", "写报表去重标记失败：" + p);
        return false;
    }
    return true;
};

report_already_sent = function(kind, day) {
    let o = read_json(report_stamp_path());
    if (o == null || type(o) != "object" || type(o[kind]) != "object")
        return false;
    return trim(sprintf("%s", o[kind].day == null ? "" : o[kind].day)) == day;
};

cmd_daily = function(opts) {
    let cfg = load_cfg(opts);
    if (!cfg.enabled && !cfg.force) {
        log("INFO", "feishu.enabled=0，跳过日报");
        return 0;
    }
    // report_items 为空 / 全是未知项 -> 什么都不发（只记日志）
    if (!length(cfg.items)) {
        log("WARN", sprintf("report_items=[%s] 未启用任何区块，跳过日报", cfg.items_raw));
        print("feishu daily: report_items 未启用任何区块"
              + "（overview/proxy_direct/wifi_wired/system/top_devices/top_apps/nodes），已跳过\n");
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
    let nowv = now_ts();
    let ctx = collect(state, hist, nowv);

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
    log("INFO", sprintf("日报生成：kind=%s day=%s items=%s bytes=%d top=%d step=%dh",
        prep.kind, ctx.day, join(",", cfg.items), prep.bytes, prep.top, prep.step));

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
        if (opts.stamp)
            mark_report_sent(prep.kind, ctx.day);
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

// scheduled：cron 入口。按 report_mode / report_time / report_weekday 判定后调用 daily。
// 同一个 kind+日期 只发一次（BASE/report-last.json 去重），配合 --window 容错不会重复。
cmd_scheduled = function(opts) {
    let cfg = load_cfg(opts);
    let nowv = now_ts();
    let due = report_due(cfg, nowv);
    let p = local_parts(nowv);
    let day = p == null ? "" : p.day;

    print(sprintf("feishu scheduled: %s due=%d kind=%s\n",
        due.reason, due.due ? 1 : 0, due.kind));

    if (!due.due) {
        log("INFO", "scheduled：未到发送时间（" + due.reason + "）");
        return 0;
    }
    if (report_already_sent(due.kind, day)) {
        print(sprintf("feishu scheduled: %s %s 已发送过，跳过（去重标记 %s）\n",
            due.kind, day, report_stamp_path()));
        log("INFO", sprintf("scheduled：%s %s 已发送过，跳过", due.kind, day));
        return 0;
    }
    opts.kind = due.kind;
    opts.stamp = true;
    return cmd_daily(opts);
};

cmd_card = function(opts) {
    let cfg = load_cfg(opts);
    if (!length(cfg.items)) {
        print("feishu card: report_items 未启用任何区块，未生成卡片\n");
        return 0;
    }
    let state_path = opts.state || (BASE + "/state.json");
    let hist_path = opts.history || (BASE + "/history.json");
    let ctx = collect(read_json(state_path), read_json(hist_path), now_ts());
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
    print(sprintf("feishu card: %s => %d 字节（上限 %d，占 %.1f%%），items=%s，Top=%d，图表步长 %dh\n",
        out, prep.bytes, LIMIT, prep.bytes * 100.0 / LIMIT, join(",", cfg.items), prep.top, prep.step));
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
    let cfg = load_cfg(opts);
    let items = cfg.items;
    if (opts.items != null)
        items = parse_items(opts.items, false);
    print(sprintf("feishu check: %s（items=%s）\n", path,
        length(items) ? join(",", items) : "none"));
    return check_card_json(fs.readfile(path), items);
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
    print(sprintf("  route     : %s%s\n",
        cfg.use_app ? "app（自建应用机器人）" : "webhook（群自定义机器人）",
        cfg.mode_explicit ? "" : "（mode 未配置：按旧规则自动判定）"));
    print(sprintf("  app       : app_id %s / app_secret %s / chat_id %s\n",
        length(cfg.app_id) ? "已配置" : "未配置",
        length(cfg.app_secret) ? "已配置" : "未配置",
        length(cfg.chat_id) ? cfg.chat_id : "未配置"));
    print(sprintf("  fallback  : %s（应用路线失败时是否回退 webhook）\n",
        cfg.fallback_webhook ? "可用" : "不可用（webhook/secret 未配齐）"));
    let tenc = read_json(BASE + "/feishu-tenant.json");
    if (cfg.use_app)
        print(sprintf("  tenant    : %s\n",
            (tenc != null && length(tenc.token)) ? "已缓存（feishu-tenant.json）" : "未缓存（下次发送时获取）"));
    print(sprintf("  daily_time: %s（旧字段）\n", cfg.daily_time));
    print(sprintf("  items     : %s%s\n",
        length(cfg.items) ? join(",", cfg.items) : "（未启用任何区块，不会发送）",
        cfg.items_explicit ? "" : "（默认，未显式配置）"));
    print(sprintf("  report    : mode=%s time=%s weekday=%d%s\n",
        cfg.report_mode, cfg.report_time, cfg.report_weekday,
        cfg.report_mode == "weekly" || cfg.report_mode == "both"
            ? sprintf("（周%d）", cfg.report_weekday) : ""));
    print(sprintf("  alert     : %s（新设备 %s，设备阈值 %s，冷却 %ds）\n",
        cfg.alert_enabled ? "开" : "关",
        cfg.alert_new_device ? "开" : "关",
        cfg.device_limit > 0 ? fmt_bytes(cfg.device_limit) : "未设置",
        cfg.cooldown));
    print(sprintf("  alert+    : app %s / 突增 %s / 离线 %s / CPU %s / 内存 %s / 磁盘 %s / 免打扰 %s\n",
        cfg.app_limit > 0 ? fmt_bytes(cfg.app_limit) : "关",
        cfg.spike_ratio > 0 ? sprintf("%.1fx", cfg.spike_ratio) : "关",
        cfg.offline_min > 0 ? sprintf("%dmin", cfg.offline_min) : "关",
        cfg.cpu_pct > 0 ? sprintf("%.0f%%", cfg.cpu_pct) : "关",
        cfg.mem_pct > 0 ? sprintf("%.0f%%", cfg.mem_pct) : "关",
        cfg.disk_pct > 0 ? sprintf("%.0f%%", cfg.disk_pct) : "关",
        length(cfg.quiet_raw) ? cfg.quiet_raw : "关"));
    print(sprintf("  daily_dir : %s（突增基线）\n", DAILY_DIR));
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
        print(sprintf("  state.json: 存在（%d 秒前更新）%s\n", now_ts() - intv(st.ts),
            system_metrics(st) != null ? "，含 system 指标" : ""));
    else
        print("  state.json: 缺失\n");
    return 0;
};

cmd_selftest = function() {
    let fails = 0;
    let total = 0;
    let ok = function(msg) { total++; print("  PASS  " + msg + "\n"); };
    let bad = function(msg) { total++; fails++; print("  FAIL  " + msg + "\n"); };
    let eq = function(got, want, msg) {
        if (sprintf("%s", got) == sprintf("%s", want))
            ok(sprintf("%s = %s", msg, got));
        else
            bad(sprintf("%s：期望 [%s] 实际 [%s]", msg, want, got));
    };

    print("== 1. 签名测试向量（官方 ts=1599360473 / secret=demo）==\n");
    let got = hmac_sign(sprintf("%d", SIGN_VECTOR.ts), SIGN_VECTOR.secret);
    print("  期望: " + SIGN_VECTOR.expect + "\n");
    print("  实际: " + got + "\n");
    eq(got, SIGN_VECTOR.expect, "签名算法（key=timestamp+\\n+secret，签空串，Base64）");

    print("== 2. 本地时间换算（不依赖 date 命令的格式差异）==\n");
    let o0 = tz_offset();
    let lp = local_parts(1700000000);            // 2023-11-14 22:13:20 UTC
    if (lp != null && match(lp.day, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) && lp.h >= 0 && lp.h <= 23 &&
        lp.m >= 0 && lp.m <= 59)
        ok(sprintf("local_parts(1700000000) -> %s %02d:%02d（tz=%s 秒）", lp.day, lp.h, lp.m, o0));
    else
        bad("local_parts 返回异常：" + jstr(lp));
    let c0 = civil_from_days(0);
    eq(sprintf("%04d-%02d-%02d", c0.y, c0.m, c0.d), "1970-01-01", "civil_from_days(0)");
    let c1 = civil_from_days(19782);             // 2024-02-29（闰日）
    eq(sprintf("%04d-%02d-%02d", c1.y, c1.m, c1.d), "2024-02-29", "civil_from_days 闰日");
    let base_wd = local_parts(1700000000).wd;
    let next_wd = local_parts(1700000000 + 86400).wd;
    eq(next_wd, (base_wd % 7) + 1, "weekday 逐日递增（1=周一 … 7=周日）");
    eq(day_of(0), "", "epoch=0 视为无效，day_of 返回空串且不崩");

    print("== 3. report_items 解析 ==\n");
    let it_default = parse_items("", true);
    eq(join(",", it_default), join(",", ITEMS_DEFAULT), "空 + 选项缺失 -> 默认清单");
    eq(join(",", parse_items("", false)), "", "空 + 选项存在 -> 什么都不发");
    eq(join(",", parse_items("none", false)), "", "none -> 什么都不发");
    eq(join(",", parse_items("top_apps,overview,top_apps", false)), "top_apps,overview",
       "去重且保持配置顺序");
    eq(join(",", parse_items("overview,bogus,top_devices", false)), "overview,top_devices",
       "未知项被忽略且不报错");

    print("== 4. 报表调度（report_mode / report_time / report_weekday）==\n");
    // 用本地时间造时间戳，保证与路由器时区无关
    let tz = tz_offset();
    let mk = function(day_shift, hh, mm) {
        // 以「今天本地 00:00」为基准偏移
        let p = local_parts(now_ts());
        let base_days = p.days;
        return base_days * 86400 + day_shift * 86400 + hh * 3600 + mm * 60 - tz;
    };
    let cfgd = default_cfg();
    cfgd.report_mode = "daily";
    cfgd.report_time = "08:30";
    let at = mk(0, 8, 30);
    let r = report_due(cfgd, at);
    eq(r.due ? 1 : 0, 1, "daily @ 08:30 -> 到点");
    eq(r.kind, "daily", "daily @ 08:30 的 kind");
    eq(report_due(cfgd, at + 60).due ? 1 : 0, 0, "daily @ 08:31 -> 未到点");
    cfgd.report_time = "8:30";
    eq(report_due(cfgd, at).due ? 1 : 0, 1, "time 写成 8:30 也能解析");
    cfgd.report_time = "25:99";
    eq(report_due(cfgd, at).due ? 1 : 0, 1, "非法 time 回退 08:30 且不崩");
    cfgd.report_time = "08:30";

    let p0 = local_parts(now_ts());
    let target_wd = 1;                              // 周一
    let shift = ((target_wd - p0.wd) % 7 + 7) % 7;  // 距离下一个周一的偏移
    let monday = mk(shift, 8, 30);
    let tuesday = mk(shift + 1, 8, 30);

    let cfgw = default_cfg();
    cfgw.report_mode = "weekly";
    cfgw.report_time = "08:30";
    cfgw.report_weekday = 1;
    r = report_due(cfgw, monday);
    eq(r.due ? 1 : 0, 1, "weekly @ 周一 08:30 -> 到点");
    eq(r.kind, "weekly", "weekly 的 kind");
    eq(report_due(cfgw, tuesday).due ? 1 : 0, 0, "weekly @ 周二 08:30 -> 不发");

    let cfgb = default_cfg();
    cfgb.report_mode = "both";
    cfgb.report_time = "08:30";
    cfgb.report_weekday = 1;
    eq(report_due(cfgb, monday).kind, "weekly", "both @ 周一 -> 周报");
    eq(report_due(cfgb, tuesday).kind, "daily", "both @ 周二 -> 日报");
    eq(report_due(cfgb, tuesday).due ? 1 : 0, 1, "both @ 周二 -> 到点");

    let cfgwin = default_cfg();
    cfgwin.report_time = "08:30";
    cfgwin.window = 10;
    eq(report_due(cfgwin, mk(0, 8, 39)).due ? 1 : 0, 1, "--window 10 覆盖 08:39");
    eq(report_due(cfgwin, mk(0, 8, 41)).due ? 1 : 0, 0, "--window 10 不覆盖 08:41");

    print("== 5. 免打扰时段 ==\n");
    let qw = quiet_parse("23:00-07:00,12:00-13:30");
    eq(length(qw), 2, "解析出两个免打扰窗口");
    eq(in_quiet(qw, mk(0, 23, 30)) != null ? 1 : 0, 1, "23:30 命中跨零点窗口");
    eq(in_quiet(qw, mk(0, 3, 0)) != null ? 1 : 0, 1, "03:00 命中跨零点窗口");
    eq(in_quiet(qw, mk(0, 7, 0)) != null ? 1 : 0, 0, "07:00 已离开窗口");
    eq(in_quiet(qw, mk(0, 12, 30)) != null ? 1 : 0, 1, "12:30 命中午间窗口");
    eq(in_quiet(qw, mk(0, 14, 0)) != null ? 1 : 0, 0, "14:00 不在窗口");
    eq(length(quiet_parse("")), 0, "空字符串 -> 无窗口（不报错）");
    eq(length(quiet_parse("garbage,23:00")), 0, "非法窗口被忽略（不报错）");

    print("== 6. 告警冷却去重 ==\n");
    let o = { devices: {}, cooldown: {} };
    let t0 = 1700000000;
    eq(allow_send(o, "k1", t0, 1800) ? 1 : 0, 1, "首次允许发送");
    eq(allow_send(o, "k1", t0 + 60, 1800) ? 1 : 0, 0, "冷却期内被挡住");
    eq(allow_send(o, "k1", t0 + 1800, 1800) ? 1 : 0, 1, "冷却结束后再次允许");
    eq(allow_send({cooldown:{}}, "k2", t0, 1800) ? 1 : 0, 1, "不同目标互不影响");

    print("== 7. 卡片结构（内置样例，不联网）==\n");
    let now = now_ts();
    let state = {
        "ts": now - 5,
        "uptime": 36000,
        "source": { "clash": "ok", "conntrack": "ok" },
        "totals": {
            "direct_rx": 1234567890, "direct_tx": 1234567,
            "proxy_rx": 9876543210, "proxy_tx": 76543210,
            "wifi_rx": 5000000000, "wifi_tx": 500000,
            "wired_rx": 6000000000, "wired_tx": 8000000,
            "unknown_rx": 1000000, "unknown_tx": 10000,
            "rx_rate": 12500000, "tx_rate": 980000
        },
        "nodes": {
            "US2-HY2": { "rx": 8000000000, "tx": 60000000 },
            "JP1-Tokyo": { "rx": 3000000000, "tx": 20000000 },
            "HK-HKT": { "rx": 1000000000, "tx": 10000000 },
            "DIRECT": { "rx": 1234567890, "tx": 1234567 }
        },
        "system": {
            "cpu_pct": 23, "mem_pct": 41, "load1": 0.52, "load5": 0.48, "load15": 0.40,
            "disk_pct": 63, "temp_c": 48, "uptime": 273600,
            "mem_total": 12884901888, "mem_used": 5282809774
        },
        "devices": [],
        "apps": [
            { "host": "ws.chatgpt.com", "rx": 900000000, "tx": 5000000, "chain": "US2-HY2", "devices": 2 },
            { "host": "www.bilibili.com", "rx": 700000000, "tx": 2000000, "chain": "DIRECT", "devices": 3 },
            { "host": "github.com", "rx": 300000000, "tx": 1000000, "chain": "JP1-Tokyo", "devices": 1 }
        ],
        "health": { "accounting_confidence": "exact", "reasons": [], "conntrack_count": 1800 }
    };
    for (let i = 1; i <= 12; i++) {
        push(state.devices, {
            "ip": sprintf("192.168.100.%d", 100 + i),
            "mac": sprintf("dc:56:7b:89:fb:%02x", i),
            "hostname": "device-" + i,
            "link": (i % 2 == 0) ? "wifi" : "wired",
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
    let ctx = collect(state, { "day": day_of(now), "buckets": buckets }, now);
    let base = default_cfg();
    base.secret = SIGN_VECTOR.secret;

    let prep = prepare_daily(ctx, base);
    if (prep == null) {
        bad("默认 report_items 无法生成卡片");
        print(sprintf("\n自检结果：FAIL（%d 项失败 / 共 %d 项）\n", fails, total));
        return 1;
    }
    print(sprintf("  默认 items=%s Top=%d step=%dh bytes=%d（样例总量 %s）\n",
        join(",", base.items), prep.top, prep.step, prep.bytes, fmt_bytes(ctx.total)));
    fails += check_card_json(signed_body({ secret: SIGN_VECTOR.secret },
        { "msg_type": "interactive", "card": prep.card }, prep.ts, prep.sign), base.items);

    // 只配 overview：不应出现代理/直连、无线/有线、表格
    base.items = parse_items("overview", false);
    let p1 = prepare_daily(ctx, base);
    let b1 = p1 == null ? "" : p1.body;
    eq(index(b1, "**总流量**") >= 0 ? 1 : 0, 1, "items=overview：含总流量");
    eq(index(b1, "**代理 / 直连**") >= 0 ? 1 : 0, 0, "items=overview：不含代理/直连区块");
    eq(index(b1, "**无线 / 有线**") >= 0 ? 1 : 0, 0, "items=overview：不含无线/有线区块");
    eq(index(b1, "\"tag\":\"table\"") >= 0 ? 1 : 0, 0, "items=overview：不含表格");
    eq(index(b1, "\"tag\":\"chart\"") >= 0 ? 1 : 0, 1, "items=overview：含折线图");

    // 只配 top_apps：不应有图表/设备表，必须有应用表
    base.items = parse_items("top_apps", false);
    let p2 = prepare_daily(ctx, base);
    let b2 = p2 == null ? "" : p2.body;
    eq(index(b2, "\"tag\":\"chart\"") >= 0 ? 1 : 0, 0, "items=top_apps：不含折线图");
    eq(index(b2, "\"app\":\"ws.chatgpt.com\"") >= 0 ? 1 : 0, 1, "items=top_apps：含应用行");
    eq(index(b2, "\"host\":\"device-12\"") >= 0 ? 1 : 0, 0, "items=top_apps：不含设备行");
    eq(index(b2, "**代理节点**") >= 0 ? 1 : 0, 0, "items=top_apps：不含节点区块");

    // 全开 + 顺序：nodes 必须在 overview 之前出现
    base.items = parse_items("nodes,overview,proxy_direct,wifi_wired,system,top_devices,top_apps", false);
    let p3 = prepare_daily(ctx, base);
    let b3 = p3 == null ? "" : p3.body;
    eq(length(base.items), 7, "全开清单 7 个区块");
    eq(index(b3, "**代理节点**") >= 0 ? 1 : 0, 1, "全开：含节点区块");
    eq(index(b3, "**系统**") >= 0 ? 1 : 0, 1, "全开：含系统区块");
    eq(index(b3, "**代理 / 直连**") >= 0 ? 1 : 0, 1, "全开：含代理/直连区块");
    ok(sprintf("全开卡片 %d 字节 < %d", length(b3), LIMIT_BODY));
    eq(index(b3, "\"tag\":\"note\"") < 0 && index(b3, "\"tag\":\"action\"") < 0 ? 1 : 0, 1,
       "全开卡片不含 note/action");
    if (index(b3, "**代理节点**") < index(b3, "**总流量**"))
        ok("区块按 report_items 顺序渲染（nodes 在 overview 之前）");
    else
        bad("区块顺序未按 report_items 渲染");

    // state.system 缺失 -> system 区块静默跳过，其它区块照常
    let st2 = json(sprintf("%J", state));
    delete st2.system;
    let ctx2 = collect(st2, { "day": day_of(now), "buckets": buckets }, now);
    base.items = parse_items("overview,system", false);
    let p4 = prepare_daily(ctx2, base);
    if (p4 != null && index(p4.body, "**系统**") < 0 && index(p4.body, "**总流量**") >= 0)
        ok("state.system 缺失：system 区块自动跳过且不报错");
    else
        bad("state.system 缺失时行为不对");
    eq(ctx2.system == null ? 1 : 0, 1, "state.system 缺失 -> ctx.system 为 null");

    // 体积超限时仍然逐级裁剪到 20480 以内（用很小的 limit 模拟）
    let old_limit = LIMIT;
    LIMIT = 3000;
    base.items = parse_items("", true);
    let p5 = prepare_daily(ctx, base);
    LIMIT = old_limit;
    if (p5 != null && p5.bytes < 3000)
        ok(sprintf("limit=3000 时裁剪到 %d 字节（Top=%d step=%dh）", p5.bytes, p5.top, p5.step));
    else
        bad("limit=3000 时未能裁剪到上限内");

    print("== 8. 告警阈值解析（空值不能报错）==\n");
    let c = load_cfg({});
    eq(c.app_limit, 0, "alert_app_daily_limit 缺省 -> 0（关闭）");
    eq(c.spike_ratio, 0, "alert_spike_ratio 缺省 -> 0（关闭）");
    eq(c.offline_min, 0, "alert_offline_min 缺省 -> 0（关闭）");
    eq(c.cpu_pct, 0, "alert_cpu_pct 缺省 -> 0（关闭）");
    eq(c.mem_pct, 0, "alert_mem_pct 缺省 -> 0（关闭）");
    eq(c.disk_pct, 0, "alert_disk_pct 缺省 -> 0（关闭）");
    eq(length(c.quiet), 0, "alert_quiet_hours 缺省 -> 无免打扰");
    eq(parse_size("20G"), 21474836480, "阈值 20G 解析");
    eq(parse_size("512M"), 536870912, "阈值 512M 解析");
    eq(system_metrics({}) == null ? 1 : 0, 1, "state 无 system -> system_metrics=null");

    print("== 9. JSON 压缩器往返 ==\n");
    let sample = { "a": "x y", "b": "q\"z", "c": "\\", "d": "中文", "e": [1, 2, { "f": true }] };
    let mini = jstr(sample);
    let back = null;
    try { back = json(mini); } catch (e) { }
    eq(back != null && jstr(back) == mini ? 1 : 0, 1, "紧凑 JSON 可被重新解析且内容一致");

    print("== 10. 发送路线（webhook / app）判定 ==\n");
    let wh = "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000";
    let cw = default_cfg();
    cw.webhook = wh; cw.secret = "s";
    eq(send_allowed(cw, true) ? 1 : 0, 1, "webhook 齐全 -> 允许发送");
    let cnone = default_cfg();
    eq(send_allowed(cnone, true) ? 1 : 0, 0, "webhook 未配置 -> 跳过（不报错）");
    let capp = default_cfg();
    capp.use_app = true; capp.app_id = "cli_x"; capp.app_secret = "sec"; capp.chat_id = "oc_x";
    eq(send_allowed(capp, true) ? 1 : 0, 1, "app 路线不要求 webhook/secret");
    capp.enabled = false;
    eq(send_allowed(capp, false) ? 1 : 0, 0, "app 路线同样遵守 enabled=0");
    eq(send_allowed(capp, true) ? 1 : 0, 1, "ignore_enabled（test 子命令）无视 enabled=0");
    let cbad = default_cfg();
    cbad.use_app = true;
    eq(send_allowed(cbad, true) ? 1 : 0, 0, "mode=app 但缺 app_id/app_secret -> 跳过");
    eq(token_ok("t-abcdef123456") ? 1 : 0, 1, "token 字符集校验：正常 token 通过");
    eq(token_ok("bad\"token\\here") ? 1 : 0, 0, "token 字符集校验：引号/反斜杠被拒");
    eq(length(api_base()) > 0 ? 1 : 0, 1, "api_base() 返回可用的 base URL");

    print(sprintf("\n自检结果：%s（%d 项失败 / 共 %d 项）\n", fails ? "FAIL" : "PASS", fails, total));
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
    print("feishu.uc " + VERSION + " — 飞书群机器人推送（日报 / 告警，内容·时间·条件均可配）\n\n");
    print("用法：\n");
    print("  ucode feishu.uc daily [--dry-run] [--out FILE]   立即生成并发送（忽略 report_time）\n");
    print("  ucode feishu.uc scheduled [--window N]           按 report_mode/time/weekday 判定，到点才发\n");
    print("  ucode feishu.uc card [--out FILE]                只生成卡片（默认 /tmp/card.json）\n");
    print("  ucode feishu.uc alerts [--dry-run]               扫描 state.json 并发送告警\n");
    print("  ucode feishu.uc test [--text TEXT]               发送连通性测试\n");
    print("  ucode feishu.uc selftest                         离线自检（签名 + 卡片 + 调度 + 告警判定）\n");
    print("  ucode feishu.uc check [FILE]                     校验卡片文件结构/体积\n");
    print("  ucode feishu.uc retry [--now]                    处理重试队列\n");
    print("  ucode feishu.uc status                           查看配置与队列\n");
    print("  ucode feishu.uc chats                            列出应用机器人所在的群（chat_id + 群名）\n");
    print("  ucode feishu.uc sign <timestamp> <secret>        打印签名（调试）\n\n");
    print("内容：--items overview,proxy_direct,wifi_wired,system,top_devices,top_apps,nodes\n");
    print("时间：--at \"YYYY-MM-DD HH:MM\" / --epoch N（注入「现在」）、--window N（分钟容错）、\n");
    print("      --mode daily|weekly|both、--time HH:MM、--weekday 1-7、--kind daily|weekly\n");
    print("条件：--app-limit 20G、--spike-ratio 3、--offline-min 30、--cpu 90、--mem 90、--disk 90、\n");
    print("      --quiet 23:00-07:00、--device-limit 40G\n");
    print("其它：--base DIR（默认 /tmp/prism-router）、--state FILE、--history FILE、\n");
    print("      --daily-dir DIR（默认 /etc/prism-router/daily）、--limit BYTES、\n");
    print("      --webhook URL、--secret SECRET（测试用，不写 UCI）、--chat CHAT_ID、--force\n");
    print("发送路线：prism-router.feishu.mode=webhook|app（默认 webhook；app 需 app_id/app_secret，\n");
    print("          chat_id 可用「扫码绑定」或 chats 子命令获得）\n");
    return 0;
};

// ───────────────────────────── 入口 ─────────────────────────────

parse_args = function(argv) {
    let o = {
        cmd: "help",
        dry_run: false,
        force: false,
        now: false,
        stamp: false,
        base: "",
        state: "",
        history: "",
        card_out: "/tmp/card.json",
        limit: LIMIT_BODY,
        device_limit: null,
        webhook: null,
        secret: null,
        chat: null,
        text: "",
        path: "",
        sign_ts: "",
        sign_secret: null,
        // 内容 / 时间 / 条件（仅本次运行，不写 UCI）
        items: null,
        at: "",
        epoch: 0,
        window: null,
        mode: null,
        time: null,
        weekday: null,
        kind: null,
        app_limit: null,
        spike_ratio: null,
        offline_min: null,
        cpu: null,
        mem: null,
        disk: null,
        quiet: null,
        daily_dir: ""
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
        } else if (a == "--items" && i + 1 < length(argv)) {
            o.items = argv[++i];
        } else if (a == "--at" && i + 1 < length(argv)) {
            o.at = argv[++i];
        } else if (a == "--epoch" && i + 1 < length(argv)) {
            o.epoch = intv(argv[++i]);
        } else if (a == "--window" && i + 1 < length(argv)) {
            o.window = argv[++i];
        } else if (a == "--mode" && i + 1 < length(argv)) {
            o.mode = argv[++i];
        } else if (a == "--time" && i + 1 < length(argv)) {
            o.time = argv[++i];
        } else if (a == "--weekday" && i + 1 < length(argv)) {
            o.weekday = argv[++i];
        } else if (a == "--kind" && i + 1 < length(argv)) {
            o.kind = argv[++i];
        } else if (a == "--app-limit" && i + 1 < length(argv)) {
            o.app_limit = argv[++i];
        } else if (a == "--spike-ratio" && i + 1 < length(argv)) {
            o.spike_ratio = argv[++i];
        } else if (a == "--offline-min" && i + 1 < length(argv)) {
            o.offline_min = argv[++i];
        } else if (a == "--cpu" && i + 1 < length(argv)) {
            o.cpu = argv[++i];
        } else if (a == "--mem" && i + 1 < length(argv)) {
            o.mem = argv[++i];
        } else if (a == "--disk" && i + 1 < length(argv)) {
            o.disk = argv[++i];
        } else if (a == "--quiet" && i + 1 < length(argv)) {
            o.quiet = argv[++i];
        } else if (a == "--daily-dir" && i + 1 < length(argv)) {
            o.daily_dir = argv[++i];
        } else if (a == "--webhook" && i + 1 < length(argv)) {
            o.webhook = argv[++i];
        } else if (a == "--secret" && i + 1 < length(argv)) {
            o.secret = argv[++i];
        } else if (a == "--chat" && i + 1 < length(argv)) {
            o.chat = argv[++i];
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
if (length(opts.daily_dir) && match(opts.daily_dir, /^\/[A-Za-z0-9._\/-]+$/))
    DAILY_DIR = opts.daily_dir;
// 注入「现在」：--epoch 直接给秒；--at 用 date 解析（失败则忽略，不报错）
if (opts.epoch > 0)
    NOW_OVERRIDE = opts.epoch;
else if (length(opts.at)) {
    let r = run(sprintf("date -d %s +%%s 2>/dev/null", shq(opts.at)));
    let v = intv(trim(r.out));
    if (v > 0)
        NOW_OVERRIDE = v;
    else
        print(sprintf("无法解析 --at %s（已忽略，使用当前时间）\n", opts.at));
}

let rc = 0;
if (opts.cmd == "daily")
    rc = cmd_daily(opts);
else if (opts.cmd == "scheduled" || opts.cmd == "cron")
    rc = cmd_scheduled(opts);
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
