//! Which failed responses the loop recovers from, and how much context the
//! next request carries. Ported from pi `utils/retry.ts`, `utils/overflow.ts`
//! and `agent-session.ts` so a provider error means the same thing here as it
//! does there.

use std::sync::LazyLock;

use regex::Regex;

use crate::protocol::{Message, StopReason};
use crate::provider::estimate_message_tokens;

/// pi `settings.retry` defaults.
pub const DEFAULT_MAX_RETRIES: u32 = 3;
pub const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 2000;
/// A provider-requested delay longer than this is not waited out.
pub const MAX_RETRY_AFTER_MS: u64 = 60_000;
/// Context usage above this share of the window archives before the next
/// request.
pub const ARCHIVE_THRESHOLD_PERCENT: u64 = 80;
/// pi's message after the single compact-and-retry attempt failed.
pub const OVERFLOW_RECOVERY_FAILED: &str = "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

fn pattern(parts: &[&str]) -> Regex {
    Regex::new(&format!("(?i){}", parts.join("|"))).expect("valid pattern")
}

static NON_RETRYABLE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&[
        "GoUsageLimitError",
        "FreeUsageLimitError",
        "Monthly usage limit reached",
        "available balance",
        "insufficient_quota",
        "out of budget",
        "quota exceeded",
        "billing",
    ])
});

static RETRYABLE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&[
        "overloaded",
        "rate.?limit",
        "too many requests",
        "429",
        "500",
        "502",
        "503",
        "504",
        "524",
        "service.?unavailable",
        "server.?error",
        "internal.?error",
        "provider.?returned.?error",
        "network.?error",
        "connection.?error",
        "connection.?refused",
        "connection.?lost",
        "other side closed",
        "fetch failed",
        "getaddrinfo",
        "ENOTFOUND",
        "EAI_AGAIN",
        "upstream.?connect",
        "reset before headers",
        "socket hang up",
        "socket connection was closed",
        "timed? out",
        "timeout",
        "terminated",
        "websocket.?closed",
        "websocket.?error",
        "ended without",
        "stream ended before message_stop",
        "stream ended before a terminal response event",
        "http2 request did not get a response",
        "retry delay",
        "you can retry your request",
        "try your request again",
        "please retry your request",
        "ResourceExhausted",
    ])
});

static OVERFLOW: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"prompt is too long",
        r"request_too_large",
        r"input is too long for requested model",
        r"exceeds the context window",
        r"exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))",
        r"input token count.*exceeds the maximum",
        r"maximum prompt length is \d+",
        r"reduce the length of the messages",
        r"maximum context length is \d+ tokens",
        r"exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?",
        r"input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)",
        r"exceeds the limit of \d+",
        r"exceeds the available context size",
        r"greater than the context length",
        r"context window exceeds limit",
        r"exceeded model token limit",
        r"too large for model with \d+ maximum context length",
        r"prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?",
        r"model_context_window_exceeded",
        r"prompt too long; exceeded (?:max )?context length",
        r"range of input length should be",
        r"context[_ ]length[_ ]exceeded",
        r"too many tokens",
        r"token limit exceeded",
        r"^4(?:00|13)\s*(?:status code)?\s*\(no body\)",
    ]
    .iter()
    .map(|source| Regex::new(&format!("(?i){source}")).expect("valid pattern"))
    .collect()
});

static NON_OVERFLOW: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&[
        r"^(?:Throttling error|Service unavailable):",
        "rate limit",
        "too many requests",
    ])
});

/// pi `isContextOverflow`: an error that names the window, or a "successful"
/// response whose input already filled it (providers that truncate silently).
pub fn is_context_overflow(message: &Message, context_window: Option<u64>) -> bool {
    let Message::Assistant {
        stop_reason,
        error_message,
        usage,
        ..
    } = message
    else {
        return false;
    };
    if *stop_reason == StopReason::Error {
        if let Some(error) = error_message {
            if !NON_OVERFLOW.is_match(error) && OVERFLOW.iter().any(|p| p.is_match(error)) {
                return true;
            }
        }
    }
    let Some(window) = context_window.filter(|window| *window > 0) else {
        return false;
    };
    let input = usage.input + usage.cache_read;
    match stop_reason {
        StopReason::Stop => input > window,
        StopReason::Length => usage.output == 0 && input as f64 >= window as f64 * 0.99,
        _ => false,
    }
}

