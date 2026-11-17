#!/usr/bin/ucode
// retention.uc — OpenWrt 棱镜路由插件的数据 / 日志保留与清理策略
//
// 负责：按保留天数清理 /etc/prism-router 下的历史数据、截断 /tmp 下过大的日志、
//       限制飞书重试队列的总量。所有阈值来自 UCI section `retention`。
// 依赖：ucode（fs / uci 内建）。不需要 curl / openssl / python3 / jq。
// 环境：iStoreOS 24.10（x86_64/musl），风格与 prism-routerd.uc / feishu.uc 一致。
//
// 清理范围（**白名单硬编码**，配置里没有任何路径项，所以不可能被配置改到系统目录）：
//   /etc/prism-router/daily/         按 retention.daily_days       默认 400 天
//   /etc/prism-router/nodes/         按 retention.nodes_days       默认 30 天
//   /etc/prism-router/stations/      按 retention.stations_days    默认 7 天
//   /tmp/prism-router/*.log          按 retention.log_days         默认 7 天
//   /tmp/prism-router/*.log          超过 retention.log_max_kb     默认 512 KB → 只留尾部一半
//   /tmp/prism-router/feishu-queue/  总量超过 retention.spool_max_kb 默认 2048 KB → 从最旧删起
//
// 用法（安装后位于 /usr/share/prism-router/retention.uc，见 prism-router/Makefile）：
//   ucode /usr/share/prism-router/retention.uc              # 按配置清理一次
//   ucode /usr/share/prism-router/retention.uc --dry-run    # 只打印清单，不动文件
//   ucode /usr/share/prism-router/retention.uc --selftest   # 离线自检（日期解析 / 白名单判定）
//   ucode /usr/share/prism-router/retention.uc --help
//
// 定时调用（cron **由用户自己加**，本脚本不改 crontab）：
//   # 每天凌晨 3:30 清理一次；stdout 是给人/脚本看的清单，cron 里丢掉即可
//   30 3 * * * /usr/bin/ucode /usr/share/prism-router/retention.uc >/dev/null 2>&1
//
// 输出契约（机器可读）：
//   * 每个动作一行，全部以 "retention: " 开头；dry-run 时动词前多一个 "将"
//     （"retention: 将删除 ..."）。WARN 行同样走 stdout，前缀 "retention: WARN "。
//   * **最后一行**固定是摘要（清理模式下 stdout 的最后一行永远是这个）：
//       retention: files_deleted=N bytes_freed=M logs_truncated=K
//     files_deleted = 实际删除的文件数（含飞书队列条目）；bytes_freed = 释放的字节数
//     （删除 + 截断）；logs_truncated = 被截断的日志个数。
//     dry-run 下这三个值都是 0（确实没动任何文件），计划量另有
//       retention: dry-run：计划删除 P 个文件、截断 T 个日志，共 B 字节（未改动任何文件）
//   * 无论有没有东西可删都 exit 0（cron 不会因此发邮件）；单个文件失败只 WARN 并继续。
//
// 判定规则（与 docs/SPEC.md §9 一致）：
//   * 文件名能解析出 YYYY-MM-DD（如 2026-11-15.json）→ 按日期算年龄；否则按 mtime 算。
//     年龄 > 保留天数 才删（恰好等于保留天数的不删）。日期按**本地时区**解释。
//   * 保留天数 = 0 表示关闭该目录 / 该项的按天清理（安全阀：配置写成 0 不会把数据删空）。
//     同理 log_max_kb = 0 关闭截断、spool_max_kb = 0 关闭队列上限。
//   * 只处理白名单目录的**直接子文件**：目录本身、符号链接、子目录、设备文件一律跳过不删。
//   * 删除前用 realpath 复核：真实路径必须正好是 `<root>/<name>` 且落在白名单根下；
//     白名单根本身也不能是符号链接（防 /etc/prism-router/daily -> /etc 这种偷梁换柱）。
//   * 日志截断用「同目录临时文件 + rename」原子替换，不会留下半截文件；保留尾部，
//     若起点切在半行上则丢掉这半行（最多丢一行）。
//   * 飞书队列按 mtime 从最旧删起；`*.processing`（正在投递中）跳过，避免删掉发送中的条目。
//
// 调试参数（仅本次运行，**不写 UCI**）：
//   --dry-run、--epoch N（注入「现在」，秒）
//   --daily-days N --nodes-days N --stations-days N --log-days N
//   --log-max-kb N --spool-max-kb N
//   --daily-dir DIR --nodes-dir DIR --stations-dir DIR --log-dir DIR --queue-dir DIR
//   （目录覆盖也必须落在 /etc/prism-router 或 /tmp/prism-router 之下，否则拒绝——
//     防止手滑把清理范围指到系统目录；被拒绝只 WARN 并跳过该目录，其它目录照常）
//
// 设计取舍：
//   * 宁可少删不可多删：任何可疑情况（realpath 不符、不是普通文件、目录是软链）都跳过。
//   * 单个文件失败不中断：WARN 进 stdout + /tmp/prism-router/retention.log + syslog。
//   * 脚本自己的日志 retention.log 也在 *.log 清理范围内，会被一起截断，不会无限增长。
//
// 注意（ucode 的坑，别按 C/JS 直觉改）：ucode 在**函数定义处**绑定标识符，所以每个
// 被调用的函数 / 常量都必须先定义再被调用（没有函数声明提升）。本文件的顺序是刻意排的：
// 基础工具 → 时间 → 路径 → 输出 → 安全 → UCI → 清理 → 入口。

