#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# prism-router-ap-agent —— AP 侧「绑定 + 上报 + 命令轮询」代理（POSIX sh）
#
# 安装位置：/usr/share/prism-router/ap-agent.sh（母节点随包分发）
# 也可以直接拷到 AP 上任意路径运行；--install 把配置写到 /etc/prism-router-ap/。
#
# 每一轮（cron 每分钟 / --loop 按 --interval）做三件事：
#   1. 采集本机 AP BSS 的无线站点元数据（mac/iface/signal/rx_rate/tx_rate/connected_sec），
#      **绝不采集任何字节字段**（客户端流量由主路由 conntrack 统计，AP 再报就是重复计数，
#      见 docs/AP-ROLE.md 方案 B）；
#   2. POST <url>?action=ap_report 上报；首轮用一次性绑定令牌自动完成绑定；
#   3. GET  <url>?action=ap_poll 取待执行命令，只认白名单 refresh|reboot，
#      执行结果 POST <url>?action=ap_result 回传。
#
# ───────────────────────────── 鉴权（v1）─────────────────────────────
# 全部字段走 Authorization（uhttpd 只转发 Authorization/ACCEPT/HOST/USER_AGENT，
# 自定义 X-* 头会被静默丢弃 —— 与该仓库 ingest / stations 的实测结论一致）：
#
#   Authorization: PrismAP token=<32 hex>;ts=<epoch>;sign=<64 hex>
#
# 同时发送 X-Prism-Token / X-Prism-Ts / X-Prism-Sign（给 nginx 等标准 CGI 用；
# uhttpd 下会被丢掉，不影响）。签名：
#
#   sign = HMAC-SHA256(key = token 的 ASCII 文本,
#                      msg  = "PRISM-AP1\n" + action + "\n" + node_id + "\n" + ts + "\n" + sha256_hex(body))
#
# GET（ap_poll）没有 body，body 为空串，sha256_hex("") 也要算进去。
# 时间戳与母节点偏差必须 ≤ 300 秒，母节点按 IP 限速 120 次/分钟。
#
# ───────────────────────── 为什么不用 openssl ─────────────────────────
# 实测目标 AP（ImmortalWrt / aarch64）**没有 openssl**，而 busybox 一定有
# sha256sum 与 printf。所以这里用纯 shell 实现 HMAC-SHA256：
#   * 64 字节 ipad/opad 用 printf '%b' + \0nnn 八进制转义直接**流式**送进 sha256sum，
#     二进制（含 NUL）从不进 shell 变量 —— 这是唯一能正确处理 key 含 0x36/0x5c
#     字节（pad 后出现 NUL）的写法；
#   * token 只进 shell 变量与 Authorization 头，**绝不进 argv / 环境变量 / 日志**
#     （openssl -hmac 会把 key 放进 /proc/<pid>/cmdline，所以即使在有 openssl 的
#     机器上也不用它）。
#   已用 openssl 对拍：普通 key、32 字符 token、含 NUL pad 的 key 全部一致。
#
# ───────────────────────────── 用法 ─────────────────────────────
#   # 一次性绑定 + 安装（ap_bind_start 返回的 cmd 就是这条，token 只出现这一次）：
#   ap-agent.sh --url http://192.168.100.1/cgi-bin/prism-router-ingest \
#               --token <32 hex> --install
#
#   # 手动跑一轮（不落配置、不改 crontab）：
#   ap-agent.sh --url ... --token ... --node-id ap-1 --once
#
#   # 常驻（不用 cron）：
#   ap-agent.sh --loop --interval 60
#
#   # cron（--install 自动写这一行；每分钟一轮，脚本自带单实例锁）：
#   * * * * * /usr/share/prism-router/ap-agent.sh >/dev/null 2>&1
#
#   其它参数：
#     --node-id ID     默认取 hostname（只保留 [A-Za-z0-9._-]）
#     --name NAME      上报的展示名，默认 = node_id
#     --iface A,B      指定 AP 接口；默认 `iw dev` 枚举 type AP（不含 AP/VLAN）
#     --interval N     仅 --loop 使用，默认 60 秒（1..86400）
#     --conf FILE      配置文件，默认 /etc/prism-router-ap/agent.conf（0600）
#     --insecure       跳过 TLS 证书校验（母节点自签 uhttpd 证书时用；HMAC 仍校验请求）
#     --cafile FILE    用指定 CA 校验母节点证书
#     --install        写配置(0600) + 写 crontab（去重）+ 立即跑一轮
#     --once           只跑一轮（默认行为）
#     --loop           常驻循环
#     --quiet          不打印，只写日志
#     --timeout N      HTTP 超时秒数，默认 15
#     --hmac KEY MSG   仅调试/门禁：打印 HMAC-SHA256 十六进制（不联网）
#     --selftest       仅调试/门禁：内部自检，成功打印 selftest OK
#     -h|--help
#
# 退出码：0 = 成功 / 无事可做（含锁被占用）；1 = 配置错误；2 = 网络或鉴权失败。
# cron 每分钟会重试，所以失败绝不刷屏：日志 256 KB 轮转，同类消息 5 分钟最多一条。
#
# 环境变量（只给测试/现场排查用，线上默认行为不受影响）：
#   PRISM_ROUTER_AP_CONF     覆盖配置文件路径
#   PRISM_ROUTER_AP_LOG      覆盖日志路径（默认 /tmp/prism-router-ap-agent.log）
#   PRISM_ROUTER_AP_LOCK     覆盖锁目录（默认 /tmp/prism-router-ap-agent.lock）
#   PRISM_ROUTER_AP_CRONTAB  用该文件代替 crontab -l/-（门禁用，避免动系统 crontab）
#   PRISM_ROUTER_AP_IW       iw 可执行文件（门禁注入假 iw）
#   PRISM_ROUTER_AP_IWINFO   iwinfo 可执行文件
#   PRISM_ROUTER_AP_UBUS     ubus 可执行文件
#
# 依赖：busybox（sha256sum / printf / awk / sed）、curl 或 wget、iw（或 iwinfo+ubus）。
# 不依赖 openssl、jq、python。仅在可信局域网使用，别把母节点 web 端口暴露到 WAN。

