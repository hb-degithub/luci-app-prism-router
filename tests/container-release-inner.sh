#!/bin/sh
# 发布门禁容器内用例（由 tests/container-validate-release.sh 在 23.05 / 24.10 中调用）。
# 不访问网络；安装、重装、卸载全部发生在一次性容器里。
#
# 检查项：
#   1. 严格依赖安装（无 --force-depends，不需要图表库占位包）
#   2. 包内每个文件落位、属主 root:root、权限 644/755；关键目录 755
#   3. payload 与 /src/repo 源码逐文件一致（含 PWA / CGI / 条件 node-auth.uc）
#   4. conffile 声明、修改 conffile 后同版本强制重装仍保留用户配置
#   5. 卸载完整清单：opkg files 列出的文件全部消失，仅 conffile 按规则保留
#   6. legacy（ar 容器）负例：必须被 opkg 以 Malformed package file 拒绝
mkdir -p /var/lock /var/run /tmp 2>/dev/null

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ # $1=路径 $2=期望 "root:root 权限"
  local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"
}
same_file(){ # $1=已安装 $2=仓库源码
  if [ ! -f "$1" ]; then bad "缺少已安装文件 $1"; return; fi
  if [ ! -f "$2" ]; then bad "缺少源码 $2"; return; fi
  cmp -s "$1" "$2" && ok "payload 一致 $1" || bad "payload 不一致 $1 != $2"
}

echo "=== release target: ${RELEASE_TARGET:-unknown} ==="
. /etc/openwrt_release 2>/dev/null || true
echo "  ${DISTRIB_ID:-OpenWrt} ${DISTRIB_RELEASE:-?} (${DISTRIB_ARCH:-?})"

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin 2>/dev/null)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=${B_CGI:-无}"

# 前端已统一使用内置 SVG，无需 luci-lib-chartjs；严格按声明依赖安装。
echo "=== 1. 严格依赖安装（无 --force-depends）==="
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/rel-i1.log 2>&1 \
  && ok "单包插件安装成功（daemon + LuCI + CGI 同包）" || { bad "单包安装失败"; tail -8 /tmp/rel-i1.log; }

echo "=== 2. 系统目录权限未被改动 ==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin 2>/dev/null)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 3. 包内文件权限 / 属主 / 语法 ==="
for d in /etc/prism-router /etc/prism-router/daily /usr/share/prism-router \
         /www/luci-static/resources/view/prism-router /www/luci-static/resources/prism-router \
         /usr/share/rpcd/ucode /usr/share/rpcd/acl.d /usr/share/luci/menu.d; do
  check "$d" "root:root drwxr-xr-x"
done
for pair in \
  "/usr/bin/prism-routerd:root:root -rwxr-xr-x" \
  "/etc/init.d/prism-routerd:root:root -rwxr-xr-x" \
  "/etc/config/prism-router:root:root -rw-r--r--" \
  "/usr/share/prism-router/feishu.uc:root:root -rw-r--r--" \
  "/usr/share/prism-router/feishu-test.sh:root:root -rwxr-xr-x" \
  "/usr/share/prism-router/retention.uc:root:root -rw-r--r--" \
  "/usr/share/prism-router/push.uc:root:root -rw-r--r--" \
  "/usr/share/prism-router/stations.uc:root:root -rw-r--r--" \
  "/www/cgi-bin/prism-router-ingest:root:root -rwxr-xr-x" \
  "/www/cgi-bin/prism-router-stations:root:root -rwxr-xr-x" \
  "/www/cgi-bin/prism-router-metrics:root:root -rwxr-xr-x" \
  "/www/cgi-bin/prism-router-feishu:root:root -rwxr-xr-x" \
  "/www/cgi-bin/prism-router-control:root:root -rwxr-xr-x" \
  "/usr/share/rpcd/ucode/prism-router.uc:root:root -rw-r--r--"; do
  f="${pair%%:*}"; want="${pair#*:}"
  check "$f" "$want"
done

# opkg files 列出的每个文件都必须存在、root:root、644 或 755（不允许 600/700）
check_opkg_files() { # $1=包名
  local pkg="$1" f own mode
  opkg files "$pkg" 2>/dev/null | tail -n +2 > "/tmp/files-$pkg.txt"
  [ -s "/tmp/files-$pkg.txt" ] || { bad "$pkg opkg files 为空"; return; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -e "$f" ]; then bad "$pkg 缺文件 $f"; continue; fi
    line=$(ls -ld "$f" 2>/dev/null)
    mode=$(printf '%s\n' "$line" | awk '{print $1}')
    own=$(printf '%s\n' "$line" | awk '{print $3":"$4}')
    [ "$own" = "root:root" ] || bad "$pkg $f 属主 $own"
    case "$mode" in
      -rw-r--r--|-rwxr-xr-x) ok "$pkg $f $mode" ;;
      *) bad "$pkg $f 权限 $mode（只允许 644/755）" ;;
    esac
  done < "/tmp/files-$pkg.txt"
}
check_opkg_files luci-app-prism-router

