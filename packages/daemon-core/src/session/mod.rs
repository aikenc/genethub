//! Portable session kernel.
//!
//! The guest owns session identity, persistence layout, replay, state
//! transitions and Agent protocol state. Native code sees only workspace file
//! locators and opaque process resource ids.

mod acp;
mod claude;
mod codex;
mod genet;
mod opencode;

use std::collections::{HashMap, VecDeque};

use genehub_proto::{
    ErrorCode, PermissionOutcome, ProtocolError, Reply, Request, SequencedEvent, SessionEvent,
    SessionSnapshot, SessionStatus, SessionSummary, TimelineItem,
};
use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityRequest, CapabilityValue, ConnectionDirective, FileKind,
    FileLocator, FileRequest, FileRoot, LogicCompletion, LogicOutcome, LogicOutput, ProcessRequest,
    ProcessSignal, ProcessSpec, ProcessStream, Publication,
};
use serde::{Deserialize, Serialize};

use crate::agents::{self, AgentDefinition, AgentKind};
use crate::capability::Client;
use crate::config::{Config, WorkspaceEntry};
use crate::CapabilityExecutor;

const SESSION_FORMAT: u32 = 4;
const META_BYTES: u32 = 1024 * 1024;
const CHAT_BYTES: u32 = 3 * 1024 * 1024;
const REPLAY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sessions {
    loaded: HashMap<String, LiveSession>,
    process_to_session: HashMap<u64, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveSession {
    meta: SessionMeta,
    seq: u64,
    replay: VecDeque<SequencedEvent>,
    pending_permissions: Vec<genehub_proto::PermissionRequest>,
    process: Option<AgentProcess>,
    active_items: Vec<TimelineItem>,
    active_turn: Option<ActiveTurn>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    format: u32,
    id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    root_handle: String,
    #[serde(default, rename = "cwd", alias = "root")]
    root: String,
    agent_id: String,
    title: Option<String>,
    model_id: Option<String>,
    mode_id: Option<String>,
    effort_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    archived: bool,
    #[serde(default)]
    pending_permission: Option<genehub_proto::PermissionRequest>,
    #[serde(default)]
    persist: Option<PersistHandle>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistHandle {
    agent_id: String,
    value: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTurn {
    id: String,
    started_at_ms: i64,
    user_item_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentProcess {
    resource_id: u64,
    definition: AgentDefinition,
    stdout: Vec<u8>,
    stderr_tail: Vec<u8>,
    driver: Driver,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "state", rename_all = "camelCase")]
enum Driver {
    Acp(acp::Driver),
    Claude(claude::Driver),
    Codex(codex::Driver),
    Genet(genet::Driver),
    OpenCode(opencode::Driver),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ChatRow {
    Item { item: TimelineItem },
}

pub fn handles(request: &Request) -> bool {
    matches!(
        request,
        Request::Subscribe { .. }
            | Request::Unsubscribe { .. }
            | Request::SessionCreate { .. }
            | Request::SessionList { .. }
            | Request::SessionGet { .. }
            | Request::RoundTrunkList { .. }
            | Request::RoundTrunkGet { .. }
            | Request::BlobGet { .. }
            | Request::SessionSend { .. }
            | Request::SessionFork { .. }
            | Request::SessionInterrupt { .. }
            | Request::SessionClose { .. }
            | Request::SessionArchive { .. }
            | Request::SessionRename { .. }
            | Request::SessionDelete { .. }
            | Request::SessionSetModel { .. }
            | Request::SessionSetMode { .. }
            | Request::SessionSetEffort { .. }
            | Request::SessionRespondPermission { .. }
    )
}

#[allow(clippy::too_many_arguments)]
pub fn request(
    sessions: &mut Sessions,
    call_id: u64,
    request: Request,
    boot: &genet_daemon_logic_api::LogicBoot,
    config: &Config,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> LogicOutput {
    let response = sessions.handle(request, boot, config, executor, next);
    match response {
        Ok(response) => LogicOutput {
            completions: vec![LogicCompletion {
                call_id,
                outcome: LogicOutcome::Reply(Box::new(response.reply)),
                connection: response.connection,
            }],
            publications: response.publications,
            ..LogicOutput::default()
        },
        Err(error) => LogicOutput::completed(call_id, LogicOutcome::Error(error)),
    }
}

pub fn event(
    sessions: &mut Sessions,
    event: CapabilityEvent,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> LogicOutput {
    match sessions.handle_event(event, executor, next) {
        Ok(publications) => LogicOutput {
            publications,
            ..LogicOutput::default()
        },
        Err(error) => LogicOutput {
            publications: vec![Publication::Fanout(genehub_proto::ServerFrame::Notice {
                level: genehub_proto::NoticeLevel::Error,
                message: error.message,
            })],
            ..LogicOutput::default()
        },
    }
}

struct Response {
    reply: Reply,
    connection: ConnectionDirective,
    publications: Vec<Publication>,
}

impl Response {
    fn reply(reply: Reply) -> Self {
        Self {
            reply,
            connection: ConnectionDirective::None,
            publications: Vec::new(),
        }
    }
}

impl Sessions {
    fn handle(
        &mut self,
        request: Request,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        match request {
            Request::Subscribe {
                session_id,
                since_seq,
                expand_last_round: _,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                let live = self.live(&session_id)?;
                let snapshot = snapshot(live, executor, next)?;
                let first = live
                    .replay
                    .front()
                    .map(|event| event.seq)
                    .unwrap_or(live.seq + 1);
                let reset = since_seq.is_some_and(|seq| seq.saturating_add(1) < first);
                let replayed = if reset {
                    Vec::new()
                } else {
                    live.replay
                        .iter()
                        .filter(|event| since_seq.is_some_and(|seq| event.seq > seq))
                        .cloned()
                        .collect()
                };
                Ok(Response {
                    reply: Reply::Subscribed {
                        snapshot,
                        replayed,
                        reset,
                    },
                    connection: ConnectionDirective::Subscribe { session_id },
                    publications: Vec::new(),
                })
            }
            Request::Unsubscribe { session_id } => Ok(Response {
                reply: Reply::Ack,
                connection: ConnectionDirective::Unsubscribe { session_id },
                publications: Vec::new(),
            }),
            Request::SessionCreate {
                workspace_id,
                agent_id,
                model_id,
                mode_id,
                title,
            } => {
                let definition = agents::require(boot, config, &agent_id)?;
                let workspace = workspace(config, &workspace_id)?;
                let (id, now) = identity_and_time(executor, next)?;
                let folder = workspace
                    .folders
                    .first()
                    .ok_or_else(|| bad_request("workspace has no folders"))?;
                let meta = SessionMeta {
                    format: SESSION_FORMAT,
                    id,
                    workspace_id,
                    root_handle: folder.root_handle.clone(),
                    root: folder.root.clone(),
                    agent_id: definition.id,
                    title: normalize_title(title),
                    model_id,
                    mode_id,
                    effort_id: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    archived: false,
                    pending_permission: None,
                    persist: None,
                };
                establish(&meta, executor, next)?;
                save_meta(&meta, executor, next)?;
                let summary = summary(&meta, SessionStatus::Idle);
                self.loaded.insert(
                    meta.id.clone(),
                    LiveSession {
                        meta,
                        seq: 0,
                        replay: VecDeque::new(),
                        pending_permissions: Vec::new(),
                        process: None,
                        active_items: Vec::new(),
                        active_turn: None,
                    },
                );
                Ok(Response::reply(Reply::Session(summary)))
            }
            Request::SessionList {
                workspace_id,
                include_archived,
            } => {
                self.load_catalog(config, executor, next)?;
                let mut summaries = self
                    .loaded
                    .values()
                    .filter(|live| {
                        workspace_id
                            .as_deref()
                            .is_none_or(|workspace| live.meta.workspace_id == workspace)
                            && (include_archived || !live.meta.archived)
                    })
                    .map(|live| summary(&live.meta, status(live)))
                    .collect::<Vec<_>>();
                summaries.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at_ms));
                Ok(Response::reply(Reply::Sessions(summaries)))
            }
            Request::SessionGet { session_id } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                Ok(Response::reply(Reply::Snapshot(snapshot(
                    self.live(&session_id)?,
                    executor,
                    next,
                )?)))
            }
            Request::SessionSend {
                session_id,
                text,
                attachments,
                ..
            } => self.send(&session_id, text, attachments, boot, config, executor, next),
            Request::SessionInterrupt { session_id } => {
                let live = self.live_mut(&session_id)?;
                let process = live
                    .process
                    .as_mut()
                    .ok_or_else(|| conflict("session is not running"))?;
                let resource_id = process.resource_id;
                let action = match &mut process.driver {
                    Driver::Claude(driver) => {
                        Some((Some(driver.interrupt().map_err(internal)?), false))
                    }
                    Driver::Codex(driver) => driver
                        .interrupt()
                        .map_err(internal)?
                        .map(|bytes| (Some(bytes), false)),
                    Driver::Genet(driver) => Some((Some(driver.interrupt()), false)),
                    Driver::Acp(driver) => {
                        Some((Some(driver.interrupt().map_err(internal)?), false))
                    }
                    Driver::OpenCode(_) => Some((None, true)),
                };
                if let Some((write, signal)) = action {
                    if let Some(bytes) = write {
                        process_write(resource_id, bytes, executor, next)?;
                    }
                    if signal {
                        process_call(
                            ProcessRequest::Signal {
                                resource_id,
                                signal: ProcessSignal::Interrupt,
                            },
                            executor,
                            next,
                        )?;
                    }
                }
                Ok(Response::reply(Reply::Ack))
            }
            Request::SessionClose { session_id } => {
                let process = {
                    let live = self.live_mut(&session_id)?;
                    let process = live.process.take();
                    live.active_turn = None;
                    process
                };
                if let Some(process) = process {
                    self.process_to_session.remove(&process.resource_id);
                    let _ = process_call(
                        ProcessRequest::Signal {
                            resource_id: process.resource_id,
                            signal: ProcessSignal::KillTree,
                        },
                        executor,
                        next,
                    );
                }
                let live = self.live(&session_id)?;
                save_meta(&live.meta, executor, next)?;
                Ok(Response::reply(Reply::Ack))
            }
            Request::SessionArchive {
                session_id,
                archived,
            } => {
                let live = self.live_mut(&session_id)?;
                live.meta.archived = archived;
                live.meta.updated_at_ms = now(executor, next)?;
                save_meta(&live.meta, executor, next)?;
                Ok(Response::reply(Reply::Session(summary(
                    &live.meta,
                    status(live),
                ))))
            }
            Request::SessionRename { session_id, title } => {
                let title = normalize_title(Some(title))
                    .ok_or_else(|| bad_request("session title cannot be empty"))?;
                let live = self.live_mut(&session_id)?;
                live.meta.title = Some(title.clone());
                live.meta.updated_at_ms = now(executor, next)?;
                save_meta(&live.meta, executor, next)?;
                let publication = publish(live, SessionEvent::TitleChanged { title });
                Ok(Response {
                    reply: Reply::Session(summary(&live.meta, status(live))),
                    connection: ConnectionDirective::None,
                    publications: vec![publication],
                })
            }
            Request::SessionDelete { session_id } => {
                if let Some(mut live) = self.loaded.remove(&session_id) {
                    if let Some(process) = live.process.take() {
                        self.process_to_session.remove(&process.resource_id);
                        let _ = process_call(
                            ProcessRequest::Signal {
                                resource_id: process.resource_id,
                                signal: ProcessSignal::KillTree,
                            },
                            executor,
                            next,
                        );
                    }
                    remove_session(&live.meta, executor, next)?;
                }
                Ok(Response::reply(Reply::Ack))
            }
            Request::SessionSetModel {
                session_id,
                model_id,
            } => self.control(&session_id, Control::Model(model_id), executor, next),
            Request::SessionSetMode {
                session_id,
                mode_id,
            } => self.control(&session_id, Control::Mode(mode_id), executor, next),
            Request::SessionSetEffort {
                session_id,
                effort_id,
            } => self.control(&session_id, Control::Effort(effort_id), executor, next),
            Request::SessionRespondPermission {
                session_id,
                request_id,
                outcome,
            } => self.permission(&session_id, request_id, outcome, executor, next),
            Request::RoundTrunkList { .. }
            | Request::RoundTrunkGet { .. }
            | Request::BlobGet { .. }
            | Request::SessionFork { .. } => Err(unsupported(
                "this portable session does not yet contain a requested round/blob operation",
            )),
            _ => Err(internal("non-session request reached session kernel")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn send(
        &mut self,
        session_id: &str,
        text: String,
        attachments: Vec<genehub_proto::Attachment>,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        self.ensure_loaded(session_id, config, executor, next)?;
        if text.trim().is_empty() && attachments.is_empty() {
            return Err(bad_request("there is nothing to send"));
        }
        let definition = {
            let live = self.live(session_id)?;
            agents::require(boot, config, &live.meta.agent_id)?
        };
        if self.live(session_id)?.active_turn.is_some() {
            return Err(conflict("session is already running"));
        }
        if self.live(session_id)?.meta.pending_permission.is_some() {
            return Err(conflict(
                "answer the waiting interaction before sending again",
            ));
        }

        let (turn_id, timestamp) = identity_and_time(executor, next)?;
        let turn_id = format!("turn_{}", turn_id.trim_start_matches("s_"));
        let user_id = format!("{turn_id}-user");
        let user = TimelineItem::UserMessage {
            id: user_id.clone(),
            text: text.clone(),
            attachments: attachments.clone(),
        };
        {
            let live = self.live_mut(session_id)?;
            if live.meta.title.is_none() {
                live.meta.title = title_from(&text);
            }
            live.meta.updated_at_ms = timestamp;
            live.active_turn = Some(ActiveTurn {
                id: turn_id.clone(),
                started_at_ms: timestamp,
                user_item_id: user_id,
            });
            append_chat(&live.meta, &[user], executor, next)?;
            save_meta(&live.meta, executor, next)?;
        }

        if self.live(session_id)?.process.is_none() {
            let process = start_process(
                self.live(session_id)?,
                definition,
                config,
                &turn_id,
                &attachments,
                executor,
                next,
            )?;
            self.process_to_session
                .insert(process.resource_id, session_id.to_string());
            self.live_mut(session_id)?.process = Some(process);
        }

        let (commands, close_input) = {
            let live = self.live_mut(session_id)?;
            let attachment_paths = codex_attachment_paths(&live.meta, &turn_id, &attachments);
            let process = live.process.as_mut().expect("process just started");
            match &mut process.driver {
                Driver::Claude(driver) => (
                    vec![driver
                        .prompt(&turn_id, text, &attachments)
                        .map_err(internal)?],
                    false,
                ),
                Driver::Codex(driver) => (
                    driver
                        .prompt(&turn_id, text, attachment_paths)
                        .map_err(internal)?,
                    false,
                ),
                Driver::Genet(driver) => (vec![driver.prompt(&turn_id, text)], false),
                Driver::Acp(driver) => (
                    driver
                        .prompt(&turn_id, text, &attachments)
                        .map_err(internal)?,
                    false,
                ),
                Driver::OpenCode(_) => (vec![text.into_bytes()], true),
            }
        };
        let resource_id = self
            .live(session_id)?
            .process
            .as_ref()
            .expect("process exists")
            .resource_id;
        for command in commands {
            process_write(resource_id, command, executor, next)?;
        }
        if close_input {
            process_call(ProcessRequest::CloseInput { resource_id }, executor, next)?;
        }
        let publication = {
            let live = self.live_mut(session_id)?;
            publish(
                live,
                SessionEvent::TurnStarted {
                    turn_id,
                    started_at_ms: timestamp,
                },
            )
        };
        Ok(Response {
            reply: Reply::Ack,
            connection: ConnectionDirective::None,
            publications: vec![publication],
        })
    }

    fn control(
        &mut self,
        session_id: &str,
        control: Control,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let live = self.live_mut(session_id)?;
        let (event, command) = match &control {
            Control::Model(value) => {
                live.meta.model_id = Some(value.clone());
                (
                    SessionEvent::ModelChanged {
                        model_id: value.clone(),
                    },
                    driver_control(live, &control)?,
                )
            }
            Control::Mode(value) => {
                live.meta.mode_id = Some(value.clone());
                (
                    SessionEvent::ModeChanged {
                        mode_id: value.clone(),
                    },
                    driver_control(live, &control)?,
                )
            }
            Control::Effort(value) => {
                live.meta.effort_id = Some(value.clone());
                (
                    SessionEvent::EffortChanged {
                        effort_id: value.clone(),
                    },
                    driver_control(live, &control)?,
                )
            }
        };
        if let Some((resource_id, bytes)) = command {
            process_write(resource_id, bytes, executor, next)?;
        }
        save_meta(&live.meta, executor, next)?;
        let publication = publish(live, event);
        Ok(Response {
            reply: Reply::Ack,
            connection: ConnectionDirective::None,
            publications: vec![publication],
        })
    }

    fn permission(
        &mut self,
        session_id: &str,
        request_id: String,
        outcome: PermissionOutcome,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let live = self.live_mut(session_id)?;
        if live.meta.pending_permission.as_ref().map(|value| &value.id) != Some(&request_id) {
            return Err(not_found(format!("no permission request {request_id}")));
        }
        let command = match live.process.as_mut() {
            Some(process) => match &mut process.driver {
                Driver::Claude(driver) => Some((
                    process.resource_id,
                    driver.respond(&request_id, &outcome).map_err(internal)?,
                )),
                Driver::Codex(driver) => Some((
                    process.resource_id,
                    driver.respond(&request_id, &outcome).map_err(internal)?,
                )),
                Driver::Genet(_) | Driver::OpenCode(_) => None,
                Driver::Acp(driver) => Some((
                    process.resource_id,
                    driver.respond(&request_id, &outcome).map_err(internal)?,
                )),
            },
            None => return Err(conflict("the agent process is no longer running")),
        };
        live.meta.pending_permission = None;
        live.pending_permissions
            .retain(|value| value.id != request_id);
        save_meta(&live.meta, executor, next)?;
        if let Some((resource_id, bytes)) = command {
            process_write(resource_id, bytes, executor, next)?;
        }
        let publication = publish(
            live,
            SessionEvent::PermissionResolved {
                request_id,
                outcome,
            },
        );
        Ok(Response {
            reply: Reply::Ack,
            connection: ConnectionDirective::None,
            publications: vec![publication],
        })
    }

    fn handle_event(
        &mut self,
        event: CapabilityEvent,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<Publication>, ProtocolError> {
        match event {
            CapabilityEvent::ProcessOutput {
                resource_id,
                stream,
                bytes,
            } => {
                let Some(session_id) = self.process_to_session.get(&resource_id).cloned() else {
                    return Ok(Vec::new());
                };
                if stream == ProcessStream::Stderr {
                    let process = self
                        .live_mut(&session_id)?
                        .process
                        .as_mut()
                        .expect("resource map points to process");
                    process.stderr_tail.extend_from_slice(&bytes);
                    if process.stderr_tail.len() > 32 * 1024 {
                        process
                            .stderr_tail
                            .drain(..process.stderr_tail.len() - 32 * 1024);
                    }
                    return Ok(Vec::new());
                }
                let (events, writes, persistence) = {
                    let process = self
                        .live_mut(&session_id)?
                        .process
                        .as_mut()
                        .expect("resource map points to process");
                    process.stdout.extend_from_slice(&bytes);
                    let lines = complete_lines(&mut process.stdout);
                    let mut events = Vec::new();
                    let mut writes = Vec::new();
                    let mut persistence = None;
                    for line in lines {
                        match &mut process.driver {
                            Driver::Claude(driver) => {
                                let output = driver.line(&line);
                                events.extend(output.events);
                                writes.extend(output.writes);
                                if output.persistence.is_some() {
                                    persistence = output.persistence;
                                }
                            }
                            Driver::Codex(driver) => {
                                let output = driver.line(&line);
                                events.extend(output.events);
                                writes.extend(output.writes);
                                if output.persistence.is_some() {
                                    persistence = output.persistence;
                                }
                            }
                            Driver::Genet(driver) => events.extend(driver.line(&line)),
                            Driver::Acp(driver) => {
                                let output = driver.line(&line);
                                events.extend(output.events);
                                writes.extend(output.writes);
                                if output.persistence.is_some() {
                                    persistence = output.persistence;
                                }
                            }
                            Driver::OpenCode(driver) => events.extend(driver.line(&line)),
                        }
                    }
                    (events, writes, persistence)
                };
                for write in writes {
                    process_write(resource_id, write, executor, next)?;
                }
                if let Some(value) = persistence {
                    let agent_id = match self
                        .live(&session_id)?
                        .process
                        .as_ref()
                        .map(|process| &process.driver)
                    {
                        Some(Driver::Claude(_)) => "claude",
                        Some(Driver::Acp(_)) => self
                            .live(&session_id)?
                            .process
                            .as_ref()
                            .map(|process| process.definition.id.as_str())
                            .unwrap_or("acp"),
                        _ => "codex",
                    };
                    self.live_mut(&session_id)?.meta.persist = Some(PersistHandle {
                        agent_id: agent_id.to_string(),
                        value,
                    });
                }
                if let Some(remote_id) = self
                    .live(&session_id)?
                    .process
                    .as_ref()
                    .and_then(|process| match &process.driver {
                        Driver::OpenCode(driver) => driver.session_id(),
                        _ => None,
                    })
                    .map(str::to_string)
                {
                    self.live_mut(&session_id)?.meta.persist = Some(PersistHandle {
                        agent_id: "opencode".to_string(),
                        value: serde_json::json!({ "sessionId": remote_id }),
                    });
                }
                self.apply_events(&session_id, events, executor, next)
            }
            CapabilityEvent::ProcessExited { resource_id, code } => {
                let Some(session_id) = self.process_to_session.remove(&resource_id) else {
                    return Ok(Vec::new());
                };
                let live = self.live_mut(&session_id)?;
                let tail = live
                    .process
                    .take()
                    .map(|process| {
                        String::from_utf8_lossy(&process.stderr_tail)
                            .trim()
                            .to_string()
                    })
                    .unwrap_or_default();
                let Some(turn) = live.active_turn.take() else {
                    return Ok(Vec::new());
                };
                let suffix = if tail.is_empty() {
                    String::new()
                } else {
                    format!(": {tail}")
                };
                self.apply_events(
                    &session_id,
                    vec![SessionEvent::TurnFailed {
                        turn_id: turn.id,
                        error: genehub_proto::TurnError {
                            code: genehub_proto::TurnErrorCode::AgentCrashed,
                            message: format!("Agent exited with code {code:?}{suffix}"),
                        },
                    }],
                    executor,
                    next,
                )
            }
            _ => Ok(Vec::new()),
        }
    }

    fn apply_events(
        &mut self,
        session_id: &str,
        events: Vec<SessionEvent>,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<Publication>, ProtocolError> {
        let mut publications = Vec::new();
        for event in events {
            let mut settled = Vec::new();
            {
                let live = self.live_mut(session_id)?;
                fold(live, &event, &mut settled);
                publications.push(publish(live, event));
            }
            if !settled.is_empty() {
                let live = self.live(session_id)?;
                append_chat(&live.meta, &settled, executor, next)?;
                save_meta(&live.meta, executor, next)?;
            }
        }
        Ok(publications)
    }

    fn load_catalog(
        &mut self,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        for workspace in config
            .workspaces
            .iter()
            .filter(|workspace| !workspace.removed)
        {
            let Some(folder) = workspace.folders.first() else {
                continue;
            };
            let root = FileRoot::Workspace {
                handle: folder.root_handle.clone(),
            };
            let mut client = Client::new(executor, next);
            let entries = match client.call_raw(CapabilityRequest::File(FileRequest::List {
                locator: FileLocator {
                    root: root.clone(),
                    path: ".genethub/sessions".to_string(),
                },
            }))? {
                Ok(CapabilityValue::FileEntries(entries)) => entries,
                Err(error)
                    if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound =>
                {
                    continue
                }
                Ok(_) => {
                    return Err(internal(
                        "session directory listing returned the wrong value",
                    ))
                }
                Err(error) => return Err(capability_error(error)),
            };
            for entry in entries
                .into_iter()
                .filter(|entry| entry.kind == FileKind::Directory)
            {
                if self.loaded.contains_key(&entry.name) {
                    continue;
                }
                if let Ok(meta) = load_meta(
                    root.clone(),
                    &entry.name,
                    &workspace.id,
                    &folder.root_handle,
                    &folder.root,
                    executor,
                    next,
                ) {
                    self.loaded.insert(
                        meta.id.clone(),
                        LiveSession {
                            pending_permissions: meta
                                .pending_permission
                                .clone()
                                .into_iter()
                                .collect(),
                            meta,
                            seq: 0,
                            replay: VecDeque::new(),
                            process: None,
                            active_items: Vec::new(),
                            active_turn: None,
                        },
                    );
                }
            }
        }
        Ok(())
    }

    fn ensure_loaded(
        &mut self,
        id: &str,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        if !self.loaded.contains_key(id) {
            self.load_catalog(config, executor, next)?;
        }
        if self.loaded.contains_key(id) {
            Ok(())
        } else {
            Err(not_found(format!("no such session: {id}")))
        }
    }

    fn live(&self, id: &str) -> Result<&LiveSession, ProtocolError> {
        self.loaded
            .get(id)
            .ok_or_else(|| not_found(format!("no such session: {id}")))
    }

    fn live_mut(&mut self, id: &str) -> Result<&mut LiveSession, ProtocolError> {
        self.loaded
            .get_mut(id)
            .ok_or_else(|| not_found(format!("no such session: {id}")))
    }
}

enum Control {
    Model(String),
    Mode(String),
    Effort(String),
}

fn driver_control(
    live: &mut LiveSession,
    control: &Control,
) -> Result<Option<(u64, Vec<u8>)>, ProtocolError> {
    let Some(process) = live.process.as_mut() else {
        return Ok(None);
    };
    let bytes = match (&mut process.driver, control) {
        (Driver::Claude(driver), Control::Model(model)) => {
            driver.set_model(model).map_err(bad_request)?
        }
        (Driver::Claude(driver), Control::Mode(mode)) => {
            driver.set_mode(mode).map_err(bad_request)?
        }
        (Driver::Claude(driver), Control::Effort(effort)) => {
            driver.set_effort(effort).map_err(bad_request)?
        }
        (Driver::Codex(driver), Control::Model(model)) => {
            driver.set_model(model);
            return Ok(None);
        }
        (Driver::Codex(driver), Control::Mode(mode)) => {
            driver.set_mode(mode).map_err(bad_request)?;
            return Ok(None);
        }
        (Driver::Codex(driver), Control::Effort(effort)) => {
            driver.set_effort(effort);
            return Ok(None);
        }
        (Driver::Genet(driver), Control::Model(model)) => driver.set_model(model)?,
        (Driver::Genet(driver), Control::Mode(mode)) => driver.set_effort(mode)?,
        (Driver::Genet(driver), Control::Effort(effort)) => driver.set_effort(effort)?,
        (Driver::Acp(driver), Control::Model(model)) => {
            let Some(bytes) = driver.set_model(model).map_err(bad_request)? else {
                return Ok(None);
            };
            bytes
        }
        (Driver::Acp(driver), Control::Mode(mode)) => {
            let Some(bytes) = driver.set_mode(mode).map_err(bad_request)? else {
                return Ok(None);
            };
            bytes
        }
        (Driver::Acp(_), Control::Effort(_)) => {
            return Err(unsupported("ACP does not expose an effort control"))
        }
        (Driver::OpenCode(_), Control::Model(_) | Control::Effort(_)) => return Ok(None),
        (Driver::OpenCode(_), Control::Mode(_)) => {
            return Err(unsupported("OpenCode does not expose switchable modes"))
        }
    };
    Ok(Some((process.resource_id, bytes)))
}

fn start_process(
    live: &LiveSession,
    definition: AgentDefinition,
    config: &Config,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<AgentProcess, ProtocolError> {
    let mut args = definition.args().to_vec();
    let mut env = std::collections::BTreeMap::new();
    let driver = match definition.kind.clone() {
        AgentKind::Claude => {
            args.extend([
                "--print".to_string(),
                "--input-format".to_string(),
                "stream-json".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--include-partial-messages".to_string(),
                "--verbose".to_string(),
                "--permission-prompt-tool".to_string(),
                "stdio".to_string(),
                "--allow-dangerously-skip-permissions".to_string(),
                "--settings".to_string(),
                r#"{"sandbox":{"enabled":false}}"#.to_string(),
                "--permission-mode".to_string(),
                live.meta
                    .mode_id
                    .clone()
                    .unwrap_or_else(|| "bypassPermissions".to_string()),
            ]);
            if let Some(model) = &live.meta.model_id {
                args.extend(["--model".to_string(), model.clone()]);
            }
            if let Some(effort) = &live.meta.effort_id {
                args.extend(["--effort".to_string(), effort.clone()]);
            }
            let session_id = live
                .meta
                .persist
                .as_ref()
                .filter(|persist| persist.agent_id == "claude")
                .and_then(|persist| persist.value.get("sessionId"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            if let Some(session_id) = &session_id {
                args.extend(["--resume".to_string(), session_id.clone()]);
            }
            Driver::Claude(claude::Driver::new(
                live.meta.mode_id.as_deref(),
                session_id,
            ))
        }
        AgentKind::Codex => {
            args.extend([
                "app-server".to_string(),
                "-c".to_string(),
                "approval_policy=\"never\"".to_string(),
                "-c".to_string(),
                "sandbox_mode=\"danger-full-access\"".to_string(),
            ]);
            write_codex_attachments(live, turn_id, attachments, executor, next)?;
            Driver::Codex(codex::Driver::new(
                live.meta
                    .persist
                    .as_ref()
                    .filter(|persist| persist.agent_id == "codex")
                    .map(|persist| &persist.value),
                live.meta.mode_id.as_deref(),
                live.meta.model_id.as_deref(),
                live.meta.effort_id.as_deref(),
            ))
        }
        AgentKind::Genet => {
            args.extend(["--mode".to_string(), "rpc".to_string()]);
            if let Some(model) = &live.meta.model_id {
                args.extend(["--model".to_string(), model.clone()]);
            }
            if let Some(effort) = live.meta.effort_id.as_ref().or(live.meta.mode_id.as_ref()) {
                args.extend(["--thinking".to_string(), effort.clone()]);
            }
            let home = format!(".genethub/sessions/{}/state/genet", live.meta.id);
            write_genet_models(&live.meta, &home, config, executor, next)?;
            env.insert(
                "GENET_AGENT_HOME".to_string(),
                native_child_path(&live.meta, &home),
            );
            args.extend([
                "--session".to_string(),
                native_child_path(&live.meta, &format!("{home}/session.jsonl")),
            ]);
            Driver::Genet(genet::Driver::default())
        }
        AgentKind::OpenCode => {
            args.extend([
                "run".to_string(),
                "--format".to_string(),
                "json".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ]);
            if let Some(session_id) = live
                .meta
                .persist
                .as_ref()
                .filter(|persist| persist.agent_id == "opencode")
                .and_then(|persist| persist.value.get("sessionId"))
                .and_then(serde_json::Value::as_str)
            {
                args.extend(["--session".to_string(), session_id.to_string()]);
            }
            if let Some(model) = &live.meta.model_id {
                args.extend(["--model".to_string(), model.clone()]);
            }
            if let Some(effort) = &live.meta.effort_id {
                args.extend(["--variant".to_string(), effort.clone()]);
            }
            args.extend(opencode_attachments(
                live,
                turn_id,
                attachments,
                executor,
                next,
            )?);
            Driver::OpenCode(opencode::Driver::new(
                turn_id.to_string(),
                live.meta
                    .persist
                    .as_ref()
                    .filter(|persist| persist.agent_id == "opencode")
                    .and_then(|persist| persist.value.get("sessionId"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            ))
        }
        AgentKind::Acp => Driver::Acp(acp::Driver::new(
            &definition.id,
            live.meta.root.clone(),
            live.meta
                .persist
                .as_ref()
                .filter(|persist| persist.agent_id == definition.id)
                .map(|persist| &persist.value),
            live.meta.model_id.as_deref(),
            live.meta.mode_id.as_deref(),
        )),
    };
    let mut client = Client::new(executor, next);
    let value = client.call(CapabilityRequest::Process(ProcessRequest::Spawn(
        ProcessSpec {
            program: definition
                .program()
                .ok_or_else(|| bad_request("agent command is empty"))?
                .to_string(),
            args,
            env,
            cwd: Some(FileLocator {
                root: FileRoot::Workspace {
                    handle: live.meta.root_handle.clone(),
                },
                path: String::new(),
            }),
            capture_stdout: true,
            capture_stderr: true,
        },
    )))?;
    let resource_id = match value {
        CapabilityValue::ProcessStarted { resource_id, .. } => resource_id,
        _ => return Err(internal("process spawn returned the wrong value")),
    };
    Ok(AgentProcess {
        resource_id,
        definition,
        stdout: Vec::new(),
        stderr_tail: Vec::new(),
        driver,
    })
}

fn write_genet_models(
    meta: &SessionMeta,
    home: &str,
    config: &Config,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let models = config
        .agents
        .providers
        .iter()
        .flat_map(|(provider, value)| {
            value.models.iter().map(move |model| {
                serde_json::json!({
                    "id": model,
                    "name": format!("{provider}/{model}"),
                    "provider": provider,
                    "api": value.dialect.clone().unwrap_or_else(|| "openai".to_string()),
                    "baseUrl": value.base_url,
                    "apiKey": value.api_key,
                })
            })
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "models": models }))
        .map_err(|error| internal(format!("encoding Agent models: {error}")))?;
    let mut client = Client::new(executor, next);
    client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
        locator: locator(meta, home),
    }))?;
    client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(meta, &format!("{home}/models.json")),
        bytes,
    }))?;
    Ok(())
}

fn opencode_attachments(
    live: &LiveSession,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<String>, ProtocolError> {
    use base64::Engine as _;

    let relative_dir = format!(
        ".genethub/sessions/{}/state/opencode/attachments",
        live.meta.id
    );
    let mut args = Vec::new();
    let mut created = false;
    for (index, attachment) in attachments.iter().enumerate() {
        let Some(encoded) = attachment.data_base64.as_deref() else {
            continue;
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                encoded
                    .chars()
                    .filter(|value| !value.is_whitespace())
                    .collect::<String>(),
            )
            .map_err(|error| bad_request(format!("invalid attachment base64: {error}")))?;
        if !created {
            let mut client = Client::new(executor, next);
            client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
                locator: locator(&live.meta, &relative_dir),
            }))?;
            created = true;
        }
        let extension = match attachment.mime.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "application/pdf" => "pdf",
            _ => "bin",
        };
        let relative = format!("{relative_dir}/{turn_id}-{index}.{extension}");
        let mut client = Client::new(executor, next);
        client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
            locator: locator(&live.meta, &relative),
            bytes,
        }))?;
        args.extend([
            "--file".to_string(),
            native_child_path(&live.meta, &relative),
        ]);
    }
    Ok(args)
}

