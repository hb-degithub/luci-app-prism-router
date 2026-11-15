#!/bin/bash
# 不依赖 OpenWrt SDK 手搓 .ipk（纯脚本包，无编译产物）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"; VER=1.0.0; REL=1
rm -rf "$OUT"; mkdir -p "$OUT"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

pack() { # $1=dir $2=basename（不带扩展名）
  local d="$1" base="$2"
  # 关键：强制 root:root + 目录 755，避免 2026-11-14 那种把 /etc /usr /www 改成 1000/700 的事故
  find "$d/data" -type d -exec chmod 755 {} +
  find "$d/data" -type f -exec chmod 644 {} +
  # 可执行条目单独 755：守护进程 / init / 测试脚本 / 接收子节点上报的 CGI / 接收 AP 站点元数据的 CGI
  chmod 755 "$d/data/usr/bin/traffic-statsd" "$d/data/etc/init.d/traffic-statsd" \
    "$d/data/usr/share/traffic-stats/feishu-test.sh" \
    "$d/data/www/cgi-bin/traffic-stats-ingest" \
    "$d/data/www/cgi-bin/traffic-stats-stations" 2>/dev/null || true
  local TO="--owner=0 --group=0 --numeric-owner"
  ( cd "$d/data"    && tar $TO -czf ../data.tar.gz . )
  ( cd "$d/control" && tar $TO -czf ../control.tar.gz . )
  printf '2.0\n' > "$d/debian-binary"
  # OpenWrt 24.10+ 的 ipk 外层就是 tar.gz（不是 ar！）
  ( cd "$d" && tar $TO -czf "$OUT/${base}.ipk" ./debian-binary ./data.tar.gz ./control.tar.gz )
  # 23.05 及更早用 ar 容器，留一份备用
  ( cd "$d" && ar rc "$OUT/${base}.legacy.ipk" debian-binary control.tar.gz data.tar.gz )
  echo "  ✓ dist/${base}.ipk         $(stat -c%s "$OUT/${base}.ipk") B (tar.gz, 24.10+)"
  echo "  ✓ dist/${base}.legacy.ipk  $(stat -c%s "$OUT/${base}.legacy.ipk") B (ar, 极旧版本, 未验证)"
}
ctl() { # $1=dir  $2=pkgname  $3=section  $4=depends  $5=desc
  printf 'Package: %s\nVersion: %s-%s\nArchitecture: all\nMaintainer: traffic-stats\nSection: %s\nPriority: optional\nDepends: %s\nDescription: %s\n' \
    "$2" "$VER" "$REL" "$3" "$4" "$5" > "$1/control/control"
}
hook() { printf '%s\n' "$@" > "$W/_h"; }

# ================= traffic-stats =================
D="$W/ts"; mkdir -p "$D/data/usr/bin" "$D/data/usr/share/traffic-stats" \
  "$D/data/etc/init.d" "$D/data/etc/config" "$D/data/etc/traffic-stats/daily" \
  "$D/data/www/cgi-bin" "$D/control"
