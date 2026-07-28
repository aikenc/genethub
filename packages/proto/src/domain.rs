//! Domain objects shared by requests, responses and the frontend's caches.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What an agent can do, declared up front.
///
/// The frontend renders controls from this rather than probing with calls that
/// might fail: a user should never be offered a model picker by an agent that
/// cannot switch models (`architecture.md` §3.2).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Capabilities {
    pub interrupt: bool,
    pub set_model: bool,
    pub set_mode: bool,
    pub permissions: bool,
    /// The agent can rehydrate a past session itself. When false the daemon
    /// falls back to read-only replay from its own log.
    pub resume: bool,
    pub attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[ts(optional)]
    #[ts(type = "number")]
    pub context_window: Option<u64>,
    pub reasoning: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ModeInfo {
    pub id: String,
    pub label: String,
    #[ts(optional)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Catalog {
    pub models: Vec<ModelInfo>,
    pub modes: Vec<ModeInfo>,
    #[ts(optional)]
    pub default_model: Option<String>,
    #[ts(optional)]
    pub default_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ProbeState {
    /// Installed and it answered a handshake.
    Ready,
    /// Binary is missing. Not an error: we simply do not offer it.
    NotInstalled,
    /// Present but unusable, e.g. not logged in or a version we cannot speak to.
    #[serde(rename_all = "camelCase")]
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub probe: ProbeState,
    pub capabilities: Capabilities,
    pub catalog: Catalog,
    /// True for the agent shipped in the installer, which is preselected on
    /// first run so a new user can run something immediately.
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub root: String,
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub title: String,
    pub status: crate::event::SessionStatus,
    #[ts(optional)]
    pub model_id: Option<String>,
    #[ts(optional)]
    pub mode_id: Option<String>,
    #[ts(type = "number")]
    pub created_at_ms: i64,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
    pub archived: bool,
}

/// Everything a client needs to render a session from scratch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionSnapshot {
    pub summary: SessionSummary,
    pub items: Vec<crate::timeline::TimelineItem>,
    /// Sequence number this snapshot is current as of. Events with a lower or
    /// equal seq have already been folded in.
    #[ts(type = "number")]
    pub seq: u64,
    pub pending_permissions: Vec<crate::event::PermissionRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct FileNode {
    pub name: String,
    /// Workspace-relative, always forward-slashed so clients need no per-OS logic.
    pub path: String,
    pub is_dir: bool,
    #[ts(optional)]
    #[ts(type = "number")]
    pub size: Option<u64>,
    /// Absent means "not expanded yet" rather than "empty".
    #[ts(optional)]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    /// False when the file looked binary; `content` is then a placeholder.
    pub is_text: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct GitChange {
    pub path: String,
    pub kind: GitChangeKind,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct GitStatus {
    #[ts(optional)]
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
    pub clean: bool,
}

/// How this client reached the daemon. Surfaced so the UI can show the user
/// which of the three paths in `architecture.md` §1 is in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum TransportKind {
    Loopback,
    Lan,
    Forwarded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct HelloResult {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub machine_id: String,
    /// Short human-comparable form of the daemon key, for out-of-band checking.
    pub fingerprint: String,
    pub transport: TransportKind,
}

/// Where this machine stands with a Hub.
///
/// One shape covers every stage of pairing so the UI polls a single call and
/// renders from what it gets back, rather than tracking the flow itself and
/// getting out of step with the daemon after a restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum HubStatus {
    /// No Hub. Everything still works on this machine and over the LAN.
    Unpaired,
    /// A code is on screen, waiting for someone to approve it in a browser.
    #[serde(rename_all = "camelCase")]
    Pairing {
        hub_url: String,
        user_code: String,
        verification_uri: String,
        /// The same address with the code already filled in, for a QR code.
        verification_uri_complete: String,
        expires_at: String,
    },
    #[serde(rename_all = "camelCase")]
    Paired {
        hub_url: String,
        /// The Hub's id for this machine, which is what the owner sees listed.
        machine_id: String,
        /// True while the outbound connection to the Hub is up. False means
        /// remote access is down even though pairing is intact.
        online: bool,
    },
    /// Pairing was attempted and did not finish. Kept until the next attempt so
    /// the reason stays on screen instead of reverting to "unpaired".
    #[serde(rename_all = "camelCase")]
    Failed { hub_url: String, message: String },
}
