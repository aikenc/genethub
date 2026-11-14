//! Session persistence: one self-contained directory per session, laid out so
//! that a path locates a file and a reference locates a byte range — never a
//! scan (`docs/session-storage.md`).
//!
//! Sessions live in the workspace they are about, not in the daemon's data
//! directory:
//!
//! ```text
//! <workspace>/.genethub/sessions/<session>/meta.json
//! <workspace>/.genethub/sessions/<session>/seed.json                 pending reconstructed context
//! <workspace>/.genethub/sessions/<session>/chat.jsonl                 narrative + one row per round
//! <workspace>/.genethub/sessions/<session>/rounds/r-000/index.jsonl   one row per trunk
//! <workspace>/.genethub/sessions/<session>/rounds/r-000/t-0000.jsonl  one trunk's batches and blob rows
//! <workspace>/.genethub/sessions/<session>/blobs/b-9f.jsonl           blob payloads, bucketed by content id
//! <workspace>/.genethub/sessions/<session>/state/                     adapter scratch
//! <workspace>/.genethub/sessions/<session>/artifacts/<time>-<hash>/   browser runtime evidence
//! ```
//!
//! Deltas are never written. Only settled items reach disk, which keeps a
//! session proportional to what was actually said rather than to the number of
//! tokens streamed (`docs/daemon.md` §4).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result, anyhow};
use genehub_proto::{
    BlobKind, BlobOverview, BlobPayload, BlobRef, HistoryCoverage, ImageThumb, ImportContinuation,
    PermissionRequest, RoundBatch, RoundBatchSummary, RoundTrunk, RoundTrunkSummary,
    SessionImportOrigin, SessionLineage, SessionStatus, SessionSummary, TimelineItem,
    UnsupportedFormat,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::rounds::{self, RoundRecord};
use crate::adapter::PersistHandle;

#[derive(Debug)]
pub struct SessionWriteContended {
    holder: String,
}

impl std::fmt::Display for SessionWriteContended {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} is writing this session; you can still read it or Fork from a completed turn",
            self.holder
        )
    }
}

impl std::error::Error for SessionWriteContended {}

#[derive(Debug)]
pub struct SessionDeleted;

impl std::fmt::Display for SessionDeleted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("this session was deleted")
    }
}

impl std::error::Error for SessionDeleted {}

/// Content ids are the first 24 hex characters of a SHA-256. 96 bits keeps
/// collisions negligible at any session size, and every trunk row carries one.
const BLOB_ID_CHARS: usize = 24;
/// Refuses a locator that would have the daemon allocate an absurd buffer for
/// a client-supplied length. No single settled item legitimately reaches this.
const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;

/// The shape this build writes a session in.
///
/// Sessions live in the user's project, so a beta, a release and a dev build
/// all read and write the same directories. That only stays safe if a build can
/// tell, before touching anything, whether the session in front of it was
/// written by something it does not understand.
///
/// Bump this only when an older build reading the result would be *wrong*, not
/// merely incomplete. Adding a field does not qualify: serde ignores what it
/// does not know, so an older build keeps working and a bump would lock it out
/// for nothing. Every bump is one-way for every session the new build writes
/// to, which is exactly the weight it should carry.
///
/// 4 — the path-as-index layout: `chat.jsonl`, `rounds/`, `blobs/`.
/// 5 — fork lineage plus a separately persisted reconstructed context seed.
///     An older build would silently send without that seed, so this addition
///     is correctness-breaking rather than merely metadata it can ignore.
/// 6 — imported origin and continuation mode. An older build would allow a
///     read-only imported transcript to send into a blank Agent context.
/// 7 — managed parent and human-interaction policy. An older build would let a
///     human write into a Workflow-owned child Session.
/// 8 — durable Human decision delivery. Older builds would discard an
///     acknowledged continuation when rewriting metadata.
/// 9 — durable input, execution fences and cleanup receipts. Older writers
///     would discard acknowledged messages or unfinished cancellation.
// 10 — explicit history-only continuation; older writers must not resume it.
pub const SESSION_FORMAT: u32 = 10;

/// What a `meta.json` from before versioning is: the layout numbered 4, which
/// is the only one that has ever been written into a workspace.
fn format_before_versions() -> u32 {
    4
}

/// The part of a `meta.json` whose shape can never change.
///
/// Read on its own, ahead of the rest, because a version a build can only
/// discover by successfully parsing the whole file is no version check at all —
/// the case it exists for is precisely the one where the rest of the file has
/// changed. It carries only what is needed to say "this conversation is here,
/// and I cannot open it": the version that decides that, plus enough to name
/// the row so the user can see what they are being kept out of.
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

/// Durable Human decision and delivery intent. Completion is acknowledged only
/// when its adapter turn terminates; a lost process may therefore redeliver it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanContinuation {
    pub request: PermissionRequest,
    pub outcome: genehub_proto::PermissionOutcome,
    pub decided_at_ms: i64,
    /// Older decisions did not retain the responder. Never backfill them as
    /// verified user decisions when replaying an interrupted continuation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responder: Option<genehub_proto::InteractionResponder>,
    #[serde(default)]
    pub grant_recorded: bool,
    #[serde(default)]
    pub completed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionActivity {
    pub last_at_ms: i64,
    pub llm_rounds: u64,
    pub tokens: Option<u64>,
    pub turn_id: Option<String>,
    pub turn_rounds: u64,
    pub turn_tokens: u64,
}

/// Control records reference the one original UserMessage in chat.jsonl.
/// `receiving` reserves delivery responsibility before appending that body.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInbox {
    #[serde(default)]
    pub entries: Vec<InboxEntry>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub has_delivered: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub message_id: String,
    #[serde(default)]
    pub received_at_ms: i64,
    /// First acknowledged handoff to the native Agent, never queue admission.
    /// Older receipts keep this unknown; a retry does not rewrite history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at_ms: Option<i64>,
    pub digest: String,
    pub source: String,
    pub task_run_id: Option<String>,
    /// receiving / queued / sent / handled; errors pause automatic processing.
    pub state: String,
    pub turn_id: Option<String>,
}

/// A turn that started and has not ended yet.
///
/// Written the moment a turn starts and cleared when it ends, so that a turn
/// which never answered leaves a durable trace instead of an absence:
/// `chat.jsonl` and the round trunks only keep turns that produced something,
/// which is exactly what a stuck turn does not do. `first_event_at_ms` is
/// absent while the agent has not said anything at all about this turn — the
/// one fact that separates a silent CLI from an answer that never arrived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTurnMarker {
    pub turn_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub started_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_event_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    #[serde(default)]
    pub activity: ExecutionActivity,
    #[serde(default)]
    pub execution_retired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_cleanup: Option<crate::processes::CleanupReceipt>,
    #[serde(default)]
    pub inbox: SessionInbox,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_preview: Option<genehub_proto::SessionMessagePreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_reply: Option<genehub_proto::SessionReplyCursor>,
    /// The turn this conversation is still owed an ending for; see
    /// [`OpenTurnMarker`]. Absent whenever no turn is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_turn: Option<OpenTurnMarker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drafts: Vec<genehub_proto::SessionDraft>,
    pub id: String,
    /// Which workspace this conversation belongs to.
    ///
    /// Resolved from the durable project key stored on disk. The local id is
    /// deliberately never persisted because another installation names the
    /// same project differently.
    #[serde(default, skip)]
    pub workspace_id: String,
    /// The layout this session is stored in, taken from the file's frozen
    /// header rather than from this field, and always written as this build's
    /// [`SESSION_FORMAT`] — see [`Store::save_meta`].
    #[serde(default = "format_before_versions", skip_deserializing)]
    pub format: u32,
    pub agent_id: String,
    /// Whether ordinary sends should resolve this conversation through the
    /// machine-global tag router. Concrete `session.create` conversations keep
    /// their explicit Agent/model, even when they contain media.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tag_routing: bool,
    /// Human-selected routing tags. Concrete Agent/model identity is derived
    /// afresh from these tags before every ordinary dispatch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routing_tags: Vec<String>,
    /// Daemon-owned requirements accumulated from image/video attachments in
    /// this conversation. Kept separate so a client cannot deselect history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media_tags: Vec<String>,
    /// `None` until it has been named. Metas written before this was optional
    /// read back as `Some`, which is the right answer for them.
    #[serde(default)]
    pub title: Option<String>,
    /// A name the user typed. First-prompt and Agent titles stay unlocked so
    /// a later Agent extraction can replace the provisional sidebar label.
    /// Metas written before this existed read back as unlocked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub title_locked: bool,
    /// See [`apply_session_labels`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    /// See [`normalize_session_description`]. Metas written before this
    /// existed read back as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub cwd: PathBuf,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    /// Metas written before this existed read back as `None`, which is the right
    /// answer for them: no level was ever chosen.
    #[serde(default)]
    pub effort_id: Option<String>,
    #[serde(default)]
    pub fast: Option<bool>,
    /// Agent-declared runtime axes. Unknown keys survive storage for history,
    /// but are filtered against the live catalog before an Agent starts.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub runtime_values: std::collections::BTreeMap<String, String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub persist: Option<PersistHandle>,
    /// Last observed agent process. Used after a daemon restart to refuse
    /// continuing a Worker whose previous process is still writing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_pid: Option<u32>,
    /// A stopped interaction waiting for a user who may return much later.
    /// Stored in meta so no live socket or Agent process is required.
    #[serde(default)]
    pub pending_permission: Option<PermissionRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_continuation: Option<HumanContinuation>,
    /// The Agent this session runs remains `agent_id`; lineage only describes
    /// where inherited history came from and how it reached this Agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<SessionLineage>,
    /// Retired execution context is history, never a source of queued work.
    #[serde(default)]
    pub history_only: bool,
    /// Provider source identity stays private to the daemon. It is also the
    /// durable duplicate key, while the public summary exposes only the Agent
    /// and whether native continuation survived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported: Option<ImportedSessionMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSessionMeta {
    pub source_key: String,
    pub agent_id: String,
    pub continuation: ImportContinuation,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<HistoryCoverage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextSeedState {
    Pending,
    /// Persisted before handing the first combined prompt to the Agent. A
    /// daemon restart in this state must not blindly send it a second time.
    Applying,
    Applied,
}

/// The potentially large reconstructed prompt lives outside `meta.json`, so a
/// session list never has to parse every inherited conversation body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSeed {
    pub state: ContextSeedState,
    pub text: String,
    /// Present for an in-place Agent migration. A staged seed only becomes
    /// active after metadata names this exact destination; this makes a crash
    /// between the two atomic file writes fail closed instead of replaying
    /// history into the old Agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_model_id: Option<String>,
}

pub(super) fn interaction_summary<'a>(
    requests: impl IntoIterator<Item = &'a PermissionRequest>,
) -> genehub_proto::SessionInteractionSummary {
    let mut summary = genehub_proto::SessionInteractionSummary::default();
    for request in requests {
        summary.count = summary.count.saturating_add(1);
        if summary.requests.len() < 16 {
            summary.requests.push(genehub_proto::SessionInteractionRef {
                request_id: request.id.clone(),
                kind: request.kind,
                title: request.title.chars().take(160).collect(),
            });
        }
    }
    summary
}

impl SessionMeta {
    /// A session written by a build from the future, described from its
    /// location and its file's frozen header alone.
    ///
    /// Nothing else in the file is trusted, because by definition this build
    /// does not know what the rest of it means.
    fn unopenable(id: String, workspace_id: String, cwd: PathBuf, header: MetaHeader) -> Self {
        SessionMeta {
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            open_turn: None,
            drafts: vec![],
            id,
            workspace_id,
            format: header.format,
            agent_id: String::new(),
            tag_routing: false,
            routing_tags: Vec::new(),
            media_tags: Vec::new(),
            title: header.title,
            title_locked: false,
            labels: Vec::new(),
            description: None,
            cwd,
            model_id: None,
            mode_id: None,
            effort_id: None,
            fast: None,
            runtime_values: Default::default(),
            created_at_ms: header.created_at_ms,
            updated_at_ms: header.updated_at_ms,
            archived: false,
            persist: None,
            agent_pid: None,
            pending_permission: None,
            human_continuation: None,
            lineage: None,
            history_only: false,
            imported: None,
        }
    }

    /// Whether this build understands the session's layout well enough to read
    /// it, let alone add to it.
    pub fn openable(&self) -> bool {
        self.format <= SESSION_FORMAT
    }

    pub fn derived_source_kind(&self) -> Option<String> {
        Some(derived_source_kind_for(&self.labels).to_string())
    }

    pub fn summary(&self, status: SessionStatus) -> SessionSummary {
        self.summary_with_activity(status, None)
    }

    /// The same, plus when the running turn last produced anything.
    ///
    /// Only a live session can answer that, so it is passed in rather than read
    /// from disk: metadata records when the session was last written, which is
    /// a different question and a misleading answer to this one.
    pub fn summary_with_activity(
        &self,
        status: SessionStatus,
        last_activity_at_ms: Option<i64>,
    ) -> SessionSummary {
        SessionSummary {
            coordination: None,
            cwd: Some(crate::file_access::display(&self.cwd)),
            interaction_summary: self
                .openable()
                .then(|| interaction_summary(self.pending_permission.iter())),
            latest_reply: self.latest_reply.clone(),
            // A pause is state a script needs to see even when nothing is queued: an
            // interrupted session otherwise looks exactly like one that finished.
            input_summary: (!self.inbox.entries.is_empty() || self.inbox.paused).then(|| {
                genehub_proto::SessionInputSummary {
                    pending_message_ids: self
                        .inbox
                        .entries
                        .iter()
                        .filter(|entry| entry.state != "handled")
                        .map(|entry| entry.message_id.clone())
                        .collect(),
                    paused: self.inbox.paused,
                    error: self.inbox.error.clone(),
                }
            }),
            message_preview: self.message_preview.clone(),
            draft_count: (!self.drafts.is_empty()).then_some(self.drafts.len() as u32),
            last_activity_at_ms,
            id: self.id.clone(),
            workspace_id: self.workspace_id.clone(),
            agent_id: self.agent_id.clone(),
            routing_tags: self.routing_tags.clone(),
            media_tags: self.media_tags.clone(),
            history_only: self.history_only.then_some(true),
            title: self.title.clone(),
            labels: self.labels.clone(),
            description: self.description.clone(),
            status,
            model_id: self.model_id.clone(),
            mode_id: self.mode_id.clone(),
            effort_id: self.effort_id.clone(),
            fast: self.fast,
            runtime_values: (!self.runtime_values.is_empty()).then(|| self.runtime_values.clone()),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            archived: self.archived,
            unsupported: (!self.openable()).then_some(UnsupportedFormat {
                written: self.format,
                supported: SESSION_FORMAT,
            }),
            lineage: self.lineage.clone(),
            imported: self.imported.as_ref().map(|imported| SessionImportOrigin {
                agent_id: imported.agent_id.clone(),
                continuation: imported.continuation,
                warnings: imported.warnings.clone(),
                coverage: imported.coverage.clone(),
            }),
        }
    }
}

pub fn derived_source_kind_for(labels: &[String]) -> &'static str {
    // Labels are display text. Only the generic platform-created marker and
    // labels distinguish automated sessions, never business roles.
    if labels.iter().any(|label| label == SESSION_STARTED_LABEL) {
        "system"
    } else {
        "human"
    }
}

/// Everything `chat.jsonl` holds, already folded.
#[derive(Debug, Clone, Default)]
pub struct ChatLog {
    /// Session narrative, in order. Never contains tool calls or reasoning.
    pub items: Vec<TimelineItem>,
    /// One entry per round, in order, last write per `roundId` winning.
    pub rounds: Vec<RoundRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
#[allow(clippy::large_enum_variant)]
enum ChatRow {
    Item { item: TimelineItem },
    Round { round: RoundRecord },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum TrunkRow {
    #[serde(rename_all = "camelCase")]
    Batch {
        index: u32,
        first_item_id: String,
        blob_count: u32,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        round_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monologue: Option<String>,
        /// Compaction reason when the batch is a context-compaction marker.
        /// Rows written before this field existed read as `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marker: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        llm_rounds: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_duration_ms: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Blob {
        item_id: String,
        kind: BlobKind,
        overview: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob: Option<BlobRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thumb: Option<ImageThumb>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_kind: Option<genehub_proto::ToolKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<genehub_proto::ToolStatus>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRecord {
    id: String,
    value: Value,
}

/// The directory a workspace keeps its sessions in.
pub fn sessions_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(HOME_DIR_NAME).join("sessions")
}

/// The per-workspace directory GeneHub owns inside the user's own project.
const HOME_DIR_NAME: &str = ".genethub";
const TOMBSTONES_DIR: &str = "tombstones";

/// Compatibility gate for builds that still take one exclusive workspace
/// lock. Current builds hold it shared, so they can coexist with each other
/// but never double-write alongside an older daemon.
const LEGACY_OWNER_LOCK: &str = "owner.lock";
const LEGACY_OWNER_NAME: &str = "owner";

/// The file whose kernel lock decides which build may write one session.
///
/// Kept empty. A Windows exclusive lock blocks reads as well as writes, so
/// anything stored here would be unreadable by precisely the process that
/// needs it: the one that just lost the lock.
const WRITER_LOCK: &str = "writer.lock";

/// Who holds [`WRITER_LOCK`], in plain text, so the build that loses can name
/// the one to close instead of saying "something else". Diagnostics only —
/// the kernel lock decides, and this file is merely the label on it.
const WRITER_NAME: &str = "writer";

/// Own both halves of a WASI lock: dropping File alone leaves the Host's
/// path-addressed handle alive. Release on every owner removal and final drop.
struct SessionLock {
    file: File,
    path: PathBuf,
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        if let Err(error) = crate::fs_lock::unlock(&self.file, &self.path) {
            tracing::warn!(%error, "could not release session home lock");
        }
    }
}

/// A registered workspace: where it is, and whether this daemon may write it.
struct Home {
    /// Shared compatibility lock excluding older workspace-locking builds.
    compatibility: Option<SessionLock>,
    /// One write lock per session. Different channels may write different
    /// conversations in the same workspace at the same time.
    writers: BTreeMap<String, SessionLock>,
}

#[derive(Default)]
struct Homes {
    /// Project id to physical Agent/session root.
    workspaces: BTreeMap<String, WorkspaceHome>,
    /// One entry per physical `.genethub`, shared by every project view rooted
    /// there. A folder and a `.code-workspace` file in that same folder share
    /// one project key so they never split one directory's history.
    roots: BTreeMap<PathBuf, Home>,
}

#[derive(Clone)]
struct WorkspaceHome {
    root: PathBuf,
    /// Stable within this physical session home and independent of the local
    /// workspace id, so another GeneHub installation can adopt the history.
    project_key: String,
    /// Older keys that still name this project. A `.code-workspace` file used
    /// to hash the file path; the directory is the identity now, but those
    /// conversations stay visible.
    aliases: Vec<String>,
}

/// Which directory on disk belongs to each workspace id.
///
/// A conversation is about a body of code, so it is kept with that code rather
/// than in the daemon's data directory: copying a project copies its history,
/// deleting one deletes it, and an uninstall does not take it away. Only the
/// workspace registry knows where a workspace lives, so the store is told, and
/// a session whose workspace is no longer registered is not locatable at all —
/// which is the honest answer, not a path in some fallback directory.
#[derive(Clone, Default)]
pub struct WorkspaceHomes {
    homes: Arc<RwLock<Homes>>,
    revision: Arc<std::sync::atomic::AtomicU64>,
}

impl WorkspaceHomes {
    pub fn attach(&self, workspace_id: &str, root: &Path) {
        self.attach_project(workspace_id, "folder", root);
    }

