"""Claude-protocol stream-json frames -> GeneHub session events.

Pure functions over a :class:`TurnState`: a frame goes in, events come out
through ``emit``. Nothing here touches a process, so every behaviour can be
replayed from a recorded frame list (see the Agents' ``replay.py``).

What a frame is, in the CLI's own terms:

* ``system`` — the session id (``init``) and ``compact_boundary``.
* ``stream_event`` — partial deltas of the assistant message being written.
  Text and thinking are streamed from here; tool calls are not, because
  ``input_json_delta`` fragments are not valid JSON until the block closes.
* ``assistant`` — the complete message so far. Tool calls open from it, with
  their parsed input.
* ``user`` — tool results (and the CLI's own "interrupted" note).
* ``result`` — the turn is over.
"""

from __future__ import annotations

import difflib
import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from .. import events
from .. import usage as usage_mod

Emit = Callable[[dict], None]

INTERRUPTED_NOTE = "[Request interrupted by user]"
ALLOW = "allow"
ALLOW_ALWAYS = "allow_always"
DENY = "deny"


class TurnState:
    """Everything that changes over the life of one turn."""

    def __init__(self, turn_id: str) -> None:
        self.id = turn_id
        self.counter = 0
        # We asked the CLI to stop this turn; the next error result is
        # therefore a cancellation, however the CLI labels it.
        self.interrupt_requested = False
        # content_block index -> [item id, kind, text so far]. The text lets
        # content_block_stop settle the item with its full text.
        self.open_blocks: Dict[int, List[Any]] = {}
        # tool_use_id -> (item id, tool name, input)
        self.tool_items: Dict[str, Tuple[str, str, Any]] = {}
        # A dispatched sub-agent's own steps, by the tool_use_id of the call
        # that dispatched them.
        self.subs: Dict[str, "Sub"] = {}
        self.usage = usage_mod.Usage()
        self.seen_assistant: set = set()
        # Message ids whose text arrived as deltas, so the snapshot's text is
        # not shown twice.
        self.streamed: set = set()
        self.snapshot_text: set = set()
        # When the prompt reached the CLI, and whether its first frame has been
        # logged: the two timestamps are what tell a CLI that never answered
        # from one whose answer never arrived.
        self.sent_at: Optional[float] = None
        self.first_frame_logged: bool = False
        self.partial = ""

    def next_item_id(self) -> str:
        self.counter += 1
        return f"{self.id}-{self.counter}"


class Sub:
    def __init__(self) -> None:
        self.items: List[dict] = []
        # child tool_use_id -> (index in items, input)
        self.at: Dict[str, Tuple[int, Any]] = {}
        self.counter = 0


def _progress(emit: Emit, state: TurnState) -> None:
    emit(events.turn_progress(state.id, usage_mod.with_live_output_rate(state.usage).to_wire()))


# -- system -------------------------------------------------------------------------------


def translate_system(frame: dict, state: Optional[TurnState], emit: Emit) -> Optional[str]:
    """Returns the session id when this is the ``init`` frame."""
    subtype = frame.get("subtype")
    if subtype == "init":
        session_id = frame.get("session_id")
        return session_id if isinstance(session_id, str) and session_id else None
    if subtype == "compact_boundary" and state is not None:
        meta = frame.get("compact_metadata")
        reason = meta.get("trigger") if isinstance(meta, dict) and isinstance(meta.get("trigger"), str) else "auto"
        emit(events.item(state.id, events.compaction(state.next_item_id(), reason)))
    return None


# -- streamed text ------------------------------------------------------------------------


