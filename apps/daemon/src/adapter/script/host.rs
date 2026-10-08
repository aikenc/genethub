//! One script Agent's `serve` process, kept alive.
//!
//! Everything that is not specific to any Agent lives here and nowhere else:
//!
//! - one process per Agent, started lazily and restarted when it exits;
//! - one restart path for crashes, missed deadlines, reloads and resets —
//!   wait for no turn in flight (bounded), stop, start, `session.start` every
//!   live session again with its last `resume` value;
//! - a user override that keeps crashing is set aside for the built-in;
//! - an in-memory snapshot of what the script last said (state, job,
//!   requests) that every screen and the router read without waiting.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use genehub_proto::{
    AgentActionInfo, AgentInfo, AgentJobInfo, AgentRequestOutcome, AgentRequestSummary,
    AgentSource, AgentUserRequest, Capabilities, Catalog, ProbeState, SessionEvent, TurnError,
    TurnErrorCode,
};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, Mutex};

use super::layout::{self, Layout, Manifest, Resolved};
use super::pending::{self, PendingAction, PendingActions};
use super::rpc::{CallError, Inbound, LogRing, Peer};
use super::runtime::Runtime;
use super::RegistryEvent;
use crate::adapter::SessionConfig;
use crate::os_process::Command;

const INITIALIZE: Duration = Duration::from_secs(30);
const SHORT: Duration = Duration::from_secs(10);
const CLOSE: Duration = Duration::from_secs(15);
/// Bounded well inside the time the host gives this daemon to exit.
const SHUTDOWN: Duration = Duration::from_secs(3);
/// How long a reload waits for a running turn before restarting anyway.
const IDLE_WAIT: Duration = Duration::from_secs(30);
const CRASH_WINDOW: Duration = Duration::from_secs(5 * 60);
const CRASHES_BEFORE_FALLBACK: usize = 3;
/// Consecutive failed starts retried without anyone asking.
const AUTOMATIC_RESTARTS: u32 = 5;
const JOB_LOG_LINES: usize = 20;
const TEST_BUDGET: Duration = Duration::from_secs(25);
const TEST_OUTPUT_LIMIT: usize = 64 * 1024;
/// What a script may put on screen, per field. Longer text is cut; a request
/// over these bounds is refused. A script must not be able to make the
/// workbench draw (or a QR encoder try to fit) something unbounded.
const TEXT_LIMIT: usize = 2048;
const LABEL_LIMIT: usize = 200;
const QR_LIMIT: usize = 1024;
const REQUEST_ITEMS_LIMIT: usize = 8;
const OPEN_REQUESTS_LIMIT: usize = 8;
const ACTIONS_LIMIT: usize = 12;
const EVENT_CAPACITY: usize = 1024;

/// What the daemon passes every script, whatever the Agent.
#[derive(Clone)]
pub struct HostEnv {
    pub channel: String,
    pub front_door_cli: Option<std::path::PathBuf>,
}

/// The last `state` notification, with defaults for what it left out.
#[derive(Clone, Default)]
struct ScriptState {
    ready: bool,
    message: Option<String>,
    version: Option<String>,
    actions: Vec<AgentActionInfo>,
    capabilities: Capabilities,
    catalog: Catalog,
}

#[derive(Default)]
struct Snapshot {
    resolved: Option<Resolved>,
    manifest: Option<Manifest>,
    icon: Option<String>,
    state: Option<ScriptState>,
    running_revision: Option<String>,
    /// Why the script is not running, in the daemon's words.
    problem: Option<String>,
    starting: bool,
    job: Option<AgentJobInfo>,
    requests: BTreeMap<String, AgentUserRequest>,
    pending_actions: PendingActions,
    pending_load_failed: bool,
    crashes: VecDeque<Instant>,
    /// Consecutive failed starts. Automatic retries stop after a few; the
    /// next explicit use (a list refresh, a send, a reload) tries again.
    failures: u32,
    /// No implicit start before this moment (crash backoff).
    retry_after: Option<Instant>,
    override_disabled: bool,
    override_stale: bool,
    /// A `reload` that found an invalid directory. Shown, but the process
    /// that was already running keeps serving and stays ready.
    reload_error: Option<String>,
    /// The last start failed before the script ran (no Python). Not the
    /// script's fault, so it never sets a local override aside.
    runtime_failed: bool,
    /// The job a person (or a CLI caller) started with `agent.action`.
    foreground_job: Option<String>,
}

/// One live session as the daemon sees it.
pub struct SessionLink {
    pub id: String,
    /// The `session.start` config, with `resume` kept current.
    config: std::sync::Mutex<Value>,
    pub events: broadcast::Sender<SessionEvent>,
    persist: std::sync::Mutex<Option<Value>>,
    pid: std::sync::Mutex<Option<u32>>,
    active_turn: std::sync::Mutex<Option<String>>,
    /// Set once the script accepted `session.start`. Only such sessions are
    /// started again after a restart; one still opening is started by its
    /// own pending call.
    started: AtomicBool,
}

impl SessionLink {
    pub fn persist(&self) -> Option<Value> {
        self.persist.lock().expect("never poisoned").clone()
    }

    pub fn pid(&self) -> Option<u32> {
        *self.pid.lock().expect("never poisoned")
    }

    pub fn begin_turn(&self, turn_id: &str) {
        *self.active_turn.lock().expect("never poisoned") = Some(turn_id.to_string());
    }

    pub fn end_turn(&self, turn_id: &str) {
        let mut active = self.active_turn.lock().expect("never poisoned");
        if active.as_deref() == Some(turn_id) {
            *active = None;
        }
    }

    fn take_turn(&self) -> Option<String> {
        self.active_turn.lock().expect("never poisoned").take()
    }

    fn busy(&self) -> bool {
        self.active_turn.lock().expect("never poisoned").is_some()
    }
}

pub struct AgentHost {
    pub id: String,
    layout: Layout,
    runtime: Arc<Runtime>,
    env: HostEnv,
    events: broadcast::Sender<RegistryEvent>,
    snapshot: std::sync::Mutex<Snapshot>,
    peer: std::sync::Mutex<Option<(u64, Arc<Peer>)>>,
    control: Mutex<()>,
    actions: Mutex<()>,
    generation: AtomicU64,
    /// Set while the daemon itself is stopping the process, so that exit is
    /// not counted as a crash.
    stopping: AtomicBool,
    /// Set once the daemon is going away: nothing starts again.
    closed: AtomicBool,
    sessions: std::sync::Mutex<HashMap<String, Weak<SessionLink>>>,
    logs: Arc<LogRing>,
    me: Weak<AgentHost>,
}

impl AgentHost {
    pub fn new(
        id: String,
        layout: Layout,
        runtime: Arc<Runtime>,
        env: HostEnv,
        events: broadcast::Sender<RegistryEvent>,
    ) -> Arc<Self> {
        let host = Arc::new_cyclic(|me| AgentHost {
            id,
            layout,
            runtime,
            env,
            events,
            snapshot: std::sync::Mutex::new(Snapshot::default()),
            peer: std::sync::Mutex::new(None),
            control: Mutex::new(()),
            actions: Mutex::new(()),
            generation: AtomicU64::new(0),
            stopping: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            sessions: std::sync::Mutex::new(HashMap::new()),
            logs: Arc::new(LogRing::default()),
            me: me.clone(),
        });
        host.rescan();
        host.restore_pending();
        host
    }

    fn arc(&self) -> Option<Arc<AgentHost>> {
        self.me.upgrade()
    }

    fn changed(&self) {
        let _ = self.events.send(RegistryEvent::Changed);
    }

    fn pending_path(&self) -> std::path::PathBuf {
        self.layout
            .root()
            .join("pending")
            .join(format!("{}.json", self.id))
    }

