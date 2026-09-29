//! Shared session state and the read-only payloads the daemon polls for.

#[cfg(test)]
use crate::protocol::Usage;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::config::ModelConfig;
use crate::protocol::Message;
use crate::rpc::Emitter;
use crate::session::Session;
use crate::skills::Skill;

/// A level-triggered cancellation signal. Unlike polling an atomic flag, a
/// waiter subscribed through `cancelled` wakes even when its underlying I/O is
/// otherwise completely idle.
pub struct Abort {
    changed: tokio::sync::watch::Sender<bool>,
}

impl Abort {
    pub fn new() -> Self {
        let (changed, _) = tokio::sync::watch::channel(false);
        Self { changed }
    }

    pub fn reset(&self) {
        self.changed.send_replace(false);
    }

    pub fn request(&self) -> bool {
        self.changed.send_replace(true)
    }

    pub fn requested(&self) -> bool {
        *self.changed.borrow()
    }

    pub fn poll(&self) -> impl Fn() -> bool + Send + 'static {
        let changed = self.changed.subscribe();
        move || *changed.borrow()
    }

    pub async fn cancelled(&self) {
        let mut changed = self.changed.subscribe();
        let _ = changed.wait_for(|requested| *requested).await;
    }
}

pub struct State {
    pub emitter: Emitter,
    pub session: Session,
    pub models: Vec<ModelConfig>,
    pub current_model: Option<ModelConfig>,
    pub thinking_level: String,
    pub genehub_session_id: Option<String>,
    pub skills: Vec<Skill>,
    pub additional_system_prompts: Vec<String>,
    pub cwd: PathBuf,
    pub streaming: bool,
    pub compacting: bool,
    pub tools_enabled: bool,
    pub abort: Arc<Abort>,
    /// The prompt currently being served, so shutdown can wait for it.
    pub running: Option<tokio::task::JoinHandle<()>>,
}

impl State {
    pub fn model_value(&self) -> Value {
        match &self.current_model {
            Some(model) => serde_json::to_value(model.to_ref()).unwrap_or(Value::Null),
            None => Value::Null,
        }
    }

    /// `PiSessionState`.
    pub fn state_value(&self) -> Value {
        let mut value = json!({
            "model": self.model_value(),
            "thinkingLevel": self.thinking_level,
            "isStreaming": self.streaming,
            "isCompacting": self.compacting,
            "sessionId": self.session.id,
            "messageCount": self.session.messages.len(),
            "pendingMessageCount": 0,
        });
        if let Some(file) = &self.session.file {
            value["sessionFile"] = json!(file.to_string_lossy());
        }
        if let Some(name) = self.session.name() {
            value["sessionName"] = json!(name);
        }
        if let Some(usage) = self.context_usage() {
            value["contextUsage"] = usage;
        }
        value
    }

    /// Reuse a completed request from the actual current history, as PI does.
    /// The boundary excludes retained pre-capsule usage and prior model settings.
    fn last_usage(&self) -> Option<(usize, u64)> {
        let selected = self.current_model.as_ref()?;
        self.session
            .messages
            .iter()
            .enumerate()
            .rev()
            .take_while(|(index, _)| *index >= self.session.usage_start)
            .find_map(|(index, message)| match message {
                Message::Assistant {
                    usage,
                    stop_reason,
                    provider,
                    model,
                    ..
                } if provider == &selected.provider
                    && model == &selected.id
                    && matches!(
                        stop_reason,
                        crate::protocol::StopReason::Stop
                            | crate::protocol::StopReason::Length
                            | crate::protocol::StopReason::ToolUse
                    )
                    && usage.input_reported
                    && usage.output_reported =>
                {
                    // GeneHub input already includes cache. PI stores uncached input
                    // and sums the components; both representations give this total.
                    let total = usage.input.saturating_add(usage.output);
                    (total > 0).then_some((index, total))
                }
                _ => None,
            })
    }

