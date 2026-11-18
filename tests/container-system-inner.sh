#!/bin/sh
# 软路由自身性能指标（state.json 的 system 段）用例（容器内执行；
# 由 tests/container-validate-system.sh 调用）
#
# 覆盖：
#   1. 安装两个包后 /etc /usr /www 权限不变（2026-11-14 事故回归核心）
#   2. 新配置项落位（system_enabled / wan_iface）与文件权限、ucode 语法
#   3. 容器真实 /proc：uptime/load/cpu_cores/mem/disk 合理，system 段 < 800B，
#      无 thermal 时 temp_c 省略（不写 0）
#   4. 伪造 /proc（两个 FIFO 提供两次采样）：
#        cpu_pct = 25.0（构造 stat 差值）、mem_pct = 25.0、load = 0.2/1.3/2.8、
#        cpu_cores = 4、mem/swap/disk 精确值、temp 缺失省略、wan 速率按默认路由接口、
#        df 在 60 秒内只跑一次（假 df 计数）
#   5. system 段序列化 < 800B；开启/关闭 system_enabled 的 state.json 增量 < 1KB；
#      关闭时整段不存在（老消费方无感）
#   6. /proc 全部读不到（空文件 + df 失败）：system 为空对象、reasons 不增加、
#      direct/proxy 与关闭 system 时逐字节一致
#   7. 单字段缺失：MemAvailable 缺失时省略 mem_avail/mem_pct 但保留 mem_total；
#      thermal 存在时 temp_c 定点换算（42950 -> 43.0）
#   8. wan_iface 显式配置时按该接口算速率（与默认路由接口区分）
#
# 隔离：--network none，不访问外网、不接触任何真机；FIFO 只在本容器 /tmp。
mkdir -p /var/run/ubus /var/lock /tmp

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
cfg_commit(){ uci commit prism-router >/dev/null 2>&1; }

EXP_DIRECT_RX=900240   # 与 tests/container-inner.sh 同一 fixture 口径（fake-ip 已排除）

# 一次守护进程运行：$1=state 目录 $2=轮数 $3=额外 env（空格分隔，可为空）
run_once(){
  SD="$1"; N="$2"; EXTRA="$3"
  rm -rf "$SD"; mkdir -p "$SD"
  env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_ONCE_POLLS="$N" \
      PRISM_ROUTER_STATE_DIR="$SD" \
      PRISM_ROUTER_DAILY_DIR="$SD.daily" \
      PRISM_ROUTER_CONNTRACK_FILE=/fixtures/nf_conntrack \
      PRISM_ROUTER_CLASH_API=127.0.0.1:1 \
      $EXTRA \
      ucode /usr/bin/prism-routerd >"$SD.log" 2>&1
  echo $?
}

# 摘要：1 system 存在 2 字段数 3 uptime 4 load1(0.1) 5 load5 6 load15
# 7 cpu_pct(0.1) 8 cpu_cores 9 mem_total 10 mem_avail 11 mem_pct(0.1)
# 12 swap_total 13 swap_free 14 temp_c(0.1) 15 temp 存在
# 16 disk_total 17 disk_used 18 disk_pct(0.1) 19 wan_rx 20 wan_tx
# 21 direct_rx 22 proxy_rx 23 reasons 数 24 confidence
SYS_PROG='let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let s=d.system;
function has(k){ return (s != null && s[k] != null) ? 1 : 0; }
function iv(k){ return (s != null && s[k] != null) ? sprintf("%d", s[k]) : "missing"; }
function tv(k){ return (s != null && s[k] != null) ? sprintf("%d", int(s[k]*10+0.5)) : "missing"; }
print(sprintf("%d|%d|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%d|%s|%s|%s|%s|%s|%d|%d|%d|%s",
  (s == null) ? 0 : 1, (s == null) ? -1 : length(s),
  iv("uptime"), tv("load1"), tv("load5"), tv("load15"),
  tv("cpu_pct"), iv("cpu_cores"),
  iv("mem_total"), iv("mem_avail"), tv("mem_pct"),
  iv("swap_total"), iv("swap_free"),
  tv("temp_c"), has("temp_c"),
  iv("disk_total"), iv("disk_used"), tv("disk_pct"),
  iv("wan_rx_rate"), iv("wan_tx_rate"),
  d.totals.direct_rx, d.totals.proxy_rx, length(d.health.reasons),
  d.health.accounting_confidence));'
