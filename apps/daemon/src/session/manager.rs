//! Session lifecycle: create, run, persist, replay.
//!
//! Everything here is agent-agnostic. The manager holds a `dyn AgentSession`
//! and never learns which adapter produced it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    Attachment, Catalog, ItemDelta, PermissionOptionKind, PermissionOutcome, PermissionRequest,
    PermissionRequestKind, SequencedEvent, SessionEvent, SessionSnapshot, SessionStatus,
    SessionSummary, TimelineItem, ToolStatus, TurnOutcome, TurnStats, Usage,
};
use tokio::sync::{broadcast, Mutex, RwLock};

use super::overview;
use super::rounds::{self, RoundOutcome, RoundRecord, TrunkBuilder, TrunkItem, TrunkSummary};
use super::store::{now_ms, title_from, SessionMeta, Store};
use crate::adapter::registry::Registry;
use crate::adapter::{AgentSession, PromptInput, ProviderMap, SessionConfig};

const BROADCAST_CAPACITY: usize = 1024;

/// One live session.
struct Live {
    meta: Mutex<SessionMeta>,
    status: Mutex<SessionStatus>,
    /// Ordered timeline. Small enough that a linear id lookup is cheaper than
    /// maintaining a second index.
    items: Mutex<Vec<TimelineItem>>,
    seq: AtomicU64,
    replay: Mutex<VecDeque<SequencedEvent>>,
    events: broadcast::Sender<SequencedEvent>,
    agent: Mutex<Option<Box<dyn AgentSession>>>,
    pending_permissions: Mutex<Vec<PermissionRequest>>,
    /// Item ids settled during the current turn, flushed to disk when it ends.
    turn_items: Mutex<Vec<String>>,
    /// Item ids accumulated across the *whole* round, spanning however many
    /// adapter turns get folded into it. Unlike `turn_items`, this is not
    /// cleared by `flush_turn` — only by the round settling — because a
    /// round-ledger entry has to reference everything the round produced,
    /// not just the last adapter turn that happened to end it.
    round_items: Mutex<Vec<String>>,
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
            _ => return None,
        };
        self.current_trunk.push(item.id(), trunk_item)
    }

    /// Closes whatever trunk is still being built, if any, so a round that
    /// settles mid-trunk still reports it — unresolved, same as
    /// `record_trunk_item`. Idempotent: closing an already-empty builder
    /// returns `None`.
    fn close_current_trunk_pending(&mut self) -> Option<rounds::ClosedTrunk> {
        self.current_trunk.close()
    }

    /// Resolves a closed trunk into its final `TrunkSummary` — assigning it
    /// the next index — and appends it to this round's trunk list.
    fn push_resolved_trunk(&mut self, closed: rounds::ClosedTrunk, monologue_text: Option<&str>) {
        let index = self.closed_trunks.len() as u32;
        self.closed_trunks
            .push(closed.into_summary(index, monologue_text));
    }
}

pub struct SessionManager {
    store: Store,
    registry: Arc<Registry>,
    sessions: RwLock<HashMap<String, Arc<Live>>>,
    replay_window: usize,
}

impl SessionManager {
    pub fn new(store: Store, registry: Arc<Registry>, replay_window: usize) -> Self {
        SessionManager {
            store,
            registry,
            sessions: RwLock::new(HashMap::new()),
            replay_window: replay_window.max(1),
        }
    }

    pub async fn create(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        agent_id: &str,
        model_id: Option<String>,
        mode_id: Option<String>,
        title: Option<String>,
    ) -> Result<SessionSummary> {
        // Fail before creating anything if the agent is not real.
        self.registry.require(agent_id)?;

        let now = now_ms();
        let meta = SessionMeta {
            effort_id: None,
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
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
        };
        self.store.save_meta(&meta)?;
        let summary = meta.summary(SessionStatus::Idle);
        self.sessions
            .write()
            .await
            .insert(meta.id.clone(), Arc::new(Live::new(meta)));
        Ok(summary)
    }