    pub fn attach_project(&self, workspace_id: &str, project_key: &str, root: &Path) {
        self.attach_project_aliased(workspace_id, project_key, &[], root);
    }

    pub fn attach_project_aliased(
        &self,
        workspace_id: &str,
        project_key: &str,
        aliases: &[String],
        root: &Path,
    ) {
        let Ok(mut homes) = self.homes.write() else {
            return;
        };
        if homes.workspaces.get(workspace_id).is_some_and(|known| {
            known.root == root && known.project_key == project_key && known.aliases == aliases
        }) {
            return;
        }
        if let Some(previous) = homes.workspaces.insert(
            workspace_id.to_string(),
            WorkspaceHome {
                root: root.to_path_buf(),
                project_key: project_key.to_string(),
                aliases: aliases.to_vec(),
            },
        ) {
            prune_home(&mut homes, &previous.root);
        }
        homes.roots.entry(root.to_path_buf()).or_default();
        self.revision
            .fetch_add(1, std::sync::atomic::Ordering::Release);
    }

    /// Stops exposing one workspace's history without deleting any of it.
    /// Reattaching the same id and root makes every session visible again.
    pub fn detach(&self, workspace_id: &str) {
        if let Ok(mut homes) = self.homes.write() {
            if let Some(home) = homes.workspaces.remove(workspace_id) {
                prune_home(&mut homes, &home.root);
                self.revision
                    .fetch_add(1, std::sync::atomic::Ordering::Release);
            }
        }
    }

    /// Where a workspace lives on disk.
    pub fn root(&self, workspace_id: &str) -> Result<PathBuf> {
        let homes = self
            .homes
            .read()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        homes
            .workspaces
            .get(workspace_id)
            .map(|home| home.root.clone())
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))
    }

    fn project_key(&self, workspace_id: &str) -> Result<String> {
        let homes = self
            .homes
            .read()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        homes
            .workspaces
            .get(workspace_id)
            .map(|home| home.project_key.clone())
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))
    }

    fn claims_project_key(&self, workspace_id: &str, project_key: &str) -> Result<bool> {
        let homes = self
            .homes
            .read()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        Ok(homes.workspaces.get(workspace_id).is_some_and(|home| {
            home.project_key == project_key || home.aliases.iter().any(|alias| alias == project_key)
        }))
    }

    fn home_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        Ok(self.root(workspace_id)?.join(HOME_DIR_NAME))
    }

    fn sessions_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        Ok(self.home_dir(workspace_id)?.join("sessions"))
    }

    /// Every physical session directory once, plus the active projects allowed
    /// to see sessions stored there.
    fn all_sessions_dirs(&self) -> Vec<(Vec<(String, WorkspaceHome)>, PathBuf)> {
        self.session_dirs_for(None)
    }

    fn session_dirs_for(
        &self,
        workspace: Option<&str>,
    ) -> Vec<(Vec<(String, WorkspaceHome)>, PathBuf)> {
        let Ok(homes) = self.homes.read() else {
            return Vec::new();
        };
        homes
            .roots
            .keys()
            .filter(|root| {
                workspace.is_none_or(|id| {
                    homes
                        .workspaces
                        .get(id)
                        .is_some_and(|home| &home.root == *root)
                })
            })
            .map(|root| {
                let projects = homes
                    .workspaces
                    .iter()
                    .filter(|(_, candidate)| &candidate.root == root)
                    .map(|(id, home)| (id.clone(), home.clone()))
                    .collect();
                (projects, sessions_dir(root))
            })
            .collect()
    }

    /// Whether this daemon already owns this session's write lock.
    fn holds(&self, workspace_id: &str, session_id: &str) -> bool {
        self.homes.read().is_ok_and(|homes| {
            homes
                .workspaces
                .get(workspace_id)
                .and_then(|workspace| homes.roots.get(&workspace.root))
                .is_some_and(|home| home.writers.contains_key(session_id))
        })
    }

    fn claim_compatibility(&self, workspace_id: &str, home_dir: &Path) -> Result<()> {
        let mut homes = self
            .homes
            .write()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        let root = homes
            .workspaces
            .get(workspace_id)
            .map(|home| home.root.clone())
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))?;
        let home = homes
            .roots
            .get_mut(&root)
            .ok_or_else(|| anyhow!("workspace {workspace_id} has no session home"))?;
        if home.compatibility.is_some() {
            return Ok(());
        }
        let path = home_dir.join(LEGACY_OWNER_LOCK);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        match crate::fs_lock::try_lock_shared(&file, &path) {
            Ok(()) => {}
            Err(error) if crate::lifecycle::lock_contended(&error) => {
                let holder = fs::read_to_string(home_dir.join(LEGACY_OWNER_NAME))
                    .ok()
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "an older GeneHub".to_string());
                tracing::warn!(
                    event = "legacy_workspace_writer_contended",
                    workspace = %workspace_id,
                    %holder,
                    "an older GeneHub is holding the workspace-wide session lock"
                );
                return Err(anyhow!(
                    "{holder} uses the older workspace-wide session lock; close or upgrade it before writing here"
                ));
            }
            Err(error) => return Err(error).with_context(|| format!("locking {}", path.display())),
        }
        home.compatibility = Some(SessionLock { file, path });
        Ok(())
    }

    /// Takes one session's write lock, or names who is holding it.
    ///
    /// Sessions live in the project, so a beta and a release pointed at the
    /// same folder are two processes over one set of files. Both may write
    /// different sessions; only one may write a particular session, and the
    /// one that loses says so instead of interleaving `chat.jsonl` rows.
    ///
    /// Claimed on the first write rather than when the workspace is
    /// registered, because merely opening a folder must not leave a
    /// `.genethub` behind in it. Re-attempted while unheld, so the loser
    /// starts working the moment the other build quits — no restart, no
    /// stale-lock cleanup, since the kernel drops it even on a crash.
    fn claim(&self, workspace_id: &str, session_id: &str, session_dir: &Path) -> Result<()> {
        let mut homes = self
            .homes
            .write()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        let root = homes
            .workspaces
            .get(workspace_id)
            .map(|home| home.root.clone())
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))?;
        let home = homes
            .roots
            .get_mut(&root)
            .ok_or_else(|| anyhow!("workspace {workspace_id} has no session home"))?;
        if home.writers.contains_key(session_id) {
            return Ok(());
        }
        let path = session_dir.join(WRITER_LOCK);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        match crate::fs_lock::try_lock_exclusive(&file, &path) {
            Ok(()) => {}
            Err(error) if crate::lifecycle::lock_contended(&error) => {
                let holder = fs::read_to_string(session_dir.join(WRITER_NAME))
                    .ok()
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "another GeneHub".to_string());
                tracing::warn!(
                    event = "session_writer_contended",
                    workspace = %workspace_id,
                    session = %session_id,
                    %holder,
                    "another daemon is writing this session"
                );
                return Err(SessionWriteContended { holder }.into());
            }
            Err(error) => return Err(error).with_context(|| format!("locking {}", path.display())),
        }
        let stamp = format!(
            "{} (pid {})\n",
            crate::channel::PRODUCT,
            crate::host_pid::current()
        );
        let _ = fs::write(session_dir.join(WRITER_NAME), stamp);
        home.writers
            .insert(session_id.to_string(), SessionLock { file, path });
        Ok(())
    }

    fn release(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        let mut homes = self
            .homes
            .write()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        let root = homes
            .workspaces
            .get(workspace_id)
            .map(|home| home.root.clone())
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))?;
        if let Some(home) = homes.roots.get_mut(&root) {
            home.writers.remove(session_id);
        }
        Ok(())
    }
}

impl Home {
    fn at() -> Self {
        Home {
            compatibility: None,
            writers: BTreeMap::new(),
        }
    }
}

impl Default for Home {
    fn default() -> Self {
        Self::at()
    }
}

fn prune_home(homes: &mut Homes, root: &Path) {
    if !homes
        .workspaces
        .values()
        .any(|candidate| candidate.root == root)
    {
        homes.roots.remove(root);
    }
}

// One rebuildable metadata table. Scope/order indexes contain references only;
// execution recovery still uses a fresh durable read, independently of this view.
#[derive(Default)]
struct PageCatalog {
    generation: u64,
    write_revision: u64,
    observation_revision: u64,
    homes_revision: u64,
    checked_at: Option<std::time::Instant>,
    initialized: bool,
    files: HashMap<PathBuf, CatalogFile>,
    order: BTreeMap<(i64, String, String), PathBuf>,
    by_id: HashMap<String, Vec<PathBuf>>,
    pending: HashSet<PathBuf>,
    errors: HashMap<PathBuf, (Vec<String>, String)>,
    projection: CatalogProjection,
    /// When each listed session's `meta.json` is next looked at, whether or
    /// not that file exists yet.
    watches: HashMap<PathBuf, crate::fs_stamp::Watch>,
    /// One per physical `sessions/` directory, keyed by that directory.
    homes: HashMap<PathBuf, HomeSweep>,
    /// Serialize observations of one physical directory, including aliases.
    /// Weak entries retain no idle project locks.
    home_sweeps: HashMap<PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>,
    changes: ChangeLog,
}

/// Which sessions changed and in what order, so a caller holding a cursor
/// reads only those instead of listing its scope again.
#[derive(Default)]
struct ChangeLog {
    /// Names this daemon's sequence; a cursor from another one starts over.
    token: String,
    seq: u64,
    last: HashMap<genehub_proto::CatalogSessionRef, u64>,
    removed: std::collections::VecDeque<(u64, genehub_proto::CatalogSessionRef)>,
    /// Removals at or below this were forgotten, so an older cursor starts over.
    floor: u64,
}

/// Removals kept for cursors that have not caught up yet.
const REMOVALS_KEPT: usize = 4096;

impl ChangeLog {
    fn touch(&mut self, session: genehub_proto::CatalogSessionRef) {
        self.seq += 1;
        self.last.insert(session, self.seq);
    }

    fn remove(&mut self, session: genehub_proto::CatalogSessionRef) {
        self.seq += 1;
        self.last.remove(&session);
        self.removed.push_back((self.seq, session));
        while self.removed.len() > REMOVALS_KEPT {
            if let Some((seq, _)) = self.removed.pop_front() {
                self.floor = seq;
            }
        }
    }
}

/// What changed in a set of projects since a cursor.
pub(super) struct CatalogChanges {
    pub changed: Vec<SessionMeta>,
    pub removed: Vec<genehub_proto::CatalogSessionRef>,
    pub token: String,
    pub seq: u64,
    pub complete: bool,
    /// The cursor could not be continued; `changed` is the whole scope.
    pub reset: bool,
}

/// Directory catalogs are swept, not walked: each pass looks only at paths
/// that are due. Hot paths are looked at every pass; every other path at
/// least once per `cold`, which bounds how late a change made by another
/// process appears in an unscoped view. A scoped read validates its own scope.
const CATALOG_SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(2);
const CATALOG_CADENCE: crate::fs_stamp::Cadence = crate::fs_stamp::Cadence {
    hot: CATALOG_SWEEP_EVERY,
    cold: std::time::Duration::from_secs(30),
    hot_for: std::time::Duration::from_secs(600),
};
/// A `sessions/` directory and its tombstones change only when a session is
/// added or removed. One the platform just touched (a project just opened, a
/// session just created there) is likely to gain more from other writers, so
/// it is looked at on every pass for a minute.
const HOME_CADENCE: crate::fs_stamp::Cadence = crate::fs_stamp::Cadence {
    hot: CATALOG_SWEEP_EVERY,
    cold: CATALOG_CADENCE.cold,
    hot_for: std::time::Duration::from_secs(60),
};
const SCOPE_REUSE: std::time::Duration = std::time::Duration::from_secs(2);

type HomeOwners = Vec<(String, String, Vec<String>)>;

fn home_owners(projects: &[(String, WorkspaceHome)]) -> HomeOwners {
    projects
        .iter()
        .map(|(id, home)| (id.clone(), home.project_key.clone(), home.aliases.clone()))
        .collect()
}

/// What the last look at one `sessions/` directory and its `tombstones/`
/// sibling found.
#[derive(Clone)]
struct HomeSeen {
    owners: HomeOwners,
    listing: Option<MetadataStamp>,
    sessions: std::collections::BTreeSet<String>,
    tombstones: Option<MetadataStamp>,
    deleted: std::collections::BTreeSet<String>,
}

struct HomeSweep {
    observation_revision: u64,
    seen: HomeSeen,
    listing: crate::fs_stamp::Watch,
    tombstones: crate::fs_stamp::Watch,
    validated: Option<std::time::Instant>,
}

/// One home's share of a sweep pass, decided under the catalog lock.
struct HomePlan {
    sessions: PathBuf,
    projects: Vec<(String, WorkspaceHome)>,
    /// Never seen, or its owning projects changed: everything is read.
    prior: Option<HomeSeen>,
    list: bool,
    tombstones: bool,
    entries: Vec<(String, Option<MetadataStamp>, bool)>,
}

enum Look {
    Same,
    Changed(CatalogFile),
    /// Listed, but its `meta.json` is not there (yet).
    Missing,
    /// No longer listed.
    Gone,
    Deleted,
}

struct HomeLooked {
    sessions: PathBuf,
    scopes: Vec<String>,
    seen: HomeSeen,
    listing_error: Option<(Vec<String>, String)>,
    /// A deleted session's files are still waiting for their writer.
    reap_pending: bool,
    /// Whether this pass looked at the listing and at the tombstones; a pass
    /// that only looked at some sessions must not postpone either.
    listed: bool,
    tombstones_looked: bool,
    looked: Vec<(PathBuf, Option<MetadataStamp>, Look)>,
}

#[derive(Default)]
struct SweepCounts {
    homes: usize,
    listings: usize,
    stats: usize,
    reads: usize,
}

/// Session ids with a tombstone in `dir`.
fn tombstone_names(dir: &Path) -> std::collections::BTreeSet<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Default::default();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            (!id.is_empty()).then(|| id.to_string())
        })
        .collect()
}

