#!/bin/bash
# 不依赖 OpenWrt SDK 手搓 .ipk（纯脚本包，无编译产物）
#
# 产物（单个插件包 + SHA256SUMS）：
#   dist/luci-app-prism-router_<VER>-<REL>_<ARCH>.ipk
#   dist/SHA256SUMS
#
# 架构：1.0.23 起随包分发官方 lark-oapi 的 musl x86_64 原生扩展
# （pycryptodome / websockets / charset_normalizer 的 .so 都是
#  cp39-abi3-musllinux / cp311-musllinux），因此 Architecture 固定为 x86_64，
# 不再是 all。可用 PRISM_ARCH 覆盖（仅用于负例/实验）。
#
# 24.10 / 23.05 的 .ipk 外层都是 tar.gz（见 docs/IPK-FORMAT.md）。
# 极旧版本（21.02 及更早）才需要 ar 容器；默认不再生成，只有显式
# `--legacy` 才会额外产出 *.legacy.ipk，并打印“不可发布”警告。
#
# 用法：
#   tools/build-ipk.sh                 # 重建 dist/，1 个插件包 + SHA256SUMS
#   tools/build-ipk.sh --legacy        # 额外产 ar 包（仅排查极旧版本，不要发布）
#   tools/build-ipk.sh --out DIR       # 输出到指定目录（供测试用临时目录）
#   tools/build-ipk.sh --help
set -euo pipefail
# 事故复核（docs/INCIDENT-2026-11-14.md）：任何 mktemp/install 默认都必须是
# 755/644，不能把调用者的 0077 之类的 umask 带进归档。
umask 022
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"; LEGACY=0
# 版本可用环境变量覆盖（CI 按 Release tag 注入）；源码默认 1.0.22，
# 与 Makefile / Android 默认版本保持一致。包名、opkg Version 与包内版本常量
# 全部由同一个 VER 派生，避免出现“新 UI 却打包成旧版本”的漂移。
VER="${PRISM_VER:-1.0.27}"; REL="${PRISM_REL:-1}"
# 随包 SDK 的 .so 是 musl x86_64；Architecture 必须与之一致，不能是 all。
ARCH="${PRISM_ARCH:-x86_64}"

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

# 版本会写进包名 / control / ucode 常量，只允许安全字符，禁止空格与 sed 元字符。
case "$VER" in
  ''|*[!0-9A-Za-z.+_-]*) echo "build-ipk: 非法版本号 [$VER]" >&2; exit 2 ;;
esac
case "$REL" in
  ''|*[!0-9]*) echo "build-ipk: 非法 release [$REL]" >&2; exit 2 ;;
esac
case "$ARCH" in
  all) echo "build-ipk: 拒绝 Architecture=all：随包的 pycryptodome/websockets .so 是 musl x86_64" >&2; exit 2 ;;
  ''|*[!a-z0-9_]*) echo "build-ipk: 非法架构 [$ARCH]" >&2; exit 2 ;;
esac

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
    "$d/data/usr/share/prism-router/feishu-ws.py" \
    "$d/data/etc/init.d/prism-router-feishu-ws" \
    "$d/data/www/cgi-bin/prism-router-ingest" \
    "$d/data/www/cgi-bin/prism-router-stations" \
    "$d/data/www/cgi-bin/prism-router-metrics" \
    "$d/data/www/cgi-bin/prism-router-control" \
    "$d/data/www/cgi-bin/prism-router-feishu" \
    "$d/data/www/cgi-bin/prism-router-system" \
    "$d/data/www/cgi-bin/prism-router-admin" \
    "$d/data/etc/init.d/prism-router-panel" \
    "$d/data/www/prism-router-panel/cgi-bin/panel-api" \
    "$d/data/www/prism-router-panel/cgi-bin/prism-router-system" \
    "$d/data/www/prism-router-panel/cgi-bin/prism-router-admin" \
    "$d/data/www/prism-router-panel/cgi-bin/prism-router-control" 2>/dev/null || true
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

