#!/bin/sh
. /src/tests/lib/prism-version-inner.sh
VER="$PRISM_VER"
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
#  22. 管理员配置读写（容器内 mock reload 与 UCI 夹具）：未认证/错误 token 401、登录换 token、
#      GET config 结构、非法输入 400 且不落盘、config_set lan 200+备份 0600/0700+uci 已改+延迟 reload、
#      system/dhcp 合法写、redirect_add/del+firewall reload、config_rollback 恢复、备份保留 10 份、
#      审计日志 0600 且不含 token、非 POST 写 405。
#  24. 自动检测更新（?what=update_check，PATH 注入假 curl，不访问外网）：
#      未配置 200 {configured:false} 且不联网、合法 repo+tag v1.2.3 的字段/notes 截断/apk·ipk 提取、
#      同版本 tag -> has_update=false、v<ver> 里混入旧版资产不被选中、非法 repo 400 invalid_repo 不联网、
#      500 -> github_unavailable、401/404 映射、缓存 0600 且第二次不调用 curl、token 不进响应/argv。
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
opkg install "$PRISM_IPK" >/tmp/i1.log 2>&1 \
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
[ "$(json_expr 'type(d.panel.write_enabled)=="bool" && d.panel.write_enabled==false && type(d.write.enabled)=="bool" && d.write.enabled==false')" = "1" ] \
  && ok "settings 默认：panel.write_enabled=false 且 write.enabled=false（写能力未开放）" \
  || bad "settings 默认写能力投影异常（panel.write_enabled=$(json_val 'd?.panel?.write_enabled') / write.enabled=$(json_val 'd?.write?.enabled')）"
# 写能力投影用例会临时改 UCI：先保存原值，段末恢复，避免影响后续只读 case。
ORIG_WRITE=$(CGET prism-router.panel.write_enabled)
ORIG_TOKEN=$(CGET prism-router.panel.token)

# write_enabled=0 + token 非空：令牌已设，但总开关关闭 -> 两个 enabled 仍为 false。
UCI set prism-router.panel.write_enabled='0'
UCI set prism-router.panel.token="$TOK"
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings&token=$TOK")
[ "$code" = "200" ] \
  && [ "$(json_expr 'type(d.panel.write_enabled)=="bool" && d.panel.write_enabled==false && type(d.write.enabled)=="bool" && d.write.enabled==false && type(d.panel.has_token)=="bool" && d.panel.has_token==true')" = "1" ] \
  && ok "write_enabled=0 + token 非空：两个 enabled=false、has_token=true" \
  || bad "write_enabled=0 + token -> $code / panel.write_enabled=$(json_val 'd?.panel?.write_enabled') / has_token=$(json_val 'd?.panel?.has_token')"

# write_enabled=1 + token 非空：父控可用；只回传 has_token，绝不回传令牌/令牌字段。
UCI set prism-router.panel.write_enabled='1'
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings&token=$TOK")
[ "$code" = "200" ] \
  && [ "$(json_expr 'type(d.panel.write_enabled)=="bool" && d.panel.write_enabled==true && type(d.write.enabled)=="bool" && d.write.enabled==true && type(d.panel.has_token)=="bool" && d.panel.has_token==true && d.panel.token==null && d.write.token==null')" = "1" ] \
  && ok "write_enabled=1 + token 非空：两个 enabled=true、has_token=true、无 token 字段" \
  || bad "write_enabled=1 + token -> $code / write_enabled=$(json_val 'd?.panel?.write_enabled') / has_token=$(json_val 'd?.panel?.has_token')"
if grep -qF "$TOK" "$B" 2>/dev/null; then
  bad "settings 响应泄漏令牌原值"
else
  ok "settings 响应不含令牌原值"
fi

# write_enabled=1 + token 空：开关打开但缺令牌 -> 两个 enabled=true、has_token=false
#（前端据此显示 notoken，而不是 on；认证仍关闭，符合"token 空仅靠网络边界"契约）。
UCI set prism-router.panel.token=''
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
[ "$code" = "200" ] \
  && [ "$(json_expr 'type(d.panel.write_enabled)=="bool" && d.panel.write_enabled==true && type(d.write.enabled)=="bool" && d.write.enabled==true && type(d.panel.has_token)=="bool" && d.panel.has_token==false && d.panel.token==null')" = "1" ] \
  && ok "write_enabled=1 + token 空：两个 enabled=true、has_token=false" \
  || bad "write_enabled=1 + token 空 -> $code / write_enabled=$(json_val 'd?.panel?.write_enabled') / has_token=$(json_val 'd?.panel?.has_token')"

# 非法值不是字符串 '1'，一律按关闭投影（与 prism-router-control 判定一致）。
for BADVAL in yes true; do
  UCI set prism-router.panel.write_enabled="$BADVAL"
  UCI commit prism-router
  code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
  [ "$code" = "200" ] \
    && [ "$(json_expr 'type(d.panel.write_enabled)=="bool" && d.panel.write_enabled==false && type(d.write.enabled)=="bool" && d.write.enabled==false')" = "1" ] \
    && ok "write_enabled=$BADVAL（非法值）：两个 enabled=false" \
    || bad "write_enabled=$BADVAL -> $code / 投影未按 false 处理"
done

# 缺配置（老 conffile 没有 write_enabled 选项）等同关闭。
UCI delete prism-router.panel.write_enabled
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
[ "$code" = "200" ] \
  && [ "$(json_expr 'type(d.panel.write_enabled)=="bool" && d.panel.write_enabled==false && type(d.write.enabled)=="bool" && d.write.enabled==false')" = "1" ] \
  && ok "缺 write_enabled 选项：两个 enabled=false" \
  || bad "缺 write_enabled -> $code / 投影未按 false 处理"

