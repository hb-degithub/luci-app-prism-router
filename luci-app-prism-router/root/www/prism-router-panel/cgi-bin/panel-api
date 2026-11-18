#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// panel-api —— 独立面板的只读 JSON API（uhttpd CGI）
// 安装为 /www/prism-router-panel/cgi-bin/panel-api，由 prism-router-panel.init 启动的
// 独立 uhttpd 实例（-x /cgi-bin）执行；契约见 docs/SPEC.md「独立面板服务」。
//
// ───────────────────────── 安全边界（必读，别按直觉改）─────────────────────────
//   * 只读：只调用 ubus 对象 prism-router 的只读方法（get_state / get_history /
//     get_nodes / get_stations / status）。**不写任何文件**，除 `ubus call` 之外
//     不执行外部命令。
//   * 认证：UCI prism-router.panel.token 非空时，请求必须带**完全相同**的
//     `?token=`、`X-Panel-Token:` 头或 `Authorization: Bearer <token>`，否则 401。
//     token 为空 = 不做应用层认证，只依赖网络边界（面板默认关闭，建议保持关闭或设置 token）。
//     ⚠ uhttpd 只把 Accept / Authorization / Host / User-Agent 转成 CGI 环境变量，
//     自定义 X-* 头会被静默丢弃（ingest.uc 里同样的实测结论）。所以经本服务访问时
//     实际可用的是 `?token=` 与 `Authorization: Bearer`；X-Panel-Token 仍保留，
//     供 nginx+fcgiwrap 等标准 CGI 或反向代理转发使用。
//   * 方法白名单：state / history / nodes / stations / status，其它 400；
//     GET / HEAD 之外 405。
//   * 任何异常（ubus 不可用、返回非 JSON、内部错误）一律 500 {"error":"internal"}，
//     绝不把堆栈、路径或命令输出泄给调用方。
//   * 不记录任何日志（尤其不记录 token）；响应头带 no-store / nosniff / no-referrer。
//
// 手工调试（不需要 web 服务器，直接喂环境变量）：
//   env REQUEST_METHOD=GET QUERY_STRING="what=state" ucode /www/prism-router-panel/cgi-bin/panel-api
//
// 依赖：ucode（fs / uci 内建）+ ubus CLI + rpcd 的 prism-router 插件（luci-app-prism-router）。
'use strict';

import { popen } from 'fs';
import { cursor } from 'uci';

const UCI_CONFIG      = 'prism-router';
const UBUS_OBJECT     = 'prism-router';
/* ubus 单条消息上限 262144B；留出余量，超了按内部错误处理，绝不把半截 JSON 转发出去。 */
const MAX_UBUS_BYTES  = 256 * 1024;
const MAX_TOKEN_BYTES = 256;
const DEFAULT_DAYS    = 1;
const MAX_DAYS        = 31;

/* what -> ubus 方法。只读方法，绝不能在这里加写方法（set_config / restart / ...）。 */
const ALLOWED = {
	state:    'get_state',
	history:  'get_history',
	nodes:    'get_nodes',
	stations: 'get_stations',
	status:   'status'
};

const HEADERS = [
	'Content-Type: application/json; charset=utf-8',
	'Cache-Control: no-store',
	'X-Content-Type-Options: nosniff',
	'Referrer-Policy: no-referrer'
];

let SENT = false;

/* settings 只读投影：只回传非敏感的配置项，绝不回传 token/密钥原值。 */
const SETTINGS_FIELDS = [
	'enabled', 'poll_interval', 'history_days', 'metrics_enabled',
	'mother_enabled', 'stations_enabled',
	'legacy_shared_secret', 'legacy_stations_token'
];

