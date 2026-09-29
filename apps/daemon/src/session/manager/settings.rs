use super::*;

impl SessionManager {
    /// What this session's agent says it offers, for checking a choice against
    /// when there is no process to ask.
    ///
    /// Before the first prompt there is no agent running — the ordinary case, not
    /// an edge one — and without this a value nobody ever offered was stored, and
    /// then announced, as if it had taken.
    pub(super) async fn offered(
        &self,
        live: &Arc<Live>,
        providers: &ProviderMap,
    ) -> Result<Catalog> {
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
        let _interaction = live.interaction_lock.lock().await;
        let _settings = live.runtime_settings.lock().await;
        let execution = live.execution.lock().await;
        if execution
            .as_ref()
            .is_some_and(|e| e.phase == ExecutionPhase::Starting)
        {
            bail!("wait for the Agent to finish starting before changing settings");
        }
        drop(execution);

        let offered = self.offered(&live, providers).await?;
        listed(
            "model",
            model_id,
            offered.models.iter().map(|model| model.id.as_str()),
        )?;
        if let Some(agent) = live.agent().await {
            agent.set_model(model_id).await?;
        }
        {
            let mut stored = live.meta.lock().await;
            let mut meta = stored.clone();
            meta.model_id = Some(model_id.to_string());
            if let Some(model) = offered.models.iter().find(|m| m.id == model_id) {
                if !model.supports_fast && meta.fast == Some(true) {
                    meta.fast = Some(false);
                }
                if let Some(effort) = &meta.effort_id {
                    if !model.efforts.iter().any(|e| e == effort) {
                        meta.effort_id = offered.default_effort.clone();
                    }
                }
            }
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            *stored = meta;
        }
        live.publish(SessionEvent::ModelChanged {
            model_id: model_id.to_string(),
        })
        .await;
        Ok(())
    }

    pub async fn drafts(&self, session_id: &str) -> Result<Vec<genehub_proto::SessionDraft>> {
        let live = self.live(session_id).await?;
        let drafts = live.meta.lock().await.drafts.clone();
        Ok(drafts)
    }

    /// Replaces the small ordered set in one write so selection, edits and
    /// deletes cannot leave half-applied composer state on disk.
    pub async fn replace_drafts(
        &self,
        session_id: &str,
        drafts: Vec<genehub_proto::SessionDraft>,
    ) -> Result<Vec<genehub_proto::SessionDraft>> {
        if drafts.len() > 5 {
            anyhow::bail!("a session supports at most 5 drafts");
        }
        let mut ids = std::collections::HashSet::new();
        for draft in &drafts {
            if draft.id.trim().is_empty() || !ids.insert(draft.id.as_str()) {
                anyhow::bail!("draft ids must be non-empty and unique");
            }
            if draft.text.trim().is_empty() && draft.attachments.is_empty() {
                anyhow::bail!("a draft needs text or an attachment");
            }
        }
        let live = self.live(session_id).await?;
        {
            let mut stored = live.meta.lock().await;
            let mut meta = stored.clone();
            meta.drafts = drafts.clone();
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            *stored = meta;
        }
        live.publish(SessionEvent::DraftsChanged {
            count: drafts.len() as u32,
        })
        .await;
        Ok(drafts)
    }

    /// Rebinds one durable GeneHub Session to a different Agent-native
    /// context. The visible timeline and Session id remain unchanged; the next
    /// user message carries a bounded reconstruction of all completed history.
    pub async fn switch_agent(
        &self,
        session_id: &str,
        target: SessionAgentTarget,
        providers: &ProviderMap,
    ) -> Result<SessionSummary> {
        self.switch_agent_with_routing(session_id, target, providers, None, false)
            .await
    }

    pub(crate) async fn switch_agent_routed(
        &self,
        session_id: &str,
        target: SessionAgentTarget,
        providers: &ProviderMap,
        routing_tags: Vec<String>,
        media_tags: Vec<String>,
    ) -> Result<SessionSummary> {
        self.switch_agent_with_routing(
            session_id,
            target,
            providers,
            Some((routing_tags, media_tags)),
            false,
        )
        .await
    }