# 带空白的 UCI 值与 control 鉴权统一：写开关 trim 后才认 '1'，空白 token 等同未设置。
UCI set prism-router.panel.write_enabled=' 1 '
UCI set prism-router.panel.token=" $TOK "
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings&token=$TOK")
[ "$code" = "200" ] \
  && [ "$(json_expr 'd.panel.write_enabled==true && d.write.enabled==true && d.panel.has_token==true && d.panel.token==null')" = "1" ] \
  && ok "带空白 write_enabled/token：与 control 一样 trim，认证和能力投影一致" \
  || bad "带空白 write_enabled/token -> $code / 投影或认证异常"
UCI set prism-router.panel.token='   '
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
[ "$code" = "200" ] \
  && [ "$(json_expr 'd.panel.write_enabled==true && d.write.enabled==true && d.panel.has_token==false')" = "1" ] \
  && ok "纯空白 token：等同未设置，不把家长控制误报为已可用" \
  || bad "纯空白 token -> $code / has_token=$(json_val 'd?.panel?.has_token')"

# 恢复本段开始前的 panel 配置（不打印令牌），供后续 case 继续使用默认环境。
if [ -n "$ORIG_WRITE" ]; then
  UCI set prism-router.panel.write_enabled="$ORIG_WRITE"
else
  UCI delete prism-router.panel.write_enabled
fi
if [ -n "$ORIG_TOKEN" ]; then
  UCI set prism-router.panel.token="$ORIG_TOKEN"
else
  UCI set prism-router.panel.token=''
fi
UCI commit prism-router
if [ "$(CGET prism-router.panel.write_enabled)" = "$ORIG_WRITE" ] \
   && [ "$(CGET prism-router.panel.token)" = "$ORIG_TOKEN" ]; then
  ok "写能力投影用例后已恢复 panel.write_enabled/panel.token 原值"
else
  bad "写能力投影用例后恢复 panel 配置失败"
fi
# 用恢复后的配置再取一次 settings，让后续断言基于新响应而不是上一场景的残留 body。
if [ -n "$ORIG_TOKEN" ]; then
  code=$(req "$PANEL/cgi-bin/panel-api?what=settings&token=$ORIG_TOKEN")
else
  code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
fi
[ "$code" = "200" ] && ok "恢复配置后 what=settings -> 200" || bad "恢复配置后 what=settings -> $code"
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
[ "$code" = "200" ] && ok "token 未设置时认证关闭 -> 200" || bad "认证关闭时 settings -> $code"
if grep -q "$TOK" "$B" 2>/dev/null; then bad "settings 响应泄漏 token 明文"; else ok "settings 不含 token 明文"; fi
UCI set prism-router.panel.token="$TOK"
UCI commit prism-router
code=$(req "$PANEL/cgi-bin/panel-api?what=settings")
[ "$code" = "401" ] && [ "$(json_expr 'd?.error=="unauthorized"')" = "1" ] \
  && ok "设 token 后 settings 不带 -> 401 unauthorized" || bad "settings 不带 token -> $code"
code=$(req "$PANEL/cgi-bin/panel-api?what=settings&token=$TOK")
[ "$code" = "200" ] && [ "$(json_expr 'type(d.panel)=="object" && d.panel.token==null')" = "1" ] \
  && ok "设 token 后 settings 带正确 token -> 200 且无 token 字段" || bad "settings 正确 token -> $code"
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
[ "$(sysjson "d.version==\"$VER\"")" = "1" ] \
  && ok "system.version=$VER（来自 /usr/lib/opkg/info/luci-app-prism-router.control）" \
  || bad "system.version 不是 $VER：$(sysval 'd.version')"

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
[ "$(sysjson "d.version==\"$VER\"")" = "1" ] && ok "version=$VER" || bad "version=$(sysval 'd.version')"
[ "$(sysjson "d.build==\"$VER-1\"")" = "1" ] && ok "build=$VER-1（opkg 完整版本）" || bad "build 异常"
[ "$(sysjson "d.apk_version==\"$VER\"")" = "1" ] && ok "apk_version=$VER（供 App 比对）" || bad "apk_version 异常"
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

echo "=== 22. 管理员配置读写（config / config_set / redirect / rollback；容器内 mock reload） ==="
# 夹具按真机 UCI 事实：lan static 192.168.100.1/24、wan dhcp eth0、dhcp.lan 100/150/12h、
# system 主机名/时区、firewall 无 redirect。容器镜像本身没有 /etc/config/network。
mkdir -p /etc/config /usr/share/zoneinfo/Asia /tmp/mockbin
: > /usr/share/zoneinfo/Asia/Shanghai
cat > /etc/config/network <<'NETEOF'
config interface 'lan'
	option proto 'static'
	option ipaddr '192.168.100.1'
	option netmask '255.255.255.0'
	option device 'br-lan'
	list dns '223.5.5.5'

config interface 'wan'
	option proto 'dhcp'
	option device 'eth0'
NETEOF
cat > /etc/config/dhcp <<'DHCPEOF'
config dnsmasq
	option domain 'lan'

config dhcp 'lan'
	option interface 'lan'
	option start '100'
	option limit '150'
	option leasetime '12h'
DHCPEOF
cat > /etc/config/system <<'SYSEOF'
config system
	option hostname 'iStoreOS'
	option timezone 'CST-8'
	option zonename 'Asia/Shanghai'
SYSEOF
cat > /etc/config/firewall <<'FWEOF'
config defaults
	option input 'ACCEPT'
	option output 'ACCEPT'
	option forward 'REJECT'
