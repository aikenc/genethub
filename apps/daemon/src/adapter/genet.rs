//! Adapter for the built-in agent: child process, JSONL frames over stdio.
//!
//! All knowledge of that agent's wire format is confined to this file. The
//! translation to `SessionEvent` happens here so nothing above the adapter
//! layer ever sees an agent-shaped frame.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Capabilities, Catalog, ItemDelta, ModeInfo, ModelInfo, PermissionOutcome, ProbeState,
    SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, Mutex};

use super::stdio::write_json_line;
use super::{
    find_executable, AgentAdapter, AgentSession, Chatter, PromptInput, ProviderMap, SessionConfig,
};
use crate::config::ProviderConfig;

const BINARY: &str = "genet-agent";

/// The file name to look for beside the daemon.
///
/// On Windows that name ends in `.exe`, and the suffix is not decoration: the
/// installer ships `genet-agent.exe`, so a sibling lookup for `genet-agent`
/// matches nothing, `PATH` does not contain the install directory either, and
/// the agent this product is named after reports itself as not installed on
/// every Windows machine. Which is exactly what shipped.
///
/// The platform is a parameter so the Windows answer can be checked from a test
/// running anywhere — the bug only existed on the platform the tests did not run
/// on.
fn agent_file_name(windows: bool) -> String {
    if windows {
        format!("{BINARY}.exe")
    } else {
        BINARY.to_string()
    }
}
const EVENT_CAPACITY: usize = 1024;

/// Environment the agent would otherwise read credentials from.
const PROVIDER_ENV: [&str; 7] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "GENET_AGENT_FAKE_PROVIDER",
];

/// Thinking levels the agent accepts, exposed as this adapter's "modes".
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub struct GenetAdapter {
    binary: Option<PathBuf>,
}

impl GenetAdapter {
    pub fn discover() -> Self {
        Self::discover_beside(
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)),
        )
    }

    /// `beside` is where the daemon itself lives, taken as an argument so a test
    /// can point it at a directory it controls.
    fn discover_beside(beside: Option<PathBuf>) -> Self {
        // Next to the daemon first: that is where the installer puts it, and it
        // must win over any unrelated binary of the same name on PATH.
        let sibling = beside
            .map(|dir| dir.join(agent_file_name(cfg!(windows))))
            .filter(|path| path.is_file());
        let binary = std::env::var("GENET_AGENT_COMMAND")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or(sibling)
            .or_else(|| find_executable(BINARY));
        GenetAdapter { binary }
    }
}

#[async_trait]
impl AgentAdapter for GenetAdapter {
    fn id(&self) -> &str {
        "genet"
    }

    fn label(&self) -> &str {
        "GeneHub Agent"
    }

