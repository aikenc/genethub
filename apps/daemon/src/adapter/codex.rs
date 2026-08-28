//! Adapter for Codex, spoken natively over its own `app-server` JSON-RPC
//! protocol instead of through the `codex-acp` bridge.
//!
//! Same trade as Claude Code (`adapter::claude`): the native protocol preserves
//! thread resume, model/effort/mode controls, permission requests and true user
//! questions without an extra bridge package. A person who installed `codex`
//! was previously told the agent was unavailable because that bridge was
//! missing.
//!
//! The bill for going native is version drift: these method names and frame
//! shapes are ours to follow now. They were read off codex-cli 0.145.0 by asking
//! the real CLI, and cross-checked against a second implementation of the same
//! protocol (`ref-repos`), which is also where the shapes that need a live model
//! to observe came from.
//!
//! Protocol notes:
//!
//! - Spawn `codex app-server` with `approval_policy="never"` and
//!   `sandbox_mode="danger-full-access"`. Line-delimited JSON-RPC on stdio, in
//!   both directions: an `initialize` request, then an `initialized`
//!   notification.
//! - `clientInfo.name` is `codex_app_server_daemon` rather than our own name.
//!   This is one of the shapes taken from the other implementation: it treats
//!   that value as a reserved, non-originating client, on the grounds that this
//!   CLI otherwise reads the client name as the originator of the model requests
//!   it makes. The effect we want either way is that a person's Codex usage
//!   stays attributed to Codex, not to us.
//! - `thread/start` takes `{ model, cwd, approvalPolicy, sandbox }` and returns
//!   the thread. Each prompt is then `turn/start` with `{ threadId, input,
//!   approvalPolicy, sandboxPolicy, model?, effort? }`.
//!
//!   **Every turn carries all four.** That is why none of `set_model`,
//!   `set_mode` or `set_effort` sends anything here: the choice is recorded and
//!   the next turn carries it, which is also the only way it could work for a
//!   choice made before the first prompt — the process does not exist yet
//!   (`session::manager::ensure_started`).
//! - The timeline arrives as `item/started` / `item/completed` notifications
//!   carrying an `item` with its own id, plus `item/agentMessage/delta` and
//!   `item/reasoning/summaryTextDelta` for the typing effect. `turn/started`
//!   names the turn — needed to interrupt it, since `turn/interrupt` takes
//!   `{ threadId, turnId }` — and `turn/completed` ends it.
//!   `thread/tokenUsage/updated` carries the token counts, `turn/plan/updated`
//!   the todo list, and a `contextCompaction` item (or `thread/compacted`)
//!   marks the history being pruned.
//!   The connection also carries notifications from sub-agent threads. Every
//!   timeline notification is therefore matched against both this session's
//!   thread and its turn before it reaches GeneHub's single-turn event model.
//! - Approvals are requests *from* the CLI, split by what is being approved:
//!   `item/commandExecution/requestApproval` and
//!   `item/fileChange/requestApproval`, both answered
//!   `{"decision":"accept"|"decline"|"cancel"}`, and
//!   `item/tool/requestUserInput`, which is a question rather than an approval
//!   and is answered `{"answers":{"<question id>":{"answers":["<label>"]}}}`.
//!   A surfaced interaction is persisted by the session manager, this process
//!   is closed, and the thread is resumed after the user responds; no request
//!   is left waiting on a live JSON-RPC connection.
//! - Not being logged in does not produce an error. `turn/start` is accepted,
//!   the user's message is echoed back as an item, and then nothing happens —
//!   no failure, no exit (verified on 0.145.0). So `probe` asks `codex login
//!   status` instead of letting the first prompt sit there spinning.
//! - Resume is `thread/resume` with the id we got from `thread/start`, stored in
//!   the daemon's `PersistHandle`. An archived thread is unarchived once and
//!   tried again; anything else fails the start so the session stays on the
//!   daemon's own read-only replay rather than silently opening a blank thread.
//! - Images are `{"type":"localImage","path":...}`: a pasted screenshot is
//!   written under the session scratch directory first, then that path is sent.
//! - Skills (`skills/list`) are deliberately not offered as slash commands.
//!   This CLI invokes one as `$name` alongside a `{"type":"skill"}` input block,
//!   so a menu that inserts `/name` as plain text would be a control that does
//!   nothing.

use std::collections::{HashMap, HashSet};
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
    PermissionRequest, PermissionRequestKind, ProbeState, SessionEvent, TimelineItem, TodoEntry,
    TodoStatus, ToolCallDetail, ToolImage, ToolKind, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, oneshot, Mutex};

use super::stdio::write_json_line;
use super::usage;
use super::{
    find_executable, AgentAdapter, AgentSession, Chatter, ImportCandidate, ImportedHistory,
    PersistHandle, PromptInput, ProviderMap, SessionConfig,
};

const BINARY: &str = "codex";
const EVENT_CAPACITY: usize = 1024;

/// The reserved, non-originating client name (see the module doc).
const CLIENT_NAME: &str = "codex_app_server_daemon";
const APPROVAL_CONFIG: &str = r#"approval_policy="never""#;
const SANDBOX_CONFIG: &str = r#"sandbox_mode="danger-full-access""#;

/// How long a request to the CLI may go unanswered. Generous because
/// `turn/start` is one of these and a cold start on Windows is slow.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// The one-off handshake that reads the model table.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Asking whether this install is logged in. Short: it reads a file.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5);

const ALLOW: &str = "allow";
const DENY: &str = "deny";

/// A mode as this CLI expresses one: an approval policy and a sandbox together,
/// not a single switch.
///
/// Which is why these are presets rather than a passthrough of its own
/// vocabulary — "on-request + workspace-write" is not something to put in front
/// of a person, but "can edit here, asks before going further" is.
struct Mode {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    /// `on-request` | `never`, as the CLI names them.
    approval: &'static str,
    /// `read-only` | `workspace-write` | `danger-full-access`.
    sandbox: &'static str,
    network: bool,
}

/// `static` rather than `const` so a lookup can hand back a `'static` reference
/// instead of copying.
static MODES: [Mode; 3] = [
    Mode {
        id: "read-only",
        label: "Read only",
        description: "Read and plan only — asks before editing or running anything",
        approval: "on-request",
        sandbox: "read-only",
        network: false,
    },
    Mode {
        id: "auto",
        label: "Default",
        description:
            "Edit files and run commands inside the workspace, asking before going beyond it",
        approval: "on-request",
        sandbox: "workspace-write",
        network: false,
    },
    Mode {
        id: "full-access",
        label: "Full access",
        description:
            "Never ask, and allow network access. Only for a workspace you could afford to lose",
        approval: "never",
        sandbox: "danger-full-access",
        network: true,
    },
];

/// GeneHub is built for unattended work: a fresh session starts with the
/// highest native authority. Explicit and persisted lower modes stay intact.
const DEFAULT_MODE: &str = "full-access";

fn app_server_args() -> [&'static str; 5] {
    ["app-server", "-c", APPROVAL_CONFIG, "-c", SANDBOX_CONFIG]
}

fn mode_named(id: &str) -> &'static Mode {
    MODES
        .iter()
        .find(|mode| mode.id == id)
        // The default, not the first entry: an unknown name must not silently
        // become "read only" and leave someone wondering why nothing happens.
        .unwrap_or_else(|| {
            MODES
                .iter()
                .find(|mode| mode.id == DEFAULT_MODE)
                .expect("the default mode is one of the modes")
        })
}

