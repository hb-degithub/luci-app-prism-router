#!/bin/sh
# 哑桥 AP「无线站点元数据上报」用例（容器内执行；由 tests/container-validate-stations.sh 调用）
#
# 覆盖：
#   1. 两个包装上后 /etc /usr /www /www/cgi-bin 权限不变（2026-11-14 事故回归核心）
#   2. 新文件落位、属主 root、权限正确（CGI 755，ucode 脚本 644）
#   3. 真跑 stations.uc（假 iw 注入 PATH）→ uhttpd + CGI → 落盘逐字段校验（含"绝不报字节"）
#   4. 负例：错 token / 通道关闭 / 过期与未来时间戳 / node_id 穿越 / 超大 body /
#      非 POST / Content-Type / node_id 与 body 不一致
#   5. get_stations 空态、有数据态、坏文件容错、大表裁剪、ACL 放行
#   6. 静默退出：无站点 / iw 缺失 / 开关关闭 都 exit 0 且不刷屏；dry-run 不发包
#
# 隔离：只在 127.0.0.1 上跑，不访问外网、不接触任何真机。
mkdir -p /var/run/ubus /var/lock /tmp /www/cgi-bin /tmp/fakebin

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
perm(){ ls -ld "$1" 2>/dev/null | awk '{print $1,$3":"$4}'; }
check(){ local got; got=$(ls -ld "$1" 2>/dev/null | awk '{print $3":"$4" "$1}')
  [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 期望[$2] 实际[${got:-不存在}]"; }
UCI(){ uci "$@" >/dev/null 2>&1; }
CGET(){ uci -q get "$1" 2>/dev/null; }
code_of(){ F="$1" ucode -e 'let fs=require("fs"); let t=""; try { t=fs.readfile(getenv("F")) ?? ""; } catch (e) { t=""; }
  let d=null; try { d=json(t); } catch (e) { d=null; }
  print((d!=null && type(d)=="object") ? (d.code ?? "null") : "nojson");'; }
logsize(){ wc -l < /tmp/traffic-stats/stations.log 2>/dev/null || echo 0; }

POST_URL="http://127.0.0.1:8080/cgi-bin/traffic-stats-stations"
TOKEN='st-token-9f3c'

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=$B_CGI"

echo "=== 1. 安装两个包 ==="
opkg install --force-depends /src/dist/traffic-stats_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 && ok "安装 traffic-stats" || { bad "安装 traffic-stats"; tail -5 /tmp/i1.log; }
opkg install --force-depends /src/dist/luci-app-traffic-stats_1.0.0-1_all.ipk >/tmp/i2.log 2>&1 && ok "安装 luci-app-traffic-stats" || { bad "安装 luci-app"; tail -5 /tmp/i2.log; }

echo "=== 2. 新文件落位与权限 ==="
check /usr/share/traffic-stats/stations.uc "root:root -rw-r--r--"
check /www/cgi-bin/traffic-stats-stations "root:root -rwxr-xr-x"
check /www/cgi-bin "root:root drwxr-xr-x"
check /usr/share/rpcd/ucode/traffic-stats.uc "root:root -rw-r--r--"
check /etc/config/traffic-stats "root:root -rw-r--r--"
grep -q "stations_enabled" /etc/config/traffic-stats && ok "config 含 stations_enabled" || bad "config 缺少 stations_enabled"
grep -q "stations_token" /etc/config/traffic-stats && ok "config 含 stations_token" || bad "config 缺少 stations_token"
grep -q "station_ifaces" /etc/config/traffic-stats && ok "config 含 station_ifaces" || bad "config 缺少 station_ifaces"
grep -q '"get_stations"' /usr/share/rpcd/acl.d/luci-app-traffic-stats.json \
  && ok "ACL 放行 get_stations" || bad "ACL 缺少 get_stations"

echo "=== 3. 系统目录权限未被改动（回归核心）==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 4. ucode 语法 ==="
ucode -c /usr/share/traffic-stats/stations.uc && ok "stations.uc 语法 OK" || bad "stations.uc 语法错误"
ucode -c /www/cgi-bin/traffic-stats-stations && ok "ingest-stations(CGI) 语法 OK" || bad "ingest-stations 语法错误"
ucode -c /usr/share/rpcd/ucode/traffic-stats.uc && ok "rpcd uc 语法 OK" || bad "rpcd uc 语法错误"

echo "=== 5. 假 iw（只实现本用例需要的两个子命令）==="
cat > /tmp/fakebin/iw <<'IW'
#!/bin/sh
# 假 iw：dev（枚举接口）/ dev <if> station dump（固定 fixture）
if [ "$1" = "dev" ] && [ -z "$2" ]; then
	printf 'phy#0\n'
	printf '\tInterface phy0.0-ap1\n\t\tifindex 22\n\t\tssid OpenWrt-2G\n\t\ttype AP\n'
	printf '\tInterface phy0.1-ap0\n\t\tifindex 23\n\t\tssid OpenWrt-5G\n\t\ttype AP\n'
	printf '\tInterface br-lan\n\t\tifindex 1\n\t\ttype AP/VLAN\n'
	exit 0
fi
if [ "$1" != "dev" ] || [ "$3" != "station" ] || [ "$4" != "dump" ]; then
	echo "fake iw: unsupported: $*" >&2
	exit 1
fi
case "$2" in
phy0.1-ap0)
	cat <<EOF
Station 22:77:08:69:a9:1f (on phy0.1-ap0)
	inactive time:	1234 ms
	rx bytes:	9999999999
	rx packets:	12345
	tx bytes:	8888888888
	tx packets:	2345
	signal:  	-53 [-57, -55] dBm
	signal avg:	-55 [-58, -56] dBm
	tx bitrate:	650.0 MBit/s VHT-MCS 7 80MHz short GI VHT-NSS 2
	rx bitrate:	866.6 MBit/s VHT-MCS 9 80MHz short GI VHT-NSS 2
	authorized:	yes
	beacon interval:100
	connected time:	3600 seconds
	associated time:	3600 seconds

Station dc:56:7b:89:fb:31 (on phy0.1-ap0)
	inactive time:	20 ms
	rx bytes:	100
	signal:  	-72 dBm
	tx bitrate:	6.0 MBit/s
	rx bitrate:	54.0 MBit/s
	connected time:	125 seconds

Station 00:11:22:33:44:55 (on phy0.1-ap0)
	inactive time:	30 ms
	connected time:	30 seconds
EOF
	;;
phy0.0-ap1)
	cat <<EOF
Station aa:bb:cc:dd:ee:ff (on phy0.0-ap1)
	signal:  	-81 dBm
	tx bitrate:	1.5 MBit/s MCS 0 20MHz
	rx bitrate:	unknown
	connected time:	9 seconds

Station 02:00:00:00:00:01 (on phy0.0-ap1)
	signal:  	5 dBm
	connected time:	2 seconds
EOF
	;;
br-lan)
	echo "fake iw: br-lan is not an AP interface" >&2
	exit 1
	;;
