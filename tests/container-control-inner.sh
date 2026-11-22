#!/bin/sh
. /src/tests/lib/prism-version-inner.sh
# 家长控制写操作用例（容器内执行；由 tests/container-validate-control.sh 调用）
#
# 覆盖 docs/SPEC.md §12 的契约：
#   1. 落位/权限/语法：CGI 755 root:root、ucode -c、init sh -n、config 默认 write_enabled=0
#   2. 开关：默认 0 → 403 write_disabled；老配置（无该选项）同样按 0 处理；GET/HEAD → 405
#   3. 令牌：token 为空 / 缺失 / 错误 → 403 forbidden；body.token 与 Bearer 两条路径都能用
#   4. pause：nft 收到固定 argv（MAC 大写、comment 带引号）；重复 pause → already 且不加规则
#   5. resume：从 `-a list chain` 输出解析 handle 并 delete rule；无规则 → already
#   6. list：从内核现查（不读 paused.json），返回 {mac,handle}
#   7. 保护目标：br-lan / 全零 / 广播 / 多播 → 400 且**一次 nft 都不调**
#   8. 非法输入：MAC/action/JSON/超大 body/无 body/错 Content-Type/错 Content-Length → 400
#   9. nft 失败 → 500 nft_failed，响应不包含 nft 原文
#  10. 持久化：paused.json 0600、内容正确、无临时残留；apply 模式重放（幂等）
#  11. 审计：control.log 0600、格式正确、不含 token、最多 200 行
#  12. 安全：任何情况下都不出现 flush / ruleset / UA3F；nft 只碰 inet fw4 forward
#  13. 卸载：CGI/init 随包移除，系统目录权限不变
#
# 隔离：不访问网络、不接触真机；nft 是 PATH 注入的假脚本，只记录 argv。
# 说明：这里直接以 CGI 环境变量调用 ucode（uhttpd 对 CGI 的 PATH 固定为
# /sbin:/usr/sbin:/bin:/usr/bin，无法注入假 nft），因此用标准 CGI 环境精确控制
# 每一种请求；HTTP 层状态码透传由其他门禁覆盖。
mkdir -p /var/lock /var/run /tmp /tmp/fakebin

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }

NFTLOG=/tmp/nft.log
NFTLIST=/tmp/nft-listing.txt
NFTFAIL=/tmp/nft-fail
BRLAN=/tmp/brlan-address
CGI=/www/cgi-bin/prism-router-control
TOKEN='ctl-gate-token-7f3a'
BR_MAC='60:be:b4:04:32:ad'
MAC1='AA:BB:CC:DD:EE:FF'
MAC2='02:00:00:00:00:01'
MAC3='02:00:00:00:00:02'
MAC_IDLE='DE:AD:BE:EF:00:01'

reset_nft(){ : > "$NFTLOG"; : > "$NFTLIST"; rm -f "$NFTFAIL"; }
reset_state(){ rm -f /etc/prism-router/paused.json /etc/prism-router/control.log; }
nft_calls(){ awk 'END{print NR+0}' "$NFTLOG" 2>/dev/null; }
count_prefix(){ awk -v p="$1" 'index($0,p)==1{n++} END{print n+0}' "$NFTLOG" 2>/dev/null; }
list_rule(){ # $1=MAC $2=handle
  printf '\t\tether saddr %s counter packets 0 bytes 0 drop comment "prism-pause-%s" # handle %s\n' \
    "$1" "$1" "$2" >> "$NFTLIST"
}

cat > /tmp/inspect.uc <<'UC'
import { readfile } from 'fs';
let raw = readfile(getenv('F')) ?? '';
let body = '';
for (let line in split(raw, '\n'))
	if (length(line))
		body = line;
let d = null;
try { d = json(body); } catch (e) { d = null; }
print(d == null ? 'nojson' : sprintf('%J', d));
UC
inspect(){ F="$1" ucode /tmp/inspect.uc 2>/dev/null; }
status_of(){ local s; s=$(sed -n 's/^Status: \([0-9][0-9][0-9]\).*/\1/p' "$1" | head -n1)
  [ -n "$s" ] && printf '%s' "$s" || printf '200'; }
expect_status(){ local desc="$1" file="$2" want="$3" got
  got=$(status_of "$file")
  [ "$got" = "$want" ] && ok "$desc → HTTP $got" \
    || bad "$desc → HTTP $got（期望 $want；$(head -c 160 "$file" 2>/dev/null | tr '\n' ' ')）"; }
