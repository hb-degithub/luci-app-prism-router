#!/bin/sh
# feishu.uc「发什么 / 什么时候发 / 什么条件下发」可配化的容器门禁（在隔离容器内执行）
#
# 覆盖：
#   1. 安装包 + 默认配置（老配置行为：只有 webhook/secret 也能正常出卡片）
#   2. report_items 各种组合：区块出现 / 不出现 / 顺序；未知项与空值不报错
#   3. report_mode / report_time / report_weekday / --window 的到点判定（--at 注入时间）
#   4. 各告警阈值触发与不触发、免打扰时段、报表不受免打扰影响
#   5. 卡片体积 < 20480、无 note/action、check 结构校验跟随 report_items
#   6. selftest / status 不退化
#
# 隔离：容器内没有外网，全程离线；不接触任何真机。

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  PASS  $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
eq(){ # $1=期望 $2=实际 $3=描述
  if [ "$1" = "$2" ]; then ok "$3（$2）"; else bad "$3：期望[$1] 实际[$2]"; fi
}
has(){ # $1=必须出现的文本 $2=文件 $3=描述
  if grep -q -- "$1" "$2" 2>/dev/null; then ok "$3"; else bad "$3（卡片里找不到 $1）"; fi
}
hasnot(){ # $1=必须不出现的文本
  if grep -q -- "$1" "$2" 2>/dev/null; then bad "$3（卡片里不该出现 $1）"; else ok "$3"; fi
}
rc_is(){ # $1=期望退出码 $2=实际 $3=描述
  eq "$1" "$2" "$3"
}

FEISHU=/usr/share/prism-router/feishu.uc
CFG=/etc/config/prism-router
NOW=$(date +%s)
TODAY=$(date +%F)
WORK=/tmp/fs-gate
rm -rf "$WORK"; mkdir -p "$WORK"

echo "=== 0. 安装 prism-router ==="
opkg install /src/dist/prism-router_1.0.0-1_all.ipk >/tmp/fs-install.log 2>&1 \
  && ok "安装成功" || { bad "安装失败"; tail -5 /tmp/fs-install.log; }
[ -f "$FEISHU" ] && ok "feishu.uc 已安装（$FEISHU）" || { bad "feishu.uc 缺失"; exit 1; }
if grep -q "report_items" "$CFG"; then
  ok "默认配置已包含 report_items（新装即有默认值）"
else
  bad "默认配置缺少 report_items"
fi
for opt in report_mode report_time report_weekday alert_app_daily_limit alert_spike_ratio \
           alert_offline_min alert_cpu_pct alert_mem_pct alert_disk_pct alert_quiet_hours; do
  grep -q "option $opt " "$CFG" && ok "默认配置含 $opt" || bad "默认配置缺少 $opt"
done
cp "$CFG" "$WORK/config.bak"

# ── 夹具生成器（ucode：直接写 JSON，避免 shell 拼 JSON 出错）──────────────
cat > "$WORK/mkfix.uc" <<'UCEOF'
let fs = require("fs");
let what = ARGV[0], path = ARGV[1], mode = ARGV[2];
let now = time();
let GiB = 1073741824;