function read_settings() {
	const c = cursor();
	const out = { settings: {}, panel: {}, write: { enabled: false } };

	for (let k in SETTINGS_FIELDS) {
		const v = c.get(UCI_CONFIG, 'settings', k);
		if (type(v) == 'string') out.settings[k] = v;
	}

	/* 飞书与保留策略不在 settings 段：映射成扁平字段给前端，保持只读契约不变。 */
	const fe = c.get(UCI_CONFIG, 'feishu', 'enabled');
	if (type(fe) == 'string') out.settings.feishu_enabled = fe;

	const rd = c.get(UCI_CONFIG, 'retention', 'daily_days');
	if (type(rd) == 'string') out.settings.retention_daily_days = rd;

	const enabled = c.get(UCI_CONFIG, 'panel', 'enabled');
	const port = c.get(UCI_CONFIG, 'panel', 'port');
	const bind = c.get(UCI_CONFIG, 'panel', 'bind');
	const token = c.get(UCI_CONFIG, 'panel', 'token');

	out.panel = {
		enabled: (enabled == '1'),
		port: (type(port) == 'string' && length(port) > 0) ? port : '8099',
		bind: (type(bind) == 'string') ? bind : '',
		has_token: (type(token) == 'string' && length(token) > 0)
	};

	return out;
}

// ───────────────────────────── 基础工具 ─────────────────────────────

function env(name) {
	const v = getenv(name);

	return (type(v) == 'string') ? v : '';
}

/* CGI 的 QUERY_STRING 是原始百分号编码；ucode 这个版本没有 urldecode，
   所以自己解（只处理 %XX 与 '+'，非法转义原样保留）。 */
function qs_decode(s) {
	let out = '';
	let i = 0;
	const n = length(s);

	while (i < n) {
		const ch = substr(s, i, 1);

		if (ch == '+') {
			out += ' ';
			i++;
			continue;
		}

		if (ch == '%' && i + 2 < n) {
			const hexs = substr(s, i + 1, 2);

			if (match(hexs, /^[0-9a-fA-F]{2}$/)) {
				out += chr(hexdec(hexs));
				i += 3;
				continue;
			}
		}

		out += ch;
		i++;
	}

	return out;
}

function qs_parse(raw) {
	const out = {};

	if (length(raw) == 0)
		return out;

	for (let pair in split(raw, '&')) {
		if (length(pair) == 0)
			continue;

		const pos = index(pair, '=');
		let key, value;

		if (pos < 0) {
			key = pair;
			value = '';
		}
		else {
			key = substr(pair, 0, pos);
			value = substr(pair, pos + 1);
		}

		key = qs_decode(key);

		if (length(key) == 0)
			continue;

		/* 同名参数以后出现的为准（与大多数 CGI 一致）。 */
		out[key] = qs_decode(value);
	}

	return out;
}

function opt(query, name) {
	const v = query[name];

	return (type(v) == 'string') ? v : '';
}

/* days：只接受 1–3 位十进制；非法回退 1，越界夹到 1..31（不把脏值传给 ubus）。 */
function clamp_days(raw) {
	if (length(raw) == 0 || !match(raw, /^[0-9]{1,3}$/))
		return DEFAULT_DAYS;

	const n = int(raw);

	if (n < 1)
		return 1;

	if (n > MAX_DAYS)
		return MAX_DAYS;

	return n;
}

// ───────────────────────────── 认证 ─────────────────────────────

function config_token() {
	try {
		/* ucode 的 uci cursor 不带参：config 名是 get() 的第一个参数
		   （cursor('prism-router') 会读不到任何值）。 */
		const c = cursor();
		const v = c.get(UCI_CONFIG, 'panel', 'token');

		return (type(v) == 'string') ? v : '';
	}
	catch (e) {
		/* 配置缺失/读不到按"未设 token"处理（面板默认关闭，不额外放大成 500）。 */
		return '';
	}
}

/* 常量时间比较：长度本身就是公开信息，长度不同直接失败；其余逐字节 XOR 累积。 */
function token_matches(want, got) {
	if (length(want) != length(got))
		return false;

	let diff = 0;

	for (let i = 0; i < length(want); i++)
		diff |= ord(substr(want, i, 1)) ^ ord(substr(got, i, 1));

	return diff == 0;
}

function authorized(want, query_token, header_token, bearer) {
	if (length(want) == 0)
		return true;

	if (length(header_token) > 0 && length(header_token) <= MAX_TOKEN_BYTES
	    && token_matches(want, header_token))
		return true;

	if (length(bearer) > 0 && length(bearer) <= MAX_TOKEN_BYTES
	    && token_matches(want, bearer))
		return true;

	if (length(query_token) > 0 && length(query_token) <= MAX_TOKEN_BYTES
	    && token_matches(want, query_token))
		return true;

	return false;
}

