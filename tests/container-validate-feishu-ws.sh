#!/bin/bash
# 飞书长连接（官方 lark-oapi + 随包 SDK）容器门禁：
#   1. 宿主机：pylib 清单/校验和/静态 import 图；feishu-ws.py 语法与自检脚本结构
#   2. 容器内（openwrt 24.10 / 23.05，--network none）：
#        - 安装后在位文件与权限（feishu-ws.py / init.d / pylib 全树 644/755）
#        - 默认配置 ws_enabled=0，长连接默认不启动
#        - rpcd 方法 feishu_ws_status 的脱敏摘要：未运行/运行中/心跳过期/坏 JSON/
#          超量裁剪；日志尾部脱敏；返回值绝不含 secret
#        - set_config 白名单接受 ws_enabled（UI 保存路径）
#        - init 脚本在缺凭据/未启用时正常返回、不产生 pid
#
# 隔离：--network none（只有 loopback）、源码只读挂载、容器用完即删；不接触任何真机。
# 宿主 glibc 加载不了 pylib 里的 musl .so，门禁镜像里也没有 python3，因此
# 「真 import lark_oapi + 真连飞书」只能在路由器上做（命令见 docs/FEISHU-WS.md
# 的「真机验证」一节）。本门禁负责结构、权限、rpcd 摘要、脱敏与 init 行为。
#
# 默认复用 dist/ 并校验 SHA256SUMS；--build 才重建一次。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-openwrt-24.10:deps}"
SKIP_BUILD="${SKIP_BUILD:-1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --build) SKIP_BUILD=0 ;;
    --no-build) SKIP_BUILD=1 ;;
    -h|--help) echo "用法: $0 [--build|--no-build]"; echo "默认 SKIP_BUILD=1，复用 dist；--build 先重建一次。"; exit 0 ;;
    *) echo "$0: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$SKIP_BUILD" = 0 ]; then
  echo ">>> 构建包（--build）"
  "$ROOT/tools/build-ipk.sh"
else
  echo ">>> 复用现有 dist（SKIP_BUILD=1；需要重建请加 --build）"
fi
DIST="$ROOT/dist"
source "$ROOT/tests/lib/prism-version.sh"
prism_pick_ipk "$DIST"
[ -f "$DIST/SHA256SUMS" ] || { echo "ERROR: 缺少 $DIST/SHA256SUMS；拒绝在未校验的产物上跑门禁" >&2; exit 1; }
SNAP=$(mktemp -d)
trap 'rm -rf "$SNAP"' EXIT
cp -a "$DIST/." "$SNAP/"
( cd "$SNAP" && sha256sum -c SHA256SUMS ) >/dev/null || { echo "ERROR: dist/SHA256SUMS 校验失败（产物被改动或不完整）" >&2; exit 1; }

echo ">>> 1/3 宿主侧：pylib 清单 / 静态 import 图 / 服务脚本语法"
[ -d "$ROOT/luci-app-prism-router/pylib" ] || { echo "FAIL: 缺少 luci-app-prism-router/pylib" >&2; exit 1; }
python3 "$ROOT/tools/pylib_tool.py" verify --pylib "$ROOT/luci-app-prism-router/pylib" --static-imports \
  > /tmp/feishu-ws-pylib.json 2>&1 \
  || { echo "FAIL: pylib 校验失败" >&2; cat /tmp/feishu-ws-pylib.json >&2; exit 1; }
python3 - <<'PY'
import json
d = json.load(open("/tmp/feishu-ws-pylib.json"))
failed = [k for k, v in d["checks"].items() if not v["ok"]]
if failed:
    raise SystemExit("pylib 校验失败项：%s" % failed)
stats = d["static_imports"]
if stats["missing"] or stats["hard_external"]:
    raise SystemExit("静态 import 图异常：missing=%s hard=%s"
                     % (stats["missing"], stats["hard_external"]))
print("  PASS  pylib 校验通过（静态图 %d 模块，硬外部依赖 0）" % stats["reachable_modules"])
PY
# 服务脚本：语法 + 不含明文 secret 打印 + 有 --selftest/--check 入口
# 语法检查用 compile()，不落 .pyc（避免把 __pycache__ 写进 root/ 污染 payload 门禁）。
python3 - "$ROOT/luci-app-prism-router/root/usr/share/prism-router/feishu-ws.py" <<'PY'
import ast, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
compile(src, path, "exec")
tree = ast.parse(src)

def mentions_secret(node):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and sub.id in ("app_secret", "secret", "token"):
            return True
        if isinstance(sub, ast.Subscript):
            key = sub.slice
            if isinstance(key, ast.Constant) and key.value in ("app_secret", "secret", "token"):
                return True
    return False

bad = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Call):
        continue
    fn = node.func
    fname = getattr(fn, "attr", None) or getattr(fn, "id", None)
    if fname not in ("write", "print", "debug", "info", "warn", "error", "exception"):
        continue
    args = list(node.args) + [kw.value for kw in node.keywords]
    if any(mentions_secret(arg) for arg in args):
        bad.append((getattr(node, "lineno", 0), fname))
if bad:
    raise SystemExit("feishu-ws.py 可能把 secret 打进日志/输出：%s" % bad)
print("  PASS  feishu-ws.py 语法通过，且日志/输出不引用 secret 变量")
PY
for opt in --selftest --check --version; do
  grep -q -- "$opt" "$ROOT/luci-app-prism-router/root/usr/share/prism-router/feishu-ws.py" \
    || { echo "FAIL: feishu-ws.py 缺 $opt" >&2; exit 1; }
done
echo "  PASS  feishu-ws.py 提供 --selftest / --check / --version"
# init 脚本：默认关闭 + 凭据校验 + PYTHONPATH 指向随包 SDK
INIT="$ROOT/luci-app-prism-router/root/etc/init.d/prism-router-feishu-ws"
grep -q 'PYTHONPATH="\$PYLIB"' "$INIT" || { echo "FAIL: init 未设置 PYTHONPATH" >&2; exit 1; }
grep -q 'ws_enabled' "$INIT" || { echo "FAIL: init 未读 ws_enabled" >&2; exit 1; }
grep -q 'respawn' "$INIT" || { echo "FAIL: init 没有 respawn" >&2; exit 1; }
echo "  PASS  init 读取 ws_enabled / 设置 PYTHONPATH / 配置 respawn"

echo ">>> 2/3 容器内用例（隔离：--network none）"
docker run --rm --network none \
  -e PRISM_VER="$PRISM_VER" \
  -e PRISM_IPK_NAME="$PRISM_IPK_NAME" \
  -e PRISM_ARCH="$PRISM_ARCH" \
  -v "$SNAP:/src/dist:ro" \
  -v "$ROOT/tests:/src/tests:ro" \
  "$IMAGE" /bin/sh /src/tests/container-feishu-ws-inner.sh

echo ">>> 3/3 飞书长连接门禁通过"
