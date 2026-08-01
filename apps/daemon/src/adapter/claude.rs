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
//!   stream-json --include-partial-messages --verbose --permission-prompt-tool
//!   stdio`, plus a `--permission-mode` naming "ask me about every tool" —
//!   which is what forces every tool call through us rather than either
//!   auto-running or blocking on a TTY prompt that does not exist here.
//!
//!   **That mode's name is not the same in every build**, and this cost a user
//!   a working Claude Code: 2.1.220 calls it `manual` and rejects `default`,
//!   while another build of the same version line calls it `default` and
//!   rejects `manual`. Either one hardcoded is a CLI that refuses to start for
//!   half the installs. So the name is read out of `claude --help` — see
//!   `ask_mode`.
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
//!   There is no wire-level "always allow this tool" reply the CLI
//!   understands (no documented `updatedPermissions` echo for this
//!   transport), so `AllowAlways` is enforced on our side: once picked, the
//!   tool name is remembered for the life of the process and every later
//!   `can_use_tool` for it is answered `allow` without ever reaching the
//!   frontend, the same short-circuit `acceptEdits` mode already uses below.
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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use genehub_proto::{
    Capabilities, Catalog, CommandInfo, ItemDelta, ModeInfo, ModelInfo, PermissionOption,
    PermissionOptionKind, PermissionOutcome, PermissionRequest, ProbeState, SessionEvent,
    TimelineItem, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, Mutex};

use super::stdio::write_json_line;
use super::{
    find_executable, AgentAdapter, AgentSession, Chatter, PersistHandle, PromptInput, ProviderMap,
    SessionConfig,
};

const BINARY: &str = "claude";
const EVENT_CAPACITY: usize = 1024;

/// Permission modes, named as the CLI names them on the wire — these go into
/// `--permission-mode` and `set_permission_mode` unchanged, and appear in the
/// CLI's own `permission_suggestions[].mode`, so a user reading either surface
/// sees the same word for the same thing.
const MODE_DEFAULT: &str = "default";
const MODE_ACCEPT_EDITS: &str = "acceptEdits";
const MODE_PLAN: &str = "plan";
const MODE_BYPASS: &str = "bypassPermissions";

/// The modes we offer, of the ones this CLI accepts.
///
/// Not every name in its `--permission-mode` list is here: 2.1.220 also accepts
/// `auto` and `dontAsk`, and nothing in the CLI or its help says what either one
/// does differently from these. A switch whose effect we cannot state is worse
/// than no switch, so they are left out until someone can describe them.
const MODES: [(&str, &str, &str); 3] = [
    (
        MODE_ACCEPT_EDITS,
        "Accept edits",
        "Apply file edits and commands without asking",
    ),
    (
        MODE_PLAN,
        "Plan",
        "Read and plan only — no edits and no commands",
    ),
    (
        MODE_BYPASS,
        "Bypass permissions",
        "Never ask about anything. Only for a workspace you could afford to lose",
    ),
];

/// How long the CLI gets to answer a control request before we give up on it.
/// Generous because a cold start on Windows is slow, and every caller here would
/// rather wait than be told a lie about what the CLI supports.
const CONTROL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Default)]
pub struct ClaudeAdapter {
    /// `claude --help`, read once per daemon run: it is the only place this CLI
    /// says which permission modes the build accepts, and the answer cannot
    /// change without the binary being replaced under us.
    help: tokio::sync::OnceCell<String>,
    /// What the CLI answered to an `initialize` control request — its model list,
    /// its slash commands, its sub-agents. Also asked once per daemon run.
    hello: tokio::sync::OnceCell<Option<Value>>,
    /// A CLI to run instead of the one on `PATH`.
    ///
    /// Only ever set by tests, and a field rather than an environment variable
    /// because `PATH` is process-wide: a test that changed it would change it for
    /// every other test running at the same time.
    program: Option<PathBuf>,
}

impl ClaudeAdapter {
    #[cfg(test)]
    fn with_program(program: PathBuf) -> Self {
        ClaudeAdapter {
            program: Some(program),
            ..ClaudeAdapter::default()
        }
    }

    fn program(&self) -> Option<PathBuf> {
        match &self.program {
            Some(explicit) => Some(explicit.clone()),
            None => find_executable(BINARY),
        }
    }

    /// This build's own help text, read once and remembered.
    async fn help(&self, program: &std::path::Path) -> &str {
        self.help
            .get_or_init(|| async {
                Command::new(program)
                    .arg("--help")
                    .output()
                    .await
                    .ok()
                    .map(|out| {
                        // Some builds print help on stderr. Both are cheap to read
                        // and only one of them has to contain the choices.
                        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
                        text.push_str(&String::from_utf8_lossy(&out.stderr));
                        text
                    })
                    .unwrap_or_default()
            })
            .await
    }

    /// The permission modes to offer for this build: the ones it accepts, of the
    /// ones we can describe.
    async fn modes(&self, program: &std::path::Path) -> Vec<ModeInfo> {
        let help = self.help(program).await;
        let mut modes = Vec::new();
        // Whatever this build calls "ask about everything" leads, because it is
        // the one that asks — a session should start in the cautious mode and be
        // moved out of it deliberately.
        if let Some(ask) = ask_mode_in(help) {
            modes.push(ModeInfo {
                id: ask.into(),
                label: "Default".into(),
                description: Some("Ask before every tool call".into()),
            });
        }
        for (id, label, description) in MODES {
            if mode_listed(help, id) {
                modes.push(ModeInfo {
                    id: id.into(),
                    label: label.into(),
                    description: Some(description.into()),
                });
            }
        }
        modes
    }

    /// The CLI's answer to an `initialize` control request, asked once per daemon
    /// run against a throwaway process.
    ///
    /// It has to be a process of its own: the model list is wanted for the agent
    /// picker, which is drawn long before anyone opens a session, and there is no
    /// way to ask this CLI anything without running it. The cost is one launch
    /// per daemon lifetime, and `initialize` reaches no model — it only reports
    /// what this install is configured with.
    async fn hello(&self, program: &std::path::Path) -> Option<Value> {
        self.hello
            .get_or_init(|| async { initialize(program).await })
            .await
            .clone()
    }
}

/// Runs one `initialize` control request and takes the answer away with it.
async fn initialize(program: &std::path::Path) -> Option<Value> {
    let mut command = Command::new(program);
    command
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ])
        // Somewhere that exists and says nothing about any of the user's
        // projects: this answer is cached for every workspace.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    super::without_a_window(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!("could not ask claude what it supports: {error}");
            return None;
        }
    };
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let request = json!({
        "type": "control_request",
        "request_id": "genehub_initialize",
        "request": { "subtype": "initialize" },
    });
    if let Err(error) = write_json_line(&mut stdin, &request).await {
        tracing::warn!("could not ask claude what it supports: {error}");
        return None;
    }

    let answer = tokio::time::timeout(CONTROL_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if frame.get("type").and_then(Value::as_str) != Some("control_response") {
                continue;
            }
            let Some(response) = frame.get("response") else {
                continue;
            };
            if response.get("subtype").and_then(Value::as_str) != Some("success") {
                let why = response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("no reason given")
                    .to_string();
                tracing::warn!("claude refused an initialize handshake: {why}");
                return None;
            }
            return response.get("response").cloned();
        }
        None
    })
    .await;

    // The process is only alive to answer this one question, and it does not exit
    // on its own: `--print` waits for a prompt it is never going to get.
    super::kill_tree(&mut child).await;

    match answer {
        Ok(answer) => answer,
        Err(_) => {
            tracing::warn!("claude did not answer an initialize handshake in time");
            None
        }
    }
}

