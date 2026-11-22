#!/bin/sh
. /src/tests/lib/prism-version-inner.sh
# AP「绑定 + 上报 + 控制」用例（容器内执行；由 tests/container-validate-ap.sh 调用）
#
# 覆盖：
#   1. 两个包装上后 /etc /usr /www /www/cgi-bin 权限不变；新文件落位/属主/权限
#   2. ap-agent.sh 语法 + 自检 + 与 openssl 对拍 HMAC；ingest / rpcd ucode 语法
#   3. ACL 放行 ap_list / ap_bind_start / ap_rename / ap_delete / ap_cmd；config 默认 ap_offline_min=10
#   4. ap_bind_start：32 hex 令牌、url/cmd、令牌文件只存 hash（0600）、明文不进 /etc、上限 8 个
#   5. 首报（真跑 ap-agent.sh + 假 iw）：绑定自动完成、令牌被消费、registry/快照落盘且无字节字段
#   6. ap_list（debug 入口 + ubus root 会话）：在线/终端数/平均信号，且不含 token/hash
#   7. 重命名、命令入队 0600、poll 取走、refresh 执行并回执 ok、reboot 回执后执行
#   8. 负例：签名错 / 时间戳超差 / 未知 node / 错 token / 非法 node_id / 非 POST / 令牌超上限
#   9. ap_delete：registry + 快照 + 队列一起删；重报变 401；未绑定快照可 rename/delete
#  10. 限速：同 IP 每分钟 > 120 次 → 429 + Retry-After
#  11. ap-agent.sh --install：配置 0600、crontab 去重、stdout/日志不含 token
#
# 隔离：只在 127.0.0.1 上跑，不访问外网、不接触任何真机。
mkdir -p /var/run/ubus /var/lock /tmp /www/cgi-bin /tmp/fakebin /etc/prism-router/stations

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }

AP_AGENT=/usr/share/prism-router/ap-agent.sh
INGEST=/www/cgi-bin/prism-router-ingest
RPCD=/usr/share/rpcd/ucode/prism-router.uc
REG=/etc/prism-router/ap-registry.json
STDIR=/etc/prism-router/stations
BINDDIR=/etc/prism-router/ap-bind
CMDDIR=/etc/prism-router/ap-cmd
BASE=http://127.0.0.1:8080
POST_URL="$BASE/cgi-bin/prism-router-ingest"

rpc(){ # $1=method $2=args json → stdout JSON
	PRISM_ROUTER_METHOD="$1" PRISM_ROUTER_ARGS="$2" \
		ucode -L /usr/lib/ucode "$RPCD"
}

# 从 JSON 文件取表达式（d = 解析结果；表达式里不要出现引号，避免 shell 嵌套）
jexpr(){
	F="$1" ucode -e "
		let fs = require('fs');
		let raw = fs.readfile(getenv('F')) ?? '';
		let d = null;
		try { d = json(raw); } catch (e) { d = null; }
		if (d == null) { print('nojson'); exit(0); }
		print(($2));"
}

# AP 通道签名：$1=action $2=node_id $3=ts $4=body $5=token
sign_for(){
	_digest=$(printf '%s' "$4" | sha256sum | sed 's/ .*//')
	_msg=$(printf 'PRISM-AP1\n%s\n%s\n%s\n%s' "$1" "$2" "$3" "$_digest")
	"$AP_AGENT" --hmac "$5" "$_msg"
}