expect_err(){ local desc="$1" file="$2" want="$3" got needle
  got=$(inspect "$file"); needle="\"error\": \"$want\""
  case "$got" in *"$needle"*) ok "$desc → $want";; *) bad "$desc → $got（期望 error=$want）";; esac; }
has_json(){ inspect "$1" | grep -qF "$2"; }
audit_lines(){ wc -l < /etc/prism-router/control.log 2>/dev/null || echo 0; }

# 用标准 CGI 环境调用（不经过 uhttpd，便于精确构造边界请求）。
run_cgi(){ # $1=out $2=method $3=content_length $4=body [$5=auth] [$6=ctype]
	out="$1"; method="$2"; clen="$3"; body="$4"; auth="${5:-}"; ctype="${6:-application/json}"
	printf '%s' "$body" | env REQUEST_METHOD="$method" CONTENT_LENGTH="$clen" \
		CONTENT_TYPE="$ctype" HTTP_AUTHORIZATION="$auth" \
		PRISM_ROUTER_BRLAN_ADDR="$BRLAN" \
		PATH=/tmp/fakebin:/usr/sbin:/usr/bin:/sbin:/bin \
		ucode "$CGI" > "$out" 2>>/tmp/cgi.stderr
}
call(){ local body="${3:-}"; run_cgi "$1" "$2" "${#body}" "$body" "${4:-}" "${5:-application/json}"; }

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=${B_CGI:-无}"

echo "=== 1. 安装单包 ==="
opkg_install_ipk "$PRISM_IPK" >/tmp/i1.log 2>&1 \
  && ok "安装 luci-app-prism-router（家长控制 CGI 同包）" \
  || { bad "安装失败"; tail -8 /tmp/i1.log; }

echo "=== 2. 落位 / 权限 / 语法 / 默认配置 ==="
check "$CGI" "root:root -rwxr-xr-x"
check /etc/prism-router "root:root drwxr-xr-x"
check /etc/init.d/prism-routerd "root:root -rwxr-xr-x"
check /etc/config/prism-router "root:root -rw-r--r--"
ucode -c "$CGI" >/dev/null 2>&1 && ok "CGI ucode 语法 OK" || bad "CGI ucode 语法错误"
sh -n /etc/init.d/prism-routerd && ok "init sh -n OK" || bad "init sh -n 失败"
[ "$(uci -q get prism-router.panel.write_enabled)" = "0" ] \
  && ok "默认 write_enabled=0（总开关关闭）" || bad "默认 write_enabled=$(uci -q get prism-router.panel.write_enabled)"
grep -q "option write_enabled '0'" /etc/config/prism-router \
  && ok "config 含 write_enabled 默认 0 的注释/值" || bad "config 缺少 write_enabled"
grep -q 'prism-router-control' /etc/init.d/prism-routerd && grep -q 'replay_paused' /etc/init.d/prism-routerd \
  && ok "init 注册了暂停规则重放（prism-router-control apply）" || bad "init 未接入重放"
grep -qE "'(flush|ruleset)'|\"(flush|ruleset)\"" "$CGI" && bad "CGI 把 flush/ruleset 当命令参数（禁止破坏性命令）" \
  || ok "CGI 没有把 flush/ruleset 作为 nft 参数"

echo "=== 3. 假 nft（记录 argv；list 返回可控文本）==="
cat > /tmp/fakebin/nft <<'NFT'
#!/bin/sh
# 假 nft：只记录 argv；list chain 由 /tmp/nft-listing.txt 控制；/tmp/nft-fail 存在时失败。
printf '%s\n' "$*" >> /tmp/nft.log
case "$1 $2" in
  "-a list")
    [ -s /tmp/nft-listing.txt ] && cat /tmp/nft-listing.txt
    exit 0 ;;
esac
[ -f /tmp/nft-fail ] && exit 1
exit 0
NFT
chmod 755 /tmp/fakebin/nft
printf '%s\n' "$BR_MAC" > "$BRLAN"
ok "假 nft 已就位（/tmp/fakebin/nft），br-lan MAC fixture=$BR_MAC"