set -u

PROG=ap-agent
CONF="${PRISM_ROUTER_AP_CONF:-/etc/prism-router-ap/agent.conf}"
LOG="${PRISM_ROUTER_AP_LOG:-/tmp/prism-router-ap-agent.log}"
LOCK="${PRISM_ROUTER_AP_LOCK:-/tmp/prism-router-ap-agent.lock}"
CRON_FILE="${PRISM_ROUTER_AP_CRONTAB:-}"
IW_BIN="${PRISM_ROUTER_AP_IW:-}"
IWINFO_BIN="${PRISM_ROUTER_AP_IWINFO:-}"
UBUS_BIN="${PRISM_ROUTER_AP_UBUS:-}"
LOG_MAX=262144          # 256 KB 轮转
LOG_GAP=300             # 同类失败日志节流（秒）
MAX_STATIONS=128        # 单轮上报上限（与母节点一致）
DEFAULT_INTERVAL=60
DEFAULT_TIMEOUT=15

URL=''
TOKEN=''
NODE_ID=''
NAME=''
IFACES=''
INTERVAL="$DEFAULT_INTERVAL"
TIMEOUT="$DEFAULT_TIMEOUT"
INSECURE=0
CAFILE=''
DO_INSTALL=0
MODE='once'
QUIET=0
HTTP_CODE=''
LAST_STATIONS=0
LAST_LOG_KEY=''
LAST_LOG_TS=0
TAB=$(printf '\t')

# ───────────────────────────── 日志 ─────────────────────────────

log_rotate() {
	[ -f "$LOG" ] || return 0
	_sz=$(wc -c < "$LOG" 2>/dev/null) || return 0
	[ -n "$_sz" ] || return 0
	[ "$_sz" -le "$LOG_MAX" ] && return 0
	_tail=$((LOG_MAX / 2))
	tail -c "$_tail" "$LOG" > "${LOG}.new" 2>/dev/null && mv "${LOG}.new" "$LOG"
	chmod 600 "$LOG" 2>/dev/null
	return 0
}

log() { # $1=level $2=message（绝不打印 token；调用方只传安全字段）
	[ -d "$(dirname "$LOG")" ] || mkdir -p "$(dirname "$LOG")" 2>/dev/null
	printf '%s %s %s: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$1" "$2" >> "$LOG" 2>/dev/null
	chmod 600 "$LOG" 2>/dev/null
	[ "$QUIET" = 1 ] || printf '%s\n' "$2"
	return 0
}

# 同类失败 5 分钟最多一条（cron 每分钟跑一次，别把日志刷满）
log_throttled() { # $1=level $2=key $3=message
	_now=$(date +%s)
	_now=${_now:-0}
	if [ "$2" = "$LAST_LOG_KEY" ] && [ $((_now - LAST_LOG_TS)) -lt "$LOG_GAP" ]; then
		return 0
	fi
	LAST_LOG_KEY="$2"
	LAST_LOG_TS="$_now"
	log "$1" "$3"
}

# ───────────────────────────── 小工具 ─────────────────────────────

trim() {
	printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

is_int() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
	esac
	return 0
}

# 只留 [A-Za-z0-9._-]，连续非法字符压成一个 '-'，去掉首尾 ._-
sanitize_id() {
	_out=''
	_prev=''
	_rest="$1"
	while [ -n "$_rest" ]; do
		_c=${_rest%"${_rest#?}"}
		_rest=${_rest#?}
		case "$_c" in
			[A-Za-z0-9._-]) _out="$_out$_c"; _prev='' ;;
			*)
				[ "$_prev" = '-' ] && continue
				_out="${_out}-"
				_prev='-'
				;;
		esac
	done
	_out=$(printf '%s' "$_out" | sed 's/^[._-]*//; s/[._-]*$//')
	[ -n "$_out" ] || _out='ap'
	case "$_out" in
		[A-Za-z0-9]*) ;;
		*) _out="ap-$_out" ;;
	esac
	printf '%s' "$_out" | cut -c1-48
}

hostname_sanitized() {
	_h=''
	[ -r /proc/sys/kernel/hostname ] && _h=$(cat /proc/sys/kernel/hostname 2>/dev/null)
	[ -n "$(trim "$_h")" ] || _h=$(hostname 2>/dev/null)
	[ -n "$(trim "$_h")" ] || _h='OpenWrt'
	sanitize_id "$(trim "$_h")"
}

