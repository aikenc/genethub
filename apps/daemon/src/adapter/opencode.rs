//! Adapter for OpenCode: a local HTTP server with an SSE event stream.
//!
//! This one exists to keep the abstraction honest. The other two adapters both
//! talk to a child process over stdio; if the normalized layer can also absorb
//! a request/response API whose events arrive on a separate stream, it is a
//! real abstraction rather than a rename of one transport
//! (`docs/architecture.md` §3.3).

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use genehub_proto::{
    Capabilities, Catalog, ModeInfo, ModelInfo, PermissionOutcome, ProbeState,
    SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};

use super::{find_executable, AgentAdapter, AgentSession, PromptInput, ProviderMap, SessionConfig};

const BINARY: &str = "opencode";
const EVENT_CAPACITY: usize = 1024;

pub struct OpenCodeAdapter;

#[async_trait]
impl AgentAdapter for OpenCodeAdapter {
    fn id(&self) -> &str {
        "opencode"
    }

    fn label(&self) -> &str {
        "OpenCode"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            interrupt: true,
            set_model: true,
            set_mode: false,
            permissions: false,
            resume: true,
            attachments: true,
        }
    }

    async fn probe(&self) -> ProbeState {
        match find_executable(BINARY) {
            Some(_) => ProbeState::Ready,
            None => ProbeState::NotInstalled,
        }
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        // OpenCode owns its own credentials, so the model list comes from a
        // running instance. Starting one just to fill a dropdown is too slow
        // for the agent picker; the session reports its models once open.
        Catalog {
            models: Vec::<ModelInfo>::new(),
            modes: Vec::<ModeInfo>::new(),
            default_model: None,
            default_mode: None,
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let binary =
            find_executable(BINARY).ok_or_else(|| anyhow!("OpenCode is not installed"))?;
        let port = pick_port()?;
        let base = format!("http://127.0.0.1:{port}");

        let child = Command::new(&binary)
            .arg("serve")
            .arg("--hostname")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(&config.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawning {}", binary.display()))?;

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?;
        wait_until_ready(&http, &base).await?;

        let created: Value = http
            .post(format!("{base}/session"))
            .json(&json!({}))
            .send()
            .await
            .context("creating an OpenCode session")?
            .json()
            .await?;
        let remote_session = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("OpenCode did not return a session id"))?
            .to_string();

        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let turn = Arc::new(Mutex::new(TurnState::default()));

        tokio::spawn(stream_events(
            http.clone(),
            base.clone(),
            remote_session.clone(),
            events.clone(),
            turn.clone(),
        ));

        Ok(Box::new(OpenCodeSession {
            http,
            base,
            remote_session,
            model: Mutex::new(config.model_id.clone()),
            events,
            turn,
            child: Mutex::new(Some(child)),
        }))
    }
}

#[derive(Default)]
struct TurnState {
    id: Option<String>,
    /// OpenCode addresses parts by id; the mapping to our item ids is kept here
    /// so repeated updates land on the same timeline entry.
    parts: std::collections::HashMap<String, String>,
    counter: u64,
}

impl TurnState {
    fn item_id_for(&mut self, part_id: &str) -> (String, bool) {
        if let Some(existing) = self.parts.get(part_id) {
            return (existing.clone(), false);
        }
        self.counter += 1;
        let turn = self.id.as_deref().unwrap_or("t0");
        let id = format!("{turn}-{}", self.counter);
        self.parts.insert(part_id.to_string(), id.clone());
        (id, true)
    }
}

struct OpenCodeSession {
    http: reqwest::Client,
    base: String,
    remote_session: String,
    model: Mutex<Option<String>>,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    child: Mutex<Option<Child>>,
}

#[async_trait]
impl AgentSession for OpenCodeSession {
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

        let mut body = json!({
            "parts": [{ "type": "text", "text": input.text }],
        });
        if let Some(model) = self.model.lock().await.clone() {
            if let Some((provider, id)) = model.split_once('/') {
                body["model"] = json!({ "providerID": provider, "modelID": id });
            }
        }

