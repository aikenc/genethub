use super::*;

impl SessionManager {
    /// The committed input intent fences Workflow replay after a crash.
    pub(crate) async fn workflow_prompt_delivered(&self, session_id: &str) -> Result<bool> {
        let live = self.live(session_id).await?;
        let delivered = live.meta.lock().await.inbox.has_delivered;
        Ok(delivered)
    }

    async fn artifact_workspace(&self, session_id: &str) -> Result<String> {
        // Upload RPCs need identity and format, not a hydrated conversation.
        if let Some(live) = self.sessions.read().await.get(session_id).cloned() {
            let meta = live.meta.lock().await;
            if self.store.is_tombstoned(&meta.workspace_id, session_id) {
                return Err(SessionMissing(session_id.into()).into());
            }
            return Ok(meta.workspace_id.clone());
        }
        let meta = self
            .store
            .list_meta()?
            .into_iter()
            .find(|m| m.id == session_id)
            .ok_or_else(|| SessionMissing(session_id.into()))?;
        if !meta.openable() {
            bail!("session uses an unsupported storage format");
        }
        Ok(meta.workspace_id)
    }

    pub async fn begin_artifact(
        &self,
        session_id: &str,
        files: Vec<SessionArtifactFile>,
        metadata: serde_json::Value,
    ) -> Result<SessionArtifactUpload> {
        let workspace_id = self.artifact_workspace(session_id).await?;
        self.store
            .begin_artifact(&workspace_id, session_id, files, metadata)
            .await
    }

    pub async fn write_artifact_chunk(
        &self,
        session_id: &str,
        upload_id: &str,
        file_index: u32,
        offset: u64,
        data_base64: &str,
    ) -> Result<()> {
        let workspace_id = self.artifact_workspace(session_id).await?;
        self.store
            .write_artifact_chunk(
                &workspace_id,
                session_id,
                upload_id,
                file_index,
                offset,
                data_base64,
            )
            .await
    }

    pub async fn finish_artifact(
        &self,
        session_id: &str,
        upload_id: &str,
    ) -> Result<SessionArtifactBundle> {
        let workspace_id = self.artifact_workspace(session_id).await?;
        self.store
            .finish_artifact(&workspace_id, session_id, upload_id)
            .await
    }

    pub async fn abort_artifact(&self, session_id: &str, upload_id: &str) -> Result<()> {
        let workspace_id = self.artifact_workspace(session_id).await?;
        self.store
            .abort_artifact(&workspace_id, session_id, upload_id)
            .await
    }

    pub async fn list(
        &self,
        workspace_id: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<SessionSummary>> {
        let mut out = Vec::new();
        for mut meta in self.store.list_meta()? {
            if let Some(workspace) = workspace_id {
                if meta.workspace_id != workspace {
                    continue;
                }
            }
            if meta.archived && !include_archived {
                continue;
            }
            match self.store.repair_catalog_noise_title(&mut meta) {
                Ok(true) => {
                    if let Some(live) = self.sessions.read().await.get(&meta.id) {
                        let mut live_meta = live.meta.lock().await;
                        if !live_meta.title_locked {
                            live_meta.title = meta.title.clone();
                            live_meta.updated_at_ms = meta.updated_at_ms;
                        }
                    }
                }
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    error = %error,
                    session_id = %meta.id,
                    "could not repair a catalog-heading session title"
                ),
            }
            // A suspended approval survives daemon restarts without a live
            // Agent process or client connection.
            let (status, activity) = match self.sessions.read().await.get(&meta.id) {
                Some(live) => {
                    let status = *live.status.lock().await;
                    (status, live.activity_of(status))
                }
                None if meta.execution_retired => (SessionStatus::Closed, None),
                None if meta.awaiting_human() => (SessionStatus::Waiting, None),
                None => (SessionStatus::Idle, None),
            };
            let mut summary = meta.summary_with_activity(status, activity);
            if let Some(live) = self.sessions.read().await.get(&meta.id) {
                summary.interaction_summary = Some(super::store::interaction_summary(
                    live.visible_permissions().await.iter(),
                ));
            }
            out.push(summary);
        }
        Ok(out)
    }