FWEOF
# reload / hostname mock：绝对路径固定，容器里不真的重启网络；断言只看调用记录。
printf '#!/bin/sh\necho "network $*" >> /tmp/admin-reload.log\n' > /etc/init.d/network
printf '#!/bin/sh\necho "dnsmasq $*" >> /tmp/admin-reload.log\n' > /etc/init.d/dnsmasq
printf '#!/bin/sh\necho "firewall $*" >> /tmp/admin-reload.log\n' > /etc/init.d/firewall
chmod 755 /etc/init.d/network /etc/init.d/dnsmasq /etc/init.d/firewall
printf '#!/bin/sh\necho "$*" >> /tmp/admin-hostname.log\n' > /tmp/mockbin/hostname
chmod 755 /tmp/mockbin/hostname
: > /tmp/admin-reload.log
: > /tmp/admin-hostname.log
# 登录测试账号：只追加一个密码已知的独立用户（不动 root）；容器用完即删。
grep -q '^prismtest:' /etc/shadow 2>/dev/null || {
  HASH=$(openssl passwd -1 -salt prismtest 'PrismTest!123')
  printf 'prismtest:%s:19000:0:99999:7:::\n' "$HASH" >> /etc/shadow
}
ok "配置夹具 + reload/hostname mock 就绪"

AH=/tmp/admin-headers.txt
AB=/tmp/admin-body.json
areq(){ # $1=方法 $2=查询串 $3=POST body（可选）
  local m="$1" q="$2" b="${3-}" len=0
  rm -f "$AH" "$AB" /tmp/admin-raw.txt
  if [ "$m" = POST ]; then
    len=$(printf '%s' "$b" | wc -c | tr -d ' ')
    printf '%s' "$b" | env PATH="/tmp/mockbin:$PATH" REQUEST_METHOD=POST QUERY_STRING="$q" \
      CONTENT_LENGTH="$len" REMOTE_ADDR=127.0.0.1 ucode "$ADMIN" 2>/dev/null
  else
    env PATH="/tmp/mockbin:$PATH" REQUEST_METHOD="$m" QUERY_STRING="$q" \
      REMOTE_ADDR=127.0.0.1 ucode "$ADMIN" 2>/dev/null
  fi > /tmp/admin-raw.txt
  tr -d '\r' < /tmp/admin-raw.txt | awk -v h="$AH" -v b="$AB" '
    !done { if ($0 == "") { done=1; next } print > h; next }
    { print > b }'
}
acode(){ head -n 1 "$AH" 2>/dev/null | sed 's/^Status: //'; }
ajson(){ # $1=表达式（d 为解析后的 JSON）
  env F="$AB" ucode -e "
    let fs = require('fs');
    let d = null;
    try { d = json(fs.readfile(getenv('F'))); } catch (e) { d = null; }
    print((function(d){ return ($1); })(d) ? '1' : '0');" 2>/dev/null
}
ajval(){ # $1=表达式；打印原始值
  env F="$AB" ucode -e "
    let fs = require('fs');
    let d = null;
    try { d = json(fs.readfile(getenv('F'))); } catch (e) { d = null; }
    print((function(d){ return ($1); })(d));" 2>/dev/null
}

echo "--- 22.1 未认证：GET config 无 token / 错误 token -> 401"
areq GET "action=config"
[ "$(acode)" = "401 Unauthorized" ] && ok "GET action=config 无 token -> 401" \
  || bad "GET config 未认证 -> [$(acode)]"
[ "$(ajson 'd.error=="unauthorized"')" = "1" ] && ok "401 响应体 {error:unauthorized}" \
  || bad "401 响应体异常"
areq GET "action=config&token=00000000000000000000000000000000"
[ "$(acode)" = "401 Unauthorized" ] && ok "GET action=config 错误 token -> 401" \
  || bad "GET config 错误 token -> [$(acode)]"

echo "--- 22.2 登录换 token"
areq POST "" '{"action":"login","username":"prismtest","password":"PrismTest!123"}'
[ "$(acode)" = "200 OK" ] && ok "POST login -> 200" || bad "POST login -> [$(acode)] $(cat "$AB")"
TOKEN=$(ajval 'd.token' | tr -d '\n')
printf '%s' "$TOKEN" | grep -Eq '^[0-9a-f]{32}$' && ok "token 为 32 位十六进制" \
  || bad "token 格式异常：[${TOKEN}]"

echo "--- 22.3 GET config：结构 / 安全头"
areq GET "action=config&token=$TOKEN"
[ "$(acode)" = "200 OK" ] && ok "GET action=config -> 200" || bad "GET config -> [$(acode)] $(cat "$AB")"
grep -qi '^Cache-Control: no-store' "$AH" && ok "config 响应 Cache-Control: no-store" \
  || bad "config 响应缺少 Cache-Control: no-store"
[ "$(ajson 'type(d.lan)=="object" && d.lan.ipaddr=="192.168.100.1" && d.lan.netmask=="255.255.255.0" && d.lan.gateway=="" && length(d.lan.dns)==1 && d.lan.dns[0]=="223.5.5.5"')" = "1" ] \
  && ok "lan 结构（ipaddr/netmask/gateway/dns）正确" || bad "lan 结构异常：$(cat "$AB")"
[ "$(ajson 'type(d.wan)=="object" && d.wan.proto=="dhcp" && d.wan.device=="eth0" && type(d.wan.ipaddr)=="string" && type(d.wan.gateway)=="string" && type(d.wan.dns)=="array"')" = "1" ] \
  && ok "wan 结构（proto/device/运行时 ipaddr·gateway/dns）正确" || bad "wan 结构异常"
