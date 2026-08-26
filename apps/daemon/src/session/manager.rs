//! Session lifecycle: create, run, persist, replay.
//!
//! Everything here is agent-agnostic. The manager holds a `dyn AgentSession`
//! and never learns which adapter produced it. Sessions persist across
//! reloads, so a Live update swaps the binary under a running conversation.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    Attachment, BlobPayload, BlobRef, Catalog, ForkMethod, ForkTarget, ForkTransfer,
    HistoryCoverage, ImportContinuation, ItemDelta, PermissionOptionKind, PermissionOutcome,
    PermissionRequest, PermissionRequestKind, ProbeState, RetrievalCapability, RoundLayer,
    RoundLayerOutcome, RoundSummary, RoundTrunk, SequencedEvent, SessionArtifactBundle,
    SessionArtifactFile, SessionArtifactUpload, SessionContext, SessionEvent,
    SessionImportCandidate, SessionImportListing, SessionImportSource, SessionInspection,
    SessionLineage, SessionNarrativePage, SessionReadSource, SessionRoundPage, SessionSnapshot,
    SessionStatus, SessionSummary, TimelineItem, ToolStatus, TurnErrorCode, TurnOutcome, TurnStats,
    Usage,
};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};

use super::context_seed::{
    build_context_seed, build_portable_context_seed, prompt_with_seed, seed_token_budget,
};
use super::overview;
use super::rounds::{self, RoundOutcome, RoundRecord, TrunkBuilder, TrunkItem, TrunkSummary};
use super::store::{
    self, now_ms, title_from, ContextSeedState, ImportedSessionMeta, SessionMeta, Store,
    SESSION_FORMAT,
};
use crate::adapter::registry::Registry;
use crate::adapter::usage::{self as token_usage};
use crate::adapter::{AgentSession, PersistHandle, PromptInput, ProviderMap, SessionConfig};
use crate::diagnostics::Diagnostics;

const BROADCAST_CAPACITY: usize = 1024;
const IMPORT_CANDIDATE_TTL_MS: i64 = 10 * 60 * 1000;

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

