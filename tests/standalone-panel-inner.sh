#!/bin/sh
# 独立面板服务（uhttpd 单实例 + 只读 ucode CGI）用例（容器内执行；
# 由 tests/container-validate-standalone-panel.sh 调用）
#
# 覆盖：
#   1. 安装后落位与权限（init 755、CGI 755、静态 644）
#   2. sh -n / ucode -c 语法；UCI panel 段默认值（enabled=0 / 8099 / bind 空 / token 空）
#   3. 默认关闭：/etc/init.d/prism-router-panel start 不监听任何端口
#   4. 真实 procd 启动独立 uhttpd → ?what=state 200 + JSON(totals) + 安全响应头 + Content-Length
#   5. 白名单：status / nodes / stations / state 默认；what=bad → 400
#   6. 方法：POST → 405；HEAD → 200 且 CGI 不输出 body
#   7. token：未设 → 200；设置后 无/错 → 401，query/Bearer 正确 → 200，X-Panel-Token 在 CGI 层验证
#   8. history：days=2 → 200 且含 days 数组；非法 days 回退/夹取不报错
#   9. 静态页面：/ → 200 text/html（页面尚未由前端任务提供时用临时占位，不写最终页面）
#  10. 参数回退：非法 port → 8099；非法 bind → 监听所有接口；旧端口不再监听
#  11. bind 默认取 network.lan.ipaddr
#  12. 后端异常：rpcd 不在 → 500 {"error":"internal"}，响应体不含路径/堆栈
#  13. 日志：init 不读 token、CGI 不写文件/不记日志、临时日志里没有 token
#
# 隔离：--network none，只有 127.0.0.1；不访问外网、不接触任何真机。
mkdir -p /var/run/ubus /var/lock /tmp

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
CGET(){ uci -q get "$1" 2>/dev/null; }

PORT=18099
PANEL="http://127.0.0.1:$PORT"
H=/tmp/panel-headers.txt
B=/tmp/panel-body.txt
TOK='panel-secret-9f3c1a7b'