ap_post(){ # $1=node_id $2=ts $3=token $4=body $5=out
	_auth="PrismAP token=$3;ts=$2;sign=$(sign_for ap_report "$1" "$2" "$4" "$3")"
	curl -sS -m 5 -o "$5" -w '%{http_code}' -X POST "$POST_URL?action=ap_report" \
		-H "Authorization: $_auth" -H 'Content-Type: application/json' \
		--data-binary "$4"
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=${B_CGI:-无}"

echo "=== 1. 安装单包插件 ==="
opkg_install_ipk "$PRISM_IPK" >/tmp/ap-i1.log 2>&1 \
  && ok "luci-app-prism-router 安装成功" || { bad "安装失败"; tail -8 /tmp/ap-i1.log; }

echo "=== 2. 系统目录权限未被改动（回归核心）==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin 2>/dev/null)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 3. 新文件落位 / 权限 / 语法 ==="
check "$AP_AGENT" "root:root -rwxr-xr-x"
check /www/prism-router "root:root drwxr-xr-x"
check /www/prism-router/ap-agent.sh "root:root -rw-r--r--"
check "$INGEST" "root:root -rwxr-xr-x"
check "$RPCD" "root:root -rw-r--r--"
check /etc/config/prism-router "root:root -rw-r--r--"
sh -n "$AP_AGENT" && ok "ap-agent.sh POSIX sh 语法 OK" || bad "ap-agent.sh 语法错误"
OUT=$("$AP_AGENT" --selftest 2>&1)
[ "$OUT" = "selftest OK" ] && ok "ap-agent.sh --selftest 通过" || bad "selftest：$OUT"

# 与 openssl 对拍（agent 的纯 shell HMAC 必须和标准实现一致）
A=$("$AP_AGENT" --hmac '0123456789abcdef0123456789abcdef' 'PRISM-AP1 test')
B=$(printf '%s' 'PRISM-AP1 test' | openssl dgst -sha256 -hmac '0123456789abcdef0123456789abcdef' | sed 's/^.*= //')
[ -n "$A" ] && [ "$A" = "$B" ] && ok "纯 shell HMAC == openssl ($A)" || bad "HMAC 不一致：sh=$A openssl=$B"

ucode -c "$INGEST" && ok "ingest ucode 语法 OK" || bad "ingest 语法错误"
ucode -c "$RPCD" && ok "rpcd ucode 语法 OK" || bad "rpcd 语法错误"
for f in /www/luci-static/resources/view/prism-router/nodes.js /www/luci-static/resources/view/prism-router/settings.js; do
  [ -f "$f" ] && ok "存在 $f" || bad "缺少 $f"
done
grep -q 'ap_list' /www/luci-static/resources/view/prism-router/nodes.js \
  && ok "nodes.js 已包含 AP 管理区块（ap_list）" || bad "nodes.js 缺少 AP 管理"
grep -q '生成绑定命令' /www/luci-static/resources/view/prism-router/nodes.js \
  && ok "nodes.js 含「生成绑定命令」" || bad "nodes.js 缺少绑定入口"
grep -q 'ap_offline_min' /www/luci-static/resources/view/prism-router/settings.js \
  && ok "settings.js 含 ap_offline_min" || bad "settings.js 缺少 ap_offline_min"

echo "=== 4. ACL / 默认配置 / 版本常量 ==="
ACL=/usr/share/rpcd/acl.d/luci-app-prism-router.json
ucode -e "json(require('fs').readfile('$ACL'))" >/dev/null 2>&1 && ok "ACL JSON 合法" || bad "ACL JSON 非法"
for m in ap_list ap_bind_start ap_rename ap_delete ap_cmd; do
  grep -q "\"$m\"" "$ACL" && ok "ACL 放行 $m" || bad "ACL 缺少 $m"
done
grep -qE "option[[:space:]]+ap_offline_min[[:space:]]+'10'" /etc/config/prism-router \
  && ok "config 默认 ap_offline_min=10" || bad "config 缺少 ap_offline_min=10"
for f in /usr/bin/prism-routerd /www/cgi-bin/prism-router-metrics /www/cgi-bin/prism-router-feishu "$RPCD"; do
  grep -q "'$PRISM_VER'" "$f" && ok "版本常量 $PRISM_VER：$f" || bad "版本常量未同步：$f"
done

echo "=== 5. 起 uhttpd / ubusd / rpcd ==="
/sbin/ubusd -s /var/run/ubus/ubus.sock >/tmp/ap-ubusd.log 2>&1 &
sleep 1
/sbin/rpcd -s /var/run/ubus/ubus.sock >/tmp/ap-rpcd.log 2>&1 &
sleep 1
/usr/sbin/uhttpd -f -p 127.0.0.1:8080 -h /www -x /cgi-bin -u /ubus >/tmp/ap-uhttpd.log 2>&1 &
i=0
while [ $i -lt 20 ]; do
  curl -s -o /dev/null -m 1 "$BASE/" && break
  i=$((i+1)); sleep 1
done
[ $i -lt 20 ] && ok "uhttpd 就绪 (127.0.0.1:8080)" || { bad "uhttpd 未就绪"; cat /tmp/ap-uhttpd.log; }

echo "=== 6. 假 iw / 假 reboot ==="
cat > /tmp/fakebin/iw <<'IW'
#!/bin/sh
if [ "$1" = "dev" ] && [ -z "$2" ]; then
	printf 'phy#0\n'
	printf '\tInterface phy0.0-ap1\n\t\tifindex 22\n\t\tssid OpenWrt-2G\n\t\ttype AP\n'
	printf '\tInterface phy0.1-ap0\n\t\tifindex 23\n\t\tssid OpenWrt-5G\n\t\ttype AP\n'
	printf '\tInterface br-lan\n\t\tifindex 1\n\t\ttype AP/VLAN\n'
	exit 0
fi
if [ "$1" != "dev" ] || [ "$3" != "station" ] || [ "$4" != "dump" ]; then
	exit 1
fi
case "$2" in
phy0.1-ap0)
	cat <<EOF
