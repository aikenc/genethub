"""The smallest ACP client that reads Cursor's own session store.

Print mode cannot list or replay sessions, so import still goes through
`cursor-agent ... acp`: `initialize`, then `session/list` for candidates and
`session/load` (or `session/resume`) for one session's visible history.
Nothing else of ACP is spoken here.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from genehub_agent.process import child_environment, kill_tree, spawn

PROTOCOL_VERSION = 1
HANDSHAKE_TIMEOUT = 20.0
# Launch flags of the ACP server, the same ones the old adapter used.
ACP_ARGS = ["--force", "--sandbox", "disabled", "--trust", "--approve-mcps", "acp"]


def client_capabilities() -> dict:
    return {
        "fs": {"readTextFile": False, "writeTextFile": False},
        "session": {"configOptions": {"boolean": {}}},
    }


def can_list_sessions(initialized: Any) -> bool:
    capabilities = initialized.get("agentCapabilities") if isinstance(initialized, dict) else None
    session = capabilities.get("sessionCapabilities") if isinstance(capabilities, dict) else None
    if not isinstance(session, dict) or "list" not in session:
        return False
    value = session["list"]
    return value is not None and value is not False


def load_method(initialized: Any) -> Optional[str]:
    capabilities = initialized.get("agentCapabilities") if isinstance(initialized, dict) else None
    if not isinstance(capabilities, dict):
        return None
    if capabilities.get("loadSession") is True:
        return "session/load"
    session = capabilities.get("sessionCapabilities")
    if isinstance(session, dict) and "resume" in session:
        return "session/resume"
    return None


def time_ms(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            from datetime import datetime

            text = value.strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def clip(value: str, limit: int) -> str:
    text = value.strip()
    out = text[:limit]
    if len(text) > limit:
        out += "…"
    return out


def history_items(updates: List[Any]) -> List[dict]:
    items: List[dict] = []
    current_role = ""
    for params in updates:
        update = params.get("update") if isinstance(params, dict) else None
        if not isinstance(update, dict):
            continue
        kind = update.get("sessionUpdate")
        if kind == "user_message_chunk":
            role = "user"
        elif kind == "agent_message_chunk":
            role = "assistant"
        else:
            continue
        content = update.get("content")
        text = content.get("text") if isinstance(content, dict) else None
        if not isinstance(text, str) or not text:
            continue
        if role == current_role and items:
            items[-1]["text"] += text
            continue
        current_role = role
        item_id = f"import-{uuid.uuid4().hex}"
        if role == "user":
            items.append({"type": "userMessage", "id": item_id, "text": text, "attachments": []})
        else:
            items.append({"type": "assistantMessage", "id": item_id, "text": text})
    return items


class AcpProbe:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process
        self.next_id = 1

    @classmethod
    async def start(cls, program: str, cwd: str) -> "AcpProbe":
        process = await spawn(
            [program] + ACP_ARGS,
            cwd=cwd or None,
            env=child_environment(remove=("GENEHUB_CLI",)),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        return cls(process)

    async def _write(self, value: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write((json.dumps(value) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def call(self, method: str, params: dict, timeout: float = HANDSHAKE_TIMEOUT) -> Tuple[Any, List[Any]]:
        request_id = self.next_id
        self.next_id += 1
        await self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            return await asyncio.wait_for(self._answer(method, request_id), timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(f"{method} timed out") from None

    async def _answer(self, method: str, request_id: int) -> Tuple[Any, List[Any]]:
        assert self.process.stdout is not None
        updates: List[Any] = []
        while True:
            raw = await self.process.stdout.readline()
            if not raw:
                raise RuntimeError(f"{method} ended before the ACP agent answered")
            try:
                frame = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            frame_id = frame.get("id")
            if frame_id == request_id and not isinstance(frame_id, bool) and "method" not in frame:
                error = frame.get("error")
                if error is not None:
                    message = error.get("message") if isinstance(error, dict) else None
                    raise RuntimeError(f"{method} failed: {message or 'unknown ACP error'}")
                return frame.get("result"), updates
            if frame.get("method") == "session/update":
                updates.append(frame.get("params"))
                continue
            if frame_id is not None and isinstance(frame.get("method"), str):
                await self._write(
                    {
                        "jsonrpc": "2.0",
                        "id": frame_id,
                        "error": {"code": -32601, "message": f"method not supported: {frame['method']}"},
                    }
                )

    async def initialize(self, timeout: float = HANDSHAKE_TIMEOUT) -> Any:
        result, _ = await self.call(
            "initialize",
            {"protocolVersion": PROTOCOL_VERSION, "clientCapabilities": client_capabilities()},
            timeout,
        )
        return result

    async def stop(self) -> None:
        await kill_tree(self.process)


async def list_candidates(program: str, cwd: str, limit: int, budget: float) -> Optional[List[dict]]:
    deadline = time.monotonic() + budget
    probe = await AcpProbe.start(program, cwd)
    try:
        initialized = await probe.initialize(min(HANDSHAKE_TIMEOUT, max(0.5, deadline - time.monotonic())))
        if not can_list_sessions(initialized):
            return None
        listed, _ = await probe.call(
            "session/list",
            {"cwd": cwd, "cursor": None},
            min(HANDSHAKE_TIMEOUT, max(0.5, deadline - time.monotonic())),
        )
        sessions = listed.get("sessions") if isinstance(listed, dict) else None
        candidates: List[Dict[str, Any]] = []
        for session in sessions if isinstance(sessions, list) else []:
            if not isinstance(session, dict) or not isinstance(session.get("sessionId"), str):
                continue
            title = session.get("title")
            candidates.append(
                {
                    "sourceId": session["sessionId"],
                    "title": title if isinstance(title, str) and title.strip() else "ACP 会话",
                    "preview": "",
                    "updatedAtMs": time_ms(session.get("updatedAt")),
                    "continuation": "native",
                }
            )
        candidates.sort(key=lambda candidate: candidate["updatedAtMs"], reverse=True)
        return candidates[:limit]
    finally:
        await probe.stop()


async def show(program: str, cwd: str, source_id: str) -> dict:
    probe = await AcpProbe.start(program, cwd)
    try:
        initialized = await probe.initialize()
        if not can_list_sessions(initialized):
            raise RuntimeError("this ACP agent does not advertise session import")
        method = load_method(initialized)
        if method is None:
            raise RuntimeError("this ACP agent cannot load the selected session")
        _, updates = await probe.call(method, {"sessionId": source_id, "cwd": cwd, "mcpServers": []})
        items = history_items(updates)
        if not items:
            raise RuntimeError("the ACP agent loaded the session but did not replay its visible history")
        title = next((clip(item["text"], 120) for item in items if item["type"] == "userMessage"), None)
        now = int(time.time() * 1000)
        result: Dict[str, Any] = {
            "createdAtMs": now,
            "updatedAtMs": now,
            "items": items,
            # An ACP session id is not a print-mode chat id. `resumable: false`
            # makes the kernel seed GeneHub's own log on the first prompt, as
            # the old adapter's `accepts_resume` did.
            "persist": {"sessionId": source_id, "resumable": False},
            "continuation": "native",
            "warnings": [],
        }
        if title is not None:
            result["title"] = title
        return result
    finally:
        await probe.stop()
