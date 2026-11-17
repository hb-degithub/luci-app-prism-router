#!/bin/sh
# 设备别名/分组 · 月配额 · 导出（CSV/JSON + Prometheus）· 陌生设备标记 —— 容器内用例
# 由 tests/container-validate-features.sh 调用（隔离容器，--network none）。
#
# 覆盖：
#   1. 安装两个包后 /etc /usr /www /www/cgi-bin 权限不变；新配置项与文件权限；ucode 语法
#   2. devices.json：set_device_meta 往返（大写/短横线 MAC 归一）、原子写、0644 root:root、
#      清空字段、非法 MAC 拒绝、控制字符清洗、超长截断、坏文件不崩
#   3. 月配额：get_state 的 month_rx/month_tx/month_total + totals.month_total；
#      当月边界（上月文件不计、未来日期不计、坏文件跳过、无 devices 行时用 totals 兜底）
#   4. 配额配置：none/device/total、小数 GB、非法值回落、空值 = 不限
#   5. first_seen：守护进程记录新 MAC、不覆盖已有 first_seen / alias / group、重复运行幂等、
#      坏 devices.json 自愈为合法 JSON
#   6. export_csv devices/apps/daily：UTF-8 BOM、CRLF、表头、RFC4180 转义（逗号/引号/换行）、
#      公式注入防护、行数、文件名、坏文件跳过、非法 what
#   7. Prometheus CGI：未启用/未配 token/错 token -> 403；?token= 与 Bearer -> 200；
#      POST -> 405；文本格式逐行校验（HELP/TYPE/样本/标签转义/无重复序列/无科学计数法）；
#      state.json 缺失或损坏 -> 200 且只有 up/info；devices.json 坏 -> 标签为空
#   8. 向后兼容：get_state 原字段齐全、无元数据时不出现新键、state.json 不含新字段、
#      status/get_history/get_daily/get_nodes/get_stations 仍可用、get_state 体积 < 180KiB
#   9. ACL 白名单、set_config 新字段放行、未知字段拒绝
#
# 隔离：不访问外网、不碰真机；全部数据落在容器 /tmp 与 /etc（容器内）。
mkdir -p /var/run/ubus /var/lock /tmp

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
CGET(){ uci -q get "$1" 2>/dev/null; }
cfg_commit(){ uci commit prism-router >/dev/null 2>&1; }
jget(){ # $1=file $2=ucode 单个表达式（d = 解析后的对象）；其余参数是额外 env
  local f="$1" expr="$2"; shift 2
  env F="$f" "$@" ucode -e "let fs=require('fs'); let d=json(fs.readfile(getenv('F'))); print($expr);" 2>/dev/null
}
jrun(){ # $1=file $2=ucode 语句块（自己 print）；其余参数是额外 env
  local f="$1" code="$2"; shift 2
  env F="$f" "$@" ucode -e "let fs=require('fs'); let d=json(fs.readfile(getenv('F'))); $code" 2>/dev/null
}

ROOT=/tmp/ft
STATE=$ROOT/state/state.json
DAILY=$ROOT/daily
DEVMETA=$ROOT/devices.json
RPCD=/usr/share/rpcd/ucode/prism-router.uc
METRICS_CGI=/www/cgi-bin/prism-router-metrics
mkdir -p "$ROOT"

TODAY=$(date +%Y-%m-%d); MON=$(date +%Y-%m)
DAY=$(date +%d)
YDAY=$(date -d "@$(( $(date +%s) - 86400 ))" +%Y-%m-%d 2>/dev/null || echo "")
YDAY_MON=${YDAY%-*}
PREV=$(date -d "@$(( $(date +%s) - 40 * 86400 ))" +%Y-%m 2>/dev/null || echo "1999-01")

M190=dc:56:7b:89:fb:31
M115=70:70:fc:07:11:13

# rpcd 调用（测试钩子把状态/日汇总/元数据三个路径指向 fixture）
rpc(){ # $1=method [$2=args json]
  env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$DAILY" \
      PRISM_ROUTER_DEVICES_FILE="$DEVMETA" \
      PRISM_ROUTER_METHOD="$1" PRISM_ROUTER_ARGS="${2:-}" \
      ucode -L /usr/lib/ucode "$RPCD" 2>>"$ROOT/rpc.err"
}
export_rpc(){ # $1=what
  env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$DAILY" \
      PRISM_ROUTER_DEVICES_FILE="$DEVMETA" \
      PRISM_ROUTER_METHOD=export_csv PRISM_ROUTER_ARGS="{\"what\":\"$1\"}" \
      ucode -L /usr/lib/ucode "$RPCD" 2>>"$ROOT/rpc.err"
}
field(){ sed -n "s/^$1=//p" "$ROOT/gs.txt" 2>/dev/null | head -1; }
csv_of(){ # $1=export_json $2=输出文件：把 JSON 里的 csv 文本原样落盘（检查转义用）
  env F="$1" O="$2" ucode -e 'let fs=require("fs"); fs.writefile(getenv("O"), json(fs.readfile(getenv("F"))).csv);' 2>/dev/null
}

cat > "$ROOT/gs.uc" <<'GSUC'
'use strict';
let fs = require('fs');
let d = json(fs.readfile(getenv('F')));
function p(k, v) { print(sprintf('%s=%s\n', k, (v == null) ? 'MISSING' : `${v}`)); }
p('totals.month_total', d?.totals?.month_total);
p('quota.mode', d?.quota?.mode);
p('quota.monthly_gb', d?.quota?.monthly_gb);
p('quota.total_gb', d?.quota?.total_gb);
p('quota.device_limit', d?.quota?.device_limit);
p('quota.total_limit', d?.quota?.total_limit);
p('quota.period', d?.quota?.period);
p('n.devices', length(d?.devices ?? []));
let i = 0;
for (let x in (d?.devices ?? [])) {
	i++;
	p(sprintf('dev.%d.mac', i), x.mac);
	p(sprintf('dev.%d.hostname', i), x.hostname);
	p(sprintf('dev.%d.month_rx', i), x.month_rx);
	p(sprintf('dev.%d.month_tx', i), x.month_tx);
	p(sprintf('dev.%d.month_total', i), x.month_total);
	p(sprintf('dev.%d.has_alias', i), (x.alias != null) ? 1 : 0);
	p(sprintf('dev.%d.alias', i), x.alias);
	p(sprintf('dev.%d.has_group', i), (x.group != null) ? 1 : 0);
	p(sprintf('dev.%d.group', i), x.group);
	p(sprintf('dev.%d.first_seen', i), x.first_seen);
	p(sprintf('dev.%d.quota_limit', i), x.quota_limit);
	p(sprintf('dev.%d.keys_old', i), length(filter(keys(x), k => k == 'ip' || k == 'mac'
		|| k == 'hostname' || k == 'link' || k == 'direct_rx' || k == 'direct_tx'
		|| k == 'proxy_rx' || k == 'proxy_tx' || k == 'rx_rate' || k == 'tx_rate'
		|| k == 'last_seen' || k == 'apps')));
	p(sprintf('dev.%d.keys_all', i), length(keys(x)));
}
GSUC

get_state(){ rpc get_state > "$ROOT/gs.json"; F="$ROOT/gs.json" ucode "$ROOT/gs.uc" > "$ROOT/gs.txt"; }
dev_by_mac(){ # $1=mac（空串=无 MAC 的设备） $2=field
  local i=1
  while [ "$i" -le 6 ]; do
    if [ "$(field "dev.$i.mac")" = "$1" ]; then field "dev.$i.$2"; return 0; fi
    i=$((i+1))
  done
  echo "NOTFOUND"
}

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin 2>/dev/null)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=${B_CGI:-无}"

