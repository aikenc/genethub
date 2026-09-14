//! Only admitted adapter output and changing usage/tool facts count as work.
use super::super::store::ExecutionActivity;
use super::*;

impl SessionManager {
    pub(crate) async fn execution_activity(&self, session_id: &str) -> Result<ExecutionActivity> {
        Ok(self
            .live(session_id)
            .await?
            .meta
            .lock()
            .await
            .activity
            .clone())
    }
    pub(crate) async fn input_handled(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Option<bool>> {
        let live = self.live(session_id).await?;
        let meta = live.meta.lock().await;
        Ok(meta
            .inbox
            .entries
            .iter()
            .find(|entry| entry.message_id == message_id)
            .map(|entry| entry.state == "handled"))
    }
}

pub(super) async fn observe(live: &Live, event: &SessionEvent) {
    let items = live.items.lock().await;
    let mut work = match event {
        SessionEvent::ItemDelta {
            delta: ItemDelta::Text { delta },
            ..
        } => !delta.is_empty(),
        SessionEvent::ItemDelta {
            item_id,
            delta:
                ItemDelta::ToolStatus {
                    status,
                    detail,
                    images,
                },
            ..
        } => match items.iter().find(|item| item.id() == item_id) {
            Some(TimelineItem::ToolCall {
                status: previous,
                detail: previous_detail,
                images: previous_images,
                ..
            }) => {
                previous != status
                    || detail
                        .as_ref()
                        .is_some_and(|detail| detail != previous_detail)
                    || (!images.is_empty() && images != previous_images)
            }
            _ => true,
        },
        SessionEvent::Item {
            item:
                TimelineItem::ToolCall {
                    id,
                    name,
                    status,
                    detail,
                    images,
                    ..
                },
            ..
        } => match items.iter().find(|item| item.id() == id) {
            Some(TimelineItem::ToolCall {
                name: previous_name,
                status: previous_status,
                detail: previous_detail,
                images: previous_images,
                ..
            }) => {
                name != previous_name
                    || status != previous_status
                    || detail != previous_detail
                    || (!images.is_empty() && images != previous_images)
            }
            _ => true,
        },
        SessionEvent::Item {
            item:
                TimelineItem::AssistantMessage { id, text, .. }
                | TimelineItem::Reasoning { id, text, .. },
            ..
        } => {
            !text.is_empty()
                && match items.iter().find(|item| item.id() == id) {
                    Some(
                        TimelineItem::AssistantMessage { text: previous, .. }
                        | TimelineItem::Reasoning { text: previous, .. },
                    ) => previous != text,
                    _ => true,
                }
        }
        _ => false,
    };
    drop(items);
    let mut meta = live.meta.lock().await;
    let activity = &mut meta.activity;
    let before = activity.clone();
    let usage = match event {
        SessionEvent::TurnProgress { turn_id, usage }
        | SessionEvent::TurnCompleted { turn_id, usage, .. } => Some((turn_id, usage)),
        _ => None,
    };
    if let Some((turn_id, usage)) = usage {
        if activity.turn_id.as_deref() != Some(turn_id) {
            activity.turn_id = Some(turn_id.clone());
            activity.turn_rounds = 0;
            activity.turn_tokens = 0;
        }
        let tokens = usage.input_tokens.saturating_add(usage.output_tokens);
        let calls = usage.llm_rounds.saturating_sub(activity.turn_rounds);
        let delta = tokens.saturating_sub(activity.turn_tokens);
        activity.llm_rounds = activity.llm_rounds.saturating_add(calls);
        if tokens > 0 {
            activity.tokens = Some(activity.tokens.unwrap_or(0).saturating_add(delta));
        }
        activity.turn_rounds = activity.turn_rounds.max(usage.llm_rounds);
        activity.turn_tokens = activity.turn_tokens.max(tokens);
        work |= calls > 0 || delta > 0;
    }
    if work {
        activity.last_at_ms = now_ms();
    }
    // Streamed text updates memory; the existing checkpoint persists at most
    // once a second. Counters and terminal boundaries always reach disk.
    if before.llm_rounds != activity.llm_rounds
        || matches!(
            event,
            SessionEvent::TurnCompleted { .. }
                | SessionEvent::TurnFailed { .. }
                | SessionEvent::TurnCanceled { .. }
        )
    {
        if let Err(error) = live.store.save_meta(&meta) {
            tracing::error!(%error, "persisting execution activity");
        }
    }
}
