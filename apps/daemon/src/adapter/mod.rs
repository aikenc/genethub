//! The agent adapter layer.
//!
//! Boundary B1 in `docs/architecture.md`: nothing outside this directory may
//! know which agent is in use. Adapters translate their agent's wire format
//! into `SessionEvent` and accept a fixed set of commands; the session kernel
//! and every transport above it see only those.

pub mod acp;
pub mod claude;
pub mod codex;
pub mod genet;
pub mod opencode;
pub mod registry;
pub mod stdio;
pub mod usage;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use genehub_proto::{
    AgentSetup, Attachment, AuthState, Capabilities, Catalog, ImportContinuation,
    PermissionOutcome, ProbeState, SessionEvent, TimelineItem,
};
use tokio::sync::{broadcast, Mutex};

use crate::config::ProviderConfig;

/// Everything an adapter needs to start a session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_id: String,
    pub cwd: PathBuf,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    /// How hard to think, when the agent has such a dial. Passed at launch for
    /// the same reason the model is: the process only starts on the first prompt,
    /// so a level chosen before that would otherwise be recorded and dropped.
    pub effort_id: Option<String>,
    /// Agent-declared runtime dimensions. Keys and values are opaque and have
    /// already been checked against the current catalog by the session layer.
    pub runtime_values: std::collections::BTreeMap<String, String>,
    /// Product-owned context added without changing the user's message. Each
    /// adapter maps it to its strongest available native system/developer
    /// instruction mechanism; ACP has a documented lower-priority fallback.
    pub additional_system_prompt: Option<String>,
    /// GeneHub built-in Skills directory. The built-in Agent also loads this so
    /// `/skill:` expansion sees the same files the catalog named.
    pub skills_dir: Option<PathBuf>,
    /// Absolute front-door CLI selected by the channel launcher. Every Agent
    /// receives the same binding; absence is explicit and never guessed.
    pub front_door_cli: Option<PathBuf>,
    /// Where the adapter may keep agent-private state for this session.
    pub scratch_dir: PathBuf,
    /// Provider credentials, keyed by provider id.
    ///
    /// Tests point `base_url` at a local mock and change nothing else, which is
    /// what keeps mock and real runs on the same code path
    /// (`docs/testing.md` §2.1).
    pub providers: std::collections::BTreeMap<String, ProviderConfig>,
    /// Handle from a previous run when the agent can rehydrate itself.
    pub resume: Option<PersistHandle>,
}

/// Opaque per-agent pointer to resumable state.
///
/// The daemon stores and returns it without interpreting it: what counts as
/// resumable is the agent's business, not ours.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistHandle {
    pub agent_id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct PromptInput {
    pub text: String,
    pub attachments: Vec<Attachment>,
}

/// Provider-owned identity and lightweight display data discovered without
/// reading an external session's full transcript.
#[derive(Debug, Clone)]
pub struct ImportCandidate {
    /// Opaque outside the adapter boundary. The manager replaces it with an
    /// expiring candidate id before anything reaches a client.
    pub source_id: String,
    pub title: String,
    pub preview: String,
    pub updated_at_ms: i64,
    pub continuation: ImportContinuation,
}

/// The selected external transcript after normalization into GeneHub's own
/// timeline. Only this full object is proportional to history size.
#[derive(Debug, Clone)]
pub struct ImportedHistory {
    pub title: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub items: Vec<TimelineItem>,
    pub persist: Option<PersistHandle>,
    pub continuation: ImportContinuation,
    pub warnings: Vec<String>,
}