def translate_stream_event(frame: dict, state: TurnState, emit: Emit) -> None:
    # A sub-agent's partial text is not the conversation's.
    if frame.get("parent_tool_use_id"):
        return
    event = frame.get("event")
    if not isinstance(event, dict):
        return
    kind = event.get("type")
    index = event.get("index") if isinstance(event.get("index"), int) else 0
    if kind == "message_start":
        message = event.get("message")
        message_id = message.get("id") if isinstance(message, dict) else None
        if isinstance(message_id, str):
            state.streamed.add(message_id)
    elif kind == "content_block_start":
        block = event.get("content_block")
        block_kind = block.get("type") if isinstance(block, dict) else None
        if block_kind in ("text", "thinking"):
            # The item opens with its first text: a thinking block the CLI
            # redacts (only a signature arrives) leaves no empty card behind.
            state.open_blocks[index] = [None, block_kind, ""]
    elif kind == "content_block_delta":
        delta = event.get("delta")
        delta = delta if isinstance(delta, dict) else {}
        text = delta.get("text") if delta.get("type") == "text_delta" else delta.get("thinking") if delta.get("type") == "thinking_delta" else None
        if not isinstance(text, str) or not text:
            return
        usage_mod.record_first_token(state.usage)
        usage_mod.record_visible_output(state.usage, text)
        _progress(emit, state)
        open_block = state.open_blocks.get(index)
        if open_block is None:
            return
        if open_block[0] is None:
            open_block[0] = state.next_item_id()
            emit(events.item(state.id, _text_item(open_block[1], open_block[0], "")))
        open_block[2] += text
        if open_block[1] == "text":
            state.partial += text
        emit(events.text_delta(state.id, open_block[0], text))
    elif kind == "content_block_stop":
        open_block = state.open_blocks.pop(index, None)
        if open_block is not None and open_block[0] is not None:
            emit(events.item(state.id, _text_item(open_block[1], open_block[0], open_block[2])))


def _text_item(kind: str, item_id: str, text: str) -> dict:
    return events.reasoning(item_id, text) if kind == "thinking" else events.assistant_message(item_id, text)


# -- tool calls -----------------------------------------------------------------------------


def content_blocks(frame: dict) -> List[dict]:
    message = frame.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def _field(value: Any, key: str) -> str:
    found = value.get(key) if isinstance(value, dict) else None
    return found if isinstance(found, str) else ""


def _line_diff(old: str, new: str) -> str:
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=2))
    # Drop the file header lines; the card already shows the path.
    return "\n".join(line for line in lines if not line.startswith(("---", "+++")))


def detail_from_tool(name: str, tool_input: Any, result: Optional[str]) -> dict:
    """The tool's name is the only signal here (there is no ``kind``), so the
    mapping is a literal table."""
    output = result or ""
    if name == "Bash":
        return events.overview_detail("shell", _field(tool_input, "description"), _field(tool_input, "command"), output)
    if name == "Read":
        return events.read_detail(_field(tool_input, "file_path"), output)
    if name == "Write":
        return events.write_detail(_field(tool_input, "file_path"), _field(tool_input, "content"))
    if name == "Edit":
        diff = _line_diff(_field(tool_input, "old_string"), _field(tool_input, "new_string"))
        return events.edit_detail(_field(tool_input, "file_path"), diff or _field(tool_input, "new_string"))
    if name == "MultiEdit":
        edits = tool_input.get("edits") if isinstance(tool_input, dict) else None
        parts = [
            _line_diff(_field(edit, "old_string"), _field(edit, "new_string"))
            for edit in edits
            if isinstance(edit, dict)
        ] if isinstance(edits, list) else []
        return events.edit_detail(_field(tool_input, "file_path"), "\n".join(part for part in parts if part))
    if name == "NotebookEdit":
        return events.edit_detail(_field(tool_input, "notebook_path") or _field(tool_input, "file_path"), _field(tool_input, "new_source"))
    if name in ("Grep", "Glob"):
        return events.search_detail(_field(tool_input, "pattern"))
    if name == "WebFetch":
        return events.fetch_detail(_field(tool_input, "url"), output)
    if name == "WebSearch":
        return events.fetch_detail(_field(tool_input, "query"), output)
    if name in ("TaskCreate", "TaskList", "TaskUpdate", "TaskGet"):
        return events.plan_detail(output)
    if name == "ExitPlanMode":
        return events.plan_detail(_field(tool_input, "plan"))
    if name in ("Task", "Agent"):
        agent = ""
        if isinstance(tool_input, dict):
            agent = _field(tool_input, "subagent_type") or _field(tool_input, "description")
        return events.sub_agent_detail(agent or "sub-agent", _field(tool_input, "prompt"))
    if name == "AskUserQuestion":
        questions = tool_input.get("questions") if isinstance(tool_input, dict) else None
        asked = "\n".join(_field(q, "question") for q in questions if isinstance(q, dict)) if isinstance(questions, list) else ""
        return events.overview_detail("other", "向你提问", asked, output)
    if name.startswith("mcp__"):
        _, _, rest = name.partition("mcp__")
        server, _, tool = rest.partition("__")
        text = json.dumps(tool_input, ensure_ascii=False) if tool_input not in (None, {}) else ""
        return events.overview_detail("mcp", f"{server}: {tool}" if tool else rest, text, output)
    return events.unknown_detail({"name": name, "input": tool_input})


