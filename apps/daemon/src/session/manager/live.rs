use super::*;

impl Live {
    pub(super) async fn claim_execution(
        &self,
        input_ids: Option<&[String]>,
    ) -> Result<Option<Execution>> {
        let _settings = self.runtime_settings.lock().await;
        let mut owner = self.execution.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            bail!("this session is closing");
        }
        if owner
            .as_ref()
            .is_some_and(|execution| execution.phase == ExecutionPhase::Saving)
        {
            flush_turn(self, &self.store).await?;
            owner.take();
        }
        if owner.is_some()
            || (input_ids.is_none() && *self.status.lock().await == SessionStatus::Waiting)
        {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Conflict,
                "a turn is already running or awaiting a response in this session".to_owned(),
            ));
        }
        // Recovered data or a failed final write must reach the log before a
        // new execution can replace its checkpoint.
        flush_turn(self, &self.store).await?;
        let meta = self.meta.lock().await;
        if let Some(ids) = input_ids {
            if meta.inbox.paused
                || ids.iter().any(|id| {
                    !meta.inbox.entries.iter().any(|entry| {
                        &entry.message_id == id && matches!(entry.state.as_str(), "queued" | "sent")
                    })
                })
            {
                return Ok(None);
            }
        }
        let execution = Execution::new(self.next_execution.fetch_add(1, Ordering::SeqCst));
        *owner = Some(execution.clone());
        drop(meta);
        *self.status.lock().await = SessionStatus::Running;
        self.publish(SessionEvent::SessionStatusChanged {
            status: SessionStatus::Running,
        })
        .await;
        Ok(Some(execution))
    }

    /// Called with the execution lock after event admission or resource
    /// retirement. This is the common commit for terminal paths.
    pub(super) async fn finish_execution(
        &self,
        owner: &mut Option<Execution>,
        event: SessionEvent,
        closed: bool,
    ) -> Result<()> {
        if closed {
            let deleted = {
                let meta = self.meta.lock().await;
                self.store.is_tombstoned(&meta.workspace_id, &meta.id)
            };
            if deleted {
                // The caller has stopped the pump and Agent. No turn or inbox
                // record should be saved after permanent logical deletion.
                if let Some(execution) = owner.take() {
                    execution.ready.send_replace(true);
                    execution.terminal.send_replace(true);
                }
                *self.status.lock().await = SessionStatus::Closed;
                self.publish(SessionEvent::SessionStatusChanged {
                    status: SessionStatus::Closed,
                })
                .await;
                return Ok(());
            }
        }
        let consultation = owner
            .as_ref()
            .is_some_and(|execution| execution.consultation);
        let outcome = match &event {
            _ if consultation && !closed => None,
            SessionEvent::TurnCompleted { .. } => Some(RoundOutcome::Completed),
            SessionEvent::TurnFailed { .. } => Some(RoundOutcome::Failed),
            _ if closed => Some(RoundOutcome::Canceled),
            _ => None, // A user can explicitly continue an interrupted round.
        };
        if let Some(outcome) = outcome {
            let by = if closed {
                Settling::Kernel
            } else {
                event_turn(&event)
                    .map(Settling::Turn)
                    .unwrap_or(Settling::Kernel)
            };
            if let Some(round) = self.settle_round(by, outcome).await {
                persist_round(self, round).await;
            }
        }
        if let Some(execution) = owner.as_mut() {
            execution.phase = ExecutionPhase::Saving;
            execution.ready.send_replace(true);
            execution.terminal.send_replace(true);
        }
        if let Err(error) = flush_turn(self, &self.store).await {
            let notice = SessionEvent::Item {
                turn_id: owner
                    .as_ref()
                    .and_then(|execution| execution.turn_id.clone())
                    .unwrap_or_default(),
                item: TimelineItem::Error {
                    id: format!(
                        "save-error-{}",
                        owner.as_ref().map(|execution| execution.id).unwrap_or(0)
                    ),
                    message: format!(
                        "保存回答失败，当前内容仍保留在会话中；下次发送会先重试保存：{error}"
                    ),
                },
            };
            apply(self, &notice).await;
            self.publish(notice).await;
            *self.status.lock().await = SessionStatus::Failed;
            self.publish(SessionEvent::SessionStatusChanged {
                status: SessionStatus::Failed,
            })
            .await;
            return Err(error)
                .context("the answer remains pending on disk; a new send will retry saving it");
        }
        inbox::settle_inputs(self, owner.as_ref(), &event).await?;
        apply(self, &event).await;
        self.publish(event).await;
        if consultation && !self.visible_permissions().await.is_empty() && !closed {
            self.round_blocked().await;
            *self.status.lock().await = SessionStatus::Waiting;
            self.publish(SessionEvent::SessionStatusChanged {
                status: SessionStatus::Waiting,
            })
            .await;
        }
        if closed {
            *self.status.lock().await = SessionStatus::Closed;
            self.publish(SessionEvent::SessionStatusChanged {
                status: SessionStatus::Closed,
            })
            .await;
        }
        owner.take();
        Ok(())
    }

    pub(super) fn new(meta: SessionMeta, store: Store) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        let waiting = meta.awaiting_human();
        let retired = meta.execution_retired;
        Live {
            execution: Mutex::new(None),
            next_execution: AtomicU64::new(1),
            inbox_lock: Mutex::new(()),
            delivery_dispatching: AtomicBool::new(false),
            closing: AtomicBool::new(meta.execution_retired),
            retirement: Mutex::new(()),
            cleanup: crate::adapter::SessionTasks::default(),
            store,
            meta: Mutex::new(meta),
            status: Mutex::new(if retired {
                SessionStatus::Closed
            } else if waiting {
                SessionStatus::Waiting
            } else {
                SessionStatus::Idle
            }),
            items: Mutex::new(Vec::new()),
            rounds: Mutex::new(Vec::new()),
            unsaved_rounds: Mutex::new(Vec::new()),
            inherited_rounds: Mutex::new(None),
            blob_refs: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            stream_epoch: uuid::Uuid::new_v4().to_string(),
            last_activity_ms: AtomicI64::new(0),
            replay: Mutex::new(VecDeque::new()),
            events,
            agent: Mutex::new(None),
            additional_system_prompt: Mutex::new(None),
            card_held: AtomicBool::new(false),
            interaction_lock: Mutex::new(()),
            runtime_settings: Mutex::new(()),
            turn_items: Mutex::new(Vec::new()),
            open_turn_written_ms: AtomicI64::new(0),
            open_turn_dirty: AtomicBool::new(false),
            deferred_seed: Mutex::new(None),
            deferred_meta: AtomicBool::new(false),
            open_trunk_items: Mutex::new(Vec::new()),
            llm_rounds: Mutex::new(LlmRounds::default()),
            pump: Mutex::new(None),
            pump_stop: tokio::sync::watch::channel(false).0,
            active_round: Mutex::new(None),
        }
    }

    /// The running turn's last sign of life, for whoever is waiting on it.
    ///
    /// Reported only while a turn is running: a session that is idle is not
    /// quiet, it is finished, and an age on a finished session reads as a
    /// problem where there is none.
    pub(super) fn activity_of(&self, status: SessionStatus) -> Option<i64> {
        if status != SessionStatus::Running {
            return None;
        }
        let at = self.last_activity_ms.load(Ordering::SeqCst);
        (at > 0).then_some(at)
    }

    pub(super) async fn visible_permissions(&self) -> Vec<PermissionRequest> {
        if self.card_held.load(Ordering::SeqCst) {
            return Vec::new();
        }
        let meta = self.meta.lock().await;
        meta.human_wait
            .as_ref()
            .filter(|wait| wait.decision.is_none())
            .and_then(|wait| wait.request.clone())
            .into_iter()
            .collect()
    }

    pub(super) async fn snapshot(&self) -> Result<SessionSnapshot> {
        let _owner = self.execution.lock().await;
        self.snapshot_unlocked().await
    }

    pub(super) async fn snapshot_unlocked(&self) -> Result<SessionSnapshot> {
        let status = *self.status.lock().await;
        let pending_permissions = self.visible_permissions().await;
        let mut summary = self
            .meta
            .lock()
            .await
            .summary_with_activity(status, self.activity_of(status));
        summary.interaction_summary = Some(super::store::interaction_summary(&pending_permissions));
        Ok(SessionSnapshot {
            stream_epoch: Some(self.stream_epoch.clone()),
            summary,
            items: self.items.lock().await.clone(),
            seq: self.seq.load(Ordering::SeqCst),
            pending_permissions,
            rounds: None,
            expanded_round: None,
            history_before: None,
            history_windowed: None,
            history_excerpt_ids: None,
        })
    }

    /// Assigns a sequence number, retains for replay, and fans out.
    pub(super) async fn publish(&self, event: SessionEvent) -> SequencedEvent {
        // Every kind of event counts, deltas included: the question this
        // answers is "is anything still coming out of it", not "has it made
        // progress", which nobody outside the agent can judge.
        self.last_activity_ms.store(now_ms(), Ordering::SeqCst);
        let session_id = self.meta.lock().await.id.clone();

        // Numbering, retaining and fanning out are one step, not three.
        //
        // Several tasks publish to the same session at once — the event pump, a
        // stop that escalated, the call that started the turn — and a sequence
        // number taken outside this lock is a promise about ordering that
        // nothing then keeps. Two publishers could take 5 and 6 and reach the
        // replay buffer in the other order, leaving a client that asked to be
        // caught up with the events in an order that never happened; the same
        // inversion on the broadcast reaches live subscribers directly.
        //
        // Holding one lock across all three costs nothing here: there is no
        // await inside it that leaves this process.
        let mut replay = self.replay.lock().await;
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let sequenced = SequencedEvent {
            seq,
            session_id,
            event,
        };
        replay.push_back(sequenced.clone());
        // A send error only means nobody is listening, which is normal when a
        // task runs with every client disconnected.
        let _ = self.events.send(sequenced.clone());
        sequenced
    }

    pub(super) async fn trim_replay(&self, window: usize) {
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
    pub(super) async fn record_round_item(&self, item: &TimelineItem) {
        {
            let open = self.open_trunk_items.lock().await;
            if open.iter().any(|id| id == item.id()) {
                return;
            }
        }
        let llm_rounds = self.llm_rounds.lock().await.cumulative();
        let closed = {
            let mut active = self.active_round.lock().await;
            match active.as_mut() {
                Some(round) if round.outcome.is_none() => round.record_trunk_item(item, llm_rounds),
                _ => None,
            }
        };
        if closed.is_some() && matches!(item, TimelineItem::Compaction { .. }) {
            // Compaction closes AFTER its marker, unlike a size boundary.
            self.open_trunk_items
                .lock()
                .await
                .push(item.id().to_string());
            self.finish_trunk(None).await;
            return;
        }
        if closed.is_some() {
            // `push` closes the previous trunk before placing this item in the
            // new one. Keep the trigger out of the old trunk's persisted id
            // set, then retain it after that set has been drained.
            self.finish_trunk(None).await;
        }
        self.open_trunk_items
            .lock()
            .await
            .push(item.id().to_string());
    }

    /// The trunk being built right now, assembled from the items still in
    /// memory. `None` when nothing has been recorded into it yet.
    pub(super) async fn build_open_trunk(
        &self,
        index: u32,
        finished_at_ms: Option<i64>,
    ) -> Option<RoundTrunk> {
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
        let (round_deltas, blocked_intervals) = {
            let active = self.active_round.lock().await;
            let round = active.as_ref()?;
            (round.round_deltas.clone(), round.blocked_intervals.clone())
        };
        let mut trunk = rounds::trunks_from_items_with_rounds(&items, &round_deltas)
            .into_iter()
            .next()?;
        if let Some(finished_at_ms) = finished_at_ms {
            rounds::extend_last_span(&mut trunk, finished_at_ms);
        }
        rounds::exclude_blocked(&mut trunk, &blocked_intervals);
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
    pub(super) async fn finish_trunk(&self, finished_at_ms: Option<i64>) {
        let (ord, index) = {
            let active = self.active_round.lock().await;
            let Some(round) = active.as_ref() else { return };
            (round.ord, round.closed_trunks.len() as u32)
        };
        let Some(trunk) = self.build_open_trunk(index, finished_at_ms).await else {
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
        // Publish the closed index only after the same items stop presenting
        // as an open trunk. The file is already durable above, so readers see
        // either the in-memory trunk or its closed summary, never both.
        if let Some(round) = self.active_round.lock().await.as_mut() {
            round.closed_trunks.push(trunk.summary);
        }
    }

    /// What this turn has said so far, in the order it was said.
    ///
    /// The prompt is left out because it was written when it arrived, and work
    /// items because they belong to the round's trunk. Shared by the write
    /// that happens while the turn runs and the one that ends it, so the two
    /// cannot disagree about what a turn's narrative is.
    pub(super) async fn turn_narrative(&self, ids: &[String]) -> Vec<TimelineItem> {
        let items = self.items.lock().await;
        ids.iter()
            .filter_map(|id| items.iter().find(|item| item.id() == id))
            .filter(|item| !matches!(item, TimelineItem::UserMessage { .. }))
            .cloned()
            .collect()
    }

    /// Writes the turn in progress, at most once a second.
    ///
    /// Called from the event pump as an answer streams in. The rate limit is
    /// the whole design: writing per token would rewrite the file thousands of
    /// times for one reply, and writing only at the end — which is what used
    /// to happen — costs the reader the entire answer if this process dies
    /// while producing it.
    pub(super) async fn persist_open_turn_if_due(&self) {
        /// Long enough that a fast stream does not turn into a write loop,
        /// short enough that what it can cost is a sentence.
        const AT_MOST_EVERY_MS: i64 = 1_000;

        if !self.open_turn_dirty.load(Ordering::SeqCst) {
            return;
        }

        let now = now_ms();
        let last = self.open_turn_written_ms.load(Ordering::SeqCst);
        if now - last < AT_MOST_EVERY_MS {
            return;
        }
        // Emptiness is settled before the slot is claimed, not after. A turn
        // whose only item so far is the prompt has nothing to write, and
        // stamping the clock for it would delay the first real write by the
        // full interval — which is exactly the moment worth not losing.
        let ids: Vec<String> = self.turn_items.lock().await.clone();
        let narrative = self.turn_narrative(&ids).await;
        if narrative.is_empty() {
            return;
        }
        // Two pump-adjacent callers arriving together would otherwise both
        // write the same content; whoever loses the exchange lets the other
        // one do it.
        if self
            .open_turn_written_ms
            .compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let meta = self.meta.lock().await.clone();
        if let Err(error) = self
            .store
            .write_open_turn(&meta.workspace_id, &meta.id, &narrative)
        {
            tracing::warn!("could not persist the open turn of {}: {error}", meta.id);
        } else {
            self.open_turn_dirty.store(false, Ordering::SeqCst);
        }
    }

    /// Rewrites the open trunk so a crash cannot cost more than the turn in
    /// progress — the same durability boundary the flat log had.
    pub(super) async fn persist_open_trunk(&self) {
        let (ord, index) = {
            let active = self.active_round.lock().await;
            let Some(round) = active.as_ref() else { return };
            (round.ord, round.closed_trunks.len() as u32)
        };
        let Some(trunk) = self.build_open_trunk(index, None).await else {
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
    pub(super) async fn begin_round(
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
            // Supersession can happen after a long idle gap. Only a real
            // terminal event can close the final LLM span at wall-clock now.
            self.finish_trunk(None).await;
        }
        self.open_trunk_items.lock().await.clear();
        self.blob_refs.lock().await.clear();
        self.llm_rounds.lock().await.clear();

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
            blocked_intervals: Vec::new(),
            outcome: None,
            current_trunk: TrunkBuilder::default(),
            round_deltas: HashMap::new(),
            last_attributed_rounds: 0,
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
    pub(super) async fn record_round(&self, round: &ActiveRound) {
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
            let mut pending = self.unsaved_rounds.lock().await;
            if !pending.contains(&record.round_id) {
                pending.push(record.round_id);
            }
        }
    }

    /// Folds a daemon-initiated continuation (approval granted, guidance
    /// answered) onto the round that was already open when the interaction
    /// started — never mints a new round, since the daemon itself decided to
    /// resume rather than being told to by the client.
    pub(super) async fn continue_round(&self, turn_id: &str) {
        let mut active = self.active_round.lock().await;
        if let Some(round) = active.as_mut() {
            if round.outcome.is_none() {
                if let Some(since) = round.blocked_since_ms.take() {
                    let now = now_ms();
                    round.blocked_ms += (now - since).max(0);
                    round.blocked_intervals.push((since, now));
                }
                if !round.adapter_turn_ids.iter().any(|id| id == turn_id) {
                    round.adapter_turn_ids.push(turn_id.to_string());
                }
            }
        }
    }

    /// A handle to the running agent, if there is one, with the lock released
    /// before the caller does anything with it.
    ///
    /// The awaits that follow all end at a process the daemon does not
    /// control, so none of them may be made while holding this.
    pub(super) async fn agent(&self) -> Option<Arc<dyn AgentSession>> {
        self.agent.lock().await.clone()
    }

    /// Marks the open round as waiting on a human. A no-op if it is already
    /// marked — two permission requests in a row must not double-count the
    /// gap between the first answer and the second question.
    pub(super) async fn round_blocked(&self) {
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
    /// Ends the open round, if the thing ending it is entitled to.
    ///
    /// A round folds several adapter turns, and only the last of them is the
    /// one still running. A terminal naming an earlier turn is a straggler from
    /// work that has already been superseded, and acting on it would end the
    /// turn the user is watching on the strength of one they cancelled.
    ///
    /// The check belongs here rather than in each adapter because two of the
    /// four cannot make it: claude's `result` frame carries no turn id at all,
    /// so the adapter stamps whichever turn is current when the frame arrives,
    /// and genet's `agent_end` does the same. Whatever they stamp, the kernel
    /// knows which turn it is actually waiting on.
    pub(super) async fn settle_round(
        &self,
        by: Settling<'_>,
        outcome: RoundOutcome,
    ) -> Option<ActiveRound> {
        let has_open_trunk = {
            let mut active = self.active_round.lock().await;
            let round = active.as_mut()?;
            if round.outcome.is_some() {
                return None;
            }
            if let Settling::Turn(turn_id) = by {
                let running = round.adapter_turn_ids.last().map(String::as_str);
                if running != Some(turn_id) {
                    tracing::warn!(
                        event = "session_stale_terminal_ignored",
                        round = %round.round_id,
                        running = running.unwrap_or("<none>"),
                        named = %turn_id,
                        "a terminal named a turn this round is no longer running"
                    );
                    return None;
                }
            }
            if let Some(since) = round.blocked_since_ms.take() {
                let now = now_ms();
                round.blocked_ms += (now - since).max(0);
                round.blocked_intervals.push((since, now));
            }
            round.outcome = Some(outcome);
            round.close_current_trunk_pending().is_some()
        };
        if has_open_trunk {
            self.finish_trunk(Some(now_ms())).await;
        }
        self.open_trunk_items.lock().await.clear();
        self.blob_refs.lock().await.clear();
        self.llm_rounds.lock().await.clear();
        self.active_round.lock().await.clone()
    }

    /// Stop receiving, then drain and join the pump's blob writer. The task
    /// handle stays in Live across cancellation and timeouts, so a retry can
    /// still join the same writer before releasing the execution.
    pub(super) async fn stop_pump(&self) -> Result<()> {
        self.pump_stop.send_replace(true);
        let mut held = self.pump.lock().await;
        if let Some(task) = held.as_mut() {
            let joined = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .context("the timeline writer has not finished; stopping can be retried")?;
            held.take();
            joined.context("the timeline writer stopped unexpectedly")?;
        }
        Ok(())
    }

    pub(super) async fn prepare_shutdown(self: &Arc<Self>) -> Result<u64> {
        self.closing.store(true, Ordering::SeqCst);
        let starting = {
            let owner = self.execution.lock().await;
            owner
                .as_ref()
                .filter(|execution| execution.phase == ExecutionPhase::Starting)
                .cloned()
        };
        if let Some(starting) = starting {
            let mut terminal = starting.terminal.subscribe();
            starting.cancel.send_replace(true);
            tokio::time::timeout(Duration::from_secs(10), terminal.wait_for(|done| *done))
                .await
                .context("the canceled handover has not released its resources")??;
        }
        self.cleanup.stop().await;
        let id = {
            let mut owner = self.execution.lock().await;
            owner
                .get_or_insert_with(|| {
                    Execution::new(self.next_execution.fetch_add(1, Ordering::SeqCst))
                })
                .id
        };
        {
            let mut owner = self.execution.lock().await;
            if let Some(execution) = owner.as_mut().filter(|execution| execution.id == id) {
                execution.phase = ExecutionPhase::Stopping;
                execution.cancel.send_replace(true);
                execution.ready.send_replace(true);
            }
        }
        // Keep the adapter alive for descendant ownership census, but retire
        // event consumption before our controlled cleanup produces its exit.
        self.stop_pump().await?;
        Ok(id)
    }

    pub(super) async fn shutdown(self: &Arc<Self>) -> Result<()> {
        let id = self.prepare_shutdown().await?;
        retire_execution(self, id, None, true).await
    }
}
