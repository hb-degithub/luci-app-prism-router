#!/bin/bash
# 把仓库文件部署到路由器（开发期用，不生成 ipk）
# 用法: ./tools/deploy.sh [main|ap|both] [--daemon-only|--ui-only]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-main}"; shift || true
MODE="${1:---all}"
RSH() { ( cd ~/软路由 && ./rssh.sh "$@" ); }
ASH() { ( cd ~/软路由 && ./assh.sh "$@" ); }

push_daemon() {
  echo "[daemon] -> $1"
  $2 'mkdir -p /tmp/traffic-stats /etc/traffic-stats/daily'
  cat "$HERE/traffic-stats/files/traffic-statsd.uc" | $2 'cat > /tmp/traffic-statsd.uc'
  [ -f "$HERE/traffic-stats/files/feishu.uc" ] && cat "$HERE/traffic-stats/files/feishu.uc" | $2 'cat > /tmp/feishu.uc' || true
  echo "  ok"
}
push_ui() {
  echo "[ui] -> $1"
  $2 'mkdir -p /www/luci-static/resources/view/traffic-stats /usr/share/rpcd/ucode /usr/share/rpcd/acl.d /usr/share/luci/menu.d'
  for f in "$HERE"/luci-app-traffic-stats/htdocs/luci-static/resources/view/traffic-stats/*.js; do
    [ -e "$f" ] || continue
    b=$(basename "$f"); cat "$f" | $2 "cat > /www/luci-static/resources/view/traffic-stats/$b"
  done
  cat "$HERE/luci-app-traffic-stats/root/usr/share/rpcd/ucode/traffic-stats.uc" | $2 'cat > /usr/share/rpcd/ucode/traffic-stats.uc'
  cat "$HERE/luci-app-traffic-stats/root/usr/share/rpcd/acl.d/luci-app-traffic-stats.json" | $2 'cat > /usr/share/rpcd/acl.d/luci-app-traffic-stats.json'
  cat "$HERE/luci-app-traffic-stats/root/usr/share/luci/menu.d/luci-app-traffic-stats.json" | $2 'cat > /usr/share/luci/menu.d/luci-app-traffic-stats.json'
  echo "  ok（需 /etc/init.d/rpcd reload）"
}
case "$TARGET" in
  main) HOST=192.168.100.1; RUN=RSH ;;
  ap)   HOST=192.168.100.3; RUN=ASH ;;
  both) push_daemon 192.168.100.1 RSH; push_daemon 192.168.100.3 ASH; exit 0 ;;
  *) echo "usage: $0 [main|ap|both] [--all|--daemon-only|--ui-only]"; exit 1 ;;
esac
case "$MODE" in
  --daemon-only) push_daemon "$HOST" "$RUN" ;;
  --ui-only)     push_ui "$HOST" "$RUN" ;;
  *)             push_daemon "$HOST" "$RUN"; push_ui "$HOST" "$RUN" ;;
esac
