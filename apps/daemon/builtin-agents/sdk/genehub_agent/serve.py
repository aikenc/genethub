"""The ``serve`` loop: one process per Agent, hosting all of its sessions.

An Agent subclasses :class:`Agent` and, for conversations, :class:`Session`,
then calls :func:`serve`. The method names below are the whole protocol;
``docs/agent-serve-protocol.md`` lists the wire messages they map to.

The daemon emits ``turnStarted`` itself before it asks a session to send, and
``turnFailed`` if this process dies mid-turn. A session emits everything in
between and exactly one of ``turnCompleted`` / ``turnFailed`` /
``turnCanceled`` to end the turn.
"""

from __future__ import annotations

import asyncio
import atexit
import os
import platform as _platform
import signal
import sys
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

from . import _boot
from . import process as _process
from .rpc import Channel


# --------------------------------------------------------------------------
# Data handed to the Agent


@dataclass
class Platform:
    os: str
    arch: str


@dataclass
class SessionConfig:
    """What the daemon knows about a session when it asks for one.

    Paths are absolute host paths. ``resume`` is the last value this script
    reported through :meth:`SessionContext.set_persist`, or ``None``.
    """

    session_id: str
    cwd: str
    scratch_dir: str
    model_id: Optional[str] = None
    mode_id: Optional[str] = None
    effort_id: Optional[str] = None
    fast: Optional[bool] = None
    runtime_values: Dict[str, str] = field(default_factory=dict)
    additional_system_prompt: Optional[str] = None
    skills_dir: Optional[str] = None
    front_door_cli: Optional[str] = None
    controller_token: Optional[str] = None
    resume: Any = None

    @classmethod
    def from_wire(cls, session_id: str, raw: dict) -> "SessionConfig":
        return cls(
            session_id=session_id,
            cwd=raw.get("cwd") or os.getcwd(),
            scratch_dir=raw.get("scratchDir") or "",
            model_id=raw.get("modelId"),
            mode_id=raw.get("modeId"),
            effort_id=raw.get("effortId"),
            fast=raw.get("fast"),
            runtime_values=dict(raw.get("runtimeValues") or {}),
            additional_system_prompt=raw.get("additionalSystemPrompt"),
            skills_dir=raw.get("skillsDir"),
            front_door_cli=raw.get("frontDoorCli"),
            controller_token=raw.get("controllerToken"),
            resume=raw.get("resume"),
        )

    def session_environment(self) -> Dict[str, str]:
        """The GeneHub bindings every live Agent CLI process receives."""
        env = {"GENEHUB_SESSION_ID": self.session_id}
        if self.front_door_cli:
            env["GENEHUB_CLI"] = self.front_door_cli
        if self.controller_token:
            env["GENEHUB_CONTROLLER_TOKEN"] = self.controller_token
        return env


# --------------------------------------------------------------------------
# User requests


def option(option_id: str, label: str) -> dict:
    return {"id": option_id, "label": label}


def link(url: str, label: Optional[str] = None, render: Optional[str] = None) -> dict:
    item = {"kind": "link", "value": url}
    if label:
        item["label"] = label
    if render:
        item["render"] = render
    return item


def code(value: str, label: Optional[str] = None) -> dict:
    item = {"kind": "code", "value": value}
    if label:
        item["label"] = label
    return item


def text_question(question_id: str, prompt: str) -> dict:
    return {"id": question_id, "prompt": prompt, "input": "text"}


def secret_question(question_id: str, prompt: str) -> dict:
    return {"id": question_id, "prompt": prompt, "input": "secret"}


def choice_question(question_id: str, prompt: str, options: List[dict], allow_multiple: bool = False) -> dict:
    return {"id": question_id, "prompt": prompt, "options": options, "allowMultiple": allow_multiple}


@dataclass
class Outcome:
    canceled: bool
    option_id: Optional[str] = None
    selected: Dict[str, List[str]] = field(default_factory=dict)
    text: Dict[str, str] = field(default_factory=dict)

    def value(self, question_id: str) -> Optional[str]:
        if question_id in self.text:
            return self.text[question_id]
        chosen = self.selected.get(question_id)
        return chosen[0] if chosen else None