    fn restore_pending(&self) {
        let mut snapshot = self.snapshot.lock().expect("never poisoned");
        let loaded = pending::load(&self.pending_path()).and_then(|actions| {
            anyhow::ensure!(
                actions.iter().all(|(id, saved)| {
                    id == &saved.request.id
                        && saved.request.agent_id == self.id
                        && request_within_bounds(&saved.request).is_ok()
                        && saved.request.display.is_empty()
                        && [&saved.job, &saved.action, &saved.step]
                            .iter()
                            .all(|s| !s.trim().is_empty() && s.chars().count() <= LABEL_LIMIT)
                        && (saved.claimed || saved.decision.is_none())
                }),
                "invalid saved continuation"
            );
            Ok(actions)
        });
        match loaded {
            Ok(actions) => {
                snapshot.pending_load_failed = false;
                for saved in actions.values() {
                    if !saved.claimed && saved.stopped {
                        snapshot
                            .requests
                            .insert(saved.request.id.clone(), saved.request.clone());
                    }
                    snapshot.foreground_job = Some(saved.job.clone());
                    snapshot.job = Some(AgentJobInfo {
                        id: saved.job.clone(),
                        action: Some(saved.action.clone()),
                        phase: Some(
                            if saved.claimed || !saved.stopped {
                                "unknown"
                            } else {
                                "waiting"
                            }
                            .into(),
                        ),
                        message: Some(
                            if !saved.stopped {
                                "停止阶段被中断，请先核查进程；待答记录已保留"
                            } else if saved.claimed {
                                "执行结果未知，请核查 Agent 状态后重新发起动作"
                            } else {
                                "已停止执行，等待用户答复"
                            }
                            .into(),
                        ),
                        percent: None,
                        log_tail: vec![],
                        done: saved.claimed || !saved.stopped,
                        error: (saved.claimed || !saved.stopped)
                            .then(|| "重启前的操作结果未知，不会自动重放".into()),
                    });
                }
                snapshot.pending_actions = actions;
            }
            Err(_) => {
                snapshot.pending_load_failed = true;
                snapshot.problem =
                    Some("无法读取待答事项；请检查 agents/pending，原记录已保留".into());
            }
        }
    }

    /// Reads which directory wins and its manifest, without starting
    /// anything. A broken manifest becomes the problem shown on screen.
    fn rescan(&self) -> Option<(Resolved, Manifest)> {
        let mut snapshot = self.snapshot.lock().expect("never poisoned");
        let resolved = self.layout.resolve(&self.id, snapshot.override_disabled);
        snapshot.resolved = resolved.clone();
        let Some(resolved) = resolved else {
            snapshot.problem = Some("这个 Agent 的目录不存在".into());
            return None;
        };
        snapshot.override_stale =
            resolved.source == AgentSource::Override && self.layout.override_stale(&self.id);
        match layout::read_manifest(&resolved.dir) {
            Ok(manifest) => {
                snapshot.icon = layout::icon_data_url(&resolved.dir, &manifest);
                snapshot.manifest = Some(manifest.clone());
                Some((resolved, manifest))
            }
            Err(error) => {
                snapshot.problem = Some(format!("{error:#}"));
                None
            }
        }
    }

    // -- what screens read ---------------------------------------------------

    pub fn label(&self) -> String {
        let snapshot = self.snapshot.lock().expect("never poisoned");
        snapshot
            .manifest
            .as_ref()
            .map(|manifest| manifest.label.clone())
            .unwrap_or_else(|| self.id.clone())
    }

    pub fn capabilities(&self) -> Capabilities {
        let snapshot = self.snapshot.lock().expect("never poisoned");
        snapshot
            .state
            .as_ref()
            .map(|state| state.capabilities.clone())
            .unwrap_or_default()
    }

    pub fn ready(&self) -> bool {
        let snapshot = self.snapshot.lock().expect("never poisoned");
        snapshot.problem.is_none() && snapshot.state.as_ref().is_some_and(|state| state.ready)
    }

    pub fn catalog(&self) -> Catalog {
        let snapshot = self.snapshot.lock().expect("never poisoned");
        snapshot
            .state
            .as_ref()
            .map(|state| state.catalog.clone())
            .unwrap_or_default()
    }