sysrep(){ F="$1" ucode -e "$SYS_PROG"; }

# system 段体积 + 是否有科学计数法：输出 "对象字节数|sci"
SYSSEG_PROG='let fs=require("fs"); let t=fs.readfile(getenv("F"));
let i=index(t, "\"system\":");
if (i < 0) { print("0|0"); } else {
  let j=i+index(substr(t, i), "{");
  if (j < i) { print("0|0"); } else {
    let depth=0; let end=0;
    for (let k=j; k<length(t); k++) {
      let c=substr(t, k, 1);
      if (c == "{") depth++;
      else if (c == "}") { depth--; if (depth == 0) { end=k+1; break; } }
    }
    if (end <= 0) { print("0|0"); } else {
      let seg=substr(t, j, end-j);
      let sci=(index(seg, "e+") >= 0 || index(seg, "E+") >= 0) ? 1 : 0;
      print(sprintf("%d|%d", end-j, sci));
    }
  }
}'
sysseg(){ F="$1" ucode -e "$SYSSEG_PROG"; }

HASSYS_PROG='let fs=require("fs"); let t=fs.readfile(getenv("F"));
print(index(t, "\"system\":") < 0 ? "0" : "1");'
hassys(){ F="$1" ucode -e "$HASSYS_PROG"; }

SYSJSON_PROG='let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
print(sprintf("%J", d.system));'
sysjson(){ F="$1" ucode -e "$SYSJSON_PROG"; }

# 主统计对照：direct/proxy/tx/reasons/confidence（system 不得改变它们）
CORE_PROG='let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
print(sprintf("%d|%d|%d|%d|%d|%s", d.totals.direct_rx, d.totals.proxy_rx,
  d.totals.direct_tx, d.totals.proxy_tx, length(d.health.reasons),
  d.health.accounting_confidence));'
coreq(){ F="$1" ucode -e "$CORE_PROG"; }

# 造一份固定内容的 /proc（不含 stat / net/dev，由调用方决定用普通文件还是 FIFO）
mkfake(){
  D="$1"; mkdir -p "$D/proc/net"
  printf '123456.78 234567.89\n' > "$D/proc/uptime"
  printf '0.15 1.25 2.75 2/345 6789\n' > "$D/proc/loadavg"
  printf 'processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\nprocessor\t: 3\n' > "$D/proc/cpuinfo"
  printf 'MemTotal:        4194304 kB\nMemFree:         1048576 kB\nMemAvailable:    3145728 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n' > "$D/proc/meminfo"
  printf 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\nwan0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' > "$D/proc/net/route"
}

# 固定内容的 net/dev：$1=文件 $2=wan0 rx $3=wan0 tx $4=wan1 rx $5=wan1 tx
mkdev(){
  cat > "$1" <<NET
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:       1       1    0    0    0     0          0         0      1       1    0    0    0     0       0          0
  wan0: $2      10    0    0    0     0          0         0 $3      20    0    0    0     0       0          0
  wan1: $4       5    0    0    0     0          0         0 $5       6    0    0    0     0       0          0
NET
}

mkfakedf(){ # $1=脚本路径 $2=计数文件
  cat > "$1" <<DF
#!/bin/sh
echo "\$@" >> "$2"
cat <<'OUT'
Filesystem           1024-blocks      Used Available Capacity Mounted on
/dev/root                1048576    262144    786432      25% /
OUT
DF
  chmod 755 "$1"
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin 2>/dev/null)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=${B_CGI:-无}"