function state(with_system) {
	let devs = [];
	let links = ["wifi", "wired", "unknown"];
	for (let i = 1; i <= 12; i++) {
		/* device-12 故意做成「离线 1 小时」，供离线告警用例使用 */
		push(devs, {
			ip: sprintf("192.168.100.%d", 100 + i),
			mac: sprintf("dc:56:7b:89:fb:%02x", i),
			hostname: "device-" + i,
			link: links[(i - 1) % 3],
			direct_rx: i * 1000000, direct_tx: i * 10000,
			proxy_rx: i * 9000000, proxy_tx: i * 90000,
			rx_rate: 1000, tx_rate: 100,
			last_seen: (i == 12) ? (now - 3600) : (now - 10)
		});
	}
	let st = {
		ts: now - 5, uptime: 36000,
		source: { clash: "ok", conntrack: "ok" },
		totals: {
			direct_rx: 1234567890, direct_tx: 1234567,
			proxy_rx: 9876543210, proxy_tx: 76543210,
			wifi_rx: 5000000000, wifi_tx: 500000,
			wired_rx: 6000000000, wired_tx: 8000000,
			unknown_rx: 2000000000, unknown_tx: 200000,
			rx_rate: 12500000, tx_rate: 980000
		},
		nodes: {
			"US2-HY2": { rx: 8000000000, tx: 60000000 },
			"JP1-Tokyo": { rx: 3000000000, tx: 20000000 },
			"HK-HKT": { rx: 1000000000, tx: 10000000 },
			"DIRECT": { rx: 1234567890, tx: 1234567 }
		},
		devices: devs,
		apps: [
			{ host: "ws.chatgpt.com", rx: 20 * GiB, tx: 0, chain: "US2-HY2", devices: 2 },
			{ host: "www.bilibili.com", rx: 5000000000, tx: 1000000, chain: "DIRECT", devices: 3 },
			{ host: "github.com", rx: 1000000000, tx: 100000, chain: "JP1-Tokyo", devices: 1 }
		],
		health: { accounting_confidence: "exact", reasons: [], conntrack_count: 1800,
		          link_source: "brctl", link_bridge: "br-lan", link_ports: [3],
		          link_ports_from: "ap_macs", link_entries: 42, link_refresh: 30, link_error: "" }
	};
	if (with_system)
		st.system = { cpu_pct: 95, mem_pct: 50, load1: 0.52, load5: 0.48, load15: 0.40,
		              disk_pct: 70, temp_c: 48, uptime: 273600,
		              mem_total: 12884901888, mem_used: 6442450944 };
	return st;
}

function history(boost) {
	let buckets = [];
	for (let i = 0; i < 96; i++) {
		let per = 1048576;                       /* 1 MB / 5min -> 12 MB/h */
		if (boost && i >= 84)                    /* 最近 1 小时的桶放大到 200 MB（rx+tx=400MB） */
			per = 200 * 1048576;
		push(buckets, {
			/* 最新一个桶正好落在「现在」，保证任意分钟都能命中当前小时（用例不随时钟漂移） */
			ts: now - (95 - i) * 300,
			direct_rx: per, direct_tx: 1024,
			proxy_rx: per, proxy_tx: 2048
		});
	}
	return { day: "", buckets: buckets };
}

function alertstate() {
	/* 11 台在线（刚看到）、device-12 一小时前最后出现 -> 离线用例 */
	let devs = {};
	for (let i = 1; i <= 12; i++) {
		let k = sprintf("dc:56:7b:89:fb:%02x", i);
		devs[k] = (i == 12) ? (now - 3600) : now;
	}
	return { version: 1, devices: devs, cooldown: {}, updated: now };
}

let out;
if (what == "state")
	out = state(mode != "nosys");
else if (what == "history")
	out = history(mode == "boost");
else if (what == "alertstate")
	out = alertstate();
else {
	print("unknown: " + what + "\n");
	exit(2);
}
fs.writefile(path, sprintf("%J", out));
UCEOF

mkfix(){ ucode "$WORK/mkfix.uc" "$@"; }

# 主夹具：带 system、普通 history、7 天 daily 基线
BASE="$WORK/base"; mkdir -p "$BASE/daily"
mkfix state "$BASE/state.json" system
mkfix history "$BASE/history.json" normal
mkfix history "$BASE/history-boost.json" boost
mkfix alertstate "$BASE/alert-state.json"
i=1
while [ "$i" -le 7 ]; do
  d=$(date -d "@$((NOW - i * 86400))" +%F)
  printf '{"day":"%s","totals":{"direct_rx":1073741824,"direct_tx":0,"proxy_rx":1073741824,"proxy_tx":0}}\n' "$d" \
    > "$BASE/daily/$d.json"
  i=$((i + 1))
done
ok "夹具就绪（state/history/daily×7/alert-state）"

