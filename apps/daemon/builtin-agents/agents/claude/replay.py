"""Offline checks for Claude Code: the shared family cases plus Claude's own."""

from __future__ import annotations

from typing import Any, Optional

from genehub_agent.claude_family import replay as family
from genehub_agent.testing import subset

import spec as claude_agent


def run_status(case: dict, flavor: Any) -> Optional[str]:
    for entry in case["outputs"]:
        got = claude_agent.status_from_output(entry["text"])
        problem = subset(entry["expect"], got, "status")
        if problem:
            return f"{entry['text']!r}: {problem}"
    return None


def run(case: dict, agent: Any) -> Optional[str]:
    return family.run(case, claude_agent.CLAUDE, {"status": run_status}, agent)
