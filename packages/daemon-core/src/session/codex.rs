//! Serializable Codex app-server JSON-RPC state machine.

use std::collections::{BTreeMap, HashSet};

use genehub_proto::PermissionOutcome;
use genehub_proto::{
    Catalog, InteractionOption, InteractionQuestion, ItemDelta, ModeInfo, ModelInfo,
    PermissionOption, PermissionOptionKind, PermissionRequest, PermissionRequestKind, SessionEvent,
    TimelineItem, TodoEntry, TodoStatus, ToolCallDetail, ToolStatus, TurnError, TurnErrorCode,
    Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CLIENT_NAME: &str = "codex_app_server_daemon";
const DEFAULT_MODE: &str = "full-access";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    next_id: i64,
    stage: Stage,
    thread: Option<String>,
    resume_thread: Option<String>,
    fork_checkpoint: Option<String>,
    mode: String,
    model: Option<String>,
    effort: Option<String>,
    #[serde(default)]
    developer_instructions: Option<String>,
    pending: BTreeMap<i64, Pending>,
    asks: BTreeMap<String, PendingAsk>,
    queued: Option<Prompt>,
    turn: Turn,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Stage {
    Fresh,
    Initializing,
    Opening,
    Ready,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Pending {
    Initialize,
    OpenThread,
    UnarchiveThread,
    StartTurn { turn_id: String },
    Interrupt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    turn_id: String,
    text: String,
    image_paths: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    id: Option<String>,
    upstream_id: Option<String>,
    open: HashSet<String>,
    usage: Usage,
    interrupt_requested: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAsk {
    upstream_id: Value,
    response: Ask,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Ask {
    Decision,
    Questions { questions: Vec<Question> },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Question {
    id: String,
    header: String,
    prompt: String,
    options: Vec<(String, String)>,
}

#[derive(Default)]
pub struct LineOutput {
    pub events: Vec<SessionEvent>,
    pub writes: Vec<Vec<u8>>,
    pub persistence: Option<Value>,
}

impl Driver {
    pub fn new(
        resume: Option<&Value>,
        mode: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        developer_instructions: Option<&str>,
    ) -> Self {
        let resume_thread = resume
            .and_then(|value| value.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let fork_checkpoint = resume
            .and_then(|value| value.get("forkCheckpoint"))
            .and_then(Value::as_str)
            .map(str::to_string);
        Self {
            next_id: 1,
            stage: Stage::Fresh,
            thread: None,
            resume_thread,
            fork_checkpoint,
            mode: mode.unwrap_or(DEFAULT_MODE).to_string(),
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            developer_instructions: developer_instructions.map(str::to_string),
            pending: BTreeMap::new(),
            asks: BTreeMap::new(),
            queued: None,
            turn: Turn::default(),
        }
    }

    pub fn prompt(
        &mut self,
        turn_id: &str,
        text: String,
        image_paths: Vec<String>,
    ) -> Result<Vec<Vec<u8>>, String> {
        if self.turn.id.is_some() || self.queued.is_some() {
            return Err("Codex already has a turn in flight".to_string());
        }
        let usage = self.turn.usage.clone();
        self.turn = Turn {
            id: Some(turn_id.to_string()),
            usage,
            ..Turn::default()
        };
        self.queued = Some(Prompt {
            turn_id: turn_id.to_string(),
            text,
            image_paths,
        });
        match self.stage {
            Stage::Fresh => {
                self.stage = Stage::Initializing;
                Ok(vec![self.call(
                    "initialize",
                    json!({ "clientInfo": {
                        "name": CLIENT_NAME,
                        "title": "GeneHub",
                        "version": env!("CARGO_PKG_VERSION"),
                    }}),
                    Pending::Initialize,
                )?])
            }
            Stage::Ready => self.start_queued().map(|value| vec![value]),
            Stage::Initializing | Stage::Opening => Ok(Vec::new()),
        }
    }

    pub fn set_model(&mut self, value: &str) {
        self.model = Some(value.to_string());
    }

    pub fn set_mode(&mut self, value: &str) -> Result<(), String> {
        if !matches!(value, "read-only" | "auto" | "full-access") {
            return Err(format!("unknown Codex mode '{value}'"));
        }
        self.mode = value.to_string();
        Ok(())
    }

    pub fn set_effort(&mut self, value: &str) {
        self.effort = Some(value.to_string());
    }

    pub fn interrupt(&mut self) -> Result<Option<Vec<u8>>, String> {
        self.turn.interrupt_requested = true;
        let (Some(thread), Some(turn)) = (self.thread.clone(), self.turn.upstream_id.clone())
        else {
            return Ok(None);
        };
        self.call(
            "turn/interrupt",
            json!({ "threadId": thread, "turnId": turn }),
            Pending::Interrupt,
        )
        .map(Some)
    }

    #[cfg(test)]
    pub fn respond(
        &mut self,
        request_id: &str,
        outcome: &PermissionOutcome,
    ) -> Result<Vec<u8>, String> {
        let pending = self
            .asks
            .remove(request_id)
            .ok_or_else(|| format!("Codex request '{request_id}' is no longer pending"))?;
        let result = match pending.response {
            Ask::Decision => json!({ "decision": decision(outcome) }),
            Ask::Questions { questions } => {
                json!({ "answers": answers(&questions, outcome) })
            }
        };
        encode(json!({
            "jsonrpc": "2.0",
            "id": pending.upstream_id,
            "result": result,
        }))
    }

    pub fn line(&mut self, line: &str) -> LineOutput {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return LineOutput::default();
        };
        let mut output = LineOutput::default();
        let method = frame.get("method").and_then(Value::as_str);
        let id = frame.get("id").cloned();
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        match (id, method) {
            (Some(id), None) => self.reply(&id, &frame, &mut output),
            (Some(id), Some(method)) => self.server_request(id, method, &params, &mut output),
            (None, Some("serverRequest/resolved")) => {
                if let Some(id) = params.get("requestId").and_then(request_key) {
                    if self.asks.remove(&id).is_some() {
                        output.events.push(SessionEvent::PermissionResolved {
                            request_id: id,
                            outcome: PermissionOutcome::Canceled,
                        });
                    }
                }
            }
            (None, Some(method)) => self.notification(method, &params, &mut output.events),
            _ => {}
        }
        output
    }

    fn reply(&mut self, id: &Value, frame: &Value, output: &mut LineOutput) {
        let Some(id) = id.as_i64() else { return };
        let Some(pending) = self.pending.remove(&id) else {
            return;
        };
        if let Some(error) = frame.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Codex returned an unknown error")
                .to_string();
            if matches!(pending, Pending::OpenThread)
                && self.fork_checkpoint.is_none()
                && self
                    .resume_thread
                    .as_deref()
                    .is_some_and(|thread| archived_thread(&message, thread))
            {
                let thread = self.resume_thread.clone().unwrap_or_default();
                if let Ok(write) = self.call(
                    "thread/unarchive",
                    json!({ "threadId": thread }),
                    Pending::UnarchiveThread,
                ) {
                    output.writes.push(write);
                    return;
                }
            }
            if let Some(turn_id) = self.turn.id.take() {
                output.events.push(SessionEvent::TurnFailed {
                    turn_id,
                    error: TurnError {
                        code: TurnErrorCode::Upstream,
                        message,
                    },
                });
            }
            self.queued = None;
            return;
        }
        let result = frame.get("result").cloned().unwrap_or(Value::Null);
        match pending {
            Pending::Initialize => {
                output.writes.push(
                    encode(json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))
                        .unwrap_or_default(),
                );
                self.stage = Stage::Opening;
                let (method, params) = if let Some(thread) = self.resume_thread.clone() {
                    if let Some(checkpoint) = self.fork_checkpoint.clone() {
                        (
                            "thread/fork",
                            with_policy(
                                json!({
                                    "threadId": thread,
                                    "lastTurnId": checkpoint,
                                    "ephemeral": false,
                                }),
                                &self.mode,
                            ),
                        )
                    } else {
                        (
                            "thread/resume",
                            with_developer_instructions(
                                with_policy(json!({ "threadId": thread }), &self.mode),
                                self.developer_instructions.as_deref(),
                            ),
                        )
                    }
                } else {
                    let mut params = with_policy(json!({}), &self.mode);
                    if let Some(model) = &self.model {
                        params["model"] = json!(model);
                    }
                    (
                        "thread/start",
                        with_developer_instructions(params, self.developer_instructions.as_deref()),
                    )
                };
                if let Ok(write) = self.call(method, params, Pending::OpenThread) {
                    output.writes.push(write);
                }
            }
            Pending::OpenThread => {
                self.thread = result
                    .get("thread")
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str)
                    .or(self.resume_thread.as_deref())
                    .map(str::to_string);
                self.stage = Stage::Ready;
                if let Some(thread) = &self.thread {
                    output.persistence = Some(json!({ "threadId": thread }));
                }
                if let Ok(write) = self.start_queued() {
                    output.writes.push(write);
                }
            }
            Pending::UnarchiveThread => {
                let Some(thread) = self.resume_thread.clone() else {
                    return;
                };
                let params = with_developer_instructions(
                    with_policy(json!({ "threadId": thread }), &self.mode),
                    self.developer_instructions.as_deref(),
                );
                if let Ok(write) = self.call("thread/resume", params, Pending::OpenThread) {
                    output.writes.push(write);
                }
            }
            Pending::StartTurn { turn_id } => {
                if self.turn.id.as_deref() == Some(&turn_id) {
                    self.turn.upstream_id = notification_turn_id(&result).map(str::to_string);
                }
            }
            Pending::Interrupt => {}
        }
    }

    fn start_queued(&mut self) -> Result<Vec<u8>, String> {
        let prompt = self
            .queued
            .take()
            .ok_or_else(|| "Codex has no queued prompt".to_string())?;
        let thread = self
            .thread
            .clone()
            .ok_or_else(|| "Codex thread is not ready".to_string())?;
        let mut input = Vec::new();
        if !prompt.text.is_empty() {
            input.push(json!({ "type": "text", "text": prompt.text }));
        }
        input.extend(
            prompt
                .image_paths
                .into_iter()
                .map(|path| json!({ "type": "localImage", "path": path })),
        );
        if input.is_empty() {
            input.push(json!({ "type": "text", "text": "" }));
        }
        let mode = mode(&self.mode);
        let mut params = json!({
            "threadId": thread,
            "input": input,
            "approvalPolicy": mode.0,
            "sandboxPolicy": mode.1,
        });
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &self.effort {
            params["effort"] = json!(effort);
        }
        self.call(
            "turn/start",
            params,
            Pending::StartTurn {
                turn_id: prompt.turn_id,
            },
        )
    }

    fn call(&mut self, method: &str, params: Value, pending: Pending) -> Result<Vec<u8>, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.pending.insert(id, pending);
        encode(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }

    fn server_request(&mut self, id: Value, method: &str, params: &Value, output: &mut LineOutput) {
        let Some(request_id) = request_key(&id) else {
            output.writes.push(
                encode(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32600, "message": "Invalid request id" }
                }))
                .unwrap_or_default(),
            );
            return;
        };
        let current = self.current_scope(params);
        if !current {
            let result = match method {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    Some(json!({ "decision": "decline" }))
                }
                "item/tool/requestUserInput" | "tool/requestUserInput" => {
                    Some(json!({ "answers": {} }))
                }
                _ => None,
            };
            if let Some(result) = result {
                output.writes.push(
                    encode(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                        .unwrap_or_default(),
                );
                return;
            }
        }
        let detail = params
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let tool_call_id = params
            .get("itemId")
            .and_then(Value::as_str)
            .map(str::to_string);
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                let title = if method.contains("commandExecution") {
                    let command = command_text(params.get("command"));
                    if command.is_empty() {
                        "Run a command?".to_string()
                    } else {
                        format!("Run `{command}`?")
                    }
                } else {
                    "Apply file changes?".to_string()
                };
                self.asks.insert(
                    request_id.clone(),
                    PendingAsk {
                        upstream_id: id,
                        response: Ask::Decision,
                    },
                );
                output.events.push(SessionEvent::PermissionRequested {
                    request: PermissionRequest {
                        id: request_id,
                        kind: PermissionRequestKind::Permission,
                        title,
                        detail,
                        tool_call_id,
                        options: allow_or_deny(),
                        questions: None,
                    },
                });
            }
            "item/tool/requestUserInput" | "tool/requestUserInput" => {
                let raw = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let questions = raw.iter().filter_map(question).collect::<Vec<_>>();
                if questions.is_empty() || questions.len() != raw.len() {
                    output.writes.push(
                        encode(json!({ "jsonrpc": "2.0", "id": id, "result": { "answers": {} } }))
                            .unwrap_or_default(),
                    );
                    return;
                }
                self.asks.insert(
                    request_id.clone(),
                    PendingAsk {
                        upstream_id: id,
                        response: Ask::Questions {
                            questions: questions.clone(),
                        },
                    },
                );
                output.events.push(SessionEvent::PermissionRequested {
                    request: PermissionRequest {
                        id: request_id,
                        kind: PermissionRequestKind::Question,
                        title: questions[0].header.clone(),
                        detail: None,
                        tool_call_id,
                        options: Vec::new(),
                        questions: Some(questions.iter().map(Question::interaction).collect()),
                    },
                });
            }
            "mcpServer/elicitation/request" => output.writes.push(
                encode(json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "action": "decline", "content": null, "_meta": null }
                }))
                .unwrap_or_default(),
            ),
            _ => output.writes.push(
                encode(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32601, "message": "GeneHub does not answer this request" }
                }))
                .unwrap_or_default(),
            ),
        }
    }

    fn current_scope(&self, params: &Value) -> bool {
        self.turn.id.is_some()
            && params.get("threadId").and_then(Value::as_str) == self.thread.as_deref()
            && notification_turn_id(params) == self.turn.upstream_id.as_deref()
    }

    fn notification(&mut self, method: &str, params: &Value, events: &mut Vec<SessionEvent>) {
        if params.get("threadId").and_then(Value::as_str) != self.thread.as_deref() {
            return;
        }
        if method == "turn/started" && self.turn.id.is_some() && self.turn.upstream_id.is_none() {
            self.turn.upstream_id = notification_turn_id(params).map(str::to_string);
            return;
        }
        let current = notification_turn_id(params) == self.turn.upstream_id.as_deref()
            && self.turn.upstream_id.is_some();
        match method {
            "turn/completed" if current => self.finish(params, events),
            "thread/tokenUsage/updated" if self.turn.id.is_none() || current => {
                if let Some(usage) = usage(params) {
                    self.turn.usage = usage;
                }
            }
            "item/started" | "item/completed" if current => {
                if let Some(item) = params.get("item") {
                    self.item(item, method == "item/completed", events);
                }
            }
            "item/agentMessage/delta" if current => self.stream(params, false, events),
            "item/reasoning/summaryTextDelta" if current => self.stream(params, true, events),
            "turn/plan/updated" if current => self.plan(params, events),
            "thread/compacted" if current => {
                if let Some(turn_id) = self.turn.id.clone() {
                    events.push(SessionEvent::Item {
                        turn_id: turn_id.clone(),
                        item: TimelineItem::Compaction {
                            id: format!("{turn_id}-compaction"),
                            reason: "Codex pruned its own history to make room.".to_string(),
                        },
                    });
                }
            }
            _ => {}
        }
    }

    fn finish(&mut self, params: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.take() else {
            return;
        };
        let turn = params.get("turn").unwrap_or(&Value::Null);
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let event = if self.turn.interrupt_requested
            || matches!(status, "interrupted" | "canceled" | "cancelled" | "aborted")
        {
            SessionEvent::TurnCanceled { turn_id }
        } else if status == "failed" || turn.get("error").is_some_and(|value| !value.is_null()) {
            SessionEvent::TurnFailed {
                turn_id,
                error: TurnError {
                    code: TurnErrorCode::Upstream,
                    message: turn
                        .get("error")
                        .and_then(|value| value.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex ended the turn without saying why")
                        .to_string(),
                },
            }
        } else {
            SessionEvent::TurnCompleted {
                turn_id,
                usage: self.turn.usage.clone(),
                fork_checkpoint: self.turn.upstream_id.clone(),
            }
        };
        self.turn.upstream_id = None;
        self.turn.interrupt_requested = false;
        self.turn.open.clear();
        events.push(event);
    }

    fn stream(&mut self, params: &Value, reasoning: bool, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
            return;
        };
        let delta = params
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if delta.is_empty() {
            return;
        }
        if self.turn.open.contains(item_id) {
            events.push(SessionEvent::ItemDelta {
                turn_id,
                item_id: item_id.to_string(),
                delta: ItemDelta::Text { delta },
            });
            return;
        }
        self.turn.open.insert(item_id.to_string());
        let item = if reasoning {
            TimelineItem::Reasoning {
                id: item_id.to_string(),
                text: delta,
            }
        } else {
            TimelineItem::AssistantMessage {
                id: item_id.to_string(),
                text: delta,
            }
        };
        events.push(SessionEvent::Item { turn_id, item });
    }

    fn item(&mut self, item: &Value, settled: bool, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_string) else {
            return;
        };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        let text = |field: &str| {
            item.get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let value = match kind {
            "userMessage" => return,
            "agentMessage" => {
                self.turn.open.insert(id.clone());
                TimelineItem::AssistantMessage {
                    id,
                    text: text("text"),
                }
            }
            "reasoning" => {
                self.turn.open.insert(id.clone());
                TimelineItem::Reasoning {
                    id,
                    text: reasoning_text(item),
                }
            }
            "commandExecution" => TimelineItem::ToolCall {
                id,
                name: "Shell".to_string(),
                status: tool_status(item, settled),
                detail: ToolCallDetail::Shell {
                    command: command_text(item.get("command")),
                    output: text("aggregatedOutput"),
                    exit_code: item
                        .get("exitCode")
                        .and_then(Value::as_i64)
                        .map(|v| v as i32),
                },
            },
            "fileChange" => TimelineItem::ToolCall {
                id,
                name: "Edit".to_string(),
                status: tool_status(item, settled),
                detail: edit_detail(item),
            },
            "mcpToolCall" => {
                let tool = text("tool");
                let server = text("server");
                TimelineItem::ToolCall {
                    id,
                    name: if server.is_empty() {
                        tool
                    } else {
                        format!("{server}.{tool}")
                    },
                    status: tool_status(item, settled),
                    detail: ToolCallDetail::Unknown { raw: item.clone() },
                }
            }
            "webSearch" => TimelineItem::ToolCall {
                id,
                name: "Web search".to_string(),
                status: tool_status(item, settled),
                detail: ToolCallDetail::Search {
                    query: text("query"),
                    matches: Vec::new(),
                },
            },
            "collabAgentToolCall" => TimelineItem::ToolCall {
                id,
                name: "Sub-agent".to_string(),
                status: tool_status(item, settled),
                detail: ToolCallDetail::SubAgent {
                    agent: text("tool"),
                    prompt: text("prompt"),
                    items: Vec::new(),
                },
            },
            "subAgentActivity" => {
                let path = text("agentPath");
                TimelineItem::ToolCall {
                    id,
                    name: match path.as_str() {
                        "" => "Sub-agent".to_string(),
                        "/root" => "Main agent".to_string(),
                        _ => path,
                    },
                    status: match item.get("kind").and_then(Value::as_str) {
                        Some("interrupted") => ToolStatus::Canceled,
                        _ if settled => ToolStatus::Ok,
                        _ => ToolStatus::Running,
                    },
                    detail: ToolCallDetail::Unknown { raw: item.clone() },
                }
            }
            "contextCompaction" => TimelineItem::Compaction {
                id,
                reason: "Codex pruned its own history to make room.".to_string(),
            },
            "error" => TimelineItem::Error {
                id,
                message: text("message"),
            },
            other => TimelineItem::ToolCall {
                id,
                name: other.to_string(),
                status: tool_status(item, settled),
                detail: ToolCallDetail::Unknown { raw: item.clone() },
            },
        };
        events.push(SessionEvent::Item {
            turn_id,
            item: value,
        });
    }

    fn plan(&self, params: &Value, events: &mut Vec<SessionEvent>) {
        let Some(turn_id) = self.turn.id.clone() else {
            return;
        };
        let items = params
            .get("plan")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let text = entry
                    .get("step")
                    .and_then(Value::as_str)
                    .or_else(|| entry.get("text").and_then(Value::as_str))?;
                Some(TodoEntry {
                    text: text.to_string(),
                    status: match entry.get("status").and_then(Value::as_str) {
                        Some("in_progress" | "inProgress") => TodoStatus::InProgress,
                        Some("completed") => TodoStatus::Completed,
                        _ => TodoStatus::Pending,
                    },
                })
            })
            .collect();
        events.push(SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: TimelineItem::Todo {
                id: format!("{turn_id}-plan"),
                items,
            },
        });
    }
}

