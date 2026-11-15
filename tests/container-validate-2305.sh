#!/bin/bash
# 容器验证门禁（OpenWrt 23.05.5 兼容性）：在隔离的 OpenWrt 24.10 容器里安装包并断言不破坏系统。
# 隔离：--network none（无网络）、源码只读挂载、容器用完即删；不接触任何真机。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-23.05:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 在隔离容器中验证（--network none）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-inner.sh