/// pi `isRetryableAssistantError`, minus overflow (archiving handles it) and
/// authentication failures (retrying a bad key only delays the real fix).
pub fn is_retryable(
    message: &Message,
    http_status: Option<u16>,
    context_window: Option<u64>,
) -> bool {
    let Message::Assistant {
        stop_reason: StopReason::Error,
        error_message: Some(error),
        ..
    } = message
    else {
        return false;
    };
    if matches!(http_status, Some(401 | 403)) || is_context_overflow(message, context_window) {
        return false;
    }
    if NON_RETRYABLE.is_match(error) {
        return false;
    }
    matches!(http_status, Some(408 | 409 | 425 | 429 | 500..=599)) || RETRYABLE.is_match(error)
}

/// pi's backoff, `base · 2^(attempt−1)`, lengthened to a provider's
/// `retry-after` when that is longer.
pub fn retry_delay_ms(base_ms: u64, attempt: u32, retry_after_ms: Option<u64>) -> u64 {
    let backoff = base_ms.saturating_mul(1u64 << attempt.saturating_sub(1).min(20));
    match retry_after_ms {
        Some(requested) => backoff.max(requested.min(MAX_RETRY_AFTER_MS)),
        None => backoff,
    }
}

/// Tokens the next request will carry, following pi `estimateContextTokens`:
/// the last valid response's reported usage plus an estimate for everything
/// appended since. Responses older than `floor` (before the latest archive)
/// describe a context that no longer exists and are ignored; with no usable
/// report the whole context is estimated rather than read as empty, plus
/// `overhead` for what no message accounts for (system prompt, tools).
pub fn context_tokens(messages: &[Message], floor: usize, overhead: u64) -> u64 {
    let floor = floor.min(messages.len());
    let reported = messages
        .iter()
        .enumerate()
        .skip(floor)
        .rev()
        .find_map(|(index, message)| {
            let Message::Assistant {
                usage, stop_reason, ..
            } = message
            else {
                return None;
            };
            if matches!(stop_reason, StopReason::Error | StopReason::Aborted)
                || !usage.token_usage_reported
            {
                return None;
            }
            let total = if usage.total_tokens > 0 {
                usage.total_tokens
            } else {
                usage.input + usage.output + usage.cache_read + usage.cache_write
            };
            (total > 0).then_some((index, total))
        });
    match reported {
        Some((index, total)) => {
            total
                + messages[index + 1..]
                    .iter()
                    .map(estimate_message_tokens)
                    .sum::<u64>()
        }
        None => overhead + messages.iter().map(estimate_message_tokens).sum::<u64>(),
    }
}

pub fn over_threshold(tokens: u64, context_window: Option<u64>) -> bool {
    context_window
        .filter(|window| *window > 0)
        .is_some_and(|window| tokens.saturating_mul(100) > window * ARCHIVE_THRESHOLD_PERCENT)
}

/// Budgets for one archive, scaled to the window so the summary and the kept
/// tail together stay well under the threshold that triggered it.
pub struct ArchiveBudget {
    pub projection_tokens: u64,
    pub tail_tokens: u64,
}

impl ArchiveBudget {
    pub fn for_window(context_window: Option<u64>) -> Self {
        let window = context_window
            .filter(|window| *window > 0)
            .unwrap_or(128_000);
        Self {
            // `genet session context` accepts 2048–64000.
            projection_tokens: (window * 35 / 100).clamp(2048, 24_000),
            tail_tokens: (window * 20 / 100).min(20_000),
        }
    }
}

/// Which messages survive an archive verbatim, as ascending indices into the
/// archived context. Everything else is replaced by the archive summary.
#[derive(Debug, PartialEq, Eq)]
pub struct ArchivePlan {
    pub kept: Vec<usize>,
}

