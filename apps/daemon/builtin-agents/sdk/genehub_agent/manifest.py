"""``agent.genet.json``: the only file the daemon reads without running code.

``.genet.json`` is the platform's suffix for files it reads without executing
anything. An Agent that still ships the flat TOML ``agent.toml`` keeps working;
the daemon reads that too, but it cannot declare ``launchingEnv``.

The daemon parses the same files with its own reader
(``apps/daemon/src/adapter/script/layout.rs``); anything the SDK accepts here
has to be accepted there as well.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import List, Optional

PROTOCOL = 1
MANIFEST_FILE = "agent.genet.json"
LEGACY_MANIFEST_FILE = "agent.toml"
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_LINE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(".*"|-?\d+)\s*(#.*)?$')


@dataclass
class Manifest:
    protocol: int
    label: str
    entry: str = "agent.py"
    description: Optional[str] = None
    icon: Optional[str] = None
    # What this Agent exports for the shell it gives its own tools. The host
    # drops these before it starts anything, so a daemon started from inside an
    # Agent's session does not hand that session's identity to every process it
    # starts afterwards.
    launching_env: List[str] = field(default_factory=list)


class ManifestError(ValueError):
    pass


def _check(manifest: Manifest) -> Manifest:
    if manifest.protocol != PROTOCOL:
        raise ManifestError(f"manifest protocol must be {PROTOCOL}, got {manifest.protocol!r}")
    if not manifest.label.strip():
        raise ManifestError("manifest needs a non-empty label")
    if manifest.entry.startswith(("/", "\\")) or ".." in manifest.entry.replace("\\", "/").split("/"):
        raise ManifestError("manifest entry must be a relative path inside the Agent directory")
    return manifest


def parse_manifest(text: str) -> Manifest:
    """Parse the JSON manifest."""
    try:
        values = json.loads(text)
    except ValueError as error:
        raise ManifestError(f"{MANIFEST_FILE} is not valid JSON: {error}") from None
    if not isinstance(values, dict):
        raise ManifestError(f"{MANIFEST_FILE} must hold an object")
    launching = values.get("launchingEnv", [])
    if not isinstance(launching, list) or not all(isinstance(name, str) for name in launching):
        raise ManifestError(f"{MANIFEST_FILE} launchingEnv must be a list of names")
    return _check(
        Manifest(
            protocol=values.get("protocol", 0),
            label=values.get("label", ""),
            entry=values.get("entry", "agent.py"),
            description=values.get("description"),
            icon=values.get("icon"),
            launching_env=list(launching),
        )
    )


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


def parse_legacy_manifest(text: str) -> Manifest:
    """Parse the flat TOML manifest Agents were written against at first."""
    values = {}
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _LINE.match(stripped)
        if not match:
            raise ManifestError(f"{LEGACY_MANIFEST_FILE} line {number}: expected key = value")
        key, raw = match.group(1), match.group(2)
        values[key] = _unquote(raw) if raw.startswith('"') else int(raw)
    return _check(
        Manifest(
            protocol=values.get("protocol", 0),
            label=values.get("label", ""),
            entry=values.get("entry", "agent.py"),
            description=values.get("description"),
            icon=values.get("icon"),
        )
    )


def read_manifest(agent_dir: str) -> Manifest:
    path = os.path.join(agent_dir, MANIFEST_FILE)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as handle:
            return parse_manifest(handle.read())
    with open(os.path.join(agent_dir, LEGACY_MANIFEST_FILE), "r", encoding="utf-8") as handle:
        return parse_legacy_manifest(handle.read())