tmpfile() {
	_tf=$(mktemp "${TMPDIR:-/tmp}/prism-ap.XXXXXX" 2>/dev/null) || _tf=''
	if [ -z "$_tf" ]; then
		_tf="${TMPDIR:-/tmp}/prism-ap.$$.$1"
		: > "$_tf" 2>/dev/null || return 1
	fi
	printf '%s' "$_tf"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ───────────────────────────── 参数 ─────────────────────────────

usage() {
	sed -n '2,95p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
	log 'ERROR' "$1"
	exit 1
}

need_arg() { # $1=opt $2=val
	[ -n "$2" ] || die "参数 $1 需要一个值"
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--url) need_arg --url "${2:-}"; URL="$2"; shift 2 ;;
			--url=*) URL="${1#--url=}"; shift ;;
			--token) need_arg --token "${2:-}"; TOKEN="$2"; shift 2 ;;
			--token=*) TOKEN="${1#--token=}"; shift ;;
			--token-file)
				need_arg --token-file "${2:-}"
				[ -r "$2" ] || die "读不到 token 文件：$2"
				TOKEN=$(head -n 1 "$2" 2>/dev/null | tr -d '\r\n')
				shift 2
				;;
			--node-id) need_arg --node-id "${2:-}"; NODE_ID="$2"; shift 2 ;;
			--node-id=*) NODE_ID="${1#--node-id=}"; shift ;;
			--name) need_arg --name "${2:-}"; NAME="$2"; shift 2 ;;
			--iface) need_arg --iface "${2:-}"; IFACES="$2"; shift 2 ;;
			--iface=*) IFACES="${1#--iface=}"; shift ;;
			--interval) need_arg --interval "${2:-}"; INTERVAL="$2"; shift 2 ;;
			--interval=*) INTERVAL="${1#--interval=}"; shift ;;
			--timeout) need_arg --timeout "${2:-}"; TIMEOUT="$2"; shift 2 ;;
			--timeout=*) TIMEOUT="${1#--timeout=}"; shift ;;
			--conf) need_arg --conf "${2:-}"; CONF="$2"; shift 2 ;;
			--conf=*) CONF="${1#--conf=}"; shift ;;
			--cafile) need_arg --cafile "${2:-}"; CAFILE="$2"; shift 2 ;;
			--cafile=*) CAFILE="${1#--cafile=}"; shift ;;
			--insecure) INSECURE=1; shift ;;
			--install) DO_INSTALL=1; shift ;;
			--loop) MODE='loop'; shift ;;
			--once) MODE='once'; shift ;;
			--quiet) QUIET=1; shift ;;
			--hmac)
				need_arg --hmac "${2:-}"
				[ $# -ge 3 ] || die '参数 --hmac 需要 KEY 和 MSG'
				hmac_sha256 "$2" "$3"
				exit $?
				;;
			--selftest) selftest; exit $? ;;
			-h|--help) usage; exit 0 ;;
			*) die "未知参数：$1（--help 查看用法）" ;;
		esac
	done
}

# 配置文件格式：每行 key=value（不 source，避免坏文件注入命令）
load_conf() {
	[ -f "$CONF" ] || return 0
	while IFS= read -r _line || [ -n "$_line" ]; do
		case "$_line" in ''|'#'*) continue ;; esac
		_key=${_line%%=*}
		_val=${_line#*=}
		case "$_key" in
			url) [ -n "$URL" ] || URL="$_val" ;;
			token) [ -n "$TOKEN" ] || TOKEN="$_val" ;;
			node_id) [ -n "$NODE_ID" ] || NODE_ID="$_val" ;;
			name) [ -n "$NAME" ] || NAME="$_val" ;;
			iface) [ -n "$IFACES" ] || IFACES="$_val" ;;
			interval) [ "$INTERVAL" = "$DEFAULT_INTERVAL" ] && INTERVAL="$_val" ;;
			insecure) [ "$INSECURE" = 1 ] || INSECURE="$_val" ;;
			cafile) [ -n "$CAFILE" ] || CAFILE="$_val" ;;
		esac
	done < "$CONF"
	return 0
}

write_conf() {
	_dir=$(dirname "$CONF")
	mkdir -p "$_dir" 2>/dev/null || die "无法创建目录：$_dir"
	chmod 700 "$_dir" 2>/dev/null
	(
		umask 077
		: > "$CONF" || exit 1
		{
			printf '# prism-router AP agent（%s 生成；0600；不要提交到任何仓库）\n' "$(date '+%Y-%m-%d %H:%M:%S')"
			printf 'url=%s\n' "$URL"
			printf 'token=%s\n' "$TOKEN"
			printf 'node_id=%s\n' "$NODE_ID"
			printf 'name=%s\n' "$NAME"
			printf 'interval=%s\n' "$INTERVAL"
			if [ "$INSECURE" = 1 ]; then printf 'insecure=1\n'; fi
			if [ -n "$CAFILE" ]; then printf 'cafile=%s\n' "$CAFILE"; fi
			if [ -n "$IFACES" ]; then printf 'iface=%s\n' "$IFACES"; fi
			true
		} >> "$CONF"
	) || die "写入配置失败：$CONF"
	chmod 600 "$CONF" 2>/dev/null
	return 0
}

# ───────────────────────────── HMAC-SHA256（纯 shell）─────────────────────────────

# 单字符 -> 十进制字节值（token 只允许 [0-9a-f]，不会碰到引号类字符）
_ord() {
	printf '%d' "'$1" 2>/dev/null || printf '0'
}

