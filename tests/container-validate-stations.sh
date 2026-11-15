#!/bin/bash
# AP 无线站点元数据通道门禁（隔离容器，--network none）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
"$ROOT/tools/build-ipk.sh" >/dev/null
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" -v "$ROOT/tests:/src/tests:ro" -v "$ROOT/traffic-stats/files:/f:ro" \
  "$IMAGE" /bin/sh /src/tests/stations-inner.sh