    pub async fn fork(
        &self,
        session_id: &str,
        turn_id: &str,
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
        let adapter = self.registry.require(&source_meta.agent_id)?;
        if !adapter.capabilities().fork {
            anyhow::bail!(
                "the {} agent does not support forking",
                source_meta.agent_id
            );
        }

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
                TimelineItem::TurnSummary { stats, .. } => stats
                    .fork_checkpoint
                    .clone()
                    .ok_or_else(|| anyhow!("that turn has no Agent fork checkpoint"))?,
                _ => unreachable!("the index was selected by the same variant"),
            };
            (items[..=at].to_vec(), checkpoint)
        };

        self.ensure_started(&source, providers).await?;
        let persist = source
            .agent
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| anyhow!("the source session has no running agent"))?
            .fork(&checkpoint)
            .await?;

        let now = now_ms();
        let title = source_meta
            .title
            .as_deref()
            .and_then(|title| title_from(&format!("{title} · 分支")));
        let meta = SessionMeta {
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: source_meta.workspace_id,
            agent_id: source_meta.agent_id,
            title,
            cwd: source_meta.cwd,
            model_id: source_meta.model_id,
            mode_id: source_meta.mode_id,
            effort_id: source_meta.effort_id,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist: Some(persist),
            pending_permission: None,
        };
        self.store.save_meta(&meta)?;
        self.store
            .append_items(&meta.workspace_id, &meta.id, &items)?;
        let summary = meta.summary(SessionStatus::Idle);
        let forked = Arc::new(Live::new(meta));
        *forked.items.lock().await = items;
        self.sessions
            .write()
            .await
            .insert(summary.id.clone(), forked);
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
            .ok_or_else(|| anyhow!("no such session: {session_id}"))?;
        // Old session logs may predate the overview-only boundary. Never let
        // their historical tool payloads or reasoning leak back to a client.
        let loaded = self.store.load_items(&meta.workspace_id, &meta.id)?;
        let items: Vec<TimelineItem> = loaded.iter().map(overview::condense_item).collect();
        if items != loaded {
            self.store
                .replace_items(&meta.workspace_id, &meta.id, &items)?;
        }
        // One-time backfill for a session that predates the round ledger
        // (§8 step 2). A no-op as soon as `<session>.rounds.jsonl` exists,
        // so this never re-runs once it has — see `ensure_rounds_migrated`.
        if let Err(error) = self
            .store
            .ensure_rounds_migrated(&meta.workspace_id, &meta.id, &items)
        {
            tracing::warn!(
                "could not migrate the round ledger for {}: {error}",
                meta.id
            );
        }
        let live = Arc::new(Live::new(meta));
        *live.items.lock().await = items;
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

    /// Snapshot plus whatever the client missed, in one answer.
    ///
    /// `reset` tells the client the difference between "here is the gap" and
    /// "start over" — silently returning a partial history would leave holes
    /// nobody notices until a user asks where their message went.
    pub async fn subscribe(
        &self,
        session_id: &str,
        since_seq: Option<u64>,
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

        let snapshot = live.snapshot().await?;
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
        continues_round: Option<String>,
    ) -> Result<String> {
        let live = self.live(session_id).await?;
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
        let started = self
            .start_turn(
                &live,
                session_id,
                text,
                attachments,
                providers,
                continues_round,
            )
            .await;
        if started.is_err() {
            // Nothing is running after all, and a session stuck on Running would
            // refuse every later prompt.
            *live.status.lock().await = SessionStatus::Idle;
        }
        started
    }

    async fn start_turn(
        &self,
        live: &Arc<Live>,
        session_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        providers: &ProviderMap,
        continues_round: Option<String>,
    ) -> Result<String> {
        self.ensure_started(live, providers).await?;

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
            .append_items(&workspace_id, session_id, std::slice::from_ref(&item))?;

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
            .send(PromptInput { text, attachments })
            .await
            .context("handing the prompt to the agent")?;
        // Only recorded once the handover actually succeeded: a failed send
        // must not leave a round with zero adapter turns behind (`send`
        // resets status to Idle on this same error, as if it never happened).
        if let Some((superseded, item_ids)) = live
            .begin_round(continues_round.as_deref(), &turn_id, item.id())
            .await
        {
            tracing::info!(
                "round {} superseded by a new message ({} adapter turn(s), {}ms blocked)",
                superseded.round_id,
                superseded.adapter_turn_ids.len(),
                superseded.blocked_ms
            );
            persist_round(live, &self.store, superseded, item_ids).await;
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
        let meta = live.meta.lock().await.clone();
        let adapter = self.registry.require(&meta.agent_id)?;

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

        let scratch = self.store.scratch_dir(&meta.workspace_id, &meta.id);
        std::fs::create_dir_all(&scratch)?;

        let session = adapter
            .start(SessionConfig {
                session_id: meta.id.clone(),
                cwd: meta.cwd.clone(),
                model_id: meta.model_id.clone(),
                mode_id: mode_override.or_else(|| meta.mode_id.clone()),
                effort_id: meta.effort_id.clone(),
                scratch_dir: scratch,
                providers: providers.clone(),
                resume: meta.persist.clone(),
            })
            .await
            .with_context(|| format!("starting the {} agent", meta.agent_id))?;

        let receiver = session.events();
        if let Some(handle) = session.persistence() {
            let mut meta = live.meta.lock().await;
            meta.persist = Some(handle);
            self.store.save_meta(&meta)?;
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
        ));
        *live.pump.lock().await = Some(pump);
        Ok(())
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        let agent = live.agent.lock().await;
        match agent.as_ref() {
            Some(agent) => agent.interrupt().await,
            // Nothing running is not a failure: the user pressed stop late.
            None => Ok(()),
        }
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

    /// Same shape as `set_model`, and for the same two reasons.
    pub async fn set_mode(
        &self,
        session_id: &str,
        mode_id: &str,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
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
            if let Some((round, item_ids)) = live.settle_round(RoundOutcome::Canceled).await {
                persist_round(&live, &self.store, round, item_ids).await;
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
            live.shutdown().await;
        }
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
        live.shutdown().await;
        Ok(())
    }

    /// Stops every agent process. Called on daemon shutdown so no orphan
    /// children survive the tray exiting.
    pub async fn shutdown(&self) {
        let sessions: Vec<Arc<Live>> = self
            .sessions
            .write()
            .await
            .drain()
            .map(|(_, v)| v)
            .collect();
        for live in sessions {
            live.shutdown().await;
        }
    }
}

