#!/bin/sh
# feishu-test.sh — feishu.uc 的离线自测（不需要真实飞书 webhook，不访问外网）
#
# 覆盖：
#   1. 官方签名测试向量（ts=1599360473, secret=demo）
#   2. 卡片 JSON 2.0 结构 / 字节数 / 禁用组件检查（不依赖 jq）
#   3. 体积超限时的 Top 截断（10 -> 8 -> 5）
#   4. 降级行为：无数据、无 webhook、无 secret、history/state 缺失
#   5. 本地 mock webhook（uhttpd + CGI）：真实 POST、服务端验签、code!=0、重试队列
#   6. 三类告警 + 30 分钟冷却
#
# 用法：
#   sh feishu-test.sh [path/to/feishu.uc]
#   FEISHU_UC=/tmp/feishu.uc sh feishu-test.sh
#   UCODE=ucode TEST_PORT=18080 sh feishu-test.sh
#   KEEP=1 sh feishu-test.sh          # 保留临时目录，便于排查
#
# 默认与 feishu.uc 放在同一目录；在路由器上：
#   cat feishu.uc       | ssh root@192.168.100.1 'cat > /tmp/feishu.uc'
#   cat feishu-test.sh  | ssh root@192.168.100.1 'cat > /tmp/feishu-test.sh'
#   ssh root@192.168.100.1 'sh /tmp/feishu-test.sh'

set -u