echo "=== 1. 安装两个包 ==="
# 严格依赖安装：不使用 --force-depends。前端已改用内置 SVG，不再依赖
# luci-lib-chartjs；其余依赖 deps 镜像都有，所以不需要任何占位包。
opkg install /src/dist/prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 && ok "安装 prism-router（严格依赖）" || { bad "安装 prism-router"; tail -5 /tmp/i1.log; }
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i2.log 2>&1 && ok "安装 luci-app-prism-router（严格依赖）" || { bad "安装 luci-app"; tail -5 /tmp/i2.log; }

echo "=== 2. 新配置项 / 文件落位 / 权限 / 语法 ==="
for k in quota_mode quota_monthly_gb quota_total_gb metrics_enabled metrics_token; do
  grep -q "option $k" /etc/config/prism-router && ok "config 含 $k" || bad "config 缺少 $k"
done
grep -q "option quota_mode 'none'" /etc/config/prism-router && ok "quota_mode 默认 none" || bad "quota_mode 默认值不对"
grep -q "option metrics_enabled '0'" /etc/config/prism-router && ok "metrics_enabled 默认 0（默认关闭）" || bad "metrics_enabled 默认值不对"
check /usr/bin/prism-routerd "root:root -rwxr-xr-x"
check /usr/share/rpcd/ucode/prism-router.uc "root:root -rw-r--r--"
check "$METRICS_CGI" "root:root -rwxr-xr-x"
check /etc/prism-router "root:root drwxr-xr-x"
ucode -c /usr/bin/prism-routerd && ok "prism-routerd 语法 OK" || bad "prism-routerd 语法错误"
ucode -c "$RPCD" && ok "rpcd uc 语法 OK" || bad "rpcd uc 语法错误"
ucode -c "$METRICS_CGI" && ok "metrics CGI 语法 OK" || bad "metrics CGI 语法错误"

echo "=== 3. 系统目录权限未被改动（回归核心）==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin 2>/dev/null)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 4. fixtures：state.json + daily/（当月 / 上月 / 当天）==="
rm -rf "$ROOT/state" "$DAILY" "$DEVMETA" "$ROOT/rpc.err"
mkdir -p "$ROOT/state" "$DAILY"
NOW=$(date +%s)
F="$STATE" NOW="$NOW" M190="$M190" M115="$M115" ucode -e '
let fs = require("fs");
let now = int(getenv("NOW"));
let d = {
  ts: now, uptime: 3600,
  source: { clash: "ok", conntrack: "ok" },
  totals: { direct_rx: 1000, direct_tx: 100, proxy_rx: 5000, proxy_tx: 500,
            wifi_rx: 1, wifi_tx: 1, wired_rx: 1, wired_tx: 1, unknown_rx: 1, unknown_tx: 1,
            rx_rate: 24000, tx_rate: 1200 },
  nodes: {},
  devices: [
    { ip: "192.168.100.190", mac: getenv("M190"), hostname: "laptop", link: "wifi",
      direct_rx: 1000, direct_tx: 100, proxy_rx: 5000, proxy_tx: 500,
      rx_rate: 24000, tx_rate: 1200, last_seen: now - 10, apps: {} },
    { ip: "192.168.100.115", mac: getenv("M115"), hostname: "a\"b\\c", link: "wired",
      direct_rx: 10, direct_tx: 1, proxy_rx: 50, proxy_tx: 5,
      rx_rate: 0, tx_rate: 0, last_seen: now - 10, apps: {} },
    { ip: "192.168.100.183", mac: "", hostname: "ip-only", link: "unknown",
      direct_rx: 120, direct_tx: 0, proxy_rx: 0, proxy_tx: 0,
      rx_rate: 0, tx_rate: 0, last_seen: now - 10, apps: {} }
  ],
  apps: [ { host: "ws.chatgpt.com", rx: 90000, tx: 5000, chain: "US2", devices: 2 },
          { host: "a,b.example", rx: 10, tx: 1, chain: "DIRECT", devices: 1 } ],
  system: { cpu_pct: 4.6, cpu_cores: 4, load1: 0.2, load5: 1.3, load15: 2.8,
            mem_total: 4294967296, mem_avail: 3221225472, mem_pct: 25.0,
            disk_total: 1073741824, disk_used: 268435456, disk_pct: 25.0,
            temp_c: 42.9, uptime: 123456, wan_rx_rate: 10000, wan_tx_rate: 1000 },
  health: { accounting_confidence: "exact", reasons: [] }
};
fs.writefile(getenv("F"), sprintf("%J", d));
'

write_one(){ # $1=文件名 $2=rx $3=tx
  cat > "$DAILY/$1" <<JSON
{"day":"${1%.json}","totals":{"rx":$2,"tx":$3},"devices":[
 {"ip":"192.168.100.190","mac":"dc:56:7b:89:fb:31","hostname":"laptop","rx":$2,"tx":$3}]}
JSON
}
write_multi(){ # $1=文件名：三台设备
  cat > "$DAILY/$1" <<JSON
{"day":"${1%.json}","totals":{"rx":1030,"tx":103},"devices":[
 {"ip":"192.168.100.190","mac":"dc:56:7b:89:fb:31","hostname":"laptop","rx":600,"tx":60},
 {"ip":"192.168.100.115","mac":"70:70:fc:07:11:13","hostname":"hb","rx":400,"tx":40},
 {"ip":"192.168.100.183","mac":"","hostname":"ip-only","rx":30,"tx":3}]}
JSON
}

write_one "$TODAY.json" 300 30
if [ -n "$YDAY" ] && [ "$YDAY_MON" = "$MON" ]; then
  write_multi "$YDAY.json"
  YDAY_IN_MONTH=1
else
  YDAY_IN_MONTH=0
fi
write_one "$PREV-15.json" 999999 99999
echo "  today=$TODAY yday=${YDAY:-无}(同月=$YDAY_IN_MONTH) prev=$PREV-15"
ls "$DAILY" | tr '\n' ' '; echo

echo "=== 5. 月配额计算：只算当月（1 号至今）==="
get_state
if [ "$YDAY_IN_MONTH" = "1" ]; then
  # 当月两份：今天 190=300/30；昨天 190=600/60、115=400/40、183=30/3
  EXP_MONTH_RX=1330; EXP_MONTH_TX=133        # 300+600+400+30 / 30+60+40+3
  EXP_190_RX=900; EXP_190_TX=90
  EXP_115_RX=400; EXP_115_TX=40
  EXP_183_RX=30;  EXP_183_TX=3
else
  EXP_MONTH_RX=300; EXP_MONTH_TX=30          # 月初：昨天的文件属于上月，必须不计
  EXP_190_RX=300; EXP_190_TX=30
  EXP_115_RX=0; EXP_115_TX=0
  EXP_183_RX=0; EXP_183_TX=0
fi
EXP_MONTH_TOTAL=$((EXP_MONTH_RX + EXP_MONTH_TX))
echo "  期望：rx=$EXP_MONTH_RX tx=$EXP_MONTH_TX total=$EXP_MONTH_TOTAL"
[ "$(field totals.month_total)" = "$EXP_MONTH_TOTAL" ] \
  && ok "totals.month_total=$EXP_MONTH_TOTAL（上月 999999/99999 已排除）" \
  || bad "totals.month_total=$(field totals.month_total) 期望 $EXP_MONTH_TOTAL"