def tool_result_text(block: dict) -> Optional[str]:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        joined = "\n".join(part["text"] for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
        return joined or None
    return None


def tool_result_images(name: str, tool_input: Any, block: dict) -> List[dict]:
    """Image parts of a tool result. A Read's ``file_path`` becomes the image's
    source path; anything else is bytes the tool produced."""
    content = block.get("content")
    read_path = _field(tool_input, "file_path") if name == "Read" else ""
    images: List[dict] = []
    for part in content if isinstance(content, list) else []:
        if not isinstance(part, dict) or part.get("type") != "image":
            continue
        source = part.get("source")
        data = source.get("data") if isinstance(source, dict) else None
        if not isinstance(data, str) or not data:
            continue
        mime = source.get("media_type") if isinstance(source.get("media_type"), str) else "image/png"
        image = {"alt": f"{name}: {read_path}" if read_path else name, "mime": mime, "dataBase64": data}
        if read_path:
            image["path"] = read_path
        images.append(image)
    return images


_TODO_STATUS = {"pending": "pending", "in_progress": "inProgress", "completed": "completed", "cancelled": "cancelled", "canceled": "cancelled"}


def _todo_entries(tool_input: Any) -> List[dict]:
    todos = tool_input.get("todos") if isinstance(tool_input, dict) else None
    entries: List[dict] = []
    for todo in todos if isinstance(todos, list) else []:
        if not isinstance(todo, dict):
            continue
        text = _field(todo, "content") or _field(todo, "activeForm")
        if text:
            entries.append({"text": text, "status": _TODO_STATUS.get(_field(todo, "status"), "pending")})
    return entries


def _tool_card(item_id: str, name: str, status: str, detail: dict, images: Optional[List[dict]] = None) -> dict:
    return events.tool_call(item_id, name, status, detail, images)


def _sub_agent_detail(state: TurnState, tool_use_id: str, name: str, tool_input: Any, result: Optional[str]) -> dict:
    detail = detail_from_tool(name, tool_input, result)
    sub = state.subs.get(tool_use_id)
    if detail.get("kind") == "subAgent" and sub is not None:
        detail["items"] = list(sub.items)
    return detail


def _collect_sub_tool_calls(frame: dict, parent: str, state: TurnState) -> None:
    parent_item = state.tool_items[parent][0]
    for block in content_blocks(frame):
        if block.get("type") != "tool_use" or not isinstance(block.get("id"), str):
            continue
        name = block.get("name") if isinstance(block.get("name"), str) else "tool"
        tool_input = block.get("input")
        sub = state.subs.setdefault(parent, Sub())
        if block["id"] in sub.at:
            continue
        sub.counter += 1
        sub.at[block["id"]] = (len(sub.items), tool_input)
        sub.items.append(_tool_card(f"{parent_item}-{sub.counter}", name, "running", detail_from_tool(name, tool_input, None)))


def _settle_sub_tool_results(frame: dict, parent: str, state: TurnState) -> None:
    sub = state.subs.get(parent)
    if sub is None:
        return
    for block in content_blocks(frame):
        if block.get("type") != "tool_result":
            continue
        found = sub.at.get(block.get("tool_use_id")) if isinstance(block.get("tool_use_id"), str) else None
        if found is None:
            continue
        index, tool_input = found
        card = sub.items[index]
        status = "error" if block.get("is_error") is True else "ok"
        sub.items[index] = _tool_card(card["id"], card["name"], status, detail_from_tool(card["name"], tool_input, tool_result_text(block)))


def _emit_sub_agent(parent: str, state: TurnState, emit: Emit) -> None:
    """Re-sends the parent call with everything the sub-agent has done so
    far: the card is one item, and an item is only ever replaced whole."""
    entry = state.tool_items.get(parent)
    if entry is None:
        return
    item_id, name, tool_input = entry
    emit(events.item(state.id, _tool_card(item_id, name, "running", _sub_agent_detail(state, parent, name, tool_input, None))))


def translate_assistant(frame: dict, state: TurnState, emit: Emit) -> None:
    """The complete message so far. Tool calls open here; text normally
    arrived as deltas already, and is taken from the snapshot only for a CLI
    that did not stream it."""
    parent = frame.get("parent_tool_use_id")
    if isinstance(parent, str) and parent in state.tool_items:
        _collect_sub_tool_calls(frame, parent, state)
        _emit_sub_agent(parent, state, emit)
        return
    message = frame.get("message")
    message = message if isinstance(message, dict) else {}
    blocks = content_blocks(frame)
    message_id = message.get("id") if isinstance(message.get("id"), str) else None
    if message_id is not None:
        key = message_id
    else:
        tools = [block["id"] for block in blocks if block.get("type") == "tool_use" and isinstance(block.get("id"), str)]
        key = ",".join(tools) if tools else "assistant-text"
    if key not in state.seen_assistant:
        state.seen_assistant.add(key)
        state.usage.llm_rounds += 1
        usage_mod.record_round_start(state.usage)
        reported = message.get("usage") if message.get("usage") is not None else frame.get("usage")
        if reported is not None:
            usage_mod.add_usage(state.usage, reported)
        _progress(emit, state)
    for block in blocks:
        kind = block.get("type")
        if kind in ("text", "thinking") and (message_id is None or message_id not in state.streamed):
            text = block.get("text") if kind == "text" else block.get("thinking")
            if isinstance(text, str) and text.strip():
                marker = (key, kind, text)
                if marker not in state.snapshot_text:
                    state.snapshot_text.add(marker)
                    usage_mod.record_first_token(state.usage)
                    usage_mod.record_visible_output(state.usage, text)
                    if kind == "text":
                        state.partial += text
                    emit(events.item(state.id, _text_item(kind, state.next_item_id(), text)))
            continue
        if kind != "tool_use" or not isinstance(block.get("id"), str) or block["id"] in state.tool_items:
            continue
        name = block.get("name") if isinstance(block.get("name"), str) else "tool"
        tool_input = block.get("input")
        if name == "TodoWrite":
            # One checklist per turn, replaced as the agent updates it.
            state.tool_items[block["id"]] = (f"{state.id}-todo", name, tool_input)
            emit(events.item(state.id, events.todo(f"{state.id}-todo", _todo_entries(tool_input))))
            continue
        item_id = state.next_item_id()
        state.tool_items[block["id"]] = (item_id, name, tool_input)
        emit(events.item(state.id, _tool_card(item_id, name, "running", detail_from_tool(name, tool_input, None))))


def translate_user(frame: dict, state: TurnState, emit: Emit) -> None:
    """Tool results, and the CLI's synthetic note that it honoured an
    interrupt."""
    parent = frame.get("parent_tool_use_id")
    if isinstance(parent, str) and parent in state.tool_items:
        _settle_sub_tool_results(frame, parent, state)
        _emit_sub_agent(parent, state, emit)
        return
    for block in content_blocks(frame):
        kind = block.get("type")
        if kind == "tool_result":
            tool_use_id = block.get("tool_use_id")
            known = state.tool_items.get(tool_use_id) if isinstance(tool_use_id, str) else None
            if known is None or known[1] == "TodoWrite":
                continue
            item_id, name, tool_input = known
            status = "error" if block.get("is_error") is True else "ok"
            # A settled Item rather than a delta: readers that only fold Items
            # must see the finished call, not the "running" one.
            emit(
                events.item(
                    state.id,
                    _tool_card(
                        item_id,
                        name,
                        status,
                        _sub_agent_detail(state, tool_use_id, name, tool_input, tool_result_text(block)),
                        tool_result_images(name, tool_input, block),
                    ),
                )
            )
        elif kind == "text" and block.get("text") == INTERRUPTED_NOTE:
            state.interrupt_requested = True
    content = (frame.get("message") or {}).get("content") if isinstance(frame.get("message"), dict) else None
    if isinstance(content, str) and content.strip() == INTERRUPTED_NOTE:
        state.interrupt_requested = True


# -- end of turn --------------------------------------------------------------------------------


def error_code(message: str) -> str:
    lowered = message.lower()
    if "401" in message or "api key" in lowered or "not logged in" in lowered or "please run /login" in lowered:
        return "missingCredentials"
    if "429" in message or "rate limit" in lowered:
        return "rateLimited"
    return "upstream"


def translate_result(frame: dict, state: TurnState, emit: Emit, label: str) -> None:
    subtype = frame.get("subtype") if isinstance(frame.get("subtype"), str) else ""
    failed = frame.get("is_error") is True or subtype.startswith("error")
    if not failed:
        total = state.usage
        # The result's usage is the turn's own total (sub-agents included);
        # the per-message figures only stand in when it reports none.
        reported = usage_mod.Usage()
        usage_mod.add_usage(reported, frame.get("usage"))
        if reported.input_tokens or reported.output_tokens:
            for field in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "token_usage_status"):
                setattr(total, field, getattr(reported, field))
        cost = frame.get("total_cost_usd")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            total.cost_usd = float(cost)
        usage_mod.finalize_output_rate(total)
        emit(events.turn_completed(state.id, total.to_wire()))
        return
    if state.interrupt_requested:
        emit(events.turn_canceled(state.id))
        return
    errors = frame.get("errors")
    message = None
    if isinstance(errors, list) and errors and isinstance(errors[0], str):
        message = errors[0]
    elif isinstance(frame.get("result"), str) and frame["result"].strip():
        message = frame["result"]
    if message is None:
        message = {"error_max_turns": f"{label} 达到了最大轮数，已停止", "error_during_execution": f"{label} 在执行中出错了"}.get(subtype, f"{label} 报告了一个错误")
    emit(events.turn_failed(state.id, message, error_code(message)))


