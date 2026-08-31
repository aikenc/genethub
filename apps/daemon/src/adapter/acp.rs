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

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    AgentSetup, AuthState, Capabilities, Catalog, ItemDelta, ModeInfo, ModelInfo, PermissionOption,
    PermissionOptionKind, PermissionOutcome, PermissionRequest, PermissionRequestKind, ProbeState,
    SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex};

use super::stdio::write_json_line;
use super::{
    find_executable, AgentAdapter, AgentSession, Chatter, PersistHandle, PromptInput, ProviderMap,
    SessionConfig,
};

const EVENT_CAPACITY: usize = 1024;
const PROTOCOL_VERSION: i64 = 1;
/// How long a throwaway handshake may take. Cursor's first answer can be slow.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);

pub struct AcpAdapter {
    id: String,
    label: String,
    command: Vec<String>,
    /// What `session/new` told us about models and modes, read once per daemon
    /// run so the picker can be drawn before anyone opens a session.
    hello: tokio::sync::OnceCell<Option<Hello>>,
    /// What the setup wizard shows. None for a bare `acp:*` declaration, which
    /// gets the honest fallback: its own documentation and nothing invented.
    setup: Option<AgentSetup>,
    /// How to ask this CLI whether it is signed in, when it publishes a way.
    auth_status: Option<AuthStatusProbe>,
}

/// A CLI's non-interactive sign-in check, described declaratively: run the
/// program with these arguments, read this boolean field from the JSON it
/// prints. `cursor-agent status --format json` answering `isAuthenticated` is
/// the shape this exists for.
pub struct AuthStatusProbe {
    pub args: Vec<String>,
    pub json_field: String,
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
}

impl AcpAdapter {
    pub fn new(id: impl Into<String>, label: impl Into<String>, command: Vec<String>) -> Self {
        AcpAdapter {
            id: id.into(),
            label: label.into(),
            command,
            hello: tokio::sync::OnceCell::new(),
            setup: None,
            auth_status: None,
        }
    }

    pub fn with_setup(mut self, setup: AgentSetup) -> Self {
        self.setup = Some(setup);
        self
    }

    pub fn with_auth_status(mut self, probe: AuthStatusProbe) -> Self {
        self.auth_status = Some(probe);
        self
    }

    fn program(&self) -> Option<PathBuf> {
        find_executable(self.command.first()?)
    }

    async fn hello(&self, program: &Path) -> Option<Hello> {
        self.hello
            .get_or_init(|| async { discover(program, &self.command).await })
            .await
            .clone()
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
            // Cursor exposes models through `session/new` and
            // `session/set_config_option`; other ACP agents may not, but an
            // empty catalog still hides the picker when discovery fails.
            set_model: true,
            set_mode: true,
            permissions: true,
            resume: true,
            fork: false,
            attachments: true,
        }
    }

    async fn probe(&self) -> ProbeState {
        match self.program() {
            Some(_) => ProbeState::Ready,
            // Every entry on this adapter now names the program it runs, so a
            // missing one is simply not installed. The one case that needed
            // more explaining than that — `codex` present but a bridge package
            // missing — went away when Codex got its own adapter.
            None => ProbeState::NotInstalled,
        }
    }

    async fn auth(&self) -> AuthState {
        let (Some(program), Some(probe)) = (self.program(), &self.auth_status) else {
            return AuthState::Unknown;
        };
        let args: Vec<&str> = probe.args.iter().map(String::as_str).collect();
        super::json_auth_status(&program, &args, &probe.json_field).await
    }

    async fn version(&self) -> Option<String> {
        super::binary_version(&self.program()?).await
    }

    fn setup(&self) -> AgentSetup {
        self.setup.clone().unwrap_or_default()
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        let Some(program) = self.program() else {
            return Catalog::default();
        };
        let hello = self.hello(&program).await.unwrap_or_default();
        Catalog {
            default_effort: None,
            // ACP does have a command list (`available_commands_update` on the
            // session), which we do not read yet.
            commands: Vec::new(),
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
            .args(&self.command[1..])
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::without_a_window(&mut command);

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
        let initialized = self
            .call(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": client_capabilities(),
                }),
            )
            .await?;
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
                    json!({ "cwd": config.cwd, "mcpServers": [] }),
                )
                .await?;
            let setup = parse_session_new(&result)?;
            *self.model_config_id.lock().await = setup.model_config_id.clone();
            *self.mode_config_id.lock().await = setup.mode_config_id.clone();
            setup.session_id
        };
        *self.acp_session.lock().await = Some(session_id.clone());
        *self.persisted_session.lock().unwrap() = Some(session_id);

        if let Some(model_id) = config.model_id.as_ref() {
            self.set_model(model_id).await?;
        }
        if let Some(mode_id) = config.mode_id.as_ref() {
            self.set_mode(mode_id).await?;
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

    async fn set_config_option(&self, config_id: &str, value: &str) -> Result<()> {
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
        }
        let _ = self.events.send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 0,
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
                    _ => SessionEvent::TurnCompleted {
                        turn_id: completed_turn,
                        usage: Usage::default(),
                        fork_checkpoint: None,
                    },
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
        self.set_config_option(&config_id, model_id).await
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
                self.set_config_option(&config_id, mode_id).await
            }
        }
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

/// Runs one handshake against a throwaway process and takes its answers away.
///
/// A process of its own because the model and mode tables are wanted for the
/// agent picker, which is drawn long before any session exists.
async fn discover(program: &Path, command: &[String]) -> Option<Hello> {
    let mut spawn = Command::new(program);
    spawn
        .args(&command[1..])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    super::without_a_window(&mut spawn);

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
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": client_capabilities(),
                },
            }),
        )
        .await
        .ok()?;
        answered(&mut lines, 1).await?;

        write_json_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": { "cwd": std::env::temp_dir(), "mcpServers": [] },
            }),
        )
        .await
        .ok()?;
        let created = answered(&mut lines, 2).await?;
        Some(hello_from_setup(parse_session_new(&created).ok()?))
    })
    .await;

    super::kill_tree(&mut child).await;

    match answer {
        Ok(Some(hello)) => Some(hello),
        Ok(None) => None,
        Err(_) => {
            tracing::warn!("an ACP agent did not answer a handshake in time");
            None
        }
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
    }
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
    Ok(Setup {
        session_id,
        models,
        modes,
        default_model,
        default_mode,
        model_config_id: config_id_for_category(result, "model"),
        mode_config_id: config_id_for_category(result, "mode"),
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
        if method == "session/request_permission" {
            let Some(id) = frame.get("id").and_then(Value::as_i64) else {
                tracing::warn!("ACP permission request had no numeric id");
                continue;
            };
            translate_permission(id, &params, &events);
            continue;
        }
        let mut state = turn.lock().await;
        if method == "session/update" {
            translate_update(&params, &mut state, &events);
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
                assert_eq!(request.kind, PermissionRequestKind::Permission);
                assert_eq!(request.tool_call_id.as_deref(), Some("c1"));
                assert_eq!(request.options.len(), 2);
                assert_eq!(request.options[1].kind, PermissionOptionKind::Reject);
            }
            other => panic!("unexpected {other:?}"),
        }
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

    /// When cursor-agent is on PATH, discovery should return real modes.
    #[tokio::test]
    async fn discover_cursor_when_installed() {
        let Some(program) = find_executable("cursor-agent") else {
            eprintln!("skipping discover_cursor_when_installed: cursor-agent not on PATH");
            return;
        };
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
}
