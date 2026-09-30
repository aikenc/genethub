use super::*;

impl SessionManager {
    pub(super) async fn live(&self, session_id: &str) -> Result<Arc<Live>> {
        loop {
            let resident = self.sessions.read().await.get(session_id).cloned();
            if let Some(live) = resident {
                return self.live_not_deleted(live).await;
            }
            let mut gates = self.hydrating.lock().await;
            let resident = self.sessions.read().await.get(session_id).cloned();
            if let Some(live) = resident {
                return self.live_not_deleted(live).await;
            }
            if let Some(sender) = gates.get(session_id) {
                let mut done = sender.subscribe();
                drop(gates);
                if !*done.borrow() {
                    let _ = done.changed().await;
                }
                continue;
            }
            let (sender, _receiver) = watch::channel(false);
            gates.insert(session_id.to_string(), sender.clone());
            drop(gates);
            let loaded = self.hydrate_from_disk(session_id).await;
            let mut sessions = self.sessions.write().await;
            let outcome = if let Some(existing) = sessions.get(session_id).cloned() {
                self.live_not_deleted(existing).await
            } else {
                match loaded {
                    Ok(live) => {
                        // A delete can tombstone and remove this row while
                        // hydration awaits IO. Recheck under the same map lock
                        // that deletion uses before publishing the new resident.
                        let workspace_id = live.meta.lock().await.workspace_id.clone();
                        if self.store.is_tombstoned(&workspace_id, session_id) {
                            Err(SessionMissing(session_id.to_string()).into())
                        } else {
                            sessions.insert(session_id.to_string(), live.clone());
                            Ok(live)
                        }
                    }
                    Err(error) => Err(error),
                }
            };
            drop(sessions);
            self.hydrating.lock().await.remove(session_id);
            let _ = sender.send(true);
            return outcome;
        }
    }

    /// A logically deleted resident may still own a failed cleanup. Keep that
    /// owner for delete retries without making the session readable or writable.
    async fn live_not_deleted(&self, live: Arc<Live>) -> Result<Arc<Live>> {
        let meta = live.meta.lock().await;
        if self.store.is_tombstoned(&meta.workspace_id, &meta.id) {
            return Err(SessionMissing(meta.id.clone()).into());
        }
        drop(meta);
        Ok(live)
    }

    /// Disk load for a session that is not in the memory map. The `sessions`
    /// lock is not held, so other conversations can still be found.
    pub(super) async fn hydrate_from_disk(&self, session_id: &str) -> Result<Arc<Live>> {
        let mut meta = self
            .store
            .list_meta()?
            .into_iter()
            .find(|meta| meta.id == session_id)
            .ok_or_else(|| SessionMissing(session_id.to_string()))?;
        if self.store.is_tombstoned(&meta.workspace_id, session_id) {
            return Err(SessionMissing(session_id.to_string()).into());
        }
        // Reading a layout this build predates would not give a partial view,
        // it would give a wrong one, and any reply written back would corrupt
        // the session for the build that can read it.
        if !meta.openable() {
            return Err(anyhow!(
                "session {session_id} uses unsupported format {}; \
                 this build only reads format {SESSION_FORMAT}",
                meta.format
            ));
        }
        let mut chat = self.store.load_chat(&meta.workspace_id, &meta.id)?;
        if apply_catalog_title_repair(&mut meta, &chat) {
            if let Err(error) = self.store.save_meta(&meta) {
                tracing::warn!(
                    error = %error,
                    session_id,
                    "could not persist a catalog-heading title repair"
                );
            }
        }
        let unsaved = self.recover_interrupted_turn(&meta, &mut chat).await?;
        let restored_round = if meta.awaiting_human() {
            chat.rounds
                .last()
                .map(|record| -> Result<ActiveRound> {
                    Ok(ActiveRound {
                        round_id: record.round_id.clone(),
                        ord: record.ord,
                        user_item_id: record.user_item_id.clone(),
                        adapter_turn_ids: record.adapter_turn_ids.clone(),
                        started_at_ms: record.started_at_ms,
                        blocked_since_ms: Some(meta.updated_at_ms),
                        blocked_ms: record.blocked_ms,
                        blocked_intervals: Vec::new(),
                        outcome: None,
                        current_trunk: TrunkBuilder::default(),
                        round_deltas: HashMap::new(),
                        last_attributed_rounds: 0,
                        closed_trunks: self.store.load_trunk_index(
                            &meta.workspace_id,
                            &meta.id,
                            record.ord,
                        )?,
                    })
                })
                .transpose()?
        } else {
            None
        };
        let live = Arc::new(Live::new(meta, self.store.clone()));
        *live.items.lock().await = chat.items;
        *live.rounds.lock().await = chat.rounds;
        *live.turn_items.lock().await = unsaved;
        *live.active_round.lock().await = restored_round;
        Ok(live)
    }

