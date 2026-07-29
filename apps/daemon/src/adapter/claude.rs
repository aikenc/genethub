//! Adapter for Claude Code, spoken natively over its own `stream-json`
//! stdio protocol instead of through the `claude-agent-acp` wrapper.
//!
//! We still never manage how this CLI reaches a model: env vars and its own
//! config file are Claude Code's documented surface for that, not ours
//! (`docs/architecture.md` §3, boundary B1; `docs/third-party-agents.md`).
//! What going native buys back, relative to the ACP wrapper, is something ACP
//! does not expose to a client at all: per-tool permission control. Claude
//! Code's `--permission-prompt-tool stdio` routes every tool call through a
//! `control_request`/`control_response` pair on the same stdio channel used
//! for the conversation, which is exactly the shape our own
//! `PermissionRequested`/`respond_permission` pair already needs.
//!
//! Protocol notes (there is no public spec; this was reverse-engineered
//! against Claude Code 2.1.220, see the investigation behind this file):
//!
//! - Spawn with `--print --input-format stream-json --output-format
//!   stream-json --include-partial-messages --verbose --permission-mode
//!   manual --permission-prompt-tool stdio`. `manual` plus `stdio` is what
//!   forces every tool call through us rather than either auto-running or
//!   blocking on a TTY prompt that does not exist here.
//! - Each user turn is one `{"type":"user","message":{...}}` line on stdin;
//!   the process stays alive across turns.
//! - Output is a mix of `{"type":"stream_event","event":{...}}` (the raw
//!   Anthropic Messages stream: `message_start`, `content_block_start`,
//!   `content_block_delta`, `content_block_stop`, `message_delta`,
//!   `message_stop`) and full snapshot frames (`{"type":"assistant",...}`,
//!   `{"type":"user",...}` for tool results). We stream text/thinking from
//!   the deltas for the typing effect, but read tool calls off the full
//!   `assistant` snapshot: `input_json_delta` fragments are not valid JSON
//!   until the block closes, and the snapshot already hands us the complete,
//!   parsed object.
//! - The CLI asks permission via `{"type":"control_request","request":
//!   {"subtype":"can_use_tool","tool_name","input","tool_use_id",...}}`. We
//!   answer `{"type":"control_response","response":{"request_id",
//!   "subtype":"success","response":{"behavior":"allow"|"deny","message"?}}}`.
//!   Leaving this unanswered (e.g. because our stdin already closed) surfaces
//!   as a denied tool call, never a hang — confirmed empirically.
//! - We interrupt with `{"type":"control_request","request":{"subtype":
//!   "interrupt"}}`; the CLI ack's it and then emits a synthetic
//!   `{"type":"user","message":{"content":[{"type":"text","text":
//!   "[Request interrupted by user]"}]}}` before its final result frame. That
//!   sentinel is the only reliable signal that a turn ended *because we asked
//!   it to*: the final frame's own `is_error`/`subtype` fields look identical
//!   for "the user cancelled" and "the upstream call failed", so cancellation
//!   is tracked locally instead of inferred from them.
//! - The turn ends with `{"type":"result", "is_error", "subtype",
//!   "stop_reason", "usage", "errors"?, ...}` — never a bare `message_stop`,
//!   which can be followed by more tool-result round trips.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Capabilities, Catalog, ItemDelta, ModeInfo, PermissionOption, PermissionOptionKind,
    PermissionOutcome, PermissionRequest, ProbeState, SessionEvent, TimelineItem, ToolCallDetail,
    ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, Mutex};

use super::stdio::write_json_line;
use super::{
    find_executable, AgentAdapter, AgentSession, PersistHandle, PromptInput, ProviderMap,
    SessionConfig,
};

const BINARY: &str = "claude";
const EVENT_CAPACITY: usize = 1024;

/// Our own permission policy, applied before the user ever sees a
/// `can_use_tool` request. The names mirror what the CLI itself calls these
/// ideas in `permission_suggestions[].mode`, so a user reading either surface
/// sees the same word for the same thing.
const MODE_DEFAULT: &str = "default";
const MODE_ACCEPT_EDITS: &str = "acceptEdits";