    pub fn info(&self) -> AgentInfo {
        let snapshot = self.snapshot.lock().expect("never poisoned");
        let state = snapshot.state.clone().unwrap_or_default();
        let ready = !snapshot.pending_load_failed
            && snapshot.problem.is_none()
            && snapshot.state.as_ref().is_some_and(|s| s.ready);
        let message = snapshot
            .pending_load_failed
            .then(|| "无法读取待答事项；原记录已保留，修复后重新加载".into())
            .or_else(|| snapshot.problem.clone())
            .or(snapshot.reload_error.clone())
            .or_else(|| {
                (snapshot.override_disabled && snapshot.state.as_ref().is_some_and(|s| s.ready))
                    .then(|| "本地修改版本连续启动失败，正在使用内置版本".to_string())
            })
            .or(state.message.clone())
            .or_else(|| {
                (snapshot.starting || snapshot.state.is_none()).then(|| "正在启动".to_string())
            });
        AgentInfo {
            id: self.id.clone(),
            label: snapshot
                .manifest
                .as_ref()
                .map(|manifest| manifest.label.clone())
                .unwrap_or_else(|| self.id.clone()),
            probe: if ready {
                ProbeState::Ready
            } else {
                ProbeState::Unavailable {
                    reason: message.clone().unwrap_or_default(),
                }
            },
            capabilities: state.capabilities,
            catalog: state.catalog,
            builtin: false,
            routes: None,
            source: snapshot.resolved.as_ref().map(|resolved| resolved.source),
            version: state.version,
            description: snapshot
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.description.clone()),
            message,
            actions: Some(state.actions),
            job: snapshot.job.clone(),
            pending_requests: Some(
                snapshot
                    .requests
                    .values()
                    .map(|request| AgentRequestSummary {
                        id: request.id.clone(),
                        title: request.title.clone(),
                    })
                    .collect(),
            ),
            icon: snapshot.icon.clone(),
            dir: snapshot.resolved.as_ref().map(|resolved| {
                crate::guest_paths::host_path(&resolved.dir)
                    .to_string_lossy()
                    .into_owned()
            }),
            override_stale: snapshot.override_stale.then_some(true),
        }
    }

    pub fn requests(&self) -> Vec<AgentUserRequest> {
        let snapshot = self.snapshot.lock().expect("never poisoned");
        snapshot.requests.values().cloned().collect()
    }

    pub fn logs(&self, count: usize) -> Vec<String> {
        self.logs.tail(count)
    }

    // -- process lifecycle ---------------------------------------------------

    /// Whether the script process is up right now.
    pub fn running(&self) -> bool {
        self.current_peer().is_some()
    }

    fn current_peer(&self) -> Option<Arc<Peer>> {
        self.peer
            .lock()
            .expect("never poisoned")
            .as_ref()
            .map(|(_, peer)| peer.clone())
    }

    /// Starts the process if it is not running. Concurrent callers wait for
    /// the same start.
    pub async fn ensure_running(&self) -> Result<Arc<Peer>> {
        if let Some(peer) = self.current_peer() {
            return Ok(peer);
        }
        let _guard = self.control.lock().await;
        if let Some(peer) = self.current_peer() {
            return Ok(peer);
        }
        {
            // Inside the backoff window every caller gets the last failure
            // instead of another start: a broken script must not be started
            // once per list refresh, send and warm-up.
            let snapshot = self.snapshot.lock().expect("never poisoned");
            if snapshot.retry_after.is_some_and(|at| Instant::now() < at) {
                anyhow::bail!(snapshot
                    .problem
                    .clone()
                    .unwrap_or_else(|| "Agent 脚本正在重试启动".into()));
            }
        }
        self.start_locked().await
    }

    async fn start_locked(&self) -> Result<Arc<Peer>> {
        let Some(host) = self.arc() else {
            anyhow::bail!("the registry is shutting down");
        };
        if self.closed.load(Ordering::SeqCst) {
            anyhow::bail!("GeneHub 正在退出");
        }
        // A start is the daemon wanting the process again; an earlier stop
        // that never got as far as a new process must not mute the crash
        // handling of this one.
        self.stopping.store(false, Ordering::SeqCst);
        self.snapshot.lock().expect("never poisoned").starting = true;
        self.changed();
        let result = self.spawn_and_initialize(&host).await;
        {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            snapshot.starting = false;
            match &result {
                Ok(_) => {
                    snapshot.problem = None;
                    snapshot.reload_error = None;
                    snapshot.failures = 0;
                    snapshot.retry_after = None;
                }
                Err(error) => snapshot.problem = Some(format!("{error:#}")),
            }
        }
        self.changed();
        if result.is_err() {
            self.record_crash();
        }
        result
    }

    async fn spawn_and_initialize(&self, host: &Arc<AgentHost>) -> Result<Arc<Peer>> {
        let (resolved, _manifest) = self
            .rescan()
            .ok_or_else(|| anyhow!(self.problem_or("Agent 目录无效")))?;

        let weak = Arc::downgrade(host);
        let python = match self
            .runtime
            .python(&move |progress| {
                if let Some(host) = weak.upgrade() {
                    host.runtime_progress(progress);
                }
            })
            .await
        {
            Ok(python) => python,
            Err(error) => {
                let message = format!("{error:#}");
                self.logs.push(format!("[daemon] {message}"));
                let mut snapshot = self.snapshot.lock().expect("never poisoned");
                snapshot.runtime_failed = true;
                if let Some(job) = snapshot.job.as_mut().filter(|job| job.id == "runtime") {
                    job.done = true;
                    job.error = Some(message);
                }
                return Err(error);
            }
        };
        self.finish_runtime_job();

        let state_dir = self.layout.state_dir(&self.id);
        std::fs::create_dir_all(&state_dir)?;
        let _ = crate::config::restrict_to_owner(&state_dir);
        let revision = layout::script_revision(&resolved.dir, &self.layout.sdk_dir()).ok();
        self.snapshot
            .lock()
            .expect("never poisoned")
            .running_revision = revision;
        let boot = self.layout.sdk_dir().join("boot.py");

        let mut command = Command::new(&python);
        command
            .arg("-I")
            .arg("-X")
            .arg("utf8")
            .arg(crate::guest_paths::host_path(&boot))
            .arg(crate::guest_paths::host_path(&resolved.dir))
            .arg("serve")
            .current_dir(&state_dir)
            .env("GENEHUB_AGENT_ID", &self.id)
            .env(
                "GENEHUB_AGENT_STATE",
                crate::guest_paths::host_path(&state_dir),
            )
            .env_remove("GENEHUB_SESSION_ID")
            .env_remove("GENEHUB_CONTROLLER_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        match &self.env.front_door_cli {
            Some(cli) => {
                command.env("GENEHUB_CLI", cli);
            }
            None => {
                command.env_remove("GENEHUB_CLI");
            }
        }
        crate::adapter::owned_child(&mut command);
        let child = command
            .spawn()
            .map_err(|error| anyhow!("无法启动 Agent 脚本：{error}"))?;

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // Whether this process ever became the live one. An exit of a process
        // that never did was already handled as a failed start.
        let became_live = Arc::new(AtomicBool::new(false));
        let (inbound, mut received) = mpsc::unbounded_channel();
        let peer = Peer::attach(
            child,
            format!("agent:{}", self.id),
            self.logs.clone(),
            inbound,
        );
        let pump = Arc::downgrade(host);
        let live = became_live.clone();
        tokio::spawn(async move {
            while let Some(message) = received.recv().await {
                let Some(host) = pump.upgrade() else { break };
                match message {
                    Inbound::Notification { method, params } => {
                        if host.generation.load(Ordering::SeqCst) == generation {
                            host.on_notification(&method, params)
                        }
                    }
                    Inbound::Exited => {
                        if live.load(Ordering::SeqCst) {
                            host.on_exit(generation).await;
                        }
                    }
                }
            }
        });

        let initialize = json!({
            "protocol": layout::PROTOCOL,
            "agentId": self.id,
            "channel": self.env.channel,
            "os": host_os(),
            // The guest only knows it is wasm32; the script asks its own
            // interpreter when this is null.
            "arch": (!cfg!(target_family = "wasm")).then_some(std::env::consts::ARCH),
            "agentDir": crate::guest_paths::host_path(&resolved.dir),
            "sdkDir": crate::guest_paths::host_path(&self.layout.sdk_dir()),
            "stateDir": crate::guest_paths::host_path(&state_dir),
            "frontDoorCli": self.env.front_door_cli,
        });
        match peer.call("initialize", initialize, INITIALIZE).await {
            Ok(reply) => {
                let protocol = reply.get("protocol").and_then(Value::as_u64);
                if protocol != Some(layout::PROTOCOL as u64) {
                    peer.kill().await;
                    anyhow::bail!(
                        "Agent 脚本说的是协议 {:?}，这个 GeneHub 只支持 {}",
                        protocol,
                        layout::PROTOCOL
                    );
                }
            }
            Err(error) => {
                peer.kill().await;
                anyhow::bail!("Agent 脚本没有完成握手：{error}{}", self.log_hint());
            }
        }
        if self.closed.load(Ordering::SeqCst) {
            peer.kill().await;
            anyhow::bail!("GeneHub 正在退出");
        }
        became_live.store(true, Ordering::SeqCst);
        *self.peer.lock().expect("never poisoned") = Some((generation, peer.clone()));
        if resolved.source == AgentSource::Override {
            self.layout.note_override_base(&self.id);
        }

        for link in self
            .live_sessions()
            .into_iter()
            .filter(|link| link.started.load(Ordering::SeqCst))
        {
            let peer = peer.clone();
            let config = link.config.lock().expect("never poisoned").clone();
            let logs = self.logs.clone();
            tokio::spawn(async move {
                let params = json!({ "sessionId": link.id, "config": config });
                if let Err(error) = peer
                    .call("session.start", params, super::SESSION_START)
                    .await
                {
                    logs.push(format!("[daemon] 重启后接回会话 {} 失败：{error}", link.id));
                }
            });
        }
        Ok(peer)
    }

    fn problem_or(&self, fallback: &str) -> String {
        self.snapshot
            .lock()
            .expect("never poisoned")
            .problem
            .clone()
            .unwrap_or_else(|| fallback.to_string())
    }

    fn log_hint(&self) -> String {
        let tail = self.logs.tail(5);
        if tail.is_empty() {
            String::new()
        } else {
            format!("（{}）", tail.join(" / "))
        }
    }

    fn runtime_progress(&self, progress: super::runtime::Progress) {
        if let Some(message) = progress.message.as_deref() {
            self.logs.push(format!("[python-runtime] {message}"));
        }
        {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            let job = snapshot.job.get_or_insert_with(|| AgentJobInfo {
                id: "runtime".into(),
                action: None,
                phase: None,
                percent: None,
                message: None,
                log_tail: Vec::new(),
                done: false,
                error: None,
            });
            if job.id != "runtime" {
                return;
            }
            job.phase = progress.phase.or(Some("runtime".into()));
            job.message = progress
                .message
                .map(|message| format!("Python 运行时准备中：{message}"));
        }
        self.changed();
    }

    fn finish_runtime_job(&self) {
        let mut snapshot = self.snapshot.lock().expect("never poisoned");
        if snapshot.job.as_ref().is_some_and(|job| job.id == "runtime") {
            snapshot.job = None;
        }
    }

    fn record_crash(&self) {
        let fall_back = {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            let now = Instant::now();
            if !std::mem::take(&mut snapshot.runtime_failed) {
                snapshot.crashes.push_back(now);
            }
            snapshot.failures = snapshot.failures.saturating_add(1);
            while snapshot
                .crashes
                .front()
                .is_some_and(|at| now.duration_since(*at) > CRASH_WINDOW)
            {
                snapshot.crashes.pop_front();
            }
            let overriding = snapshot
                .resolved
                .as_ref()
                .is_some_and(|resolved| resolved.source == AgentSource::Override);
            if overriding
                && !snapshot.override_disabled
                && snapshot.crashes.len() >= CRASHES_BEFORE_FALLBACK
            {
                snapshot.override_disabled = true;
                snapshot.crashes.clear();
                true
            } else {
                false
            }
        };
        if fall_back {
            self.logs.push(
                "[daemon] 本地修改版本连续启动失败，已临时退回内置版本；修好后执行 genet agent reload".into(),
            );
        }
        self.schedule_restart();
    }

    fn schedule_restart(&self) {
        let Some(host) = self.arc() else { return };
        let (delay, give_up) = {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            let attempts = snapshot.failures.min(6);
            let delay = Duration::from_secs(1u64 << attempts).min(Duration::from_secs(60));
            snapshot.retry_after = Some(Instant::now() + delay);
            (delay, snapshot.failures >= AUTOMATIC_RESTARTS)
        };
        if give_up {
            // Keep the reason on screen; the next explicit use after the
            // backoff tries again. An unwatched daemon must not keep running
            // an install script against the network forever.
            return;
        }
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if host.stopping.load(Ordering::SeqCst)
                || host.closed.load(Ordering::SeqCst)
                || host.current_peer().is_some()
            {
                return;
            }
            let _ = host.ensure_running().await;
        });
    }

    /// The process that became live as `generation` is gone.
    async fn on_exit(&self, generation: u64) {
        let gone = {
            let mut current = self.peer.lock().expect("never poisoned");
            match current.as_ref() {
                // A newer process is already serving: the daemon replaced
                // this one itself and has failed its turns already.
                Some((live, _)) if *live != generation => return,
                Some(_) => current.take().map(|(_, peer)| peer),
                None => None,
            }
        };
        if let Some(peer) = gone {
            // Stdout closed, but the process (or what it started) may still
            // be there.
            peer.kill().await;
        }
        let why = format!("Agent 脚本退出了{}", self.log_hint());
        self.process_gone(&why);
        if self.stopping.load(Ordering::SeqCst) {
            self.changed();
            return;
        }
        self.snapshot.lock().expect("never poisoned").problem = Some(why);
        self.changed();
        self.record_crash();
    }

    /// Everything that lived in a process that no longer exists: its turns
    /// fail, its requests close, a job it was running ends.
    fn process_gone(&self, why: &str) {
        for link in self.live_sessions() {
            if let Some(turn_id) = link.take_turn() {
                let _ = link.events.send(SessionEvent::TurnFailed {
                    turn_id,
                    error: TurnError {
                        code: TurnErrorCode::AgentCrashed,
                        message: why.to_string(),
                    },
                });
            }
        }
        let closed: Vec<_> = {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            let unconfirmed_stop = snapshot
                .pending_actions
                .values()
                .any(|saved| !saved.stopped && !saved.claimed);
            if let Some(job) = snapshot
                .job
                .as_mut()
                .filter(|job| !job.done && job.phase.as_deref() != Some("waiting"))
            {
                job.done = true;
                job.error.get_or_insert_with(|| why.to_string());
                if unconfirmed_stop {
                    job.phase = Some("unknown".into());
                    job.message = Some("停止阶段被中断，待答记录已保留；请先核查进程".into());
                }
            }
            let closed: Vec<_> = snapshot
                .requests
                .keys()
                .filter(|id| !snapshot.pending_actions.contains_key(*id))
                .cloned()
                .collect();
            for id in &closed {
                snapshot.requests.remove(id);
            }
            closed
        };
        for request_id in closed {
            let _ = self.events.send(RegistryEvent::RequestClosed {
                agent_id: self.id.clone(),
                request_id,
            });
        }
    }

    /// The one restart path for reload and reset.
    async fn restart(&self) -> Result<()> {
        let _guard = self.control.lock().await;
        let deadline = Instant::now() + IDLE_WAIT;
        while self.live_sessions().iter().any(|link| link.busy()) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        self.stop_locked().await;
        {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            snapshot.crashes.clear();
            snapshot.failures = 0;
            snapshot.retry_after = None;
            snapshot.override_disabled = false;
            snapshot.problem = None;
            snapshot.reload_error = None;
            snapshot.state = None;
        }
        self.start_locked().await.map(|_| ())
    }

    async fn stop_locked(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let peer = self.peer.lock().expect("never poisoned").take();
        if let Some((_, peer)) = peer {
            let _ = peer.call("shutdown", json!({}), SHUTDOWN).await;
            peer.kill().await;
            // Known gone now; its exit notification may arrive after a new
            // process is already serving.
            self.process_gone("Agent 脚本已重启");
        }
    }

    /// Stops for good, e.g. when the daemon reloads.
    pub async fn shutdown(&self) {
        // Never waits for the control lock: a start in progress (a Python
        // install, a hung `initialize`) must not keep the daemon from
        // exiting; a start that finishes afterwards sees `closed` and kills
        // what it started.
        self.closed.store(true, Ordering::SeqCst);
        self.stop_locked().await;
    }

    /// Re-reads the directory. An invalid manifest is reported and the
    /// running process is left alone.
    pub async fn reload(&self) -> Result<()> {
        let Some(resolved) = self.layout.resolve(&self.id, false) else {
            // Deleting `user/<id>` of an Agent that only exists there is how it
            // is disabled: stop it and say why.
            let _guard = self.control.lock().await;
            self.stop_locked().await;
            {
                let mut snapshot = self.snapshot.lock().expect("never poisoned");
                snapshot.problem = Some("这个 Agent 的目录已删除，已停用".into());
                snapshot.state = None;
                snapshot.resolved = None;
            }
            self.changed();
            return Ok(());
        };
        if let Err(error) = layout::read_manifest(&resolved.dir) {
            let message = format!("修改没有生效：{error:#}");
            self.snapshot.lock().expect("never poisoned").reload_error = Some(message.clone());
            self.changed();
            anyhow::bail!(message);
        }
        if self
            .snapshot
            .lock()
            .expect("never poisoned")
            .pending_load_failed
        {
            self.restore_pending();
        }
        self.restart().await
    }

    pub async fn reset(&self) -> Result<()> {
        if !self.layout.has_builtin(&self.id) {
            anyhow::bail!("{} 没有内置版本，不能恢复内置", self.id);
        }
        self.layout.reset(&self.id)?;
        self.restart().await
    }

    // -- calls -----------------------------------------------------------------

    /// One request with a deadline. A missed deadline restarts the process:
    /// the script stopped answering, and every other session of this Agent
    /// shares that process.
    pub async fn call(&self, method: &str, params: Value, deadline: Duration) -> Result<Value> {
        // The deadline and the restart it triggers belong to the host, not to
        // whoever asked: a caller with a shorter budget of its own (the
        // session layer gives interrupt three seconds) drops this future, and
        // a deaf script must still be restarted when its own deadline passes.
        let host = self
            .arc()
            .ok_or_else(|| anyhow!("the registry is shutting down"))?;
        let method = method.to_string();
        tokio::spawn(async move { host.call_owned(&method, params, deadline).await })
            .await
            .map_err(|error| anyhow!("Agent 调用意外中止：{error}"))?
    }

    async fn call_owned(&self, method: &str, params: Value, deadline: Duration) -> Result<Value> {
        let peer = self.ensure_running().await?;
        if method == "action.resume" {
            // Starting may fall back to another adapter. Bind the dispatch to
            // the process we will actually call, as well as the on-disk code.
            let expected = params
                .get("revision")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("恢复执行缺少适配器修订"))?;
            {
                let snapshot = self.snapshot.lock().expect("never poisoned");
                let resolved = self
                    .layout
                    .resolve(&self.id, snapshot.override_disabled)
                    .ok_or_else(|| anyhow!("恢复执行的适配器目录已改变"))?;
                anyhow::ensure!(
                    snapshot.running_revision.as_deref() == Some(expected)
                        && layout::script_revision(&resolved.dir, &self.layout.sdk_dir())?
                            == expected,
                    "恢复执行的适配器或 SDK 修订已改变；不会派发答案"
                );
            }
            anyhow::ensure!(
                self.current_peer()
                    .as_ref()
                    .is_some_and(|live| Arc::ptr_eq(live, &peer)),
                "恢复执行的进程已改变；不会派发答案"
            );
        }
        match peer.call(method, params, deadline).await {
            Ok(value) => Ok(value),
            Err(CallError::Timeout) => {
                self.logs.push(format!(
                    "[daemon] {method} 在 {} 秒内没有回应，重启 Agent 脚本",
                    deadline.as_secs()
                ));
                if let Some(host) = self.arc() {
                    tokio::spawn(async move {
                        let _guard = host.control.lock().await;
                        let still_current = host
                            .peer
                            .lock()
                            .expect("never poisoned")
                            .as_ref()
                            .is_some_and(|(_, live)| Arc::ptr_eq(live, &peer));
                        if still_current {
                            // The exit that follows is handled like any crash:
                            // turns failed, restart with backoff.
                            host.peer.lock().expect("never poisoned").take();
                            peer.kill().await;
                        }
                    });
                }
                Err(anyhow!("Agent 脚本{}", CallError::Timeout))
            }
            Err(error) => Err(anyhow!("{error}")),
        }
    }

    /// Asks the script to look again. Never waits for the answer: the new
    /// state arrives as a notification.
    pub fn refresh(&self) {
        let Some(host) = self.arc() else { return };
        tokio::spawn(async move {
            let _ = host.call("refresh", json!({}), SHORT).await;
        });
    }

    /// Starts the process in the background, for the list to fill in.
    pub fn warm(&self) {
        let Some(host) = self.arc() else { return };
        tokio::spawn(async move {
            let _ = host.ensure_running().await;
        });
    }

    pub async fn run_action(&self, action: &str) -> Result<String> {
        let _one_action = self.actions.lock().await;
        {
            let snapshot = self.snapshot.lock().expect("never poisoned");
            anyhow::ensure!(
                !snapshot.pending_load_failed,
                "无法读取原待答记录；修复前不会覆盖它"
            );
            if let Some(saved) = snapshot.pending_actions.values().find(|p| !p.claimed) {
                anyhow::ensure!(
                    saved.stopped,
                    "停止阶段未确认；请先核查进程和 agents/pending 记录，不会重复执行"
                );
                if saved.action == action {
                    return Ok(saved.job.clone());
                }
                anyhow::bail!("请先回答或取消现有的待答事项");
            }
            if let Some(job) = snapshot
                .job
                .as_ref()
                .filter(|j| !j.done && snapshot.foreground_job.as_deref() == Some(j.id.as_str()))
            {
                if job.action.as_deref() == Some(action) {
                    return Ok(job.id.clone());
                }
                anyhow::bail!("已有动作正在执行");
            }
        }
        let declared = {
            let snapshot = self.snapshot.lock().expect("never poisoned");
            snapshot
                .state
                .as_ref()
                .is_some_and(|state| state.actions.iter().any(|known| known.id == action))
        };
        if !declared {
            anyhow::bail!("{} 现在没有名为 {action} 的动作", self.id);
        }
        let reply = self
            .call("action.run", json!({ "action": action }), SHORT)
            .await?;
        let job = reply
            .get("job")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.snapshot.lock().expect("never poisoned").foreground_job = Some(job.clone());
        if !job.is_empty() {
            // On screen from the moment it is accepted, not from its first
            // progress line: an install waiting for its confirmation is
            // still a job the person started.
            self.on_job(&json!({ "job": job, "action": action }));
        }
        Ok(job)
    }

    pub async fn answer(&self, request_id: &str, outcome: AgentRequestOutcome) -> Result<()> {
        // A durable request belongs to the daemon, not to an in-memory
        // Future in whichever script generation happened to open it.
        let suspended = {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            if let Some(saved) = snapshot.pending_actions.get(request_id) {
                anyhow::ensure!(saved.stopped, "停止阶段尚未确认，不能派发答案");
                if saved.claimed {
                    anyhow::bail!("这个请求已经结束了");
                }
                validate_answer(&saved.request, &outcome)?;
                let current = self
                    .layout
                    .resolve(&self.id, snapshot.override_disabled)
                    .and_then(|resolved| {
                        layout::script_revision(&resolved.dir, &self.layout.sdk_dir()).ok()
                    });
                if saved.revision.is_none()
                    || saved.revision != current
                    || (self.running() && snapshot.running_revision != saved.revision)
                {
                    if !matches!(outcome, AgentRequestOutcome::Canceled) {
                        anyhow::bail!("适配器或 SDK 修订已改变；原问题仍保留，请取消后按新版本重新确认，不会派发旧答案");
                    }
                    let job = saved.job.clone();
                    let mut actions = snapshot.pending_actions.clone();
                    actions.remove(request_id);
                    pending::save(&self.pending_path(), &actions)?;
                    snapshot.pending_actions = actions;
                    snapshot.requests.remove(request_id);
                    drop(snapshot);
                    let _ = self.events.send(RegistryEvent::RequestClosed {
                        agent_id: self.id.clone(),
                        request_id: request_id.into(),
                    });
                    self.on_job(&json!({ "job": job, "done": true, "phase": "canceled",
                        "message": "已取消旧版本待答事项；未恢复执行，已有外部结果不会撤回" }));
                    return Ok(());
                }
                let mut actions = snapshot.pending_actions.clone();
                let saved = actions.get_mut(request_id).expect("present");
                saved.claimed = true;
                let mut decision = outcome.clone();
                if let AgentRequestOutcome::Answered { answers, .. } = &mut decision {
                    answers.retain(|answer| {
                        !saved.request.questions.iter().any(|q| {
                            q.id == answer.question_id
                                && q.input == Some(genehub_proto::AgentRequestInput::Secret)
                        })
                    });
                }
                saved.decision = Some(decision);
                let saved = saved.clone();
                // Secret answers are never stored. A claimed operation is
                // never replayed after an uncertain dispatch.
                pending::save(&self.pending_path(), &actions)?;
                snapshot.pending_actions = actions;
                snapshot.requests.remove(request_id);
                Some(saved)
            } else {
                None
            }
        };
        if let Some(saved) = suspended {
            let _ = self.events.send(RegistryEvent::RequestClosed {
                agent_id: self.id.clone(),
                request_id: request_id.into(),
            });
            self.on_job(
                &json!({ "job": saved.job, "phase": "resume", "message": "已受理，正在恢复执行" }),
            );
            let delivered = self.call("action.resume", json!({
                "job": saved.job, "action": saved.action, "step": saved.step,
                "revision": saved.revision,
                "secretIds": saved.request.questions.iter().filter(|q| q.input == Some(genehub_proto::AgentRequestInput::Secret)).map(|q| q.id.clone()).collect::<Vec<_>>(),
                "outcome": outcome,
            }), SHORT).await;
            if delivered.is_err() {
                self.on_job(&json!({ "job": saved.job, "done": true, "phase": "unknown",
                    "error": "执行结果未知，请核查 Agent 状态；不会自动重放答案" }));
            }
            return delivered.map(|_| ());
        }
        let request = self
            .snapshot
            .lock()
            .expect("never poisoned")
            .requests
            .remove(request_id);
        let Some(request) = request else {
            anyhow::bail!("这个请求已经结束了");
        };
        let _ = self.events.send(RegistryEvent::RequestClosed {
            agent_id: self.id.clone(),
            request_id: request_id.to_string(),
        });
        self.changed();
        let delivered = self
            .call(
                "request.answer",
                json!({ "id": request_id, "outcome": outcome }),
                SHORT,
            )
            .await;
        if delivered.is_err() && self.current_peer().is_some() {
            // The script is still there and still waiting: put the request
            // back so a person can answer again.
            self.snapshot
                .lock()
                .expect("never poisoned")
                .requests
                .insert(request.id.clone(), request.clone());
            let _ = self.events.send(RegistryEvent::RequestOpened(request));
            self.changed();
        }
        delivered.map(|_| ())
    }

    /// Runs `agent.py test` as a separate short process.
    pub async fn test(&self, live: bool) -> Result<(bool, String)> {
        // What a repair edits is `user/<id>`, so that is what gets tested even
        // while crashes have the running copy fall back to the built-in one.
        // Read-only: the snapshot keeps describing the running process.
        let resolved = self
            .layout
            .resolve(&self.id, false)
            .ok_or_else(|| anyhow!("这个 Agent 的目录不存在"))?;
        layout::read_manifest(&resolved.dir)?;
        let python = self.runtime.python(&|_| {}).await?;
        let state_dir = self.layout.state_dir(&self.id);
        std::fs::create_dir_all(&state_dir)?;
        let mut command = Command::new(&python);
        command
            .arg("-I")
            .arg("-X")
            .arg("utf8")
            .arg(crate::guest_paths::host_path(
                &self.layout.sdk_dir().join("boot.py"),
            ))
            .arg(crate::guest_paths::host_path(&resolved.dir))
            .arg("test");
        if live {
            command.arg("--live");
        }
        command
            .current_dir(&state_dir)
            .env("GENEHUB_AGENT_ID", &self.id)
            .env(
                "GENEHUB_AGENT_STATE",
                crate::guest_paths::host_path(&state_dir),
            )
            .env_remove("GENEHUB_SESSION_ID")
            .env_remove("GENEHUB_CONTROLLER_TOKEN")
            .env_remove("GENEHUB_CLI")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        crate::adapter::owned_child(&mut command);
        // The tests themselves stay inside the budget a CLI call gets, so
        // whoever asked sees the answer rather than a dropped request.
        let output = tokio::time::timeout(TEST_BUDGET, command.output())
            .await
            .map_err(|_| anyhow!("agent.py test 超过 {} 秒没有结束", TEST_BUDGET.as_secs()))??;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            text.push_str("\n--- stderr ---\n");
            text.push_str(&stderr);
        }
        if !output.status.success() {
            // A script that dies before printing must still say how it ended.
            text.push_str(&format!(
                "\n--- agent.py test 结束：{} ---\n",
                output.status
            ));
        }
        Ok((output.status.success(), bounded(&text, TEST_OUTPUT_LIMIT)))
    }

    // -- sessions ----------------------------------------------------------------

    fn live_sessions(&self) -> Vec<Arc<SessionLink>> {
        let mut sessions = self.sessions.lock().expect("never poisoned");
        sessions.retain(|_, link| link.strong_count() > 0);
        sessions.values().filter_map(Weak::upgrade).collect()
    }

    fn session(&self, id: &str) -> Option<Arc<SessionLink>> {
        self.sessions
            .lock()
            .expect("never poisoned")
            .get(id)
            .and_then(Weak::upgrade)
    }

    pub async fn open_session(&self, config: &SessionConfig) -> Result<Arc<SessionLink>> {
        let wire = json!({
            "cwd": crate::guest_paths::host_path(&config.cwd),
            "scratchDir": crate::guest_paths::host_path(&config.scratch_dir),
            "modelId": config.model_id,
            "modeId": config.mode_id,
            "effortId": config.effort_id,
            "fast": config.fast,
            "runtimeValues": config.runtime_values,
            "additionalSystemPrompt": config.additional_system_prompt,
            "skillsDir": config.skills_dir.as_deref().map(crate::guest_paths::host_path),
            "frontDoorCli": config.front_door_cli,
            "controllerToken": config.controller_token,
            "resume": config.resume.as_ref().map(|handle| handle.value.clone()),
        });
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let link = Arc::new(SessionLink {
            id: config.session_id.clone(),
            config: std::sync::Mutex::new(wire.clone()),
            events,
            persist: std::sync::Mutex::new(
                config.resume.as_ref().map(|handle| handle.value.clone()),
            ),
            pid: std::sync::Mutex::new(None),
            active_turn: std::sync::Mutex::new(None),
            started: AtomicBool::new(false),
        });
        self.sessions
            .lock()
            .expect("never poisoned")
            .insert(link.id.clone(), Arc::downgrade(&link));
        let params = json!({ "sessionId": link.id, "config": wire });
        let host = self
            .arc()
            .ok_or_else(|| anyhow!("the registry is shutting down"))?;
        // Running before the start is sent, so a `session.close` for a start
        // the caller gave up on can never overtake it on the pipe.
        if let Err(error) = self.ensure_running().await {
            self.forget_session(&link.id);
            return Err(error);
        }
        let session_id = link.id.clone();
        let opened = link.clone();
        let (answer, answered) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let start = host.call_owned("session.start", params, super::SESSION_START);
            tokio::pin!(start);
            let mut answer = answer;
            let result = tokio::select! {
                biased;
                result = &mut start => result,
                _ = answer.closed() => {
                    // Whoever asked gave up (the user pressed stop while the
                    // CLI was starting). Tell the script now, so it can end
                    // what it already started, instead of after the start
                    // deadline.
                    host.abandon_session(&session_id);
                    let _ = start.await;
                    return;
                }
            };
            if result.is_ok() {
                // Set here, not by the caller: a restart that follows must
                // start this session again even if nobody is waiting.
                opened.started.store(true, Ordering::SeqCst);
            }
            if let Err(result) = answer.send(result) {
                if result.is_ok() {
                    host.abandon_session(&session_id);
                }
            }
        });
        match answered.await {
            Ok(Ok(_)) => Ok(link),
            Ok(Err(error)) => {
                self.sessions
                    .lock()
                    .expect("never poisoned")
                    .remove(&link.id);
                Err(error)
            }
            Err(_) => Err(anyhow!("Agent 会话启动意外中止")),
        }
    }

    /// Closes a session nobody is waiting for any more. The SDK ends every
    /// process it started for that session on `session.close`; if the script
    /// stopped reading, the close misses its deadline and the restart that
    /// follows ends the script, whose SIGTERM handler ends them instead.
    fn abandon_session(&self, id: &str) {
        self.forget_session(id);
        let Some(host) = self.arc() else { return };
        let id = id.to_string();
        tokio::spawn(async move {
            let _ = host
                .call_owned("session.close", json!({ "sessionId": id }), CLOSE)
                .await;
        });
    }

    pub fn forget_session(&self, id: &str) {
        self.sessions.lock().expect("never poisoned").remove(id);
    }

    // -- notifications -------------------------------------------------------------

    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "state" => {
                let state = parse_state(&params);
                self.snapshot.lock().expect("never poisoned").state = Some(state);
                self.changed();
            }
            "job.progress" => self.on_job(&params),
            "request.open" => self.on_request_open(params),
            "request.prepare" => {
                let id = params
                    .get("request")
                    .and_then(|r| r.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let result = self.on_request_suspend(params, false);
                if let Some(host) = self.arc() {
                    tokio::spawn(async move {
                        let _ = host
                            .call(
                                "request.prepared",
                                json!({ "id": id,
                            "error": result.err().map(|e| e.to_string()) }),
                                SHORT,
                            )
                            .await;
                    });
                }
            }
            "request.suspend" => {
                let job = params
                    .get("job")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if let Err(error) = self.on_request_suspend(params, true) {
                    self.logs.push(format!("[daemon] 停止确认被拒绝：{error}"));
                    self.on_job(&json!({ "job": job, "done": true, "phase": "unknown",
                        "error": "停止确认未通过；原记录已保留，请先核查进程和适配器修订" }));
                }
            }
            "request.close" => {
                let Some(id) = params.get("id").and_then(Value::as_str) else {
                    return;
                };
                // A stale generation cannot cancel a durable obligation.
                if self
                    .snapshot
                    .lock()
                    .expect("never poisoned")
                    .pending_actions
                    .contains_key(id)
                {
                    return;
                }
                let removed = self
                    .snapshot
                    .lock()
                    .expect("never poisoned")
                    .requests
                    .remove(id);
                if removed.is_some() {
                    let _ = self.events.send(RegistryEvent::RequestClosed {
                        agent_id: self.id.clone(),
                        request_id: id.to_string(),
                    });
                    self.changed();
                }
            }
            "session.event" => self.on_session_event(params),
            "session.persist" => {
                let Some(link) = session_of(self, &params) else {
                    return;
                };
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                *link.persist.lock().expect("never poisoned") = Some(value.clone());
                link.config.lock().expect("never poisoned")["resume"] = value;
            }
            "session.pid" => {
                let Some(link) = session_of(self, &params) else {
                    return;
                };
                *link.pid.lock().expect("never poisoned") = params
                    .get("pid")
                    .and_then(Value::as_u64)
                    .map(|pid| pid as u32);
            }
            other => {
                self.logs.push(format!("[daemon] 未知通知 {other}，已忽略"));
            }
        }
    }

    fn on_job(&self, params: &Value) {
        let Some(id) = params.get("job").and_then(Value::as_str) else {
            return;
        };
        {
            let mut snapshot = self.snapshot.lock().expect("never poisoned");
            let fresh = snapshot.job.as_ref().map(|job| job.id.as_str()) != Some(id);
            let asked_for = snapshot.foreground_job.as_deref() == Some(id);
            if fresh && !asked_for && snapshot.job.as_ref().is_some_and(|job| !job.done) {
                // One job on screen at a time: background work must not
                // overwrite what a person is watching; the action a person
                // started always takes the slot. Its lines still reach the log.
                drop(snapshot);
                if let Some(line) = params.get("log").and_then(Value::as_str) {
                    self.logs.push(format!("[job {id}] {line}"));
                }
                return;
            }
            if fresh {
                snapshot.job = Some(AgentJobInfo {
                    id: id.to_string(),
                    action: params
                        .get("action")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    phase: None,
                    percent: None,
                    message: None,
                    log_tail: Vec::new(),
                    done: false,
                    error: None,
                });
            }
            let job = snapshot.job.as_mut().expect("just set");
            if let Some(phase) = params.get("phase").and_then(Value::as_str) {
                job.phase = Some(bounded(phase, LABEL_LIMIT));
            }
            if let Some(percent) = params.get("percent").and_then(Value::as_f64) {
                job.percent = Some(percent.clamp(0.0, 100.0));
            }
            if let Some(message) = params.get("message").and_then(Value::as_str) {
                job.message = Some(bounded(message, TEXT_LIMIT));
            }
            if let Some(line) = params.get("log").and_then(Value::as_str) {
                job.log_tail.push(line.chars().take(400).collect());
                let excess = job.log_tail.len().saturating_sub(JOB_LOG_LINES);
                job.log_tail.drain(..excess);
                self.logs.push(format!("[job {id}] {line}"));
            }
            if params.get("done").and_then(Value::as_bool) == Some(true) {
                job.done = true;
            }
            if let Some(error) = params.get("error").and_then(Value::as_str) {
                job.error = Some(bounded(error, TEXT_LIMIT));
            }
            if params.get("done").and_then(Value::as_bool) == Some(true)
                && params.get("error").is_none()
            {
                let mut actions = snapshot.pending_actions.clone();
                actions.retain(|_, saved| saved.job != id || !saved.claimed);
                if actions.len() != snapshot.pending_actions.len()
                    && pending::save(&self.pending_path(), &actions).is_ok()
                {
                    snapshot.pending_actions = actions;
                }
            }
        }
        self.changed();
    }

    fn on_request_open(&self, params: Value) {
        let mut value = params;
        value["agentId"] = json!(self.id);
        let request: AgentUserRequest = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(error) => {
                self.logs
                    .push(format!("[daemon] 无效的用户请求，已忽略：{error}"));
                return;
            }
        };
        if let Err(why) = request_within_bounds(&request) {
            self.logs
                .push(format!("[daemon] 用户请求不合规，已忽略：{why}"));
            return;
        }
        {
            let snapshot = self.snapshot.lock().expect("never poisoned");
            if snapshot.requests.len() >= OPEN_REQUESTS_LIMIT
                && !snapshot.requests.contains_key(&request.id)
            {
                drop(snapshot);
                self.logs
                    .push("[daemon] 未答复的用户请求过多，已忽略新的请求".into());
                return;
            }
        }
        self.snapshot
            .lock()
            .expect("never poisoned")
            .requests
            .insert(request.id.clone(), request.clone());
        let _ = self.events.send(RegistryEvent::RequestOpened(request));
        self.changed();
    }

    fn on_request_suspend(&self, mut params: Value, stopped: bool) -> Result<()> {
        params["request"]["agentId"] = json!(self.id);
        params["claimed"] = json!(false);
        params["decision"] = Value::Null;
        params["stopped"] = json!(stopped);
        let mut saved = serde_json::from_value::<PendingAction>(params)
            .map_err(|_| anyhow!("无效的持久待答请求"))?;
        let safe_id = |s: &str| {
            !s.is_empty()
                && s.len() <= LABEL_LIMIT
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        };
        anyhow::ensure!(
            request_within_bounds(&saved.request).is_ok()
                && saved.request.display.is_empty()
                && safe_id(&saved.job)
                && safe_id(&saved.action)
                && safe_id(&saved.step),
            "持久请求不合规；不可保存临时授权展示材料"
        );
        let mut snapshot = self.snapshot.lock().expect("never poisoned");
        anyhow::ensure!(!snapshot.pending_load_failed, "原待答记录不可读，未覆盖");
        let resolved = self
            .layout
            .resolve(&self.id, snapshot.override_disabled)
            .ok_or_else(|| anyhow!("适配器目录已改变"))?;
        let current = layout::script_revision(&resolved.dir, &self.layout.sdk_dir())?;
        anyhow::ensure!(
            snapshot.running_revision.as_deref() == Some(current.as_str()),
            "适配器或 SDK 文件已改变，需重新加载并确认"
        );
        saved.revision = Some(current);
        if stopped {
            let original = snapshot
                .pending_actions
                .get(&saved.request.id)
                .ok_or_else(|| anyhow!("没有已确认落盘的准备记录"))?;
            anyhow::ensure!(
                !original.claimed
                    && !original.stopped
                    && original.request == saved.request
                    && original.job == saved.job
                    && original.action == saved.action
                    && original.step == saved.step
                    && original.revision == saved.revision,
                "停止确认与准备记录不一致"
            );
        } else {
            anyhow::ensure!(
                snapshot
                    .pending_actions
                    .values()
                    .filter(|p| !p.claimed)
                    .count()
                    < OPEN_REQUESTS_LIMIT
                    && !snapshot.pending_actions.contains_key(&saved.request.id),
                "待答事项已存在或过多"
            );
        }
        let mut actions = snapshot.pending_actions.clone();
        actions.retain(|id, p| id == &saved.request.id || p.job != saved.job || !p.claimed);
        while actions.len() >= 64 && !actions.contains_key(&saved.request.id) {
            let old = actions
                .iter()
                .find(|(_, p)| p.claimed)
                .map(|(id, _)| id.clone());
            if let Some(old) = old {
                actions.remove(&old);
            } else {
                break;
            }
        }
        actions.insert(saved.request.id.clone(), saved.clone());
        pending::save(&self.pending_path(), &actions)
            .map_err(|_| anyhow!("无法保存待答事项，未展示请求"))?;
        snapshot.pending_actions = actions;
        if stopped {
            snapshot
                .requests
                .insert(saved.request.id.clone(), saved.request.clone());
        }
        snapshot.foreground_job = Some(saved.job.clone());
        drop(snapshot);
        self.on_job(&json!({ "job": saved.job, "action": saved.action,
            "phase": if stopped { "waiting" } else { "stopping" },
            "message": if stopped { "已停止执行，等待用户答复" } else { "待答记录已保存，正在停止执行" } }));
        if stopped {
            let _ = self
                .events
                .send(RegistryEvent::RequestOpened(saved.request));
        }
        Ok(())
    }

    fn on_session_event(&self, params: Value) {
        let Some(link) = session_of(self, &params) else {
            return;
        };
        let raw = params.get("event").cloned().unwrap_or(Value::Null);
        let event: SessionEvent = match serde_json::from_value(raw) {
            Ok(event) => event,
            Err(error) => {
                self.logs.push(format!(
                    "[daemon] 会话 {} 收到不合规的事件，已丢弃：{error}",
                    link.id
                ));
                return;
            }
        };
        match &event {
            SessionEvent::TurnCompleted { turn_id, .. }
            | SessionEvent::TurnFailed { turn_id, .. }
            | SessionEvent::TurnCanceled { turn_id } => link.end_turn(turn_id),
            _ => {}
        }
        let _ = link.events.send(event);
    }
}