    /// Moves the narrative of a turn that never finished into the log.
    ///
    /// Reached when the previous process died with an answer in flight. The
    /// items are promoted rather than merely displayed, so the log is the one
    /// durable home again and the next start does not have to know any of this
    /// happened. Anything already in the log wins: a crash between the append
    /// and the removal below would otherwise show the answer twice.
    pub(super) async fn recover_interrupted_turn(
        &self,
        meta: &SessionMeta,
        chat: &mut ChatLog,
    ) -> Result<Vec<String>> {
        let recovered = self.store.load_open_turn(&meta.workspace_id, &meta.id)?;
        if recovered.is_empty() {
            return Ok(Vec::new());
        }
        let fresh: Vec<TimelineItem> = recovered
            .into_iter()
            .filter(|item| !chat.items.iter().any(|kept| kept.id() == item.id()))
            .collect();
        if !fresh.is_empty() {
            if let Err(error) = self
                .store
                .append_chat_items(&meta.workspace_id, &meta.id, &fresh)
            {
                // Left in place to be tried again next time rather than
                // dropped: an unwritable session directory is a reason to keep
                // the only copy, not to discard it.
                tracing::warn!(
                    "could not recover the interrupted turn of {}: {error}",
                    meta.id
                );
                let unsaved = fresh.iter().map(|item| item.id().to_string()).collect();
                chat.items.extend(fresh);
                return Ok(unsaved);
            }
            chat.items.extend(fresh);
        }
        self.store.clear_open_turn(&meta.workspace_id, &meta.id);
        Ok(Vec::new())
    }

    pub async fn summary(&self, session_id: &str) -> Result<SessionSummary> {
        let live = self.live(session_id).await?;
        let status = *live.status.lock().await;
        let mut summary = live
            .meta
            .lock()
            .await
            .summary_with_activity(status, live.activity_of(status));
        summary.interaction_summary = Some(super::store::interaction_summary(
            live.visible_permissions().await.iter(),
        ));
        Ok(summary)
    }

