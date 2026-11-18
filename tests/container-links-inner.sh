#!/bin/sh
# 母路由侧「接入方式（无线 / 有线）」用例（容器内执行；由 tests/container-validate-links.sh 调用）
#
# 覆盖：
#   1. 两个包装上后 /etc /usr /www /www/cgi-bin 权限不变（2026-11-14 事故回归核心）
#   2. 新配置项落位（lan_bridge / wireless_ports / ap_macs / link_refresh）与文件权限
#   3. 假 brctl 注入 PATH 喂固定 FDB：
#        ap_macs 反查上联端口、端口 3 -> wifi、端口 2 -> wired、FDB 未命中 -> unknown
#        totals 的 wifi/wired/unknown 三桶相加 == direct + proxy（rx 与 tx 都校验）
#        conntrack 侧与 clash 侧（含 sourceIP 为空的连接）都要进桶，且只进一个桶
#   4. ap_macs 找不到时保持 wireless_ports 原值并记 reason；大写/短横线 MAC 归一
#   5. brctl 缺失 / 输出无法解析 / 网桥不存在 -> link_source=none + reasons，
#      不崩、不影响原有 direct/proxy 统计，三桶恒等式仍成立
#   6. link_refresh 生效（30s 只读一次 FDB；1s 至少读两次）
#   7. rpcd get_state / status 透传 link 字段；set_config 白名单放行新配置项
#
# 隔离：只在 127.0.0.1 上跑（uhttpd 当假 clash API），不访问外网、不接触任何真机。
mkdir -p /var/run/ubus /var/lock /tmp /tmp/fakebin /tmp/fakegarbage

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
CGET(){ uci -q get "$1" 2>/dev/null; }
cfg_commit(){ uci commit prism-router >/dev/null 2>&1; }

BASE_PATH=/usr/sbin:/usr/bin:/sbin:/bin
LINK64='00:58:28:d7:63:60'
CLASH_JSON='{"connections":[
 {"id":"c1","metadata":{"sourceIP":"192.168.100.101","host":"a.example","destinationIP":"1.1.1.1","destinationPort":"443"},"upload":500,"download":5000,"chains":["US1"]},
 {"id":"c2","metadata":{"sourceIP":"192.168.100.102","host":"b.example","destinationIP":"2.2.2.2","destinationPort":"443"},"upload":700,"download":7000,"chains":["DIRECT"]},
 {"id":"c3","metadata":{"sourceIP":"192.168.100.103","host":"c.example","destinationIP":"3.3.3.3","destinationPort":"443"},"upload":900,"download":9000,"chains":["US2"]},
 {"id":"c4","metadata":{"host":"d.example","destinationIP":"4.4.4.4","destinationPort":"443"},"upload":11,"download":111,"chains":["US1"]}
]}'

# state.json 一行摘要（| 分隔）：
#  1 link_source  2 link_ports  3 link_ports_from
#  4 direct_rx    5 proxy_rx    6 wifi_rx    7 wired_rx    8 unknown_rx
#  9 direct_tx   10 proxy_tx   11 wifi_tx   12 wired_tx   13 unknown_tx
# 14 reasons 数  15/16/17 三台设备的 link  18 FDB 条目数  19 link_error
REPORT_PROG='function dl(d, ip) { for (let x in d.devices) if (x.ip == ip) return (x.link ?? "missing"); return "none"; }
let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
let ports=[]; for (let p in (d.health.link_ports ?? [])) push(ports, sprintf("%d", p));
print(sprintf("%s|%s|%s|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%s|%s|%s|%d|%s",
  d.health.link_source, join(",", ports), d.health.link_ports_from,
  d.totals.direct_rx, d.totals.proxy_rx, d.totals.wifi_rx, d.totals.wired_rx, d.totals.unknown_rx,
  d.totals.direct_tx, d.totals.proxy_tx, d.totals.wifi_tx, d.totals.wired_tx, d.totals.unknown_tx,
  length(d.health.reasons),
  dl(d, "192.168.100.101"), dl(d, "192.168.100.102"), dl(d, "192.168.100.103"),
  d.health.link_entries, (d.health.link_error ?? "")));'
