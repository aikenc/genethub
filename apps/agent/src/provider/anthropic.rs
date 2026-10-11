//! Anthropic Messages API (streaming).

use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::Path;
use tokio::sync::mpsc::UnboundedSender;

use super::{
    adjust_max_tokens_for_thinking, clamp_max_tokens_to_context, media, select_effort, transform,
    ProviderEvent, Request, SseBuffer, DEFAULT_ANTHROPIC_MAX_TOKENS, MIN_OUTPUT_TOKENS,
};
use crate::config::ModelConfig;
use crate::protocol::{Content, Message, StopReason, Usage};

const API_VERSION: &str = "2023-06-01";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";
pub const REDACTED_THINKING_TEXT: &str = "[Reasoning redacted]";

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
    // Named by the caller, always. See the note in `openai.rs`: this file also
    // serves anything that copies Anthropic's shape, including DeepSeek's own
    // Anthropic-compatible endpoint.
    let base = model
        .base_url
        .clone()
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{} 没有配置接口地址，不知道该把请求发去哪里",
                model.provider
            )
        })?;
    let body = build_body(model, &request)?;

    let mut builder = genet_http::Client::new()
        .post(format!("{}/v1/messages", base.trim_end_matches('/')))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    if needs_interleaved_beta(model, &request.thinking_level) {
        builder = builder.header("anthropic-beta", INTERLEAVED_THINKING_BETA);
    }
    let response = builder.json(&body).send().await?;

    if !response.status().is_success() {
        return Err(super::http_error(&model.provider, response).await.into());
    }

    let mut usage = Usage::default();
    // pi: a stream that never reports why it stopped is an error, not a
    // silent success with whatever text arrived.
    let mut stop_reason: Option<StopReason> = None;
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
                        let start = &event["content_block"];
                        if let Some(text) = start["thinking"].as_str().filter(|t| !t.is_empty()) {
                            let _ = events.send(ProviderEvent::ThinkingDelta(text.into()));
                        }
                        if let Some(sig) = start["signature"].as_str().filter(|s| !s.is_empty()) {
                            let _ = events.send(ProviderEvent::ThinkingSignature(sig.into()));
                        }
                    }
                    Some("redacted_thinking") => {
                        // Opaque to us and to every other model; kept only so
                        // it can be handed back to this one unchanged.
                        block = Block::Thinking;
                        let data = event["content_block"]["data"].as_str().unwrap_or("");
                        let _ = events.send(ProviderEvent::RedactedThinking(data.into()));
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
                    Some("signature_delta") => {
                        if let Some(sig) = event["delta"]["signature"].as_str() {
                            let _ = events.send(ProviderEvent::ThinkingSignature(sig.into()));
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
                        stop_reason =
                            Some(map_stop_reason(reason, &event["delta"]["stop_details"])?);
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
    let Some(stop_reason) = stop_reason else {
        anyhow::bail!("{} stream ended without a stop reason", model.provider);
    };
    let _ = events.send(ProviderEvent::Done(stop_reason));
    Ok(())
}

fn build_body(model: &ModelConfig, request: &Request) -> anyhow::Result<Value> {
    let cache = cache_control(model);
    let mode = model.thinking();
    let thinking_on = super::thinking_budget(&request.thinking_level).is_some();
    let model_max = model.max_tokens.unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS);

    let mut max_tokens = clamp_max_tokens_to_context(model.context_window, request, model_max);
    let mut thinking: Option<Value> = None;
    let mut output_config: Option<Value> = None;
    let display = model
        .compat
        .thinking_display
        .clone()
        .unwrap_or_else(|| "summarized".into());

    if thinking_on {
        match mode {
            "adaptive" => {
                // An adaptive model decides how much to think; the only thing
                // left to ask for is how hard to push it.
                thinking = Some(json!({ "type": "adaptive", "display": display }));
                if let Some(effort) =
                    select_effort(&request.thinking_level, &model.thinking_efforts)
                {
                    output_config = Some(json!({ "effort": effort }));
                }
            }
            "budget" => {
                // pi `streamSimple`: fit the budget inside the model cap, clamp
                // the cap to what the window still holds, then make sure the
                // budget still leaves room for a visible answer.
                let (adjusted, budget) =
                    adjust_max_tokens_for_thinking(model_max, &request.thinking_level);
                max_tokens = clamp_max_tokens_to_context(model.context_window, request, adjusted);
                let budget = budget.min(max_tokens.saturating_sub(MIN_OUTPUT_TOKENS));
                // Anthropic's floor; below it the request would be rejected,
                // so this turn simply runs without extended thinking.
                if budget >= 1024 {
                    thinking = Some(json!({
                        "type": "enabled",
                        "budget_tokens": budget,
                        "display": display,
                    }));
                }
            }
            // `only`: the model always thinks and takes no switch.
            // `none`: it cannot think.
            _ => {}
        }
    } else if model.reasoning == Some(true) && matches!(mode, "adaptive" | "budget") {
        thinking = Some(json!({ "type": "disabled" }));
    }

    let mut body = json!({
        "model": model.id,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": convert_messages(model, &request.cwd, &request.messages)?,
    });
    if !request.system_prompt.is_empty() {
        let mut block = json!({ "type": "text", "text": request.system_prompt });
        if let Some(cache) = &cache {
            block["cache_control"] = cache.clone();
        }
        body["system"] = json!([block]);
    }

    if !request.tools.is_empty() {
        let last = request.tools.len() - 1;
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .enumerate()
                .map(|(index, tool)| {
                    let mut tool = json!({
                        "name": tool["name"],
                        "description": tool["description"],
                        "input_schema": tool["parameters"],
                    });
                    if let (Some(cache), true) = (&cache, index == last) {
                        tool["cache_control"] = cache.clone();
                    }
                    tool
                })
                .collect(),
        );
    }

    if let Some(thinking) = thinking {
        body["thinking"] = thinking;
    }
    if let Some(output_config) = output_config {
        body["output_config"] = output_config;
    }
    Ok(body)
}

