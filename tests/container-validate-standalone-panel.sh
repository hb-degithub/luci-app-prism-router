#!/bin/bash
# 独立面板服务门禁（第 13 套）：
#   默认复用 dist（或 --build 临时构建）→ 在隔离 OpenWrt 24.10 容器里安装
#   prism-router → 起 ubusd/procd/rpcd → 用真实 procd 启动独立 uhttpd →
#   验证「默认关闭不监听 / 200+JSON+安全响应头 / 400 / 401 / 405 / token(query+header) /
#   history days / 静态页面 / 非法 port·bind 回退 / 后端异常 500 不泄漏 / 不写日志」。
#
# 隔离：--network none（只有 loopback）、源码只读挂载、容器用完即删；不接触真机。
# 默认复用已校验的 dist（SKIP_BUILD=1），并在校验 SHA256SUMS 后快照再挂载，
# 避免并行门禁运行期间 dist 被重建导致“验的是 A、装的是 B”。
# --build 使用 tools/build-ipk.sh --out <临时目录> 构建本次源码，**不覆盖项目 dist**。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
SKIP_BUILD="${SKIP_BUILD:-1}"
BUILD_DIR=""
SNAP=""

cleanup() {
  if [ -n "$BUILD_DIR" ]; then rm -rf -- "$BUILD_DIR"; fi
  if [ -n "$SNAP" ]; then rm -rf -- "$SNAP"; fi
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --build) SKIP_BUILD=0 ;;
    --no-build) SKIP_BUILD=1 ;;
    -h|--help)
      echo "用法: $0 [--build|--no-build]"
      echo "默认 SKIP_BUILD=1，复用并校验 dist/；--build 构建到临时目录（不覆盖项目 dist）。"
      exit 0
      ;;
    *) echo "$0: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$SKIP_BUILD" = 0 ]; then
  echo ">>> 构建包到临时目录（--build；不覆盖项目 dist）"
  BUILD_DIR="$(mktemp -d)"
  "$ROOT/tools/build-ipk.sh" --out "$BUILD_DIR" >/dev/null
  DIST="$BUILD_DIR"
else
  echo ">>> 复用现有 dist（SKIP_BUILD=1；需要重建请加 --build）"
  DIST="$ROOT/dist"
fi

for p in luci-app-prism-router_1.0.0-1_all.ipk luci-app-prism-router_1.0.0-1_all.ipk; do
  [ -f "$DIST/$p" ] || { echo "ERROR: 缺少 $DIST/$p；先运行 tools/build-ipk.sh 或本脚本加 --build" >&2; exit 1; }
done
[ -f "$DIST/SHA256SUMS" ] || { echo "ERROR: 缺少 $DIST/SHA256SUMS；拒绝在未校验的产物上跑门禁" >&2; exit 1; }

# 先校验来源，再快照，最后校验将要挂载的那份快照：任何一步不一致都拒绝。
( cd "$DIST" && sha256sum -c SHA256SUMS ) >/dev/null \
  || { echo "ERROR: $DIST/SHA256SUMS 校验失败（产物被改动或不完整）" >&2; exit 1; }
SNAP="$(mktemp -d)"
cp -a "$DIST/." "$SNAP/"
( cd "$SNAP" && sha256sum -c SHA256SUMS ) >/dev/null \
  || { echo "ERROR: dist 快照校验失败（运行期间产物被改动）" >&2; exit 1; }

echo ">>> 独立面板用例（隔离容器：--network none，仅 127.0.0.1）"
docker run --rm --network none \
  -v "$SNAP:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/standalone-panel-inner.sh