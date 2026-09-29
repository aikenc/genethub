use super::*;

impl SessionManager {
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
        self.send_prepared(
            session_id,
            text,
            attachments,
            providers,
            continues_round,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn send_prepared(
        &self,
        session_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        providers: &ProviderMap,
        continues_round: Option<String>,
        prepared: Option<(TimelineItem, Vec<String>)>,
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
        // Paths inside the guidance are spelled for the consumer: a native
        // agent opens them on the host (fb_M5CQD86STboK — a Windows codex was
        // told the CLI lived at /c/... and reported it missing), while the
        // built-in agent's component child shares this daemon's preopen
        // namespace and must keep guest form.
        let host_paths = {
            let agent_id = live.meta.lock().await.agent_id.clone();
            self.registry
                .get(&agent_id)
                .map(|adapter| adapter.host_form_payloads())
                .unwrap_or(true)
        };
        let mut additional_system_prompt = crate::skills::session_guidance(
            self.skills_dir.as_deref(),
            self.front_door_cli.as_deref(),
            host_paths,
        );
        let meta = live.meta.lock().await.clone();
        if let Some(managed) = meta.managed_system_prompt.as_deref() {
            additional_system_prompt.push_str("\n\n");
            additional_system_prompt.push_str(managed);
        } else if let Some(root) = crate::workflow::root_session_guidance(&meta.cwd) {
            additional_system_prompt.push_str("\n\n");
            additional_system_prompt.push_str(&root);
        }
        let additional_system_prompt = Some(additional_system_prompt);
        let Some(execution) = live
            .claim_execution(prepared.as_ref().map(|(_, ids)| ids.as_slice()))
            .await?
        else {
            // Stop or a newer goal superseded this selection. Leave the newest
            // input runnable rather than recording a delivery failure.
            return Ok(String::new());
        };
        if let Some((_, ids)) = &prepared {
            let mut owner = live.execution.lock().await;
            if let Some(current) = owner.as_mut() {
                current.consultation = meta
                    .human_wait
                    .as_ref()
                    .is_some_and(|wait| wait.decision.is_none() && wait.request.is_some());
                current.input_ids = ids.clone();
                current.human_request_id = meta
                    .human_wait
                    .as_ref()
                    .filter(|wait| wait.decision.is_some())
                    .map(|wait| wait.id.clone());
            }
        }
        let mut handover = Handover {
            live: live.clone(),
            id: execution.id,
            complete: false,
        };
        let mut cancel = execution.cancel.subscribe();
        let started = tokio::select! {
            biased;
            _ = cancel.wait_for(|canceled| *canceled) => Err(anyhow!("the execution was stopped during handover")),
            result = tokio::time::timeout(HANDOVER_BUDGET, self.start_turn(
                &live, session_id, text, attachments, providers,
                additional_system_prompt, continues_round, execution.id, prepared,
            )) => result.unwrap_or_else(|_| Err(anyhow!(
                "the agent did not take this message within {}s; delivery may be unknown",
                HANDOVER_BUDGET.as_secs()
            ))),
        };
        if let Err(error) = &started {
            retire_execution(&live, execution.id, Some(error.to_string()), false).await?;
        }
        handover.complete = true;
        started
    }

    // These are the already-separated protocol fields for one handoff; wrapping
    // them again would add a second request shape inside the session manager.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn start_turn(
        &self,
        live: &Arc<Live>,
        session_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        providers: &ProviderMap,
        additional_system_prompt: Option<String>,
        continues_round: Option<String>,
        execution_id: u64,
        prepared: Option<(TimelineItem, Vec<String>)>,
    ) -> Result<String> {
        // The process is lazy, so this is still before any Agent sees the first
        // turn. A running Agent retains the exact prefix it started with; if it
        // has to restart later, the newest validated browser context wins.
        if live.agent.lock().await.is_none() {
            *live.additional_system_prompt.lock().await = additional_system_prompt;
        }
        let human_id = live
            .execution
            .lock()
            .await
            .as_ref()
            .and_then(|execution| execution.human_request_id.clone());
        let elevated = match live
            .meta
            .lock()
            .await
            .human_wait
            .as_ref()
            .filter(|wait| wait.decision.is_some() && Some(&wait.id) == human_id.as_ref())
            .and_then(|wait| {
                wait.request.as_ref().map(|request| {
                    (
                        request.clone(),
                        wait.decision.as_ref().expect("filtered").outcome.clone(),
                    )
                })
            }) {
            Some((request, outcome)) => continuation_for(&request, &outcome)?
                .is_some_and(|continuation| continuation.elevated),
            None => false,
        };
        let applied = self.persist_elevation(live, providers, elevated).await?;
        if let Some(owner) = live.execution.lock().await.as_mut() {
            owner.unattended_unavailable = elevated && !applied;
        }

        let seed_owner = {
            let meta = live.meta.lock().await;
            (meta.workspace_id.clone(), meta.id.clone())
        };
        let current_route = {
            let meta = live.meta.lock().await;
            (meta.agent_id.clone(), meta.model_id.clone())
        };
        let mut applying_seed = match self.store.load_seed(&seed_owner.0, &seed_owner.1)? {
            Some(seed)
                if !context_seed_targets_route(&seed, &current_route.0, &current_route.1) =>
            {
                tracing::warn!(
                    session = %session_id,
                    target_agent = ?seed.target_agent_id,
                    "ignored an uncommitted Agent migration context seed"
                );
                None
            }
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

        let item = if let Some((item, ids)) = &prepared {
            let mut meta = live.meta.lock().await;
            let mut next = meta.clone();
            next.inbox.has_delivered = true;
            for entry in &mut next.inbox.entries {
                if ids.contains(&entry.message_id) {
                    entry.state = "sent".into();
                }
            }
            self.store.save_meta(&next)?;
            *meta = next;
            item.clone()
        } else {
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
            // A session that already has a name keeps it against later prompts.
            // An Agent title can still replace a first-prompt label unless the
            // user locked the name with `rename`.
            let (workspace_id, needs_title) = {
                let meta = live.meta.lock().await;
                (
                    meta.workspace_id.clone(),
                    meta.title.is_none()
                        || (!meta.title_locked
                            && meta.title.as_deref().is_some_and(is_catalog_noise_title)),
                )
            };
            self.store
                .append_chat_items(&workspace_id, session_id, std::slice::from_ref(&item))?;

            {
                let mut meta = live.meta.lock().await;
                meta.message_preview = visible_message_preview(std::slice::from_ref(&item));
                self.store.save_meta(&meta)?;
            }
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
            item
        };

        if prepared.is_some() && live.meta.lock().await.inbox.paused {
            bail!("PM continuation was explicitly paused before handover");
        }
        let agent = live
            .agent()
            .await
            .ok_or_else(|| anyhow!("the session has no running agent"))?;
        agent
            .configure_for_prompt(current_route.1.as_deref(), providers)
            .await?;
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
                    if let Err(error) = self.store.save_seed(&seed_owner.0, &seed_owner.1, seed) {
                        tracing::warn!(
                            %error,
                            session = %session_id,
                            "agent accepted the prompt; the applied context seed will be written when the turn settles"
                        );
                        *live.deferred_seed.lock().await = Some(seed.clone());
                    }
                }
                turn_id
            }
            Err(error) => {
                // An IO error can happen after the CLI accepted the bytes.
                // Keep Applying: an explicit retry must not duplicate context
                // on an outcome we could not observe.
                return Err(error).context("handing the prompt to the agent");
            }
        };
        // The pump waits until both the handover and its round are bound.
        // A terminal emitted synchronously by send cannot outrun this commit.
        let mut owner = live.execution.lock().await;
        let execution = owner
            .as_mut()
            .filter(|execution| execution.id == execution_id)
            .ok_or_else(|| anyhow!("this handover no longer owns the session"))?;
        execution.turn_id = Some(turn_id.clone());
        execution.phase = ExecutionPhase::Running;
        let kernel_continuation = live.meta.lock().await.inbox.entries.iter().any(|entry| {
            execution.input_ids.contains(&entry.message_id) && entry.kernel_input.is_some()
        });
        let same_round = live
            .active_round
            .lock()
            .await
            .as_ref()
            .is_some_and(|round| {
                round.outcome.is_none()
                    && continues_round.as_deref() == Some(round.round_id.as_str())
            });
        if execution.consultation || (kernel_continuation && same_round) {
            live.continue_round(&turn_id).await;
            if let Some(round) = live.active_round.lock().await.clone() {
                live.record_round(&round).await;
            }
        } else {
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
        }
        if prepared.is_some() {
            let mut meta = live.meta.lock().await;
            let mut next = meta.clone();
            for entry in &mut next.inbox.entries {
                if execution.input_ids.contains(&entry.message_id) {
                    entry.turn_id = Some(turn_id.clone());
                }
            }
            if let Err(error) = self.store.save_meta(&next) {
                tracing::warn!(
                    %error,
                    session = %session_id,
                    "agent accepted the prompt; the inbox turn binding will be written when the turn settles"
                );
                live.deferred_meta.store(true, Ordering::SeqCst);
            }
            *meta = next;
        }

        // The user message belongs to the turn it started.
        live.publish(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item,
        })
        .await;
        if let Some(request_id) = execution.human_request_id.take() {
            acknowledge_human_delivery(live, &self.store, &request_id).await;
        }
        execution.ready.send_replace(true);
        Ok(turn_id)
    }

    /// Starts the agent process if it is not already running.
    ///
    /// Lazily, on first send: creating a session should not cost a process, or
    /// clicking through the sidebar would spawn one per session.
    pub(super) async fn ensure_started(
        &self,
        live: &Arc<Live>,
        providers: &ProviderMap,
    ) -> Result<()> {
        self.ensure_started_in_mode(live, providers, None).await
    }

    /// The saved handle names a store the current adapter cannot read (Cursor
    /// ACP session ids after the move to print mode). The conversation goes on
    /// from GeneHub's own log, handed over once like an Agent switch.
    pub(super) async fn seed_unresumable_history(
        &self,
        live: &Arc<Live>,
        meta: &mut SessionMeta,
        catalog: &Catalog,
    ) -> Result<()> {
        let items = migration_seed_history(meta, &live.items.lock().await);
        if !items.is_empty() {
            let last_turn = items.iter().rev().find_map(|item| match item {
                TimelineItem::TurnSummary { stats, .. } => Some(stats.turn_id.clone()),
                _ => None,
            });
            let source_round_id = {
                let rounds = live.rounds.lock().await;
                last_turn.as_deref().and_then(|turn_id| {
                    rounds
                        .iter()
                        .find(|round| round.adapter_turn_ids.iter().any(|id| id == turn_id))
                        .map(|round| round.round_id.clone())
                })
            };
            let context_window = meta
                .model_id
                .as_deref()
                .or(catalog.default_model.as_deref())
                .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                .and_then(|model| model.context_window);
            let mut seed = build_context_seed(
                &meta.id,
                last_turn.as_deref().unwrap_or("latest"),
                source_round_id.as_deref(),
                &meta.agent_id,
                &items,
                seed_token_budget(context_window),
                coverage_for_meta(meta, items.len()),
            )
            .seed;
            seed.target_agent_id = Some(meta.agent_id.clone());
            seed.target_model_id = meta.model_id.clone();
            self.store.save_seed(&meta.workspace_id, &meta.id, &seed)?;
        }
        tracing::info!(
            agent = %meta.agent_id,
            session = %meta.id,
            items = items.len(),
            "saved resume handle is not readable by this adapter; continuing from GeneHub history"
        );
        meta.persist = None;
        meta.agent_pid = None;
        self.store.save_meta(meta)?;
        *live.meta.lock().await = meta.clone();
        Ok(())
    }

    /// An approved elevation becomes the session mode. A later mode choice can
    /// lower it again. The override is not limited to the resumed turn.
    pub(super) async fn persist_elevation(
        &self,
        live: &Arc<Live>,
        providers: &ProviderMap,
        elevated: bool,
    ) -> Result<bool> {
        let mode_id = if elevated {
            let agent_id = live.meta.lock().await.agent_id.clone();
            self.registry
                .require(&agent_id)?
                .catalog(providers)
                .await
                .modes
                .into_iter()
                .find(|mode| mode.unattended)
                .map(|mode| mode.id)
        } else {
            None
        };
        let applied = mode_id.is_some();
        if let Some(mode_id) = mode_id {
            let changed = {
                let mut meta = live.meta.lock().await;
                if meta.mode_id.as_deref() == Some(mode_id.as_str()) {
                    false
                } else {
                    meta.mode_id = Some(mode_id.clone());
                    meta.updated_at_ms = now_ms();
                    self.store.save_meta(&meta)?;
                    true
                }
            };
            if changed {
                live.publish(SessionEvent::ModeChanged {
                    mode_id: mode_id.clone(),
                })
                .await;
            }
            if let Some(agent) = live.agent().await {
                agent.set_mode(&mode_id).await?;
            }
        }
        self.ensure_started_in_mode(live, providers, None).await?;
        Ok(!elevated || applied)
    }

    /// Starts a stopped native session in the mode stored on the session.
    pub(super) async fn ensure_started_in_mode(
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
        if meta.model_id.as_ref().is_some_and(|id| {
            !offered.models.is_empty() && !offered.models.iter().any(|model| &model.id == id)
        }) {
            bail!("saved model is not in the current catalog; select an available model");
        }
        if normalize_runtime_selection(&mut meta, &offered) {
            tracing::warn!(
                agent = %meta.agent_id,
                session = %meta.id,
                "recovered stale runtime selection against the current Agent catalog"
            );
            self.store.save_meta(&meta)?;
            *live.meta.lock().await = meta.clone();
        }
        if meta
            .persist
            .as_ref()
            .is_some_and(|handle| !adapter.accepts_resume(handle))
        {
            self.seed_unresumable_history(live, &mut meta, &offered)
                .await?;
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
        // Bounded, because this gate is the one place where one conversation can
        // stop another. Everything inside it has its own deadline; waiting for
        // it did not, so a single CLI that never finishes its first run took
        // every other session of that kind down with it — the caller sits here,
        // having already announced a running turn, with no round behind it and
        // no way to withdraw. That is the shape of the "状态坏了？" report.
        let Ok(_starting) = tokio::time::timeout(START_GATE_BUDGET, gate.lock()).await else {
            anyhow::bail!(
                "another {} session is still starting up; try again in a moment",
                meta.agent_id
            );
        };
        // Whoever held the gate may have been starting this very session.
        if live.agent.lock().await.is_some() {
            return Ok(());
        }

        let scratch = self.store.make_scratch_dir(&meta.workspace_id, &meta.id)?;
        let additional_system_prompt =
            live.additional_system_prompt
                .lock()
                .await
                .clone()
                .or_else(|| {
                    let mut guidance = crate::skills::session_guidance(
                        self.skills_dir.as_deref(),
                        self.front_door_cli.as_deref(),
                        adapter.host_form_payloads(),
                    );
                    if let Some(managed) = meta.managed_system_prompt.as_deref() {
                        guidance.push_str("\n\n");
                        guidance.push_str(managed);
                    }
                    Some(guidance)
                });
        let config = |resume: Option<PersistHandle>| SessionConfig {
            session_id: meta.id.clone(),
            cwd: meta.cwd.clone(),
            model_id: meta.model_id.clone(),
            mode_id: mode_override.clone().or_else(|| meta.mode_id.clone()),
            effort_id: meta.effort_id.clone(),
            fast: meta.fast,
            runtime_values: meta.runtime_values.clone(),
            additional_system_prompt: additional_system_prompt.clone(),
            skills_dir: self.skills_dir.clone(),
            front_door_cli: self.front_door_cli.clone(),
            controller_token: Some(self.controller_token(&meta.id)),
            scratch_dir: scratch.clone(),
            providers: providers.clone(),
            resume,
        };

        let requires_native_context = meta.inbox.entries.iter().any(|entry| entry.state == "sent")
            || meta
                .human_wait
                .as_ref()
                .is_some_and(|wait| wait.decision.is_some());
        if meta.persist.is_none()
            && requires_native_context
            && !self.has_pending_migration_seed(&meta)?
        {
            bail!("the accepted messages require the original Agent context, but no native resume handle is available");
        }
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
                if requires_native_context {
                    return Err(error).context("cannot resume approved Session history; restore the Agent session before continuing");
                }
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
            let mut meta = live.meta.lock().await;
            if meta.agent_pid != Some(pid) {
                meta.agent_pid = Some(pid);
                self.store.save_meta(&meta)?;
            }
        }
        live.stop_pump().await?;
        live.pump_stop.send_replace(false);
        *live.agent.lock().await = Some(Arc::from(session));
        let pump = tokio::spawn(pump_events(
            live.clone(),
            receiver,
            self.store.clone(),
            self.replay_window,
            self.processes.clone(),
            self.diagnostics.clone(),
            self.project_control.clone(),
        ));
        *live.pump.lock().await = Some(pump);
        Ok(())
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        let live = self.live(session_id).await?;
        // Bind Stop and its durable pause to the same execution. A later
        // admission may resume the inbox, but cannot become this Stop's target.
        let mut owner = live.execution.lock().await;
        {
            let mut meta = live.meta.lock().await;
            let mut next = meta.clone();
            next.inbox.set_pause(Some("userStop"));
            self.store.save_meta(&next)?;
            *meta = next;
        }
        // An interrupt stops execution and pauses the inbox. It does not
        // decide a waiting Human card; cancel is an explicit response.
        self.stop_execution(&live, &mut owner).await
    }

    async fn stop_execution(&self, live: &Arc<Live>, owner: &mut Option<Execution>) -> Result<()> {
        let Some(execution) = owner.as_mut() else {
            return Ok(());
        };
        if execution.phase == ExecutionPhase::Starting {
            execution.cancel.send_replace(true);
            return Ok(());
        }
        if execution.phase == ExecutionPhase::Stopping {
            return Ok(());
        }
        execution.phase = ExecutionPhase::Stopping;
        let execution = execution.clone();
        // Captured before any external await. The archival round may continue
        // later, but this task can only retire this one execution.
        let agent = live.agent().await;
        let task_live = live.clone();
        live.cleanup.spawn(async move {
            if let Some(agent) = agent {
                let mut terminal = execution.terminal.subscribe();
                let _ = tokio::time::timeout(INTERRUPT_ASK, agent.interrupt()).await;
                let _ = tokio::time::timeout(INTERRUPT_GRACE, terminal.wait_for(|seen| *seen)).await;
            }
            if let Err(error) = retire_execution(&task_live, execution.id, None, false).await {
                tracing::error!(execution = execution.id, %error, "could not retire interrupted execution");
            }
        });
        Ok(())
    }
}

/// Seeds written before in-session migration had no target marker and remain
/// valid for their owning fork/import. A migration marker, once present, must
/// match both Agent and model; the Agent marker also makes an explicit
/// no-model target distinguishable from an old unmarked seed on disk.
pub(super) fn context_seed_targets_route(
    seed: &ContextSeed,
    agent_id: &str,
    model_id: &Option<String>,
) -> bool {
    match seed.target_agent_id.as_deref() {
        None => true,
        Some(target_agent) => {
            target_agent == agent_id && seed.target_model_id.as_deref() == model_id.as_deref()
        }
    }
}

/// Durable inbox messages are already visible in `items`, but they have not
/// yet been handed to an Agent. They must be the next current prompt, not also
/// quoted inside the reconstructed history that precedes that prompt.
pub(super) fn migration_seed_history(
    meta: &SessionMeta,
    items: &[TimelineItem],
) -> Vec<TimelineItem> {
    let pending = meta
        .inbox
        .entries
        .iter()
        .filter(|entry| entry.state != "handled")
        .map(|entry| entry.message_id.as_str())
        .collect::<HashSet<_>>();
    items
        .iter()
        .filter(|item| !pending.contains(item.id()))
        .cloned()
        .collect()
}
