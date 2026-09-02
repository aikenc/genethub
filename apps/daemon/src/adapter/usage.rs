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
/// model's thinking-before-typing. A new round also closes the previous
/// round's generation span, so tool-execution time between rounds never
/// counts toward the output rate.
pub fn record_round_start(usage: &mut Usage) {
    close_output_span(usage);
    if usage.round_started_at_ms.is_none() {
        usage.round_started_at_ms = Some(now_ms());
    }
}

/// Records the first token of a round: folds its latency into the running
/// average TTFT. A no-op once the round has already produced a token, so only
/// the leading token counts.
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
}

/// Counts visible output text as it streams past and tracks the generation
/// clock: the first delta opens a span, every delta extends it. The text
/// feeds only the output *rate* for providers that report no token totals;
/// it never becomes a token count on the wire.
pub fn record_visible_output(usage: &mut Usage, text: &str) {
    let now = now_ms();
    if usage.span_started_at_ms.is_none() {
        usage.span_started_at_ms = Some(now);
    }
    if usage.turn_first_output_at_ms.is_none() {
        usage.turn_first_output_at_ms = Some(now);
    }
    usage.last_output_at_ms = Some(now);
    usage.visible_output_chars = usage
        .visible_output_chars
        .saturating_add(text.chars().count() as u64);
}

/// Folds the open generation span (first token -> last token of the round)
/// into the accumulated active-output clock.
fn close_output_span(usage: &mut Usage) {
    if let (Some(started), Some(last)) = (usage.span_started_at_ms.take(), usage.last_output_at_ms)
    {
        usage.active_output_ms = usage
            .active_output_ms
            .saturating_add(last.saturating_sub(started).max(0) as u64);
    }
}

/// Active generation milliseconds so far: closed spans plus the open one.
fn active_output_now(usage: &Usage) -> u64 {
    let mut active = usage.active_output_ms;
    if let Some(started) = usage.span_started_at_ms {
        active = active.saturating_add(now_ms().saturating_sub(started).max(0) as u64);
    }
    active
}

/// The output rate in tokens per second, and whether it was estimated from
/// visible text. The denominator is the time the model was actually
/// generating — per-round first-token to last-token windows summed across the
/// turn — never TTFT (reported separately) or tool-execution gaps. Reported
/// tokens give an exact rate; otherwise the visible text (chars/4) gives an
/// estimate. `None` when nothing has streamed yet.
fn output_rate(usage: &Usage, active_ms: u64) -> Option<(f64, bool)> {
    // Degenerate turn: every round arrived as one chunk, so no span has a
    // measurable duration. Fall back to the turn's first-output to
    // last-output wall clock rather than dividing by zero.
    let window_ms = if active_ms > 0 {
        active_ms
    } else {
        match (usage.turn_first_output_at_ms, usage.last_output_at_ms) {
            (Some(first), Some(last)) if last > first => (last - first) as u64,
            _ => return None,
        }
    };
    let seconds = window_ms.max(1) as f64 / 1000.0;
    if usage.output_tokens > 0 {
        return Some((usage.output_tokens as f64 / seconds, false));
    }
    if usage.visible_output_chars > 0 {
        let estimated_tokens = usage.visible_output_chars as f64 / 4.0;
        return Some((estimated_tokens / seconds, true));
    }
    None
}

/// Closes the output-rate window at end of turn: tokens produced divided by
/// the active generation clock. Reported tokens win; otherwise the visible
/// text yields an estimate the footer marks with `~`.
pub fn finalize_output_rate(usage: &mut Usage) {
    close_output_span(usage);
    let active = usage.active_output_ms;
    if let Some((rate, estimated)) = output_rate(usage, active) {
        usage.avg_output_rate_tps = Some(rate);
        usage.output_rate_estimated = estimated;
    }
}