    /// Returns the durable Human tags plus media requirements observed anywhere
    /// in the visible history. Scanning also upgrades sessions written before
    /// `mediaTags` existed without a migration pass over every workspace.
    pub(crate) async fn routing_requirements(
        &self,
        session_id: &str,
    ) -> Result<(bool, Vec<String>, Vec<String>)> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await.clone();
        let items = live.items.lock().await;
        let historical = crate::agent_routing::media_tags_for_timeline(&items);
        let enabled =
            meta.tag_routing || !meta.routing_tags.is_empty() || !meta.media_tags.is_empty();
        let media_tags =
            crate::agent_routing::normalize_tags(meta.media_tags.into_iter().chain(historical));
        Ok((enabled, meta.routing_tags, media_tags))
    }

    /// A snapshot of live member turns; reading it never starts an Agent.
    pub(crate) async fn executing_workflow_runs(&self) -> HashSet<String> {
        let lives = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut runs = HashSet::new();
        for live in lives {
            let status = *live.status.lock().await;
            if status == SessionStatus::Running {
                if let Some(managed) = &live.meta.lock().await.managed {
                    runs.insert(managed.workflow_run_id.clone());
                }
            }
        }
        runs
    }

    /// Execution ownership, including startup and cleanup, is stronger than a
    /// rendered idle status. Workflow reconciliation must not guess from chat.
    /// Stop has already fenced this live session. Missing sessions are not
    /// closing; callers treat absence with their own existence check.
    pub(crate) async fn is_closing(&self, session_id: &str) -> bool {
        if self.shutting_down.load(Ordering::SeqCst) {
            return true;
        }
        let Some(live) = self.sessions.read().await.get(session_id).cloned() else {
            return false;
        };
        live.closing.load(Ordering::SeqCst)
    }

    pub(crate) async fn has_execution(&self, session_id: &str) -> bool {
        let live = self.sessions.read().await.get(session_id).cloned();
        match live {
            Some(live) => live.execution.lock().await.is_some(),
            None => false,
        }
    }

    /// Whether a persisted Worker Session can receive a continue turn after the
    /// daemon has lost its in-memory execution. A live OS process must pause
    /// continuation so two writers cannot share the project.
    pub(crate) async fn worker_continuation(&self, session_id: &str) -> WorkerContinuation {
        let live = match self.live(session_id).await {
            Ok(live) => live,
            Err(_) => {
                return WorkerContinuation::Unavailable {
                    reason: format!("Worker Session {session_id} 不存在"),
                };
            }
        };
        let meta = live.meta.lock().await.clone();
        if meta.execution_retired || live.closing.load(Ordering::SeqCst) {
            return WorkerContinuation::Unavailable {
                reason: format!("旧 Worker Session {session_id} 已封禁，不能续接同一会话"),
            };
        }
        if self.has_execution(session_id).await {
            return WorkerContinuation::ProcessAlive {
                pid: meta.agent_pid,
            };
        }
        if let Some(pid) = meta.agent_pid {
            if crate::process::exists(pid) {
                return WorkerContinuation::ProcessAlive { pid: Some(pid) };
            }
        }
        if meta.persist.is_none() && meta.inbox.has_delivered {
            match self.has_pending_migration_seed(&meta) {
                Ok(true) => {}
                Ok(false) => {
                    return WorkerContinuation::Unavailable {
                        reason: format!("缺少原生会话句柄，不能续接 Worker {session_id}"),
                    };
                }
                Err(error) => {
                    return WorkerContinuation::Unavailable {
                        reason: format!("读取 Worker {session_id} 的迁移上下文失败：{error:#}"),
                    };
                }
            }
        }
        WorkerContinuation::Ready
    }

    /// A route switch deliberately clears the old Agent's native handle. It
    /// can continue only while a fresh, route-bound history seed is waiting to
    /// be handed to the replacement Agent for the first time.
    pub(super) fn has_pending_migration_seed(&self, meta: &SessionMeta) -> Result<bool> {
        Ok(self
            .store
            .load_seed(&meta.workspace_id, &meta.id)?
            .is_some_and(|seed| {
                seed.state == ContextSeedState::Pending
                    && seed.target_agent_id.is_some()
                    && !seed.text.trim().is_empty()
                    && context_seed_targets_route(&seed, &meta.agent_id, &meta.model_id)
            }))
    }

    pub async fn archive(&self, session_id: &str, archived: bool) -> Result<SessionSummary> {
        let live = self.live(session_id).await?;
        let meta = {
            let mut stored = live.meta.lock().await;
            let mut draft = stored.clone();
            draft.archived = archived;
            draft.updated_at_ms = now_ms();
            self.store.save_meta(&draft)?;
            *stored = draft.clone();
            draft
        };
        let status = *live.status.lock().await;
        Ok(meta.summary(status))
    }

    /// Gives a session the name the user typed.
    ///
    /// Safe from being undone: later prompts do not rename a session that
    /// already has a title, and Agent-extracted titles skip a name typed here
    /// (`title_locked`). A title overwritten a second after typing it would be
    /// worse than no rename at all.
    pub async fn rename(&self, session_id: &str, title: &str) -> Result<SessionSummary> {
        let title =
            normalize_session_title(title).ok_or_else(|| anyhow!("a session needs a name"))?;

        let live = self.live(session_id).await?;
        let meta = {
            let mut stored = live.meta.lock().await;
            let mut draft = stored.clone();
            draft.title = Some(title.clone());
            draft.title_locked = true;
            draft.updated_at_ms = now_ms();
            self.store.save_meta(&draft)?;
            *stored = draft.clone();
            draft
        };
        let summary = meta.summary(*live.status.lock().await);
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
        let resident = self.sessions.read().await.get(session_id).cloned();
        let workspace_id = match &resident {
            Some(live) => Some(live.meta.lock().await.workspace_id.clone()),
            None => self
                .store
                .list_meta()?
                .into_iter()
                .find(|meta| meta.id == session_id)
                .map(|meta| meta.workspace_id),
        };
        if let Some(workspace_id) = &workspace_id {
            self.store.mark_deleted(workspace_id, session_id)?;
        }
        let live = self.sessions.read().await.get(session_id).cloned();
        // Hydration can publish between the first resident snapshot and the
        // tombstone. Use the owner we will actually retire for physical cleanup.
        let workspace_id = match &live {
            Some(live) => {
                let workspace_id = live.meta.lock().await.workspace_id.clone();
                self.store.mark_deleted(&workspace_id, session_id)?;
                Some(workspace_id)
            }
            None => workspace_id,
        };
        let _interaction = match &live {
            Some(live) => Some(live.interaction_lock.lock().await),
            None => None,
        };
        // Stopped before the files go. An agent still running would keep
        // appending to a timeline we just removed, and the session would
        // reappear a moment after being deleted. The tombstone is already
        // on disk, so a concurrent load cannot rebuild it.
        if let Some(live) = &live {
            // A competing delete may already have completed while this one
            // waited for the interaction lock. Do not retire the same owner twice.
            if self
                .sessions
                .read()
                .await
                .get(session_id)
                .is_none_or(|kept| !Arc::ptr_eq(kept, live))
            {
                return Ok(());
            }
            cancel_human_continuation(live, &self.store).await?;
            if let Some(broker) = &self.project_control {
                broker.revoke_session(session_id).await?;
            }
            live.prepare_shutdown().await?;
            self.end_what_it_left(session_id).await;
            live.shutdown().await?;
        }
        if let Some(workspace_id) = workspace_id {
            self.store.delete(&workspace_id, session_id)?;
        }
        // Fallible retirement must finish before releasing the cleanup owner.
        // The tombstone blocks public access throughout a failed attempt.
        if let Some(live) = &live {
            let mut sessions = self.sessions.write().await;
            if sessions
                .get(session_id)
                .is_some_and(|kept| Arc::ptr_eq(kept, live))
            {
                sessions.remove(session_id);
            }
        }
        self.processes.forget(session_id).await;
        Ok(())
    }

    pub(crate) async fn fence_execution(&self, session_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        let mut meta = live.meta.lock().await;
        let mut next = meta.clone();
        next.execution_retired = true;
        self.store.save_meta(&next)?;
        *meta = next;
        live.closing.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) async fn consulting(&self, session_id: &str) -> bool {
        let Ok(live) = self.live(session_id).await else {
            return false;
        };
        let consulting = live
            .execution
            .lock()
            .await
            .as_ref()
            .is_some_and(|execution| execution.consultation);
        consulting
    }

    pub(crate) async fn current_request(
        &self,
        session_id: &str,
    ) -> Result<(Option<String>, Option<String>, bool)> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await;
        if let Some(entry) = meta
            .inbox
            .entries
            .iter()
            .rev()
            .find(|entry| entry.state == "sent" && entry.source == "user")
            .or_else(|| {
                meta.inbox
                    .entries
                    .iter()
                    .rev()
                    .find(|entry| entry.state == "sent")
            })
        {
            return Ok((
                Some(entry.message_id.clone()),
                entry.task_run_id.clone(),
                entry.source == "user",
            ));
        }
        drop(meta);
        let id = live
            .active_round
            .lock()
            .await
            .as_ref()
            .and_then(|round| round.user_item_id.clone());
        Ok((id, None, true))
    }

    pub(crate) async fn user_input_after(
        &self,
        session_id: &str,
        message_id: &str,
        after_ms: i64,
    ) -> Result<bool> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await;
        if let Some(entry) = meta
            .inbox
            .entries
            .iter()
            .find(|entry| entry.message_id == message_id)
        {
            return Ok(entry.source == "user" && entry.received_at_ms > after_ms);
        }
        drop(meta);
        let round = live.active_round.lock().await;
        Ok(round.as_ref().is_some_and(|round| {
            round.user_item_id.as_deref() == Some(message_id) && round.started_at_ms > after_ms
        }))
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        if let Some(broker) = &self.project_control {
            broker.revoke_session(session_id).await?;
        }
        let live = match self.sessions.read().await.get(session_id).cloned() {
            Some(live) => live,
            None => return Ok(()),
        };
        // The dispatcher holds the interaction lock through handover. Cancel
        // its startup first, so Close can reach an unresponsive new process.
        live.closing.store(true, Ordering::SeqCst);
        {
            let owner = live.execution.lock().await;
            if let Some(execution) = owner
                .as_ref()
                .filter(|execution| execution.phase == ExecutionPhase::Starting)
            {
                execution.cancel.send_replace(true);
            }
        }
        let _interaction = live.interaction_lock.lock().await;
        cancel_human_continuation(&live, &self.store).await?;

        let saved = live
            .meta
            .lock()
            .await
            .execution_cleanup
            .clone()
            .filter(|receipt| !receipt.completed);
        let mut receipt = match saved {
            Some(receipt) => receipt,
            None => {
                let receipt = self.processes.prepare_cleanup(session_id).await;
                let mut meta = live.meta.lock().await;
                let mut next = meta.clone();
                next.execution_cleanup = Some(receipt.clone());
                self.store.save_meta(&next)?;
                *meta = next;
                receipt
            }
        };
        // Still stop the owned adapter when observation fails. The persisted
        // receipt keeps uncertainty visible across retries and daemon restart.
        live.prepare_shutdown().await?;
        if let Err(error) = self.processes.stop_all_checked(session_id).await {
            tracing::warn!(session = session_id, %error, "descendant cleanup needs verification");
        }
        live.shutdown().await?;
        self.processes.verify_cleanup(&receipt).await?;
        receipt.completed = true;
        {
            let mut meta = live.meta.lock().await;
            let mut next = meta.clone();
            next.execution_cleanup = Some(receipt);
            self.store.save_meta(&next)?;
            *meta = next;
        }
        self.sessions.write().await.remove(session_id);
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
    pub(super) async fn end_what_it_left(&self, session_id: &str) {
        let ended = self.processes.stop_all(session_id).await;
        if ended > 0 {
            tracing::info!(session = %session_id, count = ended, "ended what the session left running");
        }
    }

    /// Stops every agent process. Called on daemon shutdown so no orphan
    /// children survive the tray exiting.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let sessions: Vec<(String, Arc<Live>)> = self.sessions.write().await.drain().collect();
        for (session_id, live) in sessions {
            if let Err(error) = live.prepare_shutdown().await {
                tracing::error!(session = %session_id, %error, "session event retirement did not complete");
            }
            // Daemon exit cannot leave an owned adapter running merely because
            // its timeline writer failed. Preserve ownership for the descendant
            // census, and keep the writer failure visible rather than claim a
            // successful Session retirement.
            self.end_what_it_left(&session_id).await;
            if let Err(error) = live.shutdown().await {
                tracing::error!(session = %session_id, %error, "session shutdown did not complete");
                if let Err(error) = close_current_agent(&live).await {
                    tracing::error!(session = %session_id, %error, "owned adapter shutdown failed");
                }
            }
        }
    }
}
