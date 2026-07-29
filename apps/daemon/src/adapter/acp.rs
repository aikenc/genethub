//! Adapter for CLIs that speak the Agent Client Protocol over stdio.
//!
//! One implementation covers every ACP-speaking agent, which is why this is in
//! the MVP rather than later: it is the cheapest way to stop the abstraction
//! from being a description of our own agent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Capabilities, Catalog, ItemDelta, ModeInfo, ModelInfo, PermissionOption, PermissionOptionKind,
    PermissionOutcome, PermissionRequest, ProbeState, SessionEvent, TimelineItem, ToolCallDetail,
    ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex};

use super::stdio::write_json_line;
use super::{find_executable, AgentAdapter, AgentSession, PromptInput, ProviderMap, SessionConfig};

const EVENT_CAPACITY: usize = 1024;
const PROTOCOL_VERSION: i64 = 1;

pub struct AcpAdapter {
    id: String,
    label: String,
    command: Vec<String>,
}

impl AcpAdapter {
    pub fn new(id: impl Into<String>, label: impl Into<String>, command: Vec<String>) -> Self {
        AcpAdapter {
            id: id.into(),
            label: label.into(),
            command,
        }
    }

    fn program(&self) -> Option<PathBuf> {
        find_executable(self.command.first()?)
    }
}

#[async_trait]
impl AgentAdapter for AcpAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            interrupt: true,
            // ACP has no model switching in the base protocol.
            set_model: false,
            set_mode: true,
            permissions: true,
            resume: false,
            attachments: true,
        }
    }

    async fn probe(&self) -> ProbeState {
        match self.program() {
            Some(_) => ProbeState::Ready,
            None => ProbeState::NotInstalled,
        }
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        // ACP agents carry their own credentials and model choice. Advertising
        // an empty model list is what makes the frontend hide the picker
        // instead of offering a control that cannot work.
        Catalog {
            models: Vec::<ModelInfo>::new(),
            modes: vec![
                ModeInfo {
                    id: "default".into(),
                    label: "Default".into(),
                    description: None,
                },
                ModeInfo {
                    id: "acceptEdits".into(),
                    label: "Accept edits".into(),
                    description: Some("Apply file edits without asking".into()),
                },
            ],
            default_model: None,
            default_mode: Some("default".into()),
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("{} is not installed", self.command[0]))?;

        let mut command = Command::new(&program);
        command
            .args(&self.command[1..])
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {}", program.display()))?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stdin = child.stdin.take().expect("stdin was piped");

        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let turn = Arc::new(Mutex::new(TurnState::default()));

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "acp-agent", "{line}");
            }
        });

        let session = AcpSession {
            stdin: Mutex::new(stdin),
            events: events.clone(),
            pending: pending.clone(),
            turn: turn.clone(),
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(child)),
            acp_session: Mutex::new(None),
        };

        tokio::spawn(read_loop(stdout, events, pending, turn));

        session.initialize(&config).await?;
        Ok(Box::new(session))
    }
}

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Default)]
struct TurnState {
    id: Option<String>,
    counter: u64,
    /// ACP streams text without explicit start/end markers, so an open item is
    /// held here and extended until something else interrupts it.
    text_item: Option<String>,
    reasoning_item: Option<String>,
}

impl TurnState {
    fn next_item_id(&mut self) -> String {
        self.counter += 1;
        let turn = self.id.as_deref().unwrap_or("t0");
        format!("{turn}-{}", self.counter)
    }
}

struct AcpSession {
    stdin: Mutex<ChildStdin>,
    events: broadcast::Sender<SessionEvent>,
    pending: PendingMap,
    turn: Arc<Mutex<TurnState>>,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
    acp_session: Mutex<Option<String>>,
}

impl AcpSession {
    async fn write(&self, value: Value) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        write_json_line(&mut stdin, &value).await
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;
        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(anyhow!("{method} failed: {message}")),
            Err(_) => Err(anyhow!("{method} failed: the agent closed the connection")),
        }
    }

    async fn initialize(&self, config: &SessionConfig) -> Result<()> {
        self.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
            }),
        )
        .await?;

        let result = self
            .call(
                "session/new",
                json!({ "cwd": config.cwd, "mcpServers": [] }),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("session/new did not return a sessionId"))?;
        *self.acp_session.lock().await = Some(session_id.to_string());
        Ok(())
    }

    async fn session_id(&self) -> Result<String> {
        self.acp_session
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow!("the ACP session was never established"))
    }
}