[ "$(field quota.period)" = "$MON" ] && ok "quota.period=$MON" || bad "quota.period=$(field quota.period) 期望 $MON"
[ "$(field n.devices)" = "3" ] && ok "devices 3 台" || bad "devices=$(field n.devices) 期望 3"
[ "$(dev_by_mac "$M190" month_rx)" = "$EXP_190_RX" ] && ok "190 month_rx=$EXP_190_RX" || bad "190 month_rx=$(dev_by_mac "$M190" month_rx) 期望 $EXP_190_RX"
[ "$(dev_by_mac "$M190" month_tx)" = "$EXP_190_TX" ] && ok "190 month_tx=$EXP_190_TX" || bad "190 month_tx=$(dev_by_mac "$M190" month_tx) 期望 $EXP_190_TX"
[ "$(dev_by_mac "$M190" month_total)" = "$((EXP_190_RX + EXP_190_TX))" ] && ok "190 month_total 正确" || bad "190 month_total=$(dev_by_mac "$M190" month_total)"
[ "$(dev_by_mac "$M115" month_rx)" = "$EXP_115_RX" ] && ok "115 month_rx=$EXP_115_RX" || bad "115 month_rx=$(dev_by_mac "$M115" month_rx) 期望 $EXP_115_RX"
[ "$(dev_by_mac "" month_rx)" = "$EXP_183_RX" ] && ok "无 MAC 设备按 IP 回退匹配：month_rx=$EXP_183_RX" || bad "无 MAC 设备 month_rx=$(dev_by_mac "" month_rx) 期望 $EXP_183_RX"
DSUM=0; j=1
while [ "$j" -le 3 ]; do DSUM=$((DSUM + $(field "dev.$j.month_total"))); j=$((j+1)); done
[ "$DSUM" = "$EXP_MONTH_TOTAL" ] && ok "三台设备 month_total 之和 == totals.month_total ($DSUM)" || bad "设备合计 $DSUM != totals $(field totals.month_total)"

echo "=== 6. 当月边界：totals 兜底 / 坏 JSON / 未来日期 / 目录缺失 ==="
mkdir -p "$ROOT/daily_b" "$ROOT/daily_c" "$ROOT/daily_d"
printf '{"day":"%s","totals":{"rx":50,"tx":5}}\n' "$TODAY" > "$ROOT/daily_b/$TODAY.json"   # 没有 devices 行
printf 'this is definitely not json\n' > "$ROOT/daily_c/$MON-01.json"                      # 坏 JSON
write_one "$MON-31.json" 777777 77777
mv "$DAILY/$MON-31.json" "$ROOT/daily_d/$MON-31.json"                                      # 未来日期

probe_month(){ # $1=每日目录 -> 打印 month_total
  env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$1" \
      PRISM_ROUTER_DEVICES_FILE="$DEVMETA" PRISM_ROUTER_METHOD=get_state PRISM_ROUTER_ARGS='{}' \
      ucode -L /usr/lib/ucode "$RPCD" > "$ROOT/probe.json" 2>>"$ROOT/rpc.err"
  jget "$ROOT/probe.json" 'd.totals.month_total'
}
[ "$(probe_month "$ROOT/daily_b")" = "55" ] && ok "无 devices 行时用 totals 兜底（50+5=55）" || bad "totals 兜底 = $(probe_month "$ROOT/daily_b") 期望 55"
[ "$(probe_month "$ROOT/daily_c")" = "0" ] && ok "坏 JSON 被跳过（month_total=0，不崩）" || bad "坏 JSON 处理 = $(probe_month "$ROOT/daily_c")"
if [ "$DAY" != "31" ]; then
  [ "$(probe_month "$ROOT/daily_d")" = "0" ] && ok "未来日期文件（$MON-31）不计入当月" || bad "未来日期被计入：$(probe_month "$ROOT/daily_d")"
else
  ok "今天是 31 号，跳过未来日期用例"
fi
R=$(probe_month "$ROOT/no-such-dir")
R2=$(jget "$ROOT/probe.json" 'sprintf("%d|%d", length(d.devices), d.totals.direct_rx)')
[ "$R|$R2" = "0|3|1000" ] && ok "daily 目录缺失：month_total=0 且其余字段不变" || bad "daily 目录缺失：$R|$R2"

echo "=== 7. 配额配置：none / device / total / 小数 / 非法 / 空 ==="
quota_probe(){ # $1=mode $2=monthly $3=total -> "mode|device_limit|total_limit|带 quota_limit 的设备数"
  UCI set "prism-router.settings.quota_mode=$1"
  UCI set "prism-router.settings.quota_monthly_gb=$2"
  UCI set "prism-router.settings.quota_total_gb=$3"
  cfg_commit
  rpc get_state > "$ROOT/gq.json" 2>/dev/null
  jget "$ROOT/gq.json" 'sprintf("%s|%s|%s|%d", d.quota.mode, d.quota.device_limit, d.quota.total_limit, length(filter(d.devices, x => x.quota_limit != null)))'
}
R=$(quota_probe none '' '');       [ "$R" = "none|0|0|0" ] && ok "mode=none：无限制（$R）" || bad "mode=none -> $R"
R=$(quota_probe device 10 '');     [ "$R" = "device|10737418240|0|3" ] && ok "mode=device 10GB：device_limit=10GiB，3 台都有 quota_limit" || bad "mode=device -> $R"
R=$(quota_probe device 0.5 '');    [ "$R" = "device|536870912|0|3" ] && ok "小数 0.5GB -> 536870912 字节" || bad "0.5GB -> $R"
R=$(quota_probe total '' 1.5);     [ "$R" = "total|0|1610612736|0" ] && ok "mode=total 1.5GB：total_limit=1610612736，设备不带 quota_limit" || bad "mode=total -> $R"
R=$(quota_probe total '' '');      [ "$R" = "total|0|0|0" ] && ok "mode=total 但 total_gb 空 -> 0（不限）" || bad "total 空 -> $R"
R=$(quota_probe bogus 5 '');       [ "$R" = "none|0|0|0" ] && ok "非法 mode -> none" || bad "非法 mode -> $R"
R=$(quota_probe device abc '');    [ "$R" = "device|0|0|0" ] && ok "非数字 GB -> 0（不猜）" || bad "非数字 GB -> $R"
R=$(quota_probe device -5 '');     [ "$R" = "device|0|0|0" ] && ok "负数 GB -> 0" || bad "负数 GB -> $R"
UCI set prism-router.settings.quota_mode='none'; UCI set prism-router.settings.quota_monthly_gb=''
UCI set prism-router.settings.quota_total_gb=''; cfg_commit