/// The `sandboxPolicy` object `turn/start` wants, which is a different shape
/// from the `sandbox` string `thread/start` takes.
fn sandbox_policy(mode: &Mode) -> Value {
    match mode.sandbox {
        "read-only" => json!({ "type": "readOnly" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite", "networkAccess": mode.network }),
    }
}

/// Thread operations carry their own policy. That lets the process itself
/// launch unrestricted while an explicit read-only/auto selection still wins.
fn with_thread_policy(mut params: Value, mode: &Mode) -> Value {
    params["approvalPolicy"] = json!(mode.approval);
    params["sandbox"] = json!(mode.sandbox);
    params
}

fn with_developer_instructions(mut params: Value, prompt: Option<&str>) -> Value {
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        params["developerInstructions"] = json!(prompt);
    }
    params
}

#[derive(Default)]
pub struct CodexAdapter {
    /// What the CLI answered when asked for its model table, read once per
    /// daemon run: the picker wants it long before anyone opens a session, and
    /// the only way to ask this CLI anything is to run it.
    hello: tokio::sync::OnceCell<Option<Hello>>,
}

/// What one handshake told us about this install.
#[derive(Clone, Default)]
struct Hello {
    models: Vec<ModelInfo>,
    default_model: Option<String>,
    /// The default model's own default thinking level, which is the only level
    /// we can state without guessing.
    default_effort: Option<String>,
}

impl CodexAdapter {
    fn program(&self) -> Option<PathBuf> {
        find_executable(BINARY)
    }

    async fn hello(&self, program: &Path) -> Option<Hello> {
        // A timeout or refused `model/list` must not hide the picker for the
        // rest of this daemon run. A later catalog refresh gets another try.
        if let Some(cached) = self.hello.get() {
            return cached.clone();
        }
        let found = discover(program).await;
        if let Some(hello) = found.clone() {
            let _ = self.hello.set(Some(hello));
        }
        found
    }
}

#[async_trait]
impl AgentAdapter for CodexAdapter {
    fn id(&self) -> &str {
        "codex"
    }

    fn label(&self) -> &str {
        "Codex"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            interrupt: true,
            // All three are real here, and none of them costs a round trip:
            // every `turn/start` carries the model, the level and the policy.
            set_model: true,
            set_effort: true,
            set_mode: true,
            permissions: true,
            // `thread/resume` with the id we stored from `thread/start`.
            resume: true,
            fork: true,
            // Pasted screenshots are written under the session scratch dir and
            // sent as `localImage` paths — that is the only shape this CLI takes.
            attachments: true,
        }
    }

    async fn probe(&self) -> ProbeState {
        let Some(program) = self.program() else {
            return ProbeState::NotInstalled;
        };
        // Asked every time rather than remembered: whoever reads the reason
        // below goes and runs `codex login`, and the picker has to notice that.
        match logged_in(&program).await {
            Some(false) => ProbeState::Unavailable {
                reason: "找到了 Codex，但它还没登录：先跑 codex login（或者 \
                         printenv OPENAI_API_KEY | codex login --with-api-key）"
                    .into(),
            },
            // Logged in, or the question could not be asked at all. A slow or
            // unusual `codex login status` is not a reason to hide a CLI that is
            // sitting right there.
            _ => ProbeState::Ready,
        }
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        let Some(program) = self.program() else {
            return Catalog::default();
        };
        let hello = self.hello(&program).await.unwrap_or_default();
        Catalog {
            runtime_axes: None,
            models: hello.models,
            modes: MODES
                .iter()
                .map(|mode| ModeInfo {
                    id: mode.id.into(),
                    label: mode.label.into(),
                    description: Some(mode.description.into()),
                })
                .collect(),
            // Its skills are invoked as `$name` with a `{"type":"skill"}` input
            // block, not as `/name` in the prompt text (see the module doc), so
            // they are not offered as commands that send plain text.
            commands: Vec::new(),
            default_model: hello.default_model,
            default_mode: Some(DEFAULT_MODE.into()),
            default_effort: hello.default_effort,
        }
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("codex is not installed"))?;
        let hello = self.hello(&program).await.unwrap_or_default();

        let mut command = Command::new(&program);
        command
            .args(app_server_args())
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

        // Kept rather than dropped: when this CLI exits on its own, its stderr
        // is the only account of why.
        let said = Arc::new(Chatter::default());
        said.watch("codex", Some(stderr)).await;

        let stdin = Arc::new(Mutex::new(stdin));
        let child = Arc::new(Mutex::new(Some(child)));
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let pending: PendingMap = Arc::default();
        let asks: AskMap = Arc::default();
        let turn = Arc::new(Mutex::new(TurnState::default()));
        // A resumed thread is known before `thread/resume` can replay any of its
        // notifications. A brand-new one is filled from `thread/start` below.
        let thread: SharedThread =
            Arc::new(std::sync::Mutex::new(resume_thread_id(&config.resume)));

        // The lists a later `set_model` / `set_effort` is checked against. The
        // CLI does not check them for us, and a picker that "succeeds" onto a
        // model that never took is worse than a refusal.
        let models: Vec<String> = hello.models.iter().map(|model| model.id.clone()).collect();
        let efforts: Vec<String> = hello
            .models
            .iter()
            .flat_map(|model| model.efforts.iter())
            .fold(Vec::new(), |mut levels, level| {
                if !levels.contains(level) {
                    levels.push(level.clone());
                }
                levels
            });

        // Chosen before the first prompt, which is the ordinary case: the
        // process only starts when there is something to send.
        let mode = config
            .mode_id
            .clone()
            .filter(|id| MODES.iter().any(|mode| mode.id == id.as_str()))
            .unwrap_or_else(|| DEFAULT_MODE.to_string());
        let model = config
            .model_id
            .clone()
            .filter(|id| models.contains(id))
            .or_else(|| hello.default_model.clone());
        let effort = config
            .effort_id
            .clone()
            .filter(|id| efforts.contains(id))
            .or_else(|| hello.default_effort.clone());

        let session = CodexSession {
            stdin: stdin.clone(),
            events: events.clone(),
            pending: pending.clone(),
            asks: asks.clone(),
            turn: turn.clone(),
            next_id: AtomicI64::new(1),
            child: child.clone(),
            // `std`, not `tokio`: `persistence()` is synchronous, and this value
            // is only ever held for a single field read or write. The reader
            // shares it so multiplexed sub-agent notifications can be rejected.
            thread: thread.clone(),
            mode: Mutex::new(mode),
            model: Mutex::new(model),
            effort: Mutex::new(effort),
            models,
            efforts,
            scratch_dir: config.scratch_dir.clone(),
        };

        tokio::spawn(read_loop(Reader {
            stdout,
            stdin,
            events,
            pending,
            asks,
            turn,
            thread,
            child,
            said: said.clone(),
        }));

        // A handshake that got no answer is usually a CLI that already left, and
        // what it wrote on the way out is the only account of why. Without this
        // the session fails with "Codex did not answer initialize" and the
        // sentence that says why is discarded by us.
        if let Err(error) = session.handshake(&config).await {
            said.settle().await;
            return Err(anyhow!("{error}{}", said.tail()));
        }
        Ok(Box::new(session))
    }

    async fn list_import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Result<Option<Vec<ImportCandidate>>> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("codex is not installed"))?;
        let listed = import_rpc(
            &program,
            cwd,
            "thread/list",
            json!({
                "cwd": cwd,
                "limit": limit.clamp(1, 100),
                "sortKey": "updated_at",
                "sortDirection": "desc",
            }),
        )
        .await?;
        let candidates = listed
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|thread| {
                let source_id = thread.get("id")?.as_str()?.to_string();
                let preview = thread
                    .get("preview")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let title = thread
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| preview.lines().next().unwrap_or("Codex 会话"))
                    .to_string();
                Some(ImportCandidate {
                    source_id,
                    title: clipped(&title, 120),
                    preview: clipped(&preview, 240),
                    updated_at_ms: thread
                        .get("updatedAt")
                        .and_then(Value::as_i64)
                        .unwrap_or_default()
                        .saturating_mul(1000),
                    continuation: ImportContinuation::Native,
                })
            })
            .collect();
        Ok(Some(candidates))
    }

    async fn import_history(&self, cwd: &Path, source_id: &str) -> Result<ImportedHistory> {
        let program = self
            .program()
            .ok_or_else(|| anyhow!("codex is not installed"))?;
        let read = import_rpc(
            &program,
            cwd,
            "thread/read",
            json!({ "threadId": source_id, "includeTurns": true }),
        )
        .await?;
        let thread = read
            .get("thread")
            .ok_or_else(|| anyhow!("thread/read did not return a thread"))?;
        let mut items = Vec::new();
        for turn in thread
            .get("turns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            for item in turn
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = format!("import-{}", uuid::Uuid::new_v4().simple());
                match item.get("type").and_then(Value::as_str) {
                    Some("userMessage") => {
                        let text = item
                            .get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|part| {
                                (part.get("type").and_then(Value::as_str) == Some("text"))
                                    .then(|| part.get("text").and_then(Value::as_str))
                                    .flatten()
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        if !text.is_empty() {
                            items.push(TimelineItem::UserMessage {
                                id,
                                text,
                                attachments: Vec::new(),
                            });
                        }
                    }
                    Some("agentMessage") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                items.push(TimelineItem::AssistantMessage {
                                    id,
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let preview = thread
            .get("preview")
            .and_then(Value::as_str)
            .unwrap_or_default();
        Ok(ImportedHistory {
            title: thread
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .or_else(|| preview.lines().next())
                .map(|value| clipped(value, 120)),
            created_at_ms: thread
                .get("createdAt")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .saturating_mul(1000),
            updated_at_ms: thread
                .get("updatedAt")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .saturating_mul(1000),
            items,
            persist: Some(PersistHandle {
                agent_id: "codex".into(),
                value: json!({ "threadId": source_id }),
            }),
            continuation: ImportContinuation::Native,
            warnings: Vec::new(),
        })
    }
}

/// One bounded app-server query used by import discovery/read. The process is
/// intentionally throwaway so opening the import dialog cannot interfere with
/// a live conversation's notification stream.
async fn import_rpc(program: &Path, cwd: &Path, method: &str, params: Value) -> Result<Value> {
    let mut command = Command::new(program);
    command
        .args(app_server_args())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    super::owned_child(&mut command);
    let mut child = command
        .spawn()
        .with_context(|| format!("spawning {} for session import", program.display()))?;
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let answer = tokio::time::timeout(CALL_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        write_json_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "clientInfo": {
                    "name": CLIENT_NAME,
                    "title": crate::channel::PRODUCT,
                    "version": crate::version::product_version(),
                } },
            }),
        )
        .await?;
        answered(&mut lines, 1)
            .await
            .ok_or_else(|| anyhow!("codex did not answer initialize"))?;
        write_json_line(
            &mut stdin,
            &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
        )
        .await?;
        write_json_line(
            &mut stdin,
            &json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }),
        )
        .await?;
        answered(&mut lines, 2)
            .await
            .ok_or_else(|| anyhow!("codex did not answer {method}"))
    })
    .await
    .map_err(|_| anyhow!("codex timed out while handling {method}"))?;
    super::kill_tree(&mut child).await;
    answer
}

fn clipped(value: &str, limit: usize) -> String {
    let mut text: String = value.trim().chars().take(limit).collect();
    if value.trim().chars().count() > limit {
        text.push('…');
    }
    text
}

/// Runs one handshake against a throwaway process and takes its answers away.
///
/// A process of its own because the model table is wanted for the agent picker,
/// which is drawn long before any session exists. Nothing here reaches a model —
/// both `initialize` and `model/list` answer without credentials, which is also
/// why this cannot double as a login check.
async fn discover(program: &Path) -> Option<Hello> {
    let mut command = Command::new(program);
    command
        .args(app_server_args())
        // Somewhere that exists and says nothing about any of the user's
        // projects: this answer is cached for every workspace.
        .current_dir(crate::os_process::scratch_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    super::owned_child(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!("could not ask codex what it supports: {error}");
            return None;
        }
    };
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;

    let answer = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        let hello = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": {
                "name": CLIENT_NAME,
                "title": crate::channel::PRODUCT,
                "version": crate::version::product_version(),
            } },
        });
        write_json_line(&mut stdin, &hello).await.ok()?;
        answered(&mut lines, 1).await?;
        let ready = json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
        write_json_line(&mut stdin, &ready).await.ok()?;

        let ask = json!({ "jsonrpc": "2.0", "id": 2, "method": "model/list", "params": {} });
        write_json_line(&mut stdin, &ask).await.ok()?;
        let listed = answered(&mut lines, 2).await?;
        let (default_model, default_effort) = match default_model_in(&listed) {
            Some((model, effort)) => (Some(model), effort),
            None => (None, None),
        };
        Some(Hello {
            models: models_in(&listed),
            default_model,
            default_effort,
        })
    })
    .await;

    // It is only alive to answer that, and it does not exit on its own.
    super::kill_tree(&mut child).await;

    match answer {
        Ok(answer) => answer,
        Err(_) => {
            tracing::warn!("codex did not answer a handshake in time");
            None
        }
    }
}

/// Reads until the reply to `id` arrives, ignoring the notifications the CLI
/// volunteers in the meantime.
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
            tracing::warn!("codex refused a handshake request: {error}");
            return None;
        }
        return Some(frame.get("result").cloned().unwrap_or(Value::Null));
    }
    None
}

/// Whether this install has credentials, as the CLI itself reports them.
///
/// Worth its own process because of how the alternative fails: see the module
/// doc — an unauthenticated turn is accepted and then simply never finishes.
async fn logged_in(program: &Path) -> Option<bool> {
    let mut command = Command::new(program);
    command
        .args(["login", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    super::owned_child(&mut command);

    let output = tokio::time::timeout(LOGIN_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    let mut said = String::from_utf8_lossy(&output.stdout).to_string();
    said.push_str(&String::from_utf8_lossy(&output.stderr));
    // Phrased as "is it logged out", because that is the only sentence worth
    // acting on. Every other wording — which account, which method — means it
    // is usable, and a check that guessed at those would hide working installs.
    Some(!said.contains("Not logged in"))
}

/// The models this install offers, as it listed them.
fn models_in(listed: &Value) -> Vec<ModelInfo> {
    let Some(models) = listed.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            // It marks the ones it does not want shown. Repeating them in a
            // picker would offer a choice its own UI does not.
            if model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }
            let id = model.get("id").and_then(Value::as_str)?;
            let efforts = efforts_in(model);
            Some(ModelInfo {
                id: id.to_string(),
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_window: None,
                reasoning: !efforts.is_empty(),
                efforts,
            })
        })
        .collect()
}

