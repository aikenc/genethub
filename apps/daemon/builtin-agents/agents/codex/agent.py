"""GeneHub script Agent for the OpenAI Codex CLI.

Lifecycle (install, login, update, state, auth-file watching) lives here;
the app-server protocol is in ``lib/codex_appserver.py``, frame translation
in ``lib/codex_translate.py``, one conversation in ``lib/codex_session.py``,
login flows in ``lib/codex_login.py``. See README.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import shutil
import tempfile
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Set

from genehub_agent import Agent, AgentContext, Job, SessionContext, install, process, serve

import codex_login
from codex_appserver import (
    CALL_TIMEOUT,
    DEFAULT_MODE,
    RpcError,
    catalog_modes,
    discover,
    hello_from,
    one_shot,
)
from codex_session import CodexSession, turn_input
from codex_translate import AskBook, Translator, is_interactive_request, notification_turn_id

BINARY = "codex"
NPM_PACKAGE = "@openai/codex"
AUTH_POLL_SECONDS = 10.0
UPDATE_CHECK_SECONDS = 24 * 3600
LOGIN_STATUS_TIMEOUT = 10.0
VERSION_TIMEOUT = 10.0

CAPABILITIES = {
    "interrupt": True,
    # Every turn/start carries the model, the level and the policy.
    "setModel": True,
    "setEffort": True,
    "setFast": False,
    "setMode": True,
    "permissions": True,
    "resume": True,
    "fork": True,
    # Pasted screenshots go out as localImage paths under the scratch dir.
    "attachments": True,
}

NOT_INSTALLED = "未安装 Codex CLI"
IMPORT_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"]
NOT_LOGGED_IN = "找到了 Codex，但它还没登录：点「登录」，或者用 API Key 登录。"


def extra_dirs() -> List[str]:
    """Where an npm or installer copy lands when the daemon's PATH does not
    include it (a desktop app started from the dock, say)."""
    home = os.path.expanduser("~")
    if os.name == "nt":
        dirs = []
        for var, sub in (("APPDATA", "npm"), ("LOCALAPPDATA", os.path.join("Programs", "codex"))):
            base = os.environ.get(var)
            if base:
                dirs.append(os.path.join(base, sub))
        return dirs
    return [
        os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        os.path.join(home, ".bun", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]


def vendored_codex(shim: str) -> Optional[str]:
    """On Windows, the native ``codex.exe`` behind npm's ``codex.cmd`` shim,
    laid out as ``@openai/codex``'s launcher looks for it. Starting it
    directly skips cmd.exe and node, so ending a session ends Codex itself."""
    if os.name != "nt" or not shim.lower().endswith(".cmd"):
        return None
    arm = platform.machine().lower() in ("arm64", "aarch64")
    triple = ("aarch64" if arm else "x86_64") + "-pc-windows-msvc"
    platform_package = os.path.join("@openai", "codex-win32-" + ("arm64" if arm else "x64"))
    modules = os.path.join(os.path.dirname(shim), "node_modules")
    package = os.path.join(modules, "@openai", "codex")
    for vendor in (
        os.path.join(package, "vendor"),
        os.path.join(package, "node_modules", platform_package, "vendor"),
        os.path.join(modules, platform_package, "vendor"),
    ):
        exe = os.path.join(vendor, triple, "codex", "codex.exe")
        if os.path.isfile(exe):
            return exe
    return None


def auth_file() -> str:
    home = os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    return os.path.join(home, "auth.json")


def file_stamp(path: str) -> Optional[tuple]:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def parse_version(text: str) -> Optional[str]:
    found = re.findall(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?", text or "")
    return found[-1] if found else None


def newer(candidate: str, current: str) -> bool:
    def key(version: str) -> tuple:
        core = re.split(r"[-+]", version, 1)[0]
        return tuple(int(part) for part in core.split(".") if part.isdigit())

    try:
        return key(candidate) > key(current)
    except ValueError:
        return False


def clipped(value: str, limit: int) -> str:
    text = value.strip()
    return text[:limit] + "…" if len(text) > limit else text


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


class CodexAgent(Agent):
    def __init__(self) -> None:
        self.ctx: Optional[AgentContext] = None
        self.program: Optional[str] = None
        self.version: Optional[str] = None
        # {"models", "defaultModel", "defaultEffort"} from model/list.
        self.hello: Optional[dict] = None
        # True / False / None (could not tell).
        self.logged_in: Optional[bool] = None
        self.sessions: set = set()
        # codex.exe paths found behind an npm shim (see `vendored_codex`).
        self._vendored: Set[str] = set()
        self._refresh_lock: Optional[asyncio.Lock] = None
        self._npm_lock: Optional[asyncio.Lock] = None
        # npm found outside the daemon's PATH; `node` sits beside it and
        # npm's `codex` launcher needs it.
        self._npm: Optional[str] = None
        self._refresh_queued = False

    # -- helpers ------------------------------------------------------------------

    def log(self, message: str) -> None:
        if self.ctx is not None:
            self.ctx.log(message)

    def env(
        self,
        extra: Optional[Dict[str, str]] = None,
        remove: Iterable[str] = (),
        program: Optional[str] = None,
    ) -> dict:
        env = process.child_environment(extra, remove)
        if self._npm and process.find_executable("node") is None:
            env = install.node_env(self._npm, env)
        program = program or self.program
        if program in self._vendored:
            # What npm's `codex.js` launcher sets up before it starts the binary.
            env.setdefault("CODEX_MANAGED_BY_NPM", "1")
            helpers = os.path.join(os.path.dirname(os.path.dirname(program)), "path")
            if os.path.isdir(helpers):
                env["PATH"] = helpers + os.pathsep + env.get("PATH", "")
        return env

    def program_path(self) -> Optional[str]:
        """GeneHub's own npm prefix first (what install/update manage), then
        PATH, then the usual install directories."""
        found = install.npm_bin(self.ctx, BINARY) if self.ctx is not None else None
        found = found or process.find_executable(BINARY, extra_dirs())
        native = vendored_codex(found) if found else None
        if native:
            self._vendored.add(native)
            return native
        return found

    def installed_by_genehub(self, program: Optional[str]) -> bool:
        if not program or self.ctx is None:
            return False
        prefix = os.path.realpath(install.npm_prefix(self.ctx))
        return os.path.realpath(program).startswith(prefix + os.sep)

    def catalog(self) -> dict:
        hello = self.hello or {}
        catalog = {
            "models": list(hello.get("models") or []),
            "modes": catalog_modes(),
            # Skills are invoked as `$name` plus a skill input block, not as
            # `/name` text, so they are not offered as commands.
            "commands": [],
            "defaultMode": DEFAULT_MODE,
        }
        if hello.get("defaultModel"):
            catalog["defaultModel"] = hello["defaultModel"]
        if hello.get("defaultEffort"):
            catalog["defaultEffort"] = hello["defaultEffort"]
        return catalog

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

    def _save_cache(self, ready: bool, actions: List[dict]) -> None:
        if self.ctx is None:
            return
        value = {"ready": ready, "version": self.version, "hello": self.hello, "actions": actions}
        path = self._cache_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".catalog-")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError as error:
            self.log(f"could not cache the Codex catalog: {error}")

    def _push(self, ready: bool, message: Optional[str], actions: List[dict]) -> None:
        assert self.ctx is not None
        self.ctx.set_state(
            ready=ready,
            message=message,
            version=self.version,
            actions=actions,
            capabilities=CAPABILITIES,
            catalog=self.catalog() if self.program else {"models": [], "modes": catalog_modes(), "commands": []},
        )
        self._save_cache(ready, actions)

    async def _version(self, program: str) -> Optional[str]:
        try:
            result = await process.run([program, "--version"], env=self.env(), timeout=VERSION_TIMEOUT)
        except (OSError, TimeoutError) as error:
            self.log(f"codex --version failed: {error}")
            return None
        return parse_version(result.stdout + result.stderr) if result.ok else None

    async def _login_status(self, program: str) -> Optional[bool]:
        """Phrased as "is it logged out": every other wording means usable."""
        try:
            result = await process.run([program, "login", "status"], env=self.env(), timeout=LOGIN_STATUS_TIMEOUT)
        except (OSError, TimeoutError) as error:
            self.log(f"codex login status failed: {error}")
            return None
        return "Not logged in" not in (result.stdout + result.stderr)

    def _mark_sessions_stale(self, reason: str) -> None:
        for session in list(self.sessions):
            session.mark_stale(reason)

    def forget(self, session: CodexSession) -> None:
        self.sessions.discard(session)

    def request_refresh(self) -> None:
        if self.ctx is None or self._refresh_queued:
            return
        self._refresh_queued = True
        self.ctx.spawn(self.refresh(self.ctx))

    # -- Agent ----------------------------------------------------------------------

    async def start(self, ctx: AgentContext) -> None:
        self.ctx = ctx
        self._refresh_lock = asyncio.Lock()
        self._npm_lock = asyncio.Lock()
        cached = self._load_cache()
        if cached:
            # The last good state at once, so the picker is never empty while
            # the probe below runs.
            self.hello = cached.get("hello") if isinstance(cached.get("hello"), dict) else None
            self.version = cached.get("version") if isinstance(cached.get("version"), str) else None
            self.program = self.program_path()
            ctx.set_state(
                ready=bool(cached.get("ready")),
                message="正在检查 Codex…",
                version=self.version,
                actions=cached.get("actions") if isinstance(cached.get("actions"), list) else [],
                capabilities=CAPABILITIES,
                catalog=self.catalog(),
            )
        ctx.spawn(self._watch_auth())
        await self.refresh(ctx)
        if self.installed_by_genehub(self.program):
            ctx.spawn(self._maybe_auto_update())

    async def refresh(self, ctx: AgentContext) -> None:
        self.ctx = ctx
        if self._refresh_lock is None:
            self._refresh_lock = asyncio.Lock()
        async with self._refresh_lock:
            self._refresh_queued = False
            await self._refresh()

    async def _refresh(self) -> None:
        program = self.program_path()
        self.program = program
        if not program or process.find_executable("node") is None:
            # Only then is a slower lookup (login shell) worth it.
            self._npm = await install.find_npm()
        if not program:
            self.logged_in = None
            self.version = None
            message = NOT_INSTALLED if self._npm else NOT_INSTALLED + "。" + install.NO_NODE
            self._push(False, message, [AgentContext.action("install", "安装", primary=True)])
            return
        self.version = await self._version(program) or self.version
        self.logged_in = await self._login_status(program)
        if self.logged_in is False:
            self._push(
                False,
                NOT_LOGGED_IN,
                [
                    AgentContext.action("login", "登录", primary=True),
                    AgentContext.action("login-api-key", "用 API Key 登录"),
                ],
            )
            return
        assert self.ctx is not None
        hello = await discover(program, self.ctx.state_dir, self.env(), self.log)
        notes = []
        if hello is not None:
            self.hello = hello
        elif self.hello:
            notes.append("Codex 没有及时返回模型列表，先显示上次的列表。")
        else:
            notes.append("Codex 没有返回模型列表，稍后刷新再试。")
        # Switching to another key needs no logout first.
        actions = [
            AgentContext.action("login-api-key", "换一个 API Key"),
            AgentContext.action("logout", "退出登录"),
            AgentContext.action("update", "更新"),
        ]
        if self.logged_in is None:
            # A slow or unusual `login status` is not a reason to hide a CLI
            # that is sitting right there — but say so, and offer login.
            notes.append("未能确认 Codex 的登录状态。")
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

    async def open_session(self, ctx: SessionContext) -> CodexSession:
        if not self.program_path():
            raise RuntimeError(NOT_INSTALLED)
        session = CodexSession(ctx, self)
        await session.start()
        self.sessions.add(session)
        return session

    async def shutdown(self, ctx: AgentContext) -> None:
        self.sessions.clear()

    async def resume_action(self, ctx: AgentContext, action: str, step: str, job: Job) -> None:
        if step == "login.external":
            # Installation has completed; never replay npm for a login answer.
            await self._login(ctx, job)
        elif step == "login.api-key":
            await self._login_api_key(ctx, job)
        else:
            await self.run_action(ctx, action, job)

    # -- install / login / update ----------------------------------------------------

    async def _install(self, ctx: AgentContext, job: Job) -> None:
        npm = self._npm = await install.find_npm()
        if npm is None:
            raise RuntimeError(install.NO_NODE)
        command = [npm, "install", "-g", "--prefix", install.npm_prefix(ctx), NPM_PACKAGE]
        confirmed = await install.confirm(
            ctx,
            job,
            "安装 Codex CLI",
            command,
            source=f"npm 包 {NPM_PACKAGE}（本机 npm 配置的仓库）",
            note="装在 GeneHub 自己的目录里，不需要管理员权限，也不改全局 PATH。",
        )
        if not confirmed:
            job.done("已取消")
            return
        assert self._npm_lock is not None
        async with self._npm_lock:
            await install.npm_install(ctx, job, NPM_PACKAGE)
        await self.refresh(ctx)
        if not self.program:
            raise RuntimeError("安装完成，但没有找到 codex 可执行文件，详情见日志")
        if self.logged_in is False:
            # Install, then ask for login right away.
            job.progress(phase="login", message="安装完成，接着登录 Codex")
            # The install succeeded; a login that does not finish must not
            # turn it into a failed job.
            try:
                result = await codex_login.interactive_login(ctx, job, self.program, self.env())
            except RuntimeError as error:
                self.log(f"login after install did not finish: {error}")
                result = "failed"
            self._mark_sessions_stale("auth")
            await self.refresh(ctx)
            if result == "canceled":
                job.done("已安装；登录已取消，可以稍后点「登录」")
                return
            if result == "failed":
                job.done("已安装；登录没有完成，可以稍后点「登录」或用 API Key 登录")
                return
        job.done(f"已安装 Codex {self.version or ''}".strip())

    def _require_program(self) -> str:
        program = self.program_path()
        if not program:
            raise RuntimeError(NOT_INSTALLED)
        return program

    async def _login(self, ctx: AgentContext, job: Job) -> None:
        result = await codex_login.interactive_login(ctx, job, self._require_program(), self.env())
        self._mark_sessions_stale("auth")
        await self.refresh(ctx)
        if result == "canceled":
            job.done("已取消")
        elif self.logged_in is False:
            raise RuntimeError("登录没有完成：Codex 仍然报告未登录")
        else:
            job.done("已登录")

    async def _login_api_key(self, ctx: AgentContext, job: Job) -> None:
        result = await codex_login.api_key_login(ctx, job, self._require_program(), self.env())
        self._mark_sessions_stale("auth")
        await self.refresh(ctx)
        if result == "canceled":
            job.done("已取消")
        elif self.logged_in is False:
            raise RuntimeError("API Key 没有生效：Codex 仍然报告未登录")
        else:
            job.done("已登录")

    async def _logout(self, ctx: AgentContext, job: Job) -> None:
        program = self._require_program()
        job.progress(phase="logout", message="codex logout")
        result = await process.run([program, "logout"], env=self.env(), timeout=30)
        self._mark_sessions_stale("auth")
        await self.refresh(ctx)
        if not result.ok:
            raise RuntimeError(f"codex logout 退出码 {result.code}")
        job.done("已退出登录")

    async def _latest_version(self) -> Optional[str]:
        npm = self._npm = await install.find_npm()
        if npm is None:
            return None
        try:
            result = await process.run([npm, "view", NPM_PACKAGE, "version"], env=install.node_env(npm, self.env()), timeout=30)
        except (OSError, TimeoutError) as error:
            self.log(f"npm view {NPM_PACKAGE} failed: {error}")
            return None
        return parse_version(result.stdout) if result.ok else None

    async def _update(self, ctx: AgentContext, job: Job, explicit: bool, latest: Optional[str] = None) -> None:
        if await install.find_npm() is None:
            raise RuntimeError(install.NO_NODE)
        job.progress(phase="check", message="查询最新版本")
        latest = latest or await self._latest_version()
        program = self.program_path()
        previous = self.version if self.installed_by_genehub(program) else None
        external = program is not None and not self.installed_by_genehub(program)
        if latest and self.version and not newer(latest, self.version) and not external:
            job.done(f"已是最新版本 {self.version}")
            return
        if external:
            if not explicit:
                return
            target = f"{NPM_PACKAGE}@{latest}" if latest else NPM_PACKAGE
            confirmed = await install.confirm(
                ctx,
                job,
                "由 GeneHub 管理 Codex 更新",
                ["npm", "install", "-g", "--prefix", install.npm_prefix(ctx), target],
                source=f"npm 包 {NPM_PACKAGE}",
                note=f"当前用的是 {program}（不是 GeneHub 装的）。确认后 GeneHub 在自己的目录里另装一份并优先使用，以后自动更新。",
            )
            if not confirmed:
                job.done("已取消")
                return
        if not explicit and self._busy_on_windows():
            job.done("有会话正在使用 Codex，下次启动时再更新")
            return
        target = f"{NPM_PACKAGE}@{latest}" if latest else NPM_PACKAGE
        assert self._npm_lock is not None
        async with self._npm_lock:
            await install.npm_install(ctx, job, target)
            # Quick self-check: the new binary must still start.
            new_program = self.program_path()
            new_version = await self._version(new_program) if new_program else None
            if new_version is None and previous:
                job.progress(phase="rollback", message=f"新版本无法启动，回到 {previous}")
                await install.npm_install(ctx, job, f"{NPM_PACKAGE}@{previous}")
                await self.refresh(ctx)
                raise RuntimeError(f"新版本 Codex 无法启动，已回到 {previous}")
        await self.refresh(ctx)
        # Running sessions keep their process; the next app-server they start
        # (new sessions, restarts at a turn boundary) uses the new binary.
        job.done(f"已更新到 {self.version or latest or '最新版本'}")

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
                self.log(f"Codex {latest} is available; not updating while sessions are using it")
                try:
                    os.remove(stamp)  # ask again at the next start
                except OSError:
                    pass
                return
            self.log(f"Codex {latest} is available (installed {self.version}); updating in the background")
            ctx.start_job("update", lambda job: self._update(ctx, job, explicit=False, latest=latest))

    def _busy_on_windows(self) -> bool:
        """Windows will not let npm replace a codex.exe a live session runs;
        the install fails half-done and so would the rollback."""
        return process.WINDOWS and bool(self.sessions)

    async def _watch_auth(self) -> None:
        """A long-running app-server keeps the token it started with. When
        the auth file changes, refresh and restart sessions at their next
        turn boundary."""
        path = auth_file()
        last = file_stamp(path)
        while True:
            await asyncio.sleep(AUTH_POLL_SECONDS)
            current = file_stamp(path)
            if current == last:
                continue
            last = current
            self.log("Codex auth file changed; refreshing, sessions restart at their next turn")
            self._mark_sessions_stale("auth")
            if self.ctx is not None:
                await self.refresh(self.ctx)

    # -- import -------------------------------------------------------------------------

    async def import_list(self, ctx: AgentContext, cwd: str, limit: int) -> Optional[List[dict]]:
        program = self._require_program()
        params = {"cwd": cwd, "limit": max(1, min(100, int(limit))), "sortKey": "updated_at", "sortDirection": "desc"}

        async def listing(extra: dict) -> Any:
            return await one_shot(
                program, cwd if os.path.isdir(cwd) else ctx.state_dir, self.env(),
                "thread/list", {**params, **extra}, self.log, CALL_TIMEOUT,
            )

        try:
            # Codex's default leaves out `codex exec` threads (scripts, CI);
            # sub-agent threads stay out, they belong to their parent.
            listed = await listing({"sourceKinds": IMPORT_SOURCE_KINDS})
        except RpcError as error:
            # A Codex that predates `sourceKinds`.
            self.log(f"thread/list with sourceKinds failed ({error}); listing Codex's default kinds")
            listed = await listing({})
        candidates = []
        data = listed.get("data") if isinstance(listed, dict) else None
        for thread in data if isinstance(data, list) else []:
            if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
                continue
            preview = (thread.get("preview") if isinstance(thread.get("preview"), str) else "").strip()
            name = thread.get("name")
            title = name if isinstance(name, str) and name.strip() else (preview.splitlines()[0] if preview else "Codex 会话")
            candidates.append(
                {
                    "sourceId": thread["id"],
                    "title": clipped(title, 120),
                    "preview": clipped(preview, 240),
                    "updatedAtMs": _int(thread.get("updatedAt")) * 1000,
                    "continuation": "native",
                }
            )
        return candidates

    async def import_show(self, ctx: AgentContext, cwd: str, source_id: str) -> dict:
        program = self._require_program()
        read = await one_shot(
            program,
            cwd if os.path.isdir(cwd) else ctx.state_dir,
            self.env(),
            "thread/read",
            {"threadId": source_id, "includeTurns": True},
            self.log,
            CALL_TIMEOUT,
        )
        thread = read.get("thread") if isinstance(read, dict) else None
        if not isinstance(thread, dict):
            raise RuntimeError("thread/read did not return a thread")
        items = []
        for turn in thread.get("turns") or []:
            for item in (turn.get("items") or []) if isinstance(turn, dict) else []:
                if not isinstance(item, dict):
                    continue
                item_id = "import-" + uuid.uuid4().hex
                if item.get("type") == "userMessage":
                    text = "\n".join(
                        part["text"]
                        for part in item.get("content") or []
                        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
                    )
                    if text:
                        items.append({"type": "userMessage", "id": item_id, "text": text, "attachments": []})
                elif item.get("type") == "agentMessage":
                    text = item.get("text")
                    if isinstance(text, str) and text:
                        items.append({"type": "assistantMessage", "id": item_id, "text": text})
        preview = thread.get("preview") if isinstance(thread.get("preview"), str) else ""
        name = thread.get("name")
        title = name if isinstance(name, str) and name.strip() else (preview.splitlines()[0] if preview else None)
        result = {
            "createdAtMs": _int(thread.get("createdAt")) * 1000,
            "updatedAtMs": _int(thread.get("updatedAt")) * 1000,
            "items": items,
            "persist": {"threadId": source_id},
            "continuation": "native",
            "warnings": [],
        }
        if title:
            result["title"] = clipped(title, 120)
        return result

    # -- offline acceptance (`boot.py <dir> test`) ----------------------------------------

    def replay(self, case: dict) -> Optional[str]:
        kind = case.get("kind", "frames")
        if kind == "catalog":
            got = hello_from(case["listed"])
            return _diff([got], [case["expect"]])
        if kind == "turnInput":
            scratch = tempfile.mkdtemp(prefix="codex-replay-")
            try:
                blocks = turn_input(case.get("text", ""), case.get("attachments") or [], scratch)
                shapes, written = [], []
                for block in blocks:
                    if block.get("type") == "localImage" and block["path"].startswith(scratch):
                        with open(block["path"], "rb") as handle:
                            written.append(handle.read().decode("latin-1"))
                        block = dict(block, path="<scratch>" + os.path.splitext(block["path"])[1])
                    shapes.append(block)
                problem = _diff(shapes, case["expect"])
                if problem is None and "bytes" in case and written != case["bytes"]:
                    problem = f"image bytes: got {written!r}, expected {case['bytes']!r}"
                return problem
            finally:
                shutil.rmtree(scratch, ignore_errors=True)
        emitted: List[dict] = []
        replies: List[dict] = []
        translator = Translator(emitted.append)
        asks = AskBook()
        thread = case.get("thread")
        for step in case["steps"]:
            if "begin" in step:
                translator.begin_turn(step["begin"])
            elif "turnStartResponse" in step:
                upstream = notification_turn_id(step["turnStartResponse"])
                if upstream:
                    translator.bind_from_response(step.get("turnId") or translator.state.id or "", upstream)
            elif "interrupt" in step:
                translator.state.interrupt_requested = True
            elif "respond" in step:
                frame, event = asks.respond(step["respond"]["requestId"], step["respond"]["outcome"])
                replies.append(frame)
                emitted.append(event)
            elif "crash" in step:
                translator.fail_crashed(step["crash"])
            elif "frame" in step:
                frame = step["frame"]
                method, params = frame.get("method"), frame.get("params")
                if frame.get("id") is not None:
                    surface = True
                    if is_interactive_request(method):
                        surface = translator.is_current_scope(params or {}, thread)
                    events_out, reply = asks.on_request(frame["id"], method, params, surface)
                    emitted.extend(events_out)
                    if reply is not None:
                        replies.append(reply)
                elif method == "serverRequest/resolved":
                    emitted.extend(asks.resolved(params, thread))
                else:
                    translator.translate(method, params, thread)
            else:
                return f"unknown step {step}"
        ignored = set(case.get("ignoreTypes") or [])
        got = [event for event in emitted if event.get("type") not in ignored]
        problem = _diff(got, case.get("events") or [])
        if problem is None and "replies" in case:
            problem = _diff(replies, case["replies"], what="reply")
        if problem is None and "state" in case:
            state = translator.state
            actual = {"id": state.id, "codexTurn": state.codex_turn, "inputTokens": state.usage.input_tokens}
            expected = {key: case["state"].get(key, actual[key]) for key in actual}
            if actual != expected:
                problem = f"state: got {actual}, expected {expected}"
        return problem


_VOLATILE = ("receivedAtMs", "avgTtftMs", "avgOutputRateTps", "outputRateEstimated")
_RANDOM_ID = re.compile(r"^compaction-[0-9a-f]{32}$")


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items() if k not in _VOLATILE}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, str) and _RANDOM_ID.match(value):
        return "compaction-*"
    return value


def _diff(got: List[Any], expected: List[Any], what: str = "event") -> Optional[str]:
    got, expected = _normalize(got), _normalize(expected)
    for index in range(max(len(got), len(expected))):
        a = got[index] if index < len(got) else None
        b = expected[index] if index < len(expected) else None
        if a != b:
            return (
                f"{what} {index}: got {json.dumps(a, ensure_ascii=False, sort_keys=True)}, "
                f"expected {json.dumps(b, ensure_ascii=False, sort_keys=True)}"
            )
    return None


if __name__ == "__main__":
    serve(CodexAgent())
