#!/bin/bash
# 一次跑完全部门禁：先构建一次 dist，再串行跑所有 wrapper（wrapper 都用 SKIP_BUILD=1）。
# 包含发布、原有回归、核心统计、认证安全与独立面板共 13 套。
#
# 为什么需要它：每个 container-validate*.sh 过去都会先 build 一次，多个门禁并行时
# 会互相 rm -rf / 重写 dist，出现“A 门禁装到 B 门禁刚写一半的包”。这里只 build 一次，
# 后续门禁只读 dist/SHA256SUMS，避免抢写。
#
# 全部隔离容器都使用 --network none；本脚本不会连接真机或外网。
#
# 用法：
#   tools/test-release.sh                 # build 一次 + 串行跑全部 13 个门禁
#   tools/test-release.sh --only features # 只跑名字匹配 features 的门禁（调试用）
#   tools/test-release.sh --list          # 列出门禁
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ONLY=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) [ $# -ge 2 ] || { echo "--only 需要关键字" >&2; exit 2; }; ONLY="$2"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    --list) LIST=1 ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "test-release: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done

GATES=(
  # release gate 最先跑：它逐字节比对 payload 与源码，最容易受并行 agent 编辑影响；
  # 其他门禁只读 dist 快照，源码后续变动不影响它们。
  container-validate-release.sh
  container-validate.sh
  container-validate-2305.sh
  container-validate-links.sh
  container-validate-nodes.sh
  container-validate-stations.sh
  container-validate-system.sh
  container-validate-retention.sh
  container-validate-feishu.sh
  container-validate-features.sh
  container-validate-core-fixes.sh
  container-validate-security-fixes.sh
  container-validate-standalone-panel.sh
)

if [ "$LIST" = 1 ]; then
  printf '%s\n' "${GATES[@]}"
  exit 0
fi

for img in openwrt-24.10:deps openwrt-23.05:deps; do
  docker image inspect "$img" >/dev/null 2>&1 || {
    echo "ERROR: 缺少本地镜像 $img（本门禁不联网拉取；请先在可联网环境构建）" >&2
    exit 1
  }
done

echo "############ 构建一次（此后所有门禁只读 dist） ############"
"$ROOT/tools/build-ipk.sh"
echo
echo "############ 校验发布产物 ############"
( cd "$ROOT/dist" && sha256sum -c SHA256SUMS )
echo

FAILED=0
RAN=0
for gate in "${GATES[@]}"; do
  if [ -n "$ONLY" ] && ! printf '%s' "$gate" | grep -q "$ONLY"; then
    continue
  fi
  RAN=$((RAN + 1))
  echo
  echo "############ [$RAN] $gate ############"
  if SKIP_BUILD=1 "$ROOT/tests/$gate"; then
    echo "############ PASS $gate ############"
  else
    echo "############ FAIL $gate ############" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo
if [ "$RAN" -eq 0 ]; then
  echo "ERROR: --only '$ONLY' 没有匹配任何门禁" >&2
  exit 2
fi
echo "############ 最终发布物完整性复核 ############"
( cd "$ROOT/dist" && sha256sum -c SHA256SUMS ) || exit 1

echo "############ 汇总：运行 $RAN 个门禁，失败 $FAILED 个 ############"
if [ "$FAILED" -ne 0 ]; then
  echo "注意：并行开发时失败可能来自其他 agent 尚未完成的改动；请结合具体门禁输出定位。" >&2
  exit 1
fi