fn write_codex_attachments(
    live: &LiveSession,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    use base64::Engine as _;

    let paths = codex_attachment_relatives(&live.meta, turn_id, attachments);
    if paths.is_empty() {
        return Ok(());
    }
    let relative_dir = format!(
        ".genethub/sessions/{}/state/codex/attachments",
        live.meta.id
    );
    let mut client = Client::new(executor, next);
    client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
        locator: locator(&live.meta, &relative_dir),
    }))?;
    for (attachment, relative) in attachments
        .iter()
        .filter(|value| value.data_base64.is_some() && value.mime.starts_with("image/"))
        .zip(paths)
    {
        let encoded = attachment.data_base64.as_deref().unwrap_or_default();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                encoded
                    .chars()
                    .filter(|value| !value.is_whitespace())
                    .collect::<String>(),
            )
            .map_err(|error| bad_request(format!("invalid attachment base64: {error}")))?;
        let mut client = Client::new(executor, next);
        client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
            locator: locator(&live.meta, &relative),
            bytes,
        }))?;
    }
    Ok(())
}

fn codex_attachment_relatives(
    meta: &SessionMeta,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
) -> Vec<String> {
    attachments
        .iter()
        .filter(|value| value.data_base64.is_some() && value.mime.starts_with("image/"))
        .enumerate()
        .map(|(index, value)| {
            let extension = match value.mime.as_str() {
                "image/jpeg" | "image/jpg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => "png",
            };
            format!(
                ".genethub/sessions/{}/state/codex/attachments/{turn_id}-{index}.{extension}",
                meta.id
            )
        })
        .collect()
}

