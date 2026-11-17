#!/bin/bash
# 发布门禁（release gate）：
#   1. 只接受 2 个 modern 包（23.05 / 24.10 通用的 tar.gz ipk）+ SHA256SUMS；
#      dist 里出现 *.legacy.ipk 直接失败（旧包不允许发布）。
#   2. 校验 SHA256SUMS；并做“篡改 / 缺文件”负例，证明哈希不符或缺失会被拒绝。
#   3. control 元数据：Package/Version/Architecture/Priority/Section/Depends；
#      Depends 与两个 Makefile 逐项一致；Priority 必须是合法值。
#   4. control 归档权限（目录 755、control/conffiles 644、postinst/prerm 755）；
#      data 归档权限（目录 755、普通文件 644、可执行文件 755、owner 0/0）。
#   5. payload 与源码：门禁进入 23.05 / 24.10 容器，逐文件比对安装内容与仓库源码；
#      检查 conffile、同版本重装（升级覆盖）与卸载完整清单。
#   6. 23.05 / 24.10 的 legacy（ar 容器）负例：必须安装失败；legacy 仅作负例，不发布。
#
# 默认复用 dist/（SKIP_BUILD=1）；--build 先重建一次。隔离：--network none，不碰真机。
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_BUILD="${SKIP_BUILD:-1}"
for arg in "$@"; do
  case "$arg" in
    --build) SKIP_BUILD=0 ;;
    --no-build) SKIP_BUILD=1 ;;
    -h|--help) echo "用法: $0 [--build|--no-build]"; echo "默认复用 dist/；--build 先重建一次。"; exit 0 ;;
    *) echo "$0: 未知参数 $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "RELEASE FAIL: $*" >&2; exit 1; }
pass() { echo "  PASS  $*"; }

if [ "$SKIP_BUILD" = 0 ]; then
  echo ">>> 构建包（--build）"
  "$ROOT/tools/build-ipk.sh"
else
  echo ">>> 复用现有 dist（SKIP_BUILD=1；需要重建请加 --build）"
fi
DIST="$ROOT/dist"
[ -d "$DIST" ] || fail "缺少 dist/，先运行 tools/build-ipk.sh"

WORK=$(mktemp -d); LEGACY_DIR=$(mktemp -d); SNAP=$(mktemp -d)
trap 'rm -rf "$WORK" "$LEGACY_DIR" "$SNAP"' EXIT
# 校验前先快照 dist：防止其他 agent 在本门禁运行期间重建 dist，造成“验 A 装 B”。
cp -a "$DIST/." "$SNAP/"
DIST="$SNAP"

echo ">>> 1/6 发布集与 SHA256SUMS"
mapfile -t MODERN < <(find "$DIST" -maxdepth 1 -type f -name '*.ipk' ! -name '*.legacy.ipk' -printf '%f\n' | LC_ALL=C sort)
[ "${#MODERN[@]}" -eq 2 ] || fail "dist 里应有 2 个 modern ipk，实际 ${#MODERN[@]} 个：${MODERN[*]:-无}"
[ "${MODERN[0]}" = "luci-app-prism-router_1.0.0-1_all.ipk" ] || fail "modern 包名不符：${MODERN[0]}"
[ "${MODERN[1]}" = "prism-router_1.0.0-1_all.ipk" ] || fail "modern 包名不符：${MODERN[1]}"
if find "$DIST" -maxdepth 1 -type f -name '*.legacy.ipk' -print -quit | grep -q .; then
  fail "dist 含 *.legacy.ipk：旧包不进入发布集，请重新 build（默认不生成 legacy）"
