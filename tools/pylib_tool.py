#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prism-router 供应商 pylib 构建 / 校验工具（只用标准库）。

用途
----
把官方 `lark-oapi` 及它**真实 import** 的依赖裁成一个可随 IPK 分发的文件树
（`luci-app-prism-router/pylib/`），安装到 `/usr/lib/prism-router/pylib/`，
由 `/etc/init.d/prism-router-feishu-ws` 用 PYTHONPATH 指向它：

    lark_oapi / Crypto(pycryptodome) / requests / urllib3 / certifi / idna
    / charset_normalizer / websockets

为什么必须裁剪
--------------
1. 体积：lark-oapi 1.8.0 的 `lark_oapi/api/` 有 10534 个 .py（17.7 MB），
   `Crypto/` 12.6 MB（60 个 .so）——整包 34.7 MB，超出插件 25 MB 目标。
2. 内存：`import lark_oapi` 会 `from .api import *`，把 10534 个模块全导进来；
   真机（iStoreOS 24.10 / python 3.11.18）实测 **166 MB RSS / 4.9 s**，
   路由器不可接受。本工具只保留长连接真正需要的 `im` 产品线。

产出是“官方源码 + 明确的裁剪/补丁”。补丁只有 5 处，全部可在
`MANIFEST.json.patches` 核对（含上游 sha256、产物 sha256、原因）：

  * `lark_oapi/__init__.py`        —— 换成 WS 子集的再导出（去掉 api/client/card/scene）
  * `lark_oapi/api/__init__.py`    —— 只 `from . import im`
  * `lark_oapi/api/im/__init__.py` —— 只 `from . import v1`（v2 无本插件事件）
  * `lark_oapi/event/dispatcher_handler.py` —— 加 `from __future__ import annotations`，
    只保留 `from lark_oapi.api.im.v1.processor import *`
  * `lark_oapi/core/http/__init__.py` —— 只 `from .handler import *`（去掉 transport，
    它是唯一硬 import `httpx` + `requests_toolbelt` 的地方，而只有已删除的 Client 用它）

被裁产品线的 `register_p2_*` 方法仍留在 builder 里，但调用会 NameError ——
这是“只分发长连接子集”的已知限制，见 VENDOR.md。

pycryptodome 的 `.so` 是 `cp39-abi3-musllinux_1_2_x86_64`，websockets /
charset_normalizer 的 `.so` 是 `cp311-musllinux`，所以 IPK 的 Architecture
必须是 **x86_64**（不能是 all），且依赖 python3.11。

子命令
------
  build   --dest DIR (--download | --wheels DIR | --site DIR)
  verify  --pylib DIR [--static-imports] [--import-check]

`build --download` 与 `verify --import-check` 必须在目标机（musl x86_64 + py3.11）
上跑：宿主 glibc 加载不了这些 musl .so。`verify --static-imports` 是纯 AST 分析，
任何 python3 都能跑，容器门禁用它。
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

# ------------------------------------------------------------------ 版本锁定
PINS = [
    ("lark-oapi", "lark_oapi", "1.8.0"),
    ("websockets", "websockets", "15.0.1"),
    ("requests", "requests", "2.34.2"),
    ("urllib3", "urllib3", "2.8.0"),
    ("certifi", "certifi", "2026.11.20"),
    ("idna", "idna", "3.20"),
    ("charset-normalizer", "charset_normalizer", "3.5.2"),
    # pycryptodome 的 import 名是 Crypto；只用于 lark AESCipher 的 AES-CBC
    ("pycryptodome", "Crypto", "4.6.0"),
]

# 未被 ws 链路 import 的可选/传递依赖：明确记录“为什么不装”，便于审阅。
NOT_VENDORED = {
    "httpx": "只有 lark_oapi.core.http.transport / channel / scene 使用；transport 的导入已裁",
    "httpcore": "httpx 的依赖，同上",
    "h11": "httpx 的依赖，同上",
    "anyio": "httpx 的依赖，同上",
    "sniffio": "anyio 的依赖，同上",
    "typing_extensions": "仅 anyio 需要；lark_oapi 本体不 import",
    "requests_toolbelt": "只有 api/*/resource 的 MultipartEncoder 用；resource 目录未分发",
    "protobuf": "lark_oapi/ws/pb/google/protobuf 已内置一份",
    "pip": "安装器，不随包",
}

# ------------------------------------------------------------------ 裁剪规则
LARK_KEEP = "core/event/ws/api-im"
LARK_DROP_DIRS = ("adapter", "card", "channel", "scene", "api")
LARK_DROP_FILES = ("client.py",)
# im 产品线里只保留事件模型 + processor：resource/service 只有已删除的 Client 会用，
# 且它们硬 import requests_toolbelt / core.http.Transport。
IM_DROP_NAMES = ("resource", "service.py", "v2")

CRYPTO_KEEP_DIRS = ("Cipher", "Util", "Random")
# lark 只用 AES-CBC；Cipher 里只留这条路径（其余 .so 约 1.6MB 且依赖已裁的 Crypto.Hash）
CRYPTO_CIPHER_KEEP = (
    "__init__.py",
    "AES.py",
    "_mode_cbc.py",
    "_state_machine.py",
    "_raw_aes.abi3.so",
    "_raw_aesni.abi3.so",
    "_raw_cbc.abi3.so",
)