*)
	exit 0
	;;
esac
IW
chmod 755 /tmp/fakebin/iw
ok "假 iw 已就位（/tmp/fakebin/iw）"

echo "=== 6. 配置（母/子同机：本容器同时扮演两边）==="
UCI set traffic-stats.settings.lan_ranges='192.168.100.0/24'
UCI set traffic-stats.settings.node_id='ap-1'
UCI set traffic-stats.settings.node_name='客厅 AP'
UCI set traffic-stats.settings.mother_url='http://127.0.0.1:8080'
UCI set traffic-stats.settings.stations_enabled='1'
UCI set traffic-stats.settings.stations_token="$TOKEN"
UCI set traffic-stats.settings.station_ifaces='phy0.1-ap0,phy0.0-ap1'
UCI commit traffic-stats
[ "$(CGET traffic-stats.settings.stations_token)" = "$TOKEN" ] && ok "UCI 站点选项写入成功" || bad "UCI 写入失败"

echo "=== 7. get_stations 空态（还没有 AP 上报）==="
rm -rf /etc/traffic-stats/stations
TRAFFIC_STATS_METHOD=get_stations ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/traffic-stats.uc > /tmp/s0.json 2>/tmp/s0.err
R=$(F=/tmp/s0.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  print(sprintf("%d|%d|%d|%s", length(d.stations ?? []), length(d.nodes ?? []), d.count ?? -1, d.enabled));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "0" ] && [ "$2" = "0" ] && [ "$3" = "0" ] && ok "空态 stations=[] nodes=[] count=0（未崩）" \
  || { bad "空态异常：$R"; cat /tmp/s0.err; }
