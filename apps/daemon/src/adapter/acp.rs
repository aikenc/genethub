//! Adapter for CLIs that speak the Agent Client Protocol over stdio.
//!
//! One implementation covers every ACP-speaking agent, which is why this is in
//! the MVP rather than later: it is the cheapest way to stop the abstraction
//! from being a description of our own agent.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::os_process::{Child, ChildStdin, Command};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Capabilities, Catalog, ImportContinuation, InteractionOption, InteractionQuestion, ItemDelta,
    ModeInfo, ModelInfo, PermissionOption, PermissionOptionKind, PermissionOutcome,
    PermissionRequest, PermissionRequestKind, ProbeState, RuntimeAxisInfo, RuntimeAxisValue,
    SessionEvent, TimelineItem, ToolCallDetail, ToolImage, ToolKind, ToolStatus, TurnError,
    TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, oneshot, Mutex};

use super::stdio::write_json_line;
use super::usage;
use super::{
    find_executable_in, AgentAdapter, AgentSession, Chatter, ImportCandidate, ImportedHistory,
    PersistHandle, PromptInput, ProviderMap, SessionConfig,
};

const EVENT_CAPACITY: usize = 1024;
const PROTOCOL_VERSION: i64 = 1;
/// How long a throwaway handshake may take. Cursor's first answer can be slow.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);
/// `cursor-agent --list-models` is a file/network read, not a session.
const LIST_MODELS_TIMEOUT: Duration = Duration::from_secs(15);
/// Asking whether this install is logged in. Short: it reads a file.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5);

pub struct AcpAdapter {
    id: String,
    label: String,
    command: Vec<String>,
    extra_dirs: Vec<PathBuf>,
    /// When set, probe also asks this CLI whether it is logged in.
    login_status: bool,
    /// What `session/new` told us about models and modes, read once per daemon
    /// run so the picker can be drawn before anyone opens a session.
    hello: tokio::sync::OnceCell<Option<Hello>>,
}

/// What one `session/new` told us about this install.
#[derive(Clone, Default)]
struct Hello {
    models: Vec<ModelInfo>,
    modes: Vec<ModeInfo>,
    default_model: Option<String>,
    default_mode: Option<String>,
    model_config_id: Option<String>,
    mode_config_id: Option<String>,
    runtime_axes: Vec<RuntimeAxisInfo>,
}

/// Parsed `session/new` result, reused by discovery and live sessions.
struct Setup {
    session_id: String,
    models: Vec<ModelInfo>,
    modes: Vec<ModeInfo>,
    default_model: Option<String>,
    default_mode: Option<String>,
    model_config_id: Option<String>,
    mode_config_id: Option<String>,
    runtime_axes: Vec<RuntimeAxisInfo>,
}

impl AcpAdapter {
    pub fn new(id: impl Into<String>, label: impl Into<String>, command: Vec<String>) -> Self {
        AcpAdapter {
            id: id.into(),
            label: label.into(),
            command,
            extra_dirs: Vec::new(),
            login_status: false,
            hello: tokio::sync::OnceCell::new(),
        }
    }

    pub fn with_extra_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.extra_dirs = dirs;
        self
    }

    pub fn checking_login(mut self) -> Self {
        self.login_status = true;
        self
    }

    fn program(&self) -> Option<PathBuf> {
        find_executable_in(self.command.first()?, &self.extra_dirs)
    }

    async fn hello(&self, program: &Path) -> Option<Hello> {
        // A failed handshake must not be remembered for the rest of the
        // daemon's life: Cursor's ACP model table is sometimes empty on the
        // first try, and a timeout while the CLI is updating used to hide the
        // picker until someone restarted us.
        if let Some(cached) = self.hello.get() {
            return cached.clone();
        }
        let found = discover(program, &self.command).await;
        if let Some(hello) = found.clone() {
            let _ = self.hello.set(Some(hello));
        }
        found
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
            set_effort: false,
            interrupt: true,
            // Cursor exposes models through `session/new`,
            // `session/set_config_option`, and — when those come back empty —
            // `cursor-agent --list-models` plus a launch `--model` pin.
            set_model: true,
            set_mode: true,
            permissions: true,
            resume: true,
            fork: false,
            attachments: true,
        }
    }

    async fn probe(&self) -> ProbeState {
        let Some(program) = self.program() else {
            // Every entry on this adapter now names the program it runs, so a
            // missing one is simply not installed. The one case that needed
            // more explaining than that — `codex` present but a bridge package
            // missing — went away when Codex got its own adapter.
            return ProbeState::NotInstalled;
        };
        if !self.login_status {
            return ProbeState::Ready;
        }
        // An API key is a documented alternative to `cursor-agent login`.
        if std::env::var_os("CURSOR_API_KEY").is_some() {
            return ProbeState::Ready;
        }
        match logged_in(&program).await {
            Some(false) => ProbeState::Unavailable {
                reason: "找到了 Cursor，但它还没登录：先跑 cursor-agent login".into(),
            },
            // Logged in, or the question could not be asked at all. A slow or
            // unusual `cursor-agent status` is not a reason to hide a CLI that
            // is sitting right there.
            _ => ProbeState::Ready,
        }
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        let Some(program) = self.program() else {
            return Catalog::default();
        };
        let Some(hello) = self.hello(&program).await else {
            return Catalog::default();
        };
        Catalog {
            default_effort: None,
            // ACP does have a command list (`available_commands_update` on the
            // session), which we do not read yet.
            commands: Vec::new(),
            runtime_axes: Some(hello.runtime_axes),
            models: hello.models,
            modes: hello.modes,
            default_model: hello.default_model,
            default_mode: hello.default_mode,
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("{} is not installed", self.command[0]))?;
        let hello = self.hello(&program).await.unwrap_or_default();

        let mut command = Command::new(&program);
        command
            .args(spawn_args(&self.command, config.model_id.as_deref()))
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::apply_session_environment(&mut command, &config);
        super::owned_child(&mut command);

        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {}", program.display()))?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stdin = child.stdin.take().expect("stdin was piped");

        let child = Arc::new(Mutex::new(Some(child)));
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let turn = Arc::new(Mutex::new(TurnState::default()));

        // Kept: a bridge that exits explains itself on stderr, and that used to
        // be logged below the default filter and then thrown away.
        let said = Arc::new(Chatter::default());
        said.watch("acp", Some(stderr)).await;

        let stdin = Arc::new(Mutex::new(stdin));
        let session = AcpSession {
            stdin: stdin.clone(),
            events: events.clone(),
            pending: pending.clone(),
            turn: turn.clone(),
            next_id: AtomicI64::new(1),
            child: child.clone(),
            said: said.clone(),
            label: self.label.clone(),
            agent_id: self.id.clone(),
            acp_session: Mutex::new(None),
            persisted_session: std::sync::Mutex::new(None),
            resume_method: std::sync::Mutex::new(None),
            model_config_id: Mutex::new(hello.model_config_id),
            mode_config_id: Mutex::new(hello.mode_config_id),
            runtime_axis_ids: Mutex::new(
                hello
                    .runtime_axes
                    .iter()
                    .map(|axis| axis.id.clone())
                    .collect(),
            ),
            additional_system_prompt: config.additional_system_prompt.clone(),
        };

        tokio::spawn(read_loop(stdout, stdin, events, pending.clone(), turn));
        tokio::spawn(watch_for_exit(child.clone(), pending));

        session.initialize(&config).await?;
        Ok(Box::new(session))
    }

    async fn list_import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Result<Option<Vec<ImportCandidate>>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("{} is not installed", self.command[0]))?;
        let mut probe = AcpImportProbe::start(&program, &self.command, cwd).await?;
        let outcome = async {
            let initialized = probe.initialize().await?;
            if !acp_can_list_sessions(&initialized) {
                return Ok(None);
            }
            let (listed, _) = probe
                .call("session/list", json!({ "cwd": cwd, "cursor": null }))
                .await?;
            let mut candidates = listed
                .get("sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|session| {
                    let source_id = session.get("sessionId")?.as_str()?.to_string();
                    let title = session
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("ACP 会话")
                        .to_string();
                    Some(ImportCandidate {
                        source_id,
                        preview: String::new(),
                        title,
                        updated_at_ms: acp_time_ms(session.get("updatedAt")),
                        continuation: ImportContinuation::Native,
                    })
                })
                .collect::<Vec<_>>();
            candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at_ms));
            candidates.truncate(limit);
            Ok(Some(candidates))
        }
        .await;
        probe.stop().await;
        outcome
    }

    async fn import_history(&self, cwd: &Path, source_id: &str) -> Result<ImportedHistory> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("{} is not installed", self.command[0]))?;
        let mut probe = AcpImportProbe::start(&program, &self.command, cwd).await?;
        let outcome = async {
            let initialized = probe.initialize().await?;
            if !acp_can_list_sessions(&initialized) {
                anyhow::bail!("this ACP agent does not advertise session import");
            }
            let method = if initialized
                .get("agentCapabilities")
                .and_then(|capabilities| capabilities.get("loadSession"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "session/load"
            } else {
                match resume_method_in(&initialized) {
                    Some(ResumeMethod::Load) => "session/load",
                    Some(ResumeMethod::Resume) => "session/resume",
                    None => anyhow::bail!("this ACP agent cannot load the selected session"),
                }
            };
            let (_, updates) = probe
                .call(
                    method,
                    json!({ "sessionId": source_id, "cwd": cwd, "mcpServers": [] }),
                )
                .await?;
            let items = acp_history_items(&updates);
            if items.is_empty() {
                anyhow::bail!(
                    "the ACP agent loaded the session but did not replay its visible history"
                );
            }
            let title = items.iter().find_map(|item| match item {
                TimelineItem::UserMessage { text, .. } => Some(acp_clip(text, 120)),
                _ => None,
            });
            let now = chrono::Utc::now().timestamp_millis();
            Ok(ImportedHistory {
                title,
                created_at_ms: now,
                updated_at_ms: now,
                items,
                persist: Some(PersistHandle {
                    agent_id: self.id.clone(),
                    value: json!({ "sessionId": source_id }),
                }),
                continuation: ImportContinuation::Native,
                warnings: Vec::new(),
            })
        }
        .await;
        probe.stop().await;
        outcome
    }
}

