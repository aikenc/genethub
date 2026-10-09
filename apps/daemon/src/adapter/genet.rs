//! Adapter for the built-in agent: child process, JSONL frames over stdio.
//!
//! All knowledge of that agent's wire format is confined to this file. The
//! translation to `SessionEvent` happens here so nothing above the adapter
//! layer ever sees an agent-shaped frame.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::os_process::{Child, ChildStdin, Command};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Attachment, Capabilities, Catalog, CommandInfo, InteractionOption, InteractionQuestion,
    ItemDelta, ModelInfo, PermissionOutcome, PermissionRequest, PermissionRequestKind, ProbeState,
    SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, Mutex};

use super::stdio::write_json_line;
use super::usage;
use super::{
    find_executable, AgentAdapter, AgentSession, Chatter, PromptInput, ProviderMap, SessionConfig,
};
use crate::config::ProviderConfig;

const BINARY: &str = crate::channel::AGENT_BINARY;

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
        // The daemon is a WASI guest, where `current_exe()` is unsupported.
        // The native host already supplies the exact front-door CLI path, so
        // use its install directory for the legacy sibling-agent lookup too.
        // If no front door was bound, PATH discovery below remains available;
        // never invent a channel-specific executable name here.
        let beside = std::env::var_os(crate::channel::ENV_CLI)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .and_then(|cli| cli.parent().map(std::path::Path::to_path_buf));
        Self::discover_beside(beside)
    }

    /// `beside` is where the daemon itself lives, taken as an argument so a test
    /// can point it at a directory it controls.
    fn discover_beside(beside: Option<PathBuf>) -> Self {
        // Next to the daemon first: that is where the installer puts it, and it
        // must win over any unrelated binary of the same name on PATH.
        let sibling = beside
            .map(|dir| dir.join(agent_file_name(cfg!(windows))))
            .filter(|path| path.is_file());
        let binary = std::env::var(crate::channel::ENV_AGENT_COMMAND)
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
        crate::channel::AGENT_LABEL
    }

    fn builtin(&self) -> bool {
        true
    }

    fn supports_evidence_scope(&self) -> bool {
        true
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            interrupt: true,
            set_model: true,
            // Thinking level, which is this agent's only such dial. It used to be
            // declared as a *mode*, which put it on the same axis as Claude's
            // tool-approval policy — one chip meaning two unrelated things
            // depending on which agent you were talking to.
            set_effort: true,
            set_fast: false,
            // No permission modes: it has no approval flow to have policy about.
            set_mode: false,
            // Structured user questions are durable stopped interactions. A
            // daemon-authored plan challenge may be rendered as PlanApproval,
            // but never elevates this Agent's permission mode.
            permissions: true,
            resume: true,
            fork: false,
            attachments: true,
        }
    }

    fn host_form_payloads(&self) -> bool {
        // The v2 agent is the component's own agent-serve entry, spawned as a
        // wasm child that shares this daemon's preopen namespace — guest paths
        // are the only spelling it understands. Only the legacy branch, a
        // native binary beside the daemon, needs host-form payloads.
        self.binary.is_some()
    }

    async fn probe(&self) -> ProbeState {
        match &self.binary {
            Some(_) => ProbeState::Ready,
            // v2: no agent binary is needed when the front door can serve the
            // component's agent entry (`$GENEHUB_CLI agent-serve`).
            None => match std::env::var("GENEHUB_CLI") {
                Ok(value) if !value.is_empty() => ProbeState::Ready,
                _ => ProbeState::NotInstalled,
            },
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
                // Every model, because the level is applied by the agent rather
                // than asked of the provider.
                efforts: THINKING_LEVELS.iter().map(|l| (*l).to_string()).collect(),
                input_modalities: Some(model.input_modalities),
                supports_fast: false,
            })
            .collect();
        Catalog {
            runtime_axes: None,
            commands: vec![
                CommandInfo {
                    name: "skill:genehub-introspect".into(),
                    description: Some(
                        "Load the read-only GeneHub introspection SOP (session history analysis)".into(),
                    ),
                    argument_hint: Some("[analysis goal]".into()),
                },
                CommandInfo {
                    name: "skill:genehub-preview".into(),
                    description: Some(
                        "Load the GeneHub Asset Preview contract (static HTML / H5 and live service previews)".into(),
                    ),
                    argument_hint: Some("[preview goal]".into()),
                },
                CommandInfo {
                    name: "compact".into(),
                    description: Some(
                        "Compact this session in a private, non-recorded analysis run".into(),
                    ),
                    argument_hint: None,
                },
            ],
            default_model: models.first().map(|m| m.id.clone()),
            models,
            modes: Vec::new(),
            default_mode: None,
            default_effort: Some("medium".to_string()),
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let home = config.scratch_dir.join("genet");
        // Uploaded chat videos live at a workspace-relative artifact path even
        // when the session's working directory is a nested project folder.
        let workspace_root = config
            .scratch_dir
            .ancestors()
            .nth(4)
            .ok_or_else(|| anyhow!("invalid GeneHub session scratch directory"))?;
        std::fs::create_dir_all(&home).context("creating the agent scratch directory")?;
        write_models_file(&home, &config.providers)?;

        let session_file = home.join("session.jsonl");
        // §6.2: a process the platform did not stop left word of how it went,
        // for the one that resumes the conversation. Read once, then gone.
        let exit_note_file = home.join(EXIT_NOTE_FILE);
        let exit_note = std::fs::read_to_string(&exit_note_file)
            .ok()
            .filter(|note| !note.trim().is_empty());
        let _ = std::fs::remove_file(&exit_note_file);
        let legacy_native = self.binary.is_some();
        let (mut command, describe) = match self.binary.clone() {
            Some(binary) => (Command::new(&binary), binary.display().to_string()),
            // v2: the agent is the `agent-run` entry of the same component the
            // daemon runs from, reached through the front door — the shell
            // injected GENEHUB_CLI, and `agent-serve` there becomes the agent.
            None => {
                let cli = std::env::var("GENEHUB_CLI")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        anyhow!(
                            "the built-in agent is not available: no agent binary beside the daemon and GENEHUB_CLI is unset"
                        )
                    })?;
                let mut command = Command::new(&cli);
                command.arg("agent-serve");
                (command, format!("{cli} agent-serve"))
            }
        };
        // The host's spawn import translates only argv[0]; a native agent
        // binary receives --session verbatim, so on a Windows host it needs
        // the host spelling. The wasm child shares our preopens and takes the
        // guest path as-is.
        let session_arg = if legacy_native {
            crate::guest_paths::host_path(&session_file)
        } else {
            session_file.clone()
        };
        // argv is what `ps aux | grep` matches against, and a system prompt
        // there makes the agent match almost any pattern its own commands
        // grep for (proposal §6.1). The session path, the session id and the
        // added prompts go in the first stdin line instead; argv keeps only
        // the mode, the model and the thinking level.
        command
            .arg("--mode")
            .arg("rpc")
            .arg("--configure-from-stdin")
            .current_dir(&config.cwd)
            .env(crate::channel::ENV_AGENT_HOME, &home)
            .env("GENET_WORKSPACE_ROOT", workspace_root);
        super::apply_session_environment(&mut command, &config);
        command.env_remove("GENEHUB_EVIDENCE_SCOPE");
        if let Some(scope) = &config.evidence_scope {
            command.env("GENEHUB_EVIDENCE_SCOPE", serde_json::to_string(scope)?);
        }

        if let Some(dir) = &config.skills_dir {
            command.env("GENEHUB_SKILLS_DIR", dir);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::owned_child(&mut command);

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
        // `mode_id` as the fallback: sessions from before thinking moved onto its
        // own axis recorded the level there, and reopening one should not quietly
        // drop back to the default.
        if let Some(level) = config.effort_id.as_ref().or(config.mode_id.as_ref()) {
            command.arg("--thinking").arg(level);
        }
        let configure = configure_command(&session_arg, &config);

        let mut child = command
            .spawn()
            .with_context(|| format!("spawning {describe}"))?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut stdin = child.stdin.take().expect("stdin was piped");
        write_json_line(&mut stdin, &configure)
            .await
            .with_context(|| format!("configuring {describe}"))?;

        let child = Arc::new(Mutex::new(Some(child)));
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let turn = Arc::new(Mutex::new(TurnState::default()));

        // stderr is kept as well as drained: a full pipe would block the process,
        // and what it wrote on the way out is the only account of why it left.
        let said = Arc::new(Chatter::default());
        said.watch("genet-agent", Some(stderr)).await;

        let closing = Arc::new(AtomicBool::new(false));
        let replies = Replies::default();
        let session = GenetSession {
            tasks: super::SessionTasks::default(),
            stdin: Mutex::new(stdin),
            events: events.clone(),
            turn: turn.clone(),
            child: child.clone(),
            said: said.clone(),
            session_file,
            closing: closing.clone(),
            exit_note: Mutex::new(exit_note),
            replies: replies.clone(),
        };

        session.tasks.spawn(translate_stream(
            stdout,
            events,
            turn,
            replies,
            child,
            said,
            Exit {
                closing,
                note_file: exit_note_file,
            },
        ));

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
    assistant_in_flight: bool,
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

/// The launch settings the agent reads before anything else under
/// `--configure-from-stdin`.
fn configure_command(session: &Path, config: &SessionConfig) -> Value {
    let prompts: Vec<&str> = config
        .additional_system_prompt
        .as_deref()
        .filter(|prompt| !prompt.trim().is_empty())
        .into_iter()
        .collect();
    json!({
        "type": "configure",
        "session": session.to_string_lossy(),
        "genehubSessionId": config.session_id,
        "systemPrompts": prompts,
    })
}

struct GenetSession {
    tasks: super::SessionTasks,
    stdin: Mutex<ChildStdin>,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    /// Shared with the stream reader, which needs the exit code to explain a crash.
    child: Arc<Mutex<Option<Child>>>,
    /// What the agent said, for a prompt that cannot be written because it is gone.
    said: Arc<Chatter>,
    session_file: PathBuf,
    /// Set before the platform itself stops the process, so the exit that
    /// follows is read as the stop it is and not as a crash.
    closing: Arc<AtomicBool>,
    /// Left by the process before this one, for the next prompt to carry.
    exit_note: Mutex<Option<String>>,
    /// Control commands awaiting their `response` frame, by request id.
    replies: Replies,
}

type Replies = Arc<std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>>;

/// How long a steer waits for the agent to say whether it took the message.
/// The agent answers from its command loop, never from inside a model call.
const STEER_REPLY_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// Beside `session.jsonl`, so it follows the conversation across processes.
const EXIT_NOTE_FILE: &str = "exit-note.txt";

/// What the stream reader needs to tell a crash from a stop, and where to
/// leave word of a crash.
struct Exit {
    closing: Arc<AtomicBool>,
    note_file: PathBuf,
}

/// The note the next process reads first, after one was killed by a signal it
/// was not sent by us. Plain facts and the rule that would have prevented
/// fb_IXUzjtBuA4wt; the user's own text follows it unchanged.
fn exit_note(why: &str) -> String {
    format!(
        "<genehub_notice>上一个 Agent 进程没有正常结束：{why}。这不是平台发起的停止。\
如果当时在执行 kill/pkill/killall，很可能误杀了 Agent 自己：结束进程前先排除 $GENEHUB_AGENT_PID、$GENEHUB_HOST_PID 及其祖先进程，按 PID 文件或端口定位目标，不要用宽泛的 grep | kill。\
继续之前，先确认上一轮未完成的操作做到了哪一步。</genehub_notice>\n\n"
    )
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
        let command = if input.text.trim() == "/compact" && input.attachments.is_empty() {
            json!({
                "id": turn_id,
                "type": "compact",
            })
        } else {
            // A slash command has to stay first to be one; the note waits for
            // a message it can sit in front of.
            let note = if input.text.trim_start().starts_with('/') {
                None
            } else {
                self.exit_note.lock().await.take()
            };
            json!({
                "id": turn_id,
                "type": "prompt",
                "message": format!("{}{}", note.unwrap_or_default(), input.text),
                "attachments": input.attachments,
            })
        };
        if let Err(broken) = self.command(command).await {
            let why = super::stopped(crate::channel::AGENT_LABEL, &self.child, &self.said).await;
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

    async fn steer(&self, text: &str, attachments: &[Attachment]) -> Result<bool> {
        {
            let turn = self.turn.lock().await;
            if turn.id.is_none() || turn.canceled {
                return Ok(false);
            }
        }
        let id = format!("steer_{}", uuid::Uuid::new_v4().simple());
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Registered before the write: the reply can beat this task back.
        self.replies
            .lock()
            .expect("replies poisoned")
            .insert(id.clone(), tx);
        let written = self
            .command(json!({
                "id": id,
                "type": "steer",
                "message": text,
                "attachments": attachments,
            }))
            .await;
        if let Err(error) = written {
            self.replies.lock().expect("replies poisoned").remove(&id);
            return Err(error);
        }
        let reply = tokio::time::timeout(STEER_REPLY_BUDGET, rx).await;
        self.replies.lock().expect("replies poisoned").remove(&id);
        match reply {
            // A refusal is the ordinary race with the turn's own end.
            Ok(Ok(frame)) => Ok(frame.get("success").and_then(Value::as_bool) == Some(true)),
            Ok(Err(_)) => Err(anyhow!(
                "{} exited before answering",
                crate::channel::AGENT_LABEL
            )),
            Err(_) => Err(anyhow!(
                "{} did not answer the steer within {}s",
                crate::channel::AGENT_LABEL,
                STEER_REPLY_BUDGET.as_secs()
            )),
        }
    }

    async fn close(&self) -> Result<()> {
        // Tools own separate process groups. Killing only the Agent's group
        // first can orphan them; its abort protocol drops those tool futures
        // before agent_end. Keep ownership if that acknowledgement is missing.
        let mut events = self.events.subscribe();
        if self.turn.lock().await.id.is_some() {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                self.interrupt().await?;
                while self.turn.lock().await.id.is_some() {
                    match events.recv().await {
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err(anyhow!(
                                "agent stopped before confirming tool cancellation"
                            ));
                        }
                    }
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .context("agent tool cancellation is unconfirmed; cleanup can be retried")??;
        }
        // Recorded before any signal goes out: the exit it causes is ours.
        self.closing.store(true, Ordering::SeqCst);
        super::close_child(&self.child).await?;
        self.tasks.stop().await;
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
        Ok(())
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        // Kept accepting the old name so a client that still sends it — and a
        // session that stored its level under `mode` — keeps working.
        self.set_effort(mode_id).await
    }

    async fn set_effort(&self, effort_id: &str) -> Result<()> {
        if !THINKING_LEVELS.contains(&effort_id) {
            return Err(anyhow!("unknown thinking level '{effort_id}'"));
        }
        self.command(json!({ "type": "set_thinking_level", "level": effort_id }))
            .await?;
        Ok(())
    }

    async fn respond_permission(&self, _request: &str, _outcome: PermissionOutcome) -> Result<()> {
        Err(anyhow!(
            "built-in Agent interactions resume as a new turn and have no live approval channel"
        ))
    }

    fn persistence(&self) -> Option<super::PersistHandle> {
        Some(super::PersistHandle {
            agent_id: "genet".into(),
            value: json!({ "sessionFile": self.session_file }),
        })
    }
}

async fn translate_stream(
    stdout: crate::os_process::ChildStdout,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    replies: Replies,
    child: Arc<Mutex<Option<Child>>>,
    said: Arc<Chatter>,
    exit: Exit,
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
                        if let Some(waiting) = reply_waiter(&frame, &replies) {
                            let _ = waiting.send(frame);
                            continue;
                        }
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

    // Whoever waits on a reply learns the agent is gone.
    replies.lock().expect("replies poisoned").clear();

    // The process died. If a turn was in flight the client is still waiting for
    // it, so fail it explicitly rather than leaving a spinner forever — and say
    // what the process said, which is the part that can be acted on.
    let ending = super::ending(&child).await;
    if exit.closing.load(Ordering::SeqCst) {
        // The platform stopped it; there is nothing to explain.
        tracing::info!(?ending, "agent stopped by the platform");
        if let Some(turn_id) = turn.lock().await.id.take() {
            let _ = events.send(SessionEvent::TurnFailed {
                turn_id,
                error: TurnError {
                    code: TurnErrorCode::Canceled,
                    message: format!("{} 已由平台停止", crate::channel::AGENT_LABEL),
                },
            });
        }
        return;
    }
    let why = super::stopped_with(crate::channel::AGENT_LABEL, ending, &said).await;
    tracing::warn!("{why}");
    if ending.is_some_and(|ending| ending.by_signal()) {
        // The next process resumes this conversation without knowing how
        // the last one ended; the user, who saw it, should not have to say.
        let reason = ending
            .map(|e| e.describe(crate::channel::AGENT_LABEL))
            .unwrap_or_default();
        if let Err(error) = std::fs::write(&exit.note_file, exit_note(&reason)) {
            tracing::warn!(%error, "could not leave the exit note");
        }
    }
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

fn reply_waiter(frame: &Value, replies: &Replies) -> Option<tokio::sync::oneshot::Sender<Value>> {
    if frame.get("type").and_then(Value::as_str) != Some("response") {
        return None;
    }
    let id = frame.get("id")?.as_str()?;
    replies.lock().expect("replies poisoned").remove(id)
}

fn builtin_questions(frame: &Value) -> Option<Vec<InteractionQuestion>> {
    let raw = frame.get("questions")?.as_array()?;
    if !(1..=3).contains(&raw.len()) {
        return None;
    }
    raw.iter()
        .map(|question| {
            let id = question.get("id")?.as_str()?.trim();
            let prompt = question.get("question")?.as_str()?.trim();
            if id.is_empty() || prompt.is_empty() {
                return None;
            }
            let options = question
                .get("options")?
                .as_array()?
                .iter()
                .enumerate()
                .map(|(index, option)| {
                    let label = option.get("label")?.as_str()?.trim();
                    (!label.is_empty()).then(|| InteractionOption {
                        id: index.to_string(),
                        label: label.to_string(),
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            if !(1..=5).contains(&options.len()) {
                return None;
            }
            Some(InteractionQuestion {
                id: id.to_string(),
                prompt: prompt.to_string(),
                allow_multiple: false,
                allow_freeform: true,
                options,
            })
        })
        .collect()
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
            started_at_ms: 0,
        }),

        "message_start"
            if frame
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("assistant")
                && !state.assistant_in_flight =>
        {
            // The built-in Agent emits this before any reasoning/text/tool
            // item. Attribute the LLM call to that item and show the round
            // while it is still running, not only after message_end.
            state.assistant_in_flight = true;
            state.usage.llm_rounds += 1;
            usage::record_round_start(&mut state.usage);
            usage::emit_progress(events, &turn_id, &state.usage);
        }

        "user_input_requested" => {
            let Some(questions) = builtin_questions(frame) else {
                return;
            };
            let request_id = frame
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("user-input")
                .to_string();
            emit(SessionEvent::PermissionRequested {
                request: PermissionRequest {
                    id: request_id.clone(),
                    kind: PermissionRequestKind::Question,
                    title: questions[0].prompt.clone(),
                    detail: None,
                    tool_call_id: Some(request_id),
                    options: Vec::new(),
                    questions: Some(questions),
                },
            });
        }

        "text_start" => {
            let id = state.next_item_id();
            state.text_item = Some(id.clone());
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::AssistantMessage {
                    id,
                    text: String::new(),
                    received_at_ms: None,
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
                    item: TimelineItem::AssistantMessage {
                        id,
                        text,
                        received_at_ms: None,
                    },
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
                    received_at_ms: None,
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
                    images: vec![],
                    started_at_ms: None,
                    finished_at_ms: None,
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
                        images: vec![],
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
                    images: vec![],
                    started_at_ms: None,
                    finished_at_ms: None,
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
                usage::add_usage(&mut state.usage, usage);
            }
            // Older/partial streams may lack message_start; still count each
            // completed assistant response exactly once.
            if !std::mem::take(&mut state.assistant_in_flight) {
                state.usage.llm_rounds += 1;
            }
            usage::emit_progress(events, &turn_id, &state.usage);
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
            // pi semantics: an aborted archive replaced nothing and the run
            // settles as cancelled; a failed one surfaces its error; one that
            // will replay the request supersedes the overflow that caused it.
            if frame.get("aborted").and_then(Value::as_bool) == Some(true) {
                state.canceled = true;
                return;
            }
            if let Some(error) = frame.get("errorMessage").and_then(Value::as_str) {
                let id = state.next_item_id();
                emit(SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::Error {
                        id,
                        message: error.to_string(),
                    },
                });
                state.failure.get_or_insert_with(|| classify_failure(error));
                return;
            }
            if frame.get("willRetry").and_then(Value::as_bool) == Some(true) {
                state.failure = None;
            }
            let id = state.next_item_id();
            let reason = frame
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .to_string();
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Compaction {
                    id,
                    reason,
                    received_at_ms: None,
                },
            });
        }

        // The agent backs off and replays the request: the failure that
        // triggered it is not the turn's outcome unless the retries run out.
        "auto_retry_start" => {
            state.failure = None;
            let attempt = frame.get("attempt").and_then(Value::as_u64).unwrap_or(1);
            let max = frame
                .get("maxAttempts")
                .and_then(Value::as_u64)
                .unwrap_or(attempt);
            let delay_ms = frame.get("delayMs").and_then(Value::as_u64).unwrap_or(0);
            let cause = frame
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error");
            let id = state.next_item_id();
            emit(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Error {
                    id,
                    message: format!(
                        "模型服务暂时不可用，{:.1} 秒后自动重试（第 {attempt}/{max} 次）：{cause}",
                        delay_ms as f64 / 1000.0
                    ),
                },
            });
        }

        "auto_retry_end" => {
            if frame.get("success").and_then(Value::as_bool) == Some(true) {
                return;
            }
            match frame.get("finalError").and_then(Value::as_str) {
                Some("Retry cancelled") => {
                    state.failure = None;
                    state.canceled = true;
                }
                Some(error) => {
                    state.failure = Some(classify_failure(error));
                }
                None => {}
            }
        }

        "agent_end" => {
            let usage = std::mem::take(&mut state.usage);
            let failure = state.failure.take();
            let canceled = state.canceled;
            state.id = None;
            state.calls.clear();
            state.text_item = None;
            state.reasoning_item = None;
            state.assistant_in_flight = false;
            state.canceled = false;

            if let Some(error) = failure {
                emit(SessionEvent::TurnFailed { turn_id, error });
            } else if canceled {
                emit(SessionEvent::TurnCanceled { turn_id });
            } else {
                emit(SessionEvent::TurnCompleted {
                    turn_id,
                    usage,
                    fork_checkpoint: None,
                });
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
    input_modalities: Vec<String>,
    thinking_mode: Option<String>,
    efforts: Vec<String>,
    compat: genehub_proto::ModelCompat,
    /// Which layer each value came from (`crate::capabilities`), so a wrong
    /// guess in models.json can be traced without the settings page.
    sources: std::collections::BTreeMap<String, String>,
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
            let resolved = crate::capabilities::resolve(provider, config, id);
            let caps = resolved.caps;
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
                // Discovery, endpoint rules and the user, merged; unknown
                // stays unknown rather than being claimed.
                context_window: caps.context_window,
                max_tokens: caps.max_tokens,
                reasoning: caps.reasoning.unwrap_or(false),
                input_modalities: caps.inputs.unwrap_or_default(),
                thinking_mode: caps.thinking,
                efforts: caps.efforts.unwrap_or_default(),
                compat: caps.compat.unwrap_or_default(),
                sources: resolved.sources,
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
                "inputModalities": model.input_modalities,
                "thinkingMode": model.thinking_mode,
                "thinkingEfforts": model.efforts,
                "compat": model.compat,
                "capabilitySources": model.sources,
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
        assert_eq!(agent_file_name(true), format!("{}.exe", BINARY));
        assert_eq!(agent_file_name(false), BINARY);
    }

    /// And the bundle has to stage what the runtime looks for, which lives
    /// in a script this test reads rather than trusts. The script takes
    /// the names from `scripts/channel.env` — written by `scripts/channel.mjs`
    /// from the same table as `BINARY` above — so the pin here is that the
    /// staging loop consumes them. v2: the agent is an entry of the guest
    /// component, so what the bundle must stage next to the CLI is the wasm
    /// shell and the component, not a native agent binary.
    #[test]
    fn the_installer_stages_the_shell_and_the_component() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop/scripts/bundle.mjs"),
        )
        .expect("the bundling script");
        assert!(
            script.contains("[CLI_BINARY, HOST_BINARY]"),
            "the installer no longer stages the wasm shell under its stamped name"
        );
        assert!(
            script.contains("join(binDir, COMPONENT_FILE)"),
            "the installer no longer stages the guest component"
        );
        assert!(
            script.contains("scripts/channel.env"),
            "the bundling script names the binaries itself again instead of \
             reading the channel's names"
        );
        assert!(
            script.contains("binary + exe"),
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

    /// `steer` is the one command whose answer the daemon waits for: the
    /// reply frame is matched back by id, and a refusal reads as "not taken".
    #[cfg(unix)]
    #[tokio::test]
    async fn a_steer_waits_for_the_agents_answer() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("fake-agent");
        std::fs::write(
            &agent,
            "#!/bin/sh\nIFS= read -r configure\nwhile IFS= read -r line; do\n  case \"$line\" in\n    *'\"type\":\"steer\"'*)\n      id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\"\\(steer_[0-9a-f]*\\)\".*/\\1/p')\n      case \"$line\" in\n        *refuse*) ok=false ;;\n        *) ok=true ;;\n      esac\n      printf '{\"type\":\"response\",\"command\":\"steer\",\"id\":\"%s\",\"success\":%s}\\n' \"$id\" \"$ok\" ;;\n    *'\"type\":\"abort\"'*)\n      printf '{\"type\":\"agent_end\",\"messages\":[]}\\n' ;;\n  esac\ndone\n",
        )
        .unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let scratch = dir.path().join("w/.genehub/sessions/s_steer/scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let session = GenetAdapter {
            binary: Some(agent),
        }
        .start(SessionConfig {
            evidence_scope: None,
            session_id: "s_steer".into(),
            cwd: dir.path().to_path_buf(),
            model_id: None,
            mode_id: None,
            effort_id: None,
            fast: None,
            runtime_values: Default::default(),
            additional_system_prompt: None,
            skills_dir: None,
            front_door_cli: None,
            controller_token: None,
            scratch_dir: scratch,
            providers: Default::default(),
            resume: None,
        })
        .await
        .expect("the agent starts");

        assert!(
            !session.steer("nothing is running", &[]).await.unwrap(),
            "no turn, nothing to steer into"
        );
        session
            .send(PromptInput {
                text: "start".into(),
                attachments: Vec::new(),
            })
            .await
            .unwrap();
        assert!(session.steer("also the docs", &[]).await.unwrap());
        assert!(!session.steer("refuse this one", &[]).await.unwrap());
        session.close().await.unwrap();
    }

    /// §6.1: the system prompt made the agent's own command line match the
    /// patterns its commands grep for, so `ps aux | grep … | kill` found the
    /// agent. What argv used to carry now arrives as the first stdin line.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_prompt_and_the_session_path_stay_off_the_command_line() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let seen = dir.path().join("seen");
        let agent = dir.path().join("fake-agent");
        std::fs::write(
            &agent,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{0}.args'\nIFS= read -r line\nprintf '%s' \"$line\" > '{0}.tmp'\nmv '{0}.tmp' '{0}.stdin'\ncat >/dev/null\n",
                seen.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let scratch = dir.path().join("w/.genehub/sessions/s_cfg/scratch");
        std::fs::create_dir_all(&scratch).unwrap();

        let adapter = GenetAdapter {
            binary: Some(agent),
        };
        let session = adapter
            .start(SessionConfig {
                evidence_scope: None,
                session_id: "s_cfg".into(),
                cwd: dir.path().to_path_buf(),
                model_id: Some("anthropic/claude".into()),
                mode_id: None,
                effort_id: Some("high".into()),
                fast: None,
                runtime_values: Default::default(),
                additional_system_prompt: Some("kill the dev server\nGeneHub rules".into()),
                skills_dir: None,
                front_door_cli: None,
                controller_token: None,
                scratch_dir: scratch.clone(),
                providers: Default::default(),
                resume: None,
            })
            .await
            .expect("the agent starts");

        let stdin_file = dir.path().join("seen.stdin");
        for _ in 0..200 {
            if stdin_file.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let args = std::fs::read_to_string(dir.path().join("seen.args")).unwrap();
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(
            args,
            [
                "--mode",
                "rpc",
                "--configure-from-stdin",
                "--model",
                "anthropic/claude",
                "--thinking",
                "high"
            ]
        );
        let configure: Value =
            serde_json::from_str(&std::fs::read_to_string(&stdin_file).unwrap()).unwrap();
        assert_eq!(configure["type"], "configure");
        assert_eq!(configure["genehubSessionId"], "s_cfg");
        assert_eq!(
            configure["systemPrompts"],
            json!(["kill the dev server\nGeneHub rules"])
        );
        let session_path = configure["session"].as_str().unwrap();
        assert!(session_path.ends_with("session.jsonl"), "{session_path}");
        session.close().await.unwrap();
    }

    fn state_with_turn() -> TurnState {
        TurnState {
            id: Some("t1".into()),
            ..TurnState::default()
        }
    }

    #[test]
    fn built_in_user_input_becomes_a_structured_stopped_interaction() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({
                "type": "user_input_requested",
                "toolCallId": "ask_takeover",
                "questions": [{
                    "id": "pm-bootstrap-challenge",
                    "header": "项目接管",
                    "question": "是否转换为 PM 项目？",
                    "options": [
                        {"label": "确认", "description": "apply once"},
                        {"label": "暂不", "description": "leave unchanged"}
                    ]
                }]
            }),
            &mut state,
            &tx,
        );

        match drain(&mut rx).as_slice() {
            [SessionEvent::PermissionRequested { request }] => {
                assert_eq!(request.id, "ask_takeover");
                assert_eq!(request.kind, PermissionRequestKind::Question);
                let questions = request.questions.as_ref().expect("structured questions");
                assert_eq!(questions[0].id, "pm-bootstrap-challenge");
                assert_eq!(questions[0].options[0].label, "确认");
            }
            other => panic!("unexpected events: {other:?}"),
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
                item:
                    TimelineItem::AssistantMessage {
                        id,
                        text,
                        received_at_ms: None,
                    },
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
                item:
                    TimelineItem::AssistantMessage {
                        id,
                        text,
                        received_at_ms: None,
                    },
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

    fn error_end(message: &str) -> Value {
        json!({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "error", "errorMessage": message
        }})
    }

    #[test]
    fn a_retried_failure_does_not_fail_the_turn() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(&error_end("openai 429: rate limit"), &mut state, &tx);
        translate_frame(
            &json!({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3,
                    "delayMs": 2000, "errorMessage": "openai 429: rate limit"}),
            &mut state,
            &tx,
        );
        translate_frame(
            &json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop"}}),
            &mut state,
            &tx,
        );
        translate_frame(
            &json!({"type": "auto_retry_end", "success": true, "attempt": 1}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        let events = drain(&mut rx);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEvent::Item { item: TimelineItem::Error { message, .. }, .. }
                if message.contains("第 1/3 次")
        )));
        assert!(matches!(
            events.last().unwrap(),
            SessionEvent::TurnCompleted { .. }
        ));
    }

    #[test]
    fn exhausted_retries_fail_with_the_final_error() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({"type": "auto_retry_start", "attempt": 3}),
            &mut state,
            &tx,
        );
        translate_frame(&error_end("openai 429: rate limit"), &mut state, &tx);
        translate_frame(
            &json!({"type": "auto_retry_end", "success": false, "attempt": 3,
                    "finalError": "openai 429: rate limit"}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        match drain(&mut rx).last().unwrap() {
            SessionEvent::TurnFailed { error, .. } => {
                assert_eq!(error.code, TurnErrorCode::RateLimited)
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_cancelled_backoff_is_a_cancelled_turn() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(&error_end("openai 503"), &mut state, &tx);
        translate_frame(
            &json!({"type": "auto_retry_start", "attempt": 1}),
            &mut state,
            &tx,
        );
        translate_frame(
            &json!({"type": "auto_retry_end", "success": false, "attempt": 1,
                    "finalError": "Retry cancelled"}),
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
    fn an_overflow_archive_that_replays_clears_the_overflow() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(&error_end("prompt is too long"), &mut state, &tx);
        translate_frame(
            &json!({"type": "compaction_end", "reason": "overflow", "willRetry": true}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        let events = drain(&mut rx);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEvent::Item { item: TimelineItem::Compaction { reason, .. }, .. } if reason == "overflow"
        )));
        assert!(matches!(
            events.last().unwrap(),
            SessionEvent::TurnCompleted { .. }
        ));
    }

    #[test]
    fn a_failed_overflow_recovery_is_shown_and_fails_the_turn() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({"type": "compaction_end", "reason": "overflow", "willRetry": false,
                    "errorMessage": "Context overflow recovery failed"}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        let events = drain(&mut rx);
        assert!(events.iter().any(|event| matches!(
            event,
            SessionEvent::Item {
                item: TimelineItem::Error { .. },
                ..
            }
        )));
        assert!(matches!(
            events.last().unwrap(),
            SessionEvent::TurnFailed { .. }
        ));
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
                &json!({"type": "message_start", "message": {"role": "assistant"}}),
                &mut state,
                &tx,
            );
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
                assert_eq!(usage.llm_rounds, 2);
                assert_eq!(usage.cost_usd, Some(0.5));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn builtin_reports_each_llm_round_before_its_first_process_item() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut state = state_with_turn();
        translate_frame(
            &json!({"type": "message_start", "message": {"role": "user"}}),
            &mut state,
            &tx,
        );
        assert!(drain(&mut rx).is_empty());

        translate_frame(
            &json!({"type": "message_start", "message": {"role": "assistant"}}),
            &mut state,
            &tx,
        );
        translate_frame(&update(json!({"type": "thinking_start"})), &mut state, &tx);
        // `drain` drops progress, and the order of progress is what is tested.
        let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(matches!(
            &events[0],
            SessionEvent::TurnProgress { usage, .. } if usage.llm_rounds == 1
        ));
        assert!(matches!(
            &events[1],
            SessionEvent::Item {
                item: TimelineItem::Reasoning { .. },
                ..
            }
        ));

        translate_frame(
            &json!({"type": "message_end", "message": {
                "role": "assistant", "stopReason": "stop", "usage": {"output": 5}
            }}),
            &mut state,
            &tx,
        );
        translate_frame(&json!({"type": "agent_end"}), &mut state, &tx);
        assert!(matches!(
            drain(&mut rx).last(),
            Some(SessionEvent::TurnCompleted { usage, .. })
                if usage.llm_rounds == 1 && usage.output_tokens == 5
        ));
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
        // DeepSeek's endpoint rule reaches the agent as compat.
        assert_eq!(written["models"][0]["compat"]["thinkingFormat"], "deepseek");
        assert_eq!(
            written["models"][0]["compat"]["requiresReasoningContent"],
            true
        );
    }

    /// §3.5: an aliased gateway model the user marked adaptive, and an official
    /// one whose capabilities came from discovery, both reach models.json in
    /// the shape the agent reads (`apps/agent/src/config.rs` `ModelConfig`).
    #[test]
    fn merged_capabilities_reach_the_models_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut gateway = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some("https://gateway.example".into()),
            dialect: Some("anthropic".into()),
            models: vec!["vendor--opus".into()],
            ..Default::default()
        };
        gateway.model_capabilities.insert(
            "vendor--opus".into(),
            genehub_proto::ModelCapabilities {
                reasoning: Some(true),
                thinking: Some("adaptive".into()),
                ..Default::default()
            },
        );
        let mut official = ProviderConfig {
            api_key: Some("sk-test".into()),
            base_url: Some("https://api.anthropic.com".into()),
            dialect: Some("anthropic".into()),
            models: vec!["claude-opus-5".into()],
            ..Default::default()
        };
        official.discovered.insert(
            "claude-opus-5".into(),
            genehub_proto::ModelCapabilities {
                context_window: Some(1_000_000),
                max_tokens: Some(128_000),
                thinking: Some("adaptive".into()),
                efforts: Some(vec!["low".into(), "high".into(), "max".into()]),
                ..Default::default()
            },
        );
        let providers = provider_map(vec![("aiclick", gateway), ("anthropic", official)]);
        write_models_file(dir.path(), &providers).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("models.json")).unwrap())
                .unwrap();
        let find = |id: &str| {
            written["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["id"] == id)
                .unwrap()
                .clone()
        };
        let alias = find("vendor--opus");
        assert_eq!(alias["thinkingMode"], "adaptive");
        assert_eq!(alias["reasoning"], true);
        assert_eq!(alias["capabilitySources"]["thinking"], "user");
        let opus = find("claude-opus-5");
        assert_eq!(opus["contextWindow"], 1_000_000);
        assert_eq!(opus["maxTokens"], 128_000);
        assert_eq!(opus["thinkingEfforts"][2], "max");
        assert_eq!(opus["capabilitySources"]["contextWindow"], "discovered");
        // The id rule says it reasons; discovery said nothing about that.
        assert_eq!(opus["reasoning"], true);
        assert_eq!(opus["capabilitySources"]["reasoning"], "rule");
    }
}