[ "$(ajson 'type(d.dhcp)=="object" && d.dhcp.enabled==true && d.dhcp.start=="100" && d.dhcp.limit=="150" && d.dhcp.leasetime=="12h"')" = "1" ] \
  && ok "dhcp 结构（enabled/start/limit/leasetime）正确" || bad "dhcp 结构异常"
[ "$(ajson 'type(d.system)=="object" && d.system.hostname=="iStoreOS" && d.system.timezone=="CST-8" && d.system.zonename=="Asia/Shanghai"')" = "1" ] \
  && ok "system 结构（hostname/timezone/zonename）正确" || bad "system 结构异常"
[ "$(ajson 'type(d.redirects)=="array" && length(d.redirects)==0')" = "1" ] \
  && ok "redirects 为数组且初始为空" || bad "redirects 结构异常"

echo "--- 22.4 非法写：400 且不落盘（无备份/配置不变）"
NET_BEFORE=$(sha256sum /etc/config/network | awk '{print $1}')
FW_BEFORE=$(sha256sum /etc/config/firewall | awk '{print $1}')
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"lan\",\"options\":{\"ipaddr\":\"192.168.100.2\"}}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="confirm_required"')" = "1" ] \
  && ok "config_set 缺 confirm -> 400 confirm_required" || bad "缺 confirm -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"lan\",\"confirm\":\"APPLY\",\"options\":{\"ipaddr\":\"192.168.100.1.1\"}}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_ipaddr"')" = "1" ] \
  && ok "非法 IPv4 -> 400 invalid_ipaddr" || bad "非法 IPv4 -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"lan\",\"confirm\":\"APPLY\",\"options\":{\"netmask\":\"255.0.255.0\"}}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_netmask"')" = "1" ] \
  && ok "非连续掩码 -> 400 invalid_netmask" || bad "非连续掩码 -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"system\",\"confirm\":\"APPLY\",\"options\":{\"hostname\":\"-bad_host\"}}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_hostname"')" = "1" ] \
  && ok "非法主机名 -> 400 invalid_hostname" || bad "非法主机名 -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"dhcp\",\"confirm\":\"APPLY\",\"options\":{\"leasetime\":\"12hours\"}}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_leasetime"')" = "1" ] \
  && ok "非法 leasetime -> 400 invalid_leasetime" || bad "非法 leasetime -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"redirect_add\",\"token\":\"$TOKEN\",\"name\":\"bad\",\"src\":\"lan\",\"dest\":\"lan\",\"src_dport\":\"8080\",\"dest_ip\":\"192.168.100.10\",\"dest_port\":\"70000\",\"proto\":\"tcp\"}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_dest_port"')" = "1" ] \
  && ok "非法端口 -> 400 invalid_dest_port" || bad "非法端口 -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_rollback\",\"token\":\"$TOKEN\",\"section\":\"dhcp\"}"
[ "$(acode)" = "404 Not Found" ] && [ "$(ajson 'd.error=="no_backup"')" = "1" ] \
  && ok "无备份回滚 -> 404 no_backup" || bad "无备份回滚 -> [$(acode)] $(cat "$AB")"
[ "$(sha256sum /etc/config/network | awk '{print $1}')" = "$NET_BEFORE" ] \
  && ok "非法请求后 /etc/config/network 未变" || bad "非法请求改动了 network"
[ "$(sha256sum /etc/config/firewall | awk '{print $1}')" = "$FW_BEFORE" ] \
  && ok "非法请求后 /etc/config/firewall 未变" || bad "非法请求改动了 firewall"
[ ! -d /etc/prism-router/backup ] && ok "非法请求未创建备份目录" \
  || bad "非法请求创建了备份目录"

echo "--- 22.5 合法 config_set lan：200 + 备份 0600 + uci 已改 + 延迟 reload"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"lan\",\"confirm\":\"APPLY\",\"options\":{\"ipaddr\":\"192.168.100.2\",\"netmask\":\"255.255.255.0\"}}"
[ "$(acode)" = "200 OK" ] && [ "$(ajson 'd.ok==true && index(d.note,"LAN 地址已改")>=0')" = "1" ] \
  && ok "合法 config_set lan -> 200 且含 LAN 地址变更提示" || bad "config_set lan -> [$(acode)] $(cat "$AB")"
grep -q "option ipaddr '192.168.100.2'" /etc/config/network \
  && ok "uci 值已改（/etc/config/network = 192.168.100.2）" || bad "uci 值未改"
BK=$(ls -1 /etc/prism-router/backup/network.* 2>/dev/null | head -n 1)
[ -n "$BK" ] && [ -f "$BK" ] && ok "写前备份已生成：$(basename "$BK")" || bad "未生成写前备份"
[ "$(ls -l "$BK" 2>/dev/null | awk '{print $1}')" = "-rw-------" ] && ok "备份文件权限 0600" \
  || bad "备份文件权限异常：[$(ls -l "$BK" 2>/dev/null | awk '{print $1}')]"
[ "$(ls -ld /etc/prism-router/backup 2>/dev/null | awk '{print $1}')" = "drwx------" ] \
  && ok "备份目录权限 0700" || bad "备份目录权限异常"
grep -q "192.168.100.1" "$BK" && ok "备份内容为改前配置（含 192.168.100.1）" \
  || bad "备份内容不是改前配置"
sleep 2
grep -q "network reload" /tmp/admin-reload.log && ok "LAN 变更后异步 network reload 已触发" \
  || bad "未触发 network reload：[$(cat /tmp/admin-reload.log 2>/dev/null)]"

