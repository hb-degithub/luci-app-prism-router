#!/bin/sh
# 核心修复容器内用例（由 tests/container-validate-core-fixes.sh 调用）。
# 覆盖：
#   1. 跨软重启：daily 恢复、baseline 恢复、截断 baseline（含 >8192 条）、
#      坏/过期基线 prime、去重 TTL 不随 600s 锚点放大、旧日文件不误读、
#      首帧不虚高、优雅停止保存。
#   2. 双源去重：DIRECT 真实目的 IP、非 fake-ip 代理流、fake-ip 旧逻辑、TTL 内的两轮、
#      clash 故障跨 TTL 后续期去重键、慢 curl 失败跨 TTL（终审阻断 1）、
#      故障全程保留 outage 账本（终审阻断 2）、故障中重启恢复 dedup/outage（终审阻断 3）。
#   5b. set_config 回滚保留他人的 staged 删除（uci changes 的 -key 行，终审阻断 4）。
#   8. pending day 只接受合法日期（防目录穿越）、baseline v3 结构/上限/类型校验、超大文件拒绝。
#   3. battle 配置：console URL（带 / ? #）、URI 注入、缺 acct 降级、双源不可用。
#   4. RPC：get_history 31 天/288 桶 <180KiB + truncated 标志、未来/非法日跳过、
#      summary 只含轻量字段、get_daily 兼容、month_scan 用 daily totals（空对象回退设备行）、
#      unavailable 白名单。
#   5. set_config：argv 数组无 shell、失败仅回滚本 section 本次 touched 字段（保留
#      预置 staged 改动）、严格 is_root。
#   6. devices.json：20 并发写不丢更新、mkdir 锁 owner/唯一 stale rename 回收、
#      多并发回收、释放不删他人锁、daemon+rpcd 双写者。
#   7. 日切写失败：pending 快照重试落盘（测试钩子模拟跨天）+ pending-daily.json
#      持久化，进程重启后恢复并重试。
mkdir -p /var/run/ubus /var/lock /tmp

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
eq(){ # $1=实际 $2=期望 $3=描述
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3（实际[$1] 期望[$2]）"; fi
}
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
CGET(){ uci -q get "$1" 2>/dev/null; }
cfg_commit(){ uci commit prism-router >/dev/null 2>&1; }
rpc(){ # $1=method [$2=args json]
  env PRISM_ROUTER_STATE_FILE="${RSTATE:-/tmp/cf/none/state.json}" \
      PRISM_ROUTER_DAILY_DIR="${RDAILY:-/tmp/cf/none/daily}" \
      PRISM_ROUTER_DEVICES_FILE="${RDEV:-/tmp/cf/none/devices.json}" \
      PRISM_ROUTER_METHOD="$1" PRISM_ROUTER_ARGS="${2:-}" \
      ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>>/tmp/cf/rpc.err
}
jget(){ # $1=file $2=ucode expression (d parsed)
  F="$1" ucode -e "let fs=require('fs'); let d=json(fs.readfile(getenv('F'))); print($2);" 2>/dev/null
}

ROOT=/tmp/cf
mkdir -p "$ROOT"

echo "=== 0. 安装两个包 ==="
opkg install /src/dist/prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 \
  && ok "安装 prism-router" || { bad "安装 prism-router"; tail -5 /tmp/i1.log; }
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i2.log 2>&1 \
  && ok "安装 luci-app-prism-router" || { bad "安装 luci-app"; tail -5 /tmp/i2.log; }
check /usr/bin/prism-routerd "root:root -rwxr-xr-x"
check /usr/share/rpcd/ucode/prism-router.uc "root:root -rw-r--r--"

echo "=== 1. ucode 语法 ==="
ucode -c /usr/bin/prism-routerd && ok "prism-routerd 语法 OK" || bad "prism-routerd 语法错误"
ucode -c /usr/share/rpcd/ucode/prism-router.uc && ok "rpcd uc 语法 OK" || bad "rpcd uc 语法错误"

UCI set prism-router.settings.lan_ranges='192.168.100.0/24'
UCI set prism-router.settings.poll_interval='5'
cfg_commit

mkdir -p "$ROOT/mock"
cat > "$ROOT/mock/connections" <<'CLASH'
{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.101","sourcePort":"40000","host":"a.example","destinationIP":"1.1.1.1","destinationPort":"443","network":"tcp"},"upload":500,"download":5000,"chains":["US1"]},
 {"id":"c2","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"b.example","destinationIP":"2.2.2.2","destinationPort":"443","network":"tcp"},"upload":700,"download":7000,"chains":["DIRECT"]},
 {"id":"c4","metadata":{"sourceIP":"192.168.100.105","sourcePort":"40004","host":"p.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":300,"download":3000,"chains":["US2"]}
]}
CLASH
cat > "$ROOT/ct.txt" <<'CT'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=2.2.2.2 sport=40001 dport=443 packets=1 bytes=700 src=2.2.2.2 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=7000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.105 dst=4.4.4.4 sport=40004 dport=443 packets=1 bytes=300 src=4.4.4.4 dst=192.168.100.105 sport=443 dport=40004 packets=1 bytes=3000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.103 dst=3.3.3.3 sport=40002 dport=443 packets=1 bytes=100 src=3.3.3.3 dst=192.168.100.103 sport=443 dport=40002 packets=1 bytes=1000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.104 dst=198.18.0.9 sport=40003 dport=443 packets=1 bytes=9000 src=198.18.0.9 dst=192.168.100.104 sport=443 dport=40003 packets=1 bytes=90000 [ASSURED] mark=0 use=1
CT
cat > "$ROOT/ct_noacct.txt" <<'CT2'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.103 dst=3.3.3.3 sport=40002 dport=443 packets=1 src=3.3.3.3 dst=192.168.100.103 sport=443 dport=40002 packets=1 [ASSURED] mark=0 use=1
CT2
cat > /tmp/dhcp.leases <<'LEASE'
0 34:f0:15:a0:0e:b1 192.168.100.101 phone *
0 aa:bb:cc:dd:ee:01 192.168.100.102 pc *
0 02:00:00:00:00:99 192.168.100.103 tv *
0 02:00:00:00:00:05 192.168.100.105 pad *
LEASE

/usr/sbin/uhttpd -f -p 127.0.0.1:19100 -h "$ROOT/mock" >/tmp/uhttpd-core.log 2>&1 &
i=0
while [ $i -lt 25 ]; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 1 http://127.0.0.1:19100/connections 2>/dev/null)" = "200" ] && break
  i=$((i+1)); sleep 0.2
done
[ $i -lt 25 ] && ok "假 clash API 就绪 (127.0.0.1:19100)" || bad "假 clash API 未就绪"

CLASH_URL='http://127.0.0.1:19100/ui/#/connections?x=1'
TODAY=$(date +%Y-%m-%d)
YDAY=$(date -d "@$(( $(date +%s) - 86400 ))" +%Y-%m-%d 2>/dev/null || echo "2000-01-01")

run_once(){ # $1=state dir $2=daily dir $3=devices file $4=conntrack $5=clash api [$6=polls]
  rm -rf "$1"; mkdir -p "$1"
  env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_ONCE_POLLS="${6:-1}" \
      PRISM_ROUTER_STATE_DIR="$1" PRISM_ROUTER_DAILY_DIR="$2" \
      PRISM_ROUTER_DEVICES_FILE="$3" PRISM_ROUTER_CONNTRACK_FILE="$4" \
      PRISM_ROUTER_CLASH_API="$5" PRISM_ROUTER_DEBUG=1 \
      ucode /usr/bin/prism-routerd >"$1.log" 2>&1
  echo $?
}
run_resume(){ # 软重启：保留 state/daily/devices/baseline，不删目录
  mkdir -p "$1"
  env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_ONCE_POLLS="${6:-1}" \
      PRISM_ROUTER_STATE_DIR="$1" PRISM_ROUTER_DAILY_DIR="$2" \
      PRISM_ROUTER_DEVICES_FILE="$3" PRISM_ROUTER_CONNTRACK_FILE="$4" \
      PRISM_ROUTER_CLASH_API="$5" PRISM_ROUTER_DEBUG=1 \
      ucode /usr/bin/prism-routerd >"$1.log" 2>&1
  echo $?
}
sum_daily(){ # file -> rx|tx|direct_rx|direct_tx|proxy_rx|proxy_tx
  [ -f "$1" ] || { echo "missing"; return; }
  F="$1" ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let t=d.totals??{};
    print(sprintf("%d|%d|%d|%d|%d|%d", int(t.rx??0), int(t.tx??0), int(t.direct_rx??0), int(t.direct_tx??0), int(t.proxy_rx??0), int(t.proxy_tx??0)));' 2>/dev/null
}
state_field(){ # file expression
  jget "$1" "$2"
}
health_field(){ # file field
  jget "$1" "sprintf(\"%s|%d|%s\", d.health.accounting_confidence, int(d.health.clash_deduped??0), join(\";\", d.health.reasons??[]))"
}

# 仅测试用 curl 替身：mode=slow 时 sleep 10 后失败（模拟慢 curl 跨过去重 TTL），
# mode=down 时立即失败，否则把 body 文件当作 200 响应。用 PATH 注入，生产不用。
fake_curl_install(){
  mkdir -p "$ROOT/bin"
  cat > "$ROOT/bin/curl" <<'FCURL'
#!/bin/sh
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -K|-m|-w) shift 2 ;;
    *) shift ;;
  esac
done
mode=$(cat "$TS_TEST_CURL_MODE" 2>/dev/null)
case "$mode" in
  slow) sleep 10; echo 000 ;;
  down) echo 000 ;;
  *) cp "$TS_TEST_CURL_BODY" "$out"; echo 200 ;;
esac
FCURL
  chmod 755 "$ROOT/bin/curl"
}
fake_curl_install

