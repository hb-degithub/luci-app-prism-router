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
 *     所以趋势图只画当天桶，标题按实际跨度写，不谎称"近 24h"。
 *
 * rpc 预算（硬约束）：
 *   进入页面 get_state ×1 + get_history ×1（history 只取 days=1，不轮询、不重试）；
 *   之后每 5s 只复用 get_state 刷新数字，不重画图表、不重排布局、不加新请求。
 */

// ---------------------------------------------------------------- rpc

var callState = rpc.declare({
	object: 'traffic-stats',
	method: 'get_state',
	expect: {},
	reject: true
});

/*
 * get_history 只取 days=1：
 *   - history.json 里只有当日 5 分钟桶（SPEC §3.1），多要一天只换来一份没有桶的日汇总；
 *   - 返回体带每桶 top_apps/top_devices，一天 288 桶已接近 ubus 单条消息 262144B 上限，
 *     请求到 days=2 有把整次调用打到 "Operation not supported" 的风险。
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

	return { color: '#c62828', bg: 'rgba(198,40,40,.12)', label: _('记账状态未知') };
}

function deviceName(dev) {
	if (dev == null) return _('未知设备');
	if (dev.hostname && ('' + dev.hostname).length) return '' + dev.hostname;
	if (dev.ip && ('' + dev.ip).length) return '' + dev.ip;
	if (dev.mac && ('' + dev.mac).length) return '' + dev.mac;

	return _('未知设备');
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

		if (!ls || (nowSec - ls) <= ONLINE_SEC) n++;
	}

	return n;
}

// ---------------------------------------------------------------- 趋势数据

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
 * ------------------------------------------------------------------ */
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

	var out = [];
	var g, gy;

	for (g = 0; g <= 3; g++) {
		gy = PT + (H - PT - PB) * g / 3;
		out.push('<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) +
			'" stroke="rgba(127,127,127,.16)" stroke-width="1"/>');
		out.push('<text x="' + (PL - 6) + '" y="' + (gy + 3).toFixed(1) +
			'" font-size="10" fill="rgba(127,127,127,.85)" text-anchor="end">' + fmtY(max * (1 - g / 3)) + '</text>');
	}

	sets.forEach(function (s) {
		var d = s.data.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
		out.push('<path d="' + d + '" fill="none" stroke="' + (s.strokeColor || '#1a73e8') +
			'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>');
	});

	var step = Math.max(1, Math.ceil(n / 7));

	for (var i = 0; i < n; i += step)
		out.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) +
			'" font-size="10" fill="rgba(127,127,127,.85)" text-anchor="middle">' + labels[i] + '</text>');

	var legend = sets.map(function (s) {
		return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px">' +
			'<i style="width:10px;height:3px;border-radius:2px;background:' + (s.strokeColor || '#1a73e8') + ';display:inline-block"></i>' +
			(s.label || '') + '</span>';
	}).join('');

	host.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column">' +
		'<div style="flex:1;min-height:0"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
		'style="width:100%;height:100%;display:block">' + out.join('') + '</svg></div>' +
		'<div style="font-size:11px;opacity:.75;padding:6px 0 0 46px">' + legend + '</div></div>';

	return { destroy: function () { try { host.innerHTML = ''; } catch (e) { } } };
}

return view.extend({
	load: function() {
		var self = this;

		this.stateError = '';
		this.historyError = '';

		/* 两个 rpc 并行发；任何一个失败都不影响另一个（history 失败只让趋势图降级） */
		return Promise.all([
			callState().catch(function(err) {
				self.stateError = (err != null && err.message) ? ('' + err.message) : '' + err;
				return null;
			}),
			callHistory(1).catch(function(err) {
				self.historyError = (err != null && err.message) ? ('' + err.message) : '' + err;
				return null;
			})
		]).then(function(res) {
			self.state = (res[0] != null && typeof res[0] == 'object' && res[0].totals != null) ? res[0] : null;
			self.history = (res[1] != null && typeof res[1] == 'object') ? res[1] : null;
			self.trend = trendOf(self.history, Math.floor(Date.now() / 1000));
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

		function card(title, chip, chipTitle, valueNode, subNodes, barNode) {
			return E('div', { 'class': 'tso-kpi' }, [
				E('div', { 'class': 'tso-kpi-h' }, [
					E('span', { 'class': 'tso-kpi-t' }, title),
					chip ? E('span', { 'class': 'tso-kpi-chip', title: chipTitle || null }, chip) : ''
				]),
				E('div', { 'class': 'tso-kpi-v' }, valueNode),
				subNodes,
				barNode || ''
			]);
		}

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

		/* 图表库由 luci-lib-chartjs 提供（nlbw.chart.min.js，Chart.js v1 API）。
		   异步注入：必须等 script 的 load 事件，不能在 render 里直接 new Chart。 */
		if (has && typeof window.Chart != 'function') {
			nodes.push(E('script', {
				type: 'text/javascript',
				src: L.resource('nlbw.chart.min.js'),
				load: function() { self.drawTrend(); },
				error: function() {
					self.chartFailed(_('图表库未安装（luci-lib-chartjs），趋势图无法绘制；上面的数字仍然有效。'));
				}
			}));
		}

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

		if (typeof window.Chart == 'function') {
			/* 图表库已在（第二次进页面）：等节点进 DOM 后再量宽度 */
			window.setTimeout(function() {
				if (run == self.renderSeq) self.drawTrend();
			}, 0);
		}
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

	/* Chart.js v1 按 canvas.width/height 绘制（没有 responsive），所以自己量容器宽度 */
	drawTrend: function() {
		var host = this.plotHost;
		var canvas = this.canvas;
		var ChartLib = window.Chart;

		if (host == null || canvas == null) return;
		if (typeof ChartLib != 'function') return;
		if (this.trend == null || this.trend.points.length == 0) return;
		if (!document.body.contains(canvas)) return;

		var w = Math.floor(host.clientWidth || host.offsetWidth || 0);
		var h = Math.floor(host.clientHeight || 0);

		if (!(w >= 120)) w = 640;      /* 布局还没生效时给一个兜底宽度 */
		if (!(h >= 120)) h = TREND_H;
		if (h > TREND_MAX_H) h = TREND_MAX_H;

		canvas.width = w;
		canvas.height = h;
		canvas.style.width = w + 'px';
		canvas.style.height = h + 'px';

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
			this.topDevBox
		]);
	},

	renderDeviceRows: function(state) {
		var devices = (state != null && Array.isArray(state.devices)) ? state.devices.slice() : [];

		devices.sort(function(a, b) { return devBytes(b) - devBytes(a); });

		var top = devices.slice(0, 5);
		var max = devBytes(top[0] || null);

		if (top.length == 0)
			return E('div', { 'class': 'tso-note', style: 'padding:12px 0' }, _('暂无设备数据'));

		return E('div', {}, top.map(function(dev) {
			var proxy = num(dev.proxy_rx) + num(dev.proxy_tx);
			var direct = num(dev.direct_rx) + num(dev.direct_tx);
			var total = devBytes(dev);
			var link = linkLook(dev.link);
			var name = deviceName(dev);

			return E('div', { 'class': 'tso-lrow' }, [
				E('div', {}, [
					E('div', { 'class': 'tso-lname', title: name }, [ shorten(name, 26) ]),
					E('div', { 'class': 'tso-lsub' }, [
						/* 没主机名时名字本身就是 IP，别再重复一遍 */
						(dev.ip && ('' + dev.ip) != name) ? E('code', {}, [ '' + dev.ip ]) : '',
						E('span', { 'class': 'tso-chip', style: 'color:' + link.color }, [ link.label ])
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