/// pi's default `cacheRetention: "short"`; gateways that reject the field can
/// switch it off per model.
fn cache_control(model: &ModelConfig) -> Option<Value> {
    (model.compat.supports_cache_control != Some(false)).then(|| json!({ "type": "ephemeral" }))
}

/// Budget-mode models need the beta for thinking between tool calls; adaptive
/// models have it built in, and pi skips the header for them.
fn needs_interleaved_beta(model: &ModelConfig, level: &str) -> bool {
    model.thinking() == "budget" && super::thinking_budget(level).is_some()
}

/// Tool results ride on user turns in the Anthropic format.
pub fn convert_messages(
    model: &ModelConfig,
    cwd: &Path,
    messages: &[Message],
) -> anyhow::Result<Value> {
    let messages =
        transform::transform_messages(messages, model, transform::normalize_anthropic_id);
    let mut out: Vec<Value> = Vec::new();
    let latest_user = messages
        .iter()
        .rposition(|message| matches!(message, Message::User { .. }));

    for (index, message) in messages.iter().enumerate() {
        match message {
            Message::User {
                content,
                attachments,
                ..
            } => {
                let mut blocks = Vec::new();
                if !content.trim().is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                for attachment in attachments {
                    let kind = media::kind(attachment)?;
                    if Some(index) != latest_user
                        && (kind == "video"
                            || !model.input_modalities.iter().any(|input| input == kind))
                    {
                        blocks.push(json!({
                            "type": "text",
                            "text": media::historical_note(attachment, kind),
                        }));
                        continue;
                    }
                    let (kind, url) = media::data_url(model, cwd, attachment)?;
                    if kind == "video" {
                        anyhow::bail!("Anthropic Messages API 不支持原生视频输入");
                    }
                    let data = url.split_once(',').expect("data URL has a comma").1;
                    blocks.push(json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": attachment.mime, "data": data },
                    }));
                }
                if !blocks.is_empty() {
                    out.push(json!({ "role": "user", "content": blocks }));
                }
            }
            Message::Assistant { content, .. } => {
                let blocks: Vec<Value> = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } if !text.trim().is_empty() => {
                            Some(json!({ "type": "text", "text": text }))
                        }
                        Content::Text { .. } => None,
                        Content::Thinking {
                            thinking,
                            signature,
                            redacted,
                        } => replay_thinking(thinking, signature.as_deref(), *redacted),
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

    // pi: the last block of the final user turn is the conversation-history
    // cache breakpoint.
    if let Some(cache) = cache_control(model) {
        if let Some(last) = out.last_mut().filter(|last| last["role"] == "user") {
            if let Some(block) = last["content"]
                .as_array_mut()
                .and_then(|blocks| blocks.last_mut())
            {
                block["cache_control"] = cache;
            }
        }
    }

    Ok(Value::Array(out))
}

