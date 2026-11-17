#!/bin/bash
# 核心修复门禁：跨软重启持久化 / 双源去重 / RPC 历史体积 / 月总账 / ACL /
# devices.json 并发写 / 日切失败重试。
#
# 隔离：--network none、源码只读挂载、容器用完即删；不接触任何真机。
#
# 产物策略（避免“验 A 装 B”的并发窗口）：
#   - 默认从**当前源码**构建到临时目录（tools/build-ipk.sh --out），不碰共享
#     dist/，因此不会覆盖发布门禁/其他人正在构建的产物；
#   - --no-build 复用现有 dist/：先把 dist 复制成快照，再在快照上校验 SHA256SUMS
#     并挂载快照 —— 校验与容器启动之间即使有人重建 dist，也不会影响本次门禁。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"

# 兼容旧调用：SKIP_BUILD=1 等价于 --no-build。
if [ -n "${SKIP_BUILD:-}" ]; then
  if [ "$SKIP_BUILD" = 1 ]; then BUILD=0; else BUILD=1; fi
else
  BUILD=1
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help)
      echo "用法: $0 [--build|--no-build]"
      echo "默认从源码构建到临时目录；--no-build 复用 dist/ 快照（仍会校验 SHA256SUMS）。"
      exit 0
      ;;
    *) echo "$0: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
DIST="$WORK/dist"

if [ "$BUILD" = 1 ]; then
  echo ">>> 从当前源码构建到临时目录（不覆盖共享 dist/）"
  "$ROOT/tools/build-ipk.sh" --out "$DIST"
else
  echo ">>> 复用现有 dist 快照（--no-build）"
  [ -d "$ROOT/dist" ] || { echo "ERROR: 缺少 $ROOT/dist；先运行 tools/build-ipk.sh 或本脚本加 --build" >&2; exit 1; }
  mkdir -p "$DIST"
  cp -a "$ROOT/dist/." "$DIST/"
fi

for p in prism-router_1.0.0-1_all.ipk luci-app-prism-router_1.0.0-1_all.ipk; do
  [ -f "$DIST/$p" ] || { echo "ERROR: 缺少 $DIST/$p；先运行 tools/build-ipk.sh 或本脚本加 --build" >&2; exit 1; }
done
[ -f "$DIST/SHA256SUMS" ] || { echo "ERROR: 缺少 $DIST/SHA256SUMS；拒绝在未校验的产物上跑门禁" >&2; exit 1; }
( cd "$DIST" && sha256sum -c SHA256SUMS ) >/dev/null || { echo "ERROR: dist/SHA256SUMS 校验失败" >&2; exit 1; }

echo ">>> 核心修复用例（隔离容器：--network none）"
docker run --rm --network none \
  -v "$DIST:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-core-fixes-inner.sh
