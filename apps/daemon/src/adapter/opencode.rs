//! Adapter for OpenCode: a local HTTP server with an SSE event stream.
//!
//! This one exists to keep the abstraction honest. The other two adapters both
//! talk to a child process over stdio; if the normalized layer can also absorb
//! a request/response API whose events arrive on a separate stream, it is a
//! real abstraction rather than a rename of one transport
//! (`docs/architecture.md` §3.3).

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use genehub_proto::{
    Capabilities, Catalog, ImportContinuation, ModeInfo, ModelInfo, PermissionOutcome, ProbeState,
    SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};

use super::{
    find_executable, AgentAdapter, AgentSession, Chatter, ImportCandidate, ImportedHistory,
    PersistHandle, PromptInput, ProviderMap, SessionConfig,
};

const BINARY: &str = "opencode";
const EVENT_CAPACITY: usize = 1024;
const OPENCODE_ALLOW_ALL: &str = r#"{"*":"allow","read":"allow","edit":"allow","glob":"allow","grep":"allow","bash":"allow","task":"allow","skill":"allow","lsp":"allow","question":"allow","webfetch":"allow","websearch":"allow","external_directory":"allow","doom_loop":"allow"}"#;

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
            set_effort: false,
            interrupt: true,
            set_model: true,
            set_mode: false,
            permissions: false,
            resume: true,
            fork: false,
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
            default_effort: None,
            // OpenCode has its own commands over HTTP, which we do not read yet.
            commands: Vec::new(),
            models: Vec::<ModelInfo>::new(),
            modes: Vec::<ModeInfo>::new(),
            default_model: None,
            default_mode: None,
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let binary = find_executable(BINARY).ok_or_else(|| anyhow!("OpenCode is not installed"))?;
        let port = pick_port()?;
        let base = format!("http://127.0.0.1:{port}");

        let mut command = Command::new(&binary);
        command
            .arg("serve")
            .arg("--hostname")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env("OPENCODE_PERMISSION", OPENCODE_ALLOW_ALL)
            .current_dir(&config.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::without_a_window(&mut command);
        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {}", binary.display()))?;

        // What the server says about itself is worth keeping for two reasons: it
        // is the only account of why a start failed, and a pipe nobody reads
        // eventually fills and stops the process that is writing into it.
        let chatter = Chatter::default();
        chatter.watch("opencode", child.stdout.take()).await;
        chatter.watch("opencode", child.stderr.take()).await;

        // No overall timeout, deliberately. A prompt POST here blocks for the whole
        // turn, and a real coding task runs longer than any number we could pick —
        // five minutes used to be that number, which means we cut off a turn the
        // agent was still working on and called it a timeout. The event stream is
        // held open even longer than that, and idle.
        //
        // What is bounded is reaching the server at all: it is on loopback, so a
        // connect that does not happen immediately is not going to happen.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        wait_until_ready(&http, &base, &mut child, &chatter).await?;

        // Prefer the session a previous run of this GeneHub session left behind.
        // OpenCode keeps those on disk across `serve` restarts; without this we
        // declared `resume: true`, stored an id, and then quietly opened a blank
        // conversation on every first prompt after a restart.
        let remote_session = open_session(&http, &base, &config.cwd, &config.resume).await?;

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
            additional_system_prompt: config.additional_system_prompt.clone(),
            events,
            turn,
            child: Mutex::new(Some(child)),
        }))
    }

    async fn list_import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Result<Option<Vec<ImportCandidate>>> {
        let mut server = OpenCodeImportServer::start(cwd).await?;
        let outcome = async {
            let response = server
                .http
                .get(format!("{}/session", server.base))
                .query(&[("directory", cwd.to_string_lossy().as_ref())])
                .send()
                .await
                .context("listing OpenCode sessions")?
                .error_for_status()
                .context("OpenCode refused session listing")?;
            let sessions: Value = response.json().await.context("reading OpenCode sessions")?;
            let mut candidates = sessions
                .as_array()
                .into_iter()
                .flatten()
                .filter(|session| {
                    session
                        .get("directory")
                        .and_then(Value::as_str)
                        .is_none_or(|directory| Path::new(directory) == cwd)
                })
                .filter_map(|session| {
                    let source_id = session.get("id")?.as_str()?.to_string();
                    let title = session
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("OpenCode 会话")
                        .to_string();
                    Some(ImportCandidate {
                        source_id,
                        preview: String::new(),
                        title,
                        updated_at_ms: session
                            .get("time")
                            .and_then(|time| time.get("updated"))
                            .and_then(Value::as_i64)
                            .unwrap_or_default(),
                        continuation: ImportContinuation::Native,
                    })
                })
                .collect::<Vec<_>>();
            candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at_ms));
            candidates.truncate(limit);
            Ok(candidates)
        }
        .await;
        server.stop().await;
        outcome.map(Some)
    }

    async fn import_history(&self, cwd: &Path, source_id: &str) -> Result<ImportedHistory> {
        let mut server = OpenCodeImportServer::start(cwd).await?;
        let outcome = async {
            let session: Value = server
                .http
                .get(format!("{}/session/{source_id}", server.base))
                .query(&[("directory", cwd.to_string_lossy().as_ref())])
                .send()
                .await
                .context("loading selected OpenCode session")?
                .error_for_status()
                .context("OpenCode could not load the selected session")?
                .json()
                .await?;
            let messages: Value = server
                .http
                .get(format!("{}/session/{source_id}/message", server.base))
                .query(&[("directory", cwd.to_string_lossy().as_ref())])
                .send()
                .await
                .context("loading selected OpenCode history")?
                .error_for_status()
                .context("OpenCode could not load the selected history")?
                .json()
                .await?;
            let mut items = Vec::new();
            for message in messages.as_array().into_iter().flatten() {
                let role = message
                    .get("info")
                    .and_then(|info| info.get("role"))
                    .and_then(Value::as_str);
                let text = message
                    .get("parts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.trim().is_empty() {
                    continue;
                }
                let id = format!("import-{}", uuid::Uuid::new_v4().simple());
                match role {
                    Some("user") => items.push(TimelineItem::UserMessage {
                        id,
                        text,
                        attachments: Vec::new(),
                    }),
                    Some("assistant") => items.push(TimelineItem::AssistantMessage { id, text }),
                    _ => {}
                }
            }
            Ok(ImportedHistory {
                title: session
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                created_at_ms: session
                    .get("time")
                    .and_then(|time| time.get("created"))
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                updated_at_ms: session
                    .get("time")
                    .and_then(|time| time.get("updated"))
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                items,
                persist: Some(PersistHandle {
                    agent_id: "opencode".into(),
                    value: json!({ "sessionId": source_id }),
                }),
                continuation: ImportContinuation::Native,
                warnings: Vec::new(),
            })
        }
        .await;
        server.stop().await;
        outcome
    }
}

