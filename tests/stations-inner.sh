#!/bin/sh
mkdir -p /var/lock /var/run /tmp /fakebin /etc/traffic-stats/stations /tmp/traffic-stats
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "=== 1. 安装包并核对权限未变 ==="
B=$(ls -ld /etc /usr /www | awk '{print $1,$3":"$4}' | tr '\n' '|')
opkg install --force-depends /src/dist/traffic-stats_1.0.0-1_all.ipk >/dev/null 2>&1 && ok "traffic-stats 安装" || bad "traffic-stats 安装"
opkg install --force-depends /src/dist/luci-app-traffic-stats_1.0.0-1_all.ipk >/dev/null 2>&1 && ok "luci-app 安装" || bad "luci-app 安装"
A=$(ls -ld /etc /usr /www | awk '{print $1,$3":"$4}' | tr '\n' '|')
[ "$B" = "$A" ] && ok "系统目录权限未变" || bad "系统目录权限被改动: $B -> $A"
[ -x /www/cgi-bin/traffic-stats-stations ] && ok "站点 CGI 已安装且可执行" || bad "站点 CGI 缺失"
[ "$(ls -ld /usr/share/traffic-stats | awk '{print $3":"$4}')" = "root:root" ] && ok "stations.uc 目录属主 root" || bad "目录属主异常"

echo "=== 2. stations.uc 解析假 iw 输出（dry-run）==="
cat > /fakebin/iw <<'EOF'
#!/bin/sh
cat <<OUT
phy#0
	Interface phy0.1-ap0
Station 22:77:08:69:a9:1f (on phy0.1-ap0)
	signal:  	-53 [-61, -57, -55, -62] dBm
	rx bitrate:	866.7 MBit/s
	tx bitrate:	650.0 MBit/s
	connected time:	3600 seconds
OUT
EOF
chmod +x /fakebin/iw
printf 'config settings "settings"\n\toption node_id "ap-1"\n\toption mother_url "http://127.0.0.1"\n\toption mother_enabled "1"\n\toption stations_enabled "1"\n\toption stations_token "tok123"\n\toption station_ifaces "phy0.1-ap0"\n' > /etc/config/traffic-stats
OUT=$(PATH=/fakebin:$PATH TRAFFIC_STATS_STATIONS_DRY=1 ucode /f/stations.uc 2>&1)
# 输出里的 JSON 是转义过的（body 是字符串），所以按值匹配而不是按字段引号匹配
echo "$OUT" | grep -q '22:77:08:69:a9:1f' && ok "解析出站点 MAC" || bad "未解析出 MAC"
echo "$OUT" | grep -q 'signal[^0-9-]*-53' && ok "解析出信号 -53" || bad "信号解析失败"
echo "$OUT" | grep -q '866700' && ok "速率换算正确（866.7 MBit/s → 866700）" || bad "速率换算错误"

echo "=== 3. 接收端：正常 / 负例 ==="
BODY='{"node_id":"ap-1","name":"客厅AP","ts":1794714000,"stations":[{"mac":"22:77:08:69:a9:1f","iface":"phy0.1-ap0","signal":-53,"rx_rate":866700,"tx_rate":650000,"connected_sec":3600}]}'
NOW=$(date +%s)
R=$(printf "%s" "$BODY" | REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} CONTENT_TYPE=application/json \
  HTTP_X_NODE_ID=ap-1 HTTP_X_TIMESTAMP=$NOW HTTP_X_TOKEN=tok123 ucode /www/cgi-bin/traffic-stats-stations 2>&1)
echo "$R" | grep -q '"code":0' && ok "正常请求被接受" || bad "正常请求失败: $R"
[ -f /etc/traffic-stats/stations/ap-1.json ] && ok "落盘 ap-1.json" || bad "未落盘"
[ "$(ls -l /etc/traffic-stats/stations/ap-1.json | awk '{print $3":"$4" "$1}')" = "root:root -rw-r--r--" ] && ok "落盘权限 root:root 644" || bad "落盘权限异常"

R2=$(printf "%s" "$BODY" | REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} CONTENT_TYPE=application/json \
  HTTP_X_NODE_ID=ap-1 HTTP_X_TIMESTAMP=$NOW HTTP_X_TOKEN=wrong ucode /www/cgi-bin/traffic-stats-stations 2>&1)
echo "$R2" | grep -q '"code":1' && ok "错 token 被拒" || bad "错 token 未拒: $R2"

R3=$(printf "%s" "$BODY" | REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} CONTENT_TYPE=application/json \
  HTTP_X_NODE_ID=ap-1 HTTP_X_TIMESTAMP=$((NOW-1000)) HTTP_X_TOKEN=tok123 ucode /www/cgi-bin/traffic-stats-stations 2>&1)
echo "$R3" | grep -q '"code":2' && ok "过期时间戳被拒" || bad "过期时间戳未拒: $R3"

R4=$(printf "%s" "$BODY" | REQUEST_METHOD=POST CONTENT_LENGTH=${#BODY} CONTENT_TYPE=application/json \
  HTTP_X_NODE_ID=../evil HTTP_X_TIMESTAMP=$NOW HTTP_X_TOKEN=tok123 ucode /www/cgi-bin/traffic-stats-stations 2>&1)
echo "$R4" | grep -q '"code":4' && ok "越权 node_id 被拒" || bad "越权未拒: $R4"
[ ! -e /etc/traffic-stats/stations/evil.json ] && ok "未产生越权文件" || bad "产生了越权文件"

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
