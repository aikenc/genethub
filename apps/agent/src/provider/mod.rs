//! Provider abstraction. Each provider translates our message history into its
//! own wire format and streams back a normalised event sequence.

pub mod anthropic;
pub mod fake;
// Shared with `tools::media`, which registers agent-requested attachments and
// must enforce the same confinement and size rules before the loop injects
// them into the conversation.
pub(crate) mod media;
pub mod openai;
pub mod transform;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::config::ModelConfig;
use crate::protocol::{Content, Message, StopReason, Usage};

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    TextStart,
    TextDelta(String),
    TextEnd,
    ThinkingStart,
    ThinkingDelta(String),
    /// Appended to the signature of the current thinking block.
    ThinkingSignature(String),
    /// A whole redacted thinking block; the payload is opaque and must be
    /// replayed byte for byte.
    RedactedThinking(String),
    ThinkingEnd,
    ToolCallStart {
        id: String,
        name: String,
    },
    ToolCallDelta(String),
    ToolCallEnd {
        id: String,
        name: String,
        arguments: Value,
    },
    Usage(Usage),
    Done(StopReason),
}

pub struct Request {
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub tools: Vec<Value>,
    pub thinking_level: String,
    pub cwd: std::path::PathBuf,
}

pub async fn stream(
    model: &ModelConfig,
    request: Request,
    events: UnboundedSender<ProviderEvent>,
) -> anyhow::Result<()> {
    match model.api() {
        "anthropic" => anthropic::stream(model, request, events).await,
        "openai" => openai::stream(model, request, events).await,
        crate::config::FAKE_PROVIDER => fake::stream(model, request, events).await,
        other => anyhow::bail!("unsupported provider api: {other}"),
    }
}

/// A provider answered with a non-success status. Kept structured so the agent
/// loop can tell a retryable 429/5xx from a 401, and honour `retry-after`.
#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: u16,
    pub retry_after_ms: Option<u64>,
    pub message: String,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}

/// Reads a failed response into an [`HttpError`]. The message keeps the
/// `"{provider} {status}: {detail}"` shape the daemon already classifies.
pub async fn http_error(provider: &str, response: genet_http::Response) -> HttpError {
    let status = response.status();
    let headers = response.headers();
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let retry_after_ms = header("retry-after-ms")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .map(|ms| ms.max(0.0) as u64)
        .or_else(|| {
            header("retry-after")
                .and_then(|value| value.trim().parse::<f64>().ok())
                .map(|seconds| (seconds.max(0.0) * 1000.0) as u64)
        });
    let detail = response.text().await.unwrap_or_default();
    HttpError {
        status: status.as_u16(),
        retry_after_ms,
        message: format!("{provider} {status}: {detail}"),
    }
}

/// pi's default budgets (`simple-options.ts`). `xhigh`/`max` have no budget
/// of their own and use `high`'s, exactly as pi's `clampReasoning` does.
pub fn thinking_budget(level: &str) -> Option<u64> {
    match level {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(8192),
        "high" | "xhigh" | "max" => Some(16384),
        _ => None,
    }
}

/// Room left for visible output once the thinking budget is taken.
pub const MIN_OUTPUT_TOKENS: u64 = 1024;
/// Margin kept free below the context window when sizing `max_tokens`.
pub const CONTEXT_SAFETY_TOKENS: u64 = 4096;
/// `max_tokens` for an Anthropic-dialect model whose limit nobody reported.
/// The field is mandatory there; the budget is clamped under it anyway.
pub const DEFAULT_ANTHROPIC_MAX_TOKENS: u64 = 8192;

/// pi `adjustMaxTokensForThinking`: with no explicit caller cap the model cap
/// is the request cap, and the budget always leaves [`MIN_OUTPUT_TOKENS`].
pub fn adjust_max_tokens_for_thinking(model_max_tokens: u64, level: &str) -> (u64, u64) {
    let mut budget = thinking_budget(level).unwrap_or(0);
    let max_tokens = model_max_tokens;
    if max_tokens <= budget {
        budget = max_tokens.saturating_sub(MIN_OUTPUT_TOKENS);
    }
    (max_tokens, budget)
}

/// pi `clampMaxTokensToContext`: never ask for more output than the window
/// can still hold after this request's input.
pub fn clamp_max_tokens_to_context(
    context_window: Option<u64>,
    request: &Request,
    max_tokens: u64,
) -> u64 {
    let Some(window) = context_window.filter(|window| *window > 0) else {
        return max_tokens.max(1);
    };
    let available = window
        .saturating_sub(estimate_request_tokens(request))
        .saturating_sub(CONTEXT_SAFETY_TOKENS);
    max_tokens.min(available.max(1))
}

const CHARS_PER_TOKEN: usize = 4;
const ESTIMATED_IMAGE_CHARS: usize = 4800;

/// pi `estimate.ts`: four characters per token, a flat size per image.
pub fn estimate_message_tokens(message: &Message) -> u64 {
    let chars = match message {
        Message::User {
            content,
            attachments,
            ..
        } => content.chars().count() + attachments.len() * ESTIMATED_IMAGE_CHARS,
        Message::Assistant { content, .. } | Message::ToolResult { content, .. } => content
            .iter()
            .map(|block| match block {
                Content::Text { text } => text.chars().count(),
                Content::Thinking { thinking, .. } => thinking.chars().count(),
                Content::ToolCall {
                    name, arguments, ..
                } => name.len() + arguments.to_string().len(),
            })
            .sum(),
    };
    chars.div_ceil(CHARS_PER_TOKEN) as u64
}