    fn builtin(&self) -> bool {
        true
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            interrupt: true,
            set_model: true,
            // Thinking level is this agent's only mode axis.
            set_mode: true,
            // No approval flow of its own yet, so the frontend must not render
            // approval controls for it.
            permissions: false,
            resume: true,
            attachments: false,
        }
    }

    async fn probe(&self) -> ProbeState {
        match &self.binary {
            Some(_) => ProbeState::Ready,
            None => ProbeState::NotInstalled,
        }
    }

    async fn catalog(&self, providers: &ProviderMap) -> Catalog {
        let models: Vec<ModelInfo> = configured_models(providers)
            .into_iter()
            .map(|model| ModelInfo {
                id: format!("{}/{}", model.provider, model.id),
                label: model.label,
                context_window: model.context_window,
                reasoning: model.reasoning,
            })
            .collect();
        let modes = THINKING_LEVELS
            .iter()
            .map(|level| ModeInfo {
                id: (*level).to_string(),
                label: format!("Thinking: {level}"),
                description: None,
            })
            .collect();
        Catalog {
            default_model: models.first().map(|m| m.id.clone()),
            models,
            modes,
            default_mode: Some("medium".to_string()),
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let binary = self
            .binary
            .clone()
            .ok_or_else(|| anyhow!("the built-in agent binary is not available"))?;

        let home = config.scratch_dir.join("genet");
        std::fs::create_dir_all(&home).context("creating the agent scratch directory")?;
        write_models_file(&home, &config.providers)?;

        let session_file = home.join("session.jsonl");
        let mut command = Command::new(&binary);
        command
            .arg("--mode")
            .arg("rpc")
            .arg("--session")
            .arg(&session_file)
            .current_dir(&config.cwd)
            .env("GENET_AGENT_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Under the daemon, `models.json` is the only source of models. The
        // agent also picks up provider keys straight from its environment when
        // it runs standalone, and inheriting those here would mean a key left
        // in someone's shell quietly overrides what the user configured.
        for key in PROVIDER_ENV {
            command.env_remove(key);
        }

        if let Some(model) = config.model_id.as_ref() {
            command.arg("--model").arg(model);
        }
        if let Some(mode) = config.mode_id.as_ref() {
            command.arg("--thinking").arg(mode);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {}", binary.display()))?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stdin = child.stdin.take().expect("stdin was piped");

        let child = Arc::new(Mutex::new(Some(child)));
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let turn = Arc::new(Mutex::new(TurnState::default()));

        // stderr is kept as well as drained: a full pipe would block the process,
        // and what it wrote on the way out is the only account of why it left.
        let said = Arc::new(Chatter::default());
        said.watch("genet-agent", Some(stderr)).await;

        let session = GenetSession {
            stdin: Mutex::new(stdin),
            events: events.clone(),
            turn: turn.clone(),
            child: child.clone(),
            said: said.clone(),
            session_file,
        };

        tokio::spawn(translate_stream(stdout, events, turn, child, said));

        Ok(Box::new(session))
    }
}

/// What the translator needs to know about the turn currently in flight.
#[derive(Default)]
struct TurnState {
    id: Option<String>,
    counter: u64,
    text_item: Option<String>,
    reasoning_item: Option<String>,
    usage: Usage,
    /// Tool call id -> (normalized name, raw arguments), captured when the call
    /// is announced so the result can be rendered with its inputs.
    calls: HashMap<String, (String, Value)>,
    failure: Option<TurnError>,
    canceled: bool,
}

impl TurnState {
    fn next_item_id(&mut self) -> String {
        self.counter += 1;
        let turn = self.id.as_deref().unwrap_or("t0");
        format!("{turn}-{}", self.counter)
    }
}

struct GenetSession {
    stdin: Mutex<ChildStdin>,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    /// Shared with the stream reader, which needs the exit code to explain a crash.
    child: Arc<Mutex<Option<Child>>>,
    /// What the agent said, for a prompt that cannot be written because it is gone.
    said: Arc<Chatter>,
    session_file: PathBuf,
}

impl GenetSession {
    async fn command(&self, value: Value) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        write_json_line(&mut stdin, &value).await
    }
}

#[async_trait]
impl AgentSession for GenetSession {
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
        // A pipe that is already closed fails with "Broken pipe", which says
        // nothing about why the agent is gone. What it said on the way out does.
        if let Err(broken) = self
            .command(json!({
                "id": turn_id,
                "type": "prompt",
                "message": input.text,
            }))
            .await
        {
            let why = super::stopped("GeneHub Agent", &self.child, &self.said).await;
            tracing::warn!("{why} (writing the prompt failed: {broken})");
            self.turn.lock().await.id = None;
            anyhow::bail!(why);
        }
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        {
            let mut turn = self.turn.lock().await;
            turn.canceled = true;
        }
        self.command(json!({ "type": "abort" })).await
    }

    async fn close(&self) -> Result<()> {
        // Dropping stdin is the agent's shutdown signal; it drains in-flight
        // work before exiting, so wait rather than killing outright.
        let mut child = self.child.lock().await;
        if let Some(mut child) = child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        let (provider, id) = model_id
            .split_once('/')
            .ok_or_else(|| anyhow!("model id must be 'provider/id', got '{model_id}'"))?;
        self.command(json!({
            "type": "set_model",
            "provider": provider,
            "modelId": id,
        }))
        .await?;
        let _ = self.events.send(SessionEvent::ModelChanged {
            model_id: model_id.to_string(),
        });
        Ok(())
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        if !THINKING_LEVELS.contains(&mode_id) {
            return Err(anyhow!("unknown thinking level '{mode_id}'"));
        }
        self.command(json!({ "type": "set_thinking_level", "level": mode_id }))
            .await?;
        let _ = self.events.send(SessionEvent::ModeChanged {
            mode_id: mode_id.to_string(),
        });
        Ok(())
    }

    async fn respond_permission(&self, _request: &str, _outcome: PermissionOutcome) -> Result<()> {
        Err(anyhow!("the built-in agent does not request approvals"))
    }

    fn persistence(&self) -> Option<super::PersistHandle> {
        Some(super::PersistHandle {
            agent_id: "genet".into(),
            value: json!({ "sessionFile": self.session_file }),
        })
    }
}

