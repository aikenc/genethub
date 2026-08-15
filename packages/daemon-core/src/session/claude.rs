//! Serializable Claude Code `stream-json` protocol state.

use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
use genehub_proto::PermissionOutcome;
use genehub_proto::{
    Catalog, CommandInfo, ItemDelta, ModeInfo, ModelInfo, PermissionOption, PermissionOptionKind,
    PermissionRequest, PermissionRequestKind, SessionEvent, TimelineItem, ToolCallDetail, ToolKind,
    ToolStatus, TurnError, TurnErrorCode, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_PERMISSION_MODE: &str = "bypassPermissions";
const MODES: [(&str, &str, &str); 3] = [
    (
        "acceptEdits",
        "Accept edits",
        "Apply file edits and commands without asking",
    ),
    (
        "plan",
        "Plan",
        "Read and plan only — no edits and no commands",
    ),
    (
        DEFAULT_PERMISSION_MODE,
        "Bypass permissions",
        "Never ask about tool use",
    ),
];

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
    /// Parent Claude tool-use id -> work performed by the dispatched Agent.
    /// Nested work replaces the parent card as one value; it must never leak
    /// into the root conversation as if the primary Agent performed it.
    #[serde(default)]
    subs: BTreeMap<String, Sub>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sub {
    items: Vec<TimelineItem>,
    /// Child tool-use id -> (item index, original input).
    at: BTreeMap<String, (usize, Value)>,
    counter: u64,
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

    #[cfg(test)]
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
        if let Some(parent) = frame
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .filter(|parent| self.turn.tools.contains_key(*parent))
            .map(str::to_string)
        {
            self.collect_sub_tool_calls(frame, &parent);
            self.emit_sub_agent(&parent, &turn_id, events, ToolStatus::Running, None);
            return;
        }
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
        if let Some(parent) = frame
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .filter(|parent| self.turn.tools.contains_key(*parent))
            .map(str::to_string)
        {
            self.settle_sub_tool_results(frame, &parent);
            self.emit_sub_agent(&parent, &turn_id, events, ToolStatus::Running, None);
            return;
        }
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
                            detail: sub_agent_detail(
                                &name,
                                &input,
                                result.as_deref(),
                                self.turn.subs.get(
                                    block
                                        .get("tool_use_id")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default(),
                                ),
                            ),
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

    fn collect_sub_tool_calls(&mut self, frame: &Value, parent: &str) {
        let Some((parent_item_id, ..)) = self.turn.tools.get(parent).cloned() else {
            return;
        };
        for block in blocks(frame) {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(tool_use_id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let sub = self.turn.subs.entry(parent.to_string()).or_default();
            if sub.at.contains_key(tool_use_id) {
                continue;
            }
            sub.counter = sub.counter.saturating_add(1);
            let id = format!("{parent_item_id}-{}", sub.counter);
            sub.at
                .insert(tool_use_id.to_string(), (sub.items.len(), input.clone()));
            sub.items.push(TimelineItem::ToolCall {
                id,
                name: name.clone(),
                status: ToolStatus::Running,
                detail: detail(&name, &input, None),
            });
        }
    }

    fn settle_sub_tool_results(&mut self, frame: &Value, parent: &str) {
        let Some(sub) = self.turn.subs.get_mut(parent) else {
            return;
        };
        for block in blocks(frame) {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some((at, input)) = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .and_then(|id| sub.at.get(id))
                .cloned()
            else {
                continue;
            };
            let Some(TimelineItem::ToolCall { id, name, .. }) = sub.items.get(at) else {
                continue;
            };
            let (id, name) = (id.clone(), name.clone());
            let status = if block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                ToolStatus::Error
            } else {
                ToolStatus::Ok
            };
            sub.items[at] = TimelineItem::ToolCall {
                id,
                name: name.clone(),
                status,
                detail: detail(&name, &input, result_text(&block).as_deref()),
            };
        }
    }

    fn emit_sub_agent(
        &self,
        parent: &str,
        turn_id: &str,
        events: &mut Vec<SessionEvent>,
        status: ToolStatus,
        result: Option<&str>,
    ) {
        let Some((id, name, input)) = self.turn.tools.get(parent) else {
            return;
        };
        events.push(SessionEvent::Item {
            turn_id: turn_id.to_string(),
            item: TimelineItem::ToolCall {
                id: id.clone(),
                name: name.clone(),
                status,
                detail: sub_agent_detail(name, input, result, self.turn.subs.get(parent)),
            },
        });
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

/// Builds the picker from this installed Claude CLI's own handshake. The
/// aliases, effort levels and commands are owned by Claude, so guessing a
/// static table would expose controls that can silently do nothing.
pub(crate) fn catalog(help: &str, hello: Option<&Value>) -> Catalog {
    let models = hello.map(models_in).unwrap_or_default();
    Catalog {
        default_effort: None,
        commands: hello.map(commands_in).unwrap_or_default(),
        default_model: hello
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| models.first().map(|model| model.id.clone())),
        default_mode: Some(DEFAULT_PERMISSION_MODE.to_string()),
        models,
        modes: modes_in(help),
    }
}

fn models_in(hello: &Value) -> Vec<ModelInfo> {
    hello
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("value").and_then(Value::as_str)?;
            let flag = |name: &str| model.get(name).and_then(Value::as_bool).unwrap_or(false);
            Some(ModelInfo {
                id: id.to_string(),
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_window: None,
                reasoning: flag("supportsEffort") || flag("supportsAdaptiveThinking"),
                efforts: if flag("supportsEffort") {
                    model
                        .get("supportedEffortLevels")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                } else {
                    Vec::new()
                },
            })
        })
        .collect()
}