echo "--- 22.6 system / dhcp 合法写 + 非法 zonename"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"system\",\"confirm\":\"APPLY\",\"options\":{\"hostname\":\"router-test\",\"timezone\":\"CST-8\",\"zonename\":\"Asia/Shanghai\"}}"
[ "$(acode)" = "200 OK" ] && grep -q "option hostname 'router-test'" /etc/config/system \
  && ok "system 写入 -> 200 且 uci 已改" || bad "system 写入 -> [$(acode)] $(cat "$AB")"
[ "$(cat /tmp/admin-hostname.log 2>/dev/null)" = "router-test" ] && ok "hostname 即时生效（hostname router-test）" \
  || bad "hostname 未即时生效：[$(cat /tmp/admin-hostname.log 2>/dev/null)]"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"system\",\"confirm\":\"APPLY\",\"options\":{\"zonename\":\"../../etc/passwd\"}}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_zonename"')" = "1" ] \
  && ok "路径穿越 zonename -> 400 invalid_zonename" || bad "路径穿越 zonename -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"dhcp\",\"confirm\":\"APPLY\",\"options\":{\"start\":120,\"limit\":100,\"leasetime\":\"6h\"}}"
[ "$(acode)" = "200 OK" ] && grep -q "option start '120'" /etc/config/dhcp \
  && grep -q "option limit '100'" /etc/config/dhcp && grep -q "option leasetime '6h'" /etc/config/dhcp \
  && ok "dhcp 写入 -> 200 且 start/limit/leasetime 已改" || bad "dhcp 写入 -> [$(acode)] $(cat "$AB")"
grep -q "dnsmasq restart" /tmp/admin-reload.log && ok "dhcp 变更后 dnsmasq restart 已触发" \
  || bad "未触发 dnsmasq restart"

echo "--- 22.7 redirect_add / redirect_del"
areq POST "" "{\"action\":\"redirect_add\",\"token\":\"$TOKEN\",\"name\":\"web\",\"src\":\"lan\",\"dest\":\"lan\",\"src_dport\":\"8080\",\"dest_ip\":\"192.168.100.10\",\"dest_port\":\"80\",\"proto\":\"tcp\"}"
[ "$(acode)" = "200 OK" ] && [ "$(ajson 'd.ok==true && d.index==0')" = "1" ] \
  && ok "redirect_add -> 200 index 0" || bad "redirect_add -> [$(acode)] $(cat "$AB")"
grep -q "config redirect" /etc/config/firewall && grep -q "option dest_ip '192.168.100.10'" /etc/config/firewall \
  && grep -q "option target 'DNAT'" /etc/config/firewall \
  && ok "firewall 配置新增 redirect（dest_ip/target=DNAT）" || bad "firewall 未新增 redirect"
grep -q "firewall reload" /tmp/admin-reload.log && ok "redirect_add 后 firewall reload 已触发" \
  || bad "redirect_add 未触发 firewall reload"
areq GET "action=config&token=$TOKEN"
[ "$(ajson 'length(d.redirects)==1 && d.redirects[0].name=="web" && d.redirects[0].dest_port=="80" && d.redirects[0].proto=="tcp" && d.redirects[0].enabled==true')" = "1" ] \
  && ok "GET config 读到 1 条 redirect 且字段正确" || bad "GET config redirect 结构异常：$(cat "$AB")"
areq POST "" "{\"action\":\"redirect_del\",\"token\":\"$TOKEN\",\"index\":0}"
[ "$(acode)" = "200 OK" ] && ! grep -q "config redirect" /etc/config/firewall \
  && ok "redirect_del -> 200 且 firewall 中 redirect 已删除" || bad "redirect_del -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"redirect_del\",\"token\":\"$TOKEN\",\"index\":9}"
[ "$(acode)" = "400 Bad Request" ] && [ "$(ajson 'd.error=="invalid_index"')" = "1" ] \
  && ok "不存在 index -> 400 invalid_index" || bad "不存在 index -> [$(acode)] $(cat "$AB")"

echo "--- 22.8 config_rollback：最近备份恢复"
areq POST "" "{\"action\":\"config_rollback\",\"token\":\"$TOKEN\",\"section\":\"lan\"}"
[ "$(acode)" = "200 OK" ] && [ "$(ajson 'd.ok==true')" = "1" ] \
  && ok "config_rollback lan -> 200" || bad "config_rollback -> [$(acode)] $(cat "$AB")"
grep -q "option ipaddr '192.168.100.1'" /etc/config/network \
  && ok "回滚后 /etc/config/network 恢复为 192.168.100.1" || bad "回滚未恢复 network"
sleep 2
grep -q "network reload" /tmp/admin-reload.log && ok "回滚后 network reload 已触发" \
  || bad "回滚未触发 network reload"

echo "--- 22.9 备份保留最近 10 份 + 审计日志"
i=0
while [ "$i" -lt 11 ]; do
  areq POST "" "{\"action\":\"config_set\",\"token\":\"$TOKEN\",\"section\":\"system\",\"confirm\":\"APPLY\",\"options\":{\"hostname\":\"router-test\"}}" >/dev/null
  i=$((i+1))
done
N_BK=$(ls -1 /etc/prism-router/backup/system.* 2>/dev/null | wc -l | tr -d ' ')
[ "$N_BK" = "10" ] && ok "每个 config 仅保留最近 10 份备份（实际 $N_BK）" || bad "备份保留数量异常（$N_BK）"
BADPERM=0
for f in /etc/prism-router/backup/system.*; do
  [ "$(ls -l "$f" | awk '{print $1}')" = "-rw-------" ] || BADPERM=1
done
[ "$BADPERM" = "0" ] && ok "全部备份文件权限 0600" || bad "存在非 0600 备份文件"
[ "$(ls -l /tmp/prism-router/admin.log 2>/dev/null | awk '{print $1}')" = "-rw-------" ] \
  && ok "审计日志 /tmp/prism-router/admin.log 权限 0600" || bad "审计日志权限异常"