echo "=== 1. 安装两个包 ==="
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 && ok "安装 prism-router" || { bad "安装 prism-router"; tail -5 /tmp/i1.log; }
true >/tmp/i2.log 2>&1 && ok "安装 luci-app-prism-router" || { bad "安装 luci-app"; tail -5 /tmp/i2.log; }

echo "=== 2. 新配置项与文件权限 ==="
for k in system_enabled wan_iface; do
  grep -q "option $k" /etc/config/prism-router && ok "config 含 $k" || bad "config 缺少 $k"
done
grep -q "option system_enabled '1'" /etc/config/prism-router && ok "system_enabled 默认 1" || bad "system_enabled 默认值不对"
grep -q "option wan_iface ''" /etc/config/prism-router && ok "wan_iface 默认空（自动默认路由）" || bad "wan_iface 默认值不对"
check /usr/bin/prism-routerd "root:root -rwxr-xr-x"
check /etc/config/prism-router "root:root -rw-r--r--"
check /usr/share/rpcd/ucode/prism-router.uc "root:root -rw-r--r--"

echo "=== 3. 系统目录权限未被改动（回归核心）==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin 2>/dev/null)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 4. ucode 语法 ==="
ucode -c /usr/bin/prism-routerd && ok "prism-routerd 语法 OK" || bad "prism-routerd 语法错误"

echo "=== 5. 容器真实 /proc（两轮采样）==="
UCI set prism-router.settings.lan_ranges='192.168.100.0/24'
UCI set prism-router.settings.system_enabled='1'
UCI set prism-router.settings.wan_iface=''
cfg_commit
cp -f /fixtures/dhcp.leases /tmp/dhcp.leases 2>/dev/null
RC=$(run_once /tmp/sys/real 2 "")
[ "$RC" = "0" ] && ok "真实 /proc 运行退出码 0" || { bad "退出码 $RC"; tail -5 /tmp/sys/real.log; }
if [ -f /tmp/sys/real/state.json ]; then
  R=$(sysrep /tmp/sys/real/state.json); OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  echo "  real system = $(sysjson /tmp/sys/real/state.json)"
  [ "$1" = "1" ] && ok "system 段存在（$2 个字段）" || bad "system 段缺失"
  [ "${3:-0}" -gt 0 ] 2>/dev/null && ok "uptime=$3 (>0)" || bad "uptime=$3"
  [ "${8:-0}" -ge 1 ] 2>/dev/null && ok "cpu_cores=$8 (>=1)" || bad "cpu_cores=$8"
  [ "${9:-0}" -gt 0 ] 2>/dev/null && ok "mem_total=$9 (>0)" || bad "mem_total=$9"
  case "$11" in ''|missing) bad "mem_pct 缺失（真实系统应有 MemAvailable）";;
    *) if [ "$11" -ge 0 ] && [ "$11" -le 1000 ]; then ok "mem_pct=${11} (0..100.0)"; else bad "mem_pct=${11} 越界"; fi;;
  esac
  [ "${16:-0}" -gt 0 ] 2>/dev/null && ok "disk_total=$16 (>0)" || bad "disk_total=$16"
  if [ "$15" = "0" ]; then ok "容器无 thermal_zone0 -> temp_c 省略（不是写 0）"; else
    ok "temp_c=$14 (0.1℃)，容器有 thermal_zone0"
  fi
  SEG=$(sysseg /tmp/sys/real/state.json); IFS='|' read -r SEGLEN SCI <<EOF
$SEG
EOF
  [ "$SEGLEN" -lt 800 ] && ok "真实样本 system 段 $SEGLEN B (<800)" || bad "system 段 $SEGLEN B 超限"
  [ "$SCI" = "0" ] && ok "system 段无科学计数法" || bad "system 段出现科学计数法"
  [ "${21}" = "$EXP_DIRECT_RX" ] && ok "direct_rx=${21}（真实 /proc 不影响主统计）" || bad "direct_rx=${21} 期望 $EXP_DIRECT_RX"
  [ "${22}" = "0" ] && ok "proxy_rx=0（clash 不可达，原有降级不变）" || bad "proxy_rx=${22} 期望 0"
  [ "${23}" = "1" ] && ok "reasons=1（只有 clash 原因，system 未加原因）" || bad "reasons=${23} 期望 1"