Station 22:77:08:69:a9:1f (on phy0.1-ap0)
	signal:  	-53 [-57, -55] dBm
	signal avg:	-55 [-58, -56] dBm
	tx bitrate:	650.0 MBit/s VHT-MCS 7 80MHz short GI VHT-NSS 2
	rx bitrate:	866.6 MBit/s VHT-MCS 9 80MHz short GI VHT-NSS 2
	connected time:	3600 seconds
	rx bytes:	9999999999
	tx bytes:	8888888888

Station dc:56:7b:89:fb:31 (on phy0.1-ap0)
	signal:  	-72 dBm
	rx bitrate:	unknown
	connected time:	125 seconds
EOF
	;;
phy0.0-ap1)
	cat <<EOF
Station aa:bb:cc:dd:ee:ff (on phy0.0-ap1)
	signal:  	5 dBm
	tx bitrate:	1.5 MBit/s MCS 0
	connected time:	9 seconds
EOF
	;;
*) exit 0 ;;
esac
IW
chmod 755 /tmp/fakebin/iw
printf '#!/bin/sh\necho reboot-called >> /tmp/reboot-called\n' > /tmp/fakebin/reboot
chmod 755 /tmp/fakebin/reboot
ok "假 iw / 假 reboot 已就位"

AGENT_ENV="PRISM_ROUTER_AP_LOG=/tmp/ap-agent.log PRISM_ROUTER_AP_LOCK=/tmp/ap-agent.lock PRISM_ROUTER_AP_IW=/tmp/fakebin/iw"
run_agent(){ # $1=token $2=node_id
	env $AGENT_ENV "$AP_AGENT" --url "$POST_URL" --token "$1" --node-id "$2" --once
}

echo "=== 7. ap_bind_start（debug 入口）：32 hex / url / cmd / 只存 hash ==="
rpc ap_bind_start '{"name":"客厅 AP","node_id":"ap-1","host":"127.0.0.1:8080"}' > /tmp/ap-bind.json 2>/tmp/ap-bind.err
[ "$(jexpr /tmp/ap-bind.json 'd.ok')" = "true" ] && ok "bind_start ok=true" || { bad "bind_start 失败"; cat /tmp/ap-bind.err; head -c 300 /tmp/ap-bind.json; }
TOKEN=$(jexpr /tmp/ap-bind.json 'd.token')
[ ${#TOKEN} -eq 32 ] && ok "token 是 32 hex" || bad "token 长度=${#TOKEN}"
case "$TOKEN" in *[!0-9a-f]*) bad "token 含非 hex 字符";; *) ok "token 只含小写 hex";; esac
[ "$(jexpr /tmp/ap-bind.json 'd.url')" = "$POST_URL" ] && ok "url=$POST_URL" || bad "url 不符"
CMD=$(jexpr /tmp/ap-bind.json 'd.cmd')
case "$CMD" in *"$POST_URL"*) ok "cmd 含 ingest 地址";; *) bad "cmd 不含 ingest 地址";; esac
case "$CMD" in *"$TOKEN"*) ok "cmd 含 token（一次性展示）";; *) bad "cmd 不含 token";; esac
case "$CMD" in *--install) ok "cmd 以 --install 结尾";; *) bad "cmd 缺少 --install";; esac
case "$CMD" in *ap-agent.sh*) ok "cmd 含 ap-agent.sh 下载";; *) bad "cmd 缺少 ap-agent.sh";; esac
HASH=$(printf '%s' "$TOKEN" | sha256sum | sed 's/ .*//')
check "$BINDDIR" "root:root drwx------"
check "$BINDDIR/$HASH.json" "root:root -rw-------"
jexpr "$BINDDIR/$HASH.json" 'd.token_hash' > /tmp/ap-hash.txt
[ "$(cat /tmp/ap-hash.txt)" = "$HASH" ] && ok "令牌文件名 = sha256(token)，内容也是 hash" || bad "令牌 hash 不符"
grep -rq "$TOKEN" /etc/prism-router && bad "token 明文落盘（违反只存 hash）" || ok "token 明文未落盘"
[ "$(jexpr /tmp/ap-bind.json 'd.expires_in')" = "600" ] && ok "有效期 600 秒" || bad "有效期不是 600"

