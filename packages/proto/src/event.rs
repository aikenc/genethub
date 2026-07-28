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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PermissionRequest {
    pub id: String,
    pub title: String,
    #[ts(optional)]
    pub detail: Option<String>,
    /// The tool call this approval gates, when it gates one.
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    pub options: Vec<PermissionOption>,
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
    /// No client was online long enough to answer. Carries the agent's default
    /// so the audit trail records what actually happened; §5 of `daemon.md`
    /// forbids resolving these silently.
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
    TurnStarted { turn_id: String },
    #[serde(rename_all = "camelCase")]
    Item { turn_id: String, item: TimelineItem },
    #[serde(rename_all = "camelCase")]
    ItemDelta {
        turn_id: String,
        item_id: String,
        delta: ItemDelta,
    },
    #[serde(rename_all = "camelCase")]
    TurnCompleted { turn_id: String, usage: Usage },
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
