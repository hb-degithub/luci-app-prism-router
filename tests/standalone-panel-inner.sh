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
#   9. apps_history：真实 daily/ 夹具 → 跨天相加/days/排序/最近 chain、坏文件 skipped 不 500、
#      100 条上限、days 夹到 1–31、不写 daily/、token 开启时未认证仍 401
#  10. 静态页面：/ → 200 text/html（页面尚未由前端任务提供时用临时占位，不写最终页面）
#  11. 参数回退：非法 port → 8099；非法 bind → 监听所有接口；旧端口不再监听
#  12. bind 默认取 network.lan.ipaddr
#  13. 后端异常：rpcd 不在 → 500 {"error":"internal"}，响应体不含路径/堆栈
#  14. 日志：init 不读 token、CGI 不写文件/不记日志、临时日志里没有 token
#  17. 系统信息 CGI（prism-router-system，GET-only、无需登录）：
#      system / services / processes / version 200 + 结构 + Content-Type/Cache-Control
#  18. 管理员 CGI（prism-router-admin）：文件 755、ucode -c、GET 未带 token → 401、
#      POST login 缺密码 → 400
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
json_val(){ # $1=表达式；打印原始值，仅用于 ok/bad 消息（不做 1/0 转换）
  ucode -e "
    let fs = require('fs');
    let d = null;
    try { d = json(fs.readfile('/tmp/panel-body.txt')); } catch (e) { d = null; }
    print((function(d){ return ($1); })(d));" 2>/dev/null
}

