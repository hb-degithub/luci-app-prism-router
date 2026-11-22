#!/bin/sh
# 飞书长连接（feishu-ws.py + 随包 lark-oapi + rpcd feishu_ws_status）容器内用例。
# 由 tests/container-validate-feishu-ws.sh 调用；--network none，一次性容器。
#
# 覆盖：
#   1. 安装（依赖校验：非 python3 严格，python3-* 见 NOTE）
#   2. 在位文件与权限：feishu-ws.py / init.d / pylib 整树
#   3. 默认配置 ws_enabled=0 + 长连接默认不启动
#   4. feishu_ws_status 摘要：未运行 / 运行中 / 心跳过期 / 坏 JSON / 超量裁剪 /
#      日志尾部脱敏 / 绝不泄露 secret
#   5. set_config 白名单接受 ws_enabled（UI 保存路径）
#   6. init 脚本：未启用、缺凭据时正常返回且不产生 pid；stop 幂等
#
# 容器里没有 python3（镜像只有 ucode/busybox），所以这里不做 import lark_oapi；
# 真实 import 在真机验证（见 docs/FEISHU-WS.md「真机验证」）。
. /src/tests/lib/prism-version-inner.sh

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3（期望[$1] 实际[$2]）"; }

PKG=/usr/share/prism-router/feishu-ws.py
INIT=/etc/init.d/prism-router-feishu-ws
PYLIB=/usr/lib/prism-router/pylib
CFG=/etc/config/prism-router
RPCD=/usr/share/rpcd/ucode/prism-router.uc
STATE=/etc/prism-router/feishu-ws.json
STATUS=/tmp/prism-router/feishu-ws.status.json
PIDF=/tmp/prism-router/feishu-ws.pid
LOGF=/tmp/prism-router/feishu-ws.log
WORK=/tmp/ws-gate
rm -rf "$WORK"; mkdir -p "$WORK" /tmp/prism-router

ws_status() { # 调用 rpcd 方法（调试入口），输出 JSON
	PRISM_ROUTER_METHOD=feishu_ws_status ucode "$RPCD" 2>"$WORK/err"
}

echo "=== 1. 安装 prism-router（依赖校验见 NOTE）==="
opkg_install_ipk "$PRISM_IPK" >/tmp/ws-install.log 2>&1 \
	&& ok "安装成功" || { bad "安装失败"; tail -10 /tmp/ws-install.log; }

echo "=== 2. 在位文件 / 权限 / 结构 ==="
for pair in \
	"$PKG:root:root -rwxr-xr-x" \
	"$INIT:root:root -rwxr-xr-x" \
	"$PYLIB:root:root drwxr-xr-x" \
	"$PYLIB/MANIFEST.json:root:root -rw-r--r--" \
	"$PYLIB/lark_oapi/__init__.py:root:root -rw-r--r--" \
	"$PYLIB/lark_oapi/ws/client.py:root:root -rw-r--r--" \
	"$PYLIB/lark_oapi/event/dispatcher_handler.py:root:root -rw-r--r--" \
	"$PYLIB/lark_oapi/api/im/v1/processor.py:root:root -rw-r--r--" \
	"$PYLIB/Crypto/Cipher/AES.py:root:root -rw-r--r--" \
	"$PYLIB/Crypto/Cipher/_raw_aes.abi3.so:root:root -rw-r--r--" \
	"$PYLIB/websockets/__init__.py:root:root -rw-r--r--" \
	"$PYLIB/requests/__init__.py:root:root -rw-r--r--"; do
	f="${pair%%:*}"; want="${pair#*:}"
	got=$(ls -ld "$f" 2>/dev/null | awk '{print $3":"$4" "$1}')
	[ "$got" = "$want" ] && ok "$f -> $got" || bad "$f 期望[$want] 实际[${got:-不存在}]"
done