card(){ # $1=输出文件，$2...=额外参数
  out=$1; shift
  ucode "$FEISHU" card --base "$BASE" --secret demo --out "$out" "$@"
}
sz(){ wc -c < "$1" | tr -d ' \t'; }
pos(){ awk -v p="$1" '{ i = index($0, p); print (i > 0 ? i : 0) }' "$2"; }
band(){ # 体积 + note/action 三项通用断言
  s=$(sz "$1")
  [ "$s" -gt 0 ] && [ "$s" -lt 20480 ] && ok "$2 体积 $s < 20480" || bad "$2 体积异常：$s"
  if grep -q '"tag":"note"' "$1" || grep -q '"tag":"action"' "$1"; then
    bad "$2 出现 note/action 标签"
  else
    ok "$2 无 note/action 标签"
  fi
}

echo
echo "=== 1. 默认配置（老配置兼容：只有 webhook/secret）==="
card "$WORK/card-default.json" >/tmp/c1.log 2>&1
rc_is 0 $? "默认配置生成卡片退出 0"
if [ -s "$WORK/card-default.json" ]; then
  ok "卡片已生成"
  band "$WORK/card-default.json" "默认卡片"
  has "**总流量**"            "$WORK/card-default.json" "默认卡片含 overview（总流量）"
  has "**代理 / 直连**"        "$WORK/card-default.json" "默认卡片含 proxy_direct"
  has "**无线 / 有线**"        "$WORK/card-default.json" "默认卡片含 wifi_wired"
  hasnot "**系统**"            "$WORK/card-default.json" "默认 report_items 不含 system（未配置就不发）"
  hasnot "**代理节点**"        "$WORK/card-default.json" "默认 report_items 不含 nodes"
  has '"schema":"2.0"'         "$WORK/card-default.json" "schema=2.0"
  has '"page_size":10'         "$WORK/card-default.json" "table.page_size=10"
  has '"text_size":"notation"' "$WORK/card-default.json" "脚注 plain_text+notation"
  eq 10 "$(grep -o '"host":"' "$WORK/card-default.json" | wc -l | tr -d ' ')" "设备行数 10（Top 10）"
  eq 3  "$(grep -o '"app":"'  "$WORK/card-default.json" | wc -l | tr -d ' ')" "应用行数 3"
  ucode "$FEISHU" check "$WORK/card-default.json" --base "$BASE" >"$WORK/check1.log" 2>&1
  rc_is 0 $? "check 用默认 report_items 校验通过"
fi
# 老配置：UCI 里完全没有新选项
cat > "$WORK/old.config" <<'OLDEOF'
config settings 'settings'
	option enabled '1'
config feishu 'feishu'
	option enabled '1'
	option webhook 'http://127.0.0.1:1/hook'
	option secret 'demo'
OLDEOF
cp "$WORK/old.config" "$CFG"
ucode "$FEISHU" card --base "$BASE" --out "$WORK/card-old.json" >"$WORK/c1b.log" 2>&1
rc_is 0 $? "纯老配置（无任何新选项）生成卡片退出 0"
has "**总流量**" "$WORK/card-old.json" "纯老配置回落到默认 report_items"
has "**代理 / 直连**" "$WORK/card-old.json" "纯老配置默认含 proxy_direct"
ucode "$FEISHU" alerts --base "$BASE" --state "$BASE/state.json" --dry-run >"$WORK/old-alerts.log" 2>&1
rc_is 0 $? "纯老配置跑 alerts 退出 0"
if grep -q "^DRYRUN" "$WORK/old-alerts.log"; then
  bad "纯老配置不应触发任何新告警（实际：$(grep -c '^DRYRUN' "$WORK/old-alerts.log") 条）"
else
  ok "纯老配置不触发任何新告警（阈值全空 = 关闭）"
fi
ucode "$FEISHU" status --base "$BASE" >"$WORK/status-old.log" 2>&1
rc_is 0 $? "纯老配置 status 退出 0"
cp "$WORK/config.bak" "$CFG"

