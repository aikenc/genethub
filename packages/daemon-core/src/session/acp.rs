//! Serializable Agent Client Protocol (ACP) client state machine.
//!
//! The platform only owns a byte-stream process. Handshake, session resume,
//! prompt framing, permissions, Cursor extensions and timeline translation
//! remain in the portable guest. Durable session state is reopened after a
//! cold Wasm replacement; live Agent processes deliberately do not survive it.

use std::collections::BTreeMap;

#[cfg(test)]
use genehub_proto::PermissionOutcome;
use genehub_proto::{
    Catalog, InteractionOption, InteractionQuestion, ItemDelta, ModeInfo, ModelInfo,
    PermissionOption, PermissionOptionKind, PermissionRequest, PermissionRequestKind, SessionEvent,
    TimelineItem, TodoEntry, TodoStatus, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode,
    Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PROTOCOL_VERSION: i64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    agent_id: String,
    cwd: String,
    next_id: i64,
    stage: Stage,
    session_id: Option<String>,
    resume_session: Option<String>,
    resume_method: Option<ResumeMethod>,
    model_config_id: Option<String>,
    mode_config_id: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    /// ACP has no standard system/developer field. Keep fixed product context
    /// separate in a leading, tagged block instead of rewriting user text.
    #[serde(default)]
    system_guidance: Option<String>,
    applied_model: bool,
    applied_mode: bool,
    pending: BTreeMap<i64, Pending>,
    interactions: BTreeMap<String, Interaction>,
    queued: Option<Prompt>,
    turn: Turn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Stage {
    Fresh,
    Initializing,
    Opening,
    Configuring,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResumeMethod {
    Resume,
    Load,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Pending {
    Initialize,
    OpenSession,
    SetModel,
    SetMode,
    Prompt { turn_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    turn_id: String,
    text: String,
    attachments: Vec<genehub_proto::Attachment>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    id: Option<String>,
    counter: u64,
    text_item: Option<String>,
    reasoning_item: Option<String>,
    interrupt_requested: bool,
    /// The announced `tool_call` frame for each live tool call, keyed by
    /// `toolCallId`. ACP sends the title, kind and locations once and then
    /// reports progress with `tool_call_update` frames that carry only the
    /// fields that changed, so the announcement has to be kept to render an
    /// update as the same tool call rather than as an anonymous one.
    #[serde(default)]
    tool_calls: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Interaction {
    upstream_id: Value,
    kind: InteractionKind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum InteractionKind {
    Permission,
    Questions,
    Plan,
}

#[derive(Default)]
pub struct LineOutput {
    pub events: Vec<SessionEvent>,
    pub writes: Vec<Vec<u8>>,
    pub persistence: Option<Value>,
}

impl Driver {
    pub fn new(
        agent_id: &str,
        cwd: String,
        resume: Option<&Value>,
        model: Option<&str>,
        mode: Option<&str>,
        system_guidance: Option<&str>,
    ) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            cwd,
            next_id: 1,
            stage: Stage::Fresh,
            session_id: None,
            resume_session: resume
                .and_then(|value| value.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::to_string),
            resume_method: None,
            model_config_id: None,
            mode_config_id: None,
            model: model.map(str::to_string),
            mode: mode.map(str::to_string),
            system_guidance: system_guidance.map(str::to_string),
            applied_model: false,
            applied_mode: false,
            pending: BTreeMap::new(),
            interactions: BTreeMap::new(),
            queued: None,
            turn: Turn::default(),
        }
    }

    pub fn prompt(
        &mut self,
        turn_id: &str,
        text: String,
        attachments: &[genehub_proto::Attachment],
    ) -> Result<Vec<Vec<u8>>, String> {
        if self.turn.id.is_some() || self.queued.is_some() {
            return Err("ACP already has a turn in flight".to_string());
        }
        self.turn = Turn {
            id: Some(turn_id.to_string()),
            ..Turn::default()
        };
        self.queued = Some(Prompt {
            turn_id: turn_id.to_string(),
            text,
            attachments: attachments.to_vec(),
        });
        match self.stage {
            Stage::Fresh => {
                self.stage = Stage::Initializing;
                Ok(vec![self.call(
                    "initialize",
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "clientCapabilities": {
                            "fs": { "readTextFile": false, "writeTextFile": false },
                            "terminal": false,
                            "session": { "configOptions": { "boolean": {} } }
                        },
                        "clientInfo": {
                            "name": "genehub-daemon",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }),
                    Pending::Initialize,
                )?])
            }
            Stage::Ready => self.start_queued().map(|write| vec![write]),
            Stage::Initializing | Stage::Opening | Stage::Configuring => Ok(Vec::new()),
        }
    }

    pub fn interrupt(&mut self) -> Result<Vec<u8>, String> {
        self.turn.interrupt_requested = true;
        for interaction in self.interactions.values() {
            // ACP requires every pending permission to be answered when the
            // enclosing prompt is canceled. The caller writes this cancel
            // notification after any explicit interaction replies.
            let _ = interaction;
        }
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| "the ACP session is not ready".to_string())?;
        encode(json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }))
    }

    pub fn set_model(&mut self, model: &str) -> Result<Option<Vec<u8>>, String> {
        self.model = Some(model.to_string());
        self.applied_model = false;
        if self.stage == Stage::Ready {
            self.stage = Stage::Configuring;
            self.configure_next()
        } else {
            Ok(None)
        }
    }

    pub fn set_mode(&mut self, mode: &str) -> Result<Option<Vec<u8>>, String> {
        self.mode = Some(mode.to_string());
        self.applied_mode = false;
        if self.stage == Stage::Ready {
            self.stage = Stage::Configuring;
            self.configure_next()
        } else {
            Ok(None)
        }
    }

    #[cfg(test)]
    pub fn respond(
        &mut self,
        request_id: &str,
        outcome: &PermissionOutcome,
    ) -> Result<Vec<u8>, String> {
        let interaction = self
            .interactions
            .remove(request_id)
            .ok_or_else(|| format!("ACP request '{request_id}' is no longer pending"))?;
        let result = match interaction.kind {
            InteractionKind::Permission => json!({ "outcome": permission_outcome(outcome) }),
            InteractionKind::Questions => cursor_question_outcome(outcome),
            InteractionKind::Plan => cursor_plan_outcome(outcome),
        };
        encode(json!({
            "jsonrpc": "2.0",
            "id": interaction.upstream_id,
            "result": result,
        }))
    }

    pub fn line(&mut self, line: &str) -> LineOutput {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return LineOutput::default();
        };
        let mut output = LineOutput::default();

        if frame.get("method").is_none() {
            if let Some(id) = frame.get("id").and_then(Value::as_i64) {
                if let Some(pending) = self.pending.remove(&id) {
                    self.response(pending, &frame, &mut output);
                }
            }
            return output;
        }

        let Some(method) = frame.get("method").and_then(Value::as_str) else {
            return output;
        };
        let params = frame.get("params").unwrap_or(&Value::Null);
        match method {
            "session/update" => self.update(params, &mut output.events),
            "session/request_permission" => self.permission(&frame, params, &mut output.events),
            "cursor/ask_question" => self.questions(&frame, params, &mut output),
            "cursor/create_plan" => self.plan(&frame, params, &mut output.events),
            "cursor/update_todos" => self.todos(params, &mut output.events),
            // These are informational notifications. Unknown *requests* must
            // be rejected so an Agent never waits forever.
            "cursor/task" | "cursor/generate_image" => {}
            _ if frame.get("id").is_some() => {
                output.writes.push(
                    encode(json!({
                        "jsonrpc": "2.0",
                        "id": frame.get("id").cloned().unwrap_or(Value::Null),
                        "error": { "code": -32601, "message": format!("method not supported: {method}") }
                    }))
                    .unwrap_or_default(),
                );
            }
            _ => {}
        }
        output
    }

    fn response(&mut self, pending: Pending, frame: &Value, output: &mut LineOutput) {
        if let Some(error) = frame.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("ACP request failed")
                .to_string();
            match pending {
                Pending::Prompt { turn_id } => {
                    self.turn = Turn::default();
                    output.events.push(SessionEvent::TurnFailed {
                        turn_id,
                        error: TurnError {
                            code: TurnErrorCode::Upstream,
                            message,
                        },
                    });
                }
                // A model or mode this Agent will not accept is a preference
                // we cannot honour, not a broken session. Agents revise their
                // model list between releases, so treating the refusal as a
                // handshake failure would make every later turn of a session
                // that remembers a retired model fail before it starts. The
                // Agent keeps its own default and the prompt still runs.
                Pending::SetModel => {
                    self.applied_model = true;
                    self.continue_configuring(output);
                }
                Pending::SetMode => {
                    self.applied_mode = true;
                    self.continue_configuring(output);
                }
                Pending::Initialize | Pending::OpenSession => self.fail_handshake(message, output),
            }
            return;
        }
        let result = frame.get("result").cloned().unwrap_or(Value::Null);
        match pending {
            Pending::Initialize => {
                self.resume_method = resume_method_in(&result);
                self.stage = Stage::Opening;
                let (method, params) = match (&self.resume_session, self.resume_method) {
                    (Some(session_id), Some(ResumeMethod::Resume)) => (
                        "session/resume",
                        json!({ "sessionId": session_id, "cwd": self.cwd, "mcpServers": [] }),
                    ),
                    (Some(session_id), Some(ResumeMethod::Load)) => (
                        "session/load",
                        json!({ "sessionId": session_id, "cwd": self.cwd, "mcpServers": [] }),
                    ),
                    _ => ("session/new", json!({ "cwd": self.cwd, "mcpServers": [] })),
                };
                match self.call(method, params, Pending::OpenSession) {
                    Ok(write) => output.writes.push(write),
                    Err(error) => self.fail_handshake(error, output),
                }
            }
            Pending::OpenSession => {
                let session_id = result
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| self.resume_session.clone());
                let Some(session_id) = session_id else {
                    self.fail_handshake("session/new returned no sessionId".to_string(), output);
                    return;
                };
                self.session_id = Some(session_id.clone());
                self.model_config_id = config_id_for_category(&result, "model");
                self.mode_config_id = config_id_for_category(&result, "mode");
                self.stage = Stage::Configuring;
                output.persistence = Some(json!({ "sessionId": session_id }));
                match self.configure_next() {
                    Ok(Some(write)) => output.writes.push(write),
                    Ok(None) => self.ready(output),
                    Err(error) => self.fail_handshake(error, output),
                }
            }
            Pending::SetModel => {
                self.applied_model = true;
                self.continue_configuring(output);
            }
            Pending::SetMode => {
                self.applied_mode = true;
                self.continue_configuring(output);
            }
            Pending::Prompt { turn_id } => {
                let canceled = matches!(
                    result.get("stopReason").and_then(Value::as_str),
                    Some("cancelled" | "canceled")
                ) || self.turn.interrupt_requested;
                let refusal = result.get("stopReason").and_then(Value::as_str) == Some("refusal");
                self.turn = Turn::default();
                if canceled {
                    output.events.push(SessionEvent::TurnCanceled { turn_id });
                } else if refusal {
                    output.events.push(SessionEvent::TurnFailed {
                        turn_id,
                        error: TurnError {
                            code: TurnErrorCode::Upstream,
                            message: "The ACP agent declined this request.".to_string(),
                        },
                    });
                } else {
                    output.events.push(SessionEvent::TurnCompleted {
                        turn_id,
                        usage: Usage::default(),
                        fork_checkpoint: None,
                    });
                }
            }
        }
    }

    /// Sends the next configuration call, or opens the session for prompting
    /// once there is nothing left to configure.
    fn continue_configuring(&mut self, output: &mut LineOutput) {
        match self.configure_next() {
            Ok(Some(write)) => output.writes.push(write),
            Ok(None) => self.ready(output),
            Err(error) => self.fail_handshake(error, output),
        }
    }

    fn configure_next(&mut self) -> Result<Option<Vec<u8>>, String> {
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| "the ACP session is not ready".to_string())?;
        if !self.applied_model {
            if let Some(model) = self.model.clone() {
                let config_id = self
                    .model_config_id
                    .clone()
                    .unwrap_or_else(|| "model".to_string());
                return self
                    .call(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": config_id, "value": model }),
                        Pending::SetModel,
                    )
                    .map(Some);
            }
            self.applied_model = true;
        }
        if !self.applied_mode {
            if let Some(mode) = self.mode.clone() {
                let (method, params) = match self.mode_config_id.clone() {
                    Some(config_id) => (
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": config_id, "value": mode }),
                    ),
                    None => (
                        "session/set_mode",
                        json!({ "sessionId": session_id, "modeId": mode }),
                    ),
                };
                return self.call(method, params, Pending::SetMode).map(Some);
            }
            self.applied_mode = true;
        }
        Ok(None)
    }

    fn ready(&mut self, output: &mut LineOutput) {
        self.stage = Stage::Ready;
        if self.queued.is_some() {
            match self.start_queued() {
                Ok(write) => output.writes.push(write),
                Err(error) => self.fail_handshake(error, output),
            }
        }
    }

    fn start_queued(&mut self) -> Result<Vec<u8>, String> {
        let prompt = self
            .queued
            .take()
            .ok_or_else(|| "there is no queued ACP prompt".to_string())?;
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| "the ACP session is not ready".to_string())?;
        let blocks = prompt_blocks(
            &prompt.text,
            &prompt.attachments,
            self.system_guidance.as_deref(),
        );
        self.call(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": blocks }),
            Pending::Prompt {
                turn_id: prompt.turn_id,
            },
        )
    }

    fn fail_handshake(&mut self, message: String, output: &mut LineOutput) {
        let turn_id = self
            .turn
            .id
            .take()
            .or_else(|| self.queued.take().map(|value| value.turn_id));
        self.stage = Stage::Fresh;
        self.pending.clear();
        if let Some(turn_id) = turn_id {
            output.events.push(SessionEvent::TurnFailed {
                turn_id,
                error: TurnError {
                    code: TurnErrorCode::AgentCrashed,
                    message,
                },
            });
        }
    }

    fn call(&mut self, method: &str, params: Value, pending: Pending) -> Result<Vec<u8>, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.pending.insert(id, pending);
        encode(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }

    fn permission(&mut self, frame: &Value, params: &Value, events: &mut Vec<SessionEvent>) {
        let Some(upstream_id) = frame.get("id").cloned() else {
            return;
        };
        let id = request_key(&upstream_id);
        let tool = params.get("toolCall").unwrap_or(&Value::Null);
        let request = PermissionRequest {
            id: id.clone(),
            kind: PermissionRequestKind::Permission,
            title: tool
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("The agent is asking for permission")
                .to_string(),
            detail: permission_detail(tool),
            tool_call_id: tool
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string),
            options: permission_options(params),
            questions: None,
        };
        self.interactions.insert(
            id,
            Interaction {
                upstream_id,
                kind: InteractionKind::Permission,
            },
        );
        events.push(SessionEvent::PermissionRequested { request });
    }

    fn questions(&mut self, frame: &Value, params: &Value, output: &mut LineOutput) {
        let Some(upstream_id) = frame.get("id").cloned() else {
            return;
        };
        let raw = params.get("questions").and_then(Value::as_array);
        let questions = raw
            .into_iter()
            .flatten()
            .filter_map(|question| {
                Some(InteractionQuestion {
                    id: question.get("id")?.as_str()?.to_string(),
                    prompt: question.get("prompt")?.as_str()?.to_string(),
                    allow_multiple: question
                        .get("allowMultiple")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    allow_freeform: true,
                    options: question
                        .get("options")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|option| {
                            Some(InteractionOption {
                                id: option.get("id")?.as_str()?.to_string(),
                                label: option.get("label")?.as_str()?.to_string(),
                            })
                        })
                        .collect(),
                })
            })
            .collect::<Vec<_>>();
        if questions.is_empty() {
            output.writes.push(
                encode(json!({
                    "jsonrpc": "2.0",
                    "id": upstream_id,
                    "error": { "code": -32602, "message": "Cursor question request has no valid questions" }
                }))
                .unwrap_or_default(),
            );
            return;
        }
        let id = request_key(&upstream_id);
        self.interactions.insert(
            id.clone(),
            Interaction {
                upstream_id,
                kind: InteractionKind::Questions,
            },
        );
        output.events.push(SessionEvent::PermissionRequested {
            request: PermissionRequest {
                id,
                kind: PermissionRequestKind::Question,
                title: params
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Clarifying questions")
                    .to_string(),
                detail: None,
                tool_call_id: params
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                options: Vec::new(),
                questions: Some(questions),
            },
        });
    }

    fn plan(&mut self, frame: &Value, params: &Value, events: &mut Vec<SessionEvent>) {
        let Some(upstream_id) = frame.get("id").cloned() else {
            return;
        };
        let id = request_key(&upstream_id);
        self.interactions.insert(
            id.clone(),
            Interaction {
                upstream_id,
                kind: InteractionKind::Plan,
            },
        );
        let detail = [
            params.get("overview").and_then(Value::as_str),
            params.get("plan").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        events.push(SessionEvent::PermissionRequested {
            request: PermissionRequest {
                id,
                kind: PermissionRequestKind::PlanApproval,
                title: params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Implementation plan")
                    .to_string(),
                detail: (!detail.is_empty()).then_some(detail),
                tool_call_id: params
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                options: vec![
                    PermissionOption {
                        id: "accept".to_string(),
                        label: "Approve and continue".to_string(),
                        kind: PermissionOptionKind::AllowOnce,
                    },
                    PermissionOption {
                        id: "reject".to_string(),
                        label: "Reject plan".to_string(),
                        kind: PermissionOptionKind::Reject,
                    },
                ],
                questions: None,
            },
        });
    }

    fn todos(&self, params: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        let items = todo_entries(params.get("todos"));
        events.push(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: TimelineItem::Todo {
                id: format!("{turn_id}-cursor-todos"),
                items,
            },
        });
    }

    fn update(&mut self, params: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        let update = params.get("update").unwrap_or(&Value::Null);
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "agent_message_chunk" => {
                let delta = content_text(update);
                match self.turn.text_item.clone() {
                    Some(item_id) => events.push(SessionEvent::ItemDelta {
                        turn_id,
                        item_id,
                        delta: ItemDelta::Text { delta },
                    }),
                    None => {
                        let id = self.next_item_id();
                        self.turn.text_item = Some(id.clone());
                        self.turn.reasoning_item = None;
                        events.push(SessionEvent::Item {
                            turn_id,
                            item: TimelineItem::AssistantMessage { id, text: delta },
                        });
                    }
                }
            }
            "agent_thought_chunk" => {
                let delta = content_text(update);
                match self.turn.reasoning_item.clone() {
                    Some(item_id) => events.push(SessionEvent::ItemDelta {
                        turn_id,
                        item_id,
                        delta: ItemDelta::Text { delta },
                    }),
                    None => {
                        let id = self.next_item_id();
                        self.turn.reasoning_item = Some(id.clone());
                        self.turn.text_item = None;
                        events.push(SessionEvent::Item {
                            turn_id,
                            item: TimelineItem::Reasoning { id, text: delta },
                        });
                    }
                }
            }
            "tool_call" | "tool_call_update" => {
                self.turn.text_item = None;
                self.turn.reasoning_item = None;
                let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return;
                };
                let merged = self.merge_tool_call(id, update);
                events.push(SessionEvent::Item {
                    turn_id,
                    item: TimelineItem::ToolCall {
                        id: id.to_string(),
                        name: merged
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                        status: match merged.get("status").and_then(Value::as_str) {
                            Some("in_progress") => ToolStatus::Running,
                            Some("completed") => ToolStatus::Ok,
                            Some("failed") => ToolStatus::Error,
                            _ => ToolStatus::Pending,
                        },
                        detail: detail_from_update(&merged),
                    },
                });
            }
            "plan" => events.push(SessionEvent::Item {
                turn_id: turn_id.clone(),
                item: TimelineItem::Todo {
                    id: format!("{turn_id}-plan"),
                    items: todo_entries(update.get("entries")),
                },
            }),
            "current_mode_update" => {
                if let Some(mode_id) = update.get("currentModeId").and_then(Value::as_str) {
                    events.push(SessionEvent::ModeChanged {
                        mode_id: mode_id.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    /// Folds one `tool_call`/`tool_call_update` frame into what is already
    /// known about that tool call and returns the whole picture.
    ///
    /// Every field an update omits keeps the value the announcement gave it,
    /// so a status-only update no longer erases the title, kind and locations
    /// that decide how the call is rendered. Fields the update does carry win,
    /// because ACP sends the complete replacement value for each of them.
    fn merge_tool_call(&mut self, id: &str, update: &Value) -> Value {
        let entry = self
            .turn
            .tool_calls
            .entry(id.to_string())
            .or_insert_with(|| json!({}));
        if let (Some(target), Some(fields)) = (entry.as_object_mut(), update.as_object()) {
            for (key, value) in fields {
                target.insert(key.clone(), value.clone());
            }
        }
        entry.clone()
    }

    fn next_item_id(&mut self) -> String {
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

fn prompt_blocks(
    text: &str,
    attachments: &[genehub_proto::Attachment],
    system_guidance: Option<&str>,
) -> Vec<Value> {
    let mut blocks = Vec::new();
    if let Some(guidance) = system_guidance.filter(|value| !value.trim().is_empty()) {
        blocks.push(json!({ "type": "text", "text": guidance }));
    }
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for attachment in attachments {
        if let Some(data) = attachment
            .data_base64
            .as_deref()
            .filter(|_| attachment.mime.starts_with("image/"))
        {
            blocks.push(json!({
                "type": "image",
                "mimeType": attachment.mime,
                "data": data,
            }));
        }
    }
    blocks
}

/// Parses the standard ACP `session/new` discovery surface. Newer Agents use
/// `models`/`modes`; older ones expose equivalent select config options.
pub(crate) fn catalog(result: Option<&Value>) -> Catalog {
    let Some(result) = result else {
        return Catalog::default();
    };
    let (models, default_model) = models_in(result);
    let (modes, default_mode) = modes_in(result);
    Catalog {
        models,
        modes,
        commands: Vec::new(),
        default_model,
        default_mode,
        default_effort: None,
    }
}

fn config_options_in(result: &Value) -> Option<&Vec<Value>> {
    result.get("configOptions").and_then(Value::as_array)
}

fn find_select_config_option<'a>(
    config_options: Option<&'a Vec<Value>>,
    category: &str,
) -> Option<&'a Value> {
    config_options?.iter().find(|entry| {
        entry.get("type").and_then(Value::as_str) == Some("select")
            && entry.get("category").and_then(Value::as_str) == Some(category)
    })
}

fn flatten_select_options(options: &[Value]) -> Vec<(String, String, Option<String>)> {
    let mut flat = Vec::new();
    for option in options {
        if let Some(value) = option.get("value").and_then(Value::as_str) {
            flat.push((
                value.to_string(),
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(value)
                    .to_string(),
                option
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ));
            continue;
        }
        let group = option.get("group").and_then(Value::as_str);
        for choice in option
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(value) = choice.get("value").and_then(Value::as_str) else {
                continue;
            };
            flat.push((
                value.to_string(),
                choice
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(value)
                    .to_string(),
                choice
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| group.map(str::to_string)),
            ));
        }
    }
    flat
}

fn models_in(result: &Value) -> (Vec<ModelInfo>, Option<String>) {
    if let Some(models) = result.get("models") {
        let current = models
            .get("currentModelId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(available) = models
            .get("availableModels")
            .and_then(Value::as_array)
            .filter(|available| !available.is_empty())
        {
            return (
                available
                    .iter()
                    .filter_map(|model| {
                        let id = model.get("modelId")?.as_str()?;
                        Some(ModelInfo {
                            id: id.to_string(),
                            label: model
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_string(),
                            context_window: None,
                            reasoning: false,
                            efforts: Vec::new(),
                        })
                    })
                    .collect(),
                current,
            );
        }
    }
    let option = find_select_config_option(config_options_in(result), "model");
    let current = option
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let choices = option
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    (
        flatten_select_options(choices)
            .into_iter()
            .map(|(id, label, _)| ModelInfo {
                id,
                label,
                context_window: None,
                reasoning: false,
                efforts: Vec::new(),
            })
            .collect(),
        current,
    )
}

fn modes_in(result: &Value) -> (Vec<ModeInfo>, Option<String>) {
    if let Some(modes) = result.get("modes") {
        let current = modes
            .get("currentModeId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(available) = modes
            .get("availableModes")
            .and_then(Value::as_array)
            .filter(|available| !available.is_empty())
        {
            return (
                available
                    .iter()
                    .filter_map(|mode| {
                        let id = mode.get("id")?.as_str()?;
                        Some(ModeInfo {
                            id: id.to_string(),
                            label: mode
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_string(),
                            description: mode
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        })
                    })
                    .collect(),
                current,
            );
        }
    }
    let option = find_select_config_option(config_options_in(result), "mode");
    let current = option
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let choices = option
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    (
        flatten_select_options(choices)
            .into_iter()
            .map(|(id, label, description)| ModeInfo {
                id,
                label,
                description,
            })
            .collect(),
        current,
    )
}

fn resume_method_in(value: &Value) -> Option<ResumeMethod> {
    let capabilities = value.get("agentCapabilities")?;
    if capabilities
        .get("sessionCapabilities")
        .and_then(|value| value.get("resume"))
        .is_some()
    {
        Some(ResumeMethod::Resume)
    } else if capabilities
        .get("loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Some(ResumeMethod::Load)
    } else {
        None
    }
}

fn config_id_for_category(value: &Value, category: &str) -> Option<String> {
    find_select_config_option(config_options_in(value), category)?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

fn request_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn permission_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|option| PermissionOption {
            id: option
                .get("optionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            label: option
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Continue")
                .to_string(),
            kind: match option.get("kind").and_then(Value::as_str) {
                Some("allow_always") => PermissionOptionKind::AllowAlways,
                Some("reject_once" | "reject_always") => PermissionOptionKind::Reject,
                _ => PermissionOptionKind::AllowOnce,
            },
        })
        .collect()
}

fn permission_detail(tool: &Value) -> Option<String> {
    if let Some(raw) = tool.get("rawInput").filter(|value| !value.is_null()) {
        if let Ok(value) = serde_json::to_string_pretty(raw) {
            return Some(value);
        }
    }
    let content = tool
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            block
                .get("content")
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .or_else(|| block.get("text").and_then(Value::as_str))
        })
        .collect::<Vec<_>>();
    if !content.is_empty() {
        return Some(content.join("\n"));
    }
    let paths = tool
        .get("locations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.get("path").and_then(Value::as_str))
        .collect::<Vec<_>>();
    (!paths.is_empty()).then(|| paths.join("\n"))
}

#[cfg(test)]
fn permission_outcome(outcome: &PermissionOutcome) -> Value {
    match outcome {
        PermissionOutcome::Selected { option_id } => {
            json!({ "outcome": "selected", "optionId": option_id })
        }
        _ => json!({ "outcome": "cancelled" }),
    }
}

#[cfg(test)]
fn cursor_question_outcome(outcome: &PermissionOutcome) -> Value {
    match outcome {
        PermissionOutcome::Answered { answers } => json!({ "outcome": {
            "outcome": "answered",
            "answers": answers.iter().map(|answer| json!({
                "questionId": answer.question_id,
                "selectedOptionIds": answer.selected_option_ids,
                "freeformText": answer.freeform_text,
            })).collect::<Vec<_>>()
        }}),
        _ => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

#[cfg(test)]
fn cursor_plan_outcome(outcome: &PermissionOutcome) -> Value {
    match outcome {
        PermissionOutcome::Selected { option_id } if option_id == "accept" => {
            json!({ "outcome": { "outcome": "accepted" } })
        }
        PermissionOutcome::Selected { .. } => {
            json!({ "outcome": { "outcome": "rejected", "reason": "Rejected by the user" } })
        }
        _ => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

fn content_text(value: &Value) -> String {
    value
        .get("content")
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn todo_entries(value: Option<&Value>) -> Vec<TodoEntry> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| TodoEntry {
            text: entry
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            status: match entry.get("status").and_then(Value::as_str) {
                Some("in_progress") => TodoStatus::InProgress,
                Some("completed") => TodoStatus::Completed,
                _ => TodoStatus::Pending,
            },
        })
        .collect()
}

fn detail_from_update(update: &Value) -> ToolCallDetail {
    let kind = update
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("other");
    // `locations` is the declared place for the file a call touches, but an
    // Agent that reports a diff carries the path on the diff block instead and
    // sends no locations at all. Without the fallback such an edit renders as
    // a diff belonging to no file.
    let path = update
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .and_then(|value| value.get("path"))
        .or_else(|| {
            update
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find_map(|block| block.get("path"))
        })
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let content = update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            block
                .get("content")
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .or_else(|| block.get("newText").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("\n");
    match kind {
        "execute" => ToolCallDetail::Shell {
            command: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            output: content,
            exit_code: None,
        },
        "read" => ToolCallDetail::Read {
            path,
            content,
            truncated: false,
        },
        "edit" => ToolCallDetail::Edit {
            path,
            diff: content,
        },
        "search" => ToolCallDetail::Search {
            query: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            matches: Vec::new(),
        },
        "fetch" => ToolCallDetail::Fetch {
            url: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            summary: content,
        },
        _ => ToolCallDetail::Unknown {
            raw: update.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(id: i64, result: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
    }

    #[test]
    fn product_guidance_is_a_separate_leading_block() {
        let blocks = prompt_blocks(
            "the user's exact request",
            &[],
            Some("<genehub_system_guidance>fixed</genehub_system_guidance>"),
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0],
            json!({
                "type": "text",
                "text": "<genehub_system_guidance>fixed</genehub_system_guidance>"
            })
        );
        assert_eq!(
            blocks[1],
            json!({ "type": "text", "text": "the user's exact request" })
        );
    }

    #[test]
    fn handshake_resume_configuration_and_prompt_are_serialized() {
        let mut driver = Driver::new(
            "cursor",
            "/work".to_string(),
            Some(&json!({ "sessionId": "remote-1" })),
            Some("composer"),
            Some("agent"),
            None,
        );
        let writes = driver.prompt("turn-1", "hello".to_string(), &[]).unwrap();
        assert!(String::from_utf8_lossy(&writes[0]).contains("initialize"));

        let initialized = driver.line(&response(
            1,
            json!({ "agentCapabilities": { "sessionCapabilities": { "resume": {} } } }),
        ));
        assert!(String::from_utf8_lossy(&initialized.writes[0]).contains("session/resume"));

        let opened = driver.line(&response(
            2,
            json!({
                "configOptions": [
                    {"type":"select","category":"model","id":"model"},
                    {"type":"select","category":"mode","id":"mode"}
                ]
            }),
        ));
        assert_eq!(opened.persistence, Some(json!({"sessionId":"remote-1"})));
        assert!(String::from_utf8_lossy(&opened.writes[0]).contains("set_config_option"));
        let model = driver.line(&response(3, json!({})));
        assert!(String::from_utf8_lossy(&model.writes[0]).contains("\"value\":\"agent\""));
        let mode = driver.line(&response(4, json!({})));
        assert!(String::from_utf8_lossy(&mode.writes[0]).contains("session/prompt"));
    }

    /// The frame sequence below is the one `cursor-agent acp` really sends for
    /// a file edit: one `tool_call` carrying the title and kind, then updates
    /// that carry only the status and the diff.
    #[test]
    fn a_tool_call_update_keeps_the_identity_the_announcement_gave_it() {
        let mut driver = Driver::new("cursor", "/work".into(), None, None, None, None);
        driver.turn.id = Some("turn-1".into());

        let announced = driver.line(
            &json!({"jsonrpc":"2.0","method":"session/update","params":{"update":{
                "sessionUpdate":"tool_call","toolCallId":"call-1","title":"Edit File",
                "kind":"edit","status":"pending","rawInput":{}
            }}})
            .to_string(),
        );
        assert!(matches!(
            announced.events.first(),
            Some(SessionEvent::Item { item: TimelineItem::ToolCall { name, status, .. }, .. })
                if name == "Edit File" && *status == ToolStatus::Pending
        ));

        let running = driver.line(
            &json!({"jsonrpc":"2.0","method":"session/update","params":{"update":{
                "sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"in_progress"
            }}})
            .to_string(),
        );
        assert!(
            matches!(
                running.events.first(),
                Some(SessionEvent::Item { item: TimelineItem::ToolCall { name, status, detail, .. }, .. })
                    if name == "Edit File"
                        && *status == ToolStatus::Running
                        && matches!(detail, ToolCallDetail::Edit { .. })
            ),
            "a status-only update must not turn the call anonymous; got {:?}",
            running.events.first()
        );

        let completed = driver.line(
            &json!({"jsonrpc":"2.0","method":"session/update","params":{"update":{
                "sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed",
                "content":[{"type":"diff","path":"/work/ping.txt","newText":"pong"}]
            }}})
            .to_string(),
        );
        let Some(SessionEvent::Item {
            item:
                TimelineItem::ToolCall {
                    name,
                    status,
                    detail,
                    ..
                },
            ..
        }) = completed.events.first()
        else {
            panic!("the completion is a tool call: {:?}", completed.events);
        };
        assert_eq!(name, "Edit File");
        assert_eq!(*status, ToolStatus::Ok);
        assert!(
            matches!(detail, ToolCallDetail::Edit { path, diff }
                if path == "/work/ping.txt" && diff == "pong"),
            "the diff belongs to the edit the announcement described; got {detail:?}"
        );
    }

    /// Agents drop models between releases, so a session that remembers a
    /// retired one must still be able to talk.
    #[test]
    fn a_refused_model_leaves_the_session_usable() {
        let mut driver = Driver::new(
            "cursor",
            "/work".to_string(),
            None,
            Some("a-model-this-agent-retired"),
            None,
            None,
        );
        driver.prompt("turn-1", "hello".to_string(), &[]).unwrap();
        driver.line(&response(1, json!({})));
        let opened = driver.line(&response(
            2,
            json!({
                "sessionId": "remote-1",
                "configOptions": [{"type":"select","category":"model","id":"model"}]
            }),
        ));
        assert!(String::from_utf8_lossy(&opened.writes[0]).contains("set_config_option"));

        let refused = driver.line(
            &json!({"jsonrpc":"2.0","id":3,"error":{
                "code":-32602,"message":"Invalid params",
                "data":{"message":"Invalid model value: a-model-this-agent-retired"}
            }})
            .to_string(),
        );
        assert!(
            refused.events.is_empty(),
            "refusing a model preference is not a failed turn; got {:?}",
            refused.events
        );
        assert!(
            String::from_utf8_lossy(&refused.writes[0]).contains("session/prompt"),
            "the prompt still runs on the Agent's own default; got {:?}",
            refused.writes.first().map(|w| String::from_utf8_lossy(w))
        );
    }

    #[test]
    fn permission_and_cursor_question_responses_preserve_wire_ids() {
        let mut driver = Driver::new("cursor", "/work".into(), None, None, None, None);
        driver.turn.id = Some("turn-1".into());
        let permission = driver.line(
            &json!({
                "jsonrpc":"2.0","id":41,"method":"session/request_permission",
                "params":{"toolCall":{"toolCallId":"t","title":"Write"},"options":[
                    {"optionId":"allow-once","name":"Allow","kind":"allow_once"}
                ]}
            })
            .to_string(),
        );
        assert!(matches!(
            permission.events.first(),
            Some(SessionEvent::PermissionRequested { request }) if request.id == "41"
        ));
        let reply = driver
            .respond(
                "41",
                &PermissionOutcome::Selected {
                    option_id: "allow-once".into(),
                },
            )
            .unwrap();
        let reply: Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(reply["id"], json!(41));
        assert_eq!(reply["result"]["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn streamed_text_tools_and_completion_form_one_turn() {
        let mut driver = Driver::new("cursor", "/work".into(), None, None, None, None);
        driver.turn.id = Some("turn-1".into());
        driver.pending.insert(
            9,
            Pending::Prompt {
                turn_id: "turn-1".into(),
            },
        );
        let text = driver.line(
            &json!({"method":"session/update","params":{"update":{
                "sessionUpdate":"agent_message_chunk","content":{"text":"hello"}
            }}})
            .to_string(),
        );
        assert!(matches!(
            text.events.first(),
            Some(SessionEvent::Item { item: TimelineItem::AssistantMessage { text, .. }, .. }) if text == "hello"
        ));
        let done = driver.line(&response(9, json!({"stopReason":"end_turn"})));
        assert!(matches!(
            done.events.first(),
            Some(SessionEvent::TurnCompleted { turn_id, .. }) if turn_id == "turn-1"
        ));
    }

    #[test]
    fn catalog_reads_native_acp_models_modes_and_defaults() {
        let result = json!({
            "models": {
                "currentModelId": "sonnet",
                "availableModels": [
                    {"modelId":"sonnet","name":"Sonnet"},
                    {"modelId":"opus","name":"Opus"}
                ]
            },
            "modes": {
                "currentModeId": "agent",
                "availableModes": [
                    {"id":"agent","name":"Agent","description":"Act autonomously"},
                    {"id":"ask","name":"Ask"}
                ]
            }
        });
        let catalog = catalog(Some(&result));
        assert_eq!(catalog.default_model.as_deref(), Some("sonnet"));
        assert_eq!(catalog.default_mode.as_deref(), Some("agent"));
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(
            catalog.modes[0].description.as_deref(),
            Some("Act autonomously")
        );
    }

    #[test]
    fn catalog_falls_back_to_grouped_select_config_options() {
        let result = json!({"configOptions":[
            {
                "id":"model-choice","type":"select","category":"model",
                "currentValue":"composer","options":[
                    {"group":"Cursor","options":[
                        {"value":"composer","name":"Composer"},
                        {"value":"fast","name":"Fast","description":"Quick replies"}
                    ]}
                ]
            },
            {
                "id":"mode-choice","type":"select","category":"mode",
                "currentValue":"agent","options":[
                    {"value":"agent","name":"Agent","description":"Write code"}
                ]
            }
        ]});
        let catalog = catalog(Some(&result));
        assert_eq!(catalog.default_model.as_deref(), Some("composer"));
        assert_eq!(catalog.models[0].label, "Composer");
        assert_eq!(catalog.models[0].id, "composer");
        assert_eq!(catalog.modes[0].description.as_deref(), Some("Write code"));
    }

    #[test]
    fn resume_attachment_and_unknown_request_contracts_survive_porting() {
        assert_eq!(
            resume_method_in(&json!({
                "agentCapabilities": {
                    "sessionCapabilities": { "resume": {} },
                    "loadSession": true
                }
            })),
            Some(ResumeMethod::Resume)
        );
        assert_eq!(
            resume_method_in(&json!({
                "agentCapabilities": { "loadSession": true }
            })),
            Some(ResumeMethod::Load)
        );

        let blocks = prompt_blocks(
            "look",
            &[
                genehub_proto::Attachment {
                    name: "shot.png".into(),
                    mime: "image/png".into(),
                    path: None,
                    data_base64: Some("Zm9v".into()),
                },
                genehub_proto::Attachment {
                    name: "path-only.png".into(),
                    mime: "image/png".into(),
                    path: Some("/tmp/path-only.png".into()),
                    data_base64: None,
                },
            ],
            None,
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert_eq!(blocks[1]["data"], "Zm9v");

        let mut driver = Driver::new("cursor", "/work".into(), None, None, None, None);
        let unknown =
            driver.line(r#"{"jsonrpc":"2.0","id":"opaque","method":"future/method","params":{}}"#);
        let reply: Value = serde_json::from_slice(&unknown.writes[0]).unwrap();
        assert_eq!(reply["id"], "opaque");
        assert_eq!(reply["error"]["code"], -32601);

        let malformed = driver.line(
            r#"{"jsonrpc":"2.0","id":9,"method":"cursor/ask_question","params":{"questions":[{"id":"q","options":[]}]}}"#,
        );
        assert!(malformed.events.is_empty());
        let reply: Value = serde_json::from_slice(&malformed.writes[0]).unwrap();
        assert_eq!(reply["error"]["code"], -32602);
    }

    #[test]
    fn permission_details_plans_todos_and_turn_scope_remain_structured() {
        assert_eq!(
            permission_detail(&json!({ "rawInput": { "command": "rm -rf build" } })),
            Some("{\n  \"command\": \"rm -rf build\"\n}".into())
        );
        assert_eq!(
            permission_detail(&json!({
                "content": [{ "content": { "text": "first" } }, { "text": "second" }]
            })),
            Some("first\nsecond".into())
        );
        assert_eq!(
            permission_detail(&json!({
                "locations": [{ "path": "src/a.rs" }, { "path": "src/b.rs" }]
            })),
            Some("src/a.rs\nsrc/b.rs".into())
        );

        let mut driver = Driver::new("cursor", "/work".into(), None, None, None, None);
        let outside = driver.line(
            r#"{"method":"cursor/update_todos","params":{"todos":[{"content":"x","status":"in_progress"}]}}"#,
        );
        assert!(outside.events.is_empty());
        driver.turn.id = Some("turn-1".into());
        let todos = driver.line(
            r#"{"method":"cursor/update_todos","params":{"todos":[{"content":"x","status":"in_progress"}]}}"#,
        );
        assert!(matches!(
            &todos.events[0],
            SessionEvent::Item {
                item: TimelineItem::Todo { items, .. },
                ..
            } if items[0].status == TodoStatus::InProgress
        ));

        let plan = driver.line(
            r#"{"jsonrpc":"2.0","id":"plan-1","method":"cursor/create_plan","params":{"name":"Implement","overview":"why","plan":"how"}}"#,
        );
        assert!(matches!(
            &plan.events[0],
            SessionEvent::PermissionRequested { request }
                if request.kind == PermissionRequestKind::PlanApproval
                    && request.detail.as_deref() == Some("why\n\nhow")
        ));
        let accepted = driver
            .respond(
                "plan-1",
                &PermissionOutcome::Selected {
                    option_id: "accept".into(),
                },
            )
            .unwrap();
        let accepted: Value = serde_json::from_slice(&accepted).unwrap();
        assert_eq!(accepted["id"], "plan-1");
        assert_eq!(accepted["result"]["outcome"]["outcome"], "accepted");
    }

    #[test]
    fn old_snapshot_without_product_guidance_still_restores() {
        let driver = Driver::new(
            "cursor",
            "/work".into(),
            Some(&json!({ "sessionId": "remote-1" })),
            Some("composer"),
            Some("agent"),
            Some("fixed guidance"),
        );
        let mut snapshot = serde_json::to_value(driver).unwrap();
        snapshot.as_object_mut().unwrap().remove("systemGuidance");
        let restored: Driver = serde_json::from_value(snapshot).unwrap();
        assert_eq!(restored.resume_session.as_deref(), Some("remote-1"));
        assert!(restored.system_guidance.is_none());
    }
}
