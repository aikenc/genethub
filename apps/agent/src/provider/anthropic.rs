//! Anthropic Messages API (streaming).

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use super::{thinking_budget, ProviderEvent, Request, SseBuffer};
use crate::config::ModelConfig;
use crate::protocol::{Content, Message, StopReason, Usage};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";

/// Which content block the stream is currently inside, so `content_block_stop`
/// closes the right one.
enum Block {
    None,
    Text,
    Thinking,
    ToolCall,
}

pub async fn stream(
    model: &ModelConfig,
    request: Request,
    events: UnboundedSender<ProviderEvent>,
) -> anyhow::Result<()> {
    let key = model
        .resolved_key()
        .ok_or_else(|| anyhow::anyhow!("no API key configured for {}", model.provider))?;
    let base = model.base_url.clone().unwrap_or(DEFAULT_BASE_URL.into());
    let body = build_body(model, &request);

    let response = reqwest::Client::new()
        .post(format!("{}/v1/messages", base.trim_end_matches('/')))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!("anthropic {status}: {detail}");
    }

    let mut usage = Usage::default();
    let mut stop_reason = StopReason::Stop;
    let mut buffer = SseBuffer::new();
    let mut block = Block::None;
    let mut tool_id = String::new();
    let mut tool_name = String::new();
    let mut tool_args = String::new();
    let mut body_stream = response.bytes_stream();

    while let Some(chunk) = body_stream.next().await {
        let chunk = chunk?;
        for payload in buffer.push(&String::from_utf8_lossy(&chunk)) {
            let Ok(event) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            match event["type"].as_str().unwrap_or_default() {
                "message_start" => {
                    apply_usage(&mut usage, &event["message"]["usage"]);
                }
                "content_block_start" => match event["content_block"]["type"].as_str() {
                    Some("text") => {
                        block = Block::Text;
                        let _ = events.send(ProviderEvent::TextStart);
                    }
                    Some("thinking") => {
                        block = Block::Thinking;
                        let _ = events.send(ProviderEvent::ThinkingStart);
                    }
                    Some("tool_use") => {
                        block = Block::ToolCall;
                        tool_id = event["content_block"]["id"].as_str().unwrap_or("").into();
                        tool_name = event["content_block"]["name"].as_str().unwrap_or("").into();
                        tool_args.clear();
                        let _ = events.send(ProviderEvent::ToolCallStart {
                            id: tool_id.clone(),
                            name: tool_name.clone(),
                        });
                    }
                    _ => {}
                },
                "content_block_delta" => match event["delta"]["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(text) = event["delta"]["text"].as_str() {
                            let _ = events.send(ProviderEvent::TextDelta(text.into()));
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = event["delta"]["thinking"].as_str() {
                            let _ = events.send(ProviderEvent::ThinkingDelta(text.into()));
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(part) = event["delta"]["partial_json"].as_str() {
                            tool_args.push_str(part);
                            let _ = events.send(ProviderEvent::ToolCallDelta(part.into()));
                        }
                    }
                    _ => {}
                },
                "content_block_stop" => {
                    match block {
                        Block::Text => {
                            let _ = events.send(ProviderEvent::TextEnd);
                        }
                        Block::Thinking => {
                            let _ = events.send(ProviderEvent::ThinkingEnd);
                        }
                        Block::ToolCall => {
                            let arguments = serde_json::from_str::<Value>(&tool_args)
                                .unwrap_or_else(|_| json!({}));
                            let _ = events.send(ProviderEvent::ToolCallEnd {
                                id: std::mem::take(&mut tool_id),
                                name: std::mem::take(&mut tool_name),
                                arguments,
                            });
                            tool_args.clear();
                        }
                        Block::None => {}
                    }
                    block = Block::None;
                }
                "message_delta" => {
                    apply_usage(&mut usage, &event["usage"]);
                    if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                        stop_reason = map_stop_reason(reason);
                    }
                }
                "error" => {
                    let message = event["error"]["message"].as_str().unwrap_or("stream error");
                    anyhow::bail!("anthropic: {message}");
                }
                _ => {}
            }
        }
    }

    usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
    let _ = events.send(ProviderEvent::Usage(usage));
    let _ = events.send(ProviderEvent::Done(stop_reason));
    Ok(())
}

fn build_body(model: &ModelConfig, request: &Request) -> Value {
    let mut body = json!({
        "model": model.id,
        "max_tokens": model.max_tokens.unwrap_or(8192),
        "stream": true,
        "system": request.system_prompt,
        "messages": convert_messages(&request.messages),
    });

    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool["name"],
                        "description": tool["description"],
                        "input_schema": tool["parameters"],
                    })
                })
                .collect(),
        );
    }

    if let Some(budget) = thinking_budget(&request.thinking_level) {
        body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
    }

    body
}

