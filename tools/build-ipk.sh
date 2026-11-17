#!/bin/bash
# 不依赖 OpenWrt SDK 手搓 .ipk（纯脚本包，无编译产物）
#
# 产物（默认只有 2 个 modern 包 + SHA256SUMS）：
#   dist/prism-router_1.0.0-1_all.ipk
#   dist/luci-app-prism-router_1.0.0-1_all.ipk
#   dist/SHA256SUMS
#
# 24.10 / 23.05 的 .ipk 外层都是 tar.gz（见 docs/IPK-FORMAT.md）。
# 极旧版本（21.02 及更早）才需要 ar 容器；默认不再生成，只有显式
# `--legacy` 才会额外产出 *.legacy.ipk，并打印“不可发布”警告。
#
# 用法：
#   tools/build-ipk.sh                 # 重建 dist/，2 个 modern 包 + SHA256SUMS
#   tools/build-ipk.sh --legacy        # 额外产 ar 包（仅排查极旧版本，不要发布）
#   tools/build-ipk.sh --out DIR       # 输出到指定目录（供测试用临时目录）
#   tools/build-ipk.sh --help
set -euo pipefail
# 事故复核（docs/INCIDENT-2026-11-14.md）：任何 mktemp/install 默认都必须是
# 755/644，不能把调用者的 0077 之类的 umask 带进归档。
umask 022
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"; LEGACY=0
VER=1.0.0; REL=1

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --legacy) LEGACY=1 ;;
    --out)    [ $# -ge 2 ] || { echo "build-ipk: --out 需要目录参数" >&2; exit 2; }
              OUT="$2"; shift ;;
    --out=*)  OUT="${1#--out=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "build-ipk: 未知参数 $1（--help 查看用法）" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$OUT" ] || { echo "build-ipk: 输出目录为空" >&2; exit 2; }
case "$OUT" in
  /|.|..|"$HOME"|"$ROOT") echo "build-ipk: 拒绝把输出目录设为 $OUT" >&2; exit 2 ;;
