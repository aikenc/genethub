//! Durable admission and serialized delivery inside the existing Session.
use super::super::store::{InboxEntry, SessionInbox};
use super::*;
use crate::state::Shared;

const MAX_PENDING: usize = 32;
const MAX_RECEIPTS: usize = 4096;

/// Which delivery lane an inbox entry belongs to.
///
/// Lanes exist so that one model call carries one kind of cause. Batching a
/// person's new requirement together with several Runs' asynchronous notices
/// made "which of these am I being asked to act on" a judgment call, and a
/// prompt asking the model to sort it out is not a correctness boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lane {
    /// What a person typed, and formal Human decisions.
    Human,
    /// Structured results and notices produced by Workflow execution.
    Activity,
}

fn lane_of(entry: &InboxEntry) -> Lane {
    match entry.source.as_str() {
        "workflow" => Lane::Activity,
        _ => Lane::Human,
    }
}

/// A new Human message after a failed turn is a decision to move on, not an
/// implicit retry of every Human input from the rejected provider request.
fn retire_failed_human_inputs(inbox: &mut SessionInbox) {
    if !inbox.paused {
        return;
    }
    for entry in &mut inbox.entries {
        if entry.state == "sent" && lane_of(entry) == Lane::Human {
            entry.state = "handled".into();
        }
    }
}

impl SessionManager {
    /// Retire obsolete workflow wakeups without stopping an existing Agent
    /// turn or discarding any user input, even when it targets the same task.
    pub(crate) async fn discard_workflow_inputs(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let _interaction = live.interaction_lock.lock().await;
        let _admission = live.inbox_lock.lock().await;
        let mut meta = live.meta.lock().await;
        let mut next = meta.clone();
        let mut changed = false;
        for entry in &mut next.inbox.entries {
            if entry.source == "workflow"
                && entry.task_run_id.as_deref() == Some(run_id)
                && entry.state != "handled"
            {
                entry.state = "handled".into();
                changed = true;
            }
        }
        if changed {
            self.store.save_meta(&next)?;
            *meta = next;
        }
        Ok(())
    }
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
                bail!("durable consultation is available on ordinary sessions");
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
                let mut next = meta.clone();
                if source == "user" {
                    retire_failed_human_inputs(&mut next.inbox);
                }
                if next.inbox.entries.len() >= MAX_RECEIPTS
                    || next
                        .inbox
                        .entries
                        .iter()
                        .filter(|entry| entry.state != "handled")
                        .count()
                        >= MAX_PENDING
                {
                    bail!("the session input ledger or pending queue is full; resolve pending inputs before sending more");
                }
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