echo
echo "=== 2. 发什么：report_items 组合 ==="
# 2.1 只 overview
card "$WORK/c-overview.json" --items overview >/dev/null 2>&1
has "**总流量**"     "$WORK/c-overview.json" "items=overview：含总流量"
has '"tag":"chart"'  "$WORK/c-overview.json" "items=overview：含折线图"
hasnot "**代理 / 直连**" "$WORK/c-overview.json" "items=overview：不含 proxy_direct"
hasnot "**无线 / 有线**" "$WORK/c-overview.json" "items=overview：不含 wifi_wired"
hasnot '"tag":"table"'   "$WORK/c-overview.json" "items=overview：不含表格"
band "$WORK/c-overview.json" "items=overview"
# 2.2 只 top_apps
card "$WORK/c-apps.json" --items top_apps >/dev/null 2>&1
has '"app":"ws.chatgpt.com"' "$WORK/c-apps.json" "items=top_apps：含应用行"
hasnot '"host":"device-12"'  "$WORK/c-apps.json" "items=top_apps：不含设备表"
hasnot '"tag":"chart"'       "$WORK/c-apps.json" "items=top_apps：不含折线图"
ucode "$FEISHU" check "$WORK/c-apps.json" --items top_apps >/dev/null 2>&1
rc_is 0 $? "check --items top_apps 通过"
# 2.3 proxy_direct + wifi_wired
card "$WORK/c-pw.json" --items proxy_direct,wifi_wired >/dev/null 2>&1
has "**代理 / 直连**" "$WORK/c-pw.json" "items=proxy_direct,wifi_wired：含 proxy_direct"
has "**无线 / 有线**" "$WORK/c-pw.json" "items=proxy_direct,wifi_wired：含 wifi_wired"
hasnot "**总流量**"   "$WORK/c-pw.json" "items=proxy_direct,wifi_wired：不含 overview"
hasnot '"tag":"table"' "$WORK/c-pw.json" "items=proxy_direct,wifi_wired：不含表格"
band "$WORK/c-pw.json" "items=proxy_direct,wifi_wired"
# 2.4 system：有数据 -> 出现；无数据 -> 静默跳过
card "$WORK/c-sys.json" --items overview,system >/dev/null 2>&1
has "**系统**" "$WORK/c-sys.json" "items=system：state.system 存在时渲染系统区块"
has "95%"      "$WORK/c-sys.json" "items=system：CPU 95% 正确带入"
mkfix state "$BASE/state-nosys.json" nosys
ucode "$FEISHU" card --base "$BASE" --state "$BASE/state-nosys.json" --secret demo \
  --items overview,system --out "$WORK/c-nosys.json" >/tmp/c2.log 2>&1
rc_is 0 $? "items=system + 无 system 字段：退出 0（不报错）"
if [ -s "$WORK/c-nosys.json" ]; then
  hasnot "**系统**" "$WORK/c-nosys.json" "state.system 缺失：system 区块自动跳过"
  has "**总流量**"  "$WORK/c-nosys.json" "state.system 缺失：其它区块照常"
else
  bad "state.system 缺失时没有生成卡片"
