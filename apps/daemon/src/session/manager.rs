//! Session lifecycle: create, run, persist, replay.
//!
//! Everything here is agent-agnostic. The manager holds a `dyn AgentSession`
//! and never learns which adapter produced it. Sessions persist across
//! reloads, so a Live update swaps the binary under a running conversation.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use genehub_proto::{
    Attachment, BlobOverview, BlobPayload, BlobRef, Catalog, ForkMethod, ForkTarget, ForkTransfer,
    HistoryCoverage, ImportContinuation, ItemDelta, ManagedSessionInfo, PermissionOptionKind,
    PermissionOutcome, PermissionRequest, PermissionRequestKind, ProbeState, RetrievalCapability,
    RoundLayer, RoundLayerOutcome, RoundSummary, RoundTrunk, SequencedEvent, SessionAgentTarget,
    SessionArtifactBundle, SessionArtifactFile, SessionArtifactUpload, SessionContext,
    SessionEvent, SessionImportCandidate, SessionImportListing, SessionImportSource,
    SessionInspection, SessionLineage, SessionNarrativePage, SessionReadSource, SessionRoundPage,
    SessionSnapshot, SessionStatus, SessionSummary, TimelineItem, ToolStatus, TrunkLocator,
    TurnErrorCode, TurnOutcome, TurnStats, Usage,
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex, RwLock};

use super::context_seed::{
    build_context_seed, build_portable_context_seed, prompt_with_seed, seed_token_budget,
};
use super::images;
use super::overview;
use super::rounds::{self, RoundOutcome, RoundRecord, TrunkBuilder, TrunkItem, TrunkSummary};
use super::store::{
    self, agent_title_fits_current, apply_catalog_title_repair, is_catalog_noise_title,
    normalize_session_title, now_ms, title_from, ChatLog, ContextSeed, ContextSeedState,
    ImportedSessionMeta, SessionMeta, Store, SESSION_FORMAT,
};
use crate::adapter::registry::Registry;
use crate::adapter::usage::{self as token_usage};
use crate::adapter::{AgentSession, PersistHandle, PromptInput, ProviderMap, SessionConfig};
use crate::diagnostics::Diagnostics;

#[path = "activity.rs"]
mod activity;
#[path = "inbox.rs"]
mod inbox;

#[path = "manager/lifecycle.rs"]
mod lifecycle;
#[cfg(test)]
use lifecycle::*;
#[path = "manager/read.rs"]
mod read;
#[path = "manager/registry.rs"]
mod registry;
use read::*;
#[path = "manager/turn.rs"]
mod turn;
use turn::*;
#[path = "manager/settings.rs"]
mod settings;
use settings::*;
#[path = "manager/human.rs"]
mod human;
use human::*;
#[path = "manager/execution.rs"]
mod execution;
#[path = "manager/live.rs"]
mod live;
use execution::*;
#[path = "manager/pump.rs"]
mod pump;
use pump::*;

const BROADCAST_CAPACITY: usize = 1024;
const IMPORT_CANDIDATE_TTL_MS: i64 = 10 * 60 * 1000;
/// Upper bound for one `*.batchGet` call. Abuse control, not a security
/// boundary: keeps a single request from turning into an unbounded scan.
const MAX_BATCH_GET: usize = 64;

/// A session id that matches nothing in memory or on disk. The router maps
/// this typed error to `notFound`; the Display text is user-facing and free
/// to change without touching the wire classification.
#[derive(Debug)]
pub struct SessionMissing(pub String);

impl std::fmt::Display for SessionMissing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "会话不存在：{}", self.0)
    }
}

impl std::error::Error for SessionMissing {}

/// Result of asking whether a Worker Session can take a post-restart continue turn.
#[derive(Debug)]
pub(crate) enum WorkerContinuation {
    Ready,
    ProcessAlive { pid: Option<u32> },
    Unavailable { reason: String },
}

