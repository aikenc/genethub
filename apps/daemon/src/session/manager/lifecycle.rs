use super::*;

impl SessionManager {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_routed(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        agent_id: &str,
        model_id: Option<String>,
        effort_id: Option<String>,
        fast: Option<bool>,
        mode_id: Option<String>,
        runtime_values: std::collections::BTreeMap<String, String>,
        title: Option<String>,
        routing_tags: Vec<String>,
        media_tags: Vec<String>,
    ) -> Result<SessionSummary> {
        let created = self
            .create(
                workspace_id,
                cwd,
                agent_id,
                model_id,
                effort_id.clone(),
                fast,
                mode_id,
                runtime_values,
                title,
            )
            .await?;
        let live = self.live(&created.id).await?;
        let mut meta = live.meta.lock().await;
        let mut next = meta.clone();
        next.tag_routing = true;
        next.routing_tags = routing_tags;
        next.media_tags = media_tags;
        self.store.save_meta(&next)?;
        *meta = next.clone();
        Ok(next.summary(SessionStatus::Idle))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        agent_id: &str,
        model_id: Option<String>,
        effort_id: Option<String>,
        fast: Option<bool>,
        mode_id: Option<String>,
        runtime_values: std::collections::BTreeMap<String, String>,
        title: Option<String>,
    ) -> Result<SessionSummary> {
        // Fail before creating anything if the agent is not real.
        self.registry.require(agent_id)?;

        let now = now_ms();
        let meta = SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            effort_id,
            fast,
            runtime_values,
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: agent_id.to_string(),
            tag_routing: false,
            routing_tags: Vec::new(),
            media_tags: Vec::new(),
            title,
            title_locked: false,
            cwd,
            model_id,
            mode_id,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist: None,
            agent_pid: None,

            human_wait: None,
            lineage: None,
            managed: None,
            managed_system_prompt: None,
            imported: None,
        };
        self.store.save_meta(&meta)?;
        // On a Windows host the guest spelling of the cwd is what every
        // adapter payload had been leaking (fb_M5CQD86STboK); log both forms
        // so the next path bug is diagnosable from the daemon log alone. The
        // host form only differs there, so Unix logs stay quiet.
        {
            let cwd_guest = meta.cwd.to_string_lossy();
            let cwd_host = crate::guest_paths::host_form(&cwd_guest);
            if cwd_host == cwd_guest {
                tracing::info!(
                    session = %meta.id,
                    agent = %meta.agent_id,
                    cwd = %cwd_guest,
                    "session created"
                );
            } else {
                tracing::info!(
                    session = %meta.id,
                    agent = %meta.agent_id,
                    cwd = %cwd_guest,
                    cwd_host = %cwd_host,
                    "session created"
                );
            }
        }
        let summary = meta.summary(SessionStatus::Idle);
        self.sessions.write().await.insert(
            meta.id.clone(),
            Arc::new(Live::new(meta, self.store.clone())),
        );
        Ok(summary)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_managed(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        agent_id: &str,
        model_id: Option<String>,
        mode_id: Option<String>,
        runtime_values: std::collections::BTreeMap<String, String>,
        title: Option<String>,
        managed: ManagedSessionInfo,
        managed_system_prompt: String,
    ) -> Result<SessionSummary> {
        self.create_managed_named(
            workspace_id,
            cwd,
            agent_id,
            model_id,
            None,
            mode_id,
            runtime_values,
            title,
            managed,
            managed_system_prompt,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_managed_named(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        agent_id: &str,
        model_id: Option<String>,
        effort_id: Option<String>,
        mode_id: Option<String>,
        runtime_values: std::collections::BTreeMap<String, String>,
        title: Option<String>,
        managed: ManagedSessionInfo,
        managed_system_prompt: String,
        stable_id: Option<String>,
    ) -> Result<SessionSummary> {
        if let Some(id) = &stable_id {
            if let Ok(existing) = self.summary(id).await {
                if existing.workspace_id != workspace_id
                    || existing.managed.as_ref().is_none_or(|info| {
                        info.workflow_run_id != managed.workflow_run_id
                            || info.node_id != managed.node_id
                    })
                {
                    bail!("diagnostic Session identity conflict");
                }
                return Ok(existing);
            }
        }
        self.registry.require(agent_id)?;
        let now = now_ms();
        let meta = SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            effort_id,
            fast: None,
            runtime_values,
            id: stable_id.unwrap_or_else(|| format!("s_{}", uuid::Uuid::new_v4().simple())),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: agent_id.to_string(),
            tag_routing: false,
            routing_tags: Vec::new(),
            media_tags: Vec::new(),
            title,
            title_locked: false,
            cwd,
            model_id,
            mode_id,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist: None,
            agent_pid: None,

            human_wait: None,
            lineage: None,
            managed: Some(managed),
            managed_system_prompt: Some(managed_system_prompt),
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

    /// Authenticates a local Agent CLI as exactly one durable Session. The
    /// proof becomes invalid when the Session no longer exists or is unreadable.
    pub async fn authenticate_controller(&self, session_id: &str, token: &str) -> bool {
        if self.summary(session_id).await.is_err() {
            return false;
        }
        let Ok(presented) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token) else {
            return false;
        };
        let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(self.controller_secret.as_bytes())
        else {
            return false;
        };
        mac.update(b"genehub.session-controller.v1\0");
        mac.update(session_id.as_bytes());
        mac.verify_slice(&presented).is_ok()
    }

    pub(super) fn controller_token(&self, session_id: &str) -> String {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(self.controller_secret.as_bytes())
            .expect("HMAC accepts every secret length");
        mac.update(b"genehub.session-controller.v1\0");
        mac.update(session_id.as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }

    pub async fn fork(
        &self,
        session_id: &str,
        turn_id: &str,
        target: Option<ForkTarget>,
        providers: &ProviderMap,
    ) -> Result<SessionSummary> {
        self.fork_with_routing(session_id, turn_id, target, providers, None)
            .await
    }

    pub(crate) async fn fork_routed(
        &self,
        session_id: &str,
        turn_id: &str,
        target: ForkTarget,
        providers: &ProviderMap,
        routing_tags: Vec<String>,
        media_tags: Vec<String>,
    ) -> Result<SessionSummary> {
        self.fork_with_routing(
            session_id,
            turn_id,
            Some(target),
            providers,
            Some((routing_tags, media_tags)),
        )
        .await
    }

    pub(super) async fn fork_with_routing(
        &self,
        session_id: &str,
        turn_id: &str,
        target: Option<ForkTarget>,
        providers: &ProviderMap,
        routing: Option<(Vec<String>, Vec<String>)>,
    ) -> Result<SessionSummary> {
        let source = self.live(session_id).await?;
        let busy = matches!(
            *source.status.lock().await,
            SessionStatus::Running | SessionStatus::Waiting
        );
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
            fork_history(&items, turn_id, busy)?
        };

        let explicit_target = target.is_some();
        let target = target.unwrap_or_else(|| ForkTarget {
            agent_id: source_meta.agent_id.clone(),
            workspace_id: None,
            model_id: source_meta.model_id.clone(),
            mode_id: source_meta.mode_id.clone(),
            effort_id: source_meta.effort_id.clone(),
            fast: source_meta.fast,
            runtime_values: source_meta.runtime_values.clone(),
        });
        let same_agent = target.agent_id == source_meta.agent_id;
        // A live turn still has usable history, but the agent is mid-prompt.
        // Reconstruct from the selected boundary instead of asking it to fork.
        let native_candidate =
            !busy && same_agent && source_adapter.capabilities().fork && checkpoint.is_some();
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
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                format!(
                    "the {} agent does not support forking",
                    source_meta.agent_id
                ),
            ));
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
        let (tag_routing, routing_tags, media_tags) = match routing {
            Some((routing_tags, media_tags)) => (true, routing_tags, media_tags),
            None if explicit_target => (false, Vec::new(), source_meta.media_tags.clone()),
            None => (
                source_meta.tag_routing,
                source_meta.routing_tags.clone(),
                source_meta.media_tags.clone(),
            ),
        };
        let meta = SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            runtime_values: target.runtime_values,
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: target.workspace_id.unwrap_or(source_meta.workspace_id),
            format: SESSION_FORMAT,
            agent_id: target.agent_id,
            tag_routing,
            routing_tags,
            media_tags,
            title,
            title_locked: source_meta.title_locked,
            cwd: source_meta.cwd,
            model_id,
            mode_id,
            effort_id,
            fast: target.fast.or(source_meta.fast),
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist,
            agent_pid: None,

            human_wait: None,
            lineage: Some(SessionLineage {
                source_session_id: session_id.to_string(),
                source_turn_id: turn_id.to_string(),
                source_agent_id: source_meta.agent_id,
                method,
                context,
            }),
            managed: None,
            managed_system_prompt: None,
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
        let busy = matches!(
            *source.status.lock().await,
            SessionStatus::Running | SessionStatus::Waiting
        );
        let meta = source.meta.lock().await.clone();
        let source_round_id = source
            .rounds
            .lock()
            .await
            .iter()
            .find(|round| round.adapter_turn_ids.iter().any(|id| id == turn_id))
            .map(|round| round.round_id.clone());
        let items = source.items.lock().await;
        let (history, _) = fork_history(&items, turn_id, busy)?;
        let through_boundary = history.len();
        let portable = history.into_iter().map(portable_fork_item).collect();
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
        // Thumbnails and blob references cross; payloads never do. A produced
        // image's original stays in the source session's blob layer and is
        // drilled into through its ref while the source remains reachable.
        let refs = source.blob_refs.lock().await;
        let mut blob_appendix: Vec<BlobOverview> =
            selected.iter().flat_map(rounds::blob_overviews).collect();
        for row in &mut blob_appendix {
            row.blob = refs.get(&row.item_id).cloned();
        }
        drop(refs);
        Ok(ForkTransfer {
            source_session_id: session_id.to_string(),
            source_turn_id: turn_id.to_string(),
            source_agent_id: meta.agent_id.clone(),
            source_round_id,
            title: meta.title.clone(),
            coverage,
            items: selected,
            blob_appendix,
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
        self.fork_import_with_routing(
            workspace_id,
            cwd,
            transfer,
            target,
            providers,
            source_accessible,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn fork_import_routed(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        transfer: ForkTransfer,
        target: ForkTarget,
        providers: &ProviderMap,
        source_accessible: bool,
        routing_tags: Vec<String>,
        media_tags: Vec<String>,
    ) -> Result<SessionSummary> {
        self.fork_import_with_routing(
            workspace_id,
            cwd,
            transfer,
            target,
            providers,
            source_accessible,
            Some((routing_tags, media_tags)),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn fork_import_with_routing(
        &self,
        workspace_id: &str,
        cwd: PathBuf,
        mut transfer: ForkTransfer,
        target: ForkTarget,
        providers: &ProviderMap,
        source_accessible: bool,
        routing: Option<(Vec<String>, Vec<String>)>,
    ) -> Result<SessionSummary> {
        let blob_appendix = std::mem::take(&mut transfer.blob_appendix);
        if target.workspace_id.as_deref() != Some(workspace_id) {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                "the fork target workspace does not match the validated workspace".to_owned(),
            ));
        }
        if !matches!(
            transfer.items.last(),
            Some(TimelineItem::TurnSummary { stats, .. })
                if stats.turn_id == transfer.source_turn_id
        ) {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Unsupported,
                "the portable fork does not end at its declared completed turn".to_owned(),
            ));
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
        let tag_routing = routing.is_some();
        let (routing_tags, media_tags) = routing.unwrap_or_default();
        let meta = SessionMeta {
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            runtime_values: target.runtime_values,
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: target.agent_id,
            tag_routing,
            routing_tags,
            media_tags,
            title: transfer
                .title
                .as_deref()
                .and_then(|title| title_from(&format!("{title} · 分支"))),
            title_locked: false,
            cwd,
            model_id,
            mode_id: target.mode_id,
            effort_id: target.effort_id,
            fast: target.fast,
            created_at_ms: now,
            updated_at_ms: now,
            archived: false,
            persist: None,
            agent_pid: None,

            human_wait: None,
            lineage: Some(SessionLineage {
                source_session_id: transfer.source_session_id,
                source_turn_id: transfer.source_turn_id,
                source_agent_id: transfer.source_agent_id,
                method: ForkMethod::ReconstructedContext,
                context: Some(built.stats),
            }),
            managed: None,
            managed_system_prompt: None,
            imported: None,
        };
        let write = || -> Result<()> {
            self.store.save_meta(&meta)?;
            self.store
                .append_chat_items(workspace_id, &meta.id, &items)?;
            self.store.save_seed(workspace_id, &meta.id, &built.seed)?;
            if !blob_appendix.is_empty() {
                self.store
                    .save_fork_appendix(workspace_id, &meta.id, &blob_appendix)?;
            }
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
            human_receipts: Vec::new(),
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            drafts: vec![],
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            format: SESSION_FORMAT,
            agent_id: candidate.agent_id.clone(),
            tag_routing: false,
            routing_tags: Vec::new(),
            media_tags: Vec::new(),
            title: history.title.or(Some(candidate.title)),
            title_locked: false,
            cwd,
            model_id: None,
            mode_id: None,
            effort_id: None,
            fast: None,
            runtime_values: Default::default(),
            created_at_ms,
            updated_at_ms,
            archived: false,
            persist: history.persist,
            agent_pid: None,



            human_wait: None,
            lineage: None,
            managed: None,
            managed_system_prompt: None,
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
}

pub(super) fn import_source_key(agent_id: &str, cwd: &std::path::Path, source_id: &str) -> String {
    let canonical = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut digest = Sha256::new();
    digest.update(agent_id.as_bytes());
    digest.update([0]);
    digest.update(canonical.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(source_id.as_bytes());
    format!("{:x}", digest.finalize())
}

pub(super) fn fork_history(
    items: &[TimelineItem],
    turn_id: &str,
    allow_in_progress: bool,
) -> Result<(Vec<TimelineItem>, Option<String>)> {
    if let Some(at) = items.iter().position(|item| {
        matches!(
            item,
            TimelineItem::TurnSummary { stats, .. } if stats.turn_id == turn_id
        )
    }) {
        let checkpoint = match &items[at] {
            TimelineItem::TurnSummary { stats, .. } => stats.fork_checkpoint.clone(),
            _ => None,
        };
        return Ok((items[..=at].to_vec(), checkpoint));
    }
    if allow_in_progress && !items.is_empty() {
        return Ok((items.to_vec(), None));
    }
    Err(anyhow!("no completed turn called {turn_id}"))
}

pub(super) fn portable_fork_item(mut item: TimelineItem) -> TimelineItem {
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

pub(super) fn bound_imported_items(items: Vec<TimelineItem>) -> (Vec<TimelineItem>, usize, usize) {
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
                received_at_ms: None,
            },
        );
    }
    (kept, omitted, altered)
}

pub(super) fn truncate_import_item(mut item: TimelineItem, max_bytes: usize) -> TimelineItem {
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
            received_at_ms: None,
        }
    }
}