/// A split is only legal where no tool call is waiting for its result:
/// before a user message or an assistant message, with every call before it
/// answered. A `request_user_input` call and the user's answer that follows
/// its placeholder result count as one exchange.
fn legal_cut(messages: &[Message], cut: usize) -> bool {
    if cut == 0 || cut > messages.len() {
        return false;
    }
    if cut < messages.len() && matches!(messages[cut], Message::ToolResult { .. }) {
        return false;
    }
    if cut < messages.len()
        && matches!(messages[cut], Message::User { .. })
        && matches!(
            &messages[cut - 1],
            Message::ToolResult { tool_name, .. } if tool_name == "request_user_input"
        )
    {
        return false;
    }
    true
}

/// Plans an archive that keeps the message at `pinned` (the prompt being
/// served) and whatever it is paired with. Within `tail_tokens` as much recent
/// work as possible stays verbatim. When even that does not fit, finished
/// exchanges of the current run are archived too, newest kept first, but the
/// pinned block always stays. `None` means there is nothing to archive.
pub fn plan_archive(messages: &[Message], pinned: usize, tail_tokens: u64) -> Option<ArchivePlan> {
    let len = messages.len();
    if pinned >= len {
        return None;
    }
    let mut pin_start = pinned;
    while pin_start > 0 && !legal_cut(messages, pin_start) {
        pin_start -= 1;
    }
    let mut cost_from = vec![0u64; len + 1];
    for index in (0..len).rev() {
        cost_from[index] = cost_from[index + 1] + estimate_message_tokens(&messages[index]);
    }
    if let Some(cut) =
        (1..=pin_start).find(|&cut| legal_cut(messages, cut) && cost_from[cut] <= tail_tokens)
    {
        return Some(ArchivePlan {
            kept: (cut..len).collect(),
        });
    }
    let pinned_cost = cost_from[pin_start] - cost_from[pinned + 1];
    let cut = (pinned + 1..=len)
        .find(|&cut| legal_cut(messages, cut) && pinned_cost + cost_from[cut] <= tail_tokens)
        .unwrap_or(len);
    let kept: Vec<usize> = (pin_start..=pinned).chain(cut..len).collect();
    (kept.len() < len).then_some(ArchivePlan { kept })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Content, Usage};
    use serde_json::json;

    fn assistant(stop_reason: StopReason, error: Option<&str>, usage: Usage) -> Message {
        Message::Assistant {
            content: vec![Content::text("x")],
            api: "fake".into(),
            provider: "fake".into(),
            model: "m".into(),
            usage,
            stop_reason,
            error_message: error.map(str::to_string),
            timestamp: 0,
        }
    }

    fn error(text: &str) -> Message {
        assistant(StopReason::Error, Some(text), Usage::default())
    }

    #[test]
    fn overflow_matches_pi_patterns_and_silent_overflow() {
        assert!(is_context_overflow(
            &error("anthropic 400 Bad Request: prompt is too long: 210000 tokens > 200000 maximum"),
            None
        ));
        assert!(is_context_overflow(
            &error("This model's maximum context length is 128000 tokens"),
            None
        ));
        assert!(is_context_overflow(
            &error("400 status code (no body)"),
            None
        ));
        assert!(!is_context_overflow(
            &error("rate limit: too many tokens per minute"),
            None
        ));
        let usage = Usage {
            token_usage_reported: true,
            input: 1200,
            ..Default::default()
        };
        assert!(is_context_overflow(
            &assistant(StopReason::Stop, None, usage.clone()),
            Some(1000)
        ));
        assert!(!is_context_overflow(
            &assistant(StopReason::Stop, None, usage),
            Some(2000)
        ));
    }

    #[test]
    fn retry_follows_pi_and_never_retries_auth_quota_or_overflow() {
        assert!(is_retryable(
            &error("openai 429 Too Many Requests: slow down"),
            Some(429),
            None
        ));
        assert!(is_retryable(
            &error("anthropic 529: overloaded_error"),
            Some(529),
            None
        ));
        assert!(is_retryable(
            &error("error sending request: connection refused"),
            None,
            None
        ));
        assert!(!is_retryable(
            &error("openai 401 Unauthorized: bad key"),
            Some(401),
            None
        ));
        assert!(!is_retryable(
            &error("openai 429: insufficient_quota"),
            Some(429),
            None
        ));
        assert!(!is_retryable(&error("prompt is too long"), Some(400), None));
        assert!(!is_retryable(&error("invalid request"), Some(400), None));
    }

    #[test]
    fn delay_is_exponential_and_honours_a_bounded_retry_after() {
        assert_eq!(retry_delay_ms(2000, 1, None), 2000);
        assert_eq!(retry_delay_ms(2000, 3, None), 8000);
        assert_eq!(retry_delay_ms(2000, 1, Some(5000)), 5000);
        assert_eq!(retry_delay_ms(2000, 1, Some(600_000)), MAX_RETRY_AFTER_MS);
    }

    #[test]
    fn context_tokens_ignore_reports_from_before_the_archive() {
        let reported = Usage {
            token_usage_reported: true,
            total_tokens: 900,
            ..Default::default()
        };
        let messages = vec![
            Message::user("a".repeat(40)),
            assistant(StopReason::Stop, None, reported),
            Message::user("b".repeat(40)),
        ];
        assert_eq!(context_tokens(&messages, 0, 50), 900 + 10);
        // An unreported response falls back to estimating, never to zero.
        assert_eq!(context_tokens(&messages, 2, 50), 50 + 10 + 1 + 10);
        assert!(over_threshold(810, Some(1000)));
        assert!(!over_threshold(800, Some(1000)));
        assert!(!over_threshold(10_000, None));
    }

    fn call(id: &str, name: &str) -> Message {
        Message::Assistant {
            content: vec![Content::ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: json!({}),
            }],
            api: "fake".into(),
            provider: "fake".into(),
            model: "m".into(),
            usage: Usage::default(),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 0,
        }
    }

    fn result(id: &str, name: &str, text: &str) -> Message {
        Message::ToolResult {
            tool_call_id: id.into(),
            tool_name: name.into(),
            content: vec![Content::text(text)],
            details: None,
            is_error: false,
            timestamp: 0,
        }
    }

    #[test]
    fn archive_keeps_the_prompt_and_never_splits_a_call_from_its_result() {
        let big = "x".repeat(4000);
        let messages = vec![
            Message::user("old"),
            call("a", "read"),
            result("a", "read", &big),
            assistant(StopReason::Stop, None, Usage::default()),
            Message::user("current"),
            call("b", "read"),
            result("b", "read", &big),
        ];
        // The current run fits: the newest legal span within budget stays.
        assert_eq!(
            plan_archive(&messages, 4, 1500).unwrap().kept,
            vec![3, 4, 5, 6]
        );
        // It does not: the run's finished exchange is archived as a whole,
        // never splitting the call from its result, and the prompt stays.
        assert_eq!(plan_archive(&messages, 4, 100).unwrap().kept, vec![4]);
        // A lone prompt has nothing to archive.
        assert_eq!(plan_archive(&[Message::user("only")], 0, 10), None);
    }

    #[test]
    fn a_user_input_exchange_stays_with_the_answer() {
        let messages = vec![
            Message::user("old"),
            assistant(StopReason::Stop, None, Usage::default()),
            call("q", "request_user_input"),
            result("q", "request_user_input", "waiting"),
            Message::user("answer"),
        ];
        assert_eq!(
            plan_archive(&messages, 4, 10_000).unwrap().kept,
            vec![1, 2, 3, 4]
        );
        assert_eq!(plan_archive(&messages, 4, 9).unwrap().kept, vec![2, 3, 4]);
        // Over budget, the question and its answer still stay together.
        assert_eq!(plan_archive(&messages, 4, 3).unwrap().kept, vec![2, 3, 4]);
    }
}
