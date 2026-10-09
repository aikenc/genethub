"""A user-layer GeneHub script Agent whose behaviour a case chooses.

testctl copies this directory to ``<data>/agents/user/<id>/`` and writes
``control.json`` next to it before the daemon starts or before
``agent.reload``. The daemon reaches it exactly as it reaches the built-in
Codex or Cursor scripts: ``boot.py`` + the shipped SDK, one ``serve``
process for every session of this Agent. Nothing inside the daemon is
stubbed; what varies is only what a script (or the CLI behind it) is free to
do at the serve-protocol boundary (``docs/agent-serve-protocol.md``).

Each session owns one stand-in CLI child (``FAKE_CLI``), reported through
``session.pid`` the way a real script reports its CLI.

control.json:
  profile       see PROFILES below
  journal       absolute path; one JSON object per line, the only thing the
                case trusts about this process
  chunks        visible chunks a normal turn says (default 2)
  delayMs       held before a turn answers
  floods        events a flood-events turn emits (default 4000)
  processTree   on the first prompt, have the CLI start child/grandchild/sibling
  once          the profile's fault fires only once per state directory
  ignoreSigterm the serve process ignores SIGTERM / SIGINT / SIGHUP
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Any, List, Optional

from genehub_agent import Agent, Session, events, option, secret_question, text_question, serve
from genehub_agent import code as display_code
from genehub_agent import link as display_link
from genehub_agent import process as sdk_process
from genehub_agent import rpc as _rpc

PROFILES = (
    "normal",
    "cli-question",
    "provider-cli",
    "native-question",
    "native-plan",
    "exit-without-terminal",
    "grandchild-holds-stdio",
    "accept-then-silent",
    "burst-then-silent",
    "reasoning-ignore-interrupt",
    "ignore-interrupt",
    "ignore-set-model",
    "hang-session-new",
    "stdin-never-drains",
    "flood-events",
    "crash-on-start",
    "login",
    "requests",
    "durable",
)

# Actions the ``requests`` profile offers, each opening Agent-level requests
# a script is free to open: one it dies holding, ones over the kernel's size
# bounds, and more at once than the kernel keeps.
REQUEST_ACTIONS = ("crash-holding-request", "oversize-requests", "nine-requests")

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("GENEHUB_AGENT_STATE") or os.getcwd()


def _load_control() -> dict:
    try:
        with open(os.path.join(HERE, "control.json"), "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


CONTROL = _load_control()
PROFILE = str(CONTROL.get("profile") or "normal")
CHUNKS = int(CONTROL.get("chunks", 2))
DELAY_S = float(CONTROL.get("delayMs", 0)) / 1000.0
FLOODS = int(CONTROL.get("floods", 4000))
FAULT_MARKER = os.path.join(STATE, "fault-fired")


def journal(event: str, **extra: Any) -> None:
    """Synchronous append, so a profile that exits abruptly still leaves the
    line that explains why."""
    path = CONTROL.get("journal")
    if not path:
        return
    line = {"ts": int(time.time() * 1000), "pid": os.getpid(), "ppid": os.getppid(), "profile": PROFILE, "event": event}
    line.update(extra)
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line) + "\n")
    except OSError:
        pass


def fault_armed() -> bool:
    """With ``once``, the first process that fires the fault leaves a marker
    in its state directory; every later process behaves normally."""
    return not (CONTROL.get("once") and os.path.exists(FAULT_MARKER))


def fire_fault(name: str) -> None:
    if CONTROL.get("once"):
        with open(FAULT_MARKER, "w", encoding="utf-8") as handle:
            handle.write(name)
            handle.flush()
            os.fsync(handle.fileno())
    journal("fault", fault=name)


journal("start", argv=sys.argv[1:], agentDir=HERE)

if CONTROL.get("ignoreSigterm"):
    for _signal in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(_signal, lambda number, _frame: journal("signal-ignored", signal=number))

if PROFILE == "crash-on-start" and fault_armed():
    fire_fault("crash-on-start")
    journal("exit", code=3)
    os._exit(3)


# -- stdin-never-drains --------------------------------------------------------
#
# A script whose own process stops taking bytes off the protocol pipe. The SDK
# reads that pipe on a thread; this gate is the only change, and it is made
# here, in the Agent's own code, the way any script is free to misbehave.

READ_PAUSED = threading.Event()
BYTES_READ = [0]


class _Gate:
    def __init__(self, raw: Any) -> None:
        self._raw = raw

    def read(self, size: int) -> bytes:
        while READ_PAUSED.is_set():
            time.sleep(3600)
        chunk = self._raw.read(size)
        BYTES_READ[0] += len(chunk or b"")
        return chunk

    def __getattr__(self, name: str) -> Any:
        return getattr(self._raw, name)


if PROFILE == "stdin-never-drains":
    _start = _rpc.Channel.start

    def _gated_start(self: Any) -> None:
        self._reader = _Gate(self._reader)
        _start(self)

    _rpc.Channel.start = _gated_start  # type: ignore[assignment]


def stop_reading() -> None:
    READ_PAUSED.set()
    journal("stdin-paused", bytesRead=BYTES_READ[0])

    def sample() -> None:
        while True:
            journal("stdin-idle", bytesRead=BYTES_READ[0])
            time.sleep(1.0)

    threading.Thread(target=sample, name="stdin-idle", daemon=True).start()


# -- the stand-in CLI ----------------------------------------------------------

FAKE_CLI = r"""
import json, signal, subprocess, sys
# Reap what it starts, as a real CLI does; a zombie would still answer kill(0).
signal.signal(signal.SIGCHLD, signal.SIG_IGN)
LOOP = "import time\nwhile True: time.sleep(60)"
ROOT = ("import subprocess, sys, time\n"
        "leaf = subprocess.Popen([sys.executable, '-I', '-c', %r], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
        "print(leaf.pid, flush=True)\n"
        "while True: time.sleep(60)\n") % LOOP
quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for line in sys.stdin:
    if line.strip() == "tree":
        sibling = subprocess.Popen([sys.executable, "-I", "-c", LOOP], **quiet)
        root = subprocess.Popen([sys.executable, "-I", "-c", ROOT], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        leaf = int(root.stdout.readline())
        print(json.dumps({"rootPid": root.pid, "leafPid": leaf, "siblingPid": sibling.pid}), flush=True)
"""


class FakeCli:
    """One child per session, started through the SDK so that it is owned by
    the session request that started it: ended with that session, and with
    this process. It also exits on its own when its stdin reaches EOF."""

    def __init__(self, proc: Any) -> None:
        self.proc = proc

    @classmethod
    async def start(cls) -> "FakeCli":
        proc = await sdk_process.spawn(
            [sys.executable, "-I", "-c", FAKE_CLI],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        return cls(proc)

    @property
    def pid(self) -> int:
        return self.proc.pid

    async def tree(self) -> dict:
        self.proc.stdin.write(b"tree\n")
        await self.proc.stdin.drain()
        return json.loads(await self.proc.stdout.readline())

    async def stop(self) -> None:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            await asyncio.wait_for(self.proc.wait(), 5)
        except asyncio.TimeoutError:
            await sdk_process.kill_tree(self.proc)


CATALOG = {
    "models": [
        {"id": "fixture", "label": "Fixture", "reasoning": False, "efforts": [], "supportsFast": False},
        {"id": "fixture-alt", "label": "Fixture Alt", "reasoning": False, "efforts": [], "supportsFast": False},
    ],
    "modes": [],
    "commands": [],
    "defaultModel": "fixture",
}
CAPABILITIES = {"interrupt": True, "resume": True, "setModel": True}


class FixtureSession(Session):
    counter = 0

    def __init__(self, ctx: Any, agent: "FixtureAgent", cli: FakeCli) -> None:
        super().__init__(ctx)
        self.agent = agent
        resume = ctx.config.resume if isinstance(ctx.config.resume, dict) else None
        if resume and isinstance(resume.get("native"), str):
            self.native = resume["native"]
            journal("resumed", sessionId=self.native, genehubSession=ctx.session_id)
        else:
            FixtureSession.counter += 1
            self.native = "native-%d-%d" % (os.getpid(), FixtureSession.counter)
        ctx.set_persist({"native": self.native})
        self.cli = cli
        ctx.set_pid(self.cli.pid)
        journal("session-start", sessionId=self.native, genehubSession=ctx.session_id, cliPid=self.cli.pid)
        self.pending: Optional[str] = None
        self.task: Optional[asyncio.Task] = None

    # -- emit helpers ------------------------------------------------------

    def say(self, turn_id: str, item_id: str, text: str, first: bool) -> None:
        if first:
            self.ctx.emit(events.item(turn_id, events.assistant_message(item_id, text)))
        else:
            self.ctx.emit(events.text_delta(turn_id, item_id, text))

    def complete(self, turn_id: str, **extra: Any) -> None:
        self.pending = None
        self.ctx.emit(events.turn_completed(turn_id, CONTROL.get("usage")))
        journal("answered", turnId=turn_id, stopReason="end_turn", **extra)

    # -- Session -------------------------------------------------------------

    async def send(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        self.pending = turn_id
        journal("prompt", turnId=turn_id, bytes=len(text))
        self.task = asyncio.ensure_future(self.turn(turn_id, text))

    async def turn(self, turn_id: str, text: str) -> None:
        item = turn_id + "-reply"
        if CONTROL.get("processTree") and not self.agent.tree_started:
            self.agent.tree_started = True
            tree = await self.cli.tree()
            journal("tree-created", **tree)
        if DELAY_S > 0:
            await asyncio.sleep(DELAY_S)
        profile = PROFILE if fault_armed() else "normal"

        if profile == "provider-cli":
            fire_fault("provider-cli")
            extra = self.ctx.config.session_environment()
            command = extra.get("GENEHUB_CLI") or os.environ.get("GENEHUB_CLI")
            if not command:
                raise RuntimeError("no configured platform CLI")
            for argv in ([command, "context"], [command, "provider", "list"]):
                child = await sdk_process.spawn(argv, env=sdk_process.child_environment(extra), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                stdout, stderr = await child.communicate()
                journal("provider-discovery", code=child.returncode, result=stdout.decode("utf-8", "replace")[:6000])
            child = await sdk_process.spawn(
                [command, "provider", "configure", "fixture-provider", "--session", self.ctx.session_id,
                 "--action", "fixture-provider-action", "--base-url", CONTROL["providerBaseUrl"],
                 "--dialect", CONTROL.get("providerDialect", "anthropic"), "--label", "测试模型服务", "--model", "mock-llm"],
                env=sdk_process.child_environment(extra), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            journal("provider-cli", cliPid=child.pid)
            stdout, stderr = await child.communicate()
            journal("provider-cli-returned", code=child.returncode)
            return

        if profile == "cli-question":
            fire_fault("cli-question")
            extra = self.ctx.config.session_environment()
            command = extra.get("GENEHUB_CLI") or os.environ.get("GENEHUB_CLI")
            if not command:
                raise RuntimeError("no configured platform CLI")
            child = await sdk_process.spawn(
                [command, "session", "ask", self.ctx.session_id,
                 "--request-id", "fixture-conversation-question", "--title", "浏览器会话提问",
                 "--question", "请选择并输入补充信息", "--choice", "选项 A", "--choice", "选项 B"],
                env=sdk_process.child_environment(extra), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            journal("question-cli", cliPid=child.pid)
            stdout, stderr = await child.communicate()
            journal("question-cli-returned", code=child.returncode, result=(stdout + stderr).decode("utf-8", "replace")[:1000])
            if self.pending:
                self.ctx.emit(events.turn_failed(turn_id, "question CLI returned without stopping: " + (stdout + stderr).decode("utf-8", "replace")[:1000]))
            # A question saves and closes this execution, including this task.
            return

        if profile == "native-plan":
            if "The user rejected the interrupted plan" in text:
                journal("rejected-continuation", sessionId=self.native)
                self.say(turn_id, item, "native plan rejected", True)
                self.complete(turn_id)
            elif "The user approved the interrupted plan" in text:
                journal("approved-continuation", sessionId=self.native)
                self.say(turn_id, item, "native plan continued", True)
                self.complete(turn_id)
            else:
                self.ctx.emit(
                    events.permission_requested(
                        "native-plan-" + turn_id,
                        "Native Agent plan",
                        [
                            {"id": "accept", "label": "Accept", "kind": "allowOnce"},
                            {"id": "reject", "label": "Reject", "kind": "reject"},
                        ],
                        kind="planApproval",
                        detail="Report completion after Human approval",
                    )
                )
                journal("plan-request", sessionId=self.native)
            return

        if profile == "native-question":
            marker = os.path.join(STATE, "questions-" + self.native)
            try:
                with open(marker, "r") as handle:
                    issued = int(handle.read())
            except (OSError, ValueError):
                issued = 0
            answered = "The user answered the interrupted questions" in text
            if answered:
                journal("continuation-received", matched=(CONTROL.get("expectedResume") or "") in text)
            if issued < int(CONTROL.get("questionCount", 1)) and (issued == 0 or answered):
                with open(marker, "w") as handle:
                    handle.write(str(issued + 1))
                if CONTROL.get("usage"):
                    self.ctx.emit(events.turn_progress(turn_id, CONTROL["usage"]))
                self.ctx.emit(events.permission_requested(
                    "native-question-" + str(issued + 1), "对话问题 " + str(issued + 1), [], kind="question",
                    questions=[{"id": "choice", "prompt": "请选择并填写补充内容",
                                "allowFreeform": True, "allowMultiple": False,
                                "options": [{"id": "a", "label": "选项 A"}, {"id": "b", "label": "选项 B"}]}]))
                journal("question-issued", index=issued + 1)
                return
            self.say(turn_id, item, "question task completed" if answered else "consultation completed", True)
            self.complete(turn_id)
            return

        if profile in ("normal", "login", "crash-on-start", "hang-session-new", "ignore-set-model"):
            if CONTROL.get("expectedResume"):
                journal("continuation-received", matched=CONTROL["expectedResume"] in text)
            for index in range(CHUNKS):
                self.say(turn_id, item, "chunk-%d " % index, index == 0)
            self.complete(turn_id)
            return

        if profile == "exit-without-terminal":
            fire_fault("exit-without-terminal")
            self.say(turn_id, item, "partial ", True)
            journal("exit", code=0)
            os._exit(0)

        if profile == "grandchild-holds-stdio":
            # What an npm/.cmd shim does: start the real program inheriting
            # every descriptor it may, then exit. The grandchild outlives this
            # process and holds whatever pipes it was handed.
            fire_fault("grandchild-holds-stdio")
            self.say(turn_id, item, "partial ", True)
            orphan = subprocess.Popen(
                [sys.executable, "-I", "-c", "import time\nwhile True: time.sleep(60)"],
                close_fds=False,
            )
            journal("orphan-spawned", orphanPid=orphan.pid)
            journal("exit", code=0)
            os._exit(0)

        if profile == "accept-then-silent":
            self.say(turn_id, item, "thinking ", True)
            journal("went-silent", turnId=turn_id)
            return

        if profile == "burst-then-silent":
            self.say(turn_id, item, "checkpoint-prefix ", True)
            await asyncio.sleep(0.15)
            self.say(turn_id, item, "checkpoint-tail ", False)
            journal("went-silent", turnId=turn_id)
            return

        if profile == "reasoning-ignore-interrupt":
            # Streamed like a real CLI's thought chunks, so its tail is still
            # pending when the turn is forced to stop.
            thought = turn_id + "-thought"
            self.ctx.emit(events.turn_progress(turn_id, events.usage(llm_rounds=1)))
            self.ctx.emit(events.item(turn_id, events.reasoning(thought, "Reasoning overview. ")))
            self.ctx.emit(events.text_delta(turn_id, thought, "source detail " * 512 + "final-reasoning-marker"))
            journal("went-silent", turnId=turn_id)
            return

        if profile in ("ignore-interrupt", "stdin-never-drains"):
            journal("went-silent", turnId=turn_id)
            return

        if profile == "flood-events":
            for index in range(FLOODS):
                self.say(turn_id, item, "f%d " % index, index == 0)
            self.complete(turn_id, floods=FLOODS)
            return

        self.complete(turn_id)

    async def interrupt(self) -> None:
        journal("cancel", pending=self.pending)
        profile = PROFILE if fault_armed() else "normal"
        if profile in ("ignore-interrupt", "reasoning-ignore-interrupt"):
            if profile == "ignore-interrupt":
                fire_fault("ignore-interrupt")
            journal("cancel-ignored")
            # Neither the turn nor this request is ever answered.
            await asyncio.Event().wait()
        if self.task is not None and not self.task.done():
            self.task.cancel()
        turn = self.pending
        if turn is None:
            return
        self.pending = None
        if profile == "native-plan":
            journal("plan-cancellation", sessionId=self.native, result={"outcome": {"outcome": "cancelled"}})
        self.ctx.emit(events.turn_canceled(turn))
        journal("answered", turnId=turn, stopReason="cancelled")

    async def set_model(self, model_id: str) -> None:
        if PROFILE == "ignore-set-model" and fault_armed():
            fire_fault("ignore-set-model")
            journal("set-model-ignored", modelId=model_id)
            await asyncio.Event().wait()
        journal("set-model", modelId=model_id)

    async def close(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()
        await self.cli.stop()
        journal("session-closed", sessionId=self.native)


class FixtureAgent(Agent):
    def __init__(self) -> None:
        self.tree_started = False
        self.withheld: List[FakeCli] = []

    def login_marker(self) -> str:
        return os.path.join(STATE, "login.sha256")

    async def start(self, ctx: Any) -> None:
        if CONTROL.get("ignoreSigterm"):
            # Replaces the SDK's own SIGTERM handler, which the serve loop
            # installs after this module ran: this script refuses to die politely.
            asyncio.get_event_loop().add_signal_handler(
                signal.SIGTERM, lambda: journal("signal-ignored", signal=int(signal.SIGTERM))
            )
        journal("initialized", agentId=ctx.agent_id, stateDir=ctx.state_dir)
        await self.refresh(ctx)

    async def refresh(self, ctx: Any) -> None:
        journal("refresh")
        if PROFILE == "login" and not os.path.exists(self.login_marker()):
            ctx.set_state(
                ready=False,
                message="fixture: not logged in",
                version="1.0.0",
                actions=[ctx.action("login", "登录", primary=True)],
                capabilities=CAPABILITIES,
                catalog=CATALOG,
            )
            return
        actions = [ctx.action("noop", "Noop")]
        if PROFILE == "durable":
            actions += [ctx.action("login", "Login"), ctx.action("uncertain", "Uncertain"), ctx.action("prepare-crash", "Prepare crash")]
        if PROFILE == "requests":
            actions += [ctx.action(name, name) for name in REQUEST_ACTIONS]
        ctx.set_state(
            ready=True,
            message="fixture: " + PROFILE,
            version="1.0.0",
            actions=actions,
            capabilities=CAPABILITIES,
            catalog=CATALOG,
        )

    async def run_action(self, ctx: Any, action: str, job: Any) -> None:
        journal("action", action=action, job=job.id)
        job.log("fixture-private-cli-output")
        if PROFILE == "durable" and action in ("login", "uncertain", "prepare-crash"):
            if job.step is None:
                grandchild = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(3600)"
                root = ("import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-I','-c',%r], "
                        "stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL); "
                        "p.stdout.readline();print(p.pid,flush=True);time.sleep(3600)") % grandchild
                child = await sdk_process.spawn([sys.executable, "-I", "-c", root], stdout=subprocess.PIPE)
                leaf = int(await child.stdout.readline())
                journal("job-child", childPid=child.pid, grandchildPid=leaf)
            try:
                outcome = await ctx.ask(job, "save", "Durable login", questions=[secret_question("token", "API Key"), text_question("note", "Note")],
                                        options=[option("ok", "Save"), option("cancel", "Cancel")])
            finally:
                journal("job-unwound", job=job.id)
                if action == "prepare-crash":
                    os._exit(74)
            if outcome.canceled or outcome.option_id == "cancel":
                job.done("Canceled")
                return
            secret = outcome.value("token") or ""
            # Independent, durable external-effect receipt. Neither this
            # file nor the journal records the credential itself.
            with open(os.path.join(STATE, "receipts.jsonl"), "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"job": job.id, "sha256": hashlib.sha256(secret.encode()).hexdigest()}) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            ctx.log("received: " + secret)
            if action == "uncertain":
                os._exit(73)
            job.done("Saved")
            return
        if action == "noop":
            return
        if PROFILE == "requests" and action in REQUEST_ACTIONS:
            await self.open_requests(ctx, action)
            return
        if action != "login":
            raise RuntimeError("unknown action " + action)
        job.progress(phase="prepare", message="preparing login", percent=10)
        job.log("fixture-login: step 1 of 2")
        job.progress(phase="waiting", message="waiting for a person", percent=50)
        job.log("fixture-login: step 2 of 2")
        outcome = await ctx.request(
            "Log in to Fixture",
            detail="Paste the API key.",
            display=[display_link("https://example.invalid/login", label="open"), display_code("ABCD-1234")],
            questions=[secret_question("token", "API Key")],
            options=[option("ok", "Save"), option("cancel", "Cancel")],
        )
        if outcome.canceled or outcome.option_id != "ok":
            journal("login-canceled")
            raise RuntimeError("login canceled")
        secret = outcome.value("token") or ""
        # Deliberately printed: the SDK must mask a secret answer on its way
        # to stderr, which is what `agent.logs` shows.
        ctx.log("fixture-login: received token " + secret)
        digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()
        with open(self.login_marker(), "w", encoding="utf-8") as handle:
            handle.write(digest)
        journal("login-stored")
        job.progress(phase="done", message="logged in", percent=100)
        await self.refresh(ctx)

    async def open_requests(self, ctx: Any, action: str) -> None:
        if action == "crash-holding-request":
            handle = ctx.open_request("fixture: held at crash", options=[option("ok", "OK")])
            journal("request-opened", requestId=handle.id, title="fixture: held at crash")
            # Dies only once the case says the request reached a person.
            marker = os.path.join(STATE, "crash-now")
            while not os.path.exists(marker):
                await asyncio.sleep(0.05)
            journal("exit", code=5)
            os._exit(5)
        if action == "oversize-requests":
            oversized = {
                "detail": dict(detail="d" * 2049),
                "title": dict(),
                "qr": dict(display=[display_link("https://example.invalid/" + "q" * 1024, label="open", render="qr")]),
            }
            for name, extra in oversized.items():
                title = "t" * 201 if name == "title" else "fixture: oversize " + name
                handle = ctx.open_request(title, options=[option("ok", "OK")], **extra)
                journal("request-opened", requestId=handle.id, title=title[:60], oversize=name)
            # In order after the others: once this one is shown, the daemon
            # has read every request above.
            sentinel = ctx.open_request("fixture: sentinel", options=[option("ok", "OK")])
            journal("request-opened", requestId=sentinel.id, title="fixture: sentinel")
            await sentinel.wait()
            return
        handles = []
        for index in range(1, 10):
            title = f"fixture: request {index}"
            handles.append(ctx.open_request(title, options=[option("ok", "OK")]))
            journal("request-opened", requestId=handles[-1].id, title=title)
        await handles[0].wait()

    async def open_session(self, ctx: Any) -> Session:
        if PROFILE == "hang-session-new" and fault_armed():
            # The CLI is up; its handshake never completes. Cancelling this
            # start (the user pressed stop) has to take that CLI with it.
            cli = await FakeCli.start()
            self.withheld.append(cli)
            ctx.set_pid(cli.pid)
            journal("withholding-session-new", genehubSession=ctx.session_id, cliPid=cli.pid)
            try:
                await asyncio.Event().wait()
            finally:
                await cli.stop()
        session = FixtureSession(ctx, self, await FakeCli.start())
        if PROFILE == "stdin-never-drains":
            # The session exists; from the next chunk on nothing is read, so
            # the first prompt larger than the pipe leaves the daemon's write
            # blocked mid-frame.
            stop_reading()
        return session

    async def shutdown(self, ctx: Any) -> None:
        journal("shutdown")


serve(FixtureAgent())
