#!/bin/sh
# 子母多节点用例（容器内执行；由 tests/container-validate-nodes.sh 调用）
#
# 覆盖：装包权限 → get_nodes 空态 → push.uc 真推（经 uhttpd + CGI）→ 快照/jsonl 落盘 →
#       rpcd get_nodes（含 LuCI /ubus ACL 路径）→ 独立复算签名与各种负例 → 坏文件容错 →
#       jsonl 5 分钟对齐/2000 行裁剪 → node_id 自动生成 → 未配置时静默。
#
# 隔离：只在 127.0.0.1 上跑，不访问外网、不接触任何真机。
mkdir -p /var/run/ubus /var/lock /tmp /www/cgi-bin

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

echo "=== 0. 安装前基线 ==="
B_ETC=$(perm /etc); B_USR=$(perm /usr); B_WWW=$(perm /www); B_CGI=$(perm /www/cgi-bin)
echo "  /etc=$B_ETC  /usr=$B_USR  /www=$B_WWW  /www/cgi-bin=$B_CGI"

echo "=== 1. 安装两个包 ==="
opkg install /src/dist/prism-router_1.0.0-1_all.ipk >/tmp/i1.log 2>&1 && ok "安装 prism-router" || { bad "安装 prism-router"; tail -5 /tmp/i1.log; }
opkg install /src/dist/luci-app-prism-router_1.0.0-1_all.ipk >/tmp/i2.log 2>&1 && ok "安装 luci-app-prism-router" || { bad "安装 luci-app"; tail -5 /tmp/i2.log; }

echo "=== 2. 新文件落位与权限 ==="
check /usr/share/prism-router/push.uc "root:root -rw-r--r--"
check /www/cgi-bin/prism-router-ingest "root:root -rwxr-xr-x"
check /www/cgi-bin "root:root drwxr-xr-x"
check /www/luci-static/resources/view/prism-router/nodes.js "root:root -rw-r--r--"
check /usr/share/luci/menu.d/luci-app-prism-router.json "root:root -rw-r--r--"
check /usr/share/rpcd/ucode/prism-router.uc "root:root -rw-r--r--"
check /etc/config/prism-router "root:root -rw-r--r--"
grep -q "prism-router/nodes" /usr/share/luci/menu.d/luci-app-prism-router.json \
  && ok "menu.d 含节点页" || bad "menu.d 没有节点页"
grep -q '"get_nodes"' /usr/share/rpcd/acl.d/luci-app-prism-router.json \
  && ok "ACL 放行 get_nodes" || bad "ACL 缺少 get_nodes"
grep -q "node_id" /etc/config/prism-router && ok "config 含子母选项" || bad "config 缺少子母选项"

echo "=== 3. 系统目录权限未被改动（回归）==="
[ "$B_ETC" = "$(perm /etc)" ] && ok "/etc 未变" || bad "/etc 被改动"
[ "$B_USR" = "$(perm /usr)" ] && ok "/usr 未变" || bad "/usr 被改动"
[ "$B_WWW" = "$(perm /www)" ] && ok "/www 未变" || bad "/www 被改动"
[ "$B_CGI" = "$(perm /www/cgi-bin)" ] && ok "/www/cgi-bin 未变" || bad "/www/cgi-bin 被改动"

echo "=== 4. ucode 语法 ==="
ucode -c /usr/share/prism-router/push.uc && ok "push.uc 语法 OK" || bad "push.uc 语法错误"
ucode -c /www/cgi-bin/prism-router-ingest && ok "ingest(CGI) 语法 OK" || bad "ingest 语法错误"
ucode -c /usr/share/rpcd/ucode/prism-router.uc && ok "rpcd uc 语法 OK" || bad "rpcd uc 语法错误"