fn codex_attachment_paths(
    meta: &SessionMeta,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
) -> Vec<String> {
    codex_attachment_relatives(meta, turn_id, attachments)
        .into_iter()
        .map(|relative| native_child_path(meta, &relative))
        .collect()
}

fn native_child_path(meta: &SessionMeta, relative: &str) -> String {
    let separator = if meta.root.contains('\\') { '\\' } else { '/' };
    format!(
        "{}{}{}",
        meta.root.trim_end_matches(['/', '\\']),
        separator,
        relative.replace('/', &separator.to_string())
    )
}

fn process_call(
    request: ProcessRequest,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Process(request))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("process operation returned the wrong value")),
    }
}

fn process_write(
    resource_id: u64,
    mut bytes: Vec<u8>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    process_call(ProcessRequest::Write { resource_id, bytes }, executor, next)
}

fn complete_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    let mut consumed = 0;
    while let Some(relative) = buffer[consumed..].iter().position(|byte| *byte == b'\n') {
        let end = consumed + relative;
        let line = String::from_utf8_lossy(&buffer[consumed..end])
            .trim_end_matches('\r')
            .to_string();
        consumed = end + 1;
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }
    if consumed > 0 {
        buffer.drain(..consumed);
    }
    if buffer.len() > 3 * 1024 * 1024 {
        buffer.clear();
    }
    lines
}