fi
# 2.5 nodes
card "$WORK/c-nodes.json" --items nodes >/dev/null 2>&1
has "**代理节点**" "$WORK/c-nodes.json" "items=nodes：含节点列表"
has "US2-HY2"      "$WORK/c-nodes.json" "items=nodes：节点名出现"
hasnot '"tag":"table"' "$WORK/c-nodes.json" "items=nodes：不含表格"
# 2.6 未知项 / 空值
card "$WORK/c-bogus.json" --items overview,bogus,nonsense >/tmp/c3.log 2>&1
rc_is 0 $? "未知区块名不报错（退出 0）"
has "**总流量**" "$WORK/c-bogus.json" "未知区块名被忽略，overview 仍在"
rm -f "$WORK/c-none.json"
card "$WORK/c-none.json" --items none >/tmp/c4.log 2>&1
rc_is 0 $? "items=none：退出 0 且不发送"
[ -f "$WORK/c-none.json" ] && bad "items=none 仍然生成了卡片" || ok "items=none 不生成卡片"
grep -q "未启用任何区块" /tmp/c4.log && ok "items=none 有明确的跳过提示" || bad "items=none 缺少提示"
rm -f "$WORK/c-empty.json"
card "$WORK/c-empty.json" --items '' >/tmp/c5.log 2>&1
rc_is 0 $? "items=''（空串）：退出 0"
[ -f "$WORK/c-empty.json" ] && bad "items='' 仍然生成了卡片" || ok "items='' 不生成卡片"
# 2.7 顺序（top_apps 在 top_devices 之前）
card "$WORK/c-order.json" --items top_apps,top_devices,overview >/dev/null 2>&1
A=$(pos '"app":"' "$WORK/c-order.json")
D=$(pos '"host":"' "$WORK/c-order.json")
if [ "$A" -gt 0 ] && [ "$D" -gt 0 ] && [ "$A" -lt "$D" ]; then
  ok "区块按 report_items 顺序渲染（app 表在设备表之前：$A < $D）"
else
  bad "区块顺序不符（app=$A host=$D）"
fi

echo
echo "=== 3. report_items 走 UCI（配置文件真的生效）==="
uci set prism-router.feishu.report_items='overview,nodes' >/dev/null 2>&1
uci commit prism-router >/dev/null 2>&1
card "$WORK/c-uci.json" >/dev/null 2>&1
has "**总流量**"   "$WORK/c-uci.json" "UCI report_items=overview,nodes：含 overview"
has "**代理节点**" "$WORK/c-uci.json" "UCI report_items=overview,nodes：含 nodes"
hasnot "**无线 / 有线**" "$WORK/c-uci.json" "UCI report_items=overview,nodes：不含 wifi_wired"
ucode "$FEISHU" check "$WORK/c-uci.json" --base "$BASE" >/dev/null 2>&1
rc_is 0 $? "check 跟随 UCI report_items"
# uci set 成空串会把选项直接删掉（等于回落默认值），所以关闭要用 'none' 哨兵
uci set prism-router.feishu.report_items='none' >/dev/null 2>&1
uci commit prism-router >/dev/null 2>&1
rm -f "$WORK/c-uci-none.json"
card "$WORK/c-uci-none.json" >/tmp/c6.log 2>&1
rc_is 0 $? "UCI report_items=none：退出 0"
[ -f "$WORK/c-uci-none.json" ] && bad "UCI report_items=none 仍生成卡片" || ok "UCI report_items=none 什么都不发"
# 全部写成无效名字：同样什么都不发（未知项被忽略 -> 0 个区块）
uci set prism-router.feishu.report_items='bogus,nonsense' >/dev/null 2>&1
uci commit prism-router >/dev/null 2>&1
rm -f "$WORK/c-uci-bogus.json"
card "$WORK/c-uci-bogus.json" >/tmp/c7.log 2>&1
rc_is 0 $? "UCI report_items 全为无效名：退出 0"
[ -f "$WORK/c-uci-bogus.json" ] && bad "UCI report_items 全无效仍生成卡片" || ok "UCI report_items 全无效 -> 什么都不发"
grep -q "未启用任何区块" /tmp/c7.log && ok "report_items 无有效区块时有明确提示" || bad "report_items 无有效区块时缺少提示"
# 直接改配置文件写空串：UCI 语义里等同「未设置」-> 回落默认清单（不报错）
cp "$WORK/config.bak" "$CFG"
sed -i "s|^[[:space:]]*option report_items .*|option report_items ''|" "$CFG"
ucode "$FEISHU" status >/tmp/c8.log 2>&1
rc_is 0 $? "配置文件 report_items=''：status 退出 0"
case "$(cat /tmp/c8.log)" in
  *"默认，未显式配置"*) ok "配置文件写空串：UCI 视为未设置，回落默认清单（不报错）";;
  *) bad "配置文件写空串的处理不符合 UCI 语义：$(grep items /tmp/c8.log)";;
