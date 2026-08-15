use std::collections::HashMap;

use genehub_proto::{
    ItemDelta, ProtocolError, SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnError,
    TurnErrorCode, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    turn: TurnState,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnState {
    id: Option<String>,
    counter: u64,
    text_item: Option<String>,
    reasoning_item: Option<String>,
    usage: Usage,
    calls: HashMap<String, (String, Value)>,
    failure: Option<TurnError>,
    canceled: bool,
}

impl TurnState {
    fn next_item_id(&mut self) -> String {
        self.counter = self.counter.saturating_add(1);
        format!("{}-{}", self.id.as_deref().unwrap_or("turn"), self.counter)
    }
}

impl Driver {
    pub fn prompt(&mut self, turn_id: &str, text: String) -> Vec<u8> {
        self.turn = TurnState {
            id: Some(turn_id.to_string()),
            ..TurnState::default()
        };
        serde_json::to_vec(&json!({
            "id": turn_id,
            "type": "prompt",
            "message": text,
        }))
        .expect("JSON value is serializable")
    }

    pub fn set_model(&self, model_id: &str) -> Result<Vec<u8>, ProtocolError> {
        let (provider, model) = validate_model(model_id)?;
        Ok(serde_json::to_vec(&json!({
            "type": "set_model",
            "provider": provider,
            "modelId": model,
        }))
        .expect("JSON value is serializable"))
    }

    pub fn set_effort(&self, effort: &str) -> Result<Vec<u8>, ProtocolError> {
        validate_effort(effort)?;
        Ok(serde_json::to_vec(&json!({
            "type": "set_thinking_level",
            "level": effort,
        }))
        .expect("JSON value is serializable"))
    }

    pub fn interrupt(&mut self) -> Vec<u8> {
        self.turn.canceled = true;
        serde_json::to_vec(&json!({ "type": "abort" })).expect("JSON value is serializable")
    }

    pub fn line(&mut self, line: &str) -> Vec<SessionEvent> {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        translate_frame(&frame, &mut self.turn, &mut events);
        events
    }
}

pub fn validate_model(model_id: &str) -> Result<(&str, &str), ProtocolError> {
    let (provider, model) = model_id.split_once('/').ok_or_else(|| ProtocolError {
        code: genehub_proto::ErrorCode::BadRequest,
        message: format!("model id must be provider/model, got {model_id}"),
    })?;
    if provider.is_empty() || model.is_empty() {
        return Err(ProtocolError {
            code: genehub_proto::ErrorCode::BadRequest,
            message: format!("model id must be provider/model, got {model_id}"),
        });
    }
    Ok((provider, model))
}

pub fn validate_effort(effort: &str) -> Result<(), ProtocolError> {
    if !THINKING_LEVELS.contains(&effort) {
        return Err(ProtocolError {
            code: genehub_proto::ErrorCode::BadRequest,
            message: format!("unknown thinking level {effort}"),
        });
    }
    Ok(())
}

fn translate_frame(frame: &Value, state: &mut TurnState, events: &mut Vec<SessionEvent>) {
    let Some(kind) = frame.get("type").and_then(Value::as_str) else {
        return;
    };
    if kind == "message_update" {
        if let Some(inner) = frame.get("assistantMessageEvent") {
            translate_frame(inner, state, events);
        }
        return;
    }
    let Some(turn_id) = state.id.clone() else {
        return;
    };
    match kind {
        // The session kernel already publishes TurnStarted before writing the
        // prompt, so the Agent's acknowledgement does not duplicate it.
        "agent_start" => {}
        "text_start" => {
            let id = state.next_item_id();
            state.text_item = Some(id.clone());
            events.push(SessionEvent::Item {
                turn_id,
                item: TimelineItem::AssistantMessage {
                    id,
                    text: String::new(),
                },
            });
        }
        "text_delta" => {
            if let (Some(item_id), Some(delta)) = (
                state.text_item.clone(),
                frame.get("delta").and_then(Value::as_str),
            ) {
                events.push(SessionEvent::ItemDelta {
                    turn_id,
                    item_id,
                    delta: ItemDelta::Text {
                        delta: delta.to_string(),
                    },
                });
            }
        }
        "text_end" => {
            if let Some(id) = state.text_item.take() {
                events.push(SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::AssistantMessage {
                        id,
                        text: frame
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    },
                });
            }
        }
        "thinking_start" => {
            let id = state.next_item_id();
            state.reasoning_item = Some(id.clone());
            events.push(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Reasoning {
                    id,
                    text: String::new(),
                },
            });
        }
        "thinking_delta" => {
            if let (Some(item_id), Some(delta)) = (
                state.reasoning_item.clone(),
                frame.get("delta").and_then(Value::as_str),
            ) {
                events.push(SessionEvent::ItemDelta {
                    turn_id,
                    item_id,
                    delta: ItemDelta::Text {
                        delta: delta.to_string(),
                    },
                });
            }
        }
        "thinking_end" => state.reasoning_item = None,
        "toolcall_end" => {
            let call = frame.get("toolCall").unwrap_or(&Value::Null);
            let (Some(id), Some(name)) = (
                call.get("id").and_then(Value::as_str),
                call.get("name").and_then(Value::as_str),
            ) else {
                return;
            };
            let arguments = call.get("arguments").cloned().unwrap_or(Value::Null);
            state
                .calls
                .insert(id.to_string(), (name.to_string(), arguments.clone()));
            events.push(SessionEvent::Item {
                turn_id,
                item: TimelineItem::ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    status: ToolStatus::Pending,
                    detail: detail_from_call(name, &arguments),
                },
            });
        }
        "tool_execution_start" => {
            if let Some(item_id) = frame.get("toolCallId").and_then(Value::as_str) {
                events.push(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: item_id.to_string(),
                    delta: ItemDelta::ToolStatus {
                        status: ToolStatus::Running,
                        detail: None,
                    },
                });
            }
        }
        "tool_execution_end" => {
            let Some(id) = frame.get("toolCallId").and_then(Value::as_str) else {
                return;
            };
            let (name, arguments) = state
                .calls
                .get(id)
                .cloned()
                .unwrap_or_else(|| ("unknown".to_string(), Value::Null));
            let result = frame.get("result").unwrap_or(&Value::Null);
            let is_error = frame
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            events.push(SessionEvent::Item {
                turn_id,
                item: TimelineItem::ToolCall {
                    id: id.to_string(),
                    name: name.clone(),
                    status: if is_error {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Ok
                    },
                    detail: detail_from_result(&name, &arguments, result, is_error),
                },
            });
        }
        "message_end" => {
            let message = frame.get("message").unwrap_or(&Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            if let Some(usage) = message.get("usage") {
                accumulate_usage(&mut state.usage, usage);
            }
            match message.get("stopReason").and_then(Value::as_str) {
                Some("error") => {
                    state.failure = Some(classify_failure(
                        message
                            .get("errorMessage")
                            .and_then(Value::as_str)
                            .unwrap_or("The Agent could not complete this turn."),
                    ));
                }
                Some("aborted") => state.canceled = true,
                _ => {}
            }
        }
        "compaction_end" => {
            let id = state.next_item_id();
            events.push(SessionEvent::Item {
                turn_id,
                item: TimelineItem::Compaction {
                    id,
                    reason: frame
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("auto")
                        .to_string(),
                },
            });
        }
        "agent_end" => {
            let usage = std::mem::take(&mut state.usage);
            let failure = state.failure.take();
            let canceled = state.canceled;
            state.id = None;
            state.calls.clear();
            state.text_item = None;
            state.reasoning_item = None;
            state.canceled = false;
            if let Some(error) = failure {
                events.push(SessionEvent::TurnFailed { turn_id, error });
            } else if canceled {
                events.push(SessionEvent::TurnCanceled { turn_id });
            } else {
                events.push(SessionEvent::TurnCompleted {
                    turn_id,
                    usage,
                    fork_checkpoint: None,
                });
            }
        }
        _ => {}
    }
}

