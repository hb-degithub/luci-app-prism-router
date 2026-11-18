#!/bin/sh
# 飞书「应用机器人 + 扫码绑定」用例（容器内执行；由 tests/container-validate-feishu-oauth.sh 调用）
#
# 覆盖：
#   1. 安装单包：CGI 落位 755、ucode 语法、默认配置（mode/app_id/app_secret/chat_id）与注释
#   2. 未配置 app_id -> start 400（JSON + no-store + 不含凭证）
#   3. 配置后 start -> 200 {state,url}：url 含 app_id/redirect_uri/state；状态文件 0600、目录 0700
#   4. app_secret 只在 0600 的 curl 配置/请求体文件里：curl argv 用 shim 抓取核对
#   5. mock 飞书：callback -> 200 HTML（无脚本/外链）→ status ready，chats 50 条、name 截断 64 字节
#   6. 错误路径：state 不存在/非法/过期 -> 404；缺 code -> 400；非法 code -> 502 + error 状态
#      且响应/状态文件都不含 app_secret / access_token
#   7. 并发上限 8 个 state（第 9 次后仍 <= 8）
#   8. 经 uhttpd 的真实 HTTP：GET 200/400、POST 405、JSON/HTML 头正确
#   9. app 模式发送：Bearer + receive_id_type=chat_id、token 缓存命中（internal 只请求一次）、
#      过期前 60 秒刷新、--chat 覆盖、缓存文件 0600
#  10. 失败处理：可重试错误「单次 + 一次重试」；不可重试只发一次；配了 webhook 则回退并记原因
#  11. webhook 模式完全不受影响（不请求 token / 不发 API）；mode 缺省时沿用旧的三件套判定
#
# 隔离：--network none，只有 127.0.0.1；mock 飞书 API 是本机 uhttpd + ucode CGI；
#      不访问外网、不接触任何真机、不连真实飞书。
mkdir -p /var/run/ubus /var/lock /tmp /www/cgi-bin /tmp/mock/cgi-bin /tmp/mockwww/cgi-bin /tmp/shim

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  PASS  $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
eq(){ # $1=期望 $2=实际 $3=描述
  if [ "$1" = "$2" ]; then ok "$3（$2）"; else bad "$3：期望[$1] 实际[$2]"; fi
}
neq(){ if [ "$1" != "$2" ]; then ok "$3"; else bad "$3：不应等于[$1]"; fi; }
rc_is(){ eq "$1" "$2" "$3"; }
has(){ if grep -q -- "$1" "$2" 2>/dev/null; then ok "$3"; else bad "$3（找不到 $1）"; fi; }
hasnt(){ if grep -q -- "$1" "$2" 2>/dev/null; then bad "$3（不该出现 $1）"; else ok "$3"; fi; }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1, $3":"$4}'; }
check(){ got=$(perm "$1"); [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
filemode(){ ls -l "$1" 2>/dev/null | awk '{print $1}'; }

FEISHU=/usr/share/prism-router/feishu.uc
CGI=/www/cgi-bin/prism-router-feishu
CFG=/etc/config/prism-router
MOCK_PORT=19091
MOCK_BASE="http://127.0.0.1:$MOCK_PORT"
MOCK=/tmp/mock
WORK=/tmp/fs-oauth
SECRET='SECRET-should-not-leak'
USER_TOKEN='u-mock-access-token'
TENANT_TOKEN='t-mock-tenant-token'
UCI(){ uci "$@" >/dev/null 2>&1; }
CGET(){ uci -q get "$1" 2>/dev/null; }

rm -rf "$WORK"; mkdir -p "$WORK"

# ───────────────────────── 0. 本地 mock 飞书 API ─────────────────────────
# 为什么用 uhttpd + ucode CGI：容器里没有 python/node，busybox nc 也没有 listen 模式；
# uhttpd 是插件依赖，CGI 又是 ucode —— 同一个工具链，零额外依赖。
cat > "$MOCK/_api.uc" <<'UCEOF'
#!/usr/bin/ucode
let fs = require("fs");
let DIR = "/tmp/mock";

function counter(name) {
	let p = DIR + "/" + name + "-count";
	let n = 0;
	try { n = int(trim(fs.readfile(p) ?? "0")); } catch (e) { n = 0; }
	if (n != n || n < 0) n = 0;
	n++;
	try { fs.writefile(p, sprintf("%d\n", n)); } catch (e) { }
	return n;
}

function note(name, line) {
	try {
		let fd = fs.open(DIR + "/" + name, "a", 420);
		if (fd) { fd.write(line + "\n"); fd.close(); }
	} catch (e) { }
}

function flag(name) {
	try { return fs.access(DIR + "/" + name); } catch (e) { return false; }
}

let method = trim(sprintf("%s", getenv("REQUEST_METHOD") ?? "GET"));
let uri = trim(sprintf("%s", getenv("REQUEST_URI") ?? ""));
let qs = trim(sprintf("%s", getenv("QUERY_STRING") ?? ""));
let auth = trim(sprintf("%s", getenv("HTTP_AUTHORIZATION") ?? getenv("AUTHORIZATION") ?? ""));
let len = int(sprintf("%s", getenv("CONTENT_LENGTH") ?? "0"));
if (len != len || len < 0) len = 0;
let body = "";
if (len > 0) {
	try { body = fs.stdin.read(len) ?? ""; } catch (e) { body = ""; }
}

let status = 200;
let out = {};

if (index(uri, "/authen/v1/oidc/access_token") >= 0) {
	note("oidc-requests.jsonl", sprintf("%s|%d|%s", method, len, body));
	if (flag("fail-oidc")) {
		status = 500;
		out = { code: 500, msg: "mock upstream down" };
	} else if (index(body, "good") >= 0) {
		out = { code: 0, data: { access_token: "u-mock-access-token", refresh_token: "r-mock", expires_in: 7200 }, msg: "ok" };
	} else {
		out = { code: 20003, msg: "Authorization code is invalid or expired" };
	}
} else if (index(uri, "/im/v1/chats") >= 0) {
	note("chats-requests.jsonl", sprintf("%s|%s", auth, qs));
	let items = [];
	for (let i = 1; i <= 60; i++) {
		let name = sprintf("测试群-%02d", i);
		if (i == 1) {
			name = "";
			for (let j = 0; j < 40; j++) name += "群";     /* 120 字节，验证 64 字节截断 */
		}
		if (i == 2) name = "";                              /* 空名 -> 回落到 chat_id */
		let id = sprintf("oc_chat_%02d", i);
		if (i == 3) id = "bad chat id";                     /* 非法 chat_id -> 跳过 */
		push(items, { chat_id: id, name: name, description: "mock", chat_mode: "group", owner_id: "ou_x" });
	}
	out = { code: 0, data: { items: items, has_more: false, page_token: "" }, msg: "ok" };
} else if (index(uri, "/auth/v3/tenant_access_token/internal") >= 0) {
	let n = counter("token");
	note("token-requests.jsonl", sprintf("%d|%s", n, body));
	if (flag("fail-token")) out = { code: 10014, msg: "app secret invalid" };
	else out = { code: 0, tenant_access_token: "t-mock-tenant-token", expire: 7200 };
} else if (index(uri, "/im/v1/messages") >= 0) {
	counter("msg");
	note("msg-requests.jsonl", sprintf("%s|%s|%s", auth, qs, body));
	if (flag("fail-messages")) out = { code: 230002, msg: "Bot/User can NOT be out of the chat." };
	else if (flag("fail-rate")) out = { code: 230020, msg: "rate limited" };
	else out = { code: 0, data: { message_id: "om_mock" } };
} else if (index(uri, "/bot/v2/hook/") >= 0) {
	counter("hook");
	note("hook-requests.jsonl", body);
	out = { code: 0, msg: "success" };
} else {
	status = 404;
	out = { code: 404, msg: "mock: unknown endpoint" };
}

if (status != 200) print(sprintf("Status: %d Error\r\n", status));
print("Content-Type: application/json; charset=utf-8\r\n\r\n");
print(sprintf("%J\n", out));
UCEOF

# 每条固定路径放一份 CGI（uhttpd 直接按「docroot + URL」找脚本，不做 PATH_INFO 拆分）
for p in open-apis/authen/v1/oidc/access_token \
         open-apis/im/v1/chats \
         open-apis/auth/v3/tenant_access_token/internal \
         open-apis/im/v1/messages \
         open-apis/bot/v2/hook/mockhook; do
  mkdir -p "$MOCK/$(dirname "$p")"
  cp "$MOCK/_api.uc" "$MOCK/$p"
  chmod 755 "$MOCK/$p"
done

# curl shim：记录 argv 与 -K 配置文件权限，再转给真正的 curl。
cat > /tmp/shim/curl <<'SHIM'
#!/bin/sh
prev=""
for a in "$@"; do
  if [ "$prev" = "-K" ]; then
    echo "KFILE $(ls -l "$a" 2>/dev/null | awk '{print $1}') $a" >> /tmp/curl-argv.log
  fi
  prev="$a"
done
echo "ARGV $*" >> /tmp/curl-argv.log
exec /usr/bin/curl "$@"
SHIM
chmod 755 /tmp/shim/curl

/usr/sbin/uhttpd -f -p 127.0.0.1:$MOCK_PORT -h "$MOCK" -x /open-apis >/tmp/mock-uhttpd.log 2>&1 &
wait_http(){ # $1=url
  i=0
  while [ "$i" -lt 60 ]; do
    c=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)
    case "$c" in 200|400|404|405|500|502) return 0 ;; esac
    i=$((i+1)); sleep 0.2
  done
  return 1
}
wait_http "$MOCK_BASE/open-apis/im/v1/chats" && ok "mock 飞书 API 已监听 $MOCK_BASE（127.0.0.1）" \
  || { bad "mock 飞书 API 未就绪"; cat /tmp/mock-uhttpd.log; }

