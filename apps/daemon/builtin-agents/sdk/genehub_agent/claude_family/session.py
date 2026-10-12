"""One conversation with a Claude-protocol CLI.

One long-lived process per session, speaking stream-json on stdin/stdout:
user frames go in, frames come out and are translated (``translate``) into
session events. Control requests (``set_model``, ``interrupt``, tool
permission prompts) travel on the same pipes.

The process starts with the first prompt, not with the session: a session
opened only to look at its history costs nothing. A process that exits on
its own is started again, with ``--resume``, by the next prompt.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional

from .. import events
from .. import process as proc
from .. import usage as usage_mod
from ..serve import Session, SessionContext
from . import catalog, translate
from .flavor import UNRESTRICTED_SETTINGS, Flavor

CONTROL_TIMEOUT = 30.0
# How long an interrupt gets before the process is ended; the next prompt
# starts a fresh one with the same session.
INTERRUPT_GRACE = 15.0
# How long a prompt may go with the CLI saying nothing at all. A turn that
# never gets a first frame is not a slow turn: nothing is coming, and without
# this the turn stays open forever — no answer, no error, nothing to retry.
FIRST_FRAME_TIMEOUT = 90.0
CHATTER_LINES = 20
PIPE_SETTLE = 1.0


@dataclass
class Launch:
    """What a session needs to know about the installed CLI."""

    program: str
    help_text: str = ""
    models: List[str] = field(default_factory=list)
    efforts: List[str] = field(default_factory=list)
    default_model: Optional[str] = None
    env: Dict[str, str] = field(default_factory=dict)


def launch_args(
    flavor: Flavor,
    launch: Launch,
    *,
    mode: str,
    model: Optional[str],
    effort: Optional[str],
    guidance: Optional[str],
    resume: Optional[str],
) -> List[str]:
    """The command line of a session process. Model and effort are passed only
    when this install listed them: a stored choice may name something that is
    not one of the CLI's own aliases, and passing it would be ignored or stop
    the CLI from starting."""
    args = [
        launch.program,
        *catalog.base_args(flavor),
        "--include-partial-messages",
    ]
    if flavor.permission_prompt_tool:
        args += ["--permission-prompt-tool", "stdio"]
    args += [flavor.skip_permissions_flag, "--settings", UNRESTRICTED_SETTINGS, "--permission-mode", mode]
    if model and model in launch.models:
        args += ["--model", model]
    if effort and effort in launch.efforts:
        args += ["--effort", effort]
    if guidance and guidance.strip():
        args += ["--append-system-prompt", guidance]
    if resume:
        args += ["--resume", resume]
    return args


_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt"}


def user_content(text: str, attachments: List[dict], scratch: str) -> List[dict]:
    """The ``content`` of a user frame: the Anthropic Messages API block shape
    the CLI wraps directly. Pasted images go inline; any other file is named in
    the text, spilled into the scratch directory first when it was pasted."""
    blocks: List[dict] = [{"type": "text", "text": text}]
    files: List[tuple] = []
    for index, attachment in enumerate(attachments or []):
        name = attachment.get("name") or ""
        mime = attachment.get("mime") or ""
        data = attachment.get("dataBase64")
        path = attachment.get("path")
        if isinstance(data, str) and data and mime.startswith("image/"):
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": "".join(data.split())}})
            continue
        if not path and isinstance(data, str) and data:
            try:
                payload = base64.b64decode("".join(data.split()), validate=True)
            except (ValueError, TypeError) as error:
                raise RuntimeError(f"读取粘贴的附件失败：{error}") from error
            directory = os.path.join(scratch, "attachments")
            os.makedirs(directory, exist_ok=True)
            path = os.path.join(directory, f"{uuid.uuid4().hex}-{index}.{_EXTENSIONS.get(mime, 'bin')}")
            with open(path, "wb") as handle:
                handle.write(payload)
        if path:
            files.append((name, path))
    if files:
        blocks[0]["text"] += "\n\nAttached files (open them with your read tool):" + "".join(f"\n- {name}: {path}" for name, path in files)
    return blocks


class FamilySession(Session):
    def __init__(self, ctx: SessionContext, agent: Any, flavor: Flavor, launch: Launch, mode_catalog: Optional[List[dict]] = None) -> None:
        super().__init__(ctx)
        self.agent = agent
        self.flavor = flavor
        self.launch = launch
        config = ctx.config
        resume = config.resume if isinstance(config.resume, dict) else {}
        found = resume.get("sessionId")
        self.session_id: Optional[str] = found if isinstance(found, str) and found else None
        self.model_id: Optional[str] = config.model_id
        self.effort_id: Optional[str] = config.effort_id
        self.mode = catalog.initial_permission_mode(config.mode_id, launch.help_text)
        self.process: Optional[asyncio.subprocess.Process] = None
        self.turn: Optional[translate.TurnState] = None
        self.said: Deque[str] = collections.deque(maxlen=CHATTER_LINES)
        self.always_allow: set = set()
        # request id -> what was asked, until the person answers.
        self.pending: Dict[str, dict] = {}
        self.awaiting: Dict[str, "asyncio.Future"] = {}
        self._control_counter = 0
        self._tasks: List["asyncio.Future"] = []
        self._watchdog: Optional["asyncio.Future"] = None
        self._stall: Optional["asyncio.Future"] = None
        self._launching: Optional[asyncio.Lock] = None
        self._chatter: Optional["asyncio.Future"] = None
        self._recycle = False
        self._changes: List[dict] = []
        self._normalize()
        if self._changes:
            ctx.agent.spawn(self._flush_after_start())

    # -- the selection ----------------------------------------------------------

    def _normalize(self) -> None:
        """A saved choice the install no longer offers is replaced, and the
        replacement reported so the session's saved choice follows."""
        launch, config = self.launch, self.ctx.config
        if self.model_id and launch.models and self.model_id not in launch.models:
            fallback = launch.default_model if launch.default_model in launch.models else launch.models[0]
            self.model_id = fallback
            self._changes.append(events.model_changed(fallback))
        if config.mode_id and config.mode_id != self.mode:
            self._changes.append(events.mode_changed(self.mode))

    async def _flush_after_start(self) -> None:
        # Scheduled during session.start; runs after its reply is written, so
        # the daemon already knows the session.
        await asyncio.sleep(0)
        changes, self._changes = self._changes, []
        for change in changes:
            self.ctx.emit(change)

    # -- the process ----------------------------------------------------------------

    def recycle_when_idle(self) -> None:
        """Credentials or the CLI changed: the next process, started with
        ``--resume``, picks that up. A turn in flight is not cut short."""
        if self.turn is not None:
            self._recycle = True
        elif self._alive():
            self._recycle_now()

    def _recycle_now(self) -> None:
        # Detached synchronously: a prompt that arrives next must start a new
        # process, not find (and be killed with) the old one.
        process, self.process = self.process, None
        self._recycle = False
        if process is not None:
            self.ctx.set_pid(None)
            self.ctx.agent.spawn(proc.kill_tree(process))

    def _alive(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def _ensure_process(self) -> None:
        if self._alive():
            return
        if self._launching is None:
            self._launching = asyncio.Lock()
        async with self._launching:
            if self._alive():
                return
            await self._launch()

    async def _launch(self) -> None:
        config = self.ctx.config
        # Fresh each time: login, update or a model list refresh may have
        # changed what this install offers since the session was opened.
        self.launch = await self.agent.prepare_launch()
        argv = launch_args(
            self.flavor,
            self.launch,
            mode=self.mode,
            model=self.model_id,
            effort=self.effort_id,
            guidance=config.additional_system_prompt,
            resume=self.session_id,
        )
        env = proc.child_environment({**self.launch.env, **config.session_environment(), **self.flavor.sandbox()})
        cwd = config.cwd if config.cwd and os.path.isdir(config.cwd) else None
        self.said.clear()
        self.ctx.agent.log(f"{self.flavor.id} starting (model={self.model_id or '(default)'}, mode={self.mode}, resume={self.session_id is not None})")
        try:
            process = await proc.spawn(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception as error:
            raise RuntimeError(f"没能启动 {self.flavor.label}：{error}") from error
        self.process = process
        self.ctx.set_pid(process.pid)
        self.ctx.agent.log(f"{self.flavor.id} process pid={process.pid} cwd={cwd or '(default)'} argv={len(argv)}")
        reader = asyncio.ensure_future(self._read(process))
        chatter = asyncio.ensure_future(self._watch_stderr(process))
        self._tasks.extend([reader, chatter])
        self._chatter = chatter

    async def _write(self, value: dict) -> None:
        process = self.process
        if process is None or process.stdin is None or process.returncode is not None:
            raise RuntimeError(await self._stopped(process))
        try:
            process.stdin.write((json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8"))
            await process.stdin.drain()
        except (OSError, ConnectionError) as error:
            raise RuntimeError(await self._stopped(process) + f"（{error}）") from error

    async def _watch_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr is not None
        while True:
            raw = await process.stderr.readline()
            if not raw:
                return
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            self.ctx.agent.log(f"{self.flavor.id}: {line}")
            self.said.append(line)

    async def _stopped(self, process: Optional[asyncio.subprocess.Process]) -> str:
        """Why the CLI is gone. Exit code and the last lines it wrote are what
        tell a missing credential, a CLI too old for our flags and a launcher
        that cannot find node apart; all three look identical otherwise."""
        chatter = self._chatter
        if chatter is not None:
            try:
                await asyncio.wait_for(asyncio.shield(chatter), PIPE_SETTLE)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        code: Optional[int] = None
        for _ in range(20):
            if process is not None and process.returncode is not None:
                code = process.returncode
                break
            if process is None:
                break
            await asyncio.sleep(0.05)
        label = self.flavor.label
        message = f"{label} 退出了（退出码 {code}）" if code is not None else f"{label} 意外退出了"
        if self.said:
            message += "：" + " / ".join(self.said)
        else:
            message += "，而且它什么都没说。日志里有它这一趟的全部输出。"
        return message

    # -- reading ------------------------------------------------------------------------

    async def _read(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout is not None
        try:
            while True:
                try:
                    raw = await process.stdout.readline()
                except ValueError as error:
                    self.ctx.agent.log(f"{self.flavor.id} sent a frame too large to read: {error}")
                    break
                if not raw:
                    break
                try:
                    frame = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if isinstance(frame, dict):
                    try:
                        await self._dispatch(frame)
                    except Exception as error:  # noqa: BLE001 - one bad frame must not end the session
                        self.ctx.agent.log(f"{self.flavor.id}: could not handle a {frame.get('type')} frame: {error!r}")
        finally:
            await self._ended(process)

    async def _dispatch(self, frame: dict) -> None:
        kind = frame.get("type")
        state = self.turn
        emit = self.ctx.emit
        # Any frame about the turn: the CLI is there and the turn is its to
        # finish, not this watch's. A control reply is the answer to something
        # this side asked (initialize, a model switch), not to the prompt, so it
        # proves nothing about the turn and must not end the watch: it arrives
        # at an unpredictable moment around the prompt, and letting it cancel
        # the watch made a stalled turn stay open about one time in three.
        about_the_turn = kind != "control_response"
        if about_the_turn:
            self._stop_stall_watch()
        if about_the_turn and state is not None and state.sent_at is not None and not state.first_frame_logged:
            state.first_frame_logged = True
            self.ctx.agent.log(f"{self.flavor.id} first frame {kind} after {(time.monotonic() - state.sent_at) * 1000:.0f}ms (turn {state.id})")
        if kind == "system":
            found = translate.translate_system(frame, state, emit)
            if found and found != self.session_id:
                self.session_id = found
                self.ctx.set_persist({"sessionId": found})
        elif kind == "control_response":
            self._settle(frame)
        elif kind == "control_request":
            await self._on_control_request(frame)
        elif state is None:
            return
        elif kind == "stream_event":
            translate.translate_stream_event(frame, state, emit)
        elif kind == "assistant":
            translate.translate_assistant(frame, state, emit)
        elif kind == "user":
            translate.translate_user(frame, state, emit)
        elif kind == "result":
            waited = f" after {(time.monotonic() - state.sent_at) * 1000:.0f}ms" if state.sent_at is not None else ""
            self.ctx.agent.log(f"{self.flavor.id} result {frame.get('subtype')} (turn {state.id}){waited}")
            self.turn = None
            self._stop_watchdog()
            translate.translate_result(frame, state, emit, self.flavor.label)
            self._drop_pending()
            if self._recycle:
                self._recycle_now()

    def _drop_pending(self) -> None:
        """A turn that ended leaves nothing for the person to answer."""
        for request_id in list(self.pending):
            self.pending.pop(request_id, None)
            self.ctx.emit(events.permission_resolved(request_id, {"outcome": "canceled"}))

    async def _ended(self, process: asyncio.subprocess.Process) -> None:
        self._stop_stall_watch()
        if self.process is not process:
            return
        why = await self._stopped(process)
        self.ctx.agent.log(why)
        self.process = None
        self.ctx.set_pid(None)
        for future in list(self.awaiting.values()):
            if not future.done():
                future.set_exception(RuntimeError(why))
        self.awaiting.clear()
        state, self.turn = self.turn, None
        self._stop_watchdog()
        self._drop_pending()
        if state is not None:
            if state.interrupt_requested:
                self.ctx.emit(events.turn_canceled(state.id))
            else:
                self.ctx.emit(events.turn_failed(state.id, why, "agentCrashed"))

    def _settle(self, frame: dict) -> None:
        response = frame.get("response")
        response = response if isinstance(response, dict) else {}
        future = self.awaiting.pop(response.get("request_id"), None) if isinstance(response.get("request_id"), str) else None
        if future is None or future.done():
            # An ack nobody waits for: `interrupt`'s answer is the turn ending.
            return
        if response.get("subtype") == "success":
            future.set_result(None)
        else:
            error = response.get("error")
            future.set_exception(RuntimeError(error if isinstance(error, str) and error else "no reason given"))

    # -- what the CLI asks of the person ---------------------------------------------------

    async def _on_control_request(self, frame: dict) -> None:
        request = frame.get("request")
        request_id = frame.get("request_id")
        if not isinstance(request, dict) or request.get("subtype") != "can_use_tool" or not isinstance(request_id, str):
            return
        tool = request.get("tool_name") if isinstance(request.get("tool_name"), str) else "a tool"
        tool_input = request.get("input")
        state = self.turn
        if tool == "AskUserQuestion":
            questions = translate.parse_questions(tool_input)
            if questions is None:
                await self._reply(request_id, _deny("GeneHub could not show these questions, so nobody answered them."))
                return
            known = state.tool_items.get(request.get("tool_use_id")) if state is not None and isinstance(request.get("tool_use_id"), str) else None
            self.pending[request_id] = {"tool": tool, "input": tool_input, "questions": questions}
            self.ctx.emit(translate.question_event(request_id, questions, known[0] if known else None))
            return
        if self.mode in (catalog.MODE_ACCEPT_EDITS, catalog.MODE_BYPASS) or tool in self.always_allow:
            # Without ever bothering the person: the whole session is in a
            # mode that does not ask, or they already chose "Always Allow".
            await self._reply(request_id, _allow(tool_input))
            return
        self.pending[request_id] = {"tool": tool, "input": tool_input}
        self.ctx.emit(translate.permission_event(request_id, request, state))

    async def _reply(self, request_id: str, response: dict) -> None:
        await self._write({"type": "control_response", "response": {"request_id": request_id, "subtype": "success", "response": response}})

    async def respond(self, request_id: str, outcome: dict) -> None:
        pending = self.pending.pop(request_id, None)
        if pending is None:
            raise RuntimeError(f"请求 {request_id} 已经不在等待回答了")
        tool_input = pending.get("input")
        if "questions" in pending:
            answers = translate.question_answers(pending["questions"], outcome) if isinstance(outcome, dict) else None
            if answers is None:
                response = _deny("The user did not answer the questions.")
            else:
                updated = dict(tool_input) if isinstance(tool_input, dict) else {}
                updated["answers"] = answers
                response = {"behavior": "allow", "allowed": True, "updatedInput": updated}
        else:
            kind = outcome.get("outcome") if isinstance(outcome, dict) else None
            choice = outcome.get("optionId") if isinstance(outcome, dict) else None
            if kind == "selected" and choice == translate.ALLOW:
                response = _allow(tool_input)
            elif kind == "selected" and choice == translate.ALLOW_ALWAYS:
                # No wire-level equivalent: enforced here for the session.
                self.always_allow.add(pending["tool"])
                response = _allow(tool_input)
            elif kind == "timedOut":
                # What the agent is told becomes its next sentence; "denied by
                # the user" when no user was there sends it off apologising
                # for a decision nobody made.
                response = _deny("No one was available to approve this, so it was denied.")
            else:
                response = _deny("Denied by the user.")
        await self._reply(request_id, response)
        self.ctx.emit(events.permission_resolved(request_id, outcome))

    # -- turns -----------------------------------------------------------------------------------

    async def send(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        if self.turn is not None:
            raise RuntimeError(f"{self.flavor.label} 还在处理上一轮")
        state = translate.TurnState(turn_id)
        # Set before the first await: a Stop that lands while the process is
        # still starting ends this turn rather than being lost.
        self.turn = state
        try:
            blocks = user_content(text, attachments, self.ctx.config.scratch_dir)
            await self._ensure_process()
            if state.interrupt_requested:
                self.turn = None
                self.ctx.emit(events.turn_canceled(turn_id))
                return
            usage_mod.record_round_start(state.usage)
            await self._write({"type": "user", "message": {"role": "user", "content": blocks}})
            state.sent_at = time.monotonic()
            self.ctx.agent.log(f"{self.flavor.id} prompt written (turn {state.id})")
            self._stop_stall_watch()
            self._stall = asyncio.ensure_future(self._stall_guard(state))
        except BaseException:
            if self.turn is state:
                self.turn = None
            raise

    async def interrupt(self) -> None:
        state = self.turn
        if state is None:
            return
        state.interrupt_requested = True
        if self._alive():
            try:
                await self._write({"type": "control_request", "request_id": self._next_id(), "request": {"subtype": "interrupt"}})
            except RuntimeError:
                pass
            self._stop_watchdog()
            self._watchdog = asyncio.ensure_future(self._force_stop(state))

    async def _force_stop(self, state: translate.TurnState) -> None:
        await asyncio.sleep(INTERRUPT_GRACE)
        if self.turn is state and self.process is not None:
            self.ctx.agent.log(f"{self.flavor.id} did not stop in {INTERRUPT_GRACE:.0f}s; ending it")
            await proc.kill_tree(self.process)

    def _stop_watchdog(self) -> None:
        watchdog, self._watchdog = self._watchdog, None
        if watchdog is not None and not watchdog.done() and watchdog is not asyncio.current_task():
            watchdog.cancel()

    async def _stall_guard(self, state: translate.TurnState) -> None:
        """A prompt the CLI never answered. Long enough that a cold start and a
        queued first token fit inside it; after that the turn is ended rather
        than left open, so the person gets an error they can act on."""
        try:
            await asyncio.sleep(FIRST_FRAME_TIMEOUT)
        except asyncio.CancelledError:
            return
        if self.turn is not state:
            return
        process = self.process
        # This watch is firing, so it is no longer something to stop. Ending the
        # process makes the reader see EOF, and the reader's own cleanup stops
        # "the stall watch": left registered, that cancelled this very task in
        # the middle of the kill, and the turn then never got its ending.
        self._stall = None
        self.turn = None
        self._stop_watchdog()
        self._drop_pending()
        why = f"{self.flavor.label} 在 {FIRST_FRAME_TIMEOUT:g} 秒内没有任何回应，本轮已结束。可以重试，或换一个 Agent。"
        self.ctx.agent.log(why)
        self.process = None
        self.ctx.set_pid(None)
        try:
            if process is not None and process.returncode is None:
                await proc.kill_tree(process)
        finally:
            self.ctx.emit(events.turn_failed(state.id, why, "timeout"))

    def _stop_stall_watch(self) -> None:
        stall, self._stall = self._stall, None
        if stall is not None and not stall.done() and stall is not asyncio.current_task():
            stall.cancel()

    async def close(self) -> None:
        self._stop_watchdog()
        self._stop_stall_watch()
        process = self.process
        self.process = None
        if process is not None:
            await proc.kill_tree(process)
            self.ctx.set_pid(None)
        for task in self._tasks:
            if not task.done():
                task.cancel()
        self._tasks.clear()
        forget = getattr(self.agent, "forget", None)
        if forget is not None:
            forget(self)

    # -- runtime settings -----------------------------------------------------------------------------

    def _next_id(self) -> str:
        self._control_counter += 1
        return f"genehub_{self._control_counter}"

    async def _ask(self, subtype: str, body: dict) -> None:
        """A control request, waited for: these back the pickers in the
        composer, and a control that reports success while the CLI ignored it
        is worse than one that fails."""
        request_id = self._next_id()
        future = asyncio.get_event_loop().create_future()
        self.awaiting[request_id] = future
        try:
            await self._write({"type": "control_request", "request_id": request_id, "request": {"subtype": subtype, **body}})
            await asyncio.wait_for(future, CONTROL_TIMEOUT)
        except asyncio.TimeoutError:
            raise RuntimeError(f"{self.flavor.label} 在 {CONTROL_TIMEOUT:.0f} 秒内没有回应 {subtype}") from None
        finally:
            self.awaiting.pop(request_id, None)

    async def set_model(self, model_id: str) -> None:
        # The CLI does not check this for us: asked for a model it has never
        # heard of it answers success and carries on with the one it had, so
        # without this a model that does not exist would look like it worked.
        if model_id not in self.launch.models:
            listed = "、".join(self.launch.models) or "它没有列出任何模型"
            raise RuntimeError(f"'{model_id}' 不是这个 {self.flavor.label} 提供的模型（{listed}）")
        if self._alive():
            try:
                await self._ask("set_model", {"model": model_id})
            except RuntimeError as error:
                raise RuntimeError(f"{self.flavor.label} 没有切换到 '{model_id}'：{error}") from error
        self.model_id = model_id

    async def set_effort(self, effort_id: str) -> None:
        if effort_id not in self.launch.efforts:
            listed = "、".join(self.launch.efforts) or "它没有列出任何档位"
            raise RuntimeError(f"'{effort_id}' 不是这个 {self.flavor.label} 提供的思考强度（{listed}）")
        if self._alive():
            try:
                # No model in the request: the level applies to whichever
                # model is in play, which can change under us.
                await self._ask("set_model", {"effort": effort_id})
            except RuntimeError as error:
                raise RuntimeError(f"{self.flavor.label} 没有切换到 '{effort_id}' 档：{error}") from error
        self.effort_id = effort_id

    async def set_mode(self, mode_id: str) -> None:
        if not catalog.is_known_mode(mode_id):
            raise RuntimeError(f"未知的模式 '{mode_id}'")
        mode = mode_id
        if mode_id in (catalog.MODE_DEFAULT, catalog.MODE_ASK_ALIAS):
            mode = catalog.ask_mode_in(self.launch.help_text) or mode_id
        if self._alive():
            try:
                await self._ask("set_permission_mode", {"mode": mode})
            except RuntimeError as error:
                # Accept-edits is also a promise kept on this side (auto-allow
                # above), so a build too old for the request still behaves.
                if mode != catalog.MODE_ACCEPT_EDITS:
                    raise RuntimeError(f"{self.flavor.label} 没有切换到 '{mode}'：{error}") from error
                self.ctx.agent.log(f"{self.flavor.id} refused set_permission_mode ({error}); approving edits here instead")
        self.mode = mode


def _allow(tool_input: Any) -> dict:
    # Claude Code reads `behavior`; CodeBuddy's host reads `allowed`. Each
    # ignores the other's field, and a CLI that only knew one would treat the
    # answer as a refusal.
    response: Dict[str, Any] = {"behavior": "allow", "allowed": True}
    if isinstance(tool_input, dict):
        response["updatedInput"] = tool_input
    return response


def _deny(message: str) -> dict:
    return {"behavior": "deny", "message": message, "allowed": False, "reason": message}