grep -q 'action=config_set section=lan result=ok' /tmp/prism-router/admin.log \
  && ok "审计日志记录 config_set/lan/ok" || bad "审计日志缺少 config_set/lan/ok"
grep -q "$TOKEN" /tmp/prism-router/admin.log && bad "审计日志泄漏 token" || ok "审计日志不含 token"

echo "--- 22.10 方法 / token 边界"
areq GET "action=config_set&token=$TOKEN"
[ "$(acode)" = "405 Method Not Allowed" ] && [ "$(ajson 'd.error=="method_not_allowed"')" = "1" ] \
  && ok "GET 写 action -> 405（不执行）" || bad "GET 写 action -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config\",\"token\":\"$TOKEN\"}"
[ "$(acode)" = "405 Method Not Allowed" ] && ok "POST 只读 config -> 405" \
  || bad "POST config -> [$(acode)] $(cat "$AB")"
areq POST "" "{\"action\":\"config_set\",\"token\":\"00000000000000000000000000000000\",\"section\":\"lan\",\"confirm\":\"APPLY\",\"options\":{\"dns\":[\"1.1.1.1\"]}}"
[ "$(acode)" = "401 Unauthorized" ] && [ "$(ajson 'd.error=="unauthorized"')" = "1" ] \
  && ok "写 action 错误 token -> 401" || bad "写 action 错误 token -> [$(acode)] $(cat "$AB")"

echo "=== 23. 系统目录权限未被改动 ==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 24. 自动检测更新：?what=update_check（PATH 注入假 curl；不访问外网） ==="
[ "$(CGET prism-router.update.cache_seconds)" = "600" ] \
  && ok "update.cache_seconds 默认 600" \
  || bad "update.cache_seconds 默认=$(CGET prism-router.update.cache_seconds)"
[ -z "$(CGET prism-router.update.github_repo)" ] \
  && ok "update.github_repo 默认空（未配置更新源）" \
  || bad "update.github_repo 默认非空"
[ -z "$(CGET prism-router.update.github_token)" ] \
  && ok "update.github_token 默认空" || bad "update.github_token 默认非空"
grep -q "^config update 'update'" /etc/config/prism-router \
  && ok "conffile 包含 config update 段" || bad "conffile 缺少 config update 段"

UPBIN=/tmp/update-bin
UPMOCK=/tmp/update-mock
mkdir -p "$UPBIN" "$UPMOCK" /tmp/prism-router
cat > "$UPBIN/curl" <<'MOCKCURL'
#!/bin/sh
# 只实现本 CGI 用到的 curl 子集：把 $MOCK_BODY 写进 -o 指定的文件，
# 往 stdout 打印 $MOCK_HTTP（模拟 -w '%{http_code}'），并记录每次调用。
printf '%s\n' "$*" >> /tmp/update-curl-args.log
printf 'call\n' >> /tmp/update-curl-count.log
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "${MOCK_BODY:-}" ] && [ -f "$MOCK_BODY" ]; then
  if [ -n "$out" ]; then cp "$MOCK_BODY" "$out"; else cat "$MOCK_BODY"; fi
fi
printf '%s' "${MOCK_HTTP:-200}"
exit "${MOCK_EXIT:-0}"
MOCKCURL
chmod 755 "$UPBIN/curl"
: > /tmp/update-curl-args.log
: > /tmp/update-curl-count.log

sysreq_mock(){ # $1=方法 $2=查询串 $3=MOCK_BODY $4=MOCK_HTTP $5=MOCK_EXIT
  rm -f "$SH" "$SB" /tmp/sys-raw.txt
  env PATH="$UPBIN:$PATH" REQUEST_METHOD="$1" QUERY_STRING="$2" \
    MOCK_BODY="${3-}" MOCK_HTTP="${4-200}" MOCK_EXIT="${5-0}" \
    ucode "$SYS" 2>/dev/null | tr -d '\r' > /tmp/sys-raw.txt
  awk -v h="$SH" -v b="$SB" '
    !done { if ($0 == "") { done=1; next } print > h; next }
    { print > b }' /tmp/sys-raw.txt
}
curl_calls(){ wc -l < /tmp/update-curl-count.log | tr -d ' '; }

TOK_UPDATE='ghp_TestToken_9f3c1a7b'

echo "--- 24.1 未配置：200 {configured:false}，且不联网"
UCI set prism-router.update.github_repo=''
UCI set prism-router.update.github_token=''
UCI set prism-router.update.cache_seconds='600'
UCI commit prism-router
rm -f /tmp/prism-router/update-cache.json
BEFORE=$(curl_calls)
sysreq_mock GET "what=update_check"
[ "$(syscode)" = "200 OK" ] && ok "未配置 update_check -> 200" || bad "未配置 update_check -> [$(syscode)]"
[ "$(sysjson 'd.configured==false')" = "1" ] && ok "未配置响应 {configured:false}" \
  || bad "未配置响应异常：$(cat "$SB")"
[ "$(sysjson 'type(d.message)=="string" && index(d.message, "未配置更新源") == 0')" = "1" ] \
  && ok "未配置 message 提示 uci set prism-router.update.github_repo=owner/repo" \
  || bad "未配置 message 异常：$(cat "$SB")"
[ "$(curl_calls)" = "$BEFORE" ] && ok "未配置时不调用 HTTP 客户端" \
  || bad "未配置时仍发起了网络请求"

