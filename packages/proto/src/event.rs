//! Session events: the push side of the client protocol.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::timeline::{TimelineItem, ToolCallDetail, ToolStatus};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Usage {
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    #[ts(type = "number")]
    pub cache_read_tokens: u64,
    #[ts(type = "number")]
    pub cache_write_tokens: u64,
    #[ts(optional)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum TurnOutcome {
    Completed,
    Failed,
    Canceled,
}

/// Metrics retained with the turn rather than only with the latest event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct TurnStats {
    pub turn_id: String,
    pub outcome: TurnOutcome,
    #[ts(type = "number")]
    pub started_at_ms: i64,
    #[ts(type = "number")]
    pub finished_at_ms: i64,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub usage: Usage,
    #[ts(type = "number")]
    pub tool_calls: u64,
    /// Opaque Agent checkpoint used only when that Agent supports true forks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fork_checkpoint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PermissionRequest {
    pub id: String,
    /// Permissions resume with elevated authority; questions resume with the
    /// selected answer but keep the session's chosen permission mode.
    #[serde(default)]
    pub kind: PermissionRequestKind,
    pub title: String,
    #[ts(optional)]
    pub detail: Option<String>,
    /// The tool call this approval gates, when it gates one.
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum PermissionRequestKind {
    #[default]
    Permission,
    Question,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "outcome", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum PermissionOutcome {
    #[serde(rename_all = "camelCase")]
    Selected {
        option_id: String,
    },
    /// Legacy wire outcome retained so older peers can still decode it. The
    /// daemon no longer creates approval timers: stopped interactions persist
    /// until a user responds.
    #[serde(rename_all = "camelCase")]
    TimedOut {
        applied_default: String,
    },
    Canceled,
}

/// Streaming increment for an item already on the timeline.
///
/// Deltas are transport-only: they are never written to the session log, which
/// keeps file size proportional to final content rather than to token count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ItemDelta {
    #[serde(rename_all = "camelCase")]
    Text { delta: String },
    #[serde(rename_all = "camelCase")]
    ToolStatus {
        status: ToolStatus,
        #[ts(optional)]
        detail: Option<ToolCallDetail>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct TurnError {
    pub code: TurnErrorCode,
    /// Already user-facing. §4.4 of `docs/testing.md` requires every failure
    /// mode to surface something actionable rather than a blank screen.
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum TurnErrorCode {
    /// No API key, or the configured one was rejected.
    MissingCredentials,
    RateLimited,
    Upstream,
    Timeout,
    /// The agent process died mid-turn.
    AgentCrashed,
    Canceled,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SessionEvent {
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        turn_id: String,
        /// Zero is accepted from adapters; the session boundary replaces it
        /// with its own wall clock before the event reaches a client.
        #[serde(default)]
        #[ts(type = "number")]
        started_at_ms: i64,
    },
    #[serde(rename_all = "camelCase")]
    Item { turn_id: String, item: TimelineItem },
    #[serde(rename_all = "camelCase")]
    ItemDelta {
        turn_id: String,
        item_id: String,
        delta: ItemDelta,
    },
    #[serde(rename_all = "camelCase")]
    TurnCompleted {
        turn_id: String,
        usage: Usage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        fork_checkpoint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TurnFailed { turn_id: String, error: TurnError },
    #[serde(rename_all = "camelCase")]
    TurnCanceled { turn_id: String },
    #[serde(rename_all = "camelCase")]
    PermissionRequested { request: PermissionRequest },
    #[serde(rename_all = "camelCase")]
    PermissionResolved {
        request_id: String,
        outcome: PermissionOutcome,
    },
    #[serde(rename_all = "camelCase")]
    ModelChanged { model_id: String },
    #[serde(rename_all = "camelCase")]
    ModeChanged { mode_id: String },
    #[serde(rename_all = "camelCase")]
    EffortChanged { effort_id: String },
    /// The session picked up a name — today only the first message's first
    /// line, set once when a session had none (`SessionManager::send`).
    /// Clients that show a session list must repaint it on this event rather
    /// than only on the next full `session.list`, or the sidebar shows
    /// "新会话" until something unrelated causes a refetch.
    #[serde(rename_all = "camelCase")]
    TitleChanged { title: String },
    /// The agent's own history was compacted or the session became read-only.
    #[serde(rename_all = "camelCase")]
    SessionStatusChanged { status: SessionStatus },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SessionStatus {
    Idle,
    Running,
    /// The turn has stopped and can be resumed after a person responds.
    Waiting,
    /// History is viewable but the underlying agent cannot resume it.
    ReadOnly,
    Failed,
    Closed,
}

/// A sequenced event as delivered to clients.
///
/// The sequence number is what makes gap-free reconnect possible: clients send
/// back the last `seq` they saw and the daemon replays from there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SequencedEvent {
    #[ts(type = "number")]
    pub seq: u64,
    pub session_id: String,
    pub event: SessionEvent,
}
