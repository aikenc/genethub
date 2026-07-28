//! Provider abstraction. Each provider translates our message history into its
//! own wire format and streams back a normalised event sequence.

pub mod anthropic;
pub mod fake;
pub mod openai;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::config::ModelConfig;
use crate::protocol::{Message, StopReason, Usage};

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    TextStart,
    TextDelta(String),
    TextEnd,
    ThinkingStart,
    ThinkingDelta(String),
    ThinkingEnd,
    ToolCallStart { id: String, name: String },
    ToolCallDelta(String),
    ToolCallEnd { id: String, name: String, arguments: Value },
    Usage(Usage),
    Done(StopReason),
}

pub struct Request {
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub tools: Vec<Value>,
    pub thinking_level: String,
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

/// Named levels map to Anthropic-style token budgets.
pub fn thinking_budget(level: &str) -> Option<u32> {
    match level {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(4096),
        "high" => Some(8192),
        "xhigh" => Some(16384),
        "max" => Some(32768),
        _ => None,
    }
}

/// OpenAI exposes coarse effort buckets instead of a token budget.
pub fn reasoning_effort(level: &str) -> Option<&'static str> {
    match level {
        "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" | "max" => Some("high"),
        _ => None,
    }
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
    fn thinking_levels_map_to_budgets() {
        assert_eq!(thinking_budget("off"), None);
        assert_eq!(thinking_budget("medium"), Some(4096));
        assert_eq!(thinking_budget("max"), Some(32768));
        assert_eq!(reasoning_effort("xhigh"), Some("high"));
        assert_eq!(reasoning_effort("off"), None);
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