/// The models this CLI says it can be pointed at, as it names them.
///
/// These are the CLI's own aliases (`default`, `opus`, `sonnet`, …), not model
/// names we invented: `set_model` is answered by the same CLI that listed them,
/// so anything here is a value it will accept. Which model an alias resolves to
/// stays this CLI's business — its env vars and its config file — and is shown
/// rather than decided (`docs/architecture.md` §3, boundary B1).
fn models_in(hello: &Value) -> Vec<ModelInfo> {
    let Some(models) = hello.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let id = model.get("value").and_then(Value::as_str)?;
            let flag = |name: &str| model.get(name).and_then(Value::as_bool).unwrap_or(false);
            Some(ModelInfo {
                id: id.to_string(),
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_window: None,
                reasoning: flag("supportsEffort") || flag("supportsAdaptiveThinking"),
                // Only when it says it takes them. A level sent to a model that
                // has none is a control that pretends to work.
                efforts: if flag("supportsEffort") {
                    model
                        .get("supportedEffortLevels")
                        .and_then(Value::as_array)
                        .map(|levels| {
                            levels
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default()
                } else {
                    Vec::new()
                },
            })
        })
        .collect()
}

/// The slash commands this install has, as it listed them.
///
/// Running one needs nothing from us — it goes to the CLI as ordinary prompt text
/// and the CLI recognises its own commands. The list is the part nobody outside
/// its terminal UI can see: on a normal install this is dozens of commands and
/// skills, and before asking for them our composer offered none of them.
fn commands_in(hello: &Value) -> Vec<CommandInfo> {
    let Some(commands) = hello.get("commands").and_then(Value::as_array) else {
        return Vec::new();
    };
    commands
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            let text = |field: &str| {
                command
                    .get(field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            Some(CommandInfo {
                name: name.to_string(),
                // Some of these are a paragraph long (a skill's trigger
                // description). Trimmed to something a menu row can hold; the
                // frontend gets to decide how much of that it shows.
                description: text("description").map(|description| shorten(&description, 240)),
                argument_hint: text("argumentHint"),
            })
        })
        .collect()
}

/// Cuts a string to at most `limit` characters, on a character boundary.
fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    // Back off to the last sentence or clause that fits, so it reads as an ending
    // rather than a cut cable.
    let cut = kept
        .rfind(['.', '。', '；', ';'])
        .map(|at| at + kept[at..].chars().next().map_or(1, char::len_utf8))
        .unwrap_or(kept.len());
    format!("{}…", kept[..cut].trim_end())
}

/// Whether `--permission-mode` lists this name among its choices.
fn mode_listed(help: &str, mode: &str) -> bool {
    let choices = help
        .split("--permission-mode")
        .nth(1)
        .map(|rest| rest.chars().take(400).collect::<String>())
        .unwrap_or_default();
    choices.contains(&format!("\"{mode}\""))
        || choices.contains(&format!("'{mode}'"))
        || choices.contains(&format!(" {mode},"))
        || choices.contains(&format!(" {mode} "))
}