class RequestHandle:
    def __init__(self, ctx: "AgentContext", request_id: str, secret_ids: Optional[Set[str]] = None) -> None:
        self._ctx = ctx
        self.id = request_id
        # Questions whose answers are masked in every log.
        self.secret_ids: Set[str] = set(secret_ids or ())
        self._future: asyncio.Future = asyncio.get_event_loop().create_future()

    async def wait(self) -> Outcome:
        try:
            return await self._future
        finally:
            self.close()

    def close(self) -> None:
        if self._ctx._requests.pop(self.id, None) is not None:
            self._ctx._channel.notify("request.close", {"id": self.id})
        if not self._future.done():
            self._future.set_result(Outcome(canceled=True))

    def _resolve(self, outcome: Outcome) -> None:
        if not self._future.done():
            self._future.set_result(outcome)


class _SuspendedRequest(Exception):
    def __init__(self, params: dict) -> None:
        self.params = params


def _outcome(raw: dict) -> Outcome:
    result = Outcome(canceled=raw.get("type") != "answered", option_id=raw.get("optionId"))
    for answer in raw.get("answers") or []:
        qid = answer.get("questionId")
        if isinstance(qid, str):
            result.selected[qid] = list(answer.get("selectedOptionIds") or [])
            if isinstance(answer.get("freeformText"), str):
                result.text[qid] = answer["freeformText"]
    return result


# --------------------------------------------------------------------------
# Jobs


class Job:
    """Progress of one action. Every update is pushed to the daemon."""

    def __init__(self, channel: Channel, job_id: str, action: Optional[str], mask: Optional["_SecretMask"] = None) -> None:
        self._channel = channel
        self._mask = mask
        self.id = job_id
        self.action = action
        self.finished = False
        self.step: Optional[str] = None
        self.outcome: Optional[Outcome] = None

    def _push(self, **fields: Any) -> None:
        params: Dict[str, Any] = {"job": self.id}
        if self.action:
            params["action"] = self.action
        for key, value in fields.items():
            if value is None:
                continue
            if isinstance(value, str) and self._mask is not None:
                value = self._mask.apply(value)
            params[key] = value
        self._channel.notify("job.progress", params)

    def progress(self, phase: Optional[str] = None, message: Optional[str] = None, percent: Optional[float] = None) -> None:
        self._push(phase=phase, message=message, percent=percent)

    def log(self, line: str) -> None:
        self._push(log=line.rstrip("\n"))

    def done(self, message: Optional[str] = None) -> None:
        if not self.finished:
            self.finished = True
            self._push(message=message, done=True)

    def fail(self, error: str) -> None:
        if not self.finished:
            self.finished = True
            self._push(error=error, done=True)


# --------------------------------------------------------------------------
# Contexts