fn fold(live: &mut LiveSession, event: &SessionEvent, settled: &mut Vec<TimelineItem>) {
    match event {
        SessionEvent::Item { item, .. } => upsert(&mut live.active_items, item.clone()),
        SessionEvent::ItemDelta { item_id, delta, .. } => {
            if let Some(item) = live
                .active_items
                .iter_mut()
                .find(|item| item.id() == item_id)
            {
                match delta {
                    genehub_proto::ItemDelta::Text { delta } => {
                        item.append_text(delta);
                    }
                    genehub_proto::ItemDelta::ToolStatus { status, detail } => {
                        if let TimelineItem::ToolCall {
                            status: current,
                            detail: current_detail,
                            ..
                        } = item
                        {
                            *current = *status;
                            if let Some(detail) = detail {
                                *current_detail = detail.clone();
                            }
                        }
                    }
                }
            }
        }
        SessionEvent::PermissionRequested { request } => {
            live.meta.pending_permission = Some(request.clone());
            live.pending_permissions = vec![request.clone()];
        }
        SessionEvent::PermissionResolved { request_id, .. } => {
            live.meta.pending_permission = None;
            live.pending_permissions
                .retain(|value| value.id != *request_id);
        }
        SessionEvent::TurnCompleted {
            turn_id,
            usage,
            fork_checkpoint,
        } => settle(
            live,
            turn_id,
            genehub_proto::TurnOutcome::Completed,
            usage.clone(),
            fork_checkpoint.clone(),
            settled,
        ),
        SessionEvent::TurnFailed { turn_id, error } => {
            let id = format!("{turn_id}-error");
            upsert(
                &mut live.active_items,
                TimelineItem::Error {
                    id,
                    message: error.message.clone(),
                },
            );
            settle(
                live,
                turn_id,
                genehub_proto::TurnOutcome::Failed,
                genehub_proto::Usage::default(),
                None,
                settled,
            );
        }
        SessionEvent::TurnCanceled { turn_id } => settle(
            live,
            turn_id,
            genehub_proto::TurnOutcome::Canceled,
            genehub_proto::Usage::default(),
            None,
            settled,
        ),
        SessionEvent::ModelChanged { model_id } => live.meta.model_id = Some(model_id.clone()),
        SessionEvent::ModeChanged { mode_id } => live.meta.mode_id = Some(mode_id.clone()),
        SessionEvent::EffortChanged { effort_id } => live.meta.effort_id = Some(effort_id.clone()),
        SessionEvent::TitleChanged { title } => live.meta.title = Some(title.clone()),
        SessionEvent::SessionStatusChanged { .. } | SessionEvent::TurnStarted { .. } => {}
    }
}