        let url = format!("{}/session/{}/message", self.base, self.remote_session);
        let http = self.http.clone();
        let events = self.events.clone();
        let turn_state = self.turn.clone();
        let completed = turn_id.clone();

        // The call blocks for the whole turn; the timeline arrives over SSE.
        tokio::spawn(async move {
            let outcome = http.post(url).json(&body).send().await;
            let mut state = turn_state.lock().await;
            if state.id.as_deref() != Some(completed.as_str()) {
                return;
            }
            state.id = None;
            let event = match outcome {
                Ok(response) if response.status().is_success() => SessionEvent::TurnCompleted {
                    turn_id: completed,
                    usage: Usage::default(),
                },
                Ok(response) => {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    SessionEvent::TurnFailed {
                        turn_id: completed,
                        error: classify_http(status.as_u16(), &body),
                    }
                }
                Err(error) => SessionEvent::TurnFailed {
                    turn_id: completed,
                    error: TurnError {
                        code: if error.is_timeout() {
                            TurnErrorCode::Timeout
                        } else {
                            TurnErrorCode::AgentCrashed
                        },
                        message: format!("OpenCode did not answer: {error}"),
                    },
                },
            };
            let _ = events.send(event);
        });

        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        self.http
            .post(format!(
                "{}/session/{}/abort",
                self.base, self.remote_session
            ))
            .send()
            .await?;
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let mut child = self.child.lock().await;
        if let Some(mut child) = child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        if !model_id.contains('/') {
            return Err(anyhow!("model id must be 'provider/id', got '{model_id}'"));
        }
        *self.model.lock().await = Some(model_id.to_string());
        let _ = self.events.send(SessionEvent::ModelChanged {
            model_id: model_id.to_string(),
        });
        Ok(())
    }

    async fn set_mode(&self, _mode_id: &str) -> Result<()> {
        Err(anyhow!("OpenCode does not expose switchable modes"))
    }

    async fn respond_permission(&self, _request: &str, _outcome: PermissionOutcome) -> Result<()> {
        Err(anyhow!("OpenCode handles approvals itself"))
    }

    fn persistence(&self) -> Option<super::PersistHandle> {
        Some(super::PersistHandle {
            agent_id: "opencode".into(),
            value: json!({ "sessionId": self.remote_session }),
        })
    }
}

/// Binds port 0 to have the OS pick a free port, then releases it.
///
/// There is an unavoidable race between releasing and the child binding, but
/// the alternative — a fixed port — breaks the moment two sessions run at once.
fn pick_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

async fn wait_until_ready(http: &reqwest::Client, base: &str) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut delay = Duration::from_millis(50);
    while std::time::Instant::now() < deadline {
        if http
            .get(format!("{base}/app"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_millis(500));
    }
    Err(anyhow!("OpenCode did not become ready within 30s"))
}

async fn stream_events(
    http: reqwest::Client,
    base: String,
    remote_session: String,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
) {
    let response = match http.get(format!("{base}/event")).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!("could not open the OpenCode event stream: {error}");
            return;
        }
    };

    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by a blank line; anything short of that is
        // a partial frame and must stay in the buffer.
        while let Some(index) = buffer.find("\n\n") {
            let frame = buffer[..index].to_string();
            buffer.drain(..index + 2);
            let Some(payload) = sse_data(&frame) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            let mut state = turn.lock().await;
            translate_event(&value, &remote_session, &mut state, &events);
        }
    }
}

fn sse_data(frame: &str) -> Option<String> {
    let mut data = String::new();
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    (!data.is_empty()).then_some(data)
}