/// The output rate right now, for the live footer: closed spans plus the
/// still-open one. Returns a clone with the rate filled in, leaving the
/// tracked usage untouched so the final `finalize_output_rate` still measures
/// the whole turn.
pub fn with_live_output_rate(usage: &Usage) -> Usage {
    let mut live = usage.clone();
    let active = active_output_now(usage);
    if let Some((rate, estimated)) = output_rate(usage, active) {
        live.avg_output_rate_tps = Some(rate);
        live.output_rate_estimated = estimated;
    }
    live
}

/// Carries the internal timing/estimation scratch across a wholesale usage
/// replacement: a provider report that swaps the struct must not lose the
/// streaming clock, or the rate window would restart mid-turn.
pub fn preserve_timing(target: &mut Usage, source: &Usage) {
    target.round_started_at_ms = source.round_started_at_ms;
    target.span_started_at_ms = source.span_started_at_ms;
    target.last_output_at_ms = source.last_output_at_ms;
    target.turn_first_output_at_ms = source.turn_first_output_at_ms;
    target.active_output_ms = source.active_output_ms;
    target.visible_output_chars = source.visible_output_chars;
    target.avg_ttft_ms = source.avg_ttft_ms;
}

/// Roughly chars/4, matching the estimator the frontend uses for the same
/// strings. Exact tokenizer counts are not available on every adapter wire.
pub fn estimate_tokens(text: &str) -> u64 {
    text.chars().count().div_ceil(4) as u64
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
            item:
                TimelineItem::ToolCall {
                    id,
                    status: ToolStatus::Ok | ToolStatus::Error | ToolStatus::Canceled,
                    detail,
                    ..
                },
        } => Some((turn_id.clone(), id.clone(), tool_output_text(detail))),
        SessionEvent::ItemDelta {
            turn_id,
            item_id,
            delta:
                ItemDelta::ToolStatus {
                    status: ToolStatus::Ok | ToolStatus::Error | ToolStatus::Canceled,
                    detail: Some(detail),
                    ..
                },
        } => Some((turn_id.clone(), item_id.clone(), tool_output_text(detail))),
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
            images: vec![],
            started_at_ms: None,
            finished_at_ms: None,
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
                    images: vec![],
                    started_at_ms: None,
                    finished_at_ms: None,
                },
                TimelineItem::Compaction {
                    id: "k1".into(),
                    reason: "auto".into(),
                },
            ],
        );
        assert_eq!(
            usage.output_tokens, 0,
            "no estimation: Cursor never reported"
        );
        assert_eq!(
            usage.input_tokens, 0,
            "no estimation: Cursor never reported"
        );
        assert_eq!(usage.tool_output_tokens, 3);
        assert_eq!(usage.llm_rounds, 1);
        assert_eq!(usage.compaction_count, 1);
    }

    /// Drives a generation span directly on the clock fields so tests do not
    /// depend on wall-clock sleeps: `started_ms_ago` opens the span,
    /// `last_ms_ago` is its most recent output.
    fn stream_span(usage: &mut Usage, started_ms_ago: i64, last_ms_ago: i64, chars: usize) {
        let now = now_ms();
        usage.span_started_at_ms = Some(now - started_ms_ago);
        usage.last_output_at_ms = Some(now - last_ms_ago);
        usage.turn_first_output_at_ms = Some(
            usage
                .turn_first_output_at_ms
                .unwrap_or(now - started_ms_ago),
        );
        usage.visible_output_chars += chars as u64;
    }

    #[test]
    fn live_output_rate_uses_reported_tokens_over_active_generation_time() {
        let mut usage = Usage {
            output_tokens: 120,
            ..Default::default()
        };
        stream_span(&mut usage, 2_000, 100, 480);
        let live = with_live_output_rate(&usage);
        let rate = live.avg_output_rate_tps.expect("rate from reported tokens");
        assert!(
            (rate - 60.0).abs() < 5.0,
            "120 tokens over ~2s of generation should be ~60 tok/s, got {rate}"
        );
        assert!(!live.output_rate_estimated, "reported tokens are exact");
        // The tracked usage is left for finalize to close out.
        assert_eq!(usage.avg_output_rate_tps, None);
        assert!(usage.span_started_at_ms.is_some(), "span still open");
    }

    #[test]
    fn output_rate_divides_by_all_rounds_not_just_the_last_one() {
        // A 3-round turn: each round generated ~2s, with tool-execution gaps
        // between them. The old bug divided the whole turn's tokens by only
        // the last round's window, inflating the rate ~3x.
        let mut usage = Usage {
            output_tokens: 360, // 120 tokens per round
            ..Default::default()
        };
        for _ in 0..2 {
            stream_span(&mut usage, 2_000, 0, 480);
            record_round_start(&mut usage); // closes the span, opens the gap
        }
        stream_span(&mut usage, 2_000, 100, 480); // final round still open
        finalize_output_rate(&mut usage);
        let rate = usage.avg_output_rate_tps.expect("rate");
        assert!(
            (rate - 60.0).abs() < 6.0,
            "360 tokens over 3x~2s of generation should be ~60 tok/s, got {rate}"
        );
        assert!(
            usage.active_output_ms >= 5_000,
            "all three ~2s spans must accumulate, got {}ms",
            usage.active_output_ms
        );
    }

    #[test]
    fn output_rate_excludes_tool_execution_gaps() {
        let mut usage = Usage {
            output_tokens: 120,
            ..Default::default()
        };
        stream_span(&mut usage, 2_000, 0, 480); // round 1: 2s of generation
        record_round_start(&mut usage); // then tools ran for a long while
        stream_span(&mut usage, 60_000, 59_000, 0); // round 2 starts 60s later, 1s of output
        finalize_output_rate(&mut usage);
        let rate = usage.avg_output_rate_tps.expect("rate");
        assert!(
            (rate - 40.0).abs() < 4.0,
            "120 tokens over ~3s of active generation (not 61s wall) should be ~40 tok/s, got {rate}"
        );
    }

    #[test]
    fn live_output_rate_estimates_from_visible_text_when_no_tokens_reported() {
        // Cursor ACP never reports output_tokens; the rate falls back to the
        // visible text (chars/4) and is flagged so the footer shows `~`.
        let mut usage = Usage::default();
        stream_span(&mut usage, 2_000, 100, 480); // 480 chars ≈ 120 tokens
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
        let usage = Usage::default();
        let live = with_live_output_rate(&usage);
        assert_eq!(live.avg_output_rate_tps, None);
    }

    #[test]
    fn single_chunk_turn_falls_back_to_first_last_output_clock() {
        // Every round arrived as one chunk: no span has measurable duration,
        // so the rate uses the turn's first-output to last-output wall clock
        // rather than dividing by zero.
        let now = now_ms();
        let mut usage = Usage {
            output_tokens: 100,
            turn_first_output_at_ms: Some(now - 4_000),
            last_output_at_ms: Some(now),
            ..Default::default()
        };
        finalize_output_rate(&mut usage);
        let rate = usage.avg_output_rate_tps.expect("fallback rate");
        assert!(
            (rate - 25.0).abs() < 3.0,
            "100 tokens over ~4s wall clock should be ~25 tok/s, got {rate}"
        );
    }

    #[test]
    fn finalize_prefers_reported_tokens_over_visible_text() {
        let mut usage = Usage {
            output_tokens: 200,
            ..Default::default()
        };
        stream_span(&mut usage, 2_000, 100, 40); // few chars: would give a lower estimate
        finalize_output_rate(&mut usage);
        let rate = usage.avg_output_rate_tps.expect("rate");
        assert!(
            (rate - 100.0).abs() < 8.0,
            "reported tokens win, got {rate}"
        );
        assert!(!usage.output_rate_estimated);
        assert!(usage.span_started_at_ms.is_none(), "span closed");
    }
}
