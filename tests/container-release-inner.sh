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
opkg install /src/dist/traffic-stats_1.0.0-1_all.ipk >/tmp/rel-i1.log 2>&1 \
  && ok "traffic-stats 安装成功" || { bad "traffic-stats 安装失败"; tail -8 /tmp/rel-i1.log; }
opkg install /src/dist/luci-app-traffic-stats_1.0.0-1_all.ipk >/tmp/rel-i2.log 2>&1 \
  && ok "luci-app-traffic-stats 安装成功" || { bad "luci-app 安装失败"; tail -8 /tmp/rel-i2.log; }

echo "=== 2. 系统目录权限未被改动 ==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin 2>/dev/null)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 3. 包内文件权限 / 属主 / 语法 ==="
for d in /etc/traffic-stats /etc/traffic-stats/daily /usr/share/traffic-stats \
         /www/luci-static/resources/view/traffic-stats /www/luci-static/resources/traffic-stats \
         /usr/share/rpcd/ucode /usr/share/rpcd/acl.d /usr/share/luci/menu.d; do
  check "$d" "root:root drwxr-xr-x"
done
for pair in \
  "/usr/bin/traffic-statsd:root:root -rwxr-xr-x" \
  "/etc/init.d/traffic-statsd:root:root -rwxr-xr-x" \
  "/etc/config/traffic-stats:root:root -rw-r--r--" \
  "/usr/share/traffic-stats/feishu.uc:root:root -rw-r--r--" \
  "/usr/share/traffic-stats/feishu-test.sh:root:root -rwxr-xr-x" \
  "/usr/share/traffic-stats/retention.uc:root:root -rw-r--r--" \
  "/usr/share/traffic-stats/push.uc:root:root -rw-r--r--" \
  "/usr/share/traffic-stats/stations.uc:root:root -rw-r--r--" \
  "/www/cgi-bin/traffic-stats-ingest:root:root -rwxr-xr-x" \
  "/www/cgi-bin/traffic-stats-stations:root:root -rwxr-xr-x" \
  "/www/cgi-bin/traffic-stats-metrics:root:root -rwxr-xr-x" \
  "/usr/share/rpcd/ucode/traffic-stats.uc:root:root -rw-r--r--"; do
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
check_opkg_files traffic-stats
check_opkg_files luci-app-traffic-stats

