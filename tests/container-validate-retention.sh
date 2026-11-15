#!/bin/bash
# 数据 / 日志保留与清理（retention.uc）容器门禁：
#   构建两个包 → 在隔离 OpenWrt 24.10 容器里安装 → 用**真实文件**验证按天删除、
#   日志截断、队列上限、dry-run、越权保护与摘要行，并回归守护进程的 daily 清理归属。
# 隔离：--network none、源码只读挂载、容器用完即删；不接触任何真机。
# 与其它门禁互不影响：
#   container-validate.sh           原有包安装 / 权限 / 守护进程离线用例
#   container-validate-2305.sh      23.05.5 兼容性
#   container-validate-nodes.sh     子母多节点
#   container-validate-stations.sh  哑桥 AP 站点元数据
#   container-validate-links.sh     无线/有线接入方式
#   container-validate-system.sh    软路由自身性能指标（system 段）
#   container-validate-retention.sh 本文件：数据 / 日志保留与清理（retention.uc）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 保留 / 清理用例（隔离容器：--network none）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-retention-inner.sh
