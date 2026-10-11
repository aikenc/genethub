"""Pointing Codex at a model provider configured in GeneHub.

Codex reads its providers from ``config.toml``; GeneHub does not edit that
file (it is the person's own, and in the shared mode it is shared with their
terminal). The same settings can be given to one ``codex app-server`` process
as ``-c key=value`` overrides, and the key is read from an environment
variable the provider table names, so nothing is written anywhere: the
provider lives exactly as long as the process that was started with it.
"""

from __future__ import annotations

import json
from typing import Dict, List

from genehub_agent import providers

# The provider table's name inside Codex. Fixed, so it can never collide with
# or shadow a provider the person wrote themselves.
TABLE = "genehub"
KEY_VARIABLE = "GENEHUB_PROVIDER_API_KEY"
# What Codex's provider tables accept on the wire protocol today.
WIRE_API = "responses"
DIALECTS = ("openai",)


def _toml(value: str) -> str:
    # A JSON string is a valid TOML basic string for everything a URL, a model
    # id or a label can contain.
    return json.dumps(value, ensure_ascii=False)


def arguments(provider: providers.Provider) -> List[str]:
    """The ``-c`` overrides that make ``codex app-server`` use ``provider``."""
    settings = [
        f"model_provider={_toml(TABLE)}",
        f"model_providers.{TABLE}.name={_toml(provider.label)}",
        f"model_providers.{TABLE}.base_url={_toml(provider.base_url)}",
        f"model_providers.{TABLE}.env_key={_toml(KEY_VARIABLE)}",
        f"model_providers.{TABLE}.wire_api={_toml(WIRE_API)}",
        f"model={_toml(provider.models[0])}",
    ]
    arguments: List[str] = []
    for setting in settings:
        arguments += ["-c", setting]
    return arguments


def environment(provider: providers.Provider) -> Dict[str, str]:
    return {KEY_VARIABLE: provider.api_key}


def hello(provider: providers.Provider) -> dict:
    """The model table Codex's own ``model/list`` would not know: the
    provider's models, none of which has effort levels Codex could name."""
    models = [{"id": model, "label": model, "reasoning": False, "efforts": [], "supportsFast": False} for model in provider.models]
    return {"models": models, "defaultModel": provider.models[0], "defaultEffort": None}