else
  bad "真实 /proc：state.json 未生成"; tail -5 /tmp/sys/real.log
fi

echo "=== 6. 伪造 /proc：两次采样（FIFO）==="
FD=/tmp/sys/fifo; rm -rf "$FD"; mkfake "$FD"
mkfakedf "$FD/fakedf" /tmp/sys/df.calls; rm -f /tmp/sys/df.calls
mkfifo "$FD/proc/stat" "$FD/proc/net/dev"
(
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' > "$FD/proc/stat"
  mkdev "$FD/proc/net/dev" 1000 2000 500 600
  printf 'cpu  200 0 200 1400 0 0 0 0 0 0\n' > "$FD/proc/stat"
  mkdev "$FD/proc/net/dev" 11000 3000 5700 5600
) &
WPID=$!
UCI set prism-router.settings.wan_iface=''
cfg_commit
RC=$(run_once /tmp/sys/fake 2 "PRISM_ROUTER_PROC_DIR=$FD/proc PRISM_ROUTER_THERMAL=$FD/no-such-temp PRISM_ROUTER_DF=$FD/fakedf PRISM_ROUTER_ROOTFS=/")
kill "$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null
[ "$RC" = "0" ] && ok "伪造 /proc 运行退出码 0" || { bad "退出码 $RC"; tail -5 /tmp/sys/fake.log; }
if [ -f /tmp/sys/fake/state.json ]; then
  R=$(sysrep /tmp/sys/fake/state.json); OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  echo "  fake system = $(sysjson /tmp/sys/fake/state.json)"
  [ "$1" = "1" ] && ok "system 段存在（$2 个字段）" || bad "system 段缺失"
  [ "$3" = "123456" ] && ok "uptime=123456（/proc/uptime 取整）" || bad "uptime=$3 期望 123456"
  [ "$4" = "2" ] && ok "load1=0.2（0.15 四舍五入到 1 位）" || bad "load1=$4 期望 2（0.2）"
  [ "$5" = "13" ] && ok "load5=1.3" || bad "load5=$5 期望 13（1.3）"
  [ "$6" = "28" ] && ok "load15=2.8" || bad "load15=$6 期望 28（2.8）"
  [ "$7" = "250" ] && ok "cpu_pct=25.0（两次 /proc/stat 差值）" || bad "cpu_pct=$7 期望 250（25.0）"
  [ "$8" = "4" ] && ok "cpu_cores=4（cpuinfo processor 行数）" || bad "cpu_cores=$8 期望 4"
  [ "$9" = "4294967296" ] && ok "mem_total=4 GiB（kB×1024）" || bad "mem_total=$9"
  [ "${10}" = "3221225472" ] && ok "mem_avail=3 GiB" || bad "mem_avail=${10}"
  [ "${11}" = "250" ] && ok "mem_pct=25.0" || bad "mem_pct=${11} 期望 250"
  [ "${12}" = "0" ] && [ "${13}" = "0" ] && ok "swap_total/swap_free=0（合法值，不是缺字段）" || bad "swap=${12}/${13}"
  [ "${15}" = "0" ] && ok "无 thermal -> temp_c 字段省略" || bad "temp_c 在无 thermal 时仍出现"
  [ "${16}" = "1073741824" ] && ok "disk_total=1 GiB" || bad "disk_total=${16}"
  [ "${17}" = "268435456" ] && ok "disk_used=256 MiB" || bad "disk_used=${17}"
  [ "${18}" = "250" ] && ok "disk_pct=25.0（used/(used+avail)）" || bad "disk_pct=${18}"
  if [ "${19}" -ge 5000 ] 2>/dev/null && [ "${19}" -le 10000 ]; then
    ok "wan_rx_rate=${19} B/s（自动取默认路由 wan0，非 wan1）"
  else bad "wan_rx_rate=${19} 不在 5000..10000"; fi
  if [ "${20}" -ge 500 ] 2>/dev/null && [ "${20}" -le 1000 ]; then
    ok "wan_tx_rate=${20} B/s（方向正确）"
  else bad "wan_tx_rate=${20} 不在 500..1000"; fi
  DFC=$(wc -l < /tmp/sys/df.calls 2>/dev/null | tr -d ' ')
  [ "$DFC" = "1" ] && ok "两轮 poll 只执行 1 次 df（60s 缓存生效）" || bad "df 执行了 ${DFC:-0} 次，期望 1"
  SEG=$(sysseg /tmp/sys/fake/state.json); IFS='|' read -r SEGLEN SCI <<EOF
