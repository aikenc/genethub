"""Codex app-server frames -> GeneHub ``SessionEvent`` JSON.

Pure and synchronous: no process, no I/O. ``codex_session`` feeds it the
frames it reads, ``agent.py replay`` feeds it recorded ones from ``tests/``.

Two pieces:

- :class:`Translator` owns the state of the turn in flight and turns
  notifications (``turn/*``, ``item/*``, ``thread/tokenUsage/updated``...)
  into events. The connection multiplexes sub-agent threads, so every
  notification is matched against both this session's thread and the bound
  upstream turn before it may touch the root turn.
- :class:`AskBook` handles requests *from* the CLI (approvals, questions) and
  maps a person's answer back into the reply app-server expects. Every
  request gets a reply — unanswered means the CLI waits forever.
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from genehub_agent import events

from codex_usage import (
    Usage,
    finalize_output_rate,
    record_first_token,
    record_round_start,
    record_visible_output,
    token_counts,
    usage_in,
    with_live_output_rate,
)

Emit = Callable[[dict], None]
Log = Callable[[str], None]

ALLOW = "allow"
DENY = "deny"
COMPACTION_REASON = "Codex pruned its own history to make room."


def _str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def notification_turn_id(params: Any) -> Optional[str]:
    """Most v2 notifications carry ``turnId``; the lifecycle frames carry the
    same id inside their ``turn`` object."""
    if not isinstance(params, dict):
        return None
    turn_id = _str(params.get("turnId"))
    if turn_id is not None:
        return turn_id
    turn = params.get("turn")
    return _str(turn.get("id")) if isinstance(turn, dict) else None


def message_in(error: Any) -> str:
    if isinstance(error, str):
        return error
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"]
    import json

    return json.dumps(error, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Item helpers


def reasoning_text(item: dict) -> str:
    for field in ("text", "summary"):
        value = item.get(field)
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts = []
            for part in value:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            if parts:
                return "\n\n".join(parts)
    return ""


_SHELL_BINS = ("bash", "sh", "dash", "zsh")
_SHELL_FLAGS = ("-c", "-lc", "-cl")
_SHELL_PREFIXES = (
    "/bin/bash -lc ",
    "/bin/bash -c ",
    "/usr/bin/bash -lc ",
    "/usr/bin/bash -c ",
    "bash -lc ",
    "bash -c ",
    "/bin/sh -lc ",
    "/bin/sh -c ",
    "sh -lc ",
    "sh -c ",
)


def _unquote_once(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    return text


def _unwrap_shell_command(command: str) -> str:
    trimmed = command.strip()
    rest = trimmed
    for prefix in _SHELL_PREFIXES:
        if trimmed.startswith(prefix):
            rest = trimmed[len(prefix):]
            break
    return _unquote_once(rest)


def command_text(command: Any) -> str:
    """A command as this CLI reports it: one string, or the argv it will run."""
    if isinstance(command, str):
        return _unwrap_shell_command(command)
    if isinstance(command, list):
        parts = [part for part in command if isinstance(part, str)]
        if len(parts) >= 3 and parts[0].rsplit("/", 1)[-1] in _SHELL_BINS and parts[1] in _SHELL_FLAGS:
            return " ".join(parts[2:])
        return _unwrap_shell_command(" ".join(parts))
    return ""


def edit_detail(item: dict) -> dict:
    """``changes`` has carried more than one field name across versions; fall
    back to the raw payload rather than an edit with no diff in it."""
    changes = item.get("changes")
    if not isinstance(changes, list):
        return events.unknown_detail(item)
    paths: List[str] = []
    diff = ""
    for change in changes:
        if not isinstance(change, dict):
            continue
        if isinstance(change.get("path"), str):
            paths.append(change["path"])
        for field in ("unifiedDiff", "unified_diff", "diff"):
            text = change.get(field)
            if isinstance(text, str):
                if diff:
                    diff += "\n"
                diff += text
                break
    if not paths:
        return events.unknown_detail(item)
    return events.edit_detail(", ".join(paths), diff)


def tool_status(item: dict, settled: bool) -> str:
    if item.get("error") is not None:
        return "error"
    status = item.get("status")
    if status in ("failed", "error", "errored"):
        return "error"
    if status in ("canceled", "cancelled", "interrupted", "aborted"):
        return "canceled"
    if status in ("completed", "success"):
        return "ok"
    # `item/completed` is the lifecycle authority: a stale `inProgress` field
    # in the final frame must not leave a card spinning forever.
    if settled:
        return "ok"
    return "running"


def sniff_image_mime_base64(data: str) -> Optional[str]:
    if data.startswith("iVBORw0KGgo"):
        return "image/png"
    if data.startswith("/9j/"):
        return "image/jpeg"
    if data.startswith("R0lGOD"):
        return "image/gif"
    if data.startswith("UklGR"):
        return "image/webp"
    return None


def mime_from_path(path: str) -> str:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
    }.get(ext, "application/octet-stream")


def split_image_payload(raw: str) -> Tuple[Optional[str], Optional[str]]:
    if raw.startswith("data:"):
        rest = raw[len("data:"):]
        if ";base64," in rest:
            mediatype, data = rest.split(";base64,", 1)
            return mediatype, data
        return None, None
    return sniff_image_mime_base64(raw), raw


def mcp_result_images(item: dict, name: str) -> List[dict]:
    result = item.get("result")
    blocks = result.get("content") if isinstance(result, dict) else None
    images = []
    for block in blocks if isinstance(blocks, list) else []:
        if not isinstance(block, dict) or block.get("type") != "image":
            continue
        data = _str(block.get("data"))
        if data is None:
            continue
        images.append({"alt": name, "mime": _str(block.get("mimeType")) or "image/png", "dataBase64": data})
    return images


# ---------------------------------------------------------------------------
# Turn state and notification translation


class TurnState:
    def __init__(self) -> None:
        # Our (the daemon's) id for the turn in flight.
        self.id: Optional[str] = None
        # The CLI's id for the same turn; needed to interrupt and to filter.
        self.codex_turn: Optional[str] = None
        # Items the timeline has already been told about.
        self.open: set = set()
        self.usage = Usage()
        # Last thread total, kept only to deduplicate usage notifications.
        self.thread_usage: Optional[Usage] = None
        self.interrupt_requested = False
        # "thread" | "item": one compaction may be reported both ways.
        self.unpaired_compaction: Optional[str] = None
        self.completed_compactions: set = set()


class Translator:
    def __init__(self, emit: Emit, log: Optional[Log] = None) -> None:
        self.emit = emit
        self.log = log or (lambda message: None)
        self.state = TurnState()

    # -- turn lifecycle driven by the session ---------------------------

    def begin_turn(self, turn_id: str) -> None:
        thread_usage = self.state.thread_usage
        self.state = TurnState()
        self.state.id = turn_id
        self.state.thread_usage = thread_usage
        record_round_start(self.state.usage)

    def bind_from_response(self, genehub_turn: str, upstream_turn: str) -> None:
        """The ``turn/start`` response is correlated to our own RPC, so it is
        authoritative if a stale same-thread start raced ahead — but it
        cannot revive a turn that already finished."""
        state = self.state
        if state.id != genehub_turn:
            return
        if state.codex_turn is not None and state.codex_turn != upstream_turn:
            self.log(f"codex turn/start response replaced notification turn {state.codex_turn} with {upstream_turn}")
        state.codex_turn = upstream_turn

    def abandon(self, turn_id: str) -> None:
        if self.state.id == turn_id:
            self.state.id = None

    def fail_crashed(self, message: str) -> None:
        turn_id = self.state.id
        self.state.id = None
        if turn_id is not None:
            self.emit(events.turn_failed(turn_id, message, code="agentCrashed"))

    def is_current_turn(self, params: dict) -> bool:
        return self.state.codex_turn is not None and self.state.codex_turn == notification_turn_id(params)

    def is_current_scope(self, params: dict, expected_thread: Optional[str]) -> bool:
        if not expected_thread:
            return False
        return (
            self.state.id is not None
            and isinstance(params, dict)
            and params.get("threadId") == expected_thread
            and self.is_current_turn(params)
        )

    def _accepts_token_usage(self, params: dict) -> bool:
        state = self.state
        return state.id is None or state.codex_turn is None or self.is_current_turn(params)

    def _progress(self) -> None:
        if self.state.id:
            self.emit(events.turn_progress(self.state.id, with_live_output_rate(self.state.usage).to_wire()))

    # -- notifications ----------------------------------------------------

    def translate(self, method: str, params: Any, expected_thread: Optional[str]) -> None:
        if not isinstance(params, dict):
            params = {}
        if method == "configWarning":
            self.log(f"codex config warning: {params.get('summary') or 'no summary'}")
            return
        if not expected_thread or params.get("threadId") != expected_thread:
            return
        state = self.state
        if method == "turn/started":
            # A duplicate is harmless; a second distinct start while this turn
            # is bound is stale and must not hijack it.
            if state.id is not None and state.codex_turn is None:
                state.codex_turn = notification_turn_id(params)
        elif method == "turn/completed":
            if self.is_current_turn(params):
                self.finish(params)
        elif method == "thread/tokenUsage/updated":
            if self._accepts_token_usage(params):
                self._token_usage(params)
        elif method in ("item/started", "item/completed"):
            if self.is_current_turn(params) and isinstance(params.get("item"), dict):
                self.item_frame(params["item"], method == "item/completed")
        elif method == "item/agentMessage/delta":
            if self.is_current_turn(params):
                self.stream(params, "assistant")
        elif method == "item/reasoning/summaryTextDelta":
            if self.is_current_turn(params):
                self.stream(params, "reasoning")
        elif method == "turn/plan/updated":
            if self.is_current_turn(params):
                self.plan(params)
        elif method == "thread/compacted":
            if self.is_current_turn(params):
                if state.unpaired_compaction == "item":
                    state.unpaired_compaction = None
                elif state.unpaired_compaction is None:
                    state.unpaired_compaction = "thread"
                    if state.id is not None:
                        self.emit(
                            events.item(state.id, events.compaction("compaction-" + uuid.uuid4().hex, COMPACTION_REASON))
                        )

    def _token_usage(self, params: dict) -> None:
        state = self.state
        token_usage = params.get("tokenUsage")
        if not isinstance(token_usage, dict):
            return
        total = token_counts(token_usage["total"]) if "total" in token_usage else None
        previous = state.thread_usage
        changed = (
            total is None
            or previous is None
            or total.input_tokens != previous.input_tokens
            or total.output_tokens != previous.output_tokens
            or total.cache_read_tokens != previous.cache_read_tokens
        )
        state.thread_usage = total if total is not None else previous
        if state.id is None or not changed:
            return
        increment = usage_in(params) if "last" in token_usage else None
        if increment is None and total is not None:
            increment = total.copy()
            if previous is not None:
                increment.input_tokens = max(0, increment.input_tokens - previous.input_tokens)
                increment.output_tokens = max(0, increment.output_tokens - previous.output_tokens)
                increment.cache_read_tokens = max(0, increment.cache_read_tokens - previous.cache_read_tokens)
        if increment is None:
            return
        state.usage.input_tokens += increment.input_tokens
        state.usage.output_tokens += increment.output_tokens
        state.usage.cache_read_tokens += increment.cache_read_tokens
        state.usage.token_usage_status = increment.token_usage_status
        state.usage.llm_rounds += 1
        self._progress()

    def finish(self, params: dict) -> None:
        state = self.state
        turn_id = state.id
        state.id = None
        if turn_id is None:
            return
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        status = turn.get("status") if isinstance(turn.get("status"), str) else "completed"
        failure = turn.get("error")
        interrupted = state.interrupt_requested or status in ("interrupted", "canceled", "cancelled", "aborted")
        if interrupted:
            event = events.turn_canceled(turn_id)
        elif failure is not None:
            event = events.turn_failed(turn_id, message_in(failure))
        elif status == "failed":
            event = events.turn_failed(turn_id, "Codex ended the turn without saying why. 日志里有它这一趟的全部输出。")
        else:
            usage = state.usage.copy()
            finalize_output_rate(usage)
            event = events.turn_completed(turn_id, usage.to_wire(), fork_checkpoint=state.codex_turn)
        state.codex_turn = None
        state.interrupt_requested = False
        state.open.clear()
        self.emit(event)

    def stream(self, params: dict, kind: str) -> None:
        state = self.state
        turn_id = state.id
        item_id = _str(params.get("itemId"))
        delta = _str(params.get("delta")) or ""
        if turn_id is None or item_id is None or not delta:
            return
        record_first_token(state.usage)
        record_visible_output(state.usage, delta)
        if item_id in state.open:
            self.emit(events.text_delta(turn_id, item_id, delta))
            return
        state.open.add(item_id)
        builder = events.assistant_message if kind == "assistant" else events.reasoning
        self.emit(events.item(turn_id, builder(item_id, delta)))

    def plan(self, params: dict) -> None:
        turn_id = self.state.id
        steps = params.get("plan")
        if turn_id is None or not isinstance(steps, list):
            return
        entries = []
        for entry in steps:
            if not isinstance(entry, dict):
                continue
            text = _str(entry.get("step")) or _str(entry.get("text"))
            if text is None:
                continue
            status = entry.get("status")
            if status in ("in_progress", "inProgress"):
                todo_status = "inProgress"
            elif status == "completed":
                todo_status = "completed"
            else:
                todo_status = "pending"
            entries.append({"text": text, "status": todo_status})
        # One list per turn, upserted in place.
        self.emit(events.item(turn_id, events.todo(f"{turn_id}-plan", entries)))

    def item_frame(self, item: dict, settled: bool) -> None:
        state = self.state
        turn_id = state.id
        kind = _str(item.get("type"))
        item_id = _str(item.get("id"))
        if turn_id is None or kind is None or not item_id:
            return

        def text_of(field: str) -> str:
            return _str(item.get(field)) or ""

        def emit(timeline_item: dict) -> None:
            self.emit(events.item(turn_id, timeline_item))

        def tool(name: str, detail: dict, images: Optional[List[dict]] = None, status: Optional[str] = None) -> None:
            emit(events.tool_call(item_id, name, status or tool_status(item, settled), detail, images=images))

        if kind != "contextCompaction":
            state.unpaired_compaction = None

        if kind == "userMessage":
            # Our own copy of what the user said is already on the timeline.
            return
        if kind == "agentMessage":
            state.open.add(item_id)
            if settled:
                record_round_start(state.usage)
                self._progress()
            emit(events.assistant_message(item_id, text_of("text")))
        elif kind == "reasoning":
            state.open.add(item_id)
            emit(events.reasoning(item_id, reasoning_text(item)))
        elif kind == "commandExecution":
            tool(
                "Shell",
                events.shell_detail(
                    command_text(item.get("command")),
                    text_of("aggregatedOutput"),
                    _int(item.get("exitCode")),
                ),
            )
        elif kind == "fileChange":
            tool("Edit", edit_detail(item))
        elif kind == "mcpToolCall":
            tool_name, server = text_of("tool"), text_of("server")
            name = f"{server}.{tool_name}" if server else tool_name
            tool(name, events.unknown_detail(item), images=mcp_result_images(item, name))
        elif kind == "imageView":
            path = text_of("path")
            tool(
                "View image",
                events.overview_detail("read", path, input_text=path),
                images=[{"alt": f"View image: {path}", "mime": mime_from_path(path), "path": path}],
            )
        elif kind == "imageGeneration":
            raw = _str(item.get("result"))
            mime, data = split_image_payload(raw) if raw is not None else (None, None)
            alt = text_of("revisedPrompt") or "Generate image"
            images = [{"alt": alt, "mime": mime or "image/png", "dataBase64": data}] if data is not None else []
            tool("Generate image", events.unknown_detail(item), images=images)
        elif kind == "webSearch":
            # It reports what it searched for, not what it found.
            tool("Web search", events.search_detail(text_of("query")))
        elif kind == "collabAgentToolCall":
            tool("Sub-agent", events.sub_agent_detail(text_of("tool"), text_of("prompt")))
        elif kind == "subAgentActivity":
            path = text_of("agentPath")
            name = "Sub-agent" if not path else ("Main agent" if path == "/root" else path)
            if item.get("kind") == "interrupted":
                status = "canceled"
            else:
                status = "ok" if settled else "running"
            tool(name, events.unknown_detail(item), status=status)
        elif kind == "contextCompaction":
            # Only the completed frame is a boundary, and only once.
            if not settled or item_id in state.completed_compactions:
                return
            state.completed_compactions.add(item_id)
            if state.unpaired_compaction == "thread":
                state.unpaired_compaction = None
                return
            state.unpaired_compaction = "item"
            emit(events.compaction(item_id, COMPACTION_REASON))
        elif kind == "error":
            message = item.get("message")
            emit(events.error_item(item_id, message_in(message if message is not None else item)))
        else:
            # A missing renderer must never become a missing event.
            tool(kind, events.unknown_detail(item))


# ---------------------------------------------------------------------------
# Requests from the CLI


INTERACTIVE_REQUESTS = (
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
)


def is_interactive_request(method: str) -> bool:
    return method in INTERACTIVE_REQUESTS


def unattended_request_result(method: str) -> Optional[dict]:
    """A foreign or stale turn still needs an immediate answer; these are the
    least-authority protocol-valid ones."""
    if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
        return {"decision": "decline"}
    if method in ("item/tool/requestUserInput", "tool/requestUserInput"):
        return {"answers": {}}
    return None


def request_key(upstream_id: Any) -> Optional[str]:
    """JSON-RPC ids may be integers or strings; the reply must echo the
    original type, and integer 1 must stay distinct from string "1"."""
    if isinstance(upstream_id, bool):
        return None
    if isinstance(upstream_id, int):
        return str(upstream_id)
    if isinstance(upstream_id, str):
        return "string:" + upstream_id
    return None


def allow_or_deny() -> List[dict]:
    # There is no "always allow" on this wire; the mode picker is where
    # someone stops being asked.
    return [
        {"id": ALLOW, "label": "Allow", "kind": "allowOnce"},
        {"id": DENY, "label": "Deny", "kind": "reject"},
    ]


def decision(outcome: dict) -> str:
    kind = outcome.get("outcome") if isinstance(outcome, dict) else None
    if kind == "selected" and outcome.get("optionId") == ALLOW:
        return "accept"
    if kind == "canceled":
        return "cancel"
    return "decline"


class Question:
    def __init__(self, question_id: str, header: str, question: str, options: List[Tuple[str, str]]) -> None:
        self.id = question_id
        self.header = header
        self.question = question
        # Option ids we invent (their position), paired with the label to send back.
        self.options = options

    def interaction(self) -> dict:
        return {
            "id": self.id,
            "prompt": self.question,
            "allowMultiple": False,
            # Codex always offers an "Other" answer besides any suggestions.
            "allowFreeform": True,
            "options": [{"id": oid, "label": label} for oid, label in self.options],
        }


def question_in(value: Any) -> Optional[Question]:
    if not isinstance(value, dict):
        return None

    def text(field: str) -> Optional[str]:
        raw = value.get(field)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        return None

    options: List[Tuple[str, str]] = []
    for index, option in enumerate(value.get("options") or [] if isinstance(value.get("options"), list) else []):
        if isinstance(option, dict) and isinstance(option.get("label"), str):
            options.append((str(index), option["label"]))
    qid, header, question = text("id"), text("header"), text("question")
    if qid is None or header is None or question is None:
        return None
    return Question(qid, header, question, options)


def codex_answers(questions: List[Question], outcome: dict) -> Dict[str, Any]:
    submitted = outcome.get("answers") if isinstance(outcome, dict) and outcome.get("outcome") == "answered" else []
    result: Dict[str, Any] = {}
    for question in questions:
        answer = next(
            (a for a in submitted or [] if isinstance(a, dict) and a.get("questionId") == question.id),
            None,
        )
        if answer is None:
            continue
        labels = dict(question.options)
        values = [labels[picked] for picked in answer.get("selectedOptionIds") or [] if picked in labels]
        freeform = answer.get("freeformText")
        if isinstance(freeform, str) and freeform.strip():
            values.append(freeform.strip())
        if values:
            result[question.id] = {"answers": values}
    return result


def _reply(upstream_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": upstream_id, "result": result}


def _reply_error(upstream_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": upstream_id, "error": {"code": code, "message": message}}


class AskBook:
    """What the CLI is waiting for us to answer, and in which shape."""

    def __init__(self, log: Optional[Log] = None, id_prefix: str = "") -> None:
        self.log = log or (lambda message: None)
        self.id_prefix = id_prefix
        # key -> (upstream id, questions or None for a decision)
        self.pending: Dict[str, Tuple[Any, Optional[List[Question]]]] = {}

    def clear(self) -> None:
        self.pending.clear()

    def on_request(self, upstream_id: Any, method: str, params: Any, surface: bool) -> Tuple[List[dict], Optional[dict]]:
        """Returns (events to emit, frame to write back now or None)."""
        if not isinstance(params, dict):
            params = {}
        request_id = request_key(upstream_id)
        if request_id is None:
            return [], _reply_error(upstream_id, -32600, "Invalid Codex request id")
        request_id = self.id_prefix + request_id
        item_id = _str(params.get("itemId"))
        reason = _str(params.get("reason"))
        reason = reason.strip() if reason and reason.strip() else None

        if not surface:
            result = unattended_request_result(method)
            if result is not None:
                return [], _reply(upstream_id, result)

        def ask(title: str) -> dict:
            return events.permission_requested(request_id, title, allow_or_deny(), detail=reason, tool_call_id=item_id)

        if method == "item/commandExecution/requestApproval":
            self.pending[request_id] = (upstream_id, None)
            command = command_text(params.get("command"))
            return [ask(f"Run `{command}`?" if command else "Run a command?")], None
        if method == "item/fileChange/requestApproval":
            self.pending[request_id] = (upstream_id, None)
            return [ask("Apply file changes?")], None
        if method in ("item/tool/requestUserInput", "tool/requestUserInput"):
            raw = params.get("questions") if isinstance(params.get("questions"), list) else []
            parsed = [q for q in (question_in(value) for value in raw) if q is not None]
            if not parsed or len(parsed) != len(raw):
                # Unrenderable: answered as "nobody answered", never guessed.
                return [], _reply(upstream_id, {"answers": {}})
            self.pending[request_id] = (upstream_id, parsed)
            event = events.permission_requested(
                request_id,
                parsed[0].header,
                [],
                kind="question",
                tool_call_id=item_id,
                questions=[q.interaction() for q in parsed],
            )
            return [event], None
        if method == "mcpServer/elicitation/request":
            # A form we cannot render: declined rather than left waiting.
            return [], _reply(upstream_id, {"action": "decline", "content": None, "_meta": None})
        self.log(f"codex asked us something we do not answer: {method}")
        return [], _reply_error(upstream_id, -32601, "GeneHub does not answer this request")

    def respond(self, request_id: str, outcome: dict) -> Tuple[dict, dict]:
        """Returns (frame to write to the CLI, event to emit)."""
        pending = self.pending.pop(request_id, None)
        if pending is None:
            raise RuntimeError(f"Codex request '{request_id}' is no longer pending")
        upstream_id, questions = pending
        if questions is not None:
            result = {"answers": codex_answers(questions, outcome)}
        else:
            result = {"decision": decision(outcome)}
        return _reply(upstream_id, result), events.permission_resolved(request_id, outcome)

    def resolved(self, params: Any, expected_thread: Optional[str]) -> List[dict]:
        """app-server cleared a request itself (another client answered, or
        its turn ended): remove the card without a second reply."""
        if not expected_thread or not isinstance(params, dict) or params.get("threadId") != expected_thread:
            return []
        request_id = request_key(params.get("requestId"))
        if request_id is None:
            return []
        request_id = self.id_prefix + request_id
        if self.pending.pop(request_id, None) is None:
            return []
        return [events.permission_resolved(request_id, {"outcome": "canceled"})]