impl Question {
    fn interaction(&self) -> InteractionQuestion {
        InteractionQuestion {
            id: self.id.clone(),
            prompt: self.prompt.clone(),
            allow_multiple: false,
            allow_freeform: true,
            options: self
                .options
                .iter()
                .map(|(id, label)| InteractionOption {
                    id: id.clone(),
                    label: label.clone(),
                })
                .collect(),
        }
    }
}

fn encode(value: Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn mode(id: &str) -> (&'static str, Value) {
    match id {
        "read-only" => ("on-request", json!({ "type": "readOnly" })),
        "auto" => (
            "on-request",
            json!({ "type": "workspaceWrite", "networkAccess": false }),
        ),
        _ => ("never", json!({ "type": "dangerFullAccess" })),
    }
}

fn with_policy(mut value: Value, selected: &str) -> Value {
    let selected = mode(selected);
    value["approvalPolicy"] = json!(selected.0);
    value["sandbox"] = match selected.1.get("type").and_then(Value::as_str) {
        Some("readOnly") => json!("read-only"),
        Some("workspaceWrite") => json!("workspace-write"),
        _ => json!("danger-full-access"),
    };
    value
}

fn with_developer_instructions(mut value: Value, instructions: Option<&str>) -> Value {
    if let Some(instructions) = instructions.filter(|value| !value.trim().is_empty()) {
        value["developerInstructions"] = json!(instructions);
    }
    value
}

fn archived_thread(message: &str, thread_id: &str) -> bool {
    message.to_ascii_lowercase().contains("archived") && message.contains(thread_id)
}

pub(crate) fn catalog(listed: Option<&Value>) -> Catalog {
    let models = listed.map(models_in).unwrap_or_default();
    let (default_model, default_effort) = listed
        .and_then(default_model_in)
        .map_or((None, None), |(model, effort)| (Some(model), effort));
    Catalog {
        models,
        modes: [
            (
                "read-only",
                "Read only",
                "Read and plan only; ask before changing anything",
            ),
            (
                "auto",
                "Default",
                "Edit inside the workspace and ask before going beyond it",
            ),
            (
                "full-access",
                "Full access",
                "Run without approval or filesystem restrictions",
            ),
        ]
        .into_iter()
        .map(|(id, label, description)| ModeInfo {
            id: id.to_string(),
            label: label.to_string(),
            description: Some(description.to_string()),
        })
        .collect(),
        commands: Vec::new(),
        default_model,
        default_mode: Some(DEFAULT_MODE.to_string()),
        default_effort,
    }
}

/// Only this exact CLI sentence is authoritative evidence that credentials
/// are missing. Unknown output keeps a present executable usable.
pub(crate) fn login_probe(stdout: &[u8], stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stdout).contains("Not logged in")
        || String::from_utf8_lossy(stderr).contains("Not logged in")
}