echo "=== 7.1 负例：host 非法 / 待用令牌上限 8 ==="
rpc ap_bind_start '{"name":"x","host":"bad host/../x"}' > /tmp/ap-badhost.json
[ "$(jexpr /tmp/ap-badhost.json 'd.ok')" = "false" ] && ok "非法 host 被拒" || bad "非法 host 未被拒"
i=0
while [ $i -lt 7 ]; do
  rpc ap_bind_start '{"name":"fill","host":"127.0.0.1:8080"}' >/tmp/ap-fill.json 2>/dev/null
  jexpr /tmp/ap-fill.json 'd.ok' | grep -q true || bad "第 $((i+2)) 个待用令牌生成失败"
  i=$((i+1))
done
rpc ap_bind_start '{"name":"too-many","host":"127.0.0.1:8080"}' > /tmp/ap-ninth.json
[ "$(jexpr /tmp/ap-ninth.json 'd.ok')" = "false" ] && ok "第 9 个待用令牌被拒（上限 8）" || bad "上限 8 未生效"
grep -q '8' /tmp/ap-ninth.json && ok "错误信息提到上限" || bad "错误信息不够清楚"
# 只保留 ap-1 的那个令牌，后续用例从干净状态开始
for f in "$BINDDIR"/*.json; do
  [ "$(basename "$f")" = "$HASH.json" ] || rm -f "$f"
done
ok "清理：只保留 ap-1 的待用令牌"

echo "=== 8. 首报：绑定自动完成 + 令牌消费 + 快照/registry ==="
run_agent "$TOKEN" ap-1 >/tmp/ap-first.out 2>&1
RC=$?
[ "$RC" = "0" ] && ok "ap-agent.sh 首报 exit 0" || { bad "首报 rc=$RC"; cat /tmp/ap-first.out; }
[ -f "$STDIR/ap-1.json" ] && ok "站点快照 /etc/prism-router/stations/ap-1.json" || bad "快照未落盘"
check "$STDIR" "root:root drwxr-xr-x"
check "$STDIR/ap-1.json" "root:root -rw-r--r--"
check "$REG" "root:root -rw-------"
[ ! -f "$BINDDIR/$HASH.json" ] && ok "一次性令牌已消费（文件删除）" || bad "令牌文件仍在"
grep -q "$TOKEN" "$REG" && bad "registry 里出现 token 明文" || ok "registry 只存 token_hash"
grep -q "\"token_hash\":\"$HASH\"" "$REG" && ok "registry token_hash 正确" || bad "registry token_hash 不符"
grep -q '"name":"客厅 AP"' "$REG" && ok "registry 使用绑定备注名" || bad "registry 名称不符"
[ "$(jexpr "$REG" 'd.aps')" != "nojson" ] && ok "registry JSON 可解析" || bad "registry JSON 坏了"

R=$(jexpr "$STDIR/ap-1.json" 'd.count')
[ "$R" = "3" ] && ok "3 个站点落盘（同 MAC 去重后）" || bad "站点数=$R"
[ "$(jexpr "$STDIR/ap-1.json" 'd.node_id')" = "ap-1" ] && ok "快照 node_id=ap-1" || bad "快照 node_id 错"
jexpr "$STDIR/ap-1.json" 'd.stations[1].signal' > /tmp/ap-sig.txt
SIG=$(cat /tmp/ap-sig.txt)
[ "$SIG" = "-53" ] && ok "signal=-53 落盘" || bad "signal=$SIG"
jexpr "$STDIR/ap-1.json" 'd.stations[1].rx_rate' > /tmp/ap-rx.txt
[ "$(cat /tmp/ap-rx.txt)" = "866600" ] && ok "rx_rate=866600 kbit/s（866.6 MBit/s 换算）" || bad "rx_rate=$(cat /tmp/ap-rx.txt)"
grep -q 'bytes' "$STDIR/ap-1.json" && bad "快照出现 bytes（违反只报元数据）" || ok "快照没有 bytes 字段"
jexpr "$STDIR/ap-1.json" 'd.stations[0].signal == null' > /tmp/ap-sig0.txt
[ "$(cat /tmp/ap-sig0.txt)" = "true" ] && ok "母节点丢弃越界 signal（5 dBm 不落盘）" \
  || bad "越界 signal 被写入：$(cat /tmp/ap-sig0.txt)"

echo "=== 9. ap_list：在线 / 终端数 / 平均信号 / 不泄露 token ==="
rpc ap_list '{}' > /tmp/ap-list.json 2>/tmp/ap-list.err
[ "$(jexpr /tmp/ap-list.json 'length(d.aps)')" = "1" ] && ok "ap_list 返回 1 台 AP" || bad "ap_list 数量不符（$(cat /tmp/ap-list.err)）"
[ "$(jexpr /tmp/ap-list.json 'd.aps[0].node_id')" = "ap-1" ] && ok "node_id=ap-1" || bad "node_id 错"
[ "$(jexpr /tmp/ap-list.json 'd.aps[0].online')" = "true" ] && ok "online=true（刚上报）" || bad "online 不是 true"
[ "$(jexpr /tmp/ap-list.json 'd.aps[0].stations')" = "3" ] && ok "stations=3" || bad "stations 不符"
AVG=$(jexpr /tmp/ap-list.json 'd.aps[0].avg_signal')
case "$AVG" in ''|nojson|*[!0-9-]*) bad "avg_signal=$AVG";; *) ok "avg_signal=$AVG（-53/-72 平均）";; esac
[ "$(jexpr /tmp/ap-list.json 'd.offline_min')" = "10" ] && ok "offline_min=10（config 默认）" || bad "offline_min 不符"
[ "$(jexpr /tmp/ap-list.json 'd.aps[0].controllable')" = "true" ] && ok "controllable=true" || bad "controllable 不是 true"
grep -qi 'token' /tmp/ap-list.json && bad "ap_list 泄露 token/hash" || ok "ap_list 不含 token/token_hash"
# ubus root 会话（ACL 读）
LOGIN=$(curl -sS -m 5 -X POST "$BASE/ubus" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"root","password":""}]}')
SID=$(echo "$LOGIN" | sed -n 's/.*"ubus_rpc_session":"\([0-9a-f]\{32\}\)".*/\1/p')
if [ -n "$SID" ]; then
  UA=$(curl -sS -m 5 -X POST "$BASE/ubus" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"$SID\",\"prism-router\",\"ap_list\",{}]}")
  case "$UA" in
    *"Access denied"*) bad "ap_list 被 ACL 拒绝";;
    *'"aps"'*) ok "root 会话可调用 ap_list（ACL 正确）";;
    *) bad "ap_list 返回异常：$(echo "$UA" | head -c 160)";;
  esac
