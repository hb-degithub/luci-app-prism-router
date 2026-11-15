#!/bin/bash
# 软路由自身性能指标（state.json 的 system 段）容器门禁：
#   构建两个包 → 在隔离 OpenWrt 24.10 容器里跑「真实 /proc + 伪造 /proc（FIFO 两次采样）
#   + 空 /proc 降级 + df 60s 缓存 + system 段体积 / state.json 增量」。
# 隔离：--network none、源码只读挂载、容器用完即删；不接触任何真机。
# 与现有五条门禁互不影响：
#   container-validate.sh           原有包安装 / 权限 / 守护进程离线用例
#   container-validate-2305.sh      23.05.5 兼容性
#   container-validate-nodes.sh     子母多节点
#   container-validate-stations.sh  哑桥 AP 站点元数据
#   container-validate-links.sh     无线/有线接入方式
#   container-validate-system.sh    本文件：软路由自身性能指标（system 段）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 系统指标用例（隔离容器：--network none，仅 /proc 与 FIFO）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-system-inner.sh