pub struct ClaudeAdapter;

impl ClaudeAdapter {
    fn program(&self) -> Option<PathBuf> {
        find_executable(BINARY)
    }
}

#[async_trait]
impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &str {
        "claude"
    }

    fn label(&self) -> &str {
        "Claude Code"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            interrupt: true,
            // Model choice is this CLI's own business (env vars, its config
            // file); advertising models we did not configure would be a
            // control we cannot actually back.
            set_model: false,
            set_mode: true,
            permissions: true,
            // `--resume <session-id>` is real; we just need the id back.
            resume: true,
            attachments: false,
        }
    }

    async fn probe(&self) -> ProbeState {
        match self.program() {
            Some(_) => ProbeState::Ready,
            None => ProbeState::NotInstalled,
        }
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        Catalog {
            models: Vec::new(),
            modes: vec![
                ModeInfo {
                    id: MODE_DEFAULT.into(),
                    label: "Default".into(),
                    description: Some("Ask before every tool call".into()),
                },
                ModeInfo {
                    id: MODE_ACCEPT_EDITS.into(),
                    label: "Accept edits".into(),
                    description: Some("Apply file edits and commands without asking".into()),
                },
            ],
            default_model: None,
            default_mode: Some(MODE_DEFAULT.into()),
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("claude is not installed"))?;

        let mut command = Command::new(&program);
        command
            .args([
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--permission-mode",
                "manual",
                "--permission-prompt-tool",
                "stdio",
            ])
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(session_id) = config
            .resume
            .as_ref()
            .filter(|handle| handle.agent_id == "claude")
            .and_then(|handle| handle.value.get("sessionId"))
            .and_then(Value::as_str)
        {
            command.args(["--resume", session_id]);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {}", program.display()))?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stdin = child.stdin.take().expect("stdin was piped");

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "claude-agent", "{line}");
            }
        });

        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let turn = Arc::new(Mutex::new(TurnState::default()));
        // A plain `std::sync::Mutex`, not `tokio::sync::Mutex`: `persistence()`
        // in the `AgentSession` trait is synchronous, and this value only ever
        // holds its lock for a single field read or write, never across an
        // `.await`.
        let native_session_id: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
        // A session created earlier and resumed now (or one whose mode was
        // set before its first prompt lazily started the process — see
        // `session::manager::ensure_started`) must not silently forget which
        // mode it was in.
        let initial_mode = match config.mode_id.as_deref() {
            Some(MODE_ACCEPT_EDITS) => MODE_ACCEPT_EDITS,
            _ => MODE_DEFAULT,
        };
        let mode = Arc::new(Mutex::new(initial_mode.to_string()));
        let stdin = Arc::new(Mutex::new(stdin));

        let session = ClaudeSession {
            stdin: stdin.clone(),
            events: events.clone(),
            turn: turn.clone(),
            child: Mutex::new(Some(child)),
            native_session_id: native_session_id.clone(),
            mode: mode.clone(),
            next_control_id: AtomicU64::new(1),
        };

        tokio::spawn(read_loop(
            stdout,
            events,
            turn,
            native_session_id,
            mode,
            stdin,
        ));

        Ok(Box::new(session))
    }
}

/// Everything that changes over the life of one turn.
#[derive(Default)]
struct TurnState {
    id: Option<String>,
    counter: u64,
    /// We asked the CLI to stop this turn; the next `is_error` result is
    /// therefore a cancellation, not a failure, however the CLI itself
    /// happens to label it (see the module doc: it does not label the two
    /// differently).
    interrupt_requested: bool,
    /// `content_block` index -> (item id, kind, text accumulated so far).
    /// The accumulator lets `content_block_stop` emit one settled `Item`
    /// with the full text, the same upsert-then-settle shape `client.rs`'s
    /// `EventsExt::assistant_text` (and the real frontend) expect — deltas
    /// alone never produce a "final" value for an item, only a moving one.
    open_blocks: HashMap<u64, (String, BlockKind, String)>,
    /// `tool_use_id` -> (item id, tool name, tool input), so the eventual
    /// `tool_result` can close the right card with a settled `Item` rather
    /// than a delta the item-only readers (`EventsExt::tool_calls`, the
    /// frontend's own initial render) would never see (same shape as the
    /// text-settling fix in `content_block_stop`, just for tool status).
    tool_items: HashMap<String, (String, String, Value)>,
}