/// A snapshot is one RPC body (`MAX_RPC_BODY_BYTES` is 2.9 MiB). Leave room for
/// summary/round metadata and JSON escaping instead of importing a transcript
/// that can be written successfully but never opened.
const IMPORT_VISIBLE_BYTES: usize = 1_800_000;
const IMPORT_VISIBLE_ITEMS: usize = 4_000;

#[derive(Debug, Clone)]
struct CachedImportCandidate {
    workspace_id: String,
    cwd: PathBuf,
    agent_id: String,
    source_id: String,
    source_key: String,
    title: String,
    expires_at_ms: i64,
}

/// LLM request round counter for one round. `turn` is the current adapter
/// turn's high-water mark — the adapter counts from zero every turn — and
/// `round_base` folds in every earlier turn of the round, so the value handed
/// to the trunk builder stays cumulative across permission resumes.
///
/// Turn boundaries are explicit: a progress event whose `turn_id` differs
/// from the current one opens a new turn and folds the previous mark into the
/// base. A progress event from an already-finished turn (a late frame still
/// sitting in the channel) is ignored, so it cannot double-fold the base.
#[derive(Default)]
struct LlmRounds {
    round_base: u32,
    turn: u32,
    turn_id: Option<String>,
    finished_turns: Vec<String>,
}

impl LlmRounds {
    /// Records the current turn's merged counter.
    fn observe(&mut self, turn_id: &str, turn_rounds: u32) {
        if self.turn_id.as_deref() == Some(turn_id) {
            self.turn = turn_rounds;
            return;
        }
        if self.finished_turns.iter().any(|id| id == turn_id) {
            return;
        }
        if let Some(previous) = self.turn_id.take() {
            self.round_base = self.round_base.saturating_add(self.turn);
            self.finished_turns.push(previous);
        }
        self.turn = turn_rounds;
        self.turn_id = Some(turn_id.to_string());
    }

