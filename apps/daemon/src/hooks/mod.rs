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
//!   the daemon keeps no authoritative state. A tick reuses what
//!   `<project>/.genethub/hooks/` said until a stamp there changes, looking
//!   again every few seconds; every run reads its file again just before it
//!   starts.
//! * **A hook cannot hurt the daemon or a Session**: it runs as its own
//!   process group, ended on timeout, never twice at once, and at most
//!   [`MAX_CONCURRENT`] at a time. A failure is recorded and shown by
//!   `hook.list`; it never stops anything, and a failing hook is never
//!   disabled, because "disabled" would be a second state somebody has to
//!   notice and undo.
//! * **Nothing a hook does can trigger a hook**: `timer` is not fired by
//!   Sessions, so there is no way to loop.
//! * **Restart and channels**: a project-local OS lock holds each execution;
//!   its last-start timestamp also preserves the interval across daemons.

pub mod env;
pub mod file;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
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
/// Minimum quiet time for the opt-in start-based interval schedule.
const MIN_GAP: Duration = Duration::from_secs(1);
/// How long to wait for a finished command's pipes to drain: a grandchild that
/// inherited them must not hold the record open.
const SETTLE: Duration = Duration::from_secs(2);
const STDERR_TAIL: usize = 2048;
/// How often the set of projects is re-read.
const ROSTER_EVERY: Duration = Duration::from_secs(5);
/// How often a project's hooks directory is looked at: a stat of 450
/// directories every second is most of a tick, and a hook written by a
/// deployment still has to start within a few seconds.
const HOOKS_CADENCE: crate::fs_stamp::Cadence = crate::fs_stamp::Cadence {
    hot: Duration::from_secs(1),
    cold: Duration::from_secs(5),
    hot_for: Duration::from_secs(10),
};

/// What one project's hooks directory said when it was last looked at.
struct Registered {
    directory: Option<crate::fs_stamp::Stamp>,
    files: Vec<(PathBuf, Option<crate::fs_stamp::Stamp>)>,
    entries: Vec<file::Entry>,
    watch: crate::fs_stamp::Watch,
}

