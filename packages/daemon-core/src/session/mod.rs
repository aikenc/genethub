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
mod overview;
mod rounds;

use std::collections::{HashMap, VecDeque};

use genehub_proto::{
    BlobKind, BlobOverview, BlobPayload, BlobRef, ErrorCode, PermissionOutcome, ProtocolError,
    Reply, Request, RoundBatch, RoundBatchSummary, RoundLayer, RoundTrunk, RoundTrunkSummary,
    SequencedEvent, SessionEvent, SessionSnapshot, SessionStatus, SessionSummary, TimelineItem,
};
use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityRequest, CapabilityValue, ConnectionDirective, FileKind,
    FileLocator, FileRequest, FileRoot, LogicCompletion, LogicOutcome, LogicOutput, ProcessRequest,
    ProcessSignal, ProcessSpec, ProcessStream, Publication,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::agents::{self, AgentDefinition, AgentKind};
use crate::capability::Client;
use crate::config::{Config, WorkspaceEntry, WorkspaceFolderEntry};
use crate::CapabilityExecutor;

const SESSION_FORMAT: u32 = 4;
const META_BYTES: u32 = 1024 * 1024;
const CHAT_BYTES: u32 = 3 * 1024 * 1024;
const FILE_CHUNK_BYTES: u32 = 1024 * 1024;
const BLOB_ID_CHARS: usize = 24;
const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;
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
    /// Opaque native handle for `<session>/writer.lock`. It is serialized so
    /// guest hot replacement cannot accidentally open a second writer.
    lock_resource_id: u64,
    seq: u64,
    replay: VecDeque<SequencedEvent>,
    #[serde(default = "default_replay_window")]
    replay_window: usize,
    pending_permissions: Vec<genehub_proto::PermissionRequest>,
    process: Option<AgentProcess>,
    active_items: Vec<TimelineItem>,
    active_turn: Option<ActiveTurn>,
    rounds: Vec<rounds::RoundRecord>,
    #[serde(default)]
    closed: bool,
    #[serde(default)]
    settled_status: Option<SessionStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    format: u32,
    id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    project_key: String,
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
    round_id: String,
    interrupted: bool,
}

