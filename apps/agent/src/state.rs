//! Shared session state and the read-only payloads the daemon polls for.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::config::ModelConfig;
use crate::protocol::{Message, Usage};
use crate::rpc::Emitter;
use crate::session::Session;
use crate::skills::Skill;

pub struct State {
    pub emitter: Emitter,
    pub session: Session,
    pub models: Vec<ModelConfig>,
    pub current_model: Option<ModelConfig>,
    pub thinking_level: String,
    pub auto_compaction: bool,
    pub skills: Vec<Skill>,
    pub additional_system_prompts: Vec<String>,
    pub cwd: PathBuf,
    pub stats: Usage,
    pub streaming: bool,
    pub abort: Arc<AtomicBool>,
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
            "isCompacting": false,
            "autoCompactionEnabled": self.auto_compaction,
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

    /// `get_session_stats` payload.
    pub fn stats_value(&self) -> Value {
        let mut user_messages = 0;
        let mut assistant_messages = 0;
        let mut tool_calls = 0;
        let mut tool_results = 0;

        for message in &self.session.messages {
            match message {
                Message::User { .. } => user_messages += 1,
                Message::Assistant { content, .. } => {
                    assistant_messages += 1;
                    tool_calls += content
                        .iter()
                        .filter(|block| matches!(block, crate::protocol::Content::ToolCall { .. }))
                        .count();
                }
                Message::ToolResult { .. } => tool_results += 1,
            }
        }

        let mut value = json!({
            "sessionId": self.session.id,
            "userMessages": user_messages,
            "assistantMessages": assistant_messages,
            "toolCalls": tool_calls,
            "toolResults": tool_results,
            "totalMessages": self.session.messages.len(),
            "tokens": {
                "input": self.stats.input,
                "output": self.stats.output,
                "cacheRead": self.stats.cache_read,
                "cacheWrite": self.stats.cache_write,
                "total": self.stats.total_tokens,
            },
            "cost": self.stats.cost.total,
        });
        if let Some(file) = &self.session.file {
            value["sessionFile"] = json!(file.to_string_lossy());
        }
        if let Some(usage) = self.context_usage() {
            value["contextUsage"] = usage;
        }
        value
    }

    /// Omitted entirely when no model or context window is known, which is what
    /// the daemon expects rather than nulls.
    fn context_usage(&self) -> Option<Value> {
        let window = self.current_model.as_ref()?.context_window?;
        if window == 0 {
            return None;
        }
        let tokens = self.stats.input + self.stats.output;
        Some(json!({
            "tokens": tokens,
            "contextWindow": window,
            "percent": ((tokens as f64 / window as f64) * 100.0).round(),
        }))
    }

    /// Skills double as `/skill:<name>` slash commands.
    pub fn commands_value(&self) -> Value {
        let commands: Vec<Value> = self
            .skills
            .iter()
            .map(|skill| {
                json!({
                    "name": format!("skill:{}", skill.name),
                    "description": skill.description,
                    "source": "skill",
                    "sourceInfo": { "path": skill.file_path.to_string_lossy() },
                })
            })
            .collect();
        json!({ "commands": commands })
    }

    pub fn models_value(&self) -> Value {
        let models: Vec<Value> = self
            .models
            .iter()
            .map(|model| serde_json::to_value(model.to_ref()).unwrap_or(Value::Null))
            .collect();
        json!({ "models": models })
    }

    pub fn messages_value(&self) -> Value {
        json!({ "messages": self.session.messages })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Content;
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
            }),
            thinking_level: "medium".into(),
            auto_compaction: true,
            additional_system_prompts: Vec::new(),
            skills: Vec::new(),
            cwd,
            stats: Usage::default(),
            streaming: false,
            abort: Arc::new(AtomicBool::new(false)),
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
    async fn stats_count_messages_by_role() {
        let mut state = state();
        state.session.append_message(Message::user("hi"));
        state.session.append_message(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "a".into(),
                name: "ls".into(),
                arguments: json!({}),
            }],
            api: "fake".into(),
            provider: "fake".into(),
            model: "echo".into(),
            usage: Usage::default(),
            stop_reason: crate::protocol::StopReason::ToolUse,
            error_message: None,
            timestamp: 0,
        });
        state.session.append_message(Message::ToolResult {
            tool_call_id: "a".into(),
            tool_name: "ls".into(),
            content: vec![Content::text("out")],
            details: None,
            is_error: false,
            timestamp: 0,
        });

        let value = state.stats_value();
        assert_eq!(value["userMessages"], 1);
        assert_eq!(value["assistantMessages"], 1);
        assert_eq!(value["toolCalls"], 1);
        assert_eq!(value["toolResults"], 1);
        assert_eq!(value["totalMessages"], 3);
        assert_eq!(value["cost"], 0.0);
    }

    #[tokio::test]
    async fn context_usage_is_omitted_without_a_context_window() {
        let mut state = state();
        state.current_model.as_mut().unwrap().context_window = None;
        assert!(state.state_value().get("contextUsage").is_none());
    }

    #[tokio::test]
    async fn skills_are_exposed_as_slash_commands() {
        let mut state = state();
        state.skills.push(Skill {
            name: "demo".into(),
            description: "Demo skill".into(),
            file_path: PathBuf::from("/skills/demo/SKILL.md"),
            base_dir: PathBuf::from("/skills/demo"),
            disable_model_invocation: false,
        });
        let value = state.commands_value();
        assert_eq!(value["commands"][0]["name"], "skill:demo");
        assert_eq!(value["commands"][0]["source"], "skill");
    }
}
