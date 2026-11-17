#!/bin/sh
# 节点认证与密钥安全用例（容器内执行；由 tests/container-validate-security-fixes.sh 调用）
#
# 覆盖本次修复的硬要求：
#   1. 每节点独立 secret，nodeA 不能写 nodeB/未知 node_id；
#   2. v2 签名含 nonce，母节点原子占用 + TTL，重放被拒；
#   3. Content-Length > MAX 读取前拒；实际读取夹到 MAX+1；声明/实际不符拒；
#   4. HMAC 的 secret 不进 argv / 环境变量（用包装 sha256sum/curl 记录真实 argv）；
#   5. curl 不 -k、不自动跨源重定向；同源 http->https 才允许；TLS 默认验证；
#   6. feishu/tenant token 临时文件 0600，日志不含 webhook/secret；
#   7. legacy 开关默认关，显式打开才接受 v1 旧签名/旧 station token；
#   8. Content-Length 先 ^[0-9]+$、再十进制上限、最后 integer()，拒 12abc/1e3/逗号/空白；
#   9. /tmp/prism-router、.auth、nonces、station-nonces 及节点子目录必须是 root 真实目录，
#      symlink / 非 root 属主失败关闭，且不向 symlink 目标写 nonce/日志；
#  10. 无 sha256sum 时 openssl 回退解析 `SHA2-256(stdin)= <64hex>` 尾部，主格式不变。
#
# 隔离：只在 127.0.0.1 上跑，不访问外网、不接触真机。

