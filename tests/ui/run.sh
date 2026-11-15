#!/bin/bash
# 无头浏览器验证 LuCI 五个页面：能渲染、无 console 报错、关键内容存在。
# 依赖镜像 ghcr.io/puppeteer/puppeteer:23（已在本机缓存，约 1.4 GB，不运行时零占用）
# 注意：容器内 puppeteer 在 /home/pptruser/node_modules；挂载目录必须 755 否则容器用户看不到。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=$(mktemp -d)
cp "$ROOT/tests/ui/page-render.js" "$WORK/test.js"
chmod 755 "$WORK"; chmod 644 "$WORK/test.js"
: "${LUCI_PASS:?请设置 LUCI_PASS 环境变量（LuCI root 密码）}"
: "${LUCI_BASE:=https://192.168.100.1}"
docker run --rm --network host -v "$WORK:/w" -w /w \
  -e NODE_PATH=/home/pptruser/node_modules \
  -e LUCI_PASS="$LUCI_PASS" -e LUCI_BASE="$LUCI_BASE" \
  ghcr.io/puppeteer/puppeteer:23 node /w/test.js
rc=$?
rm -rf "$WORK"
exit $rc
