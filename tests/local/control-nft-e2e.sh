#!/bin/sh
# 家长控制 · 本地真实 nftables 端到端测试（手动运行，**不进 15 套隔离门禁**）
#
# 隔离门禁（container-validate-control）用 PATH 注入假 nft 验证契约；本脚本用
# 真实 nft 验证规则真的能加/删/重放。因为 nft 需要 NET_ADMIN，容器必须
# --cap-add=NET_ADMIN，所以单独放在 tests/local/，按需手动执行：
#
#   docker run --rm --network none --cap-add=NET_ADMIN \
#     -v "$PWD:/src:ro" -v "$PWD/tests/local/control-nft-e2e.sh:/t.sh:ro" \
#     openwrt-24.10:deps sh /t.sh
#
# 只在本机容器内建 table inet fw4 与 forward 链，不接触真机、不影响宿主机网络。
set -u
PASS=0; FAIL=0
ok(){ echo "  PASS $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL $1"; FAIL=$((FAIL+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3（实际[$1] 期望[$2]）"; }

IPK="${PRISM_IPK:-$(for f in /src/dist/luci-app-prism-router_*.ipk; do case "$f" in *.legacy.ipk) ;; *) printf '%s\n' "$f"; break ;; esac; done)}"
opkg install "$IPK" >/tmp/i.log 2>&1 || { echo "安装失败"; tail -5 /tmp/i.log; exit 1; }

CGI=/www/cgi-bin/prism-router-control
TOK=testtoken1234567890
MAC=AA:BB:CC:DD:EE:01
MAC2=AA:BB:CC:DD:EE:02

nft add table inet fw4 || { echo "建表失败"; exit 1; }
nft add chain inet fw4 forward '{ type filter hook forward priority 0; }' || { echo "建链失败"; exit 1; }

post(){
  printf '%s' "$1" > /tmp/body.json
  REQUEST_METHOD=POST CONTENT_TYPE=application/json CONTENT_LENGTH=$(wc -c < /tmp/body.json) \
    ucode "$CGI" < /tmp/body.json 2>/dev/null
}

uci set prism-router.panel.write_enabled='0'; uci commit prism-router
out=$(post '{"token":"x","action":"list"}')
echo "$out" | grep -q write_disabled && ok "默认关闭：write_disabled" || bad "默认关闭未拒绝"

uci set prism-router.panel.write_enabled='1'
uci set prism-router.panel.token="$TOK"; uci commit prism-router

out=$(post '{"token":"wrong","action":"list"}')
echo "$out" | grep -q forbidden && ok "错误 token：forbidden" || bad "错误 token 未拒绝"

out=$(post "{\"token\":\"$TOK\",\"action\":\"pause\",\"mac\":\"$MAC\"}")
echo "$out" | grep -q '"ok": *true' && ok "pause 成功" || bad "pause 失败：$out"
nft list chain inet fw4 forward 2>/dev/null | grep -q "prism-pause-$MAC" && ok "nft 规则已插入" || bad "nft 规则缺失"
nft list chain inet fw4 forward 2>/dev/null | grep -iq "ether saddr $MAC" && ok "规则按 MAC 匹配" || bad "规则 MAC 不匹配"
nft list chain inet fw4 forward 2>/dev/null | grep -q "drop" && ok "规则动作 drop" || bad "规则未 drop"

out=$(post "{\"token\":\"$TOK\",\"action\":\"pause\",\"mac\":\"$MAC\"}")
echo "$out" | grep -q already && ok "重复 pause 幂等" || bad "重复 pause 非幂等：$out"
n=$(nft list chain inet fw4 forward 2>/dev/null | grep -c "prism-pause-$MAC")
eq "$n" "1" "重复 pause 后仍只有 1 条规则"

for badmac in 00:00:00:00:00:00 FF:FF:FF:FF:FF:FF 01:00:5E:00:00:01; do
  out=$(post "{\"token\":\"$TOK\",\"action\":\"pause\",\"mac\":\"$badmac\"}")
  echo "$out" | grep -q protected_target && ok "保护目标拒绝 $badmac" || bad "保护目标未拒绝 $badmac"
done

out=$(post '{"token":"'"$TOK"'","action":"pause","mac":"not-a-mac"}')
echo "$out" | grep -q invalid_mac && ok "非法 MAC：invalid_mac" || bad "非法 MAC 未拒绝"
out=$(post '{"token":"'"$TOK"'","action":"hack"}')
echo "$out" | grep -q invalid_action && ok "非法 action：invalid_action" || bad "非法 action 未拒绝"

out=$(post "{\"token\":\"$TOK\",\"action\":\"resume\",\"mac\":\"$MAC\"}")
echo "$out" | grep -q '"ok": *true' && ok "resume 成功" || bad "resume 失败：$out"
nft list chain inet fw4 forward 2>/dev/null | grep -q "prism-pause-$MAC" && bad "resume 后规则仍在" || ok "resume 后规则已删除"

[ -f /etc/prism-router/paused.json ] && ok "paused.json 已创建" || bad "paused.json 缺失"
[ -f /etc/prism-router/control.log ] && ok "control.log 已创建" || bad "control.log 缺失"
grep -q "$TOK" /etc/prism-router/control.log 2>/dev/null && bad "审计日志泄漏 token" || ok "审计日志不含 token"

post "{\"token\":\"$TOK\",\"action\":\"pause\",\"mac\":\"$MAC2\"}" >/dev/null
handle=$(nft -a list chain inet fw4 forward 2>/dev/null | awk '/prism-pause-AA:BB:CC:DD:EE:02/{print $NF}' | head -1)
[ -n "$handle" ] && ok "能取到规则 handle" || bad "取不到 handle"
[ -n "$handle" ] && nft delete rule inet fw4 forward handle "$handle"
ucode "$CGI" apply >/dev/null 2>&1
nft list chain inet fw4 forward 2>/dev/null | grep -q "prism-pause-$MAC2" && ok "apply 重放恢复规则" || bad "apply 未重放"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ]