echo "=== 8. 别名 / 分组：set_device_meta 往返 ==="
R=$(rpc set_device_meta '{"mac":"DC-56-7B-89-FB-31","alias":"客厅电视","group":"家人"}')
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "大写+短横线 MAC 归一后写入成功" || bad "set_device_meta 返回 $R"
grep -q "$M190" "$DEVMETA" && ok "devices.json 用小写冒号 MAC 作键" || bad "devices.json 键格式不对"
check "$DEVMETA" "root:root -rw-r--r--"
[ -z "$(ls "$ROOT" | grep 'devices.json.tmp' || true)" ] && ok "无 .tmp 残留（原子写）" || bad "残留临时文件：$(ls "$ROOT" | grep tmp)"
R=$(rpc set_device_meta '{"mac":"70:70:fc:07:11:13","alias":"hb,plus","group":"家人"}')
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "第二台设备写入成功" || bad "第二台写入失败：$R"
get_state
[ "$(dev_by_mac "$M190" alias)" = "客厅电视" ] && ok "get_state 回读 alias=客厅电视" || bad "alias 回读 $(dev_by_mac "$M190" alias)"
[ "$(dev_by_mac "$M190" group)" = "家人" ] && ok "get_state 回读 group=家人" || bad "group 回读 $(dev_by_mac "$M190" group)"
[ "$(dev_by_mac "$M115" alias)" = "hb,plus" ] && ok "含逗号的别名原样保存（CSV 转义在导出侧做）" || bad "逗号别名 $(dev_by_mac "$M115" alias)"
[ "$(dev_by_mac "$M115" has_alias)" = "1" ] && ok "有别名时 devices[] 带 alias 键" || bad "device 缺 alias 键"
[ "$(dev_by_mac "" has_alias)" = "0" ] && ok "没有元数据的设备不带 alias 键" || bad "无名设备竟然有 alias"
R=$(rpc set_device_meta '{"mac":"'"$M190"'","alias":"","group":"家人"}')
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "alias 空串 = 清除" || bad "清除 alias 失败：$R"
get_state
[ "$(dev_by_mac "$M190" has_alias)" = "0" ] && ok "清除后 devices[] 不再有 alias 键" || bad "alias 未清除"
[ "$(dev_by_mac "$M190" group)" = "家人" ] && ok "只清 alias 时 group 保留" || bad "group 被误清 $(dev_by_mac "$M190" group)"
rpc set_device_meta '{"mac":"'"$M190"'","alias":"","group":""}' >/dev/null
grep -q "$M190" "$DEVMETA" && bad "清空后 devices.json 仍有空壳记录" || ok "三个字段都空 -> 整条记录删除"
R=$(rpc set_device_meta '{"mac":"not-a-mac","alias":"x"}')
echo "$R" | grep -q 'invalid mac' && ok "非法 MAC 被拒" || bad "非法 MAC 未拒：$R"
R=$(rpc set_device_meta '{"mac":"'"$M190"'"}')
echo "$R" | grep -q 'nothing to update' && ok "既不传 alias 也不传 group -> 拒绝（不写空）" || bad "空更新未拒：$R"
R=$(rpc set_device_meta '{"mac":"'"$M190"'","alias":"x","group":null}')
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "group 显式 null = 不改" || bad "null group 处理失败：$R"
rpc set_device_meta '{"mac":"'"$M190"'","alias":"a\nb\tc","group":"家人"}' >/dev/null
get_state
[ "$(dev_by_mac "$M190" alias)" = "abc" ] && ok '别名里的 \n \t 被清洗（a\nb\tc -> abc）' || bad "控制字符未清洗：$(dev_by_mac "$M190" alias)"
LONG=$(printf 'a%.0s' $(seq 1 300))
rpc set_device_meta "{\"mac\":\"$M190\",\"alias\":\"$LONG\"}" >/dev/null
ALEN=$(jget "$DEVMETA" "length(d[getenv('M')]?.alias ?? '')" M="$M190")
[ "$ALEN" = "128" ] && ok "超长别名截断到 128 字节" || bad "超长别名长度 $ALEN 期望 128"

echo "=== 8.5 devices.json 容错：坏文件 / 非法条目 / 超长 / 超大 ==="
WEIRD=$ROOT/devices_weird.json
printf 'garbage { not json\n' > "$WEIRD"
env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$DAILY" \
    PRISM_ROUTER_DEVICES_FILE="$WEIRD" PRISM_ROUTER_METHOD=get_state PRISM_ROUTER_ARGS='{}' \
    ucode -L /usr/lib/ucode "$RPCD" > "$ROOT/gw.json" 2>"$ROOT/gw.err"
R=$(jget "$ROOT/gw.json" 'sprintf("%d|%d", length(d.devices), length(filter(d.devices, x => x.alias != null)))')
[ "$R" = "3|0" ] && ok "devices.json 损坏：get_state 仍返回 3 台设备、无 alias 键（不崩）" || bad "坏 devices.json：$R"
LONGVAL=$(printf 'b%.0s' $(seq 1 300))
cat > "$WEIRD" <<JSON
{"zz:zz:zz:zz:zz:zz":{"alias":"非法 MAC 键"},"not-an-object":1,"$M190":{"alias":"$LONGVAL","group":"g","first_seen":"abc","extra":"ignored"},"$M115":{"alias":123,"group":"x","first_seen":-5}}
JSON
env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$DAILY" \
    PRISM_ROUTER_DEVICES_FILE="$WEIRD" PRISM_ROUTER_METHOD=get_state PRISM_ROUTER_ARGS='{}' \
    ucode -L /usr/lib/ucode "$RPCD" > "$ROOT/gw2.json" 2>>"$ROOT/gw.err"
R=$(jget "$ROOT/gw2.json" 'sprintf("%d|%d|%s|%s", length(d.devices), length(filter(d.devices, x => x.alias != null)), length(d.devices[0].alias ?? ""), (d.devices[0].first_seen ?? "MISSING"))')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "3" ] && ok "非法条目被忽略，仍返回 3 台设备" || bad "非法条目容错：$1 台"
[ "$2" = "2" ] && ok "只有合法 MAC 的条目生效（非法 MAC 键/非对象条目被丢弃）" || bad "生效条目数 $2 期望 2"
[ "$3" = "128" ] && ok "别名按 128 字节截断（UTF-8 安全）" || bad "别名长度 $3 期望 128"
[ "$4" = "MISSING" ] && ok "非法 first_seen（字符串/负数）被丢弃，不输出" || bad "first_seen=$4 应省略"
env PRISM_ROUTER_DEVICES_FILE="$WEIRD" PRISM_ROUTER_METHOD=set_device_meta \
    PRISM_ROUTER_ARGS='{"mac":"'"$M190"'","alias":"读-改-写保留","group":"g"}' \
    ucode -L /usr/lib/ucode "$RPCD" > "$ROOT/gw_rw.json" 2>>"$ROOT/rpc.err"