# 64 字节 pad 的八进制转义串：key[i] XOR pad，不足补 0。
# 返回可打印转义串，由 printf '%b' 流式展开成二进制（NUL 不进变量）。
_pad_esc() {
	_key="$1"
	_pad="$2"
	_out=''
	_i=0
	while [ -n "$_key" ] && [ "$_i" -lt 64 ]; do
		_c=${_key%"${_key#?}"}
		_key=${_key#?}
		_b=$(( $(_ord "$_c") ^ _pad ))
		_out="$_out$(printf '\\0%03o' "$_b")"
		_i=$((_i + 1))
	done
	while [ "$_i" -lt 64 ]; do
		_out="$_out$(printf '\\0%03o' "$_pad")"
		_i=$((_i + 1))
	done
	printf '%s' "$_out"
}

_hex_to_esc() {
	_h="$1"
	_out=''
	while [ -n "$_h" ]; do
		_pair=${_h%"${_h#??}"}
		_h=${_h#??}
		_out="$_out$(printf '\\0%03o' $((0x$_pair)))"
	done
	printf '%s' "$_out"
}

# HMAC-SHA256：$1=key（ASCII 文本） $2=message，输出 64 位十六进制
hmac_sha256() {
	_ipad=$(_pad_esc "$1" 54)
	_opad=$(_pad_esc "$1" 92)
	_inner=$( { printf '%b' "$_ipad"; printf '%s' "$2"; } | sha256sum 2>/dev/null | sed 's/ .*//' )
	[ -n "$_inner" ] || return 1
	{ printf '%b' "$_opad"; printf '%b' "$(_hex_to_esc "$_inner")"; } | sha256sum 2>/dev/null | sed 's/ .*//'
}

sha256_hex() { # $1=数据（文本）
	printf '%s' "$1" | sha256sum 2>/dev/null | sed 's/ .*//'
}

_sha256_file() { # $1=文件（不存在 / 空 → sha256("")）
	if [ -n "$1" ] && [ -f "$1" ]; then
		sha256sum < "$1" 2>/dev/null | sed 's/ .*//'
	else
		sha256_hex ''
	fi
}

selftest() {
	_fail=0
	_got=$(hmac_sha256 'secret123' 'msg')
	[ "$_got" = 'c2a4bbd772a1ab04068be0ffc816d76afa05dccfff1ab6a2ec7e308d2f4f7e7f' ] \
		|| { printf 'selftest: HMAC 向量 1 失败：%s\n' "$_got"; _fail=1; }
	_got=$(hmac_sha256 '0123456789abcdef0123456789abcdef' '')
	[ "$_got" = '796cd3078af14636753d26b3b5555422ff55a3e261cf847b48e95371b9bd0aa2' ] \
		|| { printf 'selftest: HMAC 向量 2 失败：%s\n' "$_got"; _fail=1; }
	_got=$(sha256_hex '')
	[ "$_got" = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' ] \
		|| { printf 'selftest: sha256("") 失败：%s\n' "$_got"; _fail=1; }
	_got=$(sanitize_id '客厅 AP 01')
	[ "$_got" = 'AP-01' ] || { printf 'selftest: sanitize_id 失败：%s\n' "$_got"; _fail=1; }
	[ "$_fail" = 0 ] && printf 'selftest OK\n'
	return "$_fail"
}

# ───────────────────────────── URL / 鉴权 ─────────────────────────────

# --url 允许 http(s)://host[:port][/cgi-bin/prism-router-ingest]；输出完整 ingest URL
normalize_url() {
	_u=$(trim "$1")
	[ -n "$_u" ] || return 1
	case "$_u" in
		*[[:space:]]*|*'@'*|*'#'*) return 1 ;;
	esac
	case "$_u" in
		http://*|https://*) ;;
		*) return 1 ;;
	esac
	_u=$(printf '%s' "$_u" | sed 's:/*$::')
	case "$_u" in
		*/cgi-bin/prism-router-ingest) ;;
		*/cgi-bin) _u="$_u/prism-router-ingest" ;;
		*) _u="$_u/cgi-bin/prism-router-ingest" ;;
	esac
	printf '%s' "$_u"
}