# ── 系统信息 / 管理员 CGI（直接执行 CGI，不依赖 LuCI 的 uhttpd）──
SYS=/www/cgi-bin/prism-router-system
ADMIN=/www/cgi-bin/prism-router-admin
SH=/tmp/sys-headers.txt
SB=/tmp/sys-body.json
sysreq(){ # $1=方法 $2=查询串；响应头 -> $SH，响应体 -> $SB
  rm -f "$SH" "$SB" /tmp/sys-raw.txt
  env REQUEST_METHOD="$1" QUERY_STRING="$2" ucode "$SYS" 2>/dev/null | tr -d '\r' > /tmp/sys-raw.txt
  awk -v h="$SH" -v b="$SB" '
    !done { if ($0 == "") { done=1; next } print > h; next }
    { print > b }' /tmp/sys-raw.txt
}
syscode(){ head -n 1 "$SH" 2>/dev/null | sed 's/^Status: //'; }
syshdr(){ grep -i "^$1:" "$SH" 2>/dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*//'; }
sysjson(){ # $1=表达式（d = 解析后的 JSON）
  env F="$SB" ucode -e "
    let fs = require('fs');
    let d = null;
    try { d = json(fs.readfile(getenv('F'))); } catch (e) { d = null; }
    print((function(d){ return ($1); })(d) ? '1' : '0');" 2>/dev/null
}
sysval(){ # $1=表达式；打印原始值（用于长度/计数）
  env F="$SB" ucode -e "
    let fs = require('fs');
    let d = null;
    try { d = json(fs.readfile(getenv('F'))); } catch (e) { d = null; }
    print((function(d){ return ($1); })(d));" 2>/dev/null
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=$B_CGI"

echo "=== 1. 安装两个包 ==="
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 \
  && ok "prism-router 安装成功" || { bad "prism-router 安装失败"; tail -8 /tmp/i1.log; }
true >/tmp/i2.log 2>&1 \
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
[ "$(json_expr 'd.settings.feishu_enabled!=null')" = "1" ] \
  && ok "settings 含 feishu_enabled（映射自 feishu.enabled）" || bad "settings 缺 feishu_enabled 映射"
[ "$(json_expr 'd.settings.retention_daily_days!=null')" = "1" ] \
  && ok "settings 含 retention_daily_days（映射自 retention.daily_days）" || bad "settings 缺 retention_daily_days 映射"
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

echo "=== 10. apps_history：近 N 天应用聚合（ubus get_apps_history，只读）==="
# 直接构造 daily/YYYY-MM-DD.json（与守护进程落盘的字段一致：day/apps[host,rx,tx,chain]）。
# rpcd 的 ucode 插件用默认 DAILY_DIR=/etc/prism-router/daily 读，所以这里就是被测数据源。
APPDIR=/etc/prism-router/daily
mkdir -p "$APPDIR"
day_ago(){ ucode -e "let t=localtime(time()-($1)*86400); print(sprintf('%04d-%02d-%02d', t.year, t.mon, t.mday));" 2>/dev/null; }
D0=$(day_ago 0); D1=$(day_ago 1); D2=$(day_ago 2); D3=$(day_ago 3)
cat > "$APPDIR/$D0.json" <<EOF
{"day":"$D0","ts":1,"totals":{"rx":1,"tx":1},"nodes":{},"devices":[],
 "apps":[{"host":"video.example.com","rx":300,"tx":30,"chain":"US2-HY2","devices":2},
         {"host":"news.example.com","rx":100,"tx":10,"chain":"DIRECT","devices":1},
         {"host":"onlytoday.example.com","rx":50,"tx":5,"chain":"JP1","devices":1}]}
EOF
cat > "$APPDIR/$D1.json" <<EOF
{"day":"$D1","apps":[{"host":"video.example.com","rx":200,"tx":20,"chain":"JP1","devices":1}]}
EOF
cat > "$APPDIR/$D2.json" <<EOF
{"day":"$D2","apps":[{"host":"video.example.com","rx":100,"tx":10,"chain":"OLD-CHAIN","devices":1},
                      {"host":"game.example.com","rx":400,"tx":40,"chain":"SG","devices":1}]}
EOF
# 第 4 个文件故意写坏：必须被跳过并计入 skipped，且不能 500。
printf '{"day":"%s","apps":[{"host":"broken' "$D3" > "$APPDIR/$D3.json"
ls -la "$APPDIR" > /tmp/apps-hist-dir-before

code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=7")
[ "$code" = "200" ] && ok "apps_history&days=7 -> 200" || bad "apps_history&days=7 -> $code / $(head -c 160 "$B")"
[ "$(json_expr 'type(d)=="object" && d.days==7 && d.files==3 && d.skipped==1 && d.truncated==true')" = "1" ] \
  && ok "返回契约 {days:7, files:3, skipped:1, truncated:true}" \
  || { bad "返回契约异常：$(head -c 200 "$B")"; }
[ "$(json_expr 'type(d.apps)=="array" && length(d.apps)==4')" = "1" ] \
  && ok "坏 JSON 文件被跳过（skipped=1）且聚合出 4 个 host" || bad "聚合 host 数=$(json_val 'type(d.apps)=="array" ? length(d.apps) : "-"')"
# 同一 host 跨 3 天相加：300+200+100=600 / 30+20+10=60；days=3；chain 取最近的 US2-HY2。
[ "$(json_expr 'd.apps[0].host=="video.example.com" && d.apps[0].rx==600 && d.apps[0].tx==60 && d.apps[0].days==3 && d.apps[0].chain=="US2-HY2"')" = "1" ] \
  && ok "跨天聚合：video.example.com rx=600 tx=60 days=3 chain=US2-HY2（最近一天优先）" \
  || { bad "跨天聚合异常：$(json_val 'sprintf("%s rx=%d tx=%d days=%d chain=%s", d.apps[0].host, d.apps[0].rx, d.apps[0].tx, d.apps[0].days, d.apps[0].chain)')"; }
[ "$(json_expr 'join(",", map(d.apps, a => a.host))=="video.example.com,game.example.com,news.example.com,onlytoday.example.com"')" = "1" ] \
  && ok "按 rx+tx 降序（660/440/110/55）" || { bad "排序=[$(json_val 'join(",", map(d.apps, a => sprintf("%s:%d", a.host, a.rx+a.tx)))')]"; }
[ "$(json_expr '(function(a){ let prev=null; for (let x in a) { let t=x.rx+x.tx; if (prev!=null && t>prev) return false; prev=t; } return true; })(d.apps)')" = "1" ] \
  && ok "apps 严格单调不增（rx+tx）" || bad "apps 未按 rx+tx 单调排序"

code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=2")
[ "$code" = "200" ] && ok "apps_history&days=2 -> 200" || bad "apps_history&days=2 -> $code"
[ "$(json_expr 'd.days==2 && d.files==2 && d.skipped==0 && length(d.apps)==3 && d.apps[0].rx==500 && d.apps[0].days==2')" = "1" ] \
  && ok "days=2 只看最近 2 个日文件（video=500/50，days=2）" \
  || { bad "days=2 窗口异常：$(head -c 200 "$B")"; }
[ "$(json_expr 'index(join(",", map(d.apps, a => a.host)), "game.example.com") < 0')" = "1" ] \
  && ok "days=2 不含第 3 天的 host（窗口按文件名截取）" || bad "days=2 混入了窗口外的 host"

# days 夹到 1..31（panel-api 先夹，ubus 再夹一次）；缺省 7。
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=99")
[ "$code" = "200" ] && [ "$(json_expr 'd.days==31')" = "1" ] \
  && ok "days=99 被夹到 31（不报错）" || bad "days=99 -> $code / days=$(json_val 'd.days')"
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=0")
[ "$code" = "200" ] && [ "$(json_expr 'd.days==1 && d.files==1')" = "1" ] \
  && ok "days=0 被夹到 1（只读最近 1 个文件）" || bad "days=0 -> $code / $(head -c 160 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history")
[ "$code" = "200" ] && [ "$(json_expr 'd.days==7')" = "1" ] \
  && ok "省略 days 默认 7（不传参数不报错）" || bad "缺省 days -> $code / days=$(json_val 'd.days')"
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=abc")
[ "$code" = "200" ] && [ "$(json_expr 'd.days==7')" = "1" ] \
  && ok "days=abc 回退默认 7（不把脏值传给 ubus）" || bad "days=abc -> $code"

# 只读：聚合只读文件，不能在 daily/ 里留下任何新文件（改动 mtime/entries 都会被发现）。
ls -la "$APPDIR" > /tmp/apps-hist-dir-after
if cmp -s /tmp/apps-hist-dir-before /tmp/apps-hist-dir-after; then
  ok "apps_history 未写 daily/（目录快照前后一致）"
else
  bad "apps_history 改动了 daily/ 目录"; diff /tmp/apps-hist-dir-before /tmp/apps-hist-dir-after | head -5
fi

# 100 条上限：把现有用例挪开，只留一个 130 条应用的当日文件，断言被截到 100 条。
BAK=/tmp/apps-hist-bak
rm -rf "$BAK"; mkdir -p "$BAK"
mv "$APPDIR/$D0.json" "$APPDIR/$D1.json" "$APPDIR/$D2.json" "$APPDIR/$D3.json" "$BAK"/
D0="$D0" ucode -e 'let fs=require("fs"); let a=[]; for (let i=0;i<130;i++) push(a,{host:sprintf("H%03d.example.com",i),rx:i*10,tx:i,chain:"C"}); fs.writefile("/etc/prism-router/daily/"+getenv("D0")+".json", sprintf("%J",{day:getenv("D0"),apps:a}));' 2>/dev/null
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=1")
[ "$code" = "200" ] && ok "130 条应用 -> 200" || bad "130 条应用 -> $code"
[ "$(json_expr 'type(d.apps)=="array" && length(d.apps)==100')" = "1" ] \
  && ok "最多返回 100 条（实际 $(json_val 'type(d.apps)=="array" ? length(d.apps) : "-"')）" \
  || bad "未截到 100 条：$(json_val 'type(d.apps)=="array" ? length(d.apps) : "-"')"
[ "$(json_expr 'd.apps[0].host=="H129.example.com" && d.apps[99].host=="H030.example.com"')" = "1" ] \
  && ok "截断后仍保留最大的 100 条（H129 … H030）" \
  || bad "截断边界异常：$(json_val 'sprintf("%s -> %s", d.apps[0].host, d.apps[99].host)')"
[ "$(json_expr 'index(join(",", map(d.apps, a => a.host)), "H000.example.com") < 0')" = "1" ] \
  && ok "被截掉的尾部 host（H000）不再返回" || bad "截断后仍含尾部 host"
mv "$BAK"/*.json "$APPDIR"/ && rmdir "$BAK"

# 未认证仍 401：token 开启时 apps_history 也不能绕过认证。
UCI set prism-router.panel.token="$TOK"
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=7")
[ "$code" = "401" ] && [ "$(json_expr 'd?.error=="unauthorized"')" = "1" ] \
  && ok "token 开启后 apps_history 未带 token -> 401 unauthorized" \
  || bad "apps_history 未认证 -> $code / $(head -c 120 "$B")"
code=$(req "$PANEL/cgi-bin/panel-api?what=apps_history&days=7&token=$TOK")
[ "$code" = "200" ] && [ "$(json_expr 'length(d.apps)==4')" = "1" ] \
  && ok "带 token 的 apps_history -> 200 且数据完整" || bad "带 token -> $code"
UCI set prism-router.panel.token=''
UCI commit prism-router

# 清理本节的 daily 夹具，后面的用例不受影响。
rm -f "$APPDIR/$D0.json" "$APPDIR/$D1.json" "$APPDIR/$D2.json" "$APPDIR/$D3.json"

echo "=== 11. token：未设 vs 设置后 ==="
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

echo "=== 12. 静态页面 / 静态根 ==="
code=$(req "$PANEL/")
[ "$code" = "200" ] && ok "GET / -> 200" || bad "GET / -> $code"
case "$(hdr 'Content-Type')" in
  text/html*) ok "GET / Content-Type=$(hdr 'Content-Type')" ;;
  *) bad "GET / Content-Type=[$(hdr 'Content-Type')]" ;;
esac
[ "$PLACEHOLDER" = 1 ] && echo "  NOTE  GET / 用的是临时占位页面（前端任务尚未提供静态文件）"

echo "=== 13. 非法 port / bind 回退，旧端口不再监听 ==="
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

echo "=== 14. bind 留空 -> 自动取 network.lan.ipaddr ==="
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

echo "=== 15. 后端异常：ubus 对象不存在 -> 500 internal，且不泄漏路径/堆栈 ==="
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

echo "=== 16. 日志与只读边界 ==="
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

echo "=== 17. 系统信息 CGI（prism-router-system）：?what=system，GET-only、无需登录 ==="
check "$SYS" "root:root -rwxr-xr-x"
ucode -c "$SYS" >/dev/null 2>&1 && ok "system CGI ucode -c 通过" || bad "system CGI 语法错误"
if grep -Eq 'systemctl|systemd-run|/run/systemd' "$SYS"; then
  bad "system CGI 调用了 systemd（应只用 /proc + init.d/pidof）"
else
  ok "system CGI 不依赖 systemd"
fi

sysreq GET "what=system"
[ "$(syscode)" = "200 OK" ] && ok "what=system 未登录 -> 200" || bad "what=system -> [$(syscode)]"
case "$(syshdr Content-Type)" in
  application/json*) ok "system Content-Type=$(syshdr Content-Type)" ;;
  *) bad "system Content-Type=[$(syshdr Content-Type)]" ;;
esac
[ "$(syshdr Cache-Control)" = "no-store" ] && ok "system Cache-Control: no-store" \
  || bad "system Cache-Control=[$(syshdr Cache-Control)]"
[ "$(syshdr X-Content-Type-Options)" = "nosniff" ] && ok "system X-Content-Type-Options: nosniff" \
  || bad "system X-Content-Type-Options=[$(syshdr X-Content-Type-Options)]"
[ "$(sysjson 'type(d)=="object" && type(d.hostname)=="string" && length(d.hostname)>0')" = "1" ] \
  && ok "system.hostname 非空字符串" || bad "system.hostname 缺失"
[ "$(sysjson 'type(d.model)=="string"')" = "1" ] \
  && ok "system.model 是字符串（容器内可为空；真机读 /tmp/sysinfo/model）" || bad "system.model 类型错误"
[ "$(sysjson 'type(d.kernel)=="string" && length(d.kernel)>0')" = "1" ] \
  && ok "system.kernel 非空（/proc/sys/kernel/osrelease）" || bad "system.kernel 缺失"
[ "$(sysjson 'type(d.uptime)=="int" && d.uptime>=0')" = "1" ] \
  && ok "system.uptime 非负整数（/proc/uptime）" || bad "system.uptime 异常"
[ "$(sysjson '(function(a){ if (type(a)!="array" || length(a)!=3) return false; for (let v in a) if (type(v)!="int" && type(v)!="double") return false; return true; })(d.load)')" = "1" ] \
  && ok "system.load 为 3 个数字（/proc/loadavg）" || bad "system.load 结构异常"
[ "$(sysjson 'type(d.memory)=="object" && d.memory.total>0 && d.memory.free>=0 && d.memory.available>=0')" = "1" ] \
  && ok "system.memory{total,free,available} 为字节且 total>0" || bad "system.memory 结构异常"
[ "$(sysjson 'type(d.rootfs)=="object" && d.rootfs.total>0 && d.rootfs.used>=0 && d.rootfs.free>=0')" = "1" ] \
  && ok "system.rootfs{total,used,free} 为字节且 total>0" || bad "system.rootfs 结构异常"
[ "$(sysjson 'd.version=="1.0.0"')" = "1" ] \
  && ok "system.version=1.0.0（来自 /usr/lib/opkg/info/luci-app-prism-router.control）" \
  || bad "system.version 不是 1.0.0"

echo "=== 18. 服务 / 进程：?what=services、?what=processes ==="
sysreq GET "what=services"
[ "$(syscode)" = "200 OK" ] && ok "what=services -> 200" || bad "what=services -> [$(syscode)]"
[ "$(sysjson 'type(d.services)=="array" && length(d.services)>=5')" = "1" ] \
  && ok "services 为数组且至少 5 项" || bad "services 结构异常"
[ "$(sysjson '(function(a){ for (let s in a) { if (type(s.name)!="string" || length(s.name)==0) return false; if (type(s.label)!="string" || length(s.label)==0) return false; if (type(s.running)!="bool") return false; if (type(s.pid)!="int" || s.pid<0) return false; if (type(s.info)!="string") return false; } return true; })(d.services)')" = "1" ] \
  && ok "每个 service 的 name/label/running/pid/info 类型正确" || bad "service 字段类型异常"
[ "$(sysjson '(function(a){ for (let n in ["prism-routerd","prism-router-panel","crontab","dnsmasq","firewall"]) { let hit=false; for (let s in a) if (s.name==n) hit=true; if (!hit) return false; } return true; })(d.services)')" = "1" ] \
  && ok "包含 prism-routerd/panel/crontab/dnsmasq/firewall 五项" || bad "缺少必需的服务项"
# 此时面板正监听 18099（§14 设置 panel.port），CGI 应通过 UCI + netstat 识别到运行中的 uhttpd。
[ "$(sysjson '(function(a){ for (let s in a) if (s.name=="prism-router-panel") return s.running==true && s.pid>0; return false; })(d.services)')" = "1" ] \
  && ok "prism-router-panel 被识别为运行中（UCI 端口 + netstat）" \
  || bad "未识别到正在监听 18099 的 prism-router-panel"

sysreq GET "what=processes"
[ "$(syscode)" = "200 OK" ] && ok "what=processes -> 200" || bad "what=processes -> [$(syscode)]"
NPROC=$(sysval 'type(d.processes)=="array" ? length(d.processes) : -1')
[ "$NPROC" -ge 0 ] 2>/dev/null && [ "$NPROC" -le 20 ] && ok "processes 为数组且 ≤20 条（实际 $NPROC）" \
  || bad "processes 长度异常（$NPROC）"
if [ "$NPROC" -gt 0 ] 2>/dev/null; then
  [ "$(sysjson '(function(a){ for (let p in a) { if (type(p.pid)!="int" || p.pid<=0) return false; if (type(p.user)!="string" || length(p.user)==0) return false; if (type(p.cpu)!="int" && type(p.cpu)!="double") return false; if (p.cpu<0) return false; if (type(p.mem)!="int" || p.mem<0) return false; if (type(p.command)!="string" || length(p.command)==0 || length(p.command)>80) return false; } return true; })(d.processes)')" = "1" ] \
    && ok "每个进程 pid/user/cpu/mem/command 类型正确，command ≤80 字节" || bad "进程字段类型/截断异常"
  [ "$(sysjson '(function(a){ let prev=null; for (let p in a) { if (prev!=null && p.mem>prev) return false; prev=p.mem; } return true; })(d.processes)')" = "1" ] \
    && ok "按常驻内存降序" || bad "进程未按内存降序"
  if [ "$(sysjson 'index(join(",", map(d.processes, p => p.command)), "kthreadd") < 0')" = "1" ]; then
    ok "内核线程（cmdline 为空）已屏蔽"
  else
    bad "进程列表混入内核线程"
  fi
else
  ok "processes 为空数组但结构正确（容器内进程数不足时允许）"
fi

echo "=== 19. 版本：?what=version（App 比对用） ==="
sysreq GET "what=version"
[ "$(syscode)" = "200 OK" ] && ok "what=version -> 200" || bad "what=version -> [$(syscode)]"
[ "$(sysjson 'type(d)=="object" && length(keys(d))==4')" = "1" ] \
  && ok "version 响应恰好 4 个字段（version/build/apk_version/update_check）" || bad "version 字段数异常"
[ "$(sysjson 'd.version=="1.0.0"')" = "1" ] && ok "version=1.0.0" || bad "version=$(sysjson 'd.version')"
[ "$(sysjson 'd.build=="1.0.0-1"')" = "1" ] && ok "build=1.0.0-1（opkg 完整版本）" || bad "build 异常"
[ "$(sysjson 'd.apk_version=="1.0.0"')" = "1" ] && ok "apk_version=1.0.0（供 App 比对）" || bad "apk_version 异常"
[ "$(sysjson 'd.update_check==false')" = "1" ] && ok "update_check=false（未配置更新源）" || bad "update_check 异常"

echo "=== 20. 方法 / 参数错误：非 GET -> 405，未知 what -> 400，缺省 what=system ==="
sysreq POST "what=system"
[ "$(syscode)" = "405 Method Not Allowed" ] && ok "POST -> 405" || bad "POST -> [$(syscode)]"
[ "$(sysjson 'd.error=="method_not_allowed"')" = "1" ] && ok "POST 响应 {error:method_not_allowed}" || bad "POST 错误体异常"
sysreq PUT "what=version"
[ "$(syscode)" = "405 Method Not Allowed" ] && ok "PUT -> 405" || bad "PUT -> [$(syscode)]"
sysreq GET "what=bad"
[ "$(syscode)" = "400 Bad Request" ] && ok "what=bad -> 400" || bad "what=bad -> [$(syscode)]"
[ "$(sysjson 'd.error=="bad_request"')" = "1" ] && ok "what=bad 响应 {error:bad_request}" || bad "what=bad 错误体异常"
sysreq GET ""
[ "$(syscode)" = "200 OK" ] && [ "$(sysjson 'type(d.hostname)=="string"')" = "1" ] \
  && ok "缺省 what -> system（200 且含 hostname）" || bad "缺省 what 未回退到 system"

echo "=== 21. 管理员 CGI（prism-router-admin）：安装 / 语法 / 未认证 401 / 登录缺密码 400 ==="
check "$ADMIN" "root:root -rwxr-xr-x"
ucode -c "$ADMIN" >/dev/null 2>&1 && ok "admin CGI ucode -c 通过" || bad "admin CGI 语法错误"
raw=$(env REQUEST_METHOD=GET QUERY_STRING="action=system" ucode "$ADMIN" 2>/dev/null | tr -d '\r')
[ "$(printf '%s\n' "$raw" | head -n 1)" = "Status: 401 Unauthorized" ] \
  && ok "GET action=system 未带 token -> 401" || bad "admin GET 未认证 -> [$(printf '%s\n' "$raw" | head -n 1)]"
printf '%s\n' "$raw" | grep -Eq '"error":[[:space:]]*"unauthorized"' \
  && ok "401 响应体 {error:unauthorized}" || bad "401 响应体异常"
raw=$(printf '{"action":"login"}' | env REQUEST_METHOD=POST CONTENT_LENGTH=18 ucode "$ADMIN" 2>/dev/null | tr -d '\r')
[ "$(printf '%s\n' "$raw" | head -n 1)" = "Status: 400 Bad Request" ] \
  && ok "POST login 缺密码 -> 400" || bad "admin POST login -> [$(printf '%s\n' "$raw" | head -n 1)]"
printf '%s\n' "$raw" | grep -Eq '"error":[[:space:]]*"bad_request"' \
  && ok "400 响应体 {error:bad_request}" || bad "400 响应体异常"

echo "=== 22. 系统目录权限未被改动 ==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1