fn session_of(host: &AgentHost, params: &Value) -> Option<Arc<SessionLink>> {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .and_then(|id| host.session(id))
}

/// A partial state is completed with the defaults of each type, so a script
/// that leaves a field out is not refused for it.
fn parse_state(params: &Value) -> ScriptState {
    fn merged<T: serde::de::DeserializeOwned + serde::Serialize + Default>(
        raw: Option<&Value>,
    ) -> T {
        let mut base = serde_json::to_value(T::default()).unwrap_or(Value::Null);
        if let (Some(Value::Object(overlay)), Value::Object(target)) = (raw, &mut base) {
            for (key, value) in overlay {
                target.insert(key.clone(), value.clone());
            }
        }
        serde_json::from_value(base).unwrap_or_default()
    }
    ScriptState {
        ready: params
            .get("ready")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message: params
            .get("message")
            .and_then(Value::as_str)
            .map(|message| bounded(message, TEXT_LIMIT)),
        version: params
            .get("version")
            .and_then(Value::as_str)
            .map(|version| bounded(version, LABEL_LIMIT)),
        actions: params
            .get("actions")
            .cloned()
            .and_then(|actions| serde_json::from_value::<Vec<AgentActionInfo>>(actions).ok())
            .unwrap_or_default()
            .into_iter()
            .take(ACTIONS_LIMIT)
            .map(|mut action| {
                action.label = bounded(&action.label, LABEL_LIMIT);
                action
            })
            .collect(),
        capabilities: merged(params.get("capabilities")),
        catalog: merged(params.get("catalog")),
    }
}