fn settle(
    live: &mut LiveSession,
    turn_id: &str,
    outcome: genehub_proto::TurnOutcome,
    usage: genehub_proto::Usage,
    fork_checkpoint: Option<String>,
    settled: &mut Vec<TimelineItem>,
) {
    let active = live.active_turn.take();
    let started_at_ms = active
        .as_ref()
        .map(|active| active.started_at_ms)
        .unwrap_or(live.meta.updated_at_ms);
    let finished_at_ms = live.meta.updated_at_ms.max(started_at_ms);
    settled.append(&mut live.active_items);
    settled.push(TimelineItem::TurnSummary {
        id: format!("{turn_id}-summary"),
        stats: genehub_proto::TurnStats {
            turn_id: turn_id.to_string(),
            outcome,
            started_at_ms,
            finished_at_ms,
            duration_ms: finished_at_ms.saturating_sub(started_at_ms) as u64,
            usage,
            tool_calls: settled
                .iter()
                .filter(|item| matches!(item, TimelineItem::ToolCall { .. }))
                .count() as u64,
            fork_checkpoint,
        },
    });
}

fn upsert(items: &mut Vec<TimelineItem>, item: TimelineItem) {
    match items.iter_mut().find(|existing| existing.id() == item.id()) {
        Some(existing) => *existing = item,
        None => items.push(item),
    }
}