const fs = require("fs");

const VERSION = "1.0.0";

/* 白名单父目录：配置里没有路径项，清理范围不可能被改到系统目录 */
const ETC_ROOT = "/etc/prism-router";
const TMP_ROOT = "/tmp/prism-router";

const DEFAULT_DIRS = {
	daily:    ETC_ROOT + "/daily",
	nodes:    ETC_ROOT + "/nodes",
	stations: ETC_ROOT + "/stations",
	logs:     TMP_ROOT,
	queue:    TMP_ROOT + "/feishu-queue"
};

/* 全部默认值与 prism-router.config 的 retention 段保持一致 */
const DEFAULTS = {
	enabled: true,
	daily_days: 400,
	nodes_days: 30,
	stations_days: 7,
	log_days: 7,
	log_max_kb: 512,
	spool_max_kb: 2048,
	dry_run: false
};

const MAX_DAYS   = 36500;      /* 100 年：离谱配置直接回落到默认值 */
const MAX_KB     = 16777216;   /* 16 GB */
const READ_CHUNK = 65536;

let CFG = null;
let NOW = 0;
let TODAY = 0;
let LOG_FILE = null;
let _tz = null;
let _seq = 0;
let _uci = null;
let _uci_broken = false;

/* 摘要行与 dry-run 计划行共用的计数 */
const STATS = {
	files_deleted: 0,
	bytes_freed: 0,
	logs_truncated: 0,
	planned_files: 0,
	planned_bytes: 0,
	planned_truncs: 0
};

/* ───────────────────────────── 基础工具 ───────────────────────────── */

/* 执行命令并取回 stdout：{code, out} */
function run(cmd) {
	const p = fs.popen(cmd, "r");
	let out = "", buf = "";

	if (!p)
		return { code: -1, out: "" };

	try {
		while (length((buf = p.read(4096))) > 0)
			out += buf;
	} catch (e) {
		/* 读失败也要把子进程收掉 */
	}

	return { code: p.close(), out: out };
}

/* 单引号 shell 转义（换行 / $ / 反引号 / 引号都会被安全包住） */
function shq(s) {
	return "'" + replace(sprintf("%s", s), "'", "'\\''") + "'";
}

/* 大小显示成 KB（向上取整，0 也显示 0） */
function kb_text(n) {
	n = int(n);

	if (n <= 0)
		return "0";

	return sprintf("%d", int((n + 1023) / 1024));
}

/* ───────────────────────────── 时间 / 日期 ───────────────────────────── */

/* 本地时区偏移（秒）：用 date +%z，避免依赖 ucode 的时区能力 */
function tz_offset() {
	if (_tz != null)
		return _tz;

	const s = trim(run("date +%z 2>/dev/null").out);

	if (match(s, /^[+-][0-9]{4}$/)) {
		const sign = (substr(s, 0, 1) == "-") ? -1 : 1;

		_tz = sign * (int(substr(s, 1, 2)) * 3600 + int(substr(s, 3, 2)) * 60);
	} else {
		_tz = 0;
	}

	return _tz;
}

/* 1970-01-01 起的天数 -> 公历（Howard Hinnant 算法，feishu.uc 同款） */
function civil_from_days(days) {
	const z = int(days) + 719468;
	const era = (z >= 0 ? z : z - 146096) / 146097;
	const doe = z - era * 146097;
	const yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	const y = yoe + era * 400;
	const doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	const mp = (5 * doy + 2) / 153;
	const d = doy - (153 * mp + 2) / 5 + 1;
	const m = (mp < 10) ? mp + 3 : mp - 9;

	return { y: y + ((m <= 2) ? 1 : 0), m: m, d: d };
}

/* 公历 -> 1970-01-01 起的天数（civil_from_days 的逆运算） */
function days_from_civil(y, m, d) {
	y = int(y); m = int(m); d = int(d);

	if (m <= 2)
		y -= 1;

	const era = (y >= 0 ? y : y - 399) / 400;
	const yoe = y - era * 400;
	const doy = (153 * (m + ((m > 2) ? -3 : 9)) + 2) / 5 + d - 1;
	const doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;

	return era * 146097 + doe - 719468;
}