R=$(F="$WEIRD" M="$M190" ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  print(sprintf("%d|%s|%s|%s", length(keys(d)), d[getenv("M")].alias,
    (d[getenv("M")].first_seen == null) ? "-" : "has", (d["zz:zz:zz:zz:zz:zz"] == null) ? "gone" : "kept"));' 2>/dev/null)
[ "$R" = "2|读-改-写保留|-|gone" ] && ok "读-改-写：非法键被清掉、别名原样写回、非法 first_seen 不复活" || bad "读-改-写结果 $R"
# 1100 条记录（超过 rpcd 的 1024 读取上限）也不能崩
F="$WEIRD" ucode -e '
let fs=require("fs"); let o={};
for (let i = 0; i < 1100; i++) o[sprintf("%02x:%02x:00:00:00:00", int(i / 256), i % 256)] = { alias: sprintf("dev-%d", i) };
fs.writefile(getenv("F"), sprintf("%J", o));' 2>/dev/null
env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$DAILY" \
    PRISM_ROUTER_DEVICES_FILE="$WEIRD" PRISM_ROUTER_METHOD=get_state PRISM_ROUTER_ARGS='{}' \
    ucode -L /usr/lib/ucode "$RPCD" > "$ROOT/gw3.json" 2>>"$ROOT/gw.err"
R=$(jget "$ROOT/gw3.json" 'sprintf("%d|%d", length(d.devices), length(d.quota ? keys(d.quota) : []))')
[ "$R" = "3|6" ] && ok "1100 条 devices.json 仍正常返回（读取上限内）" || bad "超大 devices.json：$R"
[ -s "$ROOT/rpc.err" ] && bad "rpcd 调试入口有 stderr 输出：$(head -2 "$ROOT/rpc.err")" || ok "rpcd 全程无异常输出"

echo "=== 9. first_seen：守护进程记录首次出现 ==="
cp -f /fixtures/dhcp.leases /tmp/dhcp.leases 2>/dev/null
UCI set prism-router.settings.lan_ranges='192.168.100.0/24'; cfg_commit
DM2=$ROOT/devices_daemon.json
OLDDEV=aa:bb:cc:dd:ee:ff
printf '{"%s":{"alias":"老设备","group":"家人","first_seen":1000}}\n' "$OLDDEV" > "$DM2"
run_daemon(){ # $1=state dir
  env PRISM_ROUTER_ONCE=1 PRISM_ROUTER_STATE_DIR="$1" PRISM_ROUTER_DAILY_DIR="$ROOT/daily_run" \
      PRISM_ROUTER_DEVICES_FILE="$DM2" PRISM_ROUTER_CONNTRACK_FILE=/fixtures/nf_conntrack \
      PRISM_ROUTER_CLASH_API=127.0.0.1:1 ucode /usr/bin/prism-routerd >"$1.log" 2>&1
}
rm -rf "$ROOT/run1"
run_daemon "$ROOT/run1" && ok "守护进程 --once 退出码 0" || { bad "守护进程退出码非 0"; tail -5 "$ROOT/run1.log"; }
check "$DM2" "root:root -rw-r--r--"
R=$(jget "$DM2" 'type(d) == "object" ? "json" : "bad"')
[ "$R" = "json" ] && ok "守护进程写出的 devices.json 是合法 JSON" || bad "devices.json 不是合法 JSON"
R=$(jget "$DM2" 'sprintf("%d|%s|%s", d[getenv("M")].first_seen, d[getenv("M")].alias, d[getenv("M")].group)' M="$OLDDEV")
[ "$R" = "1000|老设备|家人" ] && ok "已有 first_seen / alias / group 原样保留（$R）" || bad "已有元数据被覆盖：$R"
[ -z "$(ls "$ROOT" | grep 'devices_daemon.json.tmp' || true)" ] && ok "守护进程写入无 .tmp 残留" || bad "守护进程残留临时文件"
STAMP=$(jget "$DM2" 'd[getenv("M")]?.first_seen' M="$M115")
NOW2=$(date +%s)
if [ -n "$STAMP" ] && [ "$STAMP" -gt 1700000000 ] 2>/dev/null && [ "$STAMP" -le "$NOW2" ]; then
  ok "新设备 first_seen=$STAMP（unix 秒，落盘持久化）"
else
  bad "新设备 first_seen=${STAMP:-空} 不合法（now=$NOW2）"
fi
cp -f "$DM2" "$ROOT/dm2.before"
rm -rf "$ROOT/run2"
run_daemon "$ROOT/run2"
cmp -s "$ROOT/dm2.before" "$DM2" && ok "重复运行不重写 first_seen（幂等）" || bad "重复运行改动了 devices.json"
printf 'broken { json\n' > "$DM2"
rm -rf "$ROOT/run3"
run_daemon "$ROOT/run3" && ok "devices.json 损坏时守护进程不崩（退出码 0）" || bad "devices.json 损坏导致退出码非 0"
R=$(jget "$DM2" 'type(d) == "object" ? "json" : "bad"')
[ "$R" = "json" ] && ok "坏文件被重建为合法 JSON" || bad "坏文件未被重建"

echo "=== 10. export_csv devices ==="
get_state >/dev/null 2>&1
export_rpc devices > "$ROOT/csv_dev.json"
R=$(jrun "$ROOT/csv_dev.json" 'let l = split(d.csv, "\r\n"); print(sprintf("%s|%s|%s|%s|%s", (d.ok==true)?"1":"0", (ord(substr(d.csv,0,1))==0xef && ord(substr(d.csv,1,1))==0xbb && ord(substr(d.csv,2,1))==0xbf)?"1":"0", substr(l[0], 3), d.rows, length(l)));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "1" ] && ok "export_csv devices ok=true" || bad "export_csv 返回非 ok"
[ "$2" = "1" ] && ok "CSV 带 UTF-8 BOM（Excel 打开中文不乱码）" || bad "CSV 缺 BOM"
[ "$3" = "主机名,IP,MAC,别名,分组,接入,直连下载,直连上传,代理下载,代理上传,合计,本月下载,本月上传,本月合计,首次出现" ] \
  && ok "表头 15 列正确" || bad "表头 = [$3]"
[ "$4" = "3" ] && ok "devices CSV 3 行数据" || bad "devices CSV 行数 $4 期望 3"
[ "$5" = "5" ] && ok "CRLF 行尾：表头+3 行+末尾空段 = 5 段" || bad "CRLF 分段 $5 期望 5"
FN=$(jget "$ROOT/csv_dev.json" 'd.filename')
case "$FN" in prism-router-devices-????-??-??.csv) ok "文件名 $FN";; *) bad "文件名 $FN 不符合 prism-router-devices-YYYY-MM-DD.csv";; esac
csv_of "$ROOT/csv_dev.json" "$ROOT/csv_dev.csv"
grep -qF '"a""b\c"' "$ROOT/csv_dev.csv" && ok 'hostname 里的 " 按 RFC4180 双写（a""b\c）' || bad 'hostname 引号未按 RFC4180 转义'
grep -qF '"hb,plus"' "$ROOT/csv_dev.csv" && ok '别名含逗号 -> 整体加引号' || bad '逗号别名未加引号'
rpc set_device_meta '{"mac":"70:70:fc:07:11:13","alias":"=1+1","group":"x"}' >/dev/null
export_rpc devices > "$ROOT/csv_dev2.json"
csv_of "$ROOT/csv_dev2.json" "$ROOT/csv_dev2.csv"
grep -qF "'=1+1" "$ROOT/csv_dev2.csv" && ok "以 = 开头的别名加了 ' 前缀（防 Excel 公式注入）" || bad "公式注入未防护"

R=$(env PRISM_ROUTER_STATE_FILE="$ROOT/state_bad_csv.json" PRISM_ROUTER_DAILY_DIR="$DAILY" \
      PRISM_ROUTER_DEVICES_FILE="$DEVMETA" PRISM_ROUTER_METHOD=export_csv PRISM_ROUTER_ARGS='{"what":"devices"}' \
      ucode -L /usr/lib/ucode "$RPCD" 2>/dev/null)
printf 'corrupted {{{\n' > "$ROOT/state_bad_csv.json"
R=$(env PRISM_ROUTER_STATE_FILE="$ROOT/state_bad_csv.json" PRISM_ROUTER_DAILY_DIR="$DAILY" \
      PRISM_ROUTER_DEVICES_FILE="$DEVMETA" PRISM_ROUTER_METHOD=export_csv PRISM_ROUTER_ARGS='{"what":"devices"}' \
      ucode -L /usr/lib/ucode "$RPCD" 2>/dev/null)
echo "$R" > "$ROOT/csv_bad_state.json"
R=$(jget "$ROOT/csv_bad_state.json" 'sprintf("%d|%d", (d.ok==true)?1:0, d.rows)')
[ "$R" = "1|0" ] && ok "state.json 损坏：devices CSV 只有表头（ok=true, rows=0）" || bad "坏 state 的 CSV：$R"

