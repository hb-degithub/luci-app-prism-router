#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""棱镜路由 · 飞书官方 SDK 长连接（lark-oapi WebSocket）

只做一件事：用官方 `lark_oapi.ws.Client` 常驻接收飞书事件，把「机器人被加进
哪些群」「谁在群里说过话（open_id / user_id）」记录成脱敏清单，供 LuCI 设置页
一键填入现有的 chat_id / receive_id 字段。

    /etc/init.d/prism-router-feishu-ws   procd 服务（默认关闭，ws_enabled=1 才启动）
    /etc/prism-router/feishu-ws.json     发现的群/用户（0600，原子写）
    /tmp/prism-router/feishu-ws.status.json  运行状态（tmpfs，供 rpcd 读）
    /tmp/prism-router/feishu-ws.pid      PID（tmpfs）
    /tmp/prism-router/feishu-ws.log      日志（512KB 上限，超了截断保留尾部）

安全约束
--------
* app_secret **从不**出现在命令行/IPC/日志/状态文件里：只通过 `uci -q get` 读进内存，
  日志里只有 `has_secret=true/false`。
* 事件内容不落盘：只记 chat_id / open_id / user_id / 群名（截断 64 字）。
* 状态文件 0600，原子写（同目录临时文件 + os.replace）。
* /etc 只在「发现新群/新用户」或有未落盘变更且距上次 >= 10 分钟时写一次，
  避免每条消息都擦写 flash；实时时间戳写 tmpfs 状态文件。

用法
----
    feishu-ws.py                  # 常驻（procd 调用）
    feishu-ws.py --check          # 只校验配置/依赖，不连网；退出码 0=可启动
    feishu-ws.py --selftest       # 离线自检（导入/注册/状态读写），打印 JSON
    feishu-ws.py --version
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

# 随包 SDK 住在 /usr/lib（overlay flash）：绝不写 .pyc。
# procd 启动时也会带 PYTHONDONTWRITEBYTECODE=1；这里再兜一层，覆盖手工执行
# `feishu-ws.py --selftest` 之类的情况（否则一次 import 会在 pylib 里多出 474 个
# __pycache__ 文件、约 3.7MB flash）。
sys.dont_write_bytecode = True

SERVICE_VERSION = "1.0.0"
DEFAULT_PYLIB = "/usr/lib/prism-router/pylib"
DEFAULT_STATE = "/etc/prism-router/feishu-ws.json"
DEFAULT_STATUS = "/tmp/prism-router/feishu-ws.status.json"
DEFAULT_PID = "/tmp/prism-router/feishu-ws.pid"
DEFAULT_LOG = "/tmp/prism-router/feishu-ws.log"
MAX_LOG_BYTES = 512 * 1024
MAX_CHATS = 50
MAX_USERS = 20
MAX_NAME_CHARS = 64
PERSIST_INTERVAL = 600          # /etc 状态文件最少 10 分钟写一次
STATUS_INTERVAL = 2             # tmpfs 状态文件最多 2 秒写一次
STATUS_STALE_SECONDS = 180      # rpcd 判定「还在跑」的窗口

_BAD_TOKEN = re.compile(
    r"(secret|token|password|passwd|authorization|bearer|access[_-]?token|cookie)",
    re.IGNORECASE,
)


# ---------------------------------------------------------------- 小工具
def _now():
    return int(time.time())