    pub async fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot> {
        let live = self.live(session_id).await?;
        live.snapshot().await
    }

    /// History-only reads share the snapshot shape but never create a subscription.
    pub async fn history_snapshot(
        &self,
        session_id: &str,
        recent_rounds: u32,
        before_item_id: Option<&str>,
    ) -> Result<SessionSnapshot> {
        let live = self.live(session_id).await?;
        let snapshot = self.snapshot_for_open(&live, false).await?;
        Self::window_snapshot(snapshot, recent_rounds, before_item_id)
    }

    pub(super) fn window_snapshot(
        mut snapshot: SessionSnapshot,
        recent_rounds: u32,
        before_item_id: Option<&str>,
    ) -> Result<SessionSnapshot> {
        let end = match before_item_id {
            Some(id) => snapshot
                .items
                .iter()
                .position(|item| item.id() == id)
                .ok_or_else(|| anyhow!("history cursor no longer exists; reopen the session"))?,
            None => snapshot.items.len(),
        };
        let rounds = snapshot.rounds.as_deref().unwrap_or(&[]);
        let positions: HashMap<&str, usize> = snapshot.items[..end]
            .iter()
            .enumerate()
            .map(|(index, item)| (item.id(), index))
            .collect();
        let boundaries: Vec<usize> = rounds
            .iter()
            .filter_map(|round| round.user_item_id.as_deref())
            .filter_map(|id| positions.get(id).copied())
            .collect();
        let limit = recent_rounds.clamp(1, 100) as usize;
        // Unround legacy/imported history remains reachable through the same stable cursor.
        let mut start = if boundaries.len() > limit {
            boundaries[boundaries.len() - limit]
        } else if boundaries.is_empty() {
            end.saturating_sub(limit * 4)
        } else {
            0
        };
        // Bound pathological legacy histories as well as the ordinary round count.
        start = start.max(end.saturating_sub(128));
        for item in &mut snapshot.items[start..end] {
            let bytes = serde_json::to_vec(item)?.len();
            if bytes <= 16 * 1024 {
                continue;
            }
            match item {
                TimelineItem::UserMessage {
                    id,
                    text,
                    attachments,
                } => {
                    snapshot
                        .history_excerpt_ids
                        .get_or_insert_with(Vec::new)
                        .push(id.clone());
                    *text = text.chars().take(2048).collect();
                    attachments.clear();
                }
                TimelineItem::AssistantMessage { id, text, .. } => {
                    snapshot
                        .history_excerpt_ids
                        .get_or_insert_with(Vec::new)
                        .push(id.clone());
                    *text = text.chars().take(2048).collect();
                }
                _ => {}
            }
        }
        snapshot.history_before = (start > 0).then(|| snapshot.items[start].id().to_owned());
        snapshot.items = snapshot.items[start..end].to_vec();
        if let Some(rounds) = snapshot.rounds.as_mut() {
            rounds.retain(|round| {
                round
                    .user_item_id
                    .as_deref()
                    .is_some_and(|id| snapshot.items.iter().any(|item| item.id() == id))
            });
        }
        snapshot.history_windowed = Some(true);
        Ok(snapshot)
    }

    /// Which Space this Session instantiates, and the two directories its
    /// Component Instances write to. The caller supplies the Space's
    /// composition, so this stays ignorant of the project registry.
    pub async fn component_scope(&self, session_id: &str) -> Result<(String, PathBuf, PathBuf)> {
        let live = self.live(session_id).await?;
        let workspace_id = live.meta.lock().await.workspace_id.clone();
        let space_home = self.store.space_home(&workspace_id)?;
        let session_dir = self.store.session_dir(&workspace_id, session_id)?;
        Ok((workspace_id, space_home, session_dir))
    }

