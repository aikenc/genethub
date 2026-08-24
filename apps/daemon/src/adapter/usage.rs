//! Shared token accounting for every adapter.
//!
//! Providers disagree on field names and on whether `input` already includes
//! the cached portion. This module only reads numbers; the UI subtracts cache
//! when it can and keeps tool output as its own column.

use std::collections::HashSet;

use genehub_proto::{ItemDelta, SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, Usage};
use serde_json::Value;
use tokio::sync::broadcast;

/// Roughly chars/4, matching the estimator the frontend uses for the same
/// strings. Exact tokenizer counts are not available on every adapter wire.
pub fn estimate_tokens(text: &str) -> u64 {
    ((text.chars().count() + 3) / 4) as u64
}

pub fn emit_progress(events: &broadcast::Sender<SessionEvent>, turn_id: &str, usage: &Usage) {
    if turn_id.is_empty() {
        return;
    }
    let _ = events.send(SessionEvent::TurnProgress {
        turn_id: turn_id.to_string(),
        usage: usage.clone(),
    });
}

pub fn parse_usage(value: &Value) -> Usage {
    let mut usage = Usage::default();
    add_usage(&mut usage, value);
    usage
}

pub fn add_usage(total: &mut Usage, value: &Value) {
    if value.is_null() {
        return;
    }
    let tokens = value.get("tokens").unwrap_or(&Value::Null);
    let details = value
        .get("prompt_tokens_details")
        .or_else(|| value.get("promptTokensDetails"))
        .or_else(|| value.get("input_tokens_details"))
        .unwrap_or(&Value::Null);
    let cache = tokens
        .get("cache")
        .or_else(|| value.get("cache"))
        .cloned()
        .unwrap_or(Value::Null);

    if let Some(input) = first_u64(
        value,
        &[
            "input",
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
        ],
    )
    .or_else(|| first_u64(tokens, &["input", "input_tokens", "inputTokens"]))
    {
        total.input_tokens += input;
    }
    if let Some(output) = first_u64(
        value,
        &[
            "output",
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
        ],
    )
    .or_else(|| first_u64(tokens, &["output", "output_tokens", "outputTokens"]))
    {
        total.output_tokens += output;
    }
    if let Some(cached) = first_u64(
        value,
        &[
            "cacheRead",
            "cache_read",
            "cache_read_tokens",
            "cacheReadTokens",
            "cache_read_input_tokens",
            "cachedInputTokens",
            "cached_tokens",
            "prompt_cache_hit_tokens",
        ],
    )
    .or_else(|| first_u64(details, &["cached_tokens", "cachedTokens"]))
    .or_else(|| first_u64(&cache, &["read", "cached", "hit"]))
    {
        total.cache_read_tokens += cached;
    }
    if let Some(written) = first_u64(
        value,
        &[
            "cacheWrite",
            "cache_write",
            "cache_write_tokens",
            "cacheWriteTokens",
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
        ],
    )
    .or_else(|| first_u64(&cache, &["write", "creation"]))
    {
        total.cache_write_tokens += written;
    }
    if let Some(rounds) = first_u64(value, &["llm_rounds", "llmRounds", "rounds"]) {
        total.llm_rounds += rounds;
    }
    if let Some(tool_out) = first_u64(
        value,
        &["tool_output_tokens", "toolOutputTokens", "tool_output"],
    ) {
        total.tool_output_tokens += tool_out;
    }
    if let Some(cost) = first_f64(value, &["total_cost_usd", "costUsd", "cost_usd"]).or_else(|| {
        value
            .get("cost")
            .and_then(|cost| first_f64(cost, &["total", "usd"]).or_else(|| cost.as_f64()))
    }) {
        total.cost_usd = Some(total.cost_usd.unwrap_or(0.0) + cost);
    }
}

/// Prefer the incoming running totals; keep a field the incoming side left at
/// zero so a later daemon estimate is not wiped.
pub fn merge_progress(tracked: &mut Usage, incoming: &Usage) {
    if incoming.input_tokens > 0 {
        tracked.input_tokens = incoming.input_tokens;
    }
    if incoming.output_tokens > 0 {
        tracked.output_tokens = incoming.output_tokens;
    }
    if incoming.cache_read_tokens > 0 {
        tracked.cache_read_tokens = incoming.cache_read_tokens;
    }
    if incoming.cache_write_tokens > 0 {
        tracked.cache_write_tokens = incoming.cache_write_tokens;
    }
    if incoming.llm_rounds > tracked.llm_rounds {
        tracked.llm_rounds = incoming.llm_rounds;
    }
    if incoming.tool_output_tokens > tracked.tool_output_tokens {
        tracked.tool_output_tokens = incoming.tool_output_tokens;
    }
    if incoming.cost_usd.is_some() {
        tracked.cost_usd = incoming.cost_usd;
    }
}