#[async_trait]
impl AgentSession for AcpSession {
    fn events(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    async fn send(&self, input: PromptInput) -> Result<String> {
        let session_id = self.session_id().await?;
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

        let events = self.events.clone();
        let turn_state = self.turn.clone();
        let params = json!({
            "sessionId": session_id,
            "prompt": prompt_blocks(&input),
        });

        // `session/prompt` only returns when the whole turn is done, so it runs
        // detached: the timeline arrives through notifications in the meantime.
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": params,
        }))
        .await?;

        let completed_turn = turn_id.clone();
        tokio::spawn(async move {
            let outcome = rx.await;
            let mut state = turn_state.lock().await;
            // A newer turn may already have started; do not close it out.
            if state.id.as_deref() != Some(completed_turn.as_str()) {
                return;
            }
            state.id = None;
            let event = match outcome {
                Ok(Ok(value)) => match value.get("stopReason").and_then(Value::as_str) {
                    Some("cancelled") | Some("canceled") => SessionEvent::TurnCanceled {
                        turn_id: completed_turn,
                    },
                    Some("refusal") => SessionEvent::TurnFailed {
                        turn_id: completed_turn,
                        error: TurnError {
                            code: TurnErrorCode::Upstream,
                            message: "The agent declined this request.".into(),
                        },
                    },
                    _ => SessionEvent::TurnCompleted {
                        turn_id: completed_turn,
                        usage: Usage::default(),
                    },
                },
                Ok(Err(message)) => SessionEvent::TurnFailed {
                    turn_id: completed_turn,
                    error: TurnError {
                        code: TurnErrorCode::Upstream,
                        message,
                    },
                },
                Err(_) => SessionEvent::TurnFailed {
                    turn_id: completed_turn,
                    error: TurnError {
                        code: TurnErrorCode::AgentCrashed,
                        message: "The agent process stopped unexpectedly.".into(),
                    },
                },
            };
            let _ = events.send(event);
        });

        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        let session_id = self.session_id().await?;
        self.write(json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
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
        let session_id = self.session_id().await?;
        self.call(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode_id }),
        )
        .await?;
        let _ = self.events.send(SessionEvent::ModeChanged {
            mode_id: mode_id.to_string(),
        });
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()> {
        let response = match &outcome {
            PermissionOutcome::Selected { option_id } => {
                json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
            }
            _ => json!({ "outcome": { "outcome": "cancelled" } }),
        };
        // The agent asked us, so this is a JSON-RPC *response* keyed by its id.
        let id: i64 = request_id
            .parse()
            .map_err(|_| anyhow!("'{request_id}' is not an ACP request id"))?;
        self.write(json!({ "jsonrpc": "2.0", "id": id, "result": response }))
            .await?;
        let _ = self.events.send(SessionEvent::PermissionResolved {
            request_id: request_id.to_string(),
            outcome,
        });
        Ok(())
    }
}

async fn read_loop(
    stdout: tokio::process::ChildStdout,
    events: broadcast::Sender<SessionEvent>,
    pending: PendingMap,
    turn: Arc<Mutex<TurnState>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            tracing::warn!("undecodable ACP frame");
            continue;
        };

        // A response to something we sent.
        if let Some(id) = frame.get("id").and_then(Value::as_i64) {
            if frame.get("method").is_none() {
                if let Some(sender) = pending.lock().await.remove(&id) {
                    let outcome = match frame.get("error") {
                        Some(error) => Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .to_string()),
                        None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = sender.send(outcome);
                }
                continue;
            }
        }

        let Some(method) = frame.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        let mut state = turn.lock().await;
        match method {
            "session/update" => translate_update(&params, &mut state, &events),
            "session/request_permission" => {
                let id = frame.get("id").and_then(Value::as_i64).unwrap_or(-1);
                translate_permission(id, &params, &events);
            }
            _ => {}
        }
    }
}

/// Builds a `session/prompt` content block array from a turn's text and
/// attachments. Only inline (`dataBase64`) image attachments are forwarded —
/// that is the only shape the composer produces today (pasted screenshots);
/// a bare `path` would need the daemon to read the file itself, which no
/// caller needs yet.
fn prompt_blocks(input: &PromptInput) -> Vec<Value> {
    let mut blocks = Vec::new();
    if !input.text.is_empty() {
        blocks.push(json!({ "type": "text", "text": input.text }));
    }
    for attachment in &input.attachments {
        if let Some(data) = &attachment.data_base64 {
            if attachment.mime.starts_with("image/") {
                blocks.push(json!({
                    "type": "image",
                    "mimeType": attachment.mime,
                    "data": data,
                }));
            }
        }
    }
    blocks
}