fn translate_event(
    value: &Value,
    remote_session: &str,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return;
    };
    let properties = value.get("properties").unwrap_or(&Value::Null);
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let emit = |event: SessionEvent| {
        let _ = events.send(event);
    };

    match kind {
        "message.part.updated" => {
            let part = properties.get("part").unwrap_or(&Value::Null);
            // The server multiplexes every session onto one stream.
            if part.get("sessionID").and_then(Value::as_str) != Some(remote_session) {
                return;
            }
            let Some(part_id) = part.get("id").and_then(Value::as_str) else {
                return;
            };
            let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
            let (item_id, is_new) = state.item_id_for(part_id);

            match part_type {
                "text" | "reasoning" => {
                    let text = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if is_new {
                        let item = if part_type == "reasoning" {
                            TimelineItem::Reasoning { id: item_id, text }
                        } else {
                            TimelineItem::AssistantMessage { id: item_id, text }
                        };
                        emit(SessionEvent::Item { turn_id, item });
                    } else {
                        // OpenCode resends the whole part, so the item is
                        // replaced rather than appended to. Sending a full Item
                        // keeps replay correct; a Text delta here would
                        // duplicate everything received so far.
                        let item = if part_type == "reasoning" {
                            TimelineItem::Reasoning { id: item_id, text }
                        } else {
                            TimelineItem::AssistantMessage { id: item_id, text }
                        };
                        emit(SessionEvent::Item { turn_id, item });
                    }
                }
                "tool" => {
                    let name = part
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let status_value = part
                        .get("state")
                        .and_then(|s| s.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("pending");
                    let status = match status_value {
                        "running" => ToolStatus::Running,
                        "completed" => ToolStatus::Ok,
                        "error" => ToolStatus::Error,
                        _ => ToolStatus::Pending,
                    };
                    emit(SessionEvent::Item {
                        turn_id,
                        item: TimelineItem::ToolCall {
                            id: item_id,
                            name: name.clone(),
                            status,
                            detail: detail_from_part(&name, part),
                        },
                    });
                }
                _ => {}
            }
        }
        "session.error" => {
            let message = properties
                .get("error")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("OpenCode reported an error")
                .to_string();
            state.id = None;
            emit(SessionEvent::TurnFailed {
                turn_id,
                error: classify_message(&message),
            });
        }
        "message.part.removed" | "session.idle" | "session.updated" => {}
        _ => {}
    }
}

/// Maps an OpenCode tool part onto a renderer.
fn detail_from_part(name: &str, part: &Value) -> ToolCallDetail {
    let state = part.get("state").unwrap_or(&Value::Null);
    let input = state.get("input").cloned().unwrap_or(Value::Null);
    let output = state
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let arg = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    match name {
        "bash" => ToolCallDetail::Shell {
            command: arg("command"),
            output,
            exit_code: None,
        },
        "read" => ToolCallDetail::Read {
            path: arg("filePath"),
            content: output,
            truncated: false,
        },
        "write" => ToolCallDetail::Write {
            path: arg("filePath"),
            content: arg("content"),
        },
        "edit" | "patch" => ToolCallDetail::Edit {
            path: arg("filePath"),
            diff: state
                .get("metadata")
                .and_then(|m| m.get("diff"))
                .and_then(Value::as_str)
                .unwrap_or(&output)
                .to_string(),
        },
        "grep" | "glob" | "list" => ToolCallDetail::Search {
            query: if input.get("pattern").is_some() {
                arg("pattern")
            } else {
                arg("path")
            },
            matches: output
                .lines()
                .filter(|line| !line.is_empty())
                .take(500)
                .map(|line| genehub_proto::SearchMatch {
                    path: line.to_string(),
                    line: None,
                    preview: String::new(),
                })
                .collect(),
        },
        "webfetch" => ToolCallDetail::Fetch {
            url: arg("url"),
            summary: output,
        },
        "todowrite" | "todoread" => ToolCallDetail::Plan {
            markdown: output.clone(),
        },
        "task" => ToolCallDetail::SubAgent {
            agent: arg("subagent_type"),
            prompt: arg("prompt"),
            items: Vec::new(),
        },
        _ => ToolCallDetail::Unknown {
            raw: json!({ "input": input, "output": output }),
        },
    }
}

fn classify_http(status: u16, body: &str) -> TurnError {
    let code = match status {
        401 | 403 => TurnErrorCode::MissingCredentials,
        429 => TurnErrorCode::RateLimited,
        408 | 504 => TurnErrorCode::Timeout,
        _ => TurnErrorCode::Upstream,
    };
    TurnError {
        code,
        message: format!("OpenCode returned HTTP {status}: {}", first_line(body)),
    }
}