/// Picks the "ask about everything" mode out of a `--help` listing.
///
/// Both names mean the same thing and no build accepts both, so this is a
/// question of vocabulary, not behaviour. `default` is preferred only because it
/// is the newer name; when neither appears the caller passes no flag at all
/// rather than guessing.
fn ask_mode_in(help: &str) -> Option<&'static str> {
    let listed = |name: &str| {
        help.contains(&format!("\"{name}\""))
            || help.contains(&format!("'{name}'"))
            || help.contains(&format!(" {name},"))
    };
    // Only where the CLI is actually listing permission modes. "default" is a
    // word that appears all over a help text.
    let choices = help
        .split("--permission-mode")
        .nth(1)
        .map(|rest| rest.chars().take(400).collect::<String>())
        .unwrap_or_default();
    let listed_in_choices = |name: &str| {
        choices.contains(&format!("\"{name}\""))
            || choices.contains(&format!("'{name}'"))
            || choices.contains(&format!(" {name},"))
    };
    if listed_in_choices("default") {
        return Some("default");
    }
    if listed_in_choices("manual") {
        return Some("manual");
    }
    // A build that documents the flag without listing its choices: the two names
    // may still be mentioned elsewhere in the text.
    if listed("default") {
        return Some("default");
    }
    if listed("manual") {
        return Some("manual");
    }
    None
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
            set_effort: true,
            interrupt: true,
            // Switching between them is a control request this CLI answers;
            // *which* models there are is still its own business (env vars, its
            // config file) and the catalog only ever repeats the list it gave us.
            // An install whose handshake told us nothing lists none, and the
            // frontend draws no picker for an empty list.
            set_model: true,
            set_mode: true,
            permissions: true,
            // `--resume <session-id>` is real; we just need the id back.
            resume: true,
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
        let Some(program) = self.program() else {
            return Catalog::default();
        };
        let hello = self.hello(&program).await;
        let models = hello.as_ref().map(models_in).unwrap_or_default();
        let commands = hello.as_ref().map(commands_in).unwrap_or_default();
        let modes = self.modes(&program).await;
        Catalog {
            // Which level it is on right now is not in anything it tells us, and
            // guessing would put a wrong answer on screen — the picker offers
            // "default" for exactly this reason.
            default_effort: None,
            commands,
            default_model: hello
                .as_ref()
                .and_then(|hello| hello.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string)
                // Which model is current is the CLI's to decide; when it does not
                // say, the first entry it listed is its own recommendation.
                .or_else(|| models.first().map(|model| model.id.clone())),
            // Whichever name this build uses for "ask about everything", which
            // `modes` puts first — a session starts cautious.
            default_mode: modes.first().map(|mode| mode.id.clone()),
            models,
            modes,
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
                "--permission-prompt-tool",
                "stdio",
            ])
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        super::without_a_window(&mut command);

        // A session created earlier and resumed now (or one whose mode was set
        // before its first prompt lazily started the process — see
        // `session::manager::ensure_started`) must not silently forget which mode
        // it was in. And the mode has to be in force from the first turn, which
        // means the launch flag: a session in `plan` that started in the asking
        // mode could edit a file before any `set_permission_mode` landed.
        // What this install said it had: which model to launch with, and the only
        // list a later `set_model` can be checked against. The CLI will not check
        // it for us — asked for a model it has never heard of, it answers
        // `success` and carries on with the one it already had.
        let models: Vec<String> = self
            .hello(&program)
            .await
            .as_ref()
            .map(models_in)
            .unwrap_or_default()
            .into_iter()
            .map(|model| model.id)
            .collect();

        // Every level any of its models named. The CLI does not check these either
        // — `effort: "nonsense"` also comes back `success` — so this list is what
        // a later `set_effort` gets checked against.
        let efforts: Vec<String> = self
            .hello(&program)
            .await
            .as_ref()
            .map(models_in)
            .unwrap_or_default()
            .into_iter()
            .flat_map(|model| model.efforts)
            .fold(Vec::new(), |mut levels, level| {
                if !levels.contains(&level) {
                    levels.push(level);
                }
                levels
            });

        let help = self.help(&program).await.to_string();
        let ask_mode = ask_mode_in(&help).map(str::to_string);
        let initial_mode = config
            .mode_id
            .clone()
            .filter(|id| MODES.iter().any(|(mode, ..)| mode == id) || Some(id) == ask_mode.as_ref())
            .or_else(|| ask_mode.clone())
            .unwrap_or_else(|| MODE_DEFAULT.to_string());
        // Only a name this build actually lists: an unlisted one is not ignored,
        // it makes the CLI refuse to start (which is how a hardcoded `manual`
        // once cost a user their Claude Code entirely).
        match Some(initial_mode.as_str())
            .filter(|mode| mode_listed(&help, mode))
            .or(ask_mode.as_deref())
        {
            Some(mode) => {
                command.args(["--permission-mode", mode]);
            }
            // A build that names this something we have never seen. Its own
            // configured default is a better guess than a name it will reject:
            // starting without the flag at least gets a session, and
            // `--permission-prompt-tool stdio` still routes whatever it does ask
            // about through us.
            None => tracing::warn!(
                "claude --help lists no permission mode we recognise; \
                 starting without --permission-mode"
            ),
        }

        // A model picked before the first prompt, which is the ordinary case: the
        // process only starts when there is something to send (see
        // `session::manager::ensure_started`), so without this the choice would be
        // recorded and then quietly dropped.
        //
        // Only an alias this install listed. Anything else is not ours to pass on:
        // a session's stored model may well name a provider's model rather than
        // one of this CLI's aliases (how Claude Code reaches a model is its own
        // business — `docs/architecture.md` §3, boundary B1), and passing that as
        // `--model` would either be ignored or stop it from starting.
        if let Some(model) = config
            .model_id
            .as_deref()
            .filter(|model| models.iter().any(|known| known == model))
        {
            command.args(["--model", model]);
        }

        // Same reason as `--model` above: chosen before the first prompt, and the
        // process does not exist until then.
        if let Some(effort) = config
            .effort_id
            .as_deref()
            .filter(|effort| efforts.iter().any(|known| known == effort))
        {
            command.args(["--effort", effort]);
        }

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

        // Kept, not dropped. When this CLI exits on its own, its stderr is the
        // only account of why — and it used to go to `tracing::debug!`, under the
        // default filter, which is how "Claude Code stopped unexpectedly." became
        // the entire error message.
        let said = Arc::new(Chatter::default());
        said.watch("claude", Some(stderr)).await;

        let child = Arc::new(Mutex::new(Some(child)));
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let turn = Arc::new(Mutex::new(TurnState::default()));
        // A plain `std::sync::Mutex`, not `tokio::sync::Mutex`: `persistence()`
        // in the `AgentSession` trait is synchronous, and this value only ever
        // holds its lock for a single field read or write, never across an
        // `.await`.
        let native_session_id: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
        let mode = Arc::new(Mutex::new(initial_mode));
        let stdin = Arc::new(Mutex::new(stdin));
        // `AllowAlways` has no wire-level equivalent (see module doc), so it
        // is enforced here: tool names the user has blanket-approved, and the
        // request id -> tool name lookup `respond_permission` needs to learn
        // about a fresh approval once the user answers.
        let always_allow: Arc<Mutex<HashSet<String>>> = Arc::default();
        let pending_tools: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let awaiting: Awaiting = Arc::default();

        let session = ClaudeSession {
            stdin: stdin.clone(),
            events: events.clone(),
            turn: turn.clone(),
            child: child.clone(),
            said: said.clone(),
            native_session_id: native_session_id.clone(),
            mode: mode.clone(),
            next_control_id: AtomicU64::new(1),
            always_allow: always_allow.clone(),
            pending_tools: pending_tools.clone(),
            awaiting: awaiting.clone(),
            models,
            efforts,
        };

        let control = ControlState {
            mode,
            stdin,
            always_allow,
            pending_tools,
        };
        tokio::spawn(read_loop(
            stdout,
            events,
            turn,
            native_session_id,
            control,
            child,
            said,
            awaiting,
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
    /// A dispatched sub-agent's own steps, by the `tool_use_id` of the call that
    /// dispatched it. They arrive as ordinary `assistant`/`user` frames carrying
    /// `parent_tool_use_id`, and belong inside that call's card rather than in the
    /// conversation — where, until this existed, a sub-agent's `Bash` and `Read`
    /// appeared as if the main agent had run them itself.
    subs: HashMap<String, Sub>,
}

/// What one sub-agent has done so far.
#[derive(Default)]
struct Sub {
    items: Vec<TimelineItem>,
    /// Child `tool_use_id` -> which of `items` is its card, and the input it was
    /// called with. The input is kept because the result arrives in a frame that
    /// does not repeat it, and rebuilding the card needs both halves.
    at: HashMap<String, (usize, Value)>,
    counter: u64,
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
    /// Shared with `read_loop`, which needs the exit code to explain a crash.
    child: Arc<Mutex<Option<Child>>>,
    /// What the CLI said, for a prompt that cannot be written because it is gone.
    said: Arc<Chatter>,
    native_session_id: Arc<std::sync::Mutex<Option<String>>>,
    mode: Arc<Mutex<String>>,
    next_control_id: AtomicU64,
    always_allow: Arc<Mutex<HashSet<String>>>,
    pending_tools: Arc<Mutex<HashMap<String, String>>>,
    /// The thinking levels this install named, for the same reason `models` is
    /// kept: the CLI answers `success` to levels that do not exist.
    efforts: Vec<String>,
    /// Control requests we have sent and want the answer to.
    awaiting: Awaiting,
    /// The model ids this install offered, which are the only ones a `set_model`
    /// can be checked against.
    models: Vec<String>,
}

/// `request_id` -> whoever is waiting for that `control_response`.
///
/// Only for the requests whose answer changes what we tell the caller: a
/// `set_model` the CLI rejected has to reach the user as a failed control rather
/// than a picker that quietly moved and changed nothing.
type Awaiting = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<(), String>>>>>;

/// Everything `handle_control_request` needs to answer Claude Code's
/// `can_use_tool` prompts, bundled so `read_loop` doesn't carry each of these
/// as its own parameter (they are otherwise unrelated to the rest of its
/// frame-dispatch loop).
struct ControlState {
    mode: Arc<Mutex<String>>,
    stdin: Arc<Mutex<ChildStdin>>,
    always_allow: Arc<Mutex<HashSet<String>>>,
    pending_tools: Arc<Mutex<HashMap<String, String>>>,
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

    /// Sends a control request and waits for the CLI's answer to it.
    ///
    /// Waiting is the point: these back the pickers in the composer, and a
    /// control that reports success while the CLI ignored it is worse than one
    /// that fails — the user would go on believing they had switched.
    async fn ask(&self, subtype: &str, request: Value) -> Result<(), String> {
        let request_id = self.control_request_id();
        let (tell, told) = tokio::sync::oneshot::channel();
        self.awaiting.lock().await.insert(request_id.clone(), tell);

        let mut body = json!({ "subtype": subtype });
        if let (Some(body), Some(request)) = (body.as_object_mut(), request.as_object()) {
            body.extend(request.clone());
        }
        let sent = self
            .write(json!({
                "type": "control_request",
                "request_id": request_id,
                "request": body,
            }))
            .await;
        if let Err(error) = sent {
            self.awaiting.lock().await.remove(&request_id);
            return Err(super::stopped("Claude Code", &self.child, &self.said).await
                + &format!(" ({error})"));
        }

        match tokio::time::timeout(CONTROL_TIMEOUT, told).await {
            Ok(Ok(answer)) => answer,
            // The read loop is gone, which means so is the CLI.
            Ok(Err(_)) => Err(super::stopped("Claude Code", &self.child, &self.said).await),
            Err(_) => {
                self.awaiting.lock().await.remove(&request_id);
                Err(format!("no answer to {subtype} in {CONTROL_TIMEOUT:?}"))
            }
        }
    }
}

/// Hands a `control_response` to whoever sent the request it answers.
async fn settle_control_response(frame: &Value, awaiting: &Awaiting) {
    let response = frame.get("response").unwrap_or(&Value::Null);
    let Some(request_id) = response.get("request_id").and_then(Value::as_str) else {
        return;
    };
    let Some(tell) = awaiting.lock().await.remove(request_id) else {
        // An ack nobody is waiting for — `interrupt` sends one of these, and its
        // answer is the turn ending rather than this frame.
        return;
    };
    let answer = match response.get("subtype").and_then(Value::as_str) {
        Some("success") => Ok(()),
        _ => Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("no reason given")
            .to_string()),
    };
    let _ = tell.send(answer);
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

        // A CLI that already exited leaves a closed pipe, and the write fails with
        // "Broken pipe (os error 32)" — which is as much use to the reader as
        // "stopped unexpectedly" was. What it said before it closed is the answer,
        // so this failure gets the same treatment as a crash mid-turn.
        if let Err(broken) = self
            .write(json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": user_content_blocks(&input),
                },
            }))
            .await
        {
            let why = super::stopped("Claude Code", &self.child, &self.said).await;
            tracing::warn!("{why} (writing the prompt failed: {broken})");
            self.turn.lock().await.id = None;
            let _ = self.events.send(SessionEvent::TurnFailed {
                turn_id: turn_id.clone(),
                error: TurnError {
                    code: TurnErrorCode::AgentCrashed,
                    message: why.clone(),
                },
            });
            anyhow::bail!(why);
        }
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
            // The tree: on Windows this handle is an npm `.cmd` shim and the CLI
            // itself is its child, which would otherwise outlive the session.
            super::kill_tree(&mut child).await;
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        // The CLI will not check this for us. Asked for a model it has never
        // heard of it answers `success`, prints "Set model to <whatever you
        // typed>" and goes on using the model it already had — so without this,
        // picking a model that does not exist would look like it worked and
        // silently change nothing.
        if !self.models.iter().any(|model| model == model_id) {
            return Err(anyhow!(
                "'{model_id}' is not a model this Claude Code offers ({})",
                if self.models.is_empty() {
                    "it listed none".to_string()
                } else {
                    self.models.join(", ")
                }
            ));
        }
        // Which model is in play stays the CLI's own state from here; it reports
        // it on the next turn's `assistant` frames.
        self.ask("set_model", json!({ "model": model_id }))
            .await
            .map_err(|why| anyhow!("claude would not switch to '{model_id}': {why}"))
    }

    async fn set_effort(&self, effort_id: &str) -> Result<()> {
        // Checked here for the same reason models are: asked for `effort: "very"`
        // the CLI answers `success` and keeps thinking exactly as hard as before.
        if !self.efforts.iter().any(|effort| effort == effort_id) {
            return Err(anyhow!(
                "'{effort_id}' is not an effort level this Claude Code offers ({})",
                if self.efforts.is_empty() {
                    "it listed none".to_string()
                } else {
                    self.efforts.join(", ")
                }
            ));
        }
        // No model in the request: the level applies to whichever model is in
        // play, and which one that is can change under us (its own `/model`
        // command). Sending a model here would quietly undo that.
        self.ask("set_model", json!({ "effort": effort_id }))
            .await
            .map_err(|why| anyhow!("claude would not think '{effort_id}': {why}"))
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        let known = mode_id == MODE_DEFAULT
            || mode_id == "manual"
            || MODES.iter().any(|(mode, ..)| *mode == mode_id);
        if !known {
            return Err(anyhow!("unknown mode '{mode_id}'"));
        }
        // The CLI is the one that has to change behaviour: `plan` and
        // `bypassPermissions` are decisions about what it does before it ever
        // asks us anything, and there is nothing we could enforce on this side.
        if let Err(why) = self
            .ask("set_permission_mode", json!({ "mode": mode_id }))
            .await
        {
            // Accept-edits is the exception, because it is also a promise we can
            // keep ourselves: `handle_control_request` allows without asking. A
            // build too old for the control request still gets the behaviour.
            if mode_id != MODE_ACCEPT_EDITS {
                return Err(anyhow!("claude would not switch to '{mode_id}': {why}"));
            }
            tracing::warn!(
                "claude refused set_permission_mode ({why}); \
                 approving edits on our side instead"
            );
        }
        *self.mode.lock().await = mode_id.to_string();
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()> {
        let tool_name = self.pending_tools.lock().await.remove(request_id);
        let response = match &outcome {
            PermissionOutcome::Selected { option_id } if option_id == "allow" => {
                json!({ "behavior": "allow" })
            }
            PermissionOutcome::Selected { option_id } if option_id == "allow_always" => {
                if let Some(tool_name) = tool_name {
                    self.always_allow.lock().await.insert(tool_name);
                }
                json!({ "behavior": "allow" })
            }
            // What the agent is told matters: it writes its own next sentence out
            // of this. "Denied by the user" when no user was there sends it off
            // apologising for a decision nobody made.
            PermissionOutcome::TimedOut { .. } => json!({
                "behavior": "deny",
                "message": "No one was available to approve this, so it was denied.",
            }),
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

#[allow(clippy::too_many_arguments)]
async fn read_loop(
    stdout: tokio::process::ChildStdout,
    events: broadcast::Sender<SessionEvent>,
    turn: Arc<Mutex<TurnState>>,
    native_session_id: Arc<std::sync::Mutex<Option<String>>>,
    control: ControlState,
    child: Arc<Mutex<Option<Child>>>,
    said: Arc<Chatter>,
    awaiting: Awaiting,
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
            Some("system") => {
                let mut state = turn.lock().await;
                translate_system_frame(&frame, &mut state, &events, &native_session_id);
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
                handle_control_request(&frame, &turn, &events, &control).await;
            }
            Some("control_response") => settle_control_response(&frame, &awaiting).await,
            Some("result") => {
                let mut state = turn.lock().await;
                translate_result(&frame, &mut state, &events);
            }
            _ => {}
        }
    }

    // Gathered before the lock on the turn: it waits on the process and on the
    // stderr readers, and holding the turn through that would stall an interrupt.
    let why = super::stopped("Claude Code", &child, &said).await;
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

/// The CLI's out-of-band frames about itself: which session this is, and when it
/// dropped part of the conversation to make room.
fn translate_system_frame(
    frame: &Value,
    state: &mut TurnState,
    events: &broadcast::Sender<SessionEvent>,
    native_session_id: &std::sync::Mutex<Option<String>>,
) {
    match frame.get("subtype").and_then(Value::as_str) {
        Some("init") => {
            if let Some(id) = frame.get("session_id").and_then(Value::as_str) {
                *native_session_id.lock().unwrap() = Some(id.to_string());
            }
        }
        // Worth a line in the timeline: it is the explanation for an agent that
        // stops remembering something said earlier, which otherwise reads as the
        // agent losing the thread for no reason.
        Some("compact_boundary") => {
            let Some(turn_id) = state.id.clone() else {
                return;
            };
            let id = state.next_item_id();
            let reason = frame
                .get("compact_metadata")
                .and_then(|meta| meta.get("trigger"))
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .to_string();
            let _ = events.send(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Compaction { id, reason },
            });
        }
        _ => {}
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

/// Opens a card for each tool the sub-agent has started, inside its parent.
fn collect_sub_tool_calls(frame: &Value, parent: &str, state: &mut TurnState) {
    let Some((parent_item_id, ..)) = state.tool_items.get(parent).cloned() else {
        return;
    };
    for block in content_blocks(frame) {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(tool_use_id) = block.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let sub = state.subs.entry(parent.to_string()).or_default();
        if sub.at.contains_key(tool_use_id) {
            continue;
        }
        sub.counter += 1;
        let id = format!("{parent_item_id}-{}", sub.counter);
        sub.at
            .insert(tool_use_id.to_string(), (sub.items.len(), input.clone()));
        sub.items.push(TimelineItem::ToolCall {
            id,
            detail: detail_from_tool(&name, &input, None),
            name,
            status: ToolStatus::Running,
        });
    }
}

/// Closes the sub-agent's cards as its tools finish.
fn settle_sub_tool_results(frame: &Value, parent: &str, state: &mut TurnState) {
    let Some(sub) = state.subs.get_mut(parent) else {
        return;
    };
    for block in content_blocks(frame) {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some((at, input)) = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .and_then(|id| sub.at.get(id))
            .cloned()
        else {
            continue;
        };
        let Some(TimelineItem::ToolCall { id, name, .. }) = sub.items.get(at) else {
            continue;
        };
        let (id, name) = (id.clone(), name.clone());
        let status = if block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            ToolStatus::Error
        } else {
            ToolStatus::Ok
        };
        let result = tool_result_text(&block);
        sub.items[at] = TimelineItem::ToolCall {
            detail: detail_from_tool(&name, &input, result.as_deref()),
            id,
            name,
            status,
        };
    }
}

/// Re-sends the parent call with everything the sub-agent has done so far.
///
/// Every nested step means another copy of the parent card, which is how the
/// frontend learns anything happened at all: the card is one item, and an item is
/// only ever replaced whole.
fn emit_sub_agent(
    parent: &str,
    turn_id: &str,
    state: &TurnState,
    events: &broadcast::Sender<SessionEvent>,
) {
    let Some((id, name, input)) = state.tool_items.get(parent) else {
        return;
    };
    let _ = events.send(SessionEvent::Item {
        turn_id: turn_id.to_string(),
        item: TimelineItem::ToolCall {
            id: id.clone(),
            detail: sub_agent_detail(name, input, None, state.subs.get(parent)),
            name: name.clone(),
            status: ToolStatus::Running,
        },
    });
}

/// The parent call's detail, with the sub-agent's steps spliced back in.
///
/// `detail_from_tool` cannot do this itself: it sees one tool call in isolation,
/// and the nested steps live in the turn's state. Without this the tool result
/// that closes the call would rebuild the card with an empty `items` and wipe
/// everything the sub-agent had been seen doing.
fn sub_agent_detail(
    name: &str,
    input: &Value,
    result: Option<&str>,
    sub: Option<&Sub>,
) -> ToolCallDetail {
    let detail = detail_from_tool(name, input, result);
    match (detail, sub) {
        (
            ToolCallDetail::SubAgent { agent, prompt, .. },
            Some(Sub {
                items: collected, ..
            }),
        ) => ToolCallDetail::SubAgent {
            agent,
            prompt,
            items: collected.clone(),
        },
        (detail, _) => detail,
    }
}

fn content_blocks(frame: &Value) -> Vec<Value> {
    frame
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
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
    // A sub-agent's frame. Its tool calls go inside the call that dispatched it.
    if let Some(parent) = frame
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .filter(|parent| state.tool_items.contains_key(*parent))
    {
        let parent = parent.to_string();
        collect_sub_tool_calls(frame, &parent, state);
        emit_sub_agent(&parent, &turn_id, state, events);
        return;
    }
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
    // A sub-agent's own tool results, and the prompt it was dispatched with. The
    // prompt is already on the parent card, so only the results are threaded in.
    if let Some(parent) = frame
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .filter(|parent| state.tool_items.contains_key(*parent))
    {
        let parent = parent.to_string();
        settle_sub_tool_results(frame, &parent, state);
        emit_sub_agent(&parent, &turn_id, state, events);
        return;
    }
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
                        detail: sub_agent_detail(
                            &name,
                            &input,
                            result_text.as_deref(),
                            state.subs.get(tool_use_id),
                        ),
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

/// Builds the `content` array for a user turn's `{"type":"user",...}` frame:
/// the same content-block shape the Anthropic Messages API uses, which is
/// what Claude Code's stdin protocol wraps directly (module doc). Only
/// inline (`dataBase64`) image attachments are forwarded — that is the only
/// shape the composer produces today (pasted screenshots); a bare `path`
/// would need the daemon to read the file itself, which no caller needs yet.
fn user_content_blocks(input: &PromptInput) -> Vec<Value> {
    let mut blocks = vec![json!({ "type": "text", "text": input.text })];
    for attachment in &input.attachments {
        if let Some(data) = &attachment.data_base64 {
            if attachment.mime.starts_with("image/") {
                blocks.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": attachment.mime, "data": data },
                }));
            }
        }
    }
    blocks
}

