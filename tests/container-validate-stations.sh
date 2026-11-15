#!/bin/bash
# 哑桥 AP「无线站点元数据上报」容器门禁：
#   构建两个包 → 在隔离的 OpenWrt 24.10 容器里跑「AP 采集 → CGI 接收 → 落盘 → rpcd → 负例」。
# 隔离：--network none（只有 loopback）、源码只读挂载、容器用完即删；不接触任何真机。
# 与另外两条门禁互不影响：
#   container-validate.sh        原有 28 项（包安装 / 权限 / 守护进程离线用例）
#   container-validate-nodes.sh  子母多节点 75 项
#   container-validate-stations.sh  本文件：AP 站点元数据（只报信号/速率，不报字节）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
echo ">>> 1/2 构建包"
"$ROOT/tools/build-ipk.sh" >/dev/null
echo ">>> 2/2 站点元数据用例（隔离容器：--network none，仅 127.0.0.1）"
docker run --rm --network none \
  -v "$ROOT/dist:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  -v "$ROOT/tests/fixtures:/fixtures:ro" \
  "$IMAGE" /bin/sh /src/tests/container-stations-inner.sh