struct AcpImportProbe {
    child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<crate::os_process::ChildStdout>>,
    next_id: i64,
}

impl AcpImportProbe {
    async fn start(program: &Path, command: &[String], cwd: &Path) -> Result<Self> {
        let mut spawn = Command::new(program);
        spawn
            .args(&command[1..])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        super::owned_child(&mut spawn);
        let mut child = spawn
            .spawn()
            .context("spawning ACP agent for session import")?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        Ok(Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
        })
    }

    async fn initialize(&mut self) -> Result<Value> {
        let (initialized, _) = self
            .call(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": client_capabilities(),
                }),
            )
            .await?;
        Ok(initialized)
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<(Value, Vec<Value>)> {
        let id = self.next_id;
        self.next_id += 1;
        write_json_line(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await?;
        tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            let mut updates = Vec::new();
            while let Some(line) = self.lines.next_line().await? {
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if frame.get("id").and_then(Value::as_i64) == Some(id) {
                    if let Some(error) = frame.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown ACP error");
                        return Err(anyhow!("{method} failed: {message}"));
                    }
                    return Ok((frame.get("result").cloned().unwrap_or(Value::Null), updates));
                }
                if frame.get("method").and_then(Value::as_str) == Some("session/update") {
                    updates.push(frame.get("params").cloned().unwrap_or(Value::Null));
                    continue;
                }
                if let (Some(request_id), Some(request_method)) =
                    (frame.get("id"), frame.get("method").and_then(Value::as_str))
                {
                    write_json_line(
                        &mut self.stdin,
                        &unsupported_request(request_id, request_method),
                    )
                    .await?;
                }
            }
            Err(anyhow!("{method} ended before the ACP agent answered"))
        })
        .await
        .map_err(|_| anyhow!("{method} timed out"))?
    }

    async fn stop(&mut self) {
        super::kill_tree(&mut self.child).await;
    }
}

fn acp_can_list_sessions(initialized: &Value) -> bool {
    let value = initialized
        .get("agentCapabilities")
        .and_then(|capabilities| capabilities.get("sessionCapabilities"))
        .and_then(|session| session.get("list"));
    value.is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
}

fn acp_time_ms(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or_default(),
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|time| time.timestamp_millis())
            .unwrap_or_default(),
        _ => 0,
    }
}

fn acp_history_items(updates: &[Value]) -> Vec<TimelineItem> {
    let mut items: Vec<TimelineItem> = Vec::new();
    let mut current_role = "";
    for params in updates {
        let update = params.get("update").unwrap_or(&Value::Null);
        let role = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("user_message_chunk") => "user",
            Some("agent_message_chunk") => "assistant",
            _ => continue,
        };
        let text = update
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        if role == current_role {
            if let Some(last) = items.last_mut() {
                let _ = last.append_text(text);
                continue;
            }
        }
        current_role = role;
        let id = format!("import-{}", uuid::Uuid::new_v4().simple());
        items.push(if role == "user" {
            TimelineItem::UserMessage {
                id,
                text: text.to_string(),
                attachments: Vec::new(),
            }
        } else {
            TimelineItem::AssistantMessage {
                id,
                text: text.to_string(),
                received_at_ms: None,
            }
        });
    }
    items
}

fn acp_clip(value: &str, limit: usize) -> String {
    let mut output: String = value.trim().chars().take(limit).collect();
    if value.trim().chars().count() > limit {
        output.push('…');
    }
    output
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
    usage: Usage,
}

impl TurnState {
    fn next_item_id(&mut self) -> String {
        self.counter += 1;
        let turn = self.id.as_deref().unwrap_or("t0");
        format!("{turn}-{}", self.counter)
    }
}

struct AcpSession {
    stdin: Arc<Mutex<ChildStdin>>,
    events: broadcast::Sender<SessionEvent>,
    pending: PendingMap,
    turn: Arc<Mutex<TurnState>>,
    next_id: AtomicI64,
    child: Arc<Mutex<Option<Child>>>,
    /// What the bridge said on its way out, for the turn that was waiting on it.
    said: Arc<Chatter>,
    /// The agent's name as the user knows it, for the same failure.
    label: String,
    agent_id: String,
    acp_session: Mutex<Option<String>>,
    persisted_session: std::sync::Mutex<Option<String>>,
    resume_method: std::sync::Mutex<Option<ResumeMethod>>,
    model_config_id: Mutex<Option<String>>,
    mode_config_id: Mutex<Option<String>>,
    runtime_axis_ids: Mutex<Vec<String>>,
    /// ACP has no standard system/developer-instruction field. Product
    /// guidance is mapped per agent: Cursor gets an embedded resource plus
    /// `_meta.systemPrompt.append` so its auto-namer sees only user text;
    /// other ACP CLIs still get a leading text block. The daemon timeline
    /// retains only user text either way.
    additional_system_prompt: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResumeMethod {
    Resume,
    Load,
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
        let initialized = self.call("initialize", initialize_params()).await?;
        if let Some(method_id) = first_auth_method(&initialized) {
            // Official Cursor ACP flow is initialize → authenticate →
            // session/new. A missing login must not abort the session: the
            // CLI still answers session/new, and the picker already said
            // whether this install is usable.
            if let Err(error) = self
                .call("authenticate", json!({ "methodId": method_id }))
                .await
            {
                tracing::warn!("ACP authenticate ({method_id}) failed: {error}");
            }
        }
        let resume_method = resume_method_in(&initialized);
        *self.resume_method.lock().unwrap() = resume_method;

        let resumed = config
            .resume
            .as_ref()
            .filter(|handle| handle.agent_id == self.agent_id)
            .and_then(|handle| handle.value.get("sessionId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let session_id = if let Some(session_id) = resumed {
            let method = resume_method.ok_or_else(|| {
                anyhow!("this ACP agent did not advertise session resume or load support")
            })?;
            self.call(
                match method {
                    ResumeMethod::Resume => "session/resume",
                    ResumeMethod::Load => "session/load",
                },
                json!({
                    "sessionId": session_id,
                    "cwd": config.cwd,
                    "mcpServers": [],
                }),
            )
            .await
            .with_context(|| format!("resuming ACP session {session_id}"))?;
            session_id.to_string()
        } else {
            let result = self
                .call(
                    "session/new",
                    session_new_params(
                        config.cwd.as_path(),
                        config.additional_system_prompt.as_deref(),
                    ),
                )
                .await?;
            let setup = parse_session_new(&result)?;
            *self.model_config_id.lock().await = setup.model_config_id.clone();
            *self.mode_config_id.lock().await = setup.mode_config_id.clone();
            *self.runtime_axis_ids.lock().await = setup
                .runtime_axes
                .iter()
                .map(|axis| axis.id.clone())
                .collect();
            setup.session_id
        };
        *self.acp_session.lock().await = Some(session_id.clone());
        *self.persisted_session.lock().unwrap() = Some(session_id);

        if let Some(model_id) = config.model_id.as_ref() {
            if let Err(error) = self.set_model(model_id).await {
                // Cursor's published workaround when ACP cannot switch
                // models at runtime is `--model` on the launch line, which
                // `start` already passed. Failing the session here would
                // throw away a pin that is already in force.
                if self.agent_id == "cursor" || self.agent_id.contains("cursor") {
                    tracing::warn!("ACP runtime model switch failed after launch pin: {error}");
                } else {
                    return Err(error);
                }
            }
        }
        if let Some(mode_id) = config.mode_id.as_ref() {
            self.set_mode(mode_id).await?;
        }
        for (axis_id, value_id) in &config.runtime_values {
            self.set_runtime_axis(axis_id, value_id).await?;
        }
        Ok(())
    }

    async fn session_id(&self) -> Result<String> {
        self.acp_session
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow!("the ACP session was never established"))
    }

