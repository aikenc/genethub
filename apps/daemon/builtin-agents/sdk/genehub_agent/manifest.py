"""``agent.toml``: the only file the daemon reads without running code.

The format is a flat subset of TOML — ``key = "string"`` and ``key = 123`` —
so the SDK can read it on interpreters older than ``tomllib``. The daemon
parses the same file with a full TOML parser; anything beyond this subset is
rejected there too.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

PROTOCOL = 1
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_LINE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(".*"|-?\d+)\s*(#.*)?$')


@dataclass
class Manifest:
    protocol: int
    label: str
    entry: str = "agent.py"
    description: Optional[str] = None
    icon: Optional[str] = None


class ManifestError(ValueError):
    pass


def _unquote(raw: str) -> str:
    body = raw[1:-1]
    out = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def parse_manifest(text: str) -> Manifest:
    values = {}
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _LINE.match(stripped)
        if not match:
            raise ManifestError(f"agent.toml line {number}: expected key = value")
        key, raw = match.group(1), match.group(2)
        values[key] = _unquote(raw) if raw.startswith('"') else int(raw)
    protocol = values.get("protocol")
    if protocol != PROTOCOL:
        raise ManifestError(f"agent.toml protocol must be {PROTOCOL}, got {protocol!r}")
    label = values.get("label")
    if not isinstance(label, str) or not label.strip():
        raise ManifestError("agent.toml needs a non-empty label")
    entry = values.get("entry", "agent.py")
    if not isinstance(entry, str) or entry.startswith(("/", "\\")) or ".." in entry.replace("\\", "/").split("/"):
        raise ManifestError("agent.toml entry must be a relative path inside the Agent directory")
    return Manifest(
        protocol=protocol,
        label=label.strip(),
        entry=entry,
        description=values.get("description") if isinstance(values.get("description"), str) else None,
        icon=values.get("icon") if isinstance(values.get("icon"), str) else None,
    )


def read_manifest(agent_dir: str) -> Manifest:
    path = os.path.join(agent_dir, "agent.toml")
    with open(path, "r", encoding="utf-8") as handle:
        return parse_manifest(handle.read())
