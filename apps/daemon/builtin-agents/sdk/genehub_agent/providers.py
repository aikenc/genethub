"""Running an Agent on a model provider the person configured in GeneHub.

GeneHub keeps providers (address, protocol, key, models) once, in the
workbench's "添加 provider". A script Agent that can run its CLI against a
custom endpoint offers "use a GeneHub provider": the person picks one, this
module remembers only *which* (an id, in the Agent's state directory), and
each time the Agent needs it the daemon is asked for the current
configuration. The key lives in memory, in the CLI's environment, and nowhere
else: no file, no log, no model.

What to do with the configuration is the Agent's business: Claude Code wants
a handful of environment variables, Codex wants provider settings on its
command line. This module only finds, remembers and checks compatibility.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .serve import AgentContext, Job, option

FILE = "provider.json"


@dataclass
class Provider:
    id: str
    label: str
    dialect: str
    base_url: str
    api_key: str = field(repr=False, default="")
    models: List[str] = field(default_factory=list)

    @staticmethod
    def from_wire(raw: Dict[str, Any]) -> "Provider":
        models = raw.get("models")
        return Provider(
            id=str(raw.get("id") or ""),
            label=str(raw.get("label") or raw.get("id") or ""),
            dialect=str(raw.get("dialect") or ""),
            base_url=str(raw.get("baseUrl") or ""),
            api_key=str(raw.get("apiKey") or ""),
            models=[model for model in models if isinstance(model, str)] if isinstance(models, list) else [],
        )


def _path(ctx: AgentContext) -> str:
    return os.path.join(ctx.state_dir, FILE)


def bound(ctx: AgentContext) -> Optional[str]:
    """The id of the provider this Agent was pointed at, if any."""
    try:
        with open(_path(ctx), "r", encoding="utf-8") as handle:
            value = json.load(handle).get("provider")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def bind(ctx: AgentContext, provider_id: Optional[str]) -> None:
    """Remembers the choice, or forgets it with ``None``."""
    os.makedirs(ctx.state_dir, exist_ok=True)
    path = _path(ctx)
    if not provider_id:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump({"provider": provider_id}, handle)
    os.replace(temp, path)


async def fetch(ctx: AgentContext, provider_id: str, dialects: Sequence[str]) -> Provider:
    """The current configuration of ``provider_id``, or an explanation."""
    answer = await ctx.provider_call("get", provider_id)
    raw = answer.get("provider")
    if not isinstance(raw, dict):
        raise RuntimeError(f"没有取到 {provider_id} 的配置")
    provider = Provider.from_wire(raw)
    if provider.dialect not in dialects:
        raise RuntimeError(compatibility(provider.label, provider.dialect, dialects))
    if not provider.models:
        raise RuntimeError(f"{provider.label} 还没有可用的模型列表。到「添加 provider」里确认 Key，或者手动写上模型。")
    return provider


def compatibility(label: str, dialect: str, dialects: Sequence[str]) -> str:
    return f"{label} 说的是 {dialect} 接口，这个 Agent 只能接 {'、'.join(dialects)} 接口的 provider"


async def usable(ctx: AgentContext, dialects: Sequence[str]) -> List[dict]:
    """Configured providers this Agent could run on, without their keys."""
    answer = await ctx.provider_call("list")
    listed = answer.get("providers")
    return [
        item
        for item in (listed if isinstance(listed, list) else [])
        if isinstance(item, dict) and item.get("usable") and item.get("dialect") in dialects and item.get("models")
    ]


async def choose(ctx: AgentContext, job: Job, label: str, dialects: Sequence[str]) -> Optional[str]:
    """Asks which provider ``label`` should run on. ``None`` when canceled."""
    found = await usable(ctx, dialects)
    if not found:
        raise RuntimeError(
            f"还没有 {label} 能用的 provider：需要先在「模型与 Agent」里「添加 provider」，"
            f"填好 Key，接口类型选 {'、'.join(dialects)}。"
        )
    outcome = await ctx.ask(
        job,
        "provider.choose",
        f"让 {label} 使用哪个 provider？",
        detail=(
            f"{label} 会改用这个 provider 的地址、Key 和模型，不再用它自己的登录。"
            "Key 只在运行时交给 Agent，不会保存到别处。"
        ),
        options=[option("p:" + item["id"], f"{item.get('label') or item['id']}（{len(item.get('models') or [])} 个模型）") for item in found]
        + [option("cancel", "取消")],
    )
    chosen = outcome.option_id or ""
    if outcome.canceled or not chosen.startswith("p:"):
        return None
    return chosen[2:]


def note(label: str, provider: Provider) -> str:
    return f"现在用的是 provider「{provider.label}」，不用 {label} 自己的登录。"


def actions(ctx: AgentContext, label: str, available: bool = True) -> List[dict]:
    """Where to pick or leave a provider; ``available`` is False for an
    Agent that cannot be pointed at one."""
    if not available:
        return []
    if bound(ctx):
        return [
            AgentContext.action("provider-use", "换一个 provider", group="account"),
            AgentContext.action("provider-leave", f"改用 {label} 自己的登录", group="account"),
        ]
    return [AgentContext.action("provider-use", "使用已配置的 provider", group="account")]