def _s(value, limit=None):
    """把事件字段转成安全字符串：非字符串/None -> ''，去掉控制字符并截断。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    value = "".join(ch for ch in value if ch >= " " and ch != "\x7f")
    if limit is not None and len(value) > limit:
        value = value[:limit]
    return value.strip()


def mask_secret(value):
    """只用于「是否已配置」这类判断的展示，绝不返回原值。"""
    return "***" if _s(value) else ""


def mask_log_line(line):
    """日志脱敏：URL 去掉 query（SDK 会把 access_key/ticket 打进连接串），
    形如 secret=/token:/access_key=/ticket= 的 token 整体打码。"""
    out = []
    for token in str(line).split():
        low = token.lower()
        if low.startswith(("ws://", "wss://", "http://", "https://")) and "?" in token:
            out.append(token.split("?", 1)[0] + "?***")
        elif _BAD_TOKEN.search(token) and ("=" in token or ":" in token):
            out.append("***")
        elif any(word in low for word in ("access_key=", "ticket=", "appsecret=", "sign=")):
            out.append("***")
        else:
            out.append(_s(token, 200))
    return _s(" ".join(out), 400)


# ---------------------------------------------------------------- 日志
class FileLog(object):
    def __init__(self, path, max_bytes=MAX_LOG_BYTES):
        self.path = path
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self._level = 20
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        try:
            self._size = os.path.getsize(path)
        except OSError:
            self._size = 0

    def set_level(self, level):
        self._level = level

    def _truncate(self):
        keep = max(self.max_bytes // 2, 4096)
        try:
            with open(self.path, "rb") as fh:
                fh.seek(-keep, os.SEEK_END)
                tail = fh.read()
        except OSError:
            self._size = 0
            return
        cut = tail.find(b"\n")
        if cut >= 0:
            tail = tail[cut + 1:]
        header = ("[... 超过 %d 字节，仅保留尾部 ...]\n" % self.max_bytes).encode("utf-8")
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
        try:
            os.write(fd, header + tail)
        finally:
            os.close(fd)
        try:
            self._size = os.path.getsize(self.path)
        except OSError:
            self._size = 0

    def write(self, level, message):
        line = "%s %-5s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), level, message)
        if level == "ERROR":
            self._level = max(self._level, 40)
        data = line.encode("utf-8", "replace")
        with self._lock:
            if self._size + len(data) > self.max_bytes:
                self._truncate()
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
                try:
                    os.write(fd, data)
                finally:
                    os.close(fd)
                self._size += len(data)
            except OSError:
                pass
        # 进 logread（procd 捕获 stdout/stderr）；文件里另有完整副本
        try:
            sys.stderr.write(line)
            sys.stderr.flush()
        except (OSError, ValueError):
            pass


# ---------------------------------------------------------------- 原子写
def atomic_write(path, data, mode=0o600):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=parent or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path, payload, mode=0o600):
    atomic_write(path, json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", mode)


# ---------------------------------------------------------------- 配置
def read_uci(option):
    """只读 UCI；不打印、不缓存 secret。"""
    try:
        proc = subprocess.run(
            ["uci", "-q", "get", "prism-router.feishu." + option],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout.decode("utf-8", "replace").strip()


def read_config():
    app_id = os.environ.get("PRISM_FEISHU_APP_ID") or read_uci("app_id")
    app_secret = os.environ.get("PRISM_FEISHU_APP_SECRET") or read_uci("app_secret")
    enabled = os.environ.get("PRISM_FEISHU_WS_ENABLED") or read_uci("ws_enabled")
    return {
        "app_id": _s(app_id),
        "app_secret": _s(app_secret),
        "ws_enabled": 1 if _s(enabled).lower() in ("1", "true", "yes", "on", "enabled") else 0,
    }


def ensure_pylib():
    """强制优先使用随包 SDK。

    路由器上可能还残留旧的手工 `pip install`（完整 lark-oapi 会 import 10534 个模块、
    166MB RSS）。只要随包目录存在，就把它插到 sys.path 最前面，保证服务跑的是
    /usr/lib/prism-router/pylib 这份裁剪过的 SDK；只有随包缺失时才回落到系统路径。
    返回值：实际使用的目录（或 "sys.path" / ""）。
    """
    if os.path.isdir(os.path.join(DEFAULT_PYLIB, "lark_oapi")):
        while DEFAULT_PYLIB in sys.path:
            sys.path.remove(DEFAULT_PYLIB)
        sys.path.insert(0, DEFAULT_PYLIB)
        loaded = sys.modules.get("lark_oapi")
        if loaded is not None:  # 极端情况：被 sitecustomize 之类提前导入
            where = getattr(loaded, "__file__", "") or ""
            if not where.startswith(DEFAULT_PYLIB):
                return "conflict:" + where
        return DEFAULT_PYLIB
    try:
        import lark_oapi  # noqa: F401
        return "sys.path"
    except Exception:
        return ""


# ---------------------------------------------------------------- 状态
class Store(object):
    def __init__(self, state_path, status_path, pid_path, log):
        self.state_path = state_path
        self.status_path = status_path
        self.pid_path = pid_path
        self.log = log
        self.chats = []
        self.users = []
        self.last_event_ts = 0
        self.last_event_type = ""
        self.events_seen = 0
        self.connected = False
        self.last_error = ""
        self.started_at = _now()
        self._dirty = False
        self._new_entity = False
        self._last_persist = 0.0
        self._last_status = 0.0
        self._lock = threading.Lock()
        self.load()

    # -- 读
    def load(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        for item in data.get("chats") or []:
            if isinstance(item, dict) and _s(item.get("chat_id")):
                self.chats.append({
                    "chat_id": _s(item.get("chat_id"), 128),
                    "name": _s(item.get("name"), MAX_NAME_CHARS),
                    "first_seen": int(item.get("first_seen") or 0),
                    "last_seen": int(item.get("last_seen") or 0),
                })
        for item in data.get("users") or []:
            if isinstance(item, dict) and (_s(item.get("open_id")) or _s(item.get("user_id"))):
                self.users.append({
                    "open_id": _s(item.get("open_id"), 128),
                    "user_id": _s(item.get("user_id"), 128),
                    "name": _s(item.get("name"), MAX_NAME_CHARS),
                    "first_seen": int(item.get("first_seen") or 0),
                    "last_seen": int(item.get("last_seen") or 0),
                })
        self.last_event_ts = int(data.get("last_event_ts") or 0)
        self.last_event_type = _s(data.get("last_event_type"), 64)
        self.chats = self.chats[:MAX_CHATS]
        self.users = self.users[:MAX_USERS]

    # -- 写
    def snapshot(self):
        return {
            "version": 1,
            "updated_at": _now(),
            "last_event_ts": self.last_event_ts,
            "last_event_type": self.last_event_type,
            "events_seen": self.events_seen,
            "chats": self.chats[:MAX_CHATS],
            "users": self.users[:MAX_USERS],
        }

    def status_snapshot(self):
        return {
            "version": 1,
            "pid": os.getpid(),
            "service_version": SERVICE_VERSION,
            "started_at": self.started_at,
            "updated_at": _now(),
            "connected": bool(self.connected),
            "last_event_ts": self.last_event_ts,
            "last_event_type": self.last_event_type,
            "events_seen": self.events_seen,
            "chats": len(self.chats),
            "users": len(self.users),
            "last_error": _s(self.last_error, 200),
        }

    def persist(self, force=False):
        with self._lock:
            now = time.time()
            if not force:
                if not self._dirty:
                    return
                if not self._new_entity and now - self._last_persist < PERSIST_INTERVAL:
                    return
            try:
                atomic_write_json(self.state_path, self.snapshot(), 0o600)
            except OSError as exc:
                self.last_error = "state write failed: %s" % exc
                self.log.write("ERROR", self.last_error)
                return
            self._dirty = False
            self._new_entity = False
            self._last_persist = now

    def write_status(self, force=False):
        with self._lock:
            now = time.time()
            if not force and now - self._last_status < STATUS_INTERVAL:
                return
            self._last_status = now
            try:
                atomic_write_json(self.status_path, self.status_snapshot(), 0o644)
            except OSError as exc:
                self.log.write("WARN", "status write failed: %s" % exc)

    def write_pid(self):
        try:
            atomic_write(self.pid_path, "%d\n" % os.getpid(), 0o644)
        except OSError as exc:
            self.log.write("WARN", "pid write failed: %s" % exc)

    def remove_pid(self):
        try:
            os.unlink(self.pid_path)
        except OSError:
            pass

    # -- 事件记账
    def set_connected(self, connected):
        if bool(connected) == self.connected:
            return
        self.connected = bool(connected)
        self.log.write("INFO", "长连接%s" % ("已建立" if self.connected else "已断开"))
        self.write_status(force=True)

    def mark_event(self, event_type):
        self.last_event_ts = _now()
        self.last_event_type = _s(event_type, 64)
        self.events_seen += 1
        self._dirty = True
        self.write_status(force=True)

    def mark_chat(self, chat_id, name=""):
        chat_id = _s(chat_id, 128)
        if not chat_id:
            return
        now = _now()
        name = _s(name, MAX_NAME_CHARS)
        for item in self.chats:
            if item["chat_id"] == chat_id:
                if name and not item["name"]:
                    item["name"] = name
                    self._dirty = True
                item["last_seen"] = now
                return
        self.chats.insert(0, {"chat_id": chat_id, "name": name,
                              "first_seen": now, "last_seen": now})
        if len(self.chats) > MAX_CHATS:
            self.chats = self.chats[:MAX_CHATS]
        self._dirty = True
        self._new_entity = True
        self.log.write("INFO", "发现群 chat_id=%s name=%s" % (chat_id, name or "-"))

    def mark_user(self, open_id, user_id="", name=""):
        open_id = _s(open_id, 128)
        user_id = _s(user_id, 128)
        if not open_id and not user_id:
            return
        now = _now()
        name = _s(name, MAX_NAME_CHARS)
        for item in self.users:
            if (open_id and item["open_id"] == open_id) or \
               (not open_id and user_id and item["user_id"] == user_id):
                if not item["open_id"] and open_id:
                    item["open_id"] = open_id
                if not item["user_id"] and user_id:
                    item["user_id"] = user_id
                if name and not item["name"]:
                    item["name"] = name
                item["last_seen"] = now
                return
        self.users.insert(0, {"open_id": open_id, "user_id": user_id, "name": name,
                              "first_seen": now, "last_seen": now})
        if len(self.users) > MAX_USERS:
            self.users = self.users[:MAX_USERS]
        self._dirty = True
        self._new_entity = True
        self.log.write("INFO", "发现用户 open_id=%s user_id=%s" % (open_id or "-", user_id or "-"))


# ---------------------------------------------------------------- 事件处理
def build_event_handler(store, log):
    from lark_oapi.event.dispatcher_handler import EventDispatcherHandler

    def on_bot_added(event):
        try:
            data = getattr(event, "event", None)
            chat_id = _s(getattr(data, "chat_id", ""), 128)
            name = _s(getattr(data, "name", ""), MAX_NAME_CHARS)
            if not name:
                i18n = getattr(data, "i18n_names", None)
                name = _s(getattr(i18n, "zh_cn", ""), MAX_NAME_CHARS) if i18n else ""
            store.mark_chat(chat_id, name)
            store.mark_event("im.chat.member.bot.added_v1")
            store.persist()
        except Exception as exc:  # 处理器抛异常会让 ws 客户端断开，必须兜住
            store.last_error = "bot_added handler: %s" % exc
            log.write("ERROR", store.last_error)

    def on_message(event):
        try:
            data = getattr(event, "event", None)
            message = getattr(data, "message", None)
            sender = getattr(data, "sender", None)
            sender_id = getattr(sender, "sender_id", None)
            chat_id = _s(getattr(message, "chat_id", ""), 128)
            open_id = _s(getattr(sender_id, "open_id", ""), 128)
            user_id = _s(getattr(sender_id, "user_id", ""), 128)
            sender_type = _s(getattr(sender, "sender_type", ""), 32).lower()
            store.mark_chat(chat_id)
            if sender_type not in ("app", "bot"):
                store.mark_user(open_id, user_id)
            store.mark_event("im.message.receive_v1")
            store.persist()
        except Exception as exc:
            store.last_error = "message handler: %s" % exc
            log.write("ERROR", store.last_error)

    handler = (EventDispatcherHandler.builder("", "")
               .register_p2_im_chat_member_bot_added_v1(on_bot_added)
               .register_p2_im_message_receive_v1(on_message))
    return handler


# ---------------------------------------------------------------- 运行
def install_signals(ws_mod, store, log, stop_evt):
    def _handler(signum, _frame):
        log.write("INFO", "收到信号 %d，准备干净退出" % signum)
        stop_evt.set()
        loop = getattr(ws_mod, "loop", None)
        if loop is not None:
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:
                pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (OSError, ValueError):
            pass


def start_watchdog(client, store, stop_evt):
    def _run():
        # 首轮 2 秒（尽快把 connected=true 反映出来），之后 15 秒心跳。
        interval = 2
        while not stop_evt.wait(interval):
            interval = 15
            try:
                conn = getattr(client, "_conn", None)
                store.set_connected(conn is not None)
                store.persist()
                store.write_status(force=True)
            except Exception as exc:
                store.last_error = "watchdog: %s" % exc
                store.log.write("WARN", store.last_error)

    thread = threading.Thread(target=_run, name="feishu-ws-watchdog", daemon=True)
    thread.start()
    return thread


def run(args, log):
    config = read_config()
    if not config["ws_enabled"]:
        log.write("WARN", "ws_enabled=0，不启动（uci set prism-router.feishu.ws_enabled=1）")
        return 3
    if not config["app_id"] or not config["app_secret"]:
        log.write("ERROR", "缺少 feishu.app_id / feishu.app_secret，拒绝启动")
        return 2

    where = ensure_pylib()
    if not where:
        log.write("ERROR", "找不到 lark_oapi（期望 %s），请重装 prism-router" % DEFAULT_PYLIB)
        return 2
    if where.startswith("conflict:"):
        log.write("ERROR", "lark_oapi 已被其它路径抢先导入（%s），拒绝混用随包 SDK" %
                  where[len("conflict:"):])
        return 2

    from lark_oapi.core.enum import LogLevel
    import lark_oapi.ws.client as ws_mod

    store = Store(args.state, args.status, args.pid_file, log)
    store.started_at = _now()
    store.log.write("INFO", "启动长连接（pid=%d，sdk=%s，state=%s）" % (
        os.getpid(), where, args.state))
    store.write_pid()
    store.write_status(force=True)

    stop_evt = threading.Event()

    # 接管 SDK 的连接日志：写进同一份日志文件，且经过 mask_log_line 脱敏
    # （SDK 默认把 wss URL 连 access_key/ticket 一起打到 stdout；这里把默认
    #  handler 降级为 WARNING，并用自定义 handler 输出脱敏后的 INFO）。
    lark_logger = None
    fh = None
    try:
        import logging as _logging
        from lark_oapi.core.log import logger as lark_logger

        class _MaskedHandler(_logging.Handler):
            def emit(self, record):
                try:
                    msg = record.getMessage()
                except Exception:
                    msg = str(record.msg)
                log.write(record.levelname, mask_log_line(msg))

        for existing in list(lark_logger.handlers):
            existing.setLevel(int(LogLevel.WARNING.value))
        fh = _MaskedHandler()
        fh.setLevel(int(LogLevel.INFO.value))
        lark_logger.addHandler(fh)
        lark_logger.setLevel(int(LogLevel.INFO.value))
    except Exception:
        fh = None

    code = 0
    try:
        # 事件处理器 / Client 构造也放进 try：凭据非法等异常同样要写日志并清 pid，
        # 否则 procd 重启时会在 /tmp 留下指向死进程的 pid 文件。
        handler = build_event_handler(store, log)
        client = ws_mod.Client(config["app_id"], config["app_secret"],
                               event_handler=handler, log_level=LogLevel.INFO)
        install_signals(ws_mod, store, log, stop_evt)
        start_watchdog(client, store, stop_evt)
        client.start()
    except (SystemExit, KeyboardInterrupt):
        code = 0
    except RuntimeError as exc:
        if stop_evt.is_set():
            log.write("INFO", "事件循环已按信号停止")
        else:
            store.last_error = "runtime: %s" % exc
            log.write("ERROR", store.last_error)
            code = 1
    except Exception as exc:
        store.last_error = "%s: %s" % (type(exc).__name__, exc)
        log.write("ERROR", "长连接退出：%s" % store.last_error)
        code = 1
    finally:
        stop_evt.set()
        store.set_connected(False)
        store.persist(force=True)
        store.write_status(force=True)
        store.remove_pid()
        log.write("INFO", "已退出（code=%d，events=%d）" % (code, store.events_seen))
        if fh is not None:
            try:
                lark_logger.removeHandler(fh)
                fh.close()
            except Exception:
                pass
    return code


# ---------------------------------------------------------------- 自检
def selftest(args):
    where = ensure_pylib()
    result = {
        "ok": False,
        "service_version": SERVICE_VERSION,
        "python": sys.version.split()[0],
        "pylib": where or None,
        "lark_oapi": False,
        "handlers": [],
        "client_ctor": False,
        "state_write": False,
        "state_mode": None,
        "log_write": False,
        "status_write": False,
        "error": "",
    }
    tmp = tempfile.mkdtemp(prefix="feishu-ws-selftest-")
    try:
        log = FileLog(os.path.join(tmp, "feishu-ws.log"))
        if not where:
            result["error"] = "lark_oapi 不可导入"
            print(json.dumps(result, ensure_ascii=False))
            return 1
        if where.startswith("conflict:"):
            result["error"] = "lark_oapi 已被其它路径抢先导入：%s" % where[len("conflict:"):]
            print(json.dumps(result, ensure_ascii=False))
            return 1

        import lark_oapi
        from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
        import lark_oapi.ws.client as ws_mod

        result["lark_oapi"] = True
        result["lark_version"] = getattr(lark_oapi, "__version__", "")
        result["module_file"] = getattr(lark_oapi, "__file__", "")

        store = Store(os.path.join(tmp, "feishu-ws.json"),
                      os.path.join(tmp, "status.json"),
                      os.path.join(tmp, "pid"), log)
        handler = build_event_handler(store, log)
        store.mark_chat("oc_selftest", "自检群")
        store.mark_user("ou_selftest", "u_selftest")
        store.mark_event("im.message.receive_v1")
        store.persist(force=True)
        store.write_status(force=True)
        result["handlers"] = sorted(handler._processorMap.keys())
        result["state_write"] = os.path.isfile(store.state_path)
        if result["state_write"]:
            result["state_mode"] = oct(os.stat(store.state_path).st_mode & 0o777)
            with open(store.state_path, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            result["chats"] = len(saved.get("chats") or [])
            result["users"] = len(saved.get("users") or [])
        result["status_write"] = os.path.isfile(store.status_path)
        result["log_write"] = os.path.isfile(log.path) and os.path.getsize(log.path) > 0

        client = ws_mod.Client("cli_selftest", "secret_selftest", event_handler=handler)
        result["client_ctor"] = client is not None
        result["ok"] = all([
            result["lark_oapi"], result["client_ctor"], result["state_write"],
            result["state_mode"] == "0o600", result["status_write"],
            result["log_write"], len(result["handlers"]) >= 2,
        ])
        store.remove_pid()
    except Exception as exc:
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
    finally:
        for name in os.listdir(tmp):
            try:
                os.unlink(os.path.join(tmp, name))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


def check_config(args):
    config = read_config()
    where = ensure_pylib()
    result = {
        "ok": bool(config["ws_enabled"] and config["app_id"] and config["app_secret"] and where),
        "service_version": SERVICE_VERSION,
        "ws_enabled": bool(config["ws_enabled"]),
        "has_app_id": bool(config["app_id"]),
        "has_app_secret": bool(mask_secret(config["app_secret"])),
        "pylib": where or None,
        "python": sys.version.split()[0],
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


# ---------------------------------------------------------------- 入口
def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="棱镜路由 · 飞书长连接（官方 lark-oapi WebSocket）",
        add_help=True,
    )
    ap.add_argument("--state", default=os.environ.get("PRISM_FEISHU_WS_STATE", DEFAULT_STATE))
    ap.add_argument("--status", default=os.environ.get("PRISM_FEISHU_WS_STATUS", DEFAULT_STATUS))
    ap.add_argument("--pid-file", default=os.environ.get("PRISM_FEISHU_WS_PID", DEFAULT_PID))
    ap.add_argument("--log", default=os.environ.get("PRISM_FEISHU_WS_LOG", DEFAULT_LOG))
    ap.add_argument("--check", action="store_true", help="只校验配置与依赖，不连网")
    ap.add_argument("--selftest", action="store_true", help="离线自检（不连网）")
    ap.add_argument("--version", action="store_true")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.version:
        print("prism-router-feishu-ws %s" % SERVICE_VERSION)
        return 0
    if args.selftest:
        return selftest(args)
    log = FileLog(args.log)
    if args.check:
        return check_config(args)
    return run(args, log)


if __name__ == "__main__":
    sys.exit(main())
