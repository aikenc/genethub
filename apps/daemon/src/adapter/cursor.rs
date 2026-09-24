//! Adapter for Cursor's CLI in print mode (`cursor-agent --print
//! --output-format stream-json`).
//!
//! Cursor's ACP server ignores the launch `--model` and `session/new` model
//! parameters and offers exactly one variant per model, so reasoning effort and
//! Fast could be shown but never chosen (fb_eVSh3fuuyrv6). Print mode honours
//! `--model <slug>` on every run, so each turn is one short-lived process that
//! names the exact slug (`grok-4.7-low-fast`) and continues the conversation
//! through `--resume <chatId>`.
//!
//! Three consequences shape this file:
//! - a canceled run is not kept in Cursor's history, so the next prompt carries
//!   what was interrupted;
//! - every run rewrites Cursor's global default model in
//!   `~/.cursor/cli-config.json`, which is restored once no turn is running;
//! - ACP session ids and print chat ids live in separate stores, so a handle
//!   from the ACP adapter is refused (`accepts_resume`) and the session layer
//!   seeds the conversation from GeneHub's own log instead.

#![allow(deprecated)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use crate::os_process::{Child, Command};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Capabilities, Catalog, ItemDelta, ModeInfo, ModelInfo, PermissionOutcome, ProbeState,
    SearchMatch, SessionEvent, TimelineItem, TodoEntry, TodoStatus, ToolCallDetail, ToolKind,
    ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, Mutex, RwLock};

use super::acp::AcpAdapter;
use super::usage;
use super::{
    find_executable_in, AgentAdapter, AgentSession, Chatter, ImportCandidate, ImportedHistory,
    PersistHandle, PromptInput, ProviderMap, SessionConfig,
};

const EVENT_CAPACITY: usize = 1024;
const LIST_MODELS_TIMEOUT: Duration = Duration::from_secs(15);
/// Keys every print run writes into `cli-config.json`.
const GLOBAL_MODEL_KEYS: &[&str] = &["model", "selectedModel"];
/// Enough of an interrupted exchange to pick it up again, not a transcript.
const INTERRUPTED_CLIP: usize = 4000;

pub struct CursorAdapter {
    id: String,
    label: String,
    program_name: String,
    extra_dirs: Vec<PathBuf>,
    /// Import still reads Cursor's ACP session store: print mode cannot list
    /// or replay sessions.
    importer: AcpAdapter,
    models: RwLock<Option<ListedModels>>,
}

#[derive(Clone, Default)]
struct ListedModels {
    /// Slugs exactly as `--list-models` printed them; the only ids `--model`
    /// accepts.
    raw: Vec<ModelInfo>,
    /// One entry per base model with its efforts and Fast, as the picker shows.
    grouped: Vec<ModelInfo>,
    default_model: Option<String>,
}

impl CursorAdapter {
    /// `acp_command` is the program plus its ACP arguments, used only for import.
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        acp_command: Vec<String>,
        extra_dirs: Vec<PathBuf>,
    ) -> Self {
        let id = id.into();
        let label = label.into();
        CursorAdapter {
            program_name: acp_command.first().cloned().unwrap_or_default(),
            importer: AcpAdapter::new(id.clone(), label.clone(), acp_command)
                .with_extra_dirs(extra_dirs.clone()),
            id,
            label,
            extra_dirs,
            models: RwLock::new(None),
        }
    }

    fn program(&self) -> Option<PathBuf> {
        find_executable_in(&self.program_name, &self.extra_dirs)
    }

    async fn listed(&self, program: &Path) -> Option<ListedModels> {
        // A failed listing is not remembered, so a CLI mid-update does not hide
        // the picker until someone restarts the daemon.
        if let Some(cached) = self.models.read().await.clone() {
            return Some(cached);
        }
        let (raw, default) = list_raw_models_from_cli(program).await?;
        let (grouped, default_model) = group_cli_models(&raw, default.as_deref());
        let listed = ListedModels {
            raw,
            grouped,
            default_model,
        };
        *self.models.write().await = Some(listed.clone());
        Some(listed)
    }
}

fn cursor_modes() -> Vec<ModeInfo> {
    vec![
        ModeInfo {
            id: "agent".into(),
            label: "Agent".into(),
            description: Some("Full tool access".into()),
        },
        ModeInfo {
            id: "plan".into(),
            label: "Plan".into(),
            description: Some("Read-only planning".into()),
        },
        ModeInfo {
            id: "ask".into(),
            label: "Ask".into(),
            description: Some("Read-only questions".into()),
        },
    ]
}