ctl() { # $1=dir  $2=pkgname  $3=section  $4=depends  $5=desc  $6=arch
  # Priority 必须是 Debian/OpenWrt 的合法值；不能把占位符/密码类字符串写进 control。
  # Depends 必须与两个 Makefile 保持一致（release gate 会逐项比对）。
  # Architecture 必须与包名、以及随包 .so 的 musl 架构一致。
  printf 'Package: %s\nVersion: %s-%s\nArchitecture: %s\nMaintainer: prism-router\nSection: %s\nPriority: standard\nDepends: %s\nDescription: %s\n' \
    "$2" "$VER" "$REL" "$6" "$3" "$4" "$5" > "$1/control/control"
  chmod 644 "$1/control/control"
}
hook() { printf '%s\n' "$@" > "$W/_h"; chmod 644 "$W/_h"; }

# 打包时把源码中的版本常量替换成实际发布版本（源码默认值保持不变）。
# 四个入口全部使用同一个 VER：daemon --version、rpcd status.version、
# metrics traffic_info、feishu 的版本常量不会各自漂移。
versioned() { # $1=源文件 $2=目标文件 $3=常量名
  local src="$1" dst="$2" name="$3"
  sed -E "s/^(const[[:space:]]+$name[[:space:]]*=[[:space:]]*)'[^']*';/\1'$VER';/" "$src" > "$dst"
  grep -Fq "const $name" "$dst" && grep -Fq "'$VER';" "$dst" \
    || { echo "build-ipk: $src 中找不到 const $name 版本常量" >&2; exit 1; }
}

# ================= luci-app-prism-router（单包插件）=================
# 一个 ipk 同时包含：守护进程、init、配置、rpcd 插件、ACL、菜单、LuCI 页面、
# CGI 与独立面板（默认关闭）。不再拆成 daemon 包 + LuCI 包。
D="$W/app"
mkdir -p "$D/data/usr/bin" "$D/data/usr/share/prism-router" \
  "$D/data/usr/share/rpcd/ucode" "$D/data/usr/share/rpcd/acl.d" \
  "$D/data/usr/share/luci/menu.d" \
  "$D/data/etc/init.d" "$D/data/etc/config" "$D/data/etc/prism-router/daily" \
  "$D/data/www/cgi-bin" "$D/data/www/prism-router-panel/cgi-bin" \
  "$D/data/www/luci-static/resources/view/prism-router" \
  "$D/data/www/luci-static/resources/prism-router" \
  "$D/data/usr/lib/prism-router" "$D/control"
chmod 755 "$D" "$D/control" "$D/data" \
  "$D/data/usr" "$D/data/usr/bin" "$D/data/usr/share" "$D/data/usr/share/prism-router" \
  "$D/data/usr/share/rpcd" "$D/data/usr/share/rpcd/ucode" "$D/data/usr/share/rpcd/acl.d" \
  "$D/data/usr/share/luci" "$D/data/usr/share/luci/menu.d" \
  "$D/data/etc" "$D/data/etc/init.d" "$D/data/etc/config" \
  "$D/data/etc/prism-router" "$D/data/etc/prism-router/daily" \
  "$D/data/www" "$D/data/www/cgi-bin" \
  "$D/data/www/prism-router-panel" "$D/data/www/prism-router-panel/cgi-bin" \
  "$D/data/www/luci-static" "$D/data/www/luci-static/resources" \
  "$D/data/www/luci-static/resources/view" "$D/data/www/luci-static/resources/view/prism-router" \
  "$D/data/www/luci-static/resources/prism-router" \
  "$D/data/usr/lib/prism-router"

# 守护进程 / init / 配置
versioned "$ROOT/luci-app-prism-router/root/usr/bin/prism-routerd" "$W/prism-routerd" DAEMON_VERSION
install -m 755 "$W/prism-routerd"                                               "$D/data/usr/bin/prism-routerd"
install -m 755 "$ROOT/luci-app-prism-router/root/etc/init.d/prism-routerd"     "$D/data/etc/init.d/prism-routerd"
install -m 755 "$ROOT/luci-app-prism-router/root/etc/init.d/prism-router-panel" "$D/data/etc/init.d/prism-router-panel"
install -m 644 "$ROOT/luci-app-prism-router/root/etc/config/prism-router"      "$D/data/etc/config/prism-router"

