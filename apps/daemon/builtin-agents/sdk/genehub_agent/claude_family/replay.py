"""Offline checks behind ``boot.py <agent> test`` for a Claude-protocol Agent.

Every ``tests/*.json`` case has a ``kind``:

``translate``  recorded CLI frames through ``translate``, no process
``catalog``    a recorded ``initialize`` answer and ``--help`` text
``args``       the command line a session process gets
``content``    the content blocks of a user frame
``history``    project keys and session-file import under a temporary config dir
``initialize`` ``catalog.initialize`` and the Agent's own state against a fake CLI
``session``    a real ``FamilySession`` driving ``fakecli.py``
``keycheck``   the real model-list check against a local HTTP server

Expected values are subsets (see ``testing.subset``).
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import tempfile
from typing import Any, Dict, List, Optional

from .. import events, keycheck
from ..serve import SessionConfig
from ..testing import assistant_texts, subset
from . import catalog, history, translate
from .flavor import Flavor, managed_bin_for
from .session import FamilySession, Launch, launch_args, user_content

HERE = os.path.dirname(os.path.abspath(__file__))
TERMINAL = ("turnCompleted", "turnFailed", "turnCanceled")


def _without_noise(emitted: List[dict], keep_deltas: bool = False) -> List[dict]:
    dropped = {"turnProgress"} | (set() if keep_deltas else {"itemDelta"})
    return [event for event in emitted if event.get("type") not in dropped]


# -- translate ----------------------------------------------------------------------------


def feed(frame: dict, state: Optional[translate.TurnState], emit: Any, label: str) -> Optional[str]:
    kind = frame.get("type")
    if kind == "system":
        return translate.translate_system(frame, state, emit)
    if state is None:
        return None
    if kind == "stream_event":
        translate.translate_stream_event(frame, state, emit)
    elif kind == "assistant":
        translate.translate_assistant(frame, state, emit)
    elif kind == "user":
        translate.translate_user(frame, state, emit)
    elif kind == "result":
        translate.translate_result(frame, state, emit, label)
    return None


def run_translate(case: dict, flavor: Flavor) -> Optional[str]:
    state = translate.TurnState(case.get("turnId", "turn_1"))
    state.interrupt_requested = bool(case.get("interruptRequested"))
    emitted: List[dict] = []
    session_id = None
    for frame in case["frames"]:
        found = feed(frame, state, emitted.append, flavor.label)
        session_id = found or session_id
    expect = case["expect"]
    checks = [
        ("events", _without_noise(emitted)),
        ("allEvents", emitted),
        ("assistantTexts", assistant_texts(emitted)),
        ("sessionId", session_id),
    ]
    for key, actual in checks:
        if key in expect:
            problem = subset(expect[key], actual, key)
            if problem:
                return problem
    if "progressEvents" in expect:
        count = sum(1 for event in emitted if event.get("type") == "turnProgress")
        if count != expect["progressEvents"]:
            return f"progressEvents: expected {expect['progressEvents']}, got {count}"
    if "terminal" in expect:
        last = [event for event in emitted if event.get("type") in TERMINAL]
        if len(last) != 1:
            return f"terminal: expected exactly one terminal event, got {len(last)}"
        return subset(expect["terminal"], last[0], "terminal")
    return None


# -- catalog / args / content --------------------------------------------------------------


def run_catalog(case: dict, flavor: Flavor) -> Optional[str]:
    hello = case.get("hello")
    help_text = case.get("help", "")
    built = catalog.build_catalog(hello, help_text)
    if "catalog" in case.get("expect", {}):
        problem = subset(case["expect"]["catalog"], built, "catalog")
        if problem:
            return problem
    if "ids" in case.get("expect", {}):
        got = {key: [entry.get("id") or entry.get("name") for entry in built[key]] for key in ("models", "modes", "commands")}
        problem = subset(case["expect"]["ids"], got, "ids")
        if problem:
            return problem
    for entry in case.get("initialMode", []):
        got = catalog.initial_permission_mode(entry.get("requested"), help_text)
        if got != entry["expect"]:
            return f"initial_permission_mode({entry.get('requested')!r}) = {got!r}, expected {entry['expect']!r}"
    return None


def run_args(case: dict, flavor: Flavor) -> Optional[str]:
    for entry in case["launches"]:
        spec = entry.get("launch", {})
        launch = Launch(program="/bin/cli", help_text=spec.get("help", ""), models=spec.get("models", []), efforts=spec.get("efforts", []))
        got = launch_args(
            flavor,
            launch,
            mode=entry["mode"],
            model=entry.get("model"),
            effort=entry.get("effort"),
            guidance=entry.get("guidance"),
            resume=entry.get("resume"),
        )
        for needle in entry.get("has", []):
            window = needle if isinstance(needle, list) else [needle]
            if not any(got[i : i + len(window)] == window for i in range(len(got))):
                return f"argv {got} lacks {window}"
        for needle in entry.get("lacks", []):
            if needle in got:
                return f"argv {got} should not contain {needle!r}"
        if "exact" in entry and got != entry["exact"]:
            return f"argv {got}, expected {entry['exact']}"
    return None


def run_content(case: dict, flavor: Flavor) -> Optional[str]:
    with tempfile.TemporaryDirectory() as scratch:
        blocks = user_content(case["text"], case.get("attachments", []), scratch)
        problem = subset(case["expect"]["blocks"], blocks, "blocks")
        if problem:
            return problem
        for needle in case["expect"].get("textContains", []):
            if needle not in blocks[0]["text"]:
                return f"text lacks {needle!r}"
        if case["expect"].get("spilledFiles"):
            spilled = os.listdir(os.path.join(scratch, "attachments"))
            if len(spilled) != case["expect"]["spilledFiles"]:
                return f"expected {case['expect']['spilledFiles']} spilled files, found {spilled}"
    return None


# -- history ------------------------------------------------------------------------------------


def run_history(case: dict, flavor: Flavor) -> Optional[str]:
    for text, key in case.get("claudeKeys", []):
        got = history.claude_project_key(text)
        if got != key and not (isinstance(key, str) and key.startswith("<prefix>") and got.startswith(key[len("<prefix>") :])):
            return f"claude_project_key({text!r}) = {got!r}, expected {key!r}"
    for text, key in case.get("codebuddyKeys", []):
        got = history.codebuddy_project_key(text)
        if got != key and not (isinstance(key, str) and key.startswith("<prefix>") and got.startswith(key[len("<prefix>") :])):
            return f"codebuddy_project_key({text!r}) = {got!r}, expected {key!r}"
    sessions = case.get("sessions")
    if sessions is None:
        return None
    with tempfile.TemporaryDirectory() as config, tempfile.TemporaryDirectory() as workspace:
        before = os.environ.get(flavor.config_dir_env)
        os.environ[flavor.config_dir_env] = config
        try:
            directory = history.project_dir(flavor, workspace)
            os.makedirs(directory)
            for index, session in enumerate(sessions):
                path = os.path.join(directory, session["id"] + ".jsonl")
                with open(path, "w", encoding="utf-8") as handle:
                    for line in session["lines"]:
                        handle.write((line if isinstance(line, str) else json.dumps(line)) + "\n")
                os.utime(path, (1000 + index, 1000 + index))
            listed = history.list_candidates(flavor, workspace, case.get("limit", 10))
            if "list" in case["expect"]:
                problem = subset(case["expect"]["list"], listed, "list")
                if problem:
                    return problem
            for source_id, want in case["expect"].get("show", {}).items():
                shown = history.show(flavor, workspace, source_id)
                for item in shown["items"]:
                    item.pop("id", None)
                problem = subset(want, shown, f"show[{source_id}]")
                if problem:
                    return problem
            for bad in case["expect"].get("rejected", []):
                try:
                    history.show(flavor, workspace, bad)
                except RuntimeError:
                    continue
                return f"show({bad!r}) should have been rejected"
        finally:
            if before is None:
                os.environ.pop(flavor.config_dir_env, None)
            else:
                os.environ[flavor.config_dir_env] = before
    return None


# -- a fake CLI ----------------------------------------------------------------------------------


class Fake:
    """A script file, a log file and an executable that runs ``fakecli.py``."""

    def __init__(self, script: dict, directory: Optional[str] = None, name: str = "fake-cli") -> None:
        self.work = tempfile.mkdtemp(prefix="genehub-fake-cli-")
        if directory:
            os.makedirs(directory, exist_ok=True)
        self.directory = self.work
        self.script_path = os.path.join(self.directory, "script.json")
        self.log_path = os.path.join(self.directory, "log.jsonl")
        self.program = os.path.join(directory or self.directory, name)
        with open(self.script_path, "w", encoding="utf-8") as handle:
            json.dump(script, handle)
        with open(self.log_path, "w", encoding="utf-8"):
            pass
        with open(self.program, "w", encoding="utf-8") as handle:
            handle.write(f'#!/bin/sh\nexec "{sys.executable}" "{os.path.join(HERE, "fakecli.py")}" "$@"\n')
        os.chmod(self.program, os.stat(self.program).st_mode | stat.S_IXUSR)
        os.environ["FAKE_CLI_SCRIPT"] = self.script_path
        os.environ["FAKE_CLI_LOG"] = self.log_path

    def stdin_lines(self) -> List[str]:
        return [entry["stdin"] for entry in self.log() if "stdin" in entry]

    def log(self) -> List[dict]:
        with open(self.log_path, "r", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def runs(self) -> List[List[str]]:
        return [entry["argv"] for entry in self.log() if "argv" in entry]

    def received(self, types: List[str]) -> List[dict]:
        return [entry["in"] for entry in self.log() if "in" in entry and entry["in"].get("type") in types]

    def close(self) -> None:
        os.environ.pop("FAKE_CLI_SCRIPT", None)
        os.environ.pop("FAKE_CLI_LOG", None)


def run_initialize(case: dict, flavor: Flavor) -> Optional[str]:
    if os.name == "nt":
        return None
    fake = Fake(case["cli"])
    try:
        answer = asyncio.new_event_loop().run_until_complete(
            catalog.initialize(fake.program, flavor, dict(os.environ), tempfile.gettempdir(), timeout=case.get("timeout", 10.0))
        )
        if "answer" in case["expect"]:
            problem = subset(case["expect"]["answer"], answer, "answer")
            if problem:
                return problem
        elif answer is not None:
            return f"expected no answer, got {answer}"
        argv = (fake.runs() or [[]])[0]
        for needle in case["expect"].get("argvHas", []):
            if needle not in argv:
                return f"initialize argv {argv} lacks {needle!r}"
        for needle in case["expect"].get("argvLacks", []):
            if needle in argv:
                return f"initialize argv {argv} should not contain {needle!r}"
    finally:
        fake.close()
    return None


# -- session --------------------------------------------------------------------------------------


class _StubAgent:
    def __init__(self, launch: Launch) -> None:
        self.launch = launch
        self.spawned: List[Any] = []
        self.logged: List[str] = []

    def spawn(self, coroutine: Any) -> "asyncio.Future":
        future = asyncio.ensure_future(coroutine)
        self.spawned.append(future)
        return future

    def log(self, message: str) -> None:
        self.logged.append(message)

    async def prepare_launch(self) -> Launch:
        return self.launch

    def forget(self, session: Any) -> None:
        return None


class _StubContext:
    def __init__(self, config: SessionConfig, agent: _StubAgent) -> None:
        self.config = config
        self.agent = agent
        self.session_id = config.session_id
        self.emitted: List[dict] = []
        self.persisted: List[Any] = []
        self.pids: List[Optional[int]] = []

    def emit(self, event: dict) -> None:
        self.emitted.append(event)

    def set_persist(self, value: Any) -> None:
        self.config.resume = value
        self.persisted.append(value)

    def set_pid(self, pid: Optional[int]) -> None:
        self.pids.append(pid)


async def _wait(predicate: Any, what: str, timeout: float = 15.0) -> None:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise RuntimeError(f"timed out waiting for {what}")
        await asyncio.sleep(0.02)


async def _drive(case: dict, flavor: Flavor, fake: Fake, workspace: str) -> Dict[str, Any]:
    spec = case.get("launch", {})
    launch = Launch(
        program=fake.program,
        help_text=spec.get("help", ""),
        models=spec.get("models", []),
        efforts=spec.get("efforts", []),
        default_model=spec.get("defaultModel"),
        env={},
    )
    config = SessionConfig.from_wire("s1", {"cwd": workspace, "scratchDir": os.path.join(workspace, "scratch"), **case.get("config", {})})
    agent = _StubAgent(launch)
    ctx = _StubContext(config, agent)
    session = FamilySession(ctx, agent, flavor, launch)  # type: ignore[arg-type]
    errors: Dict[int, str] = {}
    try:
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        for index, step in enumerate(case["steps"]):
            try:
                await _step(session, ctx, step, index)
            except RuntimeError as error:
                if "expectError" not in step:
                    raise RuntimeError(f"step {index} {json.dumps(step, ensure_ascii=False)[:120]}: {error}") from error
                errors[index] = str(error)
    finally:
        await session.close()
        for future in agent.spawned:
            future.cancel()
    return {"ctx": ctx, "agent": agent, "session": session, "errors": errors}


async def _step(session: FamilySession, ctx: _StubContext, step: dict, index: int) -> None:
    def terminals() -> int:
        return sum(1 for event in ctx.emitted if event.get("type") in TERMINAL)

    if "send" in step:
        before = terminals()
        step["_before"] = before
        await session.send(step.get("turnId", f"turn_{index}"), step["send"], step.get("attachments", []))
        if step.get("wait", True):
            await _wait(lambda: terminals() > before, "the turn to end")
    elif "waitFor" in step:
        await _wait(lambda: any(event.get("type") == step["waitFor"] for event in ctx.emitted), step["waitFor"])
    elif "waitTerminal" in step:
        count = step["waitTerminal"] if isinstance(step["waitTerminal"], int) else 1
        await _wait(lambda: terminals() >= count, "a terminal event")
    elif "respond" in step:
        asks = [event for event in ctx.emitted if event.get("type") == "permissionRequested"]
        request_id = step.get("requestId") or asks[-1]["request"]["id"]
        await session.respond(request_id, step["respond"])
    elif "setModel" in step:
        await session.set_model(step["setModel"])
    elif "setEffort" in step:
        await session.set_effort(step["setEffort"])
    elif "setMode" in step:
        await session.set_mode(step["setMode"])
    elif "interrupt" in step:
        await session.interrupt()
    elif "sleep" in step:
        await asyncio.sleep(step["sleep"])
    elif "recycle" in step:
        session.recycle_when_idle()
        await asyncio.sleep(0.2)
    else:
        raise RuntimeError(f"unknown step {step}")
    if "expectError" in step:
        raise RuntimeError("expected this step to fail")


def run_session(case: dict, flavor: Flavor) -> Optional[str]:
    if os.name == "nt":
        return None
    import genehub_agent.claude_family.session as session_module

    original = (session_module.INTERRUPT_GRACE, session_module.CONTROL_TIMEOUT)
    session_module.INTERRUPT_GRACE = case.get("interruptGrace", original[0])
    session_module.CONTROL_TIMEOUT = case.get("controlTimeout", original[1])
    fake = Fake(case["cli"])
    workspace = tempfile.mkdtemp(prefix="genehub-fake-ws-")
    try:
        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(asyncio.wait_for(_drive(case, flavor, fake, workspace), case.get("timeout", 60.0)))
        except RuntimeError as error:
            return str(error)
        finally:
            loop.close()
        ctx: _StubContext = result["ctx"]
        if os.environ.get("GENEHUB_REPLAY_DUMP"):
            sys.stderr.write("--- events\n" + "\n".join(json.dumps(event, ensure_ascii=False) for event in ctx.emitted) + "\n--- received\n" + "\n".join(json.dumps(item, ensure_ascii=False) for item in fake.received(["user", "control_request", "control_response"])) + "\n--- runs\n" + "\n".join(json.dumps(item) for item in fake.runs()) + "\n")
        # A step that was expected to fail must have failed with its message.
        for index, step in enumerate(case["steps"]):
            if "expectError" in step:
                got = result["errors"].get(index)
                if got is None:
                    return f"step {index} should have failed"
                if step["expectError"] not in got:
                    return f"step {index} failed with {got!r}, expected it to contain {step['expectError']!r}"
        expect = case.get("expect", {})
        if "events" in expect:
            problem = subset(expect["events"], _without_noise(ctx.emitted), "events")
            if problem:
                return problem
        if "types" in expect:
            problem = subset(expect["types"], [event.get("type") for event in _without_noise(ctx.emitted, True) if event.get("type") != "itemDelta" or expect.get("withDeltas")], "types")
            if problem:
                return problem
        if "terminals" in expect:
            got = [event for event in ctx.emitted if event.get("type") in TERMINAL]
            problem = subset(expect["terminals"], got, "terminals")
            if problem:
                return problem
        if "asked" in expect:
            asked = [event for event in ctx.emitted if event.get("type") in ("permissionRequested", "permissionResolved")]
            problem = subset(expect["asked"], asked, "asked")
            if problem:
                return problem
        if "received" in expect:
            received = fake.received(case.get("receivedTypes", ["user", "control_request", "control_response"]))
            problem = subset(expect["received"], received, "received")
            if problem:
                return problem
        if "runs" in expect:
            problem = _check_runs(expect["runs"], fake.runs())
            if problem:
                return problem
        if "persist" in expect:
            problem = subset(expect["persist"], ctx.persisted, "persist")
            if problem:
                return problem
        if "sessionState" in expect:
            session = result["session"]
            actual = {"modelId": session.model_id, "effortId": session.effort_id, "mode": session.mode, "sessionId": session.session_id}
            problem = subset(expect["sessionState"], actual, "sessionState")
            if problem:
                return problem
        if "logged" in expect:
            for needle in expect["logged"]:
                if not any(needle in line for line in result["agent"].logged):
                    return f"the log lacks {needle!r}"
        return None
    finally:
        session_module.INTERRUPT_GRACE, session_module.CONTROL_TIMEOUT = original
        fake.close()


def _check_runs(expect: List[dict], runs: List[List[str]]) -> Optional[str]:
    if len(runs) != len(expect):
        return f"runs: expected {len(expect)} process starts, got {len(runs)}"
    for index, (want, argv) in enumerate(zip(expect, runs)):
        for needle in want.get("has", []):
            window = needle if isinstance(needle, list) else [needle]
            if not any(argv[i : i + len(window)] == window for i in range(len(argv))):
                return f"run {index}: argv {argv} lacks {window}"
        for needle in want.get("lacks", []):
            if needle in argv:
                return f"run {index}: argv {argv} should not contain {needle!r}"
    return None


# -- the Agent's own flows ------------------------------------------------------------------------

CREDENTIAL_VARIABLES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEBUDDY_API_KEY",
    "CODEBUDDY_INTERNET_ENVIRONMENT",
)


def _verdict(spec: dict) -> keycheck.Verdict:
    return keycheck.Verdict(spec["status"], spec.get("detail", ""))


class _World:
    """A throwaway state directory, a fake CLI (and optionally a fake npm that
    installs it) and the environment variables a flow may touch."""

    def __init__(self, case: dict, flavor: Flavor, agent_cls: Any) -> None:
        from .. import install
        from ..testing import scratch_context

        self.flavor = flavor
        self.saved_env = dict(os.environ)
        for name in CREDENTIAL_VARIABLES:
            os.environ.pop(name, None)
        os.environ["HOME"] = tempfile.mkdtemp(prefix="genehub-fake-home-")
        for name in ("CLAUDE_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"):
            os.environ.pop(name, None)
        self.install = install
        # The service's answer to "do you know this key?" and what was asked.
        self.key_verdict = _verdict(case.get("keyCheck") or {"status": "ok"})
        self.key_urls: List[str] = []
        # Keys the service rejects whatever the general answer is.
        self.reject_keys: List[str] = list(case.get("rejectKeys") or [])
        self._real_fetch = keycheck.fetch
        world = self

        async def fetch(url: str, headers: Any, timeout: float = 0) -> keycheck.Verdict:
            world.key_urls.append(url)
            sent = {value.replace("Bearer ", "") for value in headers.values()}
            if sent & set(world.reject_keys):
                return keycheck.Verdict(keycheck.REJECTED, "服务拒绝了这个 API Key（HTTP 401）")
            return world.key_verdict

        keycheck.fetch = fetch  # type: ignore[assignment]
        self.ctx, self.channel, _ = scratch_context(flavor.id)
        self.agent = agent_cls()
        bin_dir = install.npm_bin_dir(self.ctx)
        name = flavor.binaries[0]
        staging = None if case.get("installed", True) else tempfile.mkdtemp(prefix="genehub-fake-stage-")
        self.fake = Fake(case["cli"], directory=staging or bin_dir, name=name)
        npm_dir = tempfile.mkdtemp(prefix="genehub-fake-npm-")
        self.fake_npm = os.path.join(npm_dir, "npm")
        # `npm install -g --prefix P <package>[@version]` puts the fake CLI in
        # P/bin and remembers the version asked for; `npm view` knows the latest.
        with open(self.fake_npm, "w", encoding="utf-8") as handle:
            handle.write(
                "#!/bin/sh\n"
                'case "$1" in\n'
                "  install)\n"
                f'    mkdir -p "$4/bin" && cp "{self.fake.program}" "$4/bin/{name}" 2>/dev/null\n'
                '    case "$5" in\n'
                '      @*@*) echo "${5##*@}" > "$FAKE_CLI_LOG.version" ;;\n'
                '      @*) ;;\n'
                '      *@*) echo "${5##*@}" > "$FAKE_CLI_LOG.version" ;;\n'
                "    esac ;;\n"
                f'  view) echo "{case["cli"].get("latest", "9.9.9")}" ;;\n'
                "esac\n"
                "exit 0\n"
            )
        os.chmod(self.fake_npm, 0o755)
        # Only GeneHub's own prefix is looked in (plus, for an install that is
        # not GeneHub's, the one fake CLI): a real install on this machine
        # must not be found.
        managed = bin_dir
        external = self.fake.program if staging and case.get("external") else None
        self.agent.find_program = lambda: managed_bin_for(managed, name) or external  # type: ignore[method-assign]
        self.agent._maybe_auto_update = _noop  # type: ignore[method-assign]
        self._real_find_npm = install.find_npm
        npm = self.fake_npm

        async def find_npm() -> Optional[str]:
            return npm

        install.find_npm = find_npm  # type: ignore[assignment]

    def close(self) -> None:
        from .. import credentials, space

        keycheck.fetch = self._real_fetch  # type: ignore[assignment]
        space._SHADOWED.clear()
        credentials._SHADOWED.clear()
        self.install.find_npm = self._real_find_npm  # type: ignore[assignment]
        self.fake.close()
        os.environ.clear()
        os.environ.update(self.saved_env)

    def state(self) -> Optional[dict]:
        states = [m["params"] for m in self.channel.messages if m["method"] == "state"]
        return states[-1] if states else None


async def _noop(*args: Any, **kwargs: Any) -> None:
    return None


async def _respond(world: _World, start: int, live: List[dict]) -> None:
    """The daemon's side of a job: commit what a durable request needs before
    it is shown, and answer live cards the way a person would."""
    seen = start
    while True:
        await asyncio.sleep(0.02)
        for message in world.channel.messages[seen:]:
            seen += 1
            params = message["params"]
            if message["method"] == "request.prepare":
                waiting = world.ctx._preparing.get(params["request"]["id"])
                if waiting is not None and not waiting.done():
                    waiting.set_result(None)
            elif message["method"] == "request.open" and live:
                answer = dict(live.pop(0))
                delay = answer.pop("delay", 0.05)

                async def deliver(request_id: str = params["id"], raw: dict = answer, wait: float = delay) -> None:
                    await asyncio.sleep(wait)
                    world.ctx._answer(request_id, raw)

                asyncio.ensure_future(deliver())


async def _run_flow_step(world: _World, step: dict) -> Dict[str, Any]:
    from ..serve import Job, _outcome, _run_job

    ctx, channel, agent = world.ctx, world.channel, world.agent
    action = step["run"]
    answers = [dict(answer) for answer in step.get("answers", [])]
    live = [dict(answer) for answer in step.get("live", [])]
    start = len(channel.messages)
    job = ctx._job(action)

    def work_for(current: Any) -> Any:
        return lambda j: agent.run_action(ctx, action, j)

    work = work_for(job)
    suspended: List[dict] = []
    responder = asyncio.ensure_future(_respond(world, start, live))
    try:
        for _ in range(12):
            before = len(channel.messages)
            await asyncio.wait_for(_run_job(job, work), step.get("timeout", 30.0))
            held = [m["params"] for m in channel.messages[before:] if m["method"] == "request.suspend"]
            if not held:
                break
            params = held[0]
            suspended.append({"step": params["step"], "title": params["request"]["title"], "questions": params["request"]["questions"]})
            if not answers:
                raise RuntimeError(f"the flow asked {params['step']!r} but the case has no answer left")
            raw = answers.pop(0)
            job = Job(channel, job.id, action, ctx._mask)
            job.step = params["step"]
            job.outcome = _outcome(raw)
            for question in params["request"]["questions"]:
                if question.get("input") == "secret":
                    value = job.outcome.text.get(question["id"])
                    if value:
                        ctx._mask.add(value)
            resumed = params["step"]
            work = (lambda r: (lambda j: agent.resume_action(ctx, action, r, j)))(resumed)
    finally:
        responder.cancel()
    messages = channel.messages[start:]
    finished = [m["params"] for m in messages if m["method"] == "job.progress" and m["params"].get("done")]
    if not finished:
        result = "error: the job never finished"
    elif finished[-1].get("error"):
        result = "error: " + finished[-1]["error"]
    else:
        result = "done: " + (finished[-1].get("message") or "")
    cards = [m["params"] for m in messages if m["method"] == "request.open"]
    closed = [m for m in messages if m["method"] == "request.close"]
    return {"result": result, "suspended": suspended, "cards": cards, "cardsLeftOpen": len(cards) - len(closed), "state": world.state()}


async def _drive_agent(case: dict, world: _World) -> Optional[str]:
    from .. import credentials, login

    ctx, agent = world.ctx, world.agent
    if case.get("interruptedLogin"):
        # A daemon that died mid-login leaves this marker behind.
        login._write_marker(ctx, "login")
    await agent.start(ctx)
    for number, step in enumerate(case["steps"]):
        label = f"step {number} {json.dumps({k: v for k, v in step.items() if k in ('run', 'refresh', 'setEnv')}, ensure_ascii=False)}"
        if "setKeyCheck" in step:
            world.key_verdict = _verdict(step["setKeyCheck"])
        if "setRejectKeys" in step:
            world.reject_keys = list(step["setRejectKeys"])
        if step.get("forgetKeys"):
            agent._keys.forget()
        for name, value in (step.get("setEnv") or {}).items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        record: Dict[str, Any] = {}
        if "run" in step:
            record = await _run_flow_step(world, step)
        else:
            await agent.refresh(ctx)
            record = {"state": world.state()}
        expect = step.get("expect", {})
        record["credentials"] = credentials.has(ctx)
        record["env"] = {name: os.environ.get(name) for name in expect.get("env", {})}
        record["runs"] = [" ".join(argv) for argv in world.fake.runs()]
        record["keyChecks"] = list(world.key_urls)
        from .. import space

        runs = [entry for entry in world.fake.log() if "argv" in entry]
        mine = space.directory(ctx)
        record["lastRunEnv"] = {
            name: ("<space>" if value == mine else value) for name, value in ((runs[-1].get("env") if runs else None) or {}).items()
        }
        record["space"] = space.own(ctx)
        record["stdin"] = world.fake.stdin_lines()
        # The environment variable that picks CodeBuddy's service, as the last
        # `--acp` login process saw it.
        acp_runs = [entry for entry in world.fake.log() if entry.get("argv") == ["--acp"]]
        record["acpEnv"] = acp_runs[-1]["env"].get("CODEBUDDY_INTERNET_ENVIRONMENT") if acp_runs else "<no login process>"
        # The environment variable that picks CodeBuddy's service, as the last
        # `--acp` login process saw it.
        acp_runs = [entry for entry in world.fake.log() if entry.get("argv") == ["--acp"]]
        record["acpEnv"] = acp_runs[-1]["env"].get("CODEBUDDY_INTERNET_ENVIRONMENT") if acp_runs else "<no login process>"
        for key, want in expect.items():
            if key in ("neverLogged", "runsInclude", "runsExclude", "resultStartsWith"):
                continue
            if key == "result" and isinstance(want, str):
                if not str(record["result"]).startswith(want):
                    return f"{label}: result {record['result']!r}, expected it to start with {want!r}"
                continue
            problem = subset(want, record.get(key), key)
            if problem:
                return f"{label}: {problem}"
        for needle in expect.get("runsInclude", []):
            if not any(needle in run for run in record["runs"]):
                return f"{label}: the CLI was never run with {needle!r} (ran: {record['runs']})"
        for needle in expect.get("runsExclude", []):
            if any(needle in run for run in record["runs"]):
                return f"{label}: the CLI was run with {needle!r}"
        if record.get("cardsLeftOpen"):
            return f"{label}: a card was left open"
        if os.path.exists(os.path.join(ctx.state_dir, login.MARKER)) and "run" in step:
            return f"{label}: the pending-login marker was left behind"
        shown = json.dumps([m["params"] for m in world.channel.messages if m["method"] in ("job.progress", "state")], ensure_ascii=False)
        for secret in expect.get("neverLogged", []):
            if secret in shown:
                return f"{label}: {secret!r} reached the job log or the state"
    for secret in case.get("neverLogged", []):
        if secret in json.dumps([m["params"] for m in world.channel.messages if m["method"] in ("job.progress", "state")], ensure_ascii=False):
            return f"{secret!r} reached the job log or the state"
    for session in list(agent.sessions):
        await session.close()
    return None


def run_keycheck(case: dict, flavor: Flavor) -> Optional[str]:
    """The real check (``keycheck.anthropic`` / ``openai``) against a local
    server that answers what the case says."""
    import http.server
    import threading

    seen: List[dict] = []
    spec = case.get("server") or {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen.append({"path": self.path, "headers": {name.lower(): value for name, value in self.headers.items()}})
            if self.path.startswith("/elsewhere"):
                self.send_response(200)
                self.end_headers()
                return
            self.send_response(spec.get("status", 200))
            if spec.get("redirect"):
                self.send_header("Location", spec["redirect"])
            self.end_headers()

        def log_message(self, *_args: Any) -> None:
            return None

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    if spec.get("closed"):
        server.shutdown()
        server.server_close()
    base = f"http://127.0.0.1:{port}"
    env = {name: value.replace("<base>", base) for name, value in (case.get("env") or {}).items()}
    key = case.get("key", "sk-probe-key")
    check = keycheck.anthropic if case.get("service") == "anthropic" else keycheck.openai
    loop = asyncio.new_event_loop()
    try:
        verdict = loop.run_until_complete(check(key, env))
    finally:
        loop.close()
        if not spec.get("closed"):
            server.shutdown()
            server.server_close()
    first = seen[0] if seen else {"path": None, "headers": {}}
    record = {
        "status": verdict.status,
        "detail": verdict.detail,
        "path": first["path"],
        "requests": len(seen),
        "headers": {name: ("<key>" if value in (key, "Bearer " + key) else value) for name, value in first["headers"].items() if name in ("x-api-key", "authorization", "anthropic-version")},
        "keyInDetail": key in verdict.detail,
        "followedRedirect": any(entry["path"].startswith("/elsewhere") for entry in seen),
    }
    return subset(case["expect"], record, "keycheck")


def run_agent(case: dict, flavor: Flavor, agent_cls: Any) -> Optional[str]:
    if os.name == "nt":
        return None
    world = _World(case, flavor, agent_cls)
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(asyncio.wait_for(_drive_agent(case, world), case.get("timeout", 120.0)))
    except (RuntimeError, asyncio.TimeoutError) as error:
        return f"{error.__class__.__name__}: {error}"
    finally:
        loop.close()
        world.close()


def run(case: dict, flavor: Flavor, extra: Optional[Dict[str, Any]] = None, agent: Any = None) -> Optional[str]:
    kind = case.get("kind")
    if kind == "agent":
        return run_agent(case, flavor, type(agent))
    handlers: Dict[str, Any] = {
        "translate": run_translate,
        "catalog": run_catalog,
        "args": run_args,
        "content": run_content,
        "history": run_history,
        "initialize": run_initialize,
        "session": run_session,
        "keycheck": run_keycheck,
    }
    handlers.update(extra or {})
    handler = handlers.get(kind)
    if handler is None:
        return f"unknown case kind {kind!r}"
    return handler(case, flavor)