    /// Rebinds a failed Workflow Worker in place. The Workflow controller is
    /// the only caller allowed to migrate a managed Session: Human-initiated
    /// switches stay forbidden so a project's role-tag contract remains the
    /// authority. Session id, managed prompt, history and write lease survive.
    pub(crate) async fn switch_managed_agent(
        &self,
        session_id: &str,
        target: SessionAgentTarget,
        providers: &ProviderMap,
    ) -> Result<SessionSummary> {
        self.switch_agent_with_routing(session_id, target, providers, None, true)
            .await
    }

    pub(super) async fn switch_agent_with_routing(
        &self,
        session_id: &str,
        target: SessionAgentTarget,
        providers: &ProviderMap,
        routing: Option<(Vec<String>, Vec<String>)>,
        allow_managed: bool,
    ) -> Result<SessionSummary> {
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let _settings = live.runtime_settings.lock().await;
        let _retirement = live.retirement.lock().await;

        {
            let mut execution = live.execution.lock().await;
            if execution
                .as_ref()
                .is_some_and(|current| current.phase == ExecutionPhase::Saving)
            {
                flush_turn(&live, &self.store).await?;
                execution.take();
            }
            if execution.is_some() {
                bail!("wait for the current Agent turn to finish before switching Agent");
            }
        }
        let status = *live.status.lock().await;
        if !matches!(status, SessionStatus::Idle | SessionStatus::Failed) {
            bail!("this Session cannot switch Agent while it is {status:?}");
        }

        let source_meta = live.meta.lock().await.clone();
        if source_meta.managed.is_some() && !allow_managed {
            bail!("Workflow-managed Sessions keep the Agent chosen by their tag contract");
        }
        if source_meta.managed.is_none() && allow_managed {
            bail!("only Workflow-managed Sessions can use automatic Worker failover");
        }
        if source_meta
            .imported
            .as_ref()
            .is_some_and(|imported| imported.continuation == ImportContinuation::ReadOnly)
        {
            bail!("this imported conversation is read-only and cannot switch Agent");
        }
        let (tag_routing, routing_tags, media_tags) = match routing {
            Some((routing_tags, media_tags)) => (true, routing_tags, media_tags),
            None => (false, Vec::new(), source_meta.media_tags.clone()),
        };
        let same_runtime = source_meta.agent_id == target.agent_id
            && source_meta.model_id == target.model_id
            && source_meta.mode_id == target.mode_id
            && source_meta.effort_id == target.effort_id
            && source_meta.fast == target.fast
            && source_meta.runtime_values == target.runtime_values;
        if same_runtime {
            if source_meta.tag_routing == tag_routing
                && source_meta.routing_tags == routing_tags
                && source_meta.media_tags == media_tags
            {
                return Ok(source_meta.summary(status));
            }
            // A new tag or newly observed medium can still resolve to the
            // exact running destination. Persist that intent atomically, but
            // keep the Agent-native thread and its context alive.
            let mut next = source_meta.clone();
            next.tag_routing = tag_routing;
            next.routing_tags = routing_tags;
            next.media_tags = media_tags;
            next.updated_at_ms = now_ms();
            self.store.save_meta(&next)?;
            *live.meta.lock().await = next.clone();
            live.publish(SessionEvent::AgentChanged {
                agent_id: next.agent_id.clone(),
                model_id: next.model_id.clone(),
                mode_id: next.mode_id.clone(),
                effort_id: next.effort_id.clone(),
                fast: next.fast,
                runtime_values: next.runtime_values.clone(),
                routing_tags: next.routing_tags.clone(),
                media_tags: next.media_tags.clone(),
            })
            .await;
            return Ok(next.summary(status));
        }
        let adapter = self.registry.require(&target.agent_id)?;
        match adapter.probe().await {
            ProbeState::Ready => {}
            ProbeState::NotInstalled => {
                bail!("the {} agent is not installed", target.agent_id)
            }
            ProbeState::Unavailable { reason } => {
                bail!("the {} agent is unavailable: {reason}", target.agent_id)
            }
        }
        let catalog = adapter.catalog(providers).await;
        let mut next = source_meta.clone();
        next.agent_id = target.agent_id.clone();
        next.model_id = target.model_id.clone();
        next.mode_id = target.mode_id.clone();
        next.effort_id = target.effort_id.clone();
        next.fast = target.fast;
        next.runtime_values = target.runtime_values.clone();
        next.tag_routing = tag_routing;
        next.routing_tags = routing_tags;
        next.media_tags = media_tags;
        let requested = (
            next.model_id.clone(),
            next.mode_id.clone(),
            next.effort_id.clone(),
            next.fast,
            next.runtime_values.clone(),
        );
        if normalize_runtime_selection(&mut next, &catalog)
            || requested
                != (
                    next.model_id.clone(),
                    next.mode_id.clone(),
                    next.effort_id.clone(),
                    next.fast,
                    next.runtime_values.clone(),
                )
        {
            bail!("the selected Agent runtime is no longer available; refresh the Agent list");
        }

        let items = migration_seed_history(&source_meta, &live.items.lock().await);
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
        let target_seed = if items.is_empty() {
            None
        } else {
            let context_window = target
                .model_id
                .as_deref()
                .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                .or_else(|| {
                    catalog
                        .default_model
                        .as_deref()
                        .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                })
                .and_then(|model| model.context_window);
            let mut built = build_context_seed(
                session_id,
                last_turn.as_deref().unwrap_or("latest"),
                source_round_id.as_deref(),
                &source_meta.agent_id,
                &items,
                seed_token_budget(context_window),
                coverage_for_meta(&source_meta, items.len()),
            )
            .seed;
            built.target_agent_id = Some(target.agent_id.clone());
            built.target_model_id = target.model_id.clone();
            Some(built)
        };

        // Stop the event pump before closing the old process so its channel
        // closure cannot be mistaken for a failed turn after the new binding
        // has been committed.
        live.stop_pump().await?;
        close_current_agent(&live).await?;

        let old_seed = self
            .store
            .load_seed(&source_meta.workspace_id, &source_meta.id)?;
        if let Some(seed) = &target_seed {
            self.store
                .save_seed(&source_meta.workspace_id, &source_meta.id, seed)?;
        }
        next.persist = None;
        next.agent_pid = None;
        next.updated_at_ms = now_ms();
        if let Err(error) = self.store.save_meta(&next) {
            if let Some(seed) = old_seed.as_ref() {
                let _ = self
                    .store
                    .save_seed(&source_meta.workspace_id, &source_meta.id, seed);
            }
            return Err(error).context("persisting the new Agent binding");
        }
        *live.meta.lock().await = next.clone();
        *live.additional_system_prompt.lock().await = None;
        live.publish(SessionEvent::AgentChanged {
            agent_id: next.agent_id.clone(),
            model_id: next.model_id.clone(),
            mode_id: next.mode_id.clone(),
            effort_id: next.effort_id.clone(),
            fast: next.fast,
            runtime_values: next.runtime_values.clone(),
            routing_tags: next.routing_tags.clone(),
            media_tags: next.media_tags.clone(),
        })
        .await;
        Ok(next.summary(status))
    }