[ "$4" = "true" ] && ok "空态仍能读到开关 enabled=true" || bad "enabled=$4"

echo "=== 8. 起 uhttpd / ubusd / rpcd ==="
/sbin/ubusd -s /var/run/ubus/ubus.sock >/tmp/ubusd.log 2>&1 &
sleep 1
/sbin/rpcd -s /var/run/ubus/ubus.sock >/tmp/rpcd.log 2>&1 &
sleep 1
/usr/sbin/uhttpd -f -p 127.0.0.1:8080 -h /www -x /cgi-bin -u /ubus >/tmp/uhttpd.log 2>&1 &
i=0
while [ $i -lt 20 ]; do
  curl -s -o /dev/null -m 1 http://127.0.0.1:8080/ && break
  i=$((i+1)); sleep 0.2
done
[ $i -lt 20 ] && ok "uhttpd 就绪 (127.0.0.1:8080)" || { bad "uhttpd 未就绪"; cat /tmp/uhttpd.log; }

echo "=== 9. 真跑 stations.uc（假 iw 注入 PATH）→ CGI → 落盘 ==="
PATH=/tmp/fakebin:$PATH ucode /usr/share/traffic-stats/stations.uc
RC=$?
[ "$RC" = "0" ] && ok "stations.uc 退出码 0" || bad "stations.uc 退出码 $RC"
[ -f /etc/traffic-stats/stations/ap-1.json ] && ok "快照 /etc/traffic-stats/stations/ap-1.json 已落盘" \
  || { bad "快照未落盘"; tail -3 /tmp/traffic-stats/stations.log; }
check /etc/traffic-stats/stations "root:root drwxr-xr-x"
check /etc/traffic-stats/stations/ap-1.json "root:root -rw-r--r--"
[ -e /etc/traffic-stats/stations/ap-1.jsonl ] && bad "出现了 jsonl 历史（信号是瞬时量，不该落）" \
  || ok "没有 jsonl 历史（不磨 flash）"

R=$(F=/etc/traffic-stats/stations/ap-1.json ucode -e '
  let fs = require("fs"); let d = json(fs.readfile(getenv("F")));
  let s1 = null, s4 = null, s5 = null;
  for (let s in d.stations) {
    if (s.mac == "22:77:08:69:a9:1f") s1 = s;
    if (s.mac == "aa:bb:cc:dd:ee:ff") s4 = s;
    if (s.mac == "02:00:00:00:00:01") s5 = s;
  }
  print(sprintf("%s|%d|%d|%s|%s|%s|%s|%s|%s|%s|%s",
    d.node_id, d.count, length(d.stations), d.name,
    s1.signal, s1.rx_rate, s1.tx_rate, s1.connected_sec, s1.iface,
    (type(s4.rx_rate) == "null" ? "absent" : s4.rx_rate),
    (type(s5.signal) == "null" ? "absent" : s5.signal)));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "ap-1" ] && ok "快照 node_id=ap-1" || bad "node_id=$1"
