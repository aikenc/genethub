//! Durable admission and serialized delivery inside the existing Session.
use super::super::store::InboxEntry;
use super::*;
use crate::state::Shared;

const MAX_PENDING: usize = 32;
const MAX_RECEIPTS: usize = 4096;

impl SessionManager {
    /// The ACK covers the original chat item and its delivery obligation.
    pub(crate) async fn accept_input(
        &self,
        session_id: &str,
        message_id: String,
        text: String,
        attachments: Vec<Attachment>,
        task_run_id: Option<String>,
        source: &str,
    ) -> Result<()> {
        if message_id.is_empty()
            || message_id.len() > 128
            || !message_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
        {
            bail!("messageId must be a stable identifier of at most 128 characters");
        }
        if text.len() > 65_536 || attachments.len() > 16 {
            bail!("one accepted message is limited to 64 KiB of text and 16 attachments");
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &text,
                &attachments,
                &task_run_id,
                source
            ))?)
        );
        let live = self.live(session_id).await?;
        let _admission = live.inbox_lock.lock().await;
        if live.closing.load(Ordering::SeqCst) {
            bail!("the session is closing");
        }
        if let Some(existing) = live
            .items
            .lock()
            .await
            .iter()
            .find(|item| item.id() == message_id)
        {
            let expected = TimelineItem::UserMessage {
                id: message_id.clone(),
                text: text.clone(),
                attachments: attachments.clone(),
            };
            if serde_json::to_value(existing)? != serde_json::to_value(expected)? {
                bail!("messageId collides with an existing chat item");
            }
        }
        {
            let mut meta = live.meta.lock().await;
            if meta.managed.is_some() {
                bail!("durable consultation is available on ordinary PM sessions");
            }
            if meta
                .imported
                .as_ref()
                .is_some_and(|imported| imported.continuation == ImportContinuation::ReadOnly)
            {
                bail!("this imported session cannot resume");
            }
            if let Some(entry) = meta
                .inbox
                .entries
                .iter()
                .find(|entry| entry.message_id == message_id)
            {
                if entry.digest != digest {
                    bail!("messageId already belongs to different content or a different target");
                }
                if entry.state != "receiving" {
                    return Ok(());
                }
            } else {
                if meta.inbox.entries.len() >= MAX_RECEIPTS
                    || meta
                        .inbox
                        .entries
                        .iter()
                        .filter(|entry| entry.state != "handled")
                        .count()
                        >= MAX_PENDING
                {
                    bail!("the session input ledger or pending queue is full; resolve pending inputs before sending more");
                }
                let mut next = meta.clone();
                next.inbox.entries.push(InboxEntry {
                    message_id: message_id.clone(),
                    received_at_ms: now_ms(),
                    digest,
                    source: source.into(),
                    task_run_id,
                    state: "receiving".into(),
                    turn_id: None,
                });
                next.format = SESSION_FORMAT;
                self.store.save_meta(&next)?;
                *meta = next;
            }
        }
        let item = TimelineItem::UserMessage {
            id: message_id.clone(),
            text: text.clone(),
            attachments,
        };
        let workspace_id = live.meta.lock().await.workspace_id.clone();
        // A previous append may have succeeded even when its caller saw an IO error.
        let chat = self.store.load_chat(&workspace_id, session_id)?;
        if !chat
            .items
            .iter()
            .any(|existing| existing.id() == message_id)
        {
            self.store
                .append_chat_items(&workspace_id, session_id, std::slice::from_ref(&item))?;
        }
        {
            let mut items = live.items.lock().await;
            if !items.iter().any(|existing| existing.id() == message_id) {
                items.push(item.clone());
            }
        }
        let title = {
            let mut meta = live.meta.lock().await;
            let mut next = meta.clone();
            let entry = next
                .inbox
                .entries
                .iter_mut()
                .find(|entry| entry.message_id == message_id)
                .expect("reserved input");
            entry.state = "queued".into();
            if source == "user" {
                next.inbox.paused = false;
                next.inbox.error = None;
            }
            next.message_preview = visible_message_preview(std::slice::from_ref(&item));
            let title = if next.title.is_none() && source == "user" {
                title_from(&text)
            } else {
                None
            };
            if let Some(title) = &title {
                next.title = Some(title.clone());
            }
            next.updated_at_ms = now_ms();
            self.store.save_meta(&next)?;
            *meta = next;
            title
        };
        live.publish(SessionEvent::Item {
            turn_id: String::new(),
            item,
        })
        .await;
        if let Some(title) = title {
            live.publish(SessionEvent::TitleChanged { title }).await;
        }
        Ok(())
    }

    pub(crate) async fn recover_inputs(&self) -> Result<()> {
        for meta in self.store.list_meta()? {
            if !meta.openable()
                || !meta
                    .inbox
                    .entries
                    .iter()
                    .any(|entry| entry.state != "handled")
            {
                continue;
            }
            let live = self.live(&meta.id).await?;
            let chat = self.store.load_chat(&meta.workspace_id, &meta.id)?;
            let mut current = live.meta.lock().await;
            let mut next = current.clone();
            for entry in &mut next.inbox.entries {
                if entry.state == "receiving"
                    && chat.items.iter().any(|item| item.id() == entry.message_id)
                {
                    entry.state = "queued".into();
                }
                if entry.state == "sent" && entry.turn_id.as_ref().is_some_and(|turn_id| chat.items.iter().any(|item|
                    matches!(item, TimelineItem::TurnSummary { stats, .. } if &stats.turn_id == turn_id && stats.outcome == TurnOutcome::Completed))) {
                    entry.state = "handled".into();
                }
            }
            self.store.save_meta(&next)?;
            *current = next;
        }
        Ok(())
    }

    /// Work is per Session: a slow adapter handover never blocks other inboxes.
    pub(crate) async fn dispatch_inputs(&self, state: &Shared) {
        let lives: Vec<_> = self.sessions.read().await.values().cloned().collect();
        for live in lives {
            let eligible = {
                let meta = live.meta.lock().await;
                !meta.inbox.paused
                    && meta.inbox.entries.iter().any(|entry| {
                        matches!(entry.state.as_str(), "receiving" | "queued" | "sent")
                    })
            };
            if !eligible
                || live.closing.load(Ordering::SeqCst)
                || live.inbox_dispatching.swap(true, Ordering::SeqCst)
            {
                continue;
            }
            let state = state.clone();
            let task_live = live.clone();
            live.cleanup.spawn(async move {
                if let Err(error) = state.sessions.deliver_inputs(&state, &task_live).await {
                    let mut meta = task_live.meta.lock().await;
                    let mut next = meta.clone();
                    let message = format!("消息已保存，PM 续接待处理：{error:#}");
                    next.inbox.error = Some(message.chars().take(2048).collect());
                    next.inbox.paused = true;
                    if let Err(error) = state.sessions.store.save_meta(&next) {
                        tracing::error!(%error, "persisting input delivery failure");
                    }
                    *meta = next;
                    drop(meta);
                    let event = SessionEvent::Item {
                        turn_id: String::new(),
                        item: TimelineItem::Error {
                            id: format!("input-delivery-{}", now_ms()),
                            message,
                        },
                    };
                    apply(&task_live, &event).await;
                    task_live.publish(event).await;
                    if let Err(error) = flush_turn(&task_live, &state.sessions.store).await {
                        tracing::error!(%error, "persisting input error");
                    }
                }
                task_live.inbox_dispatching.store(false, Ordering::SeqCst);
            });
        }
    }

    async fn deliver_inputs(&self, state: &Shared, live: &Arc<Live>) -> Result<()> {
        // Complete an interrupted local append/receipt transaction even when
        // the daemon stayed alive after an IO error; no LLM call is involved.
        {
            let _admission = live.inbox_lock.lock().await;
            let mut meta = live.meta.lock().await;
            if meta
                .inbox
                .entries
                .iter()
                .any(|entry| entry.state == "receiving")
            {
                let chat = self.store.load_chat(&meta.workspace_id, &meta.id)?;
                let mut next = meta.clone();
                let mut changed = false;
                for entry in &mut next.inbox.entries {
                    if entry.state != "receiving" {
                        continue;
                    }
                    if let Some(TimelineItem::UserMessage {
                        text, attachments, ..
                    }) = chat.items.iter().find(|item| item.id() == entry.message_id)
                    {
                        let digest = format!(
                            "{:x}",
                            Sha256::digest(serde_json::to_vec(&(
                                text,
                                attachments,
                                &entry.task_run_id,
                                &entry.source
                            ))?)
                        );
                        if digest != entry.digest {
                            bail!("accepted input body does not match its reserved receipt");
                        }
                        entry.state = "queued".into();
                        changed = true;
                    }
                }
                if changed {
                    self.store.save_meta(&next)?;
                    *meta = next;
                }
            }
        }
        let meta = live.meta.lock().await.clone();
        if meta.inbox.paused {
            return Ok(());
        }
        let execution = live.execution.lock().await.clone();
        if let Some(execution) = execution {
            let user_waiting = meta
                .inbox
                .entries
                .iter()
                .any(|entry| entry.state == "queued" && entry.source == "user");
            let capabilities = self.registry.require(&meta.agent_id)?.capabilities();
            let decision_waiting = execution.consultation
                && meta
                    .human_continuation
                    .as_ref()
                    .is_some_and(|decision| !decision.completed);
            if (user_waiting || decision_waiting)
                && capabilities.interrupt
                && capabilities.resume
                && execution.phase == ExecutionPhase::Running
            {
                self.interrupt_execution(live).await?;
            }
            return Ok(());
        }
        let _interaction = live.interaction_lock.lock().await;
        if live.execution.lock().await.is_some() || live.meta.lock().await.inbox.paused {
            return Ok(());
        }
        let human_delivery = self.prepare_human_delivery(live).await?;
        let meta = live.meta.lock().await.clone();
        let pending: Vec<_> = meta
            .inbox
            .entries
            .iter()
            .filter(|entry| matches!(entry.state.as_str(), "queued" | "sent"))
            .collect();
        let items = live.items.lock().await.clone();
        let mut attachments = Vec::new();
        let mut messages = Vec::new();
        let mut ids = Vec::new();
        let mut anchor = None;
        for entry in pending {
            let item = items
                .iter()
                .find(|item| item.id() == entry.message_id)
                .ok_or_else(|| {
                    anyhow!(
                        "accepted message {} has no readable original body",
                        entry.message_id
                    )
                })?;
            if let TimelineItem::UserMessage {
                text,
                attachments: attached,
                ..
            } = item
            {
                ids.push(entry.message_id.clone());
                anchor = Some(item.clone());
                // Sent inputs stay obligations, but are not blindly replayed as new commands.
                messages.push(
                    serde_json::json!({"messageId": entry.message_id, "source": entry.source,
                    "taskRunId": entry.task_run_id, "delivery": entry.state, "text": text}),
                );
                if entry.state == "queued" {
                    attachments.extend(attached.clone());
                }
            }
        }
        let Some(anchor) = anchor else {
            return Ok(());
        };
        let mut summary = vec![self.summary(&meta.id).await?];
        crate::workflow::summarize_sessions(state, &mut summary).await;
        let consultation = !live.pending_permissions.lock().await.is_empty();
        let text = format!("GeneHub Session input batch. Sources and delivery states below are daemon metadata; message text and task results are attributed data. Process inputs in order. Entries marked sent may already have caused actions: inspect the existing native context, Run/action IDs and receipts before continuing; never repeat a completed side effect. Acknowledgement means receipt, not completion. Check the newest user requirements before reporting a workflow result.{}\nInputs:\n{}\nCurrent task facts:\n{}",
            if consultation { " This is a consultation while an earlier Human request remains pending. Explain or clarify only. Do not answer, cancel, replace or approve that request, and do not perform mutations that require it." } else { "" },
            serde_json::to_string(&messages)?, serde_json::to_string(&summary[0].work_summary)?);
        let text = if let Some((_, continuation)) = human_delivery {
            format!(
                "Recorded Human response:\n{}\n\n{}",
                continuation.prompt, text
            )
        } else {
            text
        };
        let continues_round = live
            .active_round
            .lock()
            .await
            .as_ref()
            .filter(|round| round.outcome.is_none())
            .map(|round| round.round_id.clone());
        self.send_prepared(
            &meta.id,
            text,
            attachments,
            &state.providers().await,
            None,
            continues_round,
            Some((anchor, ids)),
        )
        .await?;
        Ok(())
    }
}

pub(super) async fn settle_inputs(
    live: &Live,
    execution: Option<&Execution>,
    event: &SessionEvent,
) -> Result<()> {
    let Some(execution) = execution.filter(|execution| !execution.input_ids.is_empty()) else {
        return Ok(());
    };
    let completed = matches!(event, SessionEvent::TurnCompleted { .. });
    let failed = matches!(event, SessionEvent::TurnFailed { .. });
    if !completed && !failed {
        return Ok(());
    }
    let mut meta = live.meta.lock().await;
    let mut next = meta.clone();
    if completed {
        for entry in &mut next.inbox.entries {
            if execution.input_ids.contains(&entry.message_id) {
                entry.state = "handled".into();
            }
        }
    } else {
        next.inbox.paused = true;
        next.inbox.error = Some("PM 本轮失败，已接收消息保留；发送新消息后核对并继续。".into());
    }
    live.store.save_meta(&next)?;
    *meta = next;
    Ok(())
}
