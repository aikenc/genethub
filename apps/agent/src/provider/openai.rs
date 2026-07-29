//! OpenAI-compatible Chat Completions (streaming). Also covers DeepSeek, Kimi,
//! OpenRouter, vLLM and other services that copy this shape.

use std::collections::BTreeMap;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use super::{reasoning_effort, ProviderEvent, Request, SseBuffer};
use crate::config::ModelConfig;
use crate::protocol::{Content, Message, StopReason, Usage};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
    started: bool,
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
        .post(format!("{}/chat/completions", base.trim_end_matches('/')))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        // Named after the provider the user configured, not the dialect we
        // speak to it: "openai 401" is baffling when you typed a DeepSeek key.
        anyhow::bail!("{} {status}: {detail}", model.provider);
    }

    let mut usage = Usage::default();
    let mut stop_reason = StopReason::Stop;
    let mut buffer = SseBuffer::new();
    let mut text_open = false;
    let mut thinking_open = false;
    let mut tool_calls: BTreeMap<u64, PartialToolCall> = BTreeMap::new();
    let mut body_stream = response.bytes_stream();

    while let Some(chunk) = body_stream.next().await {
        let chunk = chunk?;
        for payload in buffer.push(&String::from_utf8_lossy(&chunk)) {
            let Ok(event) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            if let Some(message) = event["error"]["message"].as_str() {
                anyhow::bail!("openai: {message}");
            }
            apply_usage(&mut usage, &event["usage"]);

            let choice = &event["choices"][0];
            let delta = &choice["delta"];

            // Reasoning arrives on a separate field and always precedes the
            // answer. Providers disagree on the name, so accept both.
            let reasoning = delta["reasoning_content"]
                .as_str()
                .or_else(|| delta["reasoning"].as_str())
                .filter(|text| !text.is_empty());
            if let Some(text) = reasoning {
                if !thinking_open {
                    thinking_open = true;
                    let _ = events.send(ProviderEvent::ThinkingStart);
                }
                let _ = events.send(ProviderEvent::ThinkingDelta(text.into()));
            }

            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                if thinking_open {
                    thinking_open = false;
                    let _ = events.send(ProviderEvent::ThinkingEnd);
                }
                if !text_open {
                    text_open = true;
                    let _ = events.send(ProviderEvent::TextStart);
                }
                let _ = events.send(ProviderEvent::TextDelta(text.into()));
            }

            if let Some(calls) = delta["tool_calls"].as_array() {
                for call in calls {
                    let index = call["index"].as_u64().unwrap_or(0);
                    let entry = tool_calls.entry(index).or_default();
                    if let Some(id) = call["id"].as_str() {
                        entry.id = id.to_string();
                    }
                    if let Some(name) = call["function"]["name"].as_str() {
                        entry.name.push_str(name);
                    }
                    if !entry.started && !entry.id.is_empty() && !entry.name.is_empty() {
                        entry.started = true;
                        let _ = events.send(ProviderEvent::ToolCallStart {
                            id: entry.id.clone(),
                            name: entry.name.clone(),
                        });
                    }
                    if let Some(part) = call["function"]["arguments"].as_str() {
                        entry.arguments.push_str(part);
                        let _ = events.send(ProviderEvent::ToolCallDelta(part.into()));
                    }
                }
            }

            if let Some(reason) = choice["finish_reason"].as_str() {
                if thinking_open {
                    thinking_open = false;
                    let _ = events.send(ProviderEvent::ThinkingEnd);
                }
                if text_open {
                    text_open = false;
                    let _ = events.send(ProviderEvent::TextEnd);
                }
                stop_reason = map_finish_reason(reason);
            }
        }
    }

    if thinking_open {
        let _ = events.send(ProviderEvent::ThinkingEnd);
    }
    if text_open {
        let _ = events.send(ProviderEvent::TextEnd);
    }
    for (_, call) in tool_calls {
        let arguments =
            serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
        let _ = events.send(ProviderEvent::ToolCallEnd {
            id: call.id,
            name: call.name,
            arguments,
        });
    }

    usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
    let _ = events.send(ProviderEvent::Usage(usage));
    let _ = events.send(ProviderEvent::Done(stop_reason));
    Ok(())
}