# 绑定令牌固定 32 位小写 hex（母节点生成）
valid_token() {
	case "$1" in
		''|*[!0-9a-f]*) return 1 ;;
	esac
	[ ${#1} -eq 32 ]
}

# 由 action/ts/body 文件生成 Authorization；$3 为空串表示无 body
auth_header() {
	_digest=$(_sha256_file "$3")
	_msg=$(printf 'PRISM-AP1\n%s\n%s\n%s\n%s' "$1" "$NODE_ID" "$2" "$_digest")
	_sign=$(hmac_sha256 "$TOKEN" "$_msg") || return 1
	[ -n "$_sign" ] || return 1
	printf 'PrismAP token=%s;ts=%s;sign=%s' "$TOKEN" "$2" "$_sign"
}

# ───────────────────────────── HTTP ─────────────────────────────

# 返回 0 表示传输层成功；HTTP 状态码写进全局 HTTP_CODE（curl 才有）
http_request() { # $1=method $2=url $3=auth $4=body-file $5=out-file
	_method="$1"
	_url="$2"
	_auth="$3"
	_body="$4"
	_out="$5"
	HTTP_CODE=''

	if have curl; then
		_curl="curl -sS -m $TIMEOUT -o $_out -w %{http_code} -L --max-redirs 3"
		if [ "$INSECURE" = 1 ]; then _curl="$_curl -k"; fi
		if [ -n "$CAFILE" ]; then _curl="$_curl --cacert $_CAFILE"; fi
		if [ "$_method" = 'POST' ]; then
			# shellcheck disable=SC2086
			HTTP_CODE=$($_curl -X POST \
				-H "Authorization: $_auth" \
				-H "X-Prism-Token: $TOKEN" \
				-H 'Content-Type: application/json' \
				-H 'User-Agent: prism-router-ap-agent/1' \
				--data-binary "@$_body" "$_url" 2>/dev/null)
		else
			# shellcheck disable=SC2086
			HTTP_CODE=$($_curl -X GET \
				-H "Authorization: $_auth" \
				-H "X-Prism-Token: $TOKEN" \
				-H 'User-Agent: prism-router-ap-agent/1' \
				"$_url" 2>/dev/null)
		fi
		case "$HTTP_CODE" in
			''|000|*[!0-9]*) return 1 ;;
		esac
		return 0
	fi

	if have wget; then
		# busybox wget：拿不到状态码，只能按退出码 + 响应体判断
		_wget="wget -q -O $_out -T $TIMEOUT"
		if [ "$INSECURE" = 1 ]; then _wget="$_wget --no-check-certificate"; fi
		if [ -n "$CAFILE" ]; then _wget="$_wget --ca-certificate=$CAFILE"; fi
		if [ "$_method" = 'POST' ]; then
			# shellcheck disable=SC2086
			$_wget --header="Authorization: $_auth" \
				--header="X-Prism-Token: $TOKEN" \
				--header='Content-Type: application/json' \
				--post-file="$_body" "$_url" >/dev/null 2>&1 || return 1
		else
			# shellcheck disable=SC2086
			$_wget --header="Authorization: $_auth" \
				--header="X-Prism-Token: $TOKEN" "$_url" >/dev/null 2>&1 || return 1
		fi
		HTTP_CODE='200'
		return 0
	fi

	return 1
}

json_msg() {
	sed -n 's/.*"msg"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1 | cut -c1-160
}

json_ok() {
	grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$1" 2>/dev/null
}

# ───────────────────────────── 采集 ─────────────────────────────

# `iw dev` -> AP 接口名（type 必须正好是 AP；AP/VLAN 是桥不是 BSS）
iw_ifaces() {
	_iw="$IW_BIN"
	[ -n "$_iw" ] || _iw=$(command -v iw 2>/dev/null)
	[ -n "$_iw" ] || return 1
	"$_iw" dev 2>/dev/null | awk '
		/^[ \t]*Interface[ \t]+/ {
			if (name != "" && kind == "ap") print name
			name = $2; kind = ""; next
		}
		/^[ \t]*type[ \t]+/ { kind = tolower($2); next }
		END { if (name != "" && kind == "ap") print name }
	'
}

# iwinfo（ubus）兜底枚举：输出第一列就是接口名
iwinfo_ifaces() {
	_ubus="$UBUS_BIN"
	[ -n "$_ubus" ] || _ubus=$(command -v ubus 2>/dev/null)
	_iwinfo="$IWINFO_BIN"
	[ -n "$_iwinfo" ] || _iwinfo=$(command -v iwinfo 2>/dev/null)
	[ -n "$_ubus" ] && [ -n "$_iwinfo" ] || return 1
	"$_iwinfo" 2>/dev/null | awk '$1 ~ /^(phy|wl|wlan|ra|mt)[A-Za-z0-9._-]*/ { print $1 }' | sort -u
}

# `iw dev <if> station dump` -> mac<TAB>signal<TAB>rx_rate<TAB>tx_rate<TAB>connected_sec
# 缺失字段输出 '-'（母节点当作"没报"）
parse_station_dump() { # $1=dump-file
	awk '
		function flush() {
			if (mac == "") return
			printf "%s\t%s\t%s\t%s\t%s\n", mac, sig, rx, tx, ct
		}
		/^Station[ \t]+/ {
			flush()
			mac = $2; sig = "-"; rx = "-"; tx = "-"; ct = "-"
			next
		}
		/^[ \t]*signal:/ {
			# "signal: -53 [-57, -55] dBm"；"signal avg:" 的 $2 不是整数，会被忽略
			if ($2 ~ /^-?[0-9]+$/) sig = $2
			next
		}
		/^[ \t]*rx bitrate:/ {
			if ($3 ~ /^[0-9]+(\.[0-9]+)?$/) rx = sprintf("%.0f", $3 * 1000)
			next
		}
		/^[ \t]*tx bitrate:/ {
			if ($3 ~ /^[0-9]+(\.[0-9]+)?$/) tx = sprintf("%.0f", $3 * 1000)
			next
		}
		/^[ \t]*connected time:/ {
			if ($3 ~ /^[0-9]+$/) ct = $3
			next
		}
		END { flush() }
	' "$1"
}

# ubus call iwinfo assoclist 兜底：只取 mac/signal/rx.rate/tx.rate（没有 connected_sec）
parse_iwinfo_json() { # $1=json-file
	tr -d '\r\n\t' < "$1" 2>/dev/null | awk '
		{
			n = split($0, part, "\"mac\"")
			for (i = 2; i <= n; i++) {
				s = part[i]
				mac = ""
				if (match(s, /"[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}"/))
					mac = tolower(substr(s, RSTART + 1, RLENGTH - 2))
				if (mac == "") continue
				sig = "-"; rx = "-"; tx = "-"
				t = s
				if (sub(/.*"signal"[ ]*:[ ]*/, "", t)) { sub(/[,}].*/, "", t); if (t ~ /^-?[0-9]+$/) sig = t }
				t = s
				if (sub(/.*"rx"[ ]*:[ ]*\{[ ]*"rate"[ ]*:[ ]*/, "", t)) { sub(/[,}].*/, "", t); if (t ~ /^[0-9]+$/) rx = t }
				t = s
				if (sub(/.*"tx"[ ]*:[ ]*\{[ ]*"rate"[ ]*:[ ]*/, "", t)) { sub(/[,}].*/, "", t); if (t ~ /^[0-9]+$/) tx = t }
				printf "%s\t%s\t%s\t%s\t-\n", mac, sig, rx, tx
			}
		}
	'
}

