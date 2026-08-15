//! Portable session kernel.
//!
//! The guest owns session identity, persistence layout, replay, state
//! transitions and Agent protocol state. Native code sees only workspace file
//! locators and opaque process resource ids.

pub(crate) mod acp;
mod artifact_links;
mod artifacts;
pub(crate) mod claude;
pub(crate) mod codex;
mod context_seed;
mod genet;
mod import;
mod opencode;
mod overview;
mod rounds;

use std::collections::{HashMap, VecDeque};

use genehub_proto::{
    AgentInfo, BackgroundProcess, BlobKind, BlobOverview, BlobPayload, BlobRef, Catalog, ErrorCode,
    ForkMethod, ForkTarget, ForkTransfer, HistoryCoverage, ImportContinuation,
    PermissionOptionKind, PermissionOutcome, PermissionRequest, PermissionRequestKind,
    ProtocolError, Reply, Request, RetrievalCapability, RoundBatch, RoundBatchSummary, RoundLayer,
    RoundTrunk, RoundTrunkSummary, SequencedEvent, SessionContext, SessionEvent,
    SessionImportOrigin, SessionInspection, SessionLineage, SessionNarrativePage,
    SessionReadSource, SessionRoundPage, SessionSnapshot, SessionStatus, SessionSummary,
    TimelineItem,
};
use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityRequest, CapabilityValue, ConnectionDirective, FileKind,
    FileLocator, FileRequest, FileRoot, LogicCompletion, LogicOutcome, LogicOutput,
    ProcessCensusRow, ProcessRequest, ProcessSignal, ProcessSpec, ProcessStream, Publication,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::agents::{self, AgentDefinition, AgentKind};
use crate::capability::Client;
use crate::config::{Config, WorkspaceEntry, WorkspaceFolderEntry};
use crate::CapabilityExecutor;

