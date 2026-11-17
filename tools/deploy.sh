#!/bin/bash
# 把仓库文件部署到路由器（仅开发期手工排查用，不生成 ipk）
#
# 正式部署请优先安装 dist/*.ipk（见 docs/DEPLOY-RULES.md）：手推文件不会经过
# opkg 的 conffile / 卸载清单 / 依赖检查，内容与权限也可能与包不一致。
#
# 用法: tools/deploy.sh [main|ap|both] [--all|--daemon-only|--ui-only] [--dry-run|--apply]
#   默认 --dry-run：只打印将要写入的完整路径清单，不执行任何 ssh。
#   只有显式 --apply 才通过既有 ssh helper（~/软路由/rssh.sh、assh.sh）执行。
#   --ui-only 不会推送任何 daemon / CGI / 配置；--daemon-only 不推送 LuCI 资源。
#
# 环境变量（测试用）：RSH_HELPER / ASH_HELPER 可指向 stub；生产环境不要改。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

TARGET=main
MODE=--all
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    main|ap|both)        TARGET="$1" ;;
    --all|--daemon-only|--ui-only) MODE="$1" ;;
    --dry-run)           APPLY=0 ;;
    --apply)             APPLY=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "deploy: 未知参数 $1" >&2
      echo "用法: $0 [main|ap|both] [--all|--daemon-only|--ui-only] [--dry-run|--apply]" >&2
      exit 2 ;;
  esac
  shift
done

RSH_HELPER="${RSH_HELPER:-$HOME/软路由/rssh.sh}"
ASH_HELPER="${ASH_HELPER:-$HOME/软路由/assh.sh}"
HOST_MAIN=192.168.100.1
HOST_AP=192.168.100.3

if [ "$APPLY" = 1 ]; then
  echo "WARNING: 手推文件仅用于开发调试；正式部署请优先安装 dist/*.ipk（opkg 才有依赖/conffile/卸载保障）。" >&2
fi

# 在给定 helper 上执行一条远程 shell 命令（仅 --apply 调用）。
remote() { # $1=helper $2=command
  if [ "$APPLY" = 1 ]; then
    "$1" "$2"
  else
    printf '  [dry-run] %s\n' "$2"
  fi
}

# 推送单个文件：先确保父目录存在；落到目标后统一 chmod。
push_file() { # $1=helper $2=label $3=src $4=dst $5=mode
  local helper="$1" label="$2" src="$3" dst="$4" mode="$5"
  if [ ! -f "$src" ]; then
    echo "deploy: 源文件缺失 $src" >&2
    return 1
  fi
  if [ "$APPLY" = 1 ]; then
    "$helper" "mkdir -p '$(dirname "$dst")' && cat > '$dst' && chmod '$mode' '$dst'" < "$src"
  else
    printf '  [%s] %-58s -> %s:%s (%s)\n' "$label" "${src#"$HERE"/}" "$label" "$dst" "$mode"
  fi
}

# 配置文件只在目标不存在时落盘，绝不覆盖真机已有配置。
push_config_if_missing() { # $1=helper $2=label $3=src $4=dst
  local helper="$1" label="$2" src="$3" dst="$4"
  if [ ! -f "$src" ]; then
    echo "deploy: 源文件缺失 $src" >&2
    return 1
  fi
  if [ "$APPLY" = 1 ]; then
    "$helper" "[ -e '$dst' ] || { mkdir -p '$(dirname "$dst")' && cat > '$dst' && chmod 644 '$dst'; }" < "$src"
  else
    printf '  [%s] %-58s -> %s:%s (仅当目标不存在)\n' "$label" "${src#"$HERE"/}" "$label" "$dst"
  fi
}

ensure_daemon_dirs() { # $1=helper
  remote "$1" 'mkdir -p /usr/bin /etc/init.d /etc/config /etc/prism-router/daily /usr/share/prism-router /www/cgi-bin'
}
ensure_ui_dirs() { # $1=helper
  remote "$1" 'mkdir -p /www/luci-static/resources/view/prism-router /www/luci-static/resources/prism-router /usr/share/rpcd/ucode /usr/share/rpcd/acl.d /usr/share/luci/menu.d'
}

