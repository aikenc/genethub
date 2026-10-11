"""Account login that needs a person at a browser, driven from the workbench.

The CLI's own login command runs for as long as the person takes: it prints
an authorization link (and sometimes a one-time code), then waits for the
authorization to finish or for a pasted code. This helper keeps exactly that
one process alive while an Agent-level request card shows the link, and ends
it when the card is answered, the process exits, the time is up or this
Agent process goes away.

Nothing here is durable on purpose. A link and a code expire, so an
interrupted login is never resumed: the card closes and the person starts
again (``take_interrupted`` turns the leftover marker into that message).
The link, the code and anything typed into the card live only in the request
card: they never reach a model, a timeline or a log.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from collections import deque
from typing import Callable, Deque, Dict, List, Optional

from . import process as _process
from .serve import AgentContext, Job, link, code as code_item, option, text_question

# How long the CLI gets to print a link, and how long a person gets to finish.
URL_TIMEOUT = 60.0
LOGIN_TIMEOUT = 10 * 60.0
# How long a pasted code is given to turn into a success or a failure.
CODE_SETTLE = 60.0

MARKER = "login.pending.json"

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_URL = re.compile(r"https://[^\s\"'<>\x1b]+")

# Agents whose login is running in this process; ``take_interrupted`` must
# not mistake their marker for a leftover.
_ACTIVE: Dict[str, str] = {}


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def _strings(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def find_url(line: str) -> Optional[str]:
    text = strip_ansi(line)
    if text.lstrip().startswith("{"):
        # A JSON-RPC notification: the link is a string value, possibly with
        # escaped characters a regex over the raw line would stop at.
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        for value in _strings(parsed):
            found = _URL.search(value)
            if found:
                return found.group(0).rstrip(".,);")
    found = _URL.search(text)
    return found.group(0).rstrip(".,);") if found else None


def hide_urls(line: str) -> str:
    return _URL.sub("<授权链接见请求卡片>", strip_ansi(line))


# -- marker --------------------------------------------------------------------


def _marker_path(ctx: AgentContext) -> str:
    return os.path.join(ctx.state_dir, MARKER)


def _write_marker(ctx: AgentContext, action: str) -> None:
    try:
        os.makedirs(ctx.state_dir, exist_ok=True)
        with open(_marker_path(ctx), "w", encoding="utf-8") as handle:
            json.dump({"action": action, "startedAtMs": int(time.time() * 1000)}, handle)
    except OSError as error:
        ctx.log(f"could not write {MARKER}: {error}")


def _remove_marker(ctx: AgentContext) -> None:
    try:
        os.remove(_marker_path(ctx))
    except FileNotFoundError:
        pass
    except OSError as error:
        ctx.log(f"could not remove {MARKER}: {error}")


INTERRUPTED = "登录已中断，请重新点「登录」"


def take_interrupted(ctx: AgentContext) -> Optional[str]:
    """The message a state should carry when the previous Agent process died
    in the middle of a login. Consumes the marker, so it is said once."""
    if ctx.agent_id in _ACTIVE:
        return None
    path = _marker_path(ctx)
    if not os.path.exists(path):
        return None
    _remove_marker(ctx)
    return INTERRUPTED


# -- the login --------------------------------------------------------------------


class LoginCanceled(Exception):
    """The person closed the card; not a failure."""


class _Output:
    """What the login CLI has said so far."""

    def __init__(
        self,
        job: Job,
        pattern_code: Optional["re.Pattern[str]"],
        on_line: Optional[Callable[[str], Optional[str]]],
        redact: Optional[Callable[[str], str]] = None,
    ) -> None:
        self.job = job
        self._redact = redact
        self.url: Optional[str] = None
        self.code: Optional[str] = None
        # Set by `on_line` returning "ok" or "error: <message>".
        self.verdict: Optional[str] = None
        self.ended = asyncio.Event()
        self.tail: Deque[str] = deque(maxlen=12)
        self.seen = asyncio.Event()
        self._pattern_code = pattern_code
        self._on_line = on_line

    def feed(self, raw: str) -> None:
        line = strip_ansi(raw).rstrip()
        if not line.strip():
            return
        if self.url is None:
            found = find_url(line)
            if found:
                self.url = found
        if self._pattern_code is not None and self.code is None:
            matched = self._pattern_code.search(line)
            if matched:
                self.code = matched.group(1) if matched.groups() else matched.group(0)
        shown = self._redact(line) if self._redact is not None else hide_urls(line)
        if self.code:
            shown = shown.replace(self.code, "<授权码见请求卡片>")
        if shown.strip():
            self.tail.append(shown)
            self.job.log(shown)
        if self._on_line is not None:
            verdict = self._on_line(line)
            if verdict and self.verdict is None:
                self.verdict = verdict
                self.ended.set()
        if self.url is not None and (self._pattern_code is None or self.code is not None):
            self.seen.set()

    def explain(self) -> str:
        lines = [line for line in self.tail if line.strip()]
        return lines[-1] if lines else ""


async def _pump(process: "asyncio.subprocess.Process", output: _Output) -> None:
    assert process.stdout is not None
    while True:
        raw = await process.stdout.readline()
        if not raw:
            return
        output.feed(raw.decode("utf-8", "replace"))


async def _first(*waits: "asyncio.Future") -> None:
    """Done when the process exited or the output said the login is over."""
    tasks = [asyncio.ensure_future(wait) for wait in waits]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()


async def _settle(task: "asyncio.Future", timeout: float) -> None:
    """Lets the reader finish what the exited process left in its pipe."""
    if task.done():
        return
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass


def _detail(base: str, expires: float) -> str:
    return base + f"\n\n链接约 {int(expires // 60)} 分钟内有效；GeneHub 等待授权完成后会自动更新状态，不需要再做别的。"


async def link_login(
    ctx: AgentContext,
    job: Job,
    argv: List[str],
    *,
    env: Dict[str, str],
    title: str,
    detail: str,
    link_label: str = "打开授权页",
    code_pattern: Optional[str] = None,
    code_label: str = "一次性授权码",
    paste_prompt: Optional[str] = None,
    cwd: Optional[str] = None,
    stdin_text: Optional[str] = None,
    on_line: Optional[Callable[[str], Optional[str]]] = None,
    redact: Optional[Callable[[str], str]] = None,
    url_timeout: float = URL_TIMEOUT,
    timeout: float = LOGIN_TIMEOUT,
) -> str:
    """Runs ``argv`` (a CLI login command) and shows its authorization link.

    ``code_pattern`` is a regex (first group = the code) for a one-time code
    the CLI prints and the person types at the link. ``paste_prompt`` makes
    the card ask for a code the person copies from the authorization page
    and the helper writes to the CLI's stdin. ``stdin_text`` is written
    right after the start (a protocol the CLI speaks on stdin instead of
    printing a link), and ``on_line`` sees every output line: returning
    ``"ok"`` or ``"error: <message>"`` ends the login for a CLI that does
    not exit by itself. ``redact`` decides what of each line reaches the
    job log (default: the line with links hidden); a protocol that may carry
    credentials in its replies logs a fixed summary or nothing.

    Returns ``"ok"`` when the CLI exits 0 and ``"canceled"`` when the person
    closes the card. Anything else raises ``RuntimeError`` with a message for
    the person; the process is always gone when this returns."""
    pattern = re.compile(code_pattern) if code_pattern else None
    output = _Output(job, pattern, on_line, redact)
    _ACTIVE[ctx.agent_id] = job.id
    _write_marker(ctx, job.action or "login")
    job.progress(phase="login", message="正在向 CLI 申请授权链接")
    process = await _process.spawn(
        argv,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE if (paste_prompt or stdin_text is not None) else subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    reader = asyncio.ensure_future(_pump(process, output))
    exited = asyncio.ensure_future(_first(process.wait(), output.ended.wait()))
    if stdin_text is not None and process.stdin is not None:
        process.stdin.write(stdin_text.encode("utf-8"))
        await process.stdin.drain()
    deadline = time.monotonic() + timeout
    handle = None
    try:
        got_link = asyncio.ensure_future(output.seen.wait())
        try:
            await asyncio.wait({got_link, exited}, timeout=url_timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            got_link.cancel()
        if output.url is None or (pattern is not None and output.code is None):
            if process.returncode is not None:
                await _settle(reader, 2.0)
            if output.verdict == "ok" or (process.returncode == 0 and output.url is None):
                return "ok"  # logged in already, nothing to authorize
            if output.verdict:
                raise RuntimeError("登录没有成功：" + output.verdict.replace("error:", "", 1).strip())
            said = output.explain()
            raise RuntimeError("没有拿到授权链接" + (f"：{said}" if said else "；请稍后重试"))
        submitted = False
        while True:
            display = [link(output.url, link_label)]
            if output.code:
                display.append(code_item(output.code, code_label))
            questions = [text_question("code", paste_prompt)] if paste_prompt and not submitted else []
            options = [option("submit", "提交授权码"), option("cancel", "取消")] if questions else [option("cancel", "取消")]
            handle = ctx.open_request(
                title,
                detail=_detail(detail, timeout),
                display=display,
                questions=questions,
                options=options,
            )
            job.progress(phase="waiting", message="等待你在浏览器里完成授权")
            answered = asyncio.ensure_future(handle.wait())
            try:
                remaining = max(deadline - time.monotonic(), 0.0)
                await asyncio.wait({answered, exited}, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
                if exited.done():
                    break
                if not answered.done():
                    raise RuntimeError(f"登录超时：{max(1, round(timeout / 60))} 分钟内没有完成授权，请重新点「登录」")
                outcome = answered.result()
                handle = None
                if outcome.canceled or outcome.option_id == "cancel":
                    raise LoginCanceled()
                pasted = (outcome.value("code") or "").strip()
                if not pasted or process.stdin is None:
                    continue
                submitted = True
                job.progress(phase="login", message="正在核对授权码")
                process.stdin.write((pasted + "\n").encode("utf-8"))
                await process.stdin.drain()
                # The CLI reports a bad code by exiting; if it is still here
                # after a while it has not understood, so ask again.
                try:
                    await asyncio.wait_for(asyncio.shield(exited), CODE_SETTLE)
                    break
                except asyncio.TimeoutError:
                    submitted = False
            finally:
                answered.cancel()
                if handle is not None:
                    handle.close()
                    handle = None
        await _settle(reader, 3.0)
        if output.verdict is not None:
            if output.verdict == "ok":
                return "ok"
            raise RuntimeError("登录没有成功：" + output.verdict.replace("error:", "", 1).strip())
        if process.returncode == 0:
            return "ok"
        said = output.explain()
        raise RuntimeError("登录没有成功" + (f"：{said}" if said else f"（退出码 {process.returncode}）"))
    except LoginCanceled:
        return "canceled"
    except asyncio.TimeoutError:
        raise RuntimeError("登录没有成功：CLI 没有按时结束") from None
    finally:
        if handle is not None:
            handle.close()
        reader.cancel()
        exited.cancel()
        await _process.kill_tree(process)
        _ACTIVE.pop(ctx.agent_id, None)
        _remove_marker(ctx)
