//! Timer hooks: a project's own commands, run by the daemon on a schedule.
//!
//! One event exists, `timer`. Everything a coordinating script needs to
//! notice — a Session that finished, one that is waiting for a person, one
//! that is paused, a notice stuck in a queue — is a fact in durable state that
//! a periodic command can read, so the daemon does not announce lifecycle
//! events and a missed announcement cannot exist. This module only runs the
//! command, on time, without ever letting it hurt anything.
//!
//! * **The directory is the registry** (`file`): nothing is registered, and
//!   the daemon keeps no authoritative state. Each tick reads
//!   `<project>/.genethub/hooks/` again.
//! * **A hook cannot hurt the daemon or a Session**: it runs as its own
//!   process group, ended on timeout, never twice at once, and at most
//!   [`MAX_CONCURRENT`] at a time. A failure is recorded and shown by
//!   `hook.list`; it never stops anything, and a failing hook is never
//!   disabled, because "disabled" would be a second state somebody has to
//!   notice and undo.
//! * **Nothing a hook does can trigger a hook**: `timer` is not fired by
//!   Sessions, so there is no way to loop.
//! * **Restart**: the run record lives in memory, so a restarted daemon runs
//!   every hook once, at once. Scripts are idempotent by contract.

pub mod env;
pub mod file;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::time::Instant;

use crate::state::Shared;

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub id: String,
    #[serde(default)]
    pub valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exec: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub runs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i32>,
    #[serde(default)]
    pub last_timed_out: bool,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookList {
    pub workspace_id: String,
    pub directory: String,
    #[serde(default)]
    pub hooks: Vec<HookInfo>,
}

/// How many hook commands run at the same time, across every project.
pub const MAX_CONCURRENT: usize = 8;
/// A run that overran its interval does not start again at once: this much
/// quiet follows it, so a slow hook cannot spin.
const MIN_GAP: Duration = Duration::from_secs(1);
/// How long to wait for a finished command's pipes to drain: a grandchild that
/// inherited them must not hold the record open.
const SETTLE: Duration = Duration::from_secs(2);
const STDERR_TAIL: usize = 2048;
/// How often the set of projects is re-read. Hooks inside a project are read on
/// every tick; only the roster of projects is cached, because listing projects
/// is far more expensive than listing a directory.
const ROSTER_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    #[serde(default)]
    running: bool,
    #[serde(default)]
    runs: u64,
    #[serde(skip)]
    last_started: Option<Instant>,
    #[serde(skip)]
    last_finished: Option<Instant>,
    #[serde(default)]
    last_started_at_ms: Option<i64>,
    #[serde(default)]
    last_exit_code: Option<i32>,
    #[serde(default)]
    last_timed_out: bool,
    #[serde(default)]
    consecutive_failures: u32,
    #[serde(default)]
    last_error: Option<String>,
}

/// Whether a hook should start now. The first run is immediate; after that a
/// hook is due `every` after it last started, but never sooner than [`MIN_GAP`]
/// after it last finished.
fn due(now: Instant, run: &Run, every: Duration) -> bool {
    if run.running {
        return false;
    }
    let Some(started) = run.last_started else {
        return true;
    };
    let finished = run.last_finished.unwrap_or(started);
    now >= (started + every).max(finished + MIN_GAP)
}

type Key = (String, String);

pub struct Hooks {
    front_door_cli: Option<PathBuf>,
    runs: Mutex<HashMap<Key, Run>>,
    limit: Arc<tokio::sync::Semaphore>,
}