echo "=== 0. 安装单包 ==="
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i.log 2>&1 \
  && ok "安装 luci-app-prism-router" || { bad "安装失败"; tail -8 /tmp/i.log; }

# rpcd 必须在装包之后再起，否则 ucode 插件不在启动时的加载列表里
echo "=== 0.5 起 ubusd / rpcd（真实 ubus 对象 prism-router）==="
/sbin/ubusd -s /var/run/ubus/ubus.sock >/tmp/ubusd.log 2>&1 &
sleep 1
/sbin/rpcd -s /var/run/ubus/ubus.sock >/tmp/rpcd.log 2>&1 &
sleep 1
ubus list 2>/dev/null | grep -qx prism-router && ok "rpcd 已注册 ubus 对象 prism-router" \
  || { bad "ubus 对象 prism-router 未注册"; cat /tmp/rpcd.log; }

echo "=== 1. 落位 / 语法 / 默认配置 ==="
[ -f "$CGI" ] || { bad "缺少 $CGI"; exit 1; }
check "$CGI" "-rwxr-xr-x root:root"
check /www/cgi-bin "drwxr-xr-x root:root"
check "$FEISHU" "-rw-r--r-- root:root"
check /etc/config/prism-router "-rw-r--r-- root:root"
ucode -c "$CGI" >/dev/null 2>&1 && ok "CGI 语法 OK" || bad "CGI 语法错误"
ucode -c "$FEISHU" >/dev/null 2>&1 && ok "feishu.uc 语法 OK" || bad "feishu.uc 语法错误"
for opt in mode app_id app_secret chat_id; do
  grep -q "option $opt " "$CFG" && ok "默认配置含 $opt" || bad "默认配置缺少 $opt"
