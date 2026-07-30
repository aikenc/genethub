//! Session lifecycle: create, run, persist, replay.
//!
//! Everything here is agent-agnostic. The manager holds a `dyn AgentSession`
//! and never learns which adapter produced it.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    Attachment, ItemDelta, PermissionOutcome, PermissionRequest, SequencedEvent, SessionEvent,
    SessionSnapshot, SessionStatus, SessionSummary, TimelineItem, ToolStatus,
};
use tokio::sync::{broadcast, Mutex, RwLock};

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
    pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
        };
        self.store.save_meta(&meta)?;
        let summary = meta.summary(SessionStatus::Idle);
        self.sessions
            .write()
            .await
            .insert(meta.id.clone(), Arc::new(Live::new(meta)));
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
        let items = self.store.load_items(&meta.workspace_id, &meta.id)?;
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
            // A live session knows its status; a stored one is idle by default.
            let status = match self.sessions.read().await.get(&meta.id) {
                Some(live) => *live.status.lock().await,
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
    ) -> Result<String> {
        let live = self.live(session_id).await?;
        {
            let mut status = live.status.lock().await;
            if *status == SessionStatus::Running {
                return Err(anyhow!("a turn is already running in this session"));
            }
            // Claimed before the handover, not after it: a second send arriving
            // while the first is still being handed over has to lose the race
            // rather than join it.
            *status = SessionStatus::Running;
        }
        let started = self
            .start_turn(&live, session_id, text, attachments, providers)
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
                mode_id: meta.mode_id.clone(),
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

    pub async fn set_model(&self, session_id: &str, model_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        {
            let mut meta = live.meta.lock().await;
            meta.model_id = Some(model_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        if let Some(agent) = live.agent.lock().await.as_ref() {
            agent.set_model(model_id).await?;
        }
        Ok(())
    }

    pub async fn set_effort(&self, session_id: &str, effort_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        {
            let mut meta = live.meta.lock().await;
            meta.effort_id = Some(effort_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        if let Some(agent) = live.agent.lock().await.as_ref() {
            agent.set_effort(effort_id).await?;
        }
        Ok(())
    }

    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        {
            let mut meta = live.meta.lock().await;
            meta.mode_id = Some(mode_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
        }
        if let Some(agent) = live.agent.lock().await.as_ref() {
            agent.set_mode(mode_id).await?;
        }
        Ok(())
    }

    pub async fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: PermissionOutcome,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        {
            let mut pending = live.pending_permissions.lock().await;
            pending.retain(|request| request.id != request_id);
        }
        let agent = live.agent.lock().await;
        let agent = agent
            .as_ref()
            .ok_or_else(|| anyhow!("the session has no running agent"))?;
        agent.respond_permission(request_id, outcome).await
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
        Live {
            meta: Mutex::new(meta),
            status: Mutex::new(SessionStatus::Idle),
            items: Mutex::new(Vec::new()),
            seq: AtomicU64::new(0),
            replay: Mutex::new(VecDeque::new()),
            events,
            agent: Mutex::new(None),
            pending_permissions: Mutex::new(Vec::new()),
            turn_items: Mutex::new(Vec::new()),
            pump: Mutex::new(None),
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

/// How long an approval may sit with nobody in a position to answer it.
///
/// Counted only while no client is subscribed. Someone looking at the approval
/// card is allowed to think for as long as they like — denying a tool call under
/// an attentive person's cursor is worse than waiting. But with every window
/// closed the card is on no screen at all, and the turn, the agent process and
/// whatever the tool was about to do all wait forever
/// (`docs/testing.md` §4.2).
const UNATTENDED_GRACE: Duration = Duration::from_secs(120);

/// How often the grace is reconsidered. Coarse on purpose: this is a deadline,
/// not a stopwatch, and it runs once per outstanding approval.
const UNATTENDED_TICK: Duration = Duration::from_secs(5);

/// Answers an approval that nobody can see, once waiting stops being plausible.
///
/// It answers through the same door a person does, so the agent hears one denial
/// on the channel it is listening to and the timeline gets one resolution — the
/// alternative is a state where the daemon believes it is resolved and the agent
/// is still blocked.
async fn deny_when_no_one_can_answer(live: Arc<Live>, request_id: String, grace: Duration) {
    let mut unattended = Duration::ZERO;
    loop {
        tokio::time::sleep(UNATTENDED_TICK).await;

        let outstanding = live
            .pending_permissions
            .lock()
            .await
            .iter()
            .any(|request| request.id == request_id);
        if !outstanding {
            return;
        }
        if live.events.receiver_count() > 0 {
            // Someone is watching, so the clock goes back to zero: a person who
            // steps away for a minute and comes back should still find the card.
            unattended = Duration::ZERO;
            continue;
        }
        unattended += UNATTENDED_TICK;
        if unattended < grace {
            continue;
        }

        let agent = live.agent.lock().await;
        let Some(agent) = agent.as_ref() else { return };
        // The default is named in the outcome rather than implied, because the
        // audit trail has to say what was applied and by whom.
        let outcome = PermissionOutcome::TimedOut {
            applied_default: "deny".into(),
        };
        if let Err(error) = agent.respond_permission(&request_id, outcome).await {
            tracing::warn!("could not deny the unattended approval {request_id}: {error}");
        }
        return;
    }
}

/// Folds adapter events into session state, then republishes them.
async fn pump_events(
    live: Arc<Live>,
    mut receiver: broadcast::Receiver<SessionEvent>,
    store: Store,
    replay_window: usize,
) {
    loop {
        let event = match receiver.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Closed) => break,
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                tracing::warn!("dropped {missed} agent events: the pump fell behind");
                continue;
            }
        };

        apply(&live, &event).await;

        if let SessionEvent::PermissionRequested { request } = &event {
            tokio::spawn(deny_when_no_one_can_answer(
                live.clone(),
                request.id.clone(),
                UNATTENDED_GRACE,
            ));
        }

        let settle = matches!(
            event,
            SessionEvent::TurnCompleted { .. }
                | SessionEvent::TurnFailed { .. }
                | SessionEvent::TurnCanceled { .. }
        );

        live.publish(event).await;
        live.trim_replay(replay_window).await;

        if settle {
            flush_turn(&live, &store).await;
        }
    }
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
            let mut turn_items = live.turn_items.lock().await;
            if !turn_items.iter().any(|id| id == item.id()) {
                turn_items.push(item.id().to_string());
            }
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
            live.pending_permissions.lock().await.push(request.clone());
        }
        SessionEvent::PermissionResolved { request_id, .. } => {
            live.pending_permissions
                .lock()
                .await
                .retain(|request| &request.id != request_id);
        }
        SessionEvent::TurnStarted { .. } => {
            *live.status.lock().await = SessionStatus::Running;
        }
        SessionEvent::TurnCompleted { .. } | SessionEvent::TurnCanceled { .. } => {
            *live.status.lock().await = SessionStatus::Idle;
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
            // Failed, not closed: the user can send again.
            *live.status.lock().await = SessionStatus::Idle;
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
        }
    }

    fn item(id: &str, text: &str) -> TimelineItem {
        TimelineItem::AssistantMessage {
            id: id.into(),
            text: text.into(),
        }
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
    }

    /// Stands in for an agent that has asked for approval and is waiting. It only
    /// has to record the answer: whether the agent then denies or allows is the
    /// adapter's business, tested where the adapters are.
    struct WaitingAgent {
        answers: Arc<Mutex<Vec<(String, PermissionOutcome)>>>,
        events: broadcast::Sender<SessionEvent>,
    }

    #[async_trait::async_trait]
    impl AgentSession for WaitingAgent {
        fn events(&self) -> broadcast::Receiver<SessionEvent> {
            self.events.subscribe()
        }
        async fn send(&self, _input: PromptInput) -> Result<String> {
            Ok("t".into())
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
            request_id: &str,
            outcome: PermissionOutcome,
        ) -> Result<()> {
            self.answers
                .lock()
                .await
                .push((request_id.to_string(), outcome));
            Ok(())
        }
    }

    async fn waiting_on_approval() -> (Arc<Live>, Arc<Mutex<Vec<(String, PermissionOutcome)>>>) {
        let live = Arc::new(Live::new(meta()));
        let answers = Arc::new(Mutex::new(Vec::new()));
        let (events, _) = broadcast::channel(8);
        *live.agent.lock().await = Some(Box::new(WaitingAgent {
            answers: answers.clone(),
            events,
        }));
        apply(
            &live,
            &SessionEvent::PermissionRequested {
                request: PermissionRequest {
                    id: "p1".into(),
                    title: "Write file".into(),
                    detail: None,
                    tool_call_id: None,
                    options: vec![],
                },
            },
        )
        .await;
        (live, answers)
    }

    /// The window is closed, the tray is still there, and the agent is blocked on
    /// a question that is on nobody's screen. Left alone this waits until the
    /// daemon exits, holding the turn and the agent process with it.
    #[tokio::test]
    async fn an_approval_no_one_can_see_is_denied_rather_than_waited_on_forever() {
        let (live, answers) = waiting_on_approval().await;

        deny_when_no_one_can_answer(live.clone(), "p1".into(), Duration::from_millis(1)).await;

        let answers = answers.lock().await;
        assert_eq!(answers.len(), 1, "the agent was never answered");
        assert_eq!(answers[0].0, "p1");
        // Named, not implied: the audit trail has to distinguish this from a
        // person who chose to deny.
        assert!(
            matches!(
                &answers[0].1,
                PermissionOutcome::TimedOut { applied_default } if applied_default == "deny"
            ),
            "answered with {:?} instead of a recorded timeout",
            answers[0].1
        );
    }

    /// The opposite mistake, and the worse one: denying a tool call while someone
    /// is sitting there reading the request. Thinking is not idleness.
    #[tokio::test]
    async fn an_approval_someone_is_looking_at_is_left_alone() {
        let (live, answers) = waiting_on_approval().await;
        let _watching = live.events.subscribe();

        let verdict = tokio::time::timeout(
            Duration::from_millis(200),
            deny_when_no_one_can_answer(live.clone(), "p1".into(), Duration::from_millis(1)),
        )
        .await;

        assert!(
            verdict.is_err(),
            "gave up on a request that a subscribed client could still answer"
        );
        assert!(answers.lock().await.is_empty());
    }

    /// And it has to stop watching once the question is answered, or every
    /// approval leaves a task behind for the life of the session.
    #[tokio::test]
    async fn the_watch_ends_when_the_approval_is_answered() {
        let (live, answers) = waiting_on_approval().await;
        live.pending_permissions.lock().await.clear();

        tokio::time::timeout(
            Duration::from_secs(30),
            deny_when_no_one_can_answer(live.clone(), "p1".into(), Duration::from_millis(1)),
        )
        .await
        .expect("the watch should return once nothing is pending");

        assert!(
            answers.lock().await.is_empty(),
            "answered a request that had already been resolved"
        );
    }

    #[tokio::test]
    async fn a_failed_turn_leaves_the_session_usable() {
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
        assert_eq!(*live.status.lock().await, SessionStatus::Idle);
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
            })
            .await;
        match event.event {
            SessionEvent::TurnCompleted { usage, .. } => assert_eq!(usage.input_tokens, 10),
            other => panic!("unexpected {other:?}"),
        }
    }
}
