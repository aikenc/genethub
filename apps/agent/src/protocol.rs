//! Wire types for the GeneHub agent protocol.
//!
//! Two consumers depend on these shapes: the daemon that drives the agent over
//! stdio, and the session files on disk. See `docs/builtin-agent.md` for the
//! normative description.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "toolCall")]
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
}

impl Content {
    pub fn text(text: impl Into<String>) -> Self {
        Content::Text { text: text.into() }
    }
}

/// Token accounting as persisted on assistant messages.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    pub cost: Cost,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.total_tokens += other.total_tokens;
        self.cost.input += other.cost.input;
        self.cost.output += other.cost.output;
        self.cost.cache_read += other.cost.cache_read;
        self.cost.cache_write += other.cost.cache_write;
        self.cost.total += other.cost.total;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Pending,
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "user")]
    User { content: String, timestamp: i64 },
    #[serde(rename = "assistant", rename_all = "camelCase")]
    Assistant {
        content: Vec<Content>,
        api: String,
        provider: String,
        model: String,
        usage: Usage,
        stop_reason: StopReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        timestamp: i64,
    },
    #[serde(rename = "toolResult", rename_all = "camelCase")]
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: Vec<Content>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        is_error: bool,
        timestamp: i64,
    },
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Message::User {
            content: text.into(),
            timestamp: now_ms(),
        }
    }

    pub fn tool_calls(&self) -> Vec<(String, String, Value)> {
        let Message::Assistant { content, .. } = self else {
            return Vec::new();
        };
        content
            .iter()
            .filter_map(|block| match block {
                Content::ToolCall {
                    id,
                    name,
                    arguments,
                } => Some((id.clone(), name.clone(), arguments.clone())),
                _ => None,
            })
            .collect()
    }
}

/// An in-flight assistant message. Streaming events carry snapshots of this.
#[derive(Debug, Clone)]
pub struct AssistantDraft {
    pub content: Vec<Content>,
    pub api: String,
    pub provider: String,
    pub model: String,
    pub usage: Usage,
    pub stop_reason: StopReason,
    pub error_message: Option<String>,
    pub timestamp: i64,
}

impl AssistantDraft {
    pub fn new(api: &str, provider: &str, model: &str) -> Self {
        AssistantDraft {
            content: Vec::new(),
            api: api.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            usage: Usage::default(),
            stop_reason: StopReason::Pending,
            error_message: None,
            timestamp: now_ms(),
        }
    }

    pub fn to_message(&self) -> Message {
        Message::Assistant {
            content: self.content.clone(),
            api: self.api.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            usage: self.usage.clone(),
            stop_reason: self.stop_reason,
            error_message: self.error_message.clone(),
            timestamp: self.timestamp,
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self.to_message()).unwrap_or(Value::Null)
    }
}

/// A model as exposed over the wire (`PiModel`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl ModelRef {
    /// `provider/id`, the form accepted by `--model`.
    pub fn reference(&self) -> String {
        format!("{}/{}", self.provider, self.id)
    }
}

/// An incoming command. Unknown `type` values still parse, so we can answer
/// with a structured failure instead of hanging the caller's request.
#[derive(Debug, Clone, Deserialize)]
pub struct Command {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub rest: Value,
}

impl Command {
    pub fn str_field(&self, key: &str) -> Option<String> {
        self.rest.get(key)?.as_str().map(|s| s.to_string())
    }

    pub fn bool_field(&self, key: &str) -> Option<bool> {
        self.rest.get(key)?.as_bool()
    }
}

pub fn response(id: Option<&str>, command: &str, data: Option<Value>) -> Value {
    let mut frame = json!({ "type": "response", "command": command, "success": true });
    if let Some(id) = id {
        frame["id"] = json!(id);
    }
    if let Some(data) = data {
        frame["data"] = data;
    }
    frame
}

pub fn error_response(id: Option<&str>, command: &str, error: impl Into<String>) -> Value {
    let mut frame = json!({
        "type": "response",
        "command": command,
        "success": false,
        "error": error.into(),
    });
    if let Some(id) = id {
        frame["id"] = json!(id);
    }
    frame
}

/// `AgentToolResult`: what rides on `tool_execution_end.result`. `details` is
/// omitted rather than nulled when a tool has nothing to report.
pub fn tool_result_value(text: &str, details: Option<&Value>) -> Value {
    let mut value = json!({ "content": [{ "type": "text", "text": text }] });
    if let Some(details) = details {
        value["details"] = details.clone();
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_message_matches_session_format() {
        let draft = AssistantDraft::new("anthropic", "anthropic", "claude-sonnet-4");
        let value = serde_json::to_value(draft.to_message()).unwrap();
        assert_eq!(value["role"], "assistant");
        assert_eq!(value["api"], "anthropic");
        assert_eq!(value["stopReason"], "pending");
        assert_eq!(value["usage"]["totalTokens"], 0);
        assert_eq!(value["usage"]["cost"]["cacheRead"], 0.0);
        assert!(value.get("errorMessage").is_none());
    }

    #[test]
    fn tool_result_message_carries_content_blocks_and_details() {
        let msg = Message::ToolResult {
            tool_call_id: "call_1".into(),
            tool_name: "read".into(),
            content: vec![Content::text("out")],
            details: Some(json!({"truncated": false})),
            is_error: false,
            timestamp: 1,
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["role"], "toolResult");
        assert_eq!(value["toolCallId"], "call_1");
        assert_eq!(value["content"][0]["type"], "text");
        assert_eq!(value["content"][0]["text"], "out");
        assert_eq!(value["details"]["truncated"], false);
        assert_eq!(value["isError"], false);
    }

    #[test]
    fn tool_calls_are_extracted_in_order() {
        let msg = Message::Assistant {
            content: vec![
                Content::text("sure"),
                Content::ToolCall {
                    id: "a".into(),
                    name: "read".into(),
                    arguments: json!({"path": "x"}),
                },
                Content::ToolCall {
                    id: "b".into(),
                    name: "bash".into(),
                    arguments: json!({"command": "ls"}),
                },
            ],
            api: "anthropic".into(),
            provider: "anthropic".into(),
            model: "m".into(),
            usage: Usage::default(),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 0,
        };
        let calls = msg.tool_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].1, "read");
        assert_eq!(calls[1].0, "b");
    }

    #[test]
    fn usage_accumulates_tokens_and_cost() {
        let mut total = Usage::default();
        let mut one = Usage {
            input: 10,
            ..Default::default()
        };
        one.total_tokens = 15;
        one.cost.total = 0.5;
        total.add(&one);
        total.add(&one);
        assert_eq!(total.input, 20);
        assert_eq!(total.total_tokens, 30);
        assert_eq!(total.cost.total, 1.0);
    }

    #[test]
    fn responses_echo_the_request_id() {
        let frame = response(Some("req-9"), "get_state", Some(json!({"a": 1})));
        assert_eq!(frame["id"], "req-9");
        assert_eq!(frame["success"], true);
        let failure = error_response(None, "nope", "boom");
        assert_eq!(failure["success"], false);
        assert_eq!(failure["error"], "boom");
        assert!(failure.get("id").is_none());
    }

    #[test]
    fn command_keeps_unknown_fields_addressable() {
        let cmd: Command =
            serde_json::from_str(r#"{"id":"1","type":"prompt","message":"hello"}"#).unwrap();
        assert_eq!(cmd.kind, "prompt");
        assert_eq!(cmd.str_field("message").as_deref(), Some("hello"));
    }
}
