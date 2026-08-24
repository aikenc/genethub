//! Shared token accounting for every adapter.
//!
//! Providers disagree on field names and on whether `input` already includes
//! the cached portion. This module only reads numbers; the UI subtracts cache
//! when it can and keeps tool output as its own column.

use std::collections::HashSet;

use genehub_proto::{ItemDelta, SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, Usage};
use serde_json::Value;
use tokio::sync::broadcast;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Marks the moment one LLM round's request went out. TTFT for that round is
/// measured from here to the first token that comes back. A round's clock is
/// set once: the turn's opening request already started it, so a later call
/// for the same round is a no-op rather than a reset that would erase the
/// model's thinking-before-typing.
pub fn record_round_start(usage: &mut Usage) {
    if usage.round_started_at_ms.is_none() {
        usage.round_started_at_ms = Some(now_ms());
    }
}

/// Records the first token of a round: folds its latency into the running
/// average TTFT and opens the output-rate window. A no-op once the round has
/// already produced a token, so only the leading token counts.
pub fn record_first_token(usage: &mut Usage) {
    let Some(started) = usage.round_started_at_ms else {
        return;
    };
    let now = now_ms();
    let ttft = now.saturating_sub(started).max(0) as u64;
    let rounds = usage.llm_rounds.max(1);
    usage.avg_ttft_ms = Some(match usage.avg_ttft_ms {
        Some(avg) => (avg * (rounds - 1) + ttft) / rounds,
        None => ttft,
    });
    usage.round_started_at_ms = None;
    usage.first_token_at_ms = Some(now);
}

/// Counts visible output text as it streams past. This feeds only the output
/// *rate* for providers that report no token totals; it never becomes a token
/// count on the wire.
pub fn record_visible_output(usage: &mut Usage, text: &str) {
    usage.visible_output_chars = usage
        .visible_output_chars
        .saturating_add(text.chars().count() as u64);
}

/// The output rate in tokens per second, and whether it was estimated from
/// visible text. Reported tokens give an exact rate; otherwise the visible
/// text (chars/4) gives an estimate. `None` when nothing has streamed yet.
fn output_rate(usage: &Usage, elapsed_ms: u64) -> Option<(f64, bool)> {
    let elapsed = elapsed_ms.max(1) as f64 / 1000.0;
    if usage.output_tokens > 0 {
        return Some((usage.output_tokens as f64 / elapsed, false));
    }
    if usage.visible_output_chars > 0 {
        let estimated_tokens = usage.visible_output_chars as f64 / 4.0;
        return Some((estimated_tokens / elapsed, true));
    }
    None
}

/// Closes the output-rate window at end of turn: tokens produced divided by
/// the streaming wall-clock. Reported tokens win; otherwise the visible text
/// yields an estimate the footer marks with `~`.
pub fn finalize_output_rate(usage: &mut Usage) {
    let Some(first) = usage.first_token_at_ms.take() else {
        return;
    };
    let elapsed = now_ms().saturating_sub(first).max(0) as u64;
    if let Some((rate, estimated)) = output_rate(usage, elapsed) {
        usage.avg_output_rate_tps = Some(rate);
        usage.output_rate_estimated = estimated;
    }
}

/// The output rate right now, for the live footer. Returns a clone with the
/// rate filled in, leaving the tracked usage untouched so the final
/// `finalize_output_rate` still measures the whole turn.
pub fn with_live_output_rate(usage: &Usage) -> Usage {
    let mut live = usage.clone();
    if let Some(first) = usage.first_token_at_ms {
        let elapsed = now_ms().saturating_sub(first).max(0) as u64;
        if let Some((rate, estimated)) = output_rate(usage, elapsed) {
            live.avg_output_rate_tps = Some(rate);
            live.output_rate_estimated = estimated;
        }
    }
    live
}

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
        usage: with_live_output_rate(usage),
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
            "cachedReadTokens",
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
            "cachedWriteTokens",
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
    if incoming.avg_ttft_ms.is_some() {
        tracked.avg_ttft_ms = incoming.avg_ttft_ms;
    }
    if incoming.avg_output_rate_tps.is_some() {
        tracked.avg_output_rate_tps = incoming.avg_output_rate_tps;
        tracked.output_rate_estimated = incoming.output_rate_estimated;
    }
    if incoming.visible_output_chars > tracked.visible_output_chars {
        tracked.visible_output_chars = incoming.visible_output_chars;
    }
    if incoming.compaction_count > tracked.compaction_count {
        tracked.compaction_count = incoming.compaction_count;
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
        ToolCallDetail::Unknown { raw } => unknown_tool_output(raw),
    }
}