esac
cp "$WORK/config.bak" "$CFG"

echo
echo "=== 4. 什么时候发：report_mode / report_time / report_weekday ==="
DOW=$(date +%u)
SHIFT=$(( (1 - DOW + 7) % 7 ))
MON=$(date -d "@$((NOW + SHIFT * 86400))" +%F)
TUE=$(date -d "@$((NOW + (SHIFT + 1) * 86400))" +%F)
sched(){ # $1=描述 $2=期望 due 标记 $3...=参数
  desc=$1; want=$2; shift 2
  out=$(ucode "$FEISHU" scheduled --base "$BASE" --secret demo --dry-run "$@" 2>&1)
  got=0
  case "$out" in *"due=1"*) got=1;; esac
  eq "$want" "$got" "$desc"
  echo "$out" | sed -n 's/^/        /p' | head -2
}
sched "daily @ $TODAY 08:30 -> 到点"       1 --at "$TODAY 08:30" --mode daily  --time 08:30
sched "daily @ $TODAY 08:31 -> 不发"       0 --at "$TODAY 08:31" --mode daily  --time 08:30
sched "daily @ $TODAY 07:59 -> 不发"       0 --at "$TODAY 07:59" --mode daily  --time 08:30
sched "time 写成 8:30 也能解析"             1 --at "$TODAY 08:30" --mode daily  --time 8:30
sched "非法 time 回退 08:30 且不崩"         1 --at "$TODAY 08:30" --mode daily  --time 25:99
sched "weekly @ 周一 $MON 08:30 -> 到点"    1 --at "$MON 08:30" --mode weekly --time 08:30 --weekday 1
sched "weekly @ 周二 $TUE 08:30 -> 不发"    0 --at "$TUE 08:30" --mode weekly --time 08:30 --weekday 1
sched "both  @ 周一 -> 到点"                1 --at "$MON 08:30" --mode both   --time 08:30 --weekday 1
sched "both  @ 周二 -> 到点"                1 --at "$TUE 08:30" --mode both   --time 08:30 --weekday 1
sched "window=0 不覆盖 08:31"               0 --at "$TODAY 08:31" --mode daily  --time 08:30
sched "window=10 覆盖 08:39"                1 --at "$TODAY 08:39" --mode daily  --time 08:30 --window 10
sched "window=10 不覆盖 08:41"              0 --at "$TODAY 08:41" --mode daily  --time 08:30 --window 10
# weekly 的卡片标题应该是「周报」；daily 是「日报」
ucode "$FEISHU" scheduled --base "$BASE" --secret demo --dry-run --at "$MON 08:30" \
  --mode weekly --time 08:30 --weekday 1 --out "$WORK/c-weekly.json" >/dev/null 2>&1
has "流量周报" "$WORK/c-weekly.json" "weekly 到点生成「流量周报」标题"
ucode "$FEISHU" check "$WORK/c-weekly.json" >/dev/null 2>&1
rc_is 0 $? "周报卡片 check 通过（title 允许「流量周报」）"
ucode "$FEISHU" scheduled --base "$BASE" --secret demo --dry-run --at "$TUE 08:30" \
  --mode both --time 08:30 --weekday 1 --out "$WORK/c-both-tue.json" >/dev/null 2>&1
has "流量日报" "$WORK/c-both-tue.json" "both 且非周报日 -> 「流量日报」标题"
# 去重标记：同一 kind+日期只发一次
printf '{"daily":{"day":"%s","ts":1}}\n' "$TODAY" > "$BASE/report-last.json"
out=$(ucode "$FEISHU" scheduled --base "$BASE" --secret demo --dry-run \
      --at "$TODAY 08:30" --mode daily --time 08:30 2>&1)
case "$out" in *"已发送过"*) ok "同日同 kind 已有标记 -> 跳过（窗口内不重复发）";; *) bad "去重标记未生效：$out";; esac
case "$out" in *"due=1"*) ok "去重时仍然报告 due=1（只是不再发送）";; *) bad "去重时未报告 due=1";; esac
rm -f "$BASE/report-last.json"