fn models_in(listed: &Value) -> Vec<ModelInfo> {
    listed
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            if model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }
            let id = model.get("id").and_then(Value::as_str)?;
            let efforts = model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    effort
                        .get("reasoningEffort")
                        .and_then(Value::as_str)
                        .or_else(|| effort.as_str())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>();
            Some(ModelInfo {
                id: id.to_string(),
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_window: None,
                reasoning: !efforts.is_empty(),
                efforts,
            })
        })
        .collect()
}

fn default_model_in(listed: &Value) -> Option<(String, Option<String>)> {
    let models = listed.get("data")?.as_array()?;
    let chosen = models
        .iter()
        .find(|model| {
            model
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .or_else(|| models.first())?;
    Some((
        chosen.get("id")?.as_str()?.to_string(),
        chosen
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
    ))
}

fn notification_turn_id(value: &Value) -> Option<&str> {
    value.get("turnId").and_then(Value::as_str).or_else(|| {
        value
            .get("turn")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
    })
}

fn request_key(value: &Value) -> Option<String> {
    match value {
        Value::Number(value) if value.as_i64().is_some() => Some(value.to_string()),
        Value::String(value) => Some(format!("string:{value}")),
        _ => None,
    }
}

fn allow_or_deny() -> Vec<PermissionOption> {
    vec![
        PermissionOption {
            id: "allow".to_string(),
            label: "Allow".to_string(),
            kind: PermissionOptionKind::AllowOnce,
        },
        PermissionOption {
            id: "deny".to_string(),
            label: "Deny".to_string(),
            kind: PermissionOptionKind::Reject,
        },
    ]
}

#[cfg(test)]
fn decision(value: &PermissionOutcome) -> &'static str {
    match value {
        PermissionOutcome::Selected { option_id } if option_id == "allow" => "accept",
        PermissionOutcome::Canceled => "cancel",
        _ => "decline",
    }
}

fn question(value: &Value) -> Option<Question> {
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Some(Question {
        id: string("id")?,
        header: string("header")?,
        prompt: string("question")?,
        options: value
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, value)| {
                Some((index.to_string(), value.get("label")?.as_str()?.to_string()))
            })
            .collect(),
    })
}

