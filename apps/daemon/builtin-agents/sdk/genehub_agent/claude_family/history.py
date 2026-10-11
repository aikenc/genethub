"""Reading the CLI's own session files, to list and import past conversations.

Both CLIs keep one JSONL file per session under
``<config dir>/projects/<project key>/<session id>.jsonl``. How the project
key is made from a workspace path is each CLI's own business and is
reproduced here exactly, so a session started in a terminal is found from
GeneHub and the other way round.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .flavor import Flavor

SESSION_ID = re.compile(r"^[A-Za-z0-9-]+$")


def radix36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    while value > 0:
        value, rest = divmod(value, 36)
        out.append(digits[rest])
    return "".join(reversed(out))


def claude_project_key(path: str) -> str:
    """Non-alphanumerics become ``-``; past 200 characters the key is cut and
    suffixed with the SDK's signed 32-bit JS string hash of the whole path."""
    replaced = "".join(character if (character.isascii() and character.isalnum()) else "-" for character in path)
    if len(replaced) <= 200:
        return replaced
    hash_value = 0
    units = path.encode("utf-16-le")
    for index in range(0, len(units), 2):
        unit = units[index] | (units[index + 1] << 8)
        hash_value = (hash_value * 31 + unit) & 0xFFFFFFFF
    if hash_value >= 0x80000000:
        hash_value -= 0x100000000
    return f"{replaced[:200]}-{radix36(abs(hash_value))}"


def codebuddy_project_key(path: str) -> str:
    """CodeBuddy's ``compressWorkspacePathName``: separators become ``-``,
    runs of ``-`` collapse, the ends are trimmed, and past 255 UTF-8 bytes the
    key is cut at 180 bytes and suffixed with a djb2-xor hash."""
    replaced = ""
    for character in path:
        character = "-" if character in "/\\:" else character
        if character != "-" or not replaced.endswith("-"):
            replaced += character
    normalized = replaced.strip("-")
    encoded = normalized.encode("utf-8")
    if len(encoded) <= 255:
        return normalized
    end = 180
    while end > 0 and (encoded[end] & 0xC0) == 0x80:
        end -= 1
    hash_value = 5381
    for byte in encoded:
        hash_value = ((hash_value * 33) & 0xFFFFFFFF) ^ byte
    return f"{encoded[:end].decode('utf-8')}-{radix36(hash_value)}"


def project_dir(flavor: Flavor, cwd: str) -> str:
    real = os.path.realpath(cwd) if cwd else cwd
    key = codebuddy_project_key(real) if flavor.project_encoding == "codebuddy" else claude_project_key(real)
    return os.path.join(flavor.config_dir(), "projects", key)


def clip(value: str, limit: int) -> str:
    text = value.strip()
    return text[:limit] + "…" if len(text) > limit else text


def history_message(entry: Any) -> Optional[Tuple[str, dict]]:
    """Claude wraps user/assistant content in ``message``; CodeBuddy's
    persisted records use ``type: message`` with a top-level role."""
    if not isinstance(entry, dict):
        return None
    kind = entry.get("type")
    if kind in ("user", "assistant"):
        message = entry.get("message")
        return (kind, message) if isinstance(message, dict) else None
    if kind == "message" and entry.get("role") in ("user", "assistant"):
        return entry["role"], entry
    return None


def message_text(message: dict) -> Optional[str]:
    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text") and isinstance(block.get("text"), str)
        )
    else:
        return None
    return text.strip() or None


def _entries(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and entry.get("isSidechain") is not True:
                yield entry


def _descriptor(flavor: Flavor, path: str) -> Optional[Tuple[str, str]]:
    session_id: Optional[str] = None
    title: Optional[str] = None
    for entry in _entries(path):
        if session_id is None and isinstance(entry.get("sessionId"), str):
            session_id = entry["sessionId"]
        if title is None:
            found = history_message(entry)
            if found and found[0] == "user":
                title = message_text(found[1])
        if session_id and title:
            break
    session_id = session_id or os.path.splitext(os.path.basename(path))[0]
    if not session_id:
        return None
    return session_id, title or f"{flavor.label} 会话 {session_id[:8]}"


def list_candidates(flavor: Flavor, cwd: str, limit: int) -> List[dict]:
    directory = project_dir(flavor, cwd)
    try:
        names = [name for name in os.listdir(directory) if name.endswith(".jsonl")]
    except FileNotFoundError:
        return []
    files: List[Tuple[str, float]] = []
    for name in names:
        path = os.path.join(directory, name)
        try:
            files.append((path, os.stat(path).st_mtime))
        except OSError:
            continue
    files.sort(key=lambda pair: pair[1], reverse=True)
    out: List[dict] = []
    for path, modified in files[: max(limit * 3, limit)]:
        try:
            found = _descriptor(flavor, path)
        except OSError:
            continue
        if found is None:
            continue
        session_id, title = found
        out.append(
            {
                "sourceId": session_id,
                "title": clip(title, 120),
                "preview": clip(title, 240),
                "updatedAtMs": int(modified * 1000),
                "continuation": "native",
            }
        )
        if len(out) >= limit:
            break
    return out


def _timestamp_ms(value: Any) -> Optional[int]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp() * 1000)


def show(flavor: Flavor, cwd: str, source_id: str) -> Dict[str, Any]:
    if not source_id or not SESSION_ID.match(source_id):
        raise RuntimeError(f"{flavor.label} 会话编号不合法")
    path = os.path.join(project_dir(flavor, cwd), f"{source_id}.jsonl")
    try:
        stat = os.stat(path)
        entries = list(_entries(path))
    except OSError as error:
        raise RuntimeError(f"读不到选中的 {flavor.label} 会话 {path}：{error}") from error
    items: List[dict] = []
    title: Optional[str] = None
    created: Optional[int] = None
    updated = 0
    for entry in entries:
        stamp = _timestamp_ms(entry.get("timestamp"))
        if stamp is not None:
            created = stamp if created is None else min(created, stamp)
            updated = max(updated, stamp)
        found = history_message(entry)
        if found is None:
            continue
        role, message = found
        text = message_text(message)
        if text is None:
            continue
        item_id = "import-" + uuid.uuid4().hex
        if role == "user":
            title = title or clip(text, 120)
            items.append({"type": "userMessage", "id": item_id, "text": text, "attachments": []})
        else:
            items.append({"type": "assistantMessage", "id": item_id, "text": text})
    modified = int(stat.st_mtime * 1000)
    result: Dict[str, Any] = {
        "createdAtMs": created if created is not None else modified,
        "updatedAtMs": updated or modified,
        "items": items,
        "persist": {"sessionId": source_id},
        "continuation": "native",
        "warnings": [],
    }
    if title:
        result["title"] = title
    return result