echo "=== 11. export_csv apps ==="
export_rpc apps > "$ROOT/csv_apps.json"
R=$(jrun "$ROOT/csv_apps.json" 'let l = split(d.csv, "\r\n"); print(sprintf("%s|%s|%d", (d.ok==true)?"1":"0", substr(l[0], 3), d.rows));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "1" ] && ok "apps CSV ok=true" || bad "apps CSV 失败"
[ "$2" = "应用,出口链路,下载,上传,合计,设备数" ] && ok "apps 表头正确" || bad "apps 表头 [$2]"
[ "$3" = "2" ] && ok "apps 2 行" || bad "apps 行数 $3 期望 2"
csv_of "$ROOT/csv_apps.json" "$ROOT/csv_apps.csv"
grep -qF '"a,b.example"' "$ROOT/csv_apps.csv" && ok "应用名含逗号 -> 加引号" || bad "应用名逗号未转义"

echo "=== 12. export_csv daily ==="
export_rpc daily > "$ROOT/csv_daily.json"
R=$(jrun "$ROOT/csv_daily.json" 'let l = split(d.csv, "\r\n"); let days = []; for (let i = 1; i < length(l) - 1; i++) push(days, split(l[i], ",")[0]); print(sprintf("%s|%s|%d|%s", (d.ok==true)?"1":"0", substr(l[0], 3), d.rows, join(",", days)));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "1" ] && ok "daily CSV ok=true" || bad "daily CSV 失败"
[ "$2" = "日期,下载,上传,合计,设备数" ] && ok "daily 表头正确" || bad "daily 表头 [$2]"
EXP_ROWS=2; [ "$YDAY_IN_MONTH" = "1" ] && EXP_ROWS=3
[ "$3" = "$EXP_ROWS" ] && ok "daily 行数 $3（跨月文件也导出，按日期升序）" || bad "daily 行数 $3 期望 $EXP_ROWS"
SORTED=$(echo "$4" | tr ',' '\n' | sort | tr '\n' ',')
[ "$4," = "$SORTED" ] && ok "按日期升序：$4" || bad "未按日期升序：$4"
R=$(env PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DAILY_DIR="$ROOT/daily_c" \
      PRISM_ROUTER_DEVICES_FILE="$DEVMETA" PRISM_ROUTER_METHOD=export_csv PRISM_ROUTER_ARGS='{"what":"daily"}' \
      ucode -L /usr/lib/ucode "$RPCD" 2>/dev/null)
echo "$R" > "$ROOT/csv_daily_bad.json"
R=$(jget "$ROOT/csv_daily_bad.json" 'sprintf("%s|%d", (d.ok==true)?"1":"0", d.rows)')
[ "$R" = "1|0" ] && ok "坏 JSON 被跳过：daily 导出 0 行且 ok=true" || bad "坏文件处理 = $R"
R=$(export_rpc bogus 2>/dev/null)
echo "$R" | tr -d ' \n' | grep -q '"ok":false' && ok "非法 what 返回 ok=false（不崩）" || bad "非法 what 返回 $R"
R=$(rpc export_csv '{}' 2>/dev/null)
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "what 缺省 = devices" || bad "缺省 what 返回 $R"

echo "=== 13. Prometheus CGI：认证 ==="
rm -f "$DEVMETA"
rpc set_device_meta '{"mac":"dc:56:7b:89:fb:31","alias":"客厅电视","group":"家人"}' >/dev/null
TOK=gate-token-7f3a
UCI set prism-router.settings.metrics_enabled='0'; UCI set prism-router.settings.metrics_token=''; cfg_commit
mrun(){ env REQUEST_METHOD="$1" QUERY_STRING="$2" HTTP_AUTHORIZATION="$3" \
        PRISM_ROUTER_STATE_FILE="$STATE" PRISM_ROUTER_DEVICES_FILE="$DEVMETA" "$METRICS_CGI"; }
hstatus(){ head -1 "$1" | tr -d '\r'; }
mrun GET "token=abc" "" > "$ROOT/m0.txt"
[ "$(hstatus "$ROOT/m0.txt")" = "Status: 403 Forbidden" ] && ok "未启用（enabled=0）-> 403" || bad "未启用返回 $(hstatus "$ROOT/m0.txt")"
UCI set prism-router.settings.metrics_enabled='1'; UCI set prism-router.settings.metrics_token=''; cfg_commit
mrun GET "token=" "" > "$ROOT/m1.txt"
[ "$(hstatus "$ROOT/m1.txt")" = "Status: 403 Forbidden" ] && ok "已启用但 token 为空 -> 403" || bad "空 token 返回 $(hstatus "$ROOT/m1.txt")"
UCI set "prism-router.settings.metrics_token=$TOK"; cfg_commit
mrun GET "" "" > "$ROOT/m2.txt"
[ "$(hstatus "$ROOT/m2.txt")" = "Status: 403 Forbidden" ] && ok "请求没带 token -> 403" || bad "缺 token 返回 $(hstatus "$ROOT/m2.txt")"
mrun GET "token=wrong" "" > "$ROOT/m3.txt"
[ "$(hstatus "$ROOT/m3.txt")" = "Status: 403 Forbidden" ] && ok "token 不匹配 -> 403" || bad "错 token 返回 $(hstatus "$ROOT/m3.txt")"
mrun GET "token=$TOK" "" > "$ROOT/ok1.txt"
[ "$(hstatus "$ROOT/ok1.txt" | grep -c '^Content-Type: text/plain')" = "1" ] && ok "?token= 正确 -> 200 + text/plain" || bad "正确 token 返回 $(hstatus "$ROOT/ok1.txt")"
mrun GET "" "Bearer $TOK" > "$ROOT/ok2.txt"
[ "$(hstatus "$ROOT/ok2.txt" | grep -c '^Content-Type: text/plain')" = "1" ] && ok "Authorization: Bearer -> 200" || bad "Bearer 返回 $(hstatus "$ROOT/ok2.txt")"
mrun GET "" "bearer $TOK" > "$ROOT/ok3.txt"
[ "$(hstatus "$ROOT/ok3.txt" | grep -c '^Content-Type: text/plain')" = "1" ] && ok "Bearer 大小写不敏感" || bad "小写 bearer 失败"
mrun POST "token=$TOK" "" > "$ROOT/m4.txt"
[ "$(hstatus "$ROOT/m4.txt")" = "Status: 405 Method Not Allowed" ] && ok "非 GET/HEAD -> 405" || bad "POST 返回 $(hstatus "$ROOT/m4.txt")"
grep -q '^Content-Type: text/plain; version=0.0.4' "$ROOT/ok1.txt" && ok "Content-Type 带 version=0.0.4（Prometheus 文本格式）" || bad "Content-Type 不对：$(hstatus "$ROOT/ok1.txt")"

echo "=== 14. Prometheus：文本格式合法性 ==="
cat > "$ROOT/validate_metrics.uc" <<'VUC'
'use strict';
let fs = require('fs');
let body = fs.readfile(getenv('F'));
let problems = [];
let samples = 0, types = 0, helps = 0;
let seen = {}, type_seen = {};
function split_labels(s) {
	let out = [], cur = '', inq = false, esc = false;
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (inq) {
			cur += c;
			if (esc) esc = false;
			else if (c == '\\') esc = true;
			else if (c == '"') inq = false;
			continue;
		}
		if (c == '"') { inq = true; cur += c; continue; }
		if (c == ',') { push(out, cur); cur = ''; continue; }
		cur += c;
	}
	if (length(cur) || length(out)) push(out, cur);
	return out;
}
for (let line in split(body, '\n')) {
	if (length(line) == 0) continue;
	if (substr(line, 0, 1) == '#') {
		let m = match(line, /^# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*)( (.+))?$/);
		if (m == null) { push(problems, 'bad comment: ' + line); continue; }
		if (m[1] == 'HELP') { helps++; continue; }
		types++;
		if (type_seen[m[2]] != null) push(problems, 'duplicate TYPE: ' + m[2]);
		type_seen[m[2]] = true;
		let kind = trim(m[4] ?? '');
		if (kind != 'gauge' && kind != 'counter' && kind != 'untyped'
			&& kind != 'summary' && kind != 'histogram')
			push(problems, 'bad type kind: ' + kind);
		continue;
	}
	let m = match(line, /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (-?[0-9]+(\.[0-9]+)?)$/);
	if (m == null) { push(problems, 'bad sample: ' + line); continue; }
	let name = m[1], labels = (m[3] != null) ? m[3] : null, value = m[4];
	if (index(value, 'e') >= 0 || index(value, 'E') >= 0) push(problems, 'sci notation: ' + line);
	if (labels != null) {
		let used = {};
		for (let p in split_labels(labels)) {
			let pm = match(p, /^([a-zA-Z_][a-zA-Z0-9_]*)="([^"\\]|\\.)*"$/);
			if (pm == null) { push(problems, 'bad label: [' + p + ']'); continue; }
			if (used[pm[1]] != null) push(problems, 'duplicate label: ' + pm[1]);
			used[pm[1]] = true;
		}
	}
	let key = name + '{' + ((labels != null) ? labels : '') + '}';
	if (seen[key] != null) push(problems, 'duplicate series: ' + key);
	seen[key] = true;
	samples++;
}
print(sprintf('%d|%d|%d|%d|%s', samples, types, helps, length(problems), join('; ', problems)));
VUC
vbody(){ awk 'p{print} !p && ($0 == "" || $0 == "\r") {p=1}' "$1" | sed 's/\r$//' > "$2"; }
vbody "$ROOT/ok1.txt" "$ROOT/ok1.body"
R=$(F="$ROOT/ok1.body" ucode "$ROOT/validate_metrics.uc" 2>/dev/null)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "${4:-x}" = "0" ] && ok "Prometheus 文本格式合法（样本 $1 条、TYPE $2 条、HELP $3 条）" || bad "格式问题：${5:-解析失败}"
[ "${1:-0}" -ge 10 ] 2>/dev/null && ok "样本数 $1 >= 10" || bad "样本太少：$1"
MISS=""
for m in traffic_info traffic_up traffic_state_present traffic_device_rx_bytes traffic_device_tx_bytes \
         traffic_proxy_rx_bytes_total traffic_direct_rx_bytes_total traffic_system_cpu_pct \
         traffic_system_mem_pct traffic_system_wan_rx_bytes_per_second traffic_devices_online; do
  grep -q "^$m" "$ROOT/ok1.body" || MISS="$MISS $m"