    /// A bounded-reader view frozen at an optional round boundary. This is the
    /// single source for the CLI pages below, so inspect/narrative/rounds agree
    /// on both the digest and what "through round" means.
    pub(super) async fn read_view(
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
                    .ok_or_else(|| {
                        crate::rpc_error::failure(
                            genehub_proto::ErrorCode::NotFound,
                            format!("no such round: {round_id}"),
                        )
                    })?,
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
        let live = self.live(session_id).await?;
        let status = *live.status.lock().await;
        Ok(SessionInspection {
            summary: view
                .meta
                .summary_with_activity(status, live.activity_of(status)),
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
                .ok_or_else(|| {
                    crate::rpc_error::failure(
                        genehub_proto::ErrorCode::NotFound,
                        format!("no such narrative item: {item_id}"),
                    )
                })?;
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
        exclude_open_round: bool,
    ) -> Result<SessionContext> {
        let through_round_id = if exclude_open_round {
            let live = self.live(session_id).await?;
            let views = self.round_views(&live).await;
            match closed_round_before_open(&views, through_round_id)? {
                ClosedBoundary::Through(round_id) => Some(round_id),
                ClosedBoundary::Unchanged(round_id) => round_id,
                ClosedBoundary::Empty => {
                    let meta = live.meta.lock().await.clone();
                    let budget = token_budget
                        .unwrap_or(crate::session::context_seed::DEFAULT_SEED_TOKEN_BUDGET)
                        .clamp(2_048, 64_000);
                    let coverage = meta
                        .imported
                        .as_ref()
                        .and_then(|imported| imported.coverage.clone())
                        .unwrap_or(HistoryCoverage {
                            source_item_count: Some(0),
                            retained_item_count: 0,
                            omitted_item_count: 0,
                            retrieval: RetrievalCapability::Genehub,
                            reason: None,
                        });
                    return Ok(build_context_seed(
                        session_id,
                        "none",
                        None,
                        &meta.agent_id,
                        &[],
                        budget,
                        coverage,
                    )
                    .context);
                }
            }
        } else {
            through_round_id.map(str::to_string)
        };
        let view = self
            .read_view(session_id, through_round_id.as_deref())
            .await?;
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
                .unwrap_or(crate::session::context_seed::DEFAULT_SEED_TOKEN_BUDGET)
                .clamp(2_048, 64_000),
            view.coverage,
        );
        Ok(built.context)
    }

    pub(super) async fn snapshot_for_open(
        &self,
        live: &Arc<Live>,
        expand_last_round: bool,
    ) -> Result<SessionSnapshot> {
        let snapshot = live.snapshot().await?;
        self.enrich_snapshot(live, snapshot, expand_last_round)
            .await
    }

    async fn enrich_snapshot(
        &self,
        live: &Arc<Live>,
        mut snapshot: SessionSnapshot,
        expand_last_round: bool,
    ) -> Result<SessionSnapshot> {
        // The open trunk's work items live alongside the narrative in memory
        // so the round layer can serve them without a read; they are addressed
        // through that layer, never replayed here.
        snapshot.items.retain(|item| !store::is_work_item(item));
        let views = self.round_views(live).await;
        snapshot.rounds = Some(views.iter().map(round_summary).collect());
        if expand_last_round {
            if let Some(last) = views.last() {
                snapshot.expanded_round = Some(Box::new(
                    self.build_round_layer(live, last, None, 20, true).await?,
                ));
            }
        }
        Ok(snapshot)
    }

    /// Every round of the session, folded, straight from what `chat.jsonl`
    /// already put in memory. Touches no round directory: a session with four
    /// rounds and a session with four hundred cost the same here.
    pub(super) async fn round_views(&self, live: &Arc<Live>) -> Vec<RoundView> {
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
                source: None,
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
                    source: None,
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
        // A fork owns its new rounds, while its inherited narrative refers to
        // immutable completed turns in its ancestry. Resolve those rounds from
        // their actual storage owner; never widen access beyond captured turns.
        let meta = live.meta.lock().await.clone();
        if meta.lineage.is_some() {
            let mut cached = live.inherited_rounds.lock().await;
            if let Some(inherited) = cached.as_ref() {
                views.extend(inherited.iter().cloned());
                views.sort_by_key(|view| (view.started_at_ms, view.ord));
                return views;
            }
            let own_count = views.len();
            let mut complete = true;
            let captured: HashSet<String> = live
                .items
                .lock()
                .await
                .iter()
                .filter_map(|item| {
                    if let TimelineItem::TurnSummary { stats, .. } = item {
                        Some(stats.turn_id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            let metas = match self.store.list_meta() {
                Ok(metas) => metas,
                Err(_) => return views,
            };
            let mut lineage = meta.lineage;
            let mut visited = HashSet::from([meta.id]);
            while let Some(origin) = lineage {
                if !visited.insert(origin.source_session_id.clone()) {
                    break;
                }
                let Some(parent) = metas
                    .iter()
                    .find(|meta| meta.id == origin.source_session_id)
                else {
                    break;
                };
                let Ok(chat) = self.store.load_chat(&parent.workspace_id, &parent.id) else {
                    complete = false;
                    break;
                };
                for record in chat.rounds {
                    if record.adapter_turn_ids.is_empty()
                        || !record
                            .adapter_turn_ids
                            .iter()
                            .all(|id| captured.contains(id))
                        || record.outcome.is_none()
                        || views.iter().any(|view| view.round_id == record.round_id)
                    {
                        continue;
                    }
                    views.push(RoundView {
                        source: Some((parent.workspace_id.clone(), parent.id.clone())),
                        round_id: record.round_id,
                        ord: record.ord,
                        user_item_id: record.user_item_id,
                        started_at_ms: record.started_at_ms,
                        ended_at_ms: record.ended_at_ms,
                        outcome: match record.outcome {
                            Some(RoundOutcome::Completed) => RoundLayerOutcome::Completed,
                            Some(RoundOutcome::Canceled) => RoundLayerOutcome::Canceled,
                            Some(RoundOutcome::Superseded) => RoundLayerOutcome::Superseded,
                            _ => RoundLayerOutcome::Failed,
                        },
                        trunk_count: record.trunk_count,
                    });
                }
                lineage = parent.lineage.clone();
            }
            if complete {
                *cached = Some(views[own_count..].to_vec());
            }
        }
        views.sort_by_key(|view| (view.started_at_ms, view.ord));
        views
    }

    /// The trunk index for one round: closed trunks from its own index file,
    /// plus the trunk still being built, which only memory knows about.
    pub(super) async fn trunk_index(
        &self,
        live: &Arc<Live>,
        view: &RoundView,
    ) -> Result<Vec<TrunkSummary>> {
        let meta = live.meta.lock().await.clone();
        let (workspace_id, session_id) = view
            .source
            .as_ref()
            .map(|(workspace, session)| (workspace.as_str(), session.as_str()))
            .unwrap_or((&meta.workspace_id, &meta.id));
        let mut summaries = self
            .store
            .load_trunk_index(workspace_id, session_id, view.ord)?;
        if let Some(open) = self.open_trunk(live, view).await {
            match summaries
                .iter_mut()
                .find(|summary| summary.index == open.summary.index)
            {
                Some(existing) => *existing = open.summary,
                None => summaries.push(open.summary),
            }
        }
        // Codex builds that emitted both the started and completed
        // `contextCompaction` item could persist the same marker twice. The
        // first marker closed the real trunk; the second became a marker-only
        // trunk. Keep old sessions readable without rewriting their ledger.
        let mut marker_ids = HashSet::new();
        summaries.retain(|summary| {
            let duplicate_marker_only = summary.blob_count == 0
                && summary.batches.len() == 1
                && summary.batches[0].marker.is_some()
                && marker_ids.contains(&summary.batches[0].first_item_id);
            for batch in &summary.batches {
                if batch.marker.is_some() {
                    marker_ids.insert(batch.first_item_id.clone());
                }
            }
            !duplicate_marker_only
        });
        Ok(summaries)
    }

    /// The trunk currently being built for this round, if this round is the
    /// open one and it has anything in it yet.
    pub(super) async fn open_trunk(
        &self,
        live: &Arc<Live>,
        view: &RoundView,
    ) -> Option<RoundTrunk> {
        if view.source.is_some() {
            return None;
        }
        let index = {
            let active = live.active_round.lock().await;
            let round = active.as_ref()?;
            // A terminal records its outcome before finish_trunk has completed.
            // Keep that settling trunk readable until its items move to the
            // closed index; otherwise list followed by get can transiently
            // report "no such trunk" at the exact end of a turn.
            if round.round_id != view.round_id {
                return None;
            }
            round.closed_trunks.len() as u32
        };
        live.build_open_trunk(index, None).await
    }

    pub(super) async fn build_round_layer(
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
    pub(super) async fn build_round_trunk(
        &self,
        live: &Arc<Live>,
        view: &RoundView,
        summary: &TrunkSummary,
    ) -> Result<RoundTrunk> {
        let mut meta = live.meta.lock().await.clone();
        if let Some((workspace_id, session_id)) = &view.source {
            meta.workspace_id = workspace_id.clone();
            meta.id = session_id.clone();
        }
        let mut trunk = if let Some(open) = self.open_trunk(live, view).await {
            if open.summary.index == summary.index {
                open
            } else {
                self.store
                    .load_trunk(&meta.workspace_id, &meta.id, view.ord, summary)?
            }
        } else {
            self.store
                .load_trunk(&meta.workspace_id, &meta.id, view.ord, summary)?
        };
        if let Ok(root) = self.store.workspace_root(&meta.workspace_id) {
            let store = self.store.clone();
            let workspace_id = meta.workspace_id.clone();
            let session_id = meta.id.clone();
            images::hydrate_produced_images(
                &root,
                &session_id,
                |blob| store.get_blob(&workspace_id, &session_id, blob),
                &mut trunk,
            );
        }
        Ok(trunk)
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
        .ok_or_else(|| {
            crate::rpc_error::failure(
                genehub_proto::ErrorCode::NotFound,
                format!("no such round: {round_id}"),
            )
        })?;
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
            .ok_or_else(|| {
                crate::rpc_error::failure(
                    genehub_proto::ErrorCode::NotFound,
                    format!("no such round: {round_id}"),
                )
            })?;
        let summary = self
            .trunk_index(&live, view)
            .await?
            .into_iter()
            .find(|summary| summary.index == trunk_index)
            .ok_or_else(|| {
                crate::rpc_error::failure(
                    genehub_proto::ErrorCode::NotFound,
                    format!("no such trunk: {trunk_index}"),
                )
            })?;
        self.build_round_trunk(&live, view, &summary).await
    }

    pub async fn blob(&self, session_id: &str, blob: &BlobRef) -> Result<BlobPayload> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await.clone();
        if let Some(payload) = self.store.get_blob(&meta.workspace_id, &meta.id, blob)? {
            return Ok(payload);
        }
        // A locator alone is not authority to read a parent's blob bucket.
        // It must appear in a round visible within this fork's boundary.
        for view in self.round_views(&live).await {
            let Some((workspace_id, owner_id)) = &view.source else {
                continue;
            };
            for summary in self
                .store
                .load_trunk_index(workspace_id, owner_id, view.ord)?
            {
                let trunk = self
                    .store
                    .load_trunk(workspace_id, owner_id, view.ord, &summary)?;
                if trunk
                    .batches
                    .iter()
                    .flat_map(|batch| &batch.blobs)
                    .any(|row| row.blob.as_ref().is_some_and(|reference| reference == blob))
                {
                    return self
                        .store
                        .get_blob(workspace_id, owner_id, blob)?
                        .ok_or_else(|| {
                            crate::rpc_error::failure(
                                genehub_proto::ErrorCode::NotFound,
                                format!("no such blob: {}", blob.id),
                            )
                        });
                }
            }
        }
        Err(crate::rpc_error::failure(
            genehub_proto::ErrorCode::NotFound,
            format!("no such blob: {}", blob.id),
        ))
    }

    /// Batch variant of `round_trunk`: one live lookup, then the same
    /// per-trunk reads in request order. Any unknown locator fails the whole
    /// batch — a partial answer would silently mislead the caller's budget
    /// accounting.
    pub async fn round_trunks(
        &self,
        session_id: &str,
        refs: &[TrunkLocator],
    ) -> Result<Vec<RoundTrunk>> {
        if refs.len() > MAX_BATCH_GET {
            bail!("batch too large: {} refs (max {MAX_BATCH_GET})", refs.len());
        }
        let mut trunks = Vec::with_capacity(refs.len());
        for locator in refs {
            trunks.push(
                self.round_trunk(session_id, &locator.round_id, locator.trunk_index)
                    .await?,
            );
        }
        Ok(trunks)
    }

    /// Batch variant of `blob`: same per-blob semantics in request order,
    /// all-or-nothing like `round_trunks`.
    pub async fn blobs(&self, session_id: &str, blobs: &[BlobRef]) -> Result<Vec<BlobPayload>> {
        if blobs.len() > MAX_BATCH_GET {
            bail!(
                "batch too large: {} blobs (max {MAX_BATCH_GET})",
                blobs.len()
            );
        }
        let mut payloads = Vec::with_capacity(blobs.len());
        for blob in blobs {
            payloads.push(self.blob(session_id, blob).await?);
        }
        Ok(payloads)
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
        self.subscribe_window(session_id, since_seq, expand_last_round, None)
            .await
    }

    /// External cursors must include their incarnation; old or missing epochs
    /// receive a fresh snapshot even when the numeric sequence happens to match.
    pub async fn subscribe_epoch(
        &self,
        session_id: &str,
        since_seq: Option<u64>,
        since_epoch: Option<&str>,
        expand_last_round: bool,
        recent_rounds: Option<u32>,
    ) -> Result<(
        SessionSnapshot,
        Vec<SequencedEvent>,
        bool,
        broadcast::Receiver<SequencedEvent>,
    )> {
        let live = self.live(session_id).await?;
        let cursor = if since_epoch == Some(live.stream_epoch.as_str()) {
            since_seq
        } else {
            None
        };
        self.subscribe_window(session_id, cursor, expand_last_round, recent_rounds)
            .await
    }

    pub async fn subscribe_window(
        &self,
        session_id: &str,
        since_seq: Option<u64>,
        expand_last_round: bool,
        recent_rounds: Option<u32>,
    ) -> Result<(
        SessionSnapshot,
        Vec<SequencedEvent>,
        bool,
        broadcast::Receiver<SequencedEvent>,
    )> {
        let live = self.live(session_id).await?;
        // Subscribe before snapshotting so nothing can slip through the gap
        // between the two.
        let _owner = live.execution.lock().await;
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
                } else if seq > current
                    || oldest.is_none_or(|oldest| seq.saturating_add(1) < oldest)
                {
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

        let snapshot = live.snapshot_unlocked().await?;
        drop(_owner);
        let snapshot = self
            .enrich_snapshot(&live, snapshot, expand_last_round)
            .await?;
        let snapshot = match recent_rounds {
            Some(limit) => Self::window_snapshot(snapshot, limit, None)?,
            None => snapshot,
        };
        Ok((snapshot, events, reset, receiver))
    }
}

pub(super) fn round_summary(view: &RoundView) -> RoundSummary {
    RoundSummary {
        round_id: view.round_id.clone(),
        user_item_id: view.user_item_id.clone(),
        started_at_ms: view.started_at_ms,
        ended_at_ms: view.ended_at_ms,
        outcome: view.outcome,
        trunk_count: view.trunk_count,
    }
}

pub(super) fn coverage_for_meta(meta: &SessionMeta, retained_items: usize) -> HistoryCoverage {
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

pub(super) fn parse_trunk_cursor(cursor: Option<&str>, len: usize) -> Result<usize> {
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

/// Step the context boundary back when it lands on the running round. A closed
/// round stays. No earlier round means the capsule is empty.
pub(super) fn closed_round_before_open(
    views: &[RoundView],
    through_round_id: Option<&str>,
) -> Result<ClosedBoundary> {
    let index = match through_round_id {
        Some(round_id) => Some(
            views
                .iter()
                .position(|view| view.round_id == round_id)
                .ok_or_else(|| {
                    crate::rpc_error::failure(
                        genehub_proto::ErrorCode::NotFound,
                        format!("no such round: {round_id}"),
                    )
                })?,
        ),
        None => views.len().checked_sub(1),
    };
    let Some(index) = index else {
        return Ok(ClosedBoundary::Unchanged(None));
    };
    if views[index].outcome != RoundLayerOutcome::Running {
        return Ok(ClosedBoundary::Unchanged(
            through_round_id.map(str::to_string),
        ));
    }
    match index.checked_sub(1) {
        Some(previous) => Ok(ClosedBoundary::Through(views[previous].round_id.clone())),
        None => Ok(ClosedBoundary::Empty),
    }
}