done
eq "webhook" "$(CGET prism-router.feishu.mode)" "默认 mode=webhook（应用机器人默认关闭）"
[ -z "$(CGET prism-router.feishu.app_id)" ] && ok "默认 app_id 为空" || bad "默认预置了 app_id"
[ -z "$(CGET prism-router.feishu.app_secret)" ] && ok "默认 app_secret 为空" || bad "默认预置了 app_secret"
[ -z "$(CGET prism-router.feishu.chat_id)" ] && ok "默认 chat_id 为空" || bad "默认预置了 chat_id"
grep -q "cgi-bin/prism-router-feishu?action=callback" "$CFG" \
  && ok "配置注释里写明了重定向 URL 形状" || bad "配置注释缺少重定向 URL"
grep -q "im:message:send_as_bot" "$CFG" && grep -q "im:chat:readonly" "$CFG" \
  && ok "配置注释写明了需要的飞书权限" || bad "配置注释缺少权限说明"
ucode "$FEISHU" selftest >/tmp/fs-selftest.log 2>&1
rc_is 0 $? "feishu.uc selftest 退出 0"
SF=$(grep -c "FAIL" /tmp/fs-selftest.log)
[ "$SF" -eq 0 ] && ok "selftest 0 项失败（含发送路线判定）" || { bad "selftest 有 $SF 项失败"; grep FAIL /tmp/fs-selftest.log | head -5; }