#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn label(&self) -> &str;

    /// True only for the agent shipped in the installer.
    fn builtin(&self) -> bool {
        false
    }

    fn capabilities(&self) -> Capabilities;

    /// Is it installed and does it answer? Never an error: "not installed" is a
    /// normal state that simply hides the agent from the picker.
    async fn probe(&self) -> ProbeState;

    /// Whether it has usable credentials, as the CLI itself reports them and
    /// without interacting with it. The default is the honest answer for a CLI
    /// that publishes no way to ask: unknown, never a guess.
    async fn auth(&self) -> AuthState {
        AuthState::Unknown
    }

    /// The installed version as the CLI reports it. `None` when the binary is
    /// absent or would not say — a version row is only worth showing when it is
    /// real.
    async fn version(&self) -> Option<String> {
        None
    }

    /// What the setup wizard shows for this agent: how to install it, how its
    /// own sign-in works, how a key reaches it.
    ///
    /// Everything stated here comes from the agent's official documentation,
    /// and none of it is executed by the daemon — the wizard pastes commands
    /// into a terminal the user is watching, and the user presses enter. The
    /// boundary in `docs/third-party-agents.md` §1 stands: we guide, the CLI
    /// configures itself.
    fn setup(&self) -> AgentSetup {
        AgentSetup::default()
    }

    async fn catalog(&self, providers: &ProviderMap) -> Catalog;

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>>;

    /// `None` means this Agent does not publish an import surface. Listing is
    /// deliberately lightweight; full history belongs only in `import_history`.
    async fn list_import_candidates(
        &self,
        _cwd: &std::path::Path,
        _limit: usize,
    ) -> Result<Option<Vec<ImportCandidate>>> {
        Ok(None)
    }

    async fn import_history(
        &self,
        _cwd: &std::path::Path,
        _source_id: &str,
    ) -> Result<ImportedHistory> {
        Err(anyhow::anyhow!(
            "this agent does not support session import"
        ))
    }
}

pub type ProviderMap = std::collections::BTreeMap<String, ProviderConfig>;

#[async_trait]
pub trait AgentSession: Send + Sync {
    /// The one and only output: already-normalized events.
    fn events(&self) -> broadcast::Receiver<SessionEvent>;

    async fn send(&self, input: PromptInput) -> Result<String>;
    async fn interrupt(&self) -> Result<()>;
    async fn close(&self) -> Result<()>;

    async fn set_model(&self, model_id: &str) -> Result<()>;
    async fn set_mode(&self, mode_id: &str) -> Result<()>;

    /// The agent's own process, when it has one.
    ///
    /// Not for controlling it — that is what `close` is for — but for finding
    /// what it started. An agent runs commands, and the ones still running
    /// when it goes quiet are reachable only through the process it runs as
    /// (`crate::processes`). `None` from an agent that is not a local process
    /// simply means there is nothing of that kind to find.
    async fn pid(&self) -> Option<u32> {
        None
    }

    /// Creates a genuinely independent Agent context through a completed turn.
    /// The checkpoint is opaque to the session kernel and came from this same
    /// adapter when that turn completed.
    async fn fork(&self, _checkpoint: &str) -> Result<PersistHandle> {
        Err(anyhow::anyhow!("this agent does not support forking"))
    }

    /// How hard to think. Refused by default: an agent with no such dial should
    /// say so rather than accept the call and ignore it, which would leave a
    /// control on screen that quietly does nothing.
    async fn set_effort(&self, effort_id: &str) -> Result<()> {
        Err(anyhow::anyhow!(
            "this agent has no effort levels to set ({effort_id})"
        ))
    }
    async fn set_runtime_axis(&self, axis_id: &str, value_id: &str) -> Result<()> {
        Err(anyhow::anyhow!(
            "this agent has no runtime axis '{axis_id}' to set ({value_id})"
        ))
    }
    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()>;

    /// `None` means the daemon must fall back to read-only replay of its own log.
    fn persistence(&self) -> Option<PersistHandle> {
        None
    }
}

pub type SharedAdapter = Arc<dyn AgentAdapter>;