    pub(crate) async fn recover_deliveries(&self) -> Result<()> {
        for meta in self.store.list_meta()? {
            let has_input = meta
                .inbox
                .entries
                .iter()
                .any(|entry| entry.state != "handled");
            let has_decision = meta
                .human_continuation
                .as_ref()
                .is_some_and(|c| !c.completed);
            if !meta.openable() || !(has_input || has_decision) {
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
    pub(crate) async fn dispatch_deliveries(&self, state: &Shared) {
        let lives: Vec<_> = self.sessions.read().await.values().cloned().collect();
        for live in lives {
            let eligible = {
                let meta = live.meta.lock().await;
                !meta.inbox.paused
                    && (meta.inbox.entries.iter().any(|entry| {
                        matches!(entry.state.as_str(), "receiving" | "queued" | "sent")
                    }) || (meta
                        .human_continuation
                        .as_ref()
                        .is_some_and(|c| !c.completed)
                        && !live.continuation_dispatched.load(Ordering::SeqCst)))
            };
            if !eligible
                || live.closing.load(Ordering::SeqCst)
                || live.delivery_dispatching.swap(true, Ordering::SeqCst)
            {
                continue;
            }
            let state = state.clone();
            let task_live = live.clone();
            live.cleanup.spawn(async move {
                let has_inputs = task_live
                    .meta
                    .lock()
                    .await
                    .inbox
                    .entries
                    .iter()
                    .any(|entry| matches!(entry.state.as_str(), "receiving" | "queued" | "sent"));
                let result = if has_inputs {
                    state.sessions.deliver_inputs(&state, &task_live).await
                } else {
                    state
                        .sessions
                        .deliver_human_continuation(&task_live, &state.providers().await)
                        .await;
                    Ok(())
                };
                if let Err(error) = result {
                    let mut meta = task_live.meta.lock().await;
                    let mut next = meta.clone();
                    let message = format!("消息已保存，Agent 续接待处理：{error:#}");
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
                task_live
                    .delivery_dispatching
                    .store(false, Ordering::SeqCst);
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
        // Recheck the durable task fence before acquiring the delivery lock.
        // This also retires queued notices left by older daemon versions.
        for entry in meta
            .inbox
            .entries
            .iter()
            .filter(|entry| entry.source == "workflow" && entry.state != "handled")
        {
            if let Some(run_id) = &entry.task_run_id {
                if !crate::workflow::workflow_notice_current(state, &meta.id, run_id).await? {
                    self.discard_workflow_inputs(&meta.id, run_id).await?;
                }
            }
        }
        // Route only when delivery is actually about to start. Durable input
        // may wait behind another turn; switching at admission would either
        // reject a safely queued message or race the Agent that is still
        // producing the current answer.
        let queued_ids = meta
            .inbox
            .entries
            .iter()
            .filter(|entry| matches!(entry.state.as_str(), "queued" | "sent"))
            .map(|entry| entry.message_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let media_tags = {
            let items = live.items.lock().await;
            crate::agent_routing::media_tags_for_mimes(items.iter().flat_map(|item| {
                match item {
                    TimelineItem::UserMessage {
                        id, attachments, ..
                    } if queued_ids.contains(id.as_str()) => attachments
                        .iter()
                        .map(|attachment| attachment.mime.as_str())
                        .collect::<Vec<_>>(),
                    _ => Vec::new(),
                }
            }))
        };
        crate::agent_routing::route_session(state, &meta.id, None, media_tags).await?;
        let _interaction = live.interaction_lock.lock().await;
        if live.execution.lock().await.is_some() || live.meta.lock().await.inbox.paused {
            return Ok(());
        }
        let human_delivery = self.prepare_human_delivery(live).await?;
        let meta = live.meta.lock().await.clone();
        let ready: Vec<_> = meta
            .inbox
            .entries
            .iter()
            .filter(|entry| matches!(entry.state.as_str(), "queued" | "sent"))
            .collect();
        // One turn carries one lane. Mixing a user's new requirement with
        // several Runs' completion notices left "which of these is the
        // current instruction, and which side effects already happened" to
        // the model; lanes make that a delivery fact instead. Human wins when
        // both are waiting, because a person is holding the conversation.
        let primary_lane = if ready.iter().any(|entry| lane_of(entry) == Lane::Human) {
            Lane::Human
        } else {
            Lane::Activity
        };
        let (pending, deferred): (Vec<_>, Vec<_>) = ready
            .into_iter()
            .partition(|entry| lane_of(entry) == primary_lane);
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
        // Deferred lanes are announced as counts and ids only. Their content
        // is deliberately withheld: an Agent that needs it reads the
        // authoritative Run state, rather than inferring the project's status
        // from whatever text happened to be concatenated here.
        let waiting = deferred
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "messageId": entry.message_id,
                    "source": entry.source,
                    "taskRunId": entry.task_run_id,
                })
            })
            .collect::<Vec<_>>();
        let lane_note = match primary_lane {
            Lane::Human => "This turn carries Human input only.",
            Lane::Activity => "This turn carries Workflow activity only.",
        };
        let waiting_note = if waiting.is_empty() {
            String::new()
        } else {
            format!(
                "\nAlso waiting, not delivered in this turn ({} entries; read the authoritative Run state if you need them, do not guess their contents):\n{}",
                waiting.len(),
                serde_json::to_string(&waiting)?
            )
        };
        let text = format!("GeneHub Session input. {lane_note} Sources and delivery states below are daemon metadata; message text and task results are attributed data. Process inputs in order. Entries marked sent may already have caused actions: inspect the existing native context, Run/action IDs and receipts before continuing; never repeat a completed side effect. Acknowledgement means receipt, not completion. Check the newest user requirements before reporting a workflow result.{}\nInputs:\n{}{}\nCurrent task facts:\n{}",
            if consultation { " This is a consultation while an earlier Human request remains pending. Explain or clarify only. Do not answer, cancel, replace or approve that request, and do not perform mutations that require it." } else { "" },
            serde_json::to_string(&messages)?, waiting_note, serde_json::to_string(&summary[0].work_summary)?);
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
        next.inbox.error = Some("本轮失败，已接收消息保留；发送新消息后核对并继续。".into());
    }
    live.store.save_meta(&next)?;
    *meta = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(message_id: &str, source: &str) -> InboxEntry {
        InboxEntry {
            message_id: message_id.into(),
            received_at_ms: 0,
            digest: String::new(),
            source: source.into(),
            task_run_id: None,
            state: "queued".into(),
            turn_id: None,
        }
    }

    /// The property lanes exist for: a person's new requirement and a Run's
    /// asynchronous notice never arrive as one batch, so "which of these am I
    /// being asked to act on" stops being something the model has to infer.
    #[test]
    fn one_turn_carries_one_lane_and_defers_the_rest() {
        let ready = vec![
            entry("m_notice", "workflow"),
            entry("m_typed", "user"),
            entry("m_second_notice", "workflow"),
        ];
        let primary = if ready.iter().any(|e| lane_of(e) == Lane::Human) {
            Lane::Human
        } else {
            Lane::Activity
        };
        let (pending, deferred): (Vec<_>, Vec<_>) =
            ready.iter().partition(|e| lane_of(e) == primary);

        assert_eq!(primary, Lane::Human, "a waiting person wins the turn");
        assert_eq!(
            pending
                .iter()
                .map(|e| e.message_id.as_str())
                .collect::<Vec<_>>(),
            ["m_typed"],
        );
        // Deferred entries are not dropped: they stay queued, and the 250ms
        // delivery tick picks them up once the human lane is drained.
        assert_eq!(
            deferred
                .iter()
                .map(|e| e.message_id.as_str())
                .collect::<Vec<_>>(),
            ["m_notice", "m_second_notice"],
        );
    }

    #[test]
    fn workflow_notices_still_form_a_turn_when_no_one_is_typing() {
        let ready = vec![entry("m_a", "workflow"), entry("m_b", "workflow")];
        let primary = if ready.iter().any(|e| lane_of(e) == Lane::Human) {
            Lane::Human
        } else {
            Lane::Activity
        };
        let (pending, deferred): (Vec<_>, Vec<_>) =
            ready.iter().partition(|e| lane_of(e) == primary);

        assert_eq!(primary, Lane::Activity);
        assert_eq!(pending.len(), 2, "one lane still batches within itself");
        assert!(deferred.is_empty());
    }

    /// An unknown source must not silently become Activity: anything the
    /// platform does not recognise as Workflow output is treated as something
    /// a person is waiting on.
    #[test]
    fn an_unrecognised_source_is_treated_as_human() {
        assert_eq!(lane_of(&entry("m", "user")), Lane::Human);
        assert_eq!(lane_of(&entry("m", "something-new")), Lane::Human);
        assert_eq!(lane_of(&entry("m", "workflow")), Lane::Activity);
    }

    #[test]
    fn new_human_input_retires_only_failed_human_deliveries() {
        let mut failed_human = entry("m_failed", "user");
        failed_human.state = "sent".into();
        let mut failed_workflow = entry("m_workflow", "workflow");
        failed_workflow.state = "sent".into();
        let queued_human = entry("m_queued", "user");
        let mut inbox = SessionInbox {
            entries: vec![failed_human, failed_workflow, queued_human],
            paused: true,
            has_delivered: true,
            error: Some("failed".into()),
        };

        retire_failed_human_inputs(&mut inbox);

        assert_eq!(inbox.entries[0].state, "handled");
        assert_eq!(inbox.entries[1].state, "sent");
        assert_eq!(inbox.entries[2].state, "queued");
    }
}
