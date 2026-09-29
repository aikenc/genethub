//! Shapes session history into a provider request.
//!
//! Error and aborted assistant turns are not replayed: a tool call they
//! started has no result, and both APIs reject the next request. A kept
//! assistant whose call never received a result gets a synthetic error result
//! so the pair stays intact. The session file is left unchanged.

use std::collections::HashSet;

use crate::protocol::{Content, Message, StopReason};

const MISSING_RESULT: &str = "No result provided for this tool call.";

pub(crate) fn provider_history(messages: &[Message]) -> Vec<Message> {
    let mut skipped = HashSet::new();
    let mut pending: Vec<(String, String)> = Vec::new();
    let mut satisfied = HashSet::new();
    let mut out = Vec::new();

    for message in messages {
        match message {
            Message::Assistant {
                stop_reason: StopReason::Error | StopReason::Aborted,
                ..
            } => {
                flush_pending(&mut out, &pending, &satisfied);
                pending.clear();
                satisfied.clear();
                for (id, _, _) in message.tool_calls() {
                    skipped.insert(id);
                }
            }
            Message::ToolResult { tool_call_id, .. } if skipped.contains(tool_call_id) => {}
            Message::ToolResult { tool_call_id, .. } => {
                if pending.iter().any(|(id, _)| id == tool_call_id) {
                    satisfied.insert(tool_call_id.clone());
                }
                out.push(message.clone());
            }
            other => {
                flush_pending(&mut out, &pending, &satisfied);
                pending.clear();
                satisfied.clear();
                if let Message::Assistant { .. } = other {
                    pending = other
                        .tool_calls()
                        .into_iter()
                        .map(|(id, name, _)| (id, name))
                        .collect();
                }
                out.push(other.clone());
            }
        }
    }
    flush_pending(&mut out, &pending, &satisfied);
    out
}

fn flush_pending(
    out: &mut Vec<Message>,
    pending: &[(String, String)],
    satisfied: &HashSet<String>,
) {
    for (id, name) in pending {
        if satisfied.contains(id) {
            continue;
        }
        out.push(Message::ToolResult {
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            content: vec![Content::text(MISSING_RESULT)],
            details: None,
            is_error: true,
            timestamp: 0,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Content, Usage};
    use serde_json::json;

    fn assistant(stop: StopReason, call: Option<(&str, &str)>) -> Message {
        let mut content = Vec::new();
        if let Some((id, name)) = call {
            content.push(Content::ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: json!({}),
            });
        }
        Message::Assistant {
            content,
            api: "fake".into(),
            provider: "fake".into(),
            model: "m".into(),
            usage: Usage::default(),
            stop_reason: stop,
            error_message: None,
            timestamp: 0,
        }
    }

    fn result(id: &str) -> Message {
        Message::ToolResult {
            tool_call_id: id.into(),
            tool_name: "ls".into(),
            content: vec![Content::text("ok")],
            details: None,
            is_error: false,
            timestamp: 0,
        }
    }

    #[test]
    fn an_error_turn_and_its_result_are_left_out_of_the_next_request() {
        let history = provider_history(&[
            Message::user("go"),
            assistant(StopReason::Error, Some(("call_a", "ls"))),
            result("call_a"),
            Message::user("continue"),
        ]);
        assert_eq!(history.len(), 2);
        assert!(matches!(&history[0], Message::User { content, .. } if content == "go"));
        assert!(matches!(&history[1], Message::User { content, .. } if content == "continue"));
    }

    #[test]
    fn a_kept_call_without_a_result_gets_a_synthetic_error() {
        let history = provider_history(&[assistant(StopReason::ToolUse, Some(("call_b", "read")))]);
        assert_eq!(history.len(), 2);
        match &history[1] {
            Message::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "call_b");
                assert!(is_error);
                assert!(matches!(
                    &content[0],
                    Content::Text { text } if text.contains("No result provided")
                ));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_completed_pair_is_unchanged() {
        let history = provider_history(&[
            assistant(StopReason::ToolUse, Some(("call_c", "ls"))),
            result("call_c"),
        ]);
        assert_eq!(history.len(), 2);
        assert!(matches!(&history[1], Message::ToolResult { is_error, .. } if !is_error));
    }
}