echo "=== 2. 跨软重启：daily 恢复 + baseline 恢复 + 首帧不虚高 ==="
T="$ROOT/t2"; D="$T/daily"; SD="$T/state"; DEV="$T/devices.json"
eq "$(run_once "$SD" "$D" "$DEV" "$ROOT/ct.txt" "$CLASH_URL")" "0" "首次启动退出码 0（全新无 daily/baseline）"
SUM1=$(sum_daily "$D/$TODAY.json")
eq "$SUM1" "16000|1600|8000|800|8000|800" "首次：direct=8000/800 proxy=8000/800（clash 三条 + 独立 conntrack 一条）"
H1=$(health_field "$SD/state.json")
echo "$H1" | grep -q '^exact|2|' && ok "首次：confidence=exact、clash_deduped=2（DIRECT + 非 fake-ip 代理流）" \
  || bad "首次 health=$H1"
RATE1=$(state_field "$SD/state.json" 'sprintf("%d|%d", int(d.totals.rx_rate??0), int(d.totals.tx_rate??0))')
eq "$RATE1" "3200|320" "首次（全新状态）按当前连接累计一次，速率=总量/1s（$RATE1）"

eq "$(run_resume "$SD" "$D" "$DEV" "$ROOT/ct.txt" "$CLASH_URL")" "0" "软重启：第二次启动退出码 0"
SUM2=$(sum_daily "$D/$TODAY.json")
eq "$SUM2" "$SUM1" "软重启后 daily 不重复累加（baseline 差量为 0）"
TOT2=$(state_field "$SD/state.json" 'sprintf("%d|%d", int(d.totals.direct_rx??0)+int(d.totals.proxy_rx??0), int(d.totals.direct_tx??0)+int(d.totals.proxy_tx??0))')
eq "$TOT2" "0|0" "软重启后进程 totals 从 0 开始（历史在 daily 里）"
RATE2=$(state_field "$SD/state.json" 'sprintf("%d|%d", int(d.totals.rx_rate??0), int(d.totals.tx_rate??0))')
eq "$RATE2" "0|0" "软重启首帧无虚高速率（$RATE2）"
grep -q 'daily restored' "$SD.log" && ok "日志确认 daily 恢复" || bad "日志没有 daily 恢复记录"
grep -q 'baseline restored.*clash=ok ct=ok' "$SD.log" && ok "日志确认 baseline 恢复" || bad "日志没有 baseline 恢复记录"

# 坏 baseline：daily 已存在 -> 必须只采样，不重复加
printf 'corrupt {{{ not json\n' > "$SD/baseline.json"
eq "$(run_resume "$SD" "$D" "$DEV" "$ROOT/ct.txt" "$CLASH_URL")" "0" "坏 baseline：启动退出码 0"
eq "$(sum_daily "$D/$TODAY.json")" "$SUM1" "坏 baseline：daily 不被重复累加"
eq "$(state_field "$SD/state.json" 'sprintf("%d|%d", int(d.totals.direct_rx??0)+int(d.totals.proxy_rx??0), int(d.totals.direct_tx??0)+int(d.totals.proxy_tx??0))')" "0|0" \
  "坏 baseline：首帧 prime（totals=0）"

# 过期 baseline：即使内容合法也不能拿旧计数硬减
NOW=$(date +%s)
printf '{"v":1,"ts":%s,"day":"%s","clash_ts":%s,"ct_ts":%s,"clash_prev":{},"ct_prev":{}}\n' \
  "$((NOW-7200))" "$TODAY" "$((NOW-7200))" "$((NOW-7200))" > "$SD/baseline.json"
eq "$(run_resume "$SD" "$D" "$DEV" "$ROOT/ct.txt" "$CLASH_URL")" "0" "过期 baseline：启动退出码 0"
eq "$(sum_daily "$D/$TODAY.json")" "$SUM1" "过期 baseline：daily 不被重复累加"
grep -q 'baseline restored' "$SD.log" && bad "过期 baseline 不应被恢复" || ok "过期 baseline 被拒绝（降级 prime）"

# baseline 里某个源从未采样过（ts=0）：空 map 不能当成「已知没有连接」
printf '{"v":1,"ts":%s,"day":"%s","clash_ts":0,"ct_ts":0,"clash_prev":{},"ct_prev":{}}\n' \
  "$NOW" "$TODAY" > "$SD/baseline.json"
eq "$(run_resume "$SD" "$D" "$DEV" "$ROOT/ct.txt" "$CLASH_URL")" "0" "源 ts=0 baseline：启动退出码 0"
eq "$(sum_daily "$D/$TODAY.json")" "$SUM1" "源 ts=0 baseline：不把现存连接全量补进 daily"
eq "$(state_field "$SD/state.json" 'sprintf("%d", int(d.totals.direct_rx??0)+int(d.totals.proxy_rx??0))')" "0" \
  "源 ts=0 -> 对应数据源 prime（首帧 totals=0）"

# 同 day 但文件里是昨天：不能把昨天 daily 读成今天
TOLD="$ROOT/t2old"; DOLD="$TOLD/daily"; SDOLD="$TOLD/state"
rm -rf "$TOLD"; mkdir -p "$DOLD"
printf '{"day":"%s","ts":%s,"totals":{"direct_rx":999999,"direct_tx":99999,"proxy_rx":0,"proxy_tx":0,"rx":999999,"tx":99999},"devices":[],"apps":[],"nodes":{}}\n' \
  "$YDAY" "$((NOW-86400))" > "$DOLD/$YDAY.json"
eq "$(run_once "$SDOLD" "$DOLD" "$TOLD/devices.json" "$ROOT/ct.txt" "$CLASH_URL")" "0" "旧日 daily 存在时启动退出码 0"
eq "$(sum_daily "$DOLD/$TODAY.json")" "$SUM1" "不误读旧日 daily：今天从 0 起算当前连接"
eq "$(sum_daily "$DOLD/$YDAY.json")" "999999|99999|999999|99999|0|0" "旧日 daily 原样保留（不被今天覆盖）"

echo "=== 2b. baseline 截断：记录真实条数，未覆盖条目恢复时只采样 ==="
# 用测试钩子把上限降到 2（同一段真实逻辑：写时记录 total/truncated，读时按
# 截断标记把没覆盖到的条目 prime）。3 条连接 -> baseline 只放 2 条。
MB="$ROOT/mockbt"; mkdir -p "$MB"
cat > "$MB/connections" <<'BT'
{"connections":[
 {"id":"b1","metadata":{"sourceIP":"192.168.100.101","sourcePort":"41001","host":"b1.example","destinationIP":"1.1.1.1","destinationPort":"443","network":"tcp"},"upload":0,"download":1000,"chains":["DIRECT"]},
 {"id":"b2","metadata":{"sourceIP":"192.168.100.102","sourcePort":"41002","host":"b2.example","destinationIP":"2.2.2.2","destinationPort":"443","network":"tcp"},"upload":0,"download":1000,"chains":["DIRECT"]},
 {"id":"b3","metadata":{"sourceIP":"192.168.100.103","sourcePort":"41003","host":"b3.example","destinationIP":"3.3.3.3","destinationPort":"443","network":"tcp"},"upload":0,"download":1000,"chains":["DIRECT"]}
]}
BT
: > "$ROOT/ct_empty.txt"
/usr/sbin/uhttpd -f -p 127.0.0.1:19101 -h "$MB" >/tmp/uhttpd-bt.log 2>&1 &
MSRV=$!
i=0
while [ $i -lt 25 ]; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 1 http://127.0.0.1:19101/connections 2>/dev/null)" = "200" ] && break
  i=$((i+1)); sleep 0.2
done
BTURL='http://127.0.0.1:19101/connections'

BT1="$ROOT/t2b"; BSD="$BT1/state"; BD="$BT1/daily"; BDEV="$BT1/devices.json"
rm -rf "$BT1"; mkdir -p "$BT1"
env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_BASELINE_MAX_ENTRIES=2 \
    PRISM_ROUTER_STATE_DIR="$BSD" PRISM_ROUTER_DAILY_DIR="$BD" \
    PRISM_ROUTER_DEVICES_FILE="$BDEV" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API="$BTURL" ucode /usr/bin/prism-routerd >"$BT1.log" 2>&1
eq "$?" "0" "baseline 截断：首轮退出码 0"
eq "$(sum_daily "$BD/$TODAY.json")" "3000|0|3000|0|0|0" "截断前：3 条直连流量 3000"
eq "$(jget "$BSD/baseline.json" 'sprintf("%d|%d|%d|%d", int(d.v??0), int(d.clash_total??0), int(d.clash_truncated??0), length(d.clash_prev??{}))')" \
  "3|3|1|2" "baseline 记录 v=3/clash_total=3/clash_truncated=1/实际写入 2 条"
# 所有连接都增长到 2000：被覆盖的 2 条只加差量 1000+1000，未被覆盖的第 3 条
# 若按旧逻辑会全量加 2000（总 7000）；正确结果应为 3000+2000=5000。
cat > "$MB/connections.new" <<'BT'
{"connections":[
 {"id":"b1","metadata":{"sourceIP":"192.168.100.101","sourcePort":"41001","host":"b1.example","destinationIP":"1.1.1.1","destinationPort":"443","network":"tcp"},"upload":0,"download":2000,"chains":["DIRECT"]},
 {"id":"b2","metadata":{"sourceIP":"192.168.100.102","sourcePort":"41002","host":"b2.example","destinationIP":"2.2.2.2","destinationPort":"443","network":"tcp"},"upload":0,"download":2000,"chains":["DIRECT"]},
 {"id":"b3","metadata":{"sourceIP":"192.168.100.103","sourcePort":"41003","host":"b3.example","destinationIP":"3.3.3.3","destinationPort":"443","network":"tcp"},"upload":0,"download":2000,"chains":["DIRECT"]}
]}
BT
mv "$MB/connections.new" "$MB/connections"
env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_BASELINE_MAX_ENTRIES=2 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$BSD" PRISM_ROUTER_DAILY_DIR="$BD" \
    PRISM_ROUTER_DEVICES_FILE="$BDEV" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API="$BTURL" ucode /usr/bin/prism-routerd >"$BT1.resume.log" 2>&1