/// The thinking levels one model named, weakest first as it ordered them.
///
/// Each entry is an object with the level and a sentence about it; older builds
/// listed bare strings, and both are cheap to accept.
fn efforts_in(model: &Value) -> Vec<String> {
    model
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| {
                    level
                        .get("reasoningEffort")
                        .and_then(Value::as_str)
                        .or_else(|| level.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The model this install would use if nobody chose, and that model's own
/// default thinking level.
fn default_model_in(listed: &Value) -> Option<(String, Option<String>)> {
    let models = listed.get("data")?.as_array()?;
    let chosen = models
        .iter()
        .find(|model| {
            model
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .or_else(|| models.first())?;
    let id = chosen.get("id").and_then(Value::as_str)?.to_string();
    let effort = chosen
        .get("defaultReasoningEffort")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((id, effort))
}

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;
type AskMap = Arc<Mutex<HashMap<String, PendingAsk>>>;
type SharedThread = Arc<std::sync::Mutex<Option<String>>>;

struct PendingAsk {
    /// JSON-RPC ids may be either integers or strings and must be echoed with
    /// their original type in the response.
    upstream_id: Value,
    response: Ask,
}

/// What the CLI is waiting for us to answer, and in which shape.
enum Ask {
    /// An approval: answered with a `decision`.
    Decision,
    /// A question: answered with the label of the option that was picked, keyed
    /// by the question's own id.
    Questions { questions: Vec<Question> },
}

#[derive(Copy, Clone)]
enum Kind {
    Assistant,
    Reasoning,
}

#[derive(Default)]
struct TurnState {
    /// Our own id for the turn in flight.
    id: Option<String>,
    /// The CLI's id for the same turn, learned from `turn/started` or its RPC
    /// response. Without it there is nothing to interrupt: `turn/interrupt` is
    /// addressed to a turn.
    codex_turn: Option<String>,
    /// Items the timeline has already been told about, so a delta can tell
    /// "extend that one" from "this is the first anyone has heard of it".
    open: HashSet<String>,
    /// The last token counts this thread reported. They arrive on their own
    /// notification, not with the end of the turn, so they are held until there
    /// is a completed turn to attach them to.
    usage: Usage,
    /// We asked for this turn to stop, so its end is a cancellation however the
    /// CLI happens to label it.
    interrupt_requested: bool,
    /// Codex reports one compaction twice: a `thread/compacted` notification and
    /// a completed `contextCompaction` item. This counts the notifications that
    /// arrived first so the item does not emit a second marker for the same
    /// squeeze.
    unpaired_compactions: u32,
}

struct CodexSession {
    stdin: Arc<Mutex<ChildStdin>>,
    events: broadcast::Sender<SessionEvent>,
    pending: PendingMap,
    asks: AskMap,
    turn: Arc<Mutex<TurnState>>,
    next_id: AtomicI64,
    child: Arc<Mutex<Option<Child>>>,
    thread: SharedThread,
    mode: Mutex<String>,
    model: Mutex<Option<String>>,
    effort: Mutex<Option<String>>,
    /// What this install listed, for checking a choice against.
    models: Vec<String>,
    efforts: Vec<String>,
    /// Where pasted images are written before `localImage` can name them.
    scratch_dir: PathBuf,
}

impl CodexSession {
    async fn write(&self, value: Value) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        write_json_line(&mut stdin, &value).await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
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
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(anyhow!("{method} failed: {message}")),
            Ok(Err(_)) => Err(anyhow!("{method} failed: Codex closed the connection")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(anyhow!("Codex did not answer {method}"))
            }
        }
    }

    /// Introduces ourselves and opens — or reopens — the thread this session talks to.
    async fn handshake(&self, config: &SessionConfig) -> Result<()> {
        self.call(
            "initialize",
            json!({ "clientInfo": {
                "name": CLIENT_NAME,
                "title": crate::channel::PRODUCT,
                "version": crate::version::product_version(),
            } }),
        )
        .await?;
        self.notify("initialized", json!({})).await?;

        if let Some(thread_id) = resume_thread_id(&config.resume) {
            self.reopen(&thread_id, config.additional_system_prompt.as_deref())
                .await?;
            *self.thread.lock().expect("the thread id is never poisoned") = Some(thread_id);
            return Ok(());
        }

        let mode = mode_named(self.mode.lock().await.as_str());
        let mut params = with_thread_policy(json!({ "cwd": config.cwd }), mode);
        if let Some(model) = self.model.lock().await.clone() {
            params["model"] = json!(model);
        }
        params = with_developer_instructions(params, config.additional_system_prompt.as_deref());
        let started = self.call("thread/start", params).await?;
        let thread = started
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("thread/start did not return a thread id"))?;
        *self.thread.lock().expect("the thread id is never poisoned") = Some(thread.to_string());
        Ok(())
    }

    /// Brings a previously started thread back into this process.
    ///
    /// Archived threads are unarchived once and tried again: Codex archives on
    /// its own schedule, and a session the user is still looking at is not
    /// something we should refuse just because it was tidied away.
    async fn reopen(&self, thread_id: &str, additional_system_prompt: Option<&str>) -> Result<()> {
        let mode = mode_named(self.mode.lock().await.as_str());
        let resume_params = || {
            with_developer_instructions(
                with_thread_policy(json!({ "threadId": thread_id }), mode),
                additional_system_prompt,
            )
        };
        match self.call("thread/resume", resume_params()).await {
            Ok(_) => Ok(()),
            Err(error) if archived_thread(&error.to_string(), thread_id) => {
                self.call("thread/unarchive", json!({ "threadId": thread_id }))
                    .await
                    .with_context(|| format!("unarchiving Codex thread {thread_id}"))?;
                self.call("thread/resume", resume_params())
                    .await
                    .with_context(|| {
                        format!("resuming Codex thread {thread_id} after unarchive")
                    })?;
                Ok(())
            }
            Err(error) => Err(error).with_context(|| format!("resuming Codex thread {thread_id}")),
        }
    }
}

/// The thread id a previous run of this session left behind, when it is ours.
fn resume_thread_id(resume: &Option<PersistHandle>) -> Option<String> {
    resume
        .as_ref()
        .filter(|handle| handle.agent_id == "codex")
        .and_then(|handle| handle.value.get("threadId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Whether a resume failure is "this thread was archived", in the wording this
/// CLI uses today. Matched loosely: the id is in the sentence either way.
fn archived_thread(message: &str, thread_id: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("archived") && message.contains(thread_id)
}

#[async_trait]
impl AgentSession for CodexSession {
    fn events(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    async fn send(&self, input: PromptInput) -> Result<String> {
        let thread = self
            .thread
            .lock()
            .expect("the thread id is never poisoned")
            .clone()
            .ok_or_else(|| anyhow!("the Codex thread was never started"))?;
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4().simple());
        {
            let mut state = self.turn.lock().await;
            // The token counts survive: they belong to the thread, and the CLI
            // only re-sends them when they change.
            let usage = state.usage.clone();
            *state = TurnState {
                id: Some(turn_id.clone()),
                usage,
                ..TurnState::default()
            };
            usage::record_round_start(&mut state.usage);
        }
        let _ = self.events.send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 0,
        });

        let mode = mode_named(self.mode.lock().await.as_str());
        let input_blocks = turn_input(&input, &self.scratch_dir)?;
        let mut params = json!({
            "threadId": thread,
            "input": input_blocks,
            // Sent every turn, which is what makes the three pickers work
            // without an RPC of their own (see the module doc).
            "approvalPolicy": mode.approval,
            "sandboxPolicy": sandbox_policy(mode),
        });
        if let Some(model) = self.model.lock().await.clone() {
            params["model"] = json!(model);
        }
        if let Some(effort) = self.effort.lock().await.clone() {
            params["effort"] = json!(effort);
        }

        // The timeline and the end arrive as notifications. The response also
        // names the accepted turn, which closes the small window where Send has
        // returned but `turn/started` has not yet been translated for Interrupt.
        let started = match self.call("turn/start", params).await {
            Ok(started) => started,
            Err(error) => {
                let mut state = self.turn.lock().await;
                if state.id.as_deref() == Some(turn_id.as_str()) {
                    state.id = None;
                }
                let _ = self.events.send(SessionEvent::TurnFailed {
                    turn_id,
                    error: TurnError {
                        code: TurnErrorCode::Upstream,
                        message: error.to_string(),
                    },
                });
                return Err(error);
            }
        };
        if let Some(upstream_turn) = notification_turn_id(&started) {
            let mut state = self.turn.lock().await;
            bind_started_turn_from_response(&mut state, &turn_id, upstream_turn);
        }
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        let thread = self
            .thread
            .lock()
            .expect("the thread id is never poisoned")
            .clone();
        let codex_turn = {
            let mut state = self.turn.lock().await;
            state.interrupt_requested = true;
            state.codex_turn.clone()
        };
        let (Some(thread), Some(codex_turn)) = (thread, codex_turn) else {
            // Nothing running, or the CLI has not named the turn yet. Not a
            // failure: the user pressed stop early, or late.
            return Ok(());
        };
        self.call(
            "turn/interrupt",
            json!({ "threadId": thread, "turnId": codex_turn }),
        )
        .await?;
        Ok(())
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
            super::kill_tree(&mut child).await;
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        // Checked here because the CLI will not: it is told the model on the
        // next turn, and an unknown name would only surface then, as a failed
        // turn rather than a refused choice.
        if !self.models.is_empty() && !self.models.iter().any(|known| known == model_id) {
            return Err(anyhow!("Codex did not list a model called '{model_id}'"));
        }
        *self.model.lock().await = Some(model_id.to_string());
        Ok(())
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        if !MODES.iter().any(|mode| mode.id == mode_id) {
            return Err(anyhow!("'{mode_id}' is not one of Codex's modes"));
        }
        *self.mode.lock().await = mode_id.to_string();
        Ok(())
    }

    async fn fork(&self, checkpoint: &str) -> Result<PersistHandle> {
        let thread_id = self
            .thread
            .lock()
            .expect("the thread id is never poisoned")
            .clone()
            .ok_or_else(|| anyhow!("the Codex thread was never started"))?;
        let forked = self
            .call(
                "thread/fork",
                with_thread_policy(
                    json!({
                        "threadId": thread_id,
                        "lastTurnId": checkpoint,
                        "ephemeral": false,
                    }),
                    mode_named(self.mode.lock().await.as_str()),
                ),
            )
            .await?;
        let thread_id = forked
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("thread/fork did not return a thread id"))?;
        Ok(PersistHandle {
            agent_id: "codex".into(),
            value: json!({ "threadId": thread_id }),
        })
    }

    async fn set_effort(&self, effort_id: &str) -> Result<()> {
        if !self.efforts.is_empty() && !self.efforts.iter().any(|known| known == effort_id) {
            return Err(anyhow!(
                "Codex did not list a thinking level called '{effort_id}'"
            ));
        }
        *self.effort.lock().await = Some(effort_id.to_string());
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()> {
        let pending = self
            .asks
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| anyhow!("Codex request '{request_id}' is no longer pending"))?;
        let result = match pending.response {
            Ask::Questions { questions } => {
                json!({ "answers": codex_answers(&questions, &outcome) })
            }
            _ => json!({ "decision": decision(&outcome) }),
        };
        self.write(json!({
            "jsonrpc": "2.0",
            "id": pending.upstream_id,
            "result": result,
        }))
        .await?;
        let _ = self.events.send(SessionEvent::PermissionResolved {
            request_id: request_id.to_string(),
            outcome,
        });
        Ok(())
    }

    fn persistence(&self) -> Option<PersistHandle> {
        let thread_id = self
            .thread
            .lock()
            .expect("the thread id is never poisoned")
            .clone()?;
        Some(PersistHandle {
            agent_id: "codex".into(),
            value: json!({ "threadId": thread_id }),
        })
    }
}

/// The `input` array for `turn/start`: text plus any pasted images, which this
/// CLI only accepts as paths on disk.
fn turn_input(input: &PromptInput, scratch: &Path) -> Result<Vec<Value>> {
    let mut blocks = Vec::new();
    if !input.text.is_empty() {
        blocks.push(json!({ "type": "text", "text": input.text }));
    }
    let images: Vec<&_> = input
        .attachments
        .iter()
        .filter(|attachment| {
            attachment.data_base64.is_some() && attachment.mime.starts_with("image/")
        })
        .collect();
    if !images.is_empty() {
        let dir = scratch.join("attachments");
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        for (index, attachment) in images.into_iter().enumerate() {
            let data = attachment
                .data_base64
                .as_deref()
                .expect("filtered to attachments with data");
            let bytes = decode_base64(data).context("decoding a pasted image")?;
            let ext = extension_for(&attachment.mime);
            let path = dir.join(format!("{}-{index}.{ext}", uuid::Uuid::new_v4().simple()));
            std::fs::write(&path, &bytes).with_context(|| format!("writing {}", path.display()))?;
            blocks.push(json!({ "type": "localImage", "path": path }));
        }
    }
    if blocks.is_empty() {
        // The composer refuses to send with neither text nor attachments, so
        // this is a protocol quirk rather than a user action — still give the
        // CLI something rather than an empty `input`.
        blocks.push(json!({ "type": "text", "text": "" }));
    }
    Ok(blocks)
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// Standard base64 (with optional padding and whitespace), as the composer
/// produces for a pasted screenshot. Kept local so a single adapter does not
/// drag a crate into the daemon for one decode site.
fn decode_base64(input: &str) -> Result<Vec<u8>> {
    const TABLE: [i8; 256] = {
        let mut table = [-1_i8; 256];
        let mut i = 0;
        while i < 26 {
            table[b'A' as usize + i] = i as i8;
            table[b'a' as usize + i] = (26 + i) as i8;
            i += 1;
        }
        i = 0;
        while i < 10 {
            table[b'0' as usize + i] = (52 + i) as i8;
            i += 1;
        }
        table[b'+' as usize] = 62;
        table[b'/' as usize] = 63;
        table
    };

    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if !cleaned.len().is_multiple_of(4) {
        return Err(anyhow!("base64 length is not a multiple of 4"));
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.as_chunks::<4>().0 {
        let pad = chunk.iter().filter(|&&byte| byte == b'=').count();
        if pad > 2 {
            return Err(anyhow!("base64 padding is longer than two characters"));
        }
        let mut values = [0u32; 4];
        for (i, &byte) in chunk.iter().enumerate() {
            if byte == b'=' {
                if i < 2 {
                    return Err(anyhow!("base64 padding in the wrong place"));
                }
                values[i] = 0;
                continue;
            }
            let value = TABLE[byte as usize];
            if value < 0 {
                return Err(anyhow!("base64 has an invalid character"));
            }
            values[i] = value as u32;
        }
        let triple = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
        out.push(((triple >> 16) & 0xff) as u8);
        if pad < 2 {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if pad < 1 {
            out.push((triple & 0xff) as u8);
        }
    }
    Ok(out)
}

/// `accept` | `decline` | `cancel`, as this CLI's approvals are answered.
///
/// There is no "always allow" on this wire, so none is offered: the mode picker
/// is where someone stops being asked, and that at least says what it does.
fn decision(outcome: &PermissionOutcome) -> &'static str {
    match outcome {
        PermissionOutcome::Selected { option_id } if option_id == ALLOW => "accept",
        // The turn is going away, not just this one tool call.
        PermissionOutcome::Canceled => "cancel",
        _ => "decline",
    }
}

fn allow_or_deny() -> Vec<PermissionOption> {
    vec![
        PermissionOption {
            id: ALLOW.into(),
            label: "Allow".into(),
            kind: PermissionOptionKind::AllowOnce,
        },
        PermissionOption {
            id: DENY.into(),
            label: "Deny".into(),
            kind: PermissionOptionKind::Reject,
        },
    ]
}

/// Everything the read loop needs, bundled because a function with eight
/// positional arguments is a function whose call site cannot be read.
struct Reader {
    stdout: crate::os_process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    events: broadcast::Sender<SessionEvent>,
    pending: PendingMap,
    asks: AskMap,
    turn: Arc<Mutex<TurnState>>,
    thread: SharedThread,
    child: Arc<Mutex<Option<Child>>>,
    said: Arc<Chatter>,
}

async fn read_loop(reader: Reader) {
    let Reader {
        stdout,
        stdin,
        events,
        pending,
        asks,
        turn,
        thread,
        child,
        said,
    } = reader;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            tracing::warn!("undecodable codex frame");
            continue;
        };
        let method = frame
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        // Preserve the wire type: app-server's RequestId is string | integer,
        // and a server request has to receive exactly the id it sent us.
        let id = frame.get("id").cloned();
        let params = frame.get("params").cloned().unwrap_or(Value::Null);

        match (id, method) {
            // A reply to something we sent.
            (Some(id), None) => {
                if let Some(id) = id.as_i64() {
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
                }
            }
            // A request from the CLI: it is waiting on a reply keyed by this id.
            (Some(id), Some(method)) => {
                let expected_thread = thread
                    .lock()
                    .expect("the thread id is never poisoned")
                    .clone();
                let surface = if is_interactive_request(&method) {
                    let state = turn.lock().await;
                    is_current_scope(&params, expected_thread.as_deref(), &state)
                } else {
                    true
                };
                translate_ask(Asked {
                    id,
                    method,
                    params,
                    surface,
                    stdin: &stdin,
                    asks: &asks,
                    events: &events,
                })
                .await;
            }
            (None, Some(method)) => {
                let expected_thread = thread
                    .lock()
                    .expect("the thread id is never poisoned")
                    .clone();
                if method == "serverRequest/resolved" {
                    resolve_ask(&params, expected_thread.as_deref(), &asks, &events).await;
                } else {
                    translate(&method, &params, expected_thread.as_deref(), &turn, &events).await;
                }
            }
            (None, None) => {}
        }
    }

    // Its stdout closed, so the CLI is gone. Nothing is going to send a
    // `turn/completed` for a turn in flight, and a turn nobody ever ends leaves
    // the composer spinning forever.
    let mut state = turn.lock().await;
    if let Some(turn_id) = state.id.take() {
        let _ = events.send(SessionEvent::TurnFailed {
            turn_id,
            error: TurnError {
                code: TurnErrorCode::AgentCrashed,
                message: super::stopped("Codex", &child, &said).await,
            },
        });
    }
}

/// One request the CLI is waiting on.
struct Asked<'a> {
    id: Value,
    method: String,
    params: Value,
    /// Only the active root turn may put the session into Waiting. Foreign
    /// requests are answered conservatively without impersonating root.
    surface: bool,
    stdin: &'a Mutex<ChildStdin>,
    asks: &'a AskMap,
    events: &'a broadcast::Sender<SessionEvent>,
}

/// The UI only needs an opaque string, while the response must preserve the
/// JSON-RPC id's original string/integer type. Prefixing string ids also keeps
/// integer `1` distinct from string `"1"` in the pending map.
fn request_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(number) if number.as_i64().is_some() => Some(number.to_string()),
        Value::String(text) => Some(format!("string:{text}")),
        _ => None,
    }
}

