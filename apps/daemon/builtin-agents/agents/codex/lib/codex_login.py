"""Codex logins: an account login kept alive for its card, and an API key.

`codex login --device-auth` prints a link and a one-time code, then waits
until the person has entered the code in any browser. That one process lives
for as long as the card does (`genehub_agent.login`); if it or the daemon
goes away the card closes and the person starts again. The API-key login
asks the service whether it knows the key (its model list, no prompt) and only then hands it to `codex login --with-api-key`; GeneHub keeps nothing.
"""

from __future__ import annotations

import os
import re
from typing import Dict, Optional, Tuple

from genehub_agent import AgentContext, Job, keycheck, login, option, process, secret_question

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


async def browser_login(ctx: AgentContext, job: Job, program: str, env: Dict[str, str]) -> str:
    """``codex login`` (the "Sign in with ChatGPT" flow): the authorization
    page sends the person back to a port on the machine Codex runs on, so the
    browser that opens the link has to be on that machine (or reach it)."""
    return await login.link_login(
        ctx,
        job,
        [program, "login"],
        env=env,
        title="登录 Codex（这台机器的浏览器）",
        detail=(
            "在这台机器的浏览器里打开下面的链接，用你的 ChatGPT 账号完成授权，授权后页面会自动回到这台机器。"
            "如果你是在别的设备上操作，这个链接完成不了，请改用「登录」（一次性授权码）。"
        ),
    )


def custom_provider(env: Dict[str, str]) -> bool:
    """Whether Codex is set up to talk to a service other than OpenAI, whose
    keys OpenAI's model list would not know."""
    home = env.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    try:
        with open(os.path.join(home, "config.toml"), "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return False
    found = re.search(r"^\s*model_provider\s*=\s*[\"']([^\"']*)[\"']", text, re.MULTILINE)
    return bool(found) and found.group(1).strip().lower() not in ("", "openai")


async def verify(key: str, env: Dict[str, str]) -> keycheck.Verdict:
    if custom_provider(env):
        return keycheck.Verdict(keycheck.UNKNOWN, "没能核对：Codex 配置里用的是自定义模型服务，第一次对话时才知道这个 Key 是否有效")
    return await keycheck.openai(key, env)


async def api_key_login(ctx: AgentContext, job: Job, program: str, env: Dict[str, str]) -> Tuple[str, Optional[str]]:
    """("ok" | "canceled", a note when the key could not be checked)."""
    outcome = await ctx.ask(
        job, "login.api-key",
        "用 API Key 登录 Codex",
        detail="粘贴一个 OpenAI API Key。GeneHub 会先向 OpenAI 核对它是否有效（不发模型请求），通过后才交给这台机器上的 Codex 保存，GeneHub 不留存。",
        questions=[secret_question("key", "OpenAI API Key")],
        options=[option("save", "保存"), option("cancel", "取消")],
    )
    key = (outcome.value("key") or "").strip()
    if outcome.canceled or outcome.option_id != "save" or not key:
        return "canceled", None
    job.progress(phase="login", message="正在核对 API Key")
    verdict = await verify(key, env)
    if verdict.rejected:
        raise RuntimeError(f"{verdict.detail}，没有保存。请检查后重新输入。")
    job.progress(phase="login", message="正在保存 API Key")
    result = await process.run([program, "login", "--with-api-key"], env=env, timeout=60, input_text=key + "\n")
    if not result.ok:
        raise RuntimeError(f"Codex 没有接受这个 API Key（退出码 {result.code}），请检查后重新输入")
    return "ok", None if verdict.ok else verdict.detail