/* 本地时间拆分：{ day:"YYYY-MM-DD", h, m, s, days } */
function local_parts(epoch) {
	const t = int(epoch) + tz_offset();
	let sod = t % 86400;

	if (sod < 0)
		sod += 86400;

	const days = (t - sod) / 86400;
	const c = civil_from_days(days);

	return {
		day: sprintf("%04d-%02d-%02d", int(c.y), int(c.m), int(c.d)),
		h: int(sod / 3600), m: int((sod % 3600) / 60), s: int(sod % 60),
		days: days
	};
}

function ts_text(epoch) {
	const p = local_parts(epoch);

	return sprintf("%s %02d:%02d:%02d", p.day, p.h, p.m, p.s);
}

/* 文件名里的日期：YYYY-MM-DD[.后缀] -> 天序号；解析不了 / 日期非法返回 null。
   只认 4-2-2 位，并且用公历往返校验（2026-02-30 这种会被退回），
   免得把 node-a.json / q-1794700000-1-0.json 之类的名字误当日期。 */
function parse_day_name(name) {
	const m = match(name, /^([0-9]{4})-([0-9]{2})-([0-9]{2})(\.[A-Za-z0-9._-]+)?$/);

	if (!m)
		return null;

	const y = int(m[1]), mo = int(m[2]), d = int(m[3]);

	if (mo < 1 || mo > 12 || d < 1 || d > 31)
		return null;

	const z = days_from_civil(y, mo, d);
	const c = civil_from_days(z);

	if (int(c.y) != y || int(c.m) != mo || int(c.d) != d)
		return null;

	return z;
}

/* ───────────────────────────── 路径与安全校验 ───────────────────────────── */

/* 规范化：去掉尾部多余的 /（配置里写成 /tmp/x/ 也算合法） */
function norm_dir(p) {
	p = trim(sprintf("%s", (p == null) ? "" : p));

	while (length(p) > 1 && substr(p, length(p) - 1) == "/")
		p = substr(p, 0, length(p) - 1);

	return p;
}

/* 只接受安全的绝对路径：字符白名单 + 不允许 . / .. 段（手写防御，不靠 realpath 兜底） */
function path_ok(p) {
	if (!match(p, /^\/[A-Za-z0-9._\/-]+$/))
		return false;

	for (let seg in split(p, "/")) {
		if (seg == "." || seg == "..")
			return false;
	}

	return true;
}

/* path 是否在 parent 之下（含 path == parent） */
function root_under(path, parent) {
	if (path == parent)
		return true;

	return substr(path, 0, length(parent) + 1) == parent + "/";
}

/* ───────────────────────────── 输出（清单 / 日志 / WARN）───────────────────────────── */

/* 动作日志：写 /tmp/prism-router/retention.log；目录不可用就只留 stdout */
function logline(level, msg) {
	if (LOG_FILE == null)
		return;

	const line = sprintf("%s [%s] retention: %s\n", ts_text(NOW), level, msg);

	try {
		const fd = fs.open(LOG_FILE, "a");

		if (fd) {
			fd.write(line);
			fd.close();
		}
	} catch (e) {
		/* 日志写不进去不影响清理 */
	}
}

/* 一行清单：stdout + retention.log */
function act(verb, path, note) {
	const msg = sprintf("%s %s（%s）", verb, path, note);

	print("retention: " + msg + "\n");
	logline("INFO", msg);
}

/* 失败不中断：stdout（前缀固定）+ retention.log + syslog。
   全部走 stdout 是刻意的：这样在 `2>&1` 下摘要仍是最后一行，顺序确定。 */
function warnf(msg) {
	print("retention: WARN " + msg + "\n");
	logline("WARN", msg);
	run(sprintf("logger -t prism-router-retention -p daemon.warn %s 2>/dev/null",
		shq("retention: " + msg)));
}

/* ───────────────────────────── 白名单校验 / 安全删除 ───────────────────────────── */

/* 白名单内的安全删除：返回 {ok:true,size} 或 {ok:false,why}。
 * 只有「普通文件 + realpath 正好等于 <root>/<name> 且仍在 root 下」才删。 */
function safe_unlink(root, name) {
	if (!length(name) || name == "." || name == ".." || index(name, "/") >= 0)
		return { ok: false, why: "文件名非法" };

	const path = root + "/" + name;
	const st = fs.lstat(path);

	if (st == null)
		return { ok: false, why: "已不存在" };

	if (st.type != "file")
		return { ok: false, why: "不是普通文件（" + st.type + "）" };

	const rp = fs.realpath(path);

	if (rp == null || rp != path || !root_under(rp, root))
		return { ok: false, why: "realpath 越界：" + sprintf("%s", rp) };

	let done = false;

	try {
		done = (fs.unlink(path) != null);
	} catch (e) {
		done = false;
	}

	if (!done)
		return { ok: false, why: "unlink 失败" };

	return { ok: true, size: st.size };
}