for f in /usr/bin/prism-routerd /usr/share/prism-router/*.uc /usr/share/rpcd/ucode/*.uc \
         /www/cgi-bin/prism-router-ingest /www/cgi-bin/prism-router-stations /www/cgi-bin/prism-router-metrics \
         /www/cgi-bin/prism-router-feishu /www/cgi-bin/prism-router-control; do
  [ -f "$f" ] || continue
  # ucode -c 按“raw script”编译；带 export 的共享库必须去掉 export 再编译，
  # 否则会把合法的 module 误判为语法错误。
  if grep -q '^export ' "$f"; then
    sed 's/^export //' "$f" > /tmp/uc-syntax.uc
    ucode -c /tmp/uc-syntax.uc >/dev/null 2>&1 \
      && ok "ucode 模块语法 $f（export 已归一）" || bad "ucode 模块语法错误 $f"
  else
    ucode -c "$f" >/dev/null 2>&1 && ok "ucode 语法 $f" || bad "ucode 语法错误 $f"
  fi
done
for j in /usr/share/rpcd/acl.d/luci-app-prism-router.json /usr/share/luci/menu.d/luci-app-prism-router.json; do
  ucode -e "json(require('fs').readfile('$j'))" >/dev/null 2>&1 \
    && ok "JSON 合法 $j" || bad "JSON 非法 $j"
done

echo "=== 4. payload 与仓库源码逐文件一致 ==="
while IFS='|' read -r dst src; do
  [ -n "$dst" ] || continue
  same_file "$dst" "/src/repo/$src"
done <<'PAYLOAD'
/usr/bin/prism-routerd|luci-app-prism-router/root/usr/bin/prism-routerd
/etc/init.d/prism-routerd|luci-app-prism-router/root/etc/init.d/prism-routerd
/etc/init.d/prism-router-panel|luci-app-prism-router/root/etc/init.d/prism-router-panel
/etc/config/prism-router|luci-app-prism-router/root/etc/config/prism-router
/usr/share/prism-router/feishu.uc|luci-app-prism-router/root/usr/share/prism-router/feishu.uc
/usr/share/prism-router/feishu-test.sh|luci-app-prism-router/root/usr/share/prism-router/feishu-test.sh
/usr/share/prism-router/retention.uc|luci-app-prism-router/root/usr/share/prism-router/retention.uc
/usr/share/prism-router/push.uc|luci-app-prism-router/root/usr/share/prism-router/push.uc
/usr/share/prism-router/stations.uc|luci-app-prism-router/root/usr/share/prism-router/stations.uc
/www/cgi-bin/prism-router-ingest|luci-app-prism-router/root/www/cgi-bin/prism-router-ingest
/www/cgi-bin/prism-router-stations|luci-app-prism-router/root/www/cgi-bin/prism-router-stations
/www/cgi-bin/prism-router-metrics|luci-app-prism-router/root/www/cgi-bin/prism-router-metrics
/www/cgi-bin/prism-router-feishu|luci-app-prism-router/root/www/cgi-bin/prism-router-feishu
/www/cgi-bin/prism-router-control|luci-app-prism-router/root/www/cgi-bin/prism-router-control
/www/prism-router-panel/index.html|luci-app-prism-router/root/www/prism-router-panel/index.html
/www/prism-router-panel/app.js|luci-app-prism-router/root/www/prism-router-panel/app.js
/www/prism-router-panel/style.css|luci-app-prism-router/root/www/prism-router-panel/style.css
/www/prism-router-panel/cgi-bin/panel-api|luci-app-prism-router/root/www/prism-router-panel/cgi-bin/panel-api
/usr/share/rpcd/ucode/prism-router.uc|luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router.uc
/usr/share/rpcd/acl.d/luci-app-prism-router.json|luci-app-prism-router/root/usr/share/rpcd/acl.d/luci-app-prism-router.json
/usr/share/luci/menu.d/luci-app-prism-router.json|luci-app-prism-router/root/usr/share/luci/menu.d/luci-app-prism-router.json
PAYLOAD
if [ -f /src/repo/luci-app-prism-router/root/usr/share/prism-router/prism-router-node-auth.uc ]; then
  same_file /usr/share/prism-router/prism-router-node-auth.uc \
    /src/repo/luci-app-prism-router/root/usr/share/prism-router/prism-router-node-auth.uc
fi

for f in /src/repo/luci-app-prism-router/htdocs/luci-static/resources/view/prism-router/*.js; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  same_file "/www/luci-static/resources/view/prism-router/$b" "$f"
done
for f in /src/repo/luci-app-prism-router/htdocs/luci-static/resources/prism-router/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  same_file "/www/luci-static/resources/prism-router/$b" "$f"
done
# 条件文件：安全 agent 新增的 rpcd 插件存在就必须进包并逐字节一致
for f in /src/repo/luci-app-prism-router/root/usr/share/rpcd/ucode/*.uc; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  same_file "/usr/share/rpcd/ucode/$b" "$f"
done

echo "=== 5. conffile / 同版本重装（升级覆盖）==="
grep -qx '/etc/config/prism-router' /usr/lib/opkg/info/luci-app-prism-router.conffiles 2>/dev/null \
  && ok "conffiles 声明 /etc/config/prism-router" || bad "conffiles 未声明 /etc/config/prism-router"

printf "\n\toption gate_marker '1'\n" >> /etc/config/prism-router
rm -f /usr/share/rpcd/ucode/prism-router.uc
opkg install --force-reinstall /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/re-luci.log 2>&1 \
  && ok "同版本强制重装成功（恢复 rpcd 插件）" || { bad "强制重装失败"; tail -8 /tmp/re-luci.log; }
same_file /usr/share/rpcd/ucode/prism-router.uc \
  /src/repo/luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router.uc

rm -f /usr/bin/prism-routerd
opkg install --force-reinstall /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/re-daemon.log 2>&1 \
  && ok "同版本强制重装成功（恢复 daemon）" || { bad "强制重装失败"; tail -8 /tmp/re-daemon.log; }
[ -f /usr/bin/prism-routerd ] && ok "重装恢复 /usr/bin/prism-routerd" || bad "重装未恢复 /usr/bin/prism-routerd"
if grep -q "gate_marker" /etc/config/prism-router; then
  ok "重装保留用户修改的 conffile"
else
  bad "重装丢失用户修改的 conffile"
fi
[ -f /etc/config/prism-router-opkg ] && echo "  NOTE  存在 /etc/config/prism-router-opkg（opkg 对修改过的 conffile 的正常行为）"

echo "=== 6. 卸载完整清单 ==="
opkg files luci-app-prism-router 2>/dev/null | tail -n +2 > /tmp/rm-luci-files.txt
opkg remove luci-app-prism-router >/tmp/rm-luci.log 2>&1 \
  && ok "卸载 luci-app-prism-router 成功" || { bad "卸载 luci-app 失败"; tail -8 /tmp/rm-luci.log; }

leftover=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" = "/etc/config/prism-router" ] && continue
  if [ -e "$f" ]; then bad "卸载残留 $f"; leftover=$((leftover+1)); fi
done < /tmp/rm-luci-files.txt
[ "$leftover" = 0 ] && ok "卸载清单内文件全部移除（conffile 按规则保留）"
[ -f /etc/config/prism-router ] && grep -q "gate_marker" /etc/config/prism-router \
  && ok "conffile 在卸载后保留（用户修改）" || bad "conffile 未按预期保留"
for f in /usr/bin/prism-routerd /etc/init.d/prism-routerd /www/cgi-bin/prism-router-ingest \
         /www/cgi-bin/prism-router-stations /www/cgi-bin/prism-router-metrics \
         /www/cgi-bin/prism-router-feishu /www/cgi-bin/prism-router-control; do
  [ -e "$f" ] && bad "卸载后仍存在 $f" || ok "已移除 $f"
done
if opkg list-installed 2>/dev/null | grep -q '^luci-app-prism-router '; then bad "luci-app 卸载后 opkg 仍认为已安装"; else ok "luci-app 已从 opkg 数据库移除"; fi

echo "=== 7. legacy（ar 容器）负例：必须被拒绝 ==="
for p in /src/legacy/*.legacy.ipk; do
  [ -e "$p" ] || { bad "缺少 legacy 负例包"; continue; }
  if opkg install "$p" >/tmp/legacy.log 2>&1; then
    bad "legacy 包被 opkg 接受：$p（旧格式不得发布）"
  else
    if grep -q 'Malformed package file\|Failed to extract control file' /tmp/legacy.log; then
      ok "legacy 被拒绝：$(basename "$p")（仅负例，不发布）"
    else
      bad "legacy 失败原因不是格式错误：$(basename "$p")"; tail -5 /tmp/legacy.log
    fi
  fi
done

echo
echo "=== release 结果（${RELEASE_TARGET:-?}）：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