echo "=== 4. 默认关闭 / 方法白名单 ==="
reset_nft; reset_state
call /tmp/r1.json POST '{"token":"whatever","action":"pause","mac":"aa:bb:cc:dd:ee:ff"}'
expect_status "默认 write_enabled=0 的 pause" /tmp/r1.json 403
expect_err "默认关闭" /tmp/r1.json write_disabled
[ "$(nft_calls)" = "0" ] && ok "默认关闭时一次 nft 都没调" || bad "默认关闭仍调用了 nft：$(cat "$NFTLOG")"

call /tmp/r2.json GET ''
expect_status "GET" /tmp/r2.json 405
call /tmp/r3.json HEAD ''
expect_status "HEAD" /tmp/r3.json 405
call /tmp/r4.json PUT '{"action":"list"}'
expect_status "PUT" /tmp/r4.json 405
[ "$(nft_calls)" = "0" ] && ok "非 POST 不触发 nft" || bad "非 POST 触发了 nft"

# 老配置（升级保留的 conffile）没有 write_enabled 选项 → 必须等同 0
uci -q delete prism-router.panel.write_enabled; uci commit prism-router
[ -z "$(uci -q get prism-router.panel.write_enabled)" ] && ok "已模拟老配置（无 write_enabled 选项）" \
  || bad "老配置模拟失败"
call /tmp/r5.json POST '{"token":"whatever","action":"list"}'
expect_status "老配置（缺 write_enabled）的 list" /tmp/r5.json 403
expect_err "老配置按关闭处理" /tmp/r5.json write_disabled

echo "=== 5. 令牌门禁（write_enabled=1）==="
uci set prism-router.panel.write_enabled='1'; uci commit prism-router
uci set prism-router.panel.token=''
uci commit prism-router
reset_nft
call /tmp/r6.json POST '{"token":"whatever","action":"list"}'
expect_status "token 为空时的 list" /tmp/r6.json 403
expect_err "token 为空" /tmp/r6.json forbidden
call /tmp/r7.json POST '{"action":"list"}' "Bearer whatever"
expect_err "token 为空 + Bearer" /tmp/r7.json forbidden
[ "$(nft_calls)" = "0" ] && ok "令牌失败不触发 nft" || bad "令牌失败仍调用了 nft"

uci set prism-router.panel.token="$TOKEN"; uci commit prism-router
call /tmp/r8.json POST '{"token":"wrong-token","action":"list"}'
expect_status "错误 body.token 的 list" /tmp/r8.json 403
expect_err "错误 body.token" /tmp/r8.json forbidden
call /tmp/r9.json POST '{"action":"list"}' "Bearer wrong-token"
expect_err "错误 Bearer" /tmp/r9.json forbidden
[ "$(nft_calls)" = "0" ] && ok "鉴权失败不触发 nft" || bad "鉴权失败仍调用了 nft"

echo "=== 6. pause：body.token 与 Bearer 两条路径 ==="
reset_nft; reset_state
call /tmp/p1.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"aa:bb:cc:dd:ee:ff"}'
expect_status "pause（body.token）" /tmp/p1.json 200
has_json /tmp/p1.json '"ok": true' && ok "pause 返回 ok=true" || bad "pause 响应：$(inspect /tmp/p1.json)"
has_json /tmp/p1.json '"already": false' && ok "首次 pause 不是 already" || bad "首次 pause 标成 already"
has_json /tmp/p1.json "\"mac\": \"$MAC1\"" && ok "响应 MAC 已归一化为大写冒号" || bad "MAC 归一化失败：$(inspect /tmp/p1.json)"
EXPECT_ADD="add rule inet fw4 forward ether saddr $MAC1 counter drop comment \"prism-pause-$MAC1\""
grep -qxF "$EXPECT_ADD" "$NFTLOG" && ok "nft 收到固定 add rule argv（含 comment 引号）" \
  || bad "nft add 命令不符；实际：$(cat "$NFTLOG" | tr '\n' '|')"
[ "$(count_prefix 'add rule inet fw4 forward ether saddr ')" = "1" ] && ok "只加了 1 条规则" \
  || bad "add rule 次数=$(count_prefix 'add rule inet fw4 forward ether saddr ')"
grep -q '^Content-Type: application/json' /tmp/p1.json && ok "响应 Content-Type: application/json" \
  || bad "响应 Content-Type 不符"
grep -qi '^Cache-Control: no-store' /tmp/p1.json && ok "响应 Cache-Control: no-store" \
  || bad "响应缺少 Cache-Control"

