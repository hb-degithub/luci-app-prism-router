#!/bin/bash
# 容器门禁共享版本解析：从 dist 里唯一的 modern ipk 反推版本，
# 不再把 1.0.0 写死在每个 wrapper 里。
prism_pick_ipk() { # $1=dist 目录
  local dist="$1" f
  PRISM_IPK=""
  for f in "$dist"/luci-app-prism-router_*.ipk; do
    [ -f "$f" ] || continue
    case "$f" in *.legacy.ipk) continue ;; esac
    if [ -n "$PRISM_IPK" ]; then
      echo "ERROR: $dist 里有多个 modern ipk，拒绝猜测要验证哪一个" >&2
      return 1
    fi
    PRISM_IPK="$f"
  done
  [ -n "$PRISM_IPK" ] || { echo "ERROR: $dist 中缺少插件 ipk；先运行 tools/build-ipk.sh 或本脚本加 --build" >&2; return 1; }
  PRISM_IPK_NAME=$(basename "$PRISM_IPK")
  PRISM_VER=$(printf '%s' "$PRISM_IPK_NAME" | sed -n 's/^luci-app-prism-router_\(.*\)-[0-9][0-9]*_all\.ipk$/\1/p')
  [ -n "$PRISM_VER" ] || { echo "ERROR: 无法从 $PRISM_IPK_NAME 解析版本" >&2; return 1; }
  export PRISM_IPK PRISM_IPK_NAME PRISM_VER
}