# 每接口采集并合并：mac<TAB>iface<TAB>signal<TAB>rx<TAB>tx<TAB>ct
collect_all() { # $1=输出 TSV
	_out="$1"
	: > "$_out"
	_ifaces=''
	if [ -n "$IFACES" ]; then
		_ifaces=$(printf '%s' "$IFACES" | tr ',' ' ')
	else
		_ifaces=$(iw_ifaces)
		[ -n "$_ifaces" ] || _ifaces=$(iwinfo_ifaces)
	fi
	[ -n "$(printf '%s' "$_ifaces" | tr -d ' \n')" ] || return 1

	_scanned=0
	for _if in $_ifaces; do
		case "$_if" in
			''|*[!A-Za-z0-9._-]*) continue ;;
		esac
		_iw="$IW_BIN"
		[ -n "$_iw" ] || _iw=$(command -v iw 2>/dev/null)
		_f=$(tmpfile dump)
		[ -n "$_f" ] || continue
		if [ -n "$_iw" ] && "$_iw" dev "$_if" station dump > "$_f" 2>/dev/null; then
			parse_station_dump "$_f" \
				| awk -F'\t' -v ifc="$_if" '{ print $1"\t"ifc"\t"$2"\t"$3"\t"$4"\t"$5 }' >> "$_out"
			_scanned=$((_scanned + 1))
		else
			_ubus="$UBUS_BIN"
			[ -n "$_ubus" ] || _ubus=$(command -v ubus 2>/dev/null)
			if [ -n "$_ubus" ] && "$_ubus" call iwinfo assoclist "{\"device\":\"$_if\"}" > "$_f" 2>/dev/null; then
				parse_iwinfo_json "$_f" \
					| awk -F'\t' -v ifc="$_if" '{ print $1"\t"ifc"\t"$2"\t"$3"\t"$4"\t"$5 }' >> "$_out"
				_scanned=$((_scanned + 1))
			else
				log_throttled 'WARN' "iface-$_if" "接口 $_if 采集失败（iw/iwinfo 都不可用），跳过"
			fi
		fi
		rm -f "$_f" 2>/dev/null
	done

	if [ -s "$_out" ]; then
		awk -F'\t' '!seen[$1]++ { print }' "$_out" | head -n "$MAX_STATIONS" > "${_out}.u"
		mv "${_out}.u" "$_out"
	fi
	[ "$_scanned" -gt 0 ]
}

count_rows() {
	[ -s "$1" ] || { printf '0'; return 0; }
	wc -l < "$1" | tr -d ' '
}

# 采集结果 -> 上报 JSON（字段白名单，绝不带出任何字节统计）
build_report_body() { # $1=tsv $2=输出文件
	_now=$(date +%s)
	{
		printf '{"v":1,"node_id":"%s","name":"%s","ts":%s,"stations":' "$NODE_ID" "$NAME" "$_now"
		awk -F'\t' '
			BEGIN { printf "[" }
			NF >= 2 && $1 != "" {
				if (n++) printf ","
				printf "{\"mac\":\"%s\",\"iface\":\"%s\"", $1, $2
				if ($3 != "" && $3 != "-") printf ",\"signal\":%s", $3
				if ($4 != "" && $4 != "-") printf ",\"rx_rate\":%s", $4
				if ($5 != "" && $5 != "-") printf ",\"tx_rate\":%s", $5
				if ($6 != "" && $6 != "-") printf ",\"connected_sec\":%s", $6
				printf "}"
			}
			END { printf "]" }
		' "$1"
		printf '}\n'
	} > "$2"
}

# ───────────────────────────── 上报 / 轮询 / 回执 ─────────────────────────────

report_once() {
	_tsv=$(tmpfile tsv) || die '无法创建临时文件'
	if ! collect_all "$_tsv"; then
		rm -f "$_tsv" 2>/dev/null
		return 1
	fi

	_body=$(tmpfile body) || die '无法创建临时文件'
	build_report_body "$_tsv" "$_body"
	_n=$(count_rows "$_tsv")
	rm -f "$_tsv" 2>/dev/null

	_auth=$(auth_header 'ap_report' "$(date +%s)" "$_body") || { rm -f "$_body"; log 'ERROR' 'HMAC 计算失败'; return 2; }
	_out=$(tmpfile out) || die '无法创建临时文件'

	if ! http_request POST "${URL}?action=ap_report" "$_auth" "$_body" "$_out"; then
		rm -f "$_body" "$_out" 2>/dev/null
		log_throttled 'WARN' 'report-net' '上报失败：无法连接母节点'
		return 2
	fi

	if [ "$HTTP_CODE" = '200' ] && json_ok "$_out"; then
		_bound=$(sed -n 's/.*"bound"[[:space:]]*:[[:space:]]*true.*/1/p' "$_out" | head -n 1)
		if [ "$_bound" = '1' ]; then
			log 'INFO' "绑定成功（node_id=$NODE_ID），已上报 $_n 个站点"
		else
			log 'INFO' "已上报 $_n 个站点（node_id=$NODE_ID）"
		fi
		rm -f "$_body" "$_out" 2>/dev/null
		LAST_STATIONS="$_n"
		return 0
	fi

	_msg=$(json_msg "$_out")
	rm -f "$_body" "$_out" 2>/dev/null
	if [ "$HTTP_CODE" = '401' ]; then
		log_throttled 'ERROR' 'report-auth' "上报被拒绝（HTTP 401 / ${_msg:-鉴权失败}）：检查 token 是否已过期或被删除"
	elif [ "$HTTP_CODE" = '429' ]; then
		log_throttled 'WARN' 'report-rate' '上报被限速（HTTP 429），下轮再试'
	else
		log_throttled 'WARN' 'report-http' "上报失败（HTTP ${HTTP_CODE:-?} / ${_msg:-无消息}）"
	fi
	return 2
}

