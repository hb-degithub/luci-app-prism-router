#!/bin/bash
# 飞书推送可配化（发什么 / 什么时候发 / 什么条件下发）容器门禁：
#   构建包 → 在隔离的 OpenWrt 24.10 容器里跑「report_items 组合 / 调度判定 / 告警阈值 /
#   免打扰 / 体积与标签 / 既有自测回归」。
# 隔离：--network none（只有 loopback）、源码只读挂载、容器用完即删；不接触任何真机。
#
# 与另外五条门禁互不影响：
#   container-validate.sh           原有门禁（包安装 / 权限 / 守护进程离线用例）
#   container-validate-2305.sh      23.05.5 兼容性
#   container-validate-nodes.sh     子母多节点
#   container-validate-stations.sh  哑桥 AP 站点元数据
#   container-validate-links.sh     接入方式（无线/有线）
#   container-validate-feishu.sh   本文件：飞书推送内容/时间/条件可配
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 飞书可配化用例（隔离容器：--network none，仅 127.0.0.1）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-feishu-inner.sh