fn translate_permission(id: i64, params: &Value, events: &broadcast::Sender<SessionEvent>) {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|option| PermissionOption {
                    id: option
                        .get("optionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    label: option
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Continue")
                        .to_string(),
                    kind: match option.get("kind").and_then(Value::as_str) {
                        Some("allow_always") => PermissionOptionKind::AllowAlways,
                        Some("reject_once") | Some("reject_always") => PermissionOptionKind::Reject,
                        _ => PermissionOptionKind::AllowOnce,
                    },
                })
                .collect()
        })
        .unwrap_or_default();

    let tool_call = params.get("toolCall");
    let _ = events.send(SessionEvent::PermissionRequested {
        request: PermissionRequest {
            id: id.to_string(),
            title: tool_call
                .and_then(|c| c.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("The agent is asking for permission")
                .to_string(),
            detail: None,
            tool_call_id: tool_call
                .and_then(|c| c.get("toolCallId"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            options,
        },
    });
}

fn translate_update(
    params: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let update = params.get("update").unwrap_or(&Value::Null);
    let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return;
    };
    let emit = |event: SessionEvent| {
        let _ = events.send(event);
    };
    let text_of = |value: &Value| -> String {
        value
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    match kind {
        "agent_message_chunk" => {
            let delta = text_of(update);
            match state.text_item.clone() {
                Some(id) => emit(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: id,
                    delta: ItemDelta::Text { delta },
                }),
                None => {
                    let id = state.next_item_id();
                    state.text_item = Some(id.clone());
                    state.reasoning_item = None;
                    emit(SessionEvent::Item {
                        turn_id,
                        item: TimelineItem::AssistantMessage { id, text: delta },
                    });
                }
            }
        }
        "agent_thought_chunk" => {
            let delta = text_of(update);
            match state.reasoning_item.clone() {
                Some(id) => emit(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: id,
                    delta: ItemDelta::Text { delta },
                }),
                None => {
                    let id = state.next_item_id();
                    state.reasoning_item = Some(id.clone());
                    state.text_item = None;
                    emit(SessionEvent::Item {
                        turn_id,
                        item: TimelineItem::Reasoning { id, text: delta },
                    });
                }
            }
        }
        "tool_call" | "tool_call_update" => {
            // Any tool activity ends the current text run, so the next chunk
            // opens a fresh bubble instead of appending after the tool card.
            state.text_item = None;
            state.reasoning_item = None;
            let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                return;
            };
            let status = match update.get("status").and_then(Value::as_str) {
                Some("in_progress") => ToolStatus::Running,
                Some("completed") => ToolStatus::Ok,
                Some("failed") => ToolStatus::Error,
                _ => ToolStatus::Pending,
            };
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::ToolCall {
                    id: id.to_string(),
                    name: update
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    status,
                    detail: detail_from_update(update),
                },
            });
        }
        "plan" => {
            let id = state.next_item_id();
            let items = update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| genehub_proto::TodoEntry {
                            text: entry
                                .get("content")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            status: match entry.get("status").and_then(Value::as_str) {
                                Some("in_progress") => genehub_proto::TodoStatus::InProgress,
                                Some("completed") => genehub_proto::TodoStatus::Completed,
                                _ => genehub_proto::TodoStatus::Pending,
                            },
                        })
                        .collect()
                })
                .unwrap_or_default();
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Todo { id, items },
            });
        }
        "current_mode_update" => {
            if let Some(mode) = update.get("currentModeId").and_then(Value::as_str) {
                emit(SessionEvent::ModeChanged {
                    mode_id: mode.to_string(),
                });
            }
        }
        _ => {}
    }
}