#[derive(Default)]
pub(super) struct CatalogProjection {
    pub revision: u64,
    pub dirty: HashSet<genehub_proto::CatalogSessionRef>,
    pub removed: HashSet<genehub_proto::CatalogSessionRef>,
    pub rows: HashMap<genehub_proto::CatalogSessionRef, (String, bool)>,
    pub workspaces: HashMap<String, String>,
    pub errors: String,
}
type MetadataStamp = crate::fs_stamp::Stamp;
#[derive(Clone)]
struct CatalogFile {
    stamp: Option<MetadataStamp>,
    meta: Option<Arc<SessionMeta>>,
    error: Option<String>,
    changed: u64,
}
#[derive(Default, Clone)]
struct CatalogScan {
    files: HashMap<PathBuf, CatalogFile>,
    errors: HashMap<PathBuf, (Vec<String>, String)>,
    homes: HashMap<PathBuf, HomeSeen>,
}
impl PageCatalog {
    /// This daemon just wrote `meta.json` at `path`: the index already holds
    /// it, so a sweep need not discover it, but it stays hot for a while.
    fn wrote(&mut self, path: &Path) {
        let now = std::time::Instant::now();
        self.watches
            .entry(path.to_path_buf())
            .or_insert_with(|| crate::fs_stamp::Watch::now(now))
            .wrote(now, CATALOG_CADENCE);
        let id = path
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned());
        if let (Some(id), Some(home)) = (
            id,
            path.parent()
                .and_then(Path::parent)
                .and_then(|sessions| self.homes.get_mut(sessions)),
        ) {
            home.seen.sessions.insert(id);
            home.listing.wrote(now, HOME_CADENCE);
        }
    }

    /// Records what one home's share of a sweep found. A write this daemon
    /// made while the sweep was looking wins over what the sweep saw.
    fn apply_home(
        &mut self,
        home: HomeLooked,
        write_revision: u64,
        validated: bool,
        now: std::time::Instant,
    ) {
        use crate::fs_stamp::Watch;
        self.observation_revision = self.observation_revision.wrapping_add(1);
        let observation_revision = self.observation_revision;
        let HomeLooked {
            sessions,
            scopes,
            seen,
            listing_error,
            reap_pending,
            listed,
            tombstones_looked,
            looked,
        } = home;
        let fresh = self
            .homes
            .get(&sessions)
            .is_none_or(|known| known.seen.owners != seen.owners);
        if fresh {
            let listed = &seen.sessions;
            let orphaned: Vec<PathBuf> = self
                .files
                .keys()
                .filter(|path| {
                    path.parent()
                        .and_then(Path::parent)
                        .is_some_and(|dir| dir == sessions)
                        && path
                            .parent()
                            .and_then(Path::file_name)
                            .is_none_or(|id| !listed.contains(&*id.to_string_lossy()))
                })
                .cloned()
                .collect();
            for path in orphaned {
                self.drop_path(&path);
                self.watches.remove(&path);
            }
        }
        // Homes present at startup were spread by the first load; one that
        // appears later belongs to a project just opened, so it starts hot.
        let known = self.homes.contains_key(&sessions);
        let entry = self
            .homes
            .entry(sessions.clone())
            .or_insert_with(|| HomeSweep {
                observation_revision,
                listing: Watch::now(now),
                tombstones: Watch::now(now),
                seen: seen.clone(),
                validated: None,
            });
        // Known and fresh means the owners changed.
        let moved = known && fresh;
        let listing_changed = !known
            || listing_error.is_some()
            || moved
            || entry.seen.listing != seen.listing
            || entry.seen.sessions != seen.sessions;
        let tombstones_changed = !known
            || reap_pending
            || moved
            || entry.seen.tombstones != seen.tombstones
            || entry.seen.deleted != seen.deleted;
        if listed {
            entry
                .listing
                .looked(seen.listing.as_ref(), listing_changed, now, HOME_CADENCE);
        }
        if tombstones_looked {
            entry.tombstones.looked(
                seen.tombstones.as_ref(),
                tombstones_changed,
                now,
                HOME_CADENCE,
            );
        }
        entry.seen = seen;
        entry.observation_revision = observation_revision;
        if validated {
            entry.validated = Some(now);
        }
        match listing_error {
            Some(error) => {
                self.errors.insert(sessions.clone(), error);
            }
            None => {
                self.errors.remove(&sessions);
            }
        }
        for (path, stamp, look) in looked {
            if self
                .files
                .get(&path)
                .is_some_and(|file| file.changed > write_revision)
            {
                continue;
            }
            match look {
                Look::Same => {
                    if let Some(watch) = self.watches.get_mut(&path) {
                        watch.looked(stamp.as_ref(), false, now, CATALOG_CADENCE);
                    }
                }
                Look::Changed(mut file) => {
                    if file.error.is_some() && file.meta.is_none() {
                        file.meta = self.files.get(&path).and_then(|old| old.meta.clone());
                    }
                    let failed = file.error.clone();
                    self.put(path.clone(), file);
                    if let Some(error) = failed {
                        self.errors.insert(path.clone(), (scopes.clone(), error));
                    }
                    // A path seen for the first time is spread like a startup
                    // find; only a known path whose stamp moved stays hot.
                    match self.watches.get_mut(&path) {
                        Some(watch) => watch.looked(stamp.as_ref(), true, now, CATALOG_CADENCE),
                        None => {
                            self.watches.insert(
                                path.clone(),
                                Watch::first(&path, stamp.as_ref(), now, CATALOG_CADENCE),
                            );
                        }
                    }
                }
                Look::Missing => {
                    let had = self.files.contains_key(&path);
                    self.drop_path(&path);
                    match self.watches.get_mut(&path) {
                        Some(watch) => watch.looked(None, had, now, CATALOG_CADENCE),
                        None => {
                            self.watches.insert(
                                path.clone(),
                                Watch::first(&path, None, now, CATALOG_CADENCE),
                            );
                        }
                    }
                }
                Look::Gone | Look::Deleted => {
                    self.drop_path(&path);
                    self.watches.remove(&path);
                }
            }
        }
    }

    /// A `sessions/` directory no project uses any more.
    fn forget_home(&mut self, sessions: &Path) {
        self.homes.remove(sessions);
        let paths: Vec<PathBuf> = self
            .files
            .keys()
            .filter(|path| path.starts_with(sessions))
            .cloned()
            .collect();
        for path in paths {
            self.drop_path(&path);
        }
        self.watches.retain(|path, _| !path.starts_with(sessions));
        self.errors.retain(|path, _| !path.starts_with(sessions));
    }

    /// Takes a path out of every index, reporting the row it held as removed.
    fn drop_path(&mut self, path: &Path) {
        if let Some(old) = self.files.remove(path).and_then(|f| f.meta) {
            let session = genehub_proto::CatalogSessionRef {
                workspace_id: old.workspace_id.clone(),
                id: old.id.clone(),
            };
            self.changes.remove(session.clone());
            self.projection.removed.insert(session);
            self.order
                .remove(&(old.updated_at_ms, old.id.clone(), old.workspace_id.clone()));
            if let Some(paths) = self.by_id.get_mut(&old.id) {
                paths.retain(|p| p != path);
                if paths.is_empty() {
                    self.by_id.remove(&old.id);
                }
            }
        }
        self.pending.remove(path);
        self.errors.remove(path);
    }

    fn put(&mut self, path: PathBuf, file: CatalogFile) {
        if let Some(old) = self.files.get(&path).and_then(|f| f.meta.as_ref()) {
            if file
                .meta
                .as_ref()
                .is_none_or(|next| next.id != old.id || next.workspace_id != old.workspace_id)
            {
                let session = genehub_proto::CatalogSessionRef {
                    workspace_id: old.workspace_id.clone(),
                    id: old.id.clone(),
                };
                self.changes.remove(session.clone());
                self.projection.removed.insert(session);
            }
            self.order
                .remove(&(old.updated_at_ms, old.id.clone(), old.workspace_id.clone()));
            if let Some(paths) = self.by_id.get_mut(&old.id) {
                paths.retain(|p| p != &path);
            }
        }
        self.pending.remove(&path);
        if let Some(meta) = &file.meta {
            let session = genehub_proto::CatalogSessionRef {
                workspace_id: meta.workspace_id.clone(),
                id: meta.id.clone(),
            };
            self.changes.touch(session.clone());
            self.projection.dirty.insert(session);
            self.order.insert(
                (
                    meta.updated_at_ms,
                    meta.id.clone(),
                    meta.workspace_id.clone(),
                ),
                path.clone(),
            );
            self.by_id
                .entry(meta.id.clone())
                .or_default()
                .push(path.clone());
            if Self::has_obligation(meta) {
                self.pending.insert(path.clone());
            }
        }
        self.errors.remove(&path);
        self.files.insert(path, file);
    }
    fn has_obligation(meta: &SessionMeta) -> bool {
        meta.pending_permission.is_some()
            || meta
                .human_continuation
                .as_ref()
                .is_some_and(|c| !c.completed)
    }
    fn check_scope(&self, workspace: Option<&str>, strict: bool) -> Result<()> {
        if strict {
            if let Some((_, reason)) = self
                .errors
                .values()
                .find(|(scopes, _)| workspace.is_none_or(|id| scopes.iter().any(|s| s == id)))
            {
                anyhow::bail!("{reason}");
            }
        }
        Ok(())
    }
    fn metadata(&self, workspace: Option<&str>, strict: bool) -> Result<Vec<SessionMeta>> {
        self.check_scope(workspace, strict)?;
        Ok(self
            .order
            .values()
            .rev()
            .filter_map(|path| self.files.get(path)?.meta.as_deref())
            .filter(|meta| workspace.is_none_or(|id| id == meta.workspace_id))
            .cloned()
            .collect())
    }
}

/// Removes a coalesced refresh even when its task is aborted or unwinds.
struct ScopeRefresh {
    pending: Arc<std::sync::Mutex<HashSet<Vec<PathBuf>>>>,
    homes: Vec<PathBuf>,
}

impl Drop for ScopeRefresh {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.homes);
        }
    }
}

#[derive(Clone)]
pub struct Store {
    homes: WorkspaceHomes,
    coordination: super::coordination::Cache,
    catalog_reads: Arc<crate::blocking::InFlightReads<Option<String>, Arc<CatalogScan>>>,
    /// Coalesce global sweeps and the initial catalog load. Scoped reads
    /// synchronize only with scans of the same physical sessions directory.
    sweep: Arc<tokio::sync::Mutex<()>>,
    scope_refreshes: Arc<std::sync::Mutex<HashSet<Vec<PathBuf>>>>,
    page_catalog: Arc<std::sync::Mutex<PageCatalog>>,
    catalog_wake: Arc<tokio::sync::Notify>,
}

impl Store {
    pub fn new(homes: WorkspaceHomes) -> Self {
        Store {
            homes,
            coordination: Default::default(),
            catalog_reads: Default::default(),
            sweep: Default::default(),
            scope_refreshes: Default::default(),
            page_catalog: Default::default(),
            catalog_wake: Default::default(),
        }
    }

    pub(super) fn coordination(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Option<genehub_proto::SessionCoordinationSummary> {
        self.coordination
            .read(&self.homes.home_dir(workspace_id).ok()?, session_id)
    }

    pub fn session_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        self.ensure_not_deleted(workspace_id, session_id)?;
        self.raw_session_dir(workspace_id, session_id)
    }