echo
echo "=== 5. 什么条件下发：阈值触发 / 不触发 ==="
alerts(){ # $@=额外参数；输出在 /tmp/fs-alerts.log
  ucode "$FEISHU" alerts --base "$BASE" --state "${STATE:-$BASE/state.json}" \
    --history "${HIST:-$BASE/history.json}" --daily-dir "$BASE/daily" --dry-run "$@" \
    >/tmp/fs-alerts.log 2>&1
  echo $?
}
fire(){ # $1=kind $2=描述
  if grep -q "kind=$1 " /tmp/fs-alerts.log; then ok "$2"; else bad "$2（未触发 $1）"; fi
}
nofire(){ # $1=kind $2=描述
  if grep -q "kind=$1 " /tmp/fs-alerts.log; then bad "$2（不该触发 $1）"; else ok "$2"; fi
}

rc_is 0 "$(alerts)" "alerts --dry-run 退出 0"
nofire app_limit "阈值全空：应用超限不触发"
alerts --app-limit 20G >/dev/null
fire app_limit "应用阈值 20G：ws.chatgpt.com(20G) 触发"
alerts --app-limit 100G >/dev/null
nofire app_limit "应用阈值 100G：不触发"
HIST="$BASE/history-boost.json"
alerts --spike-ratio 3 >/dev/null
fire spike "突增 3 倍：当前小时 > 7 日均值×3 触发"
alerts --spike-ratio 100 >/dev/null
nofire spike "突增 100 倍：不触发"
HIST=""
alerts --offline-min 10 >/dev/null
fire offline "离线 10 分钟：device-12 离线 60 分钟触发"
alerts --offline-min 120 >/dev/null
nofire offline "离线 120 分钟：不触发"
# state.json 缺失时无法判断离线 -> 静默跳过（采集异常另有告警，避免刷屏）
STATE="$BASE/no-such-state.json"
rc_is 0 "$(alerts --offline-min 10)" "state.json 缺失：离线判定退出 0"
nofire offline "state.json 缺失：离线告警静默跳过"
STATE=""
alerts --cpu 90 >/dev/null
fire sys_cpu "CPU 阈值 90%：95% 触发"
alerts --cpu 99 >/dev/null
nofire sys_cpu "CPU 阈值 99%：不触发"
alerts --mem 40 >/dev/null
fire sys_mem "内存阈值 40%：50% 触发"
alerts --mem 90 >/dev/null
nofire sys_mem "内存阈值 90%：不触发"
alerts --disk 60 >/dev/null
fire sys_disk "磁盘阈值 60%：70% 触发"
alerts --disk 90 >/dev/null
nofire sys_disk "磁盘阈值 90%：不触发"
# state.system 缺失 -> 系统类告警静默跳过
STATE="$BASE/state-nosys.json"
rc_is 0 "$(alerts --cpu 1 --mem 1 --disk 1)" "state.system 缺失：alerts 退出 0（静默跳过）"
STATE=""
nofire sys_cpu "state.system 缺失：CPU 告警静默跳过"
# 走 UCI 的阈值
uci set prism-router.feishu.alert_app_daily_limit='20G' >/dev/null 2>&1
uci set prism-router.feishu.alert_cpu_pct='90' >/dev/null 2>&1
uci commit prism-router >/dev/null 2>&1
alerts >/dev/null
fire app_limit "UCI alert_app_daily_limit=20G 生效"
fire sys_cpu "UCI alert_cpu_pct=90 生效"
cp "$WORK/config.bak" "$CFG"

