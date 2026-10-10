"""Builders for ``SessionEvent`` JSON, exactly as ``genehub_proto`` serializes it.

The daemon deserializes every event into its own types and drops (and logs)
anything that does not fit, so these builders are the shortest path to a
valid event, not the only one: ``packages/proto/bindings/index.ts`` is the
full reference.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional


def now_ms() -> int:
    return int(time.time() * 1000)


# -- usage -------------------------------------------------------------------


def usage(
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    llm_rounds: int = 0,
    tool_output_tokens: int = 0,
    compaction_count: int = 0,
    avg_ttft_ms: Optional[int] = None,
    avg_output_rate_tps: Optional[float] = None,
    output_rate_estimated: Optional[bool] = None,
    token_usage_status: Optional[str] = None,
) -> Dict[str, Any]:
    value: Dict[str, Any] = {
        "tokenUsageStatus": token_usage_status or ("reported" if input_tokens or output_tokens or cache_read_tokens or cache_write_tokens else "unavailable"),
        "inputTokens": int(input_tokens),
        "outputTokens": int(output_tokens),
        "cacheReadTokens": int(cache_read_tokens),
        "cacheWriteTokens": int(cache_write_tokens),
        "llmRounds": int(llm_rounds),
        "toolOutputTokens": int(tool_output_tokens),
        "compactionCount": int(compaction_count),
    }
    if avg_ttft_ms is not None:
        value["avgTtftMs"] = int(avg_ttft_ms)
    if avg_output_rate_tps is not None:
        value["avgOutputRateTps"] = float(avg_output_rate_tps)
    if output_rate_estimated is not None:
        value["outputRateEstimated"] = bool(output_rate_estimated)
    return value


# -- timeline items ------------------------------------------------------------


# `receivedAtMs` is left out on purpose: the daemon stamps it when the item
# arrives, and an item without it is what the daemon treats as fresh agent
# output (raw reasoning is kept as a source and shortened for the timeline).


def assistant_message(item_id: str, text: str) -> dict:
    return {"type": "assistantMessage", "id": item_id, "text": text}


def reasoning(item_id: str, text: str) -> dict:
    return {"type": "reasoning", "id": item_id, "text": text}


def user_message(item_id: str, text: str, attachments: Optional[List[dict]] = None) -> dict:
    return {"type": "userMessage", "id": item_id, "text": text, "attachments": attachments or []}


def tool_call(
    item_id: str,
    name: str,
    status: str,
    detail: dict,
    images: Optional[List[dict]] = None,
    started_at_ms: Optional[int] = None,
    finished_at_ms: Optional[int] = None,
) -> dict:
    """``status`` is one of pending, running, ok, error, canceled."""
    item = {
        "type": "toolCall",
        "id": item_id,
        "name": name,
        "status": status,
        "detail": detail,
        "images": images or [],
    }
    if started_at_ms is not None:
        item["startedAtMs"] = started_at_ms
    if finished_at_ms is not None:
        item["finishedAtMs"] = finished_at_ms
    return item


def todo(item_id: str, entries: List[dict]) -> dict:
    """``entries``: ``[{"text": ..., "status": pending|inProgress|completed|cancelled}]``."""
    return {"type": "todo", "id": item_id, "items": entries}


def compaction(item_id: str, reason: str) -> dict:
    return {"type": "compaction", "id": item_id, "reason": reason}


def error_item(item_id: str, message: str) -> dict:
    return {"type": "error", "id": item_id, "message": message}


# -- tool details ----------------------------------------------------------------


def shell_detail(command: str, output: str = "", exit_code: Optional[int] = None) -> dict:
    detail = {"kind": "shell", "command": command, "output": output}
    if exit_code is not None:
        detail["exitCode"] = exit_code
    return detail


def read_detail(path: str, content: str = "", truncated: bool = False) -> dict:
    return {"kind": "read", "path": path, "content": content, "truncated": truncated}


def edit_detail(path: str, diff: str) -> dict:
    return {"kind": "edit", "path": path, "diff": diff}


def write_detail(path: str, content: str) -> dict:
    return {"kind": "write", "path": path, "content": content}


def search_detail(query: str, matches: Optional[List[dict]] = None) -> dict:
    return {"kind": "search", "query": query, "matches": matches or []}


def fetch_detail(url: str, summary: str = "") -> dict:
    return {"kind": "fetch", "url": url, "summary": summary}


def plan_detail(markdown: str) -> dict:
    return {"kind": "plan", "markdown": markdown}


def sub_agent_detail(agent: str, prompt: str, items: Optional[List[dict]] = None) -> dict:
    return {"kind": "subAgent", "agent": agent, "prompt": prompt, "items": items or []}


def overview_detail(tool_kind: str, overview: str, input_text: str = "", output: str = "") -> dict:
    """``tool_kind``: shell, read, write, edit, search, fetch, plan, subAgent, mcp, other."""
    return {"kind": "overview", "toolKind": tool_kind, "overview": overview, "input": input_text, "output": output}


def unknown_detail(raw: Any) -> dict:
    return {"kind": "unknown", "raw": raw}


# -- events ------------------------------------------------------------------------


def item(turn_id: str, timeline_item: dict) -> dict:
    return {"type": "item", "turnId": turn_id, "item": timeline_item}


def text_delta(turn_id: str, item_id: str, delta: str) -> dict:
    return {"type": "itemDelta", "turnId": turn_id, "itemId": item_id, "delta": {"kind": "text", "delta": delta}}


def tool_status(
    turn_id: str,
    item_id: str,
    status: str,
    detail: Optional[dict] = None,
    images: Optional[List[dict]] = None,
) -> dict:
    delta: Dict[str, Any] = {"kind": "toolStatus", "status": status, "images": images or []}
    if detail is not None:
        delta["detail"] = detail
    return {"type": "itemDelta", "turnId": turn_id, "itemId": item_id, "delta": delta}


def turn_progress(turn_id: str, turn_usage: dict) -> dict:
    return {"type": "turnProgress", "turnId": turn_id, "usage": turn_usage}


def turn_completed(turn_id: str, turn_usage: Optional[dict] = None, fork_checkpoint: Optional[str] = None) -> dict:
    event = {"type": "turnCompleted", "turnId": turn_id, "usage": turn_usage or usage()}
    if fork_checkpoint:
        event["forkCheckpoint"] = fork_checkpoint
    return event


def turn_failed(turn_id: str, message: str, code: str = "upstream") -> dict:
    """``code``: missingCredentials, rateLimited, upstream, timeout, agentCrashed, canceled, internal."""
    return {"type": "turnFailed", "turnId": turn_id, "error": {"code": code, "message": message}}


def turn_canceled(turn_id: str) -> dict:
    return {"type": "turnCanceled", "turnId": turn_id}


def permission_requested(
    request_id: str,
    title: str,
    options: List[dict],
    kind: str = "permission",
    detail: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    questions: Optional[List[dict]] = None,
) -> dict:
    """``options``: ``[{"id", "label", "kind": allowOnce|allowAlways|reject}]``;
    ``kind``: permission, question or planApproval."""
    request: Dict[str, Any] = {"id": request_id, "kind": kind, "title": title, "options": options}
    if detail is not None:
        request["detail"] = detail
    if tool_call_id is not None:
        request["toolCallId"] = tool_call_id
    if questions:
        request["questions"] = questions
    return {"type": "permissionRequested", "request": request}


def permission_resolved(request_id: str, outcome: dict) -> dict:
    return {"type": "permissionResolved", "requestId": request_id, "outcome": outcome}


def model_changed(model_id: str) -> dict:
    return {"type": "modelChanged", "modelId": model_id}


def mode_changed(mode_id: str) -> dict:
    return {"type": "modeChanged", "modeId": mode_id}


def effort_changed(effort_id: str) -> dict:
    return {"type": "effortChanged", "effortId": effort_id}


def fast_changed(fast: bool) -> dict:
    return {"type": "fastChanged", "fast": bool(fast)}


def runtime_axis_changed(axis_id: str, value_id: str) -> dict:
    return {"type": "runtimeAxisChanged", "axisId": axis_id, "valueId": value_id}


def session_status(status: str) -> dict:
    """``status``: idle, running, waiting, readOnly, failed, closed."""
    return {"type": "sessionStatusChanged", "status": status}