impl Live {
    fn new(meta: SessionMeta) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        let pending = meta.pending_permission.clone();
        Live {
            meta: Mutex::new(meta),
            status: Mutex::new(if pending.is_some() {
                SessionStatus::Waiting
            } else {
                SessionStatus::Idle
            }),
            items: Mutex::new(Vec::new()),
            seq: AtomicU64::new(0),
            replay: Mutex::new(VecDeque::new()),
            events,
            agent: Mutex::new(None),
            pending_permissions: Mutex::new(pending.into_iter().collect()),
            turn_items: Mutex::new(Vec::new()),
            round_items: Mutex::new(Vec::new()),
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
    /// Adds a user-message id to the open round's ledger-bound set, if not
    /// already present. Used only by `begin_round`, for the message that
    /// starts every `session.send` — it is written directly to disk before
    /// the agent runs and so never passes through `apply`. A user message
    /// never participates in trunk boundaries (§3.2 direction three), so
    /// this never touches trunk bookkeeping.
    async fn record_round_item_id(&self, item_id: &str) {
        let mut round_items = self.round_items.lock().await;
        if !round_items.iter().any(|id| id == item_id) {
            round_items.push(item_id.to_string());
        }
    }

    /// Adds an item to the open round's ledger-bound set and feeds it into
    /// the round's trunk pagination (`ActiveRound::record_trunk_item`, §3.2
    /// direction three). Idempotent: an item id already recorded for this
    /// round is not counted twice, even if the adapter re-sends a full
    /// `Item` event for it — this is also what keeps trunk boundaries from
    /// double-counting a re-sent item.
    async fn record_round_item(&self, item: &TimelineItem) {
        {
            let mut round_items = self.round_items.lock().await;
            if round_items.iter().any(|id| id == item.id()) {
                return;
            }
            round_items.push(item.id().to_string());
        }
        let closed = {
            let mut active = self.active_round.lock().await;
            match active.as_mut() {
                Some(round) if round.outcome.is_none() => round.record_trunk_item(item),
                _ => None,
            }
        };
        if let Some(closed) = closed {
            self.finish_trunk(closed).await;
        }
    }

    /// Looks up a monologue item's *current* text in the live item store —
    /// not whatever it held the moment it first arrived, which for a
    /// streamed `AssistantMessage` is typically still empty (deltas fill it
    /// in afterward). By the time a trunk boundary is known — a later item
    /// started, meaning the adapter moved on, or the round itself settled —
    /// the monologue that opened the trunk has necessarily finished
    /// streaming, so this always sees its final text.
    async fn resolve_monologue_text(&self, item_id: Option<&str>) -> Option<String> {
        let id = item_id?;
        let items = self.items.lock().await;
        items.iter().find_map(|candidate| match candidate {
            TimelineItem::AssistantMessage {
                id: candidate_id,
                text,
            } if candidate_id == id => Some(text.clone()),
            _ => None,
        })
    }

    /// Resolves a just-closed trunk's overview and appends it to the round's
    /// trunk list — split from `record_round_item` so the `items` lock
    /// (needed to resolve the overview) and the `active_round` lock (needed
    /// to append it) are never held at the same time.
    async fn finish_trunk(&self, closed: rounds::ClosedTrunk) {
        let monologue_text = self
            .resolve_monologue_text(closed.monologue_item_id.as_deref())
            .await;
        let mut active = self.active_round.lock().await;
        if let Some(round) = active.as_mut() {
            round.push_resolved_trunk(closed, monologue_text.as_deref());
        }
    }

    /// Returns the round that was cut short together with the item ids it
    /// had accumulated, if any — `None` both when the round continues and
    /// when there was nothing open to cut short (an already-settled round is
    /// just replaced, not "superseded": nothing was taken from it). The
    /// caller persists this pair to the round ledger (`session/rounds.rs`).
    async fn begin_round(
        &self,
        continues_round: Option<&str>,
        turn_id: &str,
        user_item_id: &str,
    ) -> Option<(ActiveRound, Vec<String>)> {
        let mut active = self.active_round.lock().await;
        if let Some(current) = active.as_mut() {
            if current.outcome.is_none() && continues_round == Some(current.round_id.as_str()) {
                if !current.adapter_turn_ids.iter().any(|id| id == turn_id) {
                    current.adapter_turn_ids.push(turn_id.to_string());
                }
                drop(active);
                self.record_round_item_id(user_item_id).await;
                return None;
            }
        }
        let mut superseded = match active.take() {
            Some(mut dangling) if dangling.outcome.is_none() => {
                dangling.outcome = Some(RoundOutcome::Superseded);
                Some(dangling)
            }
            _ => None,
        };
        *active = Some(ActiveRound {
            round_id: format!("r_{}", uuid::Uuid::new_v4().simple()),
            adapter_turn_ids: vec![turn_id.to_string()],
            started_at_ms: now_ms(),
            blocked_since_ms: None,
            blocked_ms: 0,
            outcome: None,
            current_trunk: TrunkBuilder::default(),
            closed_trunks: Vec::new(),
        });
        drop(active);
        // `dangling` is already detached from the shared state above, so
        // resolving and appending its last trunk needs no `active_round`
        // lock at all — only the `items` lock inside `resolve_monologue_text`.
        if let Some(dangling) = superseded.as_mut() {
            if let Some(closed) = dangling.close_current_trunk_pending() {
                let monologue_text = self
                    .resolve_monologue_text(closed.monologue_item_id.as_deref())
                    .await;
                dangling.push_resolved_trunk(closed, monologue_text.as_deref());
            }
        }
        let superseded_items = std::mem::take(&mut *self.round_items.lock().await);
        self.record_round_item_id(user_item_id).await;
        superseded.map(|round| (round, superseded_items))
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
    async fn settle_round(&self, outcome: RoundOutcome) -> Option<(ActiveRound, Vec<String>)> {
        let pending_trunk = {
            let mut active = self.active_round.lock().await;
            let round = active.as_mut()?;
            if round.outcome.is_some() {
                return None;
            }
            if let Some(since) = round.blocked_since_ms.take() {
                round.blocked_ms += (now_ms() - since).max(0);
            }
            round.outcome = Some(outcome);
            round.close_current_trunk_pending()
        };
        if let Some(closed) = pending_trunk {
            self.finish_trunk(closed).await;
        }
        let settled = self.active_round.lock().await.clone()?;
        let item_ids = std::mem::take(&mut *self.round_items.lock().await);
        Some((settled, item_ids))
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
    let PermissionOutcome::Selected { option_id } = outcome else {
        return Ok(None);
    };
    let option = request
        .options
        .iter()
        .find(|option| option.id == *option_id)
        .ok_or_else(|| anyhow!("'{option_id}' is not an option for this interaction"))?;

    match request.kind {
        PermissionRequestKind::Permission if option.kind == PermissionOptionKind::Reject => {
            Ok(None)
        }
        PermissionRequestKind::Permission => Ok(Some(Continuation {
            elevated: true,
            prompt: format!(
                "The user approved the interrupted permission request: {}. Resume the original \
                 task from the current conversation state and do not repeat completed work.",
                option.label
            ),
        })),
        PermissionRequestKind::Question => Ok(Some(Continuation {
            elevated: false,
            prompt: format!(
                "The user answered the interrupted question '{}': {}. Resume the original task \
                 from the current conversation state and do not repeat completed work.",
                request.title, option.label
            ),
        })),
    }
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
) {
    // Thinking streams one delta per token. Keep only the overview already
    // shown; even this transient pump state must never accumulate the raw
    // reasoning block. Item id → overview last sent (at most 24 characters).
    let mut thinking: HashMap<String, String> = HashMap::new();
    let mut turns: HashMap<String, (i64, HashSet<String>)> = HashMap::new();
    loop {
        let mut event = match receiver.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Closed) => {
                // No `TurnFailed`, no `TurnCanceled` — the adapter's own sender
                // just vanished (a crashed process is the ordinary cause). The
                // round the proposal calls out this exact gap for (§3.2
                // direction one, "adapter 事件通道关闭、子进程退出"): without
                // this, it stays open forever and whatever it already
                // produced never reaches disk.
                finalize_after_channel_closed(&live, &store).await;
                break;
            }
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                tracing::warn!("dropped {missed} agent events: the pump fell behind");
                continue;
            }
        };

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
                if let Some(stats) = turn_summary(&canceled, &mut turns) {
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

        let summary = turn_summary(&event, &mut turns);
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
                if let Some((round, item_ids)) = live.settle_round(RoundOutcome::Completed).await {
                    persist_round(&live, &store, round, item_ids).await;
                }
            }
            SessionEvent::TurnFailed { .. } => {
                if let Some((round, item_ids)) = live.settle_round(RoundOutcome::Failed).await {
                    persist_round(&live, &store, round, item_ids).await;
                }
            }
            _ => {}
        }

