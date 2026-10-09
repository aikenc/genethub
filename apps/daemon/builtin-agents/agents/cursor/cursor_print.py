"""Cursor sessions in print mode: one short-lived `cursor-agent --print
--output-format stream-json` process per turn.

Cursor's ACP server ignores the launch `--model`, so reasoning effort and
Fast could be shown but never chosen. Print mode honours `--model <slug>` on
every run, so each turn names the exact slug (`grok-4.7-low-fast`) and
continues the conversation through `--resume <chatId>`.

Three consequences shape this file:
- a canceled run is not kept in Cursor's history, so the next prompt carries
  what was interrupted;
- every run rewrites Cursor's global default model in
  `~/.cursor/cli-config.json`, which is restored once no turn is running;
- ACP session ids (import) and print chat ids live in separate stores, so a
  resume value without `chatId` starts a fresh chat.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
import signal
import subprocess
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from genehub_agent import Session, SessionContext, events
from genehub_agent.process import WINDOWS, child_environment, kill_tree, spawn

import models as cursor_models
import usage as usage_mod

LABEL = "Cursor"
# Keys every print run writes into `cli-config.json`.
GLOBAL_MODEL_KEYS = ("model", "selectedModel")
# Enough of an interrupted exchange to pick it up again, not a transcript.
INTERRUPTED_CLIP = 4000
# How long a print run may linger after its `result` before it is ended:
# background work it started can hold stdout open long after the turn is over.
RESULT_EXIT_GRACE = 5.0
# How long to keep reading a pipe once the process itself is gone.
PIPE_SETTLE = 1.0
CHATTER_LINES = 20

MODES = [
    {"id": "agent", "label": "Agent", "description": "Full tool access"},
    {"id": "plan", "label": "Plan", "description": "Read-only planning"},
    {"id": "ask", "label": "Ask", "description": "Read-only questions"},
]

CAPABILITIES = {
    "interrupt": True,
    "setModel": True,
    "setEffort": True,
    "setFast": True,
    "setMode": True,
    # Print mode runs with `--force`: there is no one to ask mid-run.
    "permissions": False,
    "resume": True,
    "fork": False,
    "attachments": True,
}


# ---------------------------------------------------------------------------
# Arguments and prompt


def print_args(slug: Optional[str], chat_id: Optional[str], mode_id: Optional[str]) -> List[str]:
    """Arguments for one print run. The prompt goes to stdin."""
    args = [
        "--print",
        "--single-turn",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--approve-mcps",
    ]
    if slug:
        args += ["--model", slug]
    if chat_id:
        args += ["--resume", chat_id]
    if mode_id in ("plan", "ask"):
        args += ["--mode", mode_id]
    return args


def wrap_system_guidance(context: str) -> str:
    return (
        "<genehub_system_guidance>\n"
        + context
        + "\n</genehub_system_guidance>\n\nThe next block is the user's request."
    )


def clip(text: str, limit: int) -> str:
    text = text.strip()
    clipped = text[:limit]
    if len(text) > limit:
        clipped += "…"
    return clipped


def interrupted_note(prompt: str, partial: str) -> str:
    note = (
        "<genehub_interrupted_turn>\nThe user stopped the previous request before it finished; "
        "it is not in this conversation's history. Take it into account, but only act on the new "
        "request below.\nPrevious request:\n"
    )
    note += clip(prompt, INTERRUPTED_CLIP)
    if partial.strip():
        note += "\nYour partial reply before the stop:\n"
        note += clip(partial, INTERRUPTED_CLIP)
    note += "\n</genehub_interrupted_turn>"
    return note


def extension_for(mime: str) -> str:
    table = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/png": "png",
        "application/pdf": "pdf",
    }
    if mime in table:
        return table[mime]
    if mime.startswith("text/"):
        return "txt"
    if mime.startswith("image/"):
        return "png"
    return "bin"


def attachment_paths(attachments: List[dict], scratch: str) -> List[Tuple[str, str]]:
    """Files the CLI should open, spelled as the host names them. Pasted
    images are spilled into the session scratch directory first."""
    files: List[Tuple[str, str]] = []
    for index, attachment in enumerate(attachments):
        name = attachment.get("name") or ""
        path = attachment.get("path")
        if path:
            files.append((name, path))
            continue
        data = attachment.get("dataBase64")
        if data is None:
            continue
        try:
            payload = base64.b64decode("".join(data.split()), validate=True)
        except (ValueError, TypeError) as error:
            raise RuntimeError(f"decoding a pasted attachment: {error}") from error
        directory = os.path.join(scratch, "attachments")
        os.makedirs(directory, exist_ok=True)
        target = os.path.join(
            directory, f"{uuid.uuid4().hex}-{index}.{extension_for(attachment.get('mime') or '')}"
        )
        with open(target, "wb") as handle:
            handle.write(payload)
        files.append((name, target))
    return files


# ---------------------------------------------------------------------------
# stream-json translation


class TurnState:
    def __init__(self, turn_id: Optional[str] = None, prompt: str = "") -> None:
        self.id = turn_id
        self.counter = 0
        self.text_item: Optional[str] = None
        self.reasoning_item: Optional[str] = None
        # Text already stored on the open assistant item. Print mode then sends
        # that same segment again, still with `timestamp_ms`, before a tool,
        # retry, or question. The end-of-run copy omits `timestamp_ms`.
        self.text_segment = ""
        self.usage = usage_mod.Usage()
        # The user's words for this turn and what Cursor had answered so far,
        # kept for the next prompt if this run is canceled.
        self.prompt = prompt
        self.partial = ""
        # None, ("success", usage-or-None) or ("error", message).
        self.outcome: Optional[Tuple[str, Any]] = None

    def next_item_id(self) -> str:
        self.counter += 1
        return f"{self.id or 't0'}-{self.counter}"


Emit = Callable[[dict], None]


def _emit_progress(emit: Emit, turn_id: str, usage: usage_mod.Usage) -> None:
    if turn_id:
        emit(events.turn_progress(turn_id, usage_mod.with_live_output_rate(usage).to_wire()))


def _close_text_segment(state: TurnState) -> None:
    state.text_item = None
    state.text_segment = ""


def _open_round(state: TurnState) -> None:
    if state.text_item is None and state.reasoning_item is None:
        state.usage.llm_rounds += 1
        usage_mod.record_round_start(state.usage)


def _str_at(value: Any, key: str) -> str:
    if isinstance(value, dict):
        found = value.get(key)
        if isinstance(found, str):
            return found
    return ""


def message_text(event: dict) -> str:
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return ""
    return "".join(
        block["text"]
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    )


def translate_event(event: dict, state: TurnState, emit: Emit) -> Optional[str]:
    """Applies one stream-json event to the turn, emitting timeline events.
    Returns the chat id when the event names one."""
    chat_id = event.get("session_id")
    chat_id = chat_id if isinstance(chat_id, str) and chat_id else None
    turn_id = state.id
    if turn_id is None:
        return chat_id
    kind = event.get("type")
    subtype = event.get("subtype")

    if kind == "thinking" and subtype == "delta":
        delta = event.get("text") if isinstance(event.get("text"), str) else ""
        if not delta:
            return chat_id
        _open_round(state)
        usage_mod.record_first_token(state.usage)
        usage_mod.record_visible_output(state.usage, delta)
        _emit_progress(emit, turn_id, state.usage)
        if state.reasoning_item is not None:
            emit(events.text_delta(turn_id, state.reasoning_item, delta))
        else:
            item_id = state.next_item_id()
            state.reasoning_item = item_id
            _close_text_segment(state)
            emit(events.item(turn_id, {"type": "reasoning", "id": item_id, "text": delta}))
    elif kind == "assistant":
        # Deltas carry `timestamp_ms`. The same segment is written again
        # before a tool, retry, or question, and that copy is timestamped
        # too. The end-of-run copy is not. Both repeat text already stored.
        delta = message_text(event)
        if not delta:
            return chat_id
        repeats_segment = bool(state.text_segment) and delta == state.text_segment
        if "timestamp_ms" not in event or event.get("timestamp_ms") is None or repeats_segment:
            return chat_id
        _open_round(state)
        usage_mod.record_first_token(state.usage)
        usage_mod.record_visible_output(state.usage, delta)
        _emit_progress(emit, turn_id, state.usage)
        state.partial += delta
        state.text_segment += delta
        if state.text_item is not None:
            emit(events.text_delta(turn_id, state.text_item, delta))
        else:
            item_id = state.next_item_id()
            state.text_item = item_id
            state.reasoning_item = None
            emit(events.item(turn_id, {"type": "assistantMessage", "id": item_id, "text": delta}))
    elif kind == "tool_call" and subtype in ("started", "completed"):
        _close_text_segment(state)
        state.reasoning_item = None
        item = tool_item(event, subtype == "completed", state)
        if item is not None:
            emit(events.item(turn_id, item))
    elif kind == "result":
        is_error = event.get("is_error") is True or subtype != "success"
        if is_error:
            text = event.get("result")
            message = text if isinstance(text, str) and text.strip() else "Cursor reported an error"
            state.outcome = ("error", message)
        else:
            state.outcome = ("success", event.get("usage"))
    return chat_id


def compact_json(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def tool_kind(name: str) -> str:
    lower = name.lower()
    if "mcp" in lower:
        return "mcp"
    if "web" in lower or "fetch" in lower:
        return "fetch"
    if "delete" in lower or "write" in lower:
        return "write"
    if "search" in lower or "ls" in lower:
        return "search"
    if "task" in lower or "agent" in lower:
        return "subAgent"
    return "other"


def grep_matches(success: Any) -> List[dict]:
    matches: List[dict] = []
    results = success.get("workspaceResults") if isinstance(success, dict) else None
    if not isinstance(results, dict):
        return matches
    for result in results.values():
        content = result.get("content") if isinstance(result, dict) else None
        files = content.get("matches") if isinstance(content, dict) else None
        for file in files if isinstance(files, list) else []:
            path = _str_at(file, "file")
            hits = file.get("matches") if isinstance(file, dict) else None
            for hit in hits if isinstance(hits, list) else []:
                found: Dict[str, Any] = {"path": path, "preview": clip(_str_at(hit, "content"), 200)}
                line = hit.get("lineNumber") if isinstance(hit, dict) else None
                if isinstance(line, int) and not isinstance(line, bool) and line >= 0:
                    found["line"] = line
                matches.append(found)
    return matches


def _todo_status(raw: str) -> str:
    if raw == "TODO_STATUS_IN_PROGRESS":
        return "inProgress"
    if raw == "TODO_STATUS_COMPLETED":
        return "completed"
    return "pending"


def tool_item(event: dict, completed: bool, state: TurnState) -> Optional[dict]:
    call = event.get("tool_call")
    if not isinstance(call, dict):
        return None
    found = next(
        ((key, value) for key, value in call.items() if key.endswith("ToolCall") and isinstance(value, dict)),
        None,
    )
    if found is None:
        return None
    kind, body = found
    args = body.get("args")
    result = body.get("result")
    success = result.get("success") if isinstance(result, dict) and "success" in result else None
    has_success = isinstance(result, dict) and "success" in result

    if kind == "updateTodosToolCall":
        todos = success.get("todos") if isinstance(success, dict) and "todos" in success else None
        if todos is None and isinstance(args, dict):
            todos = args.get("todos")
        if not isinstance(todos, list):
            return None
        return events.todo(
            state.next_item_id(),
            [{"text": _str_at(todo, "content"), "status": _todo_status(_str_at(todo, "status"))} for todo in todos],
        )

    call_id = event.get("call_id")
    if not isinstance(call_id, str):
        return None
    item_id = call_id.replace("\n", ":").replace("\r", ":")
    if not completed:
        status = "running"
    elif has_success:
        status = "ok"
    else:
        status = "error"

    def failure() -> str:
        return compact_json(result) if result is not None and not has_success else ""

    out = success if has_success else None
    if kind == "shellToolCall":
        output = "\n".join(text for text in (_str_at(out, "stdout"), _str_at(out, "stderr")) if text)
        if not output:
            output = failure()
        exit_code = out.get("exitCode") if isinstance(out, dict) else None
        if not isinstance(exit_code, int) or isinstance(exit_code, bool):
            exit_code = None
        name, detail = "Shell", events.shell_detail(_str_at(args, "command"), output, exit_code)
    elif kind == "readToolCall":
        content = _str_at(out, "content") if has_success else failure()
        truncated = isinstance(out, dict) and out.get("exceededLimit") is True
        name, detail = "Read", events.read_detail(_str_at(args, "path"), content, truncated)
    elif kind == "editToolCall":
        diff = _str_at(out, "diffString") if has_success else failure()
        name, detail = "Edit", events.edit_detail(_str_at(args, "path"), diff)
    elif kind == "grepToolCall":
        name, detail = "Grep", events.search_detail(_str_at(args, "pattern"), grep_matches(out))
    elif kind == "globToolCall":
        files = out.get("files") if isinstance(out, dict) else None
        matches = [
            {"path": file, "preview": ""} for file in (files if isinstance(files, list) else []) if isinstance(file, str)
        ]
        name, detail = "Glob", events.search_detail(_str_at(args, "globPattern"), matches)
    else:
        name = kind[: -len("ToolCall")] if kind.endswith("ToolCall") else kind
        output = compact_json(success) if has_success else failure()
        detail = events.overview_detail(tool_kind(name), name, compact_json(args), output)
    return events.tool_call(item_id, name, status, detail)


def final_event(turn_id: str, state: TurnState, canceled: bool, crashed_message: str = "") -> dict:
    if canceled:
        return events.turn_canceled(turn_id)
    outcome = state.outcome
    if outcome is None:
        return events.turn_failed(turn_id, crashed_message, code="agentCrashed")
    if outcome[0] == "error":
        return events.turn_failed(turn_id, outcome[1], code="upstream")
    turn_usage = state.usage.copy()
    reported = outcome[1]
    if reported is not None:
        parsed = usage_mod.parse_usage(reported)
        if parsed.input_tokens > 0 or parsed.output_tokens > 0:
            previous = turn_usage
            turn_usage = parsed
            turn_usage.llm_rounds = previous.llm_rounds
            turn_usage.tool_output_tokens = previous.tool_output_tokens
            usage_mod.preserve_timing(turn_usage, previous)
    usage_mod.finalize_output_rate(turn_usage)
    return events.turn_completed(turn_id, turn_usage.to_wire())


# ---------------------------------------------------------------------------
# Cursor's global default model


class _GuardState:
    active = 0
    saved: Optional[Dict[str, Any]] = None


def cli_config_path() -> str:
    return os.path.join(os.path.expanduser("~"), ".cursor", "cli-config.json")


def snapshot_model_keys(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(config, dict):
        return None
    return {key: config[key] for key in GLOBAL_MODEL_KEYS if key in config}


def restore_model_keys(path: str, saved: Dict[str, Any]) -> None:
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict):
        raise ValueError("cli-config.json is not an object")
    changed = False
    for key in GLOBAL_MODEL_KEYS:
        before = config.get(key, _MISSING)
        if key in saved:
            config[key] = saved[key]
        else:
            config.pop(key, None)
        changed = changed or config.get(key, _MISSING) != before
    if not changed:
        return
    temp = path[: -len(".json")] + ".json.genehub-tmp" if path.endswith(".json") else path + ".genehub-tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2, ensure_ascii=False)
    os.replace(temp, path)


_MISSING = object()


class GlobalModelGuard:
    """Holds Cursor's global default model steady across print runs. The
    first concurrent turn snapshots the keys; the last one to finish writes
    them back."""

    def __init__(self, log: Callable[[str], None]) -> None:
        self._log = log
        self._held = True
        if _GuardState.active == 0:
            _GuardState.saved = snapshot_model_keys(cli_config_path())
        _GuardState.active += 1

    def release(self) -> None:
        if not self._held:
            return
        self._held = False
        _GuardState.active = max(0, _GuardState.active - 1)
        if _GuardState.active > 0:
            return
        saved, _GuardState.saved = _GuardState.saved, None
        if saved is None:
            return
        try:
            restore_model_keys(cli_config_path(), saved)
        except (OSError, ValueError) as error:
            self._log(f"could not restore Cursor's default model: {error}")


# ---------------------------------------------------------------------------
# The session


async def end_tree(process: asyncio.subprocess.Process) -> None:
    """Ends the run's whole process group, even when the CLI itself already
    left: what it started in the background belongs to the turn, as it did
    in the old adapter (`end_own_tree`)."""
    if WINDOWS or process.returncode is None:
        await kill_tree(process)
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except OSError:
        return
    for _ in range(40):
        await asyncio.sleep(0.05)
        try:
            os.killpg(process.pid, 0)
        except OSError:
            return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        pass


class Listed:
    """Models exactly as `--list-models` printed them (the only ids
    `--model` accepts) and grouped per base model, as the picker shows."""

    def __init__(self, raw: Optional[List[dict]] = None, default: Optional[str] = None) -> None:
        self.raw = list(raw or [])
        self.grouped, self.default_model = cursor_models.group_cli_models(self.raw, default)
        self.raw_default = default


class CursorSession(Session):
    def __init__(self, ctx: SessionContext, program: str, listed: Callable[[], "asyncio.Future"], current: Callable[[], Listed]) -> None:
        super().__init__(ctx)
        config = ctx.config
        self.program = program
        self._refresh_listed = listed
        self._current = current
        self.model_id = config.model_id
        self.effort_id = config.effort_id
        self.fast = bool(config.fast)
        self.mode_id = config.mode_id
        resume = config.resume if isinstance(config.resume, dict) else {}
        chat_id = resume.get("chatId")
        self.chat_id: Optional[str] = chat_id if isinstance(chat_id, str) and chat_id else None
        self.interrupted: Optional[str] = None
        self.turn: Optional[TurnState] = None
        self.process: Optional[asyncio.subprocess.Process] = None
        self.canceled = False
        self.task: Optional[asyncio.Task] = None
        # `send` is between its first await and a running turn; a Stop that
        # lands then is remembered here and ends the turn before it runs.
        self._starting = False
        self._start_canceled = False
        self._pending_changes: List[dict] = []
        self._normalized = False
        self._normalize_selection()
        if self._pending_changes:
            ctx.agent.spawn(self._flush_after_start())

    # -- models -----------------------------------------------------------

    @property
    def listed(self) -> Listed:
        return self._current()

    def _model(self, model_id: Optional[str]) -> Optional[dict]:
        if not model_id:
            return None
        return next((model for model in self.listed.grouped if model["id"] == model_id), None)

    def _normalize_selection(self) -> None:
        """Reconciles the saved selection with what Cursor offers now. The
        kernel passes script Agents' choices through unchanged, so this is
        where ids saved by the old ACP adapter (`grok-4.7[effort=high]`, raw
        CLI slugs) are migrated and stale ones replaced, mirroring the old
        `normalize_runtime_selection` + `resolve_legacy_cursor_model`. Runs
        once, as soon as a model list is known; every change is reported so
        the session's saved choice follows."""
        listed = self.listed
        if self._normalized or not listed.grouped:
            return
        self._normalized = True
        config = self.ctx.config
        changes = self._pending_changes
        model_id = (self.model_id or "").strip()
        if model_id and self._model(model_id) is None:
            migrated = cursor_models.resolve_legacy_model(model_id, listed.grouped)
            if migrated is not None:
                model, effort, fast = migrated
                self.model_id = model
                changes.append(events.model_changed(model))
                if config.effort_id is None and effort is not None:
                    self.effort_id = effort
                    changes.append(events.effort_changed(effort))
                if config.fast is None and fast is not None:
                    self.fast = fast
                    changes.append(events.fast_changed(fast))
            else:
                fallback = listed.default_model if self._model(listed.default_model) else listed.grouped[0]["id"]
                self.model_id = fallback
                changes.append(events.model_changed(fallback))
        if self.mode_id and not any(mode["id"] == self.mode_id for mode in MODES):
            self.mode_id = "agent"
            changes.append(events.mode_changed("agent"))
        model = self._model(self.model_id or listed.default_model)
        if model is not None:
            if self.effort_id is not None and self.effort_id not in model["efforts"]:
                # `effortChanged` cannot clear a choice; a model without
                # levels ignores the stale one in `launch_slug` anyway.
                self.effort_id = cursor_models.default_effort(model["efforts"])
                if self.effort_id is not None:
                    changes.append(events.effort_changed(self.effort_id))
            if self.fast and not model["supportsFast"]:
                self.fast = False
                changes.append(events.fast_changed(False))

    def _flush_changes(self) -> None:
        changes, self._pending_changes = self._pending_changes, []
        for change in changes:
            self.ctx.emit(change)

    async def _flush_after_start(self) -> None:
        # Scheduled during `session.start`; runs after its reply is written,
        # so the daemon already knows the session.
        await asyncio.sleep(0)
        self._flush_changes()

    def _launch_model(self) -> Optional[str]:
        model_id = self.model_id
        if not model_id or not model_id.strip():
            return None
        slug = cursor_models.launch_slug(model_id, self.effort_id, self.fast, self.listed.raw)
        if slug is None:
            raise RuntimeError(f"Cursor 没有列出模型 {model_id}；刷新模型列表或换一个模型后再试")
        return slug

    def _compose_prompt(self, text: str, attachments: List[dict]) -> str:
        prompt = ""
        guidance = self.ctx.config.additional_system_prompt
        if guidance and guidance.strip():
            prompt += wrap_system_guidance(guidance) + "\n\n"
        if self.interrupted is not None:
            prompt += self.interrupted + "\n\n"
            self.interrupted = None
        prompt += text
        files = attachment_paths(attachments, self.ctx.config.scratch_dir)
        if files:
            prompt += "\n\nAttached files (open them with your read tool):"
            for name, path in files:
                prompt += f"\n- {name}: {path}"
        return prompt

    # -- turns ------------------------------------------------------------

    async def send(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        if self.turn is not None or self._starting:
            raise RuntimeError("Cursor 还在处理上一轮")
        self._starting = True
        self._start_canceled = False
        try:
            await self._start_turn(turn_id, text, attachments)
        finally:
            self._starting = False

    async def _start_turn(self, turn_id: str, text: str, attachments: List[dict]) -> None:
        if not self.listed.raw:
            # A failed listing is not remembered; a CLI mid-update must not
            # hide every model until someone restarts.
            await self._refresh_listed()
            self._normalize_selection()
        self._flush_changes()
        if self._start_canceled:
            self.ctx.emit(events.turn_canceled(turn_id))
            return
        slug = self._launch_model()
        interrupted_before = self.interrupted
        prompt = self._compose_prompt(text, attachments)
        argv = [self.program] + print_args(slug, self.chat_id, self.mode_id)
        env = child_environment(self.ctx.config.session_environment(), remove=("GENEHUB_CLI",))
        guard = GlobalModelGuard(self.ctx.agent.log)
        try:
            process = await spawn(
                argv,
                cwd=self.ctx.config.cwd or None,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except Exception as error:
            guard.release()
            self.interrupted = interrupted_before
            raise RuntimeError(f"spawning {self.program}: {error}") from error
        if self._start_canceled:
            # Stopped while the CLI was starting: it never saw the prompt.
            await end_tree(process)
            guard.release()
            self.interrupted = interrupted_before
            self.ctx.emit(events.turn_canceled(turn_id))
            return
        self.ctx.agent.log(
            f"cursor print turn starting (model={slug or '(Cursor default)'}, resume={self.chat_id is not None})"
        )
        self.canceled = False
        self.process = process
        self.turn = TurnState(turn_id, prompt=text)
        usage_mod.record_round_start(self.turn.usage)
        self.ctx.set_pid(process.pid)
        self.task = asyncio.ensure_future(self._run_turn(turn_id, process, prompt, guard))

    async def _run_turn(self, turn_id: str, process: asyncio.subprocess.Process, prompt: str, guard: GlobalModelGuard) -> None:
        said: "collections.deque[str]" = collections.deque(maxlen=CHATTER_LINES)
        stderr_task = asyncio.ensure_future(self._watch_stderr(process, said))
        state = self.turn
        assert state is not None
        try:
            # Print mode reads the prompt from stdin until EOF; an argv prompt
            # hits the OS argument limit once guidance is attached.
            try:
                assert process.stdin is not None
                process.stdin.write(prompt.encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()
            except (OSError, ConnectionError) as error:
                self.ctx.agent.log(f"could not hand the prompt to cursor-agent: {error}")
            await self._read_stdout(process, state)

            canceled, self.canceled = self.canceled, False
            crashed_message = ""
            if state.outcome is None and not canceled:
                crashed_message = await self._stopped(process, stderr_task, said)
            event = final_event(turn_id, state, canceled, crashed_message)
            if not canceled:
                # A run that ended on its own is in Cursor's history; an
                # interruption note set during a race is stale by now.
                self.interrupted = None
            await end_tree(process)
            self.process = None
            self.turn = None
            self.ctx.set_pid(None)
            guard.release()
            self.ctx.emit(event)
        finally:
            guard.release()
            stderr_task.cancel()
            if self.turn is state:
                self.turn = None
            if self.process is process:
                self.process = None
                await end_tree(process)
                self.ctx.set_pid(None)

    async def _read_stdout(self, process: asyncio.subprocess.Process, state: TurnState) -> None:
        assert process.stdout is not None
        exited = asyncio.ensure_future(process.wait())
        settle_deadline: Optional[float] = None
        loop = asyncio.get_event_loop()
        try:
            while True:
                reading = asyncio.ensure_future(process.stdout.readline())
                if settle_deadline is None:
                    timeout = RESULT_EXIT_GRACE if state.outcome is not None else None
                    done, _ = await asyncio.wait({reading, exited}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                    if not done:
                        # The result is in and the run is still holding on:
                        # whatever it left running is not this turn.
                        reading.cancel()
                        return
                    if reading not in done:
                        settle_deadline = loop.time() + PIPE_SETTLE
                if settle_deadline is not None and not reading.done():
                    remaining = settle_deadline - loop.time()
                    if remaining <= 0:
                        reading.cancel()
                        return
                    try:
                        await asyncio.wait_for(reading, remaining)
                    except asyncio.TimeoutError:
                        return
                raw = reading.result()
                if not raw:
                    return
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                chat_id = translate_event(event, state, self.ctx.emit)
                if chat_id and chat_id != self.chat_id:
                    self.chat_id = chat_id
                    self.ctx.set_persist({"chatId": chat_id})
        finally:
            if not exited.done():
                exited.cancel()

    async def _watch_stderr(self, process: asyncio.subprocess.Process, said: "collections.deque[str]") -> None:
        assert process.stderr is not None
        while True:
            raw = await process.stderr.readline()
            if not raw:
                return
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            self.ctx.agent.log(f"cursor: {line}")
            said.append(line)

    async def _stopped(self, process: asyncio.subprocess.Process, stderr_task: asyncio.Task, said: "collections.deque[str]") -> str:
        try:
            await asyncio.wait_for(asyncio.shield(stderr_task), PIPE_SETTLE)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        code: Optional[int] = None
        for _ in range(20):
            if process.returncode is not None:
                code = process.returncode
                break
            await asyncio.sleep(0.05)
        message = f"{LABEL} 退出了（退出码 {code}）" if code is not None else f"{LABEL} 意外退出了"
        if said:
            message += ": " + " / ".join(said)
        else:
            message += "，而且它什么都没说。日志里有它这一趟的全部输出。"
        return message

    async def interrupt(self) -> None:
        turn = self.turn
        if turn is None:
            if self._starting:
                self._start_canceled = True
            return
        self.interrupted = interrupted_note(turn.prompt, turn.partial)
        self.canceled = True
        process = self.process
        if process is not None:
            await end_tree(process)

    async def close(self) -> None:
        process = self.process
        if process is not None:
            await end_tree(process)
        task = self.task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - closing regardless
                pass

    # -- runtime settings -------------------------------------------------

    async def set_model(self, model_id: str) -> None:
        model = self._model(model_id)
        if model is not None:
            if self.effort_id is not None and self.effort_id not in model["efforts"]:
                self.effort_id = None
            if not model["supportsFast"]:
                self.fast = False
        elif any(raw["id"] == model_id for raw in self.listed.raw):
            pass
        else:
            migrated = cursor_models.resolve_legacy_model(model_id, self.listed.grouped)
            if migrated is None:
                raise RuntimeError(f"Cursor 没有列出模型 {model_id}")
            model_id, effort, fast = migrated
            self.ctx.emit(events.model_changed(model_id))
            if effort is not None:
                self.effort_id = effort
                self.ctx.emit(events.effort_changed(effort))
            if fast is not None:
                self.fast = fast
                self.ctx.emit(events.fast_changed(fast))
        self.model_id = model_id

    async def set_mode(self, mode_id: str) -> None:
        if not any(mode["id"] == mode_id for mode in MODES):
            raise RuntimeError(f"Cursor has no mode '{mode_id}'")
        self.mode_id = mode_id

    async def set_effort(self, effort_id: str) -> None:
        model = self._model(self.model_id)
        if model is not None and effort_id not in model["efforts"]:
            raise RuntimeError(f"{model['label']} 没有 {effort_id} 这一档思考强度")
        self.effort_id = effort_id

    async def set_fast(self, fast: bool) -> None:
        if fast:
            model = self._model(self.model_id)
            if model is not None and not model["supportsFast"]:
                raise RuntimeError(f"{model['label']} 没有 Fast 版本")
        self.fast = bool(fast)

    async def respond(self, request_id: str, outcome: dict) -> None:
        raise RuntimeError("Cursor print mode runs without permission prompts")
