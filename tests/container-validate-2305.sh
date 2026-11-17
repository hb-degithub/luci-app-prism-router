#!/bin/bash
# 容器验证门禁（OpenWrt 23.05.5 兼容性）：在隔离的 OpenWrt 23.05 容器里安装包并断言不破坏系统。
# 隔离：--network none（无网络）、源码只读挂载、容器用完即删；不接触任何真机。
#
# 默认复用 dist/ 并校验 SHA256SUMS；--build 才重建一次，避免多门禁抢写 dist。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-23.05:deps}"
SKIP_BUILD="${SKIP_BUILD:-1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --build) SKIP_BUILD=0 ;;
    --no-build) SKIP_BUILD=1 ;;
    -h|--help) echo "用法: $0 [--build|--no-build]"; echo "默认 SKIP_BUILD=1，复用 dist；--build 先重建一次。"; exit 0 ;;
    *) echo "$0: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$SKIP_BUILD" = 0 ]; then
  echo ">>> 构建包（--build）"
  "$ROOT/tools/build-ipk.sh"
else
  echo ">>> 复用现有 dist（SKIP_BUILD=1；需要重建请加 --build）"
fi
DIST="$ROOT/dist"
for p in traffic-stats_1.0.0-1_all.ipk luci-app-traffic-stats_1.0.0-1_all.ipk; do
  [ -f "$DIST/$p" ] || { echo "ERROR: 缺少 $DIST/$p；先运行 tools/build-ipk.sh 或本脚本加 --build" >&2; exit 1; }
done
[ -f "$DIST/SHA256SUMS" ] || { echo "ERROR: 缺少 $DIST/SHA256SUMS；拒绝在未校验的产物上跑门禁" >&2; exit 1; }
# 校验后立即快照：防止其他 agent/门禁在本门禁运行期间重建 dist，导致“验的是 A、装的是 B”。
SNAP=$(mktemp -d)
trap 'rm -rf "$SNAP"' EXIT
cp -a "$DIST/." "$SNAP/"
( cd "$SNAP" && sha256sum -c SHA256SUMS ) >/dev/null || { echo "ERROR: dist/SHA256SUMS 校验失败（产物被改动或不完整）" >&2; exit 1; }
echo ">>> 在隔离容器中验证（--network none）"
docker run --rm --network none \
  -v "$SNAP:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-inner.sh