fn commands_in(hello: &Value) -> Vec<CommandInfo> {
    hello
        .get("commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            let text = |field: &str| {
                command
                    .get(field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            Some(CommandInfo {
                name: name.to_string(),
                description: text("description").map(|value| shorten(&value, 240)),
                argument_hint: text("argumentHint"),
            })
        })
        .collect()
}

fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    let cut = kept
        .rfind(['.', '。', '；', ';'])
        .map(|at| at + kept[at..].chars().next().map_or(1, char::len_utf8))
        .unwrap_or(kept.len());
    format!("{}…", kept[..cut].trim_end())
}

fn mode_listed(help: &str, mode: &str) -> bool {
    let choices = help
        .split("--permission-mode")
        .nth(1)
        .map(|rest| rest.chars().take(400).collect::<String>())
        .unwrap_or_default();
    choice_list_contains(&choices, mode)
}

fn ask_mode_in(help: &str) -> Option<&'static str> {
    let choices = help
        .split("--permission-mode")
        .nth(1)
        .map(|rest| rest.chars().take(400).collect::<String>())
        .unwrap_or_default();
    if choice_list_contains(&choices, "default") {
        Some("default")
    } else if choice_list_contains(&choices, "manual") {
        Some("manual")
    } else {
        None
    }
}

fn choice_list_contains(choices: &str, name: &str) -> bool {
    choices.match_indices(name).any(|(start, _)| {
        let before = choices[..start].chars().next_back();
        let after = choices[start + name.len()..].chars().next();
        let boundary = |character: Option<char>| {
            character.is_none_or(|character| {
                !character.is_ascii_alphanumeric() && character != '_' && character != '-'
            })
        };
        boundary(before) && boundary(after)
    })
}

