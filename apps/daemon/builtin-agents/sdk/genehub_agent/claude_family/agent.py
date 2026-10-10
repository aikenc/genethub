"""The Agent half shared by every Claude-protocol CLI: finding it, installing
and updating it, reporting what it can do, and opening sessions.

A concrete Agent (Claude Code, CodeBuddy) subclasses :class:`FamilyAgent` and
supplies what really differs: how to tell whether the CLI is logged in, how
to log in and out, and which API key it takes.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import time
from typing import Any, Dict, List, Optional

from .. import credentials, install, login, process
from ..serve import Agent, AgentContext, Job, Session, SessionContext, option, secret_question
from . import catalog, history
from .flavor import Flavor
from .session import FamilySession, Launch

CAPABILITIES = {
    "interrupt": True,
    "setModel": True,
    "setEffort": True,
    "setFast": False,
    "setMode": True,
    "permissions": True,
    "resume": True,
    "fork": False,
    "attachments": True,
}

VERSION_TIMEOUT = 10.0
HELLO_TTL = 30.0
UPDATE_CHECK_SECONDS = 24 * 3600
LOGOUT_TIMEOUT = 30.0


def parse_version(text: str) -> Optional[str]:
    found = re.findall(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?", text or "")
    return found[0] if found else None


def newer(candidate: str, current: str) -> bool:
    def key(version: str) -> tuple:
        core = re.split(r"[-+]", version, 1)[0]
        return tuple(int(part) for part in core.split(".") if part.isdigit())

    try:
        return key(candidate) > key(current)
    except ValueError:
        return False


class FamilyAgent(Agent):
    flavor: Flavor
    # The environment variable an API key is handed to the CLI in.
    api_key_env: str = ""
    api_key_title: str = ""
    api_key_detail: str = ""
    api_key_prompt: str = ""

    def __init__(self) -> None:
        self.ctx: Optional[AgentContext] = None
        self.program: Optional[str] = None
        self.version: Optional[str] = None
        # What the CLI said about itself: models, commands, current model.
        # The account it answered with is read once and never kept.
        self.hello: Optional[dict] = None
        self.account: Optional[dict] = None
        self._hello_at = 0.0
        self.help_text = ""
        self._help_for: Optional[tuple] = None
        self.logged_in: Optional[bool] = None
        self._interrupted: Optional[str] = None
        self.sessions: set = set()
        self._npm: Optional[str] = None
        self._refresh_lock: Optional[asyncio.Lock] = None
        self._npm_lock: Optional[asyncio.Lock] = None
        self._force_probe = False

    # -- what a concrete Agent supplies ------------------------------------------------

    async def login_state(self, program: str, account: Optional[dict]) -> Optional[bool]:
        """True / False, or None when it cannot be told. ``account`` is what
        the CLI's initialize answer said about the account, reduced to
        ``{"present": bool, "tokenSource": str | None}`` (nothing else is
        kept: the raw answer carries a bearer token), or None when the
        handshake gave no answer."""
        raise NotImplementedError

    async def login(self, ctx: AgentContext, job: Job, program: str) -> str:
        """Account login in the workbench: ``"ok"`` or ``"canceled"``; anything
        else raises with a message for the person."""
        raise NotImplementedError

    async def logout(self, ctx: AgentContext, job: Job, program: str) -> None:
        raise NotImplementedError

    def api_key_questions(self) -> List[dict]:
        return [secret_question("key", self.api_key_prompt)]

    def api_key_values(self, key: str, outcome: Any) -> Dict[str, str]:
        return {self.api_key_env: key}

    # -- helpers -------------------------------------------------------------------------------

    @property
    def label(self) -> str:
        return self.flavor.label

    def log(self, message: str) -> None:
        if self.ctx is not None:
            self.ctx.log(message)

    def env(self) -> Dict[str, str]:
        env = process.child_environment()
        if self._npm and process.find_executable("node") is None:
            env = install.node_env(self._npm, env)
        return env

    def find_program(self) -> Optional[str]:
        managed = install.npm_bin_dir(self.ctx) if self.ctx is not None else None
        return self.flavor.find_program(managed)

    def installed_by_genehub(self, program: Optional[str]) -> bool:
        if not program or self.ctx is None:
            return False
        prefix = os.path.realpath(install.npm_prefix(self.ctx))
        return os.path.realpath(program).startswith(prefix + os.sep)

    def not_installed(self) -> str:
        return f"未安装 {self.label}"

    def not_logged_in(self) -> str:
        return f"找到了 {self.label}，但它还没登录：点「登录」，或者用 API Key 登录。"

    def _cache_path(self) -> str:
        assert self.ctx is not None
        return os.path.join(self.ctx.state_dir, "catalog.json")

    def _load_cache(self) -> Optional[dict]:
        try:
            with open(self._cache_path(), "r", encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None

    def _save_cache(self, ready: bool, message: Optional[str], actions: List[dict]) -> None:
        if self.ctx is None:
            return
        value = {"ready": ready, "message": message, "version": self.version, "hello": self.hello, "help": self.help_text, "actions": actions}
        path = self._cache_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fd, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".catalog-")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False)
            os.replace(temp, path)
        except OSError as error:
            self.log(f"could not cache the {self.label} catalog: {error}")

    def catalog(self) -> dict:
        return catalog.build_catalog(self.hello, self.help_text)

    def _push(self, ready: bool, message: Optional[str], actions: List[dict]) -> None:
        assert self.ctx is not None
        self.ctx.set_state(
            ready=ready,
            message=message,
            version=self.version,
            actions=actions,
            capabilities=CAPABILITIES,
            catalog=self.catalog() if self.program else {"models": [], "modes": [], "commands": []},
        )
        self._save_cache(ready, message, actions)

    # -- probing ---------------------------------------------------------------------------------

    async def _version(self, program: str) -> Optional[str]:
        try:
            done = await process.run([program, "--version"], env=self.env(), timeout=VERSION_TIMEOUT)
        except (OSError, TimeoutError) as error:
            self.log(f"{self.flavor.id} --version failed: {error}")
            return None
        return parse_version(done.stdout + "\n" + done.stderr) if done.ok else None

    async def _help(self, program: str) -> str:
        key = (program, self.version)
        if self._help_for != key or not self.help_text:
            self.help_text = await catalog.read_help(program, self.flavor, self.env())
            self._help_for = key
        return self.help_text

    async def _probe(self, program: str, force: bool = False) -> None:
        """Asks the CLI what it supports, keeping the lists and a summary of
        the account (never the account itself)."""
        assert self.ctx is not None
        if not force and self.hello is not None and self.account is not None and time.monotonic() - self._hello_at < HELLO_TTL:
            return
        os.makedirs(self.ctx.state_dir, exist_ok=True)
        answer = await catalog.initialize(program, self.flavor, self.env(), self.ctx.state_dir)
        if answer is None:
            self.account = None
            return
        self.hello = {key: answer[key] for key in ("models", "commands", "model", "currentModelId") if key in answer}
        self._hello_at = time.monotonic()
        account = answer.get("account")
        source = account.get("tokenSource") if isinstance(account, dict) else None
        self.account = {"present": bool(account), "tokenSource": source if isinstance(source, str) else None}

    # -- Agent ----------------------------------------------------------------------------------------

    async def start(self, ctx: AgentContext) -> None:
        self.ctx = ctx
        self._refresh_lock = asyncio.Lock()
        self._npm_lock = asyncio.Lock()
        credentials.apply(ctx)
        self._interrupted = login.take_interrupted(ctx)
        cached = self._load_cache()
        if cached:
            # The last good state at once, so the picker is never empty while
            # the probe below runs.
            self.hello = cached.get("hello") if isinstance(cached.get("hello"), dict) else None
            self.help_text = cached.get("help") if isinstance(cached.get("help"), str) else ""
            self.version = cached.get("version") if isinstance(cached.get("version"), str) else None
            self.program = self.find_program()
            if self.program:
                ctx.set_state(
                    ready=bool(cached.get("ready")),
                    message=f"正在检查 {self.label}…",
                    version=self.version,
                    actions=cached.get("actions") if isinstance(cached.get("actions"), list) else [],
                    capabilities=CAPABILITIES,
                    catalog=self.catalog(),
                )
        await self.refresh(ctx)
        if self.installed_by_genehub(self.program):
            ctx.spawn(self._maybe_auto_update())

    async def refresh(self, ctx: AgentContext) -> None:
        self.ctx = ctx
        if self._refresh_lock is None:
            self._refresh_lock = asyncio.Lock()
            self._npm_lock = asyncio.Lock()
        async with self._refresh_lock:
            await self._refresh(force=self._force_probe)
            self._force_probe = False

    async def _refresh(self, force: bool = False) -> None:
        program = self.find_program()
        self.program = program
        if not program or process.find_executable("node") is None:
            # Only then is a slower lookup (login shell) worth it.
            self._npm = await install.find_npm()
        if not program:
            self.logged_in = None
            self.version = None
            message = self.not_installed() if self._npm else self.not_installed() + "。" + install.NO_NODE
            self._push(False, message, [AgentContext.action("install", "安装", primary=True)])
            return
        self.version = await self._version(program) or self.version
        await self._help(program)
        await self._probe(program, force)
        self.logged_in = await self.login_state(program, self.account)
        if self.logged_in is False:
            self._push(
                False,
                self._interrupted or self.not_logged_in(),
                [AgentContext.action("login", "登录", primary=True), AgentContext.action("login-api-key", "用 API Key 登录")],
            )
            return
        self._interrupted = None
        notes: List[str] = []
        if not (self.hello or {}).get("models"):
            notes.append(f"{self.label} 没有返回模型列表，稍后刷新再试。")
        actions = [
            AgentContext.action("login-api-key", "换一个 API Key" if credentials.has(self.ctx) else "用 API Key 登录"),
            AgentContext.action("logout", "退出登录"),
            AgentContext.action("update", "更新"),
        ]
        if self.logged_in is None:
            # A status call that told us nothing is not a reason to hide a CLI
            # that is sitting right there — but say so, and offer login.
            notes.append(f"未能确认 {self.label} 的登录状态。")
            actions.insert(0, AgentContext.action("login", "登录"))
        self._push(True, " ".join(notes) or None, actions)

    async def run_action(self, ctx: AgentContext, action: str, job: Job) -> None:
        self.ctx = ctx
        if action == "install":
            await self._install(ctx, job)
        elif action == "login":
            await self._login(ctx, job)
        elif action == "login-api-key":
            await self._login_api_key(ctx, job)
        elif action == "logout":
            await self._logout(ctx, job)
        elif action == "update":
            await self._update(ctx, job, explicit=True)
        else:
            raise RuntimeError(f"unknown action {action!r}")

    async def resume_action(self, ctx: AgentContext, action: str, step: str, job: Job) -> None:
        if step in ("login.method", "login.external"):
            # A login link cannot be resumed; this starts a fresh one. And
            # installation has completed: never replay npm for a login answer.
            await self._login(ctx, job)
        elif step == "login.api-key":
            await self._login_api_key(ctx, job)
        else:
            await self.run_action(ctx, action, job)

    async def open_session(self, ctx: SessionContext) -> Session:
        launch = await self.prepare_launch()
        session = FamilySession(ctx, self, self.flavor, launch)
        self.sessions.add(session)
        return session

    async def prepare_launch(self) -> Launch:
        """What a session process needs to be started: the program, and the
        model and effort ids this install listed (a stored choice is passed
        on only if it is one of them)."""
        ctx = self.ctx
        program = self.find_program()
        if program is None or ctx is None:
            raise RuntimeError(self.not_installed())
        self.program = program
        if not self.hello:
            await self._probe(program, force=True)
        if not self.help_text:
            await self._help(program)
        models = catalog.models_in(self.hello)
        return Launch(
            program=program,
            help_text=self.help_text,
            models=[model["id"] for model in models],
            efforts=catalog.efforts_of(models),
            default_model=catalog.reported_model(self.hello) or (models[0]["id"] if models else None),
            env=self.env(),
        )

    def forget(self, session: FamilySession) -> None:
        self.sessions.discard(session)

    async def shutdown(self, ctx: AgentContext) -> None:
        self.sessions.clear()

    def _recycle_sessions(self) -> None:
        """Credentials or the CLI itself changed: running sessions start a new
        process (same conversation) when they are next idle."""
        for session in list(self.sessions):
            session.recycle_when_idle()

    # -- install / login / update ------------------------------------------------------------------------

    async def _install(self, ctx: AgentContext, job: Job) -> None:
        npm = self._npm = await install.find_npm()
        if npm is None:
            raise RuntimeError(install.NO_NODE)
        package = self.flavor.npm_package
        command = [npm, "install", "-g", "--prefix", install.npm_prefix(ctx), package]
        confirmed = await install.confirm(
            ctx,
            job,
            f"安装 {self.label}",
            command,
            source=f"npm 包 {package}（本机 npm 配置的仓库）",
            note="装在 GeneHub 自己的目录里，不需要管理员权限，也不改全局 PATH。",
        )
        if not confirmed:
            job.done("已取消")
            return
        assert self._npm_lock is not None
        async with self._npm_lock:
            await install.npm_install(ctx, job, package)
        await self._refresh_now(ctx)
        if not self.program:
            raise RuntimeError(f"安装完成，但没有找到 {self.flavor.binaries[0]} 可执行文件，详情见日志")
        if self.logged_in is False:
            job.progress(phase="login", message=f"安装完成，接着登录 {self.label}")
            # The install succeeded; a login that does not finish must not
            # turn it into a failed job.
            try:
                result = await self.login(ctx, job, self.program)
            except RuntimeError as error:
                self.log(f"login after install did not finish: {error}")
                result = "failed"
            self._recycle_sessions()
            await self._refresh_now(ctx)
            if result == "canceled":
                job.done("已安装；登录已取消，可以稍后点「登录」")
                return
            if result == "failed":
                job.done("已安装；登录没有完成，可以稍后点「登录」或用 API Key 登录")
                return
        job.done(f"已安装 {self.label} {self.version or ''}".strip())

    async def _refresh_now(self, ctx: AgentContext) -> None:
        self._force_probe = True
        await self.refresh(ctx)

    def _require_program(self) -> str:
        program = self.find_program()
        if not program:
            raise RuntimeError(self.not_installed())
        return program

    async def _login(self, ctx: AgentContext, job: Job) -> None:
        self._interrupted = None
        result = await self.login(ctx, job, self._require_program())
        self._recycle_sessions()
        await self._refresh_now(ctx)
        if result == "canceled":
            job.done("已取消登录")
        elif self.logged_in is False:
            raise RuntimeError(f"登录没有完成：{self.label} 仍然报告未登录，请重新点「登录」")
        else:
            job.done("已登录")

    async def _login_api_key(self, ctx: AgentContext, job: Job) -> None:
        self._require_program()
        outcome = await ctx.ask(
            job,
            "login.api-key",
            self.api_key_title,
            detail=self.api_key_detail,
            questions=self.api_key_questions(),
            options=[option("save", "保存"), option("cancel", "取消")],
        )
        key = (outcome.value("key") or "").strip()
        if outcome.canceled or outcome.option_id != "save" or not key:
            job.done("已取消登录")
            return
        job.progress(phase="login", message="正在保存 API Key")
        credentials.save(ctx, self.api_key_values(key, outcome))
        self._recycle_sessions()
        await self._refresh_now(ctx)
        if self.logged_in is False:
            credentials.clear(ctx)
            await self._refresh_now(ctx)
            raise RuntimeError(f"API Key 没有生效：{self.label} 仍然报告未登录")
        job.done("已用 API Key 登录")

    async def _logout(self, ctx: AgentContext, job: Job) -> None:
        program = self._require_program()
        job.progress(phase="logout", message="正在退出登录")
        # A key GeneHub saved goes first, so the state below is the account's.
        credentials.clear(ctx)
        try:
            await self.logout(ctx, job, program)
        finally:
            self._recycle_sessions()
            await self._refresh_now(ctx)
        if self.logged_in is True:
            raise RuntimeError(f"已经退出了 GeneHub 保存的登录，但 {self.label} 仍然是已登录：它的登录来自这台机器上别处设置的环境变量或配置")
        job.done("已退出登录")

    async def _latest_version(self) -> Optional[str]:
        npm = self._npm = await install.find_npm()
        if npm is None:
            return None
        try:
            done = await process.run([npm, "view", self.flavor.npm_package, "version"], env=install.node_env(npm, self.env()), timeout=30)
        except (OSError, TimeoutError) as error:
            self.log(f"npm view {self.flavor.npm_package} failed: {error}")
            return None
        return parse_version(done.stdout) if done.ok else None

    async def _update(self, ctx: AgentContext, job: Job, explicit: bool, latest: Optional[str] = None) -> None:
        if await install.find_npm() is None:
            raise RuntimeError(install.NO_NODE)
        package = self.flavor.npm_package
        job.progress(phase="check", message="查询最新版本")
        latest = latest or await self._latest_version()
        program = self.find_program()
        managed = self.installed_by_genehub(program)
        previous = self.version if managed else None
        external = program is not None and not managed
        if latest and self.version and not newer(latest, self.version) and not external:
            job.done(f"已是最新版本 {self.version}")
            return
        target = f"{package}@{latest}" if latest else package
        if external:
            if not explicit:
                return
            confirmed = await install.confirm(
                ctx,
                job,
                f"由 GeneHub 管理 {self.label} 更新",
                ["npm", "install", "-g", "--prefix", install.npm_prefix(ctx), target],
                source=f"npm 包 {package}",
                note=f"当前用的是 {program}（不是 GeneHub 装的）。确认后 GeneHub 在自己的目录里另装一份并优先使用，以后自动更新。",
            )
            if not confirmed:
                job.done("已取消")
                return
        if not explicit and self._busy_on_windows():
            job.done(f"有会话正在使用 {self.label}，下次启动时再更新")
            return
        assert self._npm_lock is not None
        async with self._npm_lock:
            await install.npm_install(ctx, job, target)
            # Quick self-check: the new binary must still start.
            fresh = self.find_program()
            started = await self._version(fresh) if fresh else None
            if started is None and previous:
                job.progress(phase="rollback", message=f"新版本无法启动，回到 {previous}")
                await install.npm_install(ctx, job, f"{package}@{previous}")
                await self._refresh_now(ctx)
                raise RuntimeError(f"新版本 {self.label} 无法启动，已回到 {previous}")
        self._recycle_sessions()
        await self._refresh_now(ctx)
        job.done(f"已更新到 {self.version or latest or '最新版本'}")

    def _busy_on_windows(self) -> bool:
        """Windows will not let npm replace a binary a live session runs; the
        install fails half-done and so would the rollback."""
        return process.WINDOWS and bool(self.sessions)

    async def _maybe_auto_update(self) -> None:
        ctx = self.ctx
        assert ctx is not None
        stamp = os.path.join(ctx.state_dir, "update-check.json")
        try:
            with open(stamp, "r", encoding="utf-8") as handle:
                checked = float(json.load(handle).get("checkedAt", 0))
        except (OSError, ValueError, AttributeError, TypeError):
            checked = 0.0
        if time.time() - checked < UPDATE_CHECK_SECONDS:
            return
        try:
            with open(stamp, "w", encoding="utf-8") as handle:
                json.dump({"checkedAt": time.time()}, handle)
        except OSError:
            return
        latest = await self._latest_version()
        if latest and self.version and newer(latest, self.version):
            if self._busy_on_windows():
                self.log(f"{self.label} {latest} is available; not updating while sessions are using it")
                try:
                    os.remove(stamp)  # ask again at the next start
                except OSError:
                    pass
                return
            self.log(f"{self.label} {latest} is available (installed {self.version}); updating in the background")
            ctx.start_job("update", lambda job: self._update(ctx, job, explicit=False, latest=latest))

    # -- import -----------------------------------------------------------------------------------------------

    async def import_list(self, ctx: AgentContext, cwd: str, limit: int) -> Optional[List[dict]]:
        return await asyncio.get_event_loop().run_in_executor(None, history.list_candidates, self.flavor, cwd, int(limit))

    async def import_show(self, ctx: AgentContext, cwd: str, source_id: str) -> dict:
        return await asyncio.get_event_loop().run_in_executor(None, history.show, self.flavor, cwd, source_id)