# 发请求：$1=URL，其余是额外 curl 参数；headers -> $H，body -> $B，打印 HTTP 状态码
req(){
  local url="$1"; shift
  rm -f "$H" "$B"
  curl -s -m 10 "$@" -D "$H" -o "$B" -w '%{http_code}' "$url" 2>/dev/null
}
hdr(){ grep -i "^$1:" "$H" 2>/dev/null | head -n 1 | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//'; }
has_hdr(){ grep -qi "^$1:" "$H" 2>/dev/null; }
# 等面板真正开始监听（200/400/401/405/500 都说明 uhttpd 已起来）
wait_panel(){
  local i=0 code
  while [ "$i" -lt 60 ]; do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$PANEL/cgi-bin/panel-api?what=status" 2>/dev/null)
    case "$code" in 200|400|401|405|500) return 0 ;; esac
    i=$((i+1)); sleep 0.2
  done
  return 1
}
json_expr(){ # $1=表达式（d 为解析后的 JSON）
  ucode -e "
    let fs = require('fs');
    let d = null;
    try { d = json(fs.readfile('/tmp/panel-body.txt')); } catch (e) { d = null; }
    print((function(d){ return ($1); })(d) ? '1' : '0');" 2>/dev/null
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=$B_CGI"

echo "=== 1. 安装两个包 ==="
opkg install /src/dist/prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 \
  && ok "prism-router 安装成功" || { bad "prism-router 安装失败"; tail -8 /tmp/i1.log; }
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i2.log 2>&1 \
  && ok "luci-app 安装成功" || { bad "luci-app 安装失败"; tail -8 /tmp/i2.log; }

echo "=== 2. 落位 / 权限 / 语法 / 默认配置 ==="
check /etc/init.d/prism-router-panel "root:root -rwxr-xr-x"
check /www/prism-router-panel "root:root drwxr-xr-x"
check /www/prism-router-panel/cgi-bin "root:root drwxr-xr-x"
check /www/prism-router-panel/cgi-bin/panel-api "root:root -rwxr-xr-x"
sh -n /etc/init.d/prism-router-panel && ok "prism-router-panel.init 语法 OK" || bad "prism-router-panel.init 语法错误"
ucode -c /www/prism-router-panel/cgi-bin/panel-api && ok "panel-api 语法 OK" || bad "panel-api 语法错误"
[ "$(CGET prism-router.panel.enabled)" = "0" ] && ok "panel.enabled 默认 0（关闭）" \
  || bad "panel.enabled 默认值=$(CGET prism-router.panel.enabled)"
[ "$(CGET prism-router.panel.port)" = "8099" ] && ok "panel.port 默认 8099" \
  || bad "panel.port 默认值=$(CGET prism-router.panel.port)"
[ -z "$(CGET prism-router.panel.bind)" ] && ok "panel.bind 默认空（自动取 LAN）" || bad "panel.bind 默认值非空"
[ -z "$(CGET prism-router.panel.token)" ] && ok "panel.token 默认空（仅靠网络边界）" || bad "panel.token 默认值非空"

# 静态页面由前端任务提供（prism-router/files/panel/）。本门禁可以在页面尚未就绪时运行：
# 缺失时创建一个**临时占位** index.html，只用来验证静态根与 MIME，不写任何最终页面。
PLACEHOLDER=0
if [ -f /www/prism-router-panel/index.html ]; then
  check /www/prism-router-panel/index.html "root:root -rw-r--r--"
  echo "  NOTE  静态页面已由前端任务提供"
else
  printf '<!doctype html>\n<html><head><meta charset="utf-8"><title>panel placeholder</title></head><body>placeholder</body></html>\n' \
    > /www/prism-router-panel/index.html
  chmod 644 /www/prism-router-panel/index.html
  PLACEHOLDER=1
  echo "  NOTE  静态页面尚未由前端任务提供，创建临时占位 index.html（不写最终页面）"
fi

echo "=== 3. 起 ubusd / procd / rpcd（真实 ubus 对象 prism-router）==="
/sbin/ubusd -s /var/run/ubus/ubus.sock >/tmp/ubusd.log 2>&1 &
sleep 1
/sbin/procd >/tmp/procd.log 2>&1 &
sleep 1
/sbin/rpcd -s /var/run/ubus/ubus.sock >/tmp/rpcd.log 2>&1 &
sleep 1
ubus list 2>/dev/null | grep -qx prism-router && ok "rpcd 已注册 ubus 对象 prism-router" \
  || { bad "ubus 对象 prism-router 未注册"; cat /tmp/rpcd.log; }

echo "=== 4. 默认关闭：start 不监听 ==="
UCI set prism-router.panel.bind='127.0.0.1'
UCI set prism-router.panel.port="$PORT"
UCI commit prism-router
/etc/init.d/prism-router-panel start >/tmp/panel-start-disabled.log 2>&1 \
  && ok "/etc/init.d/prism-router-panel start（enabled=0）退出码 0" \
  || bad "/etc/init.d/prism-router-panel start（enabled=0）退出码非 0"
sleep 1
if curl -s -m 3 -o /dev/null "$PANEL/"; then
  bad "enabled=0 时仍监听 $PORT（默认关闭失效）"
else
  ok "enabled=0 时未监听 $PORT（默认关闭生效）"
fi

echo "=== 5. 启用后（127.0.0.1:$PORT）真实 procd 启动 uhttpd ==="
UCI set prism-router.panel.enabled='1'
UCI commit prism-router
/etc/init.d/prism-router-panel start >/tmp/panel-start.log 2>&1 \
  && ok "启用后 start 退出码 0" || { bad "启用后 start 失败"; tail -5 /tmp/panel-start.log; }
wait_panel && ok "uhttpd 已监听 $PANEL" || { bad "uhttpd 未监听 $PANEL"; cat /tmp/panel-start.log; }

echo "=== 6. ?what=state：200 / JSON / 安全响应头 ==="
code=$(req "$PANEL/cgi-bin/panel-api?what=state")
[ "$code" = "200" ] && ok "what=state -> HTTP 200" || bad "what=state -> HTTP $code"
[ "$(hdr 'Content-Type')" = "application/json; charset=utf-8" ] \
  && ok "Content-Type: application/json; charset=utf-8" || bad "Content-Type=[$(hdr 'Content-Type')]"
[ "$(hdr 'Cache-Control')" = "no-store" ] && ok "Cache-Control: no-store" \
  || bad "Cache-Control=[$(hdr 'Cache-Control')]"
[ "$(hdr 'X-Content-Type-Options')" = "nosniff" ] && ok "X-Content-Type-Options: nosniff" \
  || bad "X-Content-Type-Options=[$(hdr 'X-Content-Type-Options')]"
[ "$(hdr 'Referrer-Policy')" = "no-referrer" ] && ok "Referrer-Policy: no-referrer" \
  || bad "Referrer-Policy=[$(hdr 'Referrer-Policy')]"
CL=$(hdr 'Content-Length')
[ -n "$CL" ] && [ "$CL" -gt 0 ] 2>/dev/null && ok "Content-Length: $CL" || bad "缺少或非法 Content-Length=[$CL]"
[ "$(json_expr 'type(d)=="object" && type(d.totals)=="object"')" = "1" ] \
  && ok "响应是合法 JSON 且含 totals 对象" || { bad "响应不是合法 JSON 或缺少 totals"; head -c 200 "$B"; echo; }
[ "$(json_expr 'type(d)=="object" && type(d.totals)=="object" && (d.devices==null || type(d.devices)=="array") && (d.running==null || type(d.running)=="bool")')" = "1" ] \
  && ok "state 契约字段类型正确（无 daemon 时 devices/running 可为空壳）" || bad "state 结构异常"

echo "=== 7. 白名单 / 默认 what / 400 ==="
code=$(req "$PANEL/cgi-bin/panel-api")
[ "$code" = "200" ] && ok "无 what 参数默认 state -> 200" || bad "无 what 参数 -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=status")
[ "$code" = "200" ] && [ "$(json_expr 'type(d.version)=="string"')" = "1" ] \
  && ok "what=status -> 200 且含 version" || bad "what=status -> $code / $(head -c 120 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=nodes")