fn publish(live: &mut LiveSession, event: SessionEvent) -> Publication {
    live.seq = live.seq.saturating_add(1);
    let sequenced = SequencedEvent {
        seq: live.seq,
        session_id: live.meta.id.clone(),
        event,
    };
    live.replay.push_back(sequenced.clone());
    trim_replay(live);
    Publication::Session(sequenced)
}

fn trim_replay(live: &mut LiveSession) {
    while live.replay.len() > 2048 || encoded_len(&live.replay) > REPLAY_BYTES {
        live.replay.pop_front();
    }
}

fn encoded_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn snapshot(
    live: &LiveSession,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SessionSnapshot, ProtocolError> {
    let mut items = load_chat(&live.meta, executor, next)?;
    for item in &live.active_items {
        upsert(&mut items, item.clone());
    }
    Ok(SessionSnapshot {
        summary: summary(&live.meta, status(live)),
        items,
        seq: live.seq,
        pending_permissions: live.pending_permissions.clone(),
        rounds: None,
        expanded_round: None,
    })
}

fn summary(meta: &SessionMeta, status: SessionStatus) -> SessionSummary {
    SessionSummary {
        id: meta.id.clone(),
        workspace_id: meta.workspace_id.clone(),
        agent_id: meta.agent_id.clone(),
        title: meta.title.clone(),
        status,
        model_id: meta.model_id.clone(),
        mode_id: meta.mode_id.clone(),
        effort_id: meta.effort_id.clone(),
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        archived: meta.archived,
        unsupported: None,
    }
}

fn status(live: &LiveSession) -> SessionStatus {
    if live.meta.pending_permission.is_some() {
        SessionStatus::Waiting
    } else if live.active_turn.is_some() {
        SessionStatus::Running
    } else {
        SessionStatus::Idle
    }
}

fn workspace<'a>(config: &'a Config, id: &str) -> Result<&'a WorkspaceEntry, ProtocolError> {
    config
        .workspaces
        .iter()
        .find(|workspace| workspace.id == id && !workspace.removed)
        .ok_or_else(|| not_found(format!("no such workspace: {id}")))
}

