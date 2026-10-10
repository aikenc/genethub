"""GeneHub script Agent for Tencent's CodeBuddy CLI (``cbc``).

Everything protocol-shaped (sessions, translation, history, install and
update) is the shared Claude-protocol family in ``genehub_agent.claude_family``;
this file holds what is specific to CodeBuddy: how to tell it is logged in,
the account login (driven over the CLI's ACP login protocol, so GeneHub gets
the authorization link without a terminal) and the API key. See README.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from typing import Any, Dict, List, Optional

from genehub_agent import AgentContext, Job, choice_question, login, option, process, secret_question, serve
from genehub_agent.claude_family import FamilyAgent, catalog

from spec import (
    API_KEY_VARIABLE,
    CODEBUDDY,
    INTERNET_ENVIRONMENT,
    LOGIN_METHODS,
    LOGOUT_TIMEOUT,
    REGIONS,
    acp_script,
    redact_line,
    verdict_from_line,
)


class CodeBuddyAgent(FamilyAgent):
    flavor = CODEBUDDY
    api_key_env = API_KEY_VARIABLE
    api_key_title = "用 API Key 登录 CodeBuddy"
    api_key_detail = "粘贴一个 CodeBuddy API Key。它只保存在这台机器上 GeneHub 的 CodeBuddy 配置目录里，不经过任何模型，退出登录时一并删除。"
    api_key_prompt = "CodeBuddy API Key"

    def api_key_questions(self) -> List[dict]:
        return [
            secret_question("key", self.api_key_prompt),
            choice_question("region", "这个 Key 属于哪个服务", [option(value or "default", label) for value, label in REGIONS]),
        ]

    def api_key_values(self, key: str, outcome: Any) -> Dict[str, str]:
        values = {API_KEY_VARIABLE: key}
        chosen = outcome.selected.get("region") if hasattr(outcome, "selected") else None
        region = chosen[0] if chosen else "default"
        if region and region != "default":
            values[INTERNET_ENVIRONMENT] = region
        return values

    async def login_state(self, program: str, account: Optional[dict]) -> Optional[bool]:
        if os.environ.get(API_KEY_VARIABLE, "").strip():
            return True
        if account is None:
            return None
        return bool(account.get("present"))

    async def login(self, ctx: AgentContext, job: Job, program: str) -> str:
        outcome = await ctx.ask(
            job,
            "login.method",
            "登录 CodeBuddy",
            detail="选择用哪种账号登录。",
            options=[option(method, label) for method, label in LOGIN_METHODS] + [option("cancel", "取消")],
        )
        method = outcome.option_id
        if outcome.canceled or method not in dict(LOGIN_METHODS):
            return "canceled"
        env = self.env()
        # An enterprise sign-in must talk to its own service from the start.
        if method == "internal":
            env[INTERNET_ENVIRONMENT] = "internal"
        elif method == "iOA":
            env[INTERNET_ENVIRONMENT] = "ioa"
        return await login.link_login(
            ctx,
            job,
            [program, "--acp"],
            env=env,
            title="登录 CodeBuddy",
            detail="在浏览器里打开下面的链接，完成授权。授权页可以在任何一台设备的浏览器里打开。",
            stdin_text=acp_script(method),
            on_line=verdict_from_line,
            redact=redact_line,
        )

    async def logout(self, ctx: AgentContext, job: Job, program: str) -> None:
        """CodeBuddy has no logout subcommand; the stream-json control
        request is what its own ``/logout`` runs."""
        argv = [program, *catalog.base_args(self.flavor), self.flavor.skip_permissions_flag]
        child = await process.spawn(
            argv,
            cwd=ctx.state_dir,
            env={**self.env(), **self.flavor.sandbox()},
            stdin=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        request = {"type": "control_request", "request_id": "genehub_logout", "request": {"subtype": "logout"}}

        async def ask() -> Optional[str]:
            assert child.stdin is not None and child.stdout is not None
            child.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
            await child.stdin.drain()
            while True:
                raw = await child.stdout.readline()
                if not raw:
                    return "CodeBuddy 没有回应就退出了"
                try:
                    frame = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                response = frame.get("response") if isinstance(frame, dict) and frame.get("type") == "control_response" else None
                if isinstance(response, dict) and response.get("request_id") == "genehub_logout":
                    if response.get("subtype") == "success":
                        return None
                    error = response.get("error")
                    return error if isinstance(error, str) and error else "no reason given"

        try:
            problem = await asyncio.wait_for(ask(), LOGOUT_TIMEOUT)
        except asyncio.TimeoutError:
            problem = f"{LOGOUT_TIMEOUT:.0f} 秒内没有回应"
        finally:
            await process.kill_tree(child)
        if problem:
            raise RuntimeError(f"CodeBuddy 退出登录失败：{problem}")

    def replay(self, case: dict) -> Optional[str]:
        import replay

        return replay.run(case, self)


serve(CodeBuddyAgent())