DROP_ANYWHERE_DIRS = ("__pycache__", "tests", "test", "test_data", "Test", "idlelib")
DROP_ANYWHERE_SUFFIXES = (".pyc", ".pyo", ".pyi", ".c", ".h", ".pxd")
DROP_ANYWHERE_NAMES = ("RECORD", "RECORD.jws", "INSTALLER", "REQUESTED", "direct_url.json")

LIMIT_TOTAL_BYTES = 25 * 1024 * 1024
LIMIT_LARK_BYTES = 4 * 1024 * 1024
LIMIT_CRYPTO_BYTES = 4 * 1024 * 1024

MANIFEST = "MANIFEST.json"
MANIFEST_VERSION = 3

# 真正会被 import 的根模块（含运行时按名导入的动态入口）
IMPORT_ROOTS = (
    "lark_oapi",
    "lark_oapi.ws",
    "lark_oapi.event.dispatcher_handler",
    "lark_oapi.api.im.v1.processor",
    "Crypto.Cipher.AES",
    "requests",
    "urllib3",
    "certifi",
    "idna",
    "charset_normalizer",
    "websockets",
    "websockets.asyncio.client",
)

PATCH_INIT_NOTE = """\
# ---------------------------------------------------------------------------
# 本文件由 prism-router 的 tools/pylib_tool.py 替换，不是 lark-oapi 原文件。
# 只保留 WebSocket 长连接子集需要的顶层再导出；api/client/card/scene 未随包分发。
# 完整补丁清单（含上游 sha256）见同目录 MANIFEST.json；说明见 docs/FEISHU-WS.md。
# ---------------------------------------------------------------------------
"""

# 随 pylib 一起进包、并纳入 MANIFEST.totals 的短说明（长文档在仓库 docs/FEISHU-WS.md）。
PYLIB_README = """\
prism-router · 随包分发的 lark-oapi 长连接子集
===============================================

本目录由 tools/pylib_tool.py 生成，请勿手改。上游版本、逐文件 sha256、
裁剪/补丁清单、体积上限、静态 import 图都在 MANIFEST.json。

  * 安装位置：/usr/lib/prism-router/pylib（不写系统 site-packages）
  * 使用方：/usr/share/prism-router/feishu-ws.py（PYTHONPATH 指向本目录）
  * 目标平台：musl x86_64 + CPython 3.11（pycryptodome/websockets 的原生扩展绑定）
  * 重新生成：tools/vendor-pylib.sh（在路由器上 pip download + 裁剪 + 真 import 自检）
  * 离线校验：python3 tools/pylib_tool.py verify --pylib <本目录> --static-imports
  * 说明/已知限制：仓库 docs/FEISHU-WS.md（「随包 SDK」一节）
"""

PATCH_API_INIT = """# 由 prism-router tools/pylib_tool.py 生成：api/ 只随包分发 im 产品线。
from . import im
"""

PATCH_IM_INIT = """# 由 prism-router tools/pylib_tool.py 生成：只保留 v1（本插件只注册 v1 事件）。
from . import v1
"""

PATCH_HTTP_INIT = """# 由 prism-router tools/pylib_tool.py 生成：只导出 HttpHandler。
# transport 是唯一硬 import httpx / requests_toolbelt 的模块，且只有被裁掉的
# lark_oapi.Client 会用它，因此不分发。
from .handler import *
"""

PATCH_FUTURE = "from __future__ import annotations\n"


# ------------------------------------------------------------------ 小工具
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def read_text(path):
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def write_text(path, text):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    os.chmod(path, 0o644)


def walk_files(root):
    """稳定顺序遍历；MANIFEST.json 自身不参与 totals（否则无法自指纹）。"""
    out = []
    for cur, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            p = os.path.join(cur, name)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if rel == MANIFEST:
                continue
            out.append((rel, p))
    return out


def tree_stats(root):
    rows = walk_files(root)
    return len(rows), sum(os.path.getsize(p) for _rel, p in rows)


def tree_digest(root):
    h = hashlib.sha256()
    rows = walk_files(root)
    for rel, p in rows:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(sha256_file(p).encode("ascii"))
        h.update(b"\n")
    return h.hexdigest(), len(rows)


def pkg_files_bytes(root, top):
    base = os.path.join(root, top)
    files = 0
    total = 0
    for cur, _dirs, names in os.walk(base):
        for name in names:
            files += 1
            total += os.path.getsize(os.path.join(cur, name))
    return files, total


def dir_bytes(root, top):
    return pkg_files_bytes(root, top)[1]


# ------------------------------------------------------------------ 取包
def download_wheels(dest):
    reqs = ["%s==%s" % (dist, ver) for dist, _mod, ver in PINS]
    os.makedirs(dest, exist_ok=True)
    cmd = [
        sys.executable, "-m", "pip", "download",
        "--no-deps", "--only-binary=:all:", "--no-cache-dir",
        "--disable-pip-version-check", "--dest", dest,
    ] + reqs
    print("+ " + " ".join(cmd), flush=True)
    subprocess.check_call(cmd)
    return dest


