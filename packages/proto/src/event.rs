//! Session events: the push side of the client protocol.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::timeline::{TimelineItem, ToolCallDetail, ToolImage, ToolStatus};

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
    /// Completed LLM calls in this GeneHub turn. One completion that fires
    /// several tools in parallel is still one round; those tools are not
    /// extra rounds.
    #[serde(default)]
    #[ts(type = "number")]
    pub llm_rounds: u64,
    /// Estimated tokens in tool *results* (chars/4). This is not
    /// `input - cached`: uncached input also contains the prompt, history
    /// and tool schemas, so the two numbers are compared, never equated.
    #[serde(default)]
    #[ts(type = "number")]
    pub tool_output_tokens: u64,
    /// Context compactions that happened during this turn. Counted from the
    /// timeline markers the agent emitted, so it is exact even when the
    /// provider reports no token totals.
    #[serde(default)]
    #[ts(type = "number")]
    pub compaction_count: u64,
    /// Mean time from one LLM round's request to its first token, across the
    /// rounds of this turn. `None` when no adapter timing was captured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub avg_ttft_ms: Option<u64>,
    /// Mean output tokens per second while the turn was streaming. `None`
    /// when no tokens were observed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avg_output_rate_tps: Option<f64>,
    /// True when `avg_output_rate_tps` was estimated from the visible output
    /// text (chars/4) because the provider reported no output tokens. The
    /// footer prefixes such a rate with `~` so it is never mistaken for a
    /// provider-reported figure.
    #[serde(default)]
    #[ts(type = "boolean")]
    pub output_rate_estimated: bool,
    #[ts(optional)]
    pub cost_usd: Option<f64>,
    /// Timing scratch, not part of the wire contract: when the in-flight
    /// round's request started (drives TTFT).
    #[serde(skip)]
    #[ts(skip)]
    pub round_started_at_ms: Option<i64>,
    /// First output moment of the currently open generation span. A span runs
    /// from a round's first token to its last; spans are summed into
    /// `active_output_ms` so the rate never divides by tool-execution gaps.
    #[serde(skip)]
    #[ts(skip)]
    pub span_started_at_ms: Option<i64>,
    /// Most recent output activity in the open span.
    #[serde(skip)]
    #[ts(skip)]
    pub last_output_at_ms: Option<i64>,
    /// Very first output of the turn: fallback clock when every round arrived
    /// as a single chunk and no span has measurable duration.
    #[serde(skip)]
    #[ts(skip)]
    pub turn_first_output_at_ms: Option<i64>,
    /// Sum of closed per-round generation windows in milliseconds.
    #[serde(skip)]
    #[ts(skip)]
    pub active_output_ms: u64,
    /// Visible output characters seen so far, used only to estimate the output
    /// rate for providers that report no token totals. Never serialized.
    #[serde(skip)]
    #[ts(skip)]
    pub visible_output_chars: u64,
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
    /// Structured questions carried by Agent-native interaction tools. Empty
    /// for the original one-row approval card, so older stored sessions keep
    /// their exact behaviour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub questions: Option<Vec<InteractionQuestion>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum PermissionRequestKind {
    #[default]
    Permission,
    Question,
    PlanApproval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct InteractionQuestion {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub allow_multiple: bool,
    #[serde(default)]
    pub allow_freeform: bool,
    pub options: Vec<InteractionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct InteractionOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct InteractionAnswer {
    pub question_id: String,
    #[serde(default)]
    pub selected_option_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub freeform_text: Option<String>,
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
    /// Answers to one or more structured questions. Kept separate from
    /// `Selected` so permission decisions cannot accidentally be interpreted
    /// as free-form Agent input.
    #[serde(rename_all = "camelCase")]
    Answered {
        answers: Vec<InteractionAnswer>,
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
        /// Images the tool result carried. Adapters fill this when the result
        /// arrives (which is delta time, not item time); the daemon sheds it
        /// like `TimelineItem::ToolCall.images`.
        #[serde(default)]
        images: Vec<ToolImage>,
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
    /// In-flight totals for the turn still running. Transport-only: the
    /// durable footer is `TurnSummary` / `TurnCompleted`.
    #[serde(rename_all = "camelCase")]
    TurnProgress { turn_id: String, usage: Usage },
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
    #[serde(rename_all = "camelCase")]
    RuntimeAxisChanged { axis_id: String, value_id: String },
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