else
  bad "session.login 失败，跳过 ubus ACL 用例"
fi

echo "=== 10. 重命名 ==="
rpc ap_rename '{"node_id":"ap-1","name":"客厅 AP 5G"}' > /tmp/ap-ren.json
[ "$(jexpr /tmp/ap-ren.json 'd.ok')" = "true" ] && ok "ap_rename ok" || bad "ap_rename 失败"
grep -q '"name":"客厅 AP 5G"' "$REG" && ok "registry 名称已更新" || bad "registry 未更新"
rpc ap_list '{}' > /tmp/ap-list2.json
[ "$(jexpr /tmp/ap-list2.json 'd.aps[0].name')" = "客厅 AP 5G" ] && ok "ap_list 显示新名称" || bad "ap_list 名称未更新"
rpc ap_rename '{"node_id":"ap-1","name":""}' > /tmp/ap-ren2.json
[ "$(jexpr /tmp/ap-ren2.json 'd.ok')" = "false" ] && ok "空名字被拒" || bad "空名字未被拒"

echo "=== 11. 命令入队 → poll → refresh → result ==="
rpc ap_cmd '{"node_id":"ap-1","cmd":"refresh"}' > /tmp/ap-cmd.json
[ "$(jexpr /tmp/ap-cmd.json 'd.ok')" = "true" ] && ok "refresh 入队 ok" || bad "refresh 入队失败"
check "$CMDDIR" "root:root drwx------"
check "$CMDDIR/ap-1.json" "root:root -rw-------"
[ "$(jexpr "$CMDDIR/ap-1.json" 'd.cmds[0].cmd')" = "refresh" ] && ok "队列里是 refresh" || bad "队列内容错"
grep -q '"last_cmd_result":"queued"' "$REG" && ok "registry 标记 queued" || bad "registry 未标记 queued"
run_agent "$TOKEN" ap-1 >/tmp/ap-refresh.out 2>&1
RC=$?
[ "$RC" = "0" ] && ok "第二轮上报+轮询 exit 0" || { bad "第二轮 rc=$RC"; cat /tmp/ap-refresh.out; }
[ -z "$(ls -A "$CMDDIR" 2>/dev/null)" ] && ok "命令取走后队列已清空" || bad "命令队列未清空"
RES=$(grep -o '"last_cmd_result":"[^"]*"' "$REG" | head -1)
case "$RES" in *'"last_cmd_result":"ok'*) ok "refresh 回执写回 registry（$RES）";; *) bad "回执未写回：$RES";; esac
case "$RES" in *refresh*) ok "回执带 refresh 明细";; *) bad "回执缺少 refresh：$RES";; esac