call /tmp/p2.json POST '{"action":"pause","mac":"02:00:00:00:00:01"}' "Bearer $TOKEN"
expect_status "pause（Authorization: Bearer）" /tmp/p2.json 200
has_json /tmp/p2.json "\"mac\": \"$MAC2\"" && ok "Bearer 路径 MAC 归一化正确" || bad "Bearer 路径 MAC 错"

echo "=== 7. paused.json（0600 原子写）==="
check /etc/prism-router/paused.json "root:root -rw-------"
PJ=$(F=/etc/prism-router/paused.json ucode -e '
  import { readfile } from "fs";
  let d = json(readfile(getenv("F")));
  print(sprintf("%d|%s", d.v, join(",", d.paused ?? [])));' 2>/dev/null)
[ "$PJ" = "1|$MAC2,$MAC1" ] && ok "paused.json v=1 且列出 2 个 MAC（$PJ）" || bad "paused.json 内容异常：$PJ"
ls -A /etc/prism-router | grep -q '\.tmp\.' && bad "存在未清理的临时文件" || ok "没有临时文件残留"

echo "=== 8. 重复 pause 幂等（不重复加规则）==="
: > "$NFTLIST"; list_rule "$MAC1" 42
BEFORE_ADD=$(count_prefix 'add rule inet fw4 forward ether saddr ')
call /tmp/p3.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"aa:bb:cc:dd:ee:ff"}'
expect_status "重复 pause" /tmp/p3.json 200
has_json /tmp/p3.json '"already": true' && ok "重复 pause → already=true" || bad "重复 pause：$(inspect /tmp/p3.json)"
AFTER_ADD=$(count_prefix 'add rule inet fw4 forward ether saddr ')
[ "$BEFORE_ADD" = "$AFTER_ADD" ] && ok "重复 pause 没有再加规则（add 次数仍 $AFTER_ADD）" \
  || bad "重复 pause 又加了规则：$BEFORE_ADD -> $AFTER_ADD"

echo "=== 9. resume：解析 handle 并 delete rule ==="
: > "$NFTLIST"; list_rule "$MAC1" 42
call /tmp/d1.json POST '{"token":"'"$TOKEN"'","action":"resume","mac":"AA:BB:CC:DD:EE:FF"}'
expect_status "resume" /tmp/d1.json 200
has_json /tmp/d1.json '"already": false' && ok "resume 执行了删除（already=false）" || bad "resume 响应：$(inspect /tmp/d1.json)"
grep -qxF 'delete rule inet fw4 forward handle 42' "$NFTLOG" && ok "nft 收到 delete rule ... handle 42" \
  || bad "delete 命令不符：$(cat "$NFTLOG" | tr '\n' '|')"