# 轮询待执行命令；每行 "id<TAB>cmd" 写到 $1
# 注意：POSIX sh 没有局部变量，函数之间共享全局名字。这里刻意不用
# _out/_body/_auth/_url/_method（http_request 会覆盖它们），否则会把命令写到
# 响应文件里而不是命令文件里（已踩过一次）。
poll_commands() {
	_cmdfile="$1"
	: > "$_cmdfile"
	_pauth=$(auth_header 'ap_poll' "$(date +%s)" '') || return 2
	_presp=$(tmpfile poll) || return 2

	if ! http_request GET "${URL}?action=ap_poll&node_id=${NODE_ID}" "$_pauth" '' "$_presp"; then
		rm -f "$_presp" 2>/dev/null
		log_throttled 'WARN' 'poll-net' '轮询命令失败：无法连接母节点'
		return 2
	fi

	if [ "$HTTP_CODE" != '200' ] || ! json_ok "$_presp"; then
		_pmsg=$(json_msg "$_presp")
		rm -f "$_presp" 2>/dev/null
		log_throttled 'WARN' 'poll-http' "轮询失败（HTTP ${HTTP_CODE:-?} / ${_pmsg:-无消息}）"
		return 2
	fi

	# 母节点把每条命令单独打一行：{"id":"...","cmd":"refresh"}
	while IFS= read -r _pline; do
		_pcmd=$(printf '%s' "$_pline" | sed -n 's/.*"cmd"[ ]*:[ ]*"\([a-z]*\)".*/\1/p')
		case "$_pcmd" in refresh|reboot) ;; *) continue ;; esac
		_pid=$(printf '%s' "$_pline" | sed -n 's/.*"id"[ ]*:[ ]*"\([A-Za-z0-9._:-]*\)".*/\1/p')
		[ -n "$_pid" ] || _pid="cmd-$(date +%s)"
		printf '%s\t%s\n' "$_pid" "$_pcmd" >> "$_cmdfile"
	done < "$_presp"

	rm -f "$_presp" 2>/dev/null
	return 0
}

send_result() { # $1=results 数组 JSON 文本文件
	_body=$(tmpfile res) || return 2
	_now=$(date +%s)
	{
		printf '{"v":1,"node_id":"%s","ts":%s,"results":' "$NODE_ID" "$_now"
		cat "$1"
		printf '}\n'
	} > "$_body"

	_auth=$(auth_header 'ap_result' "$_now" "$_body") || { rm -f "$_body"; return 2; }
	_out=$(tmpfile out2) || { rm -f "$_body"; return 2; }

	if ! http_request POST "${URL}?action=ap_result" "$_auth" "$_body" "$_out"; then
		rm -f "$_body" "$_out" 2>/dev/null
		log_throttled 'WARN' 'result-net' '命令回执发送失败：无法连接母节点'
		return 2
	fi
	if [ "$HTTP_CODE" != '200' ] || ! json_ok "$_out"; then
		_msg=$(json_msg "$_out")
		rm -f "$_body" "$_out" 2>/dev/null
		log_throttled 'WARN' 'result-http' "命令回执失败（HTTP ${HTTP_CODE:-?} / ${_msg:-无消息}）"
		return 2
	fi
	rm -f "$_body" "$_out" 2>/dev/null
	return 0
}

# 执行白名单命令；结果 JSON 数组写到 $2。reboot 先回执再重启。
exec_commands() { # $1=cmd 文件 $2=results 文件
	_list="$1"
	_results="$2"
	_first=1
	printf '[' > "$_results"

	while IFS="$TAB" read -r _cid _cmd; do
		[ -n "$_cmd" ] || continue
		_ok='false'
		_rc=1
		_detail=''
		case "$_cmd" in
			refresh)
				log 'INFO' "执行命令 refresh（$_cid）"
				if report_once; then
					_ok='true'; _rc=0; _detail="refreshed ${LAST_STATIONS:-0} stations"
				else
					_detail='refresh failed'
				fi
				;;
			reboot)
				log 'INFO' "执行命令 reboot（$_cid）：先回执再重启，执行记录已写日志"
				_ok='true'; _rc=0; _detail='reboot scheduled'
				;;
			*)
				_detail='unsupported command'
				;;
		esac

		[ "$_first" = 1 ] || printf ',' >> "$_results"
		_first=0
		printf '{"id":"%s","cmd":"%s","ok":%s,"code":%s,"detail":"%s"}' \
			"$_cid" "$_cmd" "$_ok" "$_rc" "$_detail" >> "$_results"

		# reboot 必须在回执成功之后再执行，否则母节点永远收不到结果
		if [ "$_cmd" = 'reboot' ]; then
			printf ']' >> "$_results"
			send_result "$_results" || log 'WARN' 'reboot 回执未送达，仍然执行重启'
			( sleep 2; reboot ) >/dev/null 2>&1 &
			return 0
		fi
	done < "$_list"

	printf ']' >> "$_results"
	if [ "$_first" = 0 ]; then
		send_result "$_results"
		return $?
	fi
	return 0
}