    /// Reserve an operation's deterministic SID before it can receive input.
    /// The existing per-session writer lock excludes other daemon writers;
    /// the caller serializes local creation. Intent survives every later crash.
    pub(super) fn reserve_creation(
        &self,
        workspace_id: &str,
        operation: &str,
        parameters: &Value,
    ) -> Result<(String, Option<SessionMeta>)> {
        if operation.is_empty()
            || operation.len() > 128
            || !operation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            anyhow::bail!("creationId must contain 1-128 ASCII letters, digits, '.', '_' or '-'");
        }
        let key = self.homes.project_key(workspace_id)?;
        let digest = Sha256::digest(serde_json::to_vec(&("session.create.v1", key, operation))?);
        // Keep the established 128-bit Session ID spelling (including Windows
        // path lengths); the immutable parameters also fence a hash collision.
        let hash = format!("{:x}", digest);
        let sid = format!("s_{}", &hash[..32]);
        let dir = self.session_dir(workspace_id, &sid)?;
        let intent = dir.join("creation.json");
        let expected = serde_json::json!({"operation": operation, "parameters": parameters});
        if intent.exists() {
            let found: Value = serde_json::from_slice(&fs::read(&intent)?)?;
            if found != expected {
                anyhow::bail!("creationId already belongs to different parameters");
            }
            if dir.join("meta.json").exists() {
                let meta = self.load_meta(workspace_id, &sid)?;
                if !meta.openable() {
                    anyhow::bail!("creation was written by a newer session format");
                }
                return Ok((sid, Some(meta)));
            }
        }
        self.prepare_write(workspace_id, &sid, &dir)?;
        // Recheck after obtaining the physical writer lock.
        if intent.exists() {
            let found: Value = serde_json::from_slice(&fs::read(&intent)?)?;
            if found != expected {
                anyhow::bail!("creationId already belongs to different parameters");
            }
        } else {
            crate::config::save_private(&intent, &serde_json::to_vec(&expected)?)?;
        }
        if dir.join("meta.json").exists() {
            return Ok((sid.clone(), Some(self.load_meta(workspace_id, &sid)?)));
        }
        Ok((sid, None))
    }

    /// Where the workspace itself lives, for mapping absolute tool paths back
    /// onto workspace-relative ones.
    pub fn workspace_root(&self, workspace_id: &str) -> Result<PathBuf> {
        self.homes.root(workspace_id)
    }

    /// Everything the daemon owns for one Space, sessions included. Component
    /// storage that must outlive a single conversation lives here.
    pub fn space_home(&self, workspace_id: &str) -> Result<PathBuf> {
        self.homes.home_dir(workspace_id)
    }

    fn raw_session_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self.homes.sessions_dir(workspace_id)?.join(session_id))
    }

    fn tombstone_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .homes
            .home_dir(workspace_id)?
            .join(TOMBSTONES_DIR)
            .join(format!("{session_id}.json")))
    }

    fn is_deleted(&self, workspace_id: &str, session_id: &str) -> Result<bool> {
        Ok(self.tombstone_path(workspace_id, session_id)?.exists())
    }

    fn ensure_not_deleted(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        if self.is_deleted(workspace_id, session_id)? {
            return Err(SessionDeleted.into());
        }
        Ok(())
    }

    /// Claims a session for work that may touch adapter scratch. Forking uses
    /// this to choose native checkpointing only when the source is writable.
    pub fn claim_session(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        let dir = self.raw_session_dir(workspace_id, session_id)?;
        self.prepare_write(workspace_id, session_id, &dir)
    }

    fn meta_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("meta.json"))
    }

    fn seed_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("seed.json"))
    }

    /// The blob overview rows a fork brought with it: thumbnails and blob
    /// references, never payloads. Persisted as one JSON value per line so the
    /// forked session keeps its picture strip and — while the source session
    /// stays reachable — the refs needed to drill into originals.
    pub fn save_fork_appendix(
        &self,
        workspace_id: &str,
        session_id: &str,
        rows: &[genehub_proto::BlobOverview],
    ) -> Result<()> {
        let path = self
            .session_dir(workspace_id, session_id)?
            .join("fork-appendix.jsonl");
        self.prepare_write(
            workspace_id,
            session_id,
            path.parent()
                .expect("fork-appendix.jsonl always has a parent"),
        )?;
        let mut encoded = Vec::new();
        for row in rows {
            encoded.extend_from_slice(&serde_json::to_vec(row)?);
            encoded.push(b'\n');
        }
        crate::config::save_private(&path, &encoded)
    }

    pub fn load_fork_appendix(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Vec<genehub_proto::BlobOverview>> {
        let path = self
            .session_dir(workspace_id, session_id)?
            .join("fork-appendix.jsonl");
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        serde_json::Deserializer::from_slice(&raw)
            .into_iter::<genehub_proto::BlobOverview>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn chat_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("chat.jsonl"))
    }

    fn round_dir(&self, workspace_id: &str, session_id: &str, ord: u32) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("rounds")
            .join(format!("r-{ord:03}")))
    }

    fn trunk_index_path(&self, workspace_id: &str, session_id: &str, ord: u32) -> Result<PathBuf> {
        Ok(self
            .round_dir(workspace_id, session_id, ord)?
            .join("index.jsonl"))
    }

    fn trunk_path(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        trunk: u32,
    ) -> Result<PathBuf> {
        Ok(self
            .round_dir(workspace_id, session_id, ord)?
            .join(format!("t-{trunk:04}.jsonl")))
    }

    fn blob_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self.session_dir(workspace_id, session_id)?.join("blobs"))
    }

    /// Private per-session scratch space for adapters.
    pub fn scratch_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self.session_dir(workspace_id, session_id)?.join("state"))
    }

    /// The adapter's scratch space, ready to be written into.
    pub fn make_scratch_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        let dir = self.scratch_dir(workspace_id, session_id)?;
        self.prepare_write(workspace_id, session_id, &dir)?;
        Ok(dir)
    }

    /// The one gate every session write passes through: establishes the
    /// GeneHub home, creates the target directory, then claims that session.
    ///
    /// Reads deliberately do not come here. A build that cannot write a
    /// workspace can still show every conversation in it.
    pub(super) fn prepare_write(
        &self,
        workspace_id: &str,
        session_id: &str,
        dir: &Path,
    ) -> Result<()> {
        self.ensure_not_deleted(workspace_id, session_id)?;
        let home = self.homes.home_dir(workspace_id)?;
        if !self.homes.holds(workspace_id, session_id) {
            self.establish_home(&home)?;
            self.homes.claim_compatibility(workspace_id, &home)?;
        }
        if !dir.exists() {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
            for path in dir.ancestors().take_while(|path| path.starts_with(&home)) {
                crate::config::restrict_dir_to_owner(path)?;
            }
        }
        if !self.homes.holds(workspace_id, session_id) {
            let session_dir = self.raw_session_dir(workspace_id, session_id)?;
            fs::create_dir_all(&session_dir)
                .with_context(|| format!("creating {}", session_dir.display()))?;
            crate::config::restrict_dir_to_owner(&session_dir)?;
            self.homes.claim(workspace_id, session_id, &session_dir)?;
            // A competing deleter may have written the tombstone while this
            // process waited for writer.lock. Check only after owning the lock
            // so no write can cross the logical deletion boundary.
            if let Err(error) = self.ensure_not_deleted(workspace_id, session_id) {
                self.homes.release(workspace_id, session_id)?;
                return Err(error);
            }
        }
        Ok(())
    }

    /// Two things have to be true of a workspace's GeneHub home before any
    /// session lands in it. It must be owner-only, because conversations were
    /// owner-only when they lived under the daemon's data directory and moving
    /// them into a project must not quietly widen who can read them. And it
    /// must be invisible to the project's own version control, or the first
    /// thing a user sees after their first message is their own `git status`
    /// full of session files.
    fn establish_home(&self, home: &Path) -> Result<()> {
        if !home.exists() {
            fs::create_dir_all(home).with_context(|| format!("creating {}", home.display()))?;
            crate::config::restrict_dir_to_owner(home)?;
        }
        let ignore = home.join(".gitignore");
        if !ignore.exists() {
            fs::write(&ignore, "*\n").with_context(|| format!("writing {}", ignore.display()))?;
        }
        let rgignore = home.join(".rgignore");
        if !rgignore.exists() {
            fs::write(
                &rgignore,
                "!sessions/**\nsessions/*/blobs/\nsessions/*/state/\nsessions/*/images/\nsessions/*/artifacts/\nsessions/*/preview-review-images/\n",
            )
            .with_context(|| format!("writing {}", rgignore.display()))?;
        }
        Ok(())
    }

    // -- meta ---------------------------------------------------------------

    /// Writes the meta, stamping it with the layout this build writes.
    ///
    /// The stamp is applied here rather than by the caller so that "the file
    /// says what wrote it" cannot be forgotten at one of the dozen places a
    /// session is touched.
    pub fn save_meta(&self, meta: &SessionMeta) -> Result<()> {
        let path = self.meta_path(&meta.workspace_id, &meta.id)?;
        self.prepare_write(
            &meta.workspace_id,
            &meta.id,
            path.parent().expect("meta.json always has a parent"),
        )?;
        if meta.history_only {
            let raw = match fs::read(&path) {
                Ok(raw) => Some(raw),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if let Some(raw) = raw {
                let original: Value = serde_json::from_slice(&raw)?;
                if original.get("managed").is_some_and(|v| !v.is_null())
                    || original
                        .get("managedSystemPrompt")
                        .is_some_and(|v| !v.is_null())
                {
                    let backup = path.with_file_name(format!(
                        "meta.legacy-workflow-{}.json",
                        uuid::Uuid::new_v4().simple()
                    ));
                    crate::config::save_private(&backup, &raw)?;
                }
            }
        }
        let stamped = SessionMeta {
            format: SESSION_FORMAT,
            ..meta.clone()
        };
        let mut value = serde_json::to_value(stamped)?;
        value["projectKey"] =
            serde_json::Value::String(self.homes.project_key(&meta.workspace_id)?);
        let raw = serde_json::to_string_pretty(&value)?;
        crate::config::save_private(&path, raw.as_bytes())?;
        // Reuse the same normalization/owner selection as an actual catalog
        // read, including aliased project views and history-only records.
        let normalized = (|| -> Result<SessionMeta> {
            let dirs = self.homes.session_dirs_for(Some(&meta.workspace_id));
            let projects = &dirs.first().context("session home disappeared")?.0;
            let header: MetaHeader = serde_json::from_str(&raw)?;
            let owner = Self::metadata_owner(projects, &header.project_key)
                .context("session owner disappeared")?;
            self.load_meta_from(&owner, &meta.id, &raw, header)
        })();
        if let Ok(mut cache) = self.page_catalog.lock() {
            if let Ok(meta) = normalized {
                cache.write_revision = cache.write_revision.wrapping_add(1);
                let changed = cache.write_revision;
                cache.put(
                    path.clone(),
                    CatalogFile {
                        stamp: MetadataStamp::read(&path),
                        meta: Some(Arc::new(meta)),
                        error: None,
                        changed,
                    },
                );
                cache.wrote(&path);
            } else {
                cache.generation = cache.generation.wrapping_add(1);
                cache.checked_at = None;
            }
        }
        self.catalog_wake.notify_one();
        Ok(())
    }

    pub fn load_meta(&self, workspace_id: &str, session_id: &str) -> Result<SessionMeta> {
        let path = self.meta_path(workspace_id, session_id)?;
        let raw =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let header: MetaHeader = serde_json::from_str(&raw)
            .with_context(|| format!("reading the header of {}", path.display()))?;
        self.load_meta_from(workspace_id, session_id, &raw, header)
    }

    /// Parses one already-read `meta.json`. `list_meta` reads and parses each
    /// header once to find its owner, then reuses the same text here.
    fn load_meta_from(
        &self,
        workspace_id: &str,
        session_id: &str,
        raw: &str,
        header: MetaHeader,
    ) -> Result<SessionMeta> {
        if header.format > SESSION_FORMAT {
            if !header.project_key.is_empty()
                && !self
                    .homes
                    .claims_project_key(workspace_id, &header.project_key)?
            {
                anyhow::bail!("session {session_id} belongs to another workspace");
            }
            return Ok(SessionMeta::unopenable(
                session_id.to_string(),
                workspace_id.to_string(),
                self.homes.root(workspace_id)?,
                header,
            ));
        }
        let mut meta: SessionMeta = serde_json::from_str(raw)?;
        // A legacy execution binding is interpreted only by this disk reader.
        // No old prompt, native continuation or delivery obligation is executed.
        let legacy: Value = serde_json::from_str(raw)?;
        if legacy.get("managed").is_some_and(|v| !v.is_null())
            || legacy
                .get("managedSystemPrompt")
                .is_some_and(|v| !v.is_null())
        {
            meta.history_only = true;
            if !meta
                .labels
                .iter()
                .any(|label| label == SESSION_STARTED_LABEL)
            {
                meta.labels.push(SESSION_STARTED_LABEL.into());
            }
        }
        if meta.history_only {
            meta.inbox = Default::default();
            meta.persist = None;
            meta.pending_permission = None;
            meta.human_continuation = None;
            meta.open_turn = None;
            meta.agent_pid = None;
        }

        if !header.project_key.is_empty()
            && !self
                .homes
                .claims_project_key(workspace_id, &header.project_key)?
        {
            anyhow::bail!("session {session_id} belongs to another workspace");
        }
        meta.workspace_id = workspace_id.to_string();
        meta.format = header.format;
        Ok(meta)
    }

    /// Saves a reconstructed fork's one-shot prompt separately from metadata.
    pub fn save_seed(
        &self,
        workspace_id: &str,
        session_id: &str,
        seed: &ContextSeed,
    ) -> Result<()> {
        let path = self.seed_path(workspace_id, session_id)?;
        self.prepare_write(
            workspace_id,
            session_id,
            path.parent().expect("seed.json always has a parent"),
        )?;
        crate::config::save_private(&path, serde_json::to_vec_pretty(seed)?.as_slice())
    }

    /// Loads the reconstructed context when this session still needs to hand
    /// it to its target Agent. Ordinary and native-forked sessions have no
    /// seed file.
    pub fn load_seed(&self, workspace_id: &str, session_id: &str) -> Result<Option<ContextSeed>> {
        let path = self.seed_path(workspace_id, session_id)?;
        let raw = match fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        };
        Ok(Some(
            serde_json::from_slice(&raw).with_context(|| format!("parsing {}", path.display()))?,
        ))
    }

    /// Every session of every registered workspace, newest first.
    ///
    /// A workspace the user has not opened on this machine contributes nothing,
    /// because its directory is the only place its sessions exist.
    ///
    /// Sessions a newer build wrote are listed too, marked as unopenable. They
    /// are the user's conversations sitting in the user's own folder, so the
    /// answer to "where did my chats go" has to be visible rather than an empty
    /// list, even though this build cannot show what is inside them.
    pub async fn list_meta(&self) -> Result<Vec<SessionMeta>> {
        self.list_meta_for(None).await
    }

    pub async fn list_meta_for(&self, workspace: Option<&str>) -> Result<Vec<SessionMeta>> {
        // Execution recovery, import de-duplication and deletion checks require
        // a fresh durable observation, independently of presentation caches.
        let scan = self.fresh_metadata_scan(workspace).await?;
        let mut rows: Vec<_> = scan
            .files
            .values()
            .filter_map(|f| f.meta.as_deref())
            .filter(|m| workspace.is_none_or(|id| id == m.workspace_id))
            .cloned()
            .collect();
        rows.sort_by_key(|m| std::cmp::Reverse(m.updated_at_ms));
        Ok(rows)
    }

    pub(super) async fn list_metadata(&self, workspace: Option<&str>) -> Result<Vec<SessionMeta>> {
        self.catalog_metadata(workspace, false).await
    }

    fn invalidate_page_catalog(&self) {
        if let Ok(mut cache) = self.page_catalog.lock() {
            cache.generation = cache.generation.wrapping_add(1);
            cache.checked_at = None;
        }
    }

    fn forget_catalog_session(&self, workspace: &str, session: &str) {
        let Ok(dir) = self.raw_session_dir(workspace, session) else {
            return;
        };
        let path = dir.join("meta.json");
        if let Ok(mut cache) = self.page_catalog.lock() {
            cache.write_revision = cache.write_revision.wrapping_add(1);
            let changed = cache.write_revision;
            // A cold read that started before deletion must not put the row
            // back. The next reconciliation drops this empty cache entry.
            cache.put(
                path.clone(),
                CatalogFile {
                    stamp: None,
                    meta: None,
                    error: None,
                    changed,
                },
            );
            if let Some(watch) = cache.watches.get_mut(&path) {
                watch.hurry(std::time::Instant::now());
            }
            if let Some(home) = path
                .parent()
                .and_then(Path::parent)
                .and_then(|sessions| cache.homes.get_mut(sessions))
            {
                home.tombstones.hurry(std::time::Instant::now());
            }
        }
        self.catalog_wake.notify_one();
    }

    async fn catalog_metadata(
        &self,
        workspace: Option<&str>,
        strict: bool,
    ) -> Result<Vec<SessionMeta>> {
        if let Some(id) = workspace {
            self.homes.root(id)?;
        }
        self.ensure_catalog().await?;
        if let Some(id) = workspace {
            self.validate_scope(id).await?;
        }
        self.page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?
            .metadata(workspace, strict)
    }

    pub(super) async fn metadata_window(
        &self,
        workspace: Option<&str>,
        include_archived: bool,
        before: Option<(i64, String, String)>,
        limit: usize,
    ) -> Result<Vec<SessionMeta>> {
        if let Some(id) = workspace {
            self.homes.root(id)?;
        }
        self.ensure_catalog().await?;
        if let Some(id) = workspace {
            self.validate_scope(id).await?;
        }
        let cache = self
            .page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?;
        cache.check_scope(workspace, true)?;
        let end = before
            .map(std::ops::Bound::Excluded)
            .unwrap_or(std::ops::Bound::Unbounded);
        Ok(cache
            .order
            .range((std::ops::Bound::Unbounded, end))
            .rev()
            .filter_map(|(_, path)| cache.files.get(path)?.meta.as_deref())
            .filter(|m| {
                workspace.is_none_or(|id| id == m.workspace_id) && (include_archived || !m.archived)
            })
            .take(limit)
            .cloned()
            .collect())
    }

    pub(super) async fn activity_metadata(
        &self,
        workspace: Option<&str>,
        live_ids: &[String],
        strict: bool,
    ) -> Result<Vec<SessionMeta>> {
        if let Some(id) = workspace {
            self.homes.root(id)?;
        }
        self.ensure_catalog().await?;
        if let Some(id) = workspace {
            self.validate_scope(id).await?;
        }
        // The existing projection cache observes each home once. No history
        // row is projected just to discover which sessions have obligations.
        let coordination: Vec<_> = self
            .homes
            .session_dirs_for(workspace)
            .into_iter()
            .map(|(owners, sessions)| {
                let home = sessions.parent().expect("sessions have a home");
                (
                    owners.into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
                    self.coordination.candidates(home),
                )
            })
            .collect();
        let cache = self
            .page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?;
        cache.check_scope(workspace, strict)?;
        let mut paths = cache.pending.clone();
        for id in live_ids {
            if let Some(found) = cache.by_id.get(id) {
                paths.extend(found.iter().cloned());
            }
        }
        for (owners, ids) in coordination {
            match ids {
                Some(ids) => {
                    for id in ids {
                        if let Some(found) = cache.by_id.get(&id) {
                            paths.extend(
                                found
                                    .iter()
                                    .filter(|p| {
                                        cache
                                            .files
                                            .get(*p)
                                            .and_then(|f| f.meta.as_ref())
                                            .is_some_and(|m| owners.contains(&m.workspace_id))
                                    })
                                    .cloned(),
                            );
                        }
                    }
                }
                // An unavailable declared coordinator makes its scope unknown,
                // including sessions absent from its previous projection.
                None => paths.extend(
                    cache
                        .order
                        .values()
                        .filter(|p| {
                            cache
                                .files
                                .get(*p)
                                .and_then(|f| f.meta.as_ref())
                                .is_some_and(|m| owners.contains(&m.workspace_id))
                        })
                        .cloned(),
                ),
            }
        }
        let mut rows: Vec<_> = paths
            .iter()
            .filter_map(|p| cache.files.get(p)?.meta.as_deref())
            .filter(|m| workspace.is_none_or(|id| id == m.workspace_id))
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            (b.updated_at_ms, &b.id, &b.workspace_id).cmp(&(
                a.updated_at_ms,
                &a.id,
                &a.workspace_id,
            ))
        });
        Ok(rows)
    }

    /// Removal needs only durable pending decisions in the checked subtree,
    /// never complete summaries, title repair or unrelated project projection.
    pub(super) async fn has_pending_interactions(&self, workspaces: &[String]) -> Result<bool> {
        Ok(!self.pending_interactions(workspaces).await?.is_empty())
    }

    pub(super) fn writes_session(&self, workspace_id: &str, session_id: &str) -> bool {
        self.homes.holds(workspace_id, session_id)
    }

    /// Lets another daemon write a session this one only touched to stop it.
    pub(super) fn release_session(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        self.homes.release(workspace_id, session_id)
    }

    /// Sessions, loaded or not, that still owe the user an answer.
    pub(super) async fn pending_interactions(&self, workspaces: &[String]) -> Result<Vec<String>> {
        let mut pending = Vec::new();
        for workspace in workspaces {
            // This is an execution/removal decision, not a presentation read.
            // Observe just the affected homes, including external decisions.
            let scan = self.fresh_metadata_scan(Some(workspace)).await?;
            if let Some((_, reason)) = scan.errors.values().next() {
                anyhow::bail!("{reason}");
            }
            pending.extend(
                scan.files
                    .values()
                    .filter_map(|file| file.meta.as_ref())
                    .filter(|meta| !meta.execution_retired && PageCatalog::has_obligation(meta))
                    .map(|meta| meta.id.clone()),
            );
        }
        Ok(pending)
    }

    pub(super) fn catalog_scope_errors(&self) -> Vec<genehub_proto::CatalogScopeError> {
        let cache = self.page_catalog.lock().unwrap_or_else(|e| e.into_inner());
        let mut errors = Vec::new();
        for (scopes, message) in cache.errors.values() {
            if scopes.is_empty() {
                errors.push(genehub_proto::CatalogScopeError {
                    workspace_id: None,
                    message: message.chars().take(1000).collect(),
                });
            }
            for workspace in scopes {
                errors.push(genehub_proto::CatalogScopeError {
                    workspace_id: Some(workspace.clone()),
                    message: message.chars().take(1000).collect(),
                });
            }
        }
        errors.sort_by(|a, b| (&a.workspace_id, &a.message).cmp(&(&b.workspace_id, &b.message)));
        errors.dedup();
        errors
    }

    pub(super) fn catalog_wake(&self) -> Arc<tokio::sync::Notify> {
        self.catalog_wake.clone()
    }

    pub(super) fn mark_catalog_dirty(&self, workspace: &str, session: &str) {
        if let Ok(mut cache) = self.page_catalog.lock() {
            let session = genehub_proto::CatalogSessionRef {
                workspace_id: workspace.into(),
                id: session.into(),
            };
            cache.changes.touch(session.clone());
            cache.projection.dirty.insert(session);
        }
        self.catalog_wake.notify_one();
    }

    /// A running session published something. Only change cursors care: the
    /// catalog itself does not change, so nothing is woken.
    pub(super) fn note_activity(&self, workspace: &str, session: &str) {
        if let Ok(mut cache) = self.page_catalog.lock() {
            cache.changes.touch(genehub_proto::CatalogSessionRef {
                workspace_id: workspace.into(),
                id: session.into(),
            });
        }
    }

    /// Sessions in `workspaces` that changed after `since` (a sequence from
    /// this daemon's `token`), oldest change first and at most `limit`. Reads
    /// the index only: this daemon's own writes are already in it, and other
    /// writers appear once the background sweep has looked at them.
    pub(super) async fn catalog_changes(
        &self,
        workspaces: &HashSet<String>,
        since: Option<(&str, u64)>,
        limit: usize,
    ) -> Result<CatalogChanges> {
        self.ensure_catalog().await?;
        let mut cache = self
            .page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?;
        if cache.changes.token.is_empty() {
            cache.changes.token = uuid::Uuid::new_v4().simple().to_string();
        }
        let log = &cache.changes;
        let continued = since.filter(|(token, seq)| {
            *token == log.token && *seq <= log.seq && (*seq == 0 || *seq >= log.floor)
        });
        let after = continued.map_or(0, |(_, seq)| seq);
        let mut due: Vec<(u64, &genehub_proto::CatalogSessionRef)> = log
            .last
            .iter()
            .filter(|(session, seq)| **seq > after && workspaces.contains(&session.workspace_id))
            .map(|(session, seq)| (*seq, session))
            .collect();
        due.sort_unstable_by_key(|(seq, _)| *seq);
        let complete = due.len() <= limit;
        due.truncate(limit);
        let upto = if complete {
            log.seq
        } else {
            due.last().map_or(log.seq, |(seq, _)| *seq)
        };
        let mut changed = Vec::with_capacity(due.len());
        let mut listed = HashSet::new();
        for (_, session) in &due {
            let meta = cache.by_id.get(&session.id).and_then(|paths| {
                paths.iter().find_map(|path| {
                    cache
                        .files
                        .get(path)
                        .and_then(|file| file.meta.as_ref())
                        .filter(|meta| meta.workspace_id == session.workspace_id)
                })
            });
            if let Some(meta) = meta {
                listed.insert(*session);
                changed.push((**meta).clone());
            }
        }
        let removed = if after == 0 {
            Vec::new()
        } else {
            log.removed
                .iter()
                .filter(|(seq, session)| {
                    *seq > after
                        && *seq <= upto
                        && workspaces.contains(&session.workspace_id)
                        && !listed.contains(session)
                })
                .map(|(_, session)| session.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        };
        Ok(CatalogChanges {
            changed,
            removed,
            token: log.token.clone(),
            seq: upto,
            complete,
            reset: since.is_some_and(|(_, seq)| seq > 0) && continued.is_none(),
        })
    }

    pub(super) fn catalog_edit<R>(&self, edit: impl FnOnce(&mut CatalogProjection) -> R) -> R {
        let mut cache = self.page_catalog.lock().unwrap_or_else(|e| e.into_inner());
        edit(&mut cache.projection)
    }

    pub(super) fn catalog_metadata_keys(
        &self,
        keys: &HashSet<genehub_proto::CatalogSessionRef>,
    ) -> Vec<Arc<SessionMeta>> {
        let cache = self.page_catalog.lock().unwrap_or_else(|e| e.into_inner());
        keys.iter()
            .filter_map(|key| {
                cache
                    .by_id
                    .get(&key.id)?
                    .iter()
                    .filter_map(|path| cache.files.get(path)?.meta.as_ref())
                    .find(|meta| meta.workspace_id == key.workspace_id)
                    .cloned()
            })
            .collect()
    }

    /// A late projection cannot publish over a durable write or deletion.
    pub(super) fn catalog_accept(
        &self,
        meta: &Arc<SessionMeta>,
        row: &genehub_proto::CatalogSessionRow,
    ) -> bool {
        let mut cache = self.page_catalog.lock().unwrap_or_else(|e| e.into_inner());
        let current = cache.by_id.get(&meta.id).is_some_and(|paths| {
            paths.iter().any(|p| {
                cache
                    .files
                    .get(p)
                    .and_then(|f| f.meta.as_ref())
                    .is_some_and(|m| Arc::ptr_eq(meta, m))
            })
        });
        if !current {
            return false;
        }
        let key = genehub_proto::CatalogSessionRef {
            workspace_id: meta.workspace_id.clone(),
            id: meta.id.clone(),
        };
        let value = (row.etag.clone(), row.active);
        if cache.projection.rows.get(&key) == Some(&value) {
            return false;
        }
        cache.projection.rows.insert(key, value);
        true
    }

    async fn ensure_catalog(&self) -> Result<()> {
        let revision = self
            .homes
            .revision
            .load(std::sync::atomic::Ordering::Acquire);
        {
            let cache = self
                .page_catalog
                .lock()
                .map_err(|_| anyhow!("page catalog poisoned"))?;
            // A presentation read uses the current projection. Expiry belongs
            // to background reconciliation, never to an already-cached page.
            // New/changed home registrations still need their initial scan.
            if cache.initialized && cache.homes_revision == revision {
                return Ok(());
            }
        }
        self.reconcile_catalog().await
    }

    /// The existing discovery task owns periodic external-file reconciliation.
    /// The first pass reads every home; later passes look only at what is due
    /// (see [`CATALOG_CADENCE`]). Durable recovery continues to use
    /// fresh_metadata_scan independently of presentation snapshots.
    pub(super) async fn reconcile_catalog(&self) -> Result<()> {
        let _sweep = crate::diagnostics::read::observe("catalog_global_lock", None, None, async {
            Ok(self.sweep.lock().await)
        })
        .await?;
        loop {
            let revision = self
                .homes
                .revision
                .load(std::sync::atomic::Ordering::Acquire);
            let (generation, initialized) = {
                let cache = self
                    .page_catalog
                    .lock()
                    .map_err(|_| anyhow!("page catalog poisoned"))?;
                if cache.initialized
                    && cache.homes_revision == revision
                    && cache
                        .checked_at
                        .is_some_and(|at| at.elapsed() < CATALOG_SWEEP_EVERY)
                {
                    return Ok(());
                }
                (cache.generation, cache.initialized)
            };
            let applied = if initialized {
                crate::diagnostics::read::observe(
                    "catalog_global_refresh",
                    None,
                    None,
                    self.sweep_catalog(None, revision, generation),
                )
                .await?
            } else {
                self.load_catalog(revision, generation).await?
            };
            if applied {
                return Ok(());
            }
            // A registry/deletion fence changed during enumeration. Re-read
            // the current generation rather than returning the abandoned scan.
        }
    }

    /// Cold scopes establish a durable observation before presentation. A
    /// successfully observed scope serves its projection while one coalesced
    /// refresh runs after SCOPE_REUSE; expiry never blocks a warm page on IO.
    async fn validate_scope(&self, workspace: &str) -> Result<()> {
        let revision = self
            .homes
            .revision
            .load(std::sync::atomic::Ordering::Acquire);
        let mut homes: Vec<PathBuf> = self
            .homes
            .session_dirs_for(Some(workspace))
            .into_iter()
            .map(|(_, sessions)| sessions)
            .collect();
        homes.sort();
        homes.dedup();
        let warm = {
            let cache = self
                .page_catalog
                .lock()
                .map_err(|_| anyhow!("page catalog poisoned"))?;
            cache.initialized
                && cache.homes_revision == revision
                && homes.iter().all(|sessions| {
                    cache
                        .homes
                        .get(sessions)
                        .and_then(|home| home.validated)
                        .is_some()
                })
        };
        if warm {
            let fresh = {
                let cache = self
                    .page_catalog
                    .lock()
                    .map_err(|_| anyhow!("page catalog poisoned"))?;
                homes.iter().all(|sessions| {
                    cache
                        .homes
                        .get(sessions)
                        .and_then(|home| home.validated)
                        .is_some_and(|at| at.elapsed() < SCOPE_REUSE)
                })
            };
            if !fresh {
                let inserted = self
                    .scope_refreshes
                    .lock()
                    .map_err(|_| anyhow!("scope refresh registry poisoned"))?
                    .insert(homes.clone());
                if inserted {
                    let guard = ScopeRefresh {
                        pending: self.scope_refreshes.clone(),
                        homes,
                    };
                    let store = self.clone();
                    let workspace = workspace.to_owned();
                    tokio::spawn(async move {
                        let _guard = guard;
                        if let Err(error) = store.validate_scope_now(&workspace).await {
                            tracing::warn!(%workspace, %error, "scope catalog refresh failed");
                        }
                    });
                }
            }
            return Ok(());
        }
        self.validate_scope_now(workspace).await
    }

    async fn validate_scope_now(&self, workspace: &str) -> Result<()> {
        loop {
            let revision = self
                .homes
                .revision
                .load(std::sync::atomic::Ordering::Acquire);
            let sessions: Vec<PathBuf> = self
                .homes
                .session_dirs_for(Some(workspace))
                .into_iter()
                .map(|(_, sessions)| sessions)
                .collect();
            let generation = {
                let cache = self
                    .page_catalog
                    .lock()
                    .map_err(|_| anyhow!("page catalog poisoned"))?;
                if sessions.iter().all(|sessions| {
                    cache
                        .homes
                        .get(sessions)
                        .and_then(|home| home.validated)
                        .is_some_and(|at| at.elapsed() < SCOPE_REUSE)
                }) {
                    return Ok(());
                }
                cache.generation
            };
            if crate::diagnostics::read::observe(
                "catalog_scope_refresh",
                Some(workspace),
                None,
                self.sweep_catalog(Some(workspace), revision, generation),
            )
            .await?
            {
                return Ok(());
            }
        }
    }

    async fn load_catalog(&self, revision: u64, generation: u64) -> Result<bool> {
        let write_revision = self
            .page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?
            .write_revision;
        // Recovery always asks for a fresh durable observation. A cold
        // presentation read may share that in-flight scan, never its old
        // cached result, so boot does not walk every file twice.
        let mut scan = (*crate::diagnostics::read::observe(
            "catalog_initial_scan",
            None,
            None,
            self.fresh_metadata_scan(None),
        )
        .await?)
            .clone();
        let mut cache = self
            .page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?;
        if cache.generation != generation
            || self
                .homes
                .revision
                .load(std::sync::atomic::Ordering::Acquire)
                != revision
        {
            return Ok(false);
        }
        // Keep durable local changes made during this scan, for its entire
        // lifetime rather than a short overlay window.
        let mut wrote = Vec::new();
        for (path, file) in &cache.files {
            if file.changed > write_revision {
                scan.files.insert(path.clone(), file.clone());
                scan.errors.remove(path);
                wrote.push(path.clone());
            }
        }
        let removed: Vec<_> = cache
            .files
            .iter()
            .filter(|(path, _)| !scan.files.contains_key(*path))
            .filter_map(|(_, file)| file.meta.as_ref())
            .map(|m| genehub_proto::CatalogSessionRef {
                workspace_id: m.workspace_id.clone(),
                id: m.id.clone(),
            })
            .collect();
        for session in &removed {
            cache.changes.remove(session.clone());
        }
        cache.projection.removed.extend(removed);
        let present: Vec<_> = scan
            .files
            .values()
            .filter_map(|file| file.meta.as_ref())
            .map(|m| genehub_proto::CatalogSessionRef {
                workspace_id: m.workspace_id.clone(),
                id: m.id.clone(),
            })
            .collect();
        for session in &present {
            cache.changes.touch(session.clone());
        }
        cache.projection.dirty.extend(present);
        cache.order.clear();
        cache.by_id.clear();
        cache.pending.clear();
        for (path, file) in &scan.files {
            if let Some(m) = &file.meta {
                cache.order.insert(
                    (m.updated_at_ms, m.id.clone(), m.workspace_id.clone()),
                    path.clone(),
                );
                cache
                    .by_id
                    .entry(m.id.clone())
                    .or_default()
                    .push(path.clone());
                if PageCatalog::has_obligation(m) {
                    cache.pending.insert(path.clone());
                }
            }
        }
        let now = std::time::Instant::now();
        cache.watches.clear();
        cache.homes.clear();
        for (sessions, seen) in std::mem::take(&mut scan.homes) {
            for id in seen.sessions.difference(&seen.deleted) {
                let path = sessions.join(id).join("meta.json");
                let stamp = scan.files.get(&path).and_then(|file| file.stamp);
                cache.watches.insert(
                    path.clone(),
                    crate::fs_stamp::Watch::first(&path, stamp.as_ref(), now, CATALOG_CADENCE),
                );
            }
            let tombstones = sessions.with_file_name(TOMBSTONES_DIR);
            cache.homes.insert(
                sessions.clone(),
                HomeSweep {
                    observation_revision: 0,
                    listing: crate::fs_stamp::Watch::first(
                        &sessions,
                        seen.listing.as_ref(),
                        now,
                        HOME_CADENCE,
                    ),
                    tombstones: crate::fs_stamp::Watch::first(
                        &tombstones,
                        seen.tombstones.as_ref(),
                        now,
                        HOME_CADENCE,
                    ),
                    seen,
                    validated: None,
                },
            );
        }
        for path in wrote {
            cache.wrote(&path);
        }
        cache.initialized = true;
        cache.files = scan.files;
        cache.errors = scan.errors;
        cache.homes_revision = revision;
        cache.checked_at = Some(now);
        Ok(true)
    }

    /// One pass over what is due: a stat per due path, a directory listing
    /// only when a directory's stamp changed, and a read only when a file's
    /// stamp changed. `scope` forces every path of that project to be due.
    async fn sweep_catalog(
        &self,
        scope: Option<&str>,
        revision: u64,
        generation: u64,
    ) -> Result<bool> {
        let started = std::time::Instant::now();
        let workload = crate::diagnostics::work::Window::start();
        let registered = self.homes.session_dirs_for(scope);
        let registered_dirs: HashSet<PathBuf> = registered
            .iter()
            .map(|(_, sessions)| sessions.clone())
            .collect();
        let mut budget = crate::blocking::WorkBudget::new();
        let mut yield_wait = std::time::Duration::ZERO;
        let mut lock_wait = std::time::Duration::ZERO;
        let mut counts = SweepCounts::default();
        let mut looked = Vec::new();
        for (projects, sessions) in registered {
            yield_wait += budget.checkpoint().await;
            if scope.is_none() {
                let cache = self
                    .page_catalog
                    .lock()
                    .map_err(|_| anyhow!("page catalog poisoned"))?;
                // Most registered homes are cold and have no work this tick.
                // Avoid allocating a mutex and timed span for them. A due home
                // still acquires its physical lock and replans after waiting;
                // final generation/registry fences also cover skipped homes.
                if cache.homes.get(&sessions).is_some_and(|home| {
                    home.seen.owners == home_owners(&projects)
                        && !home.listing.due(started)
                        && !home.tombstones.due(started)
                        && home
                            .seen
                            .sessions
                            .iter()
                            .filter(|id| !home.seen.deleted.contains(*id))
                            .all(|id| {
                                let path = sessions.join(id).join("meta.json");
                                cache
                                    .watches
                                    .get(&path)
                                    .is_some_and(|watch| !watch.due(started))
                            })
                }) {
                    continue;
                }
            }
            let gate = {
                let mut cache = self
                    .page_catalog
                    .lock()
                    .map_err(|_| anyhow!("page catalog poisoned"))?;
                cache.home_sweeps.retain(|_, gate| gate.strong_count() > 0);
                let gate = cache
                    .home_sweeps
                    .get(&sessions)
                    .and_then(std::sync::Weak::upgrade)
                    .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
                cache
                    .home_sweeps
                    .insert(sessions.clone(), Arc::downgrade(&gate));
                gate
            };
            let lock_started = std::time::Instant::now();
            let _home = crate::diagnostics::read::observe(
                "catalog_home_lock",
                scope,
                Some(&sessions),
                async { Ok(gate.lock().await) },
            )
            .await?;
            lock_wait += lock_started.elapsed();
            // Only this home is serialized. A background observation records
            // its revision so a later scoped refresh wins at publication.
            let (plan, write_revision, observation_revision) = {
                let cache = self
                    .page_catalog
                    .lock()
                    .map_err(|_| anyhow!("page catalog poisoned"))?;
                if cache.generation != generation
                    || self
                        .homes
                        .revision
                        .load(std::sync::atomic::Ordering::Acquire)
                        != revision
                {
                    return Ok(false);
                }
                let force = scope.is_some();
                let owners = home_owners(&projects);
                let plan = if let Some(home) = cache
                    .homes
                    .get(&sessions)
                    .filter(|home| home.seen.owners == owners)
                {
                    // Another reader of this home may have refreshed it while
                    // this request was waiting for the same directory.
                    if force && home.validated.is_some_and(|at| at.elapsed() < SCOPE_REUSE) {
                        continue;
                    }
                    let entries: Vec<_> = home
                        .seen
                        .sessions
                        .iter()
                        .filter(|id| !home.seen.deleted.contains(*id))
                        .filter_map(|id| {
                            let path = sessions.join(id).join("meta.json");
                            let due =
                                force || cache.watches.get(&path).is_none_or(|w| w.due(started));
                            due.then(|| {
                                let file = cache.files.get(&path);
                                let stamp = file.and_then(|f| f.stamp);
                                // This daemon's write holds the session writer
                                // lock, so its stamp needs no settling.
                                let trusted =
                                    file.is_some_and(|f| f.changed > 0 && f.error.is_none());
                                let failed = file.is_some_and(|f| f.error.is_some());
                                (id.clone(), stamp, trusted && !failed)
                            })
                        })
                        .collect();
                    let list = force || home.listing.due(started);
                    let tombstones = force || home.tombstones.due(started);
                    if !list && !tombstones && entries.is_empty() {
                        continue;
                    }
                    HomePlan {
                        sessions,
                        projects,
                        prior: Some(home.seen.clone()),
                        list,
                        tombstones,
                        entries,
                    }
                } else {
                    HomePlan {
                        sessions,
                        projects,
                        prior: None,
                        list: true,
                        tombstones: true,
                        entries: Vec::new(),
                    }
                };
                let observation_revision = cache
                    .homes
                    .get(&plan.sessions)
                    .map(|home| home.observation_revision);
                (plan, cache.write_revision, observation_revision)
            };
            let home_path = plan.sessions.clone();
            let home = crate::diagnostics::read::observe(
                "catalog_home_scan",
                scope,
                Some(&home_path),
                async {
                    Ok(self
                        .sweep_home(plan, &mut budget, &mut yield_wait, &mut counts)
                        .await)
                },
            )
            .await?;
            tracing::debug!(
                event = "session_catalog_home_observed",
                scoped = scope.is_some(),
                home_key = crate::diagnostics::read::key(&home_path),
                observation_revision,
                observations = home.looked.len(),
                "session directory observation ready for publication"
            );
            let mut cache = self
                .page_catalog
                .lock()
                .map_err(|_| anyhow!("page catalog poisoned"))?;
            if cache.generation != generation
                || self
                    .homes
                    .revision
                    .load(std::sync::atomic::Ordering::Acquire)
                    != revision
            {
                return Ok(false);
            }
            if scope.is_some() {
                cache.apply_home(home, write_revision, true, std::time::Instant::now());
            } else {
                looked.push((home, write_revision, observation_revision));
            }
        }
        let mut cache = self
            .page_catalog
            .lock()
            .map_err(|_| anyhow!("page catalog poisoned"))?;
        if cache.generation != generation
            || self
                .homes
                .revision
                .load(std::sync::atomic::Ordering::Acquire)
                != revision
        {
            return Ok(false);
        }
        let now = std::time::Instant::now();
        // Keep global publication atomic, as before. A scoped refresh that
        // completed after one of these observations must not be overwritten.
        for (home, write_revision, observed) in looked {
            if cache
                .homes
                .get(&home.sessions)
                .map(|home| home.observation_revision)
                == observed
            {
                cache.apply_home(home, write_revision, false, now);
            }
        }
        if scope.is_none() {
            let stale: Vec<PathBuf> = cache
                .homes
                .keys()
                .filter(|sessions| !registered_dirs.contains(*sessions))
                .cloned()
                .collect();
            for sessions in stale {
                cache.forget_home(&sessions);
            }
            cache.homes_revision = revision;
            cache.checked_at = Some(now);
        }
        drop(cache);
        let elapsed = started.elapsed();
        tracing::debug!(
            event = "session_catalog_swept",
            scoped = scope.is_some(),
            homes = counts.homes,
            listings = counts.listings,
            stats = counts.stats,
            metadata_read = counts.reads,
            elapsed_ms = elapsed.as_millis() as u64,
            "swept session metadata stamps"
        );
        if elapsed.as_millis() >= 1000 {
            tracing::warn!(
                event = "session_catalog_slow",
                scoped = scope.is_some(),
                homes = counts.homes,
                listings = counts.listings,
                stats = counts.stats,
                metadata_read = counts.reads,
                lock_wait_ms = lock_wait.as_millis() as u64,
                yield_wait_ms = yield_wait.as_millis() as u64,
                inline_ms = elapsed
                    .saturating_sub(yield_wait)
                    .saturating_sub(lock_wait)
                    .as_millis() as u64,
                elapsed_ms = elapsed.as_millis() as u64,
                "session metadata sweep exceeded one second"
            );
            workload.report(elapsed, yield_wait);
        }
        Ok(true)
    }

    async fn sweep_home(
        &self,
        plan: HomePlan,
        budget: &mut crate::blocking::WorkBudget,
        yield_wait: &mut std::time::Duration,
        counts: &mut SweepCounts,
    ) -> HomeLooked {
        use crate::fs_stamp::settled;
        counts.homes += 1;
        let scopes: Vec<String> = plan.projects.iter().map(|(id, _)| id.clone()).collect();
        let owners = home_owners(&plan.projects);
        let fresh = plan.prior.is_none();
        let mut seen = plan.prior.unwrap_or_else(|| HomeSeen {
            owners: owners.clone(),
            listing: None,
            sessions: Default::default(),
            tombstones: None,
            deleted: Default::default(),
        });
        seen.owners = owners;
        let tombstones_dir = plan.sessions.with_file_name(TOMBSTONES_DIR);
        if fresh {
            if let Some(home) = plan.sessions.parent().filter(|home| home.exists()) {
                let _ = self.establish_home(home);
            }
        }
        let mut reap_pending = false;
        let mut looked = Vec::new();
        if plan.tombstones {
            counts.stats += 1;
            let stamp = MetadataStamp::read(&tombstones_dir);
            if fresh || stamp != seen.tombstones || !settled(seen.tombstones.as_ref()) {
                counts.listings += 1;
                seen.deleted = tombstone_names(&tombstones_dir);
            }
            seen.tombstones = stamp;
            // Files of a deleted session wait for their writer; retry until
            // they are gone, on every pass that looks at tombstones.
            if let Some((workspace, _)) = plan.projects.first() {
                let waiting: Vec<String> = seen
                    .deleted
                    .iter()
                    .filter(|id| fresh || seen.sessions.contains(*id))
                    .cloned()
                    .collect();
                for id in waiting {
                    let dir = plan.sessions.join(&id);
                    looked.push((dir.join("meta.json"), None, Look::Deleted));
                    self.reap_tombstoned_session(workspace, &id, &dir);
                    if dir.exists() {
                        reap_pending = true;
                    } else {
                        seen.sessions.remove(&id);
                    }
                }
            }
        }
        let mut listing_error = None;
        let mut entries = plan.entries;
        let (listed, tombstones_looked) = (plan.list, plan.tombstones);
        if plan.list {
            counts.stats += 1;
            let stamp = MetadataStamp::read(&plan.sessions);
            if fresh || stamp != seen.listing || !settled(seen.listing.as_ref()) {
                counts.listings += 1;
                let listed = {
                    let _work = crate::diagnostics::work::FileScope::new(
                        crate::diagnostics::work::FileWork::CatalogDirectory,
                    );
                    fs::read_dir(&plan.sessions).map(|entries| {
                        entries
                            .flatten()
                            .map(|entry| entry.file_name().to_string_lossy().into_owned())
                            .collect::<std::collections::BTreeSet<_>>()
                    })
                };
                let listed = match listed {
                    Ok(listed) => Some(listed),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Default::default()),
                    Err(e) => {
                        listing_error =
                            Some((scopes.clone(), format!("reading session directory: {e}")));
                        None
                    }
                };
                if let Some(listed) = listed {
                    for gone in seen.sessions.difference(&listed) {
                        looked.push((plan.sessions.join(gone).join("meta.json"), None, Look::Gone));
                    }
                    let known: HashSet<&String> = entries.iter().map(|(id, _, _)| id).collect();
                    let added: Vec<String> = listed
                        .iter()
                        .filter(|id| fresh || !seen.sessions.contains(*id))
                        .filter(|id| !known.contains(id))
                        .cloned()
                        .collect();
                    entries.extend(added.into_iter().map(|id| (id, None, false)));
                    seen.sessions = listed;
                    seen.listing = stamp;
                }
            }
        }
        for (id, prior, trusted) in entries {
            *yield_wait += budget.checkpoint().await;
            let path = plan.sessions.join(&id).join("meta.json");
            if !seen.sessions.contains(&id) {
                looked.push((path, None, Look::Gone));
                continue;
            }
            if seen.deleted.contains(&id) {
                looked.push((path, None, Look::Deleted));
                continue;
            }
            counts.stats += 1;
            let stamp = {
                let _work = crate::diagnostics::work::FileScope::new(
                    crate::diagnostics::work::FileWork::CatalogEntry,
                );
                MetadataStamp::read(&path)
            };
            if stamp.is_none() {
                looked.push((path, None, Look::Missing));
                continue;
            }
            if stamp == prior && (trusted || settled(prior.as_ref())) {
                looked.push((path, stamp, Look::Same));
                continue;
            }
            // A tombstone written since the last listing of tombstones/ wins.
            if tombstones_dir.join(format!("{id}.json")).exists() {
                seen.deleted.insert(id);
                looked.push((path, None, Look::Deleted));
                continue;
            }
            counts.reads += 1;
            match self.read_catalog_file(&plan.projects, &id, &path, stamp) {
                Some(file) => looked.push((path, stamp, Look::Changed(file))),
                None => looked.push((path, None, Look::Missing)),
            }
        }
        HomeLooked {
            sessions: plan.sessions,
            scopes,
            seen,
            listing_error,
            reap_pending,
            listed,
            tombstones_looked,
            looked,
        }
    }

    /// Reads and normalizes one `meta.json`. `None` when it is not there.
    fn read_catalog_file(
        &self,
        projects: &[(String, WorkspaceHome)],
        session_id: &str,
        path: &Path,
        stamp: Option<MetadataStamp>,
    ) -> Option<CatalogFile> {
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                return Some(CatalogFile {
                    stamp,
                    meta: None,
                    error: Some(format!("reading session metadata: {e}")),
                    changed: 0,
                });
            }
        };
        let parsed = (|| -> Result<Option<SessionMeta>> {
            let header: MetaHeader =
                serde_json::from_str(&raw).context("parsing session metadata header")?;
            let Some(owner) = Self::metadata_owner(projects, &header.project_key) else {
                return Ok(None);
            };
            self.load_meta_from(&owner, session_id, &raw, header)
                .context("parsing session metadata")
                .map(Some)
        })();
        Some(match parsed {
            Ok(meta) => CatalogFile {
                stamp,
                meta: meta.map(Arc::new),
                error: None,
                changed: 0,
            },
            Err(error) => CatalogFile {
                stamp,
                meta: None,
                error: Some(format!("{error:#}")),
                changed: 0,
            },
        })
    }

    async fn fresh_metadata_scan(&self, workspace: Option<&str>) -> Result<Arc<CatalogScan>> {
        crate::blocking::coalesce(
            &self.catalog_reads,
            workspace.map(str::to_owned),
            || async { self.scan_metadata(workspace).await.map(Arc::new) },
        )
        .await
    }

    async fn scan_metadata(&self, workspace: Option<&str>) -> Result<CatalogScan> {
        let started = std::time::Instant::now();
        let workload = crate::diagnostics::work::Window::start();
        let mut yield_wait = std::time::Duration::ZERO;
        let mut max_yield = std::time::Duration::ZERO;
        let mut directories = 0usize;
        let mut entries_read = 0usize;
        let mut metadata_read = 0usize;
        let mut budget = crate::blocking::WorkBudget::new();
        let mut out = CatalogScan::default();
        for (workspaces, sessions) in self.homes.session_dirs_for(workspace) {
            directories += 1;
            let scopes: Vec<_> = workspaces.iter().map(|(id, _)| id.clone()).collect();
            let waited = budget.checkpoint().await;
            yield_wait += waited;
            max_yield = max_yield.max(waited);
            // Stamps are taken before the listings they describe, so a change
            // made while listing shows up as a changed stamp next time.
            let tombstones_dir = sessions.with_file_name(TOMBSTONES_DIR);
            let tombstones = MetadataStamp::read(&tombstones_dir);
            let deleted = tombstone_names(&tombstones_dir);
            if let Some((id, _)) = workspaces.first() {
                for session_id in &deleted {
                    self.reap_tombstoned_session(id, session_id, &sessions.join(session_id));
                }
            }
            if let Some(home) = sessions.parent().filter(|home| home.exists()) {
                let _ = self.establish_home(home);
            }
            let listing = MetadataStamp::read(&sessions);
            let mut seen = HomeSeen {
                owners: home_owners(&workspaces),
                listing,
                sessions: Default::default(),
                tombstones,
                deleted,
            };
            let directory = {
                let _work = crate::diagnostics::work::FileScope::new(
                    crate::diagnostics::work::FileWork::CatalogDirectory,
                );
                fs::read_dir(&sessions)
            };
            let entries = match directory {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    out.homes.insert(sessions, seen);
                    continue;
                }
                Err(e) => {
                    out.errors.insert(
                        sessions,
                        (scopes, format!("reading session directory: {e}")),
                    );
                    continue;
                }
            };
            let mut complete = true;
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(e) => {
                        complete = false;
                        out.errors.insert(
                            sessions.clone(),
                            (scopes.clone(), format!("reading session entry: {e}")),
                        );
                        continue;
                    }
                };
                entries_read += 1;
                let waited = budget.checkpoint().await;
                yield_wait += waited;
                max_yield = max_yield.max(waited);
                let _work = crate::diagnostics::work::FileScope::new(
                    crate::diagnostics::work::FileWork::CatalogEntry,
                );
                let session_id = entry.file_name().to_string_lossy().into_owned();
                seen.sessions.insert(session_id.clone());
                if seen.deleted.contains(&session_id) {
                    continue;
                }
                let path = entry.path().join("meta.json");
                let stamp = MetadataStamp::read(&path);
                if stamp.is_none() {
                    continue;
                }
                metadata_read += 1;
                let Some(file) = self.read_catalog_file(&workspaces, &session_id, &path, stamp)
                else {
                    continue;
                };
                if let Some(error) = &file.error {
                    out.errors
                        .insert(path.clone(), (scopes.clone(), error.clone()));
                }
                out.files.insert(path, file);
            }
            if complete {
                out.homes.insert(sessions, seen);
            }
        }
        let count = out.files.values().filter(|f| f.meta.is_some()).count();
        tracing::debug!(
            event = "session_catalog_reconciled",
            scoped = workspace.is_some(),
            directories,
            entries_read,
            metadata_read,
            sessions = count,
            errors = out.errors.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "reconciled session metadata signatures"
        );
        if started.elapsed().as_millis() >= 1000 {
            tracing::warn!(
                event = "session_catalog_slow",
                scoped = workspace.is_some(),
                directories,
                entries_read,
                metadata_read,
                sessions = count,
                yield_wait_ms = yield_wait.as_millis() as u64,
                max_yield_ms = max_yield.as_millis() as u64,
                inline_ms = started.elapsed().saturating_sub(yield_wait).as_millis() as u64,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "session metadata enumeration exceeded one second"
            );
            workload.report(started.elapsed(), yield_wait);
        }
        Ok(out)
    }

    /// Locate the requested conversation by its directory, without reading
    /// every other conversation. Project keys and tombstones still decide
    /// whether a registered view can expose that directory.
    pub async fn find_meta(&self, session_id: &str) -> Result<Option<SessionMeta>> {
        if session_id.is_empty()
            || session_id.contains(['/', '\\'])
            || !matches!(
                Path::new(session_id).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Ok(None);
        }
        // Indexed homes are first, but a compatible writer may have placed a
        // newer copy in another registered home. Read only this ID's direct
        // path there; never open unrelated conversation files.
        let indexed: Vec<PathBuf> = self
            .page_catalog
            .lock()
            .ok()
            .filter(|cache| cache.initialized)
            .and_then(|cache| cache.by_id.get(session_id).cloned())
            .unwrap_or_default();
        let mut homes = self.homes.all_sessions_dirs();
        homes.sort_by_key(|(_, sessions)| {
            !indexed
                .iter()
                .any(|path| path.parent().and_then(Path::parent) == Some(sessions.as_path()))
        });
        self.find_meta_in(session_id, homes).await
    }

    async fn find_meta_in(
        &self,
        session_id: &str,
        homes: Vec<(Vec<(String, WorkspaceHome)>, PathBuf)>,
    ) -> Result<Option<SessionMeta>> {
        let mut found: Option<SessionMeta> = None;
        let mut budget = crate::blocking::WorkBudget::new();
        for (workspaces, sessions) in homes {
            budget.checkpoint().await;
            let Some(home) = sessions.parent() else {
                continue;
            };
            if home
                .join(TOMBSTONES_DIR)
                .join(format!("{session_id}.json"))
                .exists()
            {
                continue;
            }
            let Ok(raw) = fs::read_to_string(sessions.join(session_id).join("meta.json")) else {
                continue;
            };
            let Ok(header) = serde_json::from_str::<MetaHeader>(&raw) else {
                continue;
            };
            let Some(workspace_id) = Self::metadata_owner(&workspaces, &header.project_key) else {
                continue;
            };
            let _ = self.establish_home(home);
            match self.load_meta_from(&workspace_id, session_id, &raw, header) {
                Ok(meta) if meta.id == session_id => {
                    // A copied project may retain the same conversation ID.
                    // Match the newest-first catalog's existing tie-breaking.
                    if found
                        .as_ref()
                        .is_none_or(|known| meta.updated_at_ms > known.updated_at_ms)
                    {
                        found = Some(meta);
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(session = %session_id, %error, "skipping a session whose meta could not be read")
                }
            }
        }
        Ok(found)
    }

    fn metadata_owner(workspaces: &[(String, WorkspaceHome)], project_key: &str) -> Option<String> {
        if project_key.is_empty() {
            workspaces.first().map(|(id, _)| id.clone())
        } else {
            workspaces
                .iter()
                .find(|(_, home)| {
                    home.project_key == project_key
                        || home.aliases.iter().any(|alias| alias == project_key)
                })
                .map(|(id, _)| id.clone())
        }
    }

    fn reap_tombstoned_session(&self, workspace_id: &str, session_id: &str, dir: &Path) {
        if !dir.exists() {
            return;
        }
        let Ok(home) = self.homes.home_dir(workspace_id) else {
            return;
        };
        if let Err(error) = self.homes.claim_compatibility(workspace_id, &home) {
            tracing::warn!(event = "session_cleanup_deferred", reason = "legacy_writer", workspace = %workspace_id, session = %session_id, %error, "deleted session cleanup is waiting for an older GeneHub");
            return;
        }
        if !self.homes.holds(workspace_id, session_id) {
            if let Err(error) = self.homes.claim(workspace_id, session_id, dir) {
                tracing::warn!(event = "session_cleanup_deferred", reason = "session_writer", workspace = %workspace_id, session = %session_id, %error, "deleted session cleanup is waiting for its writer");
                return;
            }
        }
        if let Err(error) = self.homes.release(workspace_id, session_id) {
            tracing::warn!(event = "session_cleanup_deferred", reason = "lock_release", workspace = %workspace_id, session = %session_id, %error, "could not release deleted session before cleanup");
            return;
        }
        match fs::remove_dir_all(dir) {
            Ok(()) => tracing::info!(
                event = "session_cleanup_succeeded",
                workspace = %workspace_id,
                session = %session_id,
                "removed files left by a logically deleted session"
            ),
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(event = "session_cleanup_deferred", reason = "filesystem", workspace = %workspace_id, session = %session_id, %error, "deleted session is still awaiting physical cleanup");
                }
            }
        }
    }

    // -- chat layer ---------------------------------------------------------

    /// Appends settled narrative items. Existing lines are never rewritten, so
    /// a crash can lose the tail but cannot corrupt what came before.
    ///
    /// Tool calls and reasoning are rejected rather than silently dropped:
    /// they belong to a round's trunk files, and a caller that sends one here
    /// has a bug that would otherwise show up much later as a session whose
    /// narrative mysteriously contains work.
    pub fn append_chat_items(
        &self,
        workspace_id: &str,
        session_id: &str,
        items: &[TimelineItem],
    ) -> Result<()> {
        let rows: Vec<ChatRow> = items
            .iter()
            .filter(|item| !is_work_item(item))
            .map(|item| ChatRow::Item { item: item.clone() })
            .collect();
        self.append_chat_rows(workspace_id, session_id, &rows)
    }

    /// Records a round's current state. Called twice per round — once when it
    /// opens, once when it settles — and read last-wins per `roundId`.
    pub fn append_round(
        &self,
        workspace_id: &str,
        session_id: &str,
        record: &RoundRecord,
    ) -> Result<()> {
        self.append_chat_rows(
            workspace_id,
            session_id,
            &[ChatRow::Round {
                round: record.clone(),
            }],
        )
    }

    fn append_chat_rows(
        &self,
        workspace_id: &str,
        session_id: &str,
        rows: &[ChatRow],
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let path = self.chat_path(workspace_id, session_id)?;
        self.prepare_write(
            workspace_id,
            session_id,
            path.parent().expect("chat.jsonl always has a parent"),
        )?;
        let mut file = crate::config::open_append(&path)?;
        crate::config::restrict_to_owner(&path)?;
        // Separate a previous interrupted append from this batch. Empty lines
        // are ignored on load; an incomplete JSON row must not swallow a retry.
        writeln!(file)?;
        for row in rows {
            writeln!(file, "{}", serde_json::to_string(row)?)?;
        }
        file.flush()?;
        file.sync_all()?;
        // As with save_private, directory syncing depends on the host OS
        // (including when this code runs as WASI on Windows). File contents
        // must sync successfully; directory sync is attempted where supported.
        if let Ok(directory) = File::open(path.parent().expect("chat has a parent")) {
            let _ = directory.sync_all();
        }
        Ok(())
    }

    /// Reads the chat layer back, skipping lines that do not parse.
    ///
    /// A single bad line — a half-written record from a power cut, or a record
    /// from a newer version — must not make the whole conversation unopenable.
    pub fn load_chat(&self, workspace_id: &str, session_id: &str) -> Result<ChatLog> {
        let path = self.chat_path(workspace_id, session_id)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ChatLog::default()),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut log = ChatLog::default();
        let mut item_positions = HashMap::<String, usize>::new();
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ChatRow>(&line) {
                Ok(ChatRow::Item { item }) => {
                    // A failed append may have written complete rows before
                    // returning an error. Retrying preserves one item per id.
                    match item_positions.get(item.id()) {
                        Some(&position) => log.items[position] = item,
                        None => {
                            item_positions.insert(item.id().to_string(), log.items.len());
                            log.items.push(item);
                        }
                    }
                }
                Ok(ChatRow::Round { round }) => {
                    match log
                        .rounds
                        .iter_mut()
                        .find(|existing| existing.round_id == round.round_id)
                    {
                        Some(existing) => *existing = round,
                        None => log.rounds.push(round),
                    }
                }
                Err(error) => tracing::warn!(
                    "skipping unreadable line {} of {}: {error}",
                    index + 1,
                    path.display()
                ),
            }
        }
        log.rounds.sort_by_key(|round| round.ord);
        Ok(log)
    }

    // -- the turn in progress -----------------------------------------------

    /// Where the narrative of an unfinished turn waits.
    ///
    /// `chat.jsonl` is append-only and is written when a turn ends, which is
    /// the right home for a settled conversation and the wrong one for a turn
    /// that has not settled: the same growing answer cannot be appended
    /// repeatedly without appearing repeatedly. This file is rewritten whole
    /// instead — the last write is the truth, exactly as for a trunk — and is
    /// removed once the turn ends and its items reach the log for good.
    ///
    /// What it buys is a bound. Without it a daemon that dies mid-answer costs
    /// the reader everything they had already read; with it, the last moment
    /// of it.
    fn open_turn_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("open-turn.jsonl"))
    }

    pub fn write_open_turn(
        &self,
        workspace_id: &str,
        session_id: &str,
        items: &[TimelineItem],
    ) -> Result<()> {
        let path = self.open_turn_path(workspace_id, session_id)?;
        self.prepare_write(
            workspace_id,
            session_id,
            path.parent().expect("open-turn.jsonl always has a parent"),
        )?;
        let mut body = Vec::new();
        for item in items.iter().filter(|item| !is_work_item(item)) {
            writeln!(
                body,
                "{}",
                serde_json::to_string(&ChatRow::Item { item: item.clone() })?
            )?;
        }
        crate::config::save_private(&path, &body)
    }

    /// Missing is empty; unreadable is an error. An unreadable recovery copy
    /// cannot safely be replaced by the next execution's checkpoint.
    pub fn load_open_turn(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Vec<TimelineItem>> {
        let path = self.open_turn_path(workspace_id, session_id)?;
        let contents = match std::fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(error)
                    .context("reading the interrupted answer before accepting new writes");
            }
        };
        contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| match serde_json::from_str::<ChatRow>(line)? {
                ChatRow::Item { item } => Ok(item),
                _ => anyhow::bail!("unexpected row in the interrupted answer"),
            })
            .collect()
    }

    pub fn clear_open_turn(&self, workspace_id: &str, session_id: &str) {
        if let Ok(path) = self.open_turn_path(workspace_id, session_id) {
            let _ = std::fs::remove_file(path);
        }
    }

    // -- round layer --------------------------------------------------------

    /// Writes one trunk in full and records its summary.
    ///
    /// A trunk file is always written whole rather than appended to, so it is
    /// never half a trunk: the open trunk is rewritten at each turn boundary
    /// and the last write is the settled one. At a hundred rows the rewrite is
    /// a few tens of kilobytes, which is cheaper than the bookkeeping needed to
    /// append safely across turn boundaries.
    pub fn write_trunk(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        trunk: &RoundTrunk,
    ) -> Result<()> {
        self.write_trunk_for_round(workspace_id, session_id, ord, None, &HashMap::new(), trunk)
    }

    pub fn write_trunk_for_round(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        round_id: Option<&str>,
        blob_search_hints: &HashMap<String, super::rounds::BlobSearchHint>,
        trunk: &RoundTrunk,
    ) -> Result<()> {
        let dir = self.round_dir(workspace_id, session_id, ord)?;
        self.prepare_write(workspace_id, session_id, &dir)?;
        let mut body = Vec::new();
        for batch in &trunk.batches {
            writeln!(
                body,
                "{}",
                serde_json::to_string(&TrunkRow::Batch {
                    index: batch.summary.index,
                    first_item_id: batch.summary.first_item_id.clone(),
                    blob_count: batch.summary.blob_count,
                    text: batch.summary.text.clone(),
                    round_id: round_id.map(str::to_string),
                    monologue: batch.monologue.clone(),
                    marker: batch.summary.marker.clone(),
                    llm_rounds: batch.summary.llm_rounds,
                    started_at_ms: batch.summary.started_at_ms,
                    duration_ms: batch.summary.duration_ms,
                    tool_duration_ms: batch.summary.tool_duration_ms,
                })?
            )?;
            for blob in &batch.blobs {
                let hint = blob_search_hints.get(&blob.item_id);
                let overview = hint
                    .and_then(|h| h.overview.clone())
                    .unwrap_or_else(|| blob.overview.clone());
                let input = hint.and_then(|h| h.input.clone());
                let output = hint.and_then(|h| h.output.clone());
                writeln!(
                    body,
                    "{}",
                    serde_json::to_string(&TrunkRow::Blob {
                        item_id: blob.item_id.clone(),
                        kind: blob.kind,
                        overview,
                        input,
                        output,
                        blob: blob.blob.clone(),
                        thumb: blob.thumb.clone(),
                        path: blob.path.clone(),
                        started_at_ms: blob.started_at_ms,
                        duration_ms: blob.duration_ms,
                        tool_kind: blob.tool_kind,
                        status: blob.status,
                    })?
                )?;
            }
        }
        let path = self.trunk_path(workspace_id, session_id, ord, trunk.summary.index)?;
        crate::config::save_private(&path, &body)?;
        self.append_trunk_summary(workspace_id, session_id, ord, round_id, &trunk.summary)
    }

    fn append_trunk_summary(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        round_id: Option<&str>,
        summary: &RoundTrunkSummary,
    ) -> Result<()> {
        let path = self.trunk_index_path(workspace_id, session_id, ord)?;
        self.prepare_write(
            workspace_id,
            session_id,
            path.parent().expect("index.jsonl always has a parent"),
        )?;
        let mut value = serde_json::to_value(summary)?;
        if let (Some(round_id), Some(obj)) = (round_id, value.as_object_mut()) {
            obj.insert(
                "roundId".to_string(),
                serde_json::Value::String(round_id.to_string()),
            );
        }
        // Upsert by trunk index: an open trunk is rewritten by each periodic
        // checkpoint, and appending would leave several rows naming the same
        // file. The index is one small file per round.
        let index = summary.index as u64;
        let mut body = Vec::new();
        match std::fs::read_to_string(&path) {
            Ok(existing) => {
                for line in existing.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let same_index = serde_json::from_str::<serde_json::Value>(line)
                        .ok()
                        .and_then(|row| row.get("index").and_then(serde_json::Value::as_u64))
                        == Some(index);
                    if !same_index {
                        writeln!(body, "{line}")?;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                // A readable index is the only copy of earlier trunks. Treating
                // an I/O error as "empty" would overwrite them with nothing.
                return Err(error)
                    .with_context(|| format!("reading {} before rewriting it", path.display()));
            }
        }
        writeln!(body, "{}", serde_json::to_string(&value)?)?;
        // The trunk body is already fsynced; save_private fsyncs the index too.
        crate::config::save_private(&path, &body)?;
        Ok(())
    }

    /// One round's trunk index, last write per trunk index winning.
    pub fn load_trunk_index(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
    ) -> Result<Vec<RoundTrunkSummary>> {
        let path = self.trunk_index_path(workspace_id, session_id, ord)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut summaries: Vec<RoundTrunkSummary> = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let Ok(summary) = serde_json::from_str::<RoundTrunkSummary>(&line) else {
                tracing::warn!("skipping unreadable trunk index line in {}", path.display());
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

    /// One trunk's batches. The summary comes from the caller's index read, so
    /// this touches exactly one small file.
    pub fn load_trunk(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        summary: &RoundTrunkSummary,
    ) -> Result<RoundTrunk> {
        let path = self.trunk_path(workspace_id, session_id, ord, summary.index)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RoundTrunk {
                    summary: summary.clone(),
                    batches: Vec::new(),
                });
            }
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut batches: Vec<RoundBatch> = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<TrunkRow>(&line) {
                Ok(TrunkRow::Batch {
                    index,
                    first_item_id,
                    blob_count,
                    text,
                    round_id: _,
                    monologue,
                    marker,
                    llm_rounds,
                    started_at_ms,
                    duration_ms,
                    tool_duration_ms,
                }) => batches.push(RoundBatch {
                    summary: RoundBatchSummary {
                        index,
                        first_item_id,
                        blob_count,
                        text,
                        marker,
                        llm_rounds,
                        started_at_ms,
                        duration_ms,
                        tool_duration_ms,
                    },
                    monologue,
                    blobs: Vec::new(),
                }),
                Ok(TrunkRow::Blob {
                    item_id,
                    kind,
                    overview,
                    input: _,
                    output: _,
                    blob,
                    thumb,
                    path,
                    started_at_ms,
                    duration_ms,
                    tool_kind,
                    status,
                }) => {
                    // A blob row before any batch row means a truncated write.
                    // Attaching it to a synthetic batch keeps the content
                    // visible instead of silently dropping it.
                    if batches.is_empty() {
                        batches.push(RoundBatch {
                            summary: RoundBatchSummary {
                                index: 0,
                                first_item_id: item_id.clone(),
                                blob_count: 0,
                                text: String::new(),
                                marker: None,
                                llm_rounds: None,
                                started_at_ms: None,
                                duration_ms: None,
                                tool_duration_ms: None,
                            },
                            monologue: None,
                            blobs: Vec::new(),
                        });
                    }
                    batches
                        .last_mut()
                        .expect("just ensured non-empty")
                        .blobs
                        .push(BlobOverview {
                            item_id,
                            kind,
                            overview,
                            blob,
                            thumb,
                            path,
                            started_at_ms,
                            duration_ms,
                            tool_kind,
                            status,
                        });
                }
                Err(error) => {
                    tracing::warn!(
                        "skipping unreadable trunk row in {}: {error}",
                        path.display()
                    )
                }
            }
        }
        let batches = rounds::split_produced_image_batches(batches);
        let mut summary = summary.clone();
        summary.batches = batches.iter().map(|batch| batch.summary.clone()).collect();
        Ok(RoundTrunk { summary, batches })
    }

    // -- blob layer ---------------------------------------------------------

    /// Stores canonical JSON by content id, returning a reference that already
    /// knows where the bytes are.
    ///
    /// The returned `at` is what makes reads a seek instead of a scan; nothing
    /// else indexes blobs, so the row that keeps this reference is the index.
    ///
    /// Content addressing here buys immutability and a stable name, not
    /// deduplication: every payload embeds the id of the item it belongs to, so
    /// two different items never hash alike and there is nothing to fold
    /// together. An append that repeats content costs disk and nothing else,
    /// because each reference is complete on its own.
    pub fn put_blob(&self, workspace_id: &str, session_id: &str, value: Value) -> Result<BlobRef> {
        let encoded = serde_json::to_vec(&value)?;
        let digest = Sha256::digest(&encoded);
        let id: String = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            .chars()
            .take(BLOB_ID_CHARS)
            .collect();
        let bucket = id[..2].to_string();
        let dir = self.blob_dir(workspace_id, session_id)?;
        self.prepare_write(workspace_id, session_id, &dir)?;
        let path = dir.join(format!("b-{bucket}.jsonl"));
        let line = serde_json::to_vec(&BlobRecord {
            id: id.clone(),
            value,
        })?;
        let mut file = crate::config::open_append(&path)?;
        crate::config::restrict_to_owner(&path)?;
        let offset = file.metadata()?.len();
        file.write_all(&line)?;
        file.write_all(b"\n")?;
        file.flush()?;
        // The trunk row that points at this offset is fsynced; without this
        // the reference can survive a power loss while the bytes it names do
        // not. Measured at ~0.6ms per blob on the data volume.
        file.sync_all()?;
        Ok(BlobRef {
            id,
            bytes: encoded.len() as u64,
            at: format!("{bucket}:{offset}:{}", line.len()),
        })
    }

    /// Resolves a reference: one seek, one bounded read, one parse.
    ///
    /// The locator arrives from a client, so it is treated as untrusted input.
    /// It cannot reach outside this session — the bucket is two hex characters
    /// — but it can still name a nonsense range, and the id read back must
    /// match the id asked for before the payload is handed over.
    pub fn get_blob(
        &self,
        workspace_id: &str,
        session_id: &str,
        blob: &BlobRef,
    ) -> Result<Option<BlobPayload>> {
        let Some((bucket, offset, length)) = parse_locator(&blob.at) else {
            return Ok(None);
        };
        if !is_blob_id(&blob.id) || length == 0 || length > MAX_BLOB_BYTES {
            return Ok(None);
        }
        let path = self
            .blob_dir(workspace_id, session_id)?
            .join(format!("b-{bucket}.jsonl"));
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        if offset.saturating_add(length) > file.metadata()?.len() {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut buffer = vec![0u8; length as usize];
        file.read_exact(&mut buffer)?;
        let Ok(record) = serde_json::from_slice::<BlobRecord>(&buffer) else {
            return Ok(None);
        };
        if record.id != blob.id {
            return Ok(None);
        }
        Ok(Some(BlobPayload {
            id: record.id,
            value: record.value,
        }))
    }

    // -- lifecycle ----------------------------------------------------------

    /// Removes every trace of a session from disk.
    ///
    /// The scratch directory goes with the rest. It is where adapters keep a
    /// CLI's own idea of the conversation — a `--resume` id, a thread file —
    /// and leaving it behind would mean a deleted conversation still exists
    /// inside the agent, which is not what anyone means by "delete".
    ///
    /// Missing files are not an error: this is also the cleanup path for a
    /// session that never got as far as being written.
    pub fn delete(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        self.invalidate_page_catalog();
        let dir = self.raw_session_dir(workspace_id, session_id)?;
        let tombstone = self.tombstone_path(workspace_id, session_id)?;
        if tombstone.exists() {
            self.forget_catalog_session(workspace_id, session_id);
            self.reap_tombstoned_session(workspace_id, session_id, &dir);
            return Ok(());
        }
        if !dir.exists() {
            self.forget_catalog_session(workspace_id, session_id);
            return Ok(());
        }
        let home = self.homes.home_dir(workspace_id)?;
        self.establish_home(&home)?;
        self.homes.claim_compatibility(workspace_id, &home)?;
        if !self.homes.holds(workspace_id, session_id) {
            self.homes.claim(workspace_id, session_id, &dir)?;
        }
        let tombstones = tombstone
            .parent()
            .expect("a tombstone path always has a parent");
        fs::create_dir_all(tombstones)
            .with_context(|| format!("creating {}", tombstones.display()))?;
        crate::config::restrict_dir_to_owner(tombstones)?;
        let marker = serde_json::json!({
            "sessionId": session_id,
            "deletedAtMs": now_ms(),
        });
        crate::config::save_private(&tombstone, serde_json::to_vec_pretty(&marker)?.as_slice())?;
        self.invalidate_page_catalog();
        self.forget_catalog_session(workspace_id, session_id);
        tracing::info!(
            event = "session_tombstoned",
            workspace = %workspace_id,
            session = %session_id,
            "session was logically deleted"
        );

        // The durable marker is the atomic logical deletion. Releasing the
        // Windows lock before unlinking is now safe: every future claimant
        // rejects the tombstone after it acquires writer.lock.
        self.homes.release(workspace_id, session_id)?;
        if let Err(error) = fs::remove_dir_all(&dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(event = "session_cleanup_deferred", reason = "filesystem", workspace = %workspace_id, session = %session_id, %error, "session was deleted logically but awaits physical cleanup");
            }
        } else {
            tracing::info!(
                event = "session_cleanup_succeeded",
                workspace = %workspace_id,
                session = %session_id,
                "removed files for a logically deleted session"
            );
        }
        Ok(())
    }
}

