//! Serializable Claude Code `stream-json` protocol state.

use std::collections::{BTreeMap, BTreeSet};

use genehub_proto::{
    ItemDelta, PermissionOption, PermissionOptionKind, PermissionOutcome, PermissionRequest,
    PermissionRequestKind, SessionEvent, TimelineItem, ToolCallDetail, ToolKind, ToolStatus,
    TurnError, TurnErrorCode, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    turn: Turn,
    next_control_id: u64,
    mode: String,
    always_allow: BTreeSet<String>,
    pending_tools: BTreeMap<String, String>,
    session_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    id: Option<String>,
    counter: u64,
    interrupt_requested: bool,
    open_blocks: BTreeMap<u64, (String, BlockKind, String)>,
    tools: BTreeMap<String, (String, String, Value)>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BlockKind {
    Text,
    Thinking,
}

#[derive(Default)]
pub struct LineOutput {
    pub events: Vec<SessionEvent>,
    pub writes: Vec<Vec<u8>>,
    pub persistence: Option<Value>,
}

impl Driver {
    pub fn new(mode: Option<&str>, session_id: Option<String>) -> Self {
        Self {
            turn: Turn::default(),
            next_control_id: 1,
            mode: mode.unwrap_or("bypassPermissions").to_string(),
            always_allow: BTreeSet::new(),
            pending_tools: BTreeMap::new(),
            session_id,
        }
    }

    pub fn prompt(
        &mut self,
        turn_id: &str,
        text: String,
        attachments: &[genehub_proto::Attachment],
    ) -> Result<Vec<u8>, String> {
        self.turn = Turn {
            id: Some(turn_id.to_string()),
            ..Turn::default()
        };
        let mut content = vec![json!({ "type": "text", "text": text })];
        for attachment in attachments {
            if let Some(data) = attachment
                .data_base64
                .as_deref()
                .filter(|_| attachment.mime.starts_with("image/"))
            {
                content.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": attachment.mime,
                        "data": data,
                    }
                }));
            }
        }
        encode(json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        }))
    }

    pub fn interrupt(&mut self) -> Result<Vec<u8>, String> {
        self.turn.interrupt_requested = true;
        let id = self.control_id();
        encode(json!({
            "type": "control_request",
            "request_id": id,
            "request": { "subtype": "interrupt" }
        }))
    }

    pub fn set_model(&mut self, model: &str) -> Result<Vec<u8>, String> {
        self.control("set_model", json!({ "model": model }))
    }

    pub fn set_effort(&mut self, effort: &str) -> Result<Vec<u8>, String> {
        self.control("set_model", json!({ "effort": effort }))
    }

    pub fn set_mode(&mut self, mode: &str) -> Result<Vec<u8>, String> {
        if !matches!(
            mode,
            "default" | "manual" | "acceptEdits" | "plan" | "bypassPermissions"
        ) {
            return Err(format!("unknown Claude mode '{mode}'"));
        }
        self.mode = mode.to_string();
        self.control("set_permission_mode", json!({ "mode": mode }))
    }

    pub fn respond(
        &mut self,
        request_id: &str,
        outcome: &PermissionOutcome,
    ) -> Result<Vec<u8>, String> {
        let tool = self.pending_tools.remove(request_id);
        let response = match outcome {
            PermissionOutcome::Selected { option_id } if option_id == "allow" => {
                json!({ "behavior": "allow" })
            }
            PermissionOutcome::Selected { option_id } if option_id == "allow_always" => {
                if let Some(tool) = tool {
                    self.always_allow.insert(tool);
                }
                json!({ "behavior": "allow" })
            }
            PermissionOutcome::TimedOut { .. } => json!({
                "behavior": "deny",
                "message": "No one was available to approve this, so it was denied."
            }),
            _ => json!({ "behavior": "deny", "message": "Denied by the user." }),
        };
        encode(json!({
            "type": "control_response",
            "response": {
                "request_id": request_id,
                "subtype": "success",
                "response": response,
            }
        }))
    }

    pub fn line(&mut self, line: &str) -> LineOutput {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return LineOutput::default();
        };
        let mut output = LineOutput::default();
        match frame.get("type").and_then(Value::as_str) {
            Some("system") => self.system(&frame, &mut output),
            Some("stream_event") => self.stream(
                frame.get("event").unwrap_or(&Value::Null),
                &mut output.events,
            ),
            Some("assistant") => self.assistant(&frame, &mut output.events),
            Some("user") => self.user(&frame, &mut output.events),
            Some("control_request") => self.control_request(&frame, &mut output),
            Some("result") => self.result(&frame, &mut output.events),
            _ => {}
        }
        output
    }

    fn control(&mut self, subtype: &str, extra: Value) -> Result<Vec<u8>, String> {
        let id = self.control_id();
        let mut request = json!({ "subtype": subtype });
        if let (Some(target), Some(source)) = (request.as_object_mut(), extra.as_object()) {
            target.extend(source.clone());
        }
        encode(json!({
            "type": "control_request",
            "request_id": id,
            "request": request,
        }))
    }

    fn control_id(&mut self) -> String {
        let id = format!("genehub_{}", self.next_control_id);
        self.next_control_id = self.next_control_id.saturating_add(1);
        id
    }

    fn system(&mut self, frame: &Value, output: &mut LineOutput) {
        match frame.get("subtype").and_then(Value::as_str) {
            Some("init") => {
                if let Some(id) = frame.get("session_id").and_then(Value::as_str) {
                    self.session_id = Some(id.to_string());
                    output.persistence = Some(json!({ "sessionId": id }));
                }
            }
            Some("compact_boundary") => {
                let Some(turn_id) = self.turn.id.clone() else {
                    return;
                };
                let id = self.next_item();
                let reason = frame
                    .get("compact_metadata")
                    .and_then(|value| value.get("trigger"))
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .to_string();
                output.events.push(SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::Compaction { id, reason },
                });
            }
            _ => {}
        }
    }

    fn stream(&mut self, event: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let kind = event
                    .get("content_block")
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !matches!(kind, "text" | "thinking") {
                    return;
                }
                let id = self.next_item();
                let block = if kind == "thinking" {
                    BlockKind::Thinking
                } else {
                    BlockKind::Text
                };
                self.turn
                    .open_blocks
                    .insert(index, (id.clone(), block, String::new()));
                let item = match block {
                    BlockKind::Text => TimelineItem::AssistantMessage {
                        id,
                        text: String::new(),
                    },
                    BlockKind::Thinking => TimelineItem::Reasoning {
                        id,
                        text: String::new(),
                    },
                };
                events.push(SessionEvent::Item { turn_id, item });
            }
            Some("content_block_delta") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = event.get("delta").unwrap_or(&Value::Null);
                let text = match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => delta.get("text").and_then(Value::as_str),
                    Some("thinking_delta") => delta.get("thinking").and_then(Value::as_str),
                    _ => None,
                };
                let (Some((id, _, accumulated)), Some(text)) =
                    (self.turn.open_blocks.get_mut(&index), text)
                else {
                    return;
                };
                accumulated.push_str(text);
                events.push(SessionEvent::ItemDelta {
                    turn_id,
                    item_id: id.clone(),
                    delta: ItemDelta::Text {
                        delta: text.to_string(),
                    },
                });
            }
            Some("content_block_stop") => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some((id, kind, text)) = self.turn.open_blocks.remove(&index) else {
                    return;
                };
                let item = match kind {
                    BlockKind::Text => TimelineItem::AssistantMessage { id, text },
                    BlockKind::Thinking => TimelineItem::Reasoning { id, text },
                };
                events.push(SessionEvent::Item { turn_id, item });
            }
            _ => {}
        }
    }

    fn assistant(&mut self, frame: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        for block in blocks(frame) {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(tool_id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            if self.turn.tools.contains_key(tool_id) {
                continue;
            }
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let id = self.next_item();
            self.turn.tools.insert(
                tool_id.to_string(),
                (id.clone(), name.clone(), input.clone()),
            );
            events.push(SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: TimelineItem::ToolCall {
                    id,
                    name: name.clone(),
                    status: ToolStatus::Running,
                    detail: detail(&name, &input, None),
                },
            });
        }
    }

    fn user(&mut self, frame: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        for block in blocks(frame) {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_result") => {
                    let Some((id, name, input)) = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .and_then(|id| self.turn.tools.get(id))
                        .cloned()
                    else {
                        continue;
                    };
                    let status = if block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Ok
                    };
                    let result = result_text(&block);
                    events.push(SessionEvent::Item {
                        turn_id: turn_id.clone(),
                        item: TimelineItem::ToolCall {
                            id,
                            name: name.clone(),
                            status,
                            detail: detail(&name, &input, result.as_deref()),
                        },
                    });
                }
                Some("text")
                    if block.get("text").and_then(Value::as_str)
                        == Some("[Request interrupted by user]") =>
                {
                    self.turn.interrupt_requested = true;
                }
                _ => {}
            }
        }
    }

    fn control_request(&mut self, frame: &Value, output: &mut LineOutput) {
        let request = frame.get("request").unwrap_or(&Value::Null);
        if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
            return;
        }
        let Some(request_id) = frame.get("request_id").and_then(Value::as_str) else {
            return;
        };
        let tool = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("a tool")
            .to_string();
        if matches!(self.mode.as_str(), "acceptEdits" | "bypassPermissions")
            || self.always_allow.contains(&tool)
        {
            output.writes.push(
                encode(json!({
                    "type": "control_response",
                    "response": {
                        "request_id": request_id,
                        "subtype": "success",
                        "response": { "behavior": "allow" }
                    }
                }))
                .unwrap_or_default(),
            );
            return;
        }
        self.pending_tools
            .insert(request_id.to_string(), tool.clone());
        let item_id = request
            .get("tool_use_id")
            .and_then(Value::as_str)
            .and_then(|id| self.turn.tools.get(id))
            .map(|(id, ..)| id.clone());
        output.events.push(SessionEvent::PermissionRequested {
            request: PermissionRequest {
                id: request_id.to_string(),
                kind: PermissionRequestKind::Permission,
                title: format!("Allow {tool}?"),
                detail: request
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tool_call_id: item_id,
                options: vec![
                    PermissionOption {
                        id: "allow".into(),
                        label: "Allow".into(),
                        kind: PermissionOptionKind::AllowOnce,
                    },
                    PermissionOption {
                        id: "allow_always".into(),
                        label: format!("Always Allow {tool}"),
                        kind: PermissionOptionKind::AllowAlways,
                    },
                    PermissionOption {
                        id: "deny".into(),
                        label: "Deny".into(),
                        kind: PermissionOptionKind::Reject,
                    },
                ],
                questions: None,
            },
        });
    }

    fn result(&mut self, frame: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.take() else {
            return;
        };
        if !frame
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let usage = frame.get("usage").unwrap_or(&Value::Null);
            let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
            events.push(SessionEvent::TurnCompleted {
                turn_id,
                usage: Usage {
                    input_tokens: count("input_tokens"),
                    output_tokens: count("output_tokens"),
                    cache_read_tokens: count("cache_read_input_tokens"),
                    cache_write_tokens: count("cache_creation_input_tokens"),
                    cost_usd: frame.get("total_cost_usd").and_then(Value::as_f64),
                },
                fork_checkpoint: None,
            });
        } else if self.turn.interrupt_requested {
            events.push(SessionEvent::TurnCanceled { turn_id });
        } else {
            let message = frame
                .get("errors")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(Value::as_str)
                .or_else(|| frame.get("result").and_then(Value::as_str))
                .unwrap_or("Claude Code reported an error")
                .to_string();
            let lower = message.to_ascii_lowercase();
            events.push(SessionEvent::TurnFailed {
                turn_id,
                error: TurnError {
                    code: if lower.contains("401") || lower.contains("api key") {
                        TurnErrorCode::MissingCredentials
                    } else if lower.contains("429") {
                        TurnErrorCode::RateLimited
                    } else {
                        TurnErrorCode::Upstream
                    },
                    message,
                },
            });
        }
    }

    fn next_item(&mut self) -> String {
        self.turn.counter = self.turn.counter.saturating_add(1);
        format!(
            "{}-{}",
            self.turn.id.as_deref().unwrap_or("turn"),
            self.turn.counter
        )
    }
}

