"""GeneHub script Agent for Anthropic's Claude Code CLI.

Everything protocol-shaped (sessions, translation, history, install and
update) is the shared Claude-protocol family in ``genehub_agent.claude_family``;
this file holds what is specific to Claude Code: how to tell it is logged in,
and the two ways to log in. See README.md.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from genehub_agent import AgentContext, Job, keycheck, login, option, process, serve
from genehub_agent.claude_family import FamilyAgent, Flavor

from spec import CLAUDE, LOGOUT_TIMEOUT, STATUS_TIMEOUT, has_credential_variable, status_from_output


class ClaudeAgent(FamilyAgent):
    flavor = CLAUDE
    api_key_env = "ANTHROPIC_API_KEY"
    api_key_title = "用 API Key 登录 Claude Code"
    api_key_detail = "粘贴一个 Anthropic API Key（在 console.anthropic.com 的 API Keys 里创建）。GeneHub 会先向 Anthropic 核对它是否有效（不发模型请求）；它只保存在这台机器上，不经过任何模型，退出登录时一并删除。"
    api_key_prompt = "Anthropic API Key"

    async def verify_key(self, key: str) -> keycheck.Verdict:
        return await keycheck.anthropic(key, self.env())

    async def login_state(self, program: str, account: Optional[dict]) -> Optional[bool]:
        if has_credential_variable():
            return True
        try:
            done = await process.run([program, "auth", "status", "--json"], env=self.env(), timeout=STATUS_TIMEOUT)
            answer = status_from_output(done.stdout)
            if answer is not None:
                return answer
        except (OSError, TimeoutError) as error:
            self.log(f"claude auth status failed: {error}")
        # An older build without `auth status`: its initialize answer names
        # where the credential comes from.
        source = (account or {}).get("tokenSource")
        if isinstance(source, str):
            return source.strip().lower() not in ("", "none")
        return None

    async def login(self, ctx: AgentContext, job: Job, program: str) -> str:
        outcome = await ctx.ask(
            job,
            "login.method",
            "登录 Claude Code",
            detail="选择用哪种账号登录。",
            options=[
                option("claudeai", "Claude 订阅账号（Pro / Max / Team）"),
                option("console", "Anthropic Console（按 API 用量计费）"),
                option("cancel", "取消"),
            ],
        )
        if outcome.canceled or outcome.option_id not in ("claudeai", "console"):
            return "canceled"
        return await login.link_login(
            ctx,
            job,
            [program, "auth", "login", "--" + outcome.option_id],
            env=self.env(),
            title="登录 Claude Code",
            detail="在浏览器里打开下面的链接，完成授权。授权页可以在任何一台设备的浏览器里打开。",
            paste_prompt="授权完成后页面会显示一串授权码，粘贴到这里；如果这台机器的浏览器已经完成授权，不需要填。",
        )

    async def logout(self, ctx: AgentContext, job: Job, program: str) -> None:
        done = await process.run([program, "auth", "logout"], env=self.env(), timeout=LOGOUT_TIMEOUT)
        for line in (done.stdout + done.stderr).splitlines():
            if line.strip():
                job.log(login.strip_ansi(line))
        if not done.ok:
            raise RuntimeError(f"Claude Code 退出登录失败（退出码 {done.code}），详情见日志")

    def replay(self, case: dict) -> Optional[str]:
        import replay

        return replay.run(case, self)


serve(ClaudeAgent())
