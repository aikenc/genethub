//! Offline provider used to exercise the full loop without an API key.
//!
//! First turn: some text plus an `ls` tool call. After a tool result comes
//! back: a short closing message. That covers every event the daemon renders.

use serde_json::json;
use tokio::sync::mpsc::UnboundedSender;

use super::{ProviderEvent, Request};
use crate::config::ModelConfig;
use crate::protocol::{Message, StopReason, Usage};

pub async fn stream(
    _model: &ModelConfig,
    request: Request,
    events: UnboundedSender<ProviderEvent>,
) -> anyhow::Result<()> {
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

    let mut usage = Usage::default();
    usage.input = 10;
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
        assert!(matches!(events.last(), Some(ProviderEvent::Done(StopReason::ToolUse))));
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
        assert!(matches!(events.last(), Some(ProviderEvent::Done(StopReason::Stop))));
    }
}
