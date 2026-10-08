"""Durable account-login instructions and a secret API-key checkpoint.

Codex has no public command for resuming a stopped device/OAuth CLI attempt.
GeneHub records the capability limit and a local-login recheck obligation
without a CLI, expiring authorization material, or an in-memory wait.
"""

from __future__ import annotations

from typing import Dict

from genehub_agent import AgentContext, Job, option, process, secret_question

async def interactive_login(ctx: AgentContext, job: Job, program: str, env: Dict[str, str]) -> str:
    """The upstream CLI cannot resume a stopped OAuth/device-login attempt.

    Keep a durable login obligation, not an expiring code backed by a live
    CLI. The card states the limitation; checking an externally acquired
    local login is a fresh action. API-key login stays native in GeneHub.
    """
    job.progress(phase="login", message="当前账号授权不支持停止后恢复")
    outcome = await ctx.ask(
        job, "login.external", "登录 Codex",
        detail=("Codex 当前的账号授权需要登录进程持续运行，不能跨停止恢复。"
                "此版本不能在工作台完成账号登录；GeneHub 已停止这个动作，不会保活登录进程。"
                "可取消后改用「用 API Key 登录」。如果已通过外部方式完成账号授权，可点「检查登录」核查本地状态。"),
        options=[option("check", "检查登录"), option("cancel", "取消")],
    )
    return "canceled" if outcome.canceled or outcome.option_id != "check" else "ok"


async def api_key_login(ctx: AgentContext, job: Job, program: str, env: Dict[str, str]) -> str:
    outcome = await ctx.ask(
        job, "login.api-key",
        "用 API Key 登录 Codex",
        detail="粘贴一个 OpenAI API Key。它只交给本机的 codex login --with-api-key 保存，GeneHub 不留存。",
        questions=[secret_question("key", "OpenAI API Key")],
        options=[option("save", "保存"), option("cancel", "取消")],
    )
    key = (outcome.value("key") or "").strip()
    if outcome.canceled or outcome.option_id != "save" or not key:
        return "canceled"
    job.progress(phase="login", message="正在保存 API Key")
    result = await process.run([program, "login", "--with-api-key"], env=env, timeout=60, input_text=key + "\n")
    if not result.ok:
        raise RuntimeError(f"codex login --with-api-key 失败（退出码 {result.code}）")
    return "ok"