    fn context_usage(&self) -> Option<Value> {
        let window = self.current_model.as_ref()?.context_window?;
        if window == 0 {
            return None;
        }
        let last = self.last_usage();
        let start = last.map_or(0, |(index, _)| index + 1);
        let trailing = &self.session.messages[start..];
        // PI has no generic video/audio tokenizer. Do not turn a made-up reserve
        // into an apparently measured context size. API usage will resolve it.
        let unsupported_media = trailing.iter().any(|message| matches!(message,
            Message::User { attachments, .. } if attachments.iter().any(|a| !a.mime.starts_with("image/"))));
        let unknown = unsupported_media || (last.is_none() && self.session.usage_start > 0);
        let usage_tokens = last.map(|(_, tokens)| tokens);
        let trailing_tokens = (!unknown).then(|| estimate_message_tokens(trailing));
        let tokens = trailing_tokens.map(|tail| usage_tokens.unwrap_or(0).saturating_add(tail));
        let estimated = !unknown && (last.is_none() || !trailing.is_empty());
        Some(json!({
            "tokens": tokens,
            "usageTokens": usage_tokens,
            "estimatedTokens": trailing_tokens,
            "estimated": estimated,
            "source": if unknown { "unknown" } else if last.is_none() { "estimate" }
                else if estimated { "apiBaselineWithEstimate" } else { "api" },
            "contextWindow": window,
            "percent": tokens.map(|tokens| (tokens as f64 / window as f64 * 100.0).round()),
        }))
    }

    /// Estimate for local capsule sizing. UI provenance is handled separately:
    /// a capsule invalidates old API usage until a subsequent response reports it.
    pub(crate) fn context_tokens(&self) -> u64 {
        match self.last_usage() {
            Some((index, tokens)) => {
                tokens.saturating_add(estimate_message_tokens(&self.session.messages[index + 1..]))
            }
            None => estimate_message_tokens(&self.session.messages),
        }
    }

    pub(crate) fn awaiting_context_usage(&self) -> bool {
        self.session.usage_start > 0 && self.last_usage().is_none()
    }
}

/// PI's fallback: UTF-16 text length / 4, rounded per message; 1200 tokens
/// per image. Count content, not wire wrappers, signatures, IDs or base64.
/// This heuristic is not a tokenizer or a guaranteed upper bound.
pub(crate) fn estimate_message_tokens(messages: &[Message]) -> u64 {
    fn chars(text: &str) -> u64 {
        text.encode_utf16().count() as u64
    }
    fn content_chars(content: &[crate::protocol::Content]) -> u64 {
        content.iter().fold(0u64, |total, block| {
            total.saturating_add(match block {
                crate::protocol::Content::Text { text } => chars(text),
                crate::protocol::Content::Thinking { thinking, .. } => chars(thinking),
                crate::protocol::Content::ToolCall {
                    name, arguments, ..
                } => chars(name).saturating_add(chars(&arguments.to_string())),
            })
        })
    }
    messages.iter().fold(0u64, |total, message| {
        let count = match message {
            Message::User {
                content,
                attachments,
                ..
            } => chars(content).saturating_add(
                (attachments
                    .iter()
                    .filter(|a| a.mime.starts_with("image/"))
                    .count() as u64)
                    .saturating_mul(4800),
            ),
            Message::Assistant { content, .. } | Message::ToolResult { content, .. } => {
                content_chars(content)
            }
        };
        total.saturating_add(count.div_ceil(4))
    })
}

