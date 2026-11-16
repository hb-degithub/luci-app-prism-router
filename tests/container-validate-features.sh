#!/bin/bash
# 设备别名/分组 · 月配额 · 导出（CSV/JSON + Prometheus）· 陌生设备标记 容器门禁：
#   构建两个包 → 在隔离 OpenWrt 24.10 容器里跑「别名往返 / 当月配额跨月边界 / CSV 转义 /
#   Prometheus 文本格式与 token 校验 / first_seen / 向后兼容」。
# 隔离：--network none、源码只读挂载、容器用完即删；不接触任何真机。
# 与现有门禁互不影响：
#   container-validate.sh           原有包安装 / 权限 / 守护进程离线用例
#   container-validate-2305.sh      23.05.5 兼容性
#   container-validate-nodes.sh     子母多节点
#   container-validate-stations.sh  哑桥 AP 站点元数据
#   container-validate-links.sh     无线/有线接入方式
#   container-validate-system.sh    软路由自身性能指标（system 段）
#   container-validate-retention.sh 数据/日志保留与清理
#   container-validate-feishu.sh    飞书报表
#   container-validate-features.sh  本文件：设备元数据 / 月配额 / 导出 / Prometheus
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 设备元数据 / 月配额 / 导出 / Prometheus 用例（隔离容器：--network none）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-features-inner.sh