fn encode(value: Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn blocks(frame: &Value) -> Vec<Value> {
    frame
        .get("message")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn result_text(block: &Value) -> Option<String> {
    match block.get("content") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Array(values)) => {
            let joined = values
                .iter()
                .filter_map(|value| value.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn detail(name: &str, input: &Value, result: Option<&str>) -> ToolCallDetail {
    let field = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    match name {
        "Bash" => ToolCallDetail::Overview {
            tool_kind: ToolKind::Shell,
            overview: field("description"),
            input: field("command"),
            output: result.unwrap_or_default().to_string(),
        },
        "Read" => ToolCallDetail::Read {
            path: field("file_path"),
            content: result.unwrap_or_default().to_string(),
            truncated: false,
        },
        "Write" => ToolCallDetail::Write {
            path: field("file_path"),
            content: field("content"),
        },
        "Edit" | "NotebookEdit" => ToolCallDetail::Edit {
            path: field("file_path"),
            diff: field("new_string"),
        },
        "Grep" | "Glob" => ToolCallDetail::Search {
            query: field("pattern"),
            matches: Vec::new(),
        },
        "WebFetch" | "WebSearch" => ToolCallDetail::Fetch {
            url: input
                .get("url")
                .or_else(|| input.get("query"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            summary: result.unwrap_or_default().to_string(),
        },
        "Task" | "Agent" => ToolCallDetail::SubAgent {
            agent: input
                .get("subagent_type")
                .or_else(|| input.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("sub-agent")
                .to_string(),
            prompt: field("prompt"),
            items: Vec::new(),
        },
        "ExitPlanMode" | "TaskCreate" | "TaskList" | "TaskUpdate" => ToolCallDetail::Plan {
            markdown: input
                .get("plan")
                .and_then(Value::as_str)
                .or(result)
                .unwrap_or_default()
                .to_string(),
        },
        _ => ToolCallDetail::Unknown {
            raw: json!({ "input": input, "output": result }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_and_result_form_one_turn() {
        let mut driver = Driver::new(None, None);
        driver.prompt("turn_1", "hello".into(), &[]).unwrap();
        let start = driver.line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}"#);
        assert!(matches!(start.events[0], SessionEvent::Item { .. }));
        let delta = driver.line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}"#);
        assert!(matches!(delta.events[0], SessionEvent::ItemDelta { .. }));
        let result = driver.line(
            r#"{"type":"result","is_error":false,"usage":{"input_tokens":1,"output_tokens":2}}"#,
        );
        assert!(matches!(
            result.events[0],
            SessionEvent::TurnCompleted { .. }
        ));
    }

    #[test]
    fn permission_is_answered_on_the_same_control_id() {
        let mut driver = Driver::new(Some("default"), None);
        driver.prompt("turn_1", "hello".into(), &[]).unwrap();
        let output = driver.line(r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#);
        assert!(matches!(
            output.events[0],
            SessionEvent::PermissionRequested { .. }
        ));
        let answer = driver
            .respond(
                "r1",
                &PermissionOutcome::Selected {
                    option_id: "allow".into(),
                },
            )
            .unwrap();
        let value: Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(value["response"]["request_id"], "r1");
    }
}