push_daemon() { # $1=helper $2=label
  local helper="$1" label="$2"
  echo "[daemon:$label]"
  ensure_daemon_dirs "$helper"
  push_file "$helper" "$label" "$HERE/prism-router/files/prism-routerd.uc" \
    /usr/bin/prism-routerd 755
  push_file "$helper" "$label" "$HERE/prism-router/files/prism-routerd.init" \
    /etc/init.d/prism-routerd 755
  push_config_if_missing "$helper" "$label" "$HERE/prism-router/files/prism-router.config" \
    /etc/config/prism-router
  push_file "$helper" "$label" "$HERE/prism-router/files/feishu.uc" \
    /usr/share/prism-router/feishu.uc 644
  push_file "$helper" "$label" "$HERE/prism-router/files/feishu-test.sh" \
    /usr/share/prism-router/feishu-test.sh 755
  push_file "$helper" "$label" "$HERE/prism-router/files/retention.uc" \
    /usr/share/prism-router/retention.uc 644
  push_file "$helper" "$label" "$HERE/prism-router/files/push.uc" \
    /usr/share/prism-router/push.uc 644
  push_file "$helper" "$label" "$HERE/prism-router/files/stations.uc" \
    /usr/share/prism-router/stations.uc 644
  if [ -f "$HERE/prism-router/files/prism-router-node-auth.uc" ]; then
    push_file "$helper" "$label" "$HERE/prism-router/files/prism-router-node-auth.uc" \
      /usr/share/prism-router/prism-router-node-auth.uc 644
  fi
  # 母节点接收 CGI、AP 站点元数据 CGI、Prometheus 指标 CGI（都必须可执行）
  push_file "$helper" "$label" "$HERE/prism-router/files/ingest.uc" \
    /www/cgi-bin/prism-router-ingest 755
  push_file "$helper" "$label" "$HERE/prism-router/files/ingest-stations.uc" \
    /www/cgi-bin/prism-router-stations 755
  push_file "$helper" "$label" "$HERE/prism-router/files/prism-router-metrics.uc" \
    /www/cgi-bin/prism-router-metrics 755
  echo "  提示：使新文件生效需执行 /etc/init.d/prism-routerd restart"
}

push_ui() { # $1=helper $2=label
  local helper="$1" label="$2" f b
  echo "[ui:$label]"
  ensure_ui_dirs "$helper"
  for f in "$HERE"/luci-app-prism-router/htdocs/luci-static/resources/view/prism-router/*.js; do
    [ -f "$f" ] || continue
    b=$(basename "$f")
    push_file "$helper" "$label" "$f" "/www/luci-static/resources/view/prism-router/$b" 644
  done
  # PWA 资源：manifest / 图标 / 应用类别表，必须与 JS 一起推，否则手机版安装到主屏会 404
  for f in "$HERE"/luci-app-prism-router/htdocs/luci-static/resources/prism-router/*; do
    [ -f "$f" ] || continue
    b=$(basename "$f")
    push_file "$helper" "$label" "$f" "/www/luci-static/resources/prism-router/$b" 644
  done
  push_file "$helper" "$label" "$HERE/luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router.uc" \
    /usr/share/rpcd/ucode/prism-router.uc 644
  # 安全 agent 新增的 rpcd ucode 插件：存在才推，避免 deploy 比包少文件
  if [ -f "$HERE/luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router-node-auth.uc" ]; then
    push_file "$helper" "$label" "$HERE/luci-app-prism-router/root/usr/share/rpcd/ucode/prism-router-node-auth.uc" \
      /usr/share/rpcd/ucode/prism-router-node-auth.uc 644
  fi
  push_file "$helper" "$label" "$HERE/luci-app-prism-router/root/usr/share/rpcd/acl.d/luci-app-prism-router.json" \
    /usr/share/rpcd/acl.d/luci-app-prism-router.json 644
  push_file "$helper" "$label" "$HERE/luci-app-prism-router/root/usr/share/luci/menu.d/luci-app-prism-router.json" \
    /usr/share/luci/menu.d/luci-app-prism-router.json 644
  if [ "$APPLY" = 1 ]; then
    "$helper" 'rm -f /tmp/luci-indexcache* 2>/dev/null; /etc/init.d/rpcd reload >/dev/null 2>&1 || true'
  else
    printf '  [%s] 远程 reload: rm -f /tmp/luci-indexcache*; /etc/init.d/rpcd reload\n' "$label"
  fi
}

check_helper() { # $1=helper
  if [ "$APPLY" = 1 ] && [ ! -x "$1" ]; then
    echo "deploy: ssh helper 不存在或不可执行: $1" >&2
    return 1
  fi
}

run_for_targets() { # $1=push_daemon|push_ui
  local fn="$1"
  case "$TARGET" in
    main) check_helper "$RSH_HELPER"; "$fn" "$RSH_HELPER" "main@$HOST_MAIN" ;;
    ap)   check_helper "$ASH_HELPER"; "$fn" "$ASH_HELPER" "ap@$HOST_AP" ;;
    both) check_helper "$RSH_HELPER"; check_helper "$ASH_HELPER"
          "$fn" "$RSH_HELPER" "main@$HOST_MAIN"
          "$fn" "$ASH_HELPER" "ap@$HOST_AP" ;;
  esac
}

if [ "$APPLY" = 0 ]; then
  echo ">>> DRY-RUN（不执行 ssh；加 --apply 才会真正写入）"
fi
case "$MODE" in
  --daemon-only) run_for_targets push_daemon ;;
  --ui-only)     run_for_targets push_ui ;;
  --all)         run_for_targets push_daemon; run_for_targets push_ui ;;
esac
if [ "$APPLY" = 0 ]; then
  echo ">>> DRY-RUN 结束：以上为完整路径清单，未连接任何设备。"
fi