async fn handle_control_request(
    frame: &Value,
    turn: &Arc<Mutex<TurnState>>,
    events: &broadcast::Sender<SessionEvent>,
    control: &ControlState,
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

    let auto_allow = *control.mode.lock().await == MODE_ACCEPT_EDITS
        || control.always_allow.lock().await.contains(tool_name);
    if auto_allow {
        // Auto-approve without ever bothering the frontend: either the whole
        // session is in accept-edits mode, or the user already picked
        // "Always Allow" for this exact tool earlier in the session.
        let response = json!({
            "type": "control_response",
            "response": { "request_id": request_id, "subtype": "success",
                          "response": { "behavior": "allow" } },
        });
        let mut stdin = control.stdin.lock().await;
        if let Err(error) = write_json_line(&mut stdin, &response).await {
            tracing::warn!("failed to auto-approve a claude tool call: {error}");
        }
        return;
    }
    control
        .pending_tools
        .lock()
        .await
        .insert(request_id.to_string(), tool_name.to_string());

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
                    id: "allow_always".into(),
                    label: format!("Always Allow {tool_name}"),
                    kind: PermissionOptionKind::AllowAlways,
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
            // The CLI's own one-liner for the command, when it wrote one —
            // the daemon's overview filter keeps only this field, so the
            // human sentence survives where the command itself would be cut
            // mid-flag.
            command: match str_field("description") {
                description if !description.is_empty() => description,
                _ => str_field("command"),
            },
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
        // The plan itself, which is the whole point of plan mode: the CLI asks
        // permission for this tool and the answer decides whether it starts
        // working, so the plan has to be on screen and readable — not folded into
        // an "unknown tool" card as raw JSON, which is where it used to land.
        "ExitPlanMode" => ToolCallDetail::Plan {
            markdown: str_field("plan"),
        },
        // A sub-agent. Its own steps arrive tagged with this call's
        // `parent_tool_use_id` and are not threaded in here yet, so `items` stays
        // empty and the card shows what it was sent away to do.
        "Task" | "Agent" => ToolCallDetail::SubAgent {
            agent: input
                .get("subagent_type")
                .or_else(|| input.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("sub-agent")
                .to_string(),
            prompt: str_field("prompt"),
            items: Vec::new(),
        },
        _ => ToolCallDetail::Unknown {
            raw: json!({ "name": name, "input": input }),
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

    /// The bug this file's `ask_mode` exists for, in both directions.
    ///
    /// One build of Claude Code accepts `manual` and rejects `default`; another
    /// accepts `default` and rejects `manual`. Hardcoding either is a CLI that
    /// refuses to start for half the installs — which is exactly what happened:
    /// `option '--permission-mode <mode>' argument 'manual' is invalid`.
    #[test]
    fn the_permission_mode_is_whichever_name_this_build_knows() {
        // 2.1.220, verbatim.
        let manual_build = "  --permission-mode <mode>              Permission mode to use for the \
             session\n                                        (choices: \"acceptEdits\", \"auto\",\n\
             \"bypassPermissions\", \"manual\",\n                                        \"dontAsk\", \
             \"plan\")";
        assert_eq!(ask_mode_in(manual_build), Some("manual"));

        // What the user's build reported when it refused the other name.
        let default_build =
            "  --permission-mode <mode>  Permission mode (choices: \"acceptEdits\", \
             \"auto\", \"bypassPermissions\", \"default\", \"dontAsk\", \"plan\")";
        assert_eq!(ask_mode_in(default_build), Some("default"));

        // A build naming it something else: no flag beats a rejected flag.
        assert_eq!(
            ask_mode_in("  --permission-mode <mode>  (choices: \"loose\", \"strict\")"),
            None
        );
        assert_eq!(ask_mode_in(""), None);
    }

    /// How hard to think is a second axis, and the CLI reports it per model —
    /// which levels exist is the model's answer, not ours.
    #[test]
    fn effort_levels_come_from_the_model_that_says_it_takes_them() {
        let models = models_in(&json!({
            "models": [
                {
                    "value": "default",
                    "displayName": "Default (recommended)",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                },
                // Says it has no such dial: offering one anyway would put a
                // control on screen that changes nothing.
                {
                    "value": "plain",
                    "displayName": "Plain",
                    "supportsEffort": false,
                    "supportedEffortLevels": ["low", "high"],
                },
            ],
        }));

        assert_eq!(models[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(models[0].reasoning);
        assert!(models[1].efforts.is_empty(), "saw {:?}", models[1].efforts);
    }

    /// The command list is the one thing about slash commands we have to get from
    /// the CLI: running one is just prompt text, but nothing outside its own
    /// terminal knows they exist.
    #[test]
    fn commands_keep_the_agents_own_wording_and_lose_the_essays() {
        let hello = json!({
            "commands": [
                {
                    "name": "code-review",
                    "description": "Review the current diff for correctness bugs",
                    "argumentHint": "[low|medium|high] [--fix]",
                },
                { "name": "context", "description": "", "argumentHint": "" },
                { "name": "dataviz", "description": "  Charts.  " },
                // No name: nothing anyone could type.
                { "description": "mystery" },
            ],
        });

        let commands = commands_in(&hello);
        assert_eq!(
            commands
                .iter()
                .map(|command| command.name.as_str())
                .collect::<Vec<_>>(),
            ["code-review", "context", "dataviz"]
        );
        assert_eq!(
            commands[0].argument_hint.as_deref(),
            Some("[low|medium|high] [--fix]")
        );
        // Empty strings are absent, not empty: the menu should not reserve room
        // for a hint that is not there.
        assert_eq!(commands[1].description, None);
        assert_eq!(commands[1].argument_hint, None);

        assert_eq!(commands[2].description.as_deref(), Some("Charts."));

        assert!(commands_in(&json!({})).is_empty());
    }

    /// A skill's description is a paragraph written to make a model trigger on
    /// it, not a menu row: dozens of trigger words, hundreds of characters. It has
    /// to be cut somewhere, and cut so that it reads as an ending.
    #[test]
    fn a_paragraph_long_description_is_cut_at_a_sentence() {
        let essay = "Use this for charts. Triggers on: chart, graph, plot, dashboard, \
                     analytics, heatmap, legend, axis, tooltip, sparkline.";
        assert_eq!(shorten(essay, 30), "Use this for charts.…");

        // Nothing to cut at: better a hard stop than nothing at all.
        assert_eq!(shorten("一二三四五六七八九十", 4), "一二三四…");
        // Short enough to keep whole, and kept whole — no ellipsis on something
        // that was not shortened.
        assert_eq!(
            shorten("Compact the conversation", 240),
            "Compact the conversation"
        );
    }

    /// The CLI compacts on its own when the context fills up. Silently, until
    /// now — and an agent that has quietly forgotten the first half of the
    /// conversation looks like an agent that has lost the thread.
    #[test]
    fn compaction_leaves_a_mark_in_the_timeline() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        let session_id = std::sync::Mutex::new(None);

        translate_system_frame(
            &json!({
                "type": "system",
                "subtype": "compact_boundary",
                "compact_metadata": { "trigger": "auto", "pre_tokens": 152_000 },
            }),
            &mut turn,
            &tx,
            &session_id,
        );

        match &drain(&mut rx)[0] {
            SessionEvent::Item {
                item: TimelineItem::Compaction { reason, .. },
                ..
            } => assert_eq!(reason, "auto"),
            other => panic!("unexpected {other:?}"),
        }
    }

    /// The session id is the whole of `--resume`: without it, reopening a session
    /// silently starts a new conversation with the same name.
    #[test]
    fn the_init_frame_is_where_a_resumable_session_id_comes_from() {
        let (tx, _rx) = broadcast::channel(64);
        let session_id = std::sync::Mutex::new(None);
        translate_system_frame(
            &json!({ "type": "system", "subtype": "init", "session_id": "sess_abc" }),
            &mut state(),
            &tx,
            &session_id,
        );
        assert_eq!(session_id.lock().unwrap().as_deref(), Some("sess_abc"));
    }

    /// Plan mode's whole payoff is reading the plan before answering the request
    /// to act on it. As an "unknown tool" card — which is where `ExitPlanMode`
    /// landed — the plan was raw JSON with the newlines escaped.
    #[test]
    fn a_plan_is_offered_as_a_plan_and_not_as_unknown_json() {
        let detail = detail_from_tool(
            "ExitPlanMode",
            &json!({ "plan": "## 步骤\n1. 读代码\n2. 改" }),
            None,
        );
        assert!(
            matches!(&detail, ToolCallDetail::Plan { markdown } if markdown.starts_with("## 步骤")),
            "saw {detail:?}"
        );
    }

    /// A dispatched sub-agent's steps belong to it, not to the conversation.
    ///
    /// The frames below are the shape a real 2.1.220 emits (captured from an
    /// `Agent` call that ran `Bash` then `Read`): the sub-agent's own work arrives
    /// as ordinary `assistant`/`user` frames whose only marker is
    /// `parent_tool_use_id`. Ignore that marker, as we used to, and the
    /// sub-agent's `Bash` shows up in the timeline as if the main agent had run
    /// it — with no way to tell that it was something else's doing.
    #[test]
    fn a_sub_agents_steps_land_inside_its_own_card_and_not_in_the_conversation() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();

        // The dispatching call.
        translate_assistant_snapshot(
            &json!({"message": {"content": [{
                "type": "tool_use", "id": "tool_parent", "name": "Agent",
                "input": {"subagent_type": "Explore", "prompt": "Find hello.txt"},
            }]}}),
            &mut turn,
            &tx,
        );
        // Its work: one tool started, then finished.
        translate_assistant_snapshot(
            &json!({
                "parent_tool_use_id": "tool_parent",
                "message": {"content": [{
                    "type": "tool_use", "id": "tool_child", "name": "Bash",
                    "input": {"command": "ls /tmp"},
                }]},
            }),
            &mut turn,
            &tx,
        );
        translate_user_frame(
            &json!({
                "parent_tool_use_id": "tool_parent",
                "message": {"content": [{
                    "type": "tool_result", "tool_use_id": "tool_child", "content": "hello.txt",
                }]},
            }),
            &mut turn,
            &tx,
        );

        let items: Vec<_> = drain(&mut rx)
            .into_iter()
            .filter_map(|event| match event {
                SessionEvent::Item { item, .. } => Some(item),
                _ => None,
            })
            .collect();

        // Every one of them is the same card being replaced, never a second
        // top-level entry: three items, one id.
        assert_eq!(items.len(), 3, "saw {items:?}");
        assert!(
            items.iter().all(|item| item.id() == items[0].id()),
            "the sub-agent's steps must not become timeline entries of their own: {items:?}"
        );

        let TimelineItem::ToolCall {
            detail: ToolCallDetail::SubAgent { agent, items, .. },
            ..
        } = items.last().expect("a card")
        else {
            panic!("expected a sub-agent card, saw {:?}", items.last());
        };
        assert_eq!(agent, "Explore");
        match &items[..] {
            [TimelineItem::ToolCall {
                name,
                status,
                detail:
                    ToolCallDetail::Shell {
                        command, output, ..
                    },
                ..
            }] => {
                assert_eq!(name, "Bash");
                assert_eq!(command, "ls /tmp");
                // Settled, not still running: the result reached the right card.
                assert_eq!(*status, ToolStatus::Ok);
                assert_eq!(output, "hello.txt");
            }
            other => panic!("expected one finished nested call, saw {other:?}"),
        }
    }

    /// The result that closes the dispatching call must not take the sub-agent's
    /// history with it — the card is replaced whole, so anything not carried over
    /// disappears at exactly the moment someone would go back to read it.
    #[test]
    fn closing_the_dispatching_call_keeps_what_the_sub_agent_did() {
        let (tx, mut rx) = broadcast::channel(64);
        let mut turn = state();
        for frame in [
            json!({"message": {"content": [{
                "type": "tool_use", "id": "tool_parent", "name": "Task",
                "input": {"subagent_type": "Explore", "prompt": "Find it"},
            }]}}),
            json!({
                "parent_tool_use_id": "tool_parent",
                "message": {"content": [{
                    "type": "tool_use", "id": "tool_child", "name": "Read",
                    "input": {"file_path": "/tmp/hello.txt"},
                }]},
            }),
        ] {
            translate_assistant_snapshot(&frame, &mut turn, &tx);
        }
        drain(&mut rx);

        // The parent's own result: top-level, no parent id.
        translate_user_frame(
            &json!({"message": {"content": [{
                "type": "tool_result", "tool_use_id": "tool_parent",
                "content": "the answer is 42",
            }]}}),
            &mut turn,
            &tx,
        );

        match &drain(&mut rx)[0] {
            SessionEvent::Item {
                item:
                    TimelineItem::ToolCall {
                        status,
                        detail: ToolCallDetail::SubAgent { items, .. },
                        ..
                    },
                ..
            } => {
                assert_eq!(*status, ToolStatus::Ok);
                assert_eq!(items.len(), 1, "the nested call was dropped: {items:?}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// The CLI writes a one-line description of what a command is for; that
    /// sentence is the overview the daemon keeps, so it is what the card
    /// carries — not the command, which a 24-character cut would leave
    /// mid-flag.
    #[test]
    fn a_bash_call_prefers_the_clis_own_one_liner() {
        let detail = detail_from_tool(
            "Bash",
            &json!({
                "command": "cargo test --workspace --all-features -- --nocapture",
                "description": "Run the full test suite",
            }),
            None,
        );
        let ToolCallDetail::Shell { command, .. } = detail else {
            panic!("expected a shell call");
        };
        assert_eq!(command, "Run the full test suite");

        // No description written: the command itself is the one-liner.
        let detail = detail_from_tool("Bash", &json!({ "command": "ls" }), None);
        let ToolCallDetail::Shell { command, .. } = detail else {
            panic!("expected a shell call");
        };
        assert_eq!(command, "ls");
    }

    /// A sub-agent card that says which agent and what it was asked to do, rather
    /// than a JSON blob whose interesting field is a long prompt on one line.
    #[test]
    fn a_task_call_is_a_sub_agent_named_after_the_agent_it_dispatched() {
        let detail = detail_from_tool(
            "Task",
            &json!({
                "subagent_type": "Explore",
                "description": "find the router",
                "prompt": "Where are the RPC handlers?",
            }),
            None,
        );
        let ToolCallDetail::SubAgent {
            agent,
            prompt,
            items,
        } = detail
        else {
            panic!("expected a sub-agent");
        };
        assert_eq!(agent, "Explore");
        assert_eq!(prompt, "Where are the RPC handlers?");
        // Its own steps arrive tagged with this call's `parent_tool_use_id`, which
        // is not threaded in yet — an empty list, not a wrong one.
        assert!(items.is_empty());
    }

    /// Every offered mode has to be a name the CLI will accept, or picking it
    /// either fails a control request or — at launch — stops the session from
    /// starting at all.
    #[test]
    fn only_modes_this_build_lists_are_offered() {
        let help = "  --permission-mode <mode>  Permission mode (choices: \"acceptEdits\", \
             \"auto\", \"bypassPermissions\", \"default\", \"dontAsk\", \"plan\")";
        for mode in [MODE_ACCEPT_EDITS, MODE_PLAN, MODE_BYPASS, "default"] {
            assert!(mode_listed(help, mode), "{mode} is listed by this build");
        }
        // Offered by the CLI, deliberately not by us: nothing says what they do
        // (see `MODES`). This is not the same as "not listed".
        assert!(MODES
            .iter()
            .all(|(mode, ..)| *mode != "auto" && *mode != "dontAsk"));

        // A leaner build, and the one that matters: `plan` here would be a flag
        // that makes the CLI refuse to start.
        let older = "  --permission-mode <mode>  (choices: \"acceptEdits\", \"manual\")";
        assert!(mode_listed(older, MODE_ACCEPT_EDITS));
        assert!(!mode_listed(older, MODE_PLAN));
        assert!(!mode_listed("", MODE_ACCEPT_EDITS));
    }

    /// The model list is the CLI's own, and every id in it has to be one the CLI
    /// will take back in a `set_model`: `value`, never the resolved name it
    /// happens to print beside it.
    #[test]
    fn models_are_the_aliases_the_cli_offered_not_the_names_it_resolved_them_to() {
        // 2.1.220's answer to `initialize`, trimmed to the fields we read.
        let hello = json!({
            "model": "sonnet",
            "models": [
                {
                    "value": "default",
                    "resolvedModel": "k3-256k[1m]",
                    "displayName": "Default (recommended)",
                    "supportsEffort": true,
                    "supportsAdaptiveThinking": true,
                },
                { "value": "sonnet", "displayName": "Sonnet", "supportsEffort": false },
                // No `value`: nothing we could send back, so nothing to offer.
                { "displayName": "Mystery" },
            ],
        });
        let models = models_in(&hello);
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "sonnet"]
        );
        assert_eq!(models[0].label, "Default (recommended)");
        assert!(models[0].reasoning, "it said it supports effort levels");
        assert!(!models[1].reasoning);

        assert!(models_in(&json!({})).is_empty(), "no list, no picker");
    }

    /// "default" is an ordinary English word in a help text, and picking it up
    /// from an unrelated line would put us back to passing a name this build does
    /// not accept.
    #[test]
    fn a_mode_is_only_read_from_the_flag_that_lists_modes() {
        let help = "  --model <name>  The model to use (default: sonnet)\n  \
             --permission-mode <mode>  (choices: \"acceptEdits\", \"manual\", \"plan\")";
        assert_eq!(ask_mode_in(help), Some("manual"));
    }

    /// The whole reason this file changed: a CLI that will not run said so on its
    /// stderr, and we logged that below the default filter and reported
    /// "Claude Code stopped unexpectedly." — which is true of every cause and
    /// useful for none of them.
    ///
    /// A stand-in CLI rather than the real one, because the failure being covered
    /// is "the CLI refuses to start", and a working install cannot produce it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cli_that_refuses_to_run_reaches_the_user_with_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho 'Invalid API key · Please run /login' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();

        let adapter = ClaudeAdapter::with_program(fake);
        let session = adapter
            .start(SessionConfig {
                effort_id: None,
                session_id: "s1".into(),
                cwd: dir.path().to_path_buf(),
                model_id: None,
                mode_id: None,
                scratch_dir: dir.path().to_path_buf(),
                providers: Default::default(),
                resume: None,
            })
            .await
            .expect("spawning a CLI that exits is still a spawn that worked");

        let mut events = session.events();
        // Two ways this surfaces, depending on how quickly the CLI went: the write
        // hits a closed pipe, or it lands and the turn dies with the process. Both
        // have to carry the reason, so either is accepted here and neither is
        // allowed to be vague.
        let message = match session
            .send(PromptInput {
                text: "hi".into(),
                attachments: Vec::new(),
            })
            .await
        {
            Err(refused) => refused.to_string(),
            Ok(_) => tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    if let Ok(SessionEvent::TurnFailed { error, .. }) = events.recv().await {
                        return error.message;
                    }
                }
            })
            .await
            .expect("a CLI that exited does not leave the turn running forever"),
        };

        assert!(
            message.contains("Invalid API key"),
            "the CLI said why it would not run and the user was not told: {message}"
        );
        assert!(message.contains("退出码 1"), "no exit code in: {message}");
    }

    fn drain(rx: &mut broadcast::Receiver<SessionEvent>) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            out.push(event);
        }
        out
    }

    /// A pasted screenshot must become an Anthropic-shaped `image` content
    /// block — the same shape `stream-json` wraps directly (module doc).
    #[test]
    fn a_pasted_image_becomes_a_base64_image_block() {
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
            user_content_blocks(&input),
            vec![
                json!({ "type": "text", "text": "看看这个" }),
                json!({ "type": "image",
                        "source": { "type": "base64", "media_type": "image/png", "data": "Zm9v" } }),
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
        assert_eq!(
            user_content_blocks(&input),
            vec![json!({ "type": "text", "text": "" })]
        );
    }

    /// `cat` echoes whatever we write on its stdin, so it doubles as a cheap
    /// stand-in for the real Claude Code child process wherever a test only
    /// needs *something* implementing `ChildStdin` to write into — no
    /// protocol behaviour of the fake process itself is exercised here.
    fn fake_stdin() -> (Child, Arc<Mutex<ChildStdin>>) {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("spawning `cat` as a fake stdin sink");
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("stdin was piped")));
        (child, stdin)
    }

    fn can_use_tool(request_id: &str, tool_name: &str) -> Value {
        json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "can_use_tool", "tool_name": tool_name },
        })
    }

    /// There is no wire-level "always allow" Claude Code understands (see the
    /// module doc), so this is enforced entirely on our side: the option must
    /// be offered, and once picked, the *same* tool must stop bothering the
    /// frontend without silently starting to allow other tools too.
    #[tokio::test]
    async fn always_allow_is_offered_then_short_circuits_only_that_tool() {
        let (mut child, stdin) = fake_stdin();
        let control = ControlState {
            mode: Arc::new(Mutex::new(MODE_DEFAULT.to_string())),
            stdin,
            always_allow: Arc::default(),
            pending_tools: Arc::default(),
        };
        let turn = Arc::new(Mutex::new(state()));
        let (tx, mut rx) = broadcast::channel(64);

        handle_control_request(&can_use_tool("req1", "Bash"), &turn, &tx, &control).await;
        let request = drain(&mut rx)
            .into_iter()
            .find_map(|event| match event {
                SessionEvent::PermissionRequested { request } => Some(request),
                _ => None,
            })
            .expect("a fresh tool must still ask the frontend");
        assert_eq!(request.options.len(), 3);
        assert!(request
            .options
            .iter()
            .any(|option| option.id == "allow_always"
                && option.kind == PermissionOptionKind::AllowAlways));
        assert_eq!(
            control.pending_tools.lock().await.get("req1"),
            Some(&"Bash".to_string())
        );

        // The user picked "Always Allow" for req1 — `respond_permission` is
        // what would normally do this insert, exercised directly here since
        // it lives on `ClaudeSession`, not `ControlState`.
        control.always_allow.lock().await.insert("Bash".to_string());

        handle_control_request(&can_use_tool("req2", "Bash"), &turn, &tx, &control).await;
        assert!(
            drain(&mut rx).is_empty(),
            "the same tool must not ask again after Always Allow"
        );

        handle_control_request(&can_use_tool("req3", "Write"), &turn, &tx, &control).await;
        assert!(
            drain(&mut rx)
                .iter()
                .any(|event| matches!(event, SessionEvent::PermissionRequested { .. })),
            "a different tool must still ask, Always Allow is per-tool"
        );

        let _ = child.start_kill();
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