/// Tool calls and reasoning belong to the round layer, never to the narrative.
pub fn is_work_item(item: &TimelineItem) -> bool {
    matches!(
        item,
        TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
    )
}

fn is_blob_id(id: &str) -> bool {
    id.len() == BLOB_ID_CHARS && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_locator(at: &str) -> Option<(String, u64, u64)> {
    let mut parts = at.split(':');
    let bucket = parts.next()?;
    let offset = parts.next()?.parse().ok()?;
    let length = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if bucket.len() != 2 || !bucket.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((bucket.to_string(), offset, length))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A first line of user text, trimmed into something that fits a sidebar.
///
/// `None` when there is nothing to name it after; the session stays untitled
/// rather than being called something in a language nobody chose.
pub fn title_from(text: &str) -> Option<String> {
    let first = text.lines().find(|line| !line.trim().is_empty())?;
    let trimmed: String = first.trim().chars().take(60).collect();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Session name for a prompt. A forward is named after its source sessions,
/// `转发自「原会话名」`, instead of the envelope tag on the first line.
pub fn prompt_title(text: &str) -> Option<String> {
    let names = forward_source_names(text);
    if names.is_empty() {
        return title_from(text);
    }
    let labeled = names
        .into_iter()
        .map(|name| format!("「{name}」"))
        .collect::<Vec<_>>()
        .join("、");
    title_from(&format!("转发自{labeled}"))
}

fn forward_source_names(text: &str) -> Vec<String> {
    const OPEN: &str = "<genehub-chat-history>";
    const CLOSE: &str = "</genehub-chat-history>";
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let (body, next) = match after.find(CLOSE) {
            Some(end) => (&after[..end], &after[end + CLOSE.len()..]),
            None => (after, ""),
        };
        if let Some(name) = source_name_in_capsule(body) {
            names.push(name);
        }
        if next.is_empty() {
            break;
        }
        rest = next;
    }
    names
}

fn source_name_in_capsule(body: &str) -> Option<String> {
    let mut session = None;
    for line in body.lines() {
        let line = line.trim();
        if let Some(title) = line.strip_prefix("Source title:") {
            let title = title.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
        if session.is_none() {
            if let Some(id) = line.strip_prefix("Source session:") {
                let id = id.trim();
                if !id.is_empty() {
                    session = Some(id.to_string());
                }
            }
        }
    }
    session
}

/// Trim a session name to the same length `rename` accepts.
///
/// Empty after trim stays `None` so an Agent cannot blank a title with
/// whitespace. ACP `title: null` never arrives here as a string.
pub fn normalize_session_title(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(120).collect())
}

/// How many unhandled inputs a session accepts before it refuses more.
pub const MAX_PENDING_INPUTS: usize = 32;

/// A description is read by other Agents to decide whom to ask, so it stays one
/// short line: roughly what a Skill description is.
pub const MAX_SESSION_DESCRIPTION_BYTES: usize = 300;

/// Trims a description and checks it is one short line. Empty clears it.
///
/// The bound is in bytes, like the other Agent-facing text limits, so a line of
/// Chinese gets about a hundred characters rather than three hundred.
pub fn normalize_session_description(text: &str) -> Result<Option<String>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() > MAX_SESSION_DESCRIPTION_BYTES {
        return Err(format!(
            "a session description is at most {MAX_SESSION_DESCRIPTION_BYTES} bytes; this one is {}",
            text.len()
        ));
    }
    if text.chars().any(char::is_control) {
        return Err("a session description is one line without control characters".into());
    }
    Ok(Some(text.to_string()))
}

/// The label on a session that another session created. Four characters, well
/// inside the label limit; the default conversation list reads it to leave such
/// sessions out.
pub const SESSION_STARTED_LABEL: &str = "系统发起";

pub const MAX_SESSION_LABEL_CHARS: usize = 10;
pub const MAX_SESSION_LABELS: usize = 16;

/// Removes, then adds, labels on top of `current`, keeping first-added order.
///
/// Labels are trimmed and compared exactly. Removing an absent label is a
/// no-op, so a retried relabel converges instead of failing.
pub fn apply_session_labels(
    current: &[String],
    add: &[String],
    remove: &[String],
) -> Result<Vec<String>, String> {
    let mut labels: Vec<String> = current
        .iter()
        .filter(|label| !remove.iter().any(|gone| gone.trim() == label.as_str()))
        .cloned()
        .collect();
    for raw in add {
        let label = raw.trim();
        if label.is_empty() {
            return Err("a session label cannot be empty".into());
        }
        if label.chars().count() > MAX_SESSION_LABEL_CHARS {
            return Err(format!(
                "session label '{label}' is longer than {MAX_SESSION_LABEL_CHARS} characters"
            ));
        }
        if label.chars().any(char::is_control) {
            return Err("a session label cannot contain control characters".into());
        }
        if !labels.iter().any(|existing| existing == label) {
            labels.push(label.to_string());
        }
    }
    if labels.len() > MAX_SESSION_LABELS {
        return Err(format!(
            "a session can have at most {MAX_SESSION_LABELS} labels"
        ));
    }
    Ok(labels)
}

fn has_cjk(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch,
            '\u{4E00}'..='\u{9FFF}'
                | '\u{3400}'..='\u{4DBF}'
                | '\u{F900}'..='\u{FAFF}'
                | '\u{3040}'..='\u{30FF}'
        )
    })
}