# ───────────────────────── CGI 调用助手 ─────────────────────────
CGI_RAW=/tmp/cgi.raw; CGI_H=/tmp/cgi.h; CGI_B=/tmp/cgi.b
: > "$CGI_H"; : > "$CGI_B"
cgi(){ # $1=QUERY_STRING [$2=METHOD] [$3=HTTP_HOST]
  : > "$CGI_RAW"; : > "$CGI_H"; : > "$CGI_B"
  env PATH="/tmp/shim:$PATH" REQUEST_METHOD="${2:-GET}" HTTP_HOST="${3:-router.lan:8080}" \
      QUERY_STRING="$1" PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" \
      ucode "$CGI" > "$CGI_RAW" 2>/tmp/cgi.err
  CGI_RC=$?
  tr -d '\r' < "$CGI_RAW" > /tmp/cgi.clean
  awk 'BEGIN{h=1} h==1 && $0=="" {h=0; next} h==1 {print > "/tmp/cgi.h"} h==0 {print > "/tmp/cgi.b"}' /tmp/cgi.clean
  : > /tmp/ctl
  return 0
}
ccode(){ s=$(awk -F'[: ]+' '/^Status:/ {print $2; exit}' "$CGI_H"); [ -n "$s" ] && echo "$s" || echo 200; }
chdr(){ grep -i "^$1:" "$CGI_H" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//'; }
state_dir_files(){ ls /tmp/prism-router/feishu-oauth/*.json 2>/dev/null | wc -l | tr -d ' '; }
tenv_files(){ ls /tmp/prism-router/.feishu-oauth 2>/dev/null | wc -l | tr -d ' '; }
jget(){ # $1=路径 [$2=len]
  P="${1:-}" M="${2:-}" F="$CGI_B" ucode /tmp/jget.uc 2>/dev/null
}

cat > /tmp/jget.uc <<'JEOF'
let fs = require("fs");
let p = sprintf("%s", getenv("P") ?? "");
let mode = sprintf("%s", getenv("M") ?? "");
let raw = "";
try { raw = fs.readfile(getenv("F") ?? "/tmp/cgi.b") ?? ""; } catch (e) { raw = ""; }
let d = null;
try { d = json(raw); } catch (e) { d = null; }
let obj = d;
for (let seg in split(p, ".")) {
	if (obj == null) break;
	if (match(seg, /^[0-9]+$/)) {
		if (type(obj) == "array") obj = obj[int(seg)]; else obj = null;
	} else if (type(obj) == "object" || type(obj) == "array") {
		obj = obj[seg];
	} else {
		obj = null;
	}
}
if (mode == "len") obj = (obj == null ? 0 : length(obj));
print(obj == null ? "" : sprintf("%s", obj));
JEOF

echo
echo "=== 2. 未配置 app_id -> start 400 ==="
: > /tmp/curl-argv.log
cgi "action=start"
eq 400 "$(ccode)" "未配置 app_id：start HTTP 400"
eq "application/json; charset=utf-8" "$(chdr Content-Type)" "400 是 JSON（charset=utf-8）"
eq "no-store" "$(chdr Cache-Control)" "400 带 Cache-Control: no-store"
neq "" "$(jget error)" "400 返回 {error}"
hasnt "$SECRET" "$CGI_B" "400 响应不含 app_secret"
eq 0 "$(state_dir_files)" "未配置时没有生成 state 文件"

echo
echo "=== 3. 配置后 start -> 200 {state,url} ==="
UCI set prism-router.feishu.mode='app'
UCI set prism-router.feishu.app_id='cli_mockapp'
UCI set prism-router.feishu.app_secret="$SECRET"
UCI set prism-router.feishu.chat_id=''
UCI commit prism-router
cgi "action=start" GET "router.lan:8080"
eq 200 "$(ccode)" "配置齐全：start HTTP 200"
STATE=$(jget state)
case "$STATE" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ok "state 是 32 位小写 hex（$STATE）" ;;
  *) bad "state 形状不对：[$STATE]" ;;
esac
URL=$(jget url)
case "$URL" in
  */open-apis/authen/v1/index\?app_id=cli_mockapp*) ok "url 指向飞书授权页且带 app_id" ;;
  *) bad "url 形状不对：$URL" ;;
esac
case "$URL" in
  *"redirect_uri=http%3A%2F%2Frouter.lan%3A8080%2Fcgi-bin%2Fprism-router-feishu%3Faction%3Dcallback"*)
    ok "url 的 redirect_uri 已 urlencode（与开放平台填写的地址一致）" ;;
  *) bad "redirect_uri 未按预期编码：$URL" ;;
esac
case "$URL" in
  *"state=$STATE") ok "url 的 state 与返回一致" ;;
  *) bad "url 的 state 不一致：$URL" ;;
esac
hasnt "$SECRET" "$CGI_B" "start 响应不含 app_secret"
hasnt "$SECRET" "$URL" "url 里不含 app_secret"
eq "drwx------" "$(ls -ld /tmp/prism-router/feishu-oauth | awk '{print $1}')" "授权状态目录权限 0700"
SFILE="/tmp/prism-router/feishu-oauth/$STATE.json"
check "$SFILE" "-rw------- root:root"
has '"status": "pending"' "$SFILE" "state 文件初始为 pending"
grep -q "\"redirect\"" "$SFILE" && ok "state 文件记录了 redirect_uri（callback 用它换 token）" || bad "state 文件缺 redirect"

cgi "action=status&state=$STATE"
eq 200 "$(ccode)" "status(pending) HTTP 200"
eq "pending" "$(jget status)" "status=pending"
eq 0 "$(jget chats len)" "pending 时 chats 为空数组"

echo
echo "=== 4. app_secret 不进 argv（curl shim 抓取）==="
: > /tmp/curl-argv.log
cgi "action=callback&code=never-sent&state=$STATE"
eq 502 "$(ccode)" "callback 上游不可用（非法 code）-> 502"
[ -s /tmp/curl-argv.log ] && ok "shim 抓到了 curl 调用" || bad "shim 没抓到 curl 调用"
hasnt "$SECRET" /tmp/curl-argv.log "curl argv 不含 app_secret"
hasnt "Bearer" /tmp/curl-argv.log "curl argv 不含 Authorization/Bearer"
has "KFILE -rw-------" /tmp/curl-argv.log "curl -K 配置文件权限是 0600"
eq 0 "$(tenv_files)" "用过的临时文件已删除（.feishu-oauth 为空）"
hasnt "$SECRET" "$SFILE" "state 文件不落 app_secret"
hasnt "$SECRET" /tmp/cgi.b "错误响应不含 app_secret"
hasnt "$USER_TOKEN" /tmp/cgi.b "错误响应不含 token"

