#!/bin/bash
# 不依赖 OpenWrt SDK 手搓 .ipk（纯脚本包，无编译产物）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"; VER=1.0.0; REL=1
rm -rf "$OUT"; mkdir -p "$OUT"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

pack() { # $1=dir $2=basename（不带扩展名）
  local d="$1" base="$2"
  # 关键：必须强制 root:root 且目录 755。
  # 否则 opkg 会把包里的目录条目（./etc/、./usr/、./www/）套用到真实系统目录上，
  # 这正是 2026-11-14 把 /etc /usr /www 改成 uid1000/700、导致 ubus 与网络全挂的原因。
  find "$d/data" -type d -exec chmod 755 {} +
  find "$d/data" -type f -exec chmod 644 {} +
  chmod 755 "$d/data/usr/bin/traffic-statsd" "$d/data/etc/init.d/traffic-statsd" "$d/data/usr/share/traffic-stats/feishu-test.sh" 2>/dev/null || true
  local TO="--owner=0 --group=0 --numeric-owner"
  ( cd "$d/data" && tar $TO -czf ../data.tar.gz . )
  ( cd "$d/control" && tar $TO -czf ../control.tar.gz . )
  printf '2.0\n' > "$d/debian-binary"
  # 标准 OpenWrt / Debian 风格：ar 容器
  ( cd "$d" && ar rc "$OUT/${base}.ipk" debian-binary control.tar.gz data.tar.gz )
  # iStoreOS 定制 opkg（abpkg 标志）只认 tar 容器
  ( cd "$d" && tar -czf "$OUT/${base}.istore.ipk" debian-binary control.tar.gz data.tar.gz )
  echo "  ✓ dist/${base}.ipk        $(stat -c%s "$OUT/${base}.ipk") B (ar, 标准 OpenWrt)"
  echo "  ✓ dist/${base}.istore.ipk $(stat -c%s "$OUT/${base}.istore.ipk") B (tar, iStoreOS)"
}
ctl() { # $1=dir  $2=pkgname  $3=section  $4=depends  $5=desc
  printf 'Package: %s\nVersion: %s-%s\nArchitecture: all\nMaintainer: traffic-stats\nSection: %s\nPriority: optional\nDepends: %s\nDescription: %s\n' \
    "$2" "$VER" "$REL" "$3" "$4" "$5" > "$1/control/control"
}
hook() { printf '%s\n' "$@" > "$W/_h"; }

# ================= traffic-stats =================
D="$W/ts"; mkdir -p "$D/data/usr/bin" "$D/data/usr/share/traffic-stats" \
  "$D/data/etc/init.d" "$D/data/etc/config" "$D/data/etc/traffic-stats/daily" "$D/control"
cp "$ROOT/traffic-stats/files/traffic-statsd.uc"  "$D/data/usr/bin/traffic-statsd"; chmod 755 "$D/data/usr/bin/traffic-statsd"
cp "$ROOT/traffic-stats/files/feishu.uc"          "$D/data/usr/share/traffic-stats/feishu.uc"; chmod 644 "$D/data/usr/share/traffic-stats/feishu.uc"
cp "$ROOT/traffic-stats/files/feishu-test.sh"     "$D/data/usr/share/traffic-stats/feishu-test.sh"; chmod 755 "$D/data/usr/share/traffic-stats/feishu-test.sh"
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
cp "$ROOT/luci-app-traffic-stats/root/usr/share/luci/menu.d/luci-app-traffic-stats.json" "$D/data/usr/share/luci/menu.d/"
cp "$ROOT/luci-app-traffic-stats/root/usr/share/rpcd/acl.d/luci-app-traffic-stats.json"   "$D/data/usr/share/rpcd/acl.d/"
cp "$ROOT/luci-app-traffic-stats/root/usr/share/rpcd/ucode/traffic-stats.uc"              "$D/data/usr/share/rpcd/ucode/"
find "$D/data/www" -type f -exec chmod 644 {} \;
ctl "$D" luci-app-traffic-stats luci "luci-base, rpcd-mod-ucode, ucode, ucode-mod-fs, ucode-mod-uci, traffic-stats" \
  "LuCI pages for traffic statistics (overview / devices / apps / settings)."
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' 'rm -f /tmp/luci-indexcache* 2>/dev/null' '/etc/init.d/rpcd reload >/dev/null 2>&1' 'exit 0'
cp "$W/_h" "$D/control/postinst"; chmod 755 "$D/control/postinst"
pack "$D" "luci-app-traffic-stats_${VER}-${REL}_all"