#[async_trait]
impl AgentAdapter for CursorAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            set_effort: true,
            set_fast: true,
            interrupt: true,
            set_model: true,
            set_mode: true,
            // Print mode runs with `--force`: there is no one to ask mid-run.
            permissions: false,
            resume: true,
            fork: false,
            attachments: true,
        }
    }

    fn accepts_resume(&self, handle: &PersistHandle) -> bool {
        handle
            .value
            .get("chatId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    }

    async fn probe(&self) -> ProbeState {
        let Some(program) = self.program() else {
            return ProbeState::NotInstalled;
        };
        if std::env::var_os("CURSOR_API_KEY").is_some() {
            return ProbeState::Ready;
        }
        match super::acp::logged_in(&program).await {
            Some(false) => ProbeState::Unavailable {
                reason: "找到了 Cursor，但它还没登录：先跑 cursor-agent login".into(),
            },
            _ => ProbeState::Ready,
        }
    }

    async fn invalidate_catalog(&self) {
        *self.models.write().await = None;
        self.importer.invalidate_catalog().await;
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        let Some(program) = self.program() else {
            return Catalog::default();
        };
        let Some(listed) = self.listed(&program).await else {
            return Catalog::default();
        };
        Catalog {
            models: listed.grouped,
            modes: cursor_modes(),
            commands: Vec::new(),
            runtime_axes: None,
            default_model: listed.default_model,
            default_mode: Some("agent".into()),
            default_effort: None,
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("{} is not installed", self.program_name))?;
        let listed = self.listed(&program).await.unwrap_or_default();
        let chat_id = config
            .resume
            .as_ref()
            .filter(|handle| self.accepts_resume(handle))
            .and_then(|handle| handle.value.get("chatId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let runtime = Runtime {
            model_id: config.model_id.clone(),
            effort_id: config.effort_id.clone(),
            fast: config.fast.unwrap_or(false),
            mode_id: config.mode_id.clone(),
        };
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Ok(Box::new(CursorSession {
            program,
            agent_id: self.id.clone(),
            label: self.label.clone(),
            config,
            listed,
            runtime: std::sync::Mutex::new(runtime),
            chat_id: Arc::new(std::sync::Mutex::new(chat_id)),
            interrupted: Arc::new(std::sync::Mutex::new(None)),
            turn: Arc::new(Mutex::new(TurnState::default())),
            child: Arc::new(Mutex::new(None)),
            canceled: Arc::new(AtomicBool::new(false)),
            events,
            tasks: super::SessionTasks::default(),
        }))
    }

    async fn list_import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Result<Option<Vec<ImportCandidate>>> {
        self.importer.list_import_candidates(cwd, limit).await
    }

    async fn import_history(&self, cwd: &Path, source_id: &str) -> Result<ImportedHistory> {
        // The imported handle names an ACP session, which `accepts_resume`
        // refuses; the first prompt is then seeded from the imported items.
        self.importer.import_history(cwd, source_id).await
    }
}

#[derive(Debug, Clone)]
struct Runtime {
    model_id: Option<String>,
    effort_id: Option<String>,
    fast: bool,
    mode_id: Option<String>,
}

#[derive(Default)]
struct TurnState {
    id: Option<String>,
    counter: u64,
    text_item: Option<String>,
    reasoning_item: Option<String>,
    usage: Usage,
    /// The user's words for this turn and what Cursor had answered so far,
    /// kept for the next prompt if this run is canceled.
    prompt: String,
    partial: String,
    outcome: Option<Outcome>,
}

impl TurnState {
    fn next_item_id(&mut self) -> String {
        self.counter += 1;
        let turn = self.id.as_deref().unwrap_or("t0");
        format!("{turn}-{}", self.counter)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Success(Option<Value>),
    Error(String),
}

struct CursorSession {
    program: PathBuf,
    agent_id: String,
    label: String,
    config: SessionConfig,
    listed: ListedModels,
    runtime: std::sync::Mutex<Runtime>,
    chat_id: Arc<std::sync::Mutex<Option<String>>>,
    interrupted: Arc<std::sync::Mutex<Option<String>>>,
    turn: Arc<Mutex<TurnState>>,
    child: Arc<Mutex<Option<Child>>>,
    canceled: Arc<AtomicBool>,
    events: broadcast::Sender<SessionEvent>,
    tasks: super::SessionTasks,
}

impl CursorSession {
    fn model(&self, model_id: &str) -> Option<&ModelInfo> {
        self.listed
            .grouped
            .iter()
            .find(|model| model.id == model_id)
    }

    fn launch_model(&self, runtime: &Runtime) -> Result<Option<String>> {
        let Some(model_id) = runtime
            .model_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        else {
            return Ok(None);
        };
        let slug = launch_slug(
            model_id,
            runtime.effort_id.as_deref(),
            runtime.fast,
            &self.listed.raw,
        )
        .ok_or_else(|| anyhow!("Cursor 没有列出模型 {model_id}；刷新模型列表或换一个模型后再试"))?;
        Ok(Some(slug))
    }

    fn compose_prompt(&self, input: &PromptInput) -> Result<String> {
        let mut prompt = String::new();
        if let Some(context) = self
            .config
            .additional_system_prompt
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            prompt.push_str(&wrap_system_guidance(context));
            prompt.push_str("\n\n");
        }
        if let Some(note) = self.interrupted.lock().expect("never poisoned").take() {
            prompt.push_str(&note);
            prompt.push_str("\n\n");
        }
        prompt.push_str(&input.text);
        let files = attachment_paths(input, &self.config.scratch_dir)?;
        if !files.is_empty() {
            prompt.push_str("\n\nAttached files (open them with your read tool):");
            for (name, path) in files {
                prompt.push_str(&format!("\n- {name}: {}", path.display()));
            }
        }
        Ok(prompt)
    }
}

#[async_trait]
impl AgentSession for CursorSession {
    fn events(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    async fn send(&self, input: PromptInput) -> Result<String> {
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4().simple());
        let mut turn = self.turn.lock().await;
        if turn.id.is_some() {
            bail!("Cursor 还在处理上一轮");
        }
        let runtime = self.runtime.lock().expect("never poisoned").clone();
        let slug = self.launch_model(&runtime)?;
        let prompt = self.compose_prompt(&input)?;
        let chat_id = self.chat_id.lock().expect("never poisoned").clone();

        let mut command = Command::new(&self.program);
        command
            .args(print_args(
                slug.as_deref(),
                chat_id.as_deref(),
                runtime.mode_id.as_deref(),
            ))
            .current_dir(&self.config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::apply_session_environment(&mut command, &self.config);
        super::owned_child(&mut command);

        let guard = GlobalModelGuard::enter();
        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {}", self.program.display()))?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let said = Arc::new(Chatter::default());
        said.watch("cursor", child.stderr.take()).await;
        tracing::info!(
            model = slug.as_deref().unwrap_or("(Cursor default)"),
            resume = chat_id.is_some(),
            "cursor print turn starting"
        );

        self.canceled.store(false, Ordering::SeqCst);
        *self.child.lock().await = Some(child);
        *turn = TurnState {
            id: Some(turn_id.clone()),
            prompt: input.text.clone(),
            ..TurnState::default()
        };
        usage::record_round_start(&mut turn.usage);
        drop(turn);
        let _ = self.events.send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 0,
        });

        // Print mode reads the prompt from stdin until EOF; an argv prompt hits
        // the OS argument limit once guidance is attached.
        let write = async {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await
        };
        if let Err(error) = write.await {
            tracing::warn!(%error, "could not hand the prompt to cursor-agent");
        }
        drop(stdin);

        self.tasks.spawn(run_turn(RunTurn {
            stdout,
            turn_id: turn_id.clone(),
            turn: self.turn.clone(),
            child: self.child.clone(),
            said,
            label: self.label.clone(),
            events: self.events.clone(),
            chat_id: self.chat_id.clone(),
            interrupted: self.interrupted.clone(),
            canceled: self.canceled.clone(),
            guard,
        }));
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        {
            let turn = self.turn.lock().await;
            if turn.id.is_none() {
                return Ok(());
            }
            *self.interrupted.lock().expect("never poisoned") =
                Some(interrupted_note(&turn.prompt, &turn.partial));
        }
        self.canceled.store(true, Ordering::SeqCst);
        super::close_child(&self.child).await
    }

    async fn close(&self) -> Result<()> {
        super::close_child(&self.child).await?;
        self.tasks.stop().await;
        Ok(())
    }

    async fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .await
            .as_ref()
            .and_then(|child| child.id())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        let mut runtime = self.runtime.lock().expect("never poisoned");
        match self.model(model_id) {
            Some(model) => {
                if runtime
                    .effort_id
                    .as_ref()
                    .is_some_and(|effort| !model.efforts.contains(effort))
                {
                    runtime.effort_id = None;
                }
                if !model.supports_fast {
                    runtime.fast = false;
                }
            }
            None if self.listed.raw.iter().any(|model| model.id == model_id) => {}
            None => bail!("Cursor 没有列出模型 {model_id}"),
        }
        runtime.model_id = Some(model_id.to_string());
        Ok(())
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        if !cursor_modes().iter().any(|mode| mode.id == mode_id) {
            bail!("Cursor has no mode '{mode_id}'");
        }
        self.runtime.lock().expect("never poisoned").mode_id = Some(mode_id.to_string());
        Ok(())
    }

    async fn set_effort(&self, effort_id: &str) -> Result<()> {
        let mut runtime = self.runtime.lock().expect("never poisoned");
        if let Some(model) = runtime.model_id.as_deref().and_then(|id| self.model(id)) {
            if !model.efforts.iter().any(|effort| effort == effort_id) {
                bail!("{} 没有 {effort_id} 这一档思考强度", model.label);
            }
        }
        runtime.effort_id = Some(effort_id.to_string());
        Ok(())
    }

    async fn set_fast(&self, fast: bool) -> Result<()> {
        let mut runtime = self.runtime.lock().expect("never poisoned");
        if fast {
            if let Some(model) = runtime.model_id.as_deref().and_then(|id| self.model(id)) {
                if !model.supports_fast {
                    bail!("{} 没有 Fast 版本", model.label);
                }
            }
        }
        runtime.fast = fast;
        Ok(())
    }

    async fn respond_permission(
        &self,
        _request_id: &str,
        _outcome: PermissionOutcome,
    ) -> Result<()> {
        Err(anyhow!("Cursor print mode runs without permission prompts"))
    }

    fn persistence(&self) -> Option<PersistHandle> {
        let chat_id = self.chat_id.lock().expect("never poisoned").clone()?;
        Some(PersistHandle {
            agent_id: self.agent_id.clone(),
            value: json!({ "chatId": chat_id }),
        })
    }
}