echo
echo "=== 5. callback 成功（mock 飞书）-> 200 HTML -> status ready ==="
cgi "action=start" GET "router.lan:8080"
STATE=$(jget state)
cgi "action=callback&code=good&state=$STATE"
eq 200 "$(ccode)" "callback 成功 HTTP 200"
eq "text/html; charset=utf-8" "$(chdr Content-Type)" "callback 成功返回 HTML"
eq "no-store" "$(chdr Cache-Control)" "HTML 也带 no-store"
has "授权成功，请回到棱镜路由设置页选择要绑定的群" "$CGI_B" "HTML 提示回到设置页选群"
hasnt "<script" "$CGI_B" "HTML 无脚本"
hasnt "src=" "$CGI_B" "HTML 无外部资源（src=）"
hasnt "href=" "$CGI_B" "HTML 无外部链接（href=）"
grep -q "Bearer $USER_TOKEN" /tmp/mock/chats-requests.jsonl 2>/dev/null \
  && ok "群列表请求带 Authorization: Bearer <user_access_token>" \
  || bad "群列表请求缺少 Bearer 头：$(head -1 /tmp/mock/chats-requests.jsonl 2>/dev/null)"
grep -q "page_size=50" /tmp/mock/chats-requests.jsonl 2>/dev/null \
  && ok "群列表请求 page_size=50" || bad "群列表请求缺少 page_size=50"
grep -q "user_id_type=open_id" /tmp/mock/chats-requests.jsonl 2>/dev/null \
  && ok "群列表请求 user_id_type=open_id" || bad "群列表请求缺少 user_id_type=open_id"
grep -q 'grant_type.*authorization_code' /tmp/mock/oidc-requests.jsonl 2>/dev/null \
  && ok "换 token 请求 grant_type=authorization_code" || bad "换 token 请求缺 grant_type"
grep -q 'client_id.*cli_mockapp' /tmp/mock/oidc-requests.jsonl 2>/dev/null \
  && ok "换 token 请求带 client_id（app_id）" || bad "换 token 请求缺 client_id"
grep -q "redirect_uri" /tmp/mock/oidc-requests.jsonl 2>/dev/null \
  && ok "换 token 请求带 redirect_uri（必须是开始时那个）" || bad "换 token 请求缺 redirect_uri"
grep -q "$SECRET" /tmp/mock/oidc-requests.jsonl 2>/dev/null \
  && ok "client_secret 在请求体里（不是 argv/URL）" || bad "请求体里没有 client_secret"
eq 0 "$(tenv_files)" "callback 结束后临时文件已清理"

cgi "action=status&state=$STATE"
eq 200 "$(ccode)" "status(ready) HTTP 200"
eq "ready" "$(jget status)" "status=ready"
eq 50 "$(jget chats len)" "chats 截断到 50 条（mock 返回 60）"
neq "" "$(jget chats.0.chat_id)" "chats[0] 有 chat_id"
LEN0=$(jget chats.0.name len)
[ "$LEN0" -le 64 ] && ok "chats[0].name 截断到 64 字节内（实际 $LEN0）" \
  || bad "chats[0].name 超长：$LEN0 字节"
[ "$LEN0" -gt 0 ] && ok "chats[0].name 非空" || bad "chats[0].name 为空"
eq "$(jget chats.1.chat_id)" "$(jget chats.1.name)" "空群名回落到 chat_id"
if grep -q "bad chat id" "$CGI_B" 2>/dev/null; then bad "非法 chat_id 被写进结果"; else ok "非法 chat_id 被跳过"; fi
hasnt "$USER_TOKEN" "$SFILE" "state 文件不落 user_access_token"
hasnt "$SECRET" "$SFILE" "state 文件不落 app_secret"
check "$SFILE" "-rw------- root:root"

# 浏览器刷新回调页：同一个（已被消费的）code 再回放，必须是成功页而不是 error
cgi "action=callback&code=good&state=$STATE"
eq 200 "$(ccode)" "重复 callback（浏览器刷新）仍是 200"
has "授权成功" "$CGI_B" "重复 callback 仍返回成功页"
cgi "action=status&state=$STATE"
eq "ready" "$(jget status)" "重复 callback 没有把状态改成 error"
eq 50 "$(jget chats len)" "重复 callback 保留 chats"