/// Cursor ACP puts Read/Skill results on `rawOutput.content`, not `output`.
fn unknown_tool_output(raw: &Value) -> String {
    if let Some(text) = raw.get("output").and_then(Value::as_str) {
        if !text.is_empty() {
            return text.to_string();
        }
    }
    if let Some(text) = raw
        .get("rawOutput")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_str)
    {
        if !text.is_empty() {
            return text.to_string();
        }
    }
    if let Some(text) = raw.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            return text.to_string();
        }
    }
    String::new()
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
    // Compactions are timeline facts, not estimates: every marker the agent
    // emitted is one real context squeeze, counted here so the footer can
    // report it regardless of whether the provider also sends token totals.
    usage.compaction_count = items
        .iter()
        .filter(|item| matches!(item, TimelineItem::Compaction { .. }))
        .count() as u64;
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
    keys.iter().find_map(|key| as_u64(value.get(*key)?))
}

fn as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
        .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
        .or_else(|| value.as_str()?.parse().ok())
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

    #[test]
    fn cursor_acp_raw_output_counts_as_tool_out() {
        let items = vec![TimelineItem::ToolCall {
            id: "c1".into(),
            name: "Read".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Unknown {
                raw: json!({"rawOutput": {"content": "abcdefgh"}}),
            },
        }];
        assert_eq!(estimate_item_tool_output(&items), 2);
    }

    #[test]
    fn missing_provider_usage_stays_zero_but_counts_rounds_tools_and_compactions() {
        // Cursor ACP omits PromptResponse.usage entirely (verified against the
        // live CLI). Per the no-estimation rule we do not invent input/output
        // tokens for it; what we can still count exactly is rounds, tool
        // output, and compactions, because those are timeline facts.
        let mut usage = Usage::default();
        fill_usage_from_items(
            &mut usage,
            &[
                TimelineItem::UserMessage {
                    id: "u".into(),
                    text: "abcd".into(),
                    attachments: Vec::new(),
                },
                TimelineItem::AssistantMessage {
                    id: "a".into(),
                    text: "abcdefgh".into(),
                },
                TimelineItem::ToolCall {
                    id: "c1".into(),
                    name: "Read".into(),
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Unknown {
                        raw: json!({"rawOutput": {"content": "abcdefghijkl"}}),
                    },
                },
                TimelineItem::Compaction {
                    id: "k1".into(),
                    reason: "auto".into(),
                },
            ],
        );
        assert_eq!(usage.output_tokens, 0, "no estimation: Cursor never reported");
        assert_eq!(usage.input_tokens, 0, "no estimation: Cursor never reported");
        assert_eq!(usage.tool_output_tokens, 3);
        assert_eq!(usage.llm_rounds, 1);
        assert_eq!(usage.compaction_count, 1);
    }

    #[test]
    fn live_output_rate_uses_reported_tokens_and_first_token_clock() {
        let mut usage = Usage::default();
        usage.output_tokens = 120;
        usage.first_token_at_ms = Some(now_ms() - 2_000);
        let live = with_live_output_rate(&usage);
        let rate = live.avg_output_rate_tps.expect("rate from reported tokens");
        assert!(
            (rate - 60.0).abs() < 5.0,
            "120 tokens over ~2s should be ~60 tok/s, got {rate}"
        );
        assert!(!live.output_rate_estimated, "reported tokens are exact");
        // The tracked usage is left for finalize to close out.
        assert_eq!(usage.avg_output_rate_tps, None);
        assert!(usage.first_token_at_ms.is_some());
    }

    #[test]
    fn live_output_rate_estimates_from_visible_text_when_no_tokens_reported() {
        // Cursor ACP never reports output_tokens; the rate falls back to the
        // visible text (chars/4) and is flagged so the footer shows `~`.
        let mut usage = Usage::default();
        usage.first_token_at_ms = Some(now_ms() - 2_000);
        record_visible_output(&mut usage, &"a".repeat(480)); // 480 chars ≈ 120 tokens
        let live = with_live_output_rate(&usage);
        let rate = live.avg_output_rate_tps.expect("estimated rate");
        assert!(
            (rate - 60.0).abs() < 5.0,
            "480 chars ≈ 120 tokens over ~2s should be ~60 tok/s, got {rate}"
        );
        assert!(live.output_rate_estimated, "estimate must be flagged");
    }

    #[test]
    fn live_output_rate_stays_absent_when_nothing_streamed() {
        let mut usage = Usage::default();
        usage.first_token_at_ms = Some(now_ms() - 2_000);
        let live = with_live_output_rate(&usage);
        assert_eq!(live.avg_output_rate_tps, None);
    }

    #[test]
    fn finalize_prefers_reported_tokens_over_visible_text() {
        let mut usage = Usage::default();
        usage.output_tokens = 200;
        usage.first_token_at_ms = Some(now_ms() - 2_000);
        record_visible_output(&mut usage, & "a".repeat(40)); // would give a lower estimate
        finalize_output_rate(&mut usage);
        let rate = usage.avg_output_rate_tps.expect("rate");
        assert!((rate - 100.0).abs() < 8.0, "reported tokens win, got {rate}");
        assert!(!usage.output_rate_estimated);
        assert!(usage.first_token_at_ms.is_none(), "window closed");
    }
}
