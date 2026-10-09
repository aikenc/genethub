//! History clean-up before a provider sees it — pi's `transformMessages`.
//!
//! Session history outlives the model that wrote it: the user switches model or
//! provider, a run is aborted halfway, an old file is reopened. Each provider
//! rejects some of what that leaves behind, so every request goes through here:
//!
//! - thinking keeps its signature only when replayed to the same
//!   provider/api/model; anywhere else it becomes plain text, and redacted
//!   blocks (opaque to every other model) are dropped;
//! - tool call ids are normalised for a different model, and their results
//!   follow the new id;
//! - assistant turns that ended in error or abort are skipped — they are
//!   incomplete and may carry half a tool call;
//! - a tool call with no result gets a synthetic error result, and a result
//!   whose call is gone is dropped, so call/result pairs always match.

use std::collections::{HashMap, HashSet};

use crate::config::ModelConfig;
use crate::protocol::{Content, Message, StopReason};

pub const NO_RESULT_TEXT: &str = "No result provided";

pub fn transform_messages(
    messages: &[Message],
    model: &ModelConfig,
    normalize_id: fn(&str) -> String,
) -> Vec<Message> {
    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut first_pass = Vec::with_capacity(messages.len());

    for message in messages {
        match message {
            Message::Assistant {
                content,
                api,
                provider,
                model: model_id,
                stop_reason,
                ..
            } => {
                // pi skips these in its second pass; doing it first means no id
                // from a discarded turn can leak into the map.
                if matches!(stop_reason, StopReason::Error | StopReason::Aborted) {
                    continue;
                }
                let same_model =
                    provider == &model.provider && api == model.api() && model_id == &model.id;
                let content = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Thinking {
                            thinking,
                            signature,
                            redacted,
                        } => {
                            if *redacted {
                                return same_model.then(|| block.clone());
                            }
                            let signed = signature.as_deref().is_some_and(|s| !s.is_empty());
                            if same_model && signed {
                                return Some(block.clone());
                            }
                            if thinking.trim().is_empty() {
                                return None;
                            }
                            if same_model {
                                return Some(block.clone());
                            }
                            Some(Content::text(thinking.clone()))
                        }
                        Content::ToolCall {
                            id,
                            name,
                            arguments,
                        } if !same_model => {
                            let normalized = normalize_id(id);
                            if &normalized != id {
                                id_map.insert(id.clone(), normalized.clone());
                            }
                            Some(Content::ToolCall {
                                id: normalized,
                                name: name.clone(),
                                arguments: arguments.clone(),
                            })
                        }
                        other => Some(other.clone()),
                    })
                    .collect();
                let mut message = message.clone();
                if let Message::Assistant { content: slot, .. } = &mut message {
                    *slot = content;
                }
                first_pass.push(message);
            }
            Message::ToolResult { tool_call_id, .. } => {
                let mut message = message.clone();
                if let (
                    Some(mapped),
                    Message::ToolResult {
                        tool_call_id: slot, ..
                    },
                ) = (id_map.get(tool_call_id), &mut message)
                {
                    *slot = mapped.clone();
                }
                first_pass.push(message);
            }
            Message::User { .. } => first_pass.push(message.clone()),
        }
    }

    pair_tool_results(first_pass)
}

/// Every tool call is answered before the next user or assistant turn, and no
/// result is left without its call.
fn pair_tool_results(messages: Vec<Message>) -> Vec<Message> {
    let mut out = Vec::with_capacity(messages.len());
    let mut pending: Vec<(String, String)> = Vec::new();
    let mut answered: HashSet<String> = HashSet::new();

    let flush = |out: &mut Vec<Message>,
                 pending: &mut Vec<(String, String)>,
                 answered: &mut HashSet<String>| {
        for (id, name) in pending.drain(..) {
            if !answered.contains(&id) {
                out.push(Message::ToolResult {
                    tool_call_id: id,
                    tool_name: name,
                    content: vec![Content::text(NO_RESULT_TEXT)],
                    details: None,
                    is_error: true,
                    timestamp: crate::protocol::now_ms(),
                });
            }
        }
        answered.clear();
    };

    for message in messages {
        match &message {
            Message::ToolResult { tool_call_id, .. } => {
                let known = pending.iter().any(|(id, _)| id == tool_call_id);
                if known && answered.insert(tool_call_id.clone()) {
                    out.push(message);
                }
            }
            Message::Assistant { .. } => {
                flush(&mut out, &mut pending, &mut answered);
                pending = message
                    .tool_calls()
                    .into_iter()
                    .map(|(id, name, _)| (id, name))
                    .collect();
                out.push(message);
            }
            Message::User { .. } => {
                flush(&mut out, &mut pending, &mut answered);
                out.push(message);
            }
        }
    }
    flush(&mut out, &mut pending, &mut answered);
    out
}

/// Anthropic: `^[a-zA-Z0-9_-]+$`, at most 64 characters.
pub fn normalize_anthropic_id(id: &str) -> String {
    sanitize(id, 64)
}

/// OpenAI Chat Completions, as pi does it: a Responses-style `call|item` id is
/// sanitised into one id of at most 40 characters (a short hash keeps long
/// ones distinct); anything else only has to fit the 40-character limit.
pub fn normalize_openai_id(id: &str) -> String {
    const MAX: usize = 40;
    if let Some((call, item)) = id.split_once('|') {
        let call = sanitize_all(call);
        let item = sanitize_all(item);
        let combined = if item.is_empty() {
            call.clone()
        } else {
            format!("{call}_{item}")
        };
        if combined.len() <= MAX {
            return combined;
        }
        let hash = format!("{:08x}", fnv1a(id) as u32);
        let prefix: String = call.chars().take((MAX - hash.len() - 1).max(1)).collect();
        return format!("{prefix}_{hash}");
    }
    id.chars().take(MAX).collect()
}