# -- what the person is asked ----------------------------------------------------------------------


def permission_options(tool_name: str) -> List[dict]:
    return [
        {"id": ALLOW, "label": "Allow", "kind": "allowOnce"},
        {"id": ALLOW_ALWAYS, "label": f"Always Allow {tool_name}", "kind": "allowAlways"},
        {"id": DENY, "label": "Deny", "kind": "reject"},
    ]


def permission_event(request_id: str, request: dict, state: Optional[TurnState]) -> dict:
    tool_name = request.get("tool_name") if isinstance(request.get("tool_name"), str) else "a tool"
    tool_use_id = request.get("tool_use_id")
    known = state.tool_items.get(tool_use_id) if state is not None and isinstance(tool_use_id, str) else None
    # The card was opened from the snapshot that precedes this request; if it
    # was not, the request still goes out, without a card to highlight.
    description = request.get("description") if isinstance(request.get("description"), str) else None
    return events.permission_requested(
        request_id,
        f"Allow {tool_name}?",
        permission_options(tool_name),
        detail=description,
        tool_call_id=known[0] if known else None,
    )


class Question:
    def __init__(self, qid: str, prompt: str, header: str, options: List[str], multiple: bool) -> None:
        self.id = qid
        self.prompt = prompt
        self.header = header
        self.options = options
        self.multiple = multiple

    def interaction(self) -> dict:
        return {
            "id": self.id,
            "prompt": self.prompt,
            "allowMultiple": self.multiple,
            "allowFreeform": True,
            "options": [{"id": str(index), "label": label} for index, label in enumerate(self.options)],
        }