pub fn estimate_request_tokens(request: &Request) -> u64 {
    let fixed = request.system_prompt.chars().count()
        + request
            .tools
            .iter()
            .map(|tool| tool.to_string().len())
            .sum::<usize>();
    fixed.div_ceil(CHARS_PER_TOKEN) as u64
        + request
            .messages
            .iter()
            .map(estimate_message_tokens)
            .sum::<u64>()
}

const EFFORT_LADDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// The effort value to send for `level`, or `None` when thinking is off.
///
/// With nothing declared this is pi's default map (`minimal`/`low` → `low`,
/// everything above `medium` → `high`). When the model declares its efforts
/// (Anthropic `capabilities.effort`, Kimi `valid_efforts`, OpenRouter
/// `supported_efforts`), the level lands on the highest declared value that
/// does not exceed it, so `xhigh`/`max` reach the wire only where accepted.
pub fn select_effort(level: &str, declared: &[String]) -> Option<String> {
    let wanted = match level {
        "minimal" | "low" => 0,
        "medium" => 1,
        "high" => 2,
        "xhigh" => 3,
        "max" => 4,
        _ => return None,
    };
    let declared: Vec<usize> = declared
        .iter()
        .filter_map(|value| EFFORT_LADDER.iter().position(|step| step == value))
        .collect();
    if declared.is_empty() {
        return Some(EFFORT_LADDER[wanted.min(2)].to_string());
    }
    let chosen = declared
        .iter()
        .copied()
        .filter(|rank| *rank <= wanted)
        .max()
        .or_else(|| declared.iter().copied().min())?;
    Some(EFFORT_LADDER[chosen].to_string())
}

/// Server-sent events arrive in arbitrary chunks; this reassembles `data:`
/// payloads across chunk boundaries.
pub struct SseBuffer {
    buffer: String,
}

impl SseBuffer {
    pub fn new() -> Self {
        SseBuffer {
            buffer: String::new(),
        }
    }

    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut payloads = Vec::new();

        while let Some(index) = self.buffer.find('\n') {
            let line = self.buffer[..index].trim_end_matches('\r').to_string();
            self.buffer.drain(..=index);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            payloads.push(data.to_string());
        }

        payloads
    }
}

impl Default for SseBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_levels_map_to_pi_budgets() {
        assert_eq!(thinking_budget("off"), None);
        assert_eq!(thinking_budget("minimal"), Some(1024));
        assert_eq!(thinking_budget("medium"), Some(8192));
        assert_eq!(thinking_budget("high"), Some(16384));
        assert_eq!(thinking_budget("max"), Some(16384));
    }

    /// Ported from pi's `adjustMaxTokensForThinking` cases: the budget always
    /// stays strictly below `max_tokens`, which Anthropic requires.
    #[test]
    fn the_budget_always_leaves_room_for_output() {
        assert_eq!(
            adjust_max_tokens_for_thinking(64_000, "high"),
            (64_000, 16384)
        );
        assert_eq!(adjust_max_tokens_for_thinking(8192, "high"), (8192, 7168));
        assert_eq!(adjust_max_tokens_for_thinking(8192, "medium"), (8192, 7168));
        assert_eq!(adjust_max_tokens_for_thinking(1024, "minimal"), (1024, 0));
        for level in ["minimal", "low", "medium", "high", "xhigh", "max"] {
            for cap in [1024, 4096, 8192, 16384, 32000] {
                let (max, budget) = adjust_max_tokens_for_thinking(cap, level);
                assert!(budget < max, "{level} {cap}");
            }
        }
    }

    #[test]
    fn max_tokens_are_clamped_to_what_the_window_still_holds() {
        let request = Request {
            system_prompt: "x".repeat(40_000),
            messages: vec![],
            tools: vec![],
            thinking_level: "off".into(),
            cwd: ".".into(),
        };
        // 10k tokens of input + 4096 margin in a 20k window leaves 5904.
        assert_eq!(
            clamp_max_tokens_to_context(Some(20_000), &request, 8192),
            5904
        );
        assert_eq!(clamp_max_tokens_to_context(None, &request, 8192), 8192);
        assert_eq!(clamp_max_tokens_to_context(Some(1000), &request, 8192), 1);
    }

    #[test]
    fn efforts_follow_pi_by_default_and_the_declared_set_when_known() {
        assert_eq!(select_effort("off", &[]), None);
        assert_eq!(select_effort("minimal", &[]).as_deref(), Some("low"));
        assert_eq!(select_effort("medium", &[]).as_deref(), Some("medium"));
        assert_eq!(select_effort("max", &[]).as_deref(), Some("high"));
        let all: Vec<String> = ["low", "medium", "high", "xhigh", "max"]
            .map(String::from)
            .to_vec();
        assert_eq!(select_effort("xhigh", &all).as_deref(), Some("xhigh"));
        assert_eq!(select_effort("max", &all).as_deref(), Some("max"));
        let kimi: Vec<String> = ["high"].map(String::from).to_vec();
        assert_eq!(select_effort("low", &kimi).as_deref(), Some("high"));
        let no_xhigh: Vec<String> = ["low", "medium", "high", "max"].map(String::from).to_vec();
        assert_eq!(select_effort("xhigh", &no_xhigh).as_deref(), Some("high"));
    }

    #[test]
    fn sse_payloads_survive_split_chunks() {
        let mut buffer = SseBuffer::new();
        assert!(buffer.push("data: {\"a\":").is_empty());
        let payloads = buffer.push("1}\n\n");
        assert_eq!(payloads, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn sse_skips_comments_and_done_sentinel() {
        let mut buffer = SseBuffer::new();
        let payloads = buffer.push(": ping\nevent: message\ndata: [DONE]\ndata: {\"b\":2}\n");
        assert_eq!(payloads, vec!["{\"b\":2}".to_string()]);
    }
}
