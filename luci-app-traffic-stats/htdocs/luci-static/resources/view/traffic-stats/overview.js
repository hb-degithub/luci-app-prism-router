'use strict';
'require view';
'require dom';
'require rpc';

/*
 * 流量统计 · 总览（高信息密度版）
 *
 * 版式参考：
 *   ①  一行状态条 —— Pi-hole 的 "服务状态 + 最近更新" 单行头，取代原来的两条通栏横幅；
 *   ②  4 张 KPI 磁贴 —— Grafana / Netdata 的 "single stat" 磁贴，每张一个主数字 + 一行副值；
 *   ③  左侧趋势折线 —— Pi-hole（Queries over time）的"主图占大、图例给数值"，
 *      右侧并列的细堆叠条 —— AdGuard Home 的 "Top clients" 进度条思路：
 *      一个维度一条 8px 堆叠条 + 百分比，替掉原来两个 300px 高的环形图；
 *   ④  Top 5 设备 / Top 5 应用 —— Pi-hole 的 Top Clients / Top Permitted Domains，
 *      名称左、数值右、中间一条相对长度条，一眼比大小。
 *
 * 口径（SPEC §3.1 / §3.2，前端不得改写）：
 *   - totals 是"traffic-statsd 进程启动以来累计"，进程重启即归零；
 *     卡片上必须写明，绝不能当"今日"展示；
 *   - 代理/直连 与 无线/有线 是两个**正交**维度（同一字节在两边各出现一次），
 *     所以各自成条、各自带百分比，绝不合并成一个"总计"；
 *   - history.json 在 tmpfs、且只存当日的 5 分钟桶（跨日只有日粒度），
 *     所以趋势图只画 days[0]（今天的桶，最多 288 个），标题按实际跨度写；
 *   - 概览不再假装后端有“昨日 5 分钟桶”：daily/<日期>.json 是整天汇总，
 *     get_history 第二天只带 `summary.totals`。所以这里只显示「昨日全天 X」，
 *     明确不对今天（进程累计或今日桶）做百分比；同截止时间的环比后端不提供，
 *     文案里直接写不可用，绝不用 now-86400 去混时区分组或硬凑 0%。
 *
 * rpc 预算（硬约束）：
 *   进入页面 get_state ×1 + get_history ×1（days=2：今天桶 + 昨天日汇总，只为「昨日全天」；
 *   后端已对每个桶做瘦身，两天实测约 120 KiB，仍在 ubus 单条 262144B 以内）；
 *   之后每 5s 只复用 get_state 刷新数字，不重画图表、不重排布局、不加新请求。
 *
 * 陌生设备（只读，绝不执行任何命令）：
 *   - Top 5 设备里，first_seen 在 24 小时内的设备打「新」标记；
 *   - 每台设备给一个「阻断建议」，弹出针对该设备 MAC 的 nftables 规则文本供复制，
 *     本页不调用任何写入接口、不自动执行任何命令。
 */

// ---------------------------------------------------------------- rpc

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

/*
 * get_history 取 days=2：
 *   - 今天的 history.json（5 分钟桶）+ 最近一天/几天的 daily 汇总（整天汇总，
 *     没有 buckets，只有 summary.totals）；
 *     趋势图仍然只画最新一天；「昨日全天」按每项的 day 字段查找，不写死数组下标；
 *   - 后端在 rpcd 里按 200 KB 预算逐个桶瘦身（去掉 top_apps/top_devices），
 *     并可能裁剪 daily 的 devices/apps；summary.totals 保持兼容，不被裁掉；
 *   - 取不到（或失败）时：趋势图与「昨日全天」一起降级为"—"，不影响 get_state 的数字。
 */
var callHistory = rpc.declare({
	object: 'traffic-stats',
	method: 'get_history',
	params: [ 'days' ],
	expect: {},
	reject: true
});

var REFRESH_MS = 5000;      /* 数字刷新间隔（与现状一致） */
var TOPS_EVERY = 6;         /* 每 6 个周期（30s）重建一次 Top / 节点块 */
var STALE_SEC = 90;         /* state.ts 超过 90s 没动 → 标黄提示 */
var ONLINE_SEC = 600;       /* 在线口径：last_seen 10 分钟内（同 feishu.uc ONLINE_WINDOW） */
var BUCKET_SEC = 300;       /* 兜底桶宽：守护进程 BUCKET_SECONDS=300 */
var MAX_POINTS = 288;       /* 一天 5 分钟桶上限，跨日脏数据也只画这么久 */
var TREND_H = 168;          /* 趋势图默认高度（px） */
var TREND_MAX_H = 340;      /* 趋势图最大高度：右侧面板再高也不无限拉伸 */
var NEW_DEVICE_SEC = 86400; /* 陌生设备口径：first_seen 在 24 小时内 */
var FIRST_SEEN_KEY = 'luci-traffic-stats.device-first-seen';
var FIRST_SEEN_KEEP = 30 * 86400;  /* 本浏览器只记 30 天，避免 localStorage 越攒越多 */
var FIRST_SEEN_MAX = 512;          /* 最多记 512 台设备（家用规模绰绰有余） */

/* 出口维度（代理 / 直连） */
var COLOR_PROXY = '#2b7de9';
var COLOR_DIRECT = '#4caf50';

/* 接入维度（无线 / 有线 / 未知）——和上面是两套色、两个维度 */
var COLOR_WIFI = '#7b1fa2';
var COLOR_WIRED = '#00838f';
var COLOR_UNKNOWN = '#9e9e9e';

/* 趋势图方向（下载 / 上传） */
var COLOR_RX = '#1976d2';
var COLOR_TX = '#ef6c00';
var FILL_RX = 'rgba(25,118,210,.16)';

// ---------------------------------------------------------------- 格式化

function num(value) {
	var n = (typeof value == 'number') ? value : parseInt(value, 10);

	return (typeof n == 'number' && isFinite(n)) ? n : 0;
}

/* 流量：二进制单位，≥1 GiB 保留 1 位小数（四个页面统一口径） */
function fmtBytes(bytes) {
	var n = num(bytes);

	if (n >= 1099511627776) return (n / 1099511627776).toFixed(2) + ' TiB';
	if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GiB';
	if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
	if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';

	return Math.round(n) + ' B';
}

/* 速率：bits/s（链路习惯）；Mb/s 是十进制，和 MB/s 明确区分 */
function fmtRateBits(bytesPerSecond) {
	var bits = num(bytesPerSecond) * 8;

	if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gb/s';
	if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mb/s';
	if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' kb/s';

	return Math.round(bits) + ' b/s';
}

/* 十进制字节速率，作为辅助 */
function fmtRateBytes(bytesPerSecond) {
	var n = num(bytesPerSecond);

	if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB/s';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB/s';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB/s';

	return Math.round(n) + ' B/s';
}

function pct(part, total) {
	var p = num(part), t = num(total);

	if (t <= 0) return 0;

	return Math.min(100, Math.max(0, p * 100 / t));
}

function fmtPercent(part, total) {
	var t = num(total);

	if (t <= 0) return '—';

	return pct(part, total).toFixed(1) + '%';
}

/* 字节/桶 → Mb/s（5 分钟均值：bytes*8/step/1e6） */
function bytesToMbps(bytes, stepSec) {
	var step = num(stepSec) > 0 ? num(stepSec) : BUCKET_SEC;

	return num(bytes) * 8 / step / 1e6;
}

function fmtMbps(value) {
	var n = num(value);

	if (n >= 1000) return (n / 1000).toFixed(2) + ' Gb/s';
	if (n >= 100) return n.toFixed(0) + ' Mb/s';
	if (n >= 10) return n.toFixed(1) + ' Mb/s';

	return n.toFixed(2) + ' Mb/s';
}