grep -q "delete rule inet fw4 forward handle" "$NFTLOG" && ok "按 handle 删除（不是按 MAC 字符串）" || bad "未按 handle 删除"
PJ=$(F=/etc/prism-router/paused.json ucode -e '
  import { readfile } from "fs";
  print(join(",", json(readfile(getenv("F"))).paused ?? []));' 2>/dev/null)
[ "$PJ" = "$MAC2" ] && ok "resume 后持久化只剩未恢复的 $MAC2（$PJ）" || bad "resume 后 paused.json=$PJ"

: > "$NFTLIST"
call /tmp/d2.json POST '{"token":"'"$TOKEN"'","action":"resume","mac":"AA:BB:CC:DD:EE:FF"}'
expect_status "重复 resume" /tmp/d2.json 200
has_json /tmp/d2.json '"already": true' && ok "无规则时 resume → already=true" || bad "重复 resume：$(inspect /tmp/d2.json)"

echo "=== 10. list：从内核现查 ==="
: > "$NFTLIST"; list_rule "$MAC1" 7; list_rule "$MAC2" 8
AUDIT_BEFORE=$(audit_lines)
call /tmp/l1.json POST '{"token":"'"$TOKEN"'","action":"list"}'
expect_status "list" /tmp/l1.json 200
N=$(F=/tmp/l1.json ucode -e '
  import { readfile } from "fs";
  let raw = readfile(getenv("F")); let body = "";
  for (let line in split(raw, "\n")) if (length(line)) body = line;
  let d = json(body); print(length(d.paused ?? []));' 2>/dev/null)
[ "$N" = "2" ] && ok "list 返回 2 条暂停规则" || bad "list 条数=$N（期望 2）"
has_json /tmp/l1.json "\"mac\": \"$MAC1\", \"handle\": 7" && has_json /tmp/l1.json "\"mac\": \"$MAC2\", \"handle\": 8" \
  && ok "list 返回 {mac,handle} 且 MAC 大写" || bad "list 内容：$(inspect /tmp/l1.json)"
AUDIT_AFTER=$(audit_lines)
[ "$AUDIT_BEFORE" = "$AUDIT_AFTER" ] && ok "list 是只读的（不写审计）" || bad "list 写了审计（$AUDIT_BEFORE -> $AUDIT_AFTER）"

echo "=== 11. 保护目标：400 且不调用 nft ==="
: > "$NFTLIST"; reset_nft
for m in "$BR_MAC" '00:00:00:00:00:00' 'ff:ff:ff:ff:ff:ff' '33:33:00:00:00:01' '01:00:5e:00:00:01'; do
  call /tmp/g.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"'"$m"'"}'
  expect_status "pause $m" /tmp/g.json 400
  expect_err "pause $m" /tmp/g.json protected_target
done
[ "$(nft_calls)" = "0" ] && ok "保护目标全部在调用 nft 之前被拒（0 次调用）" \
  || bad "保护目标触发了 nft：$(cat "$NFTLOG" | tr '\n' '|')"

echo "=== 12. 非法输入 ==="
reset_nft
call /tmp/e1.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"aa:bb:cc:dd:ee"}'
expect_status "非法 MAC（5 段）" /tmp/e1.json 400; expect_err "非法 MAC（5 段）" /tmp/e1.json invalid_mac
call /tmp/e2.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"zz:bb:cc:dd:ee:ff"}'
expect_err "非 hex MAC" /tmp/e2.json invalid_mac
call /tmp/e3.json POST '{"token":"'"$TOKEN"'","action":"pause"}'
expect_err "缺少 mac" /tmp/e3.json invalid_mac
call /tmp/e4.json POST '{"token":"'"$TOKEN"'","action":"reboot","mac":"aa:bb:cc:dd:ee:ff"}'
expect_status "非法 action" /tmp/e4.json 400; expect_err "非法 action" /tmp/e4.json invalid_action
call /tmp/e5.json POST '{"token":"'"$TOKEN"'","action":"apply","mac":"aa:bb:cc:dd:ee:ff"}'
expect_status "HTTP 不允许 apply" /tmp/e5.json 400; expect_err "HTTP 不允许 apply" /tmp/e5.json invalid_action
call /tmp/e6.json POST '{"token":'
expect_status "坏 JSON" /tmp/e6.json 400; expect_err "坏 JSON" /tmp/e6.json invalid_json
call /tmp/e7.json POST '[]'
expect_err "JSON 数组不是对象" /tmp/e7.json invalid_json
call /tmp/e8.json POST '"text"'
expect_err "JSON 字符串不是对象" /tmp/e8.json invalid_json
call /tmp/e9.json POST ''
expect_status "POST 无 body" /tmp/e9.json 400; expect_err "POST 无 body" /tmp/e9.json empty_body
ucode -e 'import { writefile } from "fs"; let s = ""; for (let i = 0; i < 5000; i++) s += "x"; writefile("/tmp/big.json", s);'
call /tmp/e10.json POST "$(cat /tmp/big.json)"
expect_status "超大 body（5000 B）" /tmp/e10.json 400; expect_err "超大 body" /tmp/e10.json body_too_large
run_cgi /tmp/e11.json POST 999999 '{"token":"x","action":"list"}'
expect_status "声明长度 > 4096（不读取）" /tmp/e11.json 400; expect_err "声明长度超限" /tmp/e11.json body_too_large
run_cgi /tmp/e12.json POST '12abc' '{"token":"x","action":"list"}'
expect_status "非法 Content-Length" /tmp/e12.json 400; expect_err "非法 Content-Length" /tmp/e12.json bad_request
call /tmp/e13.json POST '{"token":"'"$TOKEN"'","action":"list"}' '' 'text/plain'
expect_status "Content-Type: text/plain" /tmp/e13.json 400; expect_err "错 Content-Type" /tmp/e13.json bad_request
[ "$(nft_calls)" = "0" ] && ok "非法输入一律不触发 nft" || bad "非法输入触发了 nft：$(cat "$NFTLOG" | tr '\n' '|')"