echo
echo "=== 6. 错误路径：state 不存在 / 非法 / 过期 / 缺 code ==="
cgi "action=status&state=00000000000000000000000000000000"
eq 404 "$(ccode)" "未知 state -> 404"
neq "" "$(jget error)" "404 返回 {error}"
cgi "action=callback&code=good&state=00000000000000000000000000000000"
eq 404 "$(ccode)" "未知 state 的 callback -> 404"
cgi "action=status&state=..%2F..%2Fetc%2Fpasswd"
eq 404 "$(ccode)" "路径穿越形状的 state -> 404（不读文件）"
cgi "action=status&action=bogus"
eq 400 "$(ccode)" "未知 action -> 400"
cgi "action=bogus"
eq 400 "$(ccode)" "未知 action（单值）-> 400"
# 过期 state：手工造一个 601 秒前的时间戳
EXP=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '{"ts":%d,"status":"pending"}\n' "$(( $(date +%s) - 601 ))" > "/tmp/prism-router/feishu-oauth/$EXP.json"
chmod 600 "/tmp/prism-router/feishu-oauth/$EXP.json"
cgi "action=status&state=$EXP"
eq 404 "$(ccode)" "过期 state 的 status -> 404"
[ -e "/tmp/prism-router/feishu-oauth/$EXP.json" ] && bad "过期 state 文件未清理" || ok "过期 state 已被清理"
printf '{"ts":%d,"status":"pending"}\n' "$(( $(date +%s) - 601 ))" > "/tmp/prism-router/feishu-oauth/$EXP.json"
cgi "action=callback&code=good&state=$EXP"
eq 404 "$(ccode)" "过期 state 的 callback -> 404"
rm -f "/tmp/prism-router/feishu-oauth/$EXP.json"
# 缺 code
cgi "action=start" GET "router.lan:8080"
STATE=$(jget state)
cgi "action=callback&state=$STATE"
eq 400 "$(ccode)" "缺 code -> 400"
# 非法 code（mock 返回 20003）
cgi "action=callback&code=bad&state=$STATE"
eq 502 "$(ccode)" "非法 code -> 502（上游 code 非 0）"
neq "" "$(jget error)" "非法 code 返回可读 error"
hasnt "$SECRET" "$CGI_B" "非法 code 响应不含 app_secret"
hasnt "$USER_TOKEN" "$CGI_B" "非法 code 响应不含 token"
cgi "action=status&state=$STATE"
eq "error" "$(jget status)" "失败后 status=error（前端可提示重新扫码）"
neq "" "$(jget error)" "error 状态带 error 文案"
hasnt "$SECRET" "$CGI_B" "error 状态不含 app_secret"
hasnt "$USER_TOKEN" "$CGI_B" "error 状态不含 token"
# 上游 5xx
touch /tmp/mock/fail-oidc
cgi "action=start" GET "router.lan:8080"
STATE=$(jget state)
cgi "action=callback&code=good&state=$STATE"
eq 502 "$(ccode)" "上游 5xx -> 502"
rm -f /tmp/mock/fail-oidc

echo
echo "=== 7. 并发 state 上限（最多 8 个）==="
i=1
while [ "$i" -le 9 ]; do
  cgi "action=start" GET "router.lan:8080"
  i=$((i + 1))
done
N=$(state_dir_files)
[ "$N" -le 8 ] && ok "连续 9 次 start 后 state 文件数 $N <= 8（删最旧）" || bad "state 文件数超限：$N"
cgi "action=start" GET "router.lan:8080"
LAST=$(jget state)
[ -f "/tmp/prism-router/feishu-oauth/$LAST.json" ] && ok "最新 state 一定在（$LAST）" || bad "最新 state 文件缺失"

echo
echo "=== 8. 经 uhttpd 的真实 HTTP ==="
cat > /tmp/mockwww/cgi-bin/prism-router-feishu <<WRAP
#!/bin/sh
PRISM_ROUTER_FEISHU_BASE='$MOCK_BASE' exec ucode $CGI
WRAP
chmod 755 /tmp/mockwww/cgi-bin/prism-router-feishu
/usr/sbin/uhttpd -f -p 127.0.0.1:18080 -h /tmp/mockwww -x /cgi-bin >/tmp/web-uhttpd.log 2>&1 &
WEB="http://127.0.0.1:18080/cgi-bin/prism-router-feishu"
H=/tmp/web.h; B=/tmp/web.b
wreq(){ # $1=query [$2=extra curl 参数...]
  q="$1"; shift
  rm -f "$H" "$B"
  curl -s -m 10 "$@" -D "$H" -o "$B" -w '%{http_code}' "$WEB?$q" 2>/dev/null
}
whdr(){ grep -i "^$1:" "$H" 2>/dev/null | head -1 | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//'; }
i=0; while [ "$i" -lt 40 ]; do
  c=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$WEB?action=status&state=x" 2>/dev/null)
  case "$c" in 400|404|405|200|500) break ;; esac
  i=$((i+1)); sleep 0.2
done
eq 200 "$(wreq 'action=start')" "uhttpd: GET start -> 200"
eq "application/json; charset=utf-8" "$(whdr Content-Type)" "uhttpd: JSON Content-Type 正确"
eq "no-store" "$(whdr Cache-Control)" "uhttpd: 带 Cache-Control: no-store"
WSTATE=$(P=state F="$B" ucode /tmp/jget.uc 2>/dev/null)
case "$WSTATE" in
  [0-9a-f][0-9a-f][0-9a-f]*) ok "uhttpd: start 返回 state（$WSTATE）" ;;
  *) bad "uhttpd: start 未返回 state" ;;