/* 解析并校验一个白名单根目录：
 *   - 必须是规范绝对路径、且位于 parent 之下（字符串层面就不可能越界）
 *   - 目录不存在 -> 静默跳过（还没产生数据，正常）
 *   - 不是普通目录 / 是符号链接 -> WARN 并跳过
 *   - realpath（解掉 parent 可能的软链）必须正好等于 parent_real + 剩余路径
 * 返回可用的根路径，或 null（表示本次不碰这个目录）。 */
function check_root(dir, parent, label) {
	const path = norm_dir(dir);

	if (!length(path) || !path_ok(path)) {
		warnf(sprintf("%s 目录 [%s] 不是规范的绝对路径，跳过", label, path));
		return null;
	}

	if (!root_under(path, parent)) {
		warnf(sprintf("拒绝 %s 目录 %s：不在白名单 %s 之下", label, path, parent));
		return null;
	}

	const st = fs.lstat(path);

	if (st == null)
		return null;

	/* ucode 的 lstat 类型串是 "directory" / "file" / "link" / ... ; 符号链接不算 */
	if (st.type != "directory") {
		warnf(sprintf("%s 目录 %s 不是普通目录（%s），跳过", label, path, st.type));
		return null;
	}

	const rp = fs.realpath(path);
	const pr = fs.realpath(parent);

	if (rp == null || pr == null) {
		warnf(sprintf("%s 目录 %s 无法 realpath，跳过", label, path));
		return null;
	}

	const want = (path == parent) ? pr : pr + substr(path, length(parent));

	if (rp != want) {
		warnf(sprintf("拒绝 %s 目录 %s：realpath=%s，疑似符号链接", label, path, rp));
		return null;
	}

	return path;
}

/* ───────────────────────────── UCI 配置 ───────────────────────────── */

function uci_cursor() {
	if (!_uci_broken && _uci == null) {
		try {
			_uci = require("uci").cursor();
		} catch (e) {
			_uci_broken = true;
			_uci = null;
		}
	}

	return _uci;
}

function uci_get(key) {
	const parts = split(key, ".");
	const c = uci_cursor();

	if (c != null && length(parts) == 3) {
		try {
			const v = c.get(parts[0], parts[1], parts[2]);

			return (v == null) ? "" : sprintf("%s", v);
		} catch (e) {
			/* 回退到 uci 命令 */
		}
	}

	const r = run("uci -q get " + shq(key) + " 2>/dev/null");

	return (r.code == 0) ? trim(r.out) : "";
}

/* 整数配置：缺省 / 非法 / 越界都回落到默认值并 WARN（绝不猜一个会删数据的值） */
function cfg_int(key, dflt, lo, hi) {
	const raw = trim(uci_get("prism-router.retention." + key));

	if (!length(raw))
		return dflt;

	if (!match(raw, /^-?[0-9]+$/)) {
		warnf(sprintf("配置 %s=%s 不是整数，用默认值 %d", key, raw, dflt));
		return dflt;
	}

	const n = int(raw);

	if (n < lo || n > hi) {
		warnf(sprintf("配置 %s=%d 超出 [%d, %d]，用默认值 %d", key, n, lo, hi, dflt));
		return dflt;
	}

	return n;
}

function cfg_bool(key, dflt) {
	const v = lc(trim(uci_get("prism-router.retention." + key)));

	if (!length(v))
		return dflt;

	if (v == "0" || v == "false" || v == "no" || v == "off" || v == "disabled")
		return false;

	return true;
}

/* 命令行里的数字：非法直接忽略（不写 UCI，也不影响其它项） */
function arg_int(v, name, lo, hi) {
	if (v == null)
		return null;

	const s = trim(sprintf("%s", v));

	if (!match(s, /^[0-9]+$/)) {
		warnf(sprintf("参数 %s=%s 不是非负整数，忽略", name, s));
		return null;
	}

	const n = int(s);

	if (n < lo || n > hi) {
		warnf(sprintf("参数 %s=%d 超出 [%d, %d]，忽略", name, n, lo, hi));
		return null;
	}

	return n;
}