report(){ F="$1" ucode -e "$REPORT_PROG"; }

# 三桶恒等式：direct+proxy 与 wifi+wired+unknown 各自相等（rx / tx 分别校验）
INV_PROG='let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
print(sprintf("%d|%d|%d|%d",
  d.totals.direct_rx + d.totals.proxy_rx,
  d.totals.wifi_rx + d.totals.wired_rx + d.totals.unknown_rx,
  d.totals.direct_tx + d.totals.proxy_tx,
  d.totals.wifi_tx + d.totals.wired_tx + d.totals.unknown_tx));'
inv(){ F="$1" ucode -e "$INV_PROG"; }

# 单台设备：link|direct_rx|proxy_rx|direct_tx|proxy_tx
DEV_PROG='let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
for (let x in d.devices) if (x.ip == getenv("IP")) { print(sprintf("%s|%d|%d|%d|%d", x.link ?? "missing", x.direct_rx, x.proxy_rx, x.direct_tx, x.proxy_tx)); return; }
print("missing");'
devq(){ F="$1" IP="$2" ucode -e "$DEV_PROG"; }

# 恒等式断言：$1=state 文件 $2=场景名
chk_inv(){
  local name inv_out
  name="$2"; inv_out=$(inv "$1")
  OLDIFS=$IFS; IFS='|'; set -- $inv_out; IFS=$OLDIFS
  if [ "$1" = "$2" ] && [ "$3" = "$4" ]; then
    ok "$name：wifi+wired+unknown == direct+proxy（rx=$2 tx=$4）"
  else
    bad "$name：三桶不自洽 rx[$1 vs $2] tx[$3 vs $4]"
  fi
}

# 跑一次守护进程：$1=state 目录，$2=PATH
run_once(){
  SD="$1"; RUN_PATH="$2"
  rm -rf "$SD"
  mkdir -p "$(dirname "$SD")"
  env PATH="$RUN_PATH" PRISM_ROUTER_ONCE=1 \
    PRISM_ROUTER_STATE_DIR="$SD" \
    PRISM_ROUTER_DAILY_DIR="$SD.daily" \
    PRISM_ROUTER_CONNTRACK_FILE=/tmp/ct.txt \
    PRISM_ROUTER_CLASH_API=127.0.0.1:19091 \
    ucode /usr/bin/prism-routerd >"$SD.log" 2>&1
  echo $?
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin 2>/dev/null)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=${B_CGI:-无}"

echo "=== 1. 安装两个包 ==="
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 && ok "安装 prism-router" || { bad "安装 prism-router"; tail -5 /tmp/i1.log; }
true >/tmp/i2.log 2>&1 && ok "安装 luci-app-prism-router" || { bad "安装 luci-app"; tail -5 /tmp/i2.log; }

echo "=== 2. 新配置项与文件权限 ==="
for k in lan_bridge wireless_ports ap_macs link_refresh; do
  grep -q "option $k" /etc/config/prism-router && ok "config 含 $k" || bad "config 缺少 $k"
done
grep -q "option lan_bridge 'br-lan'" /etc/config/prism-router && ok "lan_bridge 默认 br-lan" || bad "lan_bridge 默认值不对"
grep -q "option link_refresh '30'" /etc/config/prism-router && ok "link_refresh 默认 30" || bad "link_refresh 默认值不对"
check /usr/bin/prism-routerd "root:root -rwxr-xr-x"
check /usr/share/rpcd/ucode/prism-router.uc "root:root -rw-r--r--"
check /www/luci-static/resources/view/prism-router/overview.js "root:root -rw-r--r--"
check /www/luci-static/resources/view/prism-router/devices.js "root:root -rw-r--r--"
check /www/luci-static/resources/view/prism-router/settings.js "root:root -rw-r--r--"
check /etc/config/prism-router "root:root -rw-r--r--"

echo "=== 3. 系统目录权限未被改动（回归核心）==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin 2>/dev/null)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 4. ucode 语法 ==="
ucode -c /usr/bin/prism-routerd && ok "prism-routerd 语法 OK" || bad "prism-routerd 语法错误"
ucode -c /usr/share/rpcd/ucode/prism-router.uc && ok "rpcd uc 语法 OK" || bad "rpcd uc 语法错误"

