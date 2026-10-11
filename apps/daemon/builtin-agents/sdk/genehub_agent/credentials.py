"""An API key a person typed into a request card, kept for one Agent.

For a CLI that has no command to save a key, GeneHub keeps it in the Agent's
own state directory (owner-only) and hands it to every process the Agent
starts as the environment variable that CLI documents. Nothing is written to
the CLI's own configuration, so removing the key (``clear``) leaves the
person's other logins exactly as they were.

The values are masked in every log the moment they are loaded or saved.
"""

from __future__ import annotations

import json
import os
from typing import Dict, Optional

from .serve import AgentContext

FILE = "credentials.json"

# What the environment held before a stored value replaced it.
_SHADOWED: Dict[str, Optional[str]] = {}


def _path(ctx: AgentContext) -> str:
    return os.path.join(ctx.state_dir, FILE)


def load(ctx: AgentContext) -> Dict[str, str]:
    try:
        with open(_path(ctx), "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if isinstance(key, str) and isinstance(item, str) and item}


def _write(ctx: AgentContext, values: Dict[str, str]) -> None:
    os.makedirs(ctx.state_dir, exist_ok=True)
    path = _path(ctx)
    temp = path + ".tmp"
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(values, handle)
    os.replace(temp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def apply(ctx: AgentContext) -> Dict[str, str]:
    """Exports the stored values into this process's environment (so every
    CLI the Agent starts sees them) and masks them in logs."""
    values = load(ctx)
    for key, value in values.items():
        _SHADOWED.setdefault(key, os.environ.get(key))
        os.environ[key] = value
        ctx.add_secret(value)
    return values


def save(ctx: AgentContext, values: Dict[str, str]) -> None:
    """Replaces what is stored and puts it in force at once."""
    clear(ctx)
    clean = {key: value.strip() for key, value in values.items() if value and value.strip()}
    _write(ctx, clean)
    apply(ctx)


def clear(ctx: AgentContext) -> None:
    """Forgets the stored values and gives the environment back what it had."""
    stored = load(ctx)
    try:
        os.remove(_path(ctx))
    except FileNotFoundError:
        pass
    for key in stored:
        if key in _SHADOWED:
            before = _SHADOWED.pop(key)
            if before is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = before


def has(ctx: AgentContext) -> bool:
    return bool(load(ctx))
