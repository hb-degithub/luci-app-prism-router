#!/bin/bash
# 接入方式（无线 / 有线）容器门禁：
#   在隔离的 OpenWrt 24.10 容器里跑「假 brctl 喂固定 FDB → 设备分类 →
#   totals 三桶自洽 → brctl 缺失/输出异常降级 → rpcd 透传」。
# 隔离：--network none（只有 loopback）、源码只读挂载、容器用完即删；不接触任何真机。
#
# 默认复用 dist/ 并校验 SHA256SUMS；--build 才重建一次。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
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
for p in luci-app-prism-router_1.0.0-1_all.ipk luci-app-prism-router_1.0.0-1_all.ipk; do
  [ -f "$DIST/$p" ] || { echo "ERROR: 缺少 $DIST/$p；先运行 tools/build-ipk.sh 或本脚本加 --build" >&2; exit 1; }
done
[ -f "$DIST/SHA256SUMS" ] || { echo "ERROR: 缺少 $DIST/SHA256SUMS；拒绝在未校验的产物上跑门禁" >&2; exit 1; }
# 校验后立即快照：防止其他 agent/门禁在本门禁运行期间重建 dist，导致“验的是 A、装的是 B”。
SNAP=$(mktemp -d)
trap 'rm -rf "$SNAP"' EXIT
cp -a "$DIST/." "$SNAP/"
( cd "$SNAP" && sha256sum -c SHA256SUMS ) >/dev/null || { echo "ERROR: dist/SHA256SUMS 校验失败（产物被改动或不完整）" >&2; exit 1; }
echo ">>> 接入方式用例（隔离容器：--network none，仅 127.0.0.1）"
docker run --rm --network none \
  -v "$SNAP:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-links-inner.sh