#[derive(Clone, Copy, PartialEq)]
enum BlockKind {
    Text,
    Thinking,
}

impl TurnState {
    fn next_item_id(&mut self) -> String {
        self.counter += 1;
        let turn = self.id.as_deref().unwrap_or("t0");
        format!("{turn}-{}", self.counter)
    }
}

struct ClaudeSession {
    stdin: Arc<Mutex<ChildStdin>>,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    child: Mutex<Option<Child>>,
    native_session_id: Arc<std::sync::Mutex<Option<String>>>,
    mode: Arc<Mutex<String>>,
    next_control_id: AtomicU64,
}

impl ClaudeSession {
    async fn write(&self, value: Value) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        write_json_line(&mut stdin, &value).await
    }

    fn control_request_id(&self) -> String {
        format!(
            "genehub_{}",
            self.next_control_id.fetch_add(1, Ordering::SeqCst)
        )
    }
}

#[async_trait]
impl AgentSession for ClaudeSession {
    fn events(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    async fn send(&self, input: PromptInput) -> Result<String> {
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4().simple());
        {
            let mut turn = self.turn.lock().await;
            *turn = TurnState {
                id: Some(turn_id.clone()),
                ..TurnState::default()
            };
        }
        let _ = self.events.send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });

        self.write(json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": input.text }],
            },
        }))
        .await?;
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        {
            let mut turn = self.turn.lock().await;
            turn.interrupt_requested = true;
        }
        let request_id = self.control_request_id();
        self.write(json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "interrupt" },
        }))
        .await
    }

    async fn close(&self) -> Result<()> {
        let mut child = self.child.lock().await;
        if let Some(mut child) = child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Ok(())
    }

    async fn set_model(&self, _model_id: &str) -> Result<()> {
        Err(anyhow!("this agent manages its own model selection"))
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        if mode_id != MODE_DEFAULT && mode_id != MODE_ACCEPT_EDITS {
            return Err(anyhow!("unknown mode '{mode_id}'"));
        }
        *self.mode.lock().await = mode_id.to_string();
        let _ = self.events.send(SessionEvent::ModeChanged {
            mode_id: mode_id.to_string(),
        });
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()> {
        let response = match &outcome {
            PermissionOutcome::Selected { option_id } if option_id == "allow" => {
                json!({ "behavior": "allow" })
            }
            _ => json!({ "behavior": "deny", "message": "Denied by the user." }),
        };
        // `request_id` here is the control request's own id: the read loop
        // handed it straight to the timeline event, so replying is just
        // echoing it back inside a `control_response`.
        self.write(json!({
            "type": "control_response",
            "response": { "request_id": request_id, "subtype": "success", "response": response },
        }))
        .await?;
        let _ = self.events.send(SessionEvent::PermissionResolved {
            request_id: request_id.to_string(),
            outcome,
        });
        Ok(())
    }

    fn persistence(&self) -> Option<PersistHandle> {
        let session_id = self.native_session_id.lock().unwrap().clone()?;
        Some(PersistHandle {
            agent_id: "claude".into(),
            value: json!({ "sessionId": session_id }),
        })
    }
}