mkdir -p /www/cgi-bin /etc/config /etc/prism-router /tmp/prism-router /tmp/bin /tmp/ts

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3（期望[$2] 实际[$1]）"; }
# 容器里没有 GNU/完整 busybox stat；用 ucode lstat 读 uid/gid/mode，避免依赖 ls 文本格式。
perm(){ P="$1" ucode -e 'import { lstat } from "fs"; const s = lstat(getenv("P")); if (s) print(sprintf("%d:%d %o", s.uid, s.gid, s.mode & 511));' 2>/dev/null; }
owner(){ P="$1" ucode -e 'import { lstat } from "fs"; const s = lstat(getenv("P")); if (s) print(s.uid);' 2>/dev/null; }
CGET(){ uci -q get "$1" 2>/dev/null; }
code_of(){ F="$1" ucode -e 'let fs=require("fs"); let t=""; try { t=fs.readfile(getenv("F")) ?? ""; } catch (e) { t=""; }
  let d=null; try { d=json(t); } catch (e) { d=null; }
  print((d!=null && type(d)=="object") ? (d.code ?? "null") : "nojson");'; }
nonce(){ openssl rand -hex 16; }
now(){ date +%s; }

sign2(){ # node ts nonce secret bodyfile
  _h=$(sha256sum "$5" | cut -d' ' -f1)
  _m=$(printf 'v2\n%s\n%s\n%s\n%s' "$1" "$2" "$3" "$_h")
  printf '%s' "$_m" | openssl dgst -sha256 -hmac "$4" -binary | openssl base64 -A
}
sign1(){ # node ts secret bodyfile
  _h=$(sha256sum "$4" | cut -d' ' -f1)
  _m=$(printf '%s\n%s\n%s' "$1" "$2" "$_h")
  printf '%s' "$_m" | openssl dgst -sha256 -hmac "$3" -binary | openssl base64 -A
}
post2(){ # node ts nonce sign body out
  curl -sS -m 5 -o "$6" -w '%{http_code}' -X POST \
    "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=$1&ts=$2&proto=2&nonce=$3" \
    -H "Authorization: PrismRouter node_id=$1;ts=$2;proto=2;nonce=$3;sign=$4" \
    -H 'Content-Type: application/json' --data-binary @"$5"
}
urlq(){ printf '%s' "$1" | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g'; }
post1(){ # node ts sign body out
  _s=$(urlq "$3")
  curl -sS -m 5 -o "$5" -w '%{http_code}' -X POST \
    "http://127.0.0.1:8080/cgi-bin/prism-router-ingest?node_id=$1&ts=$2&sign=$_s" \
    -H 'Content-Type: application/json' --data-binary @"$4"
}

cfg_nodes(){
cat > /etc/config/prism-router <<EOF
config settings 'settings'
	option enabled '1'
	option mother_enabled '1'
	option mother_url 'http://127.0.0.1:8080'
	option node_id 'node-a'
	option mother_secret 'legacysecret'
	option legacy_shared_secret '0'
	option stations_enabled '1'
	option stations_token 'legacytok'
	option legacy_stations_token '0'
config node
	option node_id 'node-a'
	option secret 'secret-a'
config node
	option node_id 'node-b'
	option secret 'secret-b'
config station
	option node_id 'ap-1'
	option token 'tok-ap1'
config station
	option node_id 'ap-2'
	option token 'tok-ap2'
EOF
uci commit prism-router 2>/dev/null
}

echo "=== 0. 安装包 ==="
opkg install /src/dist/prism-router_1.0.0-1_all.ipk >/tmp/i.log 2>&1 && ok "安装 prism-router" || { bad "安装失败"; tail -8 /tmp/i.log; }
for f in /usr/share/prism-router/push.uc /usr/share/prism-router/stations.uc \
         /usr/share/prism-router/feishu.uc /www/cgi-bin/prism-router-ingest \
         /www/cgi-bin/prism-router-stations; do
  [ -f "$f" ] && ok "文件存在：$f" || bad "缺少 $f"
done
for f in /usr/share/prism-router/push.uc /usr/share/prism-router/stations.uc \
         /usr/share/prism-router/feishu.uc /www/cgi-bin/prism-router-ingest \
         /www/cgi-bin/prism-router-stations; do
  ucode -c "$f" >/dev/null 2>&1 && ok "语法 OK：$(basename "$f")" || bad "语法错误：$f"
done

echo "=== 1. 默认配置不预置可用秘密、legacy 默认关 ==="
grep -q "option legacy_shared_secret '0'" /etc/config/prism-router && ok "legacy_shared_secret 默认 0" || bad "缺少 legacy_shared_secret=0"
grep -q "option legacy_stations_token '0'" /etc/config/prism-router && ok "legacy_stations_token 默认 0" || bad "缺少 legacy_stations_token=0"
[ -z "$(CGET prism-router.settings.mother_secret)" ] && ok "默认 mother_secret 为空" || bad "默认预置了 mother_secret"
[ -z "$(CGET prism-router.settings.stations_token)" ] && ok "默认 stations_token 为空" || bad "默认预置了 stations_token"
grep -q '^config node' /etc/config/prism-router && bad "默认预置了 config node 秘密" || ok "默认没有预置 config node"
grep -q '^config station' /etc/config/prism-router && bad "默认预置了 config station token" || ok "默认没有预置 config station"
grep -q "mother_ca" /etc/config/prism-router && grep -q "mother_pinned_sha256" /etc/config/prism-router \
  && ok "HTTPS CA/pin 配置项存在（默认空 = 系统 CA 验证）" || bad "缺少 HTTPS CA/pin 配置项"

echo "=== 2. 启动 uhttpd（127.0.0.1:8080 / 9091）==="
cat > /www/cgi-bin/leak-check <<'CGI'
#!/bin/sh
{ echo "QS=$QUERY_STRING"; echo "AUTH=$HTTP_AUTHORIZATION"; echo "XTOKEN=$HTTP_X_TOKEN"; cat; } >> /tmp/leak.log
echo "Content-Type: application/json"
echo
echo '{"code":0}'
CGI
chmod 755 /www/cgi-bin/leak-check
cat > /www/cgi-bin/redirect-cross <<'CGI'
#!/bin/sh
echo "Status: 307 Temporary Redirect"
echo "Location: http://127.0.0.1:9091/cgi-bin/leak-check?x=1"
echo
CGI
chmod 755 /www/cgi-bin/redirect-cross
uhttpd -f -p 127.0.0.1:8080 -h /www -x /cgi-bin >/tmp/uh8080.log 2>&1 &
uhttpd -f -p 127.0.0.1:9091 -h /www -x /cgi-bin >/tmp/uh9091.log 2>&1 &
sleep 1
curl -s -o /dev/null -m 1 http://127.0.0.1:8080/ && ok "uhttpd 8080 就绪" || { bad "uhttpd 8080 未就绪"; cat /tmp/uh8080.log; }

cfg_nodes
cat > /tmp/ts/state.json <<EOF
{"ts":$(now),"totals":{"direct_rx":123,"direct_tx":45,"proxy_rx":6,"proxy_tx":7,"rx_rate":1,"tx_rate":2},"nodes":{},"devices":[],"apps":[]}
EOF

echo "=== 3. v2 正常推送 + 每节点密钥隔离 ==="
rm -rf /etc/prism-router/nodes
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc
eq "$?" "0" "push.uc 使用 config node 独立密钥退出 0"
[ -f /etc/prism-router/nodes/node-a.json ] && ok "node-a 快照落盘" || { bad "node-a 快照缺失"; tail -3 /tmp/ts/push.log; }
grep -q 'proto=2' /tmp/ts/push.log && ok "push 使用 v2 协议" || bad "push 未使用 v2"
grep -q 'node-a' /etc/prism-router/nodes/node-a.json && ok "快照 node_id=node-a" || bad "快照 node_id 错误"

# 并发临时文件：4 个 push 同时跑，快照仍必须是完整 JSON，且不残留 .tmp 文件
PIDS=""
for i in 1 2 3 4; do
  (PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1) &
  PIDS="$PIDS $!"
done
for p in $PIDS; do wait "$p"; done
CONC=$(ucode -e 'let fs=require("fs"); let d=null; try { d=json(fs.readfile("/etc/prism-router/nodes/node-a.json")); } catch (e) { d=null; } print((d != null && d.node_id == "node-a") ? "ok" : "bad");' 2>/dev/null)
eq "$CONC" "ok" "并发 push 后快照仍是完整合法 JSON"
TMPLEFT=$(ls /etc/prism-router/nodes/*.tmp.* 2>/dev/null | wc -l | tr -d ' ')
eq "$TMPLEFT" "0" "并发 push 后没有残留 .tmp 临时文件"

BODY_B='{"node_id":"node-b","name":"B","ts":1,"totals":{"direct_rx":2}}'
printf '%s' "$BODY_B" > /tmp/body-b.json
rm -f /etc/prism-router/nodes/node-b.json
TS=$(now); N=$(nonce); S=$(sign2 node-b "$TS" "$N" secret-a /tmp/body-b.json)
post2 node-b "$TS" "$N" "$S" /tmp/body-b.json /tmp/r-bad-secret.json >/tmp/h-bad-secret
eq "$(code_of /tmp/r-bad-secret.json)" "1" "node-a 的 secret 签 node-b → code=1"
[ ! -e /etc/prism-router/nodes/node-b.json ] && ok "node-a 不能写 node-b 快照" || bad "node-a 写出了 node-b 快照"

TS=$(now); N=$(nonce); S=$(sign2 node-b "$TS" "$N" secret-b /tmp/body-b.json)
post2 node-b "$TS" "$N" "$S" /tmp/body-b.json /tmp/r-b.json >/tmp/h-b
eq "$(code_of /tmp/r-b.json)" "0" "node-b 用自己的 secret → code=0"
[ -f /etc/prism-router/nodes/node-b.json ] && ok "node-b 快照落盘" || bad "node-b 快照缺失"

ODDB='{"node_id":"node-c","name":"C","ts":1,"totals":{}}'
printf '%s' "$ODDB" > /tmp/body-c.json
TS=$(now); N=$(nonce); S=$(sign2 node-c "$TS" "$N" secret-a /tmp/body-c.json)
post2 node-c "$TS" "$N" "$S" /tmp/body-c.json /tmp/r-c.json >/tmp/h-c
eq "$(code_of /tmp/r-c.json)" "1" "未知 node-c（即使有合法 secret-a 签名）→ code=1"
[ ! -e /etc/prism-router/nodes/node-c.json ] && ok "未知 node 未落盘" || bad "未知 node 落盘了"

MISB='{"node_id":"node-b","name":"B","ts":1,"totals":{}}'
printf '%s' "$MISB" > /tmp/body-mis.json
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-mis.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-mis.json /tmp/r-mis.json >/tmp/h-mis
eq "$(code_of /tmp/r-mis.json)" "4" "认证 node-a 但 body.node_id=node-b → code=4"

echo "=== 4. nonce 防重放 ==="
BODY_A='{"node_id":"node-a","name":"A","ts":1,"totals":{"direct_rx":1}}'
printf '%s' "$BODY_A" > /tmp/body-a.json
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-n1.json >/tmp/h-n1
eq "$(code_of /tmp/r-n1.json)" "0" "首次 nonce → code=0"
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-n2.json >/tmp/h-n2
eq "$(code_of /tmp/r-n2.json)" "8" "同一 nonce 重放 → code=8"
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-n3.json >/tmp/h-n3
eq "$(code_of /tmp/r-n3.json)" "0" "换新 nonce → code=0"
TS=$(now); S=$(sign2 node-a "$TS" "short" secret-a /tmp/body-a.json)
post2 node-a "$TS" "short" "$S" /tmp/body-a.json /tmp/r-n4.json >/tmp/h-n4
eq "$(code_of /tmp/r-n4.json)" "4" "非法 nonce（太短）→ code=4"

echo "=== 5. body 限长 / 声明与实际不符 ==="
printf '' | env REQUEST_METHOD=POST CONTENT_LENGTH=200000 CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/b1.out 2>/dev/null
grep -q '^Status: 413' /tmp/b1.out && ok "Content-Length=200000 在读取前 413" || bad "声明超限未 413（$(head -1 /tmp/b1.out)）"
dd if=/dev/zero bs=131073 count=1 2>/dev/null | tr '\0' 'x' | \
  env REQUEST_METHOD=POST CONTENT_TYPE=application/json ucode /www/cgi-bin/prism-router-ingest >/tmp/b2.out 2>/dev/null
grep -q '^Status: 413' /tmp/b2.out && ok "无 Content-Length 实际 131073 字节 → 413（读取夹到 MAX+1）" || bad "实际超限未 413"
printf '0123456789' | env REQUEST_METHOD=POST CONTENT_LENGTH=5 CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/b3.out 2>/dev/null
grep -q '"code":4' /tmp/b3.out && ok "声明 5 实际 10 → code=4" || bad "声明/实际不符未拒（$(tail -1 /tmp/b3.out)）"
printf '0123456789' | env REQUEST_METHOD=POST CONTENT_LENGTH=100 CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/b4.out 2>/dev/null
grep -q '"code":4' /tmp/b4.out && ok "声明 100 实际 10 → code=4" || bad "少读未拒（$(tail -1 /tmp/b4.out)）"

echo "=== 5b. Content-Length 严格十进制（两个 CGI 都不许宽松转换）==="
# 关键顺序：先 ^[0-9]+$，再上限，最后 integer()。以下值若先 int() 就会被转成 12。
for cl in '12abc' '1e3' '1,000' ' 12 '; do
  printf '0123456789' | env REQUEST_METHOD=POST CONTENT_LENGTH="$cl" CONTENT_TYPE=application/json \
    ucode /www/cgi-bin/prism-router-ingest >/tmp/cl-i.out 2>/dev/null
  grep -q '"code":4' /tmp/cl-i.out && ok "ingest 拒绝 Content-Length=[$cl]" || bad "ingest 接受/误判 Content-Length=[$cl]（$(tail -1 /tmp/cl-i.out)）"
  printf '0123456789' | env REQUEST_METHOD=POST CONTENT_LENGTH="$cl" CONTENT_TYPE=application/json \
    ucode /www/cgi-bin/prism-router-stations >/tmp/cl-s.out 2>/dev/null
  grep -q '"code":4' /tmp/cl-s.out && ok "stations 拒绝 Content-Length=[$cl]" || bad "stations 接受/误判 Content-Length=[$cl]（$(tail -1 /tmp/cl-s.out)）"
done
HUGECL=999999999999999999999999
printf '' | env REQUEST_METHOD=POST CONTENT_LENGTH="$HUGECL" CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/cl-i-huge.out 2>/dev/null
grep -q '^Status: 413' /tmp/cl-i-huge.out && ok "ingest 超长数字在 integer 前 413" || bad "ingest 超长数字未 413"
printf '' | env REQUEST_METHOD=POST CONTENT_LENGTH="$HUGECL" CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-stations >/tmp/cl-s-huge.out 2>/dev/null
grep -q '^Status: 413' /tmp/cl-s-huge.out && ok "stations 超长数字在 integer 前 413" || bad "stations 超长数字未 413"
# 前导零应按十进制上限比较（不是按字符串长度误判 413），随后进入认证阶段 code=1。
ZEROCL=0000000000000000000000000000000000000010
printf '0123456789' | env REQUEST_METHOD=POST CONTENT_LENGTH="$ZEROCL" CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/cl-i-zero.out 2>/dev/null
grep -q '"msg":"invalid X-Node-Id"' /tmp/cl-i-zero.out && ok "ingest 前导零归一后通过长度检查（进入 node_id 校验）" || bad "ingest 前导零处理错误（$(tail -1 /tmp/cl-i-zero.out)）"
printf '0123456789' | env REQUEST_METHOD=POST CONTENT_LENGTH="$ZEROCL" CONTENT_TYPE=application/json \
  ucode /www/cgi-bin/prism-router-stations >/tmp/cl-s-zero.out 2>/dev/null
grep -q '"msg":"invalid X-Node-Id"' /tmp/cl-s-zero.out && ok "stations 前导零归一后通过长度检查（进入 node_id 校验）" || bad "stations 前导零处理错误（$(tail -1 /tmp/cl-s-zero.out)）"

echo "=== 5c. /tmp/prism-router、.auth、nonces 目录真实且 root ==="
eq "$(perm /tmp/prism-router)" "0:0 755" "/tmp/prism-router 是 root 0755 真实目录"
eq "$(perm /tmp/prism-router/.auth)" "0:0 700" ".auth 是 root 0700 真实目录"
eq "$(perm /tmp/prism-router/nonces)" "0:0 700" "nonces 是 root 0700 真实目录"
eq "$(perm /tmp/prism-router/nonces/node-a)" "0:0 700" "nonces/node-a 是 root 0700 真实目录"

echo "=== 5d. .auth / /tmp/prism-router / nonces 的符号链接与属主异常必须失败关闭 ==="
EVIL=/tmp/sec-evil
rm -rf "$EVIL"; mkdir -p "$EVIL"; chmod 755 "$EVIL"
evil_count(){ find "$EVIL" -mindepth 1 2>/dev/null | wc -l | tr -d ' '; }

# (1) .auth 是 symlink：不得 chmod/chown 跟随，不得在目标里落 hash
rm -rf /tmp/prism-router/.auth
ln -s "$EVIL" /tmp/prism-router/.auth
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/tmp/push-link-auth.out 2>&1
eq "$?" "1" "push: .auth 为 symlink → 拒绝签名并退出 1"
eq "$(evil_count)" "0" "push: .auth symlink 目标未写入任何文件"

# (2) .auth 是「真实目录但非 root」：不得靠 chown 洗白，必须拒绝
rm -f /tmp/prism-router/.auth
mkdir /tmp/prism-router/.auth
chmod 700 /tmp/prism-router/.auth
chown 12345:12345 /tmp/prism-router/.auth
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/tmp/push-owner.out 2>&1
eq "$?" "1" "push: .auth 属主非 root → 拒绝签名并退出 1"
eq "$(owner /tmp/prism-router/.auth)" "12345" "push: 没有用 chown 偷偷改回 root"
rm -rf /tmp/prism-router/.auth

# (3) /tmp/prism-router 本身是 symlink：父目录不安全 → 失败关闭
mv /tmp/prism-router /tmp/prism-router.real
ln -s "$EVIL" /tmp/prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/tmp/push-link-parent.out 2>&1
eq "$?" "1" "push: /tmp/prism-router 为 symlink → 拒绝签名并退出 1"
eq "$(evil_count)" "0" "push: 父目录 symlink 目标未写入任何文件"
rm -f /tmp/prism-router
mv /tmp/prism-router.real /tmp/prism-router

# (3b) ingest 侧同样：父目录 symlink 时既不能写 nonce，也不能把节流日志写到目标
mv /tmp/prism-router /tmp/prism-router.real
ln -s "$EVIL" /tmp/prism-router
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-link-parent.json >/tmp/h-link-parent
PARENT_CODE=$(code_of /tmp/r-link-parent.json)
case "$PARENT_CODE" in
  5|8) ok "ingest: /tmp/prism-router 为 symlink → 失败关闭（code=$PARENT_CODE）" ;;
  *) bad "ingest: 父目录 symlink 未失败关闭（code=$PARENT_CODE）" ;;
esac
eq "$(evil_count)" "0" "ingest: 父目录 symlink 目标无任何写入（nonce/日志）"
rm -f /tmp/prism-router
mv /tmp/prism-router.real /tmp/prism-router

# (4) 正常目录恢复后必须无回归
rm -rf /tmp/prism-router/.auth
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
eq "$?" "0" "恢复真实 .auth 后 push 正常退出 0（无回归）"
eq "$(perm /tmp/prism-router/.auth)" "0:0 700" "恢复后 .auth 仍为 root 0700"

# (5) nonces 是 symlink：已认证请求也必须 code=8（失败关闭），且不写目标
rm -rf /tmp/prism-router/nonces
ln -s "$EVIL" /tmp/prism-router/nonces
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-link-nonces.json >/tmp/h-link-nonces
eq "$(code_of /tmp/r-link-nonces.json)" "8" "ingest: nonces 为 symlink → code=8"
eq "$(evil_count)" "0" "ingest: nonces symlink 目标未写入 nonce"
rm -f /tmp/prism-router/nonces
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-ok-nonces.json >/tmp/h-ok-nonces
eq "$(code_of /tmp/r-ok-nonces.json)" "0" "恢复真实 nonces 后正常请求 code=0"

# (6) 节点子目录是 symlink：同样 code=8
rm -rf /tmp/prism-router/nonces/node-a
ln -s "$EVIL" /tmp/prism-router/nonces/node-a
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-link-node.json >/tmp/h-link-node
eq "$(code_of /tmp/r-link-node.json)" "8" "ingest: nonces/node-a 为 symlink → code=8"
eq "$(evil_count)" "0" "ingest: 节点 symlink 目标未写入 nonce"
rm -f /tmp/prism-router/nonces/node-a
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
post2 node-a "$TS" "$N" "$S" /tmp/body-a.json /tmp/r-ok-node.json >/tmp/h-ok-node
eq "$(code_of /tmp/r-ok-node.json)" "0" "恢复真实节点目录后正常请求 code=0"

# (7) feishu 的 .auth 是独立副本：symlink 时签名必须失败
rm -rf /tmp/prism-router/.auth
ln -s "$EVIL" /tmp/prism-router/.auth
ucode /usr/share/prism-router/feishu.uc sign 1599360473 demo >/tmp/feishu-link.out 2>&1
eq "$?" "1" "feishu: .auth 为 symlink → 签名失败退出 1"
eq "$(evil_count)" "0" "feishu: .auth symlink 目标未写入任何文件"
rm -f /tmp/prism-router/.auth

echo "=== 5e. 共享 helper 与 5 个内嵌副本同步（静态）==="
SYNC=1
for f in /usr/share/prism-router/prism-router-node-auth.uc \
         /usr/share/prism-router/push.uc /usr/share/prism-router/stations.uc \
         /usr/share/prism-router/feishu.uc /www/cgi-bin/prism-router-ingest \
         /www/cgi-bin/prism-router-stations; do
  grep -q 'auth_safe_tmp_parent' "$f" || { SYNC=0; }
  grep -q 'auth_lstat_dir' "$f" || { SYNC=0; }
  grep -q "open(out, 'wx', 384)\|fs.open(out, \"wx\", 384)" "$f" || { SYNC=0; }
  grep -q 'SHA2-256(stdin)' "$f" || { SYNC=0; }
done
eq "$SYNC" "1" "6 个认证副本都含 lstat 目录校验 / wx 打开 / openssl 回退解析"

echo "=== 6. HMAC/secret 不进 argv（包装真实 sha256sum/curl 记录 argv）==="
wrap_tools(){
  mv /usr/bin/sha256sum /usr/bin/sha256sum.real
  cat > /usr/bin/sha256sum <<'W'
#!/bin/sh
echo "sha256sum $*" >> /tmp/argv.log
exec /bin/busybox sha256sum "$@"
W
  chmod 755 /usr/bin/sha256sum
  mv /usr/bin/curl /usr/bin/curl.real
  cat > /usr/bin/curl <<'W'
#!/bin/sh
echo "curl $*" >> /tmp/argv.log
prev=""
for a in "$@"; do
  if [ "$prev" = "-K" ]; then cp "$a" /tmp/last-curl.conf 2>/dev/null; chmod 600 /tmp/last-curl.conf 2>/dev/null; fi
  prev="$a"
done
exec /usr/bin/curl.real "$@"
W
  chmod 755 /usr/bin/curl
}
unwrap_tools(){
  [ -e /usr/bin/sha256sum.real ] && mv /usr/bin/sha256sum.real /usr/bin/sha256sum
  [ -e /usr/bin/curl.real ] && mv /usr/bin/curl.real /usr/bin/curl
}
wrap_tools
rm -f /tmp/argv.log /tmp/last-curl.conf
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
if [ -f /tmp/argv.log ]; then
  grep -Eq 'secret-a|secret-b|sign=|Authorization|legacysecret' /tmp/argv.log \
    && bad "push 的 secret/签名出现在 argv：$(grep -E 'secret|sign=|Authorization' /tmp/argv.log | head -1)" \
    || ok "push 期间 argv 无 secret/签名（仅 sha256sum 与 curl -K）"
  grep -q 'curl .* -K ' /tmp/argv.log && ok "curl 通过 0600 配置文件传参，而不是命令行 -H/--data" || bad "curl 未见 -K 配置文件"
else
  bad "包装工具未记录 argv（push 未调用 sha256sum/curl？）"
fi
if [ -f /tmp/last-curl.conf ]; then
  eq "$(ls -l /tmp/last-curl.conf | cut -c1-10)" "-rw-------" "curl 配置文件权限 0600"
  grep -q 'max-redirs = 0' /tmp/last-curl.conf && ok "curl 配置 max-redirs=0（不自动重定向）" || bad "curl 配置未禁用重定向"
  grep -q 'proto = "=http,https"' /tmp/last-curl.conf && ok "curl 配置限制 proto" || bad "curl 配置未限制 proto"
  grep -qi 'insecure' /tmp/last-curl.conf && bad "curl 配置出现 insecure/-k" || ok "curl 配置没有 insecure/-k"
  grep -q 'Authorization: PrismRouter' /tmp/last-curl.conf && ok "签名在 0600 的 curl 配置里（不在 argv/URL）" || bad "curl 配置缺少 Authorization"
else
  bad "未捕获 curl 配置文件"
fi

# ingest 侧：直接喂 stdin，包装 sha256sum 记录 argv
rm -f /tmp/argv.log
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
printf '%s' "$BODY_A" | env REQUEST_METHOD=POST CONTENT_LENGTH=$(wc -c < /tmp/body-a.json) \
  CONTENT_TYPE=application/json QUERY_STRING="node_id=node-a&ts=$TS&proto=2&nonce=$N" \
  HTTP_AUTHORIZATION="PrismRouter node_id=node-a;ts=$TS;proto=2;nonce=$N;sign=$S" \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/r-argv-ingest.json 2>/dev/null
tail -1 /tmp/r-argv-ingest.json > /tmp/r-argv-ingest.body
eq "$(code_of /tmp/r-argv-ingest.body)" "0" "ingest 直连认证通过（argv 包装下）"
if [ -f /tmp/argv.log ]; then
  grep -Eq 'secret-a|sign=|Authorization' /tmp/argv.log && bad "ingest 的 secret/签名进入 argv" || ok "ingest 期间 argv 无 secret/签名"
else
  bad "ingest 未调用包装后的 sha256sum"
fi

# feishu 侧：签名走 ucode 内存 + sha256sum，不调用 openssl -hmac
rm -f /tmp/argv.log
GS=$(ucode /usr/share/prism-router/feishu.uc sign 1599360473 demo 2>/dev/null)
WS=$(printf '' | openssl dgst -sha256 -hmac "$(printf '1599360473\ndemo')" -binary | openssl base64 -A)
eq "$GS" "$WS" "feishu 签名向量与 openssl 一致"
if [ -f /tmp/argv.log ]; then
  grep -Eq 'demo|-hmac' /tmp/argv.log && bad "feishu 的 key 进入 argv/-hmac" || ok "feishu 签名期间 argv 无 key/-hmac"
else
  bad "feishu 签名未调用包装后的 sha256sum"
fi

# stations 侧：token 只在 0600 配置，不在 argv
rm -f /tmp/argv.log /tmp/last-curl.conf
cat > /tmp/bin/iw <<'IW'
#!/bin/sh
if [ "$1" = "dev" ] && [ "$2" = "phy0.1-ap0" ]; then
  echo "Station 22:77:08:69:a9:1f (on phy0.1-ap0)"
  echo "	signal:  	-53 [-57, -55] dBm"
  echo "	rx bitrate:	866.6 MBit/s VHT-MCS 9"
  echo "	tx bitrate:	650.0 MBit/s VHT-MCS 7"
  echo "	connected time:	3600 seconds"
elif [ "$1" = "dev" ]; then
  echo "Interface phy0.1-ap0"
  echo "	type AP"
else
  exit 1
fi
IW
chmod 755 /tmp/bin/iw
# 让 stations 使用 ap-1 的独立 token
uci set prism-router.settings.node_id='ap-1'
uci set prism-router.settings.station_ifaces='phy0.1-ap0'
uci commit prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts PRISM_ROUTER_IW=/tmp/bin/iw ucode /usr/share/prism-router/stations.uc >/dev/null 2>&1
if [ -f /tmp/argv.log ]; then
  grep -Eq 'tok-ap1|Bearer|token=' /tmp/argv.log && bad "stations token 进入 argv" || ok "stations 期间 argv 无 token"
  grep -q 'curl .* -K ' /tmp/argv.log && ok "stations curl 通过 0600 配置文件传参" || bad "stations curl 未用 -K"
else
  bad "stations 未调用包装后的 curl"
fi
[ -f /tmp/last-curl.conf ] && { eq "$(ls -l /tmp/last-curl.conf | cut -c1-10)" "-rw-------" "stations curl 配置 0600"; grep -q 'Authorization: Bearer' /tmp/last-curl.conf && ok "stations token 在 0600 配置的 Authorization 里" || bad "stations 配置缺 Authorization"; } || bad "未捕获 stations curl 配置"
unwrap_tools
uci set prism-router.settings.node_id='node-a'
uci commit prism-router

echo "=== 6b. 仅 openssl 时接受 SHA2-256(stdin)= <64hex> 尾部（主 sha256sum 路径不变）==="
# 先用 sha256sum 算好请求签名；之后把 sha256sum 移走，服务端/客户端都必须走 openssl 回退。
TS=$(now); N=$(nonce); S=$(sign2 node-a "$TS" "$N" secret-a /tmp/body-a.json)
mv /usr/bin/sha256sum /usr/bin/sha256sum.no-busybox
[ -e /bin/sha256sum ] && mv /bin/sha256sum /bin/sha256sum.no-busybox
rm -rf /etc/prism-router/nodes
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/tmp/push-openssl.out 2>&1
eq "$?" "0" "push.uc 仅 openssl 时完成签名并推送"
[ -f /etc/prism-router/nodes/node-a.json ] && ok "push.uc openssl 回退后快照落盘" || bad "push.uc openssl 回退后快照缺失"
printf '%s' "$BODY_A" | env REQUEST_METHOD=POST CONTENT_LENGTH=$(wc -c < /tmp/body-a.json) \
  CONTENT_TYPE=application/json QUERY_STRING="node_id=node-a&ts=$TS&proto=2&nonce=$N" \
  HTTP_AUTHORIZATION="PrismRouter node_id=node-a;ts=$TS;proto=2;nonce=$N;sign=$S" \
  ucode /www/cgi-bin/prism-router-ingest >/tmp/ingest-openssl.json 2>/dev/null
tail -1 /tmp/ingest-openssl.json > /tmp/ingest-openssl.body
eq "$(code_of /tmp/ingest-openssl.body)" "0" "ingest 仅 openssl 时接受 openssl 格式 digest"
EMPTYH=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
H=$(ucode -e "import {auth_digest_hex} from '/usr/share/prism-router/prism-router-node-auth.uc'; print(auth_digest_hex('SHA2-256(stdin)= $EMPTYH\n'));" 2>/dev/null)
eq "$H" "$EMPTYH" "共享 helper 解析 openssl 尾部格式"
# 恢复主路径
[ -e /usr/bin/sha256sum.no-busybox ] && mv /usr/bin/sha256sum.no-busybox /usr/bin/sha256sum
[ -e /bin/sha256sum.no-busybox ] && mv /bin/sha256sum.no-busybox /bin/sha256sum
H2=$(ucode -e "import {auth_digest_hex} from '/usr/share/prism-router/prism-router-node-auth.uc'; print(auth_digest_hex('$EMPTYH  -\n'));" 2>/dev/null)
eq "$H2" "$EMPTYH" "共享 helper 主 sha256sum 行首格式保持不变"

echo "=== 7. 跨源重定向不转发凭证；同源 http->https 允许 ==="
rm -f /tmp/leak.log
uci set prism-router.settings.mother_url='http://127.0.0.1:8080/cgi-bin/redirect-cross'
uci commit prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
[ ! -f /tmp/leak.log ] && ok "跨源重定向：第三方未收到任何请求（无 token/sign/body）" || { bad "跨源重定向泄露到第三方"; cat /tmp/leak.log; }
grep -q '拒绝重定向' /tmp/ts/push.log && ok "push 日志记录拒绝跨源重定向" || bad "push 未记录拒绝重定向"

uci set prism-router.settings.node_id='ap-1'
uci commit prism-router
rm -f /tmp/leak.log
PRISM_ROUTER_STATE_DIR=/tmp/ts PRISM_ROUTER_IW=/tmp/bin/iw ucode /usr/share/prism-router/stations.uc >/dev/null 2>&1
[ ! -f /tmp/leak.log ] && ok "stations 跨源重定向：第三方未收到 token/body" || { bad "stations 重定向泄露"; cat /tmp/leak.log; }
grep -q '拒绝重定向' /tmp/ts/stations.log && ok "stations 日志记录拒绝跨源重定向" || bad "stations 未记录拒绝重定向"
uci set prism-router.settings.node_id='node-a'
uci set prism-router.settings.mother_url='http://127.0.0.1:8080'
uci commit prism-router

echo "=== 8. TLS 默认验证；配置 CA 后可用；不 -k ==="
mkdir -p /tmp/tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/tls/key.pem -out /tmp/tls/cert.pem \
  -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' >/dev/null 2>&1
uhttpd -f -s 127.0.0.1:8443 -h /www -x /cgi-bin -K /tmp/tls/key.pem -C /tmp/tls/cert.pem >/tmp/uh8443.log 2>&1 &
sleep 1
rm -rf /etc/prism-router/nodes
uci set prism-router.settings.mother_url='https://127.0.0.1:8443'
uci delete prism-router.settings.mother_ca 2>/dev/null
uci commit prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
[ ! -e /etc/prism-router/nodes/node-a.json ] && ok "自签证书且未配 CA → 推送失败（没有 -k）" || bad "未配 CA 竟然成功了（TLS 验证被绕过）"
grep -qiE 'verify|SSL|certificate' /tmp/ts/push.log && ok "日志显示证书验证失败" || bad "日志未体现 TLS 验证失败"
uci set prism-router.settings.mother_ca='/tmp/tls/cert.pem'
uci commit prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
[ -f /etc/prism-router/nodes/node-a.json ] && ok "配置 mother_ca 后推送成功" || { bad "配置 CA 后仍失败"; tail -2 /tmp/ts/push.log; }

# 同源 http:80 -> https:443 允许（仅同主机/同路径）
mkdir -p /www-http/cgi-bin /www-https/cgi-bin
cp /www/cgi-bin/prism-router-ingest /www-https/cgi-bin/redirect-same; chmod 755 /www-https/cgi-bin/redirect-same
cat > /www-http/cgi-bin/redirect-same <<'CGI'
#!/bin/sh
echo "Status: 307 Temporary Redirect"
echo "Location: https://127.0.0.1$REQUEST_URI"
echo
CGI
chmod 755 /www-http/cgi-bin/redirect-same
uhttpd -f -p 127.0.0.1:80 -h /www-http -x /cgi-bin >/tmp/uh80.log 2>&1 &
uhttpd -f -s 127.0.0.1:443 -h /www-https -x /cgi-bin -K /tmp/tls/key.pem -C /tmp/tls/cert.pem >/tmp/uh443.log 2>&1 &
sleep 1
rm -rf /etc/prism-router/nodes
uci set prism-router.settings.mother_url='http://127.0.0.1/cgi-bin/redirect-same'
uci commit prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
[ -f /etc/prism-router/nodes/node-a.json ] && ok "同源 http:80→https:443 重定向被安全跟随" || { bad "同源重定向未跟随"; tail -3 /tmp/ts/push.log; }
grep -q '同源 http->https' /tmp/ts/push.log && ok "日志记录同源 http->https 重发" || bad "未记录同源重定向"

uci set prism-router.settings.mother_url='http://127.0.0.1:8080'
uci delete prism-router.settings.mother_ca 2>/dev/null
uci commit prism-router

echo "=== 9. legacy 开关默认拒绝旧协议 ==="
# 直接 v1 签名：legacy 关闭 → 拒绝
TS=$(now); S=$(sign1 node-a "$TS" legacysecret /tmp/body-a.json)
post1 node-a "$TS" "$S" /tmp/body-a.json /tmp/r-legacy-off.json >/tmp/h-legacy-off
eq "$(code_of /tmp/r-legacy-off.json)" "1" "legacy=0 时 v1 旧签名被拒"
uci set prism-router.settings.legacy_shared_secret='1'; uci commit prism-router
TS=$(now); S=$(sign1 node-a "$TS" legacysecret /tmp/body-a.json)
post1 node-a "$TS" "$S" /tmp/body-a.json /tmp/r-legacy-on.json >/tmp/h-legacy-on
eq "$(code_of /tmp/r-legacy-on.json)" "0" "legacy=1 时 v1 旧签名接受（显式迁移）"
# legacy 打开也不影响 v2 未知节点拒绝
TS=$(now); N=$(nonce); S=$(sign2 node-c "$TS" "$N" secret-a /tmp/body-c.json)
post2 node-c "$TS" "$N" "$S" /tmp/body-c.json /tmp/r-c2.json >/tmp/h-c2
eq "$(code_of /tmp/r-c2.json)" "1" "legacy=1 时 v2 未知节点仍拒绝"
uci set prism-router.settings.legacy_shared_secret='0'; uci commit prism-router

# 只有旧 mother_secret、没有 config node 的 push：默认报错，legacy 打开才走 v1
cp /etc/config/prism-router /tmp/cfg.bak
cat > /etc/config/prism-router <<'EOF'
config settings 'settings'
	option mother_enabled '1'
	option mother_url 'http://127.0.0.1:8080'
	option node_id 'node-a'
	option mother_secret 'legacysecret'
	option legacy_shared_secret '0'
	option stations_enabled '1'
	option legacy_stations_token '0'
EOF
uci commit prism-router 2>/dev/null
rm -rf /etc/prism-router/nodes
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
eq "$?" "1" "只有 mother_secret 且 legacy=0 → push 退出 1（不默认开洞）"
grep -q '未注册' /tmp/ts/push.log && ok "日志提示节点未注册" || bad "日志未提示未注册"
[ ! -e /etc/prism-router/nodes/node-a.json ] && ok "未注册节点未落盘" || bad "未注册节点落盘了"
uci set prism-router.settings.legacy_shared_secret='1'; uci commit prism-router
PRISM_ROUTER_STATE_DIR=/tmp/ts ucode /usr/share/prism-router/push.uc >/dev/null 2>&1
[ -f /etc/prism-router/nodes/node-a.json ] && ok "legacy=1 时旧配置可平滑迁移（v1）" || bad "legacy=1 旧配置仍失败"
grep -q 'deprecated\|legacy' /tmp/ts/push.log && ok "legacy 使用有 deprecation 日志" || bad "legacy 无 deprecation 日志"
cp /tmp/cfg.bak /etc/config/prism-router
uci commit prism-router 2>/dev/null

echo "=== 10. stations 按节点 token + nonce ==="
SB='{"node_id":"ap-1","name":"AP","ts":1,"stations":[{"mac":"22:77:08:69:a9:1f","signal":-53}]}'
printf '%s' "$SB" > /tmp/sb-ap1.json
rm -f /etc/prism-router/stations/ap-1.json
TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s1.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s1.json)" "0" "ap-1 独立 token + nonce → code=0"
[ -f /etc/prism-router/stations/ap-1.json ] && ok "ap-1 站点快照落盘" || bad "ap-1 快照缺失"
curl -sS -m 5 -o /tmp/s2.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s2.json)" "8" "stations 同 nonce 重放 → code=8"

eq "$(perm /tmp/prism-router/station-nonces)" "0:0 700" "station-nonces 是 root 0700 真实目录"
eq "$(perm /tmp/prism-router/station-nonces/ap-1)" "0:0 700" "station-nonces/ap-1 是 root 0700 真实目录"

# station-nonces symlink：失败关闭（code=8），不向目标写 nonce
rm -rf /tmp/prism-router/station-nonces
ln -s "$EVIL" /tmp/prism-router/station-nonces
TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s-link.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s-link.json)" "8" "stations: station-nonces 为 symlink → code=8"
eq "$(evil_count)" "0" "stations: station-nonces symlink 目标未写入 nonce"
rm -f /tmp/prism-router/station-nonces
TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s-ok.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s-ok.json)" "0" "stations: 恢复真实 station-nonces 后 code=0"

# 节点子目录 symlink：同样失败关闭
rm -rf /tmp/prism-router/station-nonces/ap-1
ln -s "$EVIL" /tmp/prism-router/station-nonces/ap-1
TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s-link-node.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s-link-node.json)" "8" "stations: station-nonces/ap-1 为 symlink → code=8"
eq "$(evil_count)" "0" "stations: 节点 symlink 目标未写入 nonce"
rm -f /tmp/prism-router/station-nonces/ap-1
TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s-ok-node.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s-ok-node.json)" "0" "stations: 恢复真实节点目录后 code=0"

TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s3.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-2&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s3.json)" "1" "ap-1 的 token 写 ap-2 → code=1"
TS=$(now); N=$(nonce)
curl -sS -m 5 -o /tmp/s4.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-9&ts=$TS&proto=2&nonce=$N" \
  -H "Authorization: Bearer tok-ap1" -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s4.json)" "1" "未知 ap-9 → code=1"
# 旧 v1（无 nonce、token 在查询串）：默认拒绝；显式 legacy 才接受
TS=$(now)
curl -sS -m 5 -o /tmp/s5.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-1&ts=$TS&token=legacytok" \
  -H 'Content-Type: application/json' --data-binary @/tmp/sb-ap1.json >/dev/null 2>&1
eq "$(code_of /tmp/s5.json)" "1" "legacy_stations_token=0 时 v1 旧 token 被拒"
uci set prism-router.settings.legacy_stations_token='1'; uci commit prism-router
SBOLD='{"node_id":"ap-old","name":"old","ts":1,"stations":[{"mac":"22:77:08:69:a9:1f","signal":-53}]}'
printf '%s' "$SBOLD" > /tmp/sb-old.json
TS=$(now)
curl -sS -m 5 -o /tmp/s6.json -X POST \
  "http://127.0.0.1:8080/cgi-bin/prism-router-stations?node_id=ap-old&ts=$TS&token=legacytok" \
  -H 'Content-Type: application/json' --data-binary @/tmp/sb-old.json >/dev/null 2>&1
eq "$(code_of /tmp/s6.json)" "0" "legacy_stations_token=1 时 v1 旧 token 接受"
uci set prism-router.settings.legacy_stations_token='0'; uci commit prism-router

# 真 AP 脚本：token 不进 URL、日志无 token
uci set prism-router.settings.stations_enabled='1'
uci set prism-router.settings.node_id='ap-1'
uci set prism-router.settings.station_ifaces='phy0.1-ap0'
uci set prism-router.settings.mother_url='http://127.0.0.1:8080'
uci set prism-router.settings.legacy_stations_token='0'
uci commit prism-router
rm -f /tmp/ts/stations.log /tmp/ts/stations-ok.last /tmp/ts/stations-syslog-*.last
PRISM_ROUTER_STATE_DIR=/tmp/ts PRISM_ROUTER_IW=/tmp/bin/iw ucode /usr/share/prism-router/stations.uc >/tmp/stations-run.out 2>/tmp/stations-run.err
SRC=$?
if [ -s /tmp/stations-run.err ]; then echo "  stations stderr:"; head -5 /tmp/stations-run.err; fi
grep -q '上报成功' /tmp/ts/stations.log && ok "stations.uc 真实上报成功" || { bad "stations.uc 上报失败"; tail -3 /tmp/ts/stations.log 2>/dev/null || true; }
grep -q 'tok-ap1' /tmp/ts/stations.log && bad "stations 日志泄露 token" || ok "stations 日志不含 token"
PRISM_ROUTER_STATE_DIR=/tmp/ts PRISM_ROUTER_IW=/tmp/bin/iw PRISM_ROUTER_STATIONS_DRY=1 \
  ucode /usr/share/prism-router/stations.uc > /tmp/stations-dry.json 2>/dev/null
grep -q 'token=' /tmp/stations-dry.json && bad "stations dry-run 的 URL 仍带 token" || ok "stations URL 不含 token"
grep -q '"Authorization": "Bearer' /tmp/stations-dry.json && ok "stations 用 Authorization: Bearer" || bad "stations 未用 Authorization"

echo "=== 11. feishu 临时文件 0600 / 日志不含秘密 ==="
cat > /www/cgi-bin/feishu-hook <<'CGI'
#!/bin/sh
ls -la /tmp/prism-router/tmp > /tmp/feishu-perms.txt 2>&1
cat > /tmp/feishu-body.txt
echo "Content-Type: application/json"
echo
echo '{"code":0,"msg":"ok"}'
CGI
chmod 755 /www/cgi-bin/feishu-hook
uci set prism-router.feishu='feishu'
uci set prism-router.feishu.enabled='1'
uci set prism-router.feishu.webhook='http://127.0.0.1:8080/cgi-bin/feishu-hook'
uci set prism-router.feishu.secret='demo-secret'
uci commit prism-router
rm -rf /tmp/prism-router/tmp /tmp/prism-router/feishu.log
ucode /usr/share/prism-router/feishu.uc test >/tmp/feishu-test.out 2>&1
grep -q '成功' /tmp/feishu-test.out && ok "feishu test 发送成功（本地 mock）" || { bad "feishu test 失败"; cat /tmp/feishu-test.out; }
if [ -f /tmp/feishu-perms.txt ]; then
  BADPERM=$(grep -E 'body-|curl-|resp-|err-' /tmp/feishu-perms.txt | grep -v '^-rw-------' | head -1)
  [ -z "$BADPERM" ] && ok "feishu 请求体/curl 配置/响应临时文件均 0600" || bad "feishu 临时文件权限不对：$BADPERM"
else
  bad "mock 未记录 feishu 临时目录权限"
fi
grep -q 'feishu-hook\|demo-secret' /tmp/prism-router/feishu.log 2>/dev/null && bad "feishu 日志泄露 webhook/secret" || ok "feishu 日志不含 webhook/secret"
ucode /usr/share/prism-router/feishu.uc selftest >/tmp/feishu-selftest.out 2>&1
grep -q '自检结果：PASS' /tmp/feishu-selftest.out && ok "feishu selftest 全绿" || { bad "feishu selftest 失败"; tail -5 /tmp/feishu-selftest.out; }

echo
echo "=== 结果：PASS $PASS / FAIL $FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