        live.publish(event).await;
        live.trim_replay(replay_window).await;

        if settle {
            thinking.clear();
            flush_turn(&live, &store).await;
        }
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
) -> Option<TurnStats> {
    let (turn_id, outcome, usage, fork_checkpoint) = match event {
        SessionEvent::TurnCompleted {
            turn_id,
            usage,
            fork_checkpoint,
        } => (
            turn_id,
            TurnOutcome::Completed,
            usage.clone(),
            fork_checkpoint.clone(),
        ),
        SessionEvent::TurnFailed { turn_id, .. } => {
            (turn_id, TurnOutcome::Failed, Usage::default(), None)
        }
        SessionEvent::TurnCanceled { turn_id } => {
            (turn_id, TurnOutcome::Canceled, Usage::default(), None)
        }
        _ => return None,
    };
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
    let Some((round, item_ids)) = live.settle_round(RoundOutcome::Failed).await else {
        return;
    };
    persist_round(live, store, round, item_ids).await;
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

/// Appends a settled round to `<session>/session.rounds.jsonl`
/// (`session/rounds.rs`, §8 step 2).
///
/// Failure is logged, not propagated: a missing ledger entry degrades a
/// later cross-session query to "this round is invisible to it", not data
/// loss — the round's own items already reached `session.jsonl` via
/// `flush_turn`, this is only the referencing record.
async fn persist_round(live: &Arc<Live>, store: &Store, round: ActiveRound, item_ids: Vec<String>) {
    let Some(outcome) = round.outcome else {
        // Should not happen: every caller only reaches here after setting an
        // outcome. Guarded anyway rather than unwrapped, because a ledger
        // write is not worth a panic over.
        return;
    };
    let (workspace_id, session_id) = {
        let meta = live.meta.lock().await;
        (meta.workspace_id.clone(), meta.id.clone())
    };
    let record = RoundRecord {
        schema_version: rounds::SCHEMA_VERSION,
        round_id: round.round_id,
        started_at_ms: round.started_at_ms,
        ended_at_ms: now_ms(),
        outcome,
        adapter_turn_ids: round.adapter_turn_ids,
        item_ids,
        blocked_ms: round.blocked_ms,
        synthesized: false,
        trunk_summaries: round.closed_trunks,
    };
    if let Err(error) = store.append_round(&workspace_id, &session_id, &record) {
        tracing::error!("could not persist a round ledger entry for {session_id}: {error}");
    }
}

/// Writes the items this turn produced, once, when the turn ends.
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
    if let Err(error) = store.append_items(&workspace_id, &session_id, &settled) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{ToolCallDetail, TurnError, TurnErrorCode, Usage};

    fn meta() -> SessionMeta {
        SessionMeta {
            effort_id: None,
            id: "s1".into(),
            workspace_id: "w1".into(),
            agent_id: "genet".into(),
            title: None,
            cwd: PathBuf::from("/tmp"),
            model_id: None,
            mode_id: None,
            created_at_ms: 0,
            updated_at_ms: 0,
            archived: false,
            persist: None,
            pending_permission: None,
        }
    }

    fn item(id: &str, text: &str) -> TimelineItem {
        TimelineItem::AssistantMessage {
            id: id.into(),
            text: text.into(),
        }
    }

    /// A manager over a throwaway directory. Neither rename nor delete asks the
    /// registry anything, so an empty one is enough to exercise both.
    fn manager(root: &std::path::Path) -> SessionManager {
        SessionManager::new(
            Store::new(root),
            Arc::new(Registry::new(&std::collections::BTreeMap::new())),
            16,
        )
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
            .append_items("w1", "s1", &[item("a", "hi")])
            .unwrap();
        let scratch = sessions.store.scratch_dir("w1", "s1");
        std::fs::create_dir_all(&scratch).unwrap();

        sessions.delete("s1").await.unwrap();

        assert!(sessions.store.list_meta().unwrap().is_empty());
        assert!(sessions.store.load_items("w1", "s1").unwrap().is_empty());
        assert!(
            !scratch.exists(),
            "the agent's own copy of the conversation outlived the delete"
        );
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
    async fn an_item_is_upserted_rather_than_duplicated() {
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
        let request = PermissionRequest {
            id: "p1".into(),
            kind: PermissionRequestKind::Permission,
            title: "Write file".into(),
            detail: None,
            tool_call_id: None,
            options: vec![],
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
        let live = Arc::new(Live::new(meta()));
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
        let store = Store::new(dir.path());
        let live = Arc::new(Live::new(meta()));
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

    #[tokio::test]
    async fn a_persisted_interaction_rehydrates_as_waiting_without_an_agent() {
        let mut stored = meta();
        stored.pending_permission = Some(interaction(PermissionRequestKind::Permission));
        let live = Live::new(stored);
        let snapshot = live.snapshot().await.unwrap();
        assert_eq!(snapshot.summary.status, SessionStatus::Waiting);
        assert_eq!(snapshot.pending_permissions.len(), 1);
        assert!(live.agent.lock().await.is_none());
    }

    #[tokio::test]
    async fn a_failed_turn_stays_visible_as_failed_but_remains_retryable() {
        let live = Arc::new(Live::new(meta()));
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
        let store = Store::new(dir.path());
        let live = Arc::new(Live::new(meta()));

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

        let written = store.load_items("w1", "s1").unwrap();
        assert_eq!(written.len(), 1, "the prompt was persisted on arrival");
        assert_eq!(written[0].id(), "a");
    }

    #[tokio::test]
    async fn the_replay_buffer_is_bounded() {
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
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
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let live = Arc::new(Live::new(meta()));
        let (agent_events, _) = broadcast::channel(64);
        let mut seen = live.events.subscribe();
        let pump = tokio::spawn(pump_events(
            live.clone(),
            agent_events.subscribe(),
            store.clone(),
            64,
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
        tokio::time::sleep(Duration::from_millis(50)).await;
        let on_disk = store.load_items("w1", "s1").unwrap();
        (wire, on_disk, pump, agent_events)
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

        let (wire, on_disk, pump, agent_events) = pumped(script).await;
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
        let persisted = on_disk
            .iter()
            .find(|item| item.id() == "r")
            .expect("the thinking block is in the log");
        match persisted {
            TimelineItem::Reasoning { text, .. } => {
                assert_eq!(text.chars().count(), overview::REASONING_CHARS);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// A shell command's output is the heaviest ordinary payload there is.
    /// The card keeps only three short strings; the wall of text goes no
    /// further than the agent.
    #[tokio::test]
    async fn a_tool_calls_payload_stays_behind_the_access_layer() {
        let output = "a line of build output\n".repeat(500);
        let (wire, on_disk, pump, agent_events) = pumped(vec![
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
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
        live.begin_round(None, "t0", "u0").await;
        let first_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let (superseded, item_ids) = live
            .begin_round(None, "t1", "u1")
            .await
            .expect("the dangling round was cut short");
        assert_eq!(superseded.round_id, first_round_id);
        assert_eq!(superseded.outcome, Some(RoundOutcome::Superseded));
        assert_eq!(superseded.adapter_turn_ids, vec!["t0".to_string()]);
        assert_eq!(
            item_ids,
            vec!["u0".to_string()],
            "the superseded round keeps the item it had accumulated"
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
        let live = Arc::new(Live::new(meta()));
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
            *live.round_items.lock().await,
            vec!["u0".to_string(), "u1".to_string()],
            "both turns' user messages belong to the one round"
        );
    }

    #[tokio::test]
    async fn a_continues_round_naming_an_unknown_round_starts_a_fresh_one() {
        let live = Arc::new(Live::new(meta()));
        live.begin_round(None, "t0", "u0").await;
        let real_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let (superseded, item_ids) = live
            .begin_round(Some("r_does_not_exist"), "t1", "u1")
            .await
            .expect("the real dangling round is still cut short");
        assert_eq!(superseded.round_id, real_round_id);
        assert_eq!(item_ids, vec!["u0".to_string()]);

        let current = live.active_round.lock().await.clone().unwrap();
        assert_ne!(
            current.round_id, real_round_id,
            "an unrecognized continuesRound must not be trusted"
        );
        assert_eq!(current.adapter_turn_ids, vec!["t1".to_string()]);
    }

    #[tokio::test]
    async fn a_settled_round_is_replaced_quietly_not_marked_superseded_again() {
        let live = Arc::new(Live::new(meta()));
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
        let live = Arc::new(Live::new(meta()));
        live.begin_round(None, "t0", "u0").await;

        let (_, item_ids) = live
            .settle_round(RoundOutcome::Completed)
            .await
            .expect("the round was open");
        assert_eq!(item_ids, vec!["u0".to_string()]);
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
        let live = Arc::new(Live::new(meta()));
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
    }

    impl FakeSession {
        fn sharing(events: broadcast::Sender<SessionEvent>, next_turn: Arc<AtomicU64>) -> Self {
            FakeSession { events, next_turn }
        }
    }

    #[async_trait::async_trait]
    impl AgentSession for FakeSession {
        fn events(&self) -> broadcast::Receiver<SessionEvent> {
            self.events.subscribe()
        }

        async fn send(&self, _input: PromptInput) -> Result<String> {
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
        let (events, _) = broadcast::channel(64);
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
        ));
        *live.pump.lock().await = Some(pump);
        (sessions, events, turn_ids)
    }

    #[tokio::test]
    async fn a_round_completes_with_a_single_adapter_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send("s1", "hello".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let live = sessions.live("s1").await.unwrap();
        let round = live
            .active_round
            .lock()
            .await
            .clone()
            .expect("a round was opened");
        assert_eq!(round.adapter_turn_ids, vec![turn_id.clone()]);
        assert_eq!(round.outcome, Some(RoundOutcome::Completed));

        let on_disk = sessions.store.load_items("w1", "s1").unwrap();
        let user_item_id = on_disk
            .iter()
            .find_map(|item| match item {
                TimelineItem::UserMessage { id, .. } => Some(id.clone()),
                _ => None,
            })
            .expect("the prompt was written to disk");

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(rounds.len(), 1, "one settled round must be ledgered");
        assert_eq!(rounds[0].round_id, round.round_id);
        assert_eq!(rounds[0].outcome, RoundOutcome::Completed);
        assert_eq!(rounds[0].adapter_turn_ids, vec![turn_id]);
        assert!(rounds[0].item_ids.contains(&user_item_id));
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
            .send("s1", "do a bunch of stuff".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(rounds.len(), 1, "one settled round must be ledgered");
        let trunks = &rounds[0].trunk_summaries;
        assert_eq!(
            trunks.len(),
            2,
            "the second monologue must close the first trunk and open a second"
        );
        assert_eq!(trunks[0].index, 0);
        assert_eq!(trunks[0].first_item_id, "a1");
        assert_eq!(
            trunks[0].item_count, 2,
            "the opening monologue is not counted"
        );
        assert_eq!(trunks[0].overview, "reading the config first");
        assert_eq!(trunks[1].index, 1);
        assert_eq!(trunks[1].first_item_id, "a2");
        assert_eq!(
            trunks[1].item_count, 0,
            "settling the round must close the still-open second trunk, even with no work in it"
        );
        assert_eq!(trunks[1].overview, "now applying the change");
    }

    /// A round that never narrates still gets paginated: the 32-item cap is
    /// what protects the byte budget when an agent (like `genet`, which the
    /// proposal notes is prompted to "be concise") produces long runs of
    /// tool calls with no monologue in between.
    #[tokio::test]
    async fn a_round_with_no_monologue_at_all_still_paginates_at_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send("s1", "run a lot of tools".into(), vec![], &providers, None)
            .await
            .expect("accepted");
        events
            .send(SessionEvent::TurnStarted {
                turn_id: turn_id.clone(),
                started_at_ms: 1,
            })
            .unwrap();
        for i in 0..40u32 {
            events
                .send(SessionEvent::Item {
                    turn_id: turn_id.clone(),
                    item: tool_call(&format!("t{i}"), "grep"),
                })
                .unwrap();
        }
        events
            .send(SessionEvent::TurnCompleted {
                turn_id: turn_id.clone(),
                usage: Usage::default(),
                fork_checkpoint: None,
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        let trunks = &rounds[0].trunk_summaries;
        assert_eq!(
            trunks.len(),
            2,
            "40 tool calls split into a full 32-item trunk and an 8-item tail"
        );
        assert_eq!(trunks[0].item_count, 32);
        assert_eq!(trunks[0].overview, "运行了 32 次工具（grep）");
        assert_eq!(trunks[1].item_count, 8);
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
            .send("s1", "do the thing".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let live = sessions.live("s1").await.unwrap();
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let round = live.active_round.lock().await.clone().unwrap();
        assert_eq!(round.round_id, round_id_before);
        assert_eq!(round.outcome, Some(RoundOutcome::Completed));
        assert!(
            round.blocked_ms >= 0,
            "the wait for the approval was tracked"
        );

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(
            rounds.len(),
            1,
            "two adapter turns stitched into one round must ledger as one record, not two"
        );
        assert_eq!(rounds[0].round_id, round_id_before);
        assert_eq!(rounds[0].adapter_turn_ids.len(), 2);
        assert_eq!(rounds[0].outcome, RoundOutcome::Completed);
    }

    #[tokio::test]
    async fn denying_a_permission_settles_the_round_without_a_continuation() {
        let dir = tempfile::tempdir().unwrap();
        let (sessions, events, _) = wired(dir.path()).await;
        let providers = ProviderMap::new();

        let turn_id = sessions
            .send("s1", "do the thing".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let live = sessions.live("s1").await.unwrap();
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

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].outcome, RoundOutcome::Canceled);
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
            .send("s1", "count to 500".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let live = sessions.live("s1").await.unwrap();
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

        assert!(
            sessions.store.load_rounds("w1", "s1").unwrap().is_empty(),
            "a round that is still open must not appear in the ledger yet"
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
            .send("s1", "count to 500".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        let live = sessions.live("s1").await.unwrap();
        let dangling_round_id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .unwrap()
            .round_id
            .clone();

        let second_turn = sessions
            .send("s1", "what's the weather".into(), vec![], &providers, None)
            .await
            .expect("accepted");

        let round = live.active_round.lock().await.clone().unwrap();
        assert_ne!(
            round.round_id, dangling_round_id,
            "no continuesRound means a fresh round, not a guess"
        );
        assert_eq!(round.adapter_turn_ids, vec![second_turn]);

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(
            rounds.len(),
            1,
            "the superseded round must be ledgered even though it never got a terminal adapter event"
        );
        assert_eq!(rounds[0].round_id, dangling_round_id);
        assert_eq!(rounds[0].outcome, RoundOutcome::Superseded);
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
            .send("s1", "hello".into(), vec![], &providers, None)
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
        tokio::time::sleep(Duration::from_millis(50)).await;

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

        let on_disk = sessions.store.load_items("w1", "s1").unwrap();
        assert!(
            on_disk.iter().any(|stored| stored.id() == "a"),
            "the item produced before the crash must still reach disk"
        );

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(
            rounds.len(),
            1,
            "the empty-looking round must still be ledgered"
        );
        assert_eq!(rounds[0].outcome, RoundOutcome::Failed);
        assert!(
            rounds[0].item_ids.contains(&"a".to_string()),
            "the round ledger must reference what the crash did manage to produce"
        );
    }

    /// A session written before the round ledger existed gets one backfilled
    /// on first open, and never again (§8 step 2's "旧会话按缺 blob 层降级为
    /// 只读投影视图" analogue for the ledger: migrate once, then leave it be).
    #[tokio::test]
    async fn an_old_session_gets_its_round_ledger_backfilled_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = manager(dir.path());
        sessions.store.save_meta(&meta()).unwrap();
        sessions
            .store
            .append_items(
                "w1",
                "s1",
                &[
                    TimelineItem::UserMessage {
                        id: "u1".into(),
                        text: "hi".into(),
                        attachments: vec![],
                    },
                    TimelineItem::TurnSummary {
                        id: "turn-summary-t1".into(),
                        stats: TurnStats {
                            turn_id: "t1".into(),
                            outcome: TurnOutcome::Completed,
                            started_at_ms: 1,
                            finished_at_ms: 2,
                            duration_ms: 1,
                            usage: Usage::default(),
                            tool_calls: 0,
                            fork_checkpoint: None,
                        },
                    },
                ],
            )
            .unwrap();
        assert!(sessions.store.load_rounds("w1", "s1").unwrap().is_empty());

        sessions.live("s1").await.unwrap();
        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(
            rounds.len(),
            1,
            "the historical turn is backfilled as one synthesized round"
        );
        assert!(rounds[0].synthesized);
        assert_eq!(rounds[0].round_id, "legacy_r_t1");
        assert_eq!(rounds[0].outcome, RoundOutcome::Completed);

        // Append a real round directly, as if it had settled after the
        // migration ran, then force a cold reload (as a daemon restart
        // would) to prove the second `live()` call does not re-migrate and
        // clobber it.
        sessions
            .store
            .append_round(
                "w1",
                "s1",
                &RoundRecord {
                    schema_version: rounds::SCHEMA_VERSION,
                    round_id: "r_after_migration".into(),
                    started_at_ms: 10,
                    ended_at_ms: 11,
                    outcome: RoundOutcome::Completed,
                    adapter_turn_ids: vec!["t2".into()],
                    item_ids: vec![],
                    blocked_ms: 0,
                    synthesized: false,
                    trunk_summaries: vec![],
                },
            )
            .unwrap();
        sessions.sessions.write().await.clear();
        sessions.live("s1").await.unwrap();

        let rounds = sessions.store.load_rounds("w1", "s1").unwrap();
        assert_eq!(
            rounds.len(),
            2,
            "the round appended after migration must survive a second load untouched"
        );
        assert_eq!(rounds[0].round_id, "legacy_r_t1");
        assert_eq!(rounds[1].round_id, "r_after_migration");
    }
}