echo "=== 13. nft 失败 → 500，且不回显 nft 输出 ==="
reset_nft; touch "$NFTFAIL"
call /tmp/f1.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"02:00:00:00:00:02"}'
expect_status "nft 失败" /tmp/f1.json 500
expect_err "nft 失败" /tmp/f1.json nft_failed
grep -q 'fake nft\|nft:' /tmp/f1.json && bad "响应回显了 nft 输出" || ok "响应不含 nft 原始输出"
grep -q '^[0-9-]* [0-9:]* pause 02:00:00:00:00:02 failed$' /etc/prism-router/control.log \
  && ok "nft 失败写审计（failed）" || bad "nft 失败未写审计"
rm -f "$NFTFAIL"

echo "=== 14. 审计日志（0600 / 格式 / 不含 token）==="
check /etc/prism-router/control.log "root:root -rw-------"
grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} pause '"$MAC1"' ok$' /etc/prism-router/control.log \
  && ok "审计行格式 YYYY-MM-DD HH:MM:SS action mac result" || bad "审计行格式不符"
grep -qF "$TOKEN" /etc/prism-router/control.log && bad "审计日志里出现 token" || ok "审计日志不含 token"

echo "=== 15. apply 重放（本机 root，无 HTTP）==="
reset_nft; reset_state
printf '{"v":1,"paused":["%s","%s"]}' "$MAC1" "$MAC2" > /etc/prism-router/paused.json
chmod 600 /etc/prism-router/paused.json
run_apply(){ PRISM_ROUTER_BRLAN_ADDR="$BRLAN" PATH=/tmp/fakebin:/usr/sbin:/usr/bin:/sbin:/bin \
  ucode "$CGI" apply >/tmp/apply.out 2>/tmp/apply.err; echo $?; }
RC=$(run_apply)
[ "$RC" = "0" ] && ok "apply 退出码 0" || { bad "apply 退出码 $RC"; cat /tmp/apply.err; }
[ "$(count_prefix 'add rule inet fw4 forward ether saddr ')" = "2" ] \
  && ok "apply 重放了 2 条暂停规则" || bad "apply 重放条数=$(count_prefix 'add rule inet fw4 forward ether saddr ')"
grep -qxF "add rule inet fw4 forward ether saddr $MAC1 counter drop comment \"prism-pause-$MAC1\"" "$NFTLOG" \
  && ok "重放命令与 pause 完全一致（固定 argv）" || bad "重放命令不符：$(cat "$NFTLOG" | tr '\n' '|')"

: > "$NFTLIST"; list_rule "$MAC1" 11; list_rule "$MAC2" 12
: > "$NFTLOG"; rm -f "$NFTFAIL"
RC=$(run_apply)
[ "$RC" = "0" ] && [ "$(count_prefix 'add rule inet fw4 forward ether saddr ')" = "0" ] \
  && ok "apply 幂等：规则已在时不再加" || bad "apply 不幂等（rc=$RC, add=$(count_prefix 'add rule inet fw4 forward ether saddr '))"

# 保护目标即使被写进 paused.json 也不会重放
: > "$NFTLIST"; reset_nft
printf '{"v":1,"paused":["%s","33:33:00:00:00:01","%s"]}' "$BR_MAC" "$MAC1" > /etc/prism-router/paused.json
chmod 600 /etc/prism-router/paused.json
RC=$(run_apply)
[ "$RC" = "0" ] && ok "paused.json 含保护目标时 apply 退出码 0" || bad "apply rc=$RC"
[ "$(count_prefix 'add rule inet fw4 forward ether saddr ')" = "1" ] \
  && ok "apply 跳过 br-lan / 多播，只重放合法 MAC" \
  || bad "apply 重放条数=$(count_prefix 'add rule inet fw4 forward ether saddr ')"
grep -qE "$BR_MAC|33:33:00:00:00:01" "$NFTLOG" && bad "apply 对保护目标调用了 nft" || ok "apply 未对保护目标调用 nft"

# 重放不受 write_enabled 影响（重启后暂停仍然生效），但 HTTP 写操作仍被开关挡住
uci set prism-router.panel.write_enabled='0'; uci set prism-router.panel.token=''; uci commit prism-router
: > "$NFTLIST"; reset_nft
printf '{"v":1,"paused":["%s"]}' "$MAC2" > /etc/prism-router/paused.json
chmod 600 /etc/prism-router/paused.json
RC=$(run_apply)
[ "$RC" = "0" ] && [ "$(count_prefix 'add rule inet fw4 forward ether saddr ')" = "1" ] \
  && ok "write_enabled=0 时仍重放历史暂停（重启不逃逸）" || bad "关闭开关后重放失败（rc=$RC）"