async fn translate_stream(
    stdout: tokio::process::ChildStdout,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    child: Arc<Mutex<Option<Child>>>,
    said: Arc<Chatter>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(frame) => {
                        let mut state = turn.lock().await;
                        translate_frame(&frame, &mut state, &events);
                    }
                    Err(error) => {
                        tracing::warn!("undecodable frame from the agent: {error}");
                    }
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!("agent stdout closed: {error}");
                break;
            }
        }
    }

    // The process died. If a turn was in flight the client is still waiting for
    // it, so fail it explicitly rather than leaving a spinner forever — and say
    // what the process said, which is the part that can be acted on.
    let why = super::stopped("GeneHub Agent", &child, &said).await;
    tracing::warn!("{why}");
    let mut state = turn.lock().await;
    if let Some(turn_id) = state.id.take() {
        let _ = events.send(SessionEvent::TurnFailed {
            turn_id,
            error: TurnError {
                code: TurnErrorCode::AgentCrashed,
                message: why,
            },
        });
    }
}

fn translate_frame(frame: &Value, state: &mut TurnState, events: &broadcast::Sender<SessionEvent>) {
    let Some(kind) = frame.get("type").and_then(Value::as_str) else {
        return;
    };

    // Streaming events ride inside a `message_update` envelope that also
    // carries a snapshot of the whole draft message. We want the event; the
    // snapshot would just re-send everything on every token.
    if kind == "message_update" {
        if let Some(inner) = frame.get("assistantMessageEvent") {
            translate_frame(inner, state, events);
        }
        return;
    }

    let Some(turn_id) = state.id.clone() else {
        // Frames outside a turn (responses to control commands) carry no
        // timeline meaning.
        return;
    };
    let emit = |event: SessionEvent| {
        let _ = events.send(event);
    };

    match kind {
        "agent_start" => emit(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
        }),

        "text_start" => {
            let id = state.next_item_id();
            state.text_item = Some(id.clone());
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::AssistantMessage {
                    id,
                    text: String::new(),
                },
            });
        }
        "text_delta" => {
            if let (Some(id), Some(delta)) = (
                state.text_item.clone(),
                frame.get("delta").and_then(Value::as_str),
            ) {
                emit(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: id,
                    delta: ItemDelta::Text {
                        delta: delta.to_string(),
                    },
                });
            }
        }
        "text_end" => {
            if let Some(id) = state.text_item.take() {
                let text = frame
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                emit(SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::AssistantMessage { id, text },
                });
            }
        }

        "thinking_start" => {
            let id = state.next_item_id();
            state.reasoning_item = Some(id.clone());
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Reasoning {
                    id,
                    text: String::new(),
                },
            });
        }
        "thinking_delta" => {
            if let (Some(id), Some(delta)) = (
                state.reasoning_item.clone(),
                frame.get("delta").and_then(Value::as_str),
            ) {
                emit(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: id,
                    delta: ItemDelta::Text {
                        delta: delta.to_string(),
                    },
                });
            }
        }
        "thinking_end" => {
            state.reasoning_item = None;
        }

        "toolcall_end" => {
            let call = frame.get("toolCall").unwrap_or(&Value::Null);
            let (Some(id), Some(name)) = (
                call.get("id").and_then(Value::as_str),
                call.get("name").and_then(Value::as_str),
            ) else {
                return;
            };
            let arguments = call.get("arguments").cloned().unwrap_or(Value::Null);
            state
                .calls
                .insert(id.to_string(), (name.to_string(), arguments.clone()));
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    status: ToolStatus::Pending,
                    detail: detail_from_call(name, &arguments),
                },
            });
        }

        "tool_execution_start" => {
            if let Some(id) = frame.get("toolCallId").and_then(Value::as_str) {
                emit(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: id.to_string(),
                    delta: ItemDelta::ToolStatus {
                        status: ToolStatus::Running,
                        detail: None,
                    },
                });
            }
        }

        "tool_execution_end" => {
            let Some(id) = frame.get("toolCallId").and_then(Value::as_str) else {
                return;
            };
            let (name, arguments) = state
                .calls
                .get(id)
                .cloned()
                .unwrap_or_else(|| ("unknown".to_string(), Value::Null));
            let result = frame.get("result").unwrap_or(&Value::Null);
            let is_error = frame
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let status = if is_error {
                ToolStatus::Error
            } else {
                ToolStatus::Ok
            };
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::ToolCall {
                    id: id.to_string(),
                    name: name.clone(),
                    status,
                    detail: detail_from_result(&name, &arguments, result, is_error),
                },
            });
        }

        "message_end" => {
            let message = frame.get("message").unwrap_or(&Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                // The agent echoes the prompt back as a user message; the
                // daemon already recorded that from the client request.
                return;
            }
            if let Some(usage) = message.get("usage") {
                accumulate_usage(&mut state.usage, usage);
            }
            match message.get("stopReason").and_then(Value::as_str) {
                Some("error") => {
                    let message = message
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .unwrap_or("The agent could not complete this turn.");
                    state.failure = Some(classify_failure(message));
                }
                Some("aborted") => state.canceled = true,
                _ => {}
            }
        }

        "compaction_end" => {
            let id = state.next_item_id();
            let reason = frame
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .to_string();
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Compaction { id, reason },
            });
        }

        "agent_end" => {
            let usage = std::mem::take(&mut state.usage);
            let failure = state.failure.take();
            let canceled = state.canceled;
            state.id = None;
            state.calls.clear();
            state.text_item = None;
            state.reasoning_item = None;
            state.canceled = false;

            if let Some(error) = failure {
                emit(SessionEvent::TurnFailed { turn_id, error });
            } else if canceled {
                emit(SessionEvent::TurnCanceled { turn_id });
            } else {
                emit(SessionEvent::TurnCompleted { turn_id, usage });
            }
        }

        _ => {}
    }
}