function load_cfg(o) {
	const c = {
		enabled: DEFAULTS.enabled,
		daily_days: DEFAULTS.daily_days,
		nodes_days: DEFAULTS.nodes_days,
		stations_days: DEFAULTS.stations_days,
		log_days: DEFAULTS.log_days,
		log_max_kb: DEFAULTS.log_max_kb,
		spool_max_kb: DEFAULTS.spool_max_kb,
		dry_run: DEFAULTS.dry_run,
		daily_dir: DEFAULT_DIRS.daily,
		nodes_dir: DEFAULT_DIRS.nodes,
		stations_dir: DEFAULT_DIRS.stations,
		log_dir: DEFAULT_DIRS.logs,
		queue_dir: DEFAULT_DIRS.queue
	};

	c.enabled = cfg_bool("enabled", c.enabled);
	c.dry_run = cfg_bool("dry_run", c.dry_run);
	c.daily_days = cfg_int("daily_days", c.daily_days, 0, MAX_DAYS);
	c.nodes_days = cfg_int("nodes_days", c.nodes_days, 0, MAX_DAYS);
	c.stations_days = cfg_int("stations_days", c.stations_days, 0, MAX_DAYS);
	c.log_days = cfg_int("log_days", c.log_days, 0, MAX_DAYS);
	c.log_max_kb = cfg_int("log_max_kb", c.log_max_kb, 0, MAX_KB);
	c.spool_max_kb = cfg_int("spool_max_kb", c.spool_max_kb, 0, MAX_KB);

	/* 调试参数优先于 UCI（都是「仅本次运行」的覆盖） */
	if (o.dry_run)
		c.dry_run = true;

	const dd = arg_int(o.daily_days, "--daily-days", 0, MAX_DAYS);
	const nd = arg_int(o.nodes_days, "--nodes-days", 0, MAX_DAYS);
	const sd = arg_int(o.stations_days, "--stations-days", 0, MAX_DAYS);
	const ld = arg_int(o.log_days, "--log-days", 0, MAX_DAYS);
	const lk = arg_int(o.log_max_kb, "--log-max-kb", 0, MAX_KB);
	const sk = arg_int(o.spool_max_kb, "--spool-max-kb", 0, MAX_KB);

	if (dd != null) c.daily_days = dd;
	if (nd != null) c.nodes_days = nd;
	if (sd != null) c.stations_days = sd;
	if (ld != null) c.log_days = ld;
	if (lk != null) c.log_max_kb = lk;
	if (sk != null) c.spool_max_kb = sk;

	if (length(o.dirs.daily)) c.daily_dir = o.dirs.daily;
	if (length(o.dirs.nodes)) c.nodes_dir = o.dirs.nodes;
	if (length(o.dirs.stations)) c.stations_dir = o.dirs.stations;
	if (length(o.dirs.logs)) c.log_dir = o.dirs.logs;
	if (length(o.dirs.queue)) c.queue_dir = o.dirs.queue;

	return c;
}

/* ───────────────────────────── 清理动作 ───────────────────────────── */

/* 文件年龄（天）：文件名里有 YYYY-MM-DD 就按日期，否则按 mtime */
function age_days(name, st) {
	const day = parse_day_name(name);

	if (day != null)
		return TODAY - day;

	const age = int((NOW - st.mtime) / 86400);

	return (age < 0) ? 0 : age;
}

/* 按天清理一个目录；filter 为 null 表示不限文件名 */
function sweep_dir(label, root, days, filter) {
	if (root == null)
		return;

	if (days <= 0) {
		logline("INFO", sprintf("%s 保留天数=0，关闭按天清理", label));
		return;
	}

	let names = fs.lsdir(root);

	if (names == null)
		return;

	names = sort(names);

	for (let name in names) {
		if (filter != null && !match(name, filter))
			continue;

		const path = root + "/" + name;
		const st = fs.lstat(path);

		/* 子目录 / 符号链接 / 设备文件：一律不删也不跟随 */
		if (st == null || st.type != "file")
			continue;

		const age = age_days(name, st);

		if (age <= days)
			continue;

		const note = sprintf("%d 天前", age);

		if (CFG.dry_run) {
			act("将删除", path, note);
			STATS.planned_files++;
			STATS.planned_bytes += st.size;
			continue;
		}

		const r = safe_unlink(root, name);

		if (r.ok) {
			act("删除", path, note);
			STATS.files_deleted++;
			STATS.bytes_freed += r.size;
		} else {
			warnf(sprintf("删除 %s 失败：%s（继续）", path, r.why));
		}
	}
}