impl Hooks {
    pub fn new(front_door_cli: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            front_door_cli,
            runs: Mutex::new(HashMap::new()),
            limit: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT)),
        })
    }

    /// The hooks in one project as the files say now, with how each last ran.
    pub fn list(&self, workspace_id: &str, project_root: &Path) -> HookList {
        let directory = hooks_dir(project_root);
        let runs = self.runs.lock().expect("never poisoned");
        build_hook_list(workspace_id, &directory, |id| {
            runs.get(&(workspace_id.to_string(), id.to_string()))
                .cloned()
                .unwrap_or_default()
        })
    }

    /// Starts every hook of one project that is due. Cheap when the project has
    /// no hooks directory, which is nearly always.
    pub fn tick_project(
        self: &Arc<Self>,
        workspace_id: &str,
        project_root: &Path,
        python: Option<&Path>,
    ) {
        let directory = hooks_dir(project_root);
        if !directory.is_dir() {
            self.forget_project(workspace_id, project_root, &HashSet::new());
            return;
        }
        let entries = file::snapshot(&directory);
        let present: HashSet<String> = entries.iter().map(|e| e.id().to_string()).collect();
        self.forget_project(workspace_id, project_root, &present);
        let now = Instant::now();
        for entry in entries {
            let file::Entry::Valid { id, spec } = entry else {
                continue;
            };
            if !spec.enabled {
                continue;
            }
            let key = (workspace_id.to_string(), id.clone());
            {
                let mut runs = self.runs.lock().expect("never poisoned");
                let run = runs.entry(key.clone()).or_default();
                if !due(now, run, spec.every) {
                    continue;
                }
                run.running = true;
            }
            let hooks = self.clone();
            let root = project_root.to_path_buf();
            let python = python.map(Path::to_path_buf);
            tokio::spawn(async move {
                let _permit = hooks.limit.clone().acquire_owned().await.ok();
                hooks.run(key, id, spec, root, python).await;
            });
        }
    }

    /// Drops run records for hooks of this project that no longer have a file.
    /// A hook that is mid-run keeps its record until it finishes.
    fn forget_project(&self, workspace_id: &str, project_root: &Path, present: &HashSet<String>) {
        let mut runs = self.runs.lock().expect("never poisoned");
        let before = runs.len();
        runs.retain(|(workspace, id), run| {
            workspace != workspace_id || present.contains(id) || run.running
        });
        if runs.len() != before {
            write_status_file(workspace_id, project_root, &runs);
        }
    }

    fn forget_projects_except(&self, workspace_ids: &HashSet<String>) {
        let mut runs = self.runs.lock().expect("never poisoned");
        runs.retain(|(workspace, _), run| workspace_ids.contains(workspace) || run.running);
    }

    async fn run(
        self: Arc<Self>,
        key: Key,
        id: String,
        spec: file::Spec,
        project_root: PathBuf,
        python: Option<PathBuf>,
    ) {
        let started = Instant::now();
        let started_at_ms = now_ms();
        {
            let mut runs = self.runs.lock().expect("never poisoned");
            if let Some(run) = runs.get_mut(&key) {
                run.running = true;
                run.last_started = Some(started);
                run.last_started_at_ms = Some(started_at_ms);
            }
            write_status_file(&key.0, &project_root, &runs);
        }
        let outcome = self
            .execute(&id, &spec, &project_root, python.as_deref())
            .await;
        let finished = Instant::now();
        let mut runs = self.runs.lock().expect("never poisoned");
        let Some(run) = runs.get_mut(&key) else {
            return;
        };
        run.running = false;
        run.runs += 1;
        run.last_finished = Some(finished);
        run.last_exit_code = outcome.exit_code;
        run.last_timed_out = outcome.timed_out;
        match outcome.failure {
            None => {
                run.consecutive_failures = 0;
                run.last_error = None;
            }
            Some(error) => {
                run.consecutive_failures = run.consecutive_failures.saturating_add(1);
                // The first failure and then every twelfth: enough to notice in
                // the log without a hook that fails every five seconds filling it.
                if run.consecutive_failures == 1 || run.consecutive_failures % 12 == 0 {
                    tracing::warn!(
                        hook = %key.1,
                        failures = run.consecutive_failures,
                        error = %error,
                        "a timer hook failed",
                    );
                }
                run.last_error = Some(error);
            }
        }
        write_status_file(&key.0, &project_root, &runs);
    }

    async fn execute(
        &self,
        id: &str,
        spec: &file::Spec,
        project_root: &Path,
        python: Option<&Path>,
    ) -> Outcome {
        let open_env = env::load(project_root);
        let space_dir = project_root.to_string_lossy().into_owned();
        let mut platform = vec![
            ("GENEHUB_HOOK_ID", id.to_string()),
            ("GENEHUB_HOOK_EVENT", file::EVENT_TIMER.to_string()),
            ("GENEHUB_SPACE_DIR", space_dir.clone()),
        ];
        if let Some(cli) = &self.front_door_cli {
            platform.push(("GENEHUB_CLI", cli.to_string_lossy().into_owned()));
        }
        if let Some(python) = python {
            platform.push(("GENEHUB_PYTHON", python.to_string_lossy().into_owned()));
        }
        // `${GENEHUB_PYTHON}` always expands to something runnable: the platform Python when one is
        // installed, otherwise `python3` from PATH. The variable itself is only exported when it is real.
        let mut expansions = platform.clone();
        if python.is_none() {
            expansions.push(("GENEHUB_PYTHON", "python3".to_string()));
        }
        let expand = |argument: &str| expand_platform(argument, &expansions);
        let program = expand(&spec.exec[0]);
        let arguments: Vec<String> = spec.exec[1..].iter().map(|a| expand(a)).collect();
        let cwd = match &spec.cwd {
            Some(cwd) => project_root.join(expand(cwd)),
            None => project_root.to_path_buf(),
        };
        let envelope = serde_json::json!({
            "event": file::EVENT_TIMER,
            "hook": id,
            "firedAtMs": now_ms(),
            "space": {"dir": space_dir},
            "payload": spec.payload,
            "openEnvProblems": open_env.problems,
        });
        let mut stdin_bytes = envelope.to_string().into_bytes();
        stdin_bytes.push(b'\n');

        let argv = match crate::process::launch_argv(&program, None) {
            Ok(argv) => argv,
            Err(error) => {
                return Outcome::failed(format!("could not start `{program}`: {error:#}"))
            }
        };
        let mut environment: HashMap<String, String> = open_env.vars.clone().into_iter().collect();
        // What GeneHub sets wins over anything the project file says.
        for (name, value) in &platform {
            environment.insert((*name).to_string(), value.clone());
        }
        let mut command = crate::process::command(&argv, &arguments, &cwd);
        command
            .envs(&environment)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = match crate::process::Group::spawn(&mut command) {
            Ok(child) => child,
            Err(error) => {
                return Outcome::failed(format!(
                    "could not start `{program}` in {}: {error}",
                    cwd.display()
                ))
            }
        };
        if let Some(mut sink) = child.stdin() {
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = sink.write_all(&stdin_bytes).await;
                let _ = sink.shutdown().await;
            });
        }
        let stderr = child.stderr().map(|pipe| tokio::spawn(drain(pipe)));
        let stdout = child.stdout().map(|pipe| tokio::spawn(drain(pipe)));

        let mut timed_out = false;
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            () = tokio::time::sleep(spec.timeout) => {
                timed_out = true;
                child.end().await
            }
        };
        let tail = match stderr {
            Some(task) => tokio::time::timeout(SETTLE, task)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        if let Some(task) = stdout {
            let _ = tokio::time::timeout(SETTLE, task).await;
        }
        let exit_code = status.as_ref().and_then(|status| status.code());
        let signal = status.as_ref().and_then(crate::os_process::signal_of);
        let failure = if timed_out {
            Some(format!(
                "timed out after {}s and was ended",
                spec.timeout.as_secs()
            ))
        } else if let Some(signal) = signal {
            Some(format!(
                "was ended by {}",
                crate::os_process::signal_name(signal)
            ))
        } else {
            match exit_code {
                Some(0) => None,
                Some(code) => Some(format!("exited with code {code}")),
                None => Some("finished without an exit code".to_string()),
            }
        };
        let failure = failure.map(|reason| {
            let text = String::from_utf8_lossy(&tail).trim().to_string();
            if text.is_empty() {
                reason
            } else {
                format!("{reason}: {text}")
            }
        });
        Outcome {
            exit_code: if timed_out { None } else { exit_code },
            timed_out,
            failure,
        }
    }
}