esac
if grep -qi "^X-Powered-By" "$H" 2>/dev/null; then bad "uhttpd: 泄漏了 X-Powered-By"; else ok "uhttpd: 没有 X-Powered-By"; fi
eq 405 "$(wreq 'action=start' -X POST)" "uhttpd: POST -> 405"
eq 200 "$(wreq "action=callback&code=good&state=$WSTATE")" "uhttpd: callback -> 200"
eq "text/html; charset=utf-8" "$(whdr Content-Type)" "uhttpd: callback 返回 HTML"
has "授权成功" "$B" "uhttpd: callback 页面含成功文案"
WST=$(wreq "action=status&state=$WSTATE")
eq 200 "$WST" "uhttpd: status -> 200"
eq "ready" "$(P=status F="$B" ucode /tmp/jget.uc 2>/dev/null)" "uhttpd: status=ready"

echo
echo "=== 9. app 模式发送（feishu.uc）：Bearer / chat_id / token 缓存 ==="
mreset(){ rm -f "$MOCK"/*-count "$MOCK"/*.jsonl "$MOCK"/fail-* 2>/dev/null; }
mcount(){ c=$(cat "$MOCK/$1-count" 2>/dev/null); [ -n "$c" ] && echo "$c" || echo 0; }
UCI set prism-router.feishu.mode='app'
UCI set prism-router.feishu.app_id='cli_mockapp'
UCI set prism-router.feishu.app_secret="$SECRET"
UCI set prism-router.feishu.chat_id='oc_chat_01'
UCI set prism-router.feishu.webhook=''
UCI set prism-router.feishu.secret=''
UCI commit prism-router
rm -f /tmp/prism-router/feishu-tenant.json
mreset
: > /tmp/curl-argv.log
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-test1.log 2>&1
rc_is 0 $? "app 模式 test 发送成功"
eq 1 "$(mcount token)" "tenant token 只请求 1 次"
eq 1 "$(mcount msg)" "消息只发送 1 次"
M1=$(head -1 "$MOCK/msg-requests.jsonl" 2>/dev/null)
case "$M1" in
  "Bearer $TENANT_TOKEN|"*) ok "发送带 Authorization: Bearer <tenant_access_token>" ;;
  *) bad "发送缺少 Bearer 头：$M1" ;;
esac
case "$M1" in
  *"receive_id_type=chat_id"*) ok "发送用 receive_id_type=chat_id" ;;
  *) bad "发送缺少 receive_id_type=chat_id：$M1" ;;
esac
case "$M1" in
  *'"receive_id": "oc_chat_01"'*) ok "receive_id 取 UCI 里的 chat_id" ;;
  *) bad "receive_id 不是 UCI chat_id：$M1" ;;
esac
hasnt "$SECRET" /tmp/fs-test1.log "test 输出不含 app_secret"
hasnt "$TENANT_TOKEN" /tmp/fs-test1.log "test 输出不含 tenant token"
hasnt "$SECRET" /tmp/curl-argv.log "curl argv 不含 app_secret"
hasnt "Bearer" /tmp/curl-argv.log "curl argv 不含 Bearer"
check /tmp/prism-router/feishu-tenant.json "-rw------- root:root"
has '"app_id": "cli_mockapp"' /tmp/prism-router/feishu-tenant.json "token 缓存按 app_id 区分"
# 缓存命中：第二次不该再请求 internal
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-test2.log 2>&1
rc_is 0 $? "第二次 test 成功"
eq 1 "$(mcount token)" "token 缓存命中（internal 仍只请求 1 次）"
eq 2 "$(mcount msg)" "第二次仍然发消息"
# 过期前 60 秒要刷新
NOW=$(date +%s)
printf '{"app_id":"cli_mockapp","token":"%s","expire":%d}\n' "$TENANT_TOKEN" "$((NOW + 30))" \
  > /tmp/prism-router/feishu-tenant.json
chmod 600 /tmp/prism-router/feishu-tenant.json
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-test3.log 2>&1
eq 2 "$(mcount token)" "过期前 60 秒内重新申请 token（第 2 次）"
# --chat 覆盖 chat_id
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test --chat 'oc_override' >/tmp/fs-test4.log 2>&1
rc_is 0 $? "--chat 覆盖时 test 成功"
tail -1 "$MOCK/msg-requests.jsonl" 2>/dev/null | grep -q '"receive_id": "oc_override"' \
  && ok "--chat 覆盖了 receive_id" || bad "--chat 未生效：$(tail -1 "$MOCK/msg-requests.jsonl" 2>/dev/null)"
# chats 子命令（同一个 mock）
mreset
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" chats >/tmp/fs-chats.log 2>&1
rc_is 0 $? "chats 子命令退出 0"
has "oc_chat_01" /tmp/fs-chats.log "chats 输出 chat_id"
has "oc_chat_60" /tmp/fs-chats.log "chats 输出全部群（60 个）"

echo
echo "=== 10. 失败处理：单次 + 一次重试 + 回退 webhook ==="
UCI set prism-router.feishu.webhook='http://127.0.0.1:19091/open-apis/bot/v2/hook/mockhook'
UCI set prism-router.feishu.secret='wsec'
UCI commit prism-router
mreset
rm -f /tmp/prism-router/feishu-tenant.json
rm -f /tmp/prism-router/feishu.log
touch "$MOCK/fail-rate"          # 230020 = 可重试限流
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-fb1.log 2>&1
rc_is 0 $? "限流失败后回退 webhook 成功（test 返回 0）"
eq 2 "$(mcount msg)" "可重试错误：应用路线只重试一次（共 2 次）"
eq 1 "$(mcount hook)" "回退 webhook 发送 1 次"
has "回退 webhook" /tmp/prism-router/feishu.log "日志记录回退原因"
rm -f "$MOCK/fail-rate"
mreset
touch "$MOCK/fail-messages"      # 230002 = 不可重试（机器人不在群里）
rm -f /tmp/prism-router/feishu.log
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-fb2.log 2>&1
rc_is 0 $? "不可重试错误也回退 webhook（test 返回 0）"
eq 1 "$(mcount msg)" "不可重试错误：应用路线只发 1 次（不重试风暴）"
eq 1 "$(mcount hook)" "回退 webhook 发送 1 次"
rm -f "$MOCK/fail-messages"
# 没有 webhook 时：失败就是失败，不重试风暴
UCI set prism-router.feishu.webhook=''
UCI set prism-router.feishu.secret=''
UCI commit prism-router
mreset
touch "$MOCK/fail-messages"
rm -f /tmp/prism-router/feishu-tenant.json
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-fb3.log 2>&1
rc_is 1 $? "没配 webhook：失败时 test 返回 1"
eq 1 "$(mcount msg)" "没配 webhook：失败只发 1 次"
eq 0 "$(mcount hook)" "没配 webhook：不会调用 webhook"
has "失败" /tmp/fs-fb3.log "失败时 print 出明确提示"
rm -f "$MOCK/fail-messages"

echo
echo "=== 11. webhook 模式不受影响（含旧配置自动判定）==="
UCI set prism-router.feishu.mode='webhook'
UCI set prism-router.feishu.webhook='http://127.0.0.1:19091/open-apis/bot/v2/hook/mockhook'
UCI set prism-router.feishu.secret='wsec'
UCI set prism-router.feishu.app_id='cli_mockapp'
UCI set prism-router.feishu.app_secret="$SECRET"
UCI set prism-router.feishu.chat_id='oc_chat_01'
UCI commit prism-router
mreset
rm -f /tmp/prism-router/feishu-tenant.json
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-wh1.log 2>&1
rc_is 0 $? "mode=webhook：test 成功"
eq 1 "$(mcount hook)" "mode=webhook：走 webhook 1 次"
eq 0 "$(mcount token)" "mode=webhook：不申请 tenant token"
eq 0 "$(mcount msg)" "mode=webhook：不调用 im/v1/messages"
# mode 缺省（老配置）：三件套齐全 -> 仍走应用路线
UCI delete prism-router.feishu.mode
UCI commit prism-router
[ -z "$(CGET prism-router.feishu.mode)" ] && ok "已删除 mode 选项（模拟老配置升级）" || bad "mode 删除失败"
mreset
rm -f /tmp/prism-router/feishu-tenant.json
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-old1.log 2>&1
rc_is 0 $? "mode 缺省 + 三件套齐全：test 成功"
eq 1 "$(mcount msg)" "mode 缺省：仍按旧行为走应用路线"
eq 0 "$(mcount hook)" "mode 缺省：不回落到 webhook"
# 什么都没配：静默跳过（返回 1，但不发任何请求）
UCI set prism-router.feishu.mode='webhook'
UCI set prism-router.feishu.webhook=''
UCI set prism-router.feishu.secret=''
UCI set prism-router.feishu.app_id=''
UCI set prism-router.feishu.app_secret=''
UCI set prism-router.feishu.chat_id=''
UCI commit prism-router
mreset
PRISM_ROUTER_FEISHU_BASE="$MOCK_BASE" ucode "$FEISHU" test >/tmp/fs-none.log 2>&1
rc_is 1 $? "全空配置：test 返回 1（未发送）"
eq 0 "$(mcount token)" "全空配置：不发 token 请求"
eq 0 "$(mcount msg)" "全空配置：不发消息"
eq 0 "$(mcount hook)" "全空配置：不发 webhook"

echo
echo "=== 12. 收尾：CGI stderr 全程安静 / 状态目录权限稳定 ==="
[ -s /tmp/cgi.err ] && { bad "CGI 有 stderr 输出"; head -3 /tmp/cgi.err; } || ok "CGI 全程没有 stderr 输出"
eq "drwx------" "$(ls -ld /tmp/prism-router/feishu-oauth | awk '{print $1}')" "授权状态目录权限 0700"
eq 0 "$(tenv_files)" "没有遗留临时文件"
[ -f /etc/config/prism-router ] && ok "配置文件仍在（CGI 不写 /etc/config）" || bad "配置文件不见了"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