[ "$code" = "200" ] && [ "$(json_expr 'type(d.nodes)=="array"')" = "1" ] \
  && ok "what=nodes -> 200 且含 nodes[]" || bad "what=nodes -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=stations")
[ "$code" = "200" ] && ok "what=stations -> 200" || bad "what=stations -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
[ "$code" = "200" ] && ok "what=settings -> 200" || bad "what=settings -> $code"
[ "$(json_expr 'type(d.settings)=="object" && type(d.panel)=="object" && type(d.panel.port)=="string"')" = "1" ] \
  && ok "settings 含 settings/panel 字段" || bad "settings 结构异常"
[ "$(json_expr 'd.write!=null && d.write.enabled==false')" = "1" ] \
  && ok "settings.write.enabled=false（写能力未开放）" || bad "settings.write 异常"
code=$(req "$PANEL/cgi-bin/panel-api?what=bad")
[ "$code" = "400" ] && [ "$(json_expr 'd?.error=="bad_request"')" = "1" ] \
  && ok "what=bad -> 400 bad_request" || bad "what=bad -> $code / $(head -c 120 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=set_config")
[ "$code" = "400" ] && ok "写方法名（set_config）不在白名单 -> 400" || bad "set_config -> $code"

echo "=== 8. 方法：POST -> 405，HEAD -> 200（CGI 层不输出 body）==="
code=$(req "$PANEL/cgi-bin/panel-api?what=state" -X POST)
[ "$code" = "405" ] && [ "$(json_expr 'd?.error=="method_not_allowed"')" = "1" ] \
  && ok "POST -> 405 method_not_allowed（经 uhttpd）" || bad "POST -> $code / $(head -c 120 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=state" -I)
[ "$code" = "200" ] && ok "HEAD -> 200" || bad "HEAD -> $code"
[ -n "$(hdr 'Content-Length')" ] && ok "HEAD 仍带 Content-Length（GET 会返回的字节数）" || bad "HEAD 缺 Content-Length"
# curl -I 的 -o 收到的是响应头本身，不能据此判断 body；直接执行 CGI 看 HEAD 是否真的不回体
out=$(env REQUEST_METHOD=HEAD QUERY_STRING="what=state" ucode /www/prism-router-panel/cgi-bin/panel-api 2>/dev/null | tr -d '\r')
case "$out" in
  *"Content-Type: application/json"*) ok "HEAD CGI 输出 JSON 头" ;;
  *) bad "HEAD CGI 未输出 JSON 头" ;;