echo "=== 5. 假 brctl（固定 FDB）+ 合成租约 / conntrack + 假 clash API ==="
cat > /tmp/fakebin/brctl <<'FAKEBRCTL'
#!/bin/sh
echo "$*" >> /tmp/fakebrctl.calls
if [ "$1" != "showmacs" ]; then
	echo "fake brctl: unsupported: $*" >&2
	exit 1
fi
cat <<'FDB'
port no  mac addr            is local?
  3      00:58:28:d7:63:60   no
  3      34:f0:15:a0:0e:b1   no
  3      3a:18:5b:dd:2e:13   no
  1      60:be:b4:04:32:ad   yes
  2      aa:bb:cc:dd:ee:01   no
FDB
exit 0
FAKEBRCTL
chmod 755 /tmp/fakebin/brctl
rm -f /tmp/fakebrctl.calls
/tmp/fakebin/brctl showmacs br-lan >/tmp/fdb.sample 2>&1
[ "$(wc -l < /tmp/fdb.sample)" = "6" ] && ok "假 brctl 输出 6 行（1 表头 + 5 条 FDB）" || bad "假 brctl 输出异常"

cat > /tmp/dhcp.leases <<'LEASES'
0 34:f0:15:a0:0e:b1 192.168.100.101 phone-wifi *
0 aa:bb:cc:dd:ee:01 192.168.100.102 pc-wired *
0 02:00:00:00:00:99 192.168.100.103 no-fdb *
LEASES
cat > /tmp/ct.txt <<'CT'
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.101 dst=1.1.1.1 sport=40000 dport=443 packets=1 bytes=100 src=1.1.1.1 dst=192.168.100.101 sport=443 dport=40000 packets=1 bytes=1000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.102 dst=2.2.2.2 sport=40001 dport=443 packets=1 bytes=200 src=2.2.2.2 dst=192.168.100.102 sport=443 dport=40001 packets=1 bytes=2000 [ASSURED] mark=0 use=1
ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.100.103 dst=3.3.3.3 sport=40002 dport=443 packets=1 bytes=400 src=3.3.3.3 dst=192.168.100.103 sport=443 dport=40002 packets=1 bytes=4000 [ASSURED] mark=0 use=1
CT

mkdir -p /tmp/mockclash
printf '%s' "$CLASH_JSON" > /tmp/mockclash/connections
/usr/sbin/uhttpd -f -p 127.0.0.1:19091 -h /tmp/mockclash >/tmp/mockclash.log 2>&1 &
i=0
while [ $i -lt 20 ]; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 1 http://127.0.0.1:19091/connections)" = "200" ] && break
  i=$((i+1)); sleep 0.2
done
[ $i -lt 20 ] && ok "假 clash API 就绪 (127.0.0.1:19091)" || { bad "假 clash API 未就绪"; cat /tmp/mockclash.log; }

UCI set prism-router.settings.lan_ranges='192.168.100.0/24'
UCI set prism-router.settings.poll_interval='5'
cfg_commit

# 期望值（conntrack 3 条与 clash c1/c2/c3 同五元组，全部只在 Clash 侧计一次）：
#   direct_rx 7000(c2 DIRECT)                        direct_tx 700
#   proxy_rx  5000(c1) + 9000(c3) + 111(c4 无 sourceIP) = 14111
#   proxy_tx  500 + 900 + 11 = 1411
#   wifi_rx   5000(c1)                                wifi_tx 500
#   wired_rx  7000(c2 DIRECT)                         wired_tx 700
#   unknown_rx 9000 + 111(c4) = 9111                 unknown_tx 900 + 11 = 911
EXP_DIRECT_RX=7000;  EXP_DIRECT_TX=700
EXP_PROXY_RX=14111;   EXP_PROXY_TX=1411
EXP_WIFI_RX=5000;     EXP_WIFI_TX=500
EXP_WIRED_RX=7000;    EXP_WIRED_TX=700
EXP_UNKNOWN_RX=9111; EXP_UNKNOWN_TX=911
EXP_ALL_RX=21111;     EXP_ALL_TX=2111