#[cfg(test)]
fn answers(questions: &[Question], outcome: &PermissionOutcome) -> serde_json::Map<String, Value> {
    let mut result = serde_json::Map::new();
    let submitted = match outcome {
        PermissionOutcome::Answered { answers } => answers.as_slice(),
        _ => &[],
    };
    for question in questions {
        let Some(answer) = submitted
            .iter()
            .find(|answer| answer.question_id == question.id)
        else {
            continue;
        };
        let mut values = answer
            .selected_option_ids
            .iter()
            .filter_map(|id| {
                question
                    .options
                    .iter()
                    .find(|(candidate, _)| candidate == id)
                    .map(|(_, label)| label.clone())
            })
            .collect::<Vec<_>>();
        if let Some(text) = answer
            .freeform_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            values.push(text.to_string());
        }
        if !values.is_empty() {
            result.insert(question.id.clone(), json!({ "answers": values }));
        }
    }
    result
}

fn usage(params: &Value) -> Option<Usage> {
    let last = params.get("tokenUsage")?.get("last")?;
    let count = |key: &str| last.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cache_read_tokens: count("cachedInputTokens"),
        cache_write_tokens: 0,
        cost_usd: None,
    })
}

fn command_text(command: Option<&Value>) -> String {
    match command {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(value)) => value
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn reasoning_text(item: &Value) -> String {
    for field in ["text", "summary"] {
        match item.get(field) {
            Some(Value::String(value)) => return value.clone(),
            Some(Value::Array(value)) => {
                let joined = value
                    .iter()
                    .filter_map(|value| {
                        value.as_str().map(str::to_string).or_else(|| {
                            value
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                    })
                    .collect::<Vec<_>>();
                if !joined.is_empty() {
                    return joined.join("\n\n");
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn edit_detail(item: &Value) -> ToolCallDetail {
    let Some(changes) = item.get("changes").and_then(Value::as_array) else {
        return ToolCallDetail::Unknown { raw: item.clone() };
    };
    let mut paths = Vec::new();
    let mut diff = String::new();
    for change in changes {
        if let Some(path) = change.get("path").and_then(Value::as_str) {
            paths.push(path.to_string());
        }
        for field in ["unifiedDiff", "unified_diff", "diff"] {
            if let Some(value) = change.get(field).and_then(Value::as_str) {
                if !diff.is_empty() {
                    diff.push('\n');
                }
                diff.push_str(value);
                break;
            }
        }
    }
    if paths.is_empty() {
        ToolCallDetail::Unknown { raw: item.clone() }
    } else {
        ToolCallDetail::Edit {
            path: paths.join(", "),
            diff,
        }
    }
}

fn tool_status(item: &Value, settled: bool) -> ToolStatus {
    if item.get("error").is_some_and(|value| !value.is_null()) {
        return ToolStatus::Error;
    }
    match item.get("status").and_then(Value::as_str) {
        Some("inProgress" | "running" | "pending") => ToolStatus::Running,
        Some("completed" | "success") => ToolStatus::Ok,
        Some("failed" | "error" | "errored") => ToolStatus::Error,
        Some("canceled" | "cancelled" | "interrupted" | "aborted") => ToolStatus::Canceled,
        _ if settled => ToolStatus::Ok,
        _ => ToolStatus::Running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_driver() -> Driver {
        let mut driver = Driver::new(None, None, None, None, None);
        driver.stage = Stage::Ready;
        driver.thread = Some("root-thread".to_string());
        driver.turn.id = Some("turn_1".to_string());
        driver.turn.upstream_id = Some("root-turn".to_string());
        driver
    }

    #[test]
    fn handshake_queues_prompt_and_binds_thread() {
        let mut driver = Driver::new(
            None,
            None,
            Some("gpt-5"),
            Some("high"),
            Some("fixed product guidance"),
        );
        let writes = driver
            .prompt("turn_1", "hello".to_string(), Vec::new())
            .unwrap();
        assert_eq!(writes.len(), 1);
        let init = driver.line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        assert_eq!(init.writes.len(), 2);
        let start: Value = serde_json::from_slice(&init.writes[1]).unwrap();
        assert_eq!(start["method"], "thread/start");
        assert_eq!(
            start["params"]["developerInstructions"],
            "fixed product guidance"
        );
        let opened = driver.line(r#"{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"th_1"}}}"#);
        assert_eq!(opened.persistence, Some(json!({ "threadId": "th_1" })));
        assert_eq!(opened.writes.len(), 1);
    }

    #[test]
    fn resumed_threads_receive_the_same_fixed_product_guidance() {
        let mut driver = Driver::new(
            Some(&json!({"threadId":"th_1"})),
            None,
            None,
            None,
            Some("fixed product guidance"),
        );
        driver
            .prompt("turn_1", "hello".to_string(), Vec::new())
            .unwrap();
        let init = driver.line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        let resume: Value = serde_json::from_slice(&init.writes[1]).unwrap();
        assert_eq!(resume["method"], "thread/resume");
        assert_eq!(resume["params"]["threadId"], "th_1");
        assert_eq!(
            resume["params"]["developerInstructions"],
            "fixed product guidance"
        );
    }

    #[test]
    fn model_catalog_preserves_each_models_own_efforts_and_defaults() {
        let listed = json!({"data":[
            {
                "id":"gpt-5.2-codex",
                "displayName":"GPT-5.2 Codex",
                "isDefault":true,
                "defaultReasoningEffort":"high",
                "supportedReasoningEfforts":[
                    {"reasoningEffort":"low"},
                    {"reasoningEffort":"high"}
                ]
            },
            {
                "id":"hidden",
                "hidden":true,
                "supportedReasoningEfforts":["xhigh"]
            },
            {"id":"plain","displayName":"Plain"}
        ]});
        let catalog = catalog(Some(&listed));
        assert_eq!(catalog.default_model.as_deref(), Some("gpt-5.2-codex"));
        assert_eq!(catalog.default_effort.as_deref(), Some("high"));
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[0].efforts, ["low", "high"]);
        assert!(catalog.models[0].reasoning);
        assert!(!catalog.models[1].reasoning);
        assert_eq!(catalog.default_mode.as_deref(), Some("full-access"));
    }

    #[test]
    fn only_an_explicit_logged_out_sentence_hides_codex() {
        assert!(login_probe(b"", b"Not logged in. Run codex login"));
        assert!(!login_probe(b"Logged in using ChatGPT", b""));
        assert!(!login_probe(b"", b"unrecognized status output"));
    }

    #[test]
    fn an_archived_resume_is_unarchived_and_retried_with_product_guidance() {
        let mut driver = Driver::new(
            Some(&json!({"threadId":"th_archived"})),
            None,
            None,
            None,
            Some("fixed product guidance"),
        );
        driver
            .prompt("turn_1", "hello".to_string(), Vec::new())
            .unwrap();
        let opened = driver.line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        assert_eq!(opened.writes.len(), 2);
        let unarchive = driver.line(
            r#"{"jsonrpc":"2.0","id":2,"error":{"message":"thread th_archived is archived"}}"#,
        );
        let unarchive: Value = serde_json::from_slice(&unarchive.writes[0]).unwrap();
        assert_eq!(unarchive["method"], "thread/unarchive");
        assert_eq!(unarchive["params"]["threadId"], "th_archived");

        let retried = driver.line(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#);
        let retried: Value = serde_json::from_slice(&retried.writes[0]).unwrap();
        assert_eq!(retried["method"], "thread/resume");
        assert_eq!(
            retried["params"]["developerInstructions"],
            "fixed product guidance"
        );
    }

    #[test]
    fn root_thread_collaboration_items_remain_visible_and_named() {
        let mut driver = Driver::new(None, None, None, None, None);
        driver.stage = Stage::Ready;
        driver.thread = Some("root-thread".to_string());
        driver.turn.id = Some("turn_1".to_string());
        driver.turn.upstream_id = Some("root-turn".to_string());
        let output = driver.line(
            &json!({
                "method":"item/completed",
                "params":{
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "type":"subAgentActivity",
                        "id":"return-to-root",
                        "agentPath":"/root",
                        "kind":"completed"
                    }
                }
            })
            .to_string(),
        );
        assert!(matches!(
            output.events.as_slice(),
            [SessionEvent::Item {
                item: TimelineItem::ToolCall { name, status: ToolStatus::Ok, .. },
                ..
            }] if name == "Main agent"
        ));
    }

    #[test]
    fn root_approval_is_surfaced_and_answer_preserves_numeric_id() {
        let mut driver = Driver::new(Some(&json!({"threadId":"th_1"})), None, None, None, None);
        driver.stage = Stage::Ready;
        driver.thread = Some("th_1".into());
        driver.turn.id = Some("turn_1".into());
        driver.turn.upstream_id = Some("tu_1".into());
        let output = driver.line(r#"{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"th_1","turnId":"tu_1","command":"ls"}}"#);
        assert!(matches!(
            output.events[0],
            SessionEvent::PermissionRequested { .. }
        ));
        let answer = driver
            .respond(
                "7",
                &PermissionOutcome::Selected {
                    option_id: "allow".into(),
                },
            )
            .unwrap();
        let value: Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(value["id"], 7);
        assert_eq!(value["result"]["decision"], "accept");
    }

    #[test]
    fn foreign_requests_are_declined_and_root_questions_keep_labels_and_string_ids() {
        let mut driver = active_driver();
        let foreign = driver.line(
            r#"{"jsonrpc":"2.0","id":"foreign","method":"item/commandExecution/requestApproval","params":{"threadId":"other-thread","turnId":"other-turn","command":["rm","-rf","tmp"]}}"#,
        );
        assert!(foreign.events.is_empty());
        let declined: Value = serde_json::from_slice(&foreign.writes[0]).unwrap();
        assert_eq!(declined["id"], "foreign");
        assert_eq!(declined["result"]["decision"], "decline");

        let question = driver.line(
            r#"{"jsonrpc":"2.0","id":"ask-1","method":"item/tool/requestUserInput","params":{"threadId":"root-thread","turnId":"root-turn","questions":[{"id":"framework","header":"Framework","question":"Which one?","options":[{"label":"React"},{"label":"Vue"}]}]}}"#,
        );
        assert!(matches!(
            question.events.as_slice(),
            [SessionEvent::PermissionRequested { request }]
                if request.id == "string:ask-1"
                    && request.questions.as_ref().is_some_and(|questions|
                        questions[0].options[0].label == "React"
                            && questions[0].options[1].label == "Vue")
        ));
        let answer = driver
            .respond(
                "string:ask-1",
                &PermissionOutcome::Answered {
                    answers: vec![genehub_proto::InteractionAnswer {
                        question_id: "framework".to_string(),
                        selected_option_ids: vec!["1".to_string()],
                        freeform_text: Some("with TypeScript".to_string()),
                    }],
                },
            )
            .unwrap();
        let answer: Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(answer["id"], "ask-1");
        assert_eq!(
            answer["result"]["answers"]["framework"]["answers"],
            json!(["Vue", "with TypeScript"])
        );
    }

    #[test]
    fn streams_tools_plans_usage_and_completion_remain_scoped_to_the_root_turn() {
        let mut driver = active_driver();
        let foreign = driver.line(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"other","turnId":"root-turn","itemId":"msg","delta":"leak"}}"#,
        );
        assert!(foreign.events.is_empty());

        let opened = driver.line(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"root-thread","turnId":"root-turn","itemId":"msg","delta":"hello"}}"#,
        );
        assert!(matches!(
            opened.events.as_slice(),
            [SessionEvent::Item { item: TimelineItem::AssistantMessage { text, .. }, .. }]
                if text == "hello"
        ));
        let delta = driver.line(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"root-thread","turnId":"root-turn","itemId":"msg","delta":" world"}}"#,
        );
        assert!(matches!(
            delta.events.as_slice(),
            [SessionEvent::ItemDelta { delta: ItemDelta::Text { delta }, .. }]
                if delta == " world"
        ));

        let command = driver.line(
            r#"{"method":"item/completed","params":{"threadId":"root-thread","turnId":"root-turn","item":{"type":"commandExecution","id":"cmd","command":["printf","hi"],"aggregatedOutput":"hi","exitCode":0,"status":"completed"}}}"#,
        );
        assert!(matches!(
            command.events.as_slice(),
            [SessionEvent::Item {
                item: TimelineItem::ToolCall {
                    status: ToolStatus::Ok,
                    detail: ToolCallDetail::Shell { command, output, exit_code: Some(0) },
                    ..
                }, ..
            }] if command == "printf hi" && output == "hi"
        ));
        let unknown = driver.line(
            r#"{"method":"item/completed","params":{"threadId":"root-thread","turnId":"root-turn","item":{"type":"futureThing","id":"future","payload":{"kept":true}}}}"#,
        );
        assert!(matches!(
            unknown.events.as_slice(),
            [SessionEvent::Item {
                item: TimelineItem::ToolCall { detail: ToolCallDetail::Unknown { raw }, .. }, ..
            }] if raw["payload"]["kept"] == true
        ));
        let plan = driver.line(
            r#"{"method":"turn/plan/updated","params":{"threadId":"root-thread","turnId":"root-turn","plan":[{"step":"inspect","status":"completed"},{"step":"fix","status":"in_progress"}]}}"#,
        );
        assert!(matches!(
            plan.events.as_slice(),
            [SessionEvent::Item { item: TimelineItem::Todo { items, .. }, .. }]
                if items.len() == 2
                    && items[0].status == TodoStatus::Completed
                    && items[1].status == TodoStatus::InProgress
        ));
        driver.line(
            r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"root-thread","turnId":"root-turn","tokenUsage":{"last":{"inputTokens":9,"outputTokens":4,"cachedInputTokens":3}}}}"#,
        );
        let completed = driver.line(
            r#"{"method":"turn/completed","params":{"threadId":"root-thread","turn":{"id":"root-turn","status":"completed"}}}"#,
        );
        assert!(matches!(
            completed.events.as_slice(),
            [SessionEvent::TurnCompleted { usage, fork_checkpoint, .. }]
                if usage.input_tokens == 9
                    && usage.output_tokens == 4
                    && usage.cache_read_tokens == 3
                    && fork_checkpoint.as_deref() == Some("root-turn")
        ));
    }

    #[test]
    fn failed_and_interrupted_turns_cannot_be_revived_by_late_start_replies() {
        let mut driver = active_driver();
        let failure = driver.line(
            r#"{"method":"turn/completed","params":{"threadId":"root-thread","turn":{"id":"root-turn","status":"failed","error":{"message":"upstream exploded"}}}}"#,
        );
        assert!(matches!(
            failure.events.as_slice(),
            [SessionEvent::TurnFailed { error, .. }] if error.message == "upstream exploded"
        ));

        driver.turn.id = Some("turn_2".to_string());
        driver.turn.upstream_id = Some("root-turn-2".to_string());
        driver.turn.interrupt_requested = true;
        let canceled = driver.line(
            r#"{"method":"turn/completed","params":{"threadId":"root-thread","turn":{"id":"root-turn-2","status":"completed"}}}"#,
        );
        assert!(matches!(
            canceled.events.as_slice(),
            [SessionEvent::TurnCanceled { .. }]
        ));

        driver.pending.insert(
            99,
            Pending::StartTurn {
                turn_id: "turn_2".to_string(),
            },
        );
        driver.line(r#"{"jsonrpc":"2.0","id":99,"result":{"turn":{"id":"late"}}}"#);
        assert!(driver.turn.id.is_none());
        assert!(driver.turn.upstream_id.is_none());
    }

    #[test]
    fn old_snapshot_without_developer_instructions_still_restores() {
        let driver = Driver::new(
            Some(&json!({ "threadId": "th_1" })),
            Some("full-access"),
            Some("gpt-5"),
            Some("high"),
            Some("fixed guidance"),
        );
        let mut snapshot = serde_json::to_value(driver).unwrap();
        snapshot
            .as_object_mut()
            .unwrap()
            .remove("developerInstructions");
        let restored: Driver = serde_json::from_value(snapshot).unwrap();
        assert_eq!(restored.resume_thread.as_deref(), Some("th_1"));
        assert!(restored.developer_instructions.is_none());
    }
}
