//! Offline provider used to exercise the full loop without an API key.
//!
//! The default script sends some text plus an `ls` tool call, then a short
//! closing message after a tool result. Tests can register a script of rounds
//! for one model id; each call consumes the next round.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde_json::json;
use tokio::sync::mpsc::UnboundedSender;

use super::{ProviderEvent, Request};
use crate::config::ModelConfig;
use crate::protocol::{Message, StopReason, Usage};

#[derive(Clone, Debug)]
pub struct Round {
    pub thinking: bool,
    pub text: Option<String>,
}

fn scripts() -> std::sync::MutexGuard<'static, HashMap<String, VecDeque<Round>>> {
    static SCRIPTS: std::sync::OnceLock<Mutex<HashMap<String, VecDeque<Round>>>> =
        std::sync::OnceLock::new();
    SCRIPTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("fake script lock")
}

pub fn register_rounds(model_id: &str, rounds: Vec<Round>) {
    scripts().insert(model_id.to_string(), VecDeque::from(rounds));
}

fn take_round(model_id: &str) -> Option<Round> {
    scripts().get_mut(model_id).and_then(VecDeque::pop_front)
}

pub async fn stream(
    model: &ModelConfig,
    request: Request,
    events: UnboundedSender<ProviderEvent>,
) -> anyhow::Result<()> {
    if let Some(round) = take_round(&model.id) {
        if round.thinking {
            let _ = events.send(ProviderEvent::ThinkingStart);
            let _ = events.send(ProviderEvent::ThinkingDelta("checking".into()));
            let _ = events.send(ProviderEvent::ThinkingEnd);
        }
        if let Some(text) = round.text {
            let _ = events.send(ProviderEvent::TextStart);
            let _ = events.send(ProviderEvent::TextDelta(text));
            let _ = events.send(ProviderEvent::TextEnd);
        }
        let _ = events.send(ProviderEvent::Done(StopReason::Stop));
        return Ok(());
    }
    let already_used_tools = request
        .messages
        .iter()
        .any(|message| matches!(message, Message::ToolResult { .. }));

    let _ = events.send(ProviderEvent::TextStart);
    if already_used_tools {
        for word in ["Done", " — ", "listed the directory."] {
            let _ = events.send(ProviderEvent::TextDelta(word.into()));
        }
    } else {
        for word in ["Let me", " look at", " the workspace."] {
            let _ = events.send(ProviderEvent::TextDelta(word.into()));
        }
    }
    let _ = events.send(ProviderEvent::TextEnd);

    let stop_reason = if already_used_tools {
        StopReason::Stop
    } else {
        let id = format!("call_{}", uuid::Uuid::new_v4().simple());
        let _ = events.send(ProviderEvent::ToolCallStart {
            id: id.clone(),
            name: "ls".into(),
        });
        let _ = events.send(ProviderEvent::ToolCallDelta("{}".into()));
        let _ = events.send(ProviderEvent::ToolCallEnd {
            id,
            name: "ls".into(),
            arguments: json!({}),
        });
        StopReason::ToolUse
    };

    let mut usage = Usage {
        input: 10,
        ..Default::default()
    };
    usage.output = 5;
    usage.total_tokens = 15;
    let _ = events.send(ProviderEvent::Usage(usage));
    let _ = events.send(ProviderEvent::Done(stop_reason));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Content;

    fn model() -> ModelConfig {
        ModelConfig {
            provider: "fake".into(),
            id: "echo".into(),
            name: None,
            api: Some("fake".into()),
            base_url: None,
            api_key: None,
            api_key_env: None,
            context_window: None,
            max_tokens: None,
            reasoning: None,
            input_modalities: Vec::new(),
        }
    }

    async fn collect(messages: Vec<Message>) -> Vec<ProviderEvent> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        stream(
            &model(),
            Request {
                system_prompt: "sys".into(),
                messages,
                tools: vec![],
                thinking_level: "off".into(),
                cwd: ".".into(),
            },
            tx,
        )
        .await
        .unwrap();
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn first_turn_requests_a_tool_call() {
        let events = collect(vec![Message::user("hello")]).await;
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ToolCallEnd { name, .. } if name == "ls")));
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Done(StopReason::ToolUse))
        ));
    }

    #[tokio::test]
    async fn second_turn_finishes_without_tools() {
        let events = collect(vec![
            Message::user("hello"),
            Message::ToolResult {
                tool_call_id: "a".into(),
                tool_name: "ls".into(),
                content: vec![Content::text("src/")],
                details: None,
                is_error: false,
                timestamp: 0,
            },
        ])
        .await;
        assert!(!events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ToolCallEnd { .. })));
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Done(StopReason::Stop))
        ));
    }
}
