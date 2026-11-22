#!/bin/bash
# 家长控制写操作门禁（第 15 套）：
#   在隔离的 OpenWrt 24.10 容器里装单包，用 PATH 注入的假 nft 记录 argv，
#   逐项验证 /cgi-bin/prism-router-control 的开关 / 令牌 / MAC / 持久化 / 审计 /
#   重放（apply）与"绝不碰 inet UA3F、绝不做破坏性 nft 命令"。
#
# 为什么要假 nft：容器里既没有 fw4 规则集也没有真机内核；真 nft 的语义由
# 真机验收覆盖（docs/SPEC.md §12 的"剩余边界"）。这里验证的是**我们发出的
# 命令长什么样**、以及在什么条件下才发。
#
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
source "$ROOT/tests/lib/prism-version.sh"
prism_pick_ipk "$DIST"
PKG="$PRISM_IPK_NAME"
[ -f "$DIST/SHA256SUMS" ] || { echo "ERROR: 缺少 $DIST/SHA256SUMS；拒绝在未校验的产物上跑门禁" >&2; exit 1; }
# 校验后立即快照：防止其他 agent/门禁在本门禁运行期间重建 dist，导致“验的是 A、装的是 B”。
SNAP=$(mktemp -d)
trap 'rm -rf "$SNAP"' EXIT
cp -a "$DIST/." "$SNAP/"
( cd "$SNAP" && sha256sum -c SHA256SUMS ) >/dev/null || { echo "ERROR: dist/SHA256SUMS 校验失败（产物被改动或不完整）" >&2; exit 1; }
echo ">>> 家长控制用例（隔离容器：--network none，假 nft 注入 PATH）"
docker run --rm --network none \
  -e PRISM_VER="$PRISM_VER" \
  -e PRISM_IPK_NAME="$PRISM_IPK_NAME" \
  -v "$SNAP:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  "$IMAGE" /bin/sh /src/tests/container-control-inner.sh