fn host_os() -> &'static str {
    if crate::guest_paths::windows_host() {
        "windows"
    } else if cfg!(target_family = "wasm") {
        // The guest cannot tell macOS from Linux; the script can (`sys.platform`).
        "unix"
    } else {
        std::env::consts::OS
    }
}

/// `text` cut to at most `limit` bytes on a character boundary.
fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn validate_answer(request: &AgentUserRequest, outcome: &AgentRequestOutcome) -> Result<()> {
    if let AgentRequestOutcome::Answered { option_id, answers } = outcome {
        anyhow::ensure!(
            request.options.iter().any(|o| o.id == *option_id),
            "未知的请求选项"
        );
        anyhow::ensure!(answers.len() <= REQUEST_ITEMS_LIMIT, "回答过多");
        let mut seen = std::collections::BTreeSet::new();
        for answer in answers {
            let question = request
                .questions
                .iter()
                .find(|q| q.id == answer.question_id)
                .ok_or_else(|| anyhow!("未知的问题"))?;
            anyhow::ensure!(seen.insert(&answer.question_id), "问题回答重复");
            anyhow::ensure!(
                answer
                    .freeform_text
                    .as_ref()
                    .is_none_or(|s| s.len() <= 16 * 1024),
                "回答过长"
            );
            anyhow::ensure!(
                question.allow_multiple || answer.selected_option_ids.len() <= 1,
                "该问题只支持单选"
            );
            anyhow::ensure!(
                answer
                    .selected_option_ids
                    .iter()
                    .all(|id| question.options.iter().any(|o| o.id == *id)),
                "未知的问题选项"
            );
        }
    }
    Ok(())
}