class _SecretMask:
    """Wraps stderr so a value typed into a secret field never reaches the log."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self.secrets: List[str] = []

    def add(self, secret: str) -> None:
        # The value as typed and as a script will use it (stripped).
        for value in (secret, secret.strip()):
            if value and value not in self.secrets:
                self.secrets.append(value)
        # Longest first, so a secret that contains another is masked whole.
        self.secrets.sort(key=len, reverse=True)

    def apply(self, data: str) -> str:
        for secret in self.secrets:
            data = data.replace(secret, "***")
        return data

    def write(self, data: str) -> int:
        return self._stream.write(self.apply(data))

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


class AgentContext:
    def __init__(self, channel: Channel, init: dict, mask: _SecretMask) -> None:
        self._channel = channel
        self._mask = mask
        self._requests: Dict[str, RequestHandle] = {}
        self._preparing: Dict[str, asyncio.Future] = {}
        self.agent_id: str = init.get("agentId", "")
        self.channel_name: str = init.get("channel", "")
        self.platform = Platform(os=init.get("os") or sys.platform, arch=init.get("arch") or _platform.machine())
        self.state_dir: str = init.get("stateDir") or os.getcwd()
        self.agent_dir: str = init.get("agentDir") or (_boot.AGENT_DIR or "")
        self.sdk_dir: str = init.get("sdkDir") or (_boot.SDK_DIR or "")
        self.front_door_cli: Optional[str] = init.get("frontDoorCli")
        self._last_state: Optional[dict] = None
        self._background: Set[asyncio.Task] = set()

    def _track(self, task: asyncio.Task) -> asyncio.Task:
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    def _job(self, action: Optional[str]) -> Job:
        return Job(self._channel, "j_" + uuid.uuid4().hex, action, self._mask)

    # -- state ---------------------------------------------------------

    def set_state(
        self,
        ready: bool,
        message: Optional[str] = None,
        version: Optional[str] = None,
        actions: Optional[List[dict]] = None,
        capabilities: Optional[dict] = None,
        catalog: Optional[dict] = None,
    ) -> None:
        """Replaces this Agent's whole state on every screen at once."""
        state = {
            "ready": bool(ready),
            "message": self._mask.apply(message) if message else message,
            "version": version,
            "actions": actions or [],
            "capabilities": capabilities or {},
            "catalog": catalog or {"models": [], "modes": [], "commands": []},
        }
        if state != self._last_state:
            self._last_state = state
            self._channel.notify("state", state)

    @staticmethod
    def action(action_id: str, label: str, primary: bool = False) -> dict:
        return {"id": action_id, "label": label, "primary": primary}

    # -- requests ------------------------------------------------------

    def open_request(
        self,
        title: str,
        detail: Optional[str] = None,
        display: Optional[List[dict]] = None,
        questions: Optional[List[dict]] = None,
        options: Optional[List[dict]] = None,
    ) -> RequestHandle:
        """Shows a request to a person. Only a person can answer it; its
        contents never reach a model, a timeline or a log."""
        secret_ids = {
            question["id"]
            for question in questions or []
            if isinstance(question, dict) and question.get("input") == "secret" and question.get("id")
        }
        handle = RequestHandle(self, "r_" + uuid.uuid4().hex, secret_ids)
        self._requests[handle.id] = handle
        self._channel.notify(
            "request.open",
            {
                "id": handle.id,
                "title": title,
                "detail": detail,
                "display": display or [],
                "questions": questions or [],
                "options": options or [option("cancel", "取消")],
            },
        )
        return handle

    async def request(self, title: str, **kwargs: Any) -> Outcome:
        return await self.open_request(title, **kwargs).wait()

    async def ask(self, job: Job, step: str, title: str, *, detail: Optional[str] = None,
                  questions: Optional[List[dict]] = None, options: Optional[List[dict]] = None) -> Outcome:
        """Stop this action at a named, non-secret continuation boundary.

        The daemon saves only the static request and action/step identity.
        All finally blocks and owned child cleanup run before presentation.
        On answer a new job execution calls Agent.resume_action; no Future,
        old process, answer or credential is saved here.
        """
        if job.step == step and job.outcome is not None:
            result, job.outcome = job.outcome, None
            return result
        params = {
            "job": job.id, "action": job.action, "step": step,
            "request": {"id": "r_" + uuid.uuid4().hex, "title": title,
                        "detail": detail, "display": [], "questions": questions or [],
                        "options": options or [option("cancel", "取消")]},
        }
        request_id = params["request"]["id"]
        committed = asyncio.get_event_loop().create_future()
        self._preparing[request_id] = committed
        try:
            self._channel.notify("request.prepare", params)
            # Short persistence handshake, not a Future waiting for Human.
            await asyncio.wait_for(committed, timeout=10.0)
        finally:
            self._preparing.pop(request_id, None)
        raise _SuspendedRequest(params)

    def _answer(self, request_id: str, raw: dict) -> None:
        handle = self._requests.get(request_id)
        if handle is None:
            return
        if raw.get("type") != "answered":
            handle._resolve(Outcome(canceled=True))
            return
        outcome = Outcome(canceled=False, option_id=raw.get("optionId"))
        for answer in raw.get("answers") or []:
            qid = answer.get("questionId")
            if not qid:
                continue
            outcome.selected[qid] = list(answer.get("selectedOptionIds") or [])
            text = answer.get("freeformText")
            if isinstance(text, str):
                outcome.text[qid] = text
                if qid in handle.secret_ids:
                    self._mask.add(text)
        handle._resolve(outcome)

    # -- background work -----------------------------------------------

    def start_job(self, action: str, work: Callable[[Job], Awaitable[None]]) -> Job:
        """Runs work the script decided on by itself (an update check at
        start, say) as a job the person can watch."""
        job = self._job(action)
        self._track(asyncio.ensure_future(_run_job(job, work)))
        return job

    def spawn(self, coroutine: Awaitable[Any]) -> asyncio.Task:
        """Runs Agent-level background work. It belongs to no session, even
        when a session's callback started it: closing that session must not
        end the processes it runs."""
        return self._track(asyncio.ensure_future(_detached(coroutine)))

    def log(self, message: str) -> None:
        sys.stderr.write(message.rstrip("\n") + "\n")
        sys.stderr.flush()