[ "$2" = "5" ] && [ "$3" = "5" ] && ok "5 个站点全部落盘（count=$2）" || bad "站点数异常：count=$2 len=$3"
[ "$4" = "客厅 AP" ] && ok "name=客厅 AP（UTF-8 正常）" || bad "name=[$4]"
[ "$5" = "-53" ] && ok "signal=-53（从 '-53 [-57, -55] dBm' 取首个整数）" || bad "signal=$5"
[ "$6" = "866600" ] && ok "rx_rate=866600 kbit/s（866.6 MBit/s 换算）" || bad "rx_rate=$6"
[ "$7" = "650000" ] && ok "tx_rate=650000 kbit/s（650.0 MBit/s 换算）" || bad "tx_rate=$7"
[ "$8" = "3600" ] && ok "connected_sec=3600（'3600 seconds'）" || bad "connected_sec=$8"
[ "$9" = "phy0.1-ap0" ] && ok "iface=phy0.1-ap0（从 '(on ...)' 取）" || bad "iface=$9"
[ "${10}" = "absent" ] && ok "rx bitrate=unknown → 跳过该字段（不崩）" || bad "rx_rate 应为 absent，实际 ${10}"
[ "${11}" = "absent" ] && ok "signal=5 dBm 越界 → 不写该字段" || bad "越界 signal 被写入：${11}"
grep -q 'bytes' /etc/traffic-stats/stations/ap-1.json && bad "快照里出现 bytes（违反'绝不报字节'）" \
  || ok "快照里没有 bytes 字段（只报元数据）"
grep -q 'br-lan' /tmp/traffic-stats/stations.log && bad "扫了非 AP 接口 br-lan" \
  || ok "auto/enumerated 接口里没有误扫 br-lan"

echo "=== 10. get_stations 有数据（脚本入口 / ubus / ACL）==="
TRAFFIC_STATS_METHOD=get_stations ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/traffic-stats.uc > /tmp/s1.json 2>/tmp/s1.err
R=$(F=/tmp/s1.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  let hit=null; for (let s in d.stations) if (s.mac == "22:77:08:69:a9:1f") hit=s;
  print(sprintf("%d|%s|%s|%s|%s|%s", d.count, d.nodes[0].node_id, hit.signal, hit.rx_rate, hit.iface, (type(hit.signal)=="int" ? "int" : type(hit.signal))));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "5" ] && ok "get_stations 返回 5 条站点" || { bad "get_stations 条数=$1"; cat /tmp/s1.err; }
[ "$2" = "ap-1" ] && ok "nodes[0].node_id=ap-1" || bad "nodes[0].node_id=$2"
[ "$3" = "-53" ] && [ "$4" = "866600" ] && ok "按 MAC 能查到 signal/-53 与 rx_rate/866600" || bad "站点字段异常：$3/$4"
[ "$5" = "phy0.1-ap0" ] && ok "站点带 iface（前端 tooltip 用）" || bad "iface=$5"
[ "$6" = "int" ] && ok "signal 是整数（前端按数字分级）" || bad "signal 类型=$6"

B=$(ubus call traffic-stats get_stations 2>/tmp/ubus.err)
echo "$B" > /tmp/s2.json
N=$(F=/tmp/s2.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(length(d.stations ?? []));')
[ "$N" = "5" ] && ok "ubus call traffic-stats get_stations → 5 条" || { bad "ubus 条数=$N"; cat /tmp/ubus.err; }

LOGIN=$(curl -sS -m 5 -X POST http://127.0.0.1:8080/ubus -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"root","password":""}]}')
SID=$(echo "$LOGIN" | sed -n "s/.*\"ubus_rpc_session\":\"\([0-9a-f]\{32\}\)\".*/\1/p")
if [ -n "$SID" ]; then
  ok "session.login 成功"
  ACLRES=$(curl -sS -m 5 -X POST http://127.0.0.1:8080/ubus -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"$SID\",\"traffic-stats\",\"get_stations\",{}]}")
  case "$ACLRES" in
    *"Access denied"*) bad "get_stations 被 ACL 拒绝（acl.d 需包含 get_stations）";;
    *'"stations"'*) ok "root 会话可调用 get_stations（ACL 正确）";;
    *) bad "get_stations 返回异常：$(echo "$ACLRES" | head -c 200)";;
  esac
