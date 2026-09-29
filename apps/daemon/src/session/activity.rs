//! Only admitted adapter output and changing usage/tool facts count as work.
use super::super::store::ExecutionActivity;
use super::*;

impl SessionManager {
    pub(crate) async fn set_execution_rate(
        &self,
        session_id: &str,
        rate: serde_json::Value,
    ) -> Result<()> {
        let live = self.live(session_id).await?;
        let mut meta = live.meta.lock().await;
        // A resumed assignment retains its rate. A different model closes
        // the old segment before future calls use the replacement's rate.
        let changed = meta.activity.cost_rate.as_ref().is_some_and(|old| {
            old["agentId"] != rate["agentId"] || old["modelId"] != rate["modelId"]
        });
        if changed {
            let previous = meta.activity.cost_rate.clone().expect("existing rate");
            let closed_calls: u64 = meta.activity.cost_segments.iter().map(|s| s.calls).sum();
            let closed_cost: u64 = meta
                .activity
                .cost_segments
                .iter()
                .map(|s| s.milli_cny)
                .sum();
            let segment = super::super::store::ExecutionCostSegment {
                rate: previous,
                calls: meta.activity.priced_llm_rounds.saturating_sub(closed_calls),
                milli_cny: meta
                    .activity
                    .estimated_milli_cny
                    .saturating_sub(closed_cost),
            };
            meta.activity.cost_segments.push(segment);
        }
        if meta.activity.cost_rate.is_none() || changed {
            meta.activity.cost_rate = Some(rate);
            live.store.save_meta(&meta)?;
        }
        Ok(())
    }
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
        if let Some(entry) = meta
            .inbox
            .entries
            .iter()
            .find(|entry| entry.message_id == message_id)
        {
            return Ok(Some(entry.state == "handled"));
        }
        drop(meta);
        // Receipt eviction only removes handled entries; their original
        // remains durable so Workflow notices can finish their own receipt.
        let retained_original =
            live.items.lock().await.iter().any(
                |item| matches!(item, TimelineItem::UserMessage { id, .. } if id == message_id),
            );
        Ok(retained_original.then_some(true))
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
        if let Some(rate) = activity
            .cost_rate
            .as_ref()
            .and_then(|r| r["unitMilliCny"].as_u64())
        {
            activity.estimated_milli_cny = activity
                .estimated_milli_cny
                .saturating_add(calls.saturating_mul(rate));
            activity.priced_llm_rounds = activity.priced_llm_rounds.saturating_add(calls);
        }
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