/// Cursor often auto-names in English. Keep the first-prompt title when the
/// user wrote CJK and the extraction did not.
pub fn agent_title_fits_current(current: Option<&str>, incoming: &str) -> bool {
    !matches!(current, Some(current) if has_cjk(current) && !has_cjk(incoming))
}

fn folded_title(title: &str) -> String {
    title
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// ACP `session_info_update` often repeats the Skill catalog heading.
/// Those are not conversation names; keep the first-prompt label instead.
pub fn is_catalog_noise_title(title: &str) -> bool {
    matches!(
        folded_title(title).as_str(),
        "skillselectionguidance"
            | "skilldescription"
            | "genehubintrospect"
            | "genehubpreview"
            // Legacy Skill names: persisted sessions may still carry them as titles.
            | "genehubsessionhistory"
            | "genehubspeechruntime"
            | "genehubhtmlpreview"
            | "genehubservicepreview"
            | "htmlpreviewinfo"
            | "myskills"
            | "whatareyourskills"
    )
}

/// First user line that is itself a conversation name, not a catalog heading.
pub fn first_user_title(chat: &ChatLog) -> Option<String> {
    chat.items.iter().find_map(|item| match item {
        TimelineItem::UserMessage { text, .. } => {
            prompt_title(text).filter(|title| !is_catalog_noise_title(title))
        }
        _ => None,
    })
}

/// Replaces a persisted catalog heading with the first user line, in memory.
///
/// Returns whether `meta.title` changed. The caller writes it back so a list
/// scan and a rehydrate can share the rule without a second chat load.
pub fn apply_catalog_title_repair(meta: &mut SessionMeta, chat: &ChatLog) -> bool {
    if meta.title_locked {
        return false;
    }
    let Some(current) = meta.title.as_deref() else {
        return false;
    };
    if !is_catalog_noise_title(current) {
        return false;
    }
    let Some(title) = first_user_title(chat) else {
        return false;
    };
    meta.title = Some(title);
    true
}

impl Store {
    /// Persists a catalog-heading repair when the chat already has a real name.
    pub fn repair_catalog_noise_title(&self, meta: &mut SessionMeta) -> Result<bool> {
        if meta.title_locked {
            return Ok(false);
        }
        match meta.title.as_deref() {
            Some(title) if is_catalog_noise_title(title) => {}
            _ => return Ok(false),
        }
        let chat = self.load_chat(&meta.workspace_id, &meta.id)?;
        if !apply_catalog_title_repair(meta, &chat) {
            return Ok(false);
        }
        self.save_meta(meta)?;
        Ok(true)
    }
}

pub fn ensure_within(root: &Path, candidate: &Path) -> Result<PathBuf> {
    let candidate = crate::guest_paths::guest_path(candidate);
    let joined = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    // Resolve without requiring existence, so writes to new files still work.
    let normalized = normalize(&joined);
    let root = normalize(root);
    if !normalized.starts_with(&root) {
        anyhow::bail!("path escapes the workspace");
    }
    Ok(normalized)
}

/// Lexical path cleanup. `canonicalize` is unusable here because the target may
/// not exist yet, and on Windows it produces verbatim paths that break prefix
/// comparison.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod project_home_tests {
    use super::*;

    fn meta(id: &str, workspace_id: &str, cwd: &Path) -> SessionMeta {
        SessionMeta {
            inbox: Default::default(),
            execution_retired: false,
            execution_cleanup: None,
            activity: Default::default(),
            message_preview: None,
            latest_reply: None,
            open_turn: None,
            drafts: vec![],
            id: id.into(),
            workspace_id: workspace_id.into(),
            format: SESSION_FORMAT,
            agent_id: "genet".into(),
            tag_routing: false,
            routing_tags: Vec::new(),
            media_tags: Vec::new(),
            title: Some(id.into()),
            title_locked: false,
            labels: Vec::new(),
            description: None,
            cwd: cwd.to_path_buf(),
            model_id: None,
            mode_id: None,
            effort_id: None,
            fast: None,
            runtime_values: Default::default(),
            created_at_ms: 1,
            updated_at_ms: 1,
            archived: false,
            persist: None,
            agent_pid: None,
            pending_permission: None,
            human_continuation: None,
            lineage: None,
            history_only: false,
            imported: None,
        }
    }

    #[tokio::test]
    async fn project_views_share_one_physical_lock_but_not_session_ownership() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach_project("w_folder", "folder", root.path());
        homes.attach_project("w_workspace", "workspace:suite", root.path());
        let store = Store::new(homes.clone());

        store
            .save_meta(&meta("s_folder", "w_folder", root.path()))
            .unwrap();
        store
            .save_meta(&meta("s_workspace", "w_workspace", root.path()))
            .unwrap();

        let listed = store.list_meta().await.unwrap();
        assert_eq!(listed.len(), 2, "the shared directory is scanned once");
        assert!(listed.iter().any(|meta| meta.workspace_id == "w_folder"));
        assert!(listed.iter().any(|meta| meta.workspace_id == "w_workspace"));
        assert!(store.load_meta("w_workspace", "s_folder").is_err());

        homes.detach("w_folder");
        let listed = store.list_meta().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_id, "w_workspace");
        assert!(
            root.path()
                .join(".genethub/sessions/s_folder/meta.json")
                .is_file()
        );

        homes.attach_project("w_folder", "folder", root.path());
        assert_eq!(store.list_meta().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_legacy_workspace_file_key_is_claimed_by_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach_project("w_old", "workspace:filehash", root.path());
        let store = Store::new(homes.clone());
        store
            .save_meta(&meta("s_old", "w_old", root.path()))
            .unwrap();

        homes.detach("w_old");
        homes.attach_project_aliased(
            "w_dir",
            "folder",
            &["workspace:filehash".into()],
            root.path(),
        );
        let listed = store.list_meta().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "s_old");
        assert_eq!(listed[0].workspace_id, "w_dir");
    }

    #[test]
    fn a_meta_written_before_title_lock_reads_back_unlocked() {
        let raw = r#"{
            "id": "s1",
            "agentId": "genet",
            "title": "旧会话",
            "cwd": "/tmp",
            "modelId": null,
            "modeId": null,
            "createdAtMs": 1,
            "updatedAtMs": 1
        }"#;
        let meta: SessionMeta = serde_json::from_str(raw).unwrap();
        assert!(!meta.title_locked);
        assert_eq!(meta.title.as_deref(), Some("旧会话"));
    }

    #[test]
    fn latin_agent_title_does_not_replace_a_cjk_prompt_title() {
        assert!(!agent_title_fits_current(
            Some("生成三张风景画，简笔风"),
            "Sketchy Scenery Creator"
        ));
        assert!(agent_title_fits_current(
            Some("Fix the login redirect"),
            "修复登录跳转"
        ));
        assert!(agent_title_fits_current(
            Some("生成三张风景画，简笔风"),
            "简笔风景"
        ));
    }

    #[test]
    fn catalog_headings_are_not_session_names() {
        assert!(is_catalog_noise_title("Skill Selection Guidance"));
        assert!(is_catalog_noise_title("  genehub-html-preview  "));
        assert!(is_catalog_noise_title("  genehub-preview  "));
        assert!(is_catalog_noise_title("GeneHub Introspect"));
        assert!(!is_catalog_noise_title("修复登录跳转"));
        assert!(!is_catalog_noise_title("genet-beta 更新到最新"));
    }

    #[test]
    fn catalog_noise_title_is_replaced_by_the_first_user_line() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach_project("w1", "folder", root.path());
        let store = Store::new(homes);
        let mut session = meta("s1", "w1", root.path());
        session.title = Some("Skill Selection Guidance".into());
        store.save_meta(&session).unwrap();
        store
            .append_chat_items(
                "w1",
                "s1",
                &[TimelineItem::UserMessage {
                    interaction_response: None,
                    origin: None,
                    id: "u1".into(),
                    text: "genet-beta 更新到最新".into(),
                    attachments: vec![],
                }],
            )
            .unwrap();

        assert!(store.repair_catalog_noise_title(&mut session).unwrap());
        assert_eq!(session.title.as_deref(), Some("genet-beta 更新到最新"));
        assert_eq!(session.updated_at_ms, 1, "a title repair is not activity");
        let loaded = store.load_meta("w1", "s1").unwrap();
        assert_eq!(loaded.title.as_deref(), Some("genet-beta 更新到最新"));
        assert_eq!(loaded.updated_at_ms, 1);
    }

    #[test]
    fn session_contention_and_deletion_leave_feedback_diagnostics() {
        let root = tempfile::tempdir().unwrap();
        let holder_homes = WorkspaceHomes::default();
        holder_homes.attach_project("w1", "folder", root.path());
        let holder = Store::new(holder_homes);
        let other_homes = WorkspaceHomes::default();
        other_homes.attach_project("w1", "folder", root.path());
        let other = Store::new(other_homes);
        holder.save_meta(&meta("s1", "w1", root.path())).unwrap();
        let contention = other
            .save_meta(&meta("s1", "w1", root.path()))
            .unwrap_err()
            .to_string();
        holder.delete("w1", "s1").unwrap();

        assert!(contention.contains(crate::channel::PRODUCT));
        assert!(!root.path().join(".genethub/sessions/s1").exists());
        // Runtime capture through a scoped tracing subscriber is racy when
        // workspace test binaries rebuild tracing's process-global callsite
        // interest cache in parallel. Keep the behavior assertions above and
        // pin the structured diagnostics at their source instead.
        let source = include_str!("store.rs");
        for event in [
            "session_writer_contended",
            "session_tombstoned",
            "session_cleanup_succeeded",
        ] {
            assert!(
                source.contains(&format!("event = \"{event}\"")),
                "missing structured {event} diagnostic"
            );
        }
    }

    /// Writes `meta.json` the way another GeneHub process would: a temporary
    /// file renamed into place, optionally with an old modification time.
    fn write_elsewhere(root: &Path, meta: &SessionMeta, modified: Option<std::time::SystemTime>) {
        let dir = root.join(".genethub/sessions").join(&meta.id);
        std::fs::create_dir_all(&dir).unwrap();
        let mut value = serde_json::to_value(meta).unwrap();
        value["projectKey"] = Value::String("folder".into());
        let temporary = dir.join(".meta.json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(&value).unwrap()).unwrap();
        if let Some(modified) = modified {
            std::fs::File::options()
                .write(true)
                .open(&temporary)
                .unwrap()
                .set_modified(modified)
                .unwrap();
        }
        std::fs::rename(&temporary, dir.join("meta.json")).unwrap();
    }

    fn hour_ago() -> Option<std::time::SystemTime> {
        Some(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
    }

    fn titled(id: &str, title: &str, root: &Path) -> SessionMeta {
        SessionMeta {
            title: Some(title.into()),
            ..meta(id, "w1", root)
        }
    }

    async fn title_of(store: &Store, workspace: Option<&str>, id: &str) -> Option<String> {
        store
            .list_metadata(workspace)
            .await
            .unwrap()
            .into_iter()
            .find(|meta| meta.id == id)
            .and_then(|meta| meta.title)
    }

    impl Store {
        /// Everything comes due, as if the cold period had passed.
        fn age_catalog(&self) {
            let mut cache = self.page_catalog.lock().unwrap();
            let now = std::time::Instant::now();
            cache.checked_at = None;
            for watch in cache.watches.values_mut() {
                watch.hurry(now);
            }
            for home in cache.homes.values_mut() {
                home.listing.hurry(now);
                home.tombstones.hurry(now);
                home.validated = None;
            }
        }

        fn forget_validation(&self) {
            let mut cache = self.page_catalog.lock().unwrap();
            cache.checked_at = None;
            for home in cache.homes.values_mut() {
                home.validated = None;
            }
        }
    }

    #[tokio::test]
    async fn an_unscoped_read_serves_the_index_and_a_scoped_read_sees_another_writer() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        let store = Store::new(homes);
        write_elsewhere(
            root.path(),
            &titled("s_cold", "aa", root.path()),
            hour_ago(),
        );
        assert_eq!(
            title_of(&store, None, "s_cold").await.as_deref(),
            Some("aa")
        );

        write_elsewhere(
            root.path(),
            &titled("s_cold", "bb", root.path()),
            hour_ago(),
        );
        store.forget_validation();
        store.reconcile_catalog().await.unwrap();
        assert_eq!(
            title_of(&store, None, "s_cold").await.as_deref(),
            Some("aa"),
            "a background pass must not walk paths that are not due"
        );
        assert_eq!(
            title_of(&store, Some("w1"), "s_cold").await.as_deref(),
            Some("bb")
        );
    }

    #[tokio::test]
    async fn looking_at_some_sessions_does_not_postpone_looking_at_their_directory() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        let store = Store::new(homes);
        write_elsewhere(root.path(), &titled("s_old", "aa", root.path()), hour_ago());
        store.reconcile_catalog().await.unwrap();
        let listing_due = || {
            let cache = store.page_catalog.lock().unwrap();
            cache.homes.values().next().unwrap().listing.next_due()
        };
        let before = listing_due();
        {
            let mut cache = store.page_catalog.lock().unwrap();
            let now = std::time::Instant::now();
            cache.checked_at = None;
            for watch in cache.watches.values_mut() {
                watch.hurry(now);
            }
        }
        store.reconcile_catalog().await.unwrap();
        assert_eq!(listing_due(), before);
    }

    fn ids(changes: &CatalogChanges) -> Vec<&str> {
        changes
            .changed
            .iter()
            .map(|meta| meta.id.as_str())
            .collect()
    }

    #[tokio::test]
    async fn a_change_cursor_returns_only_what_changed_since_it() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        homes.attach("w2", other.path());
        let store = Store::new(homes);
        for id in ["s_a", "s_b", "s_c"] {
            store.save_meta(&titled(id, id, root.path())).unwrap();
        }
        store
            .save_meta(&SessionMeta {
                title: Some("elsewhere".into()),
                ..meta("s_other", "w2", other.path())
            })
            .unwrap();
        let scope: HashSet<String> = ["w1".to_string()].into();

        let first = store.catalog_changes(&scope, None, 2).await.unwrap();
        assert_eq!(first.changed.len(), 2);
        assert!(!first.complete && !first.reset);
        let rest = store
            .catalog_changes(&scope, Some((&first.token, first.seq)), 2)
            .await
            .unwrap();
        assert!(rest.complete);
        let mut all: Vec<_> = ids(&first).into_iter().chain(ids(&rest)).collect();
        all.sort_unstable();
        assert_eq!(all, ["s_a", "s_b", "s_c"], "pages cover the scope once");

        let quiet = store
            .catalog_changes(&scope, Some((&rest.token, rest.seq)), 50)
            .await
            .unwrap();
        assert!(quiet.changed.is_empty() && quiet.removed.is_empty());
        assert_eq!(quiet.seq, rest.seq);

        store
            .save_meta(&titled("s_b", "edited", root.path()))
            .unwrap();
        store.mark_catalog_dirty("w1", "s_c");
        store.delete("w1", "s_a").unwrap();
        let next = store
            .catalog_changes(&scope, Some((&quiet.token, quiet.seq)), 50)
            .await
            .unwrap();
        assert_eq!(ids(&next), ["s_b", "s_c"]);
        assert_eq!(next.changed[0].title.as_deref(), Some("edited"));
        assert_eq!(
            next.removed,
            [genehub_proto::CatalogSessionRef {
                workspace_id: "w1".into(),
                id: "s_a".into(),
            }]
        );

        let foreign = store
            .catalog_changes(&scope, Some(("another-daemon", 3)), 50)
            .await
            .unwrap();
        assert!(foreign.reset && foreign.removed.is_empty());
        let mut restarted = ids(&foreign);
        restarted.sort_unstable();
        assert_eq!(restarted, ["s_b", "s_c"]);
    }

    #[tokio::test]
    async fn a_cold_change_is_found_once_it_comes_due() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        let store = Store::new(homes);
        write_elsewhere(
            root.path(),
            &titled("s_cold", "aa", root.path()),
            hour_ago(),
        );
        store.reconcile_catalog().await.unwrap();

        write_elsewhere(
            root.path(),
            &titled("s_cold", "bb", root.path()),
            hour_ago(),
        );
        store.age_catalog();
        store.reconcile_catalog().await.unwrap();
        assert_eq!(
            title_of(&store, None, "s_cold").await.as_deref(),
            Some("bb")
        );
    }

    #[tokio::test]
    async fn sessions_created_and_deleted_elsewhere_follow_a_scoped_read() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        let store = Store::new(homes);
        store
            .save_meta(&titled("s_own", "own", root.path()))
            .unwrap();
        store.reconcile_catalog().await.unwrap();

        write_elsewhere(root.path(), &titled("s_new", "new", root.path()), None);
        store.forget_validation();
        assert_eq!(
            title_of(&store, Some("w1"), "s_new").await.as_deref(),
            Some("new")
        );

        let tombstones = root.path().join(".genethub").join(TOMBSTONES_DIR);
        std::fs::create_dir_all(&tombstones).unwrap();
        std::fs::write(tombstones.join("s_new.json"), b"{}").unwrap();
        store.forget_validation();
        assert_eq!(title_of(&store, Some("w1"), "s_new").await, None);
        assert_eq!(
            title_of(&store, None, "s_own").await.as_deref(),
            Some("own")
        );
    }

    #[tokio::test]
    async fn a_second_write_within_the_same_timestamp_is_not_missed() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        let store = Store::new(homes);
        write_elsewhere(root.path(), &titled("s_racy", "aa", root.path()), None);
        assert_eq!(
            title_of(&store, None, "s_racy").await.as_deref(),
            Some("aa")
        );

        // Same length, rewritten in place, modification time put back.
        let path = root.path().join(".genethub/sessions/s_racy/meta.json");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"aa\"", "\"bb\"");
        std::fs::write(&path, text).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        store.forget_validation();
        assert_eq!(
            title_of(&store, Some("w1"), "s_racy").await.as_deref(),
            Some("bb")
        );
    }

    #[tokio::test]
    async fn find_meta_uses_the_index_and_still_finds_an_unindexed_session() {
        let root = tempfile::tempdir().unwrap();
        let homes = WorkspaceHomes::default();
        homes.attach("w1", root.path());
        let store = Store::new(homes);
        store
            .save_meta(&titled("s_known", "known", root.path()))
            .unwrap();
        store.reconcile_catalog().await.unwrap();
        write_elsewhere(root.path(), &titled("s_known", "edited", root.path()), None);
        write_elsewhere(root.path(), &titled("s_late", "late", root.path()), None);
        assert_eq!(
            store
                .find_meta("s_known")
                .await
                .unwrap()
                .and_then(|m| m.title)
                .as_deref(),
            Some("edited"),
            "an indexed lookup reads the file again"
        );
        assert_eq!(
            store
                .find_meta("s_late")
                .await
                .unwrap()
                .and_then(|m| m.title)
                .as_deref(),
            Some("late")
        );
        assert!(store.find_meta("s_none").await.unwrap().is_none());
    }
}

#[cfg(test)]
mod prompt_title_tests {
    use super::prompt_title;

    #[test]
    fn keeps_an_ordinary_first_line() {
        assert_eq!(prompt_title("说的啥？").as_deref(), Some("说的啥？"));
    }

    #[test]
    fn names_a_forward_after_each_source_session() {
        let text = "\
<genehub-chat-history>
Source session: s-1
Source title: 坦克复盘
</genehub-chat-history>

<genehub-chat-history>
Source session: s-2
</genehub-chat-history>

说的啥？";
        assert_eq!(
            prompt_title(text).as_deref(),
            Some("转发自「坦克复盘」、「s-2」")
        );
    }
}
