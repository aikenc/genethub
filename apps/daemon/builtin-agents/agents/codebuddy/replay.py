"""Offline checks for CodeBuddy: the shared family cases plus its own login
protocol (the ACP lines and what may reach the log)."""

from __future__ import annotations

import json
from typing import Any, Optional

from genehub_agent.claude_family import replay as family
from genehub_agent.testing import subset

import spec


def run_acp(case: dict, flavor: Any) -> Optional[str]:
    for entry in case.get("verdicts", []):
        got = spec.verdict_from_line(entry["line"] if isinstance(entry["line"], str) else json.dumps(entry["line"]))
        if got != entry["expect"]:
            return f"verdict_from_line({entry['line']!r}) = {got!r}, expected {entry['expect']!r}"
    for entry in case.get("redacted", []):
        line = entry["line"] if isinstance(entry["line"], str) else json.dumps(entry["line"])
        got = spec.redact_line(line)
        if got != entry["expect"]:
            return f"redact_line({line!r}) = {got!r}, expected {entry['expect']!r}"
        for secret in entry.get("never", []):
            if secret in got:
                return f"redact_line leaked {secret!r}"
    for method in case.get("scripts", []):
        lines = [json.loads(line) for line in spec.acp_script(method).splitlines()]
        problem = subset(
            [
                {"id": 1, "method": "initialize"},
                {"id": 2, "method": "authenticate", "params": {"methodId": method}},
            ],
            lines,
            "script",
        )
        if problem:
            return problem
    return None


def run(case: dict, agent: Any) -> Optional[str]:
    return family.run(case, spec.CODEBUDDY, {"acp": run_acp}, agent)