call /tmp/w1.json POST '{"token":"'"$TOKEN"'","action":"resume","mac":"'"$MAC2"'"}'
expect_err "开关关闭后 HTTP 写仍被拒" /tmp/w1.json write_disabled
uci set prism-router.panel.write_enabled='1'; uci set prism-router.panel.token="$TOKEN"; uci commit prism-router

ucode "$CGI" >/tmp/usage.out 2>/tmp/usage.err; RC=$?
[ "$RC" = "2" ] && grep -q 'usage:' /tmp/usage.err && ok "无参数调用 → 退出码 2 + usage（不执行任何操作）" \
  || bad "无参数调用行为异常：rc=$RC $(cat /tmp/usage.err)"

echo "=== 16. 审计 200 行截断 ==="
reset_state
i=0
while [ $i -lt 205 ]; do
  call /tmp/t.json POST '{"token":"'"$TOKEN"'","action":"resume","mac":"de:ad:be:ef:00:01"}' >/dev/null 2>&1
  i=$((i+1))
done
LINES=$(audit_lines)
[ "$LINES" = "200" ] && ok "审计日志截断为最近 200 行（实际 $LINES）" || bad "审计行数=$LINES（期望 200）"
tail -1 /etc/prism-router/control.log | grep -q "resume $MAC_IDLE already" \
  && ok "最新一行是最后一次操作" || bad "最后一行：$(tail -1 /etc/prism-router/control.log)"
grep -qF "$TOKEN" /etc/prism-router/control.log && bad "审计日志含 token（截断后）" || ok "截断后仍不含 token"
check /etc/prism-router/control.log "root:root -rw-------"

echo "=== 17. 安全断言：nft 只碰 inet fw4 forward，绝不破坏/碰 UA3F ==="
reset_nft
: > "$NFTLIST"
call /tmp/s1.json POST '{"token":"'"$TOKEN"'","action":"list"}'
call /tmp/s2.json POST '{"token":"'"$TOKEN"'","action":"pause","mac":"02:00:00:00:00:03"}'
: > "$NFTLIST"; list_rule "02:00:00:00:00:03" 99
call /tmp/s3.json POST '{"token":"'"$TOKEN"'","action":"resume","mac":"02:00:00:00:00:03"}'
BAD=$(awk '
  $0 == "-a list chain inet fw4 forward" { next }
  index($0, "add rule inet fw4 forward ether saddr ") == 1 { next }
  index($0, "delete rule inet fw4 forward handle ") == 1 { next }
  { print }' "$NFTLOG")
[ -z "$BAD" ] && ok "全部 nft 调用都限定在 inet fw4 forward（$(wc -l < "$NFTLOG") 次）" || bad "出现白名单之外的 nft 调用：$BAD"
grep -qiE 'UA3F' "$NFTLOG" && bad "nft 调用触碰了 UA3F 表" || ok "从未触碰第三方 inet UA3F 表"
grep -qiE 'flush|ruleset|delete table|add table' "$NFTLOG" && bad "出现破坏性 nft 命令" \
  || ok "没有 flush / ruleset / delete table 等破坏性命令"

echo "=== 18. 卸载后系统目录仍然正常（回滚路径）==="
opkg remove luci-app-prism-router >/tmp/rm.log 2>&1 && ok "卸载成功" || { bad "卸载失败"; tail -5 /tmp/rm.log; }
[ ! -e "$CGI" ] && ok "CGI 已随包移除" || bad "CGI 卸载后残留"
[ ! -e /etc/init.d/prism-routerd ] && ok "init 已随包移除" || bad "init 卸载后残留"
[ "$B_ETC" = "$(perm /etc)" ] && ok "卸载后 /etc 仍是 $B_ETC" || bad "卸载后 /etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "卸载后 /usr 仍是 $B_USR" || bad "卸载后 /usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "卸载后 /www 仍是 $B_WWW" || bad "卸载后 /www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "卸载后 /www/cgi-bin 仍是 $B_CGI" || bad "卸载后 /www/cgi-bin 被改动"
[ -f /etc/prism-router/paused.json ] && ok "用户数据 paused.json 卸载后保留（可回滚重装）" \
  || echo "  NOTE  paused.json 不存在（此前被清空/未生成）"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