fn sanitize_all(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    })
}

fn sanitize(id: &str, max: usize) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(max)
        .collect();
    if cleaned.is_empty() {
        "call".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Usage;
    use serde_json::json;

    fn model(provider: &str, id: &str) -> ModelConfig {
        ModelConfig {
            provider: provider.into(),
            id: id.into(),
            api: Some("anthropic".into()),
            ..ModelConfig::default()
        }
    }

    fn assistant(model: &str, content: Vec<Content>, stop: StopReason) -> Message {
        Message::Assistant {
            content,
            api: "anthropic".into(),
            provider: "p".into(),
            model: model.into(),
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

    fn signed(text: &str) -> Content {
        Content::Thinking {
            thinking: text.into(),
            signature: Some("sig".into()),
            redacted: false,
        }
    }

    fn redacted() -> Content {
        Content::Thinking {
            thinking: "[Reasoning redacted]".into(),
            signature: Some("opaque".into()),
            redacted: true,
        }
    }

    fn content_of(message: &Message) -> &[Content] {
        match message {
            Message::Assistant { content, .. } => content,
            _ => panic!("not assistant"),
        }
    }

    #[test]
    fn the_same_model_gets_its_signed_and_redacted_thinking_back() {
        let history = vec![
            Message::user("go"),
            assistant(
                "m",
                vec![signed("plan"), redacted(), Content::text("hi")],
                StopReason::Stop,
            ),
        ];
        let out = transform_messages(&history, &model("p", "m"), normalize_anthropic_id);
        let content = content_of(&out[1]);
        assert!(matches!(&content[0], Content::Thinking { signature: Some(s), .. } if s == "sig"));
        assert!(matches!(
            &content[1],
            Content::Thinking { redacted: true, .. }
        ));
    }

    #[test]
    fn another_model_sees_thinking_as_text_and_no_redacted_blocks() {
        let history = vec![
            Message::user("go"),
            assistant(
                "old",
                vec![signed("plan"), redacted(), Content::thinking("  ")],
                StopReason::Stop,
            ),
        ];
        let out = transform_messages(&history, &model("p", "new"), normalize_anthropic_id);
        let content = content_of(&out[1]);
        assert_eq!(content.len(), 1);
        assert!(matches!(&content[0], Content::Text { text } if text == "plan"));
    }

    #[test]
    fn tool_ids_are_normalised_across_models_and_results_follow() {
        let call = Content::ToolCall {
            id: "call|abc+/=".into(),
            name: "ls".into(),
            arguments: json!({}),
        };
        let history = vec![
            Message::user("go"),
            assistant("old", vec![call], StopReason::ToolUse),
            result("call|abc+/="),
        ];
        let out = transform_messages(&history, &model("p", "new"), normalize_anthropic_id);
        let Content::ToolCall { id, .. } = &content_of(&out[1])[0] else {
            panic!()
        };
        assert_eq!(id, "call_abc___");
        assert!(matches!(&out[2], Message::ToolResult { tool_call_id, .. } if tool_call_id == id));
    }

    #[test]
    fn orphaned_calls_get_a_synthetic_error_and_stray_results_go() {
        let call = |id: &str| Content::ToolCall {
            id: id.into(),
            name: "ls".into(),
            arguments: json!({}),
        };
        let history = vec![
            Message::user("go"),
            assistant("m", vec![call("a"), call("b")], StopReason::ToolUse),
            result("a"),
            result("zombie"),
            Message::user("next"),
        ];
        let out = transform_messages(&history, &model("p", "m"), normalize_anthropic_id);
        assert_eq!(out.len(), 5);
        assert!(
            matches!(&out[2], Message::ToolResult { tool_call_id, is_error: false, .. } if tool_call_id == "a")
        );
        let Message::ToolResult {
            tool_call_id,
            is_error,
            content,
            ..
        } = &out[3]
        else {
            panic!()
        };
        assert_eq!(tool_call_id, "b");
        assert!(*is_error);
        assert!(matches!(&content[0], Content::Text { text } if text == NO_RESULT_TEXT));
        assert!(matches!(&out[4], Message::User { .. }));
    }

    #[test]
    fn failed_and_aborted_turns_are_skipped() {
        let half = Content::ToolCall {
            id: "x".into(),
            name: "bash".into(),
            arguments: json!({}),
        };
        let history = vec![
            Message::user("go"),
            assistant("m", vec![half], StopReason::Aborted),
            assistant("m", vec![Content::text("boom")], StopReason::Error),
            Message::user("again"),
        ];
        let out = transform_messages(&history, &model("p", "m"), normalize_anthropic_id);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn openai_ids_fit_forty_characters() {
        let long = format!("call_{}|{}", "a".repeat(30), "b+".repeat(200));
        let id = normalize_openai_id(&long);
        assert!(id.len() <= 40);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        assert_ne!(id, normalize_openai_id(&format!("{long}x")));
        assert_eq!(normalize_openai_id("call_1|fc_2"), "call_1_fc_2");
        assert_eq!(normalize_openai_id("toolu_01abc"), "toolu_01abc");
        assert_eq!(normalize_anthropic_id(&"x".repeat(80)).len(), 64);
    }
}