struct OpenCodeImportServer {
    http: reqwest::Client,
    base: String,
    child: Child,
}

impl OpenCodeImportServer {
    async fn start(cwd: &Path) -> Result<Self> {
        let binary = find_executable(BINARY).ok_or_else(|| anyhow!("OpenCode is not installed"))?;
        let port = pick_port()?;
        let base = format!("http://127.0.0.1:{port}");
        let mut command = Command::new(&binary);
        command
            .arg("serve")
            .arg("--hostname")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env("OPENCODE_PERMISSION", OPENCODE_ALLOW_ALL)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::without_a_window(&mut command);
        let mut child = command
            .spawn()
            .context("spawning OpenCode for session import")?;
        let chatter = Chatter::default();
        chatter.watch("opencode-import", child.stdout.take()).await;
        chatter.watch("opencode-import", child.stderr.take()).await;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        wait_until_ready(&http, &base, &mut child, &chatter).await?;
        Ok(Self { http, base, child })
    }

    async fn stop(&mut self) {
        super::kill_tree(&mut self.child).await;
    }
}

#[derive(Default)]
struct TurnState {
    id: Option<String>,
    /// OpenCode addresses parts by id; the mapping to our item ids is kept here
    /// so repeated updates land on the same timeline entry.
    parts: std::collections::HashMap<String, String>,
    /// Which messages belong to the assistant. Parts carry only a message id,
    /// and OpenCode streams the user's own message back the same way it streams
    /// the reply; without this the prompt would be echoed as an answer.
    assistant_messages: std::collections::HashSet<String>,
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
    additional_system_prompt: Option<String>,
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
            started_at_ms: 0,
        });

        let model = self.model.lock().await.clone();
        let body = message_body(
            &input,
            model.as_deref(),
            self.additional_system_prompt.as_deref(),
        );

        let url = format!("{}/session/{}/message", self.base, self.remote_session);
        let http = self.http.clone();
        let events = self.events.clone();
        let turn_state = self.turn.clone();
        let completed = turn_id.clone();

        // The call blocks for the whole turn. Its body is the finished message,
        // and it is the authority: the event stream is a separate connection
        // that can still be in flight when this returns, which on a fast turn
        // means the reply would otherwise arrive after the turn was declared
        // over — or never.
        tokio::spawn(async move {
            let outcome = http.post(url).json(&body).send().await;
            let event = match outcome {
                Ok(response) if response.status().is_success() => {
                    let settled = response.json::<Value>().await.unwrap_or(Value::Null);
                    let mut state = turn_state.lock().await;
                    if state.id.as_deref() != Some(completed.as_str()) {
                        return;
                    }
                    reconcile(&settled, &mut state, &events, &completed);
                    state.id = None;
                    SessionEvent::TurnCompleted {
                        turn_id: completed,
                        usage: usage_from_info(settled.get("info").unwrap_or(&Value::Null)),
                        fork_checkpoint: None,
                    }
                }
                Ok(response) => {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    let mut state = turn_state.lock().await;
                    if state.id.as_deref() != Some(completed.as_str()) {
                        return;
                    }
                    state.id = None;
                    SessionEvent::TurnFailed {
                        turn_id: completed,
                        error: classify_http(status.as_u16(), &body),
                    }
                }
                Err(error) => {
                    let mut state = turn_state.lock().await;
                    if state.id.as_deref() != Some(completed.as_str()) {
                        return;
                    }
                    state.id = None;
                    SessionEvent::TurnFailed {
                        turn_id: completed,
                        error: TurnError {
                            code: if error.is_timeout() {
                                TurnErrorCode::Timeout
                            } else {
                                TurnErrorCode::AgentCrashed
                            },
                            message: format!("OpenCode did not answer: {error}"),
                        },
                    }
                }
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
            // The tree: on Windows this handle is the `.cmd` shim, and the HTTP
            // server with the open port is its child.
            super::kill_tree(&mut child).await;
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        if !model_id.contains('/') {
            return Err(anyhow!("model id must be 'provider/id', got '{model_id}'"));
        }
        *self.model.lock().await = Some(model_id.to_string());
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

/// Opens the OpenCode session this GeneHub session should talk to.
///
/// When a previous run left a `PersistHandle`, that id is asked for first —
/// OpenCode keeps sessions on disk across `serve` restarts, which is the whole
/// of what `capabilities.resume` promised. A missing id falls through to a
/// fresh session rather than failing the start: the daemon still has the
/// timeline, and a blank OpenCode context is better than a session that cannot
/// send at all.
async fn open_session(
    http: &reqwest::Client,
    base: &str,
    cwd: &Path,
    resume: &Option<PersistHandle>,
) -> Result<String> {
    if let Some(session_id) = resume_session_id(resume) {
        let response = http
            .get(format!("{base}/session/{session_id}"))
            .query(&[("directory", cwd.to_string_lossy().as_ref())])
            .send()
            .await
            .with_context(|| format!("looking up OpenCode session {session_id}"))?;
        if response.status().is_success() {
            let body: Value = response
                .json()
                .await
                .with_context(|| format!("reading OpenCode session {session_id}"))?;
            if let Some(found) = body.get("id").and_then(Value::as_str) {
                return Ok(found.to_string());
            }
            return Ok(session_id);
        }
        tracing::warn!(
            "OpenCode session {session_id} was not found ({}); starting a new one",
            response.status()
        );
    }

    let created: Value = http
        .post(format!("{base}/session"))
        .json(&json!({}))
        .send()
        .await
        .context("creating an OpenCode session")?
        .json()
        .await
        .context("reading the new OpenCode session")?;
    created
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("OpenCode did not return a session id"))
}

/// The OpenCode session id a previous run left behind, when it is ours.
fn resume_session_id(resume: &Option<PersistHandle>) -> Option<String> {
    resume
        .as_ref()
        .filter(|handle| handle.agent_id == "opencode")
        .and_then(|handle| handle.value.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// How long a start may take before we call it a hang.
///
/// The first run on a machine is not a start, it is an install: OpenCode fetches
/// a provider list and its own plugin runtime before it listens. Thirty seconds
/// was enough on a warm machine and turned every fresh install into "the agent
/// failed" — an error about our software, for someone whose only mistake was
/// having just installed theirs. A warm start still answers in well under a
/// second; this is only the ceiling.
const READY_BUDGET: Duration = Duration::from_secs(180);

async fn wait_until_ready(
    http: &reqwest::Client,
    base: &str,
    child: &mut Child,
    chatter: &Chatter,
) -> Result<()> {
    let deadline = std::time::Instant::now() + READY_BUDGET;
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
        // A process that has already exited is never going to answer, and sitting
        // out the rest of the budget replaces the reason it left with a timeout.
        if let Some(status) = child.try_wait()? {
            chatter.settle().await;
            return Err(anyhow!(
                "OpenCode stopped before it was ready ({status}){}",
                chatter.tail()
            ));
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_millis(500));
    }
    Err(anyhow!(
        "OpenCode was not ready within {}s{}",
        READY_BUDGET.as_secs(),
        chatter.tail()
    ))
}

#[cfg(test)]
mod start_tests {
    use super::*;

    /// The case that used to cost three minutes and end in a timeout that said
    /// nothing: the server is gone, and it said why on its way out.
    #[tokio::test]
    async fn a_server_that_dies_is_reported_with_what_it_said() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'cannot bind: address in use' >&2; exit 3")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("sh runs");
        let chatter = Chatter::default();
        chatter.watch("opencode", child.stdout.take()).await;
        chatter.watch("opencode", child.stderr.take()).await;

        let started = std::time::Instant::now();
        let error = wait_until_ready(
            &reqwest::Client::new(),
            // Nothing listens here, so readiness can only come from the child,
            // and the child is on its way out.
            "http://127.0.0.1:1",
            &mut child,
            &chatter,
        )
        .await
        .expect_err("a dead server is not ready");

        let said = error.to_string();
        assert!(said.contains("stopped before it was ready"), "{said}");
        assert!(
            said.contains("address in use"),
            "the reason it left is missing from: {said}"
        );
        assert!(
            started.elapsed() < READY_BUDGET,
            "waited out the whole budget for a process that had already exited"
        );
    }
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
    // Worth a line: with the stream gone, a turn produces nothing at all until the
    // prompt call returns with the finished message, and "it did not stream" is
    // otherwise indistinguishable from "it is stuck".
    tracing::warn!(
        "the OpenCode event stream for {remote_session} ended; \
                    replies will arrive only when each turn finishes"
    );
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
            // The role lives on the message, which OpenCode always announces
            // before the parts that belong to it.
            let message_id = part
                .get("messageID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !state.assistant_messages.contains(message_id) {
                return;
            }
            emit_part(part, &turn_id, state, events);
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
        "message.updated" => {
            let info = properties.get("info").unwrap_or(&Value::Null);
            if info.get("sessionID").and_then(Value::as_str) != Some(remote_session) {
                return;
            }
            if info.get("role").and_then(Value::as_str) == Some("assistant") {
                if let Some(id) = info.get("id").and_then(Value::as_str) {
                    state.assistant_messages.insert(id.to_string());
                }
            }
        }
        "message.part.removed" | "session.idle" | "session.updated" => {}
        _ => {}
    }
}

/// Turns one OpenCode part into a timeline item.
///
/// Parts are addressed by id and resent in full, so replaying the same part
/// twice is harmless: the second copy replaces the first rather than appending
/// to it. That property is what lets the finished message be reconciled against
/// whatever the event stream already delivered.
fn emit_part(
    part: &Value,
    turn_id: &str,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(part_id) = part.get("id").and_then(Value::as_str) else {
        return;
    };
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let (item_id, _) = state.item_id_for(part_id);
    let turn_id = turn_id.to_string();

    let item = match part_type {
        "text" | "reasoning" => {
            let text = part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if part_type == "reasoning" {
                TimelineItem::Reasoning { id: item_id, text }
            } else {
                TimelineItem::AssistantMessage { id: item_id, text }
            }
        }
        "tool" => {
            let name = part
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let status = match part
                .get("state")
                .and_then(|state| state.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("pending")
            {
                "running" => ToolStatus::Running,
                "completed" => ToolStatus::Ok,
                "error" => ToolStatus::Error,
                _ => ToolStatus::Pending,
            };
            TimelineItem::ToolCall {
                id: item_id,
                name: name.clone(),
                status,
                detail: detail_from_part(&name, part),
            }
        }
        _ => return,
    };
    let _ = events.send(SessionEvent::Item { turn_id, item });
}

/// Builds the `parts` array for `POST /session/{id}/message`. Only inline
/// (`dataBase64`) image attachments are forwarded as `file` parts — that is
/// the only shape the composer produces today (pasted screenshots); a bare
/// `path` would need the daemon to read the file itself, which no caller
/// needs yet. OpenCode's file part takes a data URL, not raw base64
/// (`message-v2.ts`'s `FilePart.url`).
fn message_parts(input: &PromptInput) -> Vec<Value> {
    let mut parts = vec![json!({ "type": "text", "text": input.text })];
    for attachment in &input.attachments {
        if let Some(data) = &attachment.data_base64 {
            if attachment.mime.starts_with("image/") {
                parts.push(json!({
                    "type": "file",
                    "mime": attachment.mime,
                    "filename": attachment.name,
                    "url": format!("data:{};base64,{}", attachment.mime, data),
                }));
            }
        }
    }
    parts
}

fn message_body(input: &PromptInput, model: Option<&str>, system: Option<&str>) -> Value {
    let mut body = json!({ "parts": message_parts(input) });
    if let Some(prompt) = system.filter(|value| !value.trim().is_empty()) {
        // Native OpenCode message API field: higher-priority context kept
        // separate from the user's text and refreshed on every turn.
        body["system"] = json!(prompt);
    }
    if let Some((provider, id)) = model.and_then(|value| value.split_once('/')) {
        body["model"] = json!({ "providerID": provider, "modelID": id });
    }
    body
}

/// Replays the finished message, so nothing the event stream missed is lost.
fn reconcile(
    settled: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
    turn_id: &str,
) {
    if let Some(id) = settled
        .get("info")
        .and_then(|info| info.get("id"))
        .and_then(Value::as_str)
    {
        state.assistant_messages.insert(id.to_string());
    }
    let Some(parts) = settled.get("parts").and_then(Value::as_array) else {
        return;
    };
    for part in parts {
        emit_part(part, turn_id, state, events);
    }
}

fn usage_from_info(info: &Value) -> Usage {
    let tokens = info.get("tokens").unwrap_or(&Value::Null);
    let count = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cache = tokens.get("cache").cloned().unwrap_or(Value::Null);
    Usage {
        input_tokens: count(tokens, "input"),
        output_tokens: count(tokens, "output"),
        cache_read_tokens: count(&cache, "read"),
        cache_write_tokens: count(&cache, "write"),
        cost_usd: info.get("cost").and_then(Value::as_f64),
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
    body.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use genehub_proto::Attachment;

    use super::*;

    #[test]
    fn spawned_opencode_allows_tools_and_external_directories() {
        let permission: Value = serde_json::from_str(OPENCODE_ALLOW_ALL).unwrap();
        for key in [
            "*",
            "read",
            "edit",
            "bash",
            "task",
            "webfetch",
            "websearch",
            "external_directory",
            "doom_loop",
        ] {
            assert_eq!(permission[key], "allow", "{key} must not prompt");
        }
    }

    /// A turn already told that `m1` is the assistant's message, which is the
    /// order the real server uses.
    fn state() -> TurnState {
        TurnState {
            id: Some("t1".into()),
            assistant_messages: ["m1".to_string()].into_iter().collect(),
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

    /// A pasted screenshot must become a `file` part with a data URL —
    /// OpenCode's `FilePart.url` takes a URL, not raw base64.
    #[test]
    fn a_pasted_image_becomes_a_file_part_with_a_data_url() {
        let input = PromptInput {
            text: "看看这个".into(),
            attachments: vec![Attachment {
                name: "shot.png".into(),
                mime: "image/png".into(),
                path: None,
                data_base64: Some("Zm9v".into()),
            }],
        };
        assert_eq!(
            message_parts(&input),
            vec![
                json!({ "type": "text", "text": "看看这个" }),
                json!({ "type": "file", "mime": "image/png", "filename": "shot.png",
                        "url": "data:image/png;base64,Zm9v" }),
            ]
        );
    }

    #[test]
    fn artifact_guidance_uses_the_native_system_field() {
        let input = PromptInput {
            text: "生成报告".into(),
            attachments: vec![],
        };
        let body = message_body(
            &input,
            Some("openai/gpt-5"),
            Some("Use https://app.example/assets/preview/v2/device/workspace/r_root/"),
        );
        assert_eq!(
            body["system"],
            "Use https://app.example/assets/preview/v2/device/workspace/r_root/"
        );
        assert_eq!(body["parts"][0]["text"], "生成报告");
        assert_eq!(body["model"]["providerID"], "openai");
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
        assert_eq!(
            message_parts(&input),
            vec![json!({ "type": "text", "text": "" })]
        );
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
                    "id": "p1", "sessionID": "s1", "messageID": "m1", "type": "text", "text": text
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
                "id": "p1", "sessionID": "other", "messageID": "m1", "type": "text", "text": "x"
            }}}),
            "s1",
            &mut turn,
            &tx,
        );
        assert!(drain(&mut rx).is_empty(), "the event stream is shared");
    }

    /// OpenCode streams the prompt back as parts of a user message before the
    /// reply arrives. Treating those as output made the agent appear to answer
    /// by repeating the question.
    #[test]
    fn the_users_own_message_is_not_replayed_as_the_answer() {
        let (tx, mut rx) = broadcast::channel(16);
        let mut turn = TurnState {
            id: Some("t1".into()),
            ..TurnState::default()
        };
        let announce = |role: &str, id: &str| {
            json!({"type": "message.updated", "properties": {"info": {
                "id": id, "sessionID": "s1", "role": role
            }}})
        };
        let part = |message: &str, part_id: &str, text: &str| {
            json!({"type": "message.part.updated", "properties": {"part": {
                "id": part_id, "sessionID": "s1", "messageID": message,
                "type": "text", "text": text
            }}})
        };

        for event in [
            announce("user", "m_user"),
            part("m_user", "p_user", "what is 2+2"),
            announce("assistant", "m_reply"),
            part("m_reply", "p_reply", "four"),
        ] {
            translate_event(&event, "s1", &mut turn, &tx);
        }

        let texts: Vec<String> = drain(&mut rx)
            .into_iter()
            .filter_map(|event| match event {
                SessionEvent::Item {
                    item: TimelineItem::AssistantMessage { text, .. },
                    ..
                } => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["four".to_string()]);
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
        assert_eq!(
            classify_http(429, "slow down").code,
            TurnErrorCode::RateLimited
        );
        assert_eq!(classify_http(500, "boom").code, TurnErrorCode::Upstream);
    }

    /// `capabilities.resume` is only honest if a stored id is actually what we
    /// ask OpenCode for. The rest of `open_session` needs a live server; this
    /// is the part that decides whether that path is taken at all.
    #[test]
    fn a_resume_handle_only_counts_when_it_is_ours_and_names_a_session() {
        assert_eq!(resume_session_id(&None), None);
        assert_eq!(
            resume_session_id(&Some(PersistHandle {
                agent_id: "claude".into(),
                value: json!({ "sessionId": "s1" }),
            })),
            None
        );
        assert_eq!(
            resume_session_id(&Some(PersistHandle {
                agent_id: "opencode".into(),
                value: json!({ "sessionId": "" }),
            })),
            None
        );
        assert_eq!(
            resume_session_id(&Some(PersistHandle {
                agent_id: "opencode".into(),
                value: json!({ "sessionId": "ses_abc" }),
            })),
            Some("ses_abc".into())
        );
    }
}