fn establish(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let mut client = Client::new(executor, next);
    client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
        locator: locator(meta, &format!(".genethub/sessions/{}", meta.id)),
    }))?;
    client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(meta, ".genethub/.gitignore"),
        bytes: b"*\n".to_vec(),
    }))?;
    Ok(())
}

fn save_meta(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let bytes = serde_json::to_vec_pretty(meta)
        .map_err(|error| internal(format!("encoding session meta: {error}")))?;
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(meta, &format!(".genethub/sessions/{}/meta.json", meta.id)),
        bytes,
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("session meta write returned the wrong value")),
    }
}

fn load_meta(
    root: FileRoot,
    id: &str,
    workspace_id: &str,
    root_handle: &str,
    native_root: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<SessionMeta, ProtocolError> {
    let mut client = Client::new(executor, next);
    let bytes = match client.call(CapabilityRequest::File(FileRequest::Read {
        locator: FileLocator {
            root,
            path: format!(".genethub/sessions/{id}/meta.json"),
        },
        max_bytes: META_BYTES,
    }))? {
        CapabilityValue::Bytes(bytes) => bytes,
        _ => return Err(internal("session meta read returned the wrong value")),
    };
    let mut meta: SessionMeta = serde_json::from_slice(&bytes)
        .map_err(|error| internal(format!("parsing session {id} meta: {error}")))?;
    if meta.id != id || meta.format > SESSION_FORMAT {
        return Err(unsupported(format!(
            "session {id} has an unsupported format"
        )));
    }
    meta.workspace_id = workspace_id.to_string();
    meta.root_handle = root_handle.to_string();
    if meta.root.is_empty() {
        meta.root = native_root.to_string();
    }
    Ok(meta)
}

fn append_chat(
    meta: &SessionMeta,
    items: &[TimelineItem],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    if items.is_empty() {
        return Ok(());
    }
    let mut bytes = Vec::new();
    for item in items {
        let mut row = serde_json::to_vec(&ChatRow::Item { item: item.clone() })
            .map_err(|error| internal(format!("encoding session item: {error}")))?;
        bytes.append(&mut row);
        bytes.push(b'\n');
    }
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Append {
        locator: locator(meta, &format!(".genethub/sessions/{}/chat.jsonl", meta.id)),
        bytes,
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("session chat append returned the wrong value")),
    }
}