/// ACP describes tools by `kind` plus a list of locations and content blocks.
fn detail_from_update(update: &Value) -> ToolCallDetail {
    let kind = update
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("other");
    let path = update
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let content = update
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    block
                        .get("content")
                        .and_then(|c| c.get("text"))
                        .and_then(Value::as_str)
                        .or_else(|| block.get("newText").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    match kind {
        "execute" => ToolCallDetail::Shell {
            command: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            output: content,
            exit_code: None,
        },
        "read" => ToolCallDetail::Read {
            path,
            content,
            truncated: false,
        },
        "edit" => ToolCallDetail::Edit {
            path,
            diff: content,
        },
        "search" => ToolCallDetail::Search {
            query: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            matches: Vec::new(),
        },
        "fetch" => ToolCallDetail::Fetch {
            url: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            summary: content,
        },
        _ => ToolCallDetail::Unknown {
            raw: update.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use genehub_proto::Attachment;

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

    /// A pasted screenshot must become an ACP `image` block, not silently
    /// vanish because the base struct only carries text.
    #[test]
    fn a_pasted_image_becomes_an_image_content_block() {
        let input = PromptInput {
            text: "看看这个".into(),
            attachments: vec![Attachment {
                name: "shot.png".into(),
                mime: "image/png".into(),
                path: None,
                data_base64: Some("Zm9v".into()),
            }],
        };
        let blocks = prompt_blocks(&input);
        assert_eq!(
            blocks,
            vec![
                json!({ "type": "text", "text": "看看这个" }),
                json!({ "type": "image", "mimeType": "image/png", "data": "Zm9v" }),
            ]
        );
    }

    /// Attachments with no inline payload (a bare path) are not forwarded —
    /// there is no caller yet that expects the daemon to read a file itself.
    #[test]
    fn an_attachment_without_inline_data_is_dropped_not_guessed_at() {
        let input = PromptInput {
            text: "".into(),
            attachments: vec![Attachment {
                name: "notes.pdf".into(),
                mime: "application/pdf".into(),
                path: Some("/tmp/notes.pdf".into()),
                data_base64: None,
            }],
        };
        assert!(prompt_blocks(&input).is_empty());
    }

    /// ACP streams text with no start marker, unlike the built-in agent. Both
    /// must land on the same event shape, which is the point of the layer.
    #[test]
    fn the_first_chunk_opens_an_item_and_later_chunks_are_deltas() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        for text in ["he", "llo"] {
            translate_update(
                &json!({"update": {"sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": text}}}),
                &mut turn,
                &tx,
            );
        }
        let events = drain(&mut rx);
        match &events[0] {
            SessionEvent::Item {
                item: TimelineItem::AssistantMessage { text, .. },
                ..
            } => assert_eq!(text, "he"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            &events[1],
            SessionEvent::ItemDelta {
                delta: ItemDelta::Text { delta },
                ..
            } if delta == "llo"
        ));
    }

    #[test]
    fn a_tool_call_closes_the_open_text_run() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        translate_update(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "before"}}}),
            &mut turn,
            &tx,
        );
        translate_update(
            &json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "c1",
                    "title": "grep", "kind": "search", "status": "in_progress"}}),
            &mut turn,
            &tx,
        );
        translate_update(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "after"}}}),
            &mut turn,
            &tx,
        );
        let events = drain(&mut rx);
        let opened: Vec<_> = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    SessionEvent::Item {
                        item: TimelineItem::AssistantMessage { .. },
                        ..
                    }
                )
            })
            .collect();
        assert_eq!(opened.len(), 2, "text after a tool starts a new bubble");
    }

    #[test]
    fn an_edit_tool_maps_onto_the_diff_renderer() {
        let detail = detail_from_update(&json!({
            "kind": "edit",
            "locations": [{"path": "/tmp/a.rs"}],
            "content": [{"type": "diff", "newText": "-old\n+new"}]
        }));
        assert_eq!(
            detail,
            ToolCallDetail::Edit {
                path: "/tmp/a.rs".into(),
                diff: "-old\n+new".into()
            }
        );
    }

    #[test]
    fn an_unrecognised_tool_kind_still_renders_through_unknown() {
        let detail = detail_from_update(&json!({"kind": "quantum", "title": "?"}));
        assert!(matches!(detail, ToolCallDetail::Unknown { .. }));
    }

    #[test]
    fn permission_requests_carry_their_options_and_reply_id() {
        let (tx, mut rx) = broadcast::channel(8);
        translate_permission(
            42,
            &json!({
                "toolCall": {"toolCallId": "c1", "title": "Write file"},
                "options": [
                    {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "no", "name": "Deny", "kind": "reject_once"}
                ]
            }),
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::PermissionRequested { request } => {
                assert_eq!(request.id, "42", "the id is what we answer on");
                assert_eq!(request.tool_call_id.as_deref(), Some("c1"));
                assert_eq!(request.options.len(), 2);
                assert_eq!(request.options[1].kind, PermissionOptionKind::Reject);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn plan_updates_become_todo_items() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = state();
        translate_update(
            &json!({"update": {"sessionUpdate": "plan", "entries": [
                {"content": "step one", "status": "completed"},
                {"content": "step two", "status": "in_progress"}
            ]}}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::Item {
                item: TimelineItem::Todo { items, .. },
                ..
            } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].status, genehub_proto::TodoStatus::Completed);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn updates_outside_a_turn_are_ignored() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = TurnState::default();
        translate_update(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "x"}}}),
            &mut turn,
            &tx,
        );
        assert!(drain(&mut rx).is_empty());
    }
}