else
  bad "session.login 失败，跳过 ACL 用例"
fi

echo "=== 11. 负例：错 token / 通道关闭 / 时间戳 / node_id 穿越 / 超大 body / 非 POST ==="
TS=$(date +%s)
BODY='{"node_id":"ap-1","ts":'"$TS"',"stations":[{"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53}]}'

curl -sS -m 5 -o /tmp/n1.json -X POST "$POST_URL?node_id=ap-1&ts=$TS&token=WRONG" \
  -H "Content-Type: application/json" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n1.json); [ "$C" = "1" ] && ok "错 token → code=1" || bad "错 token → code=$C 期望 1"

UCI set traffic-stats.settings.stations_enabled='0'; UCI commit traffic-stats
curl -sS -m 5 -o /tmp/n2.json -X POST "$POST_URL?node_id=ap-1&ts=$TS&token=$TOKEN" \
  -H "Content-Type: application/json" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n2.json); [ "$C" = "3" ] && ok "stations_enabled=0 → code=3（拒绝）" || bad "关闭时 → code=$C 期望 3"
UCI set traffic-stats.settings.stations_enabled='1'; UCI commit traffic-stats

TS_OLD=$((TS - 1000))
curl -sS -m 5 -o /tmp/n3.json -X POST "$POST_URL?node_id=ap-1&ts=$TS_OLD&token=$TOKEN" \
  -H "Content-Type: application/json" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n3.json); [ "$C" = "2" ] && ok "时间戳早 1000 秒 → code=2（超出 300 秒容差）" || bad "过期时间戳 → code=$C 期望 2"

TS_FUT=$((TS + 1000))
curl -sS -m 5 -o /tmp/n3b.json -X POST "$POST_URL?node_id=ap-1&ts=$TS_FUT&token=$TOKEN" \
  -H "Content-Type: application/json" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n3b.json); [ "$C" = "2" ] && ok "未来时间戳 +1000 秒 → code=2" || bad "未来时间戳 → code=$C 期望 2"

curl -sS -m 5 -o /tmp/n4.json -X POST "$POST_URL?node_id=..%2Fevil&ts=$TS&token=$TOKEN" \
  -H "Content-Type: application/json" --data-binary '{"node_id":"../evil","ts":'"$TS"',"stations":[]}' >/dev/null 2>&1
C=$(code_of /tmp/n4.json); [ "$C" = "4" ] && ok "node_id=../evil → code=4" || bad "穿越 node_id → code=$C 期望 4"
if [ ! -e /etc/traffic-stats/evil.json ] && [ ! -e /etc/evil.json ] && [ ! -e /etc/passwd.json ]; then
  ok "没有越权写出文件"
else
  bad "目录穿越：出现 evil.json / passwd.json"
fi

ucode -e 'let fs=require("fs"); let s=""; for (let i=0;i<8300;i++) s+="0123456789abcdef"; fs.writefile("/tmp/big.json", s);'
BIGSTATUS=$(curl -sS -m 8 -o /tmp/n5.json -w '%{http_code}' -X POST "$POST_URL?node_id=ap-1&ts=$(date +%s)&token=$TOKEN" \
  -H "Content-Type: application/json" --data-binary @/tmp/big.json 2>/dev/null)
CBIG=$(code_of /tmp/n5.json)
[ "$BIGSTATUS" = "413" ] && ok "超大 body（$(( $(wc -c < /tmp/big.json) )) 字节）→ HTTP 413" \
  || { [ "$CBIG" = "413" ] && ok "超大 body → code=413（HTTP $BIGSTATUS）" || bad "超大 body 未被拒：HTTP=$BIGSTATUS code=$CBIG"; }
