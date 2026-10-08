"""Talking to ``codex app-server``: line-delimited JSON-RPC over stdio, in
both directions. Method names and frame shapes were read off codex-cli
0.145.0 (see the module doc of the former ``apps/daemon/src/adapter/codex.rs``):

- spawn ``codex app-server -c approval_policy="never" -c
  sandbox_mode="danger-full-access"``; ``initialize`` request, then an
  ``initialized`` notification. ``clientInfo.name`` is the reserved,
  non-originating ``codex_app_server_daemon`` so a person's usage stays
  attributed to Codex.
- ``thread/start`` / ``thread/resume`` / ``thread/fork`` carry their own
  ``approvalPolicy`` + ``sandbox``; every ``turn/start`` carries
  ``approvalPolicy``, ``sandboxPolicy``, ``model`` and ``effort``.
- ``model/list`` and ``initialize`` answer without credentials, which is why
  the catalog cannot double as a login check.
"""

from __future__ import annotations

import asyncio
import collections
import json
import os
import subprocess
from typing import Any, Callable, Dict, List, Optional

from genehub_agent import process

CLIENT_NAME = "codex_app_server_daemon"
CLIENT_TITLE = "GeneHub"
APPROVAL_CONFIG = 'approval_policy="never"'
SANDBOX_CONFIG = 'sandbox_mode="danger-full-access"'

# How long a request may go unanswered. Generous: a cold start on Windows is slow.
CALL_TIMEOUT = 90.0
# The one-off handshake that reads the model table.
HANDSHAKE_TIMEOUT = 30.0

# Phrases on app-server stderr that mean the token it holds is no longer good.
AUTH_FAILURE_MARKERS = ("token_revoked", "401 Unauthorized")


def app_server_args() -> List[str]:
    return ["app-server", "-c", APPROVAL_CONFIG, "-c", SANDBOX_CONFIG,
            "-c", "features.default_mode_request_user_input=true"]


def client_info() -> dict:
    return {"name": CLIENT_NAME, "title": CLIENT_TITLE, "version": os.environ.get("GENEHUB_VERSION", "script-1")}


# ---------------------------------------------------------------------------
# Modes: an approval policy and a sandbox together, as presets a person reads.

MODES = [
    {
        "id": "read-only",
        "label": "Read only",
        "description": "Read and plan only — asks before editing or running anything",
        "approval": "on-request",
        "sandbox": "read-only",
        "network": False,
    },
    {
        "id": "auto",
        "label": "Default",
        "description": "Edit files and run commands inside the workspace, asking before going beyond it",
        "approval": "on-request",
        "sandbox": "workspace-write",
        "network": False,
    },
    {
        "id": "full-access",
        "label": "Full access",
        "description": "Never ask, and allow network access. Only for a workspace you could afford to lose",
        "approval": "never",
        "sandbox": "danger-full-access",
        "network": True,
    },
]

# GeneHub is built for unattended work: a fresh session starts with the
# highest native authority. Explicit lower modes stay intact.
DEFAULT_MODE = "full-access"


def mode_named(mode_id: Optional[str]) -> dict:
    for mode in MODES:
        if mode["id"] == mode_id:
            return mode
    # The default, not the first entry: an unknown name must not silently
    # become "read only".
    return next(mode for mode in MODES if mode["id"] == DEFAULT_MODE)


def sandbox_policy(mode: dict) -> dict:
    """``turn/start`` wants an object; ``thread/start`` takes a string."""
    if mode["sandbox"] == "read-only":
        return {"type": "readOnly"}
    if mode["sandbox"] == "danger-full-access":
        return {"type": "dangerFullAccess"}
    return {"type": "workspaceWrite", "networkAccess": mode["network"]}


def with_thread_policy(params: dict, mode: dict) -> dict:
    params["approvalPolicy"] = mode["approval"]
    params["sandbox"] = mode["sandbox"]
    return params


def with_developer_instructions(params: dict, prompt: Optional[str]) -> dict:
    interaction = (
        "GeneHub supports native conversation questions with text input and options through request_user_input, "
        "including Default mode when the CLI exposes this tool. When the user asks for an input box or choices "
        "in this conversation, use that native tool and its schema. GeneHub persists the question and stops this execution; "
        "the Human answer starts a fresh execution in the same conversation. Do not wait, poll, or generate an HTML page "
        "as a substitute for a conversation question. HTML preview is for explicitly requested page artifacts. "
        "Never ask for API keys, login codes or credential-bearing links through a conversation tool; "
        "Agent settings handle those separately. If the native tool is not callable in the current mode, "
        "use the bound platform CLI instead: \"$GENEHUB_CLI\" session ask \"$GENEHUB_SESSION_ID\" "
        "--request-id <stable-id> --question <prompt> --choice <label> --choice <label>. "
        "Free text is enabled by default. Invoke it now when asked for conversation input; "
        "a text explanation or example command alone does not open a question. "
        "If neither entry is available, explain the actual limitation."
    )
    params["developerInstructions"] = (prompt + "\n\n" if prompt and prompt.strip() else "") + interaction
    return params