run_cycle() {
	report_once
	_rc=$?
	_cmds=$(tmpfile cmds) || return "$_rc"
	if poll_commands "$_cmds" && [ -s "$_cmds" ]; then
		_results=$(tmpfile results) || { rm -f "$_cmds"; return "$_rc"; }
		exec_commands "$_cmds" "$_results"
		rm -f "$_results" 2>/dev/null
	fi
	rm -f "$_cmds" 2>/dev/null
	return "$_rc"
}

# ───────────────────────────── 安装 ─────────────────────────────

cron_read() {
	if [ -n "$CRON_FILE" ]; then
		[ -f "$CRON_FILE" ] && cat "$CRON_FILE" 2>/dev/null
		return 0
	fi
	crontab -l 2>/dev/null
}

cron_write() { # 从 stdin 读
	if [ -n "$CRON_FILE" ]; then
		cat > "$CRON_FILE"
		chmod 600 "$CRON_FILE" 2>/dev/null
		return $?
	fi
	crontab - 2>/dev/null
}

install_cron() {
	_self="$0"
	case "$_self" in
		/*) ;;
		*) _self=$(command -v "$_self" 2>/dev/null || true) ;;
	esac
	case "$_self" in
		/*) ;;
		*) _self='/usr/share/prism-router/ap-agent.sh' ;;
	esac
	_line="* * * * * $_self >/dev/null 2>&1"

	if { cron_read | grep -v 'ap-agent\.sh' | grep -v '^[[:space:]]*$' || true; printf '%s\n' "$_line"; } | cron_write; then
		log 'INFO' "crontab 已安装：$_line"
	else
		log 'WARN' "写 crontab 失败：请手工添加 $_line"
	fi
}

do_install() {
	[ -n "$URL" ] || die '--install 需要 --url'
	valid_token "$TOKEN" || die '--install 需要合法的 --token（32 位小写十六进制）'
	write_conf
	install_cron
	log 'INFO' "配置已写入 $CONF（0600）"
	run_cycle
}

# ───────────────────────────── 锁 / 主流程 ─────────────────────────────

acquire_lock() {
	if mkdir "$LOCK" 2>/dev/null; then
		printf '%s\n' "$$" > "$LOCK/pid" 2>/dev/null
		return 0
	fi
	_pid=$(cat "$LOCK/pid" 2>/dev/null)
	if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
		return 1
	fi
	rm -rf "$LOCK" 2>/dev/null
	if mkdir "$LOCK" 2>/dev/null; then
		printf '%s\n' "$$" > "$LOCK/pid" 2>/dev/null
		return 0
	fi
	return 1
}

release_lock() {
	_pid=$(cat "$LOCK/pid" 2>/dev/null)
	[ "$_pid" = "$$" ] && rm -rf "$LOCK" 2>/dev/null
	return 0
}

main() {
	parse_args "$@"
	load_conf
	log_rotate

	[ -n "$URL" ] || die '缺少 --url（或配置文件里的 url=）'
	URL=$(normalize_url "$URL") || die "非法的 --url：$URL"
	valid_token "$TOKEN" || die '缺少或非法的 --token（必须是 32 位小写十六进制，由母节点「生成绑定命令」得到）'
	is_int "$INTERVAL" || die '--interval 必须是整数'
	[ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 86400 ] || die '--interval 必须在 1..86400'
	is_int "$TIMEOUT" || die '--timeout 必须是整数'
	[ "$TIMEOUT" -ge 1 ] && [ "$TIMEOUT" -le 300 ] || die '--timeout 必须在 1..300'

	[ -n "$NODE_ID" ] || NODE_ID=$(hostname_sanitized)
	NODE_ID=$(sanitize_id "$NODE_ID")
	[ -n "$NODE_ID" ] || die '无法确定 node_id'
	case "$NODE_ID" in
		[A-Za-z0-9]*) ;;
		*) die "非法的 node_id：$NODE_ID" ;;
	esac
	[ -n "$NAME" ] || NAME="$NODE_ID"
	NAME=$(printf '%s' "$NAME" | tr -d '\r\n\t' | cut -c1-64)
	[ -n "$NAME" ] || NAME="$NODE_ID"

	if [ "$DO_INSTALL" = 1 ]; then
		do_install
		exit 0
	fi

	acquire_lock || { log 'INFO' '上一轮还没结束（单实例锁），本轮跳过'; exit 0; }
	trap 'release_lock' EXIT
	trap 'release_lock; exit 130' INT
	trap 'release_lock; exit 143' TERM

	case "$MODE" in
		loop)
			log 'INFO' "常驻模式启动（interval=${INTERVAL}s, node_id=$NODE_ID）"
			while :; do
				run_cycle
				sleep "$INTERVAL"
			done
			;;
		*)
			run_cycle
			exit $?
			;;
	esac
}

main "$@"