struct RunTurn {
    stdout: crate::os_process::ChildStdout,
    turn_id: String,
    turn: Arc<Mutex<TurnState>>,
    child: Arc<Mutex<Option<Child>>>,
    said: Arc<Chatter>,
    label: String,
    events: broadcast::Sender<SessionEvent>,
    chat_id: Arc<std::sync::Mutex<Option<String>>>,
    interrupted: Arc<std::sync::Mutex<Option<String>>>,
    canceled: Arc<AtomicBool>,
    guard: GlobalModelGuard,
}

async fn run_turn(run: RunTurn) {
    let mut lines = BufReader::new(run.stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let mut turn = run.turn.lock().await;
        if let Some(chat_id) = translate_event(&event, &mut turn, &run.events) {
            *run.chat_id.lock().expect("never poisoned") = Some(chat_id);
        }
    }

    let canceled = run.canceled.swap(false, Ordering::SeqCst);
    let (outcome, snapshot) = {
        let turn = run.turn.lock().await;
        (turn.outcome.clone(), turn.usage.clone())
    };
    let event = match outcome {
        _ if canceled => SessionEvent::TurnCanceled {
            turn_id: run.turn_id.clone(),
        },
        Some(Outcome::Success(reported)) => {
            let mut usage = snapshot;
            if let Some(reported) = reported {
                let parsed = usage::parse_usage(&reported);
                if parsed.input_tokens > 0 || parsed.output_tokens > 0 {
                    let previous = usage.clone();
                    usage = parsed;
                    usage.llm_rounds = previous.llm_rounds;
                    usage.tool_output_tokens = previous.tool_output_tokens;
                    usage::preserve_timing(&mut usage, &previous);
                }
            }
            usage::finalize_output_rate(&mut usage);
            SessionEvent::TurnCompleted {
                turn_id: run.turn_id.clone(),
                usage,
                fork_checkpoint: None,
            }
        }
        Some(Outcome::Error(message)) => SessionEvent::TurnFailed {
            turn_id: run.turn_id.clone(),
            error: TurnError {
                code: TurnErrorCode::Upstream,
                message,
            },
        },
        None => SessionEvent::TurnFailed {
            turn_id: run.turn_id.clone(),
            error: TurnError {
                code: TurnErrorCode::AgentCrashed,
                message: super::stopped(&run.label, &run.child, &run.said).await,
            },
        },
    };
    if !canceled {
        // A run that ended on its own is in Cursor's history; an earlier
        // interruption note set during a race is stale by now.
        run.interrupted.lock().expect("never poisoned").take();
    }
    if let Err(error) = super::close_child(&run.child).await {
        tracing::warn!(%error, "cursor print process did not exit cleanly");
    }
    run.turn.lock().await.id = None;
    drop(run.guard);
    let _ = run.events.send(event);
}

/// Arguments for one print run. The prompt goes to stdin.
fn print_args(slug: Option<&str>, chat_id: Option<&str>, mode_id: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--approve-mcps",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    if let Some(slug) = slug {
        args.extend(["--model".into(), slug.to_string()]);
    }
    if let Some(chat_id) = chat_id {
        args.extend(["--resume".into(), chat_id.to_string()]);
    }
    if let Some(mode) = mode_id.filter(|mode| matches!(*mode, "plan" | "ask")) {
        args.extend(["--mode".into(), mode.to_string()]);
    }
    args
}

fn wrap_system_guidance(context: &str) -> String {
    format!(
        "<genehub_system_guidance>\n{context}\n</genehub_system_guidance>\n\nThe next block is the user's request."
    )
}

fn clip(text: &str, limit: usize) -> String {
    let text = text.trim();
    let mut clipped: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        clipped.push('…');
    }
    clipped
}

fn interrupted_note(prompt: &str, partial: &str) -> String {
    let mut note = String::from(
        "<genehub_interrupted_turn>\nThe user stopped the previous request before it finished; \
         it is not in this conversation's history. Take it into account, but only act on the new \
         request below.\nPrevious request:\n",
    );
    note.push_str(&clip(prompt, INTERRUPTED_CLIP));
    if !partial.trim().is_empty() {
        note.push_str("\nYour partial reply before the stop:\n");
        note.push_str(&clip(partial, INTERRUPTED_CLIP));
    }
    note.push_str("\n</genehub_interrupted_turn>");
    note
}

/// Files the CLI should open, spelled as the host names them. Pasted images
/// are spilled into the session scratch directory first.
fn attachment_paths(input: &PromptInput, scratch: &Path) -> Result<Vec<(String, PathBuf)>> {
    use base64::Engine as _;
    let mut files = Vec::new();
    for (index, attachment) in input.attachments.iter().enumerate() {
        if let Some(path) = attachment.path.as_deref().filter(|path| !path.is_empty()) {
            files.push((
                attachment.name.clone(),
                crate::guest_paths::host_path(Path::new(path)),
            ));
            continue;
        }
        let Some(data) = attachment.data_base64.as_deref() else {
            continue;
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.split_whitespace().collect::<String>())
            .context("decoding a pasted attachment")?;
        let dir = scratch.join("attachments");
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join(format!(
            "{}-{index}.{}",
            uuid::Uuid::new_v4().simple(),
            extension_for(&attachment.mime)
        ));
        std::fs::write(&path, &bytes).with_context(|| format!("writing {}", path.display()))?;
        files.push((
            attachment.name.clone(),
            crate::guest_paths::host_path(&path),
        ));
    }
    Ok(files)
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/png" => "png",
        "application/pdf" => "pdf",
        _ if mime.starts_with("text/") => "txt",
        _ if mime.starts_with("image/") => "png",
        _ => "bin",
    }
}