[ "$(ls -l /etc/traffic-stats/stations/ap-1.json | awk '{print $5}')" -lt 65536 ] \
  && ok "超大 body 之后快照仍是小文件" || bad "超大 body 污染了快照"

GETSTATUS=$(curl -sS -m 5 -o /tmp/n6.json -w '%{http_code}' "$POST_URL?node_id=ap-1&ts=$TS&token=$TOKEN" 2>/dev/null)
[ "$GETSTATUS" = "405" ] && ok "GET → HTTP 405" || bad "GET → HTTP $GETSTATUS 期望 405"

curl -sS -m 5 -o /tmp/n7.json -X POST "$POST_URL?node_id=ap-1&ts=$TS&token=$TOKEN" \
  -H "Content-Type: text/plain" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n7.json); [ "$C" = "4" ] && ok "Content-Type: text/plain → code=4" || bad "错 Content-Type → code=$C"

curl -sS -m 5 -o /tmp/n8.json -X POST "$POST_URL?node_id=ap-2&ts=$TS&token=$TOKEN" \
  -H "Content-Type: application/json" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n8.json); [ "$C" = "4" ] && ok "body.node_id 与 X-Node-Id 不一致 → code=4" || bad "node_id 不一致 → code=$C"

echo "=== 11.5 头路径（标准 CGI 环境：请求头传凭证，绕开 uhttpd 丢头）==="
HB='{"node_id":"ap-9","name":"头路径 AP","ts":'"$TS"',"stations":[{"mac":"de:ad:be:ef:00:01","signal":-61,"rx_rate":1200000,"tx_rate":1000000,"connected_sec":60}]}'
printf '%s' "$HB" | env REQUEST_METHOD=POST CONTENT_LENGTH=${#HB} CONTENT_TYPE=application/json \
  HTTP_X_NODE_ID=ap-9 HTTP_X_TIMESTAMP="$TS" HTTP_X_TOKEN="$TOKEN" \
  ucode /www/cgi-bin/traffic-stats-stations > /tmp/hdr.out 2>&1
grep -q '^{"code":0}$' /tmp/hdr.out && ok "头路径（X-Node-Id/X-Timestamp/X-Token）→ {\"code\":0}" \
  || bad "头路径失败：$(tail -1 /tmp/hdr.out)"
[ -f /etc/traffic-stats/stations/ap-9.json ] && ok "头路径快照已落盘" || bad "头路径快照缺失"

printf '%s' "$HB" | env REQUEST_METHOD=POST CONTENT_LENGTH=${#HB} CONTENT_TYPE=application/json \
  HTTP_X_NODE_ID=ap-9 HTTP_X_TIMESTAMP="$TS" HTTP_X_TOKEN="wrong" \
  ucode /www/cgi-bin/traffic-stats-stations > /tmp/hdr2.out 2>&1
grep -q '"code":1' /tmp/hdr2.out && ok "头路径错 token → code=1" || bad "头路径错 token 未被拒：$(tail -1 /tmp/hdr2.out)"

echo "=== 11.6 带字节字段的 body：母节点白名单闸门（对端写错也存不进来）==="
curl -sS -m 5 -o /tmp/n9.json -X POST "$POST_URL?node_id=ap-2&ts=$TS&token=$TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"node_id":"ap-2","name":"坏 AP","ts":'"$TS"',"stations":[{"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53,"rx_bytes":123456789,"tx_bytes":987654,"rx_rate":866600}]}' >/dev/null 2>&1
C=$(code_of /tmp/n9.json); [ "$C" = "0" ] && ok "带字节字段的 body 被接受（忽略多余字段）" || bad "带字节字段 → code=$C"
grep -q 'bytes' /etc/traffic-stats/stations/ap-2.json && bad "字节字段被落盘（白名单闸门失效）" \
  || ok "落盘文件里没有 bytes（白名单闸门生效）"