async fn read_loop(
    stdout: tokio::process::ChildStdout,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    native_session_id: Arc<std::sync::Mutex<Option<String>>>,
    mode: Arc<Mutex<String>>,
    stdin: Arc<Mutex<ChildStdin>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!("claude stdout closed: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            tracing::warn!("undecodable frame from claude");
            continue;
        };

        match frame.get("type").and_then(Value::as_str) {
            Some("system") if frame.get("subtype").and_then(Value::as_str) == Some("init") => {
                if let Some(id) = frame.get("session_id").and_then(Value::as_str) {
                    *native_session_id.lock().unwrap() = Some(id.to_string());
                }
            }
            Some("stream_event") => {
                let mut state = turn.lock().await;
                translate_stream_event(
                    frame.get("event").unwrap_or(&Value::Null),
                    &mut state,
                    &events,
                );
            }
            Some("assistant") => {
                let mut state = turn.lock().await;
                translate_assistant_snapshot(&frame, &mut state, &events);
            }
            Some("user") => {
                let mut state = turn.lock().await;
                translate_user_frame(&frame, &mut state, &events);
            }
            Some("control_request") => {
                handle_control_request(&frame, &mode, &turn, &events, &stdin).await;
            }
            Some("result") => {
                let mut state = turn.lock().await;
                translate_result(&frame, &mut state, &events);
            }
            _ => {}
        }
    }

    let mut state = turn.lock().await;
    if let Some(turn_id) = state.id.take() {
        let _ = events.send(SessionEvent::TurnFailed {
            turn_id,
            error: TurnError {
                code: TurnErrorCode::AgentCrashed,
                message: "Claude Code stopped unexpectedly.".into(),
            },
        });
    }
}

/// Streams text and thinking deltas for the typing effect. Tool calls are
/// deliberately not opened here: `input_json_delta` fragments are not valid
/// JSON until the block closes (see module doc).
fn translate_stream_event(
    event: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let emit = |event: SessionEvent| {
        let _ = events.send(event);
    };
    match event.get("type").and_then(Value::as_str) {
        Some("content_block_start") => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
            let kind = event
                .get("content_block")
                .and_then(|block| block.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            match kind {
                "text" | "thinking" => {
                    let id = state.next_item_id();
                    let block_kind = if kind == "thinking" {
                        BlockKind::Thinking
                    } else {
                        BlockKind::Text
                    };
                    state
                        .open_blocks
                        .insert(index, (id.clone(), block_kind, String::new()));
                    let item = if kind == "thinking" {
                        TimelineItem::Reasoning {
                            id,
                            text: String::new(),
                        }
                    } else {
                        TimelineItem::AssistantMessage {
                            id,
                            text: String::new(),
                        }
                    };
                    emit(SessionEvent::Item { turn_id, item });
                }
                // `tool_use` blocks are opened once the full snapshot frame
                // arrives with a complete, parsed `input`.
                _ => {}
            }
        }
        Some("content_block_delta") => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
            let delta = event.get("delta").unwrap_or(&Value::Null);
            let text = match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => delta.get("text").and_then(Value::as_str),
                Some("thinking_delta") => delta.get("thinking").and_then(Value::as_str),
                _ => None,
            };
            let Some(text) = text.filter(|text| !text.is_empty()) else {
                return;
            };
            let Some((item_id, _, accumulated)) = state.open_blocks.get_mut(&index) else {
                return;
            };
            accumulated.push_str(text);
            emit(SessionEvent::ItemDelta {
                turn_id,
                item_id: item_id.clone(),
                delta: ItemDelta::Text {
                    delta: text.to_string(),
                },
            });
        }
        Some("content_block_stop") => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
            let Some((id, kind, text)) = state.open_blocks.remove(&index) else {
                return;
            };
            let item = if kind == BlockKind::Thinking {
                TimelineItem::Reasoning { id, text }
            } else {
                TimelineItem::AssistantMessage { id, text }
            };
            emit(SessionEvent::Item { turn_id, item });
        }
        _ => {}
    }
}

/// The full, already-parsed assistant message. Used only to pick up tool
/// calls (see module doc); text/thinking already streamed from the deltas.
fn translate_assistant_snapshot(
    frame: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let blocks = frame
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(tool_use_id) = block.get("id").and_then(Value::as_str) else {
            continue;
        };
        if state.tool_items.contains_key(tool_use_id) {
            continue;
        }
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let id = state.next_item_id();
        state.tool_items.insert(
            tool_use_id.to_string(),
            (id.clone(), name.clone(), input.clone()),
        );
        let _ = events.send(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: TimelineItem::ToolCall {
                id,
                detail: detail_from_tool(&name, &input, None),
                name,
                status: ToolStatus::Running,
            },
        });
    }
}