class SessionContext:
    def __init__(self, agent: AgentContext, config: SessionConfig) -> None:
        self.agent = agent
        self.config = config
        self.session_id = config.session_id

    def emit(self, event: dict) -> None:
        """Sends one already-normalized ``SessionEvent`` (see ``events``)."""
        self.agent._channel.notify("session.event", {"sessionId": self.session_id, "event": event})

    def set_persist(self, value: Any) -> None:
        """What to hand back as ``config.resume`` after a restart."""
        self.config.resume = value
        self.agent._channel.notify("session.persist", {"sessionId": self.session_id, "value": value})

    def set_pid(self, pid: Optional[int]) -> None:
        """The native process this session's CLI runs as, so the daemon can
        find what it left running."""
        self.agent._channel.notify("session.pid", {"sessionId": self.session_id, "pid": pid})


# --------------------------------------------------------------------------
# What an Agent implements


class Session:
    """One conversation. Every method may raise; the message reaches the user."""

    def __init__(self, ctx: SessionContext) -> None:
        self.ctx = ctx

    async def send(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        raise NotImplementedError

    async def interrupt(self) -> None:
        raise RuntimeError("this Agent cannot interrupt a turn")

    async def close(self) -> None:
        return None

    async def set_model(self, model_id: str) -> None:
        raise RuntimeError("this Agent cannot switch models")

    async def set_mode(self, mode_id: str) -> None:
        raise RuntimeError("this Agent has no modes")

    async def set_effort(self, effort_id: str) -> None:
        raise RuntimeError(f"this Agent has no effort levels to set ({effort_id})")

    async def set_fast(self, fast: bool) -> None:
        if fast:
            raise RuntimeError("this Agent does not support fast mode")

    async def set_runtime_axis(self, axis_id: str, value_id: str) -> None:
        raise RuntimeError(f"this Agent has no runtime axis '{axis_id}' to set ({value_id})")

    async def respond(self, request_id: str, outcome: dict) -> None:
        raise RuntimeError("this Agent has no pending request to answer")

    async def fork(self, checkpoint: str) -> Any:
        raise RuntimeError("this Agent does not support forking")


class Agent:
    """One Agent directory. Subclass and override what applies."""

    async def start(self, ctx: AgentContext) -> None:
        """Called once after the daemon connects. Report a state here."""
        await self.refresh(ctx)

    async def refresh(self, ctx: AgentContext) -> None:
        ctx.set_state(ready=False, message="这个 Agent 没有实现 refresh")

    async def run_action(self, ctx: AgentContext, action: str, job: Job) -> None:
        raise RuntimeError(f"unknown action {action!r}")

    async def resume_action(self, ctx: AgentContext, action: str, step: str, job: Job) -> None:
        """Re-enter the action at its explicit checkpoint. Implementations
        with multiple steps must dispatch by step, rather than repeat earlier
        side effects. The default is suitable for a single initial question.
        """
        await self.run_action(ctx, action, job)

    async def open_session(self, ctx: SessionContext) -> Session:
        raise RuntimeError("this Agent cannot start sessions")

    async def import_list(self, ctx: AgentContext, cwd: str, limit: int) -> Optional[List[dict]]:
        return None

    async def import_show(self, ctx: AgentContext, cwd: str, source_id: str) -> dict:
        raise RuntimeError("this Agent does not support session import")

    async def shutdown(self, ctx: AgentContext) -> None:
        return None


# --------------------------------------------------------------------------
# The loop


async def _guard(coroutine: Awaitable[Any]) -> Any:
    try:
        return await coroutine
    except asyncio.CancelledError:
        raise
    except Exception:
        traceback.print_exc()
        return None


async def _detached(coroutine: Awaitable[Any]) -> Any:
    # Only ever the whole body of a task of its own: the task's context is a
    # copy, so this does not leak into whoever created it.
    _process.OWNER.set(None)
    return await _guard(coroutine)


async def _run_job(job: Job, work: Callable[[Job], Awaitable[None]]) -> None:
    # Jobs are Agent-level, whichever request or session started them.
    _process.OWNER.set("job:" + job.id)
    try:
        await work(job)
        job.done()
    except _SuspendedRequest as suspended:
        try:
            await _process.end_owned("job:" + job.id, verify=True)
            job.finished = True
            job._channel.notify("request.suspend", suspended.params)
        except Exception as error:
            traceback.print_exc()
            job.fail("未能确认停止子进程，待答记录已保留，未展示请求：" + str(error))
    except asyncio.CancelledError:
        job.fail("已取消")
        raise
    except Exception as error:  # noqa: BLE001 - every failure becomes the job's message
        traceback.print_exc()
        job.fail(str(error) or error.__class__.__name__)
    finally:
        await _process.end_owned("job:" + job.id)


class _Server:
    def __init__(self, agent: Agent) -> None:
        self.agent = agent
        self.ctx: Optional[AgentContext] = None
        self.sessions: Dict[str, Session] = {}
        # session.start still running, so a session.close can cancel it.
        self.opening: Dict[str, asyncio.Task] = {}
        # Openings a session.close / session.interrupt gave up on.
        self.abandoned: Set[asyncio.Task] = set()
        self.dispatching: Set[asyncio.Task] = set()
        self.channel: Optional[Channel] = None
        self.done: Optional[asyncio.Event] = None
        self.mask = _SecretMask(sys.stderr)
        sys.stderr = self.mask  # type: ignore[assignment]
        # boot.py points stdout at the log; a print() is masked too.
        sys.stdout = self.mask  # type: ignore[assignment]

    def on_message(self, message: dict) -> None:
        method = message.get("method")
        request_id = message.get("id")
        if not isinstance(method, str) or request_id is None:
            return
        task = asyncio.ensure_future(self.dispatch(request_id, method, message.get("params") or {}))
        self.dispatching.add(task)
        task.add_done_callback(self.dispatching.discard)

    def on_eof(self) -> None:
        if self.done is not None:
            self.done.set()

    async def dispatch(self, request_id: Any, method: str, params: dict) -> None:
        assert self.channel is not None
        if method.startswith("session.") and isinstance(params.get("sessionId"), str):
            # Everything this request starts — processes, background tasks —
            # belongs to that session.
            _process.OWNER.set(params["sessionId"])
        try:
            result = await self.handle(method, params)
            self.channel.reply(request_id, result)
        except NotImplementedError:
            self.channel.error(request_id, f"{method} is not implemented by this Agent")
        except Exception as error:  # noqa: BLE001 - the message is what the user sees
            traceback.print_exc()
            self.channel.error(request_id, str(error) or error.__class__.__name__)
        if method == "shutdown" and self.done is not None:
            self.done.set()

    def session(self, params: dict) -> Session:
        session = self.sessions.get(params.get("sessionId", ""))
        if session is None:
            raise RuntimeError(f"no such session: {params.get('sessionId')}")
        return session

    async def handle(self, method: str, params: dict) -> Any:
        agent = self.agent
        if method == "initialize":
            assert self.channel is not None
            self.ctx = AgentContext(self.channel, params, self.mask)
            self.ctx.spawn(agent.start(self.ctx))
            return {"protocol": 1}
        ctx = self.ctx
        if ctx is None:
            raise RuntimeError("initialize must come first")
        if method == "refresh":
            ctx.spawn(agent.refresh(ctx))
            return {}
        if method == "action.run":
            action = params.get("action", "")
            job = ctx._job(action)
            ctx._track(asyncio.ensure_future(_run_job(job, lambda job: agent.run_action(ctx, action, job))))
            return {"job": job.id}
        if method == "action.resume":
            action, step = params["action"], params["step"]
            job = Job(self.channel, params["job"], action, self.mask)
            job.step = step
            job.outcome = _outcome(params.get("outcome") or {})
            for qid in params.get("secretIds") or []:
                value = job.outcome.text.get(qid)
                if value:
                    self.mask.add(value)
            ctx._track(asyncio.ensure_future(_run_job(job, lambda job: agent.resume_action(ctx, action, step, job))))
            return {"job": job.id}
        if method == "request.prepared":
            waiting = ctx._preparing.get(params.get("id", ""))
            if waiting is not None and not waiting.done():
                if params.get("error"):
                    waiting.set_exception(RuntimeError(str(params["error"])))
                else:
                    waiting.set_result(None)
            return {}
        if method == "request.answer":
            ctx._answer(params.get("id", ""), params.get("outcome") or {})
            return {}
        if method == "session.start":
            session_id = params["sessionId"]
            config = SessionConfig.from_wire(session_id, params.get("config") or {})
            old = self.sessions.pop(session_id, None)
            if old is not None:
                await _guard(old.close())
            opening = asyncio.ensure_future(agent.open_session(SessionContext(ctx, config)))
            self.opening[session_id] = opening
            try:
                session: Optional[Session] = None
                try:
                    session = await opening
                except asyncio.CancelledError:
                    if opening not in self.abandoned:
                        raise  # this request itself was cancelled
                if opening in self.abandoned:
                    # Closed while starting — possibly after the start had
                    # already finished, so the Session exists and is ended here.
                    if session is not None:
                        await _guard(session.close())
                    await _process.end_owned(session_id, verify=True)
                    raise RuntimeError("会话在启动完成前就被关闭了")
            finally:
                self.abandoned.discard(opening)
                if self.opening.get(session_id) is opening:
                    del self.opening[session_id]
            assert session is not None
            self.sessions[session_id] = session
            return {}
        if method == "session.send":
            await self.session(params).send(params["turnId"], params.get("text", ""), params.get("attachments") or [])
            return {}
        if method == "session.interrupt":
            session_id = params.get("sessionId", "")
            opening = self.opening.get(session_id)
            if opening is not None and opening not in self.abandoned:
                # session.start has not returned, so there is no Session to
                # ask. Cancelling it runs the script's own cleanup, which is
                # what ends the CLI it already started.
                self.abandoned.add(opening)
                opening.cancel()
                try:
                    await opening
                except (asyncio.CancelledError, Exception):
                    pass
                await _process.end_owned(session_id, verify=True)
                return {}
            await self.session(params).interrupt()
            return {}
        if method == "session.close":
            session_id = params.get("sessionId", "")
            opening = self.opening.pop(session_id, None)
            if opening is not None:
                self.abandoned.add(opening)
                opening.cancel()
            session = self.sessions.pop(session_id, None)
            try:
                if session is not None:
                    await session.close()
            finally:
                await _process.end_owned(session_id, verify=True)
            return {}
        if method == "session.setModel":
            await self.session(params).set_model(params["modelId"])
            return {}
        if method == "session.setMode":
            await self.session(params).set_mode(params["modeId"])
            return {}
        if method == "session.setEffort":
            await self.session(params).set_effort(params["effortId"])
            return {}
        if method == "session.setFast":
            await self.session(params).set_fast(bool(params.get("fast")))
            return {}
        if method == "session.setRuntimeAxis":
            await self.session(params).set_runtime_axis(params["axisId"], params["valueId"])
            return {}
        if method == "session.respond":
            await self.session(params).respond(params["requestId"], params.get("outcome") or {})
            return {}
        if method == "session.fork":
            value = await self.session(params).fork(params.get("checkpoint", ""))
            return {"persist": value}
        if method == "import.list":
            candidates = await agent.import_list(ctx, params.get("cwd", ""), int(params.get("limit") or 50))
            return {"candidates": candidates}
        if method == "import.show":
            return await agent.import_show(ctx, params.get("cwd", ""), params["sourceId"])
        if method == "shutdown":
            for session in list(self.sessions.values()):
                await _guard(session.close())
            self.sessions.clear()
            await _guard(agent.shutdown(ctx))
            return {}
        raise LookupError(f"unknown method {method}")

    async def run(self) -> None:
        fds = _boot.PROTOCOL_FDS
        if fds is None:
            raise SystemExit("serve must be started through boot.py")
        loop = asyncio.get_event_loop()
        self.done = asyncio.Event()
        # The daemon ends this process with SIGTERM before SIGKILL. The CLIs it
        # started live in process groups of their own and would outlive it.
        if hasattr(signal, "SIGTERM") and not _process.WINDOWS:
            loop.add_signal_handler(signal.SIGTERM, self._terminated)
        _process.end_children_with_this_process()
        atexit.register(_process.end_all_now)
        self.channel = Channel(loop, fds[0], fds[1], self.on_message, self.on_eof)
        self.channel.start()
        await self.done.wait()
        for session in list(self.sessions.values()):
            await _guard(session.close())
        if self.ctx is not None:
            for task in list(self.ctx._background):
                task.cancel()
        for owner in list(_process._LIVE):
            await _process.end_owned(owner, verify=True)
        self.channel.close()

    def _terminated(self) -> None:
        _process.end_all_now()
        os._exit(0)


def serve(agent: Agent) -> None:
    """Entry point for ``agent.py``. Dispatches on the command boot.py was
    given: ``serve`` for the daemon, ``test`` for a person or an Agent."""
    command = _boot.COMMAND or ["serve"]
    if command[0] == "test":
        from .testing import run_tests

        sys.exit(run_tests(agent, live="--live" in command[1:]))
    if command[0] != "serve":
        sys.stderr.write(f"unknown command {command[0]!r}; expected serve or test\n")
        sys.exit(2)
    asyncio.run(_Server(agent).run())