eq "$?" "0" "baseline 截断：恢复轮退出码 0"
eq "$(sum_daily "$BD/$TODAY.json")" "5000|0|5000|0|0|0" \
  "截断恢复：未覆盖连接只采样，不被全量重加（5000 而不是 7000）"
grep -q 'baseline clash truncated' "$BT1.resume.log" && ok "日志确认 baseline 截断" || bad "日志没有 baseline 截断记录"

# 真实默认阈值负例：8200 条 baseline 只留 8192 条，未被覆盖的第 8199 条
# 恢复时不能把当前累计值全量补进 daily。
BIG="$ROOT/t2big"; BIGD="$BIG/daily"; BIGS="$BIG/state"
rm -rf "$BIG"; mkdir -p "$BIGD" "$BIGS"
F="$BIGD/$TODAY.json" ucode -e '
let fs=require("fs");
let obj={day:getenv("DAY"),ts:time(),totals:{direct_rx:1234,direct_tx:123,rx:1234,tx:123},devices:[],apps:[],nodes:{}};
fs.writefile(getenv("F"), sprintf("%J", obj));' DAY="$TODAY" 2>/dev/null
F="$BIGS/baseline.json" DAY="$TODAY" ucode -e '
let fs=require("fs"); let m={};
for (let i=0;i<8200;i++) m["big-"+i]={rx:100,tx:10};
let o={v:1,ts:time(),day:getenv("DAY"),clash_ts:time(),ct_ts:time(),clash_prev:m,ct_prev:{}};
fs.writefile(getenv("F"), sprintf("%J", o));' DAY="$TODAY" 2>/dev/null
cat > "$MB/connections" <<'BIGCT'
{"connections":[
 {"id":"big-8199","metadata":{"sourceIP":"192.168.100.101","sourcePort":"42001","host":"miss.example","destinationIP":"9.9.9.9","destinationPort":"443","network":"tcp"},"upload":5000,"download":50000,"chains":["DIRECT"]}
]}
BIGCT
env PRISM_ROUTER_ONCE=1 \
    PRISM_ROUTER_STATE_DIR="$BIGS" PRISM_ROUTER_DAILY_DIR="$BIGD" \
    PRISM_ROUTER_DEVICES_FILE="$BIG/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API="$BTURL" PRISM_ROUTER_DEBUG=1 ucode /usr/bin/prism-routerd >"$BIG.log" 2>&1
eq "$?" "0" ">8192 条 baseline：恢复退出码 0"
eq "$(jget "$BIGD/$TODAY.json" 'sprintf("%d|%d", int(d.totals.rx??0), int(d.totals.tx??0))')" "1234|123" \
  ">8192 条 baseline：未覆盖连接不全量重加（daily 保持 1234/123）"
grep -q 'baseline clash truncated' "$BIG.log" && ok "日志确认满 8192 条旧基线按可能截断处理" || bad "满 8192 条旧基线未按截断处理"

echo "=== 2c. 去重 TTL 不采用恢复锚点年龄（600s 旧基线） ==="
# baseline 的 ts 是 600s 前：首轮 dt=600，修复前 TTL=max(10,600*2)=1200s。
# 修复后配置 poll_interval=5 -> clamp dt 到 15s -> ttl=30s。
UCI set prism-router.settings.poll_interval='5'; cfg_commit
cat > "$MB/connections" <<'BT'
{"connections":[
 {"id":"b1","metadata":{"sourceIP":"192.168.100.101","sourcePort":"41001","host":"b1.example","destinationIP":"1.1.1.1","destinationPort":"443","network":"tcp"},"upload":0,"download":1000,"chains":["DIRECT"]},
 {"id":"b2","metadata":{"sourceIP":"192.168.100.102","sourcePort":"41002","host":"b2.example","destinationIP":"2.2.2.2","destinationPort":"443","network":"tcp"},"upload":0,"download":1000,"chains":["DIRECT"]},
 {"id":"b3","metadata":{"sourceIP":"192.168.100.103","sourcePort":"41003","host":"b3.example","destinationIP":"3.3.3.3","destinationPort":"443","network":"tcp"},"upload":0,"download":1000,"chains":["DIRECT"]}
]}
BT
TT="$ROOT/t2ttl"; TTS="$TT/state"; TTD="$TT/daily"
rm -rf "$TT"; mkdir -p "$TTS"
NOWTTL=$(date +%s)
printf '{"v":2,"ts":%s,"day":"%s","clash_ts":%s,"ct_ts":%s,"clash_prev":{},"ct_prev":{},"clash_total":0,"ct_total":0,"clash_truncated":0,"ct_truncated":0}\n' \
  "$((NOWTTL-600))" "$TODAY" "$((NOWTTL-600))" "$((NOWTTL-600))" > "$TTS/baseline.json"
env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$TTS" PRISM_ROUTER_DAILY_DIR="$TTD" \
    PRISM_ROUTER_DEVICES_FILE="$TT/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API="$BTURL" ucode /usr/bin/prism-routerd >"$TT.log" 2>&1
eq "$?" "0" "600s 旧基线：启动退出码 0"
grep -q 'dt=600s' "$TT.log" && ok "首轮 dt 确实来自 600s 旧锚点" || bad "首轮 dt 不是 600s"
grep -q 'clash dedup: entries=6 ttl=30s dt=600s' "$TT.log" \
  && ok "去重 TTL clamp 到 30s（不随锚点放大到 1200s）" \
  || bad "去重 TTL 未 clamp：$(grep 'clash dedup' "$TT.log" | tail -1)"

echo "=== 3. 双源去重 / console URL / 配置降级 ==="
# 以上 t2 的第一次已经验证 DIRECT(2.2.2.2) + 非 fake-ip 代理(4.4.4.4) 都被去重；
# 再用两轮运行验证 TTL 内不会因为两次拉取边界重复计。
T2="$ROOT/t3"; SD2="$T2/state"; D2="$T2/daily"
eq "$(run_once "$SD2" "$D2" "$T2/devices.json" "$ROOT/ct.txt" "$CLASH_URL" 3)" "0" "连续 3 轮退出码 0"
eq "$(sum_daily "$D2/$TODAY.json")" "$SUM1" "连续 3 轮 daily 仍是 16000/1600（TTL 内不重复计）"
eq "$(state_field "$SD2/state.json" 'sprintf("%d", int(d.health.clash_deduped??0))')" "2" "最后一轮 clash_deduped=2"

# URI 注入：路径里的 ;touch 不能执行，origin 仍能连上
TINJ="$ROOT/t3inj"; SDI="$TINJ/state"
rm -f "$ROOT/pwned"
eq "$(run_once "$SDI" "$TINJ/daily" "$TINJ/devices.json" "$ROOT/ct.txt" 'http://127.0.0.1:19100/;touch /tmp/cf/pwned#/x')" "0" "畸形 console URL 启动退出码 0"
[ -e "$ROOT/pwned" ] && bad "URI 注入执行了 shell 命令！" || ok "URI 中的 shell 元字符未执行"
eq "$(jget "$SDI/state.json" 'd.source.clash')" "ok" "console URL 去掉 path/query/hash 后仍连上 clash"

# 缺 acct：conntrack 有 LAN 流但没有任何 bytes= -> degraded，不能 exact
TNA="$ROOT/t3na"; SDNA="$TNA/state"
eq "$(run_once "$SDNA" "$TNA/daily" "$TNA/devices.json" "$ROOT/ct_noacct.txt" '127.0.0.1:1')" "0" "缺 acct 启动退出码 0"
HNA=$(health_field "$SDNA/state.json")
echo "$HNA" | grep -q '^degraded' && ok "缺 acct -> degraded（不冒充 exact）" || bad "缺 acct confidence=$HNA"
echo "$HNA" | grep -q 'bytes' && ok "缺 acct 原因写入 health.reasons" || bad "缺 acct 没有 reason：$HNA"

# 双源不可用：conntrack 文件缺失 + clash 连不上 -> unavailable
TU="$ROOT/t3u"; SDU="$TU/state"
eq "$(run_once "$SDU" "$TU/daily" "$TU/devices.json" "$TU/no-such-conntrack" '127.0.0.1:1')" "0" "双源不可用启动退出码 0"
eq "$(jget "$SDU/state.json" 'd.health.accounting_confidence')" "unavailable" "双源不可用 -> unavailable"
RSTATE="$SDU/state.json" RDAILY="$TU/daily" RDEV="$TU/devices.json"
rpc get_state '{}' > "$TU/gs.json" 2>/dev/null
eq "$(jget "$TU/gs.json" 'd.health.accounting_confidence')" "unavailable" "RPC 白名单保留 unavailable（不降级成 unknown）"