echo "=== 12. 母节点未配置 token 时拒绝（绝不匿名写入）==="
UCI set traffic-stats.settings.stations_token=''; UCI commit traffic-stats
curl -sS -m 5 -o /tmp/n10.json -X POST "$POST_URL?node_id=ap-1&ts=$(date +%s)&token=" \
  -H "Content-Type: application/json" --data-binary "$BODY" >/dev/null 2>&1
C=$(code_of /tmp/n10.json); [ "$C" = "3" ] && ok "母节点 stations_token 为空 → code=3" || bad "空 token → code=$C 期望 3"
UCI set traffic-stats.settings.stations_token="$TOKEN"; UCI commit traffic-stats

echo "=== 13. dry-run 只打印请求、不发包 ==="
BEFORE=$(F=/etc/traffic-stats/stations/ap-1.json ucode -e 'let fs=require("fs"); print(json(fs.readfile(getenv("F"))).received_ts);')
PATH=/tmp/fakebin:$PATH TRAFFIC_STATS_STATIONS_DRY=1 ucode /usr/share/traffic-stats/stations.uc > /tmp/dry.json 2>/tmp/dry.err
AFTER=$(F=/etc/traffic-stats/stations/ap-1.json ucode -e 'let fs=require("fs"); print(json(fs.readfile(getenv("F"))).received_ts);')
[ "$BEFORE" = "$AFTER" ] && ok "dry-run 没有发包（快照 received_ts 未变：$BEFORE）" \
  || bad "dry-run 竟然发包了：$BEFORE -> $AFTER"
grep -q 'X-Token' /tmp/dry.json && grep -q '"body"' /tmp/dry.json \
  && ok "dry-run 打印了 url/headers/body" || { bad "dry-run 输出不完整"; head -c 200 /tmp/dry.json; }