echo "=== 12. reboot：先回执再执行（假 reboot）==="
rpc ap_cmd '{"node_id":"ap-1","cmd":"reboot"}' > /tmp/ap-cmd2.json
[ "$(jexpr /tmp/ap-cmd2.json 'd.ok')" = "true" ] && ok "reboot 入队 ok" || bad "reboot 入队失败"
PATH=/tmp/fakebin:$PATH
export PATH
run_agent "$TOKEN" ap-1 >/tmp/ap-reboot.out 2>&1
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
sleep 3
[ -f /tmp/reboot-called ] && ok "reboot 已执行（假 reboot 被调用）" || { bad "reboot 未执行"; cat /tmp/ap-reboot.out; }
grep -q '"last_cmd":"reboot"' "$REG" && ok "registry last_cmd=reboot" || bad "registry last_cmd 不是 reboot"
grep -o '"last_cmd_result":"[^"]*"' "$REG" | grep -q '"ok' && ok "reboot 回执 ok" || bad "reboot 回执不是 ok"

echo "=== 13. 负例：命令白名单 / 未绑定 ==="
rpc ap_cmd '{"node_id":"ap-1","cmd":"shutdown"}' > /tmp/ap-cmd3.json
[ "$(jexpr /tmp/ap-cmd3.json 'd.ok')" = "false" ] && ok "非白名单命令被拒" || bad "shutdown 未被拒"
rpc ap_cmd '{"node_id":"ap-9","cmd":"refresh"}' > /tmp/ap-cmd4.json
[ "$(jexpr /tmp/ap-cmd4.json 'd.ok')" = "false" ] && ok "未绑定的 node 不能下发命令" || bad "未绑定 node 被接受"

echo "=== 14. 负例：AP 通道鉴权（401/400/405）==="
TS=$(date +%s)
BODY='{"v":1,"node_id":"ap-1","name":"ap-1","ts":'"$TS"',"stations":[{"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-50}]}'
CODE=$(ap_post ap-1 "$TS" "$TOKEN" "$BODY" /tmp/ap-ok.json)
[ "$CODE" = "200" ] && grep -q '"ok":true' /tmp/ap-ok.json && ok "合法签名 → 200" || bad "合法签名 → $CODE $(head -c 120 /tmp/ap-ok.json)"

SIGN_OK=$(sign_for ap_report ap-1 "$TS" "$BODY" "$TOKEN")
SIGN_BAD=$(sign_for ap_report ap-1 "$TS" "$BODY tampered" "$TOKEN")
CODE=$(curl -sS -m 5 -o /tmp/ap-bad1.json -w '%{http_code}' -X POST "$POST_URL?action=ap_report" \
  -H "Authorization: PrismAP token=$TOKEN;ts=$TS;sign=$SIGN_BAD" -H 'Content-Type: application/json' --data-binary "$BODY")
[ "$CODE" = "401" ] && ok "签名错误 → 401" || bad "签名错误 → $CODE"
grep -q '"code":401' /tmp/ap-bad1.json && ok "401 返回体 code=401" || bad "401 返回体异常"

TS_OLD=$((TS - 400))
SIGN_OLD=$(sign_for ap_report ap-1 "$TS_OLD" "$BODY" "$TOKEN")
CODE=$(curl -sS -m 5 -o /tmp/ap-bad2.json -w '%{http_code}' -X POST "$POST_URL?action=ap_report" \
  -H "Authorization: PrismAP token=$TOKEN;ts=$TS_OLD;sign=$SIGN_OLD" -H 'Content-Type: application/json' --data-binary "$BODY")
[ "$CODE" = "401" ] && ok "时间戳超差 → 401" || bad "时间戳超差 → $CODE"

CODE=$(ap_post ap-9 "$TS" "$TOKEN" "$BODY" /tmp/ap-bad3.json)
[ "$CODE" = "401" ] && ok "未知 node → 401" || bad "未知 node → $CODE"

TOKEN2=ffffffffffffffffffffffffffffffff
CODE=$(ap_post ap-1 "$TS" "$TOKEN2" "$BODY" /tmp/ap-bad4.json)
[ "$CODE" = "401" ] && ok "错 token → 401" || bad "错 token → $CODE"

CODE=$(curl -sS -m 5 -o /tmp/ap-bad5.json -w '%{http_code}' -X POST "$POST_URL?action=ap_report&node_id=..%2Fetc" \
  -H "Authorization: PrismAP token=$TOKEN;ts=$TS;sign=$SIGN_OK" -H 'Content-Type: application/json' --data-binary "$BODY")