HERE=$(dirname "$0")
case "$HERE" in
    /*) ;;
    *) HERE=$(pwd)/$HERE ;;
esac
UC=${FEISHU_UC:-${1:-$HERE/feishu.uc}}
UCODE=${UCODE:-ucode}
PORT=${TEST_PORT:-18080}

TMP=${TMPDIR:-/tmp}/feishu-test.$$
MOCK="$TMP/mock"
MOCK_PID=""

PASS=0
FAIL=0
SKIP=0

ok()  { PASS=$((PASS + 1)); echo "  [PASS] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  [FAIL] $1"; }
skip() { SKIP=$((SKIP + 1)); echo "  [SKIP] $1"; }

run_uc() { "$UCODE" "$UC" "$@"; }

bytes_of() { wc -c < "$1" | tr -d ' \t'; }

qcount() {
    ls "$1/feishu-queue"/q-*.json 2>/dev/null | wc -l | tr -d ' \t'
}

cleanup() {
    if [ -n "$MOCK_PID" ]; then
        kill "$MOCK_PID" 2>/dev/null
        wait "$MOCK_PID" 2>/dev/null
    fi
    if [ "${KEEP:-0}" = "1" ]; then
        echo "（已保留临时目录：$TMP）"
    else
        rm -rf "$TMP"
    fi
}
trap cleanup EXIT INT TERM

# ── 测试用数据 ────────────────────────────────────────────────

# 12 台设备、3 个代理节点；device-12 最大
write_state() {
    now=$(date +%s)
    {
        printf '{"ts":%d,"uptime":36000,"source":{"clash":"ok","conntrack":"ok"},' "$now"
        printf '"totals":{"direct_rx":1234567890,"direct_tx":1234567,"proxy_rx":9876543210,"proxy_tx":76543210},'
        printf '"nodes":{"US2-HY2":{"rx":8000000000,"tx":60000000},"JP1-Tokyo":{"rx":3000000000,"tx":20000000},'
        printf '"HK-HKT":{"rx":1000000000,"tx":10000000},"DIRECT":{"rx":1234567890,"tx":1234567}},'
        printf '"devices":['
        i=1
        while [ "$i" -le 12 ]; do
            [ "$i" -gt 1 ] && printf ','
            printf '{"ip":"192.168.100.%d","mac":"dc:56:7b:89:fb:%02x","hostname":"device-%d",' "$((100 + i))" "$i" "$i"
            printf '"direct_rx":%d,"direct_tx":10000,"proxy_rx":%d,"proxy_tx":90000,"rx_rate":1000,"tx_rate":100,"last_seen":%d}' \
                "$((i * 1000000))" "$((i * 9000000))" "$((now - 10))"
            i=$((i + 1))
        done
        printf '],"health":{"accounting_confidence":"exact","reasons":[],"conntrack_count":1800}}'
    } > "$1"
}

write_history() {
    now=$(date +%s)
    day=$(date +%F)
    {
        printf '{"day":"%s","buckets":[' "$day"
        i=0
        while [ "$i" -lt 96 ]; do
            [ "$i" -gt 0 ] && printf ','
            printf '{"ts":%d,"direct_rx":%d,"direct_tx":10000,"proxy_rx":%d,"proxy_tx":90000}' \
                "$((now - (96 - i) * 300))" "$((1000000 + i * 1000))" "$((9000000 + i * 1000))"
            i=$((i + 1))
        done
        printf ']}'
    } > "$1"
}

write_alert_state() {
    now=$(date +%s)
    {
        printf '{"ts":%d,"source":{"clash":"ok","conntrack":"ok"},' "$now"
        printf '"totals":{"direct_rx":1000000,"direct_tx":0,"proxy_rx":2000000,"proxy_tx":0},'
        printf '"devices":['
        printf '{"ip":"192.168.1.10","mac":"aa:bb:cc:dd:ee:01","hostname":"Laptop","direct_rx":1000000,"direct_tx":0,"proxy_rx":2000000,"proxy_tx":0,"last_seen":%d}' "$now"
        printf ',{"ip":"192.168.1.11","mac":"aa:bb:cc:dd:ee:02","hostname":"Phone","direct_rx":500000,"direct_tx":0,"proxy_rx":0,"proxy_tx":0,"last_seen":%d}' "$now"
        if [ "${2:-}" = "with_nas" ]; then
            printf ',{"ip":"192.168.1.12","mac":"aa:bb:cc:dd:ee:03","hostname":"NAS","direct_rx":900000000,"direct_tx":0,"proxy_rx":0,"proxy_tx":0,"last_seen":%d}' "$now"
        fi
        printf '],"health":{"accounting_confidence":"exact","reasons":[]}}'
    } > "$1"
}

# ── mock webhook（uhttpd + CGI）────────────────────────────────

start_mock() {
    if ! command -v uhttpd >/dev/null 2>&1; then
        return 1
    fi
    mkdir -p "$MOCK/cgi-bin"

    cat > "$MOCK/cgi-bin/ok" <<'CGI'
#!/bin/sh
# 服务端自行验签：只有 timestamp 存在且 HMAC 正确才返回 code=0
body=$(cat)
ts=$(printf '%s' "$body" | sed -n 's/.*"timestamp":"\([0-9]*\)".*/\1/p')
sign=$(printf '%s' "$body" | sed -n 's/.*"sign":"\([^"]*\)".*/\1/p')
echo "Content-Type: application/json"
echo
if [ -n "$ts" ] && [ -n "$sign" ]; then
    key=$(printf '%s\n%s' "$ts" '@SECRET@')
    want=$(printf '' | /usr/bin/openssl dgst -sha256 -hmac "$key" -binary | /usr/bin/openssl base64 -A)
    if [ "$want" = "$sign" ]; then
        printf '{"code":0,"msg":"ok","len":%s}' "${#body}"
    else
        printf '{"code":19021,"msg":"sign match fail"}'
    fi
else
    printf '{"code":19021,"msg":"missing timestamp/sign"}'
fi
CGI

    cat > "$MOCK/cgi-bin/rate" <<'CGI'
#!/bin/sh
cat >/dev/null
echo "Content-Type: application/json"
echo
printf '{"code":11232,"msg":"create message service trigger rate limit"}'
CGI

    cat > "$MOCK/cgi-bin/bad" <<'CGI'
#!/bin/sh
cat >/dev/null
echo "Content-Type: application/json"
echo
printf 'this is not json'
CGI

    cat > "$MOCK/cgi-bin/log" <<'CGI'
