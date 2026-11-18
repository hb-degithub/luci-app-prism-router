#!/bin/sh
# 数据 / 日志保留与清理（retention.uc）用例（容器内执行；
# 由 tests/container-validate-retention.sh 调用）
#
# 覆盖：
#   1. 安装两个包后 /etc /usr /www 权限不变（2026-11-14 事故回归核心）
#   2. retention.uc 落位 / 权限 / 语法；config 的 retention 段默认值齐全
#   3. 按天删除：5 个日期的 daily 只删 >400 天那个，其余一个不动（含 500 天前那个）
#   4. nodes / stations 各自天数独立生效（同年龄不同结论），文件名日期优先于 mtime
#   5. 日志截断：> log_max_kb 只留尾部一半、内容确实是尾部、无 .tmp 残留（原子替换）
#   6. 飞书队列：超 spool_max_kb 从最旧的删到不超
#   7. dry_run：只打印清单，一个文件都不动（UCI 的 dry_run=1 与 --dry-run 都算）
#   8. 越权保护：白名单外文件、符号链接、日期名子目录、目录覆盖尝试 全部不被删 / 不跟随
#   9. 摘要行格式正确；没有东西可删也 exit 0；enabled=0 时什么都不动
#  10. 守护进程：retention 段存在时不再按 history_days 计数裁剪 daily（否则 new 策略失效）
#
# 隔离：--network none，不访问外网、不接触任何真机；数据全部落容器 /etc/prism-router 与 /tmp。
mkdir -p /var/lock /var/run /tmp

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
cfg_commit(){ uci commit prism-router >/dev/null 2>&1; }
cfg_get(){ uci -q get "prism-router.retention.$1" 2>/dev/null; }

RT=/usr/share/prism-router/retention.uc
D=/etc/prism-router
T=/tmp/prism-router
OUT=/tmp/rt-out.txt
ERR=/tmp/rt-err.txt

# 距今 N 天的本地日期（busybox 只认 @epoch，不认 "N days ago"）
dayago(){ date -d "@$(( $(date +%s) - $1 * 86400 ))" +%Y-%m-%d; }
# 把文件 mtime 拨到 N 天前
age(){ touch -d "@$(( $(date +%s) - $1 * 86400 ))" "$2"; }
cnt(){ ls -1 "$1" 2>/dev/null | wc -l | tr -d ' '; }
size(){ wc -c < "$1" 2>/dev/null | tr -d ' '; }

# 跑一次 retention.uc：stdout -> $OUT，stderr -> $ERR；echo 退出码
run_rt(){ ucode "$RT" "$@" >"$OUT" 2>"$ERR"; echo $?; }

# 摘要行（stdout 最后一行）的字段值
sum_field(){ tail -n 1 "$OUT" | tr ' ' '\n' | sed -n "s/^$1=//p"; }
summary_ok(){
  tail -n 1 "$OUT" | grep -Eq \
    '^retention: files_deleted=[0-9]+ bytes_freed=[0-9]+ logs_truncated=[0-9]+$'
}

# 重新造干净的白名单目录
reset_dirs(){
  rm -rf "$D/daily" "$D/nodes" "$D/stations" "$T"
  mkdir -p "$D/daily" "$D/nodes" "$D/stations" "$T/feishu-queue"
}