[ "$CODE" = "400" ] && ok "非法 node_id → 400" || bad "非法 node_id → $CODE"

CODE=$(curl -sS -m 5 -o /tmp/ap-bad6.json -w '%{http_code}' "$POST_URL?action=ap_report&node_id=ap-1")
[ "$CODE" = "405" ] && ok "ap_report 非 POST → 405" || bad "ap_report 非 POST → $CODE"

echo "=== 14.5 重新绑定（重装 AP）：新一次性令牌接管已绑定 node ==="
rpc ap_bind_start '{"name":"客厅 AP 新","node_id":"ap-1","host":"127.0.0.1:8080"}' > /tmp/ap-rebind.json
TOKEN2=$(jexpr /tmp/ap-rebind.json 'd.token')
HASH2=$(printf '%s' "$TOKEN2" | sha256sum | sed 's/ .*//')
TS2=$(date +%s)
BODY2='{"v":1,"node_id":"ap-1","name":"ap-1","ts":'"$TS2"',"stations":[{"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-45}]}'
CODE=$(ap_post ap-1 "$TS2" "$TOKEN2" "$BODY2" /tmp/ap-rebind2.json)
[ "$CODE" = "200" ] && ok "新令牌首报 → 200（重新绑定）" || bad "重新绑定 → $CODE（$(head -c 100 /tmp/ap-rebind2.json)）"
grep -q "\"token_hash\":\"$HASH2\"" "$REG" && ok "registry token_hash 已替换" || bad "token_hash 未替换"
[ ! -f "$BINDDIR/$HASH2.json" ] && ok "重新绑定令牌已消费" || bad "重新绑定令牌仍在"
grep -q "客厅 AP 新" "$REG" && ok "重新绑定使用新备注名" || bad "备注名未更新"
CODE=$(ap_post ap-1 "$TS2" "$TOKEN" "$BODY2" /tmp/ap-oldtoken.json)
[ "$CODE" = "401" ] && ok "旧 token 立即失效 → 401" || bad "旧 token 仍可用 → $CODE"
TOKEN="$TOKEN2"
rpc ap_bind_start '{"name":"wrong-node","node_id":"ap-2","host":"127.0.0.1:8080"}' > /tmp/ap-claim.json
TOKEN3=$(jexpr /tmp/ap-claim.json 'd.token')
CODE=$(ap_post ap-1 "$TS2" "$TOKEN3" "$BODY2" /tmp/ap-claim2.json)
[ "$CODE" = "401" ] && ok "令牌声明 ap-2 却用于 ap-1 → 401" || bad "跨 node 绑定被接受 → $CODE"

echo "=== 15. ap-agent.sh --install（配置 0600 / cron / 不打印 token）==="
rm -rf /tmp/apconf /tmp/apcron.txt /tmp/ap-install.log
OUT=$(PRISM_ROUTER_AP_CONF=/tmp/apconf/agent.conf \
      PRISM_ROUTER_AP_CRONTAB=/tmp/apcron.txt \
      PRISM_ROUTER_AP_LOG=/tmp/ap-install.log \
      PRISM_ROUTER_AP_LOCK=/tmp/ap-install.lock \
      PRISM_ROUTER_AP_IW=/tmp/fakebin/iw \
      "$AP_AGENT" --url "$POST_URL" --token "$TOKEN" --node-id ap-1 --install 2>&1)
RC=$?
[ "$RC" = "0" ] && ok "--install exit 0" || { bad "--install rc=$RC"; echo "$OUT" | tail -3; }
check /tmp/apconf "root:root drwx------"
check /tmp/apconf/agent.conf "root:root -rw-------"
grep -q "^url=$POST_URL$" /tmp/apconf/agent.conf && ok "配置里有 url" || bad "配置缺 url"
grep -q "^token=$TOKEN$" /tmp/apconf/agent.conf && ok "配置里有 token（0600，AP 自己的凭证）" || bad "配置缺 token"
grep -q 'ap-agent.sh' /tmp/apcron.txt && ok "crontab 已写入" || bad "crontab 未写入"
grep -c 'ap-agent.sh' /tmp/apcron.txt | grep -qx 1 && ok "crontab 只写一条（去重）" || bad "crontab 重复"
echo "$OUT" | grep -q "$TOKEN" && bad "--install 的 stdout 打印了 token" || ok "--install stdout 不含 token"
[ -f /tmp/ap-install.log ] && { grep -q "$TOKEN" /tmp/ap-install.log && bad "日志含 token" || ok "日志不含 token"; } \
  || ok "没有日志文件（未写 /tmp 也可接受）"