esac
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
# 自定义输出必须位于项目 dist 或系统临时目录，防止误清空普通工作目录。
if [ "$OUT" != "$ROOT/dist" ]; then
  case "$OUT" in
    /tmp/*) ;;
    *) echo "build-ipk: --out 仅允许 $ROOT/dist 或 /tmp/ 下的专用目录" >&2; exit 2 ;;
  esac
fi
# 输出目录是纯构建产物；先清空，避免旧包/旧 SHA 混进发布集。
rm -rf -- "$OUT"
mkdir -p -- "$OUT"
chmod 755 "$OUT"

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
chmod 755 "$W"

pack() { # $1=dir $2=basename（不带扩展名）
  local d="$1" base="$2"
  # 关键：强制 root:root + 目录 755，避免 2026-11-14 那种把 /etc /usr /www 改成 1000/700 的事故
  find "$d/data" -type d -exec chmod 755 {} +
  find "$d/data" -type f -exec chmod 644 {} +
  # 可执行条目单独 755：守护进程 / init / 测试脚本 / 接收子节点上报的 CGI / 接收 AP 站点元数据的 CGI
  # / 独立面板的 init 与只读 CGI（静态页面仍是 644）
  chmod 755 "$d/data/usr/bin/prism-routerd" "$d/data/etc/init.d/prism-routerd" \
    "$d/data/usr/share/prism-router/feishu-test.sh" \
    "$d/data/www/cgi-bin/prism-router-ingest" \
    "$d/data/www/cgi-bin/prism-router-stations" \
    "$d/data/www/cgi-bin/prism-router-metrics" \
    "$d/data/etc/init.d/prism-router-panel" \
    "$d/data/www/prism-router-panel/cgi-bin/panel-api" 2>/dev/null || true
  # control 归档：目录 755，control/conffiles 644，维护脚本 755（opkg 会直接 exec）
  find "$d/control" -type d -exec chmod 755 {} +
  chmod 644 "$d/control/control"
  [ -f "$d/control/conffiles" ] && chmod 644 "$d/control/conffiles" || true
  [ -f "$d/control/postinst" ]  && chmod 755 "$d/control/postinst" || true
  [ -f "$d/control/prerm" ]     && chmod 755 "$d/control/prerm" || true
  # --sort=name：条目顺序稳定；owner/group 固定 0。时间位不追平（需求只要求权限/元数据可复现）。
  local TO=(--owner=0 --group=0 --numeric-owner --sort=name)
  ( cd "$d/data"    && tar "${TO[@]}" -czf ../data.tar.gz . )
  ( cd "$d/control" && tar "${TO[@]}" -czf ../control.tar.gz . )
  printf '2.0\n' > "$d/debian-binary"
  chmod 644 "$d/debian-binary"
  # OpenWrt 23.05 / 24.10 的 ipk 外层就是 tar.gz（不是 ar！）
  ( cd "$d" && tar "${TO[@]}" -czf "$OUT/${base}.ipk" ./debian-binary ./data.tar.gz ./control.tar.gz )
  chmod 644 "$OUT/${base}.ipk"
  # 23.05 及更早用 ar 容器，留一份备用（仅 --legacy）
  if [ "$LEGACY" = 1 ]; then
    ( cd "$d" && ar rcD "$OUT/${base}.legacy.ipk" debian-binary control.tar.gz data.tar.gz )
    chmod 644 "$OUT/${base}.legacy.ipk"
    echo "  ⚠ dist/${base}.legacy.ipk  $(stat -c%s "$OUT/${base}.legacy.ipk") B (ar, 极旧版本, 未验证, 不可发布)"
  fi
  echo "  ✓ dist/${base}.ipk         $(stat -c%s "$OUT/${base}.ipk") B (tar.gz, 23.05/24.10)"
}

ctl() { # $1=dir  $2=pkgname  $3=section  $4=depends  $5=desc
  # Priority 必须是 Debian/OpenWrt 的合法值；不能把占位符/密码类字符串写进 control。
  # Depends 必须与两个 Makefile 保持一致（release gate 会逐项比对）。
  printf 'Package: %s\nVersion: %s-%s\nArchitecture: all\nMaintainer: prism-router\nSection: %s\nPriority: standard\nDepends: %s\nDescription: %s\n' \
    "$2" "$VER" "$REL" "$3" "$4" "$5" > "$1/control/control"
  chmod 644 "$1/control/control"
}
hook() { printf '%s\n' "$@" > "$W/_h"; chmod 644 "$W/_h"; }

# ================= prism-router =================
D="$W/ts"; mkdir -p "$D/data/usr/bin" "$D/data/usr/share/prism-router" \
  "$D/data/etc/init.d" "$D/data/etc/config" "$D/data/etc/prism-router/daily" \
  "$D/data/www/cgi-bin" "$D/data/www/prism-router-panel/cgi-bin" "$D/control"
chmod 755 "$D" "$D/control" "$D/data" "$D/data/usr" "$D/data/usr/bin" \
  "$D/data/usr/share" "$D/data/usr/share/prism-router" \
  "$D/data/etc" "$D/data/etc/init.d" "$D/data/etc/config" \
  "$D/data/etc/prism-router" "$D/data/etc/prism-router/daily" \
  "$D/data/www" "$D/data/www/cgi-bin" \
  "$D/data/www/prism-router-panel" "$D/data/www/prism-router-panel/cgi-bin"
install -m 755 "$ROOT/prism-router/files/prism-routerd.uc"  "$D/data/usr/bin/prism-routerd"
install -m 644 "$ROOT/prism-router/files/feishu.uc"          "$D/data/usr/share/prism-router/feishu.uc"
install -m 755 "$ROOT/prism-router/files/feishu-test.sh"     "$D/data/usr/share/prism-router/feishu-test.sh"
# 数据 / 日志保留与清理（用户 cron 调用；只动白名单目录，见 docs/SPEC.md §9）
install -m 644 "$ROOT/prism-router/files/retention.uc"       "$D/data/usr/share/prism-router/retention.uc"
# 子节点推送脚本（cron 调用；不进 PATH，避免和守护进程抢名字）
install -m 644 "$ROOT/prism-router/files/push.uc"            "$D/data/usr/share/prism-router/push.uc"
# 母节点接收端：CGI，必须可执行（uhttpd -c /cgi-bin 直接 exec）
install -m 755 "$ROOT/prism-router/files/ingest.uc"          "$D/data/www/cgi-bin/prism-router-ingest"
# 哑桥 AP 侧：无线站点元数据上报（cron 调用；只报信号/速率，绝不报字节）
install -m 644 "$ROOT/prism-router/files/stations.uc"        "$D/data/usr/share/prism-router/stations.uc"
# 安全模块新增的节点/站点认证共享库：存在就打包，不存在不影响；不能因手打包漏掉。
if [ -f "$ROOT/prism-router/files/prism-router-node-auth.uc" ]; then
  install -m 644 "$ROOT/prism-router/files/prism-router-node-auth.uc" \
    "$D/data/usr/share/prism-router/prism-router-node-auth.uc"
  echo "  + prism-router: 含 prism-router-node-auth.uc"
fi
# 母节点接收端：AP 站点元数据 CGI（必须可执行；不写 jsonl 历史）
install -m 755 "$ROOT/prism-router/files/ingest-stations.uc" "$D/data/www/cgi-bin/prism-router-stations"
# Prometheus 指标导出 CGI（只读；token 认证；未启用/未配 token 一律 403）
install -m 755 "$ROOT/prism-router/files/prism-router-metrics.uc" "$D/data/www/cgi-bin/prism-router-metrics"
install -m 755 "$ROOT/prism-router/files/prism-routerd.init" "$D/data/etc/init.d/prism-routerd"
install -m 644 "$ROOT/prism-router/files/prism-router.config" "$D/data/etc/config/prism-router"
# 独立面板服务：procd 管理的独立 uhttpd 实例（init）+ 只读 ucode CGI。
# 静态页面由前端任务放在 prism-router/files/panel/，存在才装（空目录不失败）。
install -m 755 "$ROOT/prism-router/files/prism-router-panel.init" "$D/data/etc/init.d/prism-router-panel"
if [ -f "$ROOT/prism-router/files/panel-api.uc" ]; then
  install -m 755 "$ROOT/prism-router/files/panel-api.uc" \
    "$D/data/www/prism-router-panel/cgi-bin/panel-api"
fi
if [ -d "$ROOT/prism-router/files/panel" ]; then
  for f in "$ROOT"/prism-router/files/panel/*; do
    [ -f "$f" ] || continue
    install -m 644 "$f" "$D/data/www/prism-router-panel/$(basename "$f")"
  done
fi
# openssl-util 是飞书 HMAC-SHA256 与子母节点签名的真实运行时依赖，必须声明；
# uhttpd 是独立面板服务（prism-router-panel.init）的运行时依赖。
ctl "$D" prism-router net "ucode, ucode-mod-fs, ucode-mod-uci, ucode-mod-uloop, curl, openssl-util, uhttpd" \
  "Traffic statistics daemon: per-device/per-app usage with proxy-vs-direct split (OpenClash API + conntrack)."
printf '/etc/config/prism-router\n' > "$D/control/conffiles"; chmod 644 "$D/control/conffiles"
# 独立面板默认关闭：postinst 只跟随 panel.enabled 决定是否开机自启，绝不强制启动。
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' \
  'if [ -f /etc/config/traffic-stats ]; then cp -p /etc/config/traffic-stats /etc/config/prism-router 2>/dev/null; if ! uci -q get prism-router.panel.enabled >/dev/null 2>&1; then uci -q set prism-router.panel=panel; uci -q set prism-router.panel.enabled='"'"'0'"'"'; uci -q set prism-router.panel.port='"'"'8099'"'"'; uci -q set prism-router.panel.bind='"'"''"'"'; uci -q set prism-router.panel.token='"'"''"'"'; uci -q commit prism-router; fi; fi' \
  'if [ -d /etc/traffic-stats ]; then mkdir -p /etc/prism-router; cp -a /etc/traffic-stats/. /etc/prism-router/ 2>/dev/null || cp -r /etc/traffic-stats/. /etc/prism-router/ 2>/dev/null; fi' \
  'if [ -x /etc/init.d/traffic-statsd ]; then /etc/init.d/traffic-statsd stop >/dev/null 2>&1; /etc/init.d/traffic-statsd disable >/dev/null 2>&1; fi' \
  '/etc/init.d/prism-routerd enable >/dev/null 2>&1' \
  '/etc/init.d/prism-routerd restart >/dev/null 2>&1' \
  'if [ "$(uci -q get prism-router.panel.enabled)" = "1" ]; then /etc/init.d/prism-router-panel enable >/dev/null 2>&1; else /etc/init.d/prism-router-panel disable >/dev/null 2>&1; fi' \
  'exit 0'
install -m 755 "$W/_h" "$D/control/postinst"
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' \
  '/etc/init.d/prism-router-panel stop >/dev/null 2>&1' \
  '/etc/init.d/prism-router-panel disable >/dev/null 2>&1' \
  '/etc/init.d/prism-routerd stop >/dev/null 2>&1' \
  '/etc/init.d/prism-routerd disable >/dev/null 2>&1' \
  'exit 0'
install -m 755 "$W/_h" "$D/control/prerm"
pack "$D" "prism-router_${VER}-${REL}_all"

# ================= luci-app-prism-router =================
D="$W/luci"; mkdir -p "$D/data/www/luci-static/resources/view/prism-router" \
  "$D/data/www/luci-static/resources/prism-router" \
  "$D/data/usr/share/luci/menu.d" "$D/data/usr/share/rpcd/acl.d" "$D/data/usr/share/rpcd/ucode" "$D/control"
chmod 755 "$D" "$D/control" "$D/data" "$D/data/www" \
  "$D/data/www/luci-static" "$D/data/www/luci-static/resources" \
  "$D/data/www/luci-static/resources/view" "$D/data/www/luci-static/resources/view/prism-router" \
  "$D/data/www/luci-static/resources/prism-router" \
  "$D/data/usr" "$D/data/usr/share" "$D/data/usr/share/luci" "$D/data/usr/share/luci/menu.d" \
  "$D/data/usr/share/rpcd" "$D/data/usr/share/rpcd/acl.d" "$D/data/usr/share/rpcd/ucode"
for f in "$ROOT"/luci-app-prism-router/htdocs/luci-static/resources/view/prism-router/*.js; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "$D/data/www/luci-static/resources/view/prism-router/$(basename "$f")"
done
# PWA 资源（manifest + 主屏图标 + 应用类别表）
for f in "$ROOT"/luci-app-prism-router/htdocs/luci-static/resources/prism-router/*; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "$D/data/www/luci-static/resources/prism-router/$(basename "$f")"
done
# root/ 整树安装，与 luci.mk 的行为一致：未来新增的 menu/acl/rpcd ucode 插件
# （例如安全 agent 的 prism-router-node-auth.uc）放进来就自动进包，不会漏。
# 源文件常被 0600/0700 的 umask 创建，这里按“可执行→755、其余→644”归一。
while IFS= read -r f; do
  rel="${f#"$ROOT/luci-app-prism-router/root/"}"
  if [ -x "$f" ]; then m=755; else m=644; fi
  install -D -m "$m" "$f" "$D/data/$rel"
done < <(find "$ROOT/luci-app-prism-router/root" -type f | LC_ALL=C sort)
# 内置 SVG 不需要 luci-lib-chartjs；curl / openssl-util 是飞书 RPC 的真实依赖。
ctl "$D" luci-app-prism-router luci "luci-base, rpcd-mod-ucode, ucode, ucode-mod-fs, ucode-mod-uci, curl, openssl-util, prism-router" \
  "LuCI pages for traffic statistics (overview / devices / apps / settings). Conffile: /etc/config/prism-router (owned by prism-router)."
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' 'rm -f /tmp/luci-indexcache* 2>/dev/null' '/etc/init.d/rpcd reload >/dev/null 2>&1' 'exit 0'
install -m 755 "$W/_h" "$D/control/postinst"
pack "$D" "luci-app-prism-router_${VER}-${REL}_all"

# ================= 发布校验和 =================
# 只覆盖本次实际生成的 *.ipk（默认 2 个 modern；--legacy 时含 4 个）。
(
  cd "$OUT"
  find . -maxdepth 1 -type f -name '*.ipk' -printf '%f\n' | LC_ALL=C sort | while IFS= read -r f; do
    sha256sum "$f"
  done > SHA256SUMS
)
chmod 644 "$OUT/SHA256SUMS"
echo "  ✓ dist/SHA256SUMS ($(wc -l < "$OUT/SHA256SUMS") 个文件)"
if [ "$LEGACY" = 1 ]; then
  echo "WARNING: 本次额外生成了 *.legacy.ipk（ar 容器，极旧版本未验证）。" >&2
  echo "WARNING: legacy 包仅用于排查/负例测试，禁止发布或安装到 23.05/24.10。" >&2
fi