pub(crate) fn exceeds_capsule_threshold(used: u64, window: u64) -> bool {
    window > 0 && used >= window.saturating_mul(4) / 5
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::start_writer;

    fn state() -> State {
        let cwd = PathBuf::from("/tmp");
        State {
            emitter: start_writer(),
            session: Session::in_memory(cwd.clone()),
            models: Vec::new(),
            current_model: Some(ModelConfig {
                provider: "fake".into(),
                id: "echo".into(),
                name: None,
                api: Some("fake".into()),
                base_url: None,
                api_key: None,
                api_key_env: None,
                context_window: Some(1000),
                max_tokens: None,
                reasoning: None,
                input_modalities: Vec::new(),
            }),
            thinking_level: "medium".into(),
            genehub_session_id: None,
            additional_system_prompts: Vec::new(),
            skills: Vec::new(),
            cwd,
            streaming: false,
            compacting: false,
            tools_enabled: true,
            abort: Arc::new(Abort::new()),
            running: None,
        }
    }

    #[tokio::test]
    async fn state_payload_has_the_fields_the_daemon_reads() {
        let state = state();
        let value = state.state_value();
        assert_eq!(value["thinkingLevel"], "medium");
        assert_eq!(value["isStreaming"], false);
        assert_eq!(value["messageCount"], 0);
        assert_eq!(value["model"]["provider"], "fake");
        // In-memory sessions have no file, and the field must be absent.
        assert!(value.get("sessionFile").is_none());
    }

    #[tokio::test]
    async fn abort_wakes_a_waiter_and_reset_clears_the_level() {
        let abort = Arc::new(Abort::new());
        let waiting = {
            let abort = abort.clone();
            tokio::spawn(async move { abort.cancelled().await })
        };
        tokio::task::yield_now().await;
        assert!(!abort.request());
        tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
            .await
            .expect("the cancellation wakes an idle waiter")
            .unwrap();
        assert!(abort.requested());
        abort.reset();
        assert!(!abort.requested());
    }

    #[tokio::test]
    async fn context_usage_follows_the_latest_request_not_the_session_total() {
        let mut state = state();
        state.session.append_message(Message::user("hello"));
        let mut reply = crate::protocol::AssistantDraft::new("fake", "fake", "echo");
        reply.stop_reason = crate::protocol::StopReason::Stop;
        reply.usage = Usage {
            input: 100,
            output: 20,
            input_reported: true,
            output_reported: true,
            ..Usage::default()
        };
        state.session.append_message(reply.to_message());
        let usage = state.state_value()["contextUsage"].clone();
        assert_eq!(usage["tokens"], 120);
        assert_eq!(usage["source"], "api");
        assert_eq!(usage["estimatedTokens"], 0);
        state.session.append_message(Message::user("12345678"));
        let usage = state.state_value()["contextUsage"].clone();
        assert_eq!(usage["tokens"], 122);
        assert_eq!(usage["usageTokens"], 120);
        assert_eq!(usage["estimatedTokens"], 2);
        // Missing/all-zero reports cannot erase the valid request baseline.
        reply.usage = Usage::default();
        state.session.append_message(reply.to_message());
        assert_eq!(state.state_value()["contextUsage"]["usageTokens"], 120);
        state
            .session
            .replace_with_capsule("summary".into(), Vec::new());
        let usage = state.state_value()["contextUsage"].clone();
        assert!(usage["tokens"].is_null());
        assert!(usage["percent"].is_null());
        assert_eq!(usage["source"], "unknown");
    }

    #[tokio::test]
    async fn context_usage_is_omitted_without_a_context_window() {
        let mut state = state();
        state.current_model.as_mut().unwrap().context_window = None;
        assert!(state.state_value().get("contextUsage").is_none());
    }

    #[test]
    fn media_estimates_do_not_count_base64_bytes_as_text() {
        use crate::protocol::MediaAttachment;
        let image = |data: &str| {
            Message::user_with_attachments(
                "查看图片",
                vec![MediaAttachment {
                    name: "image.png".into(),
                    mime: "image/png".into(),
                    path: None,
                    data_base64: Some(data.into()),
                }],
            )
        };
        assert_eq!(
            estimate_message_tokens(&[image("tiny")]),
            estimate_message_tokens(&[image(&"x".repeat(100000))])
        );
    }
}