/// pi `convertMessages`: redacted blocks go back as `redacted_thinking`, signed
/// ones as `thinking` with their signature, and unsigned ones (an aborted
/// stream, or another model's reasoning) as plain text the API cannot reject.
fn replay_thinking(thinking: &str, signature: Option<&str>, redacted: bool) -> Option<Value> {
    if redacted {
        return Some(json!({ "type": "redacted_thinking", "data": signature.unwrap_or("") }));
    }
    let signature = signature.filter(|s| !s.trim().is_empty());
    if thinking.trim().is_empty() && signature.is_none() {
        return None;
    }
    Some(match signature {
        Some(signature) => {
            json!({ "type": "thinking", "thinking": thinking, "signature": signature })
        }
        None => json!({ "type": "text", "text": thinking }),
    })
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

/// pi: Anthropic reports running totals, not increments — `message_start`
/// carries the input side, `message_delta` the final figures. Fields are
/// assigned when present, so a proxy that omits `input_tokens` from the delta
/// keeps the value from `message_start`.
fn apply_usage(usage: &mut Usage, value: &Value) {
    if let Some(input) = value["input_tokens"].as_u64() {
        usage.token_usage_reported = true;
        usage.input = input;
    }
    if let Some(output) = value["output_tokens"].as_u64() {
        usage.token_usage_reported = true;
        usage.output = output;
    }
    if let Some(cache_read) = value["cache_read_input_tokens"].as_u64() {
        usage.cache_read = cache_read;
    }
    if let Some(cache_write) = value["cache_creation_input_tokens"].as_u64() {
        usage.cache_write = cache_write;
    }
}

/// pi `mapStopReason`. A refusal or safety stop is an error with its reason;
/// an unknown value fails loudly instead of passing for success.
fn map_stop_reason(reason: &str, details: &Value) -> anyhow::Result<StopReason> {
    Ok(match reason {
        "end_turn" | "stop_sequence" | "pause_turn" => StopReason::Stop,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::Length,
        "refusal" => anyhow::bail!(
            "{}",
            details["explanation"]
                .as_str()
                .filter(|text| !text.is_empty())
                .unwrap_or("The model refused to complete the request")
        ),
        "sensitive" => anyhow::bail!("Provider stopped with: sensitive"),
        other => anyhow::bail!("Unhandled stop reason: {other}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Usage;

    fn model() -> ModelConfig {
        ModelConfig {
            provider: "anthropic".into(),
            id: "claude-test".into(),
            api: Some("anthropic".into()),
            api_key: Some("k".into()),
            max_tokens: Some(32000),
            reasoning: Some(true),
            ..ModelConfig::default()
        }
    }

    fn request_with(level: &str) -> Request {
        Request {
            system_prompt: "sys".into(),
            messages: vec![Message::user("hi")],
            tools: vec![],
            thinking_level: level.into(),
            cwd: ".".into(),
        }
    }

    fn model_with(id: &str, mode: Option<&str>) -> ModelConfig {
        ModelConfig {
            thinking_mode: mode.map(|mode| mode.to_string()),
            id: id.into(),
            ..model()
        }
    }

    fn assistant(content: Vec<Content>) -> Message {
        Message::Assistant {
            content,
            api: "anthropic".into(),
            provider: "anthropic".into(),
            model: "claude-test".into(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 0,
        }
    }

    #[test]
    fn tools_system_and_last_user_turn_carry_cache_breakpoints() {
        let request = Request {
            tools: crate::tools::definitions(),
            ..request_with("off")
        };
        let body = build_body(&model(), &request).unwrap();
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "read");
        assert_eq!(tools[0]["input_schema"]["type"], "object");
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools.last().unwrap()["cache_control"]["type"], "ephemeral");
        assert_eq!(body["system"][0]["text"], "sys");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );

        let plain = ModelConfig {
            compat: crate::config::Compat {
                supports_cache_control: Some(false),
                ..Default::default()
            },
            ..model()
        };
        let body = build_body(&plain, &request).unwrap();
        assert!(!body.to_string().contains("cache_control"));
    }

    #[test]
    fn budget_thinking_uses_pi_budgets_and_leaves_room_for_output() {
        let body = build_body(
            &model_with("claude-test", Some("budget")),
            &request_with("high"),
        )
        .unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 16384);
        assert_eq!(body["thinking"]["display"], "summarized");
        assert_eq!(body["max_tokens"], 32000);

        // The bug behind fb_IXUzjtBuA4wt's sibling report: a budget at or above
        // max_tokens is rejected outright.
        let small = ModelConfig {
            max_tokens: Some(8192),
            ..model_with("claude-test", Some("budget"))
        };
        let body = build_body(&small, &request_with("high")).unwrap();
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["thinking"]["budget_tokens"], 8192 - 1024);
    }

    #[test]
    fn max_tokens_shrink_to_what_the_window_still_holds() {
        let tight = ModelConfig {
            context_window: Some(20_000),
            ..model_with("claude-test", Some("budget"))
        };
        let mut request = request_with("high");
        request.messages = vec![Message::user("x".repeat(40_000))];
        let body = build_body(&tight, &request).unwrap();
        let max = body["max_tokens"].as_u64().unwrap();
        assert!(max < 6_000, "max_tokens {max}");
        let budget = body["thinking"]["budget_tokens"].as_u64().unwrap();
        assert!(budget + MIN_OUTPUT_TOKENS <= max);
    }

    #[test]
    fn adaptive_models_take_an_effort_instead_of_a_budget() {
        let body = build_body(
            &model_with("claude-opus-5-5", Some("adaptive")),
            &request_with("medium"),
        )
        .unwrap();
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["thinking"]["display"], "summarized");
        assert!(body["thinking"].get("budget_tokens").is_none());
        assert_eq!(body["output_config"]["effort"], "medium");
    }

    #[test]
    fn the_mode_comes_from_config_not_the_model_id() {
        // No id rule any more: an unset mode on a reasoning model is budget.
        let body = build_body(&model_with("claude-opus-5-5", None), &request_with("high")).unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        let aliased = build_body(
            &model_with("vendor--claude-opus-latest", Some("adaptive")),
            &request_with("high"),
        )
        .unwrap();
        assert_eq!(aliased["thinking"]["type"], "adaptive");
        assert_eq!(aliased["output_config"]["effort"], "high");
    }

    #[test]
    fn efforts_follow_what_the_model_declares() {
        for (level, declared, effort) in [
            ("minimal", vec![], "low"),
            ("medium", vec![], "medium"),
            ("xhigh", vec![], "high"),
            ("max", vec![], "high"),
            (
                "xhigh",
                vec!["low", "medium", "high", "xhigh", "max"],
                "xhigh",
            ),
            ("max", vec!["low", "medium", "high", "max"], "max"),
        ] {
            let model = ModelConfig {
                thinking_efforts: declared.iter().map(|s| s.to_string()).collect(),
                ..model_with("claude-opus-5-5", Some("adaptive"))
            };
            let body = build_body(&model, &request_with(level)).unwrap();
            assert_eq!(body["output_config"]["effort"], effort, "level {level}");
        }
    }

    #[test]
    fn off_disables_thinking_explicitly_on_reasoning_models_only() {
        let body = build_body(
            &model_with("claude-opus-5-5", Some("adaptive")),
            &request_with("off"),
        )
        .unwrap();
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("output_config").is_none());

        let plain = ModelConfig {
            reasoning: Some(false),
            ..model()
        };
        let body = build_body(&plain, &request_with("off")).unwrap();
        assert!(body.get("thinking").is_none());

        let always = model_with("thinker", Some("only"));
        assert!(build_body(&always, &request_with("off"))
            .unwrap()
            .get("thinking")
            .is_none());
        assert!(build_body(&always, &request_with("high"))
            .unwrap()
            .get("thinking")
            .is_none());
    }

    #[test]
    fn the_interleaved_beta_is_only_for_budget_models() {
        assert!(needs_interleaved_beta(
            &model_with("m", Some("budget")),
            "high"
        ));
        assert!(!needs_interleaved_beta(
            &model_with("m", Some("budget")),
            "off"
        ));
        assert!(!needs_interleaved_beta(
            &model_with("m", Some("adaptive")),
            "high"
        ));
    }

    #[test]
    fn signed_redacted_and_unsigned_thinking_replay_like_pi() {
        let messages = vec![
            Message::user("go"),
            assistant(vec![
                Content::Thinking {
                    thinking: "plan".into(),
                    signature: Some("sig".into()),
                    redacted: false,
                },
                Content::Thinking {
                    thinking: REDACTED_THINKING_TEXT.into(),
                    signature: Some("opaque".into()),
                    redacted: true,
                },
                Content::thinking("aborted halfway"),
                Content::thinking("   "),
                Content::text("  "),
                Content::text("answer"),
            ]),
            Message::user("   "),
            Message::user("next"),
        ];
        let converted = convert_messages(&model(), Path::new("."), &messages).unwrap();
        let blocks = converted[1]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 4);
        assert_eq!(
            blocks[0],
            json!({"type": "thinking", "thinking": "plan", "signature": "sig"})
        );
        assert_eq!(
            blocks[1],
            json!({"type": "redacted_thinking", "data": "opaque"})
        );
        assert_eq!(
            blocks[2],
            json!({"type": "text", "text": "aborted halfway"})
        );
        assert_eq!(blocks[3]["text"], "answer");
        // The whitespace-only user turn is dropped, not sent as an empty block.
        assert_eq!(converted.as_array().unwrap().len(), 3);
    }

    #[test]
    fn consecutive_tool_results_merge_into_one_user_turn() {
        let call = |id: &str| Content::ToolCall {
            id: id.into(),
            name: "ls".into(),
            arguments: json!({}),
        };
        let result = |id: &str, text: &str| Message::ToolResult {
            tool_call_id: id.into(),
            tool_name: "ls".into(),
            content: vec![Content::text(text)],
            details: None,
            is_error: false,
            timestamp: 0,
        };
        let messages = vec![
            Message::user("go"),
            {
                let mut message = assistant(vec![call("a"), call("b")]);
                if let Message::Assistant { stop_reason, .. } = &mut message {
                    *stop_reason = StopReason::ToolUse;
                }
                message
            },
            result("a", "one"),
            result("b", "two"),
        ];
        let converted = convert_messages(&model(), Path::new("."), &messages).unwrap();
        assert_eq!(converted.as_array().unwrap().len(), 3);
        let results = &converted[2]["content"];
        assert_eq!(results.as_array().unwrap().len(), 2);
        assert_eq!(results[0]["tool_use_id"], "a");
        assert_eq!(results[1]["content"], "two");
    }

    #[test]
    fn stop_reasons_map_like_pi() {
        let none = Value::Null;
        assert_eq!(
            map_stop_reason("tool_use", &none).unwrap(),
            StopReason::ToolUse
        );
        assert_eq!(
            map_stop_reason("max_tokens", &none).unwrap(),
            StopReason::Length
        );
        assert_eq!(
            map_stop_reason("end_turn", &none).unwrap(),
            StopReason::Stop
        );
        assert_eq!(
            map_stop_reason("pause_turn", &none).unwrap(),
            StopReason::Stop
        );
        let refusal = map_stop_reason("refusal", &json!({"explanation": "policy"})).unwrap_err();
        assert_eq!(refusal.to_string(), "policy");
        assert!(map_stop_reason("sensitive", &none).is_err());
        assert!(map_stop_reason("brand_new", &none).is_err());
    }

    #[test]
    fn usage_is_assigned_not_summed() {
        let mut usage = Usage::default();
        apply_usage(
            &mut usage,
            &json!({"input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": 4}),
        );
        // message_delta repeats the running totals; proxies may omit input.
        apply_usage(
            &mut usage,
            &json!({"output_tokens": 7, "cache_read_input_tokens": 4}),
        );
        assert_eq!(usage.input, 10);
        assert_eq!(usage.cache_read, 4);
        assert_eq!(usage.output, 7);
    }
}