for f in /usr/bin/traffic-statsd /usr/share/traffic-stats/*.uc /usr/share/rpcd/ucode/*.uc \
         /www/cgi-bin/traffic-stats-ingest /www/cgi-bin/traffic-stats-stations /www/cgi-bin/traffic-stats-metrics; do
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
for j in /usr/share/rpcd/acl.d/luci-app-traffic-stats.json /usr/share/luci/menu.d/luci-app-traffic-stats.json; do
  ucode -e "json(require('fs').readfile('$j'))" >/dev/null 2>&1 \
    && ok "JSON 合法 $j" || bad "JSON 非法 $j"
done

echo "=== 4. payload 与仓库源码逐文件一致 ==="
while IFS='|' read -r dst src; do
  [ -n "$dst" ] || continue
  same_file "$dst" "/src/repo/$src"
done <<'PAYLOAD'
/usr/bin/traffic-statsd|traffic-stats/files/traffic-statsd.uc
/etc/init.d/traffic-statsd|traffic-stats/files/traffic-statsd.init
/etc/config/traffic-stats|traffic-stats/files/traffic-stats.config
/usr/share/traffic-stats/feishu.uc|traffic-stats/files/feishu.uc
/usr/share/traffic-stats/feishu-test.sh|traffic-stats/files/feishu-test.sh
/usr/share/traffic-stats/retention.uc|traffic-stats/files/retention.uc
/usr/share/traffic-stats/push.uc|traffic-stats/files/push.uc
/usr/share/traffic-stats/stations.uc|traffic-stats/files/stations.uc
/www/cgi-bin/traffic-stats-ingest|traffic-stats/files/ingest.uc
/www/cgi-bin/traffic-stats-stations|traffic-stats/files/ingest-stations.uc
/www/cgi-bin/traffic-stats-metrics|traffic-stats/files/traffic-stats-metrics.uc
/usr/share/rpcd/ucode/traffic-stats.uc|luci-app-traffic-stats/root/usr/share/rpcd/ucode/traffic-stats.uc
/usr/share/rpcd/acl.d/luci-app-traffic-stats.json|luci-app-traffic-stats/root/usr/share/rpcd/acl.d/luci-app-traffic-stats.json
/usr/share/luci/menu.d/luci-app-traffic-stats.json|luci-app-traffic-stats/root/usr/share/luci/menu.d/luci-app-traffic-stats.json
PAYLOAD
if [ -f /src/repo/traffic-stats/files/traffic-stats-node-auth.uc ]; then
  same_file /usr/share/traffic-stats/traffic-stats-node-auth.uc \
    /src/repo/traffic-stats/files/traffic-stats-node-auth.uc
fi

for f in /src/repo/luci-app-traffic-stats/htdocs/luci-static/resources/view/traffic-stats/*.js; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  same_file "/www/luci-static/resources/view/traffic-stats/$b" "$f"
done
for f in /src/repo/luci-app-traffic-stats/htdocs/luci-static/resources/traffic-stats/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  same_file "/www/luci-static/resources/traffic-stats/$b" "$f"
done
# 条件文件：安全 agent 新增的 rpcd 插件存在就必须进包并逐字节一致
for f in /src/repo/luci-app-traffic-stats/root/usr/share/rpcd/ucode/*.uc; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  same_file "/usr/share/rpcd/ucode/$b" "$f"
done

echo "=== 5. conffile / 同版本重装（升级覆盖）==="
grep -qx '/etc/config/traffic-stats' /usr/lib/opkg/info/traffic-stats.conffiles 2>/dev/null \
  && ok "conffiles 声明 /etc/config/traffic-stats" || bad "conffiles 未声明 /etc/config/traffic-stats"

printf "\n\toption gate_marker '1'\n" >> /etc/config/traffic-stats
rm -f /usr/share/rpcd/ucode/traffic-stats.uc
opkg install --force-reinstall /src/dist/luci-app-traffic-stats_1.0.0-1_all.ipk >/tmp/re-luci.log 2>&1 \
  && ok "luci-app 同版本强制重装成功" || { bad "luci-app 重装失败"; tail -8 /tmp/re-luci.log; }
same_file /usr/share/rpcd/ucode/traffic-stats.uc \
  /src/repo/luci-app-traffic-stats/root/usr/share/rpcd/ucode/traffic-stats.uc

rm -f /usr/bin/traffic-statsd
opkg install --force-reinstall /src/dist/traffic-stats_1.0.0-1_all.ipk >/tmp/re-daemon.log 2>&1 \
  && ok "traffic-stats 同版本强制重装成功" || { bad "traffic-stats 重装失败"; tail -8 /tmp/re-daemon.log; }
[ -f /usr/bin/traffic-statsd ] && ok "重装恢复 /usr/bin/traffic-statsd" || bad "重装未恢复 /usr/bin/traffic-statsd"
if grep -q "gate_marker" /etc/config/traffic-stats; then
  ok "重装保留用户修改的 conffile"
else
  bad "重装丢失用户修改的 conffile"
fi
[ -f /etc/config/traffic-stats-opkg ] && echo "  NOTE  存在 /etc/config/traffic-stats-opkg（opkg 对修改过的 conffile 的正常行为）"

echo "=== 6. 卸载完整清单 ==="
opkg files luci-app-traffic-stats 2>/dev/null | tail -n +2 > /tmp/rm-luci-files.txt
opkg files traffic-stats 2>/dev/null | tail -n +2 > /tmp/rm-daemon-files.txt
opkg remove luci-app-traffic-stats >/tmp/rm-luci.log 2>&1 \
  && ok "卸载 luci-app-traffic-stats 成功" || { bad "卸载 luci-app 失败"; tail -8 /tmp/rm-luci.log; }
opkg remove traffic-stats >/tmp/rm-daemon.log 2>&1 \
  && ok "卸载 traffic-stats 成功" || { bad "卸载 traffic-stats 失败"; tail -8 /tmp/rm-daemon.log; }

leftover=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" = "/etc/config/traffic-stats" ] && continue
  if [ -e "$f" ]; then bad "卸载残留 $f"; leftover=$((leftover+1)); fi
done < /tmp/rm-luci-files.txt
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" = "/etc/config/traffic-stats" ] && continue
  if [ -e "$f" ]; then bad "卸载残留 $f"; leftover=$((leftover+1)); fi
done < /tmp/rm-daemon-files.txt
[ "$leftover" = 0 ] && ok "卸载清单内文件全部移除（conffile 按规则保留）"
[ -f /etc/config/traffic-stats ] && grep -q "gate_marker" /etc/config/traffic-stats \
  && ok "conffile 在卸载后保留（用户修改）" || bad "conffile 未按预期保留"
for f in /usr/bin/traffic-statsd /etc/init.d/traffic-statsd /www/cgi-bin/traffic-stats-ingest \
         /www/cgi-bin/traffic-stats-stations /www/cgi-bin/traffic-stats-metrics; do
  [ -e "$f" ] && bad "卸载后仍存在 $f" || ok "已移除 $f"
done
if opkg list-installed 2>/dev/null | grep -q '^luci-app-traffic-stats '; then bad "luci-app 卸载后 opkg 仍认为已安装"; else ok "luci-app 已从 opkg 数据库移除"; fi
if opkg list-installed 2>/dev/null | grep -q '^traffic-stats '; then bad "traffic-stats 卸载后 opkg 仍认为已安装"; else ok "traffic-stats 已从 opkg 数据库移除"; fi

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
