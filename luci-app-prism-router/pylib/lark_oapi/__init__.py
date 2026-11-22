# ---------------------------------------------------------------------------
# 本文件由 prism-router 的 tools/pylib_tool.py 替换，不是 lark-oapi 原文件。
# 只保留 WebSocket 长连接子集需要的顶层再导出；api/client/card/scene 未随包分发。
# 完整补丁清单（含上游 sha256）见同目录 MANIFEST.json；说明见 docs/FEISHU-WS.md。
# ---------------------------------------------------------------------------
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