    fn cumulative(&self) -> u32 {
        self.round_base.saturating_add(self.turn)
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

/// One live session.
struct Live {
    /// The sole execution claim. Round identity is archival and may span many
    /// of these claims. This lock never covers a call into an agent.
    execution: Mutex<Option<Execution>>,
    next_execution: AtomicU64,
    inbox_lock: Mutex<()>,
    delivery_dispatching: AtomicBool,
    closing: AtomicBool,
    retirement: Mutex<()>,
    cleanup: crate::adapter::SessionTasks,
    /// Where this session's own directory is. Held here so the trunk writer
    /// can run from inside the event pump, which is the only place that knows
    /// when a trunk closed.
    store: Store,
    meta: Mutex<SessionMeta>,
    status: Mutex<SessionStatus>,
    /// The session narrative, plus the work items of the trunk currently being
    /// built. Bounded on both counts: narrative grows with what was said, and
    /// a trunk rolls over at a semantic batch boundary after its tool-call
    /// threshold. Work items are dropped as soon
    /// as their trunk is written, which is what keeps a round that runs for a
    /// day from keeping a day of tool output resident
    /// (`docs/session-storage.md` §4).
    items: Mutex<Vec<TimelineItem>>,
    /// Every round of this session, folded, as read from `chat.jsonl` and
    /// extended as rounds settle. One small record each, never the round's
    /// contents.
    rounds: Mutex<Vec<RoundRecord>>,
    unsaved_rounds: Mutex<Vec<String>>,
    /// Captured ancestor rounds are immutable for this fork. Resolve once per
    /// loaded session, without retaining ancestor narrative or tool bodies.
    inherited_rounds: Mutex<Option<Vec<RoundView>>>,
    /// Where each work item of the open trunk landed in the blob layer. Filled
    /// by the blob writer, consumed when the trunk is written, then dropped
    /// with the trunk's items.
    blob_refs: Mutex<HashMap<String, BlobRef>>,
    seq: AtomicU64,
    stream_epoch: String,
    /// When this session last published anything.
    ///
    /// Reported to clients while a turn is running, and only then, so that a
    /// person waiting can see how long it has been quiet. Nothing in the daemon
    /// reads it: silence is not evidence of death, and the only party who can
    /// tell a long thought from a wedged process is the one who asked.
    last_activity_ms: AtomicI64,
    replay: Mutex<VecDeque<SequencedEvent>>,
    events: broadcast::Sender<SequencedEvent>,
    /// Shared rather than owned so a caller can take a handle to the agent and
    /// let go of the lock before awaiting it. Everything that reaches an agent
    /// crosses a process boundary, and holding this across one of those awaits
    /// is what turns "the agent stopped answering" into "the session stopped
    /// answering": stop, close, and every read of the session queue behind it.
    agent: Mutex<Option<Arc<dyn AgentSession>>>,
    /// Deployment-aware context supplied by the authenticated UI. It is kept
    /// for an in-process Agent restart but not persisted: the next browser send
    /// recomposes domain/channel/workspace from its actual address.
    additional_system_prompt: Mutex<Option<String>>,
    /// True while a wait is on disk but the agent process has not stopped yet.
    /// The card stays out of snapshots until the process is gone.
    card_held: AtomicBool,
    /// Serializes presentation, Human decisions and continuation dispatch.
    interaction_lock: Mutex<()>,
    runtime_settings: Mutex<()>,
    /// Item ids settled during the current turn, flushed to disk when it ends.
    turn_items: Mutex<Vec<String>>,
    /// When the turn in progress last had its narrative written out, which
    /// paces that write rather than doing it per streamed token.
    open_turn_written_ms: AtomicI64,
    open_turn_dirty: AtomicBool,
    /// Applied context seed or inbox binding that could not be written after
    /// the agent had already accepted the prompt. Retried when the turn ends
    /// so a disk error does not retire a live agent.
    deferred_seed: Mutex<Option<ContextSeed>>,
    deferred_meta: AtomicBool,
    /// Work item ids belonging to the trunk currently open, in order. Cleared
    /// when that trunk is written out, so this stays bounded by a soft batch
    /// boundary during tool-heavy work
    /// however many adapter turns the round spans.
    open_trunk_items: Mutex<Vec<String>>,
    /// LLM request round counter feeding trunk pagination, mirrored from the
    /// pump's `TurnProgress` merge. The adapter's counter is cumulative within
    /// one turn only, but a round spans several turns (permission resumes,
    /// client-declared continuations), so each finished turn's high-water mark
    /// is folded into a round base the moment the counter is seen resetting.
    llm_rounds: Mutex<LlmRounds>,
    pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pump_stop: tokio::sync::watch::Sender<bool>,
    /// Daemon-owned round bookkeeping — one user request, possibly several
    /// adapter turns (`docs/agent-analysis-substrate-proposal.md` §3.2).
    /// `None` before the first `session.send` on this session. Kept around
    /// (not cleared) once a round settles, so the last one stays inspectable
    /// in memory until the next round replaces it; the durable copy lives in
    /// the round ledger (`session/rounds.rs`, §8 step 2).
    active_round: Mutex<Option<ActiveRound>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExecutionPhase {
    Starting,
    Running,
    Stopping,
    Saving,
    CleanupFailed,
}

#[derive(Clone)]
struct Execution {
    id: u64,
    phase: ExecutionPhase,
    consultation: bool,
    input_ids: Vec<String>,
    human_request_id: Option<String>,
    unattended_unavailable: bool,
    turn_id: Option<String>,
    cancel: tokio::sync::watch::Sender<bool>,
    ready: tokio::sync::watch::Sender<bool>,
    terminal: tokio::sync::watch::Sender<bool>,
}

impl Execution {
    fn new(id: u64) -> Self {
        Self {
            id,
            phase: ExecutionPhase::Starting,
            consultation: false,
            input_ids: Vec::new(),
            human_request_id: None,
            unattended_unavailable: false,
            turn_id: None,
            cancel: tokio::sync::watch::channel(false).0,
            ready: tokio::sync::watch::channel(false).0,
            terminal: tokio::sync::watch::channel(false).0,
        }
    }
}

/// A transport may drop a request future while initialize/send is pending.
/// The execution still owns the cleanup, regardless of the caller's lifetime.
struct Handover {
    live: Arc<Live>,
    id: u64,
    complete: bool,
}

impl Drop for Handover {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        let live = self.live.clone();
        let id = self.id;
        self.live.cleanup.spawn(async move {
            if let Err(error) = retire_execution(
                &live,
                id,
                Some("handover was abandoned; delivery may be unknown".into()),
                false,
            )
            .await
            {
                tracing::error!(id, %error, "could not retire abandoned handover");
            }
        });
    }
}

/// One user request's lifecycle, possibly spanning several adapter turns.
///
/// `round_id` is minted by the daemon before the first adapter turn starts
/// and never changes across an auto-stitched interruption (approval,
/// guidance) or an explicitly continued one (`continuesRound`). Adapter turn
/// ids are upstream labels only — see §3.2's "今天的 turn 不等于 round".
///
/// Deliberately narrower than the proposal's full shape: `contended` and
/// `workspaceStart` need the workspace-observation step (§8 step 5) to mean
/// anything, and adding fields nobody populates yet would be exactly the
/// "看起来完整却是假的" mistake the proposal itself warns against (rule D).
/// Who is ending a round, and therefore whether the turn id has to match.
#[derive(Clone, Copy, Debug)]
enum Settling<'a> {
    /// A terminal event from the agent. It must name the turn still running.
    Turn(&'a str),
    /// The kernel ending the round from its own side — an escalation past a
    /// deaf agent, a channel that closed, an approval the user declined. There
    /// is no turn id to match against because no turn reported anything.
    Kernel,
}

#[derive(Debug, Clone)]
struct ActiveRound {
    round_id: String,
    /// Position in the session, and the round's directory name on disk.
    ord: u32,
    /// The user message that opened this round.
    user_item_id: Option<String>,
    /// One entry per adapter turn folded into this round, in the order they
    /// started. Never empty once the round exists.
    adapter_turn_ids: Vec<String>,
    /// Not read outside tests yet — becomes the round's `startedAt` once
    /// `RoundStats` (§8 step 6) exists to report it.
    #[allow(dead_code)]
    started_at_ms: i64,
    /// Set while paused for an approval/guidance answer; folded into
    /// `blocked_ms` and cleared the moment the round resumes or ends.
    blocked_since_ms: Option<i64>,
    /// Total time this round spent waiting on a human, across every pause —
    /// not counted as the agent's own working time.
    blocked_ms: i64,
    /// Every completed waiting interval, so trunk/batch durations can exclude
    /// the time the round spent waiting on a human instead of working.
    blocked_intervals: Vec<(i64, i64)>,
    /// `None` while the round is still open (running or blocked on a human).
    outcome: Option<RoundOutcome>,
    /// This round's still-open trunk — a bounded slice of its tool-call-
    /// and-thinking stream (`docs/agent-analysis-substrate-proposal.md`
    /// §3.2 direction three, §8 step 3). Exists because a round can run
    /// long enough that "every item carries an overview" alone re-blows the
    /// byte budget the round layer itself exists to avoid.
    current_trunk: TrunkBuilder,
    /// The LLM round delta attributed to each recorded item, so the open
    /// trunk's rebuild reports the same rounds the builder counted while
    /// streaming. Deltas are absolute: a rebuild needs no base counter.
    round_deltas: HashMap<String, u32>,
    /// The cumulative round counter as of the last recorded trunk item — the
    /// next item's delta is measured from here.
    last_attributed_rounds: u32,
    /// Trunks already closed, in order. Becomes `RoundRecord::trunk_summaries`
    /// once the round settles (`close_current_trunk` folds in whatever was
    /// still open, so nothing since the last boundary is lost).
    closed_trunks: Vec<TrunkSummary>,
}

/// One round resolved far enough to answer session-layer questions, without
/// having touched that round's storage. `trunks` is filled only for the round
/// a caller actually asked to expand.
#[derive(Debug, Clone)]
struct RoundView {
    /// Storage owner for a historical round inherited through a fork.
    source: Option<(String, String)>,
    round_id: String,
    ord: u32,
    user_item_id: Option<String>,
    started_at_ms: i64,
    ended_at_ms: i64,
    outcome: RoundLayerOutcome,
    trunk_count: u32,
}

struct SessionReadView {
    meta: SessionMeta,
    items: Vec<TimelineItem>,
    rounds: Vec<RoundSummary>,
    source: SessionReadSource,
    coverage: HistoryCoverage,
}

impl ActiveRound {
    /// Feeds one item into this round's trunk pagination, if the item is one
    /// of the three kinds trunks track (`TrunkItem`). A no-op for every
    /// other `TimelineItem` variant — user messages, permission requests,
    /// plans, turn summaries, … never affect trunk boundaries. Returns a
    /// just-closed trunk unresolved: its overview needs a live look at the
    /// item store, which only `Live` has (`resolve_monologue_text`).
    fn record_trunk_item(
        &mut self,
        item: &TimelineItem,
        cumulative_rounds: u32,
    ) -> Option<rounds::ClosedTrunk> {
        let trunk_item = match item {
            TimelineItem::AssistantMessage { .. } => TrunkItem::Monologue,
            TimelineItem::Reasoning { .. } => TrunkItem::Reasoning,
            TimelineItem::ToolCall { name, .. } => TrunkItem::ToolCall(name.as_str()),
            TimelineItem::Compaction { reason, .. } => TrunkItem::Compaction(reason.as_str()),
            _ => return None,
        };
        // The rounds this item answers for are the counter's movement since
        // the previous recorded item; adapters emit progress before the item
        // that opens a round, so that item carries the round.
        let delta = cumulative_rounds.saturating_sub(self.last_attributed_rounds);
        self.last_attributed_rounds = cumulative_rounds;
        self.round_deltas.insert(item.id().to_string(), delta);
        self.current_trunk
            .push(item.id(), trunk_item, rounds::item_timing(item), delta)
    }

    /// Closes whatever trunk is still being built, if any, so a round that
    /// settles mid-trunk still reports it. Idempotent: closing an
    /// already-empty builder returns `None`.
    fn close_current_trunk_pending(&mut self) -> Option<rounds::ClosedTrunk> {
        self.current_trunk.close()
    }
}

pub struct SessionManager {
    store: Store,
    registry: Arc<Registry>,
    diagnostics: Arc<Diagnostics>,
    sessions: RwLock<HashMap<String, Arc<Live>>>,
    /// First load of a session that is not in memory. Disk reads stay outside
    /// `sessions` so one cold session cannot block every other lookup.
    hydrating: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// What each session's agent has left running. Owned here because that is
    /// where the ownership is: a stray process belongs to the conversation
    /// whose agent started it, and there is no such thing as one without a
    /// session to answer for it (`crate::processes`).
    processes: Arc<crate::processes::Processes>,
    replay_window: usize,
    import_candidates: Mutex<HashMap<String, CachedImportCandidate>>,
    /// Daemon data-dir Skills root. Absent in unit tests that only need
    /// artifact-link guidance.
    skills_dir: Option<PathBuf>,
    /// Exact channel front door supplied by the launcher. This is a runtime
    /// binding, never inferred from a product or channel name.
    front_door_cli: Option<PathBuf>,
    /// Ephemeral daemon secret for session-bound controller proofs. Reopened
    /// Agent processes receive a fresh proof, so it never becomes project
    /// source or durable user data.
    controller_secret: String,
    /// Shared with the request router: it associates an Agent-native question
    /// with a daemon-authored mutation plan before the card reaches a Human.
    project_control: Option<crate::project_control::Broker>,
    workflow_data_root: Option<PathBuf>,
    /// Daemon shutdown has started. Worker results that arrive after this
    /// point belong to a stop, not to a still-open node.
    shutting_down: AtomicBool,
}

impl SessionManager {
    pub fn new(store: Store, registry: Arc<Registry>, replay_window: usize) -> Self {
        Self::new_with_diagnostics(store, registry, replay_window, Arc::new(Diagnostics::new()))
    }

    pub fn new_with_diagnostics(
        store: Store,
        registry: Arc<Registry>,
        replay_window: usize,
        diagnostics: Arc<Diagnostics>,
    ) -> Self {
        SessionManager {
            store,
            registry,
            diagnostics,
            sessions: RwLock::new(HashMap::new()),
            hydrating: Mutex::new(HashMap::new()),
            processes: crate::processes::Processes::new(),
            replay_window: replay_window.max(1),
            import_candidates: Mutex::new(HashMap::new()),
            skills_dir: None,
            front_door_cli: None,
            controller_secret: uuid::Uuid::new_v4().simple().to_string(),
            project_control: None,
            workflow_data_root: None,
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn with_builtin_skills(
        mut self,
        dir: impl Into<PathBuf>,
        front_door_cli: Option<PathBuf>,
    ) -> Self {
        self.skills_dir = Some(dir.into());
        self.front_door_cli = front_door_cli;
        self
    }

    pub fn with_project_control(mut self, broker: crate::project_control::Broker) -> Self {
        self.project_control = Some(broker);
        self
    }

    pub fn with_workflow_data_root(mut self, root: PathBuf) -> Self {
        self.workflow_data_root = Some(root);
        self
    }

    /// A handle for the parts of the daemon that answer questions about
    /// processes without going through a session.
    pub fn processes(&self) -> Arc<crate::processes::Processes> {
        self.processes.clone()
    }
}

#[derive(Debug)]
enum ClosedBoundary {
    Through(String),
    Unchanged(Option<String>),
    Empty,
}

/// One first start at a time, per kind of agent, for the whole process.
///
/// Scoped to the process rather than to a manager because what it protects is
/// not ours: the state a third-party CLI sets up on first run belongs to the
/// machine, not to whoever asked it to start. See `ensure_started`.
static STARTING: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long a session waits for another session's first start of the same kind.
///
/// Bounded, and inside the handover budget below: whoever is waiting here has
/// already told every client that a turn is running, and being told "another
/// one is still starting, try again" is a better answer than silence.
const START_GATE_BUDGET: Duration = Duration::from_secs(40);

/// How long the whole handover gets before the claim behind it is withdrawn.
///
/// Under the sixty seconds a client waits for any request, deliberately. A
/// handover that takes longer than the caller is prepared to wait is the freeze
/// itself: the client gives up and reports a timeout, the daemon carries on
/// holding a running status with no round behind it, and every prompt in
/// between is refused as a conflict with a turn that never began. Whatever goes
/// wrong in here, the answer and the withdrawal have to arrive while someone is
/// still listening.
const HANDOVER_BUDGET: Duration = Duration::from_secs(55);

struct Continuation {
    elevated: bool,
    prompt: String,
}

/// How long the agent has to accept a cancel before the ask is abandoned.
///
/// Generous, because a healthy agent answers this in microseconds and the only
/// thing a longer wait buys is a longer freeze.
const INTERRUPT_ASK: Duration = Duration::from_secs(3);

/// How long a cancelled turn has to end before the agent is stopped outright.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

enum BlobWrite {
    Put {
        item_id: String,
        value: serde_json::Value,
    },
    Flush(oneshot::Sender<()>),
}

/// Folds adapter events into session state, then republishes them.
///
/// Everything passes through `overview` first: the daemon's answer to "what
/// is the agent doing" is one sentence per tool call or thinking block, not
/// the payload that sentence summarizes. Shedding it here — the one place
/// every agent's events converge — lightens the wire, the replay buffer, the
/// snapshot and the on-disk log in a single move.
struct TrackedTurn {
    started_at_ms: i64,
    tools: HashSet<String>,
    agent_id: String,
    model_id: Option<String>,
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

#[derive(Debug, thiserror::Error)]
#[error("the session input queue is full; the message was not admitted and may be retried")]
pub(crate) struct InputQueueFull;