fn classify_message(message: &str) -> TurnError {
    let lower = message.to_lowercase();
    let code = if lower.contains("api key") || lower.contains("unauthorized") {
        TurnErrorCode::MissingCredentials
    } else if lower.contains("rate limit") || lower.contains("429") {
        TurnErrorCode::RateLimited
    } else if lower.contains("timeout") || lower.contains("timed out") {
        TurnErrorCode::Timeout
    } else {
        TurnErrorCode::Upstream
    };
    TurnError {
        code,
        message: message.to_string(),
    }
}

fn first_line(body: &str) -> String {
    body.lines().next().unwrap_or_default().chars().take(300).collect()
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
    fn sse_frames_with_multiple_data_lines_are_joined() {
        assert_eq!(
            sse_data("event: x\ndata: {\"a\":\ndata: 1}"),
            Some("{\"a\":\n1}".into())
        );
        assert_eq!(sse_data("event: ping"), None);
    }

    /// OpenCode resends a part in full each time. Emitting a delta here would
    /// duplicate the text, so the same part id must produce a replacing item.
    #[test]
    fn a_resent_text_part_replaces_rather_than_appends() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        for text in ["he", "hello"] {
            translate_event(
                &json!({"type": "message.part.updated", "properties": {"part": {
                    "id": "p1", "sessionID": "s1", "type": "text", "text": text
                }}}),
                "s1",
                &mut turn,
                &tx,
            );
        }
        let events = drain(&mut rx);
        assert_eq!(events.len(), 2);
        let ids: Vec<_> = events
            .iter()
            .map(|event| match event {
                SessionEvent::Item {
                    item: TimelineItem::AssistantMessage { id, text },
                    ..
                } => (id.clone(), text.clone()),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(ids[0].0, ids[1].0, "the same part keeps one item id");
        assert_eq!(ids[1].1, "hello", "the later value wins outright");
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, SessionEvent::ItemDelta { .. })),
            "no deltas: they would double the text"
        );
    }

    #[test]
    fn parts_belonging_to_another_session_are_ignored() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = state();
        translate_event(
            &json!({"type": "message.part.updated", "properties": {"part": {
                "id": "p1", "sessionID": "other", "type": "text", "text": "x"
            }}}),
            "s1",
            &mut turn,
            &tx,
        );
        assert!(drain(&mut rx).is_empty(), "the event stream is shared");
    }

    #[test]
    fn a_bash_tool_part_maps_onto_the_shell_renderer() {
        let detail = detail_from_part(
            "bash",
            &json!({"state": {"status": "completed", "input": {"command": "ls"}, "output": "a\nb"}}),
        );
        assert_eq!(
            detail,
            ToolCallDetail::Shell {
                command: "ls".into(),
                output: "a\nb".into(),
                exit_code: None
            }
        );
    }

    #[test]
    fn an_unknown_opencode_tool_keeps_its_data_under_unknown() {
        let detail = detail_from_part(
            "mystery",
            &json!({"state": {"input": {"a": 1}, "output": "done"}}),
        );
        match detail {
            ToolCallDetail::Unknown { raw } => {
                assert_eq!(raw["input"]["a"], 1);
                assert_eq!(raw["output"], "done");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn session_errors_end_the_turn_with_a_classified_failure() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = state();
        translate_event(
            &json!({"type": "session.error", "properties": {"error": {"data": {
                "message": "provider returned 429 rate limit exceeded"
            }}}}),
            "s1",
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::TurnFailed { error, .. } => {
                assert_eq!(error.code, TurnErrorCode::RateLimited);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(turn.id.is_none(), "the turn is over");
    }

    #[test]
    fn http_failures_map_onto_actionable_codes() {
        assert_eq!(
            classify_http(401, "no key").code,
            TurnErrorCode::MissingCredentials
        );
        assert_eq!(classify_http(429, "slow down").code, TurnErrorCode::RateLimited);
        assert_eq!(classify_http(500, "boom").code, TurnErrorCode::Upstream);
    }
}