$SEG
EOF
  [ "$SEGLEN" -lt 800 ] && ok "伪造样本 system 段 $SEGLEN B (<800)" || bad "system 段 $SEGLEN B 超限"
  [ "$SCI" = "0" ] && ok "system 段无科学计数法" || bad "system 段出现科学计数法"
  [ "${21}" = "$EXP_DIRECT_RX" ] && ok "direct_rx=${21}（伪造 /proc 不影响主统计）" || bad "direct_rx=${21} 期望 $EXP_DIRECT_RX"
  [ "${22}" = "0" ] && ok "proxy_rx=0（clash 不可达，原有降级不变）" || bad "proxy_rx=${22} 期望 0"
  [ "${23}" = "1" ] && ok "reasons=1（system 未加原因）" || bad "reasons=${23} 期望 1"
  grep -q '"temp_c"' /tmp/sys/fake/state.json && bad "system 里不应出现 temp_c" || ok "system 里确实没有 temp_c"
else
  bad "伪造 /proc：state.json 未生成"; tail -5 /tmp/sys/fake.log
fi

echo "=== 7. 关闭 system_enabled：整段不出现且增量 < 1KB ==="
PD=/tmp/sys/plain; rm -rf "$PD"; mkfake "$PD"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' > "$PD/proc/stat"
mkdev "$PD/proc/net/dev" 1000 2000 500 600
mkfakedf "$PD/fakedf" /tmp/sys/df.plain
UCI set prism-router.settings.system_enabled='0'
cfg_commit
RC=$(run_once /tmp/sys/off 2 "PRISM_ROUTER_PROC_DIR=$PD/proc PRISM_ROUTER_THERMAL=$PD/no-such-temp PRISM_ROUTER_DF=$PD/fakedf")
[ "$RC" = "0" ] && ok "system_enabled=0 运行退出码 0" || bad "退出码 $RC"
UCI set prism-router.settings.system_enabled='1'
cfg_commit
RC=$(run_once /tmp/sys/on 2 "PRISM_ROUTER_PROC_DIR=$PD/proc PRISM_ROUTER_THERMAL=$PD/no-such-temp PRISM_ROUTER_DF=$PD/fakedf")
[ "$RC" = "0" ] && ok "system_enabled=1 运行退出码 0" || bad "退出码 $RC"
if [ -f /tmp/sys/off/state.json ] && [ -f /tmp/sys/on/state.json ]; then
  [ "$(hassys /tmp/sys/off/state.json)" = "0" ] && ok "关闭时 state.json 没有 system 键（老消费方无感）" || bad "关闭时仍出现 system 键"
  [ "$(hassys /tmp/sys/on/state.json)" = "1" ] && ok "开启时 system 键存在" || bad "开启时没有 system 键"
  OFF=$(wc -c < /tmp/sys/off/state.json); ON=$(wc -c < /tmp/sys/on/state.json)
  DIFF=$((ON - OFF))
  [ "$DIFF" -ge 0 ] && [ "$DIFF" -lt 1024 ] && ok "state.json 增量 ${DIFF} B (<1024；off=$OFF on=$ON)" || bad "state.json 增量 ${DIFF} B (off=$OFF on=$ON)"
  [ "$(coreq /tmp/sys/off/state.json)" = "$(coreq /tmp/sys/on/state.json)" ] && ok "direct/proxy/reasons 与关闭 system 时完全一致" || bad "主统计被 system 影响：off=$(coreq /tmp/sys/off/state.json) on=$(coreq /tmp/sys/on/state.json)"
  SEG=$(sysseg /tmp/sys/on/state.json); IFS='|' read -r SEGLEN SCI <<EOF