fn is_interactive_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/tool/requestUserInput"
            | "tool/requestUserInput"
    )
}

/// A foreign or stale turn still needs an immediate answer or app-server will
/// wait forever. These are the least-authority protocol-valid responses.
fn unattended_request_result(method: &str) -> Option<Value> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Some(json!({ "decision": "decline" }))
        }
        "item/tool/requestUserInput" | "tool/requestUserInput" => Some(json!({ "answers": {} })),
        _ => None,
    }
}

fn is_current_scope(params: &Value, expected_thread: Option<&str>, state: &TurnState) -> bool {
    let Some(expected_thread) = expected_thread else {
        return false;
    };
    state.id.is_some()
        && params.get("threadId").and_then(Value::as_str) == Some(expected_thread)
        && is_current_turn(params, state)
}

async fn translate_ask(asked: Asked<'_>) {
    let Asked {
        id,
        method,
        params,
        surface,
        stdin,
        asks,
        events,
    } = asked;
    let Some(request_id) = request_key(&id) else {
        answer(
            stdin,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32600, "message": "Invalid Codex request id" },
            }),
        )
        .await;
        return;
    };
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let reason = params
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(str::to_string);

    let ask = |title: String| {
        let _ = events.send(SessionEvent::PermissionRequested {
            request: PermissionRequest {
                id: request_id.clone(),
                kind: PermissionRequestKind::Permission,
                title,
                detail: reason.clone(),
                tool_call_id: item_id.clone(),
                options: allow_or_deny(),
                questions: None,
            },
        });
    };

    if !surface {
        if let Some(result) = unattended_request_result(&method) {
            answer(
                stdin,
                json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            )
            .await;
            return;
        }
    }

    match method.as_str() {
        "item/commandExecution/requestApproval" => {
            asks.lock().await.insert(
                request_id.clone(),
                PendingAsk {
                    upstream_id: id,
                    response: Ask::Decision,
                },
            );
            let command = command_text(params.get("command"));
            ask(if command.is_empty() {
                "Run a command?".to_string()
            } else {
                format!("Run `{command}`?")
            });
        }
        "item/fileChange/requestApproval" => {
            asks.lock().await.insert(
                request_id.clone(),
                PendingAsk {
                    upstream_id: id,
                    response: Ask::Decision,
                },
            );
            ask("Apply file changes?".to_string());
        }
        // Both names: the second is what builds before 0.143 called it.
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
            let questions = params
                .get("questions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let parsed: Vec<Question> = questions.iter().filter_map(question_in).collect();
            match parsed.len() == questions.len() && !parsed.is_empty() {
                true => {
                    asks.lock().await.insert(
                        request_id.clone(),
                        PendingAsk {
                            upstream_id: id,
                            response: Ask::Questions {
                                questions: parsed.clone(),
                            },
                        },
                    );
                    let _ = events.send(SessionEvent::PermissionRequested {
                        request: PermissionRequest {
                            id: request_id.clone(),
                            kind: PermissionRequestKind::Question,
                            title: parsed[0].header.clone(),
                            detail: None,
                            tool_call_id: item_id.clone(),
                            options: Vec::new(),
                            questions: Some(parsed.iter().map(Question::interaction).collect()),
                        },
                    });
                }
                false => {
                    answer(
                        stdin,
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "answers": {} } }),
                    )
                    .await
                }
            }
        }
        // An MCP server asking for input through a form we cannot render.
        // Declined rather than ignored, for the same reason as everything else
        // here: unanswered means the CLI waits.
        "mcpServer/elicitation/request" => {
            answer(
                stdin,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "action": "decline", "content": null, "_meta": null },
                }),
            )
            .await;
        }
        // Something this build asks for that we have never seen. An error is a
        // reply too, and it is the only one that cannot be mistaken for consent.
        other => {
            tracing::warn!("codex asked us something we do not answer: {other}");
            answer(
                stdin,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "GeneHub does not answer this request" },
                }),
            )
            .await;
        }
    }
}

async fn answer(stdin: &Mutex<ChildStdin>, value: Value) {
    let mut held = stdin.lock().await;
    if let Err(error) = write_json_line(&mut held, &value).await {
        tracing::warn!("could not answer codex: {error}");
    }
}

/// app-server may clear a request because another client answered it or its
/// turn ended. Remove the pending UI card without sending a second response.
async fn resolve_ask(
    params: &Value,
    expected_thread: Option<&str>,
    asks: &AskMap,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(expected_thread) = expected_thread else {
        return;
    };
    if params.get("threadId").and_then(Value::as_str) != Some(expected_thread) {
        return;
    }
    let Some(request_id) = params.get("requestId").and_then(request_key) else {
        return;
    };
    if asks.lock().await.remove(&request_id).is_some() {
        let _ = events.send(SessionEvent::PermissionResolved {
            request_id,
            outcome: PermissionOutcome::Canceled,
        });
    }
}

#[derive(Clone)]
struct Question {
    id: String,
    header: String,
    question: String,
    /// Option ids we invent (their position), paired with the label to send back.
    options: Vec<(String, String)>,
}

impl Question {
    fn interaction(&self) -> InteractionQuestion {
        InteractionQuestion {
            id: self.id.clone(),
            prompt: self.question.clone(),
            allow_multiple: false,
            // Codex's request-user-input surface always offers an "Other"
            // answer in addition to any suggested choices.
            allow_freeform: true,
            options: self
                .options
                .iter()
                .map(|(id, label)| InteractionOption {
                    id: id.clone(),
                    label: label.clone(),
                })
                .collect(),
        }
    }
}