cp "$ROOT/traffic-stats/files/traffic-statsd.uc"  "$D/data/usr/bin/traffic-statsd"; chmod 755 "$D/data/usr/bin/traffic-statsd"
cp "$ROOT/traffic-stats/files/feishu.uc"          "$D/data/usr/share/traffic-stats/feishu.uc"; chmod 644 "$D/data/usr/share/traffic-stats/feishu.uc"
cp "$ROOT/traffic-stats/files/feishu-test.sh"     "$D/data/usr/share/traffic-stats/feishu-test.sh"; chmod 755 "$D/data/usr/share/traffic-stats/feishu-test.sh"
# 数据 / 日志保留与清理（用户 cron 调用；只动白名单目录，见 docs/SPEC.md §9）
cp "$ROOT/traffic-stats/files/retention.uc"       "$D/data/usr/share/traffic-stats/retention.uc"; chmod 644 "$D/data/usr/share/traffic-stats/retention.uc"
# 子节点推送脚本（cron 调用；不进 PATH，避免和守护进程抢名字）
cp "$ROOT/traffic-stats/files/push.uc"            "$D/data/usr/share/traffic-stats/push.uc"; chmod 644 "$D/data/usr/share/traffic-stats/push.uc"
# 母节点接收端：CGI，必须可执行（uhttpd -c /cgi-bin 直接 exec）
cp "$ROOT/traffic-stats/files/ingest.uc"          "$D/data/www/cgi-bin/traffic-stats-ingest"; chmod 755 "$D/data/www/cgi-bin/traffic-stats-ingest"
# 哑桥 AP 侧：无线站点元数据上报（cron 调用；只报信号/速率，绝不报字节）
cp "$ROOT/traffic-stats/files/stations.uc"        "$D/data/usr/share/traffic-stats/stations.uc"; chmod 644 "$D/data/usr/share/traffic-stats/stations.uc"
# 母节点接收端：AP 站点元数据 CGI（必须可执行；不写 jsonl 历史）
cp "$ROOT/traffic-stats/files/ingest-stations.uc" "$D/data/www/cgi-bin/traffic-stats-stations"; chmod 755 "$D/data/www/cgi-bin/traffic-stats-stations"
cp "$ROOT/traffic-stats/files/traffic-statsd.init" "$D/data/etc/init.d/traffic-statsd"; chmod 755 "$D/data/etc/init.d/traffic-statsd"
cp "$ROOT/traffic-stats/files/traffic-stats.config" "$D/data/etc/config/traffic-stats"; chmod 644 "$D/data/etc/config/traffic-stats"
ctl "$D" traffic-stats net "ucode, ucode-mod-fs, ucode-mod-uci, ucode-mod-uloop, curl" \
  "Traffic statistics daemon: per-device/per-app usage with proxy-vs-direct split (OpenClash API + conntrack)."
printf '/etc/config/traffic-stats\n' > "$D/control/conffiles"
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' '/etc/init.d/traffic-statsd enable >/dev/null 2>&1' '/etc/init.d/traffic-statsd restart >/dev/null 2>&1' 'exit 0'
cp "$W/_h" "$D/control/postinst"; chmod 755 "$D/control/postinst"
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' '/etc/init.d/traffic-statsd stop >/dev/null 2>&1' '/etc/init.d/traffic-statsd disable >/dev/null 2>&1' 'exit 0'
cp "$W/_h" "$D/control/prerm"; chmod 755 "$D/control/prerm"
pack "$D" "traffic-stats_${VER}-${REL}_all"

# ================= luci-app-traffic-stats =================
D="$W/luci"; mkdir -p "$D/data/www/luci-static/resources/view/traffic-stats" \
  "$D/data/usr/share/luci/menu.d" "$D/data/usr/share/rpcd/acl.d" "$D/data/usr/share/rpcd/ucode" "$D/control"
cp "$ROOT"/luci-app-traffic-stats/htdocs/luci-static/resources/view/traffic-stats/*.js \
   "$D/data/www/luci-static/resources/view/traffic-stats/"
# PWA 资源（manifest + 主屏图标）
mkdir -p "$D/data/www/luci-static/resources/traffic-stats"
cp "$ROOT"/luci-app-traffic-stats/htdocs/luci-static/resources/traffic-stats/* \
   "$D/data/www/luci-static/resources/traffic-stats/" 2>/dev/null || true
cp "$ROOT/luci-app-traffic-stats/root/usr/share/luci/menu.d/luci-app-traffic-stats.json" "$D/data/usr/share/luci/menu.d/"
cp "$ROOT/luci-app-traffic-stats/root/usr/share/rpcd/acl.d/luci-app-traffic-stats.json"   "$D/data/usr/share/rpcd/acl.d/"
cp "$ROOT/luci-app-traffic-stats/root/usr/share/rpcd/ucode/traffic-stats.uc"              "$D/data/usr/share/rpcd/ucode/"
find "$D/data/www" -type f -exec chmod 644 {} \;
ctl "$D" luci-app-traffic-stats luci "luci-base, rpcd-mod-ucode, ucode, ucode-mod-fs, ucode-mod-uci, traffic-stats" \
  "LuCI pages for traffic statistics (overview / devices / apps / settings)."
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' 'rm -f /tmp/luci-indexcache* 2>/dev/null' '/etc/init.d/rpcd reload >/dev/null 2>&1' 'exit 0'
cp "$W/_h" "$D/control/postinst"; chmod 755 "$D/control/postinst"
pack "$D" "luci-app-traffic-stats_${VER}-${REL}_all"