struct Outcome {
    exit_code: Option<i32>,
    timed_out: bool,
    failure: Option<String>,
}

impl Outcome {
    fn failed(reason: String) -> Self {
        Outcome {
            exit_code: None,
            timed_out: false,
            failure: Some(reason),
        }
    }
}

/// Reads a pipe to its end, keeping only the last [`STDERR_TAIL`] bytes. It
/// must keep reading past that: a command blocked writing to a pipe nobody
/// reads is a command that never finishes.
async fn drain<R: tokio::io::AsyncRead + Unpin>(mut pipe: R) -> Vec<u8> {
    let mut tail: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                tail.extend_from_slice(&buffer[..count]);
                if tail.len() > STDERR_TAIL {
                    let cut = tail.len() - STDERR_TAIL;
                    tail.drain(..cut);
                }
            }
        }
    }
    tail
}

/// `${GENEHUB_SPACE_DIR}`, `${GENEHUB_PYTHON}` and `${GENEHUB_CLI}` — the paths
/// the daemon itself knows — in a hook's program, arguments and `cwd`. Nothing
/// else is expanded: another `${X}` is left exactly as written, so there is no
/// second substitution language to learn.
fn expand_platform(text: &str, vars: &[(&str, String)]) -> String {
    let mut out = text.to_string();
    for (name, value) in vars {
        if matches!(
            *name,
            "GENEHUB_SPACE_DIR" | "GENEHUB_PYTHON" | "GENEHUB_CLI"
        ) {
            out = out.replace(&format!("${{{name}}}"), value);
        }
    }
    out
}

