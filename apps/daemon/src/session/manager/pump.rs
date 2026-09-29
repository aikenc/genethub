use super::*;

pub(super) fn flush_reasoning_blobs(
    sender: &mpsc::UnboundedSender<BlobWrite>,
    raw: &mut HashMap<String, String>,
) {
    for (id, text) in raw.drain() {
        let value = serde_json::to_value(TimelineItem::Reasoning {
            id: id.clone(),
            text,
            received_at_ms: None,
        });
        if let Ok(value) = value {
            let _ = sender.send(BlobWrite::Put { item_id: id, value });
        }
    }
}

pub(super) fn preserve_tool_blob(sender: &mpsc::UnboundedSender<BlobWrite>, item: &TimelineItem) {
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

pub(super) async fn flush_blob_writer(sender: &mpsc::UnboundedSender<BlobWrite>) {
    let (done, wait) = oneshot::channel();
    if sender.send(BlobWrite::Flush(done)).is_ok() {
        let _ = wait.await;
    }
}

pub(super) async fn pump_events(
    live: Arc<Live>,
    mut receiver: crate::adapter::EventRx,
    store: Store,
    replay_window: usize,
    processes: Arc<crate::processes::Processes>,
    diagnostics: Arc<Diagnostics>,
    project_control: Option<crate::project_control::Broker>,
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
    let mut turns: HashMap<String, TrackedTurn> = HashMap::new();
    let mut live_usage: HashMap<String, Usage> = HashMap::new();
    let mut counted_tools: HashSet<String> = HashSet::new();
    let mut channel_closed = false;
    let mut stopping = live.pump_stop.subscribe();
    let mut checkpoint = tokio::time::interval(Duration::from_secs(1));
    checkpoint.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    'events: loop {
        let received = tokio::select! {
            biased;
            _ = async { let _ = stopping.wait_for(|stop| *stop).await; } => break,
            event = receiver.recv() => event,
            _ = checkpoint.tick() => {
                let _owner = live.execution.lock().await;
                live.persist_open_turn_if_due().await;
                // Pid is recorded once at start. A resume handle is written
                // only when it changes; an unchanged meta is not fsynced.
                let handle = live.agent().await.and_then(|agent| agent.persistence());
                if let Some(handle) = handle {
                    let mut meta = live.meta.lock().await;
                    if meta.persist.as_ref() != Some(&handle) {
                        meta.persist = Some(handle);
                        if let Err(error) = store.save_meta(&meta) {
                            tracing::error!(%error, "persisting execution checkpoint");
                        }
                    }
                }
                continue;
            }
        };
        let mut event = match received {
            Some(event) => event,
            None => {
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
        };

        // Wait for the send result to bind the execution before accepting
        // anything it emitted. Re-check after waiting, before ALL side effects.
        loop {
            let ready = {
                let owner = live.execution.lock().await;
                owner
                    .as_ref()
                    .filter(|execution| execution.phase == ExecutionPhase::Starting)
                    .map(|execution| execution.ready.subscribe())
            };
            let Some(mut ready) = ready else { break };
            if *ready.borrow() {
                break;
            }
            tokio::select! {
                biased;
                _ = async { let _ = stopping.wait_for(|stop| *stop).await; } => break 'events,
                _ = async { let _ = ready.wait_for(|ready| *ready).await; } => {}
            }
        }
        let mut owner = live.execution.lock().await;
        if owner.as_ref().is_some_and(|execution| {
            matches!(
                execution.phase,
                ExecutionPhase::Saving | ExecutionPhase::CleanupFailed
            )
        }) {
            continue;
        }
        if let Some(turn_id) = event_turn(&event) {
            if owner
                .as_ref()
                .and_then(|execution| execution.turn_id.as_deref())
                != Some(turn_id)
            {
                tracing::debug!(named = turn_id, "ignored event from an obsolete execution");
                continue;
            }
        } else if matches!(
            event,
            SessionEvent::PermissionRequested { .. } | SessionEvent::SessionStatusChanged { .. }
        ) && owner.is_none()
        {
            continue;
        }

        activity::observe(&live, &event).await;
        if let SessionEvent::TurnProgress { turn_id, usage } = &event {
            token_usage::merge_progress(live_usage.entry(turn_id.clone()).or_default(), usage);
            if let Some(merged) = live_usage.get(turn_id) {
                live.llm_rounds
                    .lock()
                    .await
                    .observe(turn_id, merged.llm_rounds as u32);
                event = SessionEvent::TurnProgress {
                    turn_id: turn_id.clone(),
                    usage: merged.clone(),
                };
            }
        }
        let tool_progress =
            token_usage::record_tool_output(&event, &mut live_usage, &mut counted_tools);

        // Shed tool-result images before anything persists, condenses or
        // publishes the event: thumbnails are generated here, produced-image
        // bytes go to the blob writer, and `data_base64` travels no further.
        {
            let images = match &mut event {
                SessionEvent::Item {
                    item: TimelineItem::ToolCall { id, images, .. },
                    ..
                } if images.iter().any(|image| image.data_base64.is_some()) => {
                    Some((id.clone(), images))
                }
                SessionEvent::ItemDelta {
                    item_id,
                    delta: ItemDelta::ToolStatus { images, .. },
                    ..
                } if images.iter().any(|image| image.data_base64.is_some()) => {
                    Some((item_id.clone(), images))
                }
                _ => None,
            };
            if let Some((item_id, images)) = images {
                let cwd = live.meta.lock().await.cwd.clone();
                let workspace_root = store
                    .workspace_root(&workspace_id)
                    .unwrap_or_else(|_| cwd.clone());
                let mut taken = std::mem::take(images);
                let shed_id = item_id.clone();
                let shed_cwd = cwd.clone();
                let shed_root = workspace_root.clone();
                let shed_session = session_id.clone();
                let shed = crate::blocking::run(move || {
                    let puts = images::shed_tool_images(
                        &shed_id,
                        &mut taken,
                        &shed_cwd,
                        &shed_root,
                        &shed_session,
                    );
                    (taken, puts)
                })
                .await;
                match shed {
                    Ok((shed_images, puts)) => {
                        *images = shed_images;
                        for put in puts {
                            let _ = blob_sender.send(BlobWrite::Put {
                                item_id: put.item_id,
                                value: put.value,
                            });
                        }
                    }
                    Err(error) => {
                        tracing::warn!("could not shed tool images for {item_id}: {error}")
                    }
                }
            }
        }

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
            let (agent_id, model_id) = {
                let meta = live.meta.lock().await;
                (meta.agent_id.clone(), meta.model_id.clone())
            };
            turns
                .entry(turn_id.clone())
                .and_modify(|turn| turn.started_at_ms = *started_at_ms)
                .or_insert_with(|| TrackedTurn {
                    started_at_ms: *started_at_ms,
                    tools: HashSet::new(),
                    agent_id,
                    model_id,
                });
        }
        if let SessionEvent::Item { turn_id, item } = &event {
            let (agent_id, model_id) = {
                let meta = live.meta.lock().await;
                (meta.agent_id.clone(), meta.model_id.clone())
            };
            let entry = turns.entry(turn_id.clone()).or_insert_with(|| TrackedTurn {
                started_at_ms: now_ms(),
                tools: HashSet::new(),
                agent_id,
                model_id,
            });
            collect_tool_ids(item, &mut entry.tools);
        }

        let updates_reasoning = match &event {
            SessionEvent::Item {
                item:
                    TimelineItem::Reasoning {
                        id,
                        text,
                        received_at_ms: None,
                    },
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
                delta:
                    ItemDelta::ToolStatus {
                        status,
                        detail,
                        images,
                    },
                ..
            } => {
                if let Some(item) = raw_tools.get_mut(item_id) {
                    if let TimelineItem::ToolCall {
                        status: raw_status,
                        detail: raw_detail,
                        images: raw_images,
                        ..
                    } = item
                    {
                        *raw_status = *status;
                        if let Some(detail) = detail {
                            *raw_detail = detail.clone();
                        }
                        if !images.is_empty() {
                            *raw_images = images.clone();
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
                | SessionEvent::Item {
                    item: TimelineItem::Compaction { .. },
                    ..
                }
        ) {
            // A compaction persists and releases its closing trunk immediately.
            // Its blob references must already be durable, just as at turn end.
            flush_blob_writer(&blob_sender).await;
        }

        let mut event = match event {
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
                        received_at_ms: None,
                    },
                }
            }
            event => {
                if let SessionEvent::Item {
                    item:
                        TimelineItem::Reasoning {
                            id,
                            text,
                            received_at_ms: None,
                        },
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

        if let SessionEvent::PermissionRequested { request } = &mut event {
            // Native RPC IDs may restart at 1 with each child. Human inputs
            // need a distinct durable identity so a retransmission cannot
            // answer a later card that reused that process-local ID.
            request.id = format!("interaction-{}", uuid::Uuid::new_v4().simple());
        }

        if let (Some(project_control), SessionEvent::PermissionRequested { request }) =
            (&project_control, &event)
        {
            match project_control
                .normalize_request(&session_id, request)
                .await
            {
                Ok(request) => event = SessionEvent::PermissionRequested { request },
                Err(error) => {
                    drop(owner);
                    fail_human_pause(&live, &store, error).await;
                    break;
                }
            }
        }

        if let SessionEvent::PermissionRequested { request } = &mut event {
            if request.kind == PermissionRequestKind::Permission
                && owner
                    .as_ref()
                    .is_some_and(|execution| execution.unattended_unavailable)
            {
                request.title = "该 Agent 无法提权".into();
                request.summary = Some("该 Agent 未声明无人值守权限模式；继续批准无法应用提权，请停止此请求后检查 Agent 的接入配置。".into());
                request.options = vec![genehub_proto::PermissionOption {
                    id: "stop-unsupported-elevation".into(),
                    label: "停止此请求".into(),
                    kind: genehub_proto::PermissionOptionKind::Reject,
                }];
            }
            if let Some(execution) = owner.as_mut() {
                execution.phase = ExecutionPhase::Stopping;
            }
            drop(owner);
            // A CLI pause can retire this pump while holding interaction.
            let _interaction = tokio::select! {
                biased;
                _ = async { let _ = stopping.wait_for(|stop| *stop).await; } => break 'events,
                guard = live.interaction_lock.lock() => guard,
            };
            let project_approval = match &project_control {
                Some(broker) => broker.is_plan_request(&session_id, &request.id).await,
                None => false,
            };
            let author = if project_approval {
                crate::session::store::WaitAuthor::Daemon
            } else {
                crate::session::store::WaitAuthor::Agent
            };
            crate::session::store::normalize_human_request(request, author);
            if let Err(error) =
                stop_agent_for_interaction(&live, &store, request, project_approval).await
            {
                fail_human_pause(&live, &store, error).await;
                break;
            }
            flush_reasoning_blobs(&blob_sender, &mut raw_thinking);
            flush_blob_writer(&blob_sender).await;
            let mut owner = live.execution.lock().await;

            // End the old turn before exposing the request. Approval later
            // starts a new native turn from the Agent's persisted session.
            if let Some(turn_id) = turns.keys().next().cloned() {
                let canceled = SessionEvent::TurnCanceled { turn_id };
                let items = live.items.lock().await;
                let (fallback_agent_id, fallback_model_id) = {
                    let meta = live.meta.lock().await;
                    (Some(meta.agent_id.clone()), meta.model_id.clone())
                };
                let stats = turn_summary(
                    &canceled,
                    &mut turns,
                    &mut live_usage,
                    &items,
                    fallback_agent_id,
                    fallback_model_id,
                );
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
                live.publish(canceled).await;
            }

            if let Err(error) = live.finish_execution(&mut owner, event, false).await {
                tracing::error!(%error, "could not commit waiting execution");
            }
            live.trim_replay(replay_window).await;
            break;
        }

        // Closing an Agent at a durable Human pause may surface as an
        // adapter crash. The user-requested pause is the authoritative cause.
        let consultation = owner
            .as_ref()
            .is_some_and(|execution| execution.consultation);
        if !consultation
            && live
                .meta
                .lock()
                .await
                .human_wait
                .as_ref()
                .is_some_and(|wait| wait.decision.is_none())
        {
            event = match event {
                SessionEvent::TurnCompleted { turn_id, .. }
                | SessionEvent::TurnFailed { turn_id, .. } => {
                    SessionEvent::TurnCanceled { turn_id }
                }
                other => other,
            };
        }
        if matches!(
            event,
            SessionEvent::TurnCompleted { .. }
                | SessionEvent::TurnFailed { .. }
                | SessionEvent::TurnCanceled { .. }
        ) {
            let cumulative = live.llm_rounds.lock().await.cumulative();
            let last_item = live.open_trunk_items.lock().await.last().cloned();
            if let (Some(id), Some(round)) = (last_item, live.active_round.lock().await.as_mut()) {
                let delta = cumulative.saturating_sub(round.last_attributed_rounds);
                *round.round_deltas.entry(id).or_default() += delta;
                round.last_attributed_rounds = cumulative;
            }
        }
        let summary = {
            let items = live.items.lock().await;
            let (fallback_agent_id, fallback_model_id) = {
                let meta = live.meta.lock().await;
                (Some(meta.agent_id.clone()), meta.model_id.clone())
            };
            turn_summary(
                &event,
                &mut turns,
                &mut live_usage,
                &items,
                fallback_agent_id,
                fallback_model_id,
            )
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

        let publish_title = match &event {
            SessionEvent::TitleChanged { title } => agent_title_would_apply(&live, title).await,
            _ => true,
        };

        if let SessionEvent::Item { item, .. } = &mut event {
            let previous = {
                let items = live.items.lock().await;
                items
                    .iter()
                    .find(|existing| existing.id() == item.id())
                    .cloned()
            };
            // Merge before both apply and publish so the store, the trunk
            // builder and every live subscriber see the completed card rather
            // than a bare status update blanking it.
            item.merge_tool_update(previous.as_ref());
            item.inherit_and_stamp_tool_times(previous.as_ref(), now_ms());
            item.inherit_and_stamp_received_at(previous.as_ref(), now_ms());
        }

        let retire = matches!(
            event,
            SessionEvent::TurnCanceled { .. } | SessionEvent::TurnFailed { .. }
        );
        let settle = matches!(
            event,
            SessionEvent::TurnCompleted { .. }
                | SessionEvent::TurnFailed { .. }
                | SessionEvent::TurnCanceled { .. }
        );
        if settle {
            if let Some(execution) = owner
                .as_ref()
                .filter(|execution| execution.phase == ExecutionPhase::Stopping)
            {
                execution.terminal.send_replace(true);
                continue;
            }
            if retire {
                if let Some(execution) = owner.as_mut() {
                    execution.phase = ExecutionPhase::Stopping;
                }
                drop(owner);
                let retirement = live.retirement.lock().await;
                if let Err(error) = close_current_agent(&live).await {
                    tracing::error!(%error, "could not retire terminal agent");
                    break;
                }
                drop(retirement);
                owner = live.execution.lock().await;
            }
            if let Err(error) = live.finish_execution(&mut owner, event, false).await {
                tracing::error!(%error, "could not commit execution completion");
            }
        } else {
            apply(&live, &event).await;
            if publish_title {
                live.publish(event).await;
            }
        }
        if let Some(progress) = tool_progress {
            apply(&live, &progress).await;
            live.publish(progress).await;
        }
        live.trim_replay(replay_window).await;

        drop(owner);
        if retire {
            break;
        }
        if settle {
            flush_deferred_durable(&live).await;
            thinking.clear();
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
        flush_deferred_durable(&live).await;
        finalize_after_channel_closed(&live, &store).await;
    }
}

pub(super) async fn flush_deferred_durable(live: &Live) {
    if let Some(seed) = live.deferred_seed.lock().await.clone() {
        let (workspace_id, session_id) = {
            let meta = live.meta.lock().await;
            (meta.workspace_id.clone(), meta.id.clone())
        };
        match live.store.save_seed(&workspace_id, &session_id, &seed) {
            Ok(()) => *live.deferred_seed.lock().await = None,
            Err(error) => tracing::warn!(
                %error,
                session = %session_id,
                "still could not write the applied context seed"
            ),
        }
    }
    if live.deferred_meta.swap(false, Ordering::SeqCst) {
        let meta = live.meta.lock().await.clone();
        if let Err(error) = live.store.save_meta(&meta) {
            live.deferred_meta.store(true, Ordering::SeqCst);
            tracing::warn!(
                %error,
                session = %meta.id,
                "still could not write the inbox turn binding"
            );
        }
    }
}

pub(super) fn turn_error_code(code: TurnErrorCode) -> &'static str {
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

pub(super) fn collect_tool_ids(item: &TimelineItem, ids: &mut HashSet<String>) {
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

pub(super) fn turn_summary(
    event: &SessionEvent,
    turns: &mut HashMap<String, TrackedTurn>,
    live_usage: &mut HashMap<String, Usage>,
    items: &[TimelineItem],
    fallback_agent_id: Option<String>,
    fallback_model_id: Option<String>,
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
    let start = items
        .iter()
        .rposition(|item| {
            matches!(
                item,
                TimelineItem::UserMessage { .. } | TimelineItem::TurnSummary { .. }
            )
        })
        .map_or(0, |index| index + 1);
    token_usage::fill_usage_from_items(&mut usage, &items[start..]);
    let finished_at_ms = now_ms();
    let (started_at_ms, tools, agent_id, model_id) = match turns.remove(turn_id) {
        Some(tracked) => (
            tracked.started_at_ms,
            tracked.tools,
            Some(tracked.agent_id),
            tracked.model_id,
        ),
        None => (
            finished_at_ms,
            HashSet::new(),
            fallback_agent_id,
            fallback_model_id,
        ),
    };
    Some(TurnStats {
        turn_id: turn_id.clone(),
        outcome,
        started_at_ms,
        finished_at_ms,
        duration_ms: finished_at_ms.saturating_sub(started_at_ms) as u64,
        usage,
        tool_calls: tools.len() as u64,
        agent_id,
        model_id,
        fork_checkpoint,
    })
}

/// Whether an Agent-extracted title should replace the current name.
///
/// Locked names (the user typed them) stay put. Empty or identical titles
/// are no-ops so a `title: null` / whitespace update cannot blank the
/// sidebar, and a repeated extraction does not spam `titleChanged`.
pub(super) async fn agent_title_would_apply(live: &Live, title: &str) -> bool {
    let Some(title) = normalize_session_title(title) else {
        return false;
    };
    if is_catalog_noise_title(&title) {
        return false;
    }
    let meta = live.meta.lock().await;
    !meta.title_locked
        && meta.title.as_deref() != Some(title.as_str())
        && agent_title_fits_current(meta.title.as_deref(), &title)
}

/// Applies an event to the in-memory timeline.
pub(super) async fn apply(live: &Live, event: &SessionEvent) {
    match event {
        SessionEvent::Item { item, .. } => {
            let mut items = live.items.lock().await;
            match items.iter_mut().find(|existing| existing.id() == item.id()) {
                Some(existing) => {
                    let mut next = item.clone();
                    next.merge_tool_update(Some(existing));
                    next.inherit_and_stamp_tool_times(Some(existing), now_ms());
                    next.inherit_and_stamp_received_at(Some(existing), now_ms());
                    *existing = next;
                }
                None => {
                    let mut next = item.clone();
                    next.inherit_and_stamp_tool_times(None, now_ms());
                    next.inherit_and_stamp_received_at(None, now_ms());
                    items.push(next);
                }
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
            live.open_turn_dirty.store(true, Ordering::SeqCst);
            live.persist_open_turn_if_due().await;
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
                ItemDelta::ToolStatus {
                    status,
                    detail,
                    images,
                } => {
                    if let TimelineItem::ToolCall {
                        status: current,
                        detail: current_detail,
                        images: current_images,
                        ..
                    } = item
                    {
                        *current = *status;
                        if let Some(detail) = detail {
                            *current_detail = detail.clone();
                        }
                        if !images.is_empty() {
                            *current_images = images.clone();
                        }
                    }
                    item.stamp_tool_times(now_ms());
                }
            }
            // Released before the write, which locks `items` itself to read
            // the narrative back: `tokio::sync::Mutex` is not reentrant.
            drop(items);
            live.open_turn_dirty.store(true, Ordering::SeqCst);
            live.persist_open_turn_if_due().await;
        }
        SessionEvent::PermissionRequested { request } => {
            {
                let mut meta = live.meta.lock().await;
                if meta
                    .human_wait
                    .as_ref()
                    .is_none_or(|wait| wait.id != request.id)
                {
                    crate::session::store::install_human_wait(&mut meta, request.clone(), false);
                }
            }
            live.card_held.store(false, Ordering::SeqCst);
            *live.status.lock().await = SessionStatus::Waiting;
        }
        SessionEvent::PermissionResolved { request_id, .. } => {
            {
                let mut meta = live.meta.lock().await;
                if meta
                    .human_wait
                    .as_ref()
                    .is_some_and(|wait| &wait.id == request_id && wait.decision.is_none())
                {
                    meta.human_wait = None;
                }
            }
            let all_resolved = live.visible_permissions().await.is_empty();
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
            let pending = !live.visible_permissions().await.is_empty();
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
            let pending = !live.visible_permissions().await.is_empty();
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
        SessionEvent::AgentChanged {
            agent_id,
            model_id,
            mode_id,
            effort_id,
            fast,
            runtime_values,
            routing_tags,
            media_tags,
        } => {
            let mut meta = live.meta.lock().await;
            meta.agent_id = agent_id.clone();
            meta.model_id = model_id.clone();
            meta.mode_id = mode_id.clone();
            meta.effort_id = effort_id.clone();
            meta.fast = *fast;
            meta.runtime_values = runtime_values.clone();
            meta.routing_tags = routing_tags.clone();
            meta.media_tags = media_tags.clone();
        }
        SessionEvent::ModeChanged { mode_id } => {
            let mut meta = live.meta.lock().await;
            meta.mode_id = Some(mode_id.clone());
        }
        SessionEvent::EffortChanged { effort_id } => {
            let mut meta = live.meta.lock().await;
            meta.effort_id = Some(effort_id.clone());
        }
        SessionEvent::FastChanged { fast } => {
            let mut meta = live.meta.lock().await;
            meta.fast = Some(*fast);
        }
        SessionEvent::RuntimeAxisChanged { axis_id, value_id } => {
            let mut meta = live.meta.lock().await;
            meta.runtime_values
                .insert(axis_id.clone(), value_id.clone());
        }
        // The mutation writes metadata before publishing. Subscribers use this
        // event as invalidation; replay must not try to reconstruct payloads.
        SessionEvent::DraftsChanged { .. } => {}
        SessionEvent::SessionStatusChanged { status } => {
            *live.status.lock().await = *status;
        }
        SessionEvent::TitleChanged { title } => {
            let Some(title) = normalize_session_title(title) else {
                return;
            };
            let mut meta = live.meta.lock().await;
            if meta.title_locked
                || meta.title.as_deref() == Some(title.as_str())
                || is_catalog_noise_title(&title)
                || !agent_title_fits_current(meta.title.as_deref(), &title)
            {
                return;
            }
            meta.title = Some(title);
            meta.updated_at_ms = now_ms();
            if let Err(error) = live.store.save_meta(&meta) {
                tracing::warn!(error = %error, "failed to persist an agent title");
            }
        }
    }
}

/// Covers the one case `TurnCompleted`/`TurnFailed`/`TurnCanceled` do not:
/// the adapter's event channel closing with no terminal event at all.
///
/// A no-op unless there was an open round — ordinary shutdown (`Live::
/// shutdown`) aborts the pump task outright rather than letting `recv` see
/// `Closed`, and a round that already settled has nothing left to clean up.
pub(super) async fn finalize_after_channel_closed(live: &Arc<Live>, _store: &Store) {
    let mut owner = live.execution.lock().await;
    let Some(execution) = owner.as_ref() else {
        return;
    };
    if execution.phase == ExecutionPhase::Stopping {
        execution.terminal.send_replace(true);
        return;
    }
    let execution_id = execution.id;
    let event = SessionEvent::TurnFailed {
        turn_id: execution.turn_id.clone().unwrap_or_default(),
        error: genehub_proto::TurnError {
            code: TurnErrorCode::AgentCrashed,
            message: "the agent event channel closed".into(),
        },
    };
    if let Some(execution) = owner.as_mut() {
        execution.phase = ExecutionPhase::Stopping;
        execution.cancel.send_replace(true);
        execution.ready.send_replace(true);
    }
    drop(owner);
    let _retirement = live.retirement.lock().await;
    if let Err(error) = close_current_agent(live).await {
        tracing::error!(%error, "could not close Agent after event stream failure");
        return;
    }
    let mut owner = live.execution.lock().await;
    if owner.as_ref().is_none_or(|e| e.id != execution_id) {
        return;
    }
    if let Err(error) = live.finish_execution(&mut owner, event, false).await {
        tracing::error!(%error, "could not commit closed event channel");
    }
}

pub(super) fn event_turn(event: &SessionEvent) -> Option<&str> {
    match event {
        SessionEvent::TurnStarted { turn_id, .. }
        | SessionEvent::TurnCompleted { turn_id, .. }
        | SessionEvent::TurnFailed { turn_id, .. }
        | SessionEvent::TurnCanceled { turn_id }
        | SessionEvent::TurnProgress { turn_id, .. }
        | SessionEvent::Item { turn_id, .. }
        | SessionEvent::ItemDelta { turn_id, .. } => Some(turn_id),
        _ => None,
    }
}

/// Records a round's final state on `chat.jsonl`.
///
/// Failure is logged, not propagated: a missing record degrades a later
/// cross-session query to "this round is invisible to it", not data loss —
/// the round's narrative and trunks already reached disk.
pub(super) async fn persist_round(live: &Live, round: ActiveRound) {
    if round.outcome.is_none() {
        // Should not happen: every caller only reaches here after setting an
        // outcome. Guarded anyway rather than unwrapped, because a ledger
        // write is not worth a panic over.
        return;
    }
    live.record_round(&round).await;
}

pub(super) fn visible_message_preview(
    items: &[TimelineItem],
) -> Option<genehub_proto::SessionMessagePreview> {
    items.iter().rev().find_map(|item| match item {
        TimelineItem::UserMessage { id, text, .. }
        | TimelineItem::AssistantMessage { id, text, .. } => {
            Some(genehub_proto::SessionMessagePreview {
                item_id: id.clone(),
                text: text.chars().take(160).collect(),
                at_ms: now_ms(),
            })
        }
        _ => None,
    })
}

pub(super) fn latest_reply(items: &[TimelineItem]) -> Option<genehub_proto::SessionReplyCursor> {
    items.iter().rev().find_map(|item| match item {
        TimelineItem::AssistantMessage { id, text, .. } if !text.trim().is_empty() => {
            Some(genehub_proto::SessionReplyCursor {
                item_id: id.clone(),
                at_ms: now_ms(),
            })
        }
        _ => None,
    })
}

/// Writes what this turn produced, once, when the turn ends: narrative to the
/// chat layer, work to the open trunk.
pub(super) async fn flush_turn(live: &Live, store: &Store) -> Result<()> {
    let pending_rounds = live.unsaved_rounds.lock().await.clone();
    if !pending_rounds.is_empty() {
        let meta = live.meta.lock().await.clone();
        let records = live.rounds.lock().await.clone();
        for record in records
            .iter()
            .filter(|record| pending_rounds.contains(&record.round_id))
        {
            store.append_round(&meta.workspace_id, &meta.id, record)?;
        }
        live.unsaved_rounds
            .lock()
            .await
            .retain(|id| !pending_rounds.contains(id));
    }
    let ids = live.turn_items.lock().await.clone();
    if ids.is_empty() {
        return Ok(());
    }
    let settled = live.turn_narrative(&ids).await;

    let (workspace_id, session_id) = {
        let meta = live.meta.lock().await;
        (meta.workspace_id.clone(), meta.id.clone())
    };
    live.persist_open_trunk().await;
    store.append_chat_items(&workspace_id, &session_id, &settled)?;
    live.turn_items.lock().await.retain(|id| !ids.contains(id));
    store.clear_open_turn(&workspace_id, &session_id);
    live.open_turn_written_ms.store(0, Ordering::SeqCst);
    live.open_turn_dirty.store(false, Ordering::SeqCst);
    let mut meta = live.meta.lock().await;
    meta.updated_at_ms = now_ms();
    if let Some(preview) = visible_message_preview(&settled) {
        meta.message_preview = Some(preview);
    }
    if let Some(reply) = latest_reply(&settled) {
        meta.latest_reply = Some(reply);
    }
    store.save_meta(&meta)?;
    Ok(())
}