/* 截断：只保留尾部 keep 字节；临时文件 + rename 原子替换 */
function truncate_tail(path, st, keep) {
	if (keep < 1)
		keep = 1;

	const start = st.size - keep;
	const fd = fs.open(path, "r");

	if (!fd)
		return { ok: false, why: "打不开" };

	/* 起点是否正好在行首：看前一个字节是不是换行 */
	let at_line_start = (start <= 0);

	if (start > 0) {
		try {
			if (fd.seek(start - 1))
				at_line_start = (fd.read(1) == "\n");
		} catch (e) {
			at_line_start = false;
		}
	}

	let data = "";

	try {
		if (!fd.seek(start)) {
			fd.close();
			return { ok: false, why: "seek 失败" };
		}

		let buf = "";

		while (length((buf = fd.read(READ_CHUNK))) > 0)
			data += buf;
	} catch (e) {
		fd.close();
		return { ok: false, why: "读取失败：" + e };
	}

	fd.close();

	/* 切在半行上就丢掉这半行（最多丢一行），保证新文件从完整行开始 */
	if (!at_line_start) {
		const nl = index(data, "\n");

		if (nl >= 0 && nl + 1 <= length(data))
			data = substr(data, nl + 1);
	}

	const tmp = sprintf("%s.tmp.%d.%d", path, NOW, _seq++);
	let wrote = false;

	try {
		wrote = (fs.writefile(tmp, data) != null);
	} catch (e) {
		wrote = false;
	}

	if (wrote) {
		/* 保留原权限（日志通常 0644） */
		try {
			fs.chmod(tmp, st.mode % 4096);
		} catch (e) {
			/* 权限只是尽量 */
		}

		try {
			if (fs.rename(tmp, path))
				return { ok: true, size: length(data) };
		} catch (e) {
			/* 落到下面统一清理临时文件 */
		}
	}

	try {
		fs.unlink(tmp);
	} catch (e) {
		/* 临时文件清不掉也不影响主流程 */
	}

	return { ok: false, why: "写入/替换失败" };
}

function sweep_logs(root, max_kb) {
	if (root == null || max_kb <= 0)
		return;

	const limit = max_kb * 1024;
	let names = fs.lsdir(root);

	if (names == null)
		return;

	names = sort(names);

	for (let name in names) {
		if (!match(name, /\.log$/))
			continue;

		const path = root + "/" + name;
		const st = fs.lstat(path);

		if (st == null || st.type != "file" || st.size <= limit)
			continue;

		const keep = int(st.size / 2);

		if (CFG.dry_run) {
			act("将截断", path, sprintf("%s KB → %s KB，保留尾部", kb_text(st.size), kb_text(keep)));
			STATS.planned_truncs++;
			STATS.planned_bytes += st.size - keep;
			continue;
		}

		const r = truncate_tail(path, st, keep);

		if (r.ok) {
			act("截断", path, sprintf("%s KB → %s KB，保留尾部", kb_text(st.size), kb_text(r.size)));
			STATS.logs_truncated++;
			STATS.bytes_freed += st.size - r.size;
		} else {
			warnf(sprintf("截断 %s 失败：%s（继续）", path, r.why));
		}
	}
}

/* 飞书重试队列：总量超过上限就从最旧的 mtime 开始删 */
function sweep_queue(root, max_kb) {
	if (root == null || max_kb <= 0)
		return;

	const limit = max_kb * 1024;
	const names = fs.lsdir(root);

	if (names == null)
		return;

	let items = [];
	let total = 0;

	for (let name in names) {
		const st = fs.lstat(root + "/" + name);

		if (st == null || st.type != "file")
			continue;

		total += st.size;
		push(items, { name: name, size: st.size, mtime: st.mtime });
	}

	if (total <= limit)
		return;

	const over = total;

	items = sort(items, function(a, b) {
		if (a.mtime != b.mtime)
			return (a.mtime < b.mtime) ? -1 : 1;

		return (a.name < b.name) ? -1 : ((a.name > b.name) ? 1 : 0);
	});

	for (let it in items) {
		if (total <= limit)
			break;

		/* 正在投递中的条目（feishu.uc 会自己收尾）不删 */
		if (match(it.name, /\.processing$/))
			continue;

		const path = root + "/" + it.name;
		const note = sprintf("队列 %s KB > %d KB", kb_text(over), max_kb);

		if (CFG.dry_run) {
			act("将删除", path, note);
			STATS.planned_files++;
			STATS.planned_bytes += it.size;
			total -= it.size;
			continue;
		}

		const r = safe_unlink(root, it.name);

		if (r.ok) {
			act("删除", path, note);
			STATS.files_deleted++;
			STATS.bytes_freed += r.size;
			total -= r.size;
		} else {
			warnf(sprintf("删除队列条目 %s 失败：%s（继续）", path, r.why));
		}
	}

	if (total > limit)
		warnf(sprintf("飞书队列仍超上限：%s KB > %d KB（剩余条目正在投递或不可删）",
			kb_text(total), max_kb));
}

/* 摘要行：清理模式下 stdout 的最后一行 */
function summarize() {
	print(sprintf("retention: files_deleted=%d bytes_freed=%d logs_truncated=%d\n",
		STATS.files_deleted, STATS.bytes_freed, STATS.logs_truncated));
}