pylib_files=$(find "$PYLIB" -type f | wc -l)
pylib_kb=$(du -sk "$PYLIB" | awk '{print $1}')
[ "$pylib_files" -ge 500 ] && ok "pylib 文件数 $pylib_files" || bad "pylib 文件数异常 $pylib_files"
[ "$pylib_kb" -lt 25600 ] && ok "pylib 占用 ${pylib_kb}KB（<25MB 目标）" || bad "pylib ${pylib_kb}KB 超 25MB"
so_count=$(find "$PYLIB" -name '*.so' | wc -l)
[ "$so_count" -ge 3 ] && ok "pylib 保留 $so_count 个 musl 原生扩展" || bad "原生扩展缺失（$so_count）"
if find "$PYLIB" \( -name '__pycache__' -o -name '*.pyc' -o -name '*.dist-info' \) -print -quit | grep -q .; then
	bad "pylib 含 __pycache__/*.pyc/dist-info"
else
	ok "pylib 不含 __pycache__/*.pyc/dist-info"
fi
for bad_path in lark_oapi/client.py lark_oapi/core/http/transport.py lark_oapi/api/contact; do
	[ -e "$PYLIB/$bad_path" ] && bad "pylib 残留未分发内容 $bad_path" || ok "pylib 已裁掉 $bad_path"
done
grep -q '"arch": "x86_64"' "$PYLIB/MANIFEST.json" && ok "MANIFEST 声明 x86_64/musl" || bad "MANIFEST 目标架构不对"

echo "=== 3. 默认配置：长连接默认关闭 ==="
grep -qE "option[[:space:]]+ws_enabled[[:space:]]+'0'" "$CFG" \
	&& ok "默认 ws_enabled=0" || bad "默认 ws_enabled 不是 0"
grep -q "ws_enabled" "$RPCD" && ok "rpcd 白名单包含 ws_enabled" || bad "rpcd 白名单缺 ws_enabled"
for acl in /usr/share/rpcd/acl.d/luci-app-prism-router.json; do
	ucode -e "let d=json(require('fs').readfile('$acl')); exit(index(d['luci-app-prism-router'].read.ubus['prism-router'], 'feishu_ws_status') >= 0 ? 0 : 1)" 2>/dev/null \
		&& ok "ACL 允许 feishu_ws_status（只读面板）" || bad "ACL 未放行 feishu_ws_status"
	ucode -e "let d=json(require('fs').readfile('$acl')); exit(index(d['luci-app-prism-router-admin'].read.ubus['prism-router'], 'feishu_ws_status') >= 0 ? 0 : 1)" 2>/dev/null \
		&& ok "ACL 允许 feishu_ws_status（管理员）" || bad "管理员 ACL 未放行 feishu_ws_status"
done

echo "=== 4. feishu_ws_status：未运行基线 ==="
rm -f "$STATE" "$STATUS" "$PIDF" "$LOGF"
ws_status > "$WORK/out.json" || bad "feishu_ws_status 调用失败（$(cat "$WORK/err")）"
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); exit((d.ok==true && d.running==false && d.ws_enabled==false && length(d.chats)==0 && length(d.users)==0 && length(d.log_tail)==0 && length(d.reasons)>0) ? 0 : 1)" \
	&& ok "未启用/未运行：ok、running=false、空清单、带原因" || { bad "未运行基线结构异常"; cat "$WORK/out.json"; }
if grep -qiE 'app_secret|"secret"|Bearer ' "$WORK/out.json"; then
	bad "feishu_ws_status 泄露 secret"
else
	ok "feishu_ws_status 未泄露 secret"
fi

echo "=== 5. feishu_ws_status：运行中 / 心跳过期 / 坏 JSON / 裁剪 ==="
# 用真实存活的进程当“服务进程”：sleep 在 PID 文件里，状态文件心跳是新的。
sleep 120 & SLEEP_PID=$!
now=$(date +%s)
cat > "$PIDF" <<EOF
$SLEEP_PID
EOF
cat > "$STATUS" <<EOF
{"version":1,"pid":$SLEEP_PID,"service_version":"1.0.0","started_at":$((now-30)),"updated_at":$now,"connected":true,"last_event_ts":$((now-5)),"last_event_type":"im.message.receive_v1","events_seen":7,"chats":1,"users":1,"last_error":""}
EOF
cat > "$STATE" <<'EOF'
{"version":1,"updated_at":1699999999,"last_event_ts":1699999900,"last_event_type":"im.chat.member.bot.added_v1","events_seen":7,
 "chats":[{"chat_id":"oc_gate_a","name":"门禁群 A","first_seen":1699999000,"last_seen":1699999900},
          {"chat_id":"oc_gate_b","name":"门禁群 B","first_seen":1699999000,"last_seen":1699999800}],
 "users":[{"open_id":"ou_gate_a","user_id":"u_gate_a","name":"甲","first_seen":1699999000,"last_seen":1699999900},
          {"open_id":"ou_gate_b","user_id":"","name":"乙","first_seen":1699999000,"last_seen":1699999800}]}