echo "=== 3b. clash 故障跨 TTL：去重续期 + 恢复按旧基线，不双计 ==="
# 正常一轮 -> 关闭 clash 超过 10s TTL -> conntrack 看到流量增长（含一条新建流）
# -> 恢复 clash（计数已增长）。修复前：conntrack 先把增长按 direct 计，clash
# 恢复后又按旧基线把同一段算成 proxy/direct，双计。修复后：故障期间续期已有
# 去重键，恢复只按旧基线补差量，总量等于真实流量。
UCI set prism-router.settings.poll_interval='1'; cfg_commit
cat > "$MB/connections" <<'CT0'
{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.101","sourcePort":"40000","host":"a.example","destinationIP":"1.1.1.1","destinationPort":"443","network":"tcp"},"upload":500,"download":5000,"chains":["US1"]},
 {"id":"c2","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"b.example","destinationIP":"2.2.2.2","destinationPort":"443","network":"tcp"},"upload":700,"download":7000,"chains":["DIRECT"]},
 {"id":"c4","metadata":{"sourceIP":"192.168.100.105","sourcePort":"40004","host":"p.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":300,"download":3000,"chains":["US2"]}
]}
CT0
cat > "$ROOT/ct_fail0.txt" <<'CTF0'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=2.2.2.2 sport=40001 dport=443 packets=1 bytes=700 src=2.2.2.2 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=7000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.105 dst=4.4.4.4 sport=40004 dport=443 packets=1 bytes=300 src=4.4.4.4 dst=192.168.100.105 sport=443 dport=40004 packets=1 bytes=3000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.103 dst=3.3.3.3 sport=40002 dport=443 packets=1 bytes=100 src=3.3.3.3 dst=192.168.100.103 sport=443 dport=40002 packets=1 bytes=1000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.104 dst=198.18.0.9 sport=40003 dport=443 packets=1 bytes=9000 src=198.18.0.9 dst=192.168.100.104 sport=443 dport=40003 packets=1 bytes=90000 [ASSURED] mark=0 use=1
CTF0
cat > "$ROOT/ct_fail1.txt" <<'CTF1'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=2.2.2.2 sport=40001 dport=443 packets=1 bytes=1400 src=2.2.2.2 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=14000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.105 dst=4.4.4.4 sport=40004 dport=443 packets=1 bytes=600 src=4.4.4.4 dst=192.168.100.105 sport=443 dport=40004 packets=1 bytes=6000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.103 dst=3.3.3.3 sport=40002 dport=443 packets=1 bytes=200 src=3.3.3.3 dst=192.168.100.103 sport=443 dport=40002 packets=1 bytes=2000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.106 dst=5.5.5.5 sport=40006 dport=443 packets=1 bytes=200 src=5.5.5.5 dst=192.168.100.106 sport=443 dport=40006 packets=1 bytes=2000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.104 dst=198.18.0.9 sport=40003 dport=443 packets=1 bytes=9000 src=198.18.0.9 dst=192.168.100.104 sport=443 dport=40003 packets=1 bytes=90000 [ASSURED] mark=0 use=1
CTF1
TF="$ROOT/t3fail"; TFS="$TF/state"; TFD="$TF/daily"
rm -rf "$TF"; mkdir -p "$TFS"
env PRISM_ROUTER_STATE_DIR="$TFS" PRISM_ROUTER_DAILY_DIR="$TFD" \
    PRISM_ROUTER_DEVICES_FILE="$TF/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_fail0.txt" \
    PRISM_ROUTER_CLASH_API="$BTURL" PRISM_ROUTER_DEBUG=1 \
    ucode /usr/bin/prism-routerd >"$TF.log" 2>&1 &
TFPID=$!
sleep 2
eq "$(sum_daily "$TFD/$TODAY.json")" "16000|1600|8000|800|8000|800" "故障前：正常一轮 16000/1600"
mv "$MB/connections" "$MB/connections.off"     # clash 下线
sleep 12                                        # 超过 max(10, 2*1)=10s TTL
# conntrack 文件路径保持不变，直接覆盖内容（模拟故障期间流量增长 + 新建连接）。
cp "$ROOT/ct_fail1.txt" "$ROOT/ct_fail0.txt"
cat > "$MB/connections.grown" <<'CT1'
{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.101","sourcePort":"40000","host":"a.example","destinationIP":"1.1.1.1","destinationPort":"443","network":"tcp"},"upload":1000,"download":10000,"chains":["US1"]},
 {"id":"c2","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"b.example","destinationIP":"2.2.2.2","destinationPort":"443","network":"tcp"},"upload":1400,"download":14000,"chains":["DIRECT"]},
 {"id":"c4","metadata":{"sourceIP":"192.168.100.105","sourcePort":"40004","host":"p.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":600,"download":6000,"chains":["US2"]},
 {"id":"c5","metadata":{"sourceIP":"192.168.100.106","sourcePort":"40006","host":"n.example","destinationIP":"5.5.5.5","destinationPort":"443","network":"tcp"},"upload":200,"download":2000,"chains":["DIRECT"]}
]}
CT1
sleep 2
mv "$MB/connections.grown" "$MB/connections"  # clash 恢复（计数已增长）
sleep 2
kill -TERM $TFPID 2>/dev/null
wait $TFPID 2>/dev/null
eq "$(sum_daily "$TFD/$TODAY.json")" "34000|3400|18000|1800|16000|1600" \
  "故障跨 TTL 后恢复：总量 34000/3400 等于真实流量（无 direct/proxy 双计）"
grep -q 'clash dedup renewed on failure' "$TF.log" && ok "日志确认故障期间续期去重键" || bad "故障期间没有续期去重键"
UCI set prism-router.settings.poll_interval='5'; cfg_commit
kill $MSRV 2>/dev/null
wait $MSRV 2>/dev/null

echo "=== 3c. 慢 curl 失败跨 TTL：故障期间保留并续期去重键（终审阻断 1） ==="
# 正常一轮建去重键 -> curl 慢失败 10s（跨过 10s TTL）-> 故障期间 ct 增长 ->
# 恢复 clash。修复前续期用 poll 起始 ctx.now 且删除过期键，conntrack 会先把
# 增量按 direct 记、恢复后 clash 再按旧基线记 proxy，双计。修复后故障全程保留
# 键、从真实 time() 续期，恢复总量等于真实流量。
UCI set prism-router.settings.poll_interval='1'; cfg_commit
FC="$ROOT/fc"; FCS="$FC/state"; FCD="$FC/daily"
rm -rf "$FC"; mkdir -p "$FCS"
FCM="$FC/mode"; FCB="$FC/body.json"; FCCT="$FC/ct"
echo ok > "$FCM"
cat > "$FC/b0.json" <<'FC0'
{"connections":[{"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":100,"download":1000,"chains":["US1"]}]}
FC0
cat > "$FC/b1.json" <<'FC1'
{"connections":[{"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":200,"download":2000,"chains":["US1"]}]}
FC1
cat > "$FC/ct0" <<'FCT0'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=1000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=1000 [ASSURED] mark=0 use=1
FCT0
cat > "$FC/ct1" <<'FCT1'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=2000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=2000 [ASSURED] mark=0 use=1
FCT1
cp "$FC/b0.json" "$FCB"; cp "$FC/ct0" "$FCCT"
env PATH="$ROOT/bin:$PATH" TS_TEST_CURL_MODE="$FCM" TS_TEST_CURL_BODY="$FCB" \
    PRISM_ROUTER_STATE_DIR="$FCS" PRISM_ROUTER_DAILY_DIR="$FCD" \
    PRISM_ROUTER_DEVICES_FILE="$FC/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$FCCT" \
    PRISM_ROUTER_CLASH_API='http://127.0.0.1:19999/connections' PRISM_ROUTER_DEBUG=1 \
    ucode /usr/bin/prism-routerd >"$FC.log" 2>&1 &
FCPID=$!
sleep 2
echo slow > "$FCM"
# 先让慢失败跨过 TTL（旧实现会在这里把键删掉），再把 ct/clash 计数一起推高：
# 这样旧实现的 conntrack 会在键已空之后把增长按 direct 记，恢复 clash 再记 proxy。
sleep 20
cp "$FC/ct1" "$FCCT"
cp "$FC/b1.json" "$FCB"
sleep 12
echo ok > "$FCM"
sleep 16
kill -TERM $FCPID 2>/dev/null
wait $FCPID 2>/dev/null
eq "$(sum_daily "$FCD/$TODAY.json")" "2000|200|0|0|2000|200" \
  "慢 curl 跨 TTL 后恢复：只有 clash 的 2000/200（conntrack 不重复记 direct）"
grep -q 'clash dedup renewed on failure: entries=2' "$FC.log" \
  && ok "慢失败期间去重键被保留并续期（entries=2）" || bad "慢失败期间去重键丢失"
grep -q 'clash outage recovered: outage ledger cleared' "$FC.log" \
  && ok "恢复成功轮清理故障标记" || bad "恢复轮没有清理故障标记"

echo "=== 3d. 故障全程保留 outage 账本：新代理流恢复只按 direct 记一次（终审阻断 2） ==="
# 故障期间新建的代理流，conntrack 先按 direct 记账并写 note；故障超过 TTL 后
# 旧实现会删除 note，恢复时 clash 又把它当新连接全量记 proxy。修复后 note 保存
# 到恢复成功轮，最终只记 direct 一次。
FD="$ROOT/fd"; FDS="$FD/state"; FDD="$FD/daily"
rm -rf "$FD"; mkdir -p "$FDS"
FDM="$FD/mode"; FDB="$FD/body.json"; FDCT="$FD/ct"
echo ok > "$FDM"
cat > "$FD/b0.json" <<'FD0'
{"connections":[{"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":100,"download":1000,"chains":["US1"]}]}
FD0
cat > "$FD/b1.json" <<'FD1'
{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":100,"download":1000,"chains":["US1"]},
 {"id":"c5","metadata":{"sourceIP":"192.168.100.105","sourcePort":"40005","host":"n.example","destinationIP":"5.5.5.5","destinationPort":"443","network":"tcp"},"upload":50,"download":500,"chains":["US2"]}
]}
FD1
cat > "$FD/ct0" <<'FDCT0'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=1000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=1000 [ASSURED] mark=0 use=1
FDCT0
cat > "$FD/ct1" <<'FDCT1'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=1000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=1000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.105 dst=5.5.5.5 sport=40005 dport=443 packets=1 bytes=500 src=5.5.5.5 dst=192.168.100.105 sport=443 dport=40005 packets=1 bytes=500 [ASSURED] mark=0 use=1
FDCT1
cp "$FD/b0.json" "$FDB"; cp "$FD/ct0" "$FDCT"
env PATH="$ROOT/bin:$PATH" TS_TEST_CURL_MODE="$FDM" TS_TEST_CURL_BODY="$FDB" \
    PRISM_ROUTER_STATE_DIR="$FDS" PRISM_ROUTER_DAILY_DIR="$FDD" \
    PRISM_ROUTER_DEVICES_FILE="$FD/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$FDCT" \
    PRISM_ROUTER_CLASH_API='http://127.0.0.1:19999/connections' PRISM_ROUTER_DEBUG=1 \
    ucode /usr/bin/prism-routerd >"$FD.log" 2>&1 &
FDPID=$!
sleep 2
echo down > "$FDM"
cp "$FD/ct1" "$FDCT"
cp "$FD/b1.json" "$FDB"
sleep 3
eq "$(state_field "$FDS/state.json" 'sprintf("%d|%d", int(d.totals.direct_rx??0), int(d.totals.proxy_rx??0))')" "500|1000" \
  "故障期新流先按 direct 记一次（500），既有代理流仍为 1000"
sleep 12
echo ok > "$FDM"
sleep 5
kill -TERM $FDPID 2>/dev/null
wait $FDPID 2>/dev/null
eq "$(sum_daily "$FDD/$TODAY.json")" "1500|600|500|500|1000|100" \
  "故障跨 TTL 恢复：新流只记 direct 500，clash 不再全量补 proxy"
grep -q 'outage ledger cleared' "$FD.log" \
  && ok "恢复成功轮才清理 outage 账本" || bad "恢复轮没有清理 outage 账本"

echo "=== 3e. 故障中重启：dedup/outage 账本随 baseline 持久化，重启后不双计（终审阻断 3） ==="
# 正常 -> 停机 -> 故障期新建流（direct 已记）-> 停机 -> 故障中重启（ct 继续增长）
# -> 恢复 clash。修复前 dedup/outage 不持久化：重启后既有代理流被按 direct 再记，
# 恢复后又按旧基线记 proxy；新流也会被全量补。修复后全程总量正确。
FE="$ROOT/fe"; FES="$FE/state"; FED="$FE/daily"
rm -rf "$FE"; mkdir -p "$FES"
FEM="$FE/mode"; FEB="$FE/body.json"; FECT="$FE/ct"
echo ok > "$FEM"
cat > "$FE/b0.json" <<'FE0'
{"connections":[{"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":100,"download":1000,"chains":["US1"]}]}
FE0
cat > "$FE/b1.json" <<'FE1'
{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":100,"download":1000,"chains":["US1"]},
 {"id":"c5","metadata":{"sourceIP":"192.168.100.105","sourcePort":"40005","host":"n.example","destinationIP":"5.5.5.5","destinationPort":"443","network":"tcp"},"upload":50,"download":500,"chains":["US2"]}
]}
FE1
cat > "$FE/b2.json" <<'FE2'
{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.102","sourcePort":"40001","host":"a.example","destinationIP":"4.4.4.4","destinationPort":"443","network":"tcp"},"upload":200,"download":2000,"chains":["US1"]},
 {"id":"c5","metadata":{"sourceIP":"192.168.100.105","sourcePort":"40005","host":"n.example","destinationIP":"5.5.5.5","destinationPort":"443","network":"tcp"},"upload":80,"download":800,"chains":["US2"]}
]}
FE2
cat > "$FE/ct0" <<'FECT0'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=1000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=1000 [ASSURED] mark=0 use=1
FECT0
cat > "$FE/ct1" <<'FECT1'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=1000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=1000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.105 dst=5.5.5.5 sport=40005 dport=443 packets=1 bytes=500 src=5.5.5.5 dst=192.168.100.105 sport=443 dport=40005 packets=1 bytes=500 [ASSURED] mark=0 use=1
FECT1
cat > "$FE/ct2" <<'FECT2'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=4.4.4.4 sport=40001 dport=443 packets=1 bytes=2000 src=4.4.4.4 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=2000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.105 dst=5.5.5.5 sport=40005 dport=443 packets=1 bytes=800 src=5.5.5.5 dst=192.168.100.105 sport=443 dport=40005 packets=1 bytes=800 [ASSURED] mark=0 use=1
FECT2
fe_start(){ # $1=log；exec 让后台 PID 就是 ucode，TERM 才能真正触发优雅停止
  exec env PATH="$ROOT/bin:$PATH" TS_TEST_CURL_MODE="$FEM" TS_TEST_CURL_BODY="$FEB" \
      PRISM_ROUTER_STATE_DIR="$FES" PRISM_ROUTER_DAILY_DIR="$FED" \
      PRISM_ROUTER_DEVICES_FILE="$FE/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$FECT" \
      PRISM_ROUTER_CLASH_API='http://127.0.0.1:19999/connections' PRISM_ROUTER_DEBUG=1 \
      ucode /usr/bin/prism-routerd >>"$1" 2>&1
}
cp "$FE/b0.json" "$FEB"; cp "$FE/ct0" "$FECT"
fe_start "$FE/d1.log" & FEP1=$!
sleep 2
kill -TERM $FEP1 2>/dev/null; wait $FEP1 2>/dev/null
echo down > "$FEM"
cp "$FE/b1.json" "$FEB"; cp "$FE/ct1" "$FECT"
fe_start "$FE/d2.log" & FEP2=$!
sleep 3
kill -TERM $FEP2 2>/dev/null; wait $FEP2 2>/dev/null
eq "$(jget "$FES/baseline.json" 'sprintf("%d|%d|%d|%d|%d", int(d.v??0), (d.clash_outage_active==true)?1:0, (d.clash_outage_had==true)?1:0, length(keys(d.clash_dedup??{})), length(keys(d.clash_outage??{})))')" \
  "3|1|1|2|4" "baseline v3 持久化 dedup=2/outage=4/active/had（有版本与上限结构）"