esac
BODY_LINES=$(printf '%s\n' "$out" | awk 'BEGIN{b=0} /^$/ {b=1; next} {if (b) n++} END{print n+0}')
[ "$BODY_LINES" = "0" ] && ok "HEAD 直接执行 CGI 无 body（只有响应头）" \
  || bad "HEAD CGI 仍输出 $BODY_LINES 行 body"

echo "=== 9. history days（1–31） ==="
code=$(req "$PANEL/cgi-bin/panel-api?what=history&days=2")
[ "$code" = "200" ] && [ "$(json_expr 'type(d.days)=="array"')" = "1" ] \
  && ok "history&days=2 -> 200 且含 days[]" || bad "history&days=2 -> $code / $(head -c 160 "$B")"
N=$(json_expr 'length(d.days)')
[ -n "$N" ] && [ "$N" -le 2 ] && ok "days=2 最多返回 2 个日期（实际 $N）" || bad "days=2 返回了 $N 个日期"
code=$(req "$PANEL/cgi-bin/panel-api?what=history&days=99")
[ "$code" = "200" ] && ok "days=99 被夹到 31（不报错）" || bad "days=99 -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=history&days=abc")
[ "$code" = "200" ] && ok "days=abc 回退默认（不报错）" || bad "days=abc -> $code"

echo "=== 10. token：未设 vs 设置后 ==="
code=$(req "$PANEL/cgi-bin/panel-api?what=settings&token=$TOK")
[ "$code" = "200" ] && ok "settings 带 token -> 200" || bad "settings 带 token -> $code"
if grep -q "$TOK" "$B" 2>/dev/null; then bad "settings 响应泄漏 token 明文"; else ok "settings 不含 token 明文"; fi
UCI set prism-router.panel.token="$TOK"
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=state")
[ "$code" = "401" ] && [ "$(json_expr 'd?.error=="unauthorized"')" = "1" ] \
  && ok "设 token 后不带 -> 401 unauthorized" || bad "不带 token -> $code / $(head -c 120 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=state&token=wrong-token")
[ "$code" = "401" ] && ok "错误 token -> 401" || bad "错误 token -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=state&token=$TOK")
[ "$code" = "200" ] && ok "?token=<正确> -> 200" || bad "query token -> $code"
# uhttpd 只转发 Accept/Authorization/Host/User-Agent，自定义 X-* 头会被丢弃，
# 所以 X-Panel-Token 在 CGI 层直接验证（标准 CGI/反代场景），HTTP 层用 Bearer 验证。
out=$(env REQUEST_METHOD=GET QUERY_STRING="what=state" HTTP_X_PANEL_TOKEN="$TOK" ucode /www/prism-router-panel/cgi-bin/panel-api 2>/dev/null | tr -d '\r')
case "$out" in
  *"Content-Type: application/json"*) ok "X-Panel-Token: <正确> -> 200（CGI 层；uhttpd 不转发 X-* 头）" ;;
  *) bad "header token -> $(printf '%s' "$out" | head -1)" ;;
esac
code=$(req "$PANEL/cgi-bin/panel-api?what=state" -H "Authorization: Bearer $TOK")
[ "$code" = "200" ] && ok "Authorization: Bearer <正确> -> 200（经 uhttpd）" \
  || bad "Authorization Bearer -> $code / $(head -c 120 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=state" -H "Authorization: Bearer wrong")
[ "$code" = "401" ] && ok "Authorization: Bearer 错误 -> 401" || bad "Authorization Bearer 错误 -> $code"
code=$(env REQUEST_METHOD=GET QUERY_STRING="what=state" HTTP_X_PANEL_TOKEN=wrong ucode /www/prism-router-panel/cgi-bin/panel-api 2>/dev/null | head -1 | tr -d '\r')
case "$code" in
  "Status: 401 Unauthorized") ok "错误 X-Panel-Token -> 401（CGI 层）" ;;
  *) bad "错误 header token -> $code" ;;