fn question_in(value: &Value) -> Option<Question> {
    let text = |field: &str| {
        value
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let options: Vec<(String, String)> = value
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .enumerate()
                .filter_map(|(index, option)| {
                    let label = option.get("label").and_then(Value::as_str)?;
                    Some((index.to_string(), label.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Question {
        id: text("id")?,
        header: text("header")?,
        question: text("question")?,
        options,
    })
}

fn codex_answers(
    questions: &[Question],
    outcome: &PermissionOutcome,
) -> serde_json::Map<String, Value> {
    let mut result = serde_json::Map::new();
    let submitted = match outcome {
        PermissionOutcome::Answered { answers } => answers.as_slice(),
        _ => &[],
    };
    for question in questions {
        let Some(answer) = submitted
            .iter()
            .find(|answer| answer.question_id == question.id)
        else {
            continue;
        };
        let mut values: Vec<String> = answer
            .selected_option_ids
            .iter()
            .filter_map(|picked| {
                question
                    .options
                    .iter()
                    .find(|(id, _)| id == picked)
                    .map(|(_, label)| label.clone())
            })
            .collect();
        if let Some(text) = answer
            .freeform_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            values.push(text.to_string());
        }
        if !values.is_empty() {
            result.insert(question.id.clone(), json!({ "answers": values }));
        }
    }
    result
}

async fn translate(
    method: &str,
    params: &Value,
    expected_thread: Option<&str>,
    turn: &Mutex<TurnState>,
    events: &broadcast::Sender<SessionEvent>,
) {
    // This warning belongs to the process, not to any conversation. All other
    // notifications handled below are thread-scoped in app-server v2; missing
    // provenance is ambiguous and is safer to ignore than to attach to root.
    if method == "configWarning" {
        // Read outside the macro: `tracing`'s own `Value` trait is in scope
        // inside one, and it would shadow `serde_json::Value` here.
        let summary = params
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("no summary");
        tracing::warn!("codex config warning: {summary}");
        return;
    }
    let Some(expected_thread) = expected_thread else {
        return;
    };
    if params.get("threadId").and_then(Value::as_str) != Some(expected_thread) {
        return;
    }

    let mut state = turn.lock().await;
    match method {
        // A duplicate is harmless; a second distinct start while this GeneHub
        // turn is already bound is stale and must not hijack it.
        "turn/started" if state.id.is_some() && state.codex_turn.is_none() => {
            state.codex_turn = notification_turn_id(params).map(str::to_string);
        }
        "turn/completed" if is_current_turn(params, &state) => finish(&mut state, params, events),
        "thread/tokenUsage/updated" if accepts_token_usage(params, &state) => {
            if let Some(usage) = usage_in(params) {
                let rounds = state.usage.llm_rounds;
                let tool_out = state.usage.tool_output_tokens;
                let previous = state.usage.clone();
                state.usage = usage;
                state.usage.llm_rounds = rounds;
                state.usage.tool_output_tokens = tool_out;
                usage::preserve_timing(&mut state.usage, &previous);
                if let Some(turn_id) = state.id.clone() {
                    usage::emit_progress(events, &turn_id, &state.usage);
                }
            }
        }
        "item/started" | "item/completed" if is_current_turn(params, &state) => {
            if let Some(item) = params.get("item") {
                item_frame(item, method == "item/completed", &mut state, events);
            }
        }
        "item/agentMessage/delta" if is_current_turn(params, &state) => {
            stream(params, Kind::Assistant, &mut state, events)
        }
        "item/reasoning/summaryTextDelta" if is_current_turn(params, &state) => {
            stream(params, Kind::Reasoning, &mut state, events)
        }
        "turn/plan/updated" if is_current_turn(params, &state) => plan(params, &mut state, events),
        "thread/compacted" if is_current_turn(params, &state) => {
            if let Some(turn_id) = state.id.clone() {
                state.unpaired_compactions += 1;
                let _ = events.send(SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::Compaction {
                        id: format!("compaction-{}", uuid::Uuid::new_v4().simple()),
                        reason: "Codex pruned its own history to make room.".into(),
                    },
                });
            }
        }
        _ => {}
    }
}

/// The upstream turn named by a v2 notification. Most carry `turnId`; the two
/// lifecycle frames carry the same id inside their `turn` object.
fn notification_turn_id(params: &Value) -> Option<&str> {
    params.get("turnId").and_then(Value::as_str).or_else(|| {
        params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
    })
}

fn bind_started_turn_from_response(state: &mut TurnState, genehub_turn: &str, upstream_turn: &str) {
    if state.id.as_deref() != Some(genehub_turn) {
        return;
    }
    match state.codex_turn.as_deref() {
        Some(bound) if bound != upstream_turn => tracing::warn!(
            "codex turn/start response replaced notification turn {bound} with {upstream_turn}"
        ),
        _ => {}
    }
    // This response is correlated to our own `turn/start` RPC, so it is
    // authoritative if a stale same-thread start raced ahead.
    state.codex_turn = Some(upstream_turn.to_string());
}

fn is_current_turn(params: &Value, state: &TurnState) -> bool {
    state.codex_turn.as_deref() == notification_turn_id(params) && state.codex_turn.is_some()
}

fn accepts_token_usage(params: &Value, state: &TurnState) -> bool {
    // Resume may replay the last thread usage while no GeneHub turn is open.
    // A usage frame can also beat `turn/started` binding; drop neither.
    state.id.is_none() || state.codex_turn.is_none() || is_current_turn(params, state)
}

/// Closes out the turn in flight.
fn finish(state: &mut TurnState, params: &Value, events: &broadcast::Sender<SessionEvent>) {
    let Some(turn_id) = state.id.take() else {
        return;
    };
    let turn = params.get("turn");
    let status = turn
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let failure = turn
        .and_then(|turn| turn.get("error"))
        .filter(|error| !error.is_null());

    let interrupted = state.interrupt_requested
        || matches!(status, "interrupted" | "canceled" | "cancelled" | "aborted");
    let event = if interrupted {
        SessionEvent::TurnCanceled { turn_id }
    } else if let Some(error) = failure {
        SessionEvent::TurnFailed {
            turn_id,
            error: TurnError {
                code: TurnErrorCode::Upstream,
                message: message_in(error),
            },
        }
    } else if status == "failed" {
        SessionEvent::TurnFailed {
            turn_id,
            error: TurnError {
                code: TurnErrorCode::Upstream,
                message: "Codex ended the turn without saying why. 日志里有它这一趟的全部输出。"
                    .into(),
            },
        }
    } else {
        let mut usage = state.usage.clone();
        usage::finalize_output_rate(&mut usage);
        SessionEvent::TurnCompleted {
            turn_id,
            usage,
            fork_checkpoint: state.codex_turn.clone(),
        }
    };

    state.codex_turn = None;
    state.interrupt_requested = false;
    state.open.clear();
    let _ = events.send(event);
}

/// A failure's own account of itself, whether it arrived as a string or an
/// object with a message in it.
fn message_in(error: &Value) -> String {
    error
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| error.to_string())
}

fn usage_in(params: &Value) -> Option<Usage> {
    let token_usage = params.get("tokenUsage")?;
    let source = token_usage
        .get("total")
        .or_else(|| token_usage.get("last"))?;
    let count = |field: &str| source.get(field).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cache_read_tokens: count("cachedInputTokens"),
        cache_write_tokens: 0,
        ..Usage::default()
    })
}

/// Streamed text for an item, which may be the first anyone has heard of it.
fn stream(
    params: &Value,
    kind: Kind,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
        return;
    };
    let delta = params
        .get("delta")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if delta.is_empty() {
        return;
    }
    usage::record_first_token(&mut state.usage);
    usage::record_visible_output(&mut state.usage, &delta);
    if state.open.contains(item_id) {
        let _ = events.send(SessionEvent::ItemDelta {
            turn_id,
            item_id: item_id.to_string(),
            delta: ItemDelta::Text { delta },
        });
        return;
    }
    state.open.insert(item_id.to_string());
    let id = item_id.to_string();
    let item = match kind {
        Kind::Assistant => TimelineItem::AssistantMessage { id, text: delta },
        Kind::Reasoning => TimelineItem::Reasoning { id, text: delta },
    };
    let _ = events.send(SessionEvent::Item { turn_id, item });
}

/// One `item/started` or `item/completed`, translated.
///
/// Both go out as `Item` events keyed by the CLI's own item id: an item that
/// starts and then completes upserts in place, which is the shape the timeline
/// and the frontend already expect.
fn item_frame(
    item: &Value,
    settled: bool,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let Some(kind) = item.get("type").and_then(Value::as_str) else {
        return;
    };
    let Some(id) = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return;
    };
    let text_of = |field: &str| {
        item.get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let emit = |item: TimelineItem| {
        let _ = events.send(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item,
        });
    };

    match kind {
        // Our own copy of what the user said is already on the timeline; the CLI
        // echoing it back is not a second message.
        "userMessage" => {}
        // Remembered even once it has completed, and cleared with the turn: a
        // delta that arrives after the settled frame must extend the message,
        // not be mistaken for a new one and replace the whole text with itself.
        "agentMessage" => {
            state.open.insert(id.clone());
            emit(TimelineItem::AssistantMessage {
                id,
                text: text_of("text"),
            });
            if settled {
                state.usage.llm_rounds += 1;
                usage::record_round_start(&mut state.usage);
                usage::emit_progress(events, &turn_id, &state.usage);
            }
        }
        "reasoning" => {
            state.open.insert(id.clone());
            emit(TimelineItem::Reasoning {
                id,
                text: reasoning_text(item),
            });
        }
        "commandExecution" => emit(TimelineItem::ToolCall {
            id,
            name: "Shell".into(),
            status: tool_status(item, settled),
            detail: ToolCallDetail::Shell {
                command: command_text(item.get("command")),
                output: item
                    .get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                exit_code: item
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .map(|code| code as i32),
            },
            images: vec![],
        }),
        "fileChange" => emit(TimelineItem::ToolCall {
            id,
            name: "Edit".into(),
            status: tool_status(item, settled),
            detail: edit_detail(item),
            images: vec![],
        }),
        "mcpToolCall" => {
            let tool = text_of("tool");
            let server = text_of("server");
            let name = if server.is_empty() {
                tool
            } else {
                format!("{server}.{tool}")
            };
            let images = mcp_result_images(item, &name);
            emit(TimelineItem::ToolCall {
                id,
                name,
                status: tool_status(item, settled),
                detail: ToolCallDetail::Unknown { raw: item.clone() },
                images,
            });
        }
        // The agent opened a local image. Only the path crosses the wire — the
        // daemon reads the workspace file for the thumbnail, so the row stays
        // a path reference rather than a blob.
        "imageView" => {
            let path = text_of("path");
            emit(TimelineItem::ToolCall {
                id,
                name: "View image".into(),
                status: tool_status(item, settled),
                detail: ToolCallDetail::Overview {
                    tool_kind: ToolKind::Read,
                    overview: path.clone(),
                    input: path.clone(),
                    output: String::new(),
                },
                images: vec![ToolImage {
                    alt: format!("View image: {path}"),
                    mime: crate::session::images::mime_from_path(&path),
                    data_base64: None,
                    thumb: None,
                    path: Some(path),
                }],
            });
        }
        "webSearch" => emit(TimelineItem::ToolCall {
            id,
            name: "Web search".into(),
            status: tool_status(item, settled),
            detail: ToolCallDetail::Search {
                query: text_of("query"),
                // It reports what it searched for, not what it found.
                matches: Vec::new(),
            },
            images: vec![],
        }),
        // A sub-agent this turn dispatched. The card says who was asked and
        // what for; its own steps arrive on a thread of their own, which is not
        // plumbed through here yet, so `items` stays empty rather than the card
        // pretending to be the whole story.
        "collabAgentToolCall" => emit(TimelineItem::ToolCall {
            id,
            name: "Sub-agent".into(),
            status: tool_status(item, settled),
            detail: ToolCallDetail::SubAgent {
                agent: text_of("tool"),
                prompt: text_of("prompt"),
                items: Vec::new(),
            },
            images: vec![],
        }),
        "subAgentActivity" => {
            let path = text_of("agentPath");
            emit(TimelineItem::ToolCall {
                id,
                name: match path.as_str() {
                    "" => "Sub-agent".to_string(),
                    // `/root` is the canonical main-agent path and commonly
                    // appears when a child sends its result back. Showing the
                    // raw path made that return look like a child named root.
                    "/root" => "Main agent".to_string(),
                    _ => path,
                },
                status: match item.get("kind").and_then(Value::as_str) {
                    Some("interrupted") => ToolStatus::Canceled,
                    _ if settled => ToolStatus::Ok,
                    _ => ToolStatus::Running,
                },
                detail: ToolCallDetail::Unknown { raw: item.clone() },
                images: vec![],
            });
        }
        "contextCompaction" => {
            // The same squeeze already produced a marker via `thread/compacted`;
            // only emit when no notification is waiting to be paired.
            if state.unpaired_compactions > 0 {
                state.unpaired_compactions -= 1;
            } else {
                emit(TimelineItem::Compaction {
                    id,
                    reason: "Codex pruned its own history to make room.".into(),
                });
            }
        }
        "error" => emit(TimelineItem::Error {
            id,
            message: match item.get("message") {
                Some(message) => message_in(message),
                None => message_in(item),
            },
        }),
        // Something this build emits that we have no renderer for. Shown rather
        // than dropped, with everything it said kept in the raw payload: a
        // missing renderer must never become a missing event
        // (`docs/architecture.md` §3, boundary B2).
        other => emit(TimelineItem::ToolCall {
            id,
            name: other.to_string(),
            status: tool_status(item, settled),
            detail: ToolCallDetail::Unknown { raw: item.clone() },
            images: vec![],
        }),
    }
}

