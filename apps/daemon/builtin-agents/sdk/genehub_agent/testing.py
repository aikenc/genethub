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


def scratch_context(agent_id: str = "test"):
    """An ``AgentContext`` on a throwaway state directory and a channel that
    records what the Agent sent, for replay hooks that drive real flows
    (a login with a fake CLI) instead of one translation function."""
    from .serve import AgentContext, Job, _SecretMask

    channel = _RecordingChannel()
    ctx = AgentContext(
        channel,  # type: ignore[arg-type]
        {"agentId": agent_id, "stateDir": tempfile.mkdtemp(prefix="genehub-agent-test-")},
        _SecretMask(sys.stderr),
    )
    return ctx, channel, Job(channel, "job-test", "test", ctx._mask)  # type: ignore[arg-type]


# -- helpers for replay hooks -----------------------------------------------------------


def subset(expected: Any, actual: Any, path: str = "$") -> Optional[str]:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return f"{path}: expected an object, got {json.dumps(actual, ensure_ascii=False)}"
        for key, value in expected.items():
            if value == "<absent>":
                if key in actual:
                    return f"{path}.{key}: expected absent, got {json.dumps(actual[key], ensure_ascii=False)}"
                continue
            if key not in actual:
                return f"{path}.{key}: missing"
            problem = subset(value, actual[key], f"{path}.{key}")
            if problem:
                return problem
        return None
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return f"{path}: expected {len(expected)} entries, got {json.dumps(actual, ensure_ascii=False)[:400]}"
        for index, (want, got) in enumerate(zip(expected, actual)):
            problem = subset(want, got, f"{path}[{index}]")
            if problem:
                return problem
        return None
    if isinstance(expected, str) and expected.startswith("<contains>"):
        needle = expected[len("<contains>") :]
        return None if isinstance(actual, str) and needle in actual else f"{path}: {actual!r} lacks {needle!r}"
    if expected != actual or type(expected) is not type(actual):
        return f"{path}: expected {json.dumps(expected, ensure_ascii=False)}, got {json.dumps(actual, ensure_ascii=False)}"
    return None


def assistant_texts(emitted: List[dict]) -> List[str]:
    texts: List[List[str]] = []
    for event in emitted:
        if event.get("type") == "item" and event["item"].get("type") == "assistantMessage":
            # An item event with a known id replaces that item, as the daemon does.
            for entry in texts:
                if entry[0] == event["item"]["id"]:
                    entry[1] = event["item"]["text"]
                    break
            else:
                texts.append([event["item"]["id"], event["item"]["text"]])
        elif event.get("type") == "itemDelta" and event["delta"].get("kind") == "text":
            for entry in reversed(texts):
                if entry[0] == event["itemId"]:
                    entry[1] += event["delta"]["delta"]
                    break
    return [text for _, text in texts]


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