/// Turns an agent-side failure message into a code the frontend can act on.
///
/// The message is matched rather than a status code because the agent reports
/// provider failures as prose; misclassifying only costs a less specific icon,
/// whereas dropping the distinction entirely would leave "no API key" looking
/// like a server outage.
fn classify_failure(message: &str) -> TurnError {
    let lower = message.to_lowercase();
    let code = if lower.contains("no model configured")
        || lower.contains("api key")
        || lower.contains("unauthorized")
        || lower.contains("401")
    {
        TurnErrorCode::MissingCredentials
    } else if lower.contains("429") || lower.contains("rate limit") {
        TurnErrorCode::RateLimited
    } else if lower.contains("timed out") || lower.contains("timeout") {
        TurnErrorCode::Timeout
    } else {
        TurnErrorCode::Upstream
    };
    TurnError {
        code,
        message: message.to_string(),
    }
}

fn accumulate_usage(total: &mut Usage, usage: &Value) {
    let field = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    total.input_tokens += field("input");
    total.output_tokens += field("output");
    total.cache_read_tokens += field("cacheRead");
    total.cache_write_tokens += field("cacheWrite");
    if let Some(cost) = usage
        .get("cost")
        .and_then(|c| c.get("total"))
        .and_then(Value::as_f64)
    {
        total.cost_usd = Some(total.cost_usd.unwrap_or(0.0) + cost);
    }
}

