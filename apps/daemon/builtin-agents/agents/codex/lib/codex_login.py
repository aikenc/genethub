"""Codex logins: an account login kept alive for its card, and an API key.

`codex login --device-auth` prints a link and a one-time code, then waits
until the person has entered the code in any browser. That one process lives
for as long as the card does (`genehub_agent.login`); if it or the daemon
goes away the card closes and the person starts again. The API-key login
hands the key straight to `codex login --with-api-key` and keeps nothing.
"""

from __future__ import annotations

from typing import Dict

from genehub_agent import AgentContext, Job, login, option, process, secret_question

# "https://auth.openai.com/codex/device" then, on its own line, "ABCD-12345".
CODE_PATTERN = r"\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b"


async def interactive_login(ctx: AgentContext, job: Job, program: str, env: Dict[str, str]) -> str:
    return await login.link_login(
        ctx,
        job,
        [program, "login", "--device-auth"],
        env=env,
        title="登录 Codex",
        detail="在浏览器里打开下面的链接，输入一次性授权码，用你的 ChatGPT 账号完成授权。授权页可以在任何一台设备的浏览器里打开。",
        code_pattern=CODE_PATTERN,
        code_label="一次性授权码",
    )


async def api_key_login(ctx: AgentContext, job: Job, program: str, env: Dict[str, str]) -> str:
    outcome = await ctx.ask(
        job, "login.api-key",
        "用 API Key 登录 Codex",
        detail="粘贴一个 OpenAI API Key。它只交给这台机器上的 Codex 保存，GeneHub 不留存。",
        questions=[secret_question("key", "OpenAI API Key")],
        options=[option("save", "保存"), option("cancel", "取消")],
    )
    key = (outcome.value("key") or "").strip()
    if outcome.canceled or outcome.option_id != "save" or not key:
        return "canceled"
    job.progress(phase="login", message="正在保存 API Key")
    result = await process.run([program, "login", "--with-api-key"], env=env, timeout=60, input_text=key + "\n")
    if not result.ok:
        raise RuntimeError(f"Codex 没有接受这个 API Key（退出码 {result.code}），请检查后重新输入")
    return "ok"