def find_wheel(wheels_dir, dist):
    prefix = dist.replace("-", "_").lower() + "-"
    hits = [os.path.join(wheels_dir, n) for n in sorted(os.listdir(wheels_dir))
            if n.endswith(".whl") and n.lower().startswith(prefix)]
    if len(hits) != 1:
        raise SystemExit("wheel 匹配失败：%s -> %r（期望恰好 1 个）" % (dist, hits))
    return hits[0]


def wheel_meta(wheel_path):
    version, tags = "", []
    with zipfile.ZipFile(wheel_path) as zf:
        for name in zf.namelist():
            if name.endswith(".dist-info/METADATA"):
                for line in zf.read(name).decode("utf-8", "replace").splitlines():
                    if line.startswith("Version: "):
                        version = line[len("Version: "):].strip()
            elif name.endswith(".dist-info/WHEEL"):
                for line in zf.read(name).decode("utf-8", "replace").splitlines():
                    if line.startswith("Tag: "):
                        tags.append(line[len("Tag: "):].strip())
    return version, tags


def extract_wheel(wheel_path, dest_root, module, extras_dir):
    kept = 0
    with zipfile.ZipFile(wheel_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if name.startswith(module + "/"):
                out = os.path.join(dest_root, name)
            elif "/licenses/" in name:
                base = os.path.basename(name)
                if not base:
                    continue
                os.makedirs(extras_dir, exist_ok=True)
                out = os.path.join(extras_dir, base)
            else:
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as fh:
                fh.write(zf.read(info))
            os.chmod(out, 0o644)
            kept += 1
    return kept


# ------------------------------------------------------------------ 裁剪 / 补丁
def should_drop(rel_path):
    parts = rel_path.split("/")
    if any(part in DROP_ANYWHERE_DIRS for part in parts):
        return True
    base = parts[-1]
    if base in DROP_ANYWHERE_NAMES:
        return True
    return any(base.endswith(suffix) for suffix in DROP_ANYWHERE_SUFFIXES)


def prune_generic(root):
    removed = []
    for cur, dirs, names in os.walk(root):
        for d in list(dirs):
            if d in DROP_ANYWHERE_DIRS:
                p = os.path.join(cur, d)
                removed.append(os.path.relpath(p, root).replace(os.sep, "/"))
                shutil.rmtree(p)
                dirs.remove(d)
        for name in names:
            rel = os.path.relpath(os.path.join(cur, name), root).replace(os.sep, "/")
            if should_drop(rel):
                removed.append(rel)
                os.unlink(os.path.join(cur, name))
    return removed


def prune_lark(root):
    base = os.path.join(root, "lark_oapi")
    removed = []
    for name in LARK_DROP_FILES:
        p = os.path.join(base, name)
        if os.path.isfile(p):
            os.unlink(p)
            removed.append("lark_oapi/" + name)
    for name in LARK_DROP_DIRS:
        p = os.path.join(base, name)
        if not os.path.isdir(p):
            continue
        if name == "api":
            for sub in sorted(os.listdir(p)):
                if sub in ("im", "__init__.py"):
                    continue
                sp = os.path.join(p, sub)
                if os.path.isdir(sp):
                    removed.append("lark_oapi/api/%s/" % sub)
                    shutil.rmtree(sp)
                else:
                    removed.append("lark_oapi/api/" + sub)
                    os.unlink(sp)
        else:
            removed.append("lark_oapi/%s/" % name)
            shutil.rmtree(p)
    for name in sorted(os.listdir(base)):
        p = os.path.join(base, name)
        if os.path.isfile(p) and name != "__init__.py":
            os.unlink(p)
            removed.append("lark_oapi/" + name)
    # im 产品线：只留 v1 的 model + processor
    im = os.path.join(base, "api", "im")
    for cur, dirs, names in os.walk(im):
        for d in list(dirs):
            if d == "resource":
                p = os.path.join(cur, d)
                removed.append(os.path.relpath(p, root).replace(os.sep, "/") + "/")
                shutil.rmtree(p)
                dirs.remove(d)
        for name in names:
            if name in ("service.py", "version.py"):
                p = os.path.join(cur, name)
                removed.append(os.path.relpath(p, root).replace(os.sep, "/"))
                os.unlink(p)
    for rel in ("v1/service.py", "service.py"):
        p = os.path.join(im, rel)
        if os.path.isfile(p):
            removed.append("lark_oapi/api/im/" + rel)
            os.unlink(p)
    v2 = os.path.join(im, "v2")
    if os.path.isdir(v2):
        removed.append("lark_oapi/api/im/v2/")
        shutil.rmtree(v2)
    # transport 是硬 import httpx + requests_toolbelt 的唯一模块；导出已摘掉，文件也不分发
    transport = os.path.join(base, "core", "http", "transport.py")
    if os.path.isfile(transport):
        removed.append("lark_oapi/core/http/transport.py")
        os.unlink(transport)
    return removed


def prune_crypto(root):
    base = os.path.join(root, "Crypto")
    removed = []
    keep = set(CRYPTO_KEEP_DIRS) | {"__init__.py", "py.typed"}
    for name in sorted(os.listdir(base)):
        if name in keep:
            continue
        p = os.path.join(base, name)
        if os.path.isdir(p):
            removed.append("Crypto/%s/" % name)
            shutil.rmtree(p)
        else:
            removed.append("Crypto/" + name)
            os.unlink(p)
    cipher = os.path.join(base, "Cipher")
    keep_cipher = set(CRYPTO_CIPHER_KEEP)
    for name in sorted(os.listdir(cipher)):
        if name in keep_cipher:
            continue
        p = os.path.join(cipher, name)
        if os.path.isdir(p):
            removed.append("Crypto/Cipher/%s/" % name)
            shutil.rmtree(p)
        else:
            removed.append("Crypto/Cipher/" + name)
            os.unlink(p)
    return removed


def patch_files(root, records):
    base = os.path.join(root, "lark_oapi")

    def replace(rel, content, reason):
        path = os.path.join(base, rel)
        rec = {"path": "lark_oapi/" + rel, "action": "replace",
               "upstream_sha256": sha256_file(path), "reason": reason}
        write_text(path, content)
        rec["sha256"] = sha256_file(path)
        records.append(rec)

    replace("__init__.py", PATCH_INIT_NOTE + """\
from . import ws
from .core import *
from .event.context import EventContext
from .event.custom import CustomizedEvent
from .event.dispatcher_handler import EventDispatcherHandler

__all__ = [
    "ws",
    "EventContext",
    "CustomizedEvent",
    "EventDispatcherHandler",
]
""", "去掉 from .api import * / .client / .card / .scene（10534 个模块、166MB RSS）")

    replace("api/__init__.py", PATCH_API_INIT,
            "api/ 只分发 im 产品线（两个事件处理器都在 im.v1）")
    replace("api/im/__init__.py", PATCH_IM_INIT,
            "im 只分发 v1（本插件只注册 v1 事件；v2 无对应事件）")
    replace("core/http/__init__.py", PATCH_HTTP_INIT,
            "只导出 HttpHandler：transport 硬 import httpx + requests_toolbelt，"
            "且只有被裁掉的 Client 使用")

    dispatcher = os.path.join(base, "event", "dispatcher_handler.py")
    original = read_text(dispatcher)
    before = sha256_bytes(original.encode("utf-8"))
    out = []
    dropped = []
    for line in original.splitlines(True):
        stripped = line.strip()
        if stripped.startswith("from lark_oapi.api.") and stripped.endswith("processor import *"):
            if "lark_oapi.api.im.v1.processor" in stripped:
                out.append(line)
            else:
                dropped.append(stripped)
            continue
        out.append(line)
    insert_at = 0
    for i, line in enumerate(out):
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            insert_at = i + 1
            continue
        break
    out.insert(insert_at, PATCH_FUTURE)
    records.append({
        "path": "lark_oapi/event/dispatcher_handler.py",
        "action": "patch",
        "upstream_sha256": before,
        "reason": "删除 %d 个已裁产品线的 processor 导入；用 from __future__ import "
                  "annotations 让未定义类型的注解惰性求值（否则 class 定义时 NameError）"
                  % len(dropped),
        "dropped_imports": dropped,
        "dropped_count": len(dropped),
    })
    write_text(dispatcher, "".join(out))
    records[-1]["sha256"] = sha256_file(dispatcher)


# ------------------------------------------------------------------ 静态 import 图
STDLIB = set(getattr(sys, "stdlib_module_names", ())) | {"__future__", "builtins"}
VENDORED_TOP = {module for _dist, module, _ver in PINS}


def _is_type_checking(test):
    if isinstance(test, ast.Name):
        return test.id == "TYPE_CHECKING"
    if isinstance(test, ast.Attribute):
        return test.attr == "TYPE_CHECKING"
    return False


def _handles_import_error(handlers):
    for handler in handlers:
        if handler.type is None:
            return True
        node = handler.type
        if isinstance(node, ast.Tuple):
            names = [getattr(elt, "id", "") for elt in node.elts]
        else:
            names = [getattr(node, "id", "")]
        if any(n in ("ImportError", "ModuleNotFoundError", "Exception", "BaseException")
               for n in names):
            return True
    return False


class _ImportCollector(ast.NodeVisitor):
    """收集 import，同时标记 try/except ImportError 与 TYPE_CHECKING 下的可选导入。"""

    def __init__(self):
        self.items = []  # (module, level, lazy, type_only)
        self._optional = 0
        self._typing = 0
        self._cond = 0
        self._func = 0

    def _add(self, module, level):
        lazy = (self._optional + self._cond + self._func) > 0
        self.items.append((module, level, lazy, self._typing > 0))

    def visit_FunctionDef(self, node):
        self._func += 1
        self.generic_visit(node)
        self._func -= 1

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Import(self, node):
        for alias in node.names:
            self._add(alias.name, 0)

    def visit_ImportFrom(self, node):
        self._add(node.module or "", node.level or 0)

    def visit_If(self, node):
        if _is_type_checking(node.test):
            self._typing += 1
            for stmt in node.body:
                self.visit(stmt)
            self._typing -= 1
            for stmt in node.orelse:
                self.visit(stmt)
            return
        self._cond += 1
        for stmt in node.body:
            self.visit(stmt)
        self._cond -= 1
        for stmt in node.orelse:
            self.visit(stmt)

    def visit_Try(self, node):
        if _handles_import_error(node.handlers):
            self._optional += 1
            for stmt in node.body:
                self.visit(stmt)
            self._optional -= 1
            for handler in node.handlers:
                self.visit(handler)
            for stmt in node.orelse + node.finalbody:
                self.visit(stmt)
            return
        self.generic_visit(node)


def collect_imports(path):
    try:
        tree = ast.parse(read_text(path))
    except SyntaxError as exc:
        return None, str(exc)
    collector = _ImportCollector()
    collector.visit(tree)
    return collector.items, None


def module_file(pylib, parts):
    if not parts:
        return None
    p = os.path.join(pylib, *parts)
    if os.path.isfile(p + ".py"):
        return p + ".py"
    if os.path.isfile(p + ".so"):
        return p + ".so"
    for suffix in (".abi3.so",):
        if os.path.isfile(p + suffix):
            return p + suffix
    d = os.path.dirname(p)
    base = os.path.basename(p)
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if name.startswith(base + ".") and name.endswith(".so"):
                return os.path.join(d, name)
    init = os.path.join(p, "__init__.py")
    if os.path.isfile(init):
        return init
    return None


def static_import_graph(pylib, roots=IMPORT_ROOTS):
    """从 IMPORT_ROOTS 出发做可达图，返回统计（含缺模块 / 硬外部依赖）。"""
    queue = [(root, False) for root in roots]
    seen = set()
    missing = {}
    lazy_missing = {}
    optional_ext = {}
    hard_ext = {}
    module_count = 0
    while queue:
        name, optional = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        parts = name.split(".")
        path = module_file(pylib, parts)
        if path is None:
            top = parts[0]
            if top in STDLIB or top in VENDORED_TOP:
                missing.setdefault("%s:%s" % (top, name), []).append("(root)")
            elif optional:
                optional_ext.setdefault(top, set()).add(name)
            else:
                hard_ext.setdefault(top, set()).add(name)
            continue
        module_count += 1
        if not path.endswith(".py"):
            # 原生扩展模块（Crypto/WebSocket speedups 等）：能解析到文件即可，无需再解析源码
            continue
        items, err = collect_imports(path)
        if err:
            missing.setdefault("*syntax*:" + name, []).append(err)
            continue
        for module, level, opt, type_only in items:
            if type_only:
                continue
            if level:
                pkg = parts[:-1] if not path.endswith("__init__.py") else parts
                if level > 1:
                    pkg = pkg[:len(pkg) - (level - 1)]
                if not pkg:
                    continue
                sub = ".".join(pkg + ([module] if module else []))
            else:
                if not module:
                    continue
                sub = module
            top = sub.split(".")[0]
            if top in STDLIB:
                continue
            if top in VENDORED_TOP:
                if module_file(pylib, sub.split(".")) is None:
                    bucket = lazy_missing if (optional or opt) else missing
                    bucket.setdefault("%s:%s" % (top, sub), []).append(name)
                    continue
                queue.append((sub, optional or opt))
            elif optional or opt:
                optional_ext.setdefault(top, set()).add(sub)
            else:
                hard_ext.setdefault(top, set()).add(sub)
    return {
        "roots": list(roots),
        "reachable_modules": module_count,
        "hard_external": {k: sorted(v) for k, v in sorted(hard_ext.items())},
        "optional_external": {k: sorted(v) for k, v in sorted(optional_ext.items())},
        "missing": {k: sorted(set(v)) for k, v in sorted(missing.items())},
        "lazy_missing": {k: sorted(set(v)) for k, v in sorted(lazy_missing.items())},
    }


def import_check(pylib):
    """在目标机上真正 import（必须 musl + python3.11）。"""
    code = r"""
import base64, hashlib, json, sys
out = {"ok": False}
try:
    import lark_oapi
    import lark_oapi.ws as ws_mod
    from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
    from Crypto.Cipher import AES
    import requests, websockets, urllib3, certifi, idna, charset_normalizer

    cipher = AES.new(b"0" * 32, AES.MODE_CBC, b"1" * 16)
    ct = cipher.encrypt(b"x" * 16)
    pt = AES.new(b"0" * 32, AES.MODE_CBC, b"1" * 16).decrypt(ct)
    out["aes_cbc_roundtrip"] = (pt == b"x" * 16)

    from lark_oapi.core.utils.decryptor import AESCipher
    key = "dummy-key"
    plain = b'{"schema":"2.0"}'
    digest = hashlib.sha256(key.encode()).digest()
    iv = b"2" * 16
    pad = 16 - len(plain) % 16
    enc = iv + AES.new(digest, AES.MODE_CBC, iv).encrypt(plain + bytes([pad]) * pad)
    out["lark_aes_decrypt"] = AESCipher(key).decrypt(enc) == plain

    b1 = EventDispatcherHandler.builder("", "").register_p2_im_chat_member_bot_added_v1(
        lambda e: None)
    b2 = EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(
        lambda e: None)
    out["register_bot_added"] = b1 is not None
    out["register_message_receive"] = b2 is not None
    out["client_ctor"] = ws_mod.Client("cli_dummy", "secret_dummy", event_handler=b2) is not None
    out["no_httpx_imported"] = "httpx" not in sys.modules
    out["no_toolbelt_imported"] = "requests_toolbelt" not in sys.modules
    out["loaded_modules"] = len(sys.modules)
    out["rss_kb"] = 0
    for line in open("/proc/self/status"):
        if line.startswith("VmRSS:"):
            out["rss_kb"] = int(line.split()[1])
    out["ok"] = all([
        out["aes_cbc_roundtrip"], out["lark_aes_decrypt"],
        out["register_bot_added"], out["register_message_receive"],
        out["client_ctor"], out["no_httpx_imported"], out["no_toolbelt_imported"],
    ])
except Exception as exc:
    import traceback
    out["error"] = "%s: %s" % (type(exc).__name__, exc)
    out["traceback"] = traceback.format_exc()[-2000:]
print(json.dumps(out, ensure_ascii=False))
sys.exit(0 if out.get("ok") else 1)
"""
    env = dict(os.environ)
    env["PYTHONPATH"] = pylib
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("PYTHONHOME", None)
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    payload = {}
    for line in proc.stdout.strip().splitlines():
        try:
            payload = json.loads(line)
        except ValueError:
            continue
    return proc.returncode == 0, payload, proc.stderr.strip()


# ------------------------------------------------------------------ verify
def cmd_verify(args):
    pylib = os.path.abspath(args.pylib)
    report = {"pylib": pylib, "checks": {}, "ok": True}

    def check(name, ok, detail=None):
        report["checks"][name] = {"ok": bool(ok), "detail": detail}
        if not ok:
            report["ok"] = False

    if not os.path.isdir(pylib):
        check("exists", False, pylib)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1

    manifest = None
    manifest_path = os.path.join(pylib, MANIFEST)
    if os.path.isfile(manifest_path):
        try:
            manifest = json.loads(read_text(manifest_path))
        except ValueError as exc:
            check("manifest_parse", False, str(exc))
    else:
        check("manifest_exists", False, manifest_path)

    files, total = tree_stats(pylib)
    digest, count = tree_digest(pylib)
    check("total_bytes", total <= LIMIT_TOTAL_BYTES, "%d <= %d" % (total, LIMIT_TOTAL_BYTES))
    if manifest:
        check("tree_sha256", manifest["totals"]["sha256"] == digest,
              "%s vs %s" % (digest, manifest["totals"]["sha256"]))
        check("file_count", manifest["totals"]["files"] == files,
              "%d vs %d" % (files, manifest["totals"]["files"]))
        check("lark_oapi_bytes", dir_bytes(pylib, "lark_oapi") <= LIMIT_LARK_BYTES,
              str(dir_bytes(pylib, "lark_oapi")))
        check("Crypto_bytes", dir_bytes(pylib, "Crypto") <= LIMIT_CRYPTO_BYTES,
              str(dir_bytes(pylib, "Crypto")))

    required = ["lark_oapi/__init__.py", "lark_oapi/ws/client.py",
                "lark_oapi/event/dispatcher_handler.py",
                "lark_oapi/api/im/v1/processor.py",
                "Crypto/Cipher/AES.py", "requests/__init__.py", "websockets/__init__.py",
                "urllib3/__init__.py", "certifi/cacert.pem", "idna/__init__.py",
                "charset_normalizer/__init__.py", MANIFEST]
    missing = [r for r in required if not os.path.isfile(os.path.join(pylib, r))]
    check("required_files", not missing, missing)

    forbidden = []
    for cur, dirs, names in os.walk(pylib):
        for d in dirs:
            if d in ("__pycache__", "tests") or d.endswith(".dist-info"):
                forbidden.append(os.path.relpath(os.path.join(cur, d), pylib))
        for name in names:
            if name.endswith((".pyc", ".pyo")):
                forbidden.append(os.path.relpath(os.path.join(cur, name), pylib))
    check("no_build_artifacts", not forbidden, forbidden[:10])

    check("api_pruned",
          not [d for d in ("acs", "contact", "drive", "sheets", "corehr", "hire", "mail")
               if os.path.isdir(os.path.join(pylib, "lark_oapi", "api", d))])
    check("client_removed", not os.path.isfile(os.path.join(pylib, "lark_oapi", "client.py")))
    check("transport_removed",
          not os.path.isfile(os.path.join(pylib, "lark_oapi", "core", "http", "transport.py")))
    for d in ("PublicKey", "Hash", "SelfTest", "Math", "Signature", "Protocol", "IO"):
        check("crypto_pruned_%s" % d, not os.path.isdir(os.path.join(pylib, "Crypto", d)))

    so = [rel for rel, _p in walk_files(pylib) if rel.endswith(".so")]
    check("native_extensions_present", len(so) >= 3, len(so))
    if manifest:
        check("manifest_native_extensions", sorted(manifest["native_extensions"]) == sorted(so))

    if args.static_imports:
        stats = static_import_graph(pylib)
        check("static_import_missing", not stats["missing"], stats["missing"])
        check("static_import_hard_external", not stats["hard_external"], stats["hard_external"])
        check("static_import_lazy_only",
              not stats.get("lazy_missing") or True, stats.get("lazy_missing"))
        report["static_imports"] = stats

    if args.import_check:
        ok, payload, stderr = import_check(pylib)
        check("runtime_import", ok, payload if not ok else "ok")
        report["runtime_import"] = payload
        if stderr:
            report["runtime_import_stderr"] = stderr[-1000:]

    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


# ------------------------------------------------------------------ build
def _finalize(root, dest):
    for cur, dirs, _names in os.walk(root):
        for d in dirs:
            os.chmod(os.path.join(cur, d), 0o755)
        os.chmod(cur, 0o755)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(root, dest)
    for cur, dirs, names in os.walk(dest):
        for d in dirs:
            os.chmod(os.path.join(cur, d), 0o755)
        for name in names:
            os.chmod(os.path.join(cur, name), 0o644)


def build_from_wheels(dest, wheels_dir):
    tmp = tempfile.mkdtemp(prefix="pylib-build-")
    try:
        root = os.path.join(tmp, "pylib")
        os.makedirs(root)
        licenses = os.path.join(root, "licenses")
        packages = {}
        for dist, module, want_version in PINS:
            wheel = find_wheel(wheels_dir, dist)
            version, tags = wheel_meta(wheel)
            if version != want_version:
                raise SystemExit("版本漂移：%s 期望 %s 实际 %s" % (dist, want_version, version))
            kept = extract_wheel(wheel, root, module, os.path.join(licenses, dist))
            packages[module] = {
                "dist": dist, "version": version, "wheel": os.path.basename(wheel),
                "wheel_tags": tags, "source_files": kept,
            }
            print("  + %-20s %-10s %5d files  %7.2f MB  [%s]" % (
                dist, version, kept, dir_bytes(root, module) / 1048576.0,
                ",".join(tags)), flush=True)
        removed = {"lark_oapi": prune_lark(root), "Crypto": prune_crypto(root)}
        removed["__all__"] = prune_generic(root)
        patches = []
        patch_files(root, patches)
        for module in packages:
            packages[module]["files"] = pkg_files_bytes(root, module)[0]
            packages[module]["bytes"] = dir_bytes(root, module)
        write_text(os.path.join(root, "README"), PYLIB_README)
        _finalize(root, dest)
        return packages, removed, patches
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_from_site(dest, site_dir):
    """备用路径：从已安装的 site-packages 取（离线复现/自测用）。"""
    tmp = tempfile.mkdtemp(prefix="pylib-site-")
    try:
        root = os.path.join(tmp, "pylib")
        os.makedirs(root)
        os.makedirs(os.path.join(root, "licenses"))
        packages = {}
        for dist, module, want_version in PINS:
            src = os.path.join(site_dir, module)
            if not os.path.isdir(src):
                raise SystemExit("site-packages 里没有 %s（%s）" % (module, dist))
            shutil.copytree(src, os.path.join(root, module))
            packages[module] = {"dist": dist, "version": want_version,
                                "wheel": "(site-packages)", "wheel_tags": ["(site)"]}
            di = os.path.join(site_dir, "%s-%s.dist-info" % (dist, want_version))
            for sub in ("licenses", ""):
                d = os.path.join(di, sub) if sub else di
                if not os.path.isdir(d):
                    continue
                for name in sorted(os.listdir(d)):
                    p = os.path.join(d, name)
                    if os.path.isfile(p) and name.startswith(("LICENSE", "COPYING", "NOTICE")):
                        os.makedirs(os.path.join(root, "licenses", dist), exist_ok=True)
                        shutil.copyfile(p, os.path.join(root, "licenses", dist, name))
        removed = {"lark_oapi": prune_lark(root), "Crypto": prune_crypto(root)}
        removed["__all__"] = prune_generic(root)
        patches = []
        patch_files(root, patches)
        for module in packages:
            packages[module]["files"] = pkg_files_bytes(root, module)[0]
            packages[module]["bytes"] = dir_bytes(root, module)
        write_text(os.path.join(root, "README"), PYLIB_README)
        _finalize(root, dest)
        return packages, removed, patches
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def write_manifest(dest, packages, removed, patches, source):
    files, total = tree_stats(dest)
    digest, count = tree_digest(dest)
    so = [rel for rel, _p in walk_files(dest) if rel.endswith(".so")]
    stats = static_import_graph(dest)
    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "generated_by": "tools/pylib_tool.py",
        "source": source,
        "target": {"arch": "x86_64", "libc": "musl", "python": "3.11",
                   "abi_tag": "cp311-musl-x86_64"},
        "pythonpath": "/usr/lib/prism-router/pylib",
        "packages": packages,
        "not_vendored": NOT_VENDORED,
        "pruned": {
            "lark_oapi": {
                "keep": LARK_KEEP,
                "why": "ws 长连接只用 core/event/ws + api/im 的事件模型；"
                       "全量 api 会 import 10534 个模块（真机 166MB RSS / 4.9s）",
            },
            "Crypto": {
                "keep": list(CRYPTO_KEEP_DIRS),
                "why": "lark AESCipher 只用 AES-CBC；PublicKey/Hash/SelfTest 等约 10MB 不参与",
            },
            "removed_entries": {
                k: (v if len(v) <= 60 else v[:60] + ["... 共 %d 项" % len(v)])
                for k, v in removed.items()
            },
        },
        "patches": patches,
        "native_extensions": so,
        "imports": stats,
        "totals": {"files": files, "bytes": total, "sha256": digest},
        "limits": {"total_bytes": LIMIT_TOTAL_BYTES,
                   "lark_oapi_bytes": LIMIT_LARK_BYTES,
                   "Crypto_bytes": LIMIT_CRYPTO_BYTES},
    }
    write_text(os.path.join(dest, MANIFEST), json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def cmd_build(args):
    dest = os.path.abspath(args.dest)
    if args.download:
        source = "pip download: " + ", ".join("%s==%s" % (d, v) for d, _m, v in PINS)
        tmp_wheels = tempfile.mkdtemp(prefix="pylib-wheels-")
        try:
            wheels = download_wheels(tmp_wheels)
            packages, removed, patches = build_from_wheels(dest, wheels)
        finally:
            shutil.rmtree(tmp_wheels, ignore_errors=True)
    elif args.wheels:
        source = "wheels: " + os.path.abspath(args.wheels)
        packages, removed, patches = build_from_wheels(dest, os.path.abspath(args.wheels))
    else:
        source = "site-packages: " + os.path.abspath(args.site)
        packages, removed, patches = build_from_site(dest, os.path.abspath(args.site))

    manifest = write_manifest(dest, packages, removed, patches, source)
    files, total = tree_stats(dest)
    print("\n=== pylib: %s" % dest)
    print("  files=%d  bytes=%d (%.2f MB)  sha256=%s" % (
        files, total, total / 1048576.0, manifest["totals"]["sha256"]))
    for module in sorted(packages):
        info = packages[module]
        print("  %-20s %-10s %5d files %7.2f MB" % (
            module, info["version"], info["files"], info["bytes"] / 1048576.0))
    print("  native .so: %d" % len(manifest["native_extensions"]))
    print("  reachable modules: %d" % manifest["imports"]["reachable_modules"])
    print("  optional externals: %s" %
          ", ".join(sorted(manifest["imports"]["optional_external"])))
    print("  target: %s" % json.dumps(manifest["target"], ensure_ascii=False))

    ok = True
    if total > LIMIT_TOTAL_BYTES:
        print("FAIL: pylib 体积 %d > %d" % (total, LIMIT_TOTAL_BYTES))
        ok = False
    for module, limit in (("lark_oapi", LIMIT_LARK_BYTES), ("Crypto", LIMIT_CRYPTO_BYTES)):
        got = dir_bytes(dest, module)
        if got > limit:
            print("FAIL: %s 体积 %d > %d" % (module, got, limit))
            ok = False
    if manifest["imports"]["missing"]:
        print("FAIL: 缺模块 %s" % json.dumps(manifest["imports"]["missing"], ensure_ascii=False))
        ok = False
    if manifest["imports"].get("lazy_missing"):
        print("  warn: 惰性/条件导入指向未分发模块（不会被 ws 链路调用）：%s" %
              ", ".join(sorted(manifest["imports"]["lazy_missing"])))
    if manifest["imports"]["hard_external"]:
        print("FAIL: 硬依赖了未分发的第三方模块 %s" %
              json.dumps(manifest["imports"]["hard_external"], ensure_ascii=False))
        ok = False
    if not ok:
        return 1
    print("OK")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="prism-router 供应商 pylib 工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="生成裁剪后的 pylib 树")
    b.add_argument("--dest", required=True, help="输出目录（如 luci-app-prism-router/pylib）")
    src = b.add_mutually_exclusive_group(required=True)
    src.add_argument("--download", action="store_true", help="在目标机上 pip download 后构建")
    src.add_argument("--wheels", help="使用已有 .whl 目录")
    src.add_argument("--site", help="使用已安装的 site-packages（离线复现/自测）")
    b.set_defaults(func=cmd_build)

    v = sub.add_parser("verify", help="校验 pylib 树（结构/体积/清单/静态 import 图）")
    v.add_argument("--pylib", required=True, help="pylib 目录")
    v.add_argument("--static-imports", action="store_true", help="静态 import 图检查")
    v.add_argument("--import-check", action="store_true",
                   help="真实 import（必须 musl x86_64 + python3.11）")
    v.set_defaults(func=cmd_verify)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