// 4 is the path-as-index layout. 5 adds fork lineage and reconstructed
// context; 6 adds imported origin and read-only continuation; 7 adds a
// root-relative, platform-neutral working-directory locator. Older builds
// must not reopen those shapes with weaker semantics, so these are
// correctness-breaking format changes.
pub(crate) const SESSION_FORMAT: u32 = 7;
const META_BYTES: u32 = 1024 * 1024;
const CHAT_BYTES: u32 = 3 * 1024 * 1024;
const FILE_CHUNK_BYTES: u32 = 1024 * 1024;
const BLOB_ID_CHARS: usize = 24;
const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;
const REPLAY_BYTES: usize = 2 * 1024 * 1024;
const IMPORT_VISIBLE_BYTES: usize = 1_800_000;
const IMPORT_VISIBLE_ITEMS: usize = 4_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sessions {
    loaded: HashMap<String, LiveSession>,
    process_to_session: HashMap<u64, String>,
    /// Shared locks on the legacy workspace-wide owner files, keyed by the
    /// opaque physical root handle. They exclude older GeneHub builds while
    /// current builds use finer per-session writer locks.
    #[serde(default)]
    compatibility_locks: HashMap<String, u64>,
    #[serde(default)]
    import_candidates: HashMap<String, import::CachedImportCandidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveSession {
    meta: SessionMeta,
    /// Opaque native handle for `<session>/writer.lock`. It is serialized so
    /// guest hot replacement cannot accidentally open a second writer.
    /// Zero means the session is loaded read-only. A writer lock is acquired
    /// lazily before the first mutation, so listing history does not exclude a
    /// second daemon from working in an unrelated session.
    #[serde(default)]
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
    #[serde(default = "format_before_versions")]
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
    /// Forward-slash relative path from `root_handle` to `root`.
    ///
    /// The native path remains useful when talking to third-party Agent CLIs,
    /// while this locator-safe spelling is what lets the platform start the
    /// process in the requested subdirectory on every host OS.
    #[serde(default)]
    cwd_path: String,
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
    pending_permission_at_ms: Option<i64>,
    #[serde(default)]
    persist: Option<PersistHandle>,
    #[serde(default)]
    lineage: Option<SessionLineage>,
    #[serde(default)]
    imported: Option<ImportedSessionMeta>,
    // Early Wasm development builds temporarily embedded this field in meta.
    // Read that shape for migration, but keep writing the mainline `seed.json`
    // contract so large reconstructed prompts never bloat every list scan.
    #[serde(default, skip_serializing)]
    context_seed: Option<ContextSeed>,
}

fn format_before_versions() -> u32 {
    4
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaHeader {
    #[serde(default = "format_before_versions")]
    format: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    created_at_ms: i64,
    #[serde(default)]
    updated_at_ms: i64,
    #[serde(default)]
    project_key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSessionMeta {
    source_key: String,
    agent_id: String,
    continuation: ImportContinuation,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    coverage: Option<HistoryCoverage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextSeed {
    state: ContextSeedState,
    text: String,
}

#[derive(Debug, PartialEq, Eq)]
struct Continuation {
    elevated: bool,
    prompt: String,
}

fn continuation_for(
    request: &PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<Continuation>, ProtocolError> {
    match request.kind {
        PermissionRequestKind::Permission => {
            let Some(option) = selected_option(request, outcome)? else {
                return Ok(None);
            };
            if option.kind == PermissionOptionKind::Reject {
                return Ok(None);
            }
            Ok(Some(Continuation {
                elevated: true,
                prompt: format!(
                    "The user approved the interrupted permission request: {}. Resume the original \
                     task from the current conversation state and do not repeat completed work.",
                    option.label
                ),
            }))
        }
        PermissionRequestKind::PlanApproval => {
            let Some(option) = selected_option(request, outcome)? else {
                return Ok(None);
            };
            if option.kind == PermissionOptionKind::Reject {
                return Ok(None);
            }
            Ok(Some(Continuation {
                elevated: false,
                prompt: format!(
                    "The user approved the interrupted plan '{}'. Continue implementing that plan \
                     from the current conversation state and do not repeat completed work.",
                    request.title
                ),
            }))
        }
        PermissionRequestKind::Question => {
            let Some(answer) = question_answer(request, outcome)? else {
                return Ok(None);
            };
            Ok(Some(Continuation {
                elevated: false,
                prompt: format!(
                    "The user answered the interrupted questions:\n{answer}\nResume the original \
                     task from the current conversation state and do not repeat completed work."
                ),
            }))
        }
    }
}

fn selected_option<'a>(
    request: &'a PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<&'a genehub_proto::PermissionOption>, ProtocolError> {
    let PermissionOutcome::Selected { option_id } = outcome else {
        return Ok(None);
    };
    request
        .options
        .iter()
        .find(|option| option.id == *option_id)
        .map(Some)
        .ok_or_else(|| {
            bad_request(format!(
                "'{option_id}' is not an option for this interaction"
            ))
        })
}

fn question_answer(
    request: &PermissionRequest,
    outcome: &PermissionOutcome,
) -> Result<Option<String>, ProtocolError> {
    if let Some(option) = selected_option(request, outcome)? {
        return Ok(Some(format!("- {}: {}", request.title, option.label)));
    }
    let PermissionOutcome::Answered { answers } = outcome else {
        return Ok(None);
    };
    let questions = request.questions.as_deref().unwrap_or_default();
    for answer in answers {
        if !questions
            .iter()
            .any(|question| question.id == answer.question_id)
        {
            return Err(bad_request(format!(
                "'{}' is not a question for this interaction",
                answer.question_id
            )));
        }
        if answers
            .iter()
            .filter(|candidate| candidate.question_id == answer.question_id)
            .count()
            > 1
        {
            return Err(bad_request(format!(
                "question '{}' was answered more than once",
                answer.question_id
            )));
        }
    }
    let mut lines = Vec::new();
    for question in questions {
        let answer = answers
            .iter()
            .find(|answer| answer.question_id == question.id)
            .ok_or_else(|| bad_request(format!("question '{}' was not answered", question.id)))?;
        if !question.allow_multiple && answer.selected_option_ids.len() > 1 {
            return Err(bad_request(format!(
                "question '{}' accepts only one option",
                question.id
            )));
        }
        let mut values = Vec::new();
        for option_id in &answer.selected_option_ids {
            let option = question
                .options
                .iter()
                .find(|option| option.id == *option_id)
                .ok_or_else(|| {
                    bad_request(format!(
                        "'{option_id}' is not an option for question '{}'",
                        question.id
                    ))
                })?;
            values.push(option.label.clone());
        }
        let freeform = answer
            .freeform_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if freeform.is_some() && !question.allow_freeform {
            return Err(bad_request(format!(
                "question '{}' does not accept a free-form answer",
                question.id
            )));
        }
        if let Some(text) = freeform {
            values.push(text.to_string());
        }
        if values.is_empty() {
            return Err(bad_request(format!(
                "question '{}' has no answer",
                question.id
            )));
        }
        lines.push(format!("- {}: {}", question.prompt, values.join(", ")));
    }
    Ok((!lines.is_empty()).then(|| lines.join("\n")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ContextSeedState {
    Pending,
    Applying,
    Applied,
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
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    watched_at_millis: u64,
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

struct SessionReadView {
    meta: SessionMeta,
    items: Vec<TimelineItem>,
    rounds: Vec<genehub_proto::RoundSummary>,
    source: SessionReadSource,
    coverage: HistoryCoverage,
}

#[allow(clippy::too_many_arguments)]
pub fn request(
    sessions: &mut Sessions,
    call_id: u64,
    request: Request,
    boot: &genet_daemon_logic_api::LogicBoot,
    config: &Config,
    agents: &[AgentInfo],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> LogicOutput {
    let response = sessions.handle(request, boot, config, agents, executor, next);
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
    pub(crate) fn validate_membership(
        &mut self,
        session_id: &str,
        workspace_id: &str,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        self.ensure_loaded(session_id, config, executor, next)?;
        if self.live(session_id)?.meta.workspace_id != workspace_id {
            return Err(bad_request("session is not a member of this workspace"));
        }
        Ok(())
    }

    pub(crate) fn context_items(
        &mut self,
        session_id: &str,
        workspace_id: &str,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<TimelineItem>, ProtocolError> {
        self.validate_membership(session_id, workspace_id, config, executor, next)?;
        load_log(&self.live(session_id)?.meta, executor, next).map(|log| log.items)
    }

    fn handle(
        &mut self,
        request: Request,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        agent_infos: &[AgentInfo],
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
                cwd,
            } => {
                let definition = agents::require(boot, config, &agent_id)?;
                let workspace = workspace(config, &workspace_id)?;
                let (id, now) = identity_and_time(executor, next)?;
                let (root_handle, root, cwd_path) =
                    resolve_session_cwd(workspace, cwd, executor, next)?;
                let meta = SessionMeta {
                    format: SESSION_FORMAT,
                    id,
                    workspace_id,
                    project_key: workspace_project_key(workspace),
                    root_handle,
                    root,
                    cwd_path,
                    agent_id: definition.id,
                    title: normalize_title(title),
                    model_id,
                    mode_id,
                    effort_id: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    archived: false,
                    pending_permission: None,
                    pending_permission_at_ms: None,
                    persist: None,
                    lineage: None,
                    imported: None,
                    context_seed: None,
                };
                establish(&meta, executor, next)?;
                let lock_resource_id = self.claim_session(&meta, executor, next)?;
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
                        config.workspaces.iter().any(|workspace| {
                            workspace.id == live.meta.workspace_id && !workspace.removed
                        }) && workspace_id
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
            Request::SessionInspect {
                session_id,
                through_round_id,
            } => Ok(Response::reply(Reply::SessionInspection(self.inspect(
                &session_id,
                through_round_id.as_deref(),
                config,
                executor,
                next,
            )?))),
            Request::SessionNarrative {
                session_id,
                through_round_id,
                item_id,
                cursor,
                limit,
            } => Ok(Response::reply(Reply::SessionNarrative(
                self.narrative_page(
                    &session_id,
                    through_round_id.as_deref(),
                    item_id.as_deref(),
                    cursor.as_deref(),
                    limit,
                    config,
                    executor,
                    next,
                )?,
            ))),
            Request::SessionRounds {
                session_id,
                through_round_id,
                cursor,
                limit,
            } => Ok(Response::reply(Reply::SessionRounds(self.round_page(
                &session_id,
                through_round_id.as_deref(),
                cursor.as_deref(),
                limit,
                config,
                executor,
                next,
            )?))),
            Request::SessionContext {
                session_id,
                through_round_id,
                token_budget,
            } => Ok(Response::reply(Reply::SessionContext(
                self.session_context(
                    &session_id,
                    through_round_id.as_deref(),
                    token_budget,
                    config,
                    executor,
                    next,
                )?,
            ))),
            Request::SessionSend {
                session_id,
                text,
                attachments,
                // Kept for old clients only. Deployment origins are never
                // trusted as model instructions; the guest injects its fixed,
                // deployment-independent path guidance below.
                artifact_preview_base_url: _,
                continues_round,
            } => self.send(
                &session_id,
                text,
                attachments,
                continues_round,
                boot,
                config,
                agent_infos,
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
                if let Err(error) = self.ensure_loaded(&session_id, config, executor, next) {
                    if error.code == ErrorCode::NotFound {
                        return Ok(Response::reply(Reply::Ack));
                    }
                    return Err(error);
                }
                if let Err(error) = self.ensure_claimed(&session_id, executor, next) {
                    if error.code == ErrorCode::NotFound {
                        return Ok(Response::reply(Reply::Ack));
                    }
                    return Err(error);
                }
                // Census must happen while the Agent is still alive: a child
                // that created its own process group becomes un-attributable
                // once its parent exits.
                let _ = self.kill_all_background_processes(&session_id, executor, next);
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
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
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
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
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
                // Deletion is idempotent and is also the one operation allowed
                // on a session written by a newer format: removing bytes does
                // not require interpreting them.
                if !self.loaded.contains_key(&session_id) {
                    self.load_catalog(config, executor, next)?;
                }
                if !self.loaded.contains_key(&session_id) {
                    return Ok(Response::reply(Reply::Ack));
                }
                if let Err(error) = self.ensure_claimed(&session_id, executor, next) {
                    if error.code == ErrorCode::NotFound {
                        return Ok(Response::reply(Reply::Ack));
                    }
                    return Err(error);
                }
                let _ = self.kill_all_background_processes(&session_id, executor, next);
                let mut live = self
                    .loaded
                    .remove(&session_id)
                    .ok_or_else(|| not_found(format!("no such session: {session_id}")))?;
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
                write_tombstone(&live.meta, executor, next)?;
                unlock_session(live.lock_resource_id, executor, next)?;
                // The tombstone is the atomic deletion. Physical cleanup can
                // be retried on a later catalog scan when the filesystem is
                // temporarily busy (notably on Windows).
                let _ = remove_session(&live.meta, executor, next);
                Ok(Response::reply(Reply::Ack))
            }
            Request::SessionSetModel {
                session_id,
                model_id,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                self.control(
                    &session_id,
                    Control::Model(model_id),
                    agent_infos,
                    executor,
                    next,
                )
            }
            Request::SessionSetMode {
                session_id,
                mode_id,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                self.control(
                    &session_id,
                    Control::Mode(mode_id),
                    agent_infos,
                    executor,
                    next,
                )
            }
            Request::SessionSetEffort {
                session_id,
                effort_id,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                self.control(
                    &session_id,
                    Control::Effort(effort_id),
                    agent_infos,
                    executor,
                    next,
                )
            }
            Request::SessionRespondPermission {
                session_id,
                request_id,
                outcome,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                self.permission(
                    &session_id,
                    request_id,
                    outcome,
                    boot,
                    config,
                    agent_infos,
                    executor,
                    next,
                )
            }
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
            Request::SessionArtifactBegin {
                session_id,
                files,
                metadata,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                let meta = self.live(&session_id)?.meta.clone();
                Ok(Response::reply(Reply::SessionArtifactUpload(
                    artifacts::begin(&meta, files, metadata, executor, next)?,
                )))
            }
            Request::SessionArtifactChunk {
                session_id,
                upload_id,
                file_index,
                offset,
                data_base64,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                let meta = self.live(&session_id)?.meta.clone();
                artifacts::chunk(
                    &meta,
                    &upload_id,
                    file_index,
                    offset,
                    &data_base64,
                    executor,
                    next,
                )?;
                Ok(Response::reply(Reply::Ack))
            }
            Request::SessionArtifactFinish {
                session_id,
                upload_id,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                let meta = self.live(&session_id)?.meta.clone();
                Ok(Response::reply(Reply::SessionArtifact(artifacts::finish(
                    &meta, &upload_id, executor, next,
                )?)))
            }
            Request::SessionArtifactAbort {
                session_id,
                upload_id,
            } => {
                self.ensure_loaded(&session_id, config, executor, next)?;
                self.ensure_claimed(&session_id, executor, next)?;
                let meta = self.live(&session_id)?.meta.clone();
                artifacts::abort(&meta, &upload_id, executor, next)?;
                Ok(Response::reply(Reply::Ack))
            }
            Request::SessionFork {
                session_id,
                turn_id,
                target,
            } => self.fork(
                &session_id,
                &turn_id,
                target,
                boot,
                config,
                agent_infos,
                executor,
                next,
            ),
            Request::SessionForkExport {
                session_id,
                turn_id,
            } => Ok(Response::reply(Reply::ForkTransfer(self.fork_export(
                &session_id,
                &turn_id,
                config,
                executor,
                next,
            )?))),
            Request::SessionForkImport { transfer, target } => {
                self.fork_import(transfer, target, boot, config, agent_infos, executor, next)
            }
            Request::SessionImportList {
                workspace_id,
                limit,
            } => Ok(Response::reply(Reply::SessionImports(self.list_imports(
                &workspace_id,
                limit,
                boot,
                config,
                executor,
                next,
            )?))),
            Request::SessionImport {
                workspace_id,
                candidate_id,
            } => self.import_session(&workspace_id, &candidate_id, boot, config, executor, next),
            Request::ProcessList => Ok(Response::reply(Reply::Processes(
                self.background_processes(executor, next)?,
            ))),
            Request::ProcessKill { session_id, pid } => {
                self.kill_background_process(&session_id, pid, executor, next)?;
                Ok(Response::reply(Reply::Ack))
            }
            Request::ProcessKillAll { session_id } => {
                self.kill_all_background_processes(&session_id, executor, next)?;
                Ok(Response::reply(Reply::Ack))
            }
            _ => Err(internal("non-session request reached session kernel")),
        }
    }

    fn background_processes(
        &self,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<BackgroundProcess>, ProtocolError> {
        let census = process_census(executor, next)?;
        let now = monotonic_now(executor, next)?;
        let mut found = Vec::new();
        for (session_id, live) in &self.loaded {
            let Some(process) = &live.process else {
                continue;
            };
            let Some(pid) = process.pid else {
                continue;
            };
            let watched_for = now.saturating_sub(process.watched_at_millis) / 1_000;
            for row in claimed_processes(&census, pid, watched_for) {
                found.push(BackgroundProcess {
                    session_id: session_id.clone(),
                    pid: row.pid,
                    parent_pid: row.parent_pid,
                    command: row.command.clone(),
                    running_for_seconds: row.running_for_seconds,
                });
            }
        }
        found.sort_by(|left, right| {
            right
                .running_for_seconds
                .cmp(&left.running_for_seconds)
                .then(left.pid.cmp(&right.pid))
        });
        Ok(found)
    }

    fn read_view(
        &mut self,
        session_id: &str,
        through_round_id: Option<&str>,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<SessionReadView, ProtocolError> {
        self.ensure_loaded(session_id, config, executor, next)?;
        let live = self.live(session_id)?;
        let boundary = match through_round_id {
            Some(round_id) => Some(
                live.rounds
                    .iter()
                    .position(|round| round.round_id == round_id)
                    .ok_or_else(|| not_found(format!("no such round: {round_id}")))?,
            ),
            None => live.rounds.len().checked_sub(1),
        };
        let selected_rounds = boundary.map(|index| &live.rounds[..=index]).unwrap_or(&[]);
        let rounds = selected_rounds
            .iter()
            .map(|round| {
                round.summary(
                    live.active_turn
                        .as_ref()
                        .is_some_and(|turn| turn.round_id == round.round_id),
                )
            })
            .collect::<Vec<_>>();
        let mut all_items = load_log(&live.meta, executor, next)?.items;
        for item in &live.active_items {
            upsert(&mut all_items, overview::condense_item(item));
        }
        let end = boundary
            .and_then(|index| live.rounds.get(index + 1))
            .and_then(|round| round.user_item_id.as_deref())
            .and_then(|next_user| all_items.iter().position(|item| item.id() == next_user))
            .unwrap_or(all_items.len());
        let items = all_items[..end]
            .iter()
            .filter(|item| {
                !matches!(
                    item,
                    TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        let encoded = serde_json::to_vec(&(items.as_slice(), rounds.as_slice()))
            .map_err(|error| internal(format!("encoding session read view: {error}")))?;
        let through_round_id = boundary.map(|index| live.rounds[index].round_id.clone());
        let coverage = live
            .meta
            .imported
            .as_ref()
            .and_then(|imported| imported.coverage.clone())
            .unwrap_or_else(|| HistoryCoverage {
                source_item_count: Some(u64::try_from(items.len()).unwrap_or(u64::MAX)),
                retained_item_count: u64::try_from(items.len()).unwrap_or(u64::MAX),
                omitted_item_count: 0,
                retrieval: RetrievalCapability::Genehub,
                reason: None,
            });
        Ok(SessionReadView {
            meta: live.meta.clone(),
            items,
            rounds,
            source: SessionReadSource {
                session_id: session_id.to_string(),
                through_round_id,
                digest: format!("sha256:{:x}", Sha256::digest(encoded)),
                untrusted: true,
            },
            coverage,
        })
    }

    fn inspect(
        &mut self,
        session_id: &str,
        through_round_id: Option<&str>,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<SessionInspection, ProtocolError> {
        let view = self.read_view(session_id, through_round_id, config, executor, next)?;
        let status = status(self.live(session_id)?);
        Ok(SessionInspection {
            summary: summary(&view.meta, status),
            source: view.source,
            narrative_item_count: u64::try_from(view.items.len()).unwrap_or(u64::MAX),
            round_count: u64::try_from(view.rounds.len()).unwrap_or(u64::MAX),
            latest_round_id: view.rounds.last().map(|round| round.round_id.clone()),
            coverage: view.coverage,
            layers: vec![
                "narrative".to_string(),
                "rounds".to_string(),
                "trunks".to_string(),
                "blobs".to_string(),
                "context".to_string(),
            ],
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn narrative_page(
        &mut self,
        session_id: &str,
        through_round_id: Option<&str>,
        item_id: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<SessionNarrativePage, ProtocolError> {
        let view = self.read_view(session_id, through_round_id, config, executor, next)?;
        if let Some(item_id) = item_id {
            if cursor.is_some() {
                return Err(bad_request("itemId and cursor are mutually exclusive"));
            }
            let item = view
                .items
                .iter()
                .find(|item| item.id() == item_id)
                .cloned()
                .ok_or_else(|| not_found(format!("no such narrative item: {item_id}")))?;
            return Ok(SessionNarrativePage {
                source: view.source,
                items: vec![item],
                next_cursor: None,
            });
        }
        let end = parse_page_cursor(cursor, view.items.len())?;
        let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
        let start = end.saturating_sub(limit);
        Ok(SessionNarrativePage {
            source: view.source,
            items: view.items[start..end].to_vec(),
            next_cursor: (start > 0).then(|| format!("before:{start}")),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn round_page(
        &mut self,
        session_id: &str,
        through_round_id: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<SessionRoundPage, ProtocolError> {
        let view = self.read_view(session_id, through_round_id, config, executor, next)?;
        let end = parse_page_cursor(cursor, view.rounds.len())?;
        let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
        let start = end.saturating_sub(limit);
        Ok(SessionRoundPage {
            source: view.source,
            rounds: view.rounds[start..end].to_vec(),
            next_cursor: (start > 0).then(|| format!("before:{start}")),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn session_context(
        &mut self,
        session_id: &str,
        through_round_id: Option<&str>,
        token_budget: Option<u64>,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<SessionContext, ProtocolError> {
        let view = self.read_view(session_id, through_round_id, config, executor, next)?;
        let boundary = view
            .source
            .through_round_id
            .as_deref()
            .unwrap_or("latest")
            .to_string();
        Ok(context_seed::build_context_seed(
            session_id,
            &boundary,
            view.source.through_round_id.as_deref(),
            &view.meta.agent_id,
            &view.items,
            token_budget
                .unwrap_or(context_seed::DEFAULT_SEED_TOKEN_BUDGET)
                .clamp(2_048, 64_000),
            view.coverage,
            true,
        )
        .context)
    }

    fn kill_background_process(
        &self,
        session_id: &str,
        pid: u32,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        let owned = self
            .background_processes(executor, next)?
            .into_iter()
            .any(|process| process.session_id == session_id && process.pid == pid);
        if !owned {
            return Err(not_found(
                "the process is not currently owned by this session",
            ));
        }
        process_unit(ProcessRequest::EndTree { pid }, executor, next)
    }

    fn kill_all_background_processes(
        &self,
        session_id: &str,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        let pids = self
            .background_processes(executor, next)?
            .into_iter()
            .filter(|process| process.session_id == session_id)
            .map(|process| process.pid)
            .collect::<std::collections::BTreeSet<_>>();
        for pid in pids {
            process_unit(ProcessRequest::EndTree { pid }, executor, next)?;
        }
        Ok(())
    }

    pub(super) fn shutdown(&mut self, executor: &mut impl CapabilityExecutor, next: &mut u64) {
        // Attribute and stop escaped descendants before their Agent parents
        // disappear. Every operation is best-effort because native resource
        // teardown still has to run even if the host census is unavailable.
        if let Ok(processes) = self.background_processes(executor, next) {
            let pids = processes
                .into_iter()
                .map(|process| process.pid)
                .collect::<std::collections::BTreeSet<_>>();
            for pid in pids {
                let _ = process_unit(ProcessRequest::EndTree { pid }, executor, next);
            }
        }
        let resources = self
            .loaded
            .values()
            .filter_map(|live| live.process.as_ref().map(|process| process.resource_id))
            .collect::<Vec<_>>();
        for resource_id in resources {
            let _ = process_call(
                ProcessRequest::Signal {
                    resource_id,
                    signal: ProcessSignal::KillTree,
                },
                executor,
                next,
            );
        }
        self.process_to_session.clear();
        for live in self.loaded.values_mut() {
            live.process = None;
            live.active_turn = None;
            live.closed = true;
        }
    }

    pub(super) fn ensure_workspace_removable(
        &mut self,
        workspace_id: &str,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        self.load_catalog(config, executor, next)?;
        if self.loaded.values().any(|live| {
            live.meta.workspace_id == workspace_id
                && matches!(
                    status(live),
                    SessionStatus::Running | SessionStatus::Waiting
                )
        }) {
            return Err(conflict(
                "stop the workspace's running or waiting sessions before removing it",
            ));
        }
        Ok(())
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
        agent_infos: &[AgentInfo],
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        self.ensure_loaded(session_id, config, executor, next)?;
        self.ensure_claimed(session_id, executor, next)?;
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
        if self
            .live(session_id)?
            .meta
            .imported
            .as_ref()
            .is_some_and(|imported| imported.continuation == ImportContinuation::ReadOnly)
        {
            return Err(conflict(
                "this imported conversation is read-only because its Agent cannot resume it",
            ));
        }
        let pending_seed = match self.live(session_id)?.meta.context_seed.as_ref() {
            Some(seed) if seed.state == ContextSeedState::Pending => Some(seed.text.clone()),
            Some(seed) if seed.state == ContextSeedState::Applying => {
                return Err(conflict(
                    "the reconstructed history may already have been handed to the Agent; create a new fork instead of sending it twice",
                ))
            }
            Some(_) | None => None,
        };

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
            let catalog = catalog_for(&definition, config, agent_infos);
            let process = match start_process(
                self.live(session_id)?,
                definition,
                config,
                &catalog,
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

        let agent_text = if let Some(seed) = pending_seed.as_deref() {
            let live = self.live_mut(session_id)?;
            if let Some(stored) = live.meta.context_seed.as_mut() {
                stored.state = ContextSeedState::Applying;
            }
            let stored = live
                .meta
                .context_seed
                .clone()
                .expect("a pending seed was just observed");
            save_seed(&live.meta, &stored, executor, next)?;
            context_seed::prompt_with_seed(seed, &text)
        } else {
            text.clone()
        };

        if let Err(error) = prompt_process(
            self.live_mut(session_id)?,
            config,
            &turn_id,
            agent_text,
            &attachments,
            executor,
            next,
        ) {
            self.abort_send(session_id, &turn_id, &error, executor, next);
            return Err(error);
        }
        if pending_seed.is_some() {
            let live = self.live_mut(session_id)?;
            if let Some(seed) = live.meta.context_seed.as_mut() {
                seed.state = ContextSeedState::Applied;
            }
            let stored = live
                .meta
                .context_seed
                .clone()
                .expect("an applied seed was just observed");
            save_seed(&live.meta, &stored, executor, next)?;
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
        if let Some(live) = self.loaded.get_mut(session_id) {
            if let Some(seed) = live.meta.context_seed.as_mut() {
                if seed.state == ContextSeedState::Applying {
                    seed.state = ContextSeedState::Pending;
                    let seed = seed.clone();
                    let _ = save_seed(&live.meta, &seed, executor, next);
                }
            }
        }
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

    #[allow(clippy::too_many_arguments)]
    fn fork(
        &mut self,
        session_id: &str,
        turn_id: &str,
        target: Option<ForkTarget>,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        agent_infos: &[AgentInfo],
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
        let source_meta = source.meta.clone();
        let source_definition = agents::require(boot, config, &source_meta.agent_id)?;
        let log = load_log(&source.meta, executor, next)?;
        let at = log
            .items
            .iter()
            .position(|item| {
                matches!(item, TimelineItem::TurnSummary { stats, .. } if stats.turn_id == turn_id)
            })
            .ok_or_else(|| not_found(format!("no completed turn called {turn_id}")))?;
        let checkpoint = match &log.items[at] {
            TimelineItem::TurnSummary { stats, .. } => stats.fork_checkpoint.clone(),
            _ => unreachable!("turn summary position was selected above"),
        };
        let items = log.items[..=at].to_vec();
        let source_round_id = source
            .rounds
            .iter()
            .find(|round| round.adapter_turn_ids.iter().any(|id| id == turn_id))
            .map(|round| round.round_id.clone());
        let explicit_target = target.is_some();
        let target = target.unwrap_or_else(|| ForkTarget {
            agent_id: source_meta.agent_id.clone(),
            workspace_id: None,
            model_id: source_meta.model_id.clone(),
            mode_id: source_meta.mode_id.clone(),
            effort_id: source_meta.effort_id.clone(),
        });
        let same_agent = target.agent_id == source_meta.agent_id;
        let source_thread = source_meta
            .persist
            .as_ref()
            .filter(|persist| persist.agent_id == source_meta.agent_id)
            .and_then(|persist| persist.value.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let native = same_agent
            && source_definition.capabilities().fork
            && checkpoint.is_some()
            && source_thread.is_some();
        if !explicit_target && !source_definition.capabilities().fork {
            return Err(unsupported(format!(
                "the {} agent does not support forking",
                source_meta.agent_id
            )));
        }
        if !explicit_target && checkpoint.is_none() {
            return Err(unsupported("that turn has no Agent fork checkpoint"));
        }
        if !explicit_target && source_thread.is_none() {
            return Err(conflict("the source Agent thread is not available"));
        }
        let target_definition = agents::require(boot, config, &target.agent_id)?;
        ensure_agent_installed(&target_definition, executor, next)?;
        let model_id = target
            .model_id
            .or_else(|| same_agent.then(|| source_meta.model_id.clone()).flatten());
        let mode_id = target
            .mode_id
            .or_else(|| same_agent.then(|| source_meta.mode_id.clone()).flatten());
        let effort_id = target
            .effort_id
            .or_else(|| same_agent.then(|| source_meta.effort_id.clone()).flatten());
        let destination_workspace_id = target
            .workspace_id
            .unwrap_or_else(|| source_meta.workspace_id.clone());
        let destination_workspace = workspace(config, &destination_workspace_id)?;
        let destination_folder = destination_workspace
            .folders
            .first()
            .ok_or_else(|| bad_request("destination workspace has no folders"))?;
        let (root_handle, root, cwd_path) = if destination_workspace_id == source_meta.workspace_id
        {
            (
                source_meta.root_handle.clone(),
                source_meta.root.clone(),
                session_cwd_path(config, &source_meta)?,
            )
        } else {
            (
                destination_folder.root_handle.clone(),
                destination_folder.root.clone(),
                String::new(),
            )
        };
        let (persist, method, context, context_seed) = if native {
            (
                Some(PersistHandle {
                    agent_id: source_meta.agent_id.clone(),
                    value: serde_json::json!({
                        "threadId": source_thread.expect("native fork has a source thread"),
                        "forkCheckpoint": checkpoint.expect("native fork has a checkpoint"),
                    }),
                }),
                ForkMethod::NativeCheckpoint,
                None,
                None,
            )
        } else {
            let catalog = catalog_for(&target_definition, config, agent_infos);
            let context_window = model_id
                .as_deref()
                .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                .or_else(|| {
                    catalog
                        .default_model
                        .as_deref()
                        .and_then(|id| catalog.models.iter().find(|model| model.id == id))
                })
                .and_then(|model| model.context_window);
            let built = context_seed::build_context_seed(
                session_id,
                turn_id,
                source_round_id.as_deref(),
                &source_meta.agent_id,
                &items,
                context_seed::seed_token_budget(context_window),
                coverage_for_meta(&source_meta, items.len()),
                true,
            );
            (
                None,
                ForkMethod::ReconstructedContext,
                Some(built.stats),
                Some(built.seed),
            )
        };
        let (id, timestamp) = identity_and_time(executor, next)?;
        let title = source_meta
            .title
            .as_deref()
            .and_then(|title| normalize_title(Some(format!("{title} · 分支"))));
        let meta = SessionMeta {
            format: SESSION_FORMAT,
            id,
            workspace_id: destination_workspace_id,
            project_key: workspace_project_key(destination_workspace),
            root_handle,
            root,
            cwd_path,
            agent_id: target.agent_id,
            title,
            model_id,
            mode_id,
            effort_id,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            archived: false,
            pending_permission: None,
            pending_permission_at_ms: None,
            persist,
            lineage: Some(SessionLineage {
                source_session_id: session_id.to_string(),
                source_turn_id: turn_id.to_string(),
                source_agent_id: source_meta.agent_id,
                method,
                context,
            }),
            imported: None,
            context_seed,
        };
        let inherited = items
            .iter()
            .cloned()
            .map(|item| ChatRow::Item { item })
            .collect::<Vec<_>>();
        establish(&meta, executor, next)?;
        let lock_resource_id = self.claim_session(&meta, executor, next)?;
        save_meta(&meta, executor, next)?;
        if let Some(seed) = meta.context_seed.as_ref() {
            save_seed(&meta, seed, executor, next)?;
        }
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

    fn fork_export(
        &mut self,
        session_id: &str,
        turn_id: &str,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<ForkTransfer, ProtocolError> {
        self.ensure_loaded(session_id, config, executor, next)?;
        let source = self.live(session_id)?;
        if source.active_turn.is_some() || source.meta.pending_permission.is_some() {
            return Err(conflict(
                "wait for the current turn to finish before forking",
            ));
        }
        let log = load_log(&source.meta, executor, next)?;
        let at = log
            .items
            .iter()
            .position(|item| {
                matches!(item, TimelineItem::TurnSummary { stats, .. } if stats.turn_id == turn_id)
            })
            .ok_or_else(|| not_found(format!("no completed turn called {turn_id}")))?;
        let source_round_id = source
            .rounds
            .iter()
            .find(|round| round.adapter_turn_ids.iter().any(|id| id == turn_id))
            .map(|round| round.round_id.clone());
        let portable = log.items[..=at]
            .iter()
            .cloned()
            .map(portable_fork_item)
            .collect();
        let (items, omitted, altered) = bound_imported_items(portable, executor, next)?;
        let mut coverage = coverage_for_meta(&source.meta, at + 1);
        coverage.retained_item_count =
            u64::try_from((at + 1).saturating_sub(omitted)).unwrap_or(u64::MAX);
        coverage.omitted_item_count = coverage
            .omitted_item_count
            .saturating_add(u64::try_from(omitted).unwrap_or(u64::MAX));
        coverage.source_item_count = Some(
            coverage
                .retained_item_count
                .saturating_add(coverage.omitted_item_count),
        );
        if omitted > 0 || altered > 0 {
            coverage.reason = Some(
                "the portable fork retained a bounded recent visible-history window".to_string(),
            );
        }
        Ok(ForkTransfer {
            source_session_id: session_id.to_string(),
            source_turn_id: turn_id.to_string(),
            source_agent_id: source.meta.agent_id.clone(),
            source_round_id,
            title: source.meta.title.clone(),
            items,
            coverage,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn fork_import(
        &mut self,
        transfer: ForkTransfer,
        target: ForkTarget,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        agent_infos: &[AgentInfo],
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let workspace_id = target
            .workspace_id
            .as_deref()
            .ok_or_else(|| bad_request("portable fork target requires a workspace"))?;
        if !matches!(
            transfer.items.last(),
            Some(TimelineItem::TurnSummary { stats, .. })
                if stats.turn_id == transfer.source_turn_id
        ) {
            return Err(bad_request(
                "the portable fork does not end at its declared completed turn",
            ));
        }
        let raw_count = transfer.items.len();
        let portable = transfer.items.into_iter().map(portable_fork_item).collect();
        let (items, omitted, altered) = bound_imported_items(portable, executor, next)?;
        let mut coverage = transfer.coverage;
        if omitted > 0 || altered > 0 {
            coverage.retained_item_count = coverage
                .retained_item_count
                .min(u64::try_from(raw_count.saturating_sub(omitted)).unwrap_or(u64::MAX));
            coverage.omitted_item_count = coverage
                .omitted_item_count
                .saturating_add(u64::try_from(omitted).unwrap_or(u64::MAX));
            coverage.source_item_count = Some(
                coverage.source_item_count.unwrap_or(0).max(
                    coverage
                        .retained_item_count
                        .saturating_add(coverage.omitted_item_count),
                ),
            );
            coverage.reason =
                Some("the destination bounded the portable fork before reconstruction".to_string());
        }
        coverage.retrieval = RetrievalCapability::Unavailable;
        coverage.reason.get_or_insert_with(|| {
            "the source session remains on another machine after this fork".to_string()
        });
        let definition = agents::require(boot, config, &target.agent_id)?;
        ensure_agent_installed(&definition, executor, next)?;
        let workspace = workspace(config, workspace_id)?;
        let folder = workspace
            .folders
            .first()
            .ok_or_else(|| bad_request("destination workspace has no folders"))?;
        let catalog = catalog_for(&definition, config, agent_infos);
        let model_id = target.model_id.or_else(|| catalog.default_model.clone());
        let context_window = model_id
            .as_deref()
            .and_then(|id| catalog.models.iter().find(|model| model.id == id))
            .and_then(|model| model.context_window);
        let built = context_seed::build_context_seed(
            &transfer.source_session_id,
            &transfer.source_turn_id,
            transfer.source_round_id.as_deref(),
            &transfer.source_agent_id,
            &items,
            context_seed::seed_token_budget(context_window),
            coverage,
            false,
        );
        let (id, timestamp) = identity_and_time(executor, next)?;
        let meta = SessionMeta {
            format: SESSION_FORMAT,
            id,
            workspace_id: workspace_id.to_string(),
            project_key: workspace_project_key(workspace),
            root_handle: folder.root_handle.clone(),
            root: folder.root.clone(),
            cwd_path: String::new(),
            agent_id: target.agent_id,
            title: transfer
                .title
                .as_deref()
                .and_then(|title| normalize_title(Some(format!("{title} · 分支")))),
            model_id,
            mode_id: target.mode_id,
            effort_id: target.effort_id,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            archived: false,
            pending_permission: None,
            pending_permission_at_ms: None,
            persist: None,
            lineage: Some(SessionLineage {
                source_session_id: transfer.source_session_id,
                source_turn_id: transfer.source_turn_id,
                source_agent_id: transfer.source_agent_id,
                method: ForkMethod::ReconstructedContext,
                context: Some(built.stats),
            }),
            imported: None,
            context_seed: Some(built.seed),
        };
        establish(&meta, executor, next)?;
        let lock_resource_id = self.claim_session(&meta, executor, next)?;
        save_meta(&meta, executor, next)?;
        if let Some(seed) = meta.context_seed.as_ref() {
            save_seed(&meta, seed, executor, next)?;
        }
        let inherited = items
            .iter()
            .cloned()
            .map(|item| ChatRow::Item { item })
            .collect::<Vec<_>>();
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
        agent_infos: &[AgentInfo],
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let (agent_id, waiting) = {
            let live = self.live(session_id)?;
            (
                live.meta.agent_id.clone(),
                live.meta.pending_permission.is_some(),
            )
        };
        if waiting && matches!(control, Control::Mode(_)) {
            return Err(conflict(
                "answer or cancel the pending Agent interaction before changing mode",
            ));
        }
        let control =
            validate_control(&agent_id, runtime_catalog(agent_infos, &agent_id), control)?;
        let live = self.live_mut(session_id)?;
        // Ask the running protocol state machine first. A rejected value must
        // not remain in session metadata or be published as if it took effect.
        let command = driver_control(live, &control)?;
        let (event, command) = match &control {
            Control::Model(value) => {
                live.meta.model_id = Some(value.clone());
                (
                    SessionEvent::ModelChanged {
                        model_id: value.clone(),
                    },
                    command,
                )
            }
            Control::Mode(value) => {
                live.meta.mode_id = Some(value.clone());
                (
                    SessionEvent::ModeChanged {
                        mode_id: value.clone(),
                    },
                    command,
                )
            }
            Control::Effort(value) => {
                live.meta.effort_id = Some(value.clone());
                (
                    SessionEvent::EffortChanged {
                        effort_id: value.clone(),
                    },
                    command,
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

    fn stop_pending_turn(
        &mut self,
        session_id: &str,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<Publication>, ProtocolError> {
        let (process, turn_id) = {
            let live = self.live_mut(session_id)?;
            if let Some(turn) = live.active_turn.as_mut() {
                // `settle` deliberately keeps an interrupted round open. The
                // approval continuation becomes another adapter turn in that
                // same user round instead of a new conversation round.
                turn.interrupted = true;
            }
            (
                live.process.take(),
                live.active_turn.as_ref().map(|turn| turn.id.clone()),
            )
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
        match turn_id {
            Some(turn_id) => self.apply_events(
                session_id,
                vec![SessionEvent::TurnCanceled { turn_id }],
                executor,
                next,
            ),
            None => Ok(Vec::new()),
        }
    }

    fn stop_for_interaction(
        &mut self,
        session_id: &str,
        request: PermissionRequest,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<Publication>, ProtocolError> {
        let timestamp = now(executor, next)?;
        {
            let live = self.live_mut(session_id)?;
            live.meta.pending_permission = Some(request.clone());
            live.meta.pending_permission_at_ms = Some(timestamp);
            live.meta.updated_at_ms = timestamp;
            live.pending_permissions = vec![request.clone()];
            // Durable before the process is touched. If the daemon stops on
            // the next instruction, restart still exposes the waiting card.
            save_meta(&live.meta, executor, next)?;
        }
        let mut publications = self.stop_pending_turn(session_id, executor, next)?;
        publications.extend(self.apply_events(
            session_id,
            vec![SessionEvent::PermissionRequested { request }],
            executor,
            next,
        )?);
        Ok(publications)
    }

    #[allow(clippy::too_many_arguments)]
    fn permission(
        &mut self,
        session_id: &str,
        request_id: String,
        outcome: PermissionOutcome,
        boot: &genet_daemon_logic_api::LogicBoot,
        config: &Config,
        agent_infos: &[AgentInfo],
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let request = self
            .live(session_id)?
            .meta
            .pending_permission
            .as_ref()
            .filter(|request| request.id == request_id)
            .cloned()
            .ok_or_else(|| not_found(format!("no permission request {request_id}")))?;
        let continuation = continuation_for(&request, &outcome)?;
        let mut publications = if self.live(session_id)?.process.is_some()
            || self.live(session_id)?.active_turn.is_some()
        {
            // Compatibility with a snapshot made by an early Wasm build that
            // still kept interactive Agent processes alive.
            self.stop_pending_turn(session_id, executor, next)?
        } else {
            Vec::new()
        };

        if let Some(continuation) = continuation {
            let agent_id = self.live(session_id)?.meta.agent_id.clone();
            let definition = agents::require(boot, config, &agent_id)?;
            let catalog = catalog_for(&definition, config, agent_infos);
            let mode_override = continuation
                .elevated
                .then(|| catalog.default_mode.clone())
                .flatten();
            let (id, timestamp) = identity_and_time(executor, next)?;
            let turn_id = format!("turn_{}", id.trim_start_matches("s_"));
            let mut launch_live = self.live(session_id)?.clone();
            if let Some(mode) = &mode_override {
                launch_live.meta.mode_id = Some(mode.clone());
            }
            let process = start_process(
                &launch_live,
                definition,
                config,
                &catalog,
                &turn_id,
                &[],
                executor,
                next,
            )?;
            self.process_to_session
                .insert(process.resource_id, session_id.to_string());
            self.live_mut(session_id)?.process = Some(process);
            if let Err(error) = prompt_process(
                self.live_mut(session_id)?,
                config,
                &turn_id,
                continuation.prompt,
                &[],
                executor,
                next,
            ) {
                let process = self.live_mut(session_id)?.process.take();
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
                return Err(error);
            }
            {
                let live = self.live_mut(session_id)?;
                let round = live
                    .rounds
                    .iter_mut()
                    .rev()
                    .find(|round| round.outcome.is_none())
                    .ok_or_else(|| conflict("the interrupted round is no longer open"))?;
                if !round.adapter_turn_ids.iter().any(|id| id == &turn_id) {
                    round.adapter_turn_ids.push(turn_id.clone());
                }
                if let Some(blocked_at) = live.meta.pending_permission_at_ms {
                    round.blocked_ms = round
                        .blocked_ms
                        .saturating_add(timestamp.saturating_sub(blocked_at));
                }
                let round_id = round.round_id.clone();
                let user_item_id = round.user_item_id.clone().unwrap_or_default();
                live.active_turn = Some(ActiveTurn {
                    id: turn_id.clone(),
                    started_at_ms: timestamp,
                    user_item_id,
                    round_id,
                    interrupted: false,
                });
                live.meta.pending_permission = None;
                live.meta.pending_permission_at_ms = None;
                live.meta.updated_at_ms = timestamp;
                live.pending_permissions.clear();
                append_rows(
                    &live.meta,
                    &[ChatRow::Round {
                        round: round.clone(),
                    }],
                    executor,
                    next,
                )?;
                save_meta(&live.meta, executor, next)?;
                publications.push(publish(
                    live,
                    SessionEvent::PermissionResolved {
                        request_id: request_id.clone(),
                        outcome: outcome.clone(),
                    },
                ));
                publications.push(publish(
                    live,
                    SessionEvent::TurnStarted {
                        turn_id,
                        started_at_ms: timestamp,
                    },
                ));
            }
        } else {
            let timestamp = now(executor, next)?;
            let live = self.live_mut(session_id)?;
            if let Some(round) = live
                .rounds
                .iter_mut()
                .rev()
                .find(|round| round.outcome.is_none())
            {
                if let Some(blocked_at) = live.meta.pending_permission_at_ms {
                    round.blocked_ms = round
                        .blocked_ms
                        .saturating_add(timestamp.saturating_sub(blocked_at));
                }
                round.ended_at_ms = timestamp;
                round.outcome = Some(rounds::RoundOutcome::Canceled);
                append_rows(
                    &live.meta,
                    &[ChatRow::Round {
                        round: round.clone(),
                    }],
                    executor,
                    next,
                )?;
            }
            live.meta.pending_permission = None;
            live.meta.pending_permission_at_ms = None;
            live.meta.updated_at_ms = timestamp;
            live.pending_permissions.clear();
            live.settled_status = Some(SessionStatus::Idle);
            save_meta(&live.meta, executor, next)?;
            publications.push(publish(
                live,
                SessionEvent::PermissionResolved {
                    request_id,
                    outcome,
                },
            ));
            publications.push(publish(
                live,
                SessionEvent::SessionStatusChanged {
                    status: SessionStatus::Idle,
                },
            ));
        }
        Ok(Response {
            reply: Reply::Ack,
            connection: ConnectionDirective::None,
            publications,
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
                let (mut events, writes, persistence) = {
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
                        let event_count = events.len();
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
                        // A durable interaction is a process boundary. Anything
                        // else already buffered after it belongs to the Agent
                        // process that is about to be discarded, not to the
                        // eventual resumed turn.
                        if events[event_count..]
                            .iter()
                            .any(|event| matches!(event, SessionEvent::PermissionRequested { .. }))
                        {
                            break;
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
                if let Some(position) = events
                    .iter()
                    .position(|event| matches!(event, SessionEvent::PermissionRequested { .. }))
                {
                    let request = match events.get(position) {
                        Some(SessionEvent::PermissionRequested { request }) => request.clone(),
                        _ => unreachable!("the position was selected by the same pattern"),
                    };
                    let preceding = events.drain(..position).collect();
                    let mut publications =
                        self.apply_events(&session_id, preceding, executor, next)?;
                    publications.extend(self.stop_for_interaction(
                        &session_id,
                        request,
                        executor,
                        next,
                    )?);
                    Ok(publications)
                } else {
                    self.apply_events(&session_id, events, executor, next)
                }
            }
            CapabilityEvent::ProcessExited { resource_id, code } => {
                let Some(session_id) = self.process_to_session.remove(&resource_id) else {
                    return Ok(Vec::new());
                };
                let live = self.live_mut(&session_id)?;
                let process = live.process.take();
                let clean_opencode_exit = code == Some(0)
                    && process.as_ref().is_some_and(|process| {
                        matches!(
                            &process.driver,
                            Driver::OpenCode(driver) if driver.can_complete_on_clean_exit()
                        )
                    });
                let tail = process
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
                let event = if clean_opencode_exit {
                    SessionEvent::TurnCompleted {
                        turn_id,
                        usage: genehub_proto::Usage::default(),
                        fork_checkpoint: None,
                    }
                } else {
                    SessionEvent::TurnFailed {
                        turn_id,
                        error: genehub_proto::TurnError {
                            code: genehub_proto::TurnErrorCode::AgentCrashed,
                            message: format!("Agent exited with code {code:?}{suffix}"),
                        },
                    }
                };
                self.apply_events(&session_id, vec![event], executor, next)
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
            if terminal {
                publications.push(Publication::Fanout(
                    genehub_proto::ServerFrame::BackgroundProcesses {
                        processes: self.background_processes(executor, next)?,
                    },
                ));
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
            // A `.code-workspace` may keep sessions under any one of its
            // physical roots. Scanning only the first silently lost sessions
            // whose explicit cwd selected another folder after restart.
            for folder in &workspace.folders {
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
                        if error.kind
                            == genet_daemon_logic_api::CapabilityFailureKind::NotFound =>
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
                    if tombstoned(root.clone(), &entry.name, executor, next)? {
                        reap_tombstoned(root.clone(), &entry.name, executor, next);
                        continue;
                    }
                    if let Ok(mut meta) =
                        load_meta(root.clone(), &entry.name, workspace, folder, executor, next)
                    {
                        let log = if meta.format <= SESSION_FORMAT {
                            if meta.context_seed.is_none() {
                                meta.context_seed = load_seed(&meta, executor, next)?;
                            }
                            load_log(&meta, executor, next).unwrap_or_default()
                        } else {
                            ChatLog::default()
                        };
                        self.loaded.insert(
                            meta.id.clone(),
                            LiveSession {
                                pending_permissions: meta
                                    .pending_permission
                                    .clone()
                                    .into_iter()
                                    .collect(),
                                meta,
                                lock_resource_id: 0,
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
        match self.loaded.get(id) {
            Some(live) if live.meta.format > SESSION_FORMAT => Err(unsupported(format!(
                "session {id} uses format {}, but this build supports through {SESSION_FORMAT}",
                live.meta.format
            ))),
            Some(_) => Ok(()),
            None => Err(not_found(format!("no such session: {id}"))),
        }
    }

    fn ensure_claimed(
        &mut self,
        id: &str,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        if self.live(id)?.lock_resource_id != 0 {
            return Ok(());
        }
        let meta = self.live(id)?.meta.clone();
        let resource_id = self.claim_session(&meta, executor, next)?;
        if tombstoned(
            FileRoot::Workspace {
                handle: meta.root_handle.clone(),
            },
            id,
            executor,
            next,
        )? {
            let _ = unlock_session(resource_id, executor, next);
            return Err(not_found(format!("no such session: {id}")));
        }
        self.live_mut(id)?.lock_resource_id = resource_id;
        Ok(())
    }

    fn claim_session(
        &mut self,
        meta: &SessionMeta,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<u64, ProtocolError> {
        if !self.compatibility_locks.contains_key(&meta.root_handle) {
            let resource_id = lock_legacy_owner(meta, executor, next)?;
            self.compatibility_locks
                .insert(meta.root_handle.clone(), resource_id);
        }
        lock_session(meta, executor, next)
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

#[derive(Debug)]
enum Control {
    Model(String),
    Mode(String),
    Effort(String),
}

fn catalog_for(
    definition: &AgentDefinition,
    config: &Config,
    agent_infos: &[AgentInfo],
) -> Catalog {
    agent_infos
        .iter()
        .find(|agent| agent.id == definition.id)
        .map(|agent| agent.catalog.clone())
        .unwrap_or_else(|| definition.catalog(config))
}

fn runtime_catalog<'a>(agent_infos: &'a [AgentInfo], agent_id: &str) -> Option<&'a Catalog> {
    agent_infos
        .iter()
        .find(|agent| agent.id == agent_id)
        .map(|agent| &agent.catalog)
}

fn offered<'a>(
    axis: &str,
    value: &str,
    values: impl Iterator<Item = &'a str>,
    reject_empty: bool,
) -> Result<(), ProtocolError> {
    let values = values.collect::<Vec<_>>();
    if values.contains(&value) || (values.is_empty() && !reject_empty) {
        return Ok(());
    }
    Err(bad_request(format!(
        "'{value}' is not a {axis} this agent offers ({})",
        if values.is_empty() {
            "it listed none".to_string()
        } else {
            values.join(", ")
        }
    )))
}

fn model_efforts(catalog: &Catalog) -> impl Iterator<Item = &str> {
    catalog
        .models
        .iter()
        .flat_map(|model| model.efforts.iter().map(String::as_str))
}

fn claude_mode(value: &str, catalog: &Catalog) -> Option<String> {
    if matches!(value, "default" | "manual") {
        return catalog
            .modes
            .iter()
            .find(|mode| mode.label == "Default")
            .map(|mode| mode.id.clone())
            .or_else(|| {
                catalog
                    .modes
                    .iter()
                    .find(|mode| matches!(mode.id.as_str(), "default" | "manual"))
                    .map(|mode| mode.id.clone())
            });
    }
    catalog
        .modes
        .iter()
        .find(|mode| mode.id == value)
        .map(|mode| mode.id.clone())
}

fn validate_control(
    agent_id: &str,
    catalog: Option<&Catalog>,
    control: Control,
) -> Result<Control, ProtocolError> {
    match control {
        Control::Model(value) => {
            if agent_id == "genet" {
                genet::validate_model(&value)?;
            } else if agent_id == "opencode" && !value.contains('/') {
                return Err(bad_request(format!(
                    "model id must be 'provider/id', got '{value}'"
                )));
            } else if let Some(catalog) = catalog {
                offered(
                    "model",
                    &value,
                    catalog.models.iter().map(|model| model.id.as_str()),
                    agent_id == "claude",
                )?;
            }
            Ok(Control::Model(value))
        }
        Control::Mode(value) => {
            if agent_id == "genet" {
                genet::validate_effort(&value)?;
                return Ok(Control::Mode(value));
            }
            if agent_id == "opencode" {
                return Err(unsupported("OpenCode does not expose switchable modes"));
            }
            let value = if agent_id == "claude" {
                match catalog {
                    Some(catalog) => claude_mode(&value, catalog).ok_or_else(|| {
                        bad_request(format!("'{value}' is not a mode this Claude Code offers"))
                    })?,
                    None => value,
                }
            } else {
                if let Some(catalog) = catalog {
                    offered(
                        "mode",
                        &value,
                        catalog.modes.iter().map(|mode| mode.id.as_str()),
                        false,
                    )?;
                }
                value
            };
            Ok(Control::Mode(value))
        }
        Control::Effort(value) => {
            if agent_id == "genet" {
                genet::validate_effort(&value)?;
            } else if matches!(agent_id, "cursor" | "acp") || agent_id.starts_with("acp:") {
                return Err(unsupported("ACP does not expose an effort control"));
            } else if let Some(catalog) = catalog {
                offered(
                    "effort level",
                    &value,
                    model_efforts(catalog),
                    agent_id == "claude",
                )?;
            }
            Ok(Control::Effort(value))
        }
    }
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

struct LaunchChoices {
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
}

fn launch_choices(kind: &AgentKind, meta: &SessionMeta, catalog: &Catalog) -> LaunchChoices {
    match kind {
        AgentKind::Claude => LaunchChoices {
            // Claude silently accepts unknown aliases while continuing to use
            // its previous model. Only pass values this installed CLI named.
            model: meta.model_id.clone().filter(|value| {
                catalog
                    .models
                    .iter()
                    .any(|model| model.id == value.as_str())
            }),
            mode: meta
                .mode_id
                .as_deref()
                .and_then(|value| claude_mode(value, catalog))
                .or_else(|| catalog.default_mode.clone())
                .or_else(|| Some("bypassPermissions".to_string())),
            effort: meta
                .effort_id
                .clone()
                .filter(|value| model_efforts(catalog).any(|effort| effort == value.as_str())),
        },
        AgentKind::Codex => LaunchChoices {
            model: meta
                .model_id
                .clone()
                .filter(|value| {
                    catalog
                        .models
                        .iter()
                        .any(|model| model.id == value.as_str())
                })
                .or_else(|| catalog.default_model.clone()),
            mode: meta
                .mode_id
                .clone()
                .filter(|value| catalog.modes.iter().any(|mode| mode.id == value.as_str()))
                .or_else(|| catalog.default_mode.clone())
                .or_else(|| Some("full-access".to_string())),
            effort: meta
                .effort_id
                .clone()
                .filter(|value| model_efforts(catalog).any(|effort| effort == value.as_str()))
                .or_else(|| catalog.default_effort.clone()),
        },
        AgentKind::Genet | AgentKind::OpenCode | AgentKind::Acp => LaunchChoices {
            model: meta.model_id.clone(),
            mode: meta.mode_id.clone(),
            effort: meta.effort_id.clone(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn start_process(
    live: &LiveSession,
    definition: AgentDefinition,
    config: &Config,
    catalog: &Catalog,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<AgentProcess, ProtocolError> {
    let mut args = definition.args().to_vec();
    let mut env = std::collections::BTreeMap::new();
    let workspace_root = workspace_root_for_meta(config, &live.meta)?;
    // `cwd_path` comes from durable guest-owned metadata. Resolve it through
    // the native filesystem capability again at the execution boundary: this
    // canonicalizes symlinks, verifies the registered roots and refuses a
    // tampered path before either the process API or ACP sees a native string.
    let (cwd_handle, native_cwd, cwd_path) = resolve_session_cwd(
        workspace(config, &live.meta.workspace_id)?,
        Some(live.meta.root.clone()),
        executor,
        next,
    )?;
    let product_guidance = artifact_links::guidance();
    let tagged_guidance = artifact_links::tagged_guidance();
    let choices = launch_choices(&definition.kind, &live.meta, catalog);
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
                choices
                    .mode
                    .clone()
                    .unwrap_or_else(|| "bypassPermissions".to_string()),
                "--append-system-prompt".to_string(),
                product_guidance.to_string(),
            ]);
            if let Some(model) = &choices.model {
                args.extend(["--model".to_string(), model.clone()]);
            }
            if let Some(effort) = &choices.effort {
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
            Driver::Claude(claude::Driver::new(choices.mode.as_deref(), session_id))
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
                choices.mode.as_deref(),
                choices.model.as_deref(),
                choices.effort.as_deref(),
                Some(product_guidance),
            ))
        }
        AgentKind::Genet => {
            args.extend([
                "--mode".to_string(),
                "rpc".to_string(),
                "--add-system-prompt".to_string(),
                product_guidance.to_string(),
            ]);
            if let Some(model) = &choices.model {
                args.extend(["--model".to_string(), model.clone()]);
            }
            if let Some(effort) = choices.effort.as_ref().or(choices.mode.as_ref()) {
                args.extend(["--thinking".to_string(), effort.clone()]);
            }
            let home = format!(".genethub/sessions/{}/state/genet", live.meta.id);
            write_genet_models(&live.meta, &home, config, executor, next)?;
            env.insert(
                definition
                    .home_env
                    .clone()
                    .unwrap_or_else(|| "GENET_AGENT_HOME".to_string()),
                native_child_path(workspace_root, &home),
            );
            args.extend([
                "--session".to_string(),
                native_child_path(workspace_root, &format!("{home}/session.jsonl")),
            ]);
            Driver::Genet(genet::Driver::default())
        }
        AgentKind::OpenCode => {
            env.insert(
                "OPENCODE_PERMISSION".to_string(),
                r#"{"*":"allow","read":"allow","edit":"allow","glob":"allow","grep":"allow","bash":"allow","task":"allow","skill":"allow","lsp":"allow","question":"allow","webfetch":"allow","websearch":"allow","external_directory":"allow","doom_loop":"allow"}"#.to_string(),
            );
            env.insert(
                "OPENCODE_CONFIG_CONTENT".to_string(),
                serde_json::json!({
                    "agent": {
                        "genehub": {
                            "description": "GeneHub session agent",
                            "mode": "primary",
                            "prompt": product_guidance,
                        }
                    }
                })
                .to_string(),
            );
            args.extend([
                "run".to_string(),
                "--format".to_string(),
                "json".to_string(),
                "--dangerously-skip-permissions".to_string(),
                "--agent".to_string(),
                "genehub".to_string(),
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
            if let Some(model) = &choices.model {
                args.extend(["--model".to_string(), model.clone()]);
            }
            if let Some(effort) = &choices.effort {
                args.extend(["--variant".to_string(), effort.clone()]);
            }
            args.extend(opencode_attachments(
                live,
                turn_id,
                attachments,
                workspace_root,
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
            native_cwd,
            live.meta
                .persist
                .as_ref()
                .filter(|persist| persist.agent_id == definition.id)
                .map(|persist| &persist.value),
            choices.model.as_deref(),
            choices.mode.as_deref(),
            Some(&tagged_guidance),
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
                root: FileRoot::Workspace { handle: cwd_handle },
                path: cwd_path,
            }),
            confinement: genet_daemon_logic_api::ConfinementMode::None,
            capture_stdout: true,
            capture_stderr: true,
        },
    )))?;
    let (resource_id, pid) = match value {
        CapabilityValue::ProcessStarted { resource_id, pid } => (resource_id, pid),
        _ => return Err(internal("process spawn returned the wrong value")),
    };
    let watched_at_millis = monotonic_now(executor, next)?;
    Ok(AgentProcess {
        resource_id,
        pid,
        watched_at_millis,
        definition,
        stdout: Vec::new(),
        stderr_tail: Vec::new(),
        driver,
    })
}

fn prompt_process(
    live: &mut LiveSession,
    config: &Config,
    turn_id: &str,
    text: String,
    attachments: &[genehub_proto::Attachment],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let workspace_root = workspace_root_for_meta(config, &live.meta)?;
    let attachment_paths = codex_attachment_paths(&live.meta, workspace_root, turn_id, attachments);
    let process = live
        .process
        .as_mut()
        .ok_or_else(|| internal("the session has no running Agent process"))?;
    let (commands, close_input) = match &mut process.driver {
        Driver::Claude(driver) => (
            vec![driver
                .prompt(turn_id, text, attachments)
                .map_err(internal)?],
            false,
        ),
        Driver::Codex(driver) => (
            driver
                .prompt(turn_id, text, attachment_paths)
                .map_err(internal)?,
            false,
        ),
        Driver::Genet(driver) => (vec![driver.prompt(turn_id, text)], false),
        Driver::Acp(driver) => (
            driver
                .prompt(turn_id, text, attachments)
                .map_err(internal)?,
            false,
        ),
        Driver::OpenCode(_) => (vec![text.into_bytes()], true),
    };
    for command in commands {
        process_write(process.resource_id, command, executor, next)?;
    }
    if close_input {
        process_call(
            ProcessRequest::CloseInput {
                resource_id: process.resource_id,
            },
            executor,
            next,
        )?;
    }
    Ok(())
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
    workspace_root: &str,
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
            native_child_path(workspace_root, &relative),
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
    workspace_root: &str,
    turn_id: &str,
    attachments: &[genehub_proto::Attachment],
) -> Vec<String> {
    codex_attachment_relatives(meta, turn_id, attachments)
        .into_iter()
        .map(|relative| native_child_path(workspace_root, &relative))
        .collect()
}

fn native_child_path(workspace_root: &str, relative: &str) -> String {
    if relative.is_empty() {
        return workspace_root.trim_end_matches(['/', '\\']).to_string();
    }
    let separator = if workspace_root.contains('\\') {
        '\\'
    } else {
        '/'
    };
    format!(
        "{}{}{}",
        workspace_root.trim_end_matches(['/', '\\']),
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

fn process_unit(
    request: ProcessRequest,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    process_call(request, executor, next)
}

fn process_census(
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<ProcessCensusRow>, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Process(ProcessRequest::Census))? {
        CapabilityValue::ProcessCensus(rows) => Ok(rows),
        _ => Err(internal("process census returned the wrong value")),
    }
}

fn claimed_processes(
    census: &[ProcessCensusRow],
    agent_pid: u32,
    watched_for_seconds: u64,
) -> Vec<&ProcessCensusRow> {
    const CLOCK_SLACK_SECONDS: u64 = 5;
    let still_agent = census.iter().any(|row| {
        row.pid == agent_pid
            && row.running_for_seconds.saturating_add(CLOCK_SLACK_SECONDS) >= watched_for_seconds
    });
    if !still_agent {
        return Vec::new();
    }
    let mut descendants = std::collections::HashSet::from([agent_pid]);
    loop {
        let before = descendants.len();
        for row in census {
            if descendants.contains(&row.parent_pid) {
                descendants.insert(row.pid);
            }
        }
        if descendants.len() == before {
            break;
        }
    }
    census
        .iter()
        .filter(|row| row.pid != agent_pid)
        .filter(|row| row.group_id == agent_pid || descendants.contains(&row.pid))
        .collect()
}

fn parse_page_cursor(cursor: Option<&str>, length: usize) -> Result<usize, ProtocolError> {
    match cursor {
        None => Ok(length),
        Some(cursor) => {
            let value = cursor
                .strip_prefix("before:")
                .ok_or_else(|| bad_request("invalid page cursor"))?
                .parse::<usize>()
                .map_err(|_| bad_request("invalid page cursor"))?;
            if value > length {
                return Err(bad_request("page cursor is outside the current view"));
            }
            Ok(value)
        }
    }
}

fn ensure_agent_installed(
    definition: &AgentDefinition,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let program = definition
        .program()
        .ok_or_else(|| bad_request("agent command is empty"))?;
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Process(ProcessRequest::ResolveProgram {
        program: program.to_string(),
    }))? {
        CapabilityValue::Text(_) => Ok(()),
        _ => Err(internal("agent resolver returned the wrong value")),
    }
}

fn coverage_for_meta(meta: &SessionMeta, retained_items: usize) -> HistoryCoverage {
    meta.imported
        .as_ref()
        .and_then(|imported| imported.coverage.clone())
        .unwrap_or_else(|| HistoryCoverage {
            source_item_count: Some(u64::try_from(retained_items).unwrap_or(u64::MAX)),
            retained_item_count: u64::try_from(retained_items).unwrap_or(u64::MAX),
            omitted_item_count: 0,
            retrieval: RetrievalCapability::Genehub,
            reason: None,
        })
}

fn portable_fork_item(mut item: TimelineItem) -> TimelineItem {
    match &mut item {
        TimelineItem::TurnSummary { stats, .. } => stats.fork_checkpoint = None,
        TimelineItem::UserMessage { attachments, .. } => {
            for attachment in attachments {
                attachment.path = None;
            }
        }
        _ => {}
    }
    item
}

fn bound_imported_items(
    items: Vec<TimelineItem>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(Vec<TimelineItem>, usize, usize), ProtocolError> {
    let total = items.len();
    let mut kept = Vec::new();
    let mut bytes = 0usize;
    let mut altered = 0usize;
    for mut item in items.into_iter().rev() {
        if kept.len() >= IMPORT_VISIBLE_ITEMS {
            break;
        }
        let mut item_bytes = serde_json::to_vec(&item)
            .map(|encoded| encoded.len().saturating_add(1))
            .unwrap_or(IMPORT_VISIBLE_BYTES);
        if item_bytes > IMPORT_VISIBLE_BYTES {
            let original = item.clone();
            item = truncate_import_item(item, IMPORT_VISIBLE_BYTES / 2);
            if item != original {
                altered = altered.saturating_add(1);
            }
            item_bytes = serde_json::to_vec(&item)
                .map(|encoded| encoded.len().saturating_add(1))
                .unwrap_or(IMPORT_VISIBLE_BYTES);
        }
        if !kept.is_empty() && bytes.saturating_add(item_bytes) > IMPORT_VISIBLE_BYTES {
            break;
        }
        bytes = bytes.saturating_add(item_bytes);
        kept.push(item);
    }
    kept.reverse();
    let omitted = total.saturating_sub(kept.len());
    if omitted > 0 {
        let (id, _) = identity_and_time(executor, next)?;
        kept.insert(
            0,
            TimelineItem::Compaction {
                id: format!("import-{}", id.trim_start_matches("s_")),
                reason: format!("导入历史过长，较早的 {omitted} 项未放入当前可见窗口"),
            },
        );
    }
    Ok((kept, omitted, altered))
}

fn truncate_import_item(mut item: TimelineItem, max_bytes: usize) -> TimelineItem {
    let id = item.id().to_string();
    let text = match &mut item {
        TimelineItem::UserMessage { text, .. }
        | TimelineItem::AssistantMessage { text, .. }
        | TimelineItem::Reasoning { text, .. } => Some(text),
        TimelineItem::Compaction { reason, .. } => Some(reason),
        TimelineItem::Error { message, .. } => Some(message),
        _ => None,
    };
    if let Some(text) = text {
        if text.len() > max_bytes {
            let mut boundary = max_bytes.min(text.len());
            while boundary > 0 && !text.is_char_boundary(boundary) {
                boundary -= 1;
            }
            text.truncate(boundary);
            text.push_str("\n\n[单条消息过长，导入时已截断]");
        }
    }
    if serde_json::to_vec(&item).is_ok_and(|encoded| encoded.len() <= max_bytes) {
        item
    } else {
        TimelineItem::Compaction {
            id,
            reason: "单条历史记录过长，导入时已省略".to_string(),
        }
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
            live.meta.pending_permission_at_ms = None;
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
        unsupported: (meta.format > SESSION_FORMAT).then_some(genehub_proto::UnsupportedFormat {
            written: meta.format,
            supported: SESSION_FORMAT,
        }),
        lineage: meta.lineage.clone(),
        imported: meta.imported.as_ref().map(|imported| SessionImportOrigin {
            agent_id: imported.agent_id.clone(),
            continuation: imported.continuation,
            warnings: imported.warnings.clone(),
            coverage: imported.coverage.clone(),
        }),
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

fn workspace_root_for_meta<'a>(
    config: &'a Config,
    meta: &SessionMeta,
) -> Result<&'a str, ProtocolError> {
    let workspace = workspace(config, &meta.workspace_id)?;
    workspace
        .folders
        .iter()
        .find(|folder| folder.root_handle == meta.root_handle)
        .map(|folder| folder.root.as_str())
        .ok_or_else(|| internal("session workspace root handle is no longer registered"))
}

fn session_cwd_path(config: &Config, meta: &SessionMeta) -> Result<String, ProtocolError> {
    if !meta.cwd_path.is_empty() {
        return Ok(meta.cwd_path.clone());
    }
    relative_native_path(workspace_root_for_meta(config, meta)?, &meta.root).ok_or_else(|| {
        conflict("session working directory is outside its registered workspace root")
    })
}

/// Recovers the locator-safe spelling for metadata written before format 7.
/// New metadata stores this value directly; string recovery only exists so an
/// already-created subdirectory session keeps its cwd after an upgrade.
fn relative_native_path(workspace_root: &str, cwd: &str) -> Option<String> {
    let workspace_root = workspace_root.replace('\\', "/");
    let cwd = cwd.replace('\\', "/");
    let workspace_root = workspace_root.trim_end_matches('/');
    let cwd = cwd.trim_end_matches('/');
    if cwd == workspace_root {
        return Some(String::new());
    }
    cwd.strip_prefix(workspace_root)
        .and_then(|relative| relative.strip_prefix('/'))
        .filter(|relative| !relative.is_empty())
        .map(str::to_string)
}

fn resolve_session_cwd(
    workspace: &WorkspaceEntry,
    cwd: Option<String>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(String, String, String), ProtocolError> {
    let first = workspace
        .folders
        .first()
        .ok_or_else(|| bad_request("workspace has no folders"))?;
    let roots = workspace
        .folders
        .iter()
        .map(|folder| genet_daemon_logic_api::WorkspaceRootPath {
            handle: folder.root_handle.clone(),
            native_path: folder.root.clone(),
        })
        .collect();
    let mut client = Client::new(executor, next);
    let locator = match client.call(CapabilityRequest::File(FileRequest::ResolveWorkspacePath {
        roots,
        default_handle: first.root_handle.clone(),
        path: cwd,
    }))? {
        CapabilityValue::FileLocator(locator) => locator,
        _ => return Err(internal("workspace cwd resolver returned the wrong value")),
    };
    let FileLocator { root, path } = locator;
    let FileRoot::Workspace { handle } = root else {
        return Err(internal(
            "workspace cwd resolver returned a non-workspace root",
        ));
    };
    let folder = workspace
        .folders
        .iter()
        .find(|folder| folder.root_handle == handle)
        .ok_or_else(|| internal("workspace cwd resolver returned an unknown root"))?;
    let separator = if folder.root.contains('\\') {
        '\\'
    } else {
        '/'
    };
    let native_root = if path.is_empty() {
        folder.root.clone()
    } else {
        format!(
            "{}{}{}",
            folder.root.trim_end_matches(['/', '\\']),
            separator,
            path.replace('/', &separator.to_string())
        )
    };
    Ok((handle, native_root, path))
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

fn lock_legacy_owner(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<u64, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Lock {
        locator: locator(meta, ".genethub/owner.lock"),
        exclusive: false,
    }))? {
        CapabilityValue::FileLocked { resource_id } => Ok(resource_id),
        _ => Err(internal(
            "legacy workspace compatibility lock returned the wrong value",
        )),
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

fn tombstoned(
    root: FileRoot,
    id: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<bool, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call_raw(CapabilityRequest::File(FileRequest::Metadata {
        locator: FileLocator {
            root,
            path: format!(".genethub/tombstones/{id}.json"),
        },
    }))? {
        Ok(CapabilityValue::FileMetadata(metadata)) => Ok(metadata.kind == FileKind::File),
        Err(error) if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound => {
            Ok(false)
        }
        Err(error) => Err(capability_error(error)),
        Ok(_) => Err(internal(
            "session tombstone metadata returned the wrong value",
        )),
    }
}

fn write_tombstone(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let timestamp = now(executor, next)?;
    let mut client = Client::new(executor, next);
    client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
        locator: locator(meta, ".genethub/tombstones"),
    }))?;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "sessionId": meta.id,
        "deletedAtMs": timestamp,
    }))
    .map_err(|error| internal(format!("encoding session tombstone: {error}")))?;
    match client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(meta, &format!(".genethub/tombstones/{}.json", meta.id)),
        bytes,
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("session tombstone write returned the wrong value")),
    }
}

fn reap_tombstoned(
    root: FileRoot,
    id: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) {
    let mut client = Client::new(executor, next);
    let lock = client.call_raw(CapabilityRequest::File(FileRequest::Lock {
        locator: FileLocator {
            root: root.clone(),
            path: format!(".genethub/sessions/{id}/writer.lock"),
        },
        exclusive: true,
    }));
    let Ok(Ok(CapabilityValue::FileLocked { resource_id })) = lock else {
        return;
    };
    let _ = client.call_raw(CapabilityRequest::File(FileRequest::Unlock { resource_id }));
    let _ = client.call_raw(CapabilityRequest::File(FileRequest::RemoveDirAll {
        locator: FileLocator {
            root,
            path: format!(".genethub/sessions/{id}"),
        },
    }));
}

fn save_meta(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    // A read of an older session is deliberately non-mutating, but the first
    // write by this build must make the one-way format transition explicit.
    // Otherwise an older daemon can reopen metadata containing semantics it
    // does not understand (fork context, imported read-only state, or cwdPath)
    // and silently run the wrong Agent context.
    let mut stamped = meta.clone();
    stamped.format = SESSION_FORMAT;
    let bytes = serde_json::to_vec_pretty(&stamped)
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
    let header: MetaHeader = serde_json::from_slice(&bytes)
        .map_err(|error| internal(format!("parsing session {id} header: {error}")))?;
    let expected_project_key = workspace_project_key(workspace);
    if !header.project_key.is_empty() && header.project_key != expected_project_key {
        return Err(conflict(format!(
            "session {id} belongs to another workspace"
        )));
    }
    if header.format > SESSION_FORMAT {
        return Ok(SessionMeta {
            format: header.format,
            id: id.to_string(),
            workspace_id: workspace.id.clone(),
            project_key: expected_project_key,
            root_handle: folder.root_handle.clone(),
            root: folder.root.clone(),
            cwd_path: String::new(),
            agent_id: String::new(),
            title: header.title,
            model_id: None,
            mode_id: None,
            effort_id: None,
            created_at_ms: header.created_at_ms,
            updated_at_ms: header.updated_at_ms,
            archived: false,
            pending_permission: None,
            pending_permission_at_ms: None,
            persist: None,
            lineage: None,
            imported: None,
            context_seed: None,
        });
    }
    let mut meta: SessionMeta = serde_json::from_slice(&bytes)
        .map_err(|error| internal(format!("parsing session {id} meta: {error}")))?;
    if meta.id != id {
        return Err(conflict(format!(
            "session directory {id} contains metadata for {}",
            meta.id
        )));
    }
    meta.format = header.format;
    meta.workspace_id = workspace.id.clone();
    meta.project_key = expected_project_key;
    meta.root_handle = folder.root_handle.clone();
    let cwd_path = if meta.cwd_path.is_empty() && meta.root.is_empty() {
        String::new()
    } else if meta.cwd_path.is_empty() {
        relative_native_path(&folder.root, &meta.root).ok_or_else(|| {
            conflict(format!(
                "session {id} working directory is outside its registered workspace root"
            ))
        })?
    } else {
        meta.cwd_path.clone()
    };
    // `cwd` is a native projection for third-party Agent protocols, never a
    // durable identity. Rebase it onto the root registered by this process so
    // another channel (or a moved folder) does not reuse the writer's path.
    meta.root = native_child_path(&folder.root, &cwd_path);
    meta.cwd_path = cwd_path;
    Ok(meta)
}

fn load_seed(
    meta: &SessionMeta,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<ContextSeed>, ProtocolError> {
    let mut client = Client::new(executor, next);
    let bytes = match client.call_raw(CapabilityRequest::File(FileRequest::Read {
        locator: locator(meta, &format!(".genethub/sessions/{}/seed.json", meta.id)),
        max_bytes: META_BYTES,
    }))? {
        Ok(CapabilityValue::Bytes(bytes)) => bytes,
        Err(error) if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound => {
            return Ok(None)
        }
        Err(error) => return Err(capability_error(error)),
        Ok(_) => return Err(internal("session seed read returned the wrong value")),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| internal(format!("parsing session {} seed: {error}", meta.id)))
}

fn save_seed(
    meta: &SessionMeta,
    seed: &ContextSeed,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let bytes = serde_json::to_vec_pretty(seed)
        .map_err(|error| internal(format!("encoding session {} seed: {error}", meta.id)))?;
    if bytes.len() > META_BYTES as usize {
        return Err(internal("session context seed exceeds its durable limit"));
    }
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(meta, &format!(".genethub/sessions/{}/seed.json", meta.id)),
        bytes,
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("session seed write returned the wrong value")),
    }
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

fn monotonic_now(
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<u64, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Clock)? {
        CapabilityValue::Clock {
            monotonic_millis, ..
        } => Ok(monotonic_millis),
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

#[cfg(test)]
mod catalog_contract_tests {
    use super::*;
    use genehub_proto::{ModeInfo, ModelInfo};

    fn catalog() -> Catalog {
        Catalog {
            models: vec![ModelInfo {
                id: "sonnet".to_string(),
                label: "Sonnet".to_string(),
                context_window: None,
                reasoning: true,
                efforts: vec!["low".to_string(), "high".to_string()],
            }],
            modes: vec![
                ModeInfo {
                    id: "manual".to_string(),
                    label: "Default".to_string(),
                    description: None,
                },
                ModeInfo {
                    id: "bypassPermissions".to_string(),
                    label: "Bypass permissions".to_string(),
                    description: None,
                },
            ],
            default_model: Some("sonnet".to_string()),
            default_mode: Some("bypassPermissions".to_string()),
            default_effort: Some("high".to_string()),
            ..Catalog::default()
        }
    }

    fn meta(model: &str, mode: &str, effort: &str) -> SessionMeta {
        SessionMeta {
            format: SESSION_FORMAT,
            id: "s_test".to_string(),
            workspace_id: "w_test".to_string(),
            project_key: "project".to_string(),
            root_handle: "root".to_string(),
            root: "/workspace".to_string(),
            cwd_path: String::new(),
            agent_id: "claude".to_string(),
            title: None,
            model_id: Some(model.to_string()),
            mode_id: Some(mode.to_string()),
            effort_id: Some(effort.to_string()),
            created_at_ms: 1,
            updated_at_ms: 1,
            archived: false,
            pending_permission: None,
            pending_permission_at_ms: None,
            persist: None,
            lineage: None,
            imported: None,
            context_seed: None,
        }
    }

    #[test]
    fn legacy_session_cwds_recover_a_locator_on_unix_and_windows() {
        assert_eq!(
            relative_native_path("/work/project", "/work/project/services/api"),
            Some("services/api".to_string())
        );
        assert_eq!(
            relative_native_path(r"C:\work\project", r"C:\work\project\services\api"),
            Some("services/api".to_string())
        );
        assert_eq!(
            relative_native_path("/work/project/", "/work/project/"),
            Some(String::new())
        );
        assert_eq!(
            relative_native_path("/work/project", "/work/project-other"),
            None
        );
    }

    #[test]
    fn claude_legacy_default_maps_to_the_mode_this_cli_actually_listed() {
        let catalog = catalog();
        assert_eq!(claude_mode("default", &catalog).as_deref(), Some("manual"));
        assert_eq!(claude_mode("manual", &catalog).as_deref(), Some("manual"));
        assert_eq!(claude_mode("plan", &catalog), None);

        let normalized = validate_control(
            "claude",
            Some(&catalog),
            Control::Mode("default".to_string()),
        )
        .unwrap();
        assert!(matches!(normalized, Control::Mode(mode) if mode == "manual"));
    }

    #[test]
    fn controls_refuse_values_the_installed_agent_did_not_offer() {
        let catalog = catalog();
        let model = validate_control("claude", Some(&catalog), Control::Model("opus".to_string()))
            .unwrap_err();
        assert_eq!(model.code, ErrorCode::BadRequest);
        assert!(model.message.contains("sonnet"));

        let effort = validate_control(
            "codex",
            Some(&catalog),
            Control::Effort("extreme".to_string()),
        )
        .unwrap_err();
        assert_eq!(effort.code, ErrorCode::BadRequest);
        assert!(effort.message.contains("low, high"));
    }

    #[test]
    fn launch_filters_stale_values_and_uses_catalog_defaults() {
        let catalog = catalog();
        let meta = meta("removed-model", "default", "extreme");

        let claude = launch_choices(&AgentKind::Claude, &meta, &catalog);
        assert_eq!(claude.model, None);
        assert_eq!(claude.mode.as_deref(), Some("manual"));
        assert_eq!(claude.effort, None);

        let codex = launch_choices(&AgentKind::Codex, &meta, &catalog);
        assert_eq!(codex.model.as_deref(), Some("sonnet"));
        assert_eq!(codex.mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(codex.effort.as_deref(), Some("high"));
    }
}

#[cfg(test)]
mod process_ownership_tests {
    use super::*;

    fn row(
        pid: u32,
        parent_pid: u32,
        group_id: u32,
        running_for_seconds: u64,
        command: &str,
    ) -> ProcessCensusRow {
        ProcessCensusRow {
            pid,
            parent_pid,
            group_id,
            running_for_seconds,
            command: command.to_string(),
        }
    }

    #[test]
    fn process_ownership_combines_group_and_descendant_rules_without_claiming_the_agent() {
        let census = vec![
            row(100, 1, 100, 60, "agent"),
            row(140, 1, 100, 50, "orphan in group"),
            row(150, 100, 150, 40, "detached child"),
            row(151, 150, 150, 30, "detached grandchild"),
            row(240, 200, 200, 20, "another session"),
        ];
        let claimed = claimed_processes(&census, 100, 55)
            .into_iter()
            .map(|row| row.pid)
            .collect::<Vec<_>>();
        assert_eq!(claimed, [140, 150, 151]);
    }

    #[test]
    fn reused_or_dead_agent_pid_cannot_claim_a_strangers_processes() {
        let reused = vec![
            row(100, 1, 100, 30, "unrelated editor"),
            row(140, 100, 100, 25, "not ours"),
        ];
        assert!(claimed_processes(&reused, 100, 3_600).is_empty());
        assert!(claimed_processes(
            &[row(140, 1, 100, 3_700, "orphan after agent exit")],
            100,
            0
        )
        .is_empty());
    }
}

#[cfg(test)]
mod interaction_contract_tests {
    use super::*;
    use genehub_proto::{
        InteractionAnswer, InteractionOption, InteractionQuestion, PermissionOption,
    };

    fn request(kind: PermissionRequestKind) -> PermissionRequest {
        PermissionRequest {
            id: "interaction-1".to_string(),
            kind,
            title: "Continue?".to_string(),
            detail: None,
            tool_call_id: None,
            options: vec![
                PermissionOption {
                    id: "yes".to_string(),
                    label: "Yes".to_string(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOption {
                    id: "no".to_string(),
                    label: "No".to_string(),
                    kind: PermissionOptionKind::Reject,
                },
            ],
            questions: None,
        }
    }

    #[test]
    fn permission_and_plan_outcomes_choose_the_correct_resume_authority() {
        let allowed = continuation_for(
            &request(PermissionRequestKind::Permission),
            &PermissionOutcome::Selected {
                option_id: "yes".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        assert!(allowed.elevated);
        assert!(allowed.prompt.contains("approved"));
        assert!(continuation_for(
            &request(PermissionRequestKind::Permission),
            &PermissionOutcome::Selected {
                option_id: "no".to_string(),
            },
        )
        .unwrap()
        .is_none());

        let plan = continuation_for(
            &request(PermissionRequestKind::PlanApproval),
            &PermissionOutcome::Selected {
                option_id: "yes".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        assert!(!plan.elevated);
        assert_eq!(
            continuation_for(
                &request(PermissionRequestKind::Permission),
                &PermissionOutcome::Selected {
                    option_id: "missing".to_string(),
                },
            )
            .unwrap_err()
            .code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn structured_question_answers_are_complete_and_unambiguous() {
        let mut question = request(PermissionRequestKind::Question);
        question.options.clear();
        question.questions = Some(vec![InteractionQuestion {
            id: "target".to_string(),
            prompt: "Which target?".to_string(),
            allow_multiple: false,
            allow_freeform: false,
            options: vec![
                InteractionOption {
                    id: "a".to_string(),
                    label: "Alpha".to_string(),
                },
                InteractionOption {
                    id: "b".to_string(),
                    label: "Beta".to_string(),
                },
            ],
        }]);
        let answer = |selected_option_ids: Vec<&str>, freeform_text: Option<&str>| {
            PermissionOutcome::Answered {
                answers: vec![InteractionAnswer {
                    question_id: "target".to_string(),
                    selected_option_ids: selected_option_ids
                        .into_iter()
                        .map(str::to_string)
                        .collect(),
                    freeform_text: freeform_text.map(str::to_string),
                }],
            }
        };
        let valid = continuation_for(&question, &answer(vec!["a"], None))
            .unwrap()
            .unwrap();
        assert!(!valid.elevated);
        assert!(valid.prompt.contains("Which target?: Alpha"));

        for invalid in [
            PermissionOutcome::Answered { answers: vec![] },
            answer(vec!["a", "b"], None),
            answer(vec!["missing"], None),
            answer(vec![], Some("custom")),
            PermissionOutcome::Answered {
                answers: vec![InteractionAnswer {
                    question_id: "unknown".to_string(),
                    selected_option_ids: vec!["a".to_string()],
                    freeform_text: None,
                }],
            },
        ] {
            assert_eq!(
                continuation_for(&question, &invalid).unwrap_err().code,
                ErrorCode::BadRequest
            );
        }
    }
}