struct SettledTurn {
    round_id: String,
    turn_id: String,
    outcome: Option<rounds::RoundOutcome>,
    items: Vec<TimelineItem>,
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
    Round { round: rounds::RoundRecord },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum TrunkRow {
    #[serde(rename_all = "camelCase")]
    Batch {
        index: u32,
        first_item_id: String,
        blob_count: u32,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monologue: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Blob {
        item_id: String,
        kind: BlobKind,
        overview: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob: Option<BlobRef>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRecord {
    id: String,
    value: Value,
}

#[derive(Default)]
struct ChatLog {
    items: Vec<TimelineItem>,
    rounds: Vec<rounds::RoundRecord>,
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
                // Close releases the live agent process; it does not make the
                // durable conversation read-only. Subscribing is the explicit
                // reopen operation used by every client before it can send.
                self.live_mut(&session_id)?.closed = false;
                let live = self.live(&session_id)?;
                let snapshot = snapshot(live, executor, next)?;
                let first = live
                    .replay
                    .front()
                    .map(|event| event.seq)
                    .unwrap_or(live.seq + 1);
                let (replayed, reset) = match since_seq {
                    // A layered snapshot already carries the narrative and a
                    // bounded last-round tail. Replaying all work history from
                    // zero would duplicate it and defeat that byte budget.
                    None | Some(0) => (Vec::new(), true),
                    Some(seq) if seq == live.seq => (Vec::new(), false),
                    Some(seq) if seq.saturating_add(1) < first => (Vec::new(), true),
                    Some(seq) => (
                        live.replay
                            .iter()
                            .filter(|event| event.seq > seq)
                            .cloned()
                            .collect(),
                        false,
                    ),
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
                    project_key: workspace_project_key(workspace),
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
                let lock_resource_id = lock_session(&meta, executor, next)?;
                save_meta(&meta, executor, next)?;
                let summary = summary(&meta, SessionStatus::Idle);
                self.loaded.insert(
                    meta.id.clone(),
                    LiveSession {
                        meta,
                        lock_resource_id,
                        seq: 0,
                        replay: VecDeque::new(),
                        replay_window: config.replay_window.max(1),
                        pending_permissions: Vec::new(),
                        process: None,
                        active_items: Vec::new(),
                        active_turn: None,
                        rounds: Vec::new(),
                        closed: false,
                        settled_status: None,
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
                continues_round,
                ..
            } => self.send(
                &session_id,
                text,
                attachments,
                continues_round,
                boot,
                config,
                executor,
                next,
            ),
            Request::SessionInterrupt { session_id } => {
                let live = self.live_mut(&session_id)?;
                if let Some(turn) = live.active_turn.as_mut() {
                    turn.interrupted = true;
                }
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
                let mut publications = Vec::new();
                if let Some(turn) = self.live_mut(&session_id)?.active_turn.as_mut() {
                    turn.interrupted = false;
                }
                if let Some(turn_id) = self
                    .live(&session_id)?
                    .active_turn
                    .as_ref()
                    .map(|turn| turn.id.clone())
                {
                    publications.extend(self.apply_events(
                        &session_id,
                        vec![SessionEvent::TurnCanceled { turn_id }],
                        executor,
                        next,
                    )?);
                }
                let process = {
                    let live = self.live_mut(&session_id)?;
                    let process = live.process.take();
                    live.active_turn = None;
                    live.closed = true;
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
                let publication = {
                    let live = self.live_mut(&session_id)?;
                    publish(
                        live,
                        SessionEvent::SessionStatusChanged {
                            status: SessionStatus::Closed,
                        },
                    )
                };
                publications.push(publication);
                Ok(Response {
                    reply: Reply::Ack,
                    connection: ConnectionDirective::None,
                    publications,
                })
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
                    unlock_session(live.lock_resource_id, executor, next)?;
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
            Request::RoundTrunkList {
                session_id,
                round_id,
                cursor,
                limit,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                let layer = round_layer(
                    self.live(&session_id)?,
                    &round_id,
                    cursor.as_deref(),
                    limit.unwrap_or(20),
                    false,
                    executor,
                    next,
                )?;
                Ok(Response::reply(Reply::RoundLayer(layer)))
            }
            Request::RoundTrunkGet {
                session_id,
                round_id,
                trunk_index,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                let live = self.live(&session_id)?;
                let round = require_round(live, &round_id)?;
                let summary = load_trunk_index(&live.meta, round.ord, executor, next)?
                    .into_iter()
                    .find(|summary| summary.index == trunk_index)
                    .ok_or_else(|| not_found(format!("no such trunk: {trunk_index}")))?;
                Ok(Response::reply(Reply::RoundTrunk(load_trunk(
                    &live.meta, round.ord, &summary, executor, next,
                )?)))
            }
            Request::BlobGet { session_id, blob } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                Ok(Response::reply(Reply::Blob(get_blob(
                    &self.live(&session_id)?.meta,
                    &blob,
                    executor,
                    next,
                )?)))
            }
            Request::SessionFork {
                session_id,
                turn_id,
            } => self.fork(&session_id, &turn_id, boot, config, executor, next),
            _ => Err(internal("non-session request reached session kernel")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn send(
        &mut self,
        session_id: &str,
        text: String,
        attachments: Vec<genehub_proto::Attachment>,
        continues_round: Option<String>,
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
        if self.live(session_id)?.closed {
            return Err(conflict("session is closed"));
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
        let mut assigned_title = None;
        {
            let live = self.live_mut(session_id)?;
            let mut rows = Vec::new();
            for round in live
                .rounds
                .iter_mut()
                .filter(|round| round.outcome.is_none())
            {
                if continues_round.as_deref() != Some(round.round_id.as_str()) {
                    round.outcome = Some(rounds::RoundOutcome::Superseded);
                    round.ended_at_ms = timestamp;
                    rows.push(ChatRow::Round {
                        round: round.clone(),
                    });
                }
            }
            let round_id = match continues_round.as_deref().and_then(|id| {
                live.rounds
                    .iter_mut()
                    .find(|round| round.round_id == id && round.outcome.is_none())
            }) {
                Some(round) => {
                    if !round.adapter_turn_ids.iter().any(|id| id == &turn_id) {
                        round.adapter_turn_ids.push(turn_id.clone());
                    }
                    rows.push(ChatRow::Round {
                        round: round.clone(),
                    });
                    round.round_id.clone()
                }
                None => {
                    let round = rounds::RoundRecord {
                        schema_version: rounds::SCHEMA_VERSION,
                        round_id: format!("r_{}", turn_id.trim_start_matches("turn_")),
                        ord: live.rounds.len() as u32,
                        user_item_id: Some(user_id.clone()),
                        started_at_ms: timestamp,
                        ended_at_ms: 0,
                        outcome: None,
                        adapter_turn_ids: vec![turn_id.clone()],
                        blocked_ms: 0,
                        synthesized: false,
                        trunk_count: 0,
                    };
                    let id = round.round_id.clone();
                    rows.push(ChatRow::Round {
                        round: round.clone(),
                    });
                    live.rounds.push(round);
                    id
                }
            };
            if live.meta.title.is_none() {
                live.meta.title = title_from(&text);
                assigned_title.clone_from(&live.meta.title);
            }
            live.meta.updated_at_ms = timestamp;
            live.settled_status = None;
            live.active_turn = Some(ActiveTurn {
                id: turn_id.clone(),
                started_at_ms: timestamp,
                user_item_id: user_id,
                round_id,
                interrupted: false,
            });
            rows.insert(0, ChatRow::Item { item: user.clone() });
            append_rows(&live.meta, &rows, executor, next)?;
            save_meta(&live.meta, executor, next)?;
        }

        if self.live(session_id)?.process.is_none() {
            let process = match start_process(
                self.live(session_id)?,
                definition,
                config,
                &turn_id,
                &attachments,
                executor,
                next,
            ) {
                Ok(process) => process,
                Err(error) => {
                    self.abort_send(session_id, &turn_id, &error, executor, next);
                    return Err(error);
                }
            };
            self.process_to_session
                .insert(process.resource_id, session_id.to_string());
            self.live_mut(session_id)?.process = Some(process);
        }

        let commands = (|| {
            let live = self.live_mut(session_id)?;
            let attachment_paths = codex_attachment_paths(&live.meta, &turn_id, &attachments);
            let process = live.process.as_mut().expect("process just started");
            Ok::<_, ProtocolError>(match &mut process.driver {
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
            })
        })();
        let (commands, close_input) = match commands {
            Ok(commands) => commands,
            Err(error) => {
                self.abort_send(session_id, &turn_id, &error, executor, next);
                return Err(error);
            }
        };
        let resource_id = self
            .live(session_id)?
            .process
            .as_ref()
            .expect("process exists")
            .resource_id;
        for command in commands {
            if let Err(error) = process_write(resource_id, command, executor, next) {
                self.abort_send(session_id, &turn_id, &error, executor, next);
                return Err(error);
            }
        }
        if close_input {
            if let Err(error) =
                process_call(ProcessRequest::CloseInput { resource_id }, executor, next)
            {
                self.abort_send(session_id, &turn_id, &error, executor, next);
                return Err(error);
            }
        }
        let publications = {
            let live = self.live_mut(session_id)?;
            let mut publications = vec![publish(
                live,
                SessionEvent::TurnStarted {
                    turn_id: turn_id.clone(),
                    started_at_ms: timestamp,
                },
            )];
            publications.push(publish(
                live,
                SessionEvent::Item {
                    turn_id,
                    item: user,
                },
            ));
            if let Some(title) = assigned_title {
                publications.push(publish(live, SessionEvent::TitleChanged { title }));
            }
            publications
        };
        Ok(Response {
            reply: Reply::Ack,
            connection: ConnectionDirective::None,
            publications,
        })
    }

    fn abort_send(
        &mut self,
        session_id: &str,
        turn_id: &str,
        cause: &ProtocolError,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) {
        let process = self
            .loaded
            .get_mut(session_id)
            .and_then(|live| live.process.take());
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
        let _ = self.apply_events(
            session_id,
            vec![SessionEvent::TurnFailed {
                turn_id: turn_id.to_string(),
                error: genehub_proto::TurnError {
                    code: genehub_proto::TurnErrorCode::Internal,
                    message: cause.message.clone(),
                },
            }],
            executor,
            next,
        );
    }

    fn fork(
        &mut self,
        session_id: &str,
        turn_id: &str,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        self.ensure_loaded(session_id, config, executor, next)?;
        let source = self.live(session_id)?;
        if source.active_turn.is_some() || source.meta.pending_permission.is_some() {
            return Err(conflict(
                "wait for the current turn to finish before forking",
            ));
        }
        let definition = agents::require(boot, config, &source.meta.agent_id)?;
        if !definition.capabilities().fork {
            return Err(unsupported(format!(
                "the {} agent does not support forking",
                source.meta.agent_id
            )));
        }
        let log = load_log(&source.meta, executor, next)?;
        let at = log
            .items
            .iter()
            .position(|item| {
                matches!(item, TimelineItem::TurnSummary { stats, .. } if stats.turn_id == turn_id)
            })
            .ok_or_else(|| not_found(format!("no completed turn called {turn_id}")))?;
        let checkpoint = match &log.items[at] {
            TimelineItem::TurnSummary { stats, .. } => stats
                .fork_checkpoint
                .clone()
                .ok_or_else(|| unsupported("that turn has no Agent fork checkpoint"))?,
            _ => unreachable!("turn summary position was selected above"),
        };
        let source_thread = source
            .meta
            .persist
            .as_ref()
            .filter(|persist| persist.agent_id == source.meta.agent_id)
            .and_then(|persist| persist.value.get("threadId"))
            .and_then(Value::as_str)
            .ok_or_else(|| conflict("the source Agent thread is not available"))?
            .to_string();
        let (id, timestamp) = identity_and_time(executor, next)?;
        let title = source
            .meta
            .title
            .as_deref()
            .and_then(|title| normalize_title(Some(format!("{title} · 分支"))));
        let meta = SessionMeta {
            format: SESSION_FORMAT,
            id,
            workspace_id: source.meta.workspace_id.clone(),
            project_key: source.meta.project_key.clone(),
            root_handle: source.meta.root_handle.clone(),
            root: source.meta.root.clone(),
            agent_id: source.meta.agent_id.clone(),
            title,
            model_id: source.meta.model_id.clone(),
            mode_id: source.meta.mode_id.clone(),
            effort_id: source.meta.effort_id.clone(),
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            archived: false,
            pending_permission: None,
            persist: Some(PersistHandle {
                agent_id: source.meta.agent_id.clone(),
                value: serde_json::json!({
                    "threadId": source_thread,
                    "forkCheckpoint": checkpoint,
                }),
            }),
        };
        let inherited = log.items[..=at]
            .iter()
            .cloned()
            .map(|item| ChatRow::Item { item })
            .collect::<Vec<_>>();
        establish(&meta, executor, next)?;
        let lock_resource_id = lock_session(&meta, executor, next)?;
        save_meta(&meta, executor, next)?;
        append_rows(&meta, &inherited, executor, next)?;
        let summary = summary(&meta, SessionStatus::Idle);
        self.loaded.insert(
            meta.id.clone(),
            LiveSession {
                meta,
                lock_resource_id,
                seq: 0,
                replay: VecDeque::new(),
                replay_window: config.replay_window.max(1),
                pending_permissions: Vec::new(),
                process: None,
                active_items: Vec::new(),
                active_turn: None,
                rounds: Vec::new(),
                closed: false,
                settled_status: None,
            },
        );
        Ok(Response::reply(Reply::Session(summary)))
    }

    fn control(
        &mut self,
        session_id: &str,
        control: Control,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let live = self.live_mut(session_id)?;
        if live.meta.agent_id == "genet" {
            match &control {
                Control::Model(value) => {
                    genet::validate_model(value)?;
                }
                Control::Mode(value) | Control::Effort(value) => {
                    genet::validate_effort(value)?;
                }
            }
        }
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
                let Some(turn_id) = live.active_turn.as_ref().map(|turn| turn.id.clone()) else {
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
                        turn_id,
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
            let terminal = matches!(
                event,
                SessionEvent::TurnCompleted { .. }
                    | SessionEvent::TurnFailed { .. }
                    | SessionEvent::TurnCanceled { .. }
            );
            let finished_at = terminal.then(|| now(executor, next)).transpose()?;
            let mut settled = None;
            {
                let live = self.live_mut(session_id)?;
                if let Some(finished_at) = finished_at {
                    live.meta.updated_at_ms = finished_at;
                }
                fold(live, &event, &mut settled);
                if let Some(event) = client_event(live, &event) {
                    publications.push(publish(live, event));
                }
            }
            if let Some(settled) = settled {
                let live = self.live_mut(session_id)?;
                persist_settled(live, settled, executor, next)?;
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
                if let Ok(meta) =
                    load_meta(root.clone(), &entry.name, workspace, folder, executor, next)
                {
                    let Ok(lock_resource_id) = lock_session(&meta, executor, next) else {
                        continue;
                    };
                    let log = load_log(&meta, executor, next).unwrap_or_default();
                    self.loaded.insert(
                        meta.id.clone(),
                        LiveSession {
                            pending_permissions: meta
                                .pending_permission
                                .clone()
                                .into_iter()
                                .collect(),
                            meta,
                            lock_resource_id,
                            seq: 0,
                            replay: VecDeque::new(),
                            replay_window: config.replay_window.max(1),
                            process: None,
                            active_items: Vec::new(),
                            active_turn: None,
                            rounds: log.rounds,
                            closed: false,
                            settled_status: None,
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
                definition
                    .home_env
                    .clone()
                    .unwrap_or_else(|| "GENET_AGENT_HOME".to_string()),
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
    let selected = meta
        .model_id
        .as_deref()
        .and_then(|model| model.split_once('/'));
    let models = config
        .agents
        .providers
        .iter()
        .flat_map(|(provider, value)| {
            let resolved = crate::config::resolve(provider, value);
            let configured = value.models.iter().map(String::as_str);
            let selected = selected
                .filter(|(selected_provider, selected_model)| {
                    *selected_provider == provider
                        && value.problem.is_none()
                        && !value.models.iter().any(|model| model == selected_model)
                        && value.api_key.as_deref().is_some_and(|key| !key.is_empty())
                })
                .map(|(_, model)| model);
            configured.chain(selected).map(move |model| {
                serde_json::json!({
                    "id": model,
                    "name": format!("{provider}/{model}"),
                    "provider": provider,
                    "api": match resolved.dialect {
                        crate::config::Dialect::OpenAi => "openai",
                        crate::config::Dialect::Anthropic => "anthropic",
                    },
                    "baseUrl": resolved.base_url,
                    "apiKey": value.api_key,
                })
            })
        })
        .collect::<Vec<_>>();
    let problem = config
        .agents
        .providers
        .iter()
        .find_map(|(provider, value)| {
            value
                .problem
                .as_deref()
                .map(|problem| format!("{provider}: {problem}"))
        });
    let bytes =
        serde_json::to_vec_pretty(&serde_json::json!({ "models": models, "problem": problem }))
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

fn client_event(live: &LiveSession, event: &SessionEvent) -> Option<SessionEvent> {
    let reasoning = match event {
        SessionEvent::Item {
            turn_id,
            item: item @ TimelineItem::Reasoning { .. },
        } => Some((turn_id, item)),
        SessionEvent::ItemDelta {
            turn_id,
            item_id,
            delta: genehub_proto::ItemDelta::Text { .. },
        } => live
            .active_items
            .iter()
            .find(|item| item.id() == item_id)
            .filter(|item| matches!(item, TimelineItem::Reasoning { .. }))
            .map(|item| (turn_id, item)),
        _ => None,
    };
    let Some((turn_id, item)) = reasoning else {
        return Some(overview::condense_event(event));
    };
    let condensed = overview::condense_item(item);
    if matches!(&condensed, TimelineItem::Reasoning { text, .. } if text.is_empty()) {
        return None;
    }
    let unchanged = live.replay.iter().rev().find_map(|sequenced| {
        let SessionEvent::Item { item, .. } = &sequenced.event else {
            return None;
        };
        (item.id() == condensed.id()).then_some(item == &condensed)
    });
    (!unchanged.unwrap_or(false)).then(|| SessionEvent::Item {
        turn_id: turn_id.clone(),
        item: condensed,
    })
}

fn fold(live: &mut LiveSession, event: &SessionEvent, settled: &mut Option<SettledTurn>) {
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
        } => {
            live.settled_status = Some(SessionStatus::Idle);
            settle(
                live,
                turn_id,
                genehub_proto::TurnOutcome::Completed,
                rounds::RoundOutcome::Completed,
                usage.clone(),
                fork_checkpoint.clone(),
                settled,
            )
        }
        SessionEvent::TurnFailed { turn_id, error } => {
            live.settled_status = Some(SessionStatus::Failed);
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
                rounds::RoundOutcome::Failed,
                genehub_proto::Usage::default(),
                None,
                settled,
            );
        }
        SessionEvent::TurnCanceled { turn_id } => {
            live.settled_status = Some(SessionStatus::Idle);
            settle(
                live,
                turn_id,
                genehub_proto::TurnOutcome::Canceled,
                rounds::RoundOutcome::Canceled,
                genehub_proto::Usage::default(),
                None,
                settled,
            )
        }
        SessionEvent::ModelChanged { model_id } => live.meta.model_id = Some(model_id.clone()),
        SessionEvent::ModeChanged { mode_id } => live.meta.mode_id = Some(mode_id.clone()),
        SessionEvent::EffortChanged { effort_id } => live.meta.effort_id = Some(effort_id.clone()),
        SessionEvent::TitleChanged { title } => live.meta.title = Some(title.clone()),
        SessionEvent::SessionStatusChanged { status } => live.settled_status = Some(*status),
        SessionEvent::TurnStarted { .. } => live.settled_status = None,
    }
}

fn settle(
    live: &mut LiveSession,
    turn_id: &str,
    outcome: genehub_proto::TurnOutcome,
    round_outcome: rounds::RoundOutcome,
    usage: genehub_proto::Usage,
    fork_checkpoint: Option<String>,
    settled: &mut Option<SettledTurn>,
) {
    let active = live.active_turn.take();
    let started_at_ms = active
        .as_ref()
        .map(|active| active.started_at_ms)
        .unwrap_or(live.meta.updated_at_ms);
    let finished_at_ms = live.meta.updated_at_ms.max(started_at_ms);
    let mut items = std::mem::take(&mut live.active_items);
    let tool_calls = items
        .iter()
        .filter(|item| matches!(item, TimelineItem::ToolCall { .. }))
        .count() as u64;
    items.push(TimelineItem::TurnSummary {
        id: format!("{turn_id}-summary"),
        stats: genehub_proto::TurnStats {
            turn_id: turn_id.to_string(),
            outcome,
            started_at_ms,
            finished_at_ms,
            duration_ms: finished_at_ms.saturating_sub(started_at_ms) as u64,
            usage,
            tool_calls,
            fork_checkpoint,
        },
    });
    *settled = Some(SettledTurn {
        round_id: active
            .as_ref()
            .map(|active| active.round_id.clone())
            .unwrap_or_else(|| format!("r_{}", turn_id.trim_start_matches("turn_"))),
        turn_id: turn_id.to_string(),
        outcome: if matches!(outcome, genehub_proto::TurnOutcome::Canceled)
            && active.as_ref().is_some_and(|active| active.interrupted)
        {
            None
        } else {
            Some(round_outcome)
        },
        items,
    });
}

fn upsert(items: &mut Vec<TimelineItem>, item: TimelineItem) {
    match items.iter_mut().find(|existing| existing.id() == item.id()) {
        Some(existing) => *existing = item,
        None => items.push(item),
    }
}

fn persist_settled(
    live: &mut LiveSession,
    settled: SettledTurn,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let Some(position) = live
        .rounds
        .iter()
        .position(|round| round.round_id == settled.round_id)
    else {
        return Err(internal(format!(
            "turn {} belongs to an unknown round {}",
            settled.turn_id, settled.round_id
        )));
    };
    let ord = live.rounds[position].ord;
    let first_trunk = live.rounds[position].trunk_count;
    let mut trunks = rounds::trunks_from_items(&settled.items, first_trunk);
    for trunk in &mut trunks {
        for blob in trunk
            .batches
            .iter_mut()
            .flat_map(|batch| batch.blobs.iter_mut())
        {
            let item = settled
                .items
                .iter()
                .find(|item| item.id() == blob.item_id)
                .ok_or_else(|| internal("round blob no longer has a source item"))?;
            blob.blob = Some(put_blob(
                &live.meta,
                serde_json::to_value(item)
                    .map_err(|error| internal(format!("encoding round blob: {error}")))?,
                executor,
                next,
            )?);
        }
        write_trunk(&live.meta, ord, trunk, executor, next)?;
    }

    let round = &mut live.rounds[position];
    if !round
        .adapter_turn_ids
        .iter()
        .any(|turn_id| turn_id == &settled.turn_id)
    {
        round.adapter_turn_ids.push(settled.turn_id);
    }
    round.trunk_count = round.trunk_count.saturating_add(trunks.len() as u32);
    if let Some(outcome) = settled.outcome {
        round.ended_at_ms = live.meta.updated_at_ms;
        round.outcome = Some(outcome);
    } else {
        round.ended_at_ms = 0;
        round.outcome = None;
    }

    let mut rows = settled
        .items
        .into_iter()
        .filter(|item| {
            !matches!(
                item,
                TimelineItem::Reasoning { .. } | TimelineItem::ToolCall { .. }
            )
        })
        .map(|item| ChatRow::Item { item })
        .collect::<Vec<_>>();
    rows.push(ChatRow::Round {
        round: round.clone(),
    });
    append_rows(&live.meta, &rows, executor, next)?;
    save_meta(&live.meta, executor, next)
}

fn put_blob(
    meta: &SessionMeta,
    value: Value,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<BlobRef, ProtocolError> {
    let encoded = serde_json::to_vec(&value)
        .map_err(|error| internal(format!("encoding blob value: {error}")))?;
    let id = Sha256::digest(&encoded)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .chars()
        .take(BLOB_ID_CHARS)
        .collect::<String>();
    let bucket = id[..2].to_string();
    let path = format!(".genethub/sessions/{}/blobs/b-{bucket}.jsonl", meta.id);
    create_dir(
        meta,
        &format!(".genethub/sessions/{}/blobs", meta.id),
        executor,
        next,
    )?;
    let offset = file_size(meta, &path, executor, next)?.unwrap_or(0);
    let mut line = serde_json::to_vec(&BlobRecord {
        id: id.clone(),
        value,
    })
    .map_err(|error| internal(format!("encoding blob record: {error}")))?;
    let length = line.len() as u64;
    if length == 0 || length > MAX_BLOB_BYTES {
        return Err(internal("round blob exceeds its storage limit"));
    }
    line.push(b'\n');
    append_bytes_chunked(meta, &path, &line, executor, next)?;
    Ok(BlobRef {
        id,
        bytes: encoded.len() as u64,
        at: format!("{bucket}:{offset}:{length}"),
    })
}

fn get_blob(
    meta: &SessionMeta,
    blob: &BlobRef,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<BlobPayload, ProtocolError> {
    let (bucket, offset, length) = parse_blob_locator(&blob.at)
        .filter(|(_, _, length)| *length > 0 && *length <= MAX_BLOB_BYTES)
        .ok_or_else(|| not_found(format!("no such blob: {}", blob.id)))?;
    if blob.id.len() != BLOB_ID_CHARS || !blob.id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(not_found(format!("no such blob: {}", blob.id)));
    }
    let path = format!(".genethub/sessions/{}/blobs/b-{bucket}.jsonl", meta.id);
    let bytes = read_range_chunked(meta, &path, offset, length, executor, next)?;
    let record: BlobRecord = serde_json::from_slice(&bytes)
        .map_err(|_| not_found(format!("no such blob: {}", blob.id)))?;
    if record.id != blob.id {
        return Err(not_found(format!("no such blob: {}", blob.id)));
    }
    Ok(BlobPayload {
        id: record.id,
        value: record.value,
    })
}

fn parse_blob_locator(value: &str) -> Option<(String, u64, u64)> {
    let mut parts = value.split(':');
    let bucket = parts.next()?;
    if bucket.len() != 2 || !bucket.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let offset = parts.next()?.parse().ok()?;
    let length = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((bucket.to_string(), offset, length))
}

fn write_trunk(
    meta: &SessionMeta,
    ord: u32,
    trunk: &RoundTrunk,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let dir = format!(".genethub/sessions/{}/rounds/r-{ord:03}", meta.id);
    create_dir(meta, &dir, executor, next)?;
    let mut body = Vec::new();
    for batch in &trunk.batches {
        push_json_line(
            &mut body,
            &TrunkRow::Batch {
                index: batch.summary.index,
                first_item_id: batch.summary.first_item_id.clone(),
                blob_count: batch.summary.blob_count,
                text: batch.summary.text.clone(),
                monologue: batch.monologue.clone(),
            },
        )?;
        for blob in &batch.blobs {
            push_json_line(
                &mut body,
                &TrunkRow::Blob {
                    item_id: blob.item_id.clone(),
                    kind: blob.kind,
                    overview: blob.overview.clone(),
                    blob: blob.blob.clone(),
                },
            )?;
        }
    }
    write_atomic_chunks(
        meta,
        &format!("{dir}/t-{:04}.jsonl", trunk.summary.index),
        body,
        executor,
        next,
    )?;
    let mut summary = serde_json::to_vec(&trunk.summary)
        .map_err(|error| internal(format!("encoding trunk summary: {error}")))?;
    summary.push(b'\n');
    append_bytes(meta, &format!("{dir}/index.jsonl"), summary, executor, next)
}

fn push_json_line<T: Serialize>(body: &mut Vec<u8>, value: &T) -> Result<(), ProtocolError> {
    serde_json::to_writer(&mut *body, value)
        .map_err(|error| internal(format!("encoding round trunk: {error}")))?;
    body.push(b'\n');
    Ok(())
}

fn write_atomic_chunks(
    meta: &SessionMeta,
    path: &str,
    bytes: Vec<u8>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let temporary = format!("{path}.tmp");
    let mut chunks = bytes.chunks(FILE_CHUNK_BYTES as usize);
    let first = chunks.next().unwrap_or_default().to_vec();
    let mut client = Client::new(executor, next);
    client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(meta, &temporary),
        bytes: first,
    }))?;
    for chunk in chunks {
        append_bytes(meta, &temporary, chunk.to_vec(), executor, next)?;
    }
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Rename {
        from: locator(meta, &temporary),
        to: locator(meta, path),
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("atomic round rename returned the wrong value")),
    }
}

fn create_dir(
    meta: &SessionMeta,
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
        locator: locator(meta, path),
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("directory creation returned the wrong value")),
    }
}

fn append_bytes(
    meta: &SessionMeta,
    path: &str,
    bytes: Vec<u8>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    if bytes.len() > genet_daemon_logic_api::MAX_CAPABILITY_CHUNK_BYTES {
        return Err(internal("file append exceeds the capability limit"));
    }
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Append {
        locator: locator(meta, path),
        bytes,
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("file append returned the wrong value")),
    }
}

fn file_size(
    meta: &SessionMeta,
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<u64>, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call_raw(CapabilityRequest::File(FileRequest::Metadata {
        locator: locator(meta, path),
    }))? {
        Ok(CapabilityValue::FileMetadata(value)) => Ok(Some(value.bytes)),
        Err(error) if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound => {
            Ok(None)
        }
        Err(error) => Err(capability_error(error)),
        Ok(_) => Err(internal("file metadata returned the wrong value")),
    }
}

fn read_range(
    meta: &SessionMeta,
    path: &str,
    offset: u64,
    length: u64,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<u8>, ProtocolError> {
    if length > genet_daemon_logic_api::MAX_CAPABILITY_CHUNK_BYTES as u64 {
        return Err(unsupported(
            "blob exceeds the current transport chunk limit",
        ));
    }
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::ReadRange {
        locator: locator(meta, path),
        offset,
        length: length as u32,
    }))? {
        CapabilityValue::Bytes(bytes) if bytes.len() as u64 == length => Ok(bytes),
        CapabilityValue::Bytes(_) => Err(not_found("the requested file range no longer exists")),
        _ => Err(internal("file range returned the wrong value")),
    }
}

fn read_range_chunked(
    meta: &SessionMeta,
    path: &str,
    offset: u64,
    length: u64,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<u8>, ProtocolError> {
    let capacity = usize::try_from(length)
        .map_err(|_| unsupported("the requested file range is too large for this platform"))?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut read = 0_u64;
    while read < length {
        let chunk = (length - read).min(FILE_CHUNK_BYTES as u64);
        bytes.extend(read_range(
            meta,
            path,
            offset + read,
            chunk,
            executor,
            next,
        )?);
        read += chunk;
    }
    Ok(bytes)
}

fn append_bytes_chunked(
    meta: &SessionMeta,
    path: &str,
    bytes: &[u8],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    for chunk in bytes.chunks(FILE_CHUNK_BYTES as usize) {
        append_bytes(meta, path, chunk.to_vec(), executor, next)?;
    }
    Ok(())
}

fn require_round<'a>(
    live: &'a LiveSession,
    round_id: &str,
) -> Result<&'a rounds::RoundRecord, ProtocolError> {
    if round_id == "latest" {
        live.rounds.last()
    } else {
        live.rounds.iter().find(|round| round.round_id == round_id)
    }
    .ok_or_else(|| not_found(format!("no such round: {round_id}")))
}

fn round_layer(
    live: &LiveSession,
    round_id: &str,
    cursor: Option<&str>,
    limit: u32,
    expand_last: bool,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<RoundLayer, ProtocolError> {
    let round = require_round(live, round_id)?;
    let index = load_trunk_index(&live.meta, round.ord, executor, next)?;
    let end = match cursor {
        None => index.len(),
        Some(cursor) => cursor
            .strip_prefix("before:")
            .and_then(|value| value.parse::<usize>().ok())
            .map(|value| value.min(index.len()))
            .ok_or_else(|| bad_request("invalid trunk cursor"))?,
    };
    let start = end.saturating_sub(limit.clamp(1, 100) as usize);
    let trunks = index[start..end].to_vec();
    let expanded_trunk = if expand_last {
        trunks
            .last()
            .map(|summary| load_trunk(&live.meta, round.ord, summary, executor, next))
            .transpose()?
    } else {
        None
    };
    let running = live
        .active_turn
        .as_ref()
        .is_some_and(|turn| turn.round_id == round.round_id);
    let mut summary = round.summary(running);
    summary.trunk_count = index.len() as u32;
    Ok(RoundLayer {
        round: summary,
        trunks,
        next_cursor: (start > 0).then(|| format!("before:{start}")),
        expanded_trunk,
    })
}

fn load_trunk_index(
    meta: &SessionMeta,
    ord: u32,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<RoundTrunkSummary>, ProtocolError> {
    let path = format!(
        ".genethub/sessions/{}/rounds/r-{ord:03}/index.jsonl",
        meta.id
    );
    let mut summaries: Vec<RoundTrunkSummary> = Vec::new();
    for line in read_lines(meta, &path, executor, next)? {
        let Ok(summary) = serde_json::from_slice::<RoundTrunkSummary>(&line) else {
            continue;
        };
        match summaries
            .iter_mut()
            .find(|existing| existing.index == summary.index)
        {
            Some(existing) => *existing = summary,
            None => summaries.push(summary),
        }
    }
    summaries.sort_by_key(|summary| summary.index);
    Ok(summaries)
}

fn load_trunk(
    meta: &SessionMeta,
    ord: u32,
    summary: &RoundTrunkSummary,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<RoundTrunk, ProtocolError> {
    let path = format!(
        ".genethub/sessions/{}/rounds/r-{ord:03}/t-{:04}.jsonl",
        meta.id, summary.index
    );
    let mut batches: Vec<RoundBatch> = Vec::new();
    for line in read_lines(meta, &path, executor, next)? {
        match serde_json::from_slice::<TrunkRow>(&line) {
            Ok(TrunkRow::Batch {
                index,
                first_item_id,
                blob_count,
                text,
                monologue,
            }) => batches.push(RoundBatch {
                summary: RoundBatchSummary {
                    index,
                    first_item_id,
                    blob_count,
                    text,
                },
                monologue,
                blobs: Vec::new(),
            }),
            Ok(TrunkRow::Blob {
                item_id,
                kind,
                overview,
                blob,
            }) => {
                if batches.is_empty() {
                    batches.push(RoundBatch {
                        summary: RoundBatchSummary {
                            index: 0,
                            first_item_id: item_id.clone(),
                            blob_count: 0,
                            text: String::new(),
                        },
                        monologue: None,
                        blobs: Vec::new(),
                    });
                }
                batches
                    .last_mut()
                    .expect("batch was just established")
                    .blobs
                    .push(BlobOverview {
                        item_id,
                        kind,
                        overview,
                        blob,
                    });
            }
            Err(_) => {}
        }
    }
    Ok(RoundTrunk {
        summary: summary.clone(),
        batches,
    })
}

fn read_lines(
    meta: &SessionMeta,
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<Vec<u8>>, ProtocolError> {
    let Some(size) = file_size(meta, path, executor, next)? else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    let mut pending = Vec::new();
    let mut offset = 0_u64;
    while offset < size {
        let length = (size - offset).min(FILE_CHUNK_BYTES as u64);
        let bytes = read_range(meta, path, offset, length, executor, next)?;
        if bytes.is_empty() {
            break;
        }
        offset += bytes.len() as u64;
        pending.extend_from_slice(&bytes);
        let split = pending
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        output.extend(
            pending[..split]
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(<[u8]>::to_vec),
        );
        pending.drain(..split);
        if pending.len() > CHAT_BYTES as usize {
            return Err(internal("a round storage row exceeds the read limit"));
        }
    }
    if !pending.is_empty() {
        output.push(pending);
    }
    Ok(output)
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
    while live.replay.len() > live.replay_window.max(1) || encoded_len(&live.replay) > REPLAY_BYTES
    {
        live.replay.pop_front();
    }
}

fn default_replay_window() -> usize {
    2048
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
    let mut items = load_log(&live.meta, executor, next)?.items;
    for item in &live.active_items {
        upsert(&mut items, overview::condense_item(item));
    }
    let round_summaries = live
        .rounds
        .iter()
        .map(|round| {
            round.summary(
                live.active_turn
                    .as_ref()
                    .is_some_and(|turn| turn.round_id == round.round_id),
            )
        })
        .collect::<Vec<_>>();
    let expanded_round = if live.rounds.is_empty() {
        None
    } else {
        Some(Box::new(round_layer(
            live, "latest", None, 20, true, executor, next,
        )?))
    };
    Ok(SessionSnapshot {
        summary: summary(&live.meta, status(live)),
        items,
        seq: live.seq,
        pending_permissions: live.pending_permissions.clone(),
        rounds: Some(round_summaries),
        expanded_round,
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
    if live.closed {
        SessionStatus::Closed
    } else if live.meta.pending_permission.is_some() {
        SessionStatus::Waiting
    } else if live.active_turn.is_some() {
        SessionStatus::Running
    } else {
        live.settled_status.unwrap_or(SessionStatus::Idle)
    }
}

fn workspace<'a>(config: &'a Config, id: &str) -> Result<&'a WorkspaceEntry, ProtocolError> {
    config
        .workspaces
        .iter()
        .find(|workspace| workspace.id == id && !workspace.removed)
        .ok_or_else(|| not_found(format!("no such workspace: {id}")))
}

fn workspace_project_key(workspace: &WorkspaceEntry) -> String {
    let Some(path) = workspace.workspace_file.as_deref() else {
        return "folder".to_string();
    };
    let mut digest = Sha256::new();
    digest.update(b"genehub-workspace-source-v1\0");
    // Existing Windows builds hashed PathBuf's UTF-16 code units; Unix builds
    // hashed its bytes. The guest sees a string, so select the historical
    // representation from the path syntax to preserve old session ownership.
    if path.contains('\\') || path.as_bytes().get(1) == Some(&b':') {
        for unit in path.encode_utf16() {
            digest.update(unit.to_le_bytes());
        }
    } else {
        digest.update(path.as_bytes());
    }
    format!("workspace:{:x}", digest.finalize())
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

fn lock_session(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<u64, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Lock {
        locator: locator(meta, &format!(".genethub/sessions/{}/writer.lock", meta.id)),
        exclusive: true,
    }))? {
        CapabilityValue::FileLocked { resource_id } => Ok(resource_id),
        _ => Err(internal("session lock returned the wrong value")),
    }
}

fn unlock_session(
    resource_id: u64,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Unlock { resource_id }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("session unlock returned the wrong value")),
    }
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
    workspace: &WorkspaceEntry,
    folder: &WorkspaceFolderEntry,
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
    let expected_project_key = workspace_project_key(workspace);
    if !meta.project_key.is_empty() && meta.project_key != expected_project_key {
        return Err(conflict(format!(
            "session {id} belongs to another workspace"
        )));
    }
    meta.workspace_id = workspace.id.clone();
    meta.project_key = expected_project_key;
    meta.root_handle = folder.root_handle.clone();
    if meta.root.is_empty() {
        meta.root = folder.root.clone();
    }
    Ok(meta)
}

fn append_rows(
    meta: &SessionMeta,
    rows: &[ChatRow],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    if rows.is_empty() {
        return Ok(());
    }
    for row in rows {
        let mut bytes = serde_json::to_vec(row)
            .map_err(|error| internal(format!("encoding session item: {error}")))?;
        bytes.push(b'\n');
        if bytes.len() > genet_daemon_logic_api::MAX_CAPABILITY_CHUNK_BYTES {
            return Err(internal(
                "a session ledger row exceeds the capability limit",
            ));
        }
        let mut client = Client::new(executor, next);
        match client.call(CapabilityRequest::File(FileRequest::Append {
            locator: locator(meta, &format!(".genethub/sessions/{}/chat.jsonl", meta.id)),
            bytes,
        }))? {
            CapabilityValue::Unit => {}
            _ => return Err(internal("session chat append returned the wrong value")),
        }
    }
    Ok(())
}

fn load_log(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<ChatLog, ProtocolError> {
    let chat = locator(meta, &format!(".genethub/sessions/{}/chat.jsonl", meta.id));
    let size = {
        let mut client = Client::new(executor, next);
        match client.call_raw(CapabilityRequest::File(FileRequest::Metadata {
            locator: chat.clone(),
        }))? {
            Ok(CapabilityValue::FileMetadata(metadata)) => metadata.bytes,
            Err(error) if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound => {
                return Ok(ChatLog::default())
            }
            Err(error) => return Err(capability_error(error)),
            Ok(_) => return Err(internal("session chat metadata returned the wrong value")),
        }
    };
    let mut log = ChatLog::default();
    let mut pending = Vec::new();
    let mut offset = 0_u64;
    while offset < size {
        let length = (size - offset).min(FILE_CHUNK_BYTES as u64) as u32;
        let mut client = Client::new(executor, next);
        let bytes = match client.call(CapabilityRequest::File(FileRequest::ReadRange {
            locator: chat.clone(),
            offset,
            length,
        }))? {
            CapabilityValue::Bytes(bytes) => bytes,
            _ => return Err(internal("session chat range returned the wrong value")),
        };
        if bytes.is_empty() {
            break;
        }
        offset = offset.saturating_add(bytes.len() as u64);
        pending.extend_from_slice(&bytes);
        let split = pending
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        for line in pending[..split].split(|byte| *byte == b'\n') {
            fold_chat_row(&mut log, line);
        }
        pending.drain(..split);
        if pending.len() > CHAT_BYTES as usize {
            return Err(internal("a session ledger row exceeds the read limit"));
        }
    }
    if !pending.is_empty() {
        fold_chat_row(&mut log, &pending);
    }
    log.rounds.sort_by_key(|round| round.ord);
    Ok(log)
}

fn fold_chat_row(log: &mut ChatLog, line: &[u8]) {
    if line.is_empty() {
        return;
    }
    match serde_json::from_slice::<ChatRow>(line) {
        Ok(ChatRow::Item { item }) => upsert(&mut log.items, item),
        Ok(ChatRow::Round { round }) => match log
            .rounds
            .iter_mut()
            .find(|existing| existing.round_id == round.round_id)
        {
            Some(existing) => *existing = round,
            None => log.rounds.push(round),
        },
        Err(_) => {}
    }
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