fn request_within_bounds(request: &AgentUserRequest) -> std::result::Result<(), &'static str> {
    let label = |text: &str| text.len() <= LABEL_LIMIT;
    if request.options.is_empty() {
        return Err("至少需要一个选项");
    }
    if request.id.is_empty() || !label(&request.id) || !label(&request.title) {
        return Err("id 或标题过长");
    }
    if request
        .detail
        .as_deref()
        .is_some_and(|detail| detail.len() > TEXT_LIMIT)
    {
        return Err("说明过长");
    }
    if request.display.len() > REQUEST_ITEMS_LIMIT
        || request.questions.len() > REQUEST_ITEMS_LIMIT
        || request.options.len() > REQUEST_ITEMS_LIMIT
    {
        return Err("展示项、问题或选项过多");
    }
    for item in &request.display {
        let limit = if item.render.as_deref() == Some("qr") {
            QR_LIMIT
        } else {
            TEXT_LIMIT
        };
        if item.value.len() > limit || item.label.as_deref().is_some_and(|text| !label(text)) {
            return Err("展示内容过长");
        }
    }
    for question in &request.questions {
        if !label(&question.id)
            || question.prompt.len() > TEXT_LIMIT
            || question.options.len() > REQUEST_ITEMS_LIMIT
            || question
                .options
                .iter()
                .any(|option| !label(&option.id) || !label(&option.label))
        {
            return Err("问题过长或选项过多");
        }
    }
    if request
        .options
        .iter()
        .any(|option| !label(&option.id) || !label(&option.label))
    {
        return Err("选项过长");
    }
    Ok(())
}