DRYCOUNT=$(F=/tmp/dry.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(length(json(d.body).stations));')
[ "$DRYCOUNT" = "5" ] && ok "dry-run body 含 5 个站点" || bad "dry-run body 站点数=$DRYCOUNT"

echo "=== 14. 静默退出（cron 友好，绝不刷屏）==="
# 14a. 开关关闭：退出 0 且不写日志
BEFORE=$(logsize)
UCI set traffic-stats.settings.stations_enabled='0'; UCI commit traffic-stats
ucode /usr/share/traffic-stats/stations.uc; RC=$?
AFTER=$(logsize)
[ "$RC" = "0" ] && [ "$AFTER" = "$BEFORE" ] && ok "stations_enabled=0 → exit 0 且不写日志" \
  || bad "关闭时 rc=$RC 日志变化=$((AFTER-BEFORE))"
UCI set traffic-stats.settings.stations_enabled='1'; UCI commit traffic-stats

# 14b. 有接口但没站点：退出 0，只记一行
UCI set traffic-stats.settings.station_ifaces='phy9.9-ap9'; UCI commit traffic-stats
BEFORE=$(logsize)
TRAFFIC_STATS_IW=/tmp/fakebin/iw ucode /usr/share/traffic-stats/stations.uc; RC=$?
AFTER=$(logsize)
[ "$RC" = "0" ] && ok "无关联站点 → exit 0" || bad "无站点时 rc=$RC"
[ "$AFTER" -eq $((BEFORE+1)) ] && ok "无站点只记 1 行日志（$BEFORE -> $AFTER）" || bad "日志行数变化 $((AFTER-BEFORE))"
tail -1 /tmp/traffic-stats/stations.log | grep -q '无关联站点' && ok "日志写明'无关联站点'" || bad "日志内容不符"

# 14c. iw 缺失：退出 0 + WARN
BEFORE=$(logsize)
TRAFFIC_STATS_IW=/nonexistent/iw ucode /usr/share/traffic-stats/stations.uc; RC=$?
AFTER=$(logsize)
[ "$RC" = "0" ] && ok "iw 缺失 → exit 0（不因 cron 报错）" || bad "iw 缺失时 rc=$RC"
tail -1 /tmp/traffic-stats/stations.log | grep -q 'station dump 失败' && ok "iw 缺失记 WARN" || bad "iw 缺失没有 WARN 日志"

UCI set traffic-stats.settings.station_ifaces='phy0.1-ap0,phy0.0-ap1'; UCI commit traffic-stats

echo "=== 15. 坏文件容错 + 大表裁剪（ubus 262144 字节上限）==="
printf 'this is not json' > /etc/traffic-stats/stations/broken.json
TRAFFIC_STATS_METHOD=get_stations ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/traffic-stats.uc > /tmp/s3.json 2>/tmp/s3.err
R=$(F=/tmp/s3.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let ids=[];
  for (let n in (d.nodes ?? [])) push(ids, n.node_id);
  print(sprintf("%d|%d", length(d.stations ?? []), length(d.nodes ?? [])));')
[ "${R%%|*}" -ge 5 ] && ok "坏文件被跳过，仍返回好数据（$R）" || { bad "坏文件容错失败：$R"; cat /tmp/s3.err; }
rm -f /etc/traffic-stats/stations/broken.json

ucode -e '
  let fs = require("fs");
  let st = [];
  for (let i = 0; i < 500; i++)
    push(st, { mac: sprintf("02:00:00:00:%02x:%02x", int(i / 256), i % 256),
      iface: "phy0.1-ap0", signal: -50 - (i % 40), rx_rate: 866600, tx_rate: 650000, connected_sec: 3600 });
  fs.writefile("/etc/traffic-stats/stations/stress.json", sprintf("%J", { v: 1, node_id: "stress", name: "压测 AP", ts: time() - 10, stations: st }));'
B=$(ubus call traffic-stats get_stations 2>/tmp/ubus3.err)
SZ=$(printf '%s' "$B" | wc -c)
echo "$B" > /tmp/s4.json
N4=$(F=/tmp/s4.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(d.count ?? -1);')
[ "$N4" -ge 1 ] && [ "$N4" -le 400 ] && ok "500 站点被裁到 $N4 条（预算内）" || { bad "裁剪异常 count=$N4"; cat /tmp/ubus3.err; }
[ "$SZ" -lt 262144 ] && ok "响应 $SZ 字节 < 262144（ubus 上限内）" || bad "响应 $SZ 字节超过 ubus 上限"
rm -f /etc/traffic-stats/stations/stress.json

echo "=== 16. 卸载后系统目录仍然正常（回滚路径）==="
opkg remove luci-app-traffic-stats >/tmp/r1.log 2>&1 && ok "卸载 luci-app 成功" || { bad "卸载 luci-app 失败"; tail -3 /tmp/r1.log; }
opkg remove traffic-stats >/tmp/r2.log 2>&1 && ok "卸载 traffic-stats 成功" || { bad "卸载 traffic-stats 失败"; tail -3 /tmp/r2.log; }
[ "$B_ETC" = "$(perm /etc)" ] && ok "卸载后 /etc 仍是 $B_ETC" || bad "卸载后 /etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "卸载后 /usr 仍是 $B_USR" || bad "卸载后 /usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "卸载后 /www 仍是 $B_WWW" || bad "卸载后 /www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "卸载后 /www/cgi-bin 仍是 $B_CGI" || bad "卸载后 /www/cgi-bin 被改动"
[ ! -e /www/cgi-bin/traffic-stats-stations ] && ok "CGI 已随包移除" || bad "CGI 卸载后残留"
[ ! -e /usr/share/traffic-stats/stations.uc ] && ok "stations.uc 已随包移除" || bad "stations.uc 卸载后残留"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