echo "=== 16. ap_delete：registry + 快照 + 队列一起删 ==="
rpc ap_cmd '{"node_id":"ap-1","cmd":"refresh"}' >/dev/null
rpc ap_delete '{"node_id":"ap-1"}' > /tmp/ap-del.json
[ "$(jexpr /tmp/ap-del.json 'd.ok')" = "true" ] && ok "ap_delete ok" || bad "ap_delete 失败"
[ -f "$STDIR/ap-1.json" ] && bad "站点快照未删除" || ok "站点快照已删除"
[ -f "$CMDDIR/ap-1.json" ] && bad "命令队列未删除" || ok "命令队列已删除"
grep -q '"ap-1"' "$REG" && bad "registry 仍含 ap-1" || ok "registry 已移除 ap-1"
rpc ap_list '{}' > /tmp/ap-list3.json
[ "$(jexpr /tmp/ap-list3.json 'length(d.aps)')" = "0" ] && ok "ap_list 变空" || bad "ap_list 仍有条目"
CODE=$(ap_post ap-1 "$TS" "$TOKEN" "$BODY" /tmp/ap-after-del.json)
[ "$CODE" = "401" ] && ok "删除后旧 token 上报 → 401（未绑定）" || bad "删除后旧 token → $CODE"

echo "=== 17. 未绑定快照：列表 / 重命名 / 删除（接管旧 ap-1 数据）==="
printf '{"v":1,"node_id":"ap-9","name":"旧 AP","ts":%s,"count":2,"stations":[{"mac":"aa:bb:cc:dd:ee:01","iface":"phy0.1-ap0","signal":-60},{"mac":"aa:bb:cc:dd:ee:02","iface":"phy0.1-ap0","signal":-70}]}\n' "$(date +%s)" > "$STDIR/ap-9.json"
rpc ap_list '{}' > /tmp/ap-list4.json
[ "$(jexpr /tmp/ap-list4.json 'length(d.aps)')" = "1" ] && ok "未绑定快照出现在列表" || bad "未绑定快照未出现"
[ "$(jexpr /tmp/ap-list4.json 'd.aps[0].managed')" = "false" ] && ok "managed=false" || bad "managed 不是 false"
[ "$(jexpr /tmp/ap-list4.json 'd.aps[0].controllable')" = "false" ] && ok "controllable=false（不能控制）" || bad "controllable 不是 false"
rpc ap_rename '{"node_id":"ap-9","name":"旧 AP 改名"}' > /tmp/ap-ren3.json
[ "$(jexpr /tmp/ap-ren3.json 'd.ok')" = "true" ] && ok "未绑定快照可重命名" || bad "未绑定快照重命名失败"
grep -q '"name":"旧 AP 改名"' "$STDIR/ap-9.json" && ok "快照 name 已更新" || bad "快照 name 未更新"
rpc ap_delete '{"node_id":"ap-9"}' > /tmp/ap-del2.json
[ "$(jexpr /tmp/ap-del2.json 'd.ok')" = "true" ] && ok "未绑定快照可删除" || bad "未绑定快照删除失败"
[ -f "$STDIR/ap-9.json" ] && bad "ap-9.json 残留" || ok "ap-9.json 已删除"

echo "=== 18. 限速：同 IP 每分钟 > 120 次 → 429 ==="
GOT429=0; RETRY=0; i=0
while [ $i -lt 260 ]; do
  CODE=$(curl -sS -m 5 -o /dev/null -D /tmp/ap-rl-hdr.txt -w '%{http_code}' \
    "$POST_URL?action=ap_poll&node_id=ap-1" \
    -H "Authorization: PrismAP token=0123456789abcdef0123456789abcdef;ts=$(date +%s);sign=0000000000000000000000000000000000000000000000000000000000000000")
  if [ "$CODE" = "429" ]; then
    GOT429=1
    grep -qi '^Retry-After: 60' /tmp/ap-rl-hdr.txt && RETRY=1
  fi
  i=$((i+1))
done
[ "$GOT429" = "1" ] && ok "超过 120 次/分钟 → 429" || bad "未触发限速（130 次都没 429）"
[ "$RETRY" = "1" ] && ok "429 带 Retry-After: 60" || bad "429 缺少 Retry-After"

echo "=== 19. 收尾：文件权限 ==="
check "$BINDDIR" "root:root drwx------"
check "$CMDDIR" "root:root drwx------"
check "$REG" "root:root -rw-------"
check "$STDIR" "root:root drwxr-xr-x"

echo "=== AP 门禁结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