    async fn set_config_option(&self, config_id: &str, value: Value) -> Result<()> {
        let session_id = self.session_id().await?;
        self.call(
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": config_id,
                "value": value,
            }),
        )
        .await?;
        Ok(())
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
            // The first round's clock starts with the request, not the first
            // chunk, so TTFT includes the model's thinking-before-typing.
            usage::record_round_start(&mut turn.usage);
        }
        let _ = self.events.send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 0,
        });

        let events = self.events.clone();
        let turn_state = self.turn.clone();
        let params = json!({
            "sessionId": session_id,
            "prompt": prompt_blocks_with_context(
                &input,
                self.additional_system_prompt.as_deref(),
                guidance_placement(&self.agent_id),
            ),
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
        let child = self.child.clone();
        let said = self.said.clone();
        let label = self.label.clone();
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
                    _ => {
                        let mut usage = state.usage.clone();
                        if let Some(reported) = value.get("usage") {
                            let parsed = usage::parse_usage(reported);
                            if parsed.input_tokens > 0 || parsed.output_tokens > 0 {
                                let rounds = usage.llm_rounds;
                                let tool_out = usage.tool_output_tokens;
                                let previous = usage.clone();
                                usage = parsed;
                                usage.llm_rounds = rounds;
                                usage.tool_output_tokens = tool_out;
                                usage::preserve_timing(&mut usage, &previous);
                            }
                        }
                        usage::finalize_output_rate(&mut usage);
                        SessionEvent::TurnCompleted {
                            turn_id: completed_turn,
                            usage,
                            fork_checkpoint: None,
                        }
                    }
                },
                Ok(Err(message)) => SessionEvent::TurnFailed {
                    turn_id: completed_turn,
                    error: TurnError {
                        code: TurnErrorCode::Upstream,
                        message,
                    },
                },
                // The bridge went away mid-turn. Its exit code and last words are
                // the difference between "the CLI is not set up" and "we passed
                // it a flag it does not know", which read identically otherwise.
                Err(_) => SessionEvent::TurnFailed {
                    turn_id: completed_turn,
                    error: TurnError {
                        code: TurnErrorCode::AgentCrashed,
                        message: super::stopped(&label, &child, &said).await,
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

    async fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .await
            .as_ref()
            .and_then(|child| child.id())
    }

    async fn close(&self) -> Result<()> {
        let mut child = self.child.lock().await;
        if let Some(mut child) = child.take() {
            // The tree: on Windows this handle is an npm `.cmd` shim and the CLI
            // itself is its child, which would otherwise outlive the session.
            super::kill_tree(&mut child).await;
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        let config_id = self
            .model_config_id
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "model".into());
        self.set_config_option(&config_id, json!(model_id)).await
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        let session_id = self.session_id().await?;
        match self
            .call(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode_id }),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(_) => {
                let config_id = self
                    .mode_config_id
                    .lock()
                    .await
                    .clone()
                    .unwrap_or_else(|| "mode".into());
                self.set_config_option(&config_id, json!(mode_id)).await
            }
        }
    }

    async fn set_runtime_axis(&self, axis_id: &str, value_id: &str) -> Result<()> {
        if !self
            .runtime_axis_ids
            .lock()
            .await
            .iter()
            .any(|known| known == axis_id)
        {
            anyhow::bail!("ACP agent did not offer runtime axis '{axis_id}'");
        }
        self.set_config_option(axis_id, json!(value_id)).await
    }

    async fn respond_permission(
        &self,
        _request_id: &str,
        _outcome: PermissionOutcome,
    ) -> Result<()> {
        Err(anyhow!(
            "ACP permission requests stop the turn and resume as a new turn"
        ))
    }

    fn persistence(&self) -> Option<PersistHandle> {
        self.resume_method.lock().unwrap().as_ref()?;
        let session_id = self.persisted_session.lock().unwrap().clone()?;
        Some(PersistHandle {
            agent_id: self.agent_id.clone(),
            value: json!({ "sessionId": session_id }),
        })
    }
}

async fn logged_in(program: &Path) -> Option<bool> {
    if let Some(answer) = run_status(program, &["status", "--format", "json"]).await {
        return Some(answer);
    }
    run_status(program, &["status"]).await
}

async fn run_status(program: &Path, args: &[&str]) -> Option<bool> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    super::owned_child(&mut command);

    let output = tokio::time::timeout(LOGIN_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    login_from_status_output(&output.stdout, &output.stderr)
}

/// Phrased as "is it logged in", because that is the only sentence worth
/// acting on. Unknown wording — which account, which method, a new JSON
/// shape — means the CLI is usable, and a check that guessed at those would
/// hide working installs.
fn login_from_status_output(stdout: &[u8], stderr: &[u8]) -> Option<bool> {
    let mut said = String::from_utf8_lossy(stdout).to_string();
    said.push_str(&String::from_utf8_lossy(stderr));
    if let Some(value) = json_object_in(&said) {
        if let Some(flag) = json_logged_in(&value) {
            return Some(flag);
        }
    }
    let lower = said.to_ascii_lowercase();
    if lower.contains("not authenticated") || lower.contains("not logged in") {
        return Some(false);
    }
    if lower.contains("logged in") {
        return Some(true);
    }
    None
}

fn json_object_in(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

fn json_logged_in(value: &Value) -> Option<bool> {
    for key in [
        "loggedIn",
        "logged_in",
        "authenticated",
        "isAuthenticated",
        "is_authenticated",
    ] {
        if let Some(flag) = value.get(key).and_then(Value::as_bool) {
            return Some(flag);
        }
    }
    None
}

/// Runs one handshake against a throwaway process and takes its answers away.
///
/// A process of its own because the model and mode tables are wanted for the
/// agent picker, which is drawn long before any session exists.
async fn discover(program: &Path, command: &[String]) -> Option<Hello> {
    // Somewhere that exists and says nothing about any of the user's projects:
    // this answer is cached for every workspace.
    let scratch = crate::os_process::scratch_dir();
    let mut spawn = Command::new(program);
    spawn
        .args(&command[1..])
        .current_dir(&scratch)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    super::owned_child(&mut spawn);

    let mut child = match spawn.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!("could not ask an ACP agent what it supports: {error}");
            return None;
        }
    };
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;

    let answer = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        write_json_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": initialize_params(),
            }),
        )
        .await
        .ok()?;
        let initialized = answered(&mut lines, 1).await?;
        let mut next_id = 2;
        if let Some(method_id) = first_auth_method(&initialized) {
            write_json_line(
                &mut stdin,
                &json!({
                    "jsonrpc": "2.0",
                    "id": next_id,
                    "method": "authenticate",
                    "params": { "methodId": method_id },
                }),
            )
            .await
            .ok()?;
            let _ = answered(&mut lines, next_id).await;
            next_id += 1;
        }

        write_json_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": next_id,
                "method": "session/new",
                "params": { "cwd": scratch, "mcpServers": [] },
            }),
        )
        .await
        .ok()?;
        let created = answered(&mut lines, next_id).await?;
        Some(hello_from_setup(parse_session_new(&created).ok()?))
    })
    .await;

    super::kill_tree(&mut child).await;

    let handshake = match answer {
        Ok(Some(hello)) => Some(hello),
        Ok(None) => None,
        Err(_) => {
            tracing::warn!("an ACP agent did not answer a handshake in time");
            None
        }
    };
    let mut hello = handshake.clone().unwrap_or_default();
    if hello.models.is_empty() && speaks_cursor_acp(command) {
        if let Some(listed) = list_models_from_cli(program).await {
            merge_cli_models(&mut hello, listed);
        }
    }
    if handshake.is_some() || !hello.models.is_empty() {
        Some(hello)
    } else {
        None
    }
}

fn hello_from_setup(setup: Setup) -> Hello {
    Hello {
        models: setup.models,
        modes: setup.modes,
        default_model: setup.default_model,
        default_mode: setup.default_mode,
        model_config_id: setup.model_config_id,
        mode_config_id: setup.mode_config_id,
        runtime_axes: setup.runtime_axes,
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": client_capabilities(),
        "clientInfo": {
            "name": "genehub",
            "title": crate::channel::PRODUCT,
            "version": crate::version::product_version(),
        },
    })
}

fn client_capabilities() -> Value {
    json!({
        "fs": { "readTextFile": false, "writeTextFile": false },
        "session": {
            "configOptions": {
                "boolean": {}
            }
        }
    })
}

fn first_auth_method(initialized: &Value) -> Option<String> {
    initialized
        .get("authMethods")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|method| method.get("id").and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn speaks_cursor_acp(command: &[String]) -> bool {
    command.first().is_some_and(|name| {
        let base = Path::new(name)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(name);
        base == "cursor-agent" || base == "agent"
    }) && command.iter().any(|arg| arg == "acp")
}

/// Launch flags Cursor documents when ACP will not switch models at runtime.
fn spawn_args(command: &[String], model_id: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = command.get(1..).unwrap_or(&[]).to_vec();
    let Some(model) = model_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return args;
    };
    if !speaks_cursor_acp(command) {
        return args;
    }
    if args.windows(2).any(|pair| pair[0] == "--model") {
        return args;
    }
    let Some(idx) = args.iter().position(|arg| arg == "acp") else {
        return args;
    };
    args.splice(idx..idx, ["--model".to_string(), model.to_string()]);
    args
}