/// The last thing a child process said, kept for whoever has to read the failure.
///
/// Every adapter here starts a program somebody else wrote, and when one of those
/// exits, its own account of why is on its stderr. That used to go to
/// `tracing::debug!` — below the default filter — so the message a user saw was
/// "Claude Code stopped unexpectedly." and the sentence that said why was
/// discarded by us before anyone could read it.
///
/// Two destinations, because they answer different questions: the log file keeps
/// everything for afterwards, and the last few lines go into the failure itself,
/// where the person is already looking.
#[derive(Default)]
pub struct Chatter {
    lines: Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    /// Held so a failure can wait for the readers to finish. A process that dies
    /// on its first line dies faster than we can read that line, and the line is
    /// the whole reason anyone opened the error.
    readers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Chatter {
    /// Enough lines to hold a stack trace, few enough that a chatty server does
    /// not become the memory of this process.
    const LINES: usize = 20;

    /// Reads a pipe, keeping the last lines and logging every one of them.
    ///
    /// `target` names the program in the log, so a file with three agents in it
    /// can still be read.
    pub async fn watch<R>(&self, target: &'static str, from: Option<R>)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        let Some(from) = from else { return };
        let lines = self.lines.clone();
        let reader = tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut reader = tokio::io::BufReader::new(from).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                // At info, not debug. The default filter is info, and a
                // diagnostic nobody can see without setting an environment
                // variable first is not a diagnostic.
                tracing::info!(target: "agent", "{target}: {line}");
                let mut held = lines.lock().expect("the log is never poisoned");
                if held.len() == Self::LINES {
                    held.pop_front();
                }
                held.push_back(line);
            }
        });
        self.readers.lock().await.push(reader);
    }

    /// Waits for the readers to reach the end of a closed pipe, which is the only
    /// thing left to read once the child is gone. Bounded, because a child that
    /// left its pipes to a grandchild would otherwise hold this open forever.
    pub async fn settle(&self) {
        let readers = std::mem::take(&mut *self.readers.lock().await);
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            for reader in readers {
                let _ = reader.await;
            }
        })
        .await;
    }

    /// Formatted to sit at the end of a sentence, and to disappear when there is
    /// nothing to say rather than leave a trailing colon.
    pub fn tail(&self) -> String {
        let held = self.lines.lock().expect("the log is never poisoned");
        if held.is_empty() {
            return String::new();
        }
        format!(": {}", Vec::from_iter(held.iter().cloned()).join(" / "))
    }
}

/// How a child process that stopped on its own should be described.
///
/// "Claude Code stopped unexpectedly." was the whole message, on every cause:
/// a missing credential, a CLI too old for the flags we pass, a shim that could
/// not find node. All three look identical to the person reading it, and none of
/// them can be acted on. The exit code and the last lines it wrote are what
/// separate them, and both are already in hand here.
pub async fn stopped(
    label: &str,
    child: &Mutex<Option<crate::os_process::Child>>,
    said: &Chatter,
) -> String {
    said.settle().await;
    let mut message = match exit_code(child).await {
        Some(code) => format!("{label} 退出了（退出码 {code}）"),
        None => format!("{label} 意外退出了"),
    };
    message.push_str(&said.tail());
    if said.tail().is_empty() {
        // Nothing said, and the reason has to be findable anyway. The log holds
        // more than the last twenty lines, including everything before this turn.
        message.push_str("，而且它什么都没说。日志里有它这一趟的全部输出。");
    }
    message
}