$SEG
EOF
  [ "$SEGLEN" -lt 800 ] && ok "常量内容样本 system 段 $SEGLEN B (<800)" || bad "system 段 $SEGLEN B 超限"
else
  bad "开启/关闭对照：state.json 缺失"
fi

echo "=== 8. 单字段缺失与 temp 定点换算 ==="
MD=/tmp/sys/memmiss; rm -rf "$MD"; mkfake "$MD"
printf 'MemTotal:        4194304 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n' > "$MD/proc/meminfo"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' > "$MD/proc/stat"
mkdev "$MD/proc/net/dev" 1000 2000 500 600
# 故意用 GNU df 的「长设备名换行」格式：数字行只有 5 个 token，仍应解析出 disk_*
cat > "$MD/fakedf" <<'DF'
#!/bin/sh
cat <<'OUT'
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/mapper/very-long-root-device-name
                 1048576    262144    786432      25% /
OUT
DF
chmod 755 "$MD/fakedf"
printf '42950\n' > "$MD/temp"
RC=$(run_once /tmp/sys/memmiss_state 1 "PRISM_ROUTER_PROC_DIR=$MD/proc PRISM_ROUTER_THERMAL=$MD/temp PRISM_ROUTER_DF=$MD/fakedf")
[ "$RC" = "0" ] && ok "MemAvailable 缺失/temp 存在：退出码 0" || bad "退出码 $RC"
if [ -f /tmp/sys/memmiss_state/state.json ]; then
  R=$(sysrep /tmp/sys/memmiss_state/state.json); OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  [ "${9}" = "4294967296" ] && ok "MemAvailable 缺失时仍保留 mem_total" || bad "mem_total=${9}"
  [ "${10}" = "missing" ] && ok "MemAvailable 缺失 -> mem_avail 省略" || bad "mem_avail=${10} 应省略"
  [ "${11}" = "missing" ] && ok "MemAvailable 缺失 -> mem_pct 省略（不写 0）" || bad "mem_pct=${11} 应省略"
  [ "${12}" = "0" ] && [ "${13}" = "0" ] && ok "swap 0 仍保留（真实值）" || bad "swap=${12}/${13}"
  [ "${15}" = "1" ] && ok "thermal 存在 -> temp_c 出现" || bad "temp_c 未出现"
  [ "${14}" = "430" ] && ok "temp_c=43.0（42950 毫摄氏度 -> 1 位小数）" || bad "temp_c=${14} 期望 430"
  [ "${16}" = "1073741824" ] && [ "${17}" = "268435456" ] && ok "GNU df 长设备名换行仍解析出 disk_total/used" || bad "换行 df 解析失败 total=${16} used=${17}"
else
  bad "单字段缺失：state.json 未生成"; tail -5 /tmp/sys/memmiss_state.log
fi