impl Registered {
    /// Whether anything the last snapshot depended on looks different.
    fn stale(&self, directory: Option<&crate::fs_stamp::Stamp>) -> bool {
        use crate::fs_stamp::{settled, Stamp};
        directory != self.directory.as_ref()
            || !settled(self.directory.as_ref())
            || self
                .files
                .iter()
                .any(|(path, stamp)| !settled(stamp.as_ref()) || Stamp::read_link(path) != *stamp)
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    #[serde(skip)]
    queued: bool,
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

/// The first run is immediate. Subsequent runs default to a full interval
/// after completion; start-based timing is an explicit, short-command opt-in.
fn due(now: Instant, run: &Run, spec: &file::Spec) -> bool {
    if run.running {
        return false;
    }
    match spec.schedule {
        file::Schedule::FixedDelay => run
            .last_finished
            .is_none_or(|finished| now >= finished + spec.every),
        file::Schedule::Interval => run.last_started.is_none_or(|started| {
            let finished = run.last_finished.unwrap_or(started);
            now >= (started + spec.every).max(finished + MIN_GAP)
        }),
    }
}

type Key = (String, String);

pub struct Hooks {
    front_door_cli: Option<PathBuf>,
    runs: Mutex<HashMap<Key, Run>>,
    registered: Mutex<HashMap<(String, PathBuf), Registered>>,
    limit: Arc<tokio::sync::Semaphore>,
    active_paths: Arc<Mutex<HashSet<PathBuf>>>,
}

impl Hooks {
    pub fn new(front_door_cli: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            front_door_cli,
            runs: Mutex::new(HashMap::new()),
            registered: Mutex::new(HashMap::new()),
            limit: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT)),
            active_paths: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    /// The hooks in one project as the files say now, with how each last ran.
    pub fn list(&self, workspace_id: &str, project_root: &Path) -> HookList {
        let directory = hooks_dir(project_root);
        let runs = self.runs.lock().expect("never poisoned");
        let persisted = read_status_file(&directory);
        build_hook_list(workspace_id, &directory, |id| {
            let local = runs.get(&(workspace_id.to_string(), id.to_string()));
            let shared = persisted.get(id);
            match (local, shared) {
                (Some(local), Some(shared))
                    if local.last_started_at_ms >= shared.last_started_at_ms =>
                {
                    local.clone()
                }
                (_, Some(shared)) => shared.clone(),
                (Some(local), _) => local.clone(),
                _ => Run::default(),
            }
        })
    }

    /// Starts every hook of one project that is due. Cheap when the project has
    /// no hooks directory, which is nearly always.
    pub fn tick_project(
        self: &Arc<Self>,
        workspace_id: &str,
        project_root: &Path,
        python: Option<&Path>,
        state: Weak<crate::state::AppState>,
    ) {
        let Some(entries) = self.registered_hooks(workspace_id, project_root) else {
            return;
        };
        let now = Instant::now();
        for entry in entries {
            let file::Entry::Valid { id, spec } = entry else {
                continue;
            };
            if !spec.enabled {
                continue;
            }
            // Do not create an unbounded collection of waiting tasks. The next
            // tick reads the file again when capacity actually exists.
            let Ok(permit) = self.limit.clone().try_acquire_owned() else {
                break;
            };
            let key = (workspace_id.to_string(), id.clone());
            {
                let mut runs = self.runs.lock().expect("never poisoned");
                let run = runs.entry(key.clone()).or_default();
                if !due(now, run, &spec) {
                    continue;
                }
                run.running = true;
                run.queued = true;
            }
            let hooks = self.clone();
            let root = project_root.to_path_buf();
            let python = python.map(Path::to_path_buf);
            let state = state.clone();
            tokio::spawn(async move {
                let _permit = permit;
                // Scheduling can yield after the roster was read. Check the
                // current registration immediately before the command starts.
                let registered =
                    if let Some(state) = state.upgrade() {
                        state.workspaces.get(&key.0).await.is_ok_and(|entry| {
                            entry.root == root && entry.terminated_at_ms.is_none()
                        })
                    } else {
                        false
                    };
                if !registered {
                    hooks.runs.lock().expect("never poisoned").remove(&key);
                    return;
                }
                hooks.run(key, id, root, python).await;
            });
        }
    }

    /// The hooks one project's files declare, looked at again only when due.
    /// `None` when the project has none.
    fn registered_hooks(
        &self,
        workspace_id: &str,
        project_root: &Path,
    ) -> Option<Vec<file::Entry>> {
        let now = std::time::Instant::now();
        let key = (workspace_id.to_string(), project_root.to_path_buf());
        let mut registered = self.registered.lock().expect("never poisoned");
        let directory = hooks_dir(project_root);
        let known = registered.get(&key);
        if known.is_some_and(|known| !known.watch.due(now)) {
            let entries = &known?.entries;
            return (!entries.is_empty()).then(|| entries.clone());
        }
        let stamp = crate::fs_stamp::Stamp::read(&directory);
        let changed = known.is_none_or(|known| known.stale(stamp.as_ref()));
        let cadence = HOOKS_CADENCE;
        if changed {
            let (entries, files) = match stamp {
                Some(stamp) if stamp.is_dir() => file::snapshot_stamped(&directory),
                _ => (Vec::new(), Vec::new()),
            };
            let present: HashSet<String> = entries.iter().map(|e| e.id().to_string()).collect();
            let watch = match registered.remove(&key) {
                Some(mut known) => {
                    known.watch.looked(stamp.as_ref(), true, now, cadence);
                    known.watch
                }
                None => crate::fs_stamp::Watch::first(&directory, stamp.as_ref(), now, cadence),
            };
            registered.insert(
                key.clone(),
                Registered {
                    directory: stamp,
                    files,
                    entries,
                    watch,
                },
            );
            drop(registered);
            self.forget_project(workspace_id, project_root, &present);
            registered = self.registered.lock().expect("never poisoned");
        } else if let Some(known) = registered.get_mut(&key) {
            known.watch.looked(stamp.as_ref(), false, now, cadence);
        }
        let entries = &registered.get(&key)?.entries;
        (!entries.is_empty()).then(|| entries.clone())
    }

    fn forget_registrations_except(&self, workspace_ids: &HashSet<String>) {
        self.registered
            .lock()
            .expect("never poisoned")
            .retain(|(workspace, _), _| workspace_ids.contains(workspace));
    }

    /// Drops run records for hooks of this project that no longer have a file.
    /// A hook that is mid-run keeps its record until it finishes.
    fn forget_project(&self, workspace_id: &str, project_root: &Path, present: &HashSet<String>) {
        let mut runs = self.runs.lock().expect("never poisoned");
        let before = runs.len();
        runs.retain(|(workspace, id), run| {
            workspace != workspace_id || present.contains(id) || (run.running && !run.queued)
        });
        if runs.len() != before {
            write_status_file(workspace_id, project_root, &runs);
        }
    }

    fn forget_projects_except(&self, workspace_ids: &HashSet<String>) {
        let mut runs = self.runs.lock().expect("never poisoned");
        runs.retain(|(workspace, _), run| {
            workspace_ids.contains(workspace) || (run.running && !run.queued)
        });
    }

    async fn run(
        self: Arc<Self>,
        key: Key,
        id: String,
        project_root: PathBuf,
        python: Option<PathBuf>,
    ) {
        // The task may have yielded after tick_project. Revalidate membership
        // and the current file before acquiring project execution ownership.
        let current = file::snapshot(&hooks_dir(&project_root))
            .into_iter()
            .find_map(|entry| match entry {
                file::Entry::Valid {
                    id: current_id,
                    spec,
                } if current_id == id && spec.enabled => Some(spec),
                _ => None,
            });
        let Some(spec) = current else {
            if let Some(run) = self.runs.lock().expect("never poisoned").get_mut(&key) {
                run.running = false;
            }
            return;
        };
        if !self.runs.lock().expect("never poisoned").contains_key(&key) {
            return;
        }
        let directory = match project_root.canonicalize() {
            Ok(root) => hooks_dir(&root),
            Err(error) => {
                if let Some(run) = self.runs.lock().expect("never poisoned").get_mut(&key) {
                    run.running = false;
                    run.last_error = Some(format!("project directory is unavailable: {error}"));
                }
                return;
            }
        };
        let path = directory.join(".locks").join(format!("{id}.lock"));
        if !self
            .active_paths
            .lock()
            .expect("never poisoned")
            .insert(path.clone())
        {
            if let Some(run) = self.runs.lock().expect("never poisoned").get_mut(&key) {
                run.running = false;
            }
            return;
        }
        let mut recovered_completion = false;
        let ownership = lock_file(&path).and_then(|guard| {
            let Some(mut guard) = guard else {
                return Ok(None);
            };
            use std::io::{Read, Seek, SeekFrom, Write};
            let mut timestamp = Vec::new();
            guard.file.read_to_end(&mut timestamp)?;
            let (previous, finished) = match timestamp.len() {
                0 => (0, 0),
                8 => (
                    i64::from_le_bytes(timestamp[..8].try_into().expect("eight bytes")),
                    0,
                ),
                16 => (
                    i64::from_le_bytes(timestamp[..8].try_into().expect("eight bytes")),
                    i64::from_le_bytes(timestamp[8..].try_into().expect("eight bytes")),
                ),
                _ => {
                    return Err(std::io::Error::other(
                        "invalid hook execution timestamps; inspect the lock file",
                    ))
                }
            };
            let now = now_ms();
            if spec.schedule == file::Schedule::FixedDelay && previous > 0 && finished == 0 {
                // The old owner disappeared without recording completion (or
                // wrote the legacy start-only format). The lock proves it no
                // longer owns execution. Observe that fact once, then honor a
                // complete cooldown instead of immediately replaying its work.
                guard.file.seek(SeekFrom::Start(8))?;
                guard.file.write_all(&now.to_le_bytes())?;
                guard.file.set_len(16)?;
                guard.file.sync_all()?;
                recovered_completion = true;
                return Ok(None);
            }
            let cooling = match spec.schedule {
                file::Schedule::FixedDelay => {
                    previous > 0 && now.saturating_sub(finished) < spec.every.as_millis() as i64
                }
                file::Schedule::Interval => {
                    now.saturating_sub(previous) < spec.every.as_millis() as i64
                        || now.saturating_sub(finished) < MIN_GAP.as_millis() as i64
                }
            };
            if cooling {
                return Ok(None);
            }
            guard.file.seek(SeekFrom::Start(0))?;
            guard.file.write_all(&now.to_le_bytes())?;
            guard.file.write_all(&0i64.to_le_bytes())?;
            guard.file.set_len(16)?;
            guard.file.sync_all()?;
            Ok(Some(guard))
        });
        let mut ownership = match ownership {
            Ok(Some(guard)) => guard,
            outcome => {
                self.active_paths
                    .lock()
                    .expect("never poisoned")
                    .remove(&path);
                let mut runs = self.runs.lock().expect("never poisoned");
                let record_outcome = recovered_completion || outcome.is_err();
                if let Some(run) = runs.get_mut(&key) {
                    run.running = false;
                    run.queued = false;
                    if recovered_completion {
                        if let Some(shared) = read_status_file(&directory).get(&id) {
                            run.runs = run.runs.max(shared.runs);
                            run.last_started_at_ms = shared.last_started_at_ms;
                            run.consecutive_failures = shared.consecutive_failures;
                        }
                        run.last_finished = Some(Instant::now());
                        run.last_exit_code = None;
                        run.last_timed_out = false;
                        run.consecutive_failures = run.consecutive_failures.saturating_add(1);
                        run.last_error = Some(
                            "previous owner stopped without completion; waiting for the next run"
                                .to_string(),
                        );
                    }
                    if let Err(error) = outcome {
                        run.last_error = Some(format!("hook execution ownership failed: {error}"));
                        run.consecutive_failures = run.consecutive_failures.saturating_add(1);
                    }
                }
                if record_outcome {
                    write_status_file(&key.0, &project_root, &runs);
                }
                return;
            }
        };
        ownership.local = Some(self.active_paths.clone());
        let _ownership = ownership;
        let started = Instant::now();
        let started_at_ms = now_ms();
        {
            let mut runs = self.runs.lock().expect("never poisoned");
            if let Some(run) = runs.get_mut(&key) {
                if let Some(shared) = read_status_file(&hooks_dir(&project_root)).get(&id) {
                    run.runs = run.runs.max(shared.runs);
                    run.consecutive_failures = shared.consecutive_failures;
                }
                run.running = true;
                run.queued = false;
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

        let mut environment: HashMap<String, String> = open_env.vars.clone().into_iter().collect();
        // What GeneHub sets wins over anything the project file says.
        for (name, value) in &platform {
            environment.insert((*name).to_string(), value.clone());
        }
        let mut command = crate::process::command(&program, &arguments, &cwd);
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
                if spec.schedule == file::Schedule::Interval {
                    None // Drop below enforces the short mode's hard deadline.
                } else {
                    child.end().await
                }
            }
        };
        if timed_out && spec.schedule == file::Schedule::Interval {
            // Graceful termination permits two more seconds of business work,
            // which would exceed e.g. a 150ms interval-mode allowance. Group's
            // existing Drop kills the entire process tree without that grace.
            drop(child);
        }
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
            let limit = if spec.timeout.subsec_nanos() == 0 {
                format!("{}s", spec.timeout.as_secs())
            } else {
                format!("{}ms", spec.timeout.as_millis())
            };
            Some(format!("timed out after {limit} and was ended"))
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
    // Merge under the same cross-process primitive. Another channel may own
    // different hooks; neither a stale snapshot nor a fixed temp name may erase it.
    let result = (|| -> std::io::Result<()> {
        let Some(_guard) = lock_file(&directory.join(".locks").join(".status.lock"))? else {
            return Ok(());
        };
        let mut map = read_status_file(&directory);
        let present: HashSet<String> = file::snapshot(&directory)
            .into_iter()
            .map(|entry| entry.id().to_string())
            .collect();
        map.retain(|id, _| present.contains(id));
        for ((workspace, id), run) in runs {
            if workspace != workspace_id {
                continue;
            }
            if map
                .get(id)
                .is_none_or(|old| old.last_started_at_ms <= run.last_started_at_ms)
            {
                map.insert(id.clone(), run.clone());
            }
        }
        let bytes = serde_json::to_vec(&map).map_err(std::io::Error::other)?;
        crate::config::save_private(&directory.join(".status.json"), &bytes)
            .map_err(std::io::Error::other)
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "could not persist hook status");
    }
}

struct FileGuard {
    file: std::fs::File,
    path: PathBuf,
    local: Option<Arc<Mutex<HashSet<PathBuf>>>>,
}
impl Drop for FileGuard {
    fn drop(&mut self) {
        if self.local.is_some() {
            use std::io::{Seek, SeekFrom, Write};
            let saved = (|| -> std::io::Result<()> {
                self.file.seek(SeekFrom::Start(8))?;
                self.file.write_all(&now_ms().to_le_bytes())?;
                self.file.sync_all()
            })();
            if let Err(error) = saved {
                tracing::warn!(%error, "could not persist hook finish time");
            }
        }
        let _ = crate::fs_lock::unlock(&self.file, &self.path);
        if let Some(local) = &self.local {
            local.lock().expect("never poisoned").remove(&self.path);
        }
    }
}
fn lock_file(path: &Path) -> std::io::Result<Option<FileGuard>> {
    let parent = path.parent().expect("hook lock directory");
    if parent.is_symlink() || path.is_symlink() {
        return Err(std::io::Error::other(
            "hook locks must not be symbolic links",
        ));
    }
    std::fs::create_dir_all(parent)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    match crate::fs_lock::try_lock_exclusive(&file, path) {
        Ok(()) => Ok(Some(FileGuard {
            file,
            path: path.to_path_buf(),
            local: None,
        })),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error),
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
                .filter(|workspace| workspace.terminated_at_ms.is_none())
                .map(|workspace| (workspace.id, PathBuf::from(workspace.root)))
                .collect();
            refreshed = Some(Instant::now());
            let ids: HashSet<String> = roster.iter().map(|(id, _)| id.clone()).collect();
            state.hooks.forget_projects_except(&ids);
            state.hooks.forget_registrations_except(&ids);
        }
        let python = state.registry.python();
        let mut budget = crate::blocking::WorkBudget::new();
        for (id, root) in &roster {
            budget.checkpoint().await;
            state
                .hooks
                .tick_project(id, root, python.as_deref(), Arc::downgrade(&state));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOOK: &str = r#"{"event":"timer","every":"5s","exec":["true"]}"#;

    fn come_due(hooks: &Hooks) {
        let now = std::time::Instant::now();
        for known in hooks.registered.lock().unwrap().values_mut() {
            known.watch.hurry(now);
        }
    }

    fn enabled(entries: &[file::Entry]) -> Vec<bool> {
        entries
            .iter()
            .map(|entry| matches!(entry, file::Entry::Valid { spec, .. } if spec.enabled))
            .collect()
    }

    #[test]
    fn a_tick_reuses_the_registry_until_it_is_due_and_then_sees_edits() {
        let root = tempfile::tempdir().unwrap();
        let hooks = Hooks::new(None);
        assert!(hooks.registered_hooks("w", root.path()).is_none());

        let directory = hooks_dir(root.path());
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("team.genet.json"), HOOK).unwrap();
        assert!(
            hooks.registered_hooks("w", root.path()).is_none(),
            "a project without hooks is not looked at again on every tick"
        );
        come_due(&hooks);
        let entries = hooks.registered_hooks("w", root.path()).unwrap();
        assert_eq!(enabled(&entries), vec![true]);

        let disabled = HOOK.replace("\"exec\"", "\"enabled\":false,\"exec\"");
        std::fs::write(directory.join("team.genet.json"), disabled).unwrap();
        come_due(&hooks);
        let entries = hooks.registered_hooks("w", root.path()).unwrap();
        assert_eq!(enabled(&entries), vec![false], "an in-place edit is seen");

        std::fs::remove_file(directory.join("team.genet.json")).unwrap();
        come_due(&hooks);
        assert!(hooks.registered_hooks("w", root.path()).is_none());
    }
}