done
[ -z "$MISS" ] && ok "11 个必需指标全部存在" || bad "缺少指标：$MISS"
grep -qxF 'traffic_device_rx_bytes{mac="dc:56:7b:89:fb:31",hostname="laptop",alias="客厅电视",group="家人"} 6000' "$ROOT/ok1.body" \
  && ok "device 指标 4 标签齐全、值 = direct+proxy (6000)" || bad "device 行不对：$(grep '^traffic_device_rx_bytes' "$ROOT/ok1.body" | head -1)"
grep -qF 'hostname="a\"b\\c"' "$ROOT/ok1.body" && ok '标签值转义（" -> \"，\ -> \\）' || bad '标签值未转义'
grep -qx 'traffic_system_cpu_pct 4.6' "$ROOT/ok1.body" && ok "system 指标定点 1 位小数（cpu_pct 4.6）" || bad "cpu_pct 行不对"
grep -qx 'traffic_system_temp_celsius 42.9' "$ROOT/ok1.body" && ok "temp_c 42.9" || bad "temp 行不对"
grep -qx 'traffic_proxy_rx_bytes_total 5000' "$ROOT/ok1.body" && ok "proxy_rx 累计值 5000" || bad "proxy 行不对"
grep -qx 'traffic_up 1' "$ROOT/ok1.body" && ok "traffic_up=1（state.json 新鲜）" || bad "traffic_up 不为 1"
grep -qx 'traffic_devices_online 3' "$ROOT/ok1.body" && ok "traffic_devices_online=3" || bad "在线设备数不对"
[ "$(tail -c 1 "$ROOT/ok1.body" | wc -l)" = "1" ] && ok "响应体以换行结尾" || bad "响应体结尾不是换行"

echo "=== 15. Prometheus：缺数据降级 ==="
mkdir -p "$ROOT/state_missing"
mrun2(){ env REQUEST_METHOD=GET QUERY_STRING="token=$TOK" \
          PRISM_ROUTER_STATE_FILE="$1" PRISM_ROUTER_DEVICES_FILE="$2" "$METRICS_CGI"; }
mrun2 "$ROOT/state_missing/state.json" "$DEVMETA" > "$ROOT/m5.txt"
vbody "$ROOT/m5.txt" "$ROOT/m5.body"
[ "$(hstatus "$ROOT/m5.txt")" = "Content-Type: text/plain; version=0.0.4; charset=utf-8" ] && ok "state.json 缺失仍是 200" || bad "缺 state 状态行 $(hstatus "$ROOT/m5.txt")"
grep -qx 'traffic_state_present 0' "$ROOT/m5.body" && ok "state.json 缺失：state_present=0（不崩）" || bad "缺 state 时输出不对"
grep -q '^traffic_device_rx_bytes' "$ROOT/m5.body" && bad "缺 state 时仍输出了设备指标" || ok "缺 state 时没有设备样本（不猜 0）"
printf 'corrupted {{{\n' > "$ROOT/state_bad.json"
mrun2 "$ROOT/state_bad.json" "$DEVMETA" > "$ROOT/m6.txt"
vbody "$ROOT/m6.txt" "$ROOT/m6.body"
grep -qx 'traffic_state_present 0' "$ROOT/m6.body" && ok "state.json 损坏：state_present=0 且不崩" || bad "损坏 state 处理失败"
printf 'not json at all\n' > "$ROOT/devices_bad.json"
mrun2 "$STATE" "$ROOT/devices_bad.json" > "$ROOT/m7.txt"
vbody "$ROOT/m7.txt" "$ROOT/m7.body"
R=$(F="$ROOT/m7.body" ucode "$ROOT/validate_metrics.uc" 2>/dev/null)
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "${4:-x}" = "0" ] && ok "devices.json 损坏：仍输出合法指标（${1:-0} 条样本）" || bad "坏 devices.json 输出非法：$R"
grep -q 'alias=""' "$ROOT/m7.body" && ok "坏 devices.json 时 alias 标签为空串" || bad "alias 标签异常"

echo "=== 16. 向后兼容 ==="
rm -f "$DEVMETA"
get_state
[ "$(field n.devices)" = "3" ] && ok "无 devices.json 时 get_state 仍返回 3 台设备" || bad "设备数 $(field n.devices)"
OLD_OK=1; j=1
while [ "$j" -le 3 ]; do
  [ "$(field "dev.$j.keys_old")" = "12" ] || OLD_OK=0
  j=$((j+1))