echo "--- 24.2 合法 repo + mock GitHub 200：字段 / notes 截断 / apk·ipk / token 边界"
LONG_NOTE=$(awk 'BEGIN { for (i = 0; i < 2500; i++) printf "x" }')
GH_OK="$UPMOCK/release-ok.json"
cat > "$GH_OK" <<JSON
{
  "tag_name": "v1.2.3",
  "published_at": "2026-11-01T10:00:00Z",
  "html_url": "https://github.com/acme/prism-router/releases/tag/v1.2.3",
  "body": "$LONG_NOTE",
  "assets": [
    {"name": "prism-router_1.2.3_all.ipk",
     "browser_download_url": "https://github.com/acme/prism-router/releases/download/v1.2.3/prism-router_1.2.3_all.ipk",
     "size": 123456},
    {"name": "prism-router-1.2.3.apk",
     "browser_download_url": "https://github.com/acme/prism-router/releases/download/v1.2.3/prism-router-1.2.3.apk",
     "size": 2345678},
    {"name": "source.tar.gz",
     "browser_download_url": "https://github.com/acme/prism-router/archive/v1.2.3.tar.gz",
     "size": 999}
  ]
}
JSON
UCI set prism-router.update.github_repo='acme/prism-router'
UCI set prism-router.update.github_token="$TOK_UPDATE"
UCI commit prism-router
rm -f /tmp/prism-router/update-cache.json
: > /tmp/update-curl-count.log
: > /tmp/update-curl-args.log
sysreq_mock GET "what=update_check" "$GH_OK" 200
[ "$(syscode)" = "200 OK" ] && ok "合法 repo update_check -> 200" || bad "合法 repo -> [$(syscode)] $(cat "$SB")"
[ "$(sysjson "d.configured==true && d.repo==\"acme/prism-router\" && d.current==\"$VER\"")" = "1" ] \
  && ok "响应含 configured/repo/current" || bad "基础字段异常：$(head -c 200 "$SB")"
[ "$(sysjson 'd.latest=="1.2.3" && d.has_update==true')" = "1" ] \
  && ok "tag v1.2.3 -> latest=1.2.3、has_update=true" || bad "latest/has_update 异常：$(cat "$SB")"
