"""GeneHub script Agent for Cursor's CLI (`cursor-agent`).

Sessions run print mode, one process per turn (`cursor_print`); history
import reads Cursor's ACP session store (`acp_import`); install, login,
logout and update are ordinary actions (`lifecycle`).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, List, Optional

from genehub_agent import Agent, AgentContext, Job, Session, SessionContext, option, serve
from genehub_agent import install as sdk_install
from genehub_agent.process import child_environment, run

import acp_import
import cursor_print
import lifecycle

CATALOG_CACHE = "catalog.json"
STATE_FILE = "state.json"
UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
IMPORT_LIST_BUDGET = 13.0


def _now_ms() -> int:
    return int(time.time() * 1000)


class CursorAgent(Agent):
    def __init__(self) -> None:
        self.listed = cursor_print.Listed()
        self.program: Optional[str] = None
        self._refreshing: Optional[asyncio.Lock] = None
        self._listing: Optional[asyncio.Lock] = None
        self._supports_update: Optional[bool] = None
        self._help_for: Optional[str] = None

    # -- small persistence --------------------------------------------------

    def _read_json(self, ctx: AgentContext, name: str) -> dict:
        try:
            with open(os.path.join(ctx.state_dir, name), "r", encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_json(self, ctx: AgentContext, name: str, value: dict) -> None:
        try:
            os.makedirs(ctx.state_dir, exist_ok=True)
            path = os.path.join(ctx.state_dir, name)
            temp = path + ".tmp"
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False)
            os.replace(temp, path)
        except OSError as error:
            ctx.log(f"could not write {name}: {error}")

    def _update_state_file(self, ctx: AgentContext, **fields: Any) -> None:
        state = self._read_json(ctx, STATE_FILE)
        state.update(fields)
        self._write_json(ctx, STATE_FILE, state)

    # -- state ------------------------------------------------------------------

    def catalog(self) -> dict:
        if not self.listed.grouped:
            return {"models": [], "modes": [], "commands": []}
        catalog = {
            "models": self.listed.grouped,
            "modes": cursor_print.MODES,
            "commands": [],
            "defaultMode": "agent",
        }
        if self.listed.default_model:
            catalog["defaultModel"] = self.listed.default_model
        return catalog

    def _find(self, ctx: AgentContext) -> Optional[str]:
        program = lifecycle.find_program(self._read_json(ctx, STATE_FILE).get("program"))
        if program and program != self.program:
            self._update_state_file(ctx, program=program)
        self.program = program
        return program

    async def _supports(self, program: str) -> bool:
        if self._help_for != program or self._supports_update is None:
            text = await lifecycle.help_text(program, [])
            self._supports_update = lifecycle.help_lists_command(text, "update")
            self._help_for = program
        return bool(self._supports_update)

    async def _list_models(self, ctx: AgentContext, program: str) -> bool:
        assert self._listing is not None
        async with self._listing:
            listed = await lifecycle.list_raw_models(program)
            if listed is None:
                return False
            raw, default = listed
            self.listed = cursor_print.Listed(raw, default)
            self._write_json(ctx, CATALOG_CACHE, {"raw": raw, "default": default, "savedAtMs": _now_ms()})
            return True

    def _push(self, ctx: AgentContext, ready: bool, message: Optional[str], version: Optional[str], actions: List[dict]) -> None:
        ctx.set_state(
            ready=ready,
            message=message,
            version=version,
            actions=actions,
            capabilities=cursor_print.CAPABILITIES,
            catalog=self.catalog(),
        )

    async def start(self, ctx: AgentContext) -> None:
        self._refreshing = asyncio.Lock()
        self._listing = asyncio.Lock()
        cached = self._read_json(ctx, CATALOG_CACHE)
        if isinstance(cached.get("raw"), list) and cached["raw"]:
            self.listed = cursor_print.Listed(cached["raw"], cached.get("default"))
            last = self._read_json(ctx, STATE_FILE).get("lastState")
            if isinstance(last, dict) and self._find(ctx):
                self._push(ctx, bool(last.get("ready")), last.get("message"), last.get("version"), last.get("actions") or [])
        await self.refresh(ctx)
        await self._maybe_update_in_background(ctx)

    async def refresh(self, ctx: AgentContext) -> None:
        if self._refreshing is None:
            self._refreshing = asyncio.Lock()
            self._listing = asyncio.Lock()
        async with self._refreshing:
            await self._refresh(ctx)

    async def _refresh(self, ctx: AgentContext) -> None:
        program = self._find(ctx)
        if program is None:
            self._report(ctx, False, "未安装 Cursor CLI", None, [ctx.action("install", "安装", primary=True)])
            return
        version = await lifecycle.version(program)
        if os.environ.get("CURSOR_API_KEY"):
            logged: Optional[bool] = True
        else:
            logged = await lifecycle.logged_in(program)
        if logged is False:
            self._report(ctx, False, "找到了 Cursor，但它还没登录", version, [ctx.action("login", "登录", primary=True)])
            return
        await self._list_models(ctx, program)
        actions = []
        message = None
        if logged is None:
            message = "未能确认登录状态"
            actions.append(ctx.action("login", "登录"))
        actions.append(ctx.action("logout", "退出登录"))
        if await self._supports(program):
            actions.append(ctx.action("update", "更新"))
        self._report(ctx, True, message, version, actions)

    def _report(self, ctx: AgentContext, ready: bool, message: Optional[str], version: Optional[str], actions: List[dict]) -> None:
        self._push(ctx, ready, message, version, actions)
        self._update_state_file(
            ctx, lastState={"ready": ready, "message": message, "version": version, "actions": actions}
        )

    # -- actions --------------------------------------------------------------

    async def run_action(self, ctx: AgentContext, action: str, job: Job) -> None:
        if action == "install":
            await self._install(ctx, job)
        elif action == "login":
            if await self._login(ctx, job) == "canceled":
                job.done("已取消登录")
        elif action == "logout":
            await self._logout(ctx, job)
        elif action == "update":
            await self._update(ctx, job)
        else:
            raise RuntimeError(f"unknown action {action!r}")

    async def _install(self, ctx: AgentContext, job: Job) -> None:
        if not lifecycle.WINDOWS and lifecycle.find_executable("curl") is None:
            raise RuntimeError("需要 curl 才能运行 Cursor 的官方安装脚本。请先安装 curl，再重试。")
        confirmed = await sdk_install.confirm(
            ctx,
            job,
            "安装 Cursor CLI",
            [lifecycle.INSTALL_LINE],
            lifecycle.INSTALL_SOURCE,
            note="Cursor 官方安装脚本，装到当前用户目录，不需要管理员权限。",
        )
        if not confirmed:
            job.done("已取消安装")
            return
        job.progress(phase="install", message=lifecycle.INSTALL_LINE)
        code = await lifecycle.stream_logged(lifecycle.INSTALL_ARGV, job.log, lifecycle.INSTALL_TIMEOUT)
        if code != 0:
            raise RuntimeError(f"安装失败（退出码 {code}），详情见日志")
        self._supports_update = None
        program = self._find(ctx)
        if program is None:
            raise RuntimeError("安装脚本已完成，但没有找到 cursor-agent；详情见日志")
        # Only a CLI GeneHub installed is updated in the background; one the
        # user installed is theirs to update (proposal §8.3).
        self._update_state_file(ctx, installedByGenehub=program)
        job.progress(phase="verify", message="已安装 " + program)
        if not os.environ.get("CURSOR_API_KEY") and await lifecycle.logged_in(program) is not True:
            if await self._login(ctx, job) == "canceled":
                job.done("已安装；登录已取消，可以稍后点「登录」")
        else:
            await self.refresh(ctx)

    async def _login(self, ctx: AgentContext, job: Job) -> str:
        if self._find(ctx) is None:
            raise RuntimeError("未安装 Cursor CLI")
        job.progress(phase="login", message="当前账号授权不支持停止后恢复")
        outcome = await ctx.ask(
            job, "login.external", "登录 Cursor",
            detail=("Cursor 当前的账号授权不能跨停止恢复。此版本不能在工作台完成账号登录；"
                    "GeneHub 已停止这个动作，不会保留登录进程或过期链接。"
                    "如果已通过外部方式获得本机登录凭据，可点「检查登录」核查状态；也可取消此事项。"),
            options=[option("check", "检查登录"), option("cancel", "取消")],
        )
        await self.refresh(ctx)
        if outcome.canceled or outcome.option_id != "check":
            return "canceled"
        if not os.environ.get("CURSOR_API_KEY") and await lifecycle.logged_in(self._find(ctx)) is not True:
            raise RuntimeError("Cursor 仍然报告未登录，请完成本机登录后重新检查")
        job.done("已登录")
        return "ok"

    async def resume_action(self, ctx: AgentContext, action: str, step: str, job: Job) -> None:
        if step == "login.external":
            if await self._login(ctx, job) == "canceled":
                job.done("已安装；登录已取消" if action == "install" else "已取消登录")
        else:
            await self.run_action(ctx, action, job)

    async def _logout(self, ctx: AgentContext, job: Job) -> None:
        program = self._find(ctx)
        if program is None:
            raise RuntimeError("未安装 Cursor CLI")
        job.progress(phase="logout", message="cursor-agent logout")
        try:
            done = await run([program, "logout"], env=child_environment(), timeout=lifecycle.LOGOUT_TIMEOUT)
        finally:
            await self.refresh(ctx)
        for line in (done.stdout + done.stderr).splitlines():
            if line.strip():
                job.log(lifecycle.strip_ansi(line))
        if not done.ok:
            raise RuntimeError(f"cursor-agent logout 退出码 {done.code}，详情见日志")

    async def _update(self, ctx: AgentContext, job: Job) -> None:
        program = self._find(ctx)
        if program is None:
            raise RuntimeError("未安装 Cursor CLI")
        if not await self._supports(program):
            raise RuntimeError("这个版本的 cursor-agent 没有 update 子命令；请重新运行安装")
        self._update_state_file(ctx, lastUpdateCheckMs=_now_ms())
        before = await lifecycle.version(program)
        job.progress(phase="update", message="cursor-agent update")
        code = await lifecycle.stream_logged([program, "update"], job.log, lifecycle.UPDATE_TIMEOUT)
        self._supports_update = None
        await self.refresh(ctx)
        if code != 0:
            raise RuntimeError(f"cursor-agent update 退出码 {code}，详情见日志")
        # Quick self-check: the updated CLI must still start. Cursor's updater
        # cannot go back to a given version, so a failure is reported, not
        # rolled back.
        updated = self._find(ctx)
        after = await lifecycle.version(updated) if updated else None
        if after is None:
            raise RuntimeError("更新后 cursor-agent 无法启动（--version 没有结果）；请点「安装」重新安装")
        job.done(f"已是最新版本 {after}" if after == before else f"已更新到 {after}")

    async def _maybe_update_in_background(self, ctx: AgentContext) -> None:
        program = self.program
        if program is None:
            return
        recorded = self._read_json(ctx, STATE_FILE)
        if recorded.get("installedByGenehub") != program:
            return
        last = recorded.get("lastUpdateCheckMs")
        if isinstance(last, int) and _now_ms() - last < UPDATE_INTERVAL_MS:
            return
        if not await self._supports(program):
            return
        self._update_state_file(ctx, lastUpdateCheckMs=_now_ms())
        ctx.start_job("update", lambda job: self._update(ctx, job))

    # -- sessions -------------------------------------------------------------

    async def open_session(self, ctx: SessionContext) -> Session:
        program = self.program or self._find(ctx.agent)
        if program is None:
            raise RuntimeError(f"{lifecycle.PROGRAM} is not installed")
        if not self.listed.raw:
            await self._list_models(ctx.agent, program)

        async def relist() -> None:
            await self._list_models(ctx.agent, program)

        return cursor_print.CursorSession(ctx, program, relist, lambda: self.listed)

    # -- import ---------------------------------------------------------------

    async def import_list(self, ctx: AgentContext, cwd: str, limit: int) -> Optional[List[dict]]:
        program = self.program or self._find(ctx)
        if program is None:
            raise RuntimeError(f"{lifecycle.PROGRAM} is not installed")
        return await acp_import.list_candidates(program, cwd, limit, IMPORT_LIST_BUDGET)

    async def import_show(self, ctx: AgentContext, cwd: str, source_id: str) -> dict:
        program = self.program or self._find(ctx)
        if program is None:
            raise RuntimeError(f"{lifecycle.PROGRAM} is not installed")
        return await acp_import.show(program, cwd, source_id)

    # -- offline acceptance -----------------------------------------------------

    def replay(self, case: dict) -> Optional[str]:
        import replay

        return replay.run(case)


serve(CursorAgent())