fn modes_in(help: &str) -> Vec<ModeInfo> {
    let mut modes = vec![ModeInfo {
        id: DEFAULT_PERMISSION_MODE.to_string(),
        label: "Bypass permissions".to_string(),
        description: Some("Never ask about tool use".to_string()),
    }];
    if let Some(ask) = ask_mode_in(help) {
        modes.push(ModeInfo {
            id: ask.to_string(),
            label: "Default".to_string(),
            description: Some("Ask before every tool call".to_string()),
        });
    }
    for (id, label, description) in MODES {
        if id != DEFAULT_PERMISSION_MODE && mode_listed(help, id) {
            modes.push(ModeInfo {
                id: id.to_string(),
                label: label.to_string(),
                description: Some(description.to_string()),
            });
        }
    }
    modes
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

fn sub_agent_detail(
    name: &str,
    input: &Value,
    result: Option<&str>,
    sub: Option<&Sub>,
) -> ToolCallDetail {
    match (detail(name, input, result), sub) {
        (ToolCallDetail::SubAgent { agent, prompt, .. }, Some(Sub { items, .. })) => {
            ToolCallDetail::SubAgent {
                agent,
                prompt,
                items: items.clone(),
            }
        }
        (detail, _) => detail,
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

    #[test]
    fn attachments_compaction_tools_and_usage_keep_the_mainline_contract() {
        let mut driver = Driver::new(None, None);
        let prompt = driver
            .prompt(
                "turn_1",
                "inspect this".into(),
                &[
                    genehub_proto::Attachment {
                        name: "shot.png".into(),
                        mime: "image/png".into(),
                        data_base64: Some("aW1hZ2U=".into()),
                        path: None,
                    },
                    genehub_proto::Attachment {
                        name: "path-only.png".into(),
                        mime: "image/png".into(),
                        data_base64: None,
                        path: Some("/tmp/path-only.png".into()),
                    },
                ],
            )
            .unwrap();
        let prompt: Value = serde_json::from_slice(&prompt).unwrap();
        let content = prompt["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "aW1hZ2U=");

        let initialized =
            driver.line(r#"{"type":"system","subtype":"init","session_id":"claude-session"}"#);
        assert_eq!(
            initialized.persistence,
            Some(json!({ "sessionId": "claude-session" }))
        );
        let compacted = driver.line(
            r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto"}}"#,
        );
        assert!(matches!(
            compacted.events.as_slice(),
            [SessionEvent::Item { item: TimelineItem::Compaction { reason, .. }, .. }]
                if reason == "auto"
        ));

        let opened = driver.line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"printf hi","description":"Print hi"}}]}}"#,
        );
        assert!(matches!(
            opened.events.as_slice(),
            [SessionEvent::Item {
                item: TimelineItem::ToolCall {
                    status: ToolStatus::Running,
                    detail: ToolCallDetail::Overview { tool_kind: ToolKind::Shell, input, .. },
                    ..
                }, ..
            }] if input == "printf hi"
        ));
        let settled = driver.line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"hi"}]}}"#,
        );
        assert!(matches!(
            settled.events.as_slice(),
            [SessionEvent::Item {
                item: TimelineItem::ToolCall {
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Overview { output, .. },
                    ..
                }, ..
            }] if output == "hi"
        ));
        let result = driver.line(
            r#"{"type":"result","is_error":false,"usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":3,"cache_creation_input_tokens":2},"total_cost_usd":0.25}"#,
        );
        assert!(matches!(
            result.events.as_slice(),
            [SessionEvent::TurnCompleted { usage, .. }]
                if usage.input_tokens == 11
                    && usage.output_tokens == 7
                    && usage.cache_read_tokens == 3
                    && usage.cache_write_tokens == 2
                    && usage.cost_usd == Some(0.25)
        ));
    }

    #[test]
    fn thinking_interrupts_and_failures_are_not_misclassified() {
        let mut driver = Driver::new(None, None);
        driver.prompt("turn_1", "think".into(), &[]).unwrap();
        let opened = driver.line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":4,"content_block":{"type":"thinking"}}}"#);
        assert!(matches!(
            opened.events.as_slice(),
            [SessionEvent::Item {
                item: TimelineItem::Reasoning { .. },
                ..
            }]
        ));
        driver.line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":4,"delta":{"type":"thinking_delta","thinking":"carefully"}}}"#);
        let stopped = driver
            .line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":4}}"#);
        assert!(matches!(
            stopped.events.as_slice(),
            [SessionEvent::Item { item: TimelineItem::Reasoning { text, .. }, .. }]
                if text == "carefully"
        ));
        driver.interrupt().unwrap();
        let canceled = driver.line(r#"{"type":"result","is_error":true,"result":"stopped"}"#);
        assert!(matches!(
            canceled.events.as_slice(),
            [SessionEvent::TurnCanceled { .. }]
        ));

        driver.prompt("turn_2", "retry".into(), &[]).unwrap();
        let limited =
            driver.line(r#"{"type":"result","is_error":true,"errors":["429 rate limit"]}"#);
        assert!(matches!(
            limited.events.as_slice(),
            [SessionEvent::TurnFailed {
                error: TurnError {
                    code: TurnErrorCode::RateLimited,
                    ..
                },
                ..
            }]
        ));
        driver.prompt("turn_3", "retry".into(), &[]).unwrap();
        let missing =
            driver.line(r#"{"type":"result","is_error":true,"errors":["API key is missing"]}"#);
        assert!(matches!(
            missing.events.as_slice(),
            [SessionEvent::TurnFailed {
                error: TurnError {
                    code: TurnErrorCode::MissingCredentials,
                    ..
                },
                ..
            }]
        ));
    }

    #[test]
    fn always_allow_is_enforced_by_the_serializable_driver() {
        let mut driver = Driver::new(Some("default"), None);
        driver.prompt("turn_1", "hello".into(), &[]).unwrap();
        let request = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#;
        assert!(matches!(
            driver.line(request).events.as_slice(),
            [SessionEvent::PermissionRequested { .. }]
        ));
        driver
            .respond(
                "r1",
                &PermissionOutcome::Selected {
                    option_id: "allow_always".into(),
                },
            )
            .unwrap();
        let allowed = driver.line(
            r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#,
        );
        assert!(allowed.events.is_empty());
        let wire: Value = serde_json::from_slice(&allowed.writes[0]).unwrap();
        assert_eq!(wire["response"]["request_id"], "r2");
        assert_eq!(wire["response"]["response"]["behavior"], "allow");
    }

    #[test]
    fn sub_agent_steps_stay_inside_the_dispatching_card_and_survive_settlement() {
        let mut driver = Driver::new(None, None);
        driver.prompt("turn_1", "hello".into(), &[]).unwrap();

        let opened = driver.line(
            &json!({"type":"assistant","message":{"content":[{
                "type":"tool_use","id":"tool_parent","name":"Agent",
                "input":{"subagent_type":"Explore","prompt":"Find hello.txt"}
            }]}})
            .to_string(),
        );
        let nested = driver.line(
            &json!({"type":"assistant","parent_tool_use_id":"tool_parent",
            "message":{"content":[{
                "type":"tool_use","id":"tool_child","name":"Bash",
                "input":{"command":"ls /tmp","description":"List files"}
            }]}})
            .to_string(),
        );
        let settled = driver.line(
            &json!({"type":"user","parent_tool_use_id":"tool_parent",
            "message":{"content":[{
                "type":"tool_result","tool_use_id":"tool_child","content":"hello.txt"
            }]}})
            .to_string(),
        );
        let parent_done = driver.line(
            &json!({"type":"user","message":{"content":[{
                "type":"tool_result","tool_use_id":"tool_parent","content":"done"
            }]}})
            .to_string(),
        );

        for output in [&opened, &nested, &settled, &parent_done] {
            assert_eq!(output.events.len(), 1);
        }
        let ids = [&opened, &nested, &settled, &parent_done]
            .into_iter()
            .map(|output| match &output.events[0] {
                SessionEvent::Item {
                    item: TimelineItem::ToolCall { id, .. },
                    ..
                } => id.as_str(),
                other => panic!("expected one tool card, saw {other:?}"),
            })
            .collect::<Vec<_>>();
        assert!(ids.iter().all(|id| *id == ids[0]));
        match &parent_done.events[0] {
            SessionEvent::Item {
                item:
                    TimelineItem::ToolCall {
                        status: ToolStatus::Ok,
                        detail: ToolCallDetail::SubAgent { items, .. },
                        ..
                    },
                ..
            } => match items.as_slice() {
                [TimelineItem::ToolCall {
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Overview { output, .. },
                    ..
                }] => assert_eq!(output, "hello.txt"),
                other => panic!("expected one settled nested tool, saw {other:?}"),
            },
            other => panic!("expected settled sub-agent card, saw {other:?}"),
        }
    }

    #[test]
    fn catalog_uses_the_clis_aliases_efforts_commands_and_supported_modes() {
        let hello = json!({
            "model": "sonnet",
            "models": [
                {
                    "value": "sonnet",
                    "displayName": "Sonnet",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "high"]
                },
                {
                    "value": "haiku",
                    "displayName": "Haiku",
                    "supportsEffort": false,
                    "supportsAdaptiveThinking": false
                }
            ],
            "commands": [{
                "name": "review",
                "description": "Review the current change",
                "argumentHint": "[path]"
            }]
        });
        let catalog = catalog(
            "--permission-mode <mode> choices: default, acceptEdits, plan, bypassPermissions",
            Some(&hello),
        );
        assert_eq!(catalog.default_model.as_deref(), Some("sonnet"));
        assert_eq!(catalog.models[0].efforts, ["low", "high"]);
        assert!(catalog.models[0].reasoning);
        assert!(!catalog.models[1].reasoning);
        assert_eq!(catalog.commands[0].name, "review");
        assert_eq!(catalog.commands[0].argument_hint.as_deref(), Some("[path]"));
        assert_eq!(
            catalog
                .modes
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            ["bypassPermissions", "default", "acceptEdits", "plan"]
        );
    }

    #[test]
    fn unsupported_claude_modes_are_not_invented() {
        let catalog = catalog("--permission-mode <mode> choices: manual, plan", None);
        assert_eq!(
            catalog
                .modes
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            ["bypassPermissions", "manual", "plan"]
        );
    }

    #[test]
    fn old_snapshot_without_nested_sub_agents_still_restores() {
        let driver = Driver::new(Some("plan"), Some("session-1".into()));
        let mut snapshot = serde_json::to_value(driver).unwrap();
        snapshot["turn"].as_object_mut().unwrap().remove("subs");
        let restored: Driver = serde_json::from_value(snapshot).unwrap();
        assert_eq!(restored.session_id.as_deref(), Some("session-1"));
        assert!(restored.turn.subs.is_empty());
    }
}