/* ───────────────────────────── 入口 ───────────────────────────── */

function usage() {
	print(sprintf("retention.uc %s — 棱镜路由插件的数据 / 日志保留与清理\n\n", VERSION));
	print("用法：\n");
	print("  ucode retention.uc                       按 UCI prism-router.retention 清理一次\n");
	print("  ucode retention.uc --dry-run             只打印将要删除/截断的清单，不动文件\n");
	print("  ucode retention.uc --selftest            离线自检（日期解析 / 白名单判定）\n");
	print("  ucode retention.uc --help\n\n");
	print("cron（自己加，本脚本不改 crontab）：\n");
	print("  30 3 * * * /usr/bin/ucode /usr/share/prism-router/retention.uc >/dev/null 2>&1\n\n");
	print("可覆盖项（仅本次运行，不写 UCI）：\n");
	print("  --epoch N --daily-days N --nodes-days N --stations-days N --log-days N\n");
	print("  --log-max-kb N --spool-max-kb N\n");
	print("  --daily-dir DIR --nodes-dir DIR --stations-dir DIR --log-dir DIR --queue-dir DIR\n");
	print("  （目录覆盖必须落在 /etc/prism-router 或 /tmp/prism-router 之下，否则拒绝）\n\n");
	print("清理范围：daily / nodes / stations / *.log（按天） + *.log（超限截断） + feishu-queue（总量）\n");
	print("输出：动作行以 \"retention: \" 开头，最后一行是\n");
	print("      retention: files_deleted=N bytes_freed=M logs_truncated=K\n");

	return 0;
}

/* 离线自检：纯函数（日期 / 路径），不读写任何真实数据目录 */
function selftest() {
	let pass = 0, fail = 0;

	const eq = function(name, got, want) {
		const g = sprintf("%s", got), w = sprintf("%s", want);

		if (g == w) {
			pass++;
		} else {
			print(sprintf("retention: selftest FAIL %s 期望[%s] 实际[%s]\n", name, w, g));
			fail++;
		}
	};

	const eqn = function(name, got, want) {
		eq(name, (got == null) ? "null" : sprintf("%d", got),
			(want == null) ? "null" : sprintf("%d", want));
	};

	const eqb = function(name, got, want) {
		eq(name, got ? 1 : 0, want ? 1 : 0);
	};

	/* 公历 / 天序号 */
	eqn("days_from_civil(1970-01-01)", days_from_civil(1970, 1, 1), 0);
	eqn("days_from_civil(2024-02-29)", days_from_civil(2024, 2, 29), 19782);
	eq("civil_from_days(19782)",
		sprintf("%d-%d-%d", int(civil_from_days(19782).y),
			int(civil_from_days(19782).m), int(civil_from_days(19782).d)),
		"2024-2-29");

	/* 文件名日期解析 */
	eqn("parse 2024-02-29.json", parse_day_name("2024-02-29.json"), 19782);
	eqn("parse 2024-02-30.json", parse_day_name("2024-02-30.json"), null);
	eqn("parse 2020-13-01.json", parse_day_name("2020-13-01.json"), null);
	eqn("parse 2026-11-15.jsonl", parse_day_name("2026-11-15.jsonl"),
		days_from_civil(2026, 11, 15));
	eqn("parse 2020-1-1.json", parse_day_name("2020-1-1.json"), null);
	eqn("parse node-a.json", parse_day_name("node-a.json"), null);
	eqn("parse q-1794700000-1-0.json", parse_day_name("q-1794700000-1-0.json"), null);

	/* 路径校验 */
	eqb("path_ok daily", path_ok("/etc/prism-router/daily"), true);
	eqb("path_ok dotdot", path_ok("/etc/../etc"), false);
	eqb("path_ok relative", path_ok("etc/x"), false);
	eqb("path_ok space", path_ok("/tmp/a b"), false);
	eqb("root_under daily", root_under("/etc/prism-router/daily", ETC_ROOT), true);
	eqb("root_under itself", root_under("/tmp/prism-router", TMP_ROOT), true);
	eqb("root_under /etc", root_under("/etc", ETC_ROOT), false);
	eqb("root_under prefix-trap", root_under("/etc/prism-routerX/a", ETC_ROOT), false);
	eq("norm_dir trailing", norm_dir("/tmp/x///"), "/tmp/x");
	eq("norm_dir root", norm_dir("/"), "/");
	eq("kb_text 512", kb_text(512), "1");
	eq("kb_text 5120", kb_text(5120), "5");

	print(sprintf("retention: selftest %s %d/%d\n",
		(fail == 0) ? "OK" : "FAIL", pass, pass + fail));

	return (fail == 0) ? 0 : 1;
}