# 每个用例前把 UCI 恢复成默认值（retention 段全部选项）
reset_cfg(){
  UCI set prism-router.retention.enabled='1'
  UCI set prism-router.retention.daily_days='400'
  UCI set prism-router.retention.nodes_days='30'
  UCI set prism-router.retention.stations_days='7'
  UCI set prism-router.retention.log_days='7'
  UCI set prism-router.retention.log_max_kb='512'
  UCI set prism-router.retention.spool_max_kb='2048'
  UCI set prism-router.retention.dry_run='0'
  cfg_commit
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW"

echo "=== 1. 安装两个包 ==="
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 \
  && ok "prism-router 安装成功" || { bad "prism-router 安装失败"; tail -5 /tmp/i1.log; }
true >/tmp/i2.log 2>&1 \
  && ok "luci-app 安装成功" || { bad "luci-app 安装失败"; tail -5 /tmp/i2.log; }

echo "=== 2. 系统目录权限未被改动（回归核心）==="
A_ETC=$(perm /etc); A_USR=$(perm /usr); A_WWW=$(perm /www)
[ "$B_ETC" = "$A_ETC" ] && ok "/etc 未变 ($A_ETC)" || bad "/etc 被改动: $B_ETC -> $A_ETC"
[ "$B_USR" = "$A_USR" ] && ok "/usr 未变 ($A_USR)" || bad "/usr 被改动: $B_USR -> $A_USR"
[ "$B_WWW" = "$A_WWW" ] && ok "/www 未变 ($A_WWW)" || bad "/www 被改动: $B_WWW -> $A_WWW"

echo "=== 3. retention.uc 落位 / 权限 / 语法 ==="
if [ -f "$RT" ]; then
  ok "存在 $RT  ($(perm "$RT"))"
  check "$RT" "root:root -rw-r--r--"
  ucode -c "$RT" >/tmp/rt-c.log 2>&1 && ok "ucode 语法检查通过" || { bad "语法检查失败"; tail -3 /tmp/rt-c.log; }
else
  bad "缺失 $RT（Makefile / build-ipk.sh 没装？）"
fi

echo "=== 4. config 的 retention 段默认值 ==="
for kv in enabled=1 daily_days=400 nodes_days=30 stations_days=7 log_days=7 \
          log_max_kb=512 spool_max_kb=2048 dry_run=0; do
  k=${kv%%=*}; want=${kv#*=}; got=$(cfg_get "$k")
  [ "$got" = "$want" ] && ok "retention.$k=$got" || bad "retention.$k 期望[$want] 实际[${got:-缺失}]"
done
# 原有 section 一行都没被改动（追加而非重写）
grep -q "^config settings 'settings'" /etc/config/prism-router \
  && grep -q "^config feishu 'feishu'" /etc/config/prism-router \
  && grep -q "^config retention 'retention'" /etc/config/prism-router \
  && ok "config 里 settings / feishu / retention 三个 section 都在" \
  || bad "config 的 section 结构被破坏"
check /etc/config/prism-router "root:root -rw-r--r--"

echo "=== 5. 离线自检（日期解析 / 白名单判定）==="
RC=$(ucode "$RT" --selftest >/tmp/rt-self.txt 2>&1; echo $?)
grep -q 'selftest OK' /tmp/rt-self.txt && ok "selftest OK ($(tail -1 /tmp/rt-self.txt))" \
  || { bad "selftest 未通过"; tail -5 /tmp/rt-self.txt; }
[ "$RC" = "0" ] && ok "selftest 退出码 0" || bad "selftest 退出码 $RC"

echo "=== 6. daily：5 个日期只删 500 天前那个 ==="
reset_cfg; reset_dirs
for n in 0 100 200 300; do f=$(dayago $n); printf '{"day":"%s"}\n' "$f" > "$D/daily/$f.json"; done
OLD5=$(dayago 500); printf '{"day":"%s"}\n' "$OLD5" > "$D/daily/$OLD5.json"
RC=$(run_rt)
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
[ ! -e "$D/daily/$OLD5.json" ] && ok "删除 $OLD5.json（500 天前 > daily_days=400）" \
  || bad "500 天前的 daily 没被删"
KEPT=0
for n in 0 100 200 300; do [ -e "$D/daily/$(dayago $n).json" ] && KEPT=$((KEPT+1)); done
[ "$KEPT" = "4" ] && ok "其余 4 个 daily 一个没动" || bad "其余 daily 只剩 $KEPT/4"
grep -q "retention: 删除 $D/daily/$OLD5.json（500 天前）" "$OUT" \
  && ok "清单行格式：retention: 删除 X（N 天前）" \
  || { bad "清单行不符合约定"; head -3 "$OUT"; }
summary_ok && ok "摘要行格式正确 ($(tail -n 1 "$OUT"))" || bad "摘要行格式不对：$(tail -n 1 "$OUT")"
[ "$(sum_field files_deleted)" = "1" ] && ok "files_deleted=1" || bad "files_deleted=$(sum_field files_deleted) 期望 1"

echo "=== 7. nodes / stations 天数独立生效（同年龄不同结论）==="
reset_cfg; reset_dirs
printf 'a\n' > "$D/nodes/node-40d.json"; age 40 "$D/nodes/node-40d.json"      # > 30 -> 删
printf 'b\n' > "$D/nodes/node-10d.json"; age 10 "$D/nodes/node-10d.json"      # < 30 -> 留
printf 'c\n' > "$D/nodes/node-2d.json";  age 2  "$D/nodes/node-2d.json"       # < 30 -> 留
printf 'd\n' > "$D/stations/ap-10d.json"; age 10 "$D/stations/ap-10d.json"    # > 7  -> 删
printf 'e\n' > "$D/stations/ap-2d.json";  age 2  "$D/stations/ap-2d.json"     # < 7  -> 留
# 文件名里有日期时按日期判断（mtime 是现在也得删）
printf 'f\n' > "$D/nodes/2020-01-01.json"
RC=$(run_rt)
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
[ ! -e "$D/nodes/node-40d.json" ] && ok "nodes 40 天前 -> 删除（nodes_days=30）" || bad "node-40d 没删"
[ -e "$D/nodes/node-10d.json" ] && [ -e "$D/nodes/node-2d.json" ] \
  && ok "nodes 10/2 天前 -> 保留" || bad "nodes 里不该删的被删了"
[ ! -e "$D/nodes/2020-01-01.json" ] && ok "文件名日期优先于 mtime（2020-01-01.json 删）" \
  || bad "日期名文件没被删（日期解析失效？）"
[ ! -e "$D/stations/ap-10d.json" ] && ok "stations 10 天前 -> 删除（stations_days=7）" || bad "ap-10d 没删"
[ -e "$D/stations/ap-2d.json" ] && ok "stations 2 天前 -> 保留" || bad "ap-2d 被误删"
[ "$(sum_field files_deleted)" = "3" ] && ok "files_deleted=3（40d + 10d + 2020）" \
  || bad "files_deleted=$(sum_field files_deleted) 期望 3"

echo "=== 8. 日志截断：只留尾部一半，且内容确实是尾部 ==="
reset_cfg; reset_dirs
LOG=$T/feishu.log
{ echo HEADMARK; seq 1 100000; echo TAILMARK; } > "$LOG"   # ~576 KB > 512 KB
BEFORE=$(size "$LOG")
RC=$(run_rt)
AFTER=$(size "$LOG")
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
[ "$BEFORE" -gt 524288 ] && ok "造出超限日志 ${BEFORE}B (> 512KB)" || bad "测试日志只有 ${BEFORE}B"
[ "$AFTER" -lt "$BEFORE" ] && ok "被截断 ${BEFORE}B -> ${AFTER}B" || bad "日志没被截断（${AFTER}B）"
[ "$AFTER" -ge 260000 ] && [ "$AFTER" -le 310000 ] \
  && ok "截断后约为一半（${AFTER}B ≈ $((BEFORE/2))B）" || bad "截断后 ${AFTER}B，不是约一半"
tail -c 20 "$LOG" | grep -q TAILMARK && ok "尾部内容保留（TAILMARK 在）" || bad "尾部内容丢了"
head -c 100 "$LOG" | grep -q HEADMARK && bad "头部内容还在（没从尾部切）" || ok "头部内容已丢（从尾部切）"
[ "$(sum_field logs_truncated)" = "1" ] && ok "logs_truncated=1" || bad "logs_truncated=$(sum_field logs_truncated)"
ls -1 "$T" | grep -q '\.tmp\.' && bad "残留临时文件 $(ls -1 "$T" | grep '\.tmp\.')" \
  || ok "没有 .tmp 残留（临时文件 + rename 原子替换）"
# 日志来源是守护进程 / 飞书模块，权限保持 0644
[ "$(perm "$LOG" | awk '{print $1}')" = "-rw-r--r--" ] && ok "截断后权限仍为 0644" \
  || bad "截断后权限变了：$(perm "$LOG")"

echo "=== 9. 飞书队列：超上限从最旧的删到不超 ==="
reset_cfg; reset_dirs
Q=$T/feishu-queue
for i in 1 2 3; do seq 1 200000 > "$Q/q-$i.json"; done          # 每个 ~1.2 MB
age 3 "$Q/q-1.json"; age 2 "$Q/q-2.json"; age 1 "$Q/q-3.json"
BEFORE_KB=$(du -sk "$Q" | cut -f1)
RC=$(run_rt)
AFTER_KB=$(du -sk "$Q" | cut -f1)
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
[ "$BEFORE_KB" -gt 2048 ] && ok "造出超限队列 ${BEFORE_KB}KB (> 2048KB)" || bad "队列只有 ${BEFORE_KB}KB"
[ "$AFTER_KB" -le 2048 ] && ok "删到不超上限（${BEFORE_KB}KB -> ${AFTER_KB}KB）" \
  || bad "队列仍超限 ${AFTER_KB}KB"
[ ! -e "$Q/q-1.json" ] && [ ! -e "$Q/q-2.json" ] && ok "最旧的两个（q-1/q-2）被删" \
  || bad "没有从最旧开始删（剩：$(ls "$Q")）"
[ -e "$Q/q-3.json" ] && ok "最新的 q-3.json 保留" || bad "最新的 q-3 被删了"
grep -q "retention: 删除 $Q/q-1.json（队列" "$OUT" && ok "清单行带队列原因" \
  || { bad "队列删除清单行不符合约定"; grep -c '删除' "$OUT"; }

echo "=== 10. dry_run：只打印清单，一个文件都不动 ==="
reset_cfg; reset_dirs
OLD5=$(dayago 500)
printf '{"day":"%s"}\n' "$OLD5" > "$D/daily/$OLD5.json"
printf 'x\n' > "$D/nodes/old.json"; age 90 "$D/nodes/old.json"
{ echo HEADMARK; seq 1 100000; echo TAILMARK; } > "$T/feishu.log"
for i in 1 2 3; do seq 1 200000 > "$Q/q-$i.json"; done
age 5 "$Q/q-1.json"
BEFORE_STATE=$(ls -1 "$D/daily" "$D/nodes" "$D/stations" "$T/feishu-queue" | wc -l)
BEFORE_LOG=$(size "$T/feishu.log")
BEFORE_QKB=$(du -sk "$Q" | cut -f1)
RC=$(run_rt --dry-run)
[ "$RC" = "0" ] && ok "--dry-run 退出码 0" || bad "--dry-run 退出码 $RC"
[ -e "$D/daily/$OLD5.json" ] && [ -e "$D/nodes/old.json" ] && ok "dry-run 没删文件" || bad "dry-run 删了文件！"
[ "$(size "$T/feishu.log")" = "$BEFORE_LOG" ] && ok "dry-run 没截断日志（仍 ${BEFORE_LOG}B）" \
  || bad "dry-run 截断了日志"
[ "$(du -sk "$Q" | cut -f1)" = "$BEFORE_QKB" ] && ok "dry-run 没动队列（仍 ${BEFORE_QKB}KB）" \
  || bad "dry-run 动了队列"
AFTER_STATE=$(ls -1 "$D/daily" "$D/nodes" "$D/stations" "$T/feishu-queue" | wc -l)
[ "$BEFORE_STATE" = "$AFTER_STATE" ] && ok "dry-run 前后条目数一致（$AFTER_STATE）" \
  || bad "dry-run 前后条目数 $BEFORE_STATE -> $AFTER_STATE"
grep -q "retention: 将删除 $D/daily/$OLD5.json（500 天前）" "$OUT" && ok "清单用「将删除」" \
  || { bad "dry-run 清单格式不对"; head -4 "$OUT"; }
grep -q "retention: 将截断 $T/feishu.log（" "$OUT" && ok "清单用「将截断」" || bad "没有「将截断」行"
grep -q 'retention: dry-run：计划删除 .* 个文件、截断 .* 个日志' "$OUT" && ok "有计划汇总行" \
  || { bad "没有 dry-run 计划汇总"; tail -2 "$OUT"; }
summary_ok && ok "dry-run 摘要行格式正确 ($(tail -n 1 "$OUT"))" || bad "dry-run 摘要行格式不对"
[ "$(sum_field files_deleted)" = "0" ] && [ "$(sum_field logs_truncated)" = "0" ] \
  && ok "dry-run 摘要记 0（确实没动文件）" \
  || bad "dry-run 摘要不是 0：$(tail -n 1 "$OUT")"
[ -s "$ERR" ] && bad "stderr 有输出：$(head -2 "$ERR")" || ok "dry-run 无 stderr 噪声"

echo "=== 11. UCI dry_run=1 与 --dry-run 等价 ==="
UCI set prism-router.retention.dry_run='1'; cfg_commit
OLD6=$(dayago 600); printf 'z\n' > "$D/daily/$OLD6.json"
RC=$(run_rt)
[ "$RC" = "0" ] && [ -e "$D/daily/$OLD6.json" ] && ok "dry_run=1：文件保留" || bad "dry_run=1 竟然删了文件"
grep -q "retention: 将删除 $D/daily/$OLD6.json" "$OUT" && ok "dry_run=1：清单里是「将删除」" \
  || bad "dry_run=1 没走 dry-run 分支"
UCI set prism-router.retention.dry_run='0'; cfg_commit

echo "=== 12. 越权保护：白名单外 / 符号链接 / 目录 / 覆盖尝试 ==="
reset_cfg; reset_dirs
NOW_D=$(dayago 500)
# (a) 白名单外的文件：/etc/escape.json 与白名单目录的父目录 /etc/prism-router/escape.json
printf 'escape\n' > /etc/escape.json;            age 900 /etc/escape.json
printf 'escape2\n' > "$D/escape.json";           age 900 "$D/escape.json"
# (b) 白名单目录里的符号链接（名字是超期日期，指向白名单外）
ln -s /etc/escape.json "$D/daily/$NOW_D.json"
# (c) 白名单目录里名为超期日期的**子目录**（拒绝删除目录本身）
SUBD=$(dayago 800); mkdir -p "$D/daily/$SUBD.json"
# (d) 目录里的普通超期文件（对照：这个应该被删）
REAL=$(dayago 700); printf 'real\n' > "$D/daily/$REAL.json"
RC=$(run_rt)
[ "$RC" = "0" ] && ok "退出码 0" || bad "退出码 $RC"
[ -f /etc/escape.json ] && [ "$(cat /etc/escape.json)" = "escape" ] && ok "/etc/escape.json 未被删" \
  || bad "/etc/escape.json 被删/被改！"
[ -f "$D/escape.json" ] && ok "父目录 $D/escape.json 未被删（不在白名单目录里）" \
  || bad "父目录里的 escape.json 被删了！"
[ -L "$D/daily/$NOW_D.json" ] && [ -f /etc/escape.json ] && ok "符号链接未被删、目标未被跟随删除" \
  || bad "符号链接或它的目标被删了！"
[ -d "$D/daily/$SUBD.json" ] && ok "日期名子目录未被删（拒绝删目录本身）" || bad "子目录被删了！"
[ ! -e "$D/daily/$REAL.json" ] && ok "同目录里的普通超期文件照常删除（对照）" || bad "普通文件没删（逻辑失效）"
grep -q "retention: 删除 $D/daily/$REAL.json（700 天前）" "$OUT" && ok "只删了该删的那个" \
  || bad "清单里没有对照文件的删除行"

# (e) 目录覆盖尝试：/etc、上跳、白名单外的 tmp 目录 一律拒绝，系统目录不受影响
printf 'keep\n' > /etc/rt-keep.json; age 900 /etc/rt-keep.json
OLD8=$(dayago 700); printf 'nofallback\n' > "$D/daily/$OLD8.json"
RC=$(run_rt --daily-dir /etc --nodes-dir "$D/../.." --stations-dir /etc/prism-router/../../etc \
           --log-dir /etc --queue-dir /tmp)
[ "$RC" = "0" ] && ok "非法目录覆盖也退出 0（不崩）" || bad "非法目录覆盖退出码 $RC"
[ -f /etc/rt-keep.json ] && ok "/etc/rt-keep.json 未被删（--daily-dir /etc 被拒绝）" \
  || bad "--daily-dir /etc 竟然生效了！"
[ -e "$D/daily/$OLD8.json" ] && ok "被拒绝后不回退到默认目录（$D/daily 里的超期文件没被删）" \
  || bad "拒绝 --daily-dir /etc 后偷偷回退到了默认目录！"
grep -q '拒绝 daily 目录 /etc' "$OUT" && ok "打印拒绝原因（不在白名单之下）" \
  || { bad "没有拒绝日志"; head -4 "$OUT"; }
grep -q '不是规范的绝对路径' "$OUT" && ok "含 .. 的路径被拒绝（规范化校验）" \
  || { bad "含 .. 的路径没被拒绝"; grep WARN "$OUT"; }

# (f) 白名单根被换成符号链接：整个目录跳过（不跟随）
reset_dirs
mkdir -p /tmp/rt-evil; printf 'victim\n' > /tmp/rt-evil/v.json; age 900 /tmp/rt-evil/v.json
rmdir "$D/stations" 2>/dev/null; ln -s /tmp/rt-evil "$D/stations"
RC=$(run_rt)
[ "$RC" = "0" ] && ok "白名单根是软链时退出 0" || bad "退出码 $RC"
[ -f /tmp/rt-evil/v.json ] && ok "软链指向的目录内容未被删（不跟随）" || bad "跟随软链删了白名单外的文件！"
grep -q 'stations 目录 .* 不是普通目录（link）' "$OUT" && ok "打印「不是普通目录（link）」" \
  || { bad "没有拒绝软链根目录的日志"; grep WARN "$OUT"; }

echo "=== 13. 无东西可删 / enabled=0 ==="
reset_cfg; reset_dirs
RC=$(run_rt)
[ "$RC" = "0" ] && ok "空目录也退出 0" || bad "空目录退出码 $RC"
summary_ok && ok "空目录摘要行仍正确 ($(tail -n 1 "$OUT"))" || bad "空目录摘要行不对"
[ "$(sum_field files_deleted)" = "0" ] && [ "$(sum_field bytes_freed)" = "0" ] \
  && [ "$(sum_field logs_truncated)" = "0" ] && ok "摘要全 0" || bad "空目录摘要不全 0"

UCI set prism-router.retention.enabled='0'; cfg_commit
OLD7=$(dayago 500); printf 'q\n' > "$D/daily/$OLD7.json"
{ echo HEADMARK; seq 1 100000; echo TAILMARK; } > "$T/feishu.log"
BEFORE_LOG=$(size "$T/feishu.log")
RC=$(run_rt)
[ "$RC" = "0" ] && ok "enabled=0 退出码 0" || bad "enabled=0 退出码 $RC"
[ -e "$D/daily/$OLD7.json" ] && ok "enabled=0 不删文件" || bad "enabled=0 竟然删文件"
[ "$(size "$T/feishu.log")" = "$BEFORE_LOG" ] && ok "enabled=0 不截断日志" || bad "enabled=0 竟然截断日志"
grep -q '已禁用' "$OUT" && ok "打印「已禁用」" || bad "没有禁用提示"
summary_ok && ok "enabled=0 摘要行仍正确" || bad "enabled=0 摘要行不对"
reset_cfg

echo "=== 13.5 安全阀：days=0 关闭 / 非法值回落默认 ==="
reset_dirs
UCI set prism-router.retention.daily_days='0'; cfg_commit
OLD9=$(dayago 500); printf 'safe\n' > "$D/daily/$OLD9.json"
{ echo HEADMARK; seq 1 100000; echo TAILMARK; } > "$T/feishu.log"
BEFORE_LOG=$(size "$T/feishu.log")
UCI set prism-router.retention.log_max_kb='0'; cfg_commit
RC=$(run_rt)
[ "$RC" = "0" ] && ok "0 值退出码 0" || bad "0 值退出码 $RC"
[ -e "$D/daily/$OLD9.json" ] && ok "daily_days=0 -> 关闭按天清理（500 天前的文件保留）" \
  || bad "daily_days=0 竟然还在删"
[ "$(size "$T/feishu.log")" = "$BEFORE_LOG" ] && ok "log_max_kb=0 -> 关闭截断" || bad "log_max_kb=0 竟然截断了"
UCI set prism-router.retention.daily_days='abc'; cfg_commit
RC=$(run_rt)
grep -q '配置 daily_days=abc 不是整数，用默认值 400' "$OUT" && ok "非法值回落默认并 WARN" \
  || { bad "非法值没有回落到默认"; grep WARN "$OUT"; }
[ ! -e "$D/daily/$OLD9.json" ] && ok "回落 daily_days=400 后 500 天前的文件被删（默认值生效）" \
  || bad "回落默认值后没有生效"
reset_cfg

echo "=== 14. 守护进程：retention 段接管 daily 清理（新策略才生效）==="
# 老行为：按 settings.history_days 计数裁剪（默认 7 个文件）
# 新行为：retention.enabled=1 时不裁剪，交给 retention.uc 按 daily_days 日期清理
# PRISM_ROUTER_PRUNE_NOW=1 让守护进程在启动时立刻跑一次清理判定（等价于跨天那次，
# 容器里等不到零点；正常运行时它只在 day_rollover_check 里跑）。
rm -rf /tmp/rt-daily; mkdir -p /tmp/rt-daily
for i in 1 2 3 4 5 6 7 8 9 10; do
  printf '{"day":"2024-01-%02d"}\n' "$i" > "/tmp/rt-daily/2024-01-$(printf '%02d' $i).json"
done
UCI set prism-router.settings.lan_ranges='192.168.100.0/24'
UCI set prism-router.retention.enabled='1'; cfg_commit
TODAY_F=$(date +%Y-%m-%d)
PRISM_ROUTER_ONCE=1 PRISM_ROUTER_PRUNE_NOW=1 PRISM_ROUTER_DAILY_DIR=/tmp/rt-daily \
  PRISM_ROUTER_CONNTRACK_FILE=/fixtures/nf_conntrack \
  PRISM_ROUTER_CLASH_API=127.0.0.1:1 \
  ucode /usr/bin/prism-routerd >/tmp/rt-daemon1.log 2>&1
N1=$(cnt /tmp/rt-daily)
[ "$N1" = "11" ] && ok "retention 段存在 -> 守护进程不裁剪（10 个历史 + 今天 = 11）" \
  || bad "retention 段存在时仍被裁剪：剩 $N1 个（期望 11）"

UCI set prism-router.retention.enabled='0'; cfg_commit
PRISM_ROUTER_ONCE=1 PRISM_ROUTER_PRUNE_NOW=1 PRISM_ROUTER_DAILY_DIR=/tmp/rt-daily \
  PRISM_ROUTER_CONNTRACK_FILE=/fixtures/nf_conntrack \
  PRISM_ROUTER_CLASH_API=127.0.0.1:1 \
  ucode /usr/bin/prism-routerd >/tmp/rt-daemon2.log 2>&1
N2=$(cnt /tmp/rt-daily)
# 本次启动时目录里已有 11 个（10 个历史 + 今天那份）-> 按 history_days=7 裁到 7 个
[ "$N2" = "7" ] && ok "retention 段关闭 -> 回到 history_days=7 计数裁剪（剩 7 个）" \
  || bad "retention 段关闭后剩 $N2 个（期望 7），老行为回归失败"
[ ! -e /tmp/rt-daily/2024-01-01.json ] && [ -e /tmp/rt-daily/2024-01-10.json ] \
  && ok "老行为确实从最旧的开始裁（01-01 没了，01-10 还在）" \
  || bad "老行为裁剪顺序不对：$(ls /tmp/rt-daily | tr '\n' ' ')"
[ -e "/tmp/rt-daily/$TODAY_F.json" ] && ok "今天的 daily 仍在（$TODAY_F.json）" || bad "今天的 daily 被误删"
reset_cfg

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