fn hooks_dir(project_root: &Path) -> PathBuf {
    project_root.join(".genethub").join("hooks")
}

/// Reads hook files and their persisted run records from `<project>/.genethub/hooks/`.
pub fn list_on_disk(workspace_id: &str, project_root: &Path) -> HookList {
    let directory = hooks_dir(project_root);
    let runs = read_status_file(&directory);
    build_hook_list(workspace_id, &directory, |id| {
        runs.get(id).cloned().unwrap_or_default()
    })
}

fn build_hook_list(
    workspace_id: &str,
    directory: &Path,
    mut run_of: impl FnMut(&str) -> Run,
) -> HookList {
    let hooks = file::snapshot(directory)
        .into_iter()
        .map(|entry| {
            let run = run_of(entry.id());
            let mut info = HookInfo {
                id: entry.id().to_string(),
                running: run.running,
                runs: run.runs,
                last_started_at_ms: run.last_started_at_ms,
                last_exit_code: run.last_exit_code,
                last_timed_out: run.last_timed_out,
                consecutive_failures: run.consecutive_failures,
                last_error: run.last_error,
                ..HookInfo::default()
            };
            match entry {
                file::Entry::Valid { spec, .. } => {
                    info.valid = true;
                    info.event = Some(file::EVENT_TIMER.into());
                    info.every_seconds = Some(spec.every.as_secs());
                    info.exec = spec.exec;
                    info.enabled = spec.enabled;
                    info.owner = spec.owner;
                }
                file::Entry::Invalid { problem, .. } => info.problem = Some(problem),
            }
            info
        })
        .collect();
    HookList {
        workspace_id: workspace_id.to_string(),
        directory: directory.to_string_lossy().into_owned(),
        hooks,
    }
}

fn read_status_file(directory: &Path) -> HashMap<String, Run> {
    let path = directory.join(".status.json");
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_status_file(workspace_id: &str, project_root: &Path, runs: &HashMap<Key, Run>) {
    let directory = hooks_dir(project_root);
    if !directory.is_dir() {
        return;
    }
    let map: HashMap<&str, &Run> = runs
        .iter()
        .filter_map(|((ws, id), run)| (ws == workspace_id).then_some((id.as_str(), run)))
        .collect();
    if let Ok(bytes) = serde_json::to_vec(&map) {
        let tmp = directory.join(".status.json.tmp");
        let dst = directory.join(".status.json");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &dst);
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The scheduler: one task for the daemon, one tick a second.
pub async fn run_timer(state: Shared) {
    let mut ticks = tokio::time::interval(Duration::from_secs(1));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut roster: Vec<(String, PathBuf)> = Vec::new();
    let mut refreshed: Option<Instant> = None;
    loop {
        ticks.tick().await;
        if refreshed.is_none_or(|at| at.elapsed() >= ROSTER_EVERY) {
            roster = state
                .workspaces
                .list()
                .await
                .into_iter()
                .map(|workspace| (workspace.id, PathBuf::from(workspace.root)))
                .collect();
            refreshed = Some(Instant::now());
            let ids: HashSet<String> = roster.iter().map(|(id, _)| id.clone()).collect();
            state.hooks.forget_projects_except(&ids);
        }
        let python = state.registry.python();
        for (id, root) in &roster {
            state.hooks.tick_project(id, root, python.as_deref());
        }
    }
}

#[cfg(test)]
mod tests;