echo
echo "=== 6. 免打扰时段 ==="
QF=$(date -d "@$((NOW - 3600))" +%H:%M)
QT=$(date -d "@$((NOW + 3600))" +%H:%M)
alerts --app-limit 20G --quiet "$QF-$QT" >/dev/null
if grep -q "免打扰时段" /tmp/fs-alerts.log; then ok "免打扰时段内跳过告警（$QF-$QT）"; else bad "免打扰未生效"; fi
nofire app_limit "免打扰时段内不发送任何告警"
alerts --app-limit 20G --quiet "00:00-00:01" >/dev/null
if grep -q "免打扰时段" /tmp/fs-alerts.log; then bad "不该命中 00:00-00:01 免打扰"; else ok "时段外正常判定（00:00-00:01）"; fi
fire app_limit "时段外告警正常触发"
uci set prism-router.feishu.alert_quiet_hours="$QF-$QT" >/dev/null 2>&1
uci commit prism-router >/dev/null 2>&1
alerts --app-limit 20G >/dev/null
if grep -q "免打扰时段" /tmp/fs-alerts.log; then ok "UCI alert_quiet_hours 生效"; else bad "UCI 免打扰未生效"; fi
cp "$WORK/config.bak" "$CFG"
# 报表不受免打扰影响
out=$(ucode "$FEISHU" scheduled --base "$BASE" --secret demo --dry-run \
      --at "$TODAY 08:30" --mode daily --time 08:30 --quiet "00:00-23:59" 2>&1)
case "$out" in *"due=1"*) ok "免打扰不影响报表（scheduled 仍 due=1）";; *) bad "免打扰影响了报表：$out";; esac

echo
echo "=== 7. 卡片体积 / 标签 / check 全组合 ==="
for items in "overview" "proxy_direct,wifi_wired" "system" "nodes" "top_devices" "top_apps" \
             "overview,proxy_direct,wifi_wired,system,top_devices,top_apps,nodes"; do
  f="$WORK/c-$(echo "$items" | tr ',' '_').json"
  card "$f" --items "$items" >/dev/null 2>&1
  if [ -s "$f" ]; then
    s=$(sz "$f")
    [ "$s" -lt 20480 ] && ok "items=$items：$s 字节 < 20480" || bad "items=$items：$s 字节超限"
    if grep -q '"tag":"note"' "$f" || grep -q '"tag":"action"' "$f"; then
      bad "items=$items：出现 note/action"
    else
      ok "items=$items：无 note/action"
    fi
    ucode "$FEISHU" check "$f" --items "$items" >/dev/null 2>&1 \
      && ok "items=$items：check 通过" || bad "items=$items：check 失败"
  else
    bad "items=$items：卡片未生成"
  fi
done

echo
echo "=== 8. 自检与状态 ==="
ucode "$FEISHU" selftest >/tmp/fs-selftest.log 2>&1
rc_is 0 $? "selftest 退出 0"
SPAS=$(grep -c "PASS" /tmp/fs-selftest.log)
SFAIL=$(grep -c "FAIL" /tmp/fs-selftest.log)
[ "$SFAIL" -eq 0 ] && ok "selftest 0 项失败" || { bad "selftest 有 $SFAIL 项失败"; tail -5 /tmp/fs-selftest.log; }
[ "$SPAS" -ge 60 ] && ok "selftest 断言数 $SPAS（>=60，未退化）" || bad "selftest 断言数只有 $SPAS"
ucode "$FEISHU" status --base "$BASE" >/tmp/fs-status.log 2>&1
rc_is 0 $? "status 退出 0"
has "items" /tmp/fs-status.log "status 显示 report_items"
has "report" /tmp/fs-status.log "status 显示 report_mode/time/weekday"
has "alert+" /tmp/fs-status.log "status 显示新增告警阈值"
# 旧的离线自测脚本（打包自带）仍然全绿
if [ -x /usr/share/prism-router/feishu-test.sh ]; then
  sh /usr/share/prism-router/feishu-test.sh >/tmp/fs-legacy.log 2>&1
  LRC=$?
  if [ "$LRC" -eq 0 ]; then
    ok "feishu-test.sh（打包自带的离线自测）全绿：$(grep '结果：PASS' /tmp/fs-legacy.log | head -1)"
  else
    bad "feishu-test.sh 失败"
    grep -E "FAIL" /tmp/fs-legacy.log | head -8
  fi
fi

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