echo "=== 6. Case A：ap_macs 反查上联端口（$LINK64 -> 端口 3）==="
UCI set prism-router.settings.lan_bridge='br-lan'
UCI set prism-router.settings.wireless_ports=''
UCI set prism-router.settings.ap_macs="$LINK64"
UCI set prism-router.settings.link_refresh='30'
cfg_commit
RC=$(run_once /tmp/lk/a "/tmp/fakebin:$BASE_PATH")
[ "$RC" = "0" ] && ok "守护进程退出码 0（--once）" || { bad "退出码 $RC"; tail -5 /tmp/lk/a.log; }
if [ -f /tmp/lk/a/state.json ]; then
  ok "state.json 已生成（$(wc -c < /tmp/lk/a/state.json) 字节）"
  R=$(report /tmp/lk/a/state.json)
  OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  [ "$1" = "brctl" ] && ok "health.link_source=brctl" || bad "link_source=$1 期望 brctl"
  [ "$2" = "3" ] && ok "ap_macs 反查端口=$2（期望 3）" || bad "link_ports=$2 期望 3"
  [ "$3" = "ap_macs" ] && ok "端口来源=ap_macs（优先于 wireless_ports）" || bad "link_ports_from=$3"
  [ "${18}" = "5" ] && ok "FDB 解析到 5 条（表头被忽略）" || bad "link_entries=${18} 期望 5"
  [ "${15}" = "wifi" ] && ok "192.168.100.101（端口 3）-> wifi" || bad "101 link=${15} 期望 wifi"
  [ "${16}" = "wired" ] && ok "192.168.100.102（端口 2）-> wired" || bad "102 link=${16} 期望 wired"
  [ "${17}" = "unknown" ] && ok "192.168.100.103（不在 FDB）-> unknown" || bad "103 link=${17} 期望 unknown"
  [ "$4" = "$EXP_DIRECT_RX" ] && ok "direct_rx=$4（原有统计口径不变）" || bad "direct_rx=$4 期望 $EXP_DIRECT_RX"
  [ "$5" = "$EXP_PROXY_RX" ] && ok "proxy_rx=$5（含 sourceIP 为空的连接）" || bad "proxy_rx=$5 期望 $EXP_PROXY_RX"
  [ "$6" = "$EXP_WIFI_RX" ] && ok "wifi_rx=$6" || bad "wifi_rx=$6 期望 $EXP_WIFI_RX"
  [ "$7" = "$EXP_WIRED_RX" ] && ok "wired_rx=$7" || bad "wired_rx=$7 期望 $EXP_WIRED_RX"
  [ "$8" = "$EXP_UNKNOWN_RX" ] && ok "unknown_rx=$8" || bad "unknown_rx=$8 期望 $EXP_UNKNOWN_RX"
  [ "${11}" = "$EXP_WIFI_TX" ] && ok "wifi_tx=${11}" || bad "wifi_tx=${11} 期望 $EXP_WIFI_TX"
  [ "${12}" = "$EXP_WIRED_TX" ] && ok "wired_tx=${12}" || bad "wired_tx=${12} 期望 $EXP_WIRED_TX"
  [ "${13}" = "$EXP_UNKNOWN_TX" ] && ok "unknown_tx=${13}" || bad "unknown_tx=${13} 期望 $EXP_UNKNOWN_TX"
  [ "${14}" = "0" ] && ok "reasons=0（clash/conntrack/FDB 全部正常）" || bad "reasons=${14} 期望 0"
  chk_inv /tmp/lk/a/state.json "Case A"
  D=$(devq /tmp/lk/a/state.json 192.168.100.101)
  OLDIFS=$IFS; IFS='|'; set -- $D; IFS=$OLDIFS
  if [ "$1" = "wifi" ] && [ "$2" = "0" ] && [ "$3" = "5000" ]; then
    ok "设备 101：link=wifi direct_rx=0 proxy_rx=5000（同五元组不重复计）"
  else
    bad "设备 101：$D"
  fi