fi
[ -f "$DIST/SHA256SUMS" ] || fail "缺少 dist/SHA256SUMS"
[ "$(wc -l < "$DIST/SHA256SUMS")" -eq 2 ] || fail "SHA256SUMS 应恰好覆盖 2 个 modern 包"
expected_names=$(printf '%s\n' "${MODERN[@]}" | LC_ALL=C sort)
actual_names=$(awk '{print $2}' "$DIST/SHA256SUMS" | LC_ALL=C sort)
[ "$expected_names" = "$actual_names" ] || fail "SHA256SUMS 的文件清单与 dist 不一致"
( cd "$DIST" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || fail "SHA256SUMS 校验失败"
pass "2 个 modern 包 + SHA256SUMS 一致"

echo ">>> 2/6 哈希负例（篡改 / 缺文件必须被拒绝）"
mkdir -p "$WORK/tamper" "$WORK/missing"
cp -a "$DIST/." "$WORK/tamper/"
printf '\000' >> "$WORK/tamper/prism-router_1.0.0-1_all.ipk"
if ( cd "$WORK/tamper" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ); then
  fail "篡改后的 ipk 仍通过 SHA256SUMS（拒绝逻辑失效）"
fi
pass "篡改 ipk → 哈希校验拒绝"
cp -a "$DIST/." "$WORK/missing/"
rm -f "$WORK/missing/luci-app-prism-router_1.0.0-1_all.ipk"
if ( cd "$WORK/missing" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ); then
  fail "缺少 ipk 仍通过 SHA256SUMS（拒绝逻辑失效）"
fi
pass "缺失 ipk → 哈希校验拒绝"

# ---------- 元数据 / 权限检查 ----------
unpack_ipk() { # $1=ipk $2=目标目录
  local ipk="$1" d="$2"
  mkdir -p "$d/ctl" "$d/root"
  tar -xzf "$ipk" -C "$d" || fail "无法解开 $ipk"
  [ "$(cat "$d/debian-binary")" = "2.0" ] || fail "$ipk debian-binary 不是 2.0"
  tar -xzf "$d/control.tar.gz" -C "$d/ctl" || fail "$ipk control.tar.gz 损坏"
  tar -xzf "$d/data.tar.gz" -C "$d/root" || fail "$ipk data.tar.gz 损坏"
}

norm_deps() { tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d' | LC_ALL=C sort; }
make_deps() { # $1=Makefile $2=变量名
  awk -v key="$2" '
    $0 ~ "^[[:space:]]*" key ":[[:space:]]*=" {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      while (line ~ /\\[[:space:]]*$/) {
        sub(/\\[[:space:]]*$/, "", line)
        if ((getline nxt) <= 0) break
        line = line " " nxt
      }
      gsub(/\\/, " ", line)
      gsub(/\+/, " ", line)
      gsub(/,/, " ", line)
      print line
      exit
    }' "$1" | tr -s '[:blank:]' '\n' | sed '/^$/d' | LC_ALL=C sort
}

is_exec_name() {
  case "$1" in
    ./usr/bin/prism-routerd|./etc/init.d/prism-routerd|\
    ./usr/share/prism-router/feishu-test.sh|\
    ./www/cgi-bin/prism-router-ingest|./www/cgi-bin/prism-router-stations|\
    ./www/cgi-bin/prism-router-metrics|\
    ./etc/init.d/prism-router-panel|./www/prism-router-panel/cgi-bin/panel-api) return 0 ;;
  esac
  return 1
}

check_pkg() { # $1=ipk $2=pkg $3=section $4=makefile $5=depvar
  local ipk="$1" pkg="$2" section="$3" mk="$4" depvar="$5"
  local d="$WORK/unpack-$pkg" ctl data listing data_list control_list
  unpack_ipk "$ipk" "$d"
  ctl="$d/ctl"; data="$d/root"
  # 一次性展开清单：不要用 `tar | grep -q`，grep 提前退出会让 tar 收到 SIGPIPE，
  # 在 pipefail 下被误判为失败。
  listing="$WORK/outer-$pkg.txt"; tar -tzf "$ipk" > "$listing"
  data_list="$WORK/data-$pkg.txt"; tar -tzf "$d/data.tar.gz" > "$data_list"
  control_list="$WORK/control-$pkg.txt"; tar -tzf "$d/control.tar.gz" > "$control_list"

  # 外层：恰好 3 个普通文件、644、0/0
  local bad
  bad=$(tar -tvzf "$ipk" | awk '$1 != "-rw-r--r--" || $2 != "0/0" {print $1, $2, $NF}')
  [ -z "$bad" ] || fail "$pkg 外层条目权限/属主异常：$bad"
  [ "$(wc -l < "$listing")" -eq 3 ] || fail "$pkg 外层应恰好 3 个条目"
  for e in ./debian-binary ./data.tar.gz ./control.tar.gz; do
    grep -qxF "$e" "$listing" || fail "$pkg 外层缺少 $e"
  done
  pass "$pkg 外层 tar.gz 结构/权限"

  # control 归档：目录 755；control/conffiles 644；postinst/prerm 755
  bad=$(tar -tvzf "$d/control.tar.gz" | awk '
    {
      mode=$1; owner=$2; name=$NF;
      if (owner != "0/0") { print "owner " name; next }
      if (name ~ /\/$/) { if (mode != "drwxr-xr-x") print "dir " name " " mode; next }
      if (name == "./postinst" || name == "./prerm") {
        if (mode != "-rwxr-xr-x") print "script " name " " mode
      } else if (mode != "-rw-r--r--") print "file " name " " mode
    }')
  [ -z "$bad" ] || fail "$pkg control 归档权限异常：$bad"
  for e in ./control; do grep -qxF "$e" "$control_list" || fail "$pkg control 缺 $e"; done
  control_mode() { tar -tvzf "$d/control.tar.gz" | awk -v n="$1" '$NF == n { print $1; exit }'; }
  [ "$(control_mode ./control)" = "-rw-r--r--" ] || fail "$pkg control 不是 644"
  if grep -qxF ./conffiles "$control_list"; then
    [ "$(control_mode ./conffiles)" = "-rw-r--r--" ] || fail "$pkg conffiles 不是 644"
  fi
  if grep -qxF ./postinst "$control_list"; then
    [ "$(control_mode ./postinst)" = "-rwxr-xr-x" ] || fail "$pkg postinst 不是 755"
  fi
  if grep -qxF ./prerm "$control_list"; then
    [ "$(control_mode ./prerm)" = "-rwxr-xr-x" ] || fail "$pkg prerm 不是 755"
  fi
  pass "$pkg control 目录/脚本权限"

  # data 归档：目录 755；普通文件 644；仅白名单可执行；owner 0/0
  bad=$(tar -tvzf "$d/data.tar.gz" | awk '
    function isexec(p) {
      return p == "./usr/bin/prism-routerd" ||
             p == "./etc/init.d/prism-routerd" ||
             p == "./usr/share/prism-router/feishu-test.sh" ||
             p == "./www/cgi-bin/prism-router-ingest" ||
             p == "./www/cgi-bin/prism-router-stations" ||
             p == "./www/cgi-bin/prism-router-metrics" ||
             p == "./etc/init.d/prism-router-panel" ||
             p == "./www/prism-router-panel/cgi-bin/panel-api"
    }
    {
      mode=$1; owner=$2; name=$NF;
      if (owner != "0/0") { print "owner " name; next }
      if (name ~ /\/$/) {
        if (mode != "drwxr-xr-x") print "dir " name " " mode
        next
      }
      if (isexec(name)) {
        if (mode != "-rwxr-xr-x") print "exec " name " " mode
      } else if (mode != "-rw-r--r--") print "file " name " " mode
    }')
  [ -z "$bad" ] || fail "$pkg data 归档权限异常：$bad"
  pass "$pkg data 目录/文件权限"

  # control 字段
  [ -f "$ctl/control" ] || fail "$pkg 缺 control"
  grep -qx "Package: $pkg" "$ctl/control" || fail "$pkg Package 字段不符"
  grep -qx "Version: 1.0.0-1" "$ctl/control" || fail "$pkg Version 字段不符"
  grep -qx "Architecture: all" "$ctl/control" || fail "$pkg Architecture 字段不符"
  grep -qx "Section: $section" "$ctl/control" || fail "$pkg Section 字段不符"
  local priority
  priority=$(sed -n 's/^Priority: //p' "$ctl/control" | head -1)
  case "$priority" in
    standard|required|important|extra) ;;
    *) fail "$pkg Priority 非法：[$priority]" ;;
  esac
  pass "$pkg Priority=$priority"

  local ctl_deps mk_deps
  ctl_deps=$(sed -n 's/^Depends: //p' "$ctl/control" | head -1 | norm_deps)
  mk_deps=$(make_deps "$mk" "$depvar")
  [ -n "$mk_deps" ] || fail "$pkg 无法从 $mk 解析 $depvar"
  [ "$ctl_deps" = "$mk_deps" ] || {
    echo "control Depends:" >&2; printf '%s\n' "$ctl_deps" >&2
    echo "Makefile $depvar:" >&2; printf '%s\n' "$mk_deps" >&2
    fail "$pkg control Depends 与 Makefile 不一致"
  }
  pass "$pkg Depends 与 Makefile $depvar 一致"
  case "$pkg" in
    prism-router)
      printf '%s\n' "$ctl_deps" | grep -qx 'openssl-util' || fail "prism-router 缺 openssl-util（飞书/子母签名真实依赖）"
      printf '%s\n' "$ctl_deps" | grep -qx 'curl' || fail "prism-router 缺 curl"
      ;;
    luci-app-prism-router)
      for dep in curl openssl-util prism-router; do
        printf '%s\n' "$ctl_deps" | grep -qx "$dep" || fail "luci-app-prism-router 缺 $dep"
      done
      ;;
  esac
  pass "$pkg 关键运行时依赖齐全"

  # conffile
  if [ "$pkg" = "prism-router" ]; then
    [ "$(cat "$ctl/conffiles" 2>/dev/null)" = "/etc/config/prism-router" ] || fail "prism-router conffiles 不符"
    pass "prism-router conffile=/etc/config/prism-router"
  else
    [ ! -e "$ctl/conffiles" ] || fail "luci-app-prism-router 不应声明 conffile"
  fi

  # payload 与源码一一对应（存在才打包）
  local entry
  if [ "$pkg" = "prism-router" ]; then
    for entry in \
      "./usr/bin/prism-routerd:prism-router/files/prism-routerd.uc" \
      "./etc/init.d/prism-routerd:prism-router/files/prism-routerd.init" \
      "./etc/config/prism-router:prism-router/files/prism-router.config" \
      "./usr/share/prism-router/feishu.uc:prism-router/files/feishu.uc" \
      "./usr/share/prism-router/feishu-test.sh:prism-router/files/feishu-test.sh" \
      "./usr/share/prism-router/retention.uc:prism-router/files/retention.uc" \
      "./usr/share/prism-router/push.uc:prism-router/files/push.uc" \
      "./usr/share/prism-router/stations.uc:prism-router/files/stations.uc" \
      "./www/cgi-bin/prism-router-ingest:prism-router/files/ingest.uc" \
      "./www/cgi-bin/prism-router-stations:prism-router/files/ingest-stations.uc" \
      "./www/cgi-bin/prism-router-metrics:prism-router/files/prism-router-metrics.uc" \
      "./etc/init.d/prism-router-panel:prism-router/files/prism-router-panel.init" \
      "./www/prism-router-panel/cgi-bin/panel-api:prism-router/files/panel-api.uc"; do
      local t="${entry%%:*}" s="${entry#*:}"
      [ -f "$ROOT/$s" ] || continue
      grep -qxF "$t" "$data_list" || fail "$pkg payload 缺少 $t（源 $s）"
      cmp -s "$data/${t#./}" "$ROOT/$s" || fail "$pkg payload $t 与源码 $s 不一致"
    done
    # 独立面板静态页面（前端任务提供；存在才要求进包，逐字节一致、权限 644）
    local f b rel
    for f in "$ROOT"/prism-router/files/panel/*; do
      [ -f "$f" ] || continue
      b=$(basename "$f"); rel="www/prism-router-panel/$b"
      grep -qxF "./$rel" "$data_list" || fail "prism-router payload 缺面板静态文件 $rel"
      cmp -s "$data/$rel" "$f" || fail "panel 静态文件 $rel 与源码不一致"
    done
    if [ -f "$ROOT/prism-router/files/prism-router-node-auth.uc" ]; then
      grep -qxF "./usr/share/prism-router/prism-router-node-auth.uc" "$data_list" \
        || fail "prism-router payload 缺 prism-router-node-auth.uc（安全模块共享库）"
      cmp -s "$data/usr/share/prism-router/prism-router-node-auth.uc" \
        "$ROOT/prism-router/files/prism-router-node-auth.uc" \
        || fail "prism-router-node-auth.uc 与源码不一致"
    fi
  else
    for entry in \
      "./usr/share/rpcd/ucode/prism-router.uc:luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router.uc" \
      "./usr/share/rpcd/acl.d/luci-app-prism-router.json:luci-app-prism-router/root/usr/share/rpcd/acl.d/luci-app-prism-router.json" \
      "./usr/share/luci/menu.d/luci-app-prism-router.json:luci-app-prism-router/root/usr/share/luci/menu.d/luci-app-prism-router.json"; do
      local t="${entry%%:*}" s="${entry#*:}"
      [ -f "$ROOT/$s" ] || continue
      grep -qxF "$t" "$data_list" || fail "$pkg payload 缺少 $t（源 $s）"
      cmp -s "$data/${t#./}" "$ROOT/$s" || fail "$pkg payload $t 与源码 $s 不一致"
    done
    local f b rel
    for f in "$ROOT"/luci-app-prism-router/htdocs/luci-static/resources/view/prism-router/*.js; do
      b=$(basename "$f"); rel="www/luci-static/resources/view/prism-router/$b"
      grep -qxF "./$rel" "$data_list" || fail "payload 缺 JS $rel"
      cmp -s "$data/$rel" "$f" || fail "payload JS $rel 与源码不一致"
    done
    for f in "$ROOT"/luci-app-prism-router/htdocs/luci-static/resources/prism-router/*; do
      [ -f "$f" ] || continue
      b=$(basename "$f"); rel="www/luci-static/resources/prism-router/$b"
      grep -qxF "./$rel" "$data_list" || fail "payload 缺 PWA 资源 $rel"
      cmp -s "$data/$rel" "$f" || fail "payload PWA $rel 与源码不一致"
    done
    # rpcd/ucode 下的所有 .uc（含安全 agent 后续新增的 node-auth）都必须进包
    for f in "$ROOT"/luci-app-prism-router/root/usr/share/rpcd/ucode/*.uc; do
      [ -f "$f" ] || continue
      b=$(basename "$f"); rel="usr/share/rpcd/ucode/$b"
      grep -qxF "./$rel" "$data_list" || fail "payload 缺 rpcd ucode $rel"
      cmp -s "$data/$rel" "$f" || fail "payload rpcd ucode $rel 与源码不一致"
    done
    # root/ 整树（menu/acl/rpcd ucode 以及未来新增文件）都必须进包
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      rel="${f#"$ROOT/luci-app-prism-router/root/"}"
      grep -qxF "./$rel" "$data_list" || fail "payload 缺 root/ 文件 $rel"
      cmp -s "$data/$rel" "$f" || fail "payload root/ 文件 $rel 与源码不一致"
    done < <(find "$ROOT/luci-app-prism-router/root" -type f | LC_ALL=C sort)
  fi
  pass "$pkg payload 与源码一致（含条件文件）"
}

echo ">>> 3/6 control 元数据 / 权限 / payload↔源码"
check_pkg "$DIST/prism-router_1.0.0-1_all.ipk" prism-router net \
  "$ROOT/prism-router/Makefile" DEPENDS
check_pkg "$DIST/luci-app-prism-router_1.0.0-1_all.ipk" luci-app-prism-router luci \
  "$ROOT/luci-app-prism-router/Makefile" LUCI_DEPENDS

echo ">>> 4/6 生成 legacy 负例（只用于验证旧格式被拒绝，不发布）"
"$ROOT/tools/build-ipk.sh" --legacy --out "$LEGACY_DIR" >"$WORK/legacy.out" 2>"$WORK/legacy.err" \
  || fail "--legacy 构建失败"
grep -q '^WARNING:' "$WORK/legacy.err" || fail "--legacy 未打印不可发布警告"
[ "$(find "$LEGACY_DIR" -maxdepth 1 -type f -name '*.legacy.ipk' | wc -l)" -eq 2 ] \
  || fail "--legacy 未产出 2 个 legacy 包"
[ "$(wc -l < "$LEGACY_DIR/SHA256SUMS")" -eq 4 ] || fail "--legacy 的 SHA256SUMS 应覆盖 4 个包"
pass "legacy 包按需生成且输出警告（仅负例）"

echo ">>> 5/6 容器内 release 校验（23.05 / 24.10，--network none）"
RC=0
run_release() { # $1=image $2=label
  echo "--- release gate: $2 ($1)"
  if ! docker run --rm --network none \
    -e "RELEASE_TARGET=$2" \
    -v "$ROOT:/src/repo:ro" \
    -v "$SNAP:/src/dist:ro" \
    -v "$ROOT/tests:/src/tests:ro" \
    -v "$LEGACY_DIR:/src/legacy:ro" \
    "$1" /bin/sh /src/tests/container-release-inner.sh; then
    echo "RELEASE FAIL: $2 容器校验失败" >&2
    RC=1
  fi
}
run_release openwrt-24.10:deps 24.10
run_release openwrt-23.05:deps 23.05
[ "$RC" -eq 0 ] || fail "容器内 release 校验未全部通过"

echo ">>> 6/6 release gate 全部通过"