fn models_from_cli_list(text: &str) -> (Vec<ModelInfo>, Option<String>) {
    let mut models = Vec::new();
    let mut default_model = None;
    for line in text.lines() {
        let line = line.trim();
        let Some((id, rest)) = line.split_once(" - ") else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() || id.contains(char::is_whitespace) {
            continue;
        }
        let default = rest.contains("(default)");
        let label = rest.replace("(default)", "").trim().to_string();
        if default {
            default_model = Some(id.to_string());
        }
        models.push(ModelInfo {
            id: id.to_string(),
            label: if label.is_empty() {
                id.to_string()
            } else {
                label
            },
            context_window: None,
            reasoning: false,
            efforts: Vec::new(),
        });
    }
    if default_model.is_none() {
        default_model = models
            .iter()
            .find(|model| model.id == "auto")
            .map(|model| model.id.clone());
    }
    (models, default_model)
}

fn merge_cli_models(hello: &mut Hello, listed: (Vec<ModelInfo>, Option<String>)) {
    if !hello.models.is_empty() {
        return;
    }
    hello.models = listed.0;
    if hello.default_model.is_none() {
        hello.default_model = listed.1;
    }
}

async fn list_models_from_cli(program: &Path) -> Option<(Vec<ModelInfo>, Option<String>)> {
    for args in [["--list-models"].as_slice(), ["models"].as_slice()] {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::owned_child(&mut command);
        let output = match tokio::time::timeout(LIST_MODELS_TIMEOUT, command.output()).await {
            Ok(Ok(output)) => output,
            _ => continue,
        };
        let mut text = String::from_utf8_lossy(&output.stdout).to_string();
        if text.trim().is_empty() {
            text = String::from_utf8_lossy(&output.stderr).to_string();
        }
        let listed = models_from_cli_list(&text);
        if !listed.0.is_empty() {
            return Some(listed);
        }
    }
    None
}

fn resume_method_in(initialized: &Value) -> Option<ResumeMethod> {
    let capabilities = initialized.get("agentCapabilities")?;
    if capabilities
        .get("sessionCapabilities")
        .and_then(|session| session.get("resume"))
        .is_some()
    {
        return Some(ResumeMethod::Resume);
    }
    if capabilities
        .get("loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some(ResumeMethod::Load);
    }
    None
}

fn parse_session_new(result: &Value) -> Result<Setup> {
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("session/new did not return a sessionId"))?
        .to_string();
    let (models, default_model) = models_in(result);
    let (modes, default_mode) = modes_in(result);
    let runtime_axes = runtime_axes_in(result);
    Ok(Setup {
        session_id,
        models,
        modes,
        default_model,
        default_mode,
        model_config_id: config_id_for_category(result, "model"),
        mode_config_id: config_id_for_category(result, "mode"),
        runtime_axes,
    })
}

fn config_options_in(result: &Value) -> Option<&Vec<Value>> {
    result.get("configOptions").and_then(Value::as_array)
}

fn find_select_config_option<'a>(
    config_options: Option<&'a Vec<Value>>,
    category: &str,
) -> Option<&'a Value> {
    config_options?.iter().find(|entry| {
        entry.get("type").and_then(Value::as_str) == Some("select")
            && entry.get("category").and_then(Value::as_str) == Some(category)
    })
}

fn flatten_select_options(options: &[Value]) -> Vec<(String, String, Option<String>)> {
    let mut flat = Vec::new();
    for option in options {
        if option.get("value").and_then(Value::as_str).is_some() {
            flat.push((
                option
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                option
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            ));
            continue;
        }
        let Some(group) = option.get("group").and_then(Value::as_str) else {
            continue;
        };
        if let Some(nested) = option.get("options").and_then(Value::as_array) {
            for choice in nested {
                flat.push((
                    choice
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    choice
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    choice
                        .get("description")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or_else(|| Some(group.to_string())),
                ));
            }
        }
    }
    flat
}