else
  bad "state.json 未生成"; tail -5 /tmp/lk/a.log
fi

echo "=== 7. Case A2：ap_macs 大写 + 短横线归一 ==="
UCI set prism-router.settings.ap_macs='00-58-28-D7-63-60'
cfg_commit
RC=$(run_once /tmp/lk/a2 "/tmp/fakebin:$BASE_PATH")
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
R=$(report /tmp/lk/a2/state.json)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
if [ "$1" = "brctl" ] && [ "$2" = "3" ] && [ "$3" = "ap_macs" ]; then
  ok "大写/短横线 MAC 归一后仍反查到端口 3"
else
  bad "link=$1 ports=$2 from=$3"
fi

echo "=== 8. Case B：wireless_ports='3,5'（不配 ap_macs）==="
UCI set prism-router.settings.ap_macs=''
UCI set prism-router.settings.wireless_ports='3,5'
cfg_commit
RC=$(run_once /tmp/lk/b "/tmp/fakebin:$BASE_PATH")
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
R=$(report /tmp/lk/b/state.json)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "brctl" ] && ok "link_source=brctl" || bad "link_source=$1"
[ "$2" = "3,5" ] && ok "link_ports=3,5（显式配置）" || bad "link_ports=$2 期望 3,5"
[ "$3" = "wireless_ports" ] && ok "端口来源=wireless_ports" || bad "link_ports_from=$3"
if [ "${15}" = "wifi" ] && [ "${16}" = "wired" ] && [ "${17}" = "unknown" ]; then
  ok "分类：端口 3 -> wifi，端口 2 -> wired，FDB 未命中 -> unknown"
else
  bad "分类 101=${15} 102=${16} 103=${17}"
fi
if [ "$6" = "$EXP_WIFI_RX" ] && [ "$7" = "$EXP_WIRED_RX" ] && [ "$8" = "$EXP_UNKNOWN_RX" ]; then
  ok "三桶字节与 Case A 一致（$6/$7/$8）"
else
  bad "三桶 $6/$7/$8"
fi
chk_inv /tmp/lk/b/state.json "Case B"

echo "=== 9. Case C：ap_macs 查不到 -> 保持 wireless_ports 原值 + reason ==="
UCI set prism-router.settings.ap_macs='00:11:22:33:44:55'
UCI set prism-router.settings.wireless_ports='2'
cfg_commit
RC=$(run_once /tmp/lk/c "/tmp/fakebin:$BASE_PATH")
[ "$RC" = "0" ] && ok "退出码 0（找不到 AP 也不崩）" || bad "退出码 $RC"
R=$(report /tmp/lk/c/state.json)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "brctl" ] && ok "link_source=brctl（FDB 本身读到了）" || bad "link_source=$1"
[ "$2" = "2" ] && ok "link_ports 保持配置值 2" || bad "link_ports=$2 期望 2"
[ "$3" = "wireless_ports" ] && ok "端口来源回退 wireless_ports" || bad "link_ports_from=$3"
echo "${19:-}" | grep -q 'ap_macs' && ok "link_error/reasons 写明 ap_macs 未找到" || bad "link_error=${19:-}"
if [ "${15}" = "wired" ] && [ "${16}" = "wifi" ]; then
  ok "端口 2 变成无线上联口：101(口3)->wired，102(口2)->wifi"
else
  bad "分类 101=${15} 102=${16}"
fi
[ "${14}" = "1" ] && ok "health.reasons=1（仅接入方式告警）" || bad "reasons=${14} 期望 1"
chk_inv /tmp/lk/c/state.json "Case C"

echo "=== 10. Case D：brctl 不存在（指向不存在路径）==="
UCI set prism-router.settings.ap_macs=''
UCI set prism-router.settings.wireless_ports='3'
cfg_commit
rm -rf /tmp/lk/d
RC=$(env PATH="$BASE_PATH" PRISM_ROUTER_BRCTL=/nonexistent/brctl PRISM_ROUTER_ONCE=1 \
  PRISM_ROUTER_STATE_DIR=/tmp/lk/d PRISM_ROUTER_CONNTRACK_FILE=/tmp/ct.txt \
  PRISM_ROUTER_CLASH_API=127.0.0.1:19091 ucode /usr/bin/prism-routerd >/tmp/lk/d.log 2>&1; echo $?)