cp "$FE/b2.json" "$FEB"; cp "$FE/ct2" "$FECT"
fe_start "$FE/d3.log" & FEP3=$!
sleep 3
echo ok > "$FEM"
sleep 5
kill -TERM $FEP3 2>/dev/null; wait $FEP3 2>/dev/null
eq "$(sum_daily "$FED/$TODAY.json")" "2800|1000|800|800|2000|200" \
  "故障中重启后恢复：总量 2800/1000 = 真实流量（既有代理流不双计）"
grep -q 'baseline dedup restored: dedup=2 outage=4 active=1 had=1' "$FE/d3.log" \
  && ok "重启日志确认 dedup/outage 账本从 baseline 恢复" || bad "重启没有恢复 dedup/outage 账本"
grep -q 'clash outage recovered: outage ledger cleared' "$FE/d3.log" \
  && ok "重启后的恢复成功轮清理故障账本" || bad "重启后恢复轮没有清理故障账本"

echo "=== 4. get_history：31 天/288 桶 <180KiB，summary 轻量，跳过未来/非法日 ==="
RT="$ROOT/rpc"; RSTATE="$RT/state/state.json"; RDAILY="$RT/daily"; RDEV="$RT/devices.json"
rm -rf "$RT"; mkdir -p "$RT/state" "$RT/daily"
mkdir -p /tmp/prism-router
F="$RDAILY" O="$RSTATE" ucode -e '
let fs=require("fs"); let dir=getenv("F"); let now=time(); let t=localtime(now);
let today=sprintf("%04d-%02d-%02d", t.year, t.mon, t.mday);
for (let k=0; k<31; k++) {
  let ts=now-k*86400; let d=localtime(ts);
  let day=sprintf("%04d-%02d-%02d", d.year, d.mon, d.mday);
  let devs=[]; for (let i=0;i<200;i++) push(devs,{ip:"192.168.100."+(i%250),mac:sprintf("aa:bb:cc:dd:%02x:%02x", int(i/256), i%256),rx:i*1000,tx:i*10});
  let apps=[]; for (let i=0;i<50;i++) push(apps,{host:"host"+i+".example.com",rx:i*10000,tx:i*100,chain:"DIRECT",devices:5});
  let nodes={}; for (let i=0;i<40;i++) nodes["N"+i]={rx:i*100,tx:i*10};
  let obj={day:day,ts:ts,totals:{direct_rx:1000000,direct_tx:10000,proxy_rx:2000000,proxy_tx:20000,rx:3000000,tx:30000},nodes:nodes,devices:devs,apps:apps};
  fs.writefile(dir+"/"+day+".json", sprintf("%J",obj));
}
let hist=[]; for (let i=0;i<288;i++) push(hist,{ts:now-288*300+i*300,direct_rx:1000+i,direct_tx:100,proxy_rx:2000+i,proxy_tx:200,wifi_rx:1,wifi_tx:1,wired_rx:2,wired_tx:2,top_apps:[{host:"x",rx:1,tx:1}],top_devices:[{ip:"1",rx:1,tx:1}]});
fs.writefile("/tmp/prism-router/history.json", sprintf("%J",{day:today,buckets:hist}));
let st={ts:now,uptime:10,source:{clash:"ok",conntrack:"ok"},totals:{direct_rx:1,direct_tx:1,proxy_rx:1,proxy_tx:1},nodes:{},devices:[],apps:[],health:{accounting_confidence:"unavailable",reasons:["synthetic"],clash_deduped:7}};
fs.writefile(getenv("O"), sprintf("%J",st));
' 2>/dev/null
# 未来日期 + 非法日期文件
FUT=$(F="$RDAILY" ucode -e 'let fs=require("fs"); let t=localtime(time()+86400); print(sprintf("%04d-%02d-%02d", t.year, t.mon, t.mday));' 2>/dev/null)
printf '{"day":"%s","totals":{"rx":777777,"tx":77777}}\n' "$FUT" > "$RDAILY/$FUT.json"
printf '{"day":"2026-13-40","totals":{"rx":888888,"tx":88888}}\n' > "$RDAILY/2026-13-40.json"
rpc get_history '{"days":31}' > "$RT/h.json" 2>/dev/null
HSZ=$(wc -c < "$RT/h.json")
[ "$HSZ" -lt 184320 ] && ok "get_history 31 天体积 $HSZ B < 184320" || bad "get_history 超预算：$HSZ B"
HPROBE=$(F="$RT/h.json" ucode -e '
let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
let n=length(d.days); let tr=(d.truncated==null)?"missing":((d.truncated==true)?"1":"0");
let buckets=0; let sums=0; let bad=0; let future=0; let invalid=0;
for (let x in d.days) {
  buckets += length(x.buckets??[]);
  if (x.summary != null) { sums++; if (type(x.summary.devices)=="array" || type(x.summary.apps)=="array") bad=1; if (x.summary.totals==null) bad=1; }
  if (x.day > getenv("TODAY")) future=1;
  if (x.day == "2026-13-40") invalid=1;
  for (let b in (x.buckets??[])) if (b.top_apps != null || b.top_devices != null) bad=1;
}
print(sprintf("%d|%d|%s|%d|%d|%d|%d", n, buckets, tr, sums, bad, future, invalid));' TODAY="$TODAY")
OLDIFS=$IFS; IFS='|'; set -- $HPROBE; IFS=$OLDIFS
eq "$1" "31" "get_history 返回 31 天"
eq "$2" "288" "history.json 的 288 个桶全部保留（已瘦身）"
[ "$3" = "0" ] || [ "$3" = "1" ] && ok "truncated 是布尔标志（$3）" || bad "truncated 标志缺失：$3"
[ "$4" -ge 30 ] && ok "30/31 天有轻量 summary（$4 天）" || bad "summary 天数不足：$4"
eq "$5" "0" "summary 不含 devices/apps 数组、桶不含 top_* 重字段"
eq "$6" "0" "未来日期被跳过"
eq "$7" "0" "非法日期 2026-13-40 被跳过"
RSTATE="$RSTATE" RDAILY="$RDAILY" RDEV="$RDEV" rpc get_daily "{\"day\":\"$TODAY\"}" > "$RT/d.json" 2>/dev/null
R=$(jget "$RT/d.json" 'sprintf("%d|%d", length(d.devices??[]), length(d.apps??[]))')
eq "$R" "200|50" "get_daily 仍返回完整 200 设备/50 应用（兼容）"

# 月总账：daily totals 优先；devices 行（截断）不能主导
MT="$ROOT/month"; MD="$MT/daily"; MSTATE="$MT/state.json"
rm -rf "$MT"; mkdir -p "$MD"
F="$MD/$TODAY.json" ucode -e '
let fs=require("fs");
let obj={day:getenv("DAY"),ts:time(),totals:{direct_rx:1000,direct_tx:100,proxy_rx:0,proxy_tx:0,rx:1000,tx:100},devices:[{ip:"192.168.100.2",mac:"aa:bb:cc:dd:ee:02",rx:10,tx:1}],apps:[],nodes:{}};
fs.writefile(getenv("F"), sprintf("%J",obj));' DAY="$TODAY" 2>/dev/null
printf '{"ts":%s,"totals":{},"health":{"accounting_confidence":"exact"},"devices":[],"apps":[]}\n' "$(date +%s)" > "$MSTATE"
RSTATE="$MSTATE" RDAILY="$MD" RDEV="$MT/devices.json" rpc get_state '{}' > "$MT/gs.json" 2>/dev/null
R=$(jget "$MT/gs.json" 'sprintf("%d", int(d.totals.month_total??0))')
eq "$R" "1100" "month_scan 总账用 daily totals（1000+100），不是截断 devices 行的 11"

# totals 是空对象 {}：必须回退到 devices 行求和（老文件兼容）。
MT2="$ROOT/month-empty"; MD2="$MT2/daily"; MSTATE2="$MT2/state.json"
rm -rf "$MT2"; mkdir -p "$MD2"
F="$MD2/$TODAY.json" ucode -e '
let fs=require("fs");
let obj={day:getenv("DAY"),ts:time(),totals:{},devices:[{ip:"192.168.100.2",mac:"aa:bb:cc:dd:ee:02",rx:10,tx:1}],apps:[],nodes:{}};
fs.writefile(getenv("F"), sprintf("%J",obj));' DAY="$TODAY" 2>/dev/null
printf '{"ts":%s,"totals":{},"health":{"accounting_confidence":"exact"},"devices":[],"apps":[]}\n' "$(date +%s)" > "$MSTATE2"
RSTATE="$MSTATE2" RDAILY="$MD2" RDEV="$MT2/devices.json" rpc get_state '{}' > "$MT2/gs.json" 2>/dev/null
R=$(jget "$MT2/gs.json" 'sprintf("%d", int(d.totals.month_total??0))')
eq "$R" "11" "totals 空对象时月总账回退 devices 行（10+1=11）"

# totals 有有效 rx/tx（即使都是 0）：总账有效，不用 devices 行。
MT3="$ROOT/month-zero"; MD3="$MT3/daily"; MSTATE3="$MT3/state.json"
rm -rf "$MT3"; mkdir -p "$MD3"
F="$MD3/$TODAY.json" ucode -e '
let fs=require("fs");
let obj={day:getenv("DAY"),ts:time(),totals:{rx:0,tx:0},devices:[{ip:"192.168.100.2",mac:"aa:bb:cc:dd:ee:02",rx:10,tx:1}],apps:[],nodes:{}};
fs.writefile(getenv("F"), sprintf("%J",obj));' DAY="$TODAY" 2>/dev/null
printf '{"ts":%s,"totals":{},"health":{"accounting_confidence":"exact"},"devices":[],"apps":[]}\n' "$(date +%s)" > "$MSTATE3"
RSTATE="$MSTATE3" RDAILY="$MD3" RDEV="$MT3/devices.json" rpc get_state '{}' > "$MT3/gs.json" 2>/dev/null
R=$(jget "$MT3/gs.json" 'sprintf("%d", int(d.totals.month_total??0))')
eq "$R" "0" "totals 有效 rx=0/tx=0 时不回退 devices 行（月总账 0）"

echo "=== 5. set_config：argv 无 shell / 失败回滚 staged UCI / 严格 is_root ==="
R=$(rpc set_config '{"section":"settings","options":"{\"poll_interval\":\"9\",\"metrics_token\":\"$(touch /tmp/cf/pwned2)\"}"}')
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "set_config 合法字段写入成功" || bad "set_config 失败：$R"
eq "$(CGET prism-router.settings.metrics_token)" '$(touch /tmp/cf/pwned2)' "注入串被当作字面值写入（argv 数组）"
[ -e "$ROOT/pwned2" ] && bad "set_config 执行了注入命令！" || ok "set_config 未执行注入命令"
BEFORE=$(CGET prism-router.settings.poll_interval)
LONG=$(awk 'BEGIN{for(i=0;i<2000;i++)printf "x"}')
printf '{"section":"settings","options":"{\\"poll_interval\\":\\"7\\",\\"clash_secret\\":\\"%s\\"}"}\n' "$LONG" > "$ROOT/badargs.json"
R=$(env PRISM_ROUTER_METHOD=set_config PRISM_ROUTER_ARGS="$(cat "$ROOT/badargs.json")" \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$R" | grep -q '过长' && ok "超长字段被拒绝" || bad "超长字段未被拒绝：$R"
eq "$(CGET prism-router.settings.poll_interval)" "$BEFORE" "失败回滚：poll_interval 未被改成 7"
[ -z "$(uci changes prism-router 2>/dev/null)" ] && ok "失败后没有残留 staged UCI" || bad "残留 staged UCI：$(uci changes prism-router)"

# 别的字段/别的写者已经 staged 的改动必须保留：预置 history_days=77，
# 本次调用也写 history_days=42 但随后失败，恢复应把 77 原样放回，而不是
# 整段 revert 或用 42 覆盖。
UCI set prism-router.settings.history_days='77'
printf '{"section":"settings","options":"{\\"poll_interval\\":\\"7\\",\\"history_days\\":\\"42\\",\\"clash_secret\\":\\"%s\\"}"}\n' "$LONG" > "$ROOT/badargs2.json"
R=$(env PRISM_ROUTER_METHOD=set_config PRISM_ROUTER_ARGS="$(cat "$ROOT/badargs2.json")" \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$R" | grep -q '过长' && ok "带预置 staged 字段的失败调用被拒绝" || bad "失败调用未被拒绝：$R"
eq "$(CGET prism-router.settings.history_days)" "77" "预置 staged 的 history_days 保持 77（未被误清/覆盖）"
uci changes prism-router 2>/dev/null | grep -q "settings.history_days='77'" \
  && ok "history_days 仍是 staged 且值正确" || bad "history_days staged 丢失：$(uci changes prism-router)"
eq "$(CGET prism-router.settings.poll_interval)" "$BEFORE" "失败回滚：本次 poll_interval 未生效"
UCI revert prism-router.settings.history_days
[ -z "$(uci changes prism-router 2>/dev/null)" ] && ok "预置字段清理后无残留 staged UCI" || bad "清理后仍有 staged：$(uci changes prism-router)"
# 终审阻断 4：别人已经 staged 删除（uci changes 里是 `-section.option`，没有 `=`）
# 时，本次 set 冲突失败的回滚必须把删除意图放回去，不能 revert 成已提交值。
UCI set prism-router.settings.clash_secret='committed-secret'; cfg_commit
uci delete prism-router.settings.clash_secret >/dev/null 2>&1
uci changes prism-router 2>/dev/null | grep -q "^-prism-router.settings.clash_secret$" \
  && ok "预置 staged 删除（delete 行无 =）" || bad "预置 staged 删除失败：$(uci changes prism-router)"
LONG2=$(awk 'BEGIN{for(i=0;i<2000;i++)printf "z"}')
printf '{"section":"settings","options":"{\\"clash_secret\\":\\"new-secret\\",\\"metrics_token\\":\\"%s\\"}"}\n' "$LONG2" > "$ROOT/badargs3.json"
R=$(env PRISM_ROUTER_METHOD=set_config PRISM_ROUTER_ARGS="$(cat "$ROOT/badargs3.json")" \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$R" | grep -q '过长' && ok "带 staged 删除的冲突调用被拒绝" || bad "冲突调用未被拒绝：$R"
CH=$(uci changes prism-router 2>/dev/null)
echo "$CH" | grep -q "^-prism-router.settings.clash_secret$" \
  && ok "失败回滚后删除仍 staged（保留原删除意图）" || bad "删除意图丢失：$CH"
echo "$CH" | grep -q "clash_secret='new-secret'" \
  && bad "回滚残留本次 set 行：$CH" || ok "回滚没有残留本次 set"
eq "$(CGET prism-router.settings.clash_secret)" "" "staged 删除生效：读取为空"
UCI revert prism-router.settings.clash_secret
[ -z "$(uci changes prism-router 2>/dev/null)" ] && ok "删除意图清理后无残留 staged UCI" \
  || bad "删除意图清理后仍有 staged：$(uci changes prism-router)"
UCI delete prism-router.settings.clash_secret; cfg_commit

sed 's/user: .root./user: "guest"/' /usr/share/rpcd/ucode/prism-router.uc > "$ROOT/guest.uc"
sed 's/user: .root./user: null/' /usr/share/rpcd/ucode/prism-router.uc > "$ROOT/nouser.uc"
for u in guest nouser; do
  R=$(env PRISM_ROUTER_METHOD=set_config PRISM_ROUTER_ARGS='{"section":"settings","options":"{\"poll_interval\":\"8\"}"}' \
      ucode -L /usr/lib/ucode "$ROOT/$u.uc" 2>/dev/null)
  echo "$R" | grep -q 'permission denied' && ok "is_root 严格拒绝 $u" || bad "is_root 未拒绝 $u：$R"
done
R=$(rpc set_config '{"section":"settings","options":"{\"poll_interval\":\"5\"}"}')
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "已授权调试入口仍可用（root）" || bad "调试入口回归：$R"

echo "=== 6. devices.json：并发 / 陈旧锁 / daemon+rpcd 双写者 ==="
DD="$ROOT/dev"; DDEV="$DD/devices.json"
rm -rf "$DD"; mkdir -p "$DD"
i=0
PIDS=""
while [ $i -lt 20 ]; do
  m=$(printf '02:00:00:00:01:%02x' $i)
  env PRISM_ROUTER_METHOD=set_device_meta PRISM_ROUTER_DEVICES_FILE="$DDEV" \
      PRISM_ROUTER_ARGS="{\"mac\":\"$m\",\"alias\":\"a$i\"}" \
      ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc >/dev/null 2>>"$ROOT/dev.err" &
  PIDS="$PIDS $!"
  i=$((i+1))
done
wait $PIDS
eq "$(F="$DDEV" ucode -e 'let fs=require("fs"); print(length(keys(json(fs.readfile(getenv("F"))))));' 2>/dev/null)" "20" "20 个并发 set_device_meta 全部保留（实际互斥锁）"
[ -z "$(ls "$DD" | grep -E '\.tmp|\.lock' || true)" ] && ok "无 .tmp/.lock 残留" || bad "并发后残留：$(ls "$DD")"
mkdir -p "$DDEV.lock"
touch -t 202001010000 "$DDEV.lock" 2>/dev/null || true
R=$(env PRISM_ROUTER_METHOD=set_device_meta PRISM_ROUTER_DEVICES_FILE="$DDEV" \
    PRISM_ROUTER_ARGS='{"mac":"02:00:00:00:01:ff","alias":"stale"}' \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "陈旧 mkdir 锁被回收" || bad "陈旧锁未恢复：$R"
[ -d "$DDEV.lock" ] && bad "陈旧锁仍残留" || ok "陈旧锁已删除"
eq "$(F="$DDEV" ucode -e 'let fs=require("fs"); print(length(keys(json(fs.readfile(getenv("F"))))));' 2>/dev/null)" "21" "陈旧锁恢复后写入成功（21 条）"

# 带 owner 的陈旧锁：回收者必须 rename 到自己唯一 stale 路径再删（并发只有一个
# 成功），释放时校验 owner。先做单写者回收，再做 8 并发回收 + 写。
mkdir -p "$DDEV.lock"
printf '999999|0|0|1\n' > "$DDEV.lock/owner"
touch -t 202001010000 "$DDEV.lock" 2>/dev/null || true
R=$(env PRISM_ROUTER_METHOD=set_device_meta PRISM_ROUTER_DEVICES_FILE="$DDEV" \
    PRISM_ROUTER_ARGS='{"mac":"02:00:00:00:01:fe","alias":"staleowner"}' \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "带 owner 的陈旧锁被回收" || bad "带 owner 陈旧锁未恢复：$R"
[ -e "$DDEV.lock" ] && bad "带 owner 陈旧锁仍残留" || ok "带 owner 陈旧锁目录已清掉"
eq "$(F="$DDEV" ucode -e 'let fs=require("fs"); print(length(keys(json(fs.readfile(getenv("F"))))));' 2>/dev/null)" "22" "owner 陈旧锁恢复后写入成功（22 条）"

mkdir -p "$DDEV.lock"
printf '999998|0|0|2\n' > "$DDEV.lock/owner"
touch -t 202001010000 "$DDEV.lock" 2>/dev/null || true
PIDS=""
i=0
while [ $i -lt 8 ]; do
  m=$(printf '02:00:00:00:02:%02x' $i)
  env PRISM_ROUTER_METHOD=set_device_meta PRISM_ROUTER_DEVICES_FILE="$DDEV" \
      PRISM_ROUTER_ARGS="{\"mac\":\"$m\",\"alias\":\"r$i\"}" \
      ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc >/dev/null 2>>"$ROOT/dev.err" &
  PIDS="$PIDS $!"
  i=$((i+1))
done
wait $PIDS
eq "$(F="$DDEV" ucode -e 'let fs=require("fs"); print(length(keys(json(fs.readfile(getenv("F"))))));' 2>/dev/null)" "30" "8 并发回收陈旧锁后写入全部保留（30 条）"
[ -z "$(ls "$DD" | grep -E '\.tmp|\.lock' || true)" ] && ok "并发回收后无 .tmp/.lock/stale 残留" || bad "并发回收后残留：$(ls "$DD")"

# 释放校验 owner：锁被别的写者持有（不是陈旧）时，本次调用必须超时失败，
# 且不能删除别人的锁/owner。
mkdir -p "$DDEV.lock"
printf 'other-owner|1|2|3\n' > "$DDEV.lock/owner"
R=$(env PRISM_ROUTER_METHOD=set_device_meta PRISM_ROUTER_DEVICES_FILE="$DDEV" \
    PRISM_ROUTER_ARGS='{"mac":"02:00:00:00:03:01","alias":"otherheld"}' \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$R" | grep -q '设备元数据忙' && ok "他人持有的锁导致本次写失败（不无锁覆盖）" || bad "他人持锁时仍写入：$R"
eq "$(cat "$DDEV.lock/owner" 2>/dev/null)" "other-owner|1|2|3" "失败释放没有删除/改写他人的 owner"
eq "$(F="$DDEV" ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(d["02:00:00:00:03:01"]==null?"absent":"present");' 2>/dev/null)" "absent" "他人持锁时未写入 devices.json"
rm -rf "$DDEV.lock"


# daemon + rpcd 双写者：daemon 写 first_seen，rpcd 同时写 alias，双方都不丢
DW="$ROOT/dev2"; DWD="$DW/state"; DWDV="$DW/devices.json"
rm -rf "$DW"; mkdir -p "$DWD"
env PRISM_ROUTER_STATE_DIR="$DWD" PRISM_ROUTER_DAILY_DIR="$DW/daily" \
    PRISM_ROUTER_DEVICES_FILE="$DWDV" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct.txt" \
    PRISM_ROUTER_CLASH_API="$CLASH_URL" ucode /usr/bin/prism-routerd >"$DW/daemon.log" 2>&1 &
DPID=$!
sleep 1
env PRISM_ROUTER_METHOD=set_device_meta PRISM_ROUTER_DEVICES_FILE="$DWDV" \
    PRISM_ROUTER_ARGS='{"mac":"aa:bb:cc:dd:ee:01","alias":"并发别名"}' \
    ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc >/dev/null 2>>"$ROOT/dev.err"
sleep 1
kill -TERM $DPID 2>/dev/null
wait $DPID 2>/dev/null
R=$(F="$DWDV" ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let e=d["aa:bb:cc:dd:ee:01"]??{}; print(sprintf("%s|%s", e.alias??"", (e.first_seen??0)>0?"seen":"missing"));' 2>/dev/null)
eq "$R" "并发别名|seen" "daemon first_seen 与 rpcd alias 同时保留（无丢更新）"

echo "=== 7. 日切写失败：pending 快照保留并重试 ==="
UCI set prism-router.settings.poll_interval='1'; cfg_commit
RW="$ROOT/roll"; RD="$RW/daily"; RSD="$RW/state"
rm -rf "$RW"; mkdir -p "$RSD"
printf 'block\n' > "$RD"   # daily 路径先是普通文件 -> mkpath 必失败
NOW2=$(date +%s)
printf '{"v":1,"ts":%s,"day":"%s","clash_ts":%s,"ct_ts":%s,"clash_prev":{},"ct_prev":{}}\n' \
  "$NOW2" "$TODAY" "$NOW2" "$NOW2" > "$RSD/baseline.json"
env PRISM_ROUTER_TEST_ROLLOVER_AFTER=2 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$RSD" PRISM_ROUTER_DAILY_DIR="$RD" \
    PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct.txt" PRISM_ROUTER_CLASH_API="$CLASH_URL" \
    ucode /usr/bin/prism-routerd >"$RW/daemon.log" 2>&1 &
RPID=$!
sleep 3
rm -f "$RD"; mkdir -p "$RD"
sleep 7
kill -TERM $RPID 2>/dev/null
wait $RPID 2>/dev/null
[ -f "$RD/2000-01-01.json" ] && ok "日切失败后 pending 快照被重试落盘（2000-01-01.json）" || bad "pending 快照没有落盘"
R=$(sum_daily "$RD/2000-01-01.json")
eq "$R" "16000|1600|8000|800|8000|800" "pending 快照保留完整日切数据（16000/1600）"
grep -q 'pending daily retry failed' "$RW/daemon.log" && ok "日志确认首次日切写失败" || bad "日志没有日切失败记录"
grep -q 'pending daily written' "$RW/daemon.log" && ok "日志确认 pending 重试成功" || bad "日志没有 pending 重试成功记录"
[ -f "$RD/$TODAY.json" ] && ok "优雅停止写入今日 daily（flush_all）" || bad "优雅停止没有写今日 daily"
[ -f "$RSD/baseline.json" ] && ok "优雅停止保存 baseline" || bad "优雅停止没有 baseline"

# pending 快照必须跨进程重启可恢复：第一次 daily 写失败（daily 路径是文件）
# 后直接 kill 进程，pending-daily.json 应已持久化；修好 daily 目录后重启，
# 启动恢复 pending 并重试落盘。
RR="$ROOT/rollrestart"; RRD="$RR/daily"; RRSD="$RR/state"
rm -rf "$RR"; mkdir -p "$RRSD"
printf 'block\n' > "$RRD"
NOW3=$(date +%s)
printf '{"v":2,"ts":%s,"day":"%s","clash_ts":%s,"ct_ts":%s,"clash_prev":{},"ct_prev":{},"clash_total":0,"ct_total":0,"clash_truncated":0,"ct_truncated":0}\n' \
  "$NOW3" "$TODAY" "$NOW3" "$NOW3" > "$RRSD/baseline.json"
env PRISM_ROUTER_TEST_ROLLOVER_AFTER=2 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$RRSD" PRISM_ROUTER_DAILY_DIR="$RRD" \
    PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct.txt" PRISM_ROUTER_CLASH_API="$CLASH_URL" \
    ucode /usr/bin/prism-routerd >"$RR/daemon1.log" 2>&1 &
RRPID=$!
sleep 3
kill -TERM $RRPID 2>/dev/null
wait $RRPID 2>/dev/null
[ -f "$RRSD/pending-daily.json" ] && ok "日切失败后 pending-daily.json 已持久化到 state_dir" || bad "pending-daily.json 未持久化"
R=$(F="$RRSD/pending-daily.json" ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let x=(d.days??{})["2000-01-01"]??{}; let t=x.totals??{}; print(sprintf("%s|%d|%d", x.day??"", int(t.rx??0), int(t.tx??0)));' 2>/dev/null)
eq "$R" "2000-01-01|16000|1600" "持久化 pending 保留完整日切数据"
rm -f "$RRD"; mkdir -p "$RRD"
env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$RRSD" PRISM_ROUTER_DAILY_DIR="$RRD" \
    PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct.txt" PRISM_ROUTER_CLASH_API="$CLASH_URL" \
    ucode /usr/bin/prism-routerd >"$RR/daemon2.log" 2>&1
eq "$?" "0" "pending 恢复：重启退出码 0"
grep -q 'pending daily restored' "$RR/daemon2.log" && ok "重启日志确认 pending 恢复" || bad "重启没有 pending 恢复记录"
[ -f "$RRD/2000-01-01.json" ] && ok "重启后 pending 被重试落盘（2000-01-01.json）" || bad "重启后 pending 没有落盘"
eq "$(sum_daily "$RRD/2000-01-01.json")" "16000|1600|8000|800|8000|800" "重启恢复的日切数据完整（16000/1600）"
[ -f "$RRSD/pending-daily.json" ] && bad "pending-daily.json 落盘后未清除" || ok "pending-daily.json 落盘后已清除"

echo "=== 8. 安全边界：pending day 只收合法日期 / baseline 有界且拒绝超大数据 ==="
# pending-daily.json 来自磁盘，day 字段是文件名的一部分：必须严格 YYYY-MM-DD，
# 不能接受 `../../pwned` 之类路径；非法日期跳过，合法日期照常恢复。
PT="$ROOT/trav"; PTS="$PT/state"; PTD="$PT/daily"
rm -rf "$PT"; mkdir -p "$PTS"
NOWP=$(date +%s)
cat > "$PTS/pending-daily.json" <<PEND
{"v":1,"ts":$NOWP,"days":{
 "../../pwned":{"day":"../../pwned","totals":{"rx":1,"tx":1}},
 "2026-13-40":{"day":"2026-13-40","totals":{"rx":2,"tx":2}},
 "$TODAY":{"day":"$TODAY","totals":{"rx":100,"tx":10}}
}}
PEND
echo down > "$ROOT/trav.mode"
printf '' > "$ROOT/trav.body"
env PATH="$ROOT/bin:$PATH" TS_TEST_CURL_MODE="$ROOT/trav.mode" TS_TEST_CURL_BODY="$ROOT/trav.body" \
    PRISM_ROUTER_ONCE=1 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$PTS" PRISM_ROUTER_DAILY_DIR="$PTD" \
    PRISM_ROUTER_DEVICES_FILE="$PT/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API='http://127.0.0.1:19999/connections' \
    ucode /usr/bin/prism-routerd >"$PT.log" 2>&1
eq "$?" "0" "非法 pending day：启动退出码 0"
grep -q 'pending daily rejected: invalid day' "$PT.log" \
  && ok "非法 pending day 被拒绝" || bad "非法 pending day 没有被拒绝"
grep -q "pending daily written: $TODAY" "$PT.log" \
  && ok "合法日期仍照常恢复落盘" || bad "合法日期 pending 没有落盘"
[ -e "$PT/pwned.json" ] || [ -e "$ROOT/pwned.json" ] \
  && bad "pending day 路径穿越写出了 daily 目录" \
  || ok "pending day 未发生路径穿越"
[ -f "$PTS/pending-daily.json" ] && bad "pending-daily.json 落盘后未清除" \
  || ok "非法/已落盘 pending 已清理"

# baseline v3 的 dedup/outage 账本：版本、条目上限、类型/键格式校验。
BB="$ROOT/bounds"; BBS="$BB/state"; BBD="$BB/daily"
rm -rf "$BB"; mkdir -p "$BBS"
F="$BBS/baseline.json" DAY="$TODAY" NOWB=$(date +%s) ucode -e '
let fs=require("fs");
let now=int(getenv("NOWB")); let day=getenv("DAY");
let dd={}; let oo={};
for (let i=0;i<10000;i++) {
  dd[sprintf("tcp|10.0.%d.%d|1.1.1.1|*|443", int(i/250), i%250)]=now+60;
  oo[sprintf("tcp|10.1.%d.%d|2.2.2.2|*|443", int(i/250), i%250)]=now+60;
}
dd["bad-key"]=now+60;
dd["tcp|1.1.1.1|2.2.2.2|*|443"]="not-an-int";
oo["tcp|1.1.1.1|2.2.2.2|*|443|9"]=now+60;
let o={v:3,ts:now,day:day,clash_ts:now,ct_ts:now,clash_prev:{},ct_prev:{},
       clash_dedup:dd,clash_outage:oo,clash_outage_active:false,clash_outage_had:false};
fs.writefile(getenv("F"), sprintf("%J", o));' 2>/dev/null
env PATH="$ROOT/bin:$PATH" TS_TEST_CURL_MODE="$ROOT/trav.mode" TS_TEST_CURL_BODY="$ROOT/trav.body" \
    PRISM_ROUTER_ONCE=1 PRISM_ROUTER_BASELINE_MAX_ENTRIES=8 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$BBS" PRISM_ROUTER_DAILY_DIR="$BBD" \
    PRISM_ROUTER_DEVICES_FILE="$BB/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API='http://127.0.0.1:19999/connections' \
    ucode /usr/bin/prism-routerd >"$BB.log" 2>&1
eq "$?" "0" "超大/坏类型 baseline：启动退出码 0"
eq "$(jget "$BBS/baseline.json" 'sprintf("%d|%d|%d", int(d.v??0), length(keys(d.clash_dedup??{})), length(keys(d.clash_outage??{})))')" \
  "3|8|8" "baseline 账本按上限截断（8/8）且版本仍为 v3"
grep -q 'baseline dedup sanitized: dropped=' "$BB.log" \
  && ok "坏键/坏类型被丢弃并记录" || bad "坏键/坏类型没有被丢弃"
grep -q 'baseline dedup restored: dedup=8 outage=8' "$BB.log" \
  && ok "账本只恢复上限内条目" || bad "账本恢复条数不是上限"

# 超过 BASELINE_MAX_BYTES 的文件在读入前就拒绝（不解析、不占内存）。
BIGB="$ROOT/bigbase"; BIGBS="$BIGB/state"; BIGBD="$BIGB/daily"
rm -rf "$BIGB"; mkdir -p "$BIGBS"
head -c 9000000 /dev/zero > "$BIGBS/baseline.json" 2>/dev/null \
  || dd if=/dev/zero of="$BIGBS/baseline.json" bs=1024 count=9000 2>/dev/null
env PATH="$ROOT/bin:$PATH" TS_TEST_CURL_MODE="$ROOT/trav.mode" TS_TEST_CURL_BODY="$ROOT/trav.body" \
    PRISM_ROUTER_ONCE=1 PRISM_ROUTER_DEBUG=1 \
    PRISM_ROUTER_STATE_DIR="$BIGBS" PRISM_ROUTER_DAILY_DIR="$BIGBD" \
    PRISM_ROUTER_DEVICES_FILE="$BIGB/devices.json" PRISM_ROUTER_CONNTRACK_FILE="$ROOT/ct_empty.txt" \
    PRISM_ROUTER_CLASH_API='http://127.0.0.1:19999/connections' \
    ucode /usr/bin/prism-routerd >"$BIGB.log" 2>&1
eq "$?" "0" "超大 baseline：启动退出码 0"
grep -q 'baseline too large' "$BIGB.log" \
  && ok "超大 baseline 读取前被拒绝" || bad "超大 baseline 没有被大小检查拦住"

UCI set prism-router.settings.poll_interval='5'; cfg_commit

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