pub fn tool_output_text(detail: &ToolCallDetail) -> String {
    match detail {
        ToolCallDetail::Overview { output, .. } | ToolCallDetail::Shell { output, .. } => {
            output.clone()
        }
        ToolCallDetail::Read { content, .. } => content.clone(),
        ToolCallDetail::Edit { diff, .. } => diff.clone(),
        ToolCallDetail::Write { .. } => String::new(),
        ToolCallDetail::Search { matches, .. } => matches
            .iter()
            .map(|entry| {
                if entry.preview.is_empty() {
                    entry.path.clone()
                } else {
                    format!("{}:{}", entry.path, entry.preview)
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        ToolCallDetail::Fetch { summary, .. } => summary.clone(),
        ToolCallDetail::Plan { markdown } => markdown.clone(),
        ToolCallDetail::SubAgent { items, .. } => items
            .iter()
            .map(item_tool_output)
            .collect::<Vec<_>>()
            .join("\n"),
        ToolCallDetail::Unknown { raw } => raw
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

pub fn item_tool_output(item: &TimelineItem) -> String {
    match item {
        TimelineItem::ToolCall { detail, .. } => tool_output_text(detail),
        _ => String::new(),
    }
}

pub fn estimate_item_tool_output(items: &[TimelineItem]) -> u64 {
    items
        .iter()
        .map(|item| estimate_tokens(&item_tool_output(item)))
        .sum()
}

pub fn inferred_llm_rounds(items: &[TimelineItem]) -> u64 {
    let assistants = items
        .iter()
        .filter(|item| matches!(item, TimelineItem::AssistantMessage { .. }))
        .count() as u64;
    if assistants > 0 {
        return assistants;
    }
    if items.iter().any(|item| {
        matches!(
            item,
            TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
        )
    }) {
        return 1;
    }
    0
}

pub fn fill_usage_from_items(usage: &mut Usage, items: &[TimelineItem]) {
    if usage.tool_output_tokens == 0 {
        usage.tool_output_tokens = estimate_item_tool_output(items);
    }
    if usage.llm_rounds == 0 {
        usage.llm_rounds = inferred_llm_rounds(items);
    }
}

/// Tool results that have just settled on the original (pre-overview) event.
pub fn completed_tool_output(event: &SessionEvent) -> Option<(String, String, String)> {
    match event {
        SessionEvent::Item {
            turn_id,
            item: TimelineItem::ToolCall {
                id, status, detail, ..
            },
        } if matches!(
            status,
            ToolStatus::Ok | ToolStatus::Error | ToolStatus::Canceled
        ) =>
        {
            Some((turn_id.clone(), id.clone(), tool_output_text(detail)))
        }
        SessionEvent::ItemDelta {
            turn_id,
            item_id,
            delta:
                ItemDelta::ToolStatus {
                    status,
                    detail: Some(detail),
                },
        } if matches!(
            status,
            ToolStatus::Ok | ToolStatus::Error | ToolStatus::Canceled
        ) =>
        {
            Some((turn_id.clone(), item_id.clone(), tool_output_text(detail)))
        }
        _ => None,
    }
}

pub fn record_tool_output(
    event: &SessionEvent,
    live_usage: &mut std::collections::HashMap<String, Usage>,
    counted: &mut HashSet<String>,
) -> Option<SessionEvent> {
    let (turn_id, tool_id, text) = completed_tool_output(event)?;
    if text.is_empty() || !counted.insert(tool_id) {
        return None;
    }
    let usage = live_usage.entry(turn_id.clone()).or_default();
    usage.tool_output_tokens += estimate_tokens(&text);
    Some(SessionEvent::TurnProgress {
        turn_id,
        usage: usage.clone(),
    })
}

fn first_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn first_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_and_anthropic_and_agent_field_names_all_count() {
        let mut usage = Usage::default();
        add_usage(
            &mut usage,
            &json!({"prompt_tokens": 10, "completion_tokens": 4, "prompt_tokens_details": {"cached_tokens": 6}}),
        );
        add_usage(
            &mut usage,
            &json!({"input_tokens": 3, "output_tokens": 2, "cache_read_input_tokens": 1}),
        );
        add_usage(
            &mut usage,
            &json!({"input": 5, "output": 1, "cacheRead": 2, "cost": {"total": 0.25}}),
        );
        assert_eq!(usage.input_tokens, 18);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.cache_read_tokens, 9);
        assert_eq!(usage.cost_usd, Some(0.25));
    }

    #[test]
    fn estimate_is_chars_over_four() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }
}