    /// Same shape as `set_model`, and for the same two reasons.
    pub async fn set_effort(
        &self,
        session_id: &str,
        effort_id: &str,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let _settings = live.runtime_settings.lock().await;
        let execution = live.execution.lock().await;
        if execution
            .as_ref()
            .is_some_and(|e| e.phase == ExecutionPhase::Starting)
        {
            bail!("wait for the Agent to finish starting before changing settings");
        }
        drop(execution);

        let offered = self.offered(&live, providers).await?;
        let current_model_id = live.meta.lock().await.model_id.clone();
        let model = current_model_id
            .as_deref()
            .or(offered.default_model.as_deref())
            .and_then(|id| offered.models.iter().find(|m| m.id == id));
        match model {
            Some(model) => listed(
                "effort level",
                effort_id,
                model.efforts.iter().map(String::as_str),
            )?,
            None => listed(
                "effort level",
                effort_id,
                offered
                    .models
                    .iter()
                    .flat_map(|model| model.efforts.iter().map(String::as_str)),
            )?,
        }
        if let Some(agent) = live.agent().await {
            agent.set_effort(effort_id).await?;
        }
        {
            let mut stored = live.meta.lock().await;
            let mut meta = stored.clone();
            meta.effort_id = Some(effort_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            *stored = meta;
        }
        live.publish(SessionEvent::EffortChanged {
            effort_id: effort_id.to_string(),
        })
        .await;
        Ok(())
    }

    pub async fn set_fast(
        &self,
        session_id: &str,
        fast: bool,
        providers: &ProviderMap,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let _settings = live.runtime_settings.lock().await;
        let execution = live.execution.lock().await;
        if execution
            .as_ref()
            .is_some_and(|e| e.phase == ExecutionPhase::Starting)
        {
            bail!("wait for the Agent to finish starting before changing settings");
        }
        drop(execution);

        let offered = self.offered(&live, providers).await?;
        let agent_id = live.meta.lock().await.agent_id.clone();
        let adapter = self.registry.require(&agent_id)?;
        if fast && !adapter.capabilities().set_fast {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                format!("the {} agent does not support fast mode", adapter.label()),
            ));
        }
        let current_model_id = live.meta.lock().await.model_id.clone();
        let model = current_model_id
            .as_deref()
            .and_then(|id| offered.models.iter().find(|m| m.id == id));
        if let Some(model) = model {
            if fast && !model.supports_fast {
                return Err(crate::rpc_error::failure(
                    genehub_proto::ErrorCode::Unsupported,
                    format!(
                        "the selected model '{}' does not support fast mode",
                        model.id
                    ),
                ));
            }
        }
        if let Some(agent) = live.agent().await {
            agent.set_fast(fast).await?;
        }
        {
            let mut stored = live.meta.lock().await;
            let mut meta = stored.clone();
            meta.fast = Some(fast);
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            *stored = meta;
        }
        live.publish(SessionEvent::FastChanged { fast }).await;
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
        let _interaction = live.interaction_lock.lock().await;
        let _settings = live.runtime_settings.lock().await;
        let execution = live.execution.lock().await;
        if execution
            .as_ref()
            .is_some_and(|e| e.phase == ExecutionPhase::Starting)
        {
            bail!("wait for the Agent to finish starting before changing settings");
        }
        drop(execution);

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
        if let Some(agent) = live.agent().await {
            agent.set_runtime_axis(axis_id, value_id).await?;
        }
        {
            let mut stored = live.meta.lock().await;
            let mut meta = stored.clone();
            meta.runtime_values
                .insert(axis_id.to_string(), value_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            *stored = meta;
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
        let _interaction = live.interaction_lock.lock().await;
        let _settings = live.runtime_settings.lock().await;
        let execution = live.execution.lock().await;
        if execution
            .as_ref()
            .is_some_and(|e| e.phase == ExecutionPhase::Starting)
        {
            bail!("wait for the Agent to finish starting before changing settings");
        }
        drop(execution);

        if !live.visible_permissions().await.is_empty() {
            return Err(anyhow!(
                "answer or cancel the pending Agent interaction before changing mode"
            ));
        }
        match live.agent().await {
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
            let mut stored = live.meta.lock().await;
            let mut meta = stored.clone();
            meta.mode_id = Some(mode_id.to_string());
            meta.updated_at_ms = now_ms();
            self.store.save_meta(&meta)?;
            *stored = meta;
        }
        live.publish(SessionEvent::ModeChanged {
            mode_id: mode_id.to_string(),
        })
        .await;
        Ok(())
    }
}

/// Refuses a value the agent never offered.
///
/// An empty list means the agent named nothing on that axis — not that everything
/// is allowed — but there is then no picker to have chosen from either, so the
/// value is left to whoever sent it rather than guessed at here.
pub(super) fn listed<'a>(
    axis: &str,
    value: &str,
    offered: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let offered: Vec<&str> = offered.collect();
    if offered.is_empty() || offered.contains(&value) {
        return Ok(());
    }
    Err(crate::rpc_error::failure(
        genehub_proto::ErrorCode::BadRequest,
        format!(
            "'{value}' is not a {axis} this agent offers ({})",
            offered.join(", ")
        ),
    ))
}

/// Reconcile durable choices with what this Agent offers *now*.
/// Catalog-less Agents remain opaque; declared catalogs are authoritative.
pub(super) fn normalize_runtime_selection(meta: &mut SessionMeta, catalog: &Catalog) -> bool {
    let before = (
        meta.model_id.clone(),
        meta.mode_id.clone(),
        meta.effort_id.clone(),
        meta.fast,
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
        let model = meta
            .model_id
            .as_ref()
            .or(catalog.default_model.as_ref())
            .and_then(|id| catalog.models.iter().find(|model| &model.id == id));
        let efforts = model.map(|model| model.efforts.as_slice()).unwrap_or(&[]);
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
        if let Some(model) = model {
            if !model.supports_fast && meta.fast == Some(true) {
                meta.fast = Some(false);
            }
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
            meta.fast,
            meta.runtime_values.clone(),
        )
}
