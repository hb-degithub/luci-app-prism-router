#!/bin/bash
# 冒烟测试：对主路由上已部署的系统做端到端检查
# 用法: ./tests/smoke.sh [--with-traffic]
set -uo pipefail
RSH() { ( cd ~/软路由 && ./rssh.sh "$@" ); }
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info() { echo "  ·  $1"; }

echo "=== 1. 守护进程与状态文件 ==="
RUNNING=$(RSH 'ps | grep -c "[t]raffic-statsd\|[t]s.uc"' 2>/dev/null | tr -d '\r')
[ "${RUNNING:-0}" -ge 1 ] && ok "进程在运行" || bad "进程未运行"
STATE=$(RSH 'cat /tmp/traffic-stats/state.json 2>/dev/null' 2>/dev/null)
if [ -z "$STATE" ]; then bad "state.json 不存在"; else ok "state.json 存在 ($(echo -n "$STATE" | wc -c) 字节)"; fi

echo "=== 2. 数据结构与关键字段 ==="
for k in '"ts"' '"totals"' '"devices"' '"nodes"' '"health"'; do
  echo "$STATE" | grep -q "$k" && ok "字段 $k" || bad "缺字段 $k"
done
DEVS=$(echo "$STATE" | grep -o '"ip":"[^"]*"' | wc -l)
[ "${DEVS:-0}" -ge 1 ] && ok "设备数=$DEVS" || bad "设备列表为空"

echo "=== 3. 代理/直连互斥（关键） ==="
PRX=$(echo "$STATE" | grep -o '"proxy_rx":[0-9]*' | head -1 | cut -d: -f2)
DRX=$(echo "$STATE" | grep -o '"direct_rx":[0-9]*' | head -1 | cut -d: -f2)
info "proxy_rx=${PRX:-0}  direct_rx=${DRX:-0}"
if [ "${PRX:-0}" -gt 0 ] && [ "${DRX:-0}" -gt 0 ]; then ok "两个桶都有数据"
elif [ "${PRX:-0}" -gt 0 ] || [ "${DRX:-0}" -gt 0 ]; then info "只有一个桶有数据（可能当前无对应流量）"
else bad "两个桶都是 0"; fi

echo "=== 4. rpcd 接口 ==="
for m in status get_state; do
  OUT=$(RSH "ubus call traffic-stats $m" 2>&1 | head -c 200)
  case "$OUT" in *'"'*) ok "ubus $m 有返回" ;; *) bad "ubus $m: $(echo "$OUT" | head -1)" ;; esac
done

echo "=== 5. LuCI 页面（带会话）==="
RSH 'PW="${LUCI_PW:-}"; rm -f /tmp/ck.txt; [ -n "$PW" ] && curl -sk -c /tmp/ck.txt -o /dev/null --data-urlencode "luci_username=root" --data-urlencode "luci_password=$PW" "https://127.0.0.1/cgi-bin/luci/"' >/dev/null 2>&1
for p in overview devices apps settings; do
  CODE=$(RSH "curl -sk -b /tmp/ck.txt -o /dev/null -w '%{http_code}' https://127.0.0.1/cgi-bin/luci/admin/services/traffic-stats/$p" 2>/dev/null | tr -d '\r')
  JS=$(RSH "curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/luci-static/resources/view/traffic-stats/$p.js" 2>/dev/null | tr -d '\r')
  case "$CODE:$JS" in 200:200) ok "页面 $p（html=200 js=200）" ;; *:200) ok "页面 $p（js 可取，html=$CODE 未登录）" ;; *) bad "页面 $p html=$CODE js=$JS" ;; esac
done

echo "=== 6. 资源占用 ==="
RSH 'ps -o pid,rss,vsz,comm 2>/dev/null | grep -E "traffic-statsd|ts.uc" | head -3' 2>/dev/null

echo
echo "=== 结果：通过 $PASS / 失败 $FAIL ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