/// Tool results ride on user turns in the Anthropic format.
pub fn convert_messages(messages: &[Message]) -> Value {
    let mut out: Vec<Value> = Vec::new();

    for message in messages {
        match message {
            Message::User { content, .. } => out.push(json!({
                "role": "user",
                "content": [{ "type": "text", "text": content }],
            })),
            Message::Assistant { content, .. } => {
                let blocks: Vec<Value> = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } if !text.is_empty() => {
                            Some(json!({ "type": "text", "text": text }))
                        }
                        Content::ToolCall {
                            id,
                            name,
                            arguments,
                        } => Some(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": arguments,
                        })),
                        _ => None,
                    })
                    .collect();
                if !blocks.is_empty() {
                    out.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            Message::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": flatten_text(content),
                    "is_error": is_error,
                });
                // Consecutive tool results belong to one user turn.
                match out.last_mut() {
                    Some(last)
                        if last["role"] == "user"
                            && last["content"][0]["type"] == "tool_result" =>
                    {
                        if let Some(array) = last["content"].as_array_mut() {
                            array.push(block);
                        }
                    }
                    _ => out.push(json!({ "role": "user", "content": [block] })),
                }
            }
        }
    }

    Value::Array(out)
}

fn flatten_text(content: &[Content]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn apply_usage(usage: &mut Usage, value: &Value) {
    if let Some(input) = value["input_tokens"].as_u64() {
        usage.input += input;
    }
    if let Some(output) = value["output_tokens"].as_u64() {
        usage.output += output;
    }
    if let Some(cache_read) = value["cache_read_input_tokens"].as_u64() {
        usage.cache_read += cache_read;
    }
    if let Some(cache_write) = value["cache_creation_input_tokens"].as_u64() {
        usage.cache_write += cache_write;
    }
}

fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::Length,
        _ => StopReason::Stop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Usage;

    fn model() -> ModelConfig {
        ModelConfig {
            provider: "anthropic".into(),
            id: "claude-test".into(),
            name: None,
            api: Some("anthropic".into()),
            base_url: None,
            api_key: Some("k".into()),
            api_key_env: None,
            context_window: None,
            max_tokens: Some(1024),
            reasoning: Some(true),
        }
    }

    #[test]
    fn tools_are_sent_with_input_schema() {
        let request = Request {
            system_prompt: "sys".into(),
            messages: vec![Message::user("hi")],
            tools: crate::tools::definitions(),
            thinking_level: "off".into(),
        };
        let body = build_body(&model(), &request);
        assert_eq!(body["tools"][0]["name"], "read");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn thinking_budget_is_attached_when_enabled() {
        let request = Request {
            system_prompt: "sys".into(),
            messages: vec![],
            tools: vec![],
            thinking_level: "high".into(),
        };
        let body = build_body(&model(), &request);
        assert_eq!(body["thinking"]["budget_tokens"], 8192);
    }

    #[test]
    fn consecutive_tool_results_merge_into_one_user_turn() {
        let messages = vec![
            Message::user("go"),
            Message::Assistant {
                content: vec![Content::ToolCall {
                    id: "a".into(),
                    name: "ls".into(),
                    arguments: json!({}),
                }],
                api: "anthropic".into(),
                provider: "anthropic".into(),
                model: "m".into(),
                usage: Usage::default(),
                stop_reason: StopReason::ToolUse,
                error_message: None,
                timestamp: 0,
            },
            Message::ToolResult {
                tool_call_id: "a".into(),
                tool_name: "ls".into(),
                content: vec![Content::text("one")],
                details: None,
                is_error: false,
                timestamp: 0,
            },
            Message::ToolResult {
                tool_call_id: "b".into(),
                tool_name: "ls".into(),
                content: vec![Content::text("two")],
                details: None,
                is_error: false,
                timestamp: 0,
            },
        ];
        let converted = convert_messages(&messages);
        assert_eq!(converted.as_array().unwrap().len(), 3);
        let results = &converted[2]["content"];
        assert_eq!(results.as_array().unwrap().len(), 2);
        assert_eq!(results[0]["tool_use_id"], "a");
        assert_eq!(results[1]["content"], "two");
    }

    #[test]
    fn stop_reasons_map_to_protocol_values() {
        assert_eq!(map_stop_reason("tool_use"), StopReason::ToolUse);
        assert_eq!(map_stop_reason("max_tokens"), StopReason::Length);
        assert_eq!(map_stop_reason("end_turn"), StopReason::Stop);
    }

    #[test]
    fn usage_fields_accumulate_from_both_events() {
        let mut usage = Usage::default();
        apply_usage(
            &mut usage,
            &json!({"input_tokens": 10, "cache_read_input_tokens": 4}),
        );
        apply_usage(&mut usage, &json!({"output_tokens": 7}));
        assert_eq!(usage.input, 10);
        assert_eq!(usage.cache_read, 4);
        assert_eq!(usage.output, 7);
    }
}
