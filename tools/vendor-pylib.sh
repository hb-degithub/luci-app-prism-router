#!/bin/bash
# 重新生成 luci-app-prism-router/pylib/（官方 lark-oapi 长连接子集）
#
# 为什么要在路由器上跑：
#   lark-oapi 依赖的 pycryptodome / websockets / charset_normalizer 随包分发的是
#   **musl** 轮子（Tag: cp39-abi3-musllinux_1_2_x86_64 / cp311-musllinux），
#   宿主 glibc 既下不到也加载不了；路由器（iStoreOS 24.10 x86_64 + python 3.11）
#   能访问 PyPI，正好用 `pip download --no-deps --only-binary=:all:` 取到同一批轮子。
#
# 流程：把 tools/pylib_tool.py 送到路由器 → 在路由器上 pip download + 裁剪 + 打补丁
#       → 在路由器上真 import 自检 → 把目录树流回本机 → 原子替换仓库里的 pylib/。
#
# 用法：
#   tools/vendor-pylib.sh                 # 默认：pip download 后重建
#   tools/vendor-pylib.sh --site          # 复用路由器已装的 site-packages（离线）
#   tools/vendor-pylib.sh --dest DIR      # 输出到别处（默认 luci-app-prism-router/pylib）
#   tools/vendor-pylib.sh --rssh PATH     # 指定 ssh 包装脚本（默认 ~/软路由/rssh.sh）
#   tools/vendor-pylib.sh --dry-run       # 只构建+校验，不改仓库
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/luci-app-prism-router/pylib"
RSSH="${PRISM_RSSH:-$HOME/软路由/rssh.sh}"
REMOTE="${PRISM_VENDOR_REMOTE:-/tmp/prism-vendor}"
MODE="download"
DRY=0

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --site) MODE="site" ;;
    --download) MODE="download" ;;
    --dest) [ $# -ge 2 ] || { echo "vendor-pylib: --dest 需要目录" >&2; exit 2; }; DEST="$2"; shift ;;
    --rssh) [ $# -ge 2 ] || { echo "vendor-pylib: --rssh 需要路径" >&2; exit 2; }; RSSH="$2"; shift ;;
    --remote) [ $# -ge 2 ] || { echo "vendor-pylib: --remote 需要路径" >&2; exit 2; }; REMOTE="$2"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "vendor-pylib: 未知参数 $1（--help 查看用法）" >&2; exit 2 ;;
  esac
  shift
done

[ -x "$RSSH" ] || { echo "vendor-pylib: 找不到可执行的 ssh 包装脚本：$RSSH" >&2; exit 1; }
[ -n "$DEST" ] || { echo "vendor-pylib: 输出目录为空" >&2; exit 1; }
case "$DEST" in /|.|..|"$HOME"|"$ROOT") echo "vendor-pylib: 拒绝把输出目录设为 $DEST" >&2; exit 2 ;; esac
case "$REMOTE" in /tmp/*) ;; *) echo "vendor-pylib: --remote 必须在 /tmp 下" >&2; exit 2 ;; esac

rssh() { "$RSSH" "$@"; }

echo ">>> 0/5 探测目标机（必须 musl x86_64 + python3.11）"
INFO=$(rssh 'python3 -c "import sys,sysconfig;print(sys.version.split()[0], sysconfig.get_platform())"' 2>&1) \
  || { echo "vendor-pylib: 目标机 python3 不可用：$INFO" >&2; exit 1; }
echo "    $INFO"
case "$INFO" in
  3.11*) ;;
  *) echo "vendor-pylib: 目标机 python 不是 3.11（$INFO）；pylib 里的 .so 是与 3.11 绑定的" >&2; exit 1 ;;
esac

echo ">>> 1/5 上传 tools/pylib_tool.py 到 $REMOTE"
tar czf - -C "$ROOT/tools" pylib_tool.py \
  | rssh "rm -rf '$REMOTE' && mkdir -p '$REMOTE' && tar xzf - -C '$REMOTE'" >/dev/null

echo ">>> 2/5 在目标机构建 pylib（模式：$MODE）"
if [ "$MODE" = "site" ]; then
  rssh "cd '$REMOTE' && python3 pylib_tool.py build --dest '$REMOTE/pylib' --site /usr/lib/python3.11/site-packages"
else
  rssh "cd '$REMOTE' && python3 pylib_tool.py build --dest '$REMOTE/pylib' --download"
fi

echo ">>> 3/5 目标机真 import 自检（AES-CBC / 两个事件注册 / ws Client 构造）"
rssh "cd '$REMOTE' && python3 pylib_tool.py verify --pylib '$REMOTE/pylib' --static-imports --import-check" \
  | tee /tmp/vendor-pylib-verify.json >/dev/null
python3 - /tmp/vendor-pylib-verify.json <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
if not data.get("ok"):
    print("FAIL: 目标机校验失败：", [k for k, v in data["checks"].items() if not v["ok"]], file=sys.stderr)
    raise SystemExit(1)
rt = data.get("runtime_import") or {}
print("    runtime_import=%s rss=%sKB modules=%s" % (
    rt.get("ok"), rt.get("rss_kb"), rt.get("loaded_modules")))
print("    checks=%d 全部通过" % len(data["checks"]))
PY

echo ">>> 4/5 回传目录树"
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
rssh "tar czf - -C '$REMOTE' pylib" | tar xzf - -C "$STAGE"
[ -f "$STAGE/pylib/MANIFEST.json" ] || { echo "vendor-pylib: 回传内容缺 MANIFEST.json" >&2; exit 1; }

echo ">>> 5/5 落地到 $DEST"
if [ "$DRY" = 1 ]; then
  echo "    --dry-run：仅校验回传内容，不替换仓库目录"
  python3 "$ROOT/tools/pylib_tool.py" verify --pylib "$STAGE/pylib" --static-imports \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("    host verify ok =", d["ok"])'
  du -sk "$STAGE/pylib"
  exit 0
fi
# 先落地到同级临时目录，再整体替换，避免中断留下半个 pylib。
TMP_DEST="${DEST}.new"
rm -rf -- "$TMP_DEST"
mkdir -p -- "$(dirname "$DEST")"
cp -a "$STAGE/pylib" "$TMP_DEST"
chmod 755 "$TMP_DEST"
python3 "$ROOT/tools/pylib_tool.py" verify --pylib "$TMP_DEST" --static-imports \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("    host verify ok =", d["ok"]); sys.exit(0 if d["ok"] else 1)'
rm -rf -- "$DEST"
mv -- "$TMP_DEST" "$DEST"
echo
echo "完成：$DEST"
du -sk "$DEST" | awk '{printf "  磁盘占用(4K块): %d KB\n", $1}'
python3 "$ROOT/tools/pylib_tool.py" verify --pylib "$DEST" --static-imports \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  最终 verify ok =", d["ok"])'