def catalog_modes() -> List[dict]:
    return [{"id": m["id"], "label": m["label"], "description": m["description"]} for m in MODES]


# ---------------------------------------------------------------------------
# model/list


def efforts_in(model: dict) -> List[str]:
    levels = model.get("supportedReasoningEfforts")
    found: List[str] = []
    for level in levels if isinstance(levels, list) else []:
        if isinstance(level, dict) and isinstance(level.get("reasoningEffort"), str):
            found.append(level["reasoningEffort"])
        elif isinstance(level, str):
            found.append(level)
    return found


def models_in(listed: Any) -> List[dict]:
    data = listed.get("data") if isinstance(listed, dict) else None
    models = []
    for model in data if isinstance(data, list) else []:
        if not isinstance(model, dict) or model.get("hidden") is True:
            continue
        model_id = model.get("id")
        if not isinstance(model_id, str):
            continue
        efforts = efforts_in(model)
        label = model.get("displayName") if isinstance(model.get("displayName"), str) else model_id
        models.append(
            {"id": model_id, "label": label, "reasoning": bool(efforts), "efforts": efforts, "supportsFast": False}
        )
    return models


def default_model_in(listed: Any) -> Optional[tuple]:
    data = listed.get("data") if isinstance(listed, dict) else None
    if not isinstance(data, list) or not data:
        return None
    chosen = next((m for m in data if isinstance(m, dict) and m.get("isDefault") is True), data[0])
    if not isinstance(chosen, dict) or not isinstance(chosen.get("id"), str):
        return None
    effort = chosen.get("defaultReasoningEffort")
    return chosen["id"], effort if isinstance(effort, str) else None


def hello_from(listed: Any) -> dict:
    default = default_model_in(listed)
    return {
        "models": models_in(listed),
        "defaultModel": default[0] if default else None,
        "defaultEffort": default[1] if default else None,
    }


# ---------------------------------------------------------------------------
# The connection


class RpcError(RuntimeError):
    pass