/// Applies one stream-json event to the turn, emitting timeline events.
/// Returns the chat id when the event names one.
fn translate_event(
    event: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) -> Option<String> {
    let chat_id = event
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let Some(turn_id) = state.id.clone() else {
        return chat_id;
    };
    let emit = |event: SessionEvent| {
        let _ = events.send(event);
    };
    match (
        event.get("type").and_then(Value::as_str),
        event.get("subtype").and_then(Value::as_str),
    ) {
        (Some("system"), Some("init")) => {
            let model = event.get("model").and_then(Value::as_str).unwrap_or("");
            tracing::info!(model, "cursor print turn running");
        }
        (Some("thinking"), Some("delta")) => {
            let delta = event
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if delta.is_empty() {
                return chat_id;
            }
            open_round(state);
            usage::record_first_token(&mut state.usage);
            usage::record_visible_output(&mut state.usage, &delta);
            usage::emit_progress(events, &turn_id, &state.usage);
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
                        item: TimelineItem::Reasoning {
                            id,
                            text: delta,
                            received_at_ms: None,
                        },
                    });
                }
            }
        }
        (Some("assistant"), _) => {
            // Without `timestamp_ms` this is the recap of the last segment,
            // already streamed as deltas.
            if event.get("timestamp_ms").is_none() {
                return chat_id;
            }
            let delta = message_text(event);
            if delta.is_empty() {
                return chat_id;
            }
            open_round(state);
            usage::record_first_token(&mut state.usage);
            usage::record_visible_output(&mut state.usage, &delta);
            usage::emit_progress(events, &turn_id, &state.usage);
            state.partial.push_str(&delta);
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
                        item: TimelineItem::AssistantMessage {
                            id,
                            text: delta,
                            received_at_ms: None,
                        },
                    });
                }
            }
        }
        (Some("tool_call"), Some(phase @ ("started" | "completed"))) => {
            state.text_item = None;
            state.reasoning_item = None;
            if let Some(item) = tool_item(event, phase == "completed", state) {
                emit(SessionEvent::Item { turn_id, item });
            }
        }
        (Some("result"), _) => {
            let is_error = event.get("is_error").and_then(Value::as_bool) == Some(true)
                || event.get("subtype").and_then(Value::as_str) != Some("success");
            state.outcome = Some(if is_error {
                Outcome::Error(
                    event
                        .get("result")
                        .and_then(Value::as_str)
                        .filter(|text| !text.trim().is_empty())
                        .unwrap_or("Cursor reported an error")
                        .to_string(),
                )
            } else {
                Outcome::Success(event.get("usage").cloned())
            });
        }
        _ => {}
    }
    chat_id
}

fn open_round(state: &mut TurnState) {
    if state.text_item.is_none() && state.reasoning_item.is_none() {
        state.usage.llm_rounds += 1;
        usage::record_round_start(&mut state.usage);
    }
}

fn message_text(event: &Value) -> String {
    event
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect()
}

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn tool_item(event: &Value, completed: bool, state: &mut TurnState) -> Option<TimelineItem> {
    let call = event.get("tool_call")?.as_object()?;
    let (kind, body) = call
        .iter()
        .find(|(key, value)| key.ends_with("ToolCall") && value.is_object())?;
    let args = body.get("args").cloned().unwrap_or(Value::Null);
    let result = body.get("result");
    let success = result.and_then(|result| result.get("success"));

    if kind == "updateTodosToolCall" {
        let todos = success
            .and_then(|success| success.get("todos"))
            .or_else(|| args.get("todos"))?
            .as_array()?;
        return Some(TimelineItem::Todo {
            id: state.next_item_id(),
            items: todos
                .iter()
                .map(|todo| TodoEntry {
                    text: str_at(todo, "content").to_string(),
                    status: match str_at(todo, "status") {
                        "TODO_STATUS_IN_PROGRESS" => TodoStatus::InProgress,
                        "TODO_STATUS_COMPLETED" => TodoStatus::Completed,
                        _ => TodoStatus::Pending,
                    },
                })
                .collect(),
        });
    }

    let id = event
        .get("call_id")
        .and_then(Value::as_str)?
        .replace(['\n', '\r'], ":");
    let status = match (completed, success) {
        (false, _) => ToolStatus::Running,
        (true, Some(_)) => ToolStatus::Ok,
        (true, None) => ToolStatus::Error,
    };
    let failure = || {
        result
            .filter(|_| success.is_none())
            .map(|result| compact_json(result))
            .unwrap_or_default()
    };
    let empty = Value::Null;
    let out = success.unwrap_or(&empty);
    let (name, detail) = match kind.as_str() {
        "shellToolCall" => {
            let mut output = [str_at(out, "stdout"), str_at(out, "stderr")]
                .into_iter()
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if output.is_empty() {
                output = failure();
            }
            (
                "Shell",
                ToolCallDetail::Shell {
                    command: str_at(&args, "command").to_string(),
                    output,
                    exit_code: out
                        .get("exitCode")
                        .and_then(Value::as_i64)
                        .map(|code| code as i32),
                },
            )
        }
        "readToolCall" => (
            "Read",
            ToolCallDetail::Read {
                path: str_at(&args, "path").to_string(),
                content: if success.is_some() {
                    str_at(out, "content").to_string()
                } else {
                    failure()
                },
                truncated: out.get("exceededLimit").and_then(Value::as_bool) == Some(true),
            },
        ),
        "editToolCall" => (
            "Edit",
            ToolCallDetail::Edit {
                path: str_at(&args, "path").to_string(),
                diff: if success.is_some() {
                    str_at(out, "diffString").to_string()
                } else {
                    failure()
                },
            },
        ),
        "grepToolCall" => (
            "Grep",
            ToolCallDetail::Search {
                query: str_at(&args, "pattern").to_string(),
                matches: grep_matches(out),
            },
        ),
        "globToolCall" => (
            "Glob",
            ToolCallDetail::Search {
                query: str_at(&args, "globPattern").to_string(),
                matches: out
                    .get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|file| SearchMatch {
                        path: file.to_string(),
                        line: None,
                        preview: String::new(),
                    })
                    .collect(),
            },
        ),
        other => {
            let name = other.strip_suffix("ToolCall").unwrap_or(other);
            let output = match success {
                Some(success) => compact_json(success),
                None => failure(),
            };
            return Some(TimelineItem::ToolCall {
                id,
                images: Vec::new(),
                name: name.to_string(),
                status,
                detail: ToolCallDetail::Overview {
                    tool_kind: tool_kind(name),
                    overview: name.to_string(),
                    input: compact_json(&args),
                    output,
                },
                started_at_ms: None,
                finished_at_ms: None,
            });
        }
    };
    Some(TimelineItem::ToolCall {
        id,
        images: Vec::new(),
        name: name.to_string(),
        status,
        detail,
        started_at_ms: None,
        finished_at_ms: None,
    })
}