[ "$RC" = "0" ] && ok "退出码 0（brctl 缺失不崩）" || { bad "退出码 $RC"; tail -5 /tmp/lk/d.log; }
if [ -f /tmp/lk/d/state.json ]; then
  R=$(report /tmp/lk/d/state.json)
  OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  [ "$1" = "none" ] && ok "health.link_source=none" || bad "link_source=$1 期望 none"
  [ "${14}" = "1" ] && ok "health.reasons=1（写明失败原因）" || bad "reasons=${14} 期望 1"
  echo "${19:-}" | grep -q 'brctl' && ok "link_error 含 brctl 失败原因" || bad "link_error=${19:-}"
  if [ "${15}" = "unknown" ] && [ "${16}" = "unknown" ] && [ "${17}" = "unknown" ]; then
    ok "三台设备 link 全部 unknown"
  else
    bad "link=${15}/${16}/${17} 期望全 unknown"
  fi
  if [ "$6" = "0" ] && [ "$7" = "0" ] && [ "$8" = "$EXP_ALL_RX" ] && [ "${13}" = "$EXP_ALL_TX" ]; then
    ok "wifi/wired=0，全部归 unknown（rx=$8 tx=${13}）"
  else
    bad "三桶 $6/$7/$8/${13}"
  fi
  # 注意：$9 是 direct_tx，${10} 是 proxy_tx
  if [ "$4" = "$EXP_DIRECT_RX" ] && [ "$5" = "$EXP_PROXY_RX" ] && [ "$9" = "$EXP_DIRECT_TX" ] && [ "${10}" = "$EXP_PROXY_TX" ]; then
    ok "direct/proxy 统计不受影响（$4/$5/$9/${10}）"
  else
    bad "direct/proxy 被影响 $4/$5/$9/${10}"
  fi
  chk_inv /tmp/lk/d/state.json "Case D"
else
  bad "state.json 未生成"
fi

echo "=== 11. Case E：brctl 输出无法解析 ==="
cat > /tmp/fakegarbage/brctl <<'GARBAGE'
#!/bin/sh
echo "hello world"
echo "not a fdb line"
exit 0
GARBAGE
chmod 755 /tmp/fakegarbage/brctl
RC=$(run_once /tmp/lk/e "/tmp/fakegarbage:$BASE_PATH")
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
R=$(report /tmp/lk/e/state.json)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "none" ] && ok "link_source=none（输出不可解析）" || bad "link_source=$1"
[ "${18}" = "0" ] && ok "link_entries=0" || bad "link_entries=${18}"
echo "${19:-}" | grep -q '无法解析' && ok "link_error 写明输出无法解析" || bad "link_error=${19:-}"
[ "${14}" = "1" ] && ok "reasons=1" || bad "reasons=${14}"
if [ "$8" = "$EXP_ALL_RX" ] && [ "${13}" = "$EXP_ALL_TX" ]; then
  ok "全部字节进 unknown 桶（rx=$8 tx=${13}）"
else
  bad "unknown=$8/${13}"
fi
chk_inv /tmp/lk/e/state.json "Case E"

echo "=== 12. Case F：网桥不存在（真 busybox brctl，不注入假命令）==="
RC=$(run_once /tmp/lk/f "$BASE_PATH")
[ "$RC" = "0" ] && ok "退出码 0（br-lan 不存在不崩）" || { bad "退出码 $RC"; tail -5 /tmp/lk/f.log; }
R=$(report /tmp/lk/f/state.json)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "none" ] && ok "link_source=none" || bad "link_source=$1"
[ "${14}" = "1" ] && ok "reasons=1（含 brctl 报错原文）" || bad "reasons=${14}"
echo "${19:-}" | grep -qi 'br-lan' && ok "link_error 提到 br-lan" || bad "link_error=${19:-}"
if [ "$4" = "$EXP_DIRECT_RX" ] && [ "$5" = "$EXP_PROXY_RX" ]; then
  ok "direct/proxy 与 Case A 完全一致（$4/$5）"
else
  bad "direct/proxy=$4/$5"
fi
chk_inv /tmp/lk/f/state.json "Case F"

echo "=== 13. Case G：未配置 wireless_ports / ap_macs（默认安装）==="
UCI set prism-router.settings.wireless_ports=''
UCI set prism-router.settings.ap_macs=''
cfg_commit
RC=$(run_once /tmp/lk/g "/tmp/fakebin:$BASE_PATH")
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
R=$(report /tmp/lk/g/state.json)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "brctl" ] && ok "link_source=brctl（FDB 照读）" || bad "link_source=$1"
[ -z "$2" ] && ok "link_ports 为空（未配置无线上联口）" || bad "link_ports=$2 期望空"
[ "$3" = "none" ] && ok "link_ports_from=none" || bad "link_ports_from=$3"
if [ "${15}" = "wired" ] && [ "${16}" = "wired" ] && [ "${17}" = "unknown" ]; then
  ok "FDB 学到的按 wired，未命中仍 unknown"
else
  bad "分类 101=${15} 102=${16} 103=${17}"
fi
[ "${14}" = "0" ] && ok "reasons=0（未配置时不因 FDB 噪音降级）" || bad "reasons=${14} 期望 0"
chk_inv /tmp/lk/g/state.json "Case G"

echo "=== 14. link_refresh 生效（30s 只读一次 / 1s 至少两次）==="
UCI set prism-router.settings.wireless_ports='3'
UCI set prism-router.settings.link_refresh='30'
UCI set prism-router.settings.poll_interval='1'
cfg_commit
rm -f /tmp/fakebrctl.calls; rm -rf /tmp/lk/h1
env PATH="/tmp/fakebin:$BASE_PATH" PRISM_ROUTER_STATE_DIR=/tmp/lk/h1 \
  PRISM_ROUTER_CONNTRACK_FILE=/tmp/ct.txt PRISM_ROUTER_CLASH_API=127.0.0.1:19091 \
  ucode /usr/bin/prism-routerd >/tmp/lk/h1.log 2>&1 &
DPID=$!
sleep 4
kill $DPID >/dev/null 2>&1; wait $DPID >/dev/null 2>&1
N1=$(wc -l < /tmp/fakebrctl.calls 2>/dev/null || echo 0)
[ "$N1" = "1" ] && ok "link_refresh=30：4 秒内只读 1 次 FDB（实际 $N1）" || bad "link_refresh=30 读了 $N1 次，期望 1"

UCI set prism-router.settings.link_refresh='1'
cfg_commit
rm -f /tmp/fakebrctl.calls; rm -rf /tmp/lk/h2
env PATH="/tmp/fakebin:$BASE_PATH" PRISM_ROUTER_STATE_DIR=/tmp/lk/h2 \
  PRISM_ROUTER_CONNTRACK_FILE=/tmp/ct.txt PRISM_ROUTER_CLASH_API=127.0.0.1:19091 \
  ucode /usr/bin/prism-routerd >/tmp/lk/h2.log 2>&1 &
DPID=$!
sleep 4
kill $DPID >/dev/null 2>&1; wait $DPID >/dev/null 2>&1
N2=$(wc -l < /tmp/fakebrctl.calls 2>/dev/null || echo 0)
[ "$N2" -ge 2 ] && ok "link_refresh=1：4 秒内读 $N2 次 FDB（>=2）" || bad "link_refresh=1 只读了 $N2 次"
UCI set prism-router.settings.poll_interval='5'
UCI set prism-router.settings.link_refresh='30'
cfg_commit

echo "=== 15. rpcd 透传：get_state / status ==="
mkdir -p /tmp/prism-router
cp -f /tmp/lk/a/state.json /tmp/prism-router/state.json
PRISM_ROUTER_METHOD=get_state ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc >/tmp/getstate.json 2>/tmp/getstate.err
[ -s /tmp/getstate.json ] && ok "get_state 返回非空（$(wc -c < /tmp/getstate.json) 字节）" || { bad "get_state 空"; cat /tmp/getstate.err; }
CP=$(F=/tmp/getstate.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  let a=d.totals.direct_rx+d.totals.proxy_rx, b=d.totals.wifi_rx+d.totals.wired_rx+d.totals.unknown_rx;
  print(sprintf("%s|%s|%d|%d|%d", (d.health.link_source ?? "missing"),
    join(",", map((d.health.link_ports ?? []), function(x){ return sprintf("%d", x); })),
    d.totals.wifi_rx, b, a));')
OLDIFS=$IFS; IFS='|'; set -- $CP; IFS=$OLDIFS
[ "$1" = "brctl" ] && [ "$2" = "3" ] && ok "get_state 透传 health.link_source/ports" || bad "get_state link=$1 ports=$2"
[ "$3" = "$EXP_WIFI_RX" ] && ok "get_state totals.wifi_rx=$3" || bad "get_state wifi_rx=$3"
[ "$4" = "$5" ] && ok "get_state 侧三桶恒等（$4 == $5）" || bad "get_state 三桶 $4 != $5"
CPL=$(F=/tmp/getstate.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  let n=0, bad=0; for (let x in d.devices) { n++; if (x.link != "wifi" && x.link != "wired" && x.link != "unknown") bad++; }
  print(sprintf("%d|%d", n, bad));')
OLDIFS=$IFS; IFS='|'; set -- $CPL; IFS=$OLDIFS
[ "$1" -ge 3 ] && [ "$2" = "0" ] && ok "get_state 每台设备都有合法 link（$1 台，非法 0）" || bad "设备 link 非法：$1 台 / 非法 $2"
PRISM_ROUTER_METHOD=status ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc >/tmp/status.json 2>/dev/null
STL=$(F=/tmp/status.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  print(sprintf("%s|%s|%d", (d.link_source ?? "missing"), (d.link_bridge ?? "missing"),
    length(d.link_ports ?? [])));')
OLDIFS=$IFS; IFS='|'; set -- $STL; IFS=$OLDIFS
if [ "$1" = "brctl" ] && [ "$2" = "br-lan" ] && [ "$3" = "1" ]; then
  ok "status 透传 link_source/link_bridge/link_ports"
else
  bad "status link=$1 bridge=$2 ports=$3"
fi

echo "=== 16. set_config 白名单放行新配置项 ==="
SC=$(PRISM_ROUTER_METHOD=set_config PRISM_ROUTER_ARGS='{"section":"settings","options":"{\"lan_bridge\":\"br-lan\",\"wireless_ports\":\"3\",\"ap_macs\":\"00:58:28:d7:63:60\",\"link_refresh\":\"45\"}"}' \
  ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$SC" | tr -d ' \n' | grep -q '"ok":true' && ok "set_config 接受四个新字段" || bad "set_config 返回 $SC"
[ "$(CGET prism-router.settings.wireless_ports)" = "3" ] && ok "uci wireless_ports=3" || bad "wireless_ports=$(CGET prism-router.settings.wireless_ports)"
[ "$(CGET prism-router.settings.ap_macs)" = "00:58:28:d7:63:60" ] && ok "uci ap_macs 写入成功" || bad "ap_macs 写入失败"
[ "$(CGET prism-router.settings.link_refresh)" = "45" ] && ok "uci link_refresh=45" || bad "link_refresh 写入失败"
[ "$(CGET prism-router.settings.lan_bridge)" = "br-lan" ] && ok "uci lan_bridge=br-lan" || bad "lan_bridge 写入失败"
BAD=$(PRISM_ROUTER_METHOD=set_config PRISM_ROUTER_ARGS='{"section":"settings","options":"{\"ap_mac\":\"x\"}"}' \
  ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/dev/null)
echo "$BAD" | grep -q 'no valid options' && ok "非白名单字段仍被拒绝" || bad "非白名单字段未被拒绝：$BAD"

echo "=== 17. 返回体体积仍远低于 ubus 上限 ==="
SZ=$(wc -c < /tmp/getstate.json)
[ "$SZ" -lt 184320 ] && ok "get_state $SZ 字节 (<180KiB)" || bad "get_state 超预算 $SZ"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