def parse_questions(tool_input: Any) -> Optional[List[Question]]:
    """The agent's own ``AskUserQuestion``. Unrenderable input is answered as
    "nobody answered" by the caller, never guessed."""
    raw = tool_input.get("questions") if isinstance(tool_input, dict) else None
    if not isinstance(raw, list) or not raw:
        return None
    parsed: List[Question] = []
    for index, value in enumerate(raw):
        prompt = _field(value, "question").strip()
        if not prompt:
            return None
        options = [
            option["label"]
            for option in (value.get("options") if isinstance(value.get("options"), list) else [])
            if isinstance(option, dict) and isinstance(option.get("label"), str) and option["label"].strip()
        ]
        parsed.append(Question(str(index), prompt, _field(value, "header").strip(), options, value.get("multiSelect") is True))
    return parsed


def question_event(request_id: str, questions: List[Question], item_id: Optional[str]) -> dict:
    return events.permission_requested(
        request_id,
        questions[0].header or "需要你的回答",
        [],
        kind="question",
        tool_call_id=item_id,
        questions=[question.interaction() for question in questions],
    )


def question_answers(questions: List[Question], outcome: dict) -> Optional[Dict[str, str]]:
    """``{question text: answer}`` as the tool expects it, or None when
    nothing was answered."""
    submitted = outcome.get("answers") if outcome.get("outcome") == "answered" else None
    answers: Dict[str, str] = {}
    for question in questions:
        found = next((a for a in submitted or [] if isinstance(a, dict) and a.get("questionId") == question.id), None)
        if found is None:
            continue
        values = [question.options[int(picked)] for picked in found.get("selectedOptionIds") or [] if str(picked).isdigit() and int(picked) < len(question.options)]
        freeform = found.get("freeformText")
        if isinstance(freeform, str) and freeform.strip():
            values.append(freeform.strip())
        if values:
            answers[question.prompt] = ", ".join(values)
    return answers or None