fn models_in(result: &Value) -> (Vec<ModelInfo>, Option<String>) {
    if let Some(models) = result.get("models") {
        let current = models
            .get("currentModelId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if let Some(available) = models.get("availableModels").and_then(Value::as_array) {
            if !available.is_empty() {
                let list = available
                    .iter()
                    .map(|model| ModelInfo {
                        id: model
                            .get("modelId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        label: model
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        context_window: None,
                        reasoning: false,
                        efforts: Vec::new(),
                    })
                    .collect();
                return (list, current);
            }
        }
    }

    let option = find_select_config_option(config_options_in(result), "model");
    if let Some(option) = option {
        let current = option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let choices = flatten_select_options(
            option
                .get("options")
                .and_then(Value::as_array)
                .map(|entries| entries.as_slice())
                .unwrap_or(&[]),
        );
        let list = choices
            .into_iter()
            .map(|(value, name, _)| ModelInfo {
                id: value,
                label: name,
                context_window: None,
                reasoning: false,
                efforts: Vec::new(),
            })
            .collect();
        return (list, current);
    }

    (Vec::new(), None)
}

fn modes_in(result: &Value) -> (Vec<ModeInfo>, Option<String>) {
    if let Some(modes) = result.get("modes") {
        let current = modes
            .get("currentModeId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if let Some(available) = modes.get("availableModes").and_then(Value::as_array) {
            if !available.is_empty() {
                let list = available
                    .iter()
                    .map(|mode| ModeInfo {
                        id: mode
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        label: mode
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: mode
                            .get("description")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                    .collect();
                return (list, current);
            }
        }
    }

    let option = find_select_config_option(config_options_in(result), "mode");
    if let Some(option) = option {
        let current = option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let choices = flatten_select_options(
            option
                .get("options")
                .and_then(Value::as_array)
                .map(|entries| entries.as_slice())
                .unwrap_or(&[]),
        );
        let list = choices
            .into_iter()
            .map(|(value, name, description)| ModeInfo {
                id: value,
                label: name,
                description,
            })
            .collect();
        return (list, current);
    }

    (Vec::new(), None)
}

fn config_id_for_category(result: &Value, category: &str) -> Option<String> {
    find_select_config_option(config_options_in(result), category)
        .and_then(|option| option.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn runtime_axes_in(result: &Value) -> Vec<RuntimeAxisInfo> {
    config_options_in(result)
        .into_iter()
        .flatten()
        .filter(|option| {
            !matches!(
                option.get("category").and_then(Value::as_str),
                Some("model" | "mode")
            )
        })
        .filter_map(|option| {
            let id = option.get("id")?.as_str()?.to_string();
            let label = option
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let description = option
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            let (values, default_value) = match option.get("type").and_then(Value::as_str) {
                Some("select") => {
                    let values = flatten_select_options(
                        option
                            .get("options")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                    )
                    .into_iter()
                    .filter(|(id, _, _)| !id.is_empty())
                    .map(|(id, label, description)| RuntimeAxisValue {
                        id,
                        label,
                        description,
                    })
                    .collect::<Vec<_>>();
                    let current = option
                        .get("currentValue")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    (values, current)
                }
                Some("boolean") => {
                    let current = option
                        .get("currentValue")
                        .and_then(Value::as_bool)
                        .map(|value| value.to_string());
                    (
                        vec![
                            RuntimeAxisValue {
                                id: "false".into(),
                                label: "关闭".into(),
                                description: None,
                            },
                            RuntimeAxisValue {
                                id: "true".into(),
                                label: "开启".into(),
                                description: None,
                            },
                        ],
                        current,
                    )
                }
                _ => return None,
            };
            (!values.is_empty()).then_some(RuntimeAxisInfo {
                id,
                label,
                description,
                values,
                default_value,
            })
        })
        .collect()
}

async fn answered<R>(lines: &mut tokio::io::Lines<BufReader<R>>, id: i64) -> Option<Value>
where
    R: tokio::io::AsyncRead + Unpin,
{
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if frame.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = frame.get("error") {
            tracing::warn!("an ACP agent refused a handshake request: {error}");
            return None;
        }
        return frame.get("result").cloned();
    }
    None
}

async fn read_loop(
    stdout: crate::os_process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
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
        if method == "session/request_permission" {
            let Some(id) = frame.get("id").and_then(Value::as_i64) else {
                tracing::warn!("ACP permission request had no numeric id");
                continue;
            };
            translate_permission(id, &params, &events);
            continue;
        }
        if method == "cursor/ask_question" {
            let Some(id) = frame.get("id") else {
                tracing::warn!("Cursor question request had no id");
                continue;
            };
            if !translate_cursor_question(id, &params, &events) {
                let response =
                    rpc_error(id, -32602, "Cursor question request has no valid questions");
                let mut input = stdin.lock().await;
                if let Err(error) = write_json_line(&mut input, &response).await {
                    tracing::warn!("could not reject malformed Cursor question: {error}");
                }
            }
            continue;
        }
        if method == "cursor/create_plan" {
            let Some(id) = frame.get("id") else {
                tracing::warn!("Cursor plan request had no id");
                continue;
            };
            translate_cursor_plan(id, &params, &events);
            continue;
        }
        let mut state = turn.lock().await;
        if method == "session/update" {
            translate_update(&params, &mut state, &events);
            continue;
        }
        drop(state);

        // A request is not a notification: silently swallowing an extension
        // leaves the Agent waiting forever. Cursor deliberately falls back to
        // standard ACP permission requests when an extension gets -32601.
        if let Some(id) = frame.get("id") {
            let response = unsupported_request(id, method);
            let mut input = stdin.lock().await;
            if let Err(error) = write_json_line(&mut input, &response).await {
                tracing::warn!("could not reject unsupported ACP request {method}: {error}");
            }
        }
    }
    // Stdout ended, so no answer to anything still outstanding is ever coming.
    // Saying so is what turns a dead agent into a failed turn; without it the
    // session sits on `running` forever with nothing behind it, which is the
    // freeze users report. Every other adapter already does this.
    abandon_pending(&pending).await;
}

/// Fails everything still waiting on this agent.
///
/// Dropping the sender is the message: `AcpSession::send` reads a dropped
/// sender as the agent having gone away mid-turn, and reports it with the
/// process's exit code and last words rather than a bare timeout.
async fn abandon_pending(pending: &PendingMap) {
    let waiting: Vec<_> = pending
        .lock()
        .await
        .drain()
        .map(|(_, sender)| sender)
        .collect();
    if !waiting.is_empty() {
        tracing::warn!(
            outstanding = waiting.len(),
            "an ACP agent went away with requests still open"
        );
    }
}

/// How often to ask whether the agent process is still there.
///
/// Only reached when the process is gone but its stdout is not: a shim that
/// exits leaving the real CLI holding the pipe, or a grandchild that inherited
/// it. Waiting for EOF in that shape waits forever.
const EXIT_POLL: Duration = Duration::from_millis(500);

async fn watch_for_exit(child: Arc<Mutex<Option<crate::os_process::Child>>>, pending: PendingMap) {
    loop {
        tokio::time::sleep(EXIT_POLL).await;
        let gone = {
            // Never queue behind `close`: it holds this lock while it kills the
            // tree, and it takes the child away when it is done.
            let Ok(mut held) = child.try_lock() else {
                continue;
            };
            match held.as_mut() {
                None => return,
                Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
            }
        };
        if gone {
            abandon_pending(&pending).await;
            return;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GuidancePlacement {
    /// Default ACP: a leading `text` block. Agents that do not auto-name
    /// from every text block still read this as ordinary prompt context.
    LeadingText,
    /// Cursor concatenates every `text` block into `nameAgent`. An embedded
    /// `resource` still reaches the model as additional ACP context.
    EmbeddedResource,
}

fn is_cursor_agent(agent_id: &str) -> bool {
    agent_id == "cursor" || agent_id.contains("cursor")
}

fn guidance_placement(agent_id: &str) -> GuidancePlacement {
    if is_cursor_agent(agent_id) {
        GuidancePlacement::EmbeddedResource
    } else {
        GuidancePlacement::LeadingText
    }
}

fn wrap_system_guidance(context: &str) -> String {
    format!(
        "<genehub_system_guidance>\n{context}\n</genehub_system_guidance>\n\nThe next block is the user's request."
    )
}

fn session_new_params(cwd: &Path, prompt: Option<&str>) -> Value {
    let mut params = json!({ "cwd": cwd, "mcpServers": [] });
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        params["_meta"] = json!({ "systemPrompt": { "append": prompt } });
    }
    params
}

fn prompt_blocks_with_context(
    input: &PromptInput,
    context: Option<&str>,
    placement: GuidancePlacement,
) -> Vec<Value> {
    let mut blocks = Vec::new();
    if let Some(context) = context.filter(|value| !value.trim().is_empty()) {
        let wrapped = wrap_system_guidance(context);
        blocks.push(match placement {
            GuidancePlacement::LeadingText => json!({
                "type": "text",
                "text": wrapped,
            }),
            GuidancePlacement::EmbeddedResource => json!({
                "type": "resource",
                "resource": {
                    "uri": "genehub://system-guidance",
                    "mimeType": "text/plain",
                    "text": wrapped,
                },
            }),
        });
    }
    blocks.extend(prompt_blocks(input));
    blocks
}

fn permission_options(params: &Value) -> Vec<PermissionOption> {
    params
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
        .unwrap_or_default()
}

fn permission_detail(tool_call: &Value) -> Option<String> {
    if let Some(raw) = tool_call.get("rawInput") {
        if !raw.is_null() {
            if let Ok(pretty) = serde_json::to_string_pretty(raw) {
                if !pretty.is_empty() && pretty != "null" {
                    return Some(pretty);
                }
            }
        }
    }

    if let Some(content) = tool_call.get("content").and_then(Value::as_array) {
        let texts: Vec<_> = content
            .iter()
            .filter_map(|block| {
                block
                    .get("content")
                    .and_then(|inner| inner.get("text"))
                    .and_then(Value::as_str)
                    .or_else(|| block.get("text").and_then(Value::as_str))
            })
            .collect();
        if !texts.is_empty() {
            return Some(texts.join("\n"));
        }
    }

    if let Some(locations) = tool_call.get("locations").and_then(Value::as_array) {
        let paths: Vec<_> = locations
            .iter()
            .filter_map(|location| location.get("path").and_then(Value::as_str))
            .collect();
        if !paths.is_empty() {
            return Some(paths.join("\n"));
        }
    }

    None
}

fn translate_permission(id: i64, params: &Value, events: &broadcast::Sender<SessionEvent>) {
    let options = permission_options(params);

    let tool_call = params.get("toolCall");
    let _ = events.send(SessionEvent::PermissionRequested {
        request: PermissionRequest {
            id: id.to_string(),
            kind: PermissionRequestKind::Permission,
            title: tool_call
                .and_then(|call| call.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("The agent is asking for permission")
                .to_string(),
            detail: tool_call.and_then(permission_detail),
            tool_call_id: tool_call
                .and_then(|call| call.get("toolCallId"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            options,
            questions: None,
        },
    });
}

fn request_id(id: &Value) -> String {
    id.as_str()
        .map(str::to_string)
        .unwrap_or_else(|| id.to_string())
}

fn cursor_questions(params: &Value) -> Option<Vec<InteractionQuestion>> {
    let raw = params.get("questions").and_then(Value::as_array)?;
    let parsed: Vec<InteractionQuestion> = raw
        .iter()
        .filter_map(|question| {
            let id = question.get("id")?.as_str()?.to_string();
            let prompt = question.get("prompt")?.as_str()?.to_string();
            let options: Vec<InteractionOption> = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            Some(InteractionOption {
                                id: option.get("id")?.as_str()?.to_string(),
                                label: option.get("label")?.as_str()?.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(InteractionQuestion {
                id,
                prompt,
                allow_multiple: question
                    .get("allowMultiple")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                // Cursor's own UI always adds an "Other" text choice.
                allow_freeform: true,
                options,
            })
        })
        .collect();
    (!parsed.is_empty() && parsed.len() == raw.len()).then_some(parsed)
}

fn translate_cursor_question(
    id: &Value,
    params: &Value,
    events: &broadcast::Sender<SessionEvent>,
) -> bool {
    let Some(questions) = cursor_questions(params) else {
        return false;
    };
    let _ = events.send(SessionEvent::PermissionRequested {
        request: PermissionRequest {
            id: request_id(id),
            kind: PermissionRequestKind::Question,
            title: params
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Clarifying questions")
                .to_string(),
            detail: None,
            tool_call_id: params
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string),
            options: Vec::new(),
            questions: Some(questions),
        },
    });
    true
}

fn translate_cursor_plan(id: &Value, params: &Value, events: &broadcast::Sender<SessionEvent>) {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Implementation plan");
    let overview = params
        .get("overview")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let plan = params
        .get("plan")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let detail = [overview, plan]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let _ = events.send(SessionEvent::PermissionRequested {
        request: PermissionRequest {
            id: request_id(id),
            kind: PermissionRequestKind::PlanApproval,
            title: name.to_string(),
            detail: (!detail.is_empty()).then_some(detail),
            tool_call_id: params
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string),
            options: vec![
                PermissionOption {
                    id: "accept".into(),
                    label: "Approve and continue".into(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOption {
                    id: "reject".into(),
                    label: "Reject plan".into(),
                    kind: PermissionOptionKind::Reject,
                },
            ],
            questions: None,
        },
    });
}

fn unsupported_request(id: &Value, method: &str) -> Value {
    rpc_error(id, -32601, &format!("method not supported: {method}"))
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn translate_update(
    params: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let update = params.get("update").unwrap_or(&Value::Null);
    let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return;
    };
    // Session metadata is not bound to a turn. An Agent may name the
    // conversation before `session/prompt` starts or after it ends.
    if kind == "session_info_update" {
        emit_session_title(update, events);
        return;
    }
    let Some(turn_id) = state.id.clone() else {
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
            if state.text_item.is_none() && state.reasoning_item.is_none() {
                state.usage.llm_rounds += 1;
                usage::record_round_start(&mut state.usage);
            }
            if !delta.is_empty() {
                usage::record_first_token(&mut state.usage);
                usage::record_visible_output(&mut state.usage, &delta);
            }
            // Progress goes out before the item so the item that opens a round
            // is already attributed to it when the trunk builder sees it.
            usage::emit_progress(events, &turn_id, &state.usage);
            match state.text_item.clone() {
                Some(id) => emit(SessionEvent::ItemDelta {
                    turn_id: turn_id.clone(),
                    item_id: id,
                    delta: ItemDelta::Text { delta },
                }),
                None => {
                    let id = state.next_item_id();
                    state.text_item = Some(id.clone());
                    state.reasoning_item = None;
                    emit(SessionEvent::Item {
                        turn_id: turn_id.clone(),
                        item: TimelineItem::AssistantMessage { id, text: delta, received_at_ms: None },
                    });
                }
            }
        }
        "agent_thought_chunk" => {
            let delta = text_of(update);
            if state.text_item.is_none() && state.reasoning_item.is_none() {
                state.usage.llm_rounds += 1;
                usage::record_round_start(&mut state.usage);
            }
            if !delta.is_empty() {
                usage::record_first_token(&mut state.usage);
                usage::record_visible_output(&mut state.usage, &delta);
            }
            // Same ordering as agent_message_chunk: progress before the item.
            usage::emit_progress(events, &turn_id, &state.usage);
            match state.reasoning_item.clone() {
                Some(id) => emit(SessionEvent::ItemDelta {
                    turn_id: turn_id.clone(),
                    item_id: id,
                    delta: ItemDelta::Text { delta },
                }),
                None => {
                    let id = state.next_item_id();
                    state.reasoning_item = Some(id.clone());
                    state.text_item = None;
                    emit(SessionEvent::Item {
                        turn_id: turn_id.clone(),
                        item: TimelineItem::Reasoning { id, text: delta, received_at_ms: None },
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
            // No "tool" placeholder here: updates often omit the title, and a
            // placeholder would win over the real name when the daemon merges
            // the update into the item it replaces. Empty means "inherit".
            let name = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::ToolCall {
                    id: id.to_string(),
                    images: images_from_update(update, &name),
                    name,
                    status,
                    detail: detail_from_update(update),
                    started_at_ms: None,
                    finished_at_ms: None,
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
        _ => {
            if let Some(reported) = update.get("usage").or_else(|| update.get("tokenUsage")) {
                let parsed = usage::parse_usage(reported);
                if parsed.input_tokens > 0 || parsed.output_tokens > 0 {
                    let rounds = state.usage.llm_rounds;
                    let tool_out = state.usage.tool_output_tokens;
                    let previous = state.usage.clone();
                    state.usage = parsed;
                    state.usage.llm_rounds = rounds;
                    state.usage.tool_output_tokens = tool_out;
                    usage::preserve_timing(&mut state.usage, &previous);
                    usage::emit_progress(events, &turn_id, &state.usage);
                }
            }
        }
    }
}

/// ACP `session_info_update.title`. `null` or whitespace does not clear
/// an existing name — the manager only applies a non-empty title.
/// Titles that just repeat the Skill catalog / prompt heading are dropped
/// so a polluted `nameAgent` pass cannot overwrite the first-prompt label.
fn emit_session_title(update: &Value, events: &broadcast::Sender<SessionEvent>) {
    let Some(title) = update.get("title").and_then(Value::as_str) else {
        return;
    };
    let title = title.trim();
    if title.is_empty() || is_catalog_noise_title(title) {
        return;
    }
    let title: String = title.chars().take(120).collect();
    let _ = events.send(SessionEvent::TitleChanged { title });
}

fn folded_title(title: &str) -> String {
    title
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_catalog_noise_title(title: &str) -> bool {
    matches!(
        folded_title(title).as_str(),
        "skillselectionguidance"
            | "skilldescription"
            | "genehubsessionhistory"
            | "genehubspeechruntime"
            | "genehubhtmlpreview"
            | "htmlpreviewinfo"
            | "myskills"
            | "whatareyourskills"
    )
}

/// ACP tool-call content blocks can be images (`{type:"image", data,
/// mimeType}`, possibly wrapped in a `{type:"content", content:…}` block). A
/// `read`-kind call's first location is the source path; everything else is
/// treated as produced bytes.
fn images_from_update(update: &Value, name: &str) -> Vec<ToolImage> {
    // Alt text is internal accessibility text; a kind word beats an empty
    // string when the update omitted the title.
    let name = if name.is_empty() {
        update.get("kind").and_then(Value::as_str).unwrap_or("tool")
    } else {
        name
    };
    let read_path = (update.get("kind").and_then(Value::as_str) == Some("read"))
        .then(|| {
            update
                .get("locations")
                .and_then(Value::as_array)
                .and_then(|locations| locations.first())
                .and_then(|location| location.get("path"))
                .and_then(Value::as_str)
        })
        .flatten();
    update
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    let image = match block.get("type").and_then(Value::as_str) {
                        Some("image") => Some(block),
                        Some("content") => block
                            .get("content")
                            .filter(|c| c.get("type").and_then(Value::as_str) == Some("image")),
                        _ => None,
                    }?;
                    Some(ToolImage {
                        alt: match read_path {
                            Some(path) => format!("{name}: {path}"),
                            None => name.to_string(),
                        },
                        mime: image
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("image/png")
                            .to_string(),
                        data_base64: Some(image.get("data").and_then(Value::as_str)?.to_string()),
                        thumb: None,
                        path: read_path.map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// ACP describes tools by `kind` plus a list of locations and content blocks.
fn detail_from_update(update: &Value) -> ToolCallDetail {
    let kind = update
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("other");
    let title = update.get("title").and_then(Value::as_str).unwrap_or("");
    let path = acp_path(update);
    let command = acp_raw_str(update, &["command", "cmd"]);
    let query = acp_raw_str(update, &["pattern", "query"]);
    let content = acp_content(update);

    match kind {
        "execute" => ToolCallDetail::Shell {
            command: first_filled(&[&command, title]),
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
            query: first_filled(&[&query, title]),
            matches: Vec::new(),
        },
        "fetch" => ToolCallDetail::Fetch {
            url: first_filled(&[&query, title, &path]),
            summary: content,
        },
        _ => ToolCallDetail::Overview {
            tool_kind: acp_tool_kind(kind),
            overview: title.to_string(),
            input: first_filled(&[&path, &command, &query]),
            output: content,
        },
    }
}

fn acp_path(update: &Value) -> String {
    if let Some(path) = update
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    {
        return path.to_string();
    }
    acp_raw_str(update, &["path", "file_path", "filePath"])
}

fn acp_raw_str(update: &Value, keys: &[&str]) -> String {
    let Some(raw) = update.get("rawInput") else {
        return String::new();
    };
    for key in keys {
        if let Some(value) = raw.get(*key).and_then(Value::as_str) {
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    String::new()
}

fn acp_content(update: &Value) -> String {
    let from_blocks = update
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
    if !from_blocks.is_empty() {
        return from_blocks;
    }
    update
        .get("rawOutput")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn acp_tool_kind(kind: &str) -> ToolKind {
    match kind {
        "execute" => ToolKind::Shell,
        "read" => ToolKind::Read,
        "edit" => ToolKind::Edit,
        "search" => ToolKind::Search,
        "fetch" => ToolKind::Fetch,
        "switch_mode" | "plan" => ToolKind::Plan,
        _ => ToolKind::Other,
    }
}

fn first_filled(values: &[&str]) -> String {
    values
        .iter()
        .copied()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use genehub_proto::{Attachment, ToolKind};

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
            if matches!(event, SessionEvent::TurnProgress { .. }) {
                continue;
            }
            out.push(event);
        }
        out
    }

    #[test]
    fn standard_resume_is_preferred_when_the_agent_advertises_it() {
        let initialized = json!({
            "agentCapabilities": {
                "sessionCapabilities": { "resume": {} },
                "loadSession": true
            }
        });
        assert_eq!(resume_method_in(&initialized), Some(ResumeMethod::Resume));
    }

    #[test]
    fn legacy_load_is_used_only_when_explicitly_advertised() {
        assert_eq!(
            resume_method_in(&json!({
                "agentCapabilities": { "loadSession": true }
            })),
            Some(ResumeMethod::Load)
        );
        assert_eq!(
            resume_method_in(&json!({
                "agentCapabilities": { "loadSession": false }
            })),
            None
        );
        assert_eq!(resume_method_in(&json!({})), None);
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

    #[test]
    fn artifact_guidance_is_isolated_ahead_of_the_acp_user_prompt() {
        let input = PromptInput {
            text: "生成报告".into(),
            attachments: vec![],
        };
        let blocks = prompt_blocks_with_context(
            &input,
            Some("Use https://app.example/assets/preview/v2/device/workspace/r_root/"),
            GuidancePlacement::LeadingText,
        );
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0]["text"]
            .as_str()
            .unwrap()
            .contains("<genehub_system_guidance>"));
        assert!(blocks[0]["text"]
            .as_str()
            .unwrap()
            .contains("https://app.example/assets/preview/v2/device/workspace/r_root/"));
        assert_eq!(blocks[1], json!({ "type": "text", "text": "生成报告" }));
    }

    #[test]
    fn cursor_guidance_is_an_embedded_resource_not_a_text_block() {
        let input = PromptInput {
            text: "生成报告".into(),
            attachments: vec![],
        };
        let blocks = prompt_blocks_with_context(
            &input,
            Some("read genehub-session-history when inspecting a past chat"),
            GuidancePlacement::EmbeddedResource,
        );
        assert_eq!(blocks[0]["type"], "resource");
        assert_eq!(blocks[0]["resource"]["uri"], "genehub://system-guidance");
        assert!(blocks[0]["resource"]["text"]
            .as_str()
            .unwrap()
            .contains("<genehub_system_guidance>"));
        assert_eq!(blocks[1], json!({ "type": "text", "text": "生成报告" }));
        assert_eq!(
            guidance_placement("cursor"),
            GuidancePlacement::EmbeddedResource
        );
        assert_eq!(
            guidance_placement("acp:goose"),
            GuidancePlacement::LeadingText
        );
    }

    #[test]
    fn session_new_appends_system_prompt_through_meta() {
        let params = session_new_params(Path::new("/tmp/project"), Some("always link index.html"));
        assert_eq!(params["cwd"], "/tmp/project");
        assert_eq!(
            params["_meta"]["systemPrompt"]["append"],
            "always link index.html"
        );
        let bare = session_new_params(Path::new("/tmp/project"), Some("   "));
        assert!(bare.get("_meta").is_none());
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
    fn an_unrecognised_tool_kind_keeps_a_compact_overview() {
        let detail = detail_from_update(&json!({"kind": "quantum", "title": "?"}));
        assert_eq!(
            detail,
            ToolCallDetail::Overview {
                tool_kind: ToolKind::Other,
                overview: "?".into(),
                input: String::new(),
                output: String::new(),
            }
        );
    }

    #[test]
    fn cursor_raw_output_stays_in_output_not_the_overview() {
        let detail = detail_from_update(&json!({
            "sessionUpdate": "tool_call_update",
            "status": "completed",
            "toolCallId": "c1",
            "rawOutput": {"content": "skill text"}
        }));
        assert_eq!(
            detail,
            ToolCallDetail::Overview {
                tool_kind: ToolKind::Other,
                overview: String::new(),
                input: String::new(),
                output: "skill text".into(),
            }
        );
    }

    #[test]
    fn cursor_read_uses_location_or_raw_input_path() {
        let detail = detail_from_update(&json!({
            "kind": "read",
            "title": "Read File",
            "rawInput": {"path": "packages/proto/src/domain.rs"},
            "rawOutput": {"content": "---\nname: ignored-body"}
        }));
        assert_eq!(
            detail,
            ToolCallDetail::Read {
                path: "packages/proto/src/domain.rs".into(),
                content: "---\nname: ignored-body".into(),
                truncated: false
            }
        );
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
                assert_eq!(request.kind, PermissionRequestKind::Permission);
                assert_eq!(request.tool_call_id.as_deref(), Some("c1"));
                assert_eq!(request.options.len(), 2);
                assert_eq!(request.options[1].kind, PermissionOptionKind::Reject);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn cursor_questions_keep_every_prompt_and_answer_shape() {
        let (tx, mut rx) = broadcast::channel(8);
        assert!(translate_cursor_question(
            &json!("ask-1"),
            &json!({
                "toolCallId": "tool-1",
                "title": "Choose the rollout",
                "questions": [
                    {
                        "id": "environment",
                        "prompt": "Where should this ship?",
                        "options": [
                            {"id": "beta", "label": "Beta"},
                            {"id": "official", "label": "Official"}
                        ],
                        "allowMultiple": false
                    },
                    {
                        "id": "checks",
                        "prompt": "Which checks are required?",
                        "options": [{"id": "smoke", "label": "Smoke test"}],
                        "allowMultiple": true
                    }
                ]
            }),
            &tx,
        ));
        match &drain(&mut rx)[0] {
            SessionEvent::PermissionRequested { request } => {
                assert_eq!(request.id, "ask-1");
                assert_eq!(request.kind, PermissionRequestKind::Question);
                assert_eq!(request.tool_call_id.as_deref(), Some("tool-1"));
                let questions = request.questions.as_ref().expect("structured questions");
                assert_eq!(questions.len(), 2);
                assert_eq!(questions[0].options[1].label, "Official");
                assert!(questions[1].allow_multiple);
                assert!(questions.iter().all(|question| question.allow_freeform));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn cursor_plans_become_explicit_stopped_approvals() {
        let (tx, mut rx) = broadcast::channel(8);
        translate_cursor_plan(
            &json!(17),
            &json!({
                "toolCallId": "plan-tool",
                "name": "Durable interactions",
                "overview": "Stop before asking.",
                "plan": "Persist, render, then resume."
            }),
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::PermissionRequested { request } => {
                assert_eq!(request.id, "17");
                assert_eq!(request.kind, PermissionRequestKind::PlanApproval);
                assert_eq!(request.tool_call_id.as_deref(), Some("plan-tool"));
                assert!(request.detail.as_deref().unwrap().contains("Persist"));
                assert_eq!(request.options[0].id, "accept");
                assert_eq!(request.options[1].kind, PermissionOptionKind::Reject);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn unknown_acp_requests_fail_visibly_instead_of_hanging() {
        let response = unsupported_request(&json!("extension-1"), "vendor/unknown");
        assert_eq!(response["id"], json!("extension-1"));
        assert_eq!(response["error"]["code"], json!(-32601));
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("vendor/unknown"));
    }

    #[test]
    fn malformed_cursor_questions_do_not_create_unanswerable_waits() {
        let (tx, mut rx) = broadcast::channel(8);
        assert!(!translate_cursor_question(
            &json!("bad-question"),
            &json!({"questions": [{"id": "missing-prompt"}]}),
            &tx,
        ));
        assert!(rx.try_recv().is_err());
        let response = rpc_error(
            &json!("bad-question"),
            -32602,
            "Cursor question request has no valid questions",
        );
        assert_eq!(response["error"]["code"], json!(-32602));
    }

    #[test]
    fn permission_detail_prefers_pretty_raw_input() {
        let detail = permission_detail(&json!({
            "rawInput": {"path": "/tmp/a.rs", "content": "hello"},
            "locations": [{"path": "/ignored/when/raw"}]
        }));
        assert!(detail.unwrap().contains("/tmp/a.rs"));
    }

    #[test]
    fn permission_detail_falls_back_to_content_text() {
        let detail = permission_detail(&json!({
            "content": [{"content": {"text": "run this"}}]
        }));
        assert_eq!(detail.as_deref(), Some("run this"));
    }

    #[test]
    fn permission_detail_falls_back_to_location_paths() {
        let detail = permission_detail(&json!({
            "locations": [{"path": "/tmp/a.rs"}, {"path": "/tmp/b.rs"}]
        }));
        assert_eq!(detail.as_deref(), Some("/tmp/a.rs\n/tmp/b.rs"));
    }

    #[test]
    fn catalog_from_session_new_parses_modes_models_and_config_options() {
        let setup = parse_session_new(&json!({
            "sessionId": "s1",
            "modes": {
                "currentModeId": "agent",
                "availableModes": [
                    {"id": "agent", "name": "Agent"},
                    {"id": "plan", "name": "Plan"},
                    {"id": "ask", "name": "Ask"}
                ]
            },
            "models": {
                "currentModelId": "composer-2.5",
                "availableModels": [
                    {"modelId": "composer-2.5", "name": "Composer 2.5"},
                    {"modelId": "composer-2.5[fast=true]", "name": "Composer 2.5 Fast"}
                ]
            },
            "configOptions": [
                {
                    "type": "select",
                    "id": "model",
                    "category": "model",
                    "currentValue": "composer-2.5",
                    "options": [{"value": "composer-2.5", "name": "Composer 2.5"}]
                },
                {
                    "type": "select",
                    "id": "mode",
                    "category": "mode",
                    "currentValue": "agent",
                    "options": [{"value": "agent", "name": "Agent"}]
                },
                {
                    "type": "select",
                    "id": "fast",
                    "name": "Fast",
                    "currentValue": "standard",
                    "options": [
                        {"value": "standard", "name": "标准"},
                        {"value": "fast", "name": "快速"},
                        {"value": "max", "name": "极速"}
                    ]
                },
                {
                    "type": "boolean",
                    "id": "autoApply",
                    "name": "自动应用",
                    "currentValue": true
                }
            ]
        }))
        .expect("fixture parses");

        assert_eq!(setup.session_id, "s1");
        assert_eq!(setup.default_mode.as_deref(), Some("agent"));
        assert_eq!(setup.default_model.as_deref(), Some("composer-2.5"));
        assert_eq!(setup.model_config_id.as_deref(), Some("model"));
        assert_eq!(setup.mode_config_id.as_deref(), Some("mode"));
        assert_eq!(setup.modes.len(), 3);
        assert_eq!(setup.modes[1].id, "plan");
        assert_eq!(setup.models.len(), 2);
        assert_eq!(setup.models[1].id, "composer-2.5[fast=true]");
        assert_eq!(setup.runtime_axes.len(), 2);
        assert_eq!(setup.runtime_axes[0].id, "fast");
        assert_eq!(setup.runtime_axes[0].values.len(), 3);
        assert_eq!(
            setup.runtime_axes[0].default_value.as_deref(),
            Some("standard")
        );
    }

    #[test]
    fn catalog_falls_back_to_config_options_when_models_block_is_empty() {
        let setup = parse_session_new(&json!({
            "sessionId": "s1",
            "configOptions": [
                {
                    "type": "select",
                    "id": "model",
                    "category": "model",
                    "currentValue": "sonnet",
                    "options": [{"value": "sonnet", "name": "Sonnet"}]
                },
                {
                    "type": "select",
                    "id": "mode",
                    "category": "mode",
                    "currentValue": "plan",
                    "options": [{"value": "plan", "name": "Plan"}]
                }
            ]
        }))
        .expect("fixture parses");
        assert_eq!(setup.models[0].id, "sonnet");
        assert_eq!(setup.modes[0].id, "plan");
    }

    #[test]
    fn parameters_inside_opaque_model_ids_do_not_invent_runtime_axes() {
        let setup = parse_session_new(&json!({
            "sessionId": "s1",
            "configOptions": [{
                "type": "select",
                "id": "model",
                "category": "model",
                "currentValue": "grok-4.6[effort=high,fast=true]",
                "options": [{
                    "value": "grok-4.6[effort=high,fast=true]",
                    "name": "grok-4.6"
                }]
            }]
        }))
        .expect("fixture parses");

        assert!(setup.runtime_axes.is_empty());
        assert_eq!(setup.models[0].id, "grok-4.6[effort=high,fast=true]");
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
    fn a_session_info_update_becomes_a_title_change() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = state();
        translate_update(
            &json!({"update": {
                "sessionUpdate": "session_info_update",
                "title": "  修复登录跳转  "
            }}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[..] {
            [SessionEvent::TitleChanged { title }] => assert_eq!(title, "修复登录跳转"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_session_info_update_reaches_us_before_a_turn() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = TurnState::default();
        translate_update(
            &json!({"update": {
                "sessionUpdate": "session_info_update",
                "title": "夜间构建"
            }}),
            &mut turn,
            &tx,
        );
        match &drain(&mut rx)[..] {
            [SessionEvent::TitleChanged { title }] => assert_eq!(title, "夜间构建"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_empty_session_info_title_is_ignored() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = state();
        translate_update(
            &json!({"update": {"sessionUpdate": "session_info_update", "title": "   "}}),
            &mut turn,
            &tx,
        );
        translate_update(
            &json!({"update": {"sessionUpdate": "session_info_update", "title": null}}),
            &mut turn,
            &tx,
        );
        assert!(drain(&mut rx).is_empty());
    }

    #[test]
    fn a_skill_catalog_title_is_not_a_session_name() {
        let (tx, mut rx) = broadcast::channel(8);
        let mut turn = state();
        translate_update(
            &json!({"update": {
                "sessionUpdate": "session_info_update",
                "title": "Skill Selection Guidance"
            }}),
            &mut turn,
            &tx,
        );
        translate_update(
            &json!({"update": {
                "sessionUpdate": "session_info_update",
                "title": "GeneHub Session History"
            }}),
            &mut turn,
            &tx,
        );
        assert!(drain(&mut rx).is_empty());
        assert!(is_catalog_noise_title("  genehub-html-preview  "));
        assert!(!is_catalog_noise_title("修复登录跳转"));
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

    #[test]
    fn spawn_args_pins_the_model_before_the_acp_subcommand() {
        let command = vec!["cursor-agent".into(), "--force".into(), "acp".into()];
        assert_eq!(
            spawn_args(&command, Some("composer-2.5")),
            vec!["--force", "--model", "composer-2.5", "acp"]
        );
        assert_eq!(
            spawn_args(&command, None),
            vec!["--force", "acp"],
            "no model, no extra flag"
        );
        assert_eq!(
            spawn_args(&["acp-agent".into(), "acp".into()], Some("sonnet")),
            vec!["acp"],
            "only Cursor's binary gets --model"
        );
        assert_eq!(
            spawn_args(
                &[
                    "cursor-agent".into(),
                    "--model".into(),
                    "auto".into(),
                    "acp".into()
                ],
                Some("composer-2.5")
            ),
            vec!["--model", "auto", "acp"],
            "an existing pin is left alone"
        );
    }

    #[test]
    fn cursor_cli_model_list_parses_ids_and_the_default_marker() {
        let (models, default) = models_from_cli_list(
            "Available models\n\n\
             auto - Auto (default)\n\
             composer-2.5 - Composer 2.5\n\
             composer-2.5-fast - Composer 2.5 Fast\n",
        );
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["auto", "composer-2.5", "composer-2.5-fast"]
        );
        assert_eq!(models[1].label, "Composer 2.5");
        assert_eq!(default.as_deref(), Some("auto"));
    }

    #[test]
    fn cli_models_fill_an_empty_acp_catalog_only() {
        let listed = models_from_cli_list("auto - Auto (default)\ncomposer-2.5 - Composer 2.5\n");
        let mut empty = Hello::default();
        merge_cli_models(&mut empty, listed.clone());
        assert_eq!(empty.models.len(), 2);
        assert_eq!(empty.default_model.as_deref(), Some("auto"));

        let mut present = Hello {
            models: vec![ModelInfo {
                id: "composer-2.5[fast=true]".into(),
                label: "Composer 2.5 Fast".into(),
                context_window: None,
                reasoning: false,
                efforts: Vec::new(),
            }],
            default_model: Some("composer-2.5[fast=true]".into()),
            ..Hello::default()
        };
        merge_cli_models(&mut present, listed);
        assert_eq!(present.models[0].id, "composer-2.5[fast=true]");
    }

    #[test]
    fn first_auth_method_reads_cursor_login() {
        assert_eq!(
            first_auth_method(&json!({
                "authMethods": [
                    {
                        "id": "cursor_login",
                        "name": "Cursor Login"
                    }
                ]
            }))
            .as_deref(),
            Some("cursor_login")
        );
        assert_eq!(first_auth_method(&json!({})), None);
    }

    /// When cursor-agent is on PATH and signed in, discovery should return real
    /// modes.
    ///
    /// A CLI that is installed but signed out answers `initialize` and then
    /// refuses to open a session, which is the adapter working correctly — the
    /// picker reports it as unavailable and says why. So this skips on the same
    /// answer the adapter itself acts on, rather than reporting the machine's
    /// login state as a defect in this code.
    #[tokio::test]
    async fn discover_cursor_when_installed() {
        let Some(program) = crate::adapter::find_executable("cursor-agent") else {
            eprintln!("skipping discover_cursor_when_installed: cursor-agent not on PATH");
            return;
        };
        if logged_in(&program).await == Some(false) {
            eprintln!("skipping discover_cursor_when_installed: cursor-agent is not signed in");
            return;
        }
        let hello = discover(
            &program,
            &[
                "cursor-agent".into(),
                "--force".into(),
                "--sandbox".into(),
                "disabled".into(),
                "--trust".into(),
                "--approve-mcps".into(),
                "acp".into(),
            ],
        )
        .await
        .expect("cursor-agent should answer a handshake");
        assert!(
            !hello.modes.is_empty(),
            "Cursor should list agent/plan/ask modes"
        );
        assert!(
            hello.model_config_id.is_some() || !hello.models.is_empty(),
            "Cursor should expose model selection"
        );
    }

    #[tokio::test]
    async fn extra_install_dir_is_enough_for_probe_when_path_misses() {
        let dir = tempfile::tempdir().unwrap();
        let name = "genehub-test-acp-extra-agent";
        let suffix = if cfg!(windows) { ".bat" } else { "" };
        std::fs::write(dir.path().join(format!("{name}{suffix}")), b"").unwrap();
        let adapter = AcpAdapter::new("t", "T", vec![name.into()])
            .with_extra_dirs(vec![dir.path().to_path_buf()]);
        assert_eq!(adapter.probe().await, ProbeState::Ready);
    }

    #[test]
    fn status_json_and_text_agree_on_login() {
        assert_eq!(
            login_from_status_output(br#"{"loggedIn":false}"#, b""),
            Some(false)
        );
        assert_eq!(
            login_from_status_output(br#"{"authenticated":true}"#, b""),
            Some(true)
        );
        assert_eq!(
            login_from_status_output(b"Not authenticated", b""),
            Some(false)
        );
        assert_eq!(login_from_status_output(b"Not logged in", b""), Some(false));
        assert_eq!(
            login_from_status_output(b"Logged in as user@example.com", b""),
            Some(true)
        );
        assert_eq!(login_from_status_output(b"usage: cursor-agent", b""), None);
    }

    #[test]
    fn acp_image_blocks_become_tool_images() {
        let update = json!({
            "kind": "read",
            "locations": [{"path": "src/cat.png"}],
            "content": [
                {"type": "content", "content": {"type": "image", "data": "aGk=", "mimeType": "image/png"}},
            ],
        });
        let images = images_from_update(&update, "Read");
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].path.as_deref(), Some("src/cat.png"));
        assert_eq!(images[0].data_base64.as_deref(), Some("aGk="));

        let produced = json!({
            "kind": "other",
            "content": [{"type": "image", "data": "eWVz", "mimeType": "image/webp"}],
        });
        let images = images_from_update(&produced, "screenshot");
        assert_eq!(images.len(), 1);
        assert!(images[0].path.is_none());
        assert_eq!(images[0].mime, "image/webp");
    }
}