echo "=== 5. get_nodes 空态（还没有任何节点上报）==="
rm -rf /etc/prism-router/nodes
out=$(PRISM_ROUTER_METHOD=get_nodes ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc 2>/tmp/n0.err)
echo "$out" > /tmp/n0.json
N=$(F=/tmp/n0.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(length(d.nodes ?? []));')
[ "$N" = "0" ] && ok "空态 nodes=[]（未崩、未报错）" || { bad "空态 nodes=$N"; cat /tmp/n0.err; }

echo "=== 6. 起 uhttpd / ubusd / rpcd ==="
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

echo "=== 7. 配置子节点（UCI）==="
UCI set prism-router.settings.lan_ranges='192.168.100.0/24'
UCI set prism-router.settings.mother_enabled='1'
UCI set prism-router.settings.mother_url='http://127.0.0.1:8080'
UCI set prism-router.settings.mother_secret='testsecret'
# 本用例专门回归 v1 报文/查询串兼容；默认拒绝由 security-fixes 门禁覆盖。
UCI set prism-router.settings.legacy_shared_secret='1'
UCI set prism-router.settings.node_id='node-a'
UCI set prism-router.settings.node_name='客厅 AP'
UCI commit prism-router
[ "$(CGET prism-router.settings.node_id)" = "node-a" ] && ok "UCI 子母选项写入成功" || bad "UCI 写入失败"

echo "=== 8. 守护进程离线跑一次，生成 state.json ==="
mkdir -p /tmp/prism-router
cp -f /fixtures/dhcp.leases /tmp/dhcp.leases 2>/dev/null
rm -f /tmp/prism-router/state.json
PRISM_ROUTER_ONCE=1 PRISM_ROUTER_CONNTRACK_FILE=/fixtures/nf_conntrack \
PRISM_ROUTER_CLASH_API=127.0.0.1:1 ucode /usr/bin/prism-routerd >/tmp/daemon.log 2>&1
if [ -f /tmp/prism-router/state.json ]; then
  ok "state.json 生成 ($(wc -c < /tmp/prism-router/state.json) 字节)"
else
  bad "state.json 未生成"; tail -5 /tmp/daemon.log
fi

echo "=== 9. push.uc 真推 → uhttpd → CGI 落盘 ==="
ucode /usr/share/prism-router/push.uc
RC=$?
[ "$RC" = "0" ] && ok "push.uc 退出码 0" || bad "push.uc 退出码 $RC"
[ -f /etc/prism-router/nodes/node-a.json ] && ok "快照 /etc/prism-router/nodes/node-a.json 已落盘" || { bad "快照未落盘"; tail -3 /tmp/prism-router/push.log; }
check /etc/prism-router/nodes "root:root drwxr-xr-x"
check /etc/prism-router/nodes/node-a.json "root:root -rw-r--r--"
check /etc/prism-router/nodes/node-a.jsonl "root:root -rw-r--r--"

R=$(F=/etc/prism-router/nodes/node-a.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F")));
  print(sprintf("%s|%s|%d|%d|%d|%d", d.node_id, d.name, d.totals.direct_rx, d.totals.proxy_rx, length(d.devices), length(d.apps)));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "node-a" ] && ok "快照 node_id=node-a" || bad "快照 node_id=$1"
[ "$2" = "客厅 AP" ] && ok "快照 name=客厅 AP（UTF-8 正常）" || bad "快照 name=[$2]"
[ "$3" = "900240" ] && ok "快照 totals.direct_rx=$3（与 state.json 一致，fake-ip 未双计）" || bad "快照 direct_rx=$3 期望 900240"
[ "$5" -ge 1 ] && ok "快照 devices=$5（<=20）" || bad "快照 devices=$5"
[ "$6" -le 20 ] && ok "快照 apps=$6（<=20）" || bad "快照 apps=$6 超上限"

echo "=== 10. jsonl 5 分钟对齐 ==="
LINES=$(wc -l < /etc/prism-router/nodes/node-a.jsonl)
LASTTS=$(F=/etc/prism-router/nodes/node-a.jsonl ucode -e 'let fs=require("fs"); let a=split(fs.readfile(getenv("F")), "\n"); let last="";
  for (let l in a) if (length(trim(l))) last=l; let d=json(last); print(d.ts);')
[ "$((LASTTS % 300))" = "0" ] && ok "jsonl ts=$LASTTS 已按 300 秒对齐（$LINES 行）" || bad "jsonl ts=$LASTTS 未对齐"
ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
R=$(F=/etc/prism-router/nodes/node-a.jsonl ucode -e 'let fs=require("fs"); let a=split(fs.readfile(getenv("F")), "\n");
  let n=0, prev=-1, bad=0;
  for (let l in a) { l=trim(l); if (!length(l)) continue;
    let t=json(l).ts; n++;
    if (t % 300) bad++;
    if (prev >= 0 && t - prev != 300) bad++;
    prev=t; }
  print(sprintf("%d|%d", n, bad));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" -ge 1 ] && [ "$1" -le 2 ] && ok "连续两次推送后 jsonl 仍为 $1 行（同桶不重复写）" || bad "jsonl 行数异常：$1"
[ "$2" = "0" ] && ok "jsonl 每行 5 分钟桶严格递增且对齐" || bad "jsonl 时间序列异常（$2 处）"

echo "=== 11. get_nodes 有数据 ==="
PRISM_ROUTER_METHOD=get_nodes ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc > /tmp/n1.json 2>/tmp/n1.err
R=$(F=/tmp/n1.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let n=d.nodes[0];
  print(sprintf("%d|%s|%s|%d|%d", length(d.nodes), n.node_id, n.name, n.latest.totals.direct_rx, length(n.latest.devices)));')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "1" ] && ok "get_nodes 返回 1 个节点" || { bad "get_nodes 节点数=$1"; cat /tmp/n1.err; }
[ "$2" = "node-a" ] && ok "node_id=node-a" || bad "node_id=$2"
[ "$3" = "客厅 AP" ] && ok "name=客厅 AP" || bad "name=[$3]"
[ "$4" = "900240" ] && ok "latest.totals.direct_rx=$4" || bad "direct_rx=$4 期望 900240"
[ "$5" -ge 1 ] && ok "latest.devices=$5 条" || bad "latest.devices=$5"

echo "=== 12. 真实 ubus → rpcd 插件 ==="
B=$(ubus call prism-router get_nodes 2>/tmp/ubus.err)
echo "$B" > /tmp/n2.json
N2=$(F=/tmp/n2.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(length(d.nodes ?? []));')
[ "$N2" = "1" ] && ok "ubus call prism-router get_nodes → 1 个节点" || { bad "ubus 节点数=$N2"; cat /tmp/ubus.err; }

echo "=== 12.5 压力：60 节点 × 20 设备，ubus 单条消息不超 262144 字节 ==="
ucode -e '
  let fs = require("fs");
  for (let n = 0; n < 60; n++) {
    let devs = [], apps = [];
    for (let i = 0; i < 20; i++)
      push(devs, { ip: sprintf("192.168.100.%d", i + 1), mac: sprintf("aa:bb:cc:dd:ee:%02x", i),
        hostname: sprintf("host-%d-%d", n, i), direct_rx: 123456789, direct_tx: 1234,
        proxy_rx: 987654321, proxy_tx: 5678, rx_rate: 1, tx_rate: 2, last_seen: 1794676000 });
    for (let i = 0; i < 20; i++)
      push(apps, { host: sprintf("app-%d-%d.example.com", n, i), rx: 1234567, tx: 8910, chain: "US2-HY2", devices: 3 });
    let snap = { v: 1, node_id: sprintf("stress-%02d", n), name: sprintf("压测节点 %d", n),
      ts: time() - 30, received_ts: time(),
      totals: { direct_rx: 1, direct_tx: 2, proxy_rx: 3, proxy_tx: 4, rx_rate: 5, tx_rate: 6 },
      nodes: { "US2-HY2": { rx: 1, tx: 2 }, DIRECT: { rx: 3, tx: 4 } }, devices: devs, apps: apps };
    fs.writefile(sprintf("/etc/prism-router/nodes/stress-%02d.json", n), sprintf("%J", snap));
  }'
B=$(ubus call prism-router get_nodes 2>/tmp/ubus2.err)
SZ=$(printf '%s' "$B" | wc -c)
echo "$B" > /tmp/n4.json
N4=$(F=/tmp/n4.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(length(d.nodes ?? []));')
[ -n "$N4" ] && [ "$N4" -ge 6 ] && ok "压测下仍返回 $N4 个节点（自动降级裁剪）" || { bad "压测返回节点数异常：$N4"; cat /tmp/ubus2.err; }
[ "$SZ" -lt 262144 ] && ok "响应 $SZ 字节 < 262144（ubus 上限内）" || bad "响应 $SZ 字节超过 ubus 上限"
rm -f /etc/prism-router/nodes/stress-*.json

echo "=== 13. LuCI /ubus ACL 路径（root 会话）==="
LOGIN=$(curl -sS -m 5 -X POST http://127.0.0.1:8080/ubus -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"root","password":""}]}')
SID=$(echo "$LOGIN" | sed -n "s/.*\"ubus_rpc_session\":\"\([0-9a-f]\{32\}\)\".*/\1/p")
if [ -n "$SID" ]; then
  ok "session.login 成功"
  ACLRES=$(curl -sS -m 5 -X POST http://127.0.0.1:8080/ubus -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"$SID\",\"prism-router\",\"get_nodes\",{}]}")
  case "$ACLRES" in
    *"Access denied"*) bad "get_nodes 被 ACL 拒绝（acl.d 需包含 get_nodes）";;
    *'"nodes"'*) ok "root 会话可调用 get_nodes（ACL 正确）";;
    *) bad "get_nodes 返回异常：$(echo "$ACLRES" | head -c 200)";;
  esac
else
  bad "session.login 失败，跳过 ACL 用例"
fi

echo "=== 14. 独立复算签名（不依赖 push.uc，验证算法与契约一致）==="
PRISM_ROUTER_PUSH_DRY=1 ucode /usr/share/prism-router/push.uc > /tmp/dry.json 2>/tmp/dry.err
ucode -e 'let fs=require("fs"); let d=json(fs.readfile("/tmp/dry.json")); fs.writefile("/tmp/body.json", d.body);' || bad "无法从 dry-run 取 body"
if [ -s /tmp/body.json ]; then
  ok "dry-run 产出 body ($(wc -c < /tmp/body.json) 字节)"
else
  bad "dry-run body 为空"; cat /tmp/dry.err
fi
TS=$(date +%s)
HASH=$(sha256sum /tmp/body.json | cut -d' ' -f1)
SIGN=$(printf '%s\n%s\n%s' node-a "$TS" "$HASH" | openssl dgst -sha256 -hmac 'testsecret' -binary | openssl base64 -A)
SIGN_ENC=$(printf '%s' "$SIGN" | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g')
POST_Q="node_id=node-a&ts=$TS&sign=$SIGN_ENC"
curl -sS -m 8 -o /tmp/r1.json -w '%{http_code}' -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?$POST_Q" \
  -H "Content-Type: application/json" --data-binary @/tmp/body.json > /tmp/r1.status 2>/dev/null
C=$(code_of /tmp/r1.json)
[ "$C" = "0" ] && ok "独立算出的签名被接收（{\"code\":0}）" || bad "独立签名被拒：code=$C $(head -c 160 /tmp/r1.json)"

echo "=== 15. 负例：篡改 body / 错过时间窗 / 错密钥 / 非法 node_id / 超大 body / 缺签名 ==="
# 合法 JSON 但内容被改（字节变了，sha256 变，签名对不上）
ucode -e 'let fs=require("fs"); let t=fs.readfile("/tmp/body.json"); fs.writefile("/tmp/body-bad.json", replace(t, /"direct_rx":[0-9]+/, "\"direct_rx\":1"));'
SIGN_BAD=$(printf '%s\n%s\n%s' node-a "$TS" "$HASH" | openssl dgst -sha256 -hmac 'testsecret' -binary | openssl base64 -A | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g')
curl -sS -m 8 -o /tmp/r2.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS&sign=$SIGN_BAD" \
  -H "Content-Type: application/json" --data-binary @/tmp/body-bad.json >/dev/null 2>&1
C=$(code_of /tmp/r2.json); [ "$C" = "1" ] && ok "篡改 body（合法 JSON）→ code=1（签名不匹配）" || bad "篡改 body → code=$C 期望 1"

# 半截 / 非 JSON 的 body
printf '{"node_id":"node-a",' > /tmp/body-garbage.json
curl -sS -m 8 -o /tmp/r2b.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS&sign=$SIGN_BAD" \
  -H "Content-Type: application/json" --data-binary @/tmp/body-garbage.json >/dev/null 2>&1
C=$(code_of /tmp/r2b.json); [ "$C" = "4" ] && ok "坏 JSON body → code=4（拒绝且不崩）" || bad "坏 JSON body → code=$C 期望 4"

TS_OLD=$((TS - 1000))
HASH_OLD=$(sha256sum /tmp/body.json | cut -d' ' -f1)
SIGN_OLD=$(printf '%s\n%s\n%s' node-a "$TS_OLD" "$HASH_OLD" | openssl dgst -sha256 -hmac 'testsecret' -binary | openssl base64 -A | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g')
curl -sS -m 8 -o /tmp/r3.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS_OLD&sign=$SIGN_OLD" \
  -H "Content-Type: application/json" --data-binary @/tmp/body.json >/dev/null 2>&1
C=$(code_of /tmp/r3.json); [ "$C" = "2" ] && ok "时间戳早 1000 秒 → code=2（超出 300 秒容差）" || bad "过期时间戳 → code=$C 期望 2"

SIGN_WRONG=$(printf '%s\n%s\n%s' node-a "$TS" "$HASH" | openssl dgst -sha256 -hmac 'wrongsecret' -binary | openssl base64 -A | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g')
curl -sS -m 8 -o /tmp/r4.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS&sign=$SIGN_WRONG" \
  -H "Content-Type: application/json" --data-binary @/tmp/body.json >/dev/null 2>&1
C=$(code_of /tmp/r4.json); [ "$C" = "1" ] && ok "错密钥 → code=1" || bad "错密钥 → code=$C 期望 1"

curl -sS -m 8 -o /tmp/r5.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=..%2Fevil&ts=$TS&sign=$SIGN_ENC" \
  -H "Content-Type: application/json" --data-binary @/tmp/body.json >/dev/null 2>&1
C=$(code_of /tmp/r5.json); [ "$C" = "4" ] && ok "非法 node_id（../evil）→ code=4" || bad "非法 node_id → code=$C 期望 4"
[ ! -e /etc/prism-router/evil.json ] && [ ! -e /etc/evil.json ] && ok "没有越权写出文件" || bad "目录穿越：出现了 evil.json"

ucode -e 'let fs=require("fs"); let s=""; for (let i=0;i<8300;i++) s+="0123456789abcdef"; fs.writefile("/tmp/big.json", s);'
BIGSTATUS=$(curl -sS -m 8 -o /tmp/r6.json -w '%{http_code}' -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS&sign=$SIGN_ENC" \
  -H "Content-Type: application/json" --data-binary @/tmp/big.json 2>/dev/null)
CBIG=$(code_of /tmp/r6.json)
[ "$BIGSTATUS" = "413" ] || [ "$CBIG" = "413" ] && ok "超大 body（$(( $(wc -c < /tmp/big.json) )) 字节）被拒（HTTP $BIGSTATUS / code=$CBIG）" \
  || bad "超大 body 未被拒：HTTP=$BIGSTATUS code=$CBIG"

curl -sS -m 8 -o /tmp/r7.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS" \
  -H "Content-Type: application/json" --data-binary @/tmp/body.json >/dev/null 2>&1
C=$(code_of /tmp/r7.json); [ "$C" = "1" ] && ok "缺签名 → code=1" || bad "缺签名 → code=$C 期望 1"

echo "=== 16. 母节点未配置密钥时拒绝接收 ==="
UCI set prism-router.settings.mother_secret=''
UCI commit prism-router
curl -sS -m 8 -o /tmp/r8.json -X POST "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=node-a&ts=$TS&sign=$SIGN_ENC" \
  -H "Content-Type: application/json" --data-binary @/tmp/body.json >/dev/null 2>&1
C=$(code_of /tmp/r8.json); [ "$C" = "3" ] && ok "mother_secret 为空 → code=3（拒绝匿名写入）" || bad "缺密钥 → code=$C 期望 3"
UCI set prism-router.settings.mother_secret='testsecret'; UCI commit prism-router

echo "=== 17. 坏文件容错（单个文件坏掉不影响其它节点）==="
printf 'this is not json' > /etc/prism-router/nodes/broken.json
PRISM_ROUTER_METHOD=get_nodes ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc > /tmp/n3.json 2>/tmp/n3.err
R=$(F=/tmp/n3.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); print(sprintf("%d|%s", length(d.nodes ?? []), (d.nodes[0].node_id ?? "?")));')
[ "$R" = "1|node-a" ] && ok "坏文件被跳过，仍返回 node-a" || { bad "坏文件容错失败：$R"; cat /tmp/n3.err; }
rm -f /etc/prism-router/nodes/broken.json

echo "=== 17.5 字段类型错乱 / 过期节点 ==="
cat > /etc/prism-router/nodes/weird.json <<EOF
{"node_id":"weird","name":"字段类型错乱","ts":$(($(date +%s) - 900)),"totals":"not-an-object","nodes":[1,2,3],"devices":{},"apps":7}
EOF
PRISM_ROUTER_METHOD=get_nodes ucode -L /usr/lib/ucode /usr/share/rpcd/ucode/prism-router.uc > /tmp/n5.json 2>/tmp/n5.err
R=$(F=/tmp/n5.json ucode -e 'let fs=require("fs"); let d=json(fs.readfile(getenv("F"))); let w=null;
  for (let n in d.nodes) if (n.node_id == "weird") w=n;
  print(w ? sprintf("%d|%d|%d|%d|%s", length(d.nodes), w.age_sec, length(w.latest.devices), length(w.latest.apps), (type(w.latest.totals)=="object" ? "obj" : "bad")) : "missing");')
OLDIFS=$IFS; IFS='|'; set -- $R; IFS=$OLDIFS
[ "$1" = "2" ] && ok "类型错乱的节点仍被返回（不崩）" || { bad "类型错乱处理失败：$R"; cat /tmp/n5.err; }
[ "$2" -ge 300 ] && ok "过期节点 age_sec=$2（>300，前端据此标黄）" || bad "age_sec=$2 期望 >=300"
[ "$3" = "0" ] && [ "$4" = "0" ] && ok "devices/apps 类型错误 → 退化为空数组" || bad "devices=$3 apps=$4"
[ "$5" = "obj" ] && ok "totals 类型错误 → 退化为全 0 对象" || bad "totals=$5"
rm -f /etc/prism-router/nodes/weird.json

echo "=== 18. jsonl 2000 行上限（超出裁掉最旧）==="
ucode -e 'let fs=require("fs"); let s=""; for (let i=0;i<2000;i++) s += sprintf("{\"ts\":%d,\"totals\":{}}\n", 1000000 + i*300); fs.writefile("/etc/prism-router/nodes/node-a.jsonl", s);'
ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
LINES3=$(wc -l < /etc/prism-router/nodes/node-a.jsonl)
FIRST=$(F=/etc/prism-router/nodes/node-a.jsonl ucode -e 'let fs=require("fs"); let a=split(fs.readfile(getenv("F")), "\n"); print(json(a[0]).ts);')
[ "$LINES3" = "2000" ] && ok "jsonl 仍为 2000 行（裁掉最旧）" || bad "jsonl 行数=$LINES3 期望 2000"
[ "$FIRST" = "1000300" ] && ok "最旧一行被裁掉（首行 ts=$FIRST）" || bad "裁剪不对，首行 ts=$FIRST 期望 1000300"
LASTTS2=$(F=/etc/prism-router/nodes/node-a.jsonl ucode -e 'let fs=require("fs"); let a=split(fs.readfile(getenv("F")), "\n"); let last=""; for (let l in a) if (length(trim(l))) last=l; print(json(last).ts);')
[ "$((LASTTS2 % 300))" = "0" ] && ok "新追加行 ts=$LASTTS2 仍对齐" || bad "新行未对齐：$LASTTS2"

echo "=== 19. node_id 自动生成（空值首次推送）==="
UCI delete prism-router.settings.node_id; UCI commit prism-router
ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
AUTO=$(CGET prism-router.settings.node_id)
case "$AUTO" in
  '') bad "node_id 未自动生成";;
  *) echo "$AUTO" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' && ok "node_id 自动生成并写回 UCI：$AUTO" || bad "生成的 node_id 不合法：$AUTO";;
esac
[ -f "/etc/prism-router/nodes/$AUTO.json" ] && ok "自动 node_id 的快照已生成" || bad "自动 node_id 快照缺失"
UCI set prism-router.settings.node_id='node-a'; UCI commit prism-router
rm -f "/etc/prism-router/nodes/$AUTO.json" "/etc/prism-router/nodes/$AUTO.jsonl"

echo "=== 20. 未启用/未配置时静默（cron 友好）==="
BEFORE=$(wc -l < /tmp/prism-router/push.log)
UCI set prism-router.settings.mother_enabled='0'; UCI commit prism-router
ucode /usr/share/prism-router/push.uc; RC=$?
AFTER=$(wc -l < /tmp/prism-router/push.log)
[ "$RC" = "0" ] && [ "$AFTER" = "$BEFORE" ] && ok "mother_enabled=0 → 退出 0 且不写日志" || bad "mother_enabled=0 时 rc=$RC 日志变化=$((AFTER-BEFORE))"
UCI set prism-router.settings.mother_enabled='1'
UCI set prism-router.settings.mother_url=''; UCI commit prism-router
ucode /usr/share/prism-router/push.uc; RC=$?
[ "$RC" = "0" ] && ok "mother_url 留空 → 退出 0（不推送）" || bad "mother_url 留空时 rc=$RC"
UCI set prism-router.settings.mother_url='http://127.0.0.1:8080'; UCI commit prism-router

echo "=== 21. state.json 缺失时 push 不崩 ==="
mkdir -p /tmp/empty-state
PRISM_ROUTER_STATE_DIR=/tmp/empty-state ucode /usr/share/prism-router/push.uc; RC=$?
[ "$RC" = "0" ] && ok "state.json 缺失 → 退出 0（只记日志）" || bad "state.json 缺失时 rc=$RC"

echo "=== 22. push 失败路径：非 200 / 响应 code!=0 / 连不上 都退出 0 ==="
# 桩 CGI：HTTP 200 但业务 code=7（模拟母节点拒收）
printf '%s\n' '#!/bin/sh' 'printf "Content-Type: application/json\r\n\r\n{\"code\":7,\"msg\":\"stub reject\"}\n"' > /www/cgi-bin/ts-fail
chmod 755 /www/cgi-bin/ts-fail
UCI set prism-router.settings.mother_url='http://127.0.0.1:8080/cgi-bin/ts-fail'; UCI commit prism-router
ucode /usr/share/prism-router/push.uc; RC=$?
grep -q 'code=7' /tmp/prism-router/push.log && ok "响应 code!=0 → 记日志 code=7" || bad "没有记录 code=7 的失败日志"
[ "$RC" = "0" ] && ok "响应 code!=0 → 退出 0（下个周期再试）" || bad "响应 code!=0 时 rc=$RC"

UCI set prism-router.settings.mother_url='http://127.0.0.1:8080/nope'; UCI commit prism-router
ucode /usr/share/prism-router/push.uc; RC=$?
grep -q 'HTTP 404' /tmp/prism-router/push.log && ok "非 200（404）→ 记日志" || bad "没有记录 404 失败日志"
[ "$RC" = "0" ] && ok "非 200 → 退出 0" || bad "非 200 时 rc=$RC"

UCI set prism-router.settings.mother_url='http://127.0.0.1:9'; UCI commit prism-router
ucode /usr/share/prism-router/push.uc; RC=$?
[ "$RC" = "0" ] && ok "端口关闭（连不上）→ 退出 0" || bad "连不上时 rc=$RC"
rm -f /www/cgi-bin/ts-fail
UCI set prism-router.settings.mother_url='http://127.0.0.1:8080'; UCI commit prism-router

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