fn tool_kind(name: &str) -> ToolKind {
    let lower = name.to_ascii_lowercase();
    if lower.contains("mcp") {
        ToolKind::Mcp
    } else if lower.contains("web") || lower.contains("fetch") {
        ToolKind::Fetch
    } else if lower.contains("delete") || lower.contains("write") {
        ToolKind::Write
    } else if lower.contains("search") || lower.contains("ls") {
        ToolKind::Search
    } else if lower.contains("task") || lower.contains("agent") {
        ToolKind::SubAgent
    } else {
        ToolKind::Other
    }
}

fn compact_json(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn grep_matches(success: &Value) -> Vec<SearchMatch> {
    let mut matches = Vec::new();
    let Some(results) = success.get("workspaceResults").and_then(Value::as_object) else {
        return matches;
    };
    for result in results.values() {
        let files = result
            .get("content")
            .and_then(|content| content.get("matches"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for file in files {
            let path = str_at(file, "file");
            for hit in file
                .get("matches")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                matches.push(SearchMatch {
                    path: path.to_string(),
                    line: hit
                        .get("lineNumber")
                        .and_then(Value::as_u64)
                        .map(|line| line as u32),
                    preview: clip(str_at(hit, "content"), 200),
                });
            }
        }
    }
    matches
}

/// Holds Cursor's global default model steady across print runs.
///
/// Every run records its `--model` as the CLI's default in
/// `~/.cursor/cli-config.json`, which would change what a bare `cursor-agent`
/// or the IDE picks next. The first concurrent turn snapshots the keys; the
/// last one to finish writes them back.
struct GlobalModelGuard;

#[derive(Default)]
struct GuardState {
    active: usize,
    saved: Option<Map<String, Value>>,
}

static GUARD: LazyLock<std::sync::Mutex<GuardState>> =
    LazyLock::new(|| std::sync::Mutex::new(GuardState::default()));

fn cli_config_path() -> Option<PathBuf> {
    crate::config::home_dir()
        .map(|home| crate::guest_paths::guest_path(&home.join(".cursor").join("cli-config.json")))
}

impl GlobalModelGuard {
    fn enter() -> Self {
        let mut state = GUARD.lock().expect("never poisoned");
        if state.active == 0 {
            state.saved = cli_config_path().and_then(|path| snapshot_model_keys(&path));
        }
        state.active += 1;
        GlobalModelGuard
    }
}

impl Drop for GlobalModelGuard {
    fn drop(&mut self) {
        let mut state = GUARD.lock().expect("never poisoned");
        state.active = state.active.saturating_sub(1);
        if state.active > 0 {
            return;
        }
        let (Some(saved), Some(path)) = (state.saved.take(), cli_config_path()) else {
            return;
        };
        if let Err(error) = restore_model_keys(&path, &saved) {
            tracing::warn!(%error, "could not restore Cursor's default model");
        }
    }
}

fn snapshot_model_keys(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    let config: Value = serde_json::from_str(&text).ok()?;
    let config = config.as_object()?;
    Some(
        GLOBAL_MODEL_KEYS
            .iter()
            .filter_map(|key| Some((key.to_string(), config.get(*key)?.clone())))
            .collect(),
    )
}

fn restore_model_keys(path: &Path, saved: &Map<String, Value>) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut config: Value = serde_json::from_str(&text)?;
    let object = config
        .as_object_mut()
        .ok_or_else(|| anyhow!("cli-config.json is not an object"))?;
    let mut changed = false;
    for key in GLOBAL_MODEL_KEYS {
        let before = object.get(*key).cloned();
        match saved.get(*key) {
            Some(value) => {
                object.insert(key.to_string(), value.clone());
            }
            None => {
                object.remove(*key);
            }
        }
        changed |= object.get(*key).cloned() != before;
    }
    if !changed {
        return Ok(());
    }
    let temp = path.with_extension("json.genehub-tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(&config)?)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

/// The `--model` slug for a picker selection: base model, effort and Fast.
///
/// Slugs are only ever taken from `--list-models`; the bracket form Cursor's
/// ACP prints is refused by print mode. A missing effort picks the model's
/// middle level, and a Fast choice the model lacks at that level falls back to
/// the plain slug rather than failing the turn.
pub(crate) fn launch_slug(
    model_id: &str,
    effort_id: Option<&str>,
    fast: bool,
    listed: &[ModelInfo],
) -> Option<String> {
    let id = model_id.trim();
    if id.is_empty() {
        return None;
    }
    let bases = base_aliases(id);
    let family: Vec<(&str, Option<String>, bool)> = listed
        .iter()
        .filter_map(|model| {
            let (base, effort, is_fast) = parse_cli_model_id(&model.id);
            bases
                .contains(&base)
                .then_some((model.id.as_str(), effort, is_fast))
        })
        .collect();
    if family.is_empty() {
        return listed
            .iter()
            .any(|model| model.id == id)
            .then(|| id.to_string());
    }
    let mut efforts: Vec<String> = Vec::new();
    for (_, effort, _) in &family {
        if let Some(effort) = effort {
            if !efforts.contains(effort) {
                efforts.push(effort.clone());
            }
        }
    }
    efforts.sort_by_key(|effort| effort_rank(effort));
    let wanted = effort_id
        .map(|effort| {
            if effort == "extra-high" {
                "xhigh"
            } else {
                effort
            }
        })
        .filter(|effort| efforts.iter().any(|known| known == effort))
        .map(str::to_string)
        .or_else(|| default_effort(&efforts));
    let pick = |effort: &Option<String>, fast: bool| {
        family
            .iter()
            .find(|(_, candidate, is_fast)| candidate == effort && *is_fast == fast)
            .map(|(slug, ..)| slug.to_string())
    };
    pick(&wanted, fast)
        .or_else(|| pick(&wanted, !fast))
        .or_else(|| {
            efforts
                .iter()
                .find_map(|effort| pick(&Some(effort.clone()), fast))
        })
        .or_else(|| family.first().map(|(slug, ..)| slug.to_string()))
}

fn base_aliases(base: &str) -> Vec<String> {
    let mut aliases = vec![base.to_string()];
    match base.strip_prefix("cursor-") {
        Some(stripped) => aliases.push(stripped.to_string()),
        None => aliases.push(format!("cursor-{base}")),
    }
    aliases
}

fn default_effort(efforts: &[String]) -> Option<String> {
    ["medium", "high", "low"]
        .into_iter()
        .find(|preferred| efforts.iter().any(|effort| effort == preferred))
        .map(str::to_string)
        .or_else(|| efforts.first().cloned())
}

pub(crate) fn parse_cli_model_id(id: &str) -> (String, Option<String>, bool) {
    let mut s = id.trim();
    let mut is_fast = false;
    if let Some(rest) = s.strip_suffix("-fast") {
        is_fast = true;
        s = rest;
    }
    let has_trailing_thinking = if let Some(rest) = s.strip_suffix("-thinking") {
        s = rest;
        true
    } else {
        false
    };
    const KNOWN_EFFORTS: &[&str] = &[
        "extra-high",
        "xhigh",
        "minimal",
        "medium",
        "high",
        "none",
        "low",
        "max",
    ];
    let mut effort = None;
    for &e in KNOWN_EFFORTS {
        let suffix = format!("-{e}");
        if let Some(rest) = s.strip_suffix(&suffix) {
            let normalized_effort = if e == "extra-high" { "xhigh" } else { e };
            effort = Some(normalized_effort.to_string());
            s = rest;
            break;
        }
    }
    let mut base = s.to_string();
    if has_trailing_thinking {
        base.push_str("-thinking");
    }
    (base, effort, is_fast)
}

/// Maps a model id saved by the ACP adapter — an opaque
/// `grok-4.7[effort=high,fast=true]` or a raw CLI slug — onto this catalog's
/// base model plus the effort and Fast it implied.
pub(crate) fn resolve_legacy_cursor_model(
    raw_id: &str,
    catalog: &genehub_proto::Catalog,
) -> Option<(String, Option<String>, Option<bool>)> {
    let id = raw_id.trim();
    if id.is_empty() {
        return None;
    }
    if let Some(m) = catalog.models.iter().find(|m| m.id == id) {
        return Some((m.id.clone(), None, None));
    }

    let (opaque_base, params) = parse_opaque_model_id(id);
    let opaque_effort = params
        .iter()
        .find(|(k, _)| k == "effort" || k == "reasoning_effort")
        .map(|(_, v)| {
            if v == "extra-high" {
                "xhigh".to_string()
            } else {
                v.clone()
            }
        });
    let opaque_fast = params
        .iter()
        .find(|(k, _)| k == "fast")
        .map(|(_, v)| v == "true");

    for b in &base_aliases(opaque_base) {
        if let Some(m) = catalog.models.iter().find(|m| &m.id == b) {
            let effort = opaque_effort.filter(|e| m.efforts.contains(e));
            let fast = opaque_fast.filter(|f| !*f || m.supports_fast);
            return Some((m.id.clone(), effort, fast));
        }
    }

    let (cli_base, cli_effort, is_fast) = parse_cli_model_id(opaque_base);
    for b in &base_aliases(&cli_base) {
        if let Some(m) = catalog.models.iter().find(|m| &m.id == b) {
            let effort = opaque_effort
                .or(cli_effort.clone())
                .filter(|e| m.efforts.contains(e));
            let fast = opaque_fast
                .or(if is_fast { Some(true) } else { None })
                .filter(|f| !*f || m.supports_fast);
            return Some((m.id.clone(), effort, fast));
        }
    }

    None
}

fn effort_rank(effort: &str) -> usize {
    match effort {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" | "extra-high" => 5,
        "max" => 6,
        _ => 10,
    }
}

fn clean_model_label(raw_label: &str) -> String {
    let mut s = raw_label.replace("(default)", "");
    s = s.replace('\u{200b}', "");
    s = s
        .replace(" Low Thinking", " Thinking")
        .replace(" Medium Thinking", " Thinking")
        .replace(" Extra High Thinking", " Thinking")
        .replace(" Max Thinking", " Thinking");
    let mut parts: Vec<&str> = s.split_whitespace().collect();
    if parts.last().is_some_and(|w| w.eq_ignore_ascii_case("fast")) {
        parts.pop();
    }
    if parts.len() >= 2
        && parts[parts.len() - 2].eq_ignore_ascii_case("extra")
        && parts[parts.len() - 1].eq_ignore_ascii_case("high")
    {
        parts.pop();
        parts.pop();
    } else if let Some(last) = parts.last() {
        let l = last.to_ascii_lowercase();
        if matches!(
            l.as_str(),
            "low" | "medium" | "high" | "max" | "minimal" | "none"
        ) {
            parts.pop();
        }
    }
    let res = parts.join(" ");
    if res.is_empty() {
        raw_label.trim().to_string()
    } else {
        res
    }
}

fn group_cli_models(
    raw_models: &[ModelInfo],
    default: Option<&str>,
) -> (Vec<ModelInfo>, Option<String>) {
    struct Group {
        base_id: String,
        label: String,
        efforts: Vec<String>,
        supports_fast: bool,
    }

    let mut groups: Vec<Group> = Vec::new();
    let mut resolved_default = None;

    for raw in raw_models {
        let (base_id, effort, is_fast) = parse_cli_model_id(&raw.id);
        if let Some(d) = default {
            if raw.id == d && resolved_default.is_none() {
                resolved_default = Some(base_id.clone());
            }
        }
        let cleaned_label = clean_model_label(&raw.label);
        if let Some(existing) = groups.iter_mut().find(|g| g.base_id == base_id) {
            if is_fast {
                existing.supports_fast = true;
            }
            if let Some(e) = effort {
                if !existing.efforts.contains(&e) {
                    existing.efforts.push(e);
                }
            }
            if cleaned_label.len() < existing.label.len() && !cleaned_label.is_empty() {
                existing.label = cleaned_label;
            }
        } else {
            let mut efforts = Vec::new();
            if let Some(e) = effort {
                efforts.push(e);
            }
            groups.push(Group {
                base_id,
                label: cleaned_label,
                efforts,
                supports_fast: is_fast,
            });
        }
    }

    for group in &mut groups {
        group.efforts.sort_by_key(|e| effort_rank(e));
    }

    if resolved_default.is_none() {
        if groups.iter().any(|g| g.base_id == "auto") {
            resolved_default = Some("auto".to_string());
        } else {
            resolved_default = groups.first().map(|g| g.base_id.clone());
        }
    }

    let models = groups
        .into_iter()
        .map(|g| ModelInfo {
            id: g.base_id,
            label: g.label,
            context_window: None,
            reasoning: !g.efforts.is_empty(),
            efforts: g.efforts,
            supports_fast: g.supports_fast,
            input_modalities: None,
        })
        .collect();

    (models, resolved_default)
}

fn parse_opaque_model_id(id: &str) -> (&str, Vec<(String, String)>) {
    let Some((base, rest)) = id.split_once('[') else {
        return (id, Vec::new());
    };
    let params = rest
        .strip_suffix(']')
        .unwrap_or(rest)
        .split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    (base.trim(), params)
}

pub(crate) fn models_from_cli_list(text: &str) -> (Vec<ModelInfo>, Option<String>) {
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
            supports_fast: id.ends_with("-fast"),
            input_modalities: None,
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

pub(crate) async fn list_raw_models_from_cli(
    program: &Path,
) -> Option<(Vec<ModelInfo>, Option<String>)> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn listed() -> Vec<ModelInfo> {
        models_from_cli_list(
            "auto - Auto (default)\n\
             cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast\n\
             cursor-grok-4.6-high - Cursor Grok 4.6\n\
             grok-4.7-low - Grok 4.7 Low\n\
             grok-4.7-low-fast - Grok 4.7 Low Fast\n\
             grok-4.7-medium - Grok 4.7 Medium\n\
             grok-4.7-medium-fast - Grok 4.7 Medium Fast\n\
             grok-4.7-high-fast - Grok 4.7 High Fast\n\
             gpt-5.5-extra-high - GPT-5.5 Extra High\n\
             gpt-5.5-medium - GPT-5.5 Medium\n\
             composer-2.5 - Composer 2.5\n\
             composer-2.5-fast - Composer 2.5 Fast\n",
        )
        .0
    }

    #[test]
    fn launch_slug_names_the_exact_listed_variant() {
        let listed = listed();
        let slug = |model, effort, fast| launch_slug(model, effort, fast, &listed);
        assert_eq!(
            slug("grok-4.7", Some("low"), true).as_deref(),
            Some("grok-4.7-low-fast")
        );
        assert_eq!(
            slug("grok-4.7", Some("low"), false).as_deref(),
            Some("grok-4.7-low")
        );
        assert_eq!(
            slug("grok-4.7", None, false).as_deref(),
            Some("grok-4.7-medium")
        );
        assert_eq!(
            slug("grok-4.7", None, true).as_deref(),
            Some("grok-4.7-medium-fast")
        );
        assert_eq!(
            slug("grok-4.7", Some("high"), false).as_deref(),
            Some("grok-4.7-high-fast"),
            "a level that only exists as Fast still runs that level"
        );
        assert_eq!(
            slug("gpt-5.5", Some("xhigh"), false).as_deref(),
            Some("gpt-5.5-extra-high")
        );
        assert_eq!(
            slug("gpt-5.5", Some("extra-high"), false).as_deref(),
            Some("gpt-5.5-extra-high")
        );
        assert_eq!(
            slug("grok-4.6", Some("high"), true).as_deref(),
            Some("cursor-grok-4.6-high-fast")
        );
        assert_eq!(
            slug("composer-2.5", None, true).as_deref(),
            Some("composer-2.5-fast")
        );
        assert_eq!(
            slug("composer-2.5", None, false).as_deref(),
            Some("composer-2.5")
        );
        assert_eq!(slug("auto", None, false).as_deref(), Some("auto"));
        assert_eq!(
            slug("grok-4.7-low-fast", None, false).as_deref(),
            Some("grok-4.7-low-fast"),
            "a raw listed slug passes through"
        );
        assert_eq!(slug("grok-4.7[effort=high,fast=true]", None, false), None);
        assert_eq!(launch_slug("grok-4.7", Some("low"), true, &[]), None);
    }

    #[test]
    fn print_args_pin_model_resume_and_read_only_modes() {
        let args = print_args(Some("grok-4.7-low-fast"), Some("chat-1"), Some("plan"));
        let joined = args.join(" ");
        assert!(joined.starts_with("--print --output-format stream-json --stream-partial-output"));
        assert!(joined.contains("--model grok-4.7-low-fast"));
        assert!(joined.contains("--resume chat-1"));
        assert!(joined.ends_with("--mode plan"));
        let bare = print_args(None, None, Some("agent")).join(" ");
        assert!(!bare.contains("--model"));
        assert!(!bare.contains("--resume"));
        assert!(!bare.contains("--mode"));
    }

    #[test]
    fn group_cli_models_groups_efforts_and_fast() {
        let (raw, default) = models_from_cli_list(
            "Available models\n\n\
             auto - Auto (default)\n\
             grok-4.7-low - Grok 4.7  Low\n\
             grok-4.7-low-fast - Grok 4.7  Low Fast\n\
             grok-4.7-medium - Grok 4.7  Medium\n\
             grok-4.7-medium-fast - Grok 4.7  Medium Fast\n\
             composer-2.5 - Composer 2.5\n\
             composer-2.5-fast - Composer 2.5 Fast\n",
        );
        let (grouped, def) = group_cli_models(&raw, default.as_deref());
        assert_eq!(def.as_deref(), Some("auto"));
        let grok = grouped
            .iter()
            .find(|m| m.id == "grok-4.7")
            .expect("grok-4.7 found");
        assert_eq!(grok.label, "Grok 4.7");
        assert!(grok.supports_fast);
        assert!(grok.reasoning);
        assert_eq!(grok.efforts, vec!["low", "medium"]);

        let composer = grouped
            .iter()
            .find(|m| m.id == "composer-2.5")
            .expect("composer found");
        assert_eq!(composer.label, "Composer 2.5");
        assert!(composer.supports_fast);
        assert!(!composer.reasoning);
        assert!(composer.efforts.is_empty());
    }

    #[test]
    fn parse_cli_model_id_handles_thinking_and_fast() {
        assert_eq!(
            parse_cli_model_id("grok-4.7-medium-fast"),
            ("grok-4.7".into(), Some("medium".into()), true)
        );
        assert_eq!(
            parse_cli_model_id("cursor-grok-4.6-high"),
            ("cursor-grok-4.6".into(), Some("high".into()), false)
        );
        assert_eq!(
            parse_cli_model_id("claude-4.6-sonnet-medium-thinking-fast"),
            (
                "claude-4.6-sonnet-thinking".into(),
                Some("medium".into()),
                true
            )
        );
        assert_eq!(
            parse_cli_model_id("composer-2.5-fast"),
            ("composer-2.5".into(), None, true)
        );
    }

    #[test]
    fn resolve_legacy_cursor_model_maps_both_opaque_and_raw_ids() {
        let catalog = genehub_proto::Catalog {
            models: vec![
                ModelInfo {
                    id: "grok-4.7".into(),
                    label: "Grok 4.7".into(),
                    context_window: None,
                    reasoning: true,
                    efforts: vec!["low".into(), "medium".into(), "high".into()],
                    supports_fast: true,
                    input_modalities: None,
                },
                ModelInfo {
                    id: "cursor-grok-4.6".into(),
                    label: "Cursor Grok 4.6".into(),
                    context_window: None,
                    reasoning: true,
                    efforts: vec!["high".into()],
                    supports_fast: true,
                    input_modalities: None,
                },
            ],
            modes: vec![],
            commands: vec![],
            runtime_axes: None,
            default_model: Some("auto".into()),
            default_mode: None,
            default_effort: Some("medium".into()),
        };

        assert_eq!(
            resolve_legacy_cursor_model("grok-4.7", &catalog),
            Some(("grok-4.7".into(), None, None))
        );
        assert_eq!(
            resolve_legacy_cursor_model("grok-4.7[effort=high,fast=true]", &catalog),
            Some(("grok-4.7".into(), Some("high".into()), Some(true)))
        );
        assert_eq!(
            resolve_legacy_cursor_model(
                "grok-4.7[context=256k,reasoning_effort=high,fast=true]",
                &catalog
            ),
            Some(("grok-4.7".into(), Some("high".into()), Some(true)))
        );
        assert_eq!(
            resolve_legacy_cursor_model("cursor-grok-4.6-high-fast", &catalog),
            Some(("cursor-grok-4.6".into(), Some("high".into()), Some(true)))
        );
        assert_eq!(
            resolve_legacy_cursor_model("nonexistent-model", &catalog),
            None
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

    fn drain(rx: &mut broadcast::Receiver<SessionEvent>) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            out.push(event);
        }
        out
    }

    fn running_turn() -> TurnState {
        TurnState {
            id: Some("turn_1".into()),
            ..TurnState::default()
        }
    }

    #[test]
    fn stream_json_deltas_become_one_item_each_and_the_recap_is_skipped() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = running_turn();
        let lines = [
            json!({"type":"system","subtype":"init","session_id":"chat-9","model":"Grok 4.7 Low Fast"}),
            json!({"type":"thinking","subtype":"delta","text":"plan","session_id":"chat-9","timestamp_ms":1}),
            json!({"type":"thinking","subtype":"completed","session_id":"chat-9","timestamp_ms":2}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]},"session_id":"chat-9","timestamp_ms":3}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"lo"}]},"session_id":"chat-9","timestamp_ms":4}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"chat-9"}),
            json!({"type":"result","subtype":"success","is_error":false,"result":"Hello","session_id":"chat-9","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":5,"cacheWriteTokens":0}}),
        ];
        let mut chat = None;
        for line in &lines {
            chat = translate_event(line, &mut state, &tx).or(chat);
        }
        assert_eq!(chat.as_deref(), Some("chat-9"));
        assert_eq!(state.partial, "Hello");
        assert!(matches!(state.outcome, Some(Outcome::Success(Some(_)))));
        let items: Vec<_> = drain(&mut rx)
            .into_iter()
            .filter_map(|event| match event {
                SessionEvent::Item { item, .. } => Some(item),
                _ => None,
            })
            .collect();
        assert_eq!(items.len(), 2, "one reasoning item and one message item");
        assert!(matches!(&items[0], TimelineItem::Reasoning { text, .. } if text == "plan"));
        assert!(matches!(&items[1], TimelineItem::AssistantMessage { text, .. } if text == "Hel"));
    }

    #[test]
    fn tool_calls_map_to_typed_details_and_todos() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = running_turn();
        let shell_done = json!({"type":"tool_call","subtype":"completed","call_id":"call-1\nfc_1",
            "tool_call":{"shellToolCall":{"args":{"command":"ls"},
            "result":{"success":{"exitCode":0,"stdout":"a.txt\n","stderr":""}}}},"timestamp_ms":1});
        let grep_done = json!({"type":"tool_call","subtype":"completed","call_id":"call-2",
            "tool_call":{"grepToolCall":{"args":{"pattern":"beta","path":"/w"},
            "result":{"success":{"workspaceResults":{"/w":{"content":{"matches":[
                {"file":"notes.txt","matches":[{"lineNumber":2,"content":"beta"}]}]}}}}}}},"timestamp_ms":2});
        let read_failed = json!({"type":"tool_call","subtype":"completed","call_id":"call-3",
            "tool_call":{"readToolCall":{"args":{"path":"/w/missing"},
            "result":{"error":{"message":"not found"}}}},"timestamp_ms":3});
        let todos = json!({"type":"tool_call","subtype":"started","call_id":"call-4",
            "tool_call":{"updateTodosToolCall":{"args":{"todos":[
                {"id":"1","content":"First","status":"TODO_STATUS_COMPLETED"},
                {"id":"2","content":"Second","status":"TODO_STATUS_PENDING"}]}}},"timestamp_ms":4});
        for line in [&shell_done, &grep_done, &read_failed, &todos] {
            translate_event(line, &mut state, &tx);
        }
        let items: Vec<_> = drain(&mut rx)
            .into_iter()
            .filter_map(|event| match event {
                SessionEvent::Item { item, .. } => Some(item),
                _ => None,
            })
            .collect();
        match &items[0] {
            TimelineItem::ToolCall {
                id, status, detail, ..
            } => {
                assert_eq!(id, "call-1:fc_1");
                assert_eq!(*status, ToolStatus::Ok);
                assert!(
                    matches!(detail, ToolCallDetail::Shell { command, exit_code: Some(0), output } if command == "ls" && output == "a.txt\n")
                );
            }
            other => panic!("expected shell tool call, got {other:?}"),
        }
        match &items[1] {
            TimelineItem::ToolCall {
                detail: ToolCallDetail::Search { query, matches },
                ..
            } => {
                assert_eq!(query, "beta");
                assert_eq!(matches[0].path, "notes.txt");
                assert_eq!(matches[0].line, Some(2));
            }
            other => panic!("expected grep search, got {other:?}"),
        }
        match &items[2] {
            TimelineItem::ToolCall {
                status,
                detail: ToolCallDetail::Read { content, .. },
                ..
            } => {
                assert_eq!(*status, ToolStatus::Error);
                assert!(content.contains("not found"));
            }
            other => panic!("expected failed read, got {other:?}"),
        }
        match &items[3] {
            TimelineItem::Todo { items, .. } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].status, TodoStatus::Completed);
            }
            other => panic!("expected todo list, got {other:?}"),
        }
    }

    #[test]
    fn an_error_result_fails_the_turn_with_cursors_message() {
        let (tx, _rx) = broadcast::channel(8);
        let mut state = running_turn();
        translate_event(
            &json!({"type":"result","subtype":"error","is_error":true,"result":"model unavailable"}),
            &mut state,
            &tx,
        );
        assert_eq!(
            state.outcome,
            Some(Outcome::Error("model unavailable".into()))
        );
    }

    #[test]
    fn the_interrupted_note_carries_the_request_and_the_partial_reply() {
        let note = interrupted_note("refactor the parser", "I started by");
        assert!(note.contains("refactor the parser"));
        assert!(note.contains("I started by"));
        let bare = interrupted_note("just this", "  ");
        assert!(!bare.contains("partial reply"));
    }

    #[test]
    fn global_model_keys_are_restored_and_other_keys_kept() {
        let dir = std::env::temp_dir().join(format!("cursor-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli-config.json");
        std::fs::write(
            &path,
            r#"{"model":{"modelId":"grok-4.7"},"selectedModel":{"modelId":"grok-4.7"},"theme":"dark"}"#,
        )
        .unwrap();
        let saved = snapshot_model_keys(&path).expect("snapshot");
        std::fs::write(
            &path,
            r#"{"model":{"modelId":"gpt-5.5"},"selectedModel":{"modelId":"gpt-5.5"},"theme":"light"}"#,
        )
        .unwrap();
        restore_model_keys(&path, &saved).unwrap();
        let restored: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(restored["model"]["modelId"], "grok-4.7");
        assert_eq!(restored["selectedModel"]["modelId"], "grok-4.7");
        assert_eq!(
            restored["theme"], "light",
            "only the model keys are ours to restore"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_print_chat_handles_are_resumable() {
        let adapter = CursorAdapter::new(
            "cursor",
            "Cursor",
            vec!["cursor-agent".into(), "acp".into()],
            Vec::new(),
        );
        let handle = |value| PersistHandle {
            agent_id: "cursor".into(),
            value,
        };
        assert!(adapter.accepts_resume(&handle(json!({"chatId": "c1"}))));
        assert!(!adapter.accepts_resume(&handle(json!({"sessionId": "s1"}))));
        assert!(!adapter.accepts_resume(&handle(json!({"chatId": ""}))));
    }
}