function round3(n) {
	return Math.round(num(n) * 1000) / 1000;
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

function fmtClock(ts) {
	var t = num(ts);

	if (!t) return '—';

	var d = new Date(t * 1000);

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function fmtHM(ts) {
	var t = num(ts);

	if (!t) return '';

	var d = new Date(t * 1000);

	return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* 秒 → 1天2小时 / 3小时12分 / 45秒（用于"运行时长"）*/
function fmtDuration(seconds) {
	var s = num(seconds);

	if (s <= 0) return '';
	if (s >= 86400) return Math.floor(s / 86400) + _('天') + Math.floor((s % 86400) / 3600) + _('小时');
	if (s >= 3600) return Math.floor(s / 3600) + _('小时') + Math.floor((s % 3600) / 60) + _('分');
	if (s >= 60) return Math.floor(s / 60) + _('分') + (s % 60) + _('秒');

	return s + _('秒');
}

/* 秒 → 50分钟 / 2小时15分（用于"多久没更新"这种口语化提示）*/
function fmtAge(seconds) {
	var s = Math.max(0, num(seconds));

	if (s < 60) return s + _('秒');
	if (s < 3600) return Math.floor(s / 60) + _('分钟');

	return Math.floor(s / 3600) + _('小时') + Math.floor((s % 3600) / 60) + _('分');
}

function shorten(text, max) {
	var s = '' + (text == null ? '' : text);

	if (s.length <= max) return s;

	return s.substring(0, max - 1) + '…';
}

function healthLook(confidence) {
	var conf = '' + (confidence == null ? 'unknown' : confidence);

	if (conf == 'exact')
		return { color: '#2e7d32', bg: 'rgba(76,175,80,.12)', label: _('记账精确') };
	if (conf == 'degraded')
		return { color: '#e65100', bg: 'rgba(255,152,0,.14)', label: _('记账降级') };
	if (conf == 'unavailable')
		return { color: '#c62828', bg: 'rgba(198,40,40,.12)', label: _('记账不可用') };

	return { color: '#c62828', bg: 'rgba(198,40,40,.12)', label: _('记账状态未知') };
}

function deviceName(dev) {
	if (dev == null) return _('未知设备');
	if (dev.hostname && ('' + dev.hostname).length) return '' + dev.hostname;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
}

// ---------------------------------------------------------------- 昨日全天 / 陌生设备

function dayKeyFromDate(d) {
	if (d == null || isNaN(d.getTime())) return '';

	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function localDayKey(ts) {
	var d = new Date(num(ts) * 1000);

	return dayKeyFromDate(d);
}

/*
 * 后端日期是 YYYY-MM-DD（本地时区的日粒度）。这里用「本地日历日加减」而不是
 * 粗暴减 86400 秒：夏令时切换日只有 23/25 小时，减固定秒数可能落到错误的日期。
 * 中午 12 点构造 Date 再 setDate(±1)，跨 DST 也由运行时的本地日历规则处理。
 */
function parseDayKey(key) {
	var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec('' + ((key == null) ? '' : key));

	if (m == null) return null;

	var y = +m[1], mo = +m[2], da = +m[3];
	var d = new Date(y, mo - 1, da, 12, 0, 0, 0);

	/* 拒绝 2026-02-31 这类越界日期（Date 会自动进位）。 */
	if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da)
		return null;

	return d;
}

function shiftDayKey(key, delta) {
	var d = parseDayKey(key);

	if (d == null) return '';

	d.setDate(d.getDate() + num(delta));

	return dayKeyFromDate(d);
}

function latestDayKeyOf(days) {
	var latest = '';

	for (var i = 0; i < days.length; i++) {
		var d = days[i];
		var key = (d != null && typeof d.day == 'string') ? d.day : '';

		if (parseDayKey(key) != null && key > latest)
			latest = key;
	}

	return latest;
}

/*
 * 「昨日的 day」不能假设数组下标：后端把今天 history 放第一，
 * 但 daily 文件可能缺失、乱序，或只有昨天一天。用后端 day 字段查找：
 *   1. 最近一个有效 day 的「前一天」（后端时区）；
 *   2. 浏览器本地今天的「前一天」（用户/路由器时区不一致时兜底）；
 * 两个候选都按 day 精确匹配，找不到就降级，不猜下标。
 */
function findYesterdayDay(days, nowSec) {
	var latest = latestDayKeyOf(days);
	var candidates = [];
	var seen = {};

	function add(key) {
		if (key.length && !seen[key]) {
			seen[key] = true;
			candidates.push(key);
		}
	}

	add(shiftDayKey(latest, -1));
	add(shiftDayKey(localDayKey(nowSec), -1));

	for (var c = 0; c < candidates.length; c++) {
		for (var i = 0; i < days.length; i++) {
			var d = days[i];

			if (d != null && typeof d.day == 'string' && d.day === candidates[c])
				return { day: d, key: candidates[c] };
		}
	}

	return { day: null, key: candidates.length ? candidates[0] : '' };
}

/*
 * 「昨日全天」：从 get_history 的 days 里按 day 字段找昨天，只读
 * summary.totals。daily 文件是整天汇总，没有 5 分钟桶；后端也不为历史日
 * 重建桶，所以这里**不做**同截止时间环比，只展示昨日整天值，并在 title
 * 里明确写“同截止时间对比不可用”。缺数据一律渲染成 —，绝不显示 0% / NaN。
 */
function summaryTotalOf(totals) {
	if (totals == null || typeof totals != 'object') return null;

	var keys = [ 'rx', 'tx', 'direct_rx', 'direct_tx', 'proxy_rx', 'proxy_tx' ];
	var any = false, i;

	for (i = 0; i < keys.length; i++)
		if (typeof totals[keys[i]] == 'number' || typeof totals[keys[i]] == 'string')
			if (isFinite(Number(totals[keys[i]]))) any = true;

	if (!any) return null;

	var rx = (typeof totals.rx != 'undefined')
		? num(totals.rx)
		: (num(totals.direct_rx) + num(totals.proxy_rx));
	var tx = (typeof totals.tx != 'undefined')
		? num(totals.tx)
		: (num(totals.direct_tx) + num(totals.proxy_tx));

	return { rx: rx, tx: tx, total: rx + tx };
}

function yesterdayCompare(history, nowSec) {
	var days = (history != null && Array.isArray(history.days)) ? history.days : [];
	var found = findYesterdayDay(days, nowSec);
	var day = found.day;
	var totals, sum;

	function fail(why) {
		return { ok: false, text: _('昨日全天') + ' —', title: why, color: '', wholeDay: true };
	}

	if (day == null)
		return fail(_('get_history 里没有找到昨天（' + (found.key || '?') + '）的每日汇总；昨日全天数字不可用（后端不提供昨日 5 分钟桶，同截止时间对比也不可用）。'));

	totals = (day.summary != null && typeof day.summary == 'object') ? day.summary.totals : null;
	sum = summaryTotalOf(totals);

	if (sum == null)
		return fail(_('昨天的每日汇总没有 summary.totals（可能是老版本或文件损坏）；后端不返回昨日 5 分钟桶，同截止时间对比不可用。'));

	return {
		ok: true,
		wholeDay: true,
		text: _('昨日全天') + ' ' + fmtBytes(sum.total),
		color: '',
		/* 兼容旧字段，避免其它渲染代码读 undefined；含义是“昨天整天”。 */
		yestBytes: sum.total,
		todayBytes: null,
		title: _('昨日全天') + (day.day ? '（' + day.day + '）' : '') + _('：') +
			fmtBytes(sum.total) + _('。这是 daily 汇总的整天值，不是与今天同截止时间的对比；') +
			_('后端只有今天的 5 分钟桶，昨日同截止时间环比不可用。')
	};
}

function macOf(dev) {
	var mac = (dev != null && dev.mac != null) ? ('' + dev.mac).trim() : '';

	if (!mac.length) return '';

	return mac.replace(/-/g, ':').toUpperCase();
}

/* 后端字段优先；当前 rpcd 还没吐 first_seen，所以下面用浏览器本地记录兜底 */
function backendFirstSeen(dev) {
	var ts = (dev != null) ? num(dev.first_seen) : 0;

	if (ts > 1e11) ts = Math.floor(ts / 1000);

	return (ts > 0) ? ts : 0;
}

/*
 * 浏览器本地的「第一次看到这个 MAC」记录（只写 localStorage，不碰后端）：
 *   { v: 1, base: <建立基线的时间>, seen: { MAC: 首次观测时间 } }
 * base 是第一次打开本页时的时间点：**base 之后才出现的 MAC** 才算"陌生设备"，
 * 建立基线时已经在的设备不会在之后 24 小时内被误标成「新」。
 */
function readFirstSeen() {
	var seen = {}, count = 0, raw = null, obj = null, key = '';

	try {
		raw = (typeof window != 'undefined' && window.localStorage)
			? window.localStorage.getItem(FIRST_SEEN_KEY) : null;
	}
	catch (e) {
		return { seen: {}, base: 0, count: 0 };
	}

	if (!raw) return { seen: {}, base: 0, count: 0 };

	try { obj = JSON.parse(raw); }
	catch (e) { return { seen: {}, base: 0, count: 0 }; }

	if (obj == null || typeof obj != 'object' || Array.isArray(obj) ||
		obj.seen == null || typeof obj.seen != 'object')
		return { seen: {}, base: 0, count: 0 };

	for (key in obj.seen) {
		if (!obj.seen.hasOwnProperty(key)) continue;
		if (!(num(obj.seen[key]) > 0)) continue;

		seen[key] = num(obj.seen[key]);
		count++;
	}

	return { seen: seen, base: num(obj.base), count: count };
}

function writeFirstSeen(seen, base, now) {
	var keys = [], kept = {}, i, key;

	for (key in seen) {
		if (!seen.hasOwnProperty(key)) continue;
		if (!(num(seen[key]) > 0)) continue;

		/* 基线里的设备（fs <= base）要一直留着：它们一旦被清掉，下次又会被当成
		   "基线之后才出现"的新设备；只有基线之后发现、且已经满 30 天的才裁剪。 */
		if (num(seen[key]) > num(base) && now - num(seen[key]) > FIRST_SEEN_KEEP) continue;

		keys.push(key);
	}

	if (keys.length > FIRST_SEEN_MAX) {
		keys.sort(function(a, b) { return num(seen[b]) - num(seen[a]); });
		keys = keys.slice(0, FIRST_SEEN_MAX);
	}

	for (i = 0; i < keys.length; i++)
		kept[keys[i]] = num(seen[keys[i]]);

	try {
		window.localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify({ v: 1, base: num(base), seen: kept }));
	}
	catch (e) { }
}

function firstSeenBadge(fs, fromBackend) {
	var d = new Date(num(fs) * 1000);
	var when = fmtHM(fs);

	if (localDayKey(fs) != localDayKey(Math.floor(Date.now() / 1000)))
		when = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + when;

	var title = _('24 小时内首次出现：') + when;

	if (!fromBackend)
		title += _('（后端未提供 first_seen，按本浏览器首次观测时间估算）');

	return E('span', { 'class': 'tso-new', title: title }, [ E('i', {}), _('新') ]);
}

function linkLook(kind) {
	var k = '' + (kind == null ? 'unknown' : kind);

	if (k == 'wifi') return { label: _('无线'), color: COLOR_WIFI };
	if (k == 'wired') return { label: _('有线'), color: COLOR_WIRED };

	return { label: _('未知'), color: COLOR_UNKNOWN };
}

function chainLook(chain) {
	var c = '' + (chain == null ? '' : chain);

	if (c == 'DIRECT') return { label: _('直连'), color: COLOR_DIRECT };
	if (c == 'MIXED' || c == '__other__' || c.length == 0) return { label: _('混合'), color: COLOR_UNKNOWN };

	return { label: shorten(c, 14), color: COLOR_PROXY };
}

// ---------------------------------------------------------------- 维度取数

function totalOf(totals) {
	var t = totals || {};

	return num(t.direct_rx) + num(t.direct_tx) + num(t.proxy_rx) + num(t.proxy_tx);
}

function proxyOf(totals) {
	var t = totals || {};

	return num(t.proxy_rx) + num(t.proxy_tx);
}

function directOf(totals) {
	var t = totals || {};

	return num(t.direct_rx) + num(t.direct_tx);
}

function rxTotal(totals) {
	var t = totals || {};

	return num(t.direct_rx) + num(t.proxy_rx);
}

function txTotal(totals) {
	var t = totals || {};

	return num(t.direct_tx) + num(t.proxy_tx);
}

/*
 * 接入方式三个桶（互斥且完备：wifi + wired + unknown == direct + proxy）。
 * 注意这是**另一个维度**：同一字节既可能"无线接入"也可能"走代理"，
 * 所以这里的数绝不能再和代理/直连相加。
 */
function linkTotals(totals) {
	var t = totals || {};

	return {
		wifi: num(t.wifi_rx) + num(t.wifi_tx),
		wired: num(t.wired_rx) + num(t.wired_tx),
		unknown: num(t.unknown_rx) + num(t.unknown_tx)
	};
}

function linkRxTx(totals, prefix) {
	var t = totals || {};

	return { rx: num(t[prefix + '_rx']), tx: num(t[prefix + '_tx']) };
}

function devBytes(dev) {
	if (dev == null) return 0;

	return num(dev.direct_rx) + num(dev.direct_tx) + num(dev.proxy_rx) + num(dev.proxy_tx);
}

function appBytes(app) {
	if (app == null) return 0;

	return num(app.rx) + num(app.tx);
}

/* 代理出口 Top N（nodes 里除 DIRECT / __other__ 以外的节点） */
function nodeTop(state, limit) {
	var nodes = (state != null && state.nodes != null && typeof state.nodes == 'object') ? state.nodes : {};
	var list = [];

	for (var name in nodes) {
		if (!nodes.hasOwnProperty(name)) continue;
		if (name == 'DIRECT' || name == '__other__') continue;

		var bytes = num(nodes[name] && nodes[name].rx) + num(nodes[name] && nodes[name].tx);

		if (bytes <= 0) continue;

		list.push({ name: name, bytes: bytes });
	}

	list.sort(function(a, b) { return b.bytes - a.bytes; });

	return list.slice(0, limit || 3);
}

function onlineCount(state, nowSec) {
	var devices = (state != null && Array.isArray(state.devices)) ? state.devices : [];
	var n = 0;

	for (var i = 0; i < devices.length; i++) {
		var ls = num(devices[i].last_seen);

		/*
		 * 在线 = last_seen 是正数且距今 ≤ 10 分钟。
		 * 没有 last_seen（新设备/老后端）绝不算在线；未来时间戳（时钟漂移）也不冒充在线。
		 */
		if (ls > 0 && ls <= nowSec + 60 && (nowSec - ls) <= ONLINE_SEC) n++;
	}

	return n;
}

// ---------------------------------------------------------------- 趋势数据

/* 趋势图只要最近一天：多取的昨天日汇总只给「昨日全天」用，不进图表 */
function newestDay(history) {
	var days = (history != null && Array.isArray(history.days)) ? history.days : [];

	return { days: days.slice(0, 1) };
}

/*
 * 把 get_history 的 {days:[{day,buckets:[...]}]} 归一化成折线可用的点集。
 *
 * 只做前端能做的四件事（后端字段一个不改）：
 *   1. 合并所有 days 的桶、按 ts 去重排序（跨日回滚时两处可能重叠）；
 *   2. 丢掉 0 / 毫秒时间戳 / 未来时间（时钟漂移容错 10 分钟）；
 *   3. 只保留最后 MAX_POINTS 个点（= 一天 5 分钟桶），跨日脏数据不画到 48h；
 *   4. 从相邻 ts 的中位差推断桶宽，用来算 Mb/s（不硬编码 300，桶宽变了也不会错）。
 *
 * reason 用于空态文案：nohistory = 后端没有历史日；stale = 有桶但时间戳不可用。
 */
function trendOf(history, nowSec) {
	var out = {
		points: [],
		step: BUCKET_SEC,
		sumRx: 0, sumTx: 0,
		peak: 0, mean: 0,
		reason: ''
	};

	var days = (history != null && Array.isArray(history.days)) ? history.days : [];
	var seen = {};
	var list = [];
	var i, j, d, bs, b, ts;

	for (i = 0; i < days.length; i++) {
		d = days[i];
		bs = (d != null && Array.isArray(d.buckets)) ? d.buckets : [];

		for (j = 0; j < bs.length; j++) {
			b = bs[j];

			if (b == null || typeof b != 'object') continue;

			ts = num(b.ts);
			if (ts <= 0) continue;
			if (ts > 1e11) ts = Math.floor(ts / 1000);              /* 毫秒时间戳容错 */
			if (ts > nowSec + 600) continue;

			if (seen[ts] === true) continue;
			seen[ts] = true;

			list.push({
				ts: ts,
				rx: num(b.direct_rx) + num(b.proxy_rx),
				tx: num(b.direct_tx) + num(b.proxy_tx)
			});
		}
	}

	if (list.length == 0) {
		out.reason = (days.length == 0) ? 'nohistory' : 'stale';
		return out;
	}

	list.sort(function(a, b) { return a.ts - b.ts; });

	if (list.length > MAX_POINTS) list = list.slice(list.length - MAX_POINTS);

	/* 桶宽：相邻 ts 差的中位数（有缺桶也不会被拉偏） */
	var deltas = [];

	for (i = 1; i < list.length; i++) deltas.push(list[i].ts - list[i - 1].ts);

	deltas.sort(function(a, b) { return a - b; });

	var step = deltas.length ? deltas[Math.floor(deltas.length / 2)] : BUCKET_SEC;

	if (!(step >= 30 && step <= 3600)) step = BUCKET_SEC;

	out.step = step;
	out.points = list;

	var mbps, totalMbps = 0;

	for (i = 0; i < list.length; i++) {
		out.sumRx += list[i].rx;
		out.sumTx += list[i].tx;

		mbps = bytesToMbps(list[i].rx + list[i].tx, step);
		totalMbps += mbps;

		if (mbps > out.peak) out.peak = mbps;
	}

	out.mean = list.length ? (totalMbps / list.length) : 0;

	return out;
}

// ---------------------------------------------------------------- 样式（内联，不引外部 CSS）

var CSS = [
	'#ts-overview{font-size:13px;line-height:1.5}',
	'#ts-overview *,#ts-overview *::before,#ts-overview *::after{box-sizing:border-box}',

	/* ① 一行状态条 */
	'#ts-overview .tso-head{display:flex;align-items:center;gap:10px;flex-wrap:nowrap;margin:0 0 10px 0}',
	'#ts-overview .tso-title{margin:0;font-size:16px;font-weight:600;line-height:1.5;white-space:nowrap;flex:none}',
	'#ts-overview .tso-pills{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;margin-left:auto;min-width:0}',
	'#ts-overview .tso-pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;line-height:1.7;',
	'padding:0 8px;border-radius:9px;border:1px solid rgba(127,127,127,.22);white-space:nowrap}',
	'#ts-overview .tso-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;background:#9e9e9e}',
	'#ts-overview .tso-meta{font-size:11.5px;opacity:.75;white-space:nowrap}',
	'#ts-overview .tso-meta.warn{opacity:1;color:#e65100}',
	'#ts-overview .tso-btn{font:inherit;font-size:11.5px;line-height:1.7;padding:0 9px;border-radius:9px;cursor:pointer;',
	'color:inherit;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.26);white-space:nowrap}',
	'#ts-overview .tso-tech{display:none;margin:0 0 10px 0;padding:8px 11px;border-radius:8px;',
	'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.16);font-size:11.5px;line-height:1.8;word-break:break-word}',
	'#ts-overview .tso-tech.open{display:block}',
	'#ts-overview .tso-tech ul{margin:4px 0 0 0;padding-left:18px}',

	/* 空态/告警条 */
	'#ts-overview .tso-alert{margin:0 0 10px 0;padding:9px 12px;border-radius:8px;',
	'background:rgba(255,152,0,.12);border-left:3px solid #e65100;font-size:12px;line-height:1.7}',
	'#ts-overview .tso-alert ul{margin:4px 0 0 0;padding-left:18px}',

	/* ② KPI 磁贴 */
	'#ts-overview .tso-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 12px 0}',
	'#ts-overview .tso-kpi{padding:8px 11px 9px 11px;border-radius:9px;min-width:0;',
	'background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.18)}',
	'#ts-overview .tso-kpi-h{display:flex;align-items:center;gap:6px;font-size:11.5px;opacity:.75;white-space:nowrap}',
	'#ts-overview .tso-kpi-t{flex:none;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-kpi-chip{margin-left:auto;font-size:10px;opacity:.85;padding:0 5px;border-radius:6px;',
	'background:rgba(127,127,127,.16);flex:none}',
	'#ts-overview .tso-kpi-v{font-size:20px;font-weight:600;line-height:1.3;margin:1px 0 0 0;',
	'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-kpi-s{font-size:11px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-kpi-bar{display:flex;height:4px;border-radius:2px;overflow:hidden;margin-top:5px;background:rgba(127,127,127,.2)}',
	'#ts-overview .tso-fill{display:block;height:100%;width:0}',

	/* ③④ 面板与两列栅格 */
	'#ts-overview .tso-cols{display:grid;gap:12px;margin:0 0 12px 0}',
	'#ts-overview .tso-cols-main{grid-template-columns:minmax(0,1.85fr) minmax(0,1fr)}',
	'#ts-overview .tso-cols-top{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}',
	'#ts-overview .tso-panel{padding:10px 12px 11px 12px;border-radius:9px;min-width:0;',
	'background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.18)}',
	'#ts-overview .tso-ph{display:flex;align-items:center;gap:7px;flex-wrap:wrap;',
	'margin:0 0 8px 0;padding:0 0 6px 0;border-bottom:1px solid rgba(127,127,127,.2)}',
	'#ts-overview .tso-ph-t{font-size:13px;font-weight:600;white-space:nowrap}',
	'#ts-overview .tso-ph-n{font-size:11px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-ph-a{margin-left:auto;font-size:11.5px;white-space:nowrap}',
	'#ts-overview .tso-note{font-size:10.5px;opacity:.6;line-height:1.55;margin:6px 0 0 0}',

	/* 趋势图 */
	'#ts-overview .tso-cols-main .tso-panel{display:flex;flex-direction:column}',
	'#ts-overview .tso-plot{position:relative;width:100%;flex:1 1 auto;min-height:168px;min-width:0}',
	'#ts-overview .tso-plot canvas{display:block;max-width:100%}',
	'#ts-overview .tso-axis{display:flex;align-items:baseline;justify-content:space-between;gap:10px;',
	'margin-top:3px;font-size:10.5px;opacity:.62;white-space:nowrap}',
	'#ts-overview .tso-empty{height:100%;min-height:140px;display:flex;flex-direction:column;',
	'align-items:center;justify-content:center;gap:3px;padding:0 12px;text-align:center;font-size:12px;opacity:.62;line-height:1.6}',
	'#ts-overview .tso-legend{display:inline-flex;align-items:center;gap:9px;font-size:11px;opacity:.85}',
	'#ts-overview .tso-lg{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}',
	'#ts-overview .tso-lg i{width:8px;height:8px;border-radius:2px;display:inline-block}',

	/* 细堆叠条（取代环形图） */
	'#ts-overview .tso-split{display:flex;height:8px;border-radius:4px;overflow:hidden;',
	'margin:2px 0 7px 0;background:rgba(127,127,127,.2)}',
	'#ts-overview .tso-split i{display:block;height:100%;width:0}',
	'#ts-overview .tso-blk+.tso-blk{margin-top:10px;padding-top:9px;border-top:1px solid rgba(127,127,127,.14)}',
	'#ts-overview .tso-kv{display:flex;align-items:center;gap:7px;font-size:12px;line-height:1.7}',
	'#ts-overview .tso-kv-l{width:8px;height:8px;border-radius:2px;flex:none;display:inline-block}',
	'#ts-overview .tso-kv-n{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-kv-v{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}',
	'#ts-overview .tso-kv-p{flex:none;width:46px;text-align:right;opacity:.66;',
	'font-variant-numeric:tabular-nums;white-space:nowrap}',

	/* Top 列表 */
	'#ts-overview .tso-lrow{display:grid;grid-template-columns:minmax(0,1fr) 86px 76px;gap:9px;',
	'align-items:center;padding:5px 0;border-bottom:1px solid rgba(127,127,127,.12)}',
	'#ts-overview .tso-lrow:last-child{border-bottom:0}',
	'#ts-overview .tso-lname{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-lsub{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10.5px;opacity:.7;',
	'margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	'#ts-overview .tso-chip{display:inline-block;font-size:10px;line-height:1.55;padding:0 5px;border-radius:5px;',
	'background:rgba(127,127,127,.16);white-space:nowrap}',
	'#ts-overview .tso-mini{display:flex;height:6px;border-radius:3px;overflow:hidden;background:rgba(127,127,127,.2)}',
	'#ts-overview .tso-mini i{display:block;height:100%}',
	'#ts-overview .tso-lnum{font-size:12px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',

	/* 「新」设备标记 + 阻断建议（只读：只显示命令，不执行） */
	'#ts-overview .tso-new{display:inline-flex;align-items:center;gap:3px;margin-left:5px;font-size:10px;',
	'line-height:1.6;padding:0 5px;border-radius:6px;background:rgba(198,40,40,.14);color:#c62828;',
	'flex:none;white-space:nowrap}',
	'#ts-overview .tso-new i{width:6px;height:6px;border-radius:50%;background:#c62828;display:inline-block;flex:none}',
	'#ts-overview .tso-block{margin-top:9px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.7;',
	'background:rgba(255,152,0,.1);border:1px solid rgba(255,152,0,.35)}',
	'#ts-overview .tso-block-h{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
	'#ts-overview .tso-block pre{margin:6px 0;padding:7px 9px;border-radius:6px;background:rgba(127,127,127,.14);',
	'font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all;overflow-x:auto}',
	'#ts-overview .tso-block-n{font-size:10.5px;opacity:.65;margin-top:4px;line-height:1.6}',

	/* 「昨日全天」小字（总流量卡最后一行） */
	'#ts-overview .tso-cmp{font-size:11px;line-height:1.55;margin-top:1px;white-space:nowrap;',
	'overflow:hidden;text-overflow:ellipsis}',

	/* 窄屏：KPI 2×2、两列变一列、状态条允许换行 */
	'@media (max-width:1000px){',
	'#ts-overview .tso-cols-main,#ts-overview .tso-cols-top{grid-template-columns:minmax(0,1fr)}',
	'}',
	'@media (max-width:760px){',
	'#ts-overview .tso-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}',
	'#ts-overview .tso-head{flex-wrap:wrap}',
	'#ts-overview .tso-pills{margin-left:0;justify-content:flex-start}',
	'}'
].join('\n');

// ---------------------------------------------------------------- 视图


/* ------------------------------------------------------------------ *
 * 零依赖 SVG 折线渲染器
 *
 * 为什么不用 Chart.js：luci-lib-chartjs 里自带的是 nlbwmon 的精简构建，
 * Chart.prototype 上只有 Doughnut / Pie，没有 Line（实测会抛
 * "(intermediate value).Line is not a function"）。引外部 CDN 不可行，
 * 所以趋势图自己用 SVG 画，零依赖、可缩放、支持明暗主题（用半透明中性色）。
 *
 * 标签/图例全部用 createElementNS + textContent 创建，不再拼 HTML 字符串：
 * 刻度、日期、数据集名称都可能来自后端，不能被当成标记解析。
 * ------------------------------------------------------------------ */

var SVG_NS = 'http://www.w3.org/2000/svg';

function clearChildren(node) {
	while (node != null && node.firstChild)
		node.removeChild(node.firstChild);
}

function svgNode(name, attrs, text) {
	var node = document.createElementNS(SVG_NS, name);

	if (attrs != null) {
		for (var key in attrs) {
			if (attrs.hasOwnProperty(key))
				node.setAttribute(key, '' + attrs[key]);
		}
	}

	if (text != null) node.textContent = '' + text;

	return node;
}

function tsRenderLine(host, data, opts) {
	if (host == null) return null;

	var W = 900, H = 240, PL = 62, PR = 12, PT = 10, PB = 22;
	var labels = (data && data.labels) || [];
	var sets = ((data && data.datasets) || []).filter(function (s) { return s && s.data && s.data.length; });

	if (!labels.length || !sets.length) return null;

	var max = 0;
	sets.forEach(function (s) { s.data.forEach(function (v) { if (+v > max) max = +v; }); });
	if (!(max > 0)) max = 1;

	var n = labels.length;
	var fmtY = (opts && opts.fmtY) || function (v) { return Math.round(v) + ''; };
	var x = function (i) { return PL + (n === 1 ? 0 : (W - PL - PR) * i / (n - 1)); };
	var y = function (v) { return H - PB - (H - PT - PB) * (Math.max(0, +v) / max); };

	var svg = svgNode('svg', {
		viewBox: '0 0 ' + W + ' ' + H,
		preserveAspectRatio: 'none',
		style: 'width:100%;height:100%;display:block'
	});
	var g, gy, i;

	for (g = 0; g <= 3; g++) {
		gy = PT + (H - PT - PB) * g / 3;
		svg.appendChild(svgNode('line', {
			x1: PL, y1: gy.toFixed(1), x2: W - PR, y2: gy.toFixed(1),
			stroke: 'rgba(127,127,127,.16)', 'stroke-width': 1
		}));
		svg.appendChild(svgNode('text', {
			x: PL - 6, y: (gy + 3).toFixed(1), 'font-size': 10,
			fill: 'rgba(127,127,127,.85)', 'text-anchor': 'end'
		}, fmtY(max * (1 - g / 3))));
	}

	sets.forEach(function (s) {
		var d = s.data.map(function (v, idx) {
			return (idx ? 'L' : 'M') + x(idx).toFixed(1) + ' ' + y(v).toFixed(1);
		}).join(' ');

		svg.appendChild(svgNode('path', {
			d: d,
			fill: 'none',
			stroke: s.strokeColor || '#1a73e8',
			'stroke-width': 2,
			'stroke-linejoin': 'round',
			'stroke-linecap': 'round',
			'vector-effect': 'non-scaling-stroke'
		}));
	});

	var step = Math.max(1, Math.ceil(n / 7));

	for (i = 0; i < n; i += step) {
		svg.appendChild(svgNode('text', {
			x: x(i).toFixed(1), y: H - 6, 'font-size': 10,
			fill: 'rgba(127,127,127,.85)', 'text-anchor': 'middle'
		}, labels[i]));
	}

	var legend = E('div', { style: 'font-size:11px;opacity:.75;padding:6px 0 0 46px' },
		sets.map(function (s) {
			return E('span', {
				style: 'display:inline-flex;align-items:center;gap:5px;margin-right:14px'
			}, [
				E('i', {
					style: 'width:10px;height:3px;border-radius:2px;display:inline-block;background:' +
						(s.strokeColor || '#1a73e8')
				}),
				(s.label || '')
			]);
		}));

	var wrap = E('div', {
		style: 'width:100%;height:100%;display:flex;flex-direction:column'
	}, [
		E('div', { style: 'flex:1;min-height:0' }, svg),
		legend
	]);

	clearChildren(host);
	dom.content(host, wrap);

	return {
		destroy: function() {
			try { clearChildren(host); }
			catch (e) { }
		}
	};
}

return view.extend({
	load: function() {
		var self = this;

		this.stateError = '';
		this.historyError = '';

		/* 两个 rpc 并行发；任何一个失败都不影响另一个（history 失败只让趋势图/昨日全天降级） */
		return Promise.all([
			callState().catch(function(err) {
				self.stateError = (err != null && err.message) ? ('' + err.message) : '' + err;
				return null;
			}),
			callHistory(2).catch(function(err) {
				self.historyError = (err != null && err.message) ? ('' + err.message) : '' + err;
				return null;
			})
		]).then(function(res) {
			var nowSec = Math.floor(Date.now() / 1000);

			self.state = (res[0] != null && typeof res[0] == 'object' && res[0].totals != null) ? res[0] : null;
			self.history = (res[1] != null && typeof res[1] == 'object') ? res[1] : null;
			/* 趋势图仍然只画最近的一天（days[0]）；多取的昨天只给「昨日全天」用 */
			self.trend = trendOf(newestDay(self.history), nowSec);
			self.compare = yesterdayCompare(self.history, nowSec);

			/* history 整个失败时把 rpc 错误写进 title，比“没有历史数据”更好排查 */
			if (self.history == null && self.historyError)
				self.compare.title = _('读取 get_history 失败：') + shorten(self.historyError, 120) + _('，无法显示昨日全天。');
		});
	},

	render: function() {
		var state = this.state;
		var self = this;

		this.cells = [];
		this.bars = [];
		this.trendChart = null;
		this.plotHost = null;
		this.canvas = null;
		this.tick = 0;
		this.renderSeq = 0;
		this.trend = (this.trend != null) ? this.trend : trendOf(null, 0);
		this.compare = (this.compare != null) ? this.compare
			: yesterdayCompare(null, Math.floor(Date.now() / 1000));

		if (state == null)
			return this.renderUnavailable();

		var devices = Array.isArray(state.devices) ? state.devices : [];
		var apps = Array.isArray(state.apps) ? state.apps : [];

		/*
		 * 全空判定：累计 0、没有设备、没有应用、也没有历史桶 → 才挂"暂无数据"提示。
		 * 不看 ts：state.ts 有值只说明守护进程在跑，不代表采到了东西；
		 * 反过来只要有桶（哪怕 state 被裁剪空了）也算有数据，不该误报。
		 */
		var empty = (totalOf(state.totals) == 0) && (devices.length == 0) &&
			(apps.length == 0) && (this.trend.points.length == 0);

		this.root = E('div', { 'id': 'ts-overview' }, [
			E('style', {}, CSS),
			E('div', { 'class': 'tso-head' }, [
				E('h2', { 'class': 'tso-title' }, _('流量统计 · 总览')),
				this.renderPills(state)
			]),
			this.renderTech(state),
			empty ? this.renderEmptyNotice(state) : '',
			this.renderKpis(state),
			E('div', { 'class': 'tso-cols tso-cols-main' }, [
				this.renderTrendPanel(state),
				this.renderRail(state)
			]),
			E('div', { 'class': 'tso-cols tso-cols-top' }, [
				this.renderTopDevices(state),
				this.renderTopApps(state)
			])
		]);

		this.syncAll(state);
		this.afterRender();

		if (state.running === true)
			this.startRefresh();

		return this.root;
	},

	// ------------------------------------------------------------ ① 状态行

	renderPills: function(state) {
		var self = this;

		this.pillRun = E('span', { 'class': 'tso-pill' }, [
			this.dotRun = E('i', { 'class': 'tso-dot' }),
			E('span', {}, _('服务状态'))
		]);
		this.pillConf = E('span', { 'class': 'tso-pill', 'title': _('accounting_confidence：采集是否可信') }, [
			this.dotConf = E('i', { 'class': 'tso-dot' }),
			this.textConf = E('span', {}, _('记账状态未知'))
		]);
		this.metaTime = E('span', { 'class': 'tso-meta' }, '');
		this.metaStale = E('span', { 'class': 'tso-meta warn', style: 'display:none' }, '');
		this.srcClash = E('span', { 'class': 'tso-pill' }, [
			this.dotClash = E('i', { 'class': 'tso-dot' }),
			E('span', {}, 'clash')
		]);
		this.srcConn = E('span', { 'class': 'tso-pill' }, [
			this.dotConn = E('i', { 'class': 'tso-dot' }),
			E('span', {}, 'conntrack')
		]);
		this.metaOnline = E('span', { 'class': 'tso-meta' }, '');

		var more = E('button', {
			'class': 'tso-btn',
			title: _('展开：数据源明细 / 采集原因'),
			click: function(ev) {
				ev.preventDefault();
				self.toggleTech();
			}
		}, _('详情'));

		this.btnTech = more;

		/* 详细内容（趋势、Top 榜、逐设备/逐应用）放到独立窗口，LuCI 里只留这份概览 */
		var panelBtn = E('button', {
			'class': 'tso-btn',
			title: _('在新窗口打开详细面板（铺满整屏，隐藏侧栏）'),
			click: function(ev) {
				ev.preventDefault();
				window.open(L.url('admin/services/traffic-stats/panel'), '_blank',
					'width=1500,height=950,noopener');
			}
		}, _('详细面板 ↗'));

		return E('div', { 'class': 'tso-pills' }, [
			this.pillRun,
			this.pillConf,
			this.metaTime,
			this.metaStale,
			this.srcClash,
			this.srcConn,
			this.metaOnline,
			more,
			panelBtn
		]);
	},

	renderTech: function(state) {
		this.techBox = E('div', { 'class': 'tso-tech' }, [
			E('div', {}, this.cell(function(s) { return s == null ? '' : techText(s); })),
			this.techReasons = E('ul', {}, '')
		]);

		return this.techBox;
	},

	toggleTech: function() {
		if (this.techBox == null) return;

		var open = this.techBox.classList.contains('open');

		if (open) this.techBox.classList.remove('open');
		else this.techBox.classList.add('open');

		if (this.btnTech != null)
			this.btnTech.textContent = open ? _('详情') : _('收起');

		this.resizeSoon();
	},

	syncStatus: function(state) {
		var now = Math.floor(Date.now() / 1000);
		var running = (state != null && state.running === true);
		var health = (state != null && state.health) ? state.health : {};
		var source = (state != null && state.source && typeof state.source == 'object') ? state.source : {};
		var look = healthLook(health.accounting_confidence);
		var ts = (state != null) ? num(state.ts) : 0;
		var age = ts > 0 ? (now - ts) : -1;

		if (this.pillRun != null) {
			this.pillRun.lastChild.textContent = running ? _('服务运行中') : _('服务未运行');
			this.pillRun.style.background = running ? 'rgba(76,175,80,.14)' : 'rgba(198,40,40,.12)';
			this.pillRun.style.borderColor = running ? 'rgba(76,175,80,.5)' : 'rgba(198,40,40,.45)';
			this.dotRun.style.background = running ? COLOR_DIRECT : '#c62828';
		}

		if (this.pillConf != null) {
			this.pillConf.style.background = look.bg;
			this.pillConf.style.borderColor = look.color;
			this.dotConf.style.background = look.color;
			this.textConf.textContent = look.label;
			this.textConf.style.color = look.color;
		}

		if (this.metaTime != null)
			this.metaTime.textContent = _('更新') + ' ' + fmtClock(now) + ' · ' + _('数据') + ' ' + fmtClock(ts);

		if (this.metaStale != null) {
			if (age > STALE_SEC) {
				this.metaStale.style.display = '';
				this.metaStale.textContent = _('数据已') + ' ' + fmtAge(age) + ' ' + _('未更新');
				this.metaStale.title = _('state.json 的 ts 已经') + ' ' + age + ' ' + _('秒没有前进，检查 traffic-statsd 是否卡住');
			}
			else {
				this.metaStale.style.display = 'none';
				this.metaStale.textContent = '';
			}
		}

		if (this.srcClash != null) {
			var c = '' + (source.clash || 'unknown');
			this.srcClash.title = 'clash = ' + c;
			this.dotClash.style.background = (c == 'ok') ? COLOR_DIRECT : ((c == 'unknown') ? COLOR_UNKNOWN : '#c62828');
		}

		if (this.srcConn != null) {
			var k = '' + (source.conntrack || 'unknown');
			this.srcConn.title = 'conntrack = ' + k;
			this.dotConn.style.background = (k == 'ok') ? COLOR_DIRECT : ((k == 'unknown') ? COLOR_UNKNOWN : '#c62828');
		}

		if (this.metaOnline != null) {
			var devices = (state != null && Array.isArray(state.devices)) ? state.devices : [];
			var on = onlineCount(state, now);

			this.metaOnline.textContent = devices.length
				? (on + ' / ' + devices.length + ' ' + _('台在线'))
				: '';
			this.metaOnline.title = _('在线口径：last_seen 在 10 分钟内');
		}

		if (this.techReasons != null) {
			var reasons = Array.isArray(health.reasons) ? health.reasons : [];

			dom.content(this.techReasons, reasons.map(function(reason) {
				return E('li', {}, [ '' + reason ]);
			}));
		}
	},

	// ------------------------------------------------------------ ② KPI 磁贴

	renderKpis: function(state) {
		function sub(nodes) {
			return E('div', { 'class': 'tso-kpi-s' }, nodes);
		}

		/* extraNode：主数字下面的额外一行小字（目前只有「昨日全天」用） */
		function card(title, chip, chipTitle, valueNode, subNodes, extraNode, barNode) {
			return E('div', { 'class': 'tso-kpi' }, [
				E('div', { 'class': 'tso-kpi-h' }, [
					E('span', { 'class': 'tso-kpi-t' }, title),
					chip ? E('span', { 'class': 'tso-kpi-chip', title: chipTitle || null }, chip) : ''
				]),
				E('div', { 'class': 'tso-kpi-v' }, valueNode),
				subNodes,
				extraNode || '',
				barNode || ''
			]);
		}

		/* 「昨日全天」：按 day 字段找到昨天的 summary.totals，明确不是同截止时间环比。 */
		var cmp = (this.compare != null) ? this.compare
			: { text: _('昨日全天') + ' —', title: _('没有可用的昨日每日汇总。'), color: '' };
		var cmpNode = E('div', { 'class': 'tso-cmp', title: cmp.title }, cmp.text);

		if (cmp.color) cmpNode.style.color = cmp.color;

		/* 总流量：代理 + 直连（rx+tx），口径是"进程启动以来累计" */
		var totalCard = card(_('总流量'),
			_('累计'),
			_('traffic-statsd 进程启动以来累计；进程重启归零（SPEC §3.1），不是"今日"'),
			this.cell(function(s) { return fmtBytes(totalOf(s.totals)); }),
			sub([
				'↓ ', this.cell(function(s) { return fmtBytes(rxTotal(s.totals)); }),
				' · ↑ ', this.cell(function(s) { return fmtBytes(txTotal(s.totals)); }),
				' · ', this.cell(function(s) {
					var up = num(s.uptime);
					return up > 0 ? (_('已运行') + ' ' + fmtDuration(up)) : '';
				})
			]),
			cmpNode,
			null);

		/* 实时速率 */
		var rateCard = card(_('实时速率'),
			_('↓下行'),
			_('速率按 Mb/s（bits，链路习惯）；同一行括注十进制字节速率'),
			this.cell(function(s) { return fmtRateBits(num((s.totals || {}).rx_rate)); }, { style: 'color:' + COLOR_RX }),
			sub([
				'↑ ', this.cell(function(s) { return fmtRateBits(num((s.totals || {}).tx_rate)); }, { style: 'color:' + COLOR_TX }),
				' · ', this.cell(function(s) { return fmtRateBytes(num((s.totals || {}).rx_rate)); })
			]),
			null,
			null);

		/* 无线 / 有线：接入维度（与代理/直连正交），数字 + 占比 + 细条 */
		function linkCard(title, prefix, color) {
			return card(title,
				_('接入'),
				_('接入方式与"代理/直连"是两个维度，不能相加（SPEC §3.2）'),
				this.cell(function(s) { return fmtBytes(linkTotals(s.totals)[prefix]); }),
				sub([
					this.cell(function(s) {
						var l = linkTotals(s.totals);
						return fmtPercent(l[prefix], l.wifi + l.wired + l.unknown);
					}),
					' · ↓ ', this.cell(function(s) { return fmtBytes(linkRxTx(s.totals, prefix).rx); }),
					' · ↑ ', this.cell(function(s) { return fmtBytes(linkRxTx(s.totals, prefix).tx); }),
					prefix == 'wired' ? this.cell(function(s) {
						var l = linkTotals(s.totals);
						return l.unknown > 0 ? (' · ' + _('未知') + ' ' + fmtPercent(l.unknown, l.wifi + l.wired + l.unknown)) : '';
					}) : ''
				]),
				null,
				E('div', { 'class': 'tso-kpi-bar' }, [
					this.bar(function(s) {
						var l = linkTotals(s.totals);
						return pct(l[prefix], l.wifi + l.wired + l.unknown);
					}, color)
				]));
		}

		return E('div', { 'class': 'tso-kpis' }, [
			totalCard,
			rateCard,
			linkCard.call(this, _('无线接入'), 'wifi', COLOR_WIFI),
			linkCard.call(this, _('有线接入'), 'wired', COLOR_WIRED)
		]);
	},

	// ------------------------------------------------------------ ③ 趋势图

	renderTrendPanel: function(state) {
		var self = this;
		var trend = this.trend;
		var has = (trend.points.length > 0);

		this.plotHost = E('div', { 'class': 'tso-plot' });
		this.canvas = E('canvas', { width: 640, height: TREND_H });

		if (has)
			this.plotHost.appendChild(this.canvas);
		else
			this.plotHost.appendChild(this.renderTrendEmpty());

		var nodes = [
			E('div', { 'class': 'tso-ph' }, [
				E('span', { 'class': 'tso-ph-t' }, _('流量趋势')),
				E('span', { 'class': 'tso-ph-n' }, this.cell(function() { return self.trendCaption(); })),
				E('span', { 'class': 'tso-ph-a' }, E('span', { 'class': 'tso-legend' }, [
					E('span', { 'class': 'tso-lg' }, [ E('i', { style: 'background:' + COLOR_RX }), _('下载') ]),
					E('span', { 'class': 'tso-lg' }, [ E('i', { style: 'background:' + COLOR_TX }), _('上传') ])
				]))
			]),
			this.plotHost,
			E('div', { 'class': 'tso-axis' }, [
				E('span', {}, this.cell(function() { return self.axisUnit(); })),
				E('span', {}, this.cell(function() { return self.axisStats(); }))
			])
		];

		return E('div', { 'class': 'tso-panel' }, nodes);
	},

	/* 趋势图的空态：明确说清"为什么没有"，而不是留一块白 */
	renderTrendEmpty: function() {
		var why;

		if (this.historyError)
			why = _('读取 get_history 失败：') + shorten(this.historyError, 120);
		else if (this.trend.reason == 'nohistory')
			why = _('后端没有返回历史日：history.json 尚未生成（守护进程刚启动或已停）。');
		else if (this.trend.reason == 'stale')
			why = _('history.json 里的桶时间戳都不可用（早于窗口或时钟异常）。');
		else
			why = _('history.json 里还没有 5 分钟桶。');

		return E('div', { 'class': 'tso-empty' }, [
			E('strong', {}, _('暂无历史数据')),
			E('span', {}, why),
			E('span', {}, _('history.json 在 tmpfs 上，重启 traffic-statsd 会清空；等一个采集周期后再看。'))
		]);
	},

	trendCaption: function() {
		var t = this.trend;
		var n = t.points.length;

		if (n == 0) return _('暂无历史数据');

		var stepMin = Math.max(1, Math.round(t.step / 60));
		var from = t.points[0].ts, to = t.points[n - 1].ts;
		var d = new Date(from * 1000);
		var today = new Date();
		var prefix = (d.getDate() != today.getDate() || d.getMonth() != today.getMonth())
			? (pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ')
			: '';

		return (prefix + fmtHM(from) + '–' + fmtHM(to) + ' · ' + n + ' ' + _('个桶') + ' · ' +
			_('每') + ' ' + stepMin + ' ' + _('分钟'));
	},

	axisUnit: function() {
		var t = this.trend;

		if (t.points.length == 0) return '';

		return _('纵轴') + ' Mb/s（' + _('每桶均值') + '）';
	},

	axisStats: function() {
		var t = this.trend;

		if (t.points.length == 0) return '';

		return _('峰值') + ' ' + fmtMbps(t.peak) + ' · ' + _('均值') + ' ' + fmtMbps(t.mean);
	},

	afterRender: function() {
		var self = this;
		var run = ++this.renderSeq;

		if (this.resizeHandler == null) {
			this.resizeHandler = function() { self.onResize(); };
			window.addEventListener('resize', this.resizeHandler);
		}

		if (this.trend.points.length == 0) return;

		/* 内置 SVG 无外部图表库；等节点进 DOM 后再量宽度。 */
		window.setTimeout(function() {
			if (run == self.renderSeq) self.drawTrend();
		}, 0);
	},

	onResize: function() {
		var self = this;

		if (this.root == null || !document.body.contains(this.root)) {
			if (this.resizeHandler != null)
				window.removeEventListener('resize', this.resizeHandler);
			return;
		}

		if (this.resizeTimer != null) window.clearTimeout(this.resizeTimer);

		this.resizeTimer = window.setTimeout(function() {
			self.resizeTimer = null;
			self.drawTrend();
		}, 180);
	},

	resizeSoon: function() {
		var self = this;

		if (this.resizeTimer != null) window.clearTimeout(this.resizeTimer);

		this.resizeTimer = window.setTimeout(function() {
			self.resizeTimer = null;
			self.drawTrend();
		}, 60);
	},

	/* 内置 SVG 不依赖 canvas 或外部图表库，容器宽度由 CSS 自适应。 */
	drawTrend: function() {
		var host = this.plotHost;

		if (host == null) return;
		if (this.trend == null || this.trend.points.length == 0) return;
		if (!document.body.contains(canvas)) return;

		var w = Math.floor(host.clientWidth || host.offsetWidth || 0);

		if (!(w >= 120)) w = 640;      /* 布局还没生效时给一个兜底宽度 */
		if (!(h >= 120)) h = TREND_H;
		if (h > TREND_MAX_H) h = TREND_MAX_H;


		var step = this.trend.step;
		var points = this.trend.points;
		var n = points.length;
		var every = Math.max(1, Math.ceil(n / 8));   /* 大约 8 个 x 轴刻度，与桶是否对齐整点无关 */
		var labels = [];
		var sRx = [];
		var sTx = [];
		var i, d;

		for (i = 0; i < n; i++) {
			d = new Date(points[i].ts * 1000);

			/* 只给 1/8 的点写时间标签，其余留空：288 个标签会糊成一片色块 */
			labels.push(((i % every) == 0 || i == n - 1)
				? (pad2(d.getHours()) + ':' + pad2(d.getMinutes()))
				: '');
			sRx.push(round3(bytesToMbps(points[i].rx, step)));
			sTx.push(round3(bytesToMbps(points[i].tx, step)));
		}

		var data = {
			labels: labels,
			datasets: [
				{
					label: _('下载'),
					fillColor: FILL_RX,
					strokeColor: COLOR_RX,
					pointColor: COLOR_RX,
					pointStrokeColor: '#fff',
					pointHighlightFill: '#fff',
					pointHighlightStroke: COLOR_RX,
					data: sRx
				},
				{
					label: _('上传'),
					fillColor: 'rgba(0,0,0,0)',
					strokeColor: COLOR_TX,
					pointColor: COLOR_TX,
					pointStrokeColor: '#fff',
					pointHighlightFill: '#fff',
					pointHighlightStroke: COLOR_TX,
					data: sTx
				}
			]
		};

		var opts = {
			animation: false,
			scaleBeginAtZero: true,
			scaleLineColor: 'rgba(127,127,127,.35)',
			scaleGridLineColor: 'rgba(127,127,127,.16)',
			scaleGridLineWidth: 1,
			scaleShowVerticalLines: false,
			scaleFontSize: 10,
			scaleFontColor: 'rgba(127,127,127,.95)',
			bezierCurve: false,
			pointDot: false,
			pointHitDetectionRadius: 8,
			datasetStrokeWidth: 1.5,
			showTooltips: true,
			multiTooltipTemplate: function(item) {
				if (item == null) return '';

				var name = item.datasetLabel ? item.datasetLabel : '';

				return name + '：' + fmtMbps(item.value);
			}
		};

		if (this.trendChart != null) {
			try { this.trendChart.destroy(); } catch (e) { }
			this.trendChart = null;
		}

		try {
			this.trendChart = tsRenderLine(this.plotHost || (canvas.parentNode), data, { fmtY: fmtMbps });
		}
		catch (e) {
			if (window.console) console.warn('traffic-stats: 趋势图绘制失败', e);
			this.chartFailed(_('图表绘制失败：') + ('' + e));
		}
	},

	chartFailed: function(message) {
		this.trendChart = null;
		this.canvas = null;

		if (this.plotHost == null) return;

		dom.content(this.plotHost, E('div', { 'class': 'tso-empty' }, [
			E('strong', {}, _('图表不可用')),
			E('span', {}, message)
		]));
	},

	// ------------------------------------------------------------ ③ 右侧：两个维度的细条

	renderRail: function(state) {
		var self = this;
		var link = linkTotals(state.totals);
		var showUnknown = link.unknown > 0;

		function kv(color, label, valueRender, pctRender) {
			return E('div', { 'class': 'tso-kv' }, [
				E('i', { 'class': 'tso-kv-l', style: 'background:' + color }),
				E('span', { 'class': 'tso-kv-n' }, label),
				E('span', { 'class': 'tso-kv-v' }, self.cell(valueRender)),
				E('span', { 'class': 'tso-kv-p' }, self.cell(pctRender))
			]);
		}

		/* 出口维度：代理 / 直连（互斥且完备 = 总量） */
		var outBlk = E('div', { 'class': 'tso-blk' }, [
			E('div', { 'class': 'tso-kv' }, [
				E('span', { 'class': 'tso-kv-n', style: 'font-weight:600' }, _('出口：代理 vs 直连')),
				E('span', { 'class': 'tso-kv-p', style: 'width:auto;opacity:.55' }, _('rx+tx'))
			]),
			E('div', { 'class': 'tso-split' }, [
				this.bar(function(s) { return pct(proxyOf(s.totals), totalOf(s.totals)); }, COLOR_PROXY),
				this.bar(function(s) { return pct(directOf(s.totals), totalOf(s.totals)); }, COLOR_DIRECT)
			]),
			kv(COLOR_PROXY, _('代理'), function(s) {
				return fmtBytes(proxyOf(s.totals));
			}, function(s) {
				return fmtPercent(proxyOf(s.totals), totalOf(s.totals));
			}),
			kv(COLOR_DIRECT, _('直连'), function(s) {
				return fmtBytes(directOf(s.totals));
			}, function(s) {
				return fmtPercent(directOf(s.totals), totalOf(s.totals));
			})
		]);

		/* 接入维度：无线 / 有线 / 未知（三桶互斥且完备，与出口维度正交） */
		var linkBlk = E('div', { 'class': 'tso-blk' }, [
			E('div', { 'class': 'tso-kv' }, [
				E('span', { 'class': 'tso-kv-n', style: 'font-weight:600' }, _('接入：无线 / 有线')),
				E('span', { 'class': 'tso-kv-p', style: 'width:auto;opacity:.55' }, _('rx+tx'))
			]),
			E('div', { 'class': 'tso-split' }, [
				this.bar(function(s) {
					var l = linkTotals(s.totals);
					return pct(l.wifi, l.wifi + l.wired + l.unknown);
				}, COLOR_WIFI),
				this.bar(function(s) {
					var l = linkTotals(s.totals);
					return pct(l.wired, l.wifi + l.wired + l.unknown);
				}, COLOR_WIRED),
				this.bar(function(s) {
					var l = linkTotals(s.totals);
					return pct(l.unknown, l.wifi + l.wired + l.unknown);
				}, COLOR_UNKNOWN)
			]),
			kv(COLOR_WIFI, _('无线'), function(s) {
				return fmtBytes(linkTotals(s.totals).wifi);
			}, function(s) {
				var l = linkTotals(s.totals);
				return fmtPercent(l.wifi, l.wifi + l.wired + l.unknown);
			}),
			kv(COLOR_WIRED, _('有线'), function(s) {
				return fmtBytes(linkTotals(s.totals).wired);
			}, function(s) {
				var l = linkTotals(s.totals);
				return fmtPercent(l.wired, l.wifi + l.wired + l.unknown);
			}),
			showUnknown ? kv(COLOR_UNKNOWN, _('未知'), function(s) {
				return fmtBytes(linkTotals(s.totals).unknown);
			}, function(s) {
				var l = linkTotals(s.totals);
				return fmtPercent(l.unknown, l.wifi + l.wired + l.unknown);
			}) : '',
			E('div', { 'class': 'tso-note' }, this.cell(function(s) { return linkHint(s); }))
		]);

		/* 代理出口 Top3（state.nodes） */
		this.nodeBox = E('div', {});
		dom.content(this.nodeBox, this.renderNodeRows(state));

		var nodeBlk = E('div', { 'class': 'tso-blk' }, [
			E('div', { 'class': 'tso-kv' }, [
				E('span', { 'class': 'tso-kv-n', style: 'font-weight:600' }, _('代理出口 Top 3')),
				E('span', { 'class': 'tso-kv-p', style: 'width:auto;opacity:.55' }, _('按节点'))
			]),
			this.nodeBox
		]);

		return E('div', { 'class': 'tso-panel' }, [
			E('div', { 'class': 'tso-ph' }, [
				E('span', { 'class': 'tso-ph-t' }, _('两个维度')),
				E('span', { 'class': 'tso-ph-n' }, _('不能相加'))
			]),
			outBlk,
			linkBlk,
			nodeBlk,
			E('div', { 'class': 'tso-note' },
				_('出口（代理/直连）与接入（无线/有线）是两个正交维度：同一字节在两边各记一次，请勿相加。'))
		]);
	},

	renderNodeRows: function(state) {
		var rows = nodeTop(state, 3);

		if (rows.length == 0)
			return E('div', { 'class': 'tso-note' }, _('暂无节点数据（未配置代理出口，或本周期没有代理流量）'));

		return E('div', {}, rows.map(function(node) {
			return E('div', { 'class': 'tso-kv' }, [
				E('i', { 'class': 'tso-kv-l', style: 'background:' + COLOR_PROXY }),
				E('span', { 'class': 'tso-kv-n', title: '' + node.name }, [ shorten(node.name, 22) ]),
				E('span', { 'class': 'tso-kv-v' }, [ fmtBytes(node.bytes) ])
			]);
		}));
	},

	// ------------------------------------------------------------ ④ Top 5

	renderTopDevices: function(state) {
		this.topDevBox = E('div', { 'class': 'tso-list' });
		dom.content(this.topDevBox, this.renderDeviceRows(state));

		/* 「阻断建议」面板：默认隐藏，点某台设备的按钮后在这里显示规则文本（只显示，不执行） */
		this.blockBox = E('div', { 'class': 'tso-block', style: 'display:none' });

		return E('div', { 'class': 'tso-panel' }, [
			E('div', { 'class': 'tso-ph' }, [
				E('span', { 'class': 'tso-ph-t' }, _('Top 5 设备')),
				E('span', { 'class': 'tso-ph-n' }, this.cell(function(s) {
					var n = (s != null && Array.isArray(s.devices)) ? s.devices.length : 0;
					return n ? (_('共') + ' ' + n + ' ' + _('台')) : '';
				})),
				E('span', { 'class': 'tso-ph-a' }, E('a', {
					href: L.url('admin/services/traffic-stats/devices')
				}, _('全部 →')))
			]),
			this.topDevBox,
			this.blockBox
		]);
	},

	/*
	 * 陌生设备判定（只读）：
	 *   1. 后端给了 first_seen 就直接用（24 小时内 → 打「新」）；
	 *   2. 当前 rpcd 的 project_device 还没有 first_seen，于是用浏览器 localStorage 里的
	 *      "第一次看到这个 MAC 的时间"兜底；只有 **base（首次打开本页）之后才出现** 的
	 *      MAC 才算新设备 —— 否则第一眼就把所有老设备都标成「新」。
	 * 这里只读写 localStorage，不碰任何后端接口、不执行命令。
	 */
	syncFirstSeen: function(devices, now) {
		var store = readFirstSeen();
		var seen = store.seen;
		var base = (store.base > 0) ? store.base : now;   /* 没有基线就以本次为基线 */
		var seeded = (store.count > 0);
		var out = {}, dirty = (store.base <= 0);
		var i, dev, mac, ts, prev, fs;

		for (i = 0; i < devices.length; i++) {
			dev = devices[i];
			mac = macOf(dev);

			if (!mac.length) continue;

			ts = backendFirstSeen(dev);
			if (ts > now + 600) ts = 0;              /* 未来时间戳（时钟漂移）当没有 */

			prev = num(seen[mac]);
			fs = (ts > 0) ? ts : prev;

			/* 两处都有值时取更早的那个：首次出现只会越记越早 */
			if (fs > 0 && prev > 0 && prev < fs) fs = prev;

			if (fs <= 0) {
				/* 建立基线的那一次：已有设备都记成 base（它们不算"新"设备）；
				   之后再出现的 MAC 记成 max(now, base+1)，与基线内的设备区分开
				   （同一秒内出现也能区分；这个时间戳只用于 24h 窗口和展示）。 */
				fs = seeded ? Math.max(now, base + 1) : base;
				seen[mac] = fs;
				dirty = true;
			}
			else if (prev != fs) {
				seen[mac] = fs;
				dirty = true;
			}

			/* 后端 first_seen 权威；否则只认"基线建立之后才第一次看到"的设备 */
			if (ts > 0 && (now - ts) <= NEW_DEVICE_SEC && ts <= now + 600)
				out[mac] = ts;
			else if (seeded && fs > base && (now - fs) <= NEW_DEVICE_SEC)
				out[mac] = fs;
		}

		if (dirty) writeFirstSeen(seen, base, now);

		/* devices.json 刚建立时，守护进程会把当时所有在线设备一次性写进 first_seen，
		   它们本来都不是"新设备"。判据：这批时间戳彼此相差不到 2 分钟、且都产生在
		   最近 15 分钟内 —— 属于同一次 bootstrap，全部不标"新"，避免满屏红点。
		   之后新接入的设备时间戳会明显晚于这批，照常标记。 */
		/* 判定基线：所有已知设备里最早的 first_seen，就是 devices.json 建立的时刻。
		   与它相差不到 2 分钟的设备属于同一次 bootstrap（当时全屋设备被一次性写入），
		   本来都不是"新设备"，不标红点；只有明显晚于这个拐点的才算新接入。
		   这个规则与"多久以前建立的"无关，所以不会随时间漂移。 */
		var base_ts = 0, k, v;

		for (k in seen) {
			v = num(seen[k]);

			if (v > 0 && (base_ts === 0 || v < base_ts))
				base_ts = v;
		}

		if (base_ts > 0) {
			for (k in out) {
				if (num(out[k]) - base_ts <= 120)
					delete out[k];
			}
		}

		return out;
	},

	renderDeviceRows: function(state) {
		var self = this;
		var devices = (state != null && Array.isArray(state.devices)) ? state.devices.slice() : [];
		var now = Math.floor(Date.now() / 1000);

		devices.sort(function(a, b) { return devBytes(b) - devBytes(a); });

		var top = devices.slice(0, 5);
		var max = devBytes(top[0] || null);
		var seen = this.syncFirstSeen(devices, now);

		if (top.length == 0)
			return E('div', { 'class': 'tso-note', style: 'padding:12px 0' }, _('暂无设备数据'));

		return E('div', {}, top.map(function(dev) {
			var proxy = num(dev.proxy_rx) + num(dev.proxy_tx);
			var direct = num(dev.direct_rx) + num(dev.direct_tx);
			var total = devBytes(dev);
			var link = linkLook(dev.link);
			var name = deviceName(dev);
			var mac = macOf(dev);
			var fs = num(seen[mac]);
			var age = now - fs;
			var isNew = (fs > 0) && age <= NEW_DEVICE_SEC && age > -600;
			var fromBackend = backendFirstSeen(dev) > 0;

			return E('div', { 'class': 'tso-lrow' }, [
				E('div', {}, [
					E('div', { 'class': 'tso-lname', title: name, style: 'display:flex;align-items:center;gap:4px' }, [
						E('span', {
							style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
						}, [ shorten(name, 26) ]),
						isNew ? firstSeenBadge(fs, fromBackend) : '',
						mac ? E('button', {
							'class': 'tso-btn',
							type: 'button',
							style: 'margin-left:auto;flex:none;font-size:10px;padding:0 6px;line-height:1.6',
							title: _('生成针对该设备 MAC 的 nftables 阻断规则（只显示，不执行）'),
							click: function(ev) {
								ev.preventDefault();
								self.showBlockAdvice(dev);
							}
						}, [ _('阻断建议') ]) : ''
					]),
					E('div', { 'class': 'tso-lsub' }, [
						/* 没主机名时名字本身就是 IP，别再重复一遍 */
						(dev.ip && ('' + dev.ip) != name) ? E('code', {}, [ '' + dev.ip ]) : '',
						E('span', { 'class': 'tso-chip', style: 'color:' + link.color }, [ link.label ]),
						mac ? '' : E('span', {
							'class': 'tso-chip',
							title: _('state.json 里没有这台设备的 MAC，无法生成基于 MAC 的规则')
						}, [ _('无 MAC') ])
					])
				]),
				E('div', { 'class': 'tso-mini', title: _('代理') + ' ' + fmtPercent(proxy, total) + ' · ' + _('直连') + ' ' + fmtPercent(direct, total) }, [
					E('i', { style: 'background:' + COLOR_PROXY + ';width:' + pct(proxy, max).toFixed(2) + '%' }),
					E('i', { style: 'background:' + COLOR_DIRECT + ';width:' + pct(direct, max).toFixed(2) + '%' })
				]),
				E('div', { 'class': 'tso-lnum' }, [ fmtBytes(total) ])
			]);
		}));
	},

	/* 只生成 / 显示规则文本，不调用任何写入接口、不执行任何命令 */
	showBlockAdvice: function(dev) {
		var self = this;
		var mac = macOf(dev);
		var name = deviceName(dev);

		if (this.blockBox == null) return;

		if (!mac.length) {
			dom.content(this.blockBox, [
				E('div', { 'class': 'tso-block-h' }, E('strong', {}, _('阻断建议'))),
				E('div', { 'class': 'tso-block-n' },
					_('这台设备的 state.json 里没有 MAC（只有 IP），无法生成基于 MAC 的 nftables 规则。'))
			]);

			this.blockBox.style.display = '';

			return;
		}

		var cmd = 'nft add rule inet fw4 forward ether saddr ' + mac + ' counter drop';
		var copyBtn = E('button', {
			'class': 'tso-btn',
			type: 'button',
			title: _('只复制命令，不执行'),
			click: function(ev) {
				ev.preventDefault();
				self.copyText(cmd, copyBtn);
			}
		}, [ _('复制命令') ]);

		var closeBtn = E('button', {
			'class': 'tso-btn',
			type: 'button',
			click: function(ev) {
				ev.preventDefault();
				self.hideBlockAdvice();
			}
		}, [ _('收起') ]);

		dom.content(this.blockBox, [
			E('div', { 'class': 'tso-block-h' }, [
				E('strong', {}, _('阻断建议') + '：' + shorten(name, 30)),
				E('code', { style: 'font-size:10.5px;opacity:.75' }, mac),
				E('span', { style: 'margin-left:auto;display:flex;gap:6px' }, [ copyBtn, closeBtn ])
			]),
			E('p', { style: 'margin:4px 0 0 0;color:#e65100' },
				_('需在路由器 SSH 中手动执行；执行前请确认不是自己的设备')),
			E('pre', {}, E('code', {}, cmd)),
			E('div', { 'class': 'tso-block-n' },
				_('本页只显示命令，不会执行；nft 规则在防火墙重载 / 重启后失效。'))
		]);

		this.blockBox.style.display = '';
	},

	hideBlockAdvice: function() {
		if (this.blockBox == null) return;

		this.blockBox.style.display = 'none';
		dom.content(this.blockBox, '');
	},

	/* 复制到剪贴板：安全上下文用 navigator.clipboard，否则退回选中 + execCommand；都不行就提示手动复制 */
	copyText: function(text, btn) {
		var flash = function(ok) {
			if (btn == null) return;

			btn.textContent = ok ? _('已复制') : _('请手动复制');

			window.setTimeout(function() {
				if (btn != null) btn.textContent = _('复制命令');
			}, 2000);
		};

		var fallback = function() {
			var ok = false, area = null;

			try {
				area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', '');
				area.style.position = 'fixed';
				area.style.top = '-1000px';
				document.body.appendChild(area);
				area.select();
				ok = (typeof document.execCommand == 'function') ? document.execCommand('copy') : false;
			}
			catch (e) {
				ok = false;
			}
			finally {
				if (area != null && area.parentNode != null) area.parentNode.removeChild(area);
			}

			flash(ok === true);
		};

		try {
			if (window.navigator != null && window.navigator.clipboard != null &&
				typeof window.navigator.clipboard.writeText == 'function') {
				window.navigator.clipboard.writeText(text).then(function() {
					flash(true);
				}).catch(fallback);

				return;
			}
		}
		catch (e) { }

		fallback();
	},

	renderTopApps: function(state) {
		this.topAppBox = E('div', { 'class': 'tso-list' });
		dom.content(this.topAppBox, this.renderAppRows(state));

		return E('div', { 'class': 'tso-panel' }, [
			E('div', { 'class': 'tso-ph' }, [
				E('span', { 'class': 'tso-ph-t' }, _('Top 5 应用 / 域名')),
				E('span', { 'class': 'tso-ph-n' }, this.cell(function(s) {
					var n = (s != null && Array.isArray(s.apps)) ? s.apps.length : 0;
					return n ? (_('共') + ' ' + n + ' ' + _('条')) : '';
				})),
				E('span', { 'class': 'tso-ph-a' }, E('a', {
					href: L.url('admin/services/traffic-stats/apps')
				}, _('全部 →')))
			]),
			this.topAppBox
		]);
	},

	renderAppRows: function(state) {
		var apps = (state != null && Array.isArray(state.apps)) ? state.apps.slice() : [];

		apps.sort(function(a, b) { return appBytes(b) - appBytes(a); });

		var top = apps.slice(0, 5);
		var max = appBytes(top[0] || null);

		if (top.length == 0)
			return E('div', { 'class': 'tso-note', style: 'padding:12px 0' }, _('暂无应用数据'));

		return E('div', {}, top.map(function(app) {
			var total = appBytes(app);
			var look = chainLook(app.chain);
			var host = (app.host == '__other__') ? _('其他（合并）') : app.host;

			return E('div', { 'class': 'tso-lrow' }, [
				E('div', {}, [
					E('div', { 'class': 'tso-lname', title: '' + (app.host || '') }, [ shorten(host || _('未知'), 30) ]),
					E('div', { 'class': 'tso-lsub' }, [
						E('span', { 'class': 'tso-chip', style: 'color:' + look.color }, [ look.label ]),
						num(app.devices) > 0 ? E('span', {}, [ num(app.devices) + ' ' + _('台设备') ]) : ''
					])
				]),
				E('div', { 'class': 'tso-mini', title: fmtPercent(total, max) + ' ' + _('（相对第一名）') }, [
					E('i', { style: 'background:' + look.color + ';width:' + pct(total, max).toFixed(2) + '%' })
				]),
				E('div', { 'class': 'tso-lnum' }, [ fmtBytes(total) ])
			]);
		}));
	},

	// ------------------------------------------------------------ 空态 / 不可用

	renderEmptyNotice: function(state) {
		var health = (state != null && state.health) ? state.health : {};
		var reasons = Array.isArray(health.reasons) ? health.reasons : [];

		return E('div', { 'class': 'tso-alert' }, [
			E('strong', {}, _('暂无数据') + '：'),
			' ' + ((state != null && state.running === true)
				? _('traffic-statsd 正在运行，但还没有采到流量；几秒后自动刷新。')
				: _('traffic-statsd 未运行或刚启动，因此还没有 state.json。')),
			reasons.length ? E('ul', {}, reasons.map(function(r) {
				return E('li', {}, [ '' + r ]);
			})) : '',
			E('div', { 'class': 'tso-note' }, [
				E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页')),
				' · ' + _('检查采集参数与服务状态')
			])
		]);
	},

	renderUnavailable: function() {
		this.root = E('div', { 'id': 'ts-overview' }, [
			E('style', {}, CSS),
			E('h2', { 'class': 'tso-title', style: 'margin-bottom:10px' }, _('流量统计 · 总览')),
			E('div', { 'class': 'tso-alert' }, [
				E('strong', {}, _('读取不到统计数据') + '：'),
				' ',
				this.stateError
					? (_('get_state 失败：') + shorten(this.stateError, 160))
					: _('rpcd 对象 traffic-stats 不可用，或者后端尚未安装。'),
				E('div', { 'class': 'tso-note' }, [
					_('已安装 traffic-statsd 的话，请确认 rpcd 已重载：') + ' ',
					E('code', {}, '/etc/init.d/rpcd reload'),
					' · ',
					E('a', { href: L.url('admin/services/traffic-stats/settings') }, _('前往设置页'))
				])
			])
		]);

		return this.root;
	},

	// ------------------------------------------------------------ 刷新

	/* 记录所有需要随刷新更新的文本节点 */
	cell: function(render, attrs) {
		var node = E('span', attrs || {}, '—');

		this.cells.push({ node: node, render: render });

		return node;
	},

	/* 记录所有需要随刷新更新宽度的条（0..100%） */
	bar: function(render, color) {
		var node = E('i', { 'class': 'tso-fill', style: 'background:' + color + ';width:0%' });

		this.bars.push({ node: node, render: render });

		return node;
	},

	syncAll: function(state) {
		var i, p;

		for (i = 0; i < this.cells.length; i++) {
			try {
				p = this.cells[i].render(state);
				this.cells[i].node.textContent = (p == null) ? '' : ('' + p);
			}
			catch (e) {
				this.cells[i].node.textContent = '';
			}
		}

		for (i = 0; i < this.bars.length; i++) {
			try {
				p = num(this.bars[i].render(state));
				this.bars[i].node.style.width = Math.min(100, Math.max(0, p)).toFixed(2) + '%';
			}
			catch (e) { }
		}

		this.syncStatus(state);
	},

	/* 30s 重建一次动态块（Top 列表 / 节点块）：比每 5s 重建省事，也不会闪 */
	rebuildDynamic: function(state) {
		if (this.nodeBox != null)
			dom.content(this.nodeBox, this.renderNodeRows(state));

		if (this.topDevBox != null)
			dom.content(this.topDevBox, this.renderDeviceRows(state));

		if (this.topAppBox != null)
			dom.content(this.topAppBox, this.renderAppRows(state));
	},

	startRefresh: function() {
		var self = this;

		if (this.timer != null) return;

		this.timer = window.setInterval(function() {
			/* 离开页面后 #view 会被清空，这里把定时器停掉，避免后台一直轮询 */
			if (self.root == null || !document.body.contains(self.root)) {
				self.stopRefresh();
				return;
			}

			callState().then(function(state) {
				if (state == null || typeof state != 'object' || state.totals == null) return;

				self.state = state;
				self.syncAll(state);

				if (++self.tick % TOPS_EVERY == 0)
					self.rebuildDynamic(state);

				/* 守护进程停了就不必再轮询（服务重启后刷新页面即可） */
				if (state.running !== true)
					self.stopRefresh();
			}).catch(function() { });
		}, REFRESH_MS);
	},

	stopRefresh: function() {
		if (this.timer != null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}

		if (this.resizeTimer != null) {
			window.clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}

		if (this.resizeHandler != null) {
			window.removeEventListener('resize', this.resizeHandler);
			this.resizeHandler = null;
		}
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});

// ---------------------------------------------------------------- 文案拼装

/* 技术细节行（默认折叠在"详情"里）：数据源 / conntrack / clash / 接入判定 */
function techText(state) {
	var health = (state != null && state.health) ? state.health : {};
	var source = (state != null && state.source && typeof state.source == 'object') ? state.source : {};
	var ports = Array.isArray(health.link_ports) ? health.link_ports : [];
	var linkText = ('' + (health.link_source || 'none')) == 'brctl'
		? ('brctl' + (ports.length ? ' (' + ports.join(',') + ')' : ''))
		: ('none' + (health.link_error ? ' · ' + health.link_error : ''));

	return [
		_('数据源') + ' clash=' + (source.clash || 'unknown') + ' · conntrack=' + (source.conntrack || 'unknown'),
		_('conntrack 条目') + ' ' + num(health.conntrack_count),
		_('clash 连接') + ' ' + num(health.clash_connections),
		_('轮询') + ' ' + num(health.clash_poll_ms) + ' ms',
		_('接入判定') + ' ' + linkText,
		_('FDB 条目') + ' ' + num(health.link_entries),
		_('刷新') + ' ' + num(health.link_refresh) + ' s'
	].join(' · ');
}

/* 接入方式的判据提示（原版大段说明，压成一行小字） */
function linkHint(state) {
	var health = (state != null && state.health) ? state.health : {};
	var ports = Array.isArray(health.link_ports) ? health.link_ports : [];
	var source = '' + (health.link_source || 'none');
	var bridge = '' + (health.link_bridge || 'br-lan');

	if (source != 'brctl')
		return _('读不到桥 FDB（brctl 不可用）：接入方式一律 unknown，代理/直连统计不受影响。');

	if (ports.length == 0)
		return _('未配置无线上联端口（wireless_ports / ap_macs），FDB 学到的设备一律归为有线。');

	return _('判据') + '：brctl showmacs ' + bridge + ' · ' + _('上联端口') + ' ' + ports.join(', ');
}