fn load_chat(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<TimelineItem>, ProtocolError> {
    let mut client = Client::new(executor, next);
    let result = client.call_raw(CapabilityRequest::File(FileRequest::Read {
        locator: locator(meta, &format!(".genethub/sessions/{}/chat.jsonl", meta.id)),
        max_bytes: CHAT_BYTES,
    }))?;
    let bytes = match result {
        Ok(CapabilityValue::Bytes(bytes)) => bytes,
        Err(error) if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound => {
            return Ok(Vec::new())
        }
        Err(error) => return Err(capability_error(error)),
        Ok(_) => return Err(internal("session chat read returned the wrong value")),
    };
    let mut items = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(ChatRow::Item { item }) = serde_json::from_slice::<ChatRow>(line) {
            upsert(&mut items, item);
        }
    }
    Ok(items)
}

fn remove_session(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::RemoveDirAll {
        locator: locator(meta, &format!(".genethub/sessions/{}", meta.id)),
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("session removal returned the wrong value")),
    }
}

fn locator(meta: &SessionMeta, path: &str) -> FileLocator {
    FileLocator {
        root: FileRoot::Workspace {
            handle: meta.root_handle.clone(),
        },
        path: path.to_string(),
    }
}

fn identity_and_time(
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(String, i64), ProtocolError> {
    let mut client = Client::new(executor, next);
    let bytes = match client.call(CapabilityRequest::Random { bytes: 16 })? {
        CapabilityValue::Bytes(bytes) if bytes.len() == 16 => bytes,
        _ => return Err(internal("random capability returned the wrong value")),
    };
    let timestamp = match client.call(CapabilityRequest::Clock)? {
        CapabilityValue::Clock { unix_millis, .. } => unix_millis,
        _ => return Err(internal("clock capability returned the wrong value")),
    };
    Ok((
        format!(
            "s_{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ),
        timestamp,
    ))
}

fn now(executor: &mut impl CapabilityExecutor, next: &mut u64) -> Result<i64, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Clock)? {
        CapabilityValue::Clock { unix_millis, .. } => Ok(unix_millis),
        _ => Err(internal("clock capability returned the wrong value")),
    }
}

fn normalize_title(title: Option<String>) -> Option<String> {
    title.and_then(|title| {
        let title = title.trim().chars().take(120).collect::<String>();
        (!title.is_empty()).then_some(title)
    })
}

fn title_from(text: &str) -> Option<String> {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .map(|line| line.chars().take(60).collect())
}

fn capability_error(error: genet_daemon_logic_api::CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            genet_daemon_logic_api::CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            genet_daemon_logic_api::CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            genet_daemon_logic_api::CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            genet_daemon_logic_api::CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            _ => ErrorCode::Internal,
        },
        message: error.message,
    }
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn not_found(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::NotFound,
        message: message.into(),
    }
}

fn conflict(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Conflict,
        message: message.into(),
    }
}

fn unsupported(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Unsupported,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}