fn classify_failure(message: &str) -> TurnError {
    let lower = message.to_ascii_lowercase();
    let code =
        if lower.contains("api key") || lower.contains("unauthorized") || lower.contains("401") {
            TurnErrorCode::MissingCredentials
        } else if lower.contains("429") || lower.contains("rate limit") {
            TurnErrorCode::RateLimited
        } else if lower.contains("timeout") || lower.contains("timed out") {
            TurnErrorCode::Timeout
        } else {
            TurnErrorCode::Upstream
        };
    TurnError {
        code,
        message: message.to_string(),
    }
}

fn accumulate_usage(total: &mut Usage, usage: &Value) {
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    total.input_tokens = total.input_tokens.saturating_add(count("input"));
    total.output_tokens = total.output_tokens.saturating_add(count("output"));
    total.cache_read_tokens = total.cache_read_tokens.saturating_add(count("cacheRead"));
    total.cache_write_tokens = total.cache_write_tokens.saturating_add(count("cacheWrite"));
    if let Some(cost) = usage
        .get("cost")
        .and_then(|value| value.get("total"))
        .and_then(Value::as_f64)
    {
        total.cost_usd = Some(total.cost_usd.unwrap_or(0.0) + cost);
    }
}

fn arg(arguments: &Value, key: &str) -> String {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn detail_from_call(name: &str, arguments: &Value) -> ToolCallDetail {
    match name {
        "bash" => ToolCallDetail::Shell {
            command: arg(arguments, "command"),
            output: String::new(),
            exit_code: None,
        },
        "read" => ToolCallDetail::Read {
            path: arg(arguments, "path"),
            content: String::new(),
            truncated: false,
        },
        "write" => ToolCallDetail::Write {
            path: arg(arguments, "path"),
            content: arg(arguments, "content"),
        },
        "edit" => ToolCallDetail::Edit {
            path: arg(arguments, "path"),
            diff: String::new(),
        },
        _ => ToolCallDetail::Unknown {
            raw: json!({ "arguments": arguments }),
        },
    }
}

fn detail_from_result(
    name: &str,
    arguments: &Value,
    result: &Value,
    is_error: bool,
) -> ToolCallDetail {
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    match name {
        "bash" => ToolCallDetail::Shell {
            command: arg(arguments, "command"),
            output: text,
            exit_code: (!is_error).then_some(0),
        },
        "read" => ToolCallDetail::Read {
            path: arg(arguments, "path"),
            content: text,
            truncated: false,
        },
        "write" => ToolCallDetail::Write {
            path: arg(arguments, "path"),
            content: arg(arguments, "content"),
        },
        "edit" => ToolCallDetail::Edit {
            path: arg(arguments, "path"),
            diff: text,
        },
        _ => {
            let mut raw = Map::new();
            raw.insert("arguments".to_string(), arguments.clone());
            raw.insert("output".to_string(), Value::String(text));
            ToolCallDetail::Unknown {
                raw: Value::Object(raw),
            }
        }
    }
}
