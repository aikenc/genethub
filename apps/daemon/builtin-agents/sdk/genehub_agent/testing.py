"""``agent.py test``: the acceptance an Agent (or a person) runs before
``genet agent reload``.

Without ``--live`` it checks what can be checked offline: the manifest, that
the module imports, and every recorded transcript under ``tests/`` through
the Agent's own ``replay`` hook if it defines one. With ``--live`` it also
starts the Agent against the real CLI and prints the state it reports.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from typing import Any, List

from . import _boot


class _RecordingChannel:
    def __init__(self) -> None:
        self.messages: List[dict] = []

    def notify(self, method: str, params: Any = None) -> None:
        self.messages.append({"method": method, "params": params or {}})


def _check_state(state: dict) -> List[str]:
    problems = []
    if not isinstance(state.get("ready"), bool):
        problems.append("state.ready must be a boolean")
    for action in state.get("actions") or []:
        if not action.get("id") or not action.get("label"):
            problems.append(f"action without id/label: {action}")
    catalog = state.get("catalog") or {}
    for model in catalog.get("models") or []:
        if not model.get("id") or not model.get("label"):
            problems.append(f"model without id/label: {model}")
    return problems


async def _live(agent: Any) -> List[str]:
    from .serve import AgentContext, _SecretMask

    channel = _RecordingChannel()
    state_dir = os.environ.get("GENEHUB_AGENT_STATE") or tempfile.mkdtemp(prefix="genehub-agent-test-")
    os.makedirs(state_dir, exist_ok=True)
    ctx = AgentContext(channel, {"agentId": os.path.basename(_boot.AGENT_DIR or ""), "stateDir": state_dir}, _SecretMask(sys.stderr))  # type: ignore[arg-type]
    await asyncio.wait_for(agent.refresh(ctx), timeout=60)
    states = [m["params"] for m in channel.messages if m["method"] == "state"]
    if not states:
        return ["refresh reported no state"]
    print(json.dumps(states[-1], ensure_ascii=False, indent=2))
    return _check_state(states[-1])


def run_tests(agent: Any, live: bool = False) -> int:
    problems: List[str] = []
    manifest = _boot.MANIFEST
    print(f"manifest: {manifest.label} (protocol {manifest.protocol}, entry {manifest.entry})")
    replay = getattr(agent, "replay", None)
    tests_dir = os.path.join(_boot.AGENT_DIR or ".", "tests")
    if os.path.isdir(tests_dir) and callable(replay):
        for name in sorted(os.listdir(tests_dir)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(tests_dir, name), "r", encoding="utf-8") as handle:
                case = json.load(handle)
            try:
                failure = replay(case)
            except Exception as error:  # noqa: BLE001
                failure = f"{error.__class__.__name__}: {error}"
            print(f"{'FAIL' if failure else 'ok  '} {name}{': ' + failure if failure else ''}")
            if failure:
                problems.append(f"{name}: {failure}")
    if live:
        problems.extend(asyncio.run(_live(agent)))
    for problem in problems:
        print(f"problem: {problem}")
    print("passed" if not problems else f"failed ({len(problems)} problems)")
    return 0 if not problems else 1
