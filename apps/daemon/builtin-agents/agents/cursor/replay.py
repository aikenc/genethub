"""Offline checks behind `boot.py <dir> test`: every `tests/*.json` case is
one of the kinds below, run against the real translation code with no CLI.

Expected values are subsets: a dict matches when every expected key matches,
a list when it has the same length and each element matches.
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any, List, Optional

import cursor_print
import lifecycle
import models as cursor_models


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
            texts.append([event["item"]["id"], event["item"]["text"]])
        elif event.get("type") == "itemDelta" and event["delta"].get("kind") == "text":
            for entry in reversed(texts):
                if entry[0] == event["itemId"]:
                    entry[1] += event["delta"]["delta"]
                    break
    return [text for _, text in texts]


def run_translate(case: dict) -> Optional[str]:
    state = cursor_print.TurnState(case.get("turnId", "turn_1"), prompt=case.get("prompt", ""))
    emitted: List[dict] = []
    chat_id = None
    for line in case["lines"]:
        found = cursor_print.translate_event(line, state, emitted.append)
        chat_id = found or chat_id
    expect = case["expect"]
    visible = [event for event in emitted if event.get("type") != "turnProgress"]
    checks = [
        ("events", visible),
        ("assistantTexts", assistant_texts(emitted)),
        ("partial", state.partial),
        ("chatId", chat_id),
    ]
    for key, actual in checks:
        if key in expect:
            problem = subset(expect[key], actual, key)
            if problem:
                return problem
    if "progressEvents" in expect:
        count = sum(1 for event in emitted if event.get("type") == "turnProgress")
        if count != expect["progressEvents"]:
            return f"progressEvents: expected {expect['progressEvents']}, got {count}"
    if "final" in expect:
        final = cursor_print.final_event(state.id or "", state, bool(case.get("canceled")), "Cursor 退出了（退出码 1）")
        return subset(expect["final"], final, "final")
    return None


def run_models(case: dict) -> Optional[str]:
    raw, default = cursor_models.models_from_cli_list(case["cliList"])
    expect = case.get("expect", {})
    if "rawIds" in expect:
        problem = subset(expect["rawIds"], [model["id"] for model in raw], "rawIds")
        if problem:
            return problem
    if "rawDefault" in expect and expect["rawDefault"] != default:
        return f"rawDefault: expected {expect['rawDefault']!r}, got {default!r}"
    grouped, grouped_default = cursor_models.group_cli_models(raw, default)
    if "grouped" in expect:
        by_id = {model["id"]: model for model in grouped}
        for want in expect["grouped"]:
            got = by_id.get(want["id"])
            if got is None:
                return f"grouped: no model {want['id']}"
            problem = subset(want, got, f"grouped[{want['id']}]")
            if problem:
                return problem
    if "groupedDefault" in expect and expect["groupedDefault"] != grouped_default:
        return f"groupedDefault: expected {expect['groupedDefault']!r}, got {grouped_default!r}"
    for model_id, effort, fast, want in case.get("slugs", []):
        got = cursor_models.launch_slug(model_id, effort, fast, raw)
        if got != want:
            return f"launch_slug({model_id!r}, {effort!r}, {fast}) = {got!r}, expected {want!r}"
    return None


def run_helpers(case: dict) -> Optional[str]:
    for model_id, base, effort, fast in case.get("parse", []):
        got = list(cursor_models.parse_cli_model_id(model_id))
        if got != [base, effort, fast]:
            return f"parse_cli_model_id({model_id!r}) = {got}, expected {[base, effort, fast]}"
    catalog = case.get("legacyCatalog", [])
    for raw_id, want in case.get("legacy", []):
        got = cursor_models.resolve_legacy_model(raw_id, catalog)
        got = list(got) if got is not None else None
        if got != want:
            return f"resolve_legacy_model({raw_id!r}) = {got}, expected {want}"
    for entry in case.get("printArgs", []):
        got = cursor_print.print_args(entry.get("slug"), entry.get("chatId"), entry.get("mode"))
        if got != entry["expect"]:
            return f"print_args({entry}) = {got}"
    for text, want in case.get("status", []):
        got = lifecycle.login_from_status_output(text, "")
        if got != want:
            return f"login_from_status_output({text!r}) = {got}, expected {want}"
    for entry in case.get("interruptedNote", []):
        note = cursor_print.interrupted_note(entry["prompt"], entry["partial"])
        for needle in entry.get("contains", []):
            if needle not in note:
                return f"interrupted note lacks {needle!r}"
        for needle in entry.get("lacks", []):
            if needle in note:
                return f"interrupted note should not contain {needle!r}"
    for entry in case.get("loginUrls", []):
        got = lifecycle.find_login_url(entry["line"])
        if got != entry["url"]:
            return f"find_login_url({entry['line']!r}) = {got!r}"
        if entry["url"] and entry["url"] in lifecycle.hide_urls(entry["line"]):
            return "hide_urls left the login link in the log line"
    guard = case.get("guard")
    if guard:
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "cli-config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(guard["before"], handle)
            saved = cursor_print.snapshot_model_keys(path)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(guard["during"], handle)
            cursor_print.restore_model_keys(path, saved or {})
            with open(path, "r", encoding="utf-8") as handle:
                restored = json.load(handle)
            problem = subset(guard["after"], restored, "guard")
            if problem:
                return problem
    return None


class _StubAgent:
    def __init__(self) -> None:
        self.spawned: List[Any] = []

    def spawn(self, coroutine: Any) -> None:
        coroutine.close()
        self.spawned.append(True)

    def log(self, message: str) -> None:
        return None


class _StubContext:
    def __init__(self, config: Any) -> None:
        self.config = config
        self.agent = _StubAgent()
        self.session_id = config.session_id
        self.emitted: List[dict] = []

    def emit(self, event: dict) -> None:
        self.emitted.append(event)


def run_normalize(case: dict) -> Optional[str]:
    """Session start against a model list: what the old kernel-side
    normalization did, now in the session."""
    from genehub_agent import SessionConfig

    raw, default = cursor_models.models_from_cli_list(case["cliList"])
    listed = cursor_print.Listed(raw, default)
    for entry in case["sessions"]:
        config = SessionConfig.from_wire("s1", entry["config"])
        ctx = _StubContext(config)

        async def relist() -> None:
            return None

        session = cursor_print.CursorSession(ctx, "cursor-agent", relist, lambda: listed)  # type: ignore[arg-type]
        session._flush_changes()
        actual = {
            "modelId": session.model_id,
            "effortId": session.effort_id,
            "fast": session.fast,
            "modeId": session.mode_id,
            "events": ctx.emitted,
            "slug": session._launch_model(),
        }
        problem = subset(entry["expect"], actual, json.dumps(entry["config"]))
        if problem:
            return problem
    return None


def run(case: dict) -> Optional[str]:
    kind = case.get("kind")
    if kind == "translate":
        return run_translate(case)
    if kind == "models":
        return run_models(case)
    if kind == "helpers":
        return run_helpers(case)
    if kind == "normalize":
        return run_normalize(case)
    return f"unknown case kind {kind!r}"