fn build_body(model: &ModelConfig, request: &Request) -> Value {
    let mut body = json!({
        "model": model.id,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": convert_messages(&request.system_prompt, &request.messages),
    });

    if let Some(max_tokens) = model.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }

    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool["name"],
                            "description": tool["description"],
                            "parameters": tool["parameters"],
                        }
                    })
                })
                .collect(),
        );
    }

    if let Some(effort) = reasoning_effort(&request.thinking_level) {
        body["reasoning_effort"] = json!(effort);
    }

    body
}

pub fn convert_messages(system_prompt: &str, messages: &[Message]) -> Value {
    let mut out = vec![json!({ "role": "system", "content": system_prompt })];

    for message in messages {
        match message {
            Message::User { content, .. } => {
                out.push(json!({ "role": "user", "content": content }))
            }
            Message::Assistant { content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                let calls: Vec<Value> = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::ToolCall {
                            id,
                            name,
                            arguments,
                        } => Some(json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": arguments.to_string(),
                            }
                        })),
                        _ => None,
                    })
                    .collect();

                if text.is_empty() && calls.is_empty() {
                    continue;
                }
                let mut entry = json!({ "role": "assistant", "content": text });
                if !calls.is_empty() {
                    entry["tool_calls"] = Value::Array(calls);
                }
                out.push(entry);
            }
            Message::ToolResult {
                tool_call_id,
                content,
                ..
            } => out.push(json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            })),
        }
    }

    Value::Array(out)
}

fn apply_usage(usage: &mut Usage, value: &Value) {
    if let Some(input) = value["prompt_tokens"].as_u64() {
        usage.input = input;
    }
    if let Some(output) = value["completion_tokens"].as_u64() {
        usage.output = output;
    }
    if let Some(cached) = value["prompt_tokens_details"]["cached_tokens"].as_u64() {
        usage.cache_read = cached;
    }
}

fn map_finish_reason(reason: &str) -> StopReason {
    match reason {
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::Length,
        _ => StopReason::Stop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> ModelConfig {
        ModelConfig {
            provider: "openai".into(),
            id: "gpt-test".into(),
            name: None,
            api: Some("openai".into()),
            base_url: None,
            api_key: Some("k".into()),
            api_key_env: None,
            context_window: None,
            max_tokens: Some(512),
            reasoning: None,
        }
    }

    #[test]
    fn system_prompt_becomes_the_first_message() {
        let converted = convert_messages("be nice", &[Message::user("hi")]);
        assert_eq!(converted[0]["role"], "system");
        assert_eq!(converted[0]["content"], "be nice");
        assert_eq!(converted[1]["role"], "user");
    }

    #[test]
    fn tool_calls_serialise_arguments_as_a_string() {
        let messages = vec![Message::Assistant {
            content: vec![Content::ToolCall {
                id: "call_1".into(),
                name: "ls".into(),
                arguments: json!({"path": "src"}),
            }],
            api: "openai".into(),
            provider: "openai".into(),
            model: "m".into(),
            usage: Usage::default(),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 0,
        }];
        let converted = convert_messages("sys", &messages);
        let call = &converted[1]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "ls");
        assert_eq!(call["function"]["arguments"], r#"{"path":"src"}"#);
    }

    #[test]
    fn tool_results_use_the_tool_role() {
        let messages = vec![Message::ToolResult {
            tool_call_id: "call_1".into(),
            tool_name: "ls".into(),
            content: vec![Content::text("a\nb")],
            details: None,
            is_error: false,
            timestamp: 0,
        }];
        let converted = convert_messages("sys", &messages);
        assert_eq!(converted[1]["role"], "tool");
        assert_eq!(converted[1]["tool_call_id"], "call_1");
        assert_eq!(converted[1]["content"], "a\nb");
    }

    #[test]
    fn function_tools_are_wrapped_for_the_chat_api() {
        let request = Request {
            system_prompt: "sys".into(),
            messages: vec![],
            tools: crate::tools::definitions(),
            thinking_level: "medium".into(),
        };
        let body = build_body(&model(), &request);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "read");
        assert_eq!(body["reasoning_effort"], "medium");
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn finish_reasons_map_to_protocol_values() {
        assert_eq!(map_finish_reason("tool_calls"), StopReason::ToolUse);
        assert_eq!(map_finish_reason("length"), StopReason::Length);
        assert_eq!(map_finish_reason("stop"), StopReason::Stop);
    }
}
