"""A CLI's own space, kept inside GeneHub's directory (an advanced choice).

By default an Agent shares the machine: it uses the CLI's login, settings and
history exactly as the person's terminal does. A person who wants GeneHub's
use of that CLI kept apart (another account, no mixing of history) can switch
it to its own space: a directory under the Agent's state directory that the
CLI is pointed at through the variable it documents for its configuration
directory. ``HOME`` is never touched, so git, ssh and other tools the CLI
starts still see the person's real home.

The choice is a small file next to the Agent's other state. Leaving the space
only stops pointing at it; what is inside stays, so switching back and forth
loses nothing.
"""

from __future__ import annotations

import json
import os
from typing import Dict, Optional

from .serve import AgentContext, Job, option

FILE = "space.json"
DIRECTORY = "space"

# What the environment held before the space replaced it.
_SHADOWED: Dict[str, Optional[str]] = {}


def directory(ctx: AgentContext) -> str:
    return os.path.join(ctx.state_dir, DIRECTORY)


def _path(ctx: AgentContext) -> str:
    return os.path.join(ctx.state_dir, FILE)


def own(ctx: AgentContext) -> bool:
    try:
        with open(_path(ctx), "r", encoding="utf-8") as handle:
            return json.load(handle).get("own") is True
    except (OSError, ValueError, AttributeError):
        return False


def apply(ctx: AgentContext, variable: str) -> bool:
    """Puts the space in force for this process (and so every CLI it starts)
    when it is switched on, and gives the variable back otherwise. Returns
    whether the Agent is now in its own space."""
    if own(ctx):
        path = directory(ctx)
        os.makedirs(path, mode=0o700, exist_ok=True)
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass
        _SHADOWED.setdefault(variable, os.environ.get(variable))
        os.environ[variable] = path
        return True
    if variable in _SHADOWED:
        before = _SHADOWED.pop(variable)
        if before is None:
            os.environ.pop(variable, None)
        else:
            os.environ[variable] = before
    return False


def switch(ctx: AgentContext, variable: str, on: bool) -> None:
    os.makedirs(ctx.state_dir, exist_ok=True)
    path = _path(ctx)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump({"own": bool(on)}, handle)
    os.replace(temp, path)
    apply(ctx, variable)


def note(label: str) -> str:
    return f"现在用的是独立空间：登录、配置和历史都放在 GeneHub 自己的目录里，和这台机器上的 {label} 分开。"


def action(ctx: AgentContext) -> dict:
    if own(ctx):
        return AgentContext.action("space-shared", "改回沿用本机")
    return AgentContext.action("space-own", "使用独立空间")


async def confirm(ctx: AgentContext, job: Job, label: str, to_own: bool) -> bool:
    """Asks before the switch: it changes which login a CLI sees, so it is
    never done by a click that read as something smaller."""
    if to_own:
        title = f"让 {label} 使用独立空间？"
        detail = (
            f"切换后，GeneHub 里的 {label} 改用自己的一套登录、配置和历史，放在 GeneHub 的数据目录里，需要重新登录。"
            f"这台机器上 {label} 原来的登录和配置不会被改动，也不会被带过来；已有会话的历史不会跟着切换。"
        )
        yes = "切换到独立空间"
    else:
        title = f"让 {label} 改回沿用本机？"
        detail = (
            f"改回后，GeneHub 里的 {label} 沿用这台机器上 {label} 自己的登录、配置和历史。"
            "独立空间里的内容会保留，以后可以再切过去。"
        )
        yes = "改回沿用本机"
    outcome = await ctx.ask(job, "space.confirm", title, detail=detail, options=[option("switch", yes), option("cancel", "取消")])
    return not outcome.canceled and outcome.option_id == "switch"
