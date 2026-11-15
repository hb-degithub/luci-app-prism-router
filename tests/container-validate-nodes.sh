#!/bin/bash
# 子母多节点容器门禁：构建包 → 在隔离 OpenWrt 24.10 容器里跑多节点用例。
# 隔离：--network none（只有 loopback）、源码只读挂载、容器用完即删；不接触任何真机。
# 与 container-validate.sh 互不影响：那个是原有 28 项门禁，这个是新增用例。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 多节点用例（隔离容器：--network none，仅 127.0.0.1）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-nodes-inner.sh