class AppServer:
    """One ``codex app-server`` child and the JSON-RPC client around it.

    Callbacks run on the event loop and must not block:
    ``on_notification(method, params)``, ``on_request(id, method, params)``,
    ``on_exit(server)``, ``on_auth_failure()``.
    """

    def __init__(
        self,
        program: str,
        cwd: str,
        env: Dict[str, str],
        log: Callable[[str], None],
        on_notification: Optional[Callable[[str, Any], None]] = None,
        on_request: Optional[Callable[[Any, str, Any], None]] = None,
        on_exit: Optional[Callable[["AppServer"], None]] = None,
        on_auth_failure: Optional[Callable[[], None]] = None,
        log_stderr: bool = True,
    ) -> None:
        self.program = program
        self.cwd = cwd
        self.env = env
        self.log = log
        self.on_notification = on_notification
        self.on_request = on_request
        self.on_exit = on_exit
        self.on_auth_failure = on_auth_failure
        self.log_stderr = log_stderr
        self.process: Optional[asyncio.subprocess.Process] = None
        self.stderr_tail: collections.deque = collections.deque(maxlen=20)
        self._pending: Dict[int, asyncio.Future] = {}
        # Run inside the read loop, before any later frame is dispatched.
        self._on_result: Dict[int, Callable[[Any], None]] = {}
        self._next_id = 1
        self._write_lock = asyncio.Lock()
        self._tasks: List[asyncio.Task] = []
        self._closed = False
        self._stderr_done = asyncio.Event()

    @property
    def pid(self) -> Optional[int]:
        return self.process.pid if self.process is not None else None

    @property
    def alive(self) -> bool:
        return self.process is not None and self.process.returncode is None and not self._closed

    async def start(self) -> None:
        self.process = await process.spawn(
            [self.program] + app_server_args(),
            cwd=self.cwd,
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._tasks.append(asyncio.ensure_future(self._read_stdout()))
        self._tasks.append(asyncio.ensure_future(self._read_stderr()))

    async def handshake(self) -> Any:
        result = await self.call("initialize", {
            "clientInfo": client_info(), "capabilities": {"experimentalApi": True},
        }, timeout=HANDSHAKE_TIMEOUT)
        await self.notify("initialized", {})
        return result

    # -- writing ------------------------------------------------------------

    async def send(self, frame: dict) -> None:
        if self.process is None or self.process.stdin is None:
            raise RpcError("Codex is not running")
        data = (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self._write_lock:
            try:
                self.process.stdin.write(data)
                await self.process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, OSError) as error:
                raise RpcError(f"Codex closed the connection ({error})")

    async def notify(self, method: str, params: Any) -> None:
        await self.send({"jsonrpc": "2.0", "method": method, "params": params})

    async def call(
        self,
        method: str,
        params: Any,
        timeout: float = CALL_TIMEOUT,
        on_result: Optional[Callable[[Any], None]] = None,
    ) -> Any:
        """``on_result`` sees a successful result synchronously in the read
        loop, before the notifications that follow it — e.g. to bind the turn
        that ``turn/start`` named before its ``turn/completed`` is read."""
        request_id = self._next_id
        self._next_id += 1
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        if on_result is not None:
            self._on_result[request_id] = on_result
        try:
            await self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise RpcError(f"Codex did not answer {method}")
        except RpcError as error:
            raise RpcError(f"{method} failed: {error}")
        finally:
            self._pending.pop(request_id, None)
            self._on_result.pop(request_id, None)

    # -- reading ------------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        stdout = self.process.stdout
        while True:
            try:
                raw = await stdout.readline()
            except (ValueError, asyncio.LimitOverrunError):
                self.log("codex: a frame exceeded the read limit and was dropped")
                continue
            if not raw:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except ValueError:
                self.log("codex: undecodable frame")
                continue
            if isinstance(frame, dict):
                self._dispatch(frame)
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(RpcError("Codex closed the connection"))
        self._pending.clear()
        try:
            await asyncio.wait_for(self._stderr_done.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass
        if self.on_exit is not None and not self._closed:
            try:
                await asyncio.wait_for(self.process.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            self.on_exit(self)

    def _dispatch(self, frame: dict) -> None:
        method = frame.get("method")
        has_id = "id" in frame and frame.get("id") is not None
        if has_id and not isinstance(method, str):
            request_id = frame.get("id")
            future = self._pending.get(request_id) if isinstance(request_id, int) else None
            if future is None or future.done():
                return
            error = frame.get("error")
            if error is not None:
                message = error.get("message") if isinstance(error, dict) else None
                future.set_exception(RpcError(message if isinstance(message, str) else "unknown error"))
            else:
                callback = self._on_result.pop(request_id, None)
                if callback is not None:
                    try:
                        callback(frame.get("result"))
                    except Exception as error:  # noqa: BLE001
                        self.log(f"codex: result handler failed: {error!r}")
                future.set_result(frame.get("result"))
            return
        if not isinstance(method, str):
            return
        try:
            if has_id:
                if self.on_request is not None:
                    self.on_request(frame.get("id"), method, frame.get("params"))
                else:
                    asyncio.ensure_future(
                        self._safe_send(
                            {"jsonrpc": "2.0", "id": frame.get("id"), "error": {"code": -32601, "message": "not supported"}}
                        )
                    )
            elif self.on_notification is not None:
                self.on_notification(method, frame.get("params"))
        except Exception as error:  # noqa: BLE001 - one bad frame must not end the read loop
            self.log(f"codex: failed to handle {method}: {error!r}")

    async def _safe_send(self, frame: dict) -> None:
        try:
            await self.send(frame)
        except RpcError as error:
            self.log(f"could not answer codex: {error}")

    async def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        stderr = self.process.stderr
        try:
            while True:
                try:
                    raw = await stderr.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    continue
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                self.stderr_tail.append(line)
                if self.log_stderr:
                    self.log(f"codex: {line}")
                if self.on_auth_failure is not None and any(marker in line for marker in AUTH_FAILURE_MARKERS):
                    self.on_auth_failure()
        finally:
            self._stderr_done.set()

    def tail(self) -> str:
        """Formatted to end a sentence; empty when nothing was said."""
        return (": " + " / ".join(self.stderr_tail)) if self.stderr_tail else ""

    def describe_exit(self, label: str = "Codex") -> str:
        code = self.process.returncode if self.process is not None else None
        message = f"{label} 退出了（退出码 {code}）" if code is not None else f"{label} 意外退出了"
        tail = self.tail()
        message += tail
        if not tail:
            message += "，而且它什么都没说。日志里有它这一趟的全部输出。"
        return message

    async def close(self) -> None:
        self._closed = True
        if self.process is not None:
            if self.process.stdin is not None:
                try:
                    self.process.stdin.close()
                except (OSError, RuntimeError):
                    pass
            await process.kill_tree(self.process)
        for task in self._tasks:
            task.cancel()
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(RpcError("Codex closed the connection"))
        self._pending.clear()


# ---------------------------------------------------------------------------
# One-shot queries against a throwaway process


async def one_shot(
    program: str,
    cwd: str,
    env: Dict[str, str],
    method: str,
    params: Any,
    log: Callable[[str], None],
    timeout: float,
) -> Any:
    """``initialize`` + one request against a process of its own, so neither
    the picker nor the import dialog can interfere with a live session's
    notification stream. Bounded by ``timeout`` overall."""
    server = AppServer(program, cwd, env, log, log_stderr=False)

    async def ask() -> Any:
        await server.start()
        await server.handshake()
        return await server.call(method, params, timeout=timeout)

    try:
        return await asyncio.wait_for(ask(), timeout=timeout)
    except asyncio.TimeoutError:
        raise RpcError(f"codex timed out while handling {method}")
    finally:
        await server.close()


async def discover(program: str, cwd: str, env: Dict[str, str], log: Callable[[str], None]) -> Optional[dict]:
    """The model table, from a throwaway handshake. ``None`` on any failure,
    so a later refresh gets another try."""
    try:
        listed = await one_shot(program, cwd, env, "model/list", {}, log, HANDSHAKE_TIMEOUT)
    except Exception as error:  # noqa: BLE001
        log(f"could not ask codex what it supports: {error}")
        return None
    return hello_from(listed)