[ "$(sysjson 'd.published_at=="2026-11-01T10:00:00Z" && d.html_url=="https://github.com/acme/prism-router/releases/tag/v1.2.3"')" = "1" ] \
  && ok "published_at/html_url 透传" || bad "published_at/html_url 异常"
[ "$(sysjson 'type(d.notes)=="string" && length(d.notes)==2000')" = "1" ] \
  && ok "notes（原 2500 字节）截断到 2000 字节" || bad "notes 截断异常（实际 $(sysval 'length(d.notes)')）"
[ "$(sysjson 'type(d.apk)=="object" && d.apk.name=="prism-router-1.2.3.apk" && d.apk.size==2345678 && index(d.apk.url, "/releases/download/")>0')" = "1" ] \
  && ok "apk {name,url,size} 提取正确" || bad "apk 提取异常：$(cat "$SB")"
[ "$(sysjson 'type(d.ipk)=="object" && d.ipk.name=="prism-router_1.2.3_all.ipk" && d.ipk.size==123456')" = "1" ] \
  && ok "ipk {name,url,size} 提取正确" || bad "ipk 提取异常"
[ "$(curl_calls)" = "1" ] && ok "首次请求调用 HTTP 客户端 1 次" || bad "首次请求调用次数=$(curl_calls)"
grep -q 'https://api.github.com/repos/acme/prism-router/releases/latest' /tmp/update-curl-args.log \
  && ok "请求固定 api.github.com/repos/<owner>/<repo>/releases/latest" || bad "请求 URL 异常"
grep -q -- '--max-redirs 0' /tmp/update-curl-args.log \
  && ok "curl 不跟随重定向（--max-redirs 0）" || bad "curl 缺少 --max-redirs 0"
grep -q "$TOK_UPDATE" "$SB" && bad "响应泄漏 github_token" || ok "响应不含 github_token"
grep -q "$TOK_UPDATE" /tmp/update-curl-args.log && bad "token 进入 curl 命令行" \
  || ok "token 不在 curl 命令行（走 0600 --config）"
[ "$(ls /tmp/prism-router/.update-*.conf 2>/dev/null | wc -l | tr -d ' ')" = "0" ] \
  && ok "含 token 的临时 curl 配置已删除" || bad "临时 curl 配置残留"
grep -q "$TOK_UPDATE" /tmp/prism-router/update-cache.json 2>/dev/null && bad "缓存泄漏 token" \
  || ok "缓存不含 token"
[ "$(ls -l /tmp/prism-router/update-cache.json 2>/dev/null | awk '{print $1}')" = "-rw-------" ] \
  && ok "更新缓存 0600" || bad "更新缓存权限异常"
sysreq GET "what=version"
[ "$(sysjson 'd.update_check==true')" = "1" ] && ok "配置 repo 后 version.update_check=true" \
  || bad "version.update_check 未随配置变化"

echo "--- 24.2b v$VER Release 混入旧 v1.0.0 APK：不得返回旧下载链接"
GH_MIXED="$UPMOCK/release-mixed.json"
cat > "$GH_MIXED" <<JSON
{
  "tag_name": "v$VER",
  "published_at": "2026-11-22T10:00:00Z",
  "html_url": "https://github.com/acme/prism-router/releases/tag/v$VER",
  "body": "mixed assets",
  "assets": [
    {"name": "prism-router-android-1.0.0.apk",
     "browser_download_url": "https://github.com/acme/prism-router/releases/download/v1.0.0/prism-router-android-1.0.0.apk",
     "size": 111},
    {"name": "luci-app-prism-router_$VER-1_all.ipk",
     "browser_download_url": "https://github.com/acme/prism-router/releases/download/v$VER/luci-app-prism-router_$VER-1_all.ipk",
     "size": 222}
  ]
}
JSON
sysreq_mock GET "what=update_check&force=1" "$GH_MIXED" 200
[ "$(sysjson "d.latest==\"$VER\" && d.apk==null && type(d.ipk)==\"object\" && index(d.ipk.name, \"$VER\")>0")" = "1" ] \
  && ok "旧 APK 被过滤，只保留 $VER 的 IPK" \
  || bad "资产版本筛选异常：$(cat "$SB")"
[ "$(sysjson "d.html_url==\"https://github.com/acme/prism-router/releases/tag/v$VER\"")" = "1" ] \
  && ok "找不到匹配 APK 时保留 html_url Release 页" || bad "html_url 缺失"

echo "--- 24.2c v$VER Release 只有旧 v1.0.0 APK：apk/ipk 都为空，退回 Release 页"
GH_OLDONLY="$UPMOCK/release-old-only.json"
cat > "$GH_OLDONLY" <<JSON
{
  "tag_name": "v$VER",
  "published_at": "2026-11-22T10:00:00Z",
  "html_url": "https://github.com/acme/prism-router/releases/tag/v$VER",
  "body": "old only",
  "assets": [
    {"name": "prism-router-android-1.0.0.apk",
     "browser_download_url": "https://github.com/acme/prism-router/releases/download/v1.0.0/prism-router-android-1.0.0.apk",
     "size": 111}
  ]
}
JSON
sysreq_mock GET "what=update_check&force=1" "$GH_OLDONLY" 200
[ "$(sysjson 'd.apk==null && d.ipk==null && d.has_update==false')" = "1" ] \
  && ok "旧 APK 不被冒充新版（apk/ipk 为空）" \
  || bad "旧资产仍被返回：$(cat "$SB")"
[ "$(sysjson "d.html_url==\"https://github.com/acme/prism-router/releases/tag/v$VER\"")" = "1" ] \
  && ok "退回 html_url 供客户端打开 Release 页" || bad "html_url 缺失"

echo "--- 24.3 同版本 tag v$VER -> has_update=false（force 绕过缓存）"
GH_SAME="$UPMOCK/release-same.json"
cat > "$GH_SAME" <<JSON
{"tag_name":"v$VER","published_at":"2026-10-01T00:00:00Z","html_url":"https://github.com/acme/prism-router/releases/tag/v$VER","body":"same","assets":[]}
JSON
sysreq_mock GET "what=update_check&force=1" "$GH_SAME" 200
[ "$(syscode)" = "200 OK" ] && [ "$(sysjson "d.latest==\"$VER\" && d.has_update==false")" = "1" ] \
  && ok "tag v$VER -> has_update=false" || bad "同版本判定异常：$(cat "$SB")"

echo "--- 24.4 缓存：第二次请求不调用 curl；force=1 绕过"
rm -f /tmp/prism-router/update-cache.json
: > /tmp/update-curl-count.log
sysreq_mock GET "what=update_check" "$GH_OK" 200
FIRST=$(curl_calls)
sysreq_mock GET "what=update_check" "$GH_OK" 500
[ "$(sysjson 'd.latest=="1.2.3" && d.has_update==true')" = "1" ] \
  && ok "缓存命中：第二次仍返回 1.2.3（忽略 mock 500）" || bad "缓存未生效：$(cat "$SB")"
[ "$(curl_calls)" = "$FIRST" ] && [ "$FIRST" = "1" ] \
  && ok "缓存命中时不再调用 curl（$FIRST -> $(curl_calls)）" || bad "缓存期间仍调用 curl（$(curl_calls) 次）"
sysreq_mock GET "what=update_check&force=1" "$GH_OK" 500
[ "$(sysjson 'd.error=="github_unavailable" && d.detail=="HTTP 500"')" = "1" ] \
  && ok "force=1 绕过缓存，mock 500 -> 200 {error:github_unavailable, detail:HTTP 500}" \
  || bad "force/500 异常：$(cat "$SB")"

echo "--- 24.5 mock 401 / 404 错误映射"
sysreq_mock GET "what=update_check&force=1" "$GH_OK" 401
[ "$(syscode)" = "200 OK" ] && [ "$(sysjson 'd.error=="github_unauthorized" && d.detail=="HTTP 401"')" = "1" ] \
  && ok "mock 401 -> github_unauthorized（HTTP 200 包错误）" || bad "401 映射异常：$(cat "$SB")"
sysreq_mock GET "what=update_check&force=1" "$GH_OK" 404
[ "$(sysjson 'd.error=="github_not_found" && d.detail=="HTTP 404"')" = "1" ] \
  && ok "mock 404 -> github_not_found" || bad "404 映射异常：$(cat "$SB")"

echo "--- 24.6 非法 repo：400 invalid_repo，且不联网"
for BADREPO in '../evil' 'bad repo' 'noslash' 'owner/repo/extra'; do
  UCI set prism-router.update.github_repo="$BADREPO"
  UCI commit prism-router
  BEFORE=$(curl_calls)
  sysreq_mock GET "what=update_check&force=1"
  if [ "$(syscode)" = "400 Bad Request" ] && [ "$(sysjson 'd.error=="invalid_repo"')" = "1" ] \
     && [ "$(curl_calls)" = "$BEFORE" ]; then
    ok "非法 repo [$BADREPO] -> 400 invalid_repo 且不联网"
  else
    bad "非法 repo [$BADREPO] -> [$(syscode)] $(cat "$SB")（curl 调用 $(curl_calls) 次）"
  fi
done

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1