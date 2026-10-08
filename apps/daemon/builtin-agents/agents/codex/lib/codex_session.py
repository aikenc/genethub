"""One GeneHub conversation on one ``codex app-server`` process.

The process is replaced, and the thread resumed with ``thread/resume``, at
the next turn boundary when:

- the agent noticed the auth file change (a new login, a refreshed token),
- app-server's stderr said ``token_revoked`` / ``401 Unauthorized``,
- the process died between turns.

A long-running app-server keeps the token it started with; this is what
keeps a session usable after the person logs in again.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import os
import uuid
from typing import Any, List, Optional

from genehub_agent import Session, SessionContext, events

from codex_appserver import (
    DEFAULT_MODE,
    MODES,
    AppServer,
    RpcError,
    mode_named,
    sandbox_policy,
    with_developer_instructions,
    with_thread_policy,
)
from codex_translate import AskBook, Translator, is_interactive_request, notification_turn_id


def resume_thread_id(resume: Any) -> Optional[str]:
    """``{"threadId": ...}``; a pre-migration ``PersistHandle``
    (``{"agentId": "codex", "value": {...}}``) is accepted too."""
    if isinstance(resume, dict) and isinstance(resume.get("value"), dict) and "threadId" not in resume:
        if resume.get("agentId") not in (None, "codex"):
            return None
        resume = resume["value"]
    if isinstance(resume, dict):
        thread_id = resume.get("threadId")
        if isinstance(thread_id, str) and thread_id:
            return thread_id
    return None


def archived_thread(message: str, thread_id: str) -> bool:
    return "archived" in message.lower() and thread_id in message


def active_turn_named_in(message: str) -> Optional[str]:
    """``expected active turn id <old> but found <new>`` -> ``<new>``."""
    if "but found " not in message:
        return None
    found = message.split("but found ", 1)[1]
    for separator in (",", ".", '"'):
        found = found.replace(separator, " ")
    parts = found.split()
    return parts[0] if parts else None


def _extension_for(mime: str) -> str:
    return {"image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp"}.get(mime, "png")


def turn_input(text: str, attachments: List[dict], scratch_dir: str) -> List[dict]:
    """Text plus pasted images, which this CLI only accepts as paths on disk."""
    blocks: List[dict] = []
    if text:
        blocks.append({"type": "text", "text": text})
    images = [
        a
        for a in attachments or []
        if isinstance(a, dict) and str(a.get("mime") or "").startswith("image/") and (a.get("dataBase64") or a.get("path"))
    ]
    for index, attachment in enumerate(images):
        data = attachment.get("dataBase64")
        if not data:
            blocks.append({"type": "localImage", "path": attachment["path"]})
            continue
        directory = os.path.join(scratch_dir or os.getcwd(), "attachments")
        os.makedirs(directory, exist_ok=True)
        try:
            raw = base64.b64decode("".join(str(data).split()), validate=True)
        except (binascii.Error, ValueError) as error:
            raise RuntimeError(f"decoding a pasted image: {error}")
        path = os.path.join(directory, f"{uuid.uuid4().hex}-{index}.{_extension_for(attachment.get('mime', ''))}")
        with open(path, "wb") as handle:
            handle.write(raw)
        blocks.append({"type": "localImage", "path": path})
    if not blocks:
        blocks.append({"type": "text", "text": ""})
    return blocks


class CodexSession(Session):
    def __init__(self, ctx: SessionContext, runtime: Any) -> None:
        super().__init__(ctx)
        self.runtime = runtime
        config = ctx.config
        # The kernel hands stored selections over unchecked; anything the
        # current catalog no longer lists falls back to its default, and the
        # fallback is announced so the kernel's session meta follows.
        self._fallbacks: List[dict] = []
        self.mode = config.mode_id if any(m["id"] == config.mode_id for m in MODES) else DEFAULT_MODE
        if config.mode_id and self.mode != config.mode_id:
            self._fallbacks.append(events.mode_changed(self.mode))
        self.model = self._known_model(config.model_id)
        if config.model_id and self.model != config.model_id and self.model:
            self._fallbacks.append(events.model_changed(self.model))
        self.effort = self._known_effort(config.effort_id)
        if config.effort_id and self.effort != config.effort_id and self.effort:
            self._fallbacks.append(events.effort_changed(self.effort))
        self.thread_id: Optional[str] = resume_thread_id(config.resume)
        self.translator = Translator(ctx.emit, self.log)
        self.asks = AskBook(self.log)
        self.server: Optional[AppServer] = None
        self.stale_reason: Optional[str] = None
        self._dead = False
        self._closed = False
        self._lock = asyncio.Lock()
        self._turn_task: Optional[asyncio.Task] = None
        self._pending_turn: Optional[str] = None
        self._early_interrupt = False

    def log(self, message: str) -> None:
        self.ctx.agent.log(f"[codex {self.ctx.session_id}] {message}")

    # -- catalog checks (against the current catalog, not a snapshot) ---------

    def _hello(self) -> dict:
        return self.runtime.hello or {}

    @property
    def models(self) -> List[str]:
        return [m["id"] for m in self._hello().get("models") or []]

    @property
    def efforts(self) -> List[str]:
        levels: List[str] = []
        for model in self._hello().get("models") or []:
            for level in model.get("efforts") or []:
                if level not in levels:
                    levels.append(level)
        return levels

    def _known_model(self, model_id: Optional[str]) -> Optional[str]:
        """``model_id`` when listed (or when there is no catalog to check
        against), otherwise the catalog default."""
        models = self.models
        if model_id and (not models or model_id in models):
            return model_id
        return self._hello().get("defaultModel")

    def _known_effort(self, effort_id: Optional[str]) -> Optional[str]:
        # No catalog at all: nothing to check against. A catalog whose models
        # list no levels does not list this one either.
        if effort_id and (not self.models or effort_id in self.efforts):
            return effort_id
        return self._hello().get("defaultEffort")

    # -- process lifecycle ----------------------------------------------------

    async def start(self) -> None:
        async with self._lock:
            await self._open()
        for event in self._fallbacks:
            self.ctx.emit(event)
        self._fallbacks = []

    async def _open(self) -> None:
        # Upstream JSON-RPC ids start at zero again in every new process.
        # Timeline obligations must never reuse those ids across executions.
        self.asks = AskBook(self.log, id_prefix="codex-" + uuid.uuid4().hex + "-")
        program = self.runtime.program_path()
        if not program:
            raise RuntimeError("未安装 Codex CLI")
        config = self.ctx.config
        if not os.path.isdir(config.cwd):
            raise RuntimeError(f"工作目录不存在：{config.cwd}")
        env = self.runtime.env(config.session_environment(), remove=("GENEHUB_CLI",), program=program)
        server = AppServer(
            program,
            config.cwd,
            env,
            self.log,
            on_notification=self._on_notification,
            on_request=self._on_request,
            on_exit=self._on_exit,
            on_auth_failure=self._on_auth_failure,
        )
        try:
            await server.start()
        except OSError as error:
            raise RuntimeError(f"spawning {program}: {error}")
        self.server = server
        self._dead = False
        try:
            await server.handshake()
            if self.thread_id:
                await self._reopen(server, self.thread_id)
            else:
                params = with_thread_policy({"cwd": config.cwd}, mode_named(self.mode))
                if self.model:
                    params["model"] = self.model
                with_developer_instructions(params, config.additional_system_prompt)
                started = await server.call("thread/start", params)
                thread = started.get("thread") if isinstance(started, dict) else None
                thread_id = thread.get("id") if isinstance(thread, dict) else None
                if not isinstance(thread_id, str) or not thread_id:
                    raise RuntimeError("thread/start did not return a thread id")
                self.thread_id = thread_id
        except Exception as error:
            self.server = None
            # What a CLI that already left wrote on the way out is the only
            # account of why; give it a moment to arrive.
            if server.process is not None:
                try:
                    await asyncio.wait_for(server.process.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass
            await server.close()
            raise RuntimeError(f"{error}{server.tail()}")
        self.stale_reason = None
        self.ctx.set_persist({"threadId": self.thread_id})
        self.ctx.set_pid(server.pid)

    async def _reopen(self, server: AppServer, thread_id: str) -> None:
        """Archived threads are unarchived once and tried again."""

        def params() -> dict:
            return with_developer_instructions(
                with_thread_policy({"threadId": thread_id}, mode_named(self.mode)),
                self.ctx.config.additional_system_prompt,
            )

        try:
            await server.call("thread/resume", params())
            return
        except RpcError as error:
            if not archived_thread(str(error), thread_id):
                raise RuntimeError(f"resuming Codex thread {thread_id}: {error}")
        try:
            await server.call("thread/unarchive", {"threadId": thread_id})
        except RpcError as error:
            raise RuntimeError(f"unarchiving Codex thread {thread_id}: {error}")
        try:
            await server.call("thread/resume", params())
        except RpcError as error:
            raise RuntimeError(f"resuming Codex thread {thread_id} after unarchive: {error}")

    async def _restart(self) -> None:
        reason = self.stale_reason or ("exited" if self._dead else "not running")
        self.log(f"restarting app-server ({reason}) and resuming thread {self.thread_id}")
        old, self.server = self.server, None
        self.asks.clear()
        if old is not None:
            await old.close()
        await self._open()

    def mark_stale(self, reason: str) -> None:
        """Restart at the next turn boundary; never in the middle of a turn."""
        if not self._closed:
            self.stale_reason = reason

    # -- callbacks from the connection ------------------------------------------

    def _on_notification(self, method: str, params: Any) -> None:
        if method == "serverRequest/resolved":
            for event in self.asks.resolved(params, self.thread_id):
                self.ctx.emit(event)
            return
        self.translator.translate(method, params, self.thread_id)

    def _on_request(self, upstream_id: Any, method: str, params: Any) -> None:
        surface = True
        if is_interactive_request(method):
            surface = self.translator.is_current_scope(params if isinstance(params, dict) else {}, self.thread_id)
        emitted, reply = self.asks.on_request(upstream_id, method, params, surface)
        for event in emitted:
            self.ctx.emit(event)
        server = self.server
        if reply is not None and server is not None:
            asyncio.ensure_future(self._answer(server, reply))

    async def _answer(self, server: AppServer, frame: dict) -> None:
        try:
            await server.send(frame)
        except RpcError as error:
            self.log(f"could not answer codex: {error}")

    def _on_exit(self, server: AppServer) -> None:
        if server is not self.server:
            return
        self._dead = True
        self.asks.clear()
        # Nothing is going to send `turn/completed` for a turn in flight.
        self.translator.fail_crashed(server.describe_exit())
        self.ctx.set_pid(None)

    def _on_auth_failure(self) -> None:
        if self.stale_reason is None:
            self.log("app-server reported a revoked or rejected token; it will be restarted at the next turn")
        self.mark_stale("token")
        self.runtime.request_refresh()

    # -- Session ------------------------------------------------------------------

    async def send(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        if self._closed:
            raise RuntimeError("this Codex session is closed")
        self._pending_turn = turn_id
        self._early_interrupt = False
        # Returned at once: a restart + resume may take longer than the
        # daemon's send deadline, and every outcome ends as a turn event.
        self._turn_task = asyncio.ensure_future(self._run_turn(turn_id, text, attachments))

    async def _run_turn(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        begun = False
        try:
            async with self._lock:
                if self.runtime.logged_in is False:
                    self._pending_turn = None
                    self.ctx.emit(
                        events.turn_failed(turn_id, "Codex 还没登录：在 Agent 列表里点「登录」后再发。", code="missingCredentials")
                    )
                    return
                if self.server is None or self._dead or self.stale_reason:
                    await self._restart()
                if self._early_interrupt or self._closed:
                    self._pending_turn = None
                    self.ctx.emit(events.turn_canceled(turn_id))
                    return
                if not self.thread_id:
                    raise RuntimeError("the Codex thread was never started")
                blocks = turn_input(text, attachments, self.ctx.config.scratch_dir)
                server = self.server
                assert server is not None
                self.translator.begin_turn(turn_id)
                self._pending_turn = None
                begun = True
                mode = mode_named(self.mode)
                params = {
                    "threadId": self.thread_id,
                    "input": blocks,
                    "approvalPolicy": mode["approval"],
                    "sandboxPolicy": sandbox_policy(mode),
                }
                if self.model:
                    params["model"] = self.model
                if self.effort:
                    params["effort"] = self.effort

                def bind(result: Any) -> None:
                    upstream = notification_turn_id(result)
                    if upstream:
                        self.translator.bind_from_response(turn_id, upstream)

                await server.call("turn/start", params, on_result=bind)
            state = self.translator.state
            if state.id == turn_id and state.interrupt_requested:
                # Stop was pressed before the CLI named the turn.
                try:
                    await self.interrupt()
                except Exception as error:  # noqa: BLE001
                    self.log(f"deferred interrupt failed: {error}")
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - every failure ends the turn visibly
            self._pending_turn = None
            state = self.translator.state
            if begun and state.id != turn_id:
                return  # already ended (crash, completion) by the read loop
            canceled = begun and state.interrupt_requested
            self.translator.abandon(turn_id)
            if canceled:
                self.ctx.emit(events.turn_canceled(turn_id))
            else:
                self.ctx.emit(events.turn_failed(turn_id, str(error) or error.__class__.__name__))

    async def interrupt(self) -> None:
        state = self.translator.state
        if self._pending_turn is not None and state.id != self._pending_turn:
            # Still restarting or about to call turn/start.
            self._early_interrupt = True
            return
        state.interrupt_requested = True
        codex_turn, thread, server = state.codex_turn, self.thread_id, self.server
        if not codex_turn or not thread or server is None or not server.alive:
            # Nothing running, or the CLI has not named the turn yet; the
            # turn/start response path re-issues this once it has.
            return
        try:
            await server.call("turn/interrupt", {"threadId": thread, "turnId": codex_turn})
            return
        except RpcError as refused:
            actual = active_turn_named_in(str(refused))
            if actual is None:
                raise
        self.log(f"codex rotated the upstream turn ({codex_turn} -> {actual}); cancelling the one it is running")
        state.codex_turn = actual
        await server.call("turn/interrupt", {"threadId": thread, "turnId": actual})

    async def close(self) -> None:
        self._closed = True
        self.runtime.forget(self)
        if self._turn_task is not None and not self._turn_task.done():
            self._turn_task.cancel()
        server, self.server = self.server, None
        if server is not None:
            await server.close()

    async def set_model(self, model_id: str) -> None:
        self.model = self._known_model(model_id)
        if self.model != model_id:
            self.log(f"Codex did not list a model called '{model_id}'; using {self.model}")
            if self.model:
                self.ctx.emit(events.model_changed(self.model))

    async def set_mode(self, mode_id: str) -> None:
        if not any(mode["id"] == mode_id for mode in MODES):
            raise RuntimeError(f"'{mode_id}' is not one of Codex's modes")
        self.mode = mode_id

    async def set_effort(self, effort_id: str) -> None:
        self.effort = self._known_effort(effort_id)
        if self.effort != effort_id:
            self.log(f"Codex did not list a thinking level called '{effort_id}'; using {self.effort}")
            if self.effort:
                self.ctx.emit(events.effort_changed(self.effort))

    async def respond(self, request_id: str, outcome: dict) -> None:
        frame, event = self.asks.respond(request_id, outcome)
        if self.server is None:
            raise RuntimeError(f"Codex request '{request_id}' is no longer pending")
        await self.server.send(frame)
        self.ctx.emit(event)

    async def fork(self, checkpoint: str) -> Any:
        async with self._lock:
            if not self.thread_id:
                raise RuntimeError("the Codex thread was never started")
            if self.server is None or self._dead or self.stale_reason:
                await self._restart()
            assert self.server is not None
            forked = await self.server.call(
                "thread/fork",
                with_thread_policy(
                    {"threadId": self.thread_id, "lastTurnId": checkpoint, "ephemeral": False},
                    mode_named(self.mode),
                ),
            )
        thread = forked.get("thread") if isinstance(forked, dict) else None
        thread_id = thread.get("id") if isinstance(thread, dict) else None
        if not isinstance(thread_id, str) or not thread_id:
            raise RuntimeError("thread/fork did not return a thread id")
        return {"threadId": thread_id}