function parse_args(argv) {
	const o = {
		help: false, selftest: false, dry_run: false, epoch: 0,
		daily_days: null, nodes_days: null, stations_days: null,
		log_days: null, log_max_kb: null, spool_max_kb: null,
		dirs: {}
	};

	for (let i = 0; i < length(argv); i++) {
		const a = argv[i];
		const has = (i + 1 < length(argv));

		if (a == "--help" || a == "-h")
			o.help = true;
		else if (a == "--selftest")
			o.selftest = true;
		else if (a == "--dry-run" || a == "--dry_run")
			o.dry_run = true;
		else if (a == "--epoch" && has)
			o.epoch = int(argv[++i]);
		else if (a == "--daily-days" && has)
			o.daily_days = argv[++i];
		else if (a == "--nodes-days" && has)
			o.nodes_days = argv[++i];
		else if (a == "--stations-days" && has)
			o.stations_days = argv[++i];
		else if (a == "--log-days" && has)
			o.log_days = argv[++i];
		else if (a == "--log-max-kb" && has)
			o.log_max_kb = argv[++i];
		else if (a == "--spool-max-kb" && has)
			o.spool_max_kb = argv[++i];
		else if (a == "--daily-dir" && has)
			o.dirs.daily = argv[++i];
		else if (a == "--nodes-dir" && has)
			o.dirs.nodes = argv[++i];
		else if (a == "--stations-dir" && has)
			o.dirs.stations = argv[++i];
		else if (a == "--log-dir" && has)
			o.dirs.logs = argv[++i];
		else if (a == "--queue-dir" && has)
			o.dirs.queue = argv[++i];
		else
			warnf(sprintf("忽略未知参数 %s", a));
	}

	return o;
}

function main() {
	const o = parse_args(ARGV);

	if (o.help) {
		usage();
		return 0;
	}

	if (o.selftest)
		return selftest();

	NOW = (o.epoch > 0) ? o.epoch : time();
	CFG = load_cfg(o);

	const p = local_parts(NOW);

	TODAY = (p != null) ? p.days : 0;

	/* 依赖自检：ucode-mod-fs 太老时没有 fs.realpath，就无法做白名单校验。
	 * 这种情况**宁可什么都不删**（fail closed），只报一条 WARN + 全 0 摘要。 */
	if (type(fs.realpath) != "function" || type(fs.lstat) != "function"
	    || type(fs.lsdir) != "function") {
		warnf("当前 ucode-mod-fs 缺少 fs.realpath/lstat/lsdir，拒绝执行（无法校验白名单）");
		summarize();
		return 0;
	}

	/* 白名单根：任何一个解析失败只会跳过那个目录，绝不会回退到别处 */
	const roots = {
		daily: check_root(CFG.daily_dir, ETC_ROOT, "daily"),
		nodes: check_root(CFG.nodes_dir, ETC_ROOT, "nodes"),
		stations: check_root(CFG.stations_dir, ETC_ROOT, "stations"),
		logs: check_root(CFG.log_dir, TMP_ROOT, "logs"),
		queue: check_root(CFG.queue_dir, TMP_ROOT, "queue")
	};

	/* 日志只允许写进已校验过的白名单目录 */
	if (roots.logs != null)
		LOG_FILE = roots.logs + "/retention.log";

	if (!CFG.enabled) {
		logline("INFO", "retention.enabled=0，本次跳过清理");
		print("retention: 已禁用（retention.enabled=0），跳过清理\n");
		summarize();
		return 0;
	}

	if (CFG.dry_run)
		print("retention: dry-run：只打印计划，不改动任何文件\n");

	/* 1) 按天 / 按 mtime 清理 */
	sweep_dir("daily", roots.daily, CFG.daily_days, null);
	sweep_dir("nodes", roots.nodes, CFG.nodes_days, null);
	sweep_dir("stations", roots.stations, CFG.stations_days, null);
	sweep_dir("logs", roots.logs, CFG.log_days, /\.log$/);

	/* 2) 日志截断（只留尾部一半，原子替换） */
	sweep_logs(roots.logs, CFG.log_max_kb);

	/* 3) 飞书重试队列总量上限 */
	sweep_queue(roots.queue, CFG.spool_max_kb);

	if (CFG.dry_run)
		print(sprintf("retention: dry-run：计划删除 %d 个文件、截断 %d 个日志，共 %d 字节（未改动任何文件）\n",
			STATS.planned_files, STATS.planned_truncs, STATS.planned_bytes));

	summarize();
	return 0;
}

let rc = 0;

try {
	rc = main();
} catch (e) {
	/* 外层兜底：任何未预期异常都只记 WARN，绝不让 cron 收到非 0 退出码 */
	warnf(sprintf("未预期的异常：%s", e));
	summarize();
	rc = 0;
}

exit(rc);