done
[ "$OLD_OK" = "1" ] && ok "12 个原有设备字段全部保留" || bad "原有设备字段缺失"
[ "$(field dev.1.keys_all)" = "15" ] && ok "新增字段只有 month_rx/month_tx/month_total（无元数据时 15 键）" || bad "字段数 $(field dev.1.keys_all) 期望 15"
[ "$(field dev.1.has_alias)" = "0" ] && ok "没有元数据时不出现 alias 键" || bad "意外出现 alias"
[ "$(field dev.1.first_seen)" = "MISSING" ] && ok "没有 first_seen 时不出现该键" || bad "意外出现 first_seen"
[ "$(field dev.1.quota_limit)" = "MISSING" ] && ok "mode=none 时不出现 quota_limit 键" || bad "意外出现 quota_limit"
for m in status get_history get_daily get_nodes get_stations; do
  rpc "$m" '{}' > "$ROOT/old_$m.json" 2>/dev/null
  R=$(jget "$ROOT/old_$m.json" 'type(d) == "object" ? "ok" : "bad"')
  [ "$R" = "ok" ] && ok "$m 仍返回合法 JSON 对象" || bad "$m 返回非法/空"
done
grep -q '"month_rx"\|"alias"\|"first_seen"\|"quota"' "$STATE" && bad "守护进程的 state.json 被塞进了新字段" || ok "state.json 一个字段都没变（新字段只在 get_state 返回体里）"
SZ=$(wc -c < "$ROOT/gs.json")
[ "$SZ" -lt 184320 ] && ok "get_state $SZ 字节 (<180KiB)" || bad "get_state 超预算 $SZ"
grep -q '"csv"' "$ROOT/csv_dev.json" && ok "CSV 文本随返回值下发（前端可直接存文件）" || bad "返回值缺 csv"

echo "=== 17. ACL 与 set_config 白名单 ==="
ACL=/usr/share/rpcd/acl.d/luci-app-prism-router.json
grep -q '"export_csv"' "$ACL" && ok "ACL read 含 export_csv" || bad "ACL read 缺 export_csv"
if grep -q '"set_device_meta"' "$ACL"; then
  bad "LuCI ACL 仍含写方法 set_device_meta（应已精简为只读）"
else
  ok "LuCI ACL 只读（不再下发 set_device_meta）"
fi
ucode -e 'let fs=require("fs"); json(fs.readfile("/usr/share/rpcd/acl.d/luci-app-prism-router.json"));' 2>/dev/null \
  && ok "ACL 是合法 JSON" || bad "ACL JSON 坏了"
SC=$(rpc set_config '{"section":"settings","options":"{\"quota_mode\":\"device\",\"quota_monthly_gb\":\"20\",\"quota_total_gb\":\"200\",\"metrics_enabled\":\"1\",\"metrics_token\":\"tok2\"}"}')
echo "$SC" | tr -d ' \n' | grep -q '"ok":true' && ok "set_config 放行 5 个新配置项" || bad "set_config 返回 $SC"
[ "$(CGET prism-router.settings.quota_mode)" = "device" ] && ok "uci quota_mode=device" || bad "quota_mode=$(CGET prism-router.settings.quota_mode)"
[ "$(CGET prism-router.settings.quota_monthly_gb)" = "20" ] && ok "uci quota_monthly_gb=20" || bad "quota_monthly_gb 写入失败"
[ "$(CGET prism-router.settings.metrics_token)" = "tok2" ] && ok "uci metrics_token 写入成功" || bad "metrics_token 写入失败"
BAD=$(rpc set_config '{"section":"settings","options":"{\"quota_magic\":\"1\"}"}')
echo "$BAD" | grep -q 'no valid options' && ok "非白名单字段仍被拒绝" || bad "非白名单字段未被拒绝：$BAD"
UCI set prism-router.settings.quota_mode='none'; UCI set prism-router.settings.quota_monthly_gb=''
UCI set prism-router.settings.quota_total_gb=''; UCI set prism-router.settings.metrics_enabled='0'
UCI set prism-router.settings.metrics_token=''; cfg_commit

echo "=== 18. 真实 ubus → rpcd 插件（注册 / 参数策略 / 端到端）==="
mkdir -p /var/run/ubus /tmp/prism-router /etc/prism-router
cp -f "$STATE" /tmp/prism-router/state.json
rm -rf /etc/prism-router/daily; mkdir -p /etc/prism-router/daily
cp -f "$DAILY"/*.json /etc/prism-router/daily/ 2>/dev/null
rm -f /etc/prism-router/devices.json
/sbin/ubusd -s /var/run/ubus/ubus.sock >/tmp/ubusd.log 2>&1 &
sleep 1
/sbin/rpcd -s /var/run/ubus/ubus.sock >/tmp/rpcd.log 2>&1 &
sleep 3
if ubus list 2>/dev/null | grep -qx prism-router; then
  ok "rpcd 注册 ubus 对象 prism-router"
else
  bad "rpcd 未注册 prism-router（插件加载失败）"; head -3 /tmp/rpcd.log
fi
grep -q 'Skipping registration' /tmp/rpcd.log && bad "rpcd 日志出现 Skipping registration" || ok "rpcd 日志无注册失败"
ubus call prism-router get_state > "$ROOT/ubus_gs.json" 2>"$ROOT/ubus_gs.err"
R=$(jget "$ROOT/ubus_gs.json" 'sprintf("%d|%d|%s", d.totals.month_total, length(d.devices), d.quota.mode)')
[ "$R" = "$EXP_MONTH_TOTAL|3|none" ] && ok "ubus get_state：month_total=$EXP_MONTH_TOTAL、3 台设备、quota.mode=none" || bad "ubus get_state = $R"
R=$(ubus call prism-router set_device_meta '{"mac":"dc:56:7b:89:fb:31","alias":"ubus 别名","group":"ubus 组"}' 2>&1)
echo "$R" | tr -d ' \n' | grep -q '"ok":true' && ok "ubus set_device_meta 成功" || bad "ubus set_device_meta 失败：$R"
grep -q 'ubus 别名' /etc/prism-router/devices.json && ok "别名落到 /etc/prism-router/devices.json" || bad "别名未落盘"
check /etc/prism-router/devices.json "root:root -rw-r--r--"
R=$(ubus call prism-router set_device_meta '{"mac":"dc:56:7b:89:fb:31"}' 2>&1)
echo "$R" | grep -q 'nothing to update' && ok "ubus 缺省参数字段 = 不改（不误清）" || bad "ubus 只传 mac 的处理：$R"
R=$(ubus call prism-router set_device_meta '{"mac":"dc:56:7b:89:fb:31","alias":"","group":"ubus 组"}' 2>&1)
grep -q 'ubus 别名' /etc/prism-router/devices.json && bad "空串 alias 未清除" || ok "ubus 空串 alias = 清除、group 保留"
ubus call prism-router export_csv '{"what":"apps"}' > "$ROOT/ubus_csv.json" 2>/dev/null
R=$(jget "$ROOT/ubus_csv.json" 'sprintf("%d|%d", (d.ok==true)?1:0, d.rows)')
[ "$R" = "1|2" ] && ok "ubus export_csv apps 端到端（2 行）" || bad "ubus export_csv = $R"
ubus call prism-router export_csv '{}' > "$ROOT/ubus_csv2.json" 2>/dev/null
R=$(jget "$ROOT/ubus_csv2.json" 'sprintf("%s|%d", d.what, d.rows)')
[ "$R" = "devices|3" ] && ok "ubus export_csv 省略 what = devices" || bad "ubus export_csv 缺省 = $R"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