EOF
printf '2026-11-22T22:00:00 INFO  长连接已建立\n2026-11-22T22:00:01 INFO  app_secret=SUPERSECRET_DO_NOT_LEAK\n' > "$LOGF"
chmod 600 "$STATE"; chmod 644 "$STATUS" "$PIDF"; chmod 640 "$LOGF"

ws_status > "$WORK/out.json" || bad "运行中状态调用失败"
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); exit((d.running==true && d.connected==true && d.pid==$SLEEP_PID && length(d.chats)==2 && length(d.users)==2 && d.chats[0].chat_id=='oc_gate_a' && d.users[0].open_id=='ou_gate_a' && d.last_event_type=='im.message.receive_v1') ? 0 : 1)" \
	&& ok "运行中：running/connected/pid/群/用户/最近事件都正确" || { bad "运行中摘要异常"; cat "$WORK/out.json"; }
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); let joined=join('', d.log_tail); exit((length(d.log_tail)==2 && match(joined, /SUPERSECRET/) == null && match(joined, /\*\*\*/) != null) ? 0 : 1)" \
	&& ok "日志尾部脱敏（secret 被打码）" || { bad "日志尾部未脱敏"; cat "$WORK/out.json"; }

# 心跳过期 -> 不算 running（服务卡死/被 SIGKILL）
stale=$((now-600))
sed -i "s/\"updated_at\":$now/\"updated_at\":$stale/" "$STATUS"
ws_status > "$WORK/out.json"
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); exit((d.running==false && d.heartbeat_age>=600) ? 0 : 1)" \
	&& ok "心跳过期 -> running=false（heartbeat_age 暴露给 UI）" || bad "心跳过期仍被判 running"

# pid 不存在 -> 不算 running
cat > "$STATUS" <<EOF
{"version":1,"pid":999999,"updated_at":$now,"connected":true,"last_event_ts":0,"events_seen":0}
EOF
printf '999999\n' > "$PIDF"
ws_status > "$WORK/out.json"
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); exit(d.running==false ? 0 : 1)" \
	&& ok "PID 不存在 -> running=false" || bad "死 PID 仍被判 running"

# 坏 JSON / 超量：不能崩，且裁剪到 50/20
printf '{ this is not json' > "$STATE"
printf '{ broken' > "$STATUS"
printf 'not-a-pid' > "$PIDF"
ws_status > "$WORK/out.json"
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); exit((d.ok==true && d.running==false && length(d.chats)==0 && length(d.users)==0) ? 0 : 1)" \
	&& ok "坏 JSON/PID -> 返回空摘要且不崩" || { bad "坏 JSON 处理异常"; cat "$WORK/out.json"; }

ucode -e '
let chats=[], users=[];
for (let i=0;i<80;i++) push(chats, {chat_id:sprintf("oc_%03d",i), name:"群"+i, last_seen:1699999000+i});
for (let i=0;i<40;i++) push(users, {open_id:sprintf("ou_%03d",i), user_id:"", name:"用户"+i, last_seen:1699999000+i});
require("fs").writefile("/tmp/ws-gate/state-big.json", sprintf("%J", {version:1, chats: chats, users: users}));
' >/dev/null 2>&1
cp "$WORK/state-big.json" "$STATE"
printf '{"version":1,"pid":%s,"updated_at":%s,"connected":true}\n' "$SLEEP_PID" "$(date +%s)" > "$STATUS"
printf '%s\n' "$SLEEP_PID" > "$PIDF"
ws_status > "$WORK/out.json"
ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); exit((length(d.chats)==50 && length(d.users)==20) ? 0 : 1)" \
	&& ok "超量清单裁剪到 50 群 / 20 用户" || { bad "超量裁剪异常（chats=$(ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); print(length(d.chats))") users=$(ucode -e "let d=json(require('fs').readfile('$WORK/out.json')); print(length(d.users))")）"; }