/// A reasoning item's text, which is a summary this CLI may hand over as a
/// string or as a list of paragraphs.
fn reasoning_text(item: &Value) -> String {
    for field in ["text", "summary"] {
        match item.get(field) {
            Some(Value::String(text)) => return text.clone(),
            Some(Value::Array(parts)) => {
                let joined: Vec<String> = parts
                    .iter()
                    .filter_map(|part| {
                        part.as_str().map(str::to_string).or_else(|| {
                            part.get("text").and_then(Value::as_str).map(str::to_string)
                        })
                    })
                    .collect();
                if !joined.is_empty() {
                    return joined.join("\n\n");
                }
            }
            _ => {}
        }
    }
    String::new()
}

/// A command as this CLI reports it: one string, or the argv it will run.
fn command_text(command: Option<&Value>) -> String {
    match command {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// The edit a `fileChange` item describes.
///
/// Its `changes` have carried more than one field name across versions, so this
/// reads whichever it finds rather than insisting on one — and falls back to the
/// raw payload instead of showing an edit with no diff in it.
fn edit_detail(item: &Value) -> ToolCallDetail {
    let Some(changes) = item.get("changes").and_then(Value::as_array) else {
        return ToolCallDetail::Unknown { raw: item.clone() };
    };
    let mut paths: Vec<String> = Vec::new();
    let mut diff = String::new();
    for change in changes {
        if let Some(path) = change.get("path").and_then(Value::as_str) {
            paths.push(path.to_string());
        }
        for field in ["unifiedDiff", "unified_diff", "diff"] {
            if let Some(text) = change.get(field).and_then(Value::as_str) {
                if !diff.is_empty() {
                    diff.push('\n');
                }
                diff.push_str(text);
                break;
            }
        }
    }
    if paths.is_empty() {
        return ToolCallDetail::Unknown { raw: item.clone() };
    }
    ToolCallDetail::Edit {
        path: paths.join(", "),
        diff,
    }
}

fn tool_status(item: &Value, settled: bool) -> ToolStatus {
    if matches!(item.get("error"), Some(error) if !error.is_null()) {
        return ToolStatus::Error;
    }
    match item.get("status").and_then(Value::as_str) {
        Some("inProgress" | "running" | "pending") => ToolStatus::Running,
        Some("completed" | "success") => ToolStatus::Ok,
        Some("failed" | "error" | "errored") => ToolStatus::Error,
        Some("canceled" | "cancelled" | "interrupted" | "aborted") => ToolStatus::Canceled,
        // No status of its own: which frame this is says as much.
        _ if settled => ToolStatus::Ok,
        _ => ToolStatus::Running,
    }
}

/// The turn's plan, re-sent in full whenever it changes.
fn plan(params: &Value, state: &mut TurnState, events: &broadcast::Sender<SessionEvent>) {
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    let Some(steps) = params.get("plan").and_then(Value::as_array) else {
        return;
    };
    let items: Vec<TodoEntry> = steps
        .iter()
        .filter_map(|entry| {
            let text = entry
                .get("step")
                .and_then(Value::as_str)
                .or_else(|| entry.get("text").and_then(Value::as_str))?;
            Some(TodoEntry {
                text: text.to_string(),
                status: match entry.get("status").and_then(Value::as_str) {
                    Some("in_progress" | "inProgress") => TodoStatus::InProgress,
                    Some("completed") => TodoStatus::Completed,
                    _ => TodoStatus::Pending,
                },
            })
        })
        .collect();
    // One list per turn, upserted in place: the whole plan arrives on every
    // revision, and a card per revision would bury the conversation.
    let id = format!("{turn_id}-plan");
    let _ = events.send(SessionEvent::Item {
        turn_id,
        item: TimelineItem::Todo { id, items },
    });
}

/// MCP tool results carry content blocks; the image ones would otherwise be
/// dropped by the text-only detail path. They are produced bytes, never
/// workspace reads, so no source path is attached.
fn mcp_result_images(item: &Value, name: &str) -> Vec<ToolImage> {
    item.get("result")
        .and_then(|result| result.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("image"))
                .filter_map(|block| {
                    Some(ToolImage {
                        alt: name.to_string(),
                        mime: block
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("image/png")
                            .to_string(),
                        data_base64: Some(block.get("data").and_then(Value::as_str)?.to_string()),
                        thumb: None,
                        path: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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

    #[test]
    fn request_keys_preserve_json_rpc_id_types() {
        assert_eq!(request_key(&json!(7)).as_deref(), Some("7"));
        assert_eq!(request_key(&json!("7")).as_deref(), Some("string:7"));
        assert_eq!(request_key(&Value::Null), None);
    }

    #[test]
    fn foreign_interactive_requests_have_least_authority_replies() {
        assert_eq!(
            unattended_request_result("item/commandExecution/requestApproval"),
            Some(json!({ "decision": "decline" }))
        );
        assert_eq!(
            unattended_request_result("item/fileChange/requestApproval"),
            Some(json!({ "decision": "decline" }))
        );
        assert_eq!(
            unattended_request_result("item/tool/requestUserInput"),
            Some(json!({ "answers": {} }))
        );
    }

    #[test]
    fn only_the_active_root_scope_can_surface_an_interactive_request() {
        let mut state = state();
        state.codex_turn = Some("root-turn".into());
        assert!(is_current_scope(
            &json!({ "threadId": "root-thread", "turnId": "root-turn" }),
            Some("root-thread"),
            &state,
        ));
        assert!(!is_current_scope(
            &json!({ "threadId": "child-thread", "turnId": "root-turn" }),
            Some("root-thread"),
            &state,
        ));
        assert!(!is_current_scope(
            &json!({ "threadId": "root-thread", "turnId": "stale-turn" }),
            Some("root-thread"),
            &state,
        ));
        state.id = None;
        assert!(!is_current_scope(
            &json!({ "threadId": "root-thread", "turnId": "root-turn" }),
            Some("root-thread"),
            &state,
        ));
    }

    #[tokio::test]
    async fn server_resolution_clears_only_the_root_threads_pending_request() {
        let asks: AskMap = Arc::default();
        asks.lock().await.insert(
            "7".into(),
            PendingAsk {
                upstream_id: json!(7),
                response: Ask::Decision,
            },
        );
        let (events, mut seen) = broadcast::channel(4);

        resolve_ask(
            &json!({ "threadId": "child-thread", "requestId": 7 }),
            Some("root-thread"),
            &asks,
            &events,
        )
        .await;
        assert!(asks.lock().await.contains_key("7"));

        resolve_ask(
            &json!({ "threadId": "root-thread", "requestId": 7 }),
            Some("root-thread"),
            &asks,
            &events,
        )
        .await;
        assert!(asks.lock().await.is_empty());
        assert!(matches!(
            seen.try_recv().expect("the external resolution"),
            SessionEvent::PermissionResolved {
                ref request_id,
                outcome: PermissionOutcome::Canceled,
            } if request_id == "7"
        ));
    }

    #[test]
    fn turn_start_response_is_authoritative_but_cannot_revive_a_finished_turn() {
        let mut active = state();
        active.codex_turn = Some("stale-turn".into());
        bind_started_turn_from_response(&mut active, "t1", "root-turn");
        assert_eq!(active.codex_turn.as_deref(), Some("root-turn"));

        let mut finished = TurnState::default();
        bind_started_turn_from_response(&mut finished, "t1", "root-turn");
        assert_eq!(finished.codex_turn, None);
    }

    /// app-server multiplexes root and sub-agent threads over one connection.
    /// A child finishing first must not leak its final answer into the root
    /// timeline or consume the root GeneHub turn.
    #[tokio::test]
    async fn a_child_thread_cannot_write_to_or_complete_the_root_turn() {
        let (events, mut seen) = broadcast::channel(16);
        let turn = Mutex::new(state());

        translate(
            "turn/started",
            &json!({
                "threadId": "root-thread",
                "turn": {
                    "id": "root-turn",
                    "items": [],
                    "itemsView": "full",
                    "status": "inProgress",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": null,
                    "durationMs": null,
                },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        let child_frames = [
            (
                "turn/started",
                json!({
                    "threadId": "child-thread",
                    "turn": {
                        "id": "child-turn", "items": [], "itemsView": "full",
                        "status": "inProgress", "error": null, "startedAt": 2,
                        "completedAt": null, "durationMs": null,
                    },
                }),
            ),
            (
                "turn/started",
                json!({
                    "threadId": "other-child-thread",
                    "turn": {
                        "id": "other-child-turn", "items": [], "itemsView": "full",
                        "status": "inProgress", "error": null, "startedAt": 3,
                        "completedAt": null, "durationMs": null,
                    },
                }),
            ),
            (
                "item/started",
                json!({
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "startedAtMs": 4_000,
                    "item": {
                        "type": "agentMessage", "id": "child-final", "text": "",
                        "phase": "final_answer", "memoryCitation": null,
                    },
                }),
            ),
            (
                "item/agentMessage/delta",
                json!({
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "itemId": "child-final",
                    "delta": "Audit complete and returned to the parent agent.",
                }),
            ),
            (
                "item/completed",
                json!({
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "completedAtMs": 5_000,
                    "item": {
                        "type": "agentMessage",
                        "id": "child-final",
                        "text": "Audit complete and returned to the parent agent.",
                        "phase": "final_answer",
                        "memoryCitation": null,
                    },
                }),
            ),
            (
                "thread/tokenUsage/updated",
                json!({
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "tokenUsage": {
                        "last": {
                            "inputTokens": 67_092,
                            "cachedInputTokens": 65_280,
                            "outputTokens": 231,
                            "reasoningOutputTokens": 0,
                            "totalTokens": 67_323,
                        },
                        "total": {
                            "inputTokens": 67_092,
                            "cachedInputTokens": 65_280,
                            "outputTokens": 231,
                            "reasoningOutputTokens": 0,
                            "totalTokens": 67_323,
                        },
                        "modelContextWindow": 258_400,
                    },
                }),
            ),
            (
                "turn/completed",
                json!({
                    "threadId": "child-thread",
                    "turn": {
                        "id": "child-turn", "items": [], "itemsView": "full",
                        "status": "completed", "error": null, "startedAt": 2,
                        "completedAt": 5, "durationMs": 3_000,
                    },
                }),
            ),
        ];
        for (method, params) in child_frames {
            translate(method, &params, Some("root-thread"), &turn, &events).await;
        }

        assert!(matches!(
            seen.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        {
            let state = turn.lock().await;
            assert_eq!(state.id.as_deref(), Some("t1"));
            assert_eq!(state.codex_turn.as_deref(), Some("root-turn"));
            assert_eq!(state.usage.input_tokens, 0);
        }

        translate(
            "item/started",
            &json!({
                "threadId": "root-thread",
                "turnId": "root-turn",
                "startedAtMs": 5_500,
                "item": {
                    "type": "agentMessage", "id": "root-final", "text": "",
                    "phase": "final_answer", "memoryCitation": null,
                },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "item/agentMessage/delta",
            &json!({
                "threadId": "root-thread",
                "turnId": "root-turn",
                "itemId": "root-final",
                "delta": "Done.",
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "item/completed",
            &json!({
                "threadId": "root-thread",
                "turnId": "root-turn",
                "completedAtMs": 5_600,
                "item": {
                    "type": "agentMessage", "id": "root-final", "text": "Done.",
                    "phase": "final_answer", "memoryCitation": null,
                },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "thread/tokenUsage/updated",
            &json!({
                "threadId": "root-thread",
                "turnId": "root-turn",
                "tokenUsage": {
                    "last": {
                        "inputTokens": 101,
                        "cachedInputTokens": 61,
                        "outputTokens": 13,
                        "reasoningOutputTokens": 0,
                        "totalTokens": 114,
                    },
                    "total": {
                        "inputTokens": 101,
                        "cachedInputTokens": 61,
                        "outputTokens": 13,
                        "reasoningOutputTokens": 0,
                        "totalTokens": 114,
                    },
                    "modelContextWindow": 258_400,
                },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "turn/completed",
            &json!({
                "threadId": "root-thread",
                "turn": {
                    "id": "root-turn", "items": [], "itemsView": "full",
                    "status": "completed", "error": null, "startedAt": 1,
                    "completedAt": 6, "durationMs": 5_000,
                },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        assert!(matches!(
            seen.try_recv().expect("the root answer started"),
            SessionEvent::Item {
                ref turn_id,
                item: TimelineItem::AssistantMessage { ref id, ref text },
            } if turn_id == "t1" && id == "root-final" && text.is_empty()
        ));
        assert!(matches!(
            seen.try_recv().expect("the root answer delta"),
            SessionEvent::ItemDelta {
                turn_id,
                item_id,
                delta: ItemDelta::Text { delta },
            } if turn_id == "t1" && item_id == "root-final" && delta == "Done."
        ));
        assert!(matches!(
            seen.try_recv().expect("the root answer completed"),
            SessionEvent::Item {
                ref turn_id,
                item: TimelineItem::AssistantMessage { ref id, ref text },
            } if turn_id == "t1" && id == "root-final" && text == "Done."
        ));
        loop {
            match seen.try_recv().expect("progress or completion") {
                SessionEvent::TurnProgress { .. } => continue,
                other => {
                    assert!(matches!(
                        other,
                        SessionEvent::TurnCompleted {
                            ref turn_id,
                            ref usage,
                            ref fork_checkpoint,
                            ..
                        } if turn_id == "t1"
                            && usage.input_tokens == 101
                            && usage.cache_read_tokens == 61
                            && usage.output_tokens == 13
                            && fork_checkpoint.as_deref() == Some("root-turn")
                    ));
                    break;
                }
            }
        }
        assert!(matches!(
            seen.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let state = turn.lock().await;
        assert_eq!(state.id, None);
        assert_eq!(state.codex_turn, None);
    }

    /// Thread and turn ids are separate gates. This intentionally reuses the
    /// root turn id on a foreign thread so the test fails if thread filtering
    /// is ever removed while turn filtering remains.
    #[tokio::test]
    async fn a_foreign_thread_is_rejected_even_if_its_turn_id_matches() {
        let (events, mut seen) = broadcast::channel(8);
        let turn = Mutex::new(state());
        translate(
            "turn/started",
            &json!({
                "threadId": "root-thread",
                "turn": { "id": "root-turn", "items": [], "status": "inProgress" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        translate(
            "item/completed",
            &json!({
                "threadId": "child-thread",
                "turnId": "root-turn",
                "completedAtMs": 1,
                "item": { "type": "agentMessage", "id": "foreign", "text": "not root" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "turn/completed",
            &json!({
                "threadId": "child-thread",
                "turn": { "id": "root-turn", "items": [], "status": "completed" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "turn/completed",
            &json!({
                "turn": { "id": "root-turn", "items": [], "status": "completed" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        assert!(matches!(
            seen.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let state = turn.lock().await;
        assert_eq!(state.id.as_deref(), Some("t1"));
        assert_eq!(state.codex_turn.as_deref(), Some("root-turn"));
    }

    /// A notification from the right thread can still be stale. It must match
    /// the root turn learned from `turn/started` before touching shared state.
    #[tokio::test]
    async fn a_stale_turn_on_the_root_thread_cannot_mutate_the_current_turn() {
        let (events, mut seen) = broadcast::channel(8);
        let turn = Mutex::new(state());
        translate(
            "turn/started",
            &json!({
                "threadId": "root-thread",
                "turn": { "id": "root-turn", "items": [], "status": "inProgress" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        for (method, params) in [
            (
                "item/completed",
                json!({
                    "threadId": "root-thread",
                    "turnId": "stale-turn",
                    "completedAtMs": 1,
                    "item": { "type": "agentMessage", "id": "stale", "text": "old" },
                }),
            ),
            (
                "thread/tokenUsage/updated",
                json!({
                    "threadId": "root-thread",
                    "turnId": "stale-turn",
                    "tokenUsage": { "last": { "inputTokens": 999 } },
                }),
            ),
            (
                "turn/completed",
                json!({
                    "threadId": "root-thread",
                    "turn": { "id": "stale-turn", "items": [], "status": "completed" },
                }),
            ),
        ] {
            translate(method, &params, Some("root-thread"), &turn, &events).await;
        }

        assert!(matches!(
            seen.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        {
            let state = turn.lock().await;
            assert_eq!(state.id.as_deref(), Some("t1"));
            assert_eq!(state.codex_turn.as_deref(), Some("root-turn"));
            assert_eq!(state.usage.input_tokens, 0);
        }

        translate(
            "turn/completed",
            &json!({
                "threadId": "root-thread",
                "turn": { "id": "root-turn", "items": [], "status": "completed" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        assert!(matches!(
            seen.try_recv().expect("the current root turn completes"),
            SessionEvent::TurnCompleted { .. }
        ));
    }

    /// Resume may replay the root thread's last usage while no turn is active.
    /// Keeping it preserves the adapter's existing cross-turn usage behavior.
    #[tokio::test]
    async fn idle_root_usage_is_kept_for_the_next_completed_turn() {
        let (events, mut seen) = broadcast::channel(4);
        let turn = Mutex::new(TurnState::default());
        translate(
            "thread/tokenUsage/updated",
            &json!({
                "threadId": "root-thread",
                "turnId": "previous-turn",
                "tokenUsage": { "last": {
                    "inputTokens": 120,
                    "cachedInputTokens": 40,
                    "outputTokens": 7,
                } },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        assert!(matches!(
            seen.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        {
            let mut state = turn.lock().await;
            assert_eq!(state.usage.input_tokens, 120);
            assert_eq!(state.usage.cache_read_tokens, 40);
            assert_eq!(state.usage.output_tokens, 7);
            let usage = state.usage.clone();
            *state = TurnState {
                id: Some("next-genehub-turn".into()),
                usage,
                ..TurnState::default()
            };
        }

        translate(
            "turn/started",
            &json!({
                "threadId": "root-thread",
                "turn": { "id": "next-root-turn", "items": [], "status": "inProgress" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "turn/completed",
            &json!({
                "threadId": "root-thread",
                "turn": { "id": "next-root-turn", "items": [], "status": "completed" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        assert!(matches!(
            seen.try_recv().expect("the next completed turn"),
            SessionEvent::TurnCompleted { ref usage, .. }
                if usage.input_tokens == 120
                    && usage.cache_read_tokens == 40
                    && usage.output_tokens == 7
        ));
    }

    /// Root-thread collaboration summaries mention child ids inside the item;
    /// those are content, not notification provenance, and remain visible.
    #[tokio::test]
    async fn root_thread_sub_agent_activity_remains_visible() {
        let (events, mut seen) = broadcast::channel(4);
        let turn = Mutex::new(state());
        translate(
            "turn/started",
            &json!({
                "threadId": "root-thread",
                "turn": { "id": "root-turn", "items": [], "status": "inProgress" },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;
        translate(
            "item/completed",
            &json!({
                "threadId": "root-thread",
                "turnId": "root-turn",
                "completedAtMs": 1,
                "item": {
                    "type": "subAgentActivity",
                    "id": "return-to-root",
                    "agentThreadId": "child-thread",
                    "agentPath": "/root",
                    "kind": "interacted",
                },
            }),
            Some("root-thread"),
            &turn,
            &events,
        )
        .await;

        assert!(matches!(
            seen.try_recv().expect("the root collaboration summary"),
            SessionEvent::Item {
                item: TimelineItem::ToolCall { ref name, .. },
                ..
            } if name == "Main agent"
        ));
    }

    /// The three pickers are the whole reason this adapter reads `model/list`,
    /// and a level that belongs to one model must not be offered for another.
    #[test]
    fn the_model_table_carries_each_models_own_thinking_levels() {
        let listed = json!({ "data": [
            {
                "id": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "isDefault": true,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast" },
                    { "reasoningEffort": "high", "description": "Deeper" },
                ],
            },
            { "id": "gpt-5.2", "supportedReasoningEfforts": [] },
            { "id": "internal-thing", "hidden": true },
        ] });

        let models = models_in(&listed);
        assert_eq!(models.len(), 2, "a hidden model was offered: {models:?}");
        assert_eq!(models[0].label, "GPT-5.6-Sol");
        assert_eq!(models[0].efforts, vec!["low", "high"]);
        assert!(models[0].reasoning);
        // No levels means no dial, and the control belongs nowhere near it.
        assert!(models[1].efforts.is_empty());
        assert!(!models[1].reasoning);

        assert_eq!(
            default_model_in(&listed),
            Some(("gpt-5.6-sol".into(), Some("medium".into())))
        );
    }

    /// A mode here is two of the CLI's settings at once, and `turn/start` wants
    /// the sandbox as an object rather than the string `thread/start` takes.
    #[test]
    fn a_mode_is_an_approval_policy_and_a_sandbox_together() {
        let auto = mode_named("auto");
        assert_eq!(auto.approval, "on-request");
        assert_eq!(
            sandbox_policy(auto),
            json!({ "type": "workspaceWrite", "networkAccess": false })
        );

        let full = mode_named("full-access");
        assert_eq!(full.approval, "never");
        assert_eq!(sandbox_policy(full), json!({ "type": "dangerFullAccess" }));

        assert_eq!(
            sandbox_policy(mode_named("read-only")),
            json!({ "type": "readOnly" })
        );
        // An unknown name falls back to the mode a session starts in, not to
        // whichever happens to be first in the list.
        assert_eq!(mode_named("no-such-mode").id, DEFAULT_MODE);
    }

    #[test]
    fn app_server_launch_and_thread_defaults_are_unrestricted() {
        assert_eq!(
            app_server_args(),
            [
                "app-server",
                "-c",
                r#"approval_policy="never""#,
                "-c",
                r#"sandbox_mode="danger-full-access""#,
            ]
        );
        let params = with_thread_policy(json!({ "threadId": "t1" }), mode_named(DEFAULT_MODE));
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["sandbox"], "danger-full-access");

        let explicit = with_thread_policy(json!({}), mode_named("read-only"));
        assert_eq!(explicit["approvalPolicy"], "on-request");
        assert_eq!(explicit["sandbox"], "read-only");
    }

    #[test]
    fn artifact_guidance_uses_codex_developer_instructions() {
        let params = with_developer_instructions(
            json!({ "cwd": "/tmp/workspace" }),
            Some("Use https://app.example/assets/preview/v2/device/workspace/r_root/"),
        );
        assert_eq!(
            params["developerInstructions"],
            "Use https://app.example/assets/preview/v2/device/workspace/r_root/"
        );
        assert!(with_developer_instructions(json!({}), None)
            .get("developerInstructions")
            .is_none());
    }

    #[test]
    fn a_streamed_reply_opens_one_item_and_then_extends_it() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();
        let delta = |text: &str| json!({ "itemId": "item-1", "delta": text });

        stream(&delta("Hel"), Kind::Assistant, &mut state, &events);
        stream(&delta("lo"), Kind::Assistant, &mut state, &events);

        match seen.try_recv().expect("an item") {
            SessionEvent::Item {
                item: TimelineItem::AssistantMessage { id, text },
                ..
            } => {
                assert_eq!(id, "item-1");
                assert_eq!(text, "Hel");
            }
            other => panic!("unexpected {other:?}"),
        }
        match seen.try_recv().expect("a delta") {
            SessionEvent::ItemDelta {
                item_id,
                delta: ItemDelta::Text { delta },
                ..
            } => {
                assert_eq!(item_id, "item-1");
                assert_eq!(delta, "lo");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// A command that ran is the one tool card someone reads output from, and
    /// this CLI hands the command over as argv rather than a line of shell.
    #[test]
    fn a_command_item_becomes_a_shell_card_with_its_output_and_code() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();
        let item = json!({
            "type": "commandExecution",
            "id": "call-1",
            "status": "completed",
            "command": ["ls", "-a"],
            "aggregatedOutput": "README.md\n",
            "exitCode": 0,
        });

        item_frame(&item, true, &mut state, &events);

        match seen.try_recv().expect("a tool call") {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { status, detail, .. },
                ..
            } => {
                assert_eq!(status, ToolStatus::Ok);
                assert_eq!(
                    detail,
                    ToolCallDetail::Shell {
                        command: "ls -a".into(),
                        output: "README.md\n".into(),
                        exit_code: Some(0),
                    }
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// An item type nobody here has seen must still reach the screen: a missing
    /// renderer is not a licence to drop the event.
    #[test]
    fn an_unknown_item_type_is_still_shown() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();

        item_frame(
            &json!({ "type": "somethingNew", "id": "x1", "note": "hello" }),
            true,
            &mut state,
            &events,
        );

        match seen.try_recv().expect("an item") {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { name, detail, .. },
                ..
            } => {
                assert_eq!(name, "somethingNew");
                assert!(matches!(detail, ToolCallDetail::Unknown { .. }));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// We asked it to stop, so the end of this turn is a cancellation — whatever
    /// the CLI's own label for it says.
    #[test]
    fn a_turn_we_interrupted_ends_as_canceled() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();
        state.interrupt_requested = true;

        finish(
            &mut state,
            &json!({ "turn": { "status": "completed" } }),
            &events,
        );

        assert!(matches!(
            seen.try_recv().expect("an end"),
            SessionEvent::TurnCanceled { .. }
        ));
    }

    #[test]
    fn a_failed_turn_carries_the_reason_it_gave() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();

        finish(
            &mut state,
            &json!({ "turn": { "status": "failed", "error": { "message": "usage limit reached" } } }),
            &events,
        );

        match seen.try_recv().expect("an end") {
            SessionEvent::TurnFailed { error, .. } => {
                assert_eq!(error.message, "usage limit reached");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Tokens arrive on a notification of their own, ahead of the turn ending,
    /// so they have to be held until there is a completed turn to report.
    #[test]
    fn token_counts_ride_along_with_the_completed_turn() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();
        state.codex_turn = Some("turn-7".into());
        state.usage = usage_in(&json!({ "tokenUsage": { "last": {
            "inputTokens": 120,
            "cachedInputTokens": 40,
            "outputTokens": 7,
        } } }))
        .expect("usage parses");

        finish(
            &mut state,
            &json!({ "turn": { "status": "completed" } }),
            &events,
        );

        match seen.try_recv().expect("an end") {
            SessionEvent::TurnCompleted {
                usage,
                fork_checkpoint,
                ..
            } => {
                assert_eq!(usage.input_tokens, 120);
                assert_eq!(usage.cache_read_tokens, 40);
                assert_eq!(usage.output_tokens, 7);
                assert_eq!(fork_checkpoint.as_deref(), Some("turn-7"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_plan_becomes_one_todo_list_that_is_updated_in_place() {
        let (events, mut seen) = broadcast::channel(8);
        let mut state = state();
        let frame = |second: &str| {
            json!({ "plan": [
                { "step": "read the code", "status": "completed" },
                { "step": "write the fix", "status": second },
            ] })
        };

        plan(&frame("in_progress"), &mut state, &events);
        plan(&frame("completed"), &mut state, &events);

        let first = seen.try_recv().expect("a todo list");
        let second = seen.try_recv().expect("the same list again");
        let ids = [&first, &second].map(|event| match event {
            SessionEvent::Item {
                item: TimelineItem::Todo { id, .. },
                ..
            } => id.clone(),
            other => panic!("unexpected {other:?}"),
        });
        assert_eq!(ids[0], ids[1], "a revised plan opened a second card");
        match second {
            SessionEvent::Item {
                item: TimelineItem::Todo { items, .. },
                ..
            } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[1].status, TodoStatus::Completed);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// The reply shape is the whole point of splitting these: an approval takes
    /// a decision, a question takes the label that was picked.
    #[test]
    fn an_approval_is_answered_with_a_decision() {
        assert_eq!(
            decision(&PermissionOutcome::Selected {
                option_id: ALLOW.into()
            }),
            "accept"
        );
        assert_eq!(
            decision(&PermissionOutcome::Selected {
                option_id: DENY.into()
            }),
            "decline"
        );
        assert_eq!(decision(&PermissionOutcome::Canceled), "cancel");
        // Nobody was there. Declined, and the agent is told so rather than
        // being left waiting.
        assert_eq!(
            decision(&PermissionOutcome::TimedOut {
                applied_default: "deny".into()
            }),
            "decline"
        );
    }

    #[test]
    fn a_question_keeps_the_labels_it_has_to_send_back() {
        let question = question_in(&json!({
            "id": "q1",
            "header": "Which database?",
            "question": "Pick one to migrate first.",
            "options": [{ "label": "Postgres" }, { "label": "SQLite" }],
        }))
        .expect("a question with options");
        assert_eq!(question.id, "q1");
        assert_eq!(
            question.options,
            vec![
                ("0".to_string(), "Postgres".to_string()),
                ("1".to_string(), "SQLite".to_string())
            ]
        );

        let freeform = question_in(&json!({ "id": "q", "header": "h", "question": "q" }))
            .expect("free-text questions are renderable");
        assert!(freeform.interaction().allow_freeform);

        let answers = codex_answers(
            &[question, freeform],
            &PermissionOutcome::Answered {
                answers: vec![
                    genehub_proto::InteractionAnswer {
                        question_id: "q1".into(),
                        selected_option_ids: vec!["1".into()],
                        freeform_text: None,
                    },
                    genehub_proto::InteractionAnswer {
                        question_id: "q".into(),
                        selected_option_ids: vec![],
                        freeform_text: Some("Use the existing cluster".into()),
                    },
                ],
            },
        );
        assert_eq!(answers["q1"]["answers"], json!(["SQLite"]));
        assert_eq!(answers["q"]["answers"], json!(["Use the existing cluster"]));
    }

    #[test]
    fn an_edit_falls_back_to_the_raw_payload_rather_than_an_empty_diff() {
        let with_diff = json!({ "changes": [
            { "path": "src/main.rs", "unifiedDiff": "@@ -1 +1 @@\n-a\n+b\n" },
        ] });
        assert_eq!(
            edit_detail(&with_diff),
            ToolCallDetail::Edit {
                path: "src/main.rs".into(),
                diff: "@@ -1 +1 @@\n-a\n+b\n".into(),
            }
        );

        let shapeless = json!({ "changes": [{ "note": "who knows" }] });
        assert!(matches!(
            edit_detail(&shapeless),
            ToolCallDetail::Unknown { .. }
        ));
    }

    /// The frontend draws its controls from this and nothing else, so every
    /// `true` here is a promise something below actually keeps.
    #[test]
    fn every_declared_capability_has_something_behind_it() {
        let declared = CodexAdapter::default().capabilities();
        assert!(declared.interrupt, "turn/interrupt is implemented");
        assert!(declared.set_model, "every turn carries the model");
        assert!(declared.set_effort, "every turn carries the level");
        assert!(declared.set_mode, "every turn carries the policy");
        assert!(declared.permissions, "its approvals are answered here");
        assert!(declared.resume, "thread/resume is wired up");
        assert!(declared.attachments, "localImage is wired up");
    }

    #[test]
    fn a_resume_handle_only_counts_when_it_is_ours_and_names_a_thread() {
        assert_eq!(resume_thread_id(&None), None);
        assert_eq!(
            resume_thread_id(&Some(PersistHandle {
                agent_id: "claude".into(),
                value: json!({ "threadId": "t1" }),
            })),
            None
        );
        assert_eq!(
            resume_thread_id(&Some(PersistHandle {
                agent_id: "codex".into(),
                value: json!({ "threadId": "" }),
            })),
            None
        );
        assert_eq!(
            resume_thread_id(&Some(PersistHandle {
                agent_id: "codex".into(),
                value: json!({ "threadId": "thread_abc" }),
            })),
            Some("thread_abc".into())
        );
    }

    #[test]
    fn an_archived_thread_is_recognised_from_the_error_wording() {
        assert!(archived_thread(
            "session thread_abc is archived. Run `codex unarchive thread_abc`",
            "thread_abc"
        ));
        assert!(!archived_thread("thread_abc not found", "thread_abc"));
        assert!(!archived_thread("session other is archived", "thread_abc"));
    }

    #[test]
    fn a_pasted_image_becomes_a_local_image_path_on_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let input = PromptInput {
            text: "look".into(),
            attachments: vec![genehub_proto::Attachment {
                name: "shot.png".into(),
                mime: "image/png".into(),
                path: None,
                // "hi" in standard base64.
                data_base64: Some("aGk=".into()),
            }],
        };

        let blocks = turn_input(&input, dir.path()).expect("input builds");
        assert_eq!(blocks[0], json!({ "type": "text", "text": "look" }));
        let path = blocks[1]["path"].as_str().expect("a path");
        assert!(path.ends_with(".png"), "{path}");
        assert_eq!(std::fs::read(path).expect("file written"), b"hi");
        assert_eq!(blocks[1]["type"], "localImage");
    }

    #[test]
    fn base64_decodes_the_composers_padded_payload() {
        assert_eq!(decode_base64("aGk=").expect("decodes"), b"hi");
        assert_eq!(decode_base64("YQ==").expect("decodes"), b"a");
        assert!(decode_base64("!!!").is_err());
    }

    #[test]
    fn mcp_image_content_becomes_produced_tool_images() {
        let item = json!({
            "result": {"content": [
                {"type": "text", "text": "ok"},
                {"type": "image", "data": "aGk=", "mimeType": "image/png"},
            ]},
        });
        let images = mcp_result_images(&item, "shot.screenshot");
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].alt, "shot.screenshot");
        assert_eq!(images[0].mime, "image/png");
        assert!(images[0].path.is_none());
        assert_eq!(images[0].data_base64.as_deref(), Some("aGk="));
        assert!(mcp_result_images(&json!({"result": {"content": []}}), "t").is_empty());
    }
}
