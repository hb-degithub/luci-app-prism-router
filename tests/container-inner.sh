#!/bin/sh
mkdir -p /var/lock /var/run /tmp 2>/dev/null
# 在隔离容器内运行：安装包 → 断言权限未被破坏 → 跑守护进程离线用例
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ # $1=路径 $2=期望 "root:root 权限"
  local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW"

echo "=== 1. 安装 traffic-stats ==="
opkg install --force-depends /src/dist/traffic-stats_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 && ok "安装成功" || { bad "安装失败"; tail -5 /tmp/i1.log; }

echo "=== 2. 关键文件与属主权限 ==="
for f in /usr/bin/traffic-statsd /etc/init.d/traffic-statsd /etc/config/traffic-stats /usr/share/traffic-stats/feishu.uc; do
  if [ -e "$f" ]; then ok "存在 $f  ($(perm "$f"))"; else bad "缺失 $f"; fi
done
check /usr/bin/traffic-statsd "root:root -rwxr-xr-x"
check /usr/share/traffic-stats "root:root drwxr-xr-x"
check /etc/init.d/traffic-statsd "root:root -rwxr-xr-x"
check /etc/config/traffic-stats "root:root -rw-r--r--"

echo "=== 3. 安装 luci-app ==="
opkg install --force-depends /src/dist/luci-app-traffic-stats_1.0.0-1_all.ipk >/tmp/i2.log 2>&1 && ok "安装成功" || { bad "安装失败"; tail -5 /tmp/i2.log; }
check /www/luci-static/resources/view/traffic-stats "root:root drwxr-xr-x"
check /www/luci-static/resources/view/traffic-stats/overview.js "root:root -rw-r--r--"
check /usr/share/rpcd/ucode/traffic-stats.uc "root:root -rw-r--r--"

echo "=== 4. 系统目录权限未被改动（回归核心）==="
A_ETC=$(perm /etc); A_USR=$(perm /usr); A_WWW=$(perm /www)
[ "$B_ETC" = "$A_ETC" ] && ok "/etc 未变 ($A_ETC)" || bad "/etc 被改动: $B_ETC -> $A_ETC"
[ "$B_USR" = "$A_USR" ] && ok "/usr 未变 ($A_USR)" || bad "/usr 被改动: $B_USR -> $A_USR"
[ "$B_WWW" = "$A_WWW" ] && ok "/www 未变 ($A_WWW)" || bad "/www 被改动: $B_WWW -> $A_WWW"
for d in /etc/config /etc/init.d /usr/share /usr/share/rpcd /usr/share/rpcd/ucode /usr/share/luci/menu.d; do
  p=$(perm "$d")
  case "$p" in *"root:root"*) ok "$d 属主 root ($p)";; *) bad "$d 属主异常 ($p)";; esac
done

echo "=== 4.5 ucode 模块 ==="
ls /usr/lib/ucode/ 2>/dev/null | tr '\n' ' '; echo
[ -e /usr/lib/ucode/uloop.so ] && ok "uloop 模块存在" || bad "uloop 模块缺失（依赖未装）"

echo "=== 5. 守护进程离线用例（合成 conntrack + clash 不可达）==="
rm -rf /tmp/ts-vm && mkdir -p /tmp/ts-vm
# 容器里没有 br-lan，显式指定 LAN 网段与租约文件，模拟真实设备
if command -v uci >/dev/null 2>&1; then
  uci set traffic-stats.settings.lan_ranges='192.168.100.0/24' 2>/dev/null && uci commit traffic-stats 2>/dev/null
else
  printf "\n\toption lan_ranges '192.168.100.0/24'\n" >> /etc/config/traffic-stats
fi
cp -f /fixtures/dhcp.leases /tmp/dhcp.leases 2>/dev/null
TRAFFIC_STATS_ONCE=1 TRAFFIC_STATS_CONNTRACK_FILE=/fixtures/nf_conntrack \
TRAFFIC_STATS_CLASH_API=127.0.0.1:1 TRAFFIC_STATS_STATE_DIR=/tmp/ts-vm \
ucode /usr/bin/traffic-statsd >/tmp/daemon.log 2>&1
[ -f /tmp/ts-vm/state.json ] && ok "state.json 生成" || { bad "state.json 未生成"; tail -5 /tmp/daemon.log; }
if [ -f /tmp/ts-vm/state.json ]; then
  R=$(ucode -e 'let fs=require("fs"); let d=json(fs.readfile("/tmp/ts-vm/state.json")); printf("%d %d %s", length(d.devices), d.totals.direct_rx, d.health.accounting_confidence);' 2>/dev/null)
  set -- $R
  [ "${1:-0}" -ge 1 ] && ok "识别到设备数=$1" || bad "设备数=0"
  # direct_rx 只统计下载方向：900000(flow1 reply) + 240(flow3 reply) = 900240
  # fake-ip 流(flow2) 的 8000 必须被排除；若被误计会是 908240
  [ "${2:-0}" = "900240" ] && ok "direct_rx=$2（fake-ip 的 8000 已排除）" || bad "direct_rx=$2，期望 900240"
  [ "$3" = "degraded" ] && ok "clash 不可达 → confidence=degraded" || bad "confidence=$3，期望 degraded"
fi

echo "=== 6. 飞书卡片生成（离线）==="
mkdir -p /tmp/traffic-stats && cp -f /tmp/ts-vm/state.json /tmp/traffic-stats/state.json 2>/dev/null
if [ -e /usr/share/traffic-stats/feishu.uc ]; then
  ucode /usr/share/traffic-stats/feishu.uc card --out /tmp/card.json >/tmp/f.log 2>&1
  if [ -s /tmp/card.json ]; then
    SZ=$(wc -c < /tmp/card.json)
    [ "$SZ" -lt 20480 ] && ok "卡片 $SZ 字节 (<20480)" || bad "卡片超限 $SZ"
  else bad "卡片未生成 ($(tail -1 /tmp/f.log))"; fi
else bad "feishu.uc 缺失"; fi

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