kill "$SLEEP_PID" 2>/dev/null
rm -f "$STATE" "$STATUS" "$PIDF" "$LOGF"

echo "=== 6. set_config 白名单接受 ws_enabled ==="
# 调试入口用 root 身份；section=feishu、option=ws_enabled 必须在白名单里。
PRISM_ROUTER_METHOD=set_config \
PRISM_ROUTER_ARGS='{"section":"feishu","options":"{\"ws_enabled\":\"1\"}"}' \
	ucode "$RPCD" > "$WORK/set.json" 2>"$WORK/set.err"
ucode -e "let d=json(require('fs').readfile('$WORK/set.json')); exit(d.ok==true ? 0 : 1)" \
	&& ok "set_config(feishu.ws_enabled=1) 返回 ok" || { bad "set_config 拒绝 ws_enabled"; cat "$WORK/set.json" "$WORK/set.err"; }
eq "1" "$(uci -q get prism-router.feishu.ws_enabled)" "ws_enabled 已落盘为 1"
PRISM_ROUTER_METHOD=set_config \
PRISM_ROUTER_ARGS='{"section":"feishu","options":"{\"ws_enabled\":\"0\"}"}' \
	ucode "$RPCD" >/dev/null 2>&1

echo "=== 7. init 脚本：未启用 / 缺凭据时不启动 ==="
uci -q set prism-router.feishu.ws_enabled='0'
uci -q commit prism-router
rm -f "$PIDF" "$STATUS"
"$INIT" start >/dev/null 2>&1; rc=$?
eq "0" "$rc" "ws_enabled=0 时 start 返回 0（不报错）"
[ -e "$PIDF" ] && bad "ws_enabled=0 却写了 pid" || ok "ws_enabled=0 不产生 pid"

uci -q set prism-router.feishu.ws_enabled='1'
uci -q set prism-router.feishu.app_id=''
uci -q set prism-router.feishu.app_secret=''
uci -q commit prism-router
"$INIT" start >/dev/null 2>&1; rc=$?
eq "0" "$rc" "缺凭据时 start 返回 0"
[ -e "$PIDF" ] && bad "缺凭据却写了 pid" || ok "缺凭据不产生 pid"

# 有凭据但容器没有 python3：init 会因 /usr/bin/python3 不存在而跳过，仍然不产生 pid。
uci -q set prism-router.feishu.app_id='cli_gate_dummy'
uci -q set prism-router.feishu.app_secret='gate-dummy-secret-not-real'
uci -q commit prism-router
"$INIT" start >/dev/null 2>&1; rc=$?
eq "0" "$rc" "有凭据但无 python3 时 start 返回 0"
[ -e "$PIDF" ] && bad "无 python3 却写了 pid" || ok "无 python3 不产生 pid"
"$INIT" stop >/dev/null 2>&1; eq "0" "$?" "stop 幂等返回 0"
uci -q set prism-router.feishu.app_id=''
uci -q set prism-router.feishu.app_secret=''
uci -q set prism-router.feishu.ws_enabled='0'
uci -q commit prism-router

echo "=== 8. 服务脚本 --version / --check（无 python3 时只验证不崩溃）==="
if command -v python3 >/dev/null 2>&1; then
	"$PKG" --version >/dev/null 2>&1 && ok "feishu-ws.py --version" || bad "feishu-ws.py --version 失败"
	"$PKG" --selftest >/dev/null 2>&1 && ok "feishu-ws.py --selftest" || bad "feishu-ws.py --selftest 失败"
else
	echo "  SKIP  容器没有 python3：--version/--selftest 在真机验证"
fi

echo
echo "=== 飞书长连接结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