/// One live session.
struct Live {
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
    /// Where each work item of the open trunk landed in the blob layer. Filled
    /// by the blob writer, consumed when the trunk is written, then dropped
    /// with the trunk's items.
    blob_refs: Mutex<HashMap<String, BlobRef>>,
    seq: AtomicU64,
    replay: Mutex<VecDeque<SequencedEvent>>,
    events: broadcast::Sender<SequencedEvent>,
    agent: Mutex<Option<Box<dyn AgentSession>>>,
    /// Deployment-aware context supplied by the authenticated UI. It is kept
    /// for an in-process Agent restart but not persisted: the next browser send
    /// recomposes domain/channel/workspace from its actual address.
    additional_system_prompt: Mutex<Option<String>>,
    pending_permissions: Mutex<Vec<PermissionRequest>>,
    /// Item ids settled during the current turn, flushed to disk when it ends.
    turn_items: Mutex<Vec<String>>,
    /// Work item ids belonging to the trunk currently open, in order. Cleared
    /// when that trunk is written out, so this stays bounded by a soft batch
    /// boundary during tool-heavy work
    /// however many adapter turns the round spans.
    open_trunk_items: Mutex<Vec<String>>,
    pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Daemon-owned round bookkeeping — one user request, possibly several
    /// adapter turns (`docs/agent-analysis-substrate-proposal.md` §3.2).
    /// `None` before the first `session.send` on this session. Kept around
    /// (not cleared) once a round settles, so the last one stays inspectable
    /// in memory until the next round replaces it; the durable copy lives in
    /// the round ledger (`session/rounds.rs`, §8 step 2).
    active_round: Mutex<Option<ActiveRound>>,
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
    /// `None` while the round is still open (running or blocked on a human).
    outcome: Option<RoundOutcome>,
    /// This round's still-open trunk — a bounded slice of its tool-call-
    /// and-thinking stream (`docs/agent-analysis-substrate-proposal.md`
    /// §3.2 direction three, §8 step 3). Exists because a round can run
    /// long enough that "every item carries an overview" alone re-blows the
    /// byte budget the round layer itself exists to avoid.
    current_trunk: TrunkBuilder,
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
    fn record_trunk_item(&mut self, item: &TimelineItem) -> Option<rounds::ClosedTrunk> {
        let trunk_item = match item {
            TimelineItem::AssistantMessage { .. } => TrunkItem::Monologue,
            TimelineItem::Reasoning { .. } => TrunkItem::Reasoning,
            TimelineItem::ToolCall { name, .. } => TrunkItem::ToolCall(name.as_str()),
            TimelineItem::Compaction { .. } => TrunkItem::Compaction,
            _ => return None,
        };
        self.current_trunk.push(item.id(), trunk_item)
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
            processes: crate::processes::Processes::new(),
            replay_window: replay_window.max(1),
            import_candidates: Mutex::new(HashMap::new()),
            skills_dir: None,
            front_door_cli: None,
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

    /// A handle for the parts of the daemon that answer questions about
    /// processes without going through a session.
    pub fn processes(&self) -> Arc<crate::processes::Processes> {
        self.processes.clone()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        agent_id: &str,
        model_id: Option<String>,
        mode_id: Option<String>,
        runtime_values: std::collections::BTreeMap<String, String>,
        title: Option<String>,
    ) -> Result<SessionSummary> {
        // Fail before creating anything if the agent is not real.
        self.registry.require(agent_id)?;

        let now = now_ms();
        let meta = SessionMeta {
            effort_id: None,
            runtime_values,
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: agent_id.to_string(),
            title,
            cwd,
            model_id,
            mode_id,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist: None,
            pending_permission: None,
            lineage: None,
            imported: None,
        };
        self.store.save_meta(&meta)?;
        let summary = meta.summary(SessionStatus::Idle);
        self.sessions.write().await.insert(
            meta.id.clone(),
            Arc::new(Live::new(meta, self.store.clone())),
        );
        Ok(summary)
    }

    pub async fn fork(
        &self,
        session_id: &str,
        turn_id: &str,
        target: Option<ForkTarget>,
        providers: &ProviderMap,
    ) -> Result<SessionSummary> {
        let source = self.live(session_id).await?;
        if matches!(
            *source.status.lock().await,
            SessionStatus::Running | SessionStatus::Waiting
        ) {
            anyhow::bail!("wait for the current turn to finish before forking");
        }
        let source_meta = source.meta.lock().await.clone();
        let source_adapter = self.registry.require(&source_meta.agent_id)?;
        let source_round_id = source
            .rounds
            .lock()
            .await
            .iter()
            .find(|round| round.adapter_turn_ids.iter().any(|id| id == turn_id))
            .map(|round| round.round_id.clone());

        let (items, checkpoint) = {
            let items = source.items.lock().await;
            let at = items
                .iter()
                .position(|item| {
                    matches!(
                        item,
                        TimelineItem::TurnSummary { stats, .. } if stats.turn_id == turn_id
                    )
                })
                .ok_or_else(|| anyhow!("no completed turn called {turn_id}"))?;
            let checkpoint = match &items[at] {
                TimelineItem::TurnSummary { stats, .. } => stats.fork_checkpoint.clone(),
                _ => unreachable!("the index was selected by the same variant"),
            };
            (items[..=at].to_vec(), checkpoint)
        };

        let explicit_target = target.is_some();
        let target = target.unwrap_or_else(|| ForkTarget {
            agent_id: source_meta.agent_id.clone(),
            workspace_id: None,
            model_id: source_meta.model_id.clone(),
            mode_id: source_meta.mode_id.clone(),
            effort_id: source_meta.effort_id.clone(),
        });
        let same_agent = target.agent_id == source_meta.agent_id;
        let native_candidate =
            same_agent && source_adapter.capabilities().fork && checkpoint.is_some();
        let native = if native_candidate {
            match self
                .store
                .claim_session(&source_meta.workspace_id, &source_meta.id)
            {
                Ok(()) => true,
                Err(error)
                    if error
                        .downcast_ref::<super::store::SessionWriteContended>()
                        .is_some() =>
                {
                    tracing::info!(
                        event = "fork_fallback_reconstructed",
                        workspace = %source_meta.workspace_id,
                        session = %source_meta.id,
                        turn = %turn_id,
                        "native fork was unavailable because another daemon owns the source session"
                    );
                    false
                }
                Err(error) => return Err(error),
            }
        } else {
            false
        };
        if !explicit_target && !source_adapter.capabilities().fork {
            anyhow::bail!(
                "the {} agent does not support forking",
                source_meta.agent_id
            );
        }
        if !explicit_target && checkpoint.is_none() {
            anyhow::bail!("that turn has no Agent fork checkpoint");
        }

        let target_adapter = self.registry.require(&target.agent_id)?;
        if !native {
            match target_adapter.probe().await {
                ProbeState::Ready => {}
                ProbeState::NotInstalled => {
                    anyhow::bail!("the {} agent is not installed", target.agent_id)
                }
                ProbeState::Unavailable { reason } => {
                    anyhow::bail!("the {} agent is unavailable: {reason}", target.agent_id)
                }
            }
        }

        let model_id = target
            .model_id
            .or_else(|| same_agent.then(|| source_meta.model_id.clone()).flatten());
        let mode_id = target
            .mode_id
            .or_else(|| same_agent.then(|| source_meta.mode_id.clone()).flatten());
        let effort_id = target
            .effort_id
            .or_else(|| same_agent.then(|| source_meta.effort_id.clone()).flatten());

        let (persist, method, context_seed, context) = if native {
            self.ensure_started(&source, providers).await?;
            let checkpoint = checkpoint.expect("native was selected only with a checkpoint");
            let persist = source
                .agent
                .lock()
                .await
                .as_ref()
                .ok_or_else(|| anyhow!("the source session has no running agent"))?
                .fork(&checkpoint)
                .await?;
            (Some(persist), ForkMethod::NativeCheckpoint, None, None)
        } else {
            let catalog = target_adapter.catalog(providers).await;
            let context_window = model_id
                .as_deref()
                .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                .or_else(|| {
                    catalog
                        .default_model
                        .as_deref()
                        .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                })
                .and_then(|model| model.context_window);
            let built = build_context_seed(
                session_id,
                turn_id,
                source_round_id.as_deref(),
                &source_meta.agent_id,
                &items,
                seed_token_budget(context_window),
                coverage_for_meta(&source_meta, items.len()),
            );
            (
                None,
                ForkMethod::ReconstructedContext,
                Some(built.seed),
                Some(built.stats),
            )
        };

        let now = now_ms();
        let title = source_meta
            .title
            .as_deref()
            .and_then(|title| title_from(&format!("{title} · 分支")));
        let meta = SessionMeta {
            runtime_values: Default::default(),
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: target.workspace_id.unwrap_or(source_meta.workspace_id),
            format: SESSION_FORMAT,
            agent_id: target.agent_id,
            title,
            cwd: source_meta.cwd,
            model_id,
            mode_id,
            effort_id,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist,
            pending_permission: None,
            lineage: Some(SessionLineage {
                source_session_id: session_id.to_string(),
                source_turn_id: turn_id.to_string(),
                source_agent_id: source_meta.agent_id,
                method,
                context,
            }),
            imported: None,
        };
        let write = || -> Result<()> {
            self.store.save_meta(&meta)?;
            // The fork inherits the conversation, not the source's round
            // layer: its rounds happened in another session and stay
            // addressable through lineage.
            self.store
                .append_chat_items(&meta.workspace_id, &meta.id, &items)?;
            if let Some(seed) = &context_seed {
                self.store.save_seed(&meta.workspace_id, &meta.id, seed)?;
            }
            Ok(())
        };
        if let Err(error) = write() {
            let _ = self.store.delete(&meta.workspace_id, &meta.id);
            return Err(error);
        }
        let summary = meta.summary(SessionStatus::Idle);
        let forked = Arc::new(Live::new(meta, self.store.clone()));
        *forked.items.lock().await = items;
        self.sessions
            .write()
            .await
            .insert(summary.id.clone(), forked);
        Ok(summary)
    }

    pub async fn fork_export(&self, session_id: &str, turn_id: &str) -> Result<ForkTransfer> {
        let source = self.live(session_id).await?;
        if matches!(
            *source.status.lock().await,
            SessionStatus::Running | SessionStatus::Waiting
        ) {
            anyhow::bail!("wait for the current turn to finish before forking");
        }
        let meta = source.meta.lock().await.clone();
        let source_round_id = source
            .rounds
            .lock()
            .await
            .iter()
            .find(|round| round.adapter_turn_ids.iter().any(|id| id == turn_id))
            .map(|round| round.round_id.clone());
        let items = source.items.lock().await;
        let at = items
            .iter()
            .position(|item| {
                matches!(item,
            TimelineItem::TurnSummary { stats, .. } if stats.turn_id == turn_id)
            })
            .ok_or_else(|| anyhow!("no completed turn called {turn_id}"))?;
        let through_boundary = at.saturating_add(1);
        let portable = items[..=at]
            .iter()
            .cloned()
            .map(portable_fork_item)
            .collect();
        let (selected, omitted, altered) = bound_imported_items(portable);
        let mut coverage = coverage_for_meta(&meta, through_boundary);
        let prior_omitted = coverage.omitted_item_count;
        coverage.retained_item_count =
            u64::try_from(through_boundary.saturating_sub(omitted)).unwrap_or(u64::MAX);
        coverage.omitted_item_count =
            prior_omitted.saturating_add(u64::try_from(omitted).unwrap_or(u64::MAX));
        coverage.source_item_count = Some(
            coverage
                .retained_item_count
                .saturating_add(coverage.omitted_item_count),
        );
        if omitted > 0 || altered > 0 {
            coverage.reason =
                Some("the portable fork retained a bounded recent visible-history window".into());
        }
        Ok(ForkTransfer {
            source_session_id: session_id.to_string(),
            source_turn_id: turn_id.to_string(),
            source_agent_id: meta.agent_id.clone(),
            source_round_id,
            title: meta.title.clone(),
            coverage,
            items: selected,
        })
    }

    pub async fn fork_import(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        transfer: ForkTransfer,
        target: ForkTarget,
        providers: &ProviderMap,
        source_accessible: bool,
    ) -> Result<SessionSummary> {
        if target.workspace_id.as_deref() != Some(workspace_id) {
            anyhow::bail!("the fork target workspace does not match the validated workspace");
        }
        if !matches!(
            transfer.items.last(),
            Some(TimelineItem::TurnSummary { stats, .. })
                if stats.turn_id == transfer.source_turn_id
        ) {
            anyhow::bail!("the portable fork does not end at its declared completed turn");
        }
        let raw_count = transfer.items.len();
        let portable = transfer.items.into_iter().map(portable_fork_item).collect();
        let (items, omitted, altered) = bound_imported_items(portable);
        let mut coverage = transfer.coverage;
        if omitted > 0 || altered > 0 {
            coverage.retained_item_count = coverage
                .retained_item_count
                .min(u64::try_from(raw_count.saturating_sub(omitted)).unwrap_or(u64::MAX));
            coverage.omitted_item_count = coverage
                .omitted_item_count
                .saturating_add(u64::try_from(omitted).unwrap_or(u64::MAX));
            coverage.source_item_count = Some(
                coverage.source_item_count.unwrap_or(0).max(
                    coverage
                        .retained_item_count
                        .saturating_add(coverage.omitted_item_count),
                ),
            );
            coverage.reason =
                Some("the destination bounded the portable fork before reconstruction".into());
        }
        if !source_accessible {
            coverage.retrieval = RetrievalCapability::Unavailable;
            if coverage.reason.is_none() {
                coverage.reason =
                    Some("the source session remains on another machine after this fork".into());
            }
        }
        let adapter = self.registry.require(&target.agent_id)?;
        match adapter.probe().await {
            ProbeState::Ready => {}
            ProbeState::NotInstalled => {
                anyhow::bail!("the {} agent is not installed", target.agent_id)
            }
            ProbeState::Unavailable { reason } => {
                anyhow::bail!("the {} agent is unavailable: {reason}", target.agent_id)
            }
        }
        let catalog = adapter.catalog(providers).await;
        let model_id = target.model_id.or_else(|| catalog.default_model.clone());
        let context_window = model_id
            .as_deref()
            .and_then(|id| catalog.models.iter().find(|model| model.id == id))
            .and_then(|model| model.context_window);
        let built = if source_accessible {
            build_context_seed(
                &transfer.source_session_id,
                &transfer.source_turn_id,
                transfer.source_round_id.as_deref(),
                &transfer.source_agent_id,
                &items,
                seed_token_budget(context_window),
                coverage,
            )
        } else {
            build_portable_context_seed(
                &transfer.source_session_id,
                &transfer.source_turn_id,
                transfer.source_round_id.as_deref(),
                &transfer.source_agent_id,
                &items,
                seed_token_budget(context_window),
                coverage,
            )
        };
        let now = now_ms();
        let meta = SessionMeta {
            runtime_values: Default::default(),
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: target.agent_id,
            title: transfer
                .title
                .as_deref()
                .and_then(|title| title_from(&format!("{title} · 分支"))),
            cwd,
            model_id,
            mode_id: target.mode_id,
            effort_id: target.effort_id,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist: None,
            pending_permission: None,
            lineage: Some(SessionLineage {
                source_session_id: transfer.source_session_id,
                source_turn_id: transfer.source_turn_id,
                source_agent_id: transfer.source_agent_id,
                method: ForkMethod::ReconstructedContext,
                context: Some(built.stats),
            }),
            imported: None,
        };
        let write = || -> Result<()> {
            self.store.save_meta(&meta)?;
            self.store
                .append_chat_items(workspace_id, &meta.id, &items)?;
            self.store.save_seed(workspace_id, &meta.id, &built.seed)?;
            Ok(())
        };
        if let Err(error) = write() {
            let _ = self.store.delete(workspace_id, &meta.id);
            return Err(error);
        }
        let summary = meta.summary(SessionStatus::Idle);
        let live = Arc::new(Live::new(meta, self.store.clone()));
        *live.items.lock().await = items;
        self.sessions.write().await.insert(summary.id.clone(), live);
        Ok(summary)
    }

    /// Lightweight discovery pass. Every provider is asked in parallel and
    /// returns only descriptors; the full selected transcript is read later.
    pub async fn list_imports(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        limit: Option<u32>,
    ) -> Result<SessionImportListing> {
        let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
        let now = now_ms();
        let expires_at_ms = now.saturating_add(IMPORT_CANDIDATE_TTL_MS);
        let duplicate_keys: HashSet<String> = self
            .store
            .list_meta()?
            .into_iter()
            .filter(|meta| meta.workspace_id == workspace_id)
            .filter_map(|meta| meta.imported.map(|imported| imported.source_key))
            .collect();
        let discovered = self.registry.import_candidates(&cwd, limit).await;
        let mut filtered_duplicates = 0_u32;
        let mut cached = self.import_candidates.lock().await;
        cached.retain(|_, candidate| {
            candidate.expires_at_ms > now && candidate.workspace_id != workspace_id
        });
        let mut sources = Vec::new();
        for (agent_id, label, result) in discovered {
            match result {
                Ok(Some(candidates)) => {
                    let mut public = Vec::new();
                    for candidate in candidates {
                        let source_key = import_source_key(&agent_id, &cwd, &candidate.source_id);
                        if duplicate_keys.contains(&source_key) {
                            filtered_duplicates = filtered_duplicates.saturating_add(1);
                            continue;
                        }
                        let candidate_id = format!("ic_{}", uuid::Uuid::new_v4().simple());
                        cached.insert(
                            candidate_id.clone(),
                            CachedImportCandidate {
                                workspace_id: workspace_id.to_string(),
                                cwd: cwd.clone(),
                                agent_id: agent_id.clone(),
                                source_id: candidate.source_id,
                                source_key,
                                title: candidate.title.clone(),
                                expires_at_ms,
                            },
                        );
                        public.push(SessionImportCandidate {
                            candidate_id,
                            agent_id: agent_id.clone(),
                            title: candidate.title,
                            preview: candidate.preview,
                            updated_at_ms: candidate.updated_at_ms,
                            continuation: candidate.continuation,
                        });
                    }
                    sources.push(SessionImportSource {
                        agent_id,
                        label,
                        supported: true,
                        candidates: public,
                        error: None,
                    });
                }
                Ok(None) => sources.push(SessionImportSource {
                    agent_id,
                    label,
                    supported: false,
                    candidates: Vec::new(),
                    error: None,
                }),
                Err(error) => {
                    tracing::warn!(agent = %agent_id, %error, "session import discovery failed");
                    sources.push(SessionImportSource {
                        agent_id,
                        label,
                        supported: true,
                        candidates: Vec::new(),
                        // Provider paths and native handles stay out of RPC
                        // errors; the daemon log retains the detailed cause.
                        error: Some("读取失败，请查看日志".into()),
                    });
                }
            }
        }
        Ok(SessionImportListing {
            sources,
            expires_at_ms,
            filtered_duplicates,
        })
    }

    /// Full-history pass for exactly one expiring candidate. The candidate is
    /// consumed before provider I/O, so a retry always starts with a fresh
    /// discovery result rather than accidentally importing twice.
    pub async fn import(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        candidate_id: &str,
    ) -> Result<SessionSummary> {
        let candidate = self
            .import_candidates
            .lock()
            .await
            .remove(candidate_id)
            .ok_or_else(|| anyhow!("that import candidate expired; refresh the list"))?;
        if candidate.expires_at_ms <= now_ms()
            || candidate.workspace_id != workspace_id
            || candidate.cwd != cwd
        {
            anyhow::bail!("that import candidate expired; refresh the list");
        }
        if self.store.list_meta()?.into_iter().any(|meta| {
            meta.workspace_id == workspace_id
                && meta
                    .imported
                    .as_ref()
                    .is_some_and(|imported| imported.source_key == candidate.source_key)
        }) {
            anyhow::bail!("that Agent session has already been imported");
        }
        let mut history = self
            .registry
            .import_history(&candidate.agent_id, &cwd, &candidate.source_id)
            .await?;
        let source_item_count = history.items.len();
        let (bounded_items, omitted_items, altered_items) = bound_imported_items(history.items);
        history.items = bounded_items;
        let unavailable_items = omitted_items.saturating_add(altered_items);
        if unavailable_items > 0 {
            history.warnings.push(format!(
                "历史过长：GeneHub 完整保留 {} 项，省略或裁剪 {unavailable_items} 项；原 Agent 会话可能仍保留完整上下文",
                source_item_count.saturating_sub(unavailable_items)
            ));
        }
        let mut continuation = history.continuation;
        if continuation == ImportContinuation::Native && history.persist.is_none() {
            continuation = ImportContinuation::ReadOnly;
            history
                .warnings
                .push("Agent 没有返回可恢复句柄，已按只读历史导入".into());
        }
        let now = now_ms();
        let created_at_ms = if history.created_at_ms > 0 {
            history.created_at_ms
        } else {
            now
        };
        let updated_at_ms = if history.updated_at_ms > 0 {
            history.updated_at_ms
        } else {
            now
        };
        let meta = SessionMeta {
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: candidate.agent_id.clone(),
            title: history.title.or(Some(candidate.title)),
            cwd,
            model_id: None,
            mode_id: None,
            effort_id: None,
            runtime_values: Default::default(),
            created_at_ms,
            updated_at_ms,
            archived: false,
            persist: history.persist,
            pending_permission: None,
            lineage: None,
            imported: Some(ImportedSessionMeta {
                source_key: candidate.source_key,
                agent_id: candidate.agent_id,
                continuation,
                warnings: history.warnings,
                coverage: Some(HistoryCoverage {
                    source_item_count: Some(u64::try_from(source_item_count).unwrap_or(u64::MAX)),
                    retained_item_count: u64::try_from(
                        source_item_count.saturating_sub(unavailable_items),
                    )
                    .unwrap_or(u64::MAX),
                    omitted_item_count: u64::try_from(unavailable_items).unwrap_or(u64::MAX),
                    retrieval: if unavailable_items == 0 {
                        RetrievalCapability::Genehub
                    } else if continuation == ImportContinuation::Native {
                        RetrievalCapability::NativeOnly
                    } else {
                        RetrievalCapability::Unavailable
                    },
                    reason: (unavailable_items > 0).then(|| {
                        "the import retained a recent bounded window and clipped oversized records to finish promptly".into()
                    }),
                }),
            }),
        };
        let write = || -> Result<()> {
            self.store.save_meta(&meta)?;
            self.store
                .append_chat_items(workspace_id, &meta.id, &history.items)?;
            Ok(())
        };
        if let Err(error) = write() {
            let _ = self.store.delete(workspace_id, &meta.id);
            return Err(error);
        }
        let summary = meta.summary(SessionStatus::Idle);
        let imported = Arc::new(Live::new(meta, self.store.clone()));
        *imported.items.lock().await = history.items;
        self.sessions
            .write()
            .await
            .insert(summary.id.clone(), imported);
        Ok(summary)
    }

    async fn live(&self, session_id: &str) -> Result<Arc<Live>> {
        if let Some(live) = self.sessions.read().await.get(session_id).cloned() {
            return Ok(live);
        }
        // Not in memory: rehydrate from disk so a restart does not lose access
        // to past conversations.
        let meta = self
            .store
            .list_meta()?
            .into_iter()
            .find(|meta| meta.id == session_id)
            .ok_or_else(|| SessionMissing(session_id.to_string()))?;
        // Reading a layout this build predates would not give a partial view,
        // it would give a wrong one, and any reply written back would corrupt
        // the session for the build that can read it.
        if !meta.openable() {
            return Err(anyhow!(
                "session {session_id} was written in format {} by a newer version of GeneHub; \
                 this one reads up to format {SESSION_FORMAT}",
                meta.format
            ));
        }
        let chat = self.store.load_chat(&meta.workspace_id, &meta.id)?;
        let live = Arc::new(Live::new(meta, self.store.clone()));
        *live.items.lock().await = chat.items;
        *live.rounds.lock().await = chat.rounds;
        self.sessions
            .write()
            .await
            .insert(session_id.to_string(), live.clone());
        Ok(live)
    }

    pub async fn summary(&self, session_id: &str) -> Result<SessionSummary> {
        let live = self.live(session_id).await?;
        let status = *live.status.lock().await;
        let summary = live.meta.lock().await.summary(status);
        Ok(summary)
    }

    pub async fn begin_artifact(
        &self,
        session_id: &str,
        files: Vec<SessionArtifactFile>,
        metadata: serde_json::Value,
    ) -> Result<SessionArtifactUpload> {
        let live = self.live(session_id).await?;
        let workspace_id = live.meta.lock().await.workspace_id.clone();
        self.store
            .begin_artifact(&workspace_id, session_id, files, metadata)
    }

    pub async fn write_artifact_chunk(
        &self,
        session_id: &str,
        upload_id: &str,
        file_index: u32,
        offset: u64,
        data_base64: &str,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let workspace_id = live.meta.lock().await.workspace_id.clone();
        self.store.write_artifact_chunk(
            &workspace_id,
            session_id,
            upload_id,
            file_index,
            offset,
            data_base64,
        )
    }

    pub async fn finish_artifact(
        &self,
        session_id: &str,
        upload_id: &str,
    ) -> Result<SessionArtifactBundle> {
        let live = self.live(session_id).await?;
        let workspace_id = live.meta.lock().await.workspace_id.clone();
        self.store
            .finish_artifact(&workspace_id, session_id, upload_id)
    }

    pub async fn abort_artifact(&self, session_id: &str, upload_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        let workspace_id = live.meta.lock().await.workspace_id.clone();
        self.store
            .abort_artifact(&workspace_id, session_id, upload_id)
    }

    pub async fn list(
        &self,
        workspace_id: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<SessionSummary>> {
        let mut out = Vec::new();
        for meta in self.store.list_meta()? {
            if let Some(workspace) = workspace_id {
                if meta.workspace_id != workspace {
                    continue;
                }
            }
            if meta.archived && !include_archived {
                continue;
            }
            // A suspended approval survives daemon restarts without a live
            // Agent process or client connection.
            let status = match self.sessions.read().await.get(&meta.id) {
                Some(live) => *live.status.lock().await,
                None if meta.pending_permission.is_some() => SessionStatus::Waiting,
                None => SessionStatus::Idle,
            };
            out.push(meta.summary(status));
        }
        Ok(out)
    }

    pub async fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot> {
        let live = self.live(session_id).await?;
        live.snapshot().await
    }

    /// A bounded-reader view frozen at an optional round boundary. This is the
    /// single source for the CLI pages below, so inspect/narrative/rounds agree
    /// on both the digest and what "through round" means.
    async fn read_view(
        &self,
        session_id: &str,
        through_round_id: Option<&str>,
    ) -> Result<SessionReadView> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await.clone();
        let views = self.round_views(&live).await;
        let boundary = match through_round_id {
            Some(round_id) => Some(
                views
                    .iter()
                    .position(|view| view.round_id == round_id)
                    .ok_or_else(|| anyhow!("no such round: {round_id}"))?,
            ),
            None => views.len().checked_sub(1),
        };
        let selected_views = boundary.map(|index| &views[..=index]).unwrap_or(&[]);
        let rounds: Vec<RoundSummary> = selected_views.iter().map(round_summary).collect();

        let all_items = live.items.lock().await.clone();
        // The next round's user item is a stronger boundary than an adapter
        // turn id: imported and stitched rounds can contain a different number
        // of adapter turns, while every round begins with at most one stable
        // user narrative item.
        let end = boundary
            .and_then(|index| views.get(index + 1))
            .and_then(|next| next.user_item_id.as_deref())
            .and_then(|next_user| all_items.iter().position(|item| item.id() == next_user))
            .unwrap_or(all_items.len());
        let items: Vec<TimelineItem> = all_items[..end]
            .iter()
            .filter(|item| !store::is_work_item(item))
            .cloned()
            .collect();

        let encoded = serde_json::to_vec(&(items.as_slice(), rounds.as_slice()))?;
        let digest = format!("sha256:{:x}", Sha256::digest(&encoded));
        let through_round_id = boundary.map(|index| views[index].round_id.clone());
        let coverage = meta
            .imported
            .as_ref()
            .and_then(|imported| imported.coverage.clone())
            .unwrap_or_else(|| HistoryCoverage {
                source_item_count: Some(u64::try_from(items.len()).unwrap_or(u64::MAX)),
                retained_item_count: u64::try_from(items.len()).unwrap_or(u64::MAX),
                omitted_item_count: 0,
                retrieval: RetrievalCapability::Genehub,
                reason: None,
            });
        Ok(SessionReadView {
            meta,
            items,
            rounds,
            source: SessionReadSource {
                session_id: session_id.to_string(),
                through_round_id,
                digest,
                untrusted: true,
            },
            coverage,
        })
    }

    pub async fn inspect(
        &self,
        session_id: &str,
        through_round_id: Option<&str>,
    ) -> Result<SessionInspection> {
        let view = self.read_view(session_id, through_round_id).await?;
        let status = *self.live(session_id).await?.status.lock().await;
        Ok(SessionInspection {
            summary: view.meta.summary(status),
            source: view.source,
            narrative_item_count: u64::try_from(view.items.len()).unwrap_or(u64::MAX),
            round_count: u64::try_from(view.rounds.len()).unwrap_or(u64::MAX),
            latest_round_id: view.rounds.last().map(|round| round.round_id.clone()),
            coverage: view.coverage,
            layers: vec![
                "narrative".into(),
                "rounds".into(),
                "trunks".into(),
                "blobs".into(),
                "context".into(),
            ],
        })
    }

    pub async fn narrative_page(
        &self,
        session_id: &str,
        through_round_id: Option<&str>,
        item_id: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<SessionNarrativePage> {
        let view = self.read_view(session_id, through_round_id).await?;
        if let Some(item_id) = item_id {
            if cursor.is_some() {
                anyhow::bail!("itemId and cursor are mutually exclusive");
            }
            let item = view
                .items
                .iter()
                .find(|item| item.id() == item_id)
                .cloned()
                .ok_or_else(|| anyhow!("no such narrative item: {item_id}"))?;
            return Ok(SessionNarrativePage {
                source: view.source,
                items: vec![item],
                next_cursor: None,
            });
        }
        let end = parse_trunk_cursor(cursor, view.items.len())?;
        let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
        let start = end.saturating_sub(limit);
        Ok(SessionNarrativePage {
            source: view.source,
            items: view.items[start..end].to_vec(),
            next_cursor: (start > 0).then(|| format!("before:{start}")),
        })
    }

    pub async fn round_page(
        &self,
        session_id: &str,
        through_round_id: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<SessionRoundPage> {
        let view = self.read_view(session_id, through_round_id).await?;
        let end = parse_trunk_cursor(cursor, view.rounds.len())?;
        let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
        let start = end.saturating_sub(limit);
        Ok(SessionRoundPage {
            source: view.source,
            rounds: view.rounds[start..end].to_vec(),
            next_cursor: (start > 0).then(|| format!("before:{start}")),
        })
    }

    pub async fn session_context(
        &self,
        session_id: &str,
        through_round_id: Option<&str>,
        token_budget: Option<u64>,
    ) -> Result<SessionContext> {
        let view = self.read_view(session_id, through_round_id).await?;
        let boundary = view
            .source
            .through_round_id
            .as_deref()
            .unwrap_or("latest")
            .to_string();
        let built = build_context_seed(
            session_id,
            &boundary,
            view.source.through_round_id.as_deref(),
            &view.meta.agent_id,
            &view.items,
            token_budget
                .unwrap_or(super::context_seed::DEFAULT_SEED_TOKEN_BUDGET)
                .clamp(2_048, 64_000),
            view.coverage,
        );
        Ok(built.context)
    }

    async fn snapshot_for_open(
        &self,
        session_id: &str,
        expand_last_round: bool,
    ) -> Result<SessionSnapshot> {
        let live = self.live(session_id).await?;
        let mut snapshot = live.snapshot().await?;
        // The open trunk's work items live alongside the narrative in memory
        // so the round layer can serve them without a read; they are addressed
        // through that layer, never replayed here.
        snapshot.items.retain(|item| !store::is_work_item(item));
        let views = self.round_views(&live).await;
        snapshot.rounds = Some(views.iter().map(round_summary).collect());
        if expand_last_round {
            if let Some(last) = views.last() {
                snapshot.expanded_round = Some(Box::new(
                    self.build_round_layer(&live, last, None, 20, true).await?,
                ));
            }
        }
        Ok(snapshot)
    }

    /// Every round of the session, folded, straight from what `chat.jsonl`
    /// already put in memory. Touches no round directory: a session with four
    /// rounds and a session with four hundred cost the same here.
    async fn round_views(&self, live: &Arc<Live>) -> Vec<RoundView> {
        let active = live.active_round.lock().await.clone();
        let open = active
            .as_ref()
            .filter(|round| round.outcome.is_none())
            .map(|round| round.round_id.clone());
        let mut views: Vec<RoundView> = live
            .rounds
            .lock()
            .await
            .iter()
            .map(|record| RoundView {
                round_id: record.round_id.clone(),
                ord: record.ord,
                user_item_id: record.user_item_id.clone(),
                started_at_ms: record.started_at_ms,
                ended_at_ms: record.ended_at_ms,
                outcome: match record.outcome {
                    Some(RoundOutcome::Completed) => RoundLayerOutcome::Completed,
                    Some(RoundOutcome::Canceled) => RoundLayerOutcome::Canceled,
                    Some(RoundOutcome::Superseded) => RoundLayerOutcome::Superseded,
                    Some(RoundOutcome::Failed) => RoundLayerOutcome::Failed,
                    // Open on disk, and nobody is running it: the daemon went
                    // away mid-request. Saying "running" would promise output
                    // that is never coming.
                    None if open.as_deref() == Some(record.round_id.as_str()) => {
                        RoundLayerOutcome::Running
                    }
                    None => RoundLayerOutcome::Failed,
                },
                trunk_count: record.trunk_count,
            })
            .collect();
        if let Some(round) = active.filter(|round| round.outcome.is_none()) {
            let open_trunks = round.closed_trunks.len() as u32
                + u32::from(!live.open_trunk_items.lock().await.is_empty());
            match views
                .iter_mut()
                .find(|view| view.round_id == round.round_id)
            {
                Some(view) => {
                    view.outcome = RoundLayerOutcome::Running;
                    view.trunk_count = open_trunks;
                }
                None => views.push(RoundView {
                    round_id: round.round_id.clone(),
                    ord: round.ord,
                    user_item_id: round.user_item_id.clone(),
                    started_at_ms: round.started_at_ms,
                    ended_at_ms: 0,
                    outcome: RoundLayerOutcome::Running,
                    trunk_count: open_trunks,
                }),
            }
        }
        views.sort_by_key(|view| view.ord);
        views
    }

    /// The trunk index for one round: closed trunks from its own index file,
    /// plus the trunk still being built, which only memory knows about.
    async fn trunk_index(&self, live: &Arc<Live>, view: &RoundView) -> Result<Vec<TrunkSummary>> {
        let meta = live.meta.lock().await.clone();
        let mut summaries = self
            .store
            .load_trunk_index(&meta.workspace_id, &meta.id, view.ord)?;
        if let Some(open) = self.open_trunk(live, view).await {
            match summaries
                .iter_mut()
                .find(|summary| summary.index == open.summary.index)
            {
                Some(existing) => *existing = open.summary,
                None => summaries.push(open.summary),
            }
        }
        Ok(summaries)
    }

    /// The trunk currently being built for this round, if this round is the
    /// open one and it has anything in it yet.
    async fn open_trunk(&self, live: &Arc<Live>, view: &RoundView) -> Option<RoundTrunk> {
        let index = {
            let active = live.active_round.lock().await;
            let round = active.as_ref()?;
            if round.outcome.is_some() || round.round_id != view.round_id {
                return None;
            }
            round.closed_trunks.len() as u32
        };
        live.build_open_trunk(index).await
    }

    async fn build_round_layer(
        &self,
        live: &Arc<Live>,
        view: &RoundView,
        cursor: Option<&str>,
        limit: u32,
        expand_last_trunk: bool,
    ) -> Result<RoundLayer> {
        let index = self.trunk_index(live, view).await?;
        let end = parse_trunk_cursor(cursor, index.len())?;
        let limit = limit.clamp(1, 100) as usize;
        let start = end.saturating_sub(limit);
        let trunks = index[start..end].to_vec();
        let expanded_trunk = match expand_last_trunk.then(|| trunks.last()).flatten() {
            Some(summary) => Some(self.build_round_trunk(live, view, summary).await?),
            None => None,
        };
        let mut round = round_summary(view);
        round.trunk_count = index.len() as u32;
        Ok(RoundLayer {
            round,
            trunks,
            next_cursor: (start > 0).then(|| format!("before:{start}")),
            expanded_trunk,
        })
    }

    /// One trunk's contents: a single small file, or memory when it is the
    /// trunk still being written.
    async fn build_round_trunk(
        &self,
        live: &Arc<Live>,
        view: &RoundView,
        summary: &TrunkSummary,
    ) -> Result<RoundTrunk> {
        if let Some(open) = self.open_trunk(live, view).await {
            if open.summary.index == summary.index {
                return Ok(open);
            }
        }
        let meta = live.meta.lock().await.clone();
        self.store
            .load_trunk(&meta.workspace_id, &meta.id, view.ord, summary)
    }

    pub async fn round_layer(
        &self,
        session_id: &str,
        round_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<RoundLayer> {
        let live = self.live(session_id).await?;
        let views = self.round_views(&live).await;
        let view = if round_id == "latest" {
            views.last()
        } else {
            views.iter().find(|view| view.round_id == round_id)
        }
        .ok_or_else(|| anyhow!("no such round: {round_id}"))?;
        self.build_round_layer(&live, view, cursor, limit.unwrap_or(20), false)
            .await
    }

    pub async fn round_trunk(
        &self,
        session_id: &str,
        round_id: &str,
        trunk_index: u32,
    ) -> Result<RoundTrunk> {
        let live = self.live(session_id).await?;
        let views = self.round_views(&live).await;
        let view = views
            .iter()
            .find(|view| view.round_id == round_id)
            .ok_or_else(|| anyhow!("no such round: {round_id}"))?;
        let summary = self
            .trunk_index(&live, view)
            .await?
            .into_iter()
            .find(|summary| summary.index == trunk_index)
            .ok_or_else(|| anyhow!("no such trunk: {trunk_index}"))?;
        self.build_round_trunk(&live, view, &summary).await
    }

    pub async fn blob(&self, session_id: &str, blob: &BlobRef) -> Result<BlobPayload> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await;
        self.store
            .get_blob(&meta.workspace_id, &meta.id, blob)?
            .ok_or_else(|| anyhow!("no such blob: {}", blob.id))
    }

    /// Snapshot plus whatever the client missed, in one answer.
    ///
    /// `reset` tells the client the difference between "here is the gap" and
    /// "start over" — silently returning a partial history would leave holes
    /// nobody notices until a user asks where their message went.
    pub async fn subscribe(
        &self,
        session_id: &str,
        since_seq: Option<u64>,
        expand_last_round: bool,
    ) -> Result<(
        SessionSnapshot,
        Vec<SequencedEvent>,
        bool,
        broadcast::Receiver<SequencedEvent>,
    )> {
        let live = self.live(session_id).await?;
        // Subscribe before snapshotting so nothing can slip through the gap
        // between the two.
        let receiver = live.events.subscribe();
        let replay = live.replay.lock().await;

        let (events, reset) = match since_seq {
            Some(0) => {
                // The snapshot already carries the session narrative and the
                // last round's tail. Replaying the historical tool and
                // reasoning stream here would defeat its byte budget.
                (Vec::new(), true)
            }
            None => (Vec::new(), true),
            Some(seq) => {
                let oldest = replay.front().map(|event| event.seq);
                let current = live.seq.load(Ordering::SeqCst);
                if seq == current {
                    (Vec::new(), false)
                } else if oldest.is_none_or(|oldest| seq + 1 < oldest) {
                    // The gap starts before anything we still hold.
                    (Vec::new(), true)
                } else {
                    (
                        replay
                            .iter()
                            .filter(|event| event.seq > seq)
                            .cloned()
                            .collect(),
                        false,
                    )
                }
            }
        };
        drop(replay);

        let snapshot = self
            .snapshot_for_open(session_id, expand_last_round)
            .await?;
        Ok((snapshot, events, reset, receiver))
    }

    /// Hands a prompt to the agent, one turn at a time.
    ///
    /// The single-turn rule is enforced here rather than in the UI that hides the
    /// send button, because two windows on the same session are two UIs, and an
    /// agent that receives a second prompt mid-turn does not fail cleanly — it
    /// interleaves two conversations into one.
    pub async fn send(
        &self,
        session_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        providers: &ProviderMap,
        artifact_preview_base_url: Option<String>,
        continues_round: Option<String>,
    ) -> Result<String> {
        let live = self.live(session_id).await?;
        if live
            .meta
            .lock()
            .await
            .imported
            .as_ref()
            .is_some_and(|imported| imported.continuation == ImportContinuation::ReadOnly)
        {
            anyhow::bail!(
                "this imported conversation is read-only because its Agent cannot resume it"
            );
        }
        // Preview locators are rebound in the workbench Markdown renderer from
        // relative/absolute workspace paths. A deployment-specific URL prefix
        // must not be injected into Agent system prompts — only path-linking
        // rules (HTML entry file, supported kinds, no directory links).
        let _ = artifact_preview_base_url;
        let additional_system_prompt = Some(crate::skills::session_guidance(
            self.skills_dir.as_deref(),
            self.front_door_cli.as_deref(),
        ));
        {
            let mut status = live.status.lock().await;
            if matches!(*status, SessionStatus::Running | SessionStatus::Waiting) {
                return Err(anyhow!("a turn is already running in this session"));
            }
            // Claimed before the handover, not after it: a second send arriving
            // while the first is still being handed over has to lose the race
            // rather than join it.
            *status = SessionStatus::Running;
        }
        // Told to every client, not just the one that pressed send. The claim
        // above was invisible on the wire until `TurnStarted`, which is behind
        // the agent's startup — seconds for a third-party CLI — so a second
        // window went on showing an idle session it was happy to send into, and
        // got this same refusal for its trouble.
        live.publish(SessionEvent::SessionStatusChanged {
            status: SessionStatus::Running,
        })
        .await;
        let started = self
            .start_turn(
                &live,
                session_id,
                text,
                attachments,
                providers,
                additional_system_prompt,
                continues_round,
            )
            .await;
        if started.is_err() {
            // Nothing is running after all, and a session stuck on Running would
            // refuse every later prompt. Withdrawn on the wire as well, or every
            // client keeps the busy state this call just announced.
            *live.status.lock().await = SessionStatus::Idle;
            live.publish(SessionEvent::SessionStatusChanged {
                status: SessionStatus::Idle,
            })
            .await;
        }
        started
    }

    // These are the already-separated protocol fields for one handoff; wrapping
    // them again would add a second request shape inside the session manager.
    #[allow(clippy::too_many_arguments)]
    async fn start_turn(
        &self,
        live: &Arc<Live>,
        session_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        providers: &ProviderMap,
        additional_system_prompt: Option<String>,
        continues_round: Option<String>,
    ) -> Result<String> {
        // The process is lazy, so this is still before any Agent sees the first
        // turn. A running Agent retains the exact prefix it started with; if it
        // has to restart later, the newest validated browser context wins.
        if live.agent.lock().await.is_none() {
            *live.additional_system_prompt.lock().await = additional_system_prompt;
        }
        self.ensure_started(live, providers).await?;

        let seed_owner = {
            let meta = live.meta.lock().await;
            (meta.workspace_id.clone(), meta.id.clone())
        };
        let mut applying_seed = match self.store.load_seed(&seed_owner.0, &seed_owner.1)? {
            Some(mut seed) if seed.state == ContextSeedState::Pending => {
                seed.state = ContextSeedState::Applying;
                self.store.save_seed(&seed_owner.0, &seed_owner.1, &seed)?;
                Some(seed)
            }
            Some(seed) if seed.state == ContextSeedState::Applying => {
                anyhow::bail!(
                    "the reconstructed history may already have been handed to the Agent; \
                     create a new Fork instead of sending it twice"
                )
            }
            Some(_) | None => None,
        };
        let agent_text = applying_seed
            .as_ref()
            .map(|seed| prompt_with_seed(&seed.text, &text))
            .unwrap_or_else(|| text.clone());

        // Record the prompt before handing it over: if the agent dies on the
        // next line, the user's question is still in the log.
        let item = TimelineItem::UserMessage {
            id: format!("u_{}", uuid::Uuid::new_v4().simple()),
            text: text.clone(),
            attachments: attachments.clone(),
        };
        {
            let mut items = live.items.lock().await;
            items.push(item.clone());
        }
        // A session that already has a name keeps it: the name either came
        // from the user or from the first thing they said, and neither gets
        // overwritten by the second message.
        let (workspace_id, needs_title) = {
            let meta = live.meta.lock().await;
            (meta.workspace_id.clone(), meta.title.is_none())
        };
        self.store
            .append_chat_items(&workspace_id, session_id, std::slice::from_ref(&item))?;

        if needs_title {
            if let Some(title) = title_from(&text) {
                {
                    let mut meta = live.meta.lock().await;
                    meta.title = Some(title.clone());
                    meta.updated_at_ms = now_ms();
                    self.store.save_meta(&meta)?;
                }
                // Without this, the sidebar keeps showing "新会话" until
                // something else happens to trigger a `session.list` refetch
                // (switching workspaces, reconnecting) — the title on disk
                // and the title on screen silently disagree until then.
                live.publish(SessionEvent::TitleChanged { title }).await;
            }
        }

        let agent = live.agent.lock().await;
        let agent = agent
            .as_ref()
            .ok_or_else(|| anyhow!("the session has no running agent"))?;
        let turn_id = agent
            .send(PromptInput {
                text: agent_text,
                attachments,
            })
            .await;
        let turn_id = match turn_id {
            Ok(turn_id) => {
                if let Some(seed) = &mut applying_seed {
                    seed.state = ContextSeedState::Applied;
                    self.store
                        .save_seed(&seed_owner.0, &seed_owner.1, seed)
                        .context("marking reconstructed history as applied")?;
                }
                turn_id
            }
            Err(error) => {
                // A returned error means the adapter did not accept a turn.
                // Put the seed back for an explicit retry. A daemon crash while
                // the await is pending leaves `Applying`, which is intentionally
                // blocked above because its outcome is unknowable.
                if let Some(seed) = &mut applying_seed {
                    seed.state = ContextSeedState::Pending;
                    if let Err(save_error) =
                        self.store.save_seed(&seed_owner.0, &seed_owner.1, seed)
                    {
                        tracing::error!(
                            %save_error,
                            session = %seed_owner.1,
                            "could not restore reconstructed history seed after a failed send"
                        );
                    }
                }
                return Err(error).context("handing the prompt to the agent");
            }
        };
        // Only recorded once the handover actually succeeded: a failed send
        // must not leave a round with zero adapter turns behind (`send`
        // resets status to Idle on this same error, as if it never happened).
        if let Some(superseded) = live
            .begin_round(continues_round.as_deref(), &turn_id, item.id())
            .await
        {
            tracing::info!(
                "round {} superseded by a new message ({} adapter turn(s), {}ms blocked)",
                superseded.round_id,
                superseded.adapter_turn_ids.len(),
                superseded.blocked_ms
            );
            persist_round(live, superseded).await;
        }

        // The user message belongs to the turn it started.
        live.publish(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item,
        })
        .await;
        Ok(turn_id)
    }

    /// Starts the agent process if it is not already running.
    ///
    /// Lazily, on first send: creating a session should not cost a process, or
    /// clicking through the sidebar would spawn one per session.
    async fn ensure_started(&self, live: &Arc<Live>, providers: &ProviderMap) -> Result<()> {
        self.ensure_started_in_mode(live, providers, None).await
    }

    /// Starts a stopped native session with an optional one-turn mode override.
    /// Permission recovery uses the Agent's default (highest) mode without
    /// rewriting the user's explicit lower-mode choice in session metadata.
    async fn ensure_started_in_mode(
        &self,
        live: &Arc<Live>,
        providers: &ProviderMap,
        mode_override: Option<String>,
    ) -> Result<()> {
        if live.agent.lock().await.is_some() {
            return Ok(());
        }
        let mut meta = live.meta.lock().await.clone();
        let adapter = self.registry.require(&meta.agent_id)?;
        let offered = adapter.catalog(providers).await;
        if normalize_runtime_selection(&mut meta, &offered) {
            tracing::warn!(
                agent = %meta.agent_id,
                session = %meta.id,
                "recovered stale runtime selection against the current Agent catalog"
            );
            self.store.save_meta(&meta)?;
            *live.meta.lock().await = meta.clone();
        }

        // One start of this kind of agent at a time.
        //
        // Third-party CLIs do first-run work in one place for the whole machine:
        // OpenCode migrates a SQLite database under the user's data directory,
        // and two servers doing that at once lose the race — one exits on a
        // failed `CREATE TABLE` and the person is told "OpenCode stopped before
        // it was ready", with a SQL statement attached. Opening two sessions and
        // asking both a question is an ordinary thing to do, and whether it
        // works must not depend on which process reaches the schema first.
        //
        // Only the start, and only per kind: different agents still come up in
        // parallel, and once a process is running it is out of this path
        // entirely.
        let gate = {
            let mut gates = STARTING.lock().await;
            gates
                .entry(meta.agent_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _starting = gate.lock().await;
        // Whoever held the gate may have been starting this very session.
        if live.agent.lock().await.is_some() {
            return Ok(());
        }

        let scratch = self.store.make_scratch_dir(&meta.workspace_id, &meta.id)?;
        let additional_system_prompt = live.additional_system_prompt.lock().await.clone();
        let config = |resume: Option<PersistHandle>| SessionConfig {
            session_id: meta.id.clone(),
            cwd: meta.cwd.clone(),
            model_id: meta.model_id.clone(),
            mode_id: mode_override.clone().or_else(|| meta.mode_id.clone()),
            effort_id: meta.effort_id.clone(),
            runtime_values: meta.runtime_values.clone(),
            additional_system_prompt: additional_system_prompt.clone(),
            skills_dir: self.skills_dir.clone(),
            front_door_cli: self.front_door_cli.clone(),
            scratch_dir: scratch.clone(),
            providers: providers.clone(),
            resume,
        };

        // A resume handle points at state the session directory does not own —
        // the agent CLI's own thread store, under the user's home. That store
        // can be pruned by the CLI, wiped by the user, or simply absent on the
        // machine the project was copied to. Refusing to start would strand the
        // conversation for good, so a fresh thread is started instead and the
        // timeline says plainly that the agent no longer remembers what is
        // above — which is the one thing the user must not have to guess.
        let mut abandoned_handle = false;
        let session = match adapter.start(config(meta.persist.clone())).await {
            Ok(session) => session,
            Err(error) if meta.persist.is_some() => {
                abandoned_handle = true;
                tracing::warn!(
                    agent = %meta.agent_id,
                    session = %meta.id,
                    %error,
                    "could not resume the agent's thread, starting a fresh one"
                );
                let session = adapter
                    .start(config(None))
                    .await
                    .with_context(|| format!("starting the {} agent", meta.agent_id))?;
                let notice = SessionEvent::Item {
                    // Belongs to the session, not to a turn: nothing has been
                    // sent yet when the agent is started.
                    turn_id: String::new(),
                    item: TimelineItem::Error {
                        id: format!("resume-lost-{}", now_ms()),
                        message: format!(
                            "{} 找不到这个会话之前的线程了，已新开一个继续。上面的内容它不再记得，需要的话请重新说明。",
                            adapter.label()
                        ),
                    },
                };
                apply(live, &notice).await;
                live.publish(notice).await;
                session
            }
            Err(error) => {
                return Err(error).with_context(|| format!("starting the {} agent", meta.agent_id))
            }
        };

        let receiver = session.events();
        // Written back when the agent produced a handle, and cleared when this
        // start had to abandon one that no longer resolves — otherwise every
        // later start would pay for the same discovery. Not touched otherwise:
        // several agents only learn their thread id after the first turn, and
        // a `None` there means "not yet", not "gone".
        let handle = session.persistence();
        if handle.is_some() || abandoned_handle {
            let mut meta = live.meta.lock().await;
            if meta.persist != handle {
                meta.persist = handle;
                self.store.save_meta(&meta)?;
            }
        }
        // Recorded before the pump starts, so that a turn which ends quickly
        // still finds an agent to attribute its leftovers to.
        if let Some(pid) = session.pid().await {
            let session_id = live.meta.lock().await.id.clone();
            self.processes.watch(&session_id, pid).await;
        }
        *live.agent.lock().await = Some(session);

        if let Some(previous) = live.pump.lock().await.take() {
            if !previous.is_finished() {
                previous.abort();
            }
        }
        let pump = tokio::spawn(pump_events(
            live.clone(),
            receiver,
            self.store.clone(),
            self.replay_window,
            self.processes.clone(),
            self.diagnostics.clone(),
        ));
        *live.pump.lock().await = Some(pump);
        Ok(())
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        let agent_id = live.meta.lock().await.agent_id.clone();
        let started = std::time::Instant::now();
        tracing::info!(
            event = "session_interrupt_requested",
            session = %session_id,
            agent = %agent_id,
            "forwarding a user interrupt to the active agent"
        );
        let agent = live.agent.lock().await;
        let result = match agent.as_ref() {
            Some(agent) => agent.interrupt().await,
            // Nothing running is not a failure: the user pressed stop late.
            None => Ok(()),
        };
        match &result {
            Ok(()) => tracing::info!(
                event = "session_interrupt_forwarded",
                session = %session_id,
                agent = %agent_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "the agent accepted the interrupt request"
            ),
            Err(error) => tracing::warn!(
                event = "session_interrupt_failed",
                session = %session_id,
                agent = %agent_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                %error,
                "the agent rejected the interrupt request"
            ),
        }
        result
    }

    /// What this session's agent says it offers, for checking a choice against
    /// when there is no process to ask.
    ///
    /// Before the first prompt there is no agent running — the ordinary case, not
    /// an edge one — and without this a value nobody ever offered was stored, and
    /// then announced, as if it had taken.
    async fn offered(&self, live: &Arc<Live>, providers: &ProviderMap) -> Result<Catalog> {
        let agent_id = live.meta.lock().await.agent_id.clone();
        let adapter = self.registry.require(&agent_id)?;
        Ok(adapter.catalog(providers).await)
    }

    /// Records a model choice, once whoever has to accept it has.
    ///
    /// Order matters both ways. The running agent goes first, so a value it
    /// refuses is not left recorded as if it had taken (Claude Code's own model
    /// list is the only thing that can reject a model name, and it does). And the
    /// event goes out even when there is no process yet — which is the ordinary
    /// case, since one only starts on the first prompt. Without it a client that
    /// renders the picker from session state watched its own choice spring back:
    /// the pick reached us, nothing said so, and the next repaint drew the old
    /// value again.
    pub async fn set_model(
        &self,
        session_id: &str,
        model_id: &str,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        match live.agent.lock().await.as_ref() {
            Some(agent) => agent.set_model(model_id).await?,
            None => {
                let offered = self.offered(&live, providers).await?;
                listed(
                    "model",
                    model_id,
                    offered.models.iter().map(|model| model.id.as_str()),
                )?;
            }
        }
        {
            let mut meta = live.meta.lock().await;
            meta.model_id = Some(model_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        live.publish(SessionEvent::ModelChanged {
            model_id: model_id.to_string(),
        })
        .await;
        Ok(())
    }

    /// Same shape as `set_model`, and for the same two reasons.
    pub async fn set_effort(
        &self,
        session_id: &str,
        effort_id: &str,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        match live.agent.lock().await.as_ref() {
            Some(agent) => agent.set_effort(effort_id).await?,
            None => {
                let offered = self.offered(&live, providers).await?;
                listed(
                    "effort level",
                    effort_id,
                    offered
                        .models
                        .iter()
                        .flat_map(|model| model.efforts.iter().map(String::as_str)),
                )?;
            }
        }
        {
            let mut meta = live.meta.lock().await;
            meta.effort_id = Some(effort_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        live.publish(SessionEvent::EffortChanged {
            effort_id: effort_id.to_string(),
        })
        .await;
        Ok(())
    }

    pub async fn set_runtime_axis(
        &self,
        session_id: &str,
        axis_id: &str,
        value_id: &str,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let offered = self.offered(&live, providers).await?;
        let axis = offered
            .runtime_axes
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|axis| axis.id == axis_id)
            .ok_or_else(|| anyhow!("agent did not offer runtime axis '{axis_id}'"))?;
        listed(
            &format!("value for {}", axis.label),
            value_id,
            axis.values.iter().map(|value| value.id.as_str()),
        )?;
        if let Some(agent) = live.agent.lock().await.as_ref() {
            agent.set_runtime_axis(axis_id, value_id).await?;
        }
        {
            let mut meta = live.meta.lock().await;
            meta.runtime_values
                .insert(axis_id.to_string(), value_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        live.publish(SessionEvent::RuntimeAxisChanged {
            axis_id: axis_id.to_string(),
            value_id: value_id.to_string(),
        })
        .await;
        Ok(())
    }

    /// Same shape as `set_model`, and for the same two reasons.
    pub async fn set_mode(
        &self,
        session_id: &str,
        mode_id: &str,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        if !live.pending_permissions.lock().await.is_empty() {
            return Err(anyhow!(
                "answer or cancel the pending Agent interaction before changing mode"
            ));
        }
        match live.agent.lock().await.as_ref() {
            Some(agent) => agent.set_mode(mode_id).await?,
            None => {
                let offered = self.offered(&live, providers).await?;
                listed(
                    "mode",
                    mode_id,
                    offered.modes.iter().map(|mode| mode.id.as_str()),
                )?;
            }
        }
        {
            let mut meta = live.meta.lock().await;
            meta.mode_id = Some(mode_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        live.publish(SessionEvent::ModeChanged {
            mode_id: mode_id.to_string(),
        })
        .await;
        Ok(())
    }

    pub async fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: PermissionOutcome,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let request = live
            .pending_permissions
            .lock()
            .await
            .iter()
            .find(|request| request.id == request_id)
            .cloned()
            .ok_or_else(|| anyhow!("no pending interaction called '{request_id}'"))?;
        let continuation = continuation_for(&request, &outcome)?;

        if let Some(continuation) = continuation {
            let mode_override = if continuation.elevated {
                let agent_id = live.meta.lock().await.agent_id.clone();
                self.registry
                    .require(&agent_id)?
                    .catalog(providers)
                    .await
                    .default_mode
            } else {
                None
            };
            self.ensure_started_in_mode(&live, providers, mode_override)
                .await
                .context("resuming the stopped Agent session")?;
            *live.status.lock().await = SessionStatus::Running;
            let sent = {
                let agent = live.agent.lock().await;
                let agent = agent
                    .as_ref()
                    .ok_or_else(|| anyhow!("the resumed session has no running agent"))?;
                agent
                    .send(PromptInput {
                        text: continuation.prompt,
                        attachments: Vec::new(),
                    })
                    .await
            };
            match sent {
                Ok(turn_id) => {
                    // This is the daemon deciding to resume, not the client
                    // asking to — the round the interaction interrupted
                    // continues, no `continuesRound` involved (§3.2).
                    live.continue_round(&turn_id).await;
                }
                Err(error) => {
                    *live.status.lock().await = SessionStatus::Waiting;
                    return Err(error).context("continuing after the user response");
                }
            }
        } else {
            // Denied or canceled: no more agent work is coming for this
            // request, so the round it belonged to is done, not dangling.
            if let Some(round) = live.settle_round(RoundOutcome::Canceled).await {
                persist_round(&live, round).await;
            }
        }

        {
            let mut pending = live.pending_permissions.lock().await;
            pending.retain(|request| request.id != request_id);
        }
        {
            let mut meta = live.meta.lock().await;
            meta.pending_permission = None;
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        let resolved = SessionEvent::PermissionResolved {
            request_id: request_id.to_string(),
            outcome,
        };
        apply(&live, &resolved).await;
        live.publish(resolved).await;
        if *live.status.lock().await == SessionStatus::Idle {
            live.publish(SessionEvent::SessionStatusChanged {
                status: SessionStatus::Idle,
            })
            .await;
        }
        Ok(())
    }

    pub async fn archive(&self, session_id: &str, archived: bool) -> Result<SessionSummary> {
        let live = self.live(session_id).await?;
        let mut meta = live.meta.lock().await;
        meta.archived = archived;
        meta.updated_at_ms = now_ms();
        self.store.save_meta(&meta)?;
        let status = *live.status.lock().await;
        Ok(meta.summary(status))
    }

    /// Gives a session the name the user typed.
    ///
    /// Safe from being undone: `send` only names a session whose title is
    /// `None`, so a name set here survives every later message. That property is
    /// the whole feature — a title overwritten a second after typing it would be
    /// worse than no rename at all.
    pub async fn rename(&self, session_id: &str, title: &str) -> Result<SessionSummary> {
        let title = title.trim();
        if title.is_empty() {
            return Err(anyhow!("a session needs a name"));
        }
        // Long enough for a sentence, short enough that one session cannot make
        // the list unreadable for every other one.
        let title: String = title.chars().take(120).collect();

        let live = self.live(session_id).await?;
        let summary = {
            let mut meta = live.meta.lock().await;
            meta.title = Some(title.clone());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            meta.summary(*live.status.lock().await)
        };
        // The same push the daemon sends when it names a session itself, so a
        // phone watching this conversation renames it too instead of keeping
        // the old name until something else forces a refetch.
        live.publish(SessionEvent::TitleChanged { title }).await;
        Ok(summary)
    }

    /// Erases a session: timeline, metadata and scratch space.
    ///
    /// Deleting one that is already gone succeeds. The caller asked for it not
    /// to exist, and it does not — reporting that as a failure would only make
    /// two clients deleting the same row look broken.
    pub async fn delete(&self, session_id: &str) -> Result<()> {
        let live = self.sessions.write().await.remove(session_id);
        let workspace_id = match &live {
            Some(live) => Some(live.meta.lock().await.workspace_id.clone()),
            None => self
                .store
                .list_meta()?
                .into_iter()
                .find(|meta| meta.id == session_id)
                .map(|meta| meta.workspace_id),
        };
        // Stopped before the files go. An agent still running would keep
        // appending to a timeline we just removed, and the session would
        // reappear a moment after being deleted.
        if let Some(live) = live {
            self.end_what_it_left(session_id).await;
            live.shutdown().await;
        }
        self.processes.forget(session_id).await;
        let Some(workspace_id) = workspace_id else {
            return Ok(());
        };
        self.store.delete(&workspace_id, session_id)
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let live = match self.sessions.write().await.remove(session_id) {
            Some(live) => live,
            None => return Ok(()),
        };
        self.end_what_it_left(session_id).await;
        live.shutdown().await;
        self.processes.forget(session_id).await;
        Ok(())
    }

    /// Ends the processes a session left running, before the agent that
    /// answers for them goes away.
    ///
    /// Killing the agent stops its process group, which is most of what it
    /// started — but not a process that started a session of its own, and
    /// those are exactly the ones long enough lived to still be here. Left
    /// alone they would keep running with nothing left that knows whose they
    /// were: not listed, not stoppable, just a held port. So they are ended
    /// here, while the agent is still alive to identify them.
    ///
    /// Before, not after, for that reason: once the agent is gone the
    /// descendants are reparented and there is no longer any way to tell they
    /// were ever this session's.
    async fn end_what_it_left(&self, session_id: &str) {
        let ended = self.processes.stop_all(session_id).await;
        if ended > 0 {
            tracing::info!(session = %session_id, count = ended, "ended what the session left running");
        }
    }

    /// Stops every agent process. Called on daemon shutdown so no orphan
    /// children survive the tray exiting.
    pub async fn shutdown(&self) {
        let sessions: Vec<(String, Arc<Live>)> = self.sessions.write().await.drain().collect();
        for (session_id, live) in sessions {
            self.end_what_it_left(&session_id).await;
            live.shutdown().await;
        }
    }
}

fn import_source_key(agent_id: &str, cwd: &std::path::Path, source_id: &str) -> String {
    let canonical = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut digest = Sha256::new();
    digest.update(agent_id.as_bytes());
    digest.update([0]);
    digest.update(canonical.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(source_id.as_bytes());
    format!("{:x}", digest.finalize())
}

fn portable_fork_item(mut item: TimelineItem) -> TimelineItem {
    match &mut item {
        TimelineItem::TurnSummary { stats, .. } => {
            // A native checkpoint belongs to the source Agent process. It is
            // neither useful nor safe as portable history on another machine.
            stats.fork_checkpoint = None;
        }
        TimelineItem::UserMessage { attachments, .. } => {
            // Absolute paths name the source machine's filesystem. Inline
            // payloads remain portable; path-only attachments remain visible
            // by name without pretending the target can open that path.
            for attachment in attachments {
                attachment.path = None;
            }
        }
        _ => {}
    }
    item
}

fn bound_imported_items(items: Vec<TimelineItem>) -> (Vec<TimelineItem>, usize, usize) {
    let total = items.len();
    let mut kept = Vec::new();
    let mut bytes = 0_usize;
    let mut altered = 0_usize;
    for mut item in items.into_iter().rev() {
        if kept.len() >= IMPORT_VISIBLE_ITEMS {
            break;
        }
        let mut item_bytes = serde_json::to_vec(&item)
            .map(|encoded| encoded.len().saturating_add(1))
            .unwrap_or(IMPORT_VISIBLE_BYTES);
        if item_bytes > IMPORT_VISIBLE_BYTES {
            let original = item.clone();
            item = truncate_import_item(item, IMPORT_VISIBLE_BYTES / 2);
            if item != original {
                altered = altered.saturating_add(1);
            }
            item_bytes = serde_json::to_vec(&item)
                .map(|encoded| encoded.len().saturating_add(1))
                .unwrap_or(IMPORT_VISIBLE_BYTES);
        }
        if !kept.is_empty() && bytes.saturating_add(item_bytes) > IMPORT_VISIBLE_BYTES {
            break;
        }
        bytes = bytes.saturating_add(item_bytes);
        kept.push(item);
    }
    kept.reverse();
    let omitted = total.saturating_sub(kept.len());
    if omitted > 0 {
        kept.insert(
            0,
            TimelineItem::Compaction {
                id: format!("import-{}", uuid::Uuid::new_v4().simple()),
                reason: format!("导入历史过长，较早的 {omitted} 项未放入当前可见窗口"),
            },
        );
    }
    (kept, omitted, altered)
}

fn truncate_import_item(mut item: TimelineItem, max_bytes: usize) -> TimelineItem {
    let id = item.id().to_string();
    let text = match &mut item {
        TimelineItem::UserMessage { text, .. }
        | TimelineItem::AssistantMessage { text, .. }
        | TimelineItem::Reasoning { text, .. } => Some(text),
        TimelineItem::Compaction { reason, .. } => Some(reason),
        TimelineItem::Error { message, .. } => Some(message),
        _ => None,
    };
    if let Some(text) = text {
        if text.len() > max_bytes {
            let mut boundary = max_bytes.min(text.len());
            while boundary > 0 && !text.is_char_boundary(boundary) {
                boundary -= 1;
            }
            text.truncate(boundary);
            text.push_str("\n\n[单条消息过长，导入时已截断]");
        }
    }
    if serde_json::to_vec(&item).is_ok_and(|encoded| encoded.len() <= max_bytes) {
        item
    } else {
        TimelineItem::Compaction {
            id,
            reason: "单条历史记录过长，导入时已省略".into(),
        }
    }
}

fn round_summary(view: &RoundView) -> RoundSummary {
    RoundSummary {
        round_id: view.round_id.clone(),
        user_item_id: view.user_item_id.clone(),
        started_at_ms: view.started_at_ms,
        ended_at_ms: view.ended_at_ms,
        outcome: view.outcome,
        trunk_count: view.trunk_count,
    }
}

fn coverage_for_meta(meta: &SessionMeta, retained_items: usize) -> HistoryCoverage {
    meta.imported
        .as_ref()
        .and_then(|imported| imported.coverage.clone())
        .unwrap_or_else(|| HistoryCoverage {
            source_item_count: Some(u64::try_from(retained_items).unwrap_or(u64::MAX)),
            retained_item_count: u64::try_from(retained_items).unwrap_or(u64::MAX),
            omitted_item_count: 0,
            retrieval: RetrievalCapability::Genehub,
            reason: None,
        })
}

fn parse_trunk_cursor(cursor: Option<&str>, len: usize) -> Result<usize> {
    let Some(cursor) = cursor else {
        return Ok(len);
    };
    let value = cursor
        .strip_prefix("before:")
        .ok_or_else(|| anyhow!("invalid trunk cursor"))?
        .parse::<usize>()
        .map_err(|_| anyhow!("invalid trunk cursor"))?;
    Ok(value.min(len))
}

impl Live {
    fn new(meta: SessionMeta, store: Store) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        let pending = meta.pending_permission.clone();
        Live {
            store,
            meta: Mutex::new(meta),
            status: Mutex::new(if pending.is_some() {
                SessionStatus::Waiting
            } else {
                SessionStatus::Idle
            }),
            items: Mutex::new(Vec::new()),
            rounds: Mutex::new(Vec::new()),
            blob_refs: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            replay: Mutex::new(VecDeque::new()),
            events,
            agent: Mutex::new(None),
            additional_system_prompt: Mutex::new(None),
            pending_permissions: Mutex::new(pending.into_iter().collect()),
            turn_items: Mutex::new(Vec::new()),
            open_trunk_items: Mutex::new(Vec::new()),
            pump: Mutex::new(None),
            active_round: Mutex::new(None),
        }
    }

    async fn snapshot(&self) -> Result<SessionSnapshot> {
        let status = *self.status.lock().await;
        Ok(SessionSnapshot {
            summary: self.meta.lock().await.summary(status),
            items: self.items.lock().await.clone(),
            seq: self.seq.load(Ordering::SeqCst),
            pending_permissions: self.pending_permissions.lock().await.clone(),
            rounds: None,
            expanded_round: None,
        })
    }

    /// Assigns a sequence number, retains for replay, and fans out.
    async fn publish(&self, event: SessionEvent) -> SequencedEvent {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let sequenced = SequencedEvent {
            seq,
            session_id: self.meta.lock().await.id.clone(),
            event,
        };
        {
            let mut replay = self.replay.lock().await;
            replay.push_back(sequenced.clone());
        }
        // A send error only means nobody is listening, which is normal when a
        // task runs with every client disconnected.
        let _ = self.events.send(sequenced.clone());
        sequenced
    }

    async fn trim_replay(&self, window: usize) {
        let mut replay = self.replay.lock().await;
        while replay.len() > window {
            replay.pop_front();
        }
    }

    /// Opens or continues a round for a fresh `session.send`.
    ///
    /// Only the "interrupted, then a new message arrives" case reaches this
    /// decision at all — approval and guidance continuations never go
    /// through `send`, they go through `continue_round` below, because the
    /// daemon can already tell those are the same request. Here it cannot:
    /// `continues_round` is the client's explicit word for "this is the same
    /// request", and its absence — or a mismatch — means cut a new round
    /// rather than guess a stitch that cannot be undone later (§3.2).
    ///
    /// Adds an item to the open trunk and feeds it into the round's trunk
    /// pagination (`ActiveRound::record_trunk_item`, §3.2 direction three).
    /// Idempotent: an item id already recorded is not counted twice, even if
    /// the adapter re-sends a full `Item` event for it — this is also what
    /// keeps trunk boundaries from double-counting a re-sent item.
    async fn record_round_item(&self, item: &TimelineItem) {
        {
            let open = self.open_trunk_items.lock().await;
            if open.iter().any(|id| id == item.id()) {
                return;
            }
        }
        let closed = {
            let mut active = self.active_round.lock().await;
            match active.as_mut() {
                Some(round) if round.outcome.is_none() => round.record_trunk_item(item),
                _ => None,
            }
        };
        if closed.is_some() {
            // `push` closes the previous trunk before placing this item in the
            // new one. Keep the trigger out of the old trunk's persisted id
            // set, then retain it after that set has been drained.
            self.finish_trunk().await;
        }
        self.open_trunk_items
            .lock()
            .await
            .push(item.id().to_string());
    }

    /// The trunk being built right now, assembled from the items still in
    /// memory. `None` when nothing has been recorded into it yet.
    async fn build_open_trunk(&self, index: u32) -> Option<RoundTrunk> {
        let ids = self.open_trunk_items.lock().await.clone();
        if ids.is_empty() {
            return None;
        }
        let items = {
            let items = self.items.lock().await;
            let by_id: HashMap<&str, &TimelineItem> =
                items.iter().map(|item| (item.id(), item)).collect();
            ids.iter()
                .filter_map(|id| by_id.get(id.as_str()).map(|item| (*item).clone()))
                .collect::<Vec<_>>()
        };
        let mut trunk = rounds::trunks_from_items(&items).into_iter().next()?;
        trunk.summary.index = index;
        let refs = self.blob_refs.lock().await;
        for batch in &mut trunk.batches {
            for blob in &mut batch.blobs {
                blob.blob = refs.get(&blob.item_id).cloned();
            }
        }
        Some(trunk)
    }

    /// Writes the trunk that just closed and lets go of it.
    ///
    /// This is where a long round stops costing memory: once a trunk is on
    /// disk it is addressable by path, so its work items and their blob
    /// references are dropped. What stays behind is one summary line per
    /// closed trunk, which is what the round layer pages over.
    async fn finish_trunk(&self) {
        let (ord, index) = {
            let active = self.active_round.lock().await;
            let Some(round) = active.as_ref() else { return };
            (round.ord, round.closed_trunks.len() as u32)
        };
        let Some(trunk) = self.build_open_trunk(index).await else {
            return;
        };
        let meta = self.meta.lock().await.clone();
        if let Err(error) = self
            .store
            .write_trunk(&meta.workspace_id, &meta.id, ord, &trunk)
        {
            // Keeping the items in memory would not save them — the next
            // trunk close would drop them anyway — and refusing to advance
            // would wedge the round. The trunk is lost; the round is not.
            tracing::error!("could not write trunk {index} of {}: {error}", meta.id);
        }
        if let Some(round) = self.active_round.lock().await.as_mut() {
            round.closed_trunks.push(trunk.summary);
        }
        let ids: Vec<String> = std::mem::take(&mut *self.open_trunk_items.lock().await);
        let mut refs = self.blob_refs.lock().await;
        for id in &ids {
            refs.remove(id);
        }
        drop(refs);
        self.items
            .lock()
            .await
            .retain(|item| !(store::is_work_item(item) && ids.iter().any(|id| id == item.id())));
    }

    /// Rewrites the open trunk so a crash cannot cost more than the turn in
    /// progress — the same durability boundary the flat log had.
    async fn persist_open_trunk(&self) {
        let (ord, index) = {
            let active = self.active_round.lock().await;
            let Some(round) = active.as_ref() else { return };
            (round.ord, round.closed_trunks.len() as u32)
        };
        let Some(trunk) = self.build_open_trunk(index).await else {
            return;
        };
        let meta = self.meta.lock().await.clone();
        if let Err(error) = self
            .store
            .write_trunk(&meta.workspace_id, &meta.id, ord, &trunk)
        {
            tracing::warn!("could not persist the open trunk of {}: {error}", meta.id);
        }
    }

    /// Returns the round that was cut short, if any — `None` both when the
    /// round continues and when there was nothing open to cut short (an
    /// already-settled round is just replaced, not "superseded": nothing was
    /// taken from it). The caller records the returned round's final state.
    async fn begin_round(
        &self,
        continues_round: Option<&str>,
        turn_id: &str,
        user_item_id: &str,
    ) -> Option<ActiveRound> {
        {
            let mut active = self.active_round.lock().await;
            if let Some(current) = active.as_mut() {
                if current.outcome.is_none() && continues_round == Some(current.round_id.as_str()) {
                    if !current.adapter_turn_ids.iter().any(|id| id == turn_id) {
                        current.adapter_turn_ids.push(turn_id.to_string());
                    }
                    return None;
                }
            }
        }
        // The dangling round's last trunk is written while that round is still
        // the active one, so it lands in its own directory rather than in the
        // one about to be created.
        let has_open_trunk = {
            let mut active = self.active_round.lock().await;
            match active.as_mut() {
                Some(round) if round.outcome.is_none() => {
                    round.outcome = Some(RoundOutcome::Superseded);
                    round.close_current_trunk_pending().is_some()
                }
                _ => false,
            }
        };
        if has_open_trunk {
            self.finish_trunk().await;
        }
        self.open_trunk_items.lock().await.clear();
        self.blob_refs.lock().await.clear();

        let superseded = self
            .active_round
            .lock()
            .await
            .take()
            .filter(|round| round.outcome == Some(RoundOutcome::Superseded));
        let round = ActiveRound {
            round_id: format!("r_{}", uuid::Uuid::new_v4().simple()),
            ord: self.rounds.lock().await.len() as u32,
            user_item_id: Some(user_item_id.to_string()),
            adapter_turn_ids: vec![turn_id.to_string()],
            started_at_ms: now_ms(),
            blocked_since_ms: None,
            blocked_ms: 0,
            outcome: None,
            current_trunk: TrunkBuilder::default(),
            closed_trunks: Vec::new(),
        };
        // Recorded before the agent runs, so a daemon that dies mid-request
        // still leaves proof the request happened.
        self.record_round(&round).await;
        *self.active_round.lock().await = Some(round);
        superseded
    }

    /// Writes a round's current state to `chat.jsonl` and to the in-memory
    /// list the session layer answers from. Last write per round wins in both.
    async fn record_round(&self, round: &ActiveRound) {
        let record = RoundRecord {
            schema_version: rounds::SCHEMA_VERSION,
            round_id: round.round_id.clone(),
            ord: round.ord,
            user_item_id: round.user_item_id.clone(),
            started_at_ms: round.started_at_ms,
            ended_at_ms: if round.outcome.is_some() { now_ms() } else { 0 },
            outcome: round.outcome,
            adapter_turn_ids: round.adapter_turn_ids.clone(),
            blocked_ms: round.blocked_ms,
            synthesized: false,
            trunk_count: round.closed_trunks.len() as u32,
        };
        {
            let mut rounds = self.rounds.lock().await;
            match rounds
                .iter_mut()
                .find(|existing| existing.round_id == record.round_id)
            {
                Some(existing) => *existing = record.clone(),
                None => rounds.push(record.clone()),
            }
        }
        let meta = self.meta.lock().await.clone();
        if let Err(error) = self
            .store
            .append_round(&meta.workspace_id, &meta.id, &record)
        {
            tracing::error!(
                "could not record round {} of {}: {error}",
                record.ord,
                meta.id
            );
        }
    }

    /// Folds a daemon-initiated continuation (approval granted, guidance
    /// answered) onto the round that was already open when the interaction
    /// started — never mints a new round, since the daemon itself decided to
    /// resume rather than being told to by the client.
    async fn continue_round(&self, turn_id: &str) {
        let mut active = self.active_round.lock().await;
        if let Some(round) = active.as_mut() {
            if round.outcome.is_none() {
                if let Some(since) = round.blocked_since_ms.take() {
                    round.blocked_ms += (now_ms() - since).max(0);
                }
                if !round.adapter_turn_ids.iter().any(|id| id == turn_id) {
                    round.adapter_turn_ids.push(turn_id.to_string());
                }
            }
        }
    }

    /// Marks the open round as waiting on a human. A no-op if it is already
    /// marked — two permission requests in a row must not double-count the
    /// gap between the first answer and the second question.
    async fn round_blocked(&self) {
        let mut active = self.active_round.lock().await;
        if let Some(round) = active.as_mut() {
            if round.outcome.is_none() && round.blocked_since_ms.is_none() {
                round.blocked_since_ms = Some(now_ms());
            }
        }
    }

    /// Ends the open round, if there is one, returning it together with the
    /// item ids it accumulated so the caller can append a `RoundRecord`
    /// (`session/rounds.rs`). `None` when there was nothing open to settle —
    /// this is also how a caller like the channel-closed fallback tells
    /// "there was a dangling round to clean up" from "there was nothing to do".
    async fn settle_round(&self, outcome: RoundOutcome) -> Option<ActiveRound> {
        let has_open_trunk = {
            let mut active = self.active_round.lock().await;
            let round = active.as_mut()?;
            if round.outcome.is_some() {
                return None;
            }
            if let Some(since) = round.blocked_since_ms.take() {
                round.blocked_ms += (now_ms() - since).max(0);
            }
            round.outcome = Some(outcome);
            round.close_current_trunk_pending().is_some()
        };
        if has_open_trunk {
            self.finish_trunk().await;
        }
        self.open_trunk_items.lock().await.clear();
        self.blob_refs.lock().await.clear();
        self.active_round.lock().await.clone()
    }

    async fn shutdown(&self) {
        if let Some(pump) = self.pump.lock().await.take() {
            pump.abort();
        }
        if let Some(agent) = self.agent.lock().await.take() {
            let _ = agent.close().await;
        }
        *self.status.lock().await = SessionStatus::Closed;
    }
}

/// One first start at a time, per kind of agent, for the whole process.
///
/// Scoped to the process rather than to a manager because what it protects is
/// not ours: the state a third-party CLI sets up on first run belongs to the
/// machine, not to whoever asked it to start. See `ensure_started`.
static STARTING: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Continuation {
    elevated: bool,
    prompt: String,
}

fn continuation_for(
    request: &PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<Continuation>> {
    match request.kind {
        PermissionRequestKind::Permission => {
            let Some(option) = selected_option(request, outcome)? else {
                return Ok(None);
            };
            if option.kind == PermissionOptionKind::Reject {
                return Ok(None);
            }
            Ok(Some(Continuation {
                elevated: true,
                prompt: format!(
                    "The user approved the interrupted permission request: {}. Resume the original \
                     task from the current conversation state and do not repeat completed work.",
                    option.label
                ),
            }))
        }
        PermissionRequestKind::PlanApproval => {
            let Some(option) = selected_option(request, outcome)? else {
                return Ok(None);
            };
            if option.kind == PermissionOptionKind::Reject {
                return Ok(None);
            }
            Ok(Some(Continuation {
                elevated: false,
                prompt: format!(
                    "The user approved the interrupted plan '{}'. Continue implementing that plan \
                     from the current conversation state and do not repeat completed work.",
                    request.title
                ),
            }))
        }
        PermissionRequestKind::Question => {
            let answer = question_answer(request, outcome)?;
            let Some(answer) = answer else {
                return Ok(None);
            };
            Ok(Some(Continuation {
                elevated: false,
                prompt: format!(
                    "The user answered the interrupted questions:\n{answer}\nResume the original \
                     task from the current conversation state and do not repeat completed work."
                ),
            }))
        }
    }
}

fn selected_option<'a>(
    request: &'a PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<&'a genehub_proto::PermissionOption>> {
    let PermissionOutcome::Selected { option_id } = outcome else {
        return Ok(None);
    };
    request
        .options
        .iter()
        .find(|option| option.id == *option_id)
        .map(Some)
        .ok_or_else(|| anyhow!("'{option_id}' is not an option for this interaction"))
}

fn question_answer(
    request: &PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<String>> {
    if let Some(option) = selected_option(request, outcome)? {
        return Ok(Some(format!("- {}: {}", request.title, option.label)));
    }
    let PermissionOutcome::Answered { answers } = outcome else {
        return Ok(None);
    };
    let mut lines = Vec::new();
    for question in request.questions.as_deref().unwrap_or_default() {
        let answer = answers
            .iter()
            .find(|answer| answer.question_id == question.id)
            .ok_or_else(|| anyhow!("question '{}' was not answered", question.id))?;
        if !question.allow_multiple && answer.selected_option_ids.len() > 1 {
            return Err(anyhow!(
                "question '{}' accepts only one option",
                question.id
            ));
        }
        let mut values = Vec::new();
        for option_id in &answer.selected_option_ids {
            let option = question
                .options
                .iter()
                .find(|option| option.id == *option_id)
                .ok_or_else(|| {
                    anyhow!(
                        "'{option_id}' is not an option for question '{}'",
                        question.id
                    )
                })?;
            values.push(option.label.clone());
        }
        let freeform = answer
            .freeform_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if freeform.is_some() && !question.allow_freeform {
            return Err(anyhow!(
                "question '{}' does not accept a free-form answer",
                question.id
            ));
        }
        if let Some(text) = freeform {
            values.push(text.to_string());
        }
        if values.is_empty() {
            return Err(anyhow!("question '{}' has no answer", question.id));
        }
        lines.push(format!("- {}: {}", question.prompt, values.join(", ")));
    }
    Ok((!lines.is_empty()).then(|| lines.join("\n")))
}

async fn stop_agent_for_interaction(live: &Arc<Live>, store: &Store, request: &PermissionRequest) {
    live.round_blocked().await;
    let agent = live.agent.lock().await.take();
    let persist = agent.as_ref().and_then(|agent| agent.persistence());
    {
        let mut meta = live.meta.lock().await;
        if let Some(persist) = persist {
            meta.persist = Some(persist);
        }
        meta.pending_permission = Some(request.clone());
        meta.updated_at_ms = now_ms();
        if let Err(error) = store.save_meta(&meta) {
            tracing::error!(
                "could not persist stopped interaction {}: {error}",
                request.id
            );
        }
    }

    if let Some(agent) = agent {
        // Interruption is best-effort and bounded. The process is closed either
        // way, so no approval request or live transport has to survive.
        let _ = tokio::time::timeout(Duration::from_secs(5), agent.interrupt()).await;
        if let Err(error) = agent.close().await {
            tracing::warn!("could not close an Agent stopped for interaction: {error}");
        }
    }
}

enum BlobWrite {
    Put {
        item_id: String,
        value: serde_json::Value,
    },
    Flush(oneshot::Sender<()>),
}

fn flush_reasoning_blobs(
    sender: &mpsc::UnboundedSender<BlobWrite>,
    raw: &mut HashMap<String, String>,
) {
    for (id, text) in raw.drain() {
        let value = serde_json::to_value(TimelineItem::Reasoning {
            id: id.clone(),
            text,
        });
        if let Ok(value) = value {
            let _ = sender.send(BlobWrite::Put { item_id: id, value });
        }
    }
}

fn preserve_tool_blob(sender: &mpsc::UnboundedSender<BlobWrite>, item: &TimelineItem) {
    let TimelineItem::ToolCall { id, .. } = item else {
        return;
    };
    if let Ok(value) = serde_json::to_value(item) {
        let _ = sender.send(BlobWrite::Put {
            item_id: id.clone(),
            value,
        });
    }
}

async fn flush_blob_writer(sender: &mpsc::UnboundedSender<BlobWrite>) {
    let (done, wait) = oneshot::channel();
    if sender.send(BlobWrite::Flush(done)).is_ok() {
        let _ = wait.await;
    }
}

/// Folds adapter events into session state, then republishes them.
///
/// Everything passes through `overview` first: the daemon's answer to "what
/// is the agent doing" is one sentence per tool call or thinking block, not
/// the payload that sentence summarizes. Shedding it here — the one place
/// every agent's events converge — lightens the wire, the replay buffer, the
/// snapshot and the on-disk log in a single move.
async fn pump_events(
    live: Arc<Live>,
    mut receiver: broadcast::Receiver<SessionEvent>,
    store: Store,
    replay_window: usize,
    processes: Arc<crate::processes::Processes>,
    diagnostics: Arc<Diagnostics>,
) {
    let (workspace_id, session_id) = {
        let meta = live.meta.lock().await;
        (meta.workspace_id.clone(), meta.id.clone())
    };
    let (blob_sender, mut blob_receiver) = mpsc::unbounded_channel::<BlobWrite>();
    let blob_store = store.clone();
    let blob_workspace_id = workspace_id.clone();
    let blob_session_id = session_id.clone();
    let blob_live = live.clone();
    // Blocking, because it is doing file IO, and single-tasked, so appends to
    // one bucket stay ordered and the offset each reference carries is the one
    // the bytes actually landed at. The references it produces go back onto
    // `Live` for the trunk writer to pick up; a `Flush` is awaited before any
    // turn ends, so a work row is never written before its payload's address
    // is known.
    #[cfg(not(target_family = "wasm"))]
    let blob_writer = tokio::task::spawn_blocking(move || {
        while let Some(write) = blob_receiver.blocking_recv() {
            match write {
                BlobWrite::Put { item_id, value } => {
                    match blob_store.put_blob(&blob_workspace_id, &blob_session_id, value) {
                        Ok(blob) => {
                            blob_live.blob_refs.blocking_lock().insert(item_id, blob);
                        }
                        Err(error) => {
                            tracing::warn!("could not preserve blob {item_id}: {error}")
                        }
                    }
                }
                BlobWrite::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    #[cfg(target_family = "wasm")]
    let blob_writer = tokio::spawn(async move {
        while let Some(write) = blob_receiver.recv().await {
            match write {
                BlobWrite::Put { item_id, value } => {
                    match blob_store.put_blob(&blob_workspace_id, &blob_session_id, value) {
                        Ok(blob) => {
                            blob_live.blob_refs.lock().await.insert(item_id, blob);
                        }
                        Err(error) => {
                            tracing::warn!("could not preserve blob {item_id}: {error}")
                        }
                    }
                }
                BlobWrite::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    // The compact overview and source-preserved content have different
    // lifetimes. Only the former enters the timeline; the latter is flushed to
    // the content-addressed blob layer when the reasoning block moves on.
    let mut thinking: HashMap<String, String> = HashMap::new();
    let mut raw_thinking: HashMap<String, String> = HashMap::new();
    let mut raw_tools: HashMap<String, TimelineItem> = HashMap::new();
    let mut turns: HashMap<String, (i64, HashSet<String>)> = HashMap::new();
    let mut live_usage: HashMap<String, Usage> = HashMap::new();
    let mut counted_tools: HashSet<String> = HashSet::new();
    let mut channel_closed = false;
    loop {
        let mut event = match receiver.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Closed) => {
                diagnostics.record("agent", "event-stream", "error", Some("closed"));
                flush_reasoning_blobs(&blob_sender, &mut raw_thinking);
                // No `TurnFailed`, no `TurnCanceled` — the adapter's own sender
                // just vanished (a crashed process is the ordinary cause). The
                // round the proposal calls out this exact gap for (§3.2
                // direction one, "adapter 事件通道关闭、子进程退出"): without
                // this, it stays open forever and whatever it already
                // produced never reaches disk.
                channel_closed = true;
                break;
            }
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                diagnostics.record("agent", "event-stream", "error", Some("dropped"));
                tracing::warn!("dropped {missed} agent events: the pump fell behind");
                continue;
            }
        };

        if let SessionEvent::TurnProgress { turn_id, usage } = &event {
            token_usage::merge_progress(live_usage.entry(turn_id.clone()).or_default(), usage);
            if let Some(merged) = live_usage.get(turn_id) {
                event = SessionEvent::TurnProgress {
                    turn_id: turn_id.clone(),
                    usage: merged.clone(),
                };
            }
        }
        let tool_progress =
            token_usage::record_tool_output(&event, &mut live_usage, &mut counted_tools);

        match &event {
            SessionEvent::TurnStarted { .. } => {
                diagnostics.record("agent", "turn", "started", None)
            }
            SessionEvent::TurnCompleted { .. } => diagnostics.record("agent", "turn", "ok", None),
            SessionEvent::TurnFailed { error, .. } => {
                diagnostics.record("agent", "turn", "error", Some(turn_error_code(error.code)))
            }
            SessionEvent::TurnCanceled { .. } => {
                diagnostics.record("agent", "turn", "canceled", None)
            }
            _ => {}
        }

        if let SessionEvent::TurnStarted {
            turn_id,
            started_at_ms,
        } = &mut event
        {
            if *started_at_ms <= 0 {
                *started_at_ms = now_ms();
            }
            turns.insert(turn_id.clone(), (*started_at_ms, HashSet::new()));
        }
        if let SessionEvent::Item { turn_id, item } = &event {
            let entry = turns
                .entry(turn_id.clone())
                .or_insert_with(|| (now_ms(), HashSet::new()));
            collect_tool_ids(item, &mut entry.1);
        }

        let updates_reasoning = match &event {
            SessionEvent::Item {
                item: TimelineItem::Reasoning { id, text },
                ..
            } => {
                raw_thinking.insert(id.clone(), text.clone());
                true
            }
            SessionEvent::ItemDelta {
                item_id,
                delta: ItemDelta::Text { delta },
                ..
            } if raw_thinking.contains_key(item_id) => {
                raw_thinking
                    .get_mut(item_id)
                    .expect("checked against the same map")
                    .push_str(delta);
                true
            }
            _ => false,
        };
        if !updates_reasoning {
            flush_reasoning_blobs(&blob_sender, &mut raw_thinking);
        }
        match &event {
            SessionEvent::Item {
                item: item @ TimelineItem::ToolCall { id, .. },
                ..
            } => {
                raw_tools.insert(id.clone(), item.clone());
                preserve_tool_blob(&blob_sender, item);
            }
            SessionEvent::ItemDelta {
                item_id,
                delta: ItemDelta::ToolStatus { status, detail },
                ..
            } => {
                if let Some(item) = raw_tools.get_mut(item_id) {
                    if let TimelineItem::ToolCall {
                        status: raw_status,
                        detail: raw_detail,
                        ..
                    } = item
                    {
                        *raw_status = *status;
                        if let Some(detail) = detail {
                            *raw_detail = detail.clone();
                        }
                    }
                    preserve_tool_blob(&blob_sender, item);
                }
                if matches!(
                    status,
                    ToolStatus::Ok | ToolStatus::Error | ToolStatus::Canceled
                ) {
                    raw_tools.remove(item_id);
                }
            }
            _ => {}
        }
        if matches!(
            event,
            SessionEvent::TurnCompleted { .. }
                | SessionEvent::TurnFailed { .. }
                | SessionEvent::TurnCanceled { .. }
        ) {
            flush_blob_writer(&blob_sender).await;
        }

        let event = match event {
            SessionEvent::ItemDelta {
                turn_id,
                item_id,
                delta: ItemDelta::Text { delta },
            } if thinking.contains_key(&item_id) => {
                let published = thinking
                    .get_mut(&item_id)
                    .expect("checked against the same map");
                if published.ends_with('…')
                    || published.chars().count() >= overview::REASONING_CHARS
                {
                    continue;
                }
                let sentence =
                    overview::shorten(&format!("{published}{delta}"), overview::REASONING_CHARS);
                if sentence == *published {
                    // The first sentence is already on screen; the rest of the
                    // block is the detail being filtered.
                    continue;
                }
                *published = sentence.clone();
                SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::Reasoning {
                        id: item_id,
                        text: sentence,
                    },
                }
            }
            event => {
                if let SessionEvent::Item {
                    item: TimelineItem::Reasoning { id, text },
                    ..
                } = &event
                {
                    // An Item frame carries the block's text so far, whole —
                    // it replaces rather than extends what deltas built up.
                    let sentence = overview::shorten(text, overview::REASONING_CHARS);
                    thinking.insert(id.clone(), sentence.clone());
                    if sentence.is_empty() {
                        continue;
                    }
                }
                overview::condense_event(&event)
            }
        };

        if let SessionEvent::PermissionRequested { request } = &event {
            stop_agent_for_interaction(&live, &store, request).await;

            // End the old turn before exposing the request. Approval later
            // starts a new native turn from the Agent's persisted session.
            if let Some(turn_id) = turns.keys().next().cloned() {
                let canceled = SessionEvent::TurnCanceled { turn_id };
                let items = live.items.lock().await;
                let stats = turn_summary(&canceled, &mut turns, &mut live_usage, &items);
                drop(items);
                if let Some(stats) = stats {
                    let summary_event = SessionEvent::Item {
                        turn_id: stats.turn_id.clone(),
                        item: TimelineItem::TurnSummary {
                            id: format!("turn-summary-{}", stats.turn_id),
                            stats,
                        },
                    };
                    apply(&live, &summary_event).await;
                    live.publish(summary_event).await;
                }
                apply(&live, &canceled).await;
                live.publish(canceled).await;
                flush_turn(&live, &store).await;
            }

            apply(&live, &event).await;
            live.publish(event).await;
            live.trim_replay(replay_window).await;
            break;
        }

        let summary = {
            let items = live.items.lock().await;
            turn_summary(&event, &mut turns, &mut live_usage, &items)
        };
        if let Some(stats) = summary {
            let summary_event = SessionEvent::Item {
                turn_id: stats.turn_id.clone(),
                item: TimelineItem::TurnSummary {
                    id: format!("turn-summary-{}", stats.turn_id),
                    stats,
                },
            };
            apply(&live, &summary_event).await;
            live.publish(summary_event).await;
            live.trim_replay(replay_window).await;
        }

        apply(&live, &event).await;

        let settle = matches!(
            event,
            SessionEvent::TurnCompleted { .. }
                | SessionEvent::TurnFailed { .. }
                | SessionEvent::TurnCanceled { .. }
        );
        // `TurnCanceled` deliberately does not settle the round here: the one
        // triggered by a permission request already `break`s above before
        // reaching this line, and every other `TurnCanceled` is a plain
        // interrupt, which leaves the round dangling on purpose until the
        // next `send` decides whether to continue or supersede it (§3.2).
        match &event {
            SessionEvent::TurnCompleted { .. } => {
                if let Some(round) = live.settle_round(RoundOutcome::Completed).await {
                    persist_round(&live, round).await;
                }
            }
            SessionEvent::TurnFailed { .. } => {
                if let Some(round) = live.settle_round(RoundOutcome::Failed).await {
                    persist_round(&live, round).await;
                }
            }
            _ => {}
        }

        live.publish(event).await;
        if let Some(progress) = tool_progress {
            apply(&live, &progress).await;
            live.publish(progress).await;
        }
        live.trim_replay(replay_window).await;

        if settle {
            thinking.clear();
            flush_turn(&live, &store).await;
            // The end of a turn is when "what is still running" starts to mean
            // something. Until then everything the agent started is running
            // because the agent is still working.
            processes.announce_now().await;
        }
    }
    flush_reasoning_blobs(&blob_sender, &mut raw_thinking);
    flush_blob_writer(&blob_sender).await;
    drop(blob_sender);
    let _ = blob_writer.await;
    if channel_closed {
        finalize_after_channel_closed(&live, &store).await;
    }
}

fn turn_error_code(code: TurnErrorCode) -> &'static str {
    match code {
        TurnErrorCode::MissingCredentials => "missingCredentials",
        TurnErrorCode::RateLimited => "rateLimited",
        TurnErrorCode::Upstream => "upstream",
        TurnErrorCode::Timeout => "timeout",
        TurnErrorCode::AgentCrashed => "agentCrashed",
        TurnErrorCode::Canceled => "canceled",
        TurnErrorCode::Internal => "internal",
    }
}

fn collect_tool_ids(item: &TimelineItem, ids: &mut HashSet<String>) {
    let TimelineItem::ToolCall { id, detail, .. } = item else {
        return;
    };
    ids.insert(id.clone());
    if let genehub_proto::ToolCallDetail::SubAgent { items, .. } = detail {
        for item in items {
            collect_tool_ids(item, ids);
        }
    }
}

fn turn_summary(
    event: &SessionEvent,
    turns: &mut HashMap<String, (i64, HashSet<String>)>,
    live_usage: &mut HashMap<String, Usage>,
    items: &[TimelineItem],
) -> Option<TurnStats> {
    let (turn_id, outcome, mut usage, fork_checkpoint) = match event {
        SessionEvent::TurnCompleted {
            turn_id,
            usage,
            fork_checkpoint,
        } => {
            let mut usage = usage.clone();
            if let Some(tracked) = live_usage.remove(turn_id) {
                if usage.tool_output_tokens == 0 {
                    usage.tool_output_tokens = tracked.tool_output_tokens;
                }
                if usage.llm_rounds == 0 {
                    usage.llm_rounds = tracked.llm_rounds;
                }
                if usage.input_tokens == 0 && usage.output_tokens == 0 {
                    usage.input_tokens = tracked.input_tokens;
                    usage.output_tokens = tracked.output_tokens;
                    usage.cache_read_tokens = tracked.cache_read_tokens;
                    usage.cache_write_tokens = tracked.cache_write_tokens;
                    usage.cost_usd = tracked.cost_usd.or(usage.cost_usd);
                }
                // The adapter's final event is authoritative for the rate
                // stats, but a provider that reports usage only in a trailing
                // event can replace the usage wholesale and drop them; backfill
                // from the live track so the footer does not lose TTFT/rate.
                if usage.avg_ttft_ms.is_none() {
                    usage.avg_ttft_ms = tracked.avg_ttft_ms;
                }
                if usage.avg_output_rate_tps.is_none() {
                    usage.avg_output_rate_tps = tracked.avg_output_rate_tps;
                }
            }
            (
                turn_id,
                TurnOutcome::Completed,
                usage,
                fork_checkpoint.clone(),
            )
        }
        SessionEvent::TurnFailed { turn_id, .. } => (
            turn_id,
            TurnOutcome::Failed,
            live_usage.remove(turn_id).unwrap_or_default(),
            None,
        ),
        SessionEvent::TurnCanceled { turn_id } => (
            turn_id,
            TurnOutcome::Canceled,
            live_usage.remove(turn_id).unwrap_or_default(),
            None,
        ),
        _ => return None,
    };
    token_usage::fill_usage_from_items(&mut usage, items);
    let finished_at_ms = now_ms();
    let (started_at_ms, tools) = turns
        .remove(turn_id)
        .unwrap_or_else(|| (finished_at_ms, HashSet::new()));
    Some(TurnStats {
        turn_id: turn_id.clone(),
        outcome,
        started_at_ms,
        finished_at_ms,
        duration_ms: finished_at_ms.saturating_sub(started_at_ms) as u64,
        usage,
        tool_calls: tools.len() as u64,
        fork_checkpoint,
    })
}

/// Applies an event to the in-memory timeline.
async fn apply(live: &Arc<Live>, event: &SessionEvent) {
    match event {
        SessionEvent::Item { item, .. } => {
            let mut items = live.items.lock().await;
            match items.iter_mut().find(|existing| existing.id() == item.id()) {
                Some(existing) => *existing = item.clone(),
                None => items.push(item.clone()),
            }
            // Dropped explicitly, not just left to fall out of scope at the
            // end of this match arm: `record_round_item` can re-lock
            // `live.items` itself (`resolve_monologue_text`), and
            // `tokio::sync::Mutex` is not reentrant — holding this guard
            // across that call would deadlock the pump task.
            drop(items);
            let mut turn_items = live.turn_items.lock().await;
            if !turn_items.iter().any(|id| id == item.id()) {
                turn_items.push(item.id().to_string());
            }
            drop(turn_items);
            live.record_round_item(item).await;
        }
        SessionEvent::ItemDelta { item_id, delta, .. } => {
            let mut items = live.items.lock().await;
            let Some(item) = items.iter_mut().find(|item| item.id() == item_id) else {
                return;
            };
            match delta {
                ItemDelta::Text { delta } => {
                    item.append_text(delta);
                }
                ItemDelta::ToolStatus { status, detail } => {
                    if let TimelineItem::ToolCall {
                        status: current,
                        detail: current_detail,
                        ..
                    } = item
                    {
                        *current = *status;
                        if let Some(detail) = detail {
                            *current_detail = detail.clone();
                        }
                    }
                }
            }
        }
        SessionEvent::PermissionRequested { request } => {
            *live.pending_permissions.lock().await = vec![request.clone()];
            *live.status.lock().await = SessionStatus::Waiting;
        }
        SessionEvent::PermissionResolved { request_id, .. } => {
            let all_resolved = {
                let mut pending = live.pending_permissions.lock().await;
                pending.retain(|request| &request.id != request_id);
                pending.is_empty()
            };
            let mut status = live.status.lock().await;
            if all_resolved && *status == SessionStatus::Waiting {
                *status = SessionStatus::Idle;
            }
        }
        SessionEvent::TurnStarted { .. } => {
            *live.status.lock().await = SessionStatus::Running;
        }
        SessionEvent::TurnProgress { .. } => {}
        SessionEvent::TurnCompleted { .. } | SessionEvent::TurnCanceled { .. } => {
            let pending = !live.pending_permissions.lock().await.is_empty();
            *live.status.lock().await = if pending {
                SessionStatus::Waiting
            } else {
                SessionStatus::Idle
            };
        }
        SessionEvent::TurnFailed { error, .. } => {
            // Logged here rather than in each adapter, because every agent's
            // failures pass through this one place — and until they were written
            // down, a log could show an agent starting cleanly and then nothing at
            // all, while the user was looking at an error on screen.
            let meta = live.meta.lock().await;
            tracing::warn!(
                "turn failed in {} ({}): {:?} {}",
                meta.id,
                meta.agent_id,
                error.code,
                error.message
            );
            drop(meta);
            // Failed, not closed: the user can send again, but the sidebar must
            // keep the abnormal completion visible until that next attempt.
            let pending = !live.pending_permissions.lock().await.is_empty();
            *live.status.lock().await = if pending {
                SessionStatus::Waiting
            } else {
                SessionStatus::Failed
            };
        }
        SessionEvent::ModelChanged { model_id } => {
            let mut meta = live.meta.lock().await;
            meta.model_id = Some(model_id.clone());
        }
        SessionEvent::ModeChanged { mode_id } => {
            let mut meta = live.meta.lock().await;
            meta.mode_id = Some(mode_id.clone());
        }
        SessionEvent::EffortChanged { effort_id } => {
            let mut meta = live.meta.lock().await;
            meta.effort_id = Some(effort_id.clone());
        }
        SessionEvent::RuntimeAxisChanged { axis_id, value_id } => {
            let mut meta = live.meta.lock().await;
            meta.runtime_values
                .insert(axis_id.clone(), value_id.clone());
        }
        SessionEvent::SessionStatusChanged { status } => {
            *live.status.lock().await = *status;
        }
        // Published straight from `SessionManager::send`, never by an agent,
        // so it never reaches this function's caller in practice — `meta`
        // is already updated by the time it is published. Listed anyway so
        // this match stays exhaustive if that ever changes.
        SessionEvent::TitleChanged { .. } => {}
    }
}

/// Covers the one case `TurnCompleted`/`TurnFailed`/`TurnCanceled` do not:
/// the adapter's event channel closing with no terminal event at all.
///
/// A no-op unless there was an open round — ordinary shutdown (`Live::
/// shutdown`) aborts the pump task outright rather than letting `recv` see
/// `Closed`, and a round that already settled has nothing left to clean up.
async fn finalize_after_channel_closed(live: &Arc<Live>, store: &Store) {
    let Some(round) = live.settle_round(RoundOutcome::Failed).await else {
        return;
    };
    persist_round(live, round).await;
    // Whatever this turn had produced so far would otherwise never reach
    // disk: `flush_turn` only ever ran from inside this same loop, on a
    // terminal event that, this time, never arrived.
    flush_turn(live, store).await;
    let pending = !live.pending_permissions.lock().await.is_empty();
    *live.status.lock().await = if pending {
        SessionStatus::Waiting
    } else {
        SessionStatus::Failed
    };
}

/// Records a round's final state on `chat.jsonl`.
///
/// Failure is logged, not propagated: a missing record degrades a later
/// cross-session query to "this round is invisible to it", not data loss —
/// the round's narrative and trunks already reached disk.
async fn persist_round(live: &Arc<Live>, round: ActiveRound) {
    if round.outcome.is_none() {
        // Should not happen: every caller only reaches here after setting an
        // outcome. Guarded anyway rather than unwrapped, because a ledger
        // write is not worth a panic over.
        return;
    }
    live.record_round(&round).await;
}

/// Writes what this turn produced, once, when the turn ends: narrative to the
/// chat layer, work to the open trunk.
async fn flush_turn(live: &Arc<Live>, store: &Store) {
    let ids: Vec<String> = std::mem::take(&mut *live.turn_items.lock().await);
    if ids.is_empty() {
        return;
    }
    let items = live.items.lock().await;
    let settled: Vec<TimelineItem> = ids
        .iter()
        .filter_map(|id| items.iter().find(|item| item.id() == id))
        // The prompt was already written when it arrived.
        .filter(|item| !matches!(item, TimelineItem::UserMessage { .. }))
        .cloned()
        .collect();
    drop(items);

    let (workspace_id, session_id) = {
        let meta = live.meta.lock().await;
        (meta.workspace_id.clone(), meta.id.clone())
    };
    live.persist_open_trunk().await;
    if let Err(error) = store.append_chat_items(&workspace_id, &session_id, &settled) {
        tracing::error!("could not persist the timeline for {session_id}: {error}");
    }
    let mut meta = live.meta.lock().await;
    meta.updated_at_ms = now_ms();
    let _ = store.save_meta(&meta);
}

/// Tool status changes carry an implicit rule worth naming: a delta that names
/// an item we have never seen is dropped rather than creating a phantom entry.
#[allow(dead_code)]
fn _doc_only(_: ToolStatus) {}

/// Refuses a value the agent never offered.
///
/// An empty list means the agent named nothing on that axis — not that everything
/// is allowed — but there is then no picker to have chosen from either, so the
/// value is left to whoever sent it rather than guessed at here.
fn listed<'a>(axis: &str, value: &str, offered: impl Iterator<Item = &'a str>) -> Result<()> {
    let offered: Vec<&str> = offered.collect();
    if offered.is_empty() || offered.contains(&value) {
        return Ok(());
    }
    anyhow::bail!(
        "'{value}' is not a {axis} this agent offers ({})",
        offered.join(", ")
    )
}

/// Reconcile durable choices with what this Agent offers *now*.
/// Catalog-less Agents remain opaque; declared catalogs are authoritative.
fn normalize_runtime_selection(meta: &mut SessionMeta, catalog: &Catalog) -> bool {
    let before = (
        meta.model_id.clone(),
        meta.mode_id.clone(),
        meta.effort_id.clone(),
        meta.runtime_values.clone(),
    );

    if !catalog.models.is_empty()
        && meta
            .model_id
            .as_ref()
            .is_some_and(|id| !catalog.models.iter().any(|model| &model.id == id))
    {
        meta.model_id = catalog
            .default_model
            .as_ref()
            .filter(|id| catalog.models.iter().any(|model| &model.id == *id))
            .cloned()
            .or_else(|| catalog.models.first().map(|model| model.id.clone()));
    }
    if !catalog.modes.is_empty()
        && meta
            .mode_id
            .as_ref()
            .is_some_and(|id| !catalog.modes.iter().any(|mode| &mode.id == id))
    {
        meta.mode_id = catalog
            .default_mode
            .as_ref()
            .filter(|id| catalog.modes.iter().any(|mode| &mode.id == *id))
            .cloned()
            .or_else(|| catalog.modes.first().map(|mode| mode.id.clone()));
    }

    if !catalog.models.is_empty() {
        let efforts = meta
            .model_id
            .as_ref()
            .and_then(|id| catalog.models.iter().find(|model| &model.id == id))
            .map(|model| model.efforts.as_slice())
            .unwrap_or(&[]);
        if meta
            .effort_id
            .as_ref()
            .is_some_and(|id| !efforts.contains(id))
        {
            meta.effort_id = catalog
                .default_effort
                .as_ref()
                .filter(|id| efforts.contains(id))
                .cloned();
        }
    }

    if let Some(axes) = catalog.runtime_axes.as_deref() {
        meta.runtime_values.retain(|axis_id, value_id| {
            axes.iter().any(|axis| {
                &axis.id == axis_id && axis.values.iter().any(|value| &value.id == value_id)
            })
        });
    }

    before
        != (
            meta.model_id.clone(),
            meta.mode_id.clone(),
            meta.effort_id.clone(),
            meta.runtime_values.clone(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{ToolCallDetail, TurnError, TurnErrorCode, Usage};

    fn meta() -> SessionMeta {
        SessionMeta {
            effort_id: None,
            id: "s1".into(),
            workspace_id: "w1".into(),
            format: SESSION_FORMAT,
            agent_id: "genet".into(),
            title: None,
            cwd: PathBuf::from("/tmp"),
            model_id: None,
            mode_id: None,
            runtime_values: Default::default(),
            created_at_ms: 0,
            updated_at_ms: 0,
            archived: false,
            persist: None,
            pending_permission: None,
            lineage: None,
            imported: None,
        }
    }

    fn item(id: &str, text: &str) -> TimelineItem {
        TimelineItem::AssistantMessage {
            id: id.into(),
            text: text.into(),
        }
    }

    /// A store whose single workspace, `w1`, is a throwaway directory. Sessions
    /// live inside their workspace, so a test has to say which one that is.
    fn test_store(workspace_root: &std::path::Path) -> Store {
        let homes = crate::session::WorkspaceHomes::default();
        homes.attach("w1", workspace_root);
        Store::new(homes)
    }

    /// A manager over a throwaway directory. Neither rename nor delete asks the
    /// registry anything, so an empty one is enough to exercise both.
    fn manager(root: &std::path::Path) -> SessionManager {
        SessionManager::new(
            test_store(root),
            Arc::new(Registry::new(&std::collections::BTreeMap::new())),
            16,
        )
    }

    /// An agent whose past threads are gone: it starts fresh, and refuses to
    /// resume anything. Stands in for a CLI that pruned its own thread store,
    /// or a project copied to a machine that never had those threads.
    struct Amnesiac;

    struct ContextRecorder(Arc<std::sync::Mutex<Option<String>>>);

    struct Blank(tokio::sync::broadcast::Sender<SessionEvent>);

    struct ForkHarness {
        id: &'static str,
        native_fork: bool,
        prompts: Arc<std::sync::Mutex<Vec<PromptInput>>>,
        starts: Arc<std::sync::Mutex<Vec<Option<PersistHandle>>>>,
    }

    struct ForkHarnessSession {
        id: &'static str,
        native_fork: bool,
        prompts: Arc<std::sync::Mutex<Vec<PromptInput>>>,
        events: tokio::sync::broadcast::Sender<SessionEvent>,
    }

    struct ImportHarness;

    #[async_trait::async_trait]
    impl crate::adapter::AgentAdapter for ImportHarness {
        fn id(&self) -> &str {
            "historian"
        }

        fn label(&self) -> &str {
            "Historian"
        }

        fn capabilities(&self) -> genehub_proto::Capabilities {
            genehub_proto::Capabilities {
                resume: true,
                ..Default::default()
            }
        }

        async fn probe(&self) -> genehub_proto::ProbeState {
            genehub_proto::ProbeState::Ready
        }

        async fn catalog(&self, _providers: &ProviderMap) -> genehub_proto::Catalog {
            Default::default()
        }

        async fn start(
            &self,
            _config: SessionConfig,
        ) -> Result<Box<dyn crate::adapter::AgentSession>> {
            anyhow::bail!("not needed by the import test")
        }

        async fn list_import_candidates(
            &self,
            _cwd: &std::path::Path,
            _limit: usize,
        ) -> Result<Option<Vec<crate::adapter::ImportCandidate>>> {
            Ok(Some(vec![crate::adapter::ImportCandidate {
                source_id: "native-secret-42".into(),
                title: "Imported work".into(),
                preview: "first prompt".into(),
                updated_at_ms: 20,
                continuation: ImportContinuation::Native,
            }]))
        }

        async fn import_history(
            &self,
            _cwd: &std::path::Path,
            source_id: &str,
        ) -> Result<crate::adapter::ImportedHistory> {
            assert_eq!(source_id, "native-secret-42");
            Ok(crate::adapter::ImportedHistory {
                title: Some("Imported work".into()),
                created_at_ms: 10,
                updated_at_ms: 20,
                items: vec![TimelineItem::UserMessage {
                    id: "import-user".into(),
                    text: "first prompt".into(),
                    attachments: Vec::new(),
                }],
                persist: Some(PersistHandle {
                    agent_id: "historian".into(),
                    value: serde_json::json!({ "sessionId": source_id }),
                }),
                continuation: ImportContinuation::Native,
                warnings: Vec::new(),
            })
        }
    }

    #[async_trait::async_trait]
    impl crate::adapter::AgentAdapter for Amnesiac {
        fn id(&self) -> &str {
            "amnesiac"
        }

        fn label(&self) -> &str {
            "Amnesiac"
        }

        fn capabilities(&self) -> genehub_proto::Capabilities {
            genehub_proto::Capabilities {
                interrupt: false,
                set_model: false,
                set_effort: false,
                set_mode: false,
                permissions: false,
                resume: true,
                fork: false,
                attachments: false,
            }
        }

        async fn probe(&self) -> genehub_proto::ProbeState {
            genehub_proto::ProbeState::Ready
        }

        async fn catalog(&self, _providers: &ProviderMap) -> genehub_proto::Catalog {
            genehub_proto::Catalog {
                models: Vec::new(),
                modes: Vec::new(),
                commands: Vec::new(),
                runtime_axes: None,
                default_model: None,
                default_mode: None,
                default_effort: None,
            }
        }

        async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
            if config.resume.is_some() {
                return Err(anyhow!("no such thread"));
            }
            Ok(Box::new(Blank(tokio::sync::broadcast::channel(8).0)))
        }
    }

    #[async_trait::async_trait]
    impl crate::adapter::AgentAdapter for ContextRecorder {
        fn id(&self) -> &str {
            "recorder"
        }

        fn label(&self) -> &str {
            "Recorder"
        }

        fn capabilities(&self) -> genehub_proto::Capabilities {
            genehub_proto::Capabilities::default()
        }

        async fn probe(&self) -> genehub_proto::ProbeState {
            genehub_proto::ProbeState::Ready
        }

        async fn catalog(&self, _providers: &ProviderMap) -> genehub_proto::Catalog {
            genehub_proto::Catalog::default()
        }

        async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
            *self.0.lock().unwrap() = config.additional_system_prompt;
            Ok(Box::new(Blank(tokio::sync::broadcast::channel(8).0)))
        }
    }

    #[async_trait::async_trait]
    impl AgentSession for Blank {
        fn events(&self) -> tokio::sync::broadcast::Receiver<SessionEvent> {
            self.0.subscribe()
        }

        async fn send(&self, _input: PromptInput) -> Result<String> {
            Ok("t1".into())
        }

        async fn interrupt(&self) -> Result<()> {
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            Ok(())
        }

        async fn set_model(&self, _model_id: &str) -> Result<()> {
            Ok(())
        }

        async fn set_mode(&self, _mode_id: &str) -> Result<()> {
            Ok(())
        }

        async fn respond_permission(
            &self,
            _request_id: &str,
            _outcome: genehub_proto::PermissionOutcome,
        ) -> Result<()> {
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl crate::adapter::AgentAdapter for ForkHarness {
        fn id(&self) -> &str {
            self.id
        }

        fn label(&self) -> &str {
            self.id
        }

        fn capabilities(&self) -> genehub_proto::Capabilities {
            genehub_proto::Capabilities {
                fork: self.native_fork,
                ..Default::default()
            }
        }

        async fn probe(&self) -> genehub_proto::ProbeState {
            genehub_proto::ProbeState::Ready
        }

        async fn catalog(&self, _providers: &ProviderMap) -> genehub_proto::Catalog {
            genehub_proto::Catalog {
                models: vec![genehub_proto::ModelInfo {
                    id: "model".into(),
                    label: "Model".into(),
                    context_window: Some(10_000),
                    reasoning: true,
                    efforts: Vec::new(),
                }],
                modes: Vec::new(),
                commands: Vec::new(),
                runtime_axes: None,
                default_model: Some("model".into()),
                default_mode: None,
                default_effort: None,
            }
        }

        async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
            self.starts.lock().unwrap().push(config.resume);
            Ok(Box::new(ForkHarnessSession {
                id: self.id,
                native_fork: self.native_fork,
                prompts: self.prompts.clone(),
                events: tokio::sync::broadcast::channel(8).0,
            }))
        }
    }

    #[async_trait::async_trait]
    impl AgentSession for ForkHarnessSession {
        fn events(&self) -> tokio::sync::broadcast::Receiver<SessionEvent> {
            self.events.subscribe()
        }

        async fn send(&self, input: PromptInput) -> Result<String> {
            self.prompts.lock().unwrap().push(input);
            Ok(format!("turn-{}", self.prompts.lock().unwrap().len()))
        }

        async fn interrupt(&self) -> Result<()> {
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            Ok(())
        }

        async fn set_model(&self, _model_id: &str) -> Result<()> {
            Ok(())
        }

        async fn set_mode(&self, _mode_id: &str) -> Result<()> {
            Ok(())
        }

        async fn fork(&self, checkpoint: &str) -> Result<PersistHandle> {
            if !self.native_fork {
                anyhow::bail!("native fork disabled");
            }
            Ok(PersistHandle {
                agent_id: self.id.into(),
                value: serde_json::json!({ "checkpoint": checkpoint }),
            })
        }

        async fn respond_permission(
            &self,
            _request_id: &str,
            _outcome: genehub_proto::PermissionOutcome,
        ) -> Result<()> {
            Ok(())
        }
    }

    fn completed_turn(checkpoint: Option<&str>) -> Vec<TimelineItem> {
        vec![
            TimelineItem::UserMessage {
                id: "user-1".into(),
                text: "Investigate the failing deploy".into(),
                attachments: Vec::new(),
            },
            TimelineItem::AssistantMessage {
                id: "assistant-1".into(),
                text: "The health check path is stale".into(),
            },
            TimelineItem::TurnSummary {
                id: "summary-1".into(),
                stats: TurnStats {
                    turn_id: "source-turn".into(),
                    outcome: TurnOutcome::Completed,
                    started_at_ms: 1,
                    finished_at_ms: 2,
                    duration_ms: 1,
                    usage: Usage::default(),
                    tool_calls: 3,
                    fork_checkpoint: checkpoint.map(str::to_string),
                },
            },
        ]
    }

    #[tokio::test]
    async fn cross_agent_fork_uses_a_bounded_seed_without_reusing_the_source_handle() {
        let dir = tempfile::tempdir().unwrap();
        let source_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let source_starts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let target_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let target_starts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![
                Arc::new(ForkHarness {
                    id: "source",
                    native_fork: true,
                    prompts: source_prompts.clone(),
                    starts: source_starts.clone(),
                }),
                Arc::new(ForkHarness {
                    id: "target",
                    native_fork: false,
                    prompts: target_prompts.clone(),
                    starts: target_starts.clone(),
                }),
            ])),
            16,
        );
        let source = sessions
            .create(
                "w1",
                dir.path().to_path_buf(),
                "source",
                None,
                None,
                Default::default(),
                Some("Deploy".into()),
            )
            .await
            .unwrap();
        let source_live = sessions.live(&source.id).await.unwrap();
        let inherited = completed_turn(Some("native-checkpoint"));
        *source_live.items.lock().await = inherited.clone();
        sessions
            .store
            .append_chat_items("w1", &source.id, &inherited)
            .unwrap();

        let inspection = sessions.inspect(&source.id, None).await.unwrap();
        assert_eq!(inspection.narrative_item_count, 3);
        assert_eq!(inspection.coverage.omitted_item_count, 0);
        assert!(inspection.layers.iter().any(|layer| layer == "blobs"));
        let exact = sessions
            .narrative_page(&source.id, None, Some("assistant-1"), None, Some(1))
            .await
            .unwrap();
        assert_eq!(exact.items.len(), 1);
        let context = sessions
            .session_context(&source.id, None, Some(2_048))
            .await
            .unwrap();
        assert!(context.text.contains("ghref:item"));
        assert!(context
            .retrieval_commands
            .iter()
            .any(|command| command.contains("session narrative")));
        assert!(!context.references.is_empty());

        let fork = sessions
            .fork(
                &source.id,
                "source-turn",
                Some(ForkTarget {
                    agent_id: "target".into(),
                    workspace_id: None,
                    model_id: None,
                    mode_id: None,
                    effort_id: None,
                }),
                &ProviderMap::new(),
            )
            .await
            .unwrap();
        assert_eq!(fork.agent_id, "target");
        let lineage = fork.lineage.as_ref().unwrap();
        assert_eq!(lineage.method, ForkMethod::ReconstructedContext);
        assert!(lineage.context.as_ref().unwrap().token_budget <= 3_500);
        let meta = sessions.store.load_meta("w1", &fork.id).unwrap();
        assert!(
            meta.persist.is_none(),
            "a cross-Agent handle must never leak"
        );
        assert_eq!(
            sessions
                .store
                .load_seed("w1", &fork.id)
                .unwrap()
                .unwrap()
                .state,
            ContextSeedState::Pending
        );

        sessions
            .send(
                &fork.id,
                "Continue with the fix".into(),
                Vec::new(),
                &ProviderMap::new(),
                None,
                None,
            )
            .await
            .unwrap();
        {
            let prompts = target_prompts.lock().unwrap();
            assert_eq!(prompts.len(), 1);
            assert!(prompts[0].text.contains("Investigate the failing deploy"));
            assert!(prompts[0].text.contains("<current-user-message>"));
            assert!(prompts[0].text.contains("Continue with the fix"));
        }
        assert_eq!(target_starts.lock().unwrap().as_slice(), &[None]);
        assert!(source_starts.lock().unwrap().is_empty());
        assert!(source_prompts.lock().unwrap().is_empty());
        assert_eq!(
            sessions
                .store
                .load_seed("w1", &fork.id)
                .unwrap()
                .unwrap()
                .state,
            ContextSeedState::Applied
        );
        let stored = sessions.store.load_chat("w1", &fork.id).unwrap();
        assert!(stored.items.iter().any(|item| {
            matches!(item, TimelineItem::UserMessage { text, .. } if text == "Continue with the fix")
        }));
        assert!(!stored.items.iter().any(|item| {
            matches!(item, TimelineItem::UserMessage { text, .. } if text.contains("genehub-chat-history"))
        }));

        // The capsule is a one-time bootstrap. Later turns go to the target
        // Agent as ordinary user messages and cannot pay the history cost a
        // second time.
        let fork_live = sessions.live(&fork.id).await.unwrap();
        *fork_live.status.lock().await = SessionStatus::Idle;
        sessions
            .send(
                &fork.id,
                "Run the focused test".into(),
                Vec::new(),
                &ProviderMap::new(),
                None,
                None,
            )
            .await
            .unwrap();
        let prompts = target_prompts.lock().unwrap();
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[1].text, "Run the focused test");
    }

    #[tokio::test]
    async fn portable_fork_moves_visible_history_to_a_validated_workspace_without_a_checkpoint() {
        let source_dir = tempfile::tempdir().unwrap();
        let source = SessionManager::new(
            test_store(source_dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ForkHarness {
                id: "source",
                native_fork: true,
                prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
                starts: Arc::new(std::sync::Mutex::new(Vec::new())),
            })])),
            16,
        );
        let summary = source
            .create(
                "w1",
                source_dir.path().to_path_buf(),
                "source",
                None,
                None,
                Default::default(),
                Some("Portable".into()),
            )
            .await
            .unwrap();
        let live = source.live(&summary.id).await.unwrap();
        let mut source_items = completed_turn(Some("source-machine-secret"));
        if let TimelineItem::UserMessage { attachments, .. } = &mut source_items[0] {
            attachments.push(Attachment {
                name: "screen.png".into(),
                mime: "image/png".into(),
                path: Some("/source/private/screen.png".into()),
                data_base64: Some("aW1hZ2U=".into()),
            });
        }
        *live.items.lock().await = source_items;

        let transfer = source
            .fork_export(&summary.id, "source-turn")
            .await
            .unwrap();
        assert!(matches!(
            transfer.items.last(),
            Some(TimelineItem::TurnSummary { stats, .. }) if stats.fork_checkpoint.is_none()
        ));
        assert!(matches!(
            transfer.items.first(),
            Some(TimelineItem::UserMessage { attachments, .. })
                if attachments[0].path.is_none() && attachments[0].data_base64.is_some()
        ));

        let target_dir = tempfile::tempdir().unwrap();
        let target_homes = crate::session::WorkspaceHomes::default();
        target_homes.attach("target-workspace", target_dir.path());
        let target = SessionManager::new(
            Store::new(target_homes),
            Arc::new(Registry::of(vec![Arc::new(ForkHarness {
                id: "target",
                native_fork: true,
                prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
                starts: Arc::new(std::sync::Mutex::new(Vec::new())),
            })])),
            16,
        );
        let mismatch = target
            .fork_import(
                "other-workspace",
                target_dir.path().to_path_buf(),
                transfer.clone(),
                ForkTarget {
                    agent_id: "target".into(),
                    workspace_id: Some("target-workspace".into()),
                    model_id: None,
                    mode_id: None,
                    effort_id: None,
                },
                &ProviderMap::new(),
                false,
            )
            .await
            .unwrap_err();
        assert!(mismatch.to_string().contains("validated workspace"));

        let forked = target
            .fork_import(
                "target-workspace",
                target_dir.path().to_path_buf(),
                transfer,
                ForkTarget {
                    agent_id: "target".into(),
                    workspace_id: Some("target-workspace".into()),
                    model_id: None,
                    mode_id: None,
                    effort_id: None,
                },
                &ProviderMap::new(),
                false,
            )
            .await
            .unwrap();
        assert_eq!(forked.workspace_id, "target-workspace");
        assert_eq!(forked.agent_id, "target");
        assert_eq!(
            forked.lineage.as_ref().unwrap().method,
            ForkMethod::ReconstructedContext
        );
        let meta = target
            .store
            .load_meta("target-workspace", &forked.id)
            .unwrap();
        assert!(meta.persist.is_none());
        let seed = target
            .store
            .load_seed("target-workspace", &forked.id)
            .unwrap()
            .unwrap();
        assert!(seed.text.contains("remains on another machine"));
        assert!(!seed.text.contains("genet session inspect"));
        assert!(target
            .store
            .load_chat("target-workspace", &forked.id)
            .unwrap()
            .items
            .iter()
            .all(|item| !matches!(
                item,
                TimelineItem::TurnSummary { stats, .. } if stats.fork_checkpoint.is_some()
            )));
    }

    #[tokio::test]
    async fn same_agent_with_a_checkpoint_keeps_the_native_fork_path() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ForkHarness {
                id: "source",
                native_fork: true,
                prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
                starts: starts.clone(),
            })])),
            16,
        );
        let source = sessions
            .create(
                "w1",
                dir.path().to_path_buf(),
                "source",
                Some("model".into()),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let source_live = sessions.live(&source.id).await.unwrap();
        *source_live.items.lock().await = completed_turn(Some("native-checkpoint"));

        let fork = sessions
            .fork(
                &source.id,
                "source-turn",
                Some(ForkTarget {
                    agent_id: "source".into(),
                    workspace_id: None,
                    model_id: None,
                    mode_id: None,
                    effort_id: None,
                }),
                &ProviderMap::new(),
            )
            .await
            .unwrap();
        assert_eq!(fork.lineage.unwrap().method, ForkMethod::NativeCheckpoint);
        let meta = sessions.store.load_meta("w1", &fork.id).unwrap();
        assert_eq!(meta.persist.as_ref().unwrap().agent_id, "source");
        assert!(sessions.store.load_seed("w1", &fork.id).unwrap().is_none());
        assert_eq!(starts.lock().unwrap().as_slice(), &[None]);
    }

    #[tokio::test]
    async fn a_cross_channel_fork_reconstructs_when_the_source_session_is_owned() {
        let dir = tempfile::tempdir().unwrap();
        let holder = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ForkHarness {
                id: "source",
                native_fork: true,
                prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
                starts: Arc::new(std::sync::Mutex::new(Vec::new())),
            })])),
            16,
        );
        let source = holder
            .create(
                "w1",
                dir.path().to_path_buf(),
                "source",
                Some("model".into()),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let inherited = completed_turn(Some("native-checkpoint"));
        holder
            .store
            .append_chat_items("w1", &source.id, &inherited)
            .unwrap();

        let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let other = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ForkHarness {
                id: "source",
                native_fork: true,
                prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
                starts: starts.clone(),
            })])),
            16,
        );
        other.list(None, false).await.unwrap();
        let fork = other
            .fork(&source.id, "source-turn", None, &ProviderMap::new())
            .await
            .unwrap();

        assert_eq!(
            fork.lineage.unwrap().method,
            ForkMethod::ReconstructedContext
        );
        assert!(other.store.load_seed("w1", &fork.id).unwrap().is_some());
        assert!(starts.lock().unwrap().is_empty());
        holder
            .store
            .save_meta(&holder.store.load_meta("w1", &source.id).unwrap())
            .unwrap();
    }

    #[tokio::test]
    async fn explicit_same_agent_without_a_checkpoint_reconstructs_but_legacy_fork_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ForkHarness {
                id: "source",
                native_fork: true,
                prompts: Arc::new(std::sync::Mutex::new(Vec::new())),
                starts: Arc::new(std::sync::Mutex::new(Vec::new())),
            })])),
            16,
        );
        let source = sessions
            .create(
                "w1",
                dir.path().to_path_buf(),
                "source",
                Some("model".into()),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let source_live = sessions.live(&source.id).await.unwrap();
        *source_live.items.lock().await = completed_turn(None);

        let fork = sessions
            .fork(
                &source.id,
                "source-turn",
                Some(ForkTarget {
                    agent_id: "source".into(),
                    workspace_id: None,
                    model_id: None,
                    mode_id: None,
                    effort_id: None,
                }),
                &ProviderMap::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            fork.lineage.unwrap().method,
            ForkMethod::ReconstructedContext
        );
        assert!(sessions.store.load_seed("w1", &fork.id).unwrap().is_some());

        let error = sessions
            .fork(&source.id, "source-turn", None, &ProviderMap::new())
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("that turn has no Agent fork checkpoint"));
    }

    #[tokio::test]
    async fn import_discovery_is_opaque_two_stage_and_filters_durable_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ImportHarness)])),
            16,
        );

        let listing = sessions
            .list_imports("w1", dir.path().to_path_buf(), Some(20))
            .await
            .unwrap();
        let candidate = &listing.sources[0].candidates[0];
        assert!(candidate.candidate_id.starts_with("ic_"));
        assert!(
            !serde_json::to_string(&listing)
                .unwrap()
                .contains("native-secret-42"),
            "a provider handle crossed the RPC boundary"
        );

        let imported = sessions
            .import("w1", dir.path().to_path_buf(), &candidate.candidate_id)
            .await
            .unwrap();
        assert_eq!(imported.agent_id, "historian");
        assert_eq!(
            imported.imported.as_ref().unwrap().continuation,
            ImportContinuation::Native
        );
        let coverage = imported
            .imported
            .as_ref()
            .and_then(|origin| origin.coverage.as_ref())
            .expect("new imports report structured coverage");
        assert_eq!(coverage.source_item_count, Some(1));
        assert_eq!(coverage.retained_item_count, 1);
        assert_eq!(coverage.omitted_item_count, 0);
        assert_eq!(coverage.retrieval, RetrievalCapability::Genehub);
        assert_eq!(
            sessions.snapshot(&imported.id).await.unwrap().items.len(),
            1
        );

        let refreshed = sessions
            .list_imports("w1", dir.path().to_path_buf(), Some(20))
            .await
            .unwrap();
        assert!(refreshed.sources[0].candidates.is_empty());
        assert_eq!(refreshed.filtered_duplicates, 1);
    }

    #[test]
    fn oversized_imports_keep_a_bounded_recent_window_that_can_fit_one_rpc() {
        let items = (0..(IMPORT_VISIBLE_ITEMS + 100))
            .map(|index| TimelineItem::AssistantMessage {
                id: format!("i-{index}"),
                text: "reply".into(),
            })
            .collect();
        let (bounded, omitted, altered) = bound_imported_items(items);
        assert_eq!(omitted, 100);
        assert_eq!(altered, 0);
        assert!(matches!(
            bounded.first(),
            Some(TimelineItem::Compaction { .. })
        ));
        assert!(bounded.len() <= IMPORT_VISIBLE_ITEMS + 1);

        let huge = vec![TimelineItem::AssistantMessage {
            id: "huge".into(),
            text: "四".repeat(IMPORT_VISIBLE_BYTES),
        }];
        let (bounded, omitted, altered) = bound_imported_items(huge);
        assert_eq!((omitted, altered), (0, 1));
        assert!(serde_json::to_vec(&bounded).unwrap().len() < IMPORT_VISIBLE_BYTES);

        let huge_tool = vec![TimelineItem::ToolCall {
            id: "huge-tool".into(),
            name: "external".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Unknown {
                raw: serde_json::json!({ "payload": "x".repeat(IMPORT_VISIBLE_BYTES * 2) }),
            },
        }];
        let (bounded, omitted, altered) = bound_imported_items(huge_tool);
        assert_eq!((omitted, altered), (0, 1));
        assert!(matches!(
            bounded.first(),
            Some(TimelineItem::Compaction { reason, .. })
                if reason.contains("单条历史记录过长")
        ));
        assert!(serde_json::to_vec(&bounded).unwrap().len() < IMPORT_VISIBLE_BYTES);
    }

    #[tokio::test]
    async fn an_agent_that_cannot_resume_starts_over_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(Amnesiac)])),
            16,
        );
        let stale = PersistHandle {
            agent_id: "amnesiac".into(),
            value: serde_json::json!({ "threadId": "gone" }),
        };
        sessions
            .store
            .save_meta(&SessionMeta {
                agent_id: "amnesiac".into(),
                persist: Some(stale),
                ..meta()
            })
            .unwrap();

        let live = sessions.live("s1").await.unwrap();
        sessions
            .ensure_started(&live, &ProviderMap::new())
            .await
            .expect("a conversation whose thread is gone is stranded for good");

        let told = live
            .items
            .lock()
            .await
            .iter()
            .any(|item| matches!(item, TimelineItem::Error { message, .. } if message.contains("Amnesiac")));
        assert!(
            told,
            "the agent answers with no memory of the conversation above and nothing says why"
        );
        assert_eq!(
            sessions.store.load_meta("w1", "s1").unwrap().persist,
            None,
            "a handle that just failed to resume names a thread that is gone"
        );
    }

    #[tokio::test]
    async fn browser_preview_url_prefix_is_not_injected_but_path_guidance_is() {
        let dir = tempfile::tempdir().unwrap();
        let captured = Arc::new(std::sync::Mutex::new(None));
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ContextRecorder(
                captured.clone(),
            ))])),
            16,
        );
        sessions
            .store
            .save_meta(&SessionMeta {
                agent_id: "recorder".into(),
                ..meta()
            })
            .unwrap();
        let base = "https://app.example/relay-dev-2/assets/preview/v2/m_device/w1/r_project/";

        sessions
            .send(
                "s1",
                "生成报告".into(),
                vec![],
                &ProviderMap::new(),
                Some(base.into()),
                None,
            )
            .await
            .unwrap();

        let prompt = captured.lock().unwrap().clone();
        let prompt = prompt.expect("path-linking guidance should reach the adapter");
        assert!(
            !prompt.contains(base),
            "deployment-bound Preview prefixes must not become Agent system guidance"
        );
        assert!(
            prompt.contains("index.html") && prompt.contains("Never link a directory"),
            "Agents still need file-path linking rules, especially HTML entry files"
        );
        assert!(
            !prompt.contains("available_skills"),
            "unit tests without a skills dir must not invent a Skill catalog"
        );
        sessions.shutdown().await;
    }

    #[tokio::test]
    async fn daemon_skills_are_injected_into_every_adapter_system_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        let captured = Arc::new(std::sync::Mutex::new(None));
        let sessions = SessionManager::new(
            test_store(dir.path()),
            Arc::new(Registry::of(vec![Arc::new(ContextRecorder(
                captured.clone(),
            ))])),
            16,
        )
        .with_builtin_skills(skills.path(), Some(PathBuf::from("/opt/genehub/genet-dev")));
        sessions
            .store
            .save_meta(&SessionMeta {
                agent_id: "recorder".into(),
                ..meta()
            })
            .unwrap();

        sessions
            .send(
                "s1",
                "查一下上一轮会话".into(),
                vec![],
                &ProviderMap::new(),
                None,
                None,
            )
            .await
            .unwrap();

        let prompt = captured.lock().unwrap().clone().expect("catalog");
        assert!(prompt.contains("index.html"));
        assert!(prompt.contains("genehub-session-history"));
        assert!(prompt.contains("genehub-speech-runtime"));
        assert!(prompt.contains("/opt/genehub/genet-dev"));
        assert!(prompt.contains("<available_skills>"));
        assert!(prompt.contains("<location>"));
        sessions.shutdown().await;
    }

    /// A `Live` with its own throwaway store. The directory handle comes back
    /// with it so the caller keeps it alive for the length of the test.
    fn live_session(meta: SessionMeta) -> (Arc<Live>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let live = Arc::new(Live::new(meta, test_store(dir.path())));
        (live, dir)
    }

    #[tokio::test]
    async fn a_renamed_session_keeps_the_name_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();

        let summary = sessions.rename("s1", "  收尾发布  ").await.unwrap();

        assert_eq!(summary.title.as_deref(), Some("收尾发布"));
        assert_eq!(
            sessions
                .store
                .load_meta("w1", "s1")
                .unwrap()
                .title
                .as_deref(),
            Some("收尾发布"),
            "the new name only reached the copy in memory, so it is lost on restart"
        );
    }

    #[tokio::test]
    async fn a_session_cannot_be_renamed_to_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();

        assert!(
            sessions.rename("s1", "   ").await.is_err(),
            "a blank name is a row with nothing on it, and no way back to a real one"
        );
    }

    #[tokio::test]
    async fn a_renamed_session_is_not_renamed_again_by_its_first_message() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();
        sessions.rename("s1", "我起的名字").await.unwrap();

        // The condition `send` uses before naming a session from what was said.
        let named = sessions
            .live("s1")
            .await
            .unwrap()
            .meta
            .lock()
            .await
            .title
            .is_some();

        assert!(
            named,
            "the daemon would overwrite the user's title with the first message"
        );
    }

    #[tokio::test]
    async fn deleting_a_session_takes_its_timeline_and_scratch_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();
        sessions
            .store
            .append_chat_items("w1", "s1", &[item("a", "hi")])
            .unwrap();
        let scratch = sessions.store.scratch_dir("w1", "s1").unwrap();
        std::fs::create_dir_all(&scratch).unwrap();

        sessions.delete("s1").await.unwrap();

        assert!(sessions.store.list_meta().unwrap().is_empty());
        assert!(sessions.store.load_chat("w1", "s1").is_err());
        assert!(
            !scratch.exists(),
            "the agent's own copy of the conversation outlived the delete"
        );
        assert!(dir.path().join(".genethub/tombstones/s1.json").is_file());
    }

    #[tokio::test]
    async fn deleting_a_session_twice_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();

        sessions.delete("s1").await.unwrap();

        assert!(
            sessions.delete("s1").await.is_ok(),
            "two windows deleting the same row would show the second one an error"
        );
    }

    #[tokio::test]
    async fn a_tombstone_hides_residual_files_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();
        let saved = std::fs::read(dir.path().join(".genethub/sessions/s1/meta.json")).unwrap();

        sessions.delete("s1").await.unwrap();
        let residual = dir.path().join(".genethub/sessions/s1");
        std::fs::create_dir_all(&residual).unwrap();
        std::fs::write(residual.join("meta.json"), saved).unwrap();

        let restarted = manager(dir.path());
        assert!(restarted.list(None, false).await.unwrap().is_empty());
        let refused = restarted.store.save_meta(&meta()).unwrap_err();
        assert!(
            refused
                .downcast_ref::<super::store::SessionDeleted>()
                .is_some(),
            "a physically residual deleted session could be resurrected: {refused}"
        );
        restarted.delete("s1").await.unwrap();
        assert!(!residual.exists(), "retry did not collect residual files");
    }

    #[tokio::test]
    async fn tombstone_cleanup_waits_for_a_legacy_workspace_writer() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();
        let saved = std::fs::read(dir.path().join(".genethub/sessions/s1/meta.json")).unwrap();
        sessions.delete("s1").await.unwrap();
        drop(sessions);

        let residual = dir.path().join(".genethub/sessions/s1");
        std::fs::create_dir_all(&residual).unwrap();
        std::fs::write(residual.join("meta.json"), saved).unwrap();
        let legacy = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.path().join(".genethub/owner.lock"))
            .unwrap();
        // Dropping the manager releases its locks asynchronously because the
        // event pump owns a final Store clone. Under the full parallel suite
        // that task may need a scheduler turn before the legacy writer can
        // take over, so exercise the real retry boundary instead of racing it.
        let mut locked = false;
        for _ in 0..40 {
            match crate::fs_lock::try_lock_exclusive(
                &legacy,
                &dir.path().join(".genethub/owner.lock"),
            ) {
                Ok(()) => {
                    locked = true;
                    break;
                }
                Err(error) if crate::lifecycle::lock_contended(&error) => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(error) => panic!("locking the legacy writer failed: {error}"),
            }
        }
        assert!(
            locked,
            "the dropped manager did not release its legacy lock"
        );

        let restarted = manager(dir.path());
        assert!(restarted.list(None, false).await.unwrap().is_empty());
        assert!(residual.exists(), "cleanup raced the legacy writer");
        drop(legacy);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        while residual.exists() && tokio::time::Instant::now() < deadline {
            restarted.list(None, false).await.unwrap();
            if residual.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
        assert!(
            !residual.exists(),
            "cleanup did not resume after the legacy writer left"
        );
    }

    #[tokio::test]
    async fn an_item_is_upserted_rather_than_duplicated() {
        let (live, _store_dir) = live_session(meta());
        apply(
            &live,
            &SessionEvent::Item {
                turn_id: "t".into(),
                item: item("a", ""),
            },
        )
        .await;
        apply(
            &live,
            &SessionEvent::Item {
                turn_id: "t".into(),
                item: item("a", "final"),
            },
        )
        .await;

        let items = live.items.lock().await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0], item("a", "final"));
    }

    #[tokio::test]
    async fn text_deltas_accumulate_onto_the_open_item() {
        let (live, _store_dir) = live_session(meta());
        apply(
            &live,
            &SessionEvent::Item {
                turn_id: "t".into(),
                item: item("a", ""),
            },
        )
        .await;
        for delta in ["he", "llo"] {
            apply(
                &live,
                &SessionEvent::ItemDelta {
                    turn_id: "t".into(),
                    item_id: "a".into(),
                    delta: ItemDelta::Text {
                        delta: delta.into(),
                    },
                },
            )
            .await;
        }
        assert_eq!(live.items.lock().await[0], item("a", "hello"));
    }

    #[tokio::test]
    async fn a_delta_for_an_unknown_item_is_dropped_not_invented() {
        let (live, _store_dir) = live_session(meta());
        apply(
            &live,
            &SessionEvent::ItemDelta {
                turn_id: "t".into(),
                item_id: "ghost".into(),
                delta: ItemDelta::Text { delta: "x".into() },
            },
        )
        .await;
        assert!(live.items.lock().await.is_empty());
    }

    #[tokio::test]
    async fn tool_status_deltas_update_status_and_detail_in_place() {
        let (live, _store_dir) = live_session(meta());
        apply(
            &live,
            &SessionEvent::Item {
                turn_id: "t".into(),
                item: TimelineItem::ToolCall {
                    id: "c".into(),
                    name: "bash".into(),
                    status: ToolStatus::Pending,
                    detail: ToolCallDetail::Shell {
                        command: "ls".into(),
                        output: String::new(),
                        exit_code: None,
                    },
                },
            },
        )
        .await;
        apply(
            &live,
            &SessionEvent::ItemDelta {
                turn_id: "t".into(),
                item_id: "c".into(),
                delta: ItemDelta::ToolStatus {
                    status: ToolStatus::Running,
                    detail: None,
                },
            },
        )
        .await;
        let settled = live.items.lock().await[0].clone();
        match &settled {
            TimelineItem::ToolCall { status, detail, .. } => {
                assert_eq!(*status, ToolStatus::Running);
                assert!(matches!(detail, ToolCallDetail::Shell { command, .. } if command == "ls"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn sequence_numbers_are_dense_and_start_at_one() {
        let (live, _store_dir) = live_session(meta());
        for index in 1..=3 {
            let event = live
                .publish(SessionEvent::TurnStarted {
                    turn_id: "t".into(),
                    started_at_ms: 1,
                })
                .await;
            assert_eq!(event.seq, index);
        }
    }

    #[tokio::test]
    async fn pending_permissions_appear_in_the_snapshot_and_clear_on_answer() {
        let (live, _store_dir) = live_session(meta());
        let request = PermissionRequest {
            id: "p1".into(),
            kind: PermissionRequestKind::Permission,
            title: "Write file".into(),
            detail: None,
            tool_call_id: None,
            options: vec![],
            questions: None,
        };
        apply(
            &live,
            &SessionEvent::PermissionRequested {
                request: request.clone(),
            },
        )
        .await;
        assert_eq!(live.snapshot().await.unwrap().pending_permissions.len(), 1);
        assert_eq!(*live.status.lock().await, SessionStatus::Waiting);

        apply(
            &live,
            &SessionEvent::PermissionResolved {
                request_id: "p1".into(),
                outcome: PermissionOutcome::Canceled,
            },
        )
        .await;
        assert!(live
            .snapshot()
            .await
            .unwrap()
            .pending_permissions
            .is_empty());
        assert_eq!(*live.status.lock().await, SessionStatus::Idle);
    }

    #[tokio::test]
    async fn a_new_interaction_replaces_a_stale_one() {
        let (live, _store_dir) = live_session(meta());
        for id in ["p1", "p2"] {
            apply(
                &live,
                &SessionEvent::PermissionRequested {
                    request: PermissionRequest {
                        id: id.into(),
                        kind: PermissionRequestKind::Permission,
                        title: "Approval".into(),
                        detail: None,
                        tool_call_id: None,
                        options: vec![],
                        questions: None,
                    },
                },
            )
            .await;
        }

        apply(
            &live,
            &SessionEvent::PermissionResolved {
                request_id: "p1".into(),
                outcome: PermissionOutcome::Canceled,
            },
        )
        .await;

        let snapshot = live.snapshot().await.unwrap();
        assert_eq!(snapshot.pending_permissions.len(), 1);
        assert_eq!(snapshot.pending_permissions[0].id, "p2");
        assert_eq!(*live.status.lock().await, SessionStatus::Waiting);
    }

    fn interaction(kind: PermissionRequestKind) -> PermissionRequest {
        PermissionRequest {
            id: "p1".into(),
            kind,
            title: "Continue?".into(),
            detail: None,
            tool_call_id: None,
            options: vec![
                genehub_proto::PermissionOption {
                    id: "yes".into(),
                    label: "Yes".into(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                genehub_proto::PermissionOption {
                    id: "no".into(),
                    label: "No".into(),
                    kind: PermissionOptionKind::Reject,
                },
            ],
            questions: None,
        }
    }

    struct StoppingSession {
        events: broadcast::Sender<SessionEvent>,
        interrupted: Arc<std::sync::atomic::AtomicBool>,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait::async_trait]
    impl AgentSession for StoppingSession {
        fn events(&self) -> broadcast::Receiver<SessionEvent> {
            self.events.subscribe()
        }

        async fn send(&self, _input: PromptInput) -> Result<String> {
            anyhow::bail!("not used")
        }

        async fn interrupt(&self) -> Result<()> {
            self.interrupted
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn set_model(&self, _model_id: &str) -> Result<()> {
            anyhow::bail!("not used")
        }

        async fn set_mode(&self, _mode_id: &str) -> Result<()> {
            anyhow::bail!("not used")
        }

        async fn respond_permission(
            &self,
            _request_id: &str,
            _outcome: PermissionOutcome,
        ) -> Result<()> {
            anyhow::bail!("a stopped process is never answered in place")
        }

        fn persistence(&self) -> Option<crate::adapter::PersistHandle> {
            Some(crate::adapter::PersistHandle {
                agent_id: "fake".into(),
                value: serde_json::json!({ "sessionId": "native-1" }),
            })
        }
    }

    #[tokio::test]
    async fn an_interaction_is_persisted_before_the_agent_process_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path());
        let (live, _store_dir) = live_session(meta());
        let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (events, _) = broadcast::channel(1);
        *live.agent.lock().await = Some(Box::new(StoppingSession {
            events,
            interrupted: interrupted.clone(),
            closed: closed.clone(),
        }));
        let request = interaction(PermissionRequestKind::Permission);

        stop_agent_for_interaction(&live, &store, &request).await;

        assert!(live.agent.lock().await.is_none());
        assert!(interrupted.load(std::sync::atomic::Ordering::SeqCst));
        assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
        let restored = store.load_meta("w1", "s1").unwrap();
        assert_eq!(restored.pending_permission.unwrap().id, "p1");
        assert_eq!(
            restored.persist.unwrap().value["sessionId"],
            serde_json::json!("native-1")
        );
    }

    #[test]
    fn permission_grants_resume_elevated_but_rejections_do_not_resume() {
        let request = interaction(PermissionRequestKind::Permission);
        let grant = continuation_for(
            &request,
            &PermissionOutcome::Selected {
                option_id: "yes".into(),
            },
        )
        .unwrap()
        .expect("an allow option resumes");
        assert!(grant.elevated);
        assert!(grant.prompt.contains("Yes"));
        assert!(continuation_for(
            &request,
            &PermissionOutcome::Selected {
                option_id: "no".into(),
            },
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn answers_resume_without_changing_the_permission_mode() {
        let request = interaction(PermissionRequestKind::Question);
        let continuation = continuation_for(
            &request,
            &PermissionOutcome::Selected {
                option_id: "no".into(),
            },
        )
        .unwrap()
        .expect("a question answer resumes");
        assert!(!continuation.elevated);
        assert!(continuation.prompt.contains("No"));
    }

    #[test]
    fn structured_answers_all_survive_the_stop_and_resume_boundary() {
        let mut request = interaction(PermissionRequestKind::Question);
        request.questions = Some(vec![
            genehub_proto::InteractionQuestion {
                id: "environment".into(),
                prompt: "Where should this ship?".into(),
                allow_multiple: false,
                allow_freeform: false,
                options: vec![genehub_proto::InteractionOption {
                    id: "beta".into(),
                    label: "Beta".into(),
                }],
            },
            genehub_proto::InteractionQuestion {
                id: "note".into(),
                prompt: "Anything else?".into(),
                allow_multiple: false,
                allow_freeform: true,
                options: vec![],
            },
        ]);
        let continuation = continuation_for(
            &request,
            &PermissionOutcome::Answered {
                answers: vec![
                    genehub_proto::InteractionAnswer {
                        question_id: "environment".into(),
                        selected_option_ids: vec!["beta".into()],
                        freeform_text: None,
                    },
                    genehub_proto::InteractionAnswer {
                        question_id: "note".into(),
                        selected_option_ids: vec![],
                        freeform_text: Some("Keep the rollback switch".into()),
                    },
                ],
            },
        )
        .unwrap()
        .expect("complete answers resume");
        assert!(!continuation.elevated);
        assert!(continuation
            .prompt
            .contains("Where should this ship?: Beta"));
        assert!(continuation.prompt.contains("Keep the rollback switch"));
    }

    #[test]
    fn structured_answers_are_validated_at_the_daemon_boundary() {
        let mut request = interaction(PermissionRequestKind::Question);
        request.questions = Some(vec![genehub_proto::InteractionQuestion {
            id: "environment".into(),
            prompt: "Where should this ship?".into(),
            allow_multiple: false,
            allow_freeform: false,
            options: vec![
                genehub_proto::InteractionOption {
                    id: "beta".into(),
                    label: "Beta".into(),
                },
                genehub_proto::InteractionOption {
                    id: "official".into(),
                    label: "Official".into(),
                },
            ],
        }]);
        let outcome = |selected_option_ids, freeform_text| PermissionOutcome::Answered {
            answers: vec![genehub_proto::InteractionAnswer {
                question_id: "environment".into(),
                selected_option_ids,
                freeform_text,
            }],
        };

        assert!(continuation_for(
            &request,
            &outcome(vec!["beta".into(), "official".into()], None),
        )
        .err()
        .expect("multiple choices must be rejected")
        .to_string()
        .contains("only one option"));
        assert!(
            continuation_for(&request, &outcome(vec![], Some("somewhere else".into())),)
                .err()
                .expect("free-form input must be rejected")
                .to_string()
                .contains("does not accept a free-form answer")
        );
    }

    #[test]
    fn a_plan_only_resumes_after_explicit_approval() {
        let request = interaction(PermissionRequestKind::PlanApproval);
        assert!(continuation_for(
            &request,
            &PermissionOutcome::Selected {
                option_id: "no".into(),
            },
        )
        .unwrap()
        .is_none());
        let approved = continuation_for(
            &request,
            &PermissionOutcome::Selected {
                option_id: "yes".into(),
            },
        )
        .unwrap()
        .expect("approval resumes");
        assert!(!approved.elevated);
        assert!(approved.prompt.contains("Continue?"));
    }

    #[tokio::test]
    async fn mode_changes_cannot_bypass_a_waiting_interaction() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, _, _) = wired(dir.path()).await;
        let live = sessions.live("s1").await.unwrap();
        live.pending_permissions
            .lock()
            .await
            .push(interaction(PermissionRequestKind::Question));

        let error = sessions
            .set_mode("s1", "agent", &ProviderMap::new())
            .await
            .expect_err("the question must be resolved first");
        assert!(error.to_string().contains("pending Agent interaction"));
    }

    #[tokio::test]
    async fn a_persisted_interaction_rehydrates_as_waiting_without_an_agent() {
        let mut stored = meta();
        stored.pending_permission = Some(interaction(PermissionRequestKind::Permission));
        let (live, _store_dir) = live_session(stored);
        let live = &*live;
        let snapshot = live.snapshot().await.unwrap();
        assert_eq!(snapshot.summary.status, SessionStatus::Waiting);
        assert_eq!(snapshot.pending_permissions.len(), 1);
        assert!(live.agent.lock().await.is_none());
    }

    #[tokio::test]
    async fn a_failed_turn_stays_visible_as_failed_but_remains_retryable() {
        let (live, _store_dir) = live_session(meta());
        apply(
            &live,
            &SessionEvent::TurnFailed {
                turn_id: "t".into(),
                error: TurnError {
                    code: TurnErrorCode::RateLimited,
                    message: "slow down".into(),
                },
            },
        )
        .await;
        assert_eq!(*live.status.lock().await, SessionStatus::Failed);
    }

    #[tokio::test]
    async fn only_settled_non_prompt_items_are_written_at_the_end_of_a_turn() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path());
        let (live, _store_dir) = live_session(meta());

        for event in [
            SessionEvent::Item {
                turn_id: "t".into(),
                item: TimelineItem::UserMessage {
                    id: "u".into(),
                    text: "hi".into(),
                    attachments: vec![],
                },
            },
            SessionEvent::Item {
                turn_id: "t".into(),
                item: item("a", "answer"),
            },
        ] {
            apply(&live, &event).await;
        }
        flush_turn(&live, &store).await;

        let written = store.load_chat("w1", "s1").unwrap().items;
        assert_eq!(written.len(), 1, "the prompt was persisted on arrival");
        assert_eq!(written[0].id(), "a");
    }

    #[tokio::test]
    async fn the_replay_buffer_is_bounded() {
        let (live, _store_dir) = live_session(meta());
        for _ in 0..10 {
            live.publish(SessionEvent::TurnStarted {
                turn_id: "t".into(),
                started_at_ms: 1,
            })
            .await;
            live.trim_replay(4).await;
        }
        let replay = live.replay.lock().await;
        let (length, newest, oldest) = (
            replay.len(),
            replay.back().unwrap().seq,
            replay.front().unwrap().seq,
        );
        assert_eq!(length, 4);
        assert_eq!(newest, 10, "the newest is kept");
        assert_eq!(oldest, 7, "the oldest is dropped");
    }

    #[tokio::test]
    async fn usage_rides_along_on_turn_completion() {
        let (live, _store_dir) = live_session(meta());
        let event = live
            .publish(SessionEvent::TurnCompleted {
                turn_id: "t".into(),
                usage: Usage {
                    input_tokens: 10,
                    ..Usage::default()
                },
                fork_checkpoint: None,
            })
            .await;
        match event.event {
            SessionEvent::TurnCompleted { usage, .. } => assert_eq!(usage.input_tokens, 10),
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Runs the pump against a scripted agent and collects everything the
    /// clients would see until the turn ends, plus what landed on disk.
    async fn pumped(
        script: Vec<SessionEvent>,
    ) -> (
        Vec<SessionEvent>,
        Vec<TimelineItem>,
        tokio::task::JoinHandle<()>,
        broadcast::Sender<SessionEvent>,
        Store,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path());
        let live = Arc::new(Live::new(meta(), store.clone()));
        // Work only reaches disk through a round's trunk files, and in
        // production `session.send` always opens one before the agent runs.
        live.begin_round(None, "t", "u0").await;
        let (agent_events, _) = broadcast::channel(64);
        let mut seen = live.events.subscribe();
        let pump = tokio::spawn(pump_events(
            live.clone(),
            agent_events.subscribe(),
            store.clone(),
            64,
            crate::processes::Processes::new(),
            Arc::new(Diagnostics::new()),
        ));
        for event in script {
            agent_events.send(event).expect("the pump is listening");
        }
        let mut wire = Vec::new();
        loop {
            let event = seen.recv().await.expect("the pump is running").event;
            let ended = matches!(event, SessionEvent::TurnCompleted { .. });
            wire.push(event);
            if ended {
                break;
            }
        }
        // The flush rides on the settle event, which was just observed — but
        // only observed on its way out, so give the pump its turn.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let on_disk = store.load_chat("w1", "s1").unwrap().items;
        (wire, on_disk, pump, agent_events, store, dir)
    }

    /// Every work row of a round, in order, as stored. The round layer is the
    /// only way to work back to a tool call or a thinking block now: the
    /// narrative log does not carry them.
    fn stored_blobs(store: &Store, ord: u32) -> Vec<genehub_proto::BlobOverview> {
        store
            .load_trunk_index("w1", "s1", ord)
            .unwrap()
            .iter()
            .flat_map(|summary| store.load_trunk("w1", "s1", ord, summary).unwrap().batches)
            .flat_map(|batch| batch.blobs)
            .collect()
    }

    /// A thinking block streams one delta per token; what reaches the wire is
    /// its first sentence, republished only while that sentence is still
    /// growing. Forty tokens must not be forty messages.
    #[tokio::test]
    async fn thinking_reaches_the_wire_as_one_sentence_not_one_message_per_token() {
        let mut script = vec![
            SessionEvent::TurnStarted {
                turn_id: "t".into(),
                started_at_ms: 1,
            },
            SessionEvent::Item {
                turn_id: "t".into(),
                item: TimelineItem::Reasoning {
                    id: "r".into(),
                    text: String::new(),
                },
            },
        ];
        for _ in 0..40 {
            script.push(SessionEvent::ItemDelta {
                turn_id: "t".into(),
                item_id: "r".into(),
                delta: ItemDelta::Text {
                    delta: "abc ".into(),
                },
            });
        }
        script.push(SessionEvent::TurnCompleted {
            turn_id: "t".into(),
            usage: Usage::default(),
            fork_checkpoint: None,
        });

        let (wire, on_disk, pump, agent_events, store, _dir) = pumped(script).await;
        drop(agent_events);
        pump.await.unwrap();

        let reasoning_updates = wire
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    SessionEvent::Item {
                        item: TimelineItem::Reasoning { .. },
                        ..
                    }
                )
            })
            .count();
        assert!(
            reasoning_updates <= 8,
            "forty tokens became {reasoning_updates} messages"
        );
        assert!(
            !wire.iter().any(|event| matches!(
                event,
                SessionEvent::ItemDelta { item_id, .. } if item_id == "r"
            )),
            "a thinking delta leaked onto the wire"
        );
        for event in &wire {
            if let SessionEvent::Item {
                item: TimelineItem::Reasoning { text, .. },
                ..
            } = event
            {
                assert!(
                    text.chars().count() <= overview::REASONING_CHARS,
                    "more than the overview reached the wire: {text:?}"
                );
            }
        }
        assert!(
            on_disk.iter().all(|item| item.id() != "r"),
            "thinking belongs to the round layer, not to the session narrative"
        );
        let persisted = stored_blobs(&store, 0)
            .into_iter()
            .find(|blob| blob.item_id == "r")
            .expect("the thinking block is stored as a work row");
        assert_eq!(persisted.kind, genehub_proto::BlobKind::Reasoning);
        assert_eq!(
            persisted.overview.chars().count(),
            overview::REASONING_CHARS
        );
    }

    /// A shell command's output is the heaviest ordinary payload there is.
    /// The card keeps only three short strings; the wall of text goes no
    /// further than the agent.
    #[tokio::test]
    async fn a_tool_calls_payload_stays_behind_the_access_layer() {
        let output = "a line of build output\n".repeat(500);
        let (wire, on_disk, pump, agent_events, store, _dir) = pumped(vec![
            SessionEvent::TurnStarted {
                turn_id: "t".into(),
                started_at_ms: 1,
            },
            SessionEvent::Item {
                turn_id: "t".into(),
                item: TimelineItem::ToolCall {
                    id: "c".into(),
                    name: "Shell".into(),
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Shell {
                        command: "cargo build --workspace".into(),
                        output,
                        exit_code: Some(0),
                    },
                },
            },
            SessionEvent::TurnCompleted {
                turn_id: "t".into(),
                usage: Usage {
                    input_tokens: 120,
                    output_tokens: 34,
                    cache_read_tokens: 80,
                    ..Usage::default()
                },
                fork_checkpoint: Some("agent-turn-7".into()),
            },
        ])
        .await;
        drop(agent_events);
        pump.await.unwrap();

        for event in &wire {
            if let SessionEvent::Item {
                item: TimelineItem::ToolCall { detail, .. },
                ..
            } = event
            {
                match detail {
                    ToolCallDetail::Overview {
                        overview,
                        input,
                        output,
                        ..
                    } => {
                        assert_eq!(overview, "cargo build --workspace");
                        assert_eq!(input, "cargo build --workspace");
                        assert_eq!(output.lines().count(), 5);
                        assert_eq!(output.lines().next(), Some("a line of build output"));
                        assert_eq!(output.lines().last(), Some("a line of build output"));
                        assert!(overview.chars().count() <= overview::SUMMARY_CHARS);
                        assert!(input.chars().count() <= overview::TOOL_LINE_CHARS);
                        assert!(output
                            .lines()
                            .all(|line| line.chars().count() <= overview::TOOL_LINE_CHARS));
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
        }
        let stats = on_disk
            .iter()
            .find_map(|item| match item {
                TimelineItem::TurnSummary { stats, .. } => Some(stats),
                _ => None,
            })
            .expect("the completed turn keeps its statistics");
        assert_eq!(stats.usage.input_tokens, 120);
        assert_eq!(stats.usage.output_tokens, 34);
        assert_eq!(stats.usage.cache_read_tokens, 80);
        assert_eq!(stats.tool_calls, 1);
        assert_eq!(stats.fork_checkpoint.as_deref(), Some("agent-turn-7"));
        let size = serde_json::to_string(&on_disk).unwrap().len();
        assert!(size < 1_000, "the log kept the payload ({size} bytes)");
        // The work row itself is the index: it carries the locator, and no
        // separate blob index is consulted to get from item to payload.
        let blob_ref = stored_blobs(&store, 0)
            .into_iter()
            .find(|blob| blob.item_id == "c")
            .and_then(|blob| blob.blob)
            .expect("the compact row points at source-preserved content");
        let blob = store
            .get_blob("w1", "s1", &blob_ref)
            .unwrap()
            .expect("the content-addressed blob is retrievable");
        assert!(
            blob.value.to_string().len() > 10_000,
            "the source output was not replaced by its overview"
        );
    }

    // -- ActiveRound: round vs. turn (docs/agent-analysis-substrate-proposal.md §3.2) --
    //
    // The pure decision logic (`begin_round`, `continue_round`, `settle_round`)
    // is tested directly against a bare `Live`, the same way `apply` is above.
    // A handful of tests then drive the whole thing through `SessionManager`
    // with a scriptable fake in place of a real adapter — the registry only
    // ever gets asked for a real process when `live.agent` is empty, so a
    // fake dropped in ahead of time keeps `send` and `respond_permission`
    // running their real logic without spawning anything.

    #[tokio::test]
    async fn a_round_opens_on_the_first_adapter_turn() {
        let (live, _store_dir) = live_session(meta());
        let superseded = live.begin_round(None, "t0", "u0").await;
        assert!(superseded.is_none(), "nothing was open to cut short");

        let round = live
            .active_round
            .lock()
            .await
            .clone()
            .expect("a round was opened");
        assert_eq!(round.adapter_turn_ids, vec!["t0".to_string()]);
        assert!(round.outcome.is_none());
    }

    #[tokio::test]
    async fn a_send_without_continues_round_supersedes_the_dangling_round_it_replaces() {
        let (live, _store_dir) = live_session(meta());
        live.begin_round(None, "t0", "u0").await;
        let first_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let superseded = live
            .begin_round(None, "t1", "u1")
            .await
            .expect("the dangling round was cut short");
        assert_eq!(superseded.round_id, first_round_id);
        assert_eq!(superseded.outcome, Some(RoundOutcome::Superseded));
        assert_eq!(superseded.adapter_turn_ids, vec!["t0".to_string()]);
        assert_eq!(
            superseded.user_item_id.as_deref(),
            Some("u0"),
            "the superseded round keeps the message that opened it"
        );

        let current = live.active_round.lock().await.clone().unwrap();
        assert_ne!(
            current.round_id, first_round_id,
            "a fresh round must replace the superseded one"
        );
        assert_eq!(current.adapter_turn_ids, vec!["t1".to_string()]);
    }

    #[tokio::test]
    async fn a_send_with_a_matching_continues_round_folds_into_the_same_round() {
        let (live, _store_dir) = live_session(meta());
        live.begin_round(None, "t0", "u0").await;
        let round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let superseded = live.begin_round(Some(&round_id), "t1", "u1").await;
        assert!(
            superseded.is_none(),
            "a matching continuesRound must not cut the round short"
        );

        let round = live.active_round.lock().await.clone().unwrap();
        assert_eq!(round.round_id, round_id, "the round id must not change");
        assert_eq!(
            round.adapter_turn_ids,
            vec!["t0".to_string(), "t1".to_string()],
            "the new adapter turn must fold into the same round"
        );
        assert_eq!(
            round.user_item_id.as_deref(),
            Some("u0"),
            "the round is still the one the first message opened"
        );
        assert!(
            live.open_trunk_items.lock().await.is_empty(),
            "a user message is narrative, not work: it never enters a trunk"
        );
    }

    #[tokio::test]
    async fn a_continues_round_naming_an_unknown_round_starts_a_fresh_one() {
        let (live, _store_dir) = live_session(meta());
        live.begin_round(None, "t0", "u0").await;
        let real_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let superseded = live
            .begin_round(Some("r_does_not_exist"), "t1", "u1")
            .await
            .expect("the real dangling round is still cut short");
        assert_eq!(superseded.round_id, real_round_id);
        assert_eq!(superseded.user_item_id.as_deref(), Some("u0"));

        let current = live.active_round.lock().await.clone().unwrap();
        assert_ne!(
            current.round_id, real_round_id,
            "an unrecognized continuesRound must not be trusted"
        );
        assert_eq!(current.adapter_turn_ids, vec!["t1".to_string()]);
    }

    #[tokio::test]
    async fn a_settled_round_is_replaced_quietly_not_marked_superseded_again() {
        let (live, _store_dir) = live_session(meta());
        live.begin_round(None, "t0", "u0").await;
        let round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();
        assert!(live.settle_round(RoundOutcome::Completed).await.is_some());

        // A stale continuesRound for a round that already finished on its own
        // must not reopen it, and must not be reported as "cut short" —
        // nothing was taken from it, it had already ended.
        let superseded = live.begin_round(Some(&round_id), "t1", "u1").await;
        assert!(superseded.is_none());

        let current = live.active_round.lock().await.clone().unwrap();
        assert_ne!(current.round_id, round_id);
        assert!(current.outcome.is_none());
    }

    #[tokio::test]
    async fn settle_round_is_idempotent() {
        let (live, _store_dir) = live_session(meta());
        live.begin_round(None, "t0", "u0").await;

        let settled = live
            .settle_round(RoundOutcome::Completed)
            .await
            .expect("the round was open");
        assert_eq!(settled.user_item_id.as_deref(), Some("u0"));
        assert!(
            live.settle_round(RoundOutcome::Failed).await.is_none(),
            "a round cannot be settled twice"
        );

        let round = live.active_round.lock().await.clone().unwrap();
        assert_eq!(
            round.outcome,
            Some(RoundOutcome::Completed),
            "the first outcome wins"
        );
    }

    #[tokio::test]
    async fn blocked_time_is_folded_in_when_the_round_resumes_or_ends() {
        let (live, _store_dir) = live_session(meta());
        live.begin_round(None, "t0", "u0").await;
        live.round_blocked().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        live.continue_round("t1").await;

        let round = live.active_round.lock().await.clone().unwrap();
        assert!(round.blocked_since_ms.is_none(), "the pause is over");
        assert!(
            round.blocked_ms >= 15,
            "the wait should be counted, got {}ms",
            round.blocked_ms
        );
        assert_eq!(
            round.adapter_turn_ids,
            vec!["t0".to_string(), "t1".to_string()]
        );

        live.round_blocked().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        live.settle_round(RoundOutcome::Canceled).await;
        let round = live.active_round.lock().await.clone().unwrap();
        assert!(
            round.blocked_ms >= 30,
            "a second pause must add to the running total, got {}ms",
            round.blocked_ms
        );
    }

    /// A fake `AgentSession` a test drives by hand: `send` mints an
    /// incrementing turn id and returns immediately; the test pushes
    /// whatever events that turn should produce onto the same channel the
    /// running pump reads from — exactly what a real adapter does, minus the
    /// process. The counter is shared (not per-instance) so a test that
    /// re-attaches a fresh fake after a simulated restart still gets turn
    /// ids that do not collide with the ones before it.
    struct FakeSession {
        events: broadcast::Sender<SessionEvent>,
        next_turn: Arc<AtomicU64>,
        /// Fails the handover the way a CLI that died on startup does.
        refuses: bool,
    }

    impl FakeSession {
        fn sharing(events: broadcast::Sender<SessionEvent>, next_turn: Arc<AtomicU64>) -> Self {
            FakeSession {
                events,
                next_turn,
                refuses: false,
            }
        }

        fn refusing(events: broadcast::Sender<SessionEvent>) -> Self {
            FakeSession {
                events,
                next_turn: Arc::new(AtomicU64::new(0)),
                refuses: true,
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentSession for FakeSession {
        fn events(&self) -> broadcast::Receiver<SessionEvent> {
            self.events.subscribe()
        }

        async fn send(&self, _input: PromptInput) -> Result<String> {
            if self.refuses {
                anyhow::bail!("the agent stopped before it was ready");
            }
            let id = self.next_turn.fetch_add(1, Ordering::SeqCst);
            Ok(format!("t{id}"))
        }

        async fn interrupt(&self) -> Result<()> {
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            Ok(())
        }

        async fn set_model(&self, _model_id: &str) -> Result<()> {
            anyhow::bail!("not used")
        }

        async fn set_mode(&self, _mode_id: &str) -> Result<()> {
            anyhow::bail!("not used")
        }

        async fn respond_permission(
            &self,
            _request_id: &str,
            _outcome: PermissionOutcome,
        ) -> Result<()> {
            anyhow::bail!("a stopped process is never answered in place")
        }
    }

    /// Wires a session the way `ensure_started` would, but with a
    /// `FakeSession` in place of a real adapter and its pump already
    /// running — so `SessionManager::send` and `respond_permission` run
    /// their real logic end to end, only the process at the bottom is fake.
    async fn wired(
        root: &std::path::Path,
    ) -> (
        SessionManager,
        broadcast::Sender<SessionEvent>,
        Arc<AtomicU64>,
    ) {
        let sessions = manager(root);
        sessions.store.save_meta(&meta()).unwrap();
        let live = sessions.live("s1").await.unwrap();
        // Match the production adapter buffer: pagination tests deliberately
        // send more than 64 events and are not overflow tests.
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        let turn_ids = Arc::new(AtomicU64::new(0));
        *live.agent.lock().await = Some(Box::new(FakeSession::sharing(
            events.clone(),
            turn_ids.clone(),
        )));
        let pump = tokio::spawn(pump_events(
            live.clone(),
            events.subscribe(),
            sessions.store.clone(),
            64,
            sessions.processes(),
            sessions.diagnostics.clone(),
        ));
        *live.pump.lock().await = Some(pump);
        (sessions, events, turn_ids)
    }

    /// Waits for the event pump to reach a state, rather than guessing how
    /// long it takes to get there.
    ///
    /// The pump is its own task, so a test that just sent an event has to wait
    /// for it. A fixed sleep is a guess that holds when the test runs alone and
    /// breaks when the whole suite competes for the machine — which is how this
    /// helper came to exist. The ceiling is generous because it only has to
    /// catch a pump that will never arrive, not a slow one.
    async fn eventually(expected: &str, mut reached: impl AsyncFnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !reached().await {
            assert!(
                std::time::Instant::now() < deadline,
                "the event pump never {expected}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Every `SessionStatusChanged` a call published, in order.
    fn statuses(seen: &mut broadcast::Receiver<SequencedEvent>) -> Vec<SessionStatus> {
        let mut out = Vec::new();
        while let Ok(event) = seen.try_recv() {
            if let SessionEvent::SessionStatusChanged { status } = event.event {
                out.push(status);
            }
        }
        out
    }

    /// Starting an agent takes time the wire used to say nothing about. Until
    /// `TurnStarted` arrived — behind a process spawn and a handshake, seconds
    /// for a third-party CLI — every other client still saw an idle session, so
    /// it offered a send button for it and got this call's own refusal back.
    #[tokio::test]
    async fn send_says_the_session_is_busy_before_it_reaches_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, _events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();
        let live = sessions.live("s1").await.unwrap();
        let mut seen = live.events.subscribe();

        sessions
            .send("s1", "hello".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");

        let mut published = Vec::new();
        while let Ok(event) = seen.try_recv() {
            published.push(event.event);
        }
        let busy = published
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SessionEvent::SessionStatusChanged {
                        status: SessionStatus::Running
                    }
                )
            })
            .expect("the busy status reached the clients");
        let prompt = published
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SessionEvent::Item {
                        item: TimelineItem::UserMessage { .. },
                        ..
                    }
                )
            })
            .expect("the prompt reached the clients");
        assert!(
            busy < prompt,
            "the session must be known to be busy before anything else, got {published:?}"
        );
    }

    /// And withdrawn when it turns out nothing is running after all, or every
    /// client keeps a busy session that will never finish.
    #[tokio::test]
    async fn a_refused_handover_withdraws_the_busy_status() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();
        let live = sessions.live("s1").await.unwrap();
        *live.agent.lock().await = Some(Box::new(FakeSession::refusing(events.clone())));
        let mut seen = live.events.subscribe();

        sessions
            .send("s1", "hello".into(), vec![], &providers, None, None)
            .await
            .expect_err("the handover failed");

        assert_eq!(
            statuses(&mut seen),
            vec![SessionStatus::Running, SessionStatus::Idle]
        );
        assert_eq!(*live.status.lock().await, SessionStatus::Idle);
    }

    #[tokio::test]
    async fn a_round_completes_with_a_single_adapter_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send("s1", "hello".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: turn_id.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        events
            .send(SessionEvent::TurnCompleted {
                turn_id: turn_id.clone(),
                usage: Usage::default(),
                fork_checkpoint: None,
            })
            .unwrap();
        let live = sessions.live("s1").await.unwrap();
        eventually("settled the round", async || {
            live.active_round
                .lock()
                .await
                .as_ref()
                .is_some_and(|round| round.outcome.is_some())
        })
        .await;

        let round = live
            .active_round
            .lock()
            .await
            .clone()
            .expect("a round was opened");
        assert_eq!(round.adapter_turn_ids, vec![turn_id.clone()]);
        assert_eq!(round.outcome, Some(RoundOutcome::Completed));

        let on_disk = sessions.store.load_chat("w1", "s1").unwrap().items;
        let user_item_id = on_disk
            .iter()
            .find_map(|item| match item {
                TimelineItem::UserMessage { id, .. } => Some(id.clone()),
                _ => None,
            })
            .expect("the prompt was written to disk");

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(rounds.len(), 1, "one settled round must be ledgered");
        assert_eq!(rounds[0].round_id, round.round_id);
        assert_eq!(rounds[0].outcome, Some(RoundOutcome::Completed));
        assert_eq!(rounds[0].adapter_turn_ids, vec![turn_id]);
        assert_eq!(rounds[0].user_item_id.as_ref(), Some(&user_item_id));
        assert!(!rounds[0].synthesized, "a live round is never synthesized");
    }

    fn tool_call(id: &str, name: &str) -> TimelineItem {
        TimelineItem::ToolCall {
            id: id.into(),
            name: name.into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Shell {
                command: name.into(),
                output: String::new(),
                exit_code: Some(0),
            },
        }
    }

    /// End-to-end proof that trunk pagination (§3.2 direction three, §8 step
    /// 3) actually reaches the ledger: a monologue that arrives after some
    /// tool calls closes a trunk, and the round settling closes whatever
    /// trunk was still open — nothing accumulated since the last boundary is
    /// silently dropped.
    #[tokio::test]
    async fn a_monologue_boundary_mid_round_produces_two_ledgered_trunks() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send(
                "s1",
                "do a bunch of stuff".into(),
                vec![],
                &providers,
                None,
                None,
            )
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: turn_id.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        for event in [
            SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: item("a1", "reading the config first"),
            },
            SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: tool_call("t1", "read_file"),
            },
            SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: tool_call("t2", "read_file"),
            },
            SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: item("a2", "now applying the change"),
            },
        ] {
            events.send(event).unwrap();
        }
        events
            .send(SessionEvent::TurnCompleted {
                turn_id: turn_id.clone(),
                usage: Usage::default(),
                fork_checkpoint: None,
            })
            .unwrap();
        eventually("persisted the narrated trunk", async || {
            let Ok(chat) = sessions.store.load_chat("w1", "s1") else {
                return false;
            };
            let Ok(trunks) = sessions.store.load_trunk_index("w1", "s1", 0) else {
                return false;
            };
            chat.rounds
                .first()
                .is_some_and(|round| round.trunk_count == 1)
                && trunks.len() == 1
        })
        .await;

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(rounds.len(), 1, "one settled round must be ledgered");
        let trunks = sessions.store.load_trunk_index("w1", "s1", 0).unwrap();
        assert_eq!(rounds[0].trunk_count, 1);
        assert_eq!(
            trunks.len(),
            1,
            "monologues divide visible batches; the trunk remains bounded by its blob cap"
        );
        assert_eq!(trunks[0].index, 0);
        assert_eq!(trunks[0].first_item_id, "a1");
        assert_eq!(trunks[0].blob_count, 2);
        assert_eq!(trunks[0].title, "reading the config first");
        assert_eq!(trunks[0].batches.len(), 2);
        assert_eq!(trunks[0].batches[0].blob_count, 2);
        assert_eq!(trunks[0].batches[1].blob_count, 0);
    }

    /// A round that never narrates still gets paginated: the 64-tool batch cap
    /// protects the byte budget during long runs with no monologue or useful
    /// thinking boundary, while the trunk threshold remains soft.
    #[tokio::test]
    async fn a_round_with_no_monologue_at_all_paginates_after_the_soft_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send(
                "s1",
                "run a lot of tools".into(),
                vec![],
                &providers,
                None,
                None,
            )
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: turn_id.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        for i in 0..132u32 {
            events
                .send(SessionEvent::Item {
                    turn_id: turn_id.clone(),
                    item: tool_call(&format!("t{i}"), "grep"),
                })
                .unwrap();
            if i % 64 == 63 {
                tokio::task::yield_now().await;
            }
        }
        events
            .send(SessionEvent::TurnCompleted {
                turn_id: turn_id.clone(),
                usage: Usage::default(),
                fork_checkpoint: None,
            })
            .unwrap();
        eventually("persisted both paginated trunks", async || {
            let Ok(chat) = sessions.store.load_chat("w1", "s1") else {
                return false;
            };
            let Ok(trunks) = sessions.store.load_trunk_index("w1", "s1", 0) else {
                return false;
            };
            chat.rounds
                .first()
                .is_some_and(|round| round.trunk_count == 2)
                && trunks.len() == 2
        })
        .await;

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        let trunks = sessions.store.load_trunk_index("w1", "s1", 0).unwrap();
        assert_eq!(rounds[0].trunk_count, 2);
        assert_eq!(
            trunks.len(),
            2,
            "132 tool calls split after the threshold-crossing batch: {trunks:?}"
        );
        assert_eq!(trunks[0].blob_count, 128);
        assert_eq!(trunks[0].batches.len(), 2);
        assert_eq!(trunks[1].blob_count, 4);
        assert_eq!(trunks[1].batches.len(), 1);
    }

    #[tokio::test]
    async fn layered_open_omits_historical_work_and_prefetches_only_the_last_trunk() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();
        let turn_id = sessions
            .send("s1", "inspect".into(), vec![], &providers, None, None)
            .await
            .unwrap();
        events
            .send(SessionEvent::TurnStarted {
                turn_id: turn_id.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        events
            .send(SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: item("a1", "先读取配置。然后修改"),
            })
            .unwrap();
        events
            .send(SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: TimelineItem::ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Read {
                        path: "config.json".into(),
                        content: "raw source content".repeat(100),
                        truncated: false,
                    },
                },
            })
            .unwrap();
        events
            .send(SessionEvent::TurnCompleted {
                turn_id,
                usage: Usage::default(),
                fork_checkpoint: None,
            })
            .unwrap();
        eventually("persisted the expanded trunk and its blob", async || {
            let Ok(index) = sessions.store.load_trunk_index("w1", "s1", 0) else {
                return false;
            };
            let Some(summary) = index.last() else {
                return false;
            };
            let Ok(trunk) = sessions.store.load_trunk("w1", "s1", 0, summary) else {
                return false;
            };
            trunk
                .batches
                .iter()
                .flat_map(|batch| &batch.blobs)
                .any(|blob| blob.blob.is_some())
        })
        .await;

        let (snapshot, replayed, reset, _) = sessions.subscribe("s1", Some(0), true).await.unwrap();
        assert!(reset);
        assert!(
            replayed.is_empty(),
            "layered open must not replay work history"
        );
        assert!(snapshot.items.iter().all(|item| !matches!(
            item,
            TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
        )));
        let rounds = snapshot.rounds.expect("session layer includes rounds");
        assert_eq!(rounds.len(), 1);
        let expanded = snapshot
            .expanded_round
            .expect("the requested last round is prefetched");
        assert_eq!(expanded.trunks.len(), 1);
        assert_eq!(expanded.trunks[0].batches.len(), 1);
        let trunk = expanded
            .expanded_trunk
            .expect("last trunk details are present");
        assert_eq!(trunk.batches[0].blobs.len(), 1);
        assert_eq!(
            trunk.batches[0].monologue.as_deref(),
            Some("先读取配置。然后修改"),
            "process narration belongs to the expanded batch rather than being reconstructed by the client"
        );
        let reference = trunk.batches[0].blobs[0]
            .blob
            .clone()
            .expect("the compact blob row addresses source content");
        let payload = sessions.blob("s1", &reference).await.unwrap();
        assert!(payload.value.to_string().contains("raw source content"));
    }

    #[tokio::test]
    async fn trunk_index_pages_backward_without_repeating_the_round_payload() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, _events, _) = wired(dir.path()).await;
        sessions
            .store
            .append_round(
                "w1",
                "s1",
                &RoundRecord {
                    schema_version: rounds::SCHEMA_VERSION,
                    round_id: "r-many".into(),
                    ord: 0,
                    user_item_id: None,
                    started_at_ms: 1,
                    ended_at_ms: 2,
                    outcome: Some(RoundOutcome::Completed),
                    adapter_turn_ids: vec!["t1".into()],
                    blocked_ms: 0,
                    synthesized: false,
                    trunk_count: 25,
                },
            )
            .unwrap();
        for index in 0..25 {
            sessions
                .store
                .write_trunk(
                    "w1",
                    "s1",
                    0,
                    &RoundTrunk {
                        summary: TrunkSummary {
                            index,
                            first_item_id: format!("i{index}"),
                            blob_count: 100,
                            title: format!("阶段 {index}"),
                            batches: vec![],
                        },
                        batches: vec![],
                    },
                )
                .unwrap();
        }

        // A cold open, so the session layer reads the record just written
        // rather than the empty one it has in memory.
        sessions.sessions.write().await.clear();
        let recent = sessions
            .round_layer("s1", "r-many", None, Some(20))
            .await
            .unwrap();
        assert_eq!(recent.trunks.first().unwrap().index, 5);
        assert_eq!(recent.trunks.last().unwrap().index, 24);
        assert_eq!(recent.next_cursor.as_deref(), Some("before:5"));
        let older = sessions
            .round_layer("s1", "r-many", recent.next_cursor.as_deref(), Some(20))
            .await
            .unwrap();
        assert_eq!(older.trunks.len(), 5);
        assert_eq!(older.trunks.first().unwrap().index, 0);
        assert!(older.next_cursor.is_none());
    }

    /// The proposal's central claim: an approval mid-turn is not a new round,
    /// even though it is two adapter turns, two `TurnSummary`s and — before
    /// this — two independent stories about what happened.
    #[tokio::test]
    async fn approving_a_permission_stitches_the_same_round_across_two_adapter_turns() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, turn_ids) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let first_turn = sessions
            .send("s1", "do the thing".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: first_turn.clone(),
                started_at_ms: 1,
            })
            .unwrap();

        let request = interaction(PermissionRequestKind::Permission);
        events
            .send(SessionEvent::PermissionRequested {
                request: request.clone(),
            })
            .unwrap();
        let live = sessions.live("s1").await.unwrap();
        eventually("recorded the permission request", async || {
            !live.pending_permissions.lock().await.is_empty()
        })
        .await;

        let round_id_before = {
            let round = live.active_round.lock().await;
            let round = round.as_ref().expect("a round is open, just blocked");
            assert_eq!(round.adapter_turn_ids, vec![first_turn.clone()]);
            assert!(round.outcome.is_none(), "blocked is not settled");
            round.round_id.clone()
        };

        // The real pump broke its loop for the interaction, same as
        // `stop_agent_for_interaction` does against a real adapter. A fresh
        // fake stands in for whatever `ensure_started_in_mode` would really
        // start on approval, sharing the turn-id counter so the ids stay
        // distinct across the "restart".
        *live.agent.lock().await = Some(Box::new(FakeSession::sharing(
            events.clone(),
            turn_ids.clone(),
        )));
        let pump = tokio::spawn(pump_events(
            live.clone(),
            events.subscribe(),
            sessions.store.clone(),
            64,
            sessions.processes(),
            sessions.diagnostics.clone(),
        ));
        *live.pump.lock().await = Some(pump);

        sessions
            .respond_permission(
                "s1",
                &request.id,
                PermissionOutcome::Selected {
                    option_id: "yes".into(),
                },
                &providers,
            )
            .await
            .expect("an allow option resumes");

        let second_turn = {
            let round = live.active_round.lock().await;
            let round = round.as_ref().unwrap();
            assert_eq!(
                round.round_id, round_id_before,
                "an approval must not cut a new round"
            );
            assert_eq!(
                round.adapter_turn_ids.len(),
                2,
                "the resumed turn must fold into the same round"
            );
            assert!(round.blocked_since_ms.is_none(), "resumed, so unblocked");
            round.adapter_turn_ids[1].clone()
        };
        assert_ne!(second_turn, first_turn);

        events
            .send(SessionEvent::TurnStarted {
                turn_id: second_turn.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        events
            .send(SessionEvent::TurnCompleted {
                turn_id: second_turn,
                usage: Usage::default(),
                fork_checkpoint: None,
            })
            .unwrap();
        eventually("settled the resumed round", async || {
            live.active_round
                .lock()
                .await
                .as_ref()
                .is_some_and(|round| round.outcome.is_some())
        })
        .await;

        let round = live.active_round.lock().await.clone().unwrap();
        assert_eq!(round.round_id, round_id_before);
        assert_eq!(round.outcome, Some(RoundOutcome::Completed));
        assert!(
            round.blocked_ms >= 0,
            "the wait for the approval was tracked"
        );

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(
            rounds.len(),
            1,
            "two adapter turns stitched into one round must ledger as one record, not two"
        );
        assert_eq!(rounds[0].round_id, round_id_before);
        assert_eq!(rounds[0].adapter_turn_ids.len(), 2);
        assert_eq!(rounds[0].outcome, Some(RoundOutcome::Completed));
    }

    #[tokio::test]
    async fn denying_a_permission_settles_the_round_without_a_continuation() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send("s1", "do the thing".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id,
                started_at_ms: 1,
            })
            .unwrap();
        let request = interaction(PermissionRequestKind::Permission);
        events
            .send(SessionEvent::PermissionRequested {
                request: request.clone(),
            })
            .unwrap();
        let live = sessions.live("s1").await.unwrap();
        eventually("recorded the permission request", async || {
            !live.pending_permissions.lock().await.is_empty()
        })
        .await;

        sessions
            .respond_permission(
                "s1",
                &request.id,
                PermissionOutcome::Selected {
                    option_id: "no".into(),
                },
                &providers,
            )
            .await
            .expect("a reject resolves without resuming");

        let round = live.active_round.lock().await.clone().unwrap();
        assert_eq!(
            round.outcome,
            Some(RoundOutcome::Canceled),
            "no continuation means the round is done, not dangling"
        );

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].outcome, Some(RoundOutcome::Canceled));
    }

    /// The one case the daemon truly cannot decide on its own: the user
    /// pressed stop, then said something else. `continuesRound` is the
    /// client's explicit word for "same request".
    #[tokio::test]
    async fn an_interrupted_round_is_continued_when_the_next_send_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let first_turn = sessions
            .send("s1", "count to 500".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: first_turn.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        events
            .send(SessionEvent::TurnCanceled {
                turn_id: first_turn.clone(),
            })
            .unwrap();
        let live = sessions.live("s1").await.unwrap();
        eventually("released the interrupted turn", async || {
            *live.status.lock().await == genehub_proto::SessionStatus::Idle
        })
        .await;

        assert_eq!(
            *live.status.lock().await,
            genehub_proto::SessionStatus::Idle,
            "interrupted, so usable again"
        );
        let dangling_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .expect("the round from the interrupted turn is left dangling")
            .round_id
            .clone();

        let second_turn = sessions
            .send(
                "s1",
                "continue".into(),
                vec![],
                &providers,
                None,
                Some(dangling_round_id.clone()),
            )
            .await
            .expect("accepted");

        let round = live.active_round.lock().await.clone().unwrap();
        assert_eq!(
            round.round_id, dangling_round_id,
            "the same round continues"
        );
        assert_eq!(round.adapter_turn_ids, vec![first_turn, second_turn]);

        let recorded = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(
            recorded.len(),
            1,
            "a continued round stays one record, not one per adapter turn"
        );
        assert_eq!(recorded[0].round_id, dangling_round_id);
        assert_eq!(
            recorded[0].outcome, None,
            "the round is on disk from the moment it opens, and still open"
        );
    }

    /// Without that signal, the daemon must not guess: the dangling round is
    /// cut loose and a new one starts, even though nothing else about this
    /// message looks any different from a real continuation.
    #[tokio::test]
    async fn an_interrupted_round_is_superseded_by_a_plain_new_message() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let first_turn = sessions
            .send("s1", "count to 500".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: first_turn.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        events
            .send(SessionEvent::TurnCanceled {
                turn_id: first_turn,
            })
            .unwrap();
        let live = sessions.live("s1").await.unwrap();
        eventually("released the interrupted turn", async || {
            *live.status.lock().await == genehub_proto::SessionStatus::Idle
        })
        .await;

        let dangling_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let second_turn = sessions
            .send(
                "s1",
                "what's the weather".into(),
                vec![],
                &providers,
                None,
                None,
            )
            .await
            .expect("accepted");

        let round = live.active_round.lock().await.clone().unwrap();
        assert_ne!(
            round.round_id, dangling_round_id,
            "no continuesRound means a fresh round, not a guess"
        );
        assert_eq!(round.adapter_turn_ids, vec![second_turn]);

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(
            rounds.len(),
            2,
            "the superseded round and the one that replaced it are both on disk"
        );
        assert_eq!(rounds[0].round_id, dangling_round_id);
        assert_eq!(
            rounds[0].outcome,
            Some(RoundOutcome::Superseded),
            "the superseded round must be recorded even though it never got a terminal adapter event"
        );
        assert_eq!(rounds[1].round_id, round.round_id);
        assert_eq!(rounds[1].outcome, None, "the replacement is still running");
    }

    /// The fallback `TurnCompleted`/`TurnFailed`/`TurnCanceled` do not cover:
    /// the adapter's process disappears without saying anything at all. This
    /// is also, on purpose, a round that produced exactly one item before
    /// the crash — the "space round"-adjacent case §3.2 calls out as the one
    /// most likely to be silently dropped.
    #[tokio::test]
    async fn a_channel_that_closes_mid_turn_settles_the_dangling_round_and_flushes_what_it_produced(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();
        let live = sessions.live("s1").await.unwrap();

        let turn_id = sessions
            .send("s1", "hello".into(), vec![], &providers, None, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::Item {
                turn_id,
                item: item("a", "partial answer"),
            })
            .unwrap();

        // The adapter's sender vanishes without a terminal event: a crashed
        // process, not a graceful stop. Both clones have to go — the test's
        // and the fake session's — for the channel to actually close.
        live.agent.lock().await.take();
        drop(events);
        eventually("noticed the adapter was gone", async || {
            live.active_round
                .lock()
                .await
                .as_ref()
                .is_some_and(|round| round.outcome.is_some())
        })
        .await;

        let round = live
            .active_round
            .lock()
            .await
            .clone()
            .expect("the round from `send` is still there");
        assert_eq!(round.outcome, Some(RoundOutcome::Failed));
        assert_eq!(
            *live.status.lock().await,
            genehub_proto::SessionStatus::Failed,
            "a session must not stay stuck on Running with no process left"
        );

        let on_disk = sessions.store.load_chat("w1", "s1").unwrap().items;
        assert!(
            on_disk.iter().any(|stored| stored.id() == "a"),
            "the item produced before the crash must still reach disk"
        );

        let rounds = sessions.store.load_chat("w1", "s1").unwrap().rounds;
        assert_eq!(
            rounds.len(),
            1,
            "the empty-looking round must still be ledgered"
        );
        assert_eq!(rounds[0].outcome, Some(RoundOutcome::Failed));
        assert!(
            rounds[0].user_item_id.is_some(),
            "the round must still name the request it was answering"
        );
    }

    /// Sessions belong to the code they are about, so they are written inside
    /// the workspace rather than in the daemon's data directory — and the
    /// directory they land in keeps itself out of the project's own history.
    #[tokio::test]
    async fn a_session_is_written_inside_its_workspace_without_showing_up_in_it() {
        let workspace = tempfile::tempdir().unwrap();
        let sessions = manager(workspace.path());

        sessions.store.save_meta(&meta()).unwrap();
        sessions
            .store
            .append_chat_items("w1", "s1", &[item("a", "hi")])
            .unwrap();

        let home = workspace.path().join(".genethub");
        let session = home.join("sessions").join("s1");
        assert!(
            session.join("chat.jsonl").exists(),
            "the conversation is kept with the project it is about"
        );
        assert_eq!(
            std::fs::read_to_string(home.join(".gitignore")).unwrap(),
            "*\n",
            "a user's own `git status` must not fill up with session files"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            // Every level, not just the outermost: this lives in the user's own
            // folder, whose permissions are theirs to loosen.
            for directory in [&home, &home.join("sessions"), &session] {
                assert_eq!(
                    directory.metadata().unwrap().permissions().mode() & 0o777,
                    0o700,
                    "{} is readable by other local accounts",
                    directory.display()
                );
            }
        }
    }

    #[tokio::test]
    async fn another_build_of_genehub_finds_the_sessions_in_a_shared_project() {
        let workspace = tempfile::tempdir().unwrap();
        let beta = manager(workspace.path());
        beta.store.save_meta(&meta()).unwrap();
        beta.store
            .append_chat_items("w1", "s1", &[item("a", "hi")])
            .unwrap();

        let written = std::fs::read_to_string(
            workspace
                .path()
                .join(".genethub/sessions/s1")
                .join("meta.json"),
        )
        .unwrap();
        assert!(
            !written.contains("workspaceId"),
            "an id minted by this installation means nothing to the next one: {written}"
        );
        assert!(
            written.contains(&format!("\"format\": {SESSION_FORMAT}")),
            "nothing says what shape this was written in: {written}"
        );

        // The other build knows the same folder under an id of its own: the id
        // is minted per installation, the folder is the durable fact.
        let release = SessionManager::new(
            {
                let homes = crate::session::WorkspaceHomes::default();
                homes.attach("w_other", workspace.path());
                Store::new(homes)
            },
            Arc::new(Registry::new(&std::collections::BTreeMap::new())),
            16,
        );

        let listed = release.list(Some("w_other"), false).await.unwrap();
        assert_eq!(
            listed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["s1"],
            "a conversation stored in the project was invisible to the other build"
        );
        assert_eq!(
            release.snapshot("s1").await.unwrap().items.len(),
            1,
            "the other build listed the conversation but could not read it"
        );
    }

    #[tokio::test]
    async fn a_session_from_a_newer_build_is_listed_but_refused() {
        let workspace = tempfile::tempdir().unwrap();
        let sessions = manager(workspace.path());
        sessions.store.save_meta(&meta()).unwrap();

        let meta_path = workspace
            .path()
            .join(".genethub/sessions/s1")
            .join("meta.json");
        let written = SESSION_FORMAT + 1;
        std::fs::write(
            &meta_path,
            format!(r#"{{"format":{written},"title":"来自未来","whatIsThis":[1,2]}}"#),
        )
        .unwrap();

        let listed = sessions.list(None, false).await.unwrap();
        let [session] = listed.as_slice() else {
            panic!("a conversation in the user's own folder vanished from the list: {listed:?}");
        };
        assert_eq!(session.title.as_deref(), Some("来自未来"));
        assert_eq!(
            session.unsupported,
            Some(genehub_proto::UnsupportedFormat {
                written,
                supported: SESSION_FORMAT,
            }),
            "the row gives the user no way to tell why it will not open"
        );

        let refused = sessions.snapshot("s1").await.unwrap_err().to_string();
        assert!(
            refused.contains(&written.to_string()),
            "reading a layout this build predates would show the wrong thing: {refused}"
        );
    }

    #[tokio::test]
    async fn builds_share_a_project_but_only_one_writes_each_session() {
        let workspace = tempfile::tempdir().unwrap();
        let holder = manager(workspace.path());
        holder.store.save_meta(&meta()).unwrap();

        let other = manager(workspace.path());
        let mut independent = meta();
        independent.id = "s2".into();
        independent.title = Some("independent".into());
        other.store.save_meta(&independent).unwrap();
        assert!(
            workspace
                .path()
                .join(".genethub/sessions/s2/meta.json")
                .is_file(),
            "another channel could not create or write an independent session"
        );

        let refused = other.store.save_meta(&meta()).unwrap_err().to_string();
        assert!(
            refused.contains(crate::channel::PRODUCT),
            "the second build must name who is writing the session: {refused}"
        );
        assert!(
            refused.contains("Fork from a completed turn"),
            "the refusal gives no continuation path: {refused}"
        );
        assert_eq!(
            other.list(None, false).await.unwrap().len(),
            2,
            "losing the write lock must not hide the conversations"
        );

        drop(holder);
        // Claiming is retried on every write, so writing resumes on its own
        // rather than at the next restart. Given a moment, because a child
        // process spawned anywhere in this test binary briefly inherits the
        // descriptor the departing build was holding.
        let mut resumed = other.store.save_meta(&meta());
        for _ in 0..40 {
            if resumed.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            resumed = other.store.save_meta(&meta());
        }
        resumed.expect("the second build had to be restarted to write the session again");
    }

    #[tokio::test]
    async fn current_builds_do_not_double_write_with_a_legacy_workspace_owner() {
        let workspace = tempfile::tempdir().unwrap();
        let home = workspace.path().join(".genethub");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("owner"), "GeneHub Legacy\n").unwrap();
        let legacy = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(home.join("owner.lock"))
            .unwrap();
        crate::fs_lock::try_lock_exclusive(&legacy, &home.join("owner.lock")).unwrap();

        let current = manager(workspace.path());
        let refused = current.store.save_meta(&meta()).unwrap_err().to_string();
        assert!(refused.contains("GeneHub Legacy"), "{refused}");
        assert!(refused.contains("upgrade"), "{refused}");

        drop(legacy);
        let mut resumed = current.store.save_meta(&meta());
        for _ in 0..40 {
            if resumed.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            resumed = current.store.save_meta(&meta());
        }
        resumed.expect("the current build had to restart after the legacy owner exited");
    }

    #[test]
    fn stale_runtime_choices_are_reconciled_before_agent_start() {
        let mut session = meta();
        session.model_id = Some("grok-4.6[effort=high,fast=false]".into());
        session.mode_id = Some("withdrawn-mode".into());
        session.effort_id = Some("withdrawn-effort".into());
        session.runtime_values.insert("fast".into(), "max".into());
        session
            .runtime_values
            .insert("withdrawn-axis".into(), "on".into());

        let catalog = Catalog {
            models: vec![genehub_proto::ModelInfo {
                id: "grok-4.6".into(),
                label: "Grok 4.6".into(),
                context_window: None,
                reasoning: true,
                efforts: vec!["medium".into(), "high".into()],
            }],
            modes: vec![genehub_proto::ModeInfo {
                id: "agent".into(),
                label: "Agent".into(),
                description: None,
            }],
            commands: Vec::new(),
            runtime_axes: Some(vec![genehub_proto::RuntimeAxisInfo {
                id: "fast".into(),
                label: "Fast".into(),
                description: None,
                values: vec![
                    genehub_proto::RuntimeAxisValue {
                        id: "standard".into(),
                        label: "标准".into(),
                        description: None,
                    },
                    genehub_proto::RuntimeAxisValue {
                        id: "fast".into(),
                        label: "快速".into(),
                        description: None,
                    },
                    genehub_proto::RuntimeAxisValue {
                        id: "max".into(),
                        label: "极速".into(),
                        description: None,
                    },
                ],
                default_value: Some("standard".into()),
            }]),
            default_model: Some("grok-4.6".into()),
            default_mode: Some("agent".into()),
            default_effort: Some("medium".into()),
        };

        assert!(normalize_runtime_selection(&mut session, &catalog));
        assert_eq!(session.model_id.as_deref(), Some("grok-4.6"));
        assert_eq!(session.mode_id.as_deref(), Some("agent"));
        assert_eq!(session.effort_id.as_deref(), Some("medium"));
        assert_eq!(
            session.runtime_values.get("fast").map(String::as_str),
            Some("max")
        );
        assert!(!session.runtime_values.contains_key("withdrawn-axis"));
    }

    #[test]
    fn a_catalog_probe_failure_does_not_erase_opaque_runtime_choices() {
        let mut session = meta();
        session.model_id = Some("agent-owned-model".into());
        session.effort_id = Some("agent-owned-effort".into());
        session.runtime_values.insert("fast".into(), "max".into());
        let before = session.clone();

        assert!(!normalize_runtime_selection(
            &mut session,
            &Catalog::default()
        ));
        assert_eq!(session.model_id, before.model_id);
        assert_eq!(session.effort_id, before.effort_id);
        assert_eq!(session.runtime_values, before.runtime_values);
    }

    #[tokio::test]
    async fn event_pump_records_agent_failure_without_the_runtime_message() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path());
        let live = Arc::new(Live::new(meta(), store.clone()));
        live.begin_round(None, "t", "u0").await;
        let (agent_events, _) = broadcast::channel(64);
        let mut seen = live.events.subscribe();
        let diagnostics = Arc::new(Diagnostics::new());
        let pump = tokio::spawn(pump_events(
            live,
            agent_events.subscribe(),
            store,
            64,
            crate::processes::Processes::new(),
            diagnostics.clone(),
        ));

        agent_events
            .send(SessionEvent::TurnStarted {
                turn_id: "t".into(),
                started_at_ms: now_ms(),
            })
            .unwrap();
        agent_events
            .send(SessionEvent::TurnFailed {
                turn_id: "t".into(),
                error: genehub_proto::TurnError {
                    code: TurnErrorCode::RateLimited,
                    message: "secret prompt and provider response".into(),
                },
            })
            .unwrap();
        loop {
            if matches!(
                seen.recv().await.unwrap().event,
                SessionEvent::TurnFailed { .. }
            ) {
                break;
            }
        }

        let snapshot = diagnostics.snapshot(
            "test",
            &genehub_proto::HubStatus::Unpaired,
            &genehub_proto::RemoteAccess {
                relay_url: None,
                rendezvous_url: None,
                online: false,
            },
        );
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(snapshot.events.iter().any(|event| {
            event.component == "agent"
                && event.operation == "turn"
                && event.outcome == "error"
                && event.code.as_deref() == Some("rateLimited")
        }));
        assert!(!encoded.contains("secret prompt"));
        pump.abort();
    }
}