/// User-role frames carry two unrelated things back to us: tool results, and
/// the synthetic "[Request interrupted by user]" message the CLI emits after
/// honouring our interrupt.
fn translate_user_frame(
    frame: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let blocks = frame
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_result") => {
                let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                    continue;
                };
                let Some((id, name, input)) = state.tool_items.get(tool_use_id).cloned() else {
                    continue;
                };
                let is_error = block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let result_text = tool_result_text(&block);
                let status = if is_error {
                    ToolStatus::Error
                } else {
                    ToolStatus::Ok
                };
                // A settled `Item`, not an `ItemDelta`: readers that only
                // fold `Item`s (`EventsExt::tool_calls`, a client's first
                // render of a session it just opened) must see the finished
                // call, not just the "Running" one from when it opened.
                let _ = events.send(SessionEvent::Item {
                    turn_id: turn_id.clone(),
                    item: TimelineItem::ToolCall {
                        id,
                        detail: detail_from_tool(&name, &input, result_text.as_deref()),
                        name,
                        status,
                    },
                });
            }
            Some("text")
                if block.get("text").and_then(Value::as_str)
                    == Some("[Request interrupted by user]") =>
            {
                state.interrupt_requested = true;
            }
            _ => {}
        }
    }
}

fn tool_result_text(block: &Value) -> Option<String> {
    match block.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let joined = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn translate_result(
    frame: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.take() else {
        return;
    };
    let is_error = frame
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !is_error {
        let usage = frame.get("usage").unwrap_or(&Value::Null);
        let _ = events.send(SessionEvent::TurnCompleted {
            turn_id,
            usage: Usage {
                input_tokens: usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_read_tokens: usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_write_tokens: usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cost_usd: frame.get("total_cost_usd").and_then(Value::as_f64),
            },
        });
        return;
    }

    if state.interrupt_requested {
        let _ = events.send(SessionEvent::TurnCanceled { turn_id });
        return;
    }

    let message = frame
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(Value::as_str)
        .or_else(|| frame.get("result").and_then(Value::as_str))
        .unwrap_or("Claude Code reported an error.")
        .to_string();
    let code = if message.contains("401") || message.to_lowercase().contains("api key") {
        TurnErrorCode::MissingCredentials
    } else if message.contains("429") {
        TurnErrorCode::RateLimited
    } else {
        TurnErrorCode::Upstream
    };
    let _ = events.send(SessionEvent::TurnFailed {
        turn_id,
        error: TurnError { code, message },
    });
}

async fn handle_control_request(
    frame: &Value,
    mode: &Arc<Mutex<String>>,
    turn: &Arc<Mutex<TurnState>>,
    events: &broadcast::Sender<SessionEvent>,
    stdin: &Arc<Mutex<ChildStdin>>,
) {
    let request = frame.get("request").unwrap_or(&Value::Null);
    if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
        // `interrupt` acks and anything else: nothing for the timeline to do.
        return;
    }
    let Some(request_id) = frame.get("request_id").and_then(Value::as_str) else {
        return;
    };
    let tool_name = request
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("a tool");

    if *mode.lock().await == MODE_ACCEPT_EDITS {
        // Auto-approve without ever bothering the frontend.
        let response = json!({
            "type": "control_response",
            "response": { "request_id": request_id, "subtype": "success",
                          "response": { "behavior": "allow" } },
        });
        let mut stdin = stdin.lock().await;
        if let Err(error) = write_json_line(&mut stdin, &response).await {
            tracing::warn!("failed to auto-approve a claude tool call: {error}");
        }
        return;
    }

    // The `assistant` snapshot that created this tool's timeline card always
    // arrives before the CLI asks permission for it, so the lookup below
    // should normally succeed; if it doesn't, the request still goes out
    // without a card to highlight rather than being dropped.
    let tool_use_id = request.get("tool_use_id").and_then(Value::as_str);
    let item_id = match tool_use_id {
        Some(id) => turn
            .lock()
            .await
            .tool_items
            .get(id)
            .map(|(item_id, ..)| item_id.clone()),
        None => None,
    };
    let _ = events.send(SessionEvent::PermissionRequested {
        request: PermissionRequest {
            id: request_id.to_string(),
            title: format!("Allow {tool_name}?"),
            detail: request
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_call_id: item_id,
            options: vec![
                PermissionOption {
                    id: "allow".into(),
                    label: "Allow".into(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOption {
                    id: "deny".into(),
                    label: "Deny".into(),
                    kind: PermissionOptionKind::Reject,
                },
            ],
        },
    });
}

/// Claude Code's built-in tool names, mapped onto our renderers. Unlike ACP's
/// `kind`-tagged updates, here the tool *name* is the only signal, so the
/// mapping is a literal table rather than a handful of cases.
fn detail_from_tool(name: &str, input: &Value, result: Option<&str>) -> ToolCallDetail {
    let str_field = |field: &str| {
        input
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    match name {
        "Bash" => ToolCallDetail::Shell {
            command: str_field("command"),
            output: result.unwrap_or_default().to_string(),
            exit_code: None,
        },
        "Read" => ToolCallDetail::Read {
            path: str_field("file_path"),
            content: result.unwrap_or_default().to_string(),
            truncated: false,
        },
        "Write" => ToolCallDetail::Write {
            path: str_field("file_path"),
            content: str_field("content"),
        },
        "Edit" | "NotebookEdit" => ToolCallDetail::Edit {
            path: str_field("file_path"),
            diff: str_field("new_string"),
        },
        "Grep" | "Glob" => ToolCallDetail::Search {
            query: str_field("pattern"),
            matches: Vec::new(),
        },
        "WebFetch" => ToolCallDetail::Fetch {
            url: str_field("url"),
            summary: result.unwrap_or_default().to_string(),
        },
        "WebSearch" => ToolCallDetail::Fetch {
            url: str_field("query"),
            summary: result.unwrap_or_default().to_string(),
        },
        "TaskCreate" | "TaskList" | "TaskUpdate" => ToolCallDetail::Plan {
            markdown: result.unwrap_or_default().to_string(),
        },
        _ => ToolCallDetail::Unknown {
            raw: json!({ "name": name, "input": input }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> TurnState {
        TurnState {
            id: Some("t1".into()),
            ..TurnState::default()
        }
    }

    fn drain(rx: &mut broadcast::Receiver<SessionEvent>) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            out.push(event);
        }
        out
    }

    #[test]
    fn a_text_block_opens_then_streams_by_delta() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_stream_event(
            &json!({"type": "content_block_start", "index": 0,
                    "content_block": {"type": "text"}}),
            &mut turn,
            &tx,
        );
        translate_stream_event(
            &json!({"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": "hi"}}),
            &mut turn,
            &tx,
        );
        let events = drain(&mut rx);
        assert!(matches!(
            &events[0],
            SessionEvent::Item { item: TimelineItem::AssistantMessage { text, .. }, .. }
                if text.is_empty()
        ));
        assert!(matches!(
            &events[1],
            SessionEvent::ItemDelta { delta: ItemDelta::Text { delta }, .. } if delta == "hi"
        ));
    }

    #[test]
    fn a_text_block_settles_with_its_full_text_on_stop() {
        // Regression: `content_block_stop` used to just drop the open block,
        // so an `AssistantMessage` item only ever existed with empty text —
        // `EventsExt::assistant_text` (which folds `Item`s, not `ItemDelta`s)
        // then saw every third-party Claude reply as blank.
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_stream_event(
            &json!({"type": "content_block_start", "index": 0,
                    "content_block": {"type": "text"}}),
            &mut turn,
            &tx,
        );
        translate_stream_event(
            &json!({"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": "p"}}),
            &mut turn,
            &tx,
        );
        translate_stream_event(
            &json!({"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": "ong"}}),
            &mut turn,
            &tx,
        );
        translate_stream_event(
            &json!({"type": "content_block_stop", "index": 0}),
            &mut turn,
            &tx,
        );
        let events = drain(&mut rx);
        match events.last().expect("a settled item was emitted") {
            SessionEvent::Item {
                item: TimelineItem::AssistantMessage { text, .. },
                ..
            } => assert_eq!(text, "pong"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn thinking_blocks_land_on_reasoning_not_the_message() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_stream_event(
            &json!({"type": "content_block_start", "index": 0,
                    "content_block": {"type": "thinking"}}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::Item {
                item: TimelineItem::Reasoning { .. },
                ..
            } => {}
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_tool_use_snapshot_opens_a_running_tool_card_exactly_once() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        let frame = json!({
            "type": "assistant",
            "message": { "content": [
                {"type": "tool_use", "id": "call_1", "name": "Write",
                 "input": {"file_path": "/tmp/a.txt", "content": "hi"}}
            ]}
        });
        translate_assistant_snapshot(&frame, &mut turn, &tx);
        // A duplicate snapshot (the CLI resends deltas as it goes) must not
        // reopen the same card.
        translate_assistant_snapshot(&frame, &mut turn, &tx);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 1, "the second snapshot is a no-op");
        match &events[0] {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { status, detail, .. },
                ..
            } => {
                assert_eq!(*status, ToolStatus::Running);
                assert_eq!(
                    detail,
                    &ToolCallDetail::Write {
                        path: "/tmp/a.txt".into(),
                        content: "hi".into()
                    }
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_tool_result_closes_the_card_the_snapshot_opened() {
        // Regression: this used to emit only an `ItemDelta::ToolStatus`, so
        // `EventsExt::tool_calls` (which folds `Item`s, not deltas — same
        // class of bug as the text-settling one above) always saw the call
        // stuck at `Running`, and `accept_edits_mode_lets_a_real_tool_call_
        // through_without_a_prompt` failed even though the tool genuinely
        // ran and the permission auto-approval genuinely worked.
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_assistant_snapshot(
            &json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "call_1", "name": "Bash", "input": {"command": "ls"}}
            ]}}),
            &mut turn,
            &tx,
        );
        drain(&mut rx);
        translate_user_frame(
            &json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "a.txt", "is_error": false}
            ]}}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { status, detail, .. },
                ..
            } => {
                assert_eq!(*status, ToolStatus::Ok);
                assert_eq!(
                    detail,
                    &ToolCallDetail::Shell {
                        command: "ls".into(),
                        output: "a.txt".into(),
                        exit_code: None,
                    }
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn the_interrupt_sentinel_is_recognised_and_never_shown_as_a_message() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_user_frame(
            &json!({"type": "user", "message": {"content": [
                {"type": "text", "text": "[Request interrupted by user]"}
            ]}}),
            &mut turn,
            &tx,
        );
        assert!(turn.interrupt_requested);
        assert!(
            drain(&mut rx).is_empty(),
            "the sentinel is not a timeline item"
        );
    }

    #[test]
    fn a_failed_result_after_our_own_interrupt_is_reported_as_canceled_not_failed() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        turn.interrupt_requested = true;
        translate_result(
            &json!({"is_error": true, "subtype": "error_during_execution"}),
            &mut turn,
            &tx,
        );
        assert!(matches!(
            &drain(&mut rx)[0],
            SessionEvent::TurnCanceled { .. }
        ));
    }

    #[test]
    fn a_failed_result_we_never_asked_to_cancel_is_a_real_failure() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_result(
            &json!({"is_error": true, "errors": ["Error: 401 invalid api key"]}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::TurnFailed { error, .. } => {
                assert_eq!(error.code, TurnErrorCode::MissingCredentials);
                assert!(error.message.contains("401"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_clean_result_reports_usage() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_result(
            &json!({"is_error": false, "total_cost_usd": 0.01,
                    "usage": {"input_tokens": 10, "output_tokens": 5}}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::TurnCompleted { usage, .. } => {
                assert_eq!(usage.input_tokens, 10);
                assert_eq!(usage.output_tokens, 5);
                assert_eq!(usage.cost_usd, Some(0.01));
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