fn arg_str(arguments: &Value, key: &str) -> String {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Detail for a call that has been announced but not yet run.
fn detail_from_call(name: &str, arguments: &Value) -> ToolCallDetail {
    match name {
        "bash" => ToolCallDetail::Shell {
            command: arg_str(arguments, "command"),
            output: String::new(),
            exit_code: None,
        },
        "read" => ToolCallDetail::Read {
            path: arg_str(arguments, "path"),
            content: String::new(),
            truncated: false,
        },
        "write" => ToolCallDetail::Write {
            path: arg_str(arguments, "path"),
            content: arg_str(arguments, "content"),
        },
        "edit" => ToolCallDetail::Edit {
            path: arg_str(arguments, "path"),
            diff: String::new(),
        },
        "grep" | "find" | "ls" => ToolCallDetail::Search {
            query: search_query(name, arguments),
            matches: Vec::new(),
        },
        // Same shape as the settled call below, so the fallback renderer does
        // not have to handle two layouts for the same tool.
        _ => ToolCallDetail::Unknown {
            raw: json!({ "arguments": arguments.clone() }),
        },
    }
}

fn search_query(name: &str, arguments: &Value) -> String {
    match name {
        "grep" => arg_str(arguments, "pattern"),
        "find" => arg_str(arguments, "pattern"),
        _ => {
            let path = arg_str(arguments, "path");
            if path.is_empty() {
                ".".to_string()
            } else {
                path
            }
        }
    }
}

/// Detail once the tool has run. `result` is the agent's tool result object:
/// `{ content: [{type, text}], details?: {...} }`.
fn detail_from_result(
    name: &str,
    arguments: &Value,
    result: &Value,
    is_error: bool,
) -> ToolCallDetail {
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let details = result.get("details").cloned().unwrap_or(Value::Null);
    let truncated = details
        .get("truncation")
        .and_then(|t| t.get("truncated"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match name {
        "bash" => ToolCallDetail::Shell {
            command: arg_str(arguments, "command"),
            output: text.clone(),
            exit_code: exit_code_from(&text, is_error),
        },
        "read" => ToolCallDetail::Read {
            path: arg_str(arguments, "path"),
            content: text,
            truncated,
        },
        "write" => ToolCallDetail::Write {
            path: arg_str(arguments, "path"),
            content: arg_str(arguments, "content"),
        },
        "edit" => ToolCallDetail::Edit {
            path: arg_str(arguments, "path"),
            diff: details
                .get("diff")
                .and_then(Value::as_str)
                .unwrap_or(&text)
                .to_string(),
        },
        "grep" | "find" | "ls" => ToolCallDetail::Search {
            query: search_query(name, arguments),
            matches: parse_matches(&text),
        },
        _ => {
            let mut raw = Map::new();
            raw.insert("arguments".into(), arguments.clone());
            raw.insert("output".into(), Value::String(text));
            if !details.is_null() {
                raw.insert("details".into(), details);
            }
            ToolCallDetail::Unknown {
                raw: Value::Object(raw),
            }
        }
    }
}

/// The agent appends `Command exited with code N` after the output on failure.
fn exit_code_from(text: &str, is_error: bool) -> Option<i32> {
    if !is_error {
        return Some(0);
    }
    text.rsplit("Command exited with code ")
        .next()
        .and_then(|tail| tail.trim().parse::<i32>().ok())
}

/// Search tools return `path:line:text` or bare paths, one per line.
fn parse_matches(text: &str) -> Vec<genehub_proto::SearchMatch> {
    text.lines()
        .filter(|line| !line.is_empty() && *line != "(empty directory)")
        .take(500)
        .map(|line| {
            let mut parts = line.splitn(3, ':');
            let path = parts.next().unwrap_or(line).to_string();
            match (parts.next(), parts.next()) {
                (Some(number), Some(preview)) if number.parse::<u32>().is_ok() => {
                    genehub_proto::SearchMatch {
                        path,
                        line: number.parse().ok(),
                        preview: preview.to_string(),
                    }
                }
                _ => genehub_proto::SearchMatch {
                    path: line.to_string(),
                    line: None,
                    preview: String::new(),
                },
            }
        })
        .collect()
}

struct ConfiguredModel {
    provider: String,
    id: String,
    label: String,
    api: String,
    base_url: Option<String>,
    api_key: Option<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    reasoning: bool,
}

/// Turns configured providers into the models the picker offers.
///
/// Nothing is invented here any more. The provider list arrives already resolved
/// (`AppState::providers`): an address, and the models that address reported or
/// the user wrote down. A provider with a key but no models contributes nothing
/// and the settings page is where it says why — an agent picker is the wrong
/// place to explain a rejected key.
fn configured_models(providers: &ProviderMap) -> Vec<ConfiguredModel> {
    let mut models = Vec::new();
    for (provider, config) in providers {
        if config.api_key.as_deref().unwrap_or_default().is_empty() {
            continue;
        }
        // No address means no request we could honestly make. It used to mean
        // "send it to OpenAI and see".
        let Some(base_url) = config.base_url.clone().filter(|url| !url.is_empty()) else {
            continue;
        };
        let label = config.label.clone().unwrap_or_else(|| provider.clone());
        for id in &config.models {
            models.push(ConfiguredModel {
                provider: provider.clone(),
                id: id.clone(),
                // `DeepSeek:deepseek-v4-flash`. The provider is in the name
                // because with several keys configured the model id alone does
                // not say whose bill this is going on, and prettified names
                // ("DeepSeek V4 Flash") do not say what to type anywhere else.
                label: format!("{label}:{id}"),
                api: config
                    .dialect
                    .clone()
                    .unwrap_or_else(|| "openai".to_string()),
                base_url: Some(base_url.clone()),
                api_key: config.api_key.clone(),
                // Not in any provider's list response, so not claimed.
                context_window: None,
                max_tokens: None,
                reasoning: crate::provider::reasons(id),
            });
        }
    }
    models
}

/// Why there are no models to offer, when a key has been given.
///
/// The agent is what tells the user a turn cannot run, and left to itself it
/// says "add an API key in settings" — to someone who just did, and whose key
/// was rejected. Blaming the user for our state is the same mistake as sending
/// their DeepSeek key to OpenAI, so the provider's own refusal travels with the
/// models file.
fn why_none(providers: &ProviderMap) -> Option<String> {
    providers
        .values()
        .filter(|config| !config.api_key.as_deref().unwrap_or_default().is_empty())
        .find_map(|config| config.problem.clone())
}

/// Writes the agent's `models.json`.
///
/// This is the single seam that swaps a real provider for the test mock: only
/// `baseUrl` changes, so both modes exercise the same provider code path
/// (`docs/testing.md` §2.1).
fn write_models_file(home: &std::path::Path, providers: &ProviderMap) -> Result<()> {
    let models: Vec<Value> = configured_models(providers)
        .into_iter()
        .map(|model| {
            json!({
                "provider": model.provider,
                "id": model.id,
                "name": model.label,
                "api": model.api,
                "baseUrl": model.base_url,
                "apiKey": model.api_key,
                "contextWindow": model.context_window,
                "maxTokens": model.max_tokens,
                "reasoning": model.reasoning,
            })
        })
        .collect();
    let path = home.join("models.json");
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json!({ "models": models, "problem": why_none(providers) }))?,
    )
    .with_context(|| format!("writing {}", path.display()))?;
    crate::config::restrict_to_owner(&path)?;
    Ok(())
}

/// Convenience for callers that hold a single provider entry.
pub fn provider_map(entries: Vec<(&str, ProviderConfig)>) -> ProviderMap {
    entries
        .into_iter()
        .map(|(name, config)| (name.to_string(), config))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this pins shipped: the built-in agent reported "not installed" on
    /// every Windows machine, because we looked beside the daemon for a name the
    /// installer never writes. The platform where it broke is the one the test
    /// suite does not run on, so the platform is a parameter.
    #[test]
    fn on_windows_the_agent_is_looked_for_by_its_real_file_name() {
        assert_eq!(agent_file_name(true), "genet-agent.exe");
        assert_eq!(agent_file_name(false), "genet-agent");
    }

    /// And the name has to be the one the installer actually stages, which lives
    /// in a shell script this test reads rather than trusts.
    #[test]
    fn the_installer_stages_the_agent_under_that_same_name() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop/scripts/bundle.sh"),
        )
        .expect("the bundling script");
        assert!(
            script.contains("for binary in genet-daemon genet-agent"),
            "the installer no longer stages the agent under this name"
        );
        assert!(
            script.contains(r#"bin/$binary$exe"#),
            "the installer dropped the platform suffix, so the lookup will miss"
        );
    }

    /// Found beside the daemon, which is where an installed copy is — and the
    /// only place it is, since the install directory is not on PATH.
    #[test]
    fn an_agent_next_to_the_daemon_is_found() {
        let dir = tempfile::tempdir().expect("temp dir");
        let planted = dir.path().join(agent_file_name(cfg!(windows)));
        std::fs::write(&planted, "").expect("plant the agent");

        let adapter = GenetAdapter::discover_beside(Some(dir.path().to_path_buf()));
        assert_eq!(adapter.binary.as_deref(), Some(planted.as_path()));
    }

    /// An empty directory is not a failure to report at startup: it means this
    /// copy was built without the agent, and the picker simply will not offer it.
    #[test]
    fn nothing_beside_the_daemon_and_nothing_on_path_means_not_installed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let adapter = GenetAdapter::discover_beside(Some(dir.path().to_path_buf()));
        // PATH may legitimately have one on a developer machine; the assertion is
        // only that an empty sibling directory contributes nothing.
        if let Some(found) = adapter.binary {
            assert!(!found.starts_with(dir.path()), "invented {found:?}");
        }
    }

    fn state_with_turn() -> TurnState {
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

    /// Wraps an event the way the agent actually sends it.
    fn update(event: Value) -> Value {
        json!({
            "type": "message_update",
            "message": {"role": "assistant"},
            "assistantMessageEvent": event,
        })
    }

    #[test]
    fn a_streamed_reply_becomes_an_item_then_deltas_then_a_final_item() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();

        for frame in [
            json!({"type": "agent_start"}),
            update(json!({"type": "text_start"})),
            update(json!({"type": "text_delta", "delta": "he"})),
            update(json!({"type": "text_delta", "delta": "llo"})),
            update(json!({"type": "text_end", "content": "hello"})),
            json!({"type": "agent_end"}),
        ] {
            translate_frame(&frame, &mut state, &tx);
        }

        let events = drain(&mut rx);
        assert!(matches!(events[0], SessionEvent::TurnStarted { .. }));
        let item_id = match &events[1] {
            SessionEvent::Item {
                item: TimelineItem::AssistantMessage { id, text },
                ..
            } => {
                assert!(text.is_empty(), "the opening item starts empty");
                id.clone()
            }
            other => panic!("expected an opening item, got {other:?}"),
        };
        assert!(matches!(
            &events[2],
            SessionEvent::ItemDelta { item_id: id, .. } if *id == item_id
        ));
        match &events[4] {
            SessionEvent::Item {
                item: TimelineItem::AssistantMessage { id, text },
                ..
            } => {
                assert_eq!(id, &item_id, "the final item reuses the streaming id");
                assert_eq!(text, "hello");
            }
            other => panic!("expected the final item, got {other:?}"),
        }
        assert!(matches!(events[5], SessionEvent::TurnCompleted { .. }));
    }

    #[test]
    fn a_bash_call_carries_its_command_before_the_output_exists() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &update(json!({"type": "toolcall_end", "toolCall": {
                "id": "call_1", "name": "bash", "arguments": {"command": "ls -a"}
            }})),
            &mut state,
            &tx,
        );
        match &drain(&mut rx)[0] {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { status, detail, .. },
                ..
            } => {
                assert_eq!(*status, ToolStatus::Pending);
                assert_eq!(
                    detail,
                    &ToolCallDetail::Shell {
                        command: "ls -a".into(),
                        output: String::new(),
                        exit_code: None
                    }
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_failed_command_reports_its_exit_code() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &update(json!({"type": "toolcall_end", "toolCall": {
                "id": "c", "name": "bash", "arguments": {"command": "false"}
            }})),
            &mut state,
            &tx,
        );
        translate_frame(
            &json!({"type": "tool_execution_end", "toolCallId": "c", "isError": true,
                    "result": {"content": [{"type": "text", "text": "out\n\nCommand exited with code 3"}]}}),
            &mut state,
            &tx,
        );
        let events = drain(&mut rx);
        match events.last().unwrap() {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { status, detail, .. },
                ..
            } => {
                assert_eq!(*status, ToolStatus::Error);
                match detail {
                    ToolCallDetail::Shell { exit_code, .. } => assert_eq!(*exit_code, Some(3)),
                    other => panic!("unexpected detail {other:?}"),
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Rule 1 of the normalized model: an agent we have never seen must still
    /// render, so an unmapped tool becomes `Unknown` rather than nothing.
    #[test]
    fn an_unmapped_tool_falls_back_to_unknown_without_losing_data() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &update(json!({"type": "toolcall_end", "toolCall": {
                "id": "c", "name": "teleport", "arguments": {"destination": "mars"}
            }})),
            &mut state,
            &tx,
        );
        translate_frame(
            &json!({"type": "tool_execution_end", "toolCallId": "c",
                    "result": {"content": [{"type": "text", "text": "arrived"}]}}),
            &mut state,
            &tx,
        );
        let events = drain(&mut rx);
        match events.last().unwrap() {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { name, detail, .. },
                ..
            } => {
                assert_eq!(name, "teleport");
                match detail {
                    ToolCallDetail::Unknown { raw } => {
                        assert_eq!(raw["arguments"]["destination"], "mars");
                        assert_eq!(raw["output"], "arrived");
                    }
                    other => panic!("unexpected detail {other:?}"),
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn the_echoed_user_prompt_is_not_duplicated_onto_the_timeline() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({"type": "message_end", "message": {"role": "user", "content": "hi"}}),
            &mut state,
            &tx,
        );
        assert!(
            drain(&mut rx).is_empty(),
            "the daemon already recorded the prompt it sent"
        );
    }

    #[test]
    fn a_turn_that_errors_out_fails_with_a_classified_code() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({"type": "message_end", "message": {
                "role": "assistant", "stopReason": "error",
                "errorMessage": "no model configured; set an API key"
            }}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        match drain(&mut rx).last().unwrap() {
            SessionEvent::TurnFailed { error, .. } => {
                assert_eq!(error.code, TurnErrorCode::MissingCredentials);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_aborted_turn_is_reported_as_canceled_not_completed() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "aborted"}}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        assert!(matches!(
            drain(&mut rx).last().unwrap(),
            SessionEvent::TurnCanceled { .. }
        ));
    }

    #[test]
    fn usage_accumulates_across_the_turns_inside_one_run() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        for _ in 0..2 {
            translate_frame(
                &json!({"type": "message_end", "message": {
                    "role": "assistant", "stopReason": "stop",
                    "usage": {"input": 10, "output": 5, "cost": {"total": 0.25}}
                }}),
                &mut state,
                &tx,
            );
        }
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        match drain(&mut rx).last().unwrap() {
            SessionEvent::TurnCompleted { usage, .. } => {
                assert_eq!(usage.input_tokens, 20);
                assert_eq!(usage.output_tokens, 10);
                assert_eq!(usage.cost_usd, Some(0.5));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn frames_arriving_outside_a_turn_are_ignored() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = TurnState::default();
        translate_frame(&update(json!({"type": "text_start"})), &mut state, &tx);
        assert!(drain(&mut rx).is_empty());
    }

    #[test]
    fn grep_output_is_parsed_into_located_matches() {
        let matches = parse_matches("src/a.rs:12:let x = 1\nsrc/b.rs:3:fn main()");
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].path, "src/a.rs");
        assert_eq!(matches[0].line, Some(12));
        assert_eq!(matches[0].preview, "let x = 1");
    }

    #[test]
    fn bare_paths_from_ls_parse_without_a_line_number() {
        let matches = parse_matches("a.txt\nsub/");
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|m| m.line.is_none()));
        assert_eq!(matches[1].path, "sub/");
    }

    /// The provider list reaching an adapter is already resolved, so these are
    /// the two ways a provider can contribute nothing: no key, or nowhere to
    /// send it.
    #[test]
    fn a_provider_needs_both_a_key_and_an_address_to_offer_anything() {
        let providers = provider_map(vec![
            (
                "deepseek",
                ProviderConfig {
                    api_key: Some("sk-test".into()),
                    base_url: Some("https://api.deepseek.com/v1".into()),
                    label: Some("DeepSeek".into()),
                    models: vec!["deepseek-chat".into()],
                    ..Default::default()
                },
            ),
            (
                "anthropic",
                ProviderConfig {
                    models: vec!["claude-sonnet-4-20250514".into()],
                    ..Default::default()
                },
            ),
            (
                "kimi",
                ProviderConfig {
                    api_key: Some("sk-test".into()),
                    models: vec!["kimi-k2".into()],
                    ..Default::default()
                },
            ),
        ]);
        let models = configured_models(&providers);
        assert!(
            models.iter().all(|m| m.provider == "deepseek"),
            "offered a model we cannot reach: {:?}",
            models.iter().map(|m| m.id.clone()).collect::<Vec<_>>()
        );
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].api, "openai");
    }

    /// What the picker shows. With two providers configured, `deepseek-chat`
    /// alone does not say whose key is about to be spent.
    #[test]
    fn a_model_is_named_after_the_provider_and_its_own_id() {
        let providers = provider_map(vec![(
            "deepseek",
            ProviderConfig {
                api_key: Some("sk-test".into()),
                base_url: Some("https://api.deepseek.com/v1".into()),
                label: Some("DeepSeek".into()),
                models: vec!["deepseek-v4-flash".into()],
                ..Default::default()
            },
        )]);
        let models = configured_models(&providers);
        assert_eq!(models[0].label, "DeepSeek:deepseek-v4-flash");
        assert!(models[0].reasoning, "v4-flash reasons");
    }

    #[test]
    fn the_models_file_carries_the_base_url_the_test_harness_injected() {
        let dir = tempfile::tempdir().unwrap();
        let providers = provider_map(vec![(
            "deepseek",
            ProviderConfig {
                api_key: Some("sk-test".into()),
                base_url: Some("http://127.0.0.1:9/v1".into()),
                models: vec!["deepseek-v4-flash".into()],
                ..Default::default()
            },
        )]);
        write_models_file(dir.path(), &providers).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("models.json")).unwrap())
                .unwrap();
        assert_eq!(written["models"][0]["baseUrl"], "http://127.0.0.1:9/v1");
        assert_eq!(written["models"][0]["apiKey"], "sk-test");
    }
}
