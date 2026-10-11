"""What a Claude-protocol CLI says it can do: models, commands, modes.

The model and command lists come from the CLI's own answer to an
``initialize`` control request, asked of a throwaway process (nothing reaches
a model). The permission modes are read from ``--help``. Nothing here is a
list GeneHub made up: every id offered is one the CLI itself will accept.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from typing import Any, Dict, List, Optional

from .. import process
from .flavor import UNRESTRICTED_SETTINGS, Flavor

CONTROL_TIMEOUT = 30.0
HELP_TIMEOUT = 10.0

MODE_DEFAULT = "default"
MODE_ASK_ALIAS = "manual"
MODE_ACCEPT_EDITS = "acceptEdits"
MODE_PLAN = "plan"
MODE_BYPASS = "bypassPermissions"
DEFAULT_PERMISSION_MODE = MODE_BYPASS

# Not every name in the CLI's ``--permission-mode`` list is offered: `auto` and
# `dontAsk` exist, but nothing says what either does differently from these,
# and a switch whose effect cannot be stated is worse than no switch.
MODES = [
    (MODE_ACCEPT_EDITS, "Accept edits", "Apply file edits and commands without asking"),
    (MODE_PLAN, "Plan", "Read and plan only — no edits and no commands"),
    (MODE_BYPASS, "Bypass permissions", "Never ask about anything. Only for a workspace you could afford to lose"),
]


# -- --help ------------------------------------------------------------------------


async def read_help(program: str, flavor: Flavor, env: Dict[str, str]) -> str:
    """The CLI's help text, extended with the permission modes its parser
    accepts when the help is cut short (some builds exit before piped help is
    flushed): each mode is tried with a throwaway ``--version`` run, which
    validates the options before it and reaches no model."""
    text = ""
    try:
        done = await process.run([program, *flavor.help_args], env=env, timeout=HELP_TIMEOUT)
        text = done.stdout + "\n" + done.stderr
    except (OSError, TimeoutError):
        pass
    if "--permission-mode" in text:
        return text
    accepted: List[str] = []
    for ask in (MODE_ASK_ALIAS, MODE_DEFAULT):
        if await _accepts(program, flavor, ask, env):
            accepted.append(ask)
            break
    for mode in (MODE_ACCEPT_EDITS, MODE_PLAN, MODE_BYPASS):
        if await _accepts(program, flavor, mode, env):
            accepted.append(mode)
    return text + "\n--permission-mode choices: " + json.dumps(accepted) + "\n"


async def _accepts(program: str, flavor: Flavor, mode: str, env: Dict[str, str]) -> bool:
    try:
        done = await process.run([program, "--permission-mode", mode, "--version"], env=env, timeout=CONTROL_TIMEOUT)
    except (OSError, TimeoutError):
        return False
    return done.ok


def _choices(help_text: str) -> str:
    after = help_text.split("--permission-mode", 1)
    return after[1][:400] if len(after) > 1 else ""


def mode_listed(help_text: str, mode: str) -> bool:
    choices = _choices(help_text)
    return any(spelling in choices for spelling in (f'"{mode}"', f"'{mode}'", f" {mode},", f" {mode} "))


def ask_mode_in(help_text: str) -> Optional[str]:
    """The "ask about everything" mode as this build spells it. Both names mean
    the same thing and no build accepts both; ``default`` is preferred only
    because it is the newer one. "default" is an ordinary word in a help text,
    so only the choices of ``--permission-mode`` are consulted."""
    choices = _choices(help_text)

    def listed(name: str) -> bool:
        return any(spelling in choices for spelling in (f'"{name}"', f"'{name}'", f" {name},"))

    if listed(MODE_DEFAULT):
        return MODE_DEFAULT
    if listed(MODE_ASK_ALIAS):
        return MODE_ASK_ALIAS
    return None


def modes_in(help_text: str) -> List[dict]:
    modes = [{"id": MODE_BYPASS, "label": "Bypass permissions", "description": "Never ask about tool use"}]
    ask = ask_mode_in(help_text)
    if ask:
        modes.append({"id": ask, "label": "Default", "description": "Ask before every tool call"})
    for mode, label, description in MODES:
        if mode != MODE_BYPASS and mode_listed(help_text, mode):
            modes.append({"id": mode, "label": label, "description": description})
    return modes


def initial_permission_mode(requested: Optional[str], help_text: str) -> str:
    if requested:
        if requested in (MODE_DEFAULT, MODE_ASK_ALIAS):
            return ask_mode_in(help_text) or requested
        if any(mode == requested for mode, _, _ in MODES):
            return requested
    return DEFAULT_PERMISSION_MODE


def is_known_mode(mode: str) -> bool:
    return mode in (MODE_DEFAULT, MODE_ASK_ALIAS) or any(known == mode for known, _, _ in MODES)


# -- initialize --------------------------------------------------------------------


def base_args(flavor: Flavor) -> List[str]:
    return [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]


async def initialize(program: str, flavor: Flavor, env: Dict[str, str], cwd: str, timeout: float = CONTROL_TIMEOUT) -> Optional[dict]:
    """One ``initialize`` control request against a process of its own, which
    is ended with the answer. ``--print`` waits for a prompt it is never going
    to get, so it does not exit on its own. ``cwd`` is somewhere that exists
    and says nothing about the user's projects: the answer is cached for every
    workspace."""
    argv = [program, *base_args(flavor), flavor.skip_permissions_flag, "--settings", UNRESTRICTED_SETTINGS]
    try:
        child = await process.spawn(
            argv,
            cwd=cwd,
            env={**env, **flavor.sandbox()},
            stdin=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return None
    request = {"type": "control_request", "request_id": "genehub_initialize", "request": {"subtype": "initialize"}}

    async def ask() -> Optional[dict]:
        assert child.stdin is not None and child.stdout is not None
        child.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
        await child.stdin.drain()
        while True:
            raw = await child.stdout.readline()
            if not raw:
                return None
            try:
                frame = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            if not isinstance(frame, dict) or frame.get("type") != "control_response":
                continue
            response = frame.get("response")
            if not isinstance(response, dict):
                continue
            if response.get("subtype") != "success":
                return None
            answer = response.get("response")
            return answer if isinstance(answer, dict) else None

    try:
        return await asyncio.wait_for(ask(), timeout)
    except (asyncio.TimeoutError, OSError):
        return None
    finally:
        await process.kill_tree(child)


# -- reading the answer ----------------------------------------------------------------


def _text(value: Any, key: str) -> Optional[str]:
    found = value.get(key) if isinstance(value, dict) else None
    if isinstance(found, str) and found.strip():
        return found.strip()
    return None


def models_in(hello: Optional[dict]) -> List[dict]:
    """The aliases this CLI says it can be pointed at, as it names them:
    Claude calls an alias ``value``/``displayName``, CodeBuddy ``id``/``name``.
    Either is a value ``set_model`` can send back."""
    raw = hello.get("models") if isinstance(hello, dict) else None
    models: List[dict] = []
    for model in raw if isinstance(raw, list) else []:
        model_id = _text(model, "value") or _text(model, "id")
        if not model_id:
            continue
        takes_effort = bool(model.get("supportsEffort"))
        levels = model.get("supportedEffortLevels")
        efforts = [level for level in levels if isinstance(level, str)] if takes_effort and isinstance(levels, list) else []
        models.append(
            {
                "id": model_id,
                "label": _text(model, "displayName") or _text(model, "name") or model_id,
                "reasoning": takes_effort or bool(model.get("supportsAdaptiveThinking")),
                # Only when it says it takes them: a level sent to a model that
                # has none is a control that pretends to work.
                "efforts": efforts,
                "supportsFast": False,
            }
        )
    return models


def efforts_of(models: List[dict]) -> List[str]:
    levels: List[str] = []
    for model in models:
        for level in model.get("efforts") or []:
            if level not in levels:
                levels.append(level)
    return levels


def reported_model(hello: Optional[dict]) -> Optional[str]:
    """Which model the CLI says is current (Claude: ``model``; CodeBuddy:
    ``currentModelId``)."""
    for key in ("model", "currentModelId"):
        found = _text(hello, key)
        if found:
            return found
    return None


def shorten(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    kept = text[:limit]
    cut = max(kept.rfind(mark) for mark in (".", "。", "；", ";"))
    cut = cut + 1 if cut >= 0 else len(kept)
    return kept[:cut].rstrip() + "…"


def commands_in(hello: Optional[dict]) -> List[dict]:
    """Slash commands and skills this install has. Running one needs nothing
    from GeneHub: it goes to the CLI as prompt text and the CLI recognises its
    own commands. The names are given without the slash."""
    raw = hello.get("commands") if isinstance(hello, dict) else None
    commands: List[dict] = []
    seen = set()
    for command in raw if isinstance(raw, list) else []:
        name = _text(command, "name")
        if not name:
            continue
        name = name.lstrip("/")
        if not name or name in seen:
            continue
        seen.add(name)
        entry: Dict[str, Any] = {"name": name}
        description = _text(command, "description")
        if description:
            entry["description"] = shorten(description, 240)
        hint = _text(command, "argumentHint")
        if hint:
            entry["argumentHint"] = hint
        commands.append(entry)
    return commands


def build_catalog(hello: Optional[dict], help_text: str) -> dict:
    models = models_in(hello)
    catalog: Dict[str, Any] = {
        "models": models,
        "modes": modes_in(help_text),
        "commands": commands_in(hello),
        "defaultMode": DEFAULT_PERMISSION_MODE,
    }
    # Which model is current is the CLI's to say; when it does not, the first
    # one it listed is its own recommendation.
    default_model = reported_model(hello) or (models[0]["id"] if models else None)
    if default_model:
        catalog["defaultModel"] = default_model
    return catalog