# 运行时脚本（cron / push / retention / 飞书）
for f in "$ROOT"/luci-app-prism-router/root/usr/share/prism-router/*.uc; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "$D/data/usr/share/prism-router/$(basename "$f")"
done
[ -f "$ROOT/luci-app-prism-router/root/usr/share/prism-router/feishu-test.sh" ] && \
  install -m 755 "$ROOT/luci-app-prism-router/root/usr/share/prism-router/feishu-test.sh" \
    "$D/data/usr/share/prism-router/feishu-test.sh"

# 官方 lark-oapi 长连接服务 + 随包 SDK（musl x86_64）
# 先校验 vendor 树没漂移（MANIFEST.json 的 totals.sha256 / 体积 / 静态 import 图），
# 再整树拷进 data/usr/lib/prism-router/pylib。SDK 不写系统 site-packages。
PYLIB_SRC="$ROOT/luci-app-prism-router/pylib"
[ -d "$PYLIB_SRC" ] || { echo "build-ipk: 缺少 $PYLIB_SRC（先跑 tools/vendor-pylib.sh）" >&2; exit 1; }
if command -v python3 >/dev/null 2>&1; then
  python3 "$ROOT/tools/pylib_tool.py" verify --pylib "$PYLIB_SRC" --static-imports \
    >/tmp/prism-pylib-verify.json 2>/tmp/prism-pylib-verify.err \
    || { echo "build-ipk: pylib 校验失败（$PYLIB_SRC）" >&2
         grep -v '^ *$' /tmp/prism-pylib-verify.err | tail -20 >&2
         python3 - /tmp/prism-pylib-verify.json <<'PYV' >&2 || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(0)
for name, item in sorted(d.get("checks", {}).items()):
    if not item.get("ok"):
        print("  失败项 %s: %s" % (name, item.get("detail")))
PYV
         exit 1; }
  PYLIB_BYTES=$(du -sb "$PYLIB_SRC" | cut -f1)
  echo "  ✓ pylib 校验通过（$(du -sh "$PYLIB_SRC" | cut -f1)，$PYLIB_BYTES 字节）"
else
  echo "build-ipk: 警告：没有 python3，跳过 pylib 清单校验" >&2
fi
install -d -m 755 "$D/data/usr/lib/prism-router/pylib"
cp -a "$PYLIB_SRC/." "$D/data/usr/lib/prism-router/pylib/"
install -m 755 "$ROOT/luci-app-prism-router/root/usr/share/prism-router/feishu-ws.py" \
  "$D/data/usr/share/prism-router/feishu-ws.py"
install -m 755 "$ROOT/luci-app-prism-router/root/etc/init.d/prism-router-feishu-ws" \
  "$D/data/etc/init.d/prism-router-feishu-ws"

# rpcd 插件 / ACL / 菜单
versioned "$ROOT/luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router.uc" "$W/prism-router.uc" VERSION
install -m 644 "$W/prism-router.uc" \
  "$D/data/usr/share/rpcd/ucode/prism-router.uc"
install -m 644 "$ROOT/luci-app-prism-router/root/usr/share/rpcd/acl.d/luci-app-prism-router.json" \
  "$D/data/usr/share/rpcd/acl.d/luci-app-prism-router.json"
install -m 644 "$ROOT/luci-app-prism-router/root/usr/share/luci/menu.d/luci-app-prism-router.json" \
  "$D/data/usr/share/luci/menu.d/luci-app-prism-router.json"

# CGI（接收子节点 / AP 上报、Prometheus 指标、飞书扫码绑定、家长控制）
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-ingest"   "$D/data/www/cgi-bin/prism-router-ingest"
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-stations" "$D/data/www/cgi-bin/prism-router-stations"
versioned "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-metrics" "$W/prism-router-metrics" VERSION
install -m 755 "$W/prism-router-metrics"  "$D/data/www/cgi-bin/prism-router-metrics"
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-control"  "$D/data/www/cgi-bin/prism-router-control"
# 面板服务（8099）也需要家长控制：同一份 CGI 再装一份到面板 cgi-bin。
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-control"  "$D/data/www/prism-router-panel/cgi-bin/prism-router-control"
versioned "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-feishu" "$W/prism-router-feishu" VERSION
install -m 755 "$W/prism-router-feishu"   "$D/data/www/cgi-bin/prism-router-feishu"
# 系统信息（只读、无需登录）与管理员 API（登录 + token）——同样必须是 755。
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-system"   "$D/data/www/cgi-bin/prism-router-system"
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-admin"    "$D/data/www/cgi-bin/prism-router-admin"

# 独立面板（默认关闭；同一插件内的可选视图）
install -m 755 "$ROOT/luci-app-prism-router/root/www/prism-router-panel/cgi-bin/panel-api" \
  "$D/data/www/prism-router-panel/cgi-bin/panel-api"
# 面板服务（8099）也需要系统/管理员接口：同一份 CGI 再装一份到面板 cgi-bin，
# 这样 App 只填面板地址就能同时用 panel-api 与 system/admin（不必反向代理）。
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-system" \
  "$D/data/www/prism-router-panel/cgi-bin/prism-router-system"
install -m 755 "$ROOT/luci-app-prism-router/root/www/cgi-bin/prism-router-admin" \
  "$D/data/www/prism-router-panel/cgi-bin/prism-router-admin"
for f in "$ROOT"/luci-app-prism-router/root/www/prism-router-panel/*.html \
         "$ROOT"/luci-app-prism-router/root/www/prism-router-panel/*.css \
         "$ROOT"/luci-app-prism-router/root/www/prism-router-panel/*.js; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "$D/data/www/prism-router-panel/$(basename "$f")"
done

# LuCI 页面与 PWA 资源
for f in "$ROOT"/luci-app-prism-router/htdocs/luci-static/resources/view/prism-router/*.js; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "$D/data/www/luci-static/resources/view/prism-router/$(basename "$f")"
done
for f in "$ROOT"/luci-app-prism-router/htdocs/luci-static/resources/prism-router/*; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "$D/data/www/luci-static/resources/prism-router/$(basename "$f")"
done

ctl "$D" luci-app-prism-router luci \
  "luci-base, rpcd-mod-ucode, ucode, ucode-mod-fs, ucode-mod-uci, ucode-mod-uloop, curl, openssl-util, uhttpd, python3-light, python3-asyncio, python3-codecs, python3-ctypes, python3-decimal, python3-email, python3-logging, python3-openssl, python3-urllib, python3-uuid, python3-xml" \
  "PRISM Router single-package plugin: usage accounting daemon, LuCI pages, Feishu long-connection service (bundled lark-oapi), diagnostics and optional standalone panel." \
  "$ARCH"
printf '/etc/config/prism-router\n' > "$D/control/conffiles"; chmod 644 "$D/control/conffiles"
# postinst 的迁移判定要用到包内 conffile 的 sha256（构建时算好写进脚本）：
# 用来区分“本次安装刚从包里解出来的默认配置”和“用户已有的配置”。
CNF="$ROOT/luci-app-prism-router/root/etc/config/prism-router"
CNF_SHA=$(sha256sum "$CNF" | awk '{print $1}')
# postinst：只在“首次安装、且当前配置仍是包内默认值”时才从旧 traffic-stats 迁移。
# 真实 iStoreOS 回归：opkg 先解包 conffile 再执行 postinst，新装时
# /etc/config/prism-router 一定已存在，所以不能用 [ -e ] 判断；旧逻辑无条件
# cp 旧配置，升级时把 panel.token / panel.write_enabled 等用户配置整份冲掉。
cat > "$W/_h" <<'POSTINST'
#!/bin/sh
# 由 tools/build-ipk.sh 生成。只做旧配置/数据迁移与 init 启停，不改业务配置值。
[ -n "${IPKG_INSTROOT:-}" ] && exit 0

# 迁移判定（不能用 [ -e /etc/config/prism-router ]：opkg 在 postinst 之前已解包 conffile）：
#   本包已装过（opkg status 有条目） -> 当前配置属于用户，绝不迁移（升级/重装）；
#   当前配置已不是包内默认值         -> 用户配置或手工恢复，绝不迁移；
#   只有“首次安装 + 当前配置=包内默认值”才允许从 /etc/config/traffic-stats 迁移。
PKG_CONF_SHA='@PKG_CONF_SHA@'

conf_is_pkg_default() {
	[ -e /etc/config/prism-router ] || return 0
	[ "$(sha256sum /etc/config/prism-router 2>/dev/null | awk '{print $1}')" = "$PKG_CONF_SHA" ]
}

pkg_was_installed() {
	grep -q '^Package: luci-app-prism-router$' /usr/lib/opkg/status 2>/dev/null
}

if [ -f /etc/config/traffic-stats ] && ! pkg_was_installed && conf_is_pkg_default; then
	cp -p /etc/config/traffic-stats /etc/config/prism-router 2>/dev/null
	if ! uci -q get prism-router.panel.enabled >/dev/null 2>&1; then
		uci -q set prism-router.panel=panel
		uci -q set prism-router.panel.enabled='0'
		uci -q set prism-router.panel.port='8099'
		uci -q set prism-router.panel.bind=''
		uci -q set prism-router.panel.token=''
		uci -q commit prism-router
	fi
fi

# 升级/重装时补建新字段（只加缺省值，不改用户已有值）。
if ! uci -q get prism-router.feishu.ws_enabled >/dev/null 2>&1; then
	uci -q set prism-router.feishu.ws_enabled='0'
	uci -q commit prism-router
fi

# 旧数据只补缺：升级时绝不用历史 traffic-stats 覆盖较新的 daily/nodes/stations。
if [ -d /etc/traffic-stats ]; then
	mkdir -p /etc/prism-router
	cp -a -n /etc/traffic-stats/. /etc/prism-router/ 2>/dev/null || cp -rn /etc/traffic-stats/. /etc/prism-router/ 2>/dev/null
fi
if [ -x /etc/init.d/traffic-statsd ]; then
	/etc/init.d/traffic-statsd stop >/dev/null 2>&1
	/etc/init.d/traffic-statsd disable >/dev/null 2>&1
fi

/etc/init.d/prism-routerd enable >/dev/null 2>&1
/etc/init.d/prism-routerd restart >/dev/null 2>&1
if [ "$(uci -q get prism-router.panel.enabled)" = "1" ]; then
	/etc/init.d/prism-router-panel enable >/dev/null 2>&1
else
	/etc/init.d/prism-router-panel disable >/dev/null 2>&1
fi
# 飞书长连接默认关闭：只跟随 ws_enabled，绝不强制启动。
if [ "$(uci -q get prism-router.feishu.ws_enabled)" = "1" ]; then
	/etc/init.d/prism-router-feishu-ws enable >/dev/null 2>&1
	/etc/init.d/prism-router-feishu-ws restart >/dev/null 2>&1
else
	/etc/init.d/prism-router-feishu-ws stop >/dev/null 2>&1
	/etc/init.d/prism-router-feishu-ws disable >/dev/null 2>&1
fi
rm -f /tmp/luci-indexcache* 2>/dev/null
# 新装的 rpcd ucode 脚本不会随 reload 生效，必须 restart 才能注册 feishu_ws_status 等方法
/etc/init.d/rpcd restart >/dev/null 2>&1
exit 0
POSTINST
sed -i "s/@PKG_CONF_SHA@/$CNF_SHA/" "$W/_h"
install -m 755 "$W/_h" "$D/control/postinst"
hook '#!/bin/sh' '[ -n "${IPKG_INSTROOT:-}" ] && exit 0' \
  '/etc/init.d/prism-router-feishu-ws stop >/dev/null 2>&1' \
  '/etc/init.d/prism-router-feishu-ws disable >/dev/null 2>&1' \
  '/etc/init.d/prism-router-panel stop >/dev/null 2>&1' \
  '/etc/init.d/prism-router-panel disable >/dev/null 2>&1' \
  '/etc/init.d/prism-routerd stop >/dev/null 2>&1' \
  '/etc/init.d/prism-routerd disable >/dev/null 2>&1' \
  'exit 0'
install -m 755 "$W/_h" "$D/control/prerm"
pack "$D" "luci-app-prism-router_${VER}-${REL}_${ARCH}"

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