#!/bin/sh
body=$(cat)
printf '%s\n' "$body" >> '@LOGFILE@'
echo "Content-Type: application/json"
echo
printf '{"code":0,"msg":"ok"}'
CGI

    sed -i "s|@SECRET@|demo|" "$MOCK/cgi-bin/ok"
    sed -i "s|@LOGFILE@|$MOCK/requests.log|" "$MOCK/cgi-bin/log"
    chmod +x "$MOCK"/cgi-bin/*

    uhttpd -f -p 127.0.0.1:"$PORT" -h "$MOCK" >"$TMP/uhttpd.log" 2>&1 &
    MOCK_PID=$!
    sleep 1
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
        MOCK_PID=""
        return 1
    fi
    # 确认真的能连上（GET 会因为没有 body 返回 19021，但 HTTP 必须是 200）
    if ! curl -s --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/cgi-bin/rate"; then
        kill "$MOCK_PID" 2>/dev/null
        MOCK_PID=""
        return 1
    fi
    return 0
}

# ── 开始 ─────────────────────────────────────────────────────

echo "============================================================"
echo " feishu.uc 离线自测（不访问真实飞书）"
echo " feishu.uc : $UC"
echo " ucode     : $(command -v "$UCODE" 2>/dev/null || echo 未找到)"
echo " openssl   : $(command -v openssl 2>/dev/null || echo 未找到)"
echo " 临时目录  : $TMP"
echo "============================================================"

mkdir -p "$TMP" || { echo "无法创建 $TMP"; exit 1; }

if [ ! -f "$UC" ]; then
    echo "找不到 $UC（用 FEISHU_UC=... 指定）"
    exit 1
fi

echo
echo "[1] 签名测试向量"
echo "    key = timestamp + LF + secret，HMAC-SHA256 签空串，Base64"
SIG=$(run_uc sign 1599360473 demo 2>/dev/null | tr -d '\r')
EXPECT_SIG='l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8='
echo "    期望: $EXPECT_SIG"
echo "    实际: $SIG"
if [ "$SIG" = "$EXPECT_SIG" ]; then
    ok "签名与官方向量一致"
else
    bad "签名与官方向量不一致"
fi

echo
echo "[2] 内置自检（selftest：向量 + 卡片 + JSON 压缩器）"
if run_uc selftest >"$TMP/selftest.out" 2>&1; then
    ok "selftest 通过"
    grep -E "PASS|FAIL|自检结果" "$TMP/selftest.out" | tail -4
else
    bad "selftest 失败"
    tail -20 "$TMP/selftest.out"
fi

echo
echo "[3] 日报卡片结构与体积"
BASE="$TMP/base"
mkdir -p "$BASE"
write_state "$BASE/state.json"
write_history "$BASE/history.json"
if run_uc card --base "$BASE" --secret demo --out "$TMP/card.json" >"$TMP/card.out" 2>&1; then
    ok "生成卡片"
    cat "$TMP/card.out"
else
    bad "生成卡片失败"
    cat "$TMP/card.out"
fi

if [ -f "$TMP/card.json" ]; then
    BYTES=$(bytes_of "$TMP/card.json")
    [ "$BYTES" -lt 20480 ] && ok "字节数 $BYTES < 20480" || bad "字节数 $BYTES 超过 20480"
    if run_uc check "$TMP/card.json" >"$TMP/check.out" 2>&1; then
        ok "check 结构校验通过"
    else
        bad "check 结构校验失败"
    fi
    sed -n 's/^  //p' "$TMP/check.out" | tail -20

    grep -q '"tag":"note"' "$TMP/card.json" && bad "出现 2.0 已移除的 note 组件" || ok "不含 note 组件"
    grep -q '"tag":"action"' "$TMP/card.json" && bad "出现 2.0 已移除的 action 组件" || ok "不含 action 组件"
    grep -q '"schema":"2.0"' "$TMP/card.json" && ok "schema=2.0" || bad "schema 不是 2.0"
    grep -q '"page_size":10' "$TMP/card.json" && ok "table.page_size=10" || bad "page_size 不是 10"
    grep -q '"text_size":"notation"' "$TMP/card.json" && ok "脚注使用 plain_text + notation" || bad "脚注结构不对"
    HOSTS=$(grep -o '"host":"' "$TMP/card.json" | wc -l | tr -d ' \t')
    [ "$HOSTS" -eq 5 ] && ok "Top 5 设备行（实际 $HOSTS）" || bad "设备行数 $HOSTS，不是 5"

    # 默认输出路径 /tmp/card.json（需求要求的路径）
    if run_uc card --base "$BASE" --secret demo >/dev/null 2>&1 && [ -f /tmp/card.json ]; then
        ok "默认输出 /tmp/card.json（$(bytes_of /tmp/card.json) 字节）"
    else
        bad "默认输出 /tmp/card.json 失败"
    fi
else
    bad "卡片文件不存在"
fi

echo
echo "[4] 体积超限时的 Top 截断（--limit 3000，测试用）"
if run_uc card --base "$BASE" --secret demo --limit 3000 --out "$TMP/card-trunc.json" >"$TMP/card-trunc.out" 2>&1; then
    BYTES2=$(bytes_of "$TMP/card-trunc.json")
    [ "$BYTES2" -lt 3000 ] && ok "截断后 $BYTES2 < 3000" || bad "截断后仍有 $BYTES2 字节"
    grep -q "已截断" "$TMP/card-trunc.out" && ok "日志注明已截断" || bad "没有截断提示"
    HOSTS2=$(grep -o '"host":"' "$TMP/card-trunc.json" | wc -l | tr -d ' \t')
    [ "$HOSTS2" -le 8 ] && ok "Top 行数降为 $HOSTS2（<=8）" || bad "Top 行数仍为 $HOSTS2"
    sed -n 's/^/    /p' "$TMP/card-trunc.out"
else
    bad "截断测试生成失败"
    cat "$TMP/card-trunc.out"
fi

echo
echo "[5] 降级行为"
# 5.1 无数据
run_uc card --base "$TMP/nodata" --secret demo --out "$TMP/nodata.json" >"$TMP/nodata.out" 2>&1
RC=$?
if [ "$RC" -eq 0 ] && grep -q "无数据" "$TMP/nodata.out"; then
    ok "无 state/history：退出 0 且提示无数据"
else
    bad "无数据场景异常（rc=$RC）"
    cat "$TMP/nodata.out"
fi

# 5.2 无 webhook（UCI 未配置）
rm -rf "$BASE/feishu.log"
run_uc daily --base "$BASE" >"$TMP/noweb.out" 2>&1
RC=$?
if [ "$RC" -eq 0 ] && grep -q "webhook 未配置" "$BASE/feishu.log" 2>/dev/null; then
    ok "无 webhook：退出 0，日志记录跳过"
else
    bad "无 webhook 场景异常（rc=$RC）"
    cat "$BASE/feishu.log" 2>/dev/null | tail -3
fi

# 5.3 无 secret
run_uc daily --base "$BASE" --webhook http://127.0.0.1:1/x >"$TMP/nosec.out" 2>&1
RC=$?
# 自定义机器人未开「签名校验」时 secret 可以留空：不应再因缺 secret 跳过发送
if grep -q "secret 未配置" "$BASE/feishu.log" 2>/dev/null; then
    bad "无 secret 仍被跳过（应允许不签名发送）"
else
    ok "无 secret：允许不签名发送（rc=$RC）"
fi

# 5.4 history 缺失
mkdir -p "$TMP/nohist"
cp "$BASE/state.json" "$TMP/nohist/state.json"
if run_uc card --base "$TMP/nohist" --secret demo --out "$TMP/nohist.json" >"$TMP/nohist.out" 2>&1 &&
   run_uc check "$TMP/nohist.json" >/dev/null 2>&1 && grep -q "history.json 缺失" "$TMP/nohist.json"; then
    ok "history 缺失：仍生成合法卡片并注明"
else
    bad "history 缺失场景异常"
fi

# 5.5 state 缺失（只有 history）
mkdir -p "$TMP/nostate"
cp "$BASE/history.json" "$TMP/nostate/history.json"
if run_uc card --base "$TMP/nostate" --secret demo --out "$TMP/nostate.json" >"$TMP/nostate.out" 2>&1 &&
   run_uc check "$TMP/nostate.json" >/dev/null 2>&1 && grep -q "state.json 缺失" "$TMP/nostate.json"; then
    ok "state 缺失：用 history 汇总并注明"
else
    bad "state 缺失场景异常"
fi

# 5.6 网络失败（连接拒绝）
run_uc test --webhook http://127.0.0.1:1/x --secret demo --base "$TMP/net" >"$TMP/net.out" 2>&1
RC=$?
if [ "$RC" -eq 1 ] && grep -q "失败" "$TMP/net.out"; then
    ok "网络失败：退出 1 且给出原因"
else
    bad "网络失败场景异常（rc=$RC）"
fi
sed -n 's/^/    /p' "$TMP/net.out"

echo
echo "[6] 本地 mock webhook（uhttpd + CGI，仅 127.0.0.1）"
if start_mock; then
    W="http://127.0.0.1:$PORT/cgi-bin"
    ok "mock webhook 已启动：$W"
    : > "$MOCK/requests.log"

    # 6.1 服务端验签通过
    if run_uc test --webhook "$W/ok" --secret demo >"$TMP/t1.out" 2>&1; then
        ok "sign + POST：服务端验签通过（code=0）"
    else
        bad "sign + POST：服务端验签失败"
    fi
    sed -n 's/^/    /p' "$TMP/t1.out"

    # 6.2 HTTP 200 + code=19021 必须报失败
    run_uc test --webhook "$W/ok" --secret wrong >"$TMP/t2.out" 2>&1
    RC=$?
    if [ "$RC" -eq 1 ] && grep -q "19021" "$TMP/t2.out"; then
        ok "HTTP 200 + code=19021 被判为失败"
    else
        bad "code=19021 未被识别（rc=$RC）"
    fi
    sed -n 's/^/    /p' "$TMP/t2.out"

    # 6.3 code=11232 可重试 -> 入队
    Q="$TMP/queuebase"
    mkdir -p "$Q"
    cp "$BASE/state.json" "$Q/state.json"
    cp "$BASE/history.json" "$Q/history.json"
    run_uc daily --base "$Q" --webhook "$W/rate" --secret demo >"$TMP/t3.out" 2>&1
    RC=$?
    N=$(qcount "$Q")
    if [ "$RC" -eq 1 ] && grep -q "11232" "$TMP/t3.out" && [ "$N" -eq 1 ]; then
        ok "code=11232：失败并写入重试队列（$N 条）"
    else
        bad "11232 入队异常（rc=$RC, queue=$N）"
    fi
    sed -n 's/^/    /p' "$TMP/t3.out"

    # 6.4 retry --now 成功并清空队列
    run_uc retry --now --base "$Q" --webhook "$W/ok" --secret demo >"$TMP/t4.out" 2>&1
    N=$(qcount "$Q")
    if [ "$N" -eq 0 ]; then
        ok "retry --now 处理成功，队列清空"
    else
        bad "retry 后队列仍有 $N 条"
    fi
    sed -n 's/^/    /p' "$TMP/t4.out"

    # 6.5 非 JSON 响应
    run_uc test --webhook "$W/bad" --secret demo >"$TMP/t5.out" 2>&1
    RC=$?
    if [ "$RC" -eq 1 ] && grep -q "不是 JSON" "$TMP/t5.out"; then
        ok "非 JSON 响应被判为失败"
    else
        bad "非 JSON 响应处理异常（rc=$RC）"
    fi

    # 6.6 日报真实 POST
    if run_uc daily --base "$Q" --webhook "$W/ok" --secret demo >"$TMP/t6.out" 2>&1; then
        ok "日报真实 POST 成功（服务端验签）"
    else
        bad "日报真实 POST 失败"
    fi
    sed -n 's/^/    /p' "$TMP/t6.out"

    echo
    echo "[7] 告警（mock 记录收到的消息体）"
    A="$TMP/alert"
    mkdir -p "$A"
    write_alert_state "$A/s1.json" plain
    write_alert_state "$A/s2.json" with_nas
    : > "$MOCK/requests.log"

    run_uc alerts --base "$A" --state "$A/s1.json" --webhook "$W/log" --secret demo >/dev/null 2>&1
    N0=$(wc -l < "$MOCK/requests.log" | tr -d ' \t')
    [ "$N0" -eq 0 ] && ok "首次运行建立基线，不发新设备告警" || bad "首次运行发了 $N0 条"

    run_uc alerts --base "$A" --state "$A/s2.json" --webhook "$W/log" --secret demo >/dev/null 2>&1
    N1=$(wc -l < "$MOCK/requests.log" | tr -d ' \t')
    if [ "$N1" -eq 1 ] && grep -q "新设备上线" "$MOCK/requests.log"; then
        ok "新设备上线告警（1 条）"
    else
        bad "新设备上线告警异常（$N1 条）"
    fi

    run_uc alerts --base "$A" --state "$A/s2.json" --webhook "$W/log" --secret demo >/dev/null 2>&1
    N2=$(wc -l < "$MOCK/requests.log" | tr -d ' \t')
    [ "$N2" -eq "$N1" ] && ok "已知设备不重复告警" || bad "重复发送了设备告警（$N1 -> $N2）"

    run_uc alerts --base "$A" --state "$A/missing.json" --webhook "$W/log" --secret demo >/dev/null 2>&1
    N3=$(wc -l < "$MOCK/requests.log" | tr -d ' \t')
    if [ "$N3" -gt "$N2" ] && grep -q "采集异常/降级" "$MOCK/requests.log"; then
        ok "采集降级告警（$((N3 - N2)) 条）"
    else
        bad "采集降级告警异常（$N2 -> $N3）"
    fi

    run_uc alerts --base "$A" --state "$A/s2.json" --device-limit 1M --webhook "$W/log" --secret demo >/dev/null 2>&1
    N4=$(wc -l < "$MOCK/requests.log" | tr -d ' \t')
    if [ "$N4" -gt "$N3" ] && grep -q "设备流量超限" "$MOCK/requests.log"; then
        ok "设备流量超限告警（$((N4 - N3)) 条）"
    else
        bad "设备流量超限告警异常（$N3 -> $N4）"
    fi

    run_uc alerts --base "$A" --state "$A/s2.json" --device-limit 1M --webhook "$W/log" --secret demo >/dev/null 2>&1
    N5=$(wc -l < "$MOCK/requests.log" | tr -d ' \t')
    [ "$N5" -eq "$N4" ] && ok "30 分钟冷却生效，不重复发送" || bad "冷却失效（$N4 -> $N5）"

    if [ -f "$A/alert-state.json" ] && grep -q '"cooldown"' "$A/alert-state.json"; then
        ok "告警状态落盘（alert-state.json）"
    else
        bad "alert-state.json 缺失"
    fi
else
    skip "uhttpd 不可用或端口 $PORT 被占用，跳过 mock webhook 测试"
fi

echo
echo "============================================================"
echo " 结果：PASS $PASS / FAIL $FAIL / SKIP $SKIP"
echo "============================================================"
echo
echo "手动触发一次日报（不联网，只写 /tmp/card.json）："
echo "  $UCODE $UC card"
echo "手动触发一次真实日报（需要先配置 webhook + secret）："
echo "  $UCODE $UC daily"
echo "查看配置与队列："
echo "  $UCODE $UC status"
echo

[ "$FAIL" -eq 0 ] || exit 1
exit 0