/// The exit code of a child that has already stopped writing.
///
/// Polled rather than awaited, and briefly: stdout closing is not quite the same
/// as the process being gone, and a child that closed its pipes but kept running
/// must not hold this lock — `stop()` needs it to kill the thing.
async fn exit_code(child: &Mutex<Option<crate::os_process::Child>>) -> Option<i32> {
    for _ in 0..20 {
        {
            let mut held = child.lock().await;
            match held.as_mut()?.try_wait() {
                Ok(Some(status)) => return status.code(),
                // Still there: give it a moment. The lock is released first,
                // because `stop()` may be the reason it is about to go.
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

/// Prepares a child process this daemon is answerable for.
///
/// Two unrelated-looking things, always wanted together, because they are the
/// same requirement seen from two platforms: what we start must not surprise
/// the person at the machine, and must not survive us. On Windows that means
/// no console window; everywhere it means a process group of our own, so that
/// ending the agent ends what the agent started rather than orphaning a
/// language server or a dev server onto init (`crate::process`).
pub fn owned_child(command: &mut crate::os_process::Command) {
    without_a_window(command);
    crate::process::own_group(command);
}

/// Give every live Agent process the same GeneHub runtime bindings named in
/// its injected built-in Skill catalog. Probe/import helpers intentionally do
/// not receive session-scoped context.
pub(super) fn apply_session_environment(
    command: &mut crate::os_process::Command,
    config: &SessionConfig,
) {
    command.env("GENEHUB_SESSION_ID", &config.session_id);
    match &config.front_door_cli {
        Some(path) => {
            command.env("GENEHUB_CLI", path);
        }
        None => {
            command.env_remove("GENEHUB_CLI");
        }
    }
}

/// Starts a child process without giving it a console window.
///
/// Every agent here is a console program, and on Windows starting one from a GUI
/// app opens a window for it — a black box that flashes up on every session, and
/// stays on screen for as long as the agent runs. The desktop shell already does
/// this for the daemon; the daemon has to do it for what it starts.
///
/// A no-op everywhere else, so callers do not need a `cfg`.
pub fn without_a_window(command: &mut crate::os_process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Adds product-owned system context to a CLI without shell interpolation.
/// Claude and the built-in Agent use different native flag names but share the
/// same argument boundary and multiline-value safety.
pub(super) fn append_system_prompt_arg(
    command: &mut crate::os_process::Command,
    flag: &str,
    prompt: Option<&str>,
) {
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        command.arg(flag).arg(prompt);
    }
}

/// Ends a child and everything it started.
///
/// On Windows an npm-installed CLI is a `.cmd` shim, so the process we hold is
/// `cmd.exe` and the agent itself is its child. Killing what we hold leaves the
/// real thing running — a language server or an HTTP server with an open port,
/// once per session, for as long as the machine is up.
///
/// The same was true on every other platform, for a better-hidden reason: an
/// agent is a thing that runs commands, so the interesting processes are never
/// the one we hold. They are reachable because the agent was started in a
/// process group of its own (`crate::process::own_group`).
pub async fn kill_tree(child: &mut crate::os_process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        crate::process::stop_tree(pid);
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        // `/T` is the whole point: the tree, not the shim. Failure is not worth
        // reporting — the direct kill below is still coming.
        let _ = crate::os_process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// How long a status question may take before the answer is "unknown".
///
/// These run inside `agent.refresh`, which the setup wizard polls while the
/// user is signing in; a CLI that hangs must not hang the whole agent list.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(5);

/// Asks a program its version: `<program> --version`, first line, trimmed.
///
/// Bounded for the same reason as `STATUS_TIMEOUT`, and stderr is dropped:
/// what is wanted is one line like `2.1.220 (Claude Code)`, nothing else.
pub async fn binary_version(program: &Path) -> Option<String> {
    let mut command = crate::os_process::Command::new(program);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    without_a_window(&mut command);
    let output = tokio::time::timeout(STATUS_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let said = String::from_utf8_lossy(&output.stdout);
    let line = said.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// Asks a CLI whether it is signed in by reading one boolean field out of the
/// JSON its status command prints (`claude auth status`, `cursor-agent status
/// --format json`).
///
/// Only a definitive `true` or `false` becomes an answer. A non-zero exit, a
/// missing field, output that is not JSON, a process that never answered — all
/// of them are `Unknown`, because the badge this feeds must never invent a
/// state.
pub async fn json_auth_status(program: &Path, args: &[&str], field: &str) -> AuthState {
    let mut command = crate::os_process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    without_a_window(&mut command);
    let Some(Ok(output)) = tokio::time::timeout(STATUS_TIMEOUT, command.output())
        .await
        .ok()
    else {
        return AuthState::Unknown;
    };
    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return AuthState::Unknown;
    };
    match parsed.get(field).and_then(serde_json::Value::as_bool) {
        Some(true) => AuthState::Authenticated,
        Some(false) => AuthState::Unauthenticated,
        None => AuthState::Unknown,
    }
}

/// Finds an executable on `PATH`, honouring `PATHEXT` on Windows.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    find_executable_in(name, &[])
}

/// PATH first, then extra directories. Extra dirs use the same `PATHEXT` walk
/// as `PATH` — we do not guess `.exe` vs `.cmd` vs `.bat`.
#[cfg(not(target_family = "wasm"))]
pub fn find_executable_in(name: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    genet_native::locate::find_executable_in(name, extra_dirs)
}

/// The same question, asked of the shell.
///
/// The guest cannot answer it: `PATH` is the host's list written with the
/// host's separator, and WASI will not even split it. Nor is it the guest's
/// question — the shell is what will run the program (`os_process`), so it is
/// the one that has to find it.
#[cfg(target_family = "wasm")]
pub fn find_executable_in(name: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let extra: Vec<String> = extra_dirs
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    genet_wasi::wit::genehub::host::process::locate(name, &extra).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure a user actually saw was "Claude Code stopped unexpectedly." and
    /// nothing else — on a missing credential, on a flag the CLI did not know, on a
    /// shim that could not find node. This is the fix for that: the exit code and
    /// what the process said have to be in the sentence.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_that_stops_is_described_with_its_code_and_its_last_words() {
        let mut child = crate::os_process::Command::new("sh")
            .arg("-c")
            .arg("echo 'Invalid API key · Please run /login' >&2; exit 1")
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("sh runs");
        let said = Chatter::default();
        said.watch("claude", child.stderr.take()).await;
        let child = Mutex::new(Some(child));

        let message = stopped("Claude Code", &child, &said).await;
        assert!(
            message.contains("Invalid API key"),
            "the reason it left is missing from: {message}"
        );
        assert!(
            message.contains("退出码 1"),
            "the exit code is missing from: {message}"
        );
    }

    /// Silence is a state too, and the message has to leave somewhere to look
    /// rather than trailing off.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_that_says_nothing_still_points_at_the_log() {
        let mut child = crate::os_process::Command::new("sh")
            .arg("-c")
            .arg("exit 7")
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("sh runs");
        let said = Chatter::default();
        said.watch("genet-agent", child.stderr.take()).await;
        let child = Mutex::new(Some(child));

        let message = stopped(crate::channel::AGENT_LABEL, &child, &said).await;
        assert!(message.contains("退出码 7"), "{message}");
        assert!(message.contains("日志"), "nowhere to look next: {message}");
    }

    /// Guarded at the source level because half of what is being guarded
    /// cannot be exercised here: an agent started without the flag opens a
    /// console window on every session, and the person who sees that is on
    /// Windows and is not the person who can run a test for it.
    ///
    /// The second assertion is the one that will earn its keep. Calling
    /// `without_a_window` directly still passes a naive check for "was this
    /// spawn prepared", while quietly skipping the process group — and the
    /// symptom of that, a language server left running after a session ends,
    /// shows up nowhere near the line that caused it.
    #[test]
    fn every_agent_is_started_as_a_child_this_daemon_can_account_for() {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/adapter");
        for file in ["claude.rs", "codex.rs", "opencode.rs", "acp.rs", "genet.rs"] {
            let source = std::fs::read_to_string(here.join(file)).expect("read the adapter");
            assert!(
                source.contains("owned_child"),
                "{file} starts a program without preparing it to be owned"
            );
            assert!(
                source.contains("apply_session_environment"),
                "{file} starts a live Agent without the shared GeneHub CLI/session binding"
            );
            assert!(
                !source.contains("without_a_window"),
                "{file} suppresses the console window but skips the process group"
            );
        }
    }

    #[test]
    fn absolute_paths_resolve_only_when_they_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(find_executable(missing.to_str().unwrap()).is_none());

        let present = dir.path().join("here");
        std::fs::write(&present, b"").unwrap();
        assert_eq!(find_executable(present.to_str().unwrap()), Some(present));
    }

    #[test]
    fn a_binary_that_is_not_installed_resolves_to_none() {
        assert!(find_executable("genehub-definitely-not-installed").is_none());
    }

    #[test]
    fn extra_dirs_are_searched_after_path() {
        let dir = tempfile::tempdir().unwrap();
        let name = "genehub-test-extra-dir-agent";
        let present = write_searchable(dir.path(), name);
        assert!(find_executable(name).is_none());
        assert_eq!(
            find_executable_in(name, &[dir.path().to_path_buf()]),
            Some(present)
        );
    }

    /// Windows `PATHEXT` does not include the empty suffix, so a test file
    /// without `.exe`/`.cmd`/`.bat` would hide the lookup this is proving.
    fn write_searchable(dir: &std::path::Path, name: &str) -> PathBuf {
        let suffix = if cfg!(windows) { ".bat" } else { "" };
        let present = dir.join(format!("{name}{suffix}"));
        std::fs::write(&present, b"").unwrap();
        present
    }

    #[test]
    fn multiline_system_context_is_one_literal_cli_argument() {
        let mut command = crate::os_process::Command::new("agent");
        append_system_prompt_arg(
            &mut command,
            "--append-system-prompt",
            Some("first line\nhttps://app.example/assets/preview/v2/d/w/r_root/"),
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "--append-system-prompt",
                "first line\nhttps://app.example/assets/preview/v2/d/w/r_root/",
            ]
        );
    }

    #[test]
    fn every_agent_process_receives_the_exact_front_door_binding() {
        let mut command = crate::os_process::Command::new("agent");
        let config = SessionConfig {
            session_id: "s-bound".into(),
            cwd: PathBuf::from("/workspace"),
            model_id: None,
            mode_id: None,
            effort_id: None,
            runtime_values: Default::default(),
            additional_system_prompt: None,
            skills_dir: None,
            front_door_cli: Some(PathBuf::from("/opt/genehub/genet-beta")),
            scratch_dir: PathBuf::from("/scratch"),
            providers: Default::default(),
            resume: None,
        };
        apply_session_environment(&mut command, &config);
        let env: std::collections::BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            env.get("GENEHUB_CLI"),
            Some(&Some("/opt/genehub/genet-beta".into()))
        );
        assert_eq!(env.get("GENEHUB_SESSION_ID"), Some(&Some("s-bound".into())));
    }

    /// A version badge is only worth showing when the program actually said
    /// it: first line, trimmed, and nothing when the question fails.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_version_is_the_first_line_the_program_prints() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fakecli");
        std::fs::write(&fake, "#!/bin/sh\nprintf '1.2.3 (Fake CLI)\\nignored\\n'\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            binary_version(&fake).await.as_deref(),
            Some("1.2.3 (Fake CLI)")
        );
        assert!(
            binary_version(Path::new("/definitely/not/here"))
                .await
                .is_none(),
            "a program that is not there has no version"
        );
    }

    /// The auth badge maps a real boolean and nothing else: output that is not
    /// JSON, or JSON without the field, is "unknown" rather than a guess.
    #[cfg(unix)]
    #[tokio::test]
    async fn auth_status_maps_only_a_real_boolean() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, body: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let signed_in = write("in", "#!/bin/sh\nprintf '{\"loggedIn\": true}'\n");
        let signed_out = write("out", "#!/bin/sh\nprintf '{\"loggedIn\": false}'\n");
        let silent = write("silent", "#!/bin/sh\nprintf 'not json at all'\n");
        let wrong_field = write("other", "#!/bin/sh\nprintf '{\"somethingElse\": true}'\n");

        assert_eq!(
            json_auth_status(&signed_in, &[], "loggedIn").await,
            AuthState::Authenticated
        );
        assert_eq!(
            json_auth_status(&signed_out, &[], "loggedIn").await,
            AuthState::Unauthenticated
        );
        assert_eq!(
            json_auth_status(&silent, &[], "loggedIn").await,
            AuthState::Unknown
        );
        assert_eq!(
            json_auth_status(&wrong_field, &[], "loggedIn").await,
            AuthState::Unknown
        );
    }
}