/* Authorization: Bearer <token> —— uhttpd 只转发 Accept/Authorization/Host/User-Agent，
   自定义 X-* 头会被静默丢弃（与 ingest.uc 的实测结论一致）。所以规范要求的
   X-Panel-Token 之外，这里再接受 Bearer，保证"用请求头传 token"在 uhttpd 下真的可用。
   只认 "Bearer " 前缀（大小写不敏感），其余一律当没有。 */
function bearer_token(raw) {
	if (length(raw) <= 7)
		return '';

	if (lc(substr(raw, 0, 7)) != 'bearer ')
		return '';

	return trim(substr(raw, 7));
}

// ───────────────────────────── ubus 只读调用 ─────────────────────────────

/* 唯一被允许的外部命令：ubus call，对象与方法都是本文件的常量，参数只有 days 整数。
   返回解析后的 JSON；任何失败（无法 popen / 非零退出 / 超限 / 坏 JSON）返回 null。 */
function ubus_call(method, args) {
	let cmd = sprintf('ubus call %s %s', UBUS_OBJECT, method);

	if (args != null)
		cmd = sprintf("%s '%s'", cmd, sprintf('%J', args));

	const p = popen(cmd, 'r');

	if (!p)
		return null;

	let out = '', buf = '', failed = false;

	try {
		while (length((buf = p.read(4096))) > 0) {
			out += buf;

			if (length(out) > MAX_UBUS_BYTES) {
				failed = true;
				break;
			}
		}
	}
	catch (e) {
		failed = true;
	}

	const rc = p.close();

	if (failed || rc != 0)
		return null;

	try {
		return json(out);
	}
	catch (e) {
		return null;
	}
}

// ───────────────────────────── 响应 ─────────────────────────────

function emit(code, reason, body, method) {
	const payload = sprintf('%J', body);
	let head = '';

	if (code != 200)
		head += sprintf('Status: %d %s\r\n', code, reason);

	for (let h in HEADERS)
		head += sprintf('%s\r\n', h);

	head += sprintf('Content-Length: %d\r\n\r\n', length(payload));

	printf('%s', head);
	SENT = true;

	/* HEAD 只回头，不回体；Content-Length 仍是"GET 会得到的字节数"。 */
	if (method != 'HEAD')
		printf('%s', payload);
}

function fail(code, reason, error, method) {
	emit(code, reason, { error: error }, method);
}

// ───────────────────────────── 主流程 ─────────────────────────────

function handle(query) {
	/* 认证先于参数校验：未认证的调用方连"what 白名单"都不该探测到。 */
	const token = config_token();

	if (!authorized(token, opt(query, 'token'), env('HTTP_X_PANEL_TOKEN'),
	                  bearer_token(env('HTTP_AUTHORIZATION'))))
		return { code: 401, reason: 'Unauthorized', body: { error: 'unauthorized' } };

	let what = opt(query, 'what');

	if (length(what) == 0)
		what = 'state';

	if (what == 'settings')
		return { code: 200, reason: 'OK', body: read_settings() };

	if (ALLOWED[what] == null)
		return { code: 400, reason: 'Bad Request', body: { error: 'bad_request' } };

	const args = (what == 'history') ? { days: clamp_days(opt(query, 'days')) } : null;
	const data = ubus_call(ALLOWED[what], args);

	if (data == null || (type(data) != 'object' && type(data) != 'array'))
		return { code: 500, reason: 'Internal Server Error', body: { error: 'internal' } };

	return { code: 200, reason: 'OK', body: data };
}

function main() {
	let method = env('REQUEST_METHOD');

	if (length(method) == 0)
		method = 'GET';

	if (method != 'GET' && method != 'HEAD') {
		fail(405, 'Method Not Allowed', 'method_not_allowed', method);
		return;
	}

	let res;

	try {
		res = handle(qs_parse(env('QUERY_STRING')));
	}
	catch (e) {
		res = { code: 500, reason: 'Internal Server Error', body: { error: 'internal' } };
	}

	emit(res.code, res.reason, res.body, method);
}

try {
	main();
}
catch (e) {
	/* 最后兜底：不输出堆栈/路径；已经发过响应就不再补发（避免重复头）。 */
	if (!SENT)
		emit(500, 'Internal Server Error', { error: 'internal' },
		     (env('REQUEST_METHOD') == 'HEAD') ? 'HEAD' : 'GET');
}