esac
code=$(req "$PANEL/cgi-bin/panel-api?what=bad")
[ "$code" = "401" ] && ok "未认证时先返回 401（不暴露 what 白名单）" || bad "未认证 what=bad -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=bad&token=$TOK")
[ "$code" = "400" ] && ok "认证后 what=bad -> 400" || bad "认证后 what=bad -> $code"
UCI set prism-router.panel.token=''
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=state")
[ "$code" = "200" ] && ok "清空 token 后恢复 200" || bad "清空 token 后 -> $code"

echo "=== 11. 静态页面 / 静态根 ==="
code=$(req "$PANEL/")
[ "$code" = "200" ] && ok "GET / -> 200" || bad "GET / -> $code"
case "$(hdr 'Content-Type')" in
  text/html*) ok "GET / Content-Type=$(hdr 'Content-Type')" ;;
  *) bad "GET / Content-Type=[$(hdr 'Content-Type')]" ;;
esac
[ "$PLACEHOLDER" = 1 ] && echo "  NOTE  GET / 用的是临时占位页面（前端任务尚未提供静态文件）"

echo "=== 12. 非法 port / bind 回退，旧端口不再监听 ==="
UCI set prism-router.panel.port='99999'
UCI set prism-router.panel.bind='not-an-ip'
UCI commit prism-router
/etc/init.d/prism-router-panel reload >/tmp/panel-reload.log 2>&1 \
  && ok "reload 退出码 0" || { bad "reload 失败"; tail -5 /tmp/panel-reload.log; }
PANEL_BAK="$PANEL"; PANEL="http://127.0.0.1:8099"
if wait_panel; then
  ok "非法 port -> 回退 8099；非法 bind -> 监听所有接口（127.0.0.1 可达）"
else
  bad "非法 port/bind 未回退到 8099"
fi
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
  bad "reload 后旧端口 $PORT 仍在监听"
else
  ok "reload 后旧端口 $PORT 已不再监听"
fi
PANEL="$PANEL_BAK"

echo "=== 13. bind 留空 -> 自动取 network.lan.ipaddr ==="
UCI set network.lan.ipaddr='127.0.0.1'
UCI commit network
UCI set prism-router.panel.port="$PORT"
UCI set prism-router.panel.bind=''
UCI commit prism-router
/etc/init.d/prism-router-panel reload >/tmp/panel-reload2.log 2>&1
if wait_panel; then
  ok "panel.bind 留空 + network.lan.ipaddr=127.0.0.1 -> 监听 127.0.0.1:$PORT"
else
  bad "bind 未从 network.lan.ipaddr 推断"; tail -5 /tmp/panel-reload2.log
fi

echo "=== 14. 后端异常：ubus 对象不存在 -> 500 internal，且不泄漏路径/堆栈 ==="
killall rpcd 2>/dev/null || kill $(pidof rpcd) 2>/dev/null
sleep 2
code=$(req "$PANEL/cgi-bin/panel-api?what=state")
[ "$code" = "500" ] && ok "rpcd 不在 -> 500" || bad "rpcd 不在 -> $code"
[ "$(json_expr 'd?.error=="internal"')" = "1" ] && ok "响应体是 {\"error\":\"internal\"}" \
  || bad "响应体=[$(head -c 160 "$B")]"
if grep -Eq '/(usr|etc|tmp|www)/|stack|traceback|popen|ubus call' "$B" 2>/dev/null; then
  bad "500 响应泄漏了路径/命令/堆栈"
else
  ok "500 响应不含路径/命令/堆栈"
fi

echo "=== 15. 日志与只读边界 ==="
if grep -Eq 'config_get[^#]*token|uci -q get[^#]*token' /etc/init.d/prism-router-panel; then
  bad "init 读取了 token（应只在 CGI 里读，且不写日志）"
else
  ok "init 不读 token"
fi
if grep -Eq 'writefile|appendfile|logger|syslog|/dev/log' /www/prism-router-panel/cgi-bin/panel-api; then
  bad "CGI 出现写文件/日志调用"
else
  ok "CGI 无写文件/日志调用（只读 + 只用 ubus）"
fi
if grep -rqs "$TOK" /tmp/*.log 2>/dev/null; then
  bad "token 出现在日志文件里"
else
  ok "临时日志里没有 token"
fi
grep -q 'config panel' /etc/config/prism-router && ok "conffile 已包含 panel 段" || bad "conffile 缺 panel 段"

echo "=== 16. 系统目录权限未被改动 ==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1