echo "=== 9. wan_iface 显式配置（wan1）==="
WD=/tmp/sys/wan1; rm -rf "$WD"; mkfake "$WD"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' > "$WD/proc/stat"
mkfifo "$WD/proc/net/dev"
mkfakedf "$WD/fakedf" /tmp/sys/df.wan1
(
  mkdev "$WD/proc/net/dev" 0 0 500 600
  mkdev "$WD/proc/net/dev" 0 0 5700 1100
) &
WPID=$!
UCI set prism-router.settings.wan_iface='wan1'
cfg_commit
RC=$(run_once /tmp/sys/wan1_state 2 "PRISM_ROUTER_PROC_DIR=$WD/proc PRISM_ROUTER_THERMAL=$WD/no-such-temp PRISM_ROUTER_DF=$WD/fakedf")
kill "$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null
UCI set prism-router.settings.wan_iface=''
cfg_commit
[ "$RC" = "0" ] && ok "wan_iface=wan1 运行退出码 0" || { bad "退出码 $RC"; tail -5 /tmp/sys/wan1_state.log; }
if [ -f /tmp/sys/wan1_state/state.json ]; then
  R=$(sysrep /tmp/sys/wan1_state/state.json); OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  if [ "${19}" -ge 3500 ] 2>/dev/null && [ "${19}" -le 7000 ]; then
    ok "显式 wan_iface=wan1 生效：wan_rx_rate=${19} B/s（wan1 差值 5200）"
  else bad "wan_rx_rate=${19} 不符合 wan1（3500..7000）"; fi
  if [ "${20}" -ge 250 ] 2>/dev/null && [ "${20}" -le 500 ]; then
    ok "wan_iface=wan1：wan_tx_rate=${20} B/s（wan1 差值 500）"
  else bad "wan_tx_rate=${20} 不符合 wan1（250..500）"; fi
else
  bad "wan_iface=wan1：state.json 未生成"; tail -5 /tmp/sys/wan1_state.log
fi

echo "=== 10. /proc 全部读不到：空对象 + 主统计零影响 ==="
ED=/tmp/sys/empty; rm -rf "$ED"; mkdir -p "$ED/proc/net"
for f in stat meminfo loadavg uptime cpuinfo; do : > "$ED/proc/$f"; done
: > "$ED/proc/net/dev"; : > "$ED/proc/net/route"
printf '#!/bin/sh\nexit 1\n' > "$ED/faildf"; chmod 755 "$ED/faildf"
UCI set prism-router.settings.system_enabled='1'
cfg_commit
RC=$(run_once /tmp/sys/empty_on 2 "PRISM_ROUTER_PROC_DIR=$ED/proc PRISM_ROUTER_THERMAL=$ED/no-such-temp PRISM_ROUTER_DF=$ED/faildf")
[ "$RC" = "0" ] && ok "空 /proc 运行不崩（退出码 0）" || { bad "退出码 $RC"; tail -5 /tmp/sys/empty_on.log; }
UCI set prism-router.settings.system_enabled='0'
cfg_commit
RC=$(run_once /tmp/sys/empty_off 2 "PRISM_ROUTER_PROC_DIR=$ED/proc PRISM_ROUTER_THERMAL=$ED/no-such-temp PRISM_ROUTER_DF=$ED/faildf")
[ "$RC" = "0" ] && ok "空 /proc（system 关闭）运行退出码 0" || bad "退出码 $RC"
if [ -f /tmp/sys/empty_on/state.json ]; then
  R=$(sysrep /tmp/sys/empty_on/state.json); OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
  [ "$1" = "1" ] && [ "$2" = "0" ] && ok "system 是空对象 {}（没有一个字段写 0）" || bad "system 非空：$2 个字段"
  [ "${21}" = "$EXP_DIRECT_RX" ] && ok "direct_rx=${21} 完全不受影响" || bad "direct_rx=${21} 期望 $EXP_DIRECT_RX"
  [ "${22}" = "0" ] && ok "proxy_rx=0 完全不受影响" || bad "proxy_rx=${22}"
  if [ -f /tmp/sys/empty_off/state.json ]; then
    [ "$(coreq /tmp/sys/empty_on/state.json)" = "$(coreq /tmp/sys/empty_off/state.json)" ] && ok "空 /proc 与 system 关闭时主统计逐字节一致" || bad "主统计被影响"
  fi
  [ "${23}" = "1" ] && ok "reasons=1（读不到 /proc 不进 reasons）" || bad "reasons=${23} 期望 1"
  [ "$(hassys /tmp/sys/empty_on/state.json)" = "1" ] && ok "开启时即使全失败也保留空 system 对象" || bad "空 system 对象缺失"
else
  bad "空 /proc：state.json 未生成"; tail -5 /tmp/sys/empty_on.log
fi